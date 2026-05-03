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

const buildRendererConfig = config => {
  if (!Array.isArray(config)) {
    throw new Error('Invalid renderer config payload')
  }

  return _.reduce(config, (result, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.key !== 'string' || typeof value.value !== 'string') {
      throw new Error('Invalid renderer config payload')
    }
    _.set(result, `${value.key}`, _.get(JSON.parse(value.value), 'v', null))
    return result
  }, {})
}

const validateRendererPayload = renderer => {
  return renderer &&
    typeof renderer === 'object' &&
    !Array.isArray(renderer) &&
    typeof renderer.key === 'string' &&
    typeof renderer.isEnabled === 'boolean' &&
    Array.isArray(renderer.config)
}

const serializeRenderer = renderer => {
  const rendererInfo = _.find(WIKI.data.renderers, ['key', renderer.key]) || {}
  const mergedRenderer = {
    ...rendererInfo,
    ...renderer
  }
  const config = _.sortBy(_.transform(renderer.config, (res, value, key) => {
    const configData = _.get(rendererInfo.props, key, false)
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
    isEnabled: mergedRenderer.isEnabled,
    key: mergedRenderer.key,
    title: mergedRenderer.title,
    description: typeof mergedRenderer.description === 'undefined' ? null : mergedRenderer.description,
    icon: typeof mergedRenderer.icon === 'undefined' ? null : mergedRenderer.icon,
    dependsOn: typeof mergedRenderer.dependsOn === 'undefined' ? null : mergedRenderer.dependsOn,
    input: typeof mergedRenderer.input === 'undefined' ? null : mergedRenderer.input,
    output: typeof mergedRenderer.output === 'undefined' ? null : mergedRenderer.output,
    config
  }
}

router.get('/renderers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    const renderers = await WIKI.models.renderers.getRenderers()
    res.json(renderers.map(serializeRenderer))
  } catch (err) {
    next(err)
  }
})

router.post('/renderers', async (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const renderers = req.body && req.body.renderers
  if (!Array.isArray(renderers) || renderers.some(renderer => !validateRendererPayload(renderer))) {
    res.status(400).json({ error: 'Invalid renderers payload' })
    return
  }

  try {
    for (const renderer of renderers) {
      await WIKI.models.renderers.query().patch({
        isEnabled: renderer.isEnabled,
        config: buildRendererConfig(renderer.config)
      }).where('key', renderer.key)
    }

    res.json({ message: 'Renderers updated successfully' })
  } catch (err) {
    if (err instanceof SyntaxError || err.message === 'Invalid renderer config payload') {
      res.status(400).json({ error: 'Invalid renderers payload' })
      return
    }
    res.status(500).json({ error: err.message || 'Renderers update failed' })
  }
})

module.exports = router
