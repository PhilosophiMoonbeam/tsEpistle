import { createHash, randomBytes } from 'node:crypto'
import type { CookieOptions } from 'express'
import type { Request } from 'express'

import {
  FEDERATED_LOGIN_TTL_MS,
  type FederatedLoginConsumed,
  type FederatedLoginConsumeInput,
  type FederatedLoginIssueInput,
  type FederatedLoginIssueResult,
  type FederatedLoginPayload,
  type FederatedLoginProtocol,
  FederatedLoginStore
} from '../repositories/federated-login.ts'
export type {
  FederatedLoginConsumed,
  FederatedLoginPayload,
  FederatedLoginProtocol
} from '../repositories/federated-login.ts'
export const FEDERATED_LOGIN_COOKIE_PREFIX = '__Host-federated-'

export interface FederatedLoginRequest {
  readonly sessionID?: string | undefined
  readonly session?: {
    save(callback: (error?: unknown) => void): void
  } | undefined
  readonly cookies?: Record<string, unknown> | undefined
  readonly protocol?: string | undefined
  readonly secure?: boolean | undefined
  readonly get?: ((name: string) => string | undefined) | undefined
  readonly res?: FederatedLoginResponse | undefined
}

export interface FederatedLoginResponse {
  cookie?(name: string, value: string, options?: unknown): unknown
  clearCookie?(name: string, options?: unknown): unknown
}


export interface FederatedLoginIssueRequest {
  readonly request: FederatedLoginRequest
  readonly response?: FederatedLoginResponse | undefined
  readonly store: FederatedLoginStore
  readonly providerKey: string
  readonly protocol: FederatedLoginProtocol
  readonly providerRevision: string
  readonly payload: FederatedLoginPayload
}

export interface FederatedLoginIssued extends FederatedLoginIssueResult {
  readonly browserNonce?: string
}

export interface FederatedLoginConsumeRequest {
  readonly request: FederatedLoginRequest
  readonly store: FederatedLoginStore
  readonly providerKey: string
  readonly protocol: FederatedLoginProtocol
  readonly providerRevision: string
  readonly state?: string
  readonly requestId?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const providerCookieSlug = (providerKey: string): string => {
  const safeKey = providerKey.replace(/[^A-Za-z0-9_-]/gu, '-').replace(/-{2,}/gu, '-').replace(/^-|-$/gu, '').slice(0, 48) || 'provider'
  const digest = createHash('sha256').update(providerKey).digest('base64url').slice(0, 16)
  return `${safeKey}-${digest}`
}

export const federatedLoginCookieName = (providerKey: string): string => `${FEDERATED_LOGIN_COOKIE_PREFIX}${providerCookieSlug(providerKey)}`

export const federatedLoginCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  path: '/',
  maxAge: FEDERATED_LOGIN_TTL_MS
})

export const federatedLoginCookieClearOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  path: '/'
})

const browserNonceHash = (nonce: string): Buffer => createHash('sha256').update(nonce).digest()

const requestIsHttps = (request: FederatedLoginRequest): boolean => {
  if (request.secure === true) return true
  const protocol = request.protocol
  if (protocol === 'https') return true
  const forwarded = request.get?.('x-forwarded-proto')
  return typeof forwarded === 'string' && forwarded.split(',', 1)[0]?.trim().toLowerCase() === 'https'
}
export const persistFederatedLoginSession = async (request: FederatedLoginRequest): Promise<string> => {
  const sessionId = request.sessionID
  const save = request.session?.save
  if (!nonEmptyString(sessionId) || typeof save !== 'function') throw new Error('Federated login requires a durable browser session.')
  await new Promise<void>((resolve, reject) => {
    save.call(request.session, error => {
      if (error) reject(error)
      else resolve()
    })
  })
  return sessionId
}

const browserNonceFromRequest = (request: FederatedLoginRequest, providerKey: string): string | undefined => {
  const value = request.cookies?.[federatedLoginCookieName(providerKey)]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export const issueFederatedLogin = async (input: FederatedLoginIssueRequest): Promise<FederatedLoginIssued> => {
  if (input.protocol === 'saml' && !requestIsHttps(input.request)) throw new Error('SAML federation requires HTTPS.')
  const sessionId = await persistFederatedLoginSession(input.request)

  let browserNonce: string | undefined
  if (input.protocol === 'saml') browserNonce = randomBytes(32).toString('base64url')
  const issueInput: FederatedLoginIssueInput = {
    sessionId,
    providerKey: input.providerKey,
    protocol: input.protocol,
    providerRevision: input.providerRevision,
    payload: input.payload,
    ...(browserNonce === undefined ? {} : { browserNonceHash: browserNonceHash(browserNonce) })
  }
  const issued = await input.store.issue(issueInput)
  if (browserNonce !== undefined) {
    if (!input.response || typeof input.response.cookie !== 'function') throw new Error('SAML federation requires a response cookie writer.')
    input.response.cookie(federatedLoginCookieName(input.providerKey), browserNonce, federatedLoginCookieOptions())
  }
  return browserNonce === undefined ? issued : { ...issued, browserNonce }
}
export const consumeFederatedLogin = async (input: FederatedLoginConsumeRequest): Promise<FederatedLoginConsumed | null> => {
  if (input.protocol === 'saml' && !requestIsHttps(input.request)) return null
  const browserNonce = browserNonceFromRequest(input.request, input.providerKey)
  const sessionId = nonEmptyString(input.request.sessionID) ? input.request.sessionID : undefined
  if (input.protocol === 'saml' && browserNonce === undefined) return null
  const consumeInput: FederatedLoginConsumeInput = {
    providerKey: input.providerKey,
    protocol: input.protocol,
    providerRevision: input.providerRevision,
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(browserNonce === undefined ? {} : { browserNonceHash: browserNonceHash(browserNonce) })
  }
  return await input.store.consume(consumeInput)
}

export const clearFederatedLoginCookie = (response: FederatedLoginResponse, providerKey: string): void => {
  if (typeof response.clearCookie === 'function') response.clearCookie(federatedLoginCookieName(providerKey), federatedLoginCookieClearOptions())
}

const queryValue = (request: Request, name: string): unknown => {
  const query = request.query
  return isRecord(query) ? query[name] : undefined
}

const bodyValue = (request: Request, name: string): unknown => {
  const body = request.body
  return isRecord(body) ? body[name] : undefined
}

export const hasFederatedCallbackCorrelation = (request: Request): boolean => {
  if (request.method === 'GET') {
    const state = queryValue(request, 'state')
    const responseIndicator = [
      queryValue(request, 'code'),
      queryValue(request, 'error'),
      queryValue(request, 'ticket')
    ]
    return nonEmptyString(state) && responseIndicator.some(value => nonEmptyString(value))
  }
  if (request.method !== 'POST') return false
  const response = bodyValue(request, 'SAMLResponse')
  const relayState = bodyValue(request, 'RelayState')
  const cookies = (request as Request & { cookies?: Record<string, unknown> }).cookies
  const browserCookie = cookies !== undefined && Object.keys(cookies).some(key => key.startsWith(FEDERATED_LOGIN_COOKIE_PREFIX) && nonEmptyString(cookies[key]))
  return nonEmptyString(response) && (nonEmptyString(relayState) || browserCookie)
}

export const isFederatedCallbackPath = (path: string): boolean => /^\/login\/[^/]+\/callback$/u.test(path)
