import Anthropic from '@anthropic-ai/sdk'
import { runSdkAgent } from '../../../src/parity/runSdkAgent'
import * as client from '../../../src/github/client'

// Mock the Anthropic SDK default export so we can script the tool-use loop.
jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: jest.fn() }))

const createMock = jest.fn()
beforeEach(() => {
  createMock.mockReset()
  ;(Anthropic as unknown as jest.Mock).mockImplementation(() => ({
    messages: { create: createMock },
  }))
})
afterEach(() => jest.restoreAllMocks())

function toolUse(id: string, name: string, input: unknown) {
  return { type: 'tool_use', id, name, input }
}

describe('runSdkAgent (inventory)', () => {
  it('runs the tool loop and returns the validated inventory', async () => {
    jest.spyOn(client, 'listDir').mockResolvedValue([
      {
        name: 'mod.rs',
        path: 'src/models/transactions/mod.rs',
        type: 'file',
      },
    ])

    createMock
      .mockResolvedValueOnce({
        content: [
          toolUse('t1', 'listDir', { path: 'src/models/transactions' }),
        ],
      })
      .mockResolvedValueOnce({
        content: [
          toolUse('t2', 'submit_inventory', {
            repo: 'XRPLF/xrpl-rust',
            ref: 'main',
            resolvedLocations: {
              definitions: 'src/core/binarycodec/definitions/definitions.json',
              models: ['src/models/transactions'],
              registries: ['src/models/transactions/mod.rs'],
            },
            runtimeDefinitions: false,
            typedTransactionTypes: ['Payment', 'OfferCreate'],
            notes: 'transaction models under src/models/transactions',
          }),
        ],
      })

    const inventory = await runSdkAgent({
      apiKey: 'test',
      repo: 'XRPLF/xrpl-rust',
      ref: 'main',
    })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(client.listDir).toHaveBeenCalled()
    expect(inventory.typedTransactionTypes).toEqual(['Payment', 'OfferCreate'])
  })

  it('rejects a malformed inventory (schema enforced)', async () => {
    createMock.mockResolvedValueOnce({
      content: [
        toolUse('t1', 'submit_inventory', {
          // `repo` (required, no default) is missing + resolvedLocations absent
          ref: 'main',
          typedTransactionTypes: [],
          typedLedgerEntryTypes: [],
        }),
      ],
    })

    await expect(
      runSdkAgent({ apiKey: 'test', repo: 'XRPLF/xrpl.js', ref: 'main' })
    ).rejects.toThrow()
  })

  it('injects the per-SDK profile into the system prompt when sdkName is set', async () => {
    createMock.mockResolvedValueOnce({
      content: [
        toolUse('t1', 'submit_inventory', {
          repo: 'XRPLF/xrpl-rust',
          ref: 'main',
          resolvedLocations: { definitions: null, models: [], registries: [] },
          typedTransactionTypes: [],
        }),
      ],
    })

    await runSdkAgent({
      apiKey: 'k',
      repo: 'XRPLF/xrpl-rust',
      ref: 'main',
      sdkName: 'xrpl-rust',
    })

    // The real config/sdk-skills/xrpl-rust.md profile is appended to the base skill.
    const calls = createMock.mock.calls as unknown as [{ system: string }][]
    const system = calls[0][0].system
    expect(system).toContain('Profile for this SDK')
    expect(system).toContain('TransactionType') // from xrpl-rust.md profile
    expect(system).toContain('mod.rs')
  })

  it('nudges the model when it goes idle, then accepts the inventory', async () => {
    // First turn: no tool_use (model "thinks"); second turn: submits.
    createMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'looking…' }] })
      .mockResolvedValueOnce({
        content: [
          toolUse('t1', 'submit_inventory', {
            repo: 'XRPLF/xrpl.js',
            ref: 'main',
            resolvedLocations: {
              definitions: null,
              models: [],
              registries: [],
            },
            typedTransactionTypes: ['Payment'],
          }),
        ],
      })
    const inv = await runSdkAgent({
      apiKey: 'k',
      repo: 'XRPLF/xrpl.js',
      ref: 'main',
    })
    expect(createMock).toHaveBeenCalledTimes(2)
    expect(inv.typedTransactionTypes).toEqual(['Payment'])
  })

  it('throws if the model never submits within the iteration budget', async () => {
    // Always idle — exhausts MAX_ITERATIONS.
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'still…' }],
    })
    await expect(
      runSdkAgent({ apiKey: 'k', repo: 'XRPLF/x', ref: 'main' })
    ).rejects.toThrow(/without submitting/)
  })

  it('omits the profile section for an SDK with no profile file', async () => {
    createMock.mockResolvedValueOnce({
      content: [
        toolUse('t1', 'submit_inventory', {
          repo: 'XRPLF/nope',
          ref: 'main',
          resolvedLocations: { definitions: null, models: [], registries: [] },
          typedTransactionTypes: [],
        }),
      ],
    })

    await runSdkAgent({
      apiKey: 'k',
      repo: 'XRPLF/nope',
      ref: 'main',
      sdkName: 'no-such-sdk',
    })

    const calls = createMock.mock.calls as unknown as [{ system: string }][]
    const system = calls[0][0].system
    expect(system).not.toContain('Profile for this SDK')
  })
})
