import { afterEach, describe, expect, it, vi } from '../../../test/bun-test.mts'

import { CasStrategy, type CasProfile, type CasRequest, type VerifyDone } from './cas-strategy.ts'

const createRequest = (query: Record<string, unknown> = {}): CasRequest => ({
  originalUrl: '/login/cas',
  query,
  logout: (done: (error?: Error) => void) => done()
}) as unknown as CasRequest

const createStrategy = (verify: (profile: CasProfile, done: VerifyDone) => void): CasStrategy => new CasStrategy({
  version: 'CAS3.0',
  ssoBaseURL: 'https://login.example.com/cas',
  serverBaseURL: 'https://wiki.example.com',
  serviceURL: '/login/cas?source=wiki',
  passReqToCallback: true
}, (_request, profile, done) => verify(profile, done))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CAS strategy', () => {
  it('redirects unauthenticated requests to the CAS login endpoint', () => {
    const strategy = createStrategy(() => {})
    const redirect = vi.fn()
    strategy.redirect = redirect

    strategy.authenticate(createRequest(), { loginParams: { renew: true, ignored: false } })

    const target = new URL(String(redirect.mock.calls[0]?.[0]))
    expect(`${target.origin}${target.pathname}`).toBe('https://login.example.com/cas/login')
    expect(target.searchParams.get('service')).toBe('https://wiki.example.com/login/cas?source=wiki')
    expect(target.searchParams.get('renew')).toBe('true')
    expect(target.searchParams.has('ignored')).toBe(false)
  })

  it('validates a CAS 3 ticket and normalizes profile attributes', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      void input
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
      })
      strategy.success = vi.fn()
      strategy.error = reject
      strategy.authenticate(createRequest({ ticket: 'ST-123' }))
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
    expect(validationUrl.searchParams.get('service')).toBe('https://wiki.example.com/login/cas?source=wiki')
  })

  it('reports CAS authentication failures without invoking verification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`
      <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
        <cas:authenticationFailure code="INVALID_TICKET">Ticket expired</cas:authenticationFailure>
      </cas:serviceResponse>
    `, { status: 200 })))
    const verify = vi.fn()
    const strategy = createStrategy(verify)
    const error = new Promise<Error>(resolve => {
      strategy.error = resolve
    })

    strategy.authenticate(createRequest({ ticket: 'ST-expired' }))

    expect(await error).toMatchObject({ message: 'CAS authentication failed (INVALID_TICKET).' })
    expect(verify).not.toHaveBeenCalled()
  })

  it('bounds ticket validation responses without relying on content-length', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))))
    const verify = vi.fn()
    const strategy = createStrategy(verify)
    const error = new Promise<Error>(resolve => {
      strategy.error = resolve
    })

    strategy.authenticate(createRequest({ ticket: 'ST-oversized' }))

    expect(await error).toMatchObject({ message: 'CAS ticket validation response is too large.' })
    expect(verify).not.toHaveBeenCalled()
  })
})
