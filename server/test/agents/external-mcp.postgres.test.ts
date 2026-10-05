import { randomUUID } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { ExternalMcpService, EXTERNAL_MCP_LIMITS, type ExternalMcpFetchImplementation } from '../../agents/external-mcp.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { up } from '../../db/migrations/tsepistle-000050-agent-external-mcp.ts'

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
  const protocol: ExternalMcpFetchImplementation = async (_url, init) => {
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
    fetch: protocol
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
    await db.schema.createTable('agentProviderSecrets', table => {
      table.uuid('id').primary()
      table.string('keyId').notNullable()
      table.string('algorithm').notNullable()
      table.binary('nonce').notNullable()
      table.binary('ciphertext').notNullable()
      table.binary('authTag').notNullable()
      table.integer('createdBy').notNullable()
      table.timestamp('createdAt', { useTz: true }).notNullable()
    })
    await up(db)
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
