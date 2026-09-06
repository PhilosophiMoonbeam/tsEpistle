import express from 'express'
import { type Request, type Response, getWikiAuth, errorStatus } from '../_types.ts'
import { getMailWorkspaceStore } from '../../operations/mail-workspace.ts'
const router = express.Router()
const authorized = (req: Request, res: Response): boolean => {
  res.set('Cache-Control', 'no-store')
  if (getWikiAuth().checkAccess(req.user, ['manage:system'])) return true
  res.status(403).json({ error: 'System administration is required.' })
  return false
}
const failed = (res: Response, error: unknown) => {
  const status = errorStatus(error),
    expected = status && [400, 403, 404, 409].includes(status)
  return res.status(expected ? status : 503).json({
    error: expected && error instanceof Error ? error.message : 'Mail administration is unavailable. Reload to confirm saved settings and check outcomes.'
  })
}
router.get('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getMailWorkspaceStore().inspect(req.user))
  } catch (error) {
    failed(res, error)
  }
})
router.put('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getMailWorkspaceStore().save(req.user, req.body))
  } catch (error) {
    failed(res, error)
  }
})
router.post('/workspace/apply', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getMailWorkspaceStore().apply(req.user, req.body))
  } catch (error) {
    failed(res, error)
  }
})
router.get('/templates/:key', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getMailWorkspaceStore().preview(req.user, req.params.key))
  } catch (error) {
    failed(res, error)
  }
})
router.get('/checks/:id', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getMailWorkspaceStore().receipt(req.user, req.params.id))
  } catch (error) {
    failed(res, error)
  }
})
router.post('/checks', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.status(202).json(await getMailWorkspaceStore().startCheck(req.user, req.body))
  } catch (error) {
    failed(res, error)
  }
})
const retired = async (req: Request, res: Response) => {
  if (!authorized(req, res)) return
  try {
    await getMailWorkspaceStore().configuration.inspect(req.user)
    res.status(410).json({ error: 'Mail now uses the reviewed workspace. Reload Administration or use /_api/mail/workspace.' })
  } catch (error) {
    failed(res, error)
  }
}
router.get('/config', retired)
router.post('/config', retired)
router.post('/test', retired)
export default router
