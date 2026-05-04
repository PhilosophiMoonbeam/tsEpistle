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

module.exports = router
