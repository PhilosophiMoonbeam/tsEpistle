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

module.exports = router
