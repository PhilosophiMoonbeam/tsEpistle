import { generateKeyPairSync } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import jwt from 'jsonwebtoken'
import { DateTime } from 'luxon'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up } from '../../db/migrations/tsepistle-000062-personal-mcp-keys.ts'
import { issuePersonalMcpKey, listPersonalMcpKeys, revokePersonalMcpKey } from '../../operations/personal-mcp.ts'
import { loadMcpApiPrincipal } from '../../helpers/personal-mcp.ts'
import { createApiPrincipal, isApiPrincipal, rejectApiPrincipalMutation } from '../../helpers/api-principal.ts'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import { requireSystemAuthority } from '../../helpers/system-authority.ts'

const connection = getPostgresTestConnection('_personal_mcp_test', import.meta.path)
const suite = connection ? describe : describe.skip
const originalWiki = Reflect.get(globalThis, 'WIKI')
const owner = { id: 42, ownershipUserId: 42 } as Express.User
const other = { id: 43, ownershipUserId: 43 } as Express.User
const input = { name: 'My MCP client', expirationDays: 30, access: 'read-only' }

suite('personal MCP credential authority on PostgreSQL', () => {
  let db: Knex
  let runtime: { config: { agents: { enabled: boolean }; certs: { private: string } } }
  const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKey = keypair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const publicKey = keypair.publicKey.export({ format: 'pem', type: 'spki' }).toString()

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary(); table.boolean('isActive').notNullable()
      table.string('name'); table.string('email'); table.string('pictureUrl'); table.string('timezone'); table.string('localeCode')
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary(); table.string('name').notNullable().defaultTo('Group'); table.jsonb('permissions').notNullable(); table.jsonb('pageRules').notNullable()
      table.string('adminRevision').notNullable().defaultTo('revision')
    })
    await db.schema.createTable('userGroups', table => { table.integer('userId'); table.integer('groupId') })
    await db.schema.createTable('apiKeys', table => {
      table.increments('id').primary(); table.string('name').notNullable(); table.text('key').notNullable()
      table.string('expiration').notNullable(); table.boolean('isRevoked').notNullable()
      table.string('createdAt').notNullable(); table.string('updatedAt').notNullable()
    })
    await db.schema.createTable('tags', table => { table.integer('id').primary(); table.string('tag'); table.integer('redirectToId'); table.boolean('isArchived') })
    const now = new Date().toISOString()
    await db('apiKeys').insert({ name: 'Existing service key', key: 'existing-secret', expiration: '2099-01-01T00:00:00.000Z', isRevoked: false, createdAt: now, updatedAt: now })
    await up(db)
    expect(await db('apiKeys').first()).toMatchObject({ key: 'existing-secret', personalOwnerId: null, personalAccess: null, isRevoked: false })
  })
  beforeEach(async () => {
    for (const table of ['apiKeys', 'userGroups', 'users', 'groups']) await db(table).delete()
    await db('users').insert([
      { id: 42, isActive: true, name: 'Owner', email: 'owner@example.test', timezone: 'UTC', localeCode: 'en' },
      { id: 43, isActive: true, name: 'Other', email: 'other@example.test', timezone: 'UTC', localeCode: 'en' }
    ])
    await db('groups').insert([
      { id: 1, permissions: JSON.stringify(['manage:system']), pageRules: '[]' },
      { id: 3, permissions: JSON.stringify(['use:agents', 'use:mcp', 'read:pages', 'read:source', 'write:pages']), pageRules: '[]' },
      { id: 4, permissions: JSON.stringify(['read:history']), pageRules: '[]' }
    ])
    await db('userGroups').insert([{ userId: 42, groupId: 3 }, { userId: 42, groupId: 4 }, { userId: 43, groupId: 3 }])
    const wiki = {
      config: { api: { isEnabled: true }, agents: { enabled: true, mcp: { enabled: true } }, auth: { audience: 'urn:wiki:test' },
        certs: { private: privateKey }, sessionSecret: 'fixture-secret', host: 'https://wiki.example.test' },
      models: { knex: db },
      auth: { reloadApiKeys: vi.fn(async () => {}) },
      configSvc: { saveToDb: vi.fn(async () => {}) },
      events: { inbound: { on: vi.fn() }, outbound: { emit: vi.fn() } },
      lang: { t: (key: string) => key },
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      startedAt: DateTime.utc().minus({ days: 1 })
    }
    runtime = wiki
    Reflect.set(globalThis, 'WIKI', wiki)
  })
  afterAll(async () => {
    if (db) { for (const table of ['apiKeys', 'userGroups', 'users', 'groups', 'tags']) await db.schema.dropTableIfExists(table); await db.destroy() }
    if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI'); else Reflect.set(globalThis, 'WIKI', originalWiki)
  })

  it('issues a finite, resource-bound MCP credential and never lists its secret', async () => {
    const issued = await issuePersonalMcpKey(owner, '42', input)
    const claims = jwt.verify(issued.key, publicKey, { algorithms: ['RS256'], audience: 'urn:wiki:test', issuer: 'urn:wiki.js' })
    expect(claims).toMatchObject({ api: issued.item.id, grp: 1, personalMcp: 1, personalOwnerId: 42, personalAccess: 'read-only', mcpResource: 'https://wiki.example.test/mcp' })
    expect(claims).not.toHaveProperty('id')
    if (typeof claims !== 'object') throw new Error('Expected signed object claims')
    expect(claims.exp! - claims.iat!).toBe(30 * 86_400)
    const listed = await listPersonalMcpKeys(owner, '42')
    expect(listed.keys).toEqual([issued.item]); expect(JSON.stringify(listed)).not.toContain(issued.key)
    const principal = await loadMcpApiPrincipal(issued.item.id, 1)
    expect(principal).toMatchObject({ ownershipUserId: 42, personalMcpAccess: 'read-only', groups: [3, 4] })
    expect(principal).not.toHaveProperty('id'); expect(isApiPrincipal(principal)).toBe(true)
    expect(() => rejectApiPrincipalMutation(principal)).toThrow('API-key principals cannot perform direct mutations.')
    expect(principal.permissions).toContain('read:history'); expect(principal.permissions).not.toContain('manage:system')
  })

  it('isolates ownership and preserves list/revoke after issuance eligibility is lost', async () => {
    const issued = await issuePersonalMcpKey(owner, '42', input)
    expect((await listPersonalMcpKeys(other, '43')).keys).toEqual([])
    await expect(revokePersonalMcpKey(other, '43', issued.item.id)).rejects.toMatchObject({ status: 404 })
    await expect(listPersonalMcpKeys(owner, '43')).rejects.toMatchObject({ status: 409 })
    await db('userGroups').where({ userId: 42 }).delete()
    runtime.config.agents.enabled = false
    expect(await listPersonalMcpKeys(owner, '42')).toMatchObject({ canIssue: false, keys: [issued.item] })
    await expect(issuePersonalMcpKey(owner, '42', input)).rejects.toMatchObject({ status: 403 })
    await revokePersonalMcpKey(owner, '42', issued.item.id)
    expect((await db('apiKeys').where({ id: issued.item.id }).first()).isRevoked).toBe(true)
  })

  it('rechecks membership, permissions, owner status, expiry and revocation on every resolution', async () => {
    const issued = await issuePersonalMcpKey(owner, '42', { ...input, access: 'read-write' })
    await db('userGroups').where({ userId: 42, groupId: 4 }).delete()
    expect((await loadMcpApiPrincipal(issued.item.id, 1)).permissions).not.toContain('read:history')
    await db('groups').where({ id: 3 }).update({ permissions: JSON.stringify(['use:agents', 'read:pages']) })
    await expect(loadMcpApiPrincipal(issued.item.id, 1)).rejects.toMatchObject({ status: 403 })
    await db('groups').where({ id: 3 }).update({ permissions: JSON.stringify(['use:agents', 'use:mcp', 'read:pages']) })
    await db('users').where({ id: 42 }).update({ isActive: false })
    await expect(loadMcpApiPrincipal(issued.item.id, 1)).rejects.toMatchObject({ status: 401 })
    await db('users').where({ id: 42 }).update({ isActive: true })
    await db('apiKeys').where({ id: issued.item.id }).update({ expiration: '2000-01-01T00:00:00Z' })
    await expect(loadMcpApiPrincipal(issued.item.id, 1)).rejects.toMatchObject({ status: 401 })
    await db('apiKeys').where({ id: issued.item.id }).update({ expiration: '2099-01-01T00:00:00Z', isRevoked: true })
    await expect(loadMcpApiPrincipal(issued.item.id, 1)).rejects.toMatchObject({ status: 401 })
  })

  it('never falls back to the transport binding group and keeps owner-deleted keys personal', async () => {
    const issued = await issuePersonalMcpKey(owner, '42', input)
    await expect(loadMcpApiPrincipal(issued.item.id, 3)).rejects.toMatchObject({ status: 401 })
    await db('userGroups').where({ userId: 42 }).delete()
    await expect(loadMcpApiPrincipal(issued.item.id, 1)).rejects.toMatchObject({ status: 403 })
    await db('users').where({ id: 42 }).delete()
    expect(await db('apiKeys').where({ id: issued.item.id }).first()).toMatchObject({ personalOwnerId: null, personalAccess: 'read-only' })
    await expect(loadMcpApiPrincipal(issued.item.id, 1)).rejects.toMatchObject({ status: 401 })
  })

  it('loads all current owner page rules rather than the transport binding group rules', async () => {
    const issued = await issuePersonalMcpKey(owner, '42', input)
    const principal = await loadMcpApiPrincipal(issued.item.id, 1)
    const rule = { match: 'START', path: 'docs', deny: false, roles: ['read:pages'], locales: ['en'] }
    await db('groups').where({ id: 3 }).update({ pageRules: JSON.stringify([rule]) })
    expect(auth.checkPageAccess(principal, ['read:pages'], { path: 'docs/one', locale: 'en' }, await loadPageRuleAuthority(principal))).toBe(true)
    expect(auth.checkPageAccess(principal, ['read:pages'], { path: 'private/one', locale: 'en' }, await loadPageRuleAuthority(principal))).toBe(false)
    await db('groups').where({ id: 3 }).update({ pageRules: JSON.stringify([{ ...rule, deny: true }]) })
    expect(auth.checkPageAccess(principal, ['read:pages'], { path: 'docs/one', locale: 'en' }, await loadPageRuleAuthority(principal))).toBe(false)
  })

  it('cannot become browser or system authority even when personal metadata is stripped', async () => {
    const issued = await issuePersonalMcpKey(owner, '42', input)
    const personal = await loadMcpApiPrincipal(issued.item.id, 1)
    await expect(Promise.resolve(db.transaction(tx => requireSystemAuthority(tx, { user: personal })))).rejects.toMatchObject({ status: 403 })
    const disguised = createApiPrincipal(issued.item.id, 1, ['manage:system'])
    await expect(Promise.resolve(db.transaction(tx => requireSystemAuthority(tx, {
      user: disguised, apiKey: { id: issued.item.id, groupId: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
    })))).rejects.toMatchObject({ status: 403 })
  })

  it('rejects API principals, guests, unbounded grants and signing failures without persisting keys', async () => {
    await expect(issuePersonalMcpKey({ api: 7, grp: 1 } as Express.User, '42', input)).rejects.toMatchObject({ status: 401 })
    await expect(issuePersonalMcpKey({ id: 2 } as Express.User, '2', input)).rejects.toMatchObject({ status: 401 })
    for (const expirationDays of [0, 91, 1.5, Number.POSITIVE_INFINITY])
      await expect(issuePersonalMcpKey(owner, '42', { ...input, expirationDays })).rejects.toMatchObject({ status: 400 })
    await expect(issuePersonalMcpKey(owner, '42', { ...input, group: 1 })).rejects.toMatchObject({ status: 400 })
    runtime.config.certs.private = 'invalid-signing-key'
    await expect(issuePersonalMcpKey(owner, '42', input)).rejects.toThrow()
    expect(await db('apiKeys')).toHaveLength(0)
  })
})
