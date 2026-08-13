import type { Storage } from '@google-cloud/storage'
import type { Logger } from 'winston'
import type { AppConfig } from '../config'
import type { MattermostPayload } from '../notifications/mattermost'
import { postToMattermost } from '../notifications/mattermost'
import { mirrorToSlack } from '../notifications/slack'
import { unlPrQueue } from './reports/unlPrQueue'
import { weeklyUpdate } from './reports/weeklyUpdate'
import { validatorReview } from './reports/validatorReview'
import { validatorToml } from './reports/validatorToml'

export interface HandlerContext {
  config: AppConfig
  storage: Storage
  logger: Logger
  /** Compute and log the report, but post nothing. */
  dryRun: boolean
  /** Tick time. Injected so report windows are deterministic under test. */
  now: Date
  /** Deliver a report. Honours dryRun and owns the Mattermost + Slack fan-out. */
  post: (
    payload: MattermostPayload,
    meta?: Record<string, unknown>
  ) => Promise<void>
}

export type Handler = (context: HandlerContext) => Promise<void>

export type HandlerRegistry = Map<string, Handler>

/**
 * Build the context handed to every handler. Centralising `post` keeps the
 * dry-run check and the Slack mirror in one place instead of once per report.
 */
export function createHandlerContext(
  config: AppConfig,
  storage: Storage,
  logger: Logger,
  now: Date,
  dryRun: boolean
): HandlerContext {
  return {
    config,
    storage,
    logger,
    now,
    dryRun,
    post: async (payload, meta) => {
      if (dryRun) {
        logger.info('Scheduled report dry run — not posted', {
          ...meta,
          payload,
        })
        return
      }
      await postToMattermost(config.mattermostWebhookUrl, payload)
      await mirrorToSlack(config.slackWebhookUrl, payload, logger)
      logger.info('Scheduled report posted', meta)
    },
  }
}

/**
 * Every handler a job may name. Adding a recurring report is one entry here
 * plus one entry in config/schedules.yaml — no route, no infrastructure.
 */
export const HANDLERS: HandlerRegistry = new Map<string, Handler>([
  ['unlPrQueue', unlPrQueue],
  ['weeklyUpdate', weeklyUpdate],
  ['validatorReview', validatorReview],
  ['validatorToml', validatorToml],
])

export const HANDLER_NAMES: string[] = [...HANDLERS.keys()]
