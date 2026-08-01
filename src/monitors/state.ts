import type { Storage } from '@google-cloud/storage'
import { z } from 'zod'
import { DEFAULT_MONITORS_STATE, type MonitorsState } from './rules'

const BUCKET_NAME = process.env.GCS_BUCKET ?? 'xrplf-release-notifier'
const STATE_FILE = 'monitors-state.json'

/** Minimal logging surface so callers can pass winston's Logger or console. */
export interface MinimalLogger {
  error(message: string, meta?: Record<string, unknown>): void
}

/** Runtime shape of the persisted state — the source is an external file, never trust it. */
const MonitorsStateSchema = z.object({
  nodeUnreachableStreak: z.number().int().nonnegative(),
  observatoryAlerted: z.boolean(),
  logsStaleAlerted: z.boolean(),
  nodeBadStateAlerted: z.boolean(),
})

/**
 * Recover whichever individual fields are still well-typed instead of falling
 * back to DEFAULT wholesale — a full reset would silently clear every dedup
 * flag and re-page every currently-active condition on the next run.
 */
function recoverFields(raw: unknown): MonitorsState {
  const obj =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {}
  const streak = z
    .number()
    .int()
    .nonnegative()
    .safeParse(obj.nodeUnreachableStreak)
  const observatory = z.boolean().safeParse(obj.observatoryAlerted)
  const logsStale = z.boolean().safeParse(obj.logsStaleAlerted)
  const nodeBadState = z.boolean().safeParse(obj.nodeBadStateAlerted)
  return {
    nodeUnreachableStreak: streak.success
      ? streak.data
      : DEFAULT_MONITORS_STATE.nodeUnreachableStreak,
    observatoryAlerted: observatory.success
      ? observatory.data
      : DEFAULT_MONITORS_STATE.observatoryAlerted,
    logsStaleAlerted: logsStale.success
      ? logsStale.data
      : DEFAULT_MONITORS_STATE.logsStaleAlerted,
    nodeBadStateAlerted: nodeBadState.success
      ? nodeBadState.data
      : DEFAULT_MONITORS_STATE.nodeBadStateAlerted,
  }
}

export async function loadMonitorsState(
  storage: Storage,
  logger?: MinimalLogger
): Promise<MonitorsState> {
  let raw: unknown
  try {
    const [content] = await storage
      .bucket(BUCKET_NAME)
      .file(STATE_FILE)
      .download()
    raw = JSON.parse(content.toString())
  } catch {
    // No object yet (first run) or unreadable — there is no prior state to
    // preserve, so a fresh DEFAULT is correct here (not a corruption case).
    return { ...DEFAULT_MONITORS_STATE }
  }

  const validated = MonitorsStateSchema.safeParse(raw)
  if (validated.success) return validated.data
  ;(logger ?? console).error(
    'monitors-state.json failed validation — recovering individual fields instead of resetting all dedup flags',
    { issues: validated.error.issues }
  )
  return recoverFields(raw)
}

export async function saveMonitorsState(
  storage: Storage,
  state: MonitorsState
): Promise<void> {
  await storage
    .bucket(BUCKET_NAME)
    .file(STATE_FILE)
    .save(JSON.stringify(state, null, 2), { contentType: 'application/json' })
}
