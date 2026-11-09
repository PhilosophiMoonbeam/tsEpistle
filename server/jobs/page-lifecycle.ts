import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import { PAGE_LIFECYCLE_LIMITS, pageLifecycleDue, pageLifecycleMoveDestination, pageLifecycleOriginalRelativePath, pageLifecycleSelectorMatches } from '../../shared/page-lifecycle.ts'
import type { PageLifecycleClock, PageLifecycleDue, PageLifecycleEffect } from '../../shared/page-lifecycle.ts'
import { DurableJobStore, type DurableJob, type DurableJobHandler } from '../core/durable-jobs.ts'
import { writeOutboxEvent } from '../core/outbox.ts'
import Page from '../models/pages.ts'
import { assertNoStorageAssetAtPagePaths, StoragePathCollisionError } from '../helpers/storage-path-admission.ts'
import { lockPageReviewRecipientAccounts, resolvePageReviewRecipients, type ReviewRecipientLocks } from '../operations/page-review-routing.ts'
import { lifecycleDefinition, lifecycleDestinationPermitted, lifecycleFingerprint, lifecycleNativeCommentsAvailable, lifecyclePagePermitted, lifecycleSelectPages, lifecycleStoredJson, lifecycleTargetSnapshot, lockLifecycleActor, lockLifecycleNativePage, lockPageLifecycleRule, pageLifecycleDatabaseNow } from '../operations/page-lifecycle.ts'
import type { LifecycleActor, LifecycleCycle, LifecyclePage, LifecycleProposal, LifecycleReceipt, LifecycleRule, LifecycleRulePage } from '../operations/page-lifecycle.ts'
import errors from '../operations/errors.ts'

const NO_EXECUTION = '00000000-0000-4000-8000-000000000000'
const payloadSchema = z.strictObject({ cycleId: z.uuid(), ruleId: z.uuid(), ruleRevision: z.number().int().positive(), pageId: z.number().int().positive(), selectedSourceRevision: z.string().regex(/^[1-9]\d*$/) })
type Due = Extract<PageLifecycleDue, { state: 'due' }>
interface PlannedPage { pageId: number; sourceRevision: string; selectorFingerprint: string; due: Due; coalescedFrom: number | null; coalescedThrough: number | null }
interface Batch { id: string; ruleId: string; ruleRevision: number; pages: PlannedPage[] | string; scheduledCount: number; status: string }
interface EffectContext { transaction: Knex.Transaction; job: DurableJob; signal: AbortSignal; rule: LifecycleRule; cycle: LifecycleCycle; page: LifecyclePage; actor: LifecycleActor; now: Date; effectIndex: number; receipts: LifecycleReceipt[]; reviewLocks?: ReviewRecipientLocks; watcherAdmissionIds?: number[] }

const consumed = (rule: LifecycleRule, identity: LifecycleRulePage | undefined, due: Due): boolean => {
  const attempted = identity?.attemptedRevision === rule.revision && (due.cycleNo !== null ? Number(identity.attemptedIntervalHighWater) >= due.cycleNo : due.conditionKey.startsWith('body-inactive:') ? identity.attemptedBodyEpoch === due.epoch : identity.attemptedCommentEpoch === due.epoch)
  if (attempted) return true
  if (rule.executionId && identity?.lastExecutionId !== rule.executionId) return false
  if (due.cycleNo !== null) return Number(identity?.intervalHighWater ?? -1) >= due.cycleNo
  return due.conditionKey.startsWith('body-inactive:') ? identity?.consumedBodyEpoch === due.epoch : identity?.consumedCommentEpoch === due.epoch
}
const consumeCycle = async (transaction: Knex.Transaction, rule: LifecycleRule, cycle: LifecycleCycle, now: Date, committed = true): Promise<void> => {
  const current = await transaction<LifecycleRulePage>('pageLifecycleRulePages').where({ ruleId: rule.id, pageId: cycle.pageId }).forUpdate().first()
  if (!current) throw new Error('Lifecycle admitted page identity is unavailable')
  if (current.attemptedRevision > cycle.ruleRevision) return
  const sameRevision = current.attemptedRevision === cycle.ruleRevision
  const changes: Record<string, unknown> = {
    updatedAt: now, attemptedRevision: cycle.ruleRevision,
    attemptedBodyEpoch: sameRevision ? current.attemptedBodyEpoch : null,
    attemptedCommentEpoch: sameRevision ? current.attemptedCommentEpoch : null,
    attemptedIntervalHighWater: sameRevision ? current.attemptedIntervalHighWater : -1
  }
  if (cycle.cycleNo !== null) {
    changes.attemptedIntervalHighWater = Math.max(Number(changes.attemptedIntervalHighWater), Number(cycle.cycleNo))
    if (committed) changes.intervalHighWater = Math.max(Number(current.intervalHighWater), Number(cycle.cycleNo))
  } else if (cycle.conditionKey.startsWith('body-inactive:')) {
    changes.attemptedBodyEpoch = cycle.conditionEpoch
    if (committed) changes.consumedBodyEpoch = cycle.conditionEpoch
  } else {
    changes.attemptedCommentEpoch = cycle.conditionEpoch
    if (committed) changes.consumedCommentEpoch = cycle.conditionEpoch
  }
  if (committed && cycle.executionKey !== NO_EXECUTION) changes.lastExecutionId = cycle.executionKey
  await transaction('pageLifecycleRulePages').where({ ruleId: rule.id, pageId: cycle.pageId }).update(changes)
}
const recordReceipt = async (context: EffectContext, kind: PageLifecycleEffect['kind'], state: string, reason: string | null, extra: { afterSourceRevision?: string; proposalId?: string; outboxId?: string; operationId?: string } = {}): Promise<void> => {
  context.signal.throwIfAborted()
  const afterSourceRevision = extra.afterSourceRevision ?? String(context.cycle.nextExpectedSourceRevision)
  await context.transaction('pageLifecycleActionReceipts').insert({ cycleId: context.cycle.id, effectIndex: context.effectIndex, kind, state, reason, beforeSourceRevision: String(context.cycle.nextExpectedSourceRevision), afterSourceRevision, operationId: extra.operationId ?? null, proposalId: extra.proposalId ?? null, outboxId: extra.outboxId ?? null, createdAt: context.now, updatedAt: context.now })
  await context.transaction('pageLifecycleCycles').where('id', context.cycle.id).update({ nextExpectedSourceRevision: afterSourceRevision, status: 'running', updatedAt: context.now })
  // Consumption belongs to the same commit as the first factual effect, not a
  // later worker completion which a crash/cancel/revision change could bypass.
  if (context.receipts.length === 0) await consumeCycle(context.transaction, context.rule, context.cycle, context.now)
}
const stopCycle = async (transaction: Knex.Transaction, rule: LifecycleRule, cycle: LifecycleCycle, now: Date, status: string, reason: string, receipts: LifecycleReceipt[]): Promise<void> => {
  const effects = lifecycleDefinition(rule).effects
  const committed = receipts.length > 0
  for (let index = 0; index < effects.length; index++) {
    if (receipts.some(receipt => receipt.effectIndex === index)) continue
    await transaction('pageLifecycleActionReceipts').insert({ cycleId: cycle.id, effectIndex: index, kind: effects[index]!.kind, state: index === receipts.length ? ['skipped', 'coalesced'].includes(status) ? 'skipped' : status === 'suspended' ? 'suspended' : status === 'cancelled' ? 'cancelled' : 'failed' : 'blocked', reason, beforeSourceRevision: cycle.nextExpectedSourceRevision, afterSourceRevision: cycle.nextExpectedSourceRevision, operationId: null, proposalId: null, outboxId: null, createdAt: now, updatedAt: now }).onConflict(['cycleId', 'effectIndex']).ignore()
  }
  await transaction('pageLifecycleCycles').where('id', cycle.id).update({ status: committed ? 'partial' : status, reason, updatedAt: now, completedAt: now })
  await consumeCycle(transaction, rule, cycle, now, committed || status === 'coalesced')
  if (committed || status !== 'cancelled' && !['no-longer-selected', 'activity-reset', 'cycle-coalesced'].includes(reason)) await transaction('pageLifecycleRules').where({ id: rule.id, revision: cycle.ruleRevision, status: 'enabled' }).update({ status: status === 'suspended' ? 'suspended' : 'needs-attention', reason, updatedAt: now })
}

