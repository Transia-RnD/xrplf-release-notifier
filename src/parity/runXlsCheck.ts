import type { Logger } from 'winston'
import type { MattermostPayload } from '../notifications/mattermost'
import type { VersionType } from '../version/types'
import {
  getFileAtRef,
  listDir,
  listTree,
  lastCommitDate,
} from '../github/client'
import { getErrorMessage } from '../utils/error'
import type { Reference } from './reference'
import type { XlsTarget, XlsMap } from './sdks'
import { KNOWN_AMENDMENTS_PATH } from './docs'
import type { DocsTarget } from './sdks'
import {
  parseSpec,
  parseSpecDir,
  parseKnownAmendmentXls,
  resolveAll,
  extractResultCodes,
} from './xls'
import type { Spec, SpecMatch } from './xls'
import {
  checkCoverage,
  checkDrift,
  lintProcess,
  withFindings,
} from './xlsChecks'
import type { XlsVerdict } from './xlsChecks'
import { attachInProgressPRs } from './match'
import { formatXlsReport } from './xlsReport'

/**
 * Specification-parity check: does each amendment in the code still match the
 * XLS it was approved under? Fully deterministic — the verdicts come from
 * xlsChecks.ts, and this module only decides WHAT to fetch.
 *
 * The standards repo holds ~80 specs, so a delta run lists the directory once,
 * resolves what it can from directory names alone, and reads only the README
 * bodies it needs. A full sweep reads every spec — hence monthly, not per
 * release.
 *
 * Returns null when there is nothing to check, and never throws: an XLS failure
 * must not affect the SDK or docs reports running alongside it.
 */

export interface RunXlsCheckInput {
  reference: Reference
  versionType: VersionType
  mode: 'delta' | 'full'
  xls: XlsTarget
  /** Source of the amendment -> XLS links on known-amendments.md. */
  docs: DocsTarget
  xlsMap: XlsMap
  githubToken?: string
  logger: Logger
}

/** Concurrent GitHub fetches per batch. */
const FETCH_BATCH = 15
/** Above this many gaps, per-gap open-PR annotation is all noise. */
const PR_ANNOTATION_MAX_GAPS = 12
/**
 * Transactor sources read per run to verify cited result codes. Bounded because
 * a full sweep would otherwise read one file per type across every spec; when
 * the cap bites it is logged rather than silently narrowing the check.
 */
const MAX_TRANSACTOR_FETCHES = 40
/** Draft specs given a staleness lookup on a full sweep (one call each). */
const MAX_STALENESS_LOOKUPS = 30

export async function runXlsCheck(
  input: RunXlsCheckInput
): Promise<MattermostPayload | null> {
  const { reference, versionType, mode, xls, logger } = input
  try {
    const amendments = checklist(input)
    if (amendments.length === 0) {
      logger.info('XLS parity: nothing to check', { tag: reference.tag, mode })
      return null
    }

    const { matches, specs } = await resolveMatches(amendments, input)
    const verdicts = await buildVerdicts(matches, input)

    const gaps = verdicts.filter(
      (v) =>
        v.level === 'missing' || v.findings.some((f) => f.severity !== 'info')
    )
    if (gaps.length > 0 && gaps.length <= PR_ANNOTATION_MAX_GAPS) {
      await annotateOpenSpecPRs(gaps, xls.repo, input)
    }

    logger.info('XLS parity check complete', {
      tag: reference.tag,
      mode,
      checked: verdicts.filter((v) => v.level !== 'exempt').length,
      gaps: gaps.length,
    })

    return formatXlsReport({
      versionType,
      reference,
      verdicts,
      mode,
      xlsRepo: xls.repo,
      orphanSpecs: mode === 'full' ? orphanSpecs(matches, specs) : undefined,
    })
  } catch (err: unknown) {
    logger.error('XLS parity check failed', {
      tag: reference.tag,
      error: getErrorMessage(err),
    })
    return null
  }
}

