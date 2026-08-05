import type { Logger } from 'winston'
import type { MattermostPayload } from '../notifications/mattermost'
import type { VersionType } from '../version/types'
import { getFileAtRef, listDir, searchCode } from '../github/client'
import { getErrorMessage } from '../utils/error'
import type { Reference } from './reference'
import type { DocsTarget } from './sdks'
import {
  docsChecklist,
  fullDocsChecklist,
  txPagePath,
  pseudoTxPagePath,
  ledgerPagePath,
  checkTxPage,
  checkLedgerEntryPage,
  checkAmendment,
  checkField,
  TX_DIR,
  PSEUDO_TX_DIR,
  LEDGER_DIR,
  KNOWN_AMENDMENTS_PATH,
  SIDEBARS_PATH,
  COMMON_LINKS_PATH,
  TX_COMMON_FIELDS_PATH,
  LEDGER_COMMON_FIELDS_PATH,
} from './docs'
import type { DocVerdict, DocFeature } from './docs'
import { attachInProgressPRs } from './match'
import { formatDocsReport } from './docsReport'

/**
 * Documentation-parity check against the xrpl.org source repo. Fully
 * deterministic — the dev-portal's path/format conventions (see docs.ts) are
 * verified by fetching a handful of files; no agent call. A delta run costs
 * ~5 + N GitHub fetches for N new features.
 *
 * Returns null when there is nothing to check (no predecessor baseline or an
 * empty delta) or when the check fails — it NEVER throws, so a docs failure
 * can't affect the SDK parity report running alongside it.
 */

export interface RunDocsCheckInput {
  reference: Reference
  versionType: VersionType
  mode: 'delta' | 'full'
  docs: DocsTarget
  githubToken?: string
  logger: Logger
}

/** Above this many gaps (full sweeps of a lagging backlog), skip the per-gap
 * open-PR annotation — one score per gap against every open PR is all noise. */
const PR_ANNOTATION_MAX_GAPS = 15

export async function runDocsCheck(
  input: RunDocsCheckInput
): Promise<MattermostPayload | null> {
  const { reference, versionType, mode, docs, githubToken, logger } = input
  try {
    const checklist =
      mode === 'full' ? fullDocsChecklist(reference) : docsChecklist(reference)
    if (checklist.length === 0) {
      logger.info('Docs parity: nothing to check', {
        tag: reference.tag,
        mode,
      })
      return null
    }

    const verdicts =
      mode === 'full'
        ? await fullVerdicts(checklist, docs, githubToken)
        : await deltaVerdicts(checklist, docs, githubToken)

    const gaps = verdicts.filter(
      (v) => v.level !== 'documented' && v.kind !== 'field'
    )
    if (gaps.length > 0 && gaps.length <= PR_ANNOTATION_MAX_GAPS) {
      await attachInProgressPRs(docs.repo, gaps, githubToken, logger)
    }

    logger.info('Docs parity check complete', {
      tag: reference.tag,
      mode,
      checked: verdicts.length,
      gaps: gaps.length,
    })

    return formatDocsReport({
      versionType,
      reference,
      verdicts,
      mode,
      docsRepo: docs.repo,
    })
  } catch (err: unknown) {
    logger.error('Docs parity check failed', {
      tag: reference.tag,
      error: getErrorMessage(err),
    })
    return null
  }
}

/**
 * Delta: fetch the three registries + both common-fields pages once, plus each
 * new feature's conventional page (transactions fall back to the
 * pseudo-transaction directory on 404). Fetched pages double as the candidate
 * set for the field checks.
 */
