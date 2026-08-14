import {
  parseSpecDir,
  parsePreamble,
  parseSpec,
  baseAmendmentName,
  isFixAmendment,
  normalizeName,
  parseKnownAmendmentXls,
  resolveSpec,
  resolveAll,
  splitSections,
  headingType,
  typeSections,
  extractFlags,
  extractResultCodes,
  extractSpecFieldNames,
} from '../../../src/parity/xls'
import type { Spec } from '../../../src/parity/xls'

// Modeled on the real specs: XLS-85 amends an existing type, XLS-65 introduces
// one, XLS-96 ships without an `xls:` header.
const TOKEN_ESCROW = `<pre>
  xls: 85
  title: Token-Enabled Escrows
  description: Escrows for IOUs and MPTs
  author: Denis Angell (@dangell7)
  status: Final
  category: Amendment
  created: 2024-11-07
</pre>

# 1. Implementation

## 1.2. Escrow Transactions and Logic

### 1.2.1. \`EscrowCreate\`

| Field    | Required? | JSON Type | Internal Type |
| -------- | --------- | --------- | ------------- |
| \`Amount\` | Yes       | Object    | Amount        |

**Failure Conditions:**

- If the issuer lacks \`lsfAllowTrustLineLocking\`, the transaction fails with \`tecNO_PERMISSION\`.
- If the token is locked (\`lsfMPTokenLock\`), it fails with \`tecFROZEN\`.

### 1.2.2. \`EscrowFinish\`

| Field | Required? | JSON Type | Internal Type |
| ----- | --------- | --------- | ------------- |
| \`Owner\` | Yes | String | AccountID |
`

const NO_NUMBER = `<pre>
  title: Confidential MPT
  status: Draft
  category: Amendment
</pre>

# Abstract
`

function spec(dir: string, body: string): Spec {
  const parsed = parseSpec(dir, body)
  if (!parsed) throw new Error(`not a spec dir: ${dir}`)
  return parsed
}

describe('parseSpecDir', () => {
  it('reads the number and slug', () => {
    expect(parseSpecDir('XLS-0085-token-escrow')).toEqual({
      number: 85,
      slug: 'token-escrow',
    })
  })

  it('rejects non-spec directories', () => {
    expect(parseSpecDir('CONTRIBUTING.md')).toBeNull()
    expect(parseSpecDir('assets')).toBeNull()
  })
})

describe('parsePreamble', () => {
  it('reads the headers in file order', () => {
    const p = parsePreamble(TOKEN_ESCROW)
    expect(p.xls).toBe(85)
    expect(p.title).toBe('Token-Enabled Escrows')
    expect(p.status).toBe('Final')
    expect(p.category).toBe('Amendment')
    expect(p.keyOrder.slice(0, 4)).toEqual([
      'xls',
      'title',
      'description',
      'author',
    ])
  })

  it('joins wrapped continuation lines onto the previous header', () => {
    const p = parsePreamble(`<pre>
  xls: 1
  description: a description that
    wraps across lines
  status: Draft
</pre>`)
    expect(p.description).toBe('a description that wraps across lines')
  })

  it('survives a spec with no xls header', () => {
    const p = parsePreamble(NO_NUMBER)
    expect(p.xls).toBeUndefined()
    expect(p.status).toBe('Draft')
    expect(p.missing).toBe(false)
  })

  it('flags a missing preamble block', () => {
    const p = parsePreamble('# Just a document\n')
    expect(p.missing).toBe(true)
    expect(p.status).toBe('Unknown')
  })

  it('reports unrecognised status and category as Unknown', () => {
    const p = parsePreamble(
      '<pre>\n  status: Reviewing\n  category: Thing\n</pre>'
    )
    expect(p.status).toBe('Unknown')
    expect(p.category).toBe('Unknown')
  })
})

describe('parseSpec', () => {
  it('takes the number from the directory, not the header', () => {
    // The directory is authoritative — four specs ship with no `xls:` header.
    const parsed = spec('XLS-0096-confidential-mpt', NO_NUMBER)
    expect(parsed.number).toBe(96)
    expect(parsed.preamble.xls).toBeUndefined()
  })
})

