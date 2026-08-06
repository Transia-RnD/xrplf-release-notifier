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
import {
  summarizeReleaseByTag,
  summarizeBody,
  MIN_RELEASE_BODY_CHARS,
} from '../ai/summarizer'
import { summarizeBreakingForTag } from '../ai/breaking'
import type { BreakingResult } from '../ai/breaking'
import type { TagBreakingLevel } from '../notifications/mattermost'
import type { AppConfig } from '../config'
import type { RepoConfig } from '../github/repos'
import { findRepoByFullName, repoFullName } from '../github/repos'
import { maybeDispatchAlphanetSync } from '../alphanet/sync'
import { tagFloodGuard, formatTagFloodNotice } from './floodGuard'
import { getErrorMessage } from '../utils/error'
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
  if (ref === 'refs/heads/develop' && repo.visibility === 'public') {
    // Upstream develop moved — kick sentinel's Stage-1 alphanet branch sync
    // so proposal branches stay current instead of drifting until deploy day.
    const outcome = await maybeDispatchAlphanetSync(deps.config, deps.logger)
    return {
      action: 'alphanet-sync',
      reason: outcome,
      branch: 'develop',
      repo: repoFullName(repo),
    }
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

  // Bulk tag backfills (mirror/tag syncs) fire one webhook per tag; past the
  // guard's limit we post a single flood notice instead of one post per tag.
  const flood = tagFloodGuard.check(repoFullName(repo))
  if (!flood.allowed) {
    if (flood.announceSuppression) {
      await sendNotifications(
        formatTagFloodNotice(
          repoFullName(repo),
          flood.recentCount,
          tagFloodGuard.windowMs
        ),
        { scenario: 'tag-flood', version: classified.raw, repo },
        deps
      )
    }
    deps.logger.warn('Tag flood guard suppressed tag notification', {
      repo: repoFullName(repo),
      version: classified.raw,
      recentCount: flood.recentCount,
    })
    return {
      action: 'suppressed',
      reason: 'tag flood guard',
      version: classified.raw,
      repo: repoFullName(repo),
    }
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
      formatMattermostPrivateTagHeadsUp(versionInfo, repo),
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

  // The narrative summary and the diff-based breaking-change scan run in
  // parallel. The summary throws on failure (we won't post garbage to the
  // public channel); the breaking scan degrades to "none" so a diff/AI hiccup
  // can never suppress the tag notification itself.
  const [summary, breaking] = await Promise.all([
    summarizeReleaseByTag({
      owner: repo.owner,
      repo: repo.name,
      tag: tagName,
      apiKey: deps.config.anthropicApiKey,
      githubToken: deps.config.githubToken,
      logger: deps.logger,
      // The diff-based detector below owns the breaking sections on this path —
      // don't let the narrative add a redundant, message-only one.
      labelBreaking: false,
    }),
    detectBreakingSafe(tagName, repo, deps),
  ])

  const parts: string[] = []
  if (breaking.breakingNow) {
    parts.push(
      `**:rotating_light: Breaking on upgrade:**\n${breaking.breakingNow}`
    )
  }
  if (breaking.newSurface) {
    parts.push(
      `**:sparkles: New protocol surface — SDKs must add support:**\n${breaking.newSurface}`
    )
  }
  if (breaking.unvotableAmendments) {
    parts.push(
      `**:warning: Added but NOT votable — don't claim support:**\n${breaking.unvotableAmendments}`
    )
  }
  const body = [...parts, summary.mattermost].join('\n\n')
  const level: TagBreakingLevel = breaking.hasBreakingNow
    ? 'breaking'
    : breaking.hasNewSurface || breaking.hasUnvotableAmendment
      ? 'surface'
      : 'none'

  await sendNotifications(
    formatMattermost(versionInfo, NotificationSource.TAG, body, repo, level),
    { scenario: 'tag', version: classified.raw, repo },
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
      formatMattermostPrivateReleaseHeadsUp(versionInfo, repo, bodyMarkdown),
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
    formatMattermost(
      versionInfo,
      NotificationSource.RELEASE,
      summaries.mattermost,
      repo
    ),
    { scenario: 'release', version: classified.raw, repo },
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

/**
 * Run the diff-based breaking-change scan, swallowing any failure into a
 * "no breaking changes" result. A GitHub/AI error here must degrade the post
 * (drop the breaking section) rather than fail the whole tag notification.
 */
async function detectBreakingSafe(
  tag: string,
  repo: RepoConfig,
  deps: HandlerDeps
): Promise<BreakingResult> {
  try {
    return await summarizeBreakingForTag({
      owner: repo.owner,
      repo: repo.name,
      tag,
      apiKey: deps.config.anthropicApiKey,
      githubToken: deps.config.githubToken,
      logger: deps.logger,
    })
  } catch (err: unknown) {
    deps.logger.warn('Breaking-change detection failed — posting without it', {
      tag,
      repo: repoFullName(repo),
      error: getErrorMessage(err),
    })
    return {
      breakingNow: '',
      newSurface: '',
      unvotableAmendments: '',
      hasBreakingNow: false,
      hasNewSurface: false,
      hasUnvotableAmendment: false,
    }
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

export interface NotificationContext {
  scenario: string
  version: string
  repo: RepoConfig
}

/**
 * Post a webhook-driven Mattermost notification. Twitter is intentionally
 * NOT fired from webhook paths — it's reserved for the binary-poll path
 * in src/index.ts (the "install now" announcement, with image), since
 * a tweet only matters once users can actually install.
 */
export async function sendNotifications(
  mattermostPayload: MattermostPayload,
  ctx: NotificationContext,
  deps: HandlerDeps
): Promise<void> {
  const { config, logger } = deps
  try {
    await postToMattermost(config.mattermostWebhookUrl, mattermostPayload)
    logger.info('Mattermost notification sent', {
      scenario: ctx.scenario,
      version: ctx.version,
      repo: repoFullName(ctx.repo),
    })
  } catch (err: unknown) {
    logger.error('Mattermost notification failed', {
      error: getErrorMessage(err),
    })
  }
}
