import express from 'express'
import { z } from 'zod'
import { PageEditLockInputSchema } from '../../../shared/page-edit-lock.ts'
import { getPageEditLock, setPageEditLock } from '../../operations/page-edit-lock.ts'
import { governanceBrowserBoundary, governanceEmpty, governanceInput, governancePrivacyHeaders, governanceResponse } from './governance-http.ts'

const router = express.Router()
const pageIdSchema = z.string().regex(/^[1-9][0-9]*$/).refine(value => Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647)
router.use('/:id/edit-lock', governancePrivacyHeaders, governanceBrowserBoundary())
router.get('/:id/edit-lock', governanceResponse(req => {
  governanceEmpty(req.query)
  return getPageEditLock({ requester: req.user, sessionId: req.sessionID, pageId: Number(governanceInput(pageIdSchema, req.params.id)) })
}))
router.put('/:id/edit-lock', governanceResponse(req => {
  governanceEmpty(req.query)
  return setPageEditLock({ requester: req.user, sessionId: req.sessionID, pageId: Number(governanceInput(pageIdSchema, req.params.id)), input: governanceInput(PageEditLockInputSchema, req.body) })
}))
export default router
