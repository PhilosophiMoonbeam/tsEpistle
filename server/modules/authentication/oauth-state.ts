import type { Request } from 'express'
import type { Knex } from 'knex'

import {
  consumeFederatedLogin,
  issueFederatedLogin,
  type FederatedLoginIssued
} from '../../helpers/federated-login.ts'
import {
  FederatedLoginStore,
  type FederatedLoginConsumed,
  type FederatedLoginPayload,
  type FederatedLoginProtocol,
  type OAuthFederatedPayload
} from '../../repositories/federated-login.ts'

type OAuthRequest = Request & {
  sessionID?: string
}

type StateCallback = (error: Error | null, state?: string) => void
type VerifyCallback = (error: Error | null, verified?: unknown, state?: unknown) => void

type OAuthStateMeta = {
  callbackURL?: string
  authorizationURL?: string
  tokenURL?: string
  clientID?: string
}

type OidcStateContext = {
  issued?: Date | string
  maxAge?: number
  nonce?: string
}

type OAuthStateStoreOptions = {
  providerKey: string
  providerRevision: string
  protocol?: Extract<FederatedLoginProtocol, 'oauth2' | 'oidc' | 'openidconnect'>
  backend?: FederatedLoginStore
  runtime?: unknown
}

type FederatedRuntime = {
  models?: {
    knex?: Knex
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isOAuthProtocol = (value: FederatedLoginProtocol): value is Extract<FederatedLoginProtocol, 'oauth2' | 'oidc' | 'openidconnect'> =>
  value === 'oauth2' || value === 'oidc' || value === 'openidconnect'
const isOAuthPayload = (value: FederatedLoginPayload): value is OAuthFederatedPayload =>
  isObject(value) && !('serviceUrl' in value) && !('requestId' in value)
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const asError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value))

const durableStore = (runtime: unknown = globalThis.WIKI): FederatedLoginStore => {
  const candidate = runtime as FederatedRuntime
  const knex = candidate?.models?.knex
  if (!knex) throw new Error('Federated login requires a durable database store.')
  return new FederatedLoginStore(knex)
}

const requireRevision = (value: unknown): string => {
  if (!isNonEmptyString(value)) throw new Error('Federated login provider configuration revision is unavailable.')
  return value
}

const serializeIssued = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  const issued = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(issued.getTime())) throw new Error('OpenID Connect issued time is invalid.')
  return issued.toISOString()
}

const callbackPayload = (meta: OAuthStateMeta): Record<string, string> => {
  if (!isNonEmptyString(meta.callbackURL)) return {}
  return { redirectUri: meta.callbackURL }
}

const invalidState = (providedState: unknown): { message: string } => ({
  message: isNonEmptyString(providedState) ? 'Invalid authorization request state.' : 'Unable to verify authorization request state.'
})

/**
 * State storage shared by Passport OAuth2 and passport-openidconnect. The
 * upstream strategies only receive req, so this adapter resolves the durable
 * repository lazily and never writes state into req.session.
 */
export class OAuthStateStore {
  readonly providerKey: string
  readonly providerRevision: string
  readonly protocol: Extract<FederatedLoginProtocol, 'oauth2' | 'oidc' | 'openidconnect'>
  readonly backend: FederatedLoginStore | undefined
  readonly runtime: unknown

  constructor(options: OAuthStateStoreOptions) {
    if (!isNonEmptyString(options.providerKey)) throw new Error('Federated login provider key is unavailable.')
    this.providerKey = options.providerKey
    this.providerRevision = requireRevision(options.providerRevision)
    this.protocol = options.protocol ?? 'oauth2'
    this.backend = options.backend
    this.runtime = options.runtime
  }

  private repository(): FederatedLoginStore {
    return this.backend ?? durableStore(this.runtime)
  }

  async issue(request: OAuthRequest, payload: FederatedLoginPayload): Promise<FederatedLoginIssued> {
    return await issueFederatedLogin({
      request,
      store: this.repository(),
      providerKey: this.providerKey,
      protocol: this.protocol,
      providerRevision: this.providerRevision,
      payload
    })
  }

  async consume(request: OAuthRequest, state: string | undefined): Promise<FederatedLoginConsumed | null> {
    return await consumeFederatedLogin({
      request,
      store: this.repository(),
      providerKey: this.providerKey,
      protocol: this.protocol,
      providerRevision: this.providerRevision,
      ...(state === undefined ? {} : { state })
    })
  }

