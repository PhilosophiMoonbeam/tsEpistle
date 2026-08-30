const originalWiki = global.WIKI

const knexHarness = (options = {}) => {
  const truncate = vi.fn().mockResolvedValue(undefined)
  const deleteRows = vi.fn().mockResolvedValue(1)
  const where = vi.fn().mockReturnValue({ delete: deleteRows })
  const pageForShare = vi.fn().mockResolvedValue((options.rebuildPages ?? []).map(page => ({ id: page.id })))
  const pageAndWhere = vi.fn().mockReturnValue({ forShare: pageForShare })
  const pageWhere = vi.fn().mockReturnValue({ andWhere: pageAndWhere })
  const pageSelect = vi.fn().mockReturnValue({ where: pageWhere })
  const table = vi.fn().mockImplementation(tableName =>
    tableName === 'pages' ? { select: pageSelect } : { truncate, where }
  )
  const transactionRaw = vi.fn().mockResolvedValue({ rows: [] })
  const transaction = Object.assign(table, { raw: transactionRaw })
  const raw = vi.fn().mockImplementation(async sql => {
    if (sql.includes('WITH RECURSIVE query_input')) return { rows: options.queryRows ?? [] }
    return { rows: [] }
  })
  const dropTableIfExists = vi.fn().mockResolvedValue(undefined)
  const schema = {
    hasTable: vi.fn().mockResolvedValue(true),
    hasColumn: vi.fn().mockImplementation(async (_table, column) => options.legacySchema !== true || column !== 'pageId'),
    dropTableIfExists
  }
  const knex = Object.assign(vi.fn().mockImplementation(table), {
    raw,
    schema,
    transaction: vi.fn(async callback => callback(transaction))
  })
  return { knex, raw, transactionRaw, truncate, dropTableIfExists, pageWhere, pageAndWhere }
}

const installWiki = (knex, pages = {}) => {
  global.WIKI = {
    config: { db: { type: 'postgres' }, search: { maxHits: 100 } },
    data: {},
    Error: { SearchActivationFailed: class SearchActivationFailed extends Error {} },
    logger: { info: vi.fn(), warn: vi.fn() },
    models: { knex, pages }
  }
}

afterEach(() => {
  vi.resetModules()
  if (originalWiki === undefined) delete global.WIKI
  else global.WIKI = originalWiki
})

describe('PostgreSQL hybrid search', () => {
  it('replaces the legacy unindexed schema and rebuilds all derived search data', async () => {
    const harness = knexHarness({ legacySchema: true })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await plugin.init()

    expect(harness.dropTableIfExists).toHaveBeenCalledWith('pagesWords')
    expect(harness.dropTableIfExists).toHaveBeenCalledWith('pagesVector')
    expect(harness.raw.mock.calls.some(([sql]) => String(sql).includes('pages_vector_tokens_idx') && String(sql).includes('USING GIN'))).toBe(true)
    expect(harness.truncate).toHaveBeenCalledTimes(2)
    expect(harness.transactionRaw).not.toHaveBeenCalled()
  })

  it('returns bounded ranked evidence while keeping the user query in SQL bindings', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      path: `runbooks/${index + 1}`,
      locale: 'en',
      title: `Runbook ${index + 1}`,
      description: '',
      tags: ['incident'],
      score: 8 - index,
      matchedFields: index === 0 ? ['tag', 'graph'] : ['content']
    }))
    const harness = knexHarness({ queryRows: rows })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    expect(await plugin.query('Amber Falcon', { locale: 'en', path: 'runbooks' })).toEqual({
      results: rows,
      suggestions: [],
      totalHits: 5
    })
    const [sql, bindings] = harness.raw.mock.calls.find(([statement]) => String(statement).includes('WITH RECURSIVE query_input'))
    expect(sql).not.toContain('Amber Falcon')
    expect(bindings).toContain('Amber Falcon')
    expect(bindings.at(-1)).toBe(100)
  })

  it('atomically refreshes weighted tag and content terms for page mutations', async () => {
    const harness = knexHarness()
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await plugin.updated({
      id: 42,
      path: 'runbooks/falcon',
      localeCode: 'en',
      title: 'Falcon Runbook',
      description: 'Incident response',
      visibility: 'public',
      isPublished: true,
      safeContent: 'Amber Falcon recovery steps',
      tags: [{ tag: 'incident', title: 'Incident response' }]
    })

    const vectorWrite = harness.transactionRaw.mock.calls.find(([sql]) => String(sql).includes('ON CONFLICT ("pageId")'))
    expect(vectorWrite?.[1]).toEqual(expect.arrayContaining([42, 'runbooks/falcon', ['incident'], 'Amber Falcon recovery steps', 'english']))
    expect(harness.transactionRaw.mock.calls.some(([sql]) => String(sql).includes('tsvector_to_array') && String(sql).includes('pagesWords'))).toBe(true)
  })

  it('uses the same canonical rendered document for incremental saves and full rebuilds', async () => {
    const page = {
      id: 42,
      path: 'runbooks/falcon',
      localeCode: 'en',
      title: 'Falcon Runbook',
      description: 'Incident response',
      safeContent: 'rendered-only unique-extension-term',
      tags: [{ tag: 'incident', title: 'Incident response' }],
      visibility: 'public',
      isPublished: true
    }
    const harness = knexHarness({ rebuildPages: [page] })
    const pages = {
      getPageFromDb: vi.fn().mockResolvedValue({ ...page, safeContent: 'raw source must not be indexed' }),
      prepareSearchDocument: vi.fn().mockImplementation(async candidate => ({
        ...candidate,
        safeContent: 'rendered-only unique-extension-term'
      }))
    }
    installWiki(harness.knex, pages)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await plugin.updated(page)
    await plugin.rebuild()
    expect(harness.pageWhere).toHaveBeenCalledWith('isPublished', true)
    expect(harness.pageAndWhere).toHaveBeenCalledWith('visibility', 'public')

    expect(pages.prepareSearchDocument).toHaveBeenCalledTimes(1)
    const documents = harness.transactionRaw.mock.calls
      .filter(([sql]) => String(sql).includes('ON CONFLICT ("pageId")'))
      .map(([, bindings]) => bindings[7])
    expect(documents).toEqual([
      'rendered-only unique-extension-term',
      'rendered-only unique-extension-term'
    ])
    expect(documents).not.toContain('raw source must not be indexed')
  })
})