/**
 * Annotate gaps with an open standards-repo PR that may already fix them.
 * Matching is on the spec's `XLS-<n>` label rather than the amendment name —
 * that is how PRs against the standards repo are titled.
 */
async function annotateOpenSpecPRs(
  gaps: XlsVerdict[],
  repo: string,
  input: RunXlsCheckInput
): Promise<void> {
  const targets = gaps.map((v) => ({
    name: v.spec ? `XLS-${v.spec.number}` : v.amendment,
    inProgressPR: null as XlsVerdict['inProgressPR'],
  }))
  await attachInProgressPRs(repo, targets, input.githubToken, input.logger)
  targets.forEach((t, i) => {
    gaps[i].inProgressPR = t.inProgressPR
  })
}

/** Delta: amendments new in this release. Full: every amendment the ref defines. */
function checklist(
  input: RunXlsCheckInput
): { name: string; votable: boolean }[] {
  const { reference, mode } = input
  const [votable, unsupported] =
    mode === 'full'
      ? [reference.full.amendments, reference.full.unsupportedAmendments]
      : [reference.addedAmendments, reference.addedUnsupportedAmendments]
  return [
    ...votable.map((name) => ({ name, votable: true })),
    ...unsupported.map((name) => ({ name, votable: false })),
  ]
}

/**
 * Resolve amendments to specs, reading as few README bodies as possible.
 * Directory names alone settle the alias, known-amendments and slug rules; the
 * title and `featureX`-mention rules need bodies, so those are fetched only
 * when something is still unresolved (or always, on a full sweep).
 */
async function resolveMatches(
  amendments: { name: string; votable: boolean }[],
  input: RunXlsCheckInput
): Promise<{ matches: SpecMatch[]; specs: Spec[] }> {
  const { xls, docs, xlsMap, githubToken, logger, mode } = input

  const [entries, knownAmendments] = await Promise.all([
    listDir(xls.repo, '', xls.ref, githubToken),
    getFileAtRef(docs.repo, KNOWN_AMENDMENTS_PATH, docs.ref, githubToken),
  ])
  if (!entries) {
    throw new Error(`Could not list ${xls.repo}@${xls.ref}`)
  }

  const dirs = entries
    .filter((e) => e.type === 'dir' && parseSpecDir(e.name) !== null)
    .map((e) => e.name)
  const knownAmendmentXls = knownAmendments
    ? parseKnownAmendmentXls(knownAmendments)
    : {}

  const specs = new Map<string, Spec>()
  const load = async (dirNames: string[]): Promise<void> => {
    const pending = dirNames.filter((d) => !specs.has(d))
    for (let i = 0; i < pending.length; i += FETCH_BATCH) {
      await Promise.all(
        pending.slice(i, i + FETCH_BATCH).map(async (dir) => {
          const readme = await getFileAtRef(
            xls.repo,
            `${dir}/README.md`,
            xls.ref,
            githubToken
          )
          const spec = readme === null ? null : parseSpec(dir, readme)
          if (spec) specs.set(dir, spec)
        })
      )
    }
  }

  // Bodyless shells are enough for the dir-name rules; the body-based rules run
  // in the second pass below.
  const shells = dirs
    .map((dir) => parseSpec(dir, ''))
    .filter((s): s is Spec => s !== null)
  const ctx = { aliases: xlsMap.aliases, knownAmendmentXls }

  let matches = resolveAll(amendments, { ...ctx, specs: shells })
  const unresolved = matches.filter(
    (m) => !m.spec && !m.isFix && !isLegacy(m, xlsMap)
  )

  if (mode === 'full' || unresolved.length > 0) {
    await load(dirs)
    logger.info('XLS parity: read all spec bodies', {
      specs: specs.size,
      reason: mode === 'full' ? 'full sweep' : 'unresolved amendments',
    })
  } else {
    await load(matches.flatMap((m) => (m.spec ? [m.spec.dir] : [])))
  }

  // Re-resolve against the loaded bodies so title/mention rules can contribute
  // and every match carries a spec with its preamble parsed.
  const loaded = dirs.map((d) => specs.get(d)).filter((s): s is Spec => !!s)
  matches = resolveAll(amendments, { ...ctx, specs: loaded })
  return { matches, specs: loaded }
}

