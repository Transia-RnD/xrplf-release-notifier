import type { Reference, FieldSpec } from './reference'
import { requiredFields } from './reference'
import { commonDocFields } from './docs'
import {
  typeSections,
  extractFlags,
  extractResultCodes,
  extractSpecFieldNames,
  splitSections,
  REQUIRED_PREAMBLE_KEYS,
} from './xls'
import type { Spec, SpecMatch, TypeSection } from './xls'
import type { InProgressPR } from './runSdkAgent'

/**
 * The XLS-parity verdicts. Three independent families, all deterministic:
 *
 *   C — coverage & status. Does the amendment have a spec, and do the spec's
 *       status and the amendment's Supported flag agree? These are XLS-1's own
 *       rules (§3.1 "every feature amendment must have an XLS"; §4 "the XLS can
 *       only be considered Final once the rippled PR has been merged"), not
 *       house style.
 *
 *   D — surface drift. Does the spec describe the surface the code defines?
 *       The load-bearing subtlety: a spec that AMENDS an existing type lists
 *       only the fields it changes (XLS-85 lists exactly `Amount` for
 *       EscrowCreate), so "the format has a field the spec doesn't mention" is
 *       only a finding for a type the spec fully DEFINES — detected by the spec
 *       carrying a row for every SoeRequired field. The other direction (the
 *       spec names something the code doesn't have) is always a finding.
 *
 *   P — process lint (XLS-1 §4/§4.3), run on the scheduled sweep only.
 */

export type XlsLevel = 'aligned' | 'drifted' | 'missing' | 'exempt' | 'unknown'

export type FindingKind =
  | 'coverage'
  | 'status'
  | 'type'
  | 'field'
  | 'flag'
  | 'result-code'
  | 'process'

/** high = contradiction between spec and code; medium = gap; info = context. */
export type Severity = 'high' | 'medium' | 'info'

export interface XlsFinding {
  kind: FindingKind
  severity: Severity
  message: string
}

export interface XlsVerdict {
  amendment: string
  votable: boolean
  spec?: {
    number: number
    dir: string
    path: string
    status: string
    category: string
  }
  /** Which resolution rule linked this amendment to its spec. */
  via?: string
  level: XlsLevel
  findings: XlsFinding[]
  inProgressPR?: InProgressPR | null
}

/** Spec statuses that mean "this is still being written". */
const IN_PROGRESS_STATUSES = new Set(['Idea', 'Proposal', 'Draft', 'Stagnant'])
/** Statuses that mean the spec is off the table. */
const RETIRED_STATUSES = new Set(['Withdrawn', 'Deprecated'])

export interface CoverageOptions {
  /** Amendments exempt from §3.1 because they predate the XLS process. */
  legacy: Set<string>
}

/**
 * C — coverage and status agreement for one amendment. `fix*` and legacy
 * amendments short-circuit to `exempt`: §3.1 requires a spec for FEATURE
 * amendments, and bug fixes and pre-process amendments are neither.
 */
export function checkCoverage(
  match: SpecMatch,
  opts: CoverageOptions
): XlsVerdict {
  const base: XlsVerdict = {
    amendment: match.amendment,
    votable: match.votable,
    via: match.via,
    level: 'aligned',
    findings: [],
  }

  if (
    match.isFix ||
    opts.legacy.has(match.amendment) ||
    opts.legacy.has(match.base)
  ) {
    return { ...base, level: 'exempt' }
  }

  if (!match.spec) {
    return {
      ...base,
      level: 'missing',
      findings: [
        {
          kind: 'coverage',
          severity: 'high',
          message:
            'no XLS spec resolved — XLS-1 §3.1 requires an XLS for every feature amendment',
        },
      ],
    }
  }

  const { preamble, number, dir, path } = match.spec
  const verdict: XlsVerdict = {
    ...base,
    spec: {
      number,
      dir,
      path,
      status: preamble.status,
      category: preamble.category,
    },
  }
  const findings: XlsFinding[] = []

  if (preamble.category !== 'Amendment') {
    findings.push({
      kind: 'status',
      severity: 'info',
      message: `spec is category \`${preamble.category}\` while an amendment of this name ships`,
    })
  }

  if (RETIRED_STATUSES.has(preamble.status) && match.votable) {
    findings.push({
      kind: 'status',
      severity: 'high',
      message: `spec is \`${preamble.status}\` but the amendment is votable`,
    })
  } else if (IN_PROGRESS_STATUSES.has(preamble.status) && match.votable) {
    findings.push({
      kind: 'status',
      severity: 'medium',
      message: `amendment is votable but the spec is \`${preamble.status}\` — XLS-1 §4: Final once the rippled PR has merged`,
    })
  } else if (preamble.status === 'Final' && !match.votable) {
    findings.push({
      kind: 'status',
      severity: 'info',
      message: 'spec is `Final` while the amendment ships `Supported::No`',
    })
  }

  return {
    ...verdict,
    level: findings.some((f) => f.severity !== 'info') ? 'drifted' : 'aligned',
    findings,
  }
}

