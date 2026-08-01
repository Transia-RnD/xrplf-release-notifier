/**
 * Watchdog rules — the external-vantage checks the observatory monitors and the
 * stage node cannot report about themselves. Pure functions over already-fetched
 * inputs so they unit-test without network or GCS. Fetching lives in watchdog.ts.
 */

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
}

export const DEFAULT_MONITORS_STATE: MonitorsState = {
  nodeUnreachableStreak: 0,
  observatoryAlerted: false,
  logsStaleAlerted: false,
  nodeBadStateAlerted: false,
}

/** Heartbeat older than this (or any unit down) → OBSERVATORY_STALE. */
export const HEARTBEAT_MAX_AGE_MS = 30 * 60 * 1000
/** No new shipped log object in this long → LOGS_STALE. */
export const LOGS_MAX_AGE_MS = 3 * 60 * 60 * 1000
/** NODE_UNREACHABLE needs this many consecutive failed windows. */
export const NODE_UNREACHABLE_WINDOWS = 2
const HEALTHY_STATES = new Set(['full', 'proposing', 'validating'])

export interface Heartbeat {
  ts: string
  host?: string
  units: Record<string, string>
}

/** OBSERVATORY_STALE — heartbeat missing, stale, or a monitor unit not active. */
export function evaluateObservatory(
  heartbeat: Heartbeat | null,
  nowMs: number,
  state: MonitorsState
): { alerts: WatchdogAlert[]; state: MonitorsState } {
  const next = { ...state }
  const alerts: WatchdogAlert[] = []

  let problem: string | null = null
  if (!heartbeat) {
    problem = 'No observatory heartbeat object found.'
  } else {
    const ageMs = nowMs - Date.parse(heartbeat.ts)
    const downUnits = Object.entries(heartbeat.units)
      .filter(([, s]) => s !== 'active')
      .map(([u]) => u)
    if (Number.isNaN(ageMs) || ageMs > HEARTBEAT_MAX_AGE_MS) {
      problem = `Observatory heartbeat is stale (${Math.round(ageMs / 60000)} min old).`
    } else if (downUnits.length > 0) {
      problem = `Observatory units not active: ${downUnits.join(', ')}.`
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
  return { alerts, state: next }
}

export interface NodeProbe {
  healthzOk: boolean
  serverState: string | null // from public-WS server_info, null if WS failed
}

/**
 * NODE_UNREACHABLE (streak-gated) + BAD_SERVER_STATE. The stage node's own
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
    // Fire once, when the streak first reaches the threshold.
    if (next.nodeUnreachableStreak === NODE_UNREACHABLE_WINDOWS) {
      alerts.push({
        severity: 'CRITICAL',
        category: 'NODE_UNREACHABLE',
        title: 'UNL stage node unreachable',
        text: `healthz and public WS both failed for ${NODE_UNREACHABLE_WINDOWS} consecutive checks — the node or its on-box monitor may be down.`,
      })
    }
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
