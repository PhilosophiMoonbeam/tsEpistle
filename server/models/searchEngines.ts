import { Model } from 'objection'
import type { Knex } from 'knex'
import path from 'node:path'
import fs from 'fs-extra'
import _ from 'lodash'
import * as yaml from 'js-yaml'
import commonHelper from '../helpers/common.ts'
import { lockSearchIndex } from '../helpers/search-contract.ts'
import { isRecord, readModuleDefinition, readModuleDirectories } from './moduleTypes.ts'
import type { LoadedModuleDefinition, ModuleConfig, ModuleDefinition } from './moduleTypes.ts'
import postgresSearchEngine from '../modules/search/postgres/engine.ts'
import type { SearchOptions, SearchResult, WikiPage } from '../modules/types.ts'

interface SearchEnginePlugin {
  activate(): Promise<void>
  init(trx?: Knex.Transaction): Promise<void>
  query(query: string, options: SearchOptions): Promise<SearchResult>
  created(page: WikiPage): Promise<void>
  updated(page: WikiPage): Promise<void>
  deleted(page: WikiPage): Promise<void>
  renamed(page: WikiPage): Promise<void>
  rebuild(): Promise<void>
}

interface RuntimeSearchEngine extends SearchEnginePlugin {
  key: string
  config: ModuleConfig
}

interface SearchEngineData {
  searchEngines?: LoadedModuleDefinition[]
  searchEngine?: RuntimeSearchEngine
}

interface SearchEngineLogger {
  error(value: unknown): void
  info(message: string): void
  warn(value: unknown): void
}

interface SearchEngineWikiRuntime {
  SERVERPATH: string
  data: SearchEngineData
  logger: SearchEngineLogger
  models: {
    searchEngines: typeof SearchEngine
    knex: Knex
  }
}

interface RefreshSearchEnginesOptions {
  strict?: boolean
}

function isSearchEngineWikiRuntime(value: unknown): value is SearchEngineWikiRuntime {
  if (!isRecord(value) || typeof value.SERVERPATH !== 'string') return false
  if (!isRecord(value.data) || !isRecord(value.logger) || !isRecord(value.models)) return false
  if (typeof value.logger.error !== 'function' || typeof value.logger.info !== 'function' || typeof value.logger.warn !== 'function') return false
  if (typeof value.models.searchEngines !== 'function' || typeof value.models.knex !== 'function') return false
  return true
}

function getWiki(): SearchEngineWikiRuntime {
  const value: unknown = WIKI
  if (!isSearchEngineWikiRuntime(value)) {
    throw new Error('WIKI search engine services are not initialized')
  }
  return value
}

function createDefaultConfig(props: LoadedModuleDefinition['props']): ModuleConfig {
  const config: ModuleConfig = {}
  for (const [key, value] of Object.entries(props)) {
    _.set(config, key, value.default)
  }
  return config
}

function addMissingConfigDefaults(config: ModuleConfig, props: LoadedModuleDefinition['props']): ModuleConfig {
  let updatedConfig = config
  for (const [key, value] of Object.entries(props)) {
    if (!_.has(updatedConfig, key)) {
      if (updatedConfig === config) updatedConfig = _.cloneDeep(config)
      _.set(updatedConfig, key, value.default)
    }
  }
  return updatedConfig
}

function validateDictionary(wiki: SearchEngineWikiRuntime, dictionary: unknown): asserts dictionary is string {
  const choices = wiki.data.searchEngines?.find(engine => engine.key === 'postgres')?.props.dictLanguage?.enum
  if (typeof dictionary !== 'string' || !Array.isArray(choices) || !choices.includes(dictionary)) {
    throw new Error('Invalid value for search setting dictLanguage')
  }
}

async function initializeEngine(wiki: SearchEngineWikiRuntime, config: ModuleConfig, trx: Knex.Transaction): Promise<RuntimeSearchEngine> {
  validateDictionary(wiki, config.dictLanguage)
  const engine: RuntimeSearchEngine = { ...postgresSearchEngine, key: 'postgres', config: { dictLanguage: config.dictLanguage } }
  try {
    await engine.activate()
    await engine.init(trx)
  } catch (error) {
    wiki.logger.warn(error)
    throw error
  }
  return engine
}

/**
 * SearchEngine model
 */
export default class SearchEngine extends Model {
  declare key: string
  declare isEnabled: boolean
  declare level?: string
  declare config: ModuleConfig

  static override get tableName() {
    return 'searchEngines'
  }

  static override get idColumn() {
    return 'key'
  }

  static override get jsonSchema() {
    return {
      type: 'object',
      required: ['key', 'isEnabled'],
      properties: {
        key: { type: 'string' },
        isEnabled: { type: 'boolean' },
        level: { type: 'string' },
        config: { type: 'object' }
      }
    }
  }

  static override get jsonAttributes() {
    return ['config']
  }

