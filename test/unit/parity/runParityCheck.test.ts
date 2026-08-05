import { runParityCheck } from '../../../src/parity/runParityCheck'
import * as sdks from '../../../src/parity/sdks'
import * as reference from '../../../src/parity/reference'
import type { Reference } from '../../../src/parity/reference'
import * as agent from '../../../src/parity/runSdkAgent'
import type { SdkInventory } from '../../../src/parity/runSdkAgent'
import * as client from '../../../src/github/client'
import * as cache from '../../../src/parity/cache'
import * as docsCheck from '../../../src/parity/runDocsCheck'
import * as mm from '../../../src/notifications/mattermost'
import type { AppConfig } from '../../../src/config'
import type { VersionInfo } from '../../../src/version/types'
import { VersionType } from '../../../src/version/types'
import type { Logger } from 'winston'
import type { Storage } from '@google-cloud/storage'

const REF: Reference = {
  repo: 'XRPLF/rippled',
  tag: '3.2.0',
  predecessorTag: '3.1.0',
  baselineMissing: false,
  addedAmendments: [],
  addedUnsupportedAmendments: [],
  full: {
    transactionTypes: ['Payment', 'MPTokenIssuanceCreate'],
    ledgerEntryTypes: [],
    fields: ['F1', 'F2'],
    amendments: [],
    unsupportedAmendments: [],
  },
  added: [
    { name: 'Payment', kind: 'transactionType' },
    { name: 'MPTokenIssuanceCreate', kind: 'transactionType' },
  ],
}

// xrpl-rust models Payment but NOT MPTokenIssuanceCreate; definitions.json has both.
const INVENTORY: SdkInventory = {
  repo: 'XRPLF/xrpl-rust',
  ref: 'main',
  resolvedLocations: { definitions: 'def.json', models: [], registries: [] },
  runtimeDefinitions: false,
  typedTransactionTypes: ['Payment'],
  notes: '',
}
// definitions.json declares both tx types and both fields (serialization),
// but only Payment has a typed model (see INVENTORY).
const DEFS = '{"Payment":0,"MPTokenIssuanceCreate":54,"F1":1,"F2":2}'

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger

const deps = {
  config: {
    anthropicApiKey: 'k',
    githubToken: 't',
    mattermostWebhookUrl: '',
  } as AppConfig,
  storage: {} as Storage,
  logger,
}

const version: VersionInfo = {
  raw: '3.2.0',
  major: 3,
  minor: 2,
  patch: 0,
  type: VersionType.FINAL,
  branch: 'parity:3.2.0',
  commitSha: '',
  commitUrl: '',
}

function mockHappyPath() {
  jest.spyOn(sdks, 'loadParityConfig').mockReturnValue({
    rippled: { repo: 'XRPLF/rippled' },
    sdks: [{ name: 'xrpl-rust', repo: 'XRPLF/xrpl-rust', ref: 'main' }],
    docs: { repo: 'XRPLF/xrpl-dev-portal', ref: 'master' },
  })
  // Docs parity has its own suite (runDocsCheck.test.ts) — quiet by default.
  jest.spyOn(docsCheck, 'runDocsCheck').mockResolvedValue(null)
  jest.spyOn(reference, 'buildReference').mockResolvedValue(REF)
  jest.spyOn(agent, 'runSdkAgent').mockResolvedValue(INVENTORY)
  jest.spyOn(client, 'resolveRefSha').mockResolvedValue('sha1')
  jest.spyOn(client, 'getFileAtRef').mockResolvedValue(DEFS)
  jest.spyOn(client, 'listPullRequests').mockResolvedValue([])
  jest.spyOn(cache, 'loadLocationsCache').mockResolvedValue({})
  jest.spyOn(cache, 'saveLocationsCache').mockResolvedValue()
  jest.spyOn(cache, 'getCachedLocations').mockReturnValue(null)
  jest.spyOn(cache, 'isCacheWarm').mockReturnValue(false)
  jest.spyOn(cache, 'setCachedLocations').mockReturnValue()
}

afterEach(() => jest.restoreAllMocks())

