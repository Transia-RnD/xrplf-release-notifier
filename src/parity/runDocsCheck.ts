import type { Logger } from 'winston'
import type { MattermostPayload } from '../notifications/mattermost'
import type { VersionType } from '../version/types'
import { getFileAtRef, listDir, searchCode } from '../github/client'
import { getErrorMessage } from '../utils/error'
import type { Reference, Feature } from './reference'
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
  checkFieldTable,
  commonDocFields,
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
 * verified by fetching the relevant files, and each page's field table is
 * diffed against the type's macro field spec; no agent call.
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

/** Concurrent GitHub fetches per batch (full mode reads ~100 pages). */
const FETCH_BATCH = 15

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
        ? await fullVerdicts(checklist, reference, docs, githubToken)
        : await deltaVerdicts(checklist, reference, docs, githubToken)

    const gaps = verdicts.filter(
      (v) => v.level === 'missing' || v.level === 'partial'
    )
    const prTargets = gaps.filter((v) => v.kind !== 'field')
    if (prTargets.length > 0 && prTargets.length <= PR_ANNOTATION_MAX_GAPS) {
      await attachInProgressPRs(docs.repo, prTargets, githubToken, logger)
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

/** Run `fn` over items with bounded concurrency (GitHub secondary limits). */
async function inBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += FETCH_BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + FETCH_BATCH).map(fn))))
  }
  return out
}

/** Candidate doc paths for a field's owning type (tx may be a pseudo-tx). */
function ownerPagePaths(owner: Feature): string[] {
  return owner.kind === 'transactionType'
    ? [txPagePath(owner.name), pseudoTxPagePath(owner.name)]
    : [ledgerPagePath(owner.name)]
}

/**
 * Delta: fetch the three registries + both common-fields pages once, plus each
 * new feature's conventional page (transactions fall back to the
 * pseudo-transaction directory on 404). Each fetched page's field table is
 * diffed against the type's macro spec. New fields are checked on their OWNING
 * pages (resolved from the macro specs) — including existing pages a field was
 * added to — so "field documented" means a row on the right page, not a
 * mention somewhere.
 */
