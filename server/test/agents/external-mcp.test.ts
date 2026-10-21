import { createHash, randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { AxMCPClient } from '@ax-llm/ax'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import {
  ExternalMcpService,
  createExternalMcpEndpointGuard,
  normalizeExternalMcpEndpoint,
  EXTERNAL_MCP_LIMITS,
  type ExternalMcpFetchImplementation,
  type ExternalMcpLease
} from '../../agents/external-mcp.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { ExternalMcpEngineContext } from '../../agents/providers/external-mcp-engine.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import { withAgentSourceAuthorization } from '../../agents/source-authorization.ts'
import { up } from '../../db/migrations/tsepistle-000050-agent-external-mcp.ts'

import { up as addGoogleOAuth } from '../../db/migrations/tsepistle-000063-google-workspace-mcp-oauth.ts'
import { up as addGenericOAuth } from '../../db/migrations/tsepistle-000064-generic-mcp-oauth.ts'
import { up as retireOAuthPresets } from '../../db/migrations/tsepistle-000065-retire-mcp-oauth-presets.ts'
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }]
const admin = { id: 1, authVersion: 0 },
  owner = { id: 7, authVersion: 0 },
  other = { id: 8, authVersion: 0 }
const input = () => ({
  displayName: 'External research',
  endpointUrl: `https://mcp.example.com/${randomUUID()}`,
  status: 'enabled' as const,
  authMode: 'none' as const
})

// This is a credential-free remote protocol fixture, not an Ax client mock.
interface ProtocolFixture {
  readonly calls: { method: string; headers: Headers; params?: unknown }[]
  readonly fetch: ExternalMcpFetchImplementation
  setToolCount(count: number): void
  setTaskStatus(status: 'working' | 'completed'): void
}
const protocolFixture = (era: 'legacy' | 'modern' = 'modern', tasks = false): ProtocolFixture => {
  const calls: { method: string; headers: Headers; params?: unknown }[] = []
  let toolCount = 1
  let taskStatus: 'working' | 'completed' = 'working'
  const task = {
    taskId: 'owned-task',
    status: 'working',
    createdAt: '2026-08-17T00:00:00Z',
    lastUpdatedAt: '2026-08-17T00:00:00Z',
    ttl: 30_000,
    ttlMs: 30_000,
    pollInterval: 1,
    pollIntervalMs: 1
  }
  const fetch: ExternalMcpFetchImplementation = async (_url, init) => {
    if (init.method === 'DELETE') {
      calls.push({ method: 'session/terminate', headers: new Headers(init.headers) })
      return new Response(null, { status: 204 })
    }
    const message = JSON.parse(String(init.body)) as { id?: string; method: string; params?: unknown }
    calls.push({ method: message.method, headers: new Headers(init.headers), params: message.params })
    if (!message.id) return new Response(null, { status: 202 })
    if (message.method === 'server/discover' && era === 'legacy')
      return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    let result: unknown
    switch (message.method) {
      case 'server/discover':
        result = {
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {}, prompts: {}, resources: {}, ...(tasks ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {}) },
          ttlMs: 0,
          cacheScope: 'private'
        }
        break
      case 'initialize':
        result = {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {}, prompts: {}, resources: {}, ...(tasks ? { tasks: { requests: { tools: { call: {} } } } } : {}) },
          serverInfo: { name: 'Untrusted research', version: '1' }
        }
        break
      case 'tools/list':
        result = {
          resultType: 'complete',
          tools: Array.from({ length: toolCount }, (_, index) => ({
            name: index === 0 ? 'web_search' : `tool_${index}`,
            description: 'Public web search',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            ...(tasks && era === 'legacy' ? { execution: { taskSupport: 'required' } } : {})
          })),
          ttlMs: 0,
          cacheScope: 'private'
        }
        break
      case 'prompts/list':
        result = { resultType: 'complete', prompts: [{ name: 'research', description: 'Untrusted prompt' }], ttlMs: 0, cacheScope: 'private' }
        break
      case 'resources/list':
        result = {
          resultType: 'complete',
          resources: [{ uri: 'https://research.example.com/document', name: 'External document' }],
          ttlMs: 0,
          cacheScope: 'private'
        }
        break
      case 'resources/templates/list':
        result = { resultType: 'complete', resourceTemplates: [], ttlMs: 0, cacheScope: 'private' }
        break
      case 'tools/call':
        if (tasks) {
          result = era === 'legacy' ? { task } : { ...task, resultType: 'task' }
          break
        }
        result = {
          resultType: 'complete',
          content: [
            { type: 'text', text: 'External claim, not Wiki evidence' },
            { type: 'image', mimeType: 'image/png', data: 'AA==' }
          ],
          structuredContent: { source: 'external', result: ['https://research.example.com/document'] }
        }
        break
      case 'tasks/get':
        result = { ...task, status: taskStatus }
        break
      case 'tasks/result':
        result = {
          content: [
            { type: 'text', text: 'Final task result' },
            { type: 'image', mimeType: 'image/png', data: 'AA==' }
          ]
        }
        break
      case 'tasks/cancel':
        result = { ...task, status: 'cancelled' }
        break
      default:
        throw new Error(`Unexpected protocol method ${message.method}`)
    }
    return Response.json(
      { jsonrpc: '2.0', id: message.id, result },
      { headers: message.method === 'initialize' ? { 'mcp-session-id': 'credential-free-test-session' } : {} }
    )
  }
  return {
    calls,
    fetch,
    setTaskStatus: status => {
      taskStatus = status
    },
    setToolCount: (count: number) => {
      toolCount = count
    }
  }
}

