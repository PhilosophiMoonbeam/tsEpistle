import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import express, { type ErrorRequestHandler } from 'express'
import knexModule, { type Knex } from 'knex'
import { DateTime } from 'luxon'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import type UserModel from '../../models/users.ts'
import type UserKeyModel from '../../models/userKeys.ts'
import { up as personalKeysUp } from '../../db/migrations/tsepistle-000062-personal-mcp-keys.ts'
import { up as glossaryUp } from '../../db/migrations/tsepistle-000056-glossary.ts'
import { issuePersonalMcpKey, listPersonalMcpKeys, revokePersonalMcpKey } from '../../operations/personal-mcp.ts'
import { loadMcpApiPrincipal } from '../../helpers/personal-mcp.ts'
import { accountAdministration } from '../../operations/account-administration.ts'
import { getAuthenticationAdministrationStore } from '../../operations/authentication-administration.ts'
import { createGroupAdministrationStore } from '../../operations/group-administration.ts'
import { createGlossaryOperations, type GlossaryOperations } from '../../operations/glossary.ts'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import { createWikiMcpController } from '../../agents/mcp.ts'
import errors from '../../helpers/error.ts'

const connection = getPostgresTestConnection('_personal_mcp_lifecycle_test', import.meta.path)
const suite = connection ? describe : describe.skip
const previousWiki = Reflect.get(globalThis, 'WIKI')
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const permissions = ['use:agents', 'use:mcp', 'read:glossary', 'manage:glossary', 'read:pages', 'write:pages']
const keyInput = { name: 'Lifecycle client', access: 'read-only', expirationDays: 30 }
const admin = { id: 1, authVersion: 0 } as Express.User
const owner = { id: 42, ownershipUserId: 42, authVersion: 0 } as Express.User
const runtime = {
  Error: errors,
  config: {
    title: 'Personal credential lifecycle', host: 'http://127.0.0.1', sessionSecret: 'lifecycle-signing-secret', lang: { code: 'en' },
    api: { isEnabled: true }, agents: { enabled: true, mcp: { enabled: true } }, features: { featurePageComments: false },
    auth: { audience: 'urn:wiki:lifecycle', tokenExpiration: '1h', tokenRenewal: '15m', enforce2FA: false },
    certs: {
      private: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      public: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    }
  },
  data: { authentication: [
    { key: 'local', title: 'Local', isAvailable: true, useForm: true, props: {} },
    { key: 'oidc', title: 'Organization', isAvailable: true, useForm: false, props: { issuer: { type: 'string', default: '' } } }
  ] },
  models: {} as { knex: Knex; users: typeof UserModel; userKeys: typeof UserKeyModel; [key: string]: unknown },
  auth: {
    reloadApiKeys: vi.fn(async () => auth.reloadApiKeys()),
    revokeUserTokens: vi.fn((input: { id: number; kind: 'u' }) => auth.revokeUserTokens(input)),
    activateStrategies: () => auth.activateStrategies(),
    get strategyStatus() { return auth.strategyStatus }
  },
  configSvc: { saveToDb: vi.fn(async () => {}) },
  events: { inbound: { on: vi.fn((_event: string, _listener: (value: unknown) => void) => {}) }, outbound: { emit: vi.fn((_event: string, _payload?: unknown) => {}) } },
  lang: { t: (key: string) => key },
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  startedAt: DateTime.utc().minus({ days: 1 })
}