  static async getSearchEngines(): Promise<SearchEngine[]> {
    return getWiki().models.searchEngines.query()
  }

  static async refreshSearchEnginesFromDisk({ strict = false }: RefreshSearchEnginesOptions = {}): Promise<void> {
    const wiki = getWiki()
    try {
      // Load definitions before opening a transaction or taking the index lock.
      const searchEnginesDirs = await readModuleDirectories(path.join(wiki.SERVERPATH, 'modules/search'))
      const definitions: ModuleDefinition[] = []
      for (const dir of searchEnginesDirs) {
        const definitionPath = path.join(wiki.SERVERPATH, 'modules/search', dir, 'definition.yml')
        const definition = yaml.load(await fs.readFile(definitionPath, 'utf8'))
        definitions.push(readModuleDefinition(definition, definitionPath))
      }
      const diskSearchEngines: LoadedModuleDefinition[] = definitions.map(searchEngine => ({
        ...searchEngine,
        props: commonHelper.parseModuleProps(searchEngine.props)
      }))
      const changes = await wiki.models.knex.transaction(async trx => {
        // Configuration may have committed while definitions were loading or
        // this lock was waiting. Read only after taking the configure/startup lock.
        await lockSearchIndex(trx, true)
        const dbSearchEngines = await wiki.models.searchEngines.query(trx)
        let added = 0
        const removed: string[] = []
        for (const searchEngine of diskSearchEngines) {
          const dbSearchEngine = dbSearchEngines.find(candidate => candidate.key === searchEngine.key)
          if (!dbSearchEngine) {
            await wiki.models.searchEngines.query(trx).insert({
              key: searchEngine.key,
              isEnabled: false,
              config: createDefaultConfig(searchEngine.props)
            })
            added += 1
          } else {
            const config = isRecord(dbSearchEngine.config) ? dbSearchEngine.config : {}
            const updatedConfig = addMissingConfigDefaults(config, searchEngine.props)
            if (updatedConfig !== config) {
              await wiki.models.searchEngines.query(trx).patch({ config: updatedConfig }).where('key', searchEngine.key)
            }
          }
        }
        for (const searchEngine of dbSearchEngines) {
          if (!diskSearchEngines.some(candidate => candidate.key === searchEngine.key)) {
            await wiki.models.searchEngines.query(trx).where('key', searchEngine.key).del()
            removed.push(searchEngine.key)
          }
        }
        return { added, removed }
      })
      wiki.data.searchEngines = diskSearchEngines
      if (changes.added > 0) {
        wiki.logger.info(`Loaded ${changes.added} new search engines: [ OK ]`)
      } else {
        wiki.logger.info('No new search engines found: [ SKIPPED ]')
      }
      for (const key of changes.removed) {
        wiki.logger.info(`Removed search engine ${key} because it is no longer present in the modules folder: [ OK ]`)
      }
    } catch (err) {
      wiki.logger.error('Failed to scan or load new search engines: [ FAILED ]')
      wiki.logger.error(err)
      if (strict) throw err
    }
  }

  static async initEngine(): Promise<void> {
    const wiki = getWiki()
    const engine = await wiki.models.knex.transaction(async trx => {
      // Wait first: another instance may commit a new dictionary while startup is blocked.
      await lockSearchIndex(trx, true)
      const enabledSearchEngines = await wiki.models.searchEngines.query(trx).where('isEnabled', true)
      if (enabledSearchEngines.length !== 1) {
        throw new Error(`Expected exactly one enabled search provider, found ${enabledSearchEngines.length}`)
      }
      const searchEngine = enabledSearchEngines[0]
      if (!searchEngine || searchEngine.key !== 'postgres') {
        throw new Error(`Expected postgres to be the enabled search provider, found ${searchEngine?.key}`)
      }
      return initializeEngine(wiki, searchEngine.config, trx)
    })
    wiki.data.searchEngine = engine
  }

  static async configure({ dictLanguage }: { dictLanguage: string }): Promise<void> {
    const wiki = getWiki()
    validateDictionary(wiki, dictLanguage)
    const engine = await wiki.models.knex.transaction(async trx => {
      await lockSearchIndex(trx, true)
      const changed = await wiki.models.searchEngines.query(trx).patch({
        isEnabled: true,
        config: { dictLanguage }
      }).where('key', 'postgres')
      if (changed !== 1) throw new Error('Canonical postgres search provider is missing')
      const enabledSearchEngines = await wiki.models.searchEngines.query(trx).where('isEnabled', true)
      if (enabledSearchEngines.length !== 1 || enabledSearchEngines[0]?.key !== 'postgres') {
        throw new Error('Expected exactly one enabled postgres search provider')
      }
      return initializeEngine(wiki, { dictLanguage }, trx)
    })
    // The old runtime remains available through the entire transaction, including rollback.
    wiki.data.searchEngine = engine
  }
}
