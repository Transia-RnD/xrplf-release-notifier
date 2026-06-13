import axios from 'axios'
import { fetchCompare, compareCommits } from '../../../src/github/client'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const COMPARE_PAYLOAD = {
  data: {
    commits: [
      {
        sha: 'abc1234def',
        commit: { message: 'feat: thing\n\nbody', author: { name: 'alice' } },
      },
    ],
    files: [
      {
        filename: 'include/xrpl/protocol/Feature.h',
        status: 'modified',
        additions: 3,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
      {
        // binary / patch-less file — patch should come through undefined
        filename: 'docs/image.png',
        status: 'added',
        additions: 0,
        deletions: 0,
      },
    ],
  },
}

describe('fetchCompare', () => {
  beforeEach(() => jest.clearAllMocks())

  it('parses commits and files (with patches) from the compare endpoint', async () => {
    mockedAxios.get.mockResolvedValue(COMPARE_PAYLOAD)

    const result = await fetchCompare('XRPLF', 'rippled', 'base', 'head')

    if (result === null) throw new Error('expected a compare result')
    expect(result.commits).toEqual([
      { sha: 'abc1234def', message: 'feat: thing\n\nbody', author: 'alice' },
    ])
    expect(result.files).toHaveLength(2)
    expect(result.files[0]).toMatchObject({
      filename: 'include/xrpl/protocol/Feature.h',
      status: 'modified',
      additions: 3,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-old\n+new',
    })
    expect(result.files[1].patch).toBeUndefined()
  })

  it('defaults files to an empty array when the field is absent', async () => {
    mockedAxios.get.mockResolvedValue({ data: { commits: [] } })
    const result = await fetchCompare('XRPLF', 'rippled', 'base', 'head')
    if (result === null) throw new Error('expected a compare result')
    expect(result.files).toEqual([])
  })

  it('returns null on 404', async () => {
    mockedAxios.isAxiosError.mockReturnValue(true)
    mockedAxios.get.mockRejectedValue({ response: { status: 404 } })
    await expect(
      fetchCompare('XRPLF', 'rippled', 'base', 'head')
    ).resolves.toBeNull()
  })
})

describe('compareCommits (delegates to fetchCompare)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('still returns the flat commit list', async () => {
    mockedAxios.get.mockResolvedValue(COMPARE_PAYLOAD)
    await expect(
      compareCommits('XLF', 'rippled', 'base', 'head')
    ).resolves.toEqual([
      { sha: 'abc1234def', message: 'feat: thing\n\nbody', author: 'alice' },
    ])
  })

  it('returns null on 404', async () => {
    mockedAxios.isAxiosError.mockReturnValue(true)
    mockedAxios.get.mockRejectedValue({ response: { status: 404 } })
    await expect(
      compareCommits('XLF', 'rippled', 'base', 'head')
    ).resolves.toBeNull()
  })
})
