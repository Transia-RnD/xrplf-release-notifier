import type { Storage } from '@google-cloud/storage'
import { z } from 'zod'
import {
  SEVERITY_RANK,
  isNetworkScoped,
  type NetworkId,
  type Severity,
  type Topic,
} from '../alerts/types'
import { blindIndex, seal, type CryptoKeys } from './crypto'

const BUCKET_NAME = process.env.GCS_BUCKET ?? 'xrplf-release-notifier'
const ROSTER_FILE = 'sms-subscribers.json'

const SealedSchema = z.object({
  v: z.number().int().positive(),
  iv: z.string(),
  tag: z.string(),
  ct: z.string(),
})

const SubscriptionSchema = z
  .object({
    network: z.enum(['mainnet', 'alphanet']).nullable(),
    topic: z.enum([
      'network',
      'security',
      'unl',
      'infra',
      'releases',
      'parity',
    ]),
    minSeverity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  })
  .refine((s) => isNetworkScoped(s.topic) === (s.network !== null), {
    message:
      'network-scoped topics require a network; releases/parity must have none',
  })

const SubscriberSchema = z.object({
  id: z.string(),
  label: z.string(),
  phone: SealedSchema,
  phoneIndex: z.string(),
  phoneLast4: z.string(),
  subscriptions: z.array(SubscriptionSchema),
  status: z.enum(['active', 'pending', 'stopped']),
  consentAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
})

const RosterSchema = z.object({
  version: z.literal(1),
  subscribers: z.array(SubscriberSchema),
})

export type Subscription = z.infer<typeof SubscriptionSchema>
export type Subscriber = z.infer<typeof SubscriberSchema>
export type Roster = z.infer<typeof RosterSchema>

export const EMPTY_ROSTER: Roster = { version: 1, subscribers: [] }

export interface MinimalLogger {
  error(message: string, meta?: Record<string, unknown>): void
}

/**
 * E.164 normalisation. Deliberately narrow: bare 10-digit input is assumed
 * NANP, anything else must arrive with an explicit `+` country code rather
 * than being guessed at.
 */
export function toE164(raw: string): string {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (trimmed.startsWith('+')) {
    if (digits.length < 8 || digits.length > 15) {
      throw new Error(`not a plausible E.164 number: ${digits.length} digits`)
    }
    return `+${digits}`
  }
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  throw new Error(
    `ambiguous number (${digits.length} digits) — pass it with a + country code`
  )
}

export function newSubscriber(
  e164: string,
  label: string,
  subscriptions: Subscription[],
  keys: CryptoKeys,
  now: Date,
  status: Subscriber['status'] = 'pending'
): Subscriber {
  return {
    id: `sub_${blindIndex(e164, keys).slice(0, 8)}`,
    label,
    phone: seal(e164, keys),
    phoneIndex: blindIndex(e164, keys),
    phoneLast4: e164.slice(-4),
    subscriptions,
    status,
    consentAt: null,
    verifiedAt: null,
    createdAt: now.toISOString(),
  }
}

/** Does this alert reach this subscriber? Severity is the gate that matters. */
export function matches(
  sub: Subscriber,
  topic: Topic,
  network: NetworkId | null,
  severity: Severity
): boolean {
  if (sub.status !== 'active') return false
  return sub.subscriptions.some(
    (s) =>
      s.topic === topic &&
      s.network === network &&
      SEVERITY_RANK[severity] >= SEVERITY_RANK[s.minSeverity]
  )
}

export function findByIndex(
  roster: Roster,
  index: string
): Subscriber | undefined {
  return roster.subscribers.find((s) => s.phoneIndex === index)
}

interface LoadedRoster {
  roster: Roster
  /** GCS generation, replayed as a precondition on save. 0 means "must not exist". */
  generation: number
}

/**
 * Load the roster with its generation. A malformed roster is NOT recovered
 * field-by-field the way monitors-state is: a half-understood roster could
 * text the wrong person or resurrect a stopped one, so it fails closed and
 * the caller sends nothing.
 */
export async function loadRoster(
  storage: Storage,
  logger?: MinimalLogger
): Promise<LoadedRoster> {
  const file = storage.bucket(BUCKET_NAME).file(ROSTER_FILE)
  let content: Buffer
  let generation = 0
  try {
    const [meta] = await file.getMetadata()
    generation = Number(meta.generation ?? 0)
    ;[content] = await file.download()
  } catch {
    return { roster: { ...EMPTY_ROSTER }, generation: 0 }
  }

  let raw: unknown
  try {
    raw = JSON.parse(content.toString())
  } catch {
    ;(logger ?? console).error(
      'sms-subscribers.json is not valid JSON — refusing to send any SMS this run'
    )
    throw new Error('roster unreadable')
  }

  const validated = RosterSchema.safeParse(raw)
  if (!validated.success) {
    ;(logger ?? console).error(
      'sms-subscribers.json failed validation — refusing to send any SMS this run',
      { issues: validated.error.issues }
    )
    throw new Error('roster invalid')
  }
  return { roster: validated.data, generation }
}

/**
 * Write the roster back, refusing to clobber a concurrent edit. The admin CLI
 * and the inbound STOP handler both write here, and a lost STOP is a
 * compliance failure rather than merely stale data.
 */
export async function saveRoster(
  storage: Storage,
  roster: Roster,
  generation: number
): Promise<void> {
  await storage
    .bucket(BUCKET_NAME)
    .file(ROSTER_FILE)
    .save(JSON.stringify(roster, null, 2), {
      contentType: 'application/json',
      preconditionOpts: { ifGenerationMatch: generation },
    })
}
