import { afterEach, describe, expect, it, vi } from '../../../test/bun-test.mts'

import { OAuthStateStore } from '../oauth-state.ts'
import { DropboxStrategy, type DropboxProfile, type DropboxStrategyOptions, type DropboxVerify } from './dropbox-strategy.ts'

const options: DropboxStrategyOptions = {
  clientID: 'app-key',
  clientSecret: 'app-secret',
  callbackURL: 'https://wiki.example.com/login/dropbox/callback',
  passReqToCallback: true,
  state: true,
  pkce: true,
  store: new OAuthStateStore({ providerKey: 'dropbox', providerRevision: 'revision-a', backend: {} as never })
}

const createStrategy = (): DropboxStrategy =>
  new DropboxStrategy(options, (_request, _accessToken, _refreshToken, _profile, done) => {
    done(null, { id: 1 })
  })

const profileResponse = {
  account_id: 'dbid:123',
  name: {
    display_name: 'Alice Example',
    given_name: 'Alice',
    surname: 'Example',
    familiar_name: 'Alice'
  },
  email: 'alice@example.com',
  email_verified: true as const,
  profile_photo_url: 'https://dropbox.example.com/alice.png'
}
const sparseProfileResponse = {
  account_id: 'dbid:sparse',
  name: {
    display_name: 'Dropbox User'
  },
  email: 'sparse@example.com',
  email_verified: true as const,
  profile_photo_url: null
}

const getProfile = (strategy: DropboxStrategy): Promise<DropboxProfile> => new Promise((resolve, reject) => {
  strategy.userProfile('access-token', (error, profile) => {
    if (error) reject(error)
    else if (profile) resolve(profile)
    else reject(new Error('Dropbox strategy returned no profile.'))
  })
})
const getProfileError = (strategy: DropboxStrategy): Promise<Error> => new Promise(resolve => {
  strategy.userProfile('access-token', error => resolve(error ?? new Error('Dropbox strategy returned no error.')))
})

const profileRequest = (body: string, status = 200): Promise<Response> => Promise.resolve(new Response(body, { status }))

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, 'WIKI')
})

describe('Dropbox strategy', () => {
  it('uses Dropbox OAuth endpoints, PKCE, and the configured strategy name', () => {
    const strategy = createStrategy()
    expect(strategy._oauth2._accessTokenUrl).toBe('https://api.dropboxapi.com/oauth2/token')
    expect(strategy.name).toBe('dropbox-oauth2')
    expect(options.pkce).toBe(true)
    expect(options.store).toBeInstanceOf(OAuthStateStore)
  })

  it('registers under the configured transport-specific provider key', async () => {
    Reflect.set(globalThis, 'WIKI', { models: { knex: {} } })
    const { default: dropboxAuthentication } = await import('./authentication.ts')
    const passport = { use: vi.fn() }

    dropboxAuthentication.init(
      passport as never,
      {
        key: 'agents:dropbox',
        adminRevision: 'revision-a',
        clientId: options.clientID,
        clientSecret: options.clientSecret,
        callbackURL: options.callbackURL
      } as never
    )

    const [key, strategy] = passport.use.mock.calls[0] ?? []
    expect(key).toBe('agents:dropbox')
    expect(strategy).toMatchObject({ name: 'dropbox-oauth2' })
  })

  it('POSTs the literal null body and normalizes the exact Dropbox account contract', async () => {
    const body = JSON.stringify(profileResponse)
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.dropboxapi.com/2/users/get_current_account')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-token')
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
      expect(init?.body).toBe('null')
      expect(init?.redirect).toBe('error')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return await profileRequest(body)
    })
    vi.stubGlobal('fetch', fetchMock)

    const profile = await getProfile(createStrategy())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(profile).toEqual({
      provider: 'dropbox',
      id: 'dbid:123',
      displayName: 'Alice Example',
      name: { familyName: 'Example', givenName: 'Alice', middleName: '' },
      emails: [{ value: 'alice@example.com' }],
      _raw: body,
      _json: profileResponse
    })
  })

  it('accepts sparse names and preserves nullable profile photos in the parsed JSON', async () => {
    const body = JSON.stringify(sparseProfileResponse)
    vi.stubGlobal('fetch', vi.fn(async () => await profileRequest(body)))

    const profile = await getProfile(createStrategy())

    expect(profile).toEqual({
      provider: 'dropbox',
      id: 'dbid:sparse',
      displayName: 'Dropbox User',
      name: { familyName: '', givenName: '', middleName: '' },
      emails: [{ value: 'sparse@example.com' }],
      _raw: body,
      _json: sparseProfileResponse
    })
  })

  it.each([
    ['email_verified is false', { ...profileResponse, email_verified: false }, 'email_verified'],
    ['email_verified is missing', { account_id: profileResponse.account_id, name: profileResponse.name, email: profileResponse.email, profile_photo_url: profileResponse.profile_photo_url }, 'email_verified'],
    ['email is invalid', { ...profileResponse, email: 'not-an-email' }, 'email']
  ] as const)('rejects an account when %s before the Passport verifier can receive a profile', async (_case, account, invalidField) => {
    const verify = vi.fn<DropboxVerify>()
    const fetchMock = vi.fn(async () => await profileRequest(JSON.stringify(account)))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getProfileError(new DropboxStrategy(options, verify))).resolves.toMatchObject({ message: expect.stringContaining(invalidField) })
    expect(verify).not.toHaveBeenCalled()
  })

  it('rejects non-2xx, malformed, oversized, and incomplete account responses', async () => {
    const cases: Array<{ response: Response; message: string }> = [
      { response: new Response('not authorized', { status: 401 }), message: 'HTTP 401' },
      { response: new Response('{not-json', { status: 200 }), message: 'not valid JSON' },
      { response: new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }), message: 'too large' },
      { response: new Response(JSON.stringify({ name: profileResponse.name, email: profileResponse.email, email_verified: true }), { status: 200 }), message: 'account_id' },
      { response: new Response(JSON.stringify({ account_id: 'dbid:123', name: profileResponse.name, email_verified: true }), { status: 200 }), message: 'email' },
      { response: new Response(JSON.stringify({ account_id: 'dbid:123', name: { given_name: 'Alice', surname: 'Example' }, email: profileResponse.email, email_verified: true }), { status: 200 }), message: 'display_name' }
    ]

    for (const { response, message } of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => response))
      await expect(getProfileError(createStrategy())).resolves.toMatchObject({ message: expect.stringContaining(message) })
      vi.unstubAllGlobals()
    }
  })
})

