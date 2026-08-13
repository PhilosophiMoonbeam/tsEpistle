const express = require('express')
const _ = require('lodash')
const pageOperations = require('../../operations/pages')

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

const requireTagsAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system', 'read:pages'])) {
    res.status(403).json({ error: 'manage:system or read:pages is required' })
    return false
  }

  return true
}

const requirePageLinksAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system', 'read:pages'])) {
    res.status(403).json({ error: 'manage:system or read:pages is required' })
    return false
  }

  return true
}

const requirePageListAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system', 'read:pages'])) {
    res.status(403).json({ error: 'manage:system or read:pages is required' })
    return false
  }

  return true
}

const parsePositiveIntegerQuery = value => {
  if (_.isArray(value)) {
    value = value[0]
  }
  if (_.isString(value) && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

const parseTagsQuery = value => {
  if (_.isArray(value)) {
    return value.flatMap(tag => parseTagsQuery(tag))
  }
  if (_.isString(value)) {
    return value.split(',').map(tag => _.trim(tag).toLowerCase()).filter(tag => tag.length > 0)
  }
  return []
}

router.get('/', async (req, res, next) => {
  if (!requirePageListAccess(req, res)) {
    return
  }

  const limit = parsePositiveIntegerQuery(_.get(req, 'query.limit'))
  const creatorId = parsePositiveIntegerQuery(_.get(req, 'query.creatorId'))
  const authorId = parsePositiveIntegerQuery(_.get(req, 'query.authorId'))
  const locale = _.get(req, 'query.locale')
  const tags = parseTagsQuery(_.get(req, 'query.tags'))
  const orderBy = _.get(req, 'query.orderBy')
  const orderByDirection = _.get(req, 'query.orderByDirection')

  try {
    const pages = await pageOperations.list({
      requester: req.user,
      limit,
      creatorId,
      authorId,
      locale: _.isString(locale) && locale.length > 0 ? locale : undefined,
      tags,
      orderBy,
      orderByDirection
    })

    return res.json(pages.map(page => ({
      id: page.id,
      path: page.path,
      locale: page.locale,
      title: page.title === undefined ? null : page.title,
      description: page.description === undefined ? null : page.description,
      isPublished: page.isPublished,
      isPrivate: page.isPrivate,
      privateNS: page.privateNS === undefined ? null : page.privateNS,
      contentType: page.contentType,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      tags: page.tags
    })))
  } catch (err) {
    return next(err)
  }
})

router.get('/tags', async (req, res, next) => {
  if (!requireTagsAccess(req, res)) {
    return
  }

  try {
    const tags = await pageOperations.listTags(req.user)

    return res.json(tags.map(tag => ({
      id: tag.id,
      tag: tag.tag,
      title: tag.title,
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt
    })))
  } catch (err) {
    return next(err)
  }
})

router.get('/recent', async (req, res, next) => {
  if (!requireRecentPagesAccess(req, res)) {
    return
  }

  try {
    return res.json(await pageOperations.listRecent(req.user))
  } catch (err) {
    return next(err)
  }
})

router.get('/links', async (req, res, next) => {
  if (!requirePageLinksAccess(req, res)) {
    return
  }

  const locale = _.get(req, 'query.locale')
  if (!_.isString(locale) || locale.length < 1) {
    return res.status(400).json({ error: 'locale must be a non-empty string' })
  }

  try {
    return res.json(await pageOperations.listLinks({ requester: req.user, locale }))
  } catch (err) {
    return next(err)
  }
})

router.get('/:id', async (req, res, next) => {
  const rawId = _.get(req, 'params.id')
  if (!_.isString(rawId) || !/^[1-9]\d*$/.test(rawId)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  const id = Number(rawId)
  if (!Number.isSafeInteger(id)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  if (!WIKI.auth.checkAccess(req.user, ['read:pages', 'manage:system'])) {
    return res.status(403).json({ error: 'read:pages or manage:system is required' })
  }

  try {
    const page = await pageOperations.get({ requester: req.user, id })
    if (!WIKI.auth.checkAccess(req.user, ['write:pages', 'manage:system'])) {
      return res.status(403).json({ error: 'write:pages or manage:system is required' })
    }
    return res.json({
      id: page.id,
      path: page.path,
      hash: page.hash,
      title: page.title,
      description: page.description,
      isPrivate: page.isPrivate,
      isPublished: page.isPublished,
      privateNS: page.privateNS,
      publishStartDate: page.publishStartDate,
      publishEndDate: page.publishEndDate,
      contentType: page.contentType,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      editor: page.editor,
      locale: page.locale,
      authorId: page.authorId,
      authorName: page.authorName,
      authorEmail: page.authorEmail,
      creatorId: page.creatorId,
      creatorName: page.creatorName,
      creatorEmail: page.creatorEmail
    })
  } catch (err) {
    if (Number.isInteger(err.status)) return res.status(err.status).json({ error: err.message })
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
    await pageOperations.remove({ requester: req.user, id })
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
    await pageOperations.updateTag({ id, tag, title })
    res.json({ message: 'Tag has been updated successfully.' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Tag update failed' })
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
    await pageOperations.removeTag(id)
    res.json({ message: 'Tag has been deleted.' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Tag delete failed' })
  }
})

module.exports = router