  /**
   * Passport OAuth2 invokes this five-argument form when PKCE is enabled.
   * passport-openidconnect invokes the same arity with an OIDC context object.
   */
  store(request: OAuthRequest, verifierOrContext: string | OidcStateContext | undefined, appState: string | undefined, meta: OAuthStateMeta, callback: StateCallback): void {
    if (isObject(verifierOrContext)) {
      const context = verifierOrContext
      const issued = serializeIssued(context.issued)
      void this.issue(request, {
        ...callbackPayload(meta),
        ...(isNonEmptyString(context.nonce) ? { nonce: context.nonce } : {}),
        ...(context.maxAge === undefined ? {} : { maxAge: context.maxAge }),
        ...(issued === undefined ? {} : { issued }),
        responseType: 'code'
      }).then(result => callback(null, result.state)).catch(error => callback(asError(error)))
      void appState
      return
    }

    if (!isNonEmptyString(verifierOrContext)) {
      callback(new Error('OAuth authorization request did not produce a PKCE verifier.'))
      return
    }
    void this.issue(request, {
      ...callbackPayload(meta),
      codeVerifier: verifierOrContext,
      responseType: 'code'
    }).then(result => callback(null, result.state)).catch(error => callback(asError(error)))
    void appState
  }

  /**
   * OAuth2 passes metadata before the callback; OpenID Connect passes only the
   * callback. Four declared parameters make Passport choose the OAuth2 form.
   */
  verify(request: OAuthRequest, providedState: string | undefined, metaOrCallback: OAuthStateMeta | VerifyCallback, callback?: VerifyCallback): void {
    const done = typeof metaOrCallback === 'function' ? metaOrCallback : callback
    if (!done) throw new Error('Federated login state callback is unavailable.')
    void this.consume(request, isNonEmptyString(providedState) ? providedState : undefined).then(consumed => {
      if (!consumed || !isOAuthProtocol(consumed.protocol) || !isOAuthPayload(consumed.payload)) {
        done(null, false, invalidState(providedState))
        return
      }

      const payload = consumed.payload
      if (this.protocol === 'oauth2') {
        if (consumed.protocol !== 'oauth2' || !isNonEmptyString(payload.codeVerifier)) {
          done(null, false, { message: 'Invalid authorization request state.' })
          return
        }
        done(null, payload.codeVerifier)
        return
      }

      if (consumed.protocol !== 'oidc' && consumed.protocol !== 'openidconnect') {
        done(null, false, { message: 'Invalid authorization request state.' })
        return
      }

      const context: OidcStateContext = {}
      if (isNonEmptyString(payload.nonce)) context.nonce = payload.nonce
      if (typeof payload.maxAge === 'number') context.maxAge = payload.maxAge
      if (isNonEmptyString(payload.issued)) {
        const issued = new Date(payload.issued)
        if (Number.isNaN(issued.getTime())) {
          done(null, false, { message: 'Invalid authorization request state.' })
          return
        }
        context.issued = issued
      }
      done(null, context)
    }).catch(error => done(asError(error)))
    void metaOrCallback
  }
}

export const providerRevisionFromConfig = (config: { adminRevision?: unknown }): string => requireRevision(config.adminRevision)
const configRevision = providerRevisionFromConfig

export const createOAuthStateStore = (
  providerKey: string,
  providerRevision: string,
  protocol: Extract<FederatedLoginProtocol, 'oauth2' | 'oidc' | 'openidconnect'> = 'oauth2',
  backend?: FederatedLoginStore
): OAuthStateStore => new OAuthStateStore({ providerKey, providerRevision, protocol, ...(backend === undefined ? {} : { backend }) })

export const oauth2StateOptions = (config: { key: string; adminRevision?: unknown }): { state: true; pkce: true; store: OAuthStateStore } => ({
  state: true,
  pkce: true,
  store: createOAuthStateStore(config.key, configRevision(config), 'oauth2')
})
export const discordOauth2StateOptions = (config: { key: string; adminRevision?: unknown }): { state: true; pkce: true; store: OAuthStateStore } => {
  const store = createOAuthStateStore(config.key, configRevision(config), 'oauth2')
  const persist = store.store.bind(store)
  Object.defineProperty(store, 'store', {
    configurable: true,
    writable: true,
    value: function discordStore(request: OAuthRequest, verifierOrContext: string | OidcStateContext | undefined, appState: string | undefined, meta: OAuthStateMeta, callback: StateCallback, legacyArgument: unknown): void {
      void legacyArgument
      persist(request, verifierOrContext, appState, meta, callback)
    }
  })
  return { state: true, pkce: true, store }
}

export const oidcStateOptions = (config: { key: string; adminRevision?: unknown }): { store: OAuthStateStore } => ({
  store: createOAuthStateStore(config.key, configRevision(config), 'oidc')
})

export const openidConnectStateOptions = (config: { key: string; adminRevision?: unknown }): { store: OAuthStateStore } => ({
  store: createOAuthStateStore(config.key, configRevision(config), 'openidconnect')
})