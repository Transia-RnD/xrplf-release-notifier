/**
 * SMS roster admin CLI. Phone numbers are PII: they are sealed with
 * SMS_ENC_KEYS before they touch storage, and this tool never prints one in
 * full. Enrollment is admin-initiated — there is no public signup — and every
 * new record starts `pending` until the person confirms.
 *
 * Usage:
 *   npx ts-node scripts/sms-roster.ts keygen
 *   npx ts-node scripts/sms-roster.ts add <number> --label=denis [--topics=network,security] \
 *                                     [--networks=mainnet] [--min=CRITICAL] [--gcs]
 *   npx ts-node scripts/sms-roster.ts list [--gcs]
 *   npx ts-node scripts/sms-roster.ts status <sub_id> active|pending|stopped [--gcs]
 *
 * Without --gcs the roster is a local file (SMS_ROSTER_FILE, default
 * ./.sms-roster.json) so the flow can be exercised without touching production.
 */

import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { Storage } from '@google-cloud/storage'
import {
  generateKey,
  parseKeyRing,
  type CryptoKeys,
} from '../src/notifications/crypto'
import {
  EMPTY_ROSTER,
  loadRoster,
  matches,
  newSubscriber,
  saveRoster,
  toE164,
  type Roster,
  type Subscription,
} from '../src/notifications/subscribers'
import {
  isNetworkScoped,
  type NetworkId,
  type Severity,
  type Topic,
} from '../src/alerts/types'

dotenv.config()

const LOCAL_FILE =
  process.env.SMS_ROSTER_FILE ?? path.resolve(process.cwd(), '.sms-roster.json')

function loadKeys(): CryptoKeys {
  const enc = process.env.SMS_ENC_KEYS
  const pepper = process.env.SMS_INDEX_PEPPER
  if (!enc || !pepper) {
    throw new Error(
      'SMS_ENC_KEYS and SMS_INDEX_PEPPER must be set — run `sms-roster.ts keygen` first'
    )
  }
  return {
    ring: parseKeyRing(enc),
    indexPepper: Buffer.from(pepper, 'base64'),
  }
}

function readLocal(): { roster: Roster; generation: number } {
  if (!fs.existsSync(LOCAL_FILE))
    return { roster: { ...EMPTY_ROSTER }, generation: 0 }
  return {
    roster: JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')) as Roster,
    generation: 0,
  }
}

function writeLocal(roster: Roster): void {
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(roster, null, 2), { mode: 0o600 })
}

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit?.split('=').slice(1).join('=')
}

function buildSubscriptions(): Subscription[] {
  const topics = (flag('topics') ?? 'network,security,infra,unl').split(
    ','
  ) as Topic[]
  const networks = (flag('networks') ?? 'mainnet').split(',') as NetworkId[]
  const minSeverity = (flag('min') ?? 'CRITICAL') as Severity
  const subs: Subscription[] = []
  for (const topic of topics) {
    if (isNetworkScoped(topic)) {
      for (const network of networks) subs.push({ network, topic, minSeverity })
    } else {
      subs.push({ network: null, topic, minSeverity })
    }
  }
  return subs
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  const useGcs = process.argv.includes('--gcs')
  const storage = useGcs
    ? new Storage({ projectId: process.env.GCP_PROJECT_ID })
    : null

  if (cmd === 'keygen') {
    console.log(
      'Add these to .env locally and to APP_SECRETS before deploying.'
    )
    console.log(
      'Rotating SMS_INDEX_PEPPER invalidates every blind index — do not.\n'
    )
    console.log(`SMS_ENC_KEYS={"1":"${generateKey()}"}`)
    console.log(`SMS_INDEX_PEPPER=${generateKey()}`)
    return
  }

  const load = async (): Promise<{ roster: Roster; generation: number }> =>
    storage ? await loadRoster(storage) : readLocal()
  const save = async (roster: Roster, generation: number): Promise<void> => {
    if (storage) await saveRoster(storage, roster, generation)
    else writeLocal(roster)
  }

  if (cmd === 'add') {
    const keys = loadKeys()
    const label = flag('label')
    if (!label) throw new Error('--label=<name> is required')
    const e164 = toE164(process.argv[3] ?? '')
    const { roster, generation } = await load()
    const sub = newSubscriber(
      e164,
      label,
      buildSubscriptions(),
      keys,
      new Date()
    )
    if (roster.subscribers.some((s) => s.phoneIndex === sub.phoneIndex)) {
      console.log(`already on the roster: ${sub.id} (***${sub.phoneLast4})`)
      return
    }
    roster.subscribers.push(sub)
    await save(roster, generation)
    console.log(
      `added ${sub.id} label=${label} ***${sub.phoneLast4} status=pending`
    )
    console.log(`  ${sub.subscriptions.length} subscriptions`)
    console.log('  pending until they reply to the confirmation message')
    return
  }

  if (cmd === 'status') {
    const id = process.argv[3]
    const next = process.argv[4] as 'active' | 'pending' | 'stopped'
    if (!['active', 'pending', 'stopped'].includes(next)) {
      throw new Error('status must be active|pending|stopped')
    }
    const { roster, generation } = await load()
    const sub = roster.subscribers.find((s) => s.id === id)
    if (!sub) throw new Error(`no subscriber ${id}`)
    const now = new Date().toISOString()
    sub.status = next
    if (next === 'active') {
      sub.consentAt ??= now
      sub.verifiedAt = now
    }
    await save(roster, generation)
    console.log(`${sub.id} (***${sub.phoneLast4}) -> ${next}`)
    return
  }

  if (cmd === 'label') {
    const id = process.argv[3]
    const next = process.argv[4]
    if (!next) throw new Error('usage: label <sub_id> <name>')
    const { roster, generation } = await load()
    const sub = roster.subscribers.find((s) => s.id === id)
    if (!sub) throw new Error(`no subscriber ${id}`)
    sub.label = next
    await save(roster, generation)
    console.log(`${sub.id} (***${sub.phoneLast4}) label -> ${next}`)
    return
  }

  if (cmd === 'list') {
    const { roster } = await load()
    if (roster.subscribers.length === 0) {
      console.log('roster is empty')
      return
    }
    for (const s of roster.subscribers) {
      console.log(
        `${s.id}  ${s.label.padEnd(10)} ***${s.phoneLast4}  ${s.status.padEnd(7)}  v${s.phone.v}`
      )
      for (const sub of s.subscriptions) {
        console.log(
          `    ${(sub.network ?? 'global').padEnd(9)} ${sub.topic.padEnd(9)} >= ${sub.minSeverity}`
        )
      }
      const pages = matches(s, 'network', 'mainnet', 'CRITICAL')
      console.log(`    mainnet CRITICAL fork would page: ${pages}`)
    }
    return
  }

  throw new Error(`unknown command: ${cmd ?? '(none)'}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
