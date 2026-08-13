const _ = require('lodash')

const { parseConfig, serializeConfig, validateRows } = require('./configuration')

/* global WIKI */

const validProvider = provider => provider && typeof provider === 'object' && !Array.isArray(provider) && typeof provider.key === 'string' && typeof provider.isEnabled === 'boolean' && Array.isArray(provider.config)

const listProviders = async isEnabled => {
  const providers = await WIKI.models.analytics.getProviders(isEnabled)
  return providers.map(provider => {
    const definition = _.find(WIKI.data.analytics, ['key', provider.key]) || {}
    return {
      ...definition,
      ...provider,
      config: serializeConfig({ config: provider.config, definition })
    }
  })
}

const updateProviders = async providers => {
  validateRows(providers, validProvider, 'Invalid analytics providers payload')
  const updates = providers.map(provider => ({
    key: provider.key,
    isEnabled: provider.isEnabled,
    config: parseConfig(provider.config, { errorMessage: 'Invalid analytics providers payload' })
  }))
  for (const provider of updates) {
    await WIKI.models.analytics.query().patch({
      isEnabled: provider.isEnabled,
      config: provider.config
    }).where('key', provider.key)
    await WIKI.cache.del('analytics')
  }
}

module.exports = { listProviders, updateProviders }
