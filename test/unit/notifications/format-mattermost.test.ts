import { formatMattermost } from '../../../src/notifications/mattermost'
import type { VersionInfo } from '../../../src/version/types'
import { VersionType, NotificationSource } from '../../../src/version/types'

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

const SUMMARY = '**What changed:**\n• Test summary bullet.'

function mmText(payload: { attachments?: unknown[] }): string {
  return JSON.stringify(payload)
}

describe('formatMattermost (webhook)', () => {
  it('beta source bump uses test-tube emoji and beta color', () => {
    const payload = formatMattermost(
      makeVersion({
        raw: '3.2.0-b4',
        type: VersionType.BETA,
        branch: 'develop',
      }),
      NotificationSource.WEBHOOK,
      SUMMARY
    )
    const text = mmText(payload)
    expect(text).toContain(':test_tube:')
    expect(text).toContain('3.2.0-b4')
    expect(text).toContain('develop')
    expect(payload.attachments?.[0]?.color).toBe('#3F51B5')
  })

  it('RC source bump uses rocket emoji and RC color', () => {
    const payload = formatMattermost(
      makeVersion({
        raw: '3.1.0-rc1',
        type: VersionType.RC,
        branch: 'release-3.1',
      }),
      NotificationSource.WEBHOOK,
      SUMMARY
    )
    const text = mmText(payload)
    expect(text).toContain(':rocket:')
    expect(text).toContain('release candidate')
    expect(payload.attachments?.[0]?.color).toBe('#FF9800')
  })

  it('final source bump uses tada emoji and final color', () => {
    const payload = formatMattermost(
      makeVersion({
        raw: '3.1.0',
        type: VersionType.FINAL,
        branch: 'release-3.1',
      }),
      NotificationSource.WEBHOOK,
      SUMMARY
    )
    const text = mmText(payload)
    expect(text).toContain(':tada:')
    expect(text).toContain('finalized')
    expect(payload.attachments?.[0]?.color).toBe('#4CAF50')
  })
})

describe('formatMattermost (binary poll)', () => {
  it('includes install commands for the exact version', () => {
    const payload = formatMattermost(
      makeVersion({ raw: '3.1.3' }),
      NotificationSource.BINARY_POLL,
      SUMMARY
    )
    const text = mmText(payload)
    expect(text).toContain(':package:')
    expect(text).toContain('apt-get install rippled=3.1.3-1')
    expect(text).toContain('yum install rippled-3.1.3')
  })

  it('does not include commit URL', () => {
    const payload = formatMattermost(
      makeVersion({
        raw: '3.1.3',
        commitUrl: 'https://github.com/XRPLF/rippled/commit/abc123',
      }),
      NotificationSource.BINARY_POLL,
      SUMMARY
    )
    expect(mmText(payload)).not.toContain('github.com/XRPLF/rippled/commit')
  })
})

describe('formatMattermost (tag)', () => {
  it('uses label emoji and tag color', () => {
    const payload = formatMattermost(
      makeVersion({
        raw: '3.1.0',
        type: VersionType.FINAL,
        branch: 'tag:3.1.0',
      }),
      NotificationSource.TAG,
      SUMMARY
    )
    const text = mmText(payload)
    expect(text).toContain(':label:')
    expect(text).toContain('3.1.0')
    expect(payload.attachments?.[0]?.color).toBe('#2196F3')
  })
})

describe('formatMattermost (release)', () => {
  it('final-release published uses loudspeaker emoji', () => {
    const payload = formatMattermost(
      makeVersion({
        raw: '3.1.0',
        type: VersionType.FINAL,
        commitUrl: 'https://github.com/XRPLF/rippled/releases/tag/3.1.0',
      }),
      NotificationSource.RELEASE,
      SUMMARY
    )
    const text = mmText(payload)
    expect(text).toContain(':loudspeaker:')
    expect(text).toContain('published on GitHub')
  })

  it('pre-release uses different pretext', () => {
    const payload = formatMattermost(
      makeVersion({
        raw: '3.2.0-rc1',
        type: VersionType.RC,
      }),
      NotificationSource.RELEASE,
      SUMMARY
    )
    expect(mmText(payload)).toContain('pre-release')
  })
})

describe('formatMattermost summary appending', () => {
  it('appends the summary to attachment text when one already exists', () => {
    const payload = formatMattermost(
      makeVersion({ raw: '3.1.3', type: VersionType.FINAL }),
      NotificationSource.BINARY_POLL,
      '**Changes:**\n• A\n• B'
    )
    const text = payload.attachments?.[0]?.text ?? ''
    expect(text).toContain('apt-get install rippled=3.1.3-1')
    expect(text).toContain('**Changes:**')
    expect(text).toContain('• A')
  })

  it('appends the summary as the only body when no static text exists', () => {
    const payload = formatMattermost(
      makeVersion({
        raw: '3.2.0-b4',
        type: VersionType.BETA,
        branch: 'develop',
      }),
      NotificationSource.WEBHOOK,
      '**Changes:**\n• Only this bullet'
    )
    expect(payload.attachments?.[0]?.text).toBe(
      '**Changes:**\n• Only this bullet'
    )
  })
})

describe('formatMattermost attachment metadata', () => {
  it('all sources include footer and ts', () => {
    const version = makeVersion({ raw: '3.1.0', type: VersionType.FINAL })
    const sources = [
      NotificationSource.WEBHOOK,
      NotificationSource.BINARY_POLL,
      NotificationSource.TAG,
      NotificationSource.RELEASE,
    ]
    for (const src of sources) {
      const att = formatMattermost(version, src, SUMMARY).attachments?.[0]
      expect(att?.footer).toBe('xrplf-release-notifier')
      expect(typeof att?.ts).toBe('number')
    }
  })

  it('webhook attachment links the commit URL', () => {
    const payload = formatMattermost(
      makeVersion({
        raw: '3.1.0',
        type: VersionType.FINAL,
        commitUrl: 'https://github.com/XRPLF/rippled/commit/abc123',
      }),
      NotificationSource.WEBHOOK,
      SUMMARY
    )
    expect(payload.attachments?.[0]?.title_link).toBe(
      'https://github.com/XRPLF/rippled/commit/abc123'
    )
  })
})
