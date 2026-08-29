const limiter = vi.hoisted(() => ({
  middleware: vi.fn((req, res, next) => next()),
  options: [],
  reset: vi.fn().mockResolvedValue(undefined)
}))

vi.mockModule('../../helpers/auth-rate-limiter.ts', import.meta.url, () => ({
  createAuthRateLimiter: vi.fn(options => {
    limiter.options.push(options)
    return limiter
  }),
  setAuthRateLimitHeaders: vi.fn((res, retryAfterMs) => {
    res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
  })
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

describe('HTML auth controller rate limiting', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__router.all.mockClear()
    express.__router.get.mockClear()
    express.__router.post.mockClear()
    limiter.options.length = 0
    limiter.reset.mockClear()

    global.WIKI = {
      models: {
        knex: {},
        authentication: {},
        users: {
          login: vi.fn().mockResolvedValue({ jwt: 'login-jwt' })
        },
        userKeys: {}
      },
      config: {
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

  it('configures the HTML limiter with a 429 response and Retry-After', async () => {
    await loadController()
    const res = { send: vi.fn(), set: vi.fn(), status: vi.fn().mockReturnThis() }

    limiter.options[0].onLimit({}, res, 5 * 60 * 1000)

    expect(res.set).toHaveBeenCalledWith('Retry-After', '300')
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.send).toHaveBeenCalledWith('Too many failed attempts. Try again later.')
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
      bgUrl: '/_assets/img/splash/1.jpg',
      hideLocal: false
    })
    expect(res.render).not.toHaveBeenCalledWith('legacy/login', expect.anything())
  })
})
