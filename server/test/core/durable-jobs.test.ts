import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { DurableJobStore, runDurableJobBatch } from '../../core/durable-jobs.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
// Asset relocation captures WIKI during module initialization, so seed the test fixture before loading the handler registry.
global.WIKI = {}
const { cleanupDurableJobs } = await import('../../jobs/durable-job-handlers.ts')

let knex: Knex
let store: DurableJobStore

beforeEach(async () => {
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await createDurableJobs(knex)
  await addDurableJobLeaseToken(knex)
  store = new DurableJobStore(knex)
})

afterEach(async () => {
  await knex.destroy()
})

const oldCleanupJob = (id: string, state: string, completedAt: Date | null = new Date('2026-01-01T00:00:00.000Z'), type = 'old-job') => ({
  id,
  type,
  version: 1,
  payload: '{}',
  state,
  attempts: 1,
  maxAttempts: 1,
  nextRunAt: new Date('2026-01-01T00:00:00.000Z'),
  leaseOwner: null,
  leaseExpiresAt: null,
  leaseToken: null,
  lastError: null,
  deduplicationKey: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  completedAt
})

const insertCleanupBacklog = async (total: number): Promise<void> => {
  const terminalStates = ['succeeded', 'failed', 'cancelled']
  for (let offset = 0; offset < total; offset += 100) {
    const rows = Array.from({ length: Math.min(100, total - offset) }, (_, index) =>
      oldCleanupJob(`00000000-0000-4000-8000-${String(offset + index + 1000).padStart(12, '0')}`, terminalStates[(offset + index) % 3]!)
    )
    await knex('durableJobs').insert(rows)
  }
}

