import express from 'express'
import { errorStatus, type Request, type Response, wikiAuth } from '../_types.ts'
import localizationOperations from '../../operations/localization.ts'

const router = express.Router()


const requireSystemAccess = (req: Request, res: Response): boolean => { if (!wikiAuth.checkAccess(req.user, ['manage:system'])) {
  res.status(403).json({ error: 'manage:system is required' })
  return false
}

return true }

router.get('/', async (req, res, next) => {
  try {
    res.json(await localizationOperations.listLocales())
  } catch (err) {
    next(err)
  }
})

router.get('/config', (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  return res.json(localizationOperations.getConfig())
})

router.post('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await localizationOperations.updateConfig(req.body)
    return res.json({ message: 'Locale config updated' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return res.status(errorStatus(err) ?? 500).json({ error: message || 'Locale config update failed' })
  }
})

router.post('/:code/download', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await localizationOperations.download(req.params && req.params.code)
    return res.json({ message: 'Locale downloaded successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return res.status(errorStatus(err) ?? 500).json({ error: message || 'Locale download failed' })
  }
})

router.get('/:code/strings', async (req, res) => {
  const namespace = req.query.namespace
  if (typeof namespace !== 'string' || namespace.length < 1) {
    return res.status(400).json({ error: 'namespace query parameter is required' })
  }

  try {
    return res.json(await localizationOperations.getTranslations({
      locale: req.params.code,
      namespace
    }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return res.status(404).json({ error: message })
  }
})

export default router
