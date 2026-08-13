import express from 'express'
import { type Request, type Response, wikiAuth } from '../_types.ts'

import siteOperations from '../../operations/site.ts'

const router = express.Router()


const requireSystemAccess = (req: Request, res: Response): boolean => { if (!wikiAuth.checkAccess(req.user, ['manage:system'])) {
  res.status(403).json({ error: 'Forbidden' })
  return false
}
return true }

router.get('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(siteOperations.getConfig())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message || 'Site configuration fetch failed' })
  }
})

router.put('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const body: unknown = req.body
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'Site configuration must be an object' })
    }
    await siteOperations.updateConfig(body)
    res.json({ message: 'Site configuration updated successfully' })
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message || 'Site configuration update failed' })
  }
})

export default router
