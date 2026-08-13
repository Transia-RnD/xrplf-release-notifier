import { CronExpressionParser } from 'cron-parser'
import type { Job, Schedules } from './schema'
import type { JobRecord, SchedulerState } from './state'
import type { HandlerContext, HandlerRegistry } from './handlers'

/** Consecutive failures before the scheduler reports itself as broken. */
export const FAILURE_ALERT_THRESHOLD = 3

export type TickAction = 'seeded' | 'ran' | 'would-run' | 'failed' | 'skipped'

export interface TickResult {
  job: string
  action: TickAction
  error?: string
  /** Consecutive failures after this tick, present only when the job failed. */
  failures?: number
}

/**
 * True when at least one cron occurrence falls in (lastRun, now].
 *
 * Deliberately asks "has an occurrence passed?" rather than replaying every
 * missed occurrence: after an outage spanning three weekly slots the job runs
 * once, not three times. A report is a statement about the present, so firing
 * it repeatedly to "catch up" produces noise, not history.
 */
export function isDue(job: Job, lastRun: Date, now: Date): boolean {
  const previous = CronExpressionParser.parse(job.cron, {
    tz: job.tz,
    currentDate: now,
  })
    .prev()
    .toDate()
  return previous.getTime() > lastRun.getTime()
}

/** Next scheduled occurrence, for introspection via GET /schedules. */
export function nextRun(job: Job, now: Date): Date {
  return CronExpressionParser.parse(job.cron, { tz: job.tz, currentDate: now })
    .next()
    .toDate()
}

export interface TickOptions {
  now?: Date
  dryRun?: boolean
}

/**
 * Run every due job. Mutates `state` in place; the caller persists it.
 *
 * Two rules carry the correctness of the whole scheduler:
 *  - a handler that throws never advances `lastRun`, so the job retries on the
 *    next tick instead of being silently skipped until its next slot;
 *  - a handler that throws never aborts the loop, so one broken report cannot
 *    starve the others.
 */
export async function runTick(
  schedules: Schedules,
  state: SchedulerState,
  registry: HandlerRegistry,
  context: HandlerContext,
  options: TickOptions = {}
): Promise<TickResult[]> {
  const now = options.now ?? new Date()
  const dryRun = options.dryRun === true
  const results: TickResult[] = []

  for (const job of schedules.jobs) {
    if (!job.enabled) {
      results.push({ job: job.name, action: 'skipped' })
      continue
    }

    const record: JobRecord | undefined = state.jobs[job.name]

    // Cold start: a job we have never seen is seeded to "now" WITHOUT running,
    // so deploying on a Thursday does not immediately fire every Monday report.
    if (!record) {
      if (!dryRun) {
        state.jobs[job.name] = { lastRun: now.toISOString(), failures: 0 }
      }
      results.push({ job: job.name, action: 'seeded' })
      continue
    }

    if (!isDue(job, new Date(record.lastRun), now)) continue

    if (dryRun) {
      results.push({ job: job.name, action: 'would-run' })
      continue
    }

    const handler = registry.get(job.handler)
    if (!handler) {
      // Counted as a failure rather than thrown: a registry missing a name must
      // not take down the other due jobs.
      record.failures += 1
      results.push({
        job: job.name,
        action: 'failed',
        error: `unknown handler "${job.handler}"`,
        failures: record.failures,
      })
      continue
    }

    try {
      await handler(context)
      record.lastRun = now.toISOString()
      record.failures = 0
      results.push({ job: job.name, action: 'ran' })
    } catch (err) {
      record.failures += 1
      results.push({
        job: job.name,
        action: 'failed',
        error: err instanceof Error ? err.message : String(err),
        failures: record.failures,
      })
    }
  }

  return results
}
