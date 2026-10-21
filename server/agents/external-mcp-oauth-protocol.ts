import { z } from 'zod'
import { createExternalMcpEndpointGuard, normalizeExternalMcpEndpoint, validateExternalMcpDestination, type ExternalMcpServiceDependencies } from './external-mcp.ts'
import { AgentRepositoryError } from './repository.ts'

const strings = z.array(z.string().min(1).max(2_048)).max(64)
const scopeList = z.array(z.string().min(1).max(2_048).regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/u)).max(64)
const ResourceSchema = z.object({ resource: z.string().max(2_048), authorization_servers: strings.min(1), scopes_supported: scopeList.optional() })
const AuthorizationSchema = z.object({
  issuer: z.string().max(2_048), authorization_endpoint: z.string().max(2_048), token_endpoint: z.string().max(2_048),
  registration_endpoint: z.string().max(2_048).optional(), client_id_metadata_document_supported: z.boolean().optional(),
  token_endpoint_auth_methods_supported: strings.optional(), code_challenge_methods_supported: strings.optional(),
  response_types_supported: strings.optional(), grant_types_supported: strings.optional(), authorization_response_iss_parameter_supported: z.boolean().optional()
})
export interface OAuthServerMetadata {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly registrationEndpoint?: string
  readonly metadataClient: boolean
  readonly authMethods: readonly string[]
  readonly requireResponseIssuer: boolean
  readonly resource: string
  readonly scopes: readonly string[]
}
export interface OAuthHttpResponse { readonly ok: boolean; readonly status: number; readonly body: unknown; readonly challenge: string | null }
export const oauthFailure = (message = 'OAuth discovery failed; verify the issuer and client configuration'): never => {
  throw new AgentRepositoryError('EXTERNAL_MCP_OAUTH_DISCOVERY_FAILED', message, 400)
}
/** All discovery is credential-free. Each exact destination gets a fresh pinned socket boundary. */
export const oauthRequest = async (dependencies: ExternalMcpServiceDependencies, url: string, options: { body?: string; contentType?: string; authorization?: string; probe?: boolean } = {}): Promise<OAuthHttpResponse> => {
  const guard = createExternalMcpEndpointGuard({ endpointUrl: url, allowQuery: true, authorize: async () => {}, credential: async () => null,
    ...(options.authorization ? { authorization: options.authorization } : {}),
    ...(dependencies.resolve ? { resolve: dependencies.resolve } : {}), ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) })
  try {
    const response = await guard.fetch(url, { method: options.body === undefined ? 'GET' : 'POST', headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': options.contentType ?? 'application/x-www-form-urlencoded' }) }, ...(options.body === undefined ? {} : { body: options.body }) })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0, count = 0
    if (reader) try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > 65_536 || ++count > 1_024) { await reader.cancel(); return oauthFailure('OAuth response exceeds its limit') }
        chunks.push(next.value)
      }
    } finally { reader.releaseLock() }
    let body: unknown = null
    if (bytes && !options.probe) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return oauthFailure('Invalid OAuth metadata response') }
    }
    const challenge = response.headers.get('www-authenticate')
    if (challenge && challenge.length > 8_192) return oauthFailure('OAuth challenge exceeds its limit')
    return { ok: response.ok, status: response.status, body, challenge }
  } catch (error) {
    if (error instanceof AgentRepositoryError) throw error
    throw new AgentRepositoryError('EXTERNAL_MCP_OAUTH_UNAVAILABLE', 'External authorization service is unavailable', 502)
  } finally { await guard.close() }
}
const resourceContains = (resource: string, endpoint: string): boolean => {
  const base = new URL(resource), target = new URL(endpoint)
  const path = base.pathname.replace(/\/$/u, '')
  return base.origin === target.origin && (target.pathname === path || target.pathname.startsWith(path + '/'))
}
export const discoverOAuthServer = async (dependencies: ExternalMcpServiceDependencies, endpoint: string, selectedIssuer?: string): Promise<OAuthServerMetadata> => {
  const target = new URL(endpoint)
  let probe = await oauthRequest(dependencies, endpoint, { probe: true })
  if (!probe.challenge && [401, 405].includes(probe.status)) {
    probe = await oauthRequest(dependencies, endpoint, { probe: true, contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: 'oauth-discovery', method: 'server/discover', params: {} }) })
  }
  // A supplied RFC9728 challenge takes precedence; an invalid supplied URL fails closed.
  const challenge = probe.challenge ?? ''
  const matches = [...challenge.matchAll(/\bresource_metadata\s*=\s*"((?:[^"\\]|\\[\x20-\x7e])*)"/giu)]
  if (matches.length > 1 || [...challenge.matchAll(/\bresource_metadata\s*=/giu)].length !== matches.length) return oauthFailure('Invalid or ambiguous protected resource metadata challenge')
  const supplied = matches[0]?.[1]?.replace(/\\([\x20-\x7e])/gu, '$1')
  if (supplied === '') return oauthFailure('Invalid protected resource metadata challenge')
  const challengeScope = /\bscope\s*=\s*"((?:[^"\\]|\\[\x20-\x7e])*)"/iu.exec(challenge)?.[1]?.replace(/\\([\x20-\x7e])/gu, '$1')
  const parsedScopes = challengeScope === undefined ? undefined : scopeList.safeParse(challengeScope.split(' ').filter(Boolean))
  if (parsedScopes && !parsedScopes.success) return oauthFailure('Invalid OAuth challenge scopes')
  const requestedScopes = parsedScopes?.success ? parsedScopes.data : undefined
  const paths = supplied ? [normalizeExternalMcpEndpoint(supplied, true)] : [...new Set([
    target.origin + '/.well-known/oauth-protected-resource' + (target.pathname === '/' ? '' : target.pathname),
    target.origin + '/.well-known/oauth-protected-resource'
  ])]
  let resource: z.infer<typeof ResourceSchema> | undefined
  for (const path of paths) {
    const response = await oauthRequest(dependencies, path)
    if (!response.ok) { if (supplied || ![404, 405].includes(response.status)) return oauthFailure(); continue }
    const parsed = ResourceSchema.safeParse(response.body)
    if (!parsed.success) return oauthFailure()
    resource = parsed.data
    break
  }
  if (!resource) return oauthFailure('The MCP server did not publish protected resource metadata')
  normalizeExternalMcpEndpoint(resource.resource)
  // This is an OAuth audience identifier: do not invent a trailing slash.
  const canonicalResource = resource.resource
  if (!resourceContains(canonicalResource, endpoint)) return oauthFailure('Protected resource metadata does not match this MCP endpoint')
  for (const issuer of resource.authorization_servers) {
    normalizeExternalMcpEndpoint(issuer)
    if (new URL(issuer).search) return oauthFailure()
  }
  const issuer = selectedIssuer ?? resource.authorization_servers[0]!
  normalizeExternalMcpEndpoint(issuer)
  if (!resource.authorization_servers.includes(issuer)) return oauthFailure('Selected issuer is not advertised by this MCP endpoint')
  const base = new URL(issuer)
  const issuerPath = base.pathname.replace(/\/$/u, '')
  const candidates = [...new Set([
    base.origin + '/.well-known/oauth-authorization-server' + issuerPath,
    base.origin + '/.well-known/openid-configuration' + issuerPath,
    issuer.replace(/\/$/u, '') + '/.well-known/openid-configuration'
  ])]
  for (const candidate of candidates) {
    const response = await oauthRequest(dependencies, candidate)
    if (!response.ok) { if (![404, 405].includes(response.status)) return oauthFailure(); continue }
    const parsed = AuthorizationSchema.safeParse(response.body)
    if (!parsed.success || parsed.data.issuer !== issuer) return oauthFailure('Authorization server issuer does not match selected issuer')
    const metadata = parsed.data
    if (!metadata.code_challenge_methods_supported?.includes('S256') || (metadata.response_types_supported && !metadata.response_types_supported.includes('code')) || (metadata.grant_types_supported && !metadata.grant_types_supported.includes('authorization_code'))) return oauthFailure('Authorization server must support authorization code with PKCE S256')
    await Promise.all([metadata.authorization_endpoint, metadata.token_endpoint, ...(metadata.registration_endpoint ? [metadata.registration_endpoint] : [])].map(url => validateExternalMcpDestination(url, dependencies.resolve)))
    return { issuer, authorizationEndpoint: metadata.authorization_endpoint, tokenEndpoint: metadata.token_endpoint,
      ...(metadata.registration_endpoint ? { registrationEndpoint: metadata.registration_endpoint } : {}), metadataClient: metadata.client_id_metadata_document_supported === true,
      authMethods: metadata.token_endpoint_auth_methods_supported ?? ['client_secret_basic'], requireResponseIssuer: metadata.authorization_response_iss_parameter_supported === true,
      resource: canonicalResource, scopes: requestedScopes ?? resource.scopes_supported ?? [] }
  }
  return oauthFailure('Authorization server metadata is unavailable')
}
