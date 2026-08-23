describe('page search visibility', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('drops stale private search documents and their suggestions', async () => {
    const whereBuilder = {
      where: vi.fn(),
      andWhere: vi.fn(callback => {
        callback({ orWhere: vi.fn() })
      })
    }
    const livePublicPages = [{ id: 3, localeCode: 'en', path: 'public-page', title: 'Public Page', description: '' }]
    const pageQuery = {
      select: vi.fn().mockReturnThis(),
      modify: vi.fn(callback => {
        callback(whereBuilder)
        return Promise.resolve(livePublicPages)
      })
    }
    global.WIKI = {
      auth: {
        checkAccess: vi.fn().mockReturnValue(true)
      },
      config: {
        db: { type: 'postgres' },
        lang: { code: 'en' }
      },
      data: {
        searchEngine: {
          query: vi.fn().mockResolvedValue({
            results: [
              { id: 2, locale: 'en', path: 'private-page', title: 'Private Secret' },
              { id: 99, locale: 'en', path: 'public-page', title: 'Stale Indexed Title', description: 'Stale indexed description' }
            ],
            suggestions: ['private-secret'],
            totalHits: 2
          })
        }
      },
      models: {
        knex: vi.fn().mockResolvedValue([]),
        pages: {
          query: vi.fn().mockReturnValue(pageQuery)
        }
      }
    }

    const { default: operations } = await import('../operations/pages.ts')
    const result = await operations.search({ query: 'secret' })

    expect(result).toEqual({
      results: [{ id: 3, locale: 'en', path: 'public-page', title: 'Public Page', description: '', visibility: 'public' }],
      suggestions: [],
      totalHits: 1
    })
    expect(whereBuilder.where).toHaveBeenCalledWith({ visibility: 'public' })
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledTimes(1)
  })

  it('does not reveal protected pages through indexed content terms', async () => {
    const whereBuilder = {
      where: vi.fn(),
      andWhere: vi.fn(callback => callback({ orWhere: vi.fn() }))
    }
    const pageQuery = {
      select: vi.fn().mockReturnThis(),
      modify: vi.fn(callback => {
        callback(whereBuilder)
        return Promise.resolve([{ id: 3, localeCode: 'en', path: 'public-page', title: 'Public Page', description: 'Visible metadata' }])
      })
    }
    global.WIKI = {
      auth: { checkAccess: vi.fn().mockReturnValue(true) },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {
        searchEngine: {
          query: vi.fn().mockResolvedValue({
            results: [{ id: 3, locale: 'en', path: 'public-page', title: 'Public Page' }],
            suggestions: ['classified-content'],
            totalHits: 1
          })
        }
      },
      models: {
        knex: vi.fn().mockResolvedValue([{ pageId: 3 }]),
        pages: { query: vi.fn().mockReturnValue(pageQuery) }
      }
    }

    const { default: operations } = await import('../operations/pages.ts')
    await expect(operations.search({ query: 'classified' })).resolves.toEqual({
      results: [],
      suggestions: [],
      totalHits: 0
    })
  })
})
