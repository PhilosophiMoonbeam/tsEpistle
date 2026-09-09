import createKnex, { type Knex } from 'knex'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from '../../test/bun-test.mts'

import { FEDERATED_LOGIN_TTL_MS, FederatedLoginStore } from '../../repositories/federated-login.ts'
import { up as migrateFederatedLogin } from '../../db/migrations/tsepistle-000030-federated-login-state.ts'

type ProviderPlugin = {
  init(passport: { use(key: string, strategy: unknown): void }, conf: Record<string, unknown>): void | Promise<void>
}

type Strategy = {
  authenticate(request: unknown): void
  redirect(url: string, status?: number): void
  fail(challenge: unknown, status?: number): void
  error(error: Error): void
}

type OAuthRequest = {
  headers: { host: string }
  connection: { encrypted: boolean }
  protocol: string
  secure: boolean
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

const providers = [
  ['google', './google/authentication.ts'],
  ['github', './github/authentication.ts'],
  ['gitlab', './gitlab/authentication.ts'],
  ['discord', './discord/authentication.ts'],
  ['facebook', './facebook/authentication.ts'],
  ['microsoft', './microsoft/authentication.ts'],
  ['keycloak', './keycloak/authentication.ts'],
  ['okta', './okta/authentication.ts'],
  ['rocketchat', './rocketchat/authentication.ts'],
  ['slack', './slack/authentication.ts'],
  ['twitch', './twitch/authentication.ts'],
  ['oauth2', './oauth2/authentication.ts'],
  ['dropbox', './dropbox/authentication.ts']
] as const

const createConfig = (key: string, adminRevision = 'revision-a'): Record<string, unknown> => ({
  key,
  adminRevision,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  callbackURL: `https://wiki.example.com/login/${key}/callback`,
  authorizationURL: 'https://provider.example.com/oauth/authorize',
  tokenURL: 'https://provider.example.com/oauth/token',
  userInfoURL: 'https://provider.example.com/oauth/userinfo',
  baseUrl: 'https://provider.example.com',
  audience: 'https://provider.example.com',
  idp: '',
  host: 'https://provider.example.com',
  realm: 'main',
  siteURL: 'https://provider.example.com',
  team: '',
  useEnterprise: false,
  enterpriseDomain: '',
  enterpriseUserEndpoint: '',
  hostedDomain: '',
  guildId: '',
  logoutURL: '',
  logoutUpstream: false,
  logoutUpstreamRedirectLegacy: false,
  scope: [],
  userIdClaim: 'id',
  displayNameClaim: 'displayName',
  emailClaim: 'email',
  pictureClaim: 'picture',
  groupsClaim: 'groups',
  mapGroups: false,
  useQueryStringForAccessToken: false
})

const createRequest = (key: string, sessionID: string, query: Record<string, unknown> = {}): OAuthRequest => ({
  headers: { host: 'wiki.example.com' },
  connection: { encrypted: true },
  protocol: 'https',
  secure: true,
  method: 'GET',
  url: `/login/${key}/callback`,
  originalUrl: `/login/${key}/callback`,
  query,
  body: {},
  params: { strategy: key },
  sessionID,
  session: { save: callback => callback(null) },
  get: name => name.toLowerCase() === 'host' ? 'wiki.example.com' : undefined
})

const stateFromRedirect = (redirect: ReturnType<typeof vi.fn>): string => {
  const location = new URL(String(redirect.mock.calls[0]?.[0]))
  const state = location.searchParams.get('state')
  if (!state) throw new Error('OAuth authorization redirect did not contain durable state.')
  return state
}

let database: Knex
const originalWiki = Reflect.get(globalThis, 'WIKI')

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
  Reflect.set(globalThis, 'WIKI', {
    logger: { info: vi.fn(), warn: vi.fn() },
    models: { knex: database, users: { processProfile: vi.fn() } }
  })
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

const loadStrategy = async (modulePath: string, config: Record<string, unknown>): Promise<Strategy> => {
  // Authentication plugins are selected by the runtime registry in production; this keeps the shared contract test table-driven.
  const imported = await import(modulePath) as { default: ProviderPlugin }
  const use = vi.fn<(key: string, strategy: unknown) => void>()
  await imported.default.init({ use }, config)
  const strategy = use.mock.calls[0]?.[1]
  if (!strategy || typeof strategy !== 'object') throw new Error(`Provider ${String(config.key)} did not register a strategy.`)
  return strategy as Strategy
}

const prepareProvider = async (key: string, revision = 'revision-a'): Promise<void> => {
  await database('authentication').insert({ key, isEnabled: true, adminRevision: revision })
}

const prepareSession = async (sessionID: string): Promise<void> => {
  await database('sessions').insert({ sid: sessionID, sess: '{}', expired: new Date('2030-01-01T00:00:00.000Z') })
}

const prepareBrowser = async (key: string, sessionID: string, revision = 'revision-a'): Promise<void> => {
  await prepareProvider(key, revision)
  await prepareSession(sessionID)
}

const countAttempts = async (key: string): Promise<number> => {
  const row = await database('federatedLoginAttempts').where({ providerKey: key }).count<{ count: string | number }>({ count: '*' }).first()
  return Number(row?.count ?? 0)
}

const startAuthorization = async (strategy: Strategy, request: OAuthRequest): Promise<{ redirect: ReturnType<typeof vi.fn>; state: string }> => {
  const redirect = vi.fn<(url: string, status?: number) => void>()
  const redirected = new Promise<void>((resolve, reject) => {
    strategy.redirect = (url, status) => {
      redirect(url, status)
      resolve()
    }
    strategy.error = reject
    strategy.authenticate(request)
  })
  await redirected
  return { redirect, state: stateFromRedirect(redirect) }
}
const awaitFailure = async (strategy: Strategy, request: OAuthRequest, fail: ReturnType<typeof vi.fn>): Promise<number> => {
  const rejected = new Promise<number>((resolve, reject) => {
    strategy.fail = (challenge, status) => {
      fail(challenge, status)
      resolve(status ?? 0)
    }
    strategy.error = reject
    strategy.authenticate(request)
  })
  return await rejected
}

describe('OAuth provider durable state requirements', () => {
  it.each(providers)('uses a durable provider-keyed PKCE state record for %s', async (name, modulePath) => {
    const key = `tenant:${name}`
    const sessionID = `session:${name}`
    await prepareBrowser(key, sessionID)
    const strategy = await loadStrategy(modulePath, createConfig(key))
    const started = await startAuthorization(strategy, createRequest(key, sessionID))
    const location = new URL(String(started.redirect.mock.calls[0]?.[0]))

    expect(location.searchParams.get('state')).toBe(started.state)
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(await countAttempts(key)).toBe(1)
    expect(await database('federatedLoginAttempts').where({ providerKey: key }).first('payload')).toMatchObject({ payload: expect.not.stringContaining(started.state) })
  })

  it('rejects missing and mismatched callback state before token exchange', async () => {
    const key = 'tenant:oauth2'
    const sessionID = 'session:oauth2'
    await prepareBrowser(key, sessionID)
    const strategy = await loadStrategy('./oauth2/authentication.ts', createConfig(key))
    const started = await startAuthorization(strategy, createRequest(key, sessionID))
    const fail = vi.fn<(challenge: unknown, status?: number) => void>()

    expect(await awaitFailure(strategy, createRequest(key, sessionID, { code: 'authorization-code' }), fail)).toBe(403)
    expect(fail).toHaveBeenCalledTimes(1)
    expect(await countAttempts(key)).toBe(1)

    fail.mockClear()
    expect(await awaitFailure(strategy, createRequest(key, sessionID, { code: 'authorization-code', state: `${started.state}-mismatch` }), fail)).toBe(403)
    expect(fail).toHaveBeenCalledTimes(1)
  })

  it('isolates two configured instances and consumes a matching state only once', async () => {
    const firstKey = 'tenant:oauth2:first'
    const secondKey = 'tenant:oauth2:second'
    const sessionID = 'session:shared'
    await prepareProvider(firstKey)
    await prepareProvider(secondKey)
    await prepareSession(sessionID)
    const first = await loadStrategy('./oauth2/authentication.ts', createConfig(firstKey))
    const second = await loadStrategy('./oauth2/authentication.ts', createConfig(secondKey))
    const firstStarted = await startAuthorization(first, createRequest(firstKey, sessionID))
    const secondStarted = await startAuthorization(second, createRequest(secondKey, sessionID))

    expect(firstStarted.state).not.toBe(secondStarted.state)
    const firstFail = vi.fn<(challenge: unknown, status?: number) => void>()
    expect(await awaitFailure(first, createRequest(firstKey, sessionID, { code: 'code', state: secondStarted.state }), firstFail)).toBe(403)
    expect(firstFail).toHaveBeenCalledTimes(1)
    expect(await countAttempts(secondKey)).toBe(1)

    const now = new Date()
    const store = new FederatedLoginStore(database, { now: () => now })
    const consumed = await store.consume({ providerKey: secondKey, providerRevision: 'revision-a', protocol: 'oauth2', sessionId: sessionID, state: secondStarted.state })
    expect(consumed?.providerKey).toBe(secondKey)
    expect(await store.consume({ providerKey: secondKey, providerRevision: 'revision-a', protocol: 'oauth2', sessionId: sessionID, state: secondStarted.state })).toBeNull()
  })

  it('enforces the ten-minute expiry boundary', async () => {
    const key = 'tenant:expiry'
    const sessionID = 'session:expiry'
    await prepareBrowser(key, sessionID)
    let now = new Date('2026-01-01T00:00:00.000Z')
    const store = new FederatedLoginStore(database, { now: () => now })
    const issued = await store.issue({
      sessionId: sessionID,
      providerKey: key,
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: { codeVerifier: 'verifier' },
      issuedAt: now
    })
    now = new Date(now.getTime() + FEDERATED_LOGIN_TTL_MS)
    expect(await store.consume({ providerKey: key, providerRevision: 'revision-a', protocol: 'oauth2', sessionId: sessionID, state: issued.state })).toBeNull()
  })
})