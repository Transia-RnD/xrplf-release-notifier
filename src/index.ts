import 'dotenv/config'
import express from 'express'
import { Storage } from '@google-cloud/storage'
import winston from 'winston'
import { loadConfig } from './config'
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
import { VersionInfo, NotificationSource } from './version/types'
import { formatMessages } from './notifications/formatter'
import { summarizeReleaseByTag } from './ai/summarizer'

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()],
})

const app = express()

async function start() {
  const config = await loadConfig()
  const storage = new Storage({ projectId: config.gcpProjectId })

  app.post(
    '/webhook',
    express.raw({ type: '*/*' }),
    async (req, res) => {
      const signature = req.headers['x-hub-signature-256'] as string
      if (
        !signature ||
        !Buffer.isBuffer(req.body) ||
        !verifySignature(req.body, signature, config.githubWebhookSecret)
      ) {
        logger.warn('Invalid webhook signature')
        res.status(401).json({ error: 'Invalid signature' })
        return
      }

      try {
        const event = (req.headers['x-github-event'] as string) || ''
        const payload = JSON.parse(req.body.toString())

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
      } catch (err) {
        logger.error('Webhook handler error', { error: err })
        res.status(500).json({ error: 'Internal error' })
      }
    }
  )

  app.post('/poll', express.json(), async (_req, res) => {
    try {
      const state = await loadPollerState(storage)
      const current = await fetchLatestBinaryVersions()
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

      const messages = formatMessages(
        versionInfo,
        NotificationSource.BINARY_POLL,
        summary
      )
      await sendNotifications(messages, config, logger)

      const now = new Date().toISOString()
      if (current.deb && current.deb !== state.deb?.version) {
        state.deb = { version: current.deb, detectedAt: now }
      }
      if (current.rpm && current.rpm !== state.rpm?.version) {
        state.rpm = { version: current.rpm, detectedAt: now }
      }
      await savePollerState(storage, state)

      logger.info('Binary poll detected new version', {
        version: newVersion,
      })
      res
        .status(200)
        .json({ action: 'notified', version: newVersion })
    } catch (err) {
      logger.error('Poll handler error', { error: err })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  app.get('/', (_req, res) =>
    res.status(200).json({ status: 'ok' })
  )

  const port = config.port || 8080
  app.listen(port, () => logger.info(`Listening on port ${port}`))
}

start().catch((err) => {
  console.error('Startup failure', err)
  process.exit(1)
})

export { app }
