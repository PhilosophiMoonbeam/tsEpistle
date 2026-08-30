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
  class SearchEngineStore {
    static query = vi.fn(() => ({ findOne: vi.fn(async () => enabledEngine) }))
  }
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
