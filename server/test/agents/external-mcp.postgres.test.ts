import { randomUUID } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { ExternalMcpService, EXTERNAL_MCP_LIMITS, type ExternalMcpFetchImplementation } from '../../agents/external-mcp.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { up } from '../../db/migrations/tsepistle-000050-agent-external-mcp.ts'

import { up as addGoogleOAuth } from '../../db/migrations/tsepistle-000063-google-workspace-mcp-oauth.ts'
import { up as addGenericOAuth } from '../../db/migrations/tsepistle-000064-generic-mcp-oauth.ts'
import { up as retireOAuthPresets } from '../../db/migrations/tsepistle-000065-retire-mcp-oauth-presets.ts'
import { up as addSecrets } from '../../db/migrations/2.5.141.ts'
const connection = getPostgresTestConnection('_agents_test', import.meta.path)
const suite = connection ? describe : describe.skip
const schema = `external_mcp_${randomUUID().replaceAll('-', '')}`
const admin = { id: 1, authVersion: 0 },
  owner = { id: 7, authVersion: 0 },
  other = { id: 8, authVersion: 0 }
const keyring = { currentKeyId: 'test', keys: { test: Buffer.alloc(32, 19) } }
const input = () => ({
  displayName: 'Research MCP',
  endpointUrl: `https://mcp.example.com/${randomUUID()}`,
  status: 'enabled' as const,
  authMode: 'none' as const
})

