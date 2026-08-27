import type {
  AxAIService,
  AxAIServiceOptions,
  AxChatRequest,
  AxChatResponse,
  AxChatResponseResult
} from '@ax-llm/ax'
import { z } from 'zod'

import { canonicalJson } from '../../helpers/canonical-json.ts'
import { AgentRepositoryError } from '../repository.ts'

const MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024
const MAX_EVENT_BYTES = 1 * 1_024 * 1_024
const MAX_STATE_BYTES = 256 * 1_024
const MAX_STEPS = 2_000
const MAX_TEXT_CHARACTERS = 1_000_000
const STATE_PREFIX = 'wiki.gemini.interactions.v1:'
export const isGeminiInteractionsModel = (model: string): boolean => /^gemini-3(?:\.[0-9]+)?(?:-[a-z0-9][a-z0-9._-]*)?$/u.test(model)

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}
const IdentifierSchema = z.string().min(1).max(256).refine(value => !containsControlCharacter(value), 'identifier contains a control character')
const ToolNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const JsonObjectSchema = z.record(z.string(), z.unknown())
const TextContentSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().max(MAX_TEXT_CHARACTERS)
})
const ModelOutputStepSchema = z.strictObject({
  type: z.literal('model_output'),
  content: z.array(TextContentSchema).max(MAX_STEPS).optional()
})
const FunctionCallStepSchema = z.strictObject({
  type: z.literal('function_call'),
  id: IdentifierSchema,
  name: ToolNameSchema,
  arguments: JsonObjectSchema
})
const ThoughtStepSchema = z.strictObject({
  type: z.literal('thought'),
  signature: z.string().min(1).max(MAX_STATE_BYTES).optional(),
  summary: z.array(TextContentSchema).max(64).optional()
})
const OutputStepSchema = z.discriminatedUnion('type', [ModelOutputStepSchema, FunctionCallStepSchema, ThoughtStepSchema])
const OutputStepsSchema = z.array(OutputStepSchema).max(MAX_STEPS)
const UsageSchema = z.strictObject({
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
  grounding_tool_count: z.array(z.unknown()).optional()
}).refine(usage => usage.total_tokens >= usage.total_input_tokens + usage.total_output_tokens, 'total token count is inconsistent')
const InteractionSchema = z.object({
  id: IdentifierSchema,
  model: z.string().min(1).max(255),
  status: z.enum(['completed', 'requires_action', 'incomplete', 'failed', 'cancelled', 'budget_exceeded']),
  steps: OutputStepsSchema,
  usage: UsageSchema
}).passthrough()

type OutputStep = z.infer<typeof OutputStepSchema>
type Usage = z.infer<typeof UsageSchema>
type ThoughtBlock = NonNullable<AxChatResponseResult['thoughtBlocks']>[number]

const invalidResponse = (detail: string): AgentRepositoryError => new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', `Gemini Interactions ${detail}`, 502)
const corruptState = (): AgentRepositoryError => new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored Gemini Interactions continuation is invalid', 500)

const encodedState = (steps: readonly OutputStep[]): ThoughtBlock => {
  const data = `${STATE_PREFIX}${canonicalJson(steps)}`
  if (Buffer.byteLength(data, 'utf8') > MAX_STATE_BYTES) throw invalidResponse('continuation state exceeds the byte limit')
  return { data, encrypted: true }
}

const decodeState = (block: ThoughtBlock, source: 'provider' | 'stored'): readonly OutputStep[] => {
  const fail = (): never => { throw source === 'provider' ? invalidResponse('returned invalid continuation state') : corruptState() }
  if (!block.encrypted || block.signature !== undefined || typeof block.data !== 'string' || !block.data.startsWith(STATE_PREFIX) || Buffer.byteLength(block.data, 'utf8') > MAX_STATE_BYTES) fail()
  let value: unknown
  try { value = JSON.parse(block.data.slice(STATE_PREFIX.length)) } catch { fail() }
  const parsed = OutputStepsSchema.safeParse(value)
  if (!parsed.success) throw source === 'provider' ? invalidResponse('returned invalid continuation state') : corruptState()
  return parsed.data
}

