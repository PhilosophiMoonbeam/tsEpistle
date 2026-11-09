import express from 'express'
import type { Knex } from 'knex'
import { z } from 'zod'
import { listOwnGovernedNotificationReceipts, resendOwnGovernedNotification } from '../../jobs/governed-notifications.ts'
import { getTransportRuntime, type Request } from '../_types.ts'
import { governanceBrowserBoundary, governanceEmpty, governanceInput, governancePrivacyHeaders, governanceResponse, governanceUuid } from './governance-http.ts'

const router = express.Router()
const context = (req: Request) => ({ knex: getTransportRuntime<{ models: { knex: Knex } }>().models.knex, requester: req.user!, sessionId: req.sessionID })
router.use(governancePrivacyHeaders, governanceBrowserBoundary())
router.get('/', governanceResponse(req => {
  governanceEmpty(req.query)
  return listOwnGovernedNotificationReceipts(context(req))
}))
router.post('/:id/resend', governanceResponse(req => {
  const input = governanceInput(z.strictObject({ acknowledged: z.literal(true) }), req.body)
  return resendOwnGovernedNotification({ ...context(req), id: governanceUuid(req.params.id), ...input })
}))
export default router
