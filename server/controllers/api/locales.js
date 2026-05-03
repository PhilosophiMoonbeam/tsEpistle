const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'manage:system is required' })
    return false
  }

  return true
}

const validateLocaleConfigPayload = body => {
  return body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    typeof body.locale === 'string' &&
    body.locale.length > 0 &&
    typeof body.autoUpdate === 'boolean' &&
    typeof body.namespacing === 'boolean' &&
    Array.isArray(body.namespaces) &&
    body.namespaces.every(ns => typeof ns === 'string' && ns.length > 0)
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

router.post('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  if (!validateLocaleConfigPayload(req.body)) {
    return res.status(400).json({ error: 'Invalid locale config payload' })
  }

  try {
    WIKI.config.lang.code = req.body.locale
    WIKI.config.lang.autoUpdate = req.body.autoUpdate
    WIKI.config.lang.namespacing = req.body.namespacing
    WIKI.config.lang.namespaces = _.union(req.body.namespaces, [req.body.locale])

    const newLocale = await WIKI.models.locales.query().select('isRTL').where('code', req.body.locale).first()
    WIKI.config.lang.rtl = newLocale.isRTL

    await WIKI.configSvc.saveToDb(['lang'])
    await WIKI.lang.setCurrentLocale(req.body.locale)
    await WIKI.lang.refreshNamespaces()
    await WIKI.cache.del('nav:locales')

    return res.json({ message: 'Locale config updated' })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Locale config update failed' })
  }
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
