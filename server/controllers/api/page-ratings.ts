import express from 'express'
import { errorStatus, type NextFunction, type Request, type Response } from '../_types.ts'
import pageRatingOperations from '../../operations/page-ratings.ts'

const router = express.Router()
const MAX_PAGE_ID = 2_147_483_647

const pageIdParam = (req: Request, res: Response): number | null => {
  const raw = req.params.pageId
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/u.test(raw)) {
    res.status(400).json({ error: 'Choose a valid page.' })
    return null
  }
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id > MAX_PAGE_ID) {
    res.status(400).json({ error: 'Choose a valid page.' })
    return null
  }
  return id
}

const fail = (error: unknown, res: Response, next: NextFunction): void => {
  const status = errorStatus(error)
  if (status !== undefined && status >= 400 && status < 500) {
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) })
    return
  }
  next(error)
}

router.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  res.vary('Cookie')
  next()
})

router.get('/:pageId', async (req, res, next) => {
  const pageId = pageIdParam(req, res)
  if (pageId === null) return
  try {
    res.json(await pageRatingOperations.getPageRating({ requester: req.user, pageId, sessionId: req.sessionID }))
  } catch (error) {
    fail(error, res, next)
  }
})

router.put('/:pageId', async (req, res, next) => {
  const pageId = pageIdParam(req, res)
  if (pageId === null) return
  try {
    res.json(await pageRatingOperations.putPageRating({ requester: req.user, pageId, sessionId: req.sessionID, vote: req.body }))
  } catch (error) {
    fail(error, res, next)
  }
})

router.delete('/:pageId', async (req, res, next) => {
  const pageId = pageIdParam(req, res)
  if (pageId === null) return
  try {
    res.json(await pageRatingOperations.removePageRating({ requester: req.user, pageId, sessionId: req.sessionID }))
  } catch (error) {
    fail(error, res, next)
  }
})

export default router
