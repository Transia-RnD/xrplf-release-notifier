import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { CronExpressionParser } from 'cron-parser'

const JobSchema = z.object({
  /** Stable identity — it keys the persisted last-run state, so renaming a job resets it. */
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'name must be lowercase kebab-case'),
  description: z.string().optional(),
  cron: z.string().min(1),
  tz: z.string().default('UTC'),
  handler: z.string().min(1),
  enabled: z.boolean().default(true),
})

export type Job = z.infer<typeof JobSchema>

const SchedulesSchema = z.object({
  jobs: z.array(JobSchema),
})

export type Schedules = z.infer<typeof SchedulesSchema>

export const SCHEDULES_PATH = path.join(
  process.cwd(),
  'config',
  'schedules.yaml'
)

/**
 * Parse and fully validate the schedule table. Cron expressions and handler
 * names are checked here rather than at dispatch time so a typo fails loudly on
 * startup instead of becoming a job that quietly never fires.
 */
export function parseSchedules(
  raw: string,
  knownHandlers: Iterable<string>
): Schedules {
  const schedules = SchedulesSchema.parse(yaml.load(raw))

  const seen = new Set<string>()
  const handlers = new Set(knownHandlers)

  for (const job of schedules.jobs) {
    if (seen.has(job.name)) {
      throw new Error(`duplicate job name: ${job.name}`)
    }
    seen.add(job.name)

    // Check the zone separately: cron-parser only rejects an unknown tz once a
    // concrete date is involved, and its message ("unhandled timestamp") does
    // not mention the timezone at all. A typo'd zone must not silently degrade
    // to UTC and post the report at the wrong hour.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: job.tz })
    } catch {
      throw new Error(
        `job "${job.name}" has an invalid cron/tz — unknown timezone "${job.tz}"`
      )
    }

    try {
      CronExpressionParser.parse(job.cron, {
        tz: job.tz,
        currentDate: new Date(),
      })
    } catch (err) {
      throw new Error(
        `job "${job.name}" has an invalid cron/tz (${job.cron} ${job.tz}): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    if (!handlers.has(job.handler)) {
      throw new Error(
        `job "${job.name}" names unknown handler "${job.handler}" — known: ${[
          ...handlers,
        ].join(', ')}`
      )
    }
  }

  return schedules
}

export function loadSchedules(
  knownHandlers: Iterable<string>,
  file: string = SCHEDULES_PATH
): Schedules {
  return parseSchedules(readFileSync(file, 'utf8'), knownHandlers)
}
