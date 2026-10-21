import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import { GOOGLE_WORKSPACE_MCP_SERVICES, type ExternalMcpOAuthView } from '../../shared/agents/external-mcp.ts'
import { createExternalMcpEndpointGuard, type ExternalMcpServiceDependencies } from './external-mcp.ts'
import { AgentRepositoryError } from './repository.ts'

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_WORKSPACE_CALLBACK_PATH = '/agents/oauth/google/callback'
export const GOOGLE_WORKSPACE_RETURN_PATH = '/p/profile'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const invalid = (): never => { throw new AgentRepositoryError('GOOGLE_MCP_OAUTH_INVALID', 'Google authorization expired or is invalid; connect again', 400) }
const reconnect = (): never => { throw new AgentRepositoryError('GOOGLE_MCP_RECONNECT_REQUIRED', 'Connect this Google Workspace endpoint again', 409) }
const TokenSchema = z.object({
  access_token: z.string().regex(/^[\x21-\x7e]{1,8192}$/u),
  refresh_token: z.string().regex(/^[\x21-\x7e]{1,8192}$/u).optional(),
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(31_536_000),
  scope: z.string().max(16_384).optional()
})
const StoredTokenSchema = z.object({ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number(), scopes: z.array(z.string()) })
type StoredToken = z.infer<typeof StoredTokenSchema>
interface Grant {
  id: string
  userId: number
  serverId: string
  serverRevision: number
  authVersion: number
  authorizationStamp: string
  secretReference: string | null
}
interface Pending { stateHash: string; grantId: string; sessionHash: string; secretReference: string; expiresAt: Date | string | number }
export interface GoogleWorkspaceOAuthConfiguration { readonly clientId: string; readonly clientSecret: string; readonly siteOrigin: string }
export interface GoogleWorkspaceOAuthContext {
  readonly userId: number
  readonly serverId: string
  readonly serverRevision: number
  readonly authVersion: number
  readonly authorizationStamp: string
  readonly endpointUrl: string
}
type Authorize = (tx: Knex.Transaction) => Promise<GoogleWorkspaceOAuthContext>

export const googleWorkspaceService = (endpointUrl: string) => {
  const service = GOOGLE_WORKSPACE_MCP_SERVICES.find(entry => entry.endpointUrl === endpointUrl)
  if (!service) throw new AgentRepositoryError('GOOGLE_MCP_INVALID_ENDPOINT', 'Choose an official Google Workspace MCP endpoint', 400)
  return service
}

