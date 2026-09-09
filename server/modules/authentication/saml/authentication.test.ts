import { afterEach, describe, expect, it, vi } from '../../../test/bun-test.mts'
import { federatedLoginCookieName } from '../../../helpers/federated-login.ts'
import { FederatedLoginStore } from '../../../repositories/federated-login.ts'

type PassportRegistry = { use: ReturnType<typeof vi.fn> }
type Strategy = {
  _options: {
    getSamlOptions(request: unknown, done: (error: Error | null, options?: Record<string, unknown>) => void): void
  }
}

type RequestLike = {
  path: string
  originalUrl: string
  query: Record<string, unknown>
  body: Record<string, unknown>
  params: { strategy: string }
  sessionID: string
  session: { save(done: (error?: Error) => void): void }
  protocol: string
  secure: boolean
  get(name: string): string | undefined
  cookies: Record<string, string>
  res: { cookie: ReturnType<typeof vi.fn> }
}

const config = {
  key: 'saml:primary',
  adminRevision: 'revision-a',
  callbackURL: 'https://wiki.example.com/login/saml:primary/callback',
  entryPoint: 'https://idp.example.com/sso',
  issuer: 'https://wiki.example.com',
  audience: 'https://wiki.example.com',
  cert: 'idp-certificate',
  privateKey: '',
  decryptionPvk: '',
  signatureAlgorithm: 'sha256',
  digestAlgorithm: 'sha256',
  identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  wantAssertionsSigned: true,
  acceptedClockSkewMs: 0,
  disableRequestedAuthnContext: false,
  authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
  racComparison: 'exact',
  forceAuthn: false,
  passive: false,
  providerName: 'tsEpistle',
  skipRequestCompression: false,
  authnRequestBinding: 'HTTP-POST',
  mappingUID: 'uid',
  mappingEmail: 'email',
  mappingDisplayName: 'displayName',
  mappingPicture: 'picture',
  mappingGroups: 'groups',
  mapGroups: false
}

const createRequest = (overrides: Partial<RequestLike> = {}): RequestLike => ({
  path: '/login/saml:primary',
  originalUrl: '/login/saml:primary',
  query: {},
  body: {},
  params: { strategy: 'saml:primary' },
  sessionID: 'session-a',
  session: { save: done => done() },
  protocol: 'https',
  secure: true,
  get: () => undefined,
  cookies: {},
  res: { cookie: vi.fn() },
  ...overrides
})

const loadStrategy = async (): Promise<Strategy> => {
  const originalWiki = Reflect.get(globalThis, 'WIKI')
  Reflect.set(globalThis, 'WIKI', {
    models: {
      knex: {},
      users: { processProfile: vi.fn() }
    }
  })
  const imported = await import('./authentication.ts') as unknown as { default: { init(registry: PassportRegistry, value: typeof config): void } }
  const registry: PassportRegistry = { use: vi.fn() }
  imported.default.init(registry, config)
  if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
  else Reflect.set(globalThis, 'WIKI', originalWiki)
  const strategy = registry.use.mock.calls[0]?.[1]
  if (!strategy || typeof strategy !== 'object') throw new Error('SAML strategy was not registered.')
  return strategy as Strategy
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, 'WIKI')
})

describe('SAML federation correlation', () => {
  it('issues one durable browser-bound initiation with strict ten-minute request validation', async () => {
    const issue = vi.spyOn(FederatedLoginStore.prototype, 'issue').mockResolvedValue({
      attemptId: 'attempt-a',
      state: 'state-a',
      issuedAt: new Date('2026-09-09T00:00:00.000Z'),
      expiresAt: new Date('2026-09-09T00:10:00.000Z')
    })
    const strategy = await loadStrategy()
    const request = createRequest()
    const options = await new Promise<Record<string, unknown>>((resolve, reject) => {
      strategy._options.getSamlOptions(request, (error, value) => error ? reject(error) : resolve(value ?? {}))
    })

    expect(options.validateInResponseTo).toBe('always')
    expect(options.requestIdExpirationPeriodMs).toBe(600_000)
    expect(typeof options.generateUniqueId).toBe('function')
    expect(request.res.cookie).toHaveBeenCalledTimes(1)
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({
      providerKey: 'saml:primary',
      protocol: 'saml',
      providerRevision: 'revision-a',
      payload: expect.objectContaining({ requestId: expect.any(String) })
    }))

    const requestId = (options.generateUniqueId as () => string)()
    const cache = options.cacheProvider as { saveAsync(key: string, value: string): Promise<unknown> }
    await cache.saveAsync(requestId, '2026-09-09T00:00:00.000Z')
  })

  it('consumes the durable attempt once and serves repeated request-id cache reads locally', async () => {
    const consume = vi.spyOn(FederatedLoginStore.prototype, 'consume').mockResolvedValue({
      attemptId: 'attempt-a',
      providerKey: 'saml:primary',
      protocol: 'saml',
      providerRevision: 'revision-a',
      sessionId: 'session-a',
      issuedAt: new Date('2026-09-09T00:00:00.000Z'),
      expiresAt: new Date('2026-09-09T00:10:00.000Z'),
      payload: { requestId: 'request-a' }
    })
    const strategy = await loadStrategy()
    const request = createRequest({
      path: '/login/saml:primary/callback',
      originalUrl: '/login/saml:primary/callback',
      body: { SAMLResponse: 'response' },
      cookies: { [federatedLoginCookieName('saml:primary')]: 'browser-nonce' }
    })
    const options = await new Promise<Record<string, unknown>>((resolve, reject) => {
      strategy._options.getSamlOptions(request, (error, value) => error ? reject(error) : resolve(value ?? {}))
    })
    const cache = options.cacheProvider as { getAsync(key: string): Promise<string | null> }

    await expect(cache.getAsync('request-a')).resolves.toBe('2026-09-09T00:00:00.000Z')
    await expect(cache.getAsync('request-a')).resolves.toBe('2026-09-09T00:00:00.000Z')
    expect(consume).toHaveBeenCalledTimes(1)
  })

  it('rejects a callback without a SAML response instead of starting unsolicited login', async () => {
    const strategy = await loadStrategy()
    const request = createRequest({ path: '/login/saml:primary/callback', originalUrl: '/login/saml:primary/callback' })
    await expect(new Promise((resolve, reject) => {
      strategy._options.getSamlOptions(request, (error, value) => error ? resolve(error) : reject(value))
    })).resolves.toMatchObject({ message: 'SAML callback correlation is missing.' })
  })
})
