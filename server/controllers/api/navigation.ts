import express from 'express'
import { errorStatus, type Request, type Response, wikiAuth } from '../_types.ts'

import navigationOperations from '../../operations/navigation.ts'

const router = express.Router()


const requireNavigationAccess = (req: Request, res: Response): boolean => { if (!wikiAuth.checkAccess(req.user, ['manage:navigation', 'manage:system'])) {
  res.status(403).json({ error: 'manage:navigation or manage:system is required' })
  return false
}
return true }

router.get('/', async (req, res, next) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    res.json(await navigationOperations.get())
  } catch (err) {
    next(err)
  }
})

router.put('/', async (req, res) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    await navigationOperations.update(req.body || {})
    res.json({ message: 'Navigation saved successfully.' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(errorStatus(err) ?? 500).json({ error: message || 'Navigation save failed' })
  }
})

export default router
