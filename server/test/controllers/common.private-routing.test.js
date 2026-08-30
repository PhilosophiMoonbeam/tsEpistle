vi.mockModule('express', import.meta.url, () => {
  const router = { get: vi.fn(), post: vi.fn(), all: vi.fn(), use: vi.fn() }
  const expressMock = { Router: () => router, __router: router }
  return { default: expressMock, ...expressMock }
})

const express = await import('express')

const privatePage = {
  id: 7,
  path: 'secret/notes',
  locale: 'en',
  localeCode: 'en',
  visibility: 'private',
  ownerId: 42,
  title: 'Secret Notes',
  description: 'Owner only',
  contentType: 'markdown',
  content: 'secret',
  isPublished: true,
  updatedAt: '2026-08-14T00:00:00.000Z',
  createdAt: '2026-08-14T00:00:00.000Z',
  editorKey: 'markdown',
  editor: 'markdown',
  tags: [],
  extra: { css: '', js: '' },
  toc: [],
  $relatedQuery: vi.fn()
}

const response = () => {
  const res = {
    locals: { pageMeta: {}, siteConfig: {} },
    cookie: vi.fn(),
    redirect: vi.fn(),
    render: vi.fn(),
    set: vi.fn(),
    status: vi.fn(),
    vary: vi.fn()
  }
  res.status.mockReturnValue(res)
  return res
}

const request = user => ({
  params: { id: '7' },
  path: '/i/7',
  query: {},
  user,
  i18n: { changeLanguage: vi.fn(), dir: vi.fn().mockReturnValue('ltr') }
})

