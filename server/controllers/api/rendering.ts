import express from 'express'
import { type Request, type Response, getWikiAuth } from '../_types.ts'

import renderingOperations from '../../operations/rendering.ts'

const router = express.Router()


const requireSystemAccess = (req: Request, res: Response, json = false): boolean => { if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
  if (json) res.status(403).json({ error: 'Forbidden' })
  else res.sendStatus(403)
  return false
}
return true }

router.get('/renderers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const renderers = await renderingOperations.listRenderers()
    res.json(renderers.map(renderer => ({
      isEnabled: renderer.isEnabled,
      key: renderer.key,
      title: renderer.title,
      description: typeof renderer.description === 'undefined' ? null : renderer.description,
      icon: typeof renderer.icon === 'undefined' ? null : renderer.icon,
      dependsOn: typeof renderer.dependsOn === 'undefined' ? null : renderer.dependsOn,
      input: typeof renderer.input === 'undefined' ? null : renderer.input,
      output: typeof renderer.output === 'undefined' ? null : renderer.output,
      config: renderer.config
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/renderers', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    const body: unknown = req.body
    const renderers = typeof body === 'object' && body !== null && 'renderers' in body ? body.renderers : undefined
    await renderingOperations.updateRenderers(renderers)
    res.json({ message: 'Renderers updated successfully' })
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message || 'Renderers update failed' })
  }
})

export default router
