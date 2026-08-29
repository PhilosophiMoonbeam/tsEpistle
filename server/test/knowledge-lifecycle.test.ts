import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import type { AgentKnowledgeEnricher } from '../agents/providers/utility.ts'
import { enqueuePageMutationEffects } from '../core/page-mutation-outbox.ts'
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
    table.dateTime('updatedAt').notNullable()
    table.integer('authorId').notNullable()
    table.text('extra').notNullable()
  })
  await db.schema.createTable('tags', table => { table.increments('id').primary(); table.string('tag').notNullable() })
  await db.schema.createTable('pageTags', table => { table.integer('pageId').notNullable(); table.integer('tagId').notNullable() })
  await db.schema.createTable('pageHistoryTags', table => { table.integer('pageId').notNullable(); table.integer('tagId').notNullable() })
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
    table.uuid('id').primary(); table.string('status').notNullable(); table.boolean('isGlobalDefault').notNullable(); table.boolean('conformed').notNullable(); table.uuid('currentVersionId').nullable(); table.dateTime('deletedAt').nullable()
  })
  await db.schema.createTable('agentProviderProfileVersions', table => { table.uuid('id').primary(); table.boolean('conformed').notNullable() })
  await db.schema.createTable('pageAccessPasswords', table => { table.integer('pageId').notNullable() })
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

const enqueueKnowledge = async (sourceRevision: string, content: string, action: 'create' | 'update') => enqueuePageMutationEffects(db, {
  pageId: 42,
  sourceRevision,
  desiredState: 'present',
  action,
  source: content,
  location: { locale: 'en', path: 'ops/runbook', visibility: 'public', ownerId: null },
  effects: ['knowledge']
})

beforeEach(async () => {
  db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await createSchema()
})
afterEach(async () => db.destroy())

describe('page knowledge lifecycle', () => {
  it('projects manual and agent revisions from their exact immutable source snapshots', async () => {
    const first = page()
    await db('pages').insert(first)
    await enqueueKnowledge('1', String(first.content), 'create')
    await db('pageHistory').insert({ ...first, pageId: 42 })
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
    expect(await new PageKnowledgeRepository(db).getCurrent(42)).toMatchObject({ sourceRevision: '2' })
  })

  it('uses the global utility model only for declared public gaps', async () => {
    const profileVersionId = '00000000-0000-4000-8000-000000000001'
    await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
    await db('agentProviderProfiles').insert({ id: '00000000-0000-4000-8000-000000000002', status: 'enabled', isGlobalDefault: true, conformed: true, currentVersionId: profileVersionId, deletedAt: null })
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

  it('discards utility output when the exact source revision changes in flight', async () => {
    const profileVersionId = '00000000-0000-4000-8000-000000000001'
    await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
    await db('agentProviderProfiles').insert({ id: '00000000-0000-4000-8000-000000000002', status: 'enabled', isGlobalDefault: true, conformed: true, currentVersionId: profileVersionId, deletedAt: null })
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
      state: 'partial',
      enrichmentState: 'superseded',
      utilityModel: null
    })
    expect(await db('pageMutationOutbox').where({ effectKind: 'knowledge' }).first('status', 'result')).toMatchObject({ status: 'succeeded', result: expect.stringContaining('superseded') })
  })


  it('retains a partial deterministic projection when utility enrichment fails', async () => {
    const profileVersionId = '00000000-0000-4000-8000-000000000001'
    await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
    await db('agentProviderProfiles').insert({ id: '00000000-0000-4000-8000-000000000002', status: 'enabled', isGlobalDefault: true, conformed: true, currentVersionId: profileVersionId, deletedAt: null })
    const current = page()
    await db('pages').insert(current)
    await enqueueKnowledge('1', String(current.content), 'create')

    await new PageKnowledgeLifecycle(db, 'failure-worker', {
      enrichKnowledge: vi.fn(async () => { throw new Error('invalid utility output') })
    }).runOnce()

    expect(await db('pageKnowledgeProjections').first('state', 'enrichmentState', 'lastError')).toMatchObject({
      state: 'partial',
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
    expect(await db('pageKnowledgeProjections').first('state', 'enrichmentState')).toMatchObject({ state: 'partial', enrichmentState: 'withheld-private' })
  })
})
