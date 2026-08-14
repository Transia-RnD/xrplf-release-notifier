import { envelope } from '../notifications/mattermost'
import type { MattermostPayload } from '../notifications/mattermost'
import { VersionType } from '../version/types'
import type { Reference } from './reference'
import type { XlsVerdict, XlsFinding, Severity } from './xlsChecks'

/**
 * Renders XLS-parity verdicts into a Mattermost post. Severity follows the
 * other two parity reports: a prerelease is a heads-up, a FINAL that ships an
 * amendment contradicting its own approved specification is the loud signal.
 * `info` findings are context and never drive colour.
 */

const USERNAME = 'xls parity'
const COLOR_OK = '#4CAF50'
const COLOR_WARN = '#FF9800'
const COLOR_FAIL = '#F44336'
const COLOR_NEUTRAL = '#9E9E9E'

/** Max verdict lines before truncating. */
const MAX_LINES = 12
/** Max findings shown per verdict — the rest are counted. */
const MAX_FINDINGS = 4

const SEVERITY_ICON: Record<Severity, string> = {
  high: '🔴',
  medium: '🟠',
  info: '⚪',
}

export interface FormatXlsReportInput {
  versionType: VersionType
  reference: Reference
  verdicts: XlsVerdict[]
  mode: 'delta' | 'full'
  xlsRepo: string
  /** Specs the sweep read but could not tie to any amendment (full mode). */
  orphanSpecs?: { number: number; dir: string; status: string }[]
}

function actionable(findings: XlsFinding[]): XlsFinding[] {
  return findings.filter((f) => f.severity !== 'info')
}

/** Verdicts worth acting on: an unspecified amendment, or real contradictions. */
function gaps(verdicts: XlsVerdict[]): XlsVerdict[] {
  return verdicts.filter(
    (v) => v.level === 'missing' || actionable(v.findings).length > 0
  )
}

function worstSeverity(v: XlsVerdict): number {
  if (v.findings.some((f) => f.severity === 'high')) return 0
  if (v.findings.some((f) => f.severity === 'medium')) return 1
  return 2
}

function specLabel(v: XlsVerdict): string {
  return v.spec
    ? `XLS-${v.spec.number} (${v.spec.status})`
    : '_no spec resolved_'
}

function line(v: XlsVerdict): string {
  const shown = v.findings.slice(0, MAX_FINDINGS)
  const more = v.findings.length - shown.length
  const detail = shown.map((f) => `${SEVERITY_ICON[f.severity]} ${f.message}`)
  if (more > 0) detail.push(`…and ${more} more`)
  const pr = v.inProgressPR ? ` — PR #${v.inProgressPR.number} in progress` : ''
  const head = `**\`${v.amendment}\`** → ${specLabel(v)}${pr}`
  return detail.length > 0
    ? `${head}\n${detail.map((d) => `  · ${d}`).join('\n')}`
    : head
}

function formatLines(verdicts: XlsVerdict[]): string {
  const sorted = [...verdicts].sort(
    (a, b) => worstSeverity(a) - worstSeverity(b)
  )
  const lines = sorted.slice(0, MAX_LINES).map(line)
  if (sorted.length > MAX_LINES) {
    lines.push(`…and ${sorted.length - MAX_LINES} more`)
  }
  return lines.join('\n')
}

function countFindings(verdicts: XlsVerdict[], severity: Severity): number {
  return verdicts.reduce(
    (n, v) => n + v.findings.filter((f) => f.severity === severity).length,
    0
  )
}

function formatFullReport(input: FormatXlsReportInput): MattermostPayload {
  const { reference, verdicts, xlsRepo, orphanSpecs } = input
  const checked = verdicts.filter((v) => v.level !== 'exempt')
  const withSpec = checked.filter((v) => v.spec !== undefined)
  const open = gaps(checked)

  const summary =
    `amendments checked: ${checked.length} · specified: ${withSpec.length}/${checked.length} · ` +
    `contradictions: ${countFindings(checked, 'high')} · gaps: ${countFindings(checked, 'medium')}`

  const sections = [
    open.length > 0 ? formatLines(open) : '_no spec contradicts the code_',
  ]
  if (orphanSpecs && orphanSpecs.length > 0) {
    const shown = orphanSpecs
      .slice(0, 8)
      .map((s) => `\`XLS-${s.number}\` (${s.status})`)
      .join(', ')
    const more = orphanSpecs.length - Math.min(orphanSpecs.length, 8)
    sections.push(
      `\n_Amendment specs with no amendment of that name in \`features.macro\` ` +
        `(retired, renamed, or unimplemented — review, not a gap):_ ${shown}` +
        (more > 0 ? ` (+${more} more)` : '')
    )
  }

  return envelope(
    {
      fallback: `Full XLS parity audit vs xrpld ${reference.tag}`,
      color: open.length > 0 ? COLOR_WARN : COLOR_OK,
      pretext: `:scroll: Full XLS spec audit of \`${xlsRepo}\` vs xrpld \`${reference.tag}\` — ${summary}.`,
      text: sections.join('\n'),
    },
    { username: USERNAME }
  )
}

export function formatXlsReport(
  input: FormatXlsReportInput
): MattermostPayload {
  if (input.mode === 'full') return formatFullReport(input)

  const { versionType, reference, verdicts } = input
  const tag = reference.tag
  const checked = verdicts.filter((v) => v.level !== 'exempt')

  if (checked.length === 0) {
    return envelope(
      {
        fallback: `XLS parity: xrpld ${tag} — nothing to check`,
        color: COLOR_NEUTRAL,
        pretext: `:scroll: XLS parity — xrpld \`${tag}\` adds no feature amendment vs \`${reference.predecessorTag ?? 'previous'}\`.`,
      },
      { username: USERNAME }
    )
  }

  const open = gaps(checked)
  const isPrerelease =
    versionType === VersionType.BETA || versionType === VersionType.RC
  const color = isPrerelease
    ? COLOR_WARN
    : open.length > 0
      ? COLOR_FAIL
      : COLOR_OK
  const icon = isPrerelease
    ? ':warning:'
    : open.length > 0
      ? ':red_circle:'
      : ':white_check_mark:'
  const verb = isPrerelease
    ? `pre-release \`${tag}\` — specs should catch up`
    : open.length > 0
      ? `\`${tag}\` released — ${open.length} amendment${open.length === 1 ? '' : 's'} out of step with ${open.length === 1 ? 'its' : 'their'} XLS`
      : `\`${tag}\` released — every new amendment matches its XLS`

  return envelope(
    {
      fallback: `XLS parity report for xrpld ${tag}`,
      color,
      pretext: `${icon} :scroll: XLS parity: xrpld ${verb}.`,
      text: formatLines(open.length > 0 ? open : checked),
    },
    { username: USERNAME }
  )
}
