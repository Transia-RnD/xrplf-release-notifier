import * as githubClient from '../../../src/github/client'
import type { DiffFile } from '../../../src/github/client'
import { buildReference } from '../../../src/parity/reference'
import {
  detectBreakingChanges,
  summarizeBreakingForTag,
  type SurfaceDelta,
} from '../../../src/ai/breaking'

jest.mock('../../../src/github/client')
jest.mock('../../../src/parity/reference', () => ({
  buildReference: jest.fn(),
}))
jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn()
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({ messages: { create } })),
    __create: create,
  }
})

const mockedAnthropic = jest.requireMock<{ __create: jest.Mock }>(
  '@anthropic-ai/sdk'
)
const mockCreate = mockedAnthropic.__create
const mockedClient = githubClient as jest.Mocked<typeof githubClient>
const mockedBuildReference = buildReference as jest.Mock

function aiResponse(text: string) {
  return Promise.resolve({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  })
}

function file(partial: Partial<DiffFile> & { filename: string }): DiffFile {
  return { status: 'modified', additions: 1, deletions: 1, ...partial }
}

interface Verdict {
  classification: string
  statement: string
  confidence: string
}

/** stage-1 (system has "JSON array") → candidates; stage-2 → verdict. */
function wireModel(candidates: object[], verdict: Verdict) {
  mockCreate.mockImplementation((args: unknown) => {
    const { system } = args as { system: string }
    return aiResponse(
      system.includes('JSON array')
        ? JSON.stringify(candidates)
        : JSON.stringify(verdict)
    )
  })
}

const BASE_OPTS = {
  base: '3.2.0-b5',
  head: '3.2.0-b6',
  owner: 'XRPLF',
  repo: 'rippled',
  apiKey: 'k',
}
const EMPTY_SURFACE: SurfaceDelta = {
  added: [],
  addedAmendments: [],
  addedUnsupportedAmendments: [],
}
const COMMIT = { sha: 'abc1234def', message: 'fix: change', author: 'alice' }
const STPATHSET = file({
  filename: 'src/libxrpl/protocol/STPathSet.cpp',
  patch: 'Throw<std::runtime_error>',
})
const BREAKS: Verdict = {
  classification: 'BREAKING_NOW',
  statement:
    'STPathSet deserialization throws std::runtime_error on Currency+MPT path elements',
  confidence: 'high',
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedClient.getFileAtRef.mockResolvedValue('// no gate markers here')
})

