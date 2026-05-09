import axios from 'axios'
import { postToMattermost } from '../../../src/notifications/mattermost'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

describe('postToMattermost', () => {
  afterEach(() => jest.resetAllMocks())

  it('sends POST with payload to webhook URL', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 })

    const payload = {
      username: 'rippled releases',
      attachments: [{ fallback: 'hello', color: '#000000', text: 'Hello!' }],
    }
    await postToMattermost('https://mm.example.com/hooks/abc', payload)

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://mm.example.com/hooks/abc',
      payload
    )
  })

  it('throws on non-2xx response', async () => {
    mockedAxios.post.mockResolvedValue({ status: 500 })

    await expect(
      postToMattermost('https://mm.example.com/hooks/abc', {
        text: 'Hello!',
      })
    ).rejects.toThrow('Mattermost webhook failed')
  })

  it('throws on network error', async () => {
    mockedAxios.post.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(
      postToMattermost('https://mm.example.com/hooks/abc', {
        text: 'Hello!',
      })
    ).rejects.toThrow('ECONNREFUSED')
  })
})
