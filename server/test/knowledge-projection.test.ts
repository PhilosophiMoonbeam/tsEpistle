import { describe, expect, it } from 'vitest'
import {
  knowledgeProjectionView,
  mergeKnowledgeUtilityResult,
  projectPageKnowledge
} from '../knowledge/projection.ts'

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
    expect(first.concept.sections).toEqual([
      expect.objectContaining({ id: 'deploy', title: 'Deploy', startLine: 1, endLine: 3 })
    ])
    expect(first.lifecycle).toMatchObject({ status: 'draft', trustTier: 'human-reviewed', verification: 'outdated' })
    expect(first.completeness.missingFields).toEqual(['concept.tags', 'concept.entities', 'concept.relationships', 'concept.openQuestions'])
  })

  it('accepts utility values only for declared gaps and records exact provenance', () => {
    const deterministic = projectPageKnowledge(source)
    const enriched = mergeKnowledgeUtilityResult(deterministic, {
      type: 'WrongOverride',
      summary: 'Wrong override',
      tags: ['release', 'operations'],
      entities: [{ name: 'Release pipeline', type: 'System' }],
      relationships: [{ subject: 'Deploy', predicate: 'uses', object: 'Release pipeline' }],
      openQuestions: ['Who owns rollback?']
    }, {
      profileVersionId: '00000000-0000-4000-8000-000000000001',
      model: 'utility-small',
      inputSha256: 'a'.repeat(64),
      outputSha256: 'b'.repeat(64),
      generatedAt: '2026-08-18T12:01:00.000Z'
    })

    expect(enriched.concept.type).toBe('Procedure')
    expect(enriched.concept.summary).toBe('Use the release pipeline exactly.')
    expect(enriched.concept.tags).toEqual(['release', 'operations'])
    expect(enriched.completeness).toEqual({ state: 'complete', missingFields: [] })
    expect(enriched.provenance.utility).toMatchObject({ model: 'utility-small', outputSha256: 'b'.repeat(64) })
  })


  it('keeps declined utility gaps partial', () => {
    const deterministic = projectPageKnowledge(source)
    const enriched = mergeKnowledgeUtilityResult(deterministic, {
      type: null,
      summary: null,
      tags: [],
      entities: [],
      relationships: [],
      openQuestions: []
    }, {
      profileVersionId: '00000000-0000-4000-8000-000000000001',
      model: 'utility-small',
      inputSha256: 'a'.repeat(64),
      outputSha256: 'b'.repeat(64),
      generatedAt: '2026-08-18T12:01:00.000Z'
    })

    expect(enriched.completeness).toEqual(deterministic.completeness)
    expect(enriched.provenance.fields).toEqual(deterministic.provenance.fields)
  })
  it('computes staleness at read time without rewriting the projection', () => {
    const projection = projectPageKnowledge(source)
    expect(knowledgeProjectionView(projection, new Date('2026-08-19T00:00:00.000Z')).lifecycle.stale).toBe(false)
    expect(knowledgeProjectionView(projection, new Date('2026-08-21T00:00:00.000Z')).lifecycle.stale).toBe(true)
  })
})
