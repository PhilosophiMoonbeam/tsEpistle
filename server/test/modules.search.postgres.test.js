const originalWiki = global.WIKI

const knexHarness = (options = {}) => {
  const truncate = vi.fn().mockResolvedValue(undefined)
  const deleteRows = vi.fn().mockResolvedValue(1)
  const where = vi.fn().mockReturnValue({ delete: deleteRows })
  const rebuildPages = options.rebuildPages ?? []
  const transactionRaw = vi.fn().mockImplementation(async (sql, bindings = []) => {
    const statement = String(sql)
    if (statement.includes('pg_try_advisory_xact_lock')) return { rows: [{ value: options.lockAcquired !== false }] }
    if (statement.includes('WITH expected_columns')) return { rows: [{ value: options.schemaCurrent !== false }] }
    if (statement.includes('FROM "pagesSearchMetadata"')) {
      const value = options.metadataDictionary === undefined
        ? options.metadataCurrent !== false
        : options.metadataDictionary === bindings[1]
      return { rows: [{ value }] }
    }
    if (statement.includes('FULL OUTER JOIN "pagesVector"')) {
      return { rows: [{ value: options.revisionsCurrent !== false }] }
    }
    if (statement.includes('FOR SHARE OF page')) {
      const [cursor, limit] = bindings
      return { rows: rebuildPages.filter(page => page.id > cursor).slice(0, limit) }
    }
    return { rows: [] }
  })
  const table = vi.fn().mockImplementation(() => ({ truncate, where }))
  const transactionSchema = {
    dropTableIfExists: vi.fn().mockResolvedValue(undefined)
  }
  const transactionClient = Object.assign(table, { raw: transactionRaw, schema: transactionSchema })
  let transactionHeld = false
  const raw = vi.fn().mockImplementation(async (sql, bindings = []) => {
    if (options.rejectSecondConnection && transactionHeld) throw new Error('pool exhausted')
    const statement = String(sql)
    if (statement.includes('WITH RECURSIVE query_input')) {
      const rows = options.scope
        ? (options.queryRows ?? []).filter(row =>
            row.locale === options.scope.locale &&
            (row.path === options.scope.path || row.path.startsWith(`${options.scope.path}/`))
          )
        : (options.queryRows ?? [])
      return { rows: rows.slice(0, bindings.at(-1)) }
    }
    if (statement.includes('FROM "pagesWords"')) {
      const pageIds = new Set(bindings[0])
      const words = []
      for (const candidate of options.suggestionRows ?? []) {
        if (pageIds.has(candidate.pageId) && !words.some(row => row.word === candidate.word)) words.push({ word: candidate.word })
      }
      return { rows: words.slice(0, 5) }
    }
    return { rows: [] }
  })
  const schema = {
    dropTableIfExists: vi.fn().mockResolvedValue(undefined)
  }
  const transaction = vi.fn(async callback => {
    transactionHeld = true
    try {
      return await callback(transactionClient)
    } finally {
      transactionHeld = false
    }
  })
  const knex = Object.assign(vi.fn().mockImplementation(table), { raw, schema, transaction })
  return {
    knex,
    raw,
    transaction,
    transactionRaw,
    truncate,
    dropTableIfExists: transactionSchema.dropTableIfExists
  }
}

const installWiki = (knex, pages = {}) => {
  global.WIKI = {
    config: { db: { type: 'postgres' }, search: { maxHits: 100 } },
    data: {},
    Error: { SearchActivationFailed: class SearchActivationFailed extends Error {} },
    logger: { info: vi.fn(), warn: vi.fn() },
    models: {
      knex,
      pages: {
        cleanHTML: vi.fn(value => value),
        ...pages
      }
    }
  }
}

afterEach(() => {
  vi.resetModules()
  if (originalWiki === undefined) delete global.WIKI
  else global.WIKI = originalWiki
})

