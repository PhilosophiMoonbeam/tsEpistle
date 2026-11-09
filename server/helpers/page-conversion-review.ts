import { createHash, randomBytes } from 'node:crypto'
import errors from '../operations/errors.ts'
import { PAGE_CONVERSION_LIMITS as limits, type ConversionResult } from './page-conversion-protocol.ts'

interface ReviewBinding {
  pageId: number
  sourceRevision: string
  editor: string
  userId: number
  source: string
  sessionBinding?: string
}
interface RetainedReview {
  pageId: number
  sourceRevision: string
  editor: string
  userId: number
  sourceDigest: string
  candidateDigest: string
  candidate: string
  sessionBinding: string
  expiresAt: number
}
export interface PageConversionReview extends ConversionResult {
  reviewToken: string
  pageId: number
  sourceRevision: string
  editor: string
  originalSource: string
  candidateDigest: string
  expiresAt: string
}

const reviews = new Map<string, RetainedReview>()
const digest = (source: string): string => createHash('sha256').update(source, 'utf8').digest('hex')
const purgeExpired = (): void => {
  const now = Date.now()
  for (const [token, review] of reviews) if (review.expiresAt <= now) reviews.delete(token)
}
// Bounded volatile custody deliberately refuses after restart/another server instance. It never
// persists private candidate/source bytes in logs, shared caches or browser-authored commit fields.
const expiry = setInterval(purgeExpired, 30_000)
expiry.unref()

export function retainPageConversionReview(binding: ReviewBinding, result: ConversionResult): PageConversionReview {
  purgeExpired()
  if (reviews.size >= limits.reviews) throw new errors.ApplicationError('Review capacity is full. Wait for an existing review to expire.', { code: 'CONVERSION_REVIEW_BUSY', status: 429 })
  const reviewToken = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + limits.reviewTtlMs
  const candidateDigest = digest(result.candidate)
  reviews.set(reviewToken, {
    pageId: binding.pageId, sourceRevision: binding.sourceRevision, editor: binding.editor,
    userId: binding.userId, sourceDigest: digest(binding.source), candidateDigest,
    candidate: result.candidate, sessionBinding: binding.sessionBinding ?? '', expiresAt
  })
  return { ...result, reviewToken, pageId: binding.pageId, sourceRevision: binding.sourceRevision, editor: binding.editor, originalSource: binding.source, candidateDigest, expiresAt: new Date(expiresAt).toISOString() }
}

/** The model must still reauthorize and revision-fence inside its canonical transaction. */
export function consumePageConversionReview(input: ReviewBinding & { reviewToken: string }): string {
  purgeExpired()
  const review = typeof input.reviewToken === 'string' ? reviews.get(input.reviewToken) : undefined
  if (!review || review.pageId !== input.pageId || review.sourceRevision !== input.sourceRevision || review.editor !== input.editor || review.userId !== input.userId || review.sourceDigest !== digest(input.source) || review.sessionBinding !== (input.sessionBinding ?? '') || review.candidateDigest !== digest(review.candidate)) {
    throw new errors.ApplicationError('Review the current HTML source and conversion options again before confirming.', { code: 'CONVERSION_REVIEW_STALE', status: 409 })
  }
  // One confirmation attempt, including a rejected canonical transaction, retires the review.
  reviews.delete(input.reviewToken)
  return review.candidate
}
