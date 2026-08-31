import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from './bun-test.mts'
import { enqueuePageMutationEffects } from '../core/page-mutation-outbox.ts'
import { up as createProjectionStore } from '../db/migrations/2.5.152.ts'
import { PageKnowledgeLifecycle } from '../knowledge/lifecycle.ts'
import {
  KnowledgeProjectionSchema,
  KnowledgeProjectionViewSchema,
  knowledgeProjectionView,
  mergeKnowledgeUtilityResult,
  projectPageKnowledge
} from '../knowledge/projection.ts'
import { parseOkfDocument } from '../okf/format.ts'

const source = {
  pageId: 42,
  sourceRevision: '7',
  locale: 'en',
  path: 'operations/deploy',
  visibility: 'public' as const,
  contentType: 'markdown',
  content: '# Deploy\n\nUse the release pipeline exactly.\n',
  title: 'Deploy',
  description: null,
  tags: [] as string[],
  updatedAt: '2026-08-18T12:00:00.000Z',
  authorId: 5,
  metadata: {
    type: 'Procedure',
    status: 'draft',
    generated: { by: 'human:5', at: '2026-08-18T12:00:00.000Z' },
    verified: { by: 'human:6', at: '2026-08-17T12:00:00.000Z' },
    stale_after: '2026-08-20T00:00:00.000Z'
  }
}

