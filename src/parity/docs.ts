import type { Reference, FeatureKind } from './reference'
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
 *   documented = page exists AND in sidebars nav AND in common-links
 *   partial    = page exists but nav or common-links registration is absent
 * H1/requiredAmendment mismatches are evidence only — never a downgrade.
 */
function pageVerdict(
  name: string,
  kind: DocFeatureKind,
  page: string | null,
  pagePath: string,
  sidebars: string,
  commonLinks: string,
  linkRefRes: RegExp[]
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

  const level: DocLevel =
    checks.inNav && checks.inCommonLinks ? 'documented' : 'partial'
  return { name, kind, level, checks, evidence }
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
  commonLinks: string
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
    ]
  )
  if (isPseudo) verdict.checks.isPseudo = true
  return verdict
}

/** Ledger-entry page check. Accepts `[L entry]:` or the legacy `[L object]:`. */
export function checkLedgerEntryPage(
  name: string,
  page: string | null,
  sidebars: string,
  commonLinks: string
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
    ]
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
