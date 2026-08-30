import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { load as loadYaml } from 'js-yaml'
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

describe('search provider contract', () => {
  it('keeps selectable availability in parity with the documented support matrix', async () => {
    const providerKeys = ['algolia', 'aws', 'azure', 'db', 'elasticsearch', 'manticore', 'postgres', 'solr', 'sphinx']
    const definitions = await Promise.all(
      providerKeys.map(async providerKey => {
        const source = await readFile(new URL(`../../modules/search/${providerKey}/definition.yml`, import.meta.url), 'utf8')
        return loadYaml(source) as { isAvailable: boolean; key: string }
      })
    )
    const architecture = await readFile(new URL('../../../docs/search-architecture.md', import.meta.url), 'utf8')
    const documentedAvailability = Object.fromEntries(
      [...architecture.matchAll(/^\| `([^`]+)` \| (available|unavailable) \|/gmu)].map(([, key, availability]) => [key, availability === 'available'])
    )

    expect(Object.fromEntries(definitions.map(definition => [definition.key, definition.isAvailable]))).toEqual({
      algolia: true,
      aws: false,
      azure: false,
      db: true,
      elasticsearch: true,
      manticore: false,
      postgres: true,
      solr: false,
      sphinx: false
    })
    expect(documentedAvailability).toEqual(Object.fromEntries(definitions.map(definition => [definition.key, definition.isAvailable])))
  })

  it('applies Algolia scope facets before the configured bounded window', async () => {
    const candidates = [
      ...Array.from({ length: 50 }, (_, index) => ({
        objectID: String(index),
        locale: index % 2 === 0 ? 'fr' : 'en',
        path: `ops%_other/${index}`,
        title: `Higher ranked ${index}`,
        description: ''
      })),
      {
        objectID: 'in-scope',
        locale: 'en',
        path: 'ops%_/inside',
        title: 'Literal path result',
        description: ''
      }
    ]
    const searchSingleIndex = vi.fn(async (request: { searchParams: { filters?: string; hitsPerPage: number } }) => {
      expect(request.searchParams.filters).toBe('locale:"en" AND pathScopes:"ops%_"')
      const hits = candidates.filter(hit => hit.locale === 'en' && (hit.path === 'ops%_' || hit.path.startsWith('ops%_/')))
      return { hits: hits.slice(0, request.searchParams.hitsPerPage), nbHits: hits.length }
    })
    wikiGlobal.WIKI = {
      config: { search: { maxHits: 7 } },
      logger: { warn: vi.fn() },
      models: {}
    }
    const engine = (await vi.importFresh('../../modules/search/algolia/engine.ts', import.meta.url)).default
    Object.assign(engine, {
      client: { searchSingleIndex },
      config: { indexName: 'wiki' }
    })

    const result = await engine.query('literal', { locale: 'en', path: 'ops%_' })

    expect(result.results).toEqual([expect.objectContaining({ id: 'in-scope', locale: 'en', path: 'ops%_/inside' })])
    expect(searchSingleIndex.mock.calls[0]?.[0].searchParams.hitsPerPage).toBe(7)
  })

  it('delegates Algolia rebuild to atomic replacement and removes stale documents only on success', async () => {
    const rows = [{ id: 'current', locale: 'en', path: 'current', title: 'Current', description: '', render: '<p>current</p>' }]
    const stream = vi.fn(() => Readable.from(rows, { objectMode: true }))
    const query = {
      column: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      stream
    }
    const liveDocuments: Array<Record<string, unknown>> = [{ objectID: 'stale' }]
    const middleBatchFailure = new Error('Algolia middle batch failed')
    const replaceAllObjects = vi
      .fn()
      .mockRejectedValueOnce(middleBatchFailure)
      .mockImplementationOnce(async ({ objects }: { objects: Array<Record<string, unknown>> }) => {
        liveDocuments.splice(0, liveDocuments.length, ...objects)
      })
    wikiGlobal.WIKI = {
      config: { search: { maxHits: 7 } },
      logger: { info: vi.fn(), warn: vi.fn() },
      models: {
        knex: query,
        pages: { cleanHTML: vi.fn(() => 'current') }
      }
    }
    const engine = (await vi.importFresh('../../modules/search/algolia/engine.ts', import.meta.url)).default
    Object.assign(engine, {
      client: { replaceAllObjects },
      config: { indexName: 'wiki' }
    })

    await expect(engine.rebuild()).rejects.toBe(middleBatchFailure)
    expect(liveDocuments).toEqual([{ objectID: 'stale' }])

    await engine.rebuild()
    expect(replaceAllObjects).toHaveBeenLastCalledWith(
      expect.objectContaining({
        indexName: 'wiki',
        batchSize: 1000
      })
    )
    expect(liveDocuments).toEqual([expect.objectContaining({ objectID: 'current', path: 'current', pathScopes: ['current'] })])
  })

  it('applies Elasticsearch keyword scope filters before its configured size', async () => {
    const search = vi.fn(async () => ({
      hits: {
        hits: [
          {
            _id: 'in-scope',
            _source: {
              locale: 'en',
              path: 'ops%_/inside',
              title: 'Literal path result',
              description: ''
            }
          }
        ],
        total: { value: 1 }
      },
      suggest: { suggestions: [] }
    }))
    wikiGlobal.WIKI = {
      config: { search: { maxHits: 7 } },
      logger: { warn: vi.fn() }
    }
    const engine = (await vi.importFresh('../../modules/search/elasticsearch/engine.ts', import.meta.url)).default
    Object.assign(engine, {
      client: { search },
      config: { indexName: 'wiki' }
    })

    const result = await engine.query('literal', { locale: 'en', path: 'ops%_' })
    const request = search.mock.calls[0]?.[0]

    expect(result.results).toEqual([expect.objectContaining({ id: 'in-scope', locale: 'en', path: 'ops%_/inside' })])
    expect(request.size).toBe(7)
    expect(request.query.bool.filter).toEqual([
      { term: { locale: 'en' } },
      {
        bool: {
          minimum_should_match: 1,
          should: [{ term: { path: 'ops%_' } }, { prefix: { path: 'ops%_/' } }]
        }
      }
    ])
  })

  it('rejects an Elasticsearch middle bulk failure without replacing the live alias', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      id: String(index),
      realId: index,
      locale: 'en',
      path: `pages/${index}`,
      title: `Page ${index}`,
      description: '',
      render: '<p>body</p>'
    }))
    const query = {
      column: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      stream: vi.fn(() => Readable.from(rows, { objectMode: true }))
    }
    const documentFailure = { type: 'mapper_parsing_exception', reason: 'invalid document' }
    const bulk = vi
      .fn()
      .mockResolvedValueOnce({ errors: false, items: [] })
      .mockResolvedValueOnce({
        errors: true,
        items: [{ index: { _id: '1000', error: documentFailure } }]
      })
    const indices = {
      create: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      getAlias: vi.fn().mockResolvedValue({ 'wiki-old': {} }),
      updateAliases: vi.fn().mockResolvedValue({})
    }
    wikiGlobal.WIKI = {
      logger: { info: vi.fn(), warn: vi.fn() },
      models: {
        knex: query,
        pages: {
          cleanHTML: vi.fn(() => 'body'),
          query: vi.fn()
        }
      }
    }
    const engine = (await vi.importFresh('../../modules/search/elasticsearch/engine.ts', import.meta.url)).default
    Object.assign(engine, {
      client: { bulk, indices },
      config: { analyzer: 'simple', indexName: 'wiki' },
      buildTags: vi.fn(async () => [])
    })

    await expect(engine.rebuild()).rejects.toThrow('Elasticsearch bulk index failed for document 1000')

    expect(bulk).toHaveBeenCalledTimes(2)
    expect(indices.getAlias).not.toHaveBeenCalled()
    expect(indices.updateAliases).not.toHaveBeenCalled()
    expect(indices.delete).toHaveBeenCalledTimes(1)
    expect(indices.delete).not.toHaveBeenCalledWith({ index: 'wiki-old' })
  })

  it('atomically selects a complete Elasticsearch stage before removing stale live documents', async () => {
    const query = {
      column: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      stream: vi.fn(() =>
        Readable.from(
          [
            {
              id: 'current',
              realId: 1,
              locale: 'en',
              path: 'current',
              title: 'Current',
              description: '',
              render: '<p>current</p>'
            }
          ],
          { objectMode: true }
        )
      )
    }
    const bulk = vi.fn().mockResolvedValue({ errors: false, items: [] })
    const indices = {
      create: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      getAlias: vi.fn().mockResolvedValue({ 'wiki-old': {} }),
      updateAliases: vi.fn().mockResolvedValue({})
    }
    wikiGlobal.WIKI = {
      logger: { info: vi.fn(), warn: vi.fn() },
      models: {
        knex: query,
        pages: {
          cleanHTML: vi.fn(() => 'current'),
          query: vi.fn()
        }
      }
    }
    const engine = (await vi.importFresh('../../modules/search/elasticsearch/engine.ts', import.meta.url)).default
    Object.assign(engine, {
      client: { bulk, indices },
      config: { analyzer: 'simple', indexName: 'wiki' },
      buildTags: vi.fn(async () => [])
    })

    await engine.rebuild()

    const aliasActions = indices.updateAliases.mock.calls[0]?.[0].actions
    expect(aliasActions).toEqual([
      { remove: { index: 'wiki-old', alias: 'wiki' } },
      { add: { index: expect.stringMatching(/^wiki-wiki-/u), alias: 'wiki', is_write_index: true } }
    ])
    expect(indices.updateAliases.mock.invocationCallOrder[0]).toBeLessThan(indices.delete.mock.invocationCallOrder[0])
    expect(indices.delete).toHaveBeenCalledWith({ index: 'wiki-old' })
  })
})
