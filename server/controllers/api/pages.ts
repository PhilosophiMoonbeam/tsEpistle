import express from 'express'
import { type Request, type Response, getTransportRuntime, getWikiAuth } from '../_types.ts'
import _ from 'lodash'
import pageOperations from '../../operations/pages.ts'
import { linkPageLocaleRelation, listPageLocaleRelations, unlinkPageLocaleRelation } from '../../operations/page-locale-relations.ts'
import { principalId, type PageVisibility } from '../../helpers/page-access.ts'
import { getPageWatchState, listPageWatchNotifications, markPageWatchNotificationRead, unwatchPage, watchPage } from '../../operations/page-watching.ts'
import { getPageApproval, listApprovalInbox, submitPageApproval, transitionApproval } from '../../operations/approvals.ts'
import {
  assertPageUnlocked,
  getPageProtection,
  isPageProtected,
  removePageProtection,
  setPageProtection,
  unlockPage
} from '../../operations/page-protection.ts'
import { createAuthRateLimiter, setAuthRateLimitHeaders, type AuthRateLimiter } from '../../helpers/auth-rate-limiter.ts'
import type { Knex } from 'knex'

const router = express.Router()

interface PagesApiRuntime {
  collaboration: {
    issueSession(input: { pageId: number; expectedUpdatedAt: string; requester: Express.User | undefined }): Promise<unknown>
  }
  models: { knex: Knex }
}

let pageUnlockLimiter: AuthRateLimiter | undefined
const getPageUnlockLimiter = (): AuthRateLimiter => {
  if (pageUnlockLimiter) return pageUnlockLimiter
  pageUnlockLimiter = createAuthRateLimiter({
    knex: getTransportRuntime<PagesApiRuntime>().models.knex,
    keyPrefix: 'page-unlock-api',
    onLimit: (_req, res, retryAfterMs) => {
      setAuthRateLimitHeaders(res, retryAfterMs)
      res.status(429).json({ error: 'Too many failed attempts. Try again later.' })
    }
  })
  return pageUnlockLimiter
}
const pageUnlockMiddleware: express.RequestHandler = (req, res, next) => {
  getPageUnlockLimiter().middleware(req, res, next)
}

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

const isDateValue = (value: unknown): value is string | Date => typeof value === 'string' || value instanceof Date

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
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

const optionalStringQuery = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)
const requiredSourceRevision = (req: Request, res: Response): string | null => {
  const value = requestBody(req).expectedSourceRevision
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    res.status(400).json({ error: 'expectedSourceRevision must be a non-empty string' })
    return null
  }
  return value
}

const parseTreeMode = (value: unknown): TreeMode | null => (value === 'ALL' || value === 'FOLDERS' || value === 'PAGES' ? value : null)

const requesterInput = (req: Request): { requester?: Express.User } => (req.user === undefined ? {} : { requester: req.user })
const pageOperationContext = (req: Request): { requester?: Express.User; sessionId: string } => ({
  ...requesterInput(req),
  sessionId: req.sessionID
})
const hasRestrictedPageFieldAccess = (req: Request): boolean =>
  Array.isArray(req.user?.permissions) && req.user.permissions.some(permission => permission === 'write:pages' || permission === 'manage:system')
const pageResponse = (req: Request, page: unknown): unknown => {
  if (hasRestrictedPageFieldAccess(req) || typeof page !== 'object' || page === null) return page
  return _.omit(page, [
    'isPublished',
    'publishStartDate',
    'publishEndDate',
    'editor',
    'editorKey',
    'authorId',
    'authorName',
    'authorEmail',
    'creatorId',
    'creatorName',
    'creatorEmail'
  ])
}

const requireSystemAccess = (req: Request, res: Response): boolean => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'manage:system is required' })
    return false
  }
  return true
}

const requireUnlockedPage = async (req: Request, res: Response, pageId: number): Promise<boolean> => {
  try {
    if (await isPageProtected(pageId)) {
      res.set('Cache-Control', 'private, no-store')
      res.vary('Cookie')
    }
    await assertPageUnlocked({ requester: req.user, pageId, sessionId: req.sessionID })
    return true
  } catch {
    res.status(403).json({ error: 'Access denied' })
    return false
  }
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
    return value
      .split(',')
      .map(tag => _.trim(tag).toLowerCase())
      .filter(tag => tag.length > 0)
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
const sendOperationError = (res: Response, next: express.NextFunction, value: unknown, fallback: string): void => {
  const status = errorStatus(value, 0)
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: errorMessage(value, fallback) })
    return
  }
  next(value)
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

    return res.json(
      pages.map(page => {
        if (!isPageListItem(page)) {
          throw new TypeError('Page list query returned an invalid selected row')
        }
        return {
          id: page.id,
          path: page.path,
          locale: page.locale,
          title: page.title ?? null,
          description: page.description ?? null,
          ...(hasRestrictedPageFieldAccess(req) ? { isPublished: Boolean(page.isPublished) } : {}),
          visibility: page.visibility,
          ownerId: page.ownerId,
          contentType: page.contentType,
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
          tags: page.tags
        }
      })
    )
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

    return res.json(
      tags.map(tag => ({
        id: tag.id,
        tag: tag.tag,
        title: tag.title,
        createdAt: tag.createdAt,
        updatedAt: tag.updatedAt
      }))
    )
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
    res.json(
      await pageOperations.search({
        ...requesterInput(req),
        query,
        ...(locale === undefined ? {} : { locale }),
        ...(path === undefined ? {} : { path })
      })
    )
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
    res.json(
      await pageOperations.getTree({
        ...requesterInput(req),
        locale,
        mode,
        includeAncestors: _.get(req, 'query.includeAncestors') === 'true',
        ...(path === undefined ? {} : { path }),
        ...(parent === undefined ? {} : { parent })
      })
    )
  } catch (err) {
    next(err)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const page = await pageOperations.create({ ...pageOperationContext(req), input: requestBody(req) })
    res.status(201).json({ page: pageResponse(req, page) })
  } catch (err) {
    sendOperationError(res, next, err, 'Page creation failed')
  }
})

router.put('/:id', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const expectedSourceRevision = requiredSourceRevision(req, res)
  if (expectedSourceRevision === null) return
  try {
    const page = await pageOperations.update({ ...pageOperationContext(req), input: { ...requestBody(req), id, expectedSourceRevision } })
    res.json({ page: pageResponse(req, page) })
  } catch (err) {
    sendOperationError(res, next, err, 'Page update failed')
  }
})

router.patch('/:id/visibility', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const expectedSourceRevision = requiredSourceRevision(req, res)
  if (expectedSourceRevision === null) return
  const visibility = _.get(req, 'body.visibility')
  if (visibility !== 'public' && visibility !== 'private') {
    return res.status(400).json({ error: 'visibility must be public or private' })
  }
  try {
    const page = await pageOperations.changeVisibility({
      ...pageOperationContext(req),
      id,
      visibility,
      confirmPublication: _.get(req, 'body.confirmPublication') === true,
      expectedSourceRevision
    })
    return res.json({ page: pageResponse(req, page) })
  } catch (err) {
    return sendOperationError(res, next, err, 'Page visibility update failed')
  }
})

router.patch('/:id/owner', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const expectedSourceRevision = requiredSourceRevision(req, res)
  if (expectedSourceRevision === null) return
  const ownerId = _.get(req, 'body.ownerId')
  if (!Number.isSafeInteger(ownerId) || (ownerId as number) < 1) {
    return res.status(400).json({ error: 'ownerId must be a positive integer' })
  }
  try {
    const page = await pageOperations.transferOwnership({
      ...pageOperationContext(req),
      id,
      ownerId,
      expectedSourceRevision
    })
    return res.json({ page: pageResponse(req, page) })
  } catch (err) {
    return sendOperationError(res, next, err, 'Page ownership transfer failed')
  }
})

router.get('/:id/protection', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    res.set('Cache-Control', 'private, no-store')
    res.json(await getPageProtection(req.user, id))
  } catch (err) {
    next(err)
  }
})

router.put('/:id/protection', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const password = _.get(req, 'body.password')
  if (typeof password !== 'string') return res.status(400).json({ error: 'password must be a string' })
  try {
    res.set('Cache-Control', 'private, no-store')
    res.json(await setPageProtection({ requester: req.user, pageId: id, password, sessionId: req.sessionID }))
  } catch (err) {
    next(err)
  }
})

router.delete('/:id/protection', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    res.set('Cache-Control', 'private, no-store')
    res.json(await removePageProtection({ requester: req.user, pageId: id }))
  } catch (err) {
    next(err)
  }
})

router.post('/:id/unlock', pageUnlockMiddleware, async (req, res) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const password = _.get(req, 'body.password')
  try {
    await unlockPage({ requester: req.user, pageId: id, password: typeof password === 'string' ? password : '', sessionId: req.sessionID })
    req.session.pageUnlockEstablishedAt = Date.now()
    await getPageUnlockLimiter().reset(req)
    res.set('Cache-Control', 'private, no-store')
    res.sendStatus(204)
  } catch {
    res.status(403).json({ error: 'Access denied' })
  }
})

router.get('/approvals/inbox', async (req, res, next) => {
  try {
    res.json(await listApprovalInbox(req.user))
  } catch (err) {
    next(err)
  }
})

router.post('/approvals/:requestId/transition', async (req, res, next) => {
  const action = _.get(req, 'body.action')
  if (!['approve', 'request-changes', 'reject', 'cancel', 'resubmit', 'publish', 'reassign'].includes(action)) {
    return res.status(400).json({ error: 'A valid approval action is required' })
  }
  try {
    res.json(
      await transitionApproval({
        requester: req.user,
        requestId: String(req.params.requestId || ''),
        action: action as 'approve' | 'request-changes' | 'reject' | 'cancel' | 'resubmit' | 'publish' | 'reassign',
        comment: typeof _.get(req, 'body.comment') === 'string' ? _.get(req, 'body.comment') : undefined,
        assigneeId: typeof _.get(req, 'body.assigneeId') === 'number' ? _.get(req, 'body.assigneeId') : undefined
      })
    )
  } catch (err) {
    next(err)
  }
})

router.get('/:id/approval', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    res.json({ approval: await getPageApproval(req.user, id) })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/approval', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const expectedSourceRevision = requiredSourceRevision(req, res)
  if (expectedSourceRevision === null) return
  try {
    res.json(
      await submitPageApproval({
        requester: req.user,
        pageId: id,
        expectedSourceRevision,
        assigneeId: _.get(req, 'body.assigneeId'),
        comment: _.get(req, 'body.comment')
      })
    )
  } catch (err) {
    next(err)
  }
})

router.get('/watches/notifications', async (req, res, next) => {
  try {
    res.json(await listPageWatchNotifications(req.user))
  } catch (err) {
    next(err)
  }
})

router.patch('/watches/notifications/:notificationId/read', async (req, res, next) => {
  try {
    await markPageWatchNotificationRead(req.user, String(req.params.notificationId || ''))
    res.sendStatus(204)
  } catch (err) {
    next(err)
  }
})

router.get('/:id/watch', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    res.json(await getPageWatchState({ ...requesterInput(req), id }))
  } catch (err) {
    next(err)
  }
})

router.put('/:id/watch', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const emailEnabled = _.get(req, 'body.emailEnabled')
  if (emailEnabled !== undefined && typeof emailEnabled !== 'boolean') {
    return res.status(400).json({ error: 'emailEnabled must be a boolean' })
  }
  try {
    res.json(
      await watchPage({
        ...requesterInput(req),
        id,
        emailEnabled: emailEnabled === true
      })
    )
  } catch (err) {
    next(err)
  }
})

router.delete('/:id/watch', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    res.json(await unwatchPage({ ...requesterInput(req), id }))
  } catch (err) {
    next(err)
  }
})

