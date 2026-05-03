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

const serializeSearchEngine = searchEngine => {
  const searchEngineInfo = _.find(WIKI.data.searchEngines, ['key', searchEngine.key]) || {}
  const mergedSearchEngine = {
    ...searchEngineInfo,
    ...searchEngine
  }
  const config = _.sortBy(_.transform(searchEngine.config || {}, (res, value, key) => {
    const configData = _.get(searchEngineInfo.props, key, false)
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
    isEnabled: mergedSearchEngine.isEnabled,
    key: mergedSearchEngine.key,
    title: mergedSearchEngine.title,
    description: mergedSearchEngine.description,
    logo: mergedSearchEngine.logo,
    website: mergedSearchEngine.website,
    isAvailable: mergedSearchEngine.isAvailable,
    config
  }
}

router.get('/engines', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    const searchEngines = await WIKI.models.searchEngines.getSearchEngines()
    res.json(_.sortBy(searchEngines.map(serializeSearchEngine), ['title']))
  } catch (err) {
    next(err)
  }
})

router.post('/rebuild-index', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await WIKI.data.searchEngine.rebuild()
    res.json({ message: 'Index rebuilt successfully' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Index rebuild failed' })
  }
})

module.exports = router