/** Bounded scanner called by the existing minute scheduler; it creates native durable jobs only. */
export const scanPageLifecycleRules = async (knex: Knex, signal?: AbortSignal): Promise<number> => {
  signal?.throwIfAborted()
  const rules = await knex<LifecycleRule>('pageLifecycleRules').where('status', 'enabled').orderByRaw('"lastScannedAt" ASC NULLS FIRST').orderBy('id').limit(PAGE_LIFECYCLE_LIMITS.concurrency)
  let scheduled = 0
  for (const candidate of rules) {
    signal?.throwIfAborted()
    scheduled += await knex.transaction(async transaction => {
      const nativeCommentsAvailable = lifecycleDefinition(candidate).condition.kind !== 'comments-inactive' || await lifecycleNativeCommentsAvailable(transaction)
      const actor = candidate.humanOwnerId === null ? null : await lockLifecycleActor(transaction, candidate.humanOwnerId, candidate.authVersion)
      await lockPageLifecycleRule(transaction, candidate.id)
      const rule = await transaction<LifecycleRule>('pageLifecycleRules').where('id', candidate.id).forUpdate().first(), now = await pageLifecycleDatabaseNow(transaction)
      if (!rule || rule.status !== 'enabled' || rule.revision !== candidate.revision) return 0
      if (!actor || !rule.unattendedConsent || !actor.authority.permissions.some(permission => ['write:pages', 'manage:pages', 'manage:system'].includes(permission))) {
        await transaction('pageLifecycleRules').where('id', rule.id).update({ status: 'suspended', reason: 'author-unavailable', updatedAt: now })
        return 0
      }
      const definition = lifecycleDefinition(rule), pages = await lifecycleSelectPages(transaction, definition, actor.principal, actor.authority)
      if (pages.length > PAGE_LIFECYCLE_LIMITS.targets) {
        await transaction('pageLifecycleRules').where('id', rule.id).update({ status: 'needs-attention', reason: 'narrow-selector-and-preview', updatedAt: now })
        return 0
      }
      await transaction('pageLifecycleRules').where('id', rule.id).update({ lastScannedAt: now, selectedPages: JSON.stringify(lifecycleTargetSnapshot(pages)), selectorFingerprint: lifecycleFingerprint(lifecycleTargetSnapshot(pages)) })
      let batch = rule.currentBatchId ? await transaction<Batch>('pageLifecycleBatches').where('id', rule.currentBatchId).forUpdate().first() : undefined
      if (batch && batch.status === 'running' && batch.scheduledCount === lifecycleStoredJson(batch.pages).length) {
        const cycles = await transaction<LifecycleCycle>('pageLifecycleCycles').where('batchId', batch.id)
        for (const cycle of cycles) {
          if (!['queued', 'running'].includes(cycle.status) || !cycle.jobId) continue
          const job = await transaction('durableJobs').where('id', cycle.jobId).first('state')
          if (job?.state === 'failed') {
            const receipts = await transaction<LifecycleReceipt>('pageLifecycleActionReceipts').where('cycleId', cycle.id)
            await transaction('pageLifecycleCycles').where('id', cycle.id).update({ status: receipts.some(receipt => receipt.state === 'applied' || receipt.state === 'proposed') ? 'partial' : 'failed', reason: 'infrastructure-retries-exhausted', completedAt: now, updatedAt: now })
            await transaction('pageLifecycleRules').where('id', rule.id).update({ status: 'needs-attention', reason: 'infrastructure-retries-exhausted', updatedAt: now })
            return 0
          }
        }
        if (cycles.some(cycle => ['queued', 'running', 'needs-review'].includes(cycle.status))) {
          for (const cycle of cycles.filter(cycle => cycle.status === 'needs-review' && cycle.cycleNo !== null)) {
            const latest = pageLifecycleDue(definition.condition, null, now)
            if (latest.state === 'due' && latest.cycleNo !== null && latest.cycleNo > Number(cycle.cycleNo) + 1) await transaction('pageLifecycleCycles').where('id', cycle.id).update({ coalescedFrom: Number(cycle.cycleNo) + 1, coalescedThrough: latest.cycleNo - 1, updatedAt: now })
          }
          return 0
        }
        const successful = cycles.length > 0 && cycles.every(cycle => cycle.status === 'applied' || cycle.status === 'skipped' && cycle.reason === 'already-satisfied')
        const renewed = cycles.some(cycle => cycle.status === 'coalesced' || cycle.reason === 'activity-reset')
        await transaction('pageLifecycleBatches').where('id', batch.id).update({ status: successful ? 'applied' : renewed ? 'coalesced' : 'needs-attention', completedAt: now })
        if (definition.terminalPolicy === 'retire-after-success' && !renewed) {
          await transaction('pageLifecycleRules').where('id', rule.id).update({ status: successful ? 'retired' : 'needs-attention', reason: successful ? null : 'batch-not-successful', currentBatchId: null, ...(successful ? { retiredAt: now } : {}), updatedAt: now })
          return 0
        }
        await transaction('pageLifecycleRules').where('id', rule.id).update({ currentBatchId: null })
        batch = undefined
      }
      if (!batch || batch.status !== 'running') {
        const planned: PlannedPage[] = []
        for (const page of pages) {
          signal?.throwIfAborted()
          const identity = await transaction<LifecycleRulePage>('pageLifecycleRulePages').where({ ruleId: rule.id, pageId: page.id }).first()
          if (!identity) await transaction('pageLifecycleRulePages').insert({ ruleId: rule.id, pageId: page.id, originalRelativePath: pageLifecycleOriginalRelativePath(definition.selector, page.path), originalLocale: page.localeCode, consumedBodyEpoch: null, consumedCommentEpoch: null, intervalHighWater: -1, lastExecutionId: null, updatedAt: now }).onConflict(['ruleId', 'pageId']).ignore()
          const clock = await transaction<PageLifecycleClock>('pageLifecycleClocks').where('pageId', page.id).first()
          const due = pageLifecycleDue(definition.condition, nativeCommentsAvailable ? clock ?? null : null, now)
          if (due.state !== 'due' || consumed(rule, identity, due)) continue
          const pending = await transaction<LifecycleProposal>('pageLifecycleMoveProposals').where({ ruleId: rule.id, pageId: page.id, status: 'awaiting-human' }).first()
          if (pending) continue
          const existing = await transaction('pageLifecycleCycles').where({ ruleId: rule.id, ruleRevision: rule.revision, pageId: page.id, conditionKey: due.conditionKey, executionKey: rule.executionId ?? NO_EXECUTION }).first('id')
          if (existing) continue
          const highWater = Number(identity?.intervalHighWater ?? -1)
          planned.push({ pageId: page.id, sourceRevision: String(page.sourceRevision), selectorFingerprint: lifecycleFingerprint(lifecycleTargetSnapshot([page])), due, coalescedFrom: due.cycleNo !== null && due.cycleNo > highWater + 1 ? highWater + 1 : null, coalescedThrough: due.cycleNo !== null && due.cycleNo > highWater + 1 ? due.cycleNo - 1 : null })
        }
        if (planned.length === 0) return 0
        await transaction.raw('SELECT pg_advisory_xact_lock(?)', [0x504c4243])
        const active = await transaction('pageLifecycleBatches as batch').join('pageLifecycleRules as rule', 'rule.id', 'batch.ruleId').where({ 'batch.status': 'running', 'rule.status': 'enabled' }).where(function () {
          this.whereRaw('?? < jsonb_array_length(??)', ['batch.scheduledCount', 'batch.pages']).orWhereExists(transaction('pageLifecycleCycles as cycle').select(transaction.raw('1')).whereRaw('?? = ??', ['cycle.batchId', 'batch.id']).whereIn('cycle.status', ['queued', 'running']))
        }).count<{ count: string }[]>({ count: 'batch.id' }).first()
        if (Number(active?.count) >= PAGE_LIFECYCLE_LIMITS.concurrency) return 0
        batch = { id: randomUUID(), ruleId: rule.id, ruleRevision: rule.revision, pages: planned, scheduledCount: 0, status: 'running' }
        await transaction('pageLifecycleBatches').insert({ ...batch, pages: JSON.stringify(planned), createdAt: now, completedAt: null })
        await transaction('pageLifecycleRules').where('id', rule.id).update({ currentBatchId: batch.id })
      }
      const planned = lifecycleStoredJson(batch.pages), slice = planned.slice(batch.scheduledCount, batch.scheduledCount + PAGE_LIFECYCLE_LIMITS.batch)
      for (const page of slice) {
        signal?.throwIfAborted()
        const id = randomUUID(), executionKey = rule.executionId ?? NO_EXECUTION
        await transaction('pageLifecycleCycles').insert({ id, ruleId: rule.id, batchId: batch.id, ruleRevision: rule.revision, pageId: page.pageId, conditionKey: page.due.conditionKey, conditionEpoch: page.due.epoch, cycleNo: page.due.cycleNo, executionKey, dueAt: page.due.dueAt, selectedSourceRevision: page.sourceRevision, nextExpectedSourceRevision: page.sourceRevision, selectorFingerprint: page.selectorFingerprint, status: 'queued', reason: null, jobId: null, coalescedFrom: page.coalescedFrom, coalescedThrough: page.coalescedThrough, createdAt: now, updatedAt: now, completedAt: null }).onConflict(['ruleId', 'ruleRevision', 'pageId', 'conditionKey', 'executionKey']).ignore()
        const cycle = await transaction<LifecycleCycle>('pageLifecycleCycles').where({ ruleId: rule.id, ruleRevision: rule.revision, pageId: page.pageId, conditionKey: page.due.conditionKey, executionKey }).first()
        if (!cycle || cycle.status !== 'queued') continue
        const job = await new DurableJobStore(transaction).enqueue({ type: 'page-lifecycle', version: 1, payload: { cycleId: cycle.id, ruleId: rule.id, ruleRevision: rule.revision, pageId: page.pageId, selectedSourceRevision: page.sourceRevision }, maxAttempts: 5, deduplicationKey: `lifecycle:${rule.id}:${rule.revision}:${page.pageId}:${page.due.conditionKey}:${executionKey}` })
        await transaction('pageLifecycleCycles').where('id', cycle.id).update({ jobId: job.id })
      }
      await transaction('pageLifecycleBatches').where('id', batch.id).update({ scheduledCount: batch.scheduledCount + slice.length })
      return slice.length
    })
  }
  return scheduled
}

