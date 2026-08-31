describe('page search visibility', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('propagates the original provider query failure', async () => {
    const failure = new Error('provider query failed')
    const query = vi.fn().mockRejectedValue(failure)
    const knex = vi.fn()
    global.WIKI = {
      auth: { checkAccess: vi.fn().mockReturnValue(true) },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: { searchEngine: { query } },
      models: {
        knex,
        pages: { query: vi.fn() }
      }
    }

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)

    await expect(operations.search({ query: 'runbook' })).rejects.toBe(failure)
    expect(query).toHaveBeenCalledWith('runbook', { query: 'runbook' })
    expect(knex).not.toHaveBeenCalled()
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
      withGraphJoined: vi.fn().mockReturnThis(),
      modifyGraph: vi.fn().mockReturnThis(),
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
              { id: 99, locale: 'en', path: 'public-page', title: 'Stale Indexed Title', description: 'Stale indexed description' },
              { id: 4, locale: 'en', path: 'unpublished-unique-path', title: 'Unpublished Unique Title', tags: ['unpublished-unique-tag'] }
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

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const result = await operations.search({ query: 'secret' })

    expect(result).toEqual({
      results: [{ id: 3, locale: 'en', path: 'public-page', title: 'Public Page', description: '', visibility: 'public', tags: [], score: 1, matchedFields: ['content'] }],
      suggestions: [],
      totalHits: 1,
      windowLimit: 100,
      windowTruncated: false
    })
    expect(whereBuilder.where).toHaveBeenCalledWith({ visibility: 'public', isPublished: true })
    expect(pageQuery.select).toHaveBeenCalledWith('pages.id', 'pages.localeCode', 'pages.path', 'pages.title', 'pages.description')
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledTimes(1)
  })

  it('does not reveal protected pages through indexed content terms', async () => {
    const whereBuilder = {
      where: vi.fn(),
      andWhere: vi.fn(callback => callback({ orWhere: vi.fn() }))
    }
    const pageQuery = {
      select: vi.fn().mockReturnThis(),
      withGraphJoined: vi.fn().mockReturnThis(),
      modifyGraph: vi.fn().mockReturnThis(),
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

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    expect(await operations.search({ query: 'classified' })).toEqual({
      results: [],
      suggestions: [],
      totalHits: 0,
      windowLimit: 100,
      windowTruncated: false
    })
  })

  it('preserves lexical evidence and deterministically reranks stronger tag matches', async () => {
    const whereBuilder = {
      where: vi.fn(),
      andWhere: vi.fn(callback => callback({ orWhere: vi.fn() }))
    }
    const livePublicPages = [
      { id: 10, localeCode: 'en', path: 'notes/content', title: 'Content Note', description: '', tags: [] },
      { id: 11, localeCode: 'en', path: 'runbooks/falcon', title: 'Falcon Runbook', description: '', tags: [{ tag: 'amber-falcon' }] }
    ]
    const pageQuery = {
      select: vi.fn().mockReturnThis(),
      withGraphJoined: vi.fn().mockReturnThis(),
      modifyGraph: vi.fn().mockReturnThis(),
      modify: vi.fn(callback => {
        callback(whereBuilder)
        return Promise.resolve(livePublicPages)
      })
    }
    global.WIKI = {
      auth: { checkAccess: vi.fn().mockReturnValue(true) },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {
        searchEngine: {
          query: vi.fn().mockResolvedValue({
            results: [
              { id: 10, locale: 'en', path: 'notes/content', score: 1, tags: [], matchedFields: ['content'] },
              { id: 11, locale: 'en', path: 'runbooks/falcon', score: 8, tags: ['amber-falcon'], matchedFields: ['tag', 'graph'] }
            ],
            suggestions: [],
            totalHits: 2
          })
        }
      },
      models: {
        knex: vi.fn().mockResolvedValue([]),
        pages: { query: vi.fn().mockReturnValue(pageQuery) }
      }
    }

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const response = await operations.search({ query: 'amber' })

    expect(response.results.map(result => result.id)).toEqual([11, 10])
    expect(response.results[0]).toMatchObject({
      tags: ['amber-falcon'],
      score: 8,
      matchedFields: ['tag', 'graph']
    })
  })

  it('matches caller-owned private pages by locale-scoped path and tag', async () => {
    const nested = {
      where: vi.fn().mockReturnThis(),
      orWhere: vi.fn().mockReturnThis()
    }
    const whereBuilder = {
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn(value => {
        if (typeof value === 'function') value(nested)
        return whereBuilder
      })
    }
    const privateQuery = {
      column: vi.fn().mockReturnThis(),
      withGraphJoined: vi.fn().mockReturnThis(),
      modifyGraph: vi.fn().mockReturnThis(),
      modify: vi.fn(callback => {
        callback(whereBuilder)
        return privateQuery
      }),
      limit: vi.fn(async () => [{
        id: 21,
        locale: 'en',
        localeCode: 'en',
        path: 'private/runbook',
        title: 'Personal Notes',
        description: '',
        visibility: 'private',
        ownerId: 7,
        tags: [{ tag: 'runbook' }]
      }])
    }
    const searchEngine = {
      query: vi.fn().mockResolvedValue({ results: [], suggestions: [], totalHits: 0 })
    }
    global.WIKI = {
      auth: { checkAccess: vi.fn((_requester, permissions) => !permissions.includes('manage:system')) },
      config: { db: { type: 'postgres' }, lang: { code: 'en' }, search: { maxHits: 100 } },
      data: { searchEngine },
      models: {
        knex: vi.fn().mockResolvedValue([]),
        pages: { query: vi.fn().mockReturnValue(privateQuery) }
      }
    }

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const response = await operations.search({
      requester: { id: 7 },
      query: 'runbook',
      locale: 'en',
      path: 'private'
    })

    expect(response).toMatchObject({
      results: [{ id: 21, visibility: 'private', tags: ['runbook'], matchedFields: ['tag', 'path'] }],
      totalHits: 1,
      windowLimit: 150,
      windowTruncated: false
    })
    expect(whereBuilder.andWhere).toHaveBeenCalledWith('localeCode', 'en')
    expect(nested.orWhere).toHaveBeenCalledWith('tags.tag', 'ILIKE', '%runbook%')
    expect(whereBuilder.andWhere).toHaveBeenCalledWith('ownerId', 7)
    expect(searchEngine.query).toHaveBeenCalledWith('runbook', expect.objectContaining({ locale: 'en', path: 'private' }))
  })

  it('keeps unpublished private pages searchable for system managers', async () => {
    const whereBuilder = {
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis()
    }
    const privateQuery = {
      column: vi.fn().mockReturnThis(),
      withGraphJoined: vi.fn().mockReturnThis(),
      modifyGraph: vi.fn().mockReturnThis(),
      modify: vi.fn(callback => {
        callback(whereBuilder)
        return privateQuery
      }),
      limit: vi.fn(async () => [{
        id: 22,
        locale: 'en',
        localeCode: 'en',
        path: 'managed-private',
        title: 'Managed Private Draft',
        description: '',
        isPublished: false,
        visibility: 'private',
        ownerId: 7,
        tags: []
      }])
    }
    global.WIKI = {
      auth: { checkAccess: vi.fn((_requester, permissions) => permissions.includes('manage:system')) },
      config: { db: { type: 'postgres' }, lang: { code: 'en' }, search: { maxHits: 100 } },
      data: { searchEngine: { query: vi.fn().mockResolvedValue({ results: [], suggestions: [], totalHits: 0 }) } },
      models: {
        knex: vi.fn().mockResolvedValue([]),
        pages: { query: vi.fn().mockReturnValue(privateQuery) }
      }
    }

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const response = await operations.search({ requester: { id: 2 }, query: 'draft' })

    expect(response.results).toEqual([
      expect.objectContaining({ id: 22, visibility: 'private', title: 'Managed Private Draft' })
    ])
    expect(whereBuilder.where).toHaveBeenCalledWith({ visibility: 'private' })
    expect(whereBuilder.andWhere).not.toHaveBeenCalledWith('ownerId', expect.anything())
    expect(whereBuilder.andWhere).not.toHaveBeenCalledWith('isPublished', expect.anything())
  })

  it('upserts a public page only while it is published', async () => {
    const deletedTables = []
    const transactionClient = vi.fn(table => ({
      where: vi.fn(({ pageId }) => ({
        delete: vi.fn(async () => {
          deletedTables.push([table, pageId])
        })
      }))
    }))
    transactionClient.raw = vi.fn().mockResolvedValue({ rows: [] })
    const knex = vi.fn()
    knex.transaction = vi.fn(callback => callback(transactionClient))
    global.WIKI = {
      config: { db: { type: 'postgres' }, search: { maxHits: 100 } },
      Error: { SearchActivationFailed: Error },
      logger: { info: vi.fn(), warn: vi.fn() },
      models: { knex }
    }

    const { default: engine } = await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)
    engine.config = { dictLanguage: 'english' }
    const page = {
      id: 41,
      visibility: 'public',
      isPublished: false,
      path: 'unpublished-unique-path',
      localeCode: 'en',
      title: 'Unpublished Unique Title',
      description: 'unpublished-unique-description',
      safeContent: 'unpublished-unique-body',
      tags: [{ tag: 'unpublished-unique-tag' }]
    }

    await engine.created(page)
    expect(transactionClient.raw).not.toHaveBeenCalled()
    expect(deletedTables).toEqual([['pagesWords', 41], ['pagesVector', 41]])

    deletedTables.length = 0
    page.isPublished = true
    await engine.updated(page)
    const upsert = transactionClient.raw.mock.calls.find(([statement]) => statement.includes('INSERT INTO "pagesVector"'))
    expect(upsert?.[1]).toEqual(expect.arrayContaining([
      41,
      'unpublished-unique-path',
      'Unpublished Unique Title',
      'unpublished-unique-description',
      ['unpublished-unique-tag'],
      'unpublished-unique-body'
    ]))

    deletedTables.length = 0
    transactionClient.raw.mockClear()
    page.isPublished = false
    await engine.updated(page)
    expect(transactionClient.raw).not.toHaveBeenCalled()
    expect(deletedTables).toEqual([['pagesWords', 41], ['pagesVector', 41]])
  })

})
