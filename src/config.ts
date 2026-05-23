import { SecretManagerServiceClient } from '@google-cloud/secret-manager'

export interface AppConfig {
  port: number
  githubWebhookSecret: string
  githubToken?: string
  mattermostWebhookUrl: string
  twitterApiKey: string
  twitterApiSecret: string
  twitterAccessToken: string
  twitterAccessTokenSecret: string
  anthropicApiKey?: string
  gcpProjectId: string
  gcsBucket: string
}

interface AppSecrets {
  GITHUB_WEBHOOK_SECRET: string
  GITHUB_TOKEN?: string
  MATTERMOST_WEBHOOK_URL: string
  TWITTER_API_KEY: string
  TWITTER_API_SECRET: string
  TWITTER_ACCESS_TOKEN: string
  TWITTER_ACCESS_TOKEN_SECRET: string
  ANTHROPIC_API_KEY?: string
}

export async function loadConfig(): Promise<AppConfig> {
  const port = parseInt(process.env.PORT ?? '3000', 10)
  const gcpProjectId = process.env.GCP_PROJECT_ID ?? ''
  const gcsBucket = process.env.GCS_BUCKET ?? 'xrplf-release-notifier'

  if (process.env.NODE_ENV === 'production' && gcpProjectId) {
    return loadFromSecretManager(port, gcpProjectId, gcsBucket)
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
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    gcpProjectId,
    gcsBucket,
  }
}

async function loadFromSecretManager(
  port: number,
  gcpProjectId: string,
  gcsBucket: string
): Promise<AppConfig> {
  const client = new SecretManagerServiceClient()
  const secretVersion = process.env.APP_SECRET_VERSION ?? 'latest'
  const name = `projects/${gcpProjectId}/secrets/APP_SECRETS/versions/${secretVersion}`

  const [version] = await client.accessSecretVersion({ name })
  const payload = version.payload?.data?.toString()
  if (!payload) throw new Error('Empty secret payload')

  const secrets = JSON.parse(payload) as AppSecrets

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
    gcpProjectId,
    gcsBucket,
  }
}
