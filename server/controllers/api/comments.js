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

const buildProviderConfig = config => {
  if (!Array.isArray(config)) {
    throw new Error('Invalid comment provider config payload')
  }

  return _.reduce(config, (result, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.key !== 'string' || typeof value.value !== 'string') {
      throw new Error('Invalid comment provider config payload')
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
  const providerInfo = _.find(WIKI.data.commentProviders, ['key', provider.key]) || {}
  const mergedProvider = {
    ...providerInfo,
    ...provider
  }
  const config = _.sortBy(_.transform(provider.config, (res, value, key) => {
    const configData = _.get(providerInfo.props, key, false)
    if (configData) {
      res.push({
        key,
        value: JSON.stringify({
          ...configData,
          value
        })
      })
    }
  }, []), 'key')

  return {
    isEnabled: mergedProvider.isEnabled,
    key: mergedProvider.key,
    title: mergedProvider.title,
    description: mergedProvider.description,
    logo: mergedProvider.logo,
    website: mergedProvider.website,
    isAvailable: mergedProvider.isAvailable,
    config
  }
}

router.get('/providers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    const providers = await WIKI.models.commentProviders.getProviders()
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
    res.status(400).json({ error: 'Invalid comment providers payload' })
    return
  }

  try {
    for (const provider of providers) {
      await WIKI.models.commentProviders.query().patch({
        isEnabled: provider.isEnabled,
        config: buildProviderConfig(provider.config)
      }).where('key', provider.key)
    }
    await WIKI.models.commentProviders.initProvider()

    res.json({ message: 'Comment Providers updated successfully' })
  } catch (err) {
    if (err instanceof SyntaxError || err.message === 'Invalid comment provider config payload') {
      res.status(400).json({ error: 'Invalid comment providers payload' })
      return
    }
    res.status(500).json({ error: err.message || 'Comment providers update failed' })
  }
})

module.exports = router
