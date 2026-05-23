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
import { NotificationSource } from './version/types'
import { formatMattermost } from './notifications/mattermost'
import { summarizeReleaseByTag } from './ai/summarizer'

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()],
})

const app = express()

/** Wraps an async route handler so unhandled rejections become 500s, not crashes. */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      logger.error('Unhandled route error', {
        path: req.path,
        error: err instanceof Error ? err.message : String(err),
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
    express.raw({ type: '*/*' }),
    asyncHandler((req, res) => handleWebhook(req, res, config))
  )

  app.post(
    '/poll',
    express.json(),
    asyncHandler((req, res) => handlePoll(req, res, config, storage))
  )

  app.get('/', (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  const port = config.port || 8080
  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
  })
}

async function handleWebhook(
  req: Request,
  res: Response,
  config: AppConfig
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

  if (event === 'ping') {
    res.status(200).json({ action: 'pong' })
    return
  }
  if (event === 'push') {
    const result = await handlePushEvent(payload, config, logger)
    res.status(200).json(result)
    return
  }
  if (event === 'release') {
    const result = await handleReleaseEvent(payload, config, logger)
    res.status(200).json(result)
    return
  }
  res.status(200).json({ action: 'ignored', reason: `event: ${event}` })
}

async function handlePoll(
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

  const state = await loadPollerState(storage)
  const current = await fetchLatestBinaryVersions()

  // Cold-start guard: if there's no prior state, initialize from current
  // without notifying. The first poll after a fresh deploy/state-reset must
  // not announce the existing repos.ripple.com version as "new".
  const isFirstRun = !state.deb && !state.rpm
  if (isFirstRun) {
    const now = new Date().toISOString()
    if (current.deb) state.deb = { version: current.deb, detectedAt: now }
    if (current.rpm) state.rpm = { version: current.rpm, detectedAt: now }
    await savePollerState(storage, state)
    logger.info('Poller state initialized', { current })
    res.status(200).json({ action: 'initialized', state })
    return
  }

  const newVersion = detectNewVersions(current, state)
  if (!newVersion) {
    res.status(200).json({ action: 'no_change' })
    return
  }

  const classified = classifyVersion(newVersion)
  const versionInfo: VersionInfo = {
    ...classified,
    branch: 'release',
    commitSha: '',
    commitUrl: '',
  }

  const summary = await summarizeReleaseByTag({
    owner: 'XRPLF',
    repo: 'rippled',
    tag: newVersion,
    apiKey: config.anthropicApiKey,
    githubToken: config.githubToken,
    logger,
  })

  await sendNotifications(
    {
      mattermost: formatMattermost(
        versionInfo,
        NotificationSource.BINARY_POLL,
        summary.mattermost
      ),
      twitter: summary.twitter,
    },
    config,
    logger
  )

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

start().catch((err: unknown) => {
  console.error('Startup failure', err)
  process.exit(1)
})

export { app }
