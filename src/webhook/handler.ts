import { Logger } from 'winston'
import { fetchFileContent } from '../github/client'
import { parseVersionFromContent, classifyVersion } from '../version/parser'
import { VersionInfo, NotificationSource } from '../version/types'
import { formatMessages } from '../notifications/formatter'
import {
  postToMattermost,
  MattermostPayload,
} from '../notifications/mattermost'
import { postToTwitter } from '../notifications/twitter'
import { summarizeReleaseByTag, summarizeBody } from '../ai/summarizer'
import { AppConfig } from '../config'

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
  payload: Record<string, unknown>,
  config: AppConfig,
  logger: Logger
): Promise<HandlerResult> {
  const ref = payload.ref as string | undefined
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
  payload: Record<string, unknown>,
  config: AppConfig,
  logger: Logger
): Promise<HandlerResult> {
  const commits = payload.commits as Array<{
    added?: string[]
    modified?: string[]
  }>
  const fileModified = commits?.some(
    (c) =>
      c.added?.includes(WATCHED_FILE) || c.modified?.includes(WATCHED_FILE)
  )
  if (!fileModified) {
    return { action: 'ignored', reason: 'BuildInfo.cpp not modified' }
  }

  const sha = payload.after as string
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

  const messages = formatMessages(versionInfo, NotificationSource.WEBHOOK, summary)
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
  payload: Record<string, unknown>,
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

  const headCommit = payload.head_commit as
    | { id?: string; url?: string }
    | undefined
  const sha = headCommit?.id ?? (payload.after as string) ?? ''
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
  payload: Record<string, unknown>,
  config: AppConfig,
  logger: Logger
): Promise<HandlerResult> {
  const action = payload.action as string | undefined
  if (action !== 'published') {
    return { action: 'ignored', reason: `release action: ${action}` }
  }

  const release = payload.release as
    | {
        tag_name?: string
        html_url?: string
        draft?: boolean
        prerelease?: boolean
      }
    | undefined

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

  const releaseBody = (payload.release as { body?: string } | undefined)?.body
  let summary: string | null = null
  if (config.anthropicApiKey && releaseBody && releaseBody.trim().length >= 20) {
    summary = await summarizeBody(releaseBody, tagName, config.anthropicApiKey, logger)
  }

  const messages = formatMessages(versionInfo, NotificationSource.RELEASE, summary)
  await sendNotifications(messages, config, logger)

  return {
    action: 'notified',
    version: classified.raw,
    type: classified.type,
    source: 'release',
  }
}

export async function sendNotifications(
  messages: { mattermost: MattermostPayload; twitter: string },
  config: AppConfig,
  logger: Logger
): Promise<void> {
  const results = await Promise.allSettled([
    postToMattermost(config.mattermostWebhookUrl, messages.mattermost),
    postToTwitter(
      {
        appKey: config.twitterApiKey,
        appSecret: config.twitterApiSecret,
        accessToken: config.twitterAccessToken,
        accessSecret: config.twitterAccessTokenSecret,
      },
      messages.twitter
    ),
  ])

  results.forEach((r, i) => {
    const target = i === 0 ? 'Mattermost' : 'Twitter'
    if (r.status === 'rejected') {
      logger.error(`${target} notification failed`, { error: r.reason })
    } else {
      logger.info(`${target} notification sent`)
    }
  })
}
