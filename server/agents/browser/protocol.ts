import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson } from '../../helpers/canonical-json.ts'

const Identity = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
const Action = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('navigate'), url: z.string().max(4_096), attestedUrls: z.array(z.string().max(4_096)).min(1).max(100) }),
  z.strictObject({ kind: z.literal('observe') }),
  z.strictObject({ kind: z.literal('act'), action: z.enum(['scrollIntoView', 'followLink']), ref: z.string().regex(/^e[1-9]\d{0,3}$/), documentEpoch: z.uuid(), attestedUrls: z.array(z.string().max(4_096)).min(1).max(100) }),
  z.strictObject({ kind: z.literal('extract') }),
  z.strictObject({ kind: z.literal('screenshot') }),
  z.strictObject({ kind: z.literal('close') })
])
const UnsignedEnvelope = z.strictObject({
  version: z.literal(1),
  keyId: z.string().min(1).max(64),
  issuedAt: z.iso.datetime(),
  nonce: Identity,
  runId: z.uuid(),
  ownerId: z.number().int().positive(),
  leaseToken: Identity,
  contextId: Identity,
  actionCallId: Identity,
  sequence: z.number().int().positive(),
  limits: z.strictObject({ contextTtlMilliseconds: z.number().int().min(1_000).max(30 * 60_000), maximumActions: z.number().int().min(1).max(200), maximumNavigations: z.number().int().min(1).max(50), maximumResponseBytes: z.number().int().min(1_024).max(100 * 1024 * 1024) }),
  action: Action
})
const SignedEnvelope = UnsignedEnvelope.extend({ signature: z.string().regex(/^[a-f0-9]{64}$/) })
export type BrowserProtocolEnvelope = z.infer<typeof SignedEnvelope>
export type BrowserProtocolUnsignedEnvelope = z.infer<typeof UnsignedEnvelope>

export class BrowserProtocolError extends Error {
  readonly status = 401
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'BrowserProtocolError'; this.code = code }
}

const signatureFor = (secret: Buffer, value: BrowserProtocolUnsignedEnvelope): string => createHmac('sha256', secret).update(canonicalJson(value)).digest('hex')
export const signBrowserEnvelope = (value: Omit<BrowserProtocolUnsignedEnvelope, 'version' | 'issuedAt' | 'nonce'>, secret: Buffer, now = new Date()): BrowserProtocolEnvelope => {
  const unsigned = UnsignedEnvelope.parse({ ...value, version: 1, issuedAt: now.toISOString(), nonce: randomBytes(24).toString('base64url') })
  return { ...unsigned, signature: signatureFor(secret, unsigned) }
}

export class BrowserEnvelopeVerifier {
  readonly #keys: ReadonlyMap<string, Buffer>
  readonly #seen = new Map<string, number>()
  readonly #maximumSkewMilliseconds: number
  readonly #now: () => number
  constructor(keys: ReadonlyMap<string, Buffer>, options: { maximumSkewMilliseconds?: number; now?: () => number } = {}) {
    this.#keys = keys
    this.#maximumSkewMilliseconds = options.maximumSkewMilliseconds ?? 30_000
    this.#now = options.now ?? Date.now
  }
  verify(value: unknown): BrowserProtocolEnvelope {
    const envelope = SignedEnvelope.parse(value)
    const now = this.#now()
    const issuedAt = Date.parse(envelope.issuedAt)
    if (Math.abs(now - issuedAt) > this.#maximumSkewMilliseconds) throw new BrowserProtocolError('BROWSER_ENVELOPE_EXPIRED', 'Browser request timestamp is outside the accepted window')
    const secret = this.#keys.get(envelope.keyId)
    if (!secret) throw new BrowserProtocolError('BROWSER_KEY_UNKNOWN', 'Browser request signing key is unknown')
    const { signature, ...unsigned } = envelope
    const expected = Buffer.from(signatureFor(secret, unsigned), 'hex')
    const supplied = Buffer.from(signature, 'hex')
    if (expected.byteLength !== supplied.byteLength || !timingSafeEqual(expected, supplied)) throw new BrowserProtocolError('BROWSER_SIGNATURE_INVALID', 'Browser request signature is invalid')
    for (const [nonce, expiresAt] of this.#seen) if (expiresAt <= now) this.#seen.delete(nonce)
    if (this.#seen.has(envelope.nonce)) throw new BrowserProtocolError('BROWSER_NONCE_REPLAYED', 'Browser request nonce has already been used')
    this.#seen.set(envelope.nonce, now + this.#maximumSkewMilliseconds)
    return envelope
  }
}
