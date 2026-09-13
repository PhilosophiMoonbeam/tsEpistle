import express from 'express'
import { errorStatus, objectValue, type NextFunction, type Request, type Response, getWikiAuth } from '../_types.ts'

import { readDiscussionWorkspace, writeDiscussionWorkspace } from '../../operations/discussion-settings.ts'
import { discussionModeration } from '../../operations/discussion-moderation.ts'
import commentOperations from '../../operations/comments.ts'

const router = express.Router()

const requireSystemAccess = (req: Request, res: Response, json = false): boolean => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
    if (json) res.status(403).json({ error: 'Forbidden' })
    else res.sendStatus(403)
    return false
  }
  return true
}

const parsePositiveInteger = (value: unknown): number | null => {
  if (!/^[1-9]\d*$/.test(String(value || ''))) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}
const requireCommentRequester = (req: Request, res: Response): req is Request & { user: Express.User } => {
  if (req.user !== undefined) return true
  res.status(403).json({ error: 'Forbidden' })
  return false
}
const handleCommentError = (err: unknown, res: Response, next: NextFunction): void => {
  const status = errorStatus(err)
  if (status !== undefined && status >= 400 && status < 500) {
    const message = err instanceof Error ? err.message : String(err)
    const retryAfterMilliseconds = typeof err === 'object' && err !== null ? Reflect.get(err, 'retryAfterMilliseconds') : undefined
    if (status === 429 && typeof retryAfterMilliseconds === 'number' && Number.isFinite(retryAfterMilliseconds)) res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMilliseconds / 1000))))
    res.status(status).json({ error: message || 'Request Failed' })
    return
  }
  next(err)
}

router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
const fail = (res: Response, error: unknown) => {
  const status = errorStatus(error) ?? 500
  if (status >= 500) (WIKI as unknown as { logger: { warn(error: unknown): void } }).logger.warn(error)
  res.status(status).json({ error: status >= 500 ? 'Discussion request failed. Try again or check server logs.' : error instanceof Error ? error.message : String(error) })
}
router.get('/workspace', async (req, res) => { try { res.json(await readDiscussionWorkspace(req.user)) } catch (error) { fail(res, error) } })
router.put('/workspace', async (req, res) => { try { res.json(await writeDiscussionWorkspace(req.user, req.body, req.body?.fingerprint)) } catch (error) { fail(res, error) } })
router.get('/moderation', async (req, res) => { try { res.json(await discussionModeration().list(req.user, req.query)) } catch (error) { fail(res, error) } })
router.get('/moderation/:id', async (req, res) => { try { res.json(await discussionModeration().inspect(req.user, Number(req.params.id))) } catch (error) { fail(res, error) } })
router.patch('/moderation/:id', async (req, res) => { try { res.json(await discussionModeration().moderate(req.user, Number(req.params.id), req.body ?? {})) } catch (error) { fail(res, error) } })
router.get('/closed-pages', async (req, res) => { try { res.json(await discussionModeration().closedPages(req.user, req.query)) } catch (error) { fail(res, error) } })
router.get('/page-policy/:id', async (req, res) => { try { res.json(await discussionModeration().policy(req.user, Number(req.params.id))) } catch (error) { fail(res, error) } })
router.patch('/page-policy/:id', async (req, res) => { try { res.json(await discussionModeration().setPolicy(req.user, Number(req.params.id), req.body ?? {})) } catch (error) { fail(res, error) } })
router.get('/availability/:id', async (req, res, next) => {
  const pageId = parsePositiveInteger(req.params.id)
  if (pageId === null) return res.status(400).json({ error: 'Choose a valid page.' })
  if (!requireCommentRequester(req, res)) return
  try {
    res.json(await commentOperations.availability({ requester: req.user, pageId, sessionId: req.sessionID }))
  } catch (error) {
    handleCommentError(error, res, next)
  }
})

router.get('/providers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const providers = await commentOperations.listProviders()
    res.json(
      providers.map(provider => ({
        isEnabled: provider.isEnabled,
        key: provider.key,
        title: objectValue(provider, 'title'),
        description: objectValue(provider, 'description'),
        logo: objectValue(provider, 'logo'),
        website: objectValue(provider, 'website'),
        isAvailable: objectValue(provider, 'isAvailable'),
        config: provider.config
      }))
    )
  } catch (err) {
    next(err)
  }
})

router.post('/providers', async (req, res, next) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    await commentOperations.updateProviders(objectValue(req.body, 'providers'))
    res.json({ message: 'Comment Providers updated successfully' })
  } catch (err) {
    handleCommentError(err, res, next)
  }
})

router.get('/mentions', async (req, res, next) => {
  const pageId = parsePositiveInteger(req.query && req.query.pageId)
  if (pageId === null) return res.status(400).json({ error: 'pageId query parameter must be a positive integer' })
  if (!requireCommentRequester(req, res)) return
  if (typeof req.user.id !== 'number' || req.user.id === 2) return res.status(401).json({ error: 'Sign in to search mention handles.' })
  try {
    res.json(await commentOperations.searchMentions({ requester: req.user, sessionId: req.sessionID, pageId, query: req.query && req.query.q }))
  } catch (err) {
    handleCommentError(err, res, next)
  }
})

router.get('/', async (req, res, next) => {
  const pageId = parsePositiveInteger(req.query && req.query.pageId)
  if (pageId === null) {
    return res.status(400).json({ error: 'pageId query parameter must be a positive integer' })
  }
  if (!requireCommentRequester(req, res)) return
  try {
    res.json(await commentOperations.list({ requester: req.user, sessionId: req.sessionID, pageId }))
  } catch (err) {
    next(err)
  }
})

router.post('/', async (req, res, next) => {
  if (!requireCommentRequester(req, res)) return
  const body: unknown = req.body
  const input = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  try {
    const id = await commentOperations.create({
      requester: req.user, sessionId: req.sessionID,
      ip: req.ip ?? '',
      input
    })
    res.status(201).json({ id })
  } catch (err) {
    handleCommentError(err, res, next)
  }
})

router.get('/:id', async (req, res, next) => {
  const id = parsePositiveInteger(req.params && req.params.id)
  if (id === null) return res.status(400).json({ error: 'comment id must be a positive integer' })
  if (!requireCommentRequester(req, res)) return
  try {
    res.json(await commentOperations.get({ requester: req.user, sessionId: req.sessionID, id }))
  } catch (err) {
    next(err)
  }
})

router.patch('/:id', async (req, res, next) => {
  const id = parsePositiveInteger(req.params && req.params.id)
  if (id === null) return res.status(400).json({ error: 'comment id must be a positive integer' })
  if (!requireCommentRequester(req, res)) return
  try {
    const render = await commentOperations.update({
      requester: req.user, sessionId: req.sessionID,
      ip: req.ip ?? '',
      input: { id, content: objectValue(req.body, 'content') }
    })
    res.json({ render })
  } catch (err) {
    handleCommentError(err, res, next)
  }
})

router.delete('/:id', async (req, res, next) => {
  const id = parsePositiveInteger(req.params && req.params.id)
  if (id === null) return res.status(400).json({ error: 'comment id must be a positive integer' })
  if (!requireCommentRequester(req, res)) return
  try {
    await commentOperations.remove({ requester: req.user, sessionId: req.sessionID, ip: req.ip ?? '', id })
    res.json({ message: 'Comment deleted successfully' })
  } catch (err) {
    handleCommentError(err, res, next)
  }
})

export default router
