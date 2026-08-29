import { z } from 'zod'

import { AgentRepositoryError } from '../repository.ts'
import type { AgentProviderFetch } from './factory.ts'

const MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024
const MAX_EVENT_BYTES = 1 * 1_024 * 1_024

const JsonObject = z.record(z.string(), z.unknown())
const RequestItem = JsonObject.refine(value => typeof value.type === 'string' || typeof value.role === 'string', 'input items require a type or role')

const OpenResponsesRequestSchema = z.object({
  model: z.string().min(1).max(255),
  input: z.union([z.string().max(1_000_000), z.array(RequestItem).max(2_000)]),
  background: z.boolean().optional(),
  include: z.array(z.string().min(1).max(255)).max(64).optional(),
  instructions: z.string().max(1_000_000).nullable().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  metadata: JsonObject.nullable().optional(),
  parallel_tool_calls: z.boolean().optional(),
  previous_response_id: z.string().max(255).nullable().optional(),
  prompt: JsonObject.optional(),
  reasoning: JsonObject.nullable().optional(),
  safety_identifier: z.string().max(255).optional(),
  service_tier: z.string().max(64).optional(),
  store: z.literal(false),
  stream: z.boolean().optional(),
  temperature: z.number().finite().optional(),
  text: JsonObject.optional(),
  tool_choice: z.union([z.string(), JsonObject]).optional(),
  tools: z.array(JsonObject).max(256).optional(),
  top_p: z.number().finite().optional(),
  truncation: z.string().max(64).optional(),
  user: z.string().max(255).optional()
}).strict()

const OutputItemSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.enum(['message', 'function_call', 'reasoning', 'computer_call', 'file_search_call', 'web_search_call', 'code_interpreter_call', 'image_generation_call', 'local_shell_call', 'mcp_call', 'mcp_list_tools']),
  status: z.enum(['in_progress', 'incomplete', 'completed']).optional()
}).passthrough()

const OpenResponsesResponseSchema = z.object({
  id: z.string().min(1).max(255),
  object: z.literal('response'),
  created_at: z.number().int().nonnegative(),
  status: z.enum(['queued', 'in_progress', 'completed', 'incomplete', 'failed', 'cancelled']),
  model: z.string().min(1).max(255),
  output: z.array(OutputItemSchema).max(2_000),
  error: JsonObject.nullable().optional(),
  incomplete_details: JsonObject.nullable().optional(),
  usage: JsonObject.nullable().optional()
}).passthrough()

const EVENT_TYPES = new Set([
  'error',
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.file_search_call.in_progress',
  'response.file_search_call.searching',
  'response.file_search_call.completed',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
  'response.web_search_call.completed',
  'response.code_interpreter_call.in_progress',
  'response.code_interpreter_call.interpreting',
  'response.code_interpreter_call.completed',
  'response.code_interpreter_call_code.delta',
  'response.code_interpreter_call_code.done'
])
const TERMINAL_EVENT_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete'])

const invalid = (detail: string): AgentRepositoryError => new AgentRepositoryError('INVALID_OPENRESPONSES_PROTOCOL', `OpenResponses ${detail}`, 502)

const parseRequest = (init: RequestInit | undefined): z.infer<typeof OpenResponsesRequestSchema> => {
  if (init?.method !== 'POST' || typeof init.body !== 'string') throw invalid('request is not a JSON POST')
  let value: unknown
  try { value = JSON.parse(init.body) } catch { throw invalid('request is not valid JSON') }
  const parsed = OpenResponsesRequestSchema.safeParse(value)
  if (!parsed.success) throw invalid('request does not match the pinned schema')
  return parsed.data
}

const validateBufferedResponse = async (response: Response): Promise<void> => {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_RESPONSE_BYTES) throw invalid('response exceeds the byte limit')
  const bytes = new Uint8Array(await response.clone().arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw invalid('response exceeds the byte limit')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw invalid('response is not valid UTF-8 JSON') }
  if (!OpenResponsesResponseSchema.safeParse(value).success) throw invalid('response does not match the pinned schema')
}

interface SseState {
  sequence: number
  terminal: boolean
  done: boolean
}

const validateSseFrame = (frame: string, state: SseState): void => {
  const lines = frame.split('\n')
  const eventLines = lines.filter(line => line.startsWith('event:'))
  const dataLines = lines.filter(line => line.startsWith('data:'))
  if (eventLines.length === 0 && dataLines.length === 1 && dataLines[0]?.slice(5).trim() === '[DONE]') {
    if (!state.terminal || state.done) throw invalid('stream has an invalid terminal marker')
    state.done = true
    return
  }
  if (state.terminal || state.done || eventLines.length !== 1 || dataLines.length === 0) throw invalid('stream contains an invalid SSE frame')
  const event = eventLines[0]?.slice(6).trim() ?? ''
  if (!EVENT_TYPES.has(event)) throw invalid('stream contains an unknown event type')
  let value: unknown
  try { value = JSON.parse(dataLines.map(line => line.slice(5).trimStart()).join('\n')) } catch { throw invalid('stream event data is not valid JSON') }
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'type') !== event) throw invalid('stream event name does not match its data')
  const sequence = Reflect.get(value, 'sequence_number')
  if (!Number.isSafeInteger(sequence) || Number(sequence) <= state.sequence) throw invalid('stream sequence is not strictly increasing')
  state.sequence = Number(sequence)
  if (TERMINAL_EVENT_TYPES.has(event)) {
    const response = Reflect.get(value, 'response')
    if (!OpenResponsesResponseSchema.safeParse(response).success) throw invalid('terminal event response does not match the pinned schema')
    state.terminal = true
  }
}

const validatedEventStream = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  const state: SseState = { sequence: -1, terminal: false, done: false }
  let buffer = ''
  const process = (controller: TransformStreamDefaultController<Uint8Array>, flush: boolean): void => {
    buffer = buffer.replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      if (frame.length > 0) {
        validateSseFrame(frame, state)
        controller.enqueue(encoder.encode(`${frame}\n\n`))
      }
      boundary = buffer.indexOf('\n\n')
    }
    if (new TextEncoder().encode(buffer).byteLength > MAX_EVENT_BYTES) throw invalid('stream event exceeds the byte limit')
    if (flush && buffer.trim().length > 0) {
      validateSseFrame(buffer, state)
      controller.enqueue(encoder.encode(`${buffer}\n\n`))
      buffer = ''
    }
  }
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform (chunk, controller) {
      try { buffer += decoder.decode(chunk, { stream: true }) } catch { throw invalid('stream is not valid UTF-8') }
      process(controller, false)
    },
    flush (controller) {
      try { buffer += decoder.decode() } catch { throw invalid('stream is not valid UTF-8') }
      process(controller, true)
      if (!state.done) throw invalid('stream ended before its terminal marker')
    }
  }))
}

export const createOpenResponsesFetch = (delegate: AgentProviderFetch): AgentProviderFetch => Object.assign(async (input: Parameters<AgentProviderFetch>[0], init?: Parameters<AgentProviderFetch>[1]): Promise<Response> => {
  const request = parseRequest(init)
  const response = await delegate(input, init)
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (request.stream === true) {
    if (contentType !== 'text/event-stream' || !response.body) throw invalid('stream response has an invalid content type')
    return new Response(validatedEventStream(response.body), { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  if (contentType !== 'application/json') throw invalid('response has an invalid content type')
  await validateBufferedResponse(response)
  return response
}, { preconnect: delegate.preconnect })
