import { randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { up as addSecrets } from '../../db/migrations/2.5.141.ts'
import { up as addEndpoints } from '../../db/migrations/tsepistle-000050-agent-external-mcp.ts'
import { up as addGoogleOAuth } from '../../db/migrations/tsepistle-000063-google-workspace-mcp-oauth.ts'
import { up as addGenericOAuth } from '../../db/migrations/tsepistle-000064-generic-mcp-oauth.ts'
import * as genericOAuthMigration from '../../db/migrations/tsepistle-000064-generic-mcp-oauth.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { ExternalMcpService } from '../../agents/external-mcp.ts'
import { up as retireOAuthPresets } from '../../db/migrations/tsepistle-000065-retire-mcp-oauth-presets.ts'

describe('SQLite legacy external MCP OAuth forward upgrade', () => {
  let db: Knex, vault: DatabaseAgentSecretRegistry
  let googleId: string, bearerId: string, noneId: string, grantId: string
  let tokenReference: string, pendingReference: string, bearerReference: string
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    await db.raw('PRAGMA foreign_keys = ON')
    await db.schema.createTable('users', table => { table.integer('id').primary(); table.boolean('isActive').notNullable(); table.integer('authVersion').notNullable() })
    await db.schema.createTable('groups', table => { table.integer('id').primary(); table.text('permissions').notNullable() })
    await db.schema.createTable('userGroups', table => { table.integer('userId').references('id').inTable('users').onDelete('CASCADE'); table.integer('groupId').references('id').inTable('groups').onDelete('CASCADE') })
    await addSecrets(db)
    await addEndpoints(db)
    await addGoogleOAuth(db)
    await db('users').insert([{ id: 1, isActive: true, authVersion: 0 }, { id: 7, isActive: true, authVersion: 0 }])
    await db('groups').insert([{ id: 10, permissions: JSON.stringify(['manage:system']) }, { id: 20, permissions: JSON.stringify(['use:agents']) }])
    await db('userGroups').insert([{ userId: 1, groupId: 10 }, { userId: 7, groupId: 20 }])
    vault = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'migration', keys: { migration: Buffer.alloc(32, 29) } })
    googleId = randomUUID(); bearerId = randomUUID(); noneId = randomUUID(); grantId = randomUUID()
    await db.transaction(async tx => {
      bearerReference = await vault.store('retained-bearer-credential', 7, tx)
      tokenReference = await vault.store(JSON.stringify({ accessToken: 'sealed-legacy-access', refreshToken: 'sealed-legacy-refresh', expiresAt: 0, scopes: ['legacy.read'] }), 7, tx)
      pendingReference = await vault.store('retained-legacy-pkce-verifier', 7, tx)
      const common = { displayName: 'Existing endpoint', scope: 'admin', ownerId: null, status: 'enabled', revision: 1, createdBy: 1, updatedBy: 1, createdAt: new Date(), updatedAt: new Date() }
      await tx('agentExternalMcpServers').insert([
        { ...common, id: googleId, endpointUrl: 'https://gmailmcp.googleapis.com/mcp/v1', authMode: 'google', secretReference: null },
        { ...common, id: bearerId, endpointUrl: 'https://mcp.example.com/bearer', authMode: 'bearer', secretReference: bearerReference },
        { ...common, id: noneId, endpointUrl: 'https://mcp.example.com/none', authMode: 'none', secretReference: null }
      ])
      await tx('agentExternalMcpGrants').insert([googleId, bearerId, noneId].map(serverId => ({ serverId, groupId: 20 })))
      await tx('agentExternalMcpOAuthGrants').insert({ id: grantId, userId: 7, serverId: googleId, serverRevision: 1, authVersion: 0, authorizationStamp: '20', secretReference: tokenReference })
      await tx('agentExternalMcpOAuthPending').insert({ stateHash: 'a'.repeat(64), grantId, sessionHash: 'b'.repeat(64), secretReference: pendingReference, expiresAt: new Date(Date.now() + 60_000) })
    })
    await db.schema.createTable('endpointUpgradeAudit', table => { table.increments('id'); table.uuid('serverId'); table.text('displayName'); table.integer('endpointCount').defaultTo(0) })
    await db.raw('CREATE INDEX external_mcp_custom_lookup ON "agentExternalMcpServers" ("displayName")')
    await db.raw('CREATE VIEW external_mcp_saved_view AS SELECT id, "authMode" FROM "agentExternalMcpServers"')
    await db.raw(`CREATE TRIGGER external_mcp_saved_update AFTER UPDATE OF "displayName" ON "agentExternalMcpServers" BEGIN INSERT INTO "endpointUpgradeAudit" ("serverId", "displayName") VALUES (NEW.id, NEW."displayName"); END`)
    await db.raw(`CREATE TRIGGER external_mcp_dependent_audit AFTER INSERT ON "endpointUpgradeAudit" BEGIN UPDATE "endpointUpgradeAudit" SET "endpointCount" = (SELECT count(*) FROM "agentExternalMcpServers") WHERE id = NEW.id; END`)
  })
  afterEach(async () => { await db.destroy() })

  it('preserves referenced grants, PKCE, ciphertext, indexes, triggers and views while migrating saved Google rows', async () => {
    const secrets = await db('agentProviderSecrets').orderBy('id').select('*')
    const pending = await db('agentExternalMcpOAuthPending').select('*')
    const groups = await db('agentExternalMcpGrants').orderBy('serverId').select('*')
    const ordinary = await db('agentExternalMcpServers').whereIn('id', [bearerId, noneId]).orderBy('id').select('*')
    const objects = await db('sqlite_master').whereIn('name', ['external_mcp_custom_lookup', 'external_mcp_saved_update', 'external_mcp_saved_view', 'external_mcp_dependent_audit']).orderBy('name').select('name', 'type', 'sql')
    const migrationSource: Knex.MigrationSource<string> = {
      getMigrations: async () => ['tsepistle-000064-generic-mcp-oauth'],
      getMigrationName: migration => migration,
      getMigration: async () => genericOAuthMigration
    }
    await db.migrate.latest({ migrationSource })
    expect(await db.raw('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([])
    expect(await db('agentProviderSecrets').orderBy('id').select('*')).toEqual(secrets)
    expect(await db('agentExternalMcpOAuthPending').select('*')).toEqual(pending)
    expect(await db('agentExternalMcpGrants').orderBy('serverId').select('*')).toEqual(groups)
    for (const row of ordinary) expect(await db('agentExternalMcpServers').where('id', row.id).first()).toMatchObject(row)
    expect(await db('agentExternalMcpServers').where('id', googleId).first('authMode', 'oauthConfiguration')).toEqual({ authMode: 'oauth', oauthConfiguration: JSON.stringify({ preset: 'google-workspace', registrationMode: 'preregistered' }) })
    expect(await db('agentExternalMcpOAuthGrants').where('id', grantId).first('binding', 'secretReference')).toEqual({ binding: null, secretReference: tokenReference })
    expect(await db('sqlite_master').whereIn('name', objects.map(object => object.name)).orderBy('name').select('name', 'type', 'sql')).toEqual(objects)
    expect(await db('external_mcp_saved_view').where('id', googleId).first()).toEqual({ id: googleId, authMode: 'oauth' })
    await db('agentExternalMcpServers').where('id', googleId).update({ displayName: 'Preserved trigger' })
    expect(await db('endpointUpgradeAudit').first('serverId', 'displayName', 'endpointCount')).toEqual({ serverId: googleId, displayName: 'Preserved trigger', endpointCount: 3 })
    await retireOAuthPresets(db)
    const service = new ExternalMcpService({ knex: db, secrets: vault, enabled: () => true, oauth: { siteOrigin: 'https://wiki.example.test' } })
    await expect(service.oauthStatus({ id: 7, authVersion: 0 }, googleId)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect((await service.listAdmin({ id: 1, authVersion: 0 })).find(endpoint => endpoint.id === googleId)).toMatchObject({ status: 'disabled', revision: 2, oauth: { registrationMode: 'preregistered', clientSecretConfigured: false } })
    expect(await vault.get(tokenReference)).toContain('sealed-legacy-refresh')
    expect(await vault.get(pendingReference)).toBe('retained-legacy-pkce-verifier')
    await expect(Promise.resolve(db('agentExternalMcpServers').where('id', googleId).update({ authMode: 'google' }))).rejects.toThrow()
    await db('agentExternalMcpServers').where('id', googleId).delete()
    expect(await db('agentExternalMcpOAuthGrants')).toEqual([])
    expect(await db('agentExternalMcpOAuthPending')).toEqual([])
    expect(await db('agentExternalMcpGrants').where('serverId', googleId)).toEqual([])
    expect(await vault.get(tokenReference)).toBeNull()
    expect(await vault.get(pendingReference)).toBeNull()
    expect(await vault.get(bearerReference)).toBe('retained-bearer-credential')
    await expect(Promise.resolve(db('users').where('id', 7).delete())).rejects.toThrow()
  })

  it('retires bound presets without mutating sealed grants, registrations or PKCE, and requires explicit generic setup', async () => {
    await addGenericOAuth(db)
    const clientReference = await db.transaction(tx => vault.store('sealed-old-client-secret', 1, tx))
    const oldBinding = JSON.stringify({ callbackUrl: 'https://wiki.example.test/agents/oauth/google/callback', configurationHash: 'old-preset-binding' })
    await db('agentExternalMcpServers').where('id', googleId).update({ oauthClientSecretReference: clientReference })
    await db('agentExternalMcpOAuthGrants').where('id', grantId).update({ binding: oldBinding })
    await db('agentExternalMcpOAuthRegistrations').insert({ serverId: googleId, configurationHash: 'c'.repeat(64), binding: oldBinding, secretReference: clientReference })
    const genericId = randomUUID()
    const base = await db('agentExternalMcpServers').where('id', noneId).first()
    await db('agentExternalMcpServers').insert({ ...base, id: genericId, authMode: 'oauth', oauthConfiguration: JSON.stringify({ registrationMode: 'automatic' }) })
    const ordinary = await db('agentExternalMcpServers').whereIn('id', [bearerId, noneId, genericId]).orderBy('id').select('*')
    const secrets = await db('agentProviderSecrets').orderBy('id').select('*')
    const grants = await db('agentExternalMcpOAuthGrants').select('*')
    const pending = await db('agentExternalMcpOAuthPending').select('*')
    const registrations = await db('agentExternalMcpOAuthRegistrations').select('*')
    await retireOAuthPresets(db)
    expect(await db('agentProviderSecrets').orderBy('id').select('*')).toEqual(secrets)
    expect(await db('agentExternalMcpOAuthGrants').select('*')).toEqual(grants)
    expect(await db('agentExternalMcpOAuthPending').select('*')).toEqual(pending)
    expect(await db('agentExternalMcpOAuthRegistrations').select('*')).toEqual(registrations)
    for (const endpoint of ordinary) expect(await db('agentExternalMcpServers').where('id', endpoint.id).first()).toMatchObject(endpoint)
    expect(await db('agentExternalMcpServers').where('id', googleId).first('status', 'revision', 'oauthConfiguration', 'retiredOAuthConfiguration', 'oauthClientSecretReference')).toEqual({
      status: 'disabled', revision: 2, oauthConfiguration: JSON.stringify({ registrationMode: 'preregistered' }),
      retiredOAuthConfiguration: JSON.stringify({ preset: 'google-workspace', registrationMode: 'preregistered' }), oauthClientSecretReference: clientReference
    })
    const service = new ExternalMcpService({ knex: db, secrets: vault, enabled: () => true, oauth: { siteOrigin: 'https://wiki.example.test' }, fetch: async () => { throw new Error('Retired endpoint must not perform network requests') } })
    await expect(service.connectOAuth({ id: 7, authVersion: 0 }, googleId, 'browser')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    const update = { displayName: 'Explicit generic connection', endpointUrl: 'https://mcp.example.com/generic', authMode: 'oauth' as const, status: 'enabled' as const }
    await expect(service.updateAdmin({ id: 1, authVersion: 0 }, googleId, 2, update)).rejects.toMatchObject({ code: 'INVALID_EXTERNAL_MCP_CONFIGURATION' })
    expect(await vault.get(tokenReference)).toContain('sealed-legacy-refresh')
    const configured = await service.updateAdmin({ id: 1, authVersion: 0 }, googleId, 2, { ...update, oauth: { registrationMode: 'preregistered', issuer: 'https://identity.example.com', clientId: 'new-client', tokenEndpointAuthMethod: 'none' } })
    expect(configured).toMatchObject({ status: 'enabled', revision: 3, oauth: { clientId: 'new-client', clientSecretConfigured: false } })
    expect(await db('agentExternalMcpOAuthGrants').where('serverId', googleId)).toEqual([])
    expect(await db('agentExternalMcpOAuthRegistrations').where('serverId', googleId)).toEqual([])
    expect(await vault.get(tokenReference)).toBeNull()
    expect(await vault.get(pendingReference)).toBeNull()
    expect(await vault.get(clientReference)).toBeNull()
    expect(await vault.get(bearerReference)).toBe('retained-bearer-credential')
  })

  it('rolls back schema changes and restores foreign-key enforcement if reconstruction cannot start', async () => {
    await db.schema.createTable('agentExternalMcpServers_oauth_upgrade', table => { table.integer('unrelatedMarker') })
    const endpoints = await db('agentExternalMcpServers').orderBy('id').select('*')
    const secrets = await db('agentProviderSecrets').orderBy('id').select('*')
    await expect(addGenericOAuth(db)).rejects.toThrow()
    expect(await db.raw('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([])
    expect(await db('agentExternalMcpServers').orderBy('id').select('*')).toEqual(endpoints)
    expect(await db('agentProviderSecrets').orderBy('id').select('*')).toEqual(secrets)
    expect(await db('agentExternalMcpOAuthPending').first('secretReference')).toEqual({ secretReference: pendingReference })
    expect(await db.schema.hasColumn('agentExternalMcpServers', 'oauthConfiguration')).toBe(false)
  })
})