export interface DriftInput {
  spec: Spec
  reference: Reference
  /** Result codes named in the transactors of the types this spec covers. */
  transactorCodes?: Set<string>
  /** Types whose transactor source could not be located (codes unverifiable). */
  unresolvedTransactors?: string[]
  /**
   * Types this release INTRODUCES. Only for a type the spec introduces can we
   * say the spec's table is meant to be complete, so only there does an omitted
   * format field carry weight. Empty on a full sweep, where no delta exists.
   */
  introducedTypes?: Set<string>
}

/**
 * D — everything the spec says about the protocol surface, checked against the
 * macros. Returns findings only; the caller folds them into the verdict.
 */
export function checkDrift(input: DriftInput): XlsFinding[] {
  const { spec, reference } = input
  const txTypes = new Set(reference.full.transactionTypes)
  const ledgerTypes = new Set(reference.full.ledgerEntryTypes)
  const sections = typeSections(spec.body, txTypes, ledgerTypes).map((s) =>
    resolveKind(s, reference)
  )

  return [
    ...checkUndefinedTypes(spec, reference, txTypes, ledgerTypes),
    ...sections.flatMap((s) => checkSectionFields(s, reference, input)),
    ...checkSpecFlags(spec, sections, reference, input),
    ...checkSpecResultCodes(spec, reference, input),
  ]
}

/** A type section pinned to one format. */
interface ResolvedSection extends TypeSection {
  kind: 'transactionType' | 'ledgerEntryType'
}

/**
 * Pin an ambiguous name (`DepositPreauth` is both a transaction and a ledger
 * entry) to the format that actually explains the section's field table.
 */
function resolveKind(
  section: TypeSection,
  reference: Reference
): ResolvedSection {
  if (section.kinds.length === 1) {
    return { ...section, kind: section.kinds[0] }
  }
  const documented = specFieldNames(section)
  const score = (kind: 'transactionType' | 'ledgerEntryType'): number => {
    const spec = formatFields(reference, kind, section.name) ?? []
    return spec.filter((f) => documented.has(f.name)).length
  }
  const best = [...section.kinds].sort((a, b) => score(b) - score(a))[0]
  return { ...section, kind: best }
}

function formatFields(
  reference: Reference,
  kind: 'transactionType' | 'ledgerEntryType',
  name: string
): FieldSpec[] | undefined {
  const source =
    kind === 'transactionType'
      ? reference.full.txFields
      : reference.full.ledgerEntryFields
  return source?.[name]
}

// A heading whose entire text (after section numbering) is one backticked
// identifier is the form these specs use to DEFINE a type.
const TYPE_HEADING_RE = /^[\d.\s]*`([A-Z][A-Za-z0-9_]*)`\s*$/
/** Flag naming prefixes — never field names, whatever table they appear in. */
const FLAG_PREFIX_RE = /^(?:tf|lsf|asf|tmf|lsmf)[A-Z]/

/**
 * A `### \`Name\`` heading naming something the protocol has no type, field or
 * flag for. Specs use that heading form for fields and flag values too, so
 * anything the protocol knows under any of those names is excluded — what's
 * left is a name the code simply doesn't have. On a spec that is still Draft
 * this is expected (the spec leads the code), so it only carries weight once
 * the spec is Final.
 */
