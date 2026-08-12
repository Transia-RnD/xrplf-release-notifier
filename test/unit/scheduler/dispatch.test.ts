import { isDue, nextRun, runTick } from '../../../src/scheduler/dispatch'
import type { Job, Schedules } from '../../../src/scheduler/schema'
import type { SchedulerState } from '../../../src/scheduler/state'
import type {
  HandlerContext,
  HandlerRegistry,
} from '../../../src/scheduler/handlers'

const weekly: Job = {
  name: 'weekly',
  cron: '0 9 * * MON',
  tz: 'UTC',
  handler: 'weekly',
  enabled: true,
}

function schedules(...jobs: Job[]): Schedules {
  return { jobs }
}

function state(jobs: SchedulerState['jobs'] = {}): SchedulerState {
  return { jobs }
}

const context = {
  config: {},
  storage: {},
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  dryRun: false,
} as unknown as HandlerContext

describe('isDue', () => {
  it('is false between occurrences', () => {
    // Ran Mon 09:00; it is now Wed. The next slot has not arrived.
    expect(
      isDue(
        weekly,
        new Date('2026-08-03T09:00:00Z'),
        new Date('2026-08-05T12:00:00Z')
      )
    ).toBe(false)
  })

  it('is true once the occurrence has passed', () => {
    expect(
      isDue(
        weekly,
        new Date('2026-08-03T09:00:00Z'),
        new Date('2026-08-10T09:00:01Z')
      )
    ).toBe(true)
  })

  it('honours the job timezone', () => {
    const amsterdam: Job = { ...weekly, tz: 'Europe/Amsterdam' }
    // 09:00 Amsterdam in August (CEST, UTC+2) is 07:00Z. At 07:30Z the job is
    // due; the same instant would NOT be due if the job were UTC.
    const lastRun = new Date('2026-08-03T09:00:00Z')
    const now = new Date('2026-08-10T07:30:00Z')
    expect(isDue(amsterdam, lastRun, now)).toBe(true)
    expect(isDue(weekly, lastRun, now)).toBe(false)
  })
})

describe('runTick', () => {
  it('seeds a never-before-seen job without running it', async () => {
    // A fresh deploy must not immediately fire every report it has never run.
    const handler = jest.fn()
    const s = state()
    const results = await runTick(
      schedules(weekly),
      s,
      new Map([['weekly', handler]]) as HandlerRegistry,
      context,
      { now: new Date('2026-08-10T09:00:01Z') }
    )

    expect(handler).not.toHaveBeenCalled()
    expect(results).toEqual([{ job: 'weekly', action: 'seeded' }])
    expect(s.jobs.weekly.lastRun).toBe('2026-08-10T09:00:01.000Z')
  })

  it('fires ONCE after an outage spanning several occurrences', async () => {
    // Down for three weeks. A catch-up storm would post three identical
    // weekly reports; the report is a statement about now, so it fires once.
    const handler = jest.fn()
    const s = state({
      weekly: { lastRun: '2026-07-20T09:00:00.000Z', failures: 0 },
    })
    const results = await runTick(
      schedules(weekly),
      s,
      new Map([['weekly', handler]]) as HandlerRegistry,
      context,
      { now: new Date('2026-08-10T09:00:01Z') }
    )

    expect(handler).toHaveBeenCalledTimes(1)
    expect(results).toEqual([{ job: 'weekly', action: 'ran' }])
  })

  it('does not advance lastRun when the handler throws, so it retries', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('github 503'))
    const s = state({
      weekly: { lastRun: '2026-08-03T09:00:00.000Z', failures: 0 },
    })
    const registry = new Map([['weekly', handler]]) as HandlerRegistry

    const first = await runTick(schedules(weekly), s, registry, context, {
      now: new Date('2026-08-10T09:00:01Z'),
    })
    expect(first[0]).toMatchObject({ action: 'failed', failures: 1 })
    expect(s.jobs.weekly.lastRun).toBe('2026-08-03T09:00:00.000Z')

    // Next tick, five minutes later: still due, so it tries again.
    const second = await runTick(schedules(weekly), s, registry, context, {
      now: new Date('2026-08-10T09:05:01Z'),
    })
    expect(second[0]).toMatchObject({ action: 'failed', failures: 2 })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('resets the failure count after a success', async () => {
    const handler = jest.fn()
    const s = state({
      weekly: { lastRun: '2026-08-03T09:00:00.000Z', failures: 4 },
    })
    await runTick(
      schedules(weekly),
      s,
      new Map([['weekly', handler]]) as HandlerRegistry,
      context,
      { now: new Date('2026-08-10T09:00:01Z') }
    )
    expect(s.jobs.weekly).toEqual({
      lastRun: '2026-08-10T09:00:01.000Z',
      failures: 0,
    })
  })

  it('does not let one failing job starve the others', async () => {
    const boom = jest.fn().mockRejectedValue(new Error('boom'))
    const ok = jest.fn()
    const other: Job = { ...weekly, name: 'other', handler: 'ok' }
    const s = state({
      weekly: { lastRun: '2026-08-03T09:00:00.000Z', failures: 0 },
      other: { lastRun: '2026-08-03T09:00:00.000Z', failures: 0 },
    })

    const results = await runTick(
      schedules(weekly, other),
      s,
      new Map([
        ['weekly', boom],
        ['ok', ok],
      ]) as HandlerRegistry,
      context,
      { now: new Date('2026-08-10T09:00:01Z') }
    )

    expect(ok).toHaveBeenCalledTimes(1)
    expect(results.map((r) => r.action)).toEqual(['failed', 'ran'])
  })

  it('never runs a disabled job', async () => {
    const handler = jest.fn()
    const s = state({
      weekly: { lastRun: '2026-07-01T09:00:00.000Z', failures: 0 },
    })
    const results = await runTick(
      schedules({ ...weekly, enabled: false }),
      s,
      new Map([['weekly', handler]]) as HandlerRegistry,
      context,
      { now: new Date('2026-08-10T09:00:01Z') }
    )
    expect(handler).not.toHaveBeenCalled()
    expect(results).toEqual([{ job: 'weekly', action: 'skipped' }])
  })

  it('reports what would run in dry-run without running or mutating state', async () => {
    const handler = jest.fn()
    const s = state({
      weekly: { lastRun: '2026-08-03T09:00:00.000Z', failures: 0 },
    })
    const results = await runTick(
      schedules(weekly),
      s,
      new Map([['weekly', handler]]) as HandlerRegistry,
      context,
      { now: new Date('2026-08-10T09:00:01Z'), dryRun: true }
    )

    expect(handler).not.toHaveBeenCalled()
    expect(results).toEqual([{ job: 'weekly', action: 'would-run' }])
    expect(s.jobs.weekly.lastRun).toBe('2026-08-03T09:00:00.000Z')
  })
})

describe('nextRun', () => {
  it('reports the next occurrence for introspection', () => {
    expect(
      nextRun(weekly, new Date('2026-08-05T12:00:00Z')).toISOString()
    ).toBe('2026-08-10T09:00:00.000Z')
  })
})
