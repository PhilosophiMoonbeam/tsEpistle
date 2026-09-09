import { afterEach, describe, expect, it, vi } from '../../../test/bun-test.mts'

import { CasStrategy, type CasFederationOptions, type CasProfile, type CasRequest, type VerifyDone } from './cas-strategy.ts'

const createRequest = (query: Record<string, unknown> = {}): CasRequest => ({
  originalUrl: '/login/cas',
  query,
  params: { strategy: 'cas:primary' },
  sessionID: 'session-a',
  session: { save: (done: (error?: Error) => void) => done() },
  logout: (done: (error?: Error) => void) => done()
}) as unknown as CasRequest

const createStore = (consume: CasFederationOptions['store']['consume'] = async () => null): CasFederationOptions['store'] => ({
  issue: vi.fn(async () => ({ attemptId: 'attempt-a', state: 'state-a', issuedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) })),
  consume: vi.fn(consume)
})

const createStrategy = (
  verify: (profile: CasProfile, done: VerifyDone) => void,
  store = createStore()
): CasStrategy => new CasStrategy({
  version: 'CAS3.0',
  ssoBaseURL: 'https://login.example.com/cas',
  serverBaseURL: 'https://wiki.example.com',
  serviceURL: '/login/cas?source=wiki',
  passReqToCallback: true,
  federation: {
    providerKey: 'cas:primary',
    providerRevision: 'revision-a',
    store
  }
}, (_request, profile, done) => verify(profile, done))
const consumedStore = (requestId = 'state-a'): CasFederationOptions['store'] => {
  const serviceUrl = `https://wiki.example.com/login/cas?source=wiki&state=${requestId}`
  return createStore(async input => ({
    attemptId: 'attempt-a',
    providerKey: input.providerKey,
    protocol: 'cas',
    providerRevision: input.providerRevision,
    sessionId: input.sessionId ?? 'session-a',
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
    payload: { serviceUrl, requestId }
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CAS strategy', () => {
  it('redirects unauthenticated requests to the CAS login endpoint with a bound service nonce', async () => {
    const store = createStore()
    const strategy = createStrategy(() => {}, store)
    const redirect = vi.fn()
    const redirected = new Promise<void>((resolve, reject) => {
      strategy.redirect = (url, status) => {
        redirect(url, status)
        resolve()
      }
      strategy.error = reject
      strategy.authenticate(createRequest(), { loginParams: { renew: true, ignored: false } })
    })
    await redirected

    const target = new URL(String(redirect.mock.calls[0]?.[0]))
    const service = target.searchParams.get('service')
    expect(`${target.origin}${target.pathname}`).toBe('https://login.example.com/cas/login')
    expect(service).toMatch(/^https:\/\/wiki\.example\.com\/login\/cas\?source=wiki&state=[A-Za-z0-9_-]+$/u)
    expect(target.searchParams.get('renew')).toBe('true')
    expect(target.searchParams.has('ignored')).toBe(false)
    expect(store.issue).toHaveBeenCalledWith(expect.objectContaining({
      providerKey: 'cas:primary',
      protocol: 'cas',
      providerRevision: 'revision-a',
      payload: expect.objectContaining({ serviceUrl: service })
    }))
  })
  it('consumes the bound CAS attempt before validating a ticket and normalizes profile attributes', async () => {
    const requestId = 'state-a'
    const service = `https://wiki.example.com/login/cas?source=wiki&state=${requestId}`
    let consumedBeforeFetch = false
    const store = createStore(async input => {
      consumedBeforeFetch = true
      return {
        attemptId: 'attempt-a',
        providerKey: input.providerKey,
        protocol: 'cas',
        providerRevision: input.providerRevision,
        sessionId: input.sessionId ?? 'session-a',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        payload: { serviceUrl: service, requestId }
      }
    })
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      void input
      expect(consumedBeforeFetch).toBe(true)
      return new Response(`
        <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
          <cas:authenticationSuccess>
            <cas:user>alice</cas:user>
            <cas:attributes>
              <cas:Email>Alice@example.com</cas:Email>
              <cas:displayName>Alice Example</cas:displayName>
            </cas:attributes>
          </cas:authenticationSuccess>
        </cas:serviceResponse>
      `, { status: 200, headers: { 'content-type': 'application/xml' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const profilePromise = new Promise<CasProfile>((resolve, reject) => {
      const strategy = createStrategy((profile, done) => {
        resolve(profile)
        done(null, { id: 'wiki-user' })
      }, store)
      strategy.success = vi.fn()
      strategy.error = reject
      strategy.authenticate(createRequest({ ticket: 'ST-123', state: requestId }))
    })

    const profile = await profilePromise

    expect(profile).toEqual({
      user: 'alice',
      attributes: {
        email: 'Alice@example.com',
        displayname: 'Alice Example'
      }
    })
    const validationUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(`${validationUrl.origin}${validationUrl.pathname}`).toBe('https://login.example.com/cas/p3/serviceValidate')
    expect(validationUrl.searchParams.get('ticket')).toBe('ST-123')
    expect(validationUrl.searchParams.get('service')).toBe(service)
  })

  it('reports CAS authentication failures without invoking verification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`
      <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
        <cas:authenticationFailure code="INVALID_TICKET">Ticket expired</cas:authenticationFailure>
      </cas:serviceResponse>
    `, { status: 200 })))
    const verify = vi.fn()
    const strategy = createStrategy(verify, consumedStore())
    const error = new Promise<Error>(resolve => {
      strategy.error = resolve
    })

    strategy.authenticate(createRequest({ ticket: 'ST-expired', state: 'state-a' }))

    expect(await error).toMatchObject({ message: 'CAS authentication failed (INVALID_TICKET).' })
    expect(verify).not.toHaveBeenCalled()
  })

  it('bounds ticket validation responses without relying on content-length', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))))
    const verify = vi.fn()
    const strategy = createStrategy(verify, consumedStore())
    const error = new Promise<Error>(resolve => {
      strategy.error = resolve
    })

    strategy.authenticate(createRequest({ ticket: 'ST-oversized', state: 'state-a' }))

    expect(await error).toMatchObject({ message: 'CAS ticket validation response is too large.' })
    expect(verify).not.toHaveBeenCalled()
  })
})
