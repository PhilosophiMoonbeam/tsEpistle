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

const textReferenceKeys: Readonly<Record<string, true>> = { textKey: true, prefix: true, suffix: true }

const synthesisText = (value: unknown, structures: readonly unknown[]): string => {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || !('textKey' in value) || typeof value.textKey !== 'string' ||
    Object.keys(value).some(key => textReferenceKeys[key] !== true) ||
    ('prefix' in value && typeof value.prefix !== 'string') || ('suffix' in value && typeof value.suffix !== 'string'))
    throw new Error('Invalid supplied synthesis text reference')
  const entry = structures.find(row => Array.isArray(row) && row[0] === value.textKey && row[1] === 'text')
  if (!Array.isArray(entry)) throw new Error('Missing supplied synthesis text data')
  const encoded: unknown = entry[2]
  let text: string
  if (typeof encoded === 'string') text = encoded
  else if (Array.isArray(encoded) && encoded.length === 3 && typeof encoded[0] === 'string' &&
    typeof encoded[1] === 'number' && Number.isSafeInteger(encoded[1]) && encoded[1] > 0 && typeof encoded[2] === 'string')
    text = encoded[0].repeat(encoded[1]) + encoded[2]
  else throw new Error('Invalid supplied synthesis text data')
  return `${'prefix' in value ? value.prefix : ''}${text}${'suffix' in value ? value.suffix : ''}`
}

const synthesisIdentifier = (value: unknown, structures: readonly unknown[]): unknown => {
  if (typeof value !== 'number') return value
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid synthesis identifier reference')
  const entry = structures.find(row => Array.isArray(row) && row[0] === `s${value}` && row[1] === 'identifier')
  if (!Array.isArray(entry) || typeof entry[2] !== 'string') throw new Error('Missing synthesis identifier data')
  return entry[2]
}

const synthesisPacket = (packet: unknown, structures: readonly unknown[]): unknown => {
  if (!Array.isArray(packet) || packet.length !== 5 || !Array.isArray(packet[4])) return packet
  return [
    synthesisIdentifier(packet[0], structures), packet[1],
    Array.isArray(packet[2]) ? packet[2].map(value => synthesisIdentifier(value, structures)) : packet[2],
    packet[3], [synthesisIdentifier(packet[4][0], structures), ...packet[4].slice(1).map(value => typeof value === 'number' ? `s${value}` : value)]
  ]
}

export const synthesisSourcesFromRequest = (request: Readonly<AxChatRequest>): WikiSynthesisSource[] => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined || !input.includes('\n\nSource Bindings: ')) return []
  const bindings = synthesisField(input, 'Source Bindings')
  const structures = synthesisField(input, 'Source Structures')
  if (!Array.isArray(bindings) || !Array.isArray(structures)) throw new Error('Supplied synthesis source transport is not arrays')
  const sourceData = new Map<string, unknown>()
  for (const entry of structures)
    if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] === 'source')
      sourceData.set(entry[0], entry[2])
  return bindings.flatMap((binding: unknown): WikiSynthesisSource[] => {
    if (!Array.isArray(binding) || binding.length !== 3 || typeof binding[0] !== 'string' || typeof binding[1] !== 'string' || !Array.isArray(binding[2]))
      throw new Error('Invalid supplied synthesis binding group')
    return binding[2].flatMap((entry: unknown): WikiSynthesisSource[] => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Array.isArray(entry[1]))
        throw new Error('Invalid supplied synthesis binding entry')
      const data = sourceData.get(entry[0])
      if (!Array.isArray(data) || data.length !== 5 ||
        typeof data[2] !== 'string' || typeof data[3] !== 'boolean' || data[4] === undefined)
        throw new Error('Missing supplied synthesis source data')
      const source = {
        evidenceId: binding[0], sourceRevision: binding[1],
        context: synthesisText(data[0], structures), text: synthesisText(data[1], structures),
        kind: data[2], complete: data[3], packet: JSON.stringify(synthesisPacket(data[4], structures))
      }
      return entry[1].flatMap((reference: unknown): WikiSynthesisSource | WikiSynthesisSource[] => {
        if (typeof reference === 'string') return { ...source, unitId: reference }
        if (!Array.isArray(reference) || reference.length !== 3 || typeof reference[0] !== 'string' ||
          typeof reference[1] !== 'number' || !Number.isSafeInteger(reference[1]) ||
          typeof reference[2] !== 'number' || !Number.isSafeInteger(reference[2]) || reference[2] < 1 ||
          !Number.isSafeInteger(reference[1] + reference[2] - 1))
          throw new Error('Invalid supplied synthesis unit range')
        return Array.from({ length: reference[2] }, (_, index) => ({ ...source, unitId: `${reference[0]}${reference[1] + index}` }))
      })
    })
  })
}

export const synthesisOwnedPacketIncludes = (
  request: Readonly<AxChatRequest>,
  source: WikiSynthesisSource,
  literal: string
): boolean => {
  const input = synthesisInputFromRequest(request)
  if (input === undefined || !input.includes('\n\nSource Structures: ')) return false
  const packet: unknown = JSON.parse(source.packet)
  if (!Array.isArray(packet) || !Array.isArray(packet[4])) return false
  const structures = synthesisField(input, 'Source Structures')
  if (!Array.isArray(structures)) throw new Error('Supplied Source Structures field is not an array')
  const closureKey = packet[4][1]
  const closure = structures.find(entry => Array.isArray(entry) && entry[0] === closureKey && entry[1] === 'closure')?.[2]
  if (!Array.isArray(closure)) return false
  const keys = new Set<string>()
  if (typeof closure[0] === 'string') keys.add(closure[0])
  else if (typeof closure[0] === 'number') keys.add(`s${closure[0]}`)
  for (const dependencies of closure.slice(1))
    if (Array.isArray(dependencies))
      for (const key of dependencies) {
        if (typeof key === 'string') keys.add(key)
        else if (typeof key === 'number') keys.add(`s${key}`)
      }
  const expandText = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expandText)
    if (typeof value === 'object' && value !== null && 'textKey' in value && Object.keys(value).every(key => textReferenceKeys[key] === true))
      return synthesisText(value, structures)
    return value
  }
  return structures.some((entry: unknown) =>
    Array.isArray(entry) && typeof entry[0] === 'string' && keys.has(entry[0]) &&
    JSON.stringify(expandText(entry[2]))?.includes(literal) === true
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
