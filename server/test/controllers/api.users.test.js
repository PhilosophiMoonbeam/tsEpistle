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

describe('controllers/api users endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__router.get.mockClear()
  })

  const loadHandler = () => {
    const express = require('express')
    require('../../controllers/api/users')
    return express.__router.get.mock.calls.find(([path]) => path === '/whoami')[1]
  }

  it('registers the whoami route', () => {
    const handler = loadHandler()

    expect(typeof handler).toBe('function')
  })

  it('returns anonymous state when no authenticated user is present', async () => {
    const handler = loadHandler()
    const req = {}
    const res = { json: jest.fn() }

    await handler(req, res)

    expect(res.json).toHaveBeenCalledWith({ authenticated: false, user: null })
  })

  it('returns a safe authenticated user summary', async () => {
    const handler = loadHandler()
    const req = {
      user: {
        id: 42,
        name: 'Alice',
        email: 'alice@example.com',
        providerKey: 'local',
        permissions: ['manage:system'],
        password: 'secret',
        tfaSecret: 'hidden',
        providerId: 'provider-42'
      }
    }
    const res = { json: jest.fn() }

    await handler(req, res)

    expect(res.json).toHaveBeenCalledWith({
      authenticated: true,
      user: {
        id: 42,
        name: 'Alice',
        email: 'alice@example.com',
        providerKey: 'local',
        permissions: ['manage:system']
      }
    })
  })

  it('does not leak sensitive user fields', async () => {
    const handler = loadHandler()
    const req = {
      user: {
        id: 42,
        name: 'Alice',
        email: 'alice@example.com',
        providerKey: 'local',
        permissions: ['manage:system'],
        password: 'secret',
        tfaSecret: 'hidden',
        providerId: 'provider-42',
        continuationToken: 'token-123'
      }
    }
    const res = { json: jest.fn() }

    await handler(req, res)

    const payload = res.json.mock.calls[0][0]
    expect(payload.user.password).toBeUndefined()
    expect(payload.user.tfaSecret).toBeUndefined()
    expect(payload.user.providerId).toBeUndefined()
    expect(payload.user.continuationToken).toBeUndefined()
  })
})
