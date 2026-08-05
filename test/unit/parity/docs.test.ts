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
} from '../../../src/parity/docs'
import type { Reference } from '../../../src/parity/reference'

function ref(overrides: Partial<Reference> = {}): Reference {
  return {
    repo: 'XRPLF/rippled',
    tag: '3.2.0',
    predecessorTag: '3.1.3',
    full: {
      transactionTypes: ['Payment', 'Batch'],
      ledgerEntryTypes: ['AccountRoot', 'Credential'],
      fields: ['Account', 'DomainID'],
      amendments: ['Batch'],
      unsupportedAmendments: ['MPTokensV2'],
    },
    added: [
      { name: 'Batch', kind: 'transactionType' },
      { name: 'Credential', kind: 'ledgerEntryType' },
      { name: 'DomainID', kind: 'field' },
    ],
    addedAmendments: ['Batch'],
    addedUnsupportedAmendments: ['MPTokensV2'],
    baselineMissing: false,
    ...overrides,
  }
}

// Fixtures modeled on the real dev-portal files.
const SIDEBARS = `
        - page: docs/references/protocol/transactions/types/payment.md
        - page: docs/references/protocol/transactions/types/batch.md
        - page: docs/references/protocol/transactions/pseudo-transaction-types/enableamendment.md
        - page: docs/references/protocol/ledger-data/ledger-entry-types/credential.md
`

const COMMON_LINKS = `
[Batch transaction]: /docs/references/protocol/transactions/types/batch.md
[EnableAmendment pseudo-transaction]: /docs/references/protocol/transactions/pseudo-transaction-types/enableamendment.md
[Credential entry]: /docs/references/protocol/ledger-data/ledger-entry-types/credential.md
[AMM object]: /docs/references/protocol/ledger-data/ledger-entry-types/amm.md
`

const TX_PAGE = `---
seo:
    description: Submit transactions as a batch.
labels:
    - Transactions
requiredAmendment: Batch
---
# Batch

| Field | JSON Type | [Internal Type][] | Required? | Description |
|:------|:----------|:------------------|:----------|:------------|
| \`RawTransactions\` | Array | STArray | Yes | The transactions. |
`

const KNOWN_AMENDMENTS = `
## Amendments in Development

| Name | Introduced |
|:-----|:-----------|
| [MPTokensV2][] | TBD |
| [DynamicMPT][] | TBD |

## Details about Known Amendments

### Batch
[Batch]: #batch

| Amendment    | Batch |
|:-------------|:------|
| Amendment ID | ABC123 |
| Status       | Enabled |

### fixCleanup3_3_0
[fixCleanup3_3_0]: #fixcleanup3_3_0

| Amendment    | fixCleanup3_3_0 |
|:-------------|:----------------|
| Amendment ID | DEF456 |

### HeadingOnly

Some prose without an anchor or ID table.

### MPTokensV2
[MPTokensV2]: #mptokensv2

| Amendment    | MPTokensV2 |
|:-------------|:-----------|
| Amendment ID | 123ABC |
`

describe('docsChecklist', () => {
  it('includes ledger entries, fields, and both amendment lists', () => {
    const list = docsChecklist(ref())
    expect(list).toEqual([
      { name: 'Batch', kind: 'transactionType' },
      { name: 'Credential', kind: 'ledgerEntryType' },
      { name: 'DomainID', kind: 'field' },
      { name: 'Batch', kind: 'amendment', votable: true },
      { name: 'MPTokensV2', kind: 'amendment', votable: false },
    ])
  })

  it('is empty when there is no predecessor baseline', () => {
    expect(docsChecklist(ref({ baselineMissing: true }))).toEqual([])
  })
})

describe('fullDocsChecklist', () => {
  it('covers all types and amendments but never fields', () => {
    const list = fullDocsChecklist(ref())
    expect(list.map((f) => f.name)).toEqual([
      'Payment',
      'Batch',
      'AccountRoot',
      'Credential',
      'Batch',
      'MPTokensV2',
    ])
    expect(list.some((f) => f.kind === 'field')).toBe(false)
  })
})

describe('page paths', () => {
  it('lowercases the exact name with no separators', () => {
    expect(txPagePath('MPTokenIssuanceCreate')).toBe(
      'docs/references/protocol/transactions/types/mptokenissuancecreate.md'
    )
    expect(pseudoTxPagePath('EnableAmendment')).toBe(
      'docs/references/protocol/transactions/pseudo-transaction-types/enableamendment.md'
    )
    expect(ledgerPagePath('NFTokenOffer')).toBe(
      'docs/references/protocol/ledger-data/ledger-entry-types/nftokenoffer.md'
    )
  })
})

describe('checkTxPage', () => {
  it('documented when the page exists, is in nav, and in common-links', () => {
    const v = checkTxPage('Batch', TX_PAGE, null, SIDEBARS, COMMON_LINKS)
    expect(v.level).toBe('documented')
    expect(v.checks).toMatchObject({
      pageExists: true,
      inNav: true,
      inCommonLinks: true,
      h1Matches: true,
      hasRequiredAmendment: true,
    })
  })

  it('partial when the page is not registered in sidebars.yaml', () => {
    const v = checkTxPage('Batch', TX_PAGE, null, '', COMMON_LINKS)
    expect(v.level).toBe('partial')
    expect(v.evidence).toContain('page exists but not in sidebars.yaml nav')
  })

  it('partial when the common-links link-ref is absent', () => {
    const v = checkTxPage('Batch', TX_PAGE, null, SIDEBARS, '')
    expect(v.level).toBe('partial')
    expect(v.evidence).toContain('no link-ref in _snippets/common-links.md')
  })

  it('missing when neither page fetch found anything', () => {
    const v = checkTxPage('Batch', null, null, SIDEBARS, COMMON_LINKS)
    expect(v.level).toBe('missing')
    expect(v.evidence[0]).toContain('transactions/types/batch.md')
  })

  it('accepts a pseudo-transaction page and records isPseudo', () => {
    const page = '# EnableAmendment\n'
    const v = checkTxPage('EnableAmendment', null, page, SIDEBARS, COMMON_LINKS)
    expect(v.level).toBe('documented')
    expect(v.checks.isPseudo).toBe(true)
  })

  it('notes an H1 mismatch as evidence without downgrading', () => {
    const page = TX_PAGE.replace('# Batch', '# Batch Transactions')
    const v = checkTxPage('Batch', page, null, SIDEBARS, COMMON_LINKS)
    expect(v.level).toBe('documented')
    expect(v.evidence).toContain('H1 does not match `Batch`')
  })
})

describe('checkLedgerEntryPage', () => {
  const PAGE = '# Credential\n\n| `Subject` | String | AccountID | Yes | x |\n'

  it('accepts the [X entry]: link-ref form', () => {
    const v = checkLedgerEntryPage('Credential', PAGE, SIDEBARS, COMMON_LINKS)
    expect(v.level).toBe('documented')
  })

  it('accepts the legacy [X object]: link-ref form', () => {
    const sidebars =
      'page: docs/references/protocol/ledger-data/ledger-entry-types/amm.md'
    const v = checkLedgerEntryPage('AMM', '# AMM\n', sidebars, COMMON_LINKS)
    expect(v.level).toBe('documented')
  })

  it('missing without a page', () => {
    const v = checkLedgerEntryPage('Credential', null, SIDEBARS, COMMON_LINKS)
    expect(v.level).toBe('missing')
  })
})

describe('checkAmendment', () => {
  it('documented for a votable amendment with heading + anchor + ID row', () => {
    const v = checkAmendment('Batch', true, KNOWN_AMENDMENTS)
    expect(v.level).toBe('documented')
    expect(v.checks).toMatchObject({
      headingPresent: true,
      anchorPresent: true,
      idRowPresent: true,
      inDevelopmentTable: false,
    })
  })

  it('keeps underscores in the anchor (fixCleanup3_3_0 -> #fixcleanup3_3_0)', () => {
    const v = checkAmendment('fixCleanup3_3_0', true, KNOWN_AMENDMENTS)
    expect(v.checks.anchorPresent).toBe(true)
    expect(v.level).toBe('documented')
  })

  it('partial when the entry has a heading but no anchor or ID row', () => {
    const v = checkAmendment('HeadingOnly', true, KNOWN_AMENDMENTS)
    expect(v.level).toBe('partial')
    expect(v.evidence).toContain('entry heading has no link-ref anchor')
    expect(v.evidence).toContain('entry has no Amendment ID row')
  })

  it('partial when a now-votable amendment is still listed as in development', () => {
    const v = checkAmendment('MPTokensV2', true, KNOWN_AMENDMENTS)
    expect(v.level).toBe('partial')
    expect(v.evidence).toContain(
      'still listed under "Amendments in Development"'
    )
  })

  it('documented for an unvotable amendment listed as in development', () => {
    const v = checkAmendment('MPTokensV2', false, KNOWN_AMENDMENTS)
    expect(v.level).toBe('documented')
  })

  it('dev-table match requires the full name, not a prefix', () => {
    const v = checkAmendment('Dynamic', true, KNOWN_AMENDMENTS)
    expect(v.checks.inDevelopmentTable).toBe(false)
    expect(v.level).toBe('missing')
  })

  it('missing when the amendment appears nowhere on the page', () => {
    const v = checkAmendment('NopeAmendment', true, KNOWN_AMENDMENTS)
    expect(v.level).toBe('missing')
    const unvotable = checkAmendment('NopeAmendment', false, KNOWN_AMENDMENTS)
    expect(unvotable.level).toBe('missing')
  })
})

describe('checkField', () => {
  const candidates = [
    {
      path: 'docs/a.md',
      content: '# A\n| `DomainID` | String | Hash256 | No | x |\n',
    },
    {
      path: 'docs/b.md',
      content: 'Prose mentioning `DomainID` outside a table.\n',
    },
  ]

  it('documented when a table row in any candidate carries the field', () => {
    const v = checkField('DomainID', candidates)
    expect(v.level).toBe('documented')
    expect(v.checks.foundIn).toEqual(['docs/a.md'])
  })

  it('a backticked mention outside a table row does not count', () => {
    const v = checkField('DomainID', [candidates[1]])
    expect(v.level).toBe('unknown')
  })

  it('unknown (never missing) when not found anywhere we looked', () => {
    const v = checkField('Nope', candidates)
    expect(v.level).toBe('unknown')
    expect(v.evidence[0]).toContain('2 checked page(s)')
  })
})
