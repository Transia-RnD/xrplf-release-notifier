/**
 * Pure model + mapping layer for the XLS specification-parity check against
 * `XRPLF/XRPL-Standards`.
 *
 * Two hard problems live here, and both are solved deterministically:
 *
 *  1. **Reading a spec.** Every XLS carries an RFC-822 style preamble in a
 *     leading `<pre>` block (XLS-1 §4.3.1) — `xls`, `title`, `description`,
 *     `status`, `category`. The directory name carries the number too, and the
 *     directory is authoritative: four specs currently ship without an `xls:`
 *     header at all.
 *
 *  2. **Amendment -> spec.** `features.macro` carries no XLS number and specs
 *     carry no amendment name, so the link must be resolved. The chain below
 *     runs highest-confidence first and records WHICH rule matched, because a
 *     wrong mapping manufactures a page of fake drift — worse than no mapping.
 *     Anything unresolved is reported as unresolved; nothing is guessed.
 */

export type SpecStatus =
  | 'Idea'
  | 'Proposal'
  | 'Draft'
  | 'Final'
  | 'Living'
  | 'Deprecated'
  | 'Stagnant'
  | 'Withdrawn'
  | 'Unknown'

export type SpecCategory =
  | 'Amendment'
  | 'System'
  | 'Ecosystem'
  | 'Meta'
  | 'Unknown'

const STATUSES: SpecStatus[] = [
  'Idea',
  'Proposal',
  'Draft',
  'Final',
  'Living',
  'Deprecated',
  'Stagnant',
  'Withdrawn',
]
const CATEGORIES: SpecCategory[] = ['Amendment', 'System', 'Ecosystem', 'Meta']

/** Preamble headers in the order XLS-1 §4.3.1 requires them. */
export const REQUIRED_PREAMBLE_KEYS = [
  'xls',
  'title',
  'description',
  'author',
] as const

export interface SpecPreamble {
  /** From the `xls:` header — absent on specs that never got one. */
  xls?: number
  title?: string
  description?: string
  author?: string
  status: SpecStatus
  category: SpecCategory
  /** Header keys in file order — the §4.3.1 ordering check reads this. */
  keyOrder: string[]
  /** True when no `<pre>` preamble block was found at all. */
  missing: boolean
}

export interface Spec {
  /** Directory name, e.g. "XLS-0085-token-escrow". */
  dir: string
  /** Number parsed from the directory name — authoritative over the header. */
  number: number
  /** Slug after the number, e.g. "token-escrow". */
  slug: string
  /** Repo path of the spec body. */
  path: string
  preamble: SpecPreamble
  /** Full README text, preamble included. */
  body: string
}

const SPEC_DIR_RE = /^XLS-(\d{1,4})-(.+)$/

/** Parse "XLS-0085-token-escrow" into its number and slug. Null if not a spec dir. */
export function parseSpecDir(
  dir: string
): { number: number; slug: string } | null {
  const m = SPEC_DIR_RE.exec(dir)
  if (!m) return null
  return { number: parseInt(m[1], 10), slug: m[2] }
}

const PREAMBLE_RE = /<pre>\s*([\s\S]*?)<\/pre>/i
const HEADER_RE = /^\s*([A-Za-z-]+)\s*:\s*(.*)$/

/**
 * Parse the leading `<pre>` preamble. Continuation lines (a wrapped
 * description) append to the previous header's value, matching how the specs
 * are actually written.
 */
