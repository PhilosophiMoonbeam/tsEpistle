import { AxMockAIService, type AxAIService, type AxChatRequest, type AxChatResponse } from '@ax-llm/ax'
import type { DecisionBatchRequest, DecisionBatchResult } from '../../../shared/agents/decision-providers.ts'
import type { DecisionProviderRegistry, DecisionProviderRuntime } from '../../agents/decision-providers.ts'
import { wikiSynthesisSourceRef } from '../../agents/providers/wiki-synthesis.ts'
import { parseSourceDocument, type SourceSpan, type SourceUnit } from '../../agents/providers/source-document.ts'

/**
 * Test-only Jev decision judge for engine fixtures. It is a mock dependency,
 * never a production fallback and carries no semantic-accuracy claim:
 * applicability resolves to `other`; semantic questions resolve to `supports`
 * or `complete`. Inventory-specific tests must provide their own decisions.
 */
export const fixtureDecisionProviders = {
  async selectRuntime(): Promise<DecisionProviderRuntime> {
    return {
      id: '00000000-0000-4000-8000-000000000002',
      revision: 1,
      config: {
        kind: 'typesafe',
        model: 'jev-1.13.0',
        timeoutMs: 5000,
        pricing: {
          currency: 'USD',
          inputPerMillion: 0,
          outputPerMillion: 0,
          perRequest: 0,
          revision: 'fixture',
          source: 'fixture',
          verifiedAt: '2026-10-04'
        }
      }
    }
  },
  async decideBatch(
    request: DecisionBatchRequest,
    options: NonNullable<Parameters<DecisionProviderRegistry['decideBatch']>[1]> = {}
  ): Promise<DecisionBatchResult> {
    const provider = await fixtureDecisionProviders.selectRuntime()
    await options.onPreDispatch?.()
    const answers: Record<string, DecisionBatchResult['answers'][string]> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const label = Object.keys(question.criteria).find(label => label === 'other' || label === 'supports' || label === 'bounded')
      if (label === undefined) throw new Error(`Fixture decision provider has no supported mock criterion for question ${id}`)
      const probabilities: Record<string, number> = Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === label ? 1 : 0]))
      answers[id] = { choice: label, probabilities, confidence: 1 }
    }
    const pricing = provider.config.kind === 'typesafe' ? provider.config.pricing : null
    const amount = pricing
      ? (0 / 1_000_000) * pricing.inputPerMillion + (0 / 1_000_000) * pricing.outputPerMillion + pricing.perRequest
      : 0
    return {
      providerId: provider.id,
      providerRevision: provider.revision,
      model: provider.config.model,
      answers,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalTokensSource: 'derived' },
      latencyMs: 0,
      estimatedCost: pricing && { currency: pricing.currency, amount, pricingRevision: pricing.revision, source: pricing.source, verifiedAt: pricing.verifiedAt },
      estimatedCostMicros: pricing ? Math.round(amount * 1_000_000) : null
    }
  }
} satisfies Pick<DecisionProviderRegistry, 'selectRuntime' | 'decideBatch'>

// Explicit fixture adjudication for unsupported meanings that may be mechanically
// eligible. Other fixtures retain the canned positive judge so ownership/literal
// failures cannot pass merely because the semantic dependency rejects everything.
export const rejectFixtureStatements = (statements: readonly string[]) => ({
  ...fixtureDecisionProviders,
  async decideBatch(input: DecisionBatchRequest, options: Parameters<typeof fixtureDecisionProviders.decideBatch>[1]): Promise<DecisionBatchResult> {
    const decision = await fixtureDecisionProviders.decideBatch(input, options)
    const supportQuestions = Object.entries(input.questions).filter(([, question]) => Object.hasOwn(question.criteria, 'supports'))
    if (supportQuestions.length === 0) return decision
    const state = JSON.parse(input.state as string) as { candidate: readonly { statement: string }[] }
    const answers = { ...decision.answers }
    for (const [id, question] of supportQuestions) {
      const instructions = question.instructions
      if (typeof instructions !== 'object' || instructions === null || Array.isArray(instructions) ||
        !('candidate_index' in instructions) ||
        typeof instructions.candidate_index !== 'number' || !Number.isSafeInteger(instructions.candidate_index))
        throw new Error(`Fixture support question lacks its independent candidate index: ${id}`)
      const claim = state.candidate[instructions.candidate_index]
      if (claim === undefined) throw new Error(`Fixture support question selects a missing candidate: ${id}`)
      if (statements.includes(claim.statement))
        answers[id] = { choice: 'not_supported', probabilities: { supports: 0, contradicts: 0, not_supported: 1 }, confidence: 1 }
    }
    return { ...decision, answers }
  }
})

