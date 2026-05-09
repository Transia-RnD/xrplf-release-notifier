import { Storage } from '@google-cloud/storage'
import { PollerState } from './binary-checker'

const BUCKET_NAME = process.env.GCS_BUCKET || 'xrplf-release-notifier'
const STATE_FILE = 'poller-state.json'

const DEFAULT_STATE: PollerState = { deb: null, rpm: null }

export async function loadPollerState(
  storage: Storage
): Promise<PollerState> {
  try {
    const [content] = await storage
      .bucket(BUCKET_NAME)
      .file(STATE_FILE)
      .download()
    return JSON.parse(content.toString())
  } catch {
    return DEFAULT_STATE
  }
}

export async function savePollerState(
  storage: Storage,
  state: PollerState
): Promise<void> {
  await storage
    .bucket(BUCKET_NAME)
    .file(STATE_FILE)
    .save(JSON.stringify(state, null, 2), {
      contentType: 'application/json',
    })
}
