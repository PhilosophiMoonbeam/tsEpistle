
vi.mockModule('express', import.meta.url, () => {
  const routers = []

  const expressMock = {
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

  return { default: expressMock, ...expressMock }
})

const express = await import('express')
import { cloneThemeColors, DEFAULT_THEME_COLORS } from '../../../shared/theme-colors.ts'
import { createDefaultThemePalette } from '../../../shared/theme-palettes.ts'

describe('controllers/api theming endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: vi.fn()
      },
      config: {
        theming: {
          theme: 'default',
          iconset: 'mdi',
          darkMode: false,
          colors: cloneThemeColors(DEFAULT_THEME_COLORS),
          tocPosition: 'right',
          gutterStyle: 'laurel',
          gutterCustomCss: 'opacity: .4;',
          injectCSS: '.contents{color:red}',
          injectHead: '<meta name="test" content="head">',
          injectBody: '<div>body</div>',
          privateSetting: 'do-not-return'
        }
      },
      models: {
        knex: {}
      },
      configSvc: {
        saveToDb: vi.fn()
      }
    }
  })

  const loadConfigHandler = async () => {
    await vi.importFresh('../../controllers/api/theming.ts', import.meta.url)
    const router = express.__routers[0]
    return router.get.mock.calls.find(([path]) => path === '/config')[1]
  }

  const loadSaveHandler = async () => {
    await vi.importFresh('../../controllers/api/theming.ts', import.meta.url)
    const router = express.__routers[0]
    return router.post.mock.calls.find(([path]) => path === '/config')[1]
  }

  it('registers config route', async () => {
    const handler = await loadConfigHandler()

    expect(typeof handler).toBe('function')
  })

  it('registers config save route', async () => {
    const handler = await loadSaveHandler()

    expect(typeof handler).toBe('function')
  })


  it('returns 403 for unauthorized config requests without JSON', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadConfigHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: vi.fn(), json: vi.fn(), set: vi.fn() }

    handler(req, res, vi.fn())

    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
  })

  it('returns 403 for unauthorized config save requests without saving', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadSaveHandler()
    const req = { user: { permissions: [] }, body: { theme: 'default' } }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.sendStatus).not.toHaveBeenCalled()
  })

  it('checks manage:theme and manage:system access', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadConfigHandler()
    const req = { user: { permissions: ['manage:theme'] } }
    const res = { sendStatus: vi.fn(), json: vi.fn(), set: vi.fn() }

    handler(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:theme', 'manage:system'])
  })

  it('checks manage:theme and manage:system access for config save', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSaveHandler()
    const req = {
      user: { permissions: ['manage:theme'] },
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: false,
        tocPosition: 'left'
      }
    }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:theme', 'manage:system'])
  })

  it('rejects invalid theme config save payloads before persisting', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSaveHandler()
    const req = {
      user: {},
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: 'false'
      }
    }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid theme config payload' })
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
  })


  it('rejects malformed theme colors before persisting', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSaveHandler()
    const req = {
      user: {},
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: false,
        colors: {
          ...cloneThemeColors(DEFAULT_THEME_COLORS),
          light: { ...DEFAULT_THEME_COLORS.light, primary: 'blue' }
        }
      }
    }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid theme color configuration' })
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
  })
  it('rejects page gutter selectors before persisting', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSaveHandler()
    const req = {
      user: {},
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: false,
        gutterStyle: 'custom',
        gutterCustomCss: '.contents { display: none; }'
      }
    }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      error: 'Custom page gutter CSS must contain no more than 4000 characters of declarations without selectors or at-rules'
    })
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
  })

  it('returns exactly the expected config fields for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadConfigHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn(), set: vi.fn() }

    handler({ user: {} }, res, vi.fn())

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.json).toHaveBeenCalledWith({
      theme: 'default',
      iconset: 'mdi',
      darkMode: false,
      colors: cloneThemeColors(DEFAULT_THEME_COLORS),
      palettes: [createDefaultThemePalette(DEFAULT_THEME_COLORS)],
      activePaletteId: 'luminous-archive',
      tocPosition: 'right',
      gutterStyle: 'laurel',
      gutterCustomCss: 'opacity: .4;',
      injectCSS: expect.any(String),
      injectHead: '<meta name="test" content="head">',
      injectBody: '<div>body</div>'
    })
    expect(Object.keys(res.json.mock.calls[0][0]).sort()).toEqual([
      'activePaletteId',
      'colors',
      'darkMode',
      'gutterCustomCss',
      'gutterStyle',
      'iconset',
      'injectBody',
      'injectCSS',
      'injectHead',
      'palettes',
      'theme',
      'tocPosition'
    ])
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('privateSetting')
  })

  it('allows manage:theme users when checkAccess returns true', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadConfigHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn(), set: vi.fn() }

    handler({ user: { permissions: ['manage:theme'] } }, res, vi.fn())

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledTimes(1)
  })

  it('defaults tocPosition to left when config value is falsy', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.theming.tocPosition = ''
    const handler = await loadConfigHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn(), set: vi.fn() }

    handler({ user: {} }, res, vi.fn())

    expect(res.json.mock.calls[0][0].tocPosition).toBe('left')
  })

  it('defaults absent legacy page gutter settings to classical columns', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    delete global.WIKI.config.theming.gutterStyle
    delete global.WIKI.config.theming.gutterCustomCss
    const handler = await loadConfigHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn(), set: vi.fn() }

    handler({ user: {} }, res, vi.fn())

    expect(res.json.mock.calls[0][0]).toMatchObject({
      gutterStyle: 'columns',
      gutterCustomCss: ''
    })
  })

  it('beautifies injectCSS using the GraphQL read behavior', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.theming.injectCSS = '.contents{color:red}.sidebar{display:none}'
    const handler = await loadConfigHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn(), set: vi.fn() }

    handler({ user: {} }, res, vi.fn())

    expect(res.json.mock.calls[0][0].injectCSS).toContain('.contents')
    expect(res.json.mock.calls[0][0].injectCSS).toContain('color: red')
    expect(res.json.mock.calls[0][0].injectCSS).toContain('.sidebar')
    expect(res.json.mock.calls[0][0].injectCSS).toContain('display: none')
  })

  it('returns injectHead and injectBody unchanged', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.theming.injectHead = '<!-- head marker -->'
    global.WIKI.config.theming.injectBody = '<section data-test="body"></section>'
    const handler = await loadConfigHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn(), set: vi.fn() }

    handler({ user: {} }, res, vi.fn())

    expect(res.json.mock.calls[0][0].injectHead).toBe('<!-- head marker -->')
    expect(res.json.mock.calls[0][0].injectBody).toBe('<section data-test="body"></section>')
  })

  it('saves theme config with GraphQL mutation parity', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSaveHandler()
    const req = {
      user: { permissions: ['manage:theme'] },
      body: {
        theme: 'default',
        iconset: 'fa',
        darkMode: true,
        colors: {
          ...cloneThemeColors(DEFAULT_THEME_COLORS),
          dark: { ...DEFAULT_THEME_COLORS.dark, primary: '#ABCDEF' }
        },
        tocPosition: '',
        gutterStyle: 'custom',
        gutterCustomCss: ' background: linear-gradient(red, transparent); opacity: .45; ',
        injectCSS: '.contents{color:red}',
        injectHead: '<meta name="saved" content="head">',
        injectBody: '<div>saved body</div>'
      }
    }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.config.theming).toMatchObject({
      theme: 'default',
      iconset: 'fa',
      darkMode: true,
      colors: expect.objectContaining({
        dark: expect.objectContaining({ primary: '#ABCDEF' })
      }),
      tocPosition: 'left',
      gutterStyle: 'custom',
      gutterCustomCss: 'background: linear-gradient(red, transparent); opacity: .45;',
      injectHead: '<meta name="saved" content="head">',
      injectBody: '<div>saved body</div>',
      privateSetting: 'do-not-return'
    })
    expect(global.WIKI.config.theming.injectCSS).toBe('.contents{color:red}')
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['theming'])
    expect(res.json).toHaveBeenCalledWith({ message: 'Theme config updated' })
  })

  it('persists multiple editable color themes and applies the selected theme colors', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSaveHandler()
    const customColors = cloneThemeColors(DEFAULT_THEME_COLORS)
    customColors.light.primary = '#123456'
    customColors.dark.primary = '#ABCDEF'
    const palettes = [
      createDefaultThemePalette(DEFAULT_THEME_COLORS),
      { id: 'custom-theme-2', name: 'Boardroom dusk', colors: customColors }
    ]
    const req = {
      user: { permissions: ['manage:theme'] },
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: true,
        colors: cloneThemeColors(DEFAULT_THEME_COLORS),
        palettes,
        activePaletteId: 'custom-theme-2',
        tocPosition: 'right',
        gutterStyle: 'columns',
        gutterCustomCss: '',
        injectCSS: '',
        injectHead: '',
        injectBody: ''
      }
    }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.config.theming.activePaletteId).toBe('custom-theme-2')
    expect(global.WIKI.config.theming.palettes).toEqual(palettes)
    expect(global.WIKI.config.theming.colors).toEqual(customColors)
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['theming'])
  })

  it('defaults missing optional injection fields to empty strings on save', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSaveHandler()
    const req = {
      user: {},
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: false,
        tocPosition: 'right'
      }
    }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.config.theming.injectCSS).toBe('')
    expect(global.WIKI.config.theming.injectHead).toBe('')
    expect(global.WIKI.config.theming.injectBody).toBe('')
    expect(res.json).toHaveBeenCalledWith({ message: 'Theme config updated' })
  })

  it('returns JSON errors when theme config save fails', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.saveToDb.mockRejectedValue(new Error('database unavailable'))
    const handler = await loadSaveHandler()
    const req = {
      user: {},
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: false,
        tocPosition: 'left',
        injectCSS: '',
        injectHead: '',
        injectBody: ''
      }
    }
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await handler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'database unavailable' })
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
      const apiRouter = express.__routers[0]

      expect(apiRouter.use).toHaveBeenCalledWith('/theming', expect.any(Object))
    } finally {
      for (const modulePath of modulePaths) {
        vi.unmockModule(modulePath, import.meta.url)
      }
    }
  })
})
