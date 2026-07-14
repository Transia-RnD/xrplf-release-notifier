import type Anthropic from '@anthropic-ai/sdk'
import type { Logger } from 'winston'
import type { CommitSummary, DiffFile } from '../github/client'
import { fetchCompare, getFileAtRef } from '../github/client'
import { findPreviousTag, findLastFinalTag } from '../version/predecessor'
import { buildReference } from '../parity/reference'
import type { Feature } from '../parity/reference'
import {
  MODEL,
  MAX_COMMITS_FOR_SUMMARY,
  extractText,
  TRIVIAL_COMMIT,
} from './summarizer'
import { createAnthropicClient } from './client'
import { getErrorMessage } from '../utils/error'
import { BREAKING_RULES } from './breaking-rules'

const MAX_TOKENS = 1024

/** Per-file patch cap for the candidate stage. */
const MAX_PATCH_CHARS_PER_FILE = 16000
/** Total patch budget across all included files (candidate stage). */
const MAX_TOTAL_PATCH_CHARS = 80000
/** Upper bound on candidates carried into the (per-candidate) verify stage. */
const MAX_CANDIDATES = 20
/** Cap on the governing source we send a verifier; grep gates beyond this. */
const MAX_FILE_CHARS = 30000
/** Cap per high-signal surface category so a major release can't flood the post. */
const MAX_LISTED = 25
/** New SFields are numerous and low-signal individually — sample, don't list all. */
const MAX_FIELD_SAMPLE = 6

/** Reject any verifier statement that hedges — a breaking feed states facts. */
const HEDGE = /\b(may|might|could|possibly|appears?|likely|probably)\b/i

/**
 * Paths whose diffs most directly encode unconditional, operator/integrator-
 * facing behavior changes (the BREAKING-ON-UPGRADE candidate stage). New
 * protocol SURFACE (tx types/fields/ledger objects/amendments) is handled
 * separately and deterministically — see buildReference (src/parity/reference).
 */
const PRIORITY_PATHS: RegExp[] = [
  /(include\/xrpl|src\/libxrpl|src\/ripple)\/protocol\//,
  /src\/(xrpld|ripple)\/app\/tx\//,
  /src\/(xrpld|ripple)\/.*\/transactors\//,
  /(src\/(xrpld|ripple)\/rpc\/|include\/xrpl\/protocol\/ErrorCodes)/,
  /ApiVersion/i,
  /(\.cfg$|(^|\/)Config\.(h|cpp)$)/,
]

const STAGE1_PROMPT = `You are a xrpld (XRP Ledger server) release engineer. From the commit subjects, changed-file list, and patches between two tags, list the DISTINCT changes that are CANDIDATES for BREAKING ON UPGRADE — unconditional behavior/wire/API/config changes a node would exhibit the moment it runs the new binary. Do NOT list new amendments, new transaction types, or new fields (those are handled separately). Just enumerate candidates a verifier should examine.

${BREAKING_RULES}

Output ONLY a JSON array (no prose, no markdown fences). Each element:
{"title": "<short description>", "file": "<primary changed file path>", "sha": "<short commit sha>", "category": "protocol|api|config|amendment-governance"}

Group trivially-related edits into one candidate. Omit pure refactor/test/CI/docs/logging/format changes and anything amendment-gated. If there are no candidates, output [].`

const STAGE2_PROMPT = `You are a xrpld (XRP Ledger server) release engineer verifying ONE candidate change. You are given the candidate, its diff hunk, and the governing source file at the new tag. Decide definitively whether it BREAKS on upgrade (unconditional — NO amendment gate, NO api_version gate) or is NOT breaking.

${BREAKING_RULES}

Output ONLY a JSON object (no prose, no markdown fences):
{"classification": "BREAKING_NOW|NOT_BREAKING", "statement": "<the concrete change, ≤ 160 characters, NO hedging words>", "confidence": "high|medium|low"}

The "statement" is a Mattermost bullet: ONE tight factual clause naming the symbol/behavior that changed (e.g. "STPathSet deserialization now throws std::runtime_error for path elements with both MPT and Currency flags"). No "this change", no preamble, no semicolon run-ons.`

