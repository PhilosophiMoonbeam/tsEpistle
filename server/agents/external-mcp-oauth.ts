import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import { GOOGLE_WORKSPACE_MCP_SERVICES, type ExternalMcpOAuthInput, type ExternalMcpOAuthView } from '../../shared/agents/external-mcp.ts'
import { validateExternalMcpDestination, type ExternalMcpServiceDependencies } from './external-mcp.ts'
import { discoverOAuthServer, oauthFailure, oauthRequest, type OAuthServerMetadata } from './external-mcp-oauth-protocol.ts'
import { AgentRepositoryError } from './repository.ts'

export const EXTERNAL_MCP_OAUTH_CALLBACK_PATH = '/agents/oauth/callback'
export const GOOGLE_WORKSPACE_CALLBACK_PATH = '/agents/oauth/google/callback'
export const EXTERNAL_MCP_OAUTH_CLIENT_METADATA_PATH = '/agents/oauth/client-metadata'
export const EXTERNAL_MCP_OAUTH_RETURN_PATH = '/p/profile'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const invalid = (): never => { throw new AgentRepositoryError('EXTERNAL_MCP_OAUTH_INVALID', 'Authorization expired or is invalid; connect again', 400) }
const reconnect = (): never => { throw new AgentRepositoryError('EXTERNAL_MCP_RECONNECT_REQUIRED', 'Connect this external MCP endpoint again', 409) }
const TokenSchema = z.object({
  access_token: z.string().regex(/^[\x21-\x7e]{1,8192}$/u), refresh_token: z.string().regex(/^[\x21-\x7e]{1,8192}$/u).optional(),
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'), expires_in: z.number().int().positive().max(31_536_000).optional(), scope: z.string().max(16_384).optional()
})
const StoredTokenSchema = z.object({ accessToken: z.string(), refreshToken: z.string().optional(), expiresAt: z.number().nullable(), scopes: z.array(z.string()) })
type StoredToken = z.infer<typeof StoredTokenSchema>
type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'
export interface ExternalMcpOAuthConfiguration { readonly siteOrigin: string; readonly googleWorkspace?: { readonly clientId: string; readonly clientSecret: string } }
export interface ExternalMcpOAuthContext {
  readonly userId: number; readonly serverId: string; readonly serverRevision: number; readonly authVersion: number
  readonly authorizationStamp: string; readonly endpointUrl: string; readonly oauth: ExternalMcpOAuthInput; readonly clientSecretReference: string | null
  readonly credentialOwnerId: number
}
export interface ExternalMcpOAuthCallbackInput { readonly state: string; readonly code?: string; readonly error?: string; readonly iss?: string; readonly sessionId: string; readonly callbackPath: string }
export interface ExternalMcpOAuthConnectResult { readonly authorizationUrl: string }
export type ExternalMcpOAuthCallbackStatus = 'connected' | 'denied' | 'error'
export interface ExternalMcpOAuthClientMetadata {
  readonly client_id: string
  readonly client_name: string
  readonly redirect_uris: readonly string[]
  readonly token_endpoint_auth_method: 'none'
  readonly grant_types: readonly string[]
  readonly response_types: readonly string[]
  readonly application_type: 'web'
}
type Authorize = (tx: Knex.Transaction) => Promise<ExternalMcpOAuthContext>
interface Binding extends OAuthServerMetadata { readonly configurationHash: string; readonly callbackUrl: string; readonly clientId: string; readonly authMethod: AuthMethod; readonly scopes: readonly string[] }
interface Client { readonly clientId: string; readonly clientSecret?: string; readonly authMethod: AuthMethod; readonly expiresAt?: number }
interface Grant { id: string; userId: number; serverId: string; serverRevision: number; authVersion: number; authorizationStamp: string; secretReference: string | null; binding: string | null }
interface Pending { stateHash: string; grantId: string; sessionHash: string; secretReference: string; expiresAt: Date | string | number }
interface Registration { serverId: string; configurationHash: string; binding: string; secretReference: string }
interface PendingSecret { readonly verifier: string; readonly client: Client }
const configurationHash = (context: ExternalMcpOAuthContext): string => hash(JSON.stringify([context.endpointUrl, context.oauth, context.clientSecretReference]))
const registrationHash = (context: ExternalMcpOAuthContext): string => {
  const { scopes: _scopes, ...identity } = context.oauth
  return hash(JSON.stringify([context.endpointUrl, identity, context.clientSecretReference]))
}
const googleService = (url: string) => GOOGLE_WORKSPACE_MCP_SERVICES.find(service => service.endpointUrl === url) ?? oauthFailure('The Google Workspace preset requires an official service endpoint')

