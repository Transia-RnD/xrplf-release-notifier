import crypto from 'crypto'

/**
 * Envelope encryption for subscriber phone numbers. The ciphertext lives in
 * GCS; the keys live in Secret Manager, so reading a number requires both.
 *
 * `v` selects the key from the ring, which is what makes rotation possible:
 * a new key is added as the highest version and becomes the write key, while
 * older versions stay readable until every record has been rewritten.
 */

export interface Sealed {
  v: number
  iv: string
  tag: string
  ct: string
}

export interface CryptoKeys {
  /** version → 32-byte key. The highest version is the write key. */
  ring: Map<number, Buffer>
  /** HMAC key for the blind index; rotating it invalidates every index. */
  indexPepper: Buffer
}

const KEY_BYTES = 32
const IV_BYTES = 12

/**
 * Parse `SMS_ENC_KEYS` — a JSON object of `{"1": "<base64>", "2": "<base64>"}`.
 * A bare base64 string is accepted as version 1 so a first deploy needs no JSON.
 */
export function parseKeyRing(raw: string): Map<number, Buffer> {
  const ring = new Map<number, Buffer>()
  const add = (version: number, b64: string): void => {
    const key = Buffer.from(b64, 'base64')
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `SMS_ENC_KEYS v${version} must be ${KEY_BYTES} bytes, got ${key.length}`
      )
    }
    ring.set(version, key)
  }

  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) {
    add(1, trimmed)
    return ring
  }
  const parsed: unknown = JSON.parse(trimmed)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('SMS_ENC_KEYS must be a JSON object or a base64 key')
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const version = Number(k)
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`SMS_ENC_KEYS has a non-integer version: ${k}`)
    }
    if (typeof v !== 'string') {
      throw new Error(`SMS_ENC_KEYS v${k} must be a base64 string`)
    }
    add(version, v)
  }
  if (ring.size === 0) throw new Error('SMS_ENC_KEYS is empty')
  return ring
}

export function writeVersion(ring: Map<number, Buffer>): number {
  return Math.max(...ring.keys())
}

export function seal(plaintext: string, keys: CryptoKeys): Sealed {
  const v = writeVersion(keys.ring)
  const key = keys.ring.get(v)
  if (!key) throw new Error(`no key for version ${v}`)
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
}

export function open(sealed: Sealed, keys: CryptoKeys): string {
  const key = keys.ring.get(sealed.v)
  if (!key) {
    throw new Error(
      `SMS_ENC_KEYS has no key for version ${sealed.v} — a key was removed before its records were rewritten`
    )
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(sealed.iv, 'base64')
  )
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * Deterministic lookup handle for an E.164 number. Lets inbound STOP and
 * duplicate-enrollment checks find a record without decrypting anything.
 */
export function blindIndex(e164: string, keys: CryptoKeys): string {
  return crypto
    .createHmac('sha256', keys.indexPepper)
    .update(e164)
    .digest('hex')
}

/** Generate a fresh key ring entry — used by the roster CLI, never at runtime. */
export function generateKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString('base64')
}