async function deltaVerdicts(
  checklist: DocFeature[],
  docs: DocsTarget,
  githubToken?: string
): Promise<DocVerdict[]> {
  const { repo, ref } = docs
  const fetch = (path: string): Promise<string | null> =>
    getFileAtRef(repo, path, ref, githubToken)

  const txFeatures = checklist.filter((f) => f.kind === 'transactionType')
  const ledgerFeatures = checklist.filter((f) => f.kind === 'ledgerEntryType')
  const fieldFeatures = checklist.filter((f) => f.kind === 'field')
  const amendmentFeatures = checklist.filter((f) => f.kind === 'amendment')

  const [sidebars, knownAmendments, commonLinks, txCommon, ledgerCommon] =
    await Promise.all([
      fetch(SIDEBARS_PATH),
      amendmentFeatures.length > 0 ? fetch(KNOWN_AMENDMENTS_PATH) : null,
      fetch(COMMON_LINKS_PATH),
      fieldFeatures.length > 0 ? fetch(TX_COMMON_FIELDS_PATH) : null,
      fieldFeatures.length > 0 ? fetch(LEDGER_COMMON_FIELDS_PATH) : null,
    ])

  const txPages = await Promise.all(
    txFeatures.map(async (f) => {
      const page = await fetch(txPagePath(f.name))
      const pseudoPage =
        page === null ? await fetch(pseudoTxPagePath(f.name)) : null
      return { name: f.name, page, pseudoPage }
    })
  )
  const ledgerPages = await Promise.all(
    ledgerFeatures.map(async (f) => ({
      name: f.name,
      page: await fetch(ledgerPagePath(f.name)),
    }))
  )

  const verdicts: DocVerdict[] = [
    ...txPages.map((p) =>
      checkTxPage(
        p.name,
        p.page,
        p.pseudoPage,
        sidebars ?? '',
        commonLinks ?? ''
      )
    ),
    ...ledgerPages.map((p) =>
      checkLedgerEntryPage(p.name, p.page, sidebars ?? '', commonLinks ?? '')
    ),
    ...amendmentFeatures.map((f) =>
      checkAmendment(f.name, f.votable ?? true, knownAmendments ?? '')
    ),
  ]

  // Field candidates: every page fetched this run + the two common-fields pages.
  const candidates = [
    ...txPages.flatMap((p) => {
      const path =
        p.page !== null ? txPagePath(p.name) : pseudoTxPagePath(p.name)
      const content = p.page ?? p.pseudoPage
      return content !== null ? [{ path, content }] : []
    }),
    ...ledgerPages.flatMap((p) =>
      p.page !== null ? [{ path: ledgerPagePath(p.name), content: p.page }] : []
    ),
    ...(txCommon !== null
      ? [{ path: TX_COMMON_FIELDS_PATH, content: txCommon }]
      : []),
    ...(ledgerCommon !== null
      ? [{ path: LEDGER_COMMON_FIELDS_PATH, content: ledgerCommon }]
      : []),
  ]

  for (const f of fieldFeatures) {
    let verdict = checkField(f.name, candidates)
    if (verdict.level === 'unknown') {
      // Last resort: repo-wide code search. A hit anywhere under docs/ is
      // weaker evidence than a table row but beats a false "not found".
      const hits = await searchCode(
        docs.repo,
        `"${f.name}" path:docs`,
        githubToken
      )
      if (hits.length > 0) {
        verdict = {
          ...verdict,
          level: 'documented',
          checks: { foundIn: hits.map((h) => h.path) },
          evidence: [`mentioned in ${hits[0].path} (code search)`],
        }
      }
    }
    verdicts.push(verdict)
  }

  return verdicts
}

/**
 * Full sweep: three directory listings give the complete page inventories, so
 * page existence is set membership instead of per-page fetches. Common-links
 * granularity is skipped — existence + nav registration is the signal here.
 */
async function fullVerdicts(
  checklist: DocFeature[],
  docs: DocsTarget,
  githubToken?: string
): Promise<DocVerdict[]> {
  const { repo, ref } = docs

  const [txDir, pseudoDir, ledgerDir, sidebars, knownAmendments] =
    await Promise.all([
      listDir(repo, TX_DIR, ref, githubToken),
      listDir(repo, PSEUDO_TX_DIR, ref, githubToken),
      listDir(repo, LEDGER_DIR, ref, githubToken),
      getFileAtRef(repo, SIDEBARS_PATH, ref, githubToken),
      getFileAtRef(repo, KNOWN_AMENDMENTS_PATH, ref, githubToken),
    ])

  const pageSet = (entries: { name: string }[] | null): Set<string> =>
    new Set(
      (entries ?? [])
        .map((e) => e.name)
        .filter((n) => n.endsWith('.md') && n !== 'index.md')
    )
  const txPages = pageSet(txDir)
  const pseudoPages = pageSet(pseudoDir)
  const ledgerPages = pageSet(ledgerDir)

  const pageVerdict = (
    name: string,
    kind: 'transactionType' | 'ledgerEntryType'
  ): DocVerdict => {
    const isTx = kind === 'transactionType'
    const file = `${name.toLowerCase()}.md`
    const isPseudo = isTx && !txPages.has(file) && pseudoPages.has(file)
    const exists = isTx ? txPages.has(file) || isPseudo : ledgerPages.has(file)
    const path = isPseudo
      ? pseudoTxPagePath(name)
      : isTx
        ? txPagePath(name)
        : ledgerPagePath(name)

    if (!exists) {
      return {
        name,
        kind,
        level: 'missing',
        checks: { pageExists: false },
        evidence: [`no page at ${path}`],
      }
    }
    const inNav = (sidebars ?? '').includes(`page: ${path}`)
    return {
      name,
      kind,
      level: inNav ? 'documented' : 'partial',
      checks: { pageExists: true, inNav, ...(isPseudo ? { isPseudo } : {}) },
      evidence: inNav ? [] : ['page exists but not in sidebars.yaml nav'],
    }
  }

  return checklist.map((f): DocVerdict => {
    if (f.kind === 'amendment') {
      return checkAmendment(f.name, f.votable ?? true, knownAmendments ?? '')
    }
    if (f.kind === 'field') {
      // fullDocsChecklist never emits fields; guard for safety.
      return checkField(f.name, [])
    }
    return pageVerdict(f.name, f.kind)
  })
}
