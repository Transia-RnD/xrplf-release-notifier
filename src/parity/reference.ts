import type { Logger } from 'winston'
import { getFileAtRef } from '../github/client'
import { findLastFinalTag, findPredecessorTag } from '../version/predecessor'
import { splitRepo } from './sdks'

/**
 * Builds the "ground truth" feature set a given rippled release defines, parsed
 * directly from the tagged protocol macro files (no node required). The agent
 * checklist is the DELTA — features new in this release vs the predecessor —
 * which keeps each SDK scan small and answers "is the SDK caught up to THIS
 * release." The full sets are kept for context/reporting.
 */

const MACRO_DIR = 'include/xrpl/protocol/detail'
const TX_FLAGS_PATH = 'include/xrpl/protocol/TxFlags.h'
const LEDGER_FORMATS_PATH = 'include/xrpl/protocol/LedgerFormats.h'
const TER_PATH = 'include/xrpl/protocol/TER.h'
const INNER_OBJECTS_PATH = 'src/libxrpl/protocol/InnerObjectFormats.cpp'

export type FeatureKind = 'transactionType' | 'ledgerEntryType' | 'field'

export interface Feature {
  name: string
  kind: FeatureKind
}

/** One field of a transaction/ledger-entry format, from the macro's spec block. */
export interface FieldSpec {
  name: string
  required: boolean
}

/**
 * Flag names owned by each type, parsed from the XMACRO blocks in TxFlags.h /
 * LedgerFormats.h. Absent when the ref predates that layout (rippled < 3.2) —
 * consumers must treat missing as "flags unknown", not "type has no flags".
 */
export interface FlagSets {
  /** `TRANSACTION(Payment, TF_FLAG(tfPartialPayment, …))` -> Payment: [tf…]. */
  txFlags: Record<string, string[]>
  /** `LEDGER_OBJECT(Credential, LSF_FLAG(lsfAccepted, …))` -> Credential: [lsf…]. */
  ledgerFlags: Record<string, string[]>
  /** `ASF_FLAG(asfRequireDest, 1)` — AccountSet SetFlag/ClearFlag values. */
  accountSetFlags: string[]
  /**
   * Every flag name the headers declare, including the families declared as
   * plain constants outside the per-type blocks (the `tmf*`/`lsmf*` MPT flags).
   * This is the vocabulary check — "does this flag exist at all" — as distinct
   * from the per-type sets above, which answer "which type owns it".
   */
  allFlags: string[]
}

export interface FeatureSets {
  transactionTypes: string[]
  ledgerEntryTypes: string[]
  fields: string[]
  /**
   * Per-type field specs parsed from the macro blocks
   * (`TRANSACTION(..., ({ {sfX, SoeRequired}, ... }))`). Absent when the ref
   * predates the field-spec macro layout — consumers must treat missing as
   * "spec unknown", not "no fields".
   */
  txFields?: Record<string, FieldSpec[]>
  ledgerEntryFields?: Record<string, FieldSpec[]>
  /** Per-type flag names; absent when the ref predates the flag XMACRO layout. */
  flags?: FlagSets
  /** Every transaction result code the protocol defines (TER.h enum names). */
  resultCodes?: string[]
  /**
   * Fields that are members of an inner-object template (SignerEntry's
   * `Account`, Credential's `Issuer`, …). A spec documenting one under a
   * transaction is describing a nested object, not misplacing a field.
   */
  innerObjectFields?: string[]
  /** Votable amendment names (Supported::Yes) — context only; also seeds PR stems. */
  amendments: string[]
  /**
   * Amendment names present in the macro but shipped `Supported::No` — built into
   * the binary yet NOT votable, so the network cannot enable them. Tracked so a
   * release that adds one can be flagged instead of silently claiming support.
   */
  unsupportedAmendments: string[]
}

