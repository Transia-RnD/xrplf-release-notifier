import {
  parseAmendments,
  parseUnsupportedAmendments,
  parseTransactionTypes,
  parseLedgerEntryTypes,
  parseFields,
  parseTxFieldSpecs,
  parseLedgerEntryFieldSpecs,
  buildReference,
  fullTypeChecklist,
  deltaChecklist,
} from '../../../src/parity/reference'
import type { Reference } from '../../../src/parity/reference'
import * as githubApi from '../../../src/github/client'

const FEATURES_MACRO = `
// Add new amendments to the top of this list.
XRPL_FIX    (Cleanup3_2_0,                Supported::Yes, VoteBehavior::DefaultNo)
XRPL_FEATURE(MPTokensV2,                  Supported::Yes, VoteBehavior::DefaultNo)
XRPL_FEATURE(DynamicMPT,                  Supported::No,  VoteBehavior::DefaultNo)
XRPL_RETIRE_FEATURE(MultiSign)
`

const TRANSACTIONS_MACRO = `
TRANSACTION(ttPAYMENT, 0, Payment,
    Delegation::Delegable, uint256{}, CreateAcct, ({...}))
TRANSACTION(ttMPTOKEN_ISSUANCE_CREATE, 54, MPTokenIssuanceCreate,
    Delegation::Delegable, uint256{}, NoPriv, ({
    {sfMPTokenMetadata, SoeOptional},
}))
`

const LEDGER_ENTRIES_MACRO = `
#define LEDGER_ENTRY_DUPLICATE(...) EXPAND(LEDGER_ENTRY(__VA_ARGS__))
LEDGER_ENTRY(ltNFTOKEN_OFFER, 0x0037, NFTokenOffer, nft_offer, ({...}))
LEDGER_ENTRY_DUPLICATE(ltDEPOSIT_PREAUTH, 0x0070, DepositPreauth, deposit_preauth, ({...}))
LEDGER_ENTRY(ltMPTOKEN_ISSUANCE, 0x007e, MPTokenIssuance, mpt_issuance, ({...}))
`

const SFIELDS_MACRO = `
UNTYPED_SFIELD(sfLedgerEntry,            LEDGERENTRY, 257)
TYPED_SFIELD(sfAccount,                  ACCOUNT,     1)
TYPED_SFIELD(sfLedgerEntryType,          UINT16,      1, SField::kSmdNever)
TYPED_SFIELD(sfMPTokenMetadata,          BLOB,        219)
`

describe('macro parsers', () => {
  it('parses amendments, applying the fix prefix and skipping No/retired', () => {
    expect(parseAmendments(FEATURES_MACRO)).toEqual([
      'fixCleanup3_2_0',
      'MPTokensV2',
    ])
  })

  it('parses amendments regardless of Supported casing (rippled <=3.1 used lowercase)', () => {
    const lower = `
XRPL_FIX    (Cleanup3_1_3,    Supported::yes, VoteBehavior::DefaultYes)
XRPL_FEATURE(AMM,             Supported::yes, VoteBehavior::DefaultNo)
XRPL_FEATURE(NotVotable,      Supported::no,  VoteBehavior::DefaultNo)
`
    expect(parseAmendments(lower)).toEqual(['fixCleanup3_1_3', 'AMM'])
  })

  it('parseUnsupportedAmendments captures the Supported::No (built, not votable) names', () => {
    // DynamicMPT is the lone Supported::No entry in the fixture.
    expect(parseUnsupportedAmendments(FEATURES_MACRO)).toEqual(['DynamicMPT'])
    const lower = `
XRPL_FEATURE(AMM,        Supported::yes, VoteBehavior::DefaultNo)
XRPL_FEATURE(NotVotable, Supported::no,  VoteBehavior::DefaultNo)
`
    expect(parseUnsupportedAmendments(lower)).toEqual(['NotVotable'])
  })

  it('parses transaction-type human names', () => {
    expect(parseTransactionTypes(TRANSACTIONS_MACRO)).toEqual([
      'Payment',
      'MPTokenIssuanceCreate',
    ])
  })

  it('parses ledger-entry names incl. the DUPLICATE form, skipping the #define', () => {
    expect(parseLedgerEntryTypes(LEDGER_ENTRIES_MACRO)).toEqual([
      'NFTokenOffer',
      'DepositPreauth',
      'MPTokenIssuance',
    ])
  })

  it('parses field names, stripping the sf prefix and ignoring extra args', () => {
    expect(parseFields(SFIELDS_MACRO)).toEqual([
      'LedgerEntry',
      'Account',
      'LedgerEntryType',
      'MPTokenMetadata',
    ])
  })
})

