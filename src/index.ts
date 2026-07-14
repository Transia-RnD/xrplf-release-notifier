import 'dotenv/config'
import express from 'express'
import type { Request, Response } from 'express'
import { Storage } from '@google-cloud/storage'
import winston from 'winston'
import { loadConfig } from './config'
import type { AppConfig } from './config'
import { verifySignature } from './webhook/verify'
import {
  handlePushEvent,
  handleReleaseEvent,
  sendNotifications,
} from './webhook/handler'
import {
  fetchLatestBinaryVersions,
  detectNewVersions,
} from './poller/binary-checker'
import { loadPollerState, savePollerState } from './poller/state'
import { classifyVersion } from './version/parser'
import type { VersionInfo } from './version/types'
import { NotificationSource, VersionType } from './version/types'
import { formatMattermost } from './notifications/mattermost'
import { summarizeReleaseByTag } from './ai/summarizer'
import { fetchReleaseBody } from './github/client'
import { PUBLIC_REPO, repoFullName } from './github/repos'
import { renderReleaseCard } from './notifications/release-card'
import { postToTwitter } from './notifications/twitter'
import { runParityCheck } from './parity/runParityCheck'
import { triggerParityCheck } from './parity/trigger'
import { getErrorMessage } from './utils/error'

// Cloud Logging keys log severity off a top-level `severity` field, NOT
// winston's `level`. Without this mapping every winston log — errors included —
// lands at severity DEFAULT, so `severity>=ERROR` filters, the console's error
// view, and Error Reporting all silently miss them. Promote level → severity so
// errors are actually findable in prod.
const WINSTON_TO_GCP_SEVERITY: Record<string, string> = {
  error: 'ERROR',
  warn: 'WARNING',
  info: 'INFO',
  http: 'INFO',
  verbose: 'DEBUG',
  debug: 'DEBUG',
  silly: 'DEBUG',
}
const gcpSeverity = winston.format((info) => {
  info.severity = WINSTON_TO_GCP_SEVERITY[info.level] ?? 'DEFAULT'
  return info
})

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(gcpSeverity(), winston.format.json()),
  transports: [new winston.transports.Console()],
})

// Last-resort safety net: a throw outside an Express handler (a stray promise,
// a bad event callback) would otherwise crash the instance with no structured
// log. Capture both as ERROR-severity entries so they're never invisible.
process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled promise rejection', {
    error: getErrorMessage(reason),
  })
})
process.on('uncaughtException', (err: unknown) => {
  logger.error('Uncaught exception', { error: getErrorMessage(err) })
  process.exit(1)
})

const app = express()

// Behind Cloud Run's proxy: honor X-Forwarded-Proto so req.protocol is 'https'.
// Without this the parity self-POST goes to http://, gets 302-redirected to
// https, and axios follows the redirect as a GET → 404 (parity job never runs).
app.set('trust proxy', true)

/** Wraps an async route handler so unhandled rejections become 500s, not crashes. */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      logger.error('Unhandled route error', {
        path: req.path,
        error: getErrorMessage(err),
      })
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error' })
      }
    })
  }
}

async function start(): Promise<void> {
  const config = await loadConfig()
  const storage = new Storage({ projectId: config.gcpProjectId })

  app.post(
    '/webhook',
    // Default raw-body limit is 100kb, which GitHub push payloads with
    // large `commits[]` arrays routinely exceed (we've seen 900kb+ → 413
    // in prod). GitHub caps webhook payloads at 25mb; 5mb gives headroom
    // for normal traffic without opening us up to absurd bodies.
    express.raw({ type: '*/*', limit: '5mb' }),
    asyncHandler((req, res) => handleWebhook(req, res, config, storage))
  )

  app.post(
    '/poll',
    express.json(),
    asyncHandler((req, res) => handlePoll(req, res, config, storage))
  )

  // Worker endpoint for the SDK feature-parity check. Invoked (fire-and-forget)
  // by the webhook path via triggerParityCheck — kept separate because the scan
  // runs an agent per SDK and far outlives the 10s GitHub webhook window.
  app.post(
    '/parity',
    express.json(),
    asyncHandler((req, res) => handleParity(req, res, config, storage))
  )

  app.get('/', (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  const port = config.port || 8080
  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
  })
}

