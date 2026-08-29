vi.mockModule('express', import.meta.url, () => {
  const router = {
    get: vi.fn(),
    post: vi.fn(),
    use: vi.fn()
  }
  const express = {
    Router: () => router,
    __router: router
  }

  return { default: express, ...express }
})

const { default: express } = await import('express')

describe('controllers/api locales endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__router.get.mockClear()
    express.__router.post.mockClear()

    global.WIKI = {
      auth: {
        checkAccess: vi.fn().mockReturnValue(true)
      },
      cache: {
        get: vi.fn().mockResolvedValue(null),
        del: vi.fn().mockResolvedValue()
      },
      config: {
        lang: {
          code: 'en',
          autoUpdate: true,
          namespacing: false,
          namespaces: ['en', 'fr']
        }
      },
      models: {
        locales: {
          query: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue({ isRTL: true }),
            then: resolve => Promise.resolve([
              {
                code: 'en',
                isRTL: false,
                name: 'English',
                nativeName: 'English',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                availability: 100
              }
            ]).then(resolve)
          })
        }
      },
      configSvc: {
        saveToDb: vi.fn().mockResolvedValue()
      },
      scheduler: {
        registerJob: vi.fn().mockResolvedValue({
          finished: Promise.resolve()
        })
      },
      lang: {
        setCurrentLocale: vi.fn().mockResolvedValue(),
        refreshNamespaces: vi.fn().mockResolvedValue(),
        getByNamespace: vi.fn().mockResolvedValue([
          { key: 'welcome', value: 'Hello' }
        ])
      }
    }
  })

  const loadHandlers = async () => {
    await vi.importFresh('../../controllers/api/locales.ts', import.meta.url)
    return {
      list: express.__router.get.mock.calls.find(([path]) => path === '/')[1],
      config: express.__router.get.mock.calls.find(([path]) => path === '/config')[1],
      saveConfig: express.__router.post.mock.calls.find(([path]) => path === '/config')[1],
      download: express.__router.post.mock.calls.find(([path]) => path === '/:code/download')[1],
      strings: express.__router.get.mock.calls.find(([path]) => path === '/:code/strings')[1]
    }
  }

  it('registers locale routes', async () => { const handlers = await loadHandlers()

  expect(typeof handlers.list).toBe('function')
  expect(typeof handlers.config).toBe('function')
  expect(typeof handlers.saveConfig).toBe('function')
  expect(typeof handlers.download).toBe('function')
  expect(typeof handlers.strings).toBe('function') })

  it('returns locale list payload', async () => {
    const { list } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await list({}, res)

    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        code: 'en',
        name: 'English',
        nativeName: 'English'
      })
    ])
  })

  it('returns locale config payload for manage system users', async () => {
    const { config } = await loadHandlers()
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await config({ user: { permissions: ['manage:system'] } }, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:system'] }, ['manage:system'])
    expect(res.json).toHaveBeenCalledWith({
      locale: 'en',
      autoUpdate: true,
      namespacing: false,
      namespaces: ['en', 'fr']
    })
  })

  it('returns 403 for locale config without manage system access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { config } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis(), sendStatus: vi.fn() }

    await config({ user: { permissions: [] } }, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
    expect(res.sendStatus).not.toHaveBeenCalled()
  })

  it('returns JSON 403 for locale config saves without manage system access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { saveConfig } = await loadHandlers()
    const req = { user: { permissions: [] }, body: { locale: 'fr', autoUpdate: false, namespacing: true, namespaces: ['en'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await saveConfig(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
  })

  it('returns JSON 400 for malformed locale config save payloads', async () => {
    const { saveConfig } = await loadHandlers()
    const invalidPayloads = [
      {},
      { locale: '', autoUpdate: false, namespacing: true, namespaces: ['en'] },
      { locale: 'fr', autoUpdate: 'yes', namespacing: true, namespaces: ['en'] },
      { locale: 'fr', autoUpdate: false, namespacing: 'yes', namespaces: ['en'] },
      { locale: 'fr', autoUpdate: false, namespacing: true, namespaces: [null] }
    ]

    for (const body of invalidPayloads) {
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      await saveConfig({ user: {}, body }, res)
      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid locale config payload' })
    }
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
  })

  it('saves locale config preserving resolver side effects and namespace union', async () => {
    const { saveConfig } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await saveConfig({
      user: { permissions: ['manage:system'] },
      body: {
        locale: 'ar',
        autoUpdate: false,
        namespacing: true,
        namespaces: ['en', 'ar', 'fr']
      }
    }, res)

    expect(global.WIKI.config.lang.code).toBe('ar')
    expect(global.WIKI.config.lang.autoUpdate).toBe(false)
    expect(global.WIKI.config.lang.namespacing).toBe(true)
    expect(global.WIKI.config.lang.namespaces).toEqual(['en', 'ar', 'fr'])
    expect(global.WIKI.config.lang.rtl).toBe(true)
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['lang'])
    expect(global.WIKI.lang.setCurrentLocale).toHaveBeenCalledWith('ar')
    expect(global.WIKI.lang.refreshNamespaces).toHaveBeenCalledWith()
    expect(global.WIKI.cache.del).toHaveBeenCalledWith('nav:locales')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Locale config updated' })
  })

  it('returns JSON 500 for locale config save failures', async () => {
    global.WIKI.configSvc.saveToDb.mockRejectedValueOnce(new Error('save failed'))
    const { saveConfig } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await saveConfig({
      user: {},
      body: { locale: 'fr', autoUpdate: false, namespacing: true, namespaces: ['en'] }
    }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'save failed' })
  })

  it('returns JSON 403 for locale downloads without manage system access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { download } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await download({ user: { permissions: [] }, params: { code: 'fr' } }, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
    expect(global.WIKI.scheduler.registerJob).not.toHaveBeenCalled()
  })

  it('downloads locales through scheduler preserving resolver job semantics', async () => {
    const finished = Promise.resolve()
    global.WIKI.scheduler.registerJob.mockResolvedValueOnce({ finished })
    const { download } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await download({ user: { permissions: ['manage:system'] }, params: { code: 'fr' } }, res)

    expect(global.WIKI.scheduler.registerJob).toHaveBeenCalledWith({
      name: 'fetch-graph-locale',
      immediate: true
    }, 'fr')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Locale downloaded successfully' })
  })

  it('returns JSON 400 when locale download code is missing', async () => {
    const { download } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await download({ user: {}, params: { code: '' } }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'locale code is required' })
    expect(global.WIKI.scheduler.registerJob).not.toHaveBeenCalled()
  })

  it('returns JSON 500 for locale download failures', async () => {
    global.WIKI.scheduler.registerJob.mockRejectedValueOnce(new Error('download failed'))
    const { download } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await download({ user: {}, params: { code: 'fr' } }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'download failed' })
  })

  it('returns namespace strings payload when namespace is provided', async () => {
    const { strings } = await loadHandlers()
    const req = {
      params: { code: 'en' },
      query: { namespace: 'common' }
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await strings(req, res)

    expect(global.WIKI.lang.getByNamespace).toHaveBeenCalledWith('en', 'common')
    expect(res.json).toHaveBeenCalledWith([
      { key: 'welcome', value: 'Hello' }
    ])
  })

  it('returns 400 when namespace is missing', async () => {
    const { strings } = await loadHandlers()
    const req = {
      params: { code: 'en' },
      query: {}
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await strings(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'namespace query parameter is required' })
  })

  it('returns 404 when locale strings cannot be found', async () => {
    global.WIKI.lang.getByNamespace.mockRejectedValueOnce(new Error('Invalid locale or namespace'))
    const { strings } = await loadHandlers()
    const req = {
      params: { code: 'zz' },
      query: { namespace: 'common' }
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await strings(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid locale or namespace' })
  })
})
