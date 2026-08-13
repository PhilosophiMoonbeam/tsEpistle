const _ = require('lodash')

const { parseConfig, serializeConfig, validateRows } = require('./configuration')

/* global WIKI */

const validEngine = engine => engine && typeof engine === 'object' && !Array.isArray(engine) && typeof engine.key === 'string' && typeof engine.isEnabled === 'boolean' && Array.isArray(engine.config)

const listEngines = async orderBy => {
  const engines = await WIKI.models.searchEngines.getSearchEngines()
  const result = engines.map(engine => {
    const definition = _.find(WIKI.data.searchEngines, ['key', engine.key]) || {}
    return {
      ...definition,
      ...engine,
      config: serializeConfig({ config: engine.config, definition, knownOnly: true })
    }
  })
  return orderBy ? _.sortBy(result, [orderBy]) : result
}

const updateEngines = async engines => {
  validateRows(engines, validEngine, 'Invalid search engines payload')
  const updates = engines.map(engine => ({
    key: engine.key,
    isEnabled: engine.isEnabled,
    config: parseConfig(engine.config, { errorMessage: 'Invalid search engines payload' })
  }))
  let newActiveEngine = ''
  for (const engine of updates) {
    if (engine.isEnabled) newActiveEngine = engine.key
    await WIKI.models.searchEngines.query().patch({
      isEnabled: engine.isEnabled,
      config: engine.config
    }).where('key', engine.key)
  }
  if (newActiveEngine !== WIKI.data.searchEngine.key) {
    try {
      await WIKI.data.searchEngine.deactivate()
    } catch (err) {
      WIKI.logger.warn('Failed to deactivate previous search engine:', err)
    }
  }
  await WIKI.models.searchEngines.initEngine({ activate: true })
}

const rebuildIndex = () => WIKI.data.searchEngine.rebuild()

module.exports = { listEngines, rebuildIndex, updateEngines }
