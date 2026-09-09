const rateLimiter = vi.hoisted(() => ({
  create: vi.fn(() => ({
    middleware: vi.fn((req, res, next) => next()),
    reset: vi.fn().mockResolvedValue(undefined)
  }))
}))

vi.mockModule('../../helpers/auth-rate-limiter.ts', import.meta.url, () => ({
  createAuthRateLimiter: rateLimiter.create,
  setAuthRateLimitHeaders: vi.fn()
}))

vi.mockModule('../../helpers/common.ts', import.meta.url, () => ({
  default: { getCookieOpts: vi.fn(() => ({ httpOnly: true })) }
}))

vi.mockModule('express', import.meta.url, () => {
  const router = {
    all: vi.fn(),
    get: vi.fn(),
    head: vi.fn(),
    post: vi.fn()
  }
  const express = {
    Router: () => router,
    __router: router
  }
  return { default: express, ...express }
})

const { default: express } = await import('express')

describe('HTML auth controller', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__router.all.mockClear()
    express.__router.get.mockClear()
    express.__router.head.mockClear()
    express.__router.post.mockClear()
    rateLimiter.create.mockClear()

    global.WIKI = {
      models: {
        authentication: {
          getStrategy: vi.fn().mockResolvedValue({ selfRegistration: true })
        },
        users: {
          login: vi.fn().mockResolvedValue({ jwt: 'login-jwt' }),
          logout: vi.fn().mockResolvedValue('/')
        },
        userKeys: {
          validateToken: vi.fn().mockResolvedValue({ id: 7 })
        }
      },
      config: {
        logoUrl: '',
        auth: {
          autoLogin: false,
          enforce2FA: false,
          hideLocal: false,
          loginBgUrl: ''
        },
        certs: {}
      },
      data: { authentication: [] },
      Error: {}
    }
  })

  const loadController = async () => {
    const { default: createAuthController } = await vi.importFresh('../../controllers/auth.ts', import.meta.url)
    createAuthController(global.WIKI)
  }
  it('only permits logout through POST and keeps GET and HEAD inert', async () => {
    await loadController()

    const getRoute = express.__router.get.mock.calls.find(([path]) => path === '/logout')
    const headRoute = express.__router.head.mock.calls.find(([path]) => path === '/logout')
    expect(getRoute).toHaveLength(2)
    expect(headRoute).toHaveLength(2)

    for (const route of [getRoute, headRoute]) {
      const response = {
        set: vi.fn(),
        status: vi.fn().mockReturnThis(),
        end: vi.fn()
      }
      await route[1]({}, response, vi.fn())
      expect(response.set).toHaveBeenCalledWith('Allow', 'POST')
      expect(response.status).toHaveBeenCalledWith(405)
      expect(response.end).toHaveBeenCalledTimes(1)
    }

    expect(global.WIKI.models.users.logout).not.toHaveBeenCalled()
  })

  it('clears the JWT and redirects after a successful POST logout', async () => {
    const redirect = 'https://provider.example.test/logout'
    global.WIKI.models.users.logout.mockResolvedValueOnce(redirect)
    await loadController()

    const postRoute = express.__router.post.mock.calls.find(([path]) => path === '/logout')
    const req = { logout: vi.fn(callback => callback()) }
    const response = {
      set: vi.fn(),
      clearCookie: vi.fn(),
      redirect: vi.fn()
    }
    const next = vi.fn()

    await postRoute[1](req, response, next)

    expect(global.WIKI.models.users.logout).toHaveBeenCalledWith({ req, res: response })
    expect(req.logout).toHaveBeenCalledTimes(1)
    expect(response.clearCookie).toHaveBeenCalledWith('jwt', { httpOnly: true })
    expect(response.redirect).toHaveBeenCalledWith(303, redirect)
    expect(next).not.toHaveBeenCalled()
  })

  it('forwards provider and session logout errors without clearing the JWT', async () => {
    const providerError = new Error('provider logout failed')
    global.WIKI.models.users.logout.mockRejectedValueOnce(providerError)
    await loadController()
    const postRoute = express.__router.post.mock.calls.find(([path]) => path === '/logout')
    const providerRequest = { logout: vi.fn() }
    const providerResponse = { set: vi.fn(), clearCookie: vi.fn(), redirect: vi.fn() }
    const providerNext = vi.fn()

    await postRoute[1](providerRequest, providerResponse, providerNext)

    expect(providerNext).toHaveBeenCalledWith(providerError)
    expect(providerRequest.logout).not.toHaveBeenCalled()
    expect(providerResponse.clearCookie).not.toHaveBeenCalled()
    expect(providerResponse.redirect).not.toHaveBeenCalled()

    const sessionError = new Error('session logout failed')
    global.WIKI.models.users.logout.mockResolvedValueOnce('/')
    const sessionRequest = { logout: vi.fn(callback => callback(sessionError)) }
    const sessionResponse = { set: vi.fn(), clearCookie: vi.fn(), redirect: vi.fn() }
    const sessionNext = vi.fn()

    await postRoute[1](sessionRequest, sessionResponse, sessionNext)

    expect(sessionNext).toHaveBeenCalledWith(sessionError)
    expect(sessionResponse.clearCookie).not.toHaveBeenCalled()
    expect(sessionResponse.redirect).not.toHaveBeenCalled()
  })
  it('does not invoke a provider login for an unsolicited callback and clears its federation cookie', async () => {
    await loadController()
    const callbackRoute = express.__router.all.mock.calls.find(([path]) => path === '/login/:strategy/callback')
    const request = { method: 'GET', params: { strategy: 'google' }, query: {}, cookies: {} }
    const response = { clearCookie: vi.fn() }
    const next = vi.fn()

    await callbackRoute[1](request, response, next)

    expect(global.WIKI.models.users.login).not.toHaveBeenCalled()
    expect(response.clearCookie).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
  })

  it('does not invoke a provider login for a state-only callback', async () => {
    await loadController()
    const callbackRoute = express.__router.all.mock.calls.find(([path]) => path === '/login/:strategy/callback')
    const request = { method: 'GET', params: { strategy: 'google' }, query: { state: 'state-only' }, cookies: {} }
    const response = { clearCookie: vi.fn() }
    const next = vi.fn()

    await callbackRoute[1](request, response, next)

    expect(global.WIKI.models.users.login).not.toHaveBeenCalled()
    expect(response.clearCookie).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
  })

  it('clears the federation cookie after a correlated callback terminal outcome', async () => {
    await loadController()
    const callbackRoute = express.__router.all.mock.calls.find(([path]) => path === '/login/:strategy/callback')
    const request = { method: 'GET', params: { strategy: 'google' }, query: { state: 'state-a', code: 'code-a' }, cookies: {} }
    const response = { set: vi.fn(), cookie: vi.fn(), clearCookie: vi.fn(), redirect: vi.fn() }
    const next = vi.fn()

    await callbackRoute[1](request, response, next)

    expect(global.WIKI.models.users.login).toHaveBeenCalledWith({ strategy: 'google' }, { req: request, res: response })
    expect(response.clearCookie).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()
  })


  it('does not spend rate-limit attempts on invalid token landing GETs', async () => {
    await loadController()

    for (const [path, kind, templateKey] of [
      ['/verify/:token', 'verify', 'verificationToken'],
      ['/login-reset/:token', 'resetPwd', 'resetPasswordToken']
    ]) {
      const route = express.__router.get.mock.calls.find(([registeredPath]) => registeredPath === path)
      expect(route).toHaveLength(2)
      const landing = route[1]
      const invalidToken = new Error('invalid token')
      const invalidNext = vi.fn()
      global.WIKI.models.userKeys.validateToken.mockRejectedValueOnce(invalidToken)

      await landing({ params: { token: 'invalid-token' } }, { locals: {}, render: vi.fn() }, invalidNext)
      expect(global.WIKI.models.userKeys.validateToken).toHaveBeenLastCalledWith({
        kind,
        token: 'invalid-token',
        skipDelete: true
      })

      expect(invalidNext).toHaveBeenCalledWith(invalidToken)

      const validResponse = { locals: {}, render: vi.fn() }
      global.WIKI.models.userKeys.validateToken.mockResolvedValueOnce({ id: 7 })
      await landing({ params: { token: 'valid-token' } }, validResponse, vi.fn())
      expect(global.WIKI.models.userKeys.validateToken).toHaveBeenLastCalledWith({
        kind,
        token: 'valid-token',
        skipDelete: true
      })

      expect(validResponse.render).toHaveBeenCalledWith('login', expect.objectContaining({
        [templateKey]: 'valid-token'
      }))
    }

    expect(rateLimiter.create).not.toHaveBeenCalled()
  })

  it('uses the modern login shell for legacy query strings and user agents', async () => {
    await loadController()
    const route = express.__router.get.mock.calls.find(([path]) => path === '/login')
    const login = route[route.length - 1]
    const req = {
      get: vi.fn().mockReturnValue('Trident'),
      query: { legacy: '1' }
    }
    const res = {
      locals: {},
      redirect: vi.fn(),
      render: vi.fn()
    }

    await login(req, res)

    expect(res.render).toHaveBeenCalledWith('login', {
      bgUrl: '/_assets/img/splash/tsepistle-orbit.svg',
      hideLocal: false,
      faviconUrl: '/_assets/favicon.ico'
    })
    expect(res.render).not.toHaveBeenCalledWith('legacy/login', expect.anything())
  })

  it('chooses the first enabled provider for automatic login and safely handles an empty or form-first policy', async () => {
    global.WIKI.config.auth.autoLogin = true
    global.WIKI.data.authentication = [{ key: 'oidc', useForm: false }, { key: 'local', useForm: true }]
    let providers = [{ key: 'disabled', strategyKey: 'oidc', isEnabled: false }, { key: 'organization', strategyKey: 'oidc', isEnabled: true }]
    const where = vi.fn((column, value) => ({ orderBy: () => ({ first: async () => providers.find(provider => provider[column] === value) }) }))
    global.WIKI.models.authentication.query = () => ({ where })
    await loadController()
    const login = express.__router.get.mock.calls.find(([path]) => path === '/login')[1]
    const res = { locals: {}, redirect: vi.fn(), render: vi.fn() }
    await login({ query: {} }, res)
    expect(where).toHaveBeenCalledWith('isEnabled', true)
    expect(res.redirect).toHaveBeenCalledWith('/login/organization')
    res.redirect.mockClear()
    for (const policy of [[], [{ key: 'local', strategyKey: 'local', isEnabled: true }]]) {
      providers = policy
      await login({ query: {} }, res)
      expect(res.render).toHaveBeenCalled()
    }
    expect(res.redirect).not.toHaveBeenCalled()
    providers = [{ key: 'organization', strategyKey: 'oidc', isEnabled: true }]
    await login({ query: { all: '1' } }, res)
    expect(res.redirect).not.toHaveBeenCalled()
  })

  it('uses the project splash when registration has no configured background', async () => {
    await loadController()
    const route = express.__router.get.mock.calls.find(([path]) => path === '/register')
    const register = route[route.length - 1]
    const res = { locals: {}, render: vi.fn() }

    await register({}, res, vi.fn())

    expect(global.WIKI.models.authentication.getStrategy).toHaveBeenCalledWith('local')
    expect(res.render).toHaveBeenCalledWith('register', {
      bgUrl: '/_assets/img/splash/tsepistle-orbit.svg',
      faviconUrl: '/_assets/favicon.ico'
    })
  })

  it('keeps a configured custom authentication background for login and registration', async () => {
    global.WIKI.config.auth.loginBgUrl = '/uploads/custom-login-background.jpg'
    await loadController()

    const loginRoute = express.__router.get.mock.calls.find(([path]) => path === '/login')
    const login = loginRoute[loginRoute.length - 1]
    const loginResponse = { locals: {}, redirect: vi.fn(), render: vi.fn() }
    await login({ query: {} }, loginResponse)
    expect(loginResponse.render).toHaveBeenCalledWith('login', {
      bgUrl: '/uploads/custom-login-background.jpg',
      hideLocal: false,
      faviconUrl: '/_assets/favicon.ico'
    })

    const registerRoute = express.__router.get.mock.calls.find(([path]) => path === '/register')
    const register = registerRoute[registerRoute.length - 1]
    const registerResponse = { locals: {}, render: vi.fn() }
    await register({}, registerResponse, vi.fn())
    expect(registerResponse.render).toHaveBeenCalledWith('register', {
      bgUrl: '/uploads/custom-login-background.jpg',
      faviconUrl: '/_assets/favicon.ico'
    })
  })

  it('trims a configured logo URL for the authentication favicon local', async () => {
    global.WIKI.config.logoUrl = '  /uploads/site-logo.svg  '
    await loadController()
    const route = express.__router.get.mock.calls.find(([path]) => path === '/login')
    const login = route[route.length - 1]
    const res = {
      locals: {},
      redirect: vi.fn(),
      render: vi.fn()
    }

    await login({ query: {} }, res)

    expect(res.render).toHaveBeenCalledWith('login', {
      bgUrl: '/_assets/img/splash/tsepistle-orbit.svg',
      hideLocal: false,
      faviconUrl: '/uploads/site-logo.svg'
    })
  })

  it('renders email confirmation without consuming or applying the token', async () => {
    await loadController()
    const route = express.__router.get.mock.calls.find(([path]) => path === '/verify/:token')
    expect(route).toHaveLength(2)
    const verify = route[route.length - 1]
    const req = { params: { token: 'verify-token' } }
    const res = { locals: {}, render: vi.fn() }

    await verify(req, res, vi.fn())

    expect(global.WIKI.models.userKeys.validateToken).toHaveBeenCalledWith({
      kind: 'verify',
      token: 'verify-token',
      skipDelete: true
    })
    expect(res.render).toHaveBeenCalledWith('login', {
      bgUrl: '/_assets/img/splash/tsepistle-orbit.svg',
      hideLocal: false,
      faviconUrl: '/_assets/favicon.ico',
      verificationToken: 'verify-token'
    })
    expect(res.locals.pageMeta.title).toBe('Confirm Email Address')
  })

  it('renders password reset without consuming the token', async () => {
    await loadController()
    const route = express.__router.get.mock.calls.find(([path]) => path === '/login-reset/:token')
    expect(route).toHaveLength(2)
    const reset = route[route.length - 1]
    const req = { params: { token: 'reset-token' } }
    const res = { locals: {}, render: vi.fn() }

    await reset(req, res, vi.fn())

    expect(global.WIKI.models.userKeys.validateToken).toHaveBeenCalledWith({
      kind: 'resetPwd',
      token: 'reset-token',
      skipDelete: true
    })
    expect(res.render).toHaveBeenCalledWith('login', {
      bgUrl: '/_assets/img/splash/tsepistle-orbit.svg',
      hideLocal: false,
      faviconUrl: '/_assets/favicon.ico',
      resetPasswordToken: 'reset-token'
    })
    expect(res.locals.pageMeta.title).toBe('Reset Password')
  })
})
