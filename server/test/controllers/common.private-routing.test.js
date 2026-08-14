vi.mock('express', () => {
  const router = { get: vi.fn(), all: vi.fn(), use: vi.fn() }
  const expressMock = { Router: () => router, __router: router }
  return { default: expressMock, ...expressMock }
})

import * as express from 'express'

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
    status: vi.fn()
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
        knex: { client: { pool: { numFree: () => 1, numUsed: () => 0 } } },
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
    await import('../../controllers/common.ts')
    return {
      byId: express.__router.get.mock.calls.find(([path]) => Array.isArray(path) && path.includes('/i'))[1],
      admin: express.__router.get.mock.calls.find(([path]) => path === '/_admin/private/:id')[1]
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
})