export interface BreakingResult {
  /** Composed markdown bullets ("" if none) — unconditional, live on upgrade. */
  breakingNow: string
  /** Composed markdown bullets ("" if none) — new protocol surface SDKs must add. */
  newSurface: string
  /**
   * Composed markdown bullets ("" if none) — amendments added this release but
   * shipped Supported::No (built, NOT votable). Surfaced so the notification
   * can't imply the feature is available when the network can't enable it.
   */
  unvotableAmendments: string
  hasBreakingNow: boolean
  hasNewSurface: boolean
  hasUnvotableAmendment: boolean
}

const NO_BREAKING: BreakingResult = {
  breakingNow: '',
  newSurface: '',
  unvotableAmendments: '',
  hasBreakingNow: false,
  hasNewSurface: false,
  hasUnvotableAmendment: false,
}

/** New protocol surface (cumulative vs the last stable release), from buildReference. */
export interface SurfaceDelta {
  added: Feature[]
  addedAmendments: string[]
  /** Amendments new this release but Supported::No (built, not votable). */
  addedUnsupportedAmendments: string[]
}

interface Candidate {
  title: string
  file: string
  sha: string
  category: string
}

interface Verdict {
  classification: string
  statement: string
  confidence: string
}

export interface DetectBreakingOptions {
  commits: CommitSummary[]
  files: DiffFile[]
  base: string
  head: string
  owner: string
  repo: string
  apiKey: string
  githubToken?: string
  logger?: Logger
  /** Pre-computed cumulative surface (vs last stable). Empty if unavailable. */
  surface?: SurfaceDelta
}

/**
 * Classify a tag diff into (A) breaking-on-upgrade and (B) new SDK surface.
 *
 * (B) is deterministic and is supplied via `surface` — computed by
 * buildReference as a full-file set-diff against the last STABLE release, so it
 * accumulates the whole pre-release cycle and never truncates. (A) is the
 * two-stage AI on the INCREMENTAL diff (vs the previous tag): stage 1
 * enumerates unconditional-change candidates; stage 2 verifies each against the
 * governing source to confirm there is no amendment/api_version gate. Never hedges.
 */
export async function detectBreakingChanges(
  opts: DetectBreakingOptions
): Promise<BreakingResult> {
  const surface = opts.surface ?? {
    added: [],
    addedAmendments: [],
    addedUnsupportedAmendments: [],
  }
  const newSurface = formatSurface(surface)
  const unvotableAmendments = formatUnvotableAmendments(surface)

  const commits = opts.commits
    .map((c) => ({ ...c, subject: c.message.split('\n')[0].trim() }))
    .filter((c) => c.subject && !TRIVIAL_COMMIT.test(c.subject))
    .slice(0, MAX_COMMITS_FOR_SUMMARY)

  let breakingNow = ''
  if (commits.length > 0) {
    breakingNow = await detectBreakingNow(
      opts,
      commits,
      surface.addedAmendments
    )
  }

  opts.logger?.info('Breaking-change detection complete', {
    base: opts.base,
    head: opts.head,
    hasBreakingNow: breakingNow.length > 0,
    surfaceItems: surface.added.length + surface.addedAmendments.length,
  })

  return {
    breakingNow,
    newSurface,
    unvotableAmendments,
    hasBreakingNow: breakingNow.length > 0,
    hasNewSurface: newSurface.length > 0,
    hasUnvotableAmendment: unvotableAmendments.length > 0,
  }
}

async function detectBreakingNow(
  opts: DetectBreakingOptions,
  commits: { sha: string; subject: string; author: string }[],
  addedAmendments: string[]
): Promise<string> {
  const client = createAnthropicClient(opts.apiKey)

  const candidates = await listCandidates(
    client,
    opts,
    commits,
    addedAmendments
  )
  if (candidates.length === 0) return ''

  const fileCache = new Map<string, string | null>()
  const verdicts = await Promise.all(
    candidates.map((cand) => verifyCandidate(client, opts, cand, fileCache))
  )

  const items: string[] = []
  for (let i = 0; i < candidates.length; i++) {
    const v = verdicts[i]
    if (!v || v.confidence === 'low') continue
    if (v.classification !== 'BREAKING_NOW') continue
    if (HEDGE.test(v.statement)) continue
    const sha = candidates[i].sha?.slice(0, 7) ?? ''
    items.push(`• ${v.statement}${sha ? ` (${sha})` : ''}`)
  }
  return items.join('\n')
}

