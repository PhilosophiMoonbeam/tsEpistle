import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { Request } from 'express'
import {
  OFFLINE_DRAFT_KEY_MAGIC as SHARED_OFFLINE_DRAFT_KEY_MAGIC,
  OFFLINE_DRAFT_KEY_BYTES,
  OFFLINE_KEY_VERSION,
  OFFLINE_READING_KEY_BYTES,
  OFFLINE_READING_KEY_ID_BYTES,
  OFFLINE_READING_KEY_MAGIC,
  OFFLINE_READING_KEY_VERSION,
  OFFLINE_READING_CONTEXT_SCHEMA_VERSION,
  type DraftKeyContext,
  type OfflineReadingContextV1
} from '../../shared/offline.ts'
import { accountSessionIsCurrent, sessionVersion } from './account-session.ts'
import { getAuthenticatedUserContext, RequestAuthenticationError } from './request-auth.ts'
import { getTransportRuntime } from '../controllers/_types.ts'

export const OFFLINE_DRAFT_KEY_VERSION = OFFLINE_KEY_VERSION
export const OFFLINE_DRAFT_KEY_LABEL = 'tsepistle/offline-draft-key/v1' as const
export const OFFLINE_DRAFT_KEY_MAGIC = SHARED_OFFLINE_DRAFT_KEY_MAGIC

interface OfflineDraftKeyAccount {
  readonly id?: unknown
  readonly isActive?: unknown
  readonly authVersion?: unknown
}

export interface OfflineDraftKeyRuntime {
  readonly config: {
    readonly host: string
    /** Installation identity; fresh installs may use the canonical origin until persisted. */
    readonly offlineDraftSiteId?: string
    readonly sessionSecret: string
  }
  readonly models: {
    readonly users: {
      query(): {
        findById(id: number): Promise<OfflineDraftKeyAccount | undefined>
      }
    }
  }
}
export type OfflineReadingKeyRuntime = Omit<OfflineDraftKeyRuntime, 'config'> & {
  readonly config: Omit<OfflineDraftKeyRuntime['config'], 'sessionSecret'>
}

const propertyValue = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined)

