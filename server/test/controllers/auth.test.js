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
    express.__router.post.mockClear()
    rateLimiter.create.mockClear()

    global.WIKI = {
      models: {
        authentication: {
          getStrategy: vi.fn().mockResolvedValue({ selfRegistration: true })
        },
        users: {
          login: vi.fn().mockResolvedValue({ jwt: 'login-jwt' })
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
