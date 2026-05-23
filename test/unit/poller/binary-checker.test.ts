import fs from 'fs'
import path from 'path'
import type { PollerState } from '../../../src/poller/binary-checker'
import {
  parseVersionsFromHtml,
  detectNewVersions,
} from '../../../src/poller/binary-checker'

const DEB_REGEX =
  /href="rippled_(\d+\.\d+\.\d+(?:-[a-z0-9]+)?)-\d+_amd64\.deb"/g
const RPM_REGEX =
  /href="rippled-(\d+\.\d+\.\d+(?:-[a-z0-9]+)?)-\d+\.\w+\.x86_64\.rpm"/g

describe('parseVersionsFromHtml (deb)', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../../fixtures/repos-deb-listing.html'),
    'utf-8'
  )

  it('extracts all rippled versions from directory listing', () => {
    const versions = parseVersionsFromHtml(html, DEB_REGEX)
    expect(versions).toEqual(['2.2.0', '2.3.0', '3.0.0', '3.1.0', '3.1.3'])
  })

  it('ignores debug and dev packages', () => {
    const versions = parseVersionsFromHtml(html, DEB_REGEX)
    expect(versions).not.toContain('rippled-dbgsym')
    expect(versions).not.toContain('rippled-dev')
  })

  it('ignores non-rippled packages like clio', () => {
    const versions = parseVersionsFromHtml(html, DEB_REGEX)
    expect(versions.every((v) => /^\d+\.\d+\.\d+/.test(v))).toBe(true)
  })

  it('returns empty array for empty HTML', () => {
    const versions = parseVersionsFromHtml('', DEB_REGEX)
    expect(versions).toEqual([])
  })
})

describe('parseVersionsFromHtml (rpm)', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../../fixtures/repos-rpm-listing.html'),
    'utf-8'
  )

  it('extracts all rippled versions from RPM listing', () => {
    const versions = parseVersionsFromHtml(html, RPM_REGEX)
    expect(versions).toEqual(['2.2.0', '3.0.0', '3.1.3'])
  })

  it('ignores debuginfo and devel RPM packages', () => {
    const versions = parseVersionsFromHtml(html, RPM_REGEX)
    expect(versions).toHaveLength(3)
  })
})

describe('detectNewVersions', () => {
  const baseState: PollerState = {
    deb: { version: '3.1.0', detectedAt: '2025-03-15T09:00:00Z' },
    rpm: { version: '3.1.0', detectedAt: '2025-03-15T09:00:00Z' },
  }

  it('detects a new deb version', () => {
    const result = detectNewVersions({ deb: '3.1.3', rpm: '3.1.0' }, baseState)
    expect(result).toBe('3.1.3')
  })

  it('detects a new rpm version', () => {
    const result = detectNewVersions({ deb: '3.1.0', rpm: '3.1.3' }, baseState)
    expect(result).toBe('3.1.3')
  })

  it('returns null when nothing changed', () => {
    const result = detectNewVersions({ deb: '3.1.0', rpm: '3.1.0' }, baseState)
    expect(result).toBeNull()
  })

  it('handles empty initial state', () => {
    const emptyState: PollerState = { deb: null, rpm: null }
    const result = detectNewVersions({ deb: '3.1.3', rpm: null }, emptyState)
    expect(result).toBe('3.1.3')
  })

  it('prefers deb over rpm when both are new', () => {
    const emptyState: PollerState = { deb: null, rpm: null }
    const result = detectNewVersions({ deb: '3.1.3', rpm: '3.1.3' }, emptyState)
    expect(result).toBe('3.1.3')
  })

  it('returns null when both sources return null', () => {
    const state: PollerState = {
      deb: { version: '3.1.0', detectedAt: '2025-01-01T00:00:00Z' },
      rpm: { version: '3.1.0', detectedAt: '2025-01-01T00:00:00Z' },
    }
    const result = detectNewVersions({ deb: null, rpm: null }, state)
    expect(result).toBeNull()
  })
})
