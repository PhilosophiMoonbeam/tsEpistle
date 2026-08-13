const express = require('express')

const renderingOperations = require('../../operations/rendering')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res, json = false) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    if (json) res.status(403).json({ error: 'Forbidden' })
    else res.sendStatus(403)
    return false
  }
  return true
}

router.get('/renderers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const renderers = await renderingOperations.listRenderers()
    res.json(renderers.map(renderer => ({
      isEnabled: renderer.isEnabled,
      key: renderer.key,
      title: renderer.title,
      description: typeof renderer.description === 'undefined' ? null : renderer.description,
      icon: typeof renderer.icon === 'undefined' ? null : renderer.icon,
      dependsOn: typeof renderer.dependsOn === 'undefined' ? null : renderer.dependsOn,
      input: typeof renderer.input === 'undefined' ? null : renderer.input,
      output: typeof renderer.output === 'undefined' ? null : renderer.output,
      config: renderer.config
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/renderers', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    await renderingOperations.updateRenderers(req.body && req.body.renderers)
    res.json({ message: 'Renderers updated successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Renderers update failed' })
  }
})

module.exports = router
