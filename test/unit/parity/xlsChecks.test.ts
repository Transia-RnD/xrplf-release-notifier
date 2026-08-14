import {
  checkCoverage,
  checkDrift,
  lintProcess,
  withFindings,
} from '../../../src/parity/xlsChecks'
import type { XlsFinding } from '../../../src/parity/xlsChecks'
import { parseSpec } from '../../../src/parity/xls'
import type { Spec, SpecMatch } from '../../../src/parity/xls'
import type { Reference } from '../../../src/parity/reference'

function spec(dir: string, body: string): Spec {
  const parsed = parseSpec(dir, body)
  if (!parsed) throw new Error(`not a spec dir: ${dir}`)
  return parsed
}

function reference(overrides: Partial<Reference['full']> = {}): Reference {
  return {
    repo: 'XRPLF/rippled',
    tag: '3.3.0',
    predecessorTag: '3.2.1',
    full: {
      transactionTypes: ['EscrowCreate', 'VaultCreate', 'DepositPreauth'],
      ledgerEntryTypes: ['Escrow', 'Vault', 'DepositPreauth'],
      fields: ['Amount', 'Destination', 'Owner', 'Data', 'Issuer'],
      txFields: {
        EscrowCreate: [
          { name: 'Amount', required: true },
          { name: 'Destination', required: true },
        ],
        VaultCreate: [
          { name: 'Amount', required: true },
          { name: 'Data', required: false },
        ],
        DepositPreauth: [{ name: 'Owner', required: false }],
      },
      ledgerEntryFields: {
        Vault: [{ name: 'Owner', required: true }],
        DepositPreauth: [{ name: 'Issuer', required: false }],
      },
      flags: {
        txFlags: { VaultCreate: ['tfVaultPrivate'] },
        ledgerFlags: { Vault: ['lsfVaultPrivate'] },
        accountSetFlags: ['asfRequireDest'],
        allFlags: ['tfVaultPrivate', 'lsfVaultPrivate', 'asfRequireDest'],
      },
      resultCodes: ['tecNO_PERMISSION', 'tecFROZEN', 'temMALFORMED'],
      innerObjectFields: ['Issuer'],
      amendments: ['TokenEscrow'],
      unsupportedAmendments: [],
      ...overrides,
    },
    added: [],
    addedAmendments: [],
    addedUnsupportedAmendments: [],
    baselineMissing: false,
  }
}

function match(overrides: Partial<SpecMatch> = {}): SpecMatch {
  return {
    amendment: 'TokenEscrow',
    base: 'TokenEscrow',
    votable: true,
    isFix: false,
    ...overrides,
  }
}

const FINAL_SPEC = (body = ''): Spec =>
  spec(
    'XLS-0085-token-escrow',
    `<pre>\n  xls: 85\n  title: Token Escrow\n  status: Final\n  category: Amendment\n</pre>\n${body}`
  )

const DRAFT_SPEC = (body = ''): Spec =>
  spec(
    'XLS-0065-single-asset-vault',
    `<pre>\n  xls: 65\n  title: Vault\n  status: Draft\n  category: Amendment\n</pre>\n${body}`
  )

describe('checkCoverage', () => {
  it('exempts fix amendments — XLS-1 §3.1 covers FEATURE amendments', () => {
    expect(
      checkCoverage(match({ isFix: true }), { legacy: new Set() }).level
    ).toBe('exempt')
  })

  it('exempts amendments that predate the XLS process', () => {
    const v = checkCoverage(
      match({ amendment: 'MultiSign', base: 'MultiSign' }),
      {
        legacy: new Set(['MultiSign']),
      }
    )
    expect(v.level).toBe('exempt')
  })

  it('reports an unspecified feature amendment as missing', () => {
    const v = checkCoverage(match(), { legacy: new Set() })
    expect(v.level).toBe('missing')
    expect(v.findings[0].severity).toBe('high')
    expect(v.findings[0].message).toContain('§3.1')
  })

  it('accepts a votable amendment with a Final spec', () => {
    const v = checkCoverage(match({ spec: FINAL_SPEC() }), {
      legacy: new Set(),
    })
    expect(v.level).toBe('aligned')
    expect(v.findings).toEqual([])
  })

  it('flags a votable amendment whose spec is still Draft', () => {
    const v = checkCoverage(match({ spec: DRAFT_SPEC() }), {
      legacy: new Set(),
    })
    expect(v.level).toBe('drifted')
    expect(v.findings[0].severity).toBe('medium')
    expect(v.findings[0].message).toContain('§4')
  })

  it('treats a Withdrawn spec with a votable amendment as a contradiction', () => {
    const withdrawn = spec(
      'XLS-0008-tickets',
      '<pre>\n  xls: 8\n  status: Withdrawn\n  category: Amendment\n</pre>'
    )
    const v = checkCoverage(match({ spec: withdrawn }), { legacy: new Set() })
    expect(v.findings[0].severity).toBe('high')
  })

  it('notes, without alarm, a Final spec whose amendment is not votable', () => {
    const v = checkCoverage(match({ spec: FINAL_SPEC(), votable: false }), {
      legacy: new Set(),
    })
    expect(v.level).toBe('aligned')
    expect(v.findings[0].severity).toBe('info')
  })
})

