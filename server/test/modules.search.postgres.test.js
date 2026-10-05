import knexModule from 'knex'
import { getPostgresTestConnection } from './postgres-test-connection.mts'
import { isStructuredSearchQuery } from '../helpers/search-query.ts'

const originalWiki = global.WIKI
const connection = getPostgresTestConnection('_modules_search_test', import.meta.path)


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

describe('PostgreSQL web-search syntax', () => {
  it('recognizes exclusion punctuation without treating literal hyphens as operators', () => {
    for (const query of ['"Amber Falcon"', 'Amber OR Falcon', 'Amber -Marmot', 'Amber - Falcon', '-(falcon)', '-!falcon', '---falcon']) {
      expect(isStructuredSearchQuery(query)).toBe(true)
    }
    for (const query of ['Amber- Falcon', 'amber-or-falcon', 'part-number-42']) {
      expect(isStructuredSearchQuery(query)).toBe(false)
    }
  })
})

if (connection) {
  describe('PostgreSQL hybrid search persisted contracts', () => {
    let db
    let observer
    let enginePid
    let plugin

    const page = (id, overrides = {}) => ({
      id,
      sourceRevision: 1,
      renderedSourceRevision: overrides.sourceRevision ?? 1,
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

    const snapshot = async (client = db) => {
      const state = {}
      for (const table of ['searchEngines', 'pages', 'tags', 'pageTags', 'pageLinks', 'pageAccessPasswords', 'pageMutationOutbox', 'pagesVector', 'pagesWords', 'pagesSearchMetadata']) {
        const result = await client.raw(
          `SELECT COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY to_jsonb(entry)::text), '[]'::jsonb) AS rows FROM ?? entry`,
          [table]
        )
        state[table] = result.rows[0].rows
      }
      return state
    }

    const track = promise => {
      const operation = { settled: false }
      operation.outcome = promise.then(
        value => { operation.settled = true; return { value } },
        error => { operation.settled = true; return { error } }
      )
      return operation
    }

    const complete = async operation => {
      const outcome = await operation.outcome
      if (outcome.error) throw outcome.error
      return outcome.value
    }

    // Observe PostgreSQL's lock queue, rather than guessing when a concurrent call has reached its gate.
    const waitForBlock = async (operation, pid, blockerPid) => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (operation.settled) {
          await complete(operation)
          throw new Error('Expected operation to wait for the PostgreSQL lock')
        }
        const result = await observer.raw('SELECT pg_blocking_pids(?::integer) AS blockers', [pid])
        if (result.rows[0].blockers.includes(blockerPid)) return
      }
      throw new Error('PostgreSQL operation did not enter the expected lock queue')
    }

    const inTransaction = async (transaction, work) => {
      const previous = global.WIKI.models.knex
      global.WIKI.models.knex = transaction
      try {
        return await work()
      } finally {
        global.WIKI.models.knex = previous
      }
    }

    beforeAll(async () => {
      db = knexModule({
        client: 'pg',
        connection,
        pool: { min: 1, max: 1 },
        acquireConnectionTimeout: 1000
      })
      observer = knexModule({ client: 'pg', connection, pool: { min: 1, max: 2 }, acquireConnectionTimeout: 1000 })
      enginePid = (await db.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await db.raw(`
        CREATE TABLE "searchEngines" (
          key text PRIMARY KEY,
          "isEnabled" boolean NOT NULL,
          config jsonb NOT NULL
        );
        CREATE TABLE pages (
          id integer PRIMARY KEY,
          "sourceRevision" bigint NOT NULL,
          "renderedSourceRevision" bigint,
          path text NOT NULL,
          "localeCode" varchar(35) NOT NULL,
          title text NOT NULL,
          description text NOT NULL DEFAULT '',
          content text NOT NULL DEFAULT '',
          render text NOT NULL DEFAULT '',
          visibility text NOT NULL,
          "isPublished" boolean NOT NULL,
          "isSearchable" boolean NOT NULL DEFAULT true,
          "publishStartDate" varchar(255),
          "publishEndDate" varchar(255)
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
          "pageId" integer NOT NULL,
          "sourceRevision" bigint NOT NULL,
          "effectKind" text NOT NULL,
          "desiredState" text NOT NULL,
          status text NOT NULL
        );
      `)
    })

    beforeEach(async () => {
      await db.raw('TRUNCATE "searchEngines", pages, tags, "pageTags", "pageLinks", "pageAccessPasswords", "pageMutationOutbox" CASCADE')
      await db('searchEngines').insert({ key: 'postgres', isEnabled: true, config: JSON.stringify({ dictLanguage: 'english' }) })
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
      if (observer) await observer.destroy()
    })

    it('inspects real coverage and metadata without changing canonical or derived rows', async () => {
      await db('pages').insert(Array.from({ length: 11 }, (_, index) => page(index + 1)))
      await plugin.rebuild()
      await db('pagesVector').whereIn('pageId', [9, 10]).delete()
      await db('pages').where({ id: 1 }).update({ sourceRevision: 2 })
      await db('pages').where({ id: 11 }).update({ isSearchable: false })
      await db('searchEngines').where({ key: 'postgres' }).update({ config: JSON.stringify({ dictLanguage: 'simple' }) })

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

    it('withdraws window-ineligible metadata before query caps and converges on canonical removal', async () => {
      await db('pages').insert([
        page(42, { title: 'Falcone', description: 'falcn futuremetadatacipher' }),
        page(43, { title: 'Falcon Runbook', description: 'falcn', publishStartDate: '', publishEndDate: '' }),
        page(44, { title: 'Falconer', description: 'falcn expiredmetadatacipher' }),
        page(45, { title: 'Falconette', description: 'falcn privatemetadatacipher' })
      ])
      await plugin.rebuild()
      await db('pages').where({ id: 42 }).update({ publishStartDate: '2999-01-01T00:00:00.000Z' })
      await db('pages').where({ id: 44 }).update({ publishEndDate: '2000-01-01T00:00:00.000Z' })
      await db('pages').where({ id: 45 }).update({ visibility: 'private' })

      expect((await plugin.query('falcn', { limit: 1 })).results.map(result => result.id)).toEqual([43])
      expect((await plugin.query('"falcn"', {})).results.map(result => result.id)).toEqual([43])
      expect((await plugin.query('falcn', {})).suggestions).toEqual(['falcon'])
      for (const term of ['futuremetadatacipher', 'expiredmetadatacipher', 'privatemetadatacipher']) {
        expect((await plugin.query(`"${term}"`, {})).results).toEqual([])
      }
      expect(await plugin.inspectIndex()).toMatchObject({
        publicPages: 1, indexedPages: 4, missingPages: 0, stalePages: 0, excludedEntries: 3
      })

      for (const id of [42, 44, 45]) await plugin.removePage(id)
      expect(await db('pagesVector').orderBy('pageId').select('pageId')).toEqual([{ pageId: 43 }])
      expect(await db('pagesWords').whereIn('pageId', [42, 44, 45]).select('word')).toEqual([])
      const converged = await snapshot()
      for (const id of [42, 44, 45]) await plugin.removePage(id)
      expect(await snapshot()).toEqual(converged)
      await plugin.rebuild()
      expect(await snapshot()).toEqual(converged)

      // A crossed publication window is canonical eligibility, even if a stale removal resumes.
      await db('pages').where({ id: 42 }).update({
        publishStartDate: '2000-01-01T10:00:00.000+10:00',
        publishEndDate: '2998-12-31T14:00:00.000-10:00'
      })
      await plugin.removePage(42)
      expect((await plugin.query('"Falcone"', { pageIds: [42] })).results.map(result => result.id)).toEqual([42])
      expect(await db('pagesWords').where({ pageId: 42, word: 'falcone' }).select('word')).toEqual([{ word: 'falcone' }])
      expect(await plugin.inspectIndex()).toMatchObject({
        publicPages: 2, indexedPages: 2, missingPages: 0, stalePages: 0, excludedEntries: 0
      })

      await db('pages').where({ id: 42 }).update({ publishEndDate: '2000-01-01T00:00:00.000Z' })
      await plugin.init()
      expect(await db('pagesVector').orderBy('pageId').select('pageId')).toEqual([{ pageId: 43 }])
      expect(await db('pagesWords').where({ pageId: 42 }).select('word')).toEqual([])
      expect(await plugin.inspectIndex()).toMatchObject({
        publicPages: 1, indexedPages: 1, missingPages: 0, stalePages: 0, excludedEntries: 0,
        schemaVersion: 2, expectedSchemaVersion: 2
      })
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
    it('excludes stale and null-certified body bytes until their exact revisions are rendered', async () => {
      await db('pages').insert([
        page(42, { sourceRevision: 2, renderedSourceRevision: 1, render: '<p>revokedbodytoken</p>' }),
        page(43, { sourceRevision: 3, renderedSourceRevision: null, render: '<p>uncertifiedbodytoken</p>' })
      ])
      await plugin.rebuild()
      for (const [id, token] of [[42, 'revokedbodytoken'], [43, 'uncertifiedbodytoken']]) {
        expect((await plugin.query(`"${token}"`, { pageIds: [id] })).results).toEqual([])
        expect((await db.raw('SELECT count(*)::integer AS count FROM "pagesVector" WHERE "pageId" = ? AND tokens @@ plainto_tsquery(\'english\', ?)', [id, token])).rows[0].count).toBe(0)
        await plugin.reconcilePage(id)
        expect((await plugin.query(`"${token}"`, { pageIds: [id] })).results).toEqual([])
      }
      await db('pages').where({ id: 42 }).update({ renderedSourceRevision: 2, render: '<p>repairedbodytoken</p>' })
      await db('pages').where({ id: 43 }).update({ renderedSourceRevision: 3, render: '<p>certifiedbodytoken</p>' })
      await plugin.reconcilePage(42)
      await plugin.rebuild()
      for (const [id, revision, token] of [[42, '2', 'repairedbodytoken'], [43, '3', 'certifiedbodytoken']]) {
        expect((await plugin.query(`"${token}"`, { pageIds: [id] })).results).toEqual([
          expect.objectContaining({ id, sourceRevision: revision, matchedFields: ['content'] })
        ])
      }
      expect((await plugin.query('"revokedbodytoken"', {})).results).toEqual([])
      expect((await plugin.query('"uncertifiedbodytoken"', {})).results).toEqual([])
      expect(await db('pages').orderBy('id').select('id', 'sourceRevision', 'renderedSourceRevision')).toEqual([
        { id: 42, sourceRevision: '2', renderedSourceRevision: '2' },
        { id: 43, sourceRevision: '3', renderedSourceRevision: '3' }
      ])
    })

    it('uses a committed simple dictionary for old English queries, reconciliations, and rebuilds', async () => {
      await db('pages').insert(page(42, { title: 'Runner Manual', render: '<p>running</p>' }))
      await plugin.rebuild()
      expect((await plugin.query('"running"', { pageIds: [42] })).results.map(result => result.id)).toEqual([42])
      expect((await plugin.query('"run"', { pageIds: [42] })).results.map(result => result.id)).toEqual([42])

      const replacement = { ...plugin, config: { dictLanguage: 'simple' } }
      await db('searchEngines').where({ key: 'postgres' }).update({ config: JSON.stringify({ dictLanguage: 'simple' }) })
      await replacement.init()
      expect(await db('pagesSearchMetadata').select('dictionary')).toEqual([{ dictionary: 'simple' }])
      expect(plugin.config.dictLanguage).toBe('english')
      expect((await plugin.query('"running"', { pageIds: [42] })).results.map(result => result.id)).toEqual([42])
      expect((await plugin.query('"run"', { pageIds: [42] })).results).toEqual([])

      await db('pages').where({ id: 42 }).update({ sourceRevision: 2, renderedSourceRevision: 2 })
      await plugin.reconcilePage(42)
      const tokens = await db.raw('SELECT tokens @@ plainto_tsquery(\'simple\', \'running\') AS running, tokens @@ plainto_tsquery(\'simple\', \'run\') AS run FROM "pagesVector" WHERE "pageId" = 42')
      expect(tokens.rows[0]).toEqual({ running: true, run: false })
      expect((await plugin.query('"running"', { pageIds: [42], pageRevisions: { 42: '2' } })).results).toEqual([
        expect.objectContaining({ id: 42, sourceRevision: '2', matchedFields: ['content'] })
      ])
      await plugin.rebuild()
      expect(await db('pagesSearchMetadata').select('dictionary')).toEqual([{ dictionary: 'simple' }])
      expect((await plugin.query('"run"', { pageIds: [42] })).results).toEqual([])
    })

    it('waits during startup while an explicit overlapping rebuild fails without changing rows', async () => {
      await db('pages').insert(page(42))
      await plugin.rebuild()
      const before = await snapshot()
      const holder = await observer.transaction()
      let startup
      try {
        await holder.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['wiki.search.postgres.derived-index'])
        const blockerPid = (await holder.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid
        startup = track(plugin.init())
        await waitForBlock(startup, enginePid, blockerPid)
        await expect(inTransaction(observer, () => plugin.rebuild())).rejects.toThrow('PostgreSQL search rebuild is already in progress')
        expect(await snapshot(observer)).toEqual(before)
        await holder.commit()
        await complete(startup)
        expect(await snapshot()).toEqual(before)
      } finally {
        if (!holder.isCompleted()) await holder.rollback()
        if (startup) await startup.outcome
      }
    })

    it('shares rebuild exclusion while an incremental vector write is held before its vocabulary update', async () => {
      await db('pages').insert(page(42, { title: 'Original Falcon' }))
      await plugin.rebuild()
      await db('pages').where({ id: 42 }).update({ sourceRevision: 2, renderedSourceRevision: 2, title: 'Newest Falcon', render: '<p>overlapbodytoken</p>' })
      await db.raw(`
        CREATE FUNCTION test_search_vector_gate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('test.search.vector-write-barrier'));
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_search_vector_gate AFTER INSERT OR UPDATE ON "pagesVector"
          FOR EACH ROW EXECUTE FUNCTION test_search_vector_gate();
      `)
      const holder = await observer.transaction()
      let rebuildTransaction
      let incremental
      try {
        await holder.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['test.search.vector-write-barrier'])
        const blockerPid = (await holder.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid
        incremental = track(plugin.reconcilePage(42))
        await waitForBlock(incremental, enginePid, blockerPid)
        rebuildTransaction = await observer.transaction()
        // Bound a broken implementation that attempts table truncation instead of rejecting the held shared index lock.
        await rebuildTransaction.raw("SET LOCAL statement_timeout = '3000ms'")
        await expect(inTransaction(rebuildTransaction, () => plugin.rebuild())).rejects.toThrow('PostgreSQL search rebuild is already in progress')
        await rebuildTransaction.rollback()
        expect(await observer('pagesVector').where({ pageId: 42 }).select('sourceRevision', 'title')).toEqual([{ sourceRevision: '1', title: 'Original Falcon' }])
        await holder.commit()
        await complete(incremental)
        await plugin.rebuild()
        expect(await db('pagesVector').where({ pageId: 42 }).select('sourceRevision', 'title')).toEqual([{ sourceRevision: '2', title: 'Newest Falcon' }])
        expect(await db('pagesWords').where({ pageId: 42, word: 'newest' }).select('word')).toEqual([{ word: 'newest' }])
        expect((await plugin.query('"overlapbodytoken"', { pageIds: [42] })).results).toEqual([
          expect.objectContaining({ id: 42, sourceRevision: '2', matchedFields: ['content'] })
        ])
      } finally {
        if (rebuildTransaction && !rebuildTransaction.isCompleted()) await rebuildTransaction.rollback()
        if (!holder.isCompleted()) await holder.rollback()
        if (incremental) await incremental.outcome
        await observer.raw('DROP TRIGGER IF EXISTS test_search_vector_gate ON "pagesVector"; DROP FUNCTION IF EXISTS test_search_vector_gate()')
      }
    })

    it('refreshes protection and tags after waiting for the canonical page row', async () => {
      await db('pages').insert(page(42, { title: 'Metadata Anchor', render: '<p>protectionracecipher</p>' }))
      await db('tags').insert([{ id: 1, tag: 'oldrelation', title: 'Old Relation' }, { id: 2, tag: 'freshrelation', title: 'Fresh Relation' }])
      await db('pageTags').insert({ pageId: 42, tagId: 1 })
      await plugin.rebuild()
      expect((await plugin.query('"protectionracecipher"', { pageIds: [42] })).results.map(result => result.id)).toEqual([42])
      const holder = await observer.transaction()
      let reconciliation
      try {
        await holder('pages').where({ id: 42 }).forUpdate().first()
        await holder('pageAccessPasswords').insert({ pageId: 42 })
        await holder('pageTags').where({ pageId: 42 }).delete()
        await holder('pageTags').insert({ pageId: 42, tagId: 2 })
        const blockerPid = (await holder.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid
        reconciliation = track(plugin.reconcilePage(42))
        await waitForBlock(reconciliation, enginePid, blockerPid)
        await holder.commit()
        await complete(reconciliation)
        expect(await db('pagesVector').where({ pageId: 42 }).select('sourceRevision', 'tags')).toEqual([{ sourceRevision: '1', tags: ['freshrelation'] }])
        expect((await plugin.query('"protectionracecipher"', { pageIds: [42] })).results).toEqual([])
        expect((await plugin.query('"freshrelation"', { pageIds: [42] })).results.map(result => result.id)).toEqual([42])
        expect(await db('pagesWords').where({ pageId: 42, word: 'oldrelation' }).select('word')).toEqual([])
        expect(await db('pagesWords').where({ pageId: 42, word: 'freshrelation' }).select('word')).toEqual([{ word: 'freshrelation' }])
      } finally {
        if (!holder.isCompleted()) await holder.rollback()
        if (reconciliation) await reconciliation.outcome
      }
    })

    it('does not republish same-revision body bytes after render certification is revoked while waiting', async () => {
      await db('pages').insert(page(42, { render: '<p>rerenderrevokedcipher</p>' }))
      await plugin.rebuild()
      const holder = await observer.transaction()
      let reconciliation
      try {
        await holder('pages').where({ id: 42 }).forUpdate().first()
        await holder('pages').where({ id: 42 }).update({ renderedSourceRevision: null })
        const blockerPid = (await holder.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid
        reconciliation = track(plugin.reconcilePage(42))
        await waitForBlock(reconciliation, enginePid, blockerPid)
        await holder.commit()
        await complete(reconciliation)
        expect((await plugin.query('"rerenderrevokedcipher"', { pageIds: [42] })).results).toEqual([])
        expect((await db.raw('SELECT count(*)::integer AS count FROM "pagesVector" WHERE "pageId" = 42 AND tokens @@ plainto_tsquery(\'english\', \'rerenderrevokedcipher\')')).rows[0].count).toBe(0)
        expect(await db('pages').where({ id: 42 }).select('sourceRevision', 'renderedSourceRevision')).toEqual([{ sourceRevision: '1', renderedSourceRevision: null }])
        await db('pages').where({ id: 42 }).update({ renderedSourceRevision: 1, render: '<p>rerenderreplacementcipher</p>' })
        await plugin.reconcilePage(42)
        expect((await plugin.query('"rerenderreplacementcipher"', { pageIds: [42] })).results).toEqual([
          expect.objectContaining({ id: 42, sourceRevision: '1', matchedFields: ['content'] })
        ])
      } finally {
        if (!holder.isCompleted()) await holder.rollback()
        if (reconciliation) await reconciliation.outcome
      }
    })

    it.each([
      ['future', { publishStartDate: '2999-01-01T00:00:00.000Z' }],
      ['expired', { publishEndDate: '2000-01-01T00:00:00.000Z' }]
    ])('withdraws a newly %s page after waiting for the canonical row', async (_boundary, window) => {
      await db('pages').insert(page(42, { title: 'Window Boundary', render: '<p>windowbodycipher</p>' }))
      await plugin.rebuild()
      const holder = await observer.transaction()
      let reconciliation
      try {
        await holder('pages').where({ id: 42 }).forUpdate().first()
        await holder('pages').where({ id: 42 }).update(window)
        const blockerPid = (await holder.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid
        reconciliation = track(plugin.reconcilePage(42))
        await waitForBlock(reconciliation, enginePid, blockerPid)
        await holder.commit()
        await complete(reconciliation)
        expect(await db('pagesVector').where({ pageId: 42 }).select('pageId')).toEqual([])
        expect(await db('pagesWords').where({ pageId: 42 }).select('word')).toEqual([])
        expect((await plugin.query('"windowbodycipher"', { pageIds: [42] })).results).toEqual([])
      } finally {
        if (!holder.isCompleted()) await holder.rollback()
        if (reconciliation) await reconciliation.outcome
      }
    })

    for (const boundary of ['opted-out', 'absent', 'future', 'expired']) {
      it(`preserves a newer eligible vector and vocabulary when a stale ${boundary} removal resumes`, async () => {
        await db('pages').insert(page(42, { title: 'Original Falcon' }))
        await db('pageMutationOutbox').insert({
          id: '00000000-0000-4000-8000-000000000042', pageId: 42, sourceRevision: 1, effectKind: 'search', desiredState: 'absent', status: 'pending'
        })
        await plugin.rebuild()
        if (boundary === 'absent') await db('pages').where({ id: 42 }).delete()
        else if (boundary === 'future') await db('pages').where({ id: 42 }).update({ publishStartDate: '2999-01-01T00:00:00.000Z' })
        else if (boundary === 'expired') await db('pages').where({ id: 42 }).update({ publishEndDate: '2000-01-01T00:00:00.000Z' })
        else await db('pages').where({ id: 42 }).update({ isSearchable: false })
        const holder = await observer.transaction()
        let removal
        try {
          await holder.raw('SELECT pg_advisory_xact_lock_shared(hashtext(?))', ['wiki.search.postgres.derived-index'])
          await holder.raw('SELECT pg_advisory_xact_lock(hashtext(?), ?::integer)', ['wiki.search.postgres.page', 42])
          const blockerPid = (await holder.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid
          removal = track(plugin.removePage(42))
          await waitForBlock(removal, enginePid, blockerPid)
          const newer = page(42, {
            sourceRevision: 2, title: 'Newest Falcon', render: '<p>restoredeligiblecipher</p>',
            isSearchable: true, publishStartDate: '', publishEndDate: ''
          })
          if (boundary === 'absent') await holder('pages').insert(newer)
          else await holder('pages').where({ id: 42 }).update(newer)
          await inTransaction(holder, () => plugin.reconcilePage(42))
          await holder.commit()
          await complete(removal)
          expect(await db('pagesVector').where({ pageId: 42 }).select('sourceRevision', 'title')).toEqual([{ sourceRevision: '2', title: 'Newest Falcon' }])
          expect(await db('pagesWords').where({ pageId: 42, word: 'newest' }).select('word')).toEqual([{ word: 'newest' }])
          expect(await db('pageMutationOutbox').where({ pageId: 42 }).select('sourceRevision', 'desiredState', 'status')).toEqual([{ sourceRevision: '1', desiredState: 'absent', status: 'pending' }])
          expect((await plugin.query('"restoredeligiblecipher"', { pageIds: [42], pageRevisions: { 42: '2' } })).results).toEqual([
            expect.objectContaining({ id: 42, sourceRevision: '2', matchedFields: ['content'] })
          ])
        } finally {
          if (!holder.isCompleted()) await holder.rollback()
          if (removal) await removal.outcome
        }
      })
    }

    for (const literal of ['%', '_', '\\']) {
      it(`scores ${JSON.stringify(literal)} as a literal title/tag prefix rather than a LIKE operator`, async () => {
        await db('pages').insert([
          page(42, { title: 'Zeta', description: literal, render: '<p>ordinary body</p>' }),
          page(43, { title: `${literal} Target`, description: literal, render: '<p>ordinary body</p>' })
        ])
        await db('tags').insert([{ id: 1, tag: 'unrelated', title: 'Unrelated' }, { id: 2, tag: `${literal}tag`, title: `${literal}tag` }])
        await db('pageTags').insert([{ pageId: 42, tagId: 1 }, { pageId: 43, tagId: 2 }])
        await plugin.rebuild()
        const result = await plugin.query(literal, { pageIds: [42, 43], limit: 2 })
        expect(result.results.map(candidate => ({ id: candidate.id, score: candidate.score }))).toEqual([
          { id: 43, score: 5 },
          { id: 42, score: 0 }
        ])
        expect((await plugin.query(literal, { pageIds: [42, 43], limit: 1 })).results.map(candidate => candidate.id)).toEqual([43])
      })
    }
  })
}
