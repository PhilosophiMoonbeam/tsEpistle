import express from 'express'
import { type Request, type Response, getWikiAuth } from '../_types.ts'
import _ from 'lodash'
import pageOperations from '../../operations/pages.ts'
import { principalId, type PageVisibility } from '../../helpers/page-access.ts'

const router = express.Router()


type TreeMode = 'ALL' | 'FOLDERS' | 'PAGES'

interface PageListItem {
  id: number
  path: string
  locale?: string
  title?: string | null
  description?: string | null
  isPublished: boolean | number
  visibility: PageVisibility
  ownerId: number | null
  contentType: string
  createdAt: string | Date
  updatedAt: string | Date
  tags: string[]
}

interface PageOperationListItem extends Record<string, unknown> {
  id: number
  path: string
  locale?: string
  title: string
  updatedAt: Date
  tags: string[]
}

const isDateValue = (value: unknown): value is string | Date =>
  typeof value === 'string' || value instanceof Date

const isPageListItem = (page: PageOperationListItem): page is PageOperationListItem & PageListItem =>
  typeof page.id === 'number' &&
  typeof page.path === 'string' &&
  (page.locale === undefined || typeof page.locale === 'string') &&
  (page.title === undefined || page.title === null || typeof page.title === 'string') &&
  (page.description === undefined || page.description === null || typeof page.description === 'string') &&
  (typeof page.isPublished === 'boolean' || typeof page.isPublished === 'number') &&
  (page.visibility === 'public' || page.visibility === 'private') &&
  (page.ownerId === null || typeof page.ownerId === 'number') &&
  typeof page.contentType === 'string' &&
  isDateValue(page.createdAt) &&
  isDateValue(page.updatedAt) &&
  Array.isArray(page.tags) &&
  page.tags.every(tag => typeof tag === 'string')




const errorMessage = (err: unknown, fallback: string): string => {
  const message = err instanceof Error ? err.message : String(err)
  return message || fallback
}

const errorStatus = (err: unknown, fallback: number): number => {
  if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number') {
    return err.status
  }
  if (err instanceof Error && err.name === 'PagePathCollision') return 409
  return fallback
}

const requestBody = (req: Request): Record<string, unknown> => {
  const body: unknown = req.body
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

const optionalStringQuery = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const parseTreeMode = (value: unknown): TreeMode | null =>
  value === 'ALL' || value === 'FOLDERS' || value === 'PAGES' ? value : null

const requesterInput = (req: Request): { requester?: Express.User } =>
  req.user === undefined ? {} : { requester: req.user }


const requireSystemAccess = (req: Request, res: Response): boolean => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'manage:system is required' })
    return false
  }
  return true
}

const requirePageDeleteAccess = (req: Request, res: Response): boolean => {
  if (principalId(req.user) === null && !getWikiAuth().checkAccess(req.user, ['delete:pages', 'manage:system'])) {
    res.status(403).json({ error: 'delete:pages or manage:system is required' })
    return false
  }

  return true
}

const requireRecentPagesAccess = (req: Request, res: Response): boolean => {
  if (principalId(req.user) === null && !getWikiAuth().checkAccess(req.user, ['manage:system', 'read:pages'])) {
    res.status(403).json({ error: 'manage:system or read:pages is required' })
    return false
  }

  return true
}

const requireTagsAccess = (req: Request, res: Response): boolean => {
  if (principalId(req.user) === null && !getWikiAuth().checkAccess(req.user, ['manage:system', 'read:pages'])) {
    res.status(403).json({ error: 'manage:system or read:pages is required' })
    return false
  }

  return true
}

const requirePageLinksAccess = (req: Request, res: Response): boolean => {
  if (principalId(req.user) === null && !getWikiAuth().checkAccess(req.user, ['manage:system', 'read:pages'])) {
    res.status(403).json({ error: 'manage:system or read:pages is required' })
    return false
  }

  return true
}

const requirePageListAccess = (req: Request, res: Response): boolean => {
  if (principalId(req.user) === null && !getWikiAuth().checkAccess(req.user, ['manage:system', 'read:pages'])) {
    res.status(403).json({ error: 'manage:system or read:pages is required' })
    return false
  }

  return true
}

