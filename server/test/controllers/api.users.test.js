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
        checkAccess: jest.fn().mockReturnValue(true),
        strategies: {
          local: {
            displayName: 'Local',
            strategyKey: 'local'
          }
        }
      },
      data: {
        authentication: [
          { key: 'local', useForm: true }
        ]
      },
      models: {
        users: {
          query: jest.fn().mockImplementation(() => ({
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
            }),
            select: jest.fn().mockReturnValue({
              whereNotNull: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue([
                    {
                      id: 42,
                      name: 'Alice',
                      lastLoginAt: '2026-01-03T00:00:00.000Z',
                      email: 'hidden@example.com'
                    },
                    {
                      id: 77,
                      name: 'Bob',
                      lastLoginAt: '2026-01-02T00:00:00.000Z'
                    }
                  ])
                })
              })
            }),
            findById: jest.fn().mockResolvedValue({
              id: 42,
              name: 'Alice',
              email: 'alice@example.com',
              providerKey: 'local',
              providerId: 'provider-42',
              location: 'Tallinn',
              jobTitle: 'Architect',
              timezone: 'Europe/Tallinn',
              isSystem: false,
              isActive: true,
              isVerified: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
              lastLoginAt: '2026-01-03T00:00:00.000Z',
              tfaIsActive: true,
              password: 'secret',
              tfaSecret: 'hidden',
              permissions: ['manage:system'],
              $relatedQuery: jest.fn().mockReturnValue({
                select: jest.fn().mockResolvedValue([
                  { id: 1, name: 'Administrators', isSystem: true },
                  { id: 3, name: 'Editors', description: 'hidden' }
                ])
              })
            })
          }))
        }
      }
    }
  })

  const loadHandler = () => {
    const express = require('express')
    require('../../controllers/api/users')
    return {
      list: express.__router.get.mock.calls.find(([path]) => path === '/')[1],
      search: express.__router.get.mock.calls.find(([path]) => path === '/search')[1],
      lastLogins: express.__router.get.mock.calls.find(([path]) => path === '/last-logins')[1],
      whoami: express.__router.get.mock.calls.find(([path]) => path === '/whoami')[1],
      detail: express.__router.get.mock.calls.find(([path]) => path === '/:id')[1]
    }
  }

  it('registers the users routes', () => {
    const handlers = loadHandler()

    expect(typeof handlers.list).toBe('function')
    expect(typeof handlers.search).toBe('function')
    expect(typeof handlers.lastLogins).toBe('function')
    expect(typeof handlers.whoami).toBe('function')
    expect(typeof handlers.detail).toBe('function')
  })

  it('registers the last-logins route before the detail route', () => {
    loadHandler()
    const express = require('express')
    const registeredGetPaths = express.__router.get.mock.calls.map(([path]) => path)

    expect(registeredGetPaths.indexOf('/last-logins')).toBeGreaterThanOrEqual(0)
    expect(registeredGetPaths.indexOf('/:id')).toBeGreaterThan(registeredGetPaths.indexOf('/last-logins'))
  })

  it('registers the list route before the detail route', () => {
    loadHandler()
    const express = require('express')
    const registeredGetPaths = express.__router.get.mock.calls.map(([path]) => path)

    expect(registeredGetPaths.indexOf('/')).toBeGreaterThanOrEqual(0)
    expect(registeredGetPaths.indexOf('/:id')).toBeGreaterThan(registeredGetPaths.indexOf('/'))
  })

  it('returns the paginated admin users list for authorized requests', async () => {
    const countFilterBuilder = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis()
    }
    const listFilterBuilder = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis()
    }
    const countBuilder = {
      where: jest.fn(callback => {
        callback(countFilterBuilder)
        return countBuilder
      }),
      andWhere: jest.fn().mockReturnThis(),
      count: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ total: '2' })
    }
    const listBuilder = {
      where: jest.fn(callback => {
        callback(listFilterBuilder)
        return listBuilder
      }),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([
        {
          id: 42,
          email: 'alice@example.com',
          name: 'Alice',
          providerKey: 'local',
          isSystem: false,
          isActive: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-03T00:00:00.000Z',
          password: 'hidden'
        },
        {
          id: 77,
          email: 'bob@example.com',
          name: 'Bob',
          providerKey: 'ldap',
          isSystem: false,
          isActive: false,
          createdAt: '2026-01-02T00:00:00.000Z',
          lastLoginAt: null,
          tfaSecret: 'hidden'
        }
      ])
    }
    global.WIKI.models.users.query
      .mockReturnValueOnce(countBuilder)
      .mockReturnValueOnce(listBuilder)
    const { list } = loadHandler()
    const req = {
      user: { permissions: ['manage:users'] },
      query: {
        page: '3',
        pageSize: '25',
        filter: ' ali ',
        providerKey: 'local',
        orderBy: 'lastLoginAt',
        orderByDirection: 'DESC'
      }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await list(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, ['manage:users', 'manage:system'])
    expect(global.WIKI.models.users.query).toHaveBeenCalledTimes(2)
    expect(countFilterBuilder.where).toHaveBeenCalledWith('email', 'like', '%ali%')
    expect(countFilterBuilder.orWhere).toHaveBeenCalledWith('name', 'like', '%ali%')
    expect(countBuilder.andWhere).toHaveBeenCalledWith('providerKey', 'local')
    expect(countBuilder.count).toHaveBeenCalledWith('* as total')
    expect(countBuilder.first).toHaveBeenCalled()
    expect(listFilterBuilder.where).toHaveBeenCalledWith('email', 'like', '%ali%')
    expect(listFilterBuilder.orWhere).toHaveBeenCalledWith('name', 'like', '%ali%')
    expect(listBuilder.andWhere).toHaveBeenCalledWith('providerKey', 'local')
    expect(listBuilder.select).toHaveBeenCalledWith('id', 'email', 'name', 'providerKey', 'isSystem', 'isActive', 'createdAt', 'lastLoginAt')
    expect(listBuilder.orderBy).toHaveBeenCalledWith('lastLoginAt', 'desc')
    expect(listBuilder.offset).toHaveBeenCalledWith(50)
    expect(listBuilder.limit).toHaveBeenCalledWith(25)
    expect(res.json).toHaveBeenCalledWith({
      total: 2,
      users: [
        {
          id: 42,
          email: 'alice@example.com',
          name: 'Alice',
          providerKey: 'local',
          isSystem: false,
          isActive: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-03T00:00:00.000Z'
        },
        {
          id: 77,
          email: 'bob@example.com',
          name: 'Bob',
          providerKey: 'ldap',
          isSystem: false,
          isActive: false,
          createdAt: '2026-01-02T00:00:00.000Z',
          lastLoginAt: null
        }
      ]
    })
  })

  it('uses safe defaults for invalid admin users list query options', async () => {
    const countBuilder = {
      count: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ total: 0 })
    }
    const listBuilder = {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([])
    }
    global.WIKI.models.users.query
      .mockReturnValueOnce(countBuilder)
      .mockReturnValueOnce(listBuilder)
    const { list } = loadHandler()
    const req = {
      user: { permissions: ['manage:system'] },
      query: {
        page: '-9',
        pageSize: '0',
        providerKey: 'all',
        orderBy: 'password',
        orderByDirection: 'sideways'
      }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await list(req, res, jest.fn())

    expect(countBuilder.where).toBeUndefined()
    expect(countBuilder.andWhere).toBeUndefined()
    expect(listBuilder.orderBy).toHaveBeenCalledWith('name', 'asc')
    expect(listBuilder.offset).toHaveBeenCalledWith(0)
    expect(listBuilder.limit).toHaveBeenCalledWith(15)
    expect(res.json).toHaveBeenCalledWith({ total: 0, users: [] })
  })

  it('returns 403 for unauthorized admin users list requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { list } = loadHandler()
    const req = { user: { permissions: ['manage:api'] }, query: {} }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await list(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:users or manage:system is required' })
    expect(global.WIKI.models.users.query).not.toHaveBeenCalled()
  })

  it('forwards unexpected admin users list failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.users.query.mockReturnValueOnce({
      count: jest.fn().mockReturnThis(),
      first: jest.fn().mockRejectedValue(new Error('list db down'))
    })
    const { list } = loadHandler()
    const req = { user: { permissions: ['manage:system'] }, query: {} }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await list(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('list db down')
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

  it('returns the minimal dashboard last-logins payload for authorized requests', async () => {
    const { lastLogins } = loadHandler()
    const req = { user: { permissions: ['write:users'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await lastLogins(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['write:users'] }, ['write:groups', 'manage:groups', 'write:users', 'manage:users', 'manage:system'])
    expect(global.WIKI.models.users.query).toHaveBeenCalled()
    const queryBuilder = global.WIKI.models.users.query.mock.results[0].value
    expect(queryBuilder.select).toHaveBeenCalledWith('id', 'name', 'lastLoginAt')
    expect(queryBuilder.select.mock.results[0].value.whereNotNull).toHaveBeenCalledWith('lastLoginAt')
    expect(queryBuilder.select.mock.results[0].value.whereNotNull.mock.results[0].value.orderBy).toHaveBeenCalledWith('lastLoginAt', 'desc')
    expect(queryBuilder.select.mock.results[0].value.whereNotNull.mock.results[0].value.orderBy.mock.results[0].value.limit).toHaveBeenCalledWith(10)
    expect(res.json).toHaveBeenCalledWith([
      { id: 42, name: 'Alice', lastLoginAt: '2026-01-03T00:00:00.000Z' },
      { id: 77, name: 'Bob', lastLoginAt: '2026-01-02T00:00:00.000Z' }
    ])
  })

  it('returns 403 for unauthorized dashboard last-logins requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { lastLogins } = loadHandler()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await lastLogins(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'a dashboard user activity permission is required' })
  })

  it('forwards unexpected dashboard last-logins failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.users.query.mockReturnValueOnce({
      select: jest.fn().mockReturnValue({
        whereNotNull: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockRejectedValue(new Error('last logins db down'))
          })
        })
      })
    })
    const { lastLogins } = loadHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await lastLogins(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('last logins db down')
  })

  it('returns the sanitized admin user detail payload for authorized requests', async () => {
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '42' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, ['manage:users', 'manage:system'])
    expect(global.WIKI.models.users.query).toHaveBeenCalled()
    const queryBuilder = global.WIKI.models.users.query.mock.results[0].value
    expect(queryBuilder.findById).toHaveBeenCalledWith(42)
    const user = await queryBuilder.findById.mock.results[0].value
    expect(user.$relatedQuery).toHaveBeenCalledWith('groups')
    expect(user.$relatedQuery.mock.results[0].value.select).toHaveBeenCalledWith('id', 'name')
    const payload = res.json.mock.calls[0][0]
    expect(payload).toEqual({
      id: 42,
      name: 'Alice',
      email: 'alice@example.com',
      providerKey: 'local',
      providerName: 'Local',
      providerId: 'provider-42',
      providerIs2FACapable: true,
      location: 'Tallinn',
      jobTitle: 'Architect',
      timezone: 'Europe/Tallinn',
      isSystem: false,
      isActive: true,
      isVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastLoginAt: '2026-01-03T00:00:00.000Z',
      tfaIsActive: true,
      groups: [
        { id: 1, name: 'Administrators' },
        { id: 3, name: 'Editors' }
      ]
    })
    expect(payload.password).toBeUndefined()
    expect(payload.tfaSecret).toBeUndefined()
    expect(payload.permissions).toBeUndefined()
    expect(payload.groups[1].description).toBeUndefined()
  })

  it('returns unknown provider metadata when the strategy is missing', async () => {
    delete global.WIKI.auth.strategies.local
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '42' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, jest.fn())

    expect(res.json.mock.calls[0][0].providerName).toBe('Unknown')
    expect(res.json.mock.calls[0][0].providerIs2FACapable).toBe(false)
  })

  it('returns 400 for malformed user detail ids', async () => {
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '42abc' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'user id must be a positive integer' })
  })

  it('returns 404 when the requested user detail is missing', async () => {
    global.WIKI.models.users.query.mockReturnValueOnce({
      findById: jest.fn().mockResolvedValue(null)
    })
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '999' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'user not found' })
  })

  it('returns 403 for unauthorized user detail requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '42' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:users or manage:system is required' })
  })

  it('forwards unexpected user detail failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.users.query.mockReturnValueOnce({
      findById: jest.fn().mockRejectedValue(new Error('detail db down'))
    })
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '42' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('detail db down')
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
