import crypto from 'crypto'
import type { Request, Response } from 'express'
import {
  handleWhatsappInbound,
  verifyTwilioSignature,
} from '../../../src/webhook/whatsappInbound'
import type { AppConfig } from '../../../src/config'
import {
  blindIndex,
  generateKey,
  parseKeyRing,
  seal,
} from '../../../src/notifications/crypto'
import * as subscribers from '../../../src/notifications/subscribers'
import type { Roster } from '../../../src/notifications/subscribers'

jest.mock('../../../src/notifications/subscribers', () => ({
  ...jest.requireActual<typeof subscribers>(
    '../../../src/notifications/subscribers'
  ),
  loadRoster: jest.fn(),
  saveRoster: jest.fn(),
}))

const ENC_KEY = generateKey()
const PEPPER = generateKey()
const KEYS = {
  ring: parseKeyRing(`{"1":"${ENC_KEY}"}`),
  indexPepper: Buffer.from(PEPPER, 'base64'),
}
const AUTH_TOKEN = 'test-auth-token'
const NUMBER = '+13213609426'
const URL = 'https://notifier.example/whatsapp/inbound'

function config(): AppConfig {
  return {
    port: 3000,
    githubWebhookSecret: '',
    mattermostWebhookUrl: '',
    twitterApiKey: '',
    twitterApiSecret: '',
    twitterAccessToken: '',
    twitterAccessTokenSecret: '',
    anthropicApiKey: 'k',
    twitterPostingEnabled: false,
    gcpProjectId: 'p',
    alphanetSyncDebounceMinutes: 30,
    pager: {
      accountSid: 'AC' + '0'.repeat(32),
      keySid: 'SK' + '0'.repeat(32),
      keySecret: 's',
      from: '+33939200858',
      channel: 'whatsapp',
      alertTemplateSid: 'HX1',
      encKeys: `{"1":"${ENC_KEY}"}`,
      indexPepper: PEPPER,
    },
  }
}

function sign(params: Record<string, string>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], URL)
  return crypto
    .createHmac('sha1', AUTH_TOKEN)
    .update(Buffer.from(payload, 'utf-8'))
    .digest('base64')
}

function request(params: Record<string, string>, signature?: string): Request {
  return {
    body: params,
    protocol: 'https',
    originalUrl: '/whatsapp/inbound',
    get: (h: string) =>
      h === 'X-Twilio-Signature'
        ? (signature ?? sign(params))
        : h === 'host'
          ? 'notifier.example'
          : undefined,
  } as unknown as Request
}

function response(): Response & { statusCode: number } {
  const res = {
    statusCode: 0,
    status(code: number) {
      res.statusCode = code
      return res
    },
    type: () => res,
    send: () => res,
  }
  return res as unknown as Response & { statusCode: number }
}

const roster = () => ({
  roster: {
    version: 1 as const,
    subscribers: [
      {
        id: 'sub_1',
        label: 'denis',
        phone: seal(NUMBER, KEYS),
        phoneIndex: blindIndex(NUMBER, KEYS),
        phoneLast4: '9426',
        subscriptions: [],
        status: 'active' as const,
        createdAt: '2026-08-09T00:00:00Z',
      },
    ],
  },
  generation: 3,
})

const storage = {} as never

beforeEach(() => {
  jest.clearAllMocks()
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN
  ;(subscribers.loadRoster as jest.Mock).mockResolvedValue(roster())
  ;(subscribers.saveRoster as jest.Mock).mockResolvedValue(undefined)
})

describe('verifyTwilioSignature', () => {
  it('accepts a correctly signed request', () => {
    const params = { From: `whatsapp:${NUMBER}`, Body: 'STOP' }
    expect(verifyTwilioSignature(AUTH_TOKEN, URL, params, sign(params))).toBe(
      true
    )
  })

  it('rejects a tampered body', () => {
    const params = { From: `whatsapp:${NUMBER}`, Body: 'STOP' }
    const signature = sign(params)
    expect(
      verifyTwilioSignature(
        AUTH_TOKEN,
        URL,
        { ...params, Body: 'START' },
        signature
      )
    ).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifyTwilioSignature(AUTH_TOKEN, URL, {}, 'short')).toBe(false)
  })
})

describe('handleWhatsappInbound', () => {
  it('marks a subscriber stopped on STOP', async () => {
    const res = response()
    await handleWhatsappInbound(
      request({ From: `whatsapp:${NUMBER}`, Body: 'STOP' }),
      res,
      config(),
      storage
    )

    const [, saved] = (subscribers.saveRoster as jest.Mock).mock.calls[0] as [
      unknown,
      Roster,
    ]
    expect(saved.subscribers[0].status).toBe('stopped')
    expect(res.statusCode).toBe(200)
  })

  it('is case and whitespace insensitive', async () => {
    await handleWhatsappInbound(
      request({ From: `whatsapp:${NUMBER}`, Body: '  Stop  ' }),
      response(),
      config(),
      storage
    )

    const [, saved] = (subscribers.saveRoster as jest.Mock).mock.calls[0] as [
      unknown,
      Roster,
    ]
    expect(saved.subscribers[0].status).toBe('stopped')
  })

  it('reactivates on START and records consent', async () => {
    await handleWhatsappInbound(
      request({ From: `whatsapp:${NUMBER}`, Body: 'start' }),
      response(),
      config(),
      storage
    )

    const [, saved] = (subscribers.saveRoster as jest.Mock).mock.calls[0] as [
      unknown,
      Roster,
    ]
    expect(saved.subscribers[0].status).toBe('active')
    expect(saved.subscribers[0].consentAt).toBeDefined()
  })

  it('treats any other reply as an ack and writes nothing', async () => {
    await handleWhatsappInbound(
      request({ From: `whatsapp:${NUMBER}`, Body: 'on it' }),
      response(),
      config(),
      storage
    )

    expect(subscribers.saveRoster).not.toHaveBeenCalled()
  })

  it('rejects an unsigned request without touching the roster', async () => {
    const res = response()
    await handleWhatsappInbound(
      request({ From: `whatsapp:${NUMBER}`, Body: 'STOP' }, 'forged'),
      res,
      config(),
      storage
    )

    expect(res.statusCode).toBe(403)
    expect(subscribers.loadRoster).not.toHaveBeenCalled()
  })

  it('ignores a number that is not on the roster', async () => {
    const params = { From: 'whatsapp:+14155550100', Body: 'STOP' }
    const res = response()
    await handleWhatsappInbound(request(params), res, config(), storage)

    expect(subscribers.saveRoster).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
  })

  it('answers 200 even when the roster write fails, so Twilio does not retry', async () => {
    ;(subscribers.saveRoster as jest.Mock).mockRejectedValueOnce(
      new Error('gcs down')
    )
    const res = response()

    await handleWhatsappInbound(
      request({ From: `whatsapp:${NUMBER}`, Body: 'STOP' }),
      res,
      config(),
      storage
    )

    expect(res.statusCode).toBe(200)
  })
})
