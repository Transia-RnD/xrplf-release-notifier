import axios from 'axios'
import type { Storage } from '@google-cloud/storage'
import { envelope, postToMattermost } from '../notifications/mattermost'
import { loadMonitorsState, saveMonitorsState } from './state'
import {
  evaluateLogs,
  evaluateNode,
  evaluateObservatory,
  type Heartbeat,
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

async function fetchHeartbeat(storage: Storage): Promise<Heartbeat | null> {
  try {
    const [content] = await storage
      .bucket(BUCKET_NAME)
      .file(HEARTBEAT_OBJECT)
      .download()
    return JSON.parse(content.toString()) as Heartbeat
  } catch {
    return null
  }
}

async function fetchNewestLogMs(storage: Storage): Promise<number | null> {
  try {
    const [files] = await storage
      .bucket(BUCKET_NAME)
      .getFiles({ prefix: LOG_PREFIX })
    let newest: number | null = null
    for (const f of files) {
      const updated = f.metadata?.updated
      if (!updated) continue
      const ms = Date.parse(updated)
      if (newest === null || ms > newest) newest = ms
    }
    return newest
  } catch {
    return null
  }
}

async function probeNode(): Promise<NodeProbe> {
  const healthzOk = await axios
    .get(HEALTHZ_URL, { timeout: 8000 })
    .then((r) => r.status >= 200 && r.status < 300)
    .catch(() => false)
  const serverState = await queryServerState(WS_URL).catch(() => null)
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

/**
 * Run all watchdog checks, post any alerts (unless dryRun), and persist state.
 * Returns the alerts + resulting state for the response body and tests.
 */
export async function runWatchdog(
  webhookUrl: string,
  storage: Storage,
  opts: { dryRun?: boolean } = {}
): Promise<WatchdogResult> {
  const nowMs = Date.now()
  let state = await loadMonitorsState(storage)

  const [heartbeat, newestLogMs, probe] = await Promise.all([
    fetchHeartbeat(storage),
    fetchNewestLogMs(storage),
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
    for (const a of alerts) await postToMattermost(webhookUrl, toPayload(a))
    await saveMonitorsState(storage, state)
  }
  return { alerts, state }
}
