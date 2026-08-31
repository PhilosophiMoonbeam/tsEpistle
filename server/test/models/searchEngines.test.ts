import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type SearchEngineModel from '../../models/searchEngines.ts'

const plugin = vi.hoisted(() => ({
  activate: vi.fn(async () => undefined),
  deactivate: vi.fn(async () => undefined),
  init: vi.fn(async () => undefined),
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
let previousEngine = Object.assign(plugin, { key: 'previous', config: { dictLanguage: 'previous' } })
let data: { searchEngine: unknown }
let warn = vi.fn()

beforeEach(async () => {
  vi.resetModules()
  plugin.activate.mockReset().mockResolvedValue(undefined)
  plugin.init.mockReset().mockResolvedValue(undefined)
  previousEngine = Object.assign(plugin, { key: 'previous', config: { dictLanguage: 'previous' } })
  data = { searchEngine: previousEngine }
  warn = vi.fn()
  const enabledEngine = { key: 'postgres', isEnabled: true, config: { dictLanguage: 'english' } }
  const SearchEngineStore = Object.assign(() => undefined, {
    query: vi.fn(() => ({ findOne: vi.fn(async () => enabledEngine) }))
  })
  const knex = vi.fn()

  wikiGlobal.WIKI = {
    SERVERPATH: '/test/server',
    Error: { SearchActivationFailed: class extends Error {} },
    data,
    logger: { error: vi.fn(), info: vi.fn(), warn },
    models: {
      searchEngines: SearchEngineStore,
      knex,
      Objection: { transaction: { start: vi.fn() } }
    }
  }
  SearchEngine = (await vi.importFresh('../../models/searchEngines.ts', import.meta.url)).default
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalWiki === undefined) delete wikiGlobal.WIKI
  else wikiGlobal.WIKI = originalWiki
})

describe('models/searchEngines.initEngine', () => {
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

    await expect(SearchEngine.initEngine({ activate: true })).rejects.toBe(failure)

    expect(data.searchEngine).toBe(previousEngine)
    expect(plugin.init).not.toHaveBeenCalled()
  })

  it('publishes the candidate only after initialization succeeds', async () => {
    plugin.init.mockImplementationOnce(async () => {
      expect(data.searchEngine).toBe(previousEngine)
      expect(previousEngine).toMatchObject({ key: 'previous', config: { dictLanguage: 'previous' } })
    })

    await SearchEngine.initEngine()

    expect(data.searchEngine).not.toBe(plugin)
    expect(data.searchEngine).toMatchObject({ key: 'postgres', config: { dictLanguage: 'english' } })
  })
})

describe('models/searchEngines.refreshSearchEnginesFromDisk', () => {
  it('retains the sole on-disk provider and removes every stale database definition', async () => {
    const dbRows = [
      { key: 'postgres', isEnabled: true, config: { dictLanguage: 'german' } },
      { key: 'algolia', isEnabled: false, config: { appId: 'legacy' } },
      { key: 'solr', isEnabled: false, config: {} }
    ]
    const patchedConfigs: Array<Record<string, unknown>> = []
    const removedKeys: string[] = []
    const query = vi.fn(() => {
      let selectedKey = ''
      const builder = {
        patch: vi.fn((patch: { config: Record<string, unknown> }) => {
          patchedConfigs.push(patch.config)
          return builder
        }),
        where: vi.fn((_column: string, key: string) => {
          selectedKey = key
          return builder
        }),
        del: vi.fn(async () => {
          removedKeys.push(selectedKey)
          return 1
        }),
        then: (resolve: (rows: typeof dbRows) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(dbRows).then(resolve, reject)
      }
      return builder
    })
    const SearchEngineStore = Object.assign(() => undefined, { query })
    const info = vi.fn()
    const reconciliationData: { searchEngines?: Array<{ key: string }> } = {}
    wikiGlobal.WIKI = {
      SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)),
      Error: { SearchActivationFailed: class extends Error {} },
      data: reconciliationData,
      logger: { error: vi.fn(), info, warn: vi.fn() },
      models: {
        searchEngines: SearchEngineStore,
        knex: vi.fn(),
        Objection: { transaction: { start: vi.fn() } }
      }
    }

    await SearchEngine.refreshSearchEnginesFromDisk()

    expect(reconciliationData.searchEngines?.map(engine => engine.key)).toEqual(['postgres'])
    expect(patchedConfigs).toEqual([{ dictLanguage: 'german' }])
    expect(removedKeys).toEqual(['algolia', 'solr'])
    expect(info).toHaveBeenCalledWith('Removed search engine algolia because it is no longer present in the modules folder: [ OK ]')
    expect(info).toHaveBeenCalledWith('Removed search engine solr because it is no longer present in the modules folder: [ OK ]')
  })
})
