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
    express.__router.post.mockClear()

    global.WIKI = {
      auth: {
        checkAccess: jest.fn().mockReturnValue(true),
        reloadGroups: jest.fn().mockResolvedValue(undefined)
      },
      events: {
        outbound: {
          emit: jest.fn()
        }
      },
      data: {
        groups: {
          defaultPermissions: ['read:pages'],
          defaultPageRules: [{ id: 'default', path: '', roles: ['read:pages'], match: 'START', deny: false, locales: [] }]
        }
      },
      models: {
        groups: {
          query: jest.fn().mockReturnValue({
            insertAndFetch: jest.fn().mockResolvedValue({
              id: 3,
              name: 'Editors',
              isSystem: false,
              permissions: ['read:pages'],
              pageRules: []
            }),
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
            ]),
            findById: jest.fn().mockResolvedValue({
              id: 3,
              name: 'Editors',
              redirectOnLogin: '/en/home',
              isSystem: false,
              permissions: ['read:pages', 'write:pages'],
              pageRules: [
                {
                  id: 'rule-1',
                  path: 'docs',
                  roles: ['read:pages'],
                  match: 'START',
                  deny: false,
                  locales: ['en'],
                  extra: 'nope'
                }
              ],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
              $relatedQuery: jest.fn().mockReturnValue({
                select: jest.fn().mockResolvedValue([
                  { id: 10, name: 'Alice', email: 'alice@example.com', providerKey: 'local' },
                  { id: 11, name: 'Bob', email: 'bob@example.com', extra: 'nope' }
                ])
              })
            })
          })
        }
      }
    }
  })

  const loadHandler = () => {
    const express = require('express')
    require('../../controllers/api/groups')
    return {
      create: express.__router.post.mock.calls.find(([path]) => path === '/')[1],
      picker: express.__router.get.mock.calls.find(([path]) => path === '/')[1],
      list: express.__router.get.mock.calls.find(([path]) => path === '/list')[1],
      detail: express.__router.get.mock.calls.find(([path]) => path === '/:id')[1]
    }
  }

  it('registers the groups routes', () => {
    const handlers = loadHandler()

    expect(typeof handlers.create).toBe('function')
    expect(typeof handlers.picker).toBe('function')
    expect(typeof handlers.list).toBe('function')
    expect(typeof handlers.detail).toBe('function')
  })

  it('creates groups with default permissions for group admins', async () => {
    const { create } = loadHandler()
    const req = { user: { permissions: ['write:groups'] }, body: { name: ' Editors ' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await create(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['write:groups'] }, ['write:groups', 'manage:groups', 'manage:system'])
    expect(global.WIKI.models.groups.query.mock.results[0].value.insertAndFetch).toHaveBeenCalledWith({
      name: 'Editors',
      permissions: JSON.stringify(global.WIKI.data.groups.defaultPermissions),
      pageRules: JSON.stringify(global.WIKI.data.groups.defaultPageRules),
      isSystem: false
    })
    expect(global.WIKI.auth.reloadGroups).toHaveBeenCalled()
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('reloadGroups')
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'Group created successfully.',
      group: {
        id: 3,
        name: 'Editors',
        isSystem: false,
        permissions: ['read:pages'],
        pageRules: []
      }
    })
  })

  it('returns 403 for group create requests without group admin access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { create } = loadHandler()
    const req = { user: { permissions: ['manage:api'] }, body: { name: 'Editors' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await create(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'write:groups, manage:groups, or manage:system is required' })
  })

  it('returns 400 for blank group names', async () => {
    const { create } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, body: { name: '   ' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await create(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'group name is required' })
  })

  it('forwards unexpected group create failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.groups.query.mockReturnValueOnce({
      insertAndFetch: jest.fn().mockRejectedValue(new Error('create db down'))
    })
    const { create } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, body: { name: 'Editors' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await create(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('create db down')
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

  it('returns the admin group detail payload for group admins', async () => {
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { id: '3' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:groups'] }, ['write:groups', 'manage:groups', 'manage:system'])
    expect(global.WIKI.models.groups.query).toHaveBeenCalled()
    expect(global.WIKI.models.groups.query.mock.results[0].value.findById).toHaveBeenCalledWith(3)
    const group = await global.WIKI.models.groups.query.mock.results[0].value.findById.mock.results[0].value
    expect(group.$relatedQuery).toHaveBeenCalledWith('users')
    expect(group.$relatedQuery.mock.results[0].value.select).toHaveBeenCalledWith('id', 'name', 'email')
    const payload = res.json.mock.calls[0][0]
    expect(payload).toEqual({
      id: 3,
      name: 'Editors',
      redirectOnLogin: '/en/home',
      isSystem: false,
      permissions: ['read:pages', 'write:pages'],
      pageRules: [
        {
          id: 'rule-1',
          path: 'docs',
          roles: ['read:pages'],
          match: 'START',
          deny: false,
          locales: ['en']
        }
      ],
      users: [
        { id: 10, name: 'Alice', email: 'alice@example.com' },
        { id: 11, name: 'Bob', email: 'bob@example.com' }
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    })
    expect(payload.pageRules[0].extra).toBeUndefined()
    expect(payload.users[0].providerKey).toBeUndefined()
    expect(payload.users[1].extra).toBeUndefined()
  })

  it('returns 400 for malformed group detail ids', async () => {
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { id: '3abc' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'group id must be a positive integer' })
  })

  it('returns 404 when the requested group detail is missing', async () => {
    global.WIKI.models.groups.query.mockReturnValueOnce({
      findById: jest.fn().mockResolvedValue(null)
    })
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { id: '999' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'group not found' })
  })

  it('returns 403 for detail requests without group admin access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '3' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'write:groups, manage:groups, or manage:system is required' })
  })

  it('forwards unexpected detail query failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.groups.query.mockReturnValueOnce({
      findById: jest.fn().mockRejectedValue(new Error('detail db down'))
    })
    const { detail } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { id: '3' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await detail(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('detail db down')
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
