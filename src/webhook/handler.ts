import type { Logger } from 'winston'
import { fetchFileContent } from '../github/client'
import { parseVersionFromContent, classifyVersion } from '../version/parser'
import type { VersionInfo } from '../version/types'
import { NotificationSource } from '../version/types'
import { formatMessages } from '../notifications/formatter'
import type { MattermostPayload } from '../notifications/mattermost'
import { postToMattermost } from '../notifications/mattermost'
import { postToTwitter } from '../notifications/twitter'
import type { Summaries } from '../ai/summarizer'
import {
  summarizeReleaseByTag,
  summarizeBody,
  MIN_RELEASE_BODY_CHARS,
} from '../ai/summarizer'
import type { AppConfig } from '../config'
import {
  PushEventSchema,
  ReleaseEventSchema,
  type PushEvent,
  type ReleaseEvent,
} from './schemas'

const WATCHED_FILE = 'src/libxrpl/protocol/BuildInfo.cpp'
const BRANCH_REGEX = /^refs\/heads\/(develop|release-\d+\.\d+)$/
const TAG_REGEX = /^refs\/tags\/v?(.+)$/

export interface HandlerResult {
  action: string
  reason?: string
  version?: string
  type?: string
  branch?: string
  source?: string
}

export async function handlePushEvent(
  rawPayload: Record<string, unknown>,
  config: AppConfig,
  logger: Logger
): Promise<HandlerResult> {
  const parsed = PushEventSchema.safeParse(rawPayload)
  if (!parsed.success) {
    logger.warn('Push payload failed schema validation', {
      issues: parsed.error.issues.slice(0, 3),
    })
    return { action: 'ignored', reason: 'invalid push payload' }
  }
  const payload = parsed.data

  const ref = payload.ref
  if (!ref) {
    return { action: 'ignored', reason: 'missing ref' }
  }

  const tagMatch = ref.match(TAG_REGEX)
  if (tagMatch) {
    return handleTagPush(tagMatch[1], payload, config, logger)
  }

  const branchMatch = ref.match(BRANCH_REGEX)
  if (!branchMatch) {
    return { action: 'ignored', reason: 'branch not watched' }
  }
  return handleBranchPush(branchMatch[1], payload, config, logger)
}

async function handleBranchPush(
  branch: string,
  payload: PushEvent,
  config: AppConfig,
  logger: Logger
): Promise<HandlerResult> {
  const fileModified = payload.commits?.some(
    (c) =>
      Boolean(c.added?.includes(WATCHED_FILE)) ||
      Boolean(c.modified?.includes(WATCHED_FILE))
  )
  if (!fileModified) {
    return { action: 'ignored', reason: 'BuildInfo.cpp not modified' }
  }

  const sha = payload.after ?? ''
  let content: string
  try {
    content = await fetchFileContent(
      'XRPLF',
      'rippled',
      WATCHED_FILE,
      sha,
      config.githubToken
    )
  } catch (err) {
    logger.error('Failed to fetch BuildInfo.cpp', { error: err })
    throw err
  }

  const raw = parseVersionFromContent(content)
  if (!raw) {
    return { action: 'error', reason: 'Could not parse version string' }
  }

  const classified = classifyVersion(raw)
  const versionInfo: VersionInfo = {
    ...classified,
    branch,
    commitSha: sha,
    commitUrl: `https://github.com/XRPLF/rippled/commit/${sha}`,
  }

  const summary = await summarizeReleaseByTag({
    owner: 'XRPLF',
    repo: 'rippled',
    tag: raw,
    apiKey: config.anthropicApiKey,
    githubToken: config.githubToken,
    logger,
  })

  const messages = formatMessages(
    versionInfo,
    NotificationSource.WEBHOOK,
    summary
  )
  await sendNotifications(messages, config, logger)

  return {
    action: 'notified',
    version: raw,
    type: versionInfo.type,
    branch,
    source: 'branch',
  }
}

