import axios from 'axios'
import type { Storage } from '@google-cloud/storage'
import { envelope, postToMattermost } from '../notifications/mattermost'
import {
  loadMonitorsState,
  saveMonitorsState,
  type MinimalLogger,
} from './state'
import { getErrorMessage } from '../utils/error'
import {
  evaluateLogs,
  evaluateNode,
  evaluateObservatory,
  type MonitorsState,
  type NodeProbe,
  type Severity,
  type WatchdogAlert,
} from './rules'

const BUCKET_NAME = process.env.GCS_BUCKET ?? 'xrplf-release-notifier'
const HEARTBEAT_OBJECT = 'observatory/heartbeat.json'
const LOG_PREFIX = 'stage-node-logs/'
const HEALTHZ_URL =
  process.env.STAGE_NODE_HEALTHZ_URL ?? 'https://unl.xrpl.foundation/healthz'
const WS_URL = process.env.STAGE_NODE_WS_URL ?? 'wss://unl.xrpl.foundation'

const COLOR: Record<Severity, string> = {
  INFO: '#4CAF50',
  WARNING: '#FF9800',
  CRITICAL: '#E53935',
}
const EMOJI: Record<Severity, string> = {
  INFO: ':information_source:',
  WARNING: ':warning:',
  CRITICAL: ':rotating_light:',
}

/**
 * Fetch the raw parsed heartbeat JSON, unvalidated — evaluateObservatory does
 * the shape validation and treats a malformed/missing heartbeat identically
 * (both are a PROBLEM that fires OBSERVATORY_STALE, never a thrown error).
 */
async function fetchHeartbeat(storage: Storage): Promise<unknown> {
  try {
    const [content] = await storage
      .bucket(BUCKET_NAME)
      .file(HEARTBEAT_OBJECT)
      .download()
    return JSON.parse(content.toString()) as unknown
  } catch {
    return null
  }
}

/** Widen the search window until a log turns up; widest matches the bucket's
 * 14-day lifecycle rule so it can't miss anything that still exists. */
const LOG_LOOKBACK_WINDOWS_MS = [
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  14 * 24 * 60 * 60 * 1000,
]

/**
 * Newest shipped-log timestamp across all stage-node hosts. Log objects are
 * hourly-partitioned as `<host-prefix>YYYY-MM-DD-HH.jsonl`, so names sort
 * chronologically — list only a recent window (startOffset) instead of the
 * whole ever-growing history every 15-minute run.
 */
async function fetchNewestLogMs(
  storage: Storage,
  nowMs: number,
  logger?: MinimalLogger
): Promise<number | null> {
  try {
    const bucket = storage.bucket(BUCKET_NAME)
    // Delimiter listing returns per-host common prefixes, not every object.
    const [, , apiResponse] = await bucket.getFiles({
      prefix: LOG_PREFIX,
      delimiter: '/',
      autoPaginate: false,
    })
    const hostPrefixes =
      (apiResponse as { prefixes?: string[] } | undefined)?.prefixes ?? []
    if (hostPrefixes.length === 0) return null

    for (const windowMs of LOG_LOOKBACK_WINDOWS_MS) {
      const startSuffix = new Date(nowMs - windowMs)
        .toISOString()
        .slice(0, 13)
        .replace('T', '-')
      let newest: number | null = null
      for (const hostPrefix of hostPrefixes) {
        const [files] = await bucket.getFiles({
          prefix: hostPrefix,
          startOffset: `${hostPrefix}${startSuffix}`,
        })
        for (const f of files) {
          const updated = f.metadata?.updated
          if (!updated) continue
          const ms = Date.parse(updated)
          if (newest === null || ms > newest) newest = ms
        }
      }
      if (newest !== null) return newest
    }
    return null
  } catch (err) {
    logger?.error('Failed to list stage-node logs from GCS', {
      error: getErrorMessage(err),
    })
    return null
  }
}