/** Browser consent and encrypted transaction state remain application-owned, not an SDK Promise. */
export class ExternalMcpOAuthService {
  readonly #dependencies: ExternalMcpServiceDependencies
  readonly #configuration: ExternalMcpOAuthConfiguration | undefined
  constructor(dependencies: ExternalMcpServiceDependencies) {
    this.#dependencies = dependencies
    if (dependencies.oauth) {
      try {
        const origin = new URL(dependencies.oauth.siteOrigin)
        if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') return
        this.#configuration = { ...dependencies.oauth, siteOrigin: origin.origin }
      } catch { /* HTTP installations retain ordinary none/bearer MCP; OAuth reports not configured. */ }
    }
  }
  clientMetadata(): ExternalMcpOAuthClientMetadata {
    const origin = this.#config().siteOrigin
    return { client_id: origin + EXTERNAL_MCP_OAUTH_CLIENT_METADATA_PATH, client_name: 'tsEpistle external MCP', redirect_uris: [origin + EXTERNAL_MCP_OAUTH_CALLBACK_PATH], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'web' }
  }
  #config(): ExternalMcpOAuthConfiguration {
    if (!this.#configuration) throw new AgentRepositoryError('EXTERNAL_MCP_OAUTH_NOT_CONFIGURED', 'External MCP OAuth requires a public HTTPS wiki origin', 503)
    return this.#configuration
  }
  #matches(grant: Grant, context: ExternalMcpOAuthContext): boolean {
    return grant.userId === context.userId && grant.serverId === context.serverId && grant.serverRevision === context.serverRevision && grant.authVersion === context.authVersion && grant.authorizationStamp === context.authorizationStamp && Boolean(grant.binding && this.#binding(grant)?.configurationHash === configurationHash(context))
  }
  #binding(grant: Grant): Binding | null {
    if (!grant.binding) return null
    try { return JSON.parse(grant.binding) as Binding } catch { return null }
  }
  async #tokens(tx: Knex.Transaction, grant: Grant): Promise<StoredToken | null> {
    if (!grant.secretReference) return null
    const value = await this.#dependencies.secrets.get(grant.secretReference, tx)
    if (!value) return null
    try { return StoredTokenSchema.parse(JSON.parse(value)) } catch { return null }
  }
  async #remove(tx: Knex.Transaction, grant: Grant, reconnectRequired = false): Promise<void> {
    const pending = await tx<Pending>('agentExternalMcpOAuthPending').where('grantId', grant.id).select('secretReference')
    for (const row of pending) await this.#dependencies.secrets.delete(row.secretReference, tx)
    await tx('agentExternalMcpOAuthPending').where('grantId', grant.id).delete()
    if (grant.secretReference) await this.#dependencies.secrets.delete(grant.secretReference, tx)
    if (reconnectRequired) await tx('agentExternalMcpOAuthGrants').where('id', grant.id).update({ secretReference: null })
    else await tx('agentExternalMcpOAuthGrants').where('id', grant.id).delete()
  }
  async invalidateEndpoint(tx: Knex.Transaction, serverId: string, resetRegistration = false): Promise<void> {
    for (const grant of await tx<Grant>('agentExternalMcpOAuthGrants').where('serverId', serverId).select('*')) await this.#remove(tx, grant)
    if (!resetRegistration) return
    const registration = await tx<Registration>('agentExternalMcpOAuthRegistrations').where({ serverId }).first()
    if (registration) { await tx('agentExternalMcpOAuthRegistrations').where({ serverId }).delete(); await this.#dependencies.secrets.delete(registration.secretReference, tx) }
  }
  async status(authorize: Authorize): Promise<ExternalMcpOAuthView> {
    return this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).first()
      const token = grant && this.#matches(grant, context) ? await this.#tokens(tx, grant) : null
      const binding = grant && this.#binding(grant)
      const connected = Boolean(token && (token.expiresAt === null || token.expiresAt > Date.now() || token.refreshToken) && binding?.scopes.every(scope => token.scopes.includes(scope)))
      // Legacy encrypted grants remain sealed until explicit connect/disconnect; never refresh unbound tokens.
      if (grant?.binding && !this.#matches(grant, context)) await this.#remove(tx, grant, true)
      const configured = Boolean(this.#configuration && (context.oauth.preset !== 'google-workspace' || (this.#configuration.googleWorkspace?.clientId && this.#configuration.googleWorkspace.clientSecret)))
      const scopes = context.oauth.preset === 'google-workspace' ? googleService(context.endpointUrl).scopes : context.oauth.scopes ?? binding?.scopes ?? []
      return { configured, connected, scopes, reconnectRequired: Boolean(grant && !connected), ...(binding ? { issuer: binding.issuer } : context.oauth.issuer ? { issuer: context.oauth.issuer } : {}), registrationMode: context.oauth.registrationMode, ...(this.#configuration ? { callbackUrl: this.#configuration.siteOrigin + (context.oauth.preset ? GOOGLE_WORKSPACE_CALLBACK_PATH : EXTERNAL_MCP_OAUTH_CALLBACK_PATH) } : {}) }
    })
  }
  async #registration(tx: Knex.Transaction, context: ExternalMcpOAuthContext): Promise<{ binding: Binding; client: Client }> {
    const config = this.#config(), fingerprint = configurationHash(context)
    if (context.oauth.preset === 'google-workspace' && (!config.googleWorkspace?.clientId || !config.googleWorkspace.clientSecret))
      throw new AgentRepositoryError('EXTERNAL_MCP_OAUTH_NOT_CONFIGURED', 'The Google Workspace preset requires both configured client credentials', 503)
    const saved = await tx<Registration>('agentExternalMcpOAuthRegistrations').where('serverId', context.serverId).first()
    if (saved) {
      if (saved.configurationHash !== registrationHash(context)) return oauthFailure('OAuth client configuration changed; explicitly replace its credentials before reconnecting')
      const binding = JSON.parse(saved.binding) as Binding
      if (!context.oauth.preset) {
        const current = await discoverOAuthServer(this.#dependencies, context.endpointUrl, context.oauth.issuer)
        if (current.issuer !== binding.issuer || current.tokenEndpoint !== binding.tokenEndpoint || current.authorizationEndpoint !== binding.authorizationEndpoint ||
          current.resource !== binding.resource || current.requireResponseIssuer !== binding.requireResponseIssuer || !current.authMethods.includes(binding.authMethod))
          return oauthFailure('Authorization server metadata changed; explicitly replace or reconfigure the OAuth client credentials before reconnecting')
      }
      await validateExternalMcpDestination(binding.authorizationEndpoint, this.#dependencies.resolve)
      const value = await this.#dependencies.secrets.get(saved.secretReference, tx)
      if (!value) return reconnect()
      const client = JSON.parse(value) as Client
      if (client.expiresAt && client.expiresAt <= Date.now()) return oauthFailure('OAuth client registration expired; save this endpoint again')
      const currentBinding: Binding = { ...binding, configurationHash: fingerprint, scopes: context.oauth.scopes ?? binding.scopes }
      if (JSON.stringify(currentBinding) !== saved.binding) await tx('agentExternalMcpOAuthRegistrations').where('serverId', context.serverId).update({ binding: JSON.stringify(currentBinding) })
      return { binding: currentBinding, client }
    }
    let metadata: OAuthServerMetadata, client: Client
    const callbackUrl = config.siteOrigin + (context.oauth.preset ? GOOGLE_WORKSPACE_CALLBACK_PATH : EXTERNAL_MCP_OAUTH_CALLBACK_PATH)
    if (context.oauth.preset === 'google-workspace') {
      const credentials = config.googleWorkspace
      if (!credentials?.clientId || !credentials.clientSecret) throw new AgentRepositoryError('EXTERNAL_MCP_OAUTH_NOT_CONFIGURED', 'The Google Workspace preset requires both configured client credentials', 503)
      metadata = { issuer: 'https://accounts.google.com', authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token', metadataClient: false, authMethods: ['client_secret_post'], requireResponseIssuer: false, resource: context.endpointUrl, scopes: googleService(context.endpointUrl).scopes }
      client = { clientId: credentials.clientId, clientSecret: credentials.clientSecret, authMethod: 'client_secret_post' }
    } else {
      metadata = await discoverOAuthServer(this.#dependencies, context.endpointUrl, context.oauth.issuer)
      if (context.oauth.registrationMode === 'preregistered') {
        if (!context.oauth.issuer || !context.oauth.clientId) return oauthFailure('Pre-registered clients require an explicit issuer and client ID')
        const secret = context.clientSecretReference ? await this.#dependencies.secrets.get(context.clientSecretReference, tx) : null
        const authMethod = context.oauth.tokenEndpointAuthMethod ?? (secret ? 'client_secret_basic' : 'none')
        if ((authMethod === 'none' && secret) || (authMethod !== 'none' && !secret) || !metadata.authMethods.includes(authMethod)) return oauthFailure('OAuth client authentication does not match the selected issuer')
        client = { clientId: context.oauth.clientId, authMethod, ...(secret ? { clientSecret: secret } : {}) }
      } else if (metadata.metadataClient) {
        if (!metadata.authMethods.includes('none')) return oauthFailure('Authorization server does not support public metadata clients')
        client = { clientId: this.clientMetadata().client_id, authMethod: 'none' }
      } else {
        if (!metadata.registrationEndpoint) return oauthFailure('This issuer requires a pre-registered client ID')
        const authMethod = context.oauth.tokenEndpointAuthMethod ?? (metadata.authMethods.includes('none') ? 'none' : metadata.authMethods.includes('client_secret_basic') ? 'client_secret_basic' : 'client_secret_post')
        if (!metadata.authMethods.includes(authMethod)) return oauthFailure('Unsupported token endpoint authentication method')
        const response = await oauthRequest(this.#dependencies, metadata.registrationEndpoint, { contentType: 'application/json', body: JSON.stringify({ client_name: 'tsEpistle external MCP', redirect_uris: [callbackUrl], application_type: 'web', token_endpoint_auth_method: authMethod, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...(context.oauth.scopes?.length ? { scope: context.oauth.scopes.join(' ') } : {}) }) })
        const registration = z.object({ client_id: z.string().min(1).max(2_048), client_secret: z.string().min(1).max(8_192).optional(), token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(), client_secret_expires_at: z.number().int().nonnegative().optional(), redirect_uris: z.array(z.string()).max(16).optional() }).safeParse(response.body)
        if (!response.ok || !registration.success || (registration.data.token_endpoint_auth_method && registration.data.token_endpoint_auth_method !== authMethod) || (authMethod !== 'none' && !registration.data.client_secret) || (registration.data.redirect_uris && !registration.data.redirect_uris.includes(callbackUrl))) return oauthFailure('OAuth client registration was rejected')
        client = { clientId: registration.data.client_id, authMethod, ...(registration.data.client_secret ? { clientSecret: registration.data.client_secret } : {}), ...(registration.data.client_secret_expires_at ? { expiresAt: registration.data.client_secret_expires_at * 1_000 } : {}) }
      }
    }
    await Promise.all([metadata.authorizationEndpoint, metadata.tokenEndpoint].map(url => validateExternalMcpDestination(url, this.#dependencies.resolve)))
    const binding: Binding = { ...metadata, configurationHash: fingerprint, callbackUrl, clientId: client.clientId, authMethod: client.authMethod, scopes: context.oauth.preset ? metadata.scopes : context.oauth.scopes ?? metadata.scopes }
    const secretReference = await this.#dependencies.secrets.store(JSON.stringify(client), context.credentialOwnerId, tx)
    await tx('agentExternalMcpOAuthRegistrations').insert({ serverId: context.serverId, configurationHash: registrationHash(context), binding: JSON.stringify(binding), secretReference })
    return { binding, client }
  }
  async connect(authorize: Authorize, sessionId: string): Promise<ExternalMcpOAuthConnectResult> {
    if (!sessionId || sessionId.length > 1_024) return invalid()
    return this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const { binding, client } = await this.#registration(tx, context)
      const old = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).first()
      if (old) await this.#remove(tx, old)
      const grant: Grant = { id: randomUUID(), userId: context.userId, serverId: context.serverId, serverRevision: context.serverRevision, authVersion: context.authVersion, authorizationStamp: context.authorizationStamp, secretReference: null, binding: JSON.stringify(binding) }
      await tx('agentExternalMcpOAuthGrants').insert(grant)
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
      const secretReference = await this.#dependencies.secrets.store(JSON.stringify({ verifier, client } satisfies PendingSecret), context.userId, tx)
      await tx('agentExternalMcpOAuthPending').insert({ stateHash: hash(state), grantId: grant.id, sessionHash: hash(sessionId), secretReference, expiresAt: new Date(Date.now() + 10 * 60_000) })
      const url = new URL(binding.authorizationEndpoint)
      for (const [key, value] of Object.entries({ client_id: client.clientId, redirect_uri: binding.callbackUrl, response_type: 'code', scope: binding.scopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: binding.resource, ...(context.oauth.preset ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' } : {}) })) url.searchParams.set(key, value)
      await validateExternalMcpDestination(url.href, this.#dependencies.resolve)
      return { authorizationUrl: url.href }
    })
  }
  async #exchange(binding: Binding, client: Client, parameters: URLSearchParams) {
    if (client.clientId !== binding.clientId || client.authMethod !== binding.authMethod || (client.expiresAt && client.expiresAt <= Date.now())) return reconnect()
    parameters.set('resource', binding.resource)
    parameters.set('client_id', client.clientId)
    let authorization: string | undefined
    if (client.authMethod !== 'none') {
      if (!client.clientSecret) return reconnect()
      if (client.authMethod === 'client_secret_post') parameters.set('client_secret', client.clientSecret)
      else {
        const encode = (value: string): string => new URLSearchParams({ v: value }).toString().slice(2)
        authorization = 'Basic ' + Buffer.from(encode(client.clientId) + ':' + encode(client.clientSecret)).toString('base64')
      }
    }
    return oauthRequest(this.#dependencies, binding.tokenEndpoint, { body: parameters.toString(), ...(authorization ? { authorization } : {}) })
  }
  async callback(input: ExternalMcpOAuthCallbackInput, authorize: (tx: Knex.Transaction, serverId: string) => Promise<ExternalMcpOAuthContext>): Promise<ExternalMcpOAuthCallbackStatus> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.state) || !input.sessionId) return 'error'
    const pending = await this.#dependencies.knex<Pending>('agentExternalMcpOAuthPending').where('stateHash', hash(input.state)).first()
    if (!pending || pending.sessionHash !== hash(input.sessionId)) return 'error'
    const candidate = await this.#dependencies.knex<Grant>('agentExternalMcpOAuthGrants').where('id', pending.grantId).first()
    if (!candidate) return 'error'
    return this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx, candidate.serverId)
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where('id', candidate.id).forUpdate().first()
      const state = await tx<Pending>('agentExternalMcpOAuthPending').where('stateHash', hash(input.state)).forUpdate().first()
      if (!grant || !state || state.grantId !== grant.id || !this.#matches(grant, context) || state.sessionHash !== hash(input.sessionId)) return 'error'
      const binding = this.#binding(grant)!
      if (new URL(binding.callbackUrl).pathname !== input.callbackPath || (binding.requireResponseIssuer && input.iss === undefined) || (input.iss !== undefined && input.iss !== binding.issuer)) return 'error'
      const value = await this.#dependencies.secrets.get(state.secretReference, tx)
      await this.#dependencies.secrets.delete(state.secretReference, tx)
      await tx('agentExternalMcpOAuthPending').where('stateHash', state.stateHash).delete()
      if (new Date(state.expiresAt).getTime() <= Date.now() || !value) return 'error'
      if (input.error) return input.error === 'access_denied' ? 'denied' : 'error'
      if (!input.code || input.code.length > 8_192 || input.code.includes('\0')) return 'error'
      try {
        const secret = JSON.parse(value) as PendingSecret
        const response = await this.#exchange(binding, secret.client, new URLSearchParams({ grant_type: 'authorization_code', code: input.code, code_verifier: secret.verifier, redirect_uri: binding.callbackUrl }))
        const parsed = TokenSchema.safeParse(response.body)
        if (!response.ok || !parsed.success) return 'error'
        const scopes = parsed.data.scope?.split(' ').filter(Boolean) ?? [...binding.scopes]
        if (!binding.scopes.every(scope => scopes.includes(scope))) return 'error'
        if (!this.#matches(grant, await authorize(tx, candidate.serverId))) return 'error'
        const token: StoredToken = { accessToken: parsed.data.access_token, ...(parsed.data.refresh_token ? { refreshToken: parsed.data.refresh_token } : {}), expiresAt: parsed.data.expires_in === undefined ? null : Date.now() + parsed.data.expires_in * 1_000, scopes }
        const secretReference = await this.#dependencies.secrets.store(JSON.stringify(token), context.userId, tx)
        await tx('agentExternalMcpOAuthGrants').where('id', grant.id).update({ secretReference })
        return 'connected'
      } catch { return 'error' }
    })
  }
  async binding(authorize: Authorize): Promise<string | null> {
    return this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).first()
      if (!grant || !grant.binding) return null
      if (!this.#matches(grant, context)) { await this.#remove(tx, grant, true); return null }
      const token = await this.#tokens(tx, grant), binding = this.#binding(grant)!
      if (!token || (token.expiresAt !== null && token.expiresAt <= Date.now() && !token.refreshToken) || !binding.scopes.every(scope => token.scopes.includes(scope))) return null
      return grant.id
    })
  }
  async accessToken(authorize: Authorize, bindingId: string): Promise<string> {
    const result = await this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).forUpdate().first()
      if (!grant || grant.id !== bindingId || !grant.binding) return null
      if (!this.#matches(grant, context)) { await this.#remove(tx, grant, true); return null }
      const token = await this.#tokens(tx, grant), binding = this.#binding(grant)!
      if (!token || !binding.scopes.every(scope => token.scopes.includes(scope))) { await this.#remove(tx, grant, true); return null }
      if (token.expiresAt === null || token.expiresAt > Date.now() + 60_000) return token.accessToken
      if (!token.refreshToken) { if (token.expiresAt > Date.now()) return token.accessToken; await this.#remove(tx, grant, true); return null }
      const registration = await tx<Registration>('agentExternalMcpOAuthRegistrations').where('serverId', context.serverId).first()
      if (!registration || registration.binding !== grant.binding) return null
      const value = await this.#dependencies.secrets.get(registration.secretReference, tx)
      if (!value) return null
      const response = await this.#exchange(binding, JSON.parse(value) as Client, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refreshToken }))
      const parsed = TokenSchema.safeParse(response.body)
      if (!response.ok || !parsed.success) {
        if (response.status === 400 || response.status === 401) await this.#remove(tx, grant, true)
        return null
      }
      if (!this.#matches(grant, await authorize(tx))) { await this.#remove(tx, grant, true); return null }
      const scopes = parsed.data.scope?.split(' ').filter(Boolean) ?? token.scopes
      if (!binding.scopes.every(scope => scopes.includes(scope))) { await this.#remove(tx, grant, true); return null }
      const updated: StoredToken = { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token ?? token.refreshToken, expiresAt: parsed.data.expires_in === undefined ? null : Date.now() + parsed.data.expires_in * 1_000, scopes }
      const secretReference = await this.#dependencies.secrets.store(JSON.stringify(updated), context.userId, tx)
      await tx('agentExternalMcpOAuthGrants').where('id', grant.id).update({ secretReference })
      await this.#dependencies.secrets.delete(grant.secretReference!, tx)
      return updated.accessToken
    })
    return result ?? reconnect()
  }
  async assertBinding(authorize: Authorize, binding: string): Promise<void> { if (await this.binding(authorize) !== binding) return reconnect() }
  async rejectBinding(authorize: Authorize, binding: string): Promise<never> {
    await this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).forUpdate().first()
      if (grant?.id === binding) await this.#remove(tx, grant, true)
    })
    return reconnect()
  }
  async disconnect(authorize: Authorize): Promise<void> {
    // Local authority only: provider revocation can revoke sibling endpoints' grants.
    await this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).forUpdate().first()
      if (grant) await this.#remove(tx, grant)
    })
  }
}
