import type { Reference, FeatureKind, FieldSpec } from './reference'
import type { InProgressPR } from './runSdkAgent'

/**
 * Pure string-analysis layer for the xrpl.org documentation-parity check.
 * The dev-portal's conventions are rigid enough that parity is decided
 * DETERMINISTICALLY from fetched file contents — no agent:
 *   - transaction T   -> docs/references/protocol/transactions/types/<lower(T)>.md
 *                        (pseudo-transactions under pseudo-transaction-types/),
 *                        registered as `page: <path>` in sidebars.yaml, with a
 *                        `[T transaction]:` link-ref in docs/_snippets/common-links.md
 *   - ledger entry L  -> docs/references/protocol/ledger-data/ledger-entry-types/
 *                        <lower(L)>.md, same nav check, `[L entry]:` or legacy
 *                        `[L object]:` link-ref
 *   - amendment A     -> entry in resources/known-amendments.md: `### A` heading,
 *                        `[A]: #<lower(A)>` anchor, an `| Amendment ID |` row;
 *                        unreleased amendments appear only in the
 *                        "Amendments in Development" table
 *   - field F         -> a `F` table row inside the owning tx/ledger page or a
 *                        common-fields page (no machine-readable index exists,
 *                        so field checks are best-effort: `unknown`, never `missing`)
 */

export type DocFeatureKind = FeatureKind | 'amendment'

export type DocLevel = 'documented' | 'partial' | 'missing' | 'unknown'

export interface DocFeature {
  name: string
  kind: DocFeatureKind
  /** Amendments only: Supported::Yes (votable) vs Supported::No (in development). */
  votable?: boolean
}

/** Per-check outcomes — structured evidence behind each verdict. */
export interface DocChecks {
  pageExists?: boolean
  /** Page found under pseudo-transaction-types/ rather than types/. */
  isPseudo?: boolean
  /** `page: <path>` present in sidebars.yaml. */
  inNav?: boolean
  /** Link-ref present in docs/_snippets/common-links.md. */
  inCommonLinks?: boolean
  /** Page H1 equals the exact feature name. */
  h1Matches?: boolean
  /** Frontmatter carries `requiredAmendment:`. */
  hasRequiredAmendment?: boolean
  /** known-amendments.md: `### <name>` heading. */
  headingPresent?: boolean
  /** known-amendments.md: `[<name>]: #<lower(name)>` anchor line. */
  anchorPresent?: boolean
  /** known-amendments.md: `| Amendment ID |` row inside the amendment's section. */
  idRowPresent?: boolean
  /** known-amendments.md: row in the "Amendments in Development" table. */
  inDevelopmentTable?: boolean
  /** Fields: pages where a `<name>` table row matched. */
  foundIn?: string[]
  /** Format fields (from the macro spec) with no table row on the page. */
  missingFields?: string[]
  /** Table-row fields on the page that the format doesn't define (drift). */
  extraFields?: string[]
}

export interface DocVerdict {
  name: string
  kind: DocFeatureKind
  level: DocLevel
  checks: DocChecks
  evidence: string[]
  inProgressPR?: InProgressPR | null
}

export const TX_DIR = 'docs/references/protocol/transactions/types'
export const PSEUDO_TX_DIR =
  'docs/references/protocol/transactions/pseudo-transaction-types'
export const LEDGER_DIR =
  'docs/references/protocol/ledger-data/ledger-entry-types'
export const KNOWN_AMENDMENTS_PATH = 'resources/known-amendments.md'
export const SIDEBARS_PATH = 'sidebars.yaml'
export const COMMON_LINKS_PATH = 'docs/_snippets/common-links.md'
export const TX_COMMON_FIELDS_PATH =
  'docs/references/protocol/transactions/common-fields.md'
export const LEDGER_COMMON_FIELDS_PATH =
  'docs/references/protocol/ledger-data/common-fields.md'

export function txPagePath(name: string): string {
  return `${TX_DIR}/${name.toLowerCase()}.md`
}

export function pseudoTxPagePath(name: string): string {
  return `${PSEUDO_TX_DIR}/${name.toLowerCase()}.md`
}

export function ledgerPagePath(name: string): string {
  return `${LEDGER_DIR}/${name.toLowerCase()}.md`
}

/**
 * Delta checklist for a release: everything `added` (transactions, ledger
 * entries AND fields — docs cover all three, unlike the SDK checklist) plus
 * both amendment lists. Empty when there's no predecessor baseline.
 */
export function docsChecklist(reference: Reference): DocFeature[] {
  if (reference.baselineMissing) return []
  return [
    ...reference.added.map((f): DocFeature => ({ name: f.name, kind: f.kind })),
    ...reference.addedAmendments.map(
      (n): DocFeature => ({ name: n, kind: 'amendment', votable: true })
    ),
    ...reference.addedUnsupportedAmendments.map(
      (n): DocFeature => ({ name: n, kind: 'amendment', votable: false })
    ),
  ]
}

/**
 * Full backlog sweep: every transaction type, ledger entry type, and amendment
 * the ref defines. Fields are excluded — auditing them would require fetching
 * every page for a low-signal dimension.
 */
export function fullDocsChecklist(reference: Reference): DocFeature[] {
  const { full } = reference
  return [
    ...full.transactionTypes.map(
      (n): DocFeature => ({ name: n, kind: 'transactionType' })
    ),
    ...full.ledgerEntryTypes.map(
      (n): DocFeature => ({ name: n, kind: 'ledgerEntryType' })
    ),
    ...full.amendments.map(
      (n): DocFeature => ({ name: n, kind: 'amendment', votable: true })
    ),
    ...full.unsupportedAmendments.map(
      (n): DocFeature => ({ name: n, kind: 'amendment', votable: false })
    ),
  ]
}

/**
 * Common fields every transaction carries — documented centrally on
 * transactions/common-fields.md (included via a snippet), so their presence on
 * an individual page is neither required nor drift.
 */
const COMMON_TX_DOC_FIELDS = new Set([
  'Account',
  'AccountTxnID',
  'Delegate',
  'Fee',
  'Flags',
  'LastLedgerSequence',
  'Memos',
  'NetworkID',
  'SigningPubKey',
  'Signers',
  'Sequence',
  'SourceTag',
  'TicketSequence',
  'TransactionType',
  'TxnSignature',
])

/** Ledger-entry commons — the whole of ledger-data/common-fields.md. */
const COMMON_LE_DOC_FIELDS = new Set([
  'LedgerEntryType',
  'Flags',
  'index',
  'LedgerIndex',
])

export function commonDocFields(kind: DocFeatureKind): Set<string> {
  return kind === 'ledgerEntryType'
    ? COMMON_LE_DOC_FIELDS
    : COMMON_TX_DOC_FIELDS
}

/**
 * Field names documented as Markdown table rows. Matches both the plain and
 * the linked first-cell forms:  `| \`Name\` |`  and  `| [\`Name\`](...) |`.
 */
