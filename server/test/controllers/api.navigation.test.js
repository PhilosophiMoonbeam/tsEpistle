vi.mock('express', () => {
  const routers = []
  const express = {
    Router: () => {
      const router = {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        use: vi.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }

  return { default: express, ...express }
})

import express from 'express'

const API_CONTROLLER_NAMES = [
  'analytics',
  'assets',
  'auth',
  'comments',
  'contribute',
  'groups',
  'locales',
  'logging',
  'mail',
  'navigation',
  'pages',
  'rendering',
  'search',
  'site',
  'storage',
  'system',
  'theming',
  'users'
]

const loadApiIndexRouter = async () => {
  const subrouters = Object.fromEntries(API_CONTROLLER_NAMES.map(name => [name, {}]))

  for (const name of API_CONTROLLER_NAMES) {
    vi.doMock(`../../controllers/api/${name}.ts`, () => ({
      default: subrouters[name]
    }))
  }

  try {
    await expect(import('../../controllers/api/index.ts')).resolves.toBeDefined()
  } finally {
    for (const name of API_CONTROLLER_NAMES) {
      vi.doUnmock(`../../controllers/api/${name}.ts`)
    }
  }

  return { apiRouter: express.__routers.at(-1), subrouters }
}

describe('controllers/api navigation endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: vi.fn()
      },
      models: {
        navigation: {
          getTree: vi.fn().mockResolvedValue([
            { locale: 'en', ignored: true, items: [{ id: 'home', kind: 'link', label: 'Home', ignored: true }] }
          ]),
          query: vi.fn(() => ({
            patch: vi.fn(() => ({
              where: vi.fn().mockResolvedValue(1)
            }))
          }))
        }
      },
      cache: {
        set: vi.fn().mockResolvedValue(true)
      },
      config: {
        nav: {
          mode: 'TREE',
          ignored: true
        }
      },
      configSvc: {
        saveToDb: vi.fn().mockResolvedValue(true)
      }
    }
  })

  const loadRouter = async () => {
    await import('../../controllers/api/navigation.ts')
    return express.__routers[0]
  }

  const loadHandler = async () => (await loadRouter()).get.mock.calls.find(([path]) => path === '/')[1]
  const saveHandler = async () => (await loadRouter()).put.mock.calls.find(([path]) => path === '/')[1]

  const validBody = () => ({
    tree: [
      {
        locale: 'en',
        items: [
          { id: 'home', kind: 'link', label: 'Home', targetType: 'home', target: '/', visibilityGroups: [1] }
        ]
      },
      {
        locale: 'fr',
        items: []
      }
    ],
    mode: 'MIXED'
  })

  it('registers the navigation load route', async () => { expect(typeof await loadHandler()).toBe('function') })

  it('returns 403 for unauthorized navigation loads', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadHandler()
    const req = { user: { permissions: [] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:navigation or manage:system is required' })
    expect(global.WIKI.models.navigation.getTree).not.toHaveBeenCalled()
  })

  it('loads navigation config and tree with GraphQL-compatible bypass-auth semantics', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadHandler()
    const req = { user: { permissions: ['manage:navigation'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.models.navigation.getTree).toHaveBeenCalledWith({ cache: false, locale: 'all', bypassAuth: true })
    expect(res.json).toHaveBeenCalledWith({
      config: { mode: 'TREE' },
      tree: [{
        locale: 'en',
        items: [{
          id: 'home',
          kind: 'link',
          label: 'Home',
          icon: undefined,
          targetType: undefined,
          target: undefined,
          visibilityMode: undefined,
          visibilityGroups: undefined
        }]
      }]
    })
  })

  it('forwards navigation load failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.navigation.getTree.mockRejectedValueOnce(new Error('navigation tree failed'))
    const next = vi.fn()
    const handler = await loadHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('navigation tree failed')
  })

  it('registers the navigation save route', async () => { expect(typeof await saveHandler()).toBe('function') })

  it('is mounted by the API index router', async () => {
    const { apiRouter, subrouters } = await loadApiIndexRouter()

    expect(apiRouter.use).toHaveBeenCalledWith('/navigation', subrouters.navigation)
  })

  it('returns 403 for unauthorized navigation saves', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await saveHandler()
    const req = { user: { permissions: [] }, body: validBody() }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:navigation or manage:system is required' })
    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(global.WIKI.models.navigation.query).not.toHaveBeenCalled()
    expect(global.WIKI.cache.set).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
  })

  it.each([
    ['missing tree', { mode: 'TREE' }],
    ['non-array tree', { tree: {}, mode: 'TREE' }],
    ['missing locale', { tree: [{ items: [] }], mode: 'TREE' }],
    ['empty locale', { tree: [{ locale: '', items: [] }], mode: 'TREE' }],
    ['non-array items', { tree: [{ locale: 'en', items: {} }], mode: 'TREE' }],
    ['item missing id', { tree: [{ locale: 'en', items: [{ kind: 'link' }] }], mode: 'TREE' }],
    ['item missing kind', { tree: [{ locale: 'en', items: [{ id: 'home' }] }], mode: 'TREE' }],
    ['item non-string optional field', { tree: [{ locale: 'en', items: [{ id: 'home', kind: 'link', label: 42 }] }], mode: 'TREE' }],
    ['item non-integer visibility group', { tree: [{ locale: 'en', items: [{ id: 'home', kind: 'link', visibilityGroups: [1, '2'] }] }], mode: 'TREE' }]
  ])('returns 400 for malformed navigation tree payloads: %s', async (label, body) => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await saveHandler()
    const req = { user: { permissions: ['manage:navigation'] }, body }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'tree must be an array of locale navigation trees with valid navigation items' })
    expect(global.WIKI.models.navigation.query).not.toHaveBeenCalled()
  })

  it.each(['', 'INVALID', 'tree', null, undefined])('returns 400 for invalid navigation mode %p', async (mode) => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await saveHandler()
    const req = { user: { permissions: ['manage:navigation'] }, body: { tree: [], mode } }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'mode must be a valid navigation mode' })
    expect(global.WIKI.models.navigation.query).not.toHaveBeenCalled()
  })

  it('saves navigation tree, refreshes sidebar cache per locale, persists mode, and returns JSON success', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await saveHandler()
    const body = validBody()
    const req = { user: { permissions: ['manage:navigation'] }, body }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res)

    const query = global.WIKI.models.navigation.query.mock.results[0].value
    const patch = query.patch
    const where = patch.mock.results[0].value.where
    expect(patch).toHaveBeenCalledWith({ config: body.tree })
    expect(where).toHaveBeenCalledWith('key', 'site')
    expect(global.WIKI.cache.set).toHaveBeenNthCalledWith(1, 'nav:sidebar:en', body.tree[0].items, 300)
    expect(global.WIKI.cache.set).toHaveBeenNthCalledWith(2, 'nav:sidebar:fr', body.tree[1].items, 300)
    expect(global.WIKI.config.nav).toEqual({ mode: 'MIXED' })
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['nav'])
    expect(res.json).toHaveBeenCalledWith({ message: 'Navigation saved successfully.' })
  })

  it('returns JSON errors for navigation save failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.navigation.query.mockImplementationOnce(() => ({
      patch: vi.fn(() => ({
        where: vi.fn().mockRejectedValue(new Error('navigation patch failed'))
      }))
    }))
    const handler = await saveHandler()
    const req = { user: { permissions: ['manage:navigation'] }, body: validBody() }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'navigation patch failed' })
  })
})
