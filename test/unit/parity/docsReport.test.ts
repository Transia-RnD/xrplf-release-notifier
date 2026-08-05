import { formatDocsReport } from '../../../src/parity/docsReport'
import type { DocVerdict } from '../../../src/parity/docs'
import { VersionType } from '../../../src/version/types'
import type { Reference } from '../../../src/parity/reference'

const REFERENCE: Reference = {
  repo: 'XRPLF/rippled',
  tag: '3.2.0',
  predecessorTag: '3.1.3',
  full: {
    transactionTypes: ['Payment', 'Batch'],
    ledgerEntryTypes: ['Credential'],
    fields: [],
    amendments: ['Batch'],
    unsupportedAmendments: [],
  },
  added: [{ name: 'Batch', kind: 'transactionType' }],
  addedAmendments: ['Batch'],
  addedUnsupportedAmendments: [],
  baselineMissing: false,
}

function verdict(overrides: Partial<DocVerdict> = {}): DocVerdict {
  return {
    name: 'Batch',
    kind: 'transactionType',
    level: 'documented',
    checks: {},
    evidence: [],
    ...overrides,
  }
}

function input(
  verdicts: DocVerdict[],
  versionType = VersionType.FINAL,
  mode: 'delta' | 'full' = 'delta'
) {
  return {
    versionType,
    reference: REFERENCE,
    verdicts,
    mode,
    docsRepo: 'XRPLF/xrpl-dev-portal',
  }
}

describe('formatDocsReport (delta)', () => {
  it('final release with a missing page is red', () => {
    const payload = formatDocsReport(
      input([verdict({ level: 'missing', evidence: ['no page at x'] })])
    )
    expect(payload.username).toBe('docs parity')
    expect(payload.attachments?.[0].color).toBe('#F44336')
    expect(payload.attachments?.[0].pretext).toContain('not documented')
    expect(payload.attachments?.[0].text).toContain('🔴 `Batch` (tx): missing')
  })

  it('prerelease gaps are amber, not red', () => {
    const payload = formatDocsReport(
      input([verdict({ level: 'missing' })], VersionType.BETA)
    )
    expect(payload.attachments?.[0].color).toBe('#FF9800')
    expect(payload.attachments?.[0].pretext).toContain('docs should prepare')
  })

  it('all documented is green', () => {
    const payload = formatDocsReport(input([verdict()]))
    expect(payload.attachments?.[0].color).toBe('#4CAF50')
    expect(payload.attachments?.[0].pretext).toContain(
      'all new features documented'
    )
  })

  it('field unknowns alone never drive severity', () => {
    const payload = formatDocsReport(
      input([
        verdict(),
        verdict({ name: 'DomainID', kind: 'field', level: 'unknown' }),
      ])
    )
    expect(payload.attachments?.[0].color).toBe('#4CAF50')
    expect(payload.attachments?.[0].text).toContain('⚪ `DomainID` (field)')
  })

  it('renders an in-progress PR annotation', () => {
    const payload = formatDocsReport(
      input([
        verdict({ level: 'missing', inProgressPR: { number: 2712, score: 5 } }),
      ])
    )
    expect(payload.attachments?.[0].text).toContain('PR #2712 in progress')
  })

  it('sorts gaps before documented entries and truncates past the cap', () => {
    const many = [
      verdict(),
      ...Array.from({ length: 20 }, (_, i) =>
        verdict({ name: `Missing${i}`, level: 'missing' as const })
      ),
    ]
    const text = formatDocsReport(input(many)).attachments?.[0].text ?? ''
    expect(text.startsWith('🔴')).toBe(true)
    expect(text).toContain('…and 6 more')
  })

  it('neutral post when there is nothing to check', () => {
    const payload = formatDocsReport(input([]))
    expect(payload.attachments?.[0].color).toBe('#9E9E9E')
    expect(payload.attachments?.[0].pretext).toContain('no protocol features')
  })
})

describe('formatDocsReport (full)', () => {
  it('summarizes per-kind coverage, field-table alignment, and lists gaps', () => {
    const payload = formatDocsReport(
      input(
        [
          verdict({ name: 'Payment', checks: { missingFields: [] } }),
          verdict({ name: 'Batch', level: 'missing' }),
          verdict({
            name: 'Credential',
            kind: 'ledgerEntryType',
            level: 'partial',
            checks: { missingFields: ['Subject'] },
            evidence: ['field table missing: `Subject`'],
          }),
          verdict({ name: 'Batch', kind: 'amendment' }),
        ],
        VersionType.FINAL,
        'full'
      )
    )
    const att = payload.attachments?.[0]
    expect(att?.pretext).toContain('tx pages: 1/2')
    expect(att?.pretext).toContain('ledger entries: 0/1')
    expect(att?.pretext).toContain('amendments: 1/1')
    // Two pages carried an auditable spec; only Payment's table aligns.
    expect(att?.pretext).toContain('field tables aligned: 1/2')
    expect(att?.color).toBe('#FF9800')
    expect(att?.text).toContain('🔴 `Batch` (tx)')
    expect(att?.text).toContain('🟠 `Credential` (ledger)')
  })

  it('clean full sweep is green', () => {
    const payload = formatDocsReport(
      input([verdict({ name: 'Payment' })], VersionType.FINAL, 'full')
    )
    const att = payload.attachments?.[0]
    expect(att?.color).toBe('#4CAF50')
    expect(att?.text).toContain('checks out')
  })
})
