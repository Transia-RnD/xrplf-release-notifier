import type { Logger } from 'winston'
import { runDocsCheck } from '../../../src/parity/runDocsCheck'
import * as client from '../../../src/github/client'
import type { Reference } from '../../../src/parity/reference'
import { VersionType } from '../../../src/version/types'

const DOCS = { repo: 'XRPLF/xrpl-dev-portal', ref: 'master' }

function logger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger
}

function ref(overrides: Partial<Reference> = {}): Reference {
  return {
    repo: 'XRPLF/rippled',
    tag: '3.2.0',
    predecessorTag: '3.1.3',
    full: {
      transactionTypes: ['Payment', 'Batch'],
      ledgerEntryTypes: ['Credential'],
      fields: ['DomainID'],
      amendments: ['Batch'],
      unsupportedAmendments: [],
    },
    added: [
      { name: 'Batch', kind: 'transactionType' },
      { name: 'Credential', kind: 'ledgerEntryType' },
      { name: 'DomainID', kind: 'field' },
    ],
    addedAmendments: ['Batch'],
    addedUnsupportedAmendments: [],
    baselineMissing: false,
    ...overrides,
  }
}

const SIDEBARS = [
  'page: docs/references/protocol/transactions/types/batch.md',
  'page: docs/references/protocol/ledger-data/ledger-entry-types/credential.md',
].join('\n')

const COMMON_LINKS = [
  '[Batch transaction]: /docs/references/protocol/transactions/types/batch.md',
  '[Credential entry]: /docs/references/protocol/ledger-data/ledger-entry-types/credential.md',
].join('\n')

const KNOWN_AMENDMENTS = `
### Batch
[Batch]: #batch

| Amendment    | Batch |
|:-------------|:------|
| Amendment ID | ABC   |
`

/** getFileAtRef mock keyed by path; unknown paths 404 (null). */
function mockFiles(files: Record<string, string>) {
  return jest
    .spyOn(client, 'getFileAtRef')
    .mockImplementation((_repo, path) => Promise.resolve(files[path] ?? null))
}

const HAPPY_FILES: Record<string, string> = {
  'sidebars.yaml': SIDEBARS,
  'resources/known-amendments.md': KNOWN_AMENDMENTS,
  'docs/_snippets/common-links.md': COMMON_LINKS,
  'docs/references/protocol/transactions/common-fields.md': '# Common\n',
  'docs/references/protocol/ledger-data/common-fields.md': '# Common\n',
  'docs/references/protocol/transactions/types/batch.md':
    '# Batch\n| `DomainID` | String | Hash256 | No | x |\n',
  'docs/references/protocol/ledger-data/ledger-entry-types/credential.md':
    '# Credential\n',
}

afterEach(() => jest.restoreAllMocks())

