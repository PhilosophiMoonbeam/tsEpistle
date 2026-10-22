import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { up } from '../../db/migrations/tsepistle-000067-live-notes.ts'
import router from '../../controllers/api/live-notes.ts'
import { createApiPrincipal } from '../../helpers/api-principal.ts'
import { configureTransportRuntime, getTransportRuntime } from '../../controllers/_types.ts'

let db: Knex
let server: Server
let origin: string
const originalWiki = Reflect.get(globalThis, 'WIKI')
let originalTransportRuntime: object | undefined
try {
  originalTransportRuntime = getTransportRuntime<object>()
} catch {
  /* No HTTP runtime has been configured in this isolated test process. */
}
beforeEach(async () => {
  db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true,
    postProcessResponse: value => {
      const normalize = (row: unknown) => (typeof row === 'object' && row !== null && 'isActive' in row ? { ...row, isActive: Boolean(row.isActive) } : row)
      return Array.isArray(value) ? value.map(normalize) : normalize(value)
    }
  })
  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.boolean('isActive').notNullable().defaultTo(true)
    table.integer('authVersion').notNullable().defaultTo(0)
  })
  await db.schema.createTable('groups', table => {
    table.integer('id').primary()
    table.text('permissions')
  })
  await db.schema.createTable('userGroups', table => {
    table.integer('userId')
    table.integer('groupId')
  })
  await db('users').insert([{ id: 2 }, { id: 7 }])
  await db('groups').insert({ id: 3, permissions: '["write:notes"]' })
  await db('userGroups').insert({ userId: 7, groupId: 3 })
  await up(db)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (req.get('x-fixture-identity') === 'service') {
      req.user = createApiPrincipal(44, 3, ['manage:system'])
      req.authContext = { kind: 'apiKey', apiKeyId: 44, groupId: 3, ownershipUserId: null, principal: req.user }
    } else {
      const id = req.get('x-fixture-identity') === 'guest' ? 2 : 7
      req.user = { id, authVersion: 0 } as Express.User
      req.authContext =
        id === 2 ? { kind: 'guest', ownershipUserId: null, principal: req.user } : { kind: 'user', userId: id, ownershipUserId: id, principal: req.user }
    }
    Reflect.set(req, 'session', { agentCsrfToken: 'browser-csrf-token' })
    next()
  })
  app.use('/_api/live-notes', router)
  const listening = Promise.withResolvers<void>()
  server = app.listen(0, '127.0.0.1', listening.resolve)
  server.once('error', listening.reject)
  await listening.promise
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const runtime = { models: { knex: db }, config: { host: origin, sessionSecret: 'existing-root', auth: { audience: 'urn:wiki:test' } } }
  Reflect.set(globalThis, 'WIKI', runtime)
  configureTransportRuntime(runtime)
})
afterEach(async () => {
  if (server) {
    const closed = Promise.withResolvers<void>()
    server.close(error => (error ? closed.reject(error) : closed.resolve()))
    await closed.promise
  }
  await db.destroy()
  if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
  else Reflect.set(globalThis, 'WIKI', originalWiki)
  configureTransportRuntime(originalTransportRuntime ?? {})
})
const headers = () => ({ 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'x-wiki-csrf': 'browser-csrf-token' })

describe('live note browser REST admission', () => {
  it('never creates on GET and requires bound browser origin/CSRF before explicit creation', async () => {
    const missing = await fetch(`${origin}/_api/live-notes/unknown-note`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toContain('no-store')
    expect(await db('liveNotes')).toHaveLength(0)
    for (const requestHeaders of [
      { 'Content-Type': 'application/json' },
      { ...headers(), Origin: 'https://other.example.test' },
      { ...headers(), 'x-wiki-csrf': 'invalid' }
    ]) {
      const denied = await fetch(`${origin}/_api/live-notes`, { method: 'POST', headers: requestHeaders, body: '{}' })
      expect(denied.status).toBe(403)
      expect(denied.headers.get('cache-control')).toContain('no-store')
    }
    const service = await fetch(`${origin}/_api/live-notes`, { method: 'POST', headers: { ...headers(), 'x-fixture-identity': 'service' }, body: '{}' })
    expect(service.status).toBe(401)
    const created = await fetch(`${origin}/_api/live-notes`, { method: 'POST', headers: headers(), body: '{"key":"browser-note"}' })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ key: 'browser-note', ownerId: 7, revision: 0, access: 'private' })
    expect(await db('liveNotes')).toHaveLength(1)
  })

  it('supports opt-in guest read sessions, denies guest writes, and redacts unexpected driver errors', async () => {
    await fetch(`${origin}/_api/live-notes`, { method: 'POST', headers: headers(), body: '{"key":"shared-note"}' })
    await fetch(`${origin}/_api/live-notes/shared-note`, { method: 'PATCH', headers: headers(), body: '{"expectedRevision":0,"access":"read"}' })
    await db('groups').insert({ id: 2, permissions: '["read:notes"]' })
    await db('userGroups').insert({ userId: 2, groupId: 2 })
    const guestHeaders = { ...headers(), 'x-fixture-identity': 'guest' }
    const session = await fetch(`${origin}/_api/live-notes/shared-note/session`, { method: 'POST', headers: guestHeaders, body: '{}' })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ key: 'shared-note', websocketPath: '/_api/live-notes/_socket' })
    const denied = await fetch(`${origin}/_api/live-notes`, { method: 'POST', headers: guestHeaders, body: '{}' })
    expect(denied.status).toBe(403)
    await db.schema.renameTable('liveNotes', 'privateSqlTable')
    const failure = await fetch(`${origin}/_api/live-notes/shared-note`)
    expect(failure.status).toBe(500)
    expect(await failure.json()).toEqual({ error: 'The live note request failed.', code: 'NOTE_REQUEST_FAILED' })
  })
})
