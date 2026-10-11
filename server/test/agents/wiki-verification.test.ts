import type { DecisionBatchRequest, DecisionBatchResult } from '../../../shared/agents/decision-providers.ts'
import type { SourceContext, SourceLink, SourceRecord, SourceUnit } from '../../agents/providers/source-document.ts'
import { assessWikiVerificationResults, buildWikiVerificationPlan } from '../../agents/providers/wiki-verification.ts'
import type { WikiVerificationInput, WikiVerificationPlan, WikiVerificationSource } from '../../agents/providers/wiki-verification.ts'
import type { WikiReadTextReference } from '../../agents/providers/wiki-read-transport.ts'
import { unpackWikiReadTexts } from '../../agents/providers/wiki-read-transport.ts'
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
  userRequest: 'List each fictional recipe and its serving yield. Include its complete method.',
  requestFacets: ['List each fictional recipe and its serving yield.', 'Include its complete method.'],
  claims: [{ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, unitId: source.unitId,
    statement: 'The fictional, untested Moon soup yields 2 servings and is simmered before dawn.' }],
  sources: [source], evidence: [{ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, source: raw }], ...changes
})
const plan = (changes: Partial<WikiVerificationInput> = {}): WikiVerificationPlan => {
  const built = buildWikiVerificationPlan(input(changes))
  if (!built) throw new Error('Expected a verification plan')
  return built
}
type Verdict = DecisionBatchResult['answers'][string]
const supports: Verdict = { choice: 'supports', probabilities: { supports: 0.98, contradicts: 0.01, not_supported: 0.01 }, confidence: 0.97 }
const bounded: Verdict = { choice: 'bounded', probabilities: { bounded: 0.98, unbound: 0.01, not_established: 0.01 }, confidence: 0.97 }
const acceptedAnswers = (built: WikiVerificationPlan): DecisionBatchResult['answers'] =>
  Object.fromEntries(Object.entries(built.checks).map(([id, check]) => [id, check.kind === 'support' ? supports : bounded]))
const result = (answers: DecisionBatchResult['answers']): DecisionBatchResult => ({
  providerId: '00000000-0000-4000-8000-000000000001', providerRevision: 5, model: 'jev-1.13.0', answers,
  usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100, totalTokensSource: 'reported' }, latencyMs: 10,
  estimatedCost: null, estimatedCostMicros: null
})
const batchResults = (built: WikiVerificationPlan, answers = acceptedAnswers(built)): DecisionBatchResult[] =>
  built.requests.map(request => result(Object.fromEntries(Object.keys(request.questions)
    .filter(id => Object.hasOwn(answers, id)).map(id => [id, answers[id]!]))))
const state = (request: DecisionBatchRequest) => JSON.parse(request.state as string) as {
  sources: WikiVerificationSource[]
  sourceIndexes: number[]
  candidate: WikiVerificationInput['claims']
  claimIndexes: number[]
  candidateExtras?: WikiVerificationInput['candidateExtras']
  readTexts: string[]
  evidence: { evidenceId: string; sourceRevision: string; source: WikiReadTextReference }[]
}
const readsFrom = (request: DecisionBatchRequest) => {
  const decoded = state(request)
  return decoded.evidence.map(read => ({ ...read,
    source: unpackWikiReadTexts({ texts: decoded.readTexts, sources: [read.source] })[0] }))
}
const recordUnits: SourceUnit[] = record.fields.map(field => {
  const id = `${unit.id}:${field.id}`
  return { ...unit, id, normalizedText: `${field.label}: ${field.value}`,
    links: field.label === 'Method' ? [{ ...link, unitId: id }] : [] }
})
const recordSource: WikiVerificationSource = {
  ...source, text: recordUnits[0]!.normalizedText,
  closure: { ...source.closure, unit: recordUnits[0]!, units: recordUnits,
    record: { ...record, unitIds: recordUnits.map(entry => entry.id),
      fields: record.fields.map((field, index) => ({ ...field, unitIds: [recordUnits[index]!.id] })) },
    links: recordUnits.flatMap(entry => entry.links) }
}
const recordQuote = 'Fictional, untested recipes › Name | Yield | Method: Name: Moon soup | Yield: 2 servings | Method: Simmer Guide before dawn.'
const quotedInput = (): WikiVerificationInput => input({
  sources: [recordSource], claims: [{ ...input().claims[0]!, statement: recordQuote }]
})