const parsePositiveIntegerQuery = (value: unknown): number | null => {
  if (_.isArray(value)) {
    value = value[0]
  }
  if (_.isString(value) && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

const parseTagsQuery = (value: unknown): string[] => {
  if (_.isArray(value)) {
    return value.flatMap(tag => parseTagsQuery(tag))
  }
  if (_.isString(value)) {
    return value.split(',').map(tag => _.trim(tag).toLowerCase()).filter(tag => tag.length > 0)
  }
  return []
}

const parsePositiveIntegerParam = (req: Request, res: Response, name = 'id'): number | null => {
  const id = parsePositiveIntegerQuery(_.get(req, `params.${name}`))
  if (id === null) {
    res.status(400).json({ error: `${name} must be a positive integer` })
  }
  return id
}

const sendOperationError = (res: Response, value: unknown, fallback: string): void => {
  res.status(errorStatus(value, 500)).json({ error: errorMessage(value, fallback) })
}

router.get('/', async (req, res, next) => {
  if (!requirePageListAccess(req, res)) {
    return
  }

  const limit = parsePositiveIntegerQuery(_.get(req, 'query.limit'))
  const creatorId = parsePositiveIntegerQuery(_.get(req, 'query.creatorId'))
  const authorId = parsePositiveIntegerQuery(_.get(req, 'query.authorId'))
  const locale = optionalStringQuery(_.get(req, 'query.locale'))
  const tags = parseTagsQuery(_.get(req, 'query.tags'))
  const orderBy = optionalStringQuery(_.get(req, 'query.orderBy'))
  const orderByDirection = optionalStringQuery(_.get(req, 'query.orderByDirection'))

  try {
    const pages = await pageOperations.list({
      ...requesterInput(req),
      tags,
      ...(limit === null ? {} : { limit }),
      ...(creatorId === null ? {} : { creatorId }),
      ...(authorId === null ? {} : { authorId }),
      ...(locale === undefined ? {} : { locale }),
      ...(orderBy === undefined ? {} : { orderBy }),
      ...(orderByDirection === undefined ? {} : { orderByDirection })
    })

    return res.json(pages.map(page => {
      if (!isPageListItem(page)) {
        throw new TypeError('Page list query returned an invalid selected row')
      }
      return {
        id: page.id,
        path: page.path,
        locale: page.locale,
        title: page.title ?? null,
        description: page.description ?? null,
        isPublished: Boolean(page.isPublished),
        visibility: page.visibility,
        ownerId: page.ownerId,
        contentType: page.contentType,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
        tags: page.tags
      }
    }))
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
    return res.json(await pageOperations.listLinks({ ...requesterInput(req), locale }))
  } catch (err) {
    return next(err)
  }
})

router.get('/tags/search', async (req, res, next) => {
  const query = _.get(req, 'query.query')
  if (!_.isString(query) || query.length < 1) return res.status(400).json({ error: 'query must be a non-empty string' })
  try {
    res.json(await pageOperations.searchTags({ ...requesterInput(req), query }))
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
    const locale = optionalStringQuery(_.get(req, 'query.locale'))
    const path = optionalStringQuery(_.get(req, 'query.path'))
    res.json(await pageOperations.search({
      ...requesterInput(req),
      query,
      ...(locale === undefined ? {} : { locale }),
      ...(path === undefined ? {} : { path })
    }))
  } catch (err) {
    next(err)
  }
})

router.get('/tree', async (req, res, next) => {
  const locale = _.get(req, 'query.locale')
  const rawMode: unknown = _.get(req, 'query.mode', 'ALL')
  const mode = parseTreeMode(rawMode)
  const parentValue: unknown = _.get(req, 'query.parent')
  const parent = parentValue === undefined || parentValue === '' ? undefined : Number(parentValue)
  if (!_.isString(locale) || locale.length < 1) return res.status(400).json({ error: 'locale must be a non-empty string' })
  if (mode === null) return res.status(400).json({ error: 'mode must be ALL, FOLDERS, or PAGES' })
  if (parent !== undefined && (!Number.isSafeInteger(parent) || parent < 0)) return res.status(400).json({ error: 'parent must be a non-negative integer' })
  try {
    const path = optionalStringQuery(_.get(req, 'query.path'))
    res.json(await pageOperations.getTree({
      ...requesterInput(req),
      locale,
      mode,
      includeAncestors: _.get(req, 'query.includeAncestors') === 'true',
      ...(path === undefined ? {} : { path }),
      ...(parent === undefined ? {} : { parent })
    }))
  } catch (err) {
    next(err)
  }
})

router.post('/', async (req, res) => {
  try {
    const page = await pageOperations.create({ ...requesterInput(req), input: requestBody(req) })
    res.status(201).json({ page })
  } catch (err) {
    sendOperationError(res, err, 'Page creation failed')
  }
})

router.put('/:id', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    const page = await pageOperations.update({ ...requesterInput(req), input: { ...requestBody(req), id } })
    res.json({ page })
  } catch (err) {
    sendOperationError(res, err, 'Page update failed')
  }
})

router.patch('/:id/visibility', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const visibility = _.get(req, 'body.visibility')
  if (visibility !== 'public' && visibility !== 'private') {
    return res.status(400).json({ error: 'visibility must be public or private' })
  }
  try {
    const page = await pageOperations.changeVisibility({
      ...requesterInput(req),
      id,
      visibility,
      confirmPublication: _.get(req, 'body.confirmPublication') === true
    })
    return res.json({ page })
  } catch (err) {
    sendOperationError(res, err, 'Page visibility update failed')
  }
})