export interface Reference {
  repo: string
  tag: string
  predecessorTag: string | null
  /** Everything the target release defines. */
  full: FeatureSets
  /** Features present in `tag` but not in the predecessor — the actionable checklist. */
  added: Feature[]
  /** Votable amendments (Supported::Yes) new in this release (context for the report). */
  addedAmendments: string[]
  /**
   * Amendments whose name is new in this release but shipped `Supported::No` —
   * code is present but the network cannot vote them in. These are the gap that
   * lets release notes overstate support (e.g. MPTokensV2 in 3.2.0): the feature
   * looks delivered in the diff, yet the amendment is unvotable. Surfaced as an
   * explicit alert so a reviewer confirms the notes don't claim it's available.
   */
  addedUnsupportedAmendments: string[]
  /**
   * True when we couldn't establish a parseable predecessor baseline (no
   * predecessor, or one that predates the .macro layout — rippled < ~2.3).
   * In that case `added` is left EMPTY rather than diffing against nothing,
   * which would flag the entire protocol as "new" and explode the scan.
   */
  baselineMissing: boolean
  /**
   * For each ADDED field, the transaction/ledger-entry types whose format
   * includes it at `tag` — i.e. the pages that should document it. Empty array
   * = the field belongs to no type format (ledger header, metadata, etc.).
   */
  fieldOwners?: Record<string, Feature[]>
}

