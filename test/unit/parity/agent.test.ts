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
})
