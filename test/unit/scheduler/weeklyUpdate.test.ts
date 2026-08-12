import type { MattermostAttachment } from '../../../src/notifications/mattermost'
import {
  isoDay,
  lastWeek,
  repoFromApiUrl,
  groupActivity,
  activityDigest,
  formatWindow,
  buildCard,
  type RepoActivity,
} from '../../../src/scheduler/reports/weeklyUpdate'

const WINDOW = lastWeek(new Date('2026-08-07T16:00:00Z'))

function only(
  draft: string | null,
  activity: RepoActivity[]
): MattermostAttachment {
  const [attachment] = buildCard(draft, activity, WINDOW).attachments ?? []
  if (!attachment) throw new Error('card had no attachment')
  return attachment
}

describe('window helpers', () => {
  it('spans the seven days ending at `until`', () => {
    expect(isoDay(WINDOW.since)).toBe('2026-07-31')
    expect(isoDay(WINDOW.until)).toBe('2026-08-07')
    expect(formatWindow(WINDOW)).toBe('2026-07-31 to 2026-08-07')
  })
})

describe('repoFromApiUrl', () => {
  it('reduces an API url to owner/repo', () => {
    expect(repoFromApiUrl('https://api.github.com/repos/XRPLF/rippled')).toBe(
      'XRPLF/rippled'
    )
  })
})

describe('groupActivity', () => {
  it('merges commits and PRs into one entry per repo', () => {
    const grouped = groupActivity(
      [
        {
          repository: { full_name: 'XRPLF/rippled' },
          commit: { message: 'fix: bound manifest cache' },
        },
      ],
      [
        {
          number: 7925,
          title: 'Bound untrusted manifest cache',
          html_url: 'https://github.com/XRPLF/rippled/pull/7925',
          repository_url: 'https://api.github.com/repos/XRPLF/rippled',
          pull_request: { merged_at: '2026-08-01T00:00:00Z' },
        },
      ]
    )

    expect(grouped).toHaveLength(1)
    expect(grouped[0].repo).toBe('XRPLF/rippled')
    expect(grouped[0].commits).toEqual(['fix: bound manifest cache'])
    expect(grouped[0].pullRequests[0].merged).toBe(true)
  })

  it('keeps only the commit subject, not the body', () => {
    // Commit bodies are long and bury the one line worth summarising.
    const grouped = groupActivity(
      [
        {
          repository: { full_name: 'XRPLF/unl' },
          commit: { message: 'feat: add scheduler\n\nLong body\nmore body' },
        },
      ],
      []
    )
    expect(grouped[0].commits).toEqual(['feat: add scheduler'])
  })

  it('marks an unmerged PR as not merged', () => {
    const grouped = groupActivity(
      [],
      [
        {
          number: 16,
          title: 'Add unl guide md',
          html_url: 'https://github.com/XRPLF/unl/pull/16',
          repository_url: 'https://api.github.com/repos/XRPLF/unl',
          pull_request: { merged_at: null },
        },
      ]
    )
    expect(grouped[0].pullRequests[0].merged).toBe(false)
  })

  it('orders the busiest repo first', () => {
    const grouped = groupActivity(
      [
        { repository: { full_name: 'a/quiet' }, commit: { message: 'one' } },
        { repository: { full_name: 'b/busy' }, commit: { message: 'one' } },
        { repository: { full_name: 'b/busy' }, commit: { message: 'two' } },
      ],
      []
    )
    expect(grouped.map((g) => g.repo)).toEqual(['b/busy', 'a/quiet'])
  })

  it('drops hits missing the fields it needs rather than emitting blanks', () => {
    expect(groupActivity([{ commit: { message: 'orphan' } }], [])).toEqual([])
    expect(groupActivity([], [{ title: 'no repo' }])).toEqual([])
  })
})

describe('activityDigest', () => {
  it('renders repo, commits and PR state for the model', () => {
    const digest = activityDigest([
      {
        repo: 'XRPLF/unl',
        commits: ['feat: add scheduler'],
        pullRequests: [
          { number: 16, title: 'Add unl guide md', url: '', merged: false },
        ],
      },
    ])
    expect(digest).toContain('XRPLF/unl')
    expect(digest).toContain('commit: feat: add scheduler')
    expect(digest).toContain('PR #16 (open): Add unl guide md')
  })
})

describe('buildCard', () => {
  const activity: RepoActivity[] = [
    {
      repo: 'XRPLF/rippled',
      commits: ['a', 'b'],
      pullRequests: [{ number: 1, title: 't', url: '', merged: true }],
    },
  ]

  it('carries the draft and the provenance counts', () => {
    const attachment = only('[partner] **Scheduler** — shipped it', activity)
    expect(attachment.text).toContain('[partner] **Scheduler** — shipped it')
    expect(attachment.text).toContain(
      '2 commit(s) and 1 PR(s) across 1 repo(s)'
    )
    expect(attachment.title).toContain('2026-07-31 to 2026-08-07')
  })

  it('always states that unpushed work is invisible', () => {
    // The report only sees pushed work, so a draft presented as a complete week
    // would mislead.
    expect(only('anything', activity).text).toContain('Pushed work only')
  })

  it('says so plainly when nothing was pushed', () => {
    const attachment = only(null, [])
    expect(attachment.color).toBe('#9E9E9E')
    expect(attachment.text).toContain('No pushed GitHub activity')
  })
})