// Pure admission and provider-result composition; synthetic verdicts do not
// establish the native model's semantic accuracy.
describe('Wiki verification source-local admission', () => {
  it('requires no judgment for a claim-free answer even with available reads', () => {
    expect(buildWikiVerificationPlan(input({ claims: [], sources: [], evidence: [] }))).toBeNull()
    expect(buildWikiVerificationPlan(input({ claims: [] }))).toBeNull()
  })

  it('rejects cross-source identities, native-unit aliases and ambiguous bindings', () => {
    const other = { ...source, evidenceId: 'page:99:revision:8:section:1', sourceRevision: '8', unitId: 'row:2:assertion:0' }
    for (const change of [{ evidenceId: other.evidenceId }, { sourceRevision: other.sourceRevision }, { unitId: other.unitId }, { unitId: unit.id }]) {
      expect(() => buildWikiVerificationPlan(input({ sources: [source, other], claims: [{ ...input().claims[0]!, ...change }] })))
        .toThrow('unknown exact original binding')
    }
    expect(() => plan({ sources: [source, source] })).toThrow('ambiguous exact source binding')
    expect(() => plan({ evidence: [] })).toThrow('registered read')
    expect(() => plan({ evidence: [{ evidenceId: source.evidenceId, sourceRevision: '8', source: raw }] })).toThrow('registered read')
    expect(() => plan({ evidence: [...input().evidence, ...input().evidence] })).toThrow('ambiguous registered read')
  })

  it('rejects incomplete closures, missing links and dependencies and foreign record ownership', () => {
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
      { ...source, closure: { ...source.closure, record: { ...record, unitIds: ['row:1', 'row:1'] } } },
      { ...source, closure: { ...source.closure, dependencies: source.closure.dependencies.filter(entry => entry.span.start !== definitionStart) } },
      { ...source, closure: { ...source.closure, dependencies: [...source.closure.dependencies, { span: definitionSpan, text: 'foreign' }] } },
      { ...source, closure: { ...source.closure, units: [unit, { ...unit, id: 'foreign:row', recordId: 'foreign:record' }] } },
      { ...source, closure: { ...source.closure, links: [{ ...link, unitId: 'foreign:row' }] } },
      { ...source, closure: { ...source.closure, links: [] } }
    ]
    for (const bound of changed) expect(() => plan({ sources: [bound] })).toThrow('Invalid Wiki verification input')
  })

  it('validates unresolved facet indices without adding native completeness obligations', () => {
    for (const unresolvedFacets of [[-1], [2], [0.5], [0, 0]])
      expect(() => plan({ unresolvedFacets })).toThrow('unresolved facets')
    expect(() => plan({ requestFacets: [''] })).toThrow('nonempty')
    const built = buildWikiVerificationPlan({ ...quotedInput(), unresolvedFacets: [0, 1] })!
    expect(built.requests).toEqual([])
    expect(built.checks).toEqual({})
    expect(assessWikiVerificationResults(built).valid).toBe(true)
  })

  it('retains exact selected closures and complete own reads without an irrelevant record bank', () => {
    const other: WikiVerificationSource = { ...source, evidenceId: 'page:99:revision:8:section:1', sourceRevision: '8', text: 'Foreign recipe' }
    const request = input({ sources: [other, source], evidence: [
      ...input().evidence, { evidenceId: other.evidenceId, sourceRevision: '8', source: 'Foreign recipe and unrelated inventory.' },
      { evidenceId: 'uncited:related', sourceRevision: '1', source: 'An unrelated collection, not direct membership.' }
    ] })
    const built = buildWikiVerificationPlan(request)!
    expect(built.originalSources).toEqual(request.sources)
    expect(built.originalEvidence).toEqual(request.evidence)
    expect(built.originalSources).not.toBe(request.sources)
    expect(built.originalEvidence).not.toBe(request.evidence)
    expect(built.requests).toHaveLength(1)
    expect(state(built.requests[0]!).sources).toEqual([source])
    expect(state(built.requests[0]!).sourceIndexes).toEqual([1])
    expect(state(built.requests[0]!).candidate).toEqual(request.claims)
    expect(readsFrom(built.requests[0]!)).toEqual(input().evidence)
    expect(Object.values(built.checks).map(check => check.kind)).toEqual(['support'])
  })

  it('keeps identical text under distinct revisions and dispatches each own binding independently', () => {
    const other = { ...source, evidenceId: 'page:42:revision:8:section:1', sourceRevision: '8' }
    const candidate = input({ sources: [other, source], claims: [input().claims[0]!, {
      ...input().claims[0]!, evidenceId: other.evidenceId, sourceRevision: '8'
    }], evidence: [...input().evidence, { evidenceId: other.evidenceId, sourceRevision: '8', source: raw }] })
    const built = buildWikiVerificationPlan(candidate)!
    expect(built.requests).toHaveLength(2)
    for (const [index, request] of built.requests.entries()) {
      const decoded = state(request)
      expect(decoded.candidate).toEqual([candidate.claims[index]!])
      expect(decoded.claimIndexes).toEqual([index])
      expect(decoded.sources[0]!.evidenceId).toBe(candidate.claims[index]!.evidenceId)
      expect(decoded.sources[0]!.sourceRevision).toBe(candidate.claims[index]!.sourceRevision)
      expect(decoded.sources[0]!.closure).toEqual(source.closure)
    }
    const correct = batchResults(built)
    expect(assessWikiVerificationResults(built, correct).valid).toBe(true)
    expect(assessWikiVerificationResults(built, [...correct].reverse()).valid).toBe(false)
    expect(assessWikiVerificationResults(built, [correct[0]!, correct[0]!]).valid).toBe(false)
  })

  it('fails rather than pruning required read context to satisfy unchanged native bounds', () => {
    expect(() => plan({ evidence: [{ ...input().evidence[0]!, source: 'é'.repeat(70_000) }] })).toThrow()
  })
})

