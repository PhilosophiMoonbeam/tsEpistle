import knexModule, { type Knex } from 'knex'
import type { SystemRequester } from '../../helpers/system-authority.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const port = Number(process.env.WIKI_TEST_POSTGRES_PORT)
const connection =
  database.endsWith('_api_state_test') && password
    ? { host: '127.0.0.1', ...(Number.isInteger(port) && port > 0 ? { port } : {}), user: 'wiki', database, password }
    : null
const suite = connection ? describe : describe.skip
const originalWiki = globalThis.WIKI
const administrator = { user: { id: 1, authVersion: 0 } } as never

interface ApiStateOperations {
  setState(requester: SystemRequester, enabled: unknown): Promise<void>
}

suite('API availability state persistence on PostgreSQL', () => {
  let db: Knex
  let api: ApiStateOperations
  let emit: (event: string) => void

  const setting = async () => (await db('settings').where('key', 'api').first())?.value
  const runtime = () => ({
    config: { api: { isEnabled: true, runtimeOnly: 'deployment-default' } },
    configSvc: { saveToDb: vi.fn(async () => false) },
    events: { outbound: { emit } },
    models: { knex: db }
  })

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.jsonb('value').notNullable()
      table.string('updatedAt').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.jsonb('permissions').notNullable()
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
      table.integer('id').primary()
      table.boolean('isRevoked').notNullable()
      table.timestamp('expiration').notNullable()
    })
  })

  afterAll(async () => {
    if (!db) return
    for (const table of ['apiKeys', 'userGroups', 'users', 'groups', 'settings']) await db.schema.dropTableIfExists(table)
    await db.destroy()
    globalThis.WIKI = originalWiki
  })

  beforeEach(async () => {
    for (const table of ['apiKeys', 'userGroups', 'users', 'groups', 'settings']) await db(table).delete()
    await db('groups').insert([
      { id: 1, permissions: JSON.stringify(['manage:system']), adminRevision: 'system-manager' },
      { id: 3, permissions: JSON.stringify(['manage:api']), adminRevision: 'api-manager' }
    ])
    await db('users').insert({ id: 1, isActive: true, authVersion: 0 })
    await db('userGroups').insert({ userId: 1, groupId: 1 })
    await db('apiKeys').insert({ id: 7, isRevoked: false, expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
    await db('settings').insert({
      key: 'api',
      value: JSON.stringify({ isEnabled: true, durableOnly: 'retain this setting' }),
      updatedAt: '2026-09-07T00:00:00.000Z'
    })
    emit = vi.fn()
    globalThis.WIKI = runtime() as never
    api = (await vi.importFresh('../../operations/api.ts', import.meta.url)).default
  })

  it('writes the current durable API row after a nested runtime config replacement and preserves unrelated fields', async () => {
    const stale = globalThis.WIKI.config.api
    globalThis.WIKI.config.api = { isEnabled: true, runtimeOnly: 'reloaded-canonical-object' }

    await api.setState(administrator, false)

    expect(stale.isEnabled).toBe(true)
    expect(globalThis.WIKI.config.api).toEqual({ isEnabled: false, runtimeOnly: 'reloaded-canonical-object' })
    expect(await setting()).toEqual({ isEnabled: false, durableOnly: 'retain this setting' })
    expect(globalThis.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('reloadConfig')
  })

  it('does not publish a failed durable write to the current runtime', async () => {
    await db.raw("CREATE FUNCTION reject_api_state_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'api-state fixture failure'; END; $$;")
    await db.raw('CREATE TRIGGER reject_api_state_write BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION reject_api_state_write();')
    try {
      await expect(api.setState(administrator, false)).rejects.toThrow('api-state fixture failure')
    } finally {
      await db.raw('DROP TRIGGER IF EXISTS reject_api_state_write ON settings; DROP FUNCTION IF EXISTS reject_api_state_write();')
    }

    expect(globalThis.WIKI.config.api.isEnabled).toBe(true)
    expect(await setting()).toEqual({ isEnabled: true, durableOnly: 'retain this setting' })
    expect(emit).not.toHaveBeenCalled()
  })

  it('serializes concurrent state writes in request order', async () => {
    await Promise.all([api.setState(administrator, false), api.setState(administrator, true)])

    expect(globalThis.WIKI.config.api.isEnabled).toBe(true)
    expect(await setting()).toEqual({ isEnabled: true, durableOnly: 'retain this setting' })
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('rejects an inactive human account before changing the durable row', async () => {
    await db('users').where('id', 1).update({ isActive: false })

    await expect(api.setState(administrator, false)).rejects.toMatchObject({ status: 403 })

    expect(globalThis.WIKI.config.api.isEnabled).toBe(true)
    expect((await setting()).isEnabled).toBe(true)
  })

  it('rejects a revoked browser session before changing the durable row', async () => {
    await db('users').where('id', 1).update({ authVersion: 1 })

    await expect(api.setState(administrator, false)).rejects.toMatchObject({ status: 403 })

    expect(globalThis.WIKI.config.api.isEnabled).toBe(true)
    expect((await setting()).isEnabled).toBe(true)
  })

  it('rejects a revoked group permission before changing the durable row', async () => {
    await db('groups').where('id', 1).update({ permissions: JSON.stringify([]), adminRevision: 'revoked' })

    await expect(api.setState(administrator, false)).rejects.toMatchObject({ status: 403 })

    expect(globalThis.WIKI.config.api.isEnabled).toBe(true)
    expect((await setting()).isEnabled).toBe(true)
  })

  it('allows a current delegated manage:api API principal', async () => {
    await api.setState({
      user: { id: 1, ownershipUserId: null, groups: [3] },
      apiKey: { id: 7, groupId: 3, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
    } as never, false)

    expect(globalThis.WIKI.config.api.isEnabled).toBe(false)
    expect((await setting()).isEnabled).toBe(false)
  })
})
