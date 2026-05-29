import { VersionType } from './types'

const VERSION_PARTS = /^(\d+)\.(\d+)\.(\d+)(?:-(b|rc)(\d+))?$/

export function classifyVersion(raw: string) {
  const m = raw.match(VERSION_PARTS)
  if (!m) throw new Error(`Unrecognized version format: ${raw}`)

  const suffix = m[4] as 'b' | 'rc' | undefined
  const type =
    suffix === 'b'
      ? VersionType.BETA
      : suffix === 'rc'
        ? VersionType.RC
        : VersionType.FINAL

  return {
    raw,
    major: +m[1],
    minor: +m[2],
    patch: +m[3],
    type,
  }
}
