vi.mock('express', () => {
  const routers = []

  const expressMock = {
    Router: () => {
      const router = {
        get: vi.fn(),
        post: vi.fn(),
        put: vi.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }

  return { default: expressMock, ...expressMock }
})

import * as express from 'express'

describe('controllers/api storage endpoints', () => {
  let activeTargets
  let patchWhere
  let patch

  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0

    activeTargets = [
      {
        key: 'git',
        state: {
          status: 'operational',
          message: 'Ready',
          lastAttempt: '2026-05-03T00:00:00.000Z'
        }
      },
      {
        key: 'disk',
        state: {}
      }
    ]
    patchWhere = vi.fn().mockResolvedValue(1)
    patch = vi.fn(() => ({ where: patchWhere }))

    global.WIKI = {
      auth: {
        checkAccess: vi.fn(() => true)
      },
      data: {
        storage: [
          {
            key: 'git',
            title: 'Git',
            description: 'Git storage',
            schedule: 'PT5M',
            actions: [{ handler: 'sync', label: 'Sync', hint: 'Synchronize' }],
            props: {
              repoUrl: { type: 'string', order: 2 },
              credential: { type: 'string', sensitive: true, order: 1 }
            }
          },
          {
            key: 'disk',
            title: 'Disk',
            schedule: false,
            props: {
              path: { type: 'string', order: 1 }
            }
          }
        ]
      },
      models: {
        storage: {
          executeAction: vi.fn().mockResolvedValue(undefined),
          getTargets: vi.fn().mockResolvedValue([
            {
              key: 'git',
              isEnabled: 1,
              mode: 'sync',
              syncInterval: '',
              config: {
                repoUrl: 'https://example.com/repo.git',
                credential: 'stored-value',
                ignored: 'ignored'
              }
            },
            {
              key: 'disk',
              isEnabled: 0,
              mode: 'push',
              syncInterval: '',
              config: {
                path: '/data/repo'
              }
            }
          ]),
          initTargets: vi.fn().mockResolvedValue(undefined),
          query: vi.fn(() => ({
            patch,
            where: vi.fn().mockResolvedValue(activeTargets)
          }))
        }
      }
    }
  })

  const loadRouter = async () => {
    await expect(import('../../controllers/api/storage.ts')).resolves.toBeDefined()
    return express.__routers[0]
  }

  const loadGetHandler = async path => {
    const router = await loadRouter()
    return router.get.mock.calls.find(([route]) => route === path)[1]
  }

  const loadPutHandler = async path => {
    const router = await loadRouter()
    return router.put.mock.calls.find(([route]) => route === path)[1]
  }

  const loadExecuteActionHandler = async () => {
    const router = await loadRouter()
    return router.post.mock.calls.find(([path]) => path === '/actions/execute')[1]
  }

  it('registers the storage REST routes', async () => {
    const router = await loadRouter()

    expect(router.get.mock.calls.map(([path]) => path)).toEqual(['/targets', '/status'])
    expect(router.put.mock.calls.map(([path]) => path)).toEqual(['/targets'])
    expect(typeof await loadExecuteActionHandler()).toBe('function')
  })

  it.each([
    ['targets', async () => await loadGetHandler('/targets'), { body: {} }],
    ['status', async () => await loadGetHandler('/status'), { body: {} }],
    ['save targets', async () => await loadPutHandler('/targets'), { body: { targets: [] } }],
    ['execute action', async () => await loadExecuteActionHandler(), { body: { targetKey: 'disk', handler: 'sync' } }]
  ])('rejects forbidden %s requests with JSON', async (label, getHandler, req) => {
    const handler = await getHandler()
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, ...req }, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({}, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
  })

  it('returns transformed storage targets with sensitive values masked', async () => {
    const handler = await loadGetHandler('/targets')
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: {} }, res)

    expect(global.WIKI.models.storage.getTargets).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    const targets = res.json.mock.calls[0][0]
    expect(targets.map(tgt => tgt.key)).toEqual(['disk', 'git'])
    expect(targets[0]).toMatchObject({
      key: 'disk',
      title: 'Disk',
      hasSchedule: false,
      syncInterval: 'P0D',
      syncIntervalDefault: false
    })
    expect(targets[1]).toMatchObject({
      key: 'git',
      title: 'Git',
      hasSchedule: true,
      syncInterval: 'PT5M',
      syncIntervalDefault: 'PT5M'
    })
    expect(targets[1].config.map(cfg => cfg.key)).toEqual(['credential', 'repoUrl'])
    expect(JSON.parse(targets[1].config[0].value).value).toBe('********')
    expect(targets[1].config.find(cfg => cfg.key === 'ignored')).toBeUndefined()
  })

  it('returns active storage status with GraphQL resolver defaults', async () => {
    const handler = await loadGetHandler('/status')
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: {} }, res)

    expect(global.WIKI.models.storage.query).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith([
      {
        key: 'git',
        title: 'Git',
        status: 'operational',
        message: 'Ready',
        lastAttempt: '2026-05-03T00:00:00.000Z'
      },
      {
        key: 'disk',
        title: 'Disk',
        status: 'pending',
        message: 'Initializing...',
        lastAttempt: null
      }
    ])
  })

  it.each([
    [{}, 'targets must be an array.'],
    [{ targets: {} }, 'targets must be an array.'],
    [{ targets: [{ isEnabled: true, mode: 'sync', config: [] }] }, 'target key is required.'],
    [{ targets: [{ key: 'git', isEnabled: 'yes', mode: 'sync', config: [] }] }, 'target isEnabled must be a boolean.'],
    [{ targets: [{ key: 'git', isEnabled: true, config: [] }] }, 'target mode is required.'],
    [{ targets: [{ key: 'git', isEnabled: true, mode: 'sync', config: {} }] }, 'target config must be an array.']
  ])('rejects invalid targets payload %#', async (body, message) => {
    const handler = await loadPutHandler('/targets')
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body }, res)

    expect(patch).not.toHaveBeenCalled()
    expect(global.WIKI.models.storage.initTargets).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: message })
  })

  it('updates storage targets and preserves masked sensitive config', async () => {
    const handler = await loadPutHandler('/targets')
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({
      user: {},
      body: {
        targets: [
          {
            key: 'git',
            isEnabled: true,
            mode: 'sync',
            syncInterval: 'PT15M',
            config: [
              { key: 'repoUrl', value: JSON.stringify({ v: 'https://example.com/next.git' }) },
              { key: 'credential', value: JSON.stringify({ v: '********' }) }
            ]
          },
          {
            key: 'missing',
            isEnabled: true,
            mode: 'sync',
            syncInterval: 'PT1M',
            config: []
          }
        ]
      }
    }, res)

    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith({
      isEnabled: true,
      mode: 'sync',
      syncInterval: 'PT15M',
      config: {
        repoUrl: 'https://example.com/next.git',
        credential: 'stored-value'
      },
      state: {
        status: 'pending',
        message: 'Initializing...',
        lastAttempt: null
      }
    })
    expect(patchWhere).toHaveBeenCalledWith('key', 'git')
    expect(global.WIKI.models.storage.initTargets).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Storage targets updated successfully' })
  })

  it('returns JSON errors from storage target update failures', async () => {
    const handler = await loadPutHandler('/targets')
    patchWhere.mockRejectedValue(new Error('patch failed'))
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({
      user: {},
      body: {
        targets: [{ key: 'git', isEnabled: true, mode: 'sync', config: [] }]
      }
    }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'patch failed' })
  })

  it.each([
    [{ handler: 'sync' }, 'targetKey is required.'],
    [{ targetKey: '', handler: 'sync' }, 'targetKey is required.'],
    [{ targetKey: 'disk' }, 'handler is required.'],
    [{ targetKey: 'disk', handler: '' }, 'handler is required.'],
    [{ targetKey: 7, handler: 'sync' }, 'targetKey is required.'],
    [{ targetKey: 'disk', handler: false }, 'handler is required.']
  ])('rejects invalid execute action payload %#', async (body, message) => {
    const handler = await loadExecuteActionHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body }, res)

    expect(global.WIKI.models.storage.executeAction).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: message })
  })

  it('executes a storage action and returns JSON success', async () => {
    const handler = await loadExecuteActionHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { targetKey: 'git', handler: 'sync' } }, res)

    expect(global.WIKI.models.storage.executeAction).toHaveBeenCalledWith('git', 'sync')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Action completed.' })
  })

  it('returns JSON errors from storage action failures', async () => {
    const handler = await loadExecuteActionHandler()
    global.WIKI.models.storage.executeAction.mockRejectedValue(new Error('Invalid Handler for Storage Target'))
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { targetKey: 'git', handler: 'missing' } }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid Handler for Storage Target' })
  })
})
