import winston from 'winston'
import type { Storage } from '@google-cloud/storage'
import {
  handlePushEvent,
  handleReleaseEvent,
} from '../../../src/webhook/handler'
import type { AppConfig } from '../../../src/config'
import * as mattermost from '../../../src/notifications/mattermost'
import * as twitter from '../../../src/notifications/twitter'
import * as summarizer from '../../../src/ai/summarizer'
import * as dedup from '../../../src/dedup/store'

jest.mock('../../../src/github/client')
jest.mock('../../../src/notifications/mattermost', () => ({
  formatMattermost: jest.fn().mockReturnValue({}),
  formatMattermostPrivateTagHeadsUp: jest.fn().mockReturnValue({}),
  formatMattermostPrivateReleaseHeadsUp: jest.fn().mockReturnValue({}),
  postToMattermost: jest.fn(),
}))
jest.mock('../../../src/notifications/twitter')
jest.mock('../../../src/dedup/store', () => ({
  tryClaim: jest.fn(),
}))
jest.mock('../../../src/ai/summarizer', () => ({
  MIN_RELEASE_BODY_CHARS: 20,
  summarizeReleaseByTag: jest.fn(),
  summarizeBody: jest.fn(),
}))

const MOCK_SUMMARIES = {
  mattermost: '**What changed:**\n• mock bullet',
  twitter: 'mock tweet #XRPLedger #rippled',
}

const PUBLIC_REPO_FULL_NAME = 'XRPLF/rippled'
const PRIVATE_REPO_FULL_NAME = 'XRPLF/xrpld-private'

function primeSummarizerMocks(): void {
  ;(summarizer.summarizeReleaseByTag as jest.Mock).mockResolvedValue(
    MOCK_SUMMARIES
  )
  ;(summarizer.summarizeBody as jest.Mock).mockResolvedValue(MOCK_SUMMARIES)
}

const logger = winston.createLogger({ silent: true })

const mockConfig: AppConfig = {
  port: 3000,
  githubWebhookSecret: 'secret',
  githubToken: 'token',
  mattermostWebhookUrl: 'https://mm.example.com/hooks/abc',
  twitterApiKey: 'key',
  twitterApiSecret: 'secret',
  twitterAccessToken: 'token',
  twitterAccessTokenSecret: 'access-secret',
  anthropicApiKey: 'test-anthropic-key',
  gcpProjectId: 'test',
}

const mockStorage = {} as Storage

const deps = { config: mockConfig, storage: mockStorage, logger }

function withRepo<T extends Record<string, unknown>>(
  payload: T,
  fullName = PUBLIC_REPO_FULL_NAME
): T & { repository: { full_name: string } } {
  return { ...payload, repository: { full_name: fullName } }
}

describe('handlePushEvent', () => {
  beforeEach(() => {
    ;(mattermost.postToMattermost as jest.Mock).mockResolvedValue(undefined)
    ;(twitter.postToTwitter as jest.Mock).mockResolvedValue(undefined)
    ;(dedup.tryClaim as jest.Mock).mockResolvedValue(true)
    primeSummarizerMocks()
  })

  afterEach(() => jest.resetAllMocks())

  it('ignores all branch pushes (source bumps no longer notify)', async () => {
    for (const ref of [
      'refs/heads/develop',
      'refs/heads/release-3.1',
      'refs/heads/feature/my-feature',
    ]) {
      const result = await handlePushEvent(
        withRepo({ ref, after: 'abc123', commits: [] }),
        deps
      )
      expect(result.action).toBe('ignored')
      expect(mattermost.postToMattermost).not.toHaveBeenCalled()
      expect(twitter.postToTwitter).not.toHaveBeenCalled()
    }
  })

  it('notifies on a BETA tag push', async () => {
    const payload = withRepo({
      ref: 'refs/tags/3.2.0-b7',
      head_commit: {
        id: 'abc123',
        url: 'https://github.com/XRPLF/rippled/commit/abc123',
      },
    })
    const result = await handlePushEvent(payload, deps)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.2.0-b7')
    expect(result.type).toBe('beta')
    expect(result.source).toBe('tag')
    expect(result.repo).toBe(PUBLIC_REPO_FULL_NAME)
    expect(mattermost.postToMattermost).toHaveBeenCalled()
    expect(twitter.postToTwitter).toHaveBeenCalled()
  })

  it('accepts BETA tag with v prefix', async () => {
    const payload = withRepo({
      ref: 'refs/tags/v3.2.0-b7',
      head_commit: {
        id: 'abc123',
        url: 'https://github.com/XRPLF/rippled/commit/abc123',
      },
    })
    const result = await handlePushEvent(payload, deps)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.2.0-b7')
  })

  it('ignores RC tag pushes — release event will notify instead', async () => {
    const payload = withRepo({
      ref: 'refs/tags/3.1.0-rc1',
      head_commit: { id: 'abc123' },
    })
    const result = await handlePushEvent(payload, deps)
    expect(result.action).toBe('ignored')
    expect(mattermost.postToMattermost).not.toHaveBeenCalled()
  })

  it('ignores FINAL tag pushes — release event will notify instead', async () => {
    const payload = withRepo({
      ref: 'refs/tags/3.1.0',
      head_commit: { id: 'abc123' },
    })
    const result = await handlePushEvent(payload, deps)
    expect(result.action).toBe('ignored')
    expect(mattermost.postToMattermost).not.toHaveBeenCalled()
  })

  it('ignores tag deletion events', async () => {
    const payload = withRepo({
      ref: 'refs/tags/3.2.0-b7',
      deleted: true,
      head_commit: null,
    })
    const result = await handlePushEvent(payload, deps)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('tag deletion')
  })

  it('ignores tags that do not match the version pattern', async () => {
    const payload = withRepo({
      ref: 'refs/tags/not-a-version',
      head_commit: { id: 'abc123' },
    })
    const result = await handlePushEvent(payload, deps)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('tag does not match version pattern')
  })

  it('ignores events from unknown repositories', async () => {
    const payload = withRepo(
      { ref: 'refs/tags/3.2.0-b7', head_commit: { id: 'abc123' } },
      'someoneelse/rippled'
    )
    const result = await handlePushEvent(payload, deps)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('unknown repository')
  })
})