export const fullAxFixtureService = (
  chat: AxAIService['chat'],
  options: { readonly model?: string; readonly streaming?: boolean; readonly structuredOutput?: boolean } = {}
): AxAIService => new AxMockAIService({
  name: 'Wiki fixture',
  modelInfo: { name: options.model ?? 'gpt-test' },
  features: {
    functions: true,
    streaming: options.streaming ?? false,
    structuredOutputs: options.structuredOutput ?? true,
    structuredOutputModes: options.structuredOutput === false ? [] : ['native']
  },
  chatResponse: chat
})

export const synthesisInputFromRequest = (request: Readonly<AxChatRequest>): string | undefined => {
  if ((request.functions?.length ?? 0) > 0) return undefined
  for (const message of [...request.chatPrompt].reverse()) {
    if (message.role !== 'user') continue
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) continue
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    if (/^User Request: /u.test(content) && content.includes('\n\nSource Text: ') && content.includes('\n\nSource References: ')) return content
  }
  return undefined
}

const synthesisFieldText = (input: string, title: string): string => {
  const start = input.lastIndexOf(`\n\n${title}: `)
  if (start < 0) throw new Error(`Missing supplied synthesis ${title} field`)
  const value = input.slice(start + title.length + 4)
  const end = title === 'Source Text'
    ? value.lastIndexOf('\n\nSource References: ')
    : value.search(/\n\n(?:Request Facets|Available Observations|Repair Feedback): /u)
  return end < 0 ? value : value.slice(0, end)
}

const synthesisField = (input: string, title: string): unknown => JSON.parse(synthesisFieldText(input, title))

export interface SynthesisFixtureRead {
  readonly readRef: string
  readonly evidenceId: string
  readonly sourceRevision: string
  readonly title: string | null
  readonly representation: string
  readonly complete: boolean
  readonly readText: string
}

export interface SynthesisFixtureSource extends SynthesisFixtureRead {
  readonly sourceRef: string
  readonly text: string
  readonly kind: string
  readonly preview: boolean
  readonly record?: number
  readonly rawSpans?: readonly SourceSpan[]
}

export const synthesisReadsFromRequest = (request: Readonly<AxChatRequest>): SynthesisFixtureRead[] => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined) return []
  const sourceText = synthesisFieldText(input, 'Source Text')
  const headers = [...sourceText.matchAll(/(?:^|\n\n)SOURCE READ (d\d+) ([^\n]+)\n/gu)]
  return headers.map((header, index) => {
    const metadata: unknown = JSON.parse(header[2]!)
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
      throw new Error('Invalid supplied synthesis read metadata')
    const row = metadata as Record<string, unknown>
    if (typeof row.evidenceId !== 'string' || typeof row.revision !== 'string' ||
      row.title !== null && typeof row.title !== 'string' || typeof row.representation !== 'string' ||
      row.status !== 'full' && row.status !== 'truncated')
      throw new Error('Invalid supplied synthesis read identity')
    const bodyStart = header.index! + header[0].length
    const nextStart = headers[index + 1]?.index ?? sourceText.length
    const footer = `\nEND SOURCE READ ${header[1]}`
    const bodyEnd = sourceText.lastIndexOf(footer, nextStart)
    if (bodyEnd < bodyStart || bodyEnd + footer.length > nextStart)
      throw new Error('Missing supplied synthesis read footer')
    return {
      readRef: header[1]!, evidenceId: row.evidenceId, sourceRevision: row.revision,
      title: row.title, representation: row.representation, complete: row.status === 'full',
      readText: sourceText.slice(bodyStart, bodyEnd)
    }
  })
}

