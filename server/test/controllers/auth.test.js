const limiter = vi.hoisted(() => ({
  middleware: vi.fn((req, res, next) => next()),
  options: [],
  reset: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../../helpers/auth-rate-limiter.ts', () => ({
  createAuthRateLimiter: vi.fn(options => {
    limiter.options.push(options)
    return limiter
  })
}))

vi.mock('../../helpers/common.ts', () => ({
  default: { getCookieOpts: vi.fn(() => ({ httpOnly: true })) }
}))

vi.mock('express', () => {
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

import express from 'express'

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

  const loadLegacyLogin = async () => {
    await import('../../controllers/auth.ts')
    const route = express.__router.post.mock.calls.find(([path]) => path === '/login')
    return route[route.length - 1]
  }

  it('configures the HTML limiter with the preserved 401 text response', async () => {
    await loadLegacyLogin()
    const res = { send: vi.fn(), status: vi.fn().mockReturnThis() }

    limiter.options[0].onLimit({}, res, 5 * 60 * 1000)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.send).toHaveBeenCalledWith('Too many failed attempts. Try again later.')
  })

  it('deletes limiter state after a successful legacy login', async () => {
    const login = await loadLegacyLogin()
    const req = {
      body: { strategy: 'local', user: 'alice@example.com', pass: 'secret' },
      get: vi.fn(),
      query: { legacy: '1' }
    }
    const res = {
      cookie: vi.fn(),
      locals: {},
      redirect: vi.fn(),
      render: vi.fn()
    }

    await login(req, res)

    expect(global.WIKI.models.users.login).toHaveBeenCalledWith({
      strategy: 'local',
      username: 'alice@example.com',
      password: 'secret'
    }, { req, res })
    expect(limiter.reset).toHaveBeenCalledWith(req)
    expect(res.cookie).toHaveBeenCalledWith('jwt', 'login-jwt', { httpOnly: true })
    expect(res.redirect).toHaveBeenCalledWith('/')
  })
})