describe('baseAmendmentName', () => {
  it('strips revision suffixes', () => {
    expect(baseAmendmentName('BatchV1_1')).toBe('Batch')
    expect(baseAmendmentName('MPTokensV1')).toBe('MPTokens')
    expect(baseAmendmentName('PermissionDelegationV1_1')).toBe(
      'PermissionDelegation'
    )
  })

  it('leaves plain names alone', () => {
    expect(baseAmendmentName('TokenEscrow')).toBe('TokenEscrow')
    expect(baseAmendmentName('AMM')).toBe('AMM')
  })
})

describe('isFixAmendment', () => {
  it('recognises fix amendments', () => {
    expect(isFixAmendment('fixDirectoryLimit')).toBe(true)
    expect(isFixAmendment('TokenEscrow')).toBe(false)
  })
})

describe('normalizeName', () => {
  it('reduces to lowercase alphanumerics', () => {
    expect(normalizeName('token-escrow')).toBe('tokenescrow')
    expect(normalizeName('Token-Enabled Escrows')).toBe('tokenenabledescrows')
  })
})

describe('parseKnownAmendmentXls', () => {
  const page = `
### TokenEscrow
[TokenEscrow]: #tokenescrow

Extends escrow to tokens. See [XLS-85](https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0085-token-escrow).

### DynamicMPT

See [XLS-94 Dynamic MPTs](https://opensource.ripple.com/docs/xls-94-dynamic-mpts).

### fixUniversalNumber

Fixes rounding in the [XLS-30](https://github.com/XRPLF/XRPL-Standards) AMM code.

### MultiSign

No spec — predates the process.
`

  it('links amendments to their XLS number in either link form', () => {
    const map = parseKnownAmendmentXls(page)
    expect(map.TokenEscrow).toBe(85)
    expect(map.DynamicMPT).toBe(94)
  })

  it('skips fix amendments, whose prose cites the spec they fix', () => {
    expect(parseKnownAmendmentXls(page).fixUniversalNumber).toBeUndefined()
  })

  it('omits amendments with no XLS reference', () => {
    expect(parseKnownAmendmentXls(page).MultiSign).toBeUndefined()
  })
})

describe('resolveSpec', () => {
  const specs = [
    spec('XLS-0085-token-escrow', TOKEN_ESCROW),
    spec(
      'XLS-0033-multi-purpose-tokens',
      '<pre>\n  xls: 33\n  status: Final\n</pre>'
    ),
    spec(
      'XLS-0040-decentralized-identity',
      '<pre>\n  xls: 40\n  title: Decentralized Identity\n  status: Final\n</pre>\n\nGated on `featureDID`.'
    ),
  ]
  const ctx = { specs, aliases: {}, knownAmendmentXls: {} }

  it('prefers the hand-written alias over every inferred rule', () => {
    const m = resolveSpec('TokenEscrow', true, {
      ...ctx,
      aliases: { TokenEscrow: 33 },
    })
    expect(m.spec?.number).toBe(33)
    expect(m.via).toBe('alias')
  })

  it('uses the known-amendments link when there is no alias', () => {
    const m = resolveSpec('MPTokens', true, {
      ...ctx,
      knownAmendmentXls: { MPTokens: 33 },
    })
    expect(m.spec?.number).toBe(33)
    expect(m.via).toBe('known-amendments')
  })

  it('falls back to the directory slug', () => {
    const m = resolveSpec('TokenEscrow', true, ctx)
    expect(m.spec?.number).toBe(85)
    expect(m.via).toBe('slug')
  })

  it('matches a revision suffix against the base spec', () => {
    const m = resolveSpec('TokenEscrowV1_1', true, ctx)
    expect(m.spec?.number).toBe(85)
    expect(m.base).toBe('TokenEscrow')
  })

  it('falls back to a featureX mention when name and spec title differ', () => {
    // `DID` matches neither the "decentralized-identity" slug nor the title.
    const m = resolveSpec('DID', true, ctx)
    expect(m.spec?.number).toBe(40)
    expect(m.via).toBe('feature-mention')
  })

  it('reports an unresolved amendment rather than guessing', () => {
    const m = resolveSpec('SomethingNew', true, ctx)
    expect(m.spec).toBeUndefined()
    expect(m.via).toBeUndefined()
  })

  it('marks fix amendments so coverage can exempt them', () => {
    expect(resolveSpec('fixDirectoryLimit', true, ctx).isFix).toBe(true)
  })
})

