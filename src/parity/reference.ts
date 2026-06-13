import type { Logger } from 'winston'
import { getFileAtRef } from '../github/client'
import { findPredecessorTag } from '../version/predecessor'
import { splitRepo } from './sdks'

/**
 * Builds the "ground truth" feature set a given rippled release defines, parsed
 * directly from the tagged protocol macro files (no node required). The agent
 * checklist is the DELTA — features new in this release vs the predecessor —
 * which keeps each SDK scan small and answers "is the SDK caught up to THIS
 * release." The full sets are kept for context/reporting.
 */

const MACRO_DIR = 'include/xrpl/protocol/detail'

export type FeatureKind = 'transactionType' | 'ledgerEntryType' | 'field'

export interface Feature {
  name: string
  kind: FeatureKind
}

export interface FeatureSets {
  transactionTypes: string[]
  ledgerEntryTypes: string[]
  fields: string[]
  /** Amendment names — context only (no SDK models amendments); also seeds PR stems. */
  amendments: string[]
}

export interface Reference {
  repo: string
  tag: string
  predecessorTag: string | null
  /** Everything the target release defines. */
  full: FeatureSets
  /** Features present in `tag` but not in the predecessor — the actionable checklist. */
  added: Feature[]
  /** Amendments new in this release (context for the report). */
  addedAmendments: string[]
  /**
   * True when we couldn't establish a parseable predecessor baseline (no
   * predecessor, or one that predates the .macro layout — rippled < ~2.3).
   * In that case `added` is left EMPTY rather than diffing against nothing,
   * which would flag the entire protocol as "new" and explode the scan.
   */
  baselineMissing: boolean
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

export function parseAmendments(macro: string): string[] {
  const out: string[] = []
  for (const line of macro.split('\n')) {
    const m = line.match(FEATURE_RE)
    if (!m) continue
    if (m[3].toLowerCase() !== 'yes') continue // skip Supported::No (built, not votable)
    out.push(m[1].toUpperCase() === 'FIX' ? `fix${m[2]}` : m[2])
  }
  return out
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

function matchAll(macro: string, re: RegExp): string[] {
  const out: string[] = []
  for (const line of macro.split('\n')) {
    const m = line.match(re)
    if (m) out.push(m[1])
  }
  return out
}

async function fetchSets(
  repo: string,
  ref: string,
  token: string | undefined
): Promise<FeatureSets | null> {
  const [features, transactions, ledgerEntries, sfields] = await Promise.all([
    getFileAtRef(repo, `${MACRO_DIR}/features.macro`, ref, token),
    getFileAtRef(repo, `${MACRO_DIR}/transactions.macro`, ref, token),
    getFileAtRef(repo, `${MACRO_DIR}/ledger_entries.macro`, ref, token),
    getFileAtRef(repo, `${MACRO_DIR}/sfields.macro`, ref, token),
  ])
  // transactions + sfields are load-bearing; if either is missing at this ref
  // the macro layout has changed and we can't trust the parse.
  if (!transactions || !sfields || !ledgerEntries) return null
  return {
    transactionTypes: parseTransactionTypes(transactions),
    ledgerEntryTypes: parseLedgerEntryTypes(ledgerEntries),
    fields: parseFields(sfields),
    amendments: features ? parseAmendments(features) : [],
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

  const predecessorTag =
    opts.predecessorTag !== undefined
      ? opts.predecessorTag
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

  return {
    repo,
    tag,
    predecessorTag,
    full,
    added,
    addedAmendments: baselineMissing
      ? []
      : diff(full.amendments, prev?.amendments),
    baselineMissing,
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
