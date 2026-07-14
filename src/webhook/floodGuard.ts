import type { MattermostPayload } from '../notifications/mattermost'

// Guards against bulk tag backfills: a mirror/tag-sync job pushing a repo's
// full tag history fires one webhook per tag, which would otherwise post one
// notification per tag (139 posts on 2026-07-14 when xrpld-private synced
// tags from upstream). State is in-memory per instance; the service runs
// with max-instances=1, so a flood lands on one instance and every event —
// allowed or suppressed — extends the window, keeping a sustained flood
// suppressed until it has been quiet for a full window.

const DEFAULT_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_LIMIT = 3

export interface FloodCheck {
  allowed: boolean
  /** true exactly once per suppression episode — caller posts one notice */
  announceSuppression: boolean
  recentCount: number
}

export class TagFloodGuard {
  private events = new Map<string, number[]>()
  private announced = new Set<string>()

  constructor(
    readonly windowMs: number = DEFAULT_WINDOW_MS,
    readonly limit: number = DEFAULT_LIMIT
  ) {}

  check(repo: string, now: number = Date.now()): FloodCheck {
    const cutoff = now - this.windowMs
    const recent = (this.events.get(repo) ?? []).filter((t) => t > cutoff)
    recent.push(now)
    this.events.set(repo, recent)

    if (recent.length <= this.limit) {
      this.announced.delete(repo)
      return {
        allowed: true,
        announceSuppression: false,
        recentCount: recent.length,
      }
    }
    const announceSuppression = !this.announced.has(repo)
    this.announced.add(repo)
    return { allowed: false, announceSuppression, recentCount: recent.length }
  }

  reset(): void {
    this.events.clear()
    this.announced.clear()
  }
}

export const tagFloodGuard = new TagFloodGuard()

export function formatTagFloodNotice(
  repoFullName: string,
  recentCount: number,
  windowMs: number
): MattermostPayload {
  const minutes = Math.round(windowMs / 60000)
  return {
    text:
      `:no_bell: **Bulk tag push detected on \`${repoFullName}\`** — ` +
      `${recentCount} tag events within ${minutes} minutes. ` +
      `Suppressing further tag notifications for this repo until the flood stops ` +
      `(likely a mirror/tag sync, not new releases).`,
  }
}
