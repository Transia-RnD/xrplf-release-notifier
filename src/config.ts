import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import type { Channel } from './notifications/twilio'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Required env var missing: ${name}`)
  return value
}

/**
 * Everything needed to page a phone. Absent unless the whole set resolves —
 * a half-configured pager is worse than none, because it looks enabled and
 * silently drops alerts.
 *
 * The roster ciphertext lives in GCS and these keys in Secret Manager, so
 * reading a number requires both IAM surfaces. Keep them apart.
 */
export interface PagerConfig {
  accountSid: string
  keySid: string
  keySecret: string
  from: string
  channel: Channel
  /** Approved WhatsApp template; business-initiated pages are rejected without one. */
  alertTemplateSid: string
  /** Raw `SMS_ENC_KEYS` / `SMS_INDEX_PEPPER`; parsed by the crypto layer. */
  encKeys: string
  indexPepper: string
}

const PAGER_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_FROM',
  'TWILIO_ALERT_TEMPLATE_SID',
  'SMS_ENC_KEYS',
  'SMS_INDEX_PEPPER',
] as const

/**
 * `lookup` reads either process.env or the secret payload, so both load paths
 * agree on what a complete pager configuration is.
 */
function pagerConfig(
  lookup: (key: string) => string | undefined
): PagerConfig | undefined {
  if (process.env.PAGER_ENABLED !== 'true') return undefined

  const found = new Map<string, string>()
  const missing: string[] = []
  for (const key of PAGER_KEYS) {
    const value = lookup(key)
    if (value) found.set(key, value)
    else missing.push(key)
  }

  if (missing.length > 0) {
    throw new Error(
      `PAGER_ENABLED=true but missing: ${missing.join(', ')}. ` +
        'Unset PAGER_ENABLED to run without a pager.'
    )
  }

  const value = (key: string): string => found.get(key) ?? ''

  return {
    accountSid: value('TWILIO_ACCOUNT_SID'),
    keySid: value('TWILIO_API_KEY_SID'),
    keySecret: value('TWILIO_API_KEY_SECRET'),
    from: value('TWILIO_FROM'),
    channel: lookup('TWILIO_CHANNEL') === 'sms' ? 'sms' : 'whatsapp',
    alertTemplateSid: value('TWILIO_ALERT_TEMPLATE_SID'),
    encKeys: value('SMS_ENC_KEYS'),
    indexPepper: value('SMS_INDEX_PEPPER'),
  }
}

export interface AppConfig {
  port: number
  githubWebhookSecret: string
  githubToken?: string
  mattermostWebhookUrl: string
  /** Slack incoming webhook; notifications mirror there when set. */
  slackWebhookUrl?: string
  twitterApiKey: string
  twitterApiSecret: string
  twitterAccessToken: string
  twitterAccessTokenSecret: string
  anthropicApiKey: string
  /** Master switch for posting to Twitter; off unless TWITTER_POSTING_ENABLED=true. */
  twitterPostingEnabled: boolean
  pollerToken?: string
  gcpProjectId: string
  /** Sentinel endpoint for alphanet Stage-1 branch syncs; feature off when unset. */
  alphanetSyncUrl?: string
  alphanetSyncSecret?: string
  alphanetSyncDebounceMinutes: number
  /** Undefined unless PAGER_ENABLED=true and every credential resolves. */
  pager?: PagerConfig
}

interface AppSecrets {
  /** Parsed from a JSON blob, so unknown keys are expected rather than an error. */
  [key: string]: string | undefined
  GITHUB_WEBHOOK_SECRET: string
  GITHUB_TOKEN?: string
  MATTERMOST_WEBHOOK_URL: string
  SLACK_WEBHOOK_URL?: string
  TWITTER_API_KEY: string
  TWITTER_API_SECRET: string
  TWITTER_ACCESS_TOKEN: string
  TWITTER_ACCESS_TOKEN_SECRET: string
  ANTHROPIC_API_KEY: string
  POLLER_TOKEN?: string
  ALPHANET_SYNC_SECRET?: string
  TWILIO_ACCOUNT_SID?: string
  TWILIO_API_KEY_SID?: string
  TWILIO_API_KEY_SECRET?: string
  TWILIO_FROM?: string
  TWILIO_CHANNEL?: string
  TWILIO_ALERT_TEMPLATE_SID?: string
  SMS_ENC_KEYS?: string
  SMS_INDEX_PEPPER?: string
}

function alphanetSyncDebounceMinutes(): number {
  const parsed = parseInt(
    process.env.ALPHANET_SYNC_DEBOUNCE_MINUTES ?? '30',
    10
  )
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
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    twitterApiKey: process.env.TWITTER_API_KEY ?? '',
    twitterApiSecret: process.env.TWITTER_API_SECRET ?? '',
    twitterAccessToken: process.env.TWITTER_ACCESS_TOKEN ?? '',
    twitterAccessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET ?? '',
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    twitterPostingEnabled: process.env.TWITTER_POSTING_ENABLED === 'true',
    pollerToken: process.env.POLLER_TOKEN,
    gcpProjectId,
    alphanetSyncUrl: process.env.ALPHANET_SYNC_URL,
    alphanetSyncSecret: process.env.ALPHANET_SYNC_SECRET,
    alphanetSyncDebounceMinutes: alphanetSyncDebounceMinutes(),
    pager: pagerConfig((k) => process.env[k]),
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
    slackWebhookUrl: secrets.SLACK_WEBHOOK_URL,
    twitterApiKey: secrets.TWITTER_API_KEY,
    twitterApiSecret: secrets.TWITTER_API_SECRET,
    twitterAccessToken: secrets.TWITTER_ACCESS_TOKEN,
    twitterAccessTokenSecret: secrets.TWITTER_ACCESS_TOKEN_SECRET,
    anthropicApiKey: secrets.ANTHROPIC_API_KEY,
    twitterPostingEnabled: process.env.TWITTER_POSTING_ENABLED === 'true',
    pollerToken: secrets.POLLER_TOKEN,
    gcpProjectId,
    alphanetSyncUrl: process.env.ALPHANET_SYNC_URL,
    alphanetSyncSecret: secrets.ALPHANET_SYNC_SECRET,
    alphanetSyncDebounceMinutes: alphanetSyncDebounceMinutes(),
    pager: pagerConfig((k) => secrets[k] ?? process.env[k]),
  }
}
