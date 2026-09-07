import express from 'express'
import { type Request, type Response, errorStatus, getWikiAuth } from '../_types.ts'
import { systemRequester } from '../../helpers/system-authority.ts'
import { getUtilitiesWorkspaceStore } from '../../operations/utilities-workspace.ts'

const router = express.Router()

const authorized = (req: Request, res: Response): boolean => {
  res.set('Cache-Control', 'no-store')
  if (getWikiAuth().checkAccess(systemRequester(req).user, ['manage:system'])) return true
  res.status(403).json({ error: 'System administration is required.' })
  return false
}

const failed = (res: Response, error: unknown) => {
  const status = errorStatus(error)
  if (status && [400, 403, 404, 409].includes(status) && error instanceof Error) return res.status(status).json({ error: error.message })
  return res
    .status(503)
    .json({ error: 'Utilities administration is unavailable. Reload to inspect saved operation receipts; do not repeat an unconfirmed action.' })
}

router.get('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getUtilitiesWorkspaceStore().inspect(systemRequester(req)))
  } catch (error) {
    failed(res, error)
  }
})

router.post('/operations', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.status(202).json(await getUtilitiesWorkspaceStore().start(systemRequester(req), req.body))
  } catch (error) {
    failed(res, error)
  }
})

router.get('/operations/:id', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getUtilitiesWorkspaceStore().receipt(systemRequester(req), req.params.id))
  } catch (error) {
    failed(res, error)
  }
})

export default router