const admitEffect = async (transaction: Knex.Transaction, job: DurableJob, signal: AbortSignal, effectIndex: number): Promise<EffectContext | null> => {
  signal.throwIfAborted()
  const payload = payloadSchema.parse(job.payload)
  const initial = await transaction<LifecycleRule>('pageLifecycleRules').where('id', payload.ruleId).first()
  const configuredEffect = initial ? lifecycleDefinition(initial).effects[effectIndex] : undefined
  if (!configuredEffect) return null
  const nativeCommentsAvailable = !initial || lifecycleDefinition(initial).condition.kind !== 'comments-inactive' || await lifecycleNativeCommentsAvailable(transaction)
  const observed = configuredEffect?.kind === 'notify' && configuredEffect.audience === 'review-route' ? await transaction('pages').where('id', payload.pageId).first('sourceRevision') : null
  const reviewLocks = observed ? await lockPageReviewRecipientAccounts({ transaction, pageId: payload.pageId, sourceRevision: String(observed.sourceRevision), additionalUserIds: initial?.humanOwnerId == null ? [] : [initial.humanOwnerId] }) : undefined
  let watcherAdmissionIds: number[] | undefined
  if (configuredEffect.kind === 'notify' && configuredEffect.audience === 'watchers') {
    await transaction('groups').select('id').orderBy('id').forShare()
    const watched = await transaction<{ userId: number }>('pageWatchers').where('pageId', payload.pageId).select('userId')
    const ids = [...new Set([...watched.map(watch => watch.userId), ...(initial?.humanOwnerId == null ? [] : [initial.humanOwnerId])])].sort((a, b) => a - b)
    const accounts = ids.length ? await transaction<{ id: number; isActive: boolean; isSystem: boolean }>('users').select('id', 'isActive', 'isSystem').whereIn('id', ids).orderBy('id').forShare() : []
    watcherAdmissionIds = accounts.filter(account => account.isActive && !account.isSystem && account.id !== 2).map(account => account.id)
  }
  const actor = initial?.humanOwnerId == null ? null : await lockLifecycleActor(transaction, initial.humanOwnerId, initial.authVersion)
  await lockPageLifecycleRule(transaction, payload.ruleId)
  const page = actor ? await lockLifecycleNativePage(transaction, payload.pageId) : null
  const storedJob = await transaction('durableJobs').where('id', job.id).forUpdate().first()
  const now = await pageLifecycleDatabaseNow(transaction)
  signal.throwIfAborted()
  if (!storedJob || storedJob.type !== 'page-lifecycle' || storedJob.version !== 1 || job.type !== 'page-lifecycle' || job.version !== 1 || storedJob.state !== 'running' || !job.leaseOwner || !job.leaseToken || storedJob.leaseOwner !== job.leaseOwner || storedJob.leaseToken !== job.leaseToken || !storedJob.leaseExpiresAt || !Number.isFinite(new Date(storedJob.leaseExpiresAt).valueOf()) || new Date(storedJob.leaseExpiresAt).valueOf() <= now.valueOf() || lifecycleFingerprint(lifecycleStoredJson(storedJob.payload)) !== lifecycleFingerprint(job.payload)) return null
  const rule = await transaction<LifecycleRule>('pageLifecycleRules').where('id', payload.ruleId).forUpdate().first()
  const cycle = await transaction<LifecycleCycle>('pageLifecycleCycles').where('id', payload.cycleId).forUpdate().first()
  if (!rule || !cycle || cycle.ruleId !== payload.ruleId || cycle.ruleRevision !== payload.ruleRevision || cycle.pageId !== payload.pageId || cycle.jobId !== job.id) return null
  const receipts = await transaction<LifecycleReceipt>('pageLifecycleActionReceipts').where('cycleId', cycle.id).orderBy('effectIndex').forUpdate()
  if (receipts.some(receipt => receipt.effectIndex === effectIndex) || !['queued', 'running', 'needs-review'].includes(cycle.status)) return null
  if (rule.status !== 'enabled' || rule.revision !== payload.ruleRevision || !rule.unattendedConsent) { await stopCycle(transaction, rule, cycle, now, 'cancelled', 'rule-disabled-or-revised', receipts); return null }
  if (!actor || rule.humanOwnerId !== actor.account.id || rule.authVersion !== actor.account.authVersion) { await stopCycle(transaction, rule, cycle, now, 'suspended', 'author-unavailable', receipts); return null }
  if (!page || !pageLifecycleSelectorMatches(lifecycleDefinition(rule).selector, page) || !lifecyclePagePermitted(actor.principal, actor.authority, page)) { await stopCycle(transaction, rule, cycle, now, 'skipped', 'no-longer-selected', receipts); return null }
  if (await transaction('pageAccessPasswords').where('pageId', page.id).forShare().first('pageId')) { await stopCycle(transaction, rule, cycle, now, 'suspended', 'needs-interactive', receipts); return null }
  const clock = await transaction<PageLifecycleClock>('pageLifecycleClocks').where('pageId', page.id).forUpdate().first()
  const due = pageLifecycleDue(lifecycleDefinition(rule).condition, nativeCommentsAvailable ? clock ?? null : null, now)
  const committed = receipts.length > 0
  if (due.state === 'due' && due.cycleNo !== null && cycle.cycleNo !== null && due.cycleNo > Number(cycle.cycleNo) && !committed) {
    await stopCycle(transaction, rule, cycle, now, 'coalesced', 'cycle-coalesced', receipts); return null
  }
  const clockMatches = due.state === 'due' && (cycle.cycleNo === null ? due.conditionKey === cycle.conditionKey : due.cycleNo !== null && due.cycleNo >= Number(cycle.cycleNo))
  if (!clockMatches) { await stopCycle(transaction, rule, cycle, now, 'skipped', due.state === 'unknown-clock' ? 'unknown-clock' : 'activity-reset', receipts); return null }
  if (receipts.some(receipt => !['applied', 'skipped', 'proposed', 'fulfilled'].includes(receipt.state))) { await stopCycle(transaction, rule, cycle, now, 'failed', 'prior-effect-stopped', receipts); return null }
  if (String(page.sourceRevision) !== String(cycle.nextExpectedSourceRevision)) {
    if (receipts.length > 0) { await stopCycle(transaction, rule, cycle, now, 'failed', 'partial-stale', receipts); return null }
    // No effect committed: refresh only the same clock epoch, never a consumed action.
    cycle.selectedSourceRevision = page.sourceRevision; cycle.nextExpectedSourceRevision = page.sourceRevision
    cycle.selectorFingerprint = lifecycleFingerprint(lifecycleTargetSnapshot([page]))
    await transaction('pageLifecycleCycles').where('id', cycle.id).update({ selectedSourceRevision: page.sourceRevision, nextExpectedSourceRevision: page.sourceRevision, selectorFingerprint: cycle.selectorFingerprint, updatedAt: now })
  }
  if (effectIndex !== receipts.length) return null
  return { transaction, job, signal, rule, cycle, page, actor, now, effectIndex, receipts, ...(reviewLocks ? { reviewLocks } : {}), ...(watcherAdmissionIds ? { watcherAdmissionIds } : {}) }
}
const executeEffect = async (context: EffectContext, effect: PageLifecycleEffect): Promise<void> => {
  const { transaction, cycle, rule, page, actor, now, signal } = context
  signal.throwIfAborted()
  if (effect.kind === 'add-tags') {
    const tags = await transaction<{ id: number; tag: string; isArchived: boolean; redirectToId: number | null }>('tags').whereIn('id', effect.tagIds).orderBy('id').forShare()
    if (effect.tagIds.some(id => !tags.some(tag => tag.id === id && !tag.isArchived && tag.redirectToId === null))) { await stopCycle(transaction, rule, cycle, now, 'failed', 'invalid-action', context.receipts); return }
    const proposed = { ...page, tags: [...page.tags, ...tags.filter(tag => !page.tagIds.includes(tag.id))] }
    if (!lifecyclePagePermitted(actor.principal, actor.authority, proposed)) { await stopCycle(transaction, rule, cycle, now, 'suspended', 'forbidden-after-tags', context.receipts); return }
    if (effect.tagIds.every(id => page.tagIds.includes(id))) { await recordReceipt(context, effect.kind, 'skipped', 'already-satisfied'); return }
    // The authoritative native mutator owns tag/history/projection/outbox writes. Its hook is inside that same transaction.
    await Page.updatePage({ id: page.id, tags: proposed.tags.map(tag => tag.tag), expectedSourceRevision: String(cycle.nextExpectedSourceRevision), user: actor.principal as Parameters<typeof Page.updatePage>[0]['user'], transaction, unattendedLifecycle: true, canonicalTransactionHook: async (canonicalTransaction: Knex.Transaction, result: { id: number; sourceRevision: string | number; outboxId: string }) => {
      if (canonicalTransaction !== transaction || result.id !== page.id || !/^[1-9]\d*$/.test(String(result.sourceRevision)) || BigInt(result.sourceRevision) <= BigInt(cycle.nextExpectedSourceRevision) || !z.uuid().safeParse(result.outboxId).success) throw new Error('Canonical lifecycle transaction mismatch')
      signal.throwIfAborted()
      await recordReceipt(context, effect.kind, 'applied', null, { afterSourceRevision: String(result.sourceRevision), operationId: result.outboxId, outboxId: result.outboxId })
    } })
    return
  }
  if (effect.kind === 'set-notice') {
    const existing = await transaction('pageLifecycleNotices').where({ ruleId: rule.id, pageId: page.id }).forUpdate().first()
    if (existing?.text === effect.text) { await recordReceipt(context, effect.kind, 'skipped', 'already-satisfied'); return }
    await transaction('pageLifecycleNotices').insert({ ruleId: rule.id, pageId: page.id, text: effect.text, createdAt: now, updatedAt: now }).onConflict(['ruleId', 'pageId']).merge({ text: effect.text, updatedAt: now })
    const outboxId = await writeOutboxEvent(transaction, { type: 'page.lifecycle-notice', version: 1, aggregateType: 'page', aggregateId: page.id, createdAt: now, payload: { version: 1, pageId: page.id, ruleId: rule.id, cycleId: cycle.id, sourceRevision: String(page.sourceRevision) } })
    await recordReceipt(context, effect.kind, 'applied', null, { outboxId })
    return
  }
  if (effect.kind === 'propose-move') {
    if (page.visibility !== 'public' || page.ownerId !== null) { await stopCycle(transaction, rule, cycle, now, 'suspended', 'needs-manual-native-flow', context.receipts); return }
    const identity = await transaction<LifecycleRulePage>('pageLifecycleRulePages').where({ ruleId: rule.id, pageId: page.id }).forUpdate().first()
    if (!identity || identity.originalLocale !== page.localeCode) { await stopCycle(transaction, rule, cycle, now, 'failed', 'original-locale-changed', context.receipts); return }
    let destinationPath: string
    try { destinationPath = pageLifecycleMoveDestination(effect, page.id, identity.originalRelativePath) } catch (error) {
      if (!(error instanceof z.ZodError)) throw error
      await stopCycle(transaction, rule, cycle, now, 'failed', 'invalid-action', context.receipts); return
    }
    if (page.path === destinationPath) { await recordReceipt(context, effect.kind, 'skipped', 'already-satisfied'); return }
    if (!lifecycleDestinationPermitted(actor.principal, actor.authority, page, destinationPath)) { await stopCycle(transaction, rule, cycle, now, 'suspended', 'destination-unavailable', context.receipts); return }
    const collision = await transaction('pages').where({ path: destinationPath, localeCode: identity.originalLocale, visibility: 'public' }).whereNull('ownerId').first('id')
    if (collision) { await stopCycle(transaction, rule, cycle, now, 'failed', 'blocked-collision', context.receipts); return }
    try {
      await assertNoStorageAssetAtPagePaths(transaction, { path: destinationPath, localeCode: identity.originalLocale, contentType: page.contentType, visibility: 'public' })
    } catch (error) {
      if (!(error instanceof StoragePathCollisionError)) throw error
      await stopCycle(transaction, rule, cycle, now, 'failed', 'blocked-collision', context.receipts); return
    }
    const pending = await transaction<LifecycleProposal>('pageLifecycleMoveProposals').where({ ruleId: rule.id, pageId: page.id, status: 'awaiting-human' }).first()
    if (pending) { await recordReceipt(context, effect.kind, 'skipped', 'proposal-coalesced', { proposalId: pending.id }); return }
    const proposalId = randomUUID()
    await transaction('pageLifecycleMoveProposals').insert({ id: proposalId, ruleId: rule.id, cycleId: cycle.id, effectIndex: context.effectIndex, ruleRevision: rule.revision, pageId: page.id, sourceRevision: cycle.nextExpectedSourceRevision, sourcePath: page.path, sourceLocale: page.localeCode, destinationPath, destinationLocale: identity.originalLocale, selectorFingerprint: cycle.selectorFingerprint, status: 'awaiting-human', reason: null, resultSourceRevision: null, fulfilledBy: null, outboxId: null, createdAt: now, expiresAt: new Date(now.valueOf() + PAGE_LIFECYCLE_LIMITS.proposalMs), settledAt: null })
    const outboxId = await writeOutboxEvent(transaction, { type: 'page.lifecycle-move-proposed', version: 1, aggregateType: 'page', aggregateId: page.id, createdAt: now, payload: { version: 1, pageId: page.id, ruleId: rule.id, cycleId: cycle.id, proposalId, outcome: 'proposed' } })
    await recordReceipt(context, effect.kind, 'proposed', 'awaiting-human', { proposalId, outboxId })
    return
  }
  if (effect.audience === 'review-route' && !context.reviewLocks) { await stopCycle(transaction, rule, cycle, now, 'failed', 'review-route-undeliverable', context.receipts); return }
  const recipients = effect.audience === 'review-route' && context.reviewLocks ? await resolvePageReviewRecipients({ transaction, pageId: page.id, sourceRevision: String(page.sourceRevision), prepared: context.reviewLocks }) : null
  if (recipients && recipients.status !== 'eligible') { await stopCycle(transaction, rule, cycle, now, 'failed', `review-route-${recipients.status}`, context.receipts); return }
  const watchers = effect.audience === 'watchers' ? await transaction<{ userId: number; emailEnabled: boolean; inAppEnabled: boolean }>('pageWatchers').where('pageId', page.id).whereIn('userId', context.watcherAdmissionIds ?? []).where(function () { this.where('inAppEnabled', true).orWhere('emailEnabled', true) }).select('userId', 'emailEnabled', 'inAppEnabled').forShare() : []
  const audience = recipients ? recipients.recipients : watchers
  const preferences = audience.length ? await transaction<{ userId: number; emailEnabled: boolean; inAppEnabled: boolean }>('userNotificationPreferences').where('category', 'pageLifecycle').whereIn('userId', audience.map(recipient => recipient.userId)).forShare() : []
  const recipientChannels = audience.flatMap(recipient => {
    const preference = preferences.find(preference => preference.userId === recipient.userId)
    const emailEnabled = recipient.emailEnabled === true && preference?.emailEnabled === true, inAppEnabled = recipient.inAppEnabled === true && preference?.inAppEnabled === true
    return emailEnabled || inAppEnabled ? [{ userId: recipient.userId, emailEnabled, inAppEnabled }] : []
  })
  if (recipientChannels.length === 0) { await stopCycle(transaction, rule, cycle, now, 'failed', 'no-eligible-recipients', context.receipts); return }
  const actions = context.receipts.map(receipt => ({ kind: receipt.kind, state: receipt.state, reason: receipt.reason }))
  const outboxId = await writeOutboxEvent(transaction, { type: 'page.lifecycle-result', version: 1, aggregateType: 'page', aggregateId: page.id, createdAt: now, payload: { version: 1, pageId: page.id, ruleId: rule.id, cycleId: cycle.id, sourceRevision: String(page.sourceRevision), audience: effect.audience, recipientIds: recipientChannels.map(recipient => recipient.userId), recipientChannels, ...(recipients ? { routingRevision: recipients.routingRevision } : {}), outcome: actions.some(action => action.state === 'proposed') ? 'needs-review' : 'applied', actions } })
  await recordReceipt(context, effect.kind, 'applied', null, { outboxId })
}

