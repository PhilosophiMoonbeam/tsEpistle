import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Knex } from 'knex'

export const FEDERATED_LOGIN_TABLE = 'federatedLoginAttempts'
export const FEDERATED_LOGIN_TTL_MS = 10 * 60 * 1_000
export const FEDERATED_LOGIN_PAYLOAD_LIMIT = 16 * 1_024
export const FEDERATED_LOGIN_SESSION_LIMIT = 8
export const FEDERATED_LOGIN_GLOBAL_LIMIT = 10_000
export const FEDERATED_LOGIN_PRUNE_BATCH = 256

export type FederatedLoginProtocol = 'oauth2' | 'oidc' | 'openidconnect' | 'cas' | 'saml'

export type OAuthFederatedPayload = Readonly<{
  codeVerifier?: string
  nonce?: string
  redirectUri?: string
  scope?: string | readonly string[]
  responseType?: string
  issued?: string
  maxAge?: number
  authorizationParams?: Readonly<Record<string, string>>
}>

export type CasFederatedPayload = Readonly<{
  serviceUrl: string
  requestId?: string
}>

export type SamlFederatedPayload = Readonly<{
  requestId: string
  relayState?: string
}>

export type FederatedLoginPayload = OAuthFederatedPayload | CasFederatedPayload | SamlFederatedPayload

export interface FederatedLoginIssueInput<P extends FederatedLoginPayload = FederatedLoginPayload> {
  readonly sessionId: string
  readonly providerKey: string
  readonly protocol: FederatedLoginProtocol
  readonly providerRevision: string
  readonly payload: P
  readonly browserNonceHash?: Uint8Array | string
  readonly issuedAt?: Date
}

export interface FederatedLoginIssueResult {
  readonly attemptId: string
  readonly state: string
  readonly issuedAt: Date
  readonly expiresAt: Date
}

export interface FederatedLoginConsumeInput {
  readonly providerKey: string
  readonly protocol: FederatedLoginProtocol
  readonly providerRevision: string
  readonly state?: string
  readonly requestId?: string
  readonly sessionId?: string
  readonly browserNonceHash?: Uint8Array | string
}

export interface FederatedLoginConsumed<P extends FederatedLoginPayload = FederatedLoginPayload> {
  readonly attemptId: string
  readonly providerKey: string
  readonly protocol: FederatedLoginProtocol
  readonly providerRevision: string
  readonly sessionId: string
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly payload: P
}

interface FederatedLoginRow {
  id: string
  stateHash: Buffer | Uint8Array | string
  requestIdHash: Buffer | Uint8Array | string | null
  providerKey: string
  protocol: string
  providerRevision: string
  sessionId: string
  browserNonceHash: Buffer | Uint8Array | string | null
  issuedAt: Date | string
  expiresAt: Date | string
  payload: string | Record<string, unknown>
}

type JsonRecord = Record<string, unknown>
type Database = Knex | Knex.Transaction

const SUPPORTED_PROTOCOLS = new Set<FederatedLoginProtocol>(['oauth2', 'oidc', 'openidconnect', 'cas', 'saml'])
const ADVISORY_LOCK_KEY = 'tsepistle:federated-login-attempts'
const HASH_HEX = /^[0-9a-f]{64}$/iu
const HASH_BASE64URL = /^[A-Za-z0-9_-]{43}$/u

const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value)
const isProtocol = (value: unknown): value is FederatedLoginProtocol => typeof value === 'string' && SUPPORTED_PROTOCOLS.has(value as FederatedLoginProtocol)
const isPostgres = (db: Database): boolean => ['pg', 'postgres', 'postgresql'].includes(String(db.client.config.client).toLowerCase())

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'FEDERATED_LOGIN_INVALID', status: 400 })
const capacity = (message: string): Error => Object.assign(new Error(message), { code: 'FEDERATED_LOGIN_CAPACITY', status: 503 })

const text = (value: unknown, name: string, maximum: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw invalid(`${name} is invalid.`)
  return value
}

const hash = (value: string | Uint8Array): Buffer => createHash('sha256').update(value).digest()

const digest = (value: Uint8Array | string, name: string): Buffer => {
  if (value instanceof Uint8Array) {
    if (value.byteLength !== 32) throw invalid(`${name} is invalid.`)
    return Buffer.from(value)
  }
  if (typeof value === 'string' && HASH_HEX.test(value)) return Buffer.from(value, 'hex')
  if (typeof value === 'string' && HASH_BASE64URL.test(value)) return Buffer.from(value, 'base64url')
  throw invalid(`${name} is invalid.`)
}

