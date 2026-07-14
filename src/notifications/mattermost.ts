import axios from 'axios'
import type { VersionInfo } from '../version/types'
import { VersionType, NotificationSource } from '../version/types'
import type { RepoConfig } from '../github/repos'
import { PUBLIC_REPO, repoFullName } from '../github/repos'

export interface MattermostAttachment {
  fallback: string
  color: string
  pretext?: string
  title?: string
  title_link?: string
  text?: string
  footer?: string
  ts?: number
}

export interface MattermostPayload {
  username?: string
  icon_url?: string
  text?: string
  attachments?: MattermostAttachment[]
}

const USERNAME = 'xrpld releases'
const ICON_URL = 'https://eotjzkw.dlvr.cloud/pasted_2.png'
const FOOTER = 'xrplf-release-notifier'

const COLOR_RC = '#FF9800'
const COLOR_FINAL = '#4CAF50'
const COLOR_TAG = '#2196F3'
const COLOR_HEADSUP = '#9E9E9E'
const COLOR_BREAKING = '#E53935'
const COLOR_GATED = '#FF9800'

/**
 * Build the Mattermost payload for a notification event and append the
 * AI-generated summary bullets to the attachment body.
 */
/**
 * Severity of a tag post, driven by the diff-based scan:
 * - 'breaking' → something breaks for operators on upgrade (red).
 * - 'surface'  → only new protocol surface; SDKs must add support (amber).
 * - 'none'     → nothing flagged (blue).
 */
export type TagBreakingLevel = 'none' | 'surface' | 'breaking'

export function formatMattermost(
  version: VersionInfo,
  source: NotificationSource,
  summaryMarkdown: string,
  repo: RepoConfig = PUBLIC_REPO,
  tagLevel: TagBreakingLevel = 'none'
): MattermostPayload {
  const payload = (() => {
    switch (source) {
      case NotificationSource.BINARY_POLL:
        return binaryPayload(version)
      case NotificationSource.TAG:
        return tagPayload(version, repo, tagLevel)
      case NotificationSource.RELEASE:
        return releasePayload(version)
    }
  })()

  const att = payload.attachments?.[0]
  if (att) {
    const existing = att.text ? `${att.text}\n\n` : ''
    att.text = `${existing}${summaryMarkdown}`
  }
  return payload
}

/**
 * Heads-up posted when a tag is pushed on the private mirror but no curated
 * release notes exist (BETA tags only — RC/FINAL tags are covered by the
 * private release-event path below). Carries no body and no link — we have
 * nothing more than the version + SHA from the webhook payload, and a link
 * to the private repo would 404 for most Mattermost readers.
 */
export function formatMattermostPrivateTagHeadsUp(
  version: VersionInfo,
  repo: RepoConfig
): MattermostPayload {
  const shaSuffix = version.commitSha
    ? ` (\`${version.commitSha.slice(0, 7)}\`)`
    : ''
  return envelope({
    fallback: `xrpld ${version.raw} tag pushed to ${repoFullName(repo)}`,
    color: COLOR_HEADSUP,
    pretext: `:lock: xrpld \`${version.raw}\` tagged on \`${repoFullName(repo)}\`${shaSuffix} — public mirror expected to follow.`,
  })
}

/**
 * Heads-up posted when a release is published on the private mirror. Uses
 * the AI-summarized release body that already came in the webhook payload
 * — no GitHub API call is made, so no broken-token risk and no leak of
 * anything we don't already have. The summary still goes through Claude
 * for consistency with the public copy.
 */
export function formatMattermostPrivateReleaseHeadsUp(
  version: VersionInfo,
  repo: RepoConfig,
  summaryMarkdown: string
): MattermostPayload {
  const payload = envelope({
    fallback: `xrpld ${version.raw} released on ${repoFullName(repo)}`,
    color: COLOR_HEADSUP,
    pretext: `:lock: xrpld \`${version.raw}\` released on \`${repoFullName(repo)}\` — public mirror expected to follow.`,
  })
  const att = payload.attachments?.[0]
  if (att) att.text = summaryMarkdown
  return payload
}

export async function postToMattermost(
  webhookUrl: string,
  payload: MattermostPayload
): Promise<void> {
  const response = await axios.post(webhookUrl, payload)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Mattermost webhook failed with status ${response.status}`)
  }
}

/**
 * Standard single-attachment Mattermost envelope (notifier identity + footer +
 * timestamp). Exported so sibling features (e.g. the SDK parity report) post
 * with the same look. `username`/`icon_url` may be overridden per call.
 */
export function envelope(
  attachment: Omit<MattermostAttachment, 'footer' | 'ts'>,
  identity?: { username?: string; icon_url?: string }
): MattermostPayload {
  return {
    username: identity?.username ?? USERNAME,
    icon_url: identity?.icon_url ?? ICON_URL,
    attachments: [
      {
        ...attachment,
        footer: FOOTER,
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  }
}

function binaryPayload(version: VersionInfo): MattermostPayload {
  return envelope({
    fallback: `xrpld ${version.raw} binary packages available on repos.ripple.com`,
    color: COLOR_FINAL,
    pretext: `:package: xrpld \`${version.raw}\` binary packages are now available!`,
    text:
      `Install:\n` +
      `• \`apt-get install xrpld=${version.raw}-1\` (deb)\n` +
      `• \`yum install xrpld-${version.raw}\` (rpm)`,
    title: 'repos.ripple.com',
    title_link: 'https://repos.ripple.com',
  })
}

function tagPayload(
  version: VersionInfo,
  repo: RepoConfig,
  level: TagBreakingLevel = 'none'
): MattermostPayload {
  // Escalate the colour and the icon by severity — a glanceable "read this one"
  // signal in a stream of routine tag posts. 'breaking' = operators act on
  // upgrade; 'gated' = SDKs must add support before the amendment activates.
  const repoName = repoFullName(repo)
  const { color, pretext } = (() => {
    switch (level) {
      case 'breaking':
        return {
          color: COLOR_BREAKING,
          pretext: `:rotating_light: xrpld \`${version.raw}\` tag has been pushed to \`${repoName}\` — contains breaking changes.`,
        }
      case 'surface':
        return {
          color: COLOR_GATED,
          pretext: `:sparkles: xrpld \`${version.raw}\` tag has been pushed to \`${repoName}\` — new protocol surface; SDK support needed.`,
        }
      case 'none':
        return {
          color: COLOR_TAG,
          pretext: `:label: xrpld \`${version.raw}\` tag has been pushed to \`${repoName}\`.`,
        }
    }
  })()
  return envelope({
    fallback: `xrpld ${version.raw} tag pushed`,
    color,
    pretext,
    title: 'View commit',
    title_link: version.commitUrl,
  })
}

function releasePayload(version: VersionInfo): MattermostPayload {
  const isPrerelease =
    version.type === VersionType.BETA || version.type === VersionType.RC
  if (isPrerelease) {
    return envelope({
      fallback: `xrpld ${version.raw} pre-release published on GitHub`,
      color: COLOR_RC,
      pretext: `:loudspeaker: xrpld \`${version.raw}\` pre-release has been published on GitHub.`,
      title: 'Release notes',
      title_link: version.commitUrl,
    })
  }
  return envelope({
    fallback: `xrpld ${version.raw} release published on GitHub`,
    color: COLOR_FINAL,
    pretext: `:loudspeaker: xrpld \`${version.raw}\` release has been published on GitHub!`,
    text: 'Node operators: review the release notes and plan your upgrade.',
    title: 'Release notes',
    title_link: version.commitUrl,
  })
}