export const createPageLifecycleHandler = (): DurableJobHandler => async (job, { knex, signal }) => {
  const payload = payloadSchema.parse(job.payload)
  for (let pass = 0; pass < PAGE_LIFECYCLE_LIMITS.effects; pass++) {
    signal.throwIfAborted()
    let executed: boolean
    try {
      executed = await knex.transaction(async transaction => {
        const prior = await transaction<LifecycleReceipt>('pageLifecycleActionReceipts').where('cycleId', payload.cycleId).orderBy('effectIndex')
        const context = await admitEffect(transaction, job, signal, prior.length)
        if (!context) return false
        const effect = lifecycleDefinition(context.rule).effects[context.effectIndex]
        if (!effect) return false
        await executeEffect(context, effect)
        return true
      })
    } catch (error) {
      signal.throwIfAborted()
      const native = error instanceof Error ? ({ PageUpdateForbidden: ['suspended', 'forbidden'], PageMoveForbidden: ['suspended', 'destination-unavailable'], PageNotFound: ['skipped', 'no-longer-selected'], PagePathCollision: ['failed', 'blocked-collision'], PageUpdateConflict: ['failed', 'stale-source'] } as Record<string, [string, string]>)[error.name] : undefined
      const semantic = native ?? (error instanceof errors.ApplicationError && error.status >= 400 && error.status < 500 ? [error.name === 'LIFECYCLE_NEEDS_INTERACTIVE' || error.status === 403 ? 'suspended' : 'failed', error.name === 'LIFECYCLE_NEEDS_INTERACTIVE' ? 'needs-interactive' : error.status === 403 ? 'forbidden' : 'invalid-action'] : undefined)
      if (!semantic) throw error
      // The throwing canonical transaction has rolled back. Record the refusal
      // only after reacquiring the real lease/current authority; never catch and
      // commit a native mutator's partially staged writes.
      await knex.transaction(async transaction => {
        const prior = await transaction<LifecycleReceipt>('pageLifecycleActionReceipts').where('cycleId', payload.cycleId)
        const context = await admitEffect(transaction, job, signal, prior.length)
        if (context) await stopCycle(transaction, context.rule, context.cycle, context.now, semantic[0]!, semantic[1]!, context.receipts)
      })
      break
    }
    if (!executed) break
  }
  await knex.transaction(async transaction => {
    signal.throwIfAborted()
    const initial = await transaction<LifecycleRule>('pageLifecycleRules').where('id', payload.ruleId).first()
    if (!initial) return
    if (initial.humanOwnerId !== null) await lockLifecycleActor(transaction, initial.humanOwnerId, initial.authVersion)
    await lockPageLifecycleRule(transaction, payload.ruleId)
    const storedJob = await transaction('durableJobs').where('id', job.id).forUpdate().first(), now = await pageLifecycleDatabaseNow(transaction)
    if (!storedJob || storedJob.state !== 'running' || storedJob.type !== 'page-lifecycle' || storedJob.version !== 1 || storedJob.leaseOwner !== job.leaseOwner || storedJob.leaseToken !== job.leaseToken || !storedJob.leaseExpiresAt || !Number.isFinite(new Date(storedJob.leaseExpiresAt).valueOf()) || new Date(storedJob.leaseExpiresAt).valueOf() <= now.valueOf()) return
    const rule = await transaction<LifecycleRule>('pageLifecycleRules').where('id', payload.ruleId).forUpdate().first(), cycle = await transaction<LifecycleCycle>('pageLifecycleCycles').where('id', payload.cycleId).forUpdate().first()
    if (!rule || !cycle || !['queued', 'running', 'needs-review'].includes(cycle.status) || rule.status !== 'enabled' || rule.revision !== payload.ruleRevision) return
    const receipts = await transaction<LifecycleReceipt>('pageLifecycleActionReceipts').where('cycleId', cycle.id).orderBy('effectIndex')
    if (receipts.length !== lifecycleDefinition(rule).effects.length) return
    const needsReview = receipts.some(receipt => receipt.state === 'proposed'), success = receipts.every(receipt => ['applied', 'skipped', 'fulfilled', 'proposed'].includes(receipt.state)), allSkipped = receipts.every(receipt => receipt.state === 'skipped')
    await transaction('pageLifecycleCycles').where('id', cycle.id).update({ status: needsReview ? 'needs-review' : success ? allSkipped ? 'skipped' : 'applied' : 'partial', reason: allSkipped ? 'already-satisfied' : null, updatedAt: now, completedAt: needsReview ? null : now })
  })
  const pending = await knex<LifecycleCycle>('pageLifecycleCycles').where('id', payload.cycleId).first()
  if (pending && ['queued', 'running'].includes(pending.status)) throw new Error('Lifecycle work remains uncommitted; reacquire a current lease before retrying')
}