export async function handleWebhook(
  req: Request,
  res: Response,
  config: AppConfig,
  storage: Storage
): Promise<void> {
  const signature = req.headers['x-hub-signature-256']
  if (
    typeof signature !== 'string' ||
    !Buffer.isBuffer(req.body) ||
    !verifySignature(req.body, signature, config.githubWebhookSecret)
  ) {
    logger.warn('Invalid webhook signature')
    res.status(401).json({ error: 'Invalid signature' })
    return
  }

  const event = (req.headers['x-github-event'] as string | undefined) ?? ''
  const payload = JSON.parse(req.body.toString()) as Record<string, unknown>

  const deps = { config, storage, logger }
  if (event === 'ping') {
    res.status(200).json({ action: 'pong' })
    return
  }
  if (event === 'push') {
    const result = await handlePushEvent(payload, deps)
    maybeTriggerParity(result, req, config)
    res.status(200).json(result)
    return
  }
  if (event === 'release') {
    const result = await handleReleaseEvent(payload, deps)
    maybeTriggerParity(result, req, config)
    res.status(200).json(result)
    return
  }
  res.status(200).json({ action: 'ignored', reason: `event: ${event}` })
}

/**
 * Kick off a parity check for public tag-push / release-publish events. Only
 * the public-repo paths (source 'tag' / 'release') are parity-checked — never
 * the private mirror's embargoed tags. Fire-and-forget: the webhook must return
 * fast, so we don't await the scan.
 */
export function maybeTriggerParity(
  result: { source?: string; version?: string },
  req: Request,
  config: AppConfig
): void {
  if (
    (result.source === 'tag' || result.source === 'release') &&
    result.version
  ) {
    const baseUrl =
      process.env.SELF_URL ??
      `${req.protocol}://${req.get('host') ?? `localhost:${config.port}`}`
    void triggerParityCheck(baseUrl, config.pollerToken, result.version, logger)
  }
}

