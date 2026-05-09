import { VersionInfo, VersionType, NotificationSource } from '../version/types'
import { MattermostAttachment, MattermostPayload } from './mattermost'

export interface FormattedMessages {
  mattermost: MattermostPayload
  twitter: string
}

const USERNAME = 'rippled releases'
const ICON_URL = 'https://eotjzkw.dlvr.cloud/pasted_2.png'
const FOOTER = 'xrplf-release-notifier'

const COLOR_BETA = '#3F51B5'
const COLOR_RC = '#FF9800'
const COLOR_FINAL = '#4CAF50'
const COLOR_TAG = '#2196F3'

export function formatMessages(
  version: VersionInfo,
  source: NotificationSource = NotificationSource.WEBHOOK,
  summary: string | null = null
): FormattedMessages {
  const msgs = (() => {
    switch (source) {
      case NotificationSource.BINARY_POLL:
        return formatBinaryMessages(version)
      case NotificationSource.TAG:
        return formatTagMessages(version)
      case NotificationSource.RELEASE:
        return formatReleaseMessages(version)
      default:
        return formatWebhookMessages(version)
    }
  })()

  if (summary && msgs.mattermost.attachments?.[0]) {
    const att = msgs.mattermost.attachments[0]
    const existing = att.text ? `${att.text}\n\n` : ''
    att.text = `${existing}**What's in this release:**\n${summary}`
  }

  return msgs
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

function formatWebhookMessages(version: VersionInfo): FormattedMessages {
  switch (version.type) {
    case VersionType.BETA:
      return {
        mattermost: envelope({
          fallback: `rippled ${version.raw} (beta) tagged on ${version.branch}`,
          color: COLOR_BETA,
          pretext: `:test_tube: rippled \`${version.raw}\` (beta) has been tagged on \`${version.branch}\`.`,
          title: 'View commit',
          title_link: version.commitUrl,
        }),
        twitter: `rippled ${version.raw} (beta) has been tagged on the ${version.branch} branch. #XRPLedger #rippled`,
      }
    case VersionType.RC:
      return {
        mattermost: envelope({
          fallback: `rippled ${version.raw} release candidate available on ${version.branch}`,
          color: COLOR_RC,
          pretext: `:rocket: rippled \`${version.raw}\` release candidate is now available on \`${version.branch}\`.`,
          text: 'Operators: please begin testing.',
          title: 'View commit',
          title_link: version.commitUrl,
        }),
        twitter: `rippled ${version.raw} release candidate is now available. Operators: please begin testing. #XRPLedger #rippled`,
      }
    case VersionType.FINAL:
      return {
        mattermost: envelope({
          fallback: `rippled ${version.raw} officially released on ${version.branch}`,
          color: COLOR_FINAL,
          pretext: `:tada: rippled \`${version.raw}\` has been officially released on \`${version.branch}\`!`,
          text: 'Operators should upgrade as soon as possible.',
          title: 'View commit',
          title_link: version.commitUrl,
        }),
        twitter: `rippled ${version.raw} has been officially released! Node operators should upgrade. #XRPLedger #rippled`,
      }
  }
}

function formatBinaryMessages(version: VersionInfo): FormattedMessages {
  return {
    mattermost: envelope({
      fallback: `rippled ${version.raw} binary packages available on repos.ripple.com`,
      color: COLOR_FINAL,
      pretext: `:package: rippled \`${version.raw}\` binary packages are now available!`,
      text:
        `Install:\n` +
        `• \`apt-get install rippled=${version.raw}-1\` (deb)\n` +
        `• \`yum install rippled-${version.raw}\` (rpm)`,
      title: 'repos.ripple.com',
      title_link: 'https://repos.ripple.com',
    }),
    twitter: `rippled ${version.raw} binary packages are now available on repos.ripple.com. Node operators can upgrade via apt or yum. #XRPLedger #rippled`,
  }
}

function formatTagMessages(version: VersionInfo): FormattedMessages {
  return {
    mattermost: envelope({
      fallback: `rippled ${version.raw} tag pushed`,
      color: COLOR_TAG,
      pretext: `:label: rippled \`${version.raw}\` tag has been pushed to \`XRPLF/rippled\`.`,
      text: 'This marks the canonical release point.',
      title: 'View commit',
      title_link: version.commitUrl,
    }),
    twitter: `rippled ${version.raw} has been tagged on XRPLF/rippled — canonical release point. #XRPLedger #rippled`,
  }
}

function formatReleaseMessages(version: VersionInfo): FormattedMessages {
  const isPrerelease =
    version.type === VersionType.BETA || version.type === VersionType.RC
  if (isPrerelease) {
    return {
      mattermost: envelope({
        fallback: `rippled ${version.raw} pre-release published on GitHub`,
        color: COLOR_RC,
        pretext: `:loudspeaker: rippled \`${version.raw}\` pre-release has been published on GitHub.`,
        title: 'Release notes',
        title_link: version.commitUrl,
      }),
      twitter: `rippled ${version.raw} pre-release has been published on GitHub. #XRPLedger #rippled`,
    }
  }
  return {
    mattermost: envelope({
      fallback: `rippled ${version.raw} release published on GitHub`,
      color: COLOR_FINAL,
      pretext: `:loudspeaker: rippled \`${version.raw}\` release has been published on GitHub!`,
      text: 'Node operators: review the release notes and plan your upgrade.',
      title: 'Release notes',
      title_link: version.commitUrl,
    }),
    twitter: `rippled ${version.raw} release has been published on GitHub. Node operators should review and plan an upgrade. #XRPLedger #rippled`,
  }
}
