import type { MattermostAttachment } from '../../../src/notifications/mattermost'
import {
  evaluateToml,
  tally,
  buildCard,
  type TomlResult,
} from '../../../src/scheduler/reports/validatorToml'

const ENTRY = { key: 'nHBWa56Vr7', name: 'xrp.vet' }

const FULL = `
[[VALIDATORS]]
public_key = "nHBWa56Vr7"
server_country = "DE"
server_location = "Bavaria, DE"
server_cloud = "false"
network_asn = "24940"
attestation = "5FE6C392BB93"

[[VALIDATOR_SPEC]]
CPU = "Intel 24c/32t"
MEMORY = "128GB DDR4"
`

function only(results: TomlResult[]): MattermostAttachment {
  const [attachment] = buildCard(results).attachments ?? []
  if (!attachment) throw new Error('card had no attachment')
  return attachment
}

function result(over: Partial<TomlResult> = {}): TomlResult {
  return {
    name: 'a.com',
    key: 'nHA',
    listed: true,
    missingRequired: [],
    missingRecommended: [],
    attested: true,
    ...over,
  }
}

describe('evaluateToml', () => {
  it('reads XLS-50 fields and the hardware block from a complete TOML', () => {
    const r = evaluateToml(ENTRY, FULL)
    expect(r).toMatchObject({
      listed: true,
      attested: true,
      asn: '24940',
      country: 'DE',
      cpu: 'Intel 24c/32t',
      memory: '128GB DDR4',
    })
    expect(r.missingRequired).toEqual([])
    expect(r.missingRecommended).toEqual([])
    expect(r.failure).toBeUndefined()
  })

  it('reports network_asn as missing when absent', () => {
    const r = evaluateToml(
      ENTRY,
      '[[VALIDATORS]]\npublic_key = "nHBWa56Vr7"\nserver_country = "DE"\n'
    )
    expect(r.listed).toBe(true)
    expect(r.missingRequired).toEqual(['network_asn'])
    expect(r.missingRecommended).toEqual(['server_location', 'server_cloud'])
  })

  it('distinguishes a key not listed from a missing VALIDATORS block', () => {
    // Both mean "unverified", but one is a wrong TOML and the other is no TOML.
    expect(
      evaluateToml(ENTRY, '[[VALIDATORS]]\npublic_key = "nHSOMEONEELSE"\n')
        .failure
    ).toBe('key-not-listed')
    expect(evaluateToml(ENTRY, '[[SERVERS]]\ndomain = "x"\n').failure).toBe(
      'no-validators-block'
    )
  })

  it('reports unparseable TOML rather than throwing', () => {
    expect(evaluateToml(ENTRY, '[[VALIDATORS\nbroken = ').failure).toBe(
      'unparseable'
    )
  })

  it('passes through a fetch failure', () => {
    expect(evaluateToml(ENTRY, null, 'unreachable').failure).toBe('unreachable')
    expect(evaluateToml(ENTRY, null).failure).toBe('not-found')
  })

  it('accepts a non-string ASN, which operators write both ways', () => {
    // network_asn = 24940 (bare int) is valid TOML and common in the wild.
    const r = evaluateToml(
      ENTRY,
      '[[VALIDATORS]]\npublic_key = "nHBWa56Vr7"\nnetwork_asn = 24940\n'
    )
    expect(r.asn).toBe('24940')
    expect(r.missingRequired).toEqual([])
  })

  it('treats a blank field as missing', () => {
    const r = evaluateToml(
      ENTRY,
      '[[VALIDATORS]]\npublic_key = "nHBWa56Vr7"\nnetwork_asn = "  "\n'
    )
    expect(r.missingRequired).toEqual(['network_asn'])
  })
})

describe('tally', () => {
  it('counts values, most common first, ignoring undefined', () => {
    expect(tally(['A', 'B', 'A', undefined])).toEqual([
      ['A', 2],
      ['B', 1],
    ])
  })
})

describe('buildCard', () => {
  it('counts compliance against the whole dUNL, not just responders', () => {
    // 1 of 3 compliant — a report that said "1 of 1" would flatter the list.
    const attachment = only([
      result({ name: 'good.com' }),
      result({ name: 'gone.com', listed: false, failure: 'not-found' }),
      result({ name: 'partial.com', missingRequired: ['network_asn'] }),
    ])
    expect(attachment.title).toContain('1/3 compliant')
    expect(attachment.title).toContain('1 publish nothing usable')
    expect(attachment.text).toContain('gone.com')
    expect(attachment.text).toContain('Missing `network_asn` (1)')
  })

  it('reports ASN and country concentration', () => {
    const attachment = only([
      result({ asn: '24940', country: 'DE' }),
      result({ name: 'b.com', asn: '24940', country: 'US' }),
    ])
    expect(attachment.text).toContain('`24940` ×2')
    expect(attachment.text).toContain('DE ×1')
  })

  it('folds country case before tallying', () => {
    // Both spellings occur on the live dUNL; counting them apart would report
    // "us ×2, US ×1" and understate the concentration being measured.
    const attachment = only([
      result({ asn: '1', country: 'us' }),
      result({ name: 'b.com', asn: '2', country: 'US' }),
      result({ name: 'c.com', asn: '3', country: 'Us' }),
    ])
    expect(attachment.text).toContain('US ×3')
    expect(attachment.text).not.toContain('us ×')
  })

  it('surfaces declared hardware, which is otherwise polled by hand', () => {
    const attachment = only([
      result({ memory: '128GB DDR4', cpu: 'i7 24c' }),
      result({ name: 'b.com' }),
    ])
    expect(attachment.text).toContain('Declared hardware (1/2)')
    expect(attachment.text).toContain('128GB DDR4')
  })

  it('says so plainly when nobody declares hardware', () => {
    expect(only([result()]).text).toContain(
      '**Declared hardware** — none published.'
    )
  })

  it('is green only when nothing is missing anywhere', () => {
    expect(only([result({ asn: '1', country: 'DE' })]).color).toBe('#4CAF50')
    expect(only([result({ missingRequired: ['network_asn'] })]).color).toBe(
      '#FF9800'
    )
  })

  it('states that a missing field is a disclosure gap, not a fault', () => {
    expect(only([result()]).text).toContain('not what they run')
  })
})
