import express from 'express'
import { z } from 'zod'
import type { Knex } from 'knex'
import { PageReviewCommandSchema, PageReviewPreviewSchema } from '../../../shared/page-review-routing.ts'
import { readPageReviewRouting, previewPageReviewRouting, updatePageReviewRouting } from '../../operations/page-review-routing.ts'
import { isApiPrincipal } from '../../helpers/api-principal.ts'
import { getTransportRuntime, type Request } from '../_types.ts'
import { governanceBrowserBoundary, governanceEmpty, governanceInput, governancePrivacyHeaders, governanceResponse } from './governance-http.ts'

const router = express.Router()
const context = (req: Request) => ({
  knex: getTransportRuntime<{ models: { knex: Knex } }>().models.knex,
  requester: req.user, sessionId: req.sessionID, delegated: isApiPrincipal(req.user),
  pageId: Number(governanceInput(z.string().regex(/^[1-9][0-9]*$/).refine(value => Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647), req.params.id))
})
router.use('/:id/review-routing', governancePrivacyHeaders, governanceBrowserBoundary())
router.get('/:id/review-routing', governanceResponse(req => {
  governanceEmpty(req.query)
  return readPageReviewRouting(context(req))
}))
router.post('/:id/review-routing/preview', governanceResponse(req => previewPageReviewRouting({ ...context(req), preview: governanceInput(PageReviewPreviewSchema, req.body) })))
router.put('/:id/review-routing', governanceResponse(req => updatePageReviewRouting({ ...context(req), mutation: governanceInput(PageReviewCommandSchema, req.body) })))
export default router