export const synthesisSourcesFromRequest = (request: Readonly<AxChatRequest>): SynthesisFixtureSource[] => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined) return []
  const reads = new Map(synthesisReadsFromRequest(request).map(read => [read.readRef, read]))
  const references = synthesisField(input, 'Source References')
  if (references === null || typeof references !== 'object' || Array.isArray(references))
    throw new Error('Supplied synthesis references are not an index')
  const index = references as Record<string, unknown>
  if (index.scopes === null || typeof index.scopes !== 'object' || Array.isArray(index.scopes) ||
    index.units === null || typeof index.units !== 'object' || Array.isArray(index.units))
    throw new Error('Supplied synthesis references require scope and unit dictionaries')
  const scopes = index.scopes as Record<string, unknown>
  return Object.entries(index.units).flatMap(([sourceRef, row]) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row))
      throw new Error('Invalid supplied synthesis reference')
    const source = row as Record<string, unknown>
    if (typeof source.text !== 'string' || typeof source.scope !== 'number' || !Number.isSafeInteger(source.scope) ||
      source.title !== undefined && source.title !== true ||
      source.preview !== undefined && source.preview !== true ||
      source.record !== undefined && (typeof source.record !== 'number' || !Number.isSafeInteger(source.record) || source.record < 0))
      throw new Error('Invalid supplied synthesis selector')
    const rawSpans = source.rawSpans
    if (source.preview === true && (!Array.isArray(rawSpans) || rawSpans.length === 0) ||
      source.preview !== true && rawSpans !== undefined ||
      Array.isArray(rawSpans) && rawSpans.some(span =>
        span === null || typeof span !== 'object' || Array.isArray(span) ||
        typeof span.start !== 'number' || typeof span.end !== 'number' ||
        !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
        span.start < 0 || span.end <= span.start))
      throw new Error('Invalid supplied synthesis raw spans')
    const aliases = source.aliases ?? {}
    if (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases))
      throw new Error('Invalid supplied synthesis aliases')
    const aliasBindings = Object.entries(aliases).flatMap(([scopeKey, refs]) => {
      const scope = Number(scopeKey)
      if (!/^\d+$/u.test(scopeKey) || !Number.isSafeInteger(scope) || typeof refs !== 'string' || refs.length === 0)
        throw new Error('Invalid supplied synthesis alias scope list')
      return refs.split(' ').map(ref => {
        if (!/^s[A-Za-z0-9_-]{16}$/u.test(ref)) throw new Error('Invalid supplied synthesis alias reference')
        return [ref, scope] as const
      })
    })
    return [[sourceRef, source.scope], ...aliasBindings].map(([ref, scopeKey]) => {
      if (typeof ref !== 'string' || typeof scopeKey !== 'number' || !Number.isSafeInteger(scopeKey))
        throw new Error('Invalid supplied synthesis alias identity')
      const scope = scopes[String(scopeKey)]
      if (scope === null || typeof scope !== 'object' || Array.isArray(scope))
        throw new Error('Missing supplied synthesis scope')
      const owner = scope as Record<string, unknown>
      if (typeof owner.readRef !== 'string' || typeof owner.evidenceId !== 'string')
        throw new Error('Invalid supplied synthesis scope identity')
      const read = reads.get(owner.readRef)
      if (read === undefined) throw new Error('Missing supplied synthesis read')
      if (Array.isArray(rawSpans) && rawSpans.some(span => span.end > read.readText.length))
        throw new Error('Supplied synthesis raw spans exceed their physical read')
      return {
        ...read, sourceRef: ref, evidenceId: owner.evidenceId,
        text: source.text as string, kind: source.title === true ? 'page-title' : 'source',
        complete: true, preview: source.preview === true,
        ...(source.record === undefined ? {} : { record: source.record as number }),
        ...(rawSpans === undefined ? {} : { rawSpans: rawSpans as readonly SourceSpan[] })
      }
    })
  })
}

