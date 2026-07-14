import { envelope } from '../notifications/mattermost'
import type { MattermostPayload } from '../notifications/mattermost'
import { VersionType } from '../version/types'
import type { Reference } from './reference'
import type { SdkParityResult, FeatureVerdict } from './runSdkAgent'

/**
 * Renders the per-SDK parity verdicts into a Mattermost post. Severity tracks
 * the release type: beta/RC are heads-up warnings; a FINAL with any SDK behind
 * is the loud "released and NOT at parity" signal.
 */

const USERNAME = 'sdk parity'
const COLOR_OK = '#4CAF50'
const COLOR_WARN = '#FF9800'
const COLOR_FAIL = '#F44336'
const COLOR_NEUTRAL = '#9E9E9E'

/** Max feature lines shown per SDK before truncating. */
const MAX_FEATURE_LINES = 12

export interface SdkReport {
  name: string
  repo: string
  result?: SdkParityResult
  error?: string
  /** Full-parity only: deterministic Level-1 field coverage from definitions.json. */
  fieldsLevel1?: { present: number; total: number; missing: string[] }
}

export interface FormatParityReportInput {
  versionType: VersionType
  reference: Reference
  sdks: SdkReport[]
  /**
   * 'delta' (default) = "what's new in this release"; 'full' = a backlog sweep
   * of the SDK against the entire protocol type set at `reference.tag`.
   */
  mode?: 'delta' | 'full'
}

const KIND_LABEL: Record<FeatureVerdict['kind'], string> = {
  transactionType: 'tx',
  ledgerEntryType: 'ledger',
  field: 'field',
}

function verdictEmoji(v: FeatureVerdict['level2']): string {
  if (v === 'missing') return '🔴'
  if (v === 'declared-only') return '🟠'
  return '✅'
}

function notAtParity(r: SdkParityResult): FeatureVerdict[] {
  return r.features.filter((f) => f.level2 !== 'supported')
}

/** One bullet per gap (emoji + name + kind + verdict + optional PR), capped. */
function formatGapLines(gaps: FeatureVerdict[]): string {
  const lines = gaps.slice(0, MAX_FEATURE_LINES).map((f) => {
    const pr = f.inProgressPR
      ? ` — PR #${f.inProgressPR.number} in progress`
      : ''
    return `${verdictEmoji(f.level2)} \`${f.name}\` (${KIND_LABEL[f.kind]}): ${f.level2}${pr}`
  })
  if (gaps.length > MAX_FEATURE_LINES) {
    lines.push(`…and ${gaps.length - MAX_FEATURE_LINES} more`)
  }
  return lines.join('\n')
}

function renderSdk(sdk: SdkReport): string {
  if (sdk.error) {
    return `**${sdk.name}** — ⚠️ check failed: ${sdk.error}`
  }
  const result = sdk.result
  if (!result) return `**${sdk.name}** — ⚠️ no result`

  const gaps = notAtParity(result)
  if (gaps.length === 0) {
    return `**${sdk.name}** — ✅ at parity`
  }

  return `**${sdk.name}** — ⚠️ ${gaps.length} gap${gaps.length === 1 ? '' : 's'}\n${formatGapLines(gaps)}`
}

function renderSdkFull(sdk: SdkReport): string {
  if (sdk.error) return `**${sdk.name}** — ⚠️ check failed: ${sdk.error}`
  const result = sdk.result
  if (!result) return `**${sdk.name}** — ⚠️ no result`

  const total = result.features.length
  const supported = total - notAtParity(result).length
  const fields = sdk.fieldsLevel1
  const fieldsLine = fields
    ? `\nfields: ${fields.present}/${fields.total} in definitions.json` +
      (fields.missing.length ? ` (${fields.missing.length} missing)` : '')
    : ''

  if (supported === total) {
    return `**${sdk.name}** — ✅ all ${total} types supported${fieldsLine}`
  }

  const gaps = notAtParity(result)
  return `**${sdk.name}** — ${supported}/${total} types supported, ${gaps.length} gap${gaps.length === 1 ? '' : 's'}${fieldsLine}\n${formatGapLines(gaps)}`
}