/**
 * Compose the "new protocol surface" bullets — what an SDK must add support
 * for. Amendments, transaction types, and ledger objects are listed (the
 * headline surface); the many new SFields are collapsed to a count + sample so
 * a feature-heavy release doesn't produce a 400-line post.
 */
/**
 * Compose the "added but NOT votable" alert — amendments new in this release that
 * shipped Supported::No. The code is present (so the diff/notes look like the
 * feature landed) but the network can't vote the amendment in, so it isn't
 * actually available. This is the exact gap behind MPTokensV2 in 3.2.0: surface
 * it loudly so the release announcement can't claim support it doesn't have.
 */
function formatUnvotableAmendments(surface: SurfaceDelta): string {
  const amendments = dedupe(surface.addedUnsupportedAmendments)
  if (!amendments.length) return ''

  const lines = amendments
    .slice(0, MAX_LISTED)
    .map(
      (a) =>
        `• \`${a}\` — present in the binary but \`Supported::No\`, so the network cannot vote it in or enable it. Do NOT describe it as supported/available.`
    )
  if (amendments.length > MAX_LISTED)
    lines.push(`• …and ${amendments.length - MAX_LISTED} more`)
  return lines.join('\n')
}

function formatSurface(surface: SurfaceDelta): string {
  const amendments = dedupe(surface.addedAmendments)
  const txs = featureNames(surface.added, 'transactionType')
  const ledgers = featureNames(surface.added, 'ledgerEntryType')
  const fields = featureNames(surface.added, 'field')
  if (!amendments.length && !txs.length && !ledgers.length && !fields.length) {
    return ''
  }

  const lines: string[] = []
  for (const a of amendments.slice(0, MAX_LISTED))
    lines.push(`• Amendment \`${a}\``)
  for (const t of txs.slice(0, MAX_LISTED))
    lines.push(`• Transaction type \`${t}\``)
  for (const l of ledgers.slice(0, MAX_LISTED))
    lines.push(`• Ledger object \`${l}\``)
  if (fields.length > 0) {
    const sample = fields
      .slice(0, MAX_FIELD_SAMPLE)
      .map((f) => `\`${f}\``)
      .join(', ')
    lines.push(
      fields.length <= MAX_FIELD_SAMPLE
        ? `• New fields: ${sample}`
        : `• ${fields.length} new fields (${sample}, …)`
    )
  }

  const overflow = [
    ['amendments', amendments.length],
    ['transaction types', txs.length],
    ['ledger objects', ledgers.length],
  ] as const
  const extras = overflow
    .map(([label, n]) =>
      n > MAX_LISTED ? `${n - MAX_LISTED} more ${label}` : null
    )
    .filter((x): x is string => x !== null)
  if (extras.length > 0) lines.push(`• …and ${extras.join(', ')}`)

  return lines.join('\n')
}

function featureNames(added: Feature[], kind: Feature['kind']): string[] {
  return dedupe(added.filter((f) => f.kind === kind).map((f) => f.name))
}

function dedupe(names: string[]): string[] {
  return [...new Set(names)]
}

