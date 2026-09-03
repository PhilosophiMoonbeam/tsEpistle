import { afterEach, describe, expect, it, vi } from '../../../test/bun-test.mts'

import { DropboxStrategy, type DropboxProfile, type DropboxStrategyOptions, type DropboxVerify } from './dropbox-strategy.ts'

const options: DropboxStrategyOptions = {
  clientID: 'app-key',
  clientSecret: 'app-secret',
  callbackURL: 'https://wiki.example.com/login/dropbox/callback',
  passReqToCallback: true
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

const callbackProfile: DropboxProfile = {
  provider: 'dropbox',
  id: profileResponse.account_id,
  displayName: profileResponse.name.display_name,
  name: {
    familyName: profileResponse.name.surname,
    givenName: profileResponse.name.given_name,
    middleName: ''
  },
  emails: [{ value: profileResponse.email }],
  _raw: JSON.stringify(profileResponse),
  _json: profileResponse
}
type OAuthSession = Record<string, unknown>
type OAuthRequest = {
  query: Record<string, unknown>
  body: Record<string, unknown>
  params: { strategy: string }
  session: OAuthSession
}
type OAuth2AccessTokenMethod = DropboxStrategy['_oauth2']['getOAuthAccessToken']

const oauthSessionKey = 'oauth2:www.dropbox.com'
const createRequest = (session: OAuthSession, query: Record<string, unknown> = {}): OAuthRequest => ({
  query,
  body: {},
  params: { strategy: 'dropbox' },
  session
})
const getStoredState = (session: OAuthSession): string => {
  const state = (session[oauthSessionKey] as { state?: unknown } | undefined)?.state
  if (typeof state !== 'string' || state.length === 0) throw new Error('Dropbox authorization state was not stored in the request session.')
  return state
}
const startAuthorization = (strategy: DropboxStrategy): { session: OAuthSession; state: string; target: URL } => {
  const session: OAuthSession = {}
  const redirect = vi.fn<(url: string, status?: number) => void>()
  strategy.redirect = redirect

  strategy.authenticate(createRequest(session))

  expect(redirect).toHaveBeenCalledTimes(1)
  const target = new URL(String(redirect.mock.calls[0]?.[0]))
  const state = target.searchParams.get('state')
  if (!state) throw new Error('Dropbox authorization redirect did not contain state.')
  expect(state).toMatch(/^[A-Za-z0-9]{24}$/)
  expect(getStoredState(session)).toBe(state)
  return { session, state, target }
}
const createCallbackHarness = () => {
  const user = { id: 1 }
  const verify = vi.fn<DropboxVerify>((_request, _accessToken, _refreshToken, _profile, done) => {
    done(null, user)
  })
  const strategy = new DropboxStrategy(options, verify)
  const getOAuthAccessToken = vi.fn<OAuth2AccessTokenMethod>((_code, _params, done) => {
    done(null, 'access-token', 'refresh-token', {})
  })
  const userProfile = vi.fn<DropboxStrategy['userProfile']>((_accessToken, done) => {
    done(null, callbackProfile)
  })
  const success = vi.fn<DropboxStrategy['success']>()
  const fail = vi.fn<DropboxStrategy['fail']>()
  const error = vi.fn<DropboxStrategy['error']>()
  strategy._oauth2.getOAuthAccessToken = getOAuthAccessToken
  strategy.userProfile = userProfile
  strategy.success = success
  strategy.fail = fail
  strategy.error = error
  return { strategy, user, verify, getOAuthAccessToken, userProfile, success, fail, error }
}
const getProfile = (strategy: DropboxStrategy): Promise<DropboxProfile> => {
  const { promise, resolve, reject } = Promise.withResolvers<DropboxProfile>()
  strategy.userProfile('access-token', (error, profile) => {
    if (error) {
      reject(error)
    } else if (profile) {
      resolve(profile)
    } else {
      reject(new Error('Dropbox strategy returned no profile.'))
    }
  })
  return promise
}

const getProfileError = (strategy: DropboxStrategy): Promise<Error> => {
  const { promise, resolve } = Promise.withResolvers<Error>()
  strategy.userProfile('access-token', error => resolve(error ?? new Error('Dropbox strategy returned no error.')))
  return promise
}

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, 'WIKI')
})

