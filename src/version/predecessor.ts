import { listVersionTags } from '../github/client'
import { compareVersions } from '../poller/binary-checker'

/**
 * Find the version tag immediately preceding `tag` in the given repo.
 *
 * For a FINAL target (X.Y.Z) we skip all prereleases and compare against the
 * last stable. For a beta/RC target we take the closest semver predecessor of
 * any type. Returns the raw tag (with whatever `v` prefix it carries on the
 * repo), or null when no predecessor exists.
 *
 * Shared by the commit-compare summary path and the breaking-change detector
 * so both anchor to the same base.
 */
export async function findPredecessorTag(
  owner: string,
  repo: string,
  tag: string,
  token?: string
): Promise<string | null> {
  const tags = await listVersionTags(owner, repo, token)

  const target = tag.replace(/^v/, '')
  const targetIsFinal = !target.includes('-')

  const predecessors = tags
    .map((t) => ({ raw: t, normalized: t.replace(/^v/, '') }))
    .filter((t) => t.normalized !== target)
    .filter((t) => compareVersions(t.normalized, target) < 0)
    .filter((t) => (targetIsFinal ? !t.normalized.includes('-') : true))
    .sort((a, b) => compareVersions(a.normalized, b.normalized))

  return predecessors.at(-1)?.raw ?? null
}

/**
 * The newest FINAL tag in the repo — the "what is released right now" anchor
 * for audits that aren't triggered by a specific release.
 */
export async function latestFinalTag(
  owner: string,
  repo: string,
  token?: string
): Promise<string | null> {
  const tags = await listVersionTags(owner, repo, token)
  return (
    tags
      .map((t) => ({ raw: t, normalized: t.replace(/^v/, '') }))
      .filter((t) => !t.normalized.includes('-'))
      .sort((a, b) => compareVersions(a.normalized, b.normalized))
      .at(-1)?.raw ?? null
  )
}

/**
 * Find the immediately previous tag of ANY type (beta/RC/final) before `tag`.
 * This is the right base for breaking-on-upgrade: it keeps the diff small and
 * reliable (no 300-file compare-cap truncation), and each breaking change is
 * caught once, on the tag that introduced it. For a FINAL target this returns
 * the last prerelease (e.g. 3.2.0 → 3.2.0-b7), NOT the last stable.
 */
export async function findPreviousTag(
  owner: string,
  repo: string,
  tag: string,
  token?: string
): Promise<string | null> {
  const tags = await listVersionTags(owner, repo, token)

  const target = tag.replace(/^v/, '')
  const predecessors = tags
    .map((t) => ({ raw: t, normalized: t.replace(/^v/, '') }))
    .filter((t) => t.normalized !== target)
    .filter((t) => compareVersions(t.normalized, target) < 0)
    .sort((a, b) => compareVersions(a.normalized, b.normalized))

  return predecessors.at(-1)?.raw ?? null
}

/**
 * Whether the FINAL release of `tag`'s line (X.Y.Z for X.Y.Z-bN/-rcN) already
 * exists in the repo. Used to debounce prerelease work when a whole privately
 * built tag train (rc1..rcN + final) syncs to the public repo at once — the
 * final's report supersedes every RC's.
 */
export async function finalTagExists(
  owner: string,
  repo: string,
  tag: string,
  token?: string
): Promise<boolean> {
  const releaseLine = tag.replace(/^v/, '').replace(/-.*$/, '')
  const tags = await listVersionTags(owner, repo, token)
  return tags.some((t) => t.replace(/^v/, '') === releaseLine)
}

/**
 * Find the last FINAL (stable) release strictly before `tag`'s release line —
 * the right baseline for "what's new for SDKs in this release". For a beta like
 * 3.2.0-b7 (or the 3.2.0 final, or an RC) this returns 3.1.3, so the surface
 * accumulates across the whole pre-release cycle rather than resetting each beta.
 */
export async function findLastFinalTag(
  owner: string,
  repo: string,
  tag: string,
  token?: string
): Promise<string | null> {
  const tags = await listVersionTags(owner, repo, token)

  // Strip the v prefix and any -bN/-rcN suffix → the X.Y.Z release this tag targets.
  const targetRelease = tag.replace(/^v/, '').replace(/-.*$/, '')

  const finals = tags
    .map((t) => ({ raw: t, normalized: t.replace(/^v/, '') }))
    .filter((t) => !t.normalized.includes('-')) // finals only
    .filter((t) => compareVersions(t.normalized, targetRelease) < 0) // before this release
    .sort((a, b) => compareVersions(a.normalized, b.normalized))

  return finals.at(-1)?.raw ?? null
}
