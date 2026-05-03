const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.sendStatus(403)
    return false
  }

  return true
}

const parseIsEnabled = value => {
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  return undefined
}

const buildProviderConfig = config => {
  if (!Array.isArray(config)) {
    throw new Error('Invalid analytics provider config payload')
  }

  return _.reduce(config, (result, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.key !== 'string' || typeof value.value !== 'string') {
      throw new Error('Invalid analytics provider config payload')
    }
    _.set(result, `${value.key}`, _.get(JSON.parse(value.value), 'v', null))
    return result
  }, {})
}

const validateProviderPayload = provider => {
  return provider &&
    typeof provider === 'object' &&
    !Array.isArray(provider) &&
    typeof provider.key === 'string' &&
    typeof provider.isEnabled === 'boolean' &&
    Array.isArray(provider.config)
}

const serializeProvider = provider => {
  const providerInfo = _.find(WIKI.data.analytics, ['key', provider.key]) || {}
  const mergedProvider = {
    ...providerInfo,
    ...provider
  }
  const config = _.sortBy(_.transform(provider.config, (res, value, key) => {
    res.push({
      key,
      value: JSON.stringify({
        ..._.get(providerInfo.props, key, {}),
        value
      })
    })
  }, []), 'key')

  return {
    isEnabled: mergedProvider.isEnabled,
    key: mergedProvider.key,
    title: mergedProvider.title,
    description: mergedProvider.description,
    isAvailable: mergedProvider.isAvailable,
    logo: mergedProvider.logo,
    website: mergedProvider.website,
    config
  }
}

router.get('/providers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    const providers = await WIKI.models.analytics.getProviders(parseIsEnabled(_.get(req, 'query.isEnabled')))
    res.json(providers.map(serializeProvider))
  } catch (err) {
    next(err)
  }
})

router.post('/providers', async (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const providers = req.body && req.body.providers
  if (!Array.isArray(providers) || providers.some(provider => !validateProviderPayload(provider))) {
    res.status(400).json({ error: 'Invalid analytics providers payload' })
    return
  }

  try {
    for (const provider of providers) {
      await WIKI.models.analytics.query().patch({
        isEnabled: provider.isEnabled,
        config: buildProviderConfig(provider.config)
      }).where('key', provider.key)
      await WIKI.cache.del('analytics')
    }

    res.json({ message: 'Providers updated successfully' })
  } catch (err) {
    if (err instanceof SyntaxError || err.message === 'Invalid analytics provider config payload') {
      res.status(400).json({ error: 'Invalid analytics providers payload' })
      return
    }
    res.status(500).json({ error: err.message || 'Providers update failed' })
  }
})

module.exports = router
