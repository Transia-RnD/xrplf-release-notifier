import type { Request, Response } from 'express'
import {
  handleWebhook,
  handleParity,
  handlePoll,
  triggerParityForRelease,
  twitterConfigured,
} from '../../src/index'
import type { AppConfig } from '../../src/config'
import * as verify from '../../src/webhook/verify'
import * as handler from '../../src/webhook/handler'
import * as parity from '../../src/parity/runParityCheck'
import * as trigger from '../../src/parity/trigger'
import * as binaryChecker from '../../src/poller/binary-checker'
import * as state from '../../src/poller/state'
import * as summarizer from '../../src/ai/summarizer'
import * as client from '../../src/github/client'
import * as card from '../../src/notifications/release-card'
import * as twitter from '../../src/notifications/twitter'
import type { Storage } from '@google-cloud/storage'

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8080,
    githubWebhookSecret: 'secret',
    githubToken: 't',
    mattermostWebhookUrl: 'https://mm',
    twitterApiKey: 'k',
    twitterApiSecret: 's',
    twitterAccessToken: 'at',
    twitterAccessTokenSecret: 'ats',
    anthropicApiKey: 'a',
    pollerToken: 'poll-tok',
    gcpProjectId: '',
    ...over,
  } as AppConfig
}

function mockReq(over: Record<string, unknown> = {}): Request {
  return {
    headers: {},
    body: undefined,
    ip: '1.2.3.4',
    protocol: 'https',
    get: jest.fn(() => 'host.example'),
    ...over,
  } as unknown as Request
}

interface RecordingRes {
  statusCode: number
  headersSent: boolean
  body: unknown
  status(c: number): RecordingRes
  json(b: unknown): RecordingRes
}
function mockRes(): RecordingRes {
  return {
    statusCode: 200,
    headersSent: false,
    body: undefined,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      this.headersSent = true
      return this
    },
  }
}
/** Pass the recording res into a handler typed as an Express Response. */
const asRes = (r: RecordingRes) => r as unknown as Response

const storage = {} as Storage

afterEach(() => jest.restoreAllMocks())

describe('handleWebhook', () => {
  it('rejects a missing/invalid signature with 401', async () => {
    const res = mockRes()
    await handleWebhook(
      mockReq({ body: Buffer.from('{}') }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.statusCode).toBe(401)
  })

  it('answers a ping with pong', async () => {
    jest.spyOn(verify, 'verifySignature').mockReturnValue(true)
    const res = mockRes()
    await handleWebhook(
      mockReq({
        headers: { 'x-hub-signature-256': 'sha', 'x-github-event': 'ping' },
        body: Buffer.from('{}'),
      }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.body).toEqual({ action: 'pong' })
  })

  it('dispatches a push event WITHOUT triggering parity (binary poll owns it)', async () => {
    jest.spyOn(verify, 'verifySignature').mockReturnValue(true)
    jest.spyOn(handler, 'handlePushEvent').mockResolvedValue({
      action: 'notified',
      source: 'tag',
      version: '3.2.0',
    })
    const trig = jest.spyOn(trigger, 'triggerParityCheck').mockResolvedValue()
    const res = mockRes()

    await handleWebhook(
      mockReq({
        headers: { 'x-hub-signature-256': 'sha', 'x-github-event': 'push' },
        body: Buffer.from('{}'),
      }),
      asRes(res),
      cfg(),
      storage
    )

    expect(handler.handlePushEvent).toHaveBeenCalled()
    expect(trig).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
  })

  it('dispatches a release event', async () => {
    jest.spyOn(verify, 'verifySignature').mockReturnValue(true)
    jest
      .spyOn(handler, 'handleReleaseEvent')
      .mockResolvedValue({ action: 'notified', source: 'release-private' })
    const trig = jest.spyOn(trigger, 'triggerParityCheck').mockResolvedValue()
    const res = mockRes()

    await handleWebhook(
      mockReq({
        headers: { 'x-hub-signature-256': 'sha', 'x-github-event': 'release' },
        body: Buffer.from('{}'),
      }),
      asRes(res),
      cfg(),
      storage
    )
    expect(handler.handleReleaseEvent).toHaveBeenCalled()
    // private path => NOT parity-triggered
    expect(trig).not.toHaveBeenCalled()
  })

  it('ignores an unrecognized event', async () => {
    jest.spyOn(verify, 'verifySignature').mockReturnValue(true)
    const res = mockRes()
    await handleWebhook(
      mockReq({
        headers: { 'x-hub-signature-256': 'sha', 'x-github-event': 'star' },
        body: Buffer.from('{}'),
      }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.body).toMatchObject({ action: 'ignored' })
  })
})

describe('triggerParityForRelease', () => {
  it('dispatches the parity job for the released version', () => {
    const trig = jest.spyOn(trigger, 'triggerParityCheck').mockResolvedValue()
    triggerParityForRelease('3.2.0', mockReq(), cfg())
    expect(trig).toHaveBeenCalledWith(
      expect.any(String),
      'poll-tok',
      '3.2.0',
      expect.anything()
    )
  })
})

describe('handleParity', () => {
  it('401s on a bad token', async () => {
    const res = mockRes()
    await handleParity(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'wrong' }, body: {} }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.statusCode).toBe(401)
  })

  it('400s on a missing version', async () => {
    const res = mockRes()
    await handleParity(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'poll-tok' }, body: {} }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.statusCode).toBe(400)
  })

  it('400s on a version that does not match the pattern', async () => {
    const res = mockRes()
    await handleParity(
      mockReq({
        headers: { 'x-cloud-scheduler-token': 'poll-tok' },
        body: { version: 'not-a-version' },
      }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.statusCode).toBe(400)
  })

  it('runs the parity check for a valid version', async () => {
    const run = jest
      .spyOn(parity, 'runParityCheck')
      .mockResolvedValue(undefined)
    const res = mockRes()
    await handleParity(
      mockReq({
        headers: { 'x-cloud-scheduler-token': 'poll-tok' },
        body: { version: '3.2.0' },
      }),
      asRes(res),
      cfg(),
      storage
    )
    expect(run).toHaveBeenCalled()
    expect(res.body).toMatchObject({
      action: 'parity_checked',
      version: '3.2.0',
    })
  })
})

