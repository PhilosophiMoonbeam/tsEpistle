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

module.exports = router
