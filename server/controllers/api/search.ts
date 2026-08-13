import express from 'express'
import { type Request, type Response, getWikiAuth } from '../_types.ts'

import searchOperations from '../../operations/search.ts'

const router = express.Router()


const requireSystemAccess = (req: Request, res: Response, json = false): boolean => { if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
  if (json) res.status(403).json({ error: 'Forbidden' })
  else res.sendStatus(403)
  return false
}
return true }

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
    const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message || 'Search Engines update failed' })
  }
})

router.post('/rebuild-index', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await searchOperations.rebuildIndex()
    res.json({ message: 'Index rebuilt successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message || 'Index rebuild failed' })
  }
})

export default router
