import axios from 'axios'
import type { Logger } from 'winston'
import type { MattermostAttachment, MattermostPayload } from './mattermost'
import { getErrorMessage } from '../utils/error'

/**
 * Mirror a Mattermost notification to Slack when a webhook is configured.
 * Never throws — a Slack hiccup must not sink the Mattermost post or the
 * pipeline that produced it.
 */
export async function mirrorToSlack(
  slackWebhookUrl: string | undefined,
  payload: MattermostPayload,
  logger?: Logger
): Promise<void> {
  if (!slackWebhookUrl) return
  try {
    await postToSlack(slackWebhookUrl, payload)
    logger?.info('Slack notification sent')
  } catch (err: unknown) {
    logger?.warn('Slack mirror failed', { error: getErrorMessage(err) })
  }
}

/**
 * Slack incoming-webhook mirror of a Mattermost notification. Slack's legacy
 * webhook format is what Mattermost cloned, so the envelope maps 1:1 — only
 * the markdown dialect differs (Slack mrkdwn).
 */
export async function postToSlack(
  webhookUrl: string,
  payload: MattermostPayload
): Promise<void> {
  const response = await axios.post(webhookUrl, toSlackPayload(payload))
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Slack webhook failed with status ${response.status}`)
  }
}

export function toSlackPayload(payload: MattermostPayload): object {
  return {
    ...(payload.username ? { username: payload.username } : {}),
    ...(payload.icon_url ? { icon_url: payload.icon_url } : {}),
    ...(payload.text ? { text: toMrkdwn(payload.text) } : {}),
    ...(payload.attachments
      ? { attachments: payload.attachments.map(toSlackAttachment) }
      : {}),
  }
}

function toSlackAttachment(a: MattermostAttachment): object {
  return {
    fallback: a.fallback,
    color: a.color,
    ...(a.pretext ? { pretext: toMrkdwn(a.pretext) } : {}),
    ...(a.title ? { title: a.title } : {}),
    ...(a.title_link ? { title_link: a.title_link } : {}),
    ...(a.text ? { text: toMrkdwn(a.text) } : {}),
    ...(a.footer ? { footer: a.footer } : {}),
    ...(a.ts ? { ts: a.ts } : {}),
    mrkdwn_in: ['text', 'pretext'],
  }
}

/**
 * Mattermost markdown → Slack mrkdwn: `[text](url)` → `<url|text>`,
 * `**bold**` → `*bold*`. Inline code and emoji shortcodes pass through.
 */
export function toMrkdwn(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    .replace(/\*\*([^*]+(?:\*[^*]+)*)\*\*/g, '*$1*')
}
