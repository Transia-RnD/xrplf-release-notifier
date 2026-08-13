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
  detectBreakingSafe,
} from './webhook/handler'
import {
  fetchLatestBinaryVersions,
  detectNewVersions,
} from './poller/binary-checker'
import { loadPollerState, savePollerState } from './poller/state'
import { classifyVersion } from './version/parser'
import type { VersionInfo } from './version/types'
import { NotificationSource, VersionType } from './version/types'
import {
  formatMattermost,
  envelope,
  postToMattermost,
} from './notifications/mattermost'
import { summarizeReleaseByTag } from './ai/summarizer'
import { composeBreakingSections } from './ai/breaking'
import { fetchReleaseBody } from './github/client'
import { PUBLIC_REPO, repoFullName } from './github/repos'
import { renderReleaseCard } from './notifications/release-card'
import { postToTwitter } from './notifications/twitter'
import { runParityCheck } from './parity/runParityCheck'
import { triggerParityCheck } from './parity/trigger'
import { runWatchdog } from './monitors/watchdog'
import { loadSchedules } from './scheduler/schema'
import type { Schedules } from './scheduler/schema'
import {
  HANDLERS,
  HANDLER_NAMES,
  createHandlerContext,
} from './scheduler/handlers'
import { loadSchedulerState, saveSchedulerState } from './scheduler/state'
import { runTick, nextRun, FAILURE_ALERT_THRESHOLD } from './scheduler/dispatch'
import { mirrorToSlack } from './notifications/slack'
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

/**
 * Shared-secret guard for every scheduler-invoked route. When POLLER_TOKEN is
 * unset the endpoint stays open (so dev works) but says so loudly, since a
 * silently-open trigger endpoint in prod is the failure worth catching.
 */