export const preserveGeminiInteractionState = (block: ThoughtBlock): ThoughtBlock => {
  decodeState(block, 'provider')
  return { data: block.data, encrypted: true }
}

const stepText = (steps: readonly OutputStep[]): string => steps.flatMap(step => step.type === 'model_output' ? step.content ?? [] : []).map(content => content.text).join('')
const stepCalls = (steps: readonly OutputStep[]): readonly z.infer<typeof FunctionCallStepSchema>[] => steps.flatMap(step => step.type === 'function_call' ? [step] : [])

const assertAssistantStateMatches = (message: Extract<AxChatRequest['chatPrompt'][number], { role: 'assistant' }>, steps: readonly OutputStep[]): void => {
  if (stepText(steps) !== (message.content ?? '')) throw corruptState()
  const expected = (message.functionCalls ?? []).map(call => ({
    id: call.id,
    name: call.function.name,
    arguments: typeof call.function.params === 'string' ? (() => {
      try { return JSON.parse(call.function.params) as unknown } catch { throw corruptState() }
    })() : call.function.params ?? {}
  }))
  const actual = stepCalls(steps).map(call => ({ id: call.id, name: call.name, arguments: call.arguments }))
  if (canonicalJson(expected) !== canonicalJson(actual)) throw corruptState()
}

const assistantSteps = (message: Extract<AxChatRequest['chatPrompt'][number], { role: 'assistant' }>): readonly OutputStep[] => {
  if (message.thoughtBlocks?.length) {
    if (message.thoughtBlocks.length !== 1) throw corruptState()
    const steps = decodeState(message.thoughtBlocks[0]!, 'stored')
    assertAssistantStateMatches(message, steps)
    return steps
  }
  const steps: OutputStep[] = []
  for (const call of message.functionCalls ?? []) {
    let argumentsValue: unknown = call.function.params ?? {}
    if (typeof argumentsValue === 'string') {
      try { argumentsValue = JSON.parse(argumentsValue) } catch { throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Gemini Interactions action arguments are not valid JSON', 400) }
    }
    const parsed = FunctionCallStepSchema.safeParse({ type: 'function_call', id: call.id, name: call.function.name, arguments: argumentsValue })
    if (!parsed.success) throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Gemini Interactions action call is invalid', 400)
    steps.push(parsed.data)
  }
  if (message.content !== undefined) steps.push({ type: 'model_output', content: [{ type: 'text', text: message.content }] })
  return steps
}

const requestParts = (request: Readonly<AxChatRequest<unknown>>): { systemInstruction?: string, input: unknown[] } => {
  const system: string[] = []
  const input: unknown[] = []
  const functionNames = new Map<string, string>()
  for (const message of request.chatPrompt) {
    if (message.role === 'system') {
      system.push(message.content)
      continue
    }
    if (message.role === 'user') {
      if (typeof message.content !== 'string') throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Gemini Interactions currently accepts text-only Wiki messages', 400)
      input.push({ type: 'user_input', content: [{ type: 'text', text: message.content }] })
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

const toolChoice = (choice: AxChatRequest['functionCall']): unknown => {
  if (choice === undefined || choice === 'auto') return 'auto'
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

const responseResult = (id: string, status: z.infer<typeof InteractionSchema>['status'], steps: readonly OutputStep[]): AxChatResponseResult => {
  const content = stepText(steps)
  const calls = stepCalls(steps)
  return {
    index: 0,
    id,
    ...(content.length === 0 ? {} : { content }),
    ...(calls.length === 0 ? {} : {
      functionCalls: calls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, params: call.arguments } }))
    }),
    thoughtBlocks: [encodedState(steps)],
    finishReason: calls.length > 0 ? 'function_call' : status === 'incomplete' || status === 'budget_exceeded' ? 'length' : 'stop'
  }
}

const bufferedResponse = async (response: Response, expectedModel: string): Promise<AxChatResponse> => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw invalidResponse('returned an invalid content type')
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_RESPONSE_BYTES) throw invalidResponse('response exceeds the byte limit')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw invalidResponse('response exceeds the byte limit')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw invalidResponse('response is not valid UTF-8 JSON') }
  const parsed = InteractionSchema.safeParse(value)
  if (!parsed.success || parsed.data.model !== expectedModel) throw invalidResponse('response does not match the pinned schema')
  if (parsed.data.status === 'failed' || parsed.data.status === 'cancelled') throw invalidResponse('interaction did not complete successfully')
  return {
    remoteId: parsed.data.id,
    results: [responseResult(parsed.data.id, parsed.data.status, parsed.data.steps)],
    modelUsage: usageResponse(expectedModel, parsed.data.usage)
  }
}

const StreamStartStepSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('model_output'), content: z.array(TextContentSchema).max(MAX_STEPS).optional() }),
  z.strictObject({ type: z.literal('function_call'), id: IdentifierSchema, name: ToolNameSchema, arguments: JsonObjectSchema.optional() }),
  z.strictObject({ type: z.literal('thought'), signature: z.string().min(1).max(MAX_STATE_BYTES).optional(), summary: z.array(TextContentSchema).max(64).optional() })
])
const CreatedEventSchema = z.strictObject({
  event_type: z.literal('interaction.created'),
  event_id: z.string().optional(),
  interaction: z.object({ id: IdentifierSchema, model: z.string().min(1).max(255).optional(), status: z.literal('in_progress') }).passthrough()
})
const StatusEventSchema = z.strictObject({
  event_type: z.literal('interaction.status_update'),
  event_id: z.string().optional(),
  interaction_id: IdentifierSchema,
  status: z.enum(['in_progress', 'requires_action', 'completed', 'incomplete', 'failed', 'cancelled', 'budget_exceeded'])
})
const StartEventSchema = z.strictObject({
  event_type: z.literal('step.start'),
  event_id: z.string().optional(),
  index: z.number().int().nonnegative().max(MAX_STEPS - 1),
  step: StreamStartStepSchema
})
const DeltaEventSchema = z.strictObject({
  event_type: z.literal('step.delta'),
  event_id: z.string().optional(),
  index: z.number().int().nonnegative().max(MAX_STEPS - 1),
  delta: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), text: z.string().max(MAX_TEXT_CHARACTERS) }),
    z.strictObject({ type: z.literal('arguments_delta'), arguments: z.string().max(MAX_STATE_BYTES).optional() }),
    z.strictObject({ type: z.literal('thought_signature'), signature: z.string().max(MAX_STATE_BYTES).optional() })
  ])
})
const StopEventSchema = z.strictObject({
  event_type: z.literal('step.stop'),
  event_id: z.string().optional(),
  index: z.number().int().nonnegative().max(MAX_STEPS - 1),
  step_usage: UsageSchema.optional()
})
const CompletedEventSchema = z.strictObject({
  event_type: z.literal('interaction.completed'),
  event_id: z.string().optional(),
  interaction: z.object({
    id: IdentifierSchema,
    model: z.string().min(1).max(255).optional(),
    status: z.enum(['completed', 'requires_action', 'incomplete', 'failed', 'cancelled', 'budget_exceeded']),
    steps: OutputStepsSchema.optional(),
    usage: UsageSchema
  }).passthrough()
})
const ErrorEventSchema = z.strictObject({
  event_type: z.literal('error'),
  event_id: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional()
})

interface ActiveStreamStep {
  readonly start: z.infer<typeof StreamStartStepSchema>
  text: string
  arguments: string
  signature: string
  stopped: boolean
}
interface StreamState {
  interactionId: string | null
  readonly expectedModel: string
  readonly active: Map<number, ActiveStreamStep>
  readonly steps: Map<number, OutputStep>
  completed: boolean
  done: boolean
  totalBytes: number
}

const streamedChunk = (state: StreamState, result: AxChatResponseResult, usage?: Usage): AxChatResponse => ({
  ...(state.interactionId === null ? {} : { remoteId: state.interactionId }),
  results: [result],
  ...(usage === undefined ? {} : { modelUsage: usageResponse(state.expectedModel, usage) })
})

const processStreamEvent = (value: unknown, state: StreamState): readonly AxChatResponse[] => {
  if (typeof value !== 'object' || value === null) throw invalidResponse('stream event is not an object')
  const eventType = Reflect.get(value, 'event_type')
  if (eventType === 'interaction.created') {
    const parsed = CreatedEventSchema.safeParse(value)
    if (!parsed.success || state.interactionId !== null || (parsed.data.interaction.model !== undefined && parsed.data.interaction.model !== state.expectedModel)) throw invalidResponse('stream contains an invalid created event')
    state.interactionId = parsed.data.interaction.id
    return []
  }
  if (state.interactionId === null || state.completed) throw invalidResponse('stream event is out of order')
  if (eventType === 'interaction.status_update') {
    const parsed = StatusEventSchema.safeParse(value)
    if (!parsed.success || parsed.data.interaction_id !== state.interactionId || parsed.data.status === 'failed' || parsed.data.status === 'cancelled') throw invalidResponse('stream contains an invalid status event')
    return []
  }
  if (eventType === 'step.start') {
    const parsed = StartEventSchema.safeParse(value)
    if (!parsed.success || state.active.has(parsed.data.index) || state.steps.has(parsed.data.index)) throw invalidResponse('stream contains an invalid step start')
    const start = parsed.data.step
    state.active.set(parsed.data.index, {
      start,
      text: start.type === 'model_output' ? (start.content ?? []).map(content => content.text).join('') : '',
      arguments: '',
      signature: start.type === 'thought' ? start.signature ?? '' : '',
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
      current.text += delta.text
      if (current.text.length > MAX_TEXT_CHARACTERS) throw invalidResponse('streamed text exceeds the character limit')
      return [streamedChunk(state, { index: 0, content: delta.text })]
    }
    if (current.start.type === 'function_call' && delta.type === 'arguments_delta') {
      current.arguments += delta.arguments ?? ''
      if (Buffer.byteLength(current.arguments, 'utf8') > MAX_STATE_BYTES) throw invalidResponse('streamed action arguments exceed the byte limit')
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
      step = { type: 'model_output', ...(current.text.length === 0 ? {} : { content: [{ type: 'text', text: current.text }] }) }
    } else if (current.start.type === 'thought') {
      step = { type: 'thought', ...(current.signature.length === 0 ? {} : { signature: current.signature }), ...(current.start.summary === undefined ? {} : { summary: current.start.summary }) }
    } else {
      let argumentsValue: unknown = current.start.arguments ?? {}
      if (current.arguments.length > 0) {
        try { argumentsValue = JSON.parse(current.arguments) } catch { throw invalidResponse('streamed action arguments are not valid JSON') }
      }
      const call = FunctionCallStepSchema.safeParse({ type: 'function_call', id: current.start.id, name: current.start.name, arguments: argumentsValue })
      if (!call.success) throw invalidResponse('streamed action call does not match the pinned schema')
      step = call.data
    }
    state.steps.set(parsed.data.index, step)
    if (step.type !== 'function_call') return []
    return [streamedChunk(state, { index: 0, id: state.interactionId, functionCalls: [{ id: step.id, type: 'function', function: { name: step.name, params: step.arguments } }], finishReason: 'function_call' })]
  }
  if (eventType === 'interaction.completed') {
    const parsed = CompletedEventSchema.safeParse(value)
    if (!parsed.success || parsed.data.interaction.id !== state.interactionId || (parsed.data.interaction.model !== undefined && parsed.data.interaction.model !== state.expectedModel) || parsed.data.interaction.status === 'failed' || parsed.data.interaction.status === 'cancelled') throw invalidResponse('stream contains an invalid completed event')
    if ([...state.active.values()].some(step => !step.stopped)) throw invalidResponse('stream completed with an unfinished step')
    const ordered = [...state.steps.entries()].sort(([left], [right]) => left - right)
    if (ordered.some(([index], position) => index !== position)) throw invalidResponse('stream step indexes are not contiguous')
    const steps = ordered.map(([, step]) => step)
    if (parsed.data.interaction.steps !== undefined && canonicalJson(parsed.data.interaction.steps) !== canonicalJson(steps)) throw invalidResponse('completed stream steps do not match streamed steps')
    state.completed = true
    return [streamedChunk(state, {
      index: 0,
      id: state.interactionId,
      thoughtBlocks: [encodedState(steps)],
      finishReason: stepCalls(steps).length > 0 ? 'function_call' : parsed.data.interaction.status === 'incomplete' || parsed.data.interaction.status === 'budget_exceeded' ? 'length' : 'stop'
    }, parsed.data.interaction.usage)]
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
  try { value = JSON.parse(data) } catch { throw invalidResponse('stream event data is not valid JSON') }
  if (event !== '' && (typeof value !== 'object' || value === null || Reflect.get(value, 'event_type') !== event)) throw invalidResponse('stream event name does not match its data')
  return processStreamEvent(value, state)
}

const streamingResponse = (response: Response, expectedModel: string): ReadableStream<AxChatResponse> => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'text/event-stream' || !response.body) throw invalidResponse('stream response has an invalid content type')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const state: StreamState = { interactionId: null, expectedModel, active: new Map(), steps: new Map(), completed: false, done: false, totalBytes: 0 }
  let buffer = ''
  const process = (controller: TransformStreamDefaultController<AxChatResponse>, flush: boolean): void => {
    buffer = buffer.replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const item of processSseFrame(frame, state)) controller.enqueue(item)
      boundary = buffer.indexOf('\n\n')
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_EVENT_BYTES) throw invalidResponse('stream event exceeds the byte limit')
    if (flush && buffer.trim().length > 0) {
      for (const item of processSseFrame(buffer, state)) controller.enqueue(item)
      buffer = ''
    }
  }
  return response.body.pipeThrough(new TransformStream<Uint8Array, AxChatResponse>({
    transform (chunk, controller) {
      state.totalBytes += chunk.byteLength
      if (state.totalBytes > MAX_RESPONSE_BYTES) throw invalidResponse('stream exceeds the byte limit')
      try { buffer += decoder.decode(chunk, { stream: true }) } catch { throw invalidResponse('stream is not valid UTF-8') }
      process(controller, false)
    },
    flush (controller) {
      try { buffer += decoder.decode() } catch { throw invalidResponse('stream is not valid UTF-8') }
      process(controller, true)
      if (!state.done) throw invalidResponse('stream ended before its terminal marker')
    }
  }))
}

