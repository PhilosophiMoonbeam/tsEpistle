import { createRequire } from 'node:module'
import type { Request } from 'express'
import type { Strategy as PassportStrategyContract } from 'passport'
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  randomNonce,
  randomPKCECodeVerifier,
  type Configuration,
  type TokenEndpointResponseHelpers
} from 'openid-client'
import { asError } from '../types.ts'
import {
  type FederatedLoginPayload,
  type OAuthFederatedPayload
} from '../../repositories/federated-login.ts'
import { OAuthStateStore } from './oauth-state.ts'

const require = createRequire(import.meta.url)
const PassportStrategy = require('passport-strategy') as new () => PassportStrategyContract & {
  error(error: Error): void
  fail(challenge: unknown, status?: number): void
  redirect(url: string, status?: number): void
  success(user: unknown, info?: unknown): void
}

type OpenIDRequest = Request & {
  params: { strategy: string }
}

type VerifyDone = (error: Error | null, user?: Express.User | false | null, info?: unknown) => void
type OpenIDClientVerify = (request: OpenIDRequest, tokens: TokenEndpointResponseHelpers, done: VerifyDone) => void | Promise<void>

type OpenIDClientStrategyOptions = {
  config: Configuration
  callbackURL: string
  providerKey: string
  providerRevision: string
  scope?: string | readonly string[]
  authorizationParams?: Record<string, string>
  stateStore?: OAuthStateStore
  passReqToCallback: true
  name?: string
}

type StatePayload = {
  codeVerifier: string
  nonce: string
  redirectUri: string
  responseType: 'code'
  scope: string
  authorizationParams?: Record<string, string>
}

type RequestValue = Record<string, unknown>

const isObject = (value: unknown): value is RequestValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const isOpenIDProtocol = (value: string): value is 'oidc' | 'openidconnect' => value === 'oidc' || value === 'openidconnect'
const isOAuthPayload = (value: FederatedLoginPayload): value is OAuthFederatedPayload =>
  isObject(value) && !('serviceUrl' in value) && !('requestId' in value)
const firstString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value.find(entry => typeof entry === 'string')
    return typeof first === 'string' ? first : undefined
  }
  return undefined
}
const requestParameter = (request: OpenIDRequest, name: string): string | undefined => {
  const query = isObject(request.query) ? request.query[name] : undefined
  const body = isObject(request.body) ? request.body[name] : undefined
  return firstString(query) ?? firstString(body)
}

const normalizeScope = (scope: string | readonly string[] | undefined): string => {
  if (Array.isArray(scope)) return scope.join(' ')
  return typeof scope === 'string' && scope.length > 0 ? scope : 'openid profile email'
}

const requestHost = (request: OpenIDRequest): string => {
  const host = typeof request.get === 'function' ? request.get('host') : request.headers.host
  if (typeof host !== 'string' || host.length === 0) throw new Error('OpenID Connect callback host is unavailable.')
  return host
}

const requestCurrentUrl = (request: OpenIDRequest): URL => {
  const protocol = typeof request.protocol === 'string' && request.protocol.length > 0 ? request.protocol : 'https'
  const path = typeof request.originalUrl === 'string' && request.originalUrl.length > 0 ? request.originalUrl : request.url
  const current = new URL(`${protocol}://${requestHost(request)}${path}`)
  if (request.method === 'POST' && isObject(request.body)) {
    for (const [key, value] of Object.entries(request.body)) {
      const text = firstString(value)
      if (text !== undefined && !current.searchParams.has(key)) current.searchParams.set(key, text)
    }
  }
  return current
}

const invalidState = (message = 'Invalid authorization request state.'): { message: string } => ({ message })

class OpenIDClientStrategy extends PassportStrategy {
  override readonly name: string
  readonly config: Configuration
  readonly callbackURL: string
  readonly providerKey: string
  readonly providerRevision: string
  readonly scope: string
  readonly authorizationParams: Record<string, string>
  readonly stateStore: OAuthStateStore
  readonly verify: OpenIDClientVerify

