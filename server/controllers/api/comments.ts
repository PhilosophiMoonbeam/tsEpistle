import express from 'express'
import { errorStatus, objectValue, type NextFunction, type Request, type Response, getWikiAuth } from '../_types.ts'

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
    res.status(status).json({ error: message || 'Request Failed' })
    return
  }
  next(err)
}

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

router.get('/', async (req, res, next) => {
  const pageId = parsePositiveInteger(req.query && req.query.pageId)
  if (pageId === null) {
    return res.status(400).json({ error: 'pageId query parameter must be a positive integer' })
  }
  if (!requireCommentRequester(req, res)) return
  try {
    res.json(await commentOperations.list({ requester: req.user, pageId }))
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
      requester: req.user,
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
    res.json(await commentOperations.get({ requester: req.user, id }))
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
      requester: req.user,
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
    await commentOperations.remove({ requester: req.user, ip: req.ip ?? '', id })
    res.json({ message: 'Comment deleted successfully' })
  } catch (err) {
    handleCommentError(err, res, next)
  }
})

export default router