let lastParsedFixtureRead: { readonly text: string; readonly units: readonly SourceUnit[] } | undefined

// Derive expected Markdown input-unit refs from the raw bytes the model sees.
// This is a selector predicate, not reconstructed host proof or wire metadata.
export const synthesisSourceMatchesMarkdownUnitKind = (
  source: SynthesisFixtureSource,
  kind: SourceUnit['kind']
): boolean => {
  if (lastParsedFixtureRead?.text !== source.readText) lastParsedFixtureRead = {
    text: source.readText,
    units: parseSourceDocument(source.readText, { representation: 'markdown', truncated: false }).units
  }
  return lastParsedFixtureRead.units.some(unit => unit.kind === kind && wikiSynthesisSourceRef({
    evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, unitId: `${unit.id}:assertion:0`
  }) === source.sourceRef)
}


export const synthesisObservationsFromRequest = (request: Readonly<AxChatRequest>): readonly string[] => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined || !input.includes('\n\nAvailable Observations: ')) return []
  const observations: unknown = synthesisField(input, 'Available Observations')
  if (!Array.isArray(observations) || observations.some(value => typeof value !== 'string'))
    throw new Error('Supplied Available Observations field is not a string array')
  return observations
}

export const synthesisCollectionControl = (request: Readonly<AxChatRequest>): AxChatResponse | undefined => {
  const native = request.functions?.some(tool => tool.name === 'wiki_finish_collection') === true
  const prompt = request.chatPrompt.some(message =>
    message.role === 'system' &&
    /<wiki-tool-call>\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{\s*\}\s*\}\s*<\/wiki-tool-call>/u.test(message.content) &&
    /"name"\s*:\s*"wiki_finish_collection"\s*,\s*"description"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"parameters"\s*:\s*\{/u.test(message.content)
  )
  if (!native && !prompt) return undefined
  return {
    results: [native ? {
      index: 0,
      finishReason: 'function_call',
      functionCalls: [{ id: 'fixture-finish-collection', type: 'function', function: { name: 'wiki_finish_collection', params: '{}' } }]
    } : {
      index: 0,
      finishReason: 'stop',
      content: '<wiki-tool-call>{"name":"wiki_finish_collection","arguments":{}}</wiki-tool-call>'
    }],
    modelUsage: {
      ai: 'Wiki fixture',
      model: String(request.model ?? 'gpt-test'),
      tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 }
    }
  }
}

export interface SynthesisFixtureClaim {
  readonly evidenceId: string
  readonly statement: string
  readonly sourceRevision?: string
  readonly unitId?: string
  readonly sourceRef?: string
}

export interface SynthesisFixtureAnswer {
  readonly claims: readonly SynthesisFixtureClaim[]
  readonly unresolvedFacets?: readonly number[]
  readonly observations?: readonly string[]
  readonly recommendations?: string
}

export type SynthesisFixtureBindings = Readonly<Record<string, number | { readonly text?: string; readonly readText?: string; readonly sourceRef?: string }>>

export interface SynthesisFixtureOptions {
  readonly bindings?: SynthesisFixtureBindings
}