describe('handleReleaseEvent', () => {
  beforeEach(() => {
    ;(mattermost.postToMattermost as jest.Mock).mockResolvedValue(undefined)
    ;(twitter.postToTwitter as jest.Mock).mockResolvedValue(undefined)
    ;(dedup.tryClaim as jest.Mock).mockResolvedValue(true)
    primeSummarizerMocks()
  })

  afterEach(() => jest.resetAllMocks())

  it('notifies when a release is published', async () => {
    const payload = withRepo({
      action: 'published',
      release: {
        tag_name: '3.1.0',
        html_url: 'https://github.com/XRPLF/rippled/releases/tag/3.1.0',
        draft: false,
        prerelease: false,
      },
    })
    const result = await handleReleaseEvent(payload, deps)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.1.0')
    expect(result.source).toBe('release')
    expect(result.repo).toBe(PUBLIC_REPO_FULL_NAME)
    expect(mattermost.postToMattermost).toHaveBeenCalled()
    expect(twitter.postToTwitter).toHaveBeenCalled()
  })

  it('strips a v prefix on release tag_name', async () => {
    const payload = withRepo({
      action: 'published',
      release: {
        tag_name: 'v3.1.0',
        html_url: 'https://github.com/XRPLF/rippled/releases/tag/v3.1.0',
        draft: false,
        prerelease: false,
      },
    })
    const result = await handleReleaseEvent(payload, deps)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.1.0')
  })

  it('ignores draft releases', async () => {
    const payload = withRepo({
      action: 'published',
      release: { tag_name: '3.1.0', draft: true, prerelease: false },
    })
    const result = await handleReleaseEvent(payload, deps)
    expect(result.action).toBe('ignored')
    expect(mattermost.postToMattermost).not.toHaveBeenCalled()
  })

  it('ignores non-published release actions', async () => {
    const payload = withRepo({
      action: 'edited',
      release: { tag_name: '3.1.0', draft: false, prerelease: false },
    })
    const result = await handleReleaseEvent(payload, deps)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('release action: edited')
  })

  it('ignores releases whose tag does not match a version', async () => {
    const payload = withRepo({
      action: 'published',
      release: { tag_name: 'foo-bar', draft: false, prerelease: false },
    })
    const result = await handleReleaseEvent(payload, deps)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('release tag does not match version pattern')
  })
})

