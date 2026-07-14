import type { Storage } from '@google-cloud/storage'
import { loadPollerState, savePollerState } from '../../../src/poller/state'

function storageWith(file: {
  download?: () => Promise<[Buffer]>
  save?: jest.Mock
}): Storage {
  return {
    bucket: () => ({ file: () => file }),
  } as unknown as Storage
}

describe('poller state', () => {
  it('loads and parses persisted state', async () => {
    const stored = { deb: { version: '3.1.0', detectedAt: 'x' }, rpm: null }
    const s = storageWith({
      download: () => Promise.resolve([Buffer.from(JSON.stringify(stored))]),
    })
    await expect(loadPollerState(s)).resolves.toEqual(stored)
  })

  it('returns the default state when nothing is stored (download throws)', async () => {
    const s = storageWith({
      download: () => Promise.reject(new Error('No such object')),
    })
    await expect(loadPollerState(s)).resolves.toEqual({ deb: null, rpm: null })
  })

  it('saves state as pretty JSON with the right content type', async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    const s = storageWith({ save })
    await savePollerState(s, { deb: null, rpm: null })
    expect(save).toHaveBeenCalledWith(
      expect.stringContaining('"deb"'),
      expect.objectContaining({ contentType: 'application/json' })
    )
  })
})
