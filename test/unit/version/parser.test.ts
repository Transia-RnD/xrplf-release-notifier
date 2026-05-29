import { classifyVersion } from '../../../src/version/parser'
import { VersionType } from '../../../src/version/types'

describe('classifyVersion', () => {
  it('classifies beta versions', () => {
    const result = classifyVersion('3.2.0-b4')
    expect(result.type).toBe(VersionType.BETA)
    expect(result.major).toBe(3)
    expect(result.minor).toBe(2)
    expect(result.patch).toBe(0)
  })

  it('classifies RC versions', () => {
    const result = classifyVersion('3.1.0-rc1')
    expect(result.type).toBe(VersionType.RC)
    expect(result.major).toBe(3)
    expect(result.minor).toBe(1)
    expect(result.patch).toBe(0)
  })

  it('classifies final release versions', () => {
    const result = classifyVersion('3.1.0')
    expect(result.type).toBe(VersionType.FINAL)
    expect(result.major).toBe(3)
    expect(result.minor).toBe(1)
    expect(result.patch).toBe(0)
  })

  it('throws on unrecognized version format', () => {
    expect(() => classifyVersion('not-a-version')).toThrow(
      'Unrecognized version format'
    )
  })

  it('handles double-digit prerelease numbers', () => {
    const result = classifyVersion('4.0.0-rc12')
    expect(result.type).toBe(VersionType.RC)
  })
})
