jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    accessSecretVersion: jest.fn().mockResolvedValue([
      {
        payload: {
          data: Buffer.from(
            JSON.stringify({
              GITHUB_WEBHOOK_SECRET: 'w',
              GITHUB_TOKEN: 'gt',
              MATTERMOST_WEBHOOK_URL: 'mm',
              TWITTER_API_KEY: '',
              TWITTER_API_SECRET: '',
              TWITTER_ACCESS_TOKEN: '',
              TWITTER_ACCESS_TOKEN_SECRET: '',
              ANTHROPIC_API_KEY: 'ak',
              POLLER_TOKEN: 'pt',
            })
          ),
        },
      },
    ]),
  })),
}))

import { loadConfig } from '../../src/config'

const OLD_ENV = process.env
afterEach(() => {
  process.env = OLD_ENV
})

describe('loadConfig — dev / env path', () => {
  it('reads config from environment variables', async () => {
    process.env = {
      ...OLD_ENV,
      NODE_ENV: 'development',
      ANTHROPIC_API_KEY: 'ak',
      GITHUB_TOKEN: 'gt',
      MATTERMOST_WEBHOOK_URL: 'mm',
      PORT: '3000',
    }
    const c = await loadConfig()
    expect(c.anthropicApiKey).toBe('ak')
    expect(c.githubToken).toBe('gt')
    expect(c.mattermostWebhookUrl).toBe('mm')
    expect(c.port).toBe(3000)
  })

  it('throws when the required ANTHROPIC_API_KEY is missing', async () => {
    process.env = { ...OLD_ENV, NODE_ENV: 'development' }
    delete process.env.ANTHROPIC_API_KEY
    await expect(loadConfig()).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })
})

describe('loadConfig — production / Secret Manager path', () => {
  it('loads the secret blob from Secret Manager', async () => {
    process.env = { ...OLD_ENV, NODE_ENV: 'production', GCP_PROJECT_ID: 'proj' }
    const c = await loadConfig()
    expect(c.anthropicApiKey).toBe('ak')
    expect(c.mattermostWebhookUrl).toBe('mm')
    expect(c.githubWebhookSecret).toBe('w')
    expect(c.pollerToken).toBe('pt')
  })
})
