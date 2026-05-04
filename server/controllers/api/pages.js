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

const requirePageDeleteAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['delete:pages', 'manage:system'])) {
    res.status(403).json({ error: 'delete:pages or manage:system is required' })
    return false
  }

  return true
}

const requireRecentPagesAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system', 'read:pages'])) {
    res.status(403).json({ error: 'manage:system or read:pages is required' })
    return false
  }

  return true
}

router.get('/recent', async (req, res, next) => {
  if (!requireRecentPagesAccess(req, res)) {
    return
  }

  try {
    const pages = await WIKI.models.pages.query()
      .column(['pages.id', 'path', { locale: 'localeCode' }, 'title', 'updatedAt'])
      .withGraphJoined('tags')
      .modifyGraph('tags', builder => {
        builder.select('tag')
      })
      .orderBy('updatedAt', 'desc')
      .limit(10)

    return res.json(pages.filter(page => WIKI.auth.checkAccess(req.user, ['read:pages'], {
      path: page.path,
      locale: page.locale,
      tags: page.tags
    })).map(page => ({
      id: page.id,
      locale: page.locale,
      path: page.path,
      title: page.title,
      updatedAt: page.updatedAt
    })))
  } catch (err) {
    return next(err)
  }
})

router.delete('/:id', async (req, res) => {
  if (!requirePageDeleteAccess(req, res)) {
    return
  }

  const rawId = _.get(req, 'params.id')
  if (!_.isString(rawId) || !/^[1-9]\d*$/.test(rawId)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  const id = Number(rawId)
  if (!Number.isSafeInteger(id)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  try {
    await WIKI.models.pages.deletePage({
      id,
      user: req.user
    })
    res.json({ message: 'Page has been deleted.' })
  } catch (err) {
    if (err.name === 'PageNotFound') {
      return res.status(404).json({ error: err.message || 'This page does not exist.' })
    }
    if (err.name === 'PageDeleteForbidden') {
      return res.status(403).json({ error: err.message || 'You are not authorized to delete this page.' })
    }
    res.status(500).json({ error: err.message || 'Page delete failed' })
  }
})

router.patch('/tags/:id', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  const rawId = _.get(req, 'params.id')
  if (!_.isString(rawId) || !/^[1-9]\d*$/.test(rawId)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  const id = Number(rawId)
  if (!Number.isSafeInteger(id)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  const tag = _.get(req, 'body.tag')
  const title = _.get(req, 'body.title')
  if (!_.isString(tag)) {
    return res.status(400).json({ error: 'tag must be a string' })
  }
  if (!_.isString(title)) {
    return res.status(400).json({ error: 'title must be a string' })
  }

  try {
    const affectedRows = await WIKI.models.tags.query()
      .findById(id)
      .patch({
        tag: _.trim(tag).toLowerCase(),
        title: _.trim(title)
      })
    if (affectedRows < 1) {
      return res.status(404).json({ error: 'This tag does not exist.' })
    }
    res.json({ message: 'Tag has been updated successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Tag update failed' })
  }
})

router.delete('/tags/:id', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  const rawId = _.get(req, 'params.id')
  if (!_.isString(rawId) || !/^[1-9]\d*$/.test(rawId)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  const id = Number(rawId)
  if (!Number.isSafeInteger(id)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  try {
    const tagToDel = await WIKI.models.tags.query().findById(id)
    if (!tagToDel) {
      return res.status(404).json({ error: 'This tag does not exist.' })
    }

    await tagToDel.$relatedQuery('pages').unrelate()
    await WIKI.models.tags.query().deleteById(id)
    res.json({ message: 'Tag has been deleted.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Tag delete failed' })
  }
})

module.exports = router