describe('Wiki verification complete quotation boundaries', () => {
  it('mechanically accepts nine complete original own-record quotations with no native predicate', () => {
    const sources = Array.from({ length: 9 }, (_, index) => ({ ...recordSource, evidenceId: `page:${index}:revision:7:section:1` }))
    const candidate = input({ sources, claims: sources.map(bound => ({
      evidenceId: bound.evidenceId, sourceRevision: bound.sourceRevision, unitId: bound.unitId, statement: recordQuote
    })), evidence: sources.map(bound => ({ evidenceId: bound.evidenceId, sourceRevision: bound.sourceRevision, source: raw })) })
    const built = buildWikiVerificationPlan(candidate)!
    expect(built.literalSupportCount).toBe(9)
    expect(built.requests).toEqual([])
    expect(built.checks).toEqual({})
    expect(assessWikiVerificationResults(built)).toEqual({ valid: true, issues: [] })
    expect(assessWikiVerificationResults(built, [result({})]).valid).toBe(false)
  })

  it('does not infer literal status from changed quantity, condition, status, fragment or foreign-source text', () => {
    const candidate = quotedInput()
    for (const statement of [
      recordQuote.replace('2 servings', '20 servings'), recordQuote.replace('before dawn', 'after dawn'),
      recordQuote.replace('untested', 'tested'), recordQuote.replace('Fictional, untested recipes › ', ''),
      'Name: Moon soup', 'Moon soup', 'Yield: 2 servings', 'Foreign recipe | 3 servings'
    ]) {
      const built = buildWikiVerificationPlan({ ...candidate, claims: [{ ...candidate.claims[0]!, statement }] })!
      expect(built.literalSupportCount).toBe(0)
      expect(built.checks.support_0?.kind).toBe('support')
      expect(assessWikiVerificationResults(built, batchResults(built, { support_0: {
        choice: 'not_supported', probabilities: { supports: 0.01, contradicts: 0.01, not_supported: 0.98 }, confidence: 0.97
      } })).valid).toBe(false)
    }
    expect(() => buildWikiVerificationPlan({ ...candidate, sources: [{ ...recordSource,
      closure: { ...recordSource.closure!, dependencies: [] }
    }] })).toThrow('missing original-source dependencies')
  })

  it('does not borrow a complete foreign record quotation through a shared unit identity', () => {
    const foreignName = 'Sun broth'
    const foreignUnits = recordUnits.map(entry => ({ ...entry,
      normalizedText: entry.normalizedText.replace('Moon soup', foreignName) }))
    const foreign: WikiVerificationSource = { ...recordSource, evidenceId: 'page:foreign:revision:7',
      text: foreignUnits[0]!.normalizedText,
      closure: { ...recordSource.closure!, unit: foreignUnits[0]!, units: foreignUnits,
        record: { ...recordSource.closure!.record!, fields: recordSource.closure!.record!.fields.map(field =>
          ({ ...field, value: field.value.replace('Moon soup', foreignName) })) } } }
    const built = buildWikiVerificationPlan(input({ sources: [recordSource, foreign],
      claims: [{ ...input().claims[0]!, statement: recordQuote.replace('Moon soup', foreignName) }],
      evidence: [...input().evidence, { evidenceId: foreign.evidenceId, sourceRevision: '7', source: raw }]
    }))!
    expect(built.literalSupportCount).toBe(0)
    expect(state(built.requests[0]!).sources).toEqual([recordSource])
    expect(built.checks.support_0).toEqual({ kind: 'support', claimIndex: 0,
      binding: { evidenceId: source.evidenceId, sourceRevision: '7', unitId: source.unitId } })
  })

  it('mechanically accepts a complete own physical unit with its original conditional context', () => {
    const text = 'Use 2 servings only after independent approval; simmer before dawn.'
    const read = '# Fictional, untested recipes\n' + text
    const span = { start: headingEnd, end: read.length }
    const ownUnit: SourceUnit = { ...unit, kind: 'paragraph', normalizedText: text, sourceSpans: [span],
      contextIds: ['heading:1'], recordId: null, links: [] }
    const conditional: WikiVerificationSource = { ...source, kind: 'paragraph', text,
      closure: { unit: ownUnit, units: [ownUnit], contexts: [contexts[0]!], record: null, links: [],
        dependencies: [headingSpan, span].map(span => ({ span, text: read.slice(span.start, span.end) })) } }
    const candidate = input({ sources: [conditional], claims: [{ ...input().claims[0]!,
      statement: 'Fictional, untested recipes: ' + text
    }], evidence: [{ ...input().evidence[0]!, source: read }] })
    const built = buildWikiVerificationPlan(candidate)!
    expect(built.requests).toEqual([])
    expect(built.literalSupportCount).toBe(1)
    for (const statement of [text, text.replace('only after independent approval; ', '')]) {
      const changed = buildWikiVerificationPlan({ ...candidate, claims: [{ ...candidate.claims[0]!, statement }] })!
      expect(changed.literalSupportCount).toBe(0)
      expect(state(changed.requests[0]!).sources[0]!.closure).toEqual(conditional.closure)
      expect(Object.values(changed.checks).map(check => check.kind)).toEqual(['support'])
    }
  })

  it('mechanically validates only the exact authoritative title property, not a body inference', () => {
    const title: WikiVerificationSource = { evidenceId: 'page:42:revision:7', sourceRevision: '7', unitId: 'metadata:page-title',
      kind: 'page-title', context: 'Authoritative read page title; literal metadata only', text: 'Fictional Recipes', complete: true, closure: null }
    const candidate = input({ sources: [title], claims: [{ evidenceId: title.evidenceId, sourceRevision: title.sourceRevision,
      unitId: title.unitId, statement: 'The page is titled "Fictional Recipes".' }], evidence: [{
      evidenceId: title.evidenceId, sourceRevision: title.sourceRevision, source: raw
    }] })
    const built = buildWikiVerificationPlan(candidate)!
    expect(built.literalSupportCount).toBe(1)
    expect(built.requests).toEqual([])
    for (const statement of ['The page is titled "Maintenance Handbook".', 'Fictional Recipes', 'The page author tested these recipes.']) {
      const changed = buildWikiVerificationPlan({ ...candidate, claims: [{ ...candidate.claims[0]!, statement }] })!
      expect(changed.literalSupportCount).toBe(0)
      expect(changed.checks.support_0?.kind).toBe('support')
    }
    for (const changed of [{ ...title, unitId: 'foreign:title' }, { ...title, complete: false }, { ...title, text: '' },
      { ...title, closure: source.closure }])
      expect(() => buildWikiVerificationPlan({ ...candidate, sources: [changed],
        claims: [{ ...candidate.claims[0]!, unitId: changed.unitId }]
      })).toThrow('title metadata')
  })
})

