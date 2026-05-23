import * as githubClient from '../../../src/github/client'
import { summarizeReleaseByTag } from '../../../src/ai/summarizer'

jest.mock('../../../src/github/client')
jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn()
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create },
    })),
    // Re-export for assertions in the test file
    __create: create,
  }
})

// Pull the mocked create back out
import Anthropic from '@anthropic-ai/sdk'
const mockedAnthropicModule = jest.requireMock<{ __create: jest.Mock }>(
  '@anthropic-ai/sdk'
)
const mockCreate = mockedAnthropicModule.__create

const mockedClient = githubClient as jest.Mocked<typeof githubClient>

function aiResponse(text: string) {
  return Promise.resolve({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  })
}

describe('summarizeReleaseByTag', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(Anthropic as unknown as jest.Mock).mockClear()
  })

  it('returns empty summaries when apiKey is missing', async () => {
    const result = await summarizeReleaseByTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.1.3',
    })
    expect(result).toEqual({ mattermost: null, twitter: null })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('summarizes from GitHub Release body when one exists', async () => {
    mockedClient.fetchReleaseBody.mockResolvedValue(
      'Long enough release body content here.'
    )
    mockCreate.mockReturnValueOnce(aiResponse('• Security fix\n• Bug fix'))
    mockCreate.mockReturnValueOnce(
      aiResponse('rippled 3.1.3 ships a security fix. #XRPLedger #rippled')
    )

    const result = await summarizeReleaseByTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.1.3',
      apiKey: 'test-key',
    })

    expect(result.mattermost).toContain("**What's in this release:**")
    expect(result.mattermost).toContain('• Security fix')
    expect(result.twitter).toBe(
      'rippled 3.1.3 ships a security fix. #XRPLedger #rippled'
    )
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(mockedClient.listVersionTags).not.toHaveBeenCalled()
  })

  it('falls back to commit-compare when no Release body exists', async () => {
    mockedClient.fetchReleaseBody.mockResolvedValue(null)
    mockedClient.listVersionTags.mockResolvedValue([
      '3.2.0-b4',
      '3.2.0-b5',
      '3.2.0-b6',
    ])
    mockedClient.compareCommits.mockResolvedValue([
      { sha: 'abc1234', message: 'Add MPT support to DEX', author: 'alice' },
      { sha: 'def5678', message: 'Fix consensus race', author: 'bob' },
    ])
    mockCreate.mockReturnValueOnce(aiResponse('• MPT support\n• Race fix'))
    mockCreate.mockReturnValueOnce(
      aiResponse(
        'rippled 3.2.0-b6 adds MPT and fixes a race. #XRPLedger #rippled'
      )
    )

    const result = await summarizeReleaseByTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.2.0-b6',
      apiKey: 'test-key',
    })

    expect(result.mattermost).toContain('Preliminary changes since')
    expect(result.mattermost).toContain('3.2.0-b5')
    expect(result.mattermost).toContain('• MPT support')
    expect(result.twitter).toContain('3.2.0-b6')
    expect(mockedClient.compareCommits).toHaveBeenCalledWith(
      'XRPLF',
      'rippled',
      '3.2.0-b5',
      '3.2.0-b6',
      undefined
    )
  })

  it('picks last stable as base for a final tag (skips prereleases)', async () => {
    mockedClient.fetchReleaseBody.mockResolvedValue(null)
    mockedClient.listVersionTags.mockResolvedValue([
      '3.1.3',
      '3.2.0-b5',
      '3.2.0-b6',
      '3.2.0-rc1',
    ])
    mockedClient.compareCommits.mockResolvedValue([
      { sha: 'a', message: 'feat: foo', author: 'x' },
    ])
    mockCreate.mockReturnValue(aiResponse('• foo'))

    await summarizeReleaseByTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.2.0',
      apiKey: 'test-key',
    })

    expect(mockedClient.compareCommits).toHaveBeenCalledWith(
      'XRPLF',
      'rippled',
      '3.1.3', // skipped all prereleases
      '3.2.0',
      undefined
    )
  })

  it('returns empty when no predecessor tag exists', async () => {
    mockedClient.fetchReleaseBody.mockResolvedValue(null)
    mockedClient.listVersionTags.mockResolvedValue(['3.2.0-b6'])

    const result = await summarizeReleaseByTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.2.0-b6',
      apiKey: 'test-key',
    })

    expect(result).toEqual({ mattermost: null, twitter: null })
    expect(mockedClient.compareCommits).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns empty if compareCommits fails', async () => {
    mockedClient.fetchReleaseBody.mockResolvedValue(null)
    mockedClient.listVersionTags.mockResolvedValue(['3.2.0-b5', '3.2.0-b6'])
    mockedClient.compareCommits.mockRejectedValue(new Error('GitHub 500'))

    const result = await summarizeReleaseByTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.2.0-b6',
      apiKey: 'test-key',
    })

    expect(result).toEqual({ mattermost: null, twitter: null })
  })

  it('filters trivial commits (merges, version bumps, clang-format)', async () => {
    mockedClient.fetchReleaseBody.mockResolvedValue(null)
    mockedClient.listVersionTags.mockResolvedValue(['3.2.0-b5', '3.2.0-b6'])
    mockedClient.compareCommits.mockResolvedValue([
      { sha: 'a', message: 'Merge pull request #123', author: 'x' },
      { sha: 'b', message: 'bump version to 3.2.0-b6', author: 'x' },
      { sha: 'c', message: 'clang-format pass', author: 'x' },
      { sha: 'd', message: 'feat: substantive change', author: 'x' },
    ])
    mockCreate.mockReturnValue(aiResponse('• substantive change'))

    await summarizeReleaseByTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.2.0-b6',
      apiKey: 'test-key',
    })

    // The user-message content sent to Claude should only include the
    // substantive commit, not the merge/bump/clang-format ones.
    const firstCallArgs = mockCreate.mock.calls[0] as unknown[]
    const mattermostCall = firstCallArgs[0] as {
      messages: { content: string }[]
    }
    const sentContent = mattermostCall.messages[0].content
    expect(sentContent).toContain('substantive change')
    expect(sentContent).not.toContain('Merge pull request')
    expect(sentContent).not.toContain('bump version')
    expect(sentContent).not.toContain('clang-format')
  })

  it('drops a Twitter summary that exceeds 280 chars', async () => {
    mockedClient.fetchReleaseBody.mockResolvedValue(
      'Long enough release body content here.'
    )
    mockCreate.mockReturnValueOnce(aiResponse('• Good bullets'))
    // Simulate Claude ignoring the length limit
    mockCreate.mockReturnValueOnce(aiResponse('x'.repeat(300)))

    const result = await summarizeReleaseByTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.1.3',
      apiKey: 'test-key',
    })

    expect(result.mattermost).toBeTruthy()
    // Over-length tweet is rejected so we fall back to the formatter's default
    expect(result.twitter).toBeNull()
  })

  it('treats blank/short release body as "no body" and falls back to commits', async () => {
    mockedClient.fetchReleaseBody.mockResolvedValue('   ')
    mockedClient.listVersionTags.mockResolvedValue(['3.2.0-b5', '3.2.0-b6'])
    mockedClient.compareCommits.mockResolvedValue([
      { sha: 'a', message: 'feat: foo', author: 'x' },
    ])
    mockCreate.mockReturnValue(aiResponse('• foo'))

    const result = await summarizeReleaseByTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.2.0-b6',
      apiKey: 'test-key',
    })

    expect(mockedClient.compareCommits).toHaveBeenCalled()
    expect(result.mattermost).toContain('Preliminary changes since')
  })
})
