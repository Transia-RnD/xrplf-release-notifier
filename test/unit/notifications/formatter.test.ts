import { formatMessages } from '../../../src/notifications/formatter'
import {
  VersionInfo,
  VersionType,
  NotificationSource,
} from '../../../src/version/types'

function makeVersion(overrides: Partial<VersionInfo> = {}): VersionInfo {
  return {
    raw: '3.1.0',
    major: 3,
    minor: 1,
    patch: 0,
    type: VersionType.FINAL,
    branch: 'release-3.1',
    commitSha: 'abc123',
    commitUrl: 'https://github.com/XRPLF/rippled/commit/abc123',
    ...overrides,
  }
}

function mmText(msgs: { mattermost: { attachments?: Array<unknown> } }): string {
  return JSON.stringify(msgs.mattermost)
}

describe('formatMessages (webhook)', () => {
  it('formats beta version messages', () => {
    const version = makeVersion({
      raw: '3.2.0-b4',
      type: VersionType.BETA,
      prerelease: 'b4',
      branch: 'develop',
    })
    const msgs = formatMessages(version)
    const mm = mmText(msgs)
    expect(mm).toContain(':test_tube:')
    expect(mm).toContain('3.2.0-b4')
    expect(mm).toContain('develop')
    expect(msgs.mattermost.attachments?.[0]?.color).toBe('#3F51B5')
    expect(msgs.twitter).toContain('3.2.0-b4')
    expect(msgs.twitter).toContain('(beta)')
    expect(msgs.twitter).toContain('#XRPLedger')
  })

  it('formats RC version messages', () => {
    const version = makeVersion({
      raw: '3.1.0-rc1',
      type: VersionType.RC,
      prerelease: 'rc1',
      branch: 'release-3.1',
    })
    const msgs = formatMessages(version)
    const mm = mmText(msgs)
    expect(mm).toContain(':rocket:')
    expect(mm).toContain('release candidate')
    expect(msgs.mattermost.attachments?.[0]?.color).toBe('#FF9800')
    expect(msgs.twitter).toContain('release candidate')
    expect(msgs.twitter).toContain('begin testing')
  })

  it('formats final release messages', () => {
    const version = makeVersion({
      raw: '3.1.0',
      type: VersionType.FINAL,
      branch: 'release-3.1',
    })
    const msgs = formatMessages(version)
    const mm = mmText(msgs)
    expect(mm).toContain(':tada:')
    expect(mm).toContain('officially released')
    expect(mm).toContain('upgrade')
    expect(msgs.mattermost.attachments?.[0]?.color).toBe('#4CAF50')
    expect(msgs.twitter).toContain('officially released')
  })

  it('keeps twitter messages under 280 characters', () => {
    const versions = [
      makeVersion({
        raw: '3.2.0-b4',
        type: VersionType.BETA,
        branch: 'develop',
      }),
      makeVersion({
        raw: '3.1.0-rc1',
        type: VersionType.RC,
        branch: 'release-3.1',
      }),
      makeVersion({ raw: '3.1.0', type: VersionType.FINAL }),
    ]
    for (const v of versions) {
      const msgs = formatMessages(v)
      expect(msgs.twitter.length).toBeLessThanOrEqual(280)
    }
  })
})

describe('formatMessages (binary poll)', () => {
  it('formats binary availability messages', () => {
    const version = makeVersion({ raw: '3.1.3' })
    const msgs = formatMessages(version, NotificationSource.BINARY_POLL)
    const mm = mmText(msgs)
    expect(mm).toContain(':package:')
    expect(mm).toContain('binary packages')
    expect(mm).toContain('apt-get install')
    expect(mm).toContain('yum install')
    expect(msgs.twitter).toContain('binary packages')
    expect(msgs.twitter).toContain('repos.ripple.com')
    expect(msgs.twitter.length).toBeLessThanOrEqual(280)
  })

  it('includes the exact version in install commands', () => {
    const version = makeVersion({ raw: '3.1.3' })
    const msgs = formatMessages(version, NotificationSource.BINARY_POLL)
    const mm = mmText(msgs)
    expect(mm).toContain('rippled=3.1.3-1')
    expect(mm).toContain('rippled-3.1.3')
  })
})

describe('formatMessages (tag)', () => {
  it('formats tag notifications', () => {
    const version = makeVersion({
      raw: '3.1.0',
      type: VersionType.FINAL,
      branch: 'tag:3.1.0',
      commitUrl: 'https://github.com/XRPLF/rippled/commit/abc123',
    })
    const msgs = formatMessages(version, NotificationSource.TAG)
    const mm = mmText(msgs)
    expect(mm).toContain(':label:')
    expect(mm).toContain('3.1.0')
    expect(mm).toContain('tag')
    expect(msgs.mattermost.attachments?.[0]?.color).toBe('#2196F3')
    expect(msgs.twitter).toContain('3.1.0')
    expect(msgs.twitter).toContain('tagged')
    expect(msgs.twitter.length).toBeLessThanOrEqual(280)
  })
})

describe('formatMessages (release)', () => {
  it('formats published final-release messages', () => {
    const version = makeVersion({
      raw: '3.1.0',
      type: VersionType.FINAL,
      branch: 'release:3.1.0',
      commitUrl: 'https://github.com/XRPLF/rippled/releases/tag/3.1.0',
    })
    const msgs = formatMessages(version, NotificationSource.RELEASE)
    const mm = mmText(msgs)
    expect(mm).toContain(':loudspeaker:')
    expect(mm).toContain('published on GitHub')
    expect(mm).toContain('upgrade')
    expect(msgs.twitter).toContain('published on GitHub')
    expect(msgs.twitter.length).toBeLessThanOrEqual(280)
  })

  it('formats pre-release messages differently', () => {
    const version = makeVersion({
      raw: '3.2.0-rc1',
      type: VersionType.RC,
      branch: 'release:3.2.0-rc1',
    })
    const msgs = formatMessages(version, NotificationSource.RELEASE)
    const mm = mmText(msgs)
    expect(mm).toContain('pre-release')
    expect(msgs.twitter).toContain('pre-release')
    expect(msgs.twitter.length).toBeLessThanOrEqual(280)
  })
})

describe('formatMessages attachment metadata', () => {
  it('all attachments include footer and ts', () => {
    const version = makeVersion({ raw: '3.1.0', type: VersionType.FINAL })
    const sources = [
      NotificationSource.WEBHOOK,
      NotificationSource.BINARY_POLL,
      NotificationSource.TAG,
      NotificationSource.RELEASE,
    ]
    for (const src of sources) {
      const msgs = formatMessages(version, src)
      const att = msgs.mattermost.attachments?.[0]
      expect(att?.footer).toBe('xrplf-release-notifier')
      expect(typeof att?.ts).toBe('number')
    }
  })

  it('includes commit URL as title_link for webhook messages', () => {
    const version = makeVersion({
      raw: '3.1.0',
      type: VersionType.FINAL,
      commitUrl: 'https://github.com/XRPLF/rippled/commit/abc123',
    })
    const msgs = formatMessages(version)
    expect(msgs.mattermost.attachments?.[0]?.title_link).toBe(
      'https://github.com/XRPLF/rippled/commit/abc123'
    )
  })

  it('does not include commit URL in binary poll messages', () => {
    const version = makeVersion({
      raw: '3.1.3',
      commitUrl: 'https://github.com/XRPLF/rippled/commit/abc123',
    })
    const msgs = formatMessages(version, NotificationSource.BINARY_POLL)
    expect(mmText(msgs)).not.toContain('github.com/XRPLF/rippled/commit')
  })
})
