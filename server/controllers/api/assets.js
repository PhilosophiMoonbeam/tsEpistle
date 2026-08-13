const express = require('express')
const assetOperations = require('../../operations/assets')

const router = express.Router()

/* global WIKI */

const requireAccess = (req, res, permissions) => {
  if (!WIKI.auth.checkAccess(req.user, permissions)) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }
  return true
}

const positiveInteger = (value, res, name) => {
  if (!/^[1-9]\d*$/.test(String(value))) {
    res.status(400).json({ error: `${name} must be a positive integer` })
    return null
  }
  return Number(value)
}

const nonNegativeInteger = (value, res, name) => {
  if (!/^\d+$/.test(String(value))) {
    res.status(400).json({ error: `${name} must be a non-negative integer` })
    return null
  }
  return Number(value)
}

router.get('/', async (req, res, next) => {
  if (!requireAccess(req, res, ['manage:system', 'read:assets'])) return
  const folderId = nonNegativeInteger(req.query.folderId || 0, res, 'folderId')
  if (folderId === null) return
  const kind = req.query.kind || 'ALL'
  if (!['ALL', 'IMAGE', 'BINARY'].includes(kind)) return res.status(400).json({ error: 'kind must be ALL, IMAGE, or BINARY' })
  try {
    res.json(await assetOperations.list({ requester: req.user, folderId, kind }))
  } catch (err) {
    next(err)
  }
})

router.get('/folders', async (req, res, next) => {
  if (!requireAccess(req, res, ['manage:system', 'read:assets'])) return
  const parentFolderId = nonNegativeInteger(req.query.parentFolderId || 0, res, 'parentFolderId')
  if (parentFolderId === null) return
  try {
    res.json(await assetOperations.listFolders({ requester: req.user, parentFolderId }))
  } catch (err) {
    next(err)
  }
})

router.post('/folders', async (req, res, next) => {
  if (!requireAccess(req, res, ['manage:system', 'write:assets'])) return
  const parentFolderId = nonNegativeInteger(req.body && req.body.parentFolderId, res, 'parentFolderId')
  if (parentFolderId === null) return
  if (!req.body || typeof req.body.slug !== 'string' || req.body.slug.length < 1) return res.status(400).json({ error: 'slug must be a non-empty string' })
  try {
    await assetOperations.createFolder({ parentFolderId, slug: req.body.slug })
    res.status(201).json({ message: 'Asset folder created successfully.' })
  } catch (err) {
    next(err)
  }
})

router.patch('/:id', async (req, res, next) => {
  if (!requireAccess(req, res, ['manage:system', 'manage:assets'])) return
  const id = positiveInteger(req.params.id, res, 'id')
  if (id === null) return
  if (!req.body || typeof req.body.filename !== 'string' || req.body.filename.length < 1) return res.status(400).json({ error: 'filename must be a non-empty string' })
  try {
    await assetOperations.rename({ requester: req.user, id, filename: req.body.filename })
    res.json({ message: 'Asset renamed successfully.' })
  } catch (err) {
    next(err)
  }
})

router.delete('/:id', async (req, res, next) => {
  if (!requireAccess(req, res, ['manage:system', 'manage:assets'])) return
  const id = positiveInteger(req.params.id, res, 'id')
  if (id === null) return
  try {
    await assetOperations.remove({ requester: req.user, id })
    res.json({ message: 'Asset deleted successfully.' })
  } catch (err) {
    next(err)
  }
})

module.exports = router
