import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_controller_index_test', import.meta.path)

if (!connection) {
  const { default: express } = await import('express')
  const originalWiki = global.WIKI
  const indexUrl = new URL('../../controllers/api/index.ts', import.meta.url)
  const imports = new Bun.Transpiler({ loader: 'ts' }).scan(await Bun.file(indexUrl).text()).imports
  const subrouterUrls = imports.filter(({ path }) => path.startsWith('./')).map(({ path }) => new URL(path, indexUrl).href)
  const failure = new Error('private-database-connection')
  let server, baseUrl

  describe('controllers/api route shell over HTTP', () => {
    beforeEach(async () => {
      global.WIKI = { logger: { error: vi.fn() } }
      for (const url of subrouterUrls) {
        const subrouter = express.Router()
        if (url === new URL('./assets.ts', indexUrl).href) {
          subrouter.get('/shell-failure', () => { throw failure })
        }
        vi.mockModule(url, import.meta.url, () => ({ default: subrouter }))
      }
      const { default: router } = await vi.importFresh('../../controllers/api/index.ts', import.meta.url)
      const app = express()
      app.use(express.json())
      app.use('/_api', router)
      server = app.listen(0, '127.0.0.1')
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('API shell test server did not bind a TCP port')
      baseUrl = `http://127.0.0.1:${address.port}/_api`
    })

    afterEach(async () => {
      try {
        if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      } finally {
        server = undefined
        for (const url of subrouterUrls) vi.unmockModule(url, import.meta.url)
        global.WIKI = originalWiki
      }
    })

    it('returns a JSON 404 for an unknown mounted API route', async () => {
      const response = await fetch(`${baseUrl}/unknown-controller-route`)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({ error: 'Not Found' })
      expect(global.WIKI.logger.error).not.toHaveBeenCalled()
    })

    it('bounds a mounted subrouter failure with a generic JSON 500 and logs its private detail', async () => {
      const response = await fetch(`${baseUrl}/assets/shell-failure`)
      expect(response.status).toBe(500)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({ error: 'Internal Server Error' })
      expect(global.WIKI.logger.error).toHaveBeenCalledWith(failure)
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
