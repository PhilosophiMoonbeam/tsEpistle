import express from 'express'
import { getTransportRuntime, type NextFunction, type Request, type Response } from '../_types.ts'
import { createOfflineDraftKeyFrame, resolveOfflineDraftKeyContext, type OfflineDraftKeyRuntime } from '../../helpers/offline-draft-keys.ts'

const router = express.Router()

const requireSameOriginFetchSite = (req: Request, res: Response, next: NextFunction): void => {
  const fetchSite = req.get('sec-fetch-site')
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    res.status(403).json({ error: 'A same-origin request is required.' })
    return
  }
  next()
}

router.post('/draft-key', requireSameOriginFetchSite, async (req, res, next) => {
  try {
    const runtime = getTransportRuntime<OfflineDraftKeyRuntime>()
    const context = await resolveOfflineDraftKeyContext(req, runtime)
    const frame = createOfflineDraftKeyFrame(context, runtime.config.sessionSecret)
    res.set('Content-Type', 'application/octet-stream')
    res.set('Cache-Control', 'private, no-store')
    res.set('Vary', 'Cookie')
    res.status(200).send(frame)
  } catch (error) {
    next(error)
  }
})

export default router
