import type { DecisionBatchResult } from '../../../shared/agents/decision-providers.ts'
import type { SourceContext, SourceLink, SourceRecord, SourceUnit } from '../../agents/providers/source-document.ts'
import { assessWikiVerificationResult, buildWikiVerificationPlan, type WikiVerificationInput, type WikiVerificationPlan, type WikiVerificationSource } from '../../agents/providers/wiki-verification.ts'
import { describe, expect, it } from '../bun-test.mts'

const raw = '# Fictional, untested recipes\n\nName | Yield | Method\n--- | --- | ---\nMoon soup | 2 servings | Simmer [Guide][g] before dawn.\n\n[g]: /recipes/guide\n'
const headingEnd = raw.indexOf('\n') + 1
const headerStart = raw.indexOf('Name |')
const headerEnd = raw.indexOf('Moon soup')
const rowStart = headerEnd
const rowEnd = raw.indexOf('\n', rowStart) + 1
const definitionStart = raw.indexOf('[g]:')
const rowSpan = { start: rowStart, end: rowEnd }
const headingSpan = { start: 0, end: headingEnd }
const headerSpan = { start: headerStart, end: headerEnd }
const definitionSpan = { start: definitionStart, end: raw.length }
const link: SourceLink = {
  label: 'Guide', destination: '/recipes/guide', unitId: 'row:1', sourceSpans: [rowSpan], dependencySpans: [definitionSpan], kind: 'link'
}
const unit: SourceUnit = {
  id: 'row:1', kind: 'table-row', sourceSpans: [rowSpan], normalizedText: 'Moon soup | 2 servings | Simmer Guide before dawn.',
  contextIds: ['heading:1', 'header:1'], recordId: 'record:1', structuralLabels: ['Moon soup'], links: [link], complete: true
}
const contexts: readonly SourceContext[] = [
  { id: 'heading:1', kind: 'heading', sourceSpans: [headingSpan], normalizedLabel: 'Fictional, untested recipes', parentId: null, complete: true },
  { id: 'header:1', kind: 'table-header', sourceSpans: [headerSpan], normalizedLabel: 'Name | Yield | Method', parentId: 'heading:1', complete: true }
]
const record: SourceRecord = {
  id: 'record:1', kind: 'table-row', contextIds: ['heading:1', 'header:1'], unitIds: ['row:1'], complete: true,
  fields: [
    { id: 'field:1', label: 'Name', value: 'Moon soup', unitIds: ['row:1'], sourceSpans: [rowSpan], order: 0, complete: true },
    { id: 'field:2', label: 'Yield', value: '2 servings', unitIds: ['row:1'], sourceSpans: [rowSpan], order: 1, complete: true },
    { id: 'field:3', label: 'Method', value: 'Simmer Guide before dawn.', unitIds: ['row:1'], sourceSpans: [rowSpan], order: 2, complete: true }
  ]
}
const source = {
  evidenceId: 'page:42:revision:7:section:1', sourceRevision: '7', unitId: 'row:1:assertion:0', context: 'Fictional, untested recipes',
  text: unit.normalizedText, kind: 'table-row', complete: true,
  closure: { unit, units: [unit], contexts, record, links: [link],
    dependencies: [rowSpan, headingSpan, headerSpan, definitionSpan].map(span => ({ span, text: raw.slice(span.start, span.end) })) }
} satisfies WikiVerificationSource
const input = (changes: Partial<WikiVerificationInput> = {}): WikiVerificationInput => ({
  userRequest: 'List each fictional recipe, its serving yield, and its complete method.',
  requestFacets: ['each fictional recipe and its serving yield', 'its complete method'],
  claims: [{ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, unitId: source.unitId,
    statement: 'Fictional, untested recipe; Name: Moon soup; Yield: 2 servings; Method: Simmer [Guide](/recipes/guide) before dawn.' }],
  sources: [source], evidence: [{ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, source: raw }], ...changes
})
const plan = (): WikiVerificationPlan => {
  const result = buildWikiVerificationPlan(input())
  if (result === null) throw new Error('Expected factual verification plan')
  return result
}
type Verdict = DecisionBatchResult['answers'][string]
const supports: Verdict = { choice: 'supports', probabilities: { supports: 0.98, contradicts: 0.01, not_supported: 0.01 }, confidence: 0.97 }
const complete: Verdict = { choice: 'complete', probabilities: { complete: 0.98, incomplete: 0.01, not_established: 0.01 }, confidence: 0.97 }
const result = (answers: DecisionBatchResult['answers'] = { support_0: supports, coverage_0: complete, coverage_1: complete }): DecisionBatchResult => ({
  providerId: '00000000-0000-4000-8000-000000000001', providerRevision: 5, model: 'jev-1.13.0', answers,
  usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100, totalTokensSource: 'reported' }, latencyMs: 10,
  estimatedCost: null, estimatedCostMicros: null
})

