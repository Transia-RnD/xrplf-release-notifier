import {
  DEFAULT_MONITORS_STATE,
  evaluateLogs,
  evaluateNode,
  evaluateObservatory,
  HEARTBEAT_MAX_AGE_MS,
  LOGS_MAX_AGE_MS,
  NODE_UNREACHABLE_REPAGE_WINDOWS,
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

  it('alerts once on a filling disk and clears when it drains', () => {
    const hb = (disk_pct: number): Heartbeat => ({
      ts: new Date(NOW).toISOString(),
      disk_pct,
      units: { 'vlwatch.service': 'active' },
    })
    // healthy disk says nothing
    let r = evaluateObservatory(hb(40), NOW, fresh())
    expect(r.alerts).toHaveLength(0)
    // full disk is CRITICAL: it breaks dedup without stopping a unit
    r = evaluateObservatory(hb(100), NOW, r.state)
    expect(r.alerts[0]?.category).toBe('DISK_LOW')
    expect(r.alerts[0]?.severity).toBe('CRITICAL')
    // still full → no repeat
    r = evaluateObservatory(hb(100), NOW, r.state)
    expect(r.alerts).toHaveLength(0)
    // drained → rearmed
    r = evaluateObservatory(hb(40), NOW, r.state)
    expect(r.state.diskLowAlerted).toBe(false)
    expect(evaluateObservatory(hb(90), NOW, r.state).alerts[0]?.severity).toBe(
      'WARNING'
    )
  })

  it('leaves the disk rule silent when the heartbeat predates disk_pct', () => {
    const hb: Heartbeat = {
      ts: new Date(NOW).toISOString(),
      units: { 'vlwatch.service': 'active' },
    }
    const r = evaluateObservatory(hb, NOW, fresh())
    expect(r.alerts).toHaveLength(0)
    expect(r.state.diskLowAlerted).toBe(false)
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

  it('malformed heartbeat (missing units) alerts OBSERVATORY_STALE instead of throwing', () => {
    const malformed = { ts: new Date(NOW).toISOString() }
    expect(() => evaluateObservatory(malformed, NOW, fresh())).not.toThrow()
    const r = evaluateObservatory(malformed, NOW, fresh())
    expect(r.alerts[0]?.category).toBe('OBSERVATORY_STALE')
    expect(r.alerts[0]?.text).toContain('malformed')
  })

  it('malformed heartbeat (units not an object) alerts OBSERVATORY_STALE instead of throwing', () => {
    const malformed = {
      ts: new Date(NOW).toISOString(),
      units: 'not-an-object',
    }
    expect(() => evaluateObservatory(malformed, NOW, fresh())).not.toThrow()
    const r = evaluateObservatory(malformed, NOW, fresh())
    expect(r.alerts[0]?.category).toBe('OBSERVATORY_STALE')
  })

  it('heartbeat with an unparseable timestamp is worded distinctly, not "NaN min old"', () => {
    const hb = {
      ts: 'not-a-real-timestamp',
      units: { 'vlwatch.service': 'active' },
    }
    const r = evaluateObservatory(hb, NOW, fresh())
    expect(r.alerts[0]?.category).toBe('OBSERVATORY_STALE')
    expect(r.alerts[0]?.text).toContain('unparseable timestamp')
    expect(r.alerts[0]?.text).not.toContain('NaN')
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

  it('NODE_UNREACHABLE re-pages periodically during a sustained outage', () => {
    let state = fresh()
    for (let i = 0; i < NODE_UNREACHABLE_WINDOWS; i++) {
      state = evaluateNode({ healthzOk: false, serverState: null }, state).state
    }
    // Walk forward until just before the next re-page window; none should fire.
    for (let i = 1; i < NODE_UNREACHABLE_REPAGE_WINDOWS; i++) {
      const r = evaluateNode({ healthzOk: false, serverState: null }, state)
      expect(r.alerts).toHaveLength(0)
      state = r.state
    }
    // The re-page window itself fires again.
    const r = evaluateNode({ healthzOk: false, serverState: null }, state)
    expect(r.alerts[0]?.category).toBe('NODE_UNREACHABLE')
  })

  it('resets nodeBadStateAlerted when the node goes fully unreachable, allowing bad-state to re-alert', () => {
    const afterBadState = evaluateNode(
      { healthzOk: true, serverState: 'connected' },
      fresh()
    ).state
    expect(afterBadState.nodeBadStateAlerted).toBe(true)

    const afterUnreachable = evaluateNode(
      { healthzOk: false, serverState: null },
      afterBadState
    ).state
    expect(afterUnreachable.nodeBadStateAlerted).toBe(false)

    const r = evaluateNode(
      { healthzOk: true, serverState: 'connected' },
      afterUnreachable
    )
    expect(r.alerts.some((a) => a.category === 'BAD_SERVER_STATE')).toBe(true)
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
