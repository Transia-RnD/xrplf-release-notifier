import {
  dispatch,
  resetBudget,
  type AlertEvent,
} from '../../../src/notifications/dispatch'
import type { AppConfig } from '../../../src/config'
import type { MattermostPayload } from '../../../src/notifications/mattermost'
import {
  generateKey,
  seal,
  parseKeyRing,
} from '../../../src/notifications/crypto'
import * as mattermost from '../../../src/notifications/mattermost'
import * as twilio from '../../../src/notifications/twilio'
import * as subscribers from '../../../src/notifications/subscribers'

jest.mock('../../../src/notifications/mattermost', () => ({
  ...jest.requireActual<typeof mattermost>(
    '../../../src/notifications/mattermost'
  ),
  postToMattermost: jest.fn(),
}))
jest.mock('../../../src/notifications/slack')
jest.mock('../../../src/notifications/twilio')
jest.mock('../../../src/notifications/subscribers', () => ({
  ...jest.requireActual<typeof subscribers>(
    '../../../src/notifications/subscribers'
  ),
  loadRoster: jest.fn(),
}))

const ENC_KEY = generateKey()
const PEPPER = generateKey()
const KEYS = {
  ring: parseKeyRing(`{"1":"${ENC_KEY}"}`),
  indexPepper: Buffer.from(PEPPER, 'base64'),
}

const PAYLOAD: MattermostPayload = { username: 'x', attachments: [] }

const EVENT: AlertEvent = {
  severity: 'CRITICAL',
  topic: 'network',
  network: 'mainnet',
  id: 'FORK_DETECTED',
  detail: 'ledger 98123456, no branch reached quorum',
}

function config(pager = true): AppConfig {
  return {
    port: 3000,
    githubWebhookSecret: '',
    mattermostWebhookUrl: 'https://mm.example/hook',
    slackWebhookUrl: undefined,
    twitterApiKey: '',
    twitterApiSecret: '',
    twitterAccessToken: '',
    twitterAccessTokenSecret: '',
    anthropicApiKey: 'k',
    twitterPostingEnabled: false,
    gcpProjectId: 'p',
    alphanetSyncDebounceMinutes: 30,
    pager: pager
      ? {
          accountSid: 'AC' + '0'.repeat(32),
          keySid: 'SK' + '0'.repeat(32),
          keySecret: 's',
          from: '+33939200858',
          channel: 'whatsapp' as const,
          alertTemplateSid: 'HX1',
          encKeys: `{"1":"${ENC_KEY}"}`,
          indexPepper: PEPPER,
        }
      : undefined,
  }
}

/** A subscriber wired to receive `EVENT` unless overridden. */
function subscriber(over: Partial<subscribers.Subscriber> = {}) {
  return {
    id: 'sub_1',
    label: 'denis',
    phone: seal('+13213609426', KEYS),
    phoneIndex: 'idx',
    phoneLast4: '9426',
    subscriptions: [
      {
        network: 'mainnet' as const,
        topic: 'network' as const,
        minSeverity: 'CRITICAL' as const,
      },
    ],
    status: 'active' as const,
    createdAt: '2026-08-09T00:00:00Z',
    ...over,
  } as subscribers.Subscriber
}

function withRoster(...subs: subscribers.Subscriber[]) {
  ;(subscribers.loadRoster as jest.Mock).mockResolvedValue({
    roster: { version: 1, subscribers: subs },
    generation: 1,
  })
}

const storage = {} as never

beforeEach(() => {
  jest.clearAllMocks()
  resetBudget()
  ;(twilio.send as jest.Mock).mockResolvedValue({ ok: true, sid: 'MM1' })
})

describe('dispatch', () => {
  it('pages a matching subscriber through the approved template', async () => {
    withRoster(subscriber())

    const result = await dispatch(PAYLOAD, EVENT, { config: config(), storage })

    expect(result.paged).toBe(1)
    const [, to, , template] = (twilio.send as jest.Mock).mock.calls[0]
    expect(to).toBe('+13213609426')
    expect(template).toEqual({
      contentSid: 'HX1',
      variables: {
        '1': 'CRITICAL',
        '2': 'FORK_DETECTED',
        '3': 'mainnet ledger 98123456, no branch reached quorum',
      },
    })
  })

  it('posts to Mattermost even when the pager is disabled', async () => {
    const result = await dispatch(PAYLOAD, EVENT, {
      config: config(false),
      storage,
    })

    expect(mattermost.postToMattermost).toHaveBeenCalled()
    expect(result.mattermost).toBe(true)
    expect(result.paged).toBe(0)
    expect(twilio.send).not.toHaveBeenCalled()
  })

  it('still pages when Mattermost is down', async () => {
    ;(mattermost.postToMattermost as jest.Mock).mockRejectedValueOnce(
      new Error('502')
    )
    withRoster(subscriber())

    const result = await dispatch(PAYLOAD, EVENT, { config: config(), storage })

    expect(result.mattermost).toBe(false)
    expect(result.paged).toBe(1)
  })

  it('keeps the Mattermost record when the pager throws', async () => {
    ;(subscribers.loadRoster as jest.Mock).mockRejectedValueOnce(
      new Error('gcs down')
    )

    const result = await dispatch(PAYLOAD, EVENT, { config: config(), storage })

    expect(result.mattermost).toBe(true)
    expect(result.paged).toBe(0)
  })

  it('does not page a stopped subscriber', async () => {
    withRoster(subscriber({ status: 'stopped' }))

    const result = await dispatch(PAYLOAD, EVENT, { config: config(), storage })

    expect(result.paged).toBe(0)
    expect(twilio.send).not.toHaveBeenCalled()
  })

  it('does not page below a subscriber severity floor', async () => {
    withRoster(subscriber())

    const result = await dispatch(
      PAYLOAD,
      { ...EVENT, severity: 'WARNING' },
      { config: config(), storage }
    )

    expect(result.paged).toBe(0)
  })

  it('does not page across networks', async () => {
    withRoster(subscriber())

    const result = await dispatch(
      PAYLOAD,
      { ...EVENT, network: 'alphanet' },
      { config: config(), storage }
    )

    expect(result.paged).toBe(0)
  })

  it('caps a repeating alert at the hourly budget', async () => {
    withRoster(subscriber())
    const ctx = { config: config(), storage }

    for (let i = 0; i < 5; i++) await dispatch(PAYLOAD, EVENT, ctx)
    const sixth = await dispatch(PAYLOAD, EVENT, ctx)

    expect(twilio.send).toHaveBeenCalledTimes(5)
    expect(sixth.paged).toBe(0)
    expect(sixth.suppressed).toBe(1)
    // The durable record keeps flowing after the phone goes quiet.
    expect(mattermost.postToMattermost).toHaveBeenCalledTimes(6)
  })

  it('counts a rejected send as not paged', async () => {
    ;(twilio.send as jest.Mock).mockResolvedValue({
      ok: false,
      errorCode: 63016,
    })
    withRoster(subscriber())

    const result = await dispatch(PAYLOAD, EVENT, { config: config(), storage })

    expect(result.paged).toBe(0)
  })
})
