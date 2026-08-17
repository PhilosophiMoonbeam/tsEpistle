import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import createKnex, { type Knex } from 'knex'
import pageOperations from '../../operations/pages.ts'
import { createAgentLaunchRouter } from '../../controllers/api/agents.ts'

vi.mock('../../operations/pages.ts', () => ({
  default: { get: vi.fn(async () => ({ id: 42, locale: 'en', path: 'guide', updatedAt: '2026-08-17T00:00:00.000Z' })) }
}))

const csrf = 'launch-csrf-token-with-at-least-thirty-two-bytes'

describe('ordinary-origin agent launch', () => {
  let db: Knex
  let server: ReturnType<express.Express['listen']>
  let baseUrl: string
  let cookie = ''

  beforeAll(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentLaunchHandoffs', table => {
      table.string('id').primary(); table.binary('tokenSha256'); table.integer('ownerId'); table.integer('pageId').nullable(); table.string('localeCode').nullable(); table.text('path').nullable(); table.dateTime('observedUpdatedAt').nullable(); table.binary('pageHintSha256'); table.dateTime('createdAt'); table.dateTime('expiresAt'); table.dateTime('consumedAt').nullable()
    })
    const app = express()
    app.use(express.json())
    app.use(session({ secret: 'ordinary-launch-session-secret', resave: false, saveUninitialized: true }))
    app.get('/seed', (req, res) => { Reflect.set(req.session, 'agentLaunchCsrfToken', csrf); res.sendStatus(204) })
    app.use((req, _res, next) => {
      req.authContext = { kind: 'user', userId: 7, ownershipUserId: 7, principal: { id: 7 } }
      req.user = { id: 7, permissions: ['use:agents'] } as Express.User
      next()
    })
    app.use('/api/agents', createAgentLaunchRouter(() => ({ config: { host: 'https://wiki.example.test', agents: { enabled: true, publicOrigin: 'https://agents.example.test', launchTokenTtlSeconds: 300 } }, models: { knex: db } })))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server failed to bind')
    baseUrl = `http://127.0.0.1:${address.port}`
    const seeded = await fetch(`${baseUrl}/seed`)
    cookie = seeded.headers.get('set-cookie')?.split(';')[0] ?? ''
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await db.destroy()
  })

  it('reauthorizes the page and returns a one-time agents-origin 303 to form submissions', async () => {
    const body = new URLSearchParams({ csrfToken: csrf, pageId: '42', pageLocale: 'en', pagePath: 'guide', pageUpdatedAt: '2026-08-17T00:00:00.000Z' })
    const response = await fetch(`${baseUrl}/api/agents/launch`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: 'https://wiki.example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, body })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toMatch(/^https:\/\/agents\.example\.test\/\?handoff=[A-Za-z0-9_-]{43}$/)
    expect(pageOperations.get).toHaveBeenCalledWith({ id: 42, requester: expect.objectContaining({ id: 7 }) })
    expect(await db('agentLaunchHandoffs').count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({ count: 1 })
  })

  it('rejects a missing session-bound CSRF token before creating a handoff', async () => {
    const response = await fetch(`${baseUrl}/api/agents/launch`, { method: 'POST', headers: { cookie, origin: 'https://wiki.example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ page: null }) })
    expect(response.status).toBe(403)
  })
})