async function handleTagPush(
  tagName: string,
  payload: PushEvent,
  config: AppConfig,
  logger: Logger
): Promise<HandlerResult> {
  if (payload.deleted === true) {
    return { action: 'ignored', reason: 'tag deletion' }
  }

  let classified: ReturnType<typeof classifyVersion>
  try {
    classified = classifyVersion(tagName)
  } catch {
    return { action: 'ignored', reason: 'tag does not match version pattern' }
  }

  const headCommit = payload.head_commit
  const sha = headCommit?.id ?? payload.after ?? ''
  const commitUrl =
    headCommit?.url ??
    (sha ? `https://github.com/XRPLF/rippled/commit/${sha}` : '')

  const versionInfo: VersionInfo = {
    ...classified,
    branch: `tag:${tagName}`,
    commitSha: sha,
    commitUrl,
  }

  const summary = await summarizeReleaseByTag({
    owner: 'XRPLF',
    repo: 'rippled',
    tag: tagName,
    apiKey: config.anthropicApiKey,
    githubToken: config.githubToken,
    logger,
  })

  const messages = formatMessages(versionInfo, NotificationSource.TAG, summary)
  await sendNotifications(messages, config, logger)

  return {
    action: 'notified',
    version: classified.raw,
    type: classified.type,
    source: 'tag',
  }
}

export async function handleReleaseEvent(
  rawPayload: Record<string, unknown>,
  config: AppConfig,
  logger: Logger
): Promise<HandlerResult> {
  const parsed = ReleaseEventSchema.safeParse(rawPayload)
  if (!parsed.success) {
    logger.warn('Release payload failed schema validation', {
      issues: parsed.error.issues.slice(0, 3),
    })
    return { action: 'ignored', reason: 'invalid release payload' }
  }
  const payload: ReleaseEvent = parsed.data

  if (payload.action !== 'published') {
    return { action: 'ignored', reason: `release action: ${payload.action}` }
  }

  const release = payload.release
  if (!release || release.draft) {
    return { action: 'ignored', reason: 'draft or missing release' }
  }

  const tagName = release.tag_name
  if (!tagName) {
    return { action: 'ignored', reason: 'missing tag_name' }
  }

  let classified: ReturnType<typeof classifyVersion>
  try {
    classified = classifyVersion(tagName.replace(/^v/, ''))
  } catch {
    return {
      action: 'ignored',
      reason: 'release tag does not match version pattern',
    }
  }

  const versionInfo: VersionInfo = {
    ...classified,
    branch: `release:${tagName}`,
    commitSha: '',
    commitUrl: release.html_url ?? '',
  }

  const releaseBody = release.body
  let summaries: Summaries = { mattermost: null, twitter: null }
  if (
    config.anthropicApiKey &&
    releaseBody &&
    releaseBody.trim().length >= MIN_RELEASE_BODY_CHARS
  ) {
    summaries = await summarizeBody(
      releaseBody,
      tagName,
      config.anthropicApiKey,
      logger
    )
  }

  const messages = formatMessages(
    versionInfo,
    NotificationSource.RELEASE,
    summaries
  )
  await sendNotifications(messages, config, logger)

  return {
    action: 'notified',
    version: classified.raw,
    type: classified.type,
    source: 'release',
  }
}

/**
 * Twitter creds may legitimately be unset / placeholder while we wait for
 * a real account. Short-circuit instead of letting twitter-api-v2 spam the
 * logs with 401s on every notification.
 */
function twitterConfigured(config: AppConfig): boolean {
  return (
    config.twitterApiKey.length > 0 &&
    config.twitterApiKey !== 'placeholder' &&
    config.twitterApiSecret.length > 0 &&
    config.twitterApiSecret !== 'placeholder'
  )
}

export async function sendNotifications(
  messages: { mattermost: MattermostPayload; twitter: string },
  config: AppConfig,
  logger: Logger
): Promise<void> {
  const targets: { name: string; call: () => Promise<void> }[] = [
    {
      name: 'Mattermost',
      call: () =>
        postToMattermost(config.mattermostWebhookUrl, messages.mattermost),
    },
  ]

  if (twitterConfigured(config)) {
    targets.push({
      name: 'Twitter',
      call: () =>
        postToTwitter(
          {
            appKey: config.twitterApiKey,
            appSecret: config.twitterApiSecret,
            accessToken: config.twitterAccessToken,
            accessSecret: config.twitterAccessTokenSecret,
          },
          messages.twitter
        ),
    })
  } else {
    logger.info('Twitter not configured — skipping post', {
      tweet: messages.twitter,
    })
  }

  const results = await Promise.allSettled(targets.map((t) => t.call()))
  results.forEach((r, i) => {
    const name = targets[i].name
    if (r.status === 'rejected') {
      const reason: unknown = r.reason
      logger.error(`${name} notification failed`, {
        error: reason instanceof Error ? reason.message : String(reason),
      })
    } else {
      logger.info(`${name} notification sent`)
    }
  })
}
