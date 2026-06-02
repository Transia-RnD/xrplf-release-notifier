import type { Logger } from 'winston'
import type { Storage } from '@google-cloud/storage'
import { classifyVersion } from '../version/parser'
import type { VersionInfo } from '../version/types'
import { NotificationSource } from '../version/types'
import type { MattermostPayload } from '../notifications/mattermost'
import {
  formatMattermost,
  formatMattermostPrivateTagHeadsUp,
  formatMattermostPrivateReleaseHeadsUp,
  postToMattermost,
} from '../notifications/mattermost'
import { postToTwitter } from '../notifications/twitter'
import {
  summarizeReleaseByTag,
  summarizeBody,
  MIN_RELEASE_BODY_CHARS,
} from '../ai/summarizer'
import type { AppConfig } from '../config'
import type { RepoConfig } from '../github/repos'
import { findRepoByFullName, repoFullName } from '../github/repos'
import {
  PushEventSchema,
  ReleaseEventSchema,
  type PushEvent,
  type ReleaseEvent,
} from './schemas'

const TAG_REGEX = /^refs\/tags\/v?(.+)$/

export interface HandlerResult {
  action: string
  reason?: string
  version?: string
  type?: string
  branch?: string
  source?: string
  repo?: string
}

export interface HandlerDeps {
  config: AppConfig
  storage: Storage
  logger: Logger
}

export async function handlePushEvent(
  rawPayload: Record<string, unknown>,
  deps: HandlerDeps
): Promise<HandlerResult> {
  const parsed = PushEventSchema.safeParse(rawPayload)
  if (!parsed.success) {
    deps.logger.warn('Push payload failed schema validation', {
      issues: parsed.error.issues.slice(0, 3),
    })
    return { action: 'ignored', reason: 'invalid push payload' }
  }
  const payload = parsed.data

  const repo = resolveRepo(payload.repository?.full_name, deps.logger)
  if (!repo) {
    return { action: 'ignored', reason: 'unknown repository' }
  }

  const ref = payload.ref
  if (!ref) {
    return { action: 'ignored', reason: 'missing ref' }
  }

  const tagMatch = ref.match(TAG_REGEX)
  if (tagMatch) {
    return handleTagPush(tagMatch[1], payload, repo, deps)
  }
  return { action: 'ignored', reason: 'branch pushes do not notify' }
}

async function handleTagPush(
  tagName: string,
  payload: PushEvent,
  repo: RepoConfig,
  deps: HandlerDeps
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

  // Every version type fires on tag push — BETA, RC, and FINAL all post.
  // Release-event posts (for RC/FINAL) are intentionally allowed to fire
  // alongside; duplicate signals are preferable to silent misses when the
  // maintainer workflow varies (tag-only on private, release-publish on
  // public, both, etc.). Dedup is intentionally not done here.

  const headCommit = payload.head_commit
  const sha = headCommit?.id ?? payload.after ?? ''
  const commitUrl =
    headCommit?.url ??
    (sha ? `https://github.com/${repoFullName(repo)}/commit/${sha}` : '')

  const versionInfo: VersionInfo = {
    ...classified,
    branch: `tag:${tagName}`,
    commitSha: sha,
    commitUrl,
  }

  if (repo.visibility === 'private') {
    // No API calls — beta pushes have no curated notes anywhere, and a
    // commit-compare against the private repo would require a working
    // token and would expose commit messages we may not want to leak.
    // Just announce the bare fact that progress is happening.
    await sendNotifications(
      {
        mattermost: formatMattermostPrivateTagHeadsUp(versionInfo, repo),
        twitter: '',
      },
      { scenario: 'tag-private', version: classified.raw, repo },
      deps
    )
    return {
      action: 'notified',
      version: classified.raw,
      type: classified.type,
      source: 'tag-private',
      repo: repoFullName(repo),
    }
  }

  const summary = await summarizeReleaseByTag({
    owner: repo.owner,
    repo: repo.name,
    tag: tagName,
    apiKey: deps.config.anthropicApiKey,
    githubToken: deps.config.githubToken,
    logger: deps.logger,
  })

  await sendNotifications(
    {
      mattermost: formatMattermost(
        versionInfo,
        NotificationSource.TAG,
        summary.mattermost,
        repo
      ),
      twitter: summary.twitter,
    },
    {
      scenario: 'tag',
      version: classified.raw,
      repo,
    },
    deps
  )

  return {
    action: 'notified',
    version: classified.raw,
    type: classified.type,
    source: 'tag',
    repo: repoFullName(repo),
  }
}

