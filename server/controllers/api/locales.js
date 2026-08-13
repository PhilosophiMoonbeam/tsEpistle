const express = require('express')
const localizationOperations = require('../../operations/localization')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'manage:system is required' })
    return false
  }

  return true
}

router.get('/', async (req, res, next) => {
  try {
    res.json(await localizationOperations.listLocales())
  } catch (err) {
    next(err)
  }
})

router.get('/config', (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  return res.json(localizationOperations.getConfig())
})

router.post('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await localizationOperations.updateConfig(req.body)
    return res.json({ message: 'Locale config updated' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Locale config update failed' })
  }
})

router.post('/:code/download', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await localizationOperations.download(req.params && req.params.code)
    return res.json({ message: 'Locale downloaded successfully' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Locale download failed' })
  }
})

router.get('/:code/strings', async (req, res) => {
  const namespace = req.query.namespace
  if (!namespace) {
    return res.status(400).json({ error: 'namespace query parameter is required' })
  }

  try {
    return res.json(await localizationOperations.getTranslations({
      locale: req.params.code,
      namespace
    }))
  } catch (err) {
    return res.status(404).json({ error: err.message })
  }
})

module.exports = router