describe('external MCP owner-scoped native clients', () => {
  let db: Knex, service: ExternalMcpService, vault: DatabaseAgentSecretRegistry
  let protocol: ProtocolFixture, enabled: boolean
  const leases: ExternalMcpLease[] = []
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.text('permissions').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').notNullable()
      table.integer('groupId').notNullable()
      table.primary(['userId', 'groupId'])
    })
    await db.schema.createTable('agentProviderSecrets', table => {
      table.uuid('id').primary()
      table.string('keyId').notNullable()
      table.string('algorithm').notNullable()
      table.binary('nonce').notNullable()
      table.binary('ciphertext').notNullable()
      table.binary('authTag').notNullable()
      table.integer('createdBy').notNullable()
      table.timestamp('createdAt').notNullable()
    })
    await up(db)
    await addGoogleOAuth(db)
    await addGenericOAuth(db)
    await retireOAuthPresets(db)
    await db('users').insert([1, 7, 8, 9].map(id => ({ id, isActive: true, authVersion: 0 })))
    await db('groups').insert([
      { id: 10, permissions: JSON.stringify(['manage:system']) },
      { id: 20, permissions: JSON.stringify(['use:agents']) },
      { id: 30, permissions: JSON.stringify(['use:agents']) }
    ])
    await db('userGroups').insert([
      { userId: 1, groupId: 10 },
      { userId: 7, groupId: 20 },
      { userId: 8, groupId: 30 },
      { userId: 9, groupId: 20 }
    ])
    vault = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'test', keys: { test: Buffer.alloc(32, 7) } })
    protocol = protocolFixture()
    enabled = true
    service = new ExternalMcpService({ knex: db, secrets: vault, enabled: () => enabled, resolve: publicResolver, fetch: (...args) => protocol.fetch(...args) })
  })
  afterEach(async () => {
    await Promise.all(leases.splice(0).map(lease => lease.close()))
    await db.destroy()
  })
  const genericFixture = (options: { registration?: 'manual' | 'metadata' | 'dynamic'; method?: 'none' | 'client_secret_post' | 'client_secret_basic'; discovery?: 'header' | 'post' | 'path' | 'root'; oidc?: boolean; requireIssuer?: boolean; noExpiry?: boolean; noRefresh?: boolean; expiresIn?: number; refreshError?: boolean } = {}) => {
    const endpointUrl = 'https://mcp.vendor.test/api/mcp', issuer = 'https://identity.vendor.test/tenant'
    const calls: { url: string; headers: Headers; body: string | undefined }[] = []
    const tokenCalls: { url: string; body: URLSearchParams }[] = []
    const network = { privateDns: false, tokenFailure: undefined as 'redirect' | 'oversized' | undefined }
    const metadata = {
      issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: [options.method ?? 'none'],
      authorization_response_iss_parameter_supported: options.requireIssuer ?? true,
      ...(options.registration === 'metadata' ? { client_id_metadata_document_supported: true } : {}),
      ...(['metadata', 'dynamic'].includes(options.registration ?? '') ? { registration_endpoint: issuer + '/register' } : {})
    }
    const resource = { resource: endpointUrl, authorization_servers: [issuer], scopes_supported: ['vendor.read'] }
    const tokenResponse = { access_token: 'vendor-access-token', token_type: 'Bearer', scope: 'vendor.read', ...(options.noExpiry ? {} : { expires_in: options.expiresIn ?? 3_600 }), ...(options.noRefresh ? {} : { refresh_token: 'vendor-refresh-token' }) }
    const dependencies = {
      knex: db, secrets: vault, enabled: () => enabled, resolve: async () => network.privateDns ? [{ address: '127.0.0.1', family: 4 }] : publicResolver(), oauth: { siteOrigin: 'https://wiki.example.test' },
      fetch: async (url: URL, init: Parameters<ExternalMcpFetchImplementation>[1]) => {
        const headers = new Headers(init.headers)
        calls.push({ url: url.href, headers, body: init.body == null ? undefined : String(init.body) })
        if (url.href === endpointUrl) {
          if (headers.has('authorization')) return protocol.fetch(url, init)
          if (options.discovery === 'post' && init.method === 'GET') return new Response(null, { status: 405 })
          return new Response(null, { status: 401, headers: ['path', 'root'].includes(options.discovery ?? '') ? {} : { 'www-authenticate': 'Bearer resource_metadata="https://mcp.vendor.test/protected-metadata"' } })
        }
        if (url.href === 'https://mcp.vendor.test/protected-metadata' ||
          (options.discovery === 'path' && url.href === 'https://mcp.vendor.test/.well-known/oauth-protected-resource/api/mcp') ||
          (options.discovery === 'root' && url.href === 'https://mcp.vendor.test/.well-known/oauth-protected-resource')) return Response.json(resource)
        if (url.href === 'https://identity.vendor.test/.well-known/oauth-authorization-server/tenant' && !options.oidc) return Response.json(metadata)
        if (url.href === issuer + '/.well-known/openid-configuration' && options.oidc) return Response.json(metadata)
        if (url.href === issuer + '/register') return Response.json({ client_id: 'dynamic-client', ...(options.method && options.method !== 'none' ? { client_secret: 'dynamic-secret' } : {}), token_endpoint_auth_method: options.method ?? 'none' })
        if (url.href === issuer + '/token') {
          const body = new URLSearchParams(String(init.body))
          tokenCalls.push({ url: url.href, body })
          expect(init.redirect).toBe('manual')
          if (network.tokenFailure === 'redirect') return Response.redirect('https://attacker.example/steal', 302)
          if (network.tokenFailure === 'oversized') return new Response('x'.repeat(65_537))
          if (body.get('grant_type') === 'refresh_token' && options.refreshError) return Response.json({ error: 'invalid_grant' }, { status: 400 })
          return Response.json({ ...tokenResponse, ...(body.get('grant_type') === 'refresh_token' ? { access_token: 'refreshed-vendor-token' } : {}) })
        }
        return new Response(null, { status: 404 })
      }
    }
    service = new ExternalMcpService(dependencies)
    const configuration = { ...input(), endpointUrl, authMode: 'oauth' as const, oauth: {
      registrationMode: options.registration === 'manual' || options.registration === undefined ? 'preregistered' as const : 'automatic' as const,
      ...(options.registration === 'manual' || options.registration === undefined ? { issuer, clientId: 'manual-client', tokenEndpointAuthMethod: options.method ?? 'none', ...(options.method && options.method !== 'none' ? { clientSecretValue: 'manual-secret' } : {}) } : {})
    }, groupIds: [20] }
    return { calls, tokenCalls, network, issuer, metadata, resource, tokenResponse, configuration, restart: () => { service = new ExternalMcpService(dependencies) } }
  }

  it.each(['none', 'client_secret_post', 'client_secret_basic'] as const)('runs generic %s clients through PKCE, durable callback and native MCP', async method => {
    const fixture = genericFixture({ method })
    fixture.metadata.client_id_metadata_document_supported = true
    fixture.metadata.registration_endpoint = fixture.issuer + '/register'
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    expect(endpoint.oauth?.clientSecretConfigured).toBe(method !== 'none')
    const authorization = new URL((await service.connectOAuth(owner, endpoint.id, 'generic-browser')).authorizationUrl)
    expect(authorization.origin + authorization.pathname).toBe(fixture.issuer + '/authorize')
    expect(authorization.searchParams.get('resource')).toBe(endpoint.endpointUrl)
    fixture.restart()
    const callback = { state: authorization.searchParams.get('state')!, code: 'vendor-code', iss: fixture.issuer, sessionId: 'generic-browser', callbackPath: '/agents/oauth/callback' }
    expect(await service.oauthCallback(owner, { ...callback, callbackPath: '/agents/oauth/other/callback' })).toBe('error')
    expect(await service.oauthCallback(owner, callback)).toBe('connected')
    const exchange = fixture.calls.find(call => call.url.endsWith('/token'))!
    const parameters = new URLSearchParams(exchange.body)
    expect(parameters.get('resource')).toBe(endpoint.endpointUrl)
    expect(parameters.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/u)
    expect(parameters.get('client_secret')).toBe(method === 'client_secret_post' ? 'manual-secret' : null)
    expect(exchange.headers.get('authorization')).toBe(method === 'client_secret_basic' ? 'Basic ' + Buffer.from('manual-client:manual-secret').toString('base64') : null)
    expect(fixture.calls.filter(call => !call.url.endsWith('/token')).every(call => !call.headers.has('authorization') && !call.body?.includes('manual-secret'))).toBe(true)
    expect((await service.discoverForUser(owner, endpoint.id)).catalog.tools[0]?.name).toBe('web_search')
    expect(protocol.calls.every(call => call.headers.get('authorization') === 'Bearer vendor-access-token')).toBe(true)
  })

  it('preserves the advertised root resource audience in authorization and token requests', async () => {
    const fixture = genericFixture()
    fixture.resource.resource = 'https://mcp.vendor.test'
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    const authorization = new URL((await service.connectOAuth(owner, endpoint.id, 'root-resource')).authorizationUrl)
    expect(authorization.searchParams.get('resource')).toBe('https://mcp.vendor.test')
    expect(await service.oauthCallback(owner, {
      state: authorization.searchParams.get('state')!, code: 'vendor-code', iss: fixture.issuer,
      sessionId: 'root-resource', callbackPath: '/agents/oauth/callback'
    })).toBe('connected')
    const exchange = fixture.calls.find(call => call.url.endsWith('/token'))!
    expect(new URLSearchParams(exchange.body).get('resource')).toBe('https://mcp.vendor.test')
  })

  it.each([
    { registration: 'metadata' as const, discovery: 'post' as const, oidc: false },
    { registration: 'dynamic' as const, discovery: 'path' as const, oidc: false },
    { registration: 'dynamic' as const, discovery: 'root' as const, oidc: true }
  ])('discovers and persists $registration clients using $discovery protected-resource metadata', async options => {
    const fixture = genericFixture(options)
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    expect(await service.oauthStatus(owner, endpoint.id)).toMatchObject({ configured: true, connected: false })
    expect(await db('agentExternalMcpOAuthRegistrations')).toEqual([])
    const authorization = new URL((await service.connectOAuth(owner, endpoint.id, 'automatic')).authorizationUrl)
    if (options.registration === 'metadata') expect(authorization.searchParams.get('client_id')).toBe('https://wiki.example.test/agents/oauth/client-metadata')
    else {
      expect(authorization.searchParams.get('client_id')).toBe('dynamic-client')
      const registration = JSON.parse(fixture.calls.find(call => call.url.endsWith('/register'))!.body!)
      expect(registration).toMatchObject({ application_type: 'web', redirect_uris: ['https://wiki.example.test/agents/oauth/callback'], token_endpoint_auth_method: 'none' })
    }
    fixture.restart()
    expect(await service.oauthCallback(owner, { state: authorization.searchParams.get('state')!, code: 'automatic-code', iss: fixture.issuer, sessionId: 'automatic', callbackPath: '/agents/oauth/callback' })).toBe('connected')
    await service.connectOAuth({ id: 9, authVersion: 0 }, endpoint.id, 'second-person')
    expect(fixture.calls.filter(call => call.url.endsWith('/register'))).toHaveLength(options.registration === 'dynamic' ? 1 : 0)
    expect((await service.discoverForUser(owner, endpoint.id)).catalog.tools).not.toHaveLength(0)
  })

  it.each([true, false])('enforces exact response issuer binding when issuer metadata flag is %s', async requireIssuer => {
    const fixture = genericFixture({ requireIssuer })
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    const authorization = new URL((await service.connectOAuth(owner, endpoint.id, 'issuer-browser')).authorizationUrl)
    const callback = { state: authorization.searchParams.get('state')!, code: 'issuer-code', sessionId: 'issuer-browser', callbackPath: '/agents/oauth/callback' }
    expect(await service.oauthCallback(owner, { ...callback, iss: fixture.issuer + '/' })).toBe('error')
    expect(await service.oauthCallback(owner, { ...callback, error: 'access_denied', iss: 'https://attacker.test' })).toBe('error')
    if (requireIssuer) {
      expect(await service.oauthCallback(owner, callback)).toBe('error')
      expect(await service.oauthCallback(owner, { ...callback, iss: fixture.issuer })).toBe('connected')
    } else expect(await service.oauthCallback(owner, callback)).toBe('connected')
  })

  it('accepts unknown token expiry without inventing a lifetime or requiring a refresh token', async () => {
    const fixture = genericFixture({ noExpiry: true, noRefresh: true })
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    const authorization = new URL((await service.connectOAuth(owner, endpoint.id, 'unknown-expiry')).authorizationUrl)
    expect(await service.oauthCallback(owner, { state: authorization.searchParams.get('state')!, code: 'valid-code', iss: fixture.issuer, sessionId: 'unknown-expiry', callbackPath: '/agents/oauth/callback' })).toBe('connected')
    fixture.restart()
    expect(await service.oauthStatus(owner, endpoint.id)).toMatchObject({ connected: true })
    await service.discoverForUser(owner, endpoint.id)
    expect(fixture.calls.filter(call => call.url.endsWith('/token'))).toHaveLength(1)
  })

  it('never redirects a saved client secret to changed discovered token endpoints', async () => {
    const fixture = genericFixture({ method: 'client_secret_post' })
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    await service.connectOAuth(owner, endpoint.id, 'pinned-client')
    const { groupIds: _groups, ...edit } = fixture.configuration
    const { clientSecretValue: _secret, ...retainedClient } = edit.oauth
    const renamed = await service.updateAdmin(admin, endpoint.id, endpoint.revision, { ...edit, displayName: 'Renamed without replacing credentials', oauth: retainedClient })
    await service.setAdminGrants(admin, endpoint.id, renamed.revision, { groupIds: [20] })
    fixture.metadata.token_endpoint = 'https://attacker.test/token'
    await expect(service.connectOAuth(owner, endpoint.id, 'new-consent')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_OAUTH_DISCOVERY_FAILED' })
    expect(fixture.calls.some(call => call.url.startsWith('https://attacker.test'))).toBe(false)
    expect(fixture.calls.every(call => !call.body?.includes('manual-secret'))).toBe(true)
  })

  it('allows generic personal OAuth configuration only after live group policy approval', async () => {
    const fixture = genericFixture()
    const { groupIds: _groups, ...personal } = fixture.configuration
    await expect(service.createPersonal(owner, personal)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
    const endpoint = await service.createPersonal(owner, personal)
    const authorization = new URL((await service.connectOAuth(owner, endpoint.id, 'personal')).authorizationUrl)
    expect(await service.oauthCallback(owner, { state: authorization.searchParams.get('state')!, code: 'personal-code', iss: fixture.issuer, sessionId: 'personal', callbackPath: '/agents/oauth/callback' })).toBe('connected')
    expect((await service.discoverForUser(owner, endpoint.id)).catalog.tools).not.toHaveLength(0)
  })

  it.each(['authorization', 'token', 'issuer', 'resource'] as const)('rejects unsafe or mismatched discovered %s before releasing credentials', async destination => {
    const fixture = genericFixture({ method: 'client_secret_post' })
    if (destination === 'authorization') fixture.metadata.authorization_endpoint = 'https://127.0.0.1/authorize'
    if (destination === 'token') fixture.metadata.token_endpoint = 'https://user:password@identity.vendor.test/token'
    if (destination === 'issuer') fixture.metadata.issuer = fixture.issuer + '/'
    if (destination === 'resource') fixture.resource.resource = 'https://other.vendor.test/mcp'
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    await expect(service.connectOAuth(owner, endpoint.id, 'unsafe-destination')).rejects.toMatchObject({ code: expect.stringMatching(/^EXTERNAL_MCP_(?:EGRESS_DENIED|OAUTH_DISCOVERY_FAILED)$/u) })
    expect(fixture.calls.every(call => !call.headers.has('authorization') && !call.body?.includes('manual-secret'))).toBe(true)
    expect(await db('agentExternalMcpOAuthPending')).toEqual([])
  })

  it('binds refresh to the original resource and requires reconnect when granted scopes shrink', async () => {
    const fixture = genericFixture()
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    const authorization = new URL((await service.connectOAuth(owner, endpoint.id, 'scope-browser')).authorizationUrl)
    expect(await service.oauthCallback(owner, { state: authorization.searchParams.get('state')!, code: 'scope-code', iss: fixture.issuer, sessionId: 'scope-browser', callbackPath: '/agents/oauth/callback' })).toBe('connected')
    await db.transaction(async tx => {
      const grant = await tx('agentExternalMcpOAuthGrants').where('serverId', endpoint.id).first()
      const token = JSON.parse((await vault.get(grant.secretReference, tx))!)
      const secretReference = await vault.store(JSON.stringify({ ...token, expiresAt: 0 }), owner.id, tx)
      await tx('agentExternalMcpOAuthGrants').where('id', grant.id).update({ secretReference })
      await vault.delete(grant.secretReference, tx)
    })
    fixture.tokenResponse.scope = 'less'
    await expect(service.discoverForUser(owner, endpoint.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_RECONNECT_REQUIRED' })
    const exchange = fixture.calls.filter(call => call.url.endsWith('/token')).at(-1)!
    expect(new URLSearchParams(exchange.body).get('resource')).toBe(endpoint.endpointUrl)
    expect(new URLSearchParams(exchange.body).get('grant_type')).toBe('refresh_token')
    expect(await service.oauthStatus(owner, endpoint.id)).toMatchObject({ connected: false, reconnectRequired: true })
  })

  it('keeps ordinary none/bearer MCP available on HTTP installations while OAuth reports not configured', async () => {
    const fixture = genericFixture()
    service = new ExternalMcpService({ knex: db, secrets: vault, enabled: () => true, resolve: publicResolver, fetch: protocol.fetch, oauth: { siteOrigin: 'http://wiki.example.test' } })
    for (const authMode of ['none', 'bearer'] as const) {
      const endpoint = await service.createAdmin(admin, { ...input(), authMode, ...(authMode === 'bearer' ? { secretValue: 'http-install-bearer' } : {}), groupIds: [20] })
      expect((await service.discoverForUser(owner, endpoint.id)).catalog.tools).not.toHaveLength(0)
    }
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    expect(await service.oauthStatus(owner, endpoint.id)).toMatchObject({ configured: false, connected: false })
    await expect(service.connectOAuth(owner, endpoint.id, 'http-oauth')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_OAUTH_NOT_CONFIGURED' })
  })

  const oauthEndpoint = () => ({ ...input(), endpointUrl: 'https://mcp.vendor.test/api/mcp', authMode: 'oauth' as const, oauth: { registrationMode: 'preregistered' as const, issuer: 'https://identity.vendor.test/tenant', clientId: 'manual-client', tokenEndpointAuthMethod: 'none' as const }, groupIds: [20] })
  const oauthFixture = (options: { refreshError?: boolean; expiresIn?: number } = {}) => genericFixture({ ...options, requireIssuer: false }).tokenCalls
  const finishOAuthConsent = async (serverId: string, sessionId = 'browser-session') => {
    const { authorizationUrl } = await service.connectOAuth(owner, serverId, sessionId)
    const url = new URL(authorizationUrl)
    expect(url.origin + url.pathname).toBe('https://identity.vendor.test/tenant/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe('https://wiki.example.test/agents/oauth/callback')
    const state = url.searchParams.get('state')!
    const pending = await db('agentExternalMcpOAuthPending').where('stateHash', createHash('sha256').update(state).digest('hex')).first('secretReference')
    const { verifier } = JSON.parse((await vault.get(pending.secretReference))!) as { verifier: string }
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(await service.oauthCallback(owner, { state, code: 'controlled-code', sessionId, callbackPath: '/agents/oauth/callback' })).toBe('connected')
    return state
  }

  it('removes confidential client secrets rather than retaining them when switching to automatic or non-OAuth authentication', async () => {
    const fixture = genericFixture({ method: 'client_secret_post' })
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    await service.connectOAuth(owner, endpoint.id, 'confidential')
    const { groupIds: _groups, ...edit } = fixture.configuration
    const automatic = await service.updateAdmin(admin, endpoint.id, endpoint.revision, { ...edit, oauth: { registrationMode: 'automatic' } })
    expect(automatic.oauth?.clientSecretConfigured).toBe(false)
    expect(await db('agentExternalMcpOAuthRegistrations')).toEqual([])
    expect(await db('agentProviderSecrets')).toEqual([])
    const ordinary = await service.updateAdmin(admin, endpoint.id, automatic.revision, { ...input(), endpointUrl: endpoint.endpointUrl, authMode: 'none' })
    expect(ordinary.oauth).toBeUndefined()
  })

  it('keeps credentials per user, skips disconnected automatic clients, and exchanges PKCE through the consumer', async () => {
    const calls = oauthFixture()
    const server = await service.createAdmin(admin, oauthEndpoint())
    expect((await service.listForUser(owner))[0]?.id).toBe(server.id)
    const unconnected = await service.openForUser(owner.id)
    leases.push(unconnected)
    expect(unconnected.clients).toHaveLength(0)
    await expect(service.discoverForUser(owner, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_RECONNECT_REQUIRED' })
    const state = await finishOAuthConsent(server.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/u)
    expect(await service.oauthCallback(owner, { state, code: 'replay', sessionId: 'browser-session', callbackPath: '/agents/oauth/callback' })).toBe('error')
    expect(calls).toHaveLength(1)
    expect(await service.oauthStatus(owner, server.id)).toMatchObject({ connected: true, configured: true, reconnectRequired: false })
    expect(await service.oauthStatus({ id: 9, authVersion: 0 }, server.id)).toMatchObject({ connected: false })
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    expect(protocol.calls.every(call => call.headers.get('authorization') === 'Bearer vendor-access-token')).toBe(true)
    expect(JSON.stringify(await service.listForUser(owner))).not.toContain('vendor-access-token')
    expect(JSON.stringify(await db('agentProviderSecrets'))).not.toContain('vendor-refresh-token')
  })

  it('rejects browser/user mixup and expired state without consuming the legitimate consent or exchanging a code', async () => {
    const calls = oauthFixture()
    const server = await service.createAdmin(admin, oauthEndpoint())
    const url = new URL((await service.connectOAuth(owner, server.id, 'initiator-session')).authorizationUrl)
    const state = url.searchParams.get('state')!
    expect(await service.oauthCallback(owner, { state, code: 'code', sessionId: 'different-browser', callbackPath: '/agents/oauth/callback' })).toBe('error')
    expect(await service.oauthCallback({ id: 9, authVersion: 0 }, { state, code: 'code', sessionId: 'initiator-session', callbackPath: '/agents/oauth/callback' })).toBe('error')
    await db('agentExternalMcpOAuthPending').update({ expiresAt: new Date(Date.now() - 1_000) })
    expect(await service.oauthCallback(owner, { state, code: 'code', sessionId: 'initiator-session', callbackPath: '/agents/oauth/callback' })).toBe('error')
    expect(await db('agentExternalMcpOAuthPending')).toEqual([])
    expect(await db('agentProviderSecrets').where('createdBy', owner.id)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('invalidates callbacks and open native clients on endpoint-local disconnect without revoking other connections', async () => {
    const calls = oauthFixture()
    const server = await service.createAdmin(admin, oauthEndpoint())
    const state = await finishOAuthConsent(server.id)
    const secondEndpoint = await service.createAdmin(admin, { ...oauthEndpoint(), displayName: 'Another connection' })
    await finishOAuthConsent(secondEndpoint.id)
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    const before = protocol.calls.length
    await service.disconnectOAuth(owner, server.id)
    expect(calls).toHaveLength(2)
    expect(await service.oauthStatus(owner, secondEndpoint.id)).toMatchObject({ connected: true })
    expect(await db('agentProviderSecrets').where('createdBy', owner.id)).toHaveLength(1)
    await expect(lease.clients[0]!.callTool('web_search', {})).rejects.toMatchObject({ code: 'EXTERNAL_MCP_RECONNECT_REQUIRED' })
    expect(protocol.calls).toHaveLength(before)
    expect(await service.oauthCallback(owner, { state, code: 'late-code', sessionId: 'browser-session', callbackPath: '/agents/oauth/callback' })).toBe('error')
  })

  it('refreshes before native dispatch without replaying tools and removes invalid grants', async () => {
    const calls = oauthFixture({ expiresIn: 1 })
    const server = await service.createAdmin(admin, oauthEndpoint())
    await finishOAuthConsent(server.id)
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    expect(calls.filter(call => call.body.get('grant_type') === 'refresh_token').length).toBeGreaterThan(0)
    expect(protocol.calls.every(call => call.headers.get('authorization') === 'Bearer refreshed-vendor-token')).toBe(true)
    oauthFixture({ refreshError: true })
    await expect(service.discoverForUser(owner, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_RECONNECT_REQUIRED' })
    expect(await db('agentProviderSecrets').where('createdBy', owner.id)).toEqual([])
    expect(await service.oauthStatus(owner, server.id)).toMatchObject({ connected: false, reconnectRequired: true })
  })

  it('removes encrypted tokens and pending consent when endpoint revisions or grants change', async () => {
    oauthFixture()
    const server = await service.createAdmin(admin, oauthEndpoint())
    await finishOAuthConsent(server.id)
    const pending = new URL((await service.connectOAuth({ id: 9, authVersion: 0 }, server.id, 'other-browser')).authorizationUrl).searchParams.get('state')!
    await service.setAdminGrants(admin, server.id, server.revision, { groupIds: [20] })
    expect(await db('agentProviderSecrets').whereIn('createdBy', [owner.id, 9])).toEqual([])
    expect(await db('agentExternalMcpOAuthGrants')).toEqual([])
    expect(await service.oauthCallback({ id: 9, authVersion: 0 }, { state: pending, code: 'late', sessionId: 'other-browser', callbackPath: '/agents/oauth/callback' })).toBe('error')
    await expect(service.createAdmin(admin, { ...oauthEndpoint(), secretValue: 'must-not-be-accepted' })).rejects.toMatchObject({ code: 'INVALID_EXTERNAL_MCP_CREDENTIAL' })
  })
  it('fails MCP authentication without replaying side effects or retaining rejected credentials', async () => {
    oauthFixture()
    const server = await service.createAdmin(admin, oauthEndpoint())
    await finishOAuthConsent(server.id)
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    let sideEffects = 0
    protocol = { ...protocol, fetch: async () => {
      sideEffects++
      return Response.json({ error: 'invalid_token' }, { status: 401 })
    } }
    await expect(lease.clients[0]!.callTool('web_search', { query: 'must-not-repeat' })).rejects.toMatchObject({ code: 'EXTERNAL_MCP_RECONNECT_REQUIRED' })
    expect(sideEffects).toBe(1)
    expect(await service.oauthStatus(owner, server.id)).toMatchObject({ connected: false, reconnectRequired: true })
    expect(await db('agentProviderSecrets').where('createdBy', owner.id)).toEqual([])
  })
  it.each(['redirect', 'oversized', 'private-dns'] as const)('bounds the actual %s exchange and consumes state without following attacker destinations', async failure => {
    const fixture = genericFixture({ requireIssuer: false })
    const endpoint = await service.createAdmin(admin, fixture.configuration)
    const state = new URL((await service.connectOAuth(owner, endpoint.id, 'browser')).authorizationUrl).searchParams.get('state')!
    fixture.network.privateDns = failure === 'private-dns'
    if (failure !== 'private-dns') fixture.network.tokenFailure = failure
    expect(await service.oauthCallback(owner, { state, code: 'code', sessionId: 'browser', callbackPath: '/agents/oauth/callback' })).toBe('error')
    expect(await service.oauthCallback(owner, { state, code: 'code-again', sessionId: 'browser', callbackPath: '/agents/oauth/callback' })).toBe('error')
    expect(fixture.tokenCalls).toHaveLength(failure === 'private-dns' ? 0 : 1)
    expect(await db('agentProviderSecrets').where('createdBy', owner.id)).toEqual([])
    expect(await db('agentExternalMcpOAuthPending')).toEqual([])
  })
  it('cleans personal OAuth credentials and pending state on endpoint edits, policy revocation and endpoint deletion', async () => {
    oauthFixture()
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
    const { groupIds: _groups, ...input } = { ...oauthEndpoint(), displayName: 'Personal endpoint' }
    const endpoint = await service.createPersonal(owner, input)
    await finishOAuthConsent(endpoint.id)
    const updated = await service.updatePersonal(owner, endpoint.id, 1, { ...input, displayName: 'Renamed endpoint' })
    expect(await db('agentExternalMcpOAuthGrants')).toEqual([])
    await finishOAuthConsent(endpoint.id)
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: false }, 1)
    expect(await db('agentExternalMcpOAuthGrants')).toEqual([])
    expect(await db('agentProviderSecrets')).toHaveLength(1)
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 2)
    await service.connectOAuth(owner, endpoint.id, 'browser')
    await service.deletePersonal(owner, endpoint.id, updated.revision)
    expect(await db('agentExternalMcpOAuthPending')).toEqual([])
    expect(await db('agentProviderSecrets')).toEqual([])
  })
  it('blocks old access-token reflection after a refresh before native content can reach the agent', async () => {
    oauthFixture()
    const endpoint = await service.createAdmin(admin, oauthEndpoint())
    await finishOAuthConsent(endpoint.id)
    const lease = await service.openForUser(owner.id, { serverIds: [endpoint.id] })
    leases.push(lease)
    await lease.inspectCatalog(endpoint.id)
    await db.transaction(async tx => {
      const grant = await tx('agentExternalMcpOAuthGrants').where({ userId: owner.id, serverId: endpoint.id }).first()
      const token = JSON.parse((await vault.get(grant.secretReference, tx))!)
      const secretReference = await vault.store(JSON.stringify({ ...token, expiresAt: 0 }), owner.id, tx)
      await tx('agentExternalMcpOAuthGrants').where('id', grant.id).update({ secretReference })
      await vault.delete(grant.secretReference, tx)
    })
    protocol = { ...protocol, fetch: async (_url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer refreshed-vendor-token')
      const message = JSON.parse(String(init.body))
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'vendor-access-token' }] } })
    } }
    await expect(lease.clients[0]!.callTool('web_search', {})).rejects.toMatchObject({ code: 'EXTERNAL_MCP_CREDENTIAL_REFLECTED' })
  })

  it.each(['legacy', 'modern'] as const)('discovers %s catalogs natively and retains attributed raw multimodal results', async era => {
    protocol = protocolFixture(era)
    const server = await service.createAdmin(admin, { ...input(), authMode: 'bearer', secretValue: 'fixture-mcp-credential', groupIds: [20] })
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    expect(lease.clients[0]).toBeInstanceOf(AxMCPClient)
    const discovery = await lease.inspectCatalog(server.id)
    expect(discovery.attribution).toMatchObject({ serverId: server.id, namespace: server.namespace, trust: 'untrusted', authority: 'external' })
    expect(discovery.catalog.tools.map(tool => tool.name)).toEqual(['web_search'])
    expect(discovery.catalog.prompts[0]?.name).toBe('research')
    expect(discovery.catalog.resources[0]?.uri).toBe('https://research.example.com/document')
    const result = await lease.clients[0]!.callTool('web_search', { query: 'some topic' })
    expect(result).toMatchObject({
      content: [
        { type: 'text', text: 'External claim, not Wiki evidence' },
        { type: 'image', mimeType: 'image/png', data: 'AA==' }
      ],
      structuredContent: { source: 'external' }
    })
    expect(protocol.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
    await lease.close()
    await lease.close()
    if (era === 'legacy') expect(protocol.calls.filter(call => call.method === 'session/terminate')).toHaveLength(1)
    const requestsAfterClose = protocol.calls.length
    await expect(lease.clients[0]!.inspectCatalog()).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toHaveLength(requestsAfterClose)
  })

  it.each([
    ['legacy', 'DNS'],
    ['legacy', 'credential'],
    ['modern', 'DNS'],
    ['modern', 'credential']
  ] as const)('denies copied source revoked during final %s %s admission before native HTTP tools/call', async (era, stage) => {
    protocol = protocolFixture(era)
    const admissionStarted = Promise.withResolvers<void>()
    const admissionReleased = Promise.withResolvers<void>()
    let holdAdmission = false
    let sourceAllowed = true
    let admittedWithSource = false
    const sourceDenied = new AgentRepositoryError('AGENT_EVIDENCE_INVALID', 'Copied Wiki source is no longer readable', 403)
    const authorizeSource = async (): Promise<void> => {
      if (!sourceAllowed) throw sourceDenied
      admittedWithSource = true
    }
    const waitForRevocation = async (): Promise<void> => {
      if (!holdAdmission) return
      holdAdmission = false
      admissionStarted.resolve()
      await admissionReleased.promise
    }
    const guardedService = new ExternalMcpService({
      knex: db,
      secrets: {
        has: vault.has.bind(vault),
        store: vault.store.bind(vault),
        delete: vault.delete.bind(vault),
        get: async reference => {
          if (stage === 'credential') await waitForRevocation()
          return vault.get(reference)
        }
      },
      enabled: () => true,
      resolve: async () => {
        if (stage === 'DNS') await waitForRevocation()
        return publicResolver()
      },
      fetch: (...args) => protocol.fetch(...args)
    })
    const server = await guardedService.createAdmin(admin, { ...input(), authMode: 'bearer', secretValue: 'fixture-mcp-credential', groupIds: [20] })
    const context = await ExternalMcpEngineContext.open(guardedService, owner.id, new AbortController().signal)
    if (!context) throw new Error('Expected a live external MCP engine context')
    try {
      const binding = [...context.bindings.values()][0]!
      await context.invoke(binding, { query: 'Public control request' }, 'public-control')
      const control = protocol.calls.filter(call => call.method === 'tools/call')
      expect(control).toHaveLength(1)
      expect(control[0]!.headers.get('mcp-method')).toBe(era === 'modern' ? 'tools/call' : null)
      holdAdmission = true
      const pending = context.invoke(binding, { query: 'PRIVATE-WIKI-SNAPSHOT: internal stock review' }, 'copied-source', authorizeSource)
      const outcome = pending.catch((error: unknown) => error)
      await admissionStarted.promise
      expect(admittedWithSource).toBe(true)
      expect(sourceAllowed).toBe(true)
      sourceAllowed = false
      admissionReleased.resolve()
      // The repository error must survive both native SDK and host HTTP wrappers.
      expect(await outcome).toBe(sourceDenied)
      expect(protocol.calls.filter(call => call.method === 'tools/call')).toEqual(control)
      expect(JSON.stringify(protocol.calls)).not.toContain('PRIVATE-WIKI-SNAPSHOT')
      expect(await guardedService.listForUser(owner)).toMatchObject([{ id: server.id, status: 'enabled' }])
    } finally {
      admissionReleased.resolve()
      await context.close()
    }
  })

  it('rejects an advertised binding invalidated by native catalog refresh during final HTTP DNS admission', async () => {
    const resolving = Promise.withResolvers<void>()
    const resolved = Promise.withResolvers<void>()
    let holdNextResolution = false
    const guardedService = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: async () => {
        if (holdNextResolution) {
          holdNextResolution = false
          resolving.resolve()
          await resolved.promise
        }
        return publicResolver()
      },
      fetch: (...args) => protocol.fetch(...args)
    })
    await guardedService.createAdmin(admin, { ...input(), groupIds: [20] })
    // Observe the real service's lease so the race refreshes the exact native
    // client used by the engine; do not replace its owner/HTTP implementation.
    const opened = vi.spyOn(guardedService, 'openForUser')
    const context = await ExternalMcpEngineContext.open(guardedService, owner.id, new AbortController().signal)
    if (!context) throw new Error('Expected a live external MCP engine context')
    try {
      const lease = await opened.mock.results[0]!.value
      const client = lease.clients[0]!
      const revision = client.getCatalogRevision()
      const binding = [...context.bindings.values()][0]!
      holdNextResolution = true
      // No Wiki callback: the advertised binding's own authority must still
      // remain live through the final transport admission.
      const pending = context.invoke(binding, { query: 'STALE-CATALOG-ARGUMENT' }, 'stale-catalog').catch((error: unknown) => error)
      await resolving.promise
      protocol.setToolCount(2)
      await client.refresh({ force: true })
      expect(client.getTools().map(tool => tool.name)).toEqual(['web_search', 'tool_1'])
      expect(client.getCatalogRevision()).toBeGreaterThan(revision)
      resolved.resolve()
      expect(await pending).toHaveProperty('code', 'EXTERNAL_MCP_ACCESS_DENIED')
      expect(protocol.calls.filter(call => call.method === 'tools/call')).toEqual([])
      expect(JSON.stringify(protocol.calls)).not.toContain('STALE-CATALOG-ARGUMENT')
    } finally {
      resolved.resolve()
      await context.close()
      opened.mockRestore()
    }
  })

  it.each(['legacy', 'modern'] as const)('isolates concurrent %s native invocation source authority across delayed final DNS', async era => {
    protocol = protocolFixture(era)
    const resolving = Promise.withResolvers<void>()
    const resolved = Promise.withResolvers<void>()
    let holdNextResolution = false
    let firstSourceAllowed = true
    let firstSourceAdmitted = false
    const sourceDenied = new AgentRepositoryError('AGENT_EVIDENCE_INVALID', 'First invocation lost Wiki source access', 403)
    const guardedService = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: async () => {
        if (holdNextResolution) {
          holdNextResolution = false
          resolving.resolve()
          await resolved.promise
        }
        return publicResolver()
      },
      fetch: (...args) => protocol.fetch(...args)
    })
    await guardedService.createAdmin(admin, { ...input(), groupIds: [20] })
    const context = await ExternalMcpEngineContext.open(guardedService, owner.id, new AbortController().signal)
    if (!context) throw new Error('Expected a live external MCP engine context')
    try {
      const binding = [...context.bindings.values()][0]!
      holdNextResolution = true
      const first = context.invoke(binding, { query: 'PRIVATE-FIRST-INVOCATION' }, 'first-source', async () => {
        if (!firstSourceAllowed) throw sourceDenied
        firstSourceAdmitted = true
      }).catch((error: unknown) => error)
      await resolving.promise
      expect(firstSourceAdmitted).toBe(true)
      const second = await context.invoke(binding, { query: 'Independently authorized source' }, 'second-source', async () => {})
      expect(second).toHaveProperty('protocolResult.value.structuredContent.source', 'external')
      firstSourceAllowed = false
      resolved.resolve()
      expect(await first).toBe(sourceDenied)
      const sent = protocol.calls.filter(call => call.method === 'tools/call')
      expect(sent).toHaveLength(1)
      expect(sent[0]!.params).toMatchObject({ arguments: { query: 'Independently authorized source' } })
      expect(JSON.stringify(protocol.calls)).not.toContain('PRIVATE-FIRST-INVOCATION')
    } finally {
      resolved.resolve()
      await context.close()
    }
  })

  it.each(['modern', 'legacy'] as const)('isolates same-origin endpoint eras when %s initializes first', async firstEra => {
    const origin = `https://eras-${randomUUID()}.example.com`
    const fixtures = { modern: protocolFixture('modern'), legacy: protocolFixture('legacy') }
    fixtures.modern.setToolCount(2)
    const scoped = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: publicResolver,
      fetch: async (url, init) => {
        const era = url.pathname === '/modern' ? 'modern' : url.pathname === '/legacy' ? 'legacy' : undefined
        if (!era) throw new Error(`Unexpected fixture endpoint ${url.href}`)
        if (era === 'modern' && init.method !== 'DELETE') {
          const request = JSON.parse(String(init.body)) as { id?: string; method: string }
          if (request.method === 'initialize')
            return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Modern-only endpoint' } })
        }
        return fixtures[era].fetch(url, init)
      }
    })
    const order = firstEra === 'modern' ? ['modern', 'legacy'] as const : ['legacy', 'modern'] as const
    const opened: { era: 'modern' | 'legacy'; lease: ExternalMcpLease; serverId: string }[] = []
    try {
      for (const era of order) {
        const server = await scoped.createAdmin(admin, { ...input(), endpointUrl: `${origin}/${era}`, groupIds: [20] })
        const lease = await scoped.openForUser(owner.id, { serverIds: [server.id] })
        leases.push(lease)
        opened.push({ era, lease, serverId: server.id })
        const discovery = await lease.inspectCatalog(server.id)
        expect(lease.clients[0]!.getEra()).toBe(era)
        expect(discovery.catalog.tools.map(tool => tool.name)).toEqual(era === 'modern' ? ['web_search', 'tool_1'] : ['web_search'])
      }
      // Exercise both clients after both have initialized, not only the last one.
      for (const { era, lease, serverId } of opened) {
        expect((await lease.inspectCatalog(serverId)).catalog.tools).toHaveLength(era === 'modern' ? 2 : 1)
        expect(await lease.clients[0]!.callTool('web_search', { query: era })).toMatchObject({
          content: [{ type: 'text', text: 'External claim, not Wiki evidence' }, { type: 'image', mimeType: 'image/png', data: 'AA==' }],
          structuredContent: { source: 'external' }
        })
        const calls = fixtures[era].calls.filter(call => call.method === 'tools/call')
        expect(calls).toHaveLength(1)
        expect(calls[0]!.params).toMatchObject({ name: 'web_search', arguments: { query: era } })
      }
    } finally {
      await Promise.all(opened.map(({ lease }) => lease.close()))
    }
    expect(fixtures.legacy.calls.filter(call => call.method === 'initialize')).toHaveLength(1)
    expect(fixtures.legacy.calls.filter(call => call.method === 'session/terminate')).toHaveLength(1)
    expect(fixtures.modern.calls.filter(call => call.method === 'session/terminate')).toHaveLength(0)
    for (const { era, lease } of opened) {
      const count = fixtures[era].calls.length
      await lease.close()
      await expect(lease.clients[0]!.inspectCatalog()).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
      expect(fixtures[era].calls).toHaveLength(count)
    }
  })

  it('streams inspected bearer SSE ping and task-handle frames through native Ax before EOF', async () => {
    protocol = protocolFixture('modern', true)
    const encoder = new TextEncoder()
    const cancelled = Promise.withResolvers<void>()
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    let taskResponse = ''
    let pongReceived = false
    const streaming = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: publicResolver,
      fetch: async (url, init) => {
        const message = JSON.parse(String(init.body)) as { id?: string; method?: string; result?: unknown }
        if (message.id === 'fixture-server-ping' && message.method === undefined) {
          expect(message.result).toEqual({})
          pongReceived = true
          stream!.enqueue(encoder.encode(`data: ${taskResponse}\r\n\r\n`))
          return new Response(null, { status: 202 })
        }
        if (message.method !== 'tools/call') return protocol.fetch(url, init)
        taskResponse = await (await protocol.fetch(url, init)).text()
        const ping = encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'fixture-server-ping', method: 'ping', _meta: { note: 'café' } })}\r\n\r\n`)
        const unicodeSplit = ping.indexOf(0xc3) + 1
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
              controller.enqueue(ping.slice(0, unicodeSplit))
              controller.enqueue(ping.slice(unicodeSplit, -3))
              controller.enqueue(ping.slice(-3))
              // Remain open: only the native result consumer may cancel this stream.
            },
            cancel() {
              cancelled.resolve()
            }
          }),
          { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
        )
      }
    })
    const server = await streaming.createAdmin(admin, { ...input(), authMode: 'bearer', secretValue: 'fixture-only-mcp-secret', groupIds: [20] })
    const lease = await streaming.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    const outcome = await lease.clients[0]!.callToolOutcome('web_search', {})
    expect(pongReceived).toBe(true)
    expect(outcome).toMatchObject({ kind: 'task', task: { taskId: 'owned-task' } })
    expect(lease.clients[0]!.getKnownTasks()).toMatchObject([{ taskId: 'owned-task', status: 'working' }])
    await cancelled.promise
    await lease.close()
    expect(protocol.calls.filter(call => call.method === 'tasks/cancel')).toHaveLength(1)
    expect(protocol.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
  })

  it('cancels a native bearer SSE invocation while withholding an incomplete credential frame', async () => {
    const abort = new AbortController()
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const streaming = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: publicResolver,
      fetch: async (url, init) => {
        const message = JSON.parse(String(init.body)) as { method: string }
        if (message.method !== 'tools/call') return protocol.fetch(url, init)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","result":{"text":"fixture-only-mcp-'))
            },
            pull() {
              started.resolve()
            },
            cancel() {
              cancelled.resolve()
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    })
    const server = await streaming.createAdmin(admin, { ...input(), authMode: 'bearer', secretValue: 'fixture-only-mcp-secret', groupIds: [20] })
    const lease = await streaming.openForUser(owner.id, { serverIds: [server.id], signal: abort.signal })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    const pending = lease.clients[0]!.callTool('web_search', {}).catch((caught: unknown) => caught)
    await started.promise
    abort.abort(new DOMException('User cancelled', 'AbortError'))
    expect(await pending).toHaveProperty('name', 'AbortError')
    await cancelled.promise
    await lease.close()
  })

  it.each(['legacy', 'modern'] as const)('administrators inspect %s shared catalogs without granting themselves runtime access', async era => {
    protocol = protocolFixture(era)
    const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    const discovery = await service.discoverForUser(admin, server.id)
    expect(discovery.catalog.tools[0]?.name).toBe('web_search')
    expect(discovery.attribution).toMatchObject({ serverId: server.id, trust: 'untrusted', authority: 'external' })
    expect(await service.listForUser(admin)).toEqual([])
    const count = protocol.calls.length
    await expect(service.openForUser(admin.id, { serverIds: [server.id] })).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(service.discoverForUser({ ...other, permissions: ['manage:system'] } as never, server.id)).rejects.toMatchObject({
      code: 'EXTERNAL_MCP_ACCESS_DENIED'
    })
    await db('groups')
      .where('id', 10)
      .update({ permissions: JSON.stringify(['use:agents']) })
    await expect(service.discoverForUser(admin, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toHaveLength(count)
  })

  it('reauthorizes administrator discovery while the remote catalog is arriving', async () => {
    const server = await service.createAdmin(admin, { ...input(), groupIds: [] })
    let revoked = false
    const revocable = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: publicResolver,
      fetch: async (url, init) => {
        const message = JSON.parse(String(init.body)) as { method: string }
        if (message.method === 'tools/list') {
          await db('groups')
            .where('id', 10)
            .update({ permissions: JSON.stringify(['use:agents']) })
          revoked = true
        }
        return protocol.fetch(url, init)
      }
    })
    await expect(revocable.discoverForUser(admin, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(revoked).toBe(true)
    expect(protocol.calls.some(call => call.method === 'tools/call')).toBe(false)
  })

  it.each(['legacy', 'modern'] as const)('admin grants deny %s discovery, invocation, cached reads and cleanup after revocation', async era => {
    protocol = protocolFixture(era)
    const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    expect(await service.listForUser(other)).toEqual([])
    await expect(service.discoverForUser(other, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toEqual([])
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    const requestsBeforeRevocation = protocol.calls.length
    await service.setAdminGrants(admin, server.id, server.revision, { groupIds: [30] })
    await expect(lease.clients[0]!.callTool('web_search', {})).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(lease.inspectCatalog(server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(lease.clients[0]!.listTools()).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toHaveLength(requestsBeforeRevocation)
    await lease.close()
    expect(protocol.calls).toHaveLength(requestsBeforeRevocation)
    expect(await service.listForUser(owner)).toEqual([])
  })

  it('personal creation needs live group permission and owners cannot discover, edit or delete each other’s configurations', async () => {
    await expect(service.createPersonal(owner, input())).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
    await service.setGroupPolicy(admin, 30, { allowPersonalEndpoints: true }, 0)
    const server = await service.createPersonal(owner, input())
    expect(await service.listPersonal(other)).toEqual([])
    await expect(service.discoverForUser(other, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(service.updatePersonal(other, server.id, server.revision, input())).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(service.deletePersonal(other, server.id, server.revision)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toEqual([])
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    const count = protocol.calls.length
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: false }, 1)
    await expect(lease.clients[0]!.callTool('web_search', {})).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(lease.inspectCatalog(server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(service.discoverForUser(owner, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toHaveLength(count)
  })

  it.each(['membership', 'account', 'session', 'server', 'switch'] as const)(
    'revoking %s after discovery prevents actual native tool invocation',
    async change => {
      const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
      const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
      leases.push(lease)
      await lease.inspectCatalog(server.id)
      const count = protocol.calls.length
      if (change === 'membership') await db('userGroups').where({ userId: 7, groupId: 20 }).delete()
      if (change === 'account') await db('users').where('id', 7).update({ isActive: false })
      if (change === 'session') await db('users').where('id', 7).update({ authVersion: 1 })
      if (change === 'server') await db('agentExternalMcpServers').where('id', server.id).update({ status: 'disabled' })
      if (change === 'switch') enabled = false
      await expect(lease.clients[0]!.callTool('web_search', {})).rejects.toMatchObject({ status: 403 })
      expect(protocol.calls).toHaveLength(count)
      await lease.close()
      expect(protocol.calls).toHaveLength(count)
    }
  )

  it('never accepts another credential reference, redacts secrets, and prevents implicit forwarding to a changed endpoint', async () => {
    const reference = await db.transaction(tx => vault.store('other-provider-private-key', admin.id, tx))
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
    await expect(service.createPersonal(owner, { ...input(), authMode: 'bearer', secretReference: reference } as never)).rejects.toMatchObject({
      code: 'INVALID_EXTERNAL_MCP_CONFIGURATION'
    })
    const values = { ...input(), authMode: 'bearer' as const, secretValue: 'own-mcp-private-key' }
    const server = await service.createPersonal(owner, values)
    const serialized = JSON.stringify([server, await service.listPersonal(owner), await service.listForUser(owner)])
    expect(serialized).not.toContain('private-key')
    expect(serialized).not.toContain('managed:')
    expect(server.secretConfigured).toBe(true)
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    expect(protocol.calls.every(call => call.headers.get('authorization') === 'Bearer own-mcp-private-key')).toBe(true)
    const { secretValue: _secretValue, ...withoutSecret } = values
    await expect(
      service.updatePersonal(owner, server.id, server.revision, { ...withoutSecret, endpointUrl: 'https://different.example.com/mcp' })
    ).rejects.toMatchObject({ code: 'EXTERNAL_MCP_CREDENTIAL_REQUIRED' })
    const row = await db('agentExternalMcpServers').where('id', server.id).first('secretReference')
    await service.deletePersonal(owner, server.id, server.revision)
    expect(await vault.has(row.secretReference)).toBe(false)
    expect(await vault.get(reference)).toBe('other-provider-private-key')
  })

  it('rejects stale revisions, forged admin claims, and catalogs beyond bounded entries', async () => {
    await expect(
      service.createAdmin({ ...owner, groups: [10], permissions: ['manage:system'] } as never, { ...input(), groupIds: [20] })
    ).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    await expect(service.setAdminGrants(admin, server.id, 0, { groupIds: [30] })).rejects.toMatchObject({ code: 'EXTERNAL_MCP_REVISION_CHANGED' })
    protocol.setToolCount(EXTERNAL_MCP_LIMITS.catalogEntries + 1)
    await expect(service.discoverForUser(owner, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_CATALOG_TOO_LARGE' })
    expect(await service.listForUser(owner)).toHaveLength(1)
  })

  it('keeps owned native task and session cleanup authorized after source revocation and abort, isolating handles by owner and endpoint', async () => {
    protocol = protocolFixture('legacy', true)
    const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    const second = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    const controller = new AbortController()
    const lease = await service.openForUser(owner.id, { serverIds: [server.id], signal: controller.signal })
    const independent = await service.openForUser(9, { serverIds: [server.id] })
    const anotherServer = await service.openForUser(owner.id, { serverIds: [second.id] })
    leases.push(lease, independent, anotherServer)
    for (const selected of [lease, independent, anotherServer]) await selected.clients[0]!.inspectCatalog()
    const client = lease.clients[0]!
    let sourceAllowed = true
    const sourceDenied = new AgentRepositoryError('AGENT_EVIDENCE_INVALID', 'Wiki source access was revoked', 403)
    await withAgentSourceAuthorization(async () => {
      if (!sourceAllowed) throw sourceDenied
    }, async () => {
      await client.callToolTask('web_search', {})
      expect(client.getKnownTasks()).toMatchObject([{ taskId: 'owned-task', status: 'working' }])
      await expect(independent.clients[0]!.cancelTask('owned-task')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
      await expect(anotherServer.clients[0]!.cancelTask('owned-task')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
      sourceAllowed = false
      // Native discovery remains usable without the previous tool's Wiki rights.
      const listings = protocol.calls.filter(call => call.method === 'tools/list').length
      await client.refresh({ force: true })
      expect(protocol.calls.filter(call => call.method === 'tools/list')).toHaveLength(listings + 1)
      controller.abort(new DOMException('User cancelled', 'AbortError'))
      await lease.close()
      expect(protocol.calls.filter(call => call.method === 'tasks/cancel')).toHaveLength(1)
      expect(client.getKnownTasks()).toMatchObject([{ taskId: 'owned-task', status: 'cancelled' }])
      expect(protocol.calls.filter(call => call.method === 'session/terminate')).toHaveLength(1)
    })
    expect(independent.clients[0]!.getKnownTasks()).toEqual([])
    const independentTask = await independent.clients[0]!.callToolTask('web_search', {})
    expect(independentTask.task.status).toBe('working')
  })

  it.each(['legacy', 'modern'] as const)('never adopts unsolicited or inspected %s task handles for cancellation cleanup', async era => {
    protocol = protocolFixture(era, true)
    const scoped = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: publicResolver,
      fetch: async (url, init) => {
        if (init.method === 'DELETE') return protocol.fetch(url, init)
        const request = JSON.parse(String(init.body)) as { id: string; method: string; params?: { taskId?: string } }
        const response = await protocol.fetch(url, init)
        if (request.method !== 'tools/call' && request.method !== 'tasks/get') return response
        const message = (await response.json()) as { jsonrpc: string; id: string; result: Record<string, unknown> }
        if (request.method === 'tasks/get') {
          return Response.json({ ...message, result: { ...message.result, taskId: request.params?.taskId } })
        }
        const task = era === 'legacy' ? message.result.task : message.result
        const foreign = { ...(task as Record<string, unknown>), taskId: 'foreign-task' }
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tasks/status', params: { task: foreign } })}\n\n` +
            `data: ${JSON.stringify(message)}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    })
    const server = await scoped.createAdmin(admin, { ...input(), groupIds: [20] })
    const lease = await scoped.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    const client = lease.clients[0]!
    await lease.inspectCatalog(server.id)
    if (era === 'legacy') await client.callToolTask('web_search', {})
    else expect(await client.callToolOutcome('web_search', {})).toHaveProperty('kind', 'task')
    // Native Ax receives the unsolicited status and records task inspections too.
    // Neither operation means this invocation created the foreign task.
    expect(await client.getTask('foreign-task')).toHaveProperty('taskId', 'foreign-task')
    await expect(client.cancelTask('foreign-task')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(client.getKnownTasks().map(task => task.taskId)).toEqual(['owned-task'])
    await lease.close()
    expect(protocol.calls.filter(call => call.method === 'tasks/cancel').map(call => call.params)).toMatchObject([{ taskId: 'owned-task' }])
    expect(protocol.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
  })

  it.each(['legacy', 'modern'] as const)('allows %s close cleanup after a failed owned cancellation without replay or duplicate cleanup', async era => {
    protocol = protocolFixture(era, true)
    let failCancellation = true
    const scoped = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: publicResolver,
      fetch: async (url, init) => {
        const response = await protocol.fetch(url, init)
        if (init.method === 'DELETE') return response
        const request = JSON.parse(String(init.body)) as { id: string; method: string }
        if (request.method === 'tasks/cancel' && failCancellation) {
          failCancellation = false
          return Response.json({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32603, message: 'Temporary task cancellation failure' }
          })
        }
        return response
      }
    })
    const server = await scoped.createAdmin(admin, { ...input(), groupIds: [20] })
    const lease = await scoped.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    const client = lease.clients[0]!
    await lease.inspectCatalog(server.id)
    if (era === 'legacy') await client.callToolTask('web_search', {})
    else expect(await client.callToolOutcome('web_search', {})).toHaveProperty('kind', 'task')
    const cancellations = [client.cancelTask('owned-task'), client.cancelTask('owned-task')]
    await Promise.all(cancellations.map(cancellation => expect(cancellation).rejects.toThrow('Temporary task cancellation failure')))
    expect(protocol.calls.filter(call => call.method === 'tasks/cancel')).toHaveLength(1)
    expect(client.getKnownTasks()).toMatchObject([{ taskId: 'owned-task', status: 'working' }])
    await expect(client.cancelTask('foreign-task')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await Promise.all([lease.close(), client.cancelTask('owned-task'), lease.close()])
    await client.cancelTask('owned-task')
    expect(protocol.calls.filter(call => call.method === 'tasks/cancel').map(call => call.params)).toMatchObject([
      { taskId: 'owned-task' },
      { taskId: 'owned-task' }
    ])
    expect(protocol.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
  })

  it.each(['membership', 'account', 'session', 'server', 'switch', 'grants', 'personal-policy', 'endpoint'] as const)(
    'reauthorizes legacy task polls, final result and abort cleanup after %s revocation without replay',
    async change => {
      protocol = protocolFixture('legacy', true)
      await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
      const personal = change === 'personal-policy'
      const server = personal ? await service.createPersonal(owner, input()) : await service.createAdmin(admin, { ...input(), groupIds: [20] })
      const controller = new AbortController()
      const lease = await service.openForUser(owner.id, { serverIds: [server.id], signal: controller.signal })
      leases.push(lease)
      const client = lease.clients[0]!
      await client.inspectCatalog()
      await client.callToolTask('web_search', {})
      expect(await client.getTask('owned-task')).toHaveProperty('status', 'working')
      protocol.setTaskStatus('completed')
      expect(await client.getTask('owned-task')).toHaveProperty('status', 'completed')
      expect(await client.getTaskResult('owned-task')).toHaveProperty('content.1.type', 'image')
      // A second actual task is left working so close must attempt cancellation.
      await client.callToolTask('web_search', {})
      const count = protocol.calls.length
      if (change === 'membership') await db('userGroups').where({ userId: 7, groupId: 20 }).delete()
      if (change === 'account') await db('users').where('id', 7).update({ isActive: false })
      if (change === 'session') await db('users').where('id', 7).update({ authVersion: 1 })
      if (change === 'server') await db('agentExternalMcpServers').where('id', server.id).update({ status: 'disabled' })
      if (change === 'switch') enabled = false
      if (change === 'grants') await service.setAdminGrants(admin, server.id, server.revision, { groupIds: [30] })
      if (change === 'personal-policy') await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: false }, 1)
      if (change === 'endpoint')
        await db('agentExternalMcpServers').where('id', server.id).update({ endpointUrl: 'https://other.example.com/mcp', revision: 2 })
      const denial = change === 'switch' ? 'EXTERNAL_MCP_DISABLED' : 'EXTERNAL_MCP_ACCESS_DENIED'
      await expect(client.getTask('owned-task')).rejects.toMatchObject({ code: denial })
      await expect(client.getTaskResult('owned-task')).rejects.toMatchObject({ code: denial })
      controller.abort(new DOMException('Cancelled', 'AbortError'))
      await lease.close()
      expect(protocol.calls).toHaveLength(count)
      expect(protocol.calls.filter(call => call.method === 'tools/call')).toHaveLength(2)
    }
  )

  it.each(['legacy', 'modern'] as const)('cancels an in-flight negotiated %s invocation promptly without closing another owner lease', async era => {
    protocol = protocolFixture(era)
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const invocations: { params: unknown; headers: Headers; signal: AbortSignal | null | undefined }[] = []
    const terminatedSessionIds = () => protocol.calls.filter(call => call.method === 'session/terminate').map(call => call.headers.get('mcp-session-id'))
    let interruptedInvocation = false
    const cancellable = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: publicResolver,
      fetch: async (url, init) => {
        if (init.method === 'DELETE') return protocol.fetch(url, init)
        const request = JSON.parse(String(init.body)) as { method: string; params?: unknown }
        if (request.method === 'initialize') {
          const response = await protocol.fetch(url, init)
          response.headers.set('mcp-session-id', randomUUID())
          return response
        }
        if (request.method !== 'tools/call') return protocol.fetch(url, init)
        invocations.push({ params: request.params, headers: new Headers(init.headers), signal: init.signal })
        if (interruptedInvocation) return protocol.fetch(url, init)
        interruptedInvocation = true
        const pending = Promise.withResolvers<Response>()
        const onAbort = (): void => {
          cancelled.resolve()
          pending.reject(init.signal?.reason)
        }
        init.signal?.addEventListener('abort', onAbort, { once: true })
        if (init.signal?.aborted) onAbort()
        started.resolve()
        try {
          return await pending.promise
        } finally {
          init.signal?.removeEventListener('abort', onAbort)
        }
      }
    })
    // Fresh origins keep cancellation fixtures independently negotiated.
    const server = await cancellable.createAdmin(admin, {
      ...input(),
      endpointUrl: `https://${era}-${randomUUID()}.example.com/mcp`,
      groupIds: [20]
    })
    const lease = await cancellable.openForUser(owner.id, { serverIds: [server.id], signal: controller.signal })
    leases.push(lease)
    const client = lease.clients[0]!
    await lease.inspectCatalog(server.id)
    expect(client.getEra()).toBe(era)
    const cancelledSessionId = protocol.calls.findLast(call => call.method === 'tools/list')!.headers.get('mcp-session-id')
    const independent = await cancellable.openForUser(9, { serverIds: [server.id] })
    leases.push(independent)
    const independentClient = independent.clients[0]!
    await independent.inspectCatalog(server.id)
    expect(independentClient.getEra()).toBe(era)
    const independentSessionId = protocol.calls.findLast(call => call.method === 'tools/list')!.headers.get('mcp-session-id')
    if (client.getEra() === 'legacy') {
      expect(cancelledSessionId).not.toBeNull()
      expect(independentSessionId).not.toBeNull()
      expect(independentSessionId).not.toBe(cancelledSessionId)
    } else {
      expect(cancelledSessionId).toBeNull()
      expect(independentSessionId).toBeNull()
    }
    const pending = client.callTool('web_search', { query: 'cancelled-owner' })
    const rejection = pending.catch((error: unknown) => error)
    await started.promise
    controller.abort(new DOMException('User cancelled', 'AbortError'))
    expect(await rejection).toHaveProperty('name', 'AbortError')
    await cancelled.promise
    await lease.close()
    expect(invocations).toHaveLength(1)
    expect(invocations[0]!.params).toMatchObject({ name: 'web_search', arguments: { query: 'cancelled-owner' } })
    expect(invocations[0]!.signal?.aborted).toBe(true)
    expect(invocations[0]!.headers.get('mcp-session-id')).toBe(cancelledSessionId)
    // Cancellation must never replay the interrupted side effect through the fixture.
    expect(protocol.calls.filter(call => call.method === 'tools/call')).toHaveLength(0)
    expect(terminatedSessionIds()).toEqual(cancelledSessionId === null ? [] : [cancelledSessionId])
    await expect(client.inspectCatalog()).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    const independentResult = await independentClient.callTool('web_search', { query: 'surviving-owner' })
    expect(independentResult).toHaveProperty('structuredContent.source', 'external')
    expect(invocations.map(call => call.params)).toMatchObject([
      { name: 'web_search', arguments: { query: 'cancelled-owner' } },
      { name: 'web_search', arguments: { query: 'surviving-owner' } }
    ])
    expect(protocol.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
    expect(invocations[1]!.headers.get('mcp-session-id')).toBe(independentSessionId)
    expect(terminatedSessionIds()).toEqual(cancelledSessionId === null ? [] : [cancelledSessionId])
    await independent.close()
    expect(terminatedSessionIds()).toEqual([cancelledSessionId, independentSessionId].filter(sessionId => sessionId !== null))
  })

  it('bounds legacy session cleanup, cancels active invocation and shares the pending close promise', async () => {
    protocol = protocolFixture('legacy')
    const toolStarted = Promise.withResolvers<void>()
    const deleteStarted = Promise.withResolvers<void>()
    const deleteAborted = Promise.withResolvers<void>()
    let deletes = 0
    const bounded = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: publicResolver,
      fetch: async (url, init) => {
        const terminating = init.method === 'DELETE'
        const request = terminating ? undefined : (JSON.parse(String(init.body)) as { method: string })
        if (!terminating && request?.method !== 'tools/call') return protocol.fetch(url, init)
        const pending = Promise.withResolvers<Response>()
        const onAbort = (): void => {
          if (terminating) deleteAborted.resolve()
          pending.reject(init.signal?.reason)
        }
        init.signal?.addEventListener('abort', onAbort, { once: true })
        if (init.signal?.aborted) onAbort()
        if (terminating) {
          deletes++
          deleteStarted.resolve()
        } else toolStarted.resolve()
        try {
          return await pending.promise
        } finally {
          init.signal?.removeEventListener('abort', onAbort)
        }
      }
    })
    const server = await bounded.createAdmin(admin, { ...input(), groupIds: [20] })
    const lease = await bounded.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    const invocation = lease.clients[0]!.callTool('web_search', {}).catch((error: unknown) => error)
    await toolStarted.promise
    const firstClose = lease.close()
    const secondClose = lease.close()
    expect(secondClose).toBe(firstClose)
    expect(await invocation).toHaveProperty('name', 'AbortError')
    await deleteStarted.promise
    await deleteAborted.promise
    await Promise.all([firstClose, secondClose])
    expect(deletes).toBe(1)
    await expect(lease.clients[0]!.callTool('web_search', {})).rejects.toHaveProperty('code', 'EXTERNAL_MCP_ACCESS_DENIED')
    expect(deletes).toBe(1)
  })
})

