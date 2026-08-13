const express = require('express')

const commentOperations = require('../../operations/comments')

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

const parsePositiveInteger = value => {
  if (!/^[1-9]\d*$/.test(String(value || ''))) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

router.get('/providers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const providers = await commentOperations.listProviders()
    res.json(providers.map(provider => ({
      isEnabled: provider.isEnabled,
      key: provider.key,
      title: provider.title,
      description: provider.description,
      logo: provider.logo,
      website: provider.website,
      isAvailable: provider.isAvailable,
      config: provider.config
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/providers', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    await commentOperations.updateProviders(req.body && req.body.providers)
    res.json({ message: 'Comment Providers updated successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Comment providers update failed' })
  }
})

router.get('/', async (req, res, next) => {
  const locale = req.query && req.query.locale
  const path = req.query && req.query.path
  if (typeof locale !== 'string' || locale.length < 1 || typeof path !== 'string' || path.length < 1) {
    return res.status(400).json({ error: 'locale and path query parameters are required' })
  }
  try {
    res.json(await commentOperations.list({ requester: req.user, locale, path }))
  } catch (err) {
    next(err)
  }
})

router.post('/', async (req, res) => {
  try {
    const id = await commentOperations.create({
      requester: req.user,
      ip: req.ip,
      input: req.body || {}
    })
    res.status(201).json({ id })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Comment creation failed' })
  }
})

router.get('/:id', async (req, res, next) => {
  const id = parsePositiveInteger(req.params && req.params.id)
  if (id === null) return res.status(400).json({ error: 'comment id must be a positive integer' })
  try {
    res.json(await commentOperations.get({ requester: req.user, id }))
  } catch (err) {
    next(err)
  }
})

router.patch('/:id', async (req, res) => {
  const id = parsePositiveInteger(req.params && req.params.id)
  if (id === null) return res.status(400).json({ error: 'comment id must be a positive integer' })
  try {
    const render = await commentOperations.update({
      requester: req.user,
      ip: req.ip,
      input: { id, content: req.body && req.body.content }
    })
    res.json({ render })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Comment update failed' })
  }
})

router.delete('/:id', async (req, res) => {
  const id = parsePositiveInteger(req.params && req.params.id)
  if (id === null) return res.status(400).json({ error: 'comment id must be a positive integer' })
  try {
    await commentOperations.remove({ requester: req.user, ip: req.ip, id })
    res.json({ message: 'Comment deleted successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Comment deletion failed' })
  }
})

module.exports = router
