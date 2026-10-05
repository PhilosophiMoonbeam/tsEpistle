import { fileURLToPath } from 'node:url'
import knexModule from 'knex'
import type { Knex } from 'knex'
import * as Objection from 'objection'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { lockSearchIndex } from '../../helpers/search-contract.ts'
import type SearchEngineModel from '../../models/searchEngines.ts'

const plugin = vi.hoisted(() => ({
  activate: vi.fn(async () => undefined),
  init: vi.fn(async (_trx?: Knex.Transaction) => undefined),
  query: vi.fn(async () => ({ results: [], suggestions: [], totalHits: 0 })),
  created: vi.fn(async () => undefined),
  updated: vi.fn(async () => undefined),
  deleted: vi.fn(async () => undefined),
  renamed: vi.fn(async () => undefined),
  rebuild: vi.fn(async () => undefined)
}))

vi.mockModule('../../modules/search/postgres/engine.ts', import.meta.url, () => ({ default: plugin }))

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
let SearchEngine: typeof SearchEngineModel
const connection = getPostgresTestConnection('_search_model_test', import.meta.path)
const startupSuite = connection ? describe : describe.skip
let previousEngine = { ...plugin, key: 'previous', config: { dictLanguage: 'previous' } }
let data: { searchEngine: unknown }
let warn = vi.fn()

beforeEach(async () => {
  vi.resetModules()
  plugin.activate.mockReset().mockResolvedValue(undefined)
  plugin.init.mockReset().mockResolvedValue(undefined)
  previousEngine = { ...plugin, key: 'previous', config: { dictLanguage: 'previous' } }
  data = { searchEngine: previousEngine }
  warn = vi.fn()
  SearchEngine = (await vi.importFresh('../../models/searchEngines.ts', import.meta.url)).default
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalWiki === undefined) delete wikiGlobal.WIKI
  else wikiGlobal.WIKI = originalWiki
})

