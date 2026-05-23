import crypto from 'crypto'
import { verifySignature } from '../../../src/webhook/verify'

describe('verifySignature', () => {
  const secret = 'test-secret-key'
  const body = Buffer.from('{"action":"push"}')

  function makeSignature(payload: Buffer, key: string): string {
    return (
      'sha256=' + crypto.createHmac('sha256', key).update(payload).digest('hex')
    )
  }

  it('accepts a valid signature', () => {
    const sig = makeSignature(body, secret)
    expect(verifySignature(body, sig, secret)).toBe(true)
  })

  it('rejects an invalid signature', () => {
    const sig = makeSignature(body, 'wrong-key')
    expect(verifySignature(body, sig, secret)).toBe(false)
  })

  it('rejects a tampered body', () => {
    const sig = makeSignature(body, secret)
    const tampered = Buffer.from('{"action":"tampered"}')
    expect(verifySignature(tampered, sig, secret)).toBe(false)
  })

  it('rejects a malformed signature', () => {
    expect(verifySignature(body, 'sha256=invalid', secret)).toBe(false)
  })

  it('rejects an empty signature string', () => {
    expect(verifySignature(body, '', secret)).toBe(false)
  })

  it('rejects a signature without sha256= prefix', () => {
    const hash = crypto.createHmac('sha256', secret).update(body).digest('hex')
    expect(verifySignature(body, hash, secret)).toBe(false)
  })

  it('rejects a completely different length signature', () => {
    expect(verifySignature(body, 'sha256=ab', secret)).toBe(false)
  })
})