export async function handleReleaseEvent(
  rawPayload: Record<string, unknown>,
  deps: HandlerDeps
): Promise<HandlerResult> {
  const parsed = ReleaseEventSchema.safeParse(rawPayload)
  if (!parsed.success) {
    deps.logger.warn('Release payload failed schema validation', {
      issues: parsed.error.issues.slice(0, 3),
    })
    return { action: 'ignored', reason: 'invalid release payload' }
  }
  const payload: ReleaseEvent = parsed.data

  const repo = resolveRepo(payload.repository?.full_name, deps.logger)
  if (!repo) {
    return { action: 'ignored', reason: 'unknown repository' }
  }

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

  if (repo.visibility === 'private') {
    // Private path: only use what's already in the webhook payload — no
    // GitHub API calls. If the body is missing/too short, fall back to a
    // bare heads-up rather than reaching for the commit-compare API.
    let bodyMarkdown: string
    if (releaseBody && releaseBody.trim().length >= MIN_RELEASE_BODY_CHARS) {
      const summaries = await summarizeBody(
        releaseBody,
        tagName,
        deps.config.anthropicApiKey,
        deps.logger
      )
      bodyMarkdown = summaries.mattermost
    } else {
      bodyMarkdown = '_No release notes in webhook payload._'
    }

    await sendNotifications(
      {
        mattermost: formatMattermostPrivateReleaseHeadsUp(
          versionInfo,
          repo,
          bodyMarkdown
        ),
        twitter: '',
      },
      { scenario: 'release-private', version: classified.raw, repo },
      deps
    )

    return {
      action: 'notified',
      version: classified.raw,
      type: classified.type,
      source: 'release-private',
      repo: repoFullName(repo),
    }
  }

  const summaries =
    releaseBody && releaseBody.trim().length >= MIN_RELEASE_BODY_CHARS
      ? await summarizeBody(
          releaseBody,
          tagName,
          deps.config.anthropicApiKey,
          deps.logger
        )
      : await summarizeReleaseByTag({
          owner: repo.owner,
          repo: repo.name,
          tag: tagName,
          apiKey: deps.config.anthropicApiKey,
          githubToken: deps.config.githubToken,
          logger: deps.logger,
        })

  await sendNotifications(
    {
      mattermost: formatMattermost(
        versionInfo,
        NotificationSource.RELEASE,
        summaries.mattermost,
        repo
      ),
      twitter: summaries.twitter,
    },
    {
      scenario: 'release',
      version: classified.raw,
      repo,
    },
    deps
  )

  return {
    action: 'notified',
    version: classified.raw,
    type: classified.type,
    source: 'release',
    repo: repoFullName(repo),
  }
}

function resolveRepo(
  fullName: string | undefined,
  logger: Logger
): RepoConfig | undefined {
  if (!fullName) {
    logger.warn('Webhook payload missing repository.full_name')
    return undefined
  }
  const repo = findRepoByFullName(fullName)
  if (!repo) {
    logger.warn('Webhook from unknown repository', { fullName })
    return undefined
  }
  return repo
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

export interface NotificationContext {
  scenario: string
  version: string
  repo: RepoConfig
}

/**
 * Dispatch Mattermost and Twitter notifications. Both fire independently;
 * Twitter is skipped for private-repo events (embargoed) or when the
 * Twitter credentials are unset / placeholder.
 */
export async function sendNotifications(
  messages: { mattermost: MattermostPayload; twitter: string },
  ctx: NotificationContext,
  deps: HandlerDeps
): Promise<void> {
  const { config, logger } = deps
  const fullName = repoFullName(ctx.repo)

  interface Target {
    name: string
    call: () => Promise<void>
  }
  const targets: Target[] = [
    {
      name: 'Mattermost',
      call: () =>
        postToMattermost(config.mattermostWebhookUrl, messages.mattermost),
    },
  ]

  if (ctx.repo.visibility === 'private') {
    logger.info('Skipping Twitter for private-repo heads-up', {
      scenario: ctx.scenario,
      version: ctx.version,
      repo: fullName,
    })
  } else if (!twitterConfigured(config)) {
    logger.info('Twitter not configured — skipping post', {
      tweet: messages.twitter,
    })
  } else {
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
