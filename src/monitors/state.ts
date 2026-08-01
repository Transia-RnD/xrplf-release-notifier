import type { Storage } from '@google-cloud/storage'
import { DEFAULT_MONITORS_STATE, type MonitorsState } from './rules'

const BUCKET_NAME = process.env.GCS_BUCKET ?? 'xrplf-release-notifier'
const STATE_FILE = 'monitors-state.json'

export async function loadMonitorsState(
  storage: Storage
): Promise<MonitorsState> {
  try {
    const [content] = await storage
      .bucket(BUCKET_NAME)
      .file(STATE_FILE)
      .download()
    const parsed = JSON.parse(content.toString()) as Partial<MonitorsState>
    return { ...DEFAULT_MONITORS_STATE, ...parsed }
  } catch {
    return { ...DEFAULT_MONITORS_STATE }
  }
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
