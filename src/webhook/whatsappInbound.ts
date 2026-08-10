import crypto from 'crypto'
import type { Request, Response } from 'express'
import type { Storage } from '@google-cloud/storage'
import type { Logger } from 'winston'
import type { AppConfig } from '../config'
import { blindIndex, parseKeyRing } from '../notifications/crypto'
import {
  findByIndex,
  loadRoster,
  saveRoster,
  toE164,
} from '../notifications/subscribers'
import { getErrorMessage } from '../utils/error'

/**
 * Inbound WhatsApp messages from Twilio.
 *
 * WhatsApp opt-out arrives as a reply and is not filtered upstream the way
 * carriers filter SMS, so the roster is the only place a STOP is recorded.
 */

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'cancel', 'end', 'quit'])
const START_WORDS = new Set(['start', 'unstop', 'subscribe'])

/**
 * Twilio signs the exact URL plus the sorted form fields. The signature is the
 * only thing separating a real opt-out from anyone who learns the endpoint,
 * so an unverifiable request is dropped rather than trusted.
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url)
  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(payload, 'utf-8'))
    .digest('base64')

  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** `whatsapp:+3312…` → `+3312…`; plain E.164 passes through. */
function stripChannel(address: string): string {
  return address.replace(/^whatsapp:/, '')
}

export async function handleWhatsappInbound(
  req: Request,
  res: Response,
  config: AppConfig,
  storage: Storage,
  logger?: Logger
): Promise<void> {
  const pager = config.pager
  if (!pager) {
    res.status(503).send('pager not configured')
    return
  }

  const params = (req.body ?? {}) as Record<string, string>
  const signature = req.get('X-Twilio-Signature') ?? ''
  const url = `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`

  // Twilio signs with the account auth token, not the API key pair.
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    logger?.error('inbound rejected: TWILIO_AUTH_TOKEN unset')
    res.status(503).send('inbound not configured')
    return
  }

  if (!verifyTwilioSignature(authToken, url, params, signature)) {
    logger?.warn('inbound rejected: bad Twilio signature')
    res.status(403).send('bad signature')
    return
  }

  const from = params.From ?? ''
  const body = (params.Body ?? '').trim().toLowerCase()

  let e164: string
  try {
    e164 = toE164(stripChannel(from))
  } catch (err: unknown) {
    logger?.warn('inbound from unparseable address', {
      error: getErrorMessage(err),
    })
    res.status(200).send('<Response/>')
    return
  }

  const keys = {
    ring: parseKeyRing(pager.encKeys),
    indexPepper: Buffer.from(pager.indexPepper, 'base64'),
  }

  // The blind index finds the record without decrypting anyone's number.
  const index = blindIndex(e164, keys)

  try {
    const { roster, generation } = await loadRoster(storage, logger)
    const sub = findByIndex(roster, index)

    if (!sub) {
      logger?.info('inbound from a number not on the roster')
      res.status(200).send('<Response/>')
      return
    }

    const first = body.split(/\s+/)[0] ?? ''
    if (STOP_WORDS.has(first)) {
      sub.status = 'stopped'
      await saveRoster(storage, roster, generation)
      logger?.info('subscriber stopped', { subscriber: sub.id })
    } else if (START_WORDS.has(first)) {
      sub.status = 'active'
      sub.consentAt ??= new Date().toISOString()
      sub.verifiedAt = new Date().toISOString()
      await saveRoster(storage, roster, generation)
      logger?.info('subscriber started', { subscriber: sub.id })
    } else {
      // Any other reply is an ack. It opens Twilio's 24-hour window as a side
      // effect, which is why free-form follow-ups work during an incident.
      logger?.info('inbound ack', { subscriber: sub.id })
    }
  } catch (err: unknown) {
    logger?.error('inbound roster update failed', {
      error: getErrorMessage(err),
    })
  }

  // Always 200 with empty TwiML: a non-2xx makes Twilio retry, and a body would
  // be delivered to the sender as a reply.
  res.status(200).type('text/xml').send('<Response/>')
}
