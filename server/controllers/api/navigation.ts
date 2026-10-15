import express from 'express'
import { errorStatus, objectValue, type Request, type Response, getWikiAuth } from '../_types.ts'
import navigationOperations from '../../operations/navigation.ts'
import { getNavigationAdministrationStore } from '../../operations/navigation-administration.ts'
const router = express.Router()
const requireNavigationAccess = (req: Request, res: Response): boolean => {
  res.set('Cache-Control', 'no-store')
  if (!getWikiAuth().checkAccess(req.user, ['manage:navigation', 'manage:system'])) {
    res.status(403).json({ error: 'Navigation administration is required.' })
    return false
  }
  return true
}
const navigationError = (res: Response, error: unknown) => {
  const status = errorStatus(error),
    expected = status && [400, 403, 409].includes(status)
  res.status(expected ? status : 500).json({
    error: expected && error instanceof Error ? error.message : 'Navigation administration is temporarily unavailable. Reload to confirm saved settings.'
  })
}
router.get('/', async (req, res) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    res.json(await navigationOperations.get(req.user))
  } catch (error) {
    navigationError(res, error)
  }
})
router.put('/', async (req, res) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    await navigationOperations.update(req.body, req.user)
    res.json({ message: 'Navigation saved successfully.' })
  } catch (error) {
    navigationError(res, error)
  }
})
router.get('/workspace', async (req, res) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    res.json(await getNavigationAdministrationStore().inspect(req.user))
  } catch (error) {
    navigationError(res, error)
  }
})
router.put('/workspace', async (req, res) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    res.json(
      await getNavigationAdministrationStore().save(req.user, {
        policy: objectValue(req.body, 'policy'),
        fingerprint: objectValue(req.body, 'fingerprint'),
        reason: objectValue(req.body, 'reason')
      })
    )
  } catch (error) {
    navigationError(res, error)
  }
})
router.post('/workspace/move-review', async (req, res) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    res.json(await getNavigationAdministrationStore().inspectMovedPage(req.user, req.body))
  } catch (error) {
    navigationError(res, error)
  }
})
router.post('/workspace/move-repair', async (req, res) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    res.json(await getNavigationAdministrationStore().repairMovedPage(req.user, req.body))
  } catch (error) {
    navigationError(res, error)
  }
})
router.post('/workspace/activate', async (req, res) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    res.json(await getNavigationAdministrationStore().initialize(req.user, objectValue(req.body, 'fingerprint')))
  } catch (error) {
    navigationError(res, error)
  }
})
export default router
