import { AxMockAIService } from '@ax-llm/ax'
import { createWikiCoverageProgram, encodeWikiCoverageInput, type WikiCoverageInput } from '../../agents/providers/wiki-coverage.ts'
import { describe, expect, it } from '../bun-test.mts'

const input = (): WikiCoverageInput => ({
  userRequest: 'Summarize the approval restrictions.',
  requestFacets: ['approval restrictions'],
  unresolvedFacets: [],
  reads: [{ readRef: 'r1', title: 'Approvals', source: 'Approval requires both owners.', authorText: 'Approval requires both owners.' }],
  claims: [{ readRef: 'r1', statement: 'Approval requires both owners.' }]
})

describe('Wiki coverage input binding', () => {
  it('rejects duplicate physical identities even when their contents agree', () => {
    const valid = input()
    expect(() => encodeWikiCoverageInput({ ...valid, reads: [...valid.reads, valid.reads[0]!] })).toThrow()
  })

  it('rejects a conflicting body under an existing physical identity', () => {
    const valid = input()
    expect(() => encodeWikiCoverageInput({ ...valid, reads: [...valid.reads, { ...valid.reads[0]!, source: 'Only one owner is needed.' }] })).toThrow()
  })

  it('rejects assertions that refer to an unregistered physical read', () => {
    expect(() => encodeWikiCoverageInput({ ...input(), claims: [{ readRef: 'r2', statement: 'Approval requires both owners.' }] })).toThrow()
  })

  it('rejects empty request, identity and assertion text without rewriting them', () => {
    const valid = input()
    expect(() => encodeWikiCoverageInput({ ...valid, userRequest: ' \n ' })).toThrow()
    expect(() => encodeWikiCoverageInput({ ...valid, reads: [{ ...valid.reads[0]!, readRef: '' }] })).toThrow()
    expect(() => encodeWikiCoverageInput({ ...valid, claims: [{ readRef: 'r1', statement: ' ' }] })).toThrow()
  })

  it('rejects unresolved facets outside the request and repeated indices', () => {
    for (const unresolvedFacets of [[1], [-1], [0.5], [0, 0], [Number.NaN]]) {
      expect(() => encodeWikiCoverageInput({ ...input(), unresolvedFacets })).toThrow()
    }
    expect(() => encodeWikiCoverageInput({ ...input(), requestFacets: [], unresolvedFacets: [0] })).toThrow()
    expect(() => encodeWikiCoverageInput({ ...input(), requestFacets: [' '] })).toThrow()
  })
})

describe('Wiki coverage native optional feedback protocol', () => {
  const forward = (verdict: string) => createWikiCoverageProgram().forward(new AxMockAIService({
    features: { functions: false, structuredOutputs: true, structuredOutputModes: ['native'] },
    chatResponse: {
      results: [{ index: 0, content: JSON.stringify({ verdict, feedback: null }), finishReason: 'stop' }],
      modelUsage: { ai: 'fixture', model: 'fixture', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    }
  }), encodeWikiCoverageInput(input()))

  it('accepts native null feedback for a complete verdict', async () => {
    expect((await forward('complete')).verdict).toBe('complete')
  })

  it('rejects null feedback for an omission or uncertain verdict', async () => {
    for (const verdict of ['incomplete', 'not_established']) await expect(forward(verdict)).rejects.toThrow()
  })
})
