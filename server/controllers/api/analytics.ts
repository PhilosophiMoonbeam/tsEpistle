import express from 'express'
import { errorStatus, objectValue, type Request, type Response, wikiAuth } from '../_types.ts'
import _ from 'lodash'

import analyticsOperations from '../../operations/analytics.ts'

const router = express.Router()


const requireSystemAccess = (req: Request, res: Response, json = false): boolean => { if (!wikiAuth.checkAccess(req.user, ['manage:system'])) {
  if (json) res.status(403).json({ error: 'Forbidden' })
  else res.sendStatus(403)
  return false
}
return true }

const parseIsEnabled = (value: unknown): boolean | undefined => value === 'true' ? true : value === 'false' ? false : undefined

router.get('/providers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const providers = await analyticsOperations.listProviders(parseIsEnabled(_.get(req, 'query.isEnabled')))
    res.json(providers.map(provider => ({
      isEnabled: provider.isEnabled,
      key: provider.key,
      title: provider.title,
      description: provider.description,
      isAvailable: provider.isAvailable,
      logo: provider.logo,
      website: provider.website,
      config: provider.config
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/providers', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    await analyticsOperations.updateProviders(objectValue(req.body, 'providers'))
    res.json({ message: 'Providers updated successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(errorStatus(err) ?? 500).json({ error: message || 'Providers update failed' })
  }
})

export default router
