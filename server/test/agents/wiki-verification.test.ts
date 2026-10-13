import type { DecisionBatchRequest, DecisionBatchResult } from '../../../shared/agents/decision-providers.ts'
import type { SourceContext, SourceLink, SourceRecord, SourceUnit } from '../../agents/providers/source-document.ts'
import { validateDecisionBatchRequest } from '../../agents/decision-providers.ts'
import { assessWikiVerificationResults, buildWikiVerificationPlan, decodeWikiVerificationSources } from '../../agents/providers/wiki-verification.ts'
import type { WikiVerificationDecodedSource, WikiVerificationEvidence, WikiVerificationInput, WikiVerificationPlan, WikiVerificationSource } from '../../agents/providers/wiki-verification.ts'
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
  sources: [source], evidence: [{ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, readId: 'read:42:revision:7', source: raw }], ...changes
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
const state = (request: DecisionBatchRequest) => {
  const decoded = JSON.parse(request.state as string) as {
    sources: unknown[]
    sourceIndexes: number[]
    candidate: WikiVerificationInput['claims']
    claimIndexes: number[]
    candidateExtras?: WikiVerificationInput['candidateExtras']
    verificationPolicy?: string
    readTexts: string[]
    evidence: (Omit<WikiVerificationEvidence, 'source'> & { source: WikiReadTextReference })[]
  }
  return { ...decoded, sources: decodeWikiVerificationSources(decoded.sources, decoded.readTexts) }
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

const consumeSupportRequest = (request: DecisionBatchRequest, decide: (check: {
  readonly id: string
  readonly claimIndex: number
  readonly originalSourceIndex: number
  readonly claim: WikiVerificationInput['claims'][number]
  readonly source: WikiVerificationDecodedSource
  readonly registeredRead: string
}) => Verdict | undefined): DecisionBatchResult => {
  const decoded = state(request)
  const reads = readsFrom(request)
  if (!decoded.verificationPolicy?.trim()) throw new Error('Consumer cannot resolve the shared verification policy')
  return result(Object.fromEntries(Object.entries(request.questions).flatMap(([id, question]) => {
    const instructions = question.instructions as {
      candidate_index: number
      claim_index: number
      bound_source: { sourceIndex: number }
    }
    const claim = decoded.candidate[instructions.candidate_index]
    const bound = decoded.sources[decoded.sourceIndexes.indexOf(instructions.bound_source.sourceIndex)]
    const read = bound && reads.find(entry => entry.evidenceId === bound.evidenceId && entry.sourceRevision === bound.sourceRevision)
    if (!claim || !bound || read?.source === undefined || decoded.claimIndexes[instructions.candidate_index] !== instructions.claim_index)
      throw new Error('Consumer cannot resolve the original claim, selected source and registered read')
    const verdict = decide({ id, claimIndex: instructions.claim_index, originalSourceIndex: instructions.bound_source.sourceIndex,
      claim, source: bound, registeredRead: read.source })
    return verdict ? [[id, verdict]] : []
  })))
}

const matrixRaw = '# Fictional, untested recipes\n\nMetric | Moon soup | Sun broth\n--- | --- | ---\nYield | 2 servings | 3 servings\nTiming | Before dawn | After dusk\n'
const matrixHeaderSpan = { start: matrixRaw.indexOf('Metric |'), end: matrixRaw.indexOf('Yield |') }
const matrixContexts: readonly SourceContext[] = [
  { ...contexts[0]!, id: 'heading:matrix' },
  { ...contexts[1]!, id: 'header:matrix', sourceSpans: [matrixHeaderSpan], normalizedLabel: 'Metric | Moon soup | Sun broth', parentId: 'heading:matrix' }
]
const matrixSources: readonly WikiVerificationSource[] = [
  { key: 'yield', text: 'Yield | 2 servings | 3 servings', values: ['Yield', '2 servings', '3 servings'] },
  { key: 'timing', text: 'Timing | Before dawn | After dusk', values: ['Timing', 'Before dawn', 'After dusk'] }
].map(row => {
  const span = { start: matrixRaw.indexOf(row.text), end: matrixRaw.indexOf(row.text) + row.text.length + 1 }
  const nativeId = `row:${row.key}`
  const recordId = `record:${row.key}`
  const owned: SourceUnit = { id: nativeId, kind: 'table-row', sourceSpans: [span], normalizedText: row.text,
    contextIds: ['heading:matrix', 'header:matrix'], recordId, structuralLabels: [row.values[0]!], links: [], complete: true }
  const ownedRecord: SourceRecord = { id: recordId, kind: 'table-row', contextIds: owned.contextIds, unitIds: [nativeId], complete: true,
    fields: ['Metric', 'Moon soup', 'Sun broth'].map((label, order) => ({
      id: `field:${row.key}:${order}`, label, value: row.values[order]!, unitIds: [nativeId], sourceSpans: [span], order, complete: true
    })) }
  return { ...source, unitId: `${nativeId}:assertion:0`, text: row.text,
    closure: { unit: owned, units: [owned], contexts: matrixContexts, record: ownedRecord, links: [],
      dependencies: [span, headingSpan, matrixHeaderSpan].map(span => ({ span, text: matrixRaw.slice(span.start, span.end) })) } }
})
const matrixInput = (): WikiVerificationInput => input({
  userRequest: 'Give the fictional recipes’ yields and timing without changing their owners.',
  requestFacets: ['Give each recipe’s yield and timing.'],
  sources: matrixSources,
  evidence: [{ ...input().evidence[0]!, readId: 'read:matrix:revision:7', source: matrixRaw }],
  claims: [
    { ...input().claims[0]!, unitId: matrixSources[0]!.unitId, statement: 'The fictional, untested Moon soup yields 2 servings.' },
    { ...input().claims[0]!, unitId: matrixSources[1]!.unitId, statement: 'The fictional, untested Sun broth is prepared after dusk.' }
  ]
})

const shipmentInput = (): WikiVerificationInput => {
  const heading = '# Shipment rules\n'
  const paragraphs = Array.from({ length: 64 }, (_, index) =>
    `Shipment ${index + 1} may ship 2 crates only after approval. ${'x'.repeat(1_000)}.`)
  const registeredSource = heading + '\n' + paragraphs.join('\n\n')
  const governingSpan = { start: 0, end: heading.length }
  const governing: SourceContext = { id: 'h', kind: 'heading', sourceSpans: [governingSpan],
    normalizedLabel: 'Shipment rules', parentId: null, complete: true }
  let start = heading.length + 1
  const selected: WikiVerificationSource[] = paragraphs.map((text, index) => {
    const span = { start, end: start + text.length }
    start = span.end + 2
    const owned: SourceUnit = { id: `u${index}`, kind: 'paragraph', sourceSpans: [span], normalizedText: text,
      contextIds: ['h'], recordId: null, structuralLabels: [], links: [], complete: true }
    return { evidenceId: 'shipments', sourceRevision: '7', unitId: `s${index}`, context: 'Shipment rules',
      text, kind: 'paragraph', complete: true, closure: { unit: owned, units: [owned], contexts: [governing], record: null, links: [],
        dependencies: [span, governingSpan].map(span => ({ span, text: registeredSource.slice(span.start, span.end) })) } }
  })
  return input({ userRequest: 'List every shipment’s permitted quantity and approval condition.',
    requestFacets: ['Give each shipment’s quantity and approval condition.'], sources: selected,
    evidence: [{ evidenceId: 'shipments', sourceRevision: '7', readId: 'read:shipments:large-owned-closures', source: registeredSource }],
    claims: selected.map((bound, index) => ({ evidenceId: bound.evidenceId, sourceRevision: bound.sourceRevision, unitId: bound.unitId,
      statement: `Shipment ${index + 1} is permitted to ship 2 crates only after approval.` })) })
}

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
    expect(() => plan({ evidence: [{ evidenceId: source.evidenceId, sourceRevision: '8', readId: 'read:42:revision:8', source: raw }] })).toThrow('registered read')
    expect(() => plan({ evidence: [...input().evidence, ...input().evidence] })).toThrow('ambiguous registered read')
  })

  it('requires a physical read identity and rejects aliases that disagree about its original content or revision', () => {
    const original = input().evidence[0]!
    expect(() => plan({ evidence: [{ ...original, readId: '' }] })).toThrow('registered read representation')
    const alias = { ...original, evidenceId: 'page:42:revision:7:section:2' }
    for (const conflicting of [{ ...alias, source: raw + 'A different original read.' }, { ...alias, sourceRevision: '8' }])
      expect(() => plan({ evidence: [original, conflicting] })).toThrow('physical read identity has inconsistent original content or revision')
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

  it('resolves the claimed original binding and complete own read despite unrelated inventory', () => {
    const other: WikiVerificationSource = { ...source, evidenceId: 'page:99:revision:8:section:1', sourceRevision: '8', text: 'Foreign recipe' }
    const candidate = input({ sources: [other, source], evidence: [
      ...input().evidence, { evidenceId: other.evidenceId, sourceRevision: '8', readId: 'read:99:revision:8', source: 'Foreign recipe and unrelated inventory.' },
      { evidenceId: 'uncited:related', sourceRevision: '1', readId: 'read:uncited:related:revision:1', source: 'An unrelated collection, not direct membership.' }
    ] })
    const built = buildWikiVerificationPlan(candidate)!
    const decisions = built.requests.map(request => consumeSupportRequest(request, check => {
      expect(check.claim).toEqual(candidate.claims[0])
      expect(check.originalSourceIndex).toBe(1)
      expect(check.source).toEqual(source)
      expect(check.registeredRead).toBe(raw)
      return supports
    }))
    expect(assessWikiVerificationResults(built, decisions)).toEqual({ valid: true, issues: [] })
  })

  it.each([
    ['distinct revisions', { evidenceId: 'page:42:revision:8:section:1', sourceRevision: '8' }],
    ['distinct read scopes', { evidenceId: 'page:42:revision:7:section:2', sourceRevision: '7' }]
  ] as const)('keeps identical read text under %s independently bound at the decision boundary', (_case, identity) => {
    const other = { ...source, ...identity }
    const candidate = input({ sources: [other, source], claims: [input().claims[0]!, {
      ...input().claims[0]!, ...identity
    }], evidence: [...input().evidence, { ...identity, readId: `read:${identity.evidenceId}`, source: raw }] })
    const built = buildWikiVerificationPlan(candidate)!
    const evaluatedScopes = new Set<string>()
    const decisions = built.requests.map(request => consumeSupportRequest(request, check => {
      const expected = check.claimIndex === 0 ? source : other
      evaluatedScopes.add(JSON.stringify([check.source.evidenceId, check.source.sourceRevision]))
      expect(check.claim).toEqual(candidate.claims[check.claimIndex])
      expect(check.source).toEqual(expected)
      expect(check.registeredRead).toBe(raw)
      return supports
    }))
    expect(evaluatedScopes).toEqual(new Set([source, other].map(bound => JSON.stringify([bound.evidenceId, bound.sourceRevision]))))
    expect(assessWikiVerificationResults(built, decisions).valid).toBe(true)
    const negative: Verdict = { choice: 'not_supported',
      probabilities: { supports: 0.01, contradicts: 0.01, not_supported: 0.98 }, confidence: 0.97 }
    const denied = built.requests.map(request => consumeSupportRequest(request, check => check.claimIndex === 1 ? negative : supports))
    expect(assessWikiVerificationResults(built, denied).valid).toBe(false)
  })

  it('requires every independent verdict for same-read nonliteral claims', () => {
    const candidate = { ...matrixInput(), sources: [...matrixSources].reverse() }
    const built = buildWikiVerificationPlan(candidate)!
    const evaluatedClaims = new Set<number>()
    const decisions = built.requests.map(request => consumeSupportRequest(request, check => {
      evaluatedClaims.add(check.claimIndex)
      expect(check.claim).toEqual(candidate.claims[check.claimIndex])
      expect(check.originalSourceIndex).toBe(1 - check.claimIndex)
      expect(check.source).toEqual(matrixSources[check.claimIndex])
      expect(check.registeredRead).toBe(matrixRaw)
      return supports
    }))
    expect(evaluatedClaims).toEqual(new Set([0, 1]))
    expect(assessWikiVerificationResults(built, decisions)).toEqual({ valid: true, issues: [] })
    const notSupported: Verdict = { choice: 'not_supported',
      probabilities: { supports: 0.01, contradicts: 0.01, not_supported: 0.98 }, confidence: 0.97 }
    for (const rejectedClaim of [0, 1]) {
      for (const verdict of [notSupported, undefined]) {
        const partial = built.requests.map(request => consumeSupportRequest(request, check =>
          check.claimIndex === rejectedClaim ? verdict : supports))
        const assessment = assessWikiVerificationResults(built, partial)
        expect(assessment.valid).toBe(false)
        expect(assessment.issues.some(issue => issue.includes(`Claim ${rejectedClaim + 1}`))).toBe(true)
      }
    }
  })

  it('preserves separate claim authority for evidence aliases of one physical read', () => {
    const original = matrixInput()
    const alias = { ...matrixSources[1]!, evidenceId: 'page:42:revision:7:section:2' }
    const candidate = { ...original, sources: [alias, matrixSources[0]!],
      claims: [original.claims[0]!, { ...original.claims[1]!, evidenceId: alias.evidenceId }],
      evidence: [...original.evidence, { ...original.evidence[0]!, evidenceId: alias.evidenceId }] }
    const built = buildWikiVerificationPlan(candidate)!
    const evaluatedClaims = new Set<number>()
    const decisions = built.requests.map(request => consumeSupportRequest(request, check => {
      evaluatedClaims.add(check.claimIndex)
      expect(check.claim).toEqual(candidate.claims[check.claimIndex])
      expect(check.originalSourceIndex).toBe(1 - check.claimIndex)
      expect(check.source).toEqual(check.claimIndex === 0 ? matrixSources[0] : alias)
      expect(check.registeredRead).toBe(matrixRaw)
      return supports
    }))
    expect(evaluatedClaims).toEqual(new Set([0, 1]))
    expect(assessWikiVerificationResults(built, decisions)).toEqual({ valid: true, issues: [] })
    const missingAlias = built.requests.map(request => consumeSupportRequest(request, check => check.claimIndex === 1 ? undefined : supports))
    expect(assessWikiVerificationResults(built, missingAlias).valid).toBe(false)
  })

  it.each([
    ['wrong matrix column owner', 0, 'The fictional, untested Moon soup yields 3 servings.'],
    ['cross-record borrowing', 1, 'The fictional, untested Moon soup yields 2 servings.']
  ] as const)('rejects %s using its independent negative verdict without merging same-read closures', (_case, rejectedClaim, statement) => {
    const original = matrixInput()
    const candidate = { ...original, claims: original.claims.map((claim, index) => index === rejectedClaim ? { ...claim, statement } : claim) }
    const built = buildWikiVerificationPlan(candidate)!
    const negative: Verdict = { choice: 'not_supported',
      probabilities: { supports: 0.01, contradicts: 0.01, not_supported: 0.98 }, confidence: 0.97 }
    const evaluatedClaims = new Set<number>()
    const decisions = built.requests.map(request => consumeSupportRequest(request, check => {
      evaluatedClaims.add(check.claimIndex)
      expect(check.claim).toEqual(candidate.claims[check.claimIndex])
      expect(check.source.closure).toEqual(matrixSources[check.claimIndex]!.closure)
      expect(check.registeredRead).toBe(matrixRaw)
      return check.claimIndex === rejectedClaim ? negative : supports
    }))
    expect(evaluatedClaims).toEqual(new Set([0, 1]))
    const assessment = assessWikiVerificationResults(built, decisions)
    expect(assessment.valid).toBe(false)
    expect(assessment.issues).toHaveLength(1)
    expect(assessment.issues[0]).toContain(`Claim ${rejectedClaim + 1}`)
    expect(assessment.issues[0]).toContain('not_supported')
  })

  it('rejects a same-read closure that imports another selected record before requesting decisions', () => {
    const candidate = matrixInput()
    const yieldSource = matrixSources[0]!
    const timingSource = matrixSources[1]!
    const merged: WikiVerificationSource = { ...yieldSource, closure: { ...yieldSource.closure!,
      units: [...yieldSource.closure!.units, ...timingSource.closure!.units],
      record: { ...yieldSource.closure!.record!, unitIds: [...yieldSource.closure!.record!.unitIds, ...timingSource.closure!.record!.unitIds],
        fields: [...yieldSource.closure!.record!.fields, ...timingSource.closure!.record!.fields] } } }
    expect(() => buildWikiVerificationPlan({ ...candidate, sources: [merged, timingSource] })).toThrow('foreign or ambiguous ownership')
  })

  it('admits all 64 independently bound claims with large owned closures and rejects missing or uncertain verdicts', () => {
    const candidate = shipmentInput()
    const built = buildWikiVerificationPlan(candidate)!
    const evaluatedClaims = new Set<number>()
    const decisions = built.requests.map(request => {
      expect(() => validateDecisionBatchRequest(request)).not.toThrow()
      return consumeSupportRequest(request, check => {
        evaluatedClaims.add(check.claimIndex)
        expect(check.originalSourceIndex).toBe(check.claimIndex)
        expect(check.claim).toEqual(candidate.claims[check.claimIndex])
        expect(check.source).toEqual(candidate.sources[check.claimIndex])
        expect(check.registeredRead).toBe(candidate.evidence[0]!.source)
        return supports
      })
    })
    expect(evaluatedClaims).toEqual(new Set(Array.from({ length: 64 }, (_, index) => index)))
    expect(assessWikiVerificationResults(built, decisions)).toEqual({ valid: true, issues: [] })
    for (const verdict of [undefined, { ...supports, confidence: 0.8 }]) {
      const partial = built.requests.map(request => consumeSupportRequest(request, check => check.claimIndex === 63 ? verdict : supports))
      const assessment = assessWikiVerificationResults(built, partial)
      expect(assessment.valid).toBe(false)
      expect(assessment.issues.some(issue => issue.includes('Claim 64'))).toBe(true)
    }
  })

  it('admits one long normalized source while preserving exact authored dependencies, links and host authority', () => {
    const heading = '# Shipment rules\n'
    const normalized = 'Shipment may ship 2 crates only after approval. Details: ' + 'x'.repeat(30_000) + ' µ😀e\u0301.'
    const authored = normalized.replace('after approval.', 'after [approval](/approval).')
    const registeredRead = heading + '\n' + authored
    const span = { start: heading.length + 1, end: registeredRead.length }
    const governingSpan = { start: 0, end: heading.length }
    const governing: SourceContext = { id: 'h', kind: 'heading', sourceSpans: [governingSpan],
      normalizedLabel: 'Shipment rules', parentId: null, complete: true }
    const approval: SourceLink = { label: 'approval', destination: '/approval', unitId: 'u',
      sourceSpans: [span], dependencySpans: [], kind: 'link' }
    const owned: SourceUnit = { id: 'u', kind: 'paragraph', sourceSpans: [span], normalizedText: normalized,
      contextIds: ['h'], recordId: null, structuralLabels: ['Shipment'], links: [approval], complete: true }
    const bound: WikiVerificationSource = { evidenceId: 'long-shipment', sourceRevision: '7', unitId: 's',
      context: 'Shipment rules', text: normalized, kind: 'paragraph', complete: true,
      closure: { unit: owned, units: [owned], contexts: [governing], record: null, links: [approval],
        dependencies: [span, governingSpan].map(span => ({ span, text: registeredRead.slice(span.start, span.end) })) } }
    const candidate = input({ sources: [bound],
      userRequest: 'Describe the shipment’s permission and approval condition.',
      requestFacets: ['Give the permitted quantity and approval condition.'],
      evidence: [{ evidenceId: bound.evidenceId, sourceRevision: '7', readId: 'read:long-shipment', source: registeredRead }],
      claims: [{ evidenceId: bound.evidenceId, sourceRevision: '7', unitId: bound.unitId,
        statement: 'Shipment is permitted to ship 2 crates only after approval.' }] })
    const built = buildWikiVerificationPlan(candidate)!
    const evaluatedClaims = new Set<number>()
    const decisions = built.requests.map(request => {
      expect(() => validateDecisionBatchRequest(request)).not.toThrow()
      return consumeSupportRequest(request, check => {
        evaluatedClaims.add(check.claimIndex)
        expect(check.source).toEqual(bound)
        expect(check.claim).toEqual(candidate.claims[0])
        expect(check.originalSourceIndex).toBe(0)
        expect(check.registeredRead).toBe(registeredRead)
        return supports
      })
    })
    expect(evaluatedClaims).toEqual(new Set([0]))
    expect(built.originalSources[0]!.text).toBe(normalized)
    expect(built.originalSources[0]!.closure!.unit.normalizedText).toBe(normalized)
    expect(built.originalSources[0]!.closure!.dependencies[0]!.text).toBe(authored)
    expect(assessWikiVerificationResults(built, decisions)).toEqual({ valid: true, issues: [] })
    const denied = built.requests.map(request => consumeSupportRequest(request, () => ({
      choice: 'not_supported', probabilities: { supports: 0.01, contradicts: 0.01, not_supported: 0.98 }, confidence: 0.97
    })))
    expect(assessWikiVerificationResults(built, denied).valid).toBe(false)
  })

  it('rejects malformed native whole-string references without coercing or clamping indices', () => {
    expect(decodeWikiVerificationSources([{ ...source, text: { readText: 0 } }], [source.text])[0]!.text).toBe(source.text)
    for (const readText of [-1, 0.5, 1, NaN, Infinity, '0', null])
      expect(() => decodeWikiVerificationSources([{ ...source, text: { readText } }], [source.text])).toThrow('native source text reference')
    expect(() => decodeWikiVerificationSources([{ ...source, text: { readText: 0, foreign: true } }], [source.text]))
      .toThrow('native source text reference')
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
    })), evidence: sources.map(bound => ({ evidenceId: bound.evidenceId, sourceRevision: bound.sourceRevision, readId: `read:${bound.evidenceId}`, source: raw })) })
    const built = buildWikiVerificationPlan(candidate)!
    expect(built.literalSupportCount).toBe(9)
    expect(built.requests).toEqual([])
    expect(built.checks).toEqual({})
    expect(assessWikiVerificationResults(built)).toEqual({ valid: true, issues: [] })
    expect(assessWikiVerificationResults(built, [result({})]).valid).toBe(false)
  })

  it('skips a complete literal quote without collapsing two nonliteral checks for the same original selected unit', () => {
    const original = input().claims[0]!
    const candidate = input({ sources: [recordSource], claims: [
      { ...original, statement: recordQuote },
      original,
      { ...original, statement: 'The fictional, untested Moon soup has a yield of 2 servings and a before-dawn simmering method.' }
    ] })
    const built = buildWikiVerificationPlan(candidate)!
    const evaluatedClaims = new Set<number>()
    const decisions = built.requests.map(request => consumeSupportRequest(request, check => {
      evaluatedClaims.add(check.claimIndex)
      expect(check.claim).toEqual(candidate.claims[check.claimIndex])
      expect(check.originalSourceIndex).toBe(0)
      expect(check.source).toEqual(recordSource)
      expect(check.registeredRead).toBe(raw)
      return supports
    }))
    expect(built.literalSupportCount).toBe(1)
    expect(evaluatedClaims).toEqual(new Set([1, 2]))
    expect(assessWikiVerificationResults(built, decisions)).toEqual({ valid: true, issues: [] })
    const missingRepeatedBinding = built.requests.map(request => consumeSupportRequest(request, check =>
      check.claimIndex === 2 ? undefined : supports))
    expect(assessWikiVerificationResults(built, missingRepeatedBinding).valid).toBe(false)
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
      evidence: [...input().evidence, { evidenceId: foreign.evidenceId, sourceRevision: '7', readId: 'read:foreign:revision:7', source: raw }]
    }))!
    expect(built.literalSupportCount).toBe(0)
    const negative: Verdict = { choice: 'not_supported',
      probabilities: { supports: 0.01, contradicts: 0.01, not_supported: 0.98 }, confidence: 0.97 }
    const decisions = built.requests.map(request => consumeSupportRequest(request, check => {
      expect(check.source).toEqual(recordSource)
      expect(check.claim.evidenceId).toBe(recordSource.evidenceId)
      expect(check.registeredRead).toBe(raw)
      return negative
    }))
    expect(assessWikiVerificationResults(built, decisions).valid).toBe(false)
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
      evidenceId: title.evidenceId, sourceRevision: title.sourceRevision, readId: 'read:42:revision:7', source: raw
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
    expect(state(built.requests[0]!).sources[0]!.text).toBe(recordSource.text)
    expect(built.originalSources).toEqual([recordSource])
    expect(readsFrom(built.requests[0]!)).toEqual(input().evidence)
    for (const choice of ['unbound', 'not_established']) {
      const verdict = { choice, probabilities: { bounded: 0.01, unbound: choice === 'unbound' ? 0.98 : 0.01,
        not_established: choice === 'not_established' ? 0.98 : 0.01 }, confidence: 0.97 }
      expect(assessWikiVerificationResults(built, batchResults(built, { narration_0: verdict })).valid).toBe(false)
    }
    expect(assessWikiVerificationResults(built, batchResults(built)).valid).toBe(true)
    expect(assessWikiVerificationResults(built, []).valid).toBe(false)
  })

  it('rejects mutation of original dependencies omitted from narration transport', () => {
    const built = buildWikiVerificationPlan({ ...quotedInput(), candidateExtras: { observations: ['Consider reading the guide.'], recommendations: '' } })!
    expect(built.literalSupportCount).toBe(1)
    expect(Object.keys(built.checks)).toEqual(['narration_0'])
    Reflect.set(built.originalSources[0]!.closure!.dependencies[0]!, 'text', 'Changed original dependency')
    expect(assessWikiVerificationResults(built, batchResults(built))).toEqual({
      valid: false,
      issues: ['Wiki verification request or required checks changed after issuance.']
    })
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