describe('detectBreakingChanges', () => {
  it('classifies an ungated serialization change as breaking-on-upgrade', async () => {
    wireModel(
      [
        {
          title: 'STPathSet',
          file: STPATHSET.filename,
          sha: 'abc1234',
          category: 'protocol',
        },
      ],
      BREAKS
    )
    const result = await detectBreakingChanges({
      ...BASE_OPTS,
      commits: [COMMIT],
      files: [STPATHSET],
      surface: EMPTY_SURFACE,
    })
    expect(result.hasBreakingNow).toBe(true)
    expect(result.hasNewSurface).toBe(false)
    expect(result.breakingNow).toContain('std::runtime_error')
    expect(result.breakingNow).toContain('(abc1234)')
  })

  it('renders new protocol surface from the injected delta', async () => {
    wireModel([], BREAKS) // stage 1 finds no breaking candidates
    const result = await detectBreakingChanges({
      ...BASE_OPTS,
      commits: [COMMIT],
      files: [],
      surface: {
        added: [
          { name: 'MPTokenIssuanceCreate', kind: 'transactionType' },
          { name: 'MPTokenIssuance', kind: 'ledgerEntryType' },
          { name: 'TakerPaysMPT', kind: 'field' },
        ],
        addedAmendments: ['featureMPTokensV2'],
        addedUnsupportedAmendments: [],
      },
    })
    expect(result.hasBreakingNow).toBe(false)
    expect(result.hasNewSurface).toBe(true)
    expect(result.newSurface).toContain('Amendment `featureMPTokensV2`')
    expect(result.newSurface).toContain(
      'Transaction type `MPTokenIssuanceCreate`'
    )
    expect(result.newSurface).toContain('Ledger object `MPTokenIssuance`')
    expect(result.newSurface).toContain('TakerPaysMPT')
  })

  it('collapses many new fields to a count + sample', async () => {
    const fields = Array.from({ length: 9 }, (_, i) => ({
      name: `sfField${i}`,
      kind: 'field' as const,
    }))
    const result = await detectBreakingChanges({
      ...BASE_OPTS,
      commits: [{ sha: 'a', message: 'Merge pull request #1', author: 'x' }],
      files: [],
      surface: {
        added: fields,
        addedAmendments: [],
        addedUnsupportedAmendments: [],
      },
    })
    expect(result.newSurface).toContain('9 new fields')
    expect(mockCreate).not.toHaveBeenCalled() // trivial commits → no AI
  })

  it('computes surface even when every commit is trivial (no AI call)', async () => {
    const result = await detectBreakingChanges({
      ...BASE_OPTS,
      commits: [{ sha: 'a', message: 'bump version to 3.2.0-b6', author: 'x' }],
      files: [],
      surface: {
        added: [],
        addedAmendments: ['featureMPTokensV2'],
        addedUnsupportedAmendments: [],
      },
    })
    expect(result.hasNewSurface).toBe(true)
    expect(result.hasBreakingNow).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('flags an added-but-unvotable amendment (Supported::No) as a distinct alert', async () => {
    const result = await detectBreakingChanges({
      ...BASE_OPTS,
      commits: [{ sha: 'a', message: 'bump version to 3.2.0', author: 'x' }],
      files: [],
      surface: {
        added: [],
        addedAmendments: [],
        addedUnsupportedAmendments: ['MPTokensV2'],
      },
    })
    expect(result.hasUnvotableAmendment).toBe(true)
    expect(result.unvotableAmendments).toContain('`MPTokensV2`')
    expect(result.unvotableAmendments).toContain('Supported::No')
    // It is NOT a votable-surface item and NOT a breaking-on-upgrade item.
    expect(result.hasNewSurface).toBe(false)
    expect(result.hasBreakingNow).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('drops a hedged verdict', async () => {
    wireModel(
      [
        {
          title: 't',
          file: STPATHSET.filename,
          sha: 'abc1234',
          category: 'protocol',
        },
      ],
      {
        classification: 'BREAKING_NOW',
        statement: 'This may change acceptance',
        confidence: 'high',
      }
    )
    const result = await detectBreakingChanges({
      ...BASE_OPTS,
      commits: [COMMIT],
      files: [STPATHSET],
      surface: EMPTY_SURFACE,
    })
    expect(result.hasBreakingNow).toBe(false)
  })

  it('drops low-confidence verdicts', async () => {
    wireModel(
      [
        {
          title: 't',
          file: STPATHSET.filename,
          sha: 'abc1234',
          category: 'protocol',
        },
      ],
      { ...BREAKS, confidence: 'low' }
    )
    const result = await detectBreakingChanges({
      ...BASE_OPTS,
      commits: [COMMIT],
      files: [STPATHSET],
      surface: EMPTY_SURFACE,
    })
    expect(result.hasBreakingNow).toBe(false)
  })

  it('returns no breaking-now when stage 1 is unparseable', async () => {
    mockCreate.mockImplementation((args: unknown) => {
      const { system } = args as { system: string }
      return aiResponse(system.includes('JSON array') ? 'not json' : '{}')
    })
    const result = await detectBreakingChanges({
      ...BASE_OPTS,
      commits: [COMMIT],
      files: [STPATHSET],
      surface: EMPTY_SURFACE,
    })
    expect(result.hasBreakingNow).toBe(false)
  })
})

describe('summarizeBreakingForTag', () => {
  it('returns nothing when there is no predecessor and no surface', async () => {
    mockedClient.listVersionTags.mockResolvedValue(['3.2.0-b6'])
    mockedBuildReference.mockResolvedValue({ added: [], addedAmendments: [] })
    const result = await summarizeBreakingForTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.2.0-b6',
      apiKey: 'k',
    })
    expect(result.hasBreakingNow).toBe(false)
    expect(result.hasNewSurface).toBe(false)
    expect(mockedClient.fetchCompare).not.toHaveBeenCalled()
  })

  it('builds surface vs last stable and breaking-now vs previous tag', async () => {
    // findLastFinalTag + findPredecessorTag both read listVersionTags.
    mockedClient.listVersionTags.mockResolvedValue([
      '3.1.3',
      '3.2.0-b6',
      '3.2.0-b7',
    ])
    mockedBuildReference.mockResolvedValue({
      added: [{ name: 'TakerPaysMPT', kind: 'field' }],
      addedAmendments: [],
    })
    mockedClient.fetchCompare.mockResolvedValue({
      commits: [COMMIT],
      files: [STPATHSET],
    })
    wireModel(
      [
        {
          title: 'STPathSet',
          file: STPATHSET.filename,
          sha: 'aaa1111',
          category: 'protocol',
        },
      ],
      BREAKS
    )

    const result = await summarizeBreakingForTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.2.0-b7',
      apiKey: 'k',
    })

    // surface base = last stable (3.1.3), not the previous beta
    expect(mockedBuildReference).toHaveBeenCalledWith(
      expect.objectContaining({ tag: '3.2.0-b7', predecessorTag: '3.1.3' })
    )
    // breaking-on-upgrade base = previous tag (3.2.0-b6)
    expect(mockedClient.fetchCompare).toHaveBeenCalledWith(
      'XRPLF',
      'rippled',
      '3.2.0-b6',
      '3.2.0-b7',
      undefined
    )
    expect(result.hasBreakingNow).toBe(true)
    expect(result.breakingNow).toContain('STPathSet')
    expect(result.hasNewSurface).toBe(true)
    expect(result.newSurface).toContain('TakerPaysMPT')
  })

  it('still shows surface when buildReference succeeds but there is no diff', async () => {
    mockedClient.listVersionTags.mockResolvedValue(['3.1.3', '3.2.0-b7'])
    mockedBuildReference.mockResolvedValue({
      added: [],
      addedAmendments: ['featureMPTokensV2'],
    })
    mockedClient.fetchCompare.mockResolvedValue({ commits: [], files: [] })

    const result = await summarizeBreakingForTag({
      owner: 'XRPLF',
      repo: 'rippled',
      tag: '3.2.0-b7',
      apiKey: 'k',
    })
    expect(result.hasNewSurface).toBe(true)
    expect(result.newSurface).toContain('featureMPTokensV2')
    expect(result.hasBreakingNow).toBe(false)
  })
})