describe('Wiki verification narrow additional narration', () => {
  it('does not judge absent, blank or deterministically bound duplicate narration', () => {
    const candidate = quotedInput()
    for (const candidateExtras of [undefined, { observations: [], recommendations: '' },
      { observations: ['   '], recommendations: '\n' }, { observations: [recordQuote], recommendations: '' }]) {
      const built = buildWikiVerificationPlan({ ...candidate, candidateExtras })!
      expect(built.requests).toEqual([])
    }
  })

  it('checks unbound factual extras even when there are no source-bound claims', () => {
    const built = plan({ claims: [], sources: [], candidateExtras: {
      observations: ['All recipes are tested.'], recommendations: ''
    } })
    expect(Object.values(built.checks).map(check => check.kind)).toEqual(['narration'])
    expect(state(built.requests[0]!).candidate).toEqual([])
    expect(state(built.requests[0]!).sources).toEqual([])
    expect(readsFrom(built.requests[0]!)).toEqual(input().evidence)
    expect(assessWikiVerificationResults(built, batchResults(built, { narration_0: {
      choice: 'unbound', probabilities: { bounded: 0.01, unbound: 0.98, not_established: 0.01 }, confidence: 0.97
    } })).valid).toBe(false)
  })

  it('checks actual extra assertions independently without a blanket coverage or scope census', () => {
    const candidateExtras = { observations: ['Every recipe on the entire Wiki is listed.'], recommendations: 'These recipes are kitchen-tested.' }
    const built = buildWikiVerificationPlan({ ...quotedInput(), candidateExtras })!
    expect(Object.values(built.checks).map(check => check.kind)).toEqual(['narration'])
    expect(state(built.requests[0]!).candidateExtras).toEqual(candidateExtras)
    expect(state(built.requests[0]!).sources).toEqual([recordSource])
    expect(readsFrom(built.requests[0]!)).toEqual(input().evidence)
    for (const choice of ['unbound', 'not_established']) {
      const verdict = { choice, probabilities: { bounded: 0.01, unbound: choice === 'unbound' ? 0.98 : 0.01,
        not_established: choice === 'not_established' ? 0.98 : 0.01 }, confidence: 0.97 }
      expect(assessWikiVerificationResults(built, batchResults(built, { narration_0: verdict })).valid).toBe(false)
    }
    expect(assessWikiVerificationResults(built, batchResults(built)).valid).toBe(true)
    expect(assessWikiVerificationResults(built, []).valid).toBe(false)
  })

  it('retains source support and narration as separate mandatory predicates', () => {
    const built = plan({ candidateExtras: { observations: ['These recipes are tested.'], recommendations: '' } })
    expect(Object.values(built.checks).map(check => check.kind)).toEqual(['support', 'narration'])
    for (const id of Object.keys(built.checks)) {
      const answers = acceptedAnswers(built)
      delete answers[id]
      expect(assessWikiVerificationResults(built, batchResults(built, answers)).valid).toBe(false)
    }
  })
})