describe('page knowledge projection', () => {
  it('is deterministic and never mutates authoritative source', () => {
    const original = structuredClone(source)
    const first = projectPageKnowledge(source)
    const second = projectPageKnowledge(source)

    expect(first).toEqual(second)
    expect(source).toEqual(original)
    expect(first.source.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(projectPageKnowledge({ ...source, title: 'Deploy revised' }).source.sha256).not.toBe(first.source.sha256)
    expect(first.concept.sections).toEqual([expect.objectContaining({ id: 'deploy', title: 'Deploy', startLine: 1, endLine: 3 })])
    expect(first.lifecycle).toMatchObject({ status: 'draft', trustTier: 'human-reviewed', verification: 'outdated' })
    expect(first.completeness.missingFields).toEqual(['concept.tags', 'concept.entities', 'concept.relationships', 'concept.openQuestions'])
    expect(first.completeness.state).toBe('complete')
  })

  it('accepts utility values only for declared gaps and records exact provenance', () => {
    const deterministic = projectPageKnowledge(source)
    const enriched = mergeKnowledgeUtilityResult(
      deterministic,
      {
        type: 'WrongOverride',
        summary: 'Wrong override',
        tags: ['release', 'operations'],
        entities: [{ name: 'Release pipeline', type: 'System' }],
        relationships: [{ subject: 'Deploy', predicate: 'uses', object: 'Release pipeline' }],
        openQuestions: ['Who owns rollback?']
      },
      {
        profileVersionId: '00000000-0000-4000-8000-000000000001',
        model: 'utility-small',
        inputSha256: 'a'.repeat(64),
        outputSha256: 'b'.repeat(64),
        generatedAt: '2026-08-18T12:01:00.000Z'
      }
    )

    expect(enriched.concept.type).toBe('Procedure')
    expect(enriched.concept.summary).toBe('Use the release pipeline exactly.')
    expect(enriched.concept.tags).toEqual(['release', 'operations'])
    expect(enriched.completeness).toEqual({ state: 'complete', missingFields: [] })
    expect(enriched.provenance.utility).toMatchObject({ model: 'utility-small', outputSha256: 'b'.repeat(64) })
    const fieldProvenance = knowledgeProjectionView(enriched).provenance.fields
    expect(fieldProvenance).toContainEqual({ field: 'concept.type', source: 'metadata', evidence: 'pages.extra.okf.type' })
    expect(fieldProvenance).toContainEqual({ field: 'concept.tags', source: 'utility', evidence: 'b'.repeat(64) })
    expect(fieldProvenance).not.toContainEqual(expect.objectContaining({ field: 'concept.type', source: 'utility' }))
  })

  it('keeps declined utility gaps partial', () => {
    const deterministic = projectPageKnowledge(source)
    const enriched = mergeKnowledgeUtilityResult(
      deterministic,
      {
        type: null,
        summary: null,
        tags: [],
        entities: [],
        relationships: [],
        openQuestions: []
      },
      {
        profileVersionId: '00000000-0000-4000-8000-000000000001',
        model: 'utility-small',
        inputSha256: 'a'.repeat(64),
        outputSha256: 'b'.repeat(64),
        generatedAt: '2026-08-18T12:01:00.000Z'
      }
    )

    expect(enriched.completeness).toEqual(deterministic.completeness)
    expect(enriched.provenance.fields).toEqual(deterministic.provenance.fields)
  })
  it('computes staleness at read time without rewriting the projection', () => {
    const projection = projectPageKnowledge(source)
    expect(knowledgeProjectionView(projection, new Date('2026-08-19T00:00:00.000Z')).lifecycle.stale).toBe(false)
    expect(knowledgeProjectionView(projection, new Date('2026-08-21T00:00:00.000Z')).lifecycle.stale).toBe(true)
  })
  it('degrades invalid or unvalidated lifecycle metadata to unverified defaults', () => {
    const malformedMetadata = [
      {
        type: 'Procedure',
        verified: { by: 6, at: '2026-08-19T12:00:00.000Z' }
      },
      {
        type: 'Procedure',
        status: 'approved',
        verified: { by: 'human:6', at: '2026-08-19T12:00:00.000Z' }
      },
      {
        type: 'Procedure',
        verified: { by: 'human:6', at: '2026-08-19 12:00:00' }
      },
      {
        status: 'deprecated',
        verified: { by: 'human:spoofed', at: '2026-08-19T12:00:00.000Z' }
      }
    ]

    for (const metadata of malformedMetadata) {
      const projection = projectPageKnowledge({ ...source, metadata })
      expect(projection.concept.type).toBeNull()
      expect(projection.lifecycle).toEqual({
        status: 'stable',
        trustTier: 'unverified',
        verification: 'unverified',
        generatedAt: source.updatedAt,
        verifiedAt: null,
        staleAfter: null
      })
      expect(projection.provenance.fields).toContainEqual({
        field: 'lifecycle.trustTier',
        source: 'deterministic',
        evidence: 'validated OKF unverified default'
      })
    }
  })

  it('uses the same validated trust interpretation as the OKF parser', () => {
    const parsed = parseOkfDocument(
      `---
type: Procedure
status: deprecated
generated:
  by: machine:generator
  at: 2026-08-18T12:00:00.000Z
verified:
  - by: machine:checker
    at: 2026-08-18T12:30:00.000Z
  - by: human:6
    at: 2026-08-18T13:00:00.000Z
stale_after: 2026-08-20T00:00:00.000Z
---

# Deploy
`,
      new Date('2026-08-19T00:00:00.000Z')
    )
    const projection = projectPageKnowledge({ ...source, metadata: parsed.metadata })

    expect(projection.lifecycle).toEqual({
      status: parsed.trust.status,
      trustTier: parsed.trust.trustTier,
      verification: parsed.trust.verification,
      generatedAt: parsed.trust.generatedAt,
      verifiedAt: parsed.trust.verifiedAt,
      staleAfter: parsed.metadata.stale_after
    })
  })

  it('preserves metadata source order and stably deduplicates derived external links', () => {
    const projection = projectPageKnowledge({
      ...source,
      content: [
        '# Deploy',
        '[Canonical link](https://example.com/canonical)',
        '[First derived label](https://example.com/first)',
        '[Derived only](https://example.com/derived)'
      ].join('\n'),
      metadata: {
        type: 'Procedure',
        resource: 'https://example.com/canonical',
        sources: [
          { resource: 'https://example.com/first', title: 'First metadata title' },
          { resource: 'https://example.com/canonical', title: 'Canonical metadata title' },
          { resource: 'https://example.com/first', title: 'Duplicate title' }
        ]
      }
    })

    expect(projection.concept.sources).toEqual([
      { resource: 'https://example.com/canonical', title: 'Canonical metadata title' },
      { resource: 'https://example.com/first', title: 'First metadata title' },
      { resource: 'https://example.com/derived', title: 'Derived only' }
    ])
    expect(projection.provenance.fields.filter(field => field.field === 'concept.sources')).toEqual([
      { field: 'concept.sources', source: 'metadata', evidence: 'pages.extra.okf.resource' },
      { field: 'concept.sources', source: 'metadata', evidence: 'pages.extra.okf.sources' },
      { field: 'concept.sources', source: 'deterministic', evidence: 'Markdown external link destinations' }
    ])
  })

  it('exposes bounded field provenance in projection views', () => {
    const view = knowledgeProjectionView(projectPageKnowledge(source))
    expect(view.provenance.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'concept.type', source: 'metadata' }),
        expect.objectContaining({ field: 'concept.summary', source: 'deterministic' })
      ])
    )
    const oversized = {
      ...view,
      provenance: {
        ...view.provenance,
        fields: Array.from({ length: 101 }, () => view.provenance.fields![0]!)
      }
    }
    expect(KnowledgeProjectionViewSchema.safeParse(oversized).success).toBe(false)
    expect(KnowledgeProjectionSchema.parse(projectPageKnowledge(source)).provenance.fields.length).toBeLessThanOrEqual(100)
  })

  it('keeps section IDs unique across duplicate, truncated, and naturally suffixed headings', () => {
    const longHeading = 'a'.repeat(300)
    const projection = projectPageKnowledge({
      ...source,
      content: [`# ${longHeading}`, `# ${longHeading}`, `# ${longHeading} 2`].join('\n')
    })
    const ids = projection.concept.sections.map(section => section.id)

    expect(ids).toEqual(['a'.repeat(255), `${'a'.repeat(253)}-2`, `${'a'.repeat(253)}-3`])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not close Markdown fences with shorter or different delimiters', () => {
    const projection = projectPageKnowledge({
      ...source,
      content: ['# Visible before', '````ts', '# Hidden one', '```', '# Hidden two', '~~~~', '# Hidden three', '`````', '# Visible after'].join('\n')
    })

    expect(projection.concept.sections.map(section => section.title)).toEqual(['Visible before', 'Visible after'])
  })

  it('marks self-contained typed pages complete while retaining optional enrichment gaps', () => {
    const projection = projectPageKnowledge({
      ...source,
      metadata: { type: 'Procedure', status: 'stable' }
    })

    expect(projection.completeness).toEqual({
      state: 'complete',
      missingFields: ['concept.tags', 'concept.entities', 'concept.relationships']
    })
  })
})

