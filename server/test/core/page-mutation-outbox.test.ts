
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

import {
  claimPageMutationEffects,
  enqueuePageMutationEffects,
  executePageMutationEffect,
  PageMutationOutboxError,
  type PageProjectionSink
} from '../../core/page-mutation-outbox.ts'

let knex: Knex
const location = { locale: 'en', path: 'docs/start', visibility: 'public' as const, ownerId: null }

beforeEach(async () => {
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await knex.schema.createTable('pageMutationOutbox', table => {
    table.uuid('id').primary()
    table.integer('pageId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('effectKind').notNullable()
    table.string('effectKey').notNullable()
    table.string('desiredState').notNullable()
    table.string('payloadSha256').notNullable()
    table.text('payload').notNullable()
    table.string('status').notNullable().defaultTo('pending')
    table.integer('attempts').notNullable().defaultTo(0)
    table.string('leaseOwner').nullable()
    table.uuid('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('availableAt').notNullable()
    table.text('result').nullable()
    table.text('postcondition').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.unique(['pageId', 'sourceRevision', 'effectKind'])
  })
})

afterEach(async () => {
  await knex.destroy()
})

const enqueue = (overrides: Partial<Parameters<typeof enqueuePageMutationEffects>[1]> = {}) => enqueuePageMutationEffects(knex, {
  pageId: 42,
  sourceRevision: '8',
  desiredState: 'present',
  action: 'update',
  source: '# Start\n',
  location,
  ...overrides
})

describe('page mutation projection outbox', () => {
  it('commits immutable render, link, and knowledge intent atomically with the source transaction', async () => {
    await expect(Promise.resolve(knex.transaction(async transaction => {
      await enqueuePageMutationEffects(transaction, {
        pageId: 42,
        sourceRevision: '8',
        desiredState: 'present',
        action: 'update',
        source: '# Start\n',
        location
      })
      throw new Error('source write failed')
    }))).rejects.toThrow('source write failed')
    expect(await knex('pageMutationOutbox')).toEqual([])

    const ids = await enqueue()
    expect(ids).toHaveLength(3)
    expect(await knex('pageMutationOutbox').select('effectKind', 'desiredState', 'status').orderBy('effectKind')).toEqual([
      { effectKind: 'knowledge', desiredState: 'present', status: 'pending' },
      { effectKind: 'links', desiredState: 'present', status: 'pending' },
      { effectKind: 'render', desiredState: 'present', status: 'pending' }
    ])
  })

  it('is idempotent only for byte-identical desired state', async () => {
    const first = await enqueue()
    const second = await enqueue()
    expect(second).toEqual(first)
    expect(await knex('pageMutationOutbox')).toHaveLength(3)
    await expect(Promise.resolve(enqueue({ source: '# Changed\n' }))).rejects.toMatchObject({ code: 'OUTBOX_IDEMPOTENCY_CONFLICT' })
  })

  it('represents deletion without retaining deleted source', async () => {
    await enqueue({ desiredState: 'absent', action: 'delete', source: undefined, location: undefined, previousLocation: location })
    const rows = await knex('pageMutationOutbox').orderBy('effectKind')
    for (const row of rows) {
      expect(JSON.parse(row.payload)).toMatchObject({ desiredState: 'absent', sourceSha256: null, location: null, previousLocation: location })
      expect(row.payload).not.toContain('# Start')
    }
  })

  it('claims in deterministic order with fenced leases and reclaims expiry', async () => {
    await enqueue({ effects: ['render', 'links'] })
    const now = new Date('2100-08-17T00:00:00.000Z')
    const first = await claimPageMutationEffects(knex, { leaseOwner: 'worker-a', limit: 1, leaseMs: 1_000, now })
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ attempts: 1, leaseToken: expect.any(String) })
    expect(await claimPageMutationEffects(knex, { leaseOwner: 'worker-b', limit: 1, leaseMs: 1_000, now })).toHaveLength(1)
    const reclaimed = await claimPageMutationEffects(knex, { leaseOwner: 'worker-c', limit: 2, leaseMs: 1_000, now: new Date(now.valueOf() + 1_001) })
    expect(reclaimed).toHaveLength(2)
    expect(reclaimed.map(item => item.attempts)).toEqual([2, 2])
  })

  it('verifies payload hashes before exposing claimed work', async () => {
    await enqueue({ effects: ['render'] })
    await knex('pageMutationOutbox').update({ payload: '{"tampered":true}' })
    await expect(Promise.resolve(claimPageMutationEffects(knex, { leaseOwner: 'worker' }))).rejects.toMatchObject({ code: 'OUTBOX_PAYLOAD_TAMPERED' })
    expect(await knex('pageMutationOutbox').first()).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('accepts only a conforming sink result that proves the postcondition', async () => {
    await enqueue({ effects: ['render'] })
    const [claim] = await claimPageMutationEffects(knex, { leaseOwner: 'worker' })
    if (!claim) throw new Error('claim missing')
    const reconcile = vi.fn(async () => ({
      result: { rendered: true },
      postcondition: { satisfied: true, observedSourceRevision: '8', detail: 'render hash matches' }
    }))
    const sink: PageProjectionSink = { kind: 'render', reconcile }
    await executePageMutationEffect(knex, claim, new Map([['render', sink]]), new AbortController().signal)
    expect(reconcile).toHaveBeenCalledWith(claim.payload, expect.any(AbortSignal))
    expect(await knex('pageMutationOutbox').first()).toMatchObject({
      status: 'succeeded',
      leaseToken: null,
      postcondition: expect.stringContaining('render hash matches')
    })
  })

  it('fails closed for a missing, malformed, or unsatisfied sink', async () => {
    await enqueue({ effects: ['render'] })
    const [missingClaim] = await claimPageMutationEffects(knex, { leaseOwner: 'worker-a' })
    if (!missingClaim) throw new Error('claim missing')
    await expect(Promise.resolve(executePageMutationEffect(knex, missingClaim, new Map(), new AbortController().signal))).rejects.toMatchObject({ code: 'MISSING_PROJECTION_SINK' })
    expect(await knex('pageMutationOutbox').first()).toMatchObject({ status: 'failed' })

    await knex('pageMutationOutbox').delete()
    await enqueue({ effects: ['render'] })
    const [badClaim] = await claimPageMutationEffects(knex, { leaseOwner: 'worker-b' })
    if (!badClaim) throw new Error('claim missing')
    const badSink = { kind: 'render' as const, reconcile: async () => ({ result: {}, postcondition: { satisfied: false, observedSourceRevision: null, detail: 'mismatch' } }) }
    await expect(Promise.resolve(executePageMutationEffect(knex, badClaim, new Map([['render', badSink]]), new AbortController().signal))).rejects.toBeInstanceOf(PageMutationOutboxError)
    expect(await knex('pageMutationOutbox').first()).toMatchObject({ status: 'failed' })
  })

  it('retries thrown sink errors and rejects stale completion tokens', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    await enqueue({ effects: ['links'] })
    const [claim] = await claimPageMutationEffects(knex, { leaseOwner: 'worker', now: new Date() })
    if (!claim) throw new Error('claim missing')
    const sink = { kind: 'links' as const, reconcile: async () => { throw new Error('temporary') } }
    await expect(Promise.resolve(executePageMutationEffect(knex, claim, new Map([['links', sink]]), new AbortController().signal))).rejects.toThrow('temporary')
    expect(await knex('pageMutationOutbox').first()).toMatchObject({ status: 'retry', attempts: 1, leaseToken: null })
    await knex('pageMutationOutbox').update({ status: 'running', leaseToken: '00000000-0000-4000-8000-000000000099' })
    const goodSink = { kind: 'links' as const, reconcile: async () => ({ result: {}, postcondition: { satisfied: true, observedSourceRevision: '8', detail: 'ok' } }) }
    await expect(Promise.resolve(executePageMutationEffect(knex, claim, new Map([['links', goodSink]]), new AbortController().signal))).rejects.toMatchObject({ code: 'PROJECTION_LEASE_LOST' })
    vi.useRealTimers()
  })
})
