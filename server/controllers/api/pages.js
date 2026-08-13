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

const parsePositiveIntegerParam = (req, res, name = 'id') => {
  const id = parsePositiveIntegerQuery(_.get(req, `params.${name}`))
  if (id === null) {
    res.status(400).json({ error: `${name} must be a positive integer` })
  }
  return id
}

const sendOperationError = (res, err, fallback) => {
  res.status(err.status || 500).json({ error: err.message || fallback })
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

router.get('/tags/search', async (req, res, next) => {
  const query = _.get(req, 'query.query')
  if (!_.isString(query) || query.length < 1) return res.status(400).json({ error: 'query must be a non-empty string' })
  try {
    res.json(await pageOperations.searchTags({ requester: req.user, query }))
  } catch (err) {
    next(err)
  }
})

router.get('/search', async (req, res, next) => {
  const query = _.get(req, 'query.query')
  if (!_.isString(query) || query.length < 1) {
    return res.status(400).json({ error: 'query must be a non-empty string' })
  }
  try {
    res.json(await pageOperations.search({
      requester: req.user,
      query,
      locale: _.isString(_.get(req, 'query.locale')) ? _.get(req, 'query.locale') : undefined,
      path: _.isString(_.get(req, 'query.path')) ? _.get(req, 'query.path') : undefined
    }))
  } catch (err) {
    next(err)
  }
})

router.get('/tree', async (req, res, next) => {
  const locale = _.get(req, 'query.locale')
  const mode = _.get(req, 'query.mode', 'ALL')
  const parentValue = _.get(req, 'query.parent')
  const parent = parentValue === undefined || parentValue === '' ? undefined : Number(parentValue)
  if (!_.isString(locale) || locale.length < 1) return res.status(400).json({ error: 'locale must be a non-empty string' })
  if (!['ALL', 'FOLDERS', 'PAGES'].includes(mode)) return res.status(400).json({ error: 'mode must be ALL, FOLDERS, or PAGES' })
  if (parent !== undefined && (!Number.isSafeInteger(parent) || parent < 0)) return res.status(400).json({ error: 'parent must be a non-negative integer' })
  try {
    res.json(await pageOperations.getTree({
      requester: req.user,
      locale,
      path: _.isString(_.get(req, 'query.path')) ? _.get(req, 'query.path') : undefined,
      parent,
      mode,
      includeAncestors: _.get(req, 'query.includeAncestors') === 'true'
    }))
  } catch (err) {
    next(err)
  }
})

router.post('/', async (req, res) => {
  try {
    const page = await pageOperations.create({ requester: req.user, input: req.body || {} })
    res.status(201).json({ page })
  } catch (err) {
    sendOperationError(res, err, 'Page creation failed')
  }
})

router.put('/:id', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    const page = await pageOperations.update({ requester: req.user, input: { ...(req.body || {}), id } })
    res.json({ page })
  } catch (err) {
    sendOperationError(res, err, 'Page update failed')
  }
})

router.post('/:id/convert', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    await pageOperations.convert({ requester: req.user, input: { id, editor: _.get(req, 'body.editor') } })
    res.json({ message: 'Page has been converted.' })
  } catch (err) {
    sendOperationError(res, err, 'Page conversion failed')
  }
})

router.post('/:id/move', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    await pageOperations.move({
      requester: req.user,
      input: {
        id,
        destinationLocale: _.get(req, 'body.destinationLocale'),
        destinationPath: _.get(req, 'body.destinationPath')
      }
    })
    res.json({ message: 'Page has been moved.' })
  } catch (err) {
    sendOperationError(res, err, 'Page move failed')
  }
})

router.post('/:id/conflicts/check', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const checkoutDate = new Date(_.get(req, 'body.checkoutDate'))
  if (Number.isNaN(checkoutDate.valueOf())) return res.status(400).json({ error: 'checkoutDate must be a valid date' })
  try {
    res.json({ conflict: await pageOperations.checkConflict({ requester: req.user, id, checkoutDate }) })
  } catch (err) {
    sendOperationError(res, err, 'Page conflict check failed')
  }
})

router.get('/:id/conflict-latest', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    res.json(await pageOperations.getConflictLatest({ requester: req.user, id }))
  } catch (err) {
    sendOperationError(res, err, 'Latest page version fetch failed')
  }
})

router.get('/:id/history', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const offsetPage = Number(_.get(req, 'query.offsetPage', 0))
  const offsetSize = Number(_.get(req, 'query.offsetSize', 100))
  if (!Number.isSafeInteger(offsetPage) || offsetPage < 0 || !Number.isSafeInteger(offsetSize) || offsetSize < 1) {
    return res.status(400).json({ error: 'history offsets are invalid' })
  }
  try {
    res.json(await pageOperations.getHistory({ requester: req.user, id, offsetPage, offsetSize }))
  } catch (err) {
    sendOperationError(res, err, 'Page history fetch failed')
  }
})

router.get('/:id/history/:versionId', async (req, res) => {
  const pageId = parsePositiveIntegerParam(req, res)
  if (pageId === null) return
  const versionId = parsePositiveIntegerParam(req, res, 'versionId')
  if (versionId === null) return
  try {
    res.json(await pageOperations.getVersion({ requester: req.user, pageId, versionId }))
  } catch (err) {
    sendOperationError(res, err, 'Page version fetch failed')
  }
})

router.post('/:id/history/:versionId/restore', async (req, res) => {
  const pageId = parsePositiveIntegerParam(req, res)
  if (pageId === null) return
  const versionId = parsePositiveIntegerParam(req, res, 'versionId')
  if (versionId === null) return
  try {
    await pageOperations.restore({ requester: req.user, pageId, versionId })
    res.json({ message: 'Page version restored successfully.' })
  } catch (err) {
    sendOperationError(res, err, 'Page restore failed')
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
