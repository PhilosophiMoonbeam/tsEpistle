import express from 'express'
import { type Request, type Response, wikiAuth } from '../_types.ts'

import storageOperations from '../../operations/storage.ts'

const router = express.Router()


const requireSystemAccess = (req: Request, res: Response): boolean => {
  if (!wikiAuth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }
  return true
}


const sendError = (res: Response, value: unknown, fallback: string) => {
  const err = value as Error & { status?: number }
  return res.status(err.status || 500).json({ error: err.message || fallback })
}
router.get('/targets', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(await storageOperations.listTargets())
  } catch (err) {
    sendError(res, err, 'Storage targets failed')
  }
})

router.get('/status', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(await storageOperations.listStatus())
  } catch (err) {
    sendError(res, err, 'Storage status failed')
  }
})

router.put('/targets', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await storageOperations.updateTargets(req.body && req.body.targets)
    res.json({ message: 'Storage targets updated successfully' })
  } catch (err) {
    sendError(res, err, 'Storage targets update failed')
  }
})

router.post('/actions/execute', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await storageOperations.executeAction(req.body || {})
    res.json({ message: 'Action completed.' })
  } catch (err) {
    sendError(res, err, 'Storage action failed')
  }
})

export default router