function isLegacy(match: SpecMatch, xlsMap: XlsMap): boolean {
  return (
    xlsMap.legacy.includes(match.amendment) ||
    xlsMap.legacy.includes(match.base)
  )
}

async function buildVerdicts(
  matches: SpecMatch[],
  input: RunXlsCheckInput
): Promise<XlsVerdict[]> {
  const { reference, mode, xlsMap } = input
  const legacy = new Set(xlsMap.legacy)
  const introducedTypes = new Set(
    reference.added.filter((f) => f.kind !== 'field').map((f) => f.name)
  )

  const transactorCodes = await loadTransactorCodes(matches, input)
  const staleness = await loadStaleness(matches, input)

  // One verdict per amendment, but each spec's drift is computed once — several
  // amendment revisions (BatchV1_1, LendingProtocolV1_1) share one spec.
  const driftCache = new Map<number, ReturnType<typeof checkDrift>>()

  return matches.map((match) => {
    const verdict = checkCoverage(match, { legacy })
    if (verdict.level === 'exempt' || !match.spec) return verdict

    const spec = match.spec
    let drift = driftCache.get(spec.number)
    if (!drift) {
      drift = checkDrift({
        spec,
        reference,
        introducedTypes,
        transactorCodes: transactorCodes.get(spec.number),
      })
      driftCache.set(spec.number, drift)
    }

    const lint =
      mode === 'full'
        ? lintProcess({ spec, lastCommit: staleness.get(spec.dir) })
        : []
    return withFindings(verdict, [...drift, ...lint])
  })
}

/**
 * Result codes the transactors of each spec's types actually return, keyed by
 * spec number. Needs the source tree, which moves between releases, so paths
 * are discovered from one recursive listing rather than assumed.
 */
