import express from 'express'
import type { Request } from 'express'

import { getWikiAuth, objectValue } from '../_types.ts'
import { canViewRestrictedPageFields } from '../../helpers/page-field-projection.ts'
import { pageRuleAuthorityMatchesRequester, type PageRuleAuthority } from '../../helpers/group-access.ts'
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

const requesterInput = (req: Request): { requester?: Express.User } => (req.user === undefined ? {} : { requester: req.user })

const canRequestPages = (req: Request, authority: PageRuleAuthority): boolean => {
  if (!pageRuleAuthorityMatchesRequester(req.user, authority) || !Array.isArray(authority.permissions)) return false
  return (
    authority.permissions.includes('manage:system') ||
    (authority.permissions.includes('read:pages') &&
      (authority.permissions.includes('write:pages') || authority.permissions.includes('manage:pages')))
  )
}

router.get('/', async (req, res, next) => {
  try {
    const authority = await getWikiAuth().loadPageRuleAuthority(req.user)
    if (!canRequestPages(req, authority)) return res.status(403).json({ error: 'Forbidden' })

    const parsedLimit = req.query.limit === undefined ? DEFAULT_LIMIT : positiveInteger(req.query.limit)
    const parsedOffset = req.query.offset === undefined ? 0 : nonNegativeInteger(req.query.offset)
    if (parsedLimit === null || parsedLimit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be an integer from 1 through ${MAX_LIMIT}` })
    }
    if (parsedOffset === null) return res.status(400).json({ error: 'offset must be a non-negative integer' })

    const locale = typeof req.query.locale === 'string' && req.query.locale.length > 0 ? req.query.locale : undefined
    const tags =
      typeof req.query.tags === 'string'
        ? req.query.tags
            .split(',')
            .map(tag => tag.trim().toLowerCase())
            .filter(Boolean)
        : []

    const rows = await pageOperations.list({
      ...requesterInput(req),
      authority,
      limit: parsedLimit + 1,
      offset: parsedOffset,
      tags,
      ...(locale === undefined ? {} : { locale })
    })
    const emittedRows = rows.slice(0, parsedLimit)
    if (emittedRows.some(page => !canViewRestrictedPageFields({ requester: req.user, page, authority }))) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    const hasMore = rows.length > parsedLimit
    const items = emittedRows.map(page => {
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
  try {
    const authority = await getWikiAuth().loadPageRuleAuthority(req.user)
    if (!canRequestPages(req, authority)) return res.status(403).json({ error: 'Forbidden' })

    const id = positiveInteger(req.params.id)
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' })

    const page = await pageOperations.get({ ...requesterInput(req), authority, sessionId: req.sessionID, id })
    if (!canViewRestrictedPageFields({ requester: req.user, page, authority })) {
      return res.status(403).json({ error: 'Forbidden' })
    }
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
      tags: Array.isArray(page.tags)
        ? page.tags
            .map(tag => (typeof tag === 'string' ? tag : objectValue(tag, 'tag')))
            .filter((tag): tag is string => typeof tag === 'string')
        : [],
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
