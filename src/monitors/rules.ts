/**
 * Watchdog rules — the external-vantage checks the observatory monitors and the
 * stage node cannot report about themselves. Pure functions over already-fetched
 * inputs so they unit-test without network or GCS. Fetching lives in watchdog.ts.
 */

import { z } from 'zod'

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL'

export interface WatchdogAlert {
  severity: Severity
  category: string
  title: string
  text: string
}

/** Persisted between runs (GCS). Streaks drive the "N consecutive windows" rules. */
export interface MonitorsState {
  nodeUnreachableStreak: number
  observatoryAlerted: boolean
  logsStaleAlerted: boolean
  nodeBadStateAlerted: boolean
  diskLowAlerted: boolean
}

export const DEFAULT_MONITORS_STATE: MonitorsState = {
  nodeUnreachableStreak: 0,
  observatoryAlerted: false,
  logsStaleAlerted: false,
  nodeBadStateAlerted: false,
  diskLowAlerted: false,
}

/** Heartbeat older than this (or any unit down) → OBSERVATORY_STALE. */
export const HEARTBEAT_MAX_AGE_MS = 30 * 60 * 1000
/** Root-disk use at/above this → DISK_LOW (WARNING). */
export const DISK_WARN_PCT = 85
/** Root-disk use at/above this → DISK_LOW (CRITICAL): state writes are at risk. */
export const DISK_CRIT_PCT = 95
/** No new shipped log object in this long → LOGS_STALE. */
export const LOGS_MAX_AGE_MS = 3 * 60 * 60 * 1000
/** NODE_UNREACHABLE needs this many consecutive failed windows. */
export const NODE_UNREACHABLE_WINDOWS = 2
/** Once unreachable, re-page every this many additional windows (sustained outage). */
export const NODE_UNREACHABLE_REPAGE_WINDOWS = 8
const HEALTHY_STATES = new Set(['full', 'proposing', 'validating'])

/** Runtime shape of the fetched heartbeat JSON — the source is an external file, never trust it. */
export const HeartbeatSchema = z.object({
  ts: z.string(),
  host: z.string().optional(),
  /** Root-disk use percent. Optional: heartbeats predating it still validate. */
  disk_pct: z.number().optional(),
  units: z.record(z.string(), z.string()),
})
export type Heartbeat = z.infer<typeof HeartbeatSchema>

/** OBSERVATORY_STALE — heartbeat missing, malformed, stale, or a monitor unit not active. */
export function evaluateObservatory(
  heartbeatInput: unknown,
  nowMs: number,
  state: MonitorsState
): { alerts: WatchdogAlert[]; state: MonitorsState } {
  const next = { ...state }
  const alerts: WatchdogAlert[] = []

  let problem: string | null = null
  if (heartbeatInput === null || heartbeatInput === undefined) {
    problem = 'No observatory heartbeat object found.'
  } else {
    const parsed = HeartbeatSchema.safeParse(heartbeatInput)
    if (!parsed.success) {
      problem = 'Observatory heartbeat is malformed (unexpected shape).'
    } else {
      const heartbeat = parsed.data
      const ageMs = nowMs - Date.parse(heartbeat.ts)
      const downUnits = Object.entries(heartbeat.units)
        .filter(([, s]) => s !== 'active')
        .map(([u]) => u)
      if (Number.isNaN(ageMs)) {
        problem = 'Observatory heartbeat has an unparseable timestamp.'
      } else if (ageMs > HEARTBEAT_MAX_AGE_MS) {
        problem = `Observatory heartbeat is stale (${Math.round(ageMs / 60000)} min old).`
      } else if (downUnits.length > 0) {
        problem = `Observatory units not active: ${downUnits.join(', ')}.`
      }
    }
  }

  if (problem) {
    if (!next.observatoryAlerted) {
      next.observatoryAlerted = true
      alerts.push({
        severity: 'CRITICAL',
        category: 'OBSERVATORY_STALE',
        title: 'Observatory monitors may be down',
        text: `${problem} Network alerts (vlwatch/crawler) may be silently missing.`,
      })
    }
  } else {
    next.observatoryAlerted = false
  }

  // A full disk leaves every unit "active" while silently failing the atomic
  // state writes the monitors dedup on, so it needs its own signal.
  const diskPct = HeartbeatSchema.safeParse(heartbeatInput).data?.disk_pct
  if (diskPct !== undefined && diskPct >= DISK_WARN_PCT) {
    if (!next.diskLowAlerted) {
      next.diskLowAlerted = true
      alerts.push({
        severity: diskPct >= DISK_CRIT_PCT ? 'CRITICAL' : 'WARNING',
        category: 'DISK_LOW',
        title: `Observatory root disk ${diskPct}% full`,
        text:
          `The observatory VM's root disk is ${diskPct}% full. Monitor state files are ` +
          `written atomically, so once it fills, alert dedup stops persisting and the ` +
          `periodic monitors re-fire the same cards every poll.`,
      })
    }
  } else if (diskPct !== undefined) {
    next.diskLowAlerted = false
  }
  return { alerts, state: next }
}

