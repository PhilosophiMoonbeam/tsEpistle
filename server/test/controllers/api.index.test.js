vi.mockModule('express', import.meta.url, () => {
  const routers = []
  const express = {
    Router: () => {
      const router = {
        delete: vi.fn(),
        get: vi.fn(),
        patch: vi.fn(),
        post: vi.fn(),
        put: vi.fn(),
        use: vi.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }

  return { default: express, ...express }
})

const { default: express } = await import('express')

const API_MOUNTS = [
  ['assets', '/assets'],
  ['system', '/system'],
  ['analytics', '/analytics'],
  ['search', '/search'],
  ['theming', '/theming'],
  ['logging', '/logging'],
  ['navigation', '/navigation'],
  ['mail', '/mail'],
  ['storage', '/storage'],
  ['site', '/site'],
  ['rendering', '/rendering'],
  ['comments', '/comments'],
  ['contribute', '/contribute'],
  ['content-extensions', '/content-extensions'],
  ['locales', '/locales'],
  ['groups', '/groups'],
  ['users', '/users'],
  ['pages', '/pages'],
  ['auth', '/auth']
]

const loadRouter = async () => {
  const subrouters = Object.fromEntries(API_MOUNTS.map(([name]) => [name, {}]))

  for (const [name] of API_MOUNTS) {
    vi.mockModule(`../../controllers/api/${name}.ts`, import.meta.url, () => ({
      default: subrouters[name]
    }))
  }

  try {
    expect(await vi.importFresh('../../controllers/api/index.ts', import.meta.url)).toBeDefined()
  } finally {
    for (const [name] of API_MOUNTS) {
      vi.unmockModule(`../../controllers/api/${name}.ts`, import.meta.url)
    }
  }

  return {
    router: express.__routers.at(-1),
    subrouters
  }
}

describe('controllers/api route shell', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0
    global.WIKI = { logger: { error: vi.fn() } }
  })

  it('mounts every API subrouter', async () => {
    const { router, subrouters } = await loadRouter()

    for (const [name, path] of API_MOUNTS) {
      expect(router.use).toHaveBeenCalledWith(path, subrouters[name])
    }
  })

  it('returns a JSON 404 for unknown API routes', async () => {
    const { router } = await loadRouter()
    const notFoundHandler = router.use.mock.calls.find(
      ([handler]) => typeof handler === 'function' && handler.length === 2
    )[0]
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    notFoundHandler({}, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'Not Found' })
  })

  it('returns a generic JSON 500 for unexpected API failures', async () => {
    const { router } = await loadRouter()
    const errorHandler = router.use.mock.calls.find(
      ([handler]) => typeof handler === 'function' && handler.length === 4
    )[0]
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const err = new Error('boom')

    errorHandler(err, {}, res, vi.fn())
    expect(global.WIKI.logger.error).toHaveBeenCalledWith(err)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' })
  })
})