/** The host owns browser consent and durable transaction boundaries, not an in-flight SDK callback. */
export class GoogleWorkspaceOAuthService {
  readonly #dependencies: ExternalMcpServiceDependencies
  readonly #configuration: GoogleWorkspaceOAuthConfiguration | undefined
  constructor(dependencies: ExternalMcpServiceDependencies) {
    this.#dependencies = dependencies
    const config = dependencies.googleOAuth
    if (config) {
      const origin = new URL(config.siteOrigin)
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/')
        throw new Error('Google Workspace OAuth requires a canonical HTTPS site origin')
      if (!config.clientId.trim() || !config.clientSecret.trim()) throw new Error('Google Workspace OAuth requires both client credentials')
      this.#configuration = { ...config, siteOrigin: origin.origin }
    }
  }
  #config(): GoogleWorkspaceOAuthConfiguration {
    if (!this.#configuration) throw new AgentRepositoryError('GOOGLE_MCP_NOT_CONFIGURED', 'Google Workspace connections are not configured', 503)
    return this.#configuration
  }
  #matches(grant: Grant, context: GoogleWorkspaceOAuthContext): boolean {
    return grant.userId === context.userId && grant.serverId === context.serverId && grant.serverRevision === context.serverRevision &&
      grant.authVersion === context.authVersion && grant.authorizationStamp === context.authorizationStamp
  }
  async #request(url: typeof TOKEN_URL, parameters: URLSearchParams): Promise<{ ok: boolean; body: unknown }> {
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: url, authorize: async () => {}, credential: async () => null,
      ...(this.#dependencies.resolve ? { resolve: this.#dependencies.resolve } : {}),
      ...(this.#dependencies.fetch ? { fetch: this.#dependencies.fetch } : {})
    })
    try {
      const response = await guard.fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: parameters.toString() })
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) {
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > 65_536) { await reader.cancel(); throw new Error('OAuth response limit') }
            chunks.push(next.value)
          }
        } finally { reader.releaseLock() }
      }
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown = null
      if (text) { try { body = JSON.parse(text) } catch { throw new Error('Invalid OAuth response') } }
      return { ok: response.ok, body }
    } catch {
      throw new AgentRepositoryError('GOOGLE_MCP_OAUTH_UNAVAILABLE', 'Google authorization service is unavailable', 502)
    } finally { await guard.close() }
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
  async invalidateEndpoint(tx: Knex.Transaction, serverId: string): Promise<void> {
    const grants = await tx<Grant>('agentExternalMcpOAuthGrants').where('serverId', serverId).select('*')
    for (const grant of grants) await this.#remove(tx, grant)
  }
  async status(authorize: Authorize): Promise<ExternalMcpOAuthView> {
    return this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const scopes = googleWorkspaceService(context.endpointUrl).scopes
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).first()
      const connected = Boolean(grant && this.#matches(grant, context) && await this.#tokens(tx, grant))
      if (grant && !this.#matches(grant, context)) await this.#remove(tx, grant, true)
      return { configured: Boolean(this.#configuration), connected, scopes, reconnectRequired: Boolean(grant && !connected) }
    })
  }
  async connect(authorize: Authorize, sessionId: string): Promise<{ authorizationUrl: string }> {
    const config = this.#config()
    if (!sessionId || sessionId.length > 1_024) return invalid()
    return this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const service = googleWorkspaceService(context.endpointUrl)
      const old = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).first()
      if (old) await this.#remove(tx, old)
      const grant: Grant = { id: randomUUID(), userId: context.userId, serverId: context.serverId, serverRevision: context.serverRevision,
        authVersion: context.authVersion, authorizationStamp: context.authorizationStamp, secretReference: null }
      await tx('agentExternalMcpOAuthGrants').insert(grant)
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
      const secretReference = await this.#dependencies.secrets.store(verifier, context.userId, tx)
      await tx('agentExternalMcpOAuthPending').insert({ stateHash: hash(state), grantId: grant.id, sessionHash: hash(sessionId), secretReference, expiresAt: new Date(Date.now() + 10 * 60_000) })
      const url = new URL(AUTHORIZATION_URL)
      url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.siteOrigin + GOOGLE_WORKSPACE_CALLBACK_PATH,
        response_type: 'code', scope: service.scopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' }).toString()
      return { authorizationUrl: url.href }
    })
  }
  async callback(input: { state: string; code?: string; error?: string; iss?: string; sessionId: string }, authorize: (tx: Knex.Transaction, serverId: string) => Promise<GoogleWorkspaceOAuthContext>): Promise<'connected' | 'denied' | 'error'> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.state) || !input.sessionId || (input.iss !== undefined && input.iss !== 'https://accounts.google.com')) return 'error'
    const config = this.#config()
    // Find the owner/endpoint without locking; every mutation locks user then endpoint then grant.
    const pending = await this.#dependencies.knex<Pending>('agentExternalMcpOAuthPending').where('stateHash', hash(input.state)).first()
    if (!pending || pending.sessionHash !== hash(input.sessionId)) return 'error'
    const candidate = await this.#dependencies.knex<Grant>('agentExternalMcpOAuthGrants').where('id', pending.grantId).first()
    if (!candidate) return 'error'
    return this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx, candidate.serverId)
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where('id', candidate.id).forUpdate().first()
      const state = await tx<Pending>('agentExternalMcpOAuthPending').where('stateHash', hash(input.state)).forUpdate().first()
      if (!grant || !state || state.grantId !== grant.id || !this.#matches(grant, context) || state.sessionHash !== hash(input.sessionId)) return 'error'
      const verifier = await this.#dependencies.secrets.get(state.secretReference, tx)
      await this.#dependencies.secrets.delete(state.secretReference, tx)
      await tx('agentExternalMcpOAuthPending').where('stateHash', state.stateHash).delete()
      if (new Date(state.expiresAt).getTime() <= Date.now() || !verifier) return 'error'
      if (input.error) return input.error === 'access_denied' ? 'denied' : 'error'
      if (!input.code || input.code.length > 8_192 || input.code.includes('\0')) return 'error'
      try {
        const response = await this.#request(TOKEN_URL, new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
          grant_type: 'authorization_code', code: input.code, code_verifier: verifier, redirect_uri: config.siteOrigin + GOOGLE_WORKSPACE_CALLBACK_PATH }))
        const parsed = TokenSchema.safeParse(response.body)
        if (!response.ok || !parsed.success || !parsed.data.refresh_token) return 'error'
        const scopes = parsed.data.scope?.split(' ').filter(Boolean) ?? googleWorkspaceService(context.endpointUrl).scopes
        if (!googleWorkspaceService(context.endpointUrl).scopes.every(scope => scopes.includes(scope))) return 'error'
        // Recheck permissions after remote I/O; row locks serialize endpoint/disconnect and user deletion.
        const current = await authorize(tx, candidate.serverId)
        if (!this.#matches(grant, current)) return 'error'
        const token: StoredToken = { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token, expiresAt: Date.now() + parsed.data.expires_in * 1_000, scopes }
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
      if (!grant) return null
      if (!this.#matches(grant, context)) { await this.#remove(tx, grant, true); return null }
      if (!grant.secretReference || !(await this.#dependencies.secrets.has(grant.secretReference, tx))) return null
      return grant.id
    })
  }
  async accessToken(authorize: Authorize, binding: string): Promise<string> {
    const result = await this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).forUpdate().first()
      if (!grant || grant.id !== binding) return null
      if (!this.#matches(grant, context)) { await this.#remove(tx, grant, true); return null }
      const token = await this.#tokens(tx, grant)
      if (!token) return null
      if (token.expiresAt > Date.now() + 60_000) return token.accessToken
      const config = this.#config()
      const response = await this.#request(TOKEN_URL, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refreshToken,
        client_id: config.clientId, client_secret: config.clientSecret }))
      const parsed = TokenSchema.safeParse(response.body)
      if (!response.ok || !parsed.success) {
        if (typeof response.body === 'object' && response.body !== null && Reflect.get(response.body, 'error') === 'invalid_grant') await this.#remove(tx, grant, true)
        return null
      }
      const current = await authorize(tx)
      if (!this.#matches(grant, current)) { await this.#remove(tx, grant, true); return null }
      const scopes = parsed.data.scope?.split(' ').filter(Boolean) ?? token.scopes
      if (!googleWorkspaceService(context.endpointUrl).scopes.every(scope => scopes.includes(scope))) { await this.#remove(tx, grant, true); return null }
      const updated: StoredToken = { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token ?? token.refreshToken,
        expiresAt: Date.now() + parsed.data.expires_in * 1_000, scopes }
      const secretReference = await this.#dependencies.secrets.store(JSON.stringify(updated), context.userId, tx)
      await tx('agentExternalMcpOAuthGrants').where('id', grant.id).update({ secretReference })
      await this.#dependencies.secrets.delete(grant.secretReference!, tx)
      return updated.accessToken
    })
    return result ?? reconnect()
  }
  async assertBinding(authorize: Authorize, binding: string): Promise<void> {
    if (await this.binding(authorize) !== binding) return reconnect()
  }
  async rejectBinding(authorize: Authorize, binding: string): Promise<never> {
    await this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).forUpdate().first()
      if (grant?.id === binding) await this.#remove(tx, grant, true)
    })
    return reconnect()
  }
  async disconnect(authorize: Authorize): Promise<void> {
    // Google revokes the project-wide grant, not this endpoint alone. Disconnect only local authority.
    await this.#dependencies.knex.transaction(async tx => {
      const context = await authorize(tx)
      const grant = await tx<Grant>('agentExternalMcpOAuthGrants').where({ userId: context.userId, serverId: context.serverId }).forUpdate().first()
      if (!grant) return
      await this.#remove(tx, grant)
    })
  }
}
