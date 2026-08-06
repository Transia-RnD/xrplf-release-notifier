import type { Logger } from 'winston'
import type { AppConfig } from '../../../src/config'
import {
  maybeDispatchAlphanetSync,
  resetAlphanetSyncDebounce,
} from '../../../src/alphanet/sync'

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    githubWebhookSecret: 's',
    mattermostWebhookUrl: '',
    twitterApiKey: '',
    twitterApiSecret: '',
    twitterAccessToken: '',
    twitterAccessTokenSecret: '',
    anthropicApiKey: 'k',
    gcpProjectId: '',
    alphanetSyncUrl: 'https://sentinel.example/v1/alphanet/sync',
    alphanetSyncSecret: 'shhh',
    alphanetSyncDebounceMinutes: 30,
    ...overrides,
  }
}

describe('maybeDispatchAlphanetSync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetAlphanetSyncDebounce()
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 }) as never
  })

  it('is disabled when url or secret are unset', async () => {
    expect(
      await maybeDispatchAlphanetSync(config({ alphanetSyncUrl: undefined }), logger)
    ).toBe('disabled')
    expect(
      await maybeDispatchAlphanetSync(config({ alphanetSyncSecret: undefined }), logger)
    ).toBe('disabled')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('dispatches with the shared secret header', async () => {
    const outcome = await maybeDispatchAlphanetSync(config(), logger)
    expect(outcome).toBe('dispatched')
    expect(global.fetch).toHaveBeenCalledWith(
      'https://sentinel.example/v1/alphanet/sync',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Internal-Secret': 'shhh' }),
      })
    )
  })

  it('debounces a second dispatch inside the window', async () => {
    await maybeDispatchAlphanetSync(config(), logger)
    const second = await maybeDispatchAlphanetSync(config(), logger)
    expect(second).toBe('debounced')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not arm the debounce on failure', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 401 })
    expect(await maybeDispatchAlphanetSync(config(), logger)).toBe('failed')
    expect(await maybeDispatchAlphanetSync(config(), logger)).toBe('dispatched')
  })

  it('reports failed on network error without throwing', async () => {
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(new Error('boom'))
    expect(await maybeDispatchAlphanetSync(config(), logger)).toBe('failed')
  })
})
