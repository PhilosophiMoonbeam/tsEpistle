
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { DurableJobStore, runDurableJobBatch } from '../../core/durable-jobs.ts'
import { up } from '../../db/migrations/2.5.130.ts'
import { cleanupDurableJobs } from '../../jobs/durable-job-handlers.ts'

let knex: Knex
let store: DurableJobStore

beforeEach(async () => {
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await up(knex)
  store = new DurableJobStore(knex)
})

afterEach(async () => {
  await knex.destroy()
})

describe('portable durable jobs', () => {
  it('creates the versioned payload, lease, retry, and observability columns', async () => {
    const columns = await knex('durableJobs').columnInfo()

    expect(Object.keys(columns)).toEqual(expect.arrayContaining([
      'id', 'type', 'version', 'payload', 'state', 'attempts', 'maxAttempts',
      'nextRunAt', 'leaseOwner', 'leaseExpiresAt', 'lastError',
      'deduplicationKey', 'createdAt', 'updatedAt', 'completedAt'
    ]))
  })

  it('allows only one instance to claim a ready job', async () => {
    await store.enqueue({
      type: 'cleanup-durable-jobs',
      version: 1,
      payload: {},
      nextRunAt: new Date('2026-08-14T11:00:00.000Z')
    })
    const now = new Date('2026-08-14T12:00:00.000Z')

    const claims = await Promise.all([
      store.claim({ workerId: 'instance-a', now }),
      store.claim({ workerId: 'instance-b', now })
    ])

    expect(claims.flat()).toHaveLength(1)
    expect(claims.flat()[0].attempts).toBe(1)
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

    await cleanupDurableJobs(claimed ?? proofJob, { knex })
    await cleanupDurableJobs(claimed ?? proofJob, { knex })

    expect(await knex('durableJobs').where('type', 'old-job')).toEqual([])
    expect(pool.numUsed()).toBe(usedBefore)
  })
})