async function loadTransactorCodes(
  matches: SpecMatch[],
  input: RunXlsCheckInput
): Promise<Map<number, Set<string>>> {
  const { reference, githubToken, logger } = input
  const out = new Map<number, Set<string>>()

  const tree = await listTree(reference.repo, reference.tag, githubToken)
  if (!tree) {
    logger.info(
      'XLS parity: source tree unavailable — skipping code-return check'
    )
    return out
  }

  const transactors = new Map<string, string>()
  for (const path of tree) {
    if (!/(?:tx\/transactors|app\/tx\/detail)\//.test(path)) continue
    const m = /([A-Za-z0-9_]+)\.cpp$/.exec(path)
    if (m) transactors.set(m[1], path)
  }
  if (transactors.size === 0) return out

  // Plenty of documented failures come from the machinery every transaction
  // runs through rather than from its own transactor — XLS-75 documents
  // `temBAD_SIGNER`, which Transactor.cpp returns. Without these, shared-path
  // codes read as "never returned".
  const shared = tree.filter((p) =>
    /\/(?:Transactor|apply|InvariantCheck|preflight)\.cpp$/.test(p)
  )

  const txTypes = new Set(reference.full.transactionTypes)

  // Which sources each spec needs, deduped across amendment revisions.
  //
  // The corpus must cover every transaction the spec MENTIONS, not just the
  // ones with a type-scoped heading: a spec cites its result codes in prose
  // anywhere, so a corpus missing one transaction reports all of that
  // transaction's codes as never returned. If any mentioned type has no source
  // at this ref, the spec is skipped rather than half-checked.
  const wanted = new Map<number, string[]>()
  const seen = new Set<number>()
  for (const match of matches) {
    if (!match.spec || seen.has(match.spec.number)) continue
    seen.add(match.spec.number)

    const mentioned = [...txTypes].filter((t) =>
      new RegExp(`\\b${t}\\b`).test(match.spec?.body ?? '')
    )
    const missing = mentioned.filter((t) => !transactors.has(t))
    if (mentioned.length === 0) continue
    if (missing.length > 0) {
      logger.info('XLS parity: no source for a mentioned transaction', {
        spec: match.spec.dir,
        missing,
      })
      continue
    }
    wanted.set(
      match.spec.number,
      mentioned.flatMap((t) => {
        const path = transactors.get(t)
        return path === undefined ? [] : [path]
      })
    )
  }

  const budget = new Set(
    [...wanted.values()].flat().slice(0, MAX_TRANSACTOR_FETCHES)
  )
  const dropped = new Set([...wanted.values()].flat()).size - budget.size
  if (dropped > 0) {
    logger.info('XLS parity: transactor read capped', {
      read: budget.size,
      skipped: dropped,
    })
  }

  const sources = new Map<string, string>()
  const paths = [...new Set([...budget, ...shared])]
  for (let i = 0; i < paths.length; i += FETCH_BATCH) {
    await Promise.all(
      paths.slice(i, i + FETCH_BATCH).map(async (path) => {
        const src = await getFileAtRef(
          reference.repo,
          path,
          reference.tag,
          githubToken
        )
        if (src) sources.set(path, src)
      })
    )
  }

  const sharedCodes = shared.flatMap((p) =>
    extractResultCodes(sources.get(p) ?? '')
  )
  for (const [number, wantedPaths] of wanted) {
    const read = wantedPaths.filter((p) => sources.has(p))
    // Partial coverage would read as "never returned" for the unread types.
    if (read.length !== wantedPaths.length) continue
    out.set(
      number,
      new Set([
        ...sharedCodes,
        ...read.flatMap((p) => extractResultCodes(sources.get(p) ?? '')),
      ])
    )
  }
  return out
}

/** Last-commit dates for Draft specs — the §4 six-month staleness rule. */
async function loadStaleness(
  matches: SpecMatch[],
  input: RunXlsCheckInput
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (input.mode !== 'full') return out

  const drafts = [
    ...new Set(
      matches
        .filter((m) => m.spec?.preamble.status === 'Draft')
        .map((m) => m.spec?.dir)
        .filter((d): d is string => d !== undefined)
    ),
  ]
  if (drafts.length > MAX_STALENESS_LOOKUPS) {
    input.logger.info('XLS parity: staleness lookups capped', {
      checked: MAX_STALENESS_LOOKUPS,
      skipped: drafts.length - MAX_STALENESS_LOOKUPS,
    })
  }

  const targets = drafts.slice(0, MAX_STALENESS_LOOKUPS)
  for (let i = 0; i < targets.length; i += FETCH_BATCH) {
    await Promise.all(
      targets.slice(i, i + FETCH_BATCH).map(async (dir) => {
        out.set(
          dir,
          await lastCommitDate(
            input.xls.repo,
            dir,
            input.xls.ref,
            input.githubToken
          )
        )
      })
    )
  }
  return out
}

/**
 * Amendment-category specs no amendment resolved to. Not a gap on its own —
 * retired amendments leave the macro, and a spec may be implemented under a
 * differently-named amendment — so this is a review list, not a verdict.
 * Withdrawn and Deprecated specs are meant to have no amendment.
 */
function orphanSpecs(
  matches: SpecMatch[],
  specs: Spec[]
): { number: number; dir: string; status: string }[] {
  const claimed = new Set(
    matches
      .map((m) => m.spec?.number)
      .filter((n): n is number => n !== undefined)
  )
  return specs
    .filter(
      (s) =>
        s.preamble.category === 'Amendment' &&
        !claimed.has(s.number) &&
        !['Withdrawn', 'Deprecated'].includes(s.preamble.status)
    )
    .map((s) => ({
      number: s.number,
      dir: s.dir,
      status: s.preamble.status,
    }))
}
