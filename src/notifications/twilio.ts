import axios from 'axios'
import { z } from 'zod'
import { getErrorMessage } from '../utils/error'

/** Runtime shape of Twilio's responses — an external API, never trusted. */
const MessageResourceSchema = z.object({
  sid: z.string(),
  status: z.string(),
  error_code: z.number().nullable().optional(),
  error_message: z.string().nullable().optional(),
})

const ApiErrorSchema = z.object({
  code: z.number().optional(),
  message: z.string().optional(),
})

/**
 * Twilio transport for SMS and WhatsApp. Direct REST rather than the vendor
 * SDK — sending is one form-encoded POST, and `slack.ts` already sets the
 * "axios plus a small module" idiom for channels here.
 *
 * A 201 from the create call means *accepted*, not delivered: the message is
 * queued and its real fate arrives asynchronously. Anything that needs to know
 * a page landed must poll `fetchMessage` until the status is terminal.
 */

const API_ROOT = 'https://api.twilio.com/2010-04-01'

/**
 * WhatsApp rides the same Messages API as SMS; the channel is carried in the
 * address scheme rather than a parameter.
 */
export type Channel = 'sms' | 'whatsapp'

export interface TwilioConfig {
  accountSid: string
  /** API key SID (`SK…`) — preferred over the account-wide auth token. */
  keySid: string
  keySecret: string
  /** Bare E.164 — `send` applies the channel scheme. */
  from: string
  channel?: Channel
}

function address(e164: string, channel: Channel): string {
  return channel === 'whatsapp' ? `whatsapp:${e164}` : e164
}

export interface SendResult {
  ok: boolean
  sid?: string
  status?: string
  errorCode?: number
  error?: string
}

export interface MessageStatus {
  status: string
  errorCode: number | null
  errorMessage: string | null
}

/**
 * Terminal states — polling stops here. WhatsApp settles one step past
 * `delivered`, so `read` must count or a read message never resolves.
 */
const TERMINAL = new Set([
  'delivered',
  'read',
  'undelivered',
  'failed',
  'canceled',
])

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status)
}

function auth(config: TwilioConfig): { username: string; password: string } {
  return { username: config.keySid, password: config.keySecret }
}

/** An approved WhatsApp template plus the values for its `{{n}}` placeholders. */
export interface Template {
  contentSid: string
  variables: Record<string, string>
}

/**
 * Send one message. Never throws — a delivery failure must not sink the
 * Mattermost post or the pipeline that produced it.
 *
 * WhatsApp rejects free-form text outside the 24-hour window that a recipient
 * reply opens (error 63016), so a business-initiated page must pass a
 * `Template`. Plain `body` remains valid for SMS and for replies inside a live
 * window.
 */
export async function send(
  config: TwilioConfig,
  to: string,
  body: string,
  template?: Template
): Promise<SendResult> {
  const channel = config.channel ?? 'sms'
  const params = new URLSearchParams({
    To: address(to, channel),
    From: address(config.from, channel),
  })
  if (template) {
    params.set('ContentSid', template.contentSid)
    params.set('ContentVariables', JSON.stringify(template.variables))
  } else {
    params.set('Body', body)
  }
  try {
    const response = await axios.post(
      `${API_ROOT}/Accounts/${config.accountSid}/Messages.json`,
      params,
      { auth: auth(config), timeout: 15_000 }
    )
    const parsed = MessageResourceSchema.safeParse(response.data)
    if (!parsed.success) {
      return {
        ok: false,
        error: 'Twilio returned an unrecognised message resource',
      }
    }
    return { ok: true, sid: parsed.data.sid, status: parsed.data.status }
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      const data = ApiErrorSchema.safeParse(err.response.data)
      return {
        ok: false,
        errorCode: data.success ? data.data.code : undefined,
        error:
          (data.success ? data.data.message : undefined) ??
          `HTTP ${err.response.status}`,
      }
    }
    return { ok: false, error: getErrorMessage(err) }
  }
}

/** Fetch a message's current delivery state. */
export async function fetchMessage(
  config: TwilioConfig,
  sid: string
): Promise<MessageStatus | null> {
  try {
    const response = await axios.get(
      `${API_ROOT}/Accounts/${config.accountSid}/Messages/${sid}.json`,
      { auth: auth(config), timeout: 15_000 }
    )
    const parsed = MessageResourceSchema.safeParse(response.data)
    if (!parsed.success) return null
    return {
      status: parsed.data.status,
      errorCode: parsed.data.error_code ?? null,
      errorMessage: parsed.data.error_message ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Twilio error codes worth naming — the difference between "wrong config" and
 * "carrier rejected it" is otherwise invisible in the logs.
 */
export function explainErrorCode(code: number | null): string | null {
  switch (code) {
    case 21606:
    case 21659:
      return 'the From number is not a valid sender on this account'
    case 21610:
      return 'this number has replied STOP — carrier-level opt-out'
    case 21612:
      return 'no carrier route between this From and To — the sender cannot reach that country'
    case 21614:
      return 'not a reachable mobile number'
    case 30034:
      return 'A2P 10DLC unregistered — carriers are filtering this sender'
    case 63003:
      return 'no WhatsApp account for this number — the recipient cannot be reached on this channel'
    case 63007:
      return 'the From address is not a registered WhatsApp sender'
    case 63016:
      return 'business-initiated WhatsApp message sent without a template — outside the 24h reply window a Template is required'
    case 30007:
      return 'carrier filtered the message as spam'
    case 30003:
    case 30005:
      return 'handset unreachable or unknown'
    default:
      return null
  }
}