describe('private page administration routes', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__router.get.mockClear()
    global.WIKI = {
      auth: {
        checkAccess: vi.fn().mockImplementation((user, permissions) => permissions.some(permission => user?.permissions?.includes(permission))),
        getEffectivePermissions: vi.fn().mockReturnValue({
          pages: { read: false, write: false, manage: false },
          history: { read: false },
          source: { read: false }
        })
      },
      config: {
        seo: { robots: [] },
        metrics: { isEnabled: false },
        lang: { namespacing: true },
        theming: { injectCSS: '', injectHead: '', injectBody: '' },
        pageExtensions: [],
        features: { featurePageComments: false },
        host: 'http://wiki.example'
      },
      metrics: { render: vi.fn() },
      models: {
        knex: Object.assign(vi.fn().mockImplementation(() => ({
          where: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(undefined)
          })
        })), { client: { pool: { numFree: () => 1, numUsed: () => 0 } } }),
        pages: {
          getPageFromDb: vi.fn().mockResolvedValue(privatePage),
          getPage: vi.fn(),
          query: vi.fn().mockReturnValue({
            column: vi.fn().mockReturnValue({ findById: vi.fn().mockResolvedValue(privatePage) }),
            findById: vi.fn().mockResolvedValue(privatePage)
          })
        },
        pageHistory: { getVersion: vi.fn() },
        users: { getUserAvatarData: vi.fn() },
        navigation: { getTree: vi.fn().mockResolvedValue([]) },
        assets: { getAsset: vi.fn() }
      },
      data: { commentProvider: { codeTemplate: '', head: '', body: '', main: '' } }
    }
  })

  const handlers = async () => {
    const { default: createCommonController } = await vi.importFresh('../../controllers/common.ts', import.meta.url)
    createCommonController(global.WIKI)
    return {
      byId: express.__router.get.mock.calls.find(([path]) => Array.isArray(path) && path.includes('/i'))[1],
      admin: express.__router.get.mock.calls.find(([path]) => path === '/_admin/private/:id')[1],
      editor: express.__router.get.mock.calls.find(([path]) => Array.isArray(path) && path.includes('/e'))[1]
    }
  }

  it('redirects owners and administrators to distinct private routes', async () => {
    const { byId } = await handlers()
    const ownerResponse = response()
    await byId(request({ id: 42, permissions: [] }), ownerResponse)
    expect(ownerResponse.redirect).toHaveBeenCalledWith('/_private/en/secret/notes')

    const adminResponse = response()
    await byId(request({ id: 1, permissions: ['manage:system'] }), adminResponse)
    expect(adminResponse.redirect).toHaveBeenCalledWith('/_admin/private/7')
    expect(global.WIKI.models.pages.query.mock.results.at(-1).value.column).toHaveBeenCalledWith([
      'id', 'path', 'localeCode', 'visibility', 'ownerId'
    ])
  })

  it('returns identical not-found behavior to non-owners', async () => {
    const { byId } = await handlers()
    const res = response()
    await byId(request({ id: 9, permissions: ['read:pages'] }), res)
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.render).toHaveBeenCalledWith('notfound', { action: 'view' })
  })

  it('renders the by-ID inspection route only for system administrators', async () => {
    const { admin } = await handlers()
    const denied = response()
    await admin(request({ id: 9, permissions: ['read:pages'] }), denied)
    expect(denied.status).toHaveBeenCalledWith(404)

    const allowed = response()
    await admin(request({ id: 1, permissions: ['manage:system'] }), allowed)
    expect(global.WIKI.models.pages.getPageFromDb).toHaveBeenCalledWith(7)
    expect(allowed.render).toHaveBeenCalledWith('page', expect.objectContaining({
      page: privatePage,
      effectivePermissions: expect.objectContaining({ pages: { read: true, write: true, manage: true } })
    }))
  })

  it('copies protected templates only with a current requester session grant', async () => {
    let grantActive = false
    const templatePage = {
      ...privatePage,
      visibility: 'public',
      ownerId: null,
      path: 'templates/brief',
      title: 'Brief',
      content: '# Protected template'
    }
    global.WIKI.auth.getEffectivePermissions.mockReturnValue({
      pages: { read: true, write: true, manage: false },
      history: { read: true },
      source: { read: true }
    })
    global.WIKI.models.pages.getPageFromDb.mockImplementation(async input => typeof input === 'number' ? templatePage : null)
    global.WIKI.models.knex.mockImplementation(table => {
      if (table === 'pageAccessPasswords') {
        return {
          where: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({ pageId: 7, version: 3 })
          })
        }
      }
      if (table === 'pageUnlockGrants') {
        return {
          where: vi.fn().mockImplementation((column, operator) => {
            if (column === 'expiresAt' && operator === '<=') return { delete: vi.fn().mockResolvedValue(0) }
            return {
              where: vi.fn().mockReturnValue({
                first: vi.fn().mockImplementation(async () => grantActive ? { id: 'grant-1' } : undefined)
              })
            }
          })
        }
      }
      throw new Error(`Unexpected table ${table}`)
    })
    const { editor } = await handlers()
    const req = {
      i18n: { changeLanguage: vi.fn(), dir: vi.fn().mockReturnValue('ltr') },
      originalUrl: '/e/en/new-page?from=7',
      path: '/e/en/new-page',
      query: { from: '7' },
      sessionID: 'current-session',
      user: { id: 42, permissions: ['read:pages', 'write:pages'] }
    }

    const lockedResponse = response()
    await editor(req, lockedResponse, vi.fn())

    expect(lockedResponse.status).toHaveBeenCalledWith(401)
    expect(lockedResponse.render).toHaveBeenCalledWith('page-unlock', expect.objectContaining({
      pageId: 7,
      pageTitle: 'Protected page'
    }))

    grantActive = true
    const grantedResponse = response()
    await editor(req, grantedResponse, vi.fn())

    expect(grantedResponse.render).toHaveBeenCalledWith('editor', expect.objectContaining({
      page: expect.objectContaining({
        content: Buffer.from('# Protected template').toString('base64'),
        title: 'Brief'
      })
    }))
  })

  it('fails closed before loading a template source when requester context is missing', async () => {
    global.WIKI.auth.getEffectivePermissions.mockReturnValue({
      pages: { read: true, write: true, manage: false },
      history: { read: true },
      source: { read: true }
    })
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue(null)
    const { editor } = await handlers()
    const res = response()

    await editor({
      i18n: { changeLanguage: vi.fn(), dir: vi.fn().mockReturnValue('ltr') },
      originalUrl: '/e/en/new-page?from=7',
      path: '/e/en/new-page',
      query: { from: '7' },
      sessionID: 'anonymous-session'
    }, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.render).toHaveBeenCalledWith('unauthorized', { action: 'template' })
    expect(global.WIKI.models.pages.getPageFromDb).not.toHaveBeenCalledWith(7)
  })
})