export function parsePreamble(readme: string): SpecPreamble {
  const block = PREAMBLE_RE.exec(readme)
  if (!block) {
    return {
      status: 'Unknown',
      category: 'Unknown',
      keyOrder: [],
      missing: true,
    }
  }

  const raw: Record<string, string> = {}
  const keyOrder: string[] = []
  let lastKey: string | null = null
  for (const line of block[1].split('\n')) {
    const m = HEADER_RE.exec(line)
    if (m) {
      lastKey = m[1].toLowerCase()
      raw[lastKey] = m[2].trim()
      keyOrder.push(lastKey)
    } else if (lastKey && line.trim().length > 0) {
      raw[lastKey] = `${raw[lastKey]} ${line.trim()}`.trim()
    }
  }

  const xlsNumber = /^\d+$/.test(raw.xls ?? '')
    ? parseInt(raw.xls, 10)
    : undefined
  return {
    xls: xlsNumber,
    title: raw.title,
    description: raw.description,
    author: raw.author,
    status: matchEnum(raw.status, STATUSES, 'Unknown'),
    category: matchEnum(raw.category, CATEGORIES, 'Unknown'),
    keyOrder,
    missing: false,
  }
}

function matchEnum<T extends string>(
  value: string | undefined,
  allowed: T[],
  fallback: T
): T {
  const v = (value ?? '').trim().toLowerCase()
  return allowed.find((a) => a.toLowerCase() === v) ?? fallback
}

/** Build a Spec from a directory name and its README. Null for non-spec dirs. */
export function parseSpec(dir: string, readme: string): Spec | null {
  const parsed = parseSpecDir(dir)
  if (!parsed) return null
  return {
    dir,
    number: parsed.number,
    slug: parsed.slug,
    path: `${dir}/README.md`,
    preamble: parsePreamble(readme),
    body: readme,
  }
}

// --- amendment -> spec resolution -------------------------------------------

/** How a spec was linked to an amendment — shown as provenance in the report. */
export type MatchRule =
  | 'alias'
  | 'known-amendments'
  | 'slug'
  | 'title'
  | 'feature-mention'

export interface SpecMatch {
  /** Amendment name exactly as it appears in features.macro. */
  amendment: string
  /** Amendment name with any version suffix stripped (BatchV1_1 -> Batch). */
  base: string
  /** Supported::Yes in features.macro. */
  votable: boolean
  /** `fix*` amendments are bug fixes — XLS-1 §3.1 requires specs for FEATURES. */
  isFix: boolean
  spec?: Spec
  via?: MatchRule
}

/** Trailing amendment revision markers: V1, V2, V1_1, _v2. */
const VERSION_SUFFIX_RE = /_?[Vv]\d+(?:_\d+)*$/

/**
 * Strip an amendment's revision suffix — `BatchV1_1`, `MPTokensV1` and
 * `PermissionDelegationV1_1` are revisions of one feature and share its spec.
 */
export function baseAmendmentName(name: string): string {
  const stripped = name.replace(VERSION_SUFFIX_RE, '')
  return stripped.length > 0 ? stripped : name
}

export function isFixAmendment(name: string): boolean {
  return name.startsWith('fix')
}

/** Lowercase alphanumerics only — "Token-Enabled Escrows" -> "tokenenabledescrows". */
export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const KNOWN_AMENDMENT_SECTION_RE = /^### (.+)$/gm
const XLS_NUMBER_RE = /XLS-?0*(\d{1,3})\b/

/**
 * Amendment -> XLS number as already recorded on xrpl.org's
 * `resources/known-amendments.md`. Roughly a fifth of entries link their spec
 * (either the repo tree or an opensource.ripple.com page) and both forms carry
 * the number, which is all we need. Maintained by the docs team, so it costs
 * nothing and stays fresh.
 *
 * The first XLS reference inside an entry wins. `fix*` entries are skipped:
 * their prose cites the spec of the feature they fix (fixUniversalNumber names
 * XLS-30), which would be a false link.
 */
export function parseKnownAmendmentXls(
  knownAmendments: string
): Record<string, number> {
  const out: Record<string, number> = {}
  const headings = [...knownAmendments.matchAll(KNOWN_AMENDMENT_SECTION_RE)]
  for (const [i, heading] of headings.entries()) {
    const name = heading[1].trim()
    if (isFixAmendment(name)) continue
    const start = (heading.index ?? 0) + heading[0].length
    const end = headings[i + 1]?.index ?? knownAmendments.length
    const m = XLS_NUMBER_RE.exec(knownAmendments.slice(start, end))
    if (m) out[name] = parseInt(m[1], 10)
  }
  return out
}

