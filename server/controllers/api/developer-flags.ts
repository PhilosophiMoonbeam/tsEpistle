import express from 'express'
import { type Request, type Response, errorStatus, getWikiAuth } from '../_types.ts'
import { systemRequester } from '../../helpers/system-authority.ts'
import { getDeveloperFlagsWorkspaceStore } from '../../operations/developer-flags.ts'

const router = express.Router()

const authorized = (req: Request, res: Response): boolean => {
  res.set('Cache-Control', 'no-store')
  if (getWikiAuth().checkAccess(req.user, ['manage:system'])) return true
  res.status(403).json({ error: 'System administration is required.' })
  return false
}

const failed = (res: Response, error: unknown) => {
  const status = errorStatus(error)
  const expected = status && [400, 403, 409].includes(status)
  return res.status(expected ? status : 503).json({
    error:
      expected && error instanceof Error
        ? error.message
        : 'Developer flag administration is unavailable. Reload to confirm saved settings before another change.'
  })
}

router.get('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getDeveloperFlagsWorkspaceStore().inspect(systemRequester(req)))
  } catch (error) {
    failed(res, error)
  }
})

router.put('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getDeveloperFlagsWorkspaceStore().save(systemRequester(req), req.body))
  } catch (error) {
    failed(res, error)
  }
})

router.post('/workspace/apply', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getDeveloperFlagsWorkspaceStore().apply(systemRequester(req), req.body))
  } catch (error) {
    failed(res, error)
  }
})

export default router