async function listCandidates(
  client: Anthropic,
  opts: DetectBreakingOptions,
  commits: { sha: string; subject: string; author: string }[],
  addedAmendments: string[]
): Promise<Candidate[]> {
  const commitList = commits
    .map((c) => `- ${c.subject} (${c.sha.slice(0, 7)}, ${c.author})`)
    .join('\n')
  const fileList = opts.files
    .map((f) => `${f.status}\t${f.filename} (+${f.additions}/-${f.deletions})`)
    .join('\n')

  const user = [
    `Diff between xrpld ${opts.base} and ${opts.head}.`,
    `\nAmendments new in this release line (their gated code is NOT breaking-on-upgrade):\n${addedAmendments.length ? addedAmendments.map((a) => `- ${a}`).join('\n') : '(none)'}`,
    `\nCommits:\n${commitList}`,
    `\nChanged files:\n${fileList || '(none reported)'}`,
    `\nRelevant patches:\n${buildPatchBlock(opts.files)}`,
  ].join('\n')

  const text = await callModel(client, STAGE1_PROMPT, user)
  const parsed = parseJson<Candidate[]>(text, '[', ']')
  if (!parsed) {
    opts.logger?.warn('Breaking stage-1 returned unparseable candidates', {
      head: opts.head,
    })
    return []
  }
  return parsed
    .filter(
      (c) => c && typeof c.title === 'string' && typeof c.file === 'string'
    )
    .slice(0, MAX_CANDIDATES)
}

async function verifyCandidate(
  client: Anthropic,
  opts: DetectBreakingOptions,
  cand: Candidate,
  fileCache: Map<string, string | null>
): Promise<Verdict | null> {
  const hunk =
    opts.files.find((f) => f.filename === cand.file)?.patch ??
    '(hunk unavailable)'
  const source = await loadGoverningSource(opts, cand.file, fileCache)

  const user = [
    `Candidate: ${cand.title}`,
    `File: ${cand.file}   Category: ${cand.category}`,
    `\nDiff hunk:\n${truncate(hunk, MAX_PATCH_CHARS_PER_FILE)}`,
    `\nGoverning source (${cand.file} at ${opts.head}) — confirm whether the change is gated (checkExtraFeatures / rules().enabled / apiVersion) or unconditional:\n${source}`,
  ].join('\n')

  try {
    const text = await callModel(client, STAGE2_PROMPT, user)
    const v = parseJson<Verdict>(text, '{', '}')
    if (
      !v ||
      typeof v.statement !== 'string' ||
      typeof v.classification !== 'string'
    ) {
      return null
    }
    return v
  } catch (err: unknown) {
    opts.logger?.warn('Breaking stage-2 verify failed for candidate', {
      file: cand.file,
      error: getErrorMessage(err),
    })
    return null
  }
}

/** Fetch the file at the head tag (cached); grep gate lines if it's huge. */
async function loadGoverningSource(
  opts: DetectBreakingOptions,
  file: string,
  cache: Map<string, string | null>
): Promise<string> {
  if (!cache.has(file)) {
    let text: string | null = null
    try {
      text = await getFileAtRef(
        `${opts.owner}/${opts.repo}`,
        file,
        opts.head,
        opts.githubToken
      )
    } catch (err: unknown) {
      opts.logger?.warn('Failed to fetch governing source', {
        file,
        error: getErrorMessage(err),
      })
    }
    cache.set(file, text)
  }
  const text = cache.get(file) ?? null
  if (!text) return '(source unavailable)'
  return text.length <= MAX_FILE_CHARS ? text : grepGateContext(text)
}

const GATE_LINE =
  /checkExtraFeatures|rules\(\)\.enabled|rules\.enabled|\.enabled\(fix|\.enabled\(feature|ammEnabled|apiVersion/

/** For oversized files, keep only gate-relevant lines (±3 context). */
function grepGateContext(text: string): string {
  const lines = text.split('\n')
  const keep = new Set<number>()
  lines.forEach((l, i) => {
    if (GATE_LINE.test(l)) {
      for (let j = i - 3; j <= i + 3; j++) keep.add(j)
    }
  })
  const idx = [...keep]
    .filter((i) => i >= 0 && i < lines.length)
    .sort((a, b) => a - b)
  return idx.length
    ? idx.map((i) => lines[i]).join('\n')
    : '(no gate markers found)'
}

function isPriorityFile(file: DiffFile): boolean {
  return PRIORITY_PATHS.some((re) => re.test(file.filename))
}

function buildPatchBlock(files: DiffFile[]): string {
  const blocks: string[] = []
  let total = 0
  for (const file of files) {
    if (!isPriorityFile(file) || !file.patch) continue
    const patch = truncate(file.patch, MAX_PATCH_CHARS_PER_FILE)
    if (total + patch.length > MAX_TOTAL_PATCH_CHARS) {
      blocks.push(`### ${file.filename}\n…remaining patches omitted (budget)`)
      break
    }
    total += patch.length
    blocks.push(`### ${file.filename}\n${patch}`)
  }
  return blocks.join('\n\n') || '(no priority-path patches)'
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n…truncated' : s
}

function parseJson<T>(text: string, open: string, close: string): T | null {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

async function callModel(
  client: Anthropic,
  system: string,
  user: string
): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  })
  return extractText(res, 'breaking')
}

