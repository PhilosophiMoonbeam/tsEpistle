import express from 'express'
import { type Request, type Response, getWikiAuth } from '../_types.ts'

import mailOperations from '../../operations/mail.ts'

const router = express.Router()


const requireSystemAccess = (req: Request, res: Response): boolean => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }
  return true
}


const sendError = (res: Response, value: unknown, fallback: string) => {
  const err = value as Error & { status?: number }
  return res.status(err.status || 500).json({ error: err.message || fallback })
}
router.get('/config', (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.json(mailOperations.getConfig())
})

router.post('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await mailOperations.updateConfig(req.body)
    res.json({ message: 'Mail configuration updated successfully.' })
  } catch (err) {
    sendError(res, err, 'Mail configuration update failed')
  }
})

router.post('/test', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await mailOperations.sendTest(req.body && req.body.recipientEmail)
    res.json({ message: 'Test email sent successfully.' })
  } catch (err) {
    sendError(res, err, 'Test email failed')
  }
})

export default router
