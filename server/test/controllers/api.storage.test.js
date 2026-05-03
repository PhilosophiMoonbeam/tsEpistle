jest.mock('express', () => {
  const routers = []

  return {
    Router: () => {
      const router = {
        post: jest.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }
})

describe('controllers/api storage endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: jest.fn(() => true)
      },
      models: {
        storage: {
          executeAction: jest.fn().mockResolvedValue(undefined)
        }
      }
    }
  })

  const loadRouter = () => {
    const express = require('express')
    expect(() => require('../../controllers/api/storage')).not.toThrow()
    return express.__routers[0]
  }

  const loadExecuteActionHandler = () => {
    const router = loadRouter()
    return router.post.mock.calls.find(([path]) => path === '/actions/execute')[1]
  }

  it('registers the execute action route', () => {
    expect(typeof loadExecuteActionHandler()).toBe('function')
  })

  it('rejects forbidden execute action requests with JSON', async () => {
    const handler = loadExecuteActionHandler()
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await handler({ user: {}, body: { targetKey: 'disk', handler: 'sync' } }, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({}, ['manage:system'])
    expect(global.WIKI.models.storage.executeAction).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
  })

  it.each([
    [{ handler: 'sync' }, 'targetKey is required.'],
    [{ targetKey: '', handler: 'sync' }, 'targetKey is required.'],
    [{ targetKey: 'disk' }, 'handler is required.'],
    [{ targetKey: 'disk', handler: '' }, 'handler is required.'],
    [{ targetKey: 7, handler: 'sync' }, 'targetKey is required.'],
    [{ targetKey: 'disk', handler: false }, 'handler is required.']
  ])('rejects invalid execute action payload %#', async (body, message) => {
    const handler = loadExecuteActionHandler()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await handler({ user: {}, body }, res)

    expect(global.WIKI.models.storage.executeAction).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: message })
  })

  it('executes a storage action and returns JSON success', async () => {
    const handler = loadExecuteActionHandler()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await handler({ user: {}, body: { targetKey: 'git', handler: 'sync' } }, res)

    expect(global.WIKI.models.storage.executeAction).toHaveBeenCalledWith('git', 'sync')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Action completed.' })
  })

  it('returns JSON errors from storage action failures', async () => {
    const handler = loadExecuteActionHandler()
    global.WIKI.models.storage.executeAction.mockRejectedValue(new Error('Invalid Handler for Storage Target'))
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await handler({ user: {}, body: { targetKey: 'git', handler: 'missing' } }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid Handler for Storage Target' })
  })
})
