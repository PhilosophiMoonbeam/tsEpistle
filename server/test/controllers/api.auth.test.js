jest.mock('express-brute', () => {
  return jest.fn().mockImplementation(() => ({
    prevent: jest.fn((req, res, next) => next())
  }))
})

jest.mock('../../helpers/brute-knex', () => {
  return jest.fn().mockImplementation(() => ({}))
})

jest.mock('express', () => {
  const router = {
    get: jest.fn(),
    post: jest.fn(),
    use: jest.fn()
  }

  return {
    Router: () => router,
    __router: router
  }
})

describe('controllers/api auth endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__router.get.mockClear()
    express.__router.post.mockClear()

    global.WIKI = {
      data: {
        authentication: [
          {
            key: 'local',
            title: 'Local',
            useForm: true,
            props: {
              usernameFormat: { type: 'string', default: 'email' }
            }
          },
          {
            key: 'github',
            title: 'GitHub',
            useForm: false,
            props: {
              clientId: { type: 'string', default: '' }
            }
          }
        ]
      },
      auth: {
        strategies: {
          local: {
            key: 'local',
            isEnabled: true,
            strategyKey: 'local'
          },
          github: {
            key: 'github',
            isEnabled: true,
            strategyKey: 'github'
          },
          disabledlocal: {
            key: 'disabledlocal',
            isEnabled: false,
            strategyKey: 'local'
          }
        }
      },
      models: {
        authentication: {
          getStrategies: jest.fn().mockResolvedValue([
            {
              key: 'local',
              strategyKey: 'local',
              displayName: 'Local Login',
              order: 1,
              isEnabled: true,
              config: {
                usernameFormat: 'email'
              }
            },
            {
              key: 'github',
              strategyKey: 'github',
              displayName: 'GitHub Login',
              order: 2,
              isEnabled: false,
              config: {
                clientId: 'abc123'
              }
            }
          ])
        },
        users: {
          login: jest.fn(),
          loginTFA: jest.fn(),
          loginChangePassword: jest.fn(),
          loginForgotPassword: jest.fn()
        }
      }
    }
  })

  const loadHandlers = () => {
    const express = require('express')
    require('../../controllers/api/auth')
    const getRouteHandler = (path) => express.__router.get.mock.calls.find(([routePath]) => routePath === path)[1]
    const postRouteHandler = (path) => {
      const call = express.__router.post.mock.calls.find(([routePath]) => routePath === path)
      return call[call.length - 1]
    }
    return {
      strategies: getRouteHandler('/strategies'),
      forgotPassword: postRouteHandler('/forgot-password'),
      login: postRouteHandler('/login'),
      loginTFA: postRouteHandler('/login/tfa'),
      loginChangePassword: postRouteHandler('/login/change-password')
    }
  }

  it('registers the auth routes', () => {
    const handlers = loadHandlers()

    expect(typeof handlers.strategies).toBe('function')
    expect(typeof handlers.forgotPassword).toBe('function')
    expect(typeof handlers.login).toBe('function')
    expect(typeof handlers.loginTFA).toBe('function')
    expect(typeof handlers.loginChangePassword).toBe('function')
  })

  it('returns only enabled authentication strategies with the public login-safe payload', async () => {
    const { strategies } = loadHandlers()
    const res = { json: jest.fn() }

    await strategies({}, res, jest.fn())

    expect(global.WIKI.models.authentication.getStrategies).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith([
      {
        key: 'local',
        displayName: 'Local Login',
        order: 1,
        selfRegistration: undefined,
        strategy: {
          key: 'local',
          title: 'Local',
          logo: undefined,
          color: undefined,
          icon: undefined,
          useForm: true,
          usernameType: undefined
        }
      }
    ])
  })

  it('does not expose internal configuration or admin-only auth metadata', async () => {
    const { strategies } = loadHandlers()
    const res = { json: jest.fn() }

    await strategies({}, res, jest.fn())

    const payload = res.json.mock.calls[0][0][0]
    expect(payload.strategyKey).toBeUndefined()
    expect(payload.isEnabled).toBeUndefined()
    expect(payload.config).toBeUndefined()
    expect(payload.domainWhitelist).toBeUndefined()
    expect(payload.autoEnrollGroups).toBeUndefined()
    expect(payload.strategy.props).toBeUndefined()
  })

  it('forwards unexpected failures from strategy loading to next', async () => {
    global.WIKI.models.authentication.getStrategies.mockRejectedValueOnce(new Error('db failed'))
    const { strategies } = loadHandlers()
    const next = jest.fn()
    const res = { json: jest.fn() }

    await strategies({}, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('db failed')
  })

  it('returns a generic success payload for forgot-password requests', async () => {
    const { forgotPassword } = loadHandlers()
    const req = {
      body: { email: 'alice@example.com' },
      brute: { reset: jest.fn() }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await forgotPassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginForgotPassword).toHaveBeenCalledWith({
      email: 'alice@example.com'
    }, { req, res })
    expect(req.brute.reset).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Password reset request processed.' })
  })

  it('rejects missing forgot-password input with 400', async () => {
    const { forgotPassword } = loadHandlers()
    const req = {
      body: { email: '' },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await forgotPassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginForgotPassword).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'email is required' })
  })

  it('rejects malformed forgot-password input with 400', async () => {
    const { forgotPassword } = loadHandlers()
    const req = {
      body: { email: { nested: true } },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await forgotPassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginForgotPassword).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'email must be a string' })
  })

  it('forwards unexpected forgot-password failures to next', async () => {
    global.WIKI.models.users.loginForgotPassword.mockRejectedValueOnce(new Error('mail failed'))
    const { forgotPassword } = loadHandlers()
    const req = {
      body: { email: 'alice@example.com' },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()

    await forgotPassword(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('mail failed')
  })

  it('rejects non-form auth strategies for REST login', async () => {
    const { login } = loadHandlers()
    const req = { body: { strategy: 'github', username: 'octo', password: 'secret' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await login(req, res, jest.fn())

    expect(global.WIKI.models.users.login).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'REST login only supports form-based strategies' })
  })

  it('rejects disabled form strategies for REST login', async () => {
    const { login } = loadHandlers()
    const req = { body: { strategy: 'disabledlocal', username: 'alice@example.com', password: 'secret' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await login(req, res, jest.fn())

    expect(global.WIKI.models.users.login).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication strategy is disabled' })
  })

  it('returns the login continuation payload for successful REST login and resets brute-force state', async () => {
    global.WIKI.models.users.login.mockResolvedValueOnce({
      mustProvideTFA: true,
      continuationToken: 'tfa-token',
      redirect: '/admin'
    })
    const { login } = loadHandlers()
    const req = {
      body: { strategy: 'local', username: 'alice@example.com', password: 'secret' },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await login(req, res, jest.fn())

    expect(global.WIKI.models.users.login).toHaveBeenCalledWith({
      strategy: 'local',
      username: 'alice@example.com',
      password: 'secret'
    }, { req, res })
    expect(req.brute.reset).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({
      jwt: null,
      mustChangePwd: false,
      mustProvideTFA: true,
      mustSetupTFA: false,
      continuationToken: 'tfa-token',
      redirect: '/admin',
      tfaQRImage: null
    })
  })

  it('rejects malformed form-auth input with 400', async () => {
    const { login } = loadHandlers()
    const req = {
      body: { strategy: 'local', username: { nested: true }, password: ['bad'] },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await login(req, res, jest.fn())

    expect(global.WIKI.models.users.login).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'username and password must be strings' })
  })

  it('forwards login failures to next', async () => {
    global.WIKI.models.users.login.mockRejectedValueOnce(new Error('login failed'))
    const { login } = loadHandlers()
    const req = {
      body: { strategy: 'local', username: 'alice@example.com', password: 'secret' },
      login: jest.fn(),
      logIn: jest.fn()
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const next = jest.fn()

    await login(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('login failed')
  })

  it('rejects missing TFA continuation fields with 400', async () => {
    const { loginTFA } = loadHandlers()
    const req = { body: { securityCode: '', continuationToken: '' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await loginTFA(req, res, jest.fn())

    expect(global.WIKI.models.users.loginTFA).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'securityCode and continuationToken are required' })
  })

  it('returns the login TFA continuation payload and resets brute-force state', async () => {
    global.WIKI.models.users.loginTFA.mockResolvedValueOnce({
      jwt: 'jwt-token',
      redirect: '/'
    })
    const { loginTFA } = loadHandlers()
    const req = {
      body: { securityCode: '123456', continuationToken: 'tfa-token', setup: false },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const res = { json: jest.fn() }

    await loginTFA(req, res, jest.fn())

    expect(global.WIKI.models.users.loginTFA).toHaveBeenCalledWith({
      securityCode: '123456',
      continuationToken: 'tfa-token',
      setup: false
    }, { req, res })
    expect(req.brute.reset).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({
      jwt: 'jwt-token',
      mustChangePwd: false,
      mustProvideTFA: false,
      mustSetupTFA: false,
      continuationToken: null,
      redirect: '/',
      tfaQRImage: null
    })
  })

  it('rejects malformed TFA input with 400', async () => {
    const { loginTFA } = loadHandlers()
    const req = {
      body: { securityCode: 123456, continuationToken: { bad: true }, setup: 'false' },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await loginTFA(req, res, jest.fn())

    expect(global.WIKI.models.users.loginTFA).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'securityCode and continuationToken must be strings' })
  })

  it('rejects missing change-password fields with 400', async () => {
    const { loginChangePassword } = loadHandlers()
    const req = { body: { continuationToken: '', newPassword: '' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await loginChangePassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginChangePassword).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'continuationToken and newPassword are required' })
  })

  it('returns the change-password continuation payload and resets brute-force state', async () => {
    global.WIKI.models.users.loginChangePassword.mockResolvedValueOnce({
      jwt: 'jwt-token'
    })
    const { loginChangePassword } = loadHandlers()
    const req = {
      body: { continuationToken: 'pwd-token', newPassword: 'new-secret' },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const res = { json: jest.fn() }

    await loginChangePassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginChangePassword).toHaveBeenCalledWith({
      continuationToken: 'pwd-token',
      newPassword: 'new-secret'
    }, { req, res })
    expect(req.brute.reset).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({
      jwt: 'jwt-token',
      mustChangePwd: false,
      mustProvideTFA: false,
      mustSetupTFA: false,
      continuationToken: null,
      redirect: null,
      tfaQRImage: null
    })
  })

  it('rejects malformed change-password input with 400', async () => {
    const { loginChangePassword } = loadHandlers()
    const req = {
      body: { continuationToken: { bad: true }, newPassword: ['short'] },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await loginChangePassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginChangePassword).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'continuationToken and newPassword must be strings' })
  })

  it('maps expected auth errors to client-safe status codes', async () => {
    global.WIKI.models.users.login.mockRejectedValueOnce({ message: 'Invalid email / username or password.', code: 1002 })
    global.WIKI.models.users.loginTFA.mockRejectedValueOnce({ message: 'Invalid TFA Security Code or Login Token.', code: 1006 })
    global.WIKI.models.users.loginChangePassword.mockRejectedValueOnce({ message: 'Password must be at least 6 characters!', code: 1012 })
    global.WIKI.models.users.loginTFA.mockRejectedValueOnce({ message: 'Invalid validation token.', code: 1015 })
    global.WIKI.models.users.loginChangePassword.mockRejectedValueOnce({ message: 'This user does not exist.', code: 1016 })
    const { login, loginTFA, loginChangePassword } = loadHandlers()

    const loginReq = {
      body: { strategy: 'local', username: 'alice@example.com', password: 'bad' },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const tfaReq = {
      body: { securityCode: '123456', continuationToken: 'bad-token', setup: false },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const changeReq = {
      body: { continuationToken: 'pwd-token', newPassword: 'short' },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const loginRes = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const tfaRes = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const changeRes = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await login(loginReq, loginRes, jest.fn())
    await loginTFA(tfaReq, tfaRes, jest.fn())
    await loginChangePassword(changeReq, changeRes, jest.fn())

    expect(loginRes.status).toHaveBeenCalledWith(401)
    expect(loginRes.json).toHaveBeenCalledWith({ error: 'Invalid email / username or password.' })
    expect(tfaRes.status).toHaveBeenCalledWith(401)
    expect(tfaRes.json).toHaveBeenCalledWith({ error: 'Invalid TFA Security Code or Login Token.' })
    expect(changeRes.status).toHaveBeenCalledWith(400)
    expect(changeRes.json).toHaveBeenCalledWith({ error: 'Password must be at least 6 characters!' })

    const invalidTokenRes = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const missingUserRes = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await loginTFA(tfaReq, invalidTokenRes, jest.fn())
    await loginChangePassword(changeReq, missingUserRes, jest.fn())

    expect(invalidTokenRes.status).toHaveBeenCalledWith(401)
    expect(invalidTokenRes.json).toHaveBeenCalledWith({ error: 'Invalid validation token.' })
    expect(missingUserRes.status).toHaveBeenCalledWith(401)
    expect(missingUserRes.json).toHaveBeenCalledWith({ error: 'This user does not exist.' })
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.models.users.login.mockRejectedValueOnce(new Error('unexpected login failure'))
    const { login } = loadHandlers()
    const req = {
      body: { strategy: 'local', username: 'alice@example.com', password: 'secret' },
      login: jest.fn(),
      logIn: jest.fn()
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()

    await login(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('unexpected login failure')
  })
})