function checkUndefinedTypes(
  spec: Spec,
  reference: Reference,
  txTypes: Set<string>,
  ledgerTypes: Set<string>
): XlsFinding[] {
  const known = new Set([
    ...txTypes,
    ...ledgerTypes,
    ...reference.full.fields,
    ...(reference.full.flags?.allFlags ?? []),
  ])
  const named = new Set<string>()
  for (const section of splitSections(spec.body)) {
    const m = TYPE_HEADING_RE.exec(section.rawHeading)
    // ALL-CAPS headings are flag VALUES (`### `ALLORNOTHING``), not identifiers.
    if (m && !known.has(m[1]) && !/^[A-Z0-9_]+$/.test(m[1])) named.add(m[1])
  }
  return [...named].map((name) => ({
    kind: 'type' as const,
    severity: spec.preamble.status === 'Final' ? 'medium' : 'info',
    message: `defines \`${name}\`, which the protocol declares as no type, field or flag`,
  }))
}

/** Macro field spec for a type, or undefined when the ref predates field specs. */
function fieldSpecFor(
  section: ResolvedSection,
  reference: Reference
): FieldSpec[] | undefined {
  return formatFields(reference, section.kind, section.name)
}

/**
 * Field names a section's tables document. Flag tables share the row shape, so
 * flag-prefixed and lowercase names are excluded — those belong to the flag
 * check, not this one.
 */
function specFieldNames(section: TypeSection): Set<string> {
  return new Set(
    extractSpecFieldNames(section.body).filter(
      (n) => /^[A-Z]/.test(n) && !FLAG_PREFIX_RE.test(n)
    )
  )
}

/**
 * A spec section fully DEFINES its type when it documents every required
 * field — that is what separates "here is the new Vault object" from "these
 * are the two fields EscrowCreate gains".
 */
function isFullDefinition(
  documented: Set<string>,
  spec: FieldSpec[],
  common: Set<string>
): boolean {
  const required = requiredFields(spec).filter((f) => !common.has(f))
  return required.length > 0 && required.every((f) => documented.has(f))
}

function checkSectionFields(
  section: ResolvedSection,
  reference: Reference,
  input: DriftInput
): XlsFinding[] {
  const spec = fieldSpecFor(section, reference)
  if (!spec || spec.length === 0) return []

  const documented = specFieldNames(section)
  if (documented.size === 0) return []

  const common = commonDocFields(section.kind)
  const specNames = new Set(spec.map((f) => f.name))
  const knownFields = new Set(reference.full.fields)
  const findings: XlsFinding[] = []

  const innerMembers = new Set(reference.full.innerObjectFields ?? [])
  for (const name of documented) {
    if (specNames.has(name) || common.has(name)) continue
    // A member of an inner-object template documented under its container is a
    // nested-object row, not a misplaced field.
    if (innerMembers.has(name)) continue
    findings.push(
      knownFields.has(name)
        ? {
            kind: 'field',
            severity: 'medium',
            message: `documents \`${name}\` under \`${section.name}\`, but that format doesn't include it`,
          }
        : {
            kind: 'field',
            severity:
              input.spec.preamble.status === 'Final' ? 'high' : 'medium',
            message: `names field \`${name}\` under \`${section.name}\`, which the protocol doesn't define`,
          }
    )
  }

  if (isFullDefinition(documented, spec, common)) {
    const omitted = spec
      .map((f) => f.name)
      .filter((n) => !documented.has(n) && !common.has(n))
    if (omitted.length > 0) {
      findings.push({
        kind: 'field',
        // A spec that merely amends an existing type is entitled to list only
        // what it changes, and we can only tell the two apart for a type the
        // release actually introduces.
        severity: input.introducedTypes?.has(section.name) ? 'medium' : 'info',
        message: `defines \`${section.name}\` but omits ${list(omitted, 6)}`,
      })
    }
  }

  return findings
}

