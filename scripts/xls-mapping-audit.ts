/**
 * Offline audit of the XLS-parity check, run against LOCAL checkouts so it
 * costs no GitHub calls and can be re-run freely while tuning
 * config/xls-map.yaml or the drift rules.
 *
 * Every amendment in features.macro is printed with the spec it resolved to and
 * the rule that matched, so the mapping can be eyeballed in full before any of
 * it drives a report. `--drift` additionally runs the coverage/drift/lint
 * checks and prints every finding.
 *
 * Usage:
 *   npx ts-node scripts/xls-mapping-audit.ts [--xrpld DIR] [--xls DIR] [--docs DIR]
 *   npx ts-node scripts/xls-mapping-audit.ts --drift          # all mapped specs
 *   npx ts-node scripts/xls-mapping-audit.ts --drift 85       # one spec
 *
 * Defaults assume the sibling layout under ~/projects/xrplf.
 */
import { readFileSync, readdirSync, existsSync } from 'fs'
import path from 'path'
import {
  parseAmendments,
  parseUnsupportedAmendments,
  parseTransactionTypes,
  parseLedgerEntryTypes,
  parseFields,
  parseTxFieldSpecs,
  parseLedgerEntryFieldSpecs,
  parseTxFlags,
  parseLedgerFlags,
  parseAccountSetFlags,
  parseAllFlagNames,
  parseResultCodes,
  parseInnerObjectFields,
} from '../src/parity/reference'
import type { Reference } from '../src/parity/reference'
import {
  parseSpec,
  parseKnownAmendmentXls,
  resolveAll,
} from '../src/parity/xls'
import type { Spec, SpecMatch } from '../src/parity/xls'
import {
  checkCoverage,
  checkDrift,
  lintProcess,
  withFindings,
} from '../src/parity/xlsChecks'
import { loadXlsMap } from '../src/parity/sdks'

