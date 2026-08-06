import { SecretManagerServiceClient } from '@google-cloud/secret-manager'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Required env var missing: ${name}`)
  return value
}

export interface AppConfig {
  port: number
  githubWebhookSecret: string
  githubToken?: string
  mattermostWebhookUrl: string
  twitterApiKey: string
  twitterApiSecret: string
  twitterAccessToken: string
  twitterAccessTokenSecret: string
  anthropicApiKey: string
  pollerToken?: string
  gcpProjectId: string
  /** Sentinel endpoint for alphanet Stage-1 branch syncs; feature off when unset. */
  alphanetSyncUrl?: string
  alphanetSyncSecret?: string
  alphanetSyncDebounceMinutes: number
}

interface AppSecrets {
  GITHUB_WEBHOOK_SECRET: string
  GITHUB_TOKEN?: string
  MATTERMOST_WEBHOOK_URL: string
  TWITTER_API_KEY: string
  TWITTER_API_SECRET: string
  TWITTER_ACCESS_TOKEN: string
  TWITTER_ACCESS_TOKEN_SECRET: string
  ANTHROPIC_API_KEY: string
  POLLER_TOKEN?: string
  ALPHANET_SYNC_SECRET?: string
}

function alphanetSyncDebounceMinutes(): number {
  const parsed = parseInt(process.env.ALPHANET_SYNC_DEBOUNCE_MINUTES ?? '30', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30
}

export async function loadConfig(): Promise<AppConfig> {
  const port = parseInt(process.env.PORT ?? '3000', 10)
  const gcpProjectId = process.env.GCP_PROJECT_ID ?? ''

  if (process.env.NODE_ENV === 'production' && gcpProjectId) {
    return loadFromSecretManager(port, gcpProjectId)
  }

  return {
    port,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
    githubToken: process.env.GITHUB_TOKEN,
    mattermostWebhookUrl: process.env.MATTERMOST_WEBHOOK_URL ?? '',
    twitterApiKey: process.env.TWITTER_API_KEY ?? '',
    twitterApiSecret: process.env.TWITTER_API_SECRET ?? '',
    twitterAccessToken: process.env.TWITTER_ACCESS_TOKEN ?? '',
    twitterAccessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET ?? '',
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    pollerToken: process.env.POLLER_TOKEN,
    gcpProjectId,
    alphanetSyncUrl: process.env.ALPHANET_SYNC_URL,
    alphanetSyncSecret: process.env.ALPHANET_SYNC_SECRET,
    alphanetSyncDebounceMinutes: alphanetSyncDebounceMinutes(),
  }
}

async function loadFromSecretManager(
  port: number,
  gcpProjectId: string
): Promise<AppConfig> {
  const client = new SecretManagerServiceClient()
  const secretVersion = process.env.APP_SECRET_VERSION ?? 'latest'
  const name = `projects/${gcpProjectId}/secrets/APP_SECRETS/versions/${secretVersion}`

  const [version] = await client.accessSecretVersion({ name })
  const payload = version.payload?.data?.toString()
  if (!payload) throw new Error('Empty secret payload')

  const secrets = JSON.parse(payload) as AppSecrets

  if (!secrets.ANTHROPIC_API_KEY) {
    throw new Error('APP_SECRETS.ANTHROPIC_API_KEY is required')
  }

  return {
    port,
    githubWebhookSecret: secrets.GITHUB_WEBHOOK_SECRET,
    githubToken: secrets.GITHUB_TOKEN,
    mattermostWebhookUrl: secrets.MATTERMOST_WEBHOOK_URL,
    twitterApiKey: secrets.TWITTER_API_KEY,
    twitterApiSecret: secrets.TWITTER_API_SECRET,
    twitterAccessToken: secrets.TWITTER_ACCESS_TOKEN,
    twitterAccessTokenSecret: secrets.TWITTER_ACCESS_TOKEN_SECRET,
    anthropicApiKey: secrets.ANTHROPIC_API_KEY,
    pollerToken: secrets.POLLER_TOKEN,
    gcpProjectId,
    alphanetSyncUrl: process.env.ALPHANET_SYNC_URL,
    alphanetSyncSecret: secrets.ALPHANET_SYNC_SECRET,
    alphanetSyncDebounceMinutes: alphanetSyncDebounceMinutes(),
  }
}
