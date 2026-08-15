/** @vitest-environment node */

const { databaseInit } = vi.hoisted(() => ({ databaseInit: vi.fn() }))
vi.mock('../../core/db.ts', () => ({ default: { init: databaseInit } }))

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
const { default: rebuildTree } = await import('../../jobs/rebuild-tree.ts')

const renderModels = page => ({
  knex: { destroy: vi.fn().mockResolvedValue(undefined) },
  pages: {
    getPageFromDb: vi.fn().mockResolvedValue(page),
    query: vi.fn(),
    savePageToCache: vi.fn()
  },
  renderers: {
    fetchDefinitions: vi.fn(),
    getRenderingPipeline: vi.fn()
  }
})

describe('worker job database lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('releases render-page connections when the requested page is missing', async () => {
    const models = renderModels(null)
    databaseInit.mockResolvedValue(models)

    await expect(renderPage(17)).rejects.toThrow('Invalid Page Id')

    expect(models.knex.destroy).toHaveBeenCalledOnce()
  })

  it('skips empty pages without using a destroyed connection', async () => {
    const models = renderModels({ content: '', contentType: 'markdown' })
    databaseInit.mockResolvedValue(models)

    await renderPage(18)

    expect(models.renderers.fetchDefinitions).not.toHaveBeenCalled()
    expect(models.pages.query).not.toHaveBeenCalled()
    expect(models.knex.destroy).toHaveBeenCalledOnce()
  })

  it('releases rebuild-tree connections after a query failure', async () => {
    const failure = new Error('page query failed')
    const orderBy = vi.fn().mockRejectedValue(failure)
    const models = {
      knex: { destroy: vi.fn().mockResolvedValue(undefined), table: vi.fn() },
      pages: {
        query: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({ orderBy })
        })
      }
    }
    databaseInit.mockResolvedValue(models)

    await expect(rebuildTree()).rejects.toThrow('page query failed')

    expect(models.knex.destroy).toHaveBeenCalledOnce()
  })
})
