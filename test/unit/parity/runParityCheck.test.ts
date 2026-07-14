import { runParityCheck } from '../../../src/parity/runParityCheck'
import * as sdks from '../../../src/parity/sdks'
import * as reference from '../../../src/parity/reference'
import type { Reference } from '../../../src/parity/reference'
import * as agent from '../../../src/parity/runSdkAgent'
import type { SdkInventory } from '../../../src/parity/runSdkAgent'
import * as client from '../../../src/github/client'
import * as cache from '../../../src/parity/cache'
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
  })
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

    const att = payload?.attachments?.[0]
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
    const att = payload?.attachments?.[0]
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
    expect(payload?.attachments?.[0]?.text).toContain(
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
    expect(payload?.attachments?.[0]?.color).toBe('#9E9E9E')
    expect(agent.runSdkAgent).not.toHaveBeenCalled()
  })
})
