import fs from 'fs'
import path from 'path'
import {
  parseVersionFromContent,
  classifyVersion,
} from '../../../src/version/parser'
import { VersionType } from '../../../src/version/types'

const fixturesDir = path.join(__dirname, '../../fixtures')

describe('parseVersionFromContent', () => {
  it('extracts beta version from full BuildInfo.cpp content', () => {
    const content = fs.readFileSync(
      path.join(fixturesDir, 'buildinfo-beta.txt'),
      'utf-8'
    )
    expect(parseVersionFromContent(content)).toBe('3.2.0-b4')
  })

  it('extracts RC version', () => {
    const content = fs.readFileSync(
      path.join(fixturesDir, 'buildinfo-rc.txt'),
      'utf-8'
    )
    expect(parseVersionFromContent(content)).toBe('3.1.0-rc1')
  })

  it('extracts final release version', () => {
    const content = fs.readFileSync(
      path.join(fixturesDir, 'buildinfo-final.txt'),
      'utf-8'
    )
    expect(parseVersionFromContent(content)).toBe('3.1.0')
  })

  it('returns null for content without version string', () => {
    expect(parseVersionFromContent('no version here')).toBeNull()
  })

  it('handles inline version without NOLINTNEXTLINE', () => {
    const content = 'char const* const versionString = "2.0.0-b1";'
    expect(parseVersionFromContent(content)).toBe('2.0.0-b1')
  })
})

describe('classifyVersion', () => {
  it('classifies beta versions', () => {
    const result = classifyVersion('3.2.0-b4')
    expect(result.type).toBe(VersionType.BETA)
    expect(result.major).toBe(3)
    expect(result.minor).toBe(2)
    expect(result.patch).toBe(0)
    expect(result.prerelease).toBe('b4')
  })

  it('classifies RC versions', () => {
    const result = classifyVersion('3.1.0-rc1')
    expect(result.type).toBe(VersionType.RC)
    expect(result.major).toBe(3)
    expect(result.minor).toBe(1)
    expect(result.patch).toBe(0)
    expect(result.prerelease).toBe('rc1')
  })

  it('classifies final release versions', () => {
    const result = classifyVersion('3.1.0')
    expect(result.type).toBe(VersionType.FINAL)
    expect(result.major).toBe(3)
    expect(result.minor).toBe(1)
    expect(result.patch).toBe(0)
    expect(result.prerelease).toBeUndefined()
  })

  it('throws on unrecognized version format', () => {
    expect(() => classifyVersion('not-a-version')).toThrow(
      'Unrecognized version format'
    )
  })

  it('handles double-digit prerelease numbers', () => {
    const result = classifyVersion('4.0.0-rc12')
    expect(result.type).toBe(VersionType.RC)
    expect(result.prerelease).toBe('rc12')
  })
})
