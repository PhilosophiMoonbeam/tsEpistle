import type { AxChatResponse, AxChatResponseResult, AxFunctionJSONSchema } from '@ax-llm/ax'
import { z } from 'zod'
import { ACTION_CATALOG } from '../../agents/actions/catalog.ts'
import { combineGeminiInteractionState, createGeminiInteractionsService, readGeminiGoogleSearchGrounding } from '../../agents/providers/gemini-interactions.ts'
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

describe('Gemini Interactions Google Search grounding', () => {
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
        return jsonResponse(groundedInteraction())
      }) as typeof globalThis.fetch
    })
    // Ax's parameter type omits the valid root unions produced by the action catalog.
    const parameters = z.toJSONSchema(ACTION_CATALOG['pages.get'].input) as AxFunctionJSONSchema
    const result = resultOf(
      await service.chat(
        {
          model,
          chatPrompt: [{ role: 'user', content: 'Look up this page and verify its release date on the web.' }],
          functions: [{ name: 'wiki_get_page', description: 'Read a Wiki page by ID or path.', parameters }],
          functionCall: 'auto'
        },
        { stream: false }
      )
    )
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
      ['interaction.completed', { interaction: { id: '', model, status: 'completed', usage }, event_type: 'interaction.completed' }]
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
    expect(readAgentProviderUsage(terminal)).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    expect(readGeminiGoogleSearchGrounding(terminal.results[0]!)).toEqual({
      citations: [{ url: 'https://grounding.example.test/source', title: 'Example source', startIndex: 0, endIndex: 5 }],
      searchSuggestions: ['<a>query</a>']
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
      expect(readAgentProviderUsage(response)).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
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