describe('PostgreSQL hybrid search', () => {
  it('atomically repairs schema, constraint, and invalid same-name index drift', async () => {
    const harness = knexHarness({ schemaCurrent: false })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await plugin.init()

    expect(harness.dropTableIfExists).toHaveBeenCalledWith('pagesSearchMetadata')
    expect(harness.dropTableIfExists).toHaveBeenCalledWith('pagesWords')
    expect(harness.dropTableIfExists).toHaveBeenCalledWith('pagesVector')
    const contractCheck = harness.transactionRaw.mock.calls.find(([sql]) => String(sql).includes('WITH expected_columns'))[0]
    expect(contractCheck).toContain('indisvalid')
    expect(contractCheck).toContain('opclass_names')
    const recreation = harness.transactionRaw.mock.calls.find(([sql]) => String(sql).includes('CREATE TABLE "pagesVector"'))[0]
    expect(recreation).toContain('"sourceRevision" bigint NOT NULL')
    expect(recreation).toContain('CREATE UNIQUE INDEX pages_vector_identity_idx')
    expect(recreation).not.toContain('CREATE UNIQUE INDEX IF NOT EXISTS pages_vector_identity_idx')
    expect(harness.truncate).toHaveBeenCalledTimes(2)
  })

  it('rebuilds when the configured dictionary differs from persisted metadata', async () => {
    const harness = knexHarness({ metadataDictionary: 'simple' })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await plugin.init()

    expect(harness.truncate).toHaveBeenCalledTimes(2)
    const metadataRead = harness.transactionRaw.mock.calls.find(([sql]) => String(sql).includes('FROM "pagesSearchMetadata"'))
    expect(metadataRead[1]).toEqual([1, 'english'])
    const metadataWrite = harness.transactionRaw.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO "pagesSearchMetadata"'))
    expect(metadataWrite[1]).toEqual([1, 'english'])
  })

  it('reconciles stale vector source revisions before declaring readiness', async () => {
    const harness = knexHarness({ revisionsCurrent: false })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await plugin.init()

    expect(harness.transactionRaw.mock.calls.some(([sql]) =>
      String(sql).includes('vector."sourceRevision" IS DISTINCT FROM page."sourceRevision"')
    )).toBe(true)
    expect(harness.truncate).toHaveBeenCalledTimes(2)
  })

  it('rejects a concurrent rebuild before changing visible derived data', async () => {
    const harness = knexHarness({ lockAcquired: false })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await expect(plugin.rebuild()).rejects.toThrow('PostgreSQL search rebuild is already in progress')
    expect(harness.truncate).not.toHaveBeenCalled()
    expect(harness.transactionRaw).toHaveBeenCalledTimes(1)
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

  it('scopes locale and literal path before the configured result window', async () => {
    const outOfScope = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      path: `ops%_other/${index}`,
      locale: index % 2 === 0 ? 'fr' : 'en',
      title: `Higher ranked ${index}`,
      description: '',
      tags: [],
      score: 100 - index,
      matchedFields: ['title']
    }))
    const inScope = {
      id: 999,
      path: 'ops%_/inside',
      locale: 'en',
      title: 'Literal scope result',
      description: '',
      tags: [],
      score: 1,
      matchedFields: ['content']
    }
    const harness = knexHarness({
      queryRows: [...outOfScope, inScope],
      scope: { locale: 'en', path: 'ops%_' }
    })
    installWiki(harness.knex)
    global.WIKI.config.search.maxHits = 7
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    const response = await plugin.query('100%_ literal', { locale: 'en', path: 'ops%_' })
    const [sql, bindings] = harness.raw.mock.calls.find(([statement]) => String(statement).includes('WITH RECURSIVE query_input'))
    const firstLimit = sql.indexOf('LIMIT ?')

    expect(response.results).toEqual([inScope])
    expect(sql.indexOf('vector.locale = input.locale_filter')).toBeLessThan(firstLimit)
    expect(sql.indexOf('vector.path = input.path_filter')).toBeLessThan(firstLimit)
    expect(sql.indexOf('vector.path LIKE input.path_prefix')).toBeLessThan(firstLimit)
    expect(bindings).toContain('%100\\%\\_ literal%')
    expect(bindings).toContain('ops%_')
    expect(bindings).toContain('ops\\%\\_/%')
    expect(bindings.slice(-2)).toEqual([7, 7])
  })

  it('limits spelling candidates to identities in the returned scoped candidate set', async () => {
    const inScope = {
      id: 42,
      path: 'runbooks/falcon',
      locale: 'en',
      title: 'Falcon Runbook',
      description: '',
      tags: [],
      score: 1,
      matchedFields: ['content']
    }
    const harness = knexHarness({
      queryRows: [inScope],
      scope: { locale: 'en', path: 'runbooks' },
      suggestionRows: [
        { pageId: 42, word: 'falcon' },
        { pageId: 77, word: 'unrelated-french-term' }
      ]
    })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    const response = await plugin.query('falcn', { locale: 'en', path: 'runbooks' })

    expect(response.suggestions).toEqual(['falcon'])
    const [sql, bindings] = harness.raw.mock.calls.find(([statement]) => String(statement).includes('FROM "pagesWords"'))
    expect(sql).toContain('"pageId" = ANY(?::integer[])')
    expect(bindings).toEqual([[42], 'falcn', 'falcn'])
  })

  it('atomically refreshes weighted tag and content terms for page mutations', async () => {
    const harness = knexHarness()
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await plugin.updated({
      id: 42,
      path: 'runbooks/falcon',
      sourceRevision: '7',
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

  it('rebuilds from canonical rendered rows without requesting a second pool connection', async () => {
    const page = {
      id: 42,
      sourceRevision: '8',
      path: 'runbooks/falcon',
      localeCode: 'en',
      title: 'Falcon Runbook',
      description: 'Incident response',
      render: '<p>rendered-only unique-extension-term</p>',
      tags: [{ tag: 'incident', title: 'Incident response' }],
      visibility: 'public',
      isPublished: true
    }
    const harness = knexHarness({ rebuildPages: [page], rejectSecondConnection: true })
    const cleanHTML = vi.fn(() => 'rendered-only unique-extension-term')
    installWiki(harness.knex, { cleanHTML })
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await expect(plugin.rebuild()).resolves.toBeUndefined()

    expect(harness.transaction).toHaveBeenCalledTimes(1)
    expect(cleanHTML).toHaveBeenCalledWith('<p>rendered-only unique-extension-term</p>')
    const vectorWrite = harness.transactionRaw.mock.calls.find(([sql]) => String(sql).includes('ON CONFLICT ("pageId")'))
    expect(vectorWrite[1][1]).toBe('8')
    expect(vectorWrite[1][8]).toBe('rendered-only unique-extension-term')
  })

  it('walks canonical rebuild bodies through a bounded keyset cursor', async () => {
    const rebuildPages = Array.from({ length: 205 }, (_, index) => ({
      id: index + 1,
      sourceRevision: String(index + 1),
      path: `pages/${index + 1}`,
      localeCode: 'en',
      title: `Page ${index + 1}`,
      description: '',
      render: `body ${index + 1}`,
      tags: [],
      visibility: 'public',
      isPublished: true
    }))
    const harness = knexHarness({ rebuildPages })
    const cleanHTML = vi.fn(value => value)
    installWiki(harness.knex, { cleanHTML })
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await plugin.rebuild()

    const batches = harness.transactionRaw.mock.calls.filter(([sql]) => String(sql).includes('FOR SHARE OF page'))
    expect(batches.map(([, bindings]) => bindings)).toEqual([
      [0, 100],
      [100, 100],
      [200, 100]
    ])
    expect(cleanHTML).toHaveBeenCalledTimes(205)
    const vectorWrites = harness.transactionRaw.mock.calls.filter(([sql]) => String(sql).includes('ON CONFLICT ("pageId")'))
    expect(vectorWrites).toHaveLength(205)
    expect(vectorWrites[0][1][1]).toBe('1')
    expect(vectorWrites.at(-1)[1][1]).toBe('205')
  })
})