describe('runParityCheck (orchestrator, dry run)', () => {
  it('computes per-SDK verdicts from the inventory and renders the report', async () => {
    mockHappyPath()
    const payload = await runParityCheck(version, deps, {
      mode: 'delta',
      predecessorTag: '3.1.0',
      dryRun: true,
    })

    const att = payload?.sdk?.attachments?.[0]
    expect(att).toBeDefined()
    // Payment is in the typed inventory => supported (not a gap); the other is
    // declared-only (in definitions.json, no typed model).
    expect(att?.text).toContain('MPTokenIssuanceCreate')
    expect(att?.text).toContain('declared-only')
    expect(att?.text).not.toMatch(/Payment.*declared-only/)
    // FINAL release with a gap => red.
    expect(att?.color).toBe('#F44336')
    // The agent ran exactly once for the single configured SDK.
    expect(agent.runSdkAgent).toHaveBeenCalledTimes(1)
  })

  it('full mode checks all transaction types and reports field coverage', async () => {
    mockHappyPath()
    const payload = await runParityCheck(version, deps, {
      mode: 'full',
      dryRun: true,
    })
    const att = payload?.sdk?.attachments?.[0]
    expect(att?.pretext).toContain('Full SDK parity audit')
    // Both F1, F2 present in DEFS => 2/2 fields.
    expect(att?.text).toContain('fields: 2/2 in definitions.json')
    // Payment supported, MPTokenIssuanceCreate not => 1/2 types.
    expect(att?.text).toContain('1/2 types supported')
  })

  it('surfaces a per-SDK agent failure as a check-failed line, not a crash', async () => {
    mockHappyPath()
    jest
      .spyOn(agent, 'runSdkAgent')
      .mockRejectedValue(new Error('inventory timed out'))
    const payload = await runParityCheck(version, deps, {
      mode: 'delta',
      predecessorTag: '3.1.0',
      dryRun: true,
    })
    expect(payload?.sdk?.attachments?.[0]?.text).toContain(
      'check failed: inventory timed out'
    )
  })

  it('posts to Mattermost on a real run and guards against double-processing the same version', async () => {
    mockHappyPath()
    const post = jest.spyOn(mm, 'postToMattermost').mockResolvedValue()
    const v = { ...version, raw: '9.9.9' } // unique tag to avoid the in-memory guard from other tests

    await runParityCheck(v, deps, { mode: 'delta', predecessorTag: '9.9.8' })
    expect(post).toHaveBeenCalledTimes(1)

    // The same version a second time (this process lifetime) is short-circuited.
    await runParityCheck(v, deps, { mode: 'delta', predecessorTag: '9.9.8' })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('posts nothing and returns a neutral report when there is no parseable baseline', async () => {
    mockHappyPath()
    jest.spyOn(reference, 'buildReference').mockResolvedValue({
      ...REF,
      baselineMissing: true,
      added: [],
    })
    const payload = await runParityCheck(version, deps, {
      mode: 'delta',
      dryRun: true,
    })
    expect(payload?.sdk?.attachments?.[0]?.color).toBe('#9E9E9E')
    expect(agent.runSdkAgent).not.toHaveBeenCalled()
  })
})

describe('runParityCheck (prerelease tag-burst debounce)', () => {
  const rcVersion: VersionInfo = {
    ...version,
    raw: '3.3.0-rc1',
    minor: 3,
    type: VersionType.RC,
    branch: 'parity:3.3.0-rc1',
  }

  it('skips a prerelease entirely once the line final is tagged', async () => {
    mockHappyPath()
    jest
      .spyOn(client, 'listVersionTags')
      .mockResolvedValue(['3.2.1', '3.3.0-rc1', '3.3.0'])
    const post = jest.spyOn(mm, 'postToMattermost').mockResolvedValue()

    const payload = await runParityCheck(rcVersion, deps, {
      mode: 'delta',
      dryRun: true,
    })

    expect(payload).toBeUndefined()
    expect(reference.buildReference).not.toHaveBeenCalled()
    expect(agent.runSdkAgent).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('runs a prerelease normally while its final does not exist yet', async () => {
    mockHappyPath()
    jest
      .spyOn(client, 'listVersionTags')
      .mockResolvedValue(['3.2.1', '3.3.0-rc1'])

    const payload = await runParityCheck(rcVersion, deps, {
      mode: 'delta',
      predecessorTag: '3.2.1',
      dryRun: true,
    })

    expect(payload?.sdk?.attachments?.[0]).toBeDefined()
    expect(agent.runSdkAgent).toHaveBeenCalled()
  })
})

describe('runParityCheck (docs parity integration)', () => {
  const DOCS_PAYLOAD = {
    username: 'docs parity',
    attachments: [{ fallback: 'docs', color: '#4CAF50', pretext: 'docs ok' }],
  }

  it('returns the docs payload alongside the SDK report and posts both', async () => {
    mockHappyPath()
    jest.spyOn(docsCheck, 'runDocsCheck').mockResolvedValue(DOCS_PAYLOAD)
    const post = jest.spyOn(mm, 'postToMattermost').mockResolvedValue()

    const payload = await runParityCheck({ ...version, raw: '9.8.7' }, deps, {
      mode: 'delta',
      predecessorTag: '9.8.6',
    })
    expect(payload?.docs).toEqual(DOCS_PAYLOAD)
    expect(post).toHaveBeenCalledTimes(2)
    expect(docsCheck.runDocsCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: REF,
        mode: 'delta',
        docs: { repo: 'XRPLF/xrpl-dev-portal', ref: 'master' },
      })
    )
  })

  it('docsOnly skips the SDK agents entirely but still runs the docs check', async () => {
    mockHappyPath()
    jest.spyOn(docsCheck, 'runDocsCheck').mockResolvedValue(DOCS_PAYLOAD)
    const payload = await runParityCheck(version, deps, {
      mode: 'delta',
      predecessorTag: '3.1.0',
      dryRun: true,
      docsOnly: true,
    })
    expect(agent.runSdkAgent).not.toHaveBeenCalled()
    expect(payload?.sdk).toBeUndefined()
    expect(payload?.docs).toEqual(DOCS_PAYLOAD)
  })

  it('a docs-step failure never sinks the SDK report', async () => {
    mockHappyPath()
    jest
      .spyOn(docsCheck, 'runDocsCheck')
      .mockRejectedValue(new Error('portal on fire'))
    const payload = await runParityCheck(version, deps, {
      mode: 'delta',
      predecessorTag: '3.1.0',
      dryRun: true,
    })
    expect(payload?.sdk?.attachments?.[0]).toBeDefined()
    expect(payload?.docs).toBeUndefined()
  })
})