export async function handleParity(
  req: Request,
  res: Response,
  config: AppConfig,
  storage: Storage
): Promise<void> {
  // Same shared-secret guard as /poll — the worker must only be callable by our
  // own dispatch (or an operator holding the token).
  if (config.pollerToken) {
    const provided = req.headers['x-cloud-scheduler-token']
    if (provided !== config.pollerToken) {
      logger.warn('Unauthorized /parity request', { ip: req.ip })
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
  }

  const version = (req.body as { version?: string } | undefined)?.version
  if (!version) {
    res.status(400).json({ error: 'missing version' })
    return
  }

  let classified: ReturnType<typeof classifyVersion>
  try {
    classified = classifyVersion(version.replace(/^v/, ''))
  } catch {
    res.status(400).json({ error: 'version does not match pattern' })
    return
  }

  const versionInfo: VersionInfo = {
    ...classified,
    branch: `parity:${version}`,
    commitSha: '',
    commitUrl: '',
  }

  // Run synchronously within this request — this IS the background job. The
  // dispatcher already returned to GitHub; here we can take as long as needed.
  await runParityCheck(versionInfo, { config, storage, logger })
  res.status(200).json({ action: 'parity_checked', version })
}

export async function handlePoll(
  req: Request,
  res: Response,
  config: AppConfig,
  storage: Storage
): Promise<void> {
  // Auth: /poll must only be callable by Cloud Scheduler (or anyone holding
  // the shared token). If POLLER_TOKEN is unset, the endpoint is open — log
  // a warning so the misconfiguration is visible, but don't break dev.
  if (config.pollerToken) {
    const provided = req.headers['x-cloud-scheduler-token']
    if (provided !== config.pollerToken) {
      logger.warn('Unauthorized /poll request', {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      })
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
  } else {
    logger.warn(
      '/poll called without POLLER_TOKEN configured — endpoint is open'
    )
  }

  // Operators can pass `{ "dryRun": true }` to exercise the FULL pipeline
  // against production secrets/state/network WITHOUT posting or mutating GCS
  // state: summarize → format Mattermost → render card → assemble tweet, then
  // return everything in the response. Add `"version": "X.Y.Z"` to force a
  // specific final through even when it isn't the newly-detected binary — so
  // you can validate end-to-end before the .deb/.rpm actually land on stable.
  const body = (req.body ?? {}) as { dryRun?: boolean; version?: string }
  const dryRun = body.dryRun === true

  const state = await loadPollerState(storage)
  const current = await fetchLatestBinaryVersions()

  // Resolve the candidate version. A forced dry-run version bypasses both the
  // cold-start guard and the new-version diff; every other path mirrors prod.
  let newVersion: string | null
  if (dryRun && body.version) {
    newVersion = body.version.replace(/^v/, '')
  } else {
    // Cold-start guard: if there's no prior state, initialize from current
    // without notifying. The first poll after a fresh deploy/state-reset must
    // not announce the existing repos.ripple.com version as "new". Dry-run
    // never persists.
    const isFirstRun = !state.deb && !state.rpm
    if (isFirstRun) {
      const now = new Date().toISOString()
      if (current.deb) state.deb = { version: current.deb, detectedAt: now }
      if (current.rpm) state.rpm = { version: current.rpm, detectedAt: now }
      if (!dryRun) await savePollerState(storage, state)
      logger.info('Poller state initialized', { current, dryRun })
      res.status(200).json({
        action: dryRun ? 'dry_run_initialized' : 'initialized',
        state,
      })
      return
    }
    newVersion = detectNewVersions(current, state)
  }

  if (!newVersion) {
    res.status(200).json({
      action: 'no_change',
      ...(dryRun ? { dryRun: true, current } : {}),
    })
    return
  }

  const classified = classifyVersion(newVersion)

  // The poller only scrapes pool/stable/ which should contain only finals.
  // If a non-final shows up there, treat it as an unexpected state and skip
  // — the binary-published tweet ("go install now") would be wrong for
  // anything that isn't a final. Dry-run honours the same guard so the report
  // reflects exactly what prod would do.
  if (classified.type !== VersionType.FINAL) {
    logger.warn('Binary poll saw non-final on stable channel — skipping', {
      version: newVersion,
      type: classified.type,
      dryRun,
    })
    res.status(200).json({ action: 'ignored', reason: 'non-final on stable' })
    return
  }

  const versionInfo: VersionInfo = {
    ...classified,
    branch: 'release',
    commitSha: '',
    commitUrl: '',
  }

  // Release-tag gate. The binary-poll announcement is the ONLY tweet we send,
  // and both it and the public Mattermost post link to the public release
  // notes (github.com/.../releases/tag/X.Y.Z). Those 404 until the public
  // GitHub Release is published, so we must not fire before it exists. The two
  // upstream events arrive in either order and this single gate covers both:
  //   • binary first  → wait here; GCS state is NOT advanced, so the next poll
  //                      retries and fires once the Release tag is published.
  //   • release first → the release-published webhook never tweets (Mattermost
  //                      only), so when the binary lands the gate is already
  //                      satisfied and we fire immediately.
  // `fetchReleaseBody` returns null until a *published* public Release exists
  // for the tag (drafts aren't served by the tags endpoint), making it a
  // reliable existence check. It doubles as the content source for the summary.
  const publicReleaseBody = await fetchReleaseBody(
    PUBLIC_REPO.owner,
    PUBLIC_REPO.name,
    newVersion,
    config.githubToken
  ).catch((err: unknown) => {
    logger.warn(
      'Public release lookup failed — treating as not-yet-published',
      {
        tag: newVersion,
        error: getErrorMessage(err),
      }
    )
    return null
  })
  const publicReleaseExists = publicReleaseBody !== null

  if (!publicReleaseExists) {
    logger.info(
      'Binary on stable but public GitHub Release not yet published — poll waits',
      { version: newVersion, dryRun }
    )
    res.status(200).json(
      dryRun
        ? {
            action: 'dry_run',
            version: newVersion,
            wouldFire: false,
            publicReleaseExists: false,
            reason:
              'public GitHub Release tag not yet published — poll holds until the release exists',
          }
        : { action: 'waiting_for_release', version: newVersion }
    )
    return
  }

  // Release exists → public is both the content source and the posting
  // identity. (`PUBLIC_REPO` drives dedup + visibility.)
  const contentRepo = PUBLIC_REPO

  const summary = await summarizeReleaseByTag({
    owner: contentRepo.owner,
    repo: contentRepo.name,
    tag: newVersion,
    apiKey: config.anthropicApiKey,
    githubToken: config.githubToken,
    logger,
    // The binary-poll path is the ONLY place we tweet — finals on stable.
    includeTwitter: true,
  })

  // Assemble both payloads once — the live path and the dry-run report share
  // them, so what a dry-run shows is byte-for-byte what prod would send.
  const mattermostPayload = formatMattermost(
    versionInfo,
    NotificationSource.BINARY_POLL,
    summary.mattermost,
    PUBLIC_REPO
  )
  const releaseNotesUrl = `https://github.com/${repoFullName(PUBLIC_REPO)}/releases/tag/${newVersion}`
  const tweetText = `${summary.twitter}\n\nRelease notes: ${releaseNotesUrl}`

  // Dry-run: render the card to prove resvg works in this environment, then
  // return the assembled payloads. Nothing is posted and GCS state is left
  // untouched, so the real announcement still fires when the binary genuinely
  // lands. This is the safe "make sure prod will work" path.
  if (dryRun) {
    let releaseCard: { bytes: number } | { error: string }
    try {
      releaseCard = { bytes: (await renderReleaseCard(newVersion)).length }
    } catch (err: unknown) {
      releaseCard = { error: getErrorMessage(err) }
    }
    logger.info('Dry-run poll completed — nothing posted', {
      version: newVersion,
    })
    res.status(200).json({
      action: 'dry_run',
      version: newVersion,
      wouldFire: true,
      publicReleaseExists: true,
      contentRepo: repoFullName(contentRepo),
      wouldPostMattermost: true,
      mattermost: mattermostPayload,
      wouldTweet: twitterConfigured(config),
      tweet: tweetText,
      tweetChars: tweetText.length,
      releaseCard,
    })
    return
  }

  await sendNotifications(
    mattermostPayload,
    { scenario: 'binary', version: newVersion, repo: PUBLIC_REPO },
    { config, storage, logger }
  )

  // Twitter announcement — the only place we post to Twitter. Includes the
  // version-stamped release card image and a release-notes link appended
  // to the AI-generated tweet body.
  if (twitterConfigured(config)) {
    try {
      const cardPng = await renderReleaseCard(newVersion)
      await postToTwitter(
        {
          appKey: config.twitterApiKey,
          appSecret: config.twitterApiSecret,
          accessToken: config.twitterAccessToken,
          accessSecret: config.twitterAccessTokenSecret,
        },
        tweetText,
        { buffer: cardPng, mimeType: 'image/png' }
      )
      logger.info('Twitter notification sent', { version: newVersion })
    } catch (err: unknown) {
      logger.error('Twitter notification failed', {
        error: getErrorMessage(err),
      })
    }
  } else {
    logger.info('Twitter not configured — skipping post', {
      tweet: summary.twitter,
    })
  }

  const now = new Date().toISOString()
  if (current.deb && current.deb !== state.deb?.version) {
    state.deb = { version: current.deb, detectedAt: now }
  }
  if (current.rpm && current.rpm !== state.rpm?.version) {
    state.rpm = { version: current.rpm, detectedAt: now }
  }
  await savePollerState(storage, state)

  logger.info('Binary poll detected new version', { version: newVersion })
  res.status(200).json({ action: 'notified', version: newVersion })
}

/** Same short-circuit the webhook handler used to do — don't let Twitter
 *  401-spam our logs while creds are placeholder. */
export function twitterConfigured(config: AppConfig): boolean {
  return (
    config.twitterApiKey.length > 0 &&
    config.twitterApiKey !== 'placeholder' &&
    config.twitterApiSecret.length > 0 &&
    config.twitterApiSecret !== 'placeholder'
  )
}

// Only auto-start when run as the entrypoint — importing this module in tests
// must not call loadConfig() or bind a port.
if (require.main === module) {
  start().catch((err: unknown) => {
    console.error('Startup failure', err)
    process.exit(1)
  })
}

export { app }
