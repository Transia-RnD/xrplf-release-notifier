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
 * Twilio SMS transport. Direct REST rather than the vendor SDK — sending is one
 * form-encoded POST, and `slack.ts` already sets the "axios plus a small module"
 * idiom for channels here.
 *
 * A 201 from the create call means *accepted*, not delivered: the message is
 * queued and its real fate arrives asynchronously. Anything that needs to know
 * a page landed must poll `fetchMessage` until the status is terminal.
 */

const API_ROOT = 'https://api.twilio.com/2010-04-01'

export interface TwilioConfig {
  accountSid: string
  /** API key SID (`SK…`) — preferred over the account-wide auth token. */
  keySid: string
  keySecret: string
  from: string
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

/** Terminal states — polling stops here. */
const TERMINAL = new Set(['delivered', 'undelivered', 'failed', 'canceled'])

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status)
}

function auth(config: TwilioConfig): { username: string; password: string } {
  return { username: config.keySid, password: config.keySecret }
}

/**
 * Send one message. Never throws — an SMS failure must not sink the Mattermost
 * post or the pipeline that produced it.
 */
export async function sendSms(
  config: TwilioConfig,
  to: string,
  body: string
): Promise<SendResult> {
  try {
    const response = await axios.post(
      `${API_ROOT}/Accounts/${config.accountSid}/Messages.json`,
      new URLSearchParams({ To: to, From: config.from, Body: body }),
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
    case 21614:
      return 'not a reachable mobile number'
    case 30034:
      return 'A2P 10DLC unregistered — carriers are filtering this sender'
    case 30007:
      return 'carrier filtered the message as spam'
    case 30003:
    case 30005:
      return 'handset unreachable or unknown'
    default:
      return null
  }
}
