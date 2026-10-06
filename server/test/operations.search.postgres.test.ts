/// <reference types="bun" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import knexModule from 'knex'
import type { Knex } from 'knex'
import * as Objection from 'objection'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import { getPostgresTestConnection } from './postgres-test-connection.mts'
import type SearchEngineModel from '../models/searchEngines.ts'
import type PageModel from '../models/pages.ts'
import type searchOperations from '../operations/search.ts'
import type { SearchOptions, SearchResult } from '../modules/types.ts'

interface RuntimeSearchEngine {
  key: string
  config: { dictLanguage: string }
  query(query: string, options: SearchOptions): Promise<SearchResult>
  reconcilePage(pageId: number): Promise<void>
}

const connection = getPostgresTestConnection('_search_admin_test', import.meta.path)
const suite = connection ? describe : describe.skip
const mutatorName = 'search-admin-configuration-test'
const transitionLock = [51724, 901] as const
const enabledProvider = (dictionary: unknown = 'english') => ({
  key: 'postgres',
  isEnabled: true,
  config: [{ key: 'dictLanguage', value: JSON.stringify({ v: dictionary }) }]
})

suite('PostgreSQL atomic search administration', () => {
  let db: Knex
  let observer: Knex
  let SearchEngine: typeof SearchEngineModel
  let operations: typeof searchOperations
  let firstRuntime: RuntimeSearchEngine
  const originalWiki = globalThis.WIKI
  let wiki: {
    SERVERPATH: string
    config: { db: { type: string }; search: { maxHits: number } }
    data: { searchEngines: unknown[]; searchEngine?: RuntimeSearchEngine }
    Error: { SearchActivationFailed: typeof Error }
    logger: { info: () => void; warn: () => void; error: () => void }
    models: { knex: Knex; pages: unknown; searchEngines: unknown; Objection: typeof Objection }
  }

  const activeRuntime = (): RuntimeSearchEngine => {
    if (!wiki.data.searchEngine) throw new Error('The PostgreSQL search runtime was not initialized')
    return wiki.data.searchEngine
  }

  const snapshot = async (database: Knex = db) => {
    const state: Record<string, unknown> = {}
    for (const table of [
      'searchEngines',
      'pages',
      'tags',
      'pageTags',
      'pageLinks',
      'pageAccessPasswords',
      'pageMutationOutbox',
      'pagesVector',
      'pagesWords',
      'pagesSearchMetadata'
    ]) {
      const result = await database.raw<{ rows: Array<{ rows: unknown }> }>(
        `SELECT COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY to_jsonb(entry)::text), '[]'::jsonb) AS rows FROM ?? entry`,
        [table]
      )
      state[table] = result.rows[0]?.rows
    }
    return state
  }

  // Sequence increments survive rollback, so this detects attempted writes as
  // well as committed changes without replacing the real transaction boundary.
  const configurationWrites = async () => {
    const result = await observer.raw<{ rows: Array<{ last_value: string; is_called: boolean }> }>(
      'SELECT last_value, is_called FROM search_configuration_attempts'
    )
    return result.rows[0]
  }

  const savedContract = async () => {
    const result = await observer.raw<{ rows: Array<{ dictionary: string; indexedDictionary: string; isEnabled: boolean }> }>(`
      SELECT configuration.config->>'dictLanguage' AS dictionary, configuration."isEnabled",
        metadata.dictionary AS "indexedDictionary"
      FROM "searchEngines" configuration CROSS JOIN "pagesSearchMetadata" metadata
      WHERE configuration.key = 'postgres' AND metadata."contractId" = 1
    `)
    return result.rows
  }

  const vectorLexemes = async () => {
    const result = await observer.raw<{ rows: Array<{ sourceRevision: string; hasRun: boolean; hasRunning: boolean }> }>(`
      SELECT "sourceRevision", tokens @@ to_tsquery('simple', 'run') AS "hasRun",
        tokens @@ to_tsquery('simple', 'running') AS "hasRunning"
      FROM "pagesVector" WHERE "pageId" = 42
    `)
    return result.rows
  }

  const expectContentMatch = async (engine: RuntimeSearchEngine, query: string, sourceRevision = '1') => {
    const result = await engine.query(query, {})
    expect(result.results).toEqual([expect.objectContaining({ id: 42, sourceRevision, matchedFields: ['content'] })])
    expect(result.totalHits).toBe(1)
  }

  // The trigger verifies the candidate's own saved config and rebuilt vectors
  // before blocking or failing its metadata publication.
  const installTransitionProbe = async (statement: string) => {
    await db.raw(`
      CREATE FUNCTION search_dictionary_transition_probe() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.dictionary = 'simple' THEN
          IF (SELECT config->>'dictLanguage' FROM "searchEngines" WHERE key = 'postgres') IS DISTINCT FROM 'simple'
            OR NOT EXISTS (
              SELECT 1 FROM "pagesVector" WHERE "pageId" = 42
                AND tokens @@ to_tsquery('simple', 'running')
                AND NOT tokens @@ to_tsquery('simple', 'run')
            ) THEN
            RAISE EXCEPTION 'The candidate did not build a simple index with its saved configuration';
          END IF;
          ${statement}
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER search_dictionary_transition_probe BEFORE INSERT OR UPDATE ON "pagesSearchMetadata"
        FOR EACH ROW EXECUTE FUNCTION search_dictionary_transition_probe();
    `)
  }

  beforeAll(async () => {
    db = knexModule({
      client: 'pg',
      connection: connection ? { ...connection, application_name: mutatorName } : undefined,
      pool: { min: 0, max: 2 },
      acquireConnectionTimeout: 1000
    })
    observer = knexModule({
      client: 'pg',
      connection: connection ? { ...connection, application_name: 'search-admin-observer-test' } : undefined,
      pool: { min: 0, max: 2 }
    })
    await db.raw(`
      CREATE TABLE "searchEngines" (
        key text PRIMARY KEY,
        "isEnabled" boolean NOT NULL,
        config jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE pages (
        id integer PRIMARY KEY,
        "sourceRevision" bigint NOT NULL,
        "renderedSourceRevision" bigint NOT NULL,
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
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL UNIQUE, title text NOT NULL);
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
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE);
      CREATE TABLE "pageMutationOutbox" (
        id uuid PRIMARY KEY,
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "sourceRevision" bigint NOT NULL,
        "effectKind" text NOT NULL,
        "desiredState" text NOT NULL,
        status text NOT NULL
      );
      CREATE SEQUENCE search_configuration_attempts;
      CREATE FUNCTION record_search_configuration_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM nextval('search_configuration_attempts');
        RETURN NULL;
      END;
      $$;
      CREATE TRIGGER record_search_configuration_attempt AFTER INSERT OR UPDATE OR DELETE ON "searchEngines"
        FOR EACH STATEMENT EXECUTE FUNCTION record_search_configuration_attempt();
    `)
  })

  beforeEach(async () => {
    await db.raw('TRUNCATE "searchEngines", pages, tags, "pageTags", "pageLinks", "pageAccessPasswords", "pageMutationOutbox" CASCADE')
    await db('searchEngines').insert({ key: 'postgres', isEnabled: true, config: { dictLanguage: 'english' } })
    await db('pages').insert({
      id: 42,
      sourceRevision: 1,
      renderedSourceRevision: 1,
      path: 'dictionary/case-42',
      localeCode: 'en',
      title: 'Dictionary specimen',
      content: 'running',
      render: '<p>running</p>',
      visibility: 'public',
      isPublished: true
    })
    wiki = {
      SERVERPATH: fileURLToPath(new URL('../', import.meta.url)),
      config: { db: { type: 'postgres' }, search: { maxHits: 100 } },
      data: { searchEngines: [] },
      Error: { SearchActivationFailed: class SearchActivationFailed extends Error {} },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      models: { knex: db, pages: undefined, searchEngines: undefined, Objection }
    }
    globalThis.WIKI = wiki as unknown as typeof WIKI
    // Fresh model/operation modules intentionally capture this test's isolated WIKI runtime.
    const Page = (await vi.importFresh<{ default: typeof PageModel }>('../models/pages.ts', import.meta.url)).default.bindKnex(db)
    SearchEngine = (await vi.importFresh<{ default: typeof SearchEngineModel }>('../models/searchEngines.ts', import.meta.url)).default.bindKnex(db)
    wiki.models.pages = Page
    wiki.models.searchEngines = SearchEngine
    await SearchEngine.refreshSearchEnginesFromDisk({ strict: true })
    await SearchEngine.initEngine()
    firstRuntime = activeRuntime()
    await SearchEngine.initEngine()
    expect(activeRuntime()).not.toBe(firstRuntime)
    operations = (await vi.importFresh<{ default: typeof searchOperations }>('../operations/search.ts', import.meta.url)).default
  })

  afterEach(async () => {
    await db.raw('DROP FUNCTION IF EXISTS search_dictionary_transition_probe() CASCADE; DROP FUNCTION IF EXISTS search_registry_refresh_probe() CASCADE')
    vi.restoreAllMocks()
    globalThis.WIKI = originalWiki
  })

  afterAll(async () => {
    await Promise.all([db?.destroy(), observer?.destroy()])
  })

  it.each([
    ['an empty provider list', []],
    ['a disabled canonical provider', [{ ...enabledProvider(), isEnabled: false }]],
    ['a noncanonical provider', [{ ...enabledProvider(), key: 'legacy' }]],
    ['a path-like provider key', [{ ...enabledProvider(), key: './postgres' }]],
    ['duplicate enabled providers', [enabledProvider(), enabledProvider()]],
    ['a missing dictionary entry', [{ ...enabledProvider(), config: [] }]],
    ['a missing configuration array', [{ key: 'postgres', isEnabled: true }]],
    ['an empty dictionary', [enabledProvider('')]],
    ['a null dictionary', [enabledProvider(null)]],
    ['a numeric dictionary', [enabledProvider(42)]],
    ['a dictionary outside the declared enum', [enabledProvider('not-a-dictionary')]]
  ])('rejects %s without a persistence attempt or loss of the old engine', async (_description, payload) => {
    const oldEngine = activeRuntime()
    await expectContentMatch(oldEngine, '"runs"')
    const before = await snapshot()
    const writesBefore = await configurationWrites()

    const rejection: unknown = await operations.updateEngines(payload).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(rejection).toBeInstanceOf(Error)
    if (!(rejection instanceof Error)) throw new Error('Expected a client configuration rejection')
    const status: unknown = Reflect.get(rejection, 'status')
    expect(typeof status).toBe('number')
    if (typeof status !== 'number') throw new Error('Expected a client error status')
    expect(status).toBeGreaterThanOrEqual(400)
    expect(status).toBeLessThan(500)

    expect(await configurationWrites()).toEqual(writesBefore)
    expect(await snapshot()).toEqual(before)
    expect(activeRuntime()).toBe(oldEngine)
    expect(await savedContract()).toEqual([{ dictionary: 'english', indexedDictionary: 'english', isEnabled: true }])
    await expectContentMatch(oldEngine, '"runs"')
    await expectContentMatch(firstRuntime, '"runs"')
  })

  it('commits saved configuration and rebuilt metadata together, then makes both older runtimes use the new dictionary', async () => {
    const operatorSetting = { retained: true, options: ['operator-managed'] }
    await db('searchEngines')
      .where({ key: 'postgres' })
      .update({ config: { dictLanguage: 'english', operatorSetting } })
    const oldEngine = activeRuntime()
    await expectContentMatch(firstRuntime, '"runs"')
    await expectContentMatch(oldEngine, '"runs"')
    expect(await vectorLexemes()).toEqual([{ sourceRevision: '1', hasRun: true, hasRunning: false }])
    const before = await snapshot()
    await installTransitionProbe(`PERFORM pg_advisory_xact_lock(${transitionLock[0]}, ${transitionLock[1]});`)
    const blocker = await observer.transaction()
    await blocker.raw('SELECT pg_advisory_xact_lock(?::integer, ?::integer)', [...transitionLock])
    const mutation = operations.updateEngines([enabledProvider('simple')]).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error })
    )

    try {
      await vi.waitFor(
        async () => {
          const result = await observer.raw<{ rows: Array<{ waiting: boolean }> }>(
            `
          SELECT EXISTS (
            SELECT 1 FROM pg_locks lock
            JOIN pg_stat_activity activity ON activity.pid = lock.pid
            WHERE lock.locktype = 'advisory' AND NOT lock.granted
              AND activity.datname = current_database() AND activity.application_name = ?
          ) AS waiting
        `,
            [mutatorName]
          )
          expect(result.rows[0]?.waiting).toBe(true)
        },
        { timeout: 3000 }
      )
      // The candidate trigger has already verified its simple vectors/config. An
      // independent connection still sees the old committed config and metadata.
      expect(await savedContract()).toEqual([{ dictionary: 'english', indexedDictionary: 'english', isEnabled: true }])
      expect(activeRuntime()).toBe(oldEngine)
      await blocker.commit()
    } finally {
      if (!blocker.isCompleted()) await blocker.rollback()
      await mutation
    }

    expect((await mutation).error).toBeUndefined()
    expect(activeRuntime()).not.toBe(oldEngine)
    expect(activeRuntime().config.dictLanguage).toBe('simple')
    expect(await savedContract()).toEqual([{ dictionary: 'simple', indexedDictionary: 'simple', isEnabled: true }])
    expect((await observer('searchEngines').where({ key: 'postgres' }).first<{ config: unknown }>())?.config).toEqual({
      dictLanguage: 'simple',
      operatorSetting
    })
    expect(await vectorLexemes()).toEqual([{ sourceRevision: '1', hasRun: false, hasRunning: true }])
    const after = await snapshot()
    for (const table of ['pages', 'tags', 'pageTags', 'pageLinks', 'pageAccessPasswords', 'pageMutationOutbox']) {
      expect(after[table]).toEqual(before[table])
    }
    for (const engine of [firstRuntime, oldEngine, activeRuntime()]) {
      await expectContentMatch(engine, '"running"')
      expect((await engine.query('"runs"', {})).results).toEqual([])
    }
    expect(firstRuntime.config.dictLanguage).toBe('english')
    expect(oldEngine.config.dictLanguage).toBe('english')

    await db('pages').where({ id: 42 }).update({ sourceRevision: 2, renderedSourceRevision: 2, render: '<p>running again</p>' })
    await firstRuntime.reconcilePage(42)
    expect(await vectorLexemes()).toEqual([{ sourceRevision: '2', hasRun: false, hasRunning: true }])
    await expectContentMatch(oldEngine, '"running"', '2')
    expect((await activeRuntime().query('"runs"', {})).results).toEqual([])
  })

  it('rolls back real saved configuration, vectors, words and metadata after a late candidate-init failure', async () => {
    const oldEngine = activeRuntime()
    const before = await snapshot()
    await installTransitionProbe("RAISE EXCEPTION 'candidate initialization failed after rebuilding simple index';")

    await expect(operations.updateEngines([enabledProvider('simple')])).rejects.toThrow()

    expect(await snapshot(observer)).toEqual(before)
    expect(await savedContract()).toEqual([{ dictionary: 'english', indexedDictionary: 'english', isEnabled: true }])
    expect(await vectorLexemes()).toEqual([{ sourceRevision: '1', hasRun: true, hasRunning: false }])
    expect(activeRuntime()).toBe(oldEngine)
    await expectContentMatch(oldEngine, '"runs"')
    await expectContentMatch(firstRuntime, '"runs"')

    // A normal retry must work on the same runtime and database, without recovery
    // scaffolding or rebuilding the previously healthy English index by hand.
    await db.raw('DROP FUNCTION search_dictionary_transition_probe() CASCADE')
    await operations.updateEngines([enabledProvider('simple')])
    expect(await savedContract()).toEqual([{ dictionary: 'simple', indexedDictionary: 'simple', isEnabled: true }])
    await expectContentMatch(activeRuntime(), '"running"')
  })

  it('fills only missing registry defaults and leaves an already current configuration unwritten', async () => {
    const oldEngine = activeRuntime()
    await db('searchEngines')
      .where({ key: 'postgres' })
      .update({ config: { operatorSetting: { retained: true } } })
    await SearchEngine.refreshSearchEnginesFromDisk({ strict: true })
    const configuration = await observer('searchEngines').where({ key: 'postgres' }).first<{ config: unknown }>()
    expect(configuration?.config).toEqual({ dictLanguage: 'english', operatorSetting: { retained: true } })
    expect(await savedContract()).toEqual([{ dictionary: 'english', indexedDictionary: 'english', isEnabled: true }])
    expect(activeRuntime()).toBe(oldEngine)
    await expectContentMatch(oldEngine, '"runs"')

    const writesBefore = await configurationWrites()
    await SearchEngine.refreshSearchEnginesFromDisk({ strict: true })
    expect(await configurationWrites()).toEqual(writesBefore)
    expect((await observer('searchEngines').where({ key: 'postgres' }).first<{ config: unknown }>())?.config).toEqual(configuration?.config)
    expect(activeRuntime()).toBe(oldEngine)
  })

  it.each(['empty directory', 'wrong canonical key'])('rejects a registry with %s before changing saved configuration or published engines', async scenario => {
    const config = { dictLanguage: 'simple', operatorSetting: { retained: true, options: ['operator-managed'] } }
    await db('searchEngines').where({ key: 'postgres' }).update({ config })
    await SearchEngine.initEngine()
    const oldEngine = activeRuntime()
    const definitions = wiki.data.searchEngines
    const before = await snapshot(observer)
    const writesBefore = await configurationWrites()
    const serverPath = wiki.SERVERPATH
    const temporaryServerPath = await mkdtemp(path.join(tmpdir(), 'search-registry-preservation-'))

    try {
      const registryPath = path.join(temporaryServerPath, 'modules/search')
      await mkdir(registryPath, { recursive: true })
      if (scenario === 'wrong canonical key') {
        const definition = await readFile(path.join(serverPath, 'modules/search/postgres/definition.yml'), 'utf8')
        await mkdir(path.join(registryPath, 'postgres'))
        await writeFile(path.join(registryPath, 'postgres/definition.yml'), definition.replace(/^key: postgres$/m, 'key: wrong-provider'))
      }
      wiki.SERVERPATH = temporaryServerPath
      const outcome = await SearchEngine.refreshSearchEnginesFromDisk({ strict: true }).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
      )

      // Assert the real persisted state first: a fulfilled refresh that deleted
      // postgres must not hide the data-loss regression behind an error assertion.
      expect(await observer('searchEngines').orderBy('key')).toEqual([{ key: 'postgres', isEnabled: true, config }])
      expect(await snapshot(observer)).toEqual(before)
      expect(await configurationWrites()).toEqual(writesBefore)
      expect(wiki.data.searchEngines).toBe(definitions)
      expect(activeRuntime()).toBe(oldEngine)
      expect(oldEngine.config.dictLanguage).toBe('simple')
      await expectContentMatch(oldEngine, '"running"')
      expect((await oldEngine.query('"runs"', {})).results).toEqual([])
      expect(outcome.error).toBeInstanceOf(Error)
    } finally {
      wiki.SERVERPATH = serverPath
      await rm(temporaryServerPath, { recursive: true, force: true })
    }
  })

  it('rolls back registry defaults and removals without publishing unsuccessful definition metadata', async () => {
    const oldEngine = activeRuntime()
    const definitions = wiki.data.searchEngines
    await db('searchEngines').where({ key: 'postgres' }).update({ config: {} })
    await db('searchEngines').insert({ key: 'removed-provider', isEnabled: false, config: {} })
    const before = await snapshot()
    await db.raw(`
      CREATE FUNCTION search_registry_refresh_probe() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Forced registry removal failure';
      END;
      $$;
      CREATE TRIGGER search_registry_refresh_probe BEFORE DELETE ON "searchEngines"
        FOR EACH ROW EXECUTE FUNCTION search_registry_refresh_probe();
    `)

    await expect(SearchEngine.refreshSearchEnginesFromDisk({ strict: true })).rejects.toThrow()

    expect(await snapshot(observer)).toEqual(before)
    expect(wiki.data.searchEngines).toBe(definitions)
    expect(activeRuntime()).toBe(oldEngine)
    await expectContentMatch(oldEngine, '"runs"')
    await expectContentMatch(firstRuntime, '"runs"')
  })

  it('preserves a concurrently committed dictionary through registry refresh and the next startup', async () => {
    const oldEngine = activeRuntime()
    await db('pages').where({ id: 42 }).update({ content: 'chevaux', render: '<p>chevaux</p>' })
    await oldEngine.reconcilePage(42)
    expect((await oldEngine.query('"cheval"', {})).results).toEqual([])
    const writesBefore = await configurationWrites()
    await db.raw(`
      CREATE FUNCTION search_dictionary_transition_probe() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.dictionary = 'french' THEN
          PERFORM pg_advisory_xact_lock(${transitionLock[0]}, ${transitionLock[1]});
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER search_dictionary_transition_probe BEFORE INSERT OR UPDATE ON "pagesSearchMetadata"
        FOR EACH ROW EXECUTE FUNCTION search_dictionary_transition_probe();
    `)
    const blocker = await observer.transaction()
    await blocker.raw('SELECT pg_advisory_xact_lock(?::integer, ?::integer)', [...transitionLock])
    const mutation = operations.updateEngines([enabledProvider('french')]).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error })
    )
    let refresh: Promise<{ error: unknown }> | undefined
    const waitForBlockedConnections = async (count: number) => {
      await vi.waitFor(
        async () => {
          const result = await observer.raw<{ rows: Array<{ blocked: string }> }>(
            `
          SELECT count(*) AS blocked FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = ?
            AND cardinality(pg_blocking_pids(pid)) > 0
        `,
            [mutatorName]
          )
          expect(Number(result.rows[0]?.blocked)).toBe(count)
        },
        { timeout: 3000 }
      )
    }

    try {
      await waitForBlockedConnections(1)
      refresh = SearchEngine.refreshSearchEnginesFromDisk({ strict: true }).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
      )
      // Configure is blocked at metadata publication; a second real connection
      // is now refreshing the registry while its new dictionary is uncommitted.
      await waitForBlockedConnections(2)
      expect(await savedContract()).toEqual([{ dictionary: 'english', indexedDictionary: 'english', isEnabled: true }])
      expect(activeRuntime()).toBe(oldEngine)
      await blocker.commit()
    } finally {
      if (!blocker.isCompleted()) await blocker.rollback()
      await Promise.all([mutation, refresh])
    }

    expect((await mutation).error).toBeUndefined()
    expect(refresh).toBeDefined()
    expect((await refresh)?.error).toBeUndefined()
    const newEngine = activeRuntime()
    expect(newEngine).not.toBe(oldEngine)
    expect(newEngine.config.dictLanguage).toBe('french')
    expect(await savedContract()).toEqual([{ dictionary: 'french', indexedDictionary: 'french', isEnabled: true }])
    // Only configure writes: an unchanged defaults merge must not rewrite config.
    expect(await configurationWrites()).toEqual({
      last_value: String(Number(writesBefore?.last_value) + 1),
      is_called: true
    })
    for (const engine of [firstRuntime, oldEngine, newEngine]) {
      await expectContentMatch(engine, '"cheval"')
    }
    await SearchEngine.initEngine()
    expect(activeRuntime().config.dictLanguage).toBe('french')
    expect(await savedContract()).toEqual([{ dictionary: 'french', indexedDictionary: 'french', isEnabled: true }])
    await expectContentMatch(activeRuntime(), '"cheval"')
  })
})
