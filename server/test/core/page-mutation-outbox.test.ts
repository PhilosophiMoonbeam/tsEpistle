import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

import {
  claimPageMutationEffects,
  enqueuePageMutationEffects,
  executePageMutationEffect,
  rearmPageMutationEffect,
  PageProjectionLifecycle,
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
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.bigInteger('sourceRevision').notNullable()
    table.text('content').notNullable()
    table.text('render').notNullable()
    table.boolean('isPublished').notNullable().defaultTo(true)
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
})

afterEach(async () => {
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

  it('represents deletion without retaining deleted source', async () => {
    await enqueue({ desiredState: 'absent', action: 'delete', source: undefined, location: undefined, previousLocation: location })
    const rows = await knex('pageMutationOutbox').orderBy('effectKind')
    for (const row of rows) {
      expect(JSON.parse(row.payload)).toMatchObject({ desiredState: 'absent', sourceSha256: null, location: null, previousLocation: location })
      expect(row.payload).not.toContain('# Start')
    }
  })

  it('claims in deterministic order with fenced leases and reclaims expiry', async () => {
    await enqueue({ effects: ['render', 'knowledge'] })
    const now = new Date('2100-08-17T00:00:00.000Z')
    const first = await claimPageMutationEffects(knex, { leaseOwner: 'worker-a', limit: 1, leaseMs: 1_000, now })
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ attempts: 1, leaseToken: expect.any(String) })
    expect(await claimPageMutationEffects(knex, { leaseOwner: 'worker-b', limit: 1, leaseMs: 1_000, now })).toHaveLength(1)
    const reclaimed = await claimPageMutationEffects(knex, { leaseOwner: 'worker-c', limit: 2, leaseMs: 1_000, now: new Date(now.valueOf() + 1_001) })
    expect(reclaimed).toHaveLength(2)
    expect(reclaimed.map(item => item.attempts)).toEqual([2, 2])
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
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ pageId: 43 }), expect.any(AbortSignal))
    const poison = await knex('pageMutationOutbox').where({ id: poisonId }).first()
    expect(poison).toMatchObject({ status: 'failed', attempts: 0, leaseToken: null })
    expect(JSON.parse(poison.result)).toMatchObject({ quarantined: true, code: 'INVALID_OUTBOX_PAYLOAD' })
    expect(poison.result.length).toBeLessThan(1_300)
  })

  it('defers links behind pending, running, or retrying current render work without consuming attempts', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      content: '# Start\n',
      render: '<p>old render</p>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['render', 'links'] })
    const now = new Date('2100-08-17T00:00:00.000Z')

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

    await knex('pageMutationOutbox').where({ id: renderClaim.id }).update({ status: 'succeeded' })
    const [linkClaim] = await claimPageMutationEffects(knex, { leaseOwner: 'links-ready', effects: ['links'], now })
    expect(linkClaim).toMatchObject({ attempts: 1, payload: { effectKind: 'links' } })
  })

  it('waits for exact render success before claiming current search work without consuming attempts', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
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
    ).rejects.toBeInstanceOf(PageMutationOutboxError)
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
    const goodSink = {
      kind: 'links' as const,
      reconcile: async () => ({ result: {}, postcondition: { satisfied: true, observedSourceRevision: '8', detail: 'ok' } })
    }
    await expect(Promise.resolve(executePageMutationEffect(knex, claim, new Map([['links', goodSink]]), new AbortController().signal))).rejects.toMatchObject({
      code: 'PROJECTION_LEASE_LOST'
    })
    vi.useRealTimers()
  })
})

