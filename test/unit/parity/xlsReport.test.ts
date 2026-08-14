import { formatXlsReport } from '../../../src/parity/xlsReport'
import type { XlsVerdict } from '../../../src/parity/xlsChecks'
import type { Reference } from '../../../src/parity/reference'
import { VersionType } from '../../../src/version/types'

const reference = {
  repo: 'XRPLF/rippled',
  tag: '3.3.0',
  predecessorTag: '3.2.1',
  full: {
    transactionTypes: [],
    ledgerEntryTypes: [],
    fields: [],
    amendments: [],
    unsupportedAmendments: [],
  },
  added: [],
  addedAmendments: [],
  addedUnsupportedAmendments: [],
  baselineMissing: false,
} as Reference

function verdict(overrides: Partial<XlsVerdict> = {}): XlsVerdict {
  return {
    amendment: 'TokenEscrow',
    votable: true,
    level: 'aligned',
    findings: [],
    spec: {
      number: 85,
      dir: 'XLS-0085-token-escrow',
      path: 'XLS-0085-token-escrow/README.md',
      status: 'Final',
      category: 'Amendment',
    },
    ...overrides,
  }
}

function render(
  verdicts: XlsVerdict[],
  mode: 'delta' | 'full' = 'delta',
  versionType = VersionType.FINAL
): { color?: string; pretext?: string; text?: string } {
  const payload = formatXlsReport({
    versionType,
    reference,
    verdicts,
    mode,
    xlsRepo: 'XRPLF/XRPL-Standards',
  })
  return payload.attachments?.[0] ?? {}
}

describe('formatXlsReport — delta', () => {
  it('says nothing to check when the release adds no amendment', () => {
    const att = render([])
    expect(att.color).toBe('#9E9E9E')
    expect(att.pretext).toContain('adds no feature amendment')
  })

  it('goes green when every new amendment matches its spec', () => {
    const att = render([verdict()])
    expect(att.color).toBe('#4CAF50')
    expect(att.pretext).toContain('matches its XLS')
  })

  it('goes red on a FINAL that contradicts its spec', () => {
    const att = render([
      verdict({
        level: 'drifted',
        findings: [
          { kind: 'flag', severity: 'high', message: 'names flag `lsfX`' },
        ],
      }),
    ])
    expect(att.color).toBe('#F44336')
    expect(att.pretext).toContain('1 amendment out of step')
    expect(att.text).toContain('lsfX')
  })

  it('stays amber for a prerelease', () => {
    const att = render(
      [verdict({ level: 'missing', findings: [] })],
      'delta',
      VersionType.RC
    )
    expect(att.color).toBe('#FF9800')
    expect(att.pretext).toContain('specs should catch up')
  })

  it('does not count info findings as being out of step', () => {
    const att = render([
      verdict({
        findings: [
          { kind: 'process', severity: 'info', message: 'title long' },
        ],
      }),
    ])
    expect(att.color).toBe('#4CAF50')
  })

  it('names the missing spec case explicitly', () => {
    const att = render([
      verdict({
        spec: undefined,
        level: 'missing',
        findings: [{ kind: 'coverage', severity: 'high', message: 'no XLS' }],
      }),
    ])
    expect(att.text).toContain('_no spec resolved_')
  })

  it('mentions an open standards PR when one is in flight', () => {
    const att = render([
      verdict({
        level: 'drifted',
        findings: [{ kind: 'flag', severity: 'high', message: 'bad flag' }],
        inProgressPR: { number: 412, score: 5 },
      }),
    ])
    expect(att.text).toContain('PR #412')
  })
})

describe('formatXlsReport — full', () => {
  it('summarises coverage and contradiction counts', () => {
    const payload = formatXlsReport({
      versionType: VersionType.FINAL,
      reference,
      mode: 'full',
      xlsRepo: 'XRPLF/XRPL-Standards',
      verdicts: [
        verdict(),
        verdict({
          amendment: 'DynamicMPT',
          level: 'drifted',
          findings: [
            { kind: 'flag', severity: 'high', message: 'names flag `tmfX`' },
            { kind: 'status', severity: 'medium', message: 'still Draft' },
          ],
        }),
        verdict({ amendment: 'fixThing', level: 'exempt', findings: [] }),
      ],
      orphanSpecs: [{ number: 55, dir: 'XLS-0055-remit', status: 'Final' }],
    })
    const att = payload.attachments?.[0]
    // The exempt fix amendment is not "checked".
    expect(att?.pretext).toContain('amendments checked: 2')
    expect(att?.pretext).toContain('contradictions: 1')
    expect(att?.pretext).toContain('gaps: 1')
    expect(att?.text).toContain('XLS-55')
    expect(att?.text).toContain('review, not a gap')
  })
})
