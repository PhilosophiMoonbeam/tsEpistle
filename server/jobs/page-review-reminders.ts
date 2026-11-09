import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import { REVIEW_AUDIENCE_WINDOW_MS, REVIEW_DAY_MS } from '../../shared/page-review-routing.ts'
import { DurableJobStore, type DurableJob, type DurableJobHandler } from '../core/durable-jobs.ts'
import { resolvePageReviewRecipients, readReviewClock, reviewDatabaseNow, type ReviewRoutingRow } from '../operations/page-review-routing.ts'

const payloadSchema = z.strictObject({ cycleId: z.uuid(), pageId: z.number().int().positive(), routingRevision: z.string().regex(/^[1-9][0-9]*$/), sourceRevision: z.string().regex(/^[1-9][0-9]*$/), scheduleGeneration: z.string().regex(/^[1-9][0-9]*$/) })
interface ReviewCycle { id: string; pageId: number; scheduleGeneration: string; epochKey: string; milestone: string; cycleNo: string | number | null; dueAt: Date | string; sourceRevision: string; status: string; createdAt: Date | string }
export interface ReviewNotificationEffect {
  origin: 'scheduled'; category: 'reviewReminder'; eventId: string; cycleId: string; pageId: number; userId: number; sourceRevision: string; milestone: string; dueAt: string; admittedAt: string
  jobFence: { id: string; owner: string; token: string; type: 'page-review-reminder'; version: 1 }
}
/** The governed adapter owns current inbox metadata/projections and mail templates, not review identity or receipts. */
export interface PageReviewNotificationAdapter {
  deliverInApp(transaction: Knex.Transaction, effect: ReviewNotificationEffect): Promise<boolean>
  /** Retry is legal only with affirmative proof that no external handoff occurred. Throwing is ambiguous. */
  sendEmail(transaction: Knex.Transaction, effect: ReviewNotificationEffect & { messageId: string }): Promise<'sent' | 'suppressed' | 'retry-before-handoff'>
}

