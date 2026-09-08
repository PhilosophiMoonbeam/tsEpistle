import { isStructuredSearchQuery } from '../helpers/search-query.ts'

const originalWiki = global.WIKI

const knexHarness = (options = {}) => {
  const truncate = vi.fn().mockResolvedValue(undefined)
  const deleteRows = vi.fn().mockResolvedValue(1)
  const where = vi.fn().mockReturnValue({ delete: deleteRows })
  const rebuildPages = options.rebuildPages ?? []
  const transactionRaw = vi.fn().mockImplementation(async (sql, bindings = []) => {
    const statement = String(sql)
    if (statement.includes('AS "publicPages"')) return { rows: options.inspectionRow ? [options.inspectionRow] : [] }
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
    if (statement.includes('websearch_to_tsquery')) {
      const pageRevisions = bindings[10] === null ? null : JSON.parse(String(bindings[10]))
      const rows = options.scope
        ? (options.queryRows ?? []).filter(row =>
            row.locale === options.scope.locale &&
            (row.path === options.scope.path || row.path.startsWith(`${options.scope.path}/`))
          )
        : options.queryRows ?? []
      const revisionFilteredRows =
        pageRevisions === null
          ? rows
          : rows.filter(row => String(row.sourceRevision) === pageRevisions[String(row.id)])
      return { rows: revisionFilteredRows.slice(0, bindings.at(-1)) }
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
  it('classifies PostgreSQL web-search syntax without treating literal hyphens as operators', () => {
    expect(isStructuredSearchQuery('"Amber Falcon"')).toBe(true)
    expect(isStructuredSearchQuery('Amber OR Falcon')).toBe(true)
    expect(isStructuredSearchQuery('Amber -Marmot')).toBe(true)
    expect(isStructuredSearchQuery('Amber - Falcon')).toBe(true)
    expect(isStructuredSearchQuery('Amber- Falcon')).toBe(false)
    expect(isStructuredSearchQuery('amber-or-falcon')).toBe(false)
    expect(isStructuredSearchQuery('part-number-42')).toBe(false)
  })

  it('inspects coverage and dictionary metadata without rebuilding or modifying page data', async () => {
    const harness = knexHarness({ inspectionRow: { publicPages: '10', indexedPages: '9', missingPages: '2', stalePages: '1', excludedEntries: '1', dictionary: 'english', schemaVersion: 2 } })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'simple' } })
    const status = await plugin.inspectIndex()
    expect(status).toMatchObject({ publicPages: 10, indexedPages: 9, missingPages: 2, stalePages: 1, excludedEntries: 1, configuredDictionary: 'simple', indexedDictionary: 'english', schemaVersion: 2, expectedSchemaVersion: 2 })
    expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false)
    expect(harness.truncate).not.toHaveBeenCalled()
    expect(harness.dropTableIfExists).not.toHaveBeenCalled()
  })

  it('rejects a concurrent rebuild before changing visible derived data', async () => {
    const harness = knexHarness({ lockAcquired: false })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await expect(plugin.rebuild()).rejects.toThrow('PostgreSQL search rebuild is already in progress')
    expect(harness.truncate).not.toHaveBeenCalled()
  })


  it('returns suggestions only for syntax-neutral result candidates', async () => {
    const inScope = {
      id: 42,
      sourceRevision: '1',
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
    await expect(plugin.query('falcn', { locale: 'en', path: 'runbooks' })).resolves.toMatchObject({
      suggestions: ['falcon']
    })
    await expect(plugin.query('falcn OR kestrel', { locale: 'en', path: 'runbooks' })).resolves.toMatchObject({
      suggestions: []
    })
  })

  it('pins vectors to caller-authorized page revisions before candidate caps', async () => {
    const harness = knexHarness({
      queryRows: [
        { id: 42, sourceRevision: '2', path: 'runbooks/falcon', locale: 'en', title: 'New Falcon', description: '', tags: [], score: 2, matchedFields: ['title'] },
        { id: 43, sourceRevision: '1', path: 'runbooks/kestrel', locale: 'en', title: 'Authorized Kestrel', description: '', tags: [], score: 1, matchedFields: ['title'] }
      ]
    })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await expect(plugin.query('falcon', { pageIds: [42, 43], pageRevisions: { '42': '1', '43': '1' }, limit: 1 })).resolves.toMatchObject({
      results: [expect.objectContaining({ id: 43, sourceRevision: '1' })]
    })
  })

  it('returns no candidates for blank input without querying the index', async () => {
    const harness = knexHarness()
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await expect(plugin.query(' \t ', {})).resolves.toEqual({ results: [], suggestions: [], totalHits: 0 })
    expect(harness.raw).not.toHaveBeenCalled()
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
  })

})
