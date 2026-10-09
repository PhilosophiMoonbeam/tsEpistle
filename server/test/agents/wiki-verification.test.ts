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

  it('admits a many-claim inventory without losing qualifiers, record ownership or uncited related scopes', () => {
    const inventory: WikiVerificationSource[] = []
    const reads: WikiVerificationInput['evidence'][number][] = []
    for (let index = 0; index < 13; index++) {
      const identity = `p:${index}:r7:`
      const heading = '# Fictional, authored, untested recipes\n'
      const lines = Array.from({ length: 6 }, (_, step) => `R${index}/${step}:${step + 1}h elapsed;${index + 1} servings.\n`)
      const read = heading + lines.join('') + '\n[guide]: /related\n'
      const definition = { start: read.indexOf('[guide]:'), end: read.length }
      const governing: SourceContext = {
        id: `${identity}heading`, kind: 'heading', sourceSpans: [{ start: 0, end: heading.length }],
        normalizedLabel: 'Fictional, authored, untested recipes', parentId: null, complete: true
      }
      let offset = heading.length
      const owned: SourceUnit[] = lines.map((text, step) => {
        const span = { start: offset, end: offset + text.length }
        offset = span.end
        const id = `${identity}step:${step}`
        return {
          id, kind: 'table-row', sourceSpans: [span], normalizedText: text.trim(),
          contextIds: [governing.id], recordId: `${identity}record`, structuralLabels: [`R${index}`, `s${step}`],
          links: [{ label: 'Related', destination: '/related',
            unitId: id, sourceSpans: [span], dependencySpans: [definition], kind: 'link' }], complete: true
        }
      })
      const ownedRecord: SourceRecord = {
        id: `${identity}record`, kind: 'table-row', contextIds: [governing.id], unitIds: owned.map(entry => entry.id),
        fields: owned.flatMap((entry, step) => [
          { id: `${identity}elapsed:${step}`, label: 'Elapsed, not active', value: `${step + 1}h`,
            unitIds: [entry.id], sourceSpans: entry.sourceSpans, order: step * 2, complete: true },
          { id: `${identity}yield:${step}`, label: 'Serving yield', value: `${index + 1} servings`,
            unitIds: [entry.id], sourceSpans: entry.sourceSpans, order: step * 2 + 1, complete: true }
        ]), complete: true
      }
      const dependencies = [governing.sourceSpans[0]!, ...owned.map(entry => entry.sourceSpans[0]!), definition]
        .map(span => ({ span, text: read.slice(span.start, span.end) }))
      const evidenceId = `page:${index}:revision:7:section:recipes`
      reads.push({ evidenceId, sourceRevision: '7', source: read })
      for (const entry of owned.slice(0, 2)) inventory.push({
        evidenceId, sourceRevision: '7', unitId: `${entry.id}:assertion:0`, context: governing.normalizedLabel,
        text: entry.normalizedText, kind: entry.kind, complete: true,
        closure: { unit: entry, units: owned, contexts: [governing], record: ownedRecord,
          links: owned.flatMap(item => item.links), dependencies }
      })
    }
    // Equal body text is not an authority alias: retain each read's exact identity/revision.
    reads.push(
      { ...reads[0]!, evidenceId: 'page:0:revision:8:section:recipes', sourceRevision: '8' },
      { ...reads[0]!, evidenceId: 'page:alias:revision:7:section:recipes' },
      { evidenceId: 'page:related:revision:3:section:collections', sourceRevision: '3',
        source: '# Related collections, not direct recipes\n[Guide](/related/guide)\nUncited collection: seasonal experiments; authored and untested.\n' }
    )
    const candidate: WikiVerificationInput = {
      userRequest: 'Inventory every supplied recipe with fictional/authored/untested status, elapsed time, serving basis and separately labelled related collections.',
      requestFacets: ['All supplied recipes and their qualifications; related collections separately from direct members'],
      claims: inventory.map(entry => ({ evidenceId: entry.evidenceId, sourceRevision: entry.sourceRevision,
        unitId: entry.unitId, statement: `${entry.context}; ${entry.text}` })),
      sources: inventory, evidence: reads
    }
    const built = buildWikiVerificationPlan(candidate)
    if (built === null) throw new Error('Expected inventory verification plan')
    expect(Object.keys(built.request.questions)).toHaveLength(27)
    expect(new TextEncoder().encode(JSON.stringify(built.request)).byteLength).toBeLessThanOrEqual(128 * 1024 - 8192)

    // Consumer-side decoding follows the advertised columns, then checks the facts
    // needed to distinguish governing qualifiers and foreign-record borrowing.
    type PackedClosure = { unit: number; units: number[]; contexts: number[]; record: number | null; links: number[]; dependencies: number[] }
    const state = built.request.state as unknown as {
      structures: { kind: string; value: unknown }[]; structureColumns: Record<string, string[]>; identifiers: string[]
      sources: (Omit<WikiVerificationSource, 'closure'> & { closure: PackedClosure })[]
      evidence: { evidenceId: string; sourceRevision: string; source: number }[]
    }
    const decodeRow = (kind: string, value: unknown): unknown => {
      if (kind === 'evidence-source') return value
      if (!Array.isArray(value)) throw new Error(`Expected ${kind} row`)
      return Object.fromEntries(state.structureColumns[kind]!.map((column, index) => {
        const cell: unknown = value[index]
        if (['id', 'parentId', 'recordId', 'unitId'].includes(column))
          return [column, cell === null ? null : state.identifiers[cell as number]]
        if (column === 'contextIds' || column === 'unitIds')
          return [column, (cell as number[]).map(id => state.identifiers[id])]
        if (column === 'sourceSpans' || column === 'dependencySpans')
          return [column, (cell as [number, number][]).map(([start, end]) => ({ start, end }))]
        if (column === 'span') {
          const [start, end] = cell as [number, number]
          return [column, { start, end }]
        }
        if (column === 'fields' || column === 'links')
          return [column, (cell as unknown[]).map(row => decodeRow(column === 'fields' ? 'field' : 'link', row))]
        return [column, cell]
      }))
    }
    const resolve = (index: number): unknown => {
      const entry = state.structures[index]!
      return decodeRow(entry.kind, entry.value)
    }
    const decoded = state.sources.map(entry => ({
      ...entry, closure: {
        unit: resolve(entry.closure.unit), units: entry.closure.units.map(resolve), contexts: entry.closure.contexts.map(resolve),
        record: entry.closure.record === null ? null : resolve(entry.closure.record),
        links: entry.closure.links.map(resolve), dependencies: entry.closure.dependencies.map(resolve)
      }
    }))
    expect(decoded).toEqual(inventory)
    expect(state.evidence.map(entry => ({ ...entry, source: resolve(entry.source) }))).toEqual(reads)
    // The previous object-valued structure encoding keeps the same interned
    // closures, but exceeds admission even without identifier/column dictionaries.
    const { identifiers: _identifiers, structureColumns: _columns, ...legacyState } = state
    const legacyRequest = {
      ...built.request, state: {
        ...legacyState, evidence: reads,
        structures: state.structures.filter(entry => entry.kind !== 'evidence-source')
          .map(entry => ({ kind: entry.kind, value: decodeRow(entry.kind, entry.value) }))
      }
    }
    expect(new TextEncoder().encode(JSON.stringify(legacyRequest)).byteLength).toBeGreaterThan(128 * 1024 - 8192)
    const first = decoded[0]!.closure.record as SourceRecord
    const foreign = decoded[2]!.closure.record as SourceRecord
    expect(first.id).not.toBe(foreign.id)
    expect(first.fields[1]!.value).toBe('1 servings')
    expect(foreign.fields[1]!.value).toBe('2 servings')
    expect(first.fields[0]!.label).toBe('Elapsed, not active')
    expect(decoded[0]!.closure.contexts).toEqual([inventory[0]!.closure!.contexts[0]])
    expect(resolve(state.evidence.at(-1)!.source)).toContain('Uncited collection: seasonal experiments; authored and untested.')
    expect(state.evidence.slice(-3, -1).map(entry => [entry.evidenceId, entry.sourceRevision])).toEqual([
      ['page:0:revision:8:section:recipes', '8'], ['page:alias:revision:7:section:recipes', '7']
    ])
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