export const producePageReviewReminder = async ({ transaction, pageId }: { transaction: Knex.Transaction; pageId: number }): Promise<void> => {
  const observed = await transaction('pages').where('id', pageId).first('sourceRevision')
  if (!observed) return
  const resolution = await resolvePageReviewRecipients({ transaction, pageId, sourceRevision: String(observed.sourceRevision) })
  const page = await transaction('pages').where('id', pageId).forUpdate().first('sourceRevision')
  const routing = await transaction<ReviewRoutingRow>('pageReviewRouting').where({ pageId }).forUpdate().first()
  if (!page || !routing || !routing.enabled || String(page.sourceRevision) !== String(observed.sourceRevision)) return
  const now = await reviewDatabaseNow(transaction)
  if (String(routing.observedSourceRevision) !== String(page.sourceRevision)) {
    routing.observedSourceRevision = String(page.sourceRevision); routing.unverifiedAt = now
    await transaction('pageReviewRouting').where({ pageId }).update({ observedSourceRevision: routing.observedSourceRevision, unverifiedAt: now })
  }
  const clock = await readReviewClock(transaction, routing, String(page.sourceRevision), now)
  if (!clock.due) return
  const due = clock.due
  const identity = { pageId, scheduleGeneration: routing.scheduleGeneration, epochKey: due.epochKey, milestone: due.milestone }
  let cycle = await transaction<ReviewCycle>('pageReviewCycles').where(identity).first()
  const firstAdmission = !cycle
  if (!cycle) {
    const consumed = await transaction('pageReviewConsumed').where({ pageId, scheduleGeneration: routing.scheduleGeneration, epochKey: due.epochKey, milestone: routing.scheduleMode === 'independent' ? 'independent' : due.milestone }).first()
    if (consumed && (due.cycleNo === null || Number(consumed.highWater) >= due.cycleNo)) return
    cycle = { ...identity, id: randomUUID(), cycleNo: due.cycleNo, dueAt: new Date(due.dueAt), sourceRevision: String(page.sourceRevision), status: resolution.status === 'eligible' ? 'queued' : 'suppressed', createdAt: now }
    await transaction('pageReviewCycles').insert({ ...cycle, coalescedThrough: due.coalescedThrough })
    await transaction('pageReviewConsumed').insert({ pageId, scheduleGeneration: routing.scheduleGeneration, epochKey: due.epochKey, milestone: routing.scheduleMode === 'independent' ? 'independent' : due.milestone, highWater: due.cycleNo, updatedAt: now }).onConflict(['pageId', 'scheduleGeneration', 'epochKey', 'milestone']).merge(['highWater', 'updatedAt'])
    if (due.milestone === 'needs-verification') {
      await transaction('pageReviewConsumed').insert({ pageId, scheduleGeneration: routing.scheduleGeneration, epochKey: due.epochKey, milestone: 'review-soon', highWater: null, updatedAt: now }).onConflict(['pageId', 'scheduleGeneration', 'epochKey', 'milestone']).ignore()
      await transaction('pageReviewCycles').insert({ ...cycle, id: randomUUID(), milestone: 'review-soon', dueAt: new Date(due.dueAt - 60 * REVIEW_DAY_MS - 1), status: 'coalesced', coalescedThrough: null }).onConflict(['pageId', 'scheduleGeneration', 'epochKey', 'milestone']).ignore()
    }
    if (routing.scheduleMode === 'independent' || due.milestone === 'needs-verification') {
      await transaction('pageReviewCycles').where({ pageId, scheduleGeneration: routing.scheduleGeneration, epochKey: due.epochKey }).whereNot('id', cycle.id).whereIn('status', ['queued', 'suppressed'])
        .whereNotExists(transaction('pageReviewChannelReceipts').select(transaction.raw('1')).whereRaw('?? = ??', ['pageReviewChannelReceipts.cycleId', 'pageReviewCycles.id']).whereIn('status', ['sent', 'delivered', 'unknown', 'sending'])).update({ status: 'coalesced' })
    }
    // Superseded pending work cannot revive a prior milestone/epoch.
    await transaction('pageReviewCycles').where({ pageId, scheduleGeneration: routing.scheduleGeneration }).whereNot('id', cycle.id).whereIn('status', ['queued', 'suppressed']).update({ status: 'superseded' })
  }
  if (cycle.status === 'superseded' || cycle.status === 'coalesced') return
  if (routing.scheduleMode === 'independent' && String(cycle.sourceRevision) !== String(page.sourceRevision)) {
    cycle.sourceRevision = String(page.sourceRevision)
    await transaction('pageReviewCycles').where('id', cycle.id).update({ sourceRevision: cycle.sourceRevision })
  }
  const allowExpansion = firstAdmission || now.valueOf() - new Date(cycle.dueAt).valueOf() <= REVIEW_AUDIENCE_WINDOW_MS
  let addedRecipients = false
  for (const recipient of allowExpansion ? resolution.recipients : []) {
    for (const channel of ['in-app', 'email'] as const) {
      if (!(channel === 'email' ? recipient.emailEnabled : recipient.inAppEnabled)) continue
      const inserted = await transaction('pageReviewChannelReceipts').insert({ id: randomUUID(), cycleId: cycle.id, userId: recipient.userId, channel, status: 'pending', consentAtAdmission: true, attempt: 0, messageId: null, safeFailureReason: null, createdAt: now, updatedAt: now, acknowledgedAt: null }).onConflict(['cycleId', 'userId', 'channel']).ignore().returning('id')
      if (inserted.length) addedRecipients = true
    }
  }
  if (addedRecipients) await transaction('pageReviewCycles').where('id', cycle.id).increment('audienceRevision', 1)
  const audience = await transaction('pageReviewCycles').where('id', cycle.id).first('audienceRevision')
  await new DurableJobStore(transaction).enqueue({ type: 'page-review-reminder', version: 1, payload: { cycleId: cycle.id, pageId, routingRevision: String(routing.revision), sourceRevision: String(page.sourceRevision), scheduleGeneration: String(routing.scheduleGeneration) }, maxAttempts: 5, deduplicationKey: `review:${pageId}:${routing.scheduleGeneration}:${due.epochKey}:${due.milestone}:route:${routing.revision}:source:${page.sourceRevision}:audience:${audience.audienceRevision}` })
}
/** Bounded minute producer, fairly rotating even pages with no current due milestone. */
export const scanPageReviewReminders = async (knex: Knex, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted()
  const rows = await knex('pageReviewRouting').where({ enabled: true }).orderBy('lastScannedAt').orderBy('pageId').limit(100).select('pageId')
  let firstFailure: unknown
  for (const row of rows) {
    signal?.throwIfAborted()
    try {
      await knex.transaction(async transaction => {
        await producePageReviewReminder({ transaction, pageId: Number(row.pageId) })
        await transaction('pageReviewRouting').where('pageId', row.pageId).update({ lastScannedAt: await reviewDatabaseNow(transaction) })
      })
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted()
      firstFailure ??= error
    }
  }
  if (firstFailure !== undefined) throw firstFailure
}
const effectAdmission = async (transaction: Knex.Transaction, job: DurableJob) => {
  const payload = payloadSchema.parse(job.payload)
  const resolution = await resolvePageReviewRecipients({ transaction, pageId: payload.pageId, sourceRevision: payload.sourceRevision })
  const routing = await transaction<ReviewRoutingRow>('pageReviewRouting').where({ pageId: payload.pageId }).forUpdate().first()
  const cycle = await transaction<ReviewCycle>('pageReviewCycles').where('id', payload.cycleId).forUpdate().first()
  const actual = await transaction('durableJobs').where({ id: job.id, state: 'running', type: 'page-review-reminder', version: 1, leaseOwner: job.leaseOwner, leaseToken: job.leaseToken }).forUpdate().first('leaseExpiresAt')
  const now = await reviewDatabaseNow(transaction)
  if (!actual || !job.leaseOwner || !job.leaseToken || new Date(actual.leaseExpiresAt).valueOf() <= now.valueOf()) return null
  if (!routing || !routing.enabled || String(routing.revision) !== payload.routingRevision || String(routing.scheduleGeneration) !== payload.scheduleGeneration || !cycle || cycle.status === 'superseded' || cycle.status === 'coalesced' || String(cycle.sourceRevision) !== payload.sourceRevision) return null
  const clock = await readReviewClock(transaction, routing, payload.sourceRevision, now)
  if (!clock.due || clock.due.epochKey !== cycle.epochKey || clock.due.milestone !== cycle.milestone) return null
  return { payload, resolution, cycle, now }
}
export const createPageReviewReminderHandler = (adapter: PageReviewNotificationAdapter): DurableJobHandler => async (job, { knex, signal }) => {
  signal.throwIfAborted()
  if (job.payload.mode === 'reconcile') {
    const request = z.strictObject({ mode: z.literal('reconcile'), pageId: z.number().int().positive() }).parse(job.payload)
    await knex.transaction(transaction => producePageReviewReminder({ transaction, pageId: request.pageId }))
    return
  }
  const payload = payloadSchema.parse(job.payload)
  const receipts = await knex('pageReviewChannelReceipts').where({ cycleId: payload.cycleId }).orderBy('userId').orderBy('channel').select('id', 'userId', 'channel')
  for (const receipt of receipts) {
    signal.throwIfAborted()
    const email = await knex.transaction(async transaction => {
      const admission = await effectAdmission(transaction, job)
      if (!admission) return null
      const current = await transaction('pageReviewChannelReceipts').where('id', receipt.id).forUpdate().first()
      if (!current || ['sent', 'delivered', 'suppressed', 'unknown', 'failed'].includes(current.status)) return null
      if (current.status === 'sending') {
        await transaction('pageReviewChannelReceipts').where('id', receipt.id).update({ status: 'unknown', safeFailureReason: 'External handoff outcome is unknown; automatic replay refused', updatedAt: admission.now })
        await transaction('pageReviewEmailAttempts').where({ receiptId: receipt.id, attempt: current.attempt }).update({ status: 'unknown', updatedAt: admission.now })
        return null
      }
      const recipient = admission.resolution.recipients.find(value => value.userId === Number(receipt.userId))
      const consent = recipient && (receipt.channel === 'email' ? recipient.emailEnabled : recipient.inAppEnabled)
      if (!consent || current.consentAtAdmission !== true) {
        await transaction('pageReviewChannelReceipts').where('id', receipt.id).update({ status: 'suppressed', safeFailureReason: 'Current authority or channel consent unavailable', updatedAt: admission.now })
        return null
      }
      const effect: ReviewNotificationEffect = { origin: 'scheduled', category: 'reviewReminder', eventId: admission.cycle.id, cycleId: admission.cycle.id, pageId: payload.pageId, userId: Number(receipt.userId), sourceRevision: payload.sourceRevision, milestone: admission.cycle.milestone, dueAt: new Date(admission.cycle.dueAt).toISOString(), admittedAt: new Date(admission.cycle.createdAt).toISOString(), jobFence: { id: job.id, owner: job.leaseOwner!, token: job.leaseToken!, type: 'page-review-reminder', version: 1 } }
      if (receipt.channel === 'in-app') {
        signal.throwIfAborted()
        try {
          const delivered = await transaction.transaction(savepoint => adapter.deliverInApp(savepoint, effect))
          await transaction('pageReviewChannelReceipts').where('id', receipt.id).update({ status: delivered ? 'delivered' : 'suppressed', updatedAt: admission.now })
        } catch (error) {
          if (job.attempts < job.maxAttempts) throw error
          await transaction('pageReviewChannelReceipts').where('id', receipt.id).update({ status: 'failed', safeFailureReason: 'In-app transaction failed after the bounded retry policy', updatedAt: admission.now })
        }
        return null
      }
      const messageId = `<page-review-${admission.cycle.id}-${receipt.userId}-${current.attempt}@wiki.local>`
      await transaction('pageReviewChannelReceipts').where('id', receipt.id).update({ status: 'sending', messageId, handoffJobId: job.id, handoffLeaseOwner: job.leaseOwner, handoffLeaseToken: job.leaseToken, updatedAt: admission.now })
      await transaction('pageReviewEmailAttempts').insert({ receiptId: receipt.id, attempt: current.attempt, messageId, status: 'sending', createdAt: admission.now, updatedAt: admission.now }).onConflict(['receiptId', 'attempt']).merge(['status', 'updatedAt'])
      return { effect, messageId }
    })
    if (!email) continue
    let outcome: 'sent' | 'suppressed' | 'unknown' | 'retry-before-handoff' | null
    // Sending was committed before external I/O. Keep current authority locks
    // through handoff, but finalize its outcome in a separate transaction.
    try {
      outcome = await knex.transaction(async (transaction): Promise<typeof outcome> => {
        const admission = await effectAdmission(transaction, job)
        const current = await transaction('pageReviewChannelReceipts').where('id', receipt.id).forUpdate().first()
        if (!current || current.status !== 'sending' || current.messageId !== email.messageId) return null
        const recipient = admission?.resolution.recipients.find(value => value.userId === Number(receipt.userId))
        if (!admission || !recipient?.emailEnabled || signal.aborted) return 'suppressed'
        try {
          return await adapter.sendEmail(transaction, { ...email.effect, messageId: email.messageId })
        } catch { return 'unknown' }
      })
    } catch { outcome = 'unknown' }
    if (outcome === null) continue
    const retryBeforeHandoff = outcome === 'retry-before-handoff' && job.attempts < job.maxAttempts
    const status = outcome === 'retry-before-handoff' ? retryBeforeHandoff ? 'pending' : 'failed' : outcome
    const retryAdmitted = await knex.transaction(async transaction => {
      // Serialize safe-retry finalization with disable before locking its receipt.
      // A sent/unknown outcome remains truthful even if cancellation won meanwhile.
      const cycle = status === 'pending' ? await transaction<ReviewCycle>('pageReviewCycles').where('id', payload.cycleId).forShare().first('status') : undefined
      const current = await transaction('pageReviewChannelReceipts').where('id', receipt.id).forUpdate().first()
      // A late acknowledgement cannot overwrite a deliberate new attempt or
      // turn a concurrently fenced unknown result back into replayable work.
      if (!current || current.status !== 'sending' || current.messageId !== email.messageId) return false
      const finalStatus = status === 'pending' && (!cycle || ['superseded', 'coalesced'].includes(cycle.status)) ? 'suppressed' : status
      const now = await reviewDatabaseNow(transaction)
      await transaction('pageReviewChannelReceipts').where('id', receipt.id).update({ status: finalStatus, safeFailureReason: finalStatus === 'unknown' ? 'External acceptance unknown; deliberate resend required' : finalStatus === 'pending' || finalStatus === 'failed' ? 'Known pre-handoff failure' : finalStatus === 'suppressed' ? 'Current handoff authority, consent, lease or cycle unavailable' : null, updatedAt: now })
      await transaction('pageReviewEmailAttempts').where({ receiptId: receipt.id, attempt: current.attempt }).update({ status: finalStatus, updatedAt: now })
      return finalStatus === 'pending'
    })
    if (retryAdmitted) throw new Error('Review email failed before external handoff; safe retry admitted')
  }
}

