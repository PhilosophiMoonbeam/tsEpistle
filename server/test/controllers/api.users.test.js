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

    global.WIKI = {
      auth: {
        checkAccess: jest.fn().mockReturnValue(true)
      },
      models: {
        users: {
          query: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orWhere: jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue({
                  select: jest.fn().mockResolvedValue([
                    {
                      id: 42,
                      name: 'Alice',
                      email: 'alice@example.com',
                      providerKey: 'local'
                    },
                    {
                      id: 77,
                      name: 'Bob',
                      email: 'bob@example.com',
                      providerKey: 'ldap',
                      createdAt: '2026-01-01T00:00:00.000Z'
                    }
                  ])
                })
              })
            })
          })
        }
      }
    }
  })

  const loadHandler = () => {
    const express = require('express')
    require('../../controllers/api/users')
    return {
      search: express.__router.get.mock.calls.find(([path]) => path === '/search')[1],
      whoami: express.__router.get.mock.calls.find(([path]) => path === '/whoami')[1]
    }
  }

  it('registers the users routes', () => {
    const handlers = loadHandler()

    expect(typeof handlers.search).toBe('function')
    expect(typeof handlers.whoami).toBe('function')
  })

  it('returns the minimal admin user search payload for authorized requests', async () => {
    const { search } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, query: { query: 'ali' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await search(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:groups'] }, ['write:groups', 'manage:groups', 'write:users', 'manage:users', 'manage:system'])
    expect(global.WIKI.models.users.query).toHaveBeenCalled()
    const queryBuilder = global.WIKI.models.users.query.mock.results[0].value
    expect(queryBuilder.where).toHaveBeenCalledWith('email', 'like', '%ali%')
    expect(queryBuilder.where.mock.results[0].value.orWhere).toHaveBeenCalledWith('name', 'like', '%ali%')
    expect(queryBuilder.where.mock.results[0].value.orWhere.mock.results[0].value.limit).toHaveBeenCalledWith(10)
    expect(queryBuilder.where.mock.results[0].value.orWhere.mock.results[0].value.limit.mock.results[0].value.select).toHaveBeenCalledWith('id', 'name', 'email', 'providerKey')
    expect(res.json).toHaveBeenCalledWith([
      { id: 42, name: 'Alice', email: 'alice@example.com', providerKey: 'local' },
      { id: 77, name: 'Bob', email: 'bob@example.com', providerKey: 'ldap' }
    ])
  })

  it('returns an empty list for short search queries', async () => {
    const { search } = loadHandler()
    const req = { user: { permissions: ['manage:users'] }, query: { query: ' a ' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await search(req, res, jest.fn())

    expect(global.WIKI.models.users.query).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith([])
  })

  it('returns 403 for unauthorized user search requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { search } = loadHandler()
    const req = { user: { permissions: ['manage:api'] }, query: { query: 'ali' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await search(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'a user search admin permission is required' })
  })

  it('forwards unexpected user search failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.users.query.mockReturnValueOnce({
      where: jest.fn().mockReturnValue({
        orWhere: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            select: jest.fn().mockRejectedValue(new Error('search db down'))
          })
        })
      })
    })
    const { search } = loadHandler()
    const req = { user: { permissions: ['manage:system'] }, query: { query: 'ali' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await search(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('search db down')
  })

  it('returns anonymous state when no authenticated user is present', async () => {
    const { whoami } = loadHandler()
    const req = {}
    const res = { json: jest.fn() }

    await whoami(req, res)

    expect(res.json).toHaveBeenCalledWith({ authenticated: false, user: null })
  })

  it('returns a safe authenticated user summary', async () => {
    const { whoami } = loadHandler()
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

    await whoami(req, res)

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
    const { whoami } = loadHandler()
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

    await whoami(req, res)

    const payload = res.json.mock.calls[0][0]
    expect(payload.user.password).toBeUndefined()
    expect(payload.user.tfaSecret).toBeUndefined()
    expect(payload.user.providerId).toBeUndefined()
    expect(payload.user.continuationToken).toBeUndefined()
  })
})