export function authorizeSchedulerRequest(
  req: Request,
  res: Response,
  config: AppConfig,
  route: string
): boolean {
  if (!config.pollerToken) {
    logger.warn(
      `${route} called without POLLER_TOKEN configured — endpoint is open`
    )
    return true
  }
  if (req.headers['x-cloud-scheduler-token'] !== config.pollerToken) {
    logger.warn(`Unauthorized ${route} request`, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

async function start(): Promise<void> {
  const config = await loadConfig()
  const storage = new Storage({ projectId: config.gcpProjectId })

  // Parse the schedule table at startup so a bad cron expression or an unknown
  // handler name crashes the deploy instead of becoming a job that never fires.
  const schedules = loadSchedules(HANDLER_NAMES)
  logger.info('Schedule table loaded', {
    jobs: schedules.jobs.map((j) => `${j.name} (${j.cron} ${j.tz})`),
  })

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

  // External-vantage watchdog: is the observatory (vlwatch/crawler) alive and is
  // the stage node reachable? Hit by Cloud Scheduler every ~15 min.
  app.post(
    '/monitors',
    express.json(),
    asyncHandler((req, res) => handleMonitors(req, res, config, storage))
  )

  // The single entry point for every recurring job. One Cloud Scheduler job
  // POSTs here every 5 minutes; config/schedules.yaml decides what is due.
  app.post(
    '/tick',
    express.json(),
    asyncHandler((req, res) => handleTick(req, res, config, storage, schedules))
  )

  // Answers "did the weekly report fire, and when is the next one?" without
  // opening the GCP console.
  app.get(
    '/schedules',
    asyncHandler((req, res) =>
      handleSchedules(req, res, config, storage, schedules)
    )
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
    res.status(200).json(result)
    return
  }
  if (event === 'release') {
    const result = await handleReleaseEvent(payload, deps)
    res.status(200).json(result)
    return
  }
  res.status(200).json({ action: 'ignored', reason: `event: ${event}` })
}

/**
 * Kick off the SDK/docs parity report. Fired ONCE per version, from the
 * binary-poll path only — when the packages are installable and the public
 * Release exists, so "released — NOT at parity" is true when posted. The
 * webhook paths no longer trigger it: tag + release-publish each firing gave
 * every final two identical parity posts, hours before anything shipped.
 * Fire-and-forget: the parity scan runs an agent per SDK and far outlives
 * this request.
 */
export function triggerParityForRelease(
  version: string,
  req: Request,
  config: AppConfig
): void {
  const baseUrl =
    process.env.SELF_URL ??
    `${req.protocol}://${req.get('host') ?? `localhost:${config.port}`}`
  void triggerParityCheck(baseUrl, config.pollerToken, version, logger)
}

export async function handleParity(
  req: Request,
  res: Response,
  config: AppConfig,
  storage: Storage
): Promise<void> {
  // The worker must only be callable by our own dispatch (or an operator
  // holding the token).
  if (!authorizeSchedulerRequest(req, res, config, '/parity')) return

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

export async function handleMonitors(
  req: Request,
  res: Response,
  config: AppConfig,
  storage: Storage
): Promise<void> {
  if (!authorizeSchedulerRequest(req, res, config, '/monitors')) return

  const body = (req.body ?? {}) as { dryRun?: boolean }
  const dryRun = body.dryRun === true

  const { alerts, state } = await runWatchdog(
    config.mattermostWebhookUrl,
    storage,
    { dryRun, logger }
  )
  logger.info('Watchdog run complete', { alertCount: alerts.length, dryRun })
  res.status(200).json({
    action: alerts.length > 0 ? 'alerted' : 'ok',
    alerts: alerts.map((a) => ({ category: a.category, severity: a.severity })),
    ...(dryRun ? { dryRun: true, state } : {}),
  })
}

export async function handleTick(
  req: Request,
  res: Response,
  config: AppConfig,
  storage: Storage,
  schedules: Schedules
): Promise<void> {
  if (!authorizeSchedulerRequest(req, res, config, '/tick')) return

  const dryRun = (req.body as { dryRun?: boolean } | undefined)?.dryRun === true
  const now = new Date()

  const state = await loadSchedulerState(storage, logger)
  const results = await runTick(
    schedules,
    state,
    HANDLERS,
    createHandlerContext(config, storage, logger, now, dryRun),
    { now, dryRun }
  )

  // Persist even when some jobs failed — the successes and the incremented
  // failure counters both need to survive this request.
  if (!dryRun) await saveSchedulerState(storage, state)

  const broken = results.filter(
    (r) => r.action === 'failed' && (r.failures ?? 0) >= FAILURE_ALERT_THRESHOLD
  )
  if (broken.length && !dryRun) {
    // The notifier reports its own breakage through the same path it reports
    // everything else, rather than failing silently on a schedule nobody watches.
    const payload = envelope({
      fallback: 'Scheduled job failing',
      color: '#E53935',
      title: `${broken.length} scheduled job(s) failing`,
      text: broken
        .map(
          (r) =>
            `- \`${r.job}\` — ${r.failures} consecutive failures: ${r.error}`
        )
        .join('\n'),
    })
    await postToMattermost(config.mattermostWebhookUrl, payload).catch((err) =>
      logger.error('Failed to post scheduler failure alert', {
        error: getErrorMessage(err),
      })
    )
    await mirrorToSlack(config.slackWebhookUrl, payload, logger)
  }

  const ran = results.filter((r) => r.action === 'ran').length
  if (ran || broken.length) {
    logger.info('Tick complete', { ran, failed: broken.length, dryRun })
  }
  res.status(200).json({ action: 'ticked', dryRun, results })
}

export async function handleSchedules(
  req: Request,
  res: Response,
  config: AppConfig,
  storage: Storage,
  schedules: Schedules
): Promise<void> {
  if (!authorizeSchedulerRequest(req, res, config, '/schedules')) return

  const state = await loadSchedulerState(storage, logger)
  const now = new Date()

  res.status(200).json({
    jobs: schedules.jobs.map((job) => ({
      name: job.name,
      description: job.description,
      cron: job.cron,
      tz: job.tz,
      handler: job.handler,
      enabled: job.enabled,
      lastRun: state.jobs[job.name]?.lastRun ?? null,
      failures: state.jobs[job.name]?.failures ?? 0,
      nextRun: job.enabled ? nextRun(job, now).toISOString() : null,
    })),
  })
}

export async function handlePoll(
  req: Request,
  res: Response,
  config: AppConfig,
  storage: Storage
): Promise<void> {
  if (!authorizeSchedulerRequest(req, res, config, '/poll')) return

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

  // The diff-based breaking/surface scan runs FIRST — the same machinery as
  // the tag path — so both posts carry the full deterministic protocol-surface
  // listing (every amendment / tx type / ledger object) instead of the AI's
  // condensed rewrite of the release notes, and the tweet gets the
  // authoritative amendment list to name verbatim. The scan degrades to empty
  // sections on failure; the summary throws.
  const breaking = await detectBreakingSafe(newVersion, PUBLIC_REPO, {
    config,
    storage,
    logger,
  })
  const summary = await summarizeReleaseByTag({
    owner: contentRepo.owner,
    repo: contentRepo.name,
    tag: newVersion,
    apiKey: config.anthropicApiKey,
    githubToken: config.githubToken,
    logger,
    // The binary-poll path is the ONLY place we tweet — finals on stable.
    includeTwitter: true,
    // The diff-based detector owns the breaking sections on this path.
    labelBreaking: false,
    amendments: breaking.amendmentNames,
  })

  // Assemble both payloads once — the live path and the dry-run report share
  // them, so what a dry-run shows is byte-for-byte what prod would send.
  const mattermostBody = [
    ...composeBreakingSections(breaking),
    summary.mattermost,
  ].join('\n\n')
  const mattermostPayload = formatMattermost(
    versionInfo,
    NotificationSource.BINARY_POLL,
    mattermostBody,
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
      wouldTweet: config.twitterPostingEnabled && twitterConfigured(config),
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
  // to the AI-generated tweet body. Gated behind TWITTER_POSTING_ENABLED.
  if (config.twitterPostingEnabled && twitterConfigured(config)) {
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
    logger.info('Twitter posting disabled or not configured — skipping post', {
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

  // The one parity trigger — the version is now genuinely released.
  triggerParityForRelease(newVersion, req, config)

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
