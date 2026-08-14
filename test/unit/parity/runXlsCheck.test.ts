import type { Logger } from 'winston'
import { runXlsCheck } from '../../../src/parity/runXlsCheck'
import * as client from '../../../src/github/client'
import type { Reference } from '../../../src/parity/reference'
import type { XlsMap } from '../../../src/parity/sdks'
import { VersionType } from '../../../src/version/types'

const XLS = { repo: 'XRPLF/XRPL-Standards', ref: 'master' }
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
    tag: '3.3.0',
    predecessorTag: '3.2.1',
    full: {
      transactionTypes: ['EscrowCreate'],
      ledgerEntryTypes: ['Escrow'],
      fields: ['Amount'],
      txFields: { EscrowCreate: [{ name: 'Amount', required: true }] },
      ledgerEntryFields: {},
      flags: {
        txFlags: {},
        ledgerFlags: {},
        accountSetFlags: [],
        allFlags: ['lsfAllowTrustLineLocking'],
      },
      resultCodes: ['tecNO_PERMISSION'],
      innerObjectFields: [],
      amendments: ['TokenEscrow', 'fixThing'],
      unsupportedAmendments: [],
    },
    added: [],
    addedAmendments: ['TokenEscrow'],
    addedUnsupportedAmendments: [],
    baselineMissing: false,
    ...overrides,
  }
}

const XLS_MAP: XlsMap = { aliases: {}, legacy: [] }

const TOKEN_ESCROW_SPEC = `<pre>
  xls: 85
  title: Token Escrow
  status: Final
  category: Amendment
</pre>

## \`EscrowCreate\`

| \`Amount\` | Yes |

Fails with \`tecNO_PERMISSION\` unless \`lsfAllowTrustLineLocking\` is set.
Implemented in https://github.com/XRPLF/rippled/pull/5185.
`

const KNOWN_AMENDMENTS = `
### TokenEscrow
[TokenEscrow]: #tokenescrow

See [XLS-85](https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0085-token-escrow).
`

function mockRepo(files: Record<string, string>, dirs: string[]): void {
  jest
    .spyOn(client, 'getFileAtRef')
    .mockImplementation((_repo, path) => Promise.resolve(files[path] ?? null))
  jest
    .spyOn(client, 'listDir')
    .mockResolvedValue(dirs.map((name) => ({ name, path: name, type: 'dir' })))
  jest.spyOn(client, 'listTree').mockResolvedValue(null)
  jest.spyOn(client, 'listPullRequests').mockResolvedValue([])
}

const FILES: Record<string, string> = {
  'XLS-0085-token-escrow/README.md': TOKEN_ESCROW_SPEC,
  'resources/known-amendments.md': KNOWN_AMENDMENTS,
}
const DIRS = ['XLS-0085-token-escrow', 'CONTRIBUTING.md']

afterEach(() => jest.restoreAllMocks())

function input(overrides: Record<string, unknown> = {}) {
  return {
    reference: ref(),
    versionType: VersionType.FINAL,
    mode: 'delta' as const,
    xls: XLS,
    docs: DOCS,
    xlsMap: XLS_MAP,
    logger: logger(),
    ...overrides,
  }
}

describe('runXlsCheck (delta)', () => {
  it('returns null without fetching when no amendment is added', async () => {
    const spy = jest.spyOn(client, 'listDir')
    const payload = await runXlsCheck(
      input({ reference: ref({ addedAmendments: [] }) })
    )
    expect(payload).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports an aligned amendment green', async () => {
    mockRepo(FILES, DIRS)
    const payload = await runXlsCheck(input())
    expect(payload?.attachments?.[0].color).toBe('#4CAF50')
    expect(payload?.attachments?.[0].pretext).toContain('matches its XLS')
  })

  it('reads only the spec bodies it needs when everything resolves', async () => {
    mockRepo(
      { ...FILES, 'XLS-0030-automated-market-maker/README.md': '<pre></pre>' },
      [...DIRS, 'XLS-0030-automated-market-maker']
    )
    await runXlsCheck(input())
    const read = jest
      .mocked(client.getFileAtRef)
      .mock.calls.map((c) => c[1])
      .filter((p) => p.endsWith('README.md'))
    expect(read).toEqual(['XLS-0085-token-escrow/README.md'])
  })

  it('falls back to reading every spec when an amendment is unresolved', async () => {
    mockRepo(
      { ...FILES, 'XLS-0030-automated-market-maker/README.md': '<pre></pre>' },
      [...DIRS, 'XLS-0030-automated-market-maker']
    )
    await runXlsCheck(
      input({
        reference: ref({ addedAmendments: ['TokenEscrow', 'Whatever'] }),
      })
    )
    const read = jest
      .mocked(client.getFileAtRef)
      .mock.calls.map((c) => c[1])
      .filter((p) => p.endsWith('README.md'))
    expect(read).toContain('XLS-0030-automated-market-maker/README.md')
  })

  it('reports an amendment with no spec as a §3.1 gap', async () => {
    mockRepo(FILES, DIRS)
    const payload = await runXlsCheck(
      input({ reference: ref({ addedAmendments: ['Whatever'] }) })
    )
    expect(payload?.attachments?.[0].color).toBe('#F44336')
    expect(payload?.attachments?.[0].text).toContain('_no spec resolved_')
  })

  it('never throws — a GitHub failure yields no report', async () => {
    jest.spyOn(client, 'listDir').mockRejectedValue(new Error('boom'))
    jest.spyOn(client, 'getFileAtRef').mockResolvedValue(null)
    const log = logger()
    expect(await runXlsCheck(input({ logger: log }))).toBeNull()
    expect(log.error).toHaveBeenCalled()
  })

  it('checks result codes against the transactor when the tree is readable', async () => {
    const spec = TOKEN_ESCROW_SPEC.replace(
      'tecNO_PERMISSION',
      'tecNO_PERMISSION` and `tecFROZEN'
    )
    mockRepo(
      {
        ...FILES,
        'XLS-0085-token-escrow/README.md': spec,
        'src/libxrpl/tx/transactors/escrow/EscrowCreate.cpp':
          'return tecNO_PERMISSION;',
      },
      DIRS
    )
    jest
      .spyOn(client, 'listTree')
      .mockResolvedValue(['src/libxrpl/tx/transactors/escrow/EscrowCreate.cpp'])

    const payload = await runXlsCheck(
      input({
        reference: ref({
          full: {
            ...ref().full,
            resultCodes: ['tecNO_PERMISSION', 'tecFROZEN'],
          },
        }),
      })
    )
    expect(payload?.attachments?.[0].text).toContain('tecFROZEN')
  })
})

describe('runXlsCheck (full)', () => {
  it('sweeps every amendment and lists specs with no amendment', async () => {
    mockRepo(
      {
        ...FILES,
        'XLS-0055-remit/README.md':
          '<pre>\n  xls: 55\n  status: Final\n  category: Amendment\n</pre>',
      },
      [...DIRS, 'XLS-0055-remit']
    )
    jest.spyOn(client, 'lastCommitDate').mockResolvedValue(null)

    const payload = await runXlsCheck(input({ mode: 'full' }))
    const att = payload?.attachments?.[0]
    // TokenEscrow is checked; fixThing is exempt.
    expect(att?.pretext).toContain('amendments checked: 1')
    expect(att?.text).toContain('XLS-55')
  })
})
