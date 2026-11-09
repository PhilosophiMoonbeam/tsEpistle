import express from 'express'
import { z } from 'zod'
import { PageLifecyclePreviewRequestSchema, PageLifecycleSaveRequestSchema } from '../../../shared/page-lifecycle.ts'
import { previewPageLifecycle, savePageLifecycle, listPageLifecycleRules, inspectPageLifecycleRule, setPageLifecycleRuleStatus, inspectPageLifecycleProposal, refusePageLifecycleProposal, resumePageLifecycleCycle } from '../../operations/page-lifecycle.ts'
import { governanceBrowserBoundary, governanceContext, governanceEmpty, governanceInput, governancePrivacyHeaders, governanceResponse, governanceUuid } from './governance-http.ts'

const router = express.Router()
const cursorQuery = z.strictObject({ cursor: z.uuid().optional() })
router.use(governancePrivacyHeaders, governanceBrowserBoundary())
router.post('/preview', governanceResponse(req => previewPageLifecycle({ ...governanceContext(req), input: governanceInput(PageLifecyclePreviewRequestSchema, req.body) })))
router.post('/rules', governanceResponse(req => savePageLifecycle({ ...governanceContext(req), input: governanceInput(PageLifecycleSaveRequestSchema, req.body) })))
router.get('/rules', governanceResponse(req => listPageLifecycleRules({ ...governanceContext(req), ...governanceInput(cursorQuery, req.query) })))
router.get('/rules/:id', governanceResponse(req => inspectPageLifecycleRule({ ...governanceContext(req), ruleId: governanceUuid(req.params.id), ...governanceInput(cursorQuery, req.query) })))
router.post('/rules/:id/status', governanceResponse(req => {
  const input = governanceInput(z.strictObject({ expectedRevision: z.number().int().positive().safe(), action: z.enum(['disable', 'cancel']) }), req.body)
  return setPageLifecycleRuleStatus({ ...governanceContext(req), ruleId: governanceUuid(req.params.id), ...input })
}))
router.get('/proposals/:id', governanceResponse(req => {
  governanceEmpty(req.query)
  return inspectPageLifecycleProposal({ ...governanceContext(req), proposalId: governanceUuid(req.params.id) })
}))
router.post('/proposals/:id/refuse', governanceResponse(req => {
  governanceEmpty(req.body)
  return refusePageLifecycleProposal({ ...governanceContext(req), proposalId: governanceUuid(req.params.id) })
}))
router.post('/cycles/:id/resume', governanceResponse(req => {
  governanceEmpty(req.body)
  return resumePageLifecycleCycle({ ...governanceContext(req), cycleId: governanceUuid(req.params.id) })
}))
export default router
