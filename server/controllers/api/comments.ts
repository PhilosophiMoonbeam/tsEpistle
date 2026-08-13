import express from 'express'
import { errorStatus, objectValue, type Request, type Response, getWikiAuth } from '../_types.ts'

import commentOperations from '../../operations/comments.ts'

const router = express.Router()


const requireSystemAccess = (req: Request, res: Response, json = false): boolean => { if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
  if (json) res.status(403).json({ error: 'Forbidden' })
  else res.sendStatus(403)
  return false
}
return true }

const parsePositiveInteger = (value: unknown): number | null => { if (!/^[1-9]\d*$/.test(String(value || ''))) return null
const parsed = Number(value)
return Number.isSafeInteger(parsed) ? parsed : null }
const requireCommentRequester = (req: Request, res: Response): req is Request & { user: Express.User } => {
  if (req.user !== undefined) return true
  res.status(403).json({ error: 'Forbidden' })
  return false
}


router.get('/providers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const providers = await commentOperations.listProviders()
    res.json(providers.map(provider => ({
      isEnabled: provider.isEnabled,
      key: provider.key,
      title: objectValue(provider, 'title'),
      description: objectValue(provider, 'description'),
      logo: objectValue(provider, 'logo'),
      website: objectValue(provider, 'website'),
      isAvailable: objectValue(provider, 'isAvailable'),
      config: provider.config
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/providers', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    await commentOperations.updateProviders(objectValue(req.body, 'providers'))
    res.json({ message: 'Comment Providers updated successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(errorStatus(err) ?? 500).json({ error: message || 'Comment providers update failed' })
  }
})

router.get('/', async (req, res, next) => {
  const locale = req.query && req.query.locale
  const path = req.query && req.query.path
  if (typeof locale !== 'string' || locale.length < 1 || typeof path !== 'string' || path.length < 1) {
    return res.status(400).json({ error: 'locale and path query parameters are required' })
  }
  if (!requireCommentRequester(req, res)) return
  try {
    res.json(await commentOperations.list({ requester: req.user, locale, path }))
  } catch (err) {
    next(err)
  }
})

router.post('/', async (req, res) => {
  if (!requireCommentRequester(req, res)) return
  const body: unknown = req.body
  const input = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
  try {
    const id = await commentOperations.create({
      requester: req.user,
      ip: req.ip ?? '',
      input
    })
    res.status(201).json({ id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(errorStatus(err) ?? 500).json({ error: message || 'Comment creation failed' })
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

router.patch('/:id', async (req, res) => {
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
    const message = err instanceof Error ? err.message : String(err)
    res.status(errorStatus(err) ?? 500).json({ error: message || 'Comment update failed' })
  }
})

router.delete('/:id', async (req, res) => {
  const id = parsePositiveInteger(req.params && req.params.id)
  if (id === null) return res.status(400).json({ error: 'comment id must be a positive integer' })
  if (!requireCommentRequester(req, res)) return
  try {
    await commentOperations.remove({ requester: req.user, ip: req.ip ?? '', id })
    res.json({ message: 'Comment deleted successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(errorStatus(err) ?? 500).json({ error: message || 'Comment deletion failed' })
  }
})

export default router
