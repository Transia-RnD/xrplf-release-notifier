import * as githubClient from '../../../src/github/client'
import {
  findPredecessorTag,
  findPreviousTag,
  findLastFinalTag,
} from '../../../src/version/predecessor'

jest.mock('../../../src/github/client')
const mockedClient = githubClient as jest.Mocked<typeof githubClient>

describe('findPredecessorTag', () => {
  beforeEach(() => jest.clearAllMocks())

  it('picks the closest semver predecessor for a beta target', async () => {
    mockedClient.listVersionTags.mockResolvedValue([
      '3.2.0-b4',
      '3.2.0-b5',
      '3.2.0-b6',
    ])
    await expect(
      findPredecessorTag('XRPLF', 'rippled', '3.2.0-b6')
    ).resolves.toBe('3.2.0-b5')
  })

  it('skips all prereleases for a FINAL target', async () => {
    mockedClient.listVersionTags.mockResolvedValue([
      '3.1.3',
      '3.2.0-b5',
      '3.2.0-b6',
      '3.2.0-rc1',
    ])
    await expect(findPredecessorTag('XRPLF', 'rippled', '3.2.0')).resolves.toBe(
      '3.1.3'
    )
  })

  it('returns null when no predecessor exists', async () => {
    mockedClient.listVersionTags.mockResolvedValue(['3.2.0-b6'])
    await expect(
      findPredecessorTag('XRPLF', 'rippled', '3.2.0-b6')
    ).resolves.toBeNull()
  })

  it('preserves the v-prefix carried on the repo tag', async () => {
    mockedClient.listVersionTags.mockResolvedValue(['v3.2.0-b5', 'v3.2.0-b6'])
    await expect(
      findPredecessorTag('XRPLF', 'rippled', '3.2.0-b6')
    ).resolves.toBe('v3.2.0-b5')
  })
})

describe('findPreviousTag', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns the immediately previous tag of any type for a beta', async () => {
    mockedClient.listVersionTags.mockResolvedValue([
      '3.1.3',
      '3.2.0-b6',
      '3.2.0-b7',
    ])
    await expect(findPreviousTag('XRPLF', 'rippled', '3.2.0-b7')).resolves.toBe(
      '3.2.0-b6'
    )
  })

  it('returns the last prerelease (not the last final) for a FINAL target', async () => {
    mockedClient.listVersionTags.mockResolvedValue([
      '3.1.3',
      '3.2.0-b7',
      '3.2.0-rc1',
    ])
    await expect(findPreviousTag('XRPLF', 'rippled', '3.2.0')).resolves.toBe(
      '3.2.0-rc1'
    )
  })

  it('returns null when nothing precedes it', async () => {
    mockedClient.listVersionTags.mockResolvedValue(['3.2.0-b1'])
    await expect(
      findPreviousTag('XRPLF', 'rippled', '3.2.0-b1')
    ).resolves.toBeNull()
  })
})

describe('findLastFinalTag', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns the last stable before a beta, ignoring same-cycle prereleases', async () => {
    mockedClient.listVersionTags.mockResolvedValue([
      '3.1.2',
      '3.1.3',
      '3.2.0-b1',
      '3.2.0-b6',
      '3.2.0-b7',
    ])
    await expect(
      findLastFinalTag('XRPLF', 'rippled', '3.2.0-b7')
    ).resolves.toBe('3.1.3')
  })

  it('returns the last stable before a FINAL target (not the target itself)', async () => {
    mockedClient.listVersionTags.mockResolvedValue([
      '3.1.3',
      '3.2.0',
      '3.2.0-rc1',
    ])
    await expect(findLastFinalTag('XRPLF', 'rippled', '3.2.0')).resolves.toBe(
      '3.1.3'
    )
  })

  it('returns null when no earlier final exists', async () => {
    mockedClient.listVersionTags.mockResolvedValue(['3.2.0-b1', '3.2.0-b2'])
    await expect(
      findLastFinalTag('XRPLF', 'rippled', '3.2.0-b2')
    ).resolves.toBeNull()
  })
})