describe('twitterConfigured', () => {
  it('is false for empty/placeholder creds', () => {
    expect(twitterConfigured(cfg({ twitterApiKey: '' }))).toBe(false)
    expect(twitterConfigured(cfg({ twitterApiKey: 'placeholder' }))).toBe(false)
  })
  it('is true for real creds', () => {
    expect(twitterConfigured(cfg())).toBe(true)
  })
})

describe('handlePoll', () => {
  // The breaking/surface scan hits GitHub + the AI — stub it for every poll
  // test; the composed-section rendering is covered by the handler tests.
  beforeEach(() => {
    jest.spyOn(trigger, 'triggerParityCheck').mockResolvedValue()
    jest.spyOn(handler, 'detectBreakingSafe').mockResolvedValue({
      breakingNow: '',
      newSurface: '',
      unvotableAmendments: '',
      hasBreakingNow: false,
      hasNewSurface: false,
      hasUnvotableAmendment: false,
      amendmentNames: [],
    })
  })

  it('401s on a bad poller token', async () => {
    const res = mockRes()
    await handlePoll(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'wrong' }, body: {} }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.statusCode).toBe(401)
  })

  it('cold-starts: initializes state without posting', async () => {
    jest
      .spyOn(state, 'loadPollerState')
      .mockResolvedValue({ deb: null, rpm: null })
    jest
      .spyOn(binaryChecker, 'fetchLatestBinaryVersions')
      .mockResolvedValue({ deb: '3.1.0', rpm: '3.1.0' })
    const save = jest.spyOn(state, 'savePollerState').mockResolvedValue()
    const res = mockRes()
    await handlePoll(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'poll-tok' }, body: {} }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.body).toMatchObject({ action: 'initialized' })
    expect(save).toHaveBeenCalled()
  })

  it('reports no_change when no new version is detected', async () => {
    jest.spyOn(state, 'loadPollerState').mockResolvedValue({
      deb: { version: '3.1.0', detectedAt: 'x' },
      rpm: null,
    })
    jest
      .spyOn(binaryChecker, 'fetchLatestBinaryVersions')
      .mockResolvedValue({ deb: '3.1.0', rpm: null })
    jest.spyOn(binaryChecker, 'detectNewVersions').mockReturnValue(null)
    const res = mockRes()
    await handlePoll(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'poll-tok' }, body: {} }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.body).toMatchObject({ action: 'no_change' })
  })

  it('skips a non-final version on the stable channel', async () => {
    jest.spyOn(state, 'loadPollerState').mockResolvedValue({
      deb: { version: '3.1.0', detectedAt: 'x' },
      rpm: null,
    })
    jest
      .spyOn(binaryChecker, 'fetchLatestBinaryVersions')
      .mockResolvedValue({ deb: '3.2.0-rc1', rpm: null })
    jest.spyOn(binaryChecker, 'detectNewVersions').mockReturnValue('3.2.0-rc1')
    const res = mockRes()
    await handlePoll(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'poll-tok' }, body: {} }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.body).toMatchObject({ action: 'ignored' })
  })

  it('waits when the public GitHub Release is not yet published', async () => {
    jest.spyOn(state, 'loadPollerState').mockResolvedValue({
      deb: { version: '3.1.2', detectedAt: 'x' },
      rpm: null,
    })
    jest
      .spyOn(binaryChecker, 'fetchLatestBinaryVersions')
      .mockResolvedValue({ deb: '3.1.3', rpm: null })
    jest.spyOn(binaryChecker, 'detectNewVersions').mockReturnValue('3.1.3')
    jest.spyOn(client, 'fetchReleaseBody').mockResolvedValue(null) // not published
    const res = mockRes()
    await handlePoll(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'poll-tok' }, body: {} }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.body).toMatchObject({ action: 'waiting_for_release' })
  })

  it('posts Mattermost + Twitter and advances state on a new final', async () => {
    jest.spyOn(state, 'loadPollerState').mockResolvedValue({
      deb: { version: '3.1.2', detectedAt: 'x' },
      rpm: null,
    })
    jest
      .spyOn(binaryChecker, 'fetchLatestBinaryVersions')
      .mockResolvedValue({ deb: '3.1.3', rpm: '3.1.3' })
    jest.spyOn(binaryChecker, 'detectNewVersions').mockReturnValue('3.1.3')
    jest
      .spyOn(client, 'fetchReleaseBody')
      .mockResolvedValue('release notes body')
    jest
      .spyOn(summarizer, 'summarizeReleaseByTag')
      .mockResolvedValue({ mattermost: '• thing', twitter: 'live now' })
    const send = jest.spyOn(handler, 'sendNotifications').mockResolvedValue()
    jest.spyOn(card, 'renderReleaseCard').mockResolvedValue(Buffer.from('png'))
    const tweet = jest.spyOn(twitter, 'postToTwitter').mockResolvedValue()
    const save = jest.spyOn(state, 'savePollerState').mockResolvedValue()
    const res = mockRes()

    await handlePoll(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'poll-tok' }, body: {} }),
      asRes(res),
      cfg({ twitterPostingEnabled: true }),
      storage
    )

    expect(send).toHaveBeenCalled()
    expect(tweet).toHaveBeenCalled()
    expect(save).toHaveBeenCalled()
    expect(res.body).toMatchObject({ action: 'notified', version: '3.1.3' })
  })

  it('skips Twitter when posting is disabled, still posts Mattermost', async () => {
    jest.spyOn(state, 'loadPollerState').mockResolvedValue({
      deb: { version: '3.1.2', detectedAt: 'x' },
      rpm: null,
    })
    jest
      .spyOn(binaryChecker, 'fetchLatestBinaryVersions')
      .mockResolvedValue({ deb: '3.1.3', rpm: '3.1.3' })
    jest.spyOn(binaryChecker, 'detectNewVersions').mockReturnValue('3.1.3')
    jest
      .spyOn(client, 'fetchReleaseBody')
      .mockResolvedValue('release notes body')
    jest
      .spyOn(summarizer, 'summarizeReleaseByTag')
      .mockResolvedValue({ mattermost: '• thing', twitter: 'live now' })
    const send = jest.spyOn(handler, 'sendNotifications').mockResolvedValue()
    jest.spyOn(card, 'renderReleaseCard').mockResolvedValue(Buffer.from('png'))
    const tweet = jest.spyOn(twitter, 'postToTwitter').mockResolvedValue()
    jest.spyOn(state, 'savePollerState').mockResolvedValue()
    const res = mockRes()

    await handlePoll(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'poll-tok' }, body: {} }),
      asRes(res),
      cfg({ twitterPostingEnabled: false }),
      storage
    )

    expect(send).toHaveBeenCalled()
    expect(tweet).not.toHaveBeenCalled()
    expect(res.body).toMatchObject({ action: 'notified', version: '3.1.3' })
  })

  it('treats a release-lookup error as "not yet published" and waits', async () => {
    jest.spyOn(state, 'loadPollerState').mockResolvedValue({
      deb: { version: '3.1.2', detectedAt: 'x' },
      rpm: null,
    })
    jest
      .spyOn(binaryChecker, 'fetchLatestBinaryVersions')
      .mockResolvedValue({ deb: '3.1.3', rpm: null })
    jest.spyOn(binaryChecker, 'detectNewVersions').mockReturnValue('3.1.3')
    jest.spyOn(client, 'fetchReleaseBody').mockRejectedValue(new Error('500'))
    const res = mockRes()
    await handlePoll(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'poll-tok' }, body: {} }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.body).toMatchObject({ action: 'waiting_for_release' })
  })

  it('still reports notified (and advances state) when the tweet fails', async () => {
    jest.spyOn(state, 'loadPollerState').mockResolvedValue({
      deb: { version: '3.1.2', detectedAt: 'x' },
      rpm: null,
    })
    jest
      .spyOn(binaryChecker, 'fetchLatestBinaryVersions')
      .mockResolvedValue({ deb: '3.1.3', rpm: null })
    jest.spyOn(binaryChecker, 'detectNewVersions').mockReturnValue('3.1.3')
    jest.spyOn(client, 'fetchReleaseBody').mockResolvedValue('body')
    jest
      .spyOn(summarizer, 'summarizeReleaseByTag')
      .mockResolvedValue({ mattermost: '• x', twitter: 'tw' })
    jest.spyOn(handler, 'sendNotifications').mockResolvedValue()
    jest.spyOn(card, 'renderReleaseCard').mockResolvedValue(Buffer.from('png'))
    jest.spyOn(twitter, 'postToTwitter').mockRejectedValue(new Error('429'))
    const save = jest.spyOn(state, 'savePollerState').mockResolvedValue()
    const res = mockRes()

    await handlePoll(
      mockReq({ headers: { 'x-cloud-scheduler-token': 'poll-tok' }, body: {} }),
      asRes(res),
      cfg(),
      storage
    )
    expect(res.body).toMatchObject({ action: 'notified' })
    expect(save).toHaveBeenCalled()
  })

  it('dry-run assembles payloads but posts nothing and does not mutate state', async () => {
    jest.spyOn(state, 'loadPollerState').mockResolvedValue({
      deb: { version: '3.1.2', detectedAt: 'x' },
      rpm: null,
    })
    jest
      .spyOn(binaryChecker, 'fetchLatestBinaryVersions')
      .mockResolvedValue({ deb: '3.1.3', rpm: null })
    jest.spyOn(client, 'fetchReleaseBody').mockResolvedValue('body')
    jest
      .spyOn(summarizer, 'summarizeReleaseByTag')
      .mockResolvedValue({ mattermost: '• x', twitter: 'tw' })
    jest.spyOn(card, 'renderReleaseCard').mockResolvedValue(Buffer.from('png'))
    const send = jest.spyOn(handler, 'sendNotifications').mockResolvedValue()
    const tweet = jest.spyOn(twitter, 'postToTwitter').mockResolvedValue()
    const save = jest.spyOn(state, 'savePollerState').mockResolvedValue()
    const res = mockRes()

    await handlePoll(
      mockReq({
        headers: { 'x-cloud-scheduler-token': 'poll-tok' },
        body: { dryRun: true, version: '3.1.3' },
      }),
      asRes(res),
      cfg(),
      storage
    )

    expect(res.body).toMatchObject({ action: 'dry_run', wouldFire: true })
    expect(send).not.toHaveBeenCalled()
    expect(tweet).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
})
