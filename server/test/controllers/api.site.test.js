vi.mock('express', () => {
  const routers = []

  const expressMock = {
    Router: () => {
      const router = {
        get: vi.fn(),
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

describe('controllers/api site endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: vi.fn(() => true)
      },
      app: {
        enable: vi.fn(),
        disable: vi.fn()
      },
      configSvc: {
        saveToDb: vi.fn().mockResolvedValue(undefined)
      },
      config: {
        host: 'https://wiki.example.com',
        title: 'Wiki',
        company: 'Company',
        contentLicense: 'ccby',
        footerOverride: 'Footer',
        logoUrl: '/logo.svg',
        pageExtensions: ['md', 'markdown'],
        seo: {
          description: 'Description',
          robots: ['index', 'follow'],
          analyticsService: 'ga',
          analyticsId: 'UA-1'
        },
        auth: {
          autoLogin: false,
          enforce2FA: true,
          hideLocal: false,
          loginBgUrl: '/login.jpg',
          audience: 'urn:wiki.js',
          tokenExpiration: '30m',
          tokenRenewal: '14d'
        },
        editShortcuts: {
          editFab: true,
          editMenuBar: true,
          editMenuBtn: false,
          editMenuExternalBtn: false,
          editMenuExternalName: 'Docs',
          editMenuExternalIcon: 'open_in_new',
          editMenuExternalUrl: 'https://docs.example.com'
        },
        features: {
          featurePageRatings: true,
          featurePageComments: false,
          featurePersonalWikis: true
        },
        security: {
          securityOpenRedirect: false,
          securityIframe: true,
          securityReferrerPolicy: true,
          securityTrustProxy: false,
          securitySRI: true,
          securityHSTS: false,
          securityHSTSDuration: 300,
          securityCSP: false,
          securityCSPDirectives: "default-src 'self'"
        },
        uploads: {
          maxFileSize: 1048576,
          maxFiles: 10,
          scanSVG: true,
          forceDownload: false
        }
      }
    }
  })

  const loadRouter = async () => {
    await expect(import('../../controllers/api/site.ts')).resolves.toBeDefined()
    return express.__routers[0]
  }

  const loadGetConfigHandler = async () => {
    const router = await loadRouter()
    return router.get.mock.calls.find(([path]) => path === '/config')[1]
  }

  const loadPutConfigHandler = async () => {
    const router = await loadRouter()
    return router.put.mock.calls.find(([path]) => path === '/config')[1]
  }

  it('registers site config routes', async () => {
    const router = await loadRouter()

    expect(router.get.mock.calls.map(([path]) => path)).toEqual(['/config'])
    expect(router.put.mock.calls.map(([path]) => path)).toEqual(['/config'])
  })

  it.each([
    ['fetch', async () => await loadGetConfigHandler(), { body: {} }],
    ['save', async () => await loadPutConfigHandler(), { body: {} }]
  ])('rejects forbidden site config %s requests with JSON', async (label, getHandler, req) => {
    const handler = await getHandler()
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, ...req }, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({}, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
  })

  it('returns the flattened site config shape used by GraphQL clients', async () => {
    const handler = await loadGetConfigHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: {} }, res)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      host: 'https://wiki.example.com',
      title: 'Wiki',
      description: 'Description',
      robots: ['index', 'follow'],
      analyticsService: 'ga',
      analyticsId: 'UA-1',
      company: 'Company',
      contentLicense: 'ccby',
      footerOverride: 'Footer',
      logoUrl: '/logo.svg',
      pageExtensions: 'md, markdown',
      authAutoLogin: false,
      authEnforce2FA: true,
      authHideLocal: false,
      authLoginBgUrl: '/login.jpg',
      authJwtAudience: 'urn:wiki.js',
      authJwtExpiration: '30m',
      authJwtRenewablePeriod: '14d',
      editFab: true,
      featurePageRatings: true,
      securityTrustProxy: false,
      uploadMaxFileSize: 1048576,
      uploadMaxFiles: 10,
      uploadScanSVG: true,
      uploadForceDownload: false
    }))
  })

  it('updates site config with GraphQL-compatible normalization and save side effects', async () => {
    const handler = await loadPutConfigHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({
      user: {},
      body: {
        host: ' https://next.example.com/ ',
        title: ' Next Wiki ',
        company: ' Next Company ',
        contentLicense: 'cc0',
        footerOverride: '<strong>Footer</strong>',
        logoUrl: ' /next.svg ',
        pageExtensions: ' MD, Wiki,  ',
        description: 'Next description',
        robots: ['noindex'],
        analyticsService: '',
        analyticsId: '',
        authAutoLogin: true,
        editFab: false,
        featurePageComments: true,
        securityTrustProxy: true,
        securityHSTSDuration: 31536000,
        uploadMaxFileSize: 2097152,
        uploadMaxFiles: 20,
        uploadForceDownload: true
      }
    }, res)

    expect(global.WIKI.config.host).toBe('https://next.example.com')
    expect(global.WIKI.config.title).toBe('Next Wiki')
    expect(global.WIKI.config.company).toBe('Next Company')
    expect(global.WIKI.config.logoUrl).toBe('/next.svg')
    expect(global.WIKI.config.pageExtensions).toEqual(['md', 'wiki'])
    expect(global.WIKI.config.seo).toEqual({
      description: 'Next description',
      robots: ['noindex'],
      analyticsService: '',
      analyticsId: ''
    })
    expect(global.WIKI.config.auth).toEqual({
      autoLogin: true,
      enforce2FA: true,
      hideLocal: false,
      loginBgUrl: '/login.jpg',
      audience: 'urn:wiki.js',
      tokenExpiration: '30m',
      tokenRenewal: '14d'
    })
    expect(global.WIKI.config.editShortcuts.editFab).toBe(false)
    expect(global.WIKI.config.editShortcuts.editMenuBar).toBe(true)
    expect(global.WIKI.config.features.featurePageComments).toBe(true)
    expect(global.WIKI.config.features.featurePageRatings).toBe(true)
    expect(global.WIKI.config.security.securityTrustProxy).toBe(true)
    expect(global.WIKI.config.security.securityHSTSDuration).toBe(31536000)
    expect(global.WIKI.config.uploads.maxFileSize).toBe(2097152)
    expect(global.WIKI.config.uploads.maxFiles).toBe(20)
    expect(global.WIKI.config.uploads.forceDownload).toBe(true)
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['host', 'title', 'company', 'contentLicense', 'footerOverride', 'seo', 'logoUrl', 'pageExtensions', 'auth', 'editShortcuts', 'features', 'security', 'uploads'])
    expect(global.WIKI.app.enable).toHaveBeenCalledWith('trust proxy')
    expect(global.WIKI.app.disable).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Site configuration updated successfully' })
  })

  it('disables trust proxy when the saved config sets securityTrustProxy false', async () => {
    const handler = await loadPutConfigHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { securityTrustProxy: false } }, res)

    expect(global.WIKI.app.disable).toHaveBeenCalledWith('trust proxy')
  })

  it('rejects invalid save payloads with JSON', async () => {
    const handler = await loadPutConfigHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: [] }, res)

    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Site configuration must be an object' })
  })

  it('returns JSON errors from save failures', async () => {
    const handler = await loadPutConfigHandler()
    global.WIKI.configSvc.saveToDb.mockRejectedValue(new Error('save failed'))
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: {} }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'save failed' })
  })
})
