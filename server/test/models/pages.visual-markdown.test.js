import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from '../bun-test.mts'

const originalWIKI = global.WIKI

const requester = { id: 7, name: 'Owner', email: 'owner@example.com', permissions: [] }
const basePage = {
  id: 17,
  authorId: 7,
  content: '# Supported\n',
  contentType: 'markdown',
  description: '',
  editorKey: 'markdown',
  extra: {},
  hash: 'private:7:en:page',
  isPublished: true,
  localeCode: 'en',
  ownerId: 7,
  path: 'page',
  publishEndDate: '',
  publishStartDate: '',
  render: '<h1>Supported</h1>',
  title: 'Page',
  updatedAt: '2026-08-14T00:00:00.000Z',
  visibility: 'private'
}

describe('Visual Markdown page contracts', () => {
  let Page

  beforeEach(async () => {
    vi.resetModules()
    let insertedProjection
    const knex = vi.fn(table => {
      if (table === 'pages') {
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              forUpdate: vi.fn().mockReturnValue({
                first: vi.fn().mockResolvedValue({ ...basePage, sourceRevision: '2' })
              })
            })
          })
        }
      }
      if (table === 'pageMutationOutbox') {
        return {
          insert: vi.fn(row => {
            insertedProjection = row
            return { onConflict: vi.fn().mockReturnValue({ ignore: vi.fn().mockResolvedValue([]) }) }
          }),
          where: vi.fn().mockReturnValue({ first: vi.fn(async () => insertedProjection) })
        }
      }
      return { insert: vi.fn().mockResolvedValue(1) }
    })
    knex.transaction = vi.fn(callback => callback(knex))
    global.WIKI = {
      ROOTPATH: '/test',
      Error: {
        PageDeleteForbidden: Error,
        PageDuplicateCreate: Error,
        PageEmptyContent: Error,
        PageIllegalPath: Error,
        PageMoveForbidden: Error,
        PageNotFound: Error,
        PagePathCollision: Error,
        PageUpdateForbidden: Error
      },
      auth: { checkAccess: vi.fn().mockReturnValue(true) },
      config: { dataPath: '/test/data', db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {
        editors: [
          { key: 'markdown', contentType: 'markdown' },
          { key: 'visual-markdown', contentType: 'markdown' },
          { key: 'ckeditor', contentType: 'html' }
        ],
        reservedPaths: [],
        searchEngine: { created: vi.fn(), updated: vi.fn(), deleted: vi.fn(), renamed: vi.fn() }
      },
      events: { inbound: new EventEmitter(), outbound: new EventEmitter() },
      logger: { error: vi.fn(), warn: vi.fn() },
      models: {
        comments: {},
        knex,
        pageHistory: { addVersion: vi.fn() },
        pages: {},
        storage: { pageEvent: vi.fn() },
        tags: {}
      },
      scheduler: { registerJob: vi.fn() }
    }
    Page = (await vi.importFresh('../../models/pages.ts', import.meta.url)).default
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalWIKI === undefined) delete global.WIKI
    else global.WIKI = originalWIKI
  })

  function arrangeConversion (page) {
    const where = vi.fn().mockResolvedValue(1)
    const patch = vi.fn().mockReturnValue({ where })
    const query = vi.fn()
      .mockReturnValueOnce({ findById: vi.fn().mockResolvedValue(page) })
      .mockReturnValueOnce({ patch })
    const convertedPage = { ...page, hash: `${page.hash}:converted` }

    global.WIKI.models.pages = {
      query,
      getPageFromDb: vi.fn().mockResolvedValue(convertedPage),
      deletePageFromCache: vi.fn().mockResolvedValue(undefined)
    }

    return { patch, where }
  }

  function arrangeUpdate (page, editorKey) {
    const pagePatch = {
      where: vi.fn(),
      then: resolve => Promise.resolve(1).then(resolve)
    }
    pagePatch.where.mockReturnValue(pagePatch)
    const updatedPage = {
      ...page,
      content: 'Math: $x + y$',
      editorKey,
      updatedAt: '2026-08-14T00:00:01.000Z'
    }
    global.WIKI.models.pages = {
      query: vi.fn()
        .mockReturnValueOnce({ findById: vi.fn().mockResolvedValue(page) })
        .mockReturnValueOnce({ patch: vi.fn().mockReturnValue(pagePatch) })
        .mockReturnValueOnce({
          findById: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({ updatedAt: updatedPage.updatedAt })
          })
        }),
      getPageFromDb: vi.fn().mockResolvedValue(updatedPage),
      renderPage: vi.fn().mockResolvedValue(undefined)
    }
    global.WIKI.models.knex.table = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue(1) })
    })
  }

  it('changes Markdown to Visual Markdown without rewriting content or creating a conversion snapshot', async () => {
    const { patch } = arrangeConversion(basePage)

    await Page.convertPage({ id: basePage.id, editor: 'visual-markdown', user: requester })

    expect(patch).toHaveBeenCalledWith({
      contentType: 'markdown',
      editorKey: 'visual-markdown'
    })
    expect(global.WIKI.models.pageHistory.addVersion).not.toHaveBeenCalled()
  })

  it('changes extended Markdown to Visual Markdown without rewriting content', async () => {
    const page = { ...basePage, content: '## Callout\n{.is-info}' }
    const { patch } = arrangeConversion(page)

    await Page.convertPage({ id: page.id, editor: 'visual-markdown', user: requester })

    expect(patch).toHaveBeenCalledWith({
      contentType: 'markdown',
      editorKey: 'visual-markdown'
    })
    expect(global.WIKI.models.pageHistory.addVersion).not.toHaveBeenCalled()
  })

  it('converts Visual HTML content to Markdown before selecting Visual Markdown', async () => {
    const page = {
      ...basePage,
      content: '<h1>Visual page</h1><p>Text with <strong>bold</strong>.</p>',
      contentType: 'html',
      editorKey: 'ckeditor'
    }
    const { patch } = arrangeConversion(page)

    await Page.convertPage({ id: page.id, editor: 'visual-markdown', user: requester })

    expect(patch).toHaveBeenCalledWith({
      contentType: 'markdown',
      editorKey: 'visual-markdown',
      content: '# Visual page\n\nText with **bold**.'
    })
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledOnce()
  })
  it('converts rendered Visual Markdown to HTML before selecting Visual HTML', async () => {
    const page = {
      ...basePage,
      editorKey: 'visual-markdown',
      render: '<h1>Visual Markdown</h1><p>Rendered text.</p>'
    }
    const { patch } = arrangeConversion(page)
    expect(page.contentType).toBe('markdown')
    expect(global.WIKI.data.editors.find(editor => editor.key === 'ckeditor')?.contentType).toBe('html')

    await Page.convertPage({ id: page.id, editor: 'ckeditor', user: requester })

    expect(patch).toHaveBeenCalledWith({
      contentType: 'html',
      editorKey: 'ckeditor',
      content: '<h1>Visual Markdown</h1><p>Rendered text.</p>'
    })
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledOnce()
  })


  it('accepts extended content when a Visual Markdown page is updated', async () => {
    arrangeUpdate({
      ...basePage,
      editorKey: 'visual-markdown'
    }, 'visual-markdown')

    const page = await Page.updatePage({
      id: basePage.id,
      user: requester,
      content: 'Math: $x + y$'
    })

    expect(page.content).toBe('Math: $x + y$')
    expect(page.editorKey).toBe('visual-markdown')
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledOnce()
  })

  it('accepts extended content when a revision switches into Visual Markdown', async () => {
    arrangeUpdate(basePage, 'visual-markdown')

    const page = await Page.updatePage({
      id: basePage.id,
      user: requester,
      content: 'Math: $x + y$',
      editor: 'visual-markdown'
    })

    expect(page.editorKey).toBe('visual-markdown')
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledOnce()
  })

  it('rejects a stale expected timestamp before opening the update transaction', async () => {
    global.WIKI.models.pages = {
      query: vi.fn().mockReturnValue({ findById: vi.fn().mockResolvedValue(basePage) })
    }

    await expect(Promise.resolve(Page.updatePage({
      id: basePage.id,
      user: requester,
      content: '# Restored',
      expectedUpdatedAt: '2026-08-14T00:00:01.000Z'
    }))).rejects.toMatchObject({ name: 'PageUpdateConflict', status: 409 })

    expect(global.WIKI.models.knex.transaction).not.toHaveBeenCalled()
    expect(global.WIKI.models.pageHistory.addVersion).not.toHaveBeenCalled()
  })

  it('stops the transaction before tag mutation when the atomic timestamp guard loses a race', async () => {
    const pagePatch = {
      where: vi.fn(),
      then: resolve => resolve(0)
    }
    pagePatch.where.mockReturnValue(pagePatch)
    const query = vi.fn()
      .mockReturnValueOnce({ findById: vi.fn().mockResolvedValue(basePage) })
      .mockReturnValueOnce({ patch: vi.fn().mockReturnValue(pagePatch) })
    global.WIKI.models.pages = { query }
    global.WIKI.models.tags = { associateTags: vi.fn() }

    await expect(Promise.resolve(Page.updatePage({
      id: basePage.id,
      user: requester,
      content: '# Restored',
      tags: ['release'],
      expectedUpdatedAt: basePage.updatedAt
    }))).rejects.toMatchObject({ name: 'PageUpdateConflict', status: 409 })

    expect(pagePatch.where).toHaveBeenNthCalledWith(1, 'id', basePage.id)
    expect(pagePatch.where).toHaveBeenNthCalledWith(2, 'updatedAt', basePage.updatedAt)
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledOnce()
    expect(global.WIKI.models.tags.associateTags).not.toHaveBeenCalled()
  })
})
