import axios from 'axios'
import { envelope } from '../../notifications/mattermost'
import type { MattermostPayload } from '../../notifications/mattermost'
import type { HandlerContext } from '../handlers'

/**
 * The signed list is the authority on membership. data.xrpl.org cannot be used
 * for it: its `unl` field only ever reports vl.ripple.com / vl.xahau.org /
 * testnets, so `unl.xrplf.org` membership is invisible there.
 */
const UNL_YAML =
  'https://raw.githubusercontent.com/XRPLF/unl/main/data/unl-raw.yaml'
const VHS = 'https://data.xrpl.org/v1/network/validators'

/** Below this 30-day agreement a validator is worth a human look. */
export const REVIEW_THRESHOLD = 0.995

/** How many to name at each end. "Who is the top" was the ask. */
export const LEADERBOARD = 5

const COLOR_OK = '#4CAF50'
const COLOR_ATTENTION = '#FF9800'

export interface UnlEntry {
  key: string
  name: string
}

export interface Agreement {
  score: number
  missed: number
  total: number
  incomplete: boolean
}

export interface ReviewRow {
  key: string
  name: string
  /** False when the validator is on the dUNL but absent from the data source. */
  observed: boolean
  agreement24h?: Agreement
  agreement30d?: Agreement
  version?: string
  partial?: boolean
  revoked?: boolean
}

interface VhsAgreement {
  missed?: number
  total?: number
  score?: string
  incomplete?: boolean
}

interface VhsValidator {
  master_key?: string
  server_version?: string
  partial?: boolean
  revoked?: boolean
  agreement_24h?: VhsAgreement
  agreement_30day?: VhsAgreement
}

/**
 * `- id: nH...` / `name: example.com` pairs. Hand-parsed for the same reason
 * the Rust crawler does it: the file is a flat two-field list and pulling in a
 * YAML parser to read it buys nothing.
 */
export function parseUnl(yaml: string): UnlEntry[] {
  const entries: UnlEntry[] = []
  const re = /-\s+id:\s*(\S+)\s*\r?\n\s*name:\s*(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(yaml)) !== null) {
    entries.push({ key: m[1], name: m[2] })
  }
  return entries
}

export function parseAgreement(
  a: VhsAgreement | undefined
): Agreement | undefined {
  if (a?.score === undefined) return undefined
  const score = Number(a.score)
  if (!Number.isFinite(score)) return undefined
  return {
    score,
    missed: a.missed ?? 0,
    total: a.total ?? 0,
    incomplete: a.incomplete === true,
  }
}

/** Join membership (authoritative) against telemetry (best-effort). */
export function buildReview(
  unl: UnlEntry[],
  validators: VhsValidator[]
): ReviewRow[] {
  const byKey = new Map<string, VhsValidator>()
  for (const v of validators) {
    if (v.master_key) byKey.set(v.master_key, v)
  }

  return unl.map(({ key, name }) => {
    const v = byKey.get(key)
    if (!v) return { key, name, observed: false }
    return {
      key,
      name,
      observed: true,
      agreement24h: parseAgreement(v.agreement_24h),
      agreement30d: parseAgreement(v.agreement_30day),
      version: v.server_version,
      partial: v.partial,
      revoked: v.revoked,
    }
  })
}

/** Ascending by 30-day agreement; unobserved validators sort worst. */
export function byAgreement(rows: ReviewRow[]): ReviewRow[] {
  return [...rows].sort(
    (a, b) => (a.agreement30d?.score ?? -1) - (b.agreement30d?.score ?? -1)
  )
}

export function versionSpread(rows: ReviewRow[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (!r.version) continue
    counts.set(r.version, (counts.get(r.version) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function pct(a: Agreement | undefined): string {
  return a ? `${(a.score * 100).toFixed(3)}%` : 'no data'
}

function row(r: ReviewRow): string {
  if (!r.observed) return `- ${r.name} — **not visible to the data source**`
  const missed = r.agreement30d ? ` (${r.agreement30d.missed} missed)` : ''
  const flags = [
    r.partial ? 'partial-only' : '',
    r.revoked ? 'REVOKED' : '',
  ].filter(Boolean)
  const suffix = flags.length ? ` — **${flags.join(', ')}**` : ''
  return `- ${r.name} — ${pct(r.agreement30d)}${missed}, \`${r.version ?? '?'}\`${suffix}`
}

export function buildCard(rows: ReviewRow[]): MattermostPayload {
  const ranked = byAgreement(rows)
  const attention = ranked.filter(
    (r) =>
      !r.observed ||
      r.partial === true ||
      r.revoked === true ||
      (r.agreement30d !== undefined && r.agreement30d.score < REVIEW_THRESHOLD)
  )
  const top = [...ranked].reverse().slice(0, LEADERBOARD)
  const versions = versionSpread(rows)

  const sections: string[] = []

  if (attention.length) {
    sections.push(
      `**Worth a look (${attention.length})** — below ${(REVIEW_THRESHOLD * 100).toFixed(1)}% over 30d, or not observable\n` +
        attention
          .slice(0, LEADERBOARD * 2)
          .map(row)
          .join('\n')
    )
  } else {
    sections.push(
      `**All ${rows.length} above ${(REVIEW_THRESHOLD * 100).toFixed(1)}% over 30d.**`
    )
  }

  sections.push(`**Top ${top.length}**\n${top.map(row).join('\n')}`)

  if (versions.length) {
    sections.push(
      `**Versions** — ${versions.map(([v, n]) => `\`${v}\` ×${n}`).join(', ')}`
    )
  }

  // Single-observer data, so the provenance ships with the figures.
  sections.push(
    '_Agreement from data.xrpl.org (single observer — a miss may be its vantage, not the operator). ' +
      'Membership from XRPLF/unl. Engagement and education are not measured here._'
  )

  const title = attention.length
    ? `dUNL weekly review — ${attention.length} of ${rows.length} worth a look`
    : `dUNL weekly review — all ${rows.length} healthy`

  return envelope({
    fallback: title,
    color: attention.length ? COLOR_ATTENTION : COLOR_OK,
    title,
    text: sections.join('\n\n'),
  })
}

export async function fetchUnl(): Promise<UnlEntry[]> {
  const res = await axios.get<string>(UNL_YAML, { responseType: 'text' })
  return parseUnl(res.data)
}

export async function fetchValidators(): Promise<VhsValidator[]> {
  const res = await axios.get<{ validators?: VhsValidator[] }>(VHS)
  return res.data.validators ?? []
}

/**
 * Weekly dUNL reliability review. Engagement and education are deliberately out
 * of scope here — neither is derivable from telemetry.
 */
export async function validatorReview(context: HandlerContext): Promise<void> {
  const [unl, validators] = await Promise.all([fetchUnl(), fetchValidators()])
  const rows = buildReview(unl, validators)
  await context.post(buildCard(rows), {
    report: 'validatorReview',
    unlSize: rows.length,
  })
}
