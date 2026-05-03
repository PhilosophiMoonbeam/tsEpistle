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

const buildSearchEngineConfig = config => {
  if (!Array.isArray(config)) {
    throw new Error('Invalid search engine config payload')
  }

  return _.reduce(config, (result, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.key !== 'string' || typeof value.value !== 'string') {
      throw new Error('Invalid search engine config payload')
    }
    _.set(result, `${value.key}`, _.get(JSON.parse(value.value), 'v', null))
    return result
  }, {})
}

const validateSearchEnginePayload = searchEngine => {
  return searchEngine &&
    typeof searchEngine === 'object' &&
    !Array.isArray(searchEngine) &&
    typeof searchEngine.key === 'string' &&
    typeof searchEngine.isEnabled === 'boolean' &&
    Array.isArray(searchEngine.config)
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

router.post('/engines', async (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const engines = req.body && req.body.engines
  if (!Array.isArray(engines) || engines.some(engine => !validateSearchEnginePayload(engine))) {
    res.status(400).json({ error: 'Invalid search engines payload' })
    return
  }

  try {
    let newActiveEngine = ''
    for (const searchEngine of engines) {
      if (searchEngine.isEnabled) {
        newActiveEngine = searchEngine.key
      }
      await WIKI.models.searchEngines.query().patch({
        isEnabled: searchEngine.isEnabled,
        config: buildSearchEngineConfig(searchEngine.config)
      }).where('key', searchEngine.key)
    }

    if (newActiveEngine !== WIKI.data.searchEngine.key) {
      try {
        await WIKI.data.searchEngine.deactivate()
      } catch (err) {
        WIKI.logger.warn('Failed to deactivate previous search engine:', err)
      }
    }
    await WIKI.models.searchEngines.initEngine({ activate: true })

    res.json({ message: 'Search Engines updated successfully' })
  } catch (err) {
    if (err instanceof SyntaxError || err.message === 'Invalid search engine config payload') {
      res.status(400).json({ error: 'Invalid search engines payload' })
      return
    }
    res.status(500).json({ error: err.message || 'Search Engines update failed' })
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