const digestMatches = (left: unknown, right: Buffer): boolean => {
  if (left === null || left === undefined) return false
  let candidate: Buffer
  try {
    candidate = Buffer.isBuffer(left) ? left : left instanceof Uint8Array ? Buffer.from(left) : Buffer.from(String(left), 'hex')
  } catch {
    return false
  }
  return candidate.byteLength === right.byteLength && timingSafeEqual(candidate, right)
}

const dateValue = (value: Date | string, name: string): Date => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Federated login ${name} is invalid.`)
  return date
}

const payloadKeys: Record<FederatedLoginProtocol, readonly string[]> = {
  oauth2: ['authorizationParams', 'codeVerifier', 'issued', 'maxAge', 'nonce', 'redirectUri', 'responseType', 'scope'],
  oidc: ['authorizationParams', 'codeVerifier', 'issued', 'maxAge', 'nonce', 'redirectUri', 'responseType', 'scope'],
  openidconnect: ['authorizationParams', 'codeVerifier', 'issued', 'maxAge', 'nonce', 'redirectUri', 'responseType', 'scope'],
  cas: ['requestId', 'serviceUrl'],
  saml: ['relayState', 'requestId']
}

const validatePayload = (protocol: FederatedLoginProtocol, value: unknown): FederatedLoginPayload => {
  if (!isRecord(value)) throw invalid('Federated login payload is invalid.')
  const allowed = new Set(payloadKeys[protocol])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid('Federated login payload contains an unsupported field.')

  if (protocol === 'cas') {
    const serviceUrl = text(value.serviceUrl, 'Federated login service URL', 2_048)
    const requestId = value.requestId === undefined ? undefined : text(value.requestId, 'Federated login request ID', 512)
    return requestId === undefined ? { serviceUrl } : { serviceUrl, requestId }
  }
  if (protocol === 'saml') {
    const requestId = text(value.requestId, 'Federated login request ID', 512)
    const relayState = value.relayState === undefined ? undefined : text(value.relayState, 'Federated login relay state', 512)
    return relayState === undefined ? { requestId } : { requestId, relayState }
  }
  const result: Record<string, unknown> = {}
  for (const key of ['codeVerifier', 'nonce', 'redirectUri', 'responseType', 'issued'] as const) {
    if (value[key] !== undefined) result[key] = text(value[key], `Federated login ${key}`, key === 'redirectUri' ? 2_048 : 1_024)
  }
  if (result.issued !== undefined && Number.isNaN(Date.parse(String(result.issued)))) throw invalid('Federated login issued time is invalid.')
  if (value.maxAge !== undefined) {
    if (typeof value.maxAge !== 'number' || !Number.isSafeInteger(value.maxAge) || value.maxAge < 0 || value.maxAge > FEDERATED_LOGIN_TTL_MS)
      throw invalid('Federated login max age is invalid.')
    result.maxAge = value.maxAge
  }
  if (value.scope !== undefined) {
    if (typeof value.scope === 'string') result.scope = text(value.scope, 'Federated login scope', 2_048)
    else if (Array.isArray(value.scope) && value.scope.length <= 64 && value.scope.every(scope => typeof scope === 'string' && scope.length > 0 && scope.length <= 128))
      result.scope = [...value.scope]
    else throw invalid('Federated login scope is invalid.')
  }
  if (value.authorizationParams !== undefined) {
    if (!isRecord(value.authorizationParams)) throw invalid('Federated login authorization parameters are invalid.')
    const authorizationParams: Record<string, string> = {}
    const entries = Object.entries(value.authorizationParams)
    if (entries.length > 32) throw invalid('Federated login authorization parameters are invalid.')
    for (const [key, parameter] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || typeof parameter !== 'string' || parameter.length > 512)
        throw invalid('Federated login authorization parameters are invalid.')
      authorizationParams[key] = parameter
    }
    result.authorizationParams = authorizationParams
  }
  return result as OAuthFederatedPayload
}

const serializePayload = (protocol: FederatedLoginProtocol, payload: unknown): string => {
  const validated = validatePayload(protocol, payload)
  let serialized: string
  try {
    serialized = JSON.stringify(validated)
  } catch {
    throw invalid('Federated login payload is not serializable.')
  }
  if (Buffer.byteLength(serialized, 'utf8') > FEDERATED_LOGIN_PAYLOAD_LIMIT) throw invalid('Federated login payload is too large.')
  return serialized
}

const parsePayload = (protocol: FederatedLoginProtocol, payload: unknown): FederatedLoginPayload | null => {
  let parsed: unknown = payload
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload) as unknown
    } catch {
      return null
    }
  }
  try {
    return validatePayload(protocol, parsed)
  } catch {
    return null
  }
}

const rowCount = async (db: Database, where: (query: Knex.QueryBuilder) => Knex.QueryBuilder): Promise<number> => {
  const row = await where(db(FEDERATED_LOGIN_TABLE)).count<{ count: string | number }>({ count: '*' }).first()
  const value = row?.count
  return typeof value === 'number' ? value : Number(value ?? 0)
}

const lockCapacity = async (db: Database): Promise<void> => {
  if (isPostgres(db)) await db.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [ADVISORY_LOCK_KEY])
}

const pruneExpired = async (db: Database, now: Date): Promise<void> => {
  const expired = await db(FEDERATED_LOGIN_TABLE).select('id').where('expiresAt', '<=', now).orderBy('expiresAt').limit(FEDERATED_LOGIN_PRUNE_BATCH)
  const ids = expired.map(row => String((row as { id: unknown }).id)).filter(id => id.length > 0)
  if (ids.length > 0) await db(FEDERATED_LOGIN_TABLE).whereIn('id', ids).delete()
}

const isSessionLive = async (db: Database, sessionId: string, now: Date): Promise<boolean> => {
  if (!(await db.schema.hasTable('sessions'))) return false
  const row = await db('sessions').select('sid').where('sid', sessionId).where('expired', '>', now).first()
  return row !== undefined
}
const providerIsCurrent = async (db: Database, providerKey: string, providerRevision: string): Promise<boolean> => {
  if (!(await db.schema.hasTable('authentication'))) return false
  const query = db('authentication')
    .select('key')
    .where({ key: providerKey, adminRevision: providerRevision })
    .where('isEnabled', true)
  const row = await query.forShare().first()
  return row !== undefined
}

export class FederatedLoginStore {
  readonly knex: Knex
  readonly now: () => Date

  constructor(knex: Knex, options: { now?: () => Date } = {}) {
    this.knex = knex
    this.now = options.now ?? (() => new Date())
  }

  async issue(input: FederatedLoginIssueInput): Promise<FederatedLoginIssueResult> {
    const sessionId = text(input.sessionId, 'Federated login session ID', 255)
    const providerKey = text(input.providerKey, 'Federated login provider key', 255)
    const providerRevision = text(input.providerRevision, 'Federated login provider revision', 255)
    if (!isProtocol(input.protocol)) throw invalid('Federated login protocol is unsupported.')
    const protocol = input.protocol
    const serializedPayload = serializePayload(protocol, input.payload)
    const browserNonceHash = input.browserNonceHash === undefined ? null : digest(input.browserNonceHash, 'Federated login browser nonce')
    const issuedAt = input.issuedAt === undefined ? this.now() : new Date(input.issuedAt.getTime())
    if (Number.isNaN(issuedAt.getTime())) throw invalid('Federated login issue time is invalid.')
    const expiresAt = new Date(issuedAt.getTime() + FEDERATED_LOGIN_TTL_MS)
    const state = randomBytes(32).toString('base64url')
    const stateHash = hash(state)
    const payload = JSON.parse(serializedPayload) as FederatedLoginPayload
    const requestIdValue = 'requestId' in payload && typeof payload.requestId === 'string' ? payload.requestId : undefined
    const requestIdHash = requestIdValue === undefined ? null : hash(requestIdValue)
    const attemptId = randomUUID()

    await this.knex.transaction(async transaction => {
      const db = transaction
      await lockCapacity(db)
      if (!(await providerIsCurrent(db, providerKey, providerRevision))) throw invalid('Federated login provider configuration is unavailable.')
      await pruneExpired(db, issuedAt)
      await db(FEDERATED_LOGIN_TABLE)
        .where({ providerKey, protocol, sessionId })
        .delete()

      const sessionCount = await rowCount(db, query => query.where({ sessionId }).where('expiresAt', '>', issuedAt))
      if (sessionCount >= FEDERATED_LOGIN_SESSION_LIMIT) throw capacity('Federated login session capacity is exhausted.')
      const globalCount = await rowCount(db, query => query.where('expiresAt', '>', issuedAt))
      if (globalCount >= FEDERATED_LOGIN_GLOBAL_LIMIT) throw capacity('Federated login capacity is exhausted.')

      await db(FEDERATED_LOGIN_TABLE).insert({
        id: attemptId,
        stateHash,
        requestIdHash,
        providerKey,
        protocol,
        providerRevision,
        sessionId,
        browserNonceHash,
        issuedAt,
        expiresAt,
        payload: serializedPayload
      })
    })

    return { attemptId, state, issuedAt, expiresAt }
  }

  async consume<P extends FederatedLoginPayload = FederatedLoginPayload>(input: FederatedLoginConsumeInput): Promise<FederatedLoginConsumed<P> | null> {
    const providerKey = text(input.providerKey, 'Federated login provider key', 255)
    const providerRevision = text(input.providerRevision, 'Federated login provider revision', 255)
    if (!isProtocol(input.protocol)) throw invalid('Federated login protocol is unsupported.')
    const protocol = input.protocol
    const sessionId = input.sessionId === undefined ? undefined : text(input.sessionId, 'Federated login session ID', 255)
    const suppliedState = input.state === undefined ? undefined : text(input.state, 'Federated login state', 512)
    const suppliedRequestId = input.requestId === undefined ? undefined : text(input.requestId, 'Federated login request ID', 512)
    if (suppliedState === undefined && suppliedRequestId === undefined) return null
    const stateHash = suppliedState === undefined ? undefined : hash(suppliedState)
    const requestIdHash = suppliedRequestId === undefined ? undefined : hash(suppliedRequestId)
    const browserNonceHash = input.browserNonceHash === undefined ? undefined : digest(input.browserNonceHash, 'Federated login browser nonce')
    const now = this.now()
    if (Number.isNaN(now.getTime())) throw invalid('Federated login consume time is invalid.')

    return await this.knex.transaction(async transaction => {
      const db = transaction
      await lockCapacity(db)
      const query = db<FederatedLoginRow>(FEDERATED_LOGIN_TABLE).select('*').forUpdate().where({ providerKey, protocol })
      query.where(builder => {
        if (stateHash !== undefined) builder.where('stateHash', stateHash)
        if (requestIdHash !== undefined) builder.where('requestIdHash', requestIdHash)
      })
      const row = await query.first()
      if (!row) return null

      const sessionMatches = sessionId !== undefined && row.sessionId === sessionId
      const browserMatches = browserNonceHash !== undefined && digestMatches(row.browserNonceHash, browserNonceHash)
      const bindingMatches = row.browserNonceHash === null ? sessionMatches : browserMatches && (sessionId === undefined || sessionMatches)
      if (!bindingMatches) return null
      const liveSessionMatches = await isSessionLive(db, row.sessionId, now)
      if (!liveSessionMatches) {
        await db(FEDERATED_LOGIN_TABLE).where({ id: row.id }).delete()
        return null
      }

      const providerCurrent = await providerIsCurrent(db, providerKey, providerRevision)
      // Delete only after provider and browser/session binding are established.
      // Once selected, every terminal outcome consumes the durable authority.
      await db(FEDERATED_LOGIN_TABLE).where({ id: row.id }).delete()

      const rowStateMatches = stateHash === undefined || digestMatches(row.stateHash, stateHash)
      const rowRequestIdMatches = requestIdHash === undefined || digestMatches(row.requestIdHash, requestIdHash)
      const providerMatches = providerCurrent && row.providerRevision === providerRevision
      const issuedAt = dateValue(row.issuedAt, 'issue time')
      const expiresAt = dateValue(row.expiresAt, 'expiry time')
      if (!rowStateMatches || !rowRequestIdMatches || !providerMatches || expiresAt.getTime() <= now.getTime()) return null

      const payload = parsePayload(protocol, row.payload)
      if (payload === null) return null
      return {
        attemptId: row.id,
        providerKey: row.providerKey,
        protocol,
        providerRevision: row.providerRevision,
        sessionId: row.sessionId,
        issuedAt,
        expiresAt,
        payload
      } as unknown as FederatedLoginConsumed<P>
    })
  }

  async clearExpired(now = this.now()): Promise<number> {
    return await this.knex.transaction(async transaction => {
      const db = transaction
      await lockCapacity(db)
      const result = await db(FEDERATED_LOGIN_TABLE).where('expiresAt', '<=', now).delete()
      return Number(result)
    })
  }
}

export const createFederatedLoginStore = (knex: Knex, options?: { now?: () => Date }): FederatedLoginStore => new FederatedLoginStore(knex, options)
export const serializeFederatedLoginPayload = (protocol: FederatedLoginProtocol, payload: unknown): string => serializePayload(protocol, payload)
export const validateFederatedLoginPayload = (protocol: FederatedLoginProtocol, payload: unknown): FederatedLoginPayload => validatePayload(protocol, payload)
export const hashFederatedLoginValue = (value: string | Uint8Array): Buffer => hash(value)
