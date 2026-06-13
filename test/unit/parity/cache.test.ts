import {
  getCachedLocations,
  isCacheWarm,
  setCachedLocations,
} from '../../../src/parity/cache'
import type { LocationsCache } from '../../../src/parity/cache'

describe('parity locations cache helpers', () => {
  const locations = {
    definitions: 'packages/ripple-binary-codec/src/enums/definitions.json',
    models: ['packages/xrpl/src/models/transactions'],
    registries: ['packages/xrpl/src/models/transactions/transaction.ts'],
  }

  it('returns null for an unknown repo', () => {
    expect(getCachedLocations({}, 'XRPLF/xrpl.js')).toBeNull()
  })

  it('round-trips locations and reports a warm cache only on matching sha', () => {
    const cache: LocationsCache = {}
    setCachedLocations(cache, 'XRPLF/xrpl.js', 'sha-1', locations)

    expect(getCachedLocations(cache, 'XRPLF/xrpl.js')).toEqual(locations)
    expect(isCacheWarm(cache, 'XRPLF/xrpl.js', 'sha-1')).toBe(true)
    // Different sha = the repo moved since we cached → not warm (re-resolve).
    expect(isCacheWarm(cache, 'XRPLF/xrpl.js', 'sha-2')).toBe(false)
    // Null sha (couldn't resolve) is never warm.
    expect(isCacheWarm(cache, 'XRPLF/xrpl.js', null)).toBe(false)
  })

  it('overwrites the entry on re-resolution', () => {
    const cache: LocationsCache = {}
    setCachedLocations(cache, 'XRPLF/xrpl.js', 'sha-1', locations)
    const moved = { ...locations, registries: ['new/path/registry.ts'] }
    setCachedLocations(cache, 'XRPLF/xrpl.js', 'sha-2', moved)

    expect(getCachedLocations(cache, 'XRPLF/xrpl.js')).toEqual(moved)
    expect(isCacheWarm(cache, 'XRPLF/xrpl.js', 'sha-2')).toBe(true)
  })
})
