import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import session from 'express-session'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import createAgentsHostController from '../../controllers/agents-host.ts'
import { ExternalMcpService, type ExternalMcpFetchImplementation } from '../../agents/external-mcp.ts'
import { DecisionProviderRegistry } from '../../agents/decision-providers.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { up as addSecrets } from '../../db/migrations/2.5.141.ts'
import { up as addMcp } from '../../db/migrations/tsepistle-000050-agent-external-mcp.ts'
import { up as addDecisions } from '../../db/migrations/tsepistle-000051-agent-decision-providers.ts'

const connection = getPostgresTestConnection('_agents_test', import.meta.path)
const suite = connection ? describe : describe.skip
const schema = `control_http_${randomUUID().replaceAll('-', '')}`
const csrf = 'agent-control-http-csrf-token-thirty-two-bytes'
const endpoint = { displayName: 'Research', endpointUrl: 'https://mcp.example.com/api', status: 'enabled', authMode: 'none' }

suite('Agent controls persisted HTTP authorization boundary', () => {
  let db: Knex, server: Server, baseUrl: string, cookie: string
  let signedIn = true,
    userId = 7,
    permission = 'manage:system',
    networkCalls = 0
  const protocol: ExternalMcpFetchImplementation = async (_url, init) => {
    networkCalls++
    const message = JSON.parse(String(init.body))
    const result =
      message.method === 'server/discover'
        ? { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' }
        : message.method === 'tools/list'
          ? { resultType: 'complete', tools: [{ name: 'research', inputSchema: { type: 'object', properties: {} } }], ttlMs: 0, cacheScope: 'private' }
          : undefined
    if (!result) throw new Error('Unexpected guarded protocol request')
    return Response.json({ jsonrpc: '2.0', id: message.id, result })
  }
  const request = (path: string, method = 'GET', body?: unknown, security = true) =>
    fetch(`${baseUrl}/_api/agents${path}`, {
      method,
      headers: {
        cookie,
        'content-type': 'application/json',
        ...(security ? { origin: 'https://wiki.example.test', 'sec-fetch-site': 'same-origin', 'x-wiki-csrf': csrf } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  beforeAll(async () => {
    const root = knexModule({ client: 'pg', connection: connection ?? undefined })
    try {
      await root.raw(`CREATE SCHEMA "${schema}"`)
    } finally {
      await root.destroy()
    }
    db = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 4 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.specificType('permissions', 'text[]').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').references('id').inTable('users')
      table.integer('groupId').references('id').inTable('groups')
      table.primary(['userId', 'groupId'])
    })
    await addSecrets(db)
    await addMcp(db)
    await addDecisions(db)
    const secrets = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'http', keys: { http: Buffer.alloc(32, 23) } })
    const externalMcp = new ExternalMcpService({
      knex: db,
      secrets,
      enabled: () => true,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: protocol
    })
    const decisionProviders = new DecisionProviderRegistry(db, secrets)
    const app = express()
    app.use(session({ secret: 'agent-control-http-test-session', resave: false, saveUninitialized: true }))
    app.get('/seed', (req, res) => {
      Reflect.set(req.session, 'agentCsrfToken', csrf)
      res.sendStatus(204)
    })
    app.use(
      createAgentsHostController({
        auth: {
          authenticate(req, _res, next) {
            if (signedIn) {
              req.authContext = { kind: 'user', userId, ownershipUserId: userId, principal: { id: userId } }
              req.user = { id: userId, authVersion: 0, permissions: [permission] } as Express.User
            }
            next()
          }
        },
        config: {
          host: 'https://wiki.example.test',
          sessionSecret: 'control-profile-token-secret',
          agents: {
            enabled: true,
            provider: { enabled: true },
            retention: { temporarySessionHours: 24 },
            skills: { enabled: false, namespace: 'system/agent-skills' },
            proposals: { enabled: false },
            writes: {
              enabled: false,
              create: { enabled: false },
              patch: { enabled: false },
              move: { enabled: false },
              restore: { enabled: false },
              delete: { enabled: false }
            }
          }
        },
        models: { knex: db },
        externalMcp,
        decisionProviders
      })
    )
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    cookie = (await fetch(`${baseUrl}/seed`)).headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  })
  beforeEach(async () => {
    await db('agentExternalMcpGrants').delete()
    await db('agentExternalMcpServers').delete()
    await db('agentExternalMcpGroupPolicies').delete()
    await db('agentDecisionProviders').delete()
    await db('agentProviderSecrets').delete()
    await db('userGroups').delete()
    await db('groups').delete()
    await db('users').delete()
    await db('users').insert([7, 8, 9].map(id => ({ id, isActive: true, authVersion: 0 })))
    await db('groups').insert([
      { id: 10, permissions: ['manage:system'] },
      { id: 20, permissions: ['use:agents'] }
    ])
    await db('userGroups').insert([
      { userId: 7, groupId: 10 },
      { userId: 8, groupId: 20 },
      { userId: 9, groupId: 20 }
    ])
    signedIn = true
    userId = 7
    permission = 'manage:system'
    networkCalls = 0
  })
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    if (db) await db.destroy()
    const root = knexModule({ client: 'pg', connection: connection ?? undefined })
    try {
      await root.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await root.destroy()
    }
  })
  it('enforces login, use permission, CSRF, live administrator membership and account generation', async () => {
    signedIn = false
    expect((await request('/admin/external-mcp')).status).toBe(401)
    signedIn = true
    permission = 'read:pages'
    expect((await request('/external-mcp')).status).toBe(403)
    permission = 'manage:system'
    expect((await request('/admin/external-mcp', 'POST', { ...endpoint, groupIds: [20] }, false)).status).toBe(403)
    for (const [header, value] of [
      ['x-wiki-csrf', 'wrong-token'],
      ['origin', 'https://evil.example.test'],
      ['sec-fetch-site', 'cross-site']
    ] as const) {
      const denied = await fetch(`${baseUrl}/_api/agents/admin/external-mcp`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          origin: 'https://wiki.example.test',
          'sec-fetch-site': 'same-origin',
          'x-wiki-csrf': csrf,
          [header]: value
        },
        body: JSON.stringify({ ...endpoint, groupIds: [20] })
      })
      expect(denied.status).toBe(403)
    }
    expect(await db('agentExternalMcpServers')).toEqual([])
    await db('userGroups').where({ userId: 7 }).delete()
    expect((await request('/admin/external-mcp', 'POST', { ...endpoint, groupIds: [20] })).status).toBe(403)
    expect((await request('/admin/decision-providers')).status).toBe(403)
    await db('userGroups').insert({ userId: 7, groupId: 10 })
    await db('users').where({ id: 7 }).update({ authVersion: 1 })
    expect((await request('/admin/external-mcp')).status).toBe(403)
    expect(networkCalls).toBe(0)
  })
  it('isolates personal owners, rejects caller credentials/configuration authority, preserves optimistic revisions and revokes discovery', async () => {
    expect((await request('/admin/external-mcp/group-policies/20', 'PUT', { expectedRevision: 0, allowPersonalEndpoints: true })).status).toBe(200)
    userId = 8
    permission = 'use:agents'
    for (const injection of [{ ownerId: 9 }, { secretReference: 'managed:forbidden' }, { headers: { authorization: 'forbidden' } }])
      expect((await request('/personal-mcp', 'POST', { ...endpoint, ...injection })).status).toBe(400)
    const created = await request('/personal-mcp', 'POST', { ...endpoint, authMode: 'bearer', secretValue: 'write-only-mcp-key' })
    expect(created.status).toBe(201)
    const { server: saved } = await created.json()
    expect(JSON.stringify(saved)).not.toContain('write-only-mcp-key')
    expect(JSON.stringify(saved)).not.toContain('managed:')
    expect((await request(`/personal-mcp/${saved.id}`, 'PUT', { ...endpoint, expectedRevision: '1' })).status).toBe(400)
    expect((await request(`/personal-mcp/${saved.id}`, 'PUT', { ...endpoint, expectedRevision: 2 })).status).toBe(409)
    userId = 9
    expect(await (await request('/personal-mcp')).json()).toEqual({ servers: [] })
    expect((await request(`/personal-mcp/${saved.id}`, 'DELETE', { expectedRevision: 1 })).status).toBe(403)
    userId = 8
    const discovery = await request(`/external-mcp/${saved.id}/discover`, 'POST', {})
    expect(discovery.status).toBe(200)
    expect((await discovery.json()).discovery.catalog.tools[0].name).toBe('research')
    const calls = networkCalls
    userId = 7
    permission = 'manage:system'
    expect((await request('/admin/external-mcp/group-policies/20', 'PUT', { expectedRevision: 1, allowPersonalEndpoints: false })).status).toBe(200)
    userId = 8
    permission = 'use:agents'
    expect((await request(`/external-mcp/${saved.id}/discover`, 'POST', {})).status).toBe(403)
    expect(networkCalls).toBe(calls)
  })
  it('applies admin grants to available endpoints and stops revoked-grant discovery before network', async () => {
    const created = await request('/admin/external-mcp', 'POST', { ...endpoint, groupIds: [20] })
    expect(created.status).toBe(201)
    const { server: saved } = await created.json()
    userId = 8
    permission = 'use:agents'
    expect((await (await request('/external-mcp')).json()).servers.map((item: { id: string }) => item.id)).toEqual([saved.id])
    expect((await request(`/external-mcp/${saved.id}/discover`, 'POST', {})).status).toBe(200)
    const calls = networkCalls
    userId = 7
    permission = 'manage:system'
    expect((await request(`/admin/external-mcp/${saved.id}/grants`, 'PUT', { expectedRevision: 1, groupIds: [] })).status).toBe(200)
    expect((await request(`/admin/external-mcp/${saved.id}/grants`, 'PUT', { expectedRevision: 1, groupIds: [20] })).status).toBe(409)
    userId = 8
    permission = 'use:agents'
    expect(await (await request('/external-mcp')).json()).toEqual({ servers: [] })
    expect((await request(`/external-mcp/${saved.id}/discover`, 'POST', {})).status).toBe(403)
    expect(networkCalls).toBe(calls)
  })
  it('returns redacted custom decision configuration errors and stores only valid administrative writes', async () => {
    const bad = await request('/admin/decision-providers', 'POST', {
      displayName: 'Bad custom',
      secretValue: 'never-echo-this-secret',
      config: {
        kind: 'openai-compatible',
        baseUrl: 'https://user:password@classifier.example/v1',
        dialect: 'chat-completions',
        model: 'classifier',
        timeoutMs: 1000
      }
    })
    expect(bad.status).toBe(400)
    const error = await bad.text()
    expect(error).not.toContain('never-echo-this-secret')
    expect(error).not.toContain('password')
    expect(await db('agentProviderSecrets')).toEqual([])
    const created = await request('/admin/decision-providers', 'POST', {
      displayName: 'Jev',
      config: { kind: 'typesafe', model: 'jev-latest', timeoutMs: 1000 },
      secretValue: 'write-only-decision-key'
    })
    expect(created.status).toBe(201)
    const { provider } = await created.json()
    expect(JSON.stringify(provider)).not.toContain('write-only-decision-key')
    expect((await request(`/admin/decision-providers/${provider.id}`, 'DELETE', { expectedRevision: 2 })).status).toBe(409)
    expect((await request(`/admin/decision-providers/${provider.id}`, 'DELETE', { expectedRevision: 1 })).status).toBe(200)
    expect(await db('agentProviderSecrets')).toEqual([])
  })
})