describe('checkDrift — fields', () => {
  it('flags a field the protocol does not define', () => {
    const s = FINAL_SPEC(`
## \`EscrowCreate\`

| \`Amount\` | Yes |
| \`MinBidPrice\` | No |
`)
    const findings = checkDrift({ spec: s, reference: reference() })
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: 'field',
        severity: 'high',
        message: expect.stringContaining('MinBidPrice'),
      })
    )
  })

  it('flags a real field documented under a format that lacks it', () => {
    const s = FINAL_SPEC(`
## \`EscrowCreate\`

| \`Amount\` | Yes |
| \`Data\` | No |
`)
    const findings = checkDrift({ spec: s, reference: reference() })
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: 'field',
        severity: 'medium',
        message: expect.stringContaining('`Data` under `EscrowCreate`'),
      })
    )
  })

  it('ignores inner-object members documented under their container', () => {
    const s = FINAL_SPEC(`
## \`EscrowCreate\`

| \`Amount\` | Yes |
| \`Issuer\` | No |
`)
    const findings = checkDrift({ spec: s, reference: reference() })
    expect(findings.filter((f) => f.kind === 'field')).toEqual([])
  })

  it('ignores flag-table rows — those belong to the flag check', () => {
    const s = FINAL_SPEC(`
## \`VaultCreate\`

| \`Amount\` | Yes |
| \`lsfVaultPrivate\` | — |
`)
    expect(
      checkDrift({ spec: s, reference: reference() }).filter((f) =>
        f.message.includes('lsfVaultPrivate')
      )
    ).toEqual([])
  })

  it('does not treat an amending spec table as incomplete', () => {
    // XLS-85 lists only `Amount` for EscrowCreate; Destination is not a gap.
    const s = FINAL_SPEC('\n## `EscrowCreate`\n\n| `Amount` | Yes |\n')
    const omissions = checkDrift({ spec: s, reference: reference() }).filter(
      (f) => f.message.includes('omits')
    )
    expect(omissions).toEqual([])
  })

  it('reports omissions for a type the release introduces', () => {
    const s = FINAL_SPEC('\n## `VaultCreate`\n\n| `Amount` | Yes |\n')
    const findings = checkDrift({
      spec: s,
      reference: reference(),
      introducedTypes: new Set(['VaultCreate']),
    })
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: 'field',
        severity: 'medium',
        message: expect.stringContaining('omits `Data`'),
      })
    )
  })
})

