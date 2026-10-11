import { AxMockAIService, type AxAIService, type AxChatRequest, type AxChatResponse } from '@ax-llm/ax'
import type { DecisionBatchRequest, DecisionBatchResult } from '../../../shared/agents/decision-providers.ts'
import type { DecisionProviderRegistry, DecisionProviderRuntime } from '../../agents/decision-providers.ts'
import { wikiSynthesisSourceRef, type WikiSynthesisProjection, type WikiSynthesisSource } from '../../agents/providers/wiki-synthesis.ts'

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
  async decideBatch(request: DecisionBatchRequest): Promise<DecisionBatchResult> {
    const provider = await fixtureDecisionProviders.selectRuntime()
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
    if (/^User Request: /u.test(content) && content.includes('\n\nSource Structures: ') && content.includes('\n\nSource Bindings: ')) return content
  }
  return undefined
}

const synthesisField = (input: string, title: string): unknown => {
  const start = input.lastIndexOf(`\n\n${title}: `)
  if (start < 0) throw new Error(`Missing supplied synthesis ${title} field`)
  const value = input.slice(start + title.length + 4)
  const end = value.search(/\n\n(?:Source Bindings|Request Facets|Available Observations|Repair Feedback): /u)
  return JSON.parse(end < 0 ? value : value.slice(0, end))
}

interface ReadableSourceRow {
  readonly context: string
  readonly kind: string
  readonly complete: boolean
  readonly literalStatementName: string | null
  readonly packet?: unknown
  readonly authoredContentNames?: readonly string[]
}

interface ReadableSources {
  readonly sources: Record<string, ReadableSourceRow>
  readonly authoredContent: Record<string, { text: string }>
  readonly quotations: Record<string, { literalStatement: string }>
}

const synthesisStructures = (input: string): ReadableSources =>
  synthesisField(input, 'Source Structures') as ReadableSources

const synthesisSourceRows = (input: string): { evidenceId: string; sourceRevision: string; projection: WikiSynthesisProjection; row: ReadableSourceRow }[] => {
  const bindings = synthesisField(input, 'Source Bindings')
  const structures = synthesisStructures(input)
  if (!Array.isArray(bindings)) throw new Error('Supplied synthesis bindings are not an array')
  return bindings.flatMap((binding: unknown) => {
    if (!Array.isArray(binding) || binding.length !== 3 || typeof binding[0] !== 'string' || typeof binding[1] !== 'string' || !Array.isArray(binding[2]))
      throw new Error('Invalid supplied synthesis binding group')
    return binding[2].flatMap((entry: unknown) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Array.isArray(entry[1]))
        throw new Error('Invalid supplied synthesis binding entry')
      const row = structures.sources[entry[0]]
      if (row === undefined) throw new Error('Missing supplied synthesis source row')
      return entry[1].map((value: unknown) => {
        if (value === null || typeof value !== 'object' || !('sourceRef' in value) || typeof value.sourceRef !== 'string' ||
          !('text' in value) || typeof value.text !== 'string')
          throw new Error('Invalid supplied synthesis projection')
        // The fixture reads the encoder's original selected projection fields.
        const projection = value as WikiSynthesisProjection
        return { evidenceId: binding[0] as string, sourceRevision: binding[1] as string, projection, row }
      })
    })
  })
}

export type SynthesisFixtureSource = Omit<WikiSynthesisSource, 'unitId'> & { readonly sourceRef: string }

export const synthesisSourcesFromRequest = (request: Readonly<AxChatRequest>): SynthesisFixtureSource[] => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined) return []
  const structures = synthesisStructures(input)
  return synthesisSourceRows(input).map(({ evidenceId, sourceRevision, projection, row }) => {
    const literalStatement = row.literalStatementName === null ? null : structures.quotations[row.literalStatementName]?.literalStatement
    if (literalStatement === undefined) throw new Error('Missing supplied synthesis quotation')
    const packet = row.authoredContentNames === undefined ? row.packet : {
      structuralLabel: projection.structuralLabel ?? null, labels: projection.labels ?? [],
      authoredContent: authoredContentForRow(structures, row)
    }
    return {
      evidenceId, sourceRevision, sourceRef: projection.sourceRef,
      context: row.context, text: projection.text, kind: row.kind, complete: row.complete,
      packet: JSON.stringify(packet), literalStatement
    }
  })
}

const authoredContentForRow = (structures: ReadableSources, row: ReadableSourceRow): string[] =>
  (row.authoredContentNames ?? []).map(name => {
    const content = structures.authoredContent[name]
    if (content === undefined) throw new Error('Missing supplied synthesis authored content')
    return content.text
  })

export const synthesisAuthoredContentFromRequest = (
  request: Readonly<AxChatRequest>,
  source: WikiSynthesisSource | SynthesisFixtureSource
): string[] => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined) return []
  const selected = synthesisSourceRows(input).find(entry =>
    entry.evidenceId === source.evidenceId && entry.sourceRevision === source.sourceRevision &&
    entry.projection.sourceRef === ('sourceRef' in source ? source.sourceRef : wikiSynthesisSourceRef(source))
  )
  if (selected === undefined) return []
  return authoredContentForRow(synthesisStructures(input), selected.row)
}

export const synthesisOwnedPacketIncludes = (
  request: Readonly<AxChatRequest>,
  source: WikiSynthesisSource | SynthesisFixtureSource,
  literal: string
): boolean => [
  source.context, source.text, ...(source.literalStatement === null ? [] : [source.literalStatement]),
  ...synthesisAuthoredContentFromRequest(request, source)
].some(text => text.includes(literal))

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

export type SynthesisFixtureBindings = Readonly<Record<string, number | { readonly text?: string; readonly context?: string }>>

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
        candidates = candidates.filter(source => source.kind !== 'heading')
    }
    const binding = options.bindings?.[claim.evidenceId]
    if (explicitRef === undefined && binding !== undefined) {
      candidates = typeof binding === 'number'
        ? candidates.slice(binding, binding + 1)
        : candidates.filter(source => (binding.text === undefined || source.text === binding.text) && (binding.context === undefined || source.context === binding.context))
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