router.patch('/:id/owner', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const ownerId = _.get(req, 'body.ownerId')
  if (!Number.isSafeInteger(ownerId) || (ownerId as number) < 1) {
    return res.status(400).json({ error: 'ownerId must be a positive integer' })
  }
  try {
    const page = await pageOperations.transferOwnership({
      ...requesterInput(req),
      id,
      ownerId
    })
    return res.json({ page })
  } catch (err) {
    sendOperationError(res, err, 'Page ownership transfer failed')
  }
})

router.post('/:id/convert', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    const editor = _.get(req, 'body.editor')
    await pageOperations.convert({
      ...requesterInput(req),
      input: { id, ...(typeof editor === 'string' ? { editor } : {}) }
    })
    res.json({ message: 'Page has been converted.' })
  } catch (err) {
    sendOperationError(res, err, 'Page conversion failed')
  }
})

router.post('/:id/move', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    const destinationLocale = _.get(req, 'body.destinationLocale')
    const destinationPath = _.get(req, 'body.destinationPath')
    if (typeof destinationLocale !== 'string' || typeof destinationPath !== 'string') {
      return res.status(400).json({ error: 'destinationLocale and destinationPath must be strings' })
    }
    await pageOperations.move({
      ...requesterInput(req),
      input: { id, destinationLocale, destinationPath }
    })
    res.json({ message: 'Page has been moved.' })
  } catch (err) {
    sendOperationError(res, err, 'Page move failed')
  }
})

router.post('/:id/conflicts/check', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const checkoutDateValue = _.get(req, 'body.checkoutDate')
  if (typeof checkoutDateValue !== 'string' && typeof checkoutDateValue !== 'number') {
    return res.status(400).json({ error: 'checkoutDate must be a valid date' })
  }
  const checkoutDate = new Date(checkoutDateValue)
  if (Number.isNaN(checkoutDate.valueOf())) return res.status(400).json({ error: 'checkoutDate must be a valid date' })
  try {
    res.json({ conflict: await pageOperations.checkConflict({ ...requesterInput(req), id, checkoutDate }) })
  } catch (err) {
    sendOperationError(res, err, 'Page conflict check failed')
  }
})

router.get('/:id/conflict-latest', async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    res.json(await pageOperations.getConflictLatest({ ...requesterInput(req), id }))
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
    res.json(await pageOperations.getHistory({ ...requesterInput(req), id, offsetPage, offsetSize }))
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
    res.json(await pageOperations.getVersion({ ...requesterInput(req), pageId, versionId }))
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
    await pageOperations.restore({ ...requesterInput(req), pageId, versionId })
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

  if (principalId(req.user) === null && !getWikiAuth().checkAccess(req.user, ['read:pages', 'manage:system'])) {
    return res.status(403).json({ error: 'authentication or read:pages is required' })
  }

  try {
    const page = await pageOperations.get({ ...requesterInput(req), id })
    const pageResult: Record<string, unknown> = page

    return res.json({
      id: pageResult.id,
      path: pageResult.path,
      hash: pageResult.hash,
      title: pageResult.title,
      description: pageResult.description,
      visibility: pageResult.visibility,
      ownerId: pageResult.ownerId ?? null,
      isPublished: Boolean(pageResult.isPublished),
      publishStartDate: pageResult.publishStartDate || null,
      publishEndDate: pageResult.publishEndDate || null,
      contentType: pageResult.contentType,
      createdAt: pageResult.createdAt,
      updatedAt: pageResult.updatedAt,
      editor: pageResult.editor,
      locale: pageResult.locale,
      authorId: pageResult.authorId,
      authorName: pageResult.authorName,
      authorEmail: pageResult.authorEmail,
      creatorId: pageResult.creatorId,
      creatorName: pageResult.creatorName,
      creatorEmail: pageResult.creatorEmail
    })
  } catch (err) {
    if (errorStatus(err, 0) > 0) return res.status(errorStatus(err, 500)).json({ error: errorMessage(err, 'Page fetch failed') })
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
    await pageOperations.remove({ ...requesterInput(req), id })
    res.json({ message: 'Page has been deleted.' })
  } catch (err) {
    if (err instanceof Error && err.name === 'PageNotFound') {
      return res.status(404).json({ error: errorMessage(err, 'This page does not exist.') })
    }
    if (err instanceof Error && err.name === 'PageDeleteForbidden') {
      return res.status(403).json({ error: errorMessage(err, 'You are not authorized to delete this page.') })
    }
    res.status(500).json({ error: errorMessage(err, 'Page delete failed') })
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
    res.status(errorStatus(err, 500)).json({ error: errorMessage(err, 'Tag update failed') })
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
    res.status(errorStatus(err, 500)).json({ error: errorMessage(err, 'Tag delete failed') })
  }
})

export default router