function formatFullReport(input: FormatParityReportInput): MattermostPayload {
  const { reference, sdks } = input
  const tag = reference.tag
  const typeCount = reference.full.transactionTypes.length
  const anyBehind = sdks.some(
    (s) =>
      s.error !== undefined ||
      (s.result !== undefined && notAtParity(s.result).length > 0)
  )
  const body = sdks.map(renderSdkFull).join('\n\n')
  return envelope(
    {
      fallback: `Full SDK parity audit vs xrpld ${tag}`,
      color: anyBehind ? COLOR_WARN : COLOR_OK,
      pretext: `:clipboard: Full SDK parity audit vs xrpld \`${tag}\` — ${typeCount} transaction types.`,
      text: body,
    },
    { username: USERNAME }
  )
}

export function formatParityReport(
  input: FormatParityReportInput
): MattermostPayload {
  if (input.mode === 'full') return formatFullReport(input)

  const { versionType, reference, sdks } = input
  const tag = reference.tag
  const isPrerelease =
    versionType === VersionType.BETA || versionType === VersionType.RC

  // Couldn't establish a parseable predecessor — say so honestly rather than
  // implying "all good".
  if (reference.baselineMissing) {
    return envelope(
      {
        fallback: `SDK parity: xrpld ${tag} — no predecessor baseline`,
        color: COLOR_NEUTRAL,
        pretext: `:information_source: SDK parity — couldn't establish a parseable predecessor baseline for xrpld \`${tag}\` (predecessor \`${reference.predecessorTag ?? 'none'}\` predates the protocol macro layout). Skipping per-feature parity.`,
      },
      { username: USERNAME }
    )
  }

  // No new protocol features this release — neutral informational post.
  if (reference.added.length === 0) {
    return envelope(
      {
        fallback: `SDK parity: xrpld ${tag} adds no new protocol features`,
        color: COLOR_NEUTRAL,
        pretext: `:information_source: SDK parity — xrpld \`${tag}\` introduces no new transaction types, ledger entries, or fields vs \`${reference.predecessorTag ?? 'previous'}\`. Nothing to check.`,
      },
      { username: USERNAME }
    )
  }

  const anyBehind = sdks.some(
    (s) =>
      s.error !== undefined ||
      (s.result !== undefined && notAtParity(s.result).length > 0)
  )

  const color = isPrerelease ? COLOR_WARN : anyBehind ? COLOR_FAIL : COLOR_OK

  const icon = isPrerelease
    ? ':warning:'
    : anyBehind
      ? ':red_circle:'
      : ':white_check_mark:'
  const verb = isPrerelease
    ? `pre-release \`${tag}\` — SDKs should prepare`
    : anyBehind
      ? `\`${tag}\` released — these SDKs are NOT at parity`
      : `\`${tag}\` released — all SDKs at parity`

  const addedSummary = summarizeAdded(reference)
  const body = sdks.map(renderSdk).join('\n\n')

  return envelope(
    {
      fallback: `SDK parity report for xrpld ${tag}`,
      color,
      pretext: `${icon} SDK parity: xrpld ${verb}.`,
      text: `New in \`${tag}\`: ${addedSummary}\n\n${body}`,
    },
    { username: USERNAME }
  )
}

function summarizeAdded(reference: Reference): string {
  const counts: Record<string, number> = {}
  for (const f of reference.added) counts[f.kind] = (counts[f.kind] ?? 0) + 1
  const parts: string[] = []
  if (counts.transactionType) parts.push(`${counts.transactionType} tx type(s)`)
  if (counts.field) parts.push(`${counts.field} field(s)`)
  // Ledger-entry types are parsed for context but not a parity dimension.
  if (counts.ledgerEntryType)
    parts.push(`${counts.ledgerEntryType} ledger entry(ies, not checked)`)
  const amendments = reference.addedAmendments.length
    ? ` (amendments: ${reference.addedAmendments.join(', ')})`
    : ''
  return (parts.join(', ') || 'protocol changes') + amendments
}
