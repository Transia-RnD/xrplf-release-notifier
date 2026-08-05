import { envelope } from '../notifications/mattermost'
import type { MattermostPayload } from '../notifications/mattermost'
import { VersionType } from '../version/types'
import type { Reference } from './reference'
import type { DocVerdict, DocFeatureKind, DocLevel } from './docs'

/**
 * Renders documentation-parity verdicts into a Mattermost post. Severity
 * mirrors the SDK report: beta/RC gaps are heads-up warnings; a FINAL release
 * with an undocumented feature is the loud "released and NOT documented"
 * signal. Field `unknown`s are best-effort observations and never drive
 * severity.
 */

const USERNAME = 'docs parity'
const COLOR_OK = '#4CAF50'
const COLOR_WARN = '#FF9800'
const COLOR_FAIL = '#F44336'
const COLOR_NEUTRAL = '#9E9E9E'

/** Max verdict lines shown before truncating. */
const MAX_LINES = 15

export interface FormatDocsReportInput {
  versionType: VersionType
  reference: Reference
  verdicts: DocVerdict[]
  mode: 'delta' | 'full'
  docsRepo: string
}

const KIND_LABEL: Record<DocFeatureKind, string> = {
  transactionType: 'tx',
  ledgerEntryType: 'ledger',
  field: 'field',
  amendment: 'amendment',
}

const LEVEL_EMOJI: Record<DocLevel, string> = {
  documented: '✅',
  partial: '🟠',
  missing: '🔴',
  unknown: '⚪',
}

/** Gaps that count toward severity: missing/partial pages and amendment entries. */
function hardGaps(verdicts: DocVerdict[]): DocVerdict[] {
  return verdicts.filter((v) => v.level === 'missing' || v.level === 'partial')
}

function line(v: DocVerdict): string {
  const reason = v.evidence.length > 0 ? ` — ${v.evidence.join('; ')}` : ''
  const pr = v.inProgressPR ? ` — PR #${v.inProgressPR.number} in progress` : ''
  return `${LEVEL_EMOJI[v.level]} \`${v.name}\` (${KIND_LABEL[v.kind]}): ${v.level}${reason}${pr}`
}

/** Gaps first (worst level first), then unknowns, then documented; capped. */
function formatLines(verdicts: DocVerdict[]): string {
  const order: Record<DocLevel, number> = {
    missing: 0,
    partial: 1,
    unknown: 2,
    documented: 3,
  }
  const sorted = [...verdicts].sort((a, b) => order[a.level] - order[b.level])
  const lines = sorted.slice(0, MAX_LINES).map(line)
  if (sorted.length > MAX_LINES) {
    lines.push(`…and ${sorted.length - MAX_LINES} more`)
  }
  return lines.join('\n')
}

function formatFullReport(input: FormatDocsReportInput): MattermostPayload {
  const { reference, verdicts, docsRepo } = input
  const tag = reference.tag

  const byKind = (kind: DocFeatureKind): { ok: number; total: number } => {
    const of = verdicts.filter((v) => v.kind === kind)
    return {
      ok: of.filter((v) => v.level === 'documented').length,
      total: of.length,
    }
  }
  const tx = byKind('transactionType')
  const le = byKind('ledgerEntryType')
  const am = byKind('amendment')
  const gaps = hardGaps(verdicts)

  // Field-table alignment across every page that has both a page and a spec.
  const audited = verdicts.filter((v) => v.checks.missingFields !== undefined)
  const aligned = audited.filter(
    (v) => (v.checks.missingFields ?? []).length === 0
  )
  const fieldSummary =
    audited.length > 0
      ? ` · field tables aligned: ${aligned.length}/${audited.length}`
      : ''

  const summary = `tx pages: ${tx.ok}/${tx.total} · ledger entries: ${le.ok}/${le.total} · amendments: ${am.ok}/${am.total}${fieldSummary}`
  const body =
    gaps.length > 0
      ? formatLines(gaps)
      : '_every page, nav entry, amendment entry, and field table checks out_'

  return envelope(
    {
      fallback: `Full docs parity audit vs xrpld ${tag}`,
      color: gaps.length > 0 ? COLOR_WARN : COLOR_OK,
      pretext: `:books: Full docs parity audit of \`${docsRepo}\` vs xrpld \`${tag}\` — ${summary}.`,
      text: body,
    },
    { username: USERNAME }
  )
}

export function formatDocsReport(
  input: FormatDocsReportInput
): MattermostPayload {
  if (input.mode === 'full') return formatFullReport(input)

  const { versionType, reference, verdicts } = input
  const tag = reference.tag
  const isPrerelease =
    versionType === VersionType.BETA || versionType === VersionType.RC

  if (verdicts.length === 0) {
    return envelope(
      {
        fallback: `Docs parity: xrpld ${tag} — nothing to check`,
        color: COLOR_NEUTRAL,
        pretext: `:books: Docs parity — xrpld \`${tag}\` introduces no protocol features to document vs \`${reference.predecessorTag ?? 'previous'}\`.`,
      },
      { username: USERNAME }
    )
  }

  const gaps = hardGaps(verdicts)
  const color = isPrerelease
    ? COLOR_WARN
    : gaps.length > 0
      ? COLOR_FAIL
      : COLOR_OK

  const icon = isPrerelease
    ? ':warning:'
    : gaps.length > 0
      ? ':red_circle:'
      : ':white_check_mark:'
  const verb = isPrerelease
    ? `pre-release \`${tag}\` — docs should prepare`
    : gaps.length > 0
      ? `\`${tag}\` released — ${gaps.length} feature${gaps.length === 1 ? '' : 's'} not documented on xrpl.org`
      : `\`${tag}\` released — all new features documented on xrpl.org`

  return envelope(
    {
      fallback: `Docs parity report for xrpld ${tag}`,
      color,
      pretext: `${icon} :books: Docs parity: xrpld ${verb}.`,
      text: formatLines(verdicts),
    },
    { username: USERNAME }
  )
}