describe('Wiki verification strict issued-result composition', () => {
  it('requires confidence and selected probability independently strictly above the existing floor', () => {
    const built = plan({ candidateExtras: { observations: ['These recipes are tested.'], recommendations: '' } })
    expect(assessWikiVerificationResults(built, batchResults(built))).toEqual({ valid: true, issues: [] })
    for (const [id, check] of Object.entries(built.checks)) {
      const choice = check.kind === 'support' ? 'supports' : 'bounded'
      const labels = check.kind === 'support' ? ['supports', 'contradicts', 'not_supported'] : ['bounded', 'unbound', 'not_established']
      for (const [probability, confidence] of [[0.8, 0.97], [0.98, 0.8], [0.81, 0.81]] as const) {
        const verdict = { choice, confidence, probabilities: Object.fromEntries(labels.map(label =>
          [label, label === choice ? probability : (1 - probability) / 2])) }
        const assessed = assessWikiVerificationResults(built, batchResults(built, { ...acceptedAnswers(built), [id]: verdict }))
        expect(assessed.valid).toBe(probability > 0.8 && confidence > 0.8)
        if (!assessed.valid) expect(assessed.issues).toHaveLength(1)
      }
    }
  })

  it('does not average away a contradicted or unsupported source-bound fact', () => {
    const built = plan()
    for (const choice of ['contradicts', 'not_supported']) {
      const verdict = { choice, probabilities: { supports: 0.01, contradicts: choice === 'contradicts' ? 0.98 : 0.01,
        not_supported: choice === 'not_supported' ? 0.98 : 0.01 }, confidence: 0.97 }
      const assessed = assessWikiVerificationResults(built, batchResults(built, { support_0: verdict }))
      expect(assessed.valid).toBe(false)
      expect(assessed.issues[0]).toContain('Claim 1')
      expect(assessed.issues[0]).toContain(choice)
    }
  })

  it('rejects malformed, foreign, missing, extra and internally inconsistent native verdicts', () => {
    const built = plan()
    const malformed: readonly unknown[] = [
      null, [], { ...supports, confidence: NaN }, { ...supports, confidence: 1.01 }, { ...supports, confidence: -0.1 },
      { ...supports, choice: 'ready' }, { ...supports, extra: true }, { ...supports, probabilities: { supports: 1 } },
      { ...supports, probabilities: { supports: 0.98, contradicts: 0.01, not_supported: 0.01, complete: 0 } },
      { ...supports, probabilities: { supports: 1, contradicts: 1, not_supported: 0 } },
      { ...supports, probabilities: { supports: 0.01, contradicts: 0.98, not_supported: 0.01 } },
      { ...supports, probabilities: { supports: Infinity, contradicts: 0, not_supported: 0 } }
    ]
    for (const verdict of malformed) {
      const bad = result({ support_0: verdict as Verdict })
      const assessed = assessWikiVerificationResults(built, [bad])
      expect(assessed.valid).toBe(false)
      expect(assessed.issues).toHaveLength(1)
      expect(assessed.issues[0]).toContain('malformed')
    }
    expect(assessWikiVerificationResults(built, [result({})]).issues[0]).toContain('missing')
    expect(assessWikiVerificationResults(built, [result({ ...acceptedAnswers(built), foreign: supports })]).issues[0]).toContain('unexpected')
    expect(assessWikiVerificationResults(built, [{ ...result({}), answers: null } as unknown as DecisionBatchResult]).valid).toBe(false)
    expect(assessWikiVerificationResults(built, []).valid).toBe(false)
    expect(assessWikiVerificationResults(built, [...batchResults(built), ...batchResults(built)]).valid).toBe(false)
    expect(assessWikiVerificationResults(built, null as unknown as DecisionBatchResult[]).valid).toBe(false)
  })

  it('rejects post-issuance request, predicate, source, read and literal-count mutation even on mechanical plans', () => {
    for (const target of ['state', 'questions', 'checks', 'source', 'read', 'literal-count', 'unissued-copy']) {
      const built = plan()
      if (target === 'state') Reflect.set(built.requests[0]!, 'state', '{}')
      else if (target === 'questions') Reflect.deleteProperty(built.requests[0]!.questions, 'support_0')
      else if (target === 'checks') Reflect.set(built, 'checks', {})
      else if (target === 'source') Reflect.set(built.originalSources[0]!, 'text', 'Changed original')
      else if (target === 'read') Reflect.set(built.originalEvidence[0]!, 'source', 'Changed original read')
      else if (target === 'literal-count') Reflect.set(built, 'literalSupportCount', 100)
      expect(assessWikiVerificationResults(target === 'unissued-copy' ? { ...built } : built, batchResults(built)).valid).toBe(false)
    }
    for (const target of ['source', 'read', 'literal-count', 'unissued-copy']) {
      const built = buildWikiVerificationPlan(quotedInput())!
      if (target === 'source') Reflect.set(built.originalSources[0]!, 'context', 'Changed original condition')
      else if (target === 'read') Reflect.set(built.originalEvidence[0]!, 'source', 'Changed original read')
      else if (target === 'literal-count') Reflect.set(built, 'literalSupportCount', 100)
      expect(assessWikiVerificationResults(target === 'unissued-copy' ? { ...built } : built).valid).toBe(false)
    }
  })
})