const projectionRuntime = (
  overrides: Partial<ConstructorParameters<typeof PageProjectionLifecycle>[2]> = {}
): ConstructorParameters<typeof PageProjectionLifecycle>[2] => ({
  renderPage: async () => undefined,
  evictLocation: async () => undefined,
  reconcileSearchPage: async pageId => {
    const page = await knex('pages').where({ id: pageId }).first('sourceRevision')
    if (!page) return
    await knex.transaction(async transaction => {
      await transaction('pagesWords').where({ pageId }).delete()
      await transaction('pagesVector').insert({ pageId, sourceRevision: page.sourceRevision }).onConflict('pageId').merge()
      await transaction('pagesWords').insert({ pageId, word: 'indexed' })
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
  it('renders and persists links only after exact revision-fenced postconditions', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
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
        .update({ render: '<p><a class="is-internal-link is-valid-page" href="/en/target">target</a></p>' })
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

    await expect(lifecycle.runOnce()).resolves.toEqual({ processed: 1 })
    await expect(lifecycle.runOnce()).resolves.toEqual({ processed: 2 })

    expect(renderPage).toHaveBeenCalledWith(42)
    expect(evicted).toEqual(['en/docs/old/public', 'en/docs/old/public'])
    expect(await knex('pageLinks').select('pageId', 'localeCode', 'path')).toEqual([{ pageId: 42, localeCode: 'en', path: 'target' }])
    expect(await knex('pagesVector').select('pageId', 'sourceRevision')).toEqual([{ pageId: 42, sourceRevision: 8 }])
    expect(await knex('pageMutationOutbox').select('effectKind', 'status').orderBy('effectKind')).toEqual([
      { effectKind: 'links', status: 'succeeded' },
      { effectKind: 'render', status: 'succeeded' },
      { effectKind: 'search', status: 'succeeded' }
    ])
  })

  it('fences superseded revisions without rendering or overwriting current links', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
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
      content: '# New\n',
      render: '<a class="is-internal-link" href="/en/current">current</a>'
    })
    const renderPage = vi.fn(async () => undefined)
    const lifecycle = new PageProjectionLifecycle(knex, 'fence-worker', projectionRuntime({ renderPage }))

    await lifecycle.runOnce()

    expect(renderPage).not.toHaveBeenCalled()
    expect(await knex('pageLinks').select('localeCode', 'path')).toEqual([{ localeCode: 'en', path: 'current' }])
    expect(await knex('pagesVector')).toEqual([{ pageId: 42, sourceRevision: 9 }])
    expect(await knex('pageMutationOutbox').where({ sourceRevision: 8 }).whereNot({ status: 'succeeded' })).toHaveLength(0)
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search', sourceRevision: 9 }).first('status', 'attempts')).toMatchObject({
      status: 'succeeded',
      attempts: 1
    })
  })

  it('retries link publication until the immutable render effect is terminal', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      content: '# Start\n',
      render: '<a class="is-internal-link" href="/en/target">target</a>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['links'] })
    const lifecycle = new PageProjectionLifecycle(knex, 'retry-worker', projectionRuntime())

    await expect(lifecycle.runOnce()).resolves.toEqual({ processed: 2 })
    expect(await knex('pageMutationOutbox').where({ effectKind: 'links' }).first('status', 'attempts')).toMatchObject({ status: 'retry', attempts: 1 })
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('status')).toEqual({ status: 'succeeded' })
    expect(await knex('pageLinks')).toHaveLength(0)
  })

  it('removes both search tables for private, unpublished, and deleted pages', async () => {
    const lifecycle = new PageProjectionLifecycle(knex, 'removal-worker', projectionRuntime())
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
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
      content: '# Start\n',
      render: '<p>rendered</p>',
      localeCode: 'en',
      path: 'docs/start',
      visibility: 'public',
      ownerId: null
    })
    await enqueue({ effects: ['render', 'search'] })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
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
        content: '# Start\n',
        render: '<p>rendered next</p>',
        localeCode: 'en',
        path: 'docs/next',
        visibility: 'public',
        ownerId: null
      }
    ])
    await enqueue({ effects: ['render'] })
    await enqueue({
      pageId: 43,
      sourceRevision: 9,
      effects: ['render', 'search'],
      location: { ...location, path: 'docs/next' }
    })
    await knex('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
    await knex('pageMutationOutbox').where({ pageId: 43, effectKind: 'search' }).update({ status: 'succeeded', attempts: 1 })
    await knex('pagesVector').insert({ pageId: 43, sourceRevision: 7 })
    await knex('pagesWords').insert({ pageId: 43, word: 'stale' })
    const reconcileSearchPage = vi.fn(projectionRuntime().reconcileSearchPage)
    const lifecycle = new PageProjectionLifecycle(knex, 'maintenance-worker', projectionRuntime({ reconcileSearchPage }))

    await expect(lifecycle.runOnce()).resolves.toEqual({ processed: 2 })

    expect(reconcileSearchPage.mock.calls.map(([pageId]) => pageId)).toEqual([42, 43])
    expect(await knex('pagesVector').select('pageId', 'sourceRevision').orderBy('pageId')).toEqual([
      { pageId: 42, sourceRevision: 8 },
      { pageId: 43, sourceRevision: 9 }
    ])
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).select('pageId', 'status').orderBy('pageId')).toEqual([
      { pageId: 42, status: 'succeeded' },
      { pageId: 43, status: 'succeeded' }
    ])

  })

  it('processes legacy search backfills that predate durable render intent', async () => {
    await knex('pages').insert({
      id: 42,
      sourceRevision: 8,
      content: '# Legacy\n',
      render: '<p>legacy render</p>',
      localeCode: 'en',
      path: 'docs/legacy',
      visibility: 'public',
      ownerId: null
    })
    const reconcileSearchPage = vi.fn(projectionRuntime().reconcileSearchPage)
    const lifecycle = new PageProjectionLifecycle(knex, 'legacy-maintenance-worker', projectionRuntime({ reconcileSearchPage }))

    await expect(lifecycle.runOnce()).resolves.toEqual({ processed: 1 })
    expect(reconcileSearchPage).toHaveBeenCalledWith(42)
    expect(await knex('pageMutationOutbox').select('effectKind', 'status')).toEqual([{ effectKind: 'search', status: 'succeeded' }])
  })
})
