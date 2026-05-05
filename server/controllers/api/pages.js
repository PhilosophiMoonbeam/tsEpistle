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

const requireTagsAccess = (req, res) => {
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
    let pages = await WIKI.models.pages.query()
      .column([
        'pages.id',
        'path',
        { locale: 'localeCode' },
        'title',
        'description',
        'isPublished',
        'isPrivate',
        'privateNS',
        'contentType',
        'createdAt',
        'updatedAt'
      ])
      .withGraphJoined('tags')
      .modifyGraph('tags', builder => {
        builder.select('tag')
      })
      .modify(queryBuilder => {
        if (limit) {
          queryBuilder.limit(limit)
        }
        if (_.isString(locale) && locale.length > 0) {
          queryBuilder.where('localeCode', locale)
        }
        if (creatorId && authorId) {
          queryBuilder.where(function () {
            this.where('creatorId', creatorId).orWhere('authorId', authorId)
          })
        } else {
          if (creatorId) {
            queryBuilder.where('creatorId', creatorId)
          }
          if (authorId) {
            queryBuilder.where('authorId', authorId)
          }
        }
        if (tags.length > 0) {
          queryBuilder.whereIn('tags.tag', tags)
        }
        const orderDir = orderByDirection === 'DESC' ? 'desc' : 'asc'
        switch (orderBy) {
          case 'CREATED':
            queryBuilder.orderBy('createdAt', orderDir)
            break
          case 'PATH':
            queryBuilder.orderBy('path', orderDir)
            break
          case 'TITLE':
            queryBuilder.orderBy('title', orderDir)
            break
          case 'UPDATED':
            queryBuilder.orderBy('updatedAt', orderDir)
            break
          default:
            queryBuilder.orderBy('pages.id', orderDir)
            break
        }
      })

    pages = pages.filter(page => WIKI.auth.checkAccess(req.user, ['read:pages'], {
      path: page.path,
      locale: page.locale
    })).map(page => ({
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
      tags: _.map(page.tags, 'tag')
    }))

    if (tags.length > 0) {
      pages = pages.filter(page => _.every(tags, tag => _.includes(page.tags, tag)))
    }

    return res.json(pages)
  } catch (err) {
    return next(err)
  }
})

router.get('/tags', async (req, res, next) => {
  if (!requireTagsAccess(req, res)) {
    return
  }

  try {
    const pages = await WIKI.models.pages.query()
      .column([
        'path',
        { locale: 'localeCode' }
      ])
      .withGraphJoined('tags')

    const tags = _.orderBy(_.uniqBy(pages.filter(page => WIKI.auth.checkAccess(req.user, ['read:pages'], {
      path: page.path,
      locale: page.locale
    })).flatMap(page => page.tags), 'id'), ['tag'], ['asc'])

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
    const page = await WIKI.models.pages.getPageFromDb(id)
    if (!page) {
      return res.status(404).json({ error: 'This page does not exist.' })
    }
    if (!WIKI.auth.checkAccess(req.user, ['manage:pages', 'delete:pages'], {
      path: page.path,
      locale: page.localeCode
    })) {
      return res.status(403).json({ error: 'You are not authorized to view this page.' })
    }
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
      editor: page.editorKey,
      locale: page.localeCode,
      authorId: page.authorId,
      authorName: page.authorName,
      authorEmail: page.authorEmail,
      creatorId: page.creatorId,
      creatorName: page.creatorName,
      creatorEmail: page.creatorEmail
    })
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
