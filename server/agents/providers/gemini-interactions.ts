import type { AxAIService, AxAIServiceOptions, AxChatRequest, AxChatResponse, AxChatResponseResult } from '@ax-llm/ax'
import { z } from 'zod'
import type { AgentGoogleSearchCitation, AgentGoogleSearchGrounding } from '../../../shared/agents/contracts.ts'

import { canonicalJson } from '../../helpers/canonical-json.ts'
import { AgentRepositoryError } from '../repository.ts'
import type { AgentProviderFetch } from './factory.ts'

const MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024
const MAX_EVENT_BYTES = 1 * 1_024 * 1_024
const MAX_STATE_BYTES = 256 * 1_024
const MAX_STEPS = 2_000
const MAX_TEXT_CHARACTERS = 1_000_000
const MAX_SEARCH_QUERIES = 16
const MAX_SEARCH_QUERY_CHARACTERS = 2_048
const MAX_SEARCH_SUGGESTIONS = 8
const MAX_SEARCH_SUGGESTION_CHARACTERS = 32_768
const MAX_SEARCH_SUGGESTIONS_BYTES = 128 * 1_024
const MAX_GROUNDING_CITATIONS = 32
const MAX_CITATION_URL_CHARACTERS = 2_048
const MAX_CITATION_TITLE_CHARACTERS = 512
const STATE_PREFIX = 'wiki.gemini.interactions.v1:'
export const isGeminiInteractionsModel = (model: string): boolean => /^gemini-3(?:\.[0-9]+)?(?:-[a-z0-9][a-z0-9._-]*)?$/u.test(model)

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}
const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(value => !containsControlCharacter(value), 'identifier contains a control character')
// Google intentionally leaves the interaction ID empty when store:false.
// Tool call IDs still require the nonempty IdentifierSchema above.
const InteractionIdentifierSchema = z
  .string()
  .max(256)
  .refine(value => !containsControlCharacter(value), 'identifier contains a control character')
const ToolNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const JsonObjectSchema = z.record(z.string(), z.unknown())
const SignatureSchema = z.string().min(1).max(MAX_STATE_BYTES)
const UrlCitationSchema = z.strictObject({
  type: z.literal('url_citation'),
  start_index: z.number().int(),
  end_index: z.number().int(),
  url: z.string(),
  title: z.string()
})
const TextContentSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().max(MAX_TEXT_CHARACTERS),
  annotations: z.array(UrlCitationSchema).max(MAX_GROUNDING_CITATIONS).optional()
})
const ModelOutputStepSchema = z.strictObject({
  type: z.literal('model_output'),
  content: z.array(TextContentSchema).max(MAX_STEPS).optional()
})
const FunctionCallStepSchema = z.strictObject({
  type: z.literal('function_call'),
  id: IdentifierSchema,
  name: ToolNameSchema,
  arguments: JsonObjectSchema,
  signature: SignatureSchema.optional()
})
const GoogleSearchCallStepSchema = z.strictObject({
  type: z.literal('google_search_call'),
  id: IdentifierSchema,
  signature: SignatureSchema,
  arguments: z.strictObject({
    queries: z.array(z.string().min(1).max(MAX_SEARCH_QUERY_CHARACTERS)).min(1).max(MAX_SEARCH_QUERIES)
  }),
  search_type: z.literal('web_search')
})
const GoogleSearchResultItemSchema = z.strictObject({
  search_suggestions: z.string().optional()
})
const GoogleSearchResultStepSchema = z.strictObject({
  type: z.literal('google_search_result'),
  call_id: IdentifierSchema,
  signature: SignatureSchema,
  result: z.array(GoogleSearchResultItemSchema).max(MAX_SEARCH_SUGGESTIONS),
  is_error: z.boolean()
})
const ThoughtStepSchema = z.strictObject({
  type: z.literal('thought'),
  signature: SignatureSchema.optional(),
  summary: z.array(TextContentSchema).max(64).optional()
})
const OutputStepSchema = z.discriminatedUnion('type', [
  ModelOutputStepSchema,
  FunctionCallStepSchema,
  GoogleSearchCallStepSchema,
  GoogleSearchResultStepSchema,
  ThoughtStepSchema
])
const OutputStepsSchema = z.array(OutputStepSchema).max(MAX_STEPS)
const UserInputStepSchema = z.strictObject({ type: z.literal('user_input'), content: z.array(TextContentSchema).max(MAX_STEPS) })
const FunctionResultStepSchema = z.strictObject({
  type: z.literal('function_result'),
  name: ToolNameSchema,
  call_id: IdentifierSchema,
  result: z.array(TextContentSchema).max(MAX_STEPS),
  is_error: z.boolean().optional(),
  signature: SignatureSchema.optional()
})
const NativeStepSchema = z.discriminatedUnion('type', [
  ModelOutputStepSchema,
  FunctionCallStepSchema,
  GoogleSearchCallStepSchema,
  GoogleSearchResultStepSchema,
  ThoughtStepSchema,
  UserInputStepSchema,
  FunctionResultStepSchema
])
const NativeStepsSchema = z.array(NativeStepSchema).max(MAX_STEPS)
const ModalityTokenCountsSchema = z.array(z.object({ modality: z.string().min(1).max(32), tokens: z.number().int().nonnegative() })).max(16)
const ModelInvocationTokenCountsSchema = z
  .array(
    z.object({
      prompt_tokens_details: ModalityTokenCountsSchema.optional(),
      candidates_tokens_details: ModalityTokenCountsSchema.optional(),
      thoughts_tokens_details: ModalityTokenCountsSchema.optional()
    })
  )
  .max(64)