suite('mounted native personal MCP security lifecycle on PostgreSQL', () => {
  let db: Knex, server: Server | undefined, url: URL
  let users: typeof UserModel, userKeys: typeof UserKeyModel
  let glossary: GlossaryOperations
  let clients: Client[] = []
  const currentOwner = async () => ({ ...owner, authVersion: (await db('users').where('id', 42).first()).authVersion })
  const review = async () => ({ fingerprint: (await accountAdministration().inspect(admin, 42)).fingerprint, reason: 'Review personal credential security lifecycle' })
  const connect = async (bearer: string) => {
    const client = new Client({ name: 'native-lifecycle', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: { token: async () => bearer } }))
    return client
  }
  const denied = async (bearer: string) => {
    const response = await fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'old-bearer', version: '1' } } })
    })
    await response.text()
    expect([401, 403, 404]).toContain(response.status)
  }
  const readNative = async (client: Client) => {
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    expect(tools).toContain('wiki_list_glossary')
    expect(tools).not.toContain('wiki_prepare_page_create')
    const result = await client.callTool({ name: 'wiki_list_glossary', arguments: { locale: 'en', limit: 1 } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ items: [{ term: 'Lifecycle fact' }], complete: true })
  }
  const saveProvider = async (change: (provider: { isEnabled: boolean; displayName: string; config: Record<string, unknown> }) => void) => {
    const workspace = await getAuthenticationAdministrationStore().inspect(admin)
    change(workspace.providers.find(row => row.key === 'organization')!)
    return getAuthenticationAdministrationStore().save(admin, { providers: workspace.providers, fingerprint: workspace.fingerprint, reason: 'Review provider credential security policy' })
  }
  const waitBlocked = async (sql: string, blocker: number) => {
    let pid: number | undefined
    await vi.waitFor(async () => {
      const result = await db.raw<{ rows: Array<{ pid: number }> }>(
        'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ? = ANY(pg_blocking_pids(pid)) AND query LIKE ?',
        [blocker, `%${sql}%`]
      )
      expect(result.rows[0]).toBeDefined()
      pid = result.rows[0]!.pid
    }, { timeout: 5000 })
    return pid!
  }
  const withGate = async (
    table: 'apiKeys' | 'groups',
    event: 'INSERT' | 'UPDATE',
    work: (gate: { pid: number; release(): Promise<void>; track<T>(job: Promise<T>): Promise<T> }) => Promise<void>
  ) => {
    await db.raw(`CREATE FUNCTION personal_lifecycle_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext(current_database()), 35135); RETURN NEW; END $$`)
    await db.raw(`CREATE TRIGGER personal_lifecycle_gate BEFORE ${event} ON ?? FOR EACH ROW EXECUTE FUNCTION personal_lifecycle_gate()`, [table])
    const transaction = await db.transaction()
    const jobs: Promise<unknown>[] = []
    let released = false
    const release = async () => { if (!released) { await transaction.commit(); released = true } }
    try {
      const identity = await transaction.raw<{ rows: Array<{ pid: number }> }>('SELECT pg_backend_pid() AS pid')
      await transaction.raw('SELECT pg_advisory_xact_lock(hashtext(current_database()), 35135)')
      await work({
        pid: identity.rows[0]!.pid,
        release,
        track: job => { jobs.push(job); void job.catch(() => {}); return job }
      })
    } finally {
      await release()
      await Promise.allSettled(jobs)
      await db.raw('DROP TRIGGER personal_lifecycle_gate ON ??', [table])
      await db.raw('DROP FUNCTION personal_lifecycle_gate()')
    }
  }
  const prepareSecurity = async (event: 'account' | 'password' | 'recovery' | 'provider' | 'group') => {
    if (event === 'account') {
      const input = await review()
      return async () => { await accountAdministration().act(admin, 42, { ...input, action: 'deactivate' }) }
    }
    if (event === 'password') return async () => { await users.updateUser({ id: 42, newPassword: 'replacement-password-123!' }) }
    if (event === 'recovery') {
      const token = await userKeys.generateToken({ userId: 42, kind: 'resetPwd', expectedAuthVersion: 0 })
      return async () => { await users.resetPassword({ token, newPassword: 'replacement-password-123!' }) }
    }
    if (event === 'provider') {
      await db('users').where('id', 42).update({ providerKey: 'organization' })
      const workspace = await getAuthenticationAdministrationStore().inspect(admin)
      workspace.providers.find(provider => provider.key === 'organization')!.isEnabled = false
      return async () => {
        await getAuthenticationAdministrationStore().save(admin, {
          providers: workspace.providers, fingerprint: workspace.fingerprint, reason: 'Review concurrent provider invalidation'
        })
      }
    }
    const store = createGroupAdministrationStore({ db })
    const workspace = await store.inspect(admin, 3)
    return async () => {
      await store.savePolicy(admin, 3, {
        fingerprint: workspace.fingerprint, reason: 'Review concurrent group policy suspension',
        policy: { name: workspace.name, description: workspace.description, redirectOnLogin: workspace.redirectOnLogin, pageRules: workspace.pageRules, permissions: permissions.filter(permission => permission !== 'use:mcp') }
      })
    }
  }
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await db.schema.createTable('settings', table => { table.string('key').primary(); table.jsonb('value') })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      for (const name of ['name', 'email', 'password', 'providerKey', 'handle', 'pictureUrl', 'timezone', 'localeCode', 'location', 'jobTitle', 'tfaSecret', 'createdAt', 'updatedAt', 'lastLoginAt']) table.string(name)
      for (const name of ['isActive', 'isVerified']) table.boolean(name).notNullable().defaultTo(true)
      for (const name of ['isSystem', 'tfaIsActive', 'mustChangePwd']) table.boolean(name).notNullable().defaultTo(false)
      table.integer('authVersion').notNullable().defaultTo(0); table.string('adminRevision').notNullable().defaultTo('')
      table.timestamp('sessionsRevokedAt')
      for (const name of ['dateFormat', 'timeFormat', 'appearance', 'fontFamily']) table.string(name).notNullable().defaultTo('')
      table.boolean('reduceMotion').notNullable().defaultTo(false); table.boolean('underlineLinks').notNullable().defaultTo(false)
      table.string('contentTextSize').notNullable().defaultTo('default'); table.string('communicationLocale')
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary(); table.string('name'); table.jsonb('permissions'); table.jsonb('pageRules').notNullable().defaultTo('[]')
      table.boolean('isSystem').notNullable().defaultTo(false); table.string('adminRevision').notNullable().defaultTo('')
      table.string('description').notNullable().defaultTo(''); table.string('redirectOnLogin').notNullable().defaultTo('/')
      table.string('updatedAt').notNullable().defaultTo('2026-01-01T00:00:00Z')
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').references('users.id').onDelete('CASCADE'); table.integer('groupId').references('groups.id').onDelete('CASCADE')
      table.primary(['userId', 'groupId'])
    })
    await db.schema.createTable('userKeys', table => {
      table.increments('id'); table.integer('userId').references('users.id').onDelete('CASCADE'); table.string('kind'); table.string('token')
      table.integer('authVersion'); table.string('validUntil'); table.string('createdAt')
    })
    await db.schema.createTable('authentication', table => {
      table.string('key').primary(); table.string('strategyKey'); table.string('displayName'); table.string('description').defaultTo('')
      table.boolean('isEnabled').notNullable().defaultTo(true); table.boolean('selfRegistration').notNullable().defaultTo(false)
      table.integer('order').notNullable().defaultTo(0); table.jsonb('config'); table.jsonb('domainWhitelist'); table.jsonb('autoEnrollGroups')
      table.string('adminRevision').notNullable().defaultTo('')
    })
    await db.schema.createTable('userAdministrationEvents', table => {
      table.increments('id'); table.integer('userId'); table.integer('actorId'); table.string('action'); table.text('reason'); table.jsonb('details'); table.timestamp('createdAt')
    })
    await db.schema.createTable('authenticationAdministrationEvents', table => {
      table.increments('id'); table.integer('actorId'); table.text('reason'); table.jsonb('changes'); table.timestamp('createdAt')
    })
    await db.schema.createTable('groupAdministrationEvents', table => {
      table.increments('id'); table.integer('groupId'); table.integer('actorId'); table.string('action'); table.text('reason'); table.jsonb('details'); table.timestamp('createdAt')
    })
    await db.schema.createTable('navigation', table => { table.string('key').primary(); table.jsonb('config') })
    for (const name of ['agentProviderGrants', 'agentSkillGrants']) await db.schema.createTable(name, table => { table.integer('groupId') })
    await db.schema.createTable('apiKeys', table => {
      table.increments('id'); table.string('name'); table.text('key'); table.string('expiration'); table.boolean('isRevoked'); table.string('createdAt'); table.string('updatedAt')
    })
    await personalKeysUp(db)
    await db.schema.createTable('pages', table => {
      table.integer('id').primary(); table.integer('ownerId'); table.string('visibility'); table.integer('creatorId'); table.integer('authorId')
    })
    await db.schema.createTable('pageHistory', table => {
      table.integer('id').primary(); table.integer('ownerId'); table.string('visibility'); table.integer('authorId')
    })
    for (const name of ['comments', 'assets']) await db.schema.createTable(name, table => { table.integer('id').primary(); table.integer('authorId') })
    await db.schema.createTable('tags', table => { table.integer('id').primary(); table.string('tag'); table.integer('redirectToId'); table.boolean('isArchived') })
    await glossaryUp(db)
    Reflect.set(globalThis, 'WIKI', runtime)
    // These models capture WIKI at evaluation; install the complete isolated runtime before loading them.
    users = (await import('../../models/users.ts')).default.bindKnex(db)
    userKeys = (await import('../../models/userKeys.ts')).default.bindKnex(db)
    runtime.models = {
      knex: db, users, userKeys,
      apiKeys: { query: () => db('apiKeys') },
      authentication: { getStrategies: async () => [], getStrategy: async (key: string) => db('authentication').where({ key }).first() },
      pageHistory: { addVersion: async () => { throw new Error('No page source is modified by this lifecycle fixture') } }
    }
    await auth.activateStrategies(true)
    glossary = createGlossaryOperations({ db, enabled: () => true, loadAuthority: loadPageRuleAuthority })
  })
  const mount = async () => {
    const unused = async (): Promise<never> => { throw new Error('Unexpected page operation in glossary lifecycle regression') }
    const controller = createWikiMcpController({
      knex: db, authenticate: auth.authenticate.bind(auth), resolvePrincipal: (id, group) => loadMcpApiPrincipal(id, group),
      resolveUser: async id => {
        const user = await users.query().findById(id)
        if (!user) throw new Error('Approver is unavailable')
        return { id: user.id, ownershipUserId: user.id, authVersion: user.authVersion }
      },
      glossary: { operations: glossary, enabled: () => true },
      operations: { search: unused, searchTags: unused, listTags: unused, discover: unused, get: unused, getByPath: unused, getHistory: unused, getVersion: unused, listRecent: unused, listLinks: unused, listRelated: unused, create: unused, update: unused, move: unused, restore: unused, remove: unused, authorizeMutation: unused },
      config: {
        get enabled() { return runtime.config.agents.mcp.enabled }, wikiPublicOrigin: runtime.config.host,
        get agentsEnabled() { return runtime.config.agents.enabled }, skillsEnabled: false, proposalsEnabled: true, writesEnabled: true,
        writeCreateEnabled: true, writePatchEnabled: true, writeMoveEnabled: true, writeRestoreEnabled: true, writeDeleteEnabled: true,
        requestStateKeys: [Buffer.alloc(32, 7)], snapshotSigningSecret: Buffer.alloc(32, 8)
      }
    })
    const app = express()
    app.use(auth.passport.initialize())
    app.all('/mcp', auth.authenticate.bind(auth), controller)
    app.use(((error, _req, res, _next) => res.status(Number(error.status) || 500).json({ error: error.name })) as ErrorRequestHandler)
    server = app.listen(0, '127.0.0.1')
    const listening = Promise.withResolvers<void>()
    server.once('listening', listening.resolve)
    await listening.promise
    url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
  }
  beforeEach(async () => {
    Reflect.set(globalThis, 'WIKI', runtime)
    for (const table of ['glossaryTermRelations', 'glossaryNames', 'glossaryTerms', 'apiKeys', 'userKeys', 'userAdministrationEvents', 'authenticationAdministrationEvents', 'groupAdministrationEvents', 'navigation', 'agentProviderGrants', 'agentSkillGrants', 'userGroups', 'users', 'groups', 'authentication', 'settings', 'pageHistory', 'pages', 'comments', 'assets', 'tags']) await db(table).delete()
    const now = new Date().toISOString()
    await db('users').insert([
      { id: 1, name: 'Administrator', email: 'admin@example.test', providerKey: 'local', isSystem: true, timezone: 'UTC', localeCode: 'en', createdAt: now, updatedAt: now },
      { id: 42, name: 'Owner', email: 'owner@example.test', providerKey: 'local', timezone: 'UTC', localeCode: 'en', location: '', jobTitle: '', createdAt: now, updatedAt: now },
      { id: 43, name: 'Independent owner', email: 'other@example.test', providerKey: 'local', timezone: 'UTC', localeCode: 'en', createdAt: now, updatedAt: now }
    ])
    await db('groups').insert([
      { id: 1, name: 'Administrators', permissions: JSON.stringify(['manage:system']), isSystem: true },
      { id: 3, name: 'MCP readers', permissions: JSON.stringify(permissions), pageRules: JSON.stringify([{ id: 'glossary-access', match: 'EXACT', path: 'glossary', deny: false, roles: ['read:glossary', 'manage:glossary'], locales: ['en'] }]) }
    ])
    await db('userGroups').insert([{ userId: 1, groupId: 1 }, { userId: 42, groupId: 3 }, { userId: 43, groupId: 3 }])
    await db('authentication').insert([
      { key: 'local', strategyKey: 'local', displayName: 'Local', config: '{}', domainWhitelist: '{"v":[]}', autoEnrollGroups: '{"v":[]}' },
      { key: 'organization', strategyKey: 'oidc', displayName: 'Organization', order: 1, config: '{"issuer":"https://identity.example.test"}', domainWhitelist: '{"v":[]}', autoEnrollGroups: '{"v":[]}' }
    ])
    runtime.config.api.isEnabled = true; runtime.config.agents.enabled = true; runtime.config.agents.mcp.enabled = true
    runtime.auth.reloadApiKeys.mockImplementation(async () => auth.reloadApiKeys())
    runtime.events.inbound.on.mockImplementation(() => {})
    runtime.events.outbound.emit.mockImplementation(() => {})
    vi.clearAllMocks()
    await glossary.create({ requester: owner, sessionId: 'owner-glossary-session' }, {
      locale: 'en', term: 'Lifecycle fact', expansion: '', definition: 'Canonical retained glossary definition.', category: '', aliases: [], relatedIds: [],
      documentationPageId: null, documentationLabel: '', references: [], caseSensitive: false, autoLink: false
    })
    await mount()
  })
  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => {})
    clients = []
    if (server) {
      const closed = Promise.withResolvers<void>()
      server.close(error => error ? closed.reject(error) : closed.resolve())
      await closed.promise
      server = undefined
    }
  })
  afterAll(async () => {
    if (db) {
      for (const table of ['glossaryTermRelations', 'glossaryNames', 'glossaryTerms', 'apiKeys', 'userKeys', 'userAdministrationEvents', 'authenticationAdministrationEvents', 'groupAdministrationEvents', 'navigation', 'agentProviderGrants', 'agentSkillGrants', 'userGroups', 'users', 'groups', 'authentication', 'settings', 'pageHistory', 'pages', 'tags', 'comments', 'assets']) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
    if (previousWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI'); else Reflect.set(globalThis, 'WIKI', previousWiki)
  })

  it.each(['deactivate', 'end-sessions', 'admin-password', 'admin-profile-password', 'self-password', 'resetPwd', 'changePwd'] as const)(
    'denies the old bearer permanently after %s and admits only deliberate current-owner reissuance', async event => {
      const issued = await issuePersonalMcpKey(owner, '42', keyInput)
      const client = await connect(issued.key)
      await readNative(client)
      if (event === 'deactivate' || event === 'end-sessions') {
        await accountAdministration().act(admin, 42, { ...(await review()), action: event })
      } else if (event === 'admin-password') {
        await accountAdministration().setPassword(admin, 42, { ...(await review()), password: 'replacement-password-123!', mustChangePassword: false })
      } else if (event === 'admin-profile-password') {
        const workspace = await accountAdministration().inspect(admin, 42)
        await accountAdministration().updateProfile(admin, 42, { ...(await review()), profile: workspace.profile, password: 'replacement-password-123!' })
      } else if (event === 'self-password') {
        await users.updateUser({ id: 42, newPassword: 'replacement-password-123!' })
      } else {
        const token = await userKeys.generateToken({ userId: 42, kind: event, expectedAuthVersion: 0 })
        if (event === 'resetPwd') await users.resetPassword({ token, newPassword: 'replacement-password-123!' })
        else await users.loginChangePassword({ continuationToken: token, newPassword: 'replacement-password-123!' }, {
          req: { logIn: (_user: unknown, _options: unknown, callback: () => void) => callback() }
        } as never)
        expect(await db('userKeys').where({ userId: 42, token })).toHaveLength(0)
      }
      if (event === 'deactivate') {
        await expect(issuePersonalMcpKey(await currentOwner(), '42', keyInput)).rejects.toMatchObject({ status: 401 })
        await accountAdministration().act(admin, 42, { ...(await review()), action: 'activate' })
      }
      await denied(issued.key)
      await expect(client.listTools()).rejects.toThrow()
      const retained = await db('apiKeys').where('id', issued.item.id).first()
      expect(retained).toMatchObject({ key: issued.key, isRevoked: true, personalOwnerId: 42, personalAccess: 'read-only' })
      await expect(issuePersonalMcpKey(owner, '42', keyInput)).rejects.toMatchObject({ status: 401 })
      const replacement = await issuePersonalMcpKey(await currentOwner(), '42', keyInput)
      expect(replacement.item.id).not.toBe(issued.item.id)
      await readNative(await connect(replacement.key))
      expect(runtime.events.outbound.emit).toHaveBeenCalledWith('reloadApiKeys')
      const diagnostics = JSON.stringify([await db('userAdministrationEvents'), runtime.logger.warn.mock.calls, runtime.logger.error.mock.calls])
      expect(diagnostics).not.toContain(issued.key)
      expect(diagnostics).not.toContain('replacement-password-123!')
    }
  )

  it('restores still-live bearers across ordinary memberships, permissions and each API/Agent/MCP feature switch', async () => {
    const issued = await issuePersonalMcpKey(owner, '42', keyInput)
    const client = await connect(issued.key)
    await readNative(client)
    const original = (await accountAdministration().inspect(admin, 42)).profile
    await accountAdministration().updateProfile(admin, 42, { ...(await review()), profile: { ...original, groups: [] } })
    await denied(issued.key)
    await expect(issuePersonalMcpKey(await currentOwner(), '42', keyInput)).rejects.toMatchObject({ status: 403 })
    await accountAdministration().updateProfile(admin, 42, { ...(await review()), profile: original })
    await readNative(client)
    await db('groups').where('id', 3).update({ permissions: JSON.stringify(['use:agents']) })
    await denied(issued.key)
    await db('groups').where('id', 3).update({ permissions: JSON.stringify(permissions) })
    await readNative(client)
    for (const feature of [runtime.config.api, runtime.config.agents, runtime.config.agents.mcp]) {
      if ('isEnabled' in feature) feature.isEnabled = false; else feature.enabled = false
      await denied(issued.key)
      await expect(issuePersonalMcpKey(await currentOwner(), '42', keyInput)).rejects.toMatchObject({ status: 403 })
      if ('isEnabled' in feature) feature.isEnabled = true; else feature.enabled = true
      await readNative(client)
    }
    expect(await db('apiKeys').where('id', issued.item.id).first()).toMatchObject({ isRevoked: false })
    await revokePersonalMcpKey(await currentOwner(), '42', issued.item.id)
    await denied(issued.key)
    const expiring = await issuePersonalMcpKey(await currentOwner(), '42', keyInput)
    await db('apiKeys').where('id', expiring.item.id).update({ expiration: '2000-01-01T00:00:00Z' })
    runtime.config.agents.enabled = false; runtime.config.agents.enabled = true
    await denied(issued.key)
    await denied(expiring.key)
    expect((await listPersonalMcpKeys(await currentOwner(), '42')).keys).toHaveLength(2)
  })

  it('keeps provider edits on the existing invalidation predicate including enable and config while disabled', async () => {
    await db('users').where('id', 42).update({ providerKey: 'organization' })
    const independent = await issuePersonalMcpKey({ id: 43, authVersion: 0 }, '43', keyInput)
    let issued = await issuePersonalMcpKey(owner, '42', keyInput)
    await readNative(await connect(issued.key))
    await saveProvider(provider => { provider.displayName = 'Organization renamed' })
    await readNative(await connect(issued.key))
    for (const event of ['disable', 'disabled-config', 'enable', 'enabled-config'] as const) {
      const before = issued
      await saveProvider(provider => {
        if (event === 'disable') provider.isEnabled = false
        else if (event === 'enable') provider.isEnabled = true
        else provider.config.issuer = `https://${event}.example.test`
      })
      await denied(before.key)
      expect(await db('apiKeys').where('id', before.item.id).first()).toMatchObject({ isRevoked: true })
      // Provider sign-in enablement is not a second personal-owner entitlement gate.
      issued = await issuePersonalMcpKey(await currentOwner(), '42', keyInput)
      await readNative(await connect(issued.key))
      await readNative(await connect(independent.key))
    }
    expect(runtime.events.outbound.emit).toHaveBeenCalledWith('reloadApiKeys')
  })

  it('retains committed account/key state and broadcasts even when the local postcommit key reload fails', async () => {
    const issued = await issuePersonalMcpKey(owner, '42', keyInput)
    runtime.auth.reloadApiKeys.mockRejectedValue(new Error('private-provider-failure'))
    await accountAdministration().act(admin, 42, { ...(await review()), action: 'end-sessions' })
    expect(await db('users').where('id', 42).first()).toMatchObject({ authVersion: 1 })
    expect(await db('apiKeys').where('id', issued.item.id).first()).toMatchObject({ isRevoked: true })
    expect(runtime.events.outbound.emit).toHaveBeenCalledWith('reloadApiKeys')
    await denied(issued.key)
    expect(JSON.stringify(runtime.logger.warn.mock.calls)).not.toContain('private-provider-failure')
    expect(JSON.stringify(runtime.logger.warn.mock.calls)).not.toContain(issued.key)
    await expect(issuePersonalMcpKey(await currentOwner(), '42', keyInput)).rejects.toMatchObject({ status: 503 })
    expect((await db('apiKeys').where('personalOwnerId', 42)).length).toBe(2)
  })

  it.each(['self', 'resetPwd', 'changePwd'] as const)('rolls back the actual %s password, one-use grant and personal key together on key persistence failure', async event => {
    const issued = await issuePersonalMcpKey(owner, '42', keyInput)
    const token = event === 'self' ? null : await userKeys.generateToken({ userId: 42, kind: event, expectedAuthVersion: 0 })
    const before = await db('users').where('id', 42).first()
    await db.raw('ALTER TABLE "apiKeys" ADD CONSTRAINT lifecycle_key_failure CHECK ("isRevoked" = false)')
    try {
      const operation = event === 'self'
        ? users.updateUser({ id: 42, newPassword: 'replacement-password-123!' })
        : event === 'resetPwd'
          ? users.resetPassword({ token: token!, newPassword: 'replacement-password-123!' })
          : users.loginChangePassword({ continuationToken: token!, newPassword: 'replacement-password-123!' }, {
            req: { logIn: () => { throw new Error('login must not run after a failed key mutation') } }
          } as never)
      await expect(operation).rejects.toThrow()
    } finally {
      await db.raw('ALTER TABLE "apiKeys" DROP CONSTRAINT lifecycle_key_failure')
    }
    expect(await db('users').where('id', 42).first()).toEqual(before)
    expect(await db('apiKeys').where('id', issued.item.id).first()).toMatchObject({ key: issued.key, isRevoked: false })
    if (token) expect(await db('userKeys').where({ userId: 42, token })).toHaveLength(1)
    await readNative(await connect(issued.key))
  })

  it('retains immutable personal kind after native account deletion and preserves the private-history deletion guard', async () => {
    const issued = await issuePersonalMcpKey(owner, '42', keyInput)
    const independent = await issuePersonalMcpKey({ id: 43, authVersion: 0 }, '43', keyInput)
    await db('pageHistory').insert({ id: 1, ownerId: 42, authorId: 42, visibility: 'private' })
    await expect(accountAdministration().remove(admin, 42, { ...(await review()), replaceId: 43 })).rejects.toMatchObject({ status: 403 })
    expect(await db('apiKeys').where('id', issued.item.id).first()).toMatchObject({ personalOwnerId: 42, personalAccess: 'read-only', isRevoked: false })
    await db('pageHistory').where('id', 1).update({ visibility: 'public' })
    await accountAdministration().remove(admin, 42, { ...(await review()), replaceId: 43 })
    expect(await db('apiKeys').where('id', issued.item.id).first()).toMatchObject({ key: issued.key, personalOwnerId: null, personalAccess: 'read-only' })
    expect(await db('pageHistory').where('id', 1).first()).toMatchObject({ ownerId: 42, authorId: 43, visibility: 'public' })
    await denied(issued.key)
    await readNative(await connect(independent.key))
  })

  it.each(['account', 'password', 'recovery', 'provider', 'group'] as const)('serializes issuance before a concurrent %s edit without a surviving unauthorized key', async event => {
    const security = await prepareSecurity(event)
    await withGate('apiKeys', 'INSERT', async gate => {
      const issuance = gate.track(issuePersonalMcpKey(owner, '42', keyInput))
      const issuerPid = await waitBlocked('insert into "apiKeys"', gate.pid)
      const changing = gate.track(security())
      await waitBlocked(['account', 'password', 'recovery'].includes(event) ? 'from "users"' : 'from "groups"', issuerPid)
      await gate.release()
      const issued = await issuance
      await changing
      expect(await db('apiKeys').where('id', issued.item.id).first()).toMatchObject({ isRevoked: event !== 'group' })
      await denied(issued.key)
      await expect(issuePersonalMcpKey(owner, '42', keyInput)).rejects.toMatchObject({ status: 401 })
    })
  }, 20_000)

  it.each(['account', 'password', 'recovery', 'provider', 'group'] as const)('reauthorizes issuance after the %s edit wins the native policy/owner locks', async event => {
    const issued = await issuePersonalMcpKey(owner, '42', keyInput)
    const security = await prepareSecurity(event)
    await withGate(event === 'group' ? 'groups' : 'apiKeys', 'UPDATE', async gate => {
      const changing = gate.track(security())
      const editorPid = await waitBlocked(event === 'group' ? 'update "groups"' : 'update "apiKeys"', gate.pid)
      const issuance = gate.track(issuePersonalMcpKey(owner, '42', keyInput))
      await waitBlocked(['account', 'password', 'recovery'].includes(event) ? 'from "users"' : 'from "groups"', editorPid)
      await gate.release()
      await changing
      await expect(issuance).rejects.toMatchObject({ status: 401 })
      expect(await db('apiKeys').where('personalOwnerId', 42)).toHaveLength(1)
      expect(await db('apiKeys').where('id', issued.item.id).first()).toMatchObject({ isRevoked: event !== 'group' })
      await denied(issued.key)
    })
  }, 20_000)

  it('serializes explicit per-key revocation with issuance under the same owner lock without revoking its replacement', async () => {
    const existing = await issuePersonalMcpKey(owner, '42', keyInput)
    await withGate('apiKeys', 'INSERT', async gate => {
      const issuance = gate.track(issuePersonalMcpKey(owner, '42', keyInput))
      const issuerPid = await waitBlocked('insert into "apiKeys"', gate.pid)
      const revoking = gate.track(revokePersonalMcpKey(owner, '42', existing.item.id))
      await waitBlocked('from "users"', issuerPid)
      await gate.release()
      const replacement = await issuance
      await revoking
      await denied(existing.key)
      await readNative(await connect(replacement.key))
    })
  }, 20_000)

  it('preserves personal history and independent owners through native group deletion and deliberate entitlement restoration', async () => {
    const group = createGroupAdministrationStore({ db })
    const original = await group.inspect(admin, 3)
    await db('groups').insert({ id: 4, name: 'Independent entitlement', permissions: JSON.stringify(permissions), pageRules: JSON.stringify(original.pageRules) })
    await db('userGroups').where({ userId: 43, groupId: 3 }).update({ groupId: 4 })
    const issued = await issuePersonalMcpKey(owner, '42', keyInput)
    const independent = await issuePersonalMcpKey({ id: 43, authVersion: 0 }, '43', keyInput)
    const current = await group.inspect(admin, 3)
    await group.remove(admin, 3, { fingerprint: current.fingerprint, reason: 'Retire the original entitlement group' })
    await denied(issued.key)
    await readNative(await connect(independent.key))
    const workspace = await accountAdministration().inspect(admin, 42)
    await accountAdministration().updateProfile(admin, 42, { ...(await review()), profile: { ...workspace.profile, groups: [4] } })
    await readNative(await connect(issued.key))
    expect(await db('apiKeys').where('id', issued.item.id).first()).toMatchObject({ personalOwnerId: 42, personalAccess: 'read-only', isRevoked: false })
  })

  it('publishes committed revocation to another native auth instance even when the local cache reload fails', async () => {
    const issued = await issuePersonalMcpKey(owner, '42', keyInput)
    // A fresh module supplies an independent instance cache without replacing the real persistence or admission code.
    const peer = (await vi.importFresh('../../core/auth.ts', import.meta.url)).default as typeof auth
    const inbound = new EventEmitter()
    runtime.events.inbound.on.mockImplementation((event, listener) => { inbound.on(event, listener) })
    runtime.events.outbound.emit.mockImplementation((event, payload) => { inbound.emit(event, payload) })
    peer.subscribeToEvents()
    await peer.reloadApiKeys()
    expect(peer.validApiKeys).toContain(issued.item.id)
    runtime.auth.reloadApiKeys.mockRejectedValue(new Error('private-cache-reload-failure'))
    await accountAdministration().act(admin, 42, { ...(await review()), action: 'end-sessions' })
    await vi.waitFor(() => expect(peer.validApiKeys).not.toContain(issued.item.id))
    expect(auth.validApiKeys).toContain(issued.item.id)
    await denied(issued.key)
    expect(JSON.stringify(runtime.logger.warn.mock.calls)).not.toContain('private-cache-reload-failure')
  })
})