suite('PostgreSQL external MCP configuration and live authorization', () => {
  let db: Knex, service: ExternalMcpService, vault: DatabaseAgentSecretRegistry
  let networkCalls = 0
  let refreshCalls = 0
  let authorizationExchanges = 0
  let refreshStarted: PromiseWithResolvers<void> | undefined
  let refreshReleased: PromiseWithResolvers<void> | undefined
  const protocol: ExternalMcpFetchImplementation = async (url, init) => {
    if (url.hostname === 'identity.vendor.test') {
      const body = new URLSearchParams(String(init.body))
      expect(url.pathname).toBe('/token')
      if (body.get('grant_type') === 'authorization_code') authorizationExchanges++
      if (body.get('grant_type') === 'refresh_token') {
        refreshCalls++
        refreshStarted?.resolve()
        await refreshReleased?.promise
      }
      return Response.json({ access_token: `controlled-access-${refreshCalls}`, refresh_token: 'controlled-refresh', token_type: 'Bearer', expires_in: 3_600,
        scope: 'read' })
    }
    networkCalls++
    const message = JSON.parse(String(init.body)) as { method: string; id: string }
    let result: unknown
    if (message.method === 'server/discover')
      result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' }
    else if (message.method === 'tools/list')
      result = { resultType: 'complete', tools: [{ name: 'research', inputSchema: { type: 'object', properties: {} } }], ttlMs: 0, cacheScope: 'private' }
    else if (message.method === 'tools/call') result = { resultType: 'complete', content: [{ type: 'text', text: 'External result' }] }
    else throw new Error(`Unexpected method ${message.method}`)
    return Response.json({ jsonrpc: '2.0', id: message.id, result })
  }
  const dependencies = (database: Knex) => ({
    knex: database,
    secrets: new DatabaseAgentSecretRegistry(database, keyring),
    enabled: () => true,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: protocol,
    oauth: { siteOrigin: 'https://wiki.example.test' }
  })

  beforeAll(async () => {
    const adminDb = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await adminDb.raw(`CREATE SCHEMA "${schema}"`)
    } finally {
      await adminDb.destroy()
    }
    db = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 4 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.jsonb('permissions').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.integer('groupId').notNullable().references('id').inTable('groups').onDelete('CASCADE')
      table.primary(['userId', 'groupId'])
    })
    await addSecrets(db)
    await up(db)
    await addGoogleOAuth(db)
    await addGenericOAuth(db)
    await retireOAuthPresets(db)
  })
  beforeEach(async () => {
    await db('agentExternalMcpGrants').delete()
    await db('agentExternalMcpServers').delete()
    await db('agentExternalMcpGroupPolicies').delete()
    await db('agentProviderSecrets').delete()
    await db('userGroups').delete()
    await db('groups').delete()
    await db('users').delete()
    await db('users').insert([1, 7, 8].map(id => ({ id, isActive: true, authVersion: 0 })))
    await db('groups').insert([
      { id: 10, permissions: JSON.stringify(['manage:system']) },
      { id: 20, permissions: JSON.stringify(['use:agents']) },
      { id: 30, permissions: JSON.stringify(['use:agents']) }
    ])
    await db('userGroups').insert([
      { userId: 1, groupId: 10 },
      { userId: 7, groupId: 20 },
      { userId: 8, groupId: 30 }
    ])
    vault = new DatabaseAgentSecretRegistry(db, keyring)
    service = new ExternalMcpService(dependencies(db))
    networkCalls = 0
    refreshCalls = 0
    authorizationExchanges = 0
    refreshStarted = undefined
    refreshReleased = undefined
  })
  afterAll(async () => {
    if (db) await db.destroy()
    const adminDb = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await adminDb.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await adminDb.destroy()
    }
  })
  it('upgrades the real legacy schema without discarding encrypted Google grants or existing none/bearer endpoints', async () => {
    const legacySchema = `legacy_oauth_${randomUUID().replaceAll('-', '')}`
    await db.raw(`CREATE SCHEMA "${legacySchema}"`)
    const legacy = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [legacySchema], pool: { min: 0, max: 2 } })
    try {
      await legacy.schema.createTable('users', table => { table.integer('id').primary(); table.boolean('isActive').notNullable(); table.integer('authVersion').notNullable() })
      await legacy.schema.createTable('groups', table => { table.integer('id').primary(); table.jsonb('permissions').notNullable() })
      await legacy.schema.createTable('userGroups', table => { table.integer('userId').references('id').inTable('users').onDelete('CASCADE'); table.integer('groupId').references('id').inTable('groups').onDelete('CASCADE') })
      await addSecrets(legacy)
      await up(legacy)
      await addGoogleOAuth(legacy)
      await legacy('users').insert([{ id: 1, isActive: true, authVersion: 0 }, { id: 7, isActive: true, authVersion: 0 }])
      await legacy('groups').insert([{ id: 10, permissions: JSON.stringify(['manage:system']) }, { id: 20, permissions: JSON.stringify(['use:agents']) }])
      await legacy('userGroups').insert([{ userId: 1, groupId: 10 }, { userId: 7, groupId: 20 }])
      const legacyVault = new DatabaseAgentSecretRegistry(legacy, keyring)
      const grantId = randomUUID(), googleId = randomUUID(), bearerId = randomUUID(), noneId = randomUUID()
      const saved = await legacy.transaction(async tx => {
        const bearer = await legacyVault.store('legacy-bearer', 7, tx)
        const token = await legacyVault.store(JSON.stringify({ accessToken: 'legacy-google-access', refreshToken: 'legacy-google-refresh', expiresAt: 0, scopes: ['legacy.read'] }), 7, tx)
        const pending = await legacyVault.store('legacy-pkce-verifier', 7, tx)
        const base = { displayName: 'Existing endpoint', scope: 'admin', ownerId: null, status: 'enabled', revision: 1, createdBy: 1, updatedBy: 1, createdAt: new Date(), updatedAt: new Date() }
        await tx('agentExternalMcpServers').insert([
          { ...base, id: googleId, endpointUrl: 'https://gmailmcp.googleapis.com/mcp/v1', authMode: 'google', secretReference: null },
          { ...base, id: bearerId, endpointUrl: 'https://mcp.example.com/bearer', authMode: 'bearer', secretReference: bearer },
          { ...base, id: noneId, endpointUrl: 'https://mcp.example.com/none', authMode: 'none', secretReference: null }
        ])
        await tx('agentExternalMcpGrants').insert([googleId, bearerId, noneId].map(serverId => ({ serverId, groupId: 20 })))
        await tx('agentExternalMcpOAuthGrants').insert({ id: grantId, userId: 7, serverId: googleId, serverRevision: 1, authVersion: 0, authorizationStamp: '20', secretReference: token })
        await tx('agentExternalMcpOAuthPending').insert({ stateHash: 'a'.repeat(64), grantId, sessionHash: 'b'.repeat(64), secretReference: pending, expiresAt: new Date(Date.now() + 60_000) })
        return { bearer, token, pending }
      })
      await legacy.transaction(tx => addGenericOAuth(tx))
      await retireOAuthPresets(legacy)
      const migrated = new ExternalMcpService(dependencies(legacy))
      await expect(migrated.oauthStatus(owner, googleId)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
      expect(await legacy('agentExternalMcpServers').where('id', googleId).first('authMode', 'status', 'revision', 'oauthConfiguration', 'retiredOAuthConfiguration')).toEqual({
        authMode: 'oauth', status: 'disabled', revision: 2, oauthConfiguration: JSON.stringify({ registrationMode: 'preregistered' }),
        retiredOAuthConfiguration: JSON.stringify({ preset: 'google-workspace', registrationMode: 'preregistered' })
      })
      expect(await legacy('agentExternalMcpOAuthGrants').where('id', grantId).first('binding', 'secretReference')).toEqual({ binding: null, secretReference: saved.token })
      expect(await legacyVault.get(saved.token)).toContain('legacy-google-refresh')
      expect(await legacyVault.get(saved.pending)).toBe('legacy-pkce-verifier')
      expect(await legacyVault.get(saved.bearer)).toBe('legacy-bearer')
      expect((await migrated.listAdmin(admin)).filter(endpoint => endpoint.authMode !== 'oauth').map(endpoint => endpoint.authMode).sort()).toEqual(['bearer', 'none'])
      await expect(migrated.connectOAuth(owner, googleId, 'retired-browser')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    } finally {
      await legacy.destroy()
      await db.raw(`DROP SCHEMA "${legacySchema}" CASCADE`)
    }
  })

  const genericDependencies = (database: Knex) => ({
    ...dependencies(database), oauth: { siteOrigin: 'https://wiki.example.test' },
    fetch: async (url: URL, init: Parameters<ExternalMcpFetchImplementation>[1]) => {
      if (url.href === 'https://mcp.vendor.test/mcp' && !new Headers(init.headers).has('authorization')) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.vendor.test/metadata"' } })
      if (url.href === 'https://mcp.vendor.test/metadata') return Response.json({ resource: 'https://mcp.vendor.test/mcp', authorization_servers: ['https://identity.vendor.test'], scopes_supported: ['read'] })
      if (url.href === 'https://identity.vendor.test/.well-known/oauth-authorization-server') return Response.json({ issuer: 'https://identity.vendor.test', authorization_endpoint: 'https://identity.vendor.test/authorize', token_endpoint: 'https://identity.vendor.test/token', registration_endpoint: 'https://identity.vendor.test/register', token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'], code_challenge_methods_supported: ['S256'] })
      if (url.href === 'https://identity.vendor.test/register') return Response.json({ client_id: 'native-dynamic', token_endpoint_auth_method: 'none' })
      return protocol(url, init)
    }
  })

  it.each(['preregistered', 'automatic'] as const)('cleans personal %s OAuth client and registration secrets before production RESTRICT checks', async registrationMode => {
    const generic = new ExternalMcpService(genericDependencies(db))
    await generic.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
    const endpoint = await generic.createPersonal(owner, { ...input(), endpointUrl: 'https://mcp.vendor.test/mcp', authMode: 'oauth', oauth: {
      registrationMode, ...(registrationMode === 'preregistered' ? { issuer: 'https://identity.vendor.test', clientId: 'native-static', clientSecretValue: 'native-static-secret', tokenEndpointAuthMethod: 'client_secret_basic' as const } : {})
    } })
    await generic.connectOAuth(owner, endpoint.id, 'native-browser')
    expect(await db('agentProviderSecrets').where('createdBy', owner.id)).not.toHaveLength(0)
    await db('users').where('id', owner.id).delete()
    expect(await db('agentExternalMcpServers').where('id', endpoint.id)).toEqual([])
    expect(await db('agentExternalMcpOAuthRegistrations')).toEqual([])
    expect(await db('agentProviderSecrets').where('createdBy', owner.id)).toEqual([])
  })

  it('removes only OAuth-owned shared registration secrets on creator deletion and reconnects surviving null-creator endpoints', async () => {
    const generic = new ExternalMcpService(genericDependencies(db))
    const endpoint = await generic.createAdmin(admin, { ...input(), endpointUrl: 'https://mcp.vendor.test/mcp', authMode: 'oauth', oauth: { registrationMode: 'automatic' }, groupIds: [20, 30] })
    await generic.connectOAuth(owner, endpoint.id, 'first-owner')
    await db('users').where('id', admin.id).delete()
    expect(await db('agentExternalMcpServers').where('id', endpoint.id).first('createdBy')).toEqual({ createdBy: null })
    expect(await db('agentExternalMcpOAuthRegistrations')).toEqual([])
    expect(new URL((await generic.connectOAuth(other, endpoint.id, 'surviving-owner')).authorizationUrl).searchParams.get('client_id')).toBe('native-dynamic')
  })

  it('serializes generic refresh across processes and prevents disconnect racing refresh from resurrecting stale native clients', async () => {
    const second = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 4 } })
    service = new ExternalMcpService(genericDependencies(db))
    const otherProcess = new ExternalMcpService(genericDependencies(second))
    const endpoint = await service.createAdmin(admin, { ...input(), endpointUrl: 'https://mcp.vendor.test/mcp', authMode: 'oauth', oauth: { registrationMode: 'automatic' }, groupIds: [20] })
    const authorization = new URL((await service.connectOAuth(owner, endpoint.id, 'browser')).authorizationUrl)
    const callback = { state: authorization.searchParams.get('state')!, code: 'controlled-code', sessionId: 'browser' }
    expect((await Promise.all([service.oauthCallback(owner, { ...callback, callbackPath: '/agents/oauth/callback' }), otherProcess.oauthCallback(owner, { ...callback, callbackPath: '/agents/oauth/callback' })])).sort()).toEqual(['connected', 'error'])
    expect(authorizationExchanges).toBe(1)
    const expire = async () => db.transaction(async tx => {
      const grant = await tx('agentExternalMcpOAuthGrants').where({ userId: owner.id, serverId: endpoint.id }).first('id', 'secretReference')
      const token = JSON.parse((await vault.get(grant.secretReference, tx))!)
      const secretReference = await vault.store(JSON.stringify({ ...token, expiresAt: 0 }), owner.id, tx)
      await tx('agentExternalMcpOAuthGrants').where('id', grant.id).update({ secretReference })
      await vault.delete(grant.secretReference, tx)
    })
    try {
      await expire()
      refreshStarted = Promise.withResolvers<void>()
      refreshReleased = Promise.withResolvers<void>()
      const first = service.discoverForUser(owner, endpoint.id)
      await refreshStarted.promise
      const concurrent = otherProcess.discoverForUser(owner, endpoint.id)
      refreshReleased.resolve()
      await Promise.all([first, concurrent])
      expect(refreshCalls).toBe(1)
      const staleLease = await service.openForUser(owner.id, { serverIds: [endpoint.id] })
      try {
        await staleLease.inspectCatalog(endpoint.id)
        await expire()
        refreshStarted = Promise.withResolvers<void>()
        refreshReleased = Promise.withResolvers<void>()
        const inFlight = staleLease.clients[0]!.callTool('research', {})
        await refreshStarted.promise
        const disconnect = otherProcess.disconnectOAuth(owner, endpoint.id)
        refreshReleased.resolve()
        await Promise.allSettled([inFlight, disconnect])
        await disconnect
        expect(await db('agentExternalMcpOAuthGrants')).toEqual([])
        expect(await db('agentExternalMcpOAuthGrants').whereNotNull('secretReference')).toEqual([])
        const before = networkCalls
        await expect(staleLease.clients[0]!.callTool('research', {})).rejects.toMatchObject({ code: 'EXTERNAL_MCP_RECONNECT_REQUIRED' })
        expect(networkCalls).toBe(before)
      } finally { await staleLease.close() }
    } finally { refreshReleased?.resolve(); await second.destroy() }
  })

  it('cascades pending PKCE and token secrets on account deletion', async () => {
    service = new ExternalMcpService(genericDependencies(db))
    const endpoint = await service.createAdmin(admin, { ...input(), endpointUrl: 'https://mcp.vendor.test/mcp', authMode: 'oauth', oauth: { registrationMode: 'preregistered', issuer: 'https://identity.vendor.test', clientId: 'manual-client', tokenEndpointAuthMethod: 'none' }, groupIds: [20, 30] })
    const authorization = new URL((await service.connectOAuth(owner, endpoint.id, 'browser')).authorizationUrl)
    expect(await service.oauthCallback(owner, { state: authorization.searchParams.get('state')!, code: 'code', sessionId: 'browser', callbackPath: '/agents/oauth/callback' })).toBe('connected')
    await service.connectOAuth(other, endpoint.id, 'other-browser')
    expect(await db('agentProviderSecrets').where('createdBy', owner.id).orWhere('createdBy', other.id)).toHaveLength(2)
    await db('users').where('id', owner.id).delete()
    expect(await db('agentProviderSecrets').where('createdBy', owner.id).orWhere('createdBy', other.id)).toHaveLength(1)
    await db('users').where('id', other.id).delete()
    expect(await db('agentExternalMcpOAuthPending')).toEqual([])
    expect(await db('agentExternalMcpOAuthGrants')).toEqual([])
    expect(await db('agentProviderSecrets').where('createdBy', owner.id).orWhere('createdBy', other.id)).toEqual([])
  })
  it('preserves the production RESTRICT boundary for unrelated provider secrets when deleting a user', async () => {
    service = new ExternalMcpService(genericDependencies(db))
    const endpoint = await service.createAdmin(admin, { ...input(), endpointUrl: 'https://mcp.vendor.test/mcp', authMode: 'oauth', oauth: { registrationMode: 'preregistered', issuer: 'https://identity.vendor.test', clientId: 'manual-client', tokenEndpointAuthMethod: 'none' }, groupIds: [20] })
    await service.connectOAuth(owner, endpoint.id, 'browser')
    const unrelated = await db.transaction(tx => vault.store('unrelated-provider-credential', owner.id, tx))
    await expect(Promise.resolve(db('users').where('id', owner.id).delete())).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|23001)$/) })
    expect(await db('users').where('id', owner.id).first('id')).toEqual({ id: owner.id })
    expect(await vault.has(unrelated)).toBe(true)
    expect(await db('agentExternalMcpOAuthPending')).toHaveLength(1)
    expect(await db('agentProviderSecrets').where('createdBy', owner.id)).toHaveLength(2)
  })

  it('persists admin group grants and denies claimed admin authority and ungranted discovery without network', async () => {
    const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    expect(await db('agentExternalMcpGrants').where('serverId', server.id).select('groupId')).toEqual([{ groupId: 20 }])
    expect((await service.listAdmin(admin))[0]).toMatchObject({ id: server.id, revision: 1, groupIds: [20] })
    expect((await service.listForUser(owner))[0]?.id).toBe(server.id)
    expect(await service.listForUser(other)).toEqual([])
    await expect(service.discoverForUser(other, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(
      service.createAdmin({ ...owner, permissions: ['manage:system'], groups: [10] } as never, { ...input(), groupIds: [30] })
    ).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(networkCalls).toBe(0)
    await db('userGroups').where({ userId: 1, groupId: 10 }).delete()
    await expect(service.setAdminGrants(admin, server.id, 1, { groupIds: [30] })).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(await db('agentExternalMcpGrants').where('serverId', server.id).select('groupId')).toEqual([{ groupId: 20 }])
  })

  it('separates configuration discovery authority from runtime grants and sees revocation across connections', async () => {
    const second = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 2 } })
    const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    try {
      await lease.inspectCatalog(server.id)
      expect((await service.discoverForUser(admin, server.id)).catalog.tools[0]?.name).toBe('research')
      const before = networkCalls
      await expect(service.openForUser(admin.id, { serverIds: [server.id] })).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
      await new ExternalMcpService(dependencies(second)).setAdminGrants(admin, server.id, server.revision, { groupIds: [] })
      await expect(lease.inspectCatalog(server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
      await expect(lease.clients[0]!.callTool('research', {})).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
      expect(networkCalls).toBe(before)
      // Removing runtime grants does not remove the administrator's configuration authority.
      expect((await service.discoverForUser(admin, server.id)).catalog.tools[0]?.name).toBe('research')
      const after = networkCalls
      await second('groups')
        .where('id', 10)
        .update({ permissions: JSON.stringify(['use:agents']) })
      await expect(service.discoverForUser(admin, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
      expect(networkCalls).toBe(after)
    } finally {
      await lease.close()
      await second.destroy()
    }
  })

  it('persists personal group permission with owner isolation and encrypted endpoint-only credentials', async () => {
    await expect(service.createPersonal(owner, input())).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    const policy = await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
    await service.setGroupPolicy(admin, 30, { allowPersonalEndpoints: true }, 0)
    expect(policy).toEqual({ groupId: 20, revision: 1, allowPersonalEndpoints: true })
    const unrelated = await db.transaction(tx => vault.store('unrelated-provider-secret', admin.id, tx))
    await expect(service.createPersonal(owner, { ...input(), authMode: 'bearer', secretReference: unrelated } as never)).rejects.toMatchObject({
      code: 'INVALID_EXTERNAL_MCP_CONFIGURATION'
    })
    const server = await service.createPersonal(owner, { ...input(), authMode: 'bearer', secretValue: 'personal-mcp-secret' })
    const stored = await db('agentExternalMcpServers').where('id', server.id).first('secretReference', 'ownerId', 'scope')
    expect(stored).toMatchObject({ ownerId: 7, scope: 'personal' })
    expect(stored.secretReference).toMatch(/^managed:/)
    expect(stored.secretReference).not.toBe(unrelated)
    const encrypted = await db('agentProviderSecrets').where('id', stored.secretReference.slice('managed:'.length)).first('ciphertext', 'authTag')
    expect(Buffer.from(encrypted.ciphertext).toString('utf8')).not.toContain('personal-mcp-secret')
    expect(Buffer.from(encrypted.authTag).byteLength).toBe(16)
    const views = JSON.stringify([server, await service.listPersonal(owner), await service.listForUser(owner)])
    expect(views).not.toContain('personal-mcp-secret')
    expect(views).not.toContain('managed:')
    expect(server.secretConfigured).toBe(true)
    expect(await service.listPersonal(other)).toEqual([])
    await expect(service.updatePersonal(other, server.id, 1, input())).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(service.deletePersonal(other, server.id, 1)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await service.deletePersonal(owner, server.id, 1)
    expect(await vault.has(stored.secretReference)).toBe(false)
    expect(await vault.get(unrelated)).toBe('unrelated-provider-secret')
    expect(networkCalls).toBe(0)
  })

  it('rejects group permission revocation between discovery and native invocation across database connections', async () => {
    const second = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 2 } })
    const policy = await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
    const server = await service.createPersonal(owner, input())
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    try {
      const discovered = await lease.inspectCatalog(server.id)
      expect(discovered.catalog.tools[0]?.name).toBe('research')
      const before = networkCalls
      await new ExternalMcpService(dependencies(second)).setGroupPolicy(admin, 20, { allowPersonalEndpoints: false }, policy.revision)
      await expect(lease.clients[0]!.callTool('research', {})).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
      await expect(lease.inspectCatalog(server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
      await lease.close()
      expect(networkCalls).toBe(before)
      expect(await service.listForUser(owner)).toEqual([])
    } finally {
      await lease.close()
      await second.destroy()
    }
  })

  it('serializes optimistic edits and personal cap checks across connections without duplicate vault writes', async () => {
    const second = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 2 } })
    const service2 = new ExternalMcpService(dependencies(second))
    try {
      const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
      const edits = await Promise.allSettled([
        service.setAdminGrants(admin, server.id, 1, { groupIds: [20] }),
        service2.setAdminGrants(admin, server.id, 1, { groupIds: [30] })
      ])
      expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(edits.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect(edits.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'EXTERNAL_MCP_REVISION_CHANGED' } })
      expect(await db('agentExternalMcpServers').where('id', server.id).first('revision')).toMatchObject({ revision: 2 })
      await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
      for (let index = 0; index < EXTERNAL_MCP_LIMITS.personalEndpoints - 1; index++) await service.createPersonal(owner, input())
      const creations = await Promise.allSettled([
        service.createPersonal(owner, { ...input(), authMode: 'bearer', secretValue: 'first-mcp-key' }),
        service2.createPersonal(owner, { ...input(), authMode: 'bearer', secretValue: 'second-mcp-key' })
      ])
      expect(creations.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(creations.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'EXTERNAL_MCP_PERSONAL_LIMIT' } })
      expect(await db('agentExternalMcpServers').where('ownerId', 7)).toHaveLength(EXTERNAL_MCP_LIMITS.personalEndpoints)
      expect(await db('agentProviderSecrets').select('id')).toHaveLength(1)
    } finally {
      await second.destroy()
    }
  })

  it('invalid groups roll back atomically and a changed account session cannot alter saved policy', async () => {
    await expect(service.createAdmin(admin, { ...input(), authMode: 'bearer', secretValue: 'never-stored-key', groupIds: [999] })).rejects.toMatchObject({
      code: 'INVALID_EXTERNAL_MCP_GRANTS'
    })
    expect(await db('agentExternalMcpServers')).toEqual([])
    expect(await db('agentProviderSecrets')).toEqual([])
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: false }, 1)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(await db('agentExternalMcpGroupPolicies').where('groupId', 20).first()).toMatchObject({ revision: 1, allowPersonalEndpoints: true })
  })
})
