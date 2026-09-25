import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import {
  StorageOperationResultSchema,
  type StorageOperationResult,
  type StorageOperationView,
  type StorageOperationState
} from '../../shared/storage-workspace.ts'
import { DurableJobStore, type DurableJob } from '../core/durable-jobs.ts'
import { storageConfigurationKey } from '../helpers/storage-configuration-key.ts'
import type { PagePrincipal } from '../helpers/page-access.ts'
import { storageRecord, storageTargetView } from '../repositories/storage-configuration.ts'
import type { createStorageConfigurationStore } from './storage-configuration.ts'
import errors from './errors.ts'

export interface StorageRuntimeTarget {
  key: string
  generation: string
  configurationKey: string
  active: boolean
  paused: boolean
}
interface Dependencies {
  db: Knex
  configuration: ReturnType<typeof createStorageConfigurationStore>
  runtime(): StorageRuntimeTarget[]
  offline(targetKey: string | null): boolean
  isExecuting?(id: string): boolean
  now?(): Date
}
interface Row {
  id: string
  jobId: string
  targetKey: string | null
  handler: string
  state: StorageOperationState
  actorId: number | null
  reason: string
  requester: PagePrincipal
  reviewFingerprint: string
  configurationRevision: string
  runtimeGeneration: string | null
  title: string
  effect: string
  result: StorageOperationResult | null
  resolution: StorageOperationView['resolution']
  createdAt: Date | string
  startedAt: Date | string | null
  completedAt: Date | string | null
}
interface Lease {
  id: string
  state: string
  leaseToken: string | null
  leaseExpiresAt: Date | string | null
}
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const reason = z.string().trim().min(3).max(1000)
const enqueueSchema = z
  .object({
    targetKey: z.string().min(1).max(255).nullable(),
    handler: z.string().min(1).max(100),
    fingerprint: z.string().length(64),
    reason,
    confirmation: z.string().max(100)
  })
  .strict()
