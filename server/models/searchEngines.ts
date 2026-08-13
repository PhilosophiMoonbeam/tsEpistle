import { Model } from 'objection'
import type { Knex } from 'knex'
import path from 'node:path'
import fs from 'fs-extra'
import _ from 'lodash'
import * as yaml from 'js-yaml'
import commonHelper from '../helpers/common.ts'
import { hasMethod, isRecord, readModuleDefinition, readModuleDirectories } from './moduleTypes.ts'
import type {
  LoadedModuleDefinition,
  ModuleConfig,
  ModuleDefinition
} from './moduleTypes.ts'
import type { SearchOptions, SearchResult, WikiPage } from '../modules/types.ts'

interface SearchEnginePlugin {
  activate(): Promise<void>
  deactivate(): Promise<void>
  init(): Promise<void>
  query(query: string, options: SearchOptions): Promise<SearchResult | void>
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
  Error: {
    SearchActivationFailed: new (...args: unknown[]) => Error
  }
  data: SearchEngineData
  logger: SearchEngineLogger
  models: {
    searchEngines: typeof SearchEngine
    knex: Knex
    Objection: {
      transaction: {
        start(knex: Knex): Promise<Knex.Transaction>
      }
    }
  }
}

interface InitEngineOptions {
  activate?: boolean
}

const pluginMethods = [
  'activate',
  'deactivate',
  'init',
  'query',
  'created',
  'updated',
  'deleted',
  'renamed',
  'rebuild'
] as const

function isSearchEnginePlugin (value: unknown): value is SearchEnginePlugin {
  return isRecord(value) && pluginMethods.every(method => typeof value[method] === 'function')
}

function readSearchEnginePlugin (value: unknown, source: string): SearchEnginePlugin {
  if (!isRecord(value) || !isSearchEnginePlugin(value.default)) {
    throw new Error(`Invalid search engine module: ${source}`)
  }
  return value.default
}

function isSearchEngineWikiRuntime (value: unknown): value is SearchEngineWikiRuntime {
  if (!isRecord(value) || typeof value.SERVERPATH !== 'string') return false
  if (!isRecord(value.Error) || typeof value.Error.SearchActivationFailed !== 'function') return false
  if (!isRecord(value.data) || !isRecord(value.logger) || !isRecord(value.models)) return false
  if (
    typeof value.logger.error !== 'function' ||
    typeof value.logger.info !== 'function' ||
    typeof value.logger.warn !== 'function'
  ) return false
  if (
    typeof value.models.searchEngines !== 'function' ||
    typeof value.models.knex !== 'function' ||
    !isRecord(value.models.Objection) ||
    !hasMethod(value.models.Objection.transaction, 'start')
  ) return false
  return true
}

function getWiki (): SearchEngineWikiRuntime {
  const value: unknown = WIKI
  if (!isSearchEngineWikiRuntime(value)) {
    throw new Error('WIKI search engine services are not initialized')
  }
  return value
}

function createDefaultConfig (props: LoadedModuleDefinition['props']): ModuleConfig {
  const config: ModuleConfig = {}
  for (const [key, value] of Object.entries(props)) {
    _.set(config, key, value.default)
  }
  return config
}

function addMissingConfigDefaults (
  config: ModuleConfig,
  props: LoadedModuleDefinition['props']
): ModuleConfig {
  for (const [key, value] of Object.entries(props)) {
    if (!_.has(config, key)) {
      _.set(config, key, value.default)
    }
  }
  return config
}

/**
 * SearchEngine model
 */
export default class SearchEngine extends Model {
  declare key: string
  declare isEnabled: boolean
  declare level?: string
  declare config: ModuleConfig

  static override get tableName () {
    return 'searchEngines'
  }

  static override get idColumn () {
    return 'key'
  }

  static override get jsonSchema () {
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

  static override get jsonAttributes () {
    return ['config']
  }

  static async getSearchEngines (): Promise<SearchEngine[]> {
    return getWiki().models.searchEngines.query()
  }

  static async refreshSearchEnginesFromDisk (): Promise<void> {
    const wiki = getWiki()
    let trx: Knex.Transaction | undefined
    try {
      const dbSearchEngines = await wiki.models.searchEngines.query()

      // -> Fetch definitions from disk
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
      wiki.data.searchEngines = diskSearchEngines

      // -> Insert new searchEngines
      const newSearchEngines: Array<Pick<SearchEngine, 'key' | 'isEnabled' | 'config'>> = []
      for (const searchEngine of diskSearchEngines) {
        const dbSearchEngine = dbSearchEngines.find(candidate => candidate.key === searchEngine.key)
        if (!dbSearchEngine) {
          newSearchEngines.push({
            key: searchEngine.key,
            isEnabled: false,
            config: createDefaultConfig(searchEngine.props)
          })
        } else {
          const config = isRecord(dbSearchEngine.config) ? dbSearchEngine.config : {}
          await wiki.models.searchEngines.query().patch({
            config: addMissingConfigDefaults(config, searchEngine.props)
          }).where('key', searchEngine.key)
        }
      }
      if (newSearchEngines.length > 0) {
        trx = await wiki.models.Objection.transaction.start(wiki.models.knex)
        for (const searchEngine of newSearchEngines) {
          await wiki.models.searchEngines.query(trx).insert(searchEngine)
        }
        await trx.commit()
        wiki.logger.info(`Loaded ${newSearchEngines.length} new search engines: [ OK ]`)
      } else {
        wiki.logger.info('No new search engines found: [ SKIPPED ]')
      }
    } catch (err) {
      wiki.logger.error('Failed to scan or load new search engines: [ FAILED ]')
      wiki.logger.error(err)
      if (trx) {
        trx.rollback()
      }
    }
  }

  static async initEngine ({ activate = false }: InitEngineOptions = {}): Promise<void> {
    const wiki = getWiki()
    const searchEngine = await wiki.models.searchEngines.query().findOne('isEnabled', true)
    if (!searchEngine) return

    // Provider is selected from the runtime registry, so a static import cannot identify the module.
    const source = `../modules/search/${searchEngine.key}/engine.ts`
    const plugin = readSearchEnginePlugin(await import(source), source)
    const engine: RuntimeSearchEngine = Object.assign(plugin, {
      key: searchEngine.key,
      config: searchEngine.config
    })
    wiki.data.searchEngine = engine
    if (activate) {
      try {
        await engine.activate()
      } catch (err) {
        // -> Revert to basic engine
        if (err instanceof wiki.Error.SearchActivationFailed) {
          await wiki.models.searchEngines.query().patch({ isEnabled: false }).where('key', searchEngine.key)
          await wiki.models.searchEngines.query().patch({ isEnabled: true }).where('key', 'db')
          await wiki.models.searchEngines.initEngine()
        }
        throw err
      }
    }

    try {
      await engine.init()
    } catch (err) {
      wiki.logger.warn(err)
    }
  }
}