describe('Dropbox strategy', () => {
  it('uses current OAuth endpoints and the legacy runtime strategy name with unpredictable session-bound state, without PKCE or scopes', () => {
    const strategy = createStrategy()
    expect(strategy._oauth2._accessTokenUrl).toBe('https://api.dropboxapi.com/oauth2/token')

    const first = startAuthorization(strategy)
    const second = startAuthorization(strategy)

    expect(`${first.target.origin}${first.target.pathname}`).toBe('https://www.dropbox.com/oauth2/authorize')
    expect(first.target.searchParams.get('client_id')).toBe('app-key')
    expect(first.target.searchParams.get('redirect_uri')).toBe(options.callbackURL)
    expect(first.target.searchParams.get('response_type')).toBe('code')
    expect(first.target.searchParams.has('scope')).toBe(false)
    expect(first.target.searchParams.has('code_challenge')).toBe(false)
    expect(first.target.searchParams.has('code_challenge_method')).toBe(false)
    expect(second.state).not.toBe(first.state)
    expect(strategy.name).toBe('dropbox-oauth2')
  })

  it('rejects a callback with missing state before token or profile work', () => {
    const harness = createCallbackHarness()
    const { session } = startAuthorization(harness.strategy)

    harness.strategy.authenticate(createRequest(session, { code: 'authorization-code' }))

    expect(harness.fail).toHaveBeenCalledTimes(1)
    expect(harness.fail).toHaveBeenCalledWith({ message: 'Invalid authorization request state.' }, 403)
    expect(harness.getOAuthAccessToken).not.toHaveBeenCalled()
    expect(harness.userProfile).not.toHaveBeenCalled()
    expect(harness.verify).not.toHaveBeenCalled()
    expect(harness.success).not.toHaveBeenCalled()
    expect(harness.error).not.toHaveBeenCalled()
    expect(session).toEqual({})
  })

  it('rejects a callback with mismatched state before token or profile work', () => {
    const harness = createCallbackHarness()
    const { session } = startAuthorization(harness.strategy)

    harness.strategy.authenticate(createRequest(session, { code: 'authorization-code', state: 'mismatched-state' }))

    expect(harness.fail).toHaveBeenCalledTimes(1)
    expect(harness.fail).toHaveBeenCalledWith({ message: 'Invalid authorization request state.' }, 403)
    expect(harness.getOAuthAccessToken).not.toHaveBeenCalled()
    expect(harness.userProfile).not.toHaveBeenCalled()
    expect(harness.verify).not.toHaveBeenCalled()
    expect(harness.success).not.toHaveBeenCalled()
    expect(harness.error).not.toHaveBeenCalled()
    expect(session).toEqual({})
  })

  it('allows a callback with matching state to proceed exactly once', () => {
    const harness = createCallbackHarness()
    const { session, state } = startAuthorization(harness.strategy)
    const callbackRequest = createRequest(session, { code: 'authorization-code', state })

    harness.strategy.authenticate(callbackRequest)

    expect(harness.getOAuthAccessToken).toHaveBeenCalledTimes(1)
    expect(harness.getOAuthAccessToken).toHaveBeenCalledWith(
      'authorization-code',
      { grant_type: 'authorization_code', redirect_uri: options.callbackURL },
      expect.any(Function)
    )
    expect(harness.userProfile).toHaveBeenCalledTimes(1)
    expect(harness.userProfile).toHaveBeenCalledWith('access-token', expect.any(Function))
    expect(harness.verify).toHaveBeenCalledTimes(1)
    expect(harness.verify).toHaveBeenCalledWith(callbackRequest, 'access-token', 'refresh-token', callbackProfile, expect.any(Function))
    expect(harness.success).toHaveBeenCalledTimes(1)
    expect(harness.success).toHaveBeenCalledWith(harness.user, {})
    expect(harness.fail).not.toHaveBeenCalled()
    expect(harness.error).not.toHaveBeenCalled()
    expect(session).toEqual({})
  })

  it('rejects replayed callback state without repeating token, profile, or verification work', () => {
    const harness = createCallbackHarness()
    const { session, state } = startAuthorization(harness.strategy)

    harness.strategy.authenticate(createRequest(session, { code: 'authorization-code', state }))
    harness.strategy.authenticate(createRequest(session, { code: 'replayed-authorization-code', state }))

    expect(harness.fail).toHaveBeenCalledTimes(1)
    expect(harness.fail).toHaveBeenCalledWith({ message: 'Unable to verify authorization request state.' }, 403)
    expect(harness.getOAuthAccessToken).toHaveBeenCalledTimes(1)
    expect(harness.userProfile).toHaveBeenCalledTimes(1)
    expect(harness.verify).toHaveBeenCalledTimes(1)
    expect(harness.success).toHaveBeenCalledTimes(1)
    expect(harness.error).not.toHaveBeenCalled()
    expect(session).toEqual({})
  })

  it('registers under the configured transport-specific provider key', async () => {
    Reflect.set(globalThis, 'WIKI', {})
    // Load the plugin after WIKI is initialized because its runtime singleton is captured at module evaluation.
    const { default: dropboxAuthentication } = await import('./authentication.ts')
    const passport = { use: vi.fn() }

    dropboxAuthentication.init(
      passport as never,
      {
        key: 'agents:dropbox',
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
      return new Response(body, { status: 200 })
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 }))
    )

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
    [
      'email_verified is missing',
      {
        account_id: profileResponse.account_id,
        name: profileResponse.name,
        email: profileResponse.email,
        profile_photo_url: profileResponse.profile_photo_url
      },
      'email_verified'
    ],
    ['email is invalid', { ...profileResponse, email: 'not-an-email' }, 'email']
  ] as const)('rejects an account when %s before the Passport verifier can receive a profile', async (_case, account, invalidField) => {
    const verify = vi.fn<DropboxVerify>()
    const strategy = new DropboxStrategy(options, verify)
    const getOAuthAccessToken = vi.fn<OAuth2AccessTokenMethod>((_code, _params, done) => {
      done(null, 'access-token', 'refresh-token', {})
    })
    const success = vi.fn<DropboxStrategy['success']>()
    const error = new Promise<Error>(resolve => {
      strategy.error = resolve
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(account), { status: 200 }))
    strategy._oauth2.getOAuthAccessToken = getOAuthAccessToken
    strategy.success = success
    vi.stubGlobal('fetch', fetchMock)
    const { session, state } = startAuthorization(strategy)

    strategy.authenticate(createRequest(session, { code: 'authorization-code', state }))

    expect(await error).toMatchObject({ message: expect.stringContaining(invalidField) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(verify).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
  })

  it('rejects non-2xx, malformed, oversized, and incomplete account responses', async () => {
    const cases: Array<{ response: Response; message: string }> = [
      { response: new Response('not authorized', { status: 401 }), message: 'HTTP 401' },
      { response: new Response('{not-json', { status: 200 }), message: 'not valid JSON' },
      { response: new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }), message: 'too large' },
      {
        response: new Response(JSON.stringify({ name: profileResponse.name, email: profileResponse.email, email_verified: true }), { status: 200 }),
        message: 'account_id'
      },
      {
        response: new Response(JSON.stringify({ account_id: 'dbid:123', name: profileResponse.name, email_verified: true }), { status: 200 }),
        message: 'email'
      },
      {
        response: new Response(
          JSON.stringify({ account_id: 'dbid:123', name: { given_name: 'Alice', surname: 'Example' }, email: profileResponse.email, email_verified: true }),
          {
            status: 200
          }
        ),
        message: 'display_name'
      }
    ]

    for (const { response, message } of cases) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response)
      )
      await expect(getProfileError(createStrategy())).resolves.toMatchObject({ message: expect.stringContaining(message) })
      vi.unstubAllGlobals()
    }
  })
})