const UsageSchema = z
  .strictObject({
    total_input_tokens: z.number().int().nonnegative(),
    total_output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    total_thought_tokens: z.number().int().nonnegative().optional(),
    total_tool_use_tokens: z.number().int().nonnegative().optional(),
    total_cached_tokens: z.number().int().nonnegative().optional(),
    input_tokens_by_modality: z.array(z.unknown()).optional(),
    output_tokens_by_modality: z.array(z.unknown()).optional(),
    cached_tokens_by_modality: z.array(z.unknown()).optional(),
    tool_use_tokens_by_modality: z.array(z.unknown()).optional(),
    grounding_tool_count: z.array(z.unknown()).optional(),
    raw_prompt_token: z.number().int().nonnegative().optional(),
    model_invocation_token_counts: ModelInvocationTokenCountsSchema.optional(),
    non_grounding_model_invocation_token_counts: ModelInvocationTokenCountsSchema.optional()
  })
  .refine(usage => usage.total_tokens >= usage.total_input_tokens + usage.total_output_tokens, 'total token count is inconsistent')
const InteractionSchema = z
  .object({
    id: InteractionIdentifierSchema.optional(),
    model: z.string().min(1).max(255),
    status: z.enum(['completed', 'requires_action', 'incomplete', 'failed', 'cancelled', 'budget_exceeded']),
    steps: OutputStepsSchema,
    usage: UsageSchema
  })
  .passthrough()

type OutputStep = z.infer<typeof OutputStepSchema>
type NativeStep = z.infer<typeof NativeStepSchema>
interface DecodedState {
  readonly steps: readonly NativeStep[]
  readonly assistantStepStart: number
}
type Usage = z.infer<typeof UsageSchema>
type ThoughtBlock = NonNullable<AxChatResponseResult['thoughtBlocks']>[number]

const invalidResponse = (detail: string): AgentRepositoryError => new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', `Gemini Interactions ${detail}`, 502)
const corruptState = (): AgentRepositoryError =>
  new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored Gemini Interactions continuation is invalid', 500)

export interface GeminiGoogleSearchGrounding extends AgentGoogleSearchGrounding {
  readonly searchSuggestions: readonly string[]
}

type GroundingSidecar = { readonly grounding?: GeminiGoogleSearchGrounding; readonly error?: AgentRepositoryError }
const groundingSidecars = new WeakMap<AxChatResponseResult, GroundingSidecar>()

const safeCitationUrl = (value: string): boolean => {
  if (value.length < 1 || value.length > MAX_CITATION_URL_CHARACTERS || containsControlCharacter(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0
  } catch {
    return false
  }
}

const utf16OffsetsForUtf8Boundaries = (text: string, offsets: readonly number[]): ReadonlyMap<number, number> | null => {
  const requested = new Set(offsets)
  const converted = new Map<number, number>()
  let byteOffset = 0
  for (let utf16Offset = 0; utf16Offset < text.length; utf16Offset++) {
    if (requested.has(byteOffset)) converted.set(byteOffset, utf16Offset)
    const first = text.charCodeAt(utf16Offset)
    if (first <= 0x7f) {
      byteOffset += 1
    } else if (first <= 0x7ff) {
      byteOffset += 2
    } else if (first >= 0xd800 && first <= 0xdbff && utf16Offset + 1 < text.length) {
      const second = text.charCodeAt(utf16Offset + 1)
      if (second >= 0xdc00 && second <= 0xdfff) {
        byteOffset += 4
        utf16Offset++
      } else {
        byteOffset += 3
      }
    } else {
      byteOffset += 3
    }
  }
  if (requested.has(byteOffset)) converted.set(byteOffset, text.length)
  return converted.size === requested.size ? converted : null
}

const normalizedNativeSteps = (
  steps: readonly NativeStep[],
  options: Readonly<{ requireFinalSearchCitations?: boolean; presentationStart?: number }> = {}
): { readonly steps: readonly NativeStep[]; readonly groundingSidecar: GroundingSidecar } => {
  const pendingSearchCalls = new Set<string>()
  const completedSearchCalls = new Set<string>()
  let presentationError: AgentRepositoryError | undefined
  const searchSuggestions: string[] = []
  let suggestionBytes = 0
  let successfulSearch = false
  const normalized: NativeStep[] = []
  for (const step of steps) {
    if (step.type === 'google_search_call') {
      if (pendingSearchCalls.has(step.id) || completedSearchCalls.has(step.id)) throw invalidResponse('returned duplicate native search call IDs')
      pendingSearchCalls.add(step.id)
      normalized.push(step)
      continue
    }
    if (step.type !== 'google_search_result') {
      normalized.push(step)
      continue
    }
    if (!pendingSearchCalls.delete(step.call_id) || completedSearchCalls.has(step.call_id)) throw invalidResponse('returned an unmatched native search result')
    completedSearchCalls.add(step.call_id)
    successfulSearch ||= !step.is_error
    normalized.push({
      ...step,
      result: step.result.map(item => {
        const suggestion = item.search_suggestions
        if (suggestion !== undefined && suggestion.length > 0) {
          const bytes = Buffer.byteLength(suggestion, 'utf8')
          if (
            suggestion.length > MAX_SEARCH_SUGGESTION_CHARACTERS ||
            bytes > MAX_SEARCH_SUGGESTIONS_BYTES ||
            searchSuggestions.length >= MAX_SEARCH_SUGGESTIONS ||
            suggestionBytes > MAX_SEARCH_SUGGESTIONS_BYTES - bytes
          ) {
            presentationError ??= invalidResponse('returned oversized search suggestions')
          } else {
            searchSuggestions.push(suggestion)
            suggestionBytes += bytes
          }
        }
        return {}
      })
    })
  }
  if (pendingSearchCalls.size > 0) throw invalidResponse('returned an incomplete native search call')

  try {
    if (presentationError) throw presentationError
    const citations: AgentGoogleSearchCitation[] = []
    let outputOffset = 0
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
      const step = steps[stepIndex]!
      const visible = stepIndex >= (options.presentationStart ?? 0)
      if (step.type !== 'model_output') continue
      for (const content of step.content ?? []) {
        const annotations = content.annotations ?? []
        const offsets =
          annotations.length === 0
            ? undefined
            : utf16OffsetsForUtf8Boundaries(
                content.text,
                annotations.flatMap(annotation => [annotation.start_index, annotation.end_index])
              )
        if (offsets === null) throw invalidResponse('returned Google Search annotations outside UTF-8 boundaries')
        for (const annotation of annotations) {
          const startIndex = offsets?.get(annotation.start_index)
          const endIndex = offsets?.get(annotation.end_index)
          if (
            (visible && citations.length >= MAX_GROUNDING_CITATIONS) ||
            annotation.start_index < 0 ||
            annotation.end_index <= annotation.start_index ||
            startIndex === undefined ||
            endIndex === undefined ||
            outputOffset > 10_000_000 - endIndex ||
            annotation.title.trim().length === 0 ||
            annotation.title.length > MAX_CITATION_TITLE_CHARACTERS ||
            containsControlCharacter(annotation.title) ||
            !safeCitationUrl(annotation.url)
          )
            throw invalidResponse('returned invalid Google Search annotations')
          if (visible)
            citations.push({
              url: annotation.url,
              title: annotation.title,
              startIndex: outputOffset + startIndex,
              endIndex: outputOffset + endIndex
            })
        }
        if (visible) outputOffset += content.text.length
      }
    }
    if (options.requireFinalSearchCitations === true && successfulSearch && citations.length === 0) throw invalidResponse('omitted Google Search annotations')
    return {
      steps: normalized,
      groundingSidecar:
        completedSearchCalls.size === 0 && citations.length === 0
          ? {}
          : {
              grounding: Object.freeze({
                citations: Object.freeze(citations),
                searchSuggestions: Object.freeze(searchSuggestions)
              })
            }
    }
  } catch (error) {
    return {
      steps: normalized,
      groundingSidecar: {
        error: error instanceof AgentRepositoryError ? error : invalidResponse('returned invalid Google Search annotations')
      }
    }
  }
}

export const readGeminiGoogleSearchGrounding = (result: AxChatResponseResult): GeminiGoogleSearchGrounding | undefined => {
  const sidecar = groundingSidecars.get(result)
  if (sidecar?.error) throw sidecar.error
  return sidecar?.grounding
}

const encodedState = (steps: readonly NativeStep[], assistantStepStart = 0): ThoughtBlock => {
  const payload = assistantStepStart === 0 ? steps : { steps, assistantStepStart }
  const data = `${STATE_PREFIX}${canonicalJson(payload)}`
  if (Buffer.byteLength(data, 'utf8') > MAX_STATE_BYTES) throw invalidResponse('continuation state exceeds the byte limit')
  return { data, encrypted: true }
}

const decodeState = (block: ThoughtBlock, source: 'provider' | 'stored'): DecodedState => {
  const fail = (): never => {
    throw source === 'provider' ? invalidResponse('returned invalid continuation state') : corruptState()
  }
  if (
    block.encrypted !== true ||
    block.signature !== undefined ||
    typeof block.data !== 'string' ||
    !block.data.startsWith(STATE_PREFIX) ||
    Buffer.byteLength(block.data, 'utf8') > MAX_STATE_BYTES
  )
    fail()
  let value: unknown
  try {
    value = JSON.parse(block.data.slice(STATE_PREFIX.length))
  } catch {
    fail()
  }
  const legacy = NativeStepsSchema.safeParse(value)
  const envelope = z
    .strictObject({
      steps: NativeStepsSchema,
      assistantStepStart: z.number().int().nonnegative().max(MAX_STEPS)
    })
    .safeParse(value)
  let steps: readonly NativeStep[]
  let assistantStepStart: number
  if (legacy.success) {
    steps = legacy.data
    assistantStepStart = 0
  } else {
    if (!envelope.success) return fail()
    steps = envelope.data.steps
    assistantStepStart = envelope.data.assistantStepStart
  }
  const native = normalizedNativeSteps(steps, { presentationStart: assistantStepStart })
  if (assistantStepStart > steps.length || native.groundingSidecar.error || canonicalJson(native.steps) !== canonicalJson(steps)) return fail()
  return { steps, assistantStepStart }
}
export const isGeminiInteractionContinuation = (block: ThoughtBlock): boolean => {
  try {
    decodeState(block, 'provider')
    return true
  } catch {
    return false
  }
}

export const preserveGeminiInteractionState = (block: ThoughtBlock): ThoughtBlock => {
  decodeState(block, 'provider')
  return { data: block.data, encrypted: true }
}

const stepText = (steps: readonly NativeStep[]): string =>
  steps
    .flatMap(step => (step.type === 'model_output' ? (step.content ?? []) : []))
    .map(content => content.text)
    .join('')
const stepCalls = (steps: readonly NativeStep[]): readonly z.infer<typeof FunctionCallStepSchema>[] =>
  steps.flatMap(step => (step.type === 'function_call' ? [step] : []))

const assertAssistantStateMatches = (message: Extract<AxChatRequest['chatPrompt'][number], { role: 'assistant' }>, steps: readonly NativeStep[]): void => {
  if (stepText(steps) !== (message.content ?? '')) throw corruptState()
  const expected = (message.functionCalls ?? []).map(call => ({
    id: call.id,
    name: call.function.name,
    arguments:
      typeof call.function.params === 'string'
        ? (() => {
            try {
              return JSON.parse(call.function.params) as unknown
            } catch {
              throw corruptState()
            }
          })()
        : (call.function.params ?? {})
  }))
  const actual = stepCalls(steps).map(call => ({ id: call.id, name: call.name, arguments: call.arguments }))
  if (canonicalJson(expected) !== canonicalJson(actual)) throw corruptState()
}

const assistantSteps = (message: Extract<AxChatRequest['chatPrompt'][number], { role: 'assistant' }>): readonly NativeStep[] => {
  if (message.thoughtBlocks?.length) {
    if (message.thoughtBlocks.length !== 1) throw corruptState()
    const state = decodeState(message.thoughtBlocks[0]!, 'stored')
    assertAssistantStateMatches(message, state.steps.slice(state.assistantStepStart))
    return state.steps
  }
  const steps: NativeStep[] = []
  for (const call of message.functionCalls ?? []) {
    let argumentsValue: unknown = call.function.params ?? {}
    if (typeof argumentsValue === 'string') {
      try {
        argumentsValue = JSON.parse(argumentsValue)
      } catch {
        throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Gemini Interactions action arguments are not valid JSON', 400)
      }
    }
    const parsed = FunctionCallStepSchema.safeParse({ type: 'function_call', id: call.id, name: call.function.name, arguments: argumentsValue })
    if (!parsed.success) throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Gemini Interactions action call is invalid', 400)
    steps.push(parsed.data)
  }
  if (message.content !== undefined) steps.push({ type: 'model_output', content: [{ type: 'text', text: message.content }] })
  return steps
}

/** Visible prior tool work may be summarized; signatures, thoughts and search widgets may not. */
export const geminiInteractionCompactionPrefix = (
  message: Extract<AxChatRequest['chatPrompt'][number], { role: 'assistant' }>
): readonly Readonly<Record<string, unknown>>[] => {
  if (!message.thoughtBlocks?.length) return []
  if (message.thoughtBlocks.length !== 1) throw corruptState()
  const state = decodeState(message.thoughtBlocks[0]!, 'stored')
  assertAssistantStateMatches(message, state.steps.slice(state.assistantStepStart))
  return state.steps.slice(0, state.assistantStepStart).flatMap((step): Readonly<Record<string, unknown>>[] => {
    if (step.type === 'model_output' || step.type === 'user_input')
      return [{ role: step.type === 'model_output' ? 'assistant' : 'user', content: (step.content ?? []).map(part => part.text).join('') }]
    if (step.type === 'function_call') return [{ role: 'assistant', functionCalls: [{ id: step.id, name: step.name, arguments: step.arguments }] }]
    if (step.type === 'function_result')
      return [{ role: 'tool', callId: step.call_id, name: step.name, result: step.result.map(part => part.text).join(''), isError: step.is_error === true }]
    return []
  })
}

const requestParts = (chatPrompt: Readonly<AxChatRequest<unknown>>['chatPrompt']): { systemInstruction?: string; input: unknown[] } => {
  const system: string[] = []
  const input: unknown[] = []
  const functionNames = new Map<string, string>()
  for (const message of chatPrompt) {
    if (message.role === 'system') {
      system.push(message.content)
      continue
    }
    if (message.role === 'user') {
      const content =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : message.content.map(part => {
              if (part.type === 'text') return { type: 'text', text: part.text }
              if (
                part.type !== 'file' ||
                !('fileUri' in part) ||
                !/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[A-Za-z0-9_-]{1,128}$/u.test(part.fileUri) ||
                !['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(part.mimeType)
              )
                throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Gemini attachments must be validated Files API references', 400)
              return { type: part.mimeType === 'application/pdf' ? 'document' : 'image', uri: part.fileUri, mime_type: part.mimeType }
            })
      input.push({ type: 'user_input', content })
      continue
    }
    if (message.role === 'assistant') {
      const steps = assistantSteps(message)
      for (const call of stepCalls(steps)) functionNames.set(call.id, call.name)
      input.push(...steps)
      continue
    }
    const name = functionNames.get(message.functionId)
    if (!name) throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Gemini Interactions action result has no matching action call', 400)
    input.push({
      type: 'function_result',
      name,
      call_id: message.functionId,
      result: [{ type: 'text', text: message.result }],
      ...(message.isError === true ? { is_error: true } : {})
    })
  }
  if (input.length === 0) throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Gemini Interactions requires at least one input step', 400)
  return { ...(system.length === 0 ? {} : { systemInstruction: system.join('\n\n') }), input }
}

export const combineGeminiInteractionState = (chatPrompt: Readonly<AxChatRequest<unknown>>['chatPrompt'], finalBlock: ThoughtBlock): ThoughtBlock => {
  if (chatPrompt.length === 0) return preserveGeminiInteractionState(finalBlock)
  const priorInput = requestParts(chatPrompt).input
  const prior = NativeStepsSchema.safeParse(priorInput)
  if (!prior.success) throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Gemini Interactions internal continuation is invalid', 400)
  const finalState = decodeState(finalBlock, 'provider')
  const steps = [...prior.data, ...finalState.steps]
  if (steps.length > MAX_STEPS) throw invalidResponse('continuation state exceeds the step limit')
  return encodedState(steps, prior.data.length + finalState.assistantStepStart)
}

const toolChoice = (choice: AxChatRequest['functionCall'], googleSearchEnabled: boolean): unknown => {
  if (choice === undefined || choice === 'auto') return googleSearchEnabled ? 'validated' : 'auto'
  if (choice === 'none') return 'none'
  if (choice === 'required') return 'any'
  return { allowed_tools: { mode: 'any', tools: [choice.function.name] } }
}

const responseFormat = (format: AxChatRequest['responseFormat']): unknown => {
  if (format === undefined) return undefined
  return {
    type: 'text',
    mime_type: 'application/json',
    ...(format.type === 'json_schema' && format.schema !== undefined ? { schema: format.schema } : {})
  }
}

const assertSupportedModelConfig = (config: AxChatRequest['modelConfig']): void => {
  if (!config) return
  if ([config.temperature, config.topP, config.topK, config.presencePenalty, config.frequencyPenalty, config.endSequences].some(value => value !== undefined)) {
    throw new AgentRepositoryError('UNSUPPORTED_PROVIDER_OPTION', 'Gemini Interactions does not support the requested generation option', 400)
  }
}

const usageResponse = (model: string, usage: Usage): NonNullable<AxChatResponse['modelUsage']> => ({
  ai: 'google-gemini-interactions',
  model,
  tokens: {
    promptTokens: usage.total_input_tokens,
    completionTokens: usage.total_output_tokens,
    totalTokens: usage.total_tokens
  }
})

const responseResult = (
  id: string,
  status: z.infer<typeof InteractionSchema>['status'],
  steps: readonly OutputStep[],
  includePresentation = true
): AxChatResponseResult => {
  const native = normalizedNativeSteps(steps, { requireFinalSearchCitations: status === 'completed' })
  const content = stepText(native.steps)
  const calls = stepCalls(native.steps)
  const result: AxChatResponseResult = {
    index: 0,
    ...(id.length === 0 ? {} : { id }),
    ...(includePresentation && content.length > 0 ? { content } : {}),
    ...(!includePresentation || calls.length === 0
      ? {}
      : {
          functionCalls: calls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, params: call.arguments } }))
        }),
    thoughtBlocks: [encodedState(native.steps)],
    finishReason: calls.length > 0 ? 'function_call' : status === 'incomplete' || status === 'budget_exceeded' ? 'length' : 'stop'
  }
  groundingSidecars.set(result, native.groundingSidecar)
  return result
}

const readBoundedResponseBytes = async (response: Response): Promise<Uint8Array | null> => {
  const body = response.body
  if (body === null) return null
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      const value = item.value
      if (!(value instanceof Uint8Array) || chunks.length >= 65_536 || value.byteLength > MAX_RESPONSE_BYTES || total > MAX_RESPONSE_BYTES - value.byteLength) {
        void reader.cancel('Gemini response limit').catch(() => {})
        return null
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch {
    return null
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The response reader is already unusable.
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const bufferedResponse = async (response: Response, expectedModel: string, googleSearchEnabled: boolean): Promise<AxChatResponse> => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw invalidResponse('returned an invalid content type')
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw invalidResponse('response exceeds the byte limit')
  const bytes = await readBoundedResponseBytes(response)
  if (bytes === null) throw invalidResponse('response exceeds the byte limit')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw invalidResponse('response is not valid UTF-8 JSON')
  }
  const parsed = InteractionSchema.safeParse(value)
  if (!parsed.success || parsed.data.model !== expectedModel) throw invalidResponse('response does not match the pinned schema')
  if (parsed.data.status === 'failed' || parsed.data.status === 'cancelled') throw invalidResponse('interaction did not complete successfully')
  if (!googleSearchEnabled && parsed.data.steps.some(step => step.type === 'google_search_call' || step.type === 'google_search_result'))
    throw invalidResponse('returned an unrequested native search step')
  return {
    ...(!parsed.data.id ? {} : { remoteId: parsed.data.id }),
    results: [responseResult(parsed.data.id ?? '', parsed.data.status, parsed.data.steps)],
    modelUsage: usageResponse(expectedModel, parsed.data.usage)
  }
}

const StreamStartStepSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('model_output'), content: z.array(TextContentSchema).max(MAX_STEPS).optional() }),
  z.strictObject({
    type: z.literal('function_call'),
    id: IdentifierSchema,
    name: ToolNameSchema,
    arguments: JsonObjectSchema.optional(),
    signature: SignatureSchema.optional()
  }),
  z.strictObject({ type: z.literal('google_search_call'), id: IdentifierSchema, signature: z.string().max(MAX_STATE_BYTES).optional() }),
  z.strictObject({ type: z.literal('google_search_result'), call_id: IdentifierSchema, signature: z.string().max(MAX_STATE_BYTES).optional() }),
  z.strictObject({
    type: z.literal('thought'),
    signature: z.string().max(MAX_STATE_BYTES).optional(),
    summary: z.array(TextContentSchema).max(64).optional()
  })
])
const CreatedEventSchema = z.strictObject({
  event_type: z.literal('interaction.created'),
  event_id: z.string().optional(),
  interaction: z.object({ id: InteractionIdentifierSchema, model: z.string().min(1).max(255).optional(), status: z.literal('in_progress') }).passthrough()
})
const StatusEventSchema = z.strictObject({
  event_type: z.literal('interaction.status_update'),
  event_id: z.string().optional(),
  interaction_id: InteractionIdentifierSchema,
  status: z.enum(['in_progress', 'requires_action', 'completed', 'incomplete', 'failed', 'cancelled', 'budget_exceeded'])
})
const StartEventSchema = z.strictObject({
  event_type: z.literal('step.start'),
  event_id: z.string().optional(),
  index: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_STEPS - 1),
  step: StreamStartStepSchema
})
const DeltaEventSchema = z.strictObject({
  event_type: z.literal('step.delta'),
  event_id: z.string().optional(),
  index: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_STEPS - 1),
  delta: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), text: z.string().max(MAX_TEXT_CHARACTERS) }),
    z.strictObject({ type: z.literal('text_annotation_delta'), annotations: z.array(UrlCitationSchema).max(MAX_GROUNDING_CITATIONS) }),
    z.strictObject({ type: z.literal('arguments_delta'), arguments: z.string().max(MAX_STATE_BYTES).optional() }),
    z.strictObject({
      type: z.literal('google_search_call'),
      signature: z.string().max(MAX_STATE_BYTES).optional(),
      arguments: GoogleSearchCallStepSchema.shape.arguments.optional(),
      search_type: z.literal('web_search').optional()
    }),
    z.strictObject({
      type: z.literal('google_search_result'),
      signature: z.string().max(MAX_STATE_BYTES).optional(),
      result: z.array(GoogleSearchResultItemSchema).max(MAX_SEARCH_SUGGESTIONS).optional(),
      is_error: z.boolean().optional()
    }),
    z.strictObject({ type: z.literal('thought_signature'), signature: z.string().max(MAX_STATE_BYTES).optional() })
  ])
})
const StopEventSchema = z.strictObject({
  event_type: z.literal('step.stop'),
  event_id: z.string().optional(),
  index: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_STEPS - 1),
  step_usage: UsageSchema.optional()
})
const CompletedEventSchema = z.strictObject({
  event_type: z.literal('interaction.completed'),
  event_id: z.string().optional(),
  interaction: z
    .object({
      id: InteractionIdentifierSchema.optional(),
      model: z.string().min(1).max(255).optional(),
      status: z.enum(['completed', 'requires_action', 'incomplete', 'failed', 'cancelled', 'budget_exceeded']),
      steps: OutputStepsSchema.optional(),
      usage: UsageSchema
    })
    .passthrough()
})
const ErrorEventSchema = z.strictObject({
  event_type: z.literal('error'),
  event_id: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional()
})

interface ActiveStreamStep {
  readonly start: z.infer<typeof StreamStartStepSchema>
  content: z.infer<typeof TextContentSchema>[]
  arguments: string
  searchArguments?: z.infer<typeof GoogleSearchCallStepSchema>['arguments']
  searchType?: 'web_search'
  searchResult?: z.infer<typeof GoogleSearchResultStepSchema>['result']
  searchError?: boolean
  signature: string
  stopped: boolean
}
interface StreamState {
  interactionId: string | null
  readonly expectedModel: string
  readonly googleSearchEnabled: boolean
  readonly active: Map<number, ActiveStreamStep>
  readonly steps: Map<number, OutputStep>
  completed: boolean
  done: boolean
  totalBytes: number
}

const streamedChunk = (state: StreamState, result: AxChatResponseResult, usage?: Usage): AxChatResponse => ({
  ...(state.interactionId === null || state.interactionId.length === 0 ? {} : { remoteId: state.interactionId }),
  results: [result],
  ...(usage === undefined ? {} : { modelUsage: usageResponse(state.expectedModel, usage) })
})

const processStreamEvent = (value: unknown, state: StreamState): readonly AxChatResponse[] => {
  if (typeof value !== 'object' || value === null) throw invalidResponse('stream event is not an object')
  const eventType = Reflect.get(value, 'event_type')
  if (eventType === 'interaction.created') {
    const parsed = CreatedEventSchema.safeParse(value)
    if (
      !parsed.success ||
      state.interactionId !== null ||
      (parsed.data.interaction.model !== undefined && parsed.data.interaction.model !== state.expectedModel)
    )
      throw invalidResponse('stream contains an invalid created event')
    state.interactionId = parsed.data.interaction.id
    return []
  }
  if (state.interactionId === null || state.completed) throw invalidResponse('stream event is out of order')
  if (eventType === 'interaction.status_update') {
    const parsed = StatusEventSchema.safeParse(value)
    if (!parsed.success || parsed.data.interaction_id !== state.interactionId || parsed.data.status === 'failed' || parsed.data.status === 'cancelled')
      throw invalidResponse('stream contains an invalid status event')
    return []
  }
  if (eventType === 'step.start') {
    const parsed = StartEventSchema.safeParse(value)
    if (!parsed.success || state.active.has(parsed.data.index) || state.steps.has(parsed.data.index))
      throw invalidResponse('stream contains an invalid step start')
    if (!state.googleSearchEnabled && (parsed.data.step.type === 'google_search_call' || parsed.data.step.type === 'google_search_result'))
      throw invalidResponse('stream returned an unrequested native search step')
    const start = parsed.data.step
    state.active.set(parsed.data.index, {
      start,
      content: start.type === 'model_output' ? (start.content ?? []).map(content => ({ ...content })) : [],
      arguments: '',
      signature: 'signature' in start ? (start.signature ?? '') : '',
      stopped: false
    })
    if (start.type === 'model_output' && start.content?.length) return start.content.map(content => streamedChunk(state, { index: 0, content: content.text }))
    return []
  }
  if (eventType === 'step.delta') {
    const parsed = DeltaEventSchema.safeParse(value)
    const current = parsed.success ? state.active.get(parsed.data.index) : undefined
    if (!parsed.success || !current || current.stopped) throw invalidResponse('stream contains an invalid step delta')
    const delta = parsed.data.delta
    if (current.start.type === 'model_output' && delta.type === 'text') {
      const last = current.content.at(-1)
      if (last === undefined) current.content.push({ type: 'text', text: delta.text })
      else last.text += delta.text
      if (current.content.reduce((total, content) => total + content.text.length, 0) > MAX_TEXT_CHARACTERS)
        throw invalidResponse('streamed text exceeds the character limit')
      return [streamedChunk(state, { index: 0, content: delta.text })]
    }
    if (current.start.type === 'model_output' && delta.type === 'text_annotation_delta') {
      const last = current.content.at(-1)
      if (last === undefined) throw invalidResponse('streamed annotations preceded their text')
      const annotations = last.annotations ?? []
      if (annotations.length > MAX_GROUNDING_CITATIONS - delta.annotations.length) throw invalidResponse('streamed too many Google Search annotations')
      last.annotations = [...annotations, ...delta.annotations]
      return []
    }
    if (current.start.type === 'function_call' && delta.type === 'arguments_delta') {
      current.arguments += delta.arguments ?? ''
      if (Buffer.byteLength(current.arguments, 'utf8') > MAX_STATE_BYTES) throw invalidResponse('streamed action arguments exceed the byte limit')
      return []
    }
    if (current.start.type === 'google_search_call' && delta.type === 'google_search_call') {
      current.signature += delta.signature ?? ''
      if (Buffer.byteLength(current.signature, 'utf8') > MAX_STATE_BYTES || (current.searchArguments !== undefined && delta.arguments !== undefined))
        throw invalidResponse('streamed invalid native search call metadata')
      if (delta.arguments !== undefined) current.searchArguments = delta.arguments
      current.searchType = delta.search_type ?? current.searchType ?? 'web_search'
      return []
    }
    if (current.start.type === 'google_search_result' && delta.type === 'google_search_result') {
      current.signature += delta.signature ?? ''
      if (
        Buffer.byteLength(current.signature, 'utf8') > MAX_STATE_BYTES ||
        (current.searchResult !== undefined && delta.result !== undefined) ||
        (current.searchError !== undefined && delta.is_error !== undefined)
      )
        throw invalidResponse('streamed invalid native search result metadata')
      if (delta.result !== undefined) current.searchResult = delta.result
      if (delta.is_error !== undefined) current.searchError = delta.is_error
      return []
    }
    if (current.start.type === 'thought' && delta.type === 'thought_signature') {
      current.signature += delta.signature ?? ''
      if (Buffer.byteLength(current.signature, 'utf8') > MAX_STATE_BYTES) throw invalidResponse('streamed thought signature exceeds the byte limit')
      return []
    }
    throw invalidResponse('stream delta does not match its step')
  }
  if (eventType === 'step.stop') {
    const parsed = StopEventSchema.safeParse(value)
    const current = parsed.success ? state.active.get(parsed.data.index) : undefined
    if (!parsed.success || !current || current.stopped) throw invalidResponse('stream contains an invalid step stop')
    current.stopped = true
    let step: OutputStep
    if (current.start.type === 'model_output') {
      step = { type: 'model_output', ...(current.content.length === 0 ? {} : { content: current.content }) }
    } else if (current.start.type === 'thought') {
      step = {
        type: 'thought',
        ...(current.signature.length === 0 ? {} : { signature: current.signature }),
        ...(current.start.summary === undefined ? {} : { summary: current.start.summary })
      }
    } else if (current.start.type === 'google_search_call') {
      const call = GoogleSearchCallStepSchema.safeParse({
        type: 'google_search_call',
        id: current.start.id,
        signature: current.signature,
        arguments: current.searchArguments,
        search_type: current.searchType ?? 'web_search'
      })
      if (!call.success) throw invalidResponse('streamed native search call does not match the pinned schema')
      step = call.data
    } else if (current.start.type === 'google_search_result') {
      const result = GoogleSearchResultStepSchema.safeParse({
        type: 'google_search_result',
        call_id: current.start.call_id,
        signature: current.signature,
        result: current.searchResult,
        is_error: current.searchError
      })
      if (!result.success) throw invalidResponse('streamed native search result does not match the pinned schema')
      step = result.data
    } else {
      let argumentsValue: unknown = current.start.arguments ?? {}
      if (current.arguments.length > 0) {
        try {
          argumentsValue = JSON.parse(current.arguments)
        } catch {
          throw invalidResponse('streamed action arguments are not valid JSON')
        }
      }
      const call = FunctionCallStepSchema.safeParse({
        type: 'function_call',
        id: current.start.id,
        name: current.start.name,
        arguments: argumentsValue,
        ...(current.signature.length === 0 ? {} : { signature: current.signature })
      })
      if (!call.success) throw invalidResponse('streamed action call does not match the pinned schema')
      step = call.data
    }
    state.steps.set(parsed.data.index, step)
    if (step.type !== 'function_call') return []
    return [
      streamedChunk(state, {
        index: 0,
        ...(state.interactionId.length === 0 ? {} : { id: state.interactionId }),
        functionCalls: [{ id: step.id, type: 'function', function: { name: step.name, params: step.arguments } }],
        finishReason: 'function_call'
      })
    ]
  }
  if (eventType === 'interaction.completed') {
    const parsed = CompletedEventSchema.safeParse(value)
    if (
      !parsed.success ||
      (parsed.data.interaction.id ?? '') !== state.interactionId ||
      (parsed.data.interaction.model !== undefined && parsed.data.interaction.model !== state.expectedModel) ||
      parsed.data.interaction.status === 'failed' ||
      parsed.data.interaction.status === 'cancelled'
    )
      throw invalidResponse('stream contains an invalid completed event')
    if ([...state.active.values()].some(step => !step.stopped)) throw invalidResponse('stream completed with an unfinished step')
    const ordered = [...state.steps.entries()].sort(([left], [right]) => left - right)
    if (ordered.some(([index], position) => index !== position)) throw invalidResponse('stream step indexes are not contiguous')
    const steps = ordered.map(([, step]) => step)
    if (parsed.data.interaction.steps !== undefined && canonicalJson(parsed.data.interaction.steps) !== canonicalJson(steps))
      throw invalidResponse('completed stream steps do not match streamed steps')
    state.completed = true
    return [streamedChunk(state, responseResult(state.interactionId, parsed.data.interaction.status, steps, false), parsed.data.interaction.usage)]
  }
  if (eventType === 'error') {
    if (!ErrorEventSchema.safeParse(value).success) throw invalidResponse('stream contains an invalid error event')
    throw invalidResponse('stream reported an error')
  }
  throw invalidResponse('stream contains an unknown event type')
}

const processSseFrame = (frame: string, state: StreamState): readonly AxChatResponse[] => {
  const lines = frame.split('\n')
  if (lines.every(line => line.length === 0 || line.startsWith(':'))) return []
  const eventLines = lines.filter(line => line.startsWith('event:'))
  const dataLines = lines.filter(line => line.startsWith('data:'))
  const invalidLines = lines.filter(line => line.length > 0 && !line.startsWith(':') && !line.startsWith('event:') && !line.startsWith('data:'))
  if (eventLines.length > 1 || dataLines.length === 0 || invalidLines.length > 0) throw invalidResponse('stream contains an invalid SSE frame')
  const event = eventLines[0]?.slice(6).trim() ?? ''
  const data = dataLines.map(line => line.slice(5).trimStart()).join('\n')
  if (data.trim() === '[DONE]') {
    if ((event !== '' && event !== 'done') || !state.completed || state.done) throw invalidResponse('stream has an invalid terminal marker')
    state.done = true
    return []
  }
  if (state.done) throw invalidResponse('stream continued after its terminal marker')
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    throw invalidResponse('stream event data is not valid JSON')
  }
  if (event !== '' && (typeof value !== 'object' || value === null || Reflect.get(value, 'event_type') !== event))
    throw invalidResponse('stream event name does not match its data')
  return processStreamEvent(value, state)
}

