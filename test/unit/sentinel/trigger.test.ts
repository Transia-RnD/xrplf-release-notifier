import axios from 'axios'
import type { Logger } from 'winston'
import { triggerSentinelAudit } from '../../../src/sentinel/trigger'
import type { AppConfig } from '../../../src/config'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

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
    sentinelBaseUrl: 'https://sentinel.example.com/',
    sentinelApiToken: 'fri_tok',
    ...overrides,
  }
}

const params = {
  owner: 'XRPLF',
  repo: 'rippled',
  ref: '3.2.0-rc1',
  versionType: 'rc',
}

beforeEach(() => jest.clearAllMocks())

describe('triggerSentinelAudit', () => {
  it('POSTs to /reviews with bearer token and release facts (trailing slash trimmed)', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { triggered: true, auditId: 'a1' },
    })
    await triggerSentinelAudit(config(), params, logger)
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://sentinel.example.com/reviews',
      {
        owner: 'XRPLF',
        repo: 'rippled',
        ref: '3.2.0-rc1',
        versionType: 'rc',
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fri_tok' }),
      })
    )
    expect(logger.info).toHaveBeenCalledWith(
      'Sentinel audit triggered',
      expect.objectContaining({ auditId: 'a1' })
    )
  })

  it('no-ops (no POST) when base URL is unset', async () => {
    await triggerSentinelAudit(
      config({ sentinelBaseUrl: undefined }),
      params,
      logger
    )
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('no-ops (no POST) when API token is unset', async () => {
    await triggerSentinelAudit(
      config({ sentinelApiToken: undefined }),
      params,
      logger
    )
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('logs the skip reason when Sentinel declines to start', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { triggered: false, skipped: 'auto_audit_on_release disabled' },
    })
    await triggerSentinelAudit(config(), params, logger)
    expect(logger.info).toHaveBeenCalledWith(
      'Sentinel audit not started',
      expect.objectContaining({ reason: 'auto_audit_on_release disabled' })
    )
  })

  it('warns (never throws) on a request failure', async () => {
    mockedAxios.post.mockRejectedValue(new Error('connection refused'))
    await expect(
      triggerSentinelAudit(config(), params, logger)
    ).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })
})
