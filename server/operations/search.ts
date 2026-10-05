import _ from 'lodash'

import configuration, { validateRows } from './configuration.ts'
import errors from './errors.ts'
import type { SearchIndexInspection } from '../../shared/search-admin.ts'

const { parseConfig, serializeConfig } = configuration

interface ConfigEntry {
  key: string
  value: string
}

interface SearchEngineRow {
  key: string
  isEnabled: boolean
  config: ConfigEntry[] | Record<string, unknown>
  [key: string]: unknown
}

interface SearchEngineModel {
  getSearchEngines(): Promise<SearchEngineRow[]>
  configure(config: { dictLanguage: string }): Promise<void>
}

interface ActiveSearchEngine {
  key: string
  rebuild(): unknown
  inspectIndex?(): Promise<SearchIndexInspection>
}

const searchEngineModel = (WIKI.models as { searchEngines: SearchEngineModel }).searchEngines

const validEngine = (engine: unknown): engine is SearchEngineRow => Boolean(
  engine &&
  typeof engine === 'object' &&
  !Array.isArray(engine) &&
  typeof Reflect.get(engine, 'key') === 'string' &&
  typeof Reflect.get(engine, 'isEnabled') === 'boolean' &&
  Array.isArray(Reflect.get(engine, 'config'))
)

const listEngines = async (orderBy?: string): Promise<Array<Record<string, unknown>>> => {
  const searchEngineDefinitions = (WIKI.data as { searchEngines: Array<Record<string, unknown> & { key: string }> }).searchEngines
  const engines = await searchEngineModel.getSearchEngines()
  const result = engines.map(engine => {
    const definition = _.find(searchEngineDefinitions, ['key', engine.key]) ?? {}
    return {
      ...definition,
      ...engine,
      isEnabled: Boolean(engine.isEnabled),
      config: serializeConfig({ config: engine.config as Record<string, unknown>, definition, knownOnly: true })
    }
  })
  return orderBy ? _.sortBy(result, [orderBy]) : result
}

const updateEngines = async (engines: unknown): Promise<void> => {
  validateRows(engines, validEngine, 'Invalid search engines payload')
  if (engines.length !== 1 || engines[0]?.key !== 'postgres' || engines[0].isEnabled !== true) {
    throw new errors.ApplicationError('Exactly one enabled postgres search provider is required', { code: 'INVALID_CONFIGURATION' })
  }
  const engine = engines[0]
  if (!Array.isArray(engine.config) || engine.config.length !== 1 || engine.config[0]?.key !== 'dictLanguage') {
    throw new errors.ApplicationError('Search dictionary configuration is required', { code: 'INVALID_CONFIGURATION' })
  }
  const config = parseConfig(engine.config, { errorMessage: 'Invalid search engines payload' })
  const definitions = (WIKI.data as { searchEngines: Array<{ key: string; props?: Record<string, { enum?: unknown[] }> }> }).searchEngines
  const choices = definitions.find(item => item.key === 'postgres')?.props?.dictLanguage?.enum
  if (typeof config.dictLanguage !== 'string' || !Array.isArray(choices) || !choices.includes(config.dictLanguage)) {
    throw new errors.ApplicationError('Invalid value for search setting dictLanguage', { code: 'INVALID_CONFIGURATION' })
  }
  await searchEngineModel.configure({ dictLanguage: config.dictLanguage })
}

const rebuildIndex = (): unknown => (WIKI.data as { searchEngine: ActiveSearchEngine }).searchEngine.rebuild()
const inspectIndex = async () => {
  const engine = (WIKI.data as { searchEngine: ActiveSearchEngine }).searchEngine
  return { engine: engine.key, inspection: engine.inspectIndex ? await engine.inspectIndex() : null }
}

export default { listEngines, rebuildIndex, updateEngines, inspectIndex }
