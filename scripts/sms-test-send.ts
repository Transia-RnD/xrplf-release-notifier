/**
 * Send one real test message to every ACTIVE subscriber, then poll each until
 * Twilio reports a terminal state. This is the only script in the repo that
 * sends SMS; it requires --live and prints the roster it would hit first.
 *
 * A 201 is not a delivery. The polling loop is the point.
 *
 * Usage:
 *   npx ts-node scripts/sms-test-send.ts            # dry run
 *   npx ts-node scripts/sms-test-send.ts --live     # actually sends
 */

import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { z } from 'zod'
import {
  open,
  parseKeyRing,
  type CryptoKeys,
} from '../src/notifications/crypto'
import {
  EMPTY_ROSTER,
  type Roster,
  type Subscriber,
} from '../src/notifications/subscribers'
import {
  explainErrorCode,
  fetchMessage,
  isTerminal,
  send,
  type Template,
  type Channel,
  type TwilioConfig,
} from '../src/notifications/twilio'

dotenv.config()

/**
 * Deliberately not a rendered alert. A real-looking CRITICAL page sent as a
 * test teaches recipients to distrust the pager. Carries opt-out wording,
 * which the first message to a subscriber must anyway.
 */
const TEST_BODY =
  'XRPLF alerts: SMS pager test, no action needed. Reply STOP to opt out.'

const LOCAL_FILE =
  process.env.SMS_ROSTER_FILE ?? path.resolve(process.cwd(), '.sms-roster.json')

const CHANNEL: Channel =
  process.env.TWILIO_CHANNEL === 'whatsapp' ? 'whatsapp' : 'sms'

/**
 * WhatsApp needs an approved template for a business-initiated message; the
 * `{{1}}` slot carries the send time so each test is distinguishable on the
 * handset.
 */
const TEMPLATE: Template | undefined = process.env.TWILIO_TEST_TEMPLATE_SID
  ? {
      contentSid: process.env.TWILIO_TEST_TEMPLATE_SID,
      variables: { '1': new Date().toISOString().slice(0, 16) + 'Z' },
    }
  : undefined

const POLL_ATTEMPTS = 10
const POLL_INTERVAL_MS = 3000

function loadKeys(): CryptoKeys {
  const enc = process.env.SMS_ENC_KEYS
  const pepper = process.env.SMS_INDEX_PEPPER
  if (!enc || !pepper)
    throw new Error('SMS_ENC_KEYS and SMS_INDEX_PEPPER required')
  return { ring: parseKeyRing(enc), indexPepper: Buffer.from(pepper, 'base64') }
}

/**
 * Resolve basic-auth credentials as a pair. An API key only authenticates
 * alongside its own secret, so a half-set `SK…` falls through to the account
 * token rather than pairing with an unrelated secret.
 */
function loadTwilio(): TwilioConfig {
  const accountSid =
    process.env.TWILIO_ACCOUNT_SID ?? process.env.TWILIO_CLIENT_ID
  const keySid = process.env.TWILIO_API_KEY_SID
  const keySecret = process.env.TWILIO_API_KEY_SECRET
  const authToken = process.env.TWILIO_AUTH_TOKEN

  const pair =
    keySid && keySecret
      ? { keySid, keySecret }
      : authToken
        ? { keySid: accountSid, keySecret: authToken }
        : {}

  const parsed = z
    .object({
      accountSid: z.string().regex(/^AC[0-9a-f]{32}$/, 'must be an AC… SID'),
      keySid: z.string().min(1),
      keySecret: z.string().min(1),
      from: z.string().min(1),
    })
    .safeParse({ accountSid, ...pair, from: process.env.TWILIO_FROM })
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')} (${i.message})`)
      .join(', ')
    throw new Error(
      `bad Twilio config: ${detail}\n` +
        'set TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET, or TWILIO_AUTH_TOKEN'
    )
  }
  return { ...parsed.data, channel: CHANNEL }
}

function loadRoster(): Roster {
  if (!fs.existsSync(LOCAL_FILE)) return { ...EMPTY_ROSTER }
  return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')) as Roster
}

function mask(e164: string): string {
  return `${e164.slice(0, 5)}${'*'.repeat(Math.max(0, e164.length - 9))}${e164.slice(-4)}`
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const live = process.argv.includes('--live')
  const keys = loadKeys()
  const twilio = loadTwilio()
  const active: Subscriber[] = loadRoster().subscribers.filter(
    (s) => s.status === 'active'
  )

  console.log(`channel: ${CHANNEL}`)
  console.log(`template: ${TEMPLATE?.contentSid ?? '(free-form body)'}`)
  console.log(`from: ${twilio.from}`)
  console.log(`body: ${TEST_BODY} (${TEST_BODY.length} chars)`)
  console.log(`recipients: ${active.length} active\n`)

  if (active.length === 0) {
    console.log('nobody active on the roster — nothing to do')
    return
  }

  if (!live) {
    for (const s of active) {
      console.log(`  would send -> ${s.id} ${s.label} ***${s.phoneLast4}`)
    }
    console.log('\ndry run — pass --live to actually send')
    return
  }

  const sent: { sub: Subscriber; sid: string }[] = []
  for (const sub of active) {
    // Decrypt one recipient at a time, at send time, and never hold the
    // plaintext beyond this iteration.
    const to = open(sub.phone, keys)
    const result = await send(twilio, to, TEST_BODY, TEMPLATE)
    if (result.ok && result.sid) {
      console.log(
        `  accepted  ${sub.label.padEnd(6)} ${mask(to)}  ${result.sid}  status=${result.status}`
      )
      sent.push({ sub, sid: result.sid })
    } else {
      const hint = explainErrorCode(result.errorCode ?? null)
      console.log(
        `  REJECTED  ${sub.label.padEnd(6)} ${mask(to)}  code=${result.errorCode ?? '-'} ${result.error ?? ''}` +
          (hint ? `\n            ${hint}` : '')
      )
    }
  }

  if (sent.length === 0) {
    console.log('\nnothing was accepted — no delivery to confirm')
    return
  }

  console.log('\npolling for terminal delivery status...')
  const pending = new Map(sent.map((s) => [s.sid, s.sub]))
  for (
    let attempt = 0;
    attempt < POLL_ATTEMPTS && pending.size > 0;
    attempt++
  ) {
    await sleep(POLL_INTERVAL_MS)
    for (const [sid, sub] of [...pending]) {
      const status = await fetchMessage(twilio, sid)
      if (!status) continue
      if (!isTerminal(status.status)) continue
      pending.delete(sid)
      const hint = explainErrorCode(status.errorCode)
      console.log(
        `  ${status.status.toUpperCase().padEnd(11)} ${sub.label.padEnd(6)} ***${sub.phoneLast4}` +
          (status.errorCode ? `  code=${status.errorCode}` : '') +
          (hint ? `\n            ${hint}` : '') +
          (status.errorMessage ? `\n            ${status.errorMessage}` : '')
      )
    }
  }

  for (const [, sub] of pending) {
    console.log(
      `  STILL QUEUED ${sub.label} ***${sub.phoneLast4} — no terminal status yet`
    )
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
