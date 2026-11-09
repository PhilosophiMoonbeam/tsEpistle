import { createHash } from 'node:crypto'
import { SAML, type SamlConfig } from '@node-saml/node-saml'
import { SignedXml } from 'xml-crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from '../../../test/bun-test.mts'
import { tlsFixture } from '../../../test/helpers/tls-fixture.mts'
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

const loadStrategy = async (overrides: Record<string, unknown> = {}): Promise<Strategy> => {
  const originalWiki = Reflect.get(globalThis, 'WIKI')
  Reflect.set(globalThis, 'WIKI', {
    models: {
      knex: {},
      users: { processProfile: vi.fn() }
    }
  })
  const imported = await import('./authentication.ts') as unknown as { default: { init(registry: PassportRegistry, value: typeof config): void } }
  const registry: PassportRegistry = { use: vi.fn() }
  imported.default.init(registry, { ...config, ...overrides })
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
    const requestId = (options.generateUniqueId as () => string)()
    expect(requestId).toBeTruthy()
    expect(issue).toHaveBeenCalledTimes(1)
    expect(request.res.cookie).toHaveBeenCalledTimes(1)
    const [cookieName, browserNonce, cookieOptions] = request.res.cookie.mock.calls[0]!
    expect(cookieName).toBe(federatedLoginCookieName(config.key))
    expect(cookieName).toMatch(/^__Host-/u)
    expect(browserNonce).toEqual(expect.any(String))
    expect(browserNonce).toBeTruthy()
    expect(cookieOptions).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'none',
      path: '/',
      maxAge: 600_000
    })
    expect(cookieOptions).not.toHaveProperty('domain')
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({
      providerKey: 'saml:primary',
      protocol: 'saml',
      providerRevision: 'revision-a',
      sessionId: request.sessionID,
      browserNonceHash: createHash('sha256').update(browserNonce).digest(),
      payload: expect.objectContaining({ requestId })
    }))

    const cache = options.cacheProvider as {
      saveAsync(key: string, value: string): Promise<unknown>
      getAsync(key: string): Promise<string | null>
    }
    const timestamp = '2026-09-09T00:00:00.000Z'
    await expect(cache.saveAsync(requestId, timestamp)).resolves.toEqual({ value: timestamp, createdAt: Date.parse(timestamp) })
    await expect(cache.getAsync(requestId)).resolves.toBe(timestamp)
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
    const issue = vi.spyOn(FederatedLoginStore.prototype, 'issue').mockResolvedValue({
      attemptId: 'attempt-a',
      state: 'state-a',
      issuedAt: new Date('2026-09-09T00:00:00.000Z'),
      expiresAt: new Date('2026-09-09T00:10:00.000Z')
    })
    const strategy = await loadStrategy()
    const request = createRequest({ path: '/login/saml:primary/callback', originalUrl: '/login/saml:primary/callback' })
    const done = vi.fn<(error: Error | null, options?: Record<string, unknown>) => void>()
    await new Promise<void>(resolve => {
      strategy._options.getSamlOptions(request, (error, options) => {
        done(error, options)
        resolve()
      })
    })
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(done.mock.calls[0]?.[1]).toBeUndefined()
    expect(issue).not.toHaveBeenCalled()
    expect(request.res.cookie).not.toHaveBeenCalled()
  })
})

