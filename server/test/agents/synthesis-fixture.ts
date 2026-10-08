import { AxMockAIService, type AxAIService, type AxChatRequest, type AxChatResponse } from '@ax-llm/ax'
import type { WikiSynthesisSource } from '../../agents/providers/wiki-synthesis.ts'

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
  const properties = request.responseFormat?.schema?.properties
  const typedStage = properties?.claims !== undefined && properties?.unresolvedFacets !== undefined && properties?.observations !== undefined ||
    request.chatPrompt.some(message => message.role === 'system' && message.content.includes('final tool-free typed synthesis step'))
  if (!typedStage) return undefined
  for (const message of [...request.chatPrompt].reverse()) {
    if (message.role !== 'user') continue
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    if (/^User Request: /u.test(content)) return content
  }
  return undefined
}

const synthesisField = (input: string, title: string): unknown => {
  const start = input.lastIndexOf(`\n\n${title}: `)
  if (start < 0) throw new Error(`Missing supplied synthesis ${title} field`)
  const value = input.slice(start + title.length + 4)
  const end = value.search(/\n\n(?:Source Units|Request Facets|Available Observations|Repair Feedback): /u)
  return JSON.parse(end < 0 ? value : value.slice(0, end))
}

export const synthesisSourcesFromRequest = (request: Readonly<AxChatRequest>): WikiSynthesisSource[] => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined || !input.includes('\n\nSource Units: ')) return []
  const sources: unknown = synthesisField(input, 'Source Units')
  if (!Array.isArray(sources)) throw new Error('Supplied Source Units field is not an array')
  return sources as WikiSynthesisSource[]
}

export const synthesisOwnedPacketIncludes = (
  request: Readonly<AxChatRequest>,
  source: WikiSynthesisSource,
  literal: string
): boolean => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined || !input.includes('\n\nSource Structures: ')) return false
  const packet: unknown = JSON.parse(source.packet)
  if (typeof packet !== 'object' || packet === null || !('closure' in packet)) return false
  const closure = packet.closure
  if (typeof closure !== 'object' || closure === null) return false
  const keys = new Set<string>()
  for (const [name, value] of Object.entries(closure)) {
    if (name === 'recordKey' && typeof value === 'string') keys.add(value)
    if (['contextKeys', 'relatedUnitKeys', 'linkKeys'].includes(name) && Array.isArray(value))
      for (const key of value) if (typeof key === 'string') keys.add(key)
  }
  const structures = synthesisField(input, 'Source Structures')
  if (!Array.isArray(structures)) throw new Error('Supplied Source Structures field is not an array')
  return structures.some((entry: unknown) =>
    typeof entry === 'object' && entry !== null &&
    'id' in entry && typeof entry.id === 'string' && keys.has(entry.id) &&
    'payload' in entry && typeof entry.payload === 'string' && entry.payload.includes(literal)
  )
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
    message.content.includes('strict text tool protocol') &&
    /"name"\s*:\s*"wiki_finish_collection"/u.test(message.content)
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
    let candidates = sources.filter(source => source.evidenceId === claim.evidenceId && (claim.unitId === undefined || source.unitId === claim.unitId))
    if (claim.unitId === undefined) {
      const titleAssertion = /^(?:(?:The\s+)?(?:(?:current|this)\s+)?page(?:'s)?\s+(?:is\s+(?:titled|named|called)|(?:title|name)\s+is)|(?:Title|Page\s+title)\s*:)/iu.test(claim.statement)
      candidates = candidates.filter(source => (source.kind === 'page-title') === titleAssertion)
      if (!titleAssertion && (options.bindings?.[claim.evidenceId] === undefined || typeof options.bindings[claim.evidenceId] === 'number'))
        candidates = candidates.filter(source => source.kind !== 'heading')
    }
    const binding = options.bindings?.[claim.evidenceId]
    if (claim.unitId === undefined && binding !== undefined) {
      candidates = typeof binding === 'number'
        ? candidates.slice(binding, binding + 1)
        : candidates.filter(source => (binding.text === undefined || source.text === binding.text) && (binding.context === undefined || source.context === binding.context))
    }
    if (candidates.length > 1 && (claim.sourceRevision === undefined || claim.unitId === undefined))
      throw new Error(`Select an explicit source unit for fixture citation ${claim.evidenceId}`)
    const source = candidates.length === 1 ? candidates[0] : undefined
    return {
      evidenceId: claim.evidenceId,
      sourceRevision: claim.sourceRevision ?? source?.sourceRevision ?? /:revision:([^:]+)/u.exec(claim.evidenceId)?.[1] ?? 'fixture-unknown-revision',
      unitId: claim.unitId ?? source?.unitId ?? 'fixture-unknown-unit',
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