/** Bounded per-tick recovery: a live exact lease is never mistaken for an orphan. */
export const recoverPageReviewHandoffs = async (knex: Knex, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted()
  const candidates = await knex('pageReviewChannelReceipts as receipt').leftJoin('durableJobs as job', 'job.id', 'receipt.handoffJobId')
    .where('receipt.status', 'sending')
    .where(function () {
      this.whereNull('job.id').orWhereNot('job.state', 'running').orWhereNot('job.type', 'page-review-reminder').orWhereNot('job.version', 1)
        .orWhereRaw('?? IS DISTINCT FROM ??', ['job.leaseOwner', 'receipt.handoffLeaseOwner'])
        .orWhereRaw('?? IS DISTINCT FROM ??', ['job.leaseToken', 'receipt.handoffLeaseToken'])
        .orWhereNull('job.leaseExpiresAt').orWhere('job.leaseExpiresAt', '<=', knex.raw('clock_timestamp()'))
    }).orderBy('receipt.updatedAt').orderBy('receipt.id').limit(100).select('receipt.id', 'receipt.handoffJobId')
  for (const candidate of candidates) {
    signal?.throwIfAborted()
    await knex.transaction(async transaction => {
      // Effect admission also locks job before receipt. Never invert that order.
      const job = candidate.handoffJobId ? await transaction('durableJobs').where('id', candidate.handoffJobId).forUpdate().first() : null
      const receipt = await transaction('pageReviewChannelReceipts').where('id', candidate.id).forUpdate().first()
      if (!receipt || receipt.status !== 'sending' || receipt.handoffJobId !== candidate.handoffJobId) return
      const now = await reviewDatabaseNow(transaction)
      if (job?.state === 'running' && job.type === 'page-review-reminder' && Number(job.version) === 1 && job.leaseOwner === receipt.handoffLeaseOwner && job.leaseToken === receipt.handoffLeaseToken && new Date(job.leaseExpiresAt).valueOf() > now.valueOf()) return
      signal?.throwIfAborted()
      await transaction('pageReviewChannelReceipts').where('id', receipt.id).update({ status: 'unknown', safeFailureReason: 'External handoff lease ended without a durable outcome; automatic replay refused', updatedAt: now })
      await transaction('pageReviewEmailAttempts').where({ receiptId: receipt.id, attempt: receipt.attempt }).update({ status: 'unknown', updatedAt: now })
    })
  }
}