router.post('/:id/convert', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const expectedSourceRevision = requiredSourceRevision(req, res)
  if (expectedSourceRevision === null) return
  try {
    const editor = _.get(req, 'body.editor')
    await pageOperations.convert({
      ...pageOperationContext(req),
      input: { id, expectedSourceRevision, ...(typeof editor === 'string' ? { editor } : {}) }
    })
    res.json({ message: 'Page has been converted.' })
  } catch (err) {
    sendOperationError(res, next, err, 'Page conversion failed')
  }
})

router.post('/:id/move', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const expectedSourceRevision = requiredSourceRevision(req, res)
  if (expectedSourceRevision === null) return
  try {
    const destinationLocale = _.get(req, 'body.destinationLocale')
    const destinationPath = _.get(req, 'body.destinationPath')
    if (typeof destinationLocale !== 'string' || typeof destinationPath !== 'string') {
      return res.status(400).json({ error: 'destinationLocale and destinationPath must be strings' })
    }
    await pageOperations.move({
      ...pageOperationContext(req),
      input: { id, destinationLocale, destinationPath, expectedSourceRevision }
    })
    res.json({ message: 'Page has been moved.' })
  } catch (err) {
    sendOperationError(res, next, err, 'Page move failed')
  }
})

router.get('/:id/locale-relations', async (req, res, next) => {
  const pageId = parsePositiveIntegerParam(req, res)
  if (pageId === null) return
  try {
    res.json(await listPageLocaleRelations({ ...requesterInput(req), pageId }))
  } catch (err) {
    next(err)
  }
})

router.post('/:id/locale-relations', async (req, res, next) => {
  const pageId = parsePositiveIntegerParam(req, res)
  if (pageId === null) return
  const relatedPageId = requestBody(req).relatedPageId
  if (typeof relatedPageId !== 'number' || !Number.isSafeInteger(relatedPageId) || relatedPageId < 1) {
    return res.status(400).json({ error: 'relatedPageId must be a positive integer' })
  }
  try {
    res.json(await linkPageLocaleRelation({ ...requesterInput(req), pageId, relatedPageId }))
  } catch (err) {
    next(err)
  }
})

router.delete('/:id/locale-relations/:relatedPageId', async (req, res, next) => {
  const pageId = parsePositiveIntegerParam(req, res)
  if (pageId === null) return
  const relatedPageId = parsePositiveIntegerParam(req, res, 'relatedPageId')
  if (relatedPageId === null) return
  try {
    res.json(await unlinkPageLocaleRelation({ ...requesterInput(req), pageId, relatedPageId }))
  } catch (err) {
    next(err)
  }
})

router.post('/:id/conflicts/check', async (req, res, next) => {
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
    next(err)
  }
})

router.get('/:id/conflict-latest', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  try {
    res.json(await pageOperations.getConflictLatest({ ...pageOperationContext(req), id }))
  } catch (err) {
    sendOperationError(res, next, err, 'Latest page version fetch failed')
  }
})
router.post('/:id/collaboration/session', async (req, res, next) => {
  const pageId = parsePositiveIntegerParam(req, res)
  if (pageId === null) return
  if (!(await requireUnlockedPage(req, res, pageId))) return
  const expectedUpdatedAt = requestBody(req).expectedUpdatedAt
  if (typeof expectedUpdatedAt !== 'string' || Number.isNaN(Date.parse(expectedUpdatedAt))) {
    return res.status(400).json({ error: 'expectedUpdatedAt must be a valid date' })
  }
  try {
    const collaboration = getTransportRuntime<PagesApiRuntime>().collaboration
    res.json(await collaboration.issueSession({ pageId, expectedUpdatedAt, requester: req.user }))
  } catch (err) {
    next(err)
  }
})