describe('terminal knowledge effect recovery', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
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
    await db.schema.createTable('tags', table => {
      table.increments('id').primary()
      table.string('tag').notNullable()
    })
    await db.schema.createTable('pageTags', table => {
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
    await createProjectionStore(db)
  })

  afterEach(async () => db.destroy())

  it('age-gates and rearms a terminal current effect without weakening immutable conflicts', async () => {
    const current = {
      id: 42,
      sourceRevision: '7',
      content: '# Recover\n\nProject this authoritative revision.\n',
      localeCode: 'en',
      path: 'operations/recover',
      visibility: 'public',
      ownerId: null,
      contentType: 'markdown',
      title: 'Recover',
      description: null,
      updatedAt: '2026-08-18T12:00:00.000Z',
      authorId: 5,
      extra: JSON.stringify({ okf: { type: 'Procedure', status: 'stable' } })
    }
    const location = { locale: 'en', path: 'operations/recover', visibility: 'public' as const, ownerId: null }
    await db('pages').insert(current)
    await enqueuePageMutationEffects(db, {
      pageId: 42,
      sourceRevision: '7',
      desiredState: 'present',
      action: 'update',
      source: current.content,
      location,
      effects: ['knowledge']
    })
    await db('pageMutationOutbox').update({ status: 'failed', attempts: 5 })

    expect(await new PageKnowledgeLifecycle(db, 'recovery-age-gate').runOnce()).toMatchObject({ requeued: 0, processed: 0 })
    expect(await db('pageKnowledgeProjections')).toHaveLength(0)

    await db('pageMutationOutbox').update({ updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1_000).toISOString() })
    expect(await new PageKnowledgeLifecycle(db, 'recovery-worker').runOnce()).toMatchObject({ requeued: 1, processed: 1 })

    const effects = await db('pageMutationOutbox').select('status', 'attempts')
    expect(effects).toEqual([{ status: 'succeeded', attempts: 1 }])
    const rows = await db('pageKnowledgeProjections').select('sourceRevision', 'sourceSha256', 'projection')
    expect(rows).toHaveLength(1)
    expect(String(rows[0]?.sourceRevision)).toBe('7')
    expect(rows[0]?.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(KnowledgeProjectionSchema.parse(JSON.parse(String(rows[0]?.projection))).source).toMatchObject({
      pageId: 42,
      sourceRevision: '7',
      sha256: rows[0]?.sourceSha256
    })

    await expect(
      Promise.resolve(
        enqueuePageMutationEffects(db, {
          pageId: 42,
          sourceRevision: '7',
          desiredState: 'present',
          action: 'update',
          source: '# Conflicting source\n',
          location,
          effects: ['knowledge']
        })
      )
    ).rejects.toMatchObject({ code: 'OUTBOX_IDEMPOTENCY_CONFLICT' })

    expect(await new PageKnowledgeLifecycle(db, 'recovery-idempotency').runOnce()).toMatchObject({ requeued: 0, processed: 0 })
    expect(await db('pageMutationOutbox')).toHaveLength(1)
    expect(await db('pageKnowledgeProjections')).toHaveLength(1)
  })
})
