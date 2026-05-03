const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }

  return true
}

const requireNonEmptyString = (value, label) => {
  if (!_.isString(value) || _.trim(value).length < 1) {
    throw new Error(`${label} is required.`)
  }
}

const requireTargetPayload = (targets) => {
  if (!Array.isArray(targets)) {
    throw new Error('targets must be an array.')
  }

  for (const tgt of targets) {
    requireNonEmptyString(_.get(tgt, 'key', ''), 'target key')
    if (!_.isBoolean(tgt.isEnabled)) {
      throw new Error('target isEnabled must be a boolean.')
    }
    requireNonEmptyString(_.get(tgt, 'mode', ''), 'target mode')
    if (!Array.isArray(tgt.config)) {
      throw new Error('target config must be an array.')
    }
  }
}

const transformStorageTargets = async () => {
  let targets = await WIKI.models.storage.getTargets()
  targets = _.sortBy(targets.map(tgt => {
    const targetInfo = _.find(WIKI.data.storage, ['key', tgt.key]) || {}
    return {
      ...targetInfo,
      ...tgt,
      hasSchedule: (targetInfo.schedule !== false),
      syncInterval: tgt.syncInterval || targetInfo.schedule || 'P0D',
      syncIntervalDefault: targetInfo.schedule,
      config: _.sortBy(_.transform(tgt.config, (res, value, key) => {
        const configData = _.get(targetInfo.props, key, false)
        if (configData) {
          res.push({
            key,
            value: JSON.stringify({
              ...configData,
              value: (configData.sensitive && value.length > 0) ? '********' : value
            })
          })
        }
      }, []), 'key')
    }
  }), ['title', 'key'])
  return targets
}

const transformStorageStatus = async () => {
  const activeTargets = await WIKI.models.storage.query().where('isEnabled', true)
  return activeTargets.map(tgt => {
    const targetInfo = _.find(WIKI.data.storage, ['key', tgt.key]) || {}
    return {
      key: tgt.key,
      title: targetInfo.title,
      status: _.get(tgt, 'state.status', 'pending'),
      message: _.get(tgt, 'state.message', 'Initializing...'),
      lastAttempt: _.get(tgt, 'state.lastAttempt', null)
    }
  })
}

const updateStorageTargets = async (targets) => {
  const dbTargets = await WIKI.models.storage.getTargets()
  for (let tgt of targets) {
    const currentDbTarget = _.find(dbTargets, ['key', tgt.key])
    if (!currentDbTarget) {
      continue
    }
    await WIKI.models.storage.query().patch({
      isEnabled: tgt.isEnabled,
      mode: tgt.mode,
      syncInterval: tgt.syncInterval,
      config: _.reduce(tgt.config, (result, value, key) => {
        let configValue = _.get(JSON.parse(value.value), 'v', null)
        if (configValue === '********') {
          configValue = _.get(currentDbTarget.config, value.key, '')
        }
        _.set(result, `${value.key}`, configValue)
        return result
      }, {}),
      state: {
        status: 'pending',
        message: 'Initializing...',
        lastAttempt: null
      }
    }).where('key', tgt.key)
  }
  await WIKI.models.storage.initTargets()
}

router.get('/targets', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    res.json(await transformStorageTargets())
  } catch (err) {
    res.status(500).json({ error: err.message || 'Storage targets failed' })
  }
})

router.get('/status', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    res.json(await transformStorageStatus())
  } catch (err) {
    res.status(500).json({ error: err.message || 'Storage status failed' })
  }
})

router.put('/targets', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    const targets = _.get(req, 'body.targets', null)
    requireTargetPayload(targets)
    await updateStorageTargets(targets)
    res.json({ message: 'Storage targets updated successfully' })
  } catch (err) {
    const status = /( is required\.| must be )/.test(err.message) ? 400 : 500
    res.status(status).json({ error: err.message || 'Storage targets update failed' })
  }
})

router.post('/actions/execute', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    const targetKey = _.get(req, 'body.targetKey', '')
    const handler = _.get(req, 'body.handler', '')

    requireNonEmptyString(targetKey, 'targetKey')
    requireNonEmptyString(handler, 'handler')

    await WIKI.models.storage.executeAction(targetKey, handler)
    res.json({ message: 'Action completed.' })
  } catch (err) {
    const status = /is required\.$/.test(err.message) ? 400 : 500
    res.status(status).json({ error: err.message || 'Storage action failed' })
  }
})

module.exports = router