describe('dual-repo behavior', () => {
  beforeEach(() => {
    ;(mattermost.postToMattermost as jest.Mock).mockResolvedValue(undefined)
    ;(twitter.postToTwitter as jest.Mock).mockResolvedValue(undefined)
    primeSummarizerMocks()
  })

  afterEach(() => jest.resetAllMocks())

  it('public-then-public: dedup blocks the second post on both channels', async () => {
    ;(dedup.tryClaim as jest.Mock).mockResolvedValueOnce(true) // mm 1st
    ;(dedup.tryClaim as jest.Mock).mockResolvedValueOnce(true) // tw 1st
    ;(dedup.tryClaim as jest.Mock).mockResolvedValue(false) // 2nd call both fail

    const payload = withRepo({
      action: 'published',
      release: {
        tag_name: '3.1.0',
        html_url: 'https://github.com/XRPLF/rippled/releases/tag/3.1.0',
        draft: false,
        prerelease: false,
      },
    })

    await handleReleaseEvent(payload, deps)
    await handleReleaseEvent(payload, deps)

    expect(mattermost.postToMattermost).toHaveBeenCalledTimes(1)
    expect(twitter.postToTwitter).toHaveBeenCalledTimes(1)
  })

  it('private release with body: posts heads-up to Mattermost via summarizeBody, skips Twitter', async () => {
    ;(dedup.tryClaim as jest.Mock).mockResolvedValue(true)

    const payload = withRepo(
      {
        action: 'published',
        release: {
          tag_name: '3.2.0-rc2',
          html_url:
            'https://github.com/XRPLF/xrpld-private/releases/tag/3.2.0-rc2',
          draft: false,
          prerelease: true,
          body: 'Lots of important RC2 changes that fill more than twenty characters.',
        },
      },
      PRIVATE_REPO_FULL_NAME
    )

    const result = await handleReleaseEvent(payload, deps)

    expect(result.action).toBe('notified')
    expect(result.source).toBe('release-private')
    expect(result.repo).toBe(PRIVATE_REPO_FULL_NAME)
    expect(summarizer.summarizeBody).toHaveBeenCalledTimes(1)
    expect(summarizer.summarizeReleaseByTag).not.toHaveBeenCalled()
    expect(mattermost.formatMattermostPrivateReleaseHeadsUp).toHaveBeenCalled()
    expect(mattermost.postToMattermost).toHaveBeenCalledTimes(1)
    expect(twitter.postToTwitter).not.toHaveBeenCalled()
    // Only Mattermost claims a dedup slot; Twitter is short-circuited.
    expect(dedup.tryClaim).toHaveBeenCalledTimes(1)
    expect(dedup.tryClaim).toHaveBeenCalledWith(
      expect.anything(),
      'mattermost',
      'release-private',
      '3.2.0-rc2',
      PRIVATE_REPO_FULL_NAME
    )
  })

  it('private release with empty body: still posts heads-up (no API fallback)', async () => {
    ;(dedup.tryClaim as jest.Mock).mockResolvedValue(true)

    const payload = withRepo(
      {
        action: 'published',
        release: {
          tag_name: '3.2.0-rc3',
          html_url:
            'https://github.com/XRPLF/xrpld-private/releases/tag/3.2.0-rc3',
          draft: false,
          prerelease: true,
          body: '',
        },
      },
      PRIVATE_REPO_FULL_NAME
    )

    await handleReleaseEvent(payload, deps)

    // Critically: we must NOT call summarizeReleaseByTag on the private path
    // even when the body is empty — that would hit the GitHub API.
    expect(summarizer.summarizeReleaseByTag).not.toHaveBeenCalled()
    expect(summarizer.summarizeBody).not.toHaveBeenCalled()
    expect(mattermost.formatMattermostPrivateReleaseHeadsUp).toHaveBeenCalled()
    expect(mattermost.postToMattermost).toHaveBeenCalledTimes(1)
    expect(twitter.postToTwitter).not.toHaveBeenCalled()
  })

  it('private BETA tag push: bare heads-up, no API calls, no Twitter', async () => {
    ;(dedup.tryClaim as jest.Mock).mockResolvedValue(true)

    const payload = withRepo(
      {
        ref: 'refs/tags/3.2.0-b7',
        head_commit: { id: 'abc1234567890' },
      },
      PRIVATE_REPO_FULL_NAME
    )

    const result = await handlePushEvent(payload, deps)

    expect(result.action).toBe('notified')
    expect(result.source).toBe('tag-private')
    expect(summarizer.summarizeReleaseByTag).not.toHaveBeenCalled()
    expect(mattermost.formatMattermostPrivateTagHeadsUp).toHaveBeenCalled()
    expect(mattermost.postToMattermost).toHaveBeenCalledTimes(1)
    expect(twitter.postToTwitter).not.toHaveBeenCalled()
    expect(dedup.tryClaim).toHaveBeenCalledWith(
      expect.anything(),
      'mattermost',
      'tag-private',
      '3.2.0-b7',
      PRIVATE_REPO_FULL_NAME
    )
  })

  it('private-then-public for same tag: both fire (different scenario keys)', async () => {
    // Distinct scenarios — `release-private` and `release` — so the heads-up
    // and the canonical post never share a dedup slot.
    ;(dedup.tryClaim as jest.Mock).mockResolvedValue(true)

    const release = {
      tag_name: '3.1.0',
      html_url: 'https://github.com/XRPLF/rippled/releases/tag/3.1.0',
      draft: false,
      prerelease: false,
      body: 'Final release notes that go above the minimum body length.',
    }
    await handleReleaseEvent(
      withRepo({ action: 'published', release }, PRIVATE_REPO_FULL_NAME),
      deps
    )
    await handleReleaseEvent(
      withRepo({ action: 'published', release }, PUBLIC_REPO_FULL_NAME),
      deps
    )

    // Two Mattermost posts (heads-up + canonical), one tweet (canonical only).
    expect(mattermost.postToMattermost).toHaveBeenCalledTimes(2)
    expect(twitter.postToTwitter).toHaveBeenCalledTimes(1)
  })
})