async function deltaVerdicts(
  checklist: DocFeature[],
  reference: Reference,
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

  const txPages = await inBatches(txFeatures, async (f) => {
    const page = await fetch(txPagePath(f.name))
    const pseudoPage =
      page === null ? await fetch(pseudoTxPagePath(f.name)) : null
    return { name: f.name, page, pseudoPage }
  })
  const ledgerPages = await inBatches(ledgerFeatures, async (f) => ({
    name: f.name,
    page: await fetch(ledgerPagePath(f.name)),
  }))

  const txSpecs = reference.full.txFields ?? {}
  const leSpecs = reference.full.ledgerEntryFields ?? {}
  const knownFields = new Set(reference.full.fields)

  const verdicts: DocVerdict[] = [
    ...txPages.map((p) =>
      checkTxPage(
        p.name,
        p.page,
        p.pseudoPage,
        sidebars ?? '',
        commonLinks ?? '',
        txSpecs[p.name],
        knownFields
      )
    ),
    ...ledgerPages.map((p) =>
      checkLedgerEntryPage(
        p.name,
        p.page,
        sidebars ?? '',
        commonLinks ?? '',
        leSpecs[p.name],
        knownFields
      )
    ),
    ...amendmentFeatures.map((f) =>
      checkAmendment(f.name, f.votable ?? true, knownAmendments ?? '')
    ),
  ]

  // Page contents fetched this run, keyed by repo path — the owner-page pool
  // for field checks.
  const pageContents = new Map<string, string>()
  for (const p of txPages) {
    if (p.page !== null) pageContents.set(txPagePath(p.name), p.page)
    else if (p.pseudoPage !== null)
      pageContents.set(pseudoTxPagePath(p.name), p.pseudoPage)
  }
  for (const p of ledgerPages) {
    if (p.page !== null) pageContents.set(ledgerPagePath(p.name), p.page)
  }

  // Owner pages not already fetched (a new field on an EXISTING type — e.g.
  // sfDomainID added to Payment means payment.md must gain a row).
  const ownersToFetch = new Map<string, Feature>()
  for (const f of fieldFeatures) {
    for (const owner of reference.fieldOwners?.[f.name] ?? []) {
      if (!ownerPagePaths(owner).some((p) => pageContents.has(p))) {
        ownersToFetch.set(`${owner.kind}:${owner.name}`, owner)
      }
    }
  }
  await inBatches([...ownersToFetch.values()], async (owner) => {
    for (const path of ownerPagePaths(owner)) {
      const content = await fetch(path)
      if (content !== null) {
        pageContents.set(path, content)
        return
      }
    }
  })

  const commonCandidates = [
    ...(txCommon !== null
      ? [{ path: TX_COMMON_FIELDS_PATH, content: txCommon }]
      : []),
    ...(ledgerCommon !== null
      ? [{ path: LEDGER_COMMON_FIELDS_PATH, content: ledgerCommon }]
      : []),
  ]

  for (const f of fieldFeatures) {
    const owners = reference.fieldOwners?.[f.name] ?? []
    if (owners.length > 0) {
      verdicts.push(fieldOnOwnerPages(f.name, owners, pageContents))
      continue
    }

    // No owning format (ledger header / metadata fields): best-effort only.
    let verdict = checkField(f.name, commonCandidates)
    if (verdict.level === 'unknown') {
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
 * Field verdict against its owning pages. Decisive both ways: a row on an
 * owner page = documented; owner pages that exist without the row = missing
 * (a real doc gap that drives severity); owner pages that don't exist yet =
 * missing, subsumed by that page's own gap line.
 */
function fieldOnOwnerPages(
  name: string,
  owners: Feature[],
  pageContents: Map<string, string>
): DocVerdict {
  const rowRe = new RegExp(
    `^\\|.*\`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`.*\\|`,
    'm'
  )
  const foundIn: string[] = []
  const lacking: string[] = []
  const unwritten: string[] = []
  for (const owner of owners) {
    const paths = ownerPagePaths(owner)
    const path = paths.find((p) => pageContents.has(p))
    const content = path === undefined ? undefined : pageContents.get(path)
    if (path === undefined || content === undefined) {
      unwritten.push(paths[0])
    } else if (rowRe.test(content)) {
      foundIn.push(path)
    } else {
      lacking.push(path)
    }
  }

  if (foundIn.length > 0) {
    return {
      name,
      kind: 'field',
      level: 'documented',
      checks: { foundIn },
      evidence: [],
    }
  }
  const evidence =
    lacking.length > 0
      ? lacking.map((p) => `no \`${name}\` row on ${p}`)
      : [`owning page(s) not written: ${unwritten.join(', ')}`]
  return {
    name,
    kind: 'field',
    level: 'missing',
    checks: { foundIn: [] },
    evidence,
  }
}

/**
 * Full sweep: three directory listings give the complete page inventories,
 * then every EXISTING page is fetched (batched) and its field table diffed
 * against the macro spec — the complete docs-vs-protocol alignment picture.
 * Common-links granularity is skipped; existence + nav + field alignment is
 * the signal here.
 */
async function fullVerdicts(
  checklist: DocFeature[],
  reference: Reference,
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

  const txSpecs = reference.full.txFields ?? {}
  const leSpecs = reference.full.ledgerEntryFields ?? {}
  const knownFields = new Set(reference.full.fields)

  // Resolve each page-backed feature to its existing page path (or null).
  const pageFeatures = checklist.filter(
    (f) => f.kind === 'transactionType' || f.kind === 'ledgerEntryType'
  )
  const resolved = pageFeatures.map((f) => {
    const file = `${f.name.toLowerCase()}.md`
    if (f.kind === 'transactionType') {
      if (txPages.has(file)) return { f, path: txPagePath(f.name) }
      if (pseudoPages.has(file))
        return { f, path: pseudoTxPagePath(f.name), pseudo: true }
      return { f, path: null }
    }
    return ledgerPages.has(file)
      ? { f, path: ledgerPagePath(f.name) }
      : { f, path: null }
  })

  const contents = new Map<string, string>()
  await inBatches(
    resolved.filter((r) => r.path !== null),
    async (r) => {
      const content = await getFileAtRef(repo, r.path, ref, githubToken)
      if (content !== null) contents.set(r.path, content)
    }
  )

  const pageVerdicts = resolved.map(({ f, path, pseudo }): DocVerdict => {
    if (path === null) {
      const expected =
        f.kind === 'transactionType'
          ? txPagePath(f.name)
          : ledgerPagePath(f.name)
      return {
        name: f.name,
        kind: f.kind,
        level: 'missing',
        checks: { pageExists: false },
        evidence: [`no page at ${expected}`],
      }
    }

    const checks: NonNullable<DocVerdict['checks']> = {
      pageExists: true,
      inNav: (sidebars ?? '').includes(`page: ${path}`),
      ...(pseudo ? { isPseudo: true } : {}),
    }
    const evidence: string[] = []
    if (!checks.inNav) evidence.push('page exists but not in sidebars.yaml nav')

    const spec =
      f.kind === 'transactionType' ? txSpecs[f.name] : leSpecs[f.name]
    const content = contents.get(path)
    let aligned = true
    if (spec && spec.length > 0 && content !== undefined) {
      const { missing, extra } = checkFieldTable(spec, content, {
        common: commonDocFields(f.kind),
        knownFields,
      })
      checks.missingFields = missing
      checks.extraFields = extra
      if (missing.length > 0) {
        aligned = false
        const shown = missing.slice(0, 6).map((n) => `\`${n}\``)
        const more = missing.length - shown.length
        evidence.push(
          `field table missing: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
        )
      }
      if (extra.length > 0) {
        const shown = extra.slice(0, 4).map((n) => `\`${n}\``)
        const more = extra.length - shown.length
        evidence.push(
          `documents fields the format doesn't define: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
        )
      }
    }

    return {
      name: f.name,
      kind: f.kind,
      level: checks.inNav && aligned ? 'documented' : 'partial',
      checks,
      evidence,
    }
  })

  const amendmentVerdicts = checklist
    .filter((f) => f.kind === 'amendment')
    .map((f) =>
      checkAmendment(f.name, f.votable ?? true, knownAmendments ?? '')
    )

  return [...pageVerdicts, ...amendmentVerdicts]
}
