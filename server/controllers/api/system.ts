import express from 'express'
import { type NextFunction, type Request, type Response, getWikiAuth } from '../_types.ts'

import systemOperations from '../../operations/system.ts'
import importV1Operations from '../../operations/import-v1.ts'

const router = express.Router()

const requireSystemAccess = (req: Request, res: Response): boolean => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
    res.sendStatus(403)
    return false
  }
  return true
}

const requireSystemSummaryAccess = (req: Request, res: Response): boolean => {
  if (
    !getWikiAuth().checkAccess(req.user, [
      'manage:system',
      'manage:navigation',
      'manage:groups',
      'write:groups',
      'manage:users',
      'write:users',
      'manage:theme',
      'manage:api'
    ])
  ) {
    res.sendStatus(403)
    return false
  }
  return true
}

const sendError = (res: Response, value: unknown, fallback: string) => {
  const err = value as Error & { status?: number }
  return res.status(err.status || 500).json({ error: err.message || fallback })
}
const forwardError = (res: Response, next: NextFunction, value: unknown) => {
  const err = value as Error & { status?: number }
  return err.status ? res.status(err.status).json({ error: err.message }) : next(err)
}

router.get('/info', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(await systemOperations.getInfo())
  } catch (err) {
    next(err)
  }
})

router.get('/summary', async (req, res, next) => {
  if (!requireSystemSummaryAccess(req, res)) return
  try {
    res.json(await systemOperations.getSummary())
  } catch (err) {
    next(err)
  }
})

router.get('/flags', (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.json(systemOperations.listFlags())
})

router.get('/host', (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.json(systemOperations.getHost())
})

router.get('/extensions', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(await systemOperations.listExtensions())
  } catch (err) {
    next(err)
  }
})

router.get('/telemetry', (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.json(systemOperations.getTelemetry())
})

router.patch('/telemetry', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.setTelemetry(req.body && req.body.enabled)
    res.json({ message: 'Telemetry updated successfully.' })
  } catch (err) {
    forwardError(res, next, err)
  }
})

router.post('/telemetry/reset-client-id', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.resetTelemetryClientId()
    res.json({ message: 'Telemetry Client ID reset successfully.' })
  } catch (err) {
    next(err)
  }
})

router.post('/upgrade', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.performUpgrade()
    res.json({ message: 'Upgrade has started.' })
  } catch (err) {
    sendError(res, err, 'Upgrade failed')
  }
})

router.post('/cache/flush', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.flushPageCache()
    res.json({ message: 'Cache flushed successfully.' })
  } catch (err) {
    sendError(res, err, 'Cache flush failed')
  }
})

router.post('/cache/temp-uploads/flush', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.flushTemporaryUploads()
    res.json({ message: 'Temporary Uploads flushed successfully.' })
  } catch (err) {
    sendError(res, err, 'Temporary Uploads flush failed')
  }
})

router.post('/content/rebuild-tree', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.rebuildPageTree()
    res.json({ message: 'Page tree rebuilt successfully.' })
  } catch (err) {
    sendError(res, err, 'Page tree rebuild failed')
  }
})

router.post('/content/migrate-locale', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const count = await systemOperations.migratePagesToLocale({ ...(req.body || {}), requester: req.user })
    res.json({ message: 'Migrated content to target locale successfully.', count })
  } catch (err) {
    sendError(res, err, 'Locale migration failed')
  }
})

router.post('/content/render-page', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.renderPage(req.body && req.body.id)
    res.json({ message: 'Page rendered successfully.' })
  } catch (err) {
    sendError(res, err, 'Page render failed')
  }
})

router.post('/content/purge-history', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.purgePageHistory(req.body && req.body.olderThan)
    res.json({ message: 'Page history purged successfully.' })
  } catch (err) {
    sendError(res, err, 'Page history purge failed')
  }
})

router.post('/export', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.startExport({
      entities: req.body && req.body.entities,
      exportPath: req.body && req.body.path
    })
    res.json({ message: 'Export started successfully.' })
  } catch (err) {
    sendError(res, err, 'Export failed')
  }
})

router.get('/export-status', (req, res) => {
  if (!requireSystemAccess(req, res)) return
  if (typeof res.set === 'function') res.set('Cache-Control', 'no-store')
  res.json(systemOperations.getExportStatus())
})

router.get('/ssl', (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.json(systemOperations.getSsl())
})

router.patch('/ssl/redirection', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.setSslRedirection(req.body && req.body.enabled)
    res.json({ message: 'HTTP Redirection state set successfully.' })
  } catch (err) {
    sendError(res, err, 'HTTP Redirection update failed')
  }
})

router.post('/ssl/renew', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.renewSslCertificate()
    res.json({ message: 'SSL Certificate renewed successfully.' })
  } catch (err) {
    sendError(res, err, 'SSL Certificate renewal failed')
  }
})

router.post('/flags', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await systemOperations.updateFlags(req.body && req.body.flags)
    res.json({ message: 'System flags applied successfully.' })
  } catch (err) {
    forwardError(res, next, err)
  }
})

router.post('/import-v1/users', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(
      await importV1Operations.importUsers({
        mongoDbConnString: req.body && req.body.mongoDbConnString,
        groupMode: req.body && req.body.groupMode
      })
    )
  } catch (err) {
    sendError(res, err, 'Wiki.js 1.x user import failed')
  }
})

router.post('/check-for-update', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  if (req.get('X-Requested-With') !== 'XMLHttpRequest') {
    return res.status(400).json({ error: 'X-Requested-With header is required' })
  }
  try {
    res.json(await systemOperations.checkForUpdate())
  } catch (err) {
    next(err)
  }
})

export default router