export function extractDocFieldNames(page: string): string[] {
  const out: string[] = []
  for (const m of page.matchAll(/^\|\s*\[?`([A-Za-z0-9_]+)`/gm)) {
    out.push(m[1])
  }
  return [...new Set(out)]
}

export interface FieldAlignment {
  /** Spec fields with no table row on the page. */
  missing: string[]
  /** Page table rows naming fields the spec doesn't define (excl. commons). */
  extra: string[]
}

export interface FieldTableOptions {
  /** Fields documented centrally (common-fields pages) — never missing/drift. */
  common?: Set<string>
  /**
   * Every sfield the protocol currently defines. A documented name that IS a
   * real sfield but not in this type's spec is a nested-object member (e.g.
   * SignerEntry rows), not drift — only unknown names get flagged as drift.
   */
  knownFields?: Set<string>
}

/**
 * Diff a page's field table against the type's macro field spec. This is the
 * "do the docs align" check: every field the protocol format defines must
 * appear as a table row on the page that documents the type. Drift (`extra`)
 * is deliberately conservative: uppercase field-shaped names only — flag and
 * result-code tables (tfXxx/asfXxx/lsfXxx/tecXXX rows) never count.
 */
export function checkFieldTable(
  spec: FieldSpec[],
  page: string,
  opts: FieldTableOptions = {}
): FieldAlignment {
  const common = opts.common ?? COMMON_TX_DOC_FIELDS
  const documented = new Set(extractDocFieldNames(page))
  const specNames = new Set(spec.map((f) => f.name))
  return {
    missing: spec
      .map((f) => f.name)
      .filter((n) => !documented.has(n) && !common.has(n)),
    extra: [...documented].filter(
      (n) =>
        /^[A-Z]/.test(n) &&
        !specNames.has(n) &&
        !common.has(n) &&
        !(opts.knownFields?.has(n) ?? false)
    ),
  }
}

function inNav(sidebars: string, pagePath: string): boolean {
  return sidebars.includes(`page: ${pagePath}`)
}

function h1Matches(page: string, name: string): boolean {
  return new RegExp(`^# ${escapeRe(name)}\\s*$`, 'm').test(page)
}

function hasRequiredAmendment(page: string): boolean {
  return /^requiredAmendment:/m.test(page)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Verdict for a page-backed feature (transaction or ledger entry):
 *   missing    = no page at the conventional path
 *   documented = page exists AND in nav AND in common-links AND (when the
 *                type's macro field spec is known) its field table carries a
 *                row for every format field
 *   partial    = page exists but a registration or a spec field is absent
 * H1/requiredAmendment mismatches and extra (drifted) doc fields are evidence
 * only — never a downgrade.
 */
function pageVerdict(
  name: string,
  kind: DocFeatureKind,
  page: string | null,
  pagePath: string,
  sidebars: string,
  commonLinks: string,
  linkRefRes: RegExp[],
  spec?: FieldSpec[],
  knownFields?: Set<string>
): DocVerdict {
  const checks: DocChecks = { pageExists: page !== null }
  const evidence: string[] = []

  if (page === null) {
    evidence.push(`no page at ${pagePath}`)
    return { name, kind, level: 'missing', checks, evidence }
  }

  checks.inNav = inNav(sidebars, pagePath)
  checks.inCommonLinks = linkRefRes.some((re) => re.test(commonLinks))
  checks.h1Matches = h1Matches(page, name)
  checks.hasRequiredAmendment = hasRequiredAmendment(page)

  if (!checks.inNav) evidence.push('page exists but not in sidebars.yaml nav')
  if (!checks.inCommonLinks)
    evidence.push('no link-ref in _snippets/common-links.md')
  if (!checks.h1Matches) evidence.push(`H1 does not match \`${name}\``)

  let aligned = true
  if (spec && spec.length > 0) {
    const { missing, extra } = checkFieldTable(spec, page, {
      common: commonDocFields(kind),
      knownFields,
    })
    checks.missingFields = missing
    checks.extraFields = extra
    if (missing.length > 0) {
      aligned = false
      evidence.push(`field table missing: ${listCapped(missing, 6)}`)
    }
    if (extra.length > 0) {
      evidence.push(
        `documents fields the format doesn't define: ${listCapped(extra, 4)}`
      )
    }
  }

  const level: DocLevel =
    checks.inNav && checks.inCommonLinks && aligned ? 'documented' : 'partial'
  return { name, kind, level, checks, evidence }
}

function listCapped(names: string[], cap: number): string {
  const shown = names.slice(0, cap).map((n) => `\`${n}\``)
  const more = names.length - shown.length
  return shown.join(', ') + (more > 0 ? ` (+${more} more)` : '')
}

/**
 * Transaction page check. `page`/`pseudoPage` are the fetched contents of the
 * conventional paths (null = 404). A pseudo-transaction (EnableAmendment,
 * SetFee, UNLModify) lives in its own directory, so a hit there counts.
 */
export function checkTxPage(
  name: string,
  page: string | null,
  pseudoPage: string | null,
  sidebars: string,
  commonLinks: string,
  spec?: FieldSpec[],
  knownFields?: Set<string>
): DocVerdict {
  const isPseudo = page === null && pseudoPage !== null
  const verdict = pageVerdict(
    name,
    'transactionType',
    page ?? pseudoPage,
    isPseudo ? pseudoTxPagePath(name) : txPagePath(name),
    sidebars,
    commonLinks,
    [
      new RegExp(`^\\[${escapeRe(name)} transaction\\]:`, 'm'),
      new RegExp(`^\\[${escapeRe(name)} pseudo-transaction\\]:`, 'm'),
    ],
    spec,
    knownFields
  )
  if (isPseudo) verdict.checks.isPseudo = true
  return verdict
}

/** Ledger-entry page check. Accepts `[L entry]:` or the legacy `[L object]:`. */
export function checkLedgerEntryPage(
  name: string,
  page: string | null,
  sidebars: string,
  commonLinks: string,
  spec?: FieldSpec[],
  knownFields?: Set<string>
): DocVerdict {
  return pageVerdict(
    name,
    'ledgerEntryType',
    page,
    ledgerPagePath(name),
    sidebars,
    commonLinks,
    [
      new RegExp(`^\\[${escapeRe(name)} entry\\]:`, 'm'),
      new RegExp(`^\\[${escapeRe(name)} object\\]:`, 'm'),
    ],
    spec,
    knownFields
  )
}

/**
 * Amendment check against known-amendments.md.
 * Votable (Supported::Yes):
 *   documented = `### A` heading + `[A]: #<lower>` anchor + Amendment ID row,
 *                and NOT still listed in "Amendments in Development"
 *   partial    = entry incomplete (heading without anchor/ID row) or the docs
 *                still list it as in-development after it shipped votable
 *   missing    = no trace on the page
 * Unsupported (Supported::No — built but unvotable): in-development is the
 * CORRECT documented state, so a dev-table row (or a full entry) = documented;
 * absent entirely = missing.
 */
export function checkAmendment(
  name: string,
  votable: boolean,
  knownAmendments: string
): DocVerdict {
  const checks: DocChecks = {}
  const evidence: string[] = []

  checks.headingPresent = new RegExp(`^### ${escapeRe(name)}\\s*$`, 'm').test(
    knownAmendments
  )
  checks.anchorPresent = knownAmendments.includes(
    `[${name}]: #${name.toLowerCase()}`
  )

  // The amendment's own section: from its ### heading to the next ### (or EOF).
  if (checks.headingPresent) {
    const start = knownAmendments.search(
      new RegExp(`^### ${escapeRe(name)}\\s*$`, 'm')
    )
    const rest = knownAmendments.slice(start + 4 + name.length)
    const next = rest.search(/^### /m)
    const section = next === -1 ? rest : rest.slice(0, next)
    checks.idRowPresent = /^\|\s*Amendment ID\s*\|/m.test(section)
  } else {
    checks.idRowPresent = false
  }

  // "Amendments in Development" table: rows between that ## heading and the
  // next ## heading, referencing the amendment as `| [Name][] |` or `| Name |`.
  const devStart = knownAmendments.search(/^## Amendments in Development\s*$/m)
  if (devStart !== -1) {
    const rest = knownAmendments.slice(devStart + 2)
    const next = rest.search(/^## /m)
    const devSection = next === -1 ? rest : rest.slice(0, next)
    // Row cell is `| [Name][] |` (linked) or `| Name |` (plain) — the char
    // after the name must close the link or the cell, so a shorter amendment
    // name never prefix-matches a longer one.
    checks.inDevelopmentTable = new RegExp(
      `^\\|\\s*\\[?${escapeRe(name)}(\\]|\\s*\\|)`,
      'm'
    ).test(devSection)
  } else {
    checks.inDevelopmentTable = false
  }

  const fullEntry =
    checks.headingPresent && checks.anchorPresent && checks.idRowPresent
  const anyTrace =
    checks.headingPresent || checks.anchorPresent || checks.inDevelopmentTable

  let level: DocLevel
  if (!votable) {
    level = anyTrace ? 'documented' : 'missing'
    if (!anyTrace)
      evidence.push(
        'not listed in known-amendments.md (not even as in-development)'
      )
  } else if (!anyTrace) {
    level = 'missing'
    evidence.push('no entry in known-amendments.md')
  } else if (fullEntry && !checks.inDevelopmentTable) {
    level = 'documented'
  } else {
    level = 'partial'
    if (!checks.headingPresent) evidence.push('no `###` entry heading')
    if (checks.headingPresent && !checks.anchorPresent)
      evidence.push('entry heading has no link-ref anchor')
    if (checks.headingPresent && !checks.idRowPresent)
      evidence.push('entry has no Amendment ID row')
    if (checks.inDevelopmentTable)
      evidence.push('still listed under "Amendments in Development"')
  }

  return { name, kind: 'amendment', level, checks, evidence }
}

/**
 * Field check: a `` `F` `` cell in a Markdown table row in any candidate page
 * (the release's new tx/ledger pages plus the two common-fields pages).
 * There is no field index on xrpl.org, so absence only means "not found where
 * we looked" — level `unknown`, which never drives report severity.
 */
export function checkField(
  name: string,
  candidates: { path: string; content: string }[]
): DocVerdict {
  const rowRe = new RegExp(`^\\|.*\`${escapeRe(name)}\`.*\\|`, 'm')
  const foundIn = candidates
    .filter((c) => rowRe.test(c.content))
    .map((c) => c.path)
  const checks: DocChecks = { foundIn }
  if (foundIn.length > 0) {
    return {
      name,
      kind: 'field',
      level: 'documented',
      checks,
      evidence: foundIn.map((p) => `field row in ${p}`),
    }
  }
  return {
    name,
    kind: 'field',
    level: 'unknown',
    checks,
    evidence: [`not found in ${candidates.length} checked page(s)`],
  }
}