export interface SummarizeBreakingOptions {
  owner: string
  repo: string
  tag: string
  apiKey: string
  githubToken?: string
  logger?: Logger
  /**
   * Override the baseline for the NEW-SURFACE section only (an explicit tag, or
   * null for "no baseline"). Default: the last STABLE release. Breaking-on-
   * upgrade is ALWAYS computed vs the previous tag and ignores this — we never
   * run it against a far, 300-file-capped diff.
   */
  surfaceBase?: string | null
}

/**
 * End-to-end detection for a tag. New SDK surface is the cumulative delta vs the
 * last STABLE release (buildReference — full-file set-diff, no truncation, base
 * doesn't reset each beta). Breaking-on-upgrade is the incremental AI scan vs the
 * previous tag. Both degrade independently: a failure in either leaves that
 * section empty rather than blocking the post.
 */
export async function summarizeBreakingForTag(
  opts: SummarizeBreakingOptions
): Promise<BreakingResult> {
  const { owner, repo, tag, githubToken, logger } = opts

  // New surface: cumulative vs the last STABLE release (or an explicit override).
  const surfaceBase =
    opts.surfaceBase !== undefined
      ? opts.surfaceBase
      : await findLastFinalTag(owner, repo, tag, githubToken)
  // Breaking-on-upgrade: ALWAYS incremental vs the previous tag — a small,
  // reliable diff (no compare-cap truncation). Each breaking change is caught
  // once, on the tag that introduced it; never recomputed from a far diff.
  const breakingBase = await findPreviousTag(owner, repo, tag, githubToken)

  // (B) New surface vs surfaceBase.
  const surface = await loadSurface(opts, surfaceBase ?? null)

  // (A) Breaking-on-upgrade vs breakingBase.
  let commits: CommitSummary[] = []
  let files: DiffFile[] = []
  if (breakingBase) {
    const compare = await fetchCompare(
      owner,
      repo,
      breakingBase,
      tag,
      githubToken
    )
    if (compare) {
      commits = compare.commits
      files = compare.files
    }
  } else {
    logger?.info('No baseline — skipping breaking-on-upgrade scan', { tag })
  }

  if (
    commits.length === 0 &&
    surface.added.length === 0 &&
    surface.addedAmendments.length === 0
  ) {
    return NO_BREAKING
  }

  return detectBreakingChanges({
    commits,
    files,
    base: breakingBase ?? '(none)',
    head: tag,
    owner,
    repo,
    apiKey: opts.apiKey,
    githubToken,
    logger,
    surface,
  })
}

/** New surface vs `base`, via the parity reference. Never throws. */
async function loadSurface(
  opts: SummarizeBreakingOptions,
  base: string | null
): Promise<SurfaceDelta> {
  const { owner, repo, tag, githubToken, logger } = opts
  try {
    const ref = await buildReference({
      repo: `${owner}/${repo}`,
      tag,
      predecessorTag: base,
      githubToken,
      logger,
    })
    return {
      added: ref.added,
      addedAmendments: ref.addedAmendments,
      addedUnsupportedAmendments: ref.addedUnsupportedAmendments,
    }
  } catch (err: unknown) {
    logger?.warn('New-surface build failed — omitting surface section', {
      tag,
      error: getErrorMessage(err),
    })
    return { added: [], addedAmendments: [], addedUnsupportedAmendments: [] }
  }
}
