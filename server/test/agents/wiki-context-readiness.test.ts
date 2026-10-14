import type { DecisionBatchResult } from '../../../shared/agents/decision-providers.ts'
import { assessWikiContextReadiness, buildWikiContextReadinessRequest } from '../../agents/providers/wiki-context-readiness.ts'
import { describe, expect, it } from '../bun-test.mts'
import { wikiContextReadinessCases } from './fixtures/wiki-context-readiness-cases.ts'

const input = wikiContextReadinessCases[0]!.input
const read = input.reads[0]!
const result = (answer: unknown): DecisionBatchResult => ({ answers: { context_readiness: answer } }) as DecisionBatchResult

// These tests qualify deterministic gates only; the frozen semantic cases require independent native qualification.
describe('Wiki context readiness deterministic safety gates', () => {
  it('requires both confidence and selected probability strictly above 0.8', () => {
    for (const [confidence, probability, expected] of [
      [0.81, 0.81, true], [1, 1, true], [0.8, 0.9, false], [0.9, 0.8, false], [0.79, 0.9, false], [0.9, 0.79, false]
    ] as const) {
      expect(assessWikiContextReadiness(result({ choice: 'answerable', confidence,
        probabilities: { answerable: probability, collect: (1 - probability) / 2, not_established: (1 - probability) / 2 } }))).toBe(expected)
    }
  })

  it('never treats normal negative or uncertain judgments as readiness', () => {
    for (const choice of ['collect', 'not_established']) {
      expect(assessWikiContextReadiness(result({ choice, confidence: 1,
        probabilities: { answerable: 0, collect: choice === 'collect' ? 1 : 0, not_established: choice === 'not_established' ? 1 : 0 } }))).toBe(false)
    }
  })

  it('fails closed for wrong questions and malformed native distributions', () => {
    const positive = { choice: 'answerable', confidence: 0.95, probabilities: { answerable: 0.95, collect: 0.03, not_established: 0.02 } }
    for (const malformed of [
      null, {}, { ...positive, confidence: Number.NaN }, { ...positive, confidence: 1.1 },
      { ...positive, probabilities: { answerable: 0.95, collect: 0.05 } },
      { ...positive, probabilities: { answerable: 0.95, collect: 0.03, not_established: 0.02, extra: 0 } },
      { ...positive, probabilities: { answerable: 0.95, collect: 0.95, not_established: 0.02 } },
      { ...positive, probabilities: { answerable: 0.95, collect: -0.01, not_established: 0.06 } },
      { ...positive, probabilities: { answerable: Number.POSITIVE_INFINITY, collect: 0, not_established: 0 } },
      { ...positive, choice: 'unknown' }, { ...positive, extra: 'not part of the answer contract' }
    ]) expect(assessWikiContextReadiness(result(malformed))).toBe(false)
    for (const malformed of [null, {}, { answers: [] }, { answers: {} },
      { answers: { other: positive } }, { answers: { context_readiness: positive, other: positive } }
    ]) expect(assessWikiContextReadiness(malformed as DecisionBatchResult)).toBe(false)
  })

  it('skips only absent reads or optional request capacity, without hiding invalid bindings', () => {
    expect(buildWikiContextReadinessRequest({ ...input, reads: [] })).toBeNull()
    const large = { ...read, source: 'é'.repeat(130_000), authorText: 'é'.repeat(130_000) }
    expect(buildWikiContextReadinessRequest({ ...input, reads: [large] })).toBeNull()
    expect(() => buildWikiContextReadinessRequest({ ...input, reads: [{ ...large, readId: '' }] })).toThrow('incomplete exact read binding')
    expect(() => buildWikiContextReadinessRequest({ ...input, reads: [large, { ...large, sourceRevision: 'other' }] })).toThrow('duplicate or ambiguous evidence identity')
    expect(() => buildWikiContextReadinessRequest({ ...input, scope: { unsupported: undefined } })).toThrow('scope must be finite JSON')
  })

  it('rejects conflicting physical bindings while admitting distinct aliases of the same complete read', () => {
    const alias = { ...read, evidenceId: 'fixture:alias' }
    expect(buildWikiContextReadinessRequest({ ...input, reads: [read, alias] })).not.toBeNull()
    for (const changed of [{ sourceRevision: 'other' }, { source: 'other body' }, { authorText: 'other authored boundary' }, { context: 'other title' }]) {
      expect(() => buildWikiContextReadinessRequest({ ...input, reads: [read, { ...alias, ...changed }] })).toThrow('conflicting physical read binding')
    }
    expect(buildWikiContextReadinessRequest({ ...input, reads: [{ ...read, source: '', authorText: '' }] })).not.toBeNull()
  })
})
