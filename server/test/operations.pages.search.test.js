describe('page search visibility', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  const installPrivateSearchWiki = ({ rankRows, pages, isManager = false, publicResponse } = {}) => {
    const pathScope = {
      where: vi.fn().mockReturnThis(),
      orWhere: vi.fn().mockReturnThis()
    }
    const whereBuilder = {
      whereIn: vi.fn().mockReturnThis(),
      andWhere: vi.fn(value => {
        if (typeof value === 'function') value(pathScope)
        return whereBuilder
      })
    }
    const tagBuilder = {
      select: vi.fn().mockReturnThis()
    }
    const pageQuery = {
      column: vi.fn().mockReturnThis(),
      withGraphJoined: vi.fn().mockReturnThis(),
      modifyGraph: vi.fn((_relation, callback) => {
        callback(tagBuilder)
        return pageQuery
      }),
      modify: vi.fn(callback => {
        callback(whereBuilder)
        return Promise.resolve(pages ?? [])
      })
    }
    const knex = vi.fn().mockResolvedValue([])
    knex.raw = vi.fn().mockResolvedValue({ rows: rankRows ?? [] })
    const searchEngine = {
      query: vi.fn().mockResolvedValue(publicResponse ?? { results: [], suggestions: [], totalHits: 0 })
    }
    global.WIKI = {
      auth: {
        checkAccess: vi.fn((_requester, permissions) =>
          permissions.includes('manage:system') ? isManager : true
        )
      },
      config: { db: { type: 'postgres' }, lang: { code: 'en' }, search: { maxHits: 100 } },
      data: { searchEngine },
      models: {
        knex,
        pages: { query: vi.fn().mockReturnValue(pageQuery) }
      }
    }
    return { knex, pageQuery, pathScope, searchEngine, tagBuilder, whereBuilder }
  }

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

  it('treats private query and path wildcards literally before hydrating complete tags', async () => {
    const pages = [
      {
        id: 21,
        locale: 'en',
        localeCode: 'en',
        path: 'teams/%_\\root/entry',
        title: '50%_\\Draft',
        description: '',
        visibility: 'private',
        ownerId: 7,
        tags: [{ tag: 'release' }, { tag: '50%_\\draft' }]
      }
    ]
    const { knex, pageQuery, pathScope, searchEngine, tagBuilder, whereBuilder } = installPrivateSearchWiki({
      rankRows: [{ id: 21, score: 17 }],
      pages
    })

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const response = await operations.search({
      requester: { id: 7 },
      query: '50%_\\draft',
      locale: 'en',
      path: 'teams/%_\\root'
    })

    expect(response).toMatchObject({
      results: [{
        id: 21,
        visibility: 'private',
        tags: ['50%_\\draft', 'release'],
        score: 17,
        matchedFields: ['title', 'tag']
      }],
      totalHits: 1,
      windowLimit: 150,
      windowTruncated: false
    })
    const [sql, bindings] = knex.raw.mock.calls[0]
    expect(sql).toContain("page.title ILIKE input.contains_query ESCAPE '\\'")
    expect(sql).toContain("tag.tag ILIKE input.contains_query ESCAPE '\\'")
    expect(sql).toContain("(page.path = ? OR page.path LIKE ? ESCAPE '\\')")
    expect(sql).toContain('page."ownerId" = ?')
    expect(sql).toContain('page."localeCode" = ?')
    expect(bindings).toEqual([
      '50\\%\\_\\\\draft',
      '50\\%\\_\\\\draft%',
      '%50\\%\\_\\\\draft%',
      7,
      'en',
      'teams/%_\\root',
      'teams/\\%\\_\\\\root/%',
      50
    ])
    expect(whereBuilder.whereIn).toHaveBeenCalledWith('pages.id', [21])
    expect(whereBuilder.andWhere).toHaveBeenCalledWith('pages.visibility', 'private')
    expect(whereBuilder.andWhere).toHaveBeenCalledWith('pages.ownerId', 7)
    expect(whereBuilder.andWhere).toHaveBeenCalledWith('pages.localeCode', 'en')
    expect(pathScope.where).toHaveBeenCalledWith('pages.path', 'teams/%_\\root')
    expect(pathScope.orWhere).toHaveBeenCalledWith('pages.path', 'LIKE', 'teams/\\%\\_\\\\root/%')
    expect(pageQuery.withGraphJoined).toHaveBeenCalledWith('tags')
    expect(tagBuilder.select).toHaveBeenCalledWith('tag')
    expect(searchEngine.query).toHaveBeenCalledWith(
      '50%_\\draft',
      expect.objectContaining({ locale: 'en', path: 'teams/%_\\root' })
    )
  })

  it('selects a deterministic 50-page relevance window before hydrating unique pages', async () => {
    const rankRows = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      score: index < 3 ? [10, 6, 1][index] : 0
    }))
    const pages = rankRows
      .map(({ id }) => ({
        id,
        locale: 'en',
        localeCode: 'en',
        path: `private/page-${String(id).padStart(2, '0')}`,
        title: id === 1 ? 'Runbook' : id === 2 ? 'Runbook Prefix' : id === 3 ? 'Content Fallback' : `Page ${id}`,
        description: '',
        visibility: 'private',
        ownerId: 7,
        tags: id === 1 ? [{ tag: 'complete-a' }, { tag: 'complete-b' }] : []
      }))
      .reverse()
    const { knex, pageQuery, whereBuilder } = installPrivateSearchWiki({ rankRows, pages })

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const response = await operations.search({ requester: { id: 7 }, query: 'runbook' })

    expect(response.results).toHaveLength(50)
    expect(response.results.slice(0, 3).map(result => result.id)).toEqual([1, 2, 3])
    expect(response.results[0].tags).toEqual(['complete-a', 'complete-b'])
    expect(new Set(response.results.map(result => result.id)).size).toBe(50)
    expect(response.windowTruncated).toBe(true)
    const [sql, bindings] = knex.raw.mock.calls[0]
    expect(sql).toContain('LEFT JOIN LATERAL')
    expect(sql).toContain('WHEN matched.title_exact THEN 10.0 WHEN matched.title_prefix THEN 6.0')
    expect(sql).toContain('WHEN matched.tag_exact THEN 7.0 WHEN matched.tag_prefix THEN 3.0')
    expect(sql).toContain('matched.content_contains AND NOT')
    expect(sql).toContain('ORDER BY score DESC, title_order, path_order, id')
    expect(sql).toContain('LIMIT ?')
    expect(bindings.at(-1)).toBe(50)
    expect(whereBuilder.whereIn).toHaveBeenCalledWith('pages.id', rankRows.map(row => row.id))
    expect(pageQuery).not.toHaveProperty('limit')
  })

  it('lets system managers search every private owner without requiring publication', async () => {
    const page = {
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
    }
    const { knex, whereBuilder } = installPrivateSearchWiki({
      rankRows: [{ id: 22, score: 6 }],
      pages: [page],
      isManager: true
    })

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const response = await operations.search({ requester: { id: 2 }, query: 'draft' })

    expect(response.results).toEqual([
      expect.objectContaining({ id: 22, visibility: 'private', title: 'Managed Private Draft' })
    ])
    const [sql, bindings] = knex.raw.mock.calls[0]
    expect(sql).toContain("page.visibility = 'private'")
    expect(sql).not.toContain('page."ownerId" = ?')
    expect(sql).not.toContain('page."isPublished"')
    expect(bindings).toEqual(['draft', 'draft%', '%draft%', 50])
    expect(whereBuilder.andWhere).not.toHaveBeenCalledWith('pages.ownerId', expect.anything())
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
      sourceRevision: '1',
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
      '1',
      'unpublished-unique-path',
      'Unpublished Unique Title',
      'unpublished-unique-description',
      ['unpublished-unique-tag'],
      'unpublished-unique-body'
    ]))
    expect(upsert?.[1][1]).toBe('1')

    deletedTables.length = 0
    transactionClient.raw.mockClear()
    page.isPublished = false
    await engine.updated(page)
    expect(transactionClient.raw).not.toHaveBeenCalled()
    expect(deletedTables).toEqual([['pagesWords', 41], ['pagesVector', 41]])
  })

})
