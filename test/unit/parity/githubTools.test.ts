import { executeTool } from '../../../src/parity/githubTools'
import * as client from '../../../src/github/client'

const ctx = { repo: 'XRPLF/x', ref: 'main', token: 't' }
afterEach(() => jest.restoreAllMocks())

describe('executeTool', () => {
  it('listDir formats entries, marking directories', async () => {
    jest.spyOn(client, 'listDir').mockResolvedValue([
      { name: 'a.ts', path: 'src/a.ts', type: 'file' },
      { name: 'sub', path: 'src/sub', type: 'dir' },
    ])
    const out = await executeTool('listDir', { path: 'src' }, ctx)
    expect(out).toContain('src/a.ts')
    expect(out).toContain('[dir] src/sub')
  })

  it('listDir reports Not found on a 404 (null)', async () => {
    jest.spyOn(client, 'listDir').mockResolvedValue(null)
    expect(await executeTool('listDir', { path: 'x' }, ctx)).toMatch(
      /Not found/
    )
  })

  it('readFile returns file content', async () => {
    jest.spyOn(client, 'getFileAtRef').mockResolvedValue('hello')
    expect(await executeTool('readFile', { path: 'f' }, ctx)).toBe('hello')
  })

  it('readFile truncates very large files and says so', async () => {
    jest.spyOn(client, 'getFileAtRef').mockResolvedValue('x'.repeat(40_000))
    const out = await executeTool('readFile', { path: 'f' }, ctx)
    expect(out).toMatch(/truncated/)
    expect(out.length).toBeLessThan(40_000)
  })

  it('grepFile returns matching lines with line numbers', async () => {
    jest
      .spyOn(client, 'getFileAtRef')
      .mockResolvedValue('alpha\nMPTokenIssuanceCreate\nbeta')
    const out = await executeTool(
      'grepFile',
      { path: 'f', query: 'MPTokenIssuanceCreate' },
      ctx
    )
    expect(out).toContain('2: MPTokenIssuanceCreate')
  })

  it('grepFile reports no match', async () => {
    jest.spyOn(client, 'getFileAtRef').mockResolvedValue('alpha\nbeta')
    expect(
      await executeTool('grepFile', { path: 'f', query: 'zzz' }, ctx)
    ).toMatch(/No match/)
  })

  it('searchCode joins matched paths', async () => {
    jest
      .spyOn(client, 'searchCode')
      .mockResolvedValue([{ path: 'a.ts' }, { path: 'b.ts' }])
    expect(await executeTool('searchCode', { query: 'q' }, ctx)).toBe(
      'a.ts\nb.ts'
    )
  })

  it('listPRs formats open PRs', async () => {
    jest
      .spyOn(client, 'listPullRequests')
      .mockResolvedValue([
        { number: 7, title: 'feat: x', body: '', branch: 'b', url: 'u' },
      ])
    expect(await executeTool('listPRs', {}, ctx)).toContain('#7 [b] feat: x')
  })

  it('prFiles formats changed files with patch', async () => {
    jest
      .spyOn(client, 'fetchPrFiles')
      .mockResolvedValue([{ path: 'f', status: 'modified', patch: '@@ hunk' }])
    const out = await executeTool('prFiles', { number: 7 }, ctx)
    expect(out).toContain('modified f')
    expect(out).toContain('@@ hunk')
  })

  it('returns a clear message for an unknown tool', async () => {
    expect(await executeTool('nope', {}, ctx)).toMatch(/Unknown tool/)
  })
})