  constructor(options: OpenIDClientStrategyOptions, verify: OpenIDClientVerify) {
    super()
    if (!(options.config instanceof Object)) throw new TypeError('OpenID Client configuration is required.')
    if (typeof options.callbackURL !== 'string' || options.callbackURL.length === 0) throw new TypeError('OpenID Client callback URL is required.')
    if (typeof options.providerKey !== 'string' || options.providerKey.length === 0) throw new TypeError('OpenID Client provider key is required.')
    if (typeof options.providerRevision !== 'string' || options.providerRevision.length === 0) throw new TypeError('OpenID Client provider revision is required.')
    if (typeof verify !== 'function') throw new TypeError('OpenID Client strategy requires a verify callback.')
    this.name = options.name ?? 'openid-client'
    this.config = options.config
    this.callbackURL = options.callbackURL
    this.providerKey = options.providerKey
    this.providerRevision = options.providerRevision
    this.scope = normalizeScope(options.scope)
    this.authorizationParams = { ...(options.authorizationParams ?? {}) }
    this.stateStore = options.stateStore ?? new OAuthStateStore({
      providerKey: options.providerKey,
      providerRevision: options.providerRevision,
      protocol: 'openidconnect'
    })
    this.verify = verify
  }

  override authenticate(request: OpenIDRequest): void {
    const current = requestCurrentUrl(request)
    const isInitiation = request.method === 'GET' && !current.searchParams.has('code') && !current.searchParams.has('error')
    void (isInitiation ? this.startAuthorization(request) : this.completeAuthorization(request, current)).catch(error => this.error(asError(error)))
  }

  private async startAuthorization(request: OpenIDRequest): Promise<void> {
    const codeVerifier = randomPKCECodeVerifier()
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier)
    const nonce = randomNonce()
    const redirectUri = new URL(this.callbackURL).href
    const payload: StatePayload = {
      codeVerifier,
      nonce,
      redirectUri,
      responseType: 'code',
      scope: this.scope,
      ...(Object.keys(this.authorizationParams).length === 0 ? {} : { authorizationParams: this.authorizationParams })
    }
    const issued = await this.stateStore.issue(request, payload)
    const parameters = new URLSearchParams({
      ...this.authorizationParams,
      response_type: payload.responseType,
      redirect_uri: redirectUri,
      scope: payload.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      nonce,
      state: issued.state
    })
    const location = buildAuthorizationUrl(this.config, parameters)
    this.redirect(location.href)
  }

  private async completeAuthorization(request: OpenIDRequest, currentURL: URL): Promise<void> {
    const providedState = requestParameter(request, 'state')
    const consumed = await this.stateStore.consume(request, providedState)
    if (!consumed || !isOpenIDProtocol(consumed.protocol) || consumed.protocol !== this.stateStore.protocol || !isOAuthPayload(consumed.payload)) {
      this.fail(invalidState(providedState), 403)
      return
    }

    const payload = consumed.payload
    if (typeof payload.codeVerifier !== 'string' || typeof payload.nonce !== 'string' || typeof payload.redirectUri !== 'string') {
      this.fail(invalidState(), 403)
      return
    }

    const errorCode = requestParameter(request, 'error')
    if (errorCode) {
      this.fail({ message: requestParameter(request, 'error_description') ?? errorCode })
      return
    }

    const checks: {
      pkceCodeVerifier: string
      expectedNonce: string
      expectedState: string
      maxAge?: number
    } = {
      pkceCodeVerifier: payload.codeVerifier,
      expectedNonce: payload.nonce,
      expectedState: providedState ?? ''
    }
    if (typeof payload.maxAge === 'number') checks.maxAge = payload.maxAge
    const tokens = await authorizationCodeGrant(this.config, currentURL, checks)
    await this.verify(request, tokens, (error, user, info) => {
      if (error) {
        this.error(error)
      } else if (!user) {
        this.fail(info)
      } else {
        this.success(user, info)
      }
    })
  }
}

export {
  OpenIDClientStrategy,
  type OpenIDClientStrategyOptions,
  type OpenIDClientVerify,
  type StatePayload as OpenIDClientStatePayload,
  type VerifyDone as OpenIDClientVerifyDone
}