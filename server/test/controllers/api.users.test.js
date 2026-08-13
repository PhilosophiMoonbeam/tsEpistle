vi.mock('express', () => {
  const router = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
    use: vi.fn()
  }

  const expressMock = {
    Router: () => router,
    __router: router
  }

  return { default: expressMock, ...expressMock }
})

import * as express from 'express'

describe('controllers/api users endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__router.get.mockClear()
    express.__router.post.mockClear()
    express.__router.put.mockClear()
    express.__router.delete.mockClear()
    express.__router.patch.mockClear()

    global.WIKI = {
      Error: {},
      auth: {
        checkAccess: vi.fn().mockReturnValue(true),
        checkAssignUserToGroupAccess: vi.fn().mockResolvedValue(true),
        revokeUserTokens: vi.fn(),
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
      events: {
        outbound: {
          emit: vi.fn()
        }
      },
      models: {
        users: {
          createNewUser: vi.fn().mockResolvedValue(undefined),
          updateUser: vi.fn().mockResolvedValue(undefined),
          deleteUser: vi.fn().mockResolvedValue(undefined),
          query: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockReturnValue({
              orWhere: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  select: vi.fn().mockResolvedValue([
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
            select: vi.fn().mockReturnValue({
              whereNotNull: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
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
            findById: vi.fn().mockResolvedValue({
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
              $relatedQuery: vi.fn().mockReturnValue({
                select: vi.fn().mockResolvedValue([
                  { id: 1, name: 'Administrators', isSystem: true },
                  { id: 3, name: 'Editors', description: 'hidden' }
                ])
              })
            })
          }))
        },
        pages: {
          query: vi.fn()
        }
      }
    }
  })

  const loadHandler = async () => {
    await import('../../controllers/api/users.ts')
    return {
      create: express.__router.post.mock.calls.find(([path]) => path === '/')[1],
      list: express.__router.get.mock.calls.find(([path]) => path === '/')[1],
      search: express.__router.get.mock.calls.find(([path]) => path === '/search')[1],
      lastLogins: express.__router.get.mock.calls.find(([path]) => path === '/last-logins')[1],
      whoami: express.__router.get.mock.calls.find(([path]) => path === '/whoami')[1],
      update: express.__router.put.mock.calls.find(([path]) => path === '/:id')[1],
      delete: express.__router.delete.mock.calls.find(([path]) => path === '/:id')[1],
      status: express.__router.patch.mock.calls.find(([path]) => path === '/:id/status')[1],
      verification: express.__router.patch.mock.calls.find(([path]) => path === '/:id/verification')[1],
      tfa: express.__router.patch.mock.calls.find(([path]) => path === '/:id/tfa')[1],
      detail: express.__router.get.mock.calls.find(([path]) => path === '/:id')[1]
    }
  }

  it('registers the users routes', async () => {
    const handlers = await loadHandler()

    expect(typeof handlers.create).toBe('function')
    expect(typeof handlers.list).toBe('function')
    expect(typeof handlers.search).toBe('function')
    expect(typeof handlers.lastLogins).toBe('function')
    expect(typeof handlers.whoami).toBe('function')
    expect(typeof handlers.update).toBe('function')
    expect(typeof handlers.delete).toBe('function')
    expect(typeof handlers.status).toBe('function')
    expect(typeof handlers.verification).toBe('function')
    expect(typeof handlers.tfa).toBe('function')
    expect(typeof handlers.detail).toBe('function')
  })

  it('creates admin users for authorized requests', async () => {
    const { create } = await loadHandler()
    const req = {
      user: { permissions: ['write:users'] },
      body: {
        providerKey: 'local',
        email: 'alice@example.com',
        passwordRaw: 'temporary-secret',
        name: 'Alice',
        groups: [3, 4],
        mustChangePassword: true,
        sendWelcomeEmail: false,
        ignored: 'not forwarded'
      }
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await create(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['write:users'] }, ['write:users', 'manage:users', 'manage:system'])
    expect(global.WIKI.auth.checkAssignUserToGroupAccess).toHaveBeenCalledWith({ permissions: ['write:users'] }, [3, 4])
    expect(global.WIKI.models.users.createNewUser).toHaveBeenCalledWith({
      providerKey: 'local',
      email: 'alice@example.com',
      passwordRaw: 'temporary-secret',
      name: 'Alice',
      groups: [3, 4],
      mustChangePassword: true,
      sendWelcomeEmail: false
    })
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'User created successfully'
    })
  })

  it('returns 400 when admin user create groups is not an array', async () => {
    const { create } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, body: { groups: '3' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await create(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'groups must be an array' })
    expect(global.WIKI.models.users.createNewUser).not.toHaveBeenCalled()
  })

  it('returns 403 for unauthorized admin user create requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { create } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, body: { groups: [] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await create(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'write:users, manage:users or manage:system is required' })
    expect(global.WIKI.models.users.createNewUser).not.toHaveBeenCalled()
  })

  it('returns 403 when admin user create assigns disallowed elevated groups', async () => {
    global.WIKI.auth.checkAssignUserToGroupAccess.mockResolvedValueOnce(false)
    const { create } = await loadHandler()
    const req = {
      user: { permissions: ['write:users'] },
      body: { providerKey: 'local', email: 'alice@example.com', name: 'Alice', groups: [1] }
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await create(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'You are not authorized to create a user with an assignment to an administrative group.' })
    expect(global.WIKI.models.users.createNewUser).not.toHaveBeenCalled()
  })

  it('returns model validation errors for admin user create failures', async () => {
    global.WIKI.models.users.createNewUser.mockRejectedValueOnce(new Error('An account already exists using this email address.'))
    const { create } = await loadHandler()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { providerKey: 'local', email: 'alice@example.com', name: 'Alice', groups: [] }
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await create(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'An account already exists using this email address.' })
  })

  it('updates admin users for authorized requests', async () => {
    const { update } = await loadHandler()
    const req = {
      user: { permissions: ['manage:users'] },
      params: { id: '42' },
      body: {
        email: 'alice@example.com',
        name: 'Alice',
        newPassword: 'new-secret',
        groups: [3, 4],
        location: 'Tallinn',
        jobTitle: 'Architect',
        timezone: 'Europe/Tallinn',
        dateFormat: 'YYYY-MM-DD',
        appearance: 'dark',
        ignored: 'not forwarded'
      }
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await update(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, ['manage:users', 'manage:system'])
    expect(global.WIKI.auth.checkAssignUserToGroupAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, [3, 4])
    expect(global.WIKI.models.users.updateUser).toHaveBeenCalledWith({
      id: 42,
      email: 'alice@example.com',
      name: 'Alice',
      newPassword: 'new-secret',
      groups: [3, 4],
      location: 'Tallinn',
      jobTitle: 'Architect',
      timezone: 'Europe/Tallinn',
      dateFormat: 'YYYY-MM-DD',
      appearance: 'dark'
    })
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'User updated successfully'
    })
  })

  it('returns 400 for malformed admin user update ids and groups', async () => {
    const { update } = await loadHandler()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await update({ user: { permissions: ['manage:users'] }, params: { id: '42abc' }, body: { groups: [] } }, res, vi.fn())
    await update({ user: { permissions: ['manage:users'] }, params: { id: '42' }, body: { groups: '3' } }, res, vi.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 400)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'user id must be a positive integer' })
    expect(res.status).toHaveBeenNthCalledWith(2, 400)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'groups must be an array' })
    expect(global.WIKI.models.users.updateUser).not.toHaveBeenCalled()
  })

  it('returns 403 for unauthorized admin user update requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { update } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '42' }, body: { groups: [] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await update(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:users or manage:system is required' })
    expect(global.WIKI.models.users.updateUser).not.toHaveBeenCalled()
  })

  it('returns 403 when admin user update assigns disallowed elevated groups', async () => {
    global.WIKI.auth.checkAssignUserToGroupAccess.mockResolvedValueOnce(false)
    const { update } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '42' }, body: { groups: [1] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await update(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'You are not authorized to modify / assign a user from / to an administrative group.' })
    expect(global.WIKI.models.users.updateUser).not.toHaveBeenCalled()
  })

  it('returns model validation errors for admin user update failures', async () => {
    global.WIKI.models.users.updateUser.mockRejectedValueOnce(new Error('Password must be at least 6 characters!'))
    const { update } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '42' }, body: { groups: [] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await update(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Password must be at least 6 characters!' })
  })

  it('deletes admin users for authorized requests and revokes tokens', async () => {
    const { delete: deleteHandler } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '42' }, body: { replaceId: 7 } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteHandler(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, ['manage:users', 'manage:system'])
    expect(global.WIKI.models.users.deleteUser).toHaveBeenCalledWith(42, 7)
    expect(global.WIKI.auth.revokeUserTokens).toHaveBeenCalledWith({ id: 42, kind: 'u' })
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('addAuthRevoke', { id: 42, kind: 'u' })
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'User deleted successfully'
    })
  })

  it('returns 400 for malformed admin user delete ids and replacement ids', async () => {
    const { delete: deleteHandler } = await loadHandler()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteHandler({ user: { permissions: ['manage:users'] }, params: { id: '42abc' }, body: { replaceId: 7 } }, res, vi.fn())
    await deleteHandler({ user: { permissions: ['manage:users'] }, params: { id: '42' }, body: { replaceId: '7abc' } }, res, vi.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 400)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'user id must be a positive integer' })
    expect(res.status).toHaveBeenNthCalledWith(2, 400)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'user id must be a positive integer' })
    expect(global.WIKI.models.users.deleteUser).not.toHaveBeenCalled()
  })

  it('returns 403 for unauthorized admin user delete requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { delete: deleteHandler } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '42' }, body: { replaceId: 7 } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:users or manage:system is required' })
    expect(global.WIKI.models.users.deleteUser).not.toHaveBeenCalled()
  })

  it('rejects protected admin user deletes before calling the model', async () => {
    const { delete: deleteHandler } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '2' }, body: { replaceId: 7 } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Cannot delete a protected system account.' })
    expect(global.WIKI.models.users.deleteUser).not.toHaveBeenCalled()
  })

  it('maps foreign constraint admin user delete failures', async () => {
    global.WIKI.models.users.deleteUser.mockRejectedValueOnce(new Error('SQLITE_CONSTRAINT: foreign key constraint failed'))
    const { delete: deleteHandler } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '42' }, body: { replaceId: 7 } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Cannot delete user because of content relational constraints.' })
  })

  it('returns model errors for admin user delete failures', async () => {
    global.WIKI.models.users.deleteUser.mockRejectedValueOnce(new Error('This user does not exist.'))
    const { delete: deleteHandler } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '42' }, body: { replaceId: 7 } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'This user does not exist.' })
  })

  it('registers the last-logins route before the detail route', async () => {
    await loadHandler()
    const registeredGetPaths = express.__router.get.mock.calls.map(([path]) => path)

    expect(registeredGetPaths.indexOf('/last-logins')).toBeGreaterThanOrEqual(0)
    expect(registeredGetPaths.indexOf('/:id')).toBeGreaterThan(registeredGetPaths.indexOf('/last-logins'))
  })

  it('registers the list route before the detail route', async () => {
    await loadHandler()
    const registeredGetPaths = express.__router.get.mock.calls.map(([path]) => path)

    expect(registeredGetPaths.indexOf('/')).toBeGreaterThanOrEqual(0)
    expect(registeredGetPaths.indexOf('/:id')).toBeGreaterThan(registeredGetPaths.indexOf('/'))
  })

  it('registers admin user action routes before the detail route', async () => {
    await loadHandler()
    const registeredPatchPaths = express.__router.patch.mock.calls.map(([path]) => path)
    const registeredGetPaths = express.__router.get.mock.calls.map(([path]) => path)

    expect(registeredPatchPaths).toEqual(['/profile', '/:id/status', '/:id/verification', '/:id/tfa'])
    expect(registeredGetPaths.indexOf('/:id')).toBeGreaterThan(registeredGetPaths.indexOf('/profile'))
  })

  it('activates admin users through REST status action', async () => {
    const patchBuilder = {
      patch: vi.fn().mockReturnThis(),
      findById: vi.fn().mockResolvedValue(1)
    }
    global.WIKI.models.users.query.mockReturnValueOnce(patchBuilder)
    const { status } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '42' }, body: { isActive: true } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await status(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, ['manage:users', 'manage:system'])
    expect(patchBuilder.patch).toHaveBeenCalledWith({ isActive: true })
    expect(patchBuilder.findById).toHaveBeenCalledWith(42)
    expect(global.WIKI.auth.revokeUserTokens).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'User activated successfully'
    })
  })

  it('deactivates admin users through REST status action and revokes tokens', async () => {
    const patchBuilder = {
      patch: vi.fn().mockReturnThis(),
      findById: vi.fn().mockResolvedValue(1)
    }
    global.WIKI.models.users.query.mockReturnValueOnce(patchBuilder)
    const { status } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '42' }, body: { isActive: false } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await status(req, res, vi.fn())

    expect(patchBuilder.patch).toHaveBeenCalledWith({ isActive: false })
    expect(patchBuilder.findById).toHaveBeenCalledWith(42)
    expect(global.WIKI.auth.revokeUserTokens).toHaveBeenCalledWith({ id: 42, kind: 'u' })
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('addAuthRevoke', { id: 42, kind: 'u' })
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'User deactivated successfully'
    })
  })

  it('rejects protected account deactivation through REST status action', async () => {
    const { status } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '2' }, body: { isActive: false } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await status(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Cannot deactivate system accounts.' })
    expect(global.WIKI.models.users.query).not.toHaveBeenCalled()
  })

  it('verifies admin users through REST verification action', async () => {
    const patchBuilder = {
      patch: vi.fn().mockReturnThis(),
      findById: vi.fn().mockResolvedValue(1)
    }
    global.WIKI.models.users.query.mockReturnValueOnce(patchBuilder)
    const { verification } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '42' }, body: { isVerified: true } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await verification(req, res, vi.fn())

    expect(patchBuilder.patch).toHaveBeenCalledWith({ isVerified: true })
    expect(patchBuilder.findById).toHaveBeenCalledWith(42)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: true,
      message: 'User verified successfully'
    })
  })

  it('toggles admin user 2FA through REST tfa action', async () => {
    const enableBuilder = {
      patch: vi.fn().mockReturnThis(),
      findById: vi.fn().mockResolvedValue(1)
    }
    const disableBuilder = {
      patch: vi.fn().mockReturnThis(),
      findById: vi.fn().mockResolvedValue(1)
    }
    global.WIKI.models.users.query
      .mockReturnValueOnce(enableBuilder)
      .mockReturnValueOnce(disableBuilder)
    const { tfa } = await loadHandler()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await tfa({ user: { permissions: ['manage:users'] }, params: { id: '42' }, body: { enabled: true } }, res, vi.fn())
    await tfa({ user: { permissions: ['manage:users'] }, params: { id: '42' }, body: { enabled: false } }, res, vi.fn())

    expect(enableBuilder.patch).toHaveBeenCalledWith({ tfaIsActive: true, tfaSecret: null })
    expect(disableBuilder.patch).toHaveBeenCalledWith({ tfaIsActive: false, tfaSecret: null })
    expect(res.json).toHaveBeenNthCalledWith(1, {
      succeeded: true,
      message: 'User 2FA enabled successfully'
    })
    expect(res.json).toHaveBeenNthCalledWith(2, {
      succeeded: true,
      message: 'User 2FA disabled successfully'
    })
  })

  it('returns 403 for unauthorized admin user action requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { status } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '42' }, body: { isActive: true } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await status(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:users or manage:system is required' })
    expect(global.WIKI.models.users.query).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed admin user action ids and booleans', async () => {
    const { status, verification } = await loadHandler()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await status({ user: { permissions: ['manage:users'] }, params: { id: '42abc' }, body: { isActive: true } }, res, vi.fn())
    await verification({ user: { permissions: ['manage:users'] }, params: { id: '42' }, body: { isVerified: false } }, res, vi.fn())
    await status({ user: { permissions: ['manage:users'] }, params: { id: '42' }, body: { isActive: 'yes' } }, res, vi.fn())

    expect(res.status).toHaveBeenNthCalledWith(1, 400)
    expect(res.json).toHaveBeenNthCalledWith(1, { error: 'user id must be a positive integer' })
    expect(res.status).toHaveBeenNthCalledWith(2, 400)
    expect(res.json).toHaveBeenNthCalledWith(2, { error: 'isVerified must be true' })
    expect(res.status).toHaveBeenNthCalledWith(3, 400)
    expect(res.json).toHaveBeenNthCalledWith(3, { error: 'isActive must be a boolean' })
  })

  it('forwards unexpected admin user action failures to next', async () => {
    const next = vi.fn()
    global.WIKI.models.users.query.mockReturnValueOnce({
      patch: vi.fn().mockReturnThis(),
      findById: vi.fn().mockRejectedValue(new Error('status db down'))
    })
    const { status } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '42' }, body: { isActive: true } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await status(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('status db down')
  })

  it('returns the paginated admin users list for authorized requests', async () => {
    const countFilterBuilder = {
      where: vi.fn().mockReturnThis(),
      orWhere: vi.fn().mockReturnThis()
    }
    const listFilterBuilder = {
      where: vi.fn().mockReturnThis(),
      orWhere: vi.fn().mockReturnThis()
    }
    const countBuilder = {
      where: vi.fn(callback => {
        callback(countFilterBuilder)
        return countBuilder
      }),
      andWhere: vi.fn().mockReturnThis(),
      count: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ total: '2' })
    }
    const listBuilder = {
      where: vi.fn(callback => {
        callback(listFilterBuilder)
        return listBuilder
      }),
      andWhere: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        {
          id: 42,
          email: 'alice@example.com',
          name: 'Alice',
          providerKey: 'local',
          isSystem: 0,
          isActive: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-03T00:00:00.000Z',
          password: 'hidden'
        },
        {
          id: 77,
          email: 'bob@example.com',
          name: 'Bob',
          providerKey: 'ldap',
          isSystem: 1,
          isActive: 0,
          createdAt: '2026-01-02T00:00:00.000Z',
          lastLoginAt: null,
          tfaSecret: 'hidden'
        }
      ])
    }
    global.WIKI.models.users.query
      .mockReturnValueOnce(countBuilder)
      .mockReturnValueOnce(listBuilder)
    const { list } = await loadHandler()
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
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await list(req, res, vi.fn())

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
          isSystem: true,
          isActive: false,
          createdAt: '2026-01-02T00:00:00.000Z',
          lastLoginAt: null
        }
      ]
    })
  })

  it('uses safe defaults for invalid admin users list query options', async () => {
    const countBuilder = {
      count: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ total: 0 })
    }
    const listBuilder = {
      select: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([])
    }
    global.WIKI.models.users.query
      .mockReturnValueOnce(countBuilder)
      .mockReturnValueOnce(listBuilder)
    const { list } = await loadHandler()
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
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await list(req, res, vi.fn())

    expect(countBuilder.where).toBeUndefined()
    expect(countBuilder.andWhere).toBeUndefined()
    expect(listBuilder.orderBy).toHaveBeenCalledWith('name', 'asc')
    expect(listBuilder.offset).toHaveBeenCalledWith(0)
    expect(listBuilder.limit).toHaveBeenCalledWith(15)
    expect(res.json).toHaveBeenCalledWith({ total: 0, users: [] })
  })

  it('returns 403 for unauthorized admin users list requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { list } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, query: {} }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await list(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:users or manage:system is required' })
    expect(global.WIKI.models.users.query).not.toHaveBeenCalled()
  })

  it('forwards unexpected admin users list failures to next', async () => {
    const next = vi.fn()
    global.WIKI.models.users.query.mockReturnValueOnce({
      count: vi.fn().mockReturnThis(),
      first: vi.fn().mockRejectedValue(new Error('list db down'))
    })
    const { list } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, query: {} }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await list(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('list db down')
  })

  it('returns the minimal admin user search payload for authorized requests', async () => {
    const { search } = await loadHandler()
    const req = { user: { permissions: ['manage:groups'] }, query: { query: 'ali' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await search(req, res, vi.fn())

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
    const { lastLogins } = await loadHandler()
    const req = { user: { permissions: ['write:users'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await lastLogins(req, res, vi.fn())

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
    const { lastLogins } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await lastLogins(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'a dashboard user activity permission is required' })
  })

  it('forwards unexpected dashboard last-logins failures to next', async () => {
    const next = vi.fn()
    global.WIKI.models.users.query.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        whereNotNull: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error('last logins db down'))
          })
        })
      })
    })
    const { lastLogins } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await lastLogins(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('last logins db down')
  })

  it('returns the sanitized admin user detail payload for authorized requests', async () => {
    const { detail } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '42' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await detail(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, ['manage:users', 'manage:system'])
    expect(global.WIKI.models.users.query).toHaveBeenCalled()
    const queryBuilder = global.WIKI.models.users.query.mock.results[0].value
    expect(queryBuilder.findById).toHaveBeenCalledWith(42)
    const user = await queryBuilder.findById.mock.results[0].value
    expect(user.$relatedQuery).toHaveBeenCalledWith('groups')
    expect(user.$relatedQuery.mock.results[0].value.select).toHaveBeenCalledWith('groups.id', 'groups.name')
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
    const { detail } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '42' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await detail(req, res, vi.fn())

    expect(res.json.mock.calls[0][0].providerName).toBe('Unknown')
    expect(res.json.mock.calls[0][0].providerIs2FACapable).toBe(false)
  })

  it('returns 400 for malformed user detail ids', async () => {
    const { detail } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '42abc' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await detail(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'user id must be a positive integer' })
  })

  it('returns 404 when the requested user detail is missing', async () => {
    global.WIKI.models.users.query.mockReturnValueOnce({
      findById: vi.fn().mockResolvedValue(null)
    })
    const { detail } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, params: { id: '999' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await detail(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'user not found' })
  })

  it('returns 403 for unauthorized user detail requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { detail } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '42' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await detail(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:users or manage:system is required' })
  })

  it('forwards unexpected user detail failures to next', async () => {
    const next = vi.fn()
    global.WIKI.models.users.query.mockReturnValueOnce({
      findById: vi.fn().mockRejectedValue(new Error('detail db down'))
    })
    const { detail } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '42' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await detail(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('detail db down')
  })

  it('returns an empty list for short search queries', async () => {
    const { search } = await loadHandler()
    const req = { user: { permissions: ['manage:users'] }, query: { query: ' a ' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await search(req, res, vi.fn())

    expect(global.WIKI.models.users.query).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith([])
  })

  it('returns 403 for unauthorized user search requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { search } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, query: { query: 'ali' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await search(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'a user search admin permission is required' })
  })

  it('forwards unexpected user search failures to next', async () => {
    const next = vi.fn()
    global.WIKI.models.users.query.mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        orWhere: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockRejectedValue(new Error('search db down'))
          })
        })
      })
    })
    const { search } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, query: { query: 'ali' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await search(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('search db down')
  })

  it('returns anonymous state when no authenticated user is present', async () => {
    const { whoami } = await loadHandler()
    const req = {}
    const res = { json: vi.fn() }

    await whoami(req, res)

    expect(res.json).toHaveBeenCalledWith({ authenticated: false, user: null })
  })

  it('returns a safe authenticated user summary', async () => {
    const { whoami } = await loadHandler()
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
    const res = { json: vi.fn() }

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
    const { whoami } = await loadHandler()
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
    const res = { json: vi.fn() }

    await whoami(req, res)

    const payload = res.json.mock.calls[0][0]
    expect(payload.user.password).toBeUndefined()
    expect(payload.user.tfaSecret).toBeUndefined()
    expect(payload.user.providerId).toBeUndefined()
    expect(payload.user.continuationToken).toBeUndefined()
  })
})
