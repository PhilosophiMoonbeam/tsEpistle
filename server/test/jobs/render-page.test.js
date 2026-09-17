const { databaseInit } = vi.hoisted(() => ({ databaseInit: vi.fn() }))
vi.mockModule('../../core/db.ts', import.meta.url, () => ({ default: { init: databaseInit } }))

vi.mockModule('../../modules/rendering/html-core/renderer.ts', import.meta.url, () => ({ default: { render() { return this.input } } }))

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

const pageWriteQuery = () => {
  const filters = {}
  let values
  const query = {
    patch (patch) {
      // Reproduce Page.$beforeUpdate: model writes advance editorial time.
      values = { ...patch, updatedAt: 'after-render' }
      return query
    },
    update (patch) {
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
        currentPage = { ...currentPage, ...values }
        successfulWrites += 1
      }
      return Promise.resolve(matches ? 1 : 0).then(resolve, reject)
    }
  }
  return query
}
const pages = {
  getPageFromDb: vi.fn(async pageId => currentPage?.id === pageId ? { ...currentPage } : null),
  query: vi.fn(pageWriteQuery),
  savePageToCache
}

const models = {
  knex: Object.assign(vi.fn(pageWriteQuery), { destroy: vi.fn().mockResolvedValue(undefined) }),
  pages,
  renderers: {
    fetchDefinitions: vi.fn().mockResolvedValue(undefined),
    getRenderingPipeline: vi.fn(async contentType => {
      if (contentType === 'paused-revision') {
        firstRenderPaused.resolve()
        await resumeFirstRender.promise
      }
      return [{ key: 'htmlCore', config: {}, children: [] }]
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
      updatedAt: 'before-render',
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
      updatedAt: 'before-render'
    }))

    resumeFirstRender.resolve()
    await staleRender
    expect(pages.getPageFromDb).toHaveBeenCalledTimes(3)

    expect(successfulWrites).toBe(1)
    expect(currentPage.render).toBe('<p>revision 2</p>')
    expect(savePageToCache).toHaveBeenCalledOnce()
  })
  it('updates derived rendering without changing editorial time or source', async () => {
    currentPage = {
      id: 44,
      sourceRevision: 7,
      renderedSourceRevision: null,
      content: '<h1>Current source</h1>',
      contentType: 'markdown',
      render: '<p>Old render</p>',
      updatedAt: '2026-09-01T09:00:00.000Z'
    }
    databaseInit.mockResolvedValue(models)

    await renderPage(44)

    expect(currentPage).toMatchObject({
      sourceRevision: 7,
      renderedSourceRevision: 7,
      content: '<h1>Current source</h1>',
      render: '<h1>Current source</h1>',
      updatedAt: '2026-09-01T09:00:00.000Z'
    })
    expect(savePageToCache).toHaveBeenCalledWith(expect.objectContaining({
      renderedSourceRevision: 7,
      updatedAt: '2026-09-01T09:00:00.000Z'
    }))
    expect(pages.query).not.toHaveBeenCalled()
  })
  it('preserves stored output when no parser can transform the source', async () => {
    currentPage = { id: 43, sourceRevision: 1, content: '<script>unsafe()</script>', contentType: 'markdown', render: '<p>Existing output</p>' }
    databaseInit.mockResolvedValue(models)
    models.renderers.getRenderingPipeline.mockResolvedValueOnce([])
    await expect(renderPage(43)).rejects.toThrow('No enabled rendering pipeline')
    expect(currentPage.render).toBe('<p>Existing output</p>')
    expect(pages.query).not.toHaveBeenCalled()
    expect(savePageToCache).not.toHaveBeenCalled()
    expect(models.knex.destroy).toHaveBeenCalledOnce()
  })

})
