import type { Storage } from '@google-cloud/storage'

/**
 * Caches the file locations the parity agent resolved per SDK, so subsequent
 * runs can hand the agent a verified starting point instead of re-discovering
 * from scratch. Keyed by repo, stamped with the ref's commit SHA so a run can
 * tell whether the repo moved since the cache was written (drift logging). The
 * agent always re-verifies against live files, so a stale hint is harmless —
 * the cache is an optimization, never a source of truth.
 */

const BUCKET_NAME = process.env.GCS_BUCKET ?? 'xrplf-release-notifier'
const CACHE_FILE = 'parity-locations.json'

export interface SdkLocations {
  definitions: string | null
  models: string[]
  registries: string[]
}

export interface CacheEntry {
  sha: string
  locations: SdkLocations
}

/** repo full-name -> cached entry. */
export type LocationsCache = Record<string, CacheEntry>

export async function loadLocationsCache(
  storage: Storage
): Promise<LocationsCache> {
  try {
    const [content] = await storage
      .bucket(BUCKET_NAME)
      .file(CACHE_FILE)
      .download()
    return JSON.parse(content.toString()) as LocationsCache
  } catch {
    return {}
  }
}

export async function saveLocationsCache(
  storage: Storage,
  cache: LocationsCache
): Promise<void> {
  await storage
    .bucket(BUCKET_NAME)
    .file(CACHE_FILE)
    .save(JSON.stringify(cache, null, 2), { contentType: 'application/json' })
}

/** The cached locations for a repo (hint only), or null if never resolved. */
export function getCachedLocations(
  cache: LocationsCache,
  repo: string
): SdkLocations | null {
  return cache[repo]?.locations ?? null
}

/** True when the cache was written against the same commit (no drift). */
export function isCacheWarm(
  cache: LocationsCache,
  repo: string,
  sha: string | null
): boolean {
  return Boolean(sha) && cache[repo]?.sha === sha
}

export function setCachedLocations(
  cache: LocationsCache,
  repo: string,
  sha: string,
  locations: SdkLocations
): void {
  cache[repo] = { sha, locations }
}
