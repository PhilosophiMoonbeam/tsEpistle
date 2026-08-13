import _ from 'lodash'

import configuration, { validateRows } from './configuration.ts'

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

interface SearchEngineQuery {
  patch(data: Record<string, unknown>): { where(column: string, value: unknown): Promise<unknown> }
}

interface SearchEngineModel {
  getSearchEngines(): Promise<SearchEngineRow[]>
  query(): SearchEngineQuery
  initEngine(options: { activate: boolean }): Promise<unknown>
}

interface ActiveSearchEngine {
  key: string
  deactivate(): Promise<unknown>
  rebuild(): unknown
}

const searchEngineModel = (WIKI.models as { searchEngines: SearchEngineModel }).searchEngines
const searchEngineDefinitions = (WIKI.data as { searchEngines: Array<Record<string, unknown> & { key: string }> }).searchEngines
const activeSearchEngine = (WIKI.data as { searchEngine: ActiveSearchEngine }).searchEngine
const logger = WIKI.logger as { warn(message: string, error: unknown): void }

const validEngine = (engine: unknown): engine is SearchEngineRow => Boolean(
  engine &&
  typeof engine === 'object' &&
  !Array.isArray(engine) &&
  typeof Reflect.get(engine, 'key') === 'string' &&
  typeof Reflect.get(engine, 'isEnabled') === 'boolean' &&
  Array.isArray(Reflect.get(engine, 'config'))
)

const listEngines = async (orderBy?: string): Promise<Array<Record<string, unknown>>> => {
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
  const updates = engines.map(engine => ({
    key: engine.key,
    isEnabled: engine.isEnabled,
    config: parseConfig(engine.config, { errorMessage: 'Invalid search engines payload' })
  }))
  let newActiveEngine = ''
  for (const engine of updates) {
    if (engine.isEnabled) newActiveEngine = engine.key
    await searchEngineModel.query().patch({
      isEnabled: engine.isEnabled,
      config: engine.config
    }).where('key', engine.key)
  }
  if (newActiveEngine !== activeSearchEngine.key) {
    try {
      await activeSearchEngine.deactivate()
    } catch (error) {
      logger.warn('Failed to deactivate previous search engine:', error)
    }
  }
  await searchEngineModel.initEngine({ activate: true })
}

const rebuildIndex = (): unknown => activeSearchEngine.rebuild()

export default { listEngines, rebuildIndex, updateEngines }
