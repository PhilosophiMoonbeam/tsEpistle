import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_controller_index_test', import.meta.path)

if (!connection) {
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
    await vi.importFresh('../../controllers/api/index.ts', import.meta.url)
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
} else {
  const { default: knex } = await import('knex')
  const { default: express } = await import('express')
  const { fileURLToPath } = await import('node:url')
  const { configureTransportRuntime } = await import('../../controllers/_types.ts')
  const originalWiki = global.WIKI
  const db = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } })
  const wiki = {
    SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)),
    config: { lang: { code: 'en' }, sessionSecret: 'controller-index-review-key' },
    models: { knex: db },
    data: {},
    cache: { get: async () => [] },
    auth: { checkAccess: () => false },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
  }
  global.WIKI = wiki
  let server, baseUrl

  describe('actual mounted API shell on PostgreSQL', () => {
    beforeAll(async () => {
      const { default: migrations } = await import('../../db/migrator-source.ts')
      await db.migrate.latest({ migrationSource: migrations })
      await db('settings').insert({ key: 'auth', value: '{"passwordMinLength":20}', updatedAt: new Date().toISOString() }).onConflict('key').merge()
      const { default: locales } = await import('../../models/locales.ts')
      wiki.models.locales = locales.bindKnex(db)
      configureTransportRuntime(wiki)
      const router = (await import('../../controllers/api/index.ts')).default
      const app = express()
      app.use(express.json())
      app.use('/_api', router)
      server = app.listen(0, '127.0.0.1')
      await new Promise(resolve => server.once('listening', resolve))
      baseUrl = `http://127.0.0.1:${server.address().port}`
    }, 60_000)

    afterAll(async () => {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await db.destroy()
      configureTransportRuntime({})
      global.WIKI = originalWiki
    })

    it('reaches the selected protected APIs through their actual handlers rather than the shell fallback', async () => {
      for (const [method, path] of [
        ['GET', '/assets'],
        ['GET', '/system/workspace'],
        ['GET', '/analytics/workspace'],
        ['GET', '/search/index-status'],
        ['GET', '/theming/workspace'],
        ['GET', '/logging/workspace'],
        ['GET', '/navigation/workspace'],
        ['GET', '/mail/workspace'],
        ['GET', '/storage/workspace'],
        ['GET', '/site/config'],
        ['GET', '/rendering/renderers'],
        ['GET', '/comments/providers'],
        ['PATCH', '/content-extensions/index'],
        ['GET', '/locales/workspace'],
        ['GET', '/groups/workspace'],
        ['GET', '/users/workspace'],
        ['GET', '/pages']
      ]) {
        const response = await fetch(`${baseUrl}/_api${path}`, { method })
        expect(response.status).toBe(403)
        await response.text()
      }
      const passwordPolicy = await fetch(`${baseUrl}/_api/auth/password-policy`)
      expect(passwordPolicy.status).toBe(200)
      expect(passwordPolicy.headers.get('cache-control')).toBe('no-store')
      expect(await passwordPolicy.json()).toEqual({ minimum: 20, maximumBytes: 72 })
    })

    it('returns the real JSON 404 for an unknown API route', async () => {
      const response = await fetch(`${baseUrl}/_api/unknown-controller-route`)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'Not Found' })
    })

    it('bounds a real database failure at the mounted shell without leaking query detail', async () => {
      await db.schema.renameTable('locales', 'controller_unavailable_locales')
      try {
        const response = await fetch(`${baseUrl}/_api/locales`)
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ error: 'Internal Server Error' })
        expect(wiki.logger.error.mock.calls.at(-1)[0]).toBeInstanceOf(Error)
      } finally {
        await db.schema.renameTable('controller_unavailable_locales', 'locales')
      }
    })
  })
}
