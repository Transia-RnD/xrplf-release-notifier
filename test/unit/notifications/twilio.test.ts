import axios from 'axios'
import {
  explainErrorCode,
  fetchMessage,
  isTerminal,
  send,
  type TwilioConfig,
} from '../../../src/notifications/twilio'

jest.mock('axios')

const mocked = axios as jest.Mocked<typeof axios>

const CONFIG: TwilioConfig = {
  accountSid: 'AC' + '0'.repeat(32),
  keySid: 'SK' + '0'.repeat(32),
  keySecret: 'secret',
  from: '+33939200858',
}

const accepted = { data: { sid: 'SM1', status: 'queued' } }

/** The form body Twilio actually received, as a plain object. */
function posted(): Record<string, string> {
  const body = mocked.post.mock.calls[0][1] as URLSearchParams
  return Object.fromEntries(body)
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('send', () => {
  it('sends bare E.164 addresses on the sms channel', async () => {
    mocked.post.mockResolvedValueOnce(accepted)
    const result = await send(CONFIG, '+13213609426', 'hi')

    expect(result).toEqual({ ok: true, sid: 'SM1', status: 'queued' })
    expect(posted()).toEqual({
      To: '+13213609426',
      From: '+33939200858',
      Body: 'hi',
    })
  })

  it('prefixes both addresses on the whatsapp channel', async () => {
    mocked.post.mockResolvedValueOnce(accepted)
    await send({ ...CONFIG, channel: 'whatsapp' }, '+13213609426', 'hi')

    expect(posted()).toMatchObject({
      To: 'whatsapp:+13213609426',
      From: 'whatsapp:+33939200858',
    })
  })

  it('sends a template as ContentSid and drops Body', async () => {
    mocked.post.mockResolvedValueOnce(accepted)
    await send({ ...CONFIG, channel: 'whatsapp' }, '+13213609426', 'ignored', {
      contentSid: 'HX1',
      variables: { '1': 'CRITICAL', '2': 'FORK_DETECTED' },
    })

    const body = posted()
    expect(body.ContentSid).toBe('HX1')
    expect(JSON.parse(body.ContentVariables)).toEqual({
      '1': 'CRITICAL',
      '2': 'FORK_DETECTED',
    })
    expect(body.Body).toBeUndefined()
  })

  it('authenticates with the key pair, not the account sid', async () => {
    mocked.post.mockResolvedValueOnce(accepted)
    await send(CONFIG, '+13213609426', 'hi')

    expect(mocked.post.mock.calls[0][2]).toMatchObject({
      auth: { username: CONFIG.keySid, password: 'secret' },
    })
  })

  it('surfaces a Twilio error code instead of throwing', async () => {
    mocked.isAxiosError.mockReturnValueOnce(true)
    mocked.post.mockRejectedValueOnce({
      response: { status: 400, data: { code: 63016, message: 'no template' } },
    })

    await expect(send(CONFIG, '+13213609426', 'hi')).resolves.toEqual({
      ok: false,
      errorCode: 63016,
      error: 'no template',
    })
  })

  it('never throws when the network fails outright', async () => {
    mocked.isAxiosError.mockReturnValueOnce(false)
    mocked.post.mockRejectedValueOnce(new Error('ECONNRESET'))

    const result = await send(CONFIG, '+13213609426', 'hi')
    expect(result.ok).toBe(false)
  })

  it('rejects a response that is not a message resource', async () => {
    mocked.post.mockResolvedValueOnce({ data: { nonsense: true } })

    const result = await send(CONFIG, '+13213609426', 'hi')
    expect(result.ok).toBe(false)
  })
})

describe('fetchMessage', () => {
  it('returns the delivery state with its error code', async () => {
    mocked.get.mockResolvedValueOnce({
      data: {
        sid: 'SM1',
        status: 'undelivered',
        error_code: 63003,
        error_message: 'not a whatsapp user',
      },
    })

    await expect(fetchMessage(CONFIG, 'SM1')).resolves.toEqual({
      status: 'undelivered',
      errorCode: 63003,
      errorMessage: 'not a whatsapp user',
    })
  })

  it('returns null rather than throwing when the lookup fails', async () => {
    mocked.get.mockRejectedValueOnce(new Error('boom'))
    await expect(fetchMessage(CONFIG, 'SM1')).resolves.toBeNull()
  })
})

describe('isTerminal', () => {
  it('stops polling only on settled states', () => {
    expect(isTerminal('delivered')).toBe(true)
    expect(isTerminal('undelivered')).toBe(true)
    expect(isTerminal('queued')).toBe(false)
    expect(isTerminal('sent')).toBe(false)
  })
})

describe('explainErrorCode', () => {
  it('names the WhatsApp template and route failures', () => {
    expect(explainErrorCode(63016)).toMatch(/template/)
    expect(explainErrorCode(21612)).toMatch(/no carrier route/)
  })

  it('returns null for codes it has nothing to add about', () => {
    expect(explainErrorCode(null)).toBeNull()
    expect(explainErrorCode(99999)).toBeNull()
  })
})