/**
 * Flags are checked SPEC-WIDE, not per type: a failure-condition paragraph
 * legitimately cites flags owned by other objects (XLS-85's EscrowCreate rules
 * turn on AccountRoot's `lsfAllowTrustLineLocking`), so type-scoping them would
 * report every cross-reference as drift. A flag name that exists nowhere in the
 * protocol is unambiguous drift; a missing flag is only reported for a type the
 * spec fully defines.
 */
function checkSpecFlags(
  spec: Spec,
  sections: ResolvedSection[],
  reference: Reference,
  input: DriftInput
): XlsFinding[] {
  const flags = reference.full.flags
  if (!flags || flags.allFlags.length === 0) return []

  const known = new Set(flags.allFlags)
  const named = new Set(extractFlags(spec.body))
  const findings: XlsFinding[] = [...named]
    .filter((f) => !known.has(f))
    .map((f) => ({
      kind: 'flag' as const,
      // Same reasoning as undefined types: until the spec is Final, naming a
      // flag the code lacks is the spec leading the implementation.
      severity: spec.preamble.status === 'Final' ? 'high' : 'medium',
      message: `names flag \`${f}\`, which the protocol doesn't define`,
    }))

  for (const section of sections) {
    if (!input.introducedTypes?.has(section.name)) continue
    const fieldSpec = fieldSpecFor(section, reference)
    const documented = specFieldNames(section)
    if (
      !fieldSpec ||
      !isFullDefinition(documented, fieldSpec, commonDocFields(section.kind))
    ) {
      continue
    }
    const owned =
      section.kind === 'transactionType'
        ? (flags.txFlags[section.name] ?? [])
        : (flags.ledgerFlags[section.name] ?? [])
    const omitted = owned.filter((f) => !named.has(f))
    if (omitted.length > 0) {
      findings.push({
        kind: 'flag',
        severity: 'medium',
        message: `defines \`${section.name}\` but doesn't document ${list(omitted, 5)}`,
      })
    }
  }

  return findings
}

/**
 * Result codes, in two tiers.
 *
 * Tier 1 — a code TER.h doesn't define at all is a typo or a rename the spec
 * never followed (`tecOBJECT_NO_FOUND`, `terFROZEN`). Unambiguous, so it is a
 * real finding.
 *
 * Tier 2 — a valid code that never appears in the transactor sources. This one
 * cannot be decided here: transactors return plenty of codes through shared
 * helpers this layer never reads, so "absent from these files" is not "the
 * transaction can't produce it". It is reported as an `info` hint naming what
 * was actually searched, and confirming it is the semantic pass's job.
 */
function checkSpecResultCodes(
  spec: Spec,
  reference: Reference,
  input: DriftInput
): XlsFinding[] {
  const cited = extractResultCodes(spec.body)
  if (cited.length === 0) return []

  const findings: XlsFinding[] = []
  const defined = reference.full.resultCodes
  if (defined && defined.length > 0) {
    const known = new Set(defined)
    for (const code of cited.filter((c) => !known.has(c))) {
      findings.push({
        kind: 'result-code',
        severity: 'high',
        message: `cites \`${code}\`, which is not a result code TER.h defines`,
      })
    }
  }

  const { transactorCodes } = input
  if (transactorCodes && transactorCodes.size > 0) {
    const known = new Set(defined ?? [])
    const unreturned = cited.filter(
      (c) => known.has(c) && !transactorCodes.has(c)
    )
    if (unreturned.length > 0) {
      findings.push({
        kind: 'result-code',
        severity: 'info',
        message: `documents ${list(unreturned, 5)} — not found in the transactor sources (may come from a shared helper)`,
      })
    }
  }

  return findings
}

// --- P: process lint (XLS-1 §4, §4.3) ---------------------------------------

const MAX_TITLE = 44
const MAX_DESCRIPTION = 140
/** Sections XLS-1 §4.3 requires of every Draft and beyond. */
const REQUIRED_SECTIONS = [
  'Abstract',
  'Specification',
  'Security Considerations',
]
const RIPPLED_LINK_RE =
  /github\.com\/(?:XRPLF|ripple)\/(?:rippled|xrpld)\/(?:pull|commit)\//i
