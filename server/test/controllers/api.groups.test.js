jest.mock('express', () => {
  const router = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
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
    express.__router.patch.mockClear()
    express.__router.delete.mockClear()

    global.WIKI = {
      auth: {
        checkAccess: jest.fn().mockReturnValue(true),
        checkExclusiveAccess: jest.fn().mockReturnValue(false),
        reloadGroups: jest.fn().mockResolvedValue(undefined),
        revokeUserTokens: jest.fn()
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
                ]),
                relate: jest.fn().mockResolvedValue(1),
                unrelate: jest.fn().mockReturnValue({
                  where: jest.fn().mockResolvedValue(1)
                })
              })
            }),
            patch: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue(1)
            }),
            deleteById: jest.fn().mockResolvedValue(1)
          })
        },
        knex: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            first: jest.fn().mockResolvedValue(null)
          })
        }),
        users: {
          query: jest.fn().mockReturnValue({
            findById: jest.fn().mockResolvedValue({
              id: 10,
              name: 'Alice',
              email: 'alice@example.com'
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
      assignUser: express.__router.post.mock.calls.find(([path]) => path === '/:groupId/users/:userId')[1],
      unassignUser: express.__router.delete.mock.calls.find(([path]) => path === '/:groupId/users/:userId')[1],
      deleteGroup: express.__router.delete.mock.calls.find(([path]) => path === '/:id')[1],
      updateGroup: express.__router.patch.mock.calls.find(([path]) => path === '/:id')[1],
      detail: express.__router.get.mock.calls.find(([path]) => path === '/:id')[1]
    }
  }

  it('registers the groups routes', () => {
    const handlers = loadHandler()

    expect(typeof handlers.create).toBe('function')
    expect(typeof handlers.picker).toBe('function')
    expect(typeof handlers.list).toBe('function')
    expect(typeof handlers.assignUser).toBe('function')
    expect(typeof handlers.unassignUser).toBe('function')
    expect(typeof handlers.deleteGroup).toBe('function')
    expect(typeof handlers.updateGroup).toBe('function')
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

  it('assigns group users and revokes their tokens', async () => {
    const { assignUser } = loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { groupId: '3', userId: '10' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await assignUser(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, ['manage:users', 'write:groups', 'manage:groups', 'manage:system'])
    const group = await global.WIKI.models.groups.query.mock.results[0].value.findById.mock.results[0].value
    expect(global.WIKI.models.groups.query.mock.results[0].value.findById).toHaveBeenCalledWith(3)
    expect(global.WIKI.models.users.query.mock.results[0].value.findById).toHaveBeenCalledWith(10)
    expect(global.WIKI.models.knex).toHaveBeenCalledWith('userGroups')
    expect(global.WIKI.models.knex.mock.results[0].value.where).toHaveBeenCalledWith({ userId: 10, groupId: 3 })
    expect(group.$relatedQuery).toHaveBeenCalledWith('users')
    expect(group.$relatedQuery.mock.results[0].value.relate).toHaveBeenCalledWith(10)
    expect(global.WIKI.auth.revokeUserTokens).toHaveBeenCalledWith({ id: 10, kind: 'u' })
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('addAuthRevoke', { id: 10, kind: 'u' })
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'User has been assigned to group.'
    })
  })

  it('returns 403 for group user assign requests without assignment access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { assignUser } = loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { groupId: '3', userId: '10' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await assignUser(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:users, write:groups, manage:groups, or manage:system is required' })
  })

  it('returns 400 for malformed group user assign ids and guest assignment', async () => {
    const { assignUser } = loadHandler()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await assignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: 'bad', userId: '10' } }, res, jest.fn())
    await assignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: '3', userId: 'bad' } }, res, jest.fn())
    await assignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: '3', userId: '2' } }, res, jest.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 400)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'group id must be a positive integer' })
    expect(res.status).toHaveBeenNthCalledWith(2, 400)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'user id must be a positive integer' })
    expect(res.status).toHaveBeenNthCalledWith(3, 400)
    expect(res.json).toHaveBeenNthCalledWith(3, { error: 'Cannot assign the Guest user to a group.' })
  })

  it('protects elevated group user assignments for lower-tier group admins', async () => {
    global.WIKI.models.groups.query.mockReturnValueOnce({
      findById: jest.fn().mockResolvedValue({
        id: 3,
        permissions: ['manage:users'],
        $relatedQuery: jest.fn()
      })
    })
    global.WIKI.auth.checkExclusiveAccess.mockReturnValueOnce(true)
    const { assignUser } = loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { groupId: '3', userId: '10' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await assignUser(req, res, jest.fn())

    expect(global.WIKI.auth.checkExclusiveAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, ['manage:users', 'write:groups'], ['manage:groups', 'manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'You are not authorized to assign a user to this administrative group.' })
  })

  it('protects system group user assignments for non-system group admins', async () => {
    global.WIKI.models.groups.query.mockReturnValueOnce({
      findById: jest.fn().mockResolvedValue({
        id: 1,
        permissions: ['manage:system'],
        $relatedQuery: jest.fn()
      })
    })
    global.WIKI.auth.checkExclusiveAccess
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const { assignUser } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { groupId: '1', userId: '10' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await assignUser(req, res, jest.fn())

    expect(global.WIKI.auth.checkExclusiveAccess).toHaveBeenNthCalledWith(2, { permissions: ['manage:groups'] }, ['manage:groups'], ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'You are not authorized to assign a user to a group with the manage:system permission.' })
  })

  it('returns 404 when assign group or user targets are missing', async () => {
    const { assignUser } = loadHandler()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    global.WIKI.models.groups.query.mockReturnValueOnce({
      findById: jest.fn().mockResolvedValue(null)
    })
    await assignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: '999', userId: '10' } }, res, jest.fn())

    global.WIKI.models.users.query.mockReturnValueOnce({
      findById: jest.fn().mockResolvedValue(null)
    })
    await assignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: '3', userId: '999' } }, res, jest.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 404)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'Invalid Group ID' })
    expect(res.status).toHaveBeenNthCalledWith(2, 404)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'Invalid User ID' })
  })

  it('returns 400 when group user assign relation already exists', async () => {
    global.WIKI.models.knex.mockReturnValueOnce({
      where: jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue({ userId: 10, groupId: 3 })
      })
    })
    const { assignUser } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { groupId: '3', userId: '10' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await assignUser(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'User is already assigned to group.' })
  })

  it('forwards unexpected group user assign failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.groups.query.mockReturnValueOnce({
      findById: jest.fn().mockRejectedValue(new Error('assign db down'))
    })
    const { assignUser } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { groupId: '3', userId: '10' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await assignUser(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('assign db down')
  })

  it('unassigns group users and revokes their tokens', async () => {
    const { unassignUser } = loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { groupId: '3', userId: '10' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await unassignUser(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, ['manage:users', 'write:groups', 'manage:groups', 'manage:system'])
    const group = await global.WIKI.models.groups.query.mock.results[0].value.findById.mock.results[0].value
    expect(global.WIKI.models.groups.query.mock.results[0].value.findById).toHaveBeenCalledWith(3)
    expect(global.WIKI.models.users.query.mock.results[0].value.findById).toHaveBeenCalledWith(10)
    expect(group.$relatedQuery).toHaveBeenCalledWith('users')
    expect(group.$relatedQuery.mock.results[0].value.unrelate).toHaveBeenCalled()
    expect(group.$relatedQuery.mock.results[0].value.unrelate.mock.results[0].value.where).toHaveBeenCalledWith('userId', 10)
    expect(global.WIKI.auth.revokeUserTokens).toHaveBeenCalledWith({ id: 10, kind: 'u' })
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('addAuthRevoke', { id: 10, kind: 'u' })
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'User has been unassigned from group.'
    })
  })

  it('returns 403 for group user unassign requests without assignment access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { unassignUser } = loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { groupId: '3', userId: '10' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await unassignUser(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:users, write:groups, manage:groups, or manage:system is required' })
  })

  it('returns 400 for malformed group user unassign ids', async () => {
    const { unassignUser } = loadHandler()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await unassignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: 'bad', userId: '10' } }, res, jest.fn())
    await unassignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: '3', userId: 'bad' } }, res, jest.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 400)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'group id must be a positive integer' })
    expect(res.status).toHaveBeenNthCalledWith(2, 400)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'user id must be a positive integer' })
  })

  it('returns protected account errors for invalid group user unassigns', async () => {
    const { unassignUser } = loadHandler()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await unassignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: '3', userId: '2' } }, res, jest.fn())
    await unassignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: '1', userId: '1' } }, res, jest.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 400)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'Cannot unassign Guest user' })
    expect(res.status).toHaveBeenNthCalledWith(2, 400)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'Cannot unassign Administrator user from Administrators group.' })
  })

  it('returns 404 when unassign group or user targets are missing', async () => {
    const { unassignUser } = loadHandler()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    global.WIKI.models.groups.query.mockReturnValueOnce({
      findById: jest.fn().mockResolvedValue(null)
    })
    await unassignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: '999', userId: '10' } }, res, jest.fn())

    global.WIKI.models.users.query.mockReturnValueOnce({
      findById: jest.fn().mockResolvedValue(null)
    })
    await unassignUser({ user: { permissions: ['manage:groups'] }, params: { groupId: '3', userId: '999' } }, res, jest.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 404)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'Invalid Group ID' })
    expect(res.status).toHaveBeenNthCalledWith(2, 404)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'Invalid User ID' })
  })

  it('forwards unexpected group user unassign failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.groups.query.mockReturnValueOnce({
      findById: jest.fn().mockRejectedValue(new Error('unassign db down'))
    })
    const { unassignUser } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { groupId: '3', userId: '10' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await unassignUser(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('unassign db down')
  })

  it('deletes groups and reloads group permissions', async () => {
    const { deleteGroup } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { id: '3' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await deleteGroup(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:groups'] }, ['write:groups', 'manage:groups', 'manage:system'])
    expect(global.WIKI.models.groups.query.mock.results[0].value.deleteById).toHaveBeenCalledWith(3)
    expect(global.WIKI.auth.revokeUserTokens).toHaveBeenCalledWith({ id: 3, kind: 'g' })
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('addAuthRevoke', { id: 3, kind: 'g' })
    expect(global.WIKI.auth.reloadGroups).toHaveBeenCalled()
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('reloadGroups')
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'Group has been deleted.'
    })
  })

  it('returns 403 for group delete requests without group admin access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { deleteGroup } = loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '3' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await deleteGroup(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'write:groups, manage:groups, or manage:system is required' })
  })

  it('returns 400 for malformed and protected group delete ids', async () => {
    const { deleteGroup } = loadHandler()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await deleteGroup({ user: { permissions: ['manage:groups'] }, params: { id: 'bad' } }, res, jest.fn())
    await deleteGroup({ user: { permissions: ['manage:groups'] }, params: { id: '1' } }, res, jest.fn())
    await deleteGroup({ user: { permissions: ['manage:groups'] }, params: { id: '2' } }, res, jest.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 400)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'group id must be a positive integer' })
    expect(res.status).toHaveBeenNthCalledWith(2, 400)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'Cannot delete this group.' })
    expect(res.status).toHaveBeenNthCalledWith(3, 400)
    expect(res.json).toHaveBeenNthCalledWith(3, { error: 'Cannot delete this group.' })
  })

  it('forwards unexpected group delete failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.groups.query.mockReturnValueOnce({
      deleteById: jest.fn().mockRejectedValue(new Error('delete db down'))
    })
    const { deleteGroup } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { id: '3' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await deleteGroup(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('delete db down')
  })

  it('updates groups and reloads group permissions', async () => {
    const { updateGroup } = loadHandler()
    const req = {
      user: { permissions: ['manage:groups'] },
      params: { id: '3' },
      body: {
        name: 'Editors',
        redirectOnLogin: '/docs',
        permissions: ['read:pages'],
        pageRules: [{ id: 'rule-1', path: 'docs', roles: ['read:pages'], match: 'START', deny: false, locales: ['en'] }]
      }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateGroup(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:groups'] }, ['write:groups', 'manage:groups', 'manage:system'])
    const query = global.WIKI.models.groups.query.mock.results[0].value
    expect(query.patch).toHaveBeenCalledWith({
      name: 'Editors',
      redirectOnLogin: '/docs',
      permissions: JSON.stringify(['read:pages']),
      pageRules: JSON.stringify([{ id: 'rule-1', path: 'docs', roles: ['read:pages'], match: 'START', deny: false, locales: ['en'] }])
    })
    expect(query.patch.mock.results[0].value.where).toHaveBeenCalledWith('id', 3)
    expect(global.WIKI.auth.revokeUserTokens).toHaveBeenCalledWith({ id: 3, kind: 'g' })
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('addAuthRevoke', { id: 3, kind: 'g' })
    expect(global.WIKI.auth.reloadGroups).toHaveBeenCalled()
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('reloadGroups')
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'Group has been updated.'
    })
  })

  it('returns 403 for group update requests without group admin access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { updateGroup } = loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '3' }, body: { name: 'Editors', permissions: [], pageRules: [] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateGroup(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'write:groups, manage:groups, or manage:system is required' })
  })

  it('returns 400 for malformed group update ids and payloads', async () => {
    const { updateGroup } = loadHandler()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const user = { permissions: ['manage:groups'] }

    await updateGroup({ user, params: { id: 'bad' }, body: { name: 'Editors', permissions: [], pageRules: [] } }, res, jest.fn())
    await updateGroup({ user, params: { id: '3' }, body: { name: '', permissions: [], pageRules: [] } }, res, jest.fn())
    await updateGroup({ user, params: { id: '3' }, body: { name: 'Editors', permissions: 'bad', pageRules: [] } }, res, jest.fn())
    await updateGroup({ user, params: { id: '3' }, body: { name: 'Editors', permissions: [], pageRules: 'bad' } }, res, jest.fn())
    await updateGroup({ user, params: { id: '3' }, body: { name: 'Editors', permissions: [], pageRules: [{ path: 7, match: 'START' }] } }, res, jest.fn())
    await updateGroup({ user, params: { id: '3' }, body: { name: 'Editors', permissions: [], pageRules: [{ id: 'rule-1', path: 'docs', roles: ['read:pages'], match: 'BAD', deny: false, locales: ['en'] }] } }, res, jest.fn())
    await updateGroup({ user, params: { id: '3' }, body: { name: 'Editors', permissions: [], pageRules: [{ id: 'rule-1', path: 'docs', roles: 'read:pages', match: 'START', deny: false, locales: ['en'] }] } }, res, jest.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 400)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'group id must be a positive integer' })
    expect(res.status).toHaveBeenNthCalledWith(2, 400)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'group name is required' })
    expect(res.status).toHaveBeenNthCalledWith(3, 400)
    expect(res.json).toHaveBeenNthCalledWith(3, { error: 'group permissions must be an array of strings' })
    expect(res.status).toHaveBeenNthCalledWith(4, 400)
    expect(res.json).toHaveBeenNthCalledWith(4, { error: 'group page rules must be an array' })
    expect(res.status).toHaveBeenNthCalledWith(5, 400)
    expect(res.json).toHaveBeenNthCalledWith(5, { error: 'group page rules are invalid' })
    expect(res.status).toHaveBeenNthCalledWith(6, 400)
    expect(res.json).toHaveBeenNthCalledWith(6, { error: 'group page rules are invalid' })
    expect(res.status).toHaveBeenNthCalledWith(7, 400)
    expect(res.json).toHaveBeenNthCalledWith(7, { error: 'group page rules are invalid' })
  })

  it('rejects unsafe regex group update page rules', async () => {
    const { updateGroup } = loadHandler()
    const req = {
      user: { permissions: ['manage:groups'] },
      params: { id: '3' },
      body: {
        name: 'Editors',
        permissions: [],
        pageRules: [{ id: 'rule-1', path: '(x+x+)+y', roles: ['read:pages'], match: 'REGEX', deny: false, locales: ['en'] }]
      }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateGroup(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Some Page Rules contains unsafe or exponential time regex.' })
  })

  it('defaults blank group update redirectOnLogin to slash', async () => {
    const { updateGroup } = loadHandler()
    const req = {
      user: { permissions: ['manage:groups'] },
      params: { id: '3' },
      body: { name: 'Editors', redirectOnLogin: '', permissions: [], pageRules: [] }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateGroup(req, res, jest.fn())

    expect(global.WIKI.models.groups.query.mock.results[0].value.patch).toHaveBeenCalledWith(expect.objectContaining({
      redirectOnLogin: '/'
    }))
  })

  it('protects elevated and system group update permissions', async () => {
    const { updateGroup } = loadHandler()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    global.WIKI.auth.checkExclusiveAccess.mockReturnValueOnce(true)
    await updateGroup({
      user: { permissions: ['write:groups'] },
      params: { id: '3' },
      body: { name: 'Editors', permissions: ['manage:users'], pageRules: [] }
    }, res, jest.fn())

    global.WIKI.auth.checkExclusiveAccess
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    await updateGroup({
      user: { permissions: ['manage:groups'] },
      params: { id: '3' },
      body: { name: 'Editors', permissions: ['manage:system'], pageRules: [] }
    }, res, jest.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 403)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'You are not authorized to manage this group or assign these administrative permissions.' })
    expect(res.status).toHaveBeenNthCalledWith(2, 403)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'You are not authorized to manage this group or assign the manage:system permissions.' })
  })

  it('forwards unexpected group update failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.groups.query.mockReturnValueOnce({
      patch: jest.fn().mockReturnValue({
        where: jest.fn().mockRejectedValue(new Error('update db down'))
      })
    })
    const { updateGroup } = loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, params: { id: '3' }, body: { name: 'Editors', permissions: [], pageRules: [] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateGroup(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('update db down')
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
