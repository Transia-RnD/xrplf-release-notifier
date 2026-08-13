import axios from 'axios'
import { parse as parseToml } from 'smol-toml'
import { envelope } from '../../notifications/mattermost'
import type { MattermostPayload } from '../../notifications/mattermost'
import type { HandlerContext } from '../handlers'
import { fetchUnl, type UnlEntry } from './validatorReview'

/**
 * XLS-50 makes `network_asn` a MUST for validator TOMLs; the rest are SHOULDs.
 */
export const REQUIRED_FIELDS = ['network_asn'] as const
export const RECOMMENDED_FIELDS = [
  'server_country',
  'server_location',
  'server_cloud',
] as const

const TIMEOUT_MS = 8000
const CONCURRENCY = 10

const COLOR_OK = '#4CAF50'
const COLOR_GAPS = '#FF9800'

/** Why a TOML could not be used. Distinguishes "absent" from "present but wrong". */
export type TomlFailure =
  | 'unreachable'
  | 'not-found'
  | 'unparseable'
  | 'no-validators-block'
  | 'key-not-listed'

export interface TomlResult {
  name: string
  key: string
  failure?: TomlFailure
  /** The validator's own [[VALIDATORS]] entry, when its key is listed. */
  listed: boolean
  missingRequired: string[]
  missingRecommended: string[]
  attested: boolean
  asn?: string
  country?: string
  cloud?: string
  cpu?: string
  memory?: string
}

interface ValidatorsEntry {
  public_key?: unknown
  network_asn?: unknown
  server_country?: unknown
  server_location?: unknown
  server_cloud?: unknown
  attestation?: unknown
}

interface SpecEntry {
  CPU?: unknown
  MEMORY?: unknown
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

/**
 * Evaluate one validator against its published TOML.
 *
 * Domain verification here means "the key claimed by this domain is listed in
 * the TOML that domain serves". The signed `attestation` is reported as present
 * or absent but not cryptographically checked — see the spec checklist.
 */
export function evaluateToml(
  entry: UnlEntry,
  body: string | null,
  failure?: TomlFailure
): TomlResult {
  const base: TomlResult = {
    name: entry.name,
    key: entry.key,
    listed: false,
    missingRequired: [...REQUIRED_FIELDS],
    missingRecommended: [...RECOMMENDED_FIELDS],
    attested: false,
  }

  if (failure !== undefined || body === null)
    return { ...base, failure: failure ?? 'not-found' }

  let doc: Record<string, unknown>
  try {
    doc = parseToml(body) as Record<string, unknown>
  } catch {
    return { ...base, failure: 'unparseable' }
  }

  const validators = doc.VALIDATORS
  if (!Array.isArray(validators)) {
    return { ...base, failure: 'no-validators-block' }
  }

  const mine = (validators as ValidatorsEntry[]).find(
    (v) => str(v.public_key) === entry.key
  )
  if (!mine) return { ...base, failure: 'key-not-listed' }

  // VALIDATOR_SPEC is not in XLS-50 — it is the convention operators use for
  // hardware specs.
  const spec = Array.isArray(doc.VALIDATOR_SPEC)
    ? ((doc.VALIDATOR_SPEC as SpecEntry[])[0] ?? {})
    : ((doc.VALIDATOR_SPEC as SpecEntry | undefined) ?? {})

  return {
    name: entry.name,
    key: entry.key,
    listed: true,
    missingRequired: REQUIRED_FIELDS.filter(
      (f) => str(mine[f as keyof ValidatorsEntry]) === undefined
    ),
    missingRecommended: RECOMMENDED_FIELDS.filter(
      (f) => str(mine[f as keyof ValidatorsEntry]) === undefined
    ),
    attested: str(mine.attestation) !== undefined,
    asn: str(mine.network_asn),
    country: str(mine.server_country),
    cloud: str(mine.server_cloud),
    cpu: str(spec.CPU),
    memory: str(spec.MEMORY),
  }
}

export async function fetchToml(entry: UnlEntry): Promise<TomlResult> {
  const url = `https://${entry.name}/.well-known/xrp-ledger.toml`
  try {
    const res = await axios.get<string>(url, {
      timeout: TIMEOUT_MS,
      responseType: 'text',
      // 404 is a finding, not an exception — it means "publishes nothing".
      validateStatus: () => true,
    })
    if (res.status === 404) return evaluateToml(entry, null, 'not-found')
    if (res.status >= 400) return evaluateToml(entry, null, 'unreachable')
    return evaluateToml(entry, res.data)
  } catch {
    return evaluateToml(entry, null, 'unreachable')
  }
}

/** Bounded fan-out; 35 domains at 8s would otherwise risk the request budget. */
export async function fetchAll(entries: UnlEntry[]): Promise<TomlResult[]> {
  const results: TomlResult[] = []
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    results.push(
      ...(await Promise.all(entries.slice(i, i + CONCURRENCY).map(fetchToml)))
    )
  }
  return results
}

