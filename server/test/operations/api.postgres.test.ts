import { generateKeyPairSync } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { SystemRequester } from '../../helpers/system-authority.ts'
import { describeApiKeyGrant } from '../../operations/api-connections.ts'
import type ApiKeyModel from '../../models/apiKeys.ts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection = database.endsWith('_api_operations_test') && password
  ? {
      host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
      port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
      user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
      password,
      database
    }
  : null
const suite = connection ? describe : describe.skip
const originalWiki = Reflect.get(globalThis, 'WIKI')
const administrator: SystemRequester = { user: { id: 1, authVersion: 0 } as never }

type ApiOperations = {
  createKey(requester: SystemRequester, input: { name: unknown; expiration: unknown; fullAccess: unknown; group: unknown; mcpAccess?: unknown }): Promise<unknown>
  getConfig(requester: SystemRequester): Promise<{
    enabled: boolean
    createFullAccess: boolean
    assignableGroups: Array<{ id: number }>
    keys: Array<{ id: number; grant: { groupId: number | null }; canRevoke: boolean; isRevoked: boolean }>
  }>
  revokeKey(requester: SystemRequester, id: unknown): Promise<void>
}

suite('API credential authority operations on PostgreSQL', () => {
  let db: Knex
  let ApiKey: typeof ApiKeyModel
  let api: ApiOperations
  let delegatedApiKeyId: number
  let signingPrivateKey: string
  const reloadApiKeys = vi.fn(async () => undefined)
  const emit = vi.fn()

  const delegatedApi = (): SystemRequester => ({
    user: { id: 1, ownershipUserId: null, groups: [3] } as never,
    apiKey: {
      id: delegatedApiKeyId,
      groupId: 3,
      expiresAt: Math.floor(Date.now() / 1000) + 3600
    }
  })
  const group = (id: number, name: string, permissions: string[], isSystem = false) => ({
    id,
    name,
    permissions: JSON.stringify(permissions),
    pageRules: '[]',
    isSystem,
    adminRevision: `revision-${id}`
  })
  const createInput = (name: string, values: Record<string, unknown> = {}) => ({
    name,
    expiration: '1h',
    fullAccess: false,
    group: 4,
    ...values
  })
  const keyRow = async (key: string) => db('apiKeys').where('key', key).first()

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 6 } })
    for (const table of ['apiKeys', 'userGroups', 'users', 'groups', 'settings']) await db.schema.dropTableIfExists(table)
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.jsonb('value').notNullable()
      table.string('updatedAt').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.string('name').notNullable()
      table.jsonb('permissions').notNullable()
      table.jsonb('pageRules').notNullable()
      table.boolean('isSystem').notNullable()
      table.string('adminRevision').notNullable()
    })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').notNullable()
      table.integer('groupId').notNullable()
      table.primary(['userId', 'groupId'])
    })
    await db.schema.createTable('apiKeys', table => {
      table.increments('id').primary()
      table.string('name').notNullable()
      table.text('key').notNullable()
      table.timestamp('expiration').notNullable()
      table.boolean('isRevoked').notNullable()
      table.string('createdAt').notNullable()
      table.string('updatedAt').notNullable()
    })
    const modelModule = await vi.importFresh<{ default: typeof ApiKeyModel }>('../../models/apiKeys.ts', import.meta.url)
    ApiKey = modelModule.default
    ApiKey.knex(db)
  })

  afterAll(async () => {
    if (db) {
      for (const table of ['apiKeys', 'userGroups', 'users', 'groups', 'settings']) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
    if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
    else Reflect.set(globalThis, 'WIKI', originalWiki)
  })

  beforeEach(async () => {
    for (const table of ['apiKeys', 'userGroups', 'users', 'groups', 'settings']) await db(table).delete()
    await db('groups').insert([
      group(1, 'Administrators', ['manage:system'], true),
      group(2, 'Guests', ['read:pages'], true),
      group(3, 'API operators', ['manage:api']),
      group(4, 'Authors', ['read:pages']),
      group(5, 'User operators', ['manage:users'])
    ])
    await db('users').insert({ id: 1, isActive: true, authVersion: 0 })
    await db('userGroups').insert({ userId: 1, groupId: 1 })
    await db('apiKeys').insert({
      name: 'Delegation fixture',
      key: 'delegation-fixture',
      expiration: new Date(Date.now() + 3600000).toISOString(),
      isRevoked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    const delegationRow = await db('apiKeys').orderBy('id', 'desc').first()
    if (!delegationRow || typeof delegationRow.id !== 'number') throw new Error('API delegation fixture did not receive an id')
    delegatedApiKeyId = delegationRow.id
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    signingPrivateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    reloadApiKeys.mockReset().mockResolvedValue(undefined)
    emit.mockReset()
    Reflect.set(globalThis, 'WIKI', {
      config: {
        api: { isEnabled: true },
        agents: { mcp: { enabled: false } },
        auth: { audience: 'urn:wiki:test' },
        certs: { private: signingPrivateKey },
        host: 'https://wiki.example.test',
        sessionSecret: 'fixture-session-secret'
      },
      auth: { reloadApiKeys },
      events: { outbound: { emit } },
      models: { apiKeys: ApiKey, knex: db }
    })
    const operationModule = await vi.importFresh<{ default: ApiOperations }>('../../operations/api.ts', import.meta.url)
    api = operationModule.default
  })

  it('allows content-scoped grants while enforcing delegated authority ceilings', async () => {
    const issuedValue = await api.createKey(delegatedApi(), createInput('Content reader'))
    if (typeof issuedValue !== 'string') throw new Error('API operation did not return a signed key')
    const row = await keyRow(issuedValue)
    expect(row).toMatchObject({ name: 'Content reader', isRevoked: false })
    expect(describeApiKeyGrant(issuedValue)).toMatchObject({ groupId: 4 })

    await expect(api.createKey(delegatedApi(), createInput('User operator', { group: 5 }))).rejects.toMatchObject({
      status: 403,
      name: 'API_KEY_GRANT_FORBIDDEN'
    })
    await expect(api.createKey(delegatedApi(), { name: 'Full access', expiration: '1h', fullAccess: true, group: null })).rejects.toMatchObject({
      status: 403,
      name: 'API_KEY_GRANT_FORBIDDEN'
    })
    expect(await db('apiKeys').where('name', 'User operator')).toHaveLength(0)
  })

  it('revalidates stale human and API authority before issuing a credential', async () => {
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(api.createKey(administrator, createInput('Stale browser'))).rejects.toMatchObject({ status: 403 })

    await db('users').where('id', 1).update({ authVersion: 0 })
    await db('apiKeys').where('id', delegatedApiKeyId).update({ isRevoked: true })
    await expect(api.createKey(delegatedApi(), createInput('Stale API'))).rejects.toMatchObject({ status: 403 })

    expect(await db('apiKeys').where('name', 'Stale browser')).toHaveLength(0)
    expect(await db('apiKeys').where('name', 'Stale API')).toHaveLength(0)
  })

  it('derives bootstrap capabilities and revocation capability from current authority', async () => {
    const scopedValue = await api.createKey(administrator, createInput('Scoped key'))
    if (typeof scopedValue !== 'string') throw new Error('API operation did not return a signed key')
    const scopedRow = await keyRow(scopedValue)
    const delegatedConfig = await api.getConfig(delegatedApi())

    expect(delegatedConfig).toMatchObject({ enabled: true, createFullAccess: false })
    expect(delegatedConfig.assignableGroups.map(group => group.id)).toEqual([4])
    expect(delegatedConfig.keys.find(key => key.id === scopedRow.id)).toMatchObject({
      grant: { groupId: 4 },
      canRevoke: true,
      isRevoked: false
    })
    expect(delegatedConfig.keys.find(key => key.id === delegatedApiKeyId)).toMatchObject({ canRevoke: false })
  })

  it('uses changed target permissions and legacy grant shape to enforce revocation scope', async () => {
    const scopedValue = await api.createKey(administrator, createInput('Changed target'))
    if (typeof scopedValue !== 'string') throw new Error('API operation did not return a signed key')
    const scopedRow = await keyRow(scopedValue)
    await db('groups').where('id', 4).update({ permissions: JSON.stringify(['manage:system']), adminRevision: 'target-changed' })

    await expect(api.revokeKey(delegatedApi(), scopedRow.id)).rejects.toMatchObject({
      status: 403,
      name: 'API_KEY_GRANT_FORBIDDEN'
    })
    expect((await keyRow(scopedValue))?.isRevoked).toBe(false)

    await expect(api.revokeKey(delegatedApi(), delegatedApiKeyId)).rejects.toMatchObject({ status: 403 })
    expect((await db('apiKeys').where('id', delegatedApiKeyId).first())?.isRevoked).toBe(false)

    await api.revokeKey(administrator, scopedRow.id)
    await api.revokeKey(administrator, delegatedApiKeyId)
    expect((await keyRow(scopedValue))?.isRevoked).toBe(true)
    expect((await db('apiKeys').where('id', delegatedApiKeyId).first())?.isRevoked).toBe(true)
  })

  it('rolls back pending key activation when signing fails', async () => {
    const before = await db('apiKeys').count<{ count: string }[]>('* as count')
    const wiki = Reflect.get(globalThis, 'WIKI')
    if (!wiki || typeof wiki !== 'object') throw new Error('API test runtime is unavailable')
    const config = Reflect.get(wiki, 'config')
    if (!config || typeof config !== 'object') throw new Error('API test config is unavailable')
    const certs = Reflect.get(config, 'certs')
    if (!certs || typeof certs !== 'object') throw new Error('API test certificate config is unavailable')
    Reflect.set(certs, 'private', 'not-a-private-key')

    await expect(api.createKey(administrator, createInput('Failed signing'))).rejects.toThrow()

    expect(await db('apiKeys').count<{ count: string }[]>('* as count')).toEqual(before)
    expect(await db('apiKeys').where('name', 'Failed signing')).toHaveLength(0)
    expect(reloadApiKeys).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalledWith('reloadApiKeys')
  })
})