// Pure preflight and composition boundaries; no provider mock claims semantic accuracy.
describe('Wiki verification deterministic admission', () => {
  it('requires no judgment for a claim-free response, even without readable sources', () => {
    expect(buildWikiVerificationPlan(input({ claims: [], sources: [], evidence: [] }))).toBeNull()
  })

  it('rejects cross-source identity combinations, native-unit aliases and ambiguous bindings before dispatch', () => {
    const other = { ...source, evidenceId: 'page:99:revision:8:section:1', sourceRevision: '8', unitId: 'row:2:assertion:0' }
    for (const change of [{ evidenceId: other.evidenceId }, { sourceRevision: other.sourceRevision }, { unitId: other.unitId }, { unitId: unit.id }]) {
      const request = input()
      expect(() => buildWikiVerificationPlan(input({ sources: [source, other], claims: [{ ...request.claims[0]!, ...change }] }))).toThrow('unknown exact original binding')
    }
    expect(() => buildWikiVerificationPlan(input({ sources: [source, source] }))).toThrow('ambiguous exact source binding')
    expect(() => buildWikiVerificationPlan(input({ evidence: [] }))).toThrow('registered read')
    expect(() => buildWikiVerificationPlan(input({ evidence: [{ evidenceId: source.evidenceId, sourceRevision: '8', source: raw }] }))).toThrow('registered read')
  })

  it('rejects incomplete owned data, absent reference dependencies and foreign record facts', () => {
    const changed: readonly WikiVerificationSource[] = [
      { ...source, complete: false },
      { ...source, closure: { ...source.closure, unit: { ...unit, complete: false } } },
      { ...source, closure: { ...source.closure, contexts: [{ ...contexts[0]!, complete: false }, contexts[1]!] } },
      { ...source, closure: { ...source.closure, contexts: [{ ...contexts[0]!, sourceSpans: [] }, contexts[1]!] } },
      { ...source, closure: { ...source.closure, contexts: [{ ...contexts[0]!, parentId: 'header:1' }, contexts[1]!] } },
      { ...source, closure: { ...source.closure, contexts: [contexts[1]!] } },
      { ...source, closure: { ...source.closure, record: null } },
      { ...source, closure: { ...source.closure, record: { ...record, fields: [{ ...record.fields[0]!, complete: false }] } } },
      { ...source, closure: { ...source.closure, record: { ...record, fields: [{ ...record.fields[0]!, unitIds: [] }] } } },
      { ...source, closure: { ...source.closure, record: { ...record, fields: [{ ...record.fields[0]!, sourceSpans: [] }] } } },
      { ...source, closure: { ...source.closure, record: { ...record, unitIds: ['row:1', 'row:missing'] } } },
      { ...source, closure: { ...source.closure, dependencies: source.closure.dependencies.filter(entry => entry.span.start !== definitionStart) } },
      { ...source, closure: { ...source.closure, dependencies: [...source.closure.dependencies, { span: definitionSpan, text: 'foreign' }] } },
      { ...source, closure: { ...source.closure, units: [unit, { ...unit, id: 'foreign:row', recordId: 'foreign:record' }] } },
      { ...source, closure: { ...source.closure, links: [{ ...link, unitId: 'foreign:row' }] } }
    ]
    for (const bound of changed) expect(() => buildWikiVerificationPlan(input({ sources: [bound] }))).toThrow('Invalid Wiki verification input')
  })


  it('fails rather than pruning source text or skipping coverage to satisfy unchanged bounds', () => {
    expect(() => buildWikiVerificationPlan(input({ evidence: [{ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, source: 'é'.repeat(70_000) }] }))).toThrow()
    expect(() => buildWikiVerificationPlan(input({ requestFacets: Array.from({ length: 255 }, () => 'complete method') }))).toThrow()
  })
})