export interface ResolveContext {
  specs: Spec[]
  /** From config/xls-map.yaml — the human override, highest precedence. */
  aliases: Record<string, number>
  /** From parseKnownAmendmentXls; empty when the page wasn't fetched. */
  knownAmendmentXls: Record<string, number>
}

/**
 * Resolve one amendment to its spec. Order is precedence, not convenience:
 * the hand-written alias wins because it exists precisely to correct or
 * complete what inference gets wrong; a `featureX` mention in a spec body comes
 * last because specs cite amendments they merely relate to.
 */
export function resolveSpec(
  amendment: string,
  votable: boolean,
  ctx: ResolveContext
): SpecMatch {
  const base = baseAmendmentName(amendment)
  const match: SpecMatch = {
    amendment,
    base,
    votable,
    isFix: isFixAmendment(amendment),
  }
  const byNumber = (n: number | undefined): Spec | undefined =>
    n === undefined ? undefined : ctx.specs.find((s) => s.number === n)

  const alias = byNumber(ctx.aliases[amendment] ?? ctx.aliases[base])
  if (alias) return { ...match, spec: alias, via: 'alias' }

  const known = byNumber(
    ctx.knownAmendmentXls[amendment] ?? ctx.knownAmendmentXls[base]
  )
  if (known) return { ...match, spec: known, via: 'known-amendments' }

  const target = normalizeName(base)
  const bySlug = ctx.specs.find((s) => normalizeName(s.slug) === target)
  if (bySlug) return { ...match, spec: bySlug, via: 'slug' }

  const byTitle = ctx.specs.find(
    (s) => s.preamble.title && normalizeName(s.preamble.title) === target
  )
  if (byTitle) return { ...match, spec: byTitle, via: 'title' }

  const mentionRe = new RegExp(`\\bfeature${escapeRe(base)}\\b`)
  const byMention = ctx.specs.find((s) => mentionRe.test(s.body))
  if (byMention) return { ...match, spec: byMention, via: 'feature-mention' }

  return match
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Resolve every amendment in a reference's macro sets. */
export function resolveAll(
  amendments: { name: string; votable: boolean }[],
  ctx: ResolveContext
): SpecMatch[] {
  return amendments.map((a) => resolveSpec(a.name, a.votable, ctx))
}

// --- section attribution ----------------------------------------------------

export interface SpecSection {
  /** Heading text with backticks stripped. */
  heading: string
  /** Heading exactly as written, backticks included. */
  rawHeading: string
  /** `#` count. */
  level: number
  /** Text from this heading up to the next heading of any level. */
  body: string
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/gm

/** Split a spec body into heading-scoped sections, in document order. */
export function splitSections(body: string): SpecSection[] {
  const headings = [...body.matchAll(HEADING_RE)]
  return headings.map((h, i) => {
    const start = (h.index ?? 0) + h[0].length
    const end = headings[i + 1]?.index ?? body.length
    return {
      heading: h[2].replace(/`/g, '').trim(),
      rawHeading: h[2].trim(),
      level: h[1].length,
      body: body.slice(start, end),
    }
  })
}

export type TypeKind = 'transactionType' | 'ledgerEntryType'

/**
 * The protocol type a heading is about, or null. Section numbering ("1.2.1.")
 * is stripped first, then the longest whole-word type name in the heading wins
 * so "EscrowCreate" never resolves to "Escrow". A handful of names — notably
 * `DepositPreauth` — are BOTH a transaction and a ledger entry, so every kind
 * the name belongs to is returned and the caller decides which format the
 * section is actually describing.
 */
export function headingType(
  heading: string,
  txTypes: Set<string>,
  ledgerTypes: Set<string>
): { name: string; kinds: TypeKind[] } | null {
  const text = heading.replace(/^[\d.\s]+/, '')
  const kindsOf = (word: string): TypeKind[] => [
    ...(txTypes.has(word) ? (['transactionType'] as const) : []),
    ...(ledgerTypes.has(word) ? (['ledgerEntryType'] as const) : []),
  ]
  const longest = (
    candidates: string[]
  ): { name: string; kinds: TypeKind[] } | null => {
    let best: { name: string; kinds: TypeKind[] } | null = null
    for (const c of candidates) {
      const kinds = kindsOf(c)
      if (kinds.length > 0 && c.length > (best?.name.length ?? 0)) {
        best = { name: c, kinds }
      }
    }
    return best
  }

  // A backticked identifier is the spec's own marker that the heading is about
  // that type — much stronger than a bare word.
  const quoted = [...heading.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map(
    (m) => m[1]
  )
  const fromQuoted = longest(quoted)
  if (fromQuoted) return fromQuoted
  if (quoted.length > 0) return null

  // Unquoted headings only count when the type name IS the heading, modulo the
  // usual nouns around it. Otherwise a prose heading like "Escrow Transactions
  // and Logic" would claim every table under it for the Escrow entry.
  const bare = text
    .replace(
      /\b(the|a|an|transaction|pseudo-transaction|ledger|entry|entries|object|format|type)\b/gi,
      ' '
    )
    .trim()
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(bare) ? longest([bare]) : null
}

export interface TypeSection {
  name: string
  /** Every format this name could refer to; usually one. */
  kinds: TypeKind[]
  /** Concatenated body of every section scoped to this type. */
  body: string
  /** Headings that contributed, for evidence. */
  headings: string[]
}

/**
 * Group a spec's prose by the protocol type it describes. A type-naming
 * heading claims its own body and every deeper section under it, until a
 * heading at the same or a shallower level names a different type (or none) —
 * which is how these specs are actually laid out ("### 1.2.1. `EscrowCreate`"
 * followed by "**Failure Conditions:**" prose).
 *
 * Each type-naming heading starts a SEPARATE section even when an earlier one
 * named the same type: XLS-70 documents both the `DepositPreauth` transaction
 * and the `DepositPreauth` ledger entry, and merging them would check one
 * format's fields against the other's.
 */
export function typeSections(
  body: string,
  txTypes: Set<string>,
  ledgerTypes: Set<string>
): TypeSection[] {
  const out: TypeSection[] = []
  let current: TypeSection | null = null
  let level = 0

  for (const section of splitSections(body)) {
    const named = headingType(section.heading, txTypes, ledgerTypes)
    if (named) {
      current = {
        name: named.name,
        kinds: named.kinds,
        body: section.body,
        headings: [section.heading],
      }
      level = section.level
      out.push(current)
      continue
    }
    if (current && section.level <= level) current = null
    if (!current) continue
    current.body += `\n${section.body}`
    current.headings.push(section.heading)
  }
  return out
}

// --- extraction from spec prose ---------------------------------------------

const FLAG_RE = /\b((?:tf|lsf|asf|tmf|lsmf)[A-Z][A-Za-z0-9_]*)\b/g
const RESULT_CODE_RE = /\b((?:tec|tem|ter|tef|tel)[A-Z][A-Z0-9_]*)\b/g

/** Flag names (tf/lsf/asf/tmf/lsmf) named anywhere in the text. */
export function extractFlags(text: string): string[] {
  return unique([...text.matchAll(FLAG_RE)].map((m) => m[1]))
}

/** Transaction result codes named anywhere in the text. */
export function extractResultCodes(text: string): string[] {
  return unique([...text.matchAll(RESULT_CODE_RE)].map((m) => m[1]))
}

/**
 * Field names from Markdown table rows, accepting the `sf`-prefixed form the
 * specs mix in (`| `sfLockedAmount` |` documents the same field as
 * `| `LockedAmount` |`).
 */
export function extractSpecFieldNames(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/^\|\s*\[?`(?:sf)?([A-Za-z0-9_]+)`/gm)) {
    out.push(m[1])
  }
  return unique(out)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