const HOME = process.env.HOME ?? ''
const DEFAULTS = {
  xrpld: path.join(HOME, 'projects/xrplf/xrpld'),
  xls: path.join(HOME, 'projects/xrplf/XRPL-Standards'),
  docs: path.join(HOME, 'projects/xrplf/xrpl-dev-portal'),
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

function loadSpecs(root: string): Spec[] {
  const specs: Spec[] = []
  for (const dir of readdirSync(root)) {
    const readme = path.join(root, dir, 'README.md')
    if (!existsSync(readme)) continue
    const spec = parseSpec(dir, readFileSync(readme, 'utf8'))
    if (spec) specs.push(spec)
  }
  return specs.sort((a, b) => a.number - b.number)
}

/** Build a Reference straight off the local xrpld tree (no GitHub). */
function localReference(xrpldDir: string): Reference {
  const read = (rel: string): string =>
    readFileSync(path.join(xrpldDir, rel), 'utf8')
  const macro = (name: string): string =>
    read(`include/xrpl/protocol/detail/${name}.macro`)
  const transactions = macro('transactions')
  const ledgerEntries = macro('ledger_entries')
  const features = macro('features')
  const txFlagsHeader = read('include/xrpl/protocol/TxFlags.h')
  const ledgerFormats = read('include/xrpl/protocol/LedgerFormats.h')

  return {
    repo: 'local',
    tag: 'local',
    predecessorTag: null,
    full: {
      transactionTypes: parseTransactionTypes(transactions),
      ledgerEntryTypes: parseLedgerEntryTypes(ledgerEntries),
      fields: parseFields(macro('sfields')),
      txFields: parseTxFieldSpecs(transactions),
      ledgerEntryFields: parseLedgerEntryFieldSpecs(ledgerEntries),
      flags: {
        txFlags: parseTxFlags(txFlagsHeader),
        ledgerFlags: parseLedgerFlags(ledgerFormats),
        accountSetFlags: parseAccountSetFlags(txFlagsHeader),
        allFlags: [
          ...new Set([
            ...parseAllFlagNames(txFlagsHeader),
            ...parseAllFlagNames(ledgerFormats),
          ]),
        ],
      },
      resultCodes: parseResultCodes(read('include/xrpl/protocol/TER.h')),
      innerObjectFields: parseInnerObjectFields(
        read('src/libxrpl/protocol/InnerObjectFormats.cpp')
      ),
      amendments: parseAmendments(features),
      unsupportedAmendments: parseUnsupportedAmendments(features),
    },
    added: [],
    addedAmendments: [],
    addedUnsupportedAmendments: [],
    baselineMissing: true,
  }
}

const SEVERITY_ICON: Record<string, string> = {
  high: '🔴',
  medium: '🟠',
  info: '⚪',
}

/** Print coverage + drift + lint findings for the mapped specs. */
function reportDrift(
  matches: SpecMatch[],
  reference: Reference,
  legacy: Set<string>,
  only: number | undefined
): void {
  console.log('\n' + '─'.repeat(78) + '\nDRIFT\n' + '─'.repeat(78))
  const seen = new Set<number>()
  for (const match of matches) {
    if (!match.spec || (only !== undefined && match.spec.number !== only))
      continue
    if (seen.has(match.spec.number)) continue
    seen.add(match.spec.number)

    let verdict = checkCoverage(match, { legacy })
    if (verdict.level === 'exempt') continue
    verdict = withFindings(verdict, [
      ...checkDrift({ spec: match.spec, reference }),
      ...lintProcess({ spec: match.spec }),
    ])

    console.log(
      `\nXLS-${match.spec.number} ${match.spec.dir} (${match.amendment}, ${verdict.level})`
    )
    if (verdict.findings.length === 0) console.log('  — no findings')
    for (const f of verdict.findings) {
      console.log(`  ${SEVERITY_ICON[f.severity]} [${f.kind}] ${f.message}`)
    }
  }
}

function main(): void {
  const xrpldDir = arg('xrpld', DEFAULTS.xrpld)
  const xlsDir = arg('xls', DEFAULTS.xls)
  const docsDir = arg('docs', DEFAULTS.docs)

  const features = readFileSync(
    path.join(xrpldDir, 'include/xrpl/protocol/detail/features.macro'),
    'utf8'
  )
  const knownAmendmentsPath = path.join(
    docsDir,
    'resources/known-amendments.md'
  )
  const knownAmendmentXls = existsSync(knownAmendmentsPath)
    ? parseKnownAmendmentXls(readFileSync(knownAmendmentsPath, 'utf8'))
    : {}

  const specs = loadSpecs(xlsDir)
  const { aliases, legacy } = loadXlsMap()
  const legacySet = new Set(legacy)

  const amendments = [
    ...parseAmendments(features).map((name) => ({ name, votable: true })),
    ...parseUnsupportedAmendments(features).map((name) => ({
      name,
      votable: false,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name))

  const matches = resolveAll(amendments, { specs, aliases, knownAmendmentXls })

  console.log(
    `specs: ${specs.length} · amendments: ${amendments.length} · known-amendments links: ${Object.keys(knownAmendmentXls).length}\n`
  )

  const inScope = matches.filter(
    (m) => !m.isFix && !legacySet.has(m.amendment) && !legacySet.has(m.base)
  )
  for (const m of inScope) {
    const spec = m.spec
      ? `XLS-${String(m.spec.number).padStart(2, '0')} ${m.spec.preamble.status.padEnd(10)} ${m.spec.dir}`
      : '— UNRESOLVED —'
    console.log(
      `${m.votable ? '✓' : '·'} ${m.amendment.padEnd(30)} ${(m.via ?? '').padEnd(16)} ${spec}`
    )
  }

  const unresolved = inScope.filter((m) => !m.spec)
  const exempt = matches.length - inScope.length
  console.log(
    `\nin scope: ${inScope.length} · resolved: ${inScope.length - unresolved.length} · UNRESOLVED: ${unresolved.length} · exempt (fix/legacy): ${exempt}`
  )
  if (unresolved.length > 0) {
    console.log(
      `unresolved: ${unresolved.map((m) => m.amendment).join(', ')}\n` +
        'Each needs an aliases: entry (spec exists under another name), a legacy: entry\n' +
        '(predates the XLS process), or is a genuine XLS-1 §3.1 gap.'
    )
  }

  if (process.argv.includes('--drift')) {
    const arg = process.argv[process.argv.indexOf('--drift') + 1]
    const only = arg && /^\d+$/.test(arg) ? parseInt(arg, 10) : undefined
    reportDrift(matches, localReference(xrpldDir), legacySet, only)
    return
  }

  const specsWithoutAmendment = specs.filter(
    (s) =>
      s.preamble.category === 'Amendment' &&
      !matches.some((m) => m.spec?.number === s.number)
  )
  console.log(
    `\nAmendment-category specs with no amendment in features.macro: ${specsWithoutAmendment.length}`
  )
  for (const s of specsWithoutAmendment) {
    console.log(`  ${s.preamble.status.padEnd(10)} ${s.dir}`)
  }
}

main()
