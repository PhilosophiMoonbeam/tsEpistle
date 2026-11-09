import type { Knex } from 'knex'
import { DurableJobStore } from '../core/durable-jobs.ts'

/** Emits no notification under a canonical mutation's page lock; workers resolve current authority later. */
export const recordPageReviewSourceRevision = async (transaction: Knex.Transaction, input: { pageId: number; sourceRevision: string; observedAt: Date }): Promise<void> => {
  const changed = await transaction('pageReviewRouting').where({ pageId: input.pageId }).whereNot('observedSourceRevision', input.sourceRevision).update({ observedSourceRevision: input.sourceRevision, unverifiedAt: input.observedAt })
  if (!changed) return
  await new DurableJobStore(transaction).enqueue({ type: 'page-review-reminder', version: 1, maxAttempts: 5, payload: { mode: 'reconcile', pageId: input.pageId }, deduplicationKey: `review-source:${input.pageId}:${input.sourceRevision}` })
}
export const recordPageReviewAttestation = async (transaction: Knex.Transaction, input: { pageId: number; sourceRevision: string; attestationId: string; verifiedAt: Date }): Promise<void> => {
  const routing = await transaction('pageReviewRouting').where({ pageId: input.pageId, enabled: true }).first('pageId')
  if (!routing) return
  await new DurableJobStore(transaction).enqueue({ type: 'page-review-reminder', version: 1, maxAttempts: 5, payload: { mode: 'reconcile', pageId: input.pageId }, deduplicationKey: `review-attestation:${input.pageId}:${input.sourceRevision}:${input.attestationId}` })
}
