import { readFileSync, readdirSync, existsSync } from 'fs'
import path from 'path'
import {
  parseSpec,
  parseKnownAmendmentXls,
  resolveAll,
} from '../../../src/parity/xls'
import type { Spec } from '../../../src/parity/xls'
import {
  parseAmendments,
  parseUnsupportedAmendments,
} from '../../../src/parity/reference'
import { loadXlsMap } from '../../../src/parity/sdks'

/**
 * The mapping-coverage guard: every feature amendment must resolve to a spec.
 * A new amendment that resolves to nothing is reported as an XLS-1 §3.1
 * violation, which is either true (and worth a loud report) or a missing alias
 * (and a false alarm) — so this runs against the real local checkouts and
 * fails the suite rather than letting a false 🔴 reach Mattermost.
 *
 * Skipped when the sibling checkouts aren't present, so CI without them stays
 * green; scripts/xls-mapping-audit.ts is the same check with readable output.
 */

const HOME = process.env.HOME ?? ''
const XRPLD = path.join(HOME, 'projects/xrplf/xrpld')
const STANDARDS = path.join(HOME, 'projects/xrplf/XRPL-Standards')
const DEV_PORTAL = path.join(HOME, 'projects/xrplf/xrpl-dev-portal')

const FEATURES = path.join(XRPLD, 'include/xrpl/protocol/detail/features.macro')
const available = existsSync(FEATURES) && existsSync(STANDARDS)
const describeIfLocal = available ? describe : describe.skip

describeIfLocal('amendment -> XLS coverage (local checkouts)', () => {
  function specs(): Spec[] {
    return readdirSync(STANDARDS)
      .map((dir) => {
        const readme = path.join(STANDARDS, dir, 'README.md')
        return existsSync(readme)
          ? parseSpec(dir, readFileSync(readme, 'utf8'))
          : null
      })
      .filter((s): s is Spec => s !== null)
  }

  it('resolves every in-scope amendment to a spec', () => {
    const macro = readFileSync(FEATURES, 'utf8')
    const knownAmendmentsPath = path.join(
      DEV_PORTAL,
      'resources/known-amendments.md'
    )
    const knownAmendmentXls = existsSync(knownAmendmentsPath)
      ? parseKnownAmendmentXls(readFileSync(knownAmendmentsPath, 'utf8'))
      : {}

    const { aliases, legacy } = loadXlsMap()
    const amendments = [
      ...parseAmendments(macro).map((name) => ({ name, votable: true })),
      ...parseUnsupportedAmendments(macro).map((name) => ({
        name,
        votable: false,
      })),
    ]

    const unresolved = resolveAll(amendments, {
      specs: specs(),
      aliases,
      knownAmendmentXls,
    })
      .filter(
        (m) =>
          !m.spec &&
          !m.isFix &&
          !legacy.includes(m.amendment) &&
          !legacy.includes(m.base)
      )
      .map((m) => m.amendment)

    expect(unresolved).toEqual([])
  })

  it('keeps every alias pointing at a spec that exists', () => {
    const numbers = new Set(specs().map((s) => s.number))
    const dangling = Object.entries(loadXlsMap().aliases).filter(
      ([, number]) => !numbers.has(number)
    )
    expect(dangling).toEqual([])
  })
})
