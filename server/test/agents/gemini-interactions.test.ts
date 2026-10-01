import type { AxChatResponse, AxChatResponseResult, AxFunctionJSONSchema } from '@ax-llm/ax'
import { z } from 'zod'
import { ACTION_CATALOG } from '../../agents/actions/catalog.ts'
import { classifyAgentExecutionFailure } from '../../agents/providers/execution-failure.ts'
import {
  combineGeminiInteractionState,
  createGeminiInteractionsService,
  readGeminiGoogleSearchGrounding,
  readGeminiInteractionStatus
} from '../../agents/providers/gemini-interactions.ts'
import { readAgentProviderUsage } from '../../agents/providers/usage.ts'
import { describe, expect, it } from '../bun-test.mts'

const model = 'gemini-3.8-flash'
const usage = { total_input_tokens: 3, total_output_tokens: 2, total_tokens: 5 }
const annotation = {
  type: 'url_citation',
  start_index: 0,
  end_index: 5,
  url: 'https://grounding.example.test/source',
  title: 'Example source'
} as const

const groundedSteps = () => [
  {
    type: 'google_search_call',
    id: 'search_1',
    signature: 'search-call-signature',
    arguments: { queries: ['bounded public query'] },
    search_type: 'web_search'
  },
  {
    type: 'google_search_result',
    call_id: 'search_1',
    signature: 'search-result-signature',
    result: [{ search_suggestions: '<style>.chip{display:block}</style><a href="https://www.google.com/search?q=bounded">bounded</a>' }],
    is_error: false
  },
  { type: 'thought', signature: 'thought-signature' },
  { type: 'model_output', content: [{ type: 'text', text: 'Alpha', annotations: [annotation] }] },
  {
    type: 'model_output',
    content: [
      {
        type: 'text',
        text: ' 🔍Beta',
        annotations: [{ ...annotation, start_index: 5, end_index: 9, url: 'https://grounding.example.test/second', title: 'Second source' }]
      }
    ]
  }
]
const groundedInteraction = (overrides: Record<string, unknown> = {}) => ({
  model,
  status: 'completed',
  usage,
  steps: groundedSteps(),
  ...overrides
})

const jsonResponse = (value: unknown): Response => Response.json(value, { headers: { 'content-type': 'application/json' } })
const resultOf = (response: AxChatResponse | ReadableStream<AxChatResponse>): AxChatResponseResult => {
  if (response instanceof ReadableStream) throw new Error('Expected buffered response')
  return response.results[0]!
}

// Synthetic public protocol fixture, not a recorded Wiki answer or provider call.
const metadataTextEvents = (): Record<string, unknown>[] => [
  {
    event_type: 'interaction.created',
    interaction: { id: '', status: 'in_progress', model },
    metadata: { total_usage: { total_input_tokens: 3, total_output_tokens: 0, total_tokens: 3 } }
  },
  { event_type: 'interaction.status_update', interaction_id: '', status: 'in_progress', metadata: {} },
  { event_type: 'step.start', index: 0, step: { type: 'model_output' }, metadata: { total_usage: {} } },
  {
    event_type: 'step.delta',
    index: 0,
    delta: { type: 'text', text: 'Hello 🔍' },
    metadata: {
      total_usage: {
        total_output_tokens: 2,
        output_tokens_by_modality: [{ modality: 'text', tokens: 2 }],
        grounding_tool_count: [{ type: 'google_search', count: 0 }]
      }
    }
  },
  {
    event_type: 'step.stop',
    index: 0,
    step_usage: { total_output_tokens: 2 },
    usage,
    metadata: { total_usage: { total_cached_tokens: 0 } }
  },
  { event_type: 'interaction.completed', interaction: { id: '', model, status: 'completed', usage }, metadata: { total_usage: { total_tokens: 5 } } }
]
const statelessTextEvents = (): Record<string, unknown>[] => {
  const events = metadataTextEvents()
  events[0]!.interaction = {}
  events.splice(1, 1)
  events[4]!.interaction = { model, status: 'completed', usage }
  return events
}
const streamWire = (events: readonly Record<string, unknown>[], done = true): string =>
  `${events.map(value => `event: ${String(value.event_type)}\ndata: ${JSON.stringify(value)}`).join('\n\n')}\n\n${done ? 'event: done\ndata: [DONE]\n\n' : ''}`
