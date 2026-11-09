import express from 'express'
import { isLiveNoteKey } from '../../../shared/live-notes.ts'
import { hedgedocImport } from '../../operations/hedgedoc-import.ts'
import errors from '../../operations/errors.ts'
import { governanceBrowserBoundary, governanceEmpty, governancePrivacyHeaders, governanceResponse } from './governance-http.ts'

const router = express.Router()
router.use(governancePrivacyHeaders, governanceBrowserBoundary())
// The native operation parses the bounded DTO; keep private snapshots out of a second transport copy.
router.post('/review', governanceResponse(req => hedgedocImport.review(req.user, req.body)))
router.post('/execute', governanceResponse(req => hedgedocImport.execute(req.user, req.body)))
router.get('/provenance/:key', governanceResponse(req => {
  governanceEmpty(req.query)
  const key = req.params.key
  if (!isLiveNoteKey(key)) throw new errors.ApplicationError('Invalid live note key.', { code: 'INVALID_INPUT', status: 400 })
  return hedgedocImport.provenance(req.user, key)
}))
export default router
