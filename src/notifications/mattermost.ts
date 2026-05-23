import axios from 'axios'
import type { VersionInfo } from '../version/types'
import { VersionType, NotificationSource } from '../version/types'

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

const USERNAME = 'rippled releases'
const ICON_URL = 'https://eotjzkw.dlvr.cloud/pasted_2.png'
const FOOTER = 'xrplf-release-notifier'

const COLOR_BETA = '#3F51B5'
const COLOR_RC = '#FF9800'
const COLOR_FINAL = '#4CAF50'
const COLOR_TAG = '#2196F3'

/**
 * Build the Mattermost payload for a notification event and append the
 * AI-generated summary bullets to the attachment body.
 */
export function formatMattermost(
  version: VersionInfo,
  source: NotificationSource,
  summaryMarkdown: string
): MattermostPayload {
  const payload = (() => {
    switch (source) {
      case NotificationSource.BINARY_POLL:
        return binaryPayload(version)
      case NotificationSource.TAG:
        return tagPayload(version)
      case NotificationSource.RELEASE:
        return releasePayload(version)
      case NotificationSource.WEBHOOK:
        return webhookPayload(version)
    }
  })()

  const att = payload.attachments?.[0]
  if (att) {
    const existing = att.text ? `${att.text}\n\n` : ''
    att.text = `${existing}${summaryMarkdown}`
  }
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

function envelope(
  attachment: Omit<MattermostAttachment, 'footer' | 'ts'>
): MattermostPayload {
  return {
    username: USERNAME,
    icon_url: ICON_URL,
    attachments: [
      {
        ...attachment,
        footer: FOOTER,
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  }
}

function webhookPayload(version: VersionInfo): MattermostPayload {
  switch (version.type) {
    case VersionType.BETA:
      return envelope({
        fallback: `rippled ${version.raw} (beta) version bumped on ${version.branch}`,
        color: COLOR_BETA,
        pretext: `:test_tube: rippled \`${version.raw}\` (beta) version bumped on \`${version.branch}\`.`,
        title: 'View commit',
        title_link: version.commitUrl,
      })
    case VersionType.RC:
      return envelope({
        fallback: `rippled ${version.raw} release candidate available on ${version.branch}`,
        color: COLOR_RC,
        pretext: `:rocket: rippled \`${version.raw}\` release candidate is now available on \`${version.branch}\`.`,
        text: 'Operators: please begin testing.',
        title: 'View commit',
        title_link: version.commitUrl,
      })
    case VersionType.FINAL:
      return envelope({
        fallback: `rippled ${version.raw} version finalized on ${version.branch}`,
        color: COLOR_FINAL,
        pretext: `:tada: rippled \`${version.raw}\` version finalized on \`${version.branch}\` — release expected soon.`,
        text: 'A GitHub Release and binary packages will follow.',
        title: 'View commit',
        title_link: version.commitUrl,
      })
  }
}

function binaryPayload(version: VersionInfo): MattermostPayload {
  return envelope({
    fallback: `rippled ${version.raw} binary packages available on repos.ripple.com`,
    color: COLOR_FINAL,
    pretext: `:package: rippled \`${version.raw}\` binary packages are now available!`,
    text:
      `Install:\n` +
      `• \`apt-get install rippled=${version.raw}-1\` (deb)\n` +
      `• \`yum install rippled-${version.raw}\` (rpm)`,
    title: 'repos.ripple.com',
    title_link: 'https://repos.ripple.com',
  })
}

function tagPayload(version: VersionInfo): MattermostPayload {
  return envelope({
    fallback: `rippled ${version.raw} tag pushed`,
    color: COLOR_TAG,
    pretext: `:label: rippled \`${version.raw}\` tag has been pushed to \`XRPLF/rippled\`.`,
    title: 'View commit',
    title_link: version.commitUrl,
  })
}

function releasePayload(version: VersionInfo): MattermostPayload {
  const isPrerelease =
    version.type === VersionType.BETA || version.type === VersionType.RC
  if (isPrerelease) {
    return envelope({
      fallback: `rippled ${version.raw} pre-release published on GitHub`,
      color: COLOR_RC,
      pretext: `:loudspeaker: rippled \`${version.raw}\` pre-release has been published on GitHub.`,
      title: 'Release notes',
      title_link: version.commitUrl,
    })
  }
  return envelope({
    fallback: `rippled ${version.raw} release published on GitHub`,
    color: COLOR_FINAL,
    pretext: `:loudspeaker: rippled \`${version.raw}\` release has been published on GitHub!`,
    text: 'Node operators: review the release notes and plan your upgrade.',
    title: 'Release notes',
    title_link: version.commitUrl,
  })
}