describe('SAML response signature policy with the installed validator', () => {
  let certificates: { first: { key: string; cert: string }; second: { cert: string }; close(): void }
  beforeAll(() => { certificates = tlsFixture() })
  afterAll(() => { certificates?.close() })

  const sign = (xml: string, element: 'Assertion' | 'Response'): string => {
    const signature = new SignedXml({
      privateKey: certificates.first.key,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#'
    })
    signature.addReference({
      xpath: `//*[local-name()='${element}']`,
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256'
    })
    signature.computeSignature(xml, { location: { reference: `//*[local-name()='${element}']/*[local-name()='Issuer']`, action: 'after' } })
    return signature.getSignedXml()
  }

  const fixture = (options: { assertion?: boolean; response?: boolean; expires?: string; conditionExpires?: string; audience?: string; subjectRequest?: string } = {}): string => {
    const now = new Date().toISOString()
    const expires = options.expires ?? new Date(Date.now() + 300_000).toISOString()
    let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_response" Version="2.0" InResponseTo="_request" IssueInstant="${now}">
      <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.example.com</saml:Issuer>
      <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assertion" Version="2.0" IssueInstant="${now}">
        <saml:Issuer>https://idp.example.com</saml:Issuer>
        <saml:Subject><saml:NameID>alice</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
          <saml:SubjectConfirmationData InResponseTo="${options.subjectRequest ?? '_request'}" NotOnOrAfter="${expires}"/>
        </saml:SubjectConfirmation></saml:Subject>
        <saml:Conditions NotBefore="${new Date(Date.now() - 60_000).toISOString()}" NotOnOrAfter="${options.conditionExpires ?? expires}">
          <saml:AudienceRestriction><saml:Audience>${options.audience ?? config.audience}</saml:Audience></saml:AudienceRestriction>
        </saml:Conditions>
      </saml:Assertion>
    </samlp:Response>`
    if (options.assertion !== false) xml = sign(xml, 'Assertion')
    if (options.response !== false) xml = sign(xml, 'Response')
    return xml
  }

  const consumeAttempt = (issuedAt = new Date()) => ({
    attemptId: 'attempt-a',
    providerKey: config.key,
    protocol: 'saml' as const,
    providerRevision: config.adminRevision,
    sessionId: 'session-a',
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 600_000),
    payload: { requestId: '_request' }
  })

  const validator = async (overrides: Record<string, unknown> = {}): Promise<SAML> => {
    const strategy = await loadStrategy({ cert: certificates.first.cert, ...overrides })
    const request = createRequest({
      path: '/login/saml:primary/callback',
      originalUrl: '/login/saml:primary/callback',
      body: { SAMLResponse: 'present' },
      cookies: { [federatedLoginCookieName(config.key)]: 'browser-nonce' }
    })
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>()
    strategy._options.getSamlOptions(request, (error, value) => error ? reject(error) : resolve(value ?? {}))
    const options = await promise
    const idpCert = options.idpCert
    if (!(typeof idpCert === 'string' || Array.isArray(idpCert) && idpCert.every((cert: unknown): cert is string => typeof cert === 'string')) || typeof options.issuer !== 'string' || typeof options.callbackUrl !== 'string') {
      throw new Error('The native strategy did not provide its required SAML configuration.')
    }
    const nativeOptions: SamlConfig = { ...options, idpCert, issuer: options.issuer, callbackUrl: options.callbackUrl }
    return new SAML(nativeOptions)
  }

  const validate = (saml: SAML, xml: string) => saml.validatePostResponseAsync({ SAMLResponse: Buffer.from(xml).toString('base64') })

  it('keeps old providers strict and permits assertion-only login only after an explicit Boolean opt-out', async () => {
    vi.spyOn(FederatedLoginStore.prototype, 'consume').mockImplementation(async () => consumeAttempt())
    const bothSigned = fixture()
    expect((await validate(await validator(), bothSigned)).profile?.nameID).toBe('alice')
    await expect(validate(await validator(), fixture({ response: false }))).rejects.toThrow()
    await expect(validate(await validator({ wantAuthnResponseSigned: 'false' }), fixture({ response: false }))).rejects.toThrow()
    expect((await validate(await validator({ wantAuthnResponseSigned: false }), fixture({ response: false }))).profile?.nameID).toBe('alice')
  })

  it('preserves the assertion requirement, including when response signatures are optional', async () => {
    vi.spyOn(FederatedLoginStore.prototype, 'consume').mockImplementation(async () => consumeAttempt())
    for (const wantAuthnResponseSigned of [true, false]) {
      await expect(validate(await validator({ wantAuthnResponseSigned }), fixture({ assertion: false }))).rejects.toThrow()
      // Existing providers may intentionally require only a signed response.
      expect((await validate(await validator({ wantAuthnResponseSigned, wantAssertionsSigned: false }), fixture({ assertion: false }))).profile?.nameID).toBe('alice')
    }
    await expect(validate(await validator({ wantAuthnResponseSigned: false, wantAssertionsSigned: false }), fixture({ assertion: false, response: false }))).rejects.toThrow()
    expect((await validate(await validator({ wantAuthnResponseSigned: false, wantAssertionsSigned: false }), fixture({ response: false }))).profile?.nameID).toBe('alice')
  })

  it('refuses untrusted keys and tampering within either signed scope', async () => {
    vi.spyOn(FederatedLoginStore.prototype, 'consume').mockImplementation(async () => consumeAttempt())
    const bothSigned = fixture()
    const assertionSigned = fixture({ response: false })
    expect((await validate(await validator(), bothSigned)).profile?.nameID).toBe('alice')
    expect((await validate(await validator({ wantAuthnResponseSigned: false }), assertionSigned)).profile?.nameID).toBe('alice')
    await expect(validate(await validator({ cert: certificates.second.cert }), bothSigned)).rejects.toThrow()
    await expect(validate(await validator({ cert: certificates.second.cert, wantAuthnResponseSigned: false }), assertionSigned)).rejects.toThrow()
    await expect(validate(await validator(), bothSigned.replace('ID="_response"', 'ID="_tampered"'))).rejects.toThrow()
    await expect(validate(await validator({ wantAuthnResponseSigned: false }), assertionSigned.replace('>alice<', '>mallory<'))).rejects.toThrow()
  })

  it('refuses multiple and wrapped assertions rather than authenticating an unsigned sibling', async () => {
    vi.spyOn(FederatedLoginStore.prototype, 'consume').mockImplementation(async () => consumeAttempt())
    const signed = fixture({ response: false })
    expect((await validate(await validator({ wantAuthnResponseSigned: false }), signed)).profile?.nameID).toBe('alice')
    const start = signed.indexOf('<saml:Assertion')
    const end = signed.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length
    const assertion = signed.slice(start, end)
    const unsigned = fixture({ assertion: false, response: false })
    const unsignedStart = unsigned.indexOf('<saml:Assertion')
    const unsignedEnd = unsigned.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length
    const attacker = unsigned.slice(unsignedStart, unsignedEnd).replace('_assertion', '_attacker').replace('>alice<', '>mallory<')
    const multiple = signed.replace('</samlp:Response>', `${attacker}</samlp:Response>`)
    await expect(validate(await validator({ wantAuthnResponseSigned: false }), multiple)).rejects.toThrow()
    const wrapped = signed.replace(assertion, `<samlp:Extensions>${assertion}</samlp:Extensions>${attacker}`)
    await expect(validate(await validator({ wantAuthnResponseSigned: false }), wrapped)).rejects.toThrow()
  })

  it('retains audience, time and signed subject-to-response correlation checks under assertion-only policy', async () => {
    vi.spyOn(FederatedLoginStore.prototype, 'consume').mockImplementation(async () => consumeAttempt())
    const policy = { wantAuthnResponseSigned: false }
    const signed = fixture({ response: false })
    expect((await validate(await validator(policy), signed)).profile?.nameID).toBe('alice')
    await expect(validate(await validator(policy), fixture({ response: false, audience: 'https://attacker.example.com' }))).rejects.toThrow()
    await expect(validate(await validator(policy), fixture({ response: false, expires: new Date(Date.now() - 1_000).toISOString() }))).rejects.toThrow()
    await expect(validate(await validator(policy), fixture({ response: false, conditionExpires: new Date(Date.now() - 1_000).toISOString() }))).rejects.toThrow()
    await expect(validate(await validator(policy), fixture({ response: false, subjectRequest: '_other' }))).rejects.toThrow()
    await expect(validate(await validator(policy), signed.replace('InResponseTo="_request"', 'InResponseTo="_other"'))).rejects.toThrow()
  })

  it('refuses missing, expired and previously consumed request correlation across callbacks', async () => {
    const consume = vi.spyOn(FederatedLoginStore.prototype, 'consume').mockResolvedValueOnce(consumeAttempt()).mockResolvedValue(null)
    const xml = fixture({ response: false })
    const policy = { wantAuthnResponseSigned: false }
    expect((await validate(await validator(policy), xml)).profile?.nameID).toBe('alice')
    await expect(validate(await validator(policy), xml)).rejects.toThrow()
    expect(consume).toHaveBeenCalledTimes(2)
    consume.mockResolvedValue(consumeAttempt(new Date(Date.now() - 601_000)))
    await expect(validate(await validator(policy), xml)).rejects.toThrow()
    await expect(validate(await validator(policy), xml.replace(' InResponseTo="_request"', ''))).rejects.toThrow()
    expect(consume).toHaveBeenLastCalledWith(expect.objectContaining({ providerKey: config.key, providerRevision: config.adminRevision, protocol: 'saml' }))
  })
})
