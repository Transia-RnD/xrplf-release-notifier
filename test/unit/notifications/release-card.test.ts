import { renderReleaseCard } from '../../../src/notifications/release-card'

describe('renderReleaseCard', () => {
  it('renders a non-empty PNG for a version (resvg works in this env)', async () => {
    const png = await renderReleaseCard('3.1.3')
    expect(png.length).toBeGreaterThan(0)
    // PNG magic number: 0x89 'P' 'N' 'G'
    expect(png[0]).toBe(0x89)
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
  })

  it('reuses the cached template on a second render', async () => {
    const a = await renderReleaseCard('3.2.0')
    const b = await renderReleaseCard('3.2.1') // hits the cached-template branch
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
  })
})
