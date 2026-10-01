import knexModule from 'knex'
import { getPostgresTestConnection } from './postgres-test-connection.mts'
import { isStructuredSearchQuery } from '../helpers/search-query.ts'

const originalWiki = global.WIKI
const connection = getPostgresTestConnection('_modules_search_test', import.meta.path)

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
      const pages = statement.includes('page."isSearchable" = true')
        ? rebuildPages.filter(page => page.isSearchable !== false && page.isSearchable !== 0)
        : rebuildPages
      return { rows: pages.filter(page => page.id > cursor).slice(0, limit) }
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
      const sourceRows = options.queryRows ?? []
      const searchableRows = statement.includes('current_page."isSearchable" = true')
        ? sourceRows.filter(row => row.isSearchable !== false && row.isSearchable !== 0)
        : sourceRows
      const rows = options.scope
        ? searchableRows.filter(row =>
            row.locale === options.scope.locale &&
            (row.path === options.scope.path || row.path.startsWith(`${options.scope.path}/`))
          )
        : searchableRows
      const revisionFilteredRows =
        pageRevisions === null
          ? rows
          : rows.filter(row => String(row.sourceRevision) === pageRevisions[String(row.id)])
      return { rows: revisionFilteredRows.slice(0, bindings.at(-1)) }
    }
    if (statement.includes('FROM "pagesWords"')) {
      const pageIds = new Set(bindings[0])
      const sourceRows = options.suggestionRows ?? []
      const searchableRows = statement.includes('page."isSearchable" = true')
        ? sourceRows.filter(row => row.isSearchable !== false && row.isSearchable !== 0)
        : sourceRows
      const words = []
      for (const candidate of searchableRows) {
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

  it('filters an opted-out page from stale indexed candidates before worker cleanup', async () => {
    const harness = knexHarness({
      queryRows: [
        {
          id: 42,
          sourceRevision: '1',
          path: 'runbooks/opted-out',
          locale: 'en',
          title: 'Opted Out Falcon',
          description: '',
          tags: [],
          score: 10,
          matchedFields: ['title'],
          isSearchable: false
        },
        {
          id: 43,
          sourceRevision: '1',
          path: 'runbooks/searchable',
          locale: 'en',
          title: 'Searchable Falcon',
          description: '',
          tags: [],
          score: 1,
          matchedFields: ['title']
        }
      ]
    })
    installWiki(harness.knex)
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await expect(plugin.query('falcon', {})).resolves.toMatchObject({
      results: [expect.objectContaining({ id: 43 })],
      totalHits: 1
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
  it('rebuilds opted-out pages out of the derived index while keeping legacy rows searchable by default', async () => {
    const optedOut = {
      id: 42,
      sourceRevision: '8',
      path: 'runbooks/opted-out',
      localeCode: 'en',
      title: 'Opted Out Runbook',
      description: 'Excluded from search',
      render: '<p>opted-out-content</p>',
      tags: [],
      visibility: 'public',
      isPublished: true,
      isSearchable: false
    }
    const defaultSearchable = {
      id: 43,
      sourceRevision: '9',
      path: 'runbooks/default',
      localeCode: 'en',
      title: 'Default Runbook',
      description: 'Included in search',
      render: '<p>default-content</p>',
      tags: [],
      visibility: 'public',
      isPublished: true
    }
    const harness = knexHarness({ rebuildPages: [optedOut, defaultSearchable] })
    const cleanHTML = vi.fn(value => value)
    installWiki(harness.knex, { cleanHTML })
    const plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
    Object.assign(plugin, { config: { dictLanguage: 'english' } })

    await expect(plugin.rebuild()).resolves.toBeUndefined()

    expect(cleanHTML).toHaveBeenCalledTimes(1)
    expect(cleanHTML).toHaveBeenCalledWith(defaultSearchable.render)
  })


})

if (connection) {
  describe('PostgreSQL hybrid search persisted contracts', () => {
    let db
    let plugin

    const page = (id, overrides = {}) => ({
      id,
      sourceRevision: 1,
      path: `runbooks/page-${id}`,
      localeCode: 'en',
      title: `Runbook ${id}`,
      description: '',
      content: 'source-only material',
      render: '<p>canonical rendered material</p>',
      visibility: 'public',
      isPublished: true,
      ...overrides
    })

    const snapshot = async () => {
      const state = {}
      for (const table of ['pages', 'tags', 'pageTags', 'pageLinks', 'pageAccessPasswords', 'pageMutationOutbox', 'pagesVector', 'pagesWords', 'pagesSearchMetadata']) {
        const result = await db.raw(
          `SELECT COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY to_jsonb(entry)::text), '[]'::jsonb) AS rows FROM ?? entry`,
          [table]
        )
        state[table] = result.rows[0].rows
      }
      return state
    }

    beforeAll(async () => {
      db = knexModule({
        client: 'pg',
        connection,
        pool: { min: 1, max: 1 },
        acquireConnectionTimeout: 1000
      })
      await db.raw(`
        CREATE TABLE pages (
          id integer PRIMARY KEY,
          "sourceRevision" bigint NOT NULL,
          path text NOT NULL,
          "localeCode" varchar(35) NOT NULL,
          title text NOT NULL,
          description text NOT NULL DEFAULT '',
          content text NOT NULL DEFAULT '',
          render text NOT NULL DEFAULT '',
          visibility text NOT NULL,
          "isPublished" boolean NOT NULL,
          "isSearchable" boolean NOT NULL DEFAULT true
        );
        CREATE TABLE tags (
          id integer PRIMARY KEY,
          tag text NOT NULL UNIQUE,
          title text NOT NULL
        );
        CREATE TABLE "pageTags" (
          "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          "tagId" integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY ("pageId", "tagId")
        );
        CREATE TABLE "pageLinks" (
          "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          "localeCode" varchar(35) NOT NULL,
          path text NOT NULL,
          PRIMARY KEY ("pageId", "localeCode", path)
        );
        CREATE TABLE "pageAccessPasswords" (
          "pageId" integer PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE
        );
        CREATE TABLE "pageMutationOutbox" (
          id uuid PRIMARY KEY,
          "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          "sourceRevision" bigint NOT NULL,
          "effectKind" text NOT NULL,
          "desiredState" text NOT NULL,
          status text NOT NULL
        );
      `)
    })

    beforeEach(async () => {
      await db.raw('TRUNCATE pages, tags, "pageTags", "pageLinks", "pageAccessPasswords", "pageMutationOutbox" CASCADE')
      installWiki(db)
      const Page = (await vi.importFresh('../models/pages.ts', import.meta.url)).default
      Page.knex(db)
      global.WIKI.models.pages = Page
      plugin = (await vi.importFresh('../modules/search/postgres/engine.ts', import.meta.url)).default
      Object.assign(plugin, { config: { dictLanguage: 'english' } })
      await plugin.init()
    })

    afterAll(async () => {
      if (db) await db.destroy()
    })

    it('inspects real coverage and metadata without changing canonical or derived rows', async () => {
      await db('pages').insert(Array.from({ length: 11 }, (_, index) => page(index + 1)))
      await plugin.rebuild()
      await db('pagesVector').whereIn('pageId', [9, 10]).delete()
      await db('pages').where({ id: 1 }).update({ sourceRevision: 2 })
      await db('pages').where({ id: 11 }).update({ isSearchable: false })
      plugin.config.dictLanguage = 'simple'

      const before = await snapshot()
      const status = await plugin.inspectIndex()

      expect(status).toMatchObject({
        publicPages: 10,
        indexedPages: 9,
        missingPages: 2,
        stalePages: 1,
        excludedEntries: 1,
        configuredDictionary: 'simple',
        indexedDictionary: 'english',
        schemaVersion: 2,
        expectedSchemaVersion: 2
      })
      expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false)
      expect(await snapshot()).toEqual(before)
    })

    it('restricts reachable suggestion vocabulary by locale and path and suppresses structured suggestions', async () => {
      await db('pages').insert([
        page(42, { path: 'runbooks/falcon', title: 'Falcon Runbook', description: 'falcn' }),
        page(77, { path: 'runbooks/french', localeCode: 'fr', title: 'Falcone unrelated-french-term', description: 'falcn' }),
        page(78, { path: 'other/falconer', title: 'Falconer Manual', description: 'falcn' })
      ])
      await plugin.rebuild()

      // Both out-of-scope spellings satisfy PostgreSQL's actual suggestion predicate.
      const competitors = await db.raw(`SELECT 'falcone' % 'falcn' AS french, 'falconer' % 'falcn' AS other_path`)
      expect(competitors.rows[0]).toEqual({ french: true, other_path: true })
      const unscoped = await plugin.query('falcn', {})
      expect(unscoped.results.map(result => result.id).sort((a, b) => a - b)).toEqual([42, 77, 78])

      const scope = { locale: 'en', path: 'runbooks' }
      const neutral = await plugin.query('falcn', scope)
      expect(neutral.results.map(result => result.id)).toEqual([42])
      expect(neutral.suggestions).toEqual(['falcon'])
      expect(neutral.suggestions).not.toContain('unrelated-french-term')
      expect(neutral.suggestions).not.toContain('falcone')
      expect(neutral.suggestions).not.toContain('falconer')

      const originalStructured = await plugin.query('falcn OR kestrel', scope)
      expect(originalStructured.results.map(result => result.id)).toEqual([42])
      expect(originalStructured.suggestions).toEqual([])
      const reachableStructured = await plugin.query('falcon OR falcn', scope)
      expect(reachableStructured.results.map(result => result.id)).toEqual([42])
      expect(reachableStructured.suggestions).toEqual([])
    })

    it('keeps authorized page43 revision1 ahead of a mismatched exact-title candidate at cap1', async () => {
      await db('pages').insert([
        page(42, { sourceRevision: 2, path: 'runbooks/falcon', title: 'Falcon' }),
        page(43, { path: 'runbooks/kestrel', title: 'Authorized Kestrel', render: '<p>falcon</p>' })
      ])
      await plugin.rebuild()
      const unpinned = await plugin.query('falcon', { pageIds: [42, 43], limit: 1 })
      expect(unpinned.results).toEqual([expect.objectContaining({ id: 42, sourceRevision: '2' })])

      const pinned = await plugin.query('falcon', {
        pageIds: [42, 43],
        pageRevisions: { '42': '1', '43': '1' },
        limit: 1
      })
      expect(pinned.results).toEqual([expect.objectContaining({ id: 43, sourceRevision: '1' })])
      expect(pinned.totalHits).toBe(1)
    })

    it('immediately excludes canonical opt-out while its indexed row still exists and preserves its competitor', async () => {
      await db('pages').insert([
        page(42, { path: 'runbooks/opted-out', title: 'Falcon' }),
        page(43, { path: 'runbooks/searchable', title: 'Searchable Falcon' })
      ])
      await plugin.rebuild()
      expect((await plugin.query('falcon', {})).results.map(result => result.id).sort((a, b) => a - b)).toEqual([42, 43])
      await db('pages').where({ id: 42 }).update({ isSearchable: false })
      expect(await db('pagesVector').where({ pageId: 42 }).select('pageId', 'sourceRevision')).toEqual([
        { pageId: 42, sourceRevision: '1' }
      ])

      const result = await plugin.query('falcon', {})
      expect(result.results).toEqual([expect.objectContaining({ id: 43, sourceRevision: '1' })])
      expect(result.totalHits).toBe(1)
    })

    it('persists rendered revision8 on one connection then removes opt-out and indexes omitted-flag revision9', async () => {
      await db('pages').insert(page(42, {
        sourceRevision: 8,
        path: 'runbooks/falcon',
        title: 'Falcon Runbook',
        description: 'Incident response',
        render: '<p>rendered-only <strong>unique&#101;xtensionterm</strong></p>'
      }))
      await plugin.rebuild()

      expect(await db('pagesVector').select('pageId', 'sourceRevision')).toEqual([{ pageId: 42, sourceRevision: '8' }])
      const rendered = await plugin.query('uniqueextensionterm', {})
      expect(rendered.results).toEqual([
        expect.objectContaining({ id: 42, sourceRevision: '8', matchedFields: ['content'] })
      ])
      expect(await db('pagesWords').where({ pageId: 42, word: 'falcon' }).select('word')).toEqual([{ word: 'falcon' }])

      await db('pages').where({ id: 42 }).update({ isSearchable: false })
      // No isSearchable property: this insertion exercises the real canonical database default.
      await db('pages').insert(page(43, {
        sourceRevision: 9,
        path: 'runbooks/default',
        title: 'Default Runbook',
        description: 'Included in search',
        render: '<p>default-content <strong>default&#114;enderterm</strong></p>'
      }))
      expect(await db('pages').where({ id: 43 }).select('isSearchable')).toEqual([{ isSearchable: true }])
      await plugin.rebuild()

      expect(await db('pagesVector').orderBy('pageId').select('pageId', 'sourceRevision')).toEqual([
        { pageId: 43, sourceRevision: '9' }
      ])
      expect(await db('pagesWords').where({ pageId: 42 }).select('word')).toEqual([])
      expect(await db('pagesWords').where({ pageId: 43, word: 'default' }).select('word')).toEqual([{ word: 'default' }])
      const defaultRendered = await plugin.query('defaultrenderterm', {})
      expect(defaultRendered.results).toEqual([
        expect.objectContaining({ id: 43, sourceRevision: '9', matchedFields: ['content'] })
      ])
      expect((await plugin.query('uniqueextensionterm', {})).results).toEqual([])
    })
  })
}
