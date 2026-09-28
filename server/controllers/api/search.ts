import express from 'express'
import { errorStatus, type Request, type Response, getWikiAuth } from '../_types.ts'

import errors from '../../operations/errors.ts'
import searchOperations from '../../operations/search.ts'

const router = express.Router()


const requireSystemAccess = (req: Request, res: Response, json = false): boolean => { if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
  if (json) res.status(403).json({ error: 'Forbidden' })
  else res.sendStatus(403)
  return false
}
return true }

router.get('/index-status', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  res.set('Cache-Control', 'private, no-store')
  try { res.json(await searchOperations.inspectIndex()) }
  catch { res.status(503).json({ error: 'Index inspection is unavailable. Check the search engine and database logs, then try again.' }) }
})

router.get('/engines', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const engines = await searchOperations.listEngines('title')
    res.json(engines.map(engine => ({
      isEnabled: engine.isEnabled,
      key: engine.key,
      title: engine.title,
      description: engine.description,
      logo: engine.logo,
      website: engine.website,
      isAvailable: engine.isAvailable,
      config: engine.config
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/engines', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    const body: unknown = req.body
    const engines = typeof body === 'object' && body !== null && 'engines' in body ? body.engines : undefined
    await searchOperations.updateEngines(engines)
    res.json({ message: 'Search Engines updated successfully' })
  } catch (err) {
    const errorCode = errorStatus(err)
    const status = errorCode !== undefined && errorCode >= 400 && errorCode <= 599 ? errorCode : 500
    const message = err instanceof errors.ApplicationError && status >= 400 && status < 500 && err.message
      ? err.message
      : 'Search Engines update failed'
    res.status(status).json({ error: message })
  }
})

router.post('/rebuild-index', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await searchOperations.rebuildIndex()
    res.json({ message: 'Index rebuilt successfully' })
  } catch {
    res.status(500).json({ error: 'Index rebuild failed' })
  }
})

export default router
