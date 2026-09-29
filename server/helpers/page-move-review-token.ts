import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const MAX_TOKEN_TTL_MS = 5 * 60_000
const MAX_CURSOR_LENGTH = 4096

const MoveTargetSchema = z.strictObject({ locale: z.string().min(2).max(35), path: z.string().min(1).max(1024) })
const MoveSourceSchema = z.strictObject({
  id: z.number().int().positive().safe(),
  sourceRevision: z.string().regex(/^[1-9][0-9]*$/u),
  beforeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  afterDigest: z.string().regex(/^[a-f0-9]{64}$/u)
})
export const PageMoveReviewTokenPayloadSchema = z.strictObject({
  version: z.literal(1),
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().positive().safe(),
  requesterId: z.number().int().positive().safe(),
  sessionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  targetId: z.number().int().positive().safe(),
  expectedSourceRevision: z.string().regex(/^[1-9][0-9]*$/u),
  oldTarget: MoveTargetSchema,
  newTarget: MoveTargetSchema,
  targetBeforeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  targetAfterDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  selected: z.array(MoveSourceSchema).max(20),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/u)
})
export type PageMoveReviewTokenPayload = z.infer<typeof PageMoveReviewTokenPayloadSchema>

const hmac = (secret: string, scope: string, value: string): Buffer => createHmac('sha256', secret).update(`${scope}.${value}`).digest()
const sessionDigest = (secret: string, sessionId: string): string => hmac(secret, 'page-move-session:v1', sessionId).toString('hex')

export const signPageMoveReviewToken = (payload: PageMoveReviewTokenPayload, secret: string): string => {
  const canonical = PageMoveReviewTokenPayloadSchema.parse(payload)
  const encoded = Buffer.from(JSON.stringify(canonical), 'utf8').toString('base64url')
  return `${encoded}.${hmac(secret, 'page-move-review:v1', encoded).toString('base64url')}`
}

export const verifyPageMoveReviewToken = (input: {
  token: unknown
  secret: string
  requesterId: number
  sessionId: string
  now?: number
}): PageMoveReviewTokenPayload | null => {
  if (typeof input.token !== 'string' || input.token.length > 8192 || input.secret.length === 0 || input.sessionId.length === 0) return null
  const [encoded, supplied, ...extra] = input.token.split('.')
  if (!encoded || !supplied || extra.length > 0 || !/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]+$/u.test(supplied)) return null
  const actual = Buffer.from(supplied, 'base64url')
  const expected = hmac(input.secret, 'page-move-review:v1', encoded)
  if (actual.toString('base64url') !== supplied || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.toString('base64url') !== encoded) return null
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  const parsed = PageMoveReviewTokenPayloadSchema.safeParse(value)
  if (!parsed.success || JSON.stringify(parsed.data) !== bytes.toString('utf8')) return null
  const now = input.now ?? Date.now()
  const payload = parsed.data
  if (
    payload.requesterId !== input.requesterId ||
    payload.sessionDigest !== sessionDigest(input.secret, input.sessionId) ||
    payload.issuedAt > now + 60_000 ||
    payload.expiresAt <= now ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > MAX_TOKEN_TTL_MS
  ) return null
  return payload
}

export interface PageMoveReviewCursor {
  readonly version: 1
  readonly targetId: number
  readonly expectedSourceRevision: string
  readonly destinationLocale: string
  readonly destinationPath: string
  readonly requesterId: number
  readonly sessionDigest: string
  readonly afterId: number
  readonly issuedAt: number
}

const cursorKey = (secret: string): Buffer => createHash('sha256').update(`page-move-review-cursor:v1:${secret}`).digest()

export const sealPageMoveReviewCursor = (cursor: PageMoveReviewCursor, secret: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', cursorKey(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(cursor), 'utf8'), cipher.final()])
  const result = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
  if (result.length > MAX_CURSOR_LENGTH) throw new TypeError('Move review cursor exceeds its size limit')
  return result
}

export const openPageMoveReviewCursor = (value: unknown, secret: string): PageMoveReviewCursor | null => {
  if (typeof value !== 'string' || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value || bytes.length < 29) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    const parsed: unknown = JSON.parse(plaintext)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const cursor = parsed as Record<string, unknown>
    if (
      cursor.version !== 1 ||
      !Number.isSafeInteger(cursor.targetId) || Number(cursor.targetId) < 1 ||
      typeof cursor.expectedSourceRevision !== 'string' || !/^[1-9][0-9]*$/u.test(cursor.expectedSourceRevision) ||
      typeof cursor.destinationLocale !== 'string' || cursor.destinationLocale.length < 2 ||
      typeof cursor.destinationPath !== 'string' || cursor.destinationPath.length < 1 ||
      !Number.isSafeInteger(cursor.requesterId) || Number(cursor.requesterId) < 1 ||
      typeof cursor.sessionDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(cursor.sessionDigest) ||
      !Number.isSafeInteger(cursor.afterId) || Number(cursor.afterId) < 0 ||
      !Number.isSafeInteger(cursor.issuedAt) || Number(cursor.issuedAt) < 0 ||
      JSON.stringify(cursor) !== plaintext
    ) return null
    return cursor as unknown as PageMoveReviewCursor
  } catch {
    return null
  }
}

export const pageMoveSessionDigest = sessionDigest
