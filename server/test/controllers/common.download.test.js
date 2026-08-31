import { parseOkfDocument } from '../../okf/format.ts'

vi.mockModule('express', import.meta.url, () => {
  const router = { get: vi.fn(), post: vi.fn(), all: vi.fn(), use: vi.fn() }
  const expressMock = { Router: () => router, __router: router }
  return { default: expressMock, ...expressMock }
})

const express = await import('express')

const currentPage = {
  id: 7,
  path: 'guides/start',
  locale: 'en',
  localeCode: 'en',
  visibility: 'public',
  ownerId: null,
  title: 'Current guide',
  description: 'Current description',
  contentType: 'markdown',
  content: '# Current\n',
  sourceRevision: '17',
  authorId: 11,
  isPublished: true,
  updatedAt: '2026-08-30T00:00:00.000Z',
  createdAt: '2026-08-20T00:00:00.000Z',
  editorKey: 'markdown',
  editor: 'markdown',
  tags: [{ tag: 'current' }],
  extra: { okf: { type: 'Procedure', status: 'draft', current_authority: { retained: true } } },
  $relatedQuery: vi.fn()
}

const historicalPage = {
  pageId: 7,
  versionId: 3,
  path: 'guides/start',
  locale: 'fr',
  title: 'Historical guide',
  description: 'Historical description',
  contentType: 'markdown',
  content: '# Historical\n',
  sourceRevision: '9',
  authorId: 23,
  isPublished: false,
  updatedAt: '2026-08-22T00:00:00.000Z',
  createdAt: '2026-08-21T00:00:00.000Z',
  editor: 'asciidoc',
  tags: ['historical'],
  extra: { okf: { type: 'Reference', status: 'stable', historical_authority: { retained: true } } }
}

const response = () => {
  const res = {
    locals: { pageMeta: {} },
    attachment: vi.fn(),
    end: vi.fn(),
    render: vi.fn(),
    send: vi.fn(),
    set: vi.fn(),
    status: vi.fn(),
    vary: vi.fn()
  }
  res.status.mockReturnValue(res)
  res.send.mockReturnValue(res)
  return res
}

const request = (query, permissions) => ({
  path: '/d/en/guides/start.md',
  originalUrl: '/d/en/guides/start.md',
  query,
  sessionID: 'download-session',
  user: { id: 5, permissions }
})

describe('common page downloads', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__router.get.mockClear()
    global.WIKI = {
      auth: {
        checkAccess: vi.fn((user, permissions) => permissions.every(permission => user?.permissions?.includes(permission))),
        getEffectivePermissions: vi.fn()
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
        knex: Object.assign(vi.fn(() => ({
          where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) })
        })), { client: { pool: { numFree: () => 1, numUsed: () => 0 } } }),
        pages: {
          getPageFromDb: vi.fn().mockResolvedValue(currentPage),
          getPage: vi.fn(),
          query: vi.fn()
        },
        pageHistory: { getVersion: vi.fn().mockResolvedValue(historicalPage) },
        users: { getUserAvatarData: vi.fn() },
        navigation: { getTree: vi.fn() },
        assets: { getAsset: vi.fn() }
      },
      data: {
        reservedPaths: [],
        commentProvider: { codeTemplate: '', head: '', body: '', main: '' }
      }
    }
  })

  const downloadHandler = async () => {
    const { default: createCommonController } = await vi.importFresh('../../controllers/common.ts', import.meta.url)
    createCommonController(global.WIKI)
    return express.__router.get.mock.calls.find(([path]) => Array.isArray(path) && path.includes('/d'))[1]
  }

  it('downloads the current Markdown source as canonical revision metadata', async () => {
    const download = await downloadHandler()
    const res = response()
    await download(request({}, ['read:source']), res)

    expect(res.attachment).toHaveBeenCalledWith('start.md')
    const document = res.send.mock.calls[0][0]
    expect(parseOkfDocument(document)).toMatchObject({
      body: '# Current\n',
      metadata: {
        type: 'Procedure', status: 'draft', title: 'Current guide', description: 'Current description', tags: ['current'],
        current_authority: { retained: true },
        'x-wiki': {
          published: true, editor: 'markdown', source_revision: '17',
          created_at: '2026-08-20T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z'
        }
      }
    })
  })

  it('maps historical aliases into canonical metadata for the exact revision', async () => {
    const download = await downloadHandler()
    const req = request({ v: '3' }, ['read:history'])
    const res = response()
    await download(req, res)

    expect(global.WIKI.models.pageHistory.getVersion).toHaveBeenCalledWith({ pageId: 7, versionId: 3, requester: req.user })
    const document = res.send.mock.calls[0][0]
    expect(parseOkfDocument(document)).toMatchObject({
      body: '# Historical\n',
      metadata: {
        type: 'Reference', status: 'stable', title: 'Historical guide', description: 'Historical description', tags: ['historical'],
        historical_authority: { retained: true },
        'x-wiki': {
          published: false, editor: 'asciidoc', source_revision: '9',
          created_at: '2026-08-21T00:00:00.000Z', updated_at: '2026-08-22T00:00:00.000Z'
        }
      }
    })
  })

  it('retains legacy string and JSON serialization for non-Markdown pages', async () => {
    const download = await downloadHandler()
    global.WIKI.models.pages.getPageFromDb.mockResolvedValueOnce({ ...currentPage, contentType: 'html', content: '<p>Legacy</p>' })
    const htmlResponse = response()
    await download(request({}, ['read:source']), htmlResponse)
    expect(htmlResponse.send).toHaveBeenCalledWith(expect.stringContaining('<!--\ntitle: Current guide'))
    expect(htmlResponse.send.mock.calls[0][0]).toContain('<p>Legacy</p>')

    global.WIKI.models.pages.getPageFromDb.mockResolvedValueOnce({ ...currentPage, contentType: 'json', content: { answer: 42 } })
    const jsonResponse = response()
    await download(request({}, ['read:source']), jsonResponse)
    expect(jsonResponse.send).toHaveBeenCalledWith({
      answer: 42,
      _meta: expect.objectContaining({ title: 'Current guide', published: 'true', editor: 'markdown' })
    })
  })

  it('rejects invalid claimed OKF authority instead of falling back', async () => {
    const download = await downloadHandler()
    global.WIKI.models.pages.getPageFromDb.mockResolvedValueOnce({ ...currentPage, extra: { okf: { type: '' } } })
    const res = response()

    await expect(download(request({}, ['read:source']), res)).rejects.toThrow('extra.okf must contain valid OKF metadata')
    expect(res.send).not.toHaveBeenCalled()
  })
})
