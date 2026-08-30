const { databaseInit } = vi.hoisted(() => ({ databaseInit: vi.fn() }))
vi.mockModule('../../core/db.ts', import.meta.url, () => ({ default: { init: databaseInit } }))

const deferred = () => {
  let resolve
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const firstRenderPaused = deferred()
const resumeFirstRender = deferred()
const savePageToCache = vi.fn().mockResolvedValue(undefined)
let currentPage
let successfulWrites

const pages = {
  getPageFromDb: vi.fn(async pageId => currentPage?.id === pageId ? { ...currentPage } : null),
  query: vi.fn(() => {
    const filters = {}
    let values
    const query = {
      patch (patch) {
        values = patch
        return query
      },
      where (column, value) {
        filters[column] = value
        return query
      },
      then (resolve, reject) {
        const matches = currentPage?.id === filters.id &&
          (!Object.hasOwn(filters, 'sourceRevision') ||
            String(currentPage.sourceRevision) === String(filters.sourceRevision))
        if (matches) {
          currentPage = { ...currentPage, ...values, updatedAt: 'after-render' }
          successfulWrites += 1
        }
        return Promise.resolve(matches ? 1 : 0).then(resolve, reject)
      }
    }
    return query
  }),
  savePageToCache
}

const models = {
  knex: { destroy: vi.fn().mockResolvedValue(undefined) },
  pages,
  renderers: {
    fetchDefinitions: vi.fn().mockResolvedValue(undefined),
    getRenderingPipeline: vi.fn(async contentType => {
      if (contentType === 'paused-revision') {
        firstRenderPaused.resolve()
        await resumeFirstRender.promise
      }
      return []
    })
  }
}

global.WIKI = {
  config: { db: { type: 'postgres' } },
  configSvc: {
    applyFlags: vi.fn().mockResolvedValue(undefined),
    loadFromDb: vi.fn().mockResolvedValue(undefined)
  },
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  },
  models: {}
}

const { default: renderPage } = await import('../../jobs/render-page.ts')

describe('render-page revision fence', () => {
  it('does not let an older overlapping render overwrite the current database row or cache', async () => {
    currentPage = {
      id: 42,
      sourceRevision: 1,
      content: '<p>revision 1</p>',
      contentType: 'paused-revision',
      path: 'docs/revisions',
      render: ''
    }
    successfulWrites = 0
    databaseInit.mockResolvedValue(models)

    const staleRender = renderPage(42)
    await firstRenderPaused.promise

    currentPage = {
      ...currentPage,
      sourceRevision: 2,
      content: '<p>revision 2</p>',
      contentType: 'current-revision'
    }
    await renderPage(42)
    expect(pages.getPageFromDb).toHaveBeenCalledTimes(3)

    expect(successfulWrites).toBe(1)
    expect(currentPage.render).toBe('<p>revision 2</p>')
    expect(savePageToCache).toHaveBeenCalledOnce()
    expect(savePageToCache).toHaveBeenCalledWith(expect.objectContaining({
      sourceRevision: 2,
      content: '<p>revision 2</p>',
      render: '<p>revision 2</p>',
      updatedAt: 'after-render'
    }))

    resumeFirstRender.resolve()
    await staleRender
    expect(pages.getPageFromDb).toHaveBeenCalledTimes(3)

    expect(successfulWrites).toBe(1)
    expect(currentPage.render).toBe('<p>revision 2</p>')
    expect(savePageToCache).toHaveBeenCalledOnce()
  })
})
