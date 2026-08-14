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
    const livePublicPages = [{ localeCode: 'en', path: 'public-page' }]
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
              { id: 3, locale: 'en', path: 'public-page', title: 'Public Page' }
            ],
            suggestions: ['private-secret'],
            totalHits: 2
          })
        }
      },
      models: {
        pages: {
          query: vi.fn().mockReturnValue(pageQuery)
        }
      }
    }

    const { default: operations } = await import('../operations/pages.ts')
    const result = await operations.search({ query: 'secret' })

    expect(result).toEqual({
      results: [{ id: 3, locale: 'en', path: 'public-page', title: 'Public Page', visibility: 'public' }],
      suggestions: [],
      totalHits: 1
    })
    expect(whereBuilder.where).toHaveBeenCalledWith({ visibility: 'public' })
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledTimes(1)
  })
})
