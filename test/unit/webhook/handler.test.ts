import winston from 'winston'
import type { Storage } from '@google-cloud/storage'
import {
  handlePushEvent,
  handleReleaseEvent,
} from '../../../src/webhook/handler'
import { tagFloodGuard } from '../../../src/webhook/floodGuard'
import type { AppConfig } from '../../../src/config'
import * as mattermost from '../../../src/notifications/mattermost'
import * as twitter from '../../../src/notifications/twitter'
import * as summarizer from '../../../src/ai/summarizer'
import * as breaking from '../../../src/ai/breaking'

jest.mock('../../../src/github/client')
jest.mock('../../../src/notifications/mattermost', () => ({
  formatMattermost: jest.fn().mockReturnValue({}),
  formatMattermostPrivateTagHeadsUp: jest.fn().mockReturnValue({}),
  formatMattermostPrivateReleaseHeadsUp: jest.fn().mockReturnValue({}),
  postToMattermost: jest.fn(),
}))
jest.mock('../../../src/notifications/twitter')
jest.mock('../../../src/ai/summarizer', () => ({
  MIN_RELEASE_BODY_CHARS: 20,
  summarizeReleaseByTag: jest.fn(),
  summarizeBody: jest.fn(),
}))
jest.mock('../../../src/ai/breaking', () => {
  // Real composer — the section-rendering assertions below exercise it.
  const actual = jest.requireActual<{
    composeBreakingSections: (b: unknown) => string[]
  }>('../../../src/ai/breaking')
  return {
    summarizeBreakingForTag: jest.fn(),
    composeBreakingSections: actual.composeBreakingSections,
  }
})

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
  // Default: no breaking changes. Individual tests override this.
  ;(breaking.summarizeBreakingForTag as jest.Mock).mockResolvedValue({
    breakingNow: '',
    newSurface: '',
    unvotableAmendments: '',
    hasBreakingNow: false,
    hasNewSurface: false,
    hasUnvotableAmendment: false,
  })
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
  twitterPostingEnabled: false,
  gcpProjectId: 'test',
  alphanetSyncDebounceMinutes: 30,
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
    tagFloodGuard.reset()
    ;(mattermost.postToMattermost as jest.Mock).mockResolvedValue(undefined)
    ;(twitter.postToTwitter as jest.Mock).mockResolvedValue(undefined)
    primeSummarizerMocks()
  })

  afterEach(() => jest.resetAllMocks())

  it('ignores non-develop branch pushes (source bumps no longer notify)', async () => {
    for (const ref of [
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

  it('dispatches an alphanet sync on develop pushes, never a notification', async () => {
    const result = await handlePushEvent(
      withRepo({ ref: 'refs/heads/develop', after: 'abc123', commits: [] }),
      deps
    )
    expect(result.action).toBe('alphanet-sync')
    // No sync URL configured in the test config — dispatch reports disabled.
    expect(result.reason).toBe('disabled')
    expect(result.branch).toBe('develop')
    expect(mattermost.postToMattermost).not.toHaveBeenCalled()
    expect(twitter.postToTwitter).not.toHaveBeenCalled()
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
    // Twitter is reserved for the binary-poll path — webhooks never tweet.
    expect(twitter.postToTwitter).not.toHaveBeenCalled()
  })

  it('composes the breaking-on-upgrade section and escalates to "breaking"', async () => {
    ;(breaking.summarizeBreakingForTag as jest.Mock).mockResolvedValue({
      breakingNow: '• Removed RPC field `foo` (abc1234)',
      newSurface: '',
      hasBreakingNow: true,
      hasNewSurface: false,
    })
    const payload = withRepo({
      ref: 'refs/tags/3.2.0-b7',
      head_commit: { id: 'abc123' },
    })

    await handlePushEvent(payload, deps)

    const [, source, body, , level] = (mattermost.formatMattermost as jest.Mock)
      .mock.calls[0]
    expect(source).toBe('tag')
    expect(level).toBe('breaking')
    expect(body).toContain('**:rotating_light: Breaking on upgrade:**')
    expect(body).toContain('Removed RPC field `foo`')
    expect(body).toContain('mock bullet') // narrative still appended below
    // Narrative summary on the tag path must NOT label its own section.
    expect(summarizer.summarizeReleaseByTag).toHaveBeenCalledWith(
      expect.objectContaining({ labelBreaking: false })
    )
  })

  it('uses the amber "surface" level when only new protocol surface is found', async () => {
    ;(breaking.summarizeBreakingForTag as jest.Mock).mockResolvedValue({
      breakingNow: '',
      newSurface: '• Transaction type `MPTokenIssuanceCreate`',
      hasBreakingNow: false,
      hasNewSurface: true,
    })
    const payload = withRepo({
      ref: 'refs/tags/3.2.0-b7',
      head_commit: { id: 'abc123' },
    })

    await handlePushEvent(payload, deps)

    const [, , body, , level] = (mattermost.formatMattermost as jest.Mock).mock
      .calls[0]
    expect(level).toBe('surface')
    expect(body).toContain('New protocol surface')
    expect(body).toContain('`MPTokenIssuanceCreate`')
    expect(body).not.toContain('Breaking on upgrade')
  })

  it('renders the "added but NOT votable" alert and escalates to "surface"', async () => {
    ;(breaking.summarizeBreakingForTag as jest.Mock).mockResolvedValue({
      breakingNow: '',
      newSurface: '',
      unvotableAmendments:
        '• `MPTokensV2` — present in the binary but `Supported::No`, so the network cannot vote it in or enable it. Do NOT describe it as supported/available.',
      hasBreakingNow: false,
      hasNewSurface: false,
      hasUnvotableAmendment: true,
    })
    const payload = withRepo({
      ref: 'refs/tags/3.2.0',
      head_commit: { id: 'abc123' },
    })

    await handlePushEvent(payload, deps)

    const [, , body, , level] = (mattermost.formatMattermost as jest.Mock).mock
      .calls[0]
    expect(level).toBe('surface')
    expect(body).toContain("Added but NOT votable — don't claim support")
    expect(body).toContain('`MPTokensV2`')
    expect(body).toContain('Supported::No')
    expect(body).not.toContain('Breaking on upgrade')
  })

  it('stays at level "none" (blue) when nothing is flagged', async () => {
    const payload = withRepo({
      ref: 'refs/tags/3.2.0-b7',
      head_commit: { id: 'abc123' },
    })

    await handlePushEvent(payload, deps)

    const [, , body, , level] = (mattermost.formatMattermost as jest.Mock).mock
      .calls[0]
    expect(level).toBe('none')
    expect(body).not.toContain('Breaking on upgrade')
    expect(body).not.toContain('New protocol surface')
  })

  it('still posts the tag when breaking detection throws', async () => {
    ;(breaking.summarizeBreakingForTag as jest.Mock).mockRejectedValue(
      new Error('GitHub 500')
    )
    const payload = withRepo({
      ref: 'refs/tags/3.2.0-b7',
      head_commit: { id: 'abc123' },
    })

    const result = await handlePushEvent(payload, deps)

    expect(result.action).toBe('notified')
    expect(mattermost.postToMattermost).toHaveBeenCalledTimes(1)
    const [, , , , level] = (mattermost.formatMattermost as jest.Mock).mock
      .calls[0]
    expect(level).toBe('none')
  })

  it('does not run breaking detection on the private tag path', async () => {
    const payload = withRepo(
      { ref: 'refs/tags/3.2.0-b7', head_commit: { id: 'abc123' } },
      PRIVATE_REPO_FULL_NAME
    )

    await handlePushEvent(payload, deps)

    expect(breaking.summarizeBreakingForTag).not.toHaveBeenCalled()
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

  it('notifies on RC tag push (no longer ignored)', async () => {
    const payload = withRepo({
      ref: 'refs/tags/3.1.0-rc1',
      head_commit: { id: 'abc123' },
    })
    const result = await handlePushEvent(payload, deps)
    expect(result.action).toBe('notified')
    expect(result.type).toBe('rc')
    expect(mattermost.postToMattermost).toHaveBeenCalled()
  })

  it('notifies on FINAL tag push (no longer ignored)', async () => {
    const payload = withRepo({
      ref: 'refs/tags/3.1.0',
      head_commit: { id: 'abc123' },
    })
    const result = await handlePushEvent(payload, deps)
    expect(result.action).toBe('notified')
    expect(result.type).toBe('final')
    expect(mattermost.postToMattermost).toHaveBeenCalled()
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
    tagFloodGuard.reset()
    ;(mattermost.postToMattermost as jest.Mock).mockResolvedValue(undefined)
    ;(twitter.postToTwitter as jest.Mock).mockResolvedValue(undefined)
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
    expect(twitter.postToTwitter).not.toHaveBeenCalled()
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
    tagFloodGuard.reset()
    ;(mattermost.postToMattermost as jest.Mock).mockResolvedValue(undefined)
    ;(twitter.postToTwitter as jest.Mock).mockResolvedValue(undefined)
    primeSummarizerMocks()
  })

  afterEach(() => jest.resetAllMocks())

  it('private release with body: posts heads-up via summarizeBody, no Twitter', async () => {
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
  })

  it('private release with empty body: still posts heads-up (no API fallback)', async () => {
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
  })

  it('private RC tag push: bare heads-up (no longer ignored)', async () => {
    const payload = withRepo(
      {
        ref: 'refs/tags/3.2.0-rc4',
        head_commit: { id: 'def4567890abcd' },
      },
      PRIVATE_REPO_FULL_NAME
    )

    const result = await handlePushEvent(payload, deps)

    expect(result.action).toBe('notified')
    expect(result.type).toBe('rc')
    expect(result.source).toBe('tag-private')
    expect(mattermost.formatMattermostPrivateTagHeadsUp).toHaveBeenCalled()
    expect(mattermost.postToMattermost).toHaveBeenCalledTimes(1)
    expect(twitter.postToTwitter).not.toHaveBeenCalled()
  })
})
