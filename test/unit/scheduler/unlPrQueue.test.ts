import type { MattermostAttachment } from '../../../src/notifications/mattermost'
import {
  classify,
  daysBetween,
  buildCard,
  type ClassifiedPr,
} from '../../../src/scheduler/reports/unlPrQueue'

const LIST = 'data/unl-raw.yaml'

/** The card always carries exactly one attachment; fail loudly if that changes. */
function only(prs: ClassifiedPr[]): MattermostAttachment {
  const [attachment] = buildCard(prs).attachments ?? []
  if (!attachment) throw new Error('card had no attachment')
  return attachment
}

function pr(overrides: Partial<ClassifiedPr> = {}): ClassifiedPr {
  return {
    number: 1,
    title: 'Add example.com',
    url: 'https://github.com/XRPLF/unl/pull/1',
    author: 'someone',
    createdAt: '2026-06-01T00:00:00Z',
    kind: 'inclusion',
    ageDays: 10,
    ...overrides,
  }
}

describe('classify', () => {
  it('reads direction from the list-file line delta, not the title', () => {
    // Several merged PRs are titled "Add ..." while removing an entry, so the
    // title is not a usable signal.
    expect(classify([{ filename: LIST, additions: 2, deletions: 0 }])).toBe(
      'inclusion'
    )
    expect(classify([{ filename: LIST, additions: 0, deletions: 2 }])).toBe(
      'removal'
    )
  })

  it('treats a PR that does not touch the list as housekeeping', () => {
    expect(
      classify([{ filename: 'readme.md', additions: 4, deletions: 0 }])
    ).toBe('other')
  })

  it('treats an equal-line edit as not a membership change', () => {
    // e.g. renaming a validator, or reordering entries.
    expect(classify([{ filename: LIST, additions: 1, deletions: 1 }])).toBe(
      'other'
    )
  })
})

describe('daysBetween', () => {
  it('floors to whole days', () => {
    expect(
      daysBetween(
        new Date('2026-08-01T00:00:00Z'),
        new Date('2026-08-09T23:00:00Z')
      )
    ).toBe(8)
  })
})

describe('buildCard', () => {
  it('groups by kind and counts membership requests in the title', () => {
    const attachment = only([
      pr({ number: 11, kind: 'inclusion', ageDays: 20 }),
      pr({ number: 12, kind: 'removal', ageDays: 15 }),
      pr({ number: 16, kind: 'other', ageDays: 5 }),
    ])

    expect(attachment.title).toContain('2 membership request(s) open')
    expect(attachment.text).toContain('Requesting inclusion (1)')
    expect(attachment.text).toContain('Requesting removal (1)')
    expect(attachment.text).toContain('Not a membership change (1)')
  })

  it('escalates colour and title when a membership request goes stale', () => {
    const attachment = only([pr({ ageDays: 200 })])
    expect(attachment.color).toBe('#FF9800')
    expect(attachment.title).toContain('waiting over 60 days')
    expect(attachment.text).toContain('⚠️')
  })

  it('does not count a housekeeping PR as stale however old it is', () => {
    // A years-old docs PR is not the queue problem this report exists to surface.
    expect(only([pr({ kind: 'other', ageDays: 900 })]).color).toBe('#4CAF50')
  })

  it('says so plainly when the queue is empty', () => {
    expect(only([]).text).toBe('No open pull requests.')
  })
})
