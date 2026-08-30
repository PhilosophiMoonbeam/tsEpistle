import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import cookieParser from 'cookie-parser'
import express from 'express'
import session from 'express-session'
import createKnex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from '../bun-test.mts'

import createAgentsHostController from '../../controllers/agents-host.ts'

interface TestSessionState {
  agentCsrfToken?: string
}

const csrf = 'test-csrf-token-with-at-least-thirty-two-bytes'

describe('agents-host skill administration', () => {
  let db: Knex
  let baseUrl: string
  let cookie: string
  let server: Server
  let admin = true

  beforeAll(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('path').notNullable()
      table.text('content').notNullable()
      table.string('contentType').notNullable()
      table.bigInteger('sourceRevision').notNullable()
      table.string('updatedAt').notNullable()
    })
    await db.schema.createTable('agentSkills', table => {
      table.string('id').primary()
      table.string('name').notNullable().unique()
      table.integer('rootPageId').nullable()
      table.text('rootPath').notNullable()
      table.integer('assetFolderId').nullable()
      table.string('status').notNullable()
      table.string('exposureMode').notNullable()
      table.string('currentVersionId').nullable()
      table.integer('ownerUserId').nullable()
      table.dateTime('deletedAt').nullable()
      table.integer('createdBy').notNullable()
      table.integer('updatedBy').notNullable()
      table.dateTime('createdAt').defaultTo(db.fn.now())
      table.dateTime('updatedAt').defaultTo(db.fn.now())
    })
    await db.schema.createTable('agentSkillGrants', table => {
      table.string('skillId').notNullable()
      table.integer('groupId').notNullable()
    })
    await db.schema.createTable('agentSkillVersions', table => {
      table.string('id').primary()
      table.string('skillId').notNullable()
      table.bigInteger('sourceRevision').notNullable()
      table.text('skillMarkdown').notNullable()
      table.string('contentHash').notNullable()
    })
    await db('pages').insert({
      id: 42,
      path: 'system/agent-skills/release-notes',
      content: '---\nname: release-notes\ndescription: Notes\n---\nWrite notes.\n',
      contentType: 'markdown',
      sourceRevision: 1,
      updatedAt: '2026-08-17T00:00:00.000Z'
    })

    const app = express()
    app.use(cookieParser())
    app.use(session({ secret: 'agent-host-admin-test-secret', resave: false, saveUninitialized: true }))
    app.get('/seed', (req, res) => {
      const state = req.session as typeof req.session & TestSessionState
      state.agentCsrfToken = csrf
      res.sendStatus(204)
    })
    app.use(
      createAgentsHostController({
        auth: {
          authenticate(req, _res, next) {
            req.authContext = { kind: 'user', userId: 7, ownershipUserId: 7, principal: { id: 7 } }
            req.user = { id: 7, permissions: admin ? ['manage:system'] : [] } as Express.User
            next()
          }
        },
        config: {
          host: 'https://wiki.example.test',
          sessionSecret: 'agent-host-admin-token-secret',
          agents: {
            enabled: true,
            provider: { enabled: false },
            retention: { temporarySessionHours: 24 },
            skills: { enabled: true, namespace: 'system/agent-skills' },
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
        models: {
          knex: db
        }
      })
    )
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
    const seed = await fetch(`${baseUrl}/seed`)
    cookie = seed.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    await db.destroy()
  })

  it('requires system administration permission', async () => {
    admin = false
    const response = await fetch(`${baseUrl}/_api/agents/admin/skills`, { headers: { cookie } })
    expect(response.status).toBe(403)
    admin = true
  })

  it('requires exact origin and session-bound CSRF for mutations', async () => {
    const body = JSON.stringify({
      name: 'release-notes',
      rootPageId: 42,
      rootPath: 'system/agent-skills/release-notes',
      assetFolderId: null,
      exposureMode: 'all_agent_users',
      groupIds: [],
      actorId: 99
    })
    const noCsrf = await fetch(`${baseUrl}/_api/agents/admin/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://wiki.example.test', 'sec-fetch-site': 'same-origin' },
      body
    })
    expect(noCsrf.status).toBe(403)

    const wrongOrigin = await fetch(`${baseUrl}/_api/agents/admin/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example.test', 'sec-fetch-site': 'same-origin', 'x-wiki-csrf': csrf },
      body
    })
    expect(wrongOrigin.status).toBe(403)

    const accepted = await fetch(`${baseUrl}/_api/agents/admin/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://wiki.example.test', 'sec-fetch-site': 'same-origin', 'x-wiki-csrf': csrf },
      body
    })
    expect(accepted.status).toBe(201)
    expect(await db('agentSkills').select('createdBy').first()).toEqual({ createdBy: 7 })
  })

  it('returns an empty provider profile listing when provider administration is unavailable', async () => {
    const response = await fetch(`${baseUrl}/_api/agents/admin/profiles`, { headers: { cookie } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ profiles: [] })
  })

  it('explains unavailable provider administration instead of returning an opaque 404', async () => {
    const response = await fetch(`${baseUrl}/_api/agents/admin/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://wiki.example.test', 'sec-fetch-site': 'same-origin', 'x-wiki-csrf': csrf },
      body: '{}'
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'AGENT_PROVIDER_ADMIN_DISABLED',
      message: 'Provider administration is unavailable. Enable agents.provider.enabled, configure the provider runtime keys, and restart Wiki.'
    })
  })

  it('returns the ordinary administration registry view', async () => {
    const response = await fetch(`${baseUrl}/_api/agents/admin/skills`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { skills: Array<{ name: string }> }
    expect(payload.skills.map(skill => skill.name)).toEqual(['release-notes'])
  })
})
