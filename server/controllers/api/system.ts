import express from 'express'
import { type Request, type Response, getWikiAuth } from '../_types.ts'
import { systemRequester } from '../../helpers/system-authority.ts'
import { getExtensionsWorkspaceStore } from '../../operations/extensions-workspace.ts'
import systemOperations from '../../operations/system.ts'
import { getSystemWorkspaceStore } from '../../operations/system-workspace-runtime.ts'

const router = express.Router()

const authorized = (req: Request, res: Response): boolean => {
  res.set('Cache-Control', 'no-store')
  if (getWikiAuth().checkAccess(systemRequester(req).user, ['manage:system'])) return true
  res.status(403).json({ error: 'System administration is required.' })
  return false
}

const summaryAuthorized = (req: Request, res: Response): boolean => {
  if (
    getWikiAuth().checkAccess(systemRequester(req).user, [
      'manage:system',
      'manage:navigation',
      'manage:groups',
      'write:groups',
      'manage:users',
      'write:users',
      'manage:theme',
      'manage:api'
    ])
  )
    return true
  res.status(403).json({ error: 'System administration is required.' })
  return false
}

const retiredUtilities = (replacement: string) => (req: Request, res: Response) => {
  if (!authorized(req, res)) return
  res.status(410).json({ error: `Utilities now uses reviewed workspace operations. Reload Administration or use ${replacement}.` })
}
const retiredDeveloperFlags = (req: Request, res: Response) => {
  if (!authorized(req, res)) return
  res.status(410).json({ error: 'Developer flags now use reviewed workspace operations. Reload Administration or use /_api/developer-flags/workspace.' })
}

router.get('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getSystemWorkspaceStore().inspect(systemRequester(req).user))
  } catch (error) {
    const status = error instanceof Error && 'status' in error ? error.status : undefined
    res.status(status === 403 ? 403 : 503).json({
      error:
        status === 403
          ? 'Current system administration access is required.'
          : 'System observations could not be collected. Check application and database availability, then try again.'
    })
  }
})

router.get('/info', async (req, res, next) => {
  if (!authorized(req, res)) return
  try {
    res.json(await systemOperations.getInfo())
  } catch (error) {
    next(error)
  }
})

router.get('/summary', async (req, res, next) => {
  if (!summaryAuthorized(req, res)) return
  try {
    res.json(await systemOperations.getSummary())
  } catch (error) {
    next(error)
  }
})

router.get('/host', (req, res) => {
  if (!authorized(req, res)) return
  res.json(systemOperations.getHost())
})
router.get('/flags', retiredDeveloperFlags)
router.post('/flags', retiredDeveloperFlags)

router.get('/extensions', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    await getExtensionsWorkspaceStore().inspect(systemRequester(req))
    res.status(410).json({ error: 'Extensions now uses read-only deployment observations. Reload Administration or use /_api/extensions/workspace.' })
  } catch (error) {
    const status = error instanceof Error && 'status' in error ? error.status : undefined
    res
      .status(typeof status === 'number' ? status : 503)
      .json({
        error:
          error instanceof Error && typeof status === 'number'
            ? error.message
            : 'Extension observations are unavailable. Reload to inspect the deployed application image again.'
      })
  }
})

router.get('/telemetry', retiredUtilities('/_api/utilities/workspace'))
router.patch('/telemetry', retiredUtilities('/_api/utilities/workspace'))
router.post('/telemetry/reset-client-id', retiredUtilities('/_api/utilities/workspace'))
router.post('/cache/flush', retiredUtilities('/_api/utilities/workspace'))
router.post('/cache/temp-uploads/flush', retiredUtilities('/_api/utilities/workspace'))
router.post('/content/rebuild-tree', retiredUtilities('/_api/utilities/workspace'))
router.post('/content/migrate-locale', retiredUtilities('/_api/utilities/workspace'))
router.post('/content/purge-history', retiredUtilities('/_api/utilities/workspace'))
router.post('/export', retiredUtilities('/_api/utilities/workspace'))
router.get('/export-status', retiredUtilities('/_api/utilities/workspace'))
router.post('/import-v1/users', retiredUtilities('/_api/utilities/workspace'))

// Rendering has its own page-level administration workspace and does not use the Utilities batch rerender operation.
router.post('/content/render-page', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    await systemOperations.renderPage(req.body?.id)
    res.json({ message: 'Page rendered successfully.' })
  } catch (error) {
    const status = error instanceof Error && 'status' in error ? error.status : undefined
    res
      .status(typeof status === 'number' ? status : 503)
      .json({ error: error instanceof Error && typeof status === 'number' ? error.message : 'Page rendering could not be confirmed.' })
  }
})

router.post('/upgrade', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    await systemOperations.performUpgrade()
    res.json({ message: 'Upgrade has started.' })
  } catch (error) {
    const status = error instanceof Error && 'status' in error ? error.status : undefined
    res
      .status(typeof status === 'number' ? status : 503)
      .json({ error: error instanceof Error && typeof status === 'number' ? error.message : 'Upgrade is unavailable.' })
  }
})

const retiredTls = (req: Request, res: Response) => {
  if (!authorized(req, res)) return
  res.status(410).json({ error: 'HTTPS administration now uses reviewed workspace operations. Reload Administration or use /_api/tls/workspace.' })
}
router.get('/ssl', retiredTls)
router.patch('/ssl/redirection', retiredTls)
router.post('/ssl/renew', retiredTls)

router.post('/check-for-update', async (req, res, next) => {
  if (!authorized(req, res)) return
  if (req.get('X-Requested-With') !== 'XMLHttpRequest') return res.status(400).json({ error: 'X-Requested-With header is required' })
  try {
    res.json(await systemOperations.checkForUpdate())
  } catch (error) {
    next(error)
  }
})

export default router
