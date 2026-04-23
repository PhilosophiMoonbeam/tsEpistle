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

describe('controllers/api groups endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__router.get.mockClear()

    global.WIKI = {
      auth: {
        checkAccess: jest.fn().mockReturnValue(true)
      },
      models: {
        groups: {
          query: jest.fn().mockReturnValue({
            select: jest.fn().mockResolvedValue([
              {
                id: 1,
                name: 'Administrators',
                isSystem: true
              },
              {
                id: 3,
                name: 'Editors',
                isSystem: false
              }
            ])
          })
        }
      }
    }
  })

  const loadHandler = () => {
    const express = require('express')
    require('../../controllers/api/groups')
    return {
      picker: express.__router.get.mock.calls.find(([path]) => path === '/')[1],
      list: express.__router.get.mock.calls.find(([path]) => path === '/list')[1]
    }
  }

  it('registers the groups routes', () => {
    const handlers = loadHandler()

    expect(typeof handlers.picker).toBe('function')
    expect(typeof handlers.list).toBe('function')
  })

  it('returns the minimal groups picker payload for authorized users', async () => {
    const { picker } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await picker(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:groups'] }, ['write:groups', 'manage:groups', 'manage:system', 'write:users', 'manage:users', 'manage:navigation', 'manage:api'])
    expect(global.WIKI.models.groups.query).toHaveBeenCalled()
    expect(global.WIKI.models.groups.query.mock.results[0].value.select).toHaveBeenCalledWith('id', 'name', 'isSystem')
    expect(res.json).toHaveBeenCalledWith([
      { id: 1, name: 'Administrators', isSystem: true },
      { id: 3, name: 'Editors', isSystem: false }
    ])
  })

  it('does not leak extra group fields', async () => {
    global.WIKI.models.groups.query.mockReturnValueOnce({
      select: jest.fn().mockResolvedValue([
        {
          id: 3,
          name: 'Editors',
          isSystem: false,
          permissions: ['read:pages'],
          userCount: 9
        }
      ])
    })
    const { picker } = loadHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await picker(req, res, jest.fn())

    const payload = res.json.mock.calls[0][0]
    expect(payload[0].permissions).toBeUndefined()
    expect(payload[0].userCount).toBeUndefined()
    expect(payload[0]).toEqual({
      id: 3,
      name: 'Editors',
      isSystem: false
    })
  })

  it('returns the minimal groups picker payload for users, navigation, and api admins too', async () => {
    const { picker } = loadHandler()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await picker({ user: { permissions: ['write:users'] } }, res, jest.fn())
    await picker({ user: { permissions: ['manage:navigation'] } }, res, jest.fn())
    await picker({ user: { permissions: ['manage:api'] } }, res, jest.fn())

    expect(res.json).toHaveBeenCalledTimes(3)
  })

  it('returns 403 for unauthorized users', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { picker } = loadHandler()
    const req = { user: { permissions: ['manage:theme'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await picker(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'an admin groups picker permission is required' })
  })

  it('returns the admin groups table payload for group admins', async () => {
    global.WIKI.models.groups.relatedQuery = jest.fn().mockReturnValue({
      count: jest.fn().mockReturnValue({
        as: jest.fn().mockReturnValue('userCountExpr')
      })
    })
    global.WIKI.models.groups.query.mockReturnValueOnce({
      select: jest.fn().mockResolvedValue([
        {
          id: 1,
          name: 'Administrators',
          isSystem: true,
          userCount: '2',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          permissions: ['manage:system']
        }
      ])
    })
    const { list } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await list(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:groups'] }, ['write:groups', 'manage:groups', 'manage:system'])
    expect(res.json).toHaveBeenCalledWith([
      {
        id: 1,
        name: 'Administrators',
        isSystem: true,
        userCount: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ])
    expect(global.WIKI.models.groups.query.mock.results[0].value.select).toHaveBeenCalledWith(
      'groups.id',
      'groups.name',
      'groups.isSystem',
      'groups.createdAt',
      'groups.updatedAt',
      'userCountExpr'
    )
    const payload = res.json.mock.calls[0][0][0]
    expect(payload.permissions).toBeUndefined()
  })

  it('returns 403 for table-list requests without group admin access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { list } = loadHandler()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await list(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'write:groups, manage:groups, or manage:system is required' })
  })

  it('forwards unexpected query failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.groups.query.mockReturnValueOnce({
      select: jest.fn().mockRejectedValue(new Error('db down'))
    })
    const { picker } = loadHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await picker(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('db down')
  })
})
