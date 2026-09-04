import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { DurableJobStore, runDurableJobBatch } from '../../core/durable-jobs.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
import { cleanupDurableJobs } from '../../jobs/durable-job-handlers.ts'
import { createContentExtensionRerenderHandler } from '../../jobs/content-extension-rerender.ts'
import type { ContentExtensionRerenderContext } from '../../content-extensions/rerender.ts'

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

describe('portable durable jobs', () => {
  it('creates the versioned payload, lease, retry, and observability columns', async () => {
    const columns = await knex('durableJobs').columnInfo()

    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        'id',
        'type',
        'version',
        'payload',
        'state',
        'attempts',
        'maxAttempts',
        'nextRunAt',
        'leaseOwner',
        'leaseToken',
        'leaseExpiresAt',
        'lastError',
        'deduplicationKey',
        'createdAt',
        'updatedAt',
        'completedAt'
      ])
    )
  })

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

  it('claims and runs only jobs with a supported handler identity', async () => {
    const unsupported = await store.enqueue({
      type: 'unsupported-handler',
      version: 1,
      payload: {},
      nextRunAt: new Date('2026-08-14T10:00:00.000Z')
    })
    const supported = await store.enqueue({
      type: 'supported-handler',
      version: 1,
      payload: {},
      nextRunAt: new Date('2026-08-14T11:00:00.000Z')
    })
    const handler = vi.fn()

    const claimed = await runDurableJobBatch(knex, {
      workerId: 'instance-a',
      limit: 1,
      now: new Date('2026-08-14T12:00:00.000Z'),
      handlers: { 'supported-handler@1': handler }
    })

    expect(claimed).toEqual([expect.objectContaining({ id: supported.id, attempts: 1 })])
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: supported.id }), expect.objectContaining({ knex, signal: expect.any(AbortSignal) }))
    expect(await store.get(supported.id)).toMatchObject({ state: 'succeeded', attempts: 1 })
    expect(await store.get(unsupported.id)).toMatchObject({
      state: 'pending',
      attempts: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null
    })
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

  it('stops content-extension rerender effects after its lease is replaced', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const effects: string[] = []
    let batch: Promise<unknown> | undefined

    try {
      await knex.schema.createTable('pages', table => {
        table.integer('id').primary()
        table.string('hash').notNullable()
        table.text('content').notNullable()
      })
      const content = '```wiki-extension\n{"key":"spoiler","version":1,"props":{"content":"Secret"}}\n```'
      await knex('pages').insert([
        { id: 1, hash: 'first-page', content },
        { id: 2, hash: 'second-page', content }
      ])
      const job = await store.enqueue({
        type: 'rerender-content-extension',
        version: 1,
        payload: { key: 'spoiler' }
      })
      const wiki: ContentExtensionRerenderContext = {
        data: {
          searchEngine: {
            async deleted(page) {
              effects.push(`deleted:${page.id}`)
            },
            async updated(page) {
              effects.push(`updated:${page.id}`)
            }
          }
        },
        events: {
          outbound: {
            emit(_event, hash) {
              effects.push(`emit:${String(hash)}`)
            }
          }
        },
        models: {
          pages: {
            async deletePageFromCache(hash) {
              effects.push(`cache:${hash}`)
            },
            async getPageFromDb(pageId) {
              effects.push(`fetch:${pageId}`)
              return {
                id: pageId,
                hash: pageId === 1 ? 'first-page' : 'second-page',
                content,
                visibility: 'public',
                isPublished: true,
                safeContent: ''
              }
            },
            async prepareSearchDocument(page) {
              effects.push(`prepare:${page.id}`)
              return page
            },
            async renderPage(page) {
              effects.push(`render:${page.id}`)
              entered.resolve()
              await release.promise
            }
          }
        }
      }
      batch = runDurableJobBatch(knex, {
        workerId: 'instance-a',
        leaseMs: 1_000,
        handlers: {
          'rerender-content-extension@1': createContentExtensionRerenderHandler(wiki)
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
      release.resolve()
      await batch

      expect(effects).toEqual(['cache:first-page', 'emit:first-page', 'fetch:1', 'deleted:1', 'render:1'])
      expect(await store.get(job.id)).toMatchObject({
        state: 'running',
        leaseOwner: 'instance-b',
        leaseToken: replacement.leaseToken
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      release.resolve()
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
      lastError: 'Durable job lease expired after its final allowed attempt',
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
})
