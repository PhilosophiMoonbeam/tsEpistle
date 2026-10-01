import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { Configuration, customFetch, type CustomFetch } from 'openid-client'
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
    const initiate = async () => {
      const location = await new Promise<URL>((resolve, reject) => {
        strategy.redirect = url => resolve(new URL(url))
        strategy.error = reject
        strategy.authenticate(createRequest(sessionID))
      })
      const state = location.searchParams.get('state')
      const nonce = location.searchParams.get('nonce')
      const codeChallenge = location.searchParams.get('code_challenge')
      expect(state).toBeTruthy()
      expect(nonce).toBeTruthy()
      expect(codeChallenge).toBeTruthy()
      if (!state || !nonce || !codeChallenge) throw new Error('Provider redirect omitted state, nonce, or PKCE challenge')
      expect(location.searchParams.get('code_challenge_method')).toBe('S256')

      const rows = await database('federatedLoginAttempts').where({ providerKey })
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(row).toMatchObject({ providerKey, providerRevision, sessionId: sessionID, protocol: 'openidconnect' })
      expect(row.stateHash).toEqual(createHash('sha256').update(state).digest())
      expect(row.payload).not.toContain(state)
      const payload = JSON.parse(row.payload) as { nonce: string, codeVerifier: string }
      expect(payload.nonce).toBe(nonce)
      expect(payload.codeVerifier).toEqual(expect.any(String))
      expect(createHash('sha256').update(payload.codeVerifier).digest('base64url')).toBe(codeChallenge)
      return { state, nonce, codeVerifier: payload.codeVerifier }
    }

    const first = await initiate()
    const second = await initiate()
    expect(second.state).not.toBe(first.state)
    expect(second.nonce).not.toBe(first.nonce)
    expect(second.codeVerifier).not.toBe(first.codeVerifier)
  })

  it('rejects a mismatched callback before any authorization-code exchange', async () => {
    const sessionID = 'session:mismatch'
    await database('authentication').insert({ key: providerKey, isEnabled: true, adminRevision: providerRevision })
    await database('sessions').insert({ sid: sessionID, sess: '{}', expired: new Date('2030-01-01T00:00:00.000Z') })
    const strategy = createStrategy()
    const originalFetch = configuration[customFetch]
    const tokenFetch = vi.fn<CustomFetch>(async () => {
      throw new Error('Rejected callbacks must not reach token transport.')
    })
    configuration[customFetch] = tokenFetch
    try {
      const rejectCallback = async (state: string) => {
        const fail = vi.fn<(challenge: unknown, status?: number) => void>()
        const rejected = new Promise<number>((resolve, reject) => {
          strategy.fail = (challenge, status) => {
            fail(challenge, status)
            resolve(status ?? 0)
          }
          strategy.error = reject
          strategy.authenticate(createRequest(sessionID, { code: 'authorization-code', state }))
        })
        expect(await rejected).toBe(403)
        expect(fail).toHaveBeenCalledTimes(1)
        expect(tokenFetch).not.toHaveBeenCalled()
      }

      await rejectCallback('wrong-state')
      const attempts = await database('federatedLoginAttempts').where({ providerKey }).count<{ count: string | number }>({ count: '*' }).first()
      expect(Number(attempts?.count ?? 0)).toBe(0)

      const location = await new Promise<URL>((resolve, reject) => {
        strategy.redirect = url => resolve(new URL(url))
        strategy.error = reject
        strategy.authenticate(createRequest(sessionID))
      })
      const issuedState = location.searchParams.get('state')
      expect(issuedState).toBeTruthy()
      if (!issuedState) throw new Error('Provider redirect omitted state')
      const rows = await database('federatedLoginAttempts').where({ providerKey })
      expect(rows).toHaveLength(1)
      const attempt = rows[0]!
      expect(attempt).toMatchObject({ providerKey, providerRevision, sessionId: sessionID, protocol: 'openidconnect' })
      expect(attempt.stateHash).toEqual(createHash('sha256').update(issuedState).digest())

      await rejectCallback(`${issuedState}-mismatch`)
      expect(await database('federatedLoginAttempts')
        .where({ providerKey, providerRevision, sessionId: sessionID, protocol: 'openidconnect' })
        .select<{ id: string; payload: string }[]>('id', 'payload')).toEqual([{ id: attempt.id, payload: attempt.payload }])
    } finally {
      Reflect.set(configuration, customFetch, originalFetch)
    }
  })
})
