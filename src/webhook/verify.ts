import crypto from 'crypto'

export function verifySignature(
  body: Buffer,
  signature: string,
  secret: string
): boolean {
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  if (signature.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
