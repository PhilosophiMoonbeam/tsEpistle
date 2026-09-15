import express from 'express'
import { getTransportRuntime, type NextFunction, type Request, type Response } from '../_types.ts'
import { createOfflineDraftKeyFrame, resolveOfflineDraftKeyContext, type OfflineDraftKeyRuntime } from '../../helpers/offline-draft-keys.ts'

export const OFFLINE_DRAFT_KEY_PATH = '/_api/offline/draft-key' as const
export type OfflineDraftKeyPrivacyMiddleware = (req: Request, res: Response, next: NextFunction) => void

/**
 * The delivery layer mounts this at OFFLINE_DRAFT_KEY_PATH before authentication,
 * origin/fetch metadata checks, body parsing, and any other rejection boundary.
 * The route repeats it as a defense for direct router mounts.
 */
export const offlineDraftKeyPrivacyHeaders: OfflineDraftKeyPrivacyMiddleware = (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  const vary = res.get('Vary')
  if (!vary?.split(',').some(value => value.trim().toLowerCase() === 'cookie')) res.append('Vary', 'Cookie')
  next()
}

const router = express.Router()

const requireSameOriginFetchSite = (req: Request, res: Response, next: NextFunction): void => {
  const fetchSite = req.get('sec-fetch-site')
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    res.status(403).json({ error: 'A same-origin request is required.' })
    return
  }
  next()
}

router.post('/draft-key', offlineDraftKeyPrivacyHeaders, requireSameOriginFetchSite, async (req, res, next) => {
  try {
    const runtime = getTransportRuntime<OfflineDraftKeyRuntime>()
    const context = await resolveOfflineDraftKeyContext(req, runtime)
    const frame = createOfflineDraftKeyFrame(context, runtime.config.sessionSecret)
    res.set('Content-Type', 'application/octet-stream')
    res.status(200).send(frame)
  } catch (error) {
    next(error)
  }
})

export default router
