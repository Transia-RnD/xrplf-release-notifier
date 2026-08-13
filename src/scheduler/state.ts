import type { Storage } from '@google-cloud/storage'
import { z } from 'zod'
import type { MinimalLogger } from '../monitors/state'

const BUCKET_NAME = process.env.GCS_BUCKET ?? 'xrplf-release-notifier'
const STATE_FILE = 'scheduler-state.json'

const JobRecordSchema = z.object({
  /** ISO timestamp of the last SUCCESSFUL run. Advancing it is what marks work done. */
  lastRun: z.iso.datetime(),
  /** Consecutive failures since the last success. */
  failures: z.number().int().nonnegative(),
})

export type JobRecord = z.infer<typeof JobRecordSchema>

const SchedulerStateSchema = z.object({
  jobs: z.record(z.string(), JobRecordSchema),
})

export type SchedulerState = z.infer<typeof SchedulerStateSchema>

export const DEFAULT_SCHEDULER_STATE: SchedulerState = { jobs: {} }

/**
 * Drop only the job entries that fail validation, keeping the rest. A wholesale
 * reset would re-seed every job and swallow a full cycle of reports.
 */
function recoverJobs(raw: unknown): SchedulerState {
  const obj =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {}
  const jobs =
    typeof obj.jobs === 'object' && obj.jobs !== null
      ? (obj.jobs as Record<string, unknown>)
      : {}

  const recovered: Record<string, JobRecord> = {}
  for (const [name, record] of Object.entries(jobs)) {
    const parsed = JobRecordSchema.safeParse(record)
    if (parsed.success) recovered[name] = parsed.data
  }
  return { jobs: recovered }
}

export async function loadSchedulerState(
  storage: Storage,
  logger?: MinimalLogger
): Promise<SchedulerState> {
  let raw: unknown
  try {
    const [content] = await storage
      .bucket(BUCKET_NAME)
      .file(STATE_FILE)
      .download()
    raw = JSON.parse(content.toString())
  } catch {
    // No object yet (first run) or unreadable — no prior state to preserve.
    return { jobs: {} }
  }

  const validated = SchedulerStateSchema.safeParse(raw)
  if (validated.success) return validated.data
  ;(logger ?? console).error(
    'scheduler-state.json failed validation — recovering individual job records instead of reseeding every job',
    { issues: validated.error.issues }
  )
  return recoverJobs(raw)
}

export async function saveSchedulerState(
  storage: Storage,
  state: SchedulerState
): Promise<void> {
  await storage
    .bucket(BUCKET_NAME)
    .file(STATE_FILE)
    .save(JSON.stringify(state, null, 2), { contentType: 'application/json' })
}
