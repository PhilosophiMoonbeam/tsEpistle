import express from 'express'
import { type Request, type Response, errorStatus, getWikiAuth } from '../_types.ts'
import { systemRequester } from '../../helpers/system-authority.ts'
import { getExtensionsWorkspaceStore } from '../../operations/extensions-workspace.ts'

const router = express.Router()

const authorized = (req: Request, res: Response): boolean => {
  res.set('Cache-Control', 'no-store')
  if (getWikiAuth().checkAccess(req.user, ['manage:system'])) return true
  res.status(403).json({ error: 'System administration is required.' })
  return false
}

const failed = (res: Response, error: unknown) => {
  const status = errorStatus(error)
  const expected = status && [400, 403, 404, 409].includes(status)
  return res.status(expected ? status : 503).json({
    error:
      expected && error instanceof Error ? error.message : 'Extension observations are unavailable. Reload to inspect the deployed application image again.'
  })
}

router.get('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getExtensionsWorkspaceStore().inspect(systemRequester(req)))
  } catch (error) {
    failed(res, error)
  }
})

export default router
