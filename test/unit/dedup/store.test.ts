import type { Storage } from '@google-cloud/storage'
import { tryClaim } from '../../../src/dedup/store'

interface SaveCall {
  data: string | Buffer
  opts: { preconditionOpts?: { ifGenerationMatch?: number } }
}

function makeStorage(saveImpl: (call: SaveCall) => void): {
  storage: Storage
  saveCalls: SaveCall[]
} {
  const saveCalls: SaveCall[] = []
  const file = jest.fn().mockReturnValue({
    save: jest.fn((data: string | Buffer, opts: SaveCall['opts']) => {
      const call = { data, opts }
      saveCalls.push(call)
      saveImpl(call)
      return Promise.resolve()
    }),
  })
  const storage = {
    bucket: jest.fn().mockReturnValue({ file }),
  } as unknown as Storage
  return { storage, saveCalls }
}

interface ClaimMeta {
  channel: string
  scenario: string
  version: string
  repo: string
  claimedAt: string
}

describe('tryClaim', () => {
  it('returns true and writes metadata on first claim', async () => {
    const { storage, saveCalls } = makeStorage(() => undefined)
    const claimed = await tryClaim(
      storage,
      'mattermost',
      'release',
      '3.1.0',
      'XRPLF/rippled'
    )
    expect(claimed).toBe(true)
    expect(saveCalls).toHaveLength(1)
    expect(saveCalls[0].opts.preconditionOpts?.ifGenerationMatch).toBe(0)
    const meta = JSON.parse(saveCalls[0].data.toString()) as ClaimMeta
    expect(meta).toMatchObject({
      channel: 'mattermost',
      scenario: 'release',
      version: '3.1.0',
      repo: 'XRPLF/rippled',
    })
    expect(typeof meta.claimedAt).toBe('string')
  })

  it('returns false when GCS rejects with 412 (already claimed)', async () => {
    const { storage } = makeStorage(() => {
      const err = new Error('precondition failed') as Error & { code: number }
      err.code = 412
      throw err
    })
    const claimed = await tryClaim(
      storage,
      'twitter',
      'tag',
      '3.2.0-b4',
      'XRPLF/rippled'
    )
    expect(claimed).toBe(false)
  })

  it('propagates non-412 errors', async () => {
    const { storage } = makeStorage(() => {
      const err = new Error('boom') as Error & { code: number }
      err.code = 500
      throw err
    })
    await expect(
      tryClaim(storage, 'mattermost', 'release', '3.1.0', 'XRPLF/rippled')
    ).rejects.toThrow('boom')
  })
})
