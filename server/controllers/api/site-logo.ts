import express from 'express'
import multer from 'multer'
import { type NextFunction, type Request, type Response, getWikiAuth } from '../_types.ts'

import {
  SITE_LOGO_SOURCE_LIMIT,
  SiteLogoOperationError,
  getSiteLogoStatus,
  retrySiteLogoCandidate,
  uploadSiteLogoCandidate
} from '../../operations/site-logo.ts'

const router = express.Router()
export const siteLogoPreBodyRouter = express.Router()

const requireSystemAccess = (req: Request, res: Response, next: NextFunction): void => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  next()
}

const parseImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    // Busboy marks a file truncated when its size reaches (not exceeds) this limit.
    fileSize: SITE_LOGO_SOURCE_LIMIT + 1,
    files: 1,
    fields: 0,
    // Busboy counts the closing boundary when enforcing the part limit.
    parts: 2
  }
}).single('image')

const sendKnownError = (error: unknown, res: Response): boolean => {
  if (error instanceof SiteLogoOperationError) {
    res.status(error.status).json({ error: error.message, code: error.code })
    return true
  }
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Logo image exceeds 5,242,880 bytes.', code: 'IMAGE_TOO_LARGE' })
    } else {
      res.status(400).json({ error: 'Exactly one image file is required.', code: 'INVALID_IMAGE' })
    }
    return true
  }
  return false
}

const acceptMultipartImage = (req: Request, res: Response, next: NextFunction): void => {
  parseImage(req, res, error => {
    if (error && sendKnownError(error, res)) return
    if (error) return next(error)
    if (!req.file || !Buffer.isBuffer(req.file.buffer) || req.file.buffer.byteLength === 0) {
      res.status(400).json({ error: 'Exactly one non-empty image file is required.', code: 'INVALID_IMAGE' })
      return
    }
    next()
  })
}

const requesterId = (req: Request): number | null => {
  const id = req.user?.id
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null
}

router.get('/', requireSystemAccess, async (_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  try {
    res.json(await getSiteLogoStatus())
  } catch (error) {
    if (!sendKnownError(error, res)) next(error)
  }
})

siteLogoPreBodyRouter.post('/', requireSystemAccess, acceptMultipartImage, async (req, res, next) => {
  try {
    const result = await uploadSiteLogoCandidate(req.file!.buffer, requesterId(req))
    res.status(result.statusCode).json(result.status)
  } catch (error) {
    if (!sendKnownError(error, res)) next(error)
  }
})

siteLogoPreBodyRouter.post('/retry', requireSystemAccess, async (req, res, next) => {
  try {
    const result = await retrySiteLogoCandidate(requesterId(req))
    res.status(result.statusCode).json(result.status)
  } catch (error) {
    if (!sendKnownError(error, res)) next(error)
  }
})

export default router