router.get('/:id/history', async (req, res, next) => {
  const id = parsePositiveIntegerParam(req, res)
  if (id === null) return
  const offsetPage = Number(_.get(req, 'query.offsetPage', 0))
  const offsetSize = Number(_.get(req, 'query.offsetSize', 100))
  if (!Number.isSafeInteger(offsetPage) || offsetPage < 0 || !Number.isSafeInteger(offsetSize) || offsetSize < 1) {
    return res.status(400).json({ error: 'history offsets are invalid' })
  }
  try {
    res.json(await pageOperations.getHistory({ ...pageOperationContext(req), id, offsetPage, offsetSize }))
  } catch (err) {
    sendOperationError(res, next, err, 'Page history fetch failed')
  }
})

router.get('/:id/history/:versionId', async (req, res, next) => {
  const pageId = parsePositiveIntegerParam(req, res)
  if (pageId === null) return
  const versionId = parsePositiveIntegerParam(req, res, 'versionId')
  if (versionId === null) return
  try {
    res.json(await pageOperations.getVersion({ ...pageOperationContext(req), pageId, versionId }))
  } catch (err) {
    sendOperationError(res, next, err, 'Page version fetch failed')
  }
})

router.post('/:id/history/:versionId/restore', async (req, res, next) => {
  const pageId = parsePositiveIntegerParam(req, res)
  if (pageId === null) return
  const versionId = parsePositiveIntegerParam(req, res, 'versionId')
  if (versionId === null) return
  const expectedSourceRevision = requiredSourceRevision(req, res)
  if (expectedSourceRevision === null) return
  try {
    await pageOperations.restore({ ...pageOperationContext(req), pageId, versionId, expectedSourceRevision })
    res.json({ message: 'Page version restored successfully.' })
  } catch (err) {
    sendOperationError(res, next, err, 'Page restore failed')
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
    if (await isPageProtected(id)) {
      res.set('Cache-Control', 'private, no-store')
      res.vary('Cookie')
    }
    const page = await pageOperations.get({ ...pageOperationContext(req), id })
    const pageResult: Record<string, unknown> = page
    const canReadRestrictedFields = hasRestrictedPageFieldAccess(req)
    return res.json({
      id: pageResult.id,
      path: pageResult.path,
      hash: pageResult.hash,
      title: pageResult.title,
      description: pageResult.description,
      visibility: pageResult.visibility,
      ownerId: pageResult.ownerId ?? null,
      contentType: pageResult.contentType,
      createdAt: pageResult.createdAt,
      updatedAt: pageResult.updatedAt,
      sourceRevision: String(pageResult.sourceRevision),
      locale: pageResult.locale,
      ...(canReadRestrictedFields
        ? {
            isPublished: Boolean(pageResult.isPublished),
            publishStartDate: pageResult.publishStartDate || null,
            publishEndDate: pageResult.publishEndDate || null,
            editor: pageResult.editor,
            authorId: pageResult.authorId,
            authorName: pageResult.authorName,
            authorEmail: pageResult.authorEmail,
            creatorId: pageResult.creatorId,
            creatorName: pageResult.creatorName,
            creatorEmail: pageResult.creatorEmail
          }
        : {})
    })
  } catch (err) {
    sendOperationError(res, next, err, 'Page fetch failed')
  }
})

router.delete('/:id', async (req, res, next) => {
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
  const expectedSourceRevision = requiredSourceRevision(req, res)
  if (expectedSourceRevision === null) return

  try {
    await pageOperations.remove({ ...pageOperationContext(req), id, expectedSourceRevision })
    res.json({ message: 'Page has been deleted.' })
  } catch (err) {
    if (err instanceof Error && err.name === 'PageNotFound') {
      return res.status(404).json({ error: errorMessage(err, 'This page does not exist.') })
    }
    if (err instanceof Error && err.name === 'PageDeleteForbidden') {
      return res.status(403).json({ error: errorMessage(err, 'You are not authorized to delete this page.') })
    }
    return sendOperationError(res, next, err, 'Page delete failed')
  }
})

router.patch('/tags/:id', async (req, res, next) => {
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
    sendOperationError(res, next, err, 'Tag update failed')
  }
})

router.delete('/tags/:id', async (req, res, next) => {
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
    sendOperationError(res, next, err, 'Tag delete failed')
  }
})

export default router
