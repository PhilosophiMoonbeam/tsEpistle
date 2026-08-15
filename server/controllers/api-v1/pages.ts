import express from 'express'
import type { Request } from 'express'

import { getWikiAuth, objectValue } from '../_types.ts'
import { principalId } from '../../helpers/page-access.ts'
import pageOperations from '../../operations/pages.ts'

const router = express.Router()
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

const positiveInteger = (value: unknown): number | null => {
  const normalized = Array.isArray(value) ? value[0] : value
  if (typeof normalized !== 'string' || !/^[1-9]\d*$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const nonNegativeInteger = (value: unknown): number | null => {
  const normalized = Array.isArray(value) ? value[0] : value
  if (typeof normalized !== 'string' || !/^\d+$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const requesterInput = (req: Request): { requester?: Express.User } =>
  req.user === undefined ? {} : { requester: req.user }

const canRequestPages = (req: Request): boolean =>
  principalId(req.user) !== null || getWikiAuth().checkAccess(req.user, ['read:pages', 'manage:system'])

router.get('/', async (req, res, next) => {
  if (!canRequestPages(req)) return res.status(403).json({ error: 'read:pages or manage:system is required' })

  const parsedLimit = req.query.limit === undefined ? DEFAULT_LIMIT : positiveInteger(req.query.limit)
  const parsedOffset = req.query.offset === undefined ? 0 : nonNegativeInteger(req.query.offset)
  if (parsedLimit === null || parsedLimit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit must be an integer from 1 through ${MAX_LIMIT}` })
  }
  if (parsedOffset === null) return res.status(400).json({ error: 'offset must be a non-negative integer' })

  const locale = typeof req.query.locale === 'string' && req.query.locale.length > 0
    ? req.query.locale
    : undefined
  const tags = typeof req.query.tags === 'string'
    ? req.query.tags.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean)
    : []

  try {
    const rows = await pageOperations.list({
      ...requesterInput(req),
      limit: parsedLimit + 1,
      offset: parsedOffset,
      tags,
      ...(locale === undefined ? {} : { locale })
    })
    const hasMore = rows.length > parsedLimit
    const items = rows.slice(0, parsedLimit).map(page => {
      const row = page as unknown as Record<string, unknown>
      return {
        contentType: objectValue(row, 'contentType'),
        createdAt: objectValue(row, 'createdAt') ?? null,
        description: objectValue(row, 'description') ?? null,
        id: page.id,
        isPublished: Boolean(objectValue(row, 'isPublished')),
        locale: page.locale,
        ownerId: page.ownerId ?? null,
        path: page.path,
        tags: page.tags,
        title: page.title ?? null,
        updatedAt: page.updatedAt,
        visibility: page.visibility
      }
    })
    return res.json({
      items,
      pagination: {
        limit: parsedLimit,
        nextOffset: hasMore ? parsedOffset + parsedLimit : null,
        offset: parsedOffset
      }
    })
  } catch (error) {
    return next(error)
  }
})

router.get('/:id', async (req, res, next) => {
  if (!canRequestPages(req)) return res.status(403).json({ error: 'read:pages or manage:system is required' })
  const id = positiveInteger(req.params.id)
  if (id === null) return res.status(400).json({ error: 'id must be a positive integer' })

  try {
    const page = await pageOperations.get({ ...requesterInput(req), id })
    const row = page as unknown as Record<string, unknown>
    return res.json({
      authorId: objectValue(row, 'authorId') ?? null,
      authorName: objectValue(row, 'authorName') ?? null,
      contentType: objectValue(row, 'contentType'),
      createdAt: objectValue(row, 'createdAt') ?? null,
      creatorId: objectValue(row, 'creatorId') ?? null,
      creatorName: objectValue(row, 'creatorName') ?? null,
      description: objectValue(row, 'description') ?? null,
      editor: page.editor,
      id: page.id,
      isPublished: Boolean(objectValue(row, 'isPublished')),
      locale: page.locale,
      ownerId: page.ownerId ?? null,
      path: page.path,
      publishEndDate: objectValue(row, 'publishEndDate') || null,
      tags: page.tags.map(tag => tag.tag),
      publishStartDate: objectValue(row, 'publishStartDate') || null,
      title: page.title,
      updatedAt: page.updatedAt,
      visibility: page.visibility
    })
  } catch (error) {
    return next(error)
  }
})

export default router
