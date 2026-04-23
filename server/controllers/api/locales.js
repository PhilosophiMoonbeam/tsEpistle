const express = require('express')

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
    let remoteLocales = await WIKI.cache.get('locales')
    const localLocales = await WIKI.models.locales.query().select('code', 'isRTL', 'name', 'nativeName', 'createdAt', 'updatedAt', 'availability')
    remoteLocales = remoteLocales || localLocales

    res.json(remoteLocales.map(rl => {
      const installedLocale = localLocales.find(ll => ll.code === rl.code)
      return {
        ...rl,
        isInstalled: Boolean(installedLocale),
        installDate: installedLocale ? installedLocale.updatedAt : null
      }
    }))
  } catch (err) {
    next(err)
  }
})

router.get('/config', (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  return res.json({
    locale: WIKI.config.lang.code,
    autoUpdate: WIKI.config.lang.autoUpdate,
    namespacing: WIKI.config.lang.namespacing,
    namespaces: WIKI.config.lang.namespaces
  })
})

router.get('/:code/strings', async (req, res) => {
  const namespace = req.query.namespace
  if (!namespace) {
    return res.status(400).json({ error: 'namespace query parameter is required' })
  }

  try {
    const strings = await WIKI.lang.getByNamespace(req.params.code, namespace)
    return res.json(strings)
  } catch (err) {
    return res.status(404).json({ error: err.message })
  }
})

module.exports = router
