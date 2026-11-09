import express from 'express'
import { z } from 'zod'
import {
  FeedbackBoardInputSchema, FeedbackCategoryInputSchema, FeedbackSubmitInputSchema,
  FeedbackVoteInputSchema, FeedbackSubscriptionInputSchema, FeedbackTransitionInputSchema,
  FeedbackSetCategoryInputSchema, FeedbackMoveInputSchema, FeedbackDeleteInputSchema, parseFeedbackQueryString
} from '../../../shared/page-feedback.ts'
import {
  listFeedbackBoards, getFeedbackBoard, getFeedbackIdea, listFeedbackIdeas, suggestFeedbackDuplicates,
  submitExistingFeedbackIdea, setFeedbackVote, setFeedbackSubscription, transitionFeedbackIdea,
  getFeedbackRequestReceipt, setFeedbackCategory, configureFeedbackBoard, configureFeedbackCategory,
  moveFeedbackIdea, deleteFeedbackMetadata
} from '../../operations/page-feedback.ts'
import errors from '../../operations/errors.ts'
import { governanceBrowserBoundary, governanceContext, governanceEmpty, governanceInput, governancePrivacyHeaders, governanceResponse, governanceUuid } from './governance-http.ts'

const router = express.Router()
router.use(governancePrivacyHeaders, governanceBrowserBoundary(true))
router.get('/boards', governanceResponse(req => {
  governanceEmpty(req.query)
  return listFeedbackBoards(governanceContext(req))
}))
router.get('/boards/:boardId', governanceResponse(req => {
  let query
  try { query = parseFeedbackQueryString(new URL(req.originalUrl, 'http://localhost').searchParams) }
  catch { throw new errors.ApplicationError('Invalid feedback query.', { code: 'INVALID_INPUT', status: 400 }) }
  return listFeedbackIdeas({ ...governanceContext(req), boardId: governanceUuid(req.params.boardId), query })
}))
router.get('/boards/:boardId/config', governanceResponse(req => {
  governanceEmpty(req.query)
  return getFeedbackBoard({ ...governanceContext(req), boardId: governanceUuid(req.params.boardId) })
}))
router.get('/boards/:boardId/ideas/:ideaId', governanceResponse(req => {
  governanceEmpty(req.query)
  return getFeedbackIdea({ ...governanceContext(req), boardId: governanceUuid(req.params.boardId), ideaId: governanceUuid(req.params.ideaId) })
}))
router.get('/boards/:boardId/duplicates', governanceResponse(req => {
  const query = governanceInput(z.strictObject({ q: z.string().trim().min(1).max(200) }), req.query)
  return suggestFeedbackDuplicates({ ...governanceContext(req), boardId: governanceUuid(req.params.boardId), q: query.q })
}))
router.get('/receipts/:requestId', governanceResponse(req => {
  const query = governanceInput(z.strictObject({ boardId: z.uuid(), ideaId: z.uuid() }), req.query)
  return getFeedbackRequestReceipt({ ...governanceContext(req), ...query, requestId: governanceUuid(req.params.requestId) })
}))
router.post('/boards', governanceResponse(req => configureFeedbackBoard({ ...governanceInput(FeedbackBoardInputSchema, req.body), ...governanceContext(req) })))
router.post('/boards/:boardId/categories', governanceResponse(req => {
  const input = governanceInput(FeedbackCategoryInputSchema, req.body)
  if (input.boardId !== governanceUuid(req.params.boardId)) throw new errors.ApplicationError('The category board does not match the route.', { code: 'INVALID_INPUT', status: 400 })
  return configureFeedbackCategory({ ...input, ...governanceContext(req) })
}))
router.post('/submit', governanceResponse(req => submitExistingFeedbackIdea({ ...governanceInput(FeedbackSubmitInputSchema, req.body), ...governanceContext(req) }), 201))
router.post('/vote', governanceResponse(req => setFeedbackVote({ ...governanceInput(FeedbackVoteInputSchema, req.body), ...governanceContext(req) })))
router.post('/subscription', governanceResponse(req => setFeedbackSubscription({ ...governanceInput(FeedbackSubscriptionInputSchema, req.body), ...governanceContext(req) })))
router.post('/transition', governanceResponse(req => transitionFeedbackIdea({ ...governanceInput(FeedbackTransitionInputSchema, req.body), ...governanceContext(req) })))
router.post('/category', governanceResponse(req => setFeedbackCategory({ ...governanceInput(FeedbackSetCategoryInputSchema, req.body), ...governanceContext(req) })))
router.post('/move', governanceResponse(req => moveFeedbackIdea({ ...governanceInput(FeedbackMoveInputSchema, req.body), ...governanceContext(req) })))
router.post('/delete', governanceResponse(req => deleteFeedbackMetadata({ ...governanceInput(FeedbackDeleteInputSchema, req.body), ...governanceContext(req) })))
export default router