async function probeNode(): Promise<NodeProbe> {
  const [healthzOk, serverState] = await Promise.all([
    axios
      .get(HEALTHZ_URL, { timeout: 8000 })
      .then((r) => r.status >= 200 && r.status < 300)
      .catch(() => false),
    queryServerState(WS_URL).catch(() => null),
  ])
  return { healthzOk, serverState }
}

/** Minimal public-WS server_info → server_state, without a WS-client dependency. */
async function queryServerState(wsUrl: string): Promise<string | null> {
  const WebSocket = (await import('ws')).default
  return await new Promise<string | null>((resolve) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 8000 })
    const done = (v: string | null): void => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    const timer = setTimeout(() => done(null), 9000)
    ws.on('open', () =>
      ws.send(JSON.stringify({ id: 1, command: 'server_info' }))
    )
    ws.on('message', (data: Buffer) => {
      clearTimeout(timer)
      try {
        const msg = JSON.parse(data.toString()) as {
          result?: { info?: { server_state?: string } }
        }
        done(msg.result?.info?.server_state ?? null)
      } catch {
        done(null)
      }
    })
    ws.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
  })
}

function toPayload(a: WatchdogAlert): ReturnType<typeof envelope> {
  return envelope(
    {
      fallback: `${a.category}: ${a.title}`,
      color: COLOR[a.severity],
      pretext: `${EMOJI[a.severity]} **${a.title}** [${a.severity}]`,
      text: a.text,
    },
    { username: 'xrpl network monitor' }
  )
}

export interface WatchdogResult {
  alerts: WatchdogAlert[]
  state: MonitorsState
}

/** Maps an alert category back to the dedup flag it just flipped false→true,
 * so a failed post can revert only its own flag (see runWatchdog below). */
const CATEGORY_STATE_FIELD: Partial<
  Record<
    string,
    'observatoryAlerted' | 'logsStaleAlerted' | 'nodeBadStateAlerted'
  >
> = {
  OBSERVATORY_STALE: 'observatoryAlerted',
  LOGS_STALE: 'logsStaleAlerted',
  BAD_SERVER_STATE: 'nodeBadStateAlerted',
}

/**
 * Run all watchdog checks, post any alerts (unless dryRun), and persist state.
 * Returns the alerts + resulting state for the response body and tests.
 */
export async function runWatchdog(
  webhookUrl: string,
  storage: Storage,
  opts: { dryRun?: boolean; logger?: MinimalLogger } = {}
): Promise<WatchdogResult> {
  const nowMs = Date.now()
  const loadedState = await loadMonitorsState(storage, opts.logger)
  let state = loadedState

  const [heartbeat, newestLogMs, probe] = await Promise.all([
    fetchHeartbeat(storage),
    fetchNewestLogMs(storage, nowMs, opts.logger),
    probeNode(),
  ])

  const alerts: WatchdogAlert[] = []
  const obs = evaluateObservatory(heartbeat, nowMs, state)
  alerts.push(...obs.alerts)
  state = obs.state
  const node = evaluateNode(probe, state)
  alerts.push(...node.alerts)
  state = node.state
  const logs = evaluateLogs(newestLogMs, nowMs, state)
  alerts.push(...logs.alerts)
  state = logs.state

  if (!opts.dryRun) {
    // Each alert's dedup flag only just flipped false→true this run. If its
    // post fails, revert that one field to its pre-run (false) value so it
    // retries next run — without a failure on alert #2 undoing the persisted
    // dedup for an already-successfully-posted alert #1.
    const finalState = { ...state }
    for (const a of alerts) {
      try {
        await postToMattermost(webhookUrl, toPayload(a))
      } catch (err) {
        opts.logger?.error(
          'Failed to post watchdog alert — reverting its dedup flag to retry next run',
          { category: a.category, error: getErrorMessage(err) }
        )
        const field = CATEGORY_STATE_FIELD[a.category]
        if (field) finalState[field] = loadedState[field]
      }
    }
    await saveMonitorsState(storage, finalState)
    state = finalState
  }
  return { alerts, state }
}