const streamingResponse = (response: Response, expectedModel: string, googleSearchEnabled: boolean): ReadableStream<AxChatResponse> => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'text/event-stream' || !response.body) throw invalidResponse('stream response has an invalid content type')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const state: StreamState = {
    interactionId: null,
    expectedModel,
    googleSearchEnabled,
    active: new Map(),
    steps: new Map(),
    completed: false,
    done: false,
    totalBytes: 0
  }
  let buffer = ''
  const process = (controller: TransformStreamDefaultController<AxChatResponse>, flush: boolean): void => {
    buffer = buffer.replace(/\r\n/g, '\n')
    if (Buffer.byteLength(buffer, 'utf8') > MAX_EVENT_BYTES) throw invalidResponse('stream event exceeds the byte limit')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      if (Buffer.byteLength(frame, 'utf8') > MAX_EVENT_BYTES) throw invalidResponse('stream event exceeds the byte limit')
      buffer = buffer.slice(boundary + 2)
      for (const item of processSseFrame(frame, state)) controller.enqueue(item)
      if (Buffer.byteLength(buffer, 'utf8') > MAX_EVENT_BYTES) throw invalidResponse('stream event exceeds the byte limit')
      boundary = buffer.indexOf('\n\n')
    }
    if (flush && buffer.trim().length > 0) {
      if (Buffer.byteLength(buffer, 'utf8') > MAX_EVENT_BYTES) throw invalidResponse('stream event exceeds the byte limit')
      for (const item of processSseFrame(buffer, state)) controller.enqueue(item)
      buffer = ''
    }
  }
  return response.body.pipeThrough(
    new TransformStream<Uint8Array, AxChatResponse>({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) throw invalidResponse('stream chunk is invalid')
        state.totalBytes += chunk.byteLength
        if (state.totalBytes > MAX_RESPONSE_BYTES) throw invalidResponse('stream exceeds the byte limit')
        try {
          buffer += decoder.decode(chunk, { stream: true })
        } catch {
          throw invalidResponse('stream is not valid UTF-8')
        }
        process(controller, false)
      },
      flush(controller) {
        try {
          buffer += decoder.decode()
        } catch {
          throw invalidResponse('stream is not valid UTF-8')
        }
        process(controller, true)
        if (!state.done) throw invalidResponse('stream ended before its terminal marker')
      }
    })
  )
}

export interface GeminiInteractionsServiceOptions {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly fetch: AgentProviderFetch
  readonly timeoutMs: number
  readonly thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
  readonly googleSearchEnabled?: boolean
}

export const createGeminiInteractionsService = (config: GeminiInteractionsServiceOptions): Pick<AxAIService, 'chat'> => ({
  chat: async (request: Readonly<AxChatRequest<unknown>>, options?: Readonly<AxAIServiceOptions>): Promise<AxChatResponse | ReadableStream<AxChatResponse>> => {
    options?.abortSignal?.throwIfAborted()
    assertSupportedModelConfig(request.modelConfig)
    const { systemInstruction, input } = requestParts(request.chatPrompt)
    const stream = options?.stream === true
    const level = config.thinkingLevel
    const functions = request.functions ?? []
    const tools = [
      ...(config.googleSearchEnabled === true ? [{ type: 'google_search' as const }] : []),
      ...functions.map(fn => ({
        type: 'function' as const,
        name: fn.name,
        description: fn.description,
        ...(fn.parameters === undefined
          ? {}
          : {
              // Validated tool combinations require an explicit object root, including object unions.
              parameters: fn.parameters.type === undefined ? { ...fn.parameters, type: 'object' } : fn.parameters
            })
      }))
    ]
    const generationConfig = {
      ...(request.modelConfig?.maxTokens === undefined ? {} : { max_output_tokens: request.modelConfig.maxTokens }),
      ...(request.modelConfig?.stopSequences === undefined ? {} : { stop_sequences: request.modelConfig.stopSequences }),
      ...(level === undefined ? {} : { thinking_level: level }),
      tool_choice: tools.length === 0 ? 'none' : toolChoice(request.functionCall, config.googleSearchEnabled === true),
      thinking_summaries: 'none' as const
    }
    const body = {
      model: config.model,
      store: false,
      stream,
      input,
      ...(systemInstruction === undefined ? {} : { system_instruction: systemInstruction }),
      ...(tools.length === 0 ? {} : { tools }),
      ...(request.responseFormat === undefined ? {} : { response_format: responseFormat(request.responseFormat) }),
      generation_config: generationConfig
    }
    const signals = [AbortSignal.timeout(config.timeoutMs), ...(options?.abortSignal === undefined ? [] : [options.abortSignal])]
    const response = await config.fetch(`${config.baseUrl.replace(/\/$/u, '')}/interactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals)
    })
    return stream
      ? streamingResponse(response, config.model, config.googleSearchEnabled === true)
      : await bufferedResponse(response, config.model, config.googleSearchEnabled === true)
  }
})