export function tally<T>(values: (T | undefined)[]): [T, number][] {
  const counts = new Map<T, number>()
  for (const v of values) {
    if (v === undefined) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

export function buildCard(results: TomlResult[]): MattermostPayload {
  const noToml = results.filter((r) => r.failure !== undefined)
  const listed = results.filter((r) => r.listed)
  const missingAsn = listed.filter((r) => r.missingRequired.length > 0)
  const withHardware = listed.filter((r) => r.memory !== undefined)
  const compliant = listed.filter(
    (r) => r.missingRequired.length === 0 && r.missingRecommended.length === 0
  )

  const sections: string[] = [
    `**XLS-50 compliance — ${compliant.length}/${results.length} fully compliant**\n` +
      `- ${listed.length} publish a usable TOML listing their own key\n` +
      `- ${listed.length - missingAsn.length} carry \`network_asn\` (a **MUST**)\n` +
      `- ${results.filter((r) => r.attested).length} carry a signed \`attestation\``,
  ]

  if (noToml.length) {
    sections.push(
      `**No usable TOML (${noToml.length})**\n` +
        noToml.map((r) => `- ${r.name} — \`${r.failure ?? '?'}\``).join('\n')
    )
  }

  if (missingAsn.length) {
    sections.push(
      `**Missing \`network_asn\` (${missingAsn.length})**\n` +
        missingAsn.map((r) => `- ${r.name}`).join('\n')
    )
  }

  const asns = tally(listed.map((r) => r.asn))
  // Operators write the country both cased and uncased ("us" and "US" both
  // occur on the live dUNL). Tallying them apart understates concentration,
  // which is the one thing this section exists to measure.
  const countries = tally(listed.map((r) => r.country?.toUpperCase()))
  if (asns.length) {
    sections.push(
      `**Concentration (of the ${listed.length} that declare it)**\n` +
        `- ASN: ${asns.map(([a, n]) => `\`${a}\` ×${n}`).join(', ')}\n` +
        `- Country: ${countries.map(([c, n]) => `${c} ×${n}`).join(', ')}`
    )
  }

  sections.push(
    withHardware.length
      ? `**Declared hardware (${withHardware.length}/${results.length})**\n` +
          withHardware
            .map((r) => `- ${r.name} — ${r.memory ?? '?'}, ${r.cpu ?? 'CPU ?'}`)
            .join('\n')
      : '**Declared hardware** — none published.'
  )

  // Absence of a field is not absence of the property: a validator with no ASN
  // published still has one. This report measures disclosure, not infrastructure.
  sections.push(
    '_Measures what operators publish, not what they run. A missing field is a disclosure gap, not a fault. ' +
      '`attestation` is reported as present/absent, not signature-verified._'
  )

  const title = `dUNL TOML & XLS-50 — ${compliant.length}/${results.length} compliant, ${noToml.length} publish nothing usable`

  return envelope({
    fallback: title,
    color: noToml.length || missingAsn.length ? COLOR_GAPS : COLOR_OK,
    title,
    text: sections.join('\n\n'),
  })
}

/**
 * Monthly XLS-50 / domain-verification sweep. Also the only automated source of
 * the validator hardware inventory, which is otherwise polled by hand.
 */
export async function validatorToml(context: HandlerContext): Promise<void> {
  const unl = await fetchUnl()
  const results = await fetchAll(unl)
  await context.post(buildCard(results), {
    report: 'validatorToml',
    unlSize: results.length,
    noToml: results.filter((r) => r.failure !== undefined).length,
  })
}