const decisionSchema = z.object({ id: z.uuid(), fingerprint: z.string().length(64), reason, confirmation: z.string().max(100) }).strict()
const date = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString())
const activeStates = ['queued', 'running', 'interrupted']
export const createStorageActionStore = (deps: Dependencies) => {
  const now = () => deps.now?.() ?? new Date()
  const liveLease = (lease: Lease | undefined) =>
    Boolean(lease?.state === 'running' && lease.leaseToken && lease.leaseExpiresAt && new Date(lease.leaseExpiresAt).valueOf() > now().valueOf())
  const owns = (lease: Lease | undefined, job: DurableJob) => liveLease(lease) && lease!.leaseToken === job.leaseToken
  const operation = async (tx: Knex.Transaction, id: string) => {
    const row = await tx<Row>('storageOperations').where('id', id).forUpdate().first()
    if (!row) return fail('This storage operation no longer exists.', 404)
    const lease = await tx<Lease>('durableJobs').where('id', row.jobId).forUpdate().first()
    return { row, lease }
  }
  const view = (row: Row, lease: Lease | undefined): StorageOperationView => {
    const unsettled = activeStates.includes(row.state)
    const interrupted = unsettled && !(row.state === 'queued' && lease?.state === 'pending') && !liveLease(lease)
    return {
      id: row.id,
      jobId: row.jobId,
      targetKey: row.targetKey,
      handler: row.handler,
      title: row.title,
      effect: row.effect,
      state: interrupted ? 'interrupted' : row.state,
      actorId: row.actorId,
      reason: row.reason,
      configurationRevision: row.configurationRevision,
      createdAt: date(row.createdAt)!,
      startedAt: date(row.startedAt),
      completedAt: date(row.completedAt),
      result: row.result,
      resolution: row.resolution,
      canCancel: row.state === 'queued' && row.startedAt === null,
      canResolve: interrupted && row.startedAt !== null && !deps.isExecuting?.(row.id)
    }
  }
  const assertReview = (actual: string, expected: string) => {
    if (actual !== expected) fail('Storage settings or your access changed. Reload and review again.', 409)
  }
  const listInTransaction = async (tx: Knex.Transaction): Promise<StorageOperationView[]> => {
    const recent = await tx<Row>('storageOperations').orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(50)
    const active = await tx<Row>('storageOperations').whereIn('state', activeStates)
    const rows = [...new Map([...active, ...recent].map(row => [row.id, row])).values()]
    const leases = await tx<Lease>('durableJobs')
      .whereIn(
        'id',
        rows.map(row => row.jobId)
      )
      .select('id', 'state', 'leaseToken', 'leaseExpiresAt')
    return rows.map(row =>
      view(
        row,
        leases.find(lease => lease.id === row.jobId)
      )
    )
  }
  return {
    listInTransaction,
    async list(requester: PagePrincipal): Promise<StorageOperationView[]> {
      const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
      try {
        await deps.configuration.reviewState(tx, requester)
        const result = await listInTransaction(tx)
        await tx.commit()
        return result
      } catch (error) {
        await tx.rollback()
        throw error
      }
    },
    async enqueue(requester: PagePrincipal, input: unknown, transaction?: Knex.Transaction): Promise<{ id: string; jobId: string }> {
      const parsed = enqueueSchema.safeParse(input)
      if (!parsed.success) return fail('Provide a target action, current review, confirmation and administrative reason.')
      const enqueue = async (tx: Knex.Transaction) => {
        const saved = await deps.configuration.reviewState(tx, requester, true),
          draft = parsed.data
        assertReview(saved.fingerprint, draft.fingerprint)
        if (await tx('storageOperations').whereIn('state', activeStates).first('id')) return fail('Finish or resolve the current storage operation first.', 409)
        const activation = draft.handler === 'activate' && draft.targetKey === null
        const target = saved.rows.find(row => row.key === draft.targetKey),
          definition = saved.definitions.find(row => row.key === draft.targetKey)
        const action = definition?.actions.find(action => action.handler === draft.handler)
        if (!activation && (!target?.isEnabled || !definition?.isAvailable || !action))
          return fail('Choose an enabled target and one of its available actions.')
        if (!activation && draft.targetKey !== 'disk' && deps.offline(draft.targetKey)) return fail('Remote storage operations are paused in offline mode.', 409)
        const observed = deps.runtime().find(row => row.key === draft.targetKey)
        if (!activation && (!target || !observed?.active || observed.configurationKey !== storageConfigurationKey(target)))
          return fail('Apply the saved settings successfully before running a target action.', 409)
        if (!activation && storageTargetView(target!, definition).issues.length)
          return fail('Resolve the target configuration issues before running this action.')
        const confirmation = activation ? 'APPLY STORAGE SETTINGS' : action!.confirmation
        if (draft.confirmation !== confirmation) return fail('Enter the exact action confirmation.')
        const id = randomUUID(),
          createdAt = now().toISOString()
        const job = await new DurableJobStore(tx).enqueue({ type: 'storage-action', version: 1, maxAttempts: 1, payload: { operationId: id } })
        const principal =
          saved.actorId === null ? { id: 1, ownershipUserId: null, groups: requester!.groups } : { id: saved.actorId, authVersion: requester!.authVersion }
        await tx('storageOperations').insert({
          id,
          jobId: job.id,
          targetKey: draft.targetKey,
          handler: draft.handler,
          state: 'queued',
          actorId: saved.actorId,
          reason: draft.reason,
          requester: JSON.stringify(principal),
          reviewFingerprint: saved.fingerprint,
          configurationRevision: typeof saved.metadata.revision === 'string' ? saved.metadata.revision : '',
          runtimeGeneration: activation ? null : observed!.generation,
          title: activation ? 'Apply saved storage settings' : action!.title,
          effect: activation
            ? 'Stop the previous targets and initialize the enabled targets using saved settings. Initialization can connect to remote services, create destination resources, and synchronize Git content.'
            : action!.effect,
          createdAt,
          startedAt: null,
          completedAt: null,
          result: null,
          resolution: null
        })
        return { id, jobId: job.id }
      }
      return transaction ? enqueue(transaction) : deps.db.transaction(enqueue)
    },
    /** Called while the runtime queue is owned, immediately before the first plugin effect. */
    async begin(job: DurableJob) {
      if (job.type !== 'storage-action' || job.version !== 1 || typeof job.payload.operationId !== 'string') return fail('Invalid storage worker payload.')
      return deps.db.transaction(async tx => {
        const preliminary = await tx<Row>('storageOperations')
          .where({ id: String(job.payload.operationId), jobId: job.id })
          .first()
        if (!preliminary) return fail('The storage operation receipt is missing.', 409)
        const saved = await deps.configuration.reviewState(tx, preliminary.requester, true)
        const { row, lease } = await operation(tx, preliminary.id)
        if (!owns(lease, job) || row.state !== 'queued' || row.startedAt !== null)
          return fail('This storage worker no longer owns an unstarted operation.', 409)
        assertReview(saved.fingerprint, row.reviewFingerprint)
        const activation = row.handler === 'activate' && row.targetKey === null
        const target = saved.rows.find(target => target.key === row.targetKey),
          definition = saved.definitions.find(target => target.key === row.targetKey)
        const observed = deps.runtime().find(target => target.key === row.targetKey)
        if (
          !activation &&
          (!target?.isEnabled ||
            !definition?.isAvailable ||
            !definition.actions.some(action => action.handler === row.handler) ||
            !observed?.active ||
            observed.generation !== row.runtimeGeneration ||
            observed.configurationKey !== storageConfigurationKey(target))
        )
          return fail('The target runtime changed or became unavailable before execution.', 409)
        if (!activation && row.targetKey !== 'disk' && deps.offline(row.targetKey)) return fail('Remote storage operations are paused in offline mode.', 409)
        await tx('storageOperations').where('id', row.id).update({ state: 'running', startedAt: now() })
        return {
          id: row.id,
          targetKey: row.targetKey,
          handler: row.handler,
          runtimeGeneration: row.runtimeGeneration,
          credentials: saved.rows.flatMap(target => {
            const fields = saved.definitions.find(definition => definition.key === target.key)?.fields ?? []
            return Object.entries(storageRecord(target.config))
              .filter(
                ([key, value]) =>
                  typeof value === 'string' && (fields.some(field => field.key === key && field.sensitive) || !fields.some(field => field.key === key))
              )
              .map(([, value]) => String(value))
          })
        }
      })
    },
    async finish(job: DurableJob, input: unknown): Promise<void> {
      const result = StorageOperationResultSchema.safeParse(input)
      if (!result.success) return fail('Invalid storage operation result.')
      await deps.db.transaction(async tx => {
        const { row, lease } = await operation(tx, String(job.payload.operationId))
        if (row.jobId !== job.id || row.state !== 'running' || !owns(lease, job)) return fail('This storage worker no longer owns its result.', 409)
        await tx('storageOperations')
          .where('id', row.id)
          .update({ state: result.data.outcome, result: JSON.stringify(result.data), completedAt: now() })
      })
    },
    async rejectBeforeStart(job: DurableJob): Promise<void> {
      await deps.db.transaction(async tx => {
        const { row, lease } = await operation(tx, String(job.payload.operationId))
        if (row.jobId !== job.id || row.state !== 'queued' || row.startedAt !== null || !owns(lease, job)) return
        await tx('storageOperations')
          .where('id', row.id)
          .update({
            state: 'failed',
            completedAt: now(),
            result: JSON.stringify({
              outcome: 'failed',
              message: 'The operation could not start. Review current permissions, saved settings, runtime activation and offline policy.',
              counts: null,
              items: [],
              targets: []
            })
          })
      })
    },
    async decide(requester: PagePrincipal, input: unknown, kind: 'cancel' | 'resolve'): Promise<void> {
      const parsed = decisionSchema.safeParse(input)
      if (!parsed.success) return fail('Provide the operation, current review, confirmation and reason.')
      await deps.db.transaction(async tx => {
        const saved = await deps.configuration.reviewState(tx, requester, true)
        assertReview(saved.fingerprint, parsed.data.fingerprint)
        const { row, lease } = await operation(tx, parsed.data.id),
          observed = view(row, lease)
        if (kind === 'cancel' ? !observed.canCancel : !observed.canResolve)
          return fail(
            kind === 'cancel'
              ? 'This operation has already started or finished.'
              : 'This operation cannot be resolved while its worker is active or its outcome is already recorded.',
            409
          )
        if (parsed.data.confirmation !== (kind === 'cancel' ? 'CANCEL OPERATION' : 'PRIOR WORKER STOPPED'))
          return fail('Enter the exact recovery confirmation.')
        const completedAt = now().toISOString()
        await tx('storageOperations')
          .where('id', row.id)
          .update({
            state: kind === 'cancel' ? 'cancelled' : 'resolved',
            completedAt,
            resolution: JSON.stringify({ actorId: saved.actorId, reason: parsed.data.reason, createdAt: completedAt })
          })
        if (lease)
          await tx('durableJobs')
            .where('id', lease.id)
            .update({
              state: kind === 'cancel' ? 'cancelled' : 'failed',
              leaseToken: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt,
              updatedAt: completedAt,
              lastError:
                kind === 'cancel'
                  ? 'Cancelled before storage execution.'
                  : 'Uncertain storage outcome acknowledged after operator verification; never replay this job.'
            })
      })
    }
  }
}
