import { readFileSync } from 'node:fs'
import {
  parseSchedules,
  loadSchedules,
  SCHEDULES_PATH,
} from '../../../src/scheduler/schema'
import { HANDLER_NAMES } from '../../../src/scheduler/handlers'

const HANDLERS = ['weekly', 'daily']

function yaml(body: string): string {
  return `jobs:\n${body}`
}

describe('parseSchedules', () => {
  it('applies defaults for tz and enabled', () => {
    const parsed = parseSchedules(
      yaml("  - name: weekly\n    cron: '0 9 * * MON'\n    handler: weekly\n"),
      HANDLERS
    )
    expect(parsed.jobs[0]).toMatchObject({ tz: 'UTC', enabled: true })
  })

  it('rejects an invalid cron expression', () => {
    expect(() =>
      parseSchedules(
        yaml("  - name: weekly\n    cron: 'not a cron'\n    handler: weekly\n"),
        HANDLERS
      )
    ).toThrow(/invalid cron/)
  })

  it('rejects an unknown timezone', () => {
    expect(() =>
      parseSchedules(
        yaml(
          "  - name: weekly\n    cron: '0 9 * * MON'\n    tz: Mars/Olympus\n    handler: weekly\n"
        ),
        HANDLERS
      )
    ).toThrow(/invalid cron/)
  })

  it('rejects a handler that does not exist', () => {
    // The failure mode this prevents: a typo'd handler becomes a job that is
    // "scheduled" forever and silently never runs.
    expect(() =>
      parseSchedules(
        yaml("  - name: weekly\n    cron: '0 9 * * MON'\n    handler: typo\n"),
        HANDLERS
      )
    ).toThrow(/unknown handler "typo"/)
  })

  it('rejects duplicate job names', () => {
    expect(() =>
      parseSchedules(
        yaml(
          "  - name: weekly\n    cron: '0 9 * * MON'\n    handler: weekly\n" +
            "  - name: weekly\n    cron: '0 10 * * TUE'\n    handler: daily\n"
        ),
        HANDLERS
      )
    ).toThrow(/duplicate job name/)
  })

  it('rejects a non-kebab-case name', () => {
    expect(() =>
      parseSchedules(
        yaml(
          "  - name: Weekly_Report\n    cron: '0 9 * * MON'\n    handler: weekly\n"
        ),
        HANDLERS
      )
    ).toThrow()
  })
})

describe('the shipped config/schedules.yaml', () => {
  it('validates against the real handler registry', () => {
    // Guards the deploy: this is exactly what start() runs at boot.
    expect(() =>
      parseSchedules(readFileSync(SCHEDULES_PATH, 'utf8'), HANDLER_NAMES)
    ).not.toThrow()
  })

  it('loads from disk', () => {
    expect(loadSchedules(HANDLER_NAMES).jobs.length).toBeGreaterThan(0)
  })
})
