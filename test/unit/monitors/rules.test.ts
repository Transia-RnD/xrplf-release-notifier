import {
  DEFAULT_MONITORS_STATE,
  evaluateLogs,
  evaluateNode,
  evaluateObservatory,
  HEARTBEAT_MAX_AGE_MS,
  LOGS_MAX_AGE_MS,
  NODE_UNREACHABLE_WINDOWS,
  type Heartbeat,
  type MonitorsState,
} from '../../../src/monitors/rules'

const NOW = 1_800_000_000_000
const fresh = (): MonitorsState => ({ ...DEFAULT_MONITORS_STATE })

describe('evaluateObservatory', () => {
  it('alerts once when heartbeat is missing, clears when healthy', () => {
    let r = evaluateObservatory(null, NOW, fresh())
    expect(r.alerts.map((a) => a.category)).toContain('OBSERVATORY_STALE')
    // second run still missing → no repeat
    r = evaluateObservatory(null, NOW, r.state)
    expect(r.alerts).toHaveLength(0)
    // recovers
    const hb: Heartbeat = {
      ts: new Date(NOW).toISOString(),
      units: { 'vlwatch.service': 'active' },
    }
    r = evaluateObservatory(hb, NOW, r.state)
    expect(r.state.observatoryAlerted).toBe(false)
  })

  it('alerts on stale heartbeat', () => {
    const hb: Heartbeat = {
      ts: new Date(NOW - HEARTBEAT_MAX_AGE_MS - 1000).toISOString(),
      units: { 'vlwatch.service': 'active' },
    }
    const r = evaluateObservatory(hb, NOW, fresh())
    expect(r.alerts[0]?.category).toBe('OBSERVATORY_STALE')
  })

  it('alerts when a unit is not active', () => {
    const hb: Heartbeat = {
      ts: new Date(NOW).toISOString(),
      units: {
        'vlwatch.service': 'active',
        'crawler-monitor.service': 'failed',
      },
    }
    const r = evaluateObservatory(hb, NOW, fresh())
    expect(r.alerts[0]?.text).toContain('crawler-monitor.service')
  })
})

describe('evaluateNode', () => {
  it('NODE_UNREACHABLE fires only after consecutive failed windows', () => {
    let state = fresh()
    for (let i = 1; i < NODE_UNREACHABLE_WINDOWS; i++) {
      const r = evaluateNode({ healthzOk: false, serverState: null }, state)
      expect(r.alerts).toHaveLength(0)
      state = r.state
    }
    const r = evaluateNode({ healthzOk: false, serverState: null }, state)
    expect(r.alerts[0]?.category).toBe('NODE_UNREACHABLE')
  })

  it('healthz OK resets the streak (no alert)', () => {
    const state = { ...fresh(), nodeUnreachableStreak: 5 }
    const r = evaluateNode({ healthzOk: true, serverState: null }, state)
    expect(r.state.nodeUnreachableStreak).toBe(0)
    expect(r.alerts).toHaveLength(0)
  })

  it('BAD_SERVER_STATE fires for an unhealthy state, not for proposing', () => {
    const bad = evaluateNode(
      { healthzOk: true, serverState: 'connected' },
      fresh()
    )
    expect(bad.alerts.some((a) => a.category === 'BAD_SERVER_STATE')).toBe(true)
    const ok = evaluateNode(
      { healthzOk: true, serverState: 'proposing' },
      fresh()
    )
    expect(ok.alerts.some((a) => a.category === 'BAD_SERVER_STATE')).toBe(false)
  })
})

describe('evaluateLogs', () => {
  it('no logs yet (null) is not an alert', () => {
    const r = evaluateLogs(null, NOW, fresh())
    expect(r.alerts).toHaveLength(0)
  })

  it('stale logs alert once', () => {
    let r = evaluateLogs(NOW - LOGS_MAX_AGE_MS - 1, NOW, fresh())
    expect(r.alerts[0]?.category).toBe('LOGS_STALE')
    r = evaluateLogs(NOW - LOGS_MAX_AGE_MS - 1, NOW, r.state)
    expect(r.alerts).toHaveLength(0)
  })

  it('fresh logs clear the flag', () => {
    const r = evaluateLogs(NOW - 1000, NOW, {
      ...fresh(),
      logsStaleAlerted: true,
    })
    expect(r.state.logsStaleAlerted).toBe(false)
  })
})
