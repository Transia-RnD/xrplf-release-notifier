import axios from 'axios'
import { fetchFileContent } from '../../../src/github/client'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

describe('fetchFileContent', () => {
  afterEach(() => jest.resetAllMocks())

  it('fetches file content at a specific SHA', async () => {
    mockedAxios.get.mockResolvedValue({
      data: 'char const* const versionString = "3.1.0"',
    })

    const content = await fetchFileContent(
      'XRPLF',
      'rippled',
      'src/libxrpl/protocol/BuildInfo.cpp',
      'abc123'
    )

    expect(content).toBe('char const* const versionString = "3.1.0"')
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/repos/XRPLF/rippled/contents/'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github.raw+json',
        }),
      })
    )
  })

  it('includes auth header when token provided', async () => {
    mockedAxios.get.mockResolvedValue({ data: 'content' })

    await fetchFileContent('XRPLF', 'rippled', 'file.cpp', 'sha', 'my-token')

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-token',
        }),
      })
    )
  })

  it('omits auth header when no token', async () => {
    mockedAxios.get.mockResolvedValue({ data: 'content' })

    await fetchFileContent('XRPLF', 'rippled', 'file.cpp', 'sha')

    const headers = mockedAxios.get.mock.calls[0][1]?.headers as Record<
      string,
      string
    >
    expect(headers.Authorization).toBeUndefined()
  })

  it('throws on network error', async () => {
    mockedAxios.get.mockRejectedValue(new Error('Network Error'))

    await expect(
      fetchFileContent('XRPLF', 'rippled', 'file.cpp', 'sha')
    ).rejects.toThrow('Network Error')
  })
})