describe('runDocsCheck (delta)', () => {
  it('returns null without fetching when the checklist is empty', async () => {
    const spy = jest.spyOn(client, 'getFileAtRef')
    const payload = await runDocsCheck({
      reference: ref({ baselineMissing: true }),
      versionType: VersionType.FINAL,
      mode: 'delta',
      docs: DOCS,
      logger: logger(),
    })
    expect(payload).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports all-documented from conventional paths, reusing pages for fields', async () => {
    mockFiles(HAPPY_FILES)
    const search = jest.spyOn(client, 'searchCode')
    jest.spyOn(client, 'listPullRequests').mockResolvedValue([])

    const payload = await runDocsCheck({
      reference: ref(),
      versionType: VersionType.FINAL,
      mode: 'delta',
      docs: DOCS,
      logger: logger(),
    })

    expect(payload?.attachments?.[0].color).toBe('#4CAF50')
    // The field was found in the fetched Batch page — no code-search fallback.
    expect(search).not.toHaveBeenCalled()
    // No gaps -> no PR listing either.
    expect(client.listPullRequests).not.toHaveBeenCalled()
  })

  it('falls back to the pseudo-transaction directory only on a types/ 404', async () => {
    const spy = mockFiles({
      ...HAPPY_FILES,
      'docs/references/protocol/transactions/types/batch.md':
        undefined as unknown as string,
      'docs/references/protocol/transactions/pseudo-transaction-types/batch.md':
        '# Batch\n| `DomainID` | x |\n',
    })
    jest.spyOn(client, 'searchCode').mockResolvedValue([])
    jest.spyOn(client, 'listPullRequests').mockResolvedValue([])

    await runDocsCheck({
      reference: ref(),
      versionType: VersionType.FINAL,
      mode: 'delta',
      docs: DOCS,
      logger: logger(),
    })

    const paths = spy.mock.calls.map((c) => c[1])
    expect(paths).toContain(
      'docs/references/protocol/transactions/pseudo-transaction-types/batch.md'
    )
    // Credential resolved on the first try -> no pseudo lookup for it.
    expect(paths).not.toContain(
      'docs/references/protocol/ledger-data/ledger-entry-types/credential.md.pseudo'
    )
  })

  it('uses code search only for fields not found in candidates, and annotates PRs for gaps', async () => {
    mockFiles({
      ...HAPPY_FILES,
      // Batch page gone -> tx gap; field no longer found in any candidate.
      'docs/references/protocol/transactions/types/batch.md':
        undefined as unknown as string,
    })
    const search = jest
      .spyOn(client, 'searchCode')
      .mockResolvedValue([{ path: 'docs/somewhere.md' }])
    jest.spyOn(client, 'listPullRequests').mockResolvedValue([
      {
        number: 42,
        title: 'Document Batch transaction',
        body: '',
        branch: 'batch-docs',
        url: '',
      },
    ])

    const payload = await runDocsCheck({
      reference: ref(),
      versionType: VersionType.FINAL,
      mode: 'delta',
      docs: DOCS,
      logger: logger(),
    })

    expect(search).toHaveBeenCalledWith(
      DOCS.repo,
      '"DomainID" path:docs',
      undefined
    )
    const text = payload?.attachments?.[0].text ?? ''
    expect(text).toContain('🔴 `Batch` (tx)')
    expect(text).toContain('PR #42 in progress')
    // Field upgraded to documented via the search hit.
    expect(text).toContain('✅ `DomainID` (field)')
  })

  it('returns null and logs when a fetch blows up', async () => {
    jest.spyOn(client, 'getFileAtRef').mockRejectedValue(new Error('boom'))
    const log = logger()
    const payload = await runDocsCheck({
      reference: ref(),
      versionType: VersionType.FINAL,
      mode: 'delta',
      docs: DOCS,
      logger: log,
    })
    expect(payload).toBeNull()
    expect(log.error).toHaveBeenCalled()
  })
})

describe('runDocsCheck (full)', () => {
  it('uses directory listings instead of per-page fetches', async () => {
    const listDirSpy = jest
      .spyOn(client, 'listDir')
      .mockImplementation((_repo, path) => {
        if (path.endsWith('/types'))
          return Promise.resolve([
            { name: 'payment.md', path: '', type: 'file' },
            { name: 'batch.md', path: '', type: 'file' },
            { name: 'index.md', path: '', type: 'file' },
          ])
        if (path.endsWith('pseudo-transaction-types'))
          return Promise.resolve([])
        return Promise.resolve([
          { name: 'credential.md', path: '', type: 'file' },
        ])
      })
    const fileSpy = mockFiles({
      'sidebars.yaml':
        SIDEBARS +
        '\npage: docs/references/protocol/transactions/types/payment.md',
      'resources/known-amendments.md': KNOWN_AMENDMENTS,
    })
    jest.spyOn(client, 'listPullRequests').mockResolvedValue([])

    const payload = await runDocsCheck({
      reference: ref(),
      versionType: VersionType.FINAL,
      mode: 'full',
      docs: DOCS,
      logger: logger(),
    })

    expect(listDirSpy).toHaveBeenCalledTimes(3)
    // Only sidebars + known-amendments fetched — never a page.
    const fetched = fileSpy.mock.calls.map((c) => c[1])
    expect(fetched.sort()).toEqual([
      'resources/known-amendments.md',
      'sidebars.yaml',
    ])
    expect(payload?.attachments?.[0].pretext).toContain('tx pages: 2/2')
    expect(payload?.attachments?.[0].text).toContain(
      'fields not audited in full mode'
    )
  })
})
