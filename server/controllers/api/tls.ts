import express from 'express'
import { type Request, type Response, getWikiAuth, errorStatus } from '../_types.ts'
import { systemRequester } from '../../helpers/system-authority.ts'
import { getTlsWorkspaceStore } from '../../operations/tls-workspace.ts'
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
  return res
    .status(expected ? status : 503)
    .json({
      error: expected && error instanceof Error ? error.message : 'HTTPS administration is unavailable. Reload to inspect saved policy and operation receipts.'
    })
}
router.get('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getTlsWorkspaceStore().inspect(systemRequester(req)))
  } catch (error) {
    failed(res, error)
  }
})
router.put('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getTlsWorkspaceStore().save(systemRequester(req), req.body))
  } catch (error) {
    failed(res, error)
  }
})
router.post('/workspace/apply', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getTlsWorkspaceStore().applyPolicy(systemRequester(req), req.body))
  } catch (error) {
    failed(res, error)
  }
})
router.post('/operations', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.status(202).json(await getTlsWorkspaceStore().start(systemRequester(req), req.body))
  } catch (error) {
    failed(res, error)
  }
})
router.get('/operations/:id', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getTlsWorkspaceStore().receipt(systemRequester(req), req.params.id))
  } catch (error) {
    failed(res, error)
  }
})
export default router
