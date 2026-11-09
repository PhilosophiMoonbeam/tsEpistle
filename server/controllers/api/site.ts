import express from 'express'
import { type Request, type Response, getTransportRuntime, getWikiAuth } from '../_types.ts'
import type { Knex } from 'knex'

import siteOperations from '../../operations/site.ts'
import { getGeneralAdministrationStore } from '../../operations/general-administration.ts'
import { getSecurityAdministrationStore } from '../../operations/security-administration.ts'
import { getNotificationSettings, updateNotificationSettings } from '../../operations/notification-settings.ts'
import { errorStatus, objectValue } from '../_types.ts'

const router = express.Router()

const requireSystemAccess = (req: Request, res: Response): boolean => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }
  return true
}

router.get('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(siteOperations.getConfig())
  } catch (err) {
    res.status(500).json({ error: 'Site configuration fetch failed' })
  }
})

router.put('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const body: unknown = req.body
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'Site configuration must be an object' })
    }
    await siteOperations.updateConfig(body, req.user)
    res.json({ message: 'Site configuration updated successfully' })
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : 500
    const message = [400, 403, 409].includes(status) && err instanceof Error ? err.message : 'Site configuration update failed'
    const code = err instanceof Error && err.name === 'MANAGED_LOGO_CONFLICT' ? 'MANAGED_LOGO_CONFLICT' : null
    res.status(status).json(code === null ? { error: message || 'Site configuration update failed' } : { error: message, code })
  }
})

const securityError = (res: Response, error: unknown) => {
  const status = errorStatus(error),
    expected = status && [400, 403, 409].includes(status)
  res
    .status(expected ? status : 500)
    .json({ error: expected && error instanceof Error ? error.message : 'Security administration is temporarily unavailable.' })
}
router.get('/security', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.set('Cache-Control', 'no-store')
  try {
    res.json(await getSecurityAdministrationStore().inspect(req.user))
  } catch (error) {
    securityError(res, error)
  }
})
router.put('/security', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.set('Cache-Control', 'no-store')
  try {
    res.json(
      await getSecurityAdministrationStore().save(req.user, {
        policy: objectValue(req.body, 'policy'),
        fingerprint: objectValue(req.body, 'fingerprint'),
        reason: objectValue(req.body, 'reason'),
        endSessions: objectValue(req.body, 'endSessions')
      })
    )
  } catch (error) {
    securityError(res, error)
  }
})
router.post('/security/activate', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.set('Cache-Control', 'no-store')
  try {
    res.json(await getSecurityAdministrationStore().initialize(req.user, objectValue(req.body, 'fingerprint')))
  } catch (error) {
    securityError(res, error)
  }
})
const generalError = (res: Response, error: unknown) => {
  const status = errorStatus(error),
    expected = status && [400, 403, 409].includes(status)
  res
    .status(expected ? status : 500)
    .json({ error: expected && error instanceof Error ? error.message : 'General administration is temporarily unavailable.' })
}
router.get('/general', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.set('Cache-Control', 'no-store')
  try {
    res.json(await getGeneralAdministrationStore().inspect(req.user))
  } catch (error) {
    generalError(res, error)
  }
})
router.put('/general', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.set('Cache-Control', 'no-store')
  try {
    res.json(
      await getGeneralAdministrationStore().save(req.user, {
        policy: objectValue(req.body, 'policy'),
        fingerprint: objectValue(req.body, 'fingerprint'),
        reason: objectValue(req.body, 'reason')
      })
    )
  } catch (error) {
    generalError(res, error)
  }
})
router.post('/general/activate', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.set('Cache-Control', 'no-store')
  try {
    res.json(await getGeneralAdministrationStore().initialize(req.user, objectValue(req.body, 'fingerprint')))
  } catch (error) {
    generalError(res, error)
  }
})
const notificationError = (res: Response, error: unknown) => {
  const status = errorStatus(error),
    expected = status && [400, 403, 409].includes(status)
  res
    .status(expected ? status : 500)
    .json({ error: expected && error instanceof Error ? error.message : 'Notification settings are temporarily unavailable.' })
}
router.get('/notification-settings', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(await getNotificationSettings(getTransportRuntime<{ models: { knex: Knex } }>().models.knex, req.user))
  } catch (error) {
    notificationError(res, error)
  }
})
router.put('/notification-settings', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(await updateNotificationSettings(getTransportRuntime<{ models: { knex: Knex } }>().models.knex, req.user, req.body))
  } catch (error) {
    notificationError(res, error)
  }
})
export default router
