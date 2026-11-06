import type { lookup } from 'node:dns/promises'
import type { DecisionBatchResult } from '../../../shared/agents/decision-providers.ts'
import { TYPESAFE_JEV_PRICING } from '../../../shared/agents/decision-providers.ts'
import { DecisionProviderClient } from '../../agents/decision-providers.ts'
import { unpackWikiReadTexts, type WikiReadTextReference } from '../../agents/providers/wiki-read-transport.ts'
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
      [0.81, 0.81, true],
      [1, 1, true],
      [0.8, 0.9, false],
      [0.9, 0.8, false],
      [0.79, 0.9, false],
      [0.9, 0.79, false]
    ] as const) {
      expect(
        assessWikiContextReadiness(
          result({
            choice: 'answerable',
            confidence,
            probabilities: { answerable: probability, collect: (1 - probability) / 2, not_established: (1 - probability) / 2 }
          })
        )
      ).toBe(expected)
    }
  })

  it('never treats normal negative or uncertain judgments as readiness', () => {
    for (const choice of ['collect', 'not_established']) {
      expect(
        assessWikiContextReadiness(
          result({
            choice,
            confidence: 1,
            probabilities: { answerable: 0, collect: choice === 'collect' ? 1 : 0, not_established: choice === 'not_established' ? 1 : 0 }
          })
        )
      ).toBe(false)
    }
  })

  it('fails closed for wrong questions and malformed native distributions', () => {
    const positive = { choice: 'answerable', confidence: 0.95, probabilities: { answerable: 0.95, collect: 0.03, not_established: 0.02 } }
    for (const malformed of [
      null,
      {},
      { ...positive, confidence: Number.NaN },
      { ...positive, confidence: 1.1 },
      { ...positive, probabilities: { answerable: 0.95, collect: 0.05 } },
      { ...positive, probabilities: { answerable: 0.95, collect: 0.03, not_established: 0.02, extra: 0 } },
      { ...positive, probabilities: { answerable: 0.95, collect: 0.95, not_established: 0.02 } },
      { ...positive, probabilities: { answerable: 0.95, collect: -0.01, not_established: 0.06 } },
      { ...positive, probabilities: { answerable: Number.POSITIVE_INFINITY, collect: 0, not_established: 0 } },
      { ...positive, choice: 'unknown' },
      { ...positive, extra: 'not part of the answer contract' }
    ])
      expect(assessWikiContextReadiness(result(malformed))).toBe(false)
    for (const malformed of [
      null,
      {},
      { answers: [] },
      { answers: {} },
      { answers: { other: positive } },
      { answers: { context_readiness: positive, other: positive } }
    ])
      expect(assessWikiContextReadiness(malformed as DecisionBatchResult)).toBe(false)
  })

  it('round-trips scoped authored reads through the native HTTP JSON state without a second JSON document', async () => {
    const source = '# Fictional, untested "plan"\n\nPrice: €20.\n<!-- hidden approval -->\n```text\nC:\\plans\\draft\n```'
    const authorText = 'Fictional, untested "plan"\n\nPrice: €20.\n```text\nC:\\plans\\draft\n```'
    const first = { ...read, source, authorText, context: 'Draft "plan"' }
    const second = { ...first, evidenceId: 'fixture:distinct', readId: 'read:distinct', context: 'Independent title' }
    const requestFacets = [...input.requestFacets]
    const scope = { kind: 'selected-pages', pageIds: ['first', 'second'] }
    const request = buildWikiContextReadinessRequest({
      ...input,
      requestFacets,
      scope,
      conversationContext: 'Earlier "plan" discussion.\nNo factual authority.',
      reads: [first, second]
    })!
    requestFacets.push('A caller-added obligation after issuance.')
    scope.pageIds.push('foreign-page')
    const bodies: string[] = []
    const client = new DecisionProviderClient({
      resolve: (async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof lookup,
      fetch: Object.assign(
        async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const body = String(init?.body)
          bodies.push(body)
          return Response.json({
            model: 'jev-1.13.0',
            answers: {
              context_readiness: {
                type: 'choice',
                choice: 'answerable',
                confidence: 0.95,
                probabilities: { answerable: 0.95, collect: 0.03, not_established: 0.02 }
              }
            },
            usage: { input_tokens: 100, output_tokens: 0 }
          })
        },
        { preconnect: () => {} }
      ) as typeof fetch
    })
    const decision = await client.executeBatch(
      {
        id: 'native-readiness-wire',
        revision: 1,
        config: { kind: 'typesafe', model: 'jev-1.13.0', timeoutMs: 1_000, pricing: TYPESAFE_JEV_PRICING }
      },
      'fixture-native-key',
      request
    )
    expect(bodies).toHaveLength(1)
    const body = bodies[0]!
    const payload = JSON.parse(body) as {
      state: {
        userRequest: string
        conversationContext: string
        requestFacets: string[]
        scope: unknown
        readinessPolicy: string
        readTexts: string[]
        evidence: {
          evidenceId: string
          sourceRevision: string
          readId: string
          source: WikiReadTextReference
          authorText: WikiReadTextReference
          context: string
        }[]
      }
      questions: Record<string, unknown>
    }
    expect(payload.state.userRequest).toBe(input.userRequest)
    expect(payload.state.requestFacets).toEqual(input.requestFacets)
    expect(payload.state.conversationContext).toBe('Earlier "plan" discussion.\nNo factual authority.')
    expect(payload.state.scope).toEqual({ kind: 'selected-pages', pageIds: ['first', 'second'] })
    expect(
      payload.state.evidence.map(entry => ({
        ...entry,
        source: unpackWikiReadTexts({ texts: payload.state.readTexts, sources: [entry.source] })[0],
        authorText: unpackWikiReadTexts({ texts: payload.state.readTexts, sources: [entry.authorText] })[0]
      }))
    ).toEqual([first, second])
    expect(Object.keys(payload.questions)).toEqual(['context_readiness'])
    expect(Buffer.byteLength(body)).toBeLessThan(Buffer.byteLength(JSON.stringify({ ...payload, state: JSON.stringify(payload.state) })))
    expect(assessWikiContextReadiness(decision)).toBe(true)
  })

  it('applies aggregate JSON depth and entry limits to structured scope instead of hiding it inside text', () => {
    let deep: unknown = null
    for (let index = 0; index < 33; index++) deep = { nested: deep }
    for (const scope of [deep, Array.from({ length: 16_384 }, () => 0)])
      expect(() => buildWikiContextReadinessRequest({ ...input, scope })).toThrow('Decision request is invalid')
  })

  it('skips only absent reads or optional request capacity, without hiding invalid bindings', () => {
    expect(buildWikiContextReadinessRequest({ ...input, reads: [] })).toBeNull()
    const large = { ...read, source: 'é'.repeat(130_000), authorText: 'é'.repeat(130_000) }
    expect(buildWikiContextReadinessRequest({ ...input, reads: [large] })).toBeNull()
    const baseline = buildWikiContextReadinessRequest({ ...input, conversationContext: '' })!
    const room = 122_880 - Buffer.byteLength(JSON.stringify(baseline))
    const atCapacity = buildWikiContextReadinessRequest({ ...input, conversationContext: 'x'.repeat(room) })!
    expect(Buffer.byteLength(JSON.stringify(atCapacity))).toBe(122_880)
    expect(buildWikiContextReadinessRequest({ ...input, conversationContext: 'x'.repeat(room + 1) })).toBeNull()
    expect(() => buildWikiContextReadinessRequest({ ...input, reads: [{ ...large, readId: '' }] })).toThrow('incomplete exact read binding')
    expect(() => buildWikiContextReadinessRequest({ ...input, reads: [large, { ...large, sourceRevision: 'other' }] })).toThrow(
      'duplicate or ambiguous evidence identity'
    )
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