/** Called by the existing bounded durable cleanup handler, not a new scheduler. */
export const cleanupPageLifecycle = async (knex: Knex, signal?: AbortSignal): Promise<boolean> => {
  return knex.transaction(async transaction => {
    const now = await pageLifecycleDatabaseNow(transaction)
    const proposals = await transaction<LifecycleProposal>('pageLifecycleMoveProposals').where('status', 'awaiting-human').where('expiresAt', '<=', now).orderBy('expiresAt').limit(100)
    for (const candidate of proposals) {
      signal?.throwIfAborted()
      const acquired = await transaction.raw<{ rows: Array<{ acquired: boolean }> }>('SELECT pg_try_advisory_xact_lock(?, hashtext(?)) AS acquired', [0x504c5255, candidate.ruleId])
      if (!acquired.rows[0]?.acquired) continue
      const rule = await transaction<LifecycleRule>('pageLifecycleRules').where('id', candidate.ruleId).forUpdate().first()
      const cycle = await transaction<LifecycleCycle>('pageLifecycleCycles').where('id', candidate.cycleId).forUpdate().first()
      const proposal = await transaction<LifecycleProposal>('pageLifecycleMoveProposals').where({ id: candidate.id, status: 'awaiting-human' }).forUpdate().first()
      if (!rule || !cycle || !proposal || new Date(proposal.expiresAt).valueOf() > now.valueOf()) continue
      await transaction('pageLifecycleMoveProposals').where('id', proposal.id).update({ status: 'expired', reason: 'human-review-expired', settledAt: now })
      await transaction('pageLifecycleActionReceipts').where({ cycleId: proposal.cycleId, effectIndex: proposal.effectIndex, state: 'proposed' }).update({ state: 'expired', reason: 'human-review-expired', updatedAt: now })
      await transaction('pageLifecycleCycles').where('id', proposal.cycleId).update({ status: 'partial', reason: 'human-review-expired', updatedAt: now, completedAt: now })
      await transaction('pageLifecycleRules').where('id', proposal.ruleId).where('status', 'enabled').update({ status: 'needs-attention', reason: 'human-review-expired', updatedAt: now })
    }
    const previews = await transaction('pageLifecyclePreviews').where('expiresAt', '<', now).orderBy('expiresAt').limit(100).select('id')
    if (previews.length) await transaction('pageLifecyclePreviews').whereIn('id', previews.map(row => row.id)).delete()
    const ordinaryBefore = new Date(now.valueOf() - 90 * 86_400_000), auditBefore = new Date(now.valueOf() - 365 * 86_400_000)
    const oldProposals = await transaction<LifecycleProposal>('pageLifecycleMoveProposals').whereNot('status', 'awaiting-human').where('settledAt', '<', auditBefore).orderBy('settledAt').select('id').limit(100)
    if (oldProposals.length) await transaction('pageLifecycleMoveProposals').whereIn('id', oldProposals.map(proposal => proposal.id)).delete()
    const cycles = await transaction<LifecycleCycle>('pageLifecycleCycles').join('pageLifecycleRules as rule', 'rule.id', 'pageLifecycleCycles.ruleId').whereNotNull('pageLifecycleCycles.completedAt').where(function () { this.where(function () { this.whereIn('pageLifecycleCycles.status', ['applied', 'skipped', 'coalesced']).where('pageLifecycleCycles.completedAt', '<', ordinaryBefore) }).orWhere('pageLifecycleCycles.completedAt', '<', auditBefore) }).whereNotExists(transaction('pageLifecycleMoveProposals').select(transaction.raw('1')).whereRaw('?? = ??', ['pageLifecycleMoveProposals.cycleId', 'pageLifecycleCycles.id'])).whereNotExists(transaction('pageLifecycleBatches as pendingBatch').select(transaction.raw('1')).where('pendingBatch.status', 'running').where('rule.status', 'enabled').whereRaw('?? = ?? AND ?? = ??', ['pendingBatch.id', 'pageLifecycleCycles.batchId', 'rule.currentBatchId', 'pendingBatch.id'])).select('pageLifecycleCycles.id').orderBy('pageLifecycleCycles.completedAt').limit(100)
    signal?.throwIfAborted()
    if (cycles.length) await transaction('pageLifecycleCycles').whereIn('id', cycles.map(cycle => cycle.id)).delete()
    const batches = await transaction('pageLifecycleBatches').whereNot('status', 'running').where('completedAt', '<', ordinaryBefore).whereNotExists(transaction('pageLifecycleCycles').select(transaction.raw('1')).whereRaw('?? = ??', ['pageLifecycleCycles.batchId', 'pageLifecycleBatches.id'])).select('id').orderBy('completedAt').limit(100)
    if (batches.length) await transaction('pageLifecycleBatches').whereIn('id', batches.map(batch => batch.id)).delete()
    // Minimal high-water/origin rows and terminal UUID tombstones survive at least 365 days.
    const rules = await transaction<LifecycleRule>('pageLifecycleRules').whereIn('status', ['retired', 'cancelled']).where('retiredAt', '<', auditBefore).orderBy('retiredAt').limit(1)
    let purgedRule = false
    for (const candidate of rules) {
      signal?.throwIfAborted()
      const acquired = await transaction.raw<{ rows: Array<{ acquired: boolean }> }>('SELECT pg_try_advisory_xact_lock(?, hashtext(?)) AS acquired', [0x504c5255, candidate.id])
      if (!acquired.rows[0]?.acquired) continue
      const jobs = await transaction('durableJobs').whereRaw("payload::jsonb ->> 'ruleId' = ?", [candidate.id]).where('type', 'page-lifecycle').first('id')
      if (jobs) continue
      for (const table of ['pageLifecycleMoveProposals', 'pageLifecycleCycles', 'pageLifecycleBatches']) {
        const children = await transaction(table).where('ruleId', candidate.id).select('id').orderBy('id').limit(100)
        if (children.length) await transaction(table).whereIn('id', children.map(child => child.id)).delete()
        if (await transaction(table).where('ruleId', candidate.id).first('id')) return true
      }
      for (const table of ['pageLifecycleNotices', 'pageLifecycleRulePages']) {
        const children = await transaction(table).where('ruleId', candidate.id).select('pageId').orderBy('pageId').limit(100)
        if (children.length) await transaction(table).where('ruleId', candidate.id).whereIn('pageId', children.map(child => child.pageId)).delete()
        if (await transaction(table).where('ruleId', candidate.id).first('pageId')) return true
      }
      await transaction('pageLifecycleRules').where('id', candidate.id).delete()
      purgedRule = true
    }
    return proposals.length === 100 || previews.length === 100 || oldProposals.length === 100 || cycles.length === 100 || batches.length === 100 || purgedRule
  })
}
