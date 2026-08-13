const _ = require('lodash')

const { parseConfig, serializeConfig, validateRows } = require('./configuration')

/* global WIKI */

const validRenderer = renderer => renderer && typeof renderer === 'object' && !Array.isArray(renderer) && typeof renderer.key === 'string' && typeof renderer.isEnabled === 'boolean' && Array.isArray(renderer.config)

const listRenderers = async orderBy => {
  const renderers = await WIKI.models.renderers.getRenderers()
  const result = renderers.map(renderer => {
    const definition = _.find(WIKI.data.renderers, ['key', renderer.key]) || {}
    return {
      ...definition,
      ...renderer,
      config: serializeConfig({ config: renderer.config, definition, knownOnly: true })
    }
  })
  return orderBy ? _.sortBy(result, [orderBy]) : result
}

const updateRenderers = async renderers => {
  validateRows(renderers, validRenderer, 'Invalid renderers payload')
  const updates = renderers.map(renderer => ({
    key: renderer.key,
    isEnabled: renderer.isEnabled,
    config: parseConfig(renderer.config, { errorMessage: 'Invalid renderers payload' })
  }))
  for (const renderer of updates) {
    await WIKI.models.renderers.query().patch({
      isEnabled: renderer.isEnabled,
      config: renderer.config
    }).where('key', renderer.key)
  }
}

module.exports = { listRenderers, updateRenderers }
