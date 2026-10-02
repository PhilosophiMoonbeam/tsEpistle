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

describe('common page routing', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__router.get.mockClear()
    global.WIKI = {
      auth: {
        checkAccess: vi.fn().mockImplementation((user, permissions) => permissions.some(permission => user?.permissions?.includes(permission))),
        checkPageAccess: vi.fn((user, permissions, _page, authority) =>
          authority?.requester === user && permissions.some(permission => user?.permissions?.includes(permission))
        ),
        loadPageRuleAuthority: vi.fn(async requester => ({
          requester,
          permissions: requester?.permissions ?? [],
          groups: [],
          tagAliases: {}
        })),
        getEffectivePermissions: vi.fn().mockReturnValue({
          pages: { read: false, write: false, manage: false },
          history: { read: false },
          source: { read: false }
        })
      },
      config: {
        seo: { robots: [] },
        metrics: { isEnabled: false },
        lang: { code: 'en', namespacing: true },
        theming: { injectCSS: '', injectHead: '', injectBody: '' },
        pageExtensions: [],
        features: { featurePageComments: false },
        host: 'http://wiki.example'
      },
      metrics: { render: vi.fn() },
      models: {
        knex: Object.assign(vi.fn().mockImplementation(() => ({
          where: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(undefined),
            select: vi.fn().mockResolvedValue([])
          })
        })), { client: { pool: { numFree: () => 1, numUsed: () => 0 } } }),
        pages: {
          getPageFromDb: vi.fn().mockResolvedValue(privatePage),
          getPage: vi.fn(),
          query: vi.fn().mockImplementation(() => {
            let columns
            const query = {
              column: vi.fn(fields => { columns = fields; return query }),
              findById: vi.fn(async id => {
                if (id !== privatePage.id) return undefined
                return columns
                  ? Object.fromEntries(columns.map(column => [column, privatePage[column]]))
                  : privatePage
              })
            }
            return query
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
      offlineSettings: express.__router.get.mock.calls.find(([path]) => path === '/p/offline')[1],
      profile: express.__router.get.mock.calls.find(([path]) => Array.isArray(path) && path.includes('/p'))[1],
      byId: express.__router.get.mock.calls.find(([path]) => Array.isArray(path) && path.includes('/i'))[1],
      admin: express.__router.get.mock.calls.find(([path]) => path === '/_admin/private/:id')[1],
      editor: express.__router.get.mock.calls.find(([path]) => Array.isArray(path) && path.includes('/e'))[1],
      history: express.__router.get.mock.calls.find(([path]) => Array.isArray(path) && path.includes('/h'))[1],
      source: express.__router.get.mock.calls.find(([path]) => Array.isArray(path) && path.includes('/s'))[1],
      view: express.__router.get.mock.calls.find(([path]) => path === '/{*pagePath}')[1]
    }
  }

  it('exposes device settings without exposing personal profile data to guests', async () => {
    const { offlineSettings, profile } = await handlers()
    const deviceResponse = response()
    await offlineSettings(request({ id: 2 }), deviceResponse)
    expect(deviceResponse.render).toHaveBeenCalledWith('profile')
    const profileResponse = response()
    await profile(request({ id: 2 }), profileResponse)
    expect(profileResponse.status).toHaveBeenCalledWith(403)
    expect(profileResponse.render).toHaveBeenCalledWith('unauthorized', { action: 'view' })
  })

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

  it('offers Create this page on a missing-page 404 only to people who may write there', async () => {
    const { history, source } = await handlers()
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue(undefined)
    global.WIKI.auth.getEffectivePermissions.mockImplementation(req => ({
      pages: { read: true, write: Boolean(req.user?.permissions?.includes('write:pages')), manage: false },
      history: { read: true },
      source: { read: true }
    }))
    const missing = (path, user) => ({ ...request(user), path })
    const writer = { id: 5, permissions: ['read:pages', 'write:pages'] }
    const reader = { id: 6, permissions: ['read:pages'] }

    const writerHistory = response()
    await history(missing('/h/en/guides/new-guide', writer), writerHistory)
    expect(writerHistory.status).toHaveBeenCalledWith(404)
    expect(writerHistory.render).toHaveBeenCalledWith('notfound', { action: 'history', createHref: '/e/en/guides/new-guide' })
    expect(writerHistory.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(writerHistory.vary).toHaveBeenCalledWith('Cookie')
    expect(global.WIKI.auth.getEffectivePermissions).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ path: 'guides/new-guide', locale: 'en', tags: [] }),
      expect.objectContaining({ requester: writer })
    )

    const writerSource = response()
    await source(missing('/s/en/guides/new-guide', writer), writerSource)
    expect(writerSource.render).toHaveBeenCalledWith('notfound', { action: 'source', createHref: '/e/en/guides/new-guide' })

    const readerHistory = response()
    await history(missing('/h/en/guides/new-guide', reader), readerHistory)
    expect(readerHistory.status).toHaveBeenCalledWith(404)
    expect(readerHistory.render).toHaveBeenCalledWith('notfound', { action: 'history' })
    expect(readerHistory.render.mock.calls[0][1]).not.toHaveProperty('createHref')
    expect(readerHistory.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(readerHistory.vary).toHaveBeenCalledWith('Cookie')

    const privateHistory = response()
    await history(missing('/h/_private/en/notes', writer), privateHistory)
    expect(privateHistory.render.mock.calls[0][1]).toEqual({ action: 'history' })
    expect(privateHistory.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(privateHistory.vary).toHaveBeenCalledWith('Cookie')
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
  it('allows authorized direct reads of pages excluded from search', async () => {
    const optedOutPage = {
      ...privatePage,
      path: 'guides/opted-out',
      visibility: 'public',
      ownerId: null,
      title: 'Opted Out Guide',
      isSearchable: false
    }
    global.WIKI.auth.getEffectivePermissions.mockReturnValue({
      pages: { read: true, write: false, manage: false },
      history: { read: true },
      source: { read: true }
    })
    global.WIKI.models.pages.getPage.mockResolvedValue(optedOutPage)
    const { view } = await handlers()
    const res = response()

    await view({
      ...request({ id: 9, permissions: ['read:pages'] }),
      originalUrl: '/en/guides/opted-out',
      path: '/en/guides/opted-out',
      sessionID: 'direct-read-session'
    }, res, vi.fn())

    expect(res.render).toHaveBeenCalledWith('page', expect.objectContaining({ page: optedOutPage }))
  })


  it('suppresses external discussion embeds for private and password-protected pages', async () => {
    global.WIKI.config.features.featurePageComments = true
    const renderForPage = vi.fn().mockReturnValue({ head: '<script>external()</script>', body: '', main: '<div>external comments</div>' })
    global.WIKI.data.commentProvider = { codeTemplate: true, main: '', renderForPage }
    const { admin, view } = await handlers(), user = { id: 1, permissions: ['manage:system', 'read:pages'] }
    const privateRes = response(); await admin(request(user), privateRes)
    expect(privateRes.render).toHaveBeenCalledWith('page', expect.objectContaining({ commentsEnabled: false, comments: expect.objectContaining({ head: '', body: '', main: '' }) }))
    expect(renderForPage).not.toHaveBeenCalled()
    const publicPage = { ...privatePage, visibility: 'public', ownerId: null }
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue(publicPage)
    global.WIKI.models.pages.getPage.mockResolvedValue(publicPage)
    const publicRequest = { ...request(user), path: '/en/secret/notes', originalUrl: '/en/secret/notes', sessionID: 'test-session' }
    global.WIKI.models.knex.mockImplementation(() => ({ where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ pageId: 7, version: 1 }) }) }))
    const protectedRes = response(); await view(publicRequest, protectedRes, vi.fn())
    expect(protectedRes.render).toHaveBeenCalledWith('page', expect.objectContaining({ commentsEnabled: false }))
    expect(renderForPage).not.toHaveBeenCalled()
    global.WIKI.models.knex.mockImplementation(() => ({ where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) }) }))
    const publicRes = response(); await view(publicRequest, publicRes, vi.fn())
    expect(publicRes.render).toHaveBeenCalledWith('page', expect.objectContaining({ commentsEnabled: true, spaNavigation: false, comments: expect.objectContaining({ head: '<script>external()</script>' }) }))
    expect(renderForPage).toHaveBeenCalledWith(7, 'http://wiki.example/i/7')
  })

  it('marks page HTML without marking same-origin HTML assets', async () => {
    const { view } = await handlers()
    const publicPage = {
      ...privatePage,
      path: 'guides/start',
      visibility: 'public',
      ownerId: null,
      title: 'Public Guide',
      extra: { css: '', js: '' },
      toc: []
    }
    global.WIKI.auth.getEffectivePermissions.mockReturnValue({
      pages: { read: true, write: false, manage: false },
      history: { read: true },
      source: { read: true }
    })
    global.WIKI.models.pages.getPage.mockResolvedValueOnce(publicPage)

    const pageResponse = response()
    await view({
      i18n: { changeLanguage: vi.fn(), dir: vi.fn().mockReturnValue('ltr') },
      originalUrl: '/en/guides/start',
      path: '/en/guides/start',
      query: {},
      sessionID: 'page-session',
      user: { id: 9, permissions: ['read:pages'] }
    }, pageResponse, vi.fn())

    expect(pageResponse.render).toHaveBeenCalledWith('page', expect.objectContaining({ page: publicPage }))
    expect(pageResponse.set).toHaveBeenCalledWith('X-Wiki-Page', '1')

    global.WIKI.models.assets.getAsset.mockImplementationOnce(async (_path, res) => {
      res.set('Content-Type', 'text/html')
    })
    const assetResponse = response()
    await view({
      path: '/en/uploads/untrusted.html',
      query: {},
      sessionID: 'asset-session',
      user: { id: 1, permissions: ['read:assets', 'manage:system'] }
    }, assetResponse, vi.fn())

    expect(global.WIKI.models.assets.getAsset).toHaveBeenCalledWith('uploads/untrusted.html', assetResponse)
    expect(assetResponse.set).not.toHaveBeenCalledWith('X-Wiki-Page', expect.anything())
  })

  it('copies protected templates only with a current requester session grant', async () => {
    const grantRows = []
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
      const rows = table === 'pageAccessPasswords'
        ? [{ pageId: 7, version: 3 }]
        : table === 'pageUnlockGrants' ? grantRows : undefined
      if (!rows) throw new Error(`Unexpected table ${table}`)
      const predicates = []
      const matches = row => predicates.every(predicate => predicate(row))
      const query = {
        where(criteria, operator, value) {
          if (typeof criteria === 'object') {
            predicates.push(row => Object.entries(criteria).every(([column, expected]) => row[column] === expected))
          } else if (operator === '>') {
            predicates.push(row => row[criteria] > value)
          } else if (operator === '<=') {
            predicates.push(row => row[criteria] <= value)
          } else {
            throw new Error(`Unexpected comparison ${operator}`)
          }
          return query
        },
        async first() { return rows.find(matches) },
        async delete() {
          let removed = 0
          for (let index = rows.length - 1; index >= 0; index--) {
            if (matches(rows[index])) {
              rows.splice(index, 1)
              removed++
            }
          }
          return removed
        }
      }
      return query
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

    const matchingGrant = {
      id: 'grant-1',
      pageId: 7,
      sessionId: 'current-session',
      userId: 42,
      passwordVersion: 3,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
    for (const mismatch of [
      { sessionId: 'foreign-session' },
      { userId: 9 },
      { pageId: 8 },
      { passwordVersion: 2 },
      { expiresAt: new Date(Date.now() - 60 * 1000) }
    ]) {
      grantRows.splice(0, grantRows.length, { ...matchingGrant, ...mismatch })
      const deniedResponse = response()
      await editor(req, deniedResponse, vi.fn())
      expect(deniedResponse.status).toHaveBeenCalledWith(401)
      expect(deniedResponse.render).toHaveBeenCalledWith('page-unlock', expect.objectContaining({
        pageId: 7,
        pageTitle: 'Protected page'
      }))
    }

    grantRows.splice(0, grantRows.length, matchingGrant)
    const grantedResponse = response()
    await editor(req, grantedResponse, vi.fn())

    expect(grantedResponse.render).toHaveBeenCalledWith('editor', expect.objectContaining({
      page: expect.objectContaining({
        content: Buffer.from('# Protected template').toString('base64'),
        title: 'Brief'
      })
    }))
  })

  it('branches from a historical version without dropping authorized page metadata', async () => {
    const version = {
      content: '# Historical version',
      editor: 'markdown',
      title: 'Historical title',
      description: 'Historical description',
      tags: ['history', 'release'],
      isPublished: false,
      isSearchable: false,
      publishStartDate: '2026-10-01T00:00:00.000Z',
      publishEndDate: '2026-11-01T00:00:00.000Z',
      extra: { css: '.private {}', js: 'window.allowed = true' }
    }
    global.WIKI.auth.getEffectivePermissions.mockReturnValue({
      pages: { read: true, write: true, manage: false, script: true, style: false },
      history: { read: true },
      source: { read: true }
    })
    const query = {
      select: vi.fn(),
      withGraphJoined: vi.fn(),
      modifyGraph: vi.fn(),
      findById: vi.fn().mockResolvedValue({
        id: 7,
        path: 'templates/brief',
        localeCode: 'en',
        visibility: 'public',
        ownerId: null,
        tags: [{ tag: 'history' }]
      })
    }
    query.select.mockReturnValue(query)
    query.withGraphJoined.mockReturnValue(query)
    query.modifyGraph.mockReturnValue(query)
    global.WIKI.models.pages.query.mockReturnValue(query)
    global.WIKI.models.pageHistory.getVersion.mockResolvedValue(version)
    global.WIKI.models.pages.getPageFromDb.mockImplementation(async input => typeof input === 'number'
      ? {
          ...privatePage,
          path: 'templates/brief',
          visibility: 'public',
          ownerId: null,
          tags: [{ tag: 'history' }]
        }
      : null)
    const { editor } = await handlers()
    const res = response()

    await editor({
      i18n: { changeLanguage: vi.fn(), dir: vi.fn().mockReturnValue('ltr') },
      originalUrl: '/e/en/release-notes?from=7,9',
      path: '/e/en/release-notes',
      query: { from: '7,9' },
      sessionID: 'current-session',
      user: { id: 42, permissions: ['read:pages', 'read:history', 'write:pages', 'write:scripts'] }
    }, res, vi.fn())


    expect(res.render).toHaveBeenCalledWith('editor', expect.objectContaining({
      page: expect.objectContaining({
        content: Buffer.from(version.content).toString('base64'),
        title: version.title,
        tags: version.tags,
        isPublished: false,
        isSearchable: false,
        publishStartDate: version.publishStartDate,
        publishEndDate: version.publishEndDate,
        extra: expect.objectContaining({ css: '', js: version.extra.js })
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