// XRPL_FEATURE(Name, Supported::Yes, ...) -> "Name"
// XRPL_FIX    (Name, Supported::Yes, ...) -> "fix" + "Name"   (note padding spaces)
// Case-insensitive on the Supported value: rippled <= 3.1.x wrote `Supported::yes`,
// 3.2.x switched to `Supported::Yes`. Matching only one casing silently empties the
// predecessor's amendment set and reports the whole list as "new".
const FEATURE_RE =
  /^XRPL_(FEATURE|FIX)\s*\(\s*([A-Za-z0-9_]+)\s*,\s*Supported::(Yes|No)/i
// TRANSACTION(ttPAYMENT, 0, Payment, ...) -> "Payment"
const TX_RE = /^TRANSACTION\(\s*[A-Za-z0-9_]+\s*,\s*[^,]+,\s*([A-Za-z0-9_]+)/
// LEDGER_ENTRY(ltNFTOKEN_OFFER, 0x0037, NFTokenOffer, ...) -> "NFTokenOffer"
// also LEDGER_ENTRY_DUPLICATE(...) (but never the "#define LEDGER_ENTRY_DUPLICATE" line)
const LE_RE =
  /^LEDGER_ENTRY(?:_DUPLICATE)?\(\s*[A-Za-z0-9_]+\s*,\s*[^,]+,\s*([A-Za-z0-9_]+)/
// TYPED_SFIELD(sfAccount, ACCOUNT, 1) / UNTYPED_SFIELD(sfLedgerEntry, LEDGERENTRY, 257)
const SFIELD_RE = /^(?:UN)?TYPED_SFIELD\(\s*sf([A-Za-z0-9_]+)\s*,/

/**
 * Split the amendments declared in features.macro by their Supported flag.
 * `supported` = votable (Supported::Yes); `unsupported` = built but Supported::No
 * (present in the binary, NOT votable). Names get the `fix` prefix for XRPL_FIX.
 */
function parseAmendmentsBySupport(macro: string): {
  supported: string[]
  unsupported: string[]
} {
  const supported: string[] = []
  const unsupported: string[] = []
  for (const line of macro.split('\n')) {
    const m = line.match(FEATURE_RE)
    if (!m) continue
    const name = m[1].toUpperCase() === 'FIX' ? `fix${m[2]}` : m[2]
    if (m[3].toLowerCase() === 'yes') supported.push(name)
    else unsupported.push(name) // Supported::No — built, not votable
  }
  return { supported, unsupported }
}

export function parseAmendments(macro: string): string[] {
  return parseAmendmentsBySupport(macro).supported
}

export function parseUnsupportedAmendments(macro: string): string[] {
  return parseAmendmentsBySupport(macro).unsupported
}

export function parseTransactionTypes(macro: string): string[] {
  return matchAll(macro, TX_RE)
}

export function parseLedgerEntryTypes(macro: string): string[] {
  return matchAll(macro, LE_RE)
}

export function parseFields(macro: string): string[] {
  return matchAll(macro, SFIELD_RE)
}

// Field-spec blocks: the macro entry's trailing `({ {sfX, SoeRequired}, ... })`
// list. Case-insensitive on the Soe flag (SoeRequired vs older soeREQUIRED).
const TX_BLOCK_RE =
  /^TRANSACTION\(\s*[A-Za-z0-9_]+\s*,\s*[^,]+,\s*([A-Za-z0-9_]+)([\s\S]*?)\)\)/gm
const LE_BLOCK_RE =
  /^LEDGER_ENTRY(?:_DUPLICATE)?\(\s*[A-Za-z0-9_]+\s*,\s*[^,]+,\s*([A-Za-z0-9_]+)([\s\S]*?)\)\)/gm
const SPEC_FIELD_RE = /\{\s*sf([A-Za-z0-9_]+)\s*,\s*[Ss]oe([A-Za-z]+)/g

function parseFieldSpecBlocks(
  macro: string,
  blockRe: RegExp
): Record<string, FieldSpec[]> {
  const out: Record<string, FieldSpec[]> = {}
  for (const block of macro.matchAll(blockRe)) {
    const fields: FieldSpec[] = []
    for (const f of block[2].matchAll(SPEC_FIELD_RE)) {
      fields.push({ name: f[1], required: f[2].toLowerCase() === 'required' })
    }
    out[block[1]] = fields
  }
  return out
}

/** Per-transaction field specs, keyed by wire name (e.g. "Payment"). */
export function parseTxFieldSpecs(macro: string): Record<string, FieldSpec[]> {
  return parseFieldSpecBlocks(macro, TX_BLOCK_RE)
}

/** Per-ledger-entry field specs, keyed by entry name (e.g. "Check"). */
export function parseLedgerEntryFieldSpecs(
  macro: string
): Record<string, FieldSpec[]> {
  return parseFieldSpecBlocks(macro, LE_BLOCK_RE)
}

/** Member field names of every inner-object template (InnerObjectFormats.cpp). */
export function parseInnerObjectFields(source: string): string[] {
  return [...new Set([...source.matchAll(SPEC_FIELD_RE)].map((m) => m[1]))]
}

// Enum entries in TER.h: telLOCAL_ERROR = -399, telBAD_DOMAIN, …
const RESULT_CODE_RE = /^\s*((?:tel|tem|tef|ter|tec|tes)[A-Z][A-Z0-9_]*)/gm

/** Every result-code name TER.h defines — the vocabulary a spec may cite. */
export function parseResultCodes(header: string): string[] {
  return [...stripComments(header).matchAll(RESULT_CODE_RE)].map((m) => m[1])
}

/** Fields the format marks SoeRequired — the spine of a type's definition. */
export function requiredFields(spec: FieldSpec[] | undefined): string[] {
  return (spec ?? []).filter((f) => f.required).map((f) => f.name)
}

/** Drop block and line comments so commented-out flag entries never parse. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

// TRANSACTION(LoanPay, TF_FLAG(tfLoanOverpayment, 0x…) …, MASK_ADJ(0))
// The body is guarded against swallowing the next block if MASK_ADJ is absent.
const TX_FLAG_BLOCK_RE =
  /TRANSACTION\(\s*([A-Za-z0-9_]+)\s*,((?:(?!TRANSACTION\()[\s\S])*?)MASK_ADJ\(/g
// LEDGER_OBJECT(Credential, LSF_FLAG(lsfAccepted, 0x…))
const LE_FLAG_BLOCK_RE =
  /LEDGER_OBJECT\(\s*([A-Za-z0-9_]+)\s*,((?:(?!LEDGER_OBJECT\()[\s\S])*?)\)\)/g
const TF_FLAG_RE = /TF_FLAG2?\(\s*(tf[A-Za-z0-9_]+)\s*,/g
const LSF_FLAG_RE = /LSF_FLAG2?\(\s*(lsf[A-Za-z0-9_]+)\s*,/g
const ASF_FLAG_RE = /ASF_FLAG\(\s*(asf[A-Za-z0-9_]+)\s*,\s*\d+\s*\)/g

function parseFlagBlocks(
  header: string,
  blockRe: RegExp,
  flagRe: RegExp
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const block of stripComments(header).matchAll(blockRe)) {
    const names = [...block[2].matchAll(flagRe)].map((m) => m[1])
    if (names.length > 0) out[block[1]] = names
  }
  return out
}

/** Per-transaction flag names from TxFlags.h. */
export function parseTxFlags(header: string): Record<string, string[]> {
  return parseFlagBlocks(header, TX_FLAG_BLOCK_RE, TF_FLAG_RE)
}

/** Per-ledger-object flag names from LedgerFormats.h. */
export function parseLedgerFlags(header: string): Record<string, string[]> {
  return parseFlagBlocks(header, LE_FLAG_BLOCK_RE, LSF_FLAG_RE)
}

/** AccountSet SetFlag/ClearFlag names from the ACCOUNTSET_FLAGS block. */
export function parseAccountSetFlags(header: string): string[] {
  return [...stripComments(header).matchAll(ASF_FLAG_RE)].map((m) => m[1])
}

// Flags also arrive as plain constants — the tmf*/lsmf* MPT families live
// outside the per-type XMACRO blocks entirely.
const FLAG_CONSTANT_RE =
  /\b((?:tf|tmf|lsf|lsmf|asf)[A-Z][A-Za-z0-9_]*)\s*(?:=|,)/g

/** Every flag name a header declares, however it declares it. */
export function parseAllFlagNames(header: string): string[] {
  return [
    ...new Set(
      [...stripComments(header).matchAll(FLAG_CONSTANT_RE)].map((m) => m[1])
    ),
  ]
}

function matchAll(macro: string, re: RegExp): string[] {
  const out: string[] = []
  for (const line of macro.split('\n')) {
    const m = line.match(re)
    if (m) out.push(m[1])
  }
  return out
}

/**
 * Flag sets for a ref, or undefined when nothing parses — refs before the
 * XMACRO layout (rippled < 3.2) declare flags as loose constants, and reporting
 * "no flags" there would flag every documented flag as drift.
 */
function parseFlagSets(
  txFlagsHeader: string | null,
  ledgerFormatsHeader: string | null
): FlagSets | undefined {
  const txFlags = txFlagsHeader ? parseTxFlags(txFlagsHeader) : {}
  const ledgerFlags = ledgerFormatsHeader
    ? parseLedgerFlags(ledgerFormatsHeader)
    : {}
  const accountSetFlags = txFlagsHeader
    ? parseAccountSetFlags(txFlagsHeader)
    : []
  const allFlags = [
    ...new Set([
      ...(txFlagsHeader ? parseAllFlagNames(txFlagsHeader) : []),
      ...(ledgerFormatsHeader ? parseAllFlagNames(ledgerFormatsHeader) : []),
    ]),
  ]
  const parsedAnything =
    Object.keys(txFlags).length > 0 ||
    Object.keys(ledgerFlags).length > 0 ||
    accountSetFlags.length > 0
  return parsedAnything
    ? { txFlags, ledgerFlags, accountSetFlags, allFlags }
    : undefined
}

async function fetchSets(
  repo: string,
  ref: string,
  token: string | undefined
): Promise<FeatureSets | null> {
  const [
    features,
    transactions,
    ledgerEntries,
    sfields,
    txFlags,
    ledgerFlags,
    terHeader,
    innerObjects,
  ] = await Promise.all([
    getFileAtRef(repo, `${MACRO_DIR}/features.macro`, ref, token),
    getFileAtRef(repo, `${MACRO_DIR}/transactions.macro`, ref, token),
    getFileAtRef(repo, `${MACRO_DIR}/ledger_entries.macro`, ref, token),
    getFileAtRef(repo, `${MACRO_DIR}/sfields.macro`, ref, token),
    getFileAtRef(repo, TX_FLAGS_PATH, ref, token),
    getFileAtRef(repo, LEDGER_FORMATS_PATH, ref, token),
    getFileAtRef(repo, TER_PATH, ref, token),
    getFileAtRef(repo, INNER_OBJECTS_PATH, ref, token),
  ])
  // transactions + sfields are load-bearing; if either is missing at this ref
  // the macro layout has changed and we can't trust the parse.
  if (!transactions || !sfields || !ledgerEntries) return null
  return {
    flags: parseFlagSets(txFlags, ledgerFlags),
    resultCodes: terHeader ? parseResultCodes(terHeader) : undefined,
    innerObjectFields: innerObjects
      ? parseInnerObjectFields(innerObjects)
      : undefined,
    transactionTypes: parseTransactionTypes(transactions),
    ledgerEntryTypes: parseLedgerEntryTypes(ledgerEntries),
    fields: parseFields(sfields),
    amendments: features ? parseAmendments(features) : [],
    unsupportedAmendments: features ? parseUnsupportedAmendments(features) : [],
    txFields: parseTxFieldSpecs(transactions),
    ledgerEntryFields: parseLedgerEntryFieldSpecs(ledgerEntries),
  }
}

export interface BuildReferenceOptions {
  /** rippled repo, e.g. "XRPLF/rippled". */
  repo: string
  /** Target release tag (the version that triggered the run). */
  tag: string
  githubToken?: string
  logger?: Logger
  /** Override predecessor resolution (tests / explicit diffs). */
  predecessorTag?: string | null
}

export async function buildReference(
  opts: BuildReferenceOptions
): Promise<Reference> {
  const { repo, tag, githubToken } = opts
  const { owner, name } = splitRepo(repo)

  const full = await fetchSets(repo, tag, githubToken)
  if (!full) {
    throw new Error(
      `Could not fetch/parse rippled protocol macros at ${repo}@${tag} — macro layout may have moved`
    )
  }

  // Prereleases diff against the LAST FINAL, not the closest tag: rc2 vs rc1
  // is a near-empty delta that hides the cumulative "what does X.Y.Z need"
  // picture — especially under the private-build flow where the whole RC train
  // syncs to the public repo at once. Finals already skip prereleases inside
  // findPredecessorTag.
  const isPrerelease = tag.replace(/^v/, '').includes('-')
  const predecessorTag =
    opts.predecessorTag !== undefined
      ? opts.predecessorTag
      : isPrerelease
        ? await findLastFinalTag(owner, name, tag, githubToken)
        : await findPredecessorTag(owner, name, tag, githubToken)

  const prev = predecessorTag
    ? await fetchSets(repo, predecessorTag, githubToken)
    : null

  // Without a parseable predecessor we have no trustworthy baseline. Diffing
  // against empty would mark the WHOLE protocol new (hundreds of features) and
  // blow up the per-feature agent scan — so leave the delta empty and flag it.
  const baselineMissing = !prev
  if (baselineMissing) {
    opts.logger?.warn(
      'No parseable predecessor baseline — skipping per-feature delta',
      { predecessorTag }
    )
  }

  const added: Feature[] = baselineMissing
    ? []
    : [
        ...diff(full.transactionTypes, prev?.transactionTypes).map(
          (n): Feature => ({ name: n, kind: 'transactionType' })
        ),
        ...diff(full.ledgerEntryTypes, prev?.ledgerEntryTypes).map(
          (n): Feature => ({ name: n, kind: 'ledgerEntryType' })
        ),
        ...diff(full.fields, prev?.fields).map(
          (n): Feature => ({ name: n, kind: 'field' })
        ),
      ]

  // Baseline for "newly unvotable" is the predecessor's FULL amendment name set
  // (votable + unvotable). An amendment that was already Supported::No before is
  // a known in-progress feature, not a fresh "shipped but unvotable" surprise —
  // only names absent from the predecessor entirely get flagged.
  const prevAllAmendments = prev
    ? [...prev.amendments, ...prev.unsupportedAmendments]
    : []

  // Owner types per added field — every format at `tag` that includes it.
  const fieldOwners: Record<string, Feature[]> = {}
  for (const f of added) {
    if (f.kind !== 'field') continue
    fieldOwners[f.name] = [
      ...Object.entries(full.txFields ?? {})
        .filter(([, fs]) => fs.some((s) => s.name === f.name))
        .map(([n]): Feature => ({ name: n, kind: 'transactionType' })),
      ...Object.entries(full.ledgerEntryFields ?? {})
        .filter(([, fs]) => fs.some((s) => s.name === f.name))
        .map(([n]): Feature => ({ name: n, kind: 'ledgerEntryType' })),
    ]
  }

  return {
    repo,
    tag,
    predecessorTag,
    full,
    added,
    addedAmendments: baselineMissing
      ? []
      : diff(full.amendments, prev?.amendments),
    addedUnsupportedAmendments: baselineMissing
      ? []
      : diff(full.unsupportedAmendments, prevAllAmendments),
    baselineMissing,
    fieldOwners,
  }
}

/**
 * The full checklist for a full-parity sweep: every TRANSACTION type the target
 * ref defines. Ledger-entry types are intentionally excluded — most SDKs read
 * on-ledger objects as plain JSON rather than modeling them as typed builders,
 * so they're not a meaningful parity dimension (we still parse them for context).
 * Unlike `added`, this is independent of any predecessor — it surfaces the SDK's
 * entire transaction backlog, not just what changed this release.
 */
export function fullTypeChecklist(reference: Reference): Feature[] {
  return reference.full.transactionTypes.map(
    (n): Feature => ({ name: n, kind: 'transactionType' })
  )
}

/** Checklist for a delta run: new transaction types + new fields, ledger excluded. */
export function deltaChecklist(reference: Reference): Feature[] {
  return reference.added.filter((f) => f.kind !== 'ledgerEntryType')
}

/** Items in `current` not in `previous` (preserving order, deduped). */
function diff(current: string[], previous: string[] | undefined): string[] {
  const prevSet = new Set(previous ?? [])
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of current) {
    if (prevSet.has(item) || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}
