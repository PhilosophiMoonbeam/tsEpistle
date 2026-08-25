const originalWiki = global.WIKI

const knexHarness = (options = {}) => {
  const truncate = vi.fn().mockResolvedValue(undefined)
  const deleteRows = vi.fn().mockResolvedValue(1)
  const where = vi.fn().mockReturnValue({ delete: deleteRows })
  const table = vi.fn().mockReturnValue({ truncate, where })
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
  const knex = Object.assign(vi.fn(), {
    raw,
    schema,
    transaction: vi.fn(async callback => callback(transaction))
  })
  return { knex, raw, transactionRaw, truncate, dropTableIfExists }
}

const installWiki = knex => {
  global.WIKI = {
    config: { db: { type: 'postgres' }, search: { maxHits: 100 } },
    data: {},
    Error: { SearchActivationFailed: class SearchActivationFailed extends Error {} },
    logger: { info: vi.fn(), warn: vi.fn() },
    models: { knex }
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
    const plugin = (await import('../modules/search/postgres/engine.ts')).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await plugin.init()

    expect(harness.dropTableIfExists).toHaveBeenCalledWith('pagesWords')
    expect(harness.dropTableIfExists).toHaveBeenCalledWith('pagesVector')
    expect(harness.raw.mock.calls.some(([sql]) => String(sql).includes('pages_vector_tokens_idx') && String(sql).includes('USING GIN'))).toBe(true)
    expect(harness.truncate).toHaveBeenCalledTimes(2)
    expect(harness.transactionRaw.mock.calls.some(([sql]) => String(sql).includes('pageAccessPasswords') && String(sql).includes('setweight(to_tsvector'))).toBe(true)
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
    const plugin = (await import('../modules/search/postgres/engine.ts')).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await expect(plugin.query('Amber Falcon', { locale: 'en', path: 'runbooks' })).resolves.toEqual({
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
    const plugin = (await import('../modules/search/postgres/engine.ts')).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await plugin.updated({
      id: 42,
      path: 'runbooks/falcon',
      localeCode: 'en',
      title: 'Falcon Runbook',
      description: 'Incident response',
      safeContent: 'Amber Falcon recovery steps',
      tags: [{ tag: 'incident', title: 'Incident response' }]
    })

    const vectorWrite = harness.transactionRaw.mock.calls.find(([sql]) => String(sql).includes('ON CONFLICT ("pageId")'))
    expect(vectorWrite?.[1]).toEqual(expect.arrayContaining([42, 'runbooks/falcon', ['incident'], 'Amber Falcon recovery steps', 'english']))
    expect(harness.transactionRaw.mock.calls.some(([sql]) => String(sql).includes('tsvector_to_array') && String(sql).includes('pagesWords'))).toBe(true)
  })
})
