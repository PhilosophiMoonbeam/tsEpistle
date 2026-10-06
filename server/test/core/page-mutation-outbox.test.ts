import { createHash } from 'node:crypto'
import createKnex from 'knex'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

import {
  admitPageRenderEffect,
  claimPageMutationEffects,
  enqueuePageMutationEffects,
  executePageMutationEffect,
  readPageRenderEffectStatus,
  rearmPageMutationEffect,
  supersedeStalePageRenderEffects,
  PageProjectionLifecycle,
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
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.bigInteger('sourceRevision').notNullable()
    table.bigInteger('renderedSourceRevision').nullable()
    table.text('content').notNullable()
    table.text('render').notNullable()
    table.text('toc').notNullable().defaultTo('[]')
    table.boolean('isPublished').notNullable().defaultTo(true)
    table.boolean('isSearchable').notNullable().defaultTo(true)
    table.dateTime('publishStartDate').nullable()
    table.dateTime('publishEndDate').nullable()
    table.string('localeCode').notNullable()
    table.string('path').notNullable()
    table.string('visibility').notNullable()
    table.integer('ownerId').nullable()
  })
  await knex.schema.createTable('pageLinks', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.string('localeCode').notNullable()
    table.string('path').notNullable()
    table.unique(['pageId', 'localeCode', 'path'])
  })
  await knex.schema.createTable('pagesVector', table => {
    table.integer('pageId').primary()
    table.bigInteger('sourceRevision').notNullable()
  })
  await knex.schema.createTable('pagesWords', table => {
    table.integer('pageId').notNullable()
    table.string('word').notNullable()
    table.primary(['pageId', 'word'])
  })
  await knex.schema.createTable('pageAccessPasswords', table => {
    table.integer('pageId').primary()
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await knex.destroy()
})

const enqueue = (overrides: Partial<Parameters<typeof enqueuePageMutationEffects>[1]> = {}) =>
  enqueuePageMutationEffects(knex, {
    pageId: 42,
    sourceRevision: '8',
    desiredState: 'present',
    action: 'update',
    source: '# Start\n',
    location,
    ...overrides
  })

const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

const waitForProjectionStart = (started: Promise<void>, running: Promise<unknown>) =>
  Promise.race([
    started,
    running.then(() => {
      throw new Error('Lifecycle completed without starting the required projection')
    })
  ])

const projectionPage = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  sourceRevision: 8,
  renderedSourceRevision: 8,
  content: '# Start\n',
  render: '<p>currentbody</p>',
  isPublished: true,
  isSearchable: true,
  publishStartDate: null,
  publishEndDate: null,
  localeCode: 'en',
  path: 'docs/start',
  visibility: 'public',
  ownerId: null,
  ...overrides
})

