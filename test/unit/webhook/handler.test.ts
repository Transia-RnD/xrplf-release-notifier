import winston from 'winston'
import {
  handlePushEvent,
  handleReleaseEvent,
} from '../../../src/webhook/handler'
import type { AppConfig } from '../../../src/config'
import * as githubClient from '../../../src/github/client'
import * as mattermost from '../../../src/notifications/mattermost'
import * as twitter from '../../../src/notifications/twitter'

jest.mock('../../../src/github/client')
jest.mock('../../../src/notifications/mattermost')
jest.mock('../../../src/notifications/twitter')

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
  gcpProjectId: 'test',
  gcsBucket: 'test-bucket',
}

const buildInfoContent = 'char const* const versionString = "3.2.0-b4"'

describe('handlePushEvent', () => {
  beforeEach(() => {
    ;(githubClient.fetchFileContent as jest.Mock).mockResolvedValue(
      buildInfoContent
    )
    ;(mattermost.postToMattermost as jest.Mock).mockResolvedValue(undefined)
    ;(twitter.postToTwitter as jest.Mock).mockResolvedValue(undefined)
  })

  afterEach(() => jest.resetAllMocks())

  it('ignores pushes to non-watched branches', async () => {
    const payload = {
      ref: 'refs/heads/feature/my-feature',
      after: 'abc123',
      commits: [],
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('branch not watched')
  })

  it('ignores pushes that do not modify BuildInfo.cpp', async () => {
    const payload = {
      ref: 'refs/heads/develop',
      after: 'abc123',
      commits: [{ modified: ['README.md'], added: [] }],
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('BuildInfo.cpp not modified')
  })

  it('processes develop branch version bump', async () => {
    const payload = {
      ref: 'refs/heads/develop',
      after: 'abc123',
      commits: [
        {
          modified: ['src/libxrpl/protocol/BuildInfo.cpp'],
          added: [],
        },
      ],
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.2.0-b4')
    expect(result.type).toBe('beta')
    expect(result.branch).toBe('develop')
    expect(mattermost.postToMattermost).toHaveBeenCalled()
    expect(twitter.postToTwitter).toHaveBeenCalled()
  })

  it('processes release branch version bump', async () => {
    ;(githubClient.fetchFileContent as jest.Mock).mockResolvedValue(
      'char const* const versionString = "3.1.0"'
    )
    const payload = {
      ref: 'refs/heads/release-3.1',
      after: 'def456',
      commits: [
        {
          modified: ['src/libxrpl/protocol/BuildInfo.cpp'],
          added: [],
        },
      ],
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.1.0')
    expect(result.type).toBe('final')
    expect(result.branch).toBe('release-3.1')
  })

  it('still sends remaining notifications if one fails', async () => {
    ;(mattermost.postToMattermost as jest.Mock).mockRejectedValue(
      new Error('MM down')
    )
    const payload = {
      ref: 'refs/heads/develop',
      after: 'abc123',
      commits: [
        {
          modified: ['src/libxrpl/protocol/BuildInfo.cpp'],
          added: [],
        },
      ],
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('notified')
    expect(twitter.postToTwitter).toHaveBeenCalled()
  })

  it('detects BuildInfo.cpp in added files', async () => {
    const payload = {
      ref: 'refs/heads/develop',
      after: 'abc123',
      commits: [
        {
          modified: [],
          added: ['src/libxrpl/protocol/BuildInfo.cpp'],
        },
      ],
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('notified')
  })

  it('returns error when version string cannot be parsed', async () => {
    ;(githubClient.fetchFileContent as jest.Mock).mockResolvedValue(
      '// no version string here'
    )
    const payload = {
      ref: 'refs/heads/develop',
      after: 'abc123',
      commits: [
        {
          modified: ['src/libxrpl/protocol/BuildInfo.cpp'],
          added: [],
        },
      ],
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('error')
    expect(result.reason).toBe('Could not parse version string')
  })

  it('throws when GitHub API fetch fails', async () => {
    ;(githubClient.fetchFileContent as jest.Mock).mockRejectedValue(
      new Error('404 Not Found')
    )
    const payload = {
      ref: 'refs/heads/develop',
      after: 'abc123',
      commits: [
        {
          modified: ['src/libxrpl/protocol/BuildInfo.cpp'],
          added: [],
        },
      ],
    }
    await expect(handlePushEvent(payload, mockConfig, logger)).rejects.toThrow(
      '404 Not Found'
    )
  })

  it('handles both notifications failing', async () => {
    ;(mattermost.postToMattermost as jest.Mock).mockRejectedValue(
      new Error('MM down')
    )
    ;(twitter.postToTwitter as jest.Mock).mockRejectedValue(
      new Error('Twitter down')
    )
    const payload = {
      ref: 'refs/heads/develop',
      after: 'abc123',
      commits: [
        {
          modified: ['src/libxrpl/protocol/BuildInfo.cpp'],
          added: [],
        },
      ],
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.2.0-b4')
  })

  it('notifies on tag push that matches a version pattern', async () => {
    const payload = {
      ref: 'refs/tags/3.1.0',
      after: 'abc123',
      head_commit: {
        id: 'abc123',
        url: 'https://github.com/XRPLF/rippled/commit/abc123',
      },
      commits: [],
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.1.0')
    expect(result.type).toBe('final')
    expect(result.source).toBe('tag')
  })

  it('accepts tag with v prefix', async () => {
    const payload = {
      ref: 'refs/tags/v3.1.0',
      head_commit: {
        id: 'abc123',
        url: 'https://github.com/XRPLF/rippled/commit/abc123',
      },
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.1.0')
  })

  it('ignores tag deletion events', async () => {
    const payload = {
      ref: 'refs/tags/3.1.0',
      deleted: true,
      head_commit: null,
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('tag deletion')
  })

  it('ignores tags that do not match the version pattern', async () => {
    const payload = {
      ref: 'refs/tags/not-a-version',
      head_commit: { id: 'abc123' },
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('tag does not match version pattern')
  })

  it('handles RC version on release branch', async () => {
    ;(githubClient.fetchFileContent as jest.Mock).mockResolvedValue(
      'char const* const versionString = "3.1.0-rc2"'
    )
    const payload = {
      ref: 'refs/heads/release-3.1',
      after: 'abc123',
      commits: [
        {
          modified: ['src/libxrpl/protocol/BuildInfo.cpp'],
          added: [],
        },
      ],
    }
    const result = await handlePushEvent(payload, mockConfig, logger)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.1.0-rc2')
    expect(result.type).toBe('rc')
  })
})

describe('handleReleaseEvent', () => {
  beforeEach(() => {
    ;(mattermost.postToMattermost as jest.Mock).mockResolvedValue(undefined)
    ;(twitter.postToTwitter as jest.Mock).mockResolvedValue(undefined)
  })

  afterEach(() => jest.resetAllMocks())

  it('notifies when a release is published', async () => {
    const payload = {
      action: 'published',
      release: {
        tag_name: '3.1.0',
        html_url: 'https://github.com/XRPLF/rippled/releases/tag/3.1.0',
        draft: false,
        prerelease: false,
      },
    }
    const result = await handleReleaseEvent(payload, mockConfig, logger)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.1.0')
    expect(result.source).toBe('release')
    expect(mattermost.postToMattermost).toHaveBeenCalled()
    expect(twitter.postToTwitter).toHaveBeenCalled()
  })

  it('strips a v prefix on release tag_name', async () => {
    const payload = {
      action: 'published',
      release: {
        tag_name: 'v3.1.0',
        html_url: 'https://github.com/XRPLF/rippled/releases/tag/v3.1.0',
        draft: false,
        prerelease: false,
      },
    }
    const result = await handleReleaseEvent(payload, mockConfig, logger)
    expect(result.action).toBe('notified')
    expect(result.version).toBe('3.1.0')
  })

  it('ignores draft releases', async () => {
    const payload = {
      action: 'published',
      release: { tag_name: '3.1.0', draft: true, prerelease: false },
    }
    const result = await handleReleaseEvent(payload, mockConfig, logger)
    expect(result.action).toBe('ignored')
    expect(mattermost.postToMattermost).not.toHaveBeenCalled()
  })

  it('ignores non-published release actions', async () => {
    const payload = {
      action: 'edited',
      release: { tag_name: '3.1.0', draft: false, prerelease: false },
    }
    const result = await handleReleaseEvent(payload, mockConfig, logger)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('release action: edited')
  })

  it('ignores releases whose tag does not match a version', async () => {
    const payload = {
      action: 'published',
      release: { tag_name: 'foo-bar', draft: false, prerelease: false },
    }
    const result = await handleReleaseEvent(payload, mockConfig, logger)
    expect(result.action).toBe('ignored')
    expect(result.reason).toBe('release tag does not match version pattern')
  })
})
