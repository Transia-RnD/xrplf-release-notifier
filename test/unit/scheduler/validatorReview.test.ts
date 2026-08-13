import type { MattermostAttachment } from '../../../src/notifications/mattermost'
import {
  parseUnl,
  parseAgreement,
  buildReview,
  byAgreement,
  versionSpread,
  buildCard,
  REVIEW_THRESHOLD,
  type ReviewRow,
} from '../../../src/scheduler/reports/validatorReview'

function only(rows: ReviewRow[]): MattermostAttachment {
  const [attachment] = buildCard(rows).attachments ?? []
  if (!attachment) throw new Error('card had no attachment')
  return attachment
}

function row(over: Partial<ReviewRow> = {}): ReviewRow {
  return {
    key: 'nHKey',
    name: 'example.com',
    observed: true,
    agreement30d: { score: 1, missed: 0, total: 100, incomplete: false },
    version: '3.3.0',
    ...over,
  }
}

describe('parseUnl', () => {
  it('reads id/name pairs from the list file', () => {
    expect(
      parseUnl(
        'nodes:\n  - id: nHAAA\n    name: a.com\n  - id: nHBBB\n    name: b.com\n'
      )
    ).toEqual([
      { key: 'nHAAA', name: 'a.com' },
      { key: 'nHBBB', name: 'b.com' },
    ])
  })

  it('tolerates CRLF line endings', () => {
    expect(parseUnl('  - id: nHAAA\r\n    name: a.com\r\n')).toHaveLength(1)
  })
})

describe('parseAgreement', () => {
  it('converts the string score the API returns into a number', () => {
    expect(
      parseAgreement({
        missed: 701,
        total: 645588,
        score: '0.99891',
        incomplete: true,
      })
    ).toEqual({ score: 0.99891, missed: 701, total: 645588, incomplete: true })
  })

  it('returns undefined rather than NaN for missing or junk scores', () => {
    expect(parseAgreement(undefined)).toBeUndefined()
    expect(parseAgreement({})).toBeUndefined()
    expect(parseAgreement({ score: 'n/a' })).toBeUndefined()
  })
})

describe('buildReview', () => {
  it('joins membership against telemetry on the master key', () => {
    const rows = buildReview(
      [{ key: 'nHAAA', name: 'a.com' }],
      [
        {
          master_key: 'nHAAA',
          server_version: '3.3.0',
          partial: false,
          revoked: false,
          agreement_30day: { score: '0.99891', missed: 701, total: 645588 },
        },
      ]
    )
    expect(rows[0]).toMatchObject({ observed: true, version: '3.3.0' })
    expect(rows[0].agreement30d?.score).toBeCloseTo(0.99891)
  })

  it('keeps a dUNL member the data source cannot see, flagged unobserved', () => {
    // Silence from one observer is not evidence the validator is down; dropping
    // the row entirely would hide exactly the case worth investigating.
    const rows = buildReview([{ key: 'nHGONE', name: 'gone.com' }], [])
    expect(rows).toHaveLength(1)
    expect(rows[0].observed).toBe(false)
  })

  it('ignores validators that are not on the dUNL', () => {
    const rows = buildReview(
      [{ key: 'nHAAA', name: 'a.com' }],
      [{ master_key: 'nHOTHER' }, { master_key: 'nHAAA' }]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('a.com')
  })
})

describe('byAgreement', () => {
  it('sorts worst first and puts unobserved below any score', () => {
    const sorted = byAgreement([
      row({ name: 'good' }),
      row({ name: 'unseen', observed: false, agreement30d: undefined }),
      row({
        name: 'poor',
        agreement30d: { score: 0.9, missed: 10, total: 100, incomplete: false },
      }),
    ])
    expect(sorted.map((r) => r.name)).toEqual(['unseen', 'poor', 'good'])
  })
})

describe('versionSpread', () => {
  it('counts versions, most common first', () => {
    expect(
      versionSpread([
        row({ version: '3.3.0' }),
        row({ version: '3.2.1' }),
        row({ version: '3.3.0' }),
        row({ version: undefined }),
      ])
    ).toEqual([
      ['3.3.0', 2],
      ['3.2.1', 1],
    ])
  })
})

describe('buildCard', () => {
  it('flags a validator below the review threshold', () => {
    const attachment = only([
      row({
        name: 'laggard',
        agreement30d: {
          score: REVIEW_THRESHOLD - 0.01,
          missed: 500,
          total: 1000,
          incomplete: false,
        },
      }),
    ])
    expect(attachment.title).toContain('1 of 1 worth a look')
    expect(attachment.color).toBe('#FF9800')
    expect(attachment.text).toContain('laggard')
  })

  it('flags an unobserved or revoked validator regardless of score', () => {
    expect(
      only([row({ name: 'unseen', observed: false, agreement30d: undefined })])
        .text
    ).toContain('not visible to the data source')
    expect(only([row({ name: 'gone', revoked: true })]).text).toContain(
      'REVOKED'
    )
  })

  it('flags partial-only validators, which look healthy on score alone', () => {
    // Partial validations mean the node is publishing but not proposing — it
    // contributes nothing to quorum while appearing online.
    const attachment = only([row({ name: 'observer', partial: true })])
    expect(attachment.text).toContain('partial-only')
    expect(attachment.title).toContain('worth a look')
  })

  it('reports a clean week as healthy', () => {
    const attachment = only([row(), row({ name: 'b.com' })])
    expect(attachment.color).toBe('#4CAF50')
    expect(attachment.title).toContain('all 2 healthy')
  })

  it('always ships provenance and the scope caveat with the numbers', () => {
    const text = only([row()]).text ?? ''
    expect(text).toContain('single observer')
    expect(text).toContain('Engagement and education are not measured here')
  })
})