describe('external MCP untrusted endpoint boundary', () => {
  it.each([
    'http://public.example.com/mcp',
    'https://localhost/mcp',
    'https://metadata.internal/mcp',
    'https://169.254.169.254/mcp',
    'https://127.0.0.1/mcp',
    'https://[::1]/mcp',
    'https://[::ffff:93.184.216.34]/mcp',
    'https://[fc00::1]/mcp',
    'https://[fe80::1]/mcp',
    'https://user:password@public.example.com/mcp',
    'https://public.example.com:8443/mcp',
    'https://public.example.com/mcp?token=secret'
  ])('rejects prohibited endpoint %s before any network', endpoint => {
    expect(() => normalizeExternalMcpEndpoint(endpoint)).toThrow()
  })

  it.each([false, true])('guards unknown argument-bearing methods with modern routing headers present: %s', async modernHeaders => {
    const sourceDenied = new AgentRepositoryError('AGENT_EVIDENCE_INVALID', 'Wiki source access was revoked', 403)
    const captured: unknown[] = []
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => null,
      resolve: publicResolver,
      fetch: async (_url, init) => {
        captured.push(init.body)
        return Response.json({})
      }
    })
    try {
      const pending = withAgentSourceAuthorization(async () => { throw sourceDenied }, () =>
        guard.fetch('https://public.example.com/mcp', {
          method: 'POST',
          headers: modernHeaders ? { 'mcp-method': 'extension/export' } : {},
          body: JSON.stringify({ jsonrpc: '2.0', id: 'extension-call', method: 'extension/export', params: { query: 'PRIVATE-EXTENSION-ARGUMENT' } })
        })
      )
      await expect(pending).rejects.toBe(sourceDenied)
      expect(captured).toEqual([])
    } finally {
      await guard.close()
    }
  })

  it.each(['10.0.0.1', '169.254.169.254', '::ffff:93.184.216.34', 'fd00::1', 'fe80::1'])('rejects DNS answer %s without calling HTTP', async address => {
    let dispatched = false
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => null,
      resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      fetch: async () => {
        dispatched = true
        return Response.json({})
      }
    })
    try {
      await expect(guard.fetch('https://public.example.com/mcp')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_EGRESS_DENIED' })
      expect(dispatched).toBe(false)
    } finally {
      await guard.close()
    }
  })

  it.each(['invocation', 'aborted-task-cleanup', 'aborted-session-cleanup'] as const)(
    'pins and revalidates DNS at the actual Undici connection for %s, rejecting a public-to-private rebind',
    async operation => {
      let resolutions = 0
      const controller = new AbortController()
      if (operation !== 'invocation') controller.abort(new DOMException('User cancelled', 'AbortError'))
      const guard = createExternalMcpEndpointGuard({
        endpointUrl: 'https://rebind.example.com/mcp',
        signal: controller.signal,
        authorize: async () => {},
        credential: async () => null,
        resolve: async () => [{ address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
      })
      try {
        await expect(
          guard.fetch('https://rebind.example.com/mcp', {
            method: operation === 'aborted-session-cleanup' ? 'DELETE' : 'POST',
            ...(operation === 'aborted-session-cleanup' ? {} : { body: operation === 'aborted-task-cleanup' ? '{"method":"tasks/cancel"}' : '{}' })
          })
        ).rejects.toMatchObject({ status: 502 })
        expect(resolutions).toBe(2)
      } finally {
        await guard.close()
      }
    }
  )

  it('denies redirects without following them or crossing bearer credentials and denies arbitrary headers', async () => {
    let calls = 0,
      cancelled = false
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => 'test-private-bearer',
      resolve: publicResolver,
      fetch: async (url, init) => {
        calls++
        expect(url.href).toBe('https://public.example.com/mcp')
        expect(init.redirect).toBe('manual')
        expect(init.credentials).toBe('omit')
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-private-bearer')
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            }
          }),
          { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }
        )
      }
    })
    try {
      await expect(guard.fetch('https://public.example.com/mcp')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_REDIRECT_DENIED' })
      expect(calls).toBe(1)
      expect(cancelled).toBe(true)
      await expect(
        guard.fetch('https://public.example.com/mcp', { headers: { cookie: 'wiki-session', authorization: 'stolen-credential' } })
      ).rejects.toMatchObject({ code: 'EXTERNAL_MCP_EGRESS_DENIED' })
      await expect(guard.fetch('https://elsewhere.example.com/mcp')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_EGRESS_DENIED' })
      expect(calls).toBe(1)
    } finally {
      await guard.close()
    }
  })

  it.each(['body', 'escaped-json', 'sse', 'header'] as const)(
    'fails closed on %s credential reflection before exposing any remote response',
    async location => {
      const token = 'fixture-only-mcp-secret'
      const escaped = [...token].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
      const guard = createExternalMcpEndpointGuard({
        endpointUrl: 'https://public.example.com/mcp',
        authorize: async () => {},
        credential: async () => token,
        resolve: publicResolver,
        fetch: async () => {
          const text =
            location === 'body'
              ? JSON.stringify({ result: { content: [{ type: 'text', text: token }] } })
              : location === 'escaped-json'
                ? `{"error":{"message":"${escaped}"}}`
                : location === 'sse'
                  ? `data: {"result":{"description":"${escaped}"}}\n\n`
                  : '{}'
          const bytes = new TextEncoder().encode(text)
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                // Neither a chunk boundary nor JSON Unicode escapes may hide a token.
                controller.enqueue(bytes.slice(0, 13))
                controller.enqueue(bytes.slice(13))
                controller.close()
              }
            }),
            { headers: location === 'header' ? { 'mcp-session-id': token } : location === 'sse' ? { 'content-type': 'text/event-stream' } : {} }
          )
        }
      })
      try {
        const error = await guard
          .fetch('https://public.example.com/mcp', { method: 'POST', body: '{}' })
          .then(response => response.text())
          .catch((caught: unknown) => caught)
        expect(error).toMatchObject({ code: 'EXTERNAL_MCP_CREDENTIAL_REFLECTED', status: 502 })
        expect(String(error)).not.toContain(token)
        expect(JSON.stringify(error)).not.toContain(token)
      } finally {
        await guard.close()
      }
    }
  )

  it('cancels credential-bearing response inspection without exposing a partial body', async () => {
    const abort = new AbortController()
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => 'fixture-only-mcp-secret',
      resolve: publicResolver,
      signal: abort.signal,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"result":{"content":['))
            },
            pull() {
              started.resolve()
            },
            cancel() {
              cancelled.resolve()
            }
          })
        )
    })
    try {
      const pending = guard.fetch('https://public.example.com/mcp').catch((caught: unknown) => caught)
      await started.promise
      abort.abort(new DOMException('User cancelled', 'AbortError'))
      expect(await pending).toHaveProperty('name', 'AbortError')
      await cancelled.promise
    } finally {
      await guard.close()
    }
  })

  it('bounds request and streaming response bytes, and closes/cancels an outstanding body', async () => {
    let calls = 0,
      cancelled = false
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => null,
      resolve: publicResolver,
      fetch: async () => {
        calls++
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(EXTERNAL_MCP_LIMITS.responseBytes + 1))
            },
            cancel() {
              cancelled = true
            }
          })
        )
      }
    })
    try {
      await expect(
        guard.fetch('https://public.example.com/mcp', { method: 'POST', body: 'x'.repeat(EXTERNAL_MCP_LIMITS.requestBytes + 1) })
      ).rejects.toMatchObject({ code: 'EXTERNAL_MCP_REQUEST_TOO_LARGE' })
      expect(calls).toBe(0)
      const response = await guard.fetch('https://public.example.com/mcp')
      await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'EXTERNAL_MCP_RESPONSE_TOO_LARGE' })
      expect(cancelled).toBe(true)
      await guard.close()
      await expect(guard.fetch('https://public.example.com/mcp')).rejects.toHaveProperty('name', 'AbortError')
      expect(calls).toBe(1)
    } finally {
      await guard.close()
    }
  })

  it('bounds byte-limit rejection and local close when a response body never acknowledges cancellation', async () => {
    const cancellationStarted = Promise.withResolvers<void>()
    const cancellationFinished = Promise.withResolvers<void>()
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => null,
      resolve: publicResolver,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(EXTERNAL_MCP_LIMITS.responseBytes + 1))
            },
            cancel() {
              cancellationStarted.resolve()
              return cancellationFinished.promise
            }
          })
        )
    })
    try {
      const response = await guard.fetch('https://public.example.com/mcp')
      const rejection = response.arrayBuffer().catch((error: unknown) => error)
      await cancellationStarted.promise
      const closing = guard.close()
      expect(await rejection).toHaveProperty('code', 'EXTERNAL_MCP_RESPONSE_TOO_LARGE')
      await closing
      await expect(guard.fetch('https://public.example.com/mcp')).rejects.toHaveProperty('name', 'AbortError')
    } finally {
      cancellationFinished.resolve()
      await guard.close()
    }
  })

  it('propagates caller cancellation during DNS without dispatching a request', async () => {
    const controller = new AbortController()
    let dispatched = false
    const resolving = Promise.withResolvers<void>()
    const unresolved = Promise.withResolvers<readonly { address: string; family: number }[]>()
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      signal: controller.signal,
      authorize: async () => {},
      credential: async () => null,
      resolve: async () => {
        resolving.resolve()
        return unresolved.promise
      },
      fetch: async () => {
        dispatched = true
        return Response.json({})
      }
    })
    try {
      const pending = guard.fetch('https://public.example.com/mcp')
      await resolving.promise
      controller.abort(new DOMException('User cancelled', 'AbortError'))
      await expect(pending).rejects.toHaveProperty('name', 'AbortError')
      expect(dispatched).toBe(false)
    } finally {
      unresolved.resolve([{ address: '93.184.216.34', family: 4 }])
      await guard.close()
    }
  })

  it('enforces the request deadline even when DNS never finishes', async () => {
    vi.useFakeTimers()
    const resolving = Promise.withResolvers<void>()
    const unresolved = Promise.withResolvers<readonly { address: string; family: number }[]>()
    let dispatched = false
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => null,
      resolve: async () => {
        resolving.resolve()
        return unresolved.promise
      },
      fetch: async () => {
        dispatched = true
        return Response.json({})
      }
    })
    try {
      const pending = guard.fetch('https://public.example.com/mcp')
      const rejection = pending.catch((error: unknown) => error)
      await resolving.promise
      await vi.advanceTimersByTimeAsync(EXTERNAL_MCP_LIMITS.timeoutMs)
      expect(await rejection).toHaveProperty('code', 'EXTERNAL_MCP_TIMEOUT')
      expect(dispatched).toBe(false)
    } finally {
      unresolved.resolve([{ address: '93.184.216.34', family: 4 }])
      await guard.close()
      vi.useRealTimers()
    }
  })
})