// This producer only changes the output format. Statements and citation choices
// are independently supplied by each test; source text never becomes an answer.
export const synthesisFixtureAnswer = (
  request: Readonly<AxChatRequest>,
  fixture: string | SynthesisFixtureAnswer,
  options: SynthesisFixtureOptions = {}
): string => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined) {
    if (typeof fixture !== 'string') throw new Error('Typed fixture supplied outside the synthesis stage')
    return fixture
  }
  const sources = synthesisSourcesFromRequest(request)
  let answer: SynthesisFixtureAnswer
  if (typeof fixture === 'string') {
    if (/^\s*\{/u.test(fixture) || /^Claims:/u.test(fixture)) return fixture
    const claims: SynthesisFixtureClaim[] = []
    let offset = 0
    for (const marker of fixture.matchAll(/\[\[cite:([^\]]+)\]\]/gu)) {
      const statement = fixture.slice(offset, marker.index).trim()
      if (!statement) return fixture
      claims.push({ evidenceId: marker[1]!, statement })
      offset = marker.index + marker[0].length
    }
    if (claims.length === 0 || fixture.slice(offset).trim()) return fixture
    answer = { claims }
  } else answer = fixture
  const claims = answer.claims.map(claim => {
    const revision = claim.sourceRevision ?? /:revision:([^:]+)/u.exec(claim.evidenceId)?.[1]
    const explicitRef = claim.sourceRef ?? (claim.unitId === undefined ? undefined : wikiSynthesisSourceRef({
      evidenceId: claim.evidenceId, sourceRevision: revision ?? 'fixture-unknown-revision', unitId: claim.unitId
    }))
    let candidates = sources.filter(source => source.evidenceId === claim.evidenceId &&
      (revision === undefined || source.sourceRevision === revision) && (explicitRef === undefined || source.sourceRef === explicitRef))
    if (explicitRef === undefined) {
      const titleAssertion = /^(?:(?:The\s+)?(?:(?:current|this)\s+)?page(?:'s)?\s+(?:is\s+(?:titled|named|called)|(?:title|name)\s+is)|(?:Title|Page\s+title)\s*:)/iu.test(claim.statement)
      candidates = candidates.filter(source => (source.kind === 'page-title') === titleAssertion)
      if (!titleAssertion && (options.bindings?.[claim.evidenceId] === undefined || typeof options.bindings[claim.evidenceId] === 'number'))
        candidates = candidates.filter(source => !synthesisSourceMatchesMarkdownUnitKind(source, 'heading'))
    }
    const binding = options.bindings?.[claim.evidenceId]
    if (explicitRef === undefined && binding !== undefined) {
      candidates = typeof binding === 'number'
        ? candidates.slice(binding, binding + 1)
        : candidates.filter(source => (binding.text === undefined || source.text === binding.text) &&
          (binding.readText === undefined || source.readText === binding.readText) &&
          (binding.sourceRef === undefined || source.sourceRef === binding.sourceRef))
    }
    if (candidates.length > 1 && explicitRef === undefined)
      throw new Error(`Select an explicit source unit for fixture citation ${claim.evidenceId}`)
    const source = candidates.length === 1 ? candidates[0] : undefined
    return {
      sourceRef: explicitRef ?? source?.sourceRef ?? wikiSynthesisSourceRef({
        evidenceId: claim.evidenceId, sourceRevision: revision ?? 'fixture-unknown-revision', unitId: 'fixture-unknown-unit'
      }),
      statement: claim.statement
    }
  })
  const output = {
    claims,
    unresolvedFacets: answer.unresolvedFacets ?? [],
    observations: answer.observations ?? [],
    recommendations: answer.recommendations ?? ''
  }
  if (request.responseFormat !== undefined) return JSON.stringify(output)
  return [
    `Claims: ${JSON.stringify(output.claims)}`,
    `Unresolved Facets: ${JSON.stringify(output.unresolvedFacets)}`,
    `Observations: ${JSON.stringify(output.observations)}`,
    `Recommendations: ${output.recommendations}`
  ].join('\n')
}
