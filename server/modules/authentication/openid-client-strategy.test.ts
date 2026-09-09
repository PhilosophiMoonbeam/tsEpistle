import createKnex, { type Knex } from 'knex'
import { Configuration } from 'openid-client'
import type { Request } from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from '../../test/bun-test.mts'
import type { OpenIDClientStrategy } from './openid-client-strategy.ts'
import type { OAuthStateStore } from './oauth-state.ts'

import { up as migrateFederatedLogin } from '../../db/migrations/tsepistle-000030-federated-login-state.ts'
import { FederatedLoginStore } from '../../repositories/federated-login.ts'

type OpenIDRequest = Request & {
  headers: { host: string }
  protocol: string
  method: 'GET'
  url: string
  originalUrl: string
  query: Record<string, unknown>
  body: Record<string, unknown>
  params: { strategy: string }
  sessionID: string
  session: { save(callback: (error?: Error | null) => void): void }
  get(name: string): string | undefined
}

const providerKey = 'oidc:public'
const providerRevision = 'revision-a'
const callbackURL = 'https://wiki.example.com/login/oidc:public/callback'
const createRequest = (sessionID: string, query: Record<string, unknown> = {}): OpenIDRequest => {
  const encodedQuery = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : [])
  ).toString()
  const callbackPath = `/login/${providerKey}/callback${encodedQuery ? `?${encodedQuery}` : ''}`
  return {
    headers: { host: 'wiki.example.com' },
    protocol: 'https',
    method: 'GET',
    url: callbackPath,
    originalUrl: callbackPath,
    query,
    body: {},
    params: { strategy: providerKey },
    sessionID,
    session: { save: (callback: (error?: Error | null) => void) => callback(null) },
    get: (name: string) => name.toLowerCase() === 'host' ? 'wiki.example.com' : undefined
  } as unknown as OpenIDRequest
}

const configuration = new Configuration(
  {
    issuer: 'https://issuer.example.com',
    authorization_endpoint: 'https://issuer.example.com/authorize',
    token_endpoint: 'https://issuer.example.com/token'
  },
  'client-id',
  { client_secret: 'client-secret' }
)
let database: Knex
let federatedStore: FederatedLoginStore
const originalWiki = Reflect.get(globalThis, 'WIKI')
let OpenIDClientStrategyCtor: typeof OpenIDClientStrategy
let OAuthStateStoreCtor: typeof OAuthStateStore

beforeAll(async () => {
  database = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await migrateFederatedLogin(database)
  await database.schema.createTable('sessions', table => {
    table.string('sid').primary()
    table.text('sess').notNullable()
    table.dateTime('expired').notNullable()
  })
  await database.schema.createTable('authentication', table => {
    table.string('key').primary()
    table.boolean('isEnabled').notNullable()
    table.string('adminRevision').notNullable()
  })
  federatedStore = new FederatedLoginStore(database)
  Reflect.set(globalThis, 'WIKI', {
    logger: { info: vi.fn(), warn: vi.fn() },
    models: { knex: database, users: { processProfile: vi.fn() } }
  })
  OpenIDClientStrategyCtor = (await import('./openid-client-strategy.ts')).OpenIDClientStrategy
  OAuthStateStoreCtor = (await import('./oauth-state.ts')).OAuthStateStore
})

afterEach(async () => {
  await database('federatedLoginAttempts').delete()
  await database('sessions').delete()
  await database('authentication').delete()
})

afterAll(async () => {
  await database.destroy()
  if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
  else Reflect.set(globalThis, 'WIKI', originalWiki)
})

const createStrategy = (): OpenIDClientStrategy => new OpenIDClientStrategyCtor(
  {
    config: configuration,
    callbackURL,
    providerKey,
    providerRevision,
    scope: 'openid profile email',
    passReqToCallback: true,
    stateStore: new OAuthStateStoreCtor({ providerKey, providerRevision, protocol: 'openidconnect', backend: federatedStore })
  },
  (_request, _tokens, done) => done(null, { id: 1 })
)


describe('application OpenID Client strategy', () => {
  it('issues random state, nonce, and PKCE together in the durable provider record', async () => {
    const sessionID = 'session:public'
    await database('authentication').insert({ key: providerKey, isEnabled: true, adminRevision: providerRevision })
    await database('sessions').insert({ sid: sessionID, sess: '{}', expired: new Date('2030-01-01T00:00:00.000Z') })
    const strategy = createStrategy()
    const redirect = vi.fn<(url: string, status?: number) => void>()
    const redirected = new Promise<void>((resolve, reject) => {
      strategy.redirect = (url, status) => {
        redirect(url, status)
        resolve()
      }
      strategy.error = reject
      strategy.authenticate(createRequest(sessionID))
    })
    await redirected

    const location = new URL(String(redirect.mock.calls[0]?.[0]))
    const state = location.searchParams.get('state')
    expect(state).toBeTruthy()
    expect(location.searchParams.get('nonce')).toBeTruthy()
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    const row = await database('federatedLoginAttempts').where({ providerKey }).first()
    expect(row?.payload).not.toContain(state ?? '')
  })

  it('rejects a mismatched callback before any authorization-code exchange', async () => {
    const sessionID = 'session:mismatch'
    await database('authentication').insert({ key: providerKey, isEnabled: true, adminRevision: providerRevision })
    await database('sessions').insert({ sid: sessionID, sess: '{}', expired: new Date('2030-01-01T00:00:00.000Z') })
    const strategy = createStrategy()
    const fail = vi.fn<(challenge: unknown, status?: number) => void>()
    const rejected = new Promise<number>((resolve, reject) => {
      strategy.fail = (challenge, status) => {
        fail(challenge, status)
        resolve(status ?? 0)
      }
      strategy.error = reject
      strategy.authenticate(createRequest(sessionID, { code: 'authorization-code', state: 'wrong-state' }))
    })
    expect(await rejected).toBe(403)
    expect(fail).toHaveBeenCalledTimes(1)
    const attempts = await database('federatedLoginAttempts').where({ providerKey }).count<{ count: string | number }>({ count: '*' }).first()
    expect(Number(attempts?.count ?? 0)).toBe(0)
  })
})