describe('field-spec block parsing', () => {
  const TX_WITH_SPECS = `
/** This transaction type executes a payment. */
TRANSACTION(ttPAYMENT, 0, Payment,
    Delegation::Delegable,
    uint256{},
    CreateAcct | MayCreateMpt,
    ({
    {sfDestination, SoeRequired},
    {sfAmount, SoeRequired, SoeMptSupported},
    {sfDomainID, SoeOptional},
}))

TRANSACTION(ttESCROW_CREATE, 1, EscrowCreate,
    Delegation::Delegable, uint256{}, NoPriv, ({
    {sfDestination, SoeRequired},
}))
`

  const LE_WITH_SPECS = `
#define LEDGER_ENTRY_DUPLICATE(...) EXPAND(LEDGER_ENTRY(__VA_ARGS__))
LEDGER_ENTRY(ltCHECK, 0x0043, Check, check, ({
    {sfAccount,              SoeRequired},
    {sfExpiration,           SoeOptional},
}))
LEDGER_ENTRY_DUPLICATE(ltDEPOSIT_PREAUTH, 0x0070, DepositPreauth, deposit_preauth, ({
    {sfAccount,              SoeRequired},
}))
`

  it('extracts per-transaction field specs with required flags', () => {
    const specs = parseTxFieldSpecs(TX_WITH_SPECS)
    expect(specs.Payment).toEqual([
      { name: 'Destination', required: true },
      { name: 'Amount', required: true },
      { name: 'DomainID', required: false },
    ])
    expect(specs.EscrowCreate).toEqual([
      { name: 'Destination', required: true },
    ])
  })

  it('extracts ledger-entry specs including the DUPLICATE form', () => {
    const specs = parseLedgerEntryFieldSpecs(LE_WITH_SPECS)
    expect(specs.Check).toEqual([
      { name: 'Account', required: true },
      { name: 'Expiration', required: false },
    ])
    expect(specs.DepositPreauth).toEqual([{ name: 'Account', required: true }])
  })

  it('tolerates elided (...) bodies as empty specs', () => {
    const specs = parseTxFieldSpecs(
      'TRANSACTION(ttPAYMENT, 0, Payment,\n    Delegation::Delegable, uint256{}, CreateAcct, ({...}))\n'
    )
    expect(specs.Payment).toEqual([])
  })
})

describe('checklists exclude ledger types (parsed for context, not checked)', () => {
  const ref: Reference = {
    repo: 'XRPLF/rippled',
    tag: '3.1.3',
    predecessorTag: '3.1.2',
    baselineMissing: false,
    addedAmendments: [],
    addedUnsupportedAmendments: [],
    full: {
      transactionTypes: ['Payment', 'MPTokenIssuanceCreate'],
      ledgerEntryTypes: ['MPTokenIssuance', 'RippleState'],
      fields: ['DomainID'],
      amendments: [],
      unsupportedAmendments: [],
    },
    added: [
      { name: 'MPTokenIssuanceCreate', kind: 'transactionType' },
      { name: 'MPTokenIssuance', kind: 'ledgerEntryType' },
      { name: 'DomainID', kind: 'field' },
    ],
  }

  it('fullTypeChecklist is transactions only', () => {
    expect(fullTypeChecklist(ref).map((f) => f.name)).toEqual([
      'Payment',
      'MPTokenIssuanceCreate',
    ])
  })

  it('deltaChecklist keeps tx + fields, drops ledger entries', () => {
    expect(deltaChecklist(ref).map((f) => `${f.name}:${f.kind}`)).toEqual([
      'MPTokenIssuanceCreate:transactionType',
      'DomainID:field',
    ])
  })
})

