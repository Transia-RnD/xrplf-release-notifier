import type { Storage } from '@google-cloud/storage'

const BUCKET_NAME = process.env.GCS_BUCKET ?? 'xrplf-release-notifier'
const PREFIX = 'dedup/'

export type DedupChannel = 'mattermost' | 'twitter'
export type DedupScenario =
  | 'tag'
  | 'release'
  | 'binary'
  | 'tag-private'
  | 'release-private'

export interface ClaimMetadata {
  channel: DedupChannel
  scenario: DedupScenario
  version: string
  repo: string
  claimedAt: string
}

/**
 * Slug-safe object name. Version strings can contain `.` and `-` which are
 * fine for GCS, but we sanitize anything weird just in case.
 */
function keyToObjectName(
  channel: DedupChannel,
  scenario: DedupScenario,
  version: string
): string {
  const safe = version.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${PREFIX}${channel}-${scenario}-${safe}.json`
}

/**
 * Atomically claim a `(channel, scenario, version)` slot. Returns true the
 * first time this key is claimed and false on every subsequent call.
 *
 * Backed by GCS `ifGenerationMatch: 0`, which only allows the write when the
 * object does not yet exist. Two webhooks racing for the same key will both
 * try the write; exactly one PUT lands, the other returns HTTP 412 and we
 * treat that as "already claimed".
 */
export async function tryClaim(
  storage: Storage,
  channel: DedupChannel,
  scenario: DedupScenario,
  version: string,
  repo: string
): Promise<boolean> {
  const meta: ClaimMetadata = {
    channel,
    scenario,
    version,
    repo,
    claimedAt: new Date().toISOString(),
  }
  const file = storage
    .bucket(BUCKET_NAME)
    .file(keyToObjectName(channel, scenario, version))
  try {
    await file.save(JSON.stringify(meta), {
      contentType: 'application/json',
      preconditionOpts: { ifGenerationMatch: 0 },
    })
    return true
  } catch (err: unknown) {
    if (isPreconditionFailed(err)) return false
    throw err
  }
}

function isPreconditionFailed(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: number | string }).code
  return code === 412 || code === '412'
}
