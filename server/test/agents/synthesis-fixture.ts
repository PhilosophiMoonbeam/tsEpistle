import { AxMockAIService, type AxAIService, type AxChatRequest, type AxChatResponse } from '@ax-llm/ax'
import type { DecisionBatchRequest, DecisionBatchResult } from '../../../shared/agents/decision-providers.ts'
import type { DecisionProviderRegistry, DecisionProviderRuntime } from '../../agents/decision-providers.ts'
import { wikiSynthesisSourceRef, type WikiSynthesisSource } from '../../agents/providers/wiki-synthesis.ts'

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

type TextRef = number | [poolKey: number, start: number, endExclusive: number]
type SourceRow = [
  context: TextRef, kind: string, complete: boolean, selectedText: TextRef,
  literalStatement: TextRef | null, authoredTexts: TextRef[] | null,
  structuralLabel: TextRef | null, labels: TextRef[], opaquePacket?: TextRef
]

interface ReadableSourceRow {
  readonly context: string
  readonly kind: string
  readonly complete: boolean
  readonly text: string
  readonly literalStatement: string | null
  readonly packet?: string
  readonly authoredTexts?: readonly string[]
  readonly structuralLabel: string | null
  readonly labels: readonly string[]
}

interface ReadableSources {
  readonly texts: Readonly<Record<number, string>>
  readonly sources: Readonly<Record<number, SourceRow>>
}

const synthesisStructures = (input: string): ReadableSources => {
  const structures = synthesisField(input, 'Source Structures') as ReadableSources
  if (structures === null || typeof structures !== 'object' ||
    structures.texts === null || typeof structures.texts !== 'object' || Array.isArray(structures.texts) ||
    structures.sources === null || typeof structures.sources !== 'object' || Array.isArray(structures.sources))
    throw new Error('Supplied synthesis structures must contain text and source dictionaries')
  return structures
}

const suppliedText = (structures: ReadableSources, reference: TextRef): string => {
  const key = typeof reference === 'number' ? reference : reference[0]
  const text = structures.texts[key]
  if (text === undefined) throw new Error('Missing supplied synthesis text')
  if (typeof reference === 'number') return text
  const [, start, end] = reference
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length)
    throw new Error('Invalid supplied synthesis text span')
  return text.slice(start, end)
}

const synthesisSourceRows = (input: string): { evidenceId: string; sourceRevision: string; sourceRef: string; row: ReadableSourceRow }[] => {
  const bindings = synthesisField(input, 'Source Bindings')
  const structures = synthesisStructures(input)
  const text = (reference: TextRef): string => suppliedText(structures, reference)
  if (!Array.isArray(bindings)) throw new Error('Supplied synthesis bindings are not an array')
  return bindings.flatMap((binding: unknown) => {
    if (!Array.isArray(binding) || binding.length !== 3 || typeof binding[0] !== 'string' || typeof binding[1] !== 'string' || !Array.isArray(binding[2]))
      throw new Error('Invalid supplied synthesis binding group')
    return binding[2].flatMap((entry: unknown) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'number' || !Number.isSafeInteger(entry[0]) || !Array.isArray(entry[1]))
        throw new Error('Invalid supplied synthesis binding entry')
      const tuple = structures.sources[entry[0]]
      if (tuple === undefined) throw new Error('Missing supplied synthesis source row')
      const row: ReadableSourceRow = {
        context: text(tuple[0]), kind: tuple[1], complete: tuple[2], text: text(tuple[3]),
        literalStatement: tuple[4] === null ? null : text(tuple[4]),
        ...(tuple[5] === null ? { packet: text(tuple[8]!) } : { authoredTexts: tuple[5].map(text) }),
        structuralLabel: tuple[6] === null ? null : text(tuple[6]), labels: tuple[7].map(text)
      }
      return entry[1].map((value: unknown) => {
        if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string')
          throw new Error('Invalid supplied synthesis projection')
        return { evidenceId: binding[0] as string, sourceRevision: binding[1] as string, sourceRef: value[0], row }
      })
    })
  })
}

export type SynthesisFixtureSource = Omit<WikiSynthesisSource, 'unitId'> & { readonly sourceRef: string }

export const synthesisSourcesFromRequest = (request: Readonly<AxChatRequest>): SynthesisFixtureSource[] => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined) return []
  return synthesisSourceRows(input).map(({ evidenceId, sourceRevision, sourceRef, row }) => {
    const packet = row.authoredTexts === undefined ? row.packet! : JSON.stringify({
      structuralLabel: row.structuralLabel, labels: row.labels, authoredContent: row.authoredTexts
    })
    return {
      evidenceId, sourceRevision, sourceRef,
      context: row.context, text: row.text, kind: row.kind, complete: row.complete,
      packet, literalStatement: row.literalStatement
    }
  })
}

export const synthesisAuthoredContentFromRequest = (
  request: Readonly<AxChatRequest>,
  source: WikiSynthesisSource | SynthesisFixtureSource
): string[] => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined) return []
  const selected = synthesisSourceRows(input).find(entry =>
    entry.evidenceId === source.evidenceId && entry.sourceRevision === source.sourceRevision &&
    entry.sourceRef === ('sourceRef' in source ? source.sourceRef : wikiSynthesisSourceRef(source))
  )
  if (selected === undefined) return []
  return [...(selected.row.authoredTexts ?? [])]
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
