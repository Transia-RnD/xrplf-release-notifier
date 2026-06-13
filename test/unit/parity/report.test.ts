import { formatParityReport } from '../../../src/parity/report'
import type { SdkReport } from '../../../src/parity/report'
import type { Reference } from '../../../src/parity/reference'
import type { SdkParityResult } from '../../../src/parity/runSdkAgent'
import { VersionType } from '../../../src/version/types'

function makeReference(overrides: Partial<Reference> = {}): Reference {
  return {
    repo: 'XRPLF/rippled',
    tag: '2.2.0',
    predecessorTag: '2.1.0',
    full: {
      transactionTypes: [],
      ledgerEntryTypes: [],
      fields: [],
      amendments: [],
    },
    added: [{ name: 'MPTokenIssuanceCreate', kind: 'transactionType' }],
    addedAmendments: ['MPTokensV2'],
    baselineMissing: false,
    ...overrides,
  }
}

function makeResult(
  level2: SdkParityResult['features'][0]['level2']
): SdkParityResult {
  return {
    repo: 'XRPLF/xrpl.js',
    ref: 'main',
    resolvedLocations: { definitions: 'd.json', models: [], registries: [] },
    runtimeDefinitions: false,
    features: [
      {
        name: 'MPTokenIssuanceCreate',
        kind: 'transactionType',
        level1Serialization: true,
        level2,
        evidence: ['some/path.ts'],
      },
    ],
    notes: '',
  }
}

function text(payload: {
  attachments?: { color?: string; pretext?: string; text?: string }[]
}) {
  const att = payload.attachments?.[0]
  return { color: att?.color, pretext: att?.pretext, body: att?.text }
}

describe('formatParityReport', () => {
  it('reports a missing predecessor baseline honestly (not "all good")', () => {
    const payload = formatParityReport({
      versionType: VersionType.FINAL,
      reference: makeReference({
        added: [],
        addedAmendments: [],
        baselineMissing: true,
        predecessorTag: '2.2.3',
      }),
      sdks: [],
    })
    const { color, pretext } = text(payload)
    expect(color).toBe('#9E9E9E')
    expect(pretext).toContain('predecessor')
  })

  it('is neutral when the release adds no new features', () => {
    const payload = formatParityReport({
      versionType: VersionType.FINAL,
      reference: makeReference({ added: [], addedAmendments: [] }),
      sdks: [],
    })
    const { color, pretext } = text(payload)
    expect(color).toBe('#9E9E9E')
    expect(pretext).toContain('no new')
  })

  it('flags a FINAL release red when an SDK is not at parity', () => {
    const sdks: SdkReport[] = [
      {
        name: 'xrpl.js',
        repo: 'XRPLF/xrpl.js',
        result: makeResult('declared-only'),
      },
    ]
    const payload = formatParityReport({
      versionType: VersionType.FINAL,
      reference: makeReference(),
      sdks,
    })
    const { color, body } = text(payload)
    expect(color).toBe('#F44336')
    expect(body).toContain('declared-only')
    expect(body).toContain('MPTokenIssuanceCreate')
  })

  it('is a warning (orange) for pre-releases regardless of gaps', () => {
    const sdks: SdkReport[] = [
      { name: 'xrpl.js', repo: 'XRPLF/xrpl.js', result: makeResult('missing') },
    ]
    const payload = formatParityReport({
      versionType: VersionType.RC,
      reference: makeReference(),
      sdks,
    })
    expect(text(payload).color).toBe('#FF9800')
  })

  it('is green when all SDKs are at parity on a FINAL', () => {
    const sdks: SdkReport[] = [
      {
        name: 'xrpl.js',
        repo: 'XRPLF/xrpl.js',
        result: makeResult('supported'),
      },
    ]
    const payload = formatParityReport({
      versionType: VersionType.FINAL,
      reference: makeReference(),
      sdks,
    })
    const { color, body } = text(payload)
    expect(color).toBe('#4CAF50')
    expect(body).toContain('✅ at parity')
  })

  it('renders a full-parity audit: type counts + field coverage', () => {
    const reference = makeReference({
      full: {
        transactionTypes: ['Payment', 'MPTokenIssuanceCreate'],
        ledgerEntryTypes: ['MPTokenIssuance'],
        fields: ['A', 'B', 'C'],
        amendments: [],
      },
    })
    const sdks: SdkReport[] = [
      {
        name: 'xrpl-rust',
        repo: 'XRPLF/xrpl-rust',
        result: {
          repo: 'XRPLF/xrpl-rust',
          ref: 'main',
          resolvedLocations: { definitions: 'd', models: [], registries: [] },
          runtimeDefinitions: false,
          features: [
            {
              name: 'Payment',
              kind: 'transactionType',
              level1Serialization: true,
              level2: 'supported',
              evidence: ['x'],
            },
            {
              name: 'MPTokenIssuanceCreate',
              kind: 'transactionType',
              level1Serialization: true,
              level2: 'declared-only',
              evidence: ['d'],
            },
            {
              name: 'MPTokenIssuance',
              kind: 'ledgerEntryType',
              level1Serialization: false,
              level2: 'missing',
              evidence: [],
            },
          ],
          notes: '',
        },
        fieldsLevel1: { present: 2, total: 3, missing: ['C'] },
      },
    ]
    const payload = formatParityReport({
      versionType: VersionType.FINAL,
      reference,
      sdks,
      mode: 'full',
    })
    const { color, pretext, body } = text(payload)
    expect(pretext).toContain('Full SDK parity audit')
    expect(color).toBe('#FF9800') // anyBehind -> warn
    expect(body).toContain('1/3 types supported')
    expect(body).toContain('2 gaps')
    expect(body).toContain('fields: 2/3 in definitions.json (1 missing)')
  })

  it('surfaces a per-SDK error without failing the whole report', () => {
    const sdks: SdkReport[] = [
      { name: 'xrpl-rust', repo: 'XRPLF/xrpl-rust', error: 'definitions 404' },
    ]
    const payload = formatParityReport({
      versionType: VersionType.FINAL,
      reference: makeReference(),
      sdks,
    })
    const { color, body } = text(payload)
    expect(color).toBe('#F44336')
    expect(body).toContain('check failed: definitions 404')
  })
})
