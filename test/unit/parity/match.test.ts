import { computeVerdicts, attachInProgressPRs } from '../../../src/parity/match'
import { checkPresence } from '../../../src/parity/runSdkAgent'
import type { SdkInventory } from '../../../src/parity/runSdkAgent'
import * as client from '../../../src/github/client'

function inv(overrides: Partial<SdkInventory> = {}): SdkInventory {
  return {
    repo: 'XRPLF/xrpl-py',
    ref: 'main',
    resolvedLocations: { definitions: 'd.json', models: [], registries: [] },
    runtimeDefinitions: false,
    typedTransactionTypes: [],
    notes: '',
    ...overrides,
  }
}

const DEFS = JSON.stringify({
  TRANSACTION_TYPES: { Payment: 0, CheckCreate: 9 },
  LEDGER_ENTRY_TYPES: { Check: 0x43, MPToken: 0x7f },
  FIELDS: [['DomainID', {}]],
})

describe('computeVerdicts', () => {
  it('marks a typed transaction supported', () => {
    const v = computeVerdicts(
      [{ name: 'Payment', kind: 'transactionType' }],
      inv({ typedTransactionTypes: ['Payment'] }),
      DEFS
    )
    expect(v[0].level2).toBe('supported')
  })

  it('never marks a ledger type supported, even with a same-named transaction', () => {
    // SDK models Check* transactions; ledger types are out of scope entirely.
    const v = computeVerdicts(
      [{ name: 'Check', kind: 'ledgerEntryType' }],
      inv({ typedTransactionTypes: ['CheckCreate', 'CheckCash'] }),
      DEFS
    )
    // In definitions.json but ledger is never "supported" => declared-only.
    expect(v[0].level2).toBe('declared-only')
  })

  it('is missing when absent from both inventory and definitions', () => {
    const v = computeVerdicts(
      [{ name: 'Vault', kind: 'ledgerEntryType' }],
      inv(),
      DEFS
    )
    expect(v[0].level2).toBe('missing')
  })

  it('fields top out at declared-only (no typed-field layer)', () => {
    const v = computeVerdicts(
      [{ name: 'DomainID', kind: 'field' }],
      inv({ typedTransactionTypes: ['DomainID'] }), // even if mis-listed, fields never "supported"
      DEFS
    )
    expect(v[0].level2).toBe('declared-only')
  })

  it('treats all as missing when definitions could not be fetched', () => {
    const v = computeVerdicts(
      [{ name: 'Payment', kind: 'transactionType' }],
      inv(),
      null
    )
    expect(v[0].level1Serialization).toBe(false)
    expect(v[0].level2).toBe('missing')
  })
})

describe('attachInProgressPRs', () => {
  afterEach(() => jest.restoreAllMocks())

  it('annotates a gap with a stem-matching open PR', async () => {
    jest.spyOn(client, 'listPullRequests').mockResolvedValue([
      {
        number: 157,
        title: 'feat: add PermissionedDomains support (XLS-80)',
        body: '',
        branch: 'feat/xls-80',
        url: '',
      },
    ])
    const features = computeVerdicts(
      [{ name: 'PermissionedDomainSet', kind: 'transactionType' }],
      inv(),
      '{}'
    )
    await attachInProgressPRs('XRPLF/xrpl-rust', features, 'token')
    expect(features[0].inProgressPR?.number).toBe(157)
  })

  it('tolerates a PR-list failure without throwing (gap stays unannotated)', async () => {
    const spy = jest
      .spyOn(client, 'listPullRequests')
      .mockRejectedValue(new Error('rate limited'))
    // A real gap (declared-only) so attachInProgressPRs actually calls listPRs.
    const features = computeVerdicts(
      [{ name: 'MPTokenIssuanceCreate', kind: 'transactionType' }],
      inv(),
      DEFS
    )
    await attachInProgressPRs('r', features, 't')
    expect(spy).toHaveBeenCalled()
    expect(features[0].inProgressPR).toBeUndefined()
  })

  it('skips the PR lookup entirely when every feature is supported', async () => {
    const spy = jest.spyOn(client, 'listPullRequests')
    const features = computeVerdicts(
      [{ name: 'Payment', kind: 'transactionType' }],
      inv({ typedTransactionTypes: ['Payment'] }),
      DEFS
    )
    await attachInProgressPRs('r', features, 't')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('checkPresence', () => {
  afterEach(() => jest.restoreAllMocks())
  it('splits names by definitions.json presence', async () => {
    jest.spyOn(client, 'getFileAtRef').mockResolvedValue(DEFS)
    const { present, missing } = await checkPresence(
      'r',
      'main',
      'd.json',
      ['Payment', 'Nope'],
      't'
    )
    expect(present).toEqual(['Payment'])
    expect(missing).toEqual(['Nope'])
  })
})
