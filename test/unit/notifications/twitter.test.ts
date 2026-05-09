import { TwitterApi } from 'twitter-api-v2'
import {
  postToTwitter,
  TwitterCredentials,
} from '../../../src/notifications/twitter'

jest.mock('twitter-api-v2')

describe('postToTwitter', () => {
  const creds: TwitterCredentials = {
    appKey: 'key',
    appSecret: 'secret',
    accessToken: 'token',
    accessSecret: 'access-secret',
  }

  afterEach(() => jest.resetAllMocks())

  it('tweets the given text', async () => {
    const mockTweet = jest.fn().mockResolvedValue({ data: { id: '123' } })
    ;(TwitterApi as unknown as jest.Mock).mockImplementation(() => ({
      v2: { tweet: mockTweet },
    }))

    await postToTwitter(creds, 'Hello world!')

    expect(TwitterApi).toHaveBeenCalledWith({
      appKey: 'key',
      appSecret: 'secret',
      accessToken: 'token',
      accessSecret: 'access-secret',
    })
    expect(mockTweet).toHaveBeenCalledWith('Hello world!')
  })

  it('throws on API error', async () => {
    const mockTweet = jest.fn().mockRejectedValue(new Error('Rate limited'))
    ;(TwitterApi as unknown as jest.Mock).mockImplementation(() => ({
      v2: { tweet: mockTweet },
    }))

    await expect(postToTwitter(creds, 'Hello!')).rejects.toThrow(
      'Rate limited'
    )
  })
})
