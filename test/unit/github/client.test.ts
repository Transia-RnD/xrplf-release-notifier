import axios from 'axios'
import {
  getFileAtRef,
  listDir,
  searchCode,
  listPullRequests,
  fetchPrFiles,
  resolveRefSha,
} from '../../../src/github/client'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>
beforeEach(() => jest.clearAllMocks())

function notFound() {
  mockedAxios.isAxiosError.mockReturnValue(true)
  mockedAxios.get.mockRejectedValue({ response: { status: 404 } })
}

describe('getFileAtRef', () => {
  it('returns the raw file text', async () => {
    mockedAxios.get.mockResolvedValue({ data: 'file body' })
    await expect(
      getFileAtRef('XRPLF/xrpl.js', 'a/b.ts', 'main', 't')
    ).resolves.toBe('file body')
  })
  it('returns null on 404 (path moved/absent at ref)', async () => {
    notFound()
    await expect(getFileAtRef('r', 'p', 'main')).resolves.toBeNull()
  })
})

describe('listDir', () => {
  it('returns the entry array', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [{ name: 'a', path: 'd/a', type: 'file' }],
    })
    await expect(listDir('r', 'd', 'main')).resolves.toEqual([
      { name: 'a', path: 'd/a', type: 'file' },
    ])
  })
  it('wraps a single-file response in an array', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { name: 'a', path: 'a', type: 'file' },
    })
    const r = await listDir('r', 'a', 'main')
    expect(Array.isArray(r)).toBe(true)
    expect(r).toHaveLength(1)
  })
  it('returns null on 404', async () => {
    notFound()
    await expect(listDir('r', 'd', 'main')).resolves.toBeNull()
  })
})

describe('searchCode', () => {
  it('maps items to paths', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { items: [{ path: 'a.ts' }, { path: 'b.ts' }] },
    })
    await expect(searchCode('r', 'q')).resolves.toEqual([
      { path: 'a.ts' },
      { path: 'b.ts' },
    ])
  })
  it('swallows axios errors (rate limit/422) to an empty result', async () => {
    mockedAxios.isAxiosError.mockReturnValue(true)
    mockedAxios.get.mockRejectedValue({ response: { status: 403 } })
    await expect(searchCode('r', 'q')).resolves.toEqual([])
  })
})

describe('listPullRequests', () => {
  it('maps PR fields and defaults a null body to empty', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [
        {
          number: 1,
          title: 't',
          body: null,
          head: { ref: 'b' },
          html_url: 'u',
        },
      ],
    })
    await expect(listPullRequests('r')).resolves.toEqual([
      { number: 1, title: 't', body: '', branch: 'b', url: 'u' },
    ])
  })
})

describe('fetchPrFiles', () => {
  it('maps changed-file fields', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [{ filename: 'f', status: 'modified', patch: '@@' }],
    })
    await expect(fetchPrFiles('r', 1)).resolves.toEqual([
      { path: 'f', status: 'modified', patch: '@@' },
    ])
  })
})

describe('resolveRefSha', () => {
  it('returns the commit sha', async () => {
    mockedAxios.get.mockResolvedValue({ data: { sha: 'abc' } })
    await expect(resolveRefSha('r', 'main')).resolves.toBe('abc')
  })
  it('returns null on 404', async () => {
    notFound()
    await expect(resolveRefSha('r', 'main')).resolves.toBeNull()
  })
})

describe('non-404 errors propagate (not swallowed as "absent")', () => {
  it('getFileAtRef rethrows a 500', async () => {
    mockedAxios.isAxiosError.mockReturnValue(true)
    mockedAxios.get.mockRejectedValue({ response: { status: 500 } })
    await expect(getFileAtRef('r', 'p', 'main')).rejects.toBeDefined()
  })
  it('listDir rethrows a 500', async () => {
    mockedAxios.isAxiosError.mockReturnValue(true)
    mockedAxios.get.mockRejectedValue({ response: { status: 500 } })
    await expect(listDir('r', 'd', 'main')).rejects.toBeDefined()
  })
  it('resolveRefSha rethrows a 500', async () => {
    mockedAxios.isAxiosError.mockReturnValue(true)
    mockedAxios.get.mockRejectedValue({ response: { status: 500 } })
    await expect(resolveRefSha('r', 'main')).rejects.toBeDefined()
  })
  it('searchCode rethrows a non-axios error', async () => {
    mockedAxios.isAxiosError.mockReturnValue(false)
    mockedAxios.get.mockRejectedValue(new Error('boom'))
    await expect(searchCode('r', 'q')).rejects.toThrow('boom')
  })
})