const assertUnsignedInteger = (value: unknown, label: string, minimum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${label} must be a safe integer`)
  return value
}

const lpUtf8 = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength > 0xffffffff) throw new RangeError('Encoded offline draft-key field is too large')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.byteLength)
  return Buffer.concat([length, bytes])
}

const assertBoundedUtf8 = (value: string, label: string, maximumBytes: number): void => {
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) throw new RangeError(`${label} is too large`)
}

const u64be = (value: number, label: string, minimum = 0): Buffer => {
  const integer = assertUnsignedInteger(value, label, minimum)
  const encoded = Buffer.allocUnsafe(8)
  encoded.writeBigUInt64BE(BigInt(integer))
  return encoded
}

const contextFields = (
  context: DraftKeyContext
): { readonly canonicalOrigin: string; readonly siteId: string; readonly accountId: number; readonly authVersion: number } => {
  if (context.keyVersion !== OFFLINE_DRAFT_KEY_VERSION) throw new Error('Unsupported offline draft-key version')
  if (typeof context.canonicalOrigin !== 'string' || typeof context.siteId !== 'string') throw new TypeError('Offline draft-key context is invalid')
  const canonicalOrigin = context.canonicalOrigin
  const siteId = context.siteId
  assertBoundedUtf8(canonicalOrigin, 'Canonical origin', 2048)
  assertBoundedUtf8(siteId, 'Site identity', 256)
  const accountId = assertUnsignedInteger(context.accountId, 'accountId', 1)
  const authVersion = assertUnsignedInteger(context.authVersion, 'authVersion', 0)
  return { canonicalOrigin, siteId, accountId, authVersion }
}

export const encodeOfflineDraftKeyInfo = (context: DraftKeyContext): Buffer => {
  const { canonicalOrigin, siteId, accountId, authVersion } = contextFields(context)
  return Buffer.concat([
    lpUtf8(OFFLINE_DRAFT_KEY_LABEL),
    lpUtf8(canonicalOrigin),
    lpUtf8(siteId),
    u64be(accountId, 'accountId', 1),
    u64be(authVersion, 'authVersion'),
    lpUtf8(OFFLINE_DRAFT_KEY_VERSION)
  ])
}

export const deriveOfflineDraftKey = (context: DraftKeyContext, sessionSecret: string): Buffer => {
  if (typeof sessionSecret !== 'string' || sessionSecret.length === 0) throw new Error('Configured session secret is unavailable')
  const secret = Buffer.from(sessionSecret, 'utf8')
  const salt = createHash('sha256').update(Buffer.from(OFFLINE_DRAFT_KEY_LABEL, 'ascii')).digest()
  let prk: Buffer | undefined
  let info: Buffer | undefined
  let expansionInput: Buffer | undefined
  let block: Buffer | undefined
  try {
    prk = createHmac('sha256', salt).update(secret).digest()
    info = encodeOfflineDraftKeyInfo(context)
    expansionInput = Buffer.concat([info, Buffer.from([1])])
    block = createHmac('sha256', prk).update(expansionInput).digest()
    return Buffer.from(block.subarray(0, OFFLINE_DRAFT_KEY_BYTES))
  } finally {
    secret.fill(0)
    prk?.fill(0)
    info?.fill(0)
    expansionInput?.fill(0)
    block?.fill(0)
  }
}

export const encodeOfflineDraftKeyFrame = (context: DraftKeyContext, key: Uint8Array): Buffer => {
  const { canonicalOrigin, siteId, accountId, authVersion } = contextFields(context)
  if (key.byteLength !== OFFLINE_DRAFT_KEY_BYTES) throw new RangeError(`Offline draft key must contain exactly ${OFFLINE_DRAFT_KEY_BYTES} bytes`)
  return Buffer.concat([
    Buffer.from(OFFLINE_DRAFT_KEY_MAGIC, 'ascii'),
    lpUtf8(canonicalOrigin),
    lpUtf8(siteId),
    u64be(accountId, 'accountId', 1),
    u64be(authVersion, 'authVersion'),
    lpUtf8(OFFLINE_DRAFT_KEY_VERSION),
    key
  ])
}

export const createOfflineDraftKeyFrame = (context: DraftKeyContext, sessionSecret: string): Buffer => {
  const key = deriveOfflineDraftKey(context, sessionSecret)
  try {
    return encodeOfflineDraftKeyFrame(context, key)
  } finally {
    key.fill(0)
  }
}

const canonicalOriginFromConfig = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Configured site origin is unavailable')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Configured site origin is invalid')
  }
  const localHttp = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHttp)) throw new Error('Configured site origin is invalid')
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Configured site origin is invalid')
  const origin = parsed.origin
  assertBoundedUtf8(origin, 'Configured site origin', 2048)
  return origin
}

const configuredSiteId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Configured site identity is unavailable')
  assertBoundedUtf8(value, 'Configured site identity', 256)
  return value
}

const authenticationRequired = (): never => {
  throw new RequestAuthenticationError('A current human user session is required')
}

export const resolveOfflineDraftKeyContext = async (
  req: Request,
  runtime: OfflineDraftKeyRuntime = getTransportRuntime<OfflineDraftKeyRuntime>()
): Promise<DraftKeyContext> => {
  const authContext = getAuthenticatedUserContext(req)
  const accountIdClaim = propertyValue(authContext.principal, 'id')
  const authVersionClaim = propertyValue(authContext.principal, 'authVersion')
  if (accountIdClaim !== authContext.userId || typeof authVersionClaim !== 'number' || !Number.isSafeInteger(authVersionClaim) || authVersionClaim < 0)
    authenticationRequired()
  const accountId = assertUnsignedInteger(authContext.userId, 'accountId', 1)
  const account = await runtime.models.users.query().findById(accountId)
  if (!accountSessionIsCurrent({ id: accountIdClaim, authVersion: authVersionClaim }, account)) authenticationRequired()
  const currentAccountId = assertUnsignedInteger(account?.id, 'accountId', 1)
  const currentAuthVersion = sessionVersion(account?.authVersion)
  if (currentAuthVersion === null) throw new RequestAuthenticationError('A current human user session is required')
  const canonicalOrigin = canonicalOriginFromConfig(runtime.config.host)
  const configuredSiteIdentity = propertyValue(runtime.config, 'offlineDraftSiteId')
  const siteId =
    configuredSiteIdentity === undefined || configuredSiteIdentity === null || configuredSiteIdentity === ''
      ? configuredSiteId(canonicalOrigin)
      : configuredSiteId(configuredSiteIdentity)
  return {
    canonicalOrigin,
    siteId,
    accountId: currentAccountId,
    authVersion: currentAuthVersion,
    keyVersion: OFFLINE_DRAFT_KEY_VERSION
  }
}

export const OFFLINE_READING_KEY_FRAME_MAX_BYTES = 16 * 1024

const canonicalReadingKeyId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length !== 22) throw new TypeError('Offline reading key id is invalid')
  let decoded: Buffer | undefined
  try {
    decoded = Buffer.from(value, 'base64url')
    if (decoded.byteLength !== OFFLINE_READING_KEY_ID_BYTES || decoded.toString('base64url') !== value) {
      throw new Error('Non-canonical offline reading key id')
    }
    return value
  } catch {
    throw new TypeError('Offline reading key id is invalid')
  } finally {
    decoded?.fill(0)
  }
}

const readingContextFields = (
  context: OfflineReadingContextV1
): {
  readonly canonicalOrigin: string
  readonly siteId: string
  readonly accountId: number
  readonly authVersion: number
  readonly keyId: string
} => {
  if (context.schemaVersion !== OFFLINE_READING_CONTEXT_SCHEMA_VERSION) throw new Error('Unsupported offline reading context version')
  if (context.keyVersion !== OFFLINE_READING_KEY_VERSION) throw new Error('Unsupported offline reading key version')
  if (typeof context.canonicalOrigin !== 'string' || typeof context.siteId !== 'string') throw new TypeError('Offline reading context is invalid')
  const canonicalOrigin = canonicalOriginFromConfig(context.canonicalOrigin)
  const siteId = configuredSiteId(context.siteId)
  assertBoundedUtf8(canonicalOrigin, 'Canonical origin', 2048)
  assertBoundedUtf8(siteId, 'Site identity', 256)
  const accountId = assertUnsignedInteger(context.accountId, 'accountId', 1)
  const authVersion = assertUnsignedInteger(context.authVersion, 'authVersion', 0)
  const keyId = canonicalReadingKeyId(context.keyId)
  return { canonicalOrigin, siteId, accountId, authVersion, keyId }
}

export const encodeOfflineReadingKeyFrame = (context: OfflineReadingContextV1, key: Uint8Array): Buffer => {
  const { canonicalOrigin, siteId, accountId, authVersion, keyId } = readingContextFields(context)
  if (key.byteLength !== OFFLINE_READING_KEY_BYTES) throw new RangeError(`Offline reading key must contain exactly ${OFFLINE_READING_KEY_BYTES} bytes`)
  const frame = Buffer.concat([
    Buffer.from(OFFLINE_READING_KEY_MAGIC, 'ascii'),
    lpUtf8(canonicalOrigin),
    lpUtf8(siteId),
    u64be(accountId, 'accountId', 1),
    u64be(authVersion, 'authVersion'),
    lpUtf8(OFFLINE_READING_KEY_VERSION),
    lpUtf8(keyId),
    key
  ])
  if (frame.byteLength > OFFLINE_READING_KEY_FRAME_MAX_BYTES) throw new RangeError('Offline reading key frame is too large')
  return frame
}

export const createOfflineReadingKeyFrame = (context: OfflineReadingContextV1): Buffer => {
  const key = randomBytes(OFFLINE_READING_KEY_BYTES)
  try {
    return encodeOfflineReadingKeyFrame(context, key)
  } finally {
    key.fill(0)
  }
}

export const resolveOfflineReadingContext = async (
  req: Request,
  runtime: OfflineReadingKeyRuntime = getTransportRuntime<OfflineReadingKeyRuntime>()
): Promise<OfflineReadingContextV1> => {
  const authContext = getAuthenticatedUserContext(req)
  const accountIdClaim = propertyValue(authContext.principal, 'id')
  const authVersionClaim = propertyValue(authContext.principal, 'authVersion')
  if (accountIdClaim !== authContext.userId || typeof authVersionClaim !== 'number' || !Number.isSafeInteger(authVersionClaim) || authVersionClaim < 0)
    authenticationRequired()
  const accountId = assertUnsignedInteger(authContext.userId, 'accountId', 1)
  const account = await runtime.models.users.query().findById(accountId)
  if (!accountSessionIsCurrent({ id: accountIdClaim, authVersion: authVersionClaim }, account)) authenticationRequired()
  const currentAccountId = assertUnsignedInteger(account?.id, 'accountId', 1)
  const currentAuthVersion = sessionVersion(account?.authVersion)
  if (currentAuthVersion === null) throw new RequestAuthenticationError('A current human user session is required')
  const canonicalOrigin = canonicalOriginFromConfig(runtime.config.host)
  const configuredSiteIdentity = propertyValue(runtime.config, 'offlineDraftSiteId')
  const siteId =
    configuredSiteIdentity === undefined || configuredSiteIdentity === null || configuredSiteIdentity === ''
      ? configuredSiteId(canonicalOrigin)
      : configuredSiteId(configuredSiteIdentity)
  const keyIdBytes = randomBytes(OFFLINE_READING_KEY_ID_BYTES)
  let keyId: string
  try {
    keyId = keyIdBytes.toString('base64url')
  } finally {
    keyIdBytes.fill(0)
  }
  return {
    schemaVersion: OFFLINE_READING_CONTEXT_SCHEMA_VERSION,
    canonicalOrigin,
    siteId,
    accountId: currentAccountId,
    authVersion: currentAuthVersion,
    keyVersion: OFFLINE_READING_KEY_VERSION,
    keyId
  }
}
