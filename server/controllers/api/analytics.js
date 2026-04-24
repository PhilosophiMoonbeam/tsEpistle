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

module.exports = router
