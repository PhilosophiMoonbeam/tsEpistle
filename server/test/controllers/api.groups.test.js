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
    return express.__router.get.mock.calls.find(([path]) => path === '/')[1]
  }

  it('registers the groups list route', () => {
    const handler = loadHandler()

    expect(typeof handler).toBe('function')
  })

  it('returns the minimal groups picker payload for authorized users', async () => {
    const handler = loadHandler()
    const req = { user: { permissions: ['manage:groups'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler(req, res, jest.fn())

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
    const handler = loadHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler(req, res, jest.fn())

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
    const handler = loadHandler()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler({ user: { permissions: ['write:users'] } }, res, jest.fn())
    await handler({ user: { permissions: ['manage:navigation'] } }, res, jest.fn())
    await handler({ user: { permissions: ['manage:api'] } }, res, jest.fn())

    expect(res.json).toHaveBeenCalledTimes(3)
  })

  it('returns 403 for unauthorized users', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const handler = loadHandler()
    const req = { user: { permissions: ['manage:theme'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'an admin groups picker permission is required' })
  })

  it('forwards unexpected query failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.groups.query.mockReturnValueOnce({
      select: jest.fn().mockRejectedValue(new Error('db down'))
    })
    const handler = loadHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('db down')
  })
})