export interface NodeProbe {
  healthzOk: boolean
  serverState: string | null // from public-WS server_info, null if WS failed
}

/**
 * NODE_UNREACHABLE (streak-gated, re-paging every NODE_UNREACHABLE_REPAGE_WINDOWS
 * while the outage persists) + BAD_SERVER_STATE. The stage node's own
 * unl-monitor.sh covers node health from the inside; this only catches the case
 * where that monitor is itself unreachable, and a bad public server_state.
 */
export function evaluateNode(
  probe: NodeProbe,
  state: MonitorsState
): { alerts: WatchdogAlert[]; state: MonitorsState } {
  const next = { ...state }
  const alerts: WatchdogAlert[] = []

  const reachable = probe.healthzOk || probe.serverState !== null
  if (!reachable) {
    next.nodeUnreachableStreak += 1
    const streak = next.nodeUnreachableStreak
    const windowsPastThreshold = streak - NODE_UNREACHABLE_WINDOWS
    // Fire when the streak first reaches the threshold, then re-page
    // periodically for as long as the outage continues.
    if (
      streak === NODE_UNREACHABLE_WINDOWS ||
      (windowsPastThreshold > 0 &&
        windowsPastThreshold % NODE_UNREACHABLE_REPAGE_WINDOWS === 0)
    ) {
      alerts.push({
        severity: 'CRITICAL',
        category: 'NODE_UNREACHABLE',
        title: 'UNL stage node unreachable',
        text: `healthz and public WS both failed for ${streak} consecutive checks — the node or its on-box monitor may be down.`,
      })
    }
    // Fully unreachable means the WS can't have reported a server_state either
    // — clear the dedup flag so bad-state → unreachable → bad-state re-alerts.
    next.nodeBadStateAlerted = false
  } else {
    next.nodeUnreachableStreak = 0
  }

  // BAD_SERVER_STATE — only meaningful when the WS actually answered.
  if (probe.serverState !== null) {
    if (!HEALTHY_STATES.has(probe.serverState)) {
      if (!next.nodeBadStateAlerted) {
        next.nodeBadStateAlerted = true
        alerts.push({
          severity: 'WARNING',
          category: 'BAD_SERVER_STATE',
          title: `Stage node server_state: ${probe.serverState}`,
          text: `Public WS reports server_state="${probe.serverState}" (not full/proposing/validating).`,
        })
      }
    } else {
      next.nodeBadStateAlerted = false
    }
  }

  return { alerts, state: next }
}

/** LOGS_STALE — the newest shipped stage-node log is too old (log pipeline died). */
export function evaluateLogs(
  newestLogMs: number | null,
  nowMs: number,
  state: MonitorsState
): { alerts: WatchdogAlert[]; state: MonitorsState } {
  const next = { ...state }
  const alerts: WatchdogAlert[] = []
  // newestLogMs === null means no logs yet (logmon not deployed) — not an alert.
  if (newestLogMs !== null && nowMs - newestLogMs > LOGS_MAX_AGE_MS) {
    if (!next.logsStaleAlerted) {
      next.logsStaleAlerted = true
      alerts.push({
        severity: 'WARNING',
        category: 'LOGS_STALE',
        title: 'Stage-node logs stopped arriving',
        text: `No new log objects for over ${Math.round(LOGS_MAX_AGE_MS / 3600000)}h — the logmon pipeline on the stage node may be down.`,
      })
    }
  } else if (newestLogMs !== null) {
    next.logsStaleAlerted = false
  }
  return { alerts, state: next }
}
