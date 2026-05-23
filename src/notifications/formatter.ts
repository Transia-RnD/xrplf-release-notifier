import type { VersionInfo } from '../version/types'
import { VersionType, NotificationSource } from '../version/types'
import type { MattermostAttachment, MattermostPayload } from './mattermost'
import type { Summaries } from '../ai/summarizer'

export interface FormattedMessages {
  mattermost: MattermostPayload
  twitter: string
}

const NO_SUMMARIES: Summaries = { mattermost: null, twitter: null }

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
  summaries: Summaries = NO_SUMMARIES
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

  if (summaries.mattermost && msgs.mattermost.attachments?.[0]) {
    const att = msgs.mattermost.attachments[0]
    const existing = att.text ? `${att.text}\n\n` : ''
    att.text = `${existing}${summaries.mattermost}`
  }

  if (summaries.twitter) {
    msgs.twitter = summaries.twitter
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
          fallback: `rippled ${version.raw} (beta) version bumped on ${version.branch}`,
          color: COLOR_BETA,
          pretext: `:test_tube: rippled \`${version.raw}\` (beta) version bumped on \`${version.branch}\`.`,
          title: 'View commit',
          title_link: version.commitUrl,
        }),
        twitter: `rippled ${version.raw} (beta) version bumped on the ${version.branch} branch. #XRPLedger #rippled`,
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
          fallback: `rippled ${version.raw} version finalized on ${version.branch}`,
          color: COLOR_FINAL,
          pretext: `:tada: rippled \`${version.raw}\` version finalized on \`${version.branch}\` — release expected soon.`,
          text: 'A GitHub Release and binary packages will follow.',
          title: 'View commit',
          title_link: version.commitUrl,
        }),
        twitter: `rippled ${version.raw} version finalized on the ${version.branch} branch — release expected soon. #XRPLedger #rippled`,
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
      title: 'View commit',
      title_link: version.commitUrl,
    }),
    twitter: `rippled ${version.raw} has been tagged on XRPLF/rippled. #XRPLedger #rippled`,
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
