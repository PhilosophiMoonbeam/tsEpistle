import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const tokenSecretKey = Symbol.for('tsfranki.diagram-prefetch-token-secret')
const existingTokenSecret: unknown = Reflect.get(globalThis, tokenSecretKey)
const tokenSecret = Buffer.isBuffer(existingTokenSecret) ? existingTokenSecret : randomBytes(32)
if (!Buffer.isBuffer(existingTokenSecret)) Reflect.set(globalThis, tokenSecretKey, tokenSecret)

export const createDiagramPrefetchToken = (url: string): string => createHmac('sha256', tokenSecret).update(url).digest('base64url')

export const hasValidDiagramPrefetchToken = (url: string, token: string): boolean => {
  const expected = Buffer.from(createDiagramPrefetchToken(url), 'base64url')
  let supplied: Buffer
  try {
    supplied = Buffer.from(token, 'base64url')
  } catch {
    return false
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