export const retainPageReviewReminders = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    const now = await reviewDatabaseNow(transaction)
    const ordinary = new Date(now.valueOf() - 90 * REVIEW_DAY_MS)
    const exceptional = new Date(now.valueOf() - 365 * REVIEW_DAY_MS)
    await transaction('pageReviewCycles').where('createdAt', '<', exceptional).delete()
    await transaction('pageReviewCycles').where('createdAt', '<', ordinary)
      .whereNotExists(transaction('pageReviewChannelReceipts').select(transaction.raw('1')).whereRaw('?? = ??', ['pageReviewChannelReceipts.cycleId', 'pageReviewCycles.id']).whereIn('status', ['failed', 'unknown', 'sending']))
      .whereNotExists(transaction('pageReviewEmailAttempts').join('pageReviewChannelReceipts', 'pageReviewChannelReceipts.id', 'pageReviewEmailAttempts.receiptId').select(transaction.raw('1')).whereRaw('?? = ??', ['pageReviewChannelReceipts.cycleId', 'pageReviewCycles.id']).whereIn('pageReviewEmailAttempts.status', ['failed', 'unknown', 'sending'])).delete()
    await transaction('pageReviewRoutingAudit').where('createdAt', '<', ordinary).delete()
    await transaction('pageReviewConsumed').where('updatedAt', '<', exceptional).whereNotExists(transaction('pageReviewRouting').select(transaction.raw('1')).whereRaw('?? = ?? AND ?? = ??', ['pageReviewRouting.pageId', 'pageReviewConsumed.pageId', 'pageReviewRouting.scheduleGeneration', 'pageReviewConsumed.scheduleGeneration'])).delete()
  })
}