describe('checkDrift — flags and result codes', () => {
  it('flags a flag name the protocol does not define', () => {
    const s = FINAL_SPEC('\nLocking uses `lsfMPTokenLock`.\n')
    expect(checkDrift({ spec: s, reference: reference() })).toContainEqual(
      expect.objectContaining({
        kind: 'flag',
        severity: 'high',
        message: expect.stringContaining('lsfMPTokenLock'),
      })
    )
  })

  it('softens an unknown flag on a Draft spec — the spec leads the code', () => {
    const s = DRAFT_SPEC('\nLocking uses `lsfMPTokenLock`.\n')
    const flag = checkDrift({ spec: s, reference: reference() }).find(
      (f) => f.kind === 'flag'
    )
    expect(flag?.severity).toBe('medium')
  })

  it('accepts flags cited from another object in a failure condition', () => {
    const s = FINAL_SPEC('\nFails unless the issuer set `asfRequireDest`.\n')
    expect(
      checkDrift({ spec: s, reference: reference() }).filter(
        (f) => f.kind === 'flag'
      )
    ).toEqual([])
  })

  it('flags a result code TER.h does not define', () => {
    const s = FINAL_SPEC('\nFails with `terFROZEN`.\n')
    expect(checkDrift({ spec: s, reference: reference() })).toContainEqual(
      expect.objectContaining({
        kind: 'result-code',
        severity: 'high',
        message: expect.stringContaining('terFROZEN'),
      })
    )
  })

  it('hints, without alarm, at a valid code absent from the transactor', () => {
    const s = FINAL_SPEC('\n## `EscrowCreate`\n\nFails with `tecFROZEN`.\n')
    const findings = checkDrift({
      spec: s,
      reference: reference(),
      transactorCodes: new Set(['tecNO_PERMISSION']),
    })
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: 'result-code',
        severity: 'info',
        message: expect.stringContaining('tecFROZEN'),
      })
    )
  })

  it('skips the code-return check when no transactor source was read', () => {
    const s = FINAL_SPEC('\nFails with `tecFROZEN`.\n')
    expect(
      checkDrift({ spec: s, reference: reference() }).filter(
        (f) => f.kind === 'result-code'
      )
    ).toEqual([])
  })

  it('says nothing about flags when the ref predates the flag layout', () => {
    const s = FINAL_SPEC('\nUses `lsfWhatever`.\n')
    const ref = reference()
    ref.full.flags = undefined
    expect(
      checkDrift({ spec: s, reference: ref }).filter((f) => f.kind === 'flag')
    ).toEqual([])
  })
})

describe('lintProcess', () => {
  it('reports a missing preamble and stops there', () => {
    const findings = lintProcess({ spec: spec('XLS-0099-x', '# No preamble') })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('high')
  })

  it('reports a Draft with no assigned number', () => {
    const s = spec(
      'XLS-0096-confidential-mpt',
      '<pre>\n  title: Confidential MPT\n  status: Draft\n  category: Amendment\n</pre>\n# Abstract\n# Specification\n# Security Considerations'
    )
    expect(lintProcess({ spec: s })).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('no `xls:`') })
    )
  })

  it('reports a header number that disagrees with the directory', () => {
    const s = spec(
      'XLS-0085-token-escrow',
      '<pre>\n  xls: 58\n  status: Draft\n</pre>'
    )
    expect(lintProcess({ spec: s })).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('disagrees with directory'),
      })
    )
  })

  it('requires a rippled link on a Final amendment spec', () => {
    const s = FINAL_SPEC(
      '\n# Abstract\n# Specification\n# Security Considerations\n'
    )
    expect(lintProcess({ spec: s })).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('links no rippled PR/commit'),
      })
    )
  })

  it('accepts a Final spec that links its implementation', () => {
    const s = FINAL_SPEC(
      '\n# Abstract\n# Specification\n# Security Considerations\n\nImplemented in https://github.com/XRPLF/rippled/pull/5185.\n'
    )
    expect(lintProcess({ spec: s })).toEqual([])
  })

  it('reports a Draft untouched past the six-month mark', () => {
    const s = DRAFT_SPEC(
      '\n# Abstract\n# Specification\n# Security Considerations\n'
    )
    const findings = lintProcess({
      spec: s,
      lastCommit: '2025-01-01T00:00:00Z',
      now: new Date('2026-01-01T00:00:00Z'),
    })
    expect(findings).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('§4 says Stagnant'),
      })
    )
  })

  it('leaves a recently-touched Draft alone', () => {
    const s = DRAFT_SPEC(
      '\n# Abstract\n# Specification\n# Security Considerations\n'
    )
    expect(
      lintProcess({
        spec: s,
        lastCommit: '2025-12-01T00:00:00Z',
        now: new Date('2026-01-01T00:00:00Z'),
      })
    ).toEqual([])
  })
})

describe('withFindings', () => {
  const base = {
    amendment: 'TokenEscrow',
    votable: true,
    level: 'aligned' as const,
    findings: [] as XlsFinding[],
  }

  it('escalates to drifted on an actionable finding', () => {
    const v = withFindings(base, [
      { kind: 'flag', severity: 'high', message: 'x' },
    ])
    expect(v.level).toBe('drifted')
  })

  it('leaves the level alone for info-only findings', () => {
    const v = withFindings(base, [
      { kind: 'process', severity: 'info', message: 'x' },
    ])
    expect(v.level).toBe('aligned')
  })

  it('never downgrades a missing verdict', () => {
    const v = withFindings({ ...base, level: 'missing' }, [
      { kind: 'process', severity: 'info', message: 'x' },
    ])
    expect(v.level).toBe('missing')
  })
})