describe('page mutation projection outbox', () => {
  it('commits immutable render, link, search, and knowledge intent atomically with the source transaction', async () => {
    await expect(
      Promise.resolve(
        knex.transaction(async transaction => {
          await enqueuePageMutationEffects(transaction, {
            pageId: 42,
            sourceRevision: '8',
            desiredState: 'present',
            action: 'update',
            source: '# Start\n',
            location
          })
          throw new Error('source write failed')
        })
      )
    ).rejects.toThrow('source write failed')
    expect(await knex('pageMutationOutbox')).toEqual([])

    const ids = await enqueue()
    expect(ids).toHaveLength(4)
    expect(await knex('pageMutationOutbox').select('effectKind', 'desiredState', 'status').orderBy('effectKind')).toEqual([
      { effectKind: 'knowledge', desiredState: 'present', status: 'pending' },
      { effectKind: 'links', desiredState: 'present', status: 'pending' },
      { effectKind: 'render', desiredState: 'present', status: 'pending' },
      { effectKind: 'search', desiredState: 'present', status: 'pending' }
    ])
  })

  it('is idempotent only for byte-identical desired state', async () => {
    const first = await enqueue()
    const second = await enqueue()
    expect(second).toEqual(first)
    expect(await knex('pageMutationOutbox')).toHaveLength(4)
    await expect(Promise.resolve(enqueue({ source: '# Changed\n' }))).rejects.toMatchObject({ code: 'OUTBOX_IDEMPOTENCY_CONFLICT' })
  })
  it('coalesces same-revision render admission and rearms terminal work without changing immutable payload', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 8,
      content: '# Start\n',
      render: '<p>Start</p>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    const first = await knex.transaction(transaction => admitPageRenderEffect(transaction, { pageId: 42, sourceRevision: '8', source: '# Start\n', location }))
    const original = await knex('pageMutationOutbox').where({ id: first.effectId }).first()
    if (!original) throw new Error('effect missing')
    const second = await knex.transaction(transaction => admitPageRenderEffect(transaction, { pageId: 42, sourceRevision: '8', source: '# Start\n', location }))
    expect(second).toEqual(first)
    await knex('pageMutationOutbox').where({ id: first.effectId }).update({
      status: 'succeeded',
      attempts: 4,
      result: '{"rendered":true}',
      postcondition: '{"satisfied":true}'
    })
    await knex.transaction(transaction => admitPageRenderEffect(transaction, { pageId: 42, sourceRevision: '8', source: '# Start\n', location }))
    expect(await knex('pageMutationOutbox').where({ id: first.effectId }).first()).toMatchObject({
      payload: original.payload,
      payloadSha256: original.payloadSha256,
      effectKey: original.effectKey,
      status: 'retry',
      attempts: 0,
      leaseToken: null
    })
  })

  it('reports an older render intent as superseded after the page source revision changes', async () => {
    const [effectId] = await enqueue({ effects: ['render'] })
    if (!effectId) throw new Error('effect missing')
    await knex('pages').insert({
      id: 42,
      sourceRevision: 9,
      renderedSourceRevision: 8,
      content: '# Changed\n',
      render: '<p>old render</p>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await knex.transaction(transaction => supersedeStalePageRenderEffects(transaction, { pageId: 42, sourceRevision: '9' }))
    const persisted = await knex('pageMutationOutbox').where({ id: effectId }).first('status', 'result')
    expect(persisted.status).toBe('superseded')
    expect(JSON.parse(persisted.result)).toMatchObject({ superseded: true })
    await expect(readPageRenderEffectStatus(knex, { effectId })).resolves.toMatchObject({
      effectId,
      pageId: 42,
      sourceRevision: '8',
      status: 'superseded'
    })
  })

  it('represents deletion without retaining deleted source', async () => {
    await enqueue({ desiredState: 'absent', action: 'delete', source: undefined, location: undefined, previousLocation: location })
    const rows = await knex('pageMutationOutbox').orderBy('effectKind')
    expect(rows.map(row => row.effectKind)).toEqual(['knowledge', 'links', 'render', 'search'])
    for (const row of rows) {
      expect(JSON.parse(row.payload)).toMatchObject({ desiredState: 'absent', sourceSha256: null, location: null, previousLocation: location })
      expect(row.payload).not.toContain('# Start')
    }
  })

  it('claims in deterministic order with fenced leases and reclaims expiry', async () => {
    const [renderId, knowledgeId] = await enqueue({ effects: ['render', 'knowledge'] })
    if (!renderId || !knowledgeId) throw new Error('effects missing')
    await knex('pageMutationOutbox').where({ id: knowledgeId }).update({
      availableAt: '2100-08-15T00:00:00.000Z',
      createdAt: '2100-08-15T00:00:00.000Z'
    })
    await knex('pageMutationOutbox').where({ id: renderId }).update({
      availableAt: '2100-08-16T00:00:00.000Z',
      createdAt: '2100-08-16T00:00:00.000Z'
    })
    const now = new Date('2100-08-17T00:00:00.000Z')
    const first = await claimPageMutationEffects(knex, { leaseOwner: 'worker-a', limit: 1, leaseMs: 1_000, now })
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ attempts: 1, leaseToken: expect.any(String) })
    expect(first.map(item => item.id)).toEqual([knowledgeId])
    const second = await claimPageMutationEffects(knex, { leaseOwner: 'worker-b', limit: 1, leaseMs: 1_000, now })
    expect(second).toHaveLength(1)
    expect(second.map(item => item.id)).toEqual([renderId])
    expect(await claimPageMutationEffects(knex, { leaseOwner: 'worker-d', limit: 2, leaseMs: 1_000, now })).toEqual([])
    const reclaimed = await claimPageMutationEffects(knex, { leaseOwner: 'worker-c', limit: 2, leaseMs: 1_000, now: new Date(now.valueOf() + 1_001) })
    expect(reclaimed).toHaveLength(2)
    expect(reclaimed.map(item => item.attempts)).toEqual([2, 2])
    expect(reclaimed.map(item => item.id)).toEqual([knowledgeId, renderId])
    for (const original of [...first, ...second]) {
      expect(reclaimed.find(item => item.id === original.id)?.leaseToken).not.toBe(original.leaseToken)
    }
  })

  it('optionally bounds a claim to unexpired active leases while leaving unconstrained effects unchanged', async () => {
    await enqueue({ effects: ['knowledge'] })
    await enqueue({
      pageId: 43,
      sourceRevision: '9',
      effects: ['knowledge'],
      location: { ...location, path: 'docs/next' }
    })
    await enqueue({
      pageId: 44,
      sourceRevision: '10',
      effects: ['knowledge'],
      location: { ...location, path: 'docs/later' }
    })
    const now = new Date('2100-08-18T00:00:00.000Z')
    const first = await claimPageMutationEffects(knex, {
      leaseOwner: 'limited-worker-a',
      limit: 2,
      maxActive: 2,
      leaseMs: 1_000,
      effects: ['knowledge'],
      now
    })
    expect(first).toHaveLength(2)
    expect(
      await claimPageMutationEffects(knex, {
        leaseOwner: 'limited-worker-b',
        limit: 2,
        maxActive: 2,
        leaseMs: 1_000,
        effects: ['knowledge'],
        now
      })
    ).toEqual([])

    await knex('pageMutationOutbox').where({ id: first[0]?.id }).update({
      status: 'succeeded',
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null
    })
    const freed = await claimPageMutationEffects(knex, {
      leaseOwner: 'limited-worker-c',
      limit: 2,
      maxActive: 2,
      leaseMs: 1_000,
      effects: ['knowledge'],
      now
    })
    expect(freed).toHaveLength(1)

    const recovered = await claimPageMutationEffects(knex, {
      leaseOwner: 'limited-worker-d',
      limit: 2,
      maxActive: 2,
      leaseMs: 1_000,
      effects: ['knowledge'],
      now: new Date(now.valueOf() + 1_001)
    })
    expect(recovered).toHaveLength(2)
    expect(recovered.map(claim => claim.attempts)).toEqual([2, 2])

    await enqueue({
      pageId: 45,
      sourceRevision: '11',
      effects: ['render'],
      location: { ...location, path: 'docs/render' }
    })
    expect(
      await claimPageMutationEffects(knex, {
        leaseOwner: 'unconstrained-render-worker',
        limit: 1,
        effects: ['render'],
        now
      })
    ).toHaveLength(1)
  })

  it('returns no claims after an empty selection or a corrupt-only selection is exhausted', async () => {
    expect(await claimPageMutationEffects(knex, { leaseOwner: 'empty-worker', effects: ['knowledge'] })).toEqual([])

    const [poisonId] = await enqueue({ effects: ['render'] })
    if (!poisonId) throw new Error('effect missing')
    const malformed = '{'
    await knex('pageMutationOutbox')
      .where({ id: poisonId })
      .update({
        payload: malformed,
        payloadSha256: createHash('sha256').update(malformed).digest('hex')
      })

    expect(await claimPageMutationEffects(knex, { leaseOwner: 'quarantine-worker', effects: ['render'] })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ id: poisonId }).first('status', 'attempts')).toMatchObject({ status: 'failed', attempts: 0 })
  })

  it.each([undefined, 1])('preserves expired-lease scope after empty claims with maxActive %s', async maxActive => {
    const now = new Date('2100-08-18T00:00:00.000Z')
    const input = { leaseOwner: 'empty-then-ready', effects: ['knowledge'] as const, maxActive, now }
    expect(await claimPageMutationEffects(knex, input)).toEqual([])
    const [renderId] = await enqueue({ effects: ['render'] })
    await knex('pageMutationOutbox')
      .where({ id: renderId })
      .update({
        status: 'running',
        leaseOwner: 'expired-render-worker',
        leaseToken: '00000000-0000-4000-8000-000000000099',
        leaseExpiresAt: new Date(now.valueOf() - 1).toISOString()
      })
    expect(await claimPageMutationEffects(knex, input)).toEqual([])
    expect(await knex('pageMutationOutbox').where({ id: renderId }).first('status')).toEqual({
      status: maxActive === undefined ? 'pending' : 'running'
    })
    const [knowledgeId] = await enqueue({ effects: ['knowledge'] })
    expect(await claimPageMutationEffects(knex, input)).toEqual([
      expect.objectContaining({ id: knowledgeId, attempts: 1, payload: expect.objectContaining({ effectKind: 'knowledge' }) })
    ])
  })

  it('does not reclaim retry work carrying an unexpired lease token', async () => {
    const [id] = await enqueue({ effects: ['render'] })
    if (!id) throw new Error('effect missing')
    const now = new Date('2100-08-18T00:00:00.000Z')
    await knex('pageMutationOutbox')
      .where({ id })
      .update({
        status: 'retry',
        leaseOwner: 'still-running',
        leaseToken: '00000000-0000-4000-8000-000000000099',
        leaseExpiresAt: new Date(now.valueOf() + 60_000).toISOString()
      })

    expect(await claimPageMutationEffects(knex, { leaseOwner: 'replacement-worker', effects: ['render'], now })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ id }).first('status', 'attempts')).toMatchObject({ status: 'retry', attempts: 0 })
  })

  it('quarantines malformed work and claims the next valid row without exposing poison to a sink', async () => {
    const [poisonId] = await enqueue({ effects: ['render'] })
    const [validId] = await enqueue({
      pageId: 43,
      sourceRevision: '9',
      effects: ['render'],
      location: { ...location, path: 'docs/next' }
    })
    if (!poisonId || !validId) throw new Error('effect missing')
    const malformed = '{'
    await knex('pageMutationOutbox')
      .where({ id: poisonId })
      .update({
        payload: malformed,
        payloadSha256: createHash('sha256').update(malformed).digest('hex'),
        availableAt: '2100-08-16T00:00:00.000Z',
        createdAt: '2100-08-16T00:00:00.000Z'
      })
    await knex('pageMutationOutbox').where({ id: validId }).update({
      availableAt: '2100-08-17T00:00:00.000Z',
      createdAt: '2100-08-17T00:00:00.000Z'
    })

    const [claim] = await claimPageMutationEffects(knex, {
      leaseOwner: 'worker',
      limit: 1,
      now: new Date('2100-08-18T00:00:00.000Z')
    })
    if (!claim) throw new Error('claim missing')
    expect(claim).toMatchObject({ id: validId, attempts: 1, payload: { pageId: 43 } })
    const reconcile = vi.fn(async () => ({
      result: { rendered: true },
      postcondition: { satisfied: true, observedSourceRevision: '9', detail: 'ok' }
    }))
    await executePageMutationEffect(knex, claim, new Map([['render', { kind: 'render' as const, reconcile }]]), new AbortController().signal)

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ pageId: 43 }), expect.any(AbortSignal), claim)
    const poison = await knex('pageMutationOutbox').where({ id: poisonId }).first()
    expect(poison).toMatchObject({ status: 'failed', attempts: 0, leaseToken: null })
    expect(JSON.parse(poison.result)).toMatchObject({ quarantined: true, code: 'INVALID_OUTBOX_PAYLOAD' })
    expect(poison.result.length).toBeLessThan(1_300)
  })

  it('claims present links only after exact render success without consuming attempts while blocked', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 7,
      content: '# Start\n',
      render: '<p>old render</p>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['links'] })
    const now = new Date('2100-08-17T00:00:00.000Z')

    expect(await claimPageMutationEffects(knex, { leaseOwner: 'links-missing-render', effects: ['links'], now })).toEqual([])
    await enqueue({ effects: ['render'] })
    expect(await claimPageMutationEffects(knex, { leaseOwner: 'links-pending', effects: ['links'], now })).toEqual([])
    const [renderClaim] = await claimPageMutationEffects(knex, { leaseOwner: 'render', effects: ['render'], now })
    if (!renderClaim) throw new Error('render claim missing')
    expect(await claimPageMutationEffects(knex, { leaseOwner: 'links-running', effects: ['links'], now })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ effectKind: 'links' }).first('status', 'attempts')).toMatchObject({
      status: 'pending',
      attempts: 0
    })

    await knex('pageMutationOutbox')
      .where({ id: renderClaim.id })
      .update({
        status: 'retry',
        availableAt: new Date(now.valueOf() + 60_000).toISOString(),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null
      })
    expect(await claimPageMutationEffects(knex, { leaseOwner: 'links-retry', effects: ['links'], now })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ effectKind: 'links' }).first('attempts')).toMatchObject({ attempts: 0 })

    await knex('pageMutationOutbox').where({ id: renderClaim.id }).update({ status: 'failed' })
    expect(await claimPageMutationEffects(knex, { leaseOwner: 'links-failed', effects: ['links'], now })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ effectKind: 'links' }).first('attempts')).toMatchObject({ attempts: 0 })

    await knex('pageMutationOutbox').where({ id: renderClaim.id }).update({ status: 'succeeded' })
    await knex('pages').where({ id: 42 }).update({ renderedSourceRevision: 8 })
    const [linkClaim] = await claimPageMutationEffects(knex, { leaseOwner: 'links-ready', effects: ['links'], now })
    expect(linkClaim).toMatchObject({ attempts: 1, payload: { effectKind: 'links' } })
  })

  it('claims absent link cleanup independently of render state', async () => {
    await knex('pageLinks').insert({ pageId: 42, localeCode: 'en', path: 'stale' })
    await enqueue({
      desiredState: 'absent',
      action: 'delete',
      source: undefined,
      location: undefined,
      previousLocation: location,
      effects: ['links']
    })

    const [claim] = await claimPageMutationEffects(knex, { leaseOwner: 'absent-links', effects: ['links'] })
    if (!claim) throw new Error('absent links claim missing')
    expect(claim).toMatchObject({ attempts: 1, payload: { effectKind: 'links', desiredState: 'absent' } })

    const lifecycle = new PageProjectionLifecycle(knex, 'absent-links-worker', projectionRuntime())
    await knex('pageMutationOutbox').where({ id: claim.id }).update({
      status: 'pending',
      attempts: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null
    })
    await expect(lifecycle.runOnce()).resolves.toEqual({ processed: 1 })
    expect(await knex('pageLinks').where({ pageId: 42 })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ effectKind: 'links' }).first('status')).toEqual({ status: 'succeeded' })
  })

  it('waits for exact render success before claiming current search work without consuming attempts', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 7,
      content: '# Start\n',
      render: '<p>old render</p>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['render', 'search'] })
    const now = new Date('2100-08-17T00:00:00.000Z')

    expect(await claimPageMutationEffects(knex, { leaseOwner: 'search-pending', effects: ['search'], now })).toEqual([])
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'failed' })
    expect(await claimPageMutationEffects(knex, { leaseOwner: 'search-failed', effects: ['search'], now })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('status', 'attempts')).toMatchObject({
      status: 'pending',
      attempts: 0
    })

    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
    await knex('pages').where({ id: 42 }).update({ renderedSourceRevision: 8 })
    const [searchClaim] = await claimPageMutationEffects(knex, { leaseOwner: 'search-ready', effects: ['search'], now })
    expect(searchClaim).toMatchObject({ attempts: 1, payload: { effectKind: 'search', sourceRevision: '8' } })
  })

  it('rearms an exact terminal effect idempotently and fails closed for immutable tampering', async () => {
    const [id] = await enqueue({ effects: ['render'] })
    if (!id) throw new Error('effect missing')
    const original = await knex('pageMutationOutbox').where({ id }).first()
    const payload = JSON.parse(original.payload)
    await knex('pageMutationOutbox').where({ id }).update({
      status: 'succeeded',
      attempts: 5,
      result: '{"rendered":true}',
      postcondition: '{"satisfied":true}'
    })
    const now = new Date('2100-08-17T00:00:00.000Z')

    await expect(rearmPageMutationEffect(knex, { id, payload, now })).resolves.toBe(true)
    const rearmed = await knex('pageMutationOutbox').where({ id }).first()
    expect(rearmed).toMatchObject({
      id: original.id,
      pageId: original.pageId,
      sourceRevision: original.sourceRevision,
      effectKind: original.effectKind,
      effectKey: original.effectKey,
      desiredState: original.desiredState,
      payload: original.payload,
      payloadSha256: original.payloadSha256,
      status: 'retry',
      attempts: 0,
      result: null,
      postcondition: null
    })
    await expect(rearmPageMutationEffect(knex, { id, payload, now })).resolves.toBe(false)

    await knex('pageMutationOutbox').where({ id }).update({ status: 'failed' })
    await expect(rearmPageMutationEffect(knex, { id, payload, now })).resolves.toBe(true)
    await knex('pageMutationOutbox')
      .where({ id })
      .update({ status: 'succeeded', payloadSha256: '0'.repeat(64) })
    await expect(rearmPageMutationEffect(knex, { id, payload, now })).rejects.toMatchObject({ code: 'OUTBOX_PAYLOAD_TAMPERED' })
    expect(await knex('pageMutationOutbox').where({ id }).first('status', 'payload', 'payloadSha256')).toMatchObject({
      status: 'succeeded',
      payload: original.payload,
      payloadSha256: '0'.repeat(64)
    })
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
    expect(reconcile).toHaveBeenCalledWith(claim.payload, expect.any(AbortSignal), claim)
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
    await expect(Promise.resolve(executePageMutationEffect(knex, missingClaim, new Map(), new AbortController().signal))).rejects.toMatchObject({
      code: 'MISSING_PROJECTION_SINK'
    })
    expect(await knex('pageMutationOutbox').first()).toMatchObject({ status: 'failed' })

    await knex('pageMutationOutbox').delete()
    await enqueue({ effects: ['render'] })
    const [badClaim] = await claimPageMutationEffects(knex, { leaseOwner: 'worker-b' })
    if (!badClaim) throw new Error('claim missing')
    const badSink = {
      kind: 'render' as const,
      reconcile: async () => ({ result: {}, postcondition: { satisfied: false, observedSourceRevision: null, detail: 'mismatch' } })
    }
    await expect(
      Promise.resolve(executePageMutationEffect(knex, badClaim, new Map([['render', badSink]]), new AbortController().signal))
    ).rejects.toMatchObject({ code: 'PROJECTION_POSTCONDITION_FAILED' })
    expect(await knex('pageMutationOutbox').first()).toMatchObject({ status: 'failed' })

    await knex('pageMutationOutbox').delete()
    await enqueue({ effects: ['render'] })
    const [malformedClaim] = await claimPageMutationEffects(knex, { leaseOwner: 'worker-c' })
    if (!malformedClaim) throw new Error('claim missing')
    const malformedSink = {
      kind: 'render',
      reconcile: async () => ({ result: {}, postcondition: { satisfied: 'true', observedSourceRevision: '8', detail: 'invalid boolean' } })
    } as unknown as PageProjectionSink
    await expect(
      Promise.resolve(executePageMutationEffect(knex, malformedClaim, new Map([['render', malformedSink]]), new AbortController().signal))
    ).rejects.toMatchObject({ code: 'PROJECTION_POSTCONDITION_FAILED' })
    expect(await knex('pageMutationOutbox').first()).toMatchObject({ status: 'failed' })
  })

  it('retries thrown sink errors and rejects stale completion tokens', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    await enqueue({ effects: ['links'] })
    const [claim] = await claimPageMutationEffects(knex, { leaseOwner: 'worker', now: new Date() })
    if (!claim) throw new Error('claim missing')
    const sink = {
      kind: 'links' as const,
      reconcile: async () => {
        throw new Error('temporary')
      }
    }
    await expect(Promise.resolve(executePageMutationEffect(knex, claim, new Map([['links', sink]]), new AbortController().signal))).rejects.toThrow('temporary')
    expect(await knex('pageMutationOutbox').first()).toMatchObject({ status: 'retry', attempts: 1, leaseToken: null })
    await knex('pageMutationOutbox').update({ status: 'running', leaseToken: '00000000-0000-4000-8000-000000000099' })
    const reconcile = vi.fn(async () => ({
      result: {},
      postcondition: { satisfied: true, observedSourceRevision: '8', detail: 'ok' }
    }))
    const goodSink = { kind: 'links' as const, reconcile }
    await expect(Promise.resolve(executePageMutationEffect(knex, claim, new Map([['links', goodSink]]), new AbortController().signal))).rejects.toMatchObject({
      code: 'PROJECTION_LEASE_LOST'
    })
    expect(reconcile).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

const projectionRuntime = (
  overrides: Partial<ConstructorParameters<typeof PageProjectionLifecycle>[2]> = {}
): ConstructorParameters<typeof PageProjectionLifecycle>[2] => ({
  renderPage: async pageId => {
    const page = await knex('pages').where({ id: pageId }).first('sourceRevision', 'render', 'content')
    if (page)
      await knex('pages')
        .where({ id: pageId })
        .update({
          render: page.render || `<p>${page.content}</p>`,
          renderedSourceRevision: page.sourceRevision
        })
  },
  evictLocation: async () => undefined,
  reconcileSearchPage: async pageId => {
    const page = await knex('pages').where({ id: pageId }).first('sourceRevision', 'render')
    if (!page) return
    await knex.transaction(async transaction => {
      await transaction('pagesWords').where({ pageId }).delete()
      await transaction('pagesVector').insert({ pageId, sourceRevision: page.sourceRevision }).onConflict('pageId').merge()
      const words = [
        ...new Set(
          String(page.render)
            .replace(/<[^>]*>/g, ' ')
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? []
        )
      ]
      if (words.length > 0) await transaction('pagesWords').insert(words.map(word => ({ pageId, word })))
    })
  },
  removeSearchPage: async pageId => {
    await knex.transaction(async transaction => {
      await transaction('pagesWords').where({ pageId }).delete()
      await transaction('pagesVector').where({ pageId }).delete()
    })
  },
  ...overrides
})

describe('production page projection lifecycle', () => {
  it('cools completed integrity audits while queued mutations remain next-tick work', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'))
    await knex('pages').insert(
      projectionPage({
        render: '<p>currentbody <a class="is-internal-link" href="/en/target">target</a></p>'
      })
    )
    await enqueue({ effects: ['render', 'links', 'search'] })
    await knex('pageMutationOutbox').where({ pageId: 42, effectKind: 'render' }).update({ status: 'succeeded' })
    const renderPage = vi.fn(projectionRuntime().renderPage)
    await enqueue({
      pageId: 44,
      desiredState: 'absent',
      action: 'delete',
      source: undefined,
      location: undefined,
      previousLocation: location,
      effects: ['search']
    })
    const lifecycle = new PageProjectionLifecycle(knex, 'cooling-worker', projectionRuntime({ renderPage }))
    await lifecycle.runOnce()
    await lifecycle.runOnce()
    const immutable = await knex('pageMutationOutbox').where({ pageId: 42 }).select('id', 'payload', 'payloadSha256').orderBy('id')
    await knex('pageLinks').where({ pageId: 42 }).delete()
    await knex('pagesVector').where({ pageId: 42 }).delete()
    await knex('pagesVector').insert({ pageId: 44, sourceRevision: 8 })
    await knex('pagesWords').insert({ pageId: 44, word: 'orphan' })

    vi.setSystemTime(new Date('2100-01-01T00:00:01.000Z'))
    await knex('pages').insert(
      projectionPage({ id: 43, path: 'docs/queued', sourceRevision: 9, renderedSourceRevision: null, content: '# Queued\n', render: '<p>queuedbody</p>' })
    )
    await enqueue({
      pageId: 43,
      sourceRevision: 9,
      source: '# Queued\n',
      location: { ...location, path: 'docs/queued' },
      effects: ['render', 'links', 'search']
    })
    await lifecycle.runOnce()
    expect(await knex('pagesVector').where({ pageId: 43 })).toEqual([{ pageId: 43, sourceRevision: 9 }])
    expect(await knex('pageMutationOutbox').where({ pageId: 43 }).select('status')).toEqual([
      { status: 'succeeded' },
      { status: 'succeeded' },
      { status: 'succeeded' }
    ])
    expect(await knex('pagesVector').where({ pageId: 42 })).toEqual([])
    expect(await knex('pageLinks').where({ pageId: 42 })).toEqual([])
    expect(await knex('pagesWords').where({ pageId: 44, word: 'orphan' })).toHaveLength(1)

    vi.setSystemTime(new Date('2100-01-01T00:10:00.000Z'))
    for (let tick = 0; tick < 3; tick += 1) await lifecycle.runOnce()
    expect(await knex('pagesVector').where({ pageId: 42 })).toEqual([{ pageId: 42, sourceRevision: 8 }])
    expect(await knex('pageLinks').where({ pageId: 42 }).select('path')).toEqual([{ path: 'target' }])
    expect(await knex('pagesVector').where({ pageId: 44 })).toEqual([])
    expect(await knex('pagesWords').where({ pageId: 44 })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ pageId: 42 }).select('id', 'payload', 'payloadSha256').orderBy('id')).toEqual(immutable)
    expect(renderPage.mock.calls.map(call => call[0])).not.toContain(42)

    await knex('pageLinks').where({ pageId: 42 }).update({ path: 'corrupt-target' })
    await knex('pageLinks').insert({ pageId: 42, localeCode: 'en', path: 'unexpected-edge' })
    vi.setSystemTime(new Date('2100-01-01T00:20:00.000Z'))
    await lifecycle.runOnce()
    expect(await knex('pageLinks').where({ pageId: 42 }).select('localeCode', 'path')).toEqual([{ localeCode: 'en', path: 'target' }])
    expect(await knex('pageMutationOutbox').where({ pageId: 42 }).select('id', 'payload', 'payloadSha256').orderBy('id')).toEqual(immutable)
    expect(renderPage.mock.calls.map(call => call[0])).not.toContain(42)
  })

  it('activates and expires unchanged publication windows during audit cooldown with an inclusive end', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'))
    await knex('pages').insert(
      projectionPage({
        publishStartDate: '2100-01-01T00:00:02.000Z',
        publishEndDate: '2100-01-01T00:00:04.000Z'
      })
    )
    const lifecycle = new PageProjectionLifecycle(knex, 'temporal-worker', projectionRuntime())
    await lifecycle.runOnce()
    await lifecycle.runOnce()
    const immutable = await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('id', 'payload', 'payloadSha256')
    expect(await knex('pagesVector')).toEqual([])

    vi.setSystemTime(new Date('2100-01-01T00:00:02.000Z'))
    await lifecycle.runOnce()
    expect(await knex('pagesVector')).toEqual([{ pageId: 42, sourceRevision: 8 }])
    vi.setSystemTime(new Date('2100-01-01T00:00:04.000Z'))
    await lifecycle.runOnce()
    expect(await knex('pagesVector')).toEqual([{ pageId: 42, sourceRevision: 8 }])
    vi.setSystemTime(new Date('2100-01-01T00:00:04.001Z'))
    await lifecycle.runOnce()
    expect(await knex('pagesVector')).toEqual([])
    expect(await knex('pagesWords')).toEqual([])
    expect(await knex('pages').first('sourceRevision')).toEqual({ sourceRevision: 8 })
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('id', 'payload', 'payloadSha256')).toEqual(immutable)
  })

  it('finishes a bounded audit across ticks without continuously wrapping onto an unchanged tail', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'))
    for (let id = 1; id <= 35; id += 1) {
      await knex('pages').insert(projectionPage({ id, path: `docs/bounded-${id}` }))
    }
    const lifecycle = new PageProjectionLifecycle(knex, 'finite-worker', projectionRuntime())
    for (let tick = 0; tick < 20; tick += 1) await lifecycle.runOnce()
    expect(await knex('pagesVector').where({ pageId: 35 })).toEqual([{ pageId: 35, sourceRevision: 8 }])
    await knex('pagesVector').where({ pageId: 35 }).delete()
    vi.setSystemTime(new Date('2100-01-01T00:00:01.000Z'))
    for (let tick = 0; tick < 5; tick += 1) await lifecycle.runOnce()
    expect(await knex('pagesVector').where({ pageId: 35 })).toEqual([])

    vi.setSystemTime(new Date('2100-01-01T00:10:00.000Z'))
    for (let tick = 0; tick < 20; tick += 1) await lifecycle.runOnce()
    expect(await knex('pagesVector').where({ pageId: 35 })).toEqual([{ pageId: 35, sourceRevision: 8 }])
  })

  it('advances temporal repair past immutable corrupt receipts without waiting for the next full audit', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'))
    for (let id = 1; id <= 11; id += 1) {
      const path = `docs/scheduled-${id}`
      await knex('pages').insert(projectionPage({ id, path, publishStartDate: '2100-01-01T00:00:02.000Z' }))
      await enqueue({ pageId: id, location: { ...location, path }, effects: ['render', 'links', 'search'] })
    }
    await knex('pageMutationOutbox').update({ status: 'succeeded', attempts: 2 })
    const lifecycle = new PageProjectionLifecycle(knex, 'temporal-tail-worker', projectionRuntime())
    for (let tick = 0; tick < 4; tick += 1) await lifecycle.runOnce()
    await knex('pageMutationOutbox')
      .where('pageId', '<=', 10)
      .where({ effectKind: 'search' })
      .update({ payloadSha256: '0'.repeat(64) })
    const corrupt = await knex('pageMutationOutbox')
      .where('pageId', '<=', 10)
      .where({ effectKind: 'search' })
      .select('id', 'payload', 'payloadSha256', 'status', 'attempts')
      .orderBy('pageId')
    vi.setSystemTime(new Date('2100-01-01T00:00:02.000Z'))
    for (let tick = 0; tick < 3; tick += 1) await lifecycle.runOnce()
    expect(await knex('pagesVector').where({ pageId: 11 })).toEqual([{ pageId: 11, sourceRevision: 8 }])
    expect(await knex('pagesVector').where('pageId', '<=', 10)).toEqual([])
    expect(
      await knex('pageMutationOutbox')
        .where('pageId', '<=', 10)
        .where({ effectKind: 'search' })
        .select('id', 'payload', 'payloadSha256', 'status', 'attempts')
        .orderBy('pageId')
    ).toEqual(corrupt)
  })

  it('renders and persists links only after exact revision-fenced postconditions', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 7,
      content: '# Start\n',
      render: '<p>old render</p>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['render', 'links'], previousLocation: { ...location, path: 'docs/old' } })
    const evicted: string[] = []
    const renderPage = vi.fn(async (pageId: number) => {
      await knex('pages')
        .where({ id: pageId, sourceRevision: 8 })
        .update({ render: '<p><a class="is-internal-link is-valid-page" href="/en/target">target</a></p>', renderedSourceRevision: 8 })
    })
    const lifecycle = new PageProjectionLifecycle(
      knex,
      'projection-worker',
      projectionRuntime({
        renderPage,
        evictLocation: async previous => {
          evicted.push(`${previous.locale}/${previous.path}/${previous.visibility}`)
        }
      })
    )

    await lifecycle.runOnce()

    expect(renderPage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        effectId: expect.any(String),
        leaseToken: expect.any(String),
        sourceRevision: '8',
        sourceSha256: createHash('sha256').update('# Start\n').digest('hex')
      })
    )
    expect(evicted).toContain('en/docs/old/public')
    expect(evicted.every(identity => identity === 'en/docs/old/public')).toBe(true)
    expect(await knex('pageLinks').select('pageId', 'localeCode', 'path')).toEqual([{ pageId: 42, localeCode: 'en', path: 'target' }])
    expect(await knex('pagesVector').select('pageId', 'sourceRevision')).toEqual([{ pageId: 42, sourceRevision: 8 }])
    expect(await knex('pageMutationOutbox').select('effectKind', 'status').orderBy('effectKind')).toEqual([
      { effectKind: 'links', status: 'succeeded' },
      { effectKind: 'render', status: 'succeeded' },
      { effectKind: 'search', status: 'succeeded' }
    ])
  })

  it('rearms failed link work after exact render success and proves the persisted-links postcondition', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 8,
      content: '# Start\n',
      render: '<p><a class="is-internal-link" href="/en/recovered">recovered</a></p>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['render', 'links'] })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
    await knex('pageMutationOutbox').where({ effectKind: 'links' }).update({ status: 'failed', attempts: 5 })
    const linksEffect = await knex('pageMutationOutbox').where({ effectKind: 'links' }).first()
    if (!linksEffect) throw new Error('links effect missing')

    await expect(rearmPageMutationEffect(knex, { id: linksEffect.id, payload: JSON.parse(linksEffect.payload) })).resolves.toBe(true)
    const lifecycle = new PageProjectionLifecycle(knex, 'rearmed-links-worker', projectionRuntime())
    await lifecycle.runOnce()

    expect(await knex('pageLinks').select('pageId', 'localeCode', 'path')).toEqual([{ pageId: 42, localeCode: 'en', path: 'recovered' }])
    const settled = await knex('pageMutationOutbox').where({ id: linksEffect.id }).first('status', 'postcondition')
    expect(settled.status).toBe('succeeded')
    expect(JSON.parse(settled.postcondition)).toMatchObject({
      satisfied: true,
      observedSourceRevision: '8'
    })
  })

  it('compares punctuation-heavy persisted links with deterministic in-process ordering', async () => {
    const expectedLinks = [
      { pageId: 42, localeCode: 'en', path: 'fax/(212)-555-0199' },
      { pageId: 42, localeCode: 'en', path: 'fax/[draft]_212.555.0199' },
      { pageId: 42, localeCode: 'en', path: 'fax_212/555/0199' },
      { pageId: 42, localeCode: 'en', path: 'fax_[archive]-212_555_0199' },
      { pageId: 42, localeCode: 'fr', path: 'fax/[bureau]_01.23.45.67.89' }
    ]
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 8,
      content: '# Fax directory\n',
      render: [
        '<a class="is-internal-link" href="/fr/fax/%5Bbureau%5D_01.23.45.67.89">bureau</a>',
        '<a class="is-internal-link" href="/en/fax_%5Barchive%5D-212_555_0199">archive</a>',
        '<a class="is-internal-link" href="/en/fax_212/555/0199">digits</a>',
        '<a class="is-internal-link" href="/en/fax/%5Bdraft%5D_212.555.0199">draft</a>',
        '<a class="is-internal-link" href="/en/fax/(212)-555-0199">primary</a>'
      ].join(''),
      localeCode: 'en',
      path: 'docs/fax',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['render', 'links'], source: '# Fax directory\n', location: { ...location, path: 'docs/fax' } })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
    await knex.raw('PRAGMA reverse_unordered_selects = ON')

    const lifecycle = new PageProjectionLifecycle(knex, 'punctuation-links-worker', projectionRuntime())
    await lifecycle.runOnce()

    const linkEffect = await knex('pageMutationOutbox').where({ effectKind: 'links' }).first('status', 'postcondition')
    expect(linkEffect.status).toBe('succeeded')
    expect(JSON.parse(linkEffect.postcondition)).toMatchObject({ satisfied: true, observedSourceRevision: '8' })
    const persistedLinks = await knex('pageLinks').select('pageId', 'localeCode', 'path').where({ pageId: 42 })
    const linkIdentity = (link: { pageId: number; localeCode: string; path: string }): string => JSON.stringify([link.pageId, link.localeCode, link.path])
    expect(persistedLinks.map(linkIdentity).sort()).toEqual(expectedLinks.map(linkIdentity).sort())
  })

  it.each([
    {
      caseName: 'missing',
      triggerSql: `CREATE TRIGGER distort_page_links BEFORE INSERT ON pageLinks
        WHEN NEW.path = 'fax/[draft]_212.555.0199'
        BEGIN SELECT RAISE(IGNORE); END`
    },
    {
      caseName: 'extra',
      triggerSql: `CREATE TRIGGER distort_page_links AFTER INSERT ON pageLinks
        WHEN NEW.path = 'fax/[draft]_212.555.0199'
        BEGIN INSERT INTO pageLinks (pageId, localeCode, path) VALUES (NEW.pageId, 'en', 'fax/[extra]_212.555.0199'); END`
    },
    {
      caseName: 'changed',
      triggerSql: `CREATE TRIGGER distort_page_links AFTER INSERT ON pageLinks
        WHEN NEW.path = 'fax/[draft]_212.555.0199'
        BEGIN UPDATE pageLinks SET path = 'fax/[changed]_212.555.0199' WHERE id = NEW.id; END`
    }
  ])('fails the persisted-links postcondition when punctuation-heavy rows are $caseName', async ({ triggerSql }) => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 8,
      content: '# Fax directory\n',
      render:
        '<a class="is-internal-link" href="/en/fax/%5Bdraft%5D_212.555.0199">draft</a>' + '<a class="is-internal-link" href="/en/fax_212/555/0199">digits</a>',
      localeCode: 'en',
      path: 'docs/fax',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['render', 'links'], source: '# Fax directory\n', location: { ...location, path: 'docs/fax' } })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
    await knex.raw(triggerSql)

    const lifecycle = new PageProjectionLifecycle(knex, 'distorted-links-worker', projectionRuntime())
    await lifecycle.runOnce()

    const linkEffect = await knex('pageMutationOutbox').where({ effectKind: 'links' }).first('status', 'postcondition')
    expect(linkEffect.status).toBe('failed')
    expect(JSON.parse(linkEffect.postcondition)).toMatchObject({
      satisfied: false,
      observedSourceRevision: '8'
    })
  })

  it('fences superseded revisions while reconciling only the current rendered source', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 8,
      content: '# Start\n',
      render: '<a class="is-internal-link" href="/en/old">old</a>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await knex('pageLinks').insert({ pageId: 42, localeCode: 'en', path: 'current' })
    await enqueue({ effects: ['render', 'links', 'search'] })
    await knex('pages').where({ id: 42 }).update({
      sourceRevision: 9,
      renderedSourceRevision: 9,
      content: '# New\n',
      render: '<a class="is-internal-link" href="/en/current">current</a>'
    })
    const renderPage = vi.fn(async (pageId: number) => {
      await knex('pages').where({ id: pageId, sourceRevision: 9 }).update({
        render: '<a class="is-internal-link" href="/en/current">current</a>',
        renderedSourceRevision: 9
      })
    })
    const lifecycle = new PageProjectionLifecycle(knex, 'fence-worker', projectionRuntime({ renderPage }))

    await lifecycle.runOnce()

    expect(renderPage).toHaveBeenCalledWith(42, expect.objectContaining({ sourceRevision: '9' }))
    expect(await knex('pageLinks').select('localeCode', 'path')).toEqual([{ localeCode: 'en', path: 'current' }])
    expect(await knex('pageMutationOutbox').where({ sourceRevision: 8 }).whereNot({ status: 'succeeded' })).toHaveLength(0)

    await lifecycle.runOnce()

    expect(await knex('pageLinks').select('localeCode', 'path')).toEqual([{ localeCode: 'en', path: 'current' }])
    expect(await knex('pagesVector')).toEqual([{ pageId: 42, sourceRevision: 9 }])
    expect(await knex('pageMutationOutbox').where({ effectKind: 'links', sourceRevision: 9 }).first('status', 'attempts')).toMatchObject({
      status: 'succeeded',
      attempts: 1
    })
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search', sourceRevision: 9 }).first('status', 'attempts')).toMatchObject({
      status: 'succeeded',
      attempts: 1
    })
  })

  it('does not spend link attempts before an exact render effect succeeds', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 7,
      content: '# Start\n',
      render: '<a class="is-internal-link" href="/en/target">target</a>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['render', 'links', 'search'] })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'failed', attempts: 5 })
    const renderPage = vi.fn(projectionRuntime().renderPage)
    const reconcileSearchPage = vi.fn(projectionRuntime().reconcileSearchPage)
    const lifecycle = new PageProjectionLifecycle(knex, 'retry-worker', projectionRuntime({ renderPage, reconcileSearchPage }))

    await expect(lifecycle.runOnce()).resolves.toEqual({ processed: 0 })
    expect(renderPage).not.toHaveBeenCalled()
    expect(reconcileSearchPage).not.toHaveBeenCalled()
    expect(
      await knex('pageMutationOutbox').whereIn('effectKind', ['links', 'search']).select('effectKind', 'status', 'attempts').orderBy('effectKind')
    ).toEqual([
      { effectKind: 'links', status: 'pending', attempts: 0 },
      { effectKind: 'search', status: 'pending', attempts: 0 }
    ])
    expect(await knex('pageLinks')).toHaveLength(0)
    expect(await knex('pagesVector')).toEqual([])
    expect(await knex('pagesWords')).toEqual([])

    await knex('pages').where({ id: 42 }).update({ renderedSourceRevision: 8 })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
    await lifecycle.runOnce()
    expect(await knex('pageMutationOutbox').where({ effectKind: 'links' }).first('status', 'attempts')).toMatchObject({ status: 'succeeded', attempts: 1 })
    expect(await knex('pageLinks').select('pageId', 'localeCode', 'path')).toEqual([{ pageId: 42, localeCode: 'en', path: 'target' }])
  })

  it('removes both search tables for private, unpublished, and deleted pages', async () => {
    const lifecycle = new PageProjectionLifecycle(knex, 'removal-worker', projectionRuntime())
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 8,
      content: '# Start\n',
      render: '<p>private</p>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'private',
      ownerId: 7
    })
    await enqueue({
      effects: ['render', 'search'],
      location: { ...location, visibility: 'private', ownerId: 7 }
    })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
    await knex('pagesVector').insert({ pageId: 42, sourceRevision: 8 })
    await knex('pagesWords').insert({ pageId: 42, word: 'secret' })
    await lifecycle.runOnce()
    expect(await knex('pagesVector').where({ pageId: 42 })).toEqual([])
    expect(await knex('pagesWords').where({ pageId: 42 })).toEqual([])

    await knex('pages').insert({
      id: 43,
      sourceRevision: 9,
      renderedSourceRevision: 9,
      content: '# Start\n',
      render: '<p>draft</p>',
      isPublished: false,
      localeCode: 'en',
      path: 'docs/draft',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({
      pageId: 43,
      sourceRevision: 9,
      effects: ['render', 'search'],
      location: { ...location, path: 'docs/draft' }
    })
    await knex('pageMutationOutbox').where({ pageId: 43, effectKind: 'render' }).update({ status: 'succeeded' })
    await knex('pagesVector').insert({ pageId: 43, sourceRevision: 9 })
    await knex('pagesWords').insert({ pageId: 43, word: 'draft' })
    await lifecycle.runOnce()
    expect(await knex('pagesVector').where({ pageId: 43 })).toEqual([])
    expect(await knex('pagesWords').where({ pageId: 43 })).toEqual([])

    await enqueue({
      pageId: 44,
      sourceRevision: 10,
      desiredState: 'absent',
      action: 'delete',
      source: undefined,
      location: undefined,
      previousLocation: { ...location, path: 'docs/deleted' },
      effects: ['search']
    })
    await knex('pagesVector').insert({ pageId: 44, sourceRevision: 10 })
    await knex('pagesWords').insert({ pageId: 44, word: 'deleted' })
    await lifecycle.runOnce()
    expect(await knex('pagesVector').where({ pageId: 44 })).toEqual([])
    expect(await knex('pagesWords').where({ pageId: 44 })).toEqual([])
  })

  it('retries a failed exact search update', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 8,
      content: '# Start\n',
      render: '<p>rendered</p>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['render', 'links', 'search'] })
    await knex('pageMutationOutbox').whereIn('effectKind', ['render', 'links']).update({ status: 'succeeded' })
    const reconcileSearchPage = vi.fn(async () => {
      throw new Error('search unavailable')
    })
    const lifecycle = new PageProjectionLifecycle(knex, 'search-retry-worker', projectionRuntime({ reconcileSearchPage }))

    await expect(lifecycle.runOnce()).resolves.toEqual({ processed: 1 })

    expect(reconcileSearchPage).toHaveBeenCalledWith(42)
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('status', 'attempts')).toMatchObject({
      status: 'retry',
      attempts: 1
    })
  })

  it('enqueues missing current search work and rearms a succeeded stale vector deterministically', async () => {
    await knex('pages').insert([
      {
        id: 42,
        sourceRevision: 8,
        renderedSourceRevision: 8,
        content: '# Start\n',
        render: '<p>rendered</p>',
        localeCode: 'en',
        path: 'docs/start',
        visibility: 'public',
        ownerId: null
      },
      {
        id: 43,
        sourceRevision: 9,
        renderedSourceRevision: 9,
        content: '# Start\n',
        render: '<p>rendered next</p>',
        localeCode: 'en',
        path: 'docs/next',
        visibility: 'public',
        ownerId: null
      }
    ])
    await enqueue({ effects: ['render', 'links'] })
    await enqueue({
      pageId: 43,
      sourceRevision: 9,
      effects: ['render', 'links', 'search'],
      location: { ...location, path: 'docs/next' }
    })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
    await knex('pageMutationOutbox').where({ pageId: 43, effectKind: 'search' }).update({ status: 'succeeded', attempts: 1 })
    await knex('pagesVector').insert({ pageId: 43, sourceRevision: 7 })
    await knex('pagesWords').insert({ pageId: 43, word: 'stale' })
    const lifecycle = new PageProjectionLifecycle(knex, 'maintenance-worker', projectionRuntime())

    await lifecycle.runOnce()

    expect(await knex('pagesVector').select('pageId', 'sourceRevision').orderBy('pageId')).toEqual([
      { pageId: 42, sourceRevision: 8 },
      { pageId: 43, sourceRevision: 9 }
    ])
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).select('pageId', 'status').orderBy('pageId')).toEqual([
      { pageId: 42, status: 'succeeded' },
      { pageId: 43, status: 'succeeded' }
    ])
  })
  it('evicts stale search rows for an opted-out page without skipping render or links', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 8,
      content: '# Opted out\n',
      render: '<p><a class="is-internal-link" href="/en/target">target</a></p>',
      isSearchable: false,
      localeCode: 'en',
      path: 'docs/opted-out',
      visibility: 'public',
      ownerId: null
    })
    await knex('pagesVector').insert({ pageId: 42, sourceRevision: 7 })
    await knex('pagesWords').insert({ pageId: 42, word: 'stale' })

    const runtime = projectionRuntime()
    const renderPage = vi.fn(async (pageId: number) => {
      await knex('pages').where({ id: pageId }).update({
        render: '<p><a class="is-internal-link" href="/en/target">target</a></p>',
        renderedSourceRevision: 8
      })
    })
    const reconcileSearchPage = vi.fn(runtime.reconcileSearchPage)
    const removeSearchPage = vi.fn(runtime.removeSearchPage)
    const lifecycle = new PageProjectionLifecycle(
      knex,
      'opted-out-maintenance-worker',
      projectionRuntime({ renderPage, reconcileSearchPage, removeSearchPage })
    )

    await lifecycle.runOnce()

    expect(renderPage).toHaveBeenCalledWith(42, expect.objectContaining({ sourceRevision: '8' }))
    expect(reconcileSearchPage).not.toHaveBeenCalled()
    expect(removeSearchPage).toHaveBeenCalledWith(42)
    expect(await knex('pageLinks').select('pageId', 'localeCode', 'path')).toEqual([{ pageId: 42, localeCode: 'en', path: 'target' }])
    expect(await knex('pagesVector').where({ pageId: 42 })).toEqual([])
    expect(await knex('pagesWords').where({ pageId: 42 })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ pageId: 42, effectKind: 'search' }).first('status')).toEqual({ status: 'succeeded' })
  })

  it('backfills links behind a stalled current render without rewriting the render intent', async () => {
    await knex('pages').insert({
      id: 70,
      sourceRevision: 69,
      renderedSourceRevision: 69,
      content: '# Tail\n',
      render: '<p><a class="is-internal-link" href="/en/tail69">tail</a></p>',
      localeCode: 'en',
      path: 'docs/tail',
      visibility: 'public',
      ownerId: null
    })
    await enqueuePageMutationEffects(knex, {
      pageId: 70,
      sourceRevision: 69,
      desiredState: 'present',
      action: 'restore',
      source: '# Tail\n',
      location: { ...location, path: 'docs/tail' },
      effects: ['render']
    })
    const originalRender = await knex('pageMutationOutbox').where({ pageId: 70, effectKind: 'render' }).first('payload', 'payloadSha256')
    await knex('pageMutationOutbox').where({ pageId: 70, effectKind: 'render' }).update({
      status: 'running',
      leaseOwner: 'stalled-render-worker',
      leaseToken: '00000000-0000-4000-8000-000000000070',
      leaseExpiresAt: '2100-08-18T00:00:00.000Z'
    })
    const lifecycle = new PageProjectionLifecycle(knex, 'graph-recovery-worker', projectionRuntime())

    await expect(lifecycle.runOnce()).resolves.toEqual({ processed: 0 })
    expect(await knex('pageMutationOutbox').where({ pageId: 70, effectKind: 'links' }).first('status')).toEqual({ status: 'pending' })
    expect(await knex('pageMutationOutbox').where({ pageId: 70, effectKind: 'search' }).first('status')).toEqual({ status: 'pending' })
    expect(await knex('pageMutationOutbox').where({ pageId: 70, effectKind: 'render' }).first('payload', 'payloadSha256')).toEqual(originalRender)

    await knex('pageMutationOutbox').where({ pageId: 70, effectKind: 'render' }).update({
      status: 'succeeded',
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null
    })
    await expect(lifecycle.runOnce()).resolves.toEqual({ processed: 2 })
    expect(await knex('pageLinks').select('pageId', 'localeCode', 'path')).toEqual([{ pageId: 70, localeCode: 'en', path: 'tail69' }])
  })

  it('skips a terminal corrupt render dependency without starving a later graph recovery', async () => {
    await knex('pages').insert([
      {
        id: 70,
        sourceRevision: 69,
        renderedSourceRevision: 69,
        content: '# Corrupt\n',
        render: '<p>corrupt</p>',
        localeCode: 'en',
        path: 'docs/corrupt',
        visibility: 'public',
        ownerId: null
      },
      {
        id: 71,
        sourceRevision: 70,
        renderedSourceRevision: 70,
        content: '# Healthy\n',
        render: '<p><a class="is-internal-link" href="/en/healthy">healthy</a></p>',
        localeCode: 'en',
        path: 'docs/healthy',
        visibility: 'public',
        ownerId: null
      }
    ])
    await enqueuePageMutationEffects(knex, {
      pageId: 70,
      sourceRevision: 69,
      desiredState: 'present',
      action: 'update',
      source: '# Corrupt\n',
      location: { ...location, path: 'docs/corrupt' },
      effects: ['render']
    })
    const corruptRender = await knex('pageMutationOutbox').where({ pageId: 70, effectKind: 'render' }).first('payload', 'payloadSha256')
    await knex('pageMutationOutbox').where({ pageId: 70, effectKind: 'render' }).update({ status: 'failed', attempts: 5, payload: '{' })
    const lifecycle = new PageProjectionLifecycle(
      knex,
      'tail-recovery-worker',
      projectionRuntime({
        renderPage: async pageId => {
          await knex('pages').where({ id: pageId }).update({
            render: '<p><a class="is-internal-link" href="/en/healthy">healthy</a></p>',
            renderedSourceRevision: 70
          })
        }
      })
    )

    await lifecycle.runOnce()
    expect(await knex('pageMutationOutbox').where({ pageId: 71, effectKind: 'render' }).first('status')).toEqual({ status: 'succeeded' })
    expect(await knex('pageMutationOutbox').where({ pageId: 71, effectKind: 'links' }).first('status')).toEqual({ status: 'succeeded' })
    expect(await knex('pageMutationOutbox').where({ pageId: 70, effectKind: 'links' })).toHaveLength(0)
    expect(await knex('pageMutationOutbox').where({ pageId: 70, effectKind: 'render' }).first('payload', 'payloadSha256')).toEqual({
      payload: '{',
      payloadSha256: corruptRender?.payloadSha256
    })

    expect(await knex('pageLinks').select('pageId', 'localeCode', 'path')).toEqual([{ pageId: 71, localeCode: 'en', path: 'healthy' }])
  })

  it('processes legacy search and graph backfills that predate durable projection intent', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      renderedSourceRevision: 8,
      content: '# Legacy\n',
      render: '<p>legacy render</p>',
      localeCode: 'en',
      path: 'docs/legacy',
      visibility: 'public',
      ownerId: null
    })
    const reconcileSearchPage = vi.fn(projectionRuntime().reconcileSearchPage)
    const lifecycle = new PageProjectionLifecycle(knex, 'legacy-maintenance-worker', projectionRuntime({ reconcileSearchPage }))

    await lifecycle.runOnce()
    expect(reconcileSearchPage).toHaveBeenCalledWith(42)
    expect(await knex('pageMutationOutbox').select('effectKind', 'status').orderBy('effectKind')).toEqual([
      { effectKind: 'links', status: 'succeeded' },
      { effectKind: 'render', status: 'succeeded' },
      { effectKind: 'search', status: 'succeeded' }
    ])
  })

  it.each(['missing', 'stale succeeded'] as const)('rearms a %s render dependency before exposing uncertified body bytes', async dependency => {
    await knex('pages').insert(projectionPage({ renderedSourceRevision: 7, render: '<p>stalebody</p>' }))
    await enqueue({ effects: dependency === 'missing' ? ['links', 'search'] : ['render', 'links', 'search'] })
    await knex('pageMutationOutbox').whereIn('effectKind', ['render', 'links']).update({ status: 'succeeded', attempts: 3 })
    const original = await knex('pageMutationOutbox').where({ effectKind: 'render' }).first('id', 'payload', 'payloadSha256', 'effectKey')
    expect(await claimPageMutationEffects(knex, { leaseOwner: 'uncertified-body', effects: ['search'] })).toEqual([])
    const entered = deferred()
    const resume = deferred()
    const reconcileSearchPage = vi.fn(projectionRuntime().reconcileSearchPage)
    const lifecycle = new PageProjectionLifecycle(
      knex,
      'provenance-worker',
      projectionRuntime({
        reconcileSearchPage,
        renderPage: async pageId => {
          entered.release()
          await resume.promise
          await knex('pages').where({ id: pageId }).update({
            render: '<p>freshbody <a class="is-internal-link" href="/en/fresh-link">fresh</a></p>',
            renderedSourceRevision: 8
          })
        }
      })
    )
    const running = lifecycle.runOnce()
    await waitForProjectionStart(entered.promise, running)
    try {
      expect(await knex('pageMutationOutbox').where({ effectKind: 'render' }).first('status', 'attempts')).toMatchObject({ status: 'running', attempts: 1 })
      expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('status', 'attempts')).toMatchObject({ status: 'pending', attempts: 0 })
      expect(reconcileSearchPage).not.toHaveBeenCalled()
      expect(await knex('pagesVector')).toEqual([])
      expect(await knex('pagesWords')).toEqual([])
    } finally {
      resume.release()
      await running
    }
    expect(await knex('pagesVector')).toEqual([{ pageId: 42, sourceRevision: 8 }])
    expect(await knex('pagesWords').where({ pageId: 42, word: 'freshbody' })).toHaveLength(1)
    expect(await knex('pagesWords').where({ pageId: 42, word: 'stalebody' })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('status', 'attempts')).toMatchObject({ status: 'succeeded', attempts: 1 })
    if (original) expect(await knex('pageMutationOutbox').where({ id: original.id }).first('id', 'payload', 'payloadSha256', 'effectKey')).toEqual(original)
  })

  it.each([
    { reason: 'opted out', overrides: { isSearchable: false } },
    { reason: 'private', overrides: { visibility: 'private', ownerId: 7 } },
    { reason: 'unpublished', overrides: { isPublished: false } },
    { reason: 'future publication', overrides: { publishStartDate: '2100-01-02T00:00:00.000Z' } },
    { reason: 'expired publication', overrides: { publishEndDate: '2099-12-31T00:00:00.000Z' } }
  ])('cleans $reason search state despite a terminal render failure', async ({ overrides }) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'))
    const page = projectionPage({ ...overrides, renderedSourceRevision: 7 })
    await knex('pages').insert(page)
    await enqueue({
      effects: ['render', 'links', 'search'],
      location: { ...location, visibility: page.visibility as 'public' | 'private', ownerId: page.ownerId as number | null }
    })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'failed', attempts: 5 })
    await knex('pageMutationOutbox').where({ effectKind: 'links' }).update({ status: 'succeeded' })
    await knex('pagesVector').insert({ pageId: 42, sourceRevision: 7 })
    await knex('pagesWords').insert({ pageId: 42, word: 'stalebody' })
    const renderPage = vi.fn(projectionRuntime().renderPage)
    const reconcileSearchPage = vi.fn(projectionRuntime().reconcileSearchPage)
    const lifecycle = new PageProjectionLifecycle(knex, 'ineligible-cleanup-worker', projectionRuntime({ renderPage, reconcileSearchPage }))

    await lifecycle.runOnce()

    expect(renderPage).not.toHaveBeenCalled()
    expect(reconcileSearchPage).not.toHaveBeenCalled()
    expect(await knex('pagesVector').where({ pageId: 42 })).toEqual([])
    expect(await knex('pagesWords').where({ pageId: 42 })).toEqual([])
    expect(await knex('pageMutationOutbox').where({ effectKind: 'render' }).first('status', 'attempts')).toEqual({ status: 'failed', attempts: 5 })
    const effect = await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('status', 'attempts', 'result')
    expect(effect).toMatchObject({ status: 'succeeded', attempts: 1 })
    expect(JSON.parse(effect.result)).toMatchObject({ removed: true })
  })

  it.each(['opted-out revision', 'absent cleanup'] as const)('supersedes queued %s without removing a newer eligible projection', async state => {
    await knex('pages').insert(projectionPage({ id: 41, path: 'docs/barrier' }))
    await enqueue({ pageId: 41, effects: ['render', 'links', 'search'], location: { ...location, path: 'docs/barrier' } })
    await knex('pageMutationOutbox').where({ pageId: 41 }).whereIn('effectKind', ['links', 'search']).update({ status: 'succeeded' })
    await knex('pagesVector').insert({ pageId: 41, sourceRevision: 8 })
    if (state === 'opted-out revision') await knex('pages').insert(projectionPage({ isSearchable: false }))
    const [oldEffectId] = await enqueue(
      state === 'absent cleanup'
        ? { effects: ['search'], desiredState: 'absent', action: 'delete', source: undefined, location: undefined, previousLocation: location }
        : { effects: ['search'] }
    )
    await knex('pageMutationOutbox').where({ pageId: 41, effectKind: 'render' }).update({
      availableAt: '2000-01-01T00:00:00.000Z',
      createdAt: '2000-01-01T00:00:00.000Z'
    })
    const entered = deferred()
    const resume = deferred()
    const runtime = projectionRuntime()
    const removeSearchPage = vi.fn(runtime.removeSearchPage)
    const lifecycle = new PageProjectionLifecycle(
      knex,
      'queued-cleanup-worker',
      projectionRuntime({
        removeSearchPage,
        renderPage: async pageId => {
          if (pageId === 41) {
            entered.release()
            await resume.promise
          }
          await runtime.renderPage(pageId)
        }
      })
    )
    const running = lifecycle.runOnce()
    await waitForProjectionStart(entered.promise, running)
    try {
      await knex('pages')
        .insert(projectionPage({ sourceRevision: 9, renderedSourceRevision: 9, content: '# New\n', render: '<p>newerbody</p>' }))
        .onConflict('id')
        .merge()
      await enqueue({ sourceRevision: 9, source: '# New\n', effects: ['render', 'links', 'search'] })
      await knex('pageMutationOutbox').where({ pageId: 42, sourceRevision: 9 }).update({ status: 'succeeded' })
      await knex('pagesVector').insert({ pageId: 42, sourceRevision: 9 })
      await knex('pagesWords').insert({ pageId: 42, word: 'newerbody' })
    } finally {
      resume.release()
      await running
    }
    expect(removeSearchPage).not.toHaveBeenCalledWith(42)
    expect(await knex('pagesVector').where({ pageId: 42 })).toEqual([{ pageId: 42, sourceRevision: 9 }])
    expect(await knex('pagesWords').where({ pageId: 42 })).toEqual([{ pageId: 42, word: 'newerbody' }])
    const settled = await knex('pageMutationOutbox').where({ id: oldEffectId }).first('status', 'result')
    expect(settled.status).toBe('succeeded')
    expect(JSON.parse(settled.result)).toMatchObject({ superseded: true })
  })

  it('replaces same-revision links and body projections while preserving immutable coalesced receipts', async () => {
    const oldRender = '<p>oldbody <a class="is-internal-link" href="/en/old-link">old</a></p>'
    await knex('pages').insert(projectionPage({ render: oldRender }))
    await enqueue({ effects: ['render', 'links', 'search'] })
    await knex('pageMutationOutbox').update({ status: 'succeeded', attempts: 3, result: '{}', postcondition: '{"satisfied":true}' })
    await knex('pageLinks').insert({ pageId: 42, localeCode: 'en', path: 'old-link' })
    await knex('pagesVector').insert({ pageId: 42, sourceRevision: 8 })
    await knex('pagesWords').insert({ pageId: 42, word: 'oldbody' })
    const immutable = await knex('pageMutationOutbox').select('id', 'effectKind', 'effectKey', 'payload', 'payloadSha256').orderBy('effectKind')
    const admission = await knex.transaction(transaction =>
      admitPageRenderEffect(transaction, { pageId: 42, sourceRevision: 8, source: '# Start\n', location })
    )
    expect(await knex.transaction(transaction => admitPageRenderEffect(transaction, { pageId: 42, sourceRevision: 8, source: '# Start\n', location }))).toEqual(
      admission
    )
    expect(await knex('pages').where({ id: 42 }).first('renderedSourceRevision')).toEqual({ renderedSourceRevision: null })
    expect(await knex('pageLinks')).toEqual([])
    expect(await knex('pagesVector')).toEqual([])
    expect(await knex('pagesWords')).toEqual([])
    const entered = deferred()
    const resume = deferred()
    const lifecycle = new PageProjectionLifecycle(
      knex,
      'same-revision-render-worker',
      projectionRuntime({
        renderPage: async pageId => {
          entered.release()
          await resume.promise
          await knex('pages').where({ id: pageId }).update({
            render: '<p>replacementbody <a class="is-internal-link" href="/en/new-link">new</a></p>',
            renderedSourceRevision: 8
          })
        }
      })
    )
    const running = lifecycle.runOnce()
    await waitForProjectionStart(entered.promise, running)
    try {
      expect(
        await knex('pageMutationOutbox').whereIn('effectKind', ['links', 'search']).select('effectKind', 'status', 'attempts').orderBy('effectKind')
      ).toEqual([
        { effectKind: 'links', status: 'retry', attempts: 0 },
        { effectKind: 'search', status: 'retry', attempts: 0 }
      ])
      expect(await knex('pagesWords')).toEqual([])
      expect(await knex('pageLinks')).toEqual([])
    } finally {
      resume.release()
      await running
    }
    expect(await knex('pageLinks').select('pageId', 'localeCode', 'path')).toEqual([{ pageId: 42, localeCode: 'en', path: 'new-link' }])
    expect(await knex('pagesWords').where({ word: 'replacementbody' })).toHaveLength(1)
    expect(await knex('pagesWords').where({ word: 'oldbody' })).toEqual([])
    expect(await knex('pageMutationOutbox').select('id', 'effectKind', 'effectKey', 'payload', 'payloadSha256').orderBy('effectKind')).toEqual(immutable)
    expect(await knex('pageMutationOutbox').select('status', 'attempts')).toEqual([
      { status: 'succeeded', attempts: 1 },
      { status: 'succeeded', attempts: 1 },
      { status: 'succeeded', attempts: 1 }
    ])
  })

  it('revokes preclaimed running dependent tokens when the same revision is readmitted', async () => {
    await knex('pages').insert(projectionPage())
    await enqueue({ effects: ['render', 'links', 'search'] })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
    const claims = await claimPageMutationEffects(knex, { leaseOwner: 'old-dependents', effects: ['links', 'search'], limit: 2 })
    expect(claims).toHaveLength(2)
    await knex.transaction(transaction => admitPageRenderEffect(transaction, { pageId: 42, sourceRevision: 8, source: '# Start\n', location }))
    const reconcile = vi.fn(async () => {
      await knex('pagesWords').insert({ pageId: 42, word: 'oldtokenbody' })
      return { result: {}, postcondition: { satisfied: true, observedSourceRevision: '8', detail: 'stale publication' } }
    })
    for (const claim of claims) {
      await expect(
        executePageMutationEffect(
          knex,
          claim,
          {
            links: { kind: 'links', reconcile },
            search: { kind: 'search', reconcile }
          },
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: 'PROJECTION_LEASE_LOST' })
    }
    expect(reconcile).not.toHaveBeenCalled()
    expect(await knex('pagesWords')).toEqual([])
    expect(await knex('pageLinks')).toEqual([])
    expect(await knex('pageMutationOutbox').whereIn('effectKind', ['links', 'search']).select('status', 'attempts', 'leaseToken')).toEqual([
      { status: 'retry', attempts: 0, leaseToken: null },
      { status: 'retry', attempts: 0, leaseToken: null }
    ])
  })

  it('fences an already-started link projection while same-revision replacement is uncertified', async () => {
    await knex('pages').insert(projectionPage({ render: '<a class="is-internal-link" href="/en/old-link">oldbody</a>' }))
    await enqueue({ effects: ['render', 'links', 'search'], previousLocation: { ...location, path: 'docs/former' } })
    await knex('pageMutationOutbox').whereIn('effectKind', ['render', 'search']).update({ status: 'succeeded' })
    await knex('pageMutationOutbox').where({ effectKind: 'links' }).update({ availableAt: '2000-01-01T00:00:00.000Z' })
    await knex('pagesVector').insert({ pageId: 42, sourceRevision: 8 })
    await knex('pagesWords').insert({ pageId: 42, word: 'oldbody' })
    const linksEntered = deferred()
    const resumeLinks = deferred()
    const renderEntered = deferred()
    const resumeRender = deferred()
    let firstEviction = true
    const lifecycle = new PageProjectionLifecycle(
      knex,
      'running-link-fence-worker',
      projectionRuntime({
        evictLocation: async () => {
          if (!firstEviction) return
          firstEviction = false
          linksEntered.release()
          await resumeLinks.promise
        },
        renderPage: async pageId => {
          renderEntered.release()
          await resumeRender.promise
          await knex('pages').where({ id: pageId }).update({
            render: '<a class="is-internal-link" href="/en/replacement-link">replacementbody</a>',
            renderedSourceRevision: 8
          })
        }
      })
    )
    const running = lifecycle.runOnce()
    await waitForProjectionStart(linksEntered.promise, running)
    try {
      const oldLease = await knex('pageMutationOutbox').where({ effectKind: 'links' }).first('status', 'leaseToken')
      expect(oldLease).toMatchObject({ status: 'running', leaseToken: expect.any(String) })
      await knex.transaction(transaction => admitPageRenderEffect(transaction, { pageId: 42, sourceRevision: 8, source: '# Start\n', location }))
      resumeLinks.release()
      await waitForProjectionStart(renderEntered.promise, running)
      expect(await knex('pageLinks')).toEqual([])
      expect(await knex('pagesVector')).toEqual([])
      expect(await knex('pagesWords')).toEqual([])
      expect(await knex('pageMutationOutbox').where({ effectKind: 'links' }).first('status', 'attempts', 'leaseToken')).toEqual({
        status: 'retry',
        attempts: 0,
        leaseToken: null
      })
    } finally {
      resumeLinks.release()
      resumeRender.release()
      await running
    }
    expect(await knex('pageLinks').select('pageId', 'localeCode', 'path')).toEqual([{ pageId: 42, localeCode: 'en', path: 'replacement-link' }])
    expect(await knex('pagesWords').where({ word: 'oldbody' })).toEqual([])
    expect(await knex('pagesWords').where({ word: 'replacementbody' })).toHaveLength(1)
  })

  it('advances past ten immutable corrupt search receipts to repair page eleven and absent cleanup', async () => {
    for (let pageId = 1; pageId <= 11; pageId += 1) {
      const path = `docs/repair-${pageId}`
      await knex('pages').insert(projectionPage({ id: pageId, path, render: `<p>body${pageId}</p>` }))
      await enqueue({ pageId, location: { ...location, path }, effects: ['render', 'links', 'search'] })
    }
    await knex('pageMutationOutbox').update({ status: 'succeeded', attempts: 2 })
    await knex('pageMutationOutbox')
      .where('pageId', '<=', 10)
      .where({ effectKind: 'search' })
      .update({ payloadSha256: '0'.repeat(64) })
    const corrupt = await knex('pageMutationOutbox')
      .where('pageId', '<=', 10)
      .where({ effectKind: 'search' })
      .select('id', 'payload', 'payloadSha256', 'status', 'attempts')
      .orderBy('pageId')
    await enqueue({
      pageId: 12,
      desiredState: 'absent',
      action: 'delete',
      source: undefined,
      location: undefined,
      previousLocation: { ...location, path: 'docs/deleted' },
      effects: ['search']
    })
    await knex('pageMutationOutbox').where({ pageId: 12 }).update({ status: 'succeeded', attempts: 2 })
    await knex('pagesVector').insert({ pageId: 12, sourceRevision: 8 })
    await knex('pagesWords').insert({ pageId: 12, word: 'deletedbody' })
    const lifecycle = new PageProjectionLifecycle(knex, 'search-repair-cursor-worker', projectionRuntime())

    for (let tick = 0; tick < 3; tick += 1) await lifecycle.runOnce()

    expect(await knex('pagesVector').where({ pageId: 11 })).toEqual([{ pageId: 11, sourceRevision: 8 }])
    expect(await knex('pagesWords').where({ pageId: 11, word: 'body11' })).toHaveLength(1)
    expect(await knex('pageMutationOutbox').where({ pageId: 11, effectKind: 'search' }).first('status', 'attempts')).toEqual({
      status: 'succeeded',
      attempts: 1
    })
    expect(await knex('pagesVector').where({ pageId: 12 })).toEqual([])
    expect(await knex('pagesWords').where({ pageId: 12 })).toEqual([])
    expect(
      await knex('pageMutationOutbox')
        .where('pageId', '<=', 10)
        .where({ effectKind: 'search' })
        .select('id', 'payload', 'payloadSha256', 'status', 'attempts')
        .orderBy('pageId')
    ).toEqual(corrupt)
    expect(await knex('pagesVector').where('pageId', '<=', 10)).toEqual([])
  })

  it('never starts a queued render with an old token after a long first sink and a competing claim', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'))
    for (const pageId of [42, 43]) {
      const path = pageId === 42 ? 'docs/start' : 'docs/next'
      await knex('pages').insert(projectionPage({ id: pageId, path }))
      await enqueue({ pageId, location: { ...location, path }, effects: ['render', 'links', 'search'] })
      await knex('pageMutationOutbox').where({ pageId }).whereIn('effectKind', ['links', 'search']).update({ status: 'succeeded' })
      await knex('pagesVector').insert({ pageId, sourceRevision: 8 })
    }
    await knex('pageMutationOutbox')
      .where({ pageId: 42, effectKind: 'render' })
      .update({ availableAt: '2099-12-31T00:00:00.000Z', createdAt: '2099-12-31T00:00:00.000Z' })
    const entered = deferred()
    const resume = deferred()
    const renderPage = vi.fn(async (pageId: number) => {
      if (pageId === 42) {
        entered.release()
        await resume.promise
      }
      await knex('pages').where({ id: pageId }).update({ render: '<p>originalworkerbody</p>', renderedSourceRevision: 8 })
    })
    const lifecycle = new PageProjectionLifecycle(knex, 'serial-worker', projectionRuntime({ renderPage }))
    const running = lifecycle.runOnce()
    await waitForProjectionStart(entered.promise, running)
    try {
      for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) {
        await vi.advanceTimersByTimeAsync(20_000)
        await knex('pageMutationOutbox').where({ pageId: 42, effectKind: 'render' }).first('leaseExpiresAt')
      }
      vi.setSystemTime(new Date('2100-01-01T00:01:01.001Z'))
      const activeFirst = await knex('pageMutationOutbox').where({ pageId: 42, effectKind: 'render' }).first('status', 'leaseExpiresAt')
      expect(activeFirst.status).toBe('running')
      expect(Date.parse(activeFirst.leaseExpiresAt)).toBeGreaterThan(Date.now())
      const [competingClaim] = await claimPageMutationEffects(knex, { leaseOwner: 'competing-worker', effects: ['render'], limit: 1 })
      if (!competingClaim) throw new Error('competing claim missing')
      expect(competingClaim.payload.pageId).toBe(43)
      await executePageMutationEffect(
        knex,
        competingClaim,
        {
          render: {
            kind: 'render',
            reconcile: async () => {
              await knex('pages').where({ id: 43 }).update({ render: '<p>competingworkerbody</p>', renderedSourceRevision: 8 })
              return {
                result: { rendered: true },
                postcondition: { satisfied: true, observedSourceRevision: '8', detail: 'competing renderer persisted its output' }
              }
            }
          }
        },
        new AbortController().signal
      )
    } finally {
      resume.release()
      await running
    }
    expect(renderPage.mock.calls.map(([pageId]) => pageId)).toEqual([42])
    expect(await knex('pages').where({ id: 43 }).first('render')).toEqual({ render: '<p>competingworkerbody</p>' })
    expect(await knex('pageMutationOutbox').where({ pageId: 43, effectKind: 'render' }).first('status', 'leaseToken')).toEqual({
      status: 'succeeded',
      leaseToken: null
    })
  })
})
