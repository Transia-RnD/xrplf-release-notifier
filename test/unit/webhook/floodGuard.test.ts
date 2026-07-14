import {
  TagFloodGuard,
  formatTagFloodNotice,
} from '../../../src/webhook/floodGuard'

const REPO = 'XRPLF/xrpld-private'
const WINDOW = 10 * 60 * 1000

describe('TagFloodGuard', () => {
  it('allows events up to the limit', () => {
    const guard = new TagFloodGuard(WINDOW, 3)
    expect(guard.check(REPO, 1000).allowed).toBe(true)
    expect(guard.check(REPO, 2000).allowed).toBe(true)
    expect(guard.check(REPO, 3000).allowed).toBe(true)
  })

  it('suppresses beyond the limit and announces exactly once', () => {
    const guard = new TagFloodGuard(WINDOW, 3)
    guard.check(REPO, 1000)
    guard.check(REPO, 2000)
    guard.check(REPO, 3000)

    const fourth = guard.check(REPO, 4000)
    expect(fourth.allowed).toBe(false)
    expect(fourth.announceSuppression).toBe(true)

    const fifth = guard.check(REPO, 5000)
    expect(fifth.allowed).toBe(false)
    expect(fifth.announceSuppression).toBe(false)
  })

  it('stays suppressed while the flood continues past the window', () => {
    const guard = new TagFloodGuard(WINDOW, 3)
    // One event per second for well past the window — suppressed events
    // extend the window, so nothing gets through mid-flood.
    let allowedCount = 0
    for (let t = 0; t <= WINDOW * 2; t += 1000) {
      if (guard.check(REPO, t).allowed) allowedCount++
    }
    expect(allowedCount).toBe(3)
  })

  it('recovers after a full quiet window and can announce a new episode', () => {
    const guard = new TagFloodGuard(WINDOW, 3)
    for (let t = 1000; t <= 5000; t += 1000) {
      guard.check(REPO, t)
    }
    const afterQuiet = guard.check(REPO, 5000 + WINDOW + 1)
    expect(afterQuiet.allowed).toBe(true)

    // A fresh flood announces again.
    const base = 5000 + WINDOW + 1
    guard.check(REPO, base + 1)
    guard.check(REPO, base + 2)
    const suppressed = guard.check(REPO, base + 3)
    expect(suppressed.allowed).toBe(false)
    expect(suppressed.announceSuppression).toBe(true)
  })

  it('tracks repos independently', () => {
    const guard = new TagFloodGuard(WINDOW, 3)
    for (let t = 1000; t <= 4000; t += 1000) {
      guard.check(REPO, t)
    }
    expect(guard.check(REPO, 5000).allowed).toBe(false)
    expect(guard.check('XRPLF/rippled', 5000).allowed).toBe(true)
  })
})

describe('formatTagFloodNotice', () => {
  it('names the repo, count, and window', () => {
    const payload = formatTagFloodNotice(REPO, 12, WINDOW)
    expect(payload.text).toContain(REPO)
    expect(payload.text).toContain('12 tag events')
    expect(payload.text).toContain('10 minutes')
  })
})