describe('buildReference', () => {
  const PREV_TX = `TRANSACTION(ttPAYMENT, 0, Payment, ..., ({...}))\n`
  const PREV_LE = `LEDGER_ENTRY(ltNFTOKEN_OFFER, 0x0037, NFTokenOffer, nft_offer, ({...}))\n`
  const PREV_SF = `TYPED_SFIELD(sfAccount, ACCOUNT, 1)\n`
  const PREV_FEAT = `XRPL_FEATURE(MPTokensV2, Supported::Yes, VoteBehavior::DefaultNo)\n`

  afterEach(() => jest.restoreAllMocks())

  function mockMacros(ref: string, file: string): string | null {
    const isPrev = ref === '2.1.0'
    if (file.endsWith('transactions.macro'))
      return isPrev ? PREV_TX : TRANSACTIONS_MACRO
    if (file.endsWith('ledger_entries.macro'))
      return isPrev ? PREV_LE : LEDGER_ENTRIES_MACRO
    if (file.endsWith('sfields.macro')) return isPrev ? PREV_SF : SFIELDS_MACRO
    if (file.endsWith('features.macro'))
      return isPrev ? PREV_FEAT : FEATURES_MACRO
    return null
  }

  it('computes the new-this-release delta against the predecessor', async () => {
    jest
      .spyOn(githubApi, 'getFileAtRef')
      .mockImplementation((_repo, file, ref) =>
        Promise.resolve(mockMacros(ref, file))
      )

    const ref = await buildReference({
      repo: 'XRPLF/rippled',
      tag: '2.2.0',
      predecessorTag: '2.1.0',
    })

    const names = ref.added.map((f) => `${f.name}:${f.kind}`)
    expect(names).toContain('MPTokenIssuanceCreate:transactionType')
    expect(names).toContain('MPTokenIssuance:ledgerEntryType')
    expect(names).toContain('DepositPreauth:ledgerEntryType')
    expect(names).toContain('MPTokenMetadata:field')
    // Carried over from the predecessor — not "new":
    expect(names).not.toContain('Payment:transactionType')
    expect(names).not.toContain('Account:field')
    // fixCleanup3_2_0 is new; MPTokensV2 existed before
    expect(ref.addedAmendments).toEqual(['fixCleanup3_2_0'])
    // DynamicMPT is new this release AND Supported::No — the gap signal.
    expect(ref.addedUnsupportedAmendments).toEqual(['DynamicMPT'])
    expect(ref.baselineMissing).toBe(false)
    // The new field's owning type resolved from the tag's field specs.
    expect(ref.fieldOwners?.MPTokenMetadata).toEqual([
      { name: 'MPTokenIssuanceCreate', kind: 'transactionType' },
    ])
  })

  it('does NOT re-flag an amendment that was already Supported::No in the predecessor', async () => {
    // Predecessor already carries DynamicMPT as Supported::No — a known
    // in-progress feature, not a fresh "shipped but unvotable" surprise.
    const prevWithNo =
      PREV_FEAT +
      `XRPL_FEATURE(DynamicMPT, Supported::No, VoteBehavior::DefaultNo)\n`
    jest
      .spyOn(githubApi, 'getFileAtRef')
      .mockImplementation((_repo, file, ref) => {
        if (ref === '2.1.0' && file.endsWith('features.macro'))
          return Promise.resolve(prevWithNo)
        return Promise.resolve(mockMacros(ref, file))
      })

    const ref = await buildReference({
      repo: 'XRPLF/rippled',
      tag: '2.2.0',
      predecessorTag: '2.1.0',
    })

    expect(ref.addedUnsupportedAmendments).toEqual([])
  })

  it('flags baselineMissing and empties the delta when the predecessor cannot be parsed', async () => {
    jest
      .spyOn(githubApi, 'getFileAtRef')
      .mockImplementation((_repo, file, ref) => {
        // Target tag parses; the pre-macro-refactor predecessor returns nothing.
        if (ref === '2.1.0') return Promise.resolve(null)
        return Promise.resolve(mockMacros(ref, file))
      })

    const ref = await buildReference({
      repo: 'XRPLF/rippled',
      tag: '2.2.0',
      predecessorTag: '2.1.0',
    })

    expect(ref.baselineMissing).toBe(true)
    expect(ref.added).toEqual([])
    expect(ref.addedAmendments).toEqual([])
    expect(ref.addedUnsupportedAmendments).toEqual([])
  })
})
