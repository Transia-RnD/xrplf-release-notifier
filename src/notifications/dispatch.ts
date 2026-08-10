import type { Storage } from '@google-cloud/storage'
import type { Logger } from 'winston'
import type { AppConfig, PagerConfig } from '../config'
import type { NetworkId, Severity, Topic } from '../alerts/types'
import type { MattermostPayload } from './mattermost'
import { postToMattermost } from './mattermost'
import { mirrorToSlack } from './slack'
import { open, parseKeyRing, type CryptoKeys } from './crypto'
import { loadRoster, matches, type Subscriber } from './subscribers'
import { send, type TwilioConfig } from './twilio'
import { getErrorMessage } from '../utils/error'

/**
 * The single fan-out point for an alert. Every channel is reached from here so
 * that adding one is a change in this file rather than at each call site.
 *
 * Order is Mattermost, Slack, then the pager, and each runs in its own
 * try/catch: Mattermost is the system of record, so a pager failure must never
 * cost the durable record of what happened.
 */

/** The routing facts about an alert, separate from how it is rendered. */
export interface AlertEvent {
  severity: Severity
  topic: Topic
  /** Null for topics that describe software rather than a running network. */
  network: NetworkId | null
  /** Machine id, e.g. `FORK_DETECTED`. */
  id: string
  /** One line of human detail. Truncated into the template slot. */
  detail: string
}

export interface DispatchCtx {
  config: AppConfig
  storage?: Storage
  logger?: Logger
}

export interface DispatchResult {
  mattermost: boolean
  slack: boolean
  paged: number
  /** Recipients skipped because they were over budget this hour. */
  suppressed: number
}

/** Per-subscriber page budget, then silence until the window rolls. */
const PAGES_PER_HOUR = 5
const WINDOW_MS = 60 * 60 * 1000

/**
 * Cloud Run runs max-instances=1, so per-instance memory is sufficient state.
 * A restart forgives the budget, which is the safe direction to fail: it pages
 * more, never less.
 */
const budget = new Map<string, number[]>()

function withinBudget(subId: string, now: number): boolean {
  const recent = (budget.get(subId) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= PAGES_PER_HOUR) {
    budget.set(subId, recent)
    return false
  }
  recent.push(now)
  budget.set(subId, recent)
  return true
}

export function resetBudget(): void {
  budget.clear()
}

/** Template slot 3. WhatsApp renders one line; a wall of text helps nobody at 3am. */
function detailSlot(event: AlertEvent): string {
  const scope = event.network ? `${event.network} ` : ''
  const line = `${scope}${event.detail}`.replace(/\s+/g, ' ').trim()
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

function twilioConfig(pager: PagerConfig): TwilioConfig {
  return {
    accountSid: pager.accountSid,
    keySid: pager.keySid,
    keySecret: pager.keySecret,
    from: pager.from,
    channel: pager.channel,
  }
}

function cryptoKeys(pager: PagerConfig): CryptoKeys {
  return {
    ring: parseKeyRing(pager.encKeys),
    indexPepper: Buffer.from(pager.indexPepper, 'base64'),
  }
}

async function page(
  event: AlertEvent,
  pager: PagerConfig,
  storage: Storage,
  logger?: Logger
): Promise<{ paged: number; suppressed: number }> {
  const keys = cryptoKeys(pager)
  const twilio = twilioConfig(pager)
  const { roster } = await loadRoster(storage, logger)

  const recipients: Subscriber[] = roster.subscribers.filter((s) =>
    matches(s, event.topic, event.network, event.severity)
  )

  let paged = 0
  let suppressed = 0
  const now = Date.now()

  for (const sub of recipients) {
    if (!withinBudget(sub.id, now)) {
      suppressed++
      logger?.warn('pager budget exhausted', { subscriber: sub.id })
      continue
    }

    // Decrypt one recipient at a time and never hold the plaintext beyond
    // this iteration; logs carry the id and last four only.
    const to = open(sub.phone, keys)
    const result = await send(twilio, to, event.detail, {
      contentSid: pager.alertTemplateSid,
      variables: {
        '1': event.severity,
        '2': event.id,
        '3': detailSlot(event),
      },
    })

    if (result.ok) {
      paged++
      logger?.info('paged', { subscriber: sub.id, sid: result.sid })
    } else {
      logger?.error('page failed', {
        subscriber: sub.id,
        last4: sub.phoneLast4,
        code: result.errorCode,
        error: result.error,
      })
    }
  }

  return { paged, suppressed }
}

/**
 * `payload` is the already-formatted Mattermost message; `event` carries the
 * routing facts. Keeping them separate means the existing formatters are
 * reached unchanged and the pager does not re-render anything.
 */
export async function dispatch(
  payload: MattermostPayload,
  event: AlertEvent,
  ctx: DispatchCtx
): Promise<DispatchResult> {
  const { config, logger } = ctx
  const result: DispatchResult = {
    mattermost: false,
    slack: false,
    paged: 0,
    suppressed: 0,
  }

  try {
    await postToMattermost(config.mattermostWebhookUrl, payload)
    result.mattermost = true
  } catch (err: unknown) {
    logger?.error('Mattermost post failed', { error: getErrorMessage(err) })
  }

  try {
    await mirrorToSlack(config.slackWebhookUrl, payload, logger)
    result.slack = Boolean(config.slackWebhookUrl)
  } catch (err: unknown) {
    logger?.warn('Slack mirror failed', { error: getErrorMessage(err) })
  }

  if (config.pager && ctx.storage) {
    try {
      const outcome = await page(event, config.pager, ctx.storage, logger)
      result.paged = outcome.paged
      result.suppressed = outcome.suppressed
    } catch (err: unknown) {
      logger?.error('pager dispatch failed', { error: getErrorMessage(err) })
    }
  }

  return result
}
