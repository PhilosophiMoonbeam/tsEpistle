vi.mockModule('express', import.meta.url, () => {
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

const express = await import('express')

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
            isAvailable: true,
            supportedModes: ['sync', 'push'],
            actions: [{ handler: 'sync', label: 'Sync', hint: 'Synchronize' }],
            props: {
              authType: { type: 'string', enum: ['ssh', 'basic'], order: 3 },
              repoUrl: { type: 'string', order: 2 },
              credential: { type: 'string', sensitive: true, order: 1 }
            }
          },
          {
            key: 'disk',
            title: 'Disk',
            schedule: false,
            isAvailable: true,
            supportedModes: ['push'],
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
    expect(await vi.importFresh('../../controllers/api/storage.ts', import.meta.url)).toBeDefined()
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

  it('reads storage definitions after the operation module is loaded', async () => {
    const handler = await loadGetHandler('/targets')
    global.WIKI.data.storage = global.WIKI.data.storage.map(target => ({
      ...target,
      title: `Runtime ${target.key}`
    }))
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: {} }, res)

    expect(res.json.mock.calls[0][0].map(target => target.title)).toEqual(['Runtime disk', 'Runtime git'])
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
        lastAttempt: '2026-05-03T00:00:00.000Z',
        lastOperation: null
      },
      {
        key: 'disk',
        title: 'Disk',
        status: 'pending',
        message: 'Initializing...',
        lastAttempt: null,
        lastOperation: null
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

  it.each([
    [
      [{ key: 'missing', isEnabled: true, mode: 'sync', syncInterval: 'PT1M', config: [] }],
      'Storage target missing does not exist.'
    ],
    [
      [{ key: 'git', isEnabled: true, mode: 'pull', syncInterval: 'PT1M', config: [] }],
      'Storage target git does not support mode pull.'
    ],
    [
      [{ key: 'git', isEnabled: true, mode: 'sync', syncInterval: 'soon', config: [] }],
      'target syncInterval must be a valid ISO 8601 duration.'
    ],
    [
      [{ key: 'git', isEnabled: true, mode: 'sync', syncInterval: 'PT1M', config: [{ key: 'unknown', value: JSON.stringify({ v: 'x' }) }] }],
      'target git config must contain unique, known entries.'
    ],
    [
      [{
        key: 'git',
        isEnabled: true,
        mode: 'sync',
        syncInterval: 'PT1M',
        config: [
          { key: 'repoUrl', value: JSON.stringify({ v: 'first' }) },
          { key: 'repoUrl', value: JSON.stringify({ v: 'second' }) }
        ]
      }],
      'target git config must contain unique, known entries.'
    ],
    [
      [{ key: 'git', isEnabled: true, mode: 'sync', syncInterval: 'PT1M', config: [{ key: 'repoUrl', value: JSON.stringify({ v: false }) }] }],
      'target git config value repoUrl has an invalid type.'
    ],
    [
      [{ key: 'git', isEnabled: true, mode: 'sync', syncInterval: 'PT1M', config: [{ key: 'authType', value: JSON.stringify({ v: 'token' }) }] }],
      'target git config value authType is not allowed.'
    ]
  ])('rejects invalid target semantics %# before mutation', async (targets, message) => {
    const handler = await loadPutHandler('/targets')
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { targets } }, res)

    expect(patch).not.toHaveBeenCalled()
    expect(global.WIKI.models.storage.initTargets).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: message })
  })

  it('validates every target before writing any target', async () => {
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
            config: [{ key: 'repoUrl', value: JSON.stringify({ v: 'https://example.com/next.git' }) }]
          },
          {
            key: 'disk',
            isEnabled: true,
            mode: 'push',
            syncInterval: 'P0D',
            config: [{ key: 'unknown', value: JSON.stringify({ v: '/tmp' }) }]
          }
        ]
      }
    }, res)

    expect(patch).not.toHaveBeenCalled()
    expect(global.WIKI.models.storage.initTargets).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
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

  it('executes a storage action and returns its JSON summary', async () => {
    const summary = {
      targetKey: 'git',
      handler: 'sync',
      outcome: 'succeeded',
      total: 1,
      succeeded: 1,
      failed: 0,
      formats: {
        okf: 1,
        legacyV1: 0,
        legacyWiki: 0,
        plain: 0,
        invalid: 0
      },
      items: [{
        kind: 'page',
        path: 'docs/storage',
        outcome: 'succeeded',
        format: 'okf',
        message: null,
        diagnostics: []
      }],
      startedAt: '2026-08-31T10:00:00.000Z',
      completedAt: '2026-08-31T10:00:01.000Z',
      message: 'Action completed.'
    }
    global.WIKI.models.storage.executeAction.mockResolvedValueOnce(summary)
    const handler = await loadExecuteActionHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { targetKey: 'git', handler: 'sync' } }, res)

    expect(global.WIKI.models.storage.executeAction).toHaveBeenCalledWith('git', 'sync')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(summary)
  })

  it('rejects undeclared storage actions before runtime dispatch', async () => {
    const handler = await loadExecuteActionHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { targetKey: 'git', handler: 'missing' } }, res)

    expect(global.WIKI.models.storage.executeAction).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Storage target git does not declare action missing.' })
  })
})