const textStreamService = (body: string | ReadableStream<Uint8Array>) =>
  createGeminiInteractionsService({
    apiKey: 'test-key',
    baseUrl: 'https://gemini.example.test',
    model,
    fetch: (async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch,
    timeoutMs: 10_000
  })

describe('Gemini Interactions Google Search grounding', () => {
  it('preserves the raw interaction status so truncated turns stay diagnosable', async () => {
    const textInteraction = { model, status: 'budget_exceeded', usage, steps: [{ type: 'model_output', content: [{ type: 'text', text: 'The poem so far' }] }] }
    const service = createGeminiInteractionsService({
      apiKey: 'key',
      baseUrl: 'https://gemini.example.test',
      model,
      timeoutMs: 5_000,
      fetch: (async () => jsonResponse(textInteraction)) as typeof globalThis.fetch
    })
    const response = await service.chat({ chatPrompt: [{ role: 'user' as const, content: 'Write a poem' }] }, { stream: false })
    const result = resultOf(response as AxChatResponse)
    expect(result.finishReason).toBe('length')
    expect(readGeminiInteractionStatus(result)).toBe('budget_exceeded')
  })

  it('exposes only valid provider-reported cached input counts without changing charged token usage', async () => {
    for (const cached of [undefined, 0, 2]) {
      const service = createGeminiInteractionsService({
        apiKey: 'key',
        baseUrl: 'https://gemini.example.test',
        model,
        timeoutMs: 5_000,
        fetch: (async () =>
          jsonResponse({
            model,
            status: 'completed',
            usage: { ...usage, ...(cached === undefined ? {} : { total_cached_tokens: cached }) },
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Grounded answer' }] }]
          })) as typeof globalThis.fetch
      })
      const response = await service.chat({ chatPrompt: [{ role: 'user', content: 'Question' }] }, { stream: false })
      if (response instanceof ReadableStream) throw new Error('Expected buffered response')
      expect(readAgentProviderUsage('gemini-api', response)).toEqual({
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        ...(cached === undefined ? {} : { cachedInputTokens: cached })
      })
      expect(response.modelUsage?.tokens).not.toHaveProperty('cachedInputTokens')
      if (cached === undefined) expect(response.modelUsage?.tokens).not.toHaveProperty('cacheReadTokens')
      else expect(response.modelUsage?.tokens).toHaveProperty('cacheReadTokens', cached)
    }
    for (const cached of [-1, 0.5, '2', 4, Number.MAX_SAFE_INTEGER + 1]) {
      const service = createGeminiInteractionsService({
        apiKey: 'key',
        baseUrl: 'https://gemini.example.test',
        model,
        timeoutMs: 5_000,
        fetch: (async () =>
          jsonResponse({
            model,
            status: 'completed',
            usage: { ...usage, total_cached_tokens: cached },
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Grounded answer' }] }]
          })) as typeof globalThis.fetch
      })
      await expect(service.chat({ chatPrompt: [{ role: 'user', content: 'Question' }] }, { stream: false })).rejects.toMatchObject({
        code: 'INVALID_PROVIDER_RESPONSE'
      })
    }
  })

  it('defaults search off and uses validated mixed-tool choice only when explicitly enabled', async () => {
    const payloads: Record<string, unknown>[] = []
    const fetch = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse({ model, status: 'completed', usage, steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }] })
    }
    const base = {
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model,
      fetch: fetch as typeof globalThis.fetch,
      timeoutMs: 10_000
    }
    const request = {
      chatPrompt: [{ role: 'user' as const, content: 'hello' }],
      model,
      functions: [{ name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object' } }],
      functionCall: 'auto' as const
    }
    await createGeminiInteractionsService(base).chat(request, { stream: false })
    await createGeminiInteractionsService({ ...base, googleSearchEnabled: true }).chat(request, { stream: false })

    expect(payloads[0]).toMatchObject({ tools: [{ type: 'function', name: 'wiki_get_page' }], generation_config: { tool_choice: 'auto' } })
    expect(payloads[0]).not.toHaveProperty('tools.1')
    expect(payloads[1]).toMatchObject({
      tools: [{ type: 'google_search' }, { type: 'function', name: 'wiki_get_page' }],
      generation_config: { tool_choice: 'validated' }
    })
    await expect(
      createGeminiInteractionsService({
        ...base,
        fetch: (async () => jsonResponse(groundedInteraction())) as typeof globalThis.fetch
      }).chat({ chatPrompt: [{ role: 'user', content: 'no search consent' }], model }, { stream: false })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
  })

  it('admits union-shaped Wiki tools through the validated native-search boundary', async () => {
    const requestSchema = z.object({
      tools: z.array(z.object({ type: z.string(), parameters: z.unknown().optional() }))
    })
    let offeredMemoryParameters: unknown
    const service = createGeminiInteractionsService({
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model,
      timeoutMs: 10_000,
      googleSearchEnabled: true,
      fetch: (async (_input, init) => {
        const request = requestSchema.parse(JSON.parse(String(init?.body)))
        // Gemini validated mode rejects root anyOf/oneOf schemas without an explicit object type.
        if (request.tools.some(tool => tool.type === 'function' && !z.object({ type: z.literal('object') }).safeParse(tool.parameters).success))
          return Response.json({ error: { code: 'invalid_request' } }, { status: 400 })
        offeredMemoryParameters = request.tools[2]?.parameters
        return jsonResponse(groundedInteraction())
      }) as typeof globalThis.fetch
    })
    // Ax's parameter type omits the valid root unions produced by the action catalog.
    const parameters = z.toJSONSchema(ACTION_CATALOG['pages.get'].input) as AxFunctionJSONSchema
    const memoryParameters = z.toJSONSchema(ACTION_CATALOG['memory.manage'].input) as AxFunctionJSONSchema
    const result = resultOf(
      await service.chat(
        {
          model,
          chatPrompt: [{ role: 'user', content: 'Look up this page and verify its release date on the web.' }],
          functions: [
            { name: 'wiki_get_page', description: 'Read a Wiki page by ID or path.', parameters },
            { name: 'wiki_manage_memory', description: 'Manage personal memory', parameters: memoryParameters }
          ],
          functionCall: 'auto'
        },
        { stream: false }
      )
    )
    expect(offeredMemoryParameters).toMatchObject({
      type: 'object',
      required: ['action', 'target'],
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove'] },
        target: { type: 'string', enum: ['agent', 'user'] },
        content: { type: 'string' },
        oldText: { type: 'string' }
      }
    })
    expect(z.object({ oneOf: z.array(z.object({ additionalProperties: z.literal(false) })).length(3) }).safeParse(offeredMemoryParameters).success).toBe(true)
    expect(result.content).toBe('Alpha 🔍Beta')
    expect(readGeminiGoogleSearchGrounding(result)?.citations.map(citation => citation.url)).toEqual([
      'https://grounding.example.test/source',
      'https://grounding.example.test/second'
    ])
  })

  it('preserves native steps and citation offsets while excluding only suggestion HTML from replay', async () => {
    const payloads: Array<{ input: unknown[] }> = []
    const fetch = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as { input: unknown[] })
      return jsonResponse(
        payloads.length === 1
          ? groundedInteraction()
          : { model, status: 'completed', usage, steps: [{ type: 'model_output', content: [{ type: 'text', text: 'follow-up' }] }] }
      )
    }
    const service = createGeminiInteractionsService({
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model,
      fetch: fetch as typeof globalThis.fetch,
      timeoutMs: 10_000,
      googleSearchEnabled: true
    })
    const first = resultOf(await service.chat({ chatPrompt: [{ role: 'user', content: 'search' }], model }, { stream: false }))
    expect(first.content).toBe('Alpha 🔍Beta')
    expect(readGeminiGoogleSearchGrounding(first)).toEqual({
      citations: [
        { url: 'https://grounding.example.test/source', title: 'Example source', startIndex: 0, endIndex: 5 },
        { url: 'https://grounding.example.test/second', title: 'Second source', startIndex: 8, endIndex: 12 }
      ],
      searchSuggestions: ['<style>.chip{display:block}</style><a href="https://www.google.com/search?q=bounded">bounded</a>']
    })

    await createGeminiInteractionsService({
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model,
      fetch: fetch as typeof globalThis.fetch,
      timeoutMs: 10_000
    }).chat(
      {
        chatPrompt: [
          { role: 'assistant', content: 'Alpha 🔍Beta', thoughtBlocks: first.thoughtBlocks },
          { role: 'user', content: 'follow up without search' }
        ],
        model
      },
      { stream: false }
    )
    expect(payloads[1]!.input).toContainEqual({
      type: 'google_search_result',
      call_id: 'search_1',
      signature: 'search-result-signature',
      result: [{}],
      is_error: false
    })
    expect(payloads[1]!.input).toContainEqual({
      type: 'model_output',
      content: [
        {
          type: 'text',
          text: ' 🔍Beta',
          annotations: [{ ...annotation, start_index: 5, end_index: 9, url: 'https://grounding.example.test/second', title: 'Second source' }]
        }
      ]
    })
    expect(JSON.stringify(payloads[1])).not.toContain('search_suggestions')
    expect(payloads[1]!.input.map(step => (typeof step === 'object' && step !== null ? Reflect.get(step, 'type') : undefined))).toEqual([
      'google_search_call',
      'google_search_result',
      'thought',
      'model_output',
      'model_output',
      'user_input'
    ])
  })

  it('assembles streamed native search metadata and annotations without dispatching a host function', async () => {
    const events = [
      ['interaction.created', { interaction: { id: '', status: 'in_progress', model }, event_type: 'interaction.created' }],
      ['interaction.status_update', { interaction_id: '', status: 'in_progress', event_type: 'interaction.status_update' }],
      ['step.start', { index: 0, step: { id: 'search_1', signature: '', type: 'google_search_call' }, event_type: 'step.start' }],
      [
        'step.delta',
        { index: 0, delta: { signature: 'call-signature', type: 'google_search_call', arguments: { queries: ['query'] } }, event_type: 'step.delta' }
      ],
      ['step.stop', { index: 0, event_type: 'step.stop' }],
      ['step.start', { index: 1, step: { call_id: 'search_1', signature: '', type: 'google_search_result' }, event_type: 'step.start' }],
      [
        'step.delta',
        {
          index: 1,
          delta: { signature: 'result-signature', type: 'google_search_result', result: [{ search_suggestions: '<a>query</a>' }], is_error: false },
          event_type: 'step.delta'
        }
      ],
      ['step.stop', { index: 1, event_type: 'step.stop' }],
      ['step.start', { index: 2, step: { type: 'model_output' }, event_type: 'step.start' }],
      ['step.delta', { index: 2, delta: { text: 'Alpha', type: 'text' }, event_type: 'step.delta' }],
      ['step.delta', { index: 2, delta: { annotations: [annotation], type: 'text_annotation_delta' }, event_type: 'step.delta' }],
      ['step.stop', { index: 2, event_type: 'step.stop' }],
      [
        'interaction.completed',
        { interaction: { id: '', model, status: 'completed', usage: { ...usage, total_cached_tokens: 2 } }, event_type: 'interaction.completed' }
      ]
    ] as const
    const wire = `${events.map(([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}`).join('\n\n')}\n\nevent: done\ndata: [DONE]\n\n`
    const service = createGeminiInteractionsService({
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model,
      fetch: (async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch,
      timeoutMs: 10_000,
      googleSearchEnabled: true
    })
    const response = await service.chat({ chatPrompt: [{ role: 'user', content: 'search' }], model }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    const chunks: AxChatResponse[] = []
    for await (const chunk of response) chunks.push(chunk)
    const terminal = chunks.at(-1)!
    expect(chunks.flatMap(chunk => chunk.results).some(result => (result.functionCalls?.length ?? 0) > 0)).toBe(false)
    expect(readAgentProviderUsage('gemini-api', terminal)).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      cachedInputTokens: 2
    })
    expect(
      chunks
        .slice(0, -1)
        .flatMap(chunk => chunk.results)
        .map(result => result.content ?? '')
        .join('')
    ).toBe('Alpha')
    expect(chunks.slice(0, -1).every(chunk => chunk.modelUsage === undefined)).toBe(true)
    expect(readGeminiGoogleSearchGrounding(terminal.results[0]!)).toEqual({
      citations: [{ url: 'https://grounding.example.test/source', title: 'Example source', startIndex: 0, endIndex: 5 }],
      searchSuggestions: ['<a>query</a>']
    })
  })

  it('accepts documented inert metadata on every event and separate cumulative stop usage through split UTF-8 framing', async () => {
    const bytes = new TextEncoder().encode(streamWire(metadataTextEvents()).replaceAll('\n', '\r\n'))
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close()
        else controller.enqueue(bytes.subarray(offset, ++offset))
      }
    })
    const response = await textStreamService(body).chat({ chatPrompt: [{ role: 'user', content: 'Give a short greeting' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    const chunks = await Array.fromAsync(response)
    expect(
      chunks
        .flatMap(chunk => chunk.results)
        .map(result => result.content ?? '')
        .join('')
    ).toBe('Hello 🔍')
    expect(chunks.slice(0, -1).every(chunk => chunk.modelUsage === undefined)).toBe(true)
    expect(readAgentProviderUsage('gemini-api', chunks.at(-1)!)).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    expect(chunks.every(chunk => chunk.remoteId === undefined && chunk.results.every(result => result.id === undefined))).toBe(true)
    expect(readGeminiInteractionStatus(chunks.at(-1)!.results[0]!)).toBe('completed')
  })

  it.each([
    ['empty partial interaction', {}],
    ['partial interaction with the pinned model', { model }]
  ])('accepts stateless creation with %s through completed text, terminal usage, and reader EOF', async (_name, interaction) => {
    const events = statelessTextEvents()
    events[0]!.interaction = interaction
    const response = await textStreamService(streamWire(events)).chat({ chatPrompt: [{ role: 'user', content: 'Give a short greeting' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    const chunks = await Array.fromAsync(response)
    expect(chunks.flatMap(chunk => chunk.results).map(result => result.content ?? '').join('')).toBe('Hello 🔍')
    expect(chunks.every(chunk => chunk.remoteId === undefined && chunk.results.every(result => result.id === undefined))).toBe(true)
    expect(chunks.slice(0, -1).every(chunk => chunk.modelUsage === undefined)).toBe(true)
    expect(readAgentProviderUsage('gemini-api', chunks.at(-1)!)).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    expect(readGeminiInteractionStatus(chunks.at(-1)!.results[0]!)).toBe('completed')
  })

  it.each([
    ['completion first binds identity', undefined, undefined, 'response_1', undefined, 'response_1'],
    ['status first binds identity', undefined, 'response_1', undefined, 'response_1', 'response_1'],
    ['creation retains identity when completion omits it', 'response_1', undefined, undefined, 'response_1', 'response_1'],
    ['empty status identity stays bound without fabricated IDs', undefined, '', undefined, undefined, undefined]
  ] as const)('accepts %s through the completed text stream', async (_name, createdId, statusId, completedId, textRemoteId, finalId) => {
    const events = statelessTextEvents()
    events[0]!.interaction = { ...(createdId === undefined ? {} : { id: createdId }), model }
    events[4]!.interaction = { ...(completedId === undefined ? {} : { id: completedId }), model, status: 'completed', usage }
    if (statusId !== undefined) events.splice(1, 0, { event_type: 'interaction.status_update', interaction_id: statusId, status: 'in_progress' })
    const response = await textStreamService(streamWire(events)).chat({ chatPrompt: [{ role: 'user', content: 'Give a short greeting' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    const chunks = await Array.fromAsync(response)
    expect(chunks.flatMap(chunk => chunk.results).map(result => result.content ?? '').join('')).toBe('Hello 🔍')
    expect(chunks[0]!.remoteId).toBe(textRemoteId)
    expect(chunks.at(-1)!.remoteId).toBe(finalId)
    expect(chunks.at(-1)!.results[0]!.id).toBe(finalId)
    expect(readAgentProviderUsage('gemini-api', chunks.at(-1)!)).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    expect(readGeminiInteractionStatus(chunks.at(-1)!.results[0]!)).toBe('completed')
  })

  it.each([
    ['negative', { total_input_tokens: -1 }],
    ['fractional', { total_output_tokens: 0.5 }],
    ['wrong primitive', { total_tokens: '5' }],
    ['unsafe integer', { total_tokens: Number.MAX_SAFE_INTEGER + 1 }],
    ['overflowing sum', { total_input_tokens: Number.MAX_SAFE_INTEGER, total_output_tokens: 1 }],
    ['inconsistent total', { total_input_tokens: 3, total_output_tokens: 2, total_tokens: 4 }],
    ['input above total', { total_input_tokens: 3, total_tokens: 2 }],
    ['cached above input', { total_input_tokens: 3, total_cached_tokens: 4 }],
    ['negative modality count', { input_tokens_by_modality: [{ modality: 'text', tokens: -1 }] }],
    ['modality sum above input', { total_input_tokens: 3, input_tokens_by_modality: [{ modality: 'text', tokens: 4 }] }],
    ['unsafe grounding count', { grounding_tool_count: [{ type: 'google_search', count: Number.MAX_SAFE_INTEGER + 1 }] }],
    ['oversized modality list', { input_tokens_by_modality: Array.from({ length: 17 }, () => ({ tokens: 0 })) }],
    ['arbitrary nested field', { input_tokens_by_modality: [{ private: 'private-provider-detail' }] }],
    ['arbitrary usage field', { private: 'private-provider-detail' }]
  ])('rejects %s sparse metadata counters rather than treating them as usage receipts', async (_name, totalUsage) => {
    const events = metadataTextEvents()
    events[0]!.metadata = { total_usage: totalUsage }
    const response = await textStreamService(streamWire(events)).chat({ chatPrompt: [{ role: 'user', content: 'Question' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    await expect(Array.fromAsync(response)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      agentDiagnostics: { providerErrorCode: 'protocol_stream_created_metadata_usage_invalid' }
    })
  })

  it.each([
    [1, 'protocol_stream_status_invalid'],
    [2, 'protocol_stream_step_start_invalid'],
    [3, 'protocol_stream_step_delta_invalid'],
    [4, 'protocol_stream_step_stop_invalid'],
    [5, 'protocol_stream_completed_invalid']
  ] as const)('validates metadata on later event %s without skipping its envelope guard', async (index, providerErrorCode) => {
    const events = metadataTextEvents()
    events[index]!.metadata = { total_usage: { total_tokens: -1 } }
    const response = await textStreamService(streamWire(events)).chat({ chatPrompt: [{ role: 'user', content: 'Question' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    await expect(Array.fromAsync(response)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      agentDiagnostics: { providerErrorCode }
    })
  })

  it.each(['step_usage', 'usage'])('validates step.stop %s independently of metadata and the final receipt', async field => {
    const events = metadataTextEvents()
    events[4]![field] = { total_input_tokens: 3, total_cached_tokens: 4 }
    const response = await textStreamService(streamWire(events)).chat({ chatPrompt: [{ role: 'user', content: 'Question' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    await expect(Array.fromAsync(response)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      agentDiagnostics: { providerErrorCode: 'protocol_stream_step_stop_invalid' }
    })
  })

  it.each([
    ['absent', undefined],
    ['incomplete', { total_tokens: 5 }]
  ])('does not let metadata substitute for an %s final usage receipt', async (_name, finalUsage) => {
    const events = statelessTextEvents()
    events[4]!.interaction = { model, status: 'completed', ...(finalUsage === undefined ? {} : { usage: finalUsage }) }
    events[4]!.metadata = { total_usage: usage }
    const response = await textStreamService(streamWire(events)).chat({ chatPrompt: [{ role: 'user', content: 'Question' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    await expect(Array.fromAsync(response)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      agentDiagnostics: { providerErrorCode: 'protocol_stream_completed_invalid' }
    })
  })

  it.each([
    [
      'completion receipt despite a completed status update',
      (events: Record<string, unknown>[]) =>
        [...events.slice(0, -1), { event_type: 'interaction.status_update', interaction_id: '', status: 'completed' }],
      true,
      'protocol_stream_terminal_invalid'
    ],
    ['done marker', (events: Record<string, unknown>[]) => events, false, 'protocol_stream_missing_terminal']
  ] as const)('requires the %s after sparse creation even when the reader reaches EOF', async (_name, selectEvents, done, providerErrorCode) => {
    const response = await textStreamService(streamWire(selectEvents(statelessTextEvents()), done)).chat(
      { chatPrompt: [{ role: 'user', content: 'Question' }] },
      { stream: true }
    )
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    await expect(Array.fromAsync(response)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      agentDiagnostics: { providerErrorCode }
    })
  })

  it('accepts inert metadata on error events without converting a provider failure into completion', async () => {
    const events = metadataTextEvents().slice(0, 1)
    events.push({ event_type: 'error', error: { code: 'invalid_request' }, metadata: { total_usage: { total_input_tokens: 3 } } })
    const response = await textStreamService(streamWire(events, false)).chat({ chatPrompt: [{ role: 'user', content: 'Question' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    await expect(Array.fromAsync(response)).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_REJECTED',
      agentDiagnostics: { providerErrorCode: 'invalid_request' }
    })
  })

  it('does not retry a transient provider error after sparse creation without identity or status', async () => {
    let requests = 0
    const events = [
      statelessTextEvents()[0]!,
      { event_type: 'error', error: { code: 'service_unavailable' }, metadata: { total_usage: { total_input_tokens: 3 } } }
    ]
    const service = createGeminiInteractionsService({
      apiKey: 'test-key',
      baseUrl: 'https://gemini.example.test',
      model,
      timeoutMs: 10_000,
      streamRetryDelayMs: 0,
      fetch: (async () => {
        requests++
        return new Response(streamWire(events, false), { headers: { 'content-type': 'text/event-stream' } })
      }) as typeof globalThis.fetch
    })
    const response = await service.chat({ chatPrompt: [{ role: 'user', content: 'Question' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    await expect(Array.fromAsync(response)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      agentDiagnostics: { providerErrorCode: 'service_unavailable' }
    })
    expect(requests).toBe(1)
  })

  it('requires genuine reader EOF even after terminal usage and the done marker', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
        controller.enqueue(new TextEncoder().encode(streamWire(statelessTextEvents())))
      }
    })
    const response = await textStreamService(body).chat({ chatPrompt: [{ role: 'user', content: 'Question' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
    const reader = response.getReader()
    expect((await reader.read()).value?.results[0]?.content).toBe('Hello 🔍')
    expect(readAgentProviderUsage('gemini-api', (await reader.read()).value!)).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    const eof = reader.read()
    source.error(new Error('synthetic transport failed before EOF'))
    await expect(eof).rejects.toThrow('synthetic transport failed before EOF')
    reader.releaseLock()
  })

  it.each([
    ['missing interaction', [{ event_type: 'interaction.created' }], 'protocol_stream_created_interaction_missing'],
    ['null interaction', [{ event_type: 'interaction.created', interaction: null }], 'protocol_stream_created_interaction_null'],
    ['array interaction', [{ event_type: 'interaction.created', interaction: [] }], 'protocol_stream_created_interaction_type'],
    ['null identity', [{ event_type: 'interaction.created', interaction: { id: null, status: 'in_progress', model } }], 'protocol_stream_created_id_null'],
    ['non-string identity', [{ event_type: 'interaction.created', interaction: { id: 7, status: 'in_progress', model } }], 'protocol_stream_created_id_type'],
    [
      'oversized identity',
      [{ event_type: 'interaction.created', interaction: { id: 'x'.repeat(257), status: 'in_progress', model } }],
      'protocol_stream_created_id_length'
    ],
    [
      'identity control character',
      [{ event_type: 'interaction.created', interaction: { id: 'private-provider-detail\n', status: 'in_progress', model } }],
      'protocol_stream_created_id_control'
    ],
    ['null status', [{ event_type: 'interaction.created', interaction: { id: '', model, status: null } }], 'protocol_stream_created_status_null'],
    ['non-string status', [{ event_type: 'interaction.created', interaction: { id: '', model, status: 7 } }], 'protocol_stream_created_status_type'],
    ['false status without identity', [{ event_type: 'interaction.created', interaction: { status: false } }], 'protocol_stream_created_status_type'],
    [
      'terminal status on creation without identity',
      [{ event_type: 'interaction.created', interaction: { status: 'completed' } }],
      'protocol_stream_created_status_unsupported'
    ],
    [
      'unsupported status',
      [{ event_type: 'interaction.created', interaction: { id: '', model, status: 'private-provider-detail' } }],
      'protocol_stream_created_status_unsupported'
    ],
    ['null model', [{ event_type: 'interaction.created', interaction: { id: '', model: null, status: 'in_progress' } }], 'protocol_stream_created_model_null'],
    [
      'non-string model',
      [{ event_type: 'interaction.created', interaction: { id: '', model: 7, status: 'in_progress' } }],
      'protocol_stream_created_model_type'
    ],
    ['empty model', [{ event_type: 'interaction.created', interaction: { id: '', model: '', status: 'in_progress' } }], 'protocol_stream_created_model_length'],
    [
      'oversized model',
      [{ event_type: 'interaction.created', interaction: { id: '', model: 'x'.repeat(256), status: 'in_progress' } }],
      'protocol_stream_created_model_length'
    ],
    [
      'mismatched model without identity or status',
      [{ event_type: 'interaction.created', interaction: { model: 'private-provider-detail' } }],
      'protocol_stream_created_model_mismatch'
    ],
    [
      'null event identifier',
      [{ event_type: 'interaction.created', event_id: null, interaction: { id: '', model, status: 'in_progress' } }],
      'protocol_stream_created_event_id_null'
    ],
    [
      'non-string event identifier',
      [{ event_type: 'interaction.created', event_id: 7, interaction: { id: '', model, status: 'in_progress' } }],
      'protocol_stream_created_event_id_type'
    ],
    [
      'null metadata',
      [{ event_type: 'interaction.created', interaction: { id: '', model, status: 'in_progress' }, metadata: null }],
      'protocol_stream_created_metadata_null'
    ],
    [
      'array metadata',
      [{ event_type: 'interaction.created', interaction: { id: '', model, status: 'in_progress' }, metadata: [] }],
      'protocol_stream_created_metadata_type'
    ],
    [
      'unknown metadata field',
      [{ event_type: 'interaction.created', interaction: { id: '', model, status: 'in_progress' }, metadata: { private: 'private-provider-detail' } }],
      'protocol_stream_created_metadata_usage_invalid'
    ],
    [
      'unknown root field',
      [{ event_type: 'interaction.created', interaction: { id: '', model, status: 'in_progress' }, private: 'private-provider-detail' }],
      'protocol_stream_created_root_unknown_field'
    ],
    ['duplicate creation', [metadataTextEvents()[0]!, metadataTextEvents()[0]!], 'protocol_stream_created_duplicate'],
    [
      'duplicate sparse creation without identity or status',
      [statelessTextEvents()[0]!, statelessTextEvents()[0]!],
      'protocol_stream_created_duplicate'
    ],
    [
      'missing required status identity after identity-less creation',
      [statelessTextEvents()[0]!, { event_type: 'interaction.status_update', status: 'in_progress' }],
      'protocol_stream_status_id_missing'
    ],
    [
      'null status identity after identity-less creation',
      [statelessTextEvents()[0]!, { event_type: 'interaction.status_update', interaction_id: null, status: 'in_progress' }],
      'protocol_stream_status_id_null'
    ],
    [
      'non-string status identity after identity-less creation',
      [statelessTextEvents()[0]!, { event_type: 'interaction.status_update', interaction_id: 7, status: 'in_progress' }],
      'protocol_stream_status_id_type'
    ],
    [
      'missing required update status after sparse creation',
      [statelessTextEvents()[0]!, { event_type: 'interaction.status_update', interaction_id: '' }],
      'protocol_stream_status_status_missing'
    ],
    [
      'null update status after sparse creation',
      [statelessTextEvents()[0]!, { event_type: 'interaction.status_update', interaction_id: '', status: null }],
      'protocol_stream_status_status_type'
    ],
    [
      'non-string update status after sparse creation',
      [statelessTextEvents()[0]!, { event_type: 'interaction.status_update', interaction_id: '', status: false }],
      'protocol_stream_status_status_type'
    ],
    [
      'unsupported update status after sparse creation',
      [statelessTextEvents()[0]!, { event_type: 'interaction.status_update', interaction_id: '', status: 'private-provider-detail' }],
      'protocol_stream_status_status_invalid'
    ],
    [
      'missing final status after sparse creation',
      [...statelessTextEvents().slice(0, 4), { event_type: 'interaction.completed', interaction: { model, usage } }],
      'protocol_stream_completed_invalid'
    ],
    [
      'null final identity after identity-less creation',
      [statelessTextEvents()[0]!, { event_type: 'interaction.completed', interaction: { id: null, model, status: 'completed', usage } }],
      'protocol_stream_completed_invalid'
    ],
    [
      'non-string final identity after identity-less creation',
      [statelessTextEvents()[0]!, { event_type: 'interaction.completed', interaction: { id: 7, model, status: 'completed', usage } }],
      'protocol_stream_completed_invalid'
    ],
    [
      'status identity changing after its first binding',
      [
        statelessTextEvents()[0]!,
        { event_type: 'interaction.status_update', interaction_id: 'response_1', status: 'in_progress' },
        { event_type: 'interaction.status_update', interaction_id: 'response_2', status: 'in_progress' }
      ],
      'protocol_stream_status_invalid'
    ],
    [
      'final identity changing after status first binds it',
      [
        statelessTextEvents()[0]!,
        { event_type: 'interaction.status_update', interaction_id: 'response_1', status: 'in_progress' },
        { event_type: 'interaction.completed', interaction: { id: 'response_2', model, status: 'completed', usage } }
      ],
      'protocol_stream_completed_invalid'
    ],
    [
      'identity before status and metadata diagnostics',
      [{ event_type: 'interaction.created', interaction: { id: null, status: null }, event_id: 7, metadata: null }],
      'protocol_stream_created_id_null'
    ],
    [
      'schema before duplicate and model mismatch diagnostics',
      [metadataTextEvents()[0]!, { event_type: 'interaction.created', interaction: { id: null, status: 'in_progress', model: 'private-provider-detail' } }],
      'protocol_stream_created_id_null'
    ],
    [
      'duplicate before model mismatch diagnostics',
      [metadataTextEvents()[0]!, { event_type: 'interaction.created', interaction: { id: '', status: 'in_progress', model: 'private-provider-detail' } }],
      'protocol_stream_created_duplicate'
    ],
    [
      'mismatched status identity despite valid metadata',
      [metadataTextEvents()[0]!, { event_type: 'interaction.status_update', interaction_id: 'private-provider-detail', status: 'in_progress', metadata: {} }],
      'protocol_stream_status_invalid'
    ],
    [
      'mismatched final identity despite valid metadata',
      [
        ...metadataTextEvents().slice(0, 5),
        { event_type: 'interaction.completed', interaction: { id: 'private-provider-detail', model, status: 'completed', usage }, metadata: {} }
      ],
      'protocol_stream_completed_invalid'
    ],
    [
      'mismatched final model without identity despite valid metadata',
      [
        ...statelessTextEvents().slice(0, 4),
        { event_type: 'interaction.completed', interaction: { model: 'private-provider-detail', status: 'completed', usage }, metadata: {} }
      ],
      'protocol_stream_completed_invalid'
    ],
    [
      'failed final status despite valid metadata',
      [...metadataTextEvents().slice(0, 5), { event_type: 'interaction.completed', interaction: { id: '', model, status: 'failed', usage }, metadata: {} }],
      'protocol_stream_completed_invalid'
    ],
    [
      'unrequested native search despite valid metadata',
      [metadataTextEvents()[0]!, { event_type: 'step.start', index: 0, step: { type: 'google_search_call', id: 'search_1' }, metadata: {} }],
      'protocol_grounding_invalid'
    ],
    [
      'invalid error metadata',
      [metadataTextEvents()[0]!, { event_type: 'error', error: { code: 'invalid_request' }, metadata: { total_usage: { total_tokens: -1 } } }],
      'protocol_stream_error_invalid'
    ],
    ['out-of-order event', [{ event_type: 'step.stop', index: 0 }], 'protocol_stream_event_out_of_order'],
    [
      'unknown event',
      [
        { event_type: 'interaction.created', interaction: { id: 'private-provider-detail', status: 'in_progress', model } },
        { event_type: 'private-provider-detail', error: 'private-provider-detail' }
      ],
      'protocol_stream_event_unknown'
    ],
    [
      'unfinished step',
      [
        { event_type: 'interaction.created', interaction: { id: 'private-provider-detail', status: 'in_progress', model } },
        { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
        { event_type: 'interaction.completed', interaction: { id: 'private-provider-detail', model, status: 'completed', usage } }
      ],
      'protocol_stream_step_unfinished'
    ],
    [
      'mismatched delta',
      [
        { event_type: 'interaction.created', interaction: { id: 'private-provider-detail', status: 'in_progress', model } },
        { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
        { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'private-provider-detail' } }
      ],
      'protocol_stream_delta_step_mismatch'
    ]
  ] as const)('distinguishes %s without exposing provider data in failure diagnostics', async (_name, events, providerErrorCode) => {
    const wire = `${events.map(value => `event: ${value.event_type}\ndata: ${JSON.stringify(value)}`).join('\n\n')}\n\n`
    const service = createGeminiInteractionsService({
      apiKey: 'private-provider-detail',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model,
      fetch: (async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch,
      timeoutMs: 10_000
    })
    const consume = async (): Promise<void> => {
      try {
        const response = await service.chat({ chatPrompt: [{ role: 'user', content: 'private-provider-detail' }], model }, { stream: true })
        if (!(response instanceof ReadableStream)) throw new Error('Expected stream')
        for await (const chunk of response) void chunk
      } catch (error) {
        const failure = classifyAgentExecutionFailure(error, 'provider_stream')
        expect(failure.diagnostics).toEqual({ transportKind: 'gemini-api', providerErrorCode })
        expect(JSON.stringify(failure)).not.toContain('private-provider-detail')
        throw failure
      }
    }
    await expect(consume()).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      stage: 'provider_stream',
      message: 'Agent inference failed',
      diagnostics: { transportKind: 'gemini-api', providerErrorCode }
    })
  })

  it('keeps reported usage available before rejecting missing, unsafe, or oversized presentation metadata', async () => {
    const invalidSteps = [
      groundedInteraction({
        steps: groundedInteraction().steps.map(step =>
          step.type === 'model_output' ? { type: 'model_output', content: [{ type: 'text', text: 'Alpha' }] } : step
        )
      }),
      groundedInteraction({
        steps: groundedInteraction().steps.map(step =>
          step.type === 'model_output'
            ? { type: 'model_output', content: [{ type: 'text', text: 'Alpha', annotations: [{ ...annotation, url: 'javascript:alert(1)' }] }] }
            : step
        )
      }),
      groundedInteraction({
        steps: groundedInteraction().steps.map(step =>
          step.type === 'model_output'
            ? { type: 'model_output', content: [{ type: 'text', text: 'Alpha', annotations: [{ ...annotation, title: 'x'.repeat(1_025) }] }] }
            : step
        )
      }),
      groundedInteraction({
        steps: groundedInteraction().steps.map(step =>
          step.type === 'google_search_result' ? { ...step, result: [{ search_suggestions: 'x'.repeat(32_769) }] } : step
        )
      })
    ]
    for (const interaction of invalidSteps) {
      const service = createGeminiInteractionsService({
        apiKey: 'test-key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model,
        fetch: (async () => jsonResponse(interaction)) as typeof globalThis.fetch,
        timeoutMs: 10_000,
        googleSearchEnabled: true
      })
      const response = await service.chat({ chatPrompt: [{ role: 'user', content: 'search' }], model }, { stream: false })
      if (response instanceof ReadableStream) throw new Error('Expected buffered response')
      expect(readAgentProviderUsage('gemini-api', response)).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
      expect(() => readGeminiGoogleSearchGrounding(response.results[0]!)).toThrow()
    }
  })
  it('retains native search and host-tool context across an internal engine turn', async () => {
    type NativePayload = { input: unknown[]; tools?: unknown[]; generation_config: { tool_choice: unknown } }
    const payloads: NativePayload[] = []
    const interactions = [
      {
        model,
        status: 'requires_action',
        usage,
        steps: [
          groundedSteps()[0],
          groundedSteps()[1],
          {
            type: 'function_call',
            id: 'host_call_1',
            signature: 'host-call-signature',
            name: 'wiki_get_page',
            arguments: { title: 'October 7' }
          }
        ]
      },
      {
        model,
        status: 'completed',
        usage,
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Final grounded synthesis' }] }]
      }
    ]
    const service = createGeminiInteractionsService({
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model,
      fetch: (async (_input: URL | RequestInfo, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as NativePayload)
        return jsonResponse(interactions.shift())
      }) as typeof globalThis.fetch,
      timeoutMs: 10_000,
      googleSearchEnabled: true
    })
    const first = resultOf(
      await service.chat(
        {
          chatPrompt: [{ role: 'user', content: 'Research then use the host tool' }],
          model,
          functions: [{ name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object' } }]
        },
        { stream: false }
      )
    )
    const activePrompt = [
      {
        role: 'assistant' as const,
        functionCalls: first.functionCalls,
        thoughtBlocks: first.thoughtBlocks
      },
      { role: 'function' as const, functionId: 'host_call_1', result: '{"title":"October 7","extract":"evidence"}' }
    ]
    const final = resultOf(
      await service.chat(
        {
          chatPrompt: [{ role: 'user', content: 'Research then use the host tool' }, ...activePrompt],
          model
        },
        { stream: false }
      )
    )
    const combined = combineGeminiInteractionState(activePrompt, final.thoughtBlocks![0]!)
    const replayService = createGeminiInteractionsService({
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model,
      fetch: (async (_input: URL | RequestInfo, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as NativePayload)
        return jsonResponse({
          model,
          status: 'completed',
          usage,
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Follow-up answer' }] }]
        })
      }) as typeof globalThis.fetch,
      timeoutMs: 10_000
    })
    await replayService.chat(
      {
        chatPrompt: [
          { role: 'user', content: 'Research then use the host tool' },
          { role: 'assistant', content: final.content, thoughtBlocks: [combined] },
          { role: 'user', content: 'What did you conclude?' }
        ],
        model
      },
      { stream: false }
    )

    expect(payloads[1]).toMatchObject({
      tools: [{ type: 'google_search' }],
      generation_config: { tool_choice: 'validated' }
    })
    expect(payloads[2]).not.toHaveProperty('tools')
    expect(payloads[2]).toHaveProperty('generation_config.tool_choice', 'none')

    const replay = payloads[2]!.input as Array<Record<string, unknown>>
    expect(replay.map(step => step.type)).toEqual([
      'user_input',
      'google_search_call',
      'google_search_result',
      'function_call',
      'function_result',
      'model_output',
      'user_input'
    ])
    expect(replay[1]).toMatchObject({ id: 'search_1', signature: 'search-call-signature' })
    expect(replay[2]).toMatchObject({ call_id: 'search_1', signature: 'search-result-signature', result: [{}] })
    expect(replay[3]).toMatchObject({ id: 'host_call_1', signature: 'host-call-signature' })
    expect(replay[4]).toMatchObject({ call_id: 'host_call_1', name: 'wiki_get_page' })
    expect(replay[5]).toMatchObject({ content: [{ text: 'Final grounded synthesis' }] })
  })
})
