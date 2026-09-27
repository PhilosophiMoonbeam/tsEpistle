import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { PageLinksRequestSchema } from '../../../shared/page-links.ts'
import { getPageLinks } from '../../operations/page-links.ts'

const router = express.Router()
const allowedQueryKeys: Record<string, true> = { direction: true, cursor: true }

const invalidRequest = (res: Response): void => {
  res.status(400).json({ error: 'Page links request is invalid.' })
}

router.get('/:pageId/links', async (req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'private, no-store')
  res.vary('Cookie')
  const pageIdValue = req.params.pageId
  if (typeof pageIdValue !== 'string' || !/^[1-9][0-9]*$/.test(pageIdValue)) {
    invalidRequest(res)
    return
  }
  const pageId = Number(pageIdValue)
  if (!Number.isSafeInteger(pageId)) {
    invalidRequest(res)
    return
  }
  if (Object.keys(req.query).some(key => !Object.hasOwn(allowedQueryKeys, key))) {
    invalidRequest(res)
    return
  }
  const direction = req.query.direction
  const cursor = req.query.cursor
  const parsed = PageLinksRequestSchema.safeParse({
    pageId,
    direction,
    ...(cursor === undefined ? {} : { cursor })
  })
  if (!parsed.success) {
    invalidRequest(res)
    return
  }
  try {
    const result = await getPageLinks({ ...parsed.data, requester: req.user })
    res.status(result.state === 'refresh' ? 409 : 200).json(result)
  } catch (error) {
    next(error)
  }
})

export default router