startupSuite('models/searchEngines.initEngine persisted lifecycle', () => {
  let db: Knex

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 3 } })
    await db.raw(`
      CREATE TABLE "searchEngines" (
        key text PRIMARY KEY,
        "isEnabled" boolean NOT NULL,
        config jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `)
  })

  beforeEach(async () => {
    await db('searchEngines').delete()
    await db('searchEngines').insert({ key: 'postgres', isEnabled: true, config: { dictLanguage: 'english' } })
    SearchEngine = SearchEngine.bindKnex(db)
    wikiGlobal.WIKI = {
      SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)),
      data,
      logger: { error: vi.fn(), info: vi.fn(), warn },
      models: { searchEngines: SearchEngine, knex: db, Objection }
    }
    await SearchEngine.refreshSearchEnginesFromDisk({ strict: true })
  })

  afterAll(async () => {
    await db?.destroy()
  })

  it('rejects a disabled saved provider without replacing the old runtime', async () => {
    await db('searchEngines').where({ key: 'postgres' }).update({ isEnabled: false })

    await expect(SearchEngine.initEngine()).rejects.toThrow('Expected exactly one enabled search provider, found 0')

    expect(plugin.init).not.toHaveBeenCalled()
    expect(data.searchEngine).toBe(previousEngine)
  })

  it('rejects a missing enabled provider instead of silently skipping initialization', async () => {
    await db('searchEngines').delete()

    await expect(SearchEngine.initEngine()).rejects.toThrow('Expected exactly one enabled search provider, found 0')

    expect(plugin.init).not.toHaveBeenCalled()
    expect(data.searchEngine).toBe(previousEngine)
  })

  it('rejects ambiguous enabled providers', async () => {
    await db('searchEngines').insert({ key: 'legacy', isEnabled: true, config: {} })

    await expect(SearchEngine.initEngine()).rejects.toThrow('Expected exactly one enabled search provider, found 2')

    expect(plugin.init).not.toHaveBeenCalled()
    expect(data.searchEngine).toBe(previousEngine)
  })

  it.each(['legacy', './postgres'])('rejects a sole enabled noncanonical provider %s', async key => {
    await db('searchEngines').where({ key: 'postgres' }).update({ key })

    await expect(SearchEngine.initEngine()).rejects.toThrow(`Expected postgres to be the enabled search provider, found ${key}`)

    expect(plugin.init).not.toHaveBeenCalled()
    expect(data.searchEngine).toBe(previousEngine)
  })

  it('retains the previous engine and surfaces the original init failure', async () => {
    const failure = new Error('provider init failed')
    plugin.init.mockRejectedValueOnce(failure)

    await expect(SearchEngine.initEngine()).rejects.toBe(failure)

    expect(data.searchEngine).toBe(previousEngine)
    expect(previousEngine).toMatchObject({ key: 'previous', config: { dictLanguage: 'previous' } })
    expect(warn).toHaveBeenCalledWith(failure)
  })

  it('propagates PostgreSQL activation failures without selecting a fallback provider', async () => {
    const failure = new Error('postgres activation failed')
    plugin.activate.mockRejectedValueOnce(failure)

    await expect(SearchEngine.initEngine()).rejects.toBe(failure)

    expect(data.searchEngine).toBe(previousEngine)
    expect(plugin.init).not.toHaveBeenCalled()
  })

  it.each([{}, { dictLanguage: '' }, { dictLanguage: 'not-a-dictionary' }])('rejects invalid saved dictionary %j without replacing the old runtime', async config => {
    await db('searchEngines').where({ key: 'postgres' }).update({ config })

    await expect(SearchEngine.initEngine()).rejects.toThrow('Invalid value for search setting dictLanguage')

    expect(plugin.init).not.toHaveBeenCalled()
    expect(data.searchEngine).toBe(previousEngine)
  })

  it('publishes the candidate only after initialization succeeds', async () => {
    plugin.init.mockImplementationOnce(async (trx?: Knex.Transaction) => {
      if (!trx) throw new Error('Candidate initialization did not receive its PostgreSQL transaction')
      expect(await trx('searchEngines').where({ key: 'postgres' }).first('config')).toEqual({ config: { dictLanguage: 'english' } })
      expect(trx.isTransaction).toBe(true)
      expect(data.searchEngine).toBe(previousEngine)
      expect(previousEngine).toMatchObject({ key: 'previous', config: { dictLanguage: 'previous' } })
    })

    await SearchEngine.initEngine()

    expect(data.searchEngine).not.toBe(plugin)
    expect(data.searchEngine).toMatchObject({ key: 'postgres', config: { dictLanguage: 'english' } })
  })

  it('waits for startup ownership before selecting the freshly committed saved dictionary', async () => {
    const blocker = await db.transaction()
    await lockSearchIndex(blocker, true)
    await blocker('searchEngines').where({ key: 'postgres' }).update({ config: { dictLanguage: 'simple' } })
    const initialization = SearchEngine.initEngine().then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error })
    )

    try {
      await vi.waitFor(async () => {
        const result = await db.raw<{ rows: Array<{ waiting: boolean }> }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks lock
            JOIN pg_stat_activity activity ON activity.pid = lock.pid
            WHERE lock.locktype = 'advisory' AND NOT lock.granted
              AND activity.datname = current_database()
          ) AS waiting
        `)
        expect(result.rows[0]?.waiting).toBe(true)
      }, { timeout: 3000 })
      expect(data.searchEngine).toBe(previousEngine)
      expect(plugin.init).not.toHaveBeenCalled()
      await blocker.commit()
    } finally {
      if (!blocker.isCompleted()) await blocker.rollback()
      await initialization
    }

    expect((await initialization).error).toBeUndefined()
    expect(data.searchEngine).toMatchObject({ key: 'postgres', config: { dictLanguage: 'simple' } })
  })
})

