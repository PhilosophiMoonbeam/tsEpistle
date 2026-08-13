import express from 'express'
import { type Request, wikiAuth } from '../_types.ts'

import themingOperations from '../../operations/theming.ts'

const router = express.Router()


const canManageTheme = (req: Request): boolean => wikiAuth.checkAccess(req.user, ['manage:theme', 'manage:system'])

router.get('/config', (req, res) => {
  if (!canManageTheme(req)) return res.sendStatus(403)
  res.set('Cache-Control', 'no-store')
  res.json(themingOperations.getConfig())
})

router.post('/config', async (req, res) => {
  if (!canManageTheme(req)) return res.status(403).json({ error: 'Forbidden' })
  try {
    const body: unknown = req.body
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'Theme configuration must be an object' })
    }
    await themingOperations.updateConfig(body)
    res.json({ message: 'Theme config updated' })
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message || 'Theme config update failed' })
  }
})

export default router
