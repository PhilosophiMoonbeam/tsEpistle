import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import type { AgentKnowledgeEnricher } from '../agents/providers/utility.ts'
import { claimPageMutationEffects, enqueuePageMutationEffects } from '../core/page-mutation-outbox.ts'
import { up as createProjectionStore } from '../db/migrations/2.5.152.ts'
import { PageKnowledgeLifecycle, PageKnowledgeRepository } from '../knowledge/lifecycle.ts'

let db: Knex

const createSchema = async (): Promise<void> => {
  await db.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.bigInteger('sourceRevision').notNullable()
    table.text('content').notNullable()
    table.string('localeCode').notNullable()
    table.string('path').notNullable()
    table.string('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.string('contentType').notNullable()
    table.string('title').notNullable()
    table.text('description').nullable()
    table.dateTime('updatedAt').notNullable()
    table.integer('authorId').notNullable()
    table.text('extra').notNullable()
  })
  await db.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.text('content').notNullable()
    table.string('localeCode').notNullable()
    table.string('path').notNullable()
    table.string('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.string('contentType').notNullable()
    table.string('title').notNullable()
    table.text('description').nullable()
    table.dateTime('versionDate').notNullable()
    table.integer('authorId').notNullable()
    table.text('extra').notNullable()
  })
  await db.schema.createTable('tags', table => {
    table.increments('id').primary()
    table.string('tag').notNullable()
  })
  await db.schema.createTable('pageTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
  await db.schema.createTable('pageHistoryTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
  await db.schema.createTable('pageMutationOutbox', table => {
    table.uuid('id').primary()
    table.integer('pageId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('effectKind').notNullable()
    table.string('effectKey').notNullable()
    table.string('desiredState').notNullable()
    table.string('payloadSha256').notNullable()
    table.text('payload').notNullable()
    table.string('status').notNullable()
    table.integer('attempts').notNullable()
    table.string('leaseOwner').nullable()
    table.string('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('availableAt').notNullable()
    table.text('result').nullable()
    table.text('postcondition').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.unique(['pageId', 'sourceRevision', 'effectKind'])
  })
  await db.schema.createTable('agentProviderProfiles', table => {
    table.uuid('id').primary()
    table.string('status').notNullable()
    table.boolean('isGlobalDefault').notNullable()
    table.boolean('conformed').notNullable()
    table.uuid('currentVersionId').nullable()
    table.dateTime('deletedAt').nullable()
  })
  await db.schema.createTable('agentProviderProfileVersions', table => {
    table.uuid('id').primary()
    table.boolean('conformed').notNullable()
  })
  await db.schema.createTable('pageAccessPasswords', table => {
    table.integer('pageId').notNullable()
  })
  await createProjectionStore(db)
}

const page = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  sourceRevision: '1',
  content: '# Runbook\n\nFollow the deployment runbook.\n',
  localeCode: 'en',
  path: 'ops/runbook',
  visibility: 'public',
  ownerId: null,
  contentType: 'markdown',
  title: 'Runbook',
  description: null,
  updatedAt: '2026-08-18T12:00:00.000Z',
  authorId: 5,
  extra: JSON.stringify({ okf: { type: 'Procedure', status: 'stable' } }),
  ...overrides
})

const enqueueKnowledge = async (sourceRevision: string, content: string, action: 'create' | 'update') =>
  enqueuePageMutationEffects(db, {
    pageId: 42,
    sourceRevision,
    desiredState: 'present',
    action,
    source: content,
    location: { locale: 'en', path: 'ops/runbook', visibility: 'public', ownerId: null },
    effects: ['knowledge']
  })

const enqueuePageKnowledge = async (source: Record<string, unknown>) =>
  enqueuePageMutationEffects(db, {
    pageId: Number(source.id),
    sourceRevision: String(source.sourceRevision),
    desiredState: 'present',
    action: 'create',
    source: String(source.content),
    location: {
      locale: String(source.localeCode),
      path: String(source.path),
      visibility: source.visibility as 'public' | 'private',
      ownerId: source.ownerId === null ? null : Number(source.ownerId)
    },
    effects: ['knowledge']
  })

const enableUtilityEnrichment = async (): Promise<void> => {
  const profileVersionId = '00000000-0000-4000-8000-000000000001'
  await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
  await db('agentProviderProfiles').insert({
    id: '00000000-0000-4000-8000-000000000002',
    status: 'enabled',
    isGlobalDefault: true,
    conformed: true,
    currentVersionId: profileVersionId,
    deletedAt: null
  })
}

const utilityResult = (tag: string) => ({
  value: {
    type: null,
    summary: null,
    tags: [tag],
    entities: [],
    relationships: [],
    openQuestions: []
  },
  model: 'utility-small',
  inputSha256: 'a'.repeat(64),
  outputSha256: 'b'.repeat(64),
  inputTokens: 1,
  outputTokens: 1
})

beforeEach(async () => {
  db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await createSchema()
})
afterEach(async () => db.destroy())

describe('page knowledge lifecycle', () => {
  it('projects delayed revisions from production-shaped immutable history snapshots', async () => {
    const generatedAt = '2026-08-01T09:00:00.000Z'
    const verifiedAt = '2026-08-02T10:00:00.000Z'
    const first = page({
      extra: JSON.stringify({
        okf: {
          type: 'Procedure',
          status: 'stable',
          generated: { by: 'human:5', at: generatedAt },
          verified: [{ by: 'human:9', at: verifiedAt }]
        }
      })
    })
    await db('pages').insert(first)
    await enqueueKnowledge('1', String(first.content), 'create')
    const { updatedAt: versionDate, ...historySnapshot } = first
    const [historyId] = await db('pageHistory').insert({ ...historySnapshot, pageId: 42, versionDate })
    const [tagId] = await db('tags').insert({ tag: 'historical-tag' })
    await db('pageHistoryTags').insert({ pageId: historyId, tagId })
    const second = page({ sourceRevision: '2', content: '# Runbook\n\nUse the revised deployment runbook.\n' })
    await db('pages').where({ id: 42 }).update(second)
    await enqueueKnowledge('2', String(second.content), 'update')

    const lifecycle = new PageKnowledgeLifecycle(db, 'test-worker')
    await lifecycle.runOnce()

    const rows = await db('pageKnowledgeProjections').orderBy('sourceRevision').select('sourceRevision', 'sourceSha256', 'state')
    expect(rows).toHaveLength(2)
    expect(rows.map(row => String(row.sourceRevision))).toEqual(['1', '2'])
    expect(rows.every(row => /^[a-f0-9]{64}$/.test(String(row.sourceSha256)))).toBe(true)
    expect(await db('pages').where({ id: 42 }).first('content')).toEqual({ content: second.content })
    const historicalProjection = await db('pageKnowledgeProjections').where({ pageId: 42, sourceRevision: '1' }).first('projection')
    expect(JSON.parse(String(historicalProjection.projection))).toMatchObject({ source: { updatedAt: versionDate } })
    expect(await new PageKnowledgeRepository(db).getRevision(42, '1')).toMatchObject({
      sourceRevision: '1',
      conceptType: 'Procedure',
      tags: ['historical-tag'],
      lifecycle: {
        generatedAt,
        verifiedAt,
        trustTier: 'human-reviewed',
        verification: 'current'
      }
    })
    expect(await new PageKnowledgeRepository(db).getCurrent(42)).toMatchObject({ sourceRevision: '2' })
  })

  it('repairs missing, unparsable, wrong-source, and hash-mismatched current projections through their succeeded effect', async () => {
    const current = page()
    await db('pages').insert(current)
    await enqueueKnowledge('1', String(current.content), 'create')
    const lifecycle = new PageKnowledgeLifecycle(db, 'repair-worker')
    await lifecycle.runOnce()

    const expectRepair = async () => {
      await expect(lifecycle.runOnce()).resolves.toMatchObject({ backfilled: 1, processed: 1 })
      const stored = await db('pageKnowledgeProjections').where({ pageId: 42, sourceRevision: '1' }).first('sourceSha256', 'projection')
      const projection = JSON.parse(String(stored.projection))
      expect(stored.sourceSha256).toBe(projection.source.sha256)
      expect(projection.source).toMatchObject({ pageId: 42, sourceRevision: '1' })
      expect(await db('pageMutationOutbox').where({ effectKind: 'knowledge' }).first('status')).toEqual({ status: 'succeeded' })
    }

    await db('pageKnowledgeProjections').where({ pageId: 42, sourceRevision: '1' }).delete()
    await expectRepair()

    await db('pageKnowledgeProjections').where({ pageId: 42, sourceRevision: '1' }).update({ projection: '{' })
    await expectRepair()

    let stored = await db('pageKnowledgeProjections').where({ pageId: 42, sourceRevision: '1' }).first('projection')
    let projection = JSON.parse(String(stored.projection))
    projection.source.pageId = 99
    await db('pageKnowledgeProjections')
      .where({ pageId: 42, sourceRevision: '1' })
      .update({ projection: JSON.stringify(projection) })
    await expectRepair()

    stored = await db('pageKnowledgeProjections').where({ pageId: 42, sourceRevision: '1' }).first('projection')
    projection = JSON.parse(String(stored.projection))
    projection.source.sourceRevision = '2'
    await db('pageKnowledgeProjections')
      .where({ pageId: 42, sourceRevision: '1' })
      .update({ projection: JSON.stringify(projection) })
    await expectRepair()

    stored = await db('pageKnowledgeProjections').where({ pageId: 42, sourceRevision: '1' }).first('projection')
    projection = JSON.parse(String(stored.projection))
    projection.source.sha256 = '0'.repeat(64)
    await db('pageKnowledgeProjections')
      .where({ pageId: 42, sourceRevision: '1' })
      .update({ sourceSha256: '0'.repeat(64), projection: JSON.stringify(projection) })
    await expectRepair()
  })

  it('enqueues missing effects, avoids healthy requeues, leaves pending work singular, and rearms failed work', async () => {
    const current = page()
    await db('pages').insert(current)
    const lifecycle = new PageKnowledgeLifecycle(db, 'healthy-projection-worker')

    await expect(lifecycle.runOnce()).resolves.toMatchObject({ backfilled: 1, processed: 1 })
    await expect(lifecycle.runOnce()).resolves.toMatchObject({ backfilled: 0, processed: 0 })
    expect(await db('pageMutationOutbox').where({ effectKind: 'knowledge' }).count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({
      count: 1
    })

    await db('pageKnowledgeProjections').delete()
    await db('pageMutationOutbox').update({ status: 'pending' })
    await expect(lifecycle.runOnce()).resolves.toMatchObject({ backfilled: 0, processed: 1 })
    expect(await db('pageMutationOutbox').where({ effectKind: 'knowledge' }).count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({
      count: 1
    })
    expect(await db('pageKnowledgeProjections').where({ pageId: 42, sourceRevision: '1' }).first()).toBeDefined()

    await db('pageKnowledgeProjections').delete()
    await db('pageMutationOutbox').update({ status: 'failed' })
    await expect(lifecycle.runOnce()).resolves.toMatchObject({ backfilled: 1, processed: 1 })
    expect(await db('pageKnowledgeProjections').where({ pageId: 42, sourceRevision: '1' }).first()).toBeDefined()
  })

  it('advances the bounded projection scan to later page IDs and wraps to low IDs', async () => {
    for (let id = 1; id <= 27; id += 1) {
      const source = page({ id, path: `ops/runbook-${id}` })
      await db('pages').insert(source)
      await enqueuePageKnowledge(source)
    }
    const initializer = new PageKnowledgeLifecycle(db, 'scan-initializer')
    await initializer.runOnce()
    await initializer.runOnce()
    await initializer.runOnce()
    expect(await db('pageKnowledgeProjections').count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({ count: 27 })

    await db('pageKnowledgeProjections').whereIn('pageId', [1, 26]).delete()
    const lifecycle = new PageKnowledgeLifecycle(db, 'rotating-repair-worker')
    await expect(lifecycle.runOnce()).resolves.toMatchObject({ backfilled: 1, processed: 1 })
    expect(await db('pageKnowledgeProjections').where({ pageId: 26 }).first()).toBeUndefined()

    await db('pageKnowledgeProjections').where({ pageId: 1 }).delete()
    await expect(lifecycle.runOnce()).resolves.toMatchObject({ backfilled: 2, processed: 2 })
    expect(await db('pageKnowledgeProjections').whereIn('pageId', [1, 26]).orderBy('pageId').pluck('pageId')).toEqual([1, 26])
  })

  it('fails closed when a terminal effect needed for repair has tampered immutable content', async () => {
    const current = page()
    await db('pages').insert(current)
    await enqueueKnowledge('1', String(current.content), 'create')
    const lifecycle = new PageKnowledgeLifecycle(db, 'tamper-worker')
    await lifecycle.runOnce()
    await db('pageKnowledgeProjections').delete()
    const original = await db('pageMutationOutbox').where({ effectKind: 'knowledge' }).first('payload', 'payloadSha256')
    const tampered = JSON.parse(String(original.payload))
    tampered.location.path = 'tampered/path'
    await db('pageMutationOutbox')
      .where({ effectKind: 'knowledge' })
      .update({ payload: JSON.stringify(tampered) })

    await expect(lifecycle.runOnce()).rejects.toMatchObject({ code: 'OUTBOX_PAYLOAD_TAMPERED' })
    expect(await db('pageKnowledgeProjections').first()).toBeUndefined()
    const unchanged = await db('pageMutationOutbox').where({ effectKind: 'knowledge' }).first('status', 'payload', 'payloadSha256')
    expect(unchanged).toMatchObject({ status: 'succeeded', payloadSha256: original.payloadSha256 })
    expect(JSON.parse(String(unchanged.payload))).toMatchObject({ location: { path: 'tampered/path' } })
  })

  it('uses the global utility model only for declared public gaps', async () => {
    const profileVersionId = '00000000-0000-4000-8000-000000000001'
    await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
    await db('agentProviderProfiles').insert({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'enabled',
      isGlobalDefault: true,
      conformed: true,
      currentVersionId: profileVersionId,
      deletedAt: null
    })
    const current = page()
    await db('pages').insert(current)
    await enqueueKnowledge('1', String(current.content), 'create')
    const enrichKnowledge = vi.fn(async (request: unknown) => {
      void request
      return {
        value: {
          type: null,
          summary: null,
          tags: ['operations'],
          entities: [{ name: 'Deployment runbook', type: 'Document' }],
          relationships: [{ subject: 'Runbook', predicate: 'documents', object: 'Deployment' }],
          openQuestions: []
        },
        model: 'utility-small',
        inputSha256: 'a'.repeat(64),
        outputSha256: 'b'.repeat(64),
        inputTokens: 50,
        outputTokens: 20
      }
    })
    const enricher = { enrichKnowledge } as AgentKnowledgeEnricher

    await new PageKnowledgeLifecycle(db, 'utility-worker', enricher).runOnce()

    expect(enrichKnowledge).toHaveBeenCalledOnce()
    expect(enrichKnowledge.mock.calls[0]?.[0]).toMatchObject({
      profileVersionId,
      missingFields: ['concept.tags', 'concept.entities', 'concept.relationships']
    })
    expect(await db('pageKnowledgeProjections').first('state', 'enrichmentState', 'utilityProfileVersionId', 'utilityModel')).toMatchObject({
      state: 'complete',
      enrichmentState: 'succeeded',
      utilityProfileVersionId: profileVersionId,
      utilityModel: 'utility-small'
    })
  })

  it('does not requeue unavailable utility gaps when no enricher is configured', async () => {
    await enableUtilityEnrichment()
    const current = page()
    await db('pages').insert(current)
    await enqueueKnowledge('1', String(current.content), 'create')
    const lifecycle = new PageKnowledgeLifecycle(db, 'no-enricher-worker')

    await lifecycle.runOnce()
    expect(await db('pageKnowledgeProjections').first('state', 'enrichmentState')).toEqual({
      state: 'complete',
      enrichmentState: 'unavailable'
    })
    expect(await lifecycle.runOnce()).toMatchObject({ requeued: 0, processed: 0 })
  })

  it('retries successful optional enrichment once when the active utility profile changes', async () => {
    const originalProfileVersionId = '00000000-0000-4000-8000-000000000001'
    const nextProfileVersionId = '00000000-0000-4000-8000-000000000003'
    await enableUtilityEnrichment()
    const current = page()
    await db('pages').insert(current)
    await enqueueKnowledge('1', String(current.content), 'create')
    const enrichKnowledge = vi.fn(async () => utilityResult('profile-result'))
    const lifecycle = new PageKnowledgeLifecycle(db, 'profile-worker', { enrichKnowledge })

    await lifecycle.runOnce()
    expect(enrichKnowledge).toHaveBeenCalledOnce()
    expect(await db('pageKnowledgeProjections').first('state', 'enrichmentState', 'utilityProfileVersionId')).toMatchObject({
      state: 'complete',
      enrichmentState: 'succeeded',
      utilityProfileVersionId: originalProfileVersionId
    })

    await db('agentProviderProfileVersions').insert({ id: nextProfileVersionId, conformed: true })
    await db('agentProviderProfiles').update({ currentVersionId: nextProfileVersionId })
    expect(await lifecycle.runOnce()).toMatchObject({ requeued: 1, processed: 1 })
    expect(enrichKnowledge).toHaveBeenCalledTimes(2)
    expect(await db('pageKnowledgeProjections').first('utilityProfileVersionId')).toEqual({ utilityProfileVersionId: nextProfileVersionId })

    expect(await lifecycle.runOnce()).toMatchObject({ requeued: 0, processed: 0 })
    expect(enrichKnowledge).toHaveBeenCalledTimes(2)
  })

  it('discards utility output when the exact source revision changes in flight', async () => {
    const profileVersionId = '00000000-0000-4000-8000-000000000001'
    await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
    await db('agentProviderProfiles').insert({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'enabled',
      isGlobalDefault: true,
      conformed: true,
      currentVersionId: profileVersionId,
      deletedAt: null
    })
    const current = page()
    await db('pages').insert(current)
    await enqueueKnowledge('1', String(current.content), 'create')
    const enrichKnowledge = vi.fn(async () => {
      await db('pages').where({ id: 42 }).update({ sourceRevision: '2', content: '# Replaced\n' })
      return {
        value: { type: null, summary: null, tags: [], entities: [], relationships: [], openQuestions: [] },
        model: 'utility-small',
        inputSha256: 'a'.repeat(64),
        outputSha256: 'b'.repeat(64),
        inputTokens: 1,
        outputTokens: 1
      }
    })

    await new PageKnowledgeLifecycle(db, 'fence-worker', { enrichKnowledge }).runOnce()

    expect(enrichKnowledge).toHaveBeenCalledOnce()
    expect(await db('pageKnowledgeProjections').first('state', 'enrichmentState', 'utilityModel')).toMatchObject({
      state: 'complete',
      enrichmentState: 'superseded',
      utilityModel: null
    })
    expect(await db('pageMutationOutbox').where({ effectKind: 'knowledge' }).first('status', 'result')).toMatchObject({
      status: 'succeeded',
      result: expect.stringContaining('superseded')
    })
  })

  it('renews a healthy lease throughout long utility enrichment and releases its heartbeat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let enrichmentSignal: AbortSignal | undefined
    let running: Promise<unknown> | undefined

    try {
      await enableUtilityEnrichment()
      const current = page()
      await db('pages').insert(current)
      await enqueueKnowledge('1', String(current.content), 'create')
      running = new PageKnowledgeLifecycle(db, 'healthy-worker', {
        enrichKnowledge: vi.fn(async request => {
          enrichmentSignal = request.signal
          entered.resolve()
          await release.promise
          return utilityResult('healthy-worker')
        })
      }).runOnce()
      await entered.promise
      const original = await db('pageMutationOutbox').first('leaseToken', 'leaseExpiresAt')

      await vi.advanceTimersByTimeAsync(60_000)

      const renewed = await db('pageMutationOutbox').first('leaseToken', 'leaseExpiresAt')
      expect(renewed.leaseToken).toBe(original.leaseToken)
      expect(new Date(String(renewed.leaseExpiresAt)).valueOf()).toBeGreaterThan(new Date(String(original.leaseExpiresAt)).valueOf())
      expect(enrichmentSignal?.aborted).toBe(false)
      expect(
        await claimPageMutationEffects(db, {
          leaseOwner: 'contending-worker',
          limit: 1,
          leaseMs: 120_000,
          now: new Date('2026-08-18T12:02:00.001Z'),
          effects: ['knowledge']
        })
      ).toEqual([])

      release.resolve()
      await running
      expect(await db('pageMutationOutbox').first('status', 'leaseToken')).toMatchObject({ status: 'succeeded', leaseToken: null })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      release.resolve()
      await running?.catch(() => undefined)
      vi.useRealTimers()
    }
  })

  it('fences a stale projection write immediately after another worker reclaims the lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'))
    const firstEntered = Promise.withResolvers<void>()
    const firstRelease = Promise.withResolvers<void>()
    const replacementEntered = Promise.withResolvers<void>()
    const replacementRelease = Promise.withResolvers<void>()
    let firstRunning: Promise<unknown> | undefined
    let replacementRunning: Promise<unknown> | undefined

    try {
      await enableUtilityEnrichment()
      const current = page()
      await db('pages').insert(current)
      await enqueueKnowledge('1', String(current.content), 'create')
      firstRunning = new PageKnowledgeLifecycle(db, 'stale-worker', {
        enrichKnowledge: vi.fn(async () => {
          firstEntered.resolve()
          await firstRelease.promise
          return utilityResult('stale-worker')
        })
      }).runOnce()
      await firstEntered.promise

      vi.setSystemTime(new Date('2026-08-18T12:02:00.001Z'))
      replacementRunning = new PageKnowledgeLifecycle(db, 'replacement-worker', {
        enrichKnowledge: vi.fn(async () => {
          replacementEntered.resolve()
          await replacementRelease.promise
          return utilityResult('replacement-worker')
        })
      }).runOnce()
      await replacementEntered.promise
      const replacementClaim = await db('pageMutationOutbox').first('leaseOwner', 'leaseToken', 'status')
      expect(replacementClaim).toMatchObject({ leaseOwner: 'replacement-worker', status: 'running' })

      firstRelease.resolve()
      await firstRunning

      expect(await db('pageKnowledgeProjections').first()).toBeUndefined()
      expect(await db('pageMutationOutbox').first('leaseOwner', 'leaseToken', 'status')).toEqual(replacementClaim)

      replacementRelease.resolve()
      await replacementRunning
      const stored = await db('pageKnowledgeProjections').first('projection')
      expect(JSON.parse(String(stored.projection))).toMatchObject({ concept: { tags: ['replacement-worker'] } })
      expect(await db('pageMutationOutbox').first('status', 'leaseToken')).toMatchObject({ status: 'succeeded', leaseToken: null })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      firstRelease.resolve()
      replacementRelease.resolve()
      await Promise.all([firstRunning?.catch(() => undefined), replacementRunning?.catch(() => undefined)])
      vi.useRealTimers()
    }
  })

  it('aborts in-flight enrichment when its lease heartbeat discovers a replacement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'))
    const firstEntered = Promise.withResolvers<void>()
    const stopFirst = Promise.withResolvers<void>()
    const replacementEntered = Promise.withResolvers<void>()
    const replacementRelease = Promise.withResolvers<void>()
    let firstSignal: AbortSignal | undefined
    let firstRunning: Promise<unknown> | undefined
    let replacementRunning: Promise<unknown> | undefined

    try {
      await enableUtilityEnrichment()
      const current = page()
      await db('pages').insert(current)
      await enqueueKnowledge('1', String(current.content), 'create')
      firstRunning = new PageKnowledgeLifecycle(db, 'aborted-worker', {
        enrichKnowledge: vi.fn(async request => {
          firstSignal = request.signal
          firstEntered.resolve()
          const aborted = Promise.withResolvers<void>()
          const onAbort = (): void => aborted.resolve()
          if (request.signal.aborted) aborted.resolve()
          else request.signal.addEventListener('abort', onAbort, { once: true })
          try {
            await Promise.race([aborted.promise, stopFirst.promise])
          } finally {
            request.signal.removeEventListener('abort', onAbort)
          }
          request.signal.throwIfAborted()
          return utilityResult('aborted-worker')
        })
      }).runOnce()
      await firstEntered.promise

      vi.setSystemTime(new Date('2026-08-18T12:02:00.001Z'))
      replacementRunning = new PageKnowledgeLifecycle(db, 'replacement-worker', {
        enrichKnowledge: vi.fn(async () => {
          replacementEntered.resolve()
          await replacementRelease.promise
          return utilityResult('replacement-worker')
        })
      }).runOnce()
      await replacementEntered.promise

      await vi.advanceTimersByTimeAsync(60_000)
      await firstRunning

      expect(firstSignal?.aborted).toBe(true)
      expect(await db('pageKnowledgeProjections').first()).toBeUndefined()
      expect(await db('pageMutationOutbox').first('leaseOwner', 'status')).toMatchObject({ leaseOwner: 'replacement-worker', status: 'running' })

      replacementRelease.resolve()
      await replacementRunning
      expect(await db('pageMutationOutbox').first('status', 'leaseToken')).toMatchObject({ status: 'succeeded', leaseToken: null })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      stopFirst.resolve()
      replacementRelease.resolve()
      await Promise.all([firstRunning?.catch(() => undefined), replacementRunning?.catch(() => undefined)])
      vi.useRealTimers()
    }
  })

  it('retains a complete deterministic projection when optional utility enrichment fails', async () => {
    const profileVersionId = '00000000-0000-4000-8000-000000000001'
    await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
    await db('agentProviderProfiles').insert({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'enabled',
      isGlobalDefault: true,
      conformed: true,
      currentVersionId: profileVersionId,
      deletedAt: null
    })
    const current = page()
    await db('pages').insert(current)
    await enqueueKnowledge('1', String(current.content), 'create')

    await new PageKnowledgeLifecycle(db, 'failure-worker', {
      enrichKnowledge: vi.fn(async () => {
        throw new Error('invalid utility output')
      })
    }).runOnce()

    expect(await db('pageKnowledgeProjections').first('state', 'enrichmentState', 'lastError')).toMatchObject({
      state: 'complete',
      enrichmentState: 'failed',
      lastError: 'invalid utility output'
    })
    expect(await db('pageMutationOutbox').where({ effectKind: 'knowledge' }).first('status')).toEqual({ status: 'succeeded' })
  })
  it('keeps private pages deterministic and never sends them to the utility provider', async () => {
    const current = page({ visibility: 'private', ownerId: 5 })
    await db('pages').insert(current)
    await enqueuePageMutationEffects(db, {
      pageId: 42,
      sourceRevision: '1',
      desiredState: 'present',
      action: 'create',
      source: String(current.content),
      location: { locale: 'en', path: 'ops/runbook', visibility: 'private', ownerId: 5 },
      effects: ['knowledge']
    })
    const enrichKnowledge = vi.fn()

    await new PageKnowledgeLifecycle(db, 'private-worker', { enrichKnowledge }).runOnce()

    expect(enrichKnowledge).not.toHaveBeenCalled()
    expect(await db('pageKnowledgeProjections').first('state', 'enrichmentState')).toMatchObject({ state: 'complete', enrichmentState: 'withheld-private' })
  })

  it('treats SQL wildcard characters as literal knowledge search input', async () => {
    const literal = page({ id: 1, title: '100% reliable', path: 'literal-percent' })
    const ordinary = page({ id: 2, title: 'Ordinary runbook', path: 'ordinary' })
    for (const source of [literal, ordinary]) {
      await db('pages').insert(source)
      await enqueuePageMutationEffects(db, {
        pageId: Number(source.id),
        sourceRevision: source.sourceRevision,
        desiredState: 'present',
        action: 'create',
        source: String(source.content),
        location: {
          locale: String(source.localeCode),
          path: String(source.path),
          visibility: 'public',
          ownerId: null
        },
        effects: ['knowledge']
      })
    }
    await new PageKnowledgeLifecycle(db, 'search-worker').runOnce()
    vi.stubGlobal('WIKI', { auth: { checkAccess: vi.fn().mockReturnValue(true) } })
    try {
      expect(
        await new PageKnowledgeRepository(db).searchVisible({
          query: '%',
          requester: { id: 5 } as Express.User,
          limit: 10
        })
      ).toMatchObject([{ id: 1, path: 'literal-percent' }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fills the requested limit after password and knowledge filters in deterministic order', async () => {
    const sources = [
      page({ id: 1, path: 'protected', title: 'Common protected', extra: JSON.stringify({ okf: { type: 'Procedure', status: 'stable' } }) }),
      page({ id: 2, path: 'filtered', title: 'Common filtered', extra: JSON.stringify({ okf: { type: 'Reference', status: 'stable' } }) }),
      page({ id: 3, path: 'eligible/z', title: 'Common eligible Z', extra: JSON.stringify({ okf: { type: 'Procedure', status: 'stable' } }) }),
      page({ id: 4, path: 'eligible/a', title: 'Common eligible A', extra: JSON.stringify({ okf: { type: 'Procedure', status: 'stable' } }) })
    ]
    for (const source of sources) {
      await db('pages').insert(source)
      await enqueuePageMutationEffects(db, {
        pageId: Number(source.id),
        sourceRevision: source.sourceRevision,
        desiredState: 'present',
        action: 'create',
        source: String(source.content),
        location: {
          locale: String(source.localeCode),
          path: String(source.path),
          visibility: 'public',
          ownerId: null
        },
        effects: ['knowledge']
      })
    }
    await db('pageAccessPasswords').insert({ pageId: 1 })
    await new PageKnowledgeLifecycle(db, 'search-worker').runOnce()
    vi.stubGlobal('WIKI', { auth: { checkAccess: vi.fn().mockReturnValue(true) } })
    try {
      expect(
        await new PageKnowledgeRepository(db).searchVisible({
          query: 'common',
          requester: { id: 5 } as Express.User,
          limit: 2,
          filter: { conceptType: 'Procedure' }
        })
      ).toMatchObject([
        { id: 4, path: 'eligible/a' },
        { id: 3, path: 'eligible/z' }
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