describe('Wiki verification conservative composition', () => {
  it('requires each support and coverage verdict to pass independently above the initial floor', () => {
    const built = plan()
    expect(assessWikiVerificationResult(built, result())).toEqual({ valid: true, issues: [] })
    for (const confidence of [0, 0.79, 0.8]) {
      for (const answers of [
        { support_0: { ...supports, confidence }, coverage_0: complete, coverage_1: complete },
        { support_0: supports, coverage_0: complete, coverage_1: { ...complete, confidence } }
      ]) {
        const assessed = assessWikiVerificationResult(built, result(answers))
        expect(assessed.valid).toBe(false)
        expect(assessed.issues).toHaveLength(1)
        expect(assessed.issues[0]).toContain('uncertain')
      }
    }
  })

  it('does not average away contradictions, unsupported claims or incomplete and unestablished facets', () => {
    const built = plan()
    for (const choice of ['contradicts', 'not_supported'] as const) {
      const verdict = { choice, probabilities: { supports: 0.01, contradicts: choice === 'contradicts' ? 0.98 : 0.01, not_supported: choice === 'not_supported' ? 0.98 : 0.01 }, confidence: 0.97 }
      const assessed = assessWikiVerificationResult(built, result({ support_0: verdict, coverage_0: complete, coverage_1: complete }))
      expect(assessed.valid).toBe(false)
      expect(assessed.issues[0]).toContain(`Claim 1`)
      expect(assessed.issues[0]).toContain(choice)
    }
    for (const choice of ['incomplete', 'not_established'] as const) {
      const verdict = { choice, probabilities: { complete: 0.01, incomplete: choice === 'incomplete' ? 0.98 : 0.01, not_established: choice === 'not_established' ? 0.98 : 0.01 }, confidence: 0.97 }
      const assessed = assessWikiVerificationResult(built, result({ support_0: supports, coverage_0: complete, coverage_1: verdict }))
      expect(assessed.valid).toBe(false)
      expect(assessed.issues[0]).toContain('Requested facet 2 (its complete method)')
      expect(assessed.issues[0]).toContain(choice)
    }
    const assessed = assessWikiVerificationResult(built, result({
      support_0: { choice: 'contradicts', probabilities: { supports: 0, contradicts: 1, not_supported: 0 }, confidence: 1 },
      coverage_0: { ...complete, confidence: 0.7 }, coverage_1: complete
    }))
    expect(assessed.issues).toHaveLength(2)
  })

  it('rejects missing, extra, malformed and internally inconsistent verdict combinations', () => {
    const built = plan()
    const malformed: readonly unknown[] = [
      null, [], { ...supports, confidence: NaN }, { ...supports, confidence: 1.01 }, { ...supports, confidence: -0.1 },
      { ...supports, choice: 'ready' }, { ...supports, extra: true },
      { ...supports, probabilities: { supports: 1 } },
      { ...supports, probabilities: { supports: 0.98, contradicts: 0.01, not_supported: 0.01, complete: 0 } },
      { ...supports, probabilities: { supports: 1, contradicts: 1, not_supported: 0 } },
      { ...supports, probabilities: { supports: 0.01, contradicts: 0.98, not_supported: 0.01 } },
      { ...supports, probabilities: { supports: Infinity, contradicts: 0, not_supported: 0 } }
    ]
    for (const verdict of malformed) {
      const bad = { ...result(), answers: { support_0: verdict, coverage_0: complete, coverage_1: complete } } as unknown as DecisionBatchResult
      const assessed = assessWikiVerificationResult(built, bad)
      expect(assessed.valid).toBe(false)
      expect(assessed.issues).toHaveLength(1)
      expect(assessed.issues[0]).toContain('malformed')
    }
    expect(assessWikiVerificationResult(built, result({ support_0: supports, coverage_0: complete })).issues[0]).toContain('missing')
    expect(assessWikiVerificationResult(built, result({ support_0: supports, coverage_0: complete, coverage_1: complete, extra: complete })).issues[0]).toContain('unexpected')
    expect(assessWikiVerificationResult(built, { ...result(), answers: null } as unknown as DecisionBatchResult).valid).toBe(false)
  })
})