export interface GeminiInteractionsServiceOptions {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly fetch: typeof fetch
  readonly timeoutMs: number
  readonly reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}

const thinkingLevel = (effort: GeminiInteractionsServiceOptions['reasoningEffort']): 'minimal' | 'low' | 'medium' | 'high' | undefined => {
  if (effort === undefined) return undefined
  if (effort === 'none' || effort === 'minimal') return 'minimal'
  if (effort === 'xhigh') return 'high'
  return effort
}

export const createGeminiInteractionsService = (config: GeminiInteractionsServiceOptions): Pick<AxAIService, 'chat'> => ({
  chat: async (request: Readonly<AxChatRequest<unknown>>, options?: Readonly<AxAIServiceOptions>): Promise<AxChatResponse | ReadableStream<AxChatResponse>> => {
    options?.abortSignal?.throwIfAborted()
    assertSupportedModelConfig(request.modelConfig)
    const { systemInstruction, input } = requestParts(request)
    const stream = options?.stream === true
    const level = thinkingLevel(config.reasoningEffort)
    const generationConfig = {
      ...(request.modelConfig?.maxTokens === undefined ? {} : { max_output_tokens: request.modelConfig.maxTokens }),
      ...(request.modelConfig?.stopSequences === undefined ? {} : { stop_sequences: request.modelConfig.stopSequences }),
      ...(level === undefined ? {} : { thinking_level: level }),
      thinking_summaries: 'none' as const
    }
    const body = {
      model: config.model,
      store: false,
      stream,
      input,
      ...(systemInstruction === undefined ? {} : { system_instruction: systemInstruction }),
      ...(request.functions?.length ? {
        tools: request.functions.map(fn => ({ type: 'function', name: fn.name, description: fn.description, ...(fn.parameters === undefined ? {} : { parameters: fn.parameters }) })),
        tool_choice: toolChoice(request.functionCall)
      } : {}),
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
    return stream ? streamingResponse(response, config.model) : await bufferedResponse(response, config.model)
  }
})