describe('portable durable jobs', () => {
  it('allows only one instance to claim a ready job', async () => {
    await store.enqueue({
      type: 'cleanup-durable-jobs',
      version: 1,
      payload: {},
      nextRunAt: new Date('2026-08-14T11:00:00.000Z')
    })
    const now = new Date('2026-08-14T12:00:00.000Z')

    const claims = await Promise.all([store.claim({ workerId: 'instance-a', now }), store.claim({ workerId: 'instance-b', now })])

    expect(claims.flat()).toHaveLength(1)
    expect(claims.flat()[0].attempts).toBe(1)
  })

  it('claims and runs only jobs with a supported handler type and version', async () => {
    const unsupported = await store.enqueue({
      type: 'unsupported-handler',
      version: 5,
      payload: {},
      nextRunAt: new Date('2026-08-14T10:00:00.000Z')
    })
    const unsupportedVersion = await store.enqueue({
      type: 'process-site-logo',
      version: 4,
      payload: {},
      nextRunAt: new Date('2026-08-14T10:30:00.000Z')
    })
    const supported = await store.enqueue({
      type: 'process-site-logo',
      version: 5,
      payload: {},
      nextRunAt: new Date('2026-08-14T11:00:00.000Z')
    })
    const handler = vi.fn()

    const claimed = await runDurableJobBatch(knex, {
      workerId: 'instance-a',
      limit: 1,
      now: new Date('2026-08-14T12:00:00.000Z'),
      handlers: { 'process-site-logo@5': handler }
    })

    expect(claimed).toEqual([expect.objectContaining({ id: supported.id, version: 5, attempts: 1 })])
    expect(handler).toHaveBeenCalledOnce()
    expect(await store.get(supported.id)).toMatchObject({ state: 'succeeded', attempts: 1 })
    for (const job of [unsupported, unsupportedVersion]) {
      expect(await store.get(job.id)).toMatchObject({
        state: 'pending',
        attempts: 0,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: null
      })
    }
  })

  it('renews the lease while a handler remains blocked', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let batch: Promise<unknown> | undefined

    try {
      const job = await store.enqueue({
        type: 'blocked-handler',
        version: 1,
        payload: {}
      })
      batch = runDurableJobBatch(knex, {
        workerId: 'instance-a',
        leaseMs: 1_000,
        handlers: {
          'blocked-handler@1': async () => {
            entered.resolve()
            await release.promise
          }
        }
      })
      await entered.promise

      await vi.advanceTimersByTimeAsync(500)
      await vi.advanceTimersByTimeAsync(501)

      expect(
        await store.claim({
          workerId: 'instance-b',
          leaseMs: 1_000,
          now: new Date()
        })
      ).toEqual([])

      release.resolve()
      await batch
      expect(await store.get(job.id)).toMatchObject({ state: 'succeeded', attempts: 1 })
    } finally {
      release.resolve()
      await batch?.catch(() => undefined)
      vi.useRealTimers()
    }
  })

  it('aborts an in-flight handler when its lease is replaced', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'))
    const entered = Promise.withResolvers<void>()
    const stopWaiting = Promise.withResolvers<void>()
    const sideEffects: string[] = []
    let batch: Promise<unknown> | undefined

    try {
      const job = await store.enqueue({
        type: 'lease-sensitive-handler',
        version: 1,
        payload: {}
      })
      batch = runDurableJobBatch(knex, {
        workerId: 'instance-a',
        leaseMs: 1_000,
        handlers: {
          'lease-sensitive-handler@1': async (_job, { signal }) => {
            sideEffects.push('first')
            entered.resolve()
            const aborted = Promise.withResolvers<void>()
            const onAbort = (): void => aborted.resolve()
            if (signal.aborted) aborted.resolve()
            else signal.addEventListener('abort', onAbort, { once: true })
            try {
              await Promise.race([aborted.promise, stopWaiting.promise])
            } finally {
              signal.removeEventListener('abort', onAbort)
            }
            signal.throwIfAborted()
            sideEffects.push('second')
          }
        }
      })
      await entered.promise

      const [replacement] = await store.claim({
        workerId: 'instance-b',
        leaseMs: 1_000,
        now: new Date('2026-08-14T12:00:02.000Z')
      })
      expect(replacement).toMatchObject({ id: job.id, leaseOwner: 'instance-b', attempts: 2 })

      await vi.advanceTimersByTimeAsync(500)
      await batch

      expect(sideEffects).toEqual(['first'])
      expect(await store.get(job.id)).toMatchObject({
        state: 'running',
        leaseOwner: 'instance-b',
        leaseToken: replacement.leaseToken
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      stopWaiting.resolve()
      await batch?.catch(() => undefined)
      vi.useRealTimers()
    }
  })

  it('recovers an expired lease after a worker disappears', async () => {
    await store.enqueue({
      type: 'cleanup-durable-jobs',
      version: 1,
      payload: {},
      nextRunAt: new Date('2026-08-14T11:00:00.000Z')
    })
    const first = await store.claim({
      workerId: 'instance-a',
      leaseMs: 1_000,
      now: new Date('2026-08-14T12:00:00.000Z')
    })

    const recovered = await store.claim({
      workerId: 'instance-b',
      leaseMs: 1_000,
      now: new Date('2026-08-14T12:00:02.000Z')
    })

    expect(first).toHaveLength(1)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      id: first[0].id,
      leaseOwner: 'instance-b',
      attempts: 2
    })
  })

  it('terminally fails an expired lease after the final allowed attempt', async () => {
    const job = await store.enqueue({
      type: 'cleanup-durable-jobs',
      version: 1,
      payload: {},
      maxAttempts: 1,
      nextRunAt: new Date('2026-08-14T11:00:00.000Z')
    })
    const claimed = await store.claim({
      workerId: 'instance-a',
      leaseMs: 1_000,
      now: new Date('2026-08-14T12:00:00.000Z')
    })
    const recoveredAt = new Date('2026-08-14T12:00:02.000Z')

    expect(claimed).toHaveLength(1)
    expect(await store.claim({ workerId: 'instance-b', leaseMs: 1_000, now: recoveredAt })).toEqual([])
    expect(await store.complete(claimed[0], new Date('2026-08-14T12:00:03.000Z'))).toBe(false)
    expect(await store.get(job.id)).toMatchObject({
      state: 'failed',
      attempts: 1,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: expect.any(String),
      completedAt: recoveredAt,
      updatedAt: recoveredAt
    })
  })

  it('rejects stale lease operations after a replacement claim', async () => {
    await store.enqueue({
      type: 'cleanup-durable-jobs',
      version: 1,
      payload: {},
      nextRunAt: new Date('2026-08-14T11:00:00.000Z')
    })
    const [first] = await store.claim({
      workerId: 'instance-a',
      leaseMs: 1_000,
      now: new Date('2026-08-14T12:00:00.000Z')
    })
    const [replacement] = await store.claim({
      workerId: 'instance-a',
      leaseMs: 1_000,
      now: new Date('2026-08-14T12:00:02.000Z')
    })

    expect(first.leaseToken).not.toBe(replacement.leaseToken)
    expect(await store.extendLease(first, 1_000, new Date('2026-08-14T12:00:02.100Z'))).toBe(false)
    expect(await store.complete(first, new Date('2026-08-14T12:00:02.100Z'))).toBe(false)
    expect(await store.fail(first, new Error('stale failure'), () => 0, new Date('2026-08-14T12:00:02.100Z'))).toBe(false)
    expect(await store.get(first.id)).toMatchObject({
      state: 'running',
      attempts: 2,
      leaseToken: replacement.leaseToken,
      lastError: null
    })
  })

  it('applies bounded retries and records terminal failure', async () => {
    const job = await store.enqueue({
      type: 'always-fails',
      version: 1,
      payload: { value: 7 },
      maxAttempts: 2
    })
    const handler = vi.fn().mockRejectedValue(new Error('proof failure'))

    await runDurableJobBatch(knex, {
      workerId: 'instance-a',
      handlers: { 'always-fails@1': handler },
      retryDelay: () => 0
    })
    await runDurableJobBatch(knex, {
      workerId: 'instance-a',
      handlers: { 'always-fails@1': handler },
      retryDelay: () => 0
    })

    expect(await store.get(job.id)).toMatchObject({
      attempts: 2,
      state: 'failed',
      lastError: expect.stringContaining('proof failure')
    })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('runs the cleanup proof idempotently without retaining a connection', async () => {
    const oldDate = new Date('2026-01-01T00:00:00.000Z')
    await knex('durableJobs').insert({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'old-job',
      version: 1,
      payload: '{}',
      state: 'succeeded',
      attempts: 1,
      maxAttempts: 1,
      nextRunAt: oldDate,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      deduplicationKey: null,
      createdAt: oldDate,
      updatedAt: oldDate,
      completedAt: oldDate
    })
    const proofJob = await store.enqueue({ type: 'cleanup-durable-jobs', version: 1, payload: {} })
    const [claimed] = await store.claim({ workerId: 'instance-a' })
    const pool = knex.client.pool
    const usedBefore = pool.numUsed()
    const signal = new AbortController().signal

    await cleanupDurableJobs(claimed ?? proofJob, { knex, signal })
    await cleanupDurableJobs(claimed ?? proofJob, { knex, signal })

    expect(await knex('durableJobs').where('type', 'old-job')).toEqual([])
    expect(pool.numUsed()).toBe(usedBefore)
  })

  it('drains cleanup backlogs in at most 500-row handlers with deduplicated continuations and preserved data', async () => {
    await insertCleanupBacklog(1100)
    await knex.schema.createTable('assetRelocationEffects', table => {
      table.uuid('id').primary()
      table.uuid('jobId').notNullable().references('id').inTable('durableJobs').onDelete('CASCADE')
      table.string('status', 16).notNullable()
    })
    const recent = new Date()
    const retained = [
      oldCleanupJob('00000000-0000-4000-8000-000000000010', 'pending', null),
      oldCleanupJob('00000000-0000-4000-8000-000000000011', 'running', null),
      oldCleanupJob('00000000-0000-4000-8000-000000000012', 'succeeded', recent),
      oldCleanupJob('00000000-0000-4000-8000-000000000013', 'failed', recent),
      oldCleanupJob('00000000-0000-4000-8000-000000000014', 'cancelled', recent),
      oldCleanupJob('00000000-0000-4000-8000-000000000015', 'failed', undefined, 'asset-relocation'),
      oldCleanupJob('00000000-0000-4000-8000-000000000016', 'cancelled', undefined, 'asset-relocation')
    ]
    const resolved = oldCleanupJob('00000000-0000-4000-8000-000000000017', 'succeeded', undefined, 'asset-relocation')
    await knex('durableJobs').insert([...retained, resolved])
    await knex('assetRelocationEffects').insert([
      { id: '00000000-0000-4000-8000-000000000115', jobId: retained[5]!.id, status: 'failed' },
      { id: '00000000-0000-4000-8000-000000000117', jobId: resolved.id, status: 'succeeded' }
    ])
    const beforeRetained = await knex('durableJobs')
      .whereIn(
        'id',
        retained.map(job => job.id)
      )
      .orderBy('id')
    const job = await store.enqueue({ type: 'cleanup-durable-jobs', version: 1, payload: {}, maxAttempts: 3 })
    const [claimed] = await store.claim({ workerId: 'cleanup-worker', limit: 1, supportedIdentities: ['cleanup-durable-jobs@1'] })
    expect(claimed?.id).toBe(job.id)
    if (!claimed) throw new Error('Cleanup job was not claimed')
    const context = { knex, signal: new AbortController().signal }

    await cleanupDurableJobs(claimed, context)

    expect(
      await knex('durableJobs')
        .whereNotIn(
          'id',
          retained.map(job => job.id)
        )
        .whereNot('type', 'cleanup-durable-jobs')
    ).toHaveLength(601)
    const [continuation] = await knex('durableJobs').where({ type: 'cleanup-durable-jobs', state: 'pending' })
    expect(continuation).toMatchObject({ version: 1, payload: '{}', attempts: 0 })
    expect(await knex('durableJobs').where({ type: 'cleanup-durable-jobs', state: 'pending' })).toHaveLength(1)

    // A retried handler must reuse its queued continuation, not create a second cleanup chain.
    await cleanupDurableJobs(claimed, context)

    expect(
      await knex('durableJobs')
        .whereNotIn(
          'id',
          retained.map(job => job.id)
        )
        .whereNot('type', 'cleanup-durable-jobs')
    ).toHaveLength(101)
    expect(await knex('durableJobs').where({ type: 'cleanup-durable-jobs', state: 'pending' })).toEqual([continuation])
    expect(await store.complete(claimed)).toBe(true)
    const batch = await runDurableJobBatch(knex, {
      workerId: 'cleanup-worker',
      limit: 1,
      handlers: { 'cleanup-durable-jobs@1': cleanupDurableJobs }
    })

    expect(batch).toEqual([expect.objectContaining({ id: continuation.id })])
    expect(await knex('durableJobs').where('type', 'old-job')).toHaveLength(5)
    expect(await knex('durableJobs').where({ id: resolved.id })).toEqual([])
    expect(await knex('durableJobs').where({ type: 'cleanup-durable-jobs', state: 'pending' })).toEqual([])
    expect(
      await knex('durableJobs')
        .whereIn(
          'id',
          retained.map(job => job.id)
        )
        .orderBy('id')
    ).toEqual(beforeRetained)
    expect(await knex('assetRelocationEffects')).toEqual([{ id: '00000000-0000-4000-8000-000000000115', jobId: retained[5]!.id, status: 'failed' }])
  })

  it('rolls back bounded cleanup when continuation persistence fails and retries without losing the backlog', async () => {
    await insertCleanupBacklog(501)
    const job = await store.enqueue({ type: 'cleanup-durable-jobs', version: 1, payload: {} })
    const context = { knex, signal: new AbortController().signal }
    await knex.raw(`CREATE TRIGGER reject_cleanup_continuation BEFORE INSERT ON durableJobs
      WHEN NEW.type = 'cleanup-durable-jobs'
      BEGIN SELECT RAISE(ABORT, 'continuation persistence failed'); END`)

    await expect(cleanupDurableJobs(job, context)).rejects.toThrow('continuation persistence failed')

    expect(await knex('durableJobs').where('type', 'old-job')).toHaveLength(501)
    expect(await knex('durableJobs').where('type', 'cleanup-durable-jobs')).toHaveLength(1)
    expect(knex.client.pool.numUsed()).toBe(0)
    await knex.raw('DROP TRIGGER reject_cleanup_continuation')

    await cleanupDurableJobs(job, context)

    expect(await knex('durableJobs').where('type', 'old-job')).toHaveLength(1)
    const continuations = await knex('durableJobs').where({ type: 'cleanup-durable-jobs', state: 'pending' }).whereNot('id', job.id)
    expect(continuations).toHaveLength(1)
    expect(continuations[0]).toMatchObject({ version: 1, payload: '{}', attempts: 0 })
    expect(knex.client.pool.numUsed()).toBe(0)
  })

  it('retains old unresolved asset relocation evidence and reservations', async () => {
    const oldDate = new Date('2026-01-01T00:00:00.000Z')
    await knex.schema.createTable('assetRelocationEffects', table => {
      table.uuid('id').primary()
      table.uuid('jobId').notNullable().references('id').inTable('durableJobs').onDelete('CASCADE')
      table.string('status', 16).notNullable()
    })
    const unresolvedJobId = '00000000-0000-4000-8000-000000000002'
    const resolvedJobId = '00000000-0000-4000-8000-000000000003'
    const durableJob = (id: string, type: string, state: 'failed' | 'succeeded') => ({
      id,
      type,
      version: 1,
      payload: '{}',
      state,
      attempts: 1,
      maxAttempts: 1,
      nextRunAt: oldDate,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: state === 'failed' ? 'failed' : null,
      deduplicationKey: null,
      createdAt: oldDate,
      updatedAt: oldDate,
      completedAt: oldDate
    })
    await knex('durableJobs').insert([durableJob(unresolvedJobId, 'asset-relocation', 'failed'), durableJob(resolvedJobId, 'asset-relocation', 'succeeded')])
    await knex('assetRelocationEffects').insert([
      { id: '00000000-0000-4000-8000-000000000012', jobId: unresolvedJobId, status: 'failed' },
      { id: '00000000-0000-4000-8000-000000000013', jobId: resolvedJobId, status: 'succeeded' }
    ])

    const proofJob = await store.enqueue({ type: 'cleanup-durable-jobs', version: 1, payload: {} })
    await cleanupDurableJobs(proofJob, { knex, signal: new AbortController().signal })

    expect(await knex('durableJobs').where({ id: unresolvedJobId })).toHaveLength(1)
    expect(await knex('assetRelocationEffects').where({ jobId: unresolvedJobId })).toHaveLength(1)
    expect(await knex('durableJobs').where({ id: resolvedJobId })).toHaveLength(0)
    expect(await knex('assetRelocationEffects').where({ jobId: resolvedJobId })).toHaveLength(0)
  })
})