describe('resolveAll', () => {
  it('resolves every amendment it is given', () => {
    const specs = [spec('XLS-0085-token-escrow', TOKEN_ESCROW)]
    const matches = resolveAll(
      [
        { name: 'TokenEscrow', votable: true },
        { name: 'fixTokenEscrowV1', votable: false },
      ],
      { specs, aliases: {}, knownAmendmentXls: {} }
    )
    expect(matches).toHaveLength(2)
    expect(matches[0].spec?.number).toBe(85)
    expect(matches[1].isFix).toBe(true)
  })
})

describe('splitSections', () => {
  it('keeps both the stripped and the raw heading', () => {
    const sections = splitSections('### 1.2.1. `EscrowCreate`\n\nbody\n')
    expect(sections[0].heading).toBe('1.2.1. EscrowCreate')
    expect(sections[0].rawHeading).toBe('1.2.1. `EscrowCreate`')
    expect(sections[0].level).toBe(3)
  })
})

describe('headingType', () => {
  const tx = new Set(['EscrowCreate', 'DepositPreauth', 'Payment'])
  const ledger = new Set(['Escrow', 'DepositPreauth'])

  it('prefers the longest type name in the heading', () => {
    expect(headingType('1.2.1. EscrowCreate', tx, ledger)).toEqual({
      name: 'EscrowCreate',
      kinds: ['transactionType'],
    })
  })

  it('returns both kinds for a name that is a transaction AND a ledger entry', () => {
    expect(headingType('The DepositPreauth entry', tx, ledger)).toEqual({
      name: 'DepositPreauth',
      kinds: ['transactionType', 'ledgerEntryType'],
    })
  })

  it('returns null when no known type is named', () => {
    expect(headingType('Motivation', tx, ledger)).toBeNull()
  })
})

describe('typeSections', () => {
  const tx = new Set(['EscrowCreate', 'EscrowFinish', 'DepositPreauth'])
  const ledger = new Set(['Escrow', 'DepositPreauth'])

  it('scopes each type-naming heading to its own section', () => {
    const sections = typeSections(TOKEN_ESCROW, tx, ledger)
    expect(sections.map((s) => s.name)).toEqual([
      'EscrowCreate',
      'EscrowFinish',
    ])
    expect(sections[0].body).toContain('lsfAllowTrustLineLocking')
    expect(sections[0].body).not.toContain('Owner')
  })

  it('keeps deeper unnamed sections with the type above them', () => {
    const body = `## \`EscrowCreate\`

| \`Amount\` |

### Failure conditions

fails with \`tecNO_PERMISSION\`
`
    const sections = typeSections(body, tx, ledger)
    expect(sections).toHaveLength(1)
    expect(sections[0].body).toContain('tecNO_PERMISSION')
  })

  it('does not merge two sections that share a name', () => {
    // XLS-70 documents both the DepositPreauth transaction and the entry.
    const body = `## The \`DepositPreauth\` transaction

| \`Authorize\` |

## The \`DepositPreauth\` ledger entry

| \`OwnerNode\` |
`
    const sections = typeSections(body, tx, ledger)
    expect(sections).toHaveLength(2)
    expect(sections[0].body).not.toContain('OwnerNode')
  })
})

describe('extraction helpers', () => {
  it('pulls flag names of every prefix', () => {
    expect(extractFlags(TOKEN_ESCROW)).toEqual([
      'lsfAllowTrustLineLocking',
      'lsfMPTokenLock',
    ])
  })

  it('pulls result codes', () => {
    expect(extractResultCodes(TOKEN_ESCROW)).toEqual([
      'tecNO_PERMISSION',
      'tecFROZEN',
    ])
  })

  it('reads table field names with or without the sf prefix', () => {
    const table = '| `sfLockedAmount` | Yes |\n| [`Amount`](x) | No |\n'
    expect(extractSpecFieldNames(table)).toEqual(['LockedAmount', 'Amount'])
  })
})
