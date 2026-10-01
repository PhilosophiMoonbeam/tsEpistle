const realExpress = (await import('express')).default

const writeLegacy = vi.fn().mockResolvedValue({})
const routers = []
vi.mockModule('../../operations/rendering-workspace.ts', import.meta.url, () => ({ writeLegacyRenderingSettings: writeLegacy, readRenderingWorkspace: vi.fn(), writeRenderingWorkspace: vi.fn(), inspectRenderingOutput: vi.fn() }))
const recordedExpress = {
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
  }
}
vi.mockModule('express', import.meta.url, () => ({ default: recordedExpress, ...recordedExpress }))


describe('controllers/api rendering endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    writeLegacy.mockReset().mockResolvedValue({})
    routers.length = 0

    global.WIKI = {
      logger: { warn: vi.fn() },
      auth: {
        checkAccess: vi.fn()
      },
      data: {
        renderers: [
          {
            key: 'markdownCore',
            title: 'Markdown Core',
            description: 'Core markdown renderer.',
            icon: 'mdi-language-markdown',
            input: 'markdown',
            output: 'html',
            props: {
              safeMode: {
                type: 'boolean',
                title: 'Safe Mode',
                order: 1,
                hint: 'Enable benign safety behavior'
              },
              flavor: {
                type: 'string',
                title: 'Flavor',
                order: 2
              }
            },
            unrelatedMetadata: 'do-not-return'
          },
          {
            key: 'emojiRenderer',
            title: 'Emoji Renderer',
            description: 'Adds emoji rendering.',
            icon: 'mdi-emoticon-outline',
            dependsOn: 'markdownCore',
            props: {}
          }
        ]
      },
      models: {
        renderers: {
          getRenderers: vi.fn().mockResolvedValue([
            {
              key: 'markdownCore',
              isEnabled: 1,
              config: {
                flavor: 'commonmark',
                safeMode: true,
                internalNote: 'do-not-return'
              },
              privateField: 'do-not-return',
              props: {
                raw: true
              }
            },
            {
              key: 'emojiRenderer',
              isEnabled: 0,
              config: {},
              privateField: 'do-not-return'
            }
          ])
        }
      }
    }
  })

  const loadRenderersHandler = async () => {
    await vi.importFresh('../../controllers/api/rendering.ts', import.meta.url)
    const router = routers[0]
    return router.get.mock.calls.find(([path]) => path === '/renderers')[1]
  }

  const loadSaveRenderersHandler = async () => {
    await vi.importFresh('../../controllers/api/rendering.ts', import.meta.url)
    const router = routers[0]
    return router.post.mock.calls.find(([path]) => path === '/renderers')[1]
  }

  it('returns 403 for unauthorized renderer requests without querying renderers', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadRenderersHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.renderers.getRenderers).not.toHaveBeenCalled()
  })

  it('returns allowlisted renderer fields without raw props or internal fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadRenderersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

    expect(global.WIKI.models.renderers.getRenderers).toHaveBeenCalledWith()
    expect(res.json).toHaveBeenCalledWith([
      {
        isEnabled: true,
        key: 'markdownCore',
        title: 'Markdown Core',
        description: 'Core markdown renderer.',
        icon: 'mdi-language-markdown',
        dependsOn: null,
        input: 'markdown',
        output: 'html',
        config: expect.any(Array)
      },
      {
        isEnabled: false,
        key: 'emojiRenderer',
        title: 'Emoji Renderer',
        description: 'Adds emoji rendering.',
        icon: 'mdi-emoticon-outline',
        dependsOn: 'markdownCore',
        input: null,
        output: null,
        config: []
      }
    ])
    const row = res.json.mock.calls[0][0][0]
    expect(row).not.toHaveProperty('props')
    expect(row).not.toHaveProperty('privateField')
    expect(row).not.toHaveProperty('unrelatedMetadata')
    expect(row).not.toHaveProperty('internalNote')
  })

  it('reads renderer definitions after the operation module is loaded', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadRenderersHandler()
    global.WIKI.data.renderers = global.WIKI.data.renderers.map(renderer => ({
      ...renderer,
      title: `Runtime ${renderer.key}`
    }))
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

    expect(res.json.mock.calls[0][0][0].title).toBe('Runtime markdownCore')
  })

  it('merges config with renderer metadata as JSON strings and omits unknown config keys', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadRenderersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

    const config = res.json.mock.calls[0][0][0].config
    expect(config.map(row => row.key).sort()).toEqual(['flavor', 'safeMode'])
    for (const row of config) expect(typeof row.value).toBe('string')
    expect(Object.fromEntries(config.map(row => [row.key, JSON.parse(row.value)]))).toEqual({
      flavor: {
        type: 'string',
        title: 'Flavor',
        order: 2,
        value: 'commonmark'
      },
      safeMode: {
        type: 'boolean',
        title: 'Safe Mode',
        order: 1,
        hint: 'Enable benign safety behavior',
        value: true
      }
    })
  })

  it('returns JSON 403 for unauthorized renderer save requests without writing settings', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadSaveRenderersHandler()
    const req = { user: { permissions: [] }, body: { renderers: [] } }
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), sendStatus: vi.fn() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(writeLegacy).not.toHaveBeenCalled()
  })

  it('decodes renderer configuration before writing enabled and disabled settings', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSaveRenderersHandler()
    const req = {
      user: { permissions: ['manage:system'] },
      body: {
        renderers: [
          {
            key: 'markdownCore',
            isEnabled: true,
            config: [
              { key: 'safeMode', value: JSON.stringify({ v: false }) },
              { key: 'flavor', value: JSON.stringify({ v: 'commonmark' }) },
              { key: 'missingValue', value: JSON.stringify({ raw: true }) }
            ]
          },
          {
            key: 'emojiRenderer',
            isEnabled: false,
            config: []
          }
        ]
      }
    }
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), sendStatus: vi.fn() }

    await handler(req, res, vi.fn())

    expect(writeLegacy).toHaveBeenCalledWith([
      { key: 'markdownCore', isEnabled: true, config: { safeMode: false, flavor: 'commonmark', missingValue: null } },
      { key: 'emojiRenderer', isEnabled: false, config: {} }
    ])
    expect(res.json).toHaveBeenCalledWith({ message: expect.any(String) })
    expect(res.json.mock.calls[0][0].message.length).toBeGreaterThan(0)
  })

  it('rejects invalid renderer save payloads before writing settings', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSaveRenderersHandler()
    const req = { user: {}, body: { renderers: [{ key: 'markdownCore', isEnabled: 'yes', config: [] }] } }
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), sendStatus: vi.fn() }

    await handler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid renderers payload' })
    expect(writeLegacy).not.toHaveBeenCalled()
  })

  it('rejects malformed renderer config JSON during save', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSaveRenderersHandler()
    const req = { user: {}, body: { renderers: [{ key: 'markdownCore', isEnabled: true, config: [{ key: 'safeMode', value: '{bad' }] }] } }
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), sendStatus: vi.fn() }

    await handler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid renderers payload' })
    expect(writeLegacy).not.toHaveBeenCalled()
  })

  it('returns JSON errors when renderer save fails unexpectedly', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    writeLegacy.mockRejectedValue(new Error('database unavailable'))
    const handler = await loadSaveRenderersHandler()
    const req = { user: {}, body: { renderers: [{ key: 'markdownCore', isEnabled: true, config: [] }] } }
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), sendStatus: vi.fn() }

    await handler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Rendering request failed. Try again or check server logs.' })
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('rendering failed')
    global.WIKI.models.renderers.getRenderers.mockRejectedValue(err)
    const handler = await loadRenderersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }
    const next = vi.fn()

    await handler({ user: {} }, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })
  it('denies unauthorized renderer requests through the API index over HTTP', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const indexUrl = new URL('../../controllers/api/index.ts', import.meta.url)
    const imports = new Bun.Transpiler({ loader: 'ts' }).scan(await Bun.file(indexUrl).text()).imports
    for (const { path } of imports) {
      if (path.startsWith('./') && path !== './rendering.ts') {
        vi.mockModule(new URL(path, indexUrl).href, import.meta.url, () => ({ default: realExpress.Router() }))
      }
    }
    vi.mockModule('express', import.meta.url, () => ({ default: realExpress, ...realExpress }))
    let server
    try {
      const { default: apiRouter } = await vi.importFresh('../../controllers/api/index.ts', import.meta.url)
      const user = { permissions: [] }
      const app = realExpress()
      app.use((req, _res, next) => { req.user = user; next() })
      app.use('/_api', apiRouter)
      server = app.listen(0, '127.0.0.1')
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Rendering test server did not bind a TCP port')
      const denied = await fetch(`http://127.0.0.1:${address.port}/_api/rendering/renderers`)
      expect(denied.status).toBe(403)
      expect(denied.headers.get('cache-control')).toBe('private, no-store')
      expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(user, ['manage:system'])
      expect(global.WIKI.models.renderers.getRenderers).not.toHaveBeenCalled()
    } finally {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      vi.mockModule('express', import.meta.url, () => ({ default: recordedExpress, ...recordedExpress }))
    }
  })
  it('is mounted by the API index router', async () => {
    const modulePaths = [
      '../../controllers/api/analytics.ts',
      '../../controllers/api/assets.ts',
      '../../controllers/api/auth.ts',
      '../../controllers/api/comments.ts',
      '../../controllers/api/content-extensions.ts',
      '../../controllers/api/groups.ts',
      '../../controllers/api/locales.ts',
      '../../controllers/api/logging.ts',
      '../../controllers/api/mail.ts',
      '../../controllers/api/navigation.ts',
      '../../controllers/api/pages.ts',
      '../../controllers/api/rendering.ts',
      '../../controllers/api/search.ts',
      '../../controllers/api/site.ts',
      '../../controllers/api/storage.ts',
      '../../controllers/api/system.ts',
      '../../controllers/api/theming.ts',
      '../../controllers/api/users.ts',
      '../../controllers/api/webhooks.ts'
    ]
    for (const modulePath of modulePaths) {
      vi.mockModule(modulePath, import.meta.url, () => ({ default: {} }))
    }

    try {
      expect(await vi.importFresh('../../controllers/api/index.ts', import.meta.url)).toBeDefined()
      const apiRouter = routers.find(router =>
        router.use.mock.calls.some(([path]) => path === '/rendering')
      )

      expect(apiRouter).toBeDefined()

      expect(apiRouter.use).toHaveBeenCalledWith('/rendering', expect.any(Object))
    } finally {
      for (const modulePath of modulePaths) {
        vi.unmockModule(modulePath, import.meta.url)
      }
    }
  })
})