/** §4: a Draft untouched for six months should be Stagnant. */
const STAGNANT_AFTER_DAYS = 182

export interface ProcessLintInput {
  spec: Spec
  /** ISO date of the last commit touching the spec directory. */
  lastCommit?: string | null
  /** Reference point for the staleness window; defaults to now. */
  now?: Date
}

export function lintProcess(input: ProcessLintInput): XlsFinding[] {
  const { spec, lastCommit } = input
  const { preamble } = spec
  const findings: XlsFinding[] = []
  const process = (severity: Severity, message: string): void => {
    findings.push({ kind: 'process', severity, message })
  }

  if (preamble.missing) {
    process('high', 'no `<pre>` preamble block (XLS-1 §4.3.1)')
    return findings
  }

  const beyondProposal = !['Idea', 'Proposal', 'Unknown'].includes(
    preamble.status
  )
  if (preamble.xls === undefined && beyondProposal) {
    process('medium', 'no `xls:` header — numbers are assigned at Draft (§4)')
  } else if (preamble.xls !== undefined && preamble.xls !== spec.number) {
    process(
      'medium',
      `\`xls: ${preamble.xls}\` disagrees with directory \`${spec.dir}\``
    )
  }

  if ((preamble.title?.length ?? 0) > MAX_TITLE) {
    process(
      'info',
      `title is ${preamble.title?.length} chars (§4.3.1 limit ${MAX_TITLE})`
    )
  }
  if ((preamble.description?.length ?? 0) > MAX_DESCRIPTION) {
    process(
      'info',
      `description is ${preamble.description?.length} chars (§4.3.1 limit ${MAX_DESCRIPTION})`
    )
  }

  const present = preamble.keyOrder.filter((k) =>
    (REQUIRED_PREAMBLE_KEYS as readonly string[]).includes(k)
  )
  const expected = REQUIRED_PREAMBLE_KEYS.filter((k) => present.includes(k))
  if (present.join(',') !== expected.join(',')) {
    process(
      'info',
      `preamble headers out of §4.3.1 order: ${present.join(', ')}`
    )
  }

  if (beyondProposal) {
    const headings = splitSections(spec.body).map((s) =>
      s.heading.toLowerCase()
    )
    const missing = REQUIRED_SECTIONS.filter(
      (s) => !headings.some((h) => h.includes(s.toLowerCase()))
    )
    if (missing.length > 0) {
      const security = missing.includes('Security Considerations')
      process(
        preamble.status === 'Final' && security ? 'medium' : 'info',
        `missing required section(s): ${missing.join(', ')} (§4.3)`
      )
    }
  }

  if (
    preamble.status === 'Final' &&
    (preamble.category === 'Amendment' || preamble.category === 'System') &&
    !RIPPLED_LINK_RE.test(spec.body)
  ) {
    process(
      'medium',
      '`Final` but links no rippled PR/commit (§4.3 Reference Implementation)'
    )
  }

  if (preamble.status === 'Draft' && lastCommit) {
    const days = Math.floor(
      ((input.now ?? new Date()).getTime() - new Date(lastCommit).getTime()) /
        86_400_000
    )
    if (days > STAGNANT_AFTER_DAYS) {
      process('info', `Draft untouched for ${days} days — §4 says Stagnant`)
    }
  }

  return findings
}

/** Fold drift/lint findings into a coverage verdict. */
export function withFindings(
  verdict: XlsVerdict,
  findings: XlsFinding[]
): XlsVerdict {
  if (findings.length === 0) return verdict
  const all = [...verdict.findings, ...findings]
  const level =
    verdict.level === 'exempt' || verdict.level === 'missing'
      ? verdict.level
      : all.some((f) => f.severity !== 'info')
        ? 'drifted'
        : verdict.level
  return { ...verdict, level, findings: all }
}

function list(names: string[], cap: number): string {
  const shown = names.slice(0, cap).map((n) => `\`${n}\``)
  const more = names.length - shown.length
  return shown.join(', ') + (more > 0 ? ` (+${more} more)` : '')
}
