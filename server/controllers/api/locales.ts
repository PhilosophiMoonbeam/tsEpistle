import { getLocaleAdministrationStore } from '../../operations/locale-administration.ts'
import express from 'express'
import multer from 'multer'
import { errorStatus, objectValue, type NextFunction, type Request, type Response, getWikiAuth } from '../_types.ts'
import localizationOperations from '../../operations/localization.ts'
import { MAX_LOCALE_FILE_BYTES } from '../../../shared/locale-policy.ts'

const router = express.Router()


const requireSystemAccess = (req: Request, res: Response): boolean => { res.set('Cache-Control', 'no-store'); if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
  res.status(403).json({ error: 'manage:system is required' })
  return false
}

return true }

const localeError = (res: Response, error: unknown) => {
  const status = errorStatus(error), expected = status && [400, 403, 409].includes(status)
  return res.status(expected ? status : 500).json({ error: expected && error instanceof Error ? error.message : 'Locale administration is temporarily unavailable. Reload to confirm the saved state.' })
}
const LOCAL_LOCALE_FILE_LIMIT = MAX_LOCALE_FILE_BYTES
const parseLocalLocaleFile = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: LOCAL_LOCALE_FILE_LIMIT,
    files: 1,
    fields: 3,
    parts: 5,
    fieldNameSize: 32,
    fieldSize: 8 * 1024,
    headerPairs: 32
  }
}).single('file')

const requireSystemAccessMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  if (requireSystemAccess(req, res)) next()
}

const acceptLocalLocaleFile = (req: Request, res: Response, next: NextFunction): void => {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    res.status(400).json({ error: 'Locale file review must use multipart/form-data.' })
    return
  }

  parseLocalLocaleFile(req, res, error => {
    if (error) {
      if (error instanceof multer.MulterError && ['LIMIT_FILE_SIZE', 'LIMIT_FIELD_VALUE'].includes(error.code)) {
        res.status(413).json({ error: 'Locale review upload exceeds the supported size limit.' })
      } else {
        res.status(400).json({ error: 'Locale review upload must contain exactly one file and the fields code, fingerprint, and reason.' })
      }
      return
    }

    const body = req.body as Record<string, unknown> | undefined
    const keys = body ? Object.keys(body) : []
    const file = req.file
    if (
      keys.length !== 3 ||
      keys.some(key => !['code', 'fingerprint', 'reason'].includes(key)) ||
      !['code', 'fingerprint', 'reason'].every(key => typeof body?.[key] === 'string' && (body[key] as string).trim().length > 0) ||
      !file ||
      !Buffer.isBuffer(file.buffer) ||
      file.buffer.byteLength === 0
    ) {
      res.status(400).json({ error: 'Locale review upload must contain exactly one non-empty file and the fields code, fingerprint, and reason.' })
      return
    }
    next()
  })
}

router.post('/workspace/local-files/review', requireSystemAccessMiddleware, acceptLocalLocaleFile, async (req, res) => {
  try {
    const fields = req.body as { code: string; fingerprint: string; reason: string }
    const result = await getLocaleAdministrationStore().reviewLocalFile(req.user, {
      code: fields.code,
      fingerprint: fields.fingerprint,
      reason: fields.reason,
      bytes: req.file!.buffer
    })
    res.status(201).json(result)
  } catch (error) {
    localeError(res, error)
  }
})

router.post('/workspace/local-files/:reviewId/commit', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  const reviewId = req.params?.reviewId
  if (typeof reviewId !== 'string' || !reviewId.trim()) {
    res.status(400).json({ error: 'A locale file review ID is required.' })
    return
  }
  try {
    res.status(202).json(await getLocaleAdministrationStore().enqueueLocalFile(req.user, { reviewId }))
  } catch (error) {
    localeError(res, error)
  }
})

router.get('/workspace', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try { res.json(await getLocaleAdministrationStore().inspect(req.user)) } catch (error) { localeError(res, error) }
})
router.put('/workspace', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try { res.json(await getLocaleAdministrationStore().save(req.user, { policy: objectValue(req.body, 'policy'), fingerprint: objectValue(req.body, 'fingerprint'), reason: objectValue(req.body, 'reason') })) } catch (error) { localeError(res, error) }
})
router.post('/workspace/activate', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try { res.json(await getLocaleAdministrationStore().initialize(req.user, objectValue(req.body, 'fingerprint'))) } catch (error) { localeError(res, error) }
})
router.post('/workspace/operations', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try { res.status(202).json(await getLocaleAdministrationStore().enqueue(req.user, { kind: objectValue(req.body, 'kind'), code: objectValue(req.body, 'code'), fingerprint: objectValue(req.body, 'fingerprint'), reason: objectValue(req.body, 'reason') })) } catch (error) { localeError(res, error) }
})

router.get('/', async (req, res, next) => {
  try {
    res.json(await localizationOperations.listLocales())
  } catch (err) {
    next(err)
  }
})

router.get('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try { return res.json((await getLocaleAdministrationStore().inspect(req.user)).policy) } catch (error) { return localeError(res, error) }
})

router.post('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await localizationOperations.updateConfig(req.body, req.user)
    return res.json({ message: 'Locale config updated' })
  } catch (err) {
    return localeError(res, err)
  }
})

router.post('/:code/download', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    const result = await localizationOperations.download(req.params && req.params.code, req.user)
    return res.status(202).json({ ...result, message: 'Language package installation queued. Inspect the Locale workspace for its result.' })
  } catch (err) {
    return localeError(res, err)
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
