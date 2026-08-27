import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import createKnex, { type Knex } from 'knex'
import type { LookupAddress } from 'node:dns'
import type { AxChatRequest } from '@ax-llm/ax'
import { AgentProviderFactory } from '../../agents/providers/factory.ts'
import { createOpenResponsesFetch } from '../../agents/providers/openresponses.ts'
import { createGeminiInteractionsService } from '../../agents/providers/gemini-interactions.ts'

const publicResolver = async (): Promise<LookupAddress[]> => [{ address: '93.184.216.34', family: 4 }]
const capabilities = { streaming: false, toolCalling: 'prompt', parallelToolCalls: false, structuredOutput: 'prompt-only', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }

describe('additional provider transports', () => {
  let db: Knex
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary(); table.string('transportKind'); table.string('model'); table.string('baseUrl'); table.string('authMode'); table.string('secretReference'); table.text('adapterConfig'); table.text('capabilities'); table.string('capabilityRevision'); table.string('pricingRevision'); table.boolean('conformed')
    })
  })
  afterEach(async () => db.destroy())

  const insert = async (values: { id: string; transportKind: string; baseUrl: string; authMode: string }): Promise<void> => {
    await db('agentProviderProfileVersions').insert({
      ...values,
      model: 'model-test',
      secretReference: 'env:TRANSPORT_TEST_KEY',
      adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {} }),
      capabilities: JSON.stringify(capabilities),
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1',
      conformed: true
    })
  }

  it('runs OpenResponses through the storage-off Responses protocol', async () => {
    const id = '00000000-0000-4000-8000-000000000011'
    await insert({ id, transportKind: 'openresponses', baseUrl: 'https://openresponses.example.test/v1', authMode: 'bearer' })
    await db('agentProviderProfileVersions').where({ id }).update({ capabilities: JSON.stringify({ ...capabilities, toolCalling: 'native', parallelToolCalls: true }) })
    let payload: Record<string, unknown> = {}
    const fetchImplementation = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ id: 'resp_1', object: 'response', created_at: 1, status: 'completed', error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model: 'model-test', parallel_tool_calls: false, previous_response_id: null, output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'open', annotations: [] }] }], usage: { input_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3 } })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const response = await provider.service.chat({
      chatPrompt: [{ role: 'user', content: 'hello' }],
      functions: [{ name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Page ID' } } } }]
    }, { stream: false })
    expect(response).not.toBeInstanceOf(ReadableStream)
    expect(payload).toMatchObject({ store: false, previous_response_id: null, parallel_tool_calls: true, tools: [{ type: 'function', name: 'wiki_get_page', strict: false }] })
    expect(payload.include).toContain('reasoning.encrypted_content')
  })

  it('maps Anthropic native tools, tool use, and tool results', async () => {
    const id = '00000000-0000-4000-8000-000000000012'
    await insert({ id, transportKind: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', authMode: 'anthropic-api-key' })
    await db('agentProviderProfileVersions').where({ id }).update({ capabilities: JSON.stringify({ ...capabilities, toolCalling: 'native', parallelToolCalls: true }) })
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const fetchImplementation = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return requests.length === 1
        ? Response.json({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'wiki_get_page', input: { id: 42 } }], model: 'model-test', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } })
        : Response.json({ id: 'msg_2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'anthropic' }], model: 'model-test', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 1 } })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'anthropic-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const definition = { name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object' as const, properties: { id: { type: 'number' as const, description: 'Page ID' } } } }
    const first = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }], functions: [definition] }, { stream: false })
    if (first instanceof ReadableStream) throw new Error('Expected a buffered Anthropic response')
    const [call] = first.results[0]?.functionCalls ?? []
    expect(call).toMatchObject({ id: 'toolu_1', function: { name: 'wiki_get_page' } })
    await provider.service.chat({
      chatPrompt: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', functionCalls: call ? [call] : [] },
        { role: 'function', functionId: 'toolu_1', result: '{"id":42}' }
      ],
      functions: [definition]
    }, { stream: false })
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(requests[0]?.headers.get('x-api-key')).toBe('anthropic-key')
    expect(requests[0]?.headers.get('anthropic-version')).toBeTruthy()
    expect(requests[0]?.body).toMatchObject({ tools: [{ name: 'wiki_get_page', input_schema: { type: 'object' } }] })
    expect(JSON.stringify(requests[1]?.body)).toContain('tool_result')
    expect(JSON.stringify(requests[1]?.body)).toContain('toolu_1')
  })

  it('streams Gemini Interactions tools with stateless exact-step continuation', async () => {
    const id = '00000000-0000-4000-8000-000000000015'
    await insert({ id, transportKind: 'gemini-api', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', authMode: 'google-api-key' })
    await db('agentProviderProfileVersions').where({ id }).update({
      model: 'gemini-3.7-flash',
      capabilities: JSON.stringify({ ...capabilities, streaming: true, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'native-json-schema', usage: 'stream' })
    })
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const firstSteps = [
      { type: 'thought', signature: 'opaque-signature' },
      { type: 'function_call', id: 'call_1', name: 'wiki_get_page', arguments: { id: 42 } },
      { type: 'function_call', id: 'call_2', name: 'wiki_list_tags', arguments: {} }
    ]
    const finalSteps = [{ type: 'model_output', content: [{ type: 'text', text: 'gemini' }] }]
    const stream = (interactionId: string, steps: readonly Record<string, unknown>[], usage: Record<string, number>): string => {
      const frames: string[] = [
        `event: interaction.created\ndata: ${JSON.stringify({ event_type: 'interaction.created', interaction: { id: interactionId, model: 'gemini-3.7-flash', status: 'in_progress' } })}`
      ]
      steps.forEach((step, index) => {
        if (step.type === 'thought') {
          frames.push(
            `event: step.start\ndata: ${JSON.stringify({ event_type: 'step.start', index, step: { type: 'thought' } })}`,
            `event: step.delta\ndata: ${JSON.stringify({ event_type: 'step.delta', index, delta: { type: 'thought_signature', signature: step.signature } })}`
          )
        } else if (step.type === 'function_call') {
          frames.push(
            `event: step.start\ndata: ${JSON.stringify({ event_type: 'step.start', index, step: { type: 'function_call', id: step.id, name: step.name } })}`,
            `event: step.delta\ndata: ${JSON.stringify({ event_type: 'step.delta', index, delta: { type: 'arguments_delta', arguments: JSON.stringify(step.arguments) } })}`
          )
        } else {
          frames.push(
            `event: step.start\ndata: ${JSON.stringify({ event_type: 'step.start', index, step: { type: 'model_output' } })}`,
            `event: step.delta\ndata: ${JSON.stringify({ event_type: 'step.delta', index, delta: { type: 'text', text: 'gemini' } })}`
          )
        }
        frames.push(`event: step.stop\ndata: ${JSON.stringify({ event_type: 'step.stop', index })}`)
      })
      frames.push(
        `event: interaction.completed\ndata: ${JSON.stringify({ event_type: 'interaction.completed', interaction: { id: interactionId, model: 'gemini-3.7-flash', status: 'completed', steps, usage } })}`,
        'event: done\ndata: [DONE]'
      )
      return `${frames.join('\n\n')}\n\n`
    }
    const responses = [
      stream('interaction_1', firstSteps, { total_input_tokens: 3, total_output_tokens: 2, total_tokens: 5 }),
      stream('interaction_2', finalSteps, { total_input_tokens: 6, total_output_tokens: 1, total_tokens: 7 })
    ]
    const fetchImplementation = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(responses.shift(), { headers: { 'content-type': 'text/event-stream' } })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'gemini-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const definitions: NonNullable<AxChatRequest['functions']> = [
      { name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Page ID' } } } },
      { name: 'wiki_list_tags', description: 'List tags', parameters: { type: 'object', properties: {} } }
    ]
    const consume = async (value: Awaited<ReturnType<typeof provider.service.chat>>) => {
      if (!(value instanceof ReadableStream)) throw new Error('Expected a streaming Gemini Interactions response')
      const items = []
      for await (const item of value) items.push(item)
      return items
    }
    const first = await consume(await provider.service.chat({
      chatPrompt: [{ role: 'system', content: 'Use Wiki actions.' }, { role: 'user', content: 'hello' }],
      functions: definitions,
      functionCall: 'auto',
      responseFormat: { type: 'json_schema', schema: { type: 'object' } }
    }, { stream: true }))
    const calls = first.flatMap(item => item.results.flatMap(result => result.functionCalls ?? []))
    const rawState = first.flatMap(item => item.results.flatMap(result => result.thoughtBlocks ?? [])).at(-1)
    expect(calls).toMatchObject([
      { id: 'call_1', function: { name: 'wiki_get_page', params: { id: 42 } } },
      { id: 'call_2', function: { name: 'wiki_list_tags', params: {} } }
    ])
    expect(rawState).toMatchObject({ encrypted: true })
    expect(rawState?.data).toContain('wiki.gemini.interactions.v1:')
    if (!rawState) throw new Error('Gemini Interactions did not return its continuation state')
    const continuation = provider.preserveThoughtBlock('', rawState)
    if (!continuation) throw new Error('Gemini Interactions continuation state was not preserved')
    const final = await consume(await provider.service.chat({
      chatPrompt: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', functionCalls: calls, thoughtBlocks: [continuation] },
        { role: 'function', functionId: 'call_1', result: '{"id":42}' },
        { role: 'function', functionId: 'call_2', result: '[]' }
      ],
      functions: definitions
    }, { stream: true }))
    expect(final.flatMap(item => item.results).map(result => result.content ?? '').join('')).toBe('gemini')
    expect(final.at(-1)?.modelUsage?.tokens).toMatchObject({ promptTokens: 6, completionTokens: 1, totalTokens: 7 })
    expect(requests.map(request => request.url)).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      'https://generativelanguage.googleapis.com/v1beta/interactions'
    ])
    expect(requests.every(request => request.headers.get('x-goog-api-key') === 'gemini-key')).toBe(true)
    expect(requests.every(request => !request.url.includes('gemini-key'))).toBe(true)
    expect(requests[0]?.body).toMatchObject({
      model: 'gemini-3.7-flash',
      store: false,
      stream: true,
      system_instruction: 'Use Wiki actions.',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ type: 'function', name: 'wiki_get_page' }, { type: 'function', name: 'wiki_list_tags' }],
      tool_choice: 'auto',
      response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object' } }
    })
    expect(requests[1]?.body).toMatchObject({
      store: false,
      input: [
        { type: 'user_input' },
        { type: 'thought', signature: 'opaque-signature' },
        { type: 'function_call', id: 'call_1', name: 'wiki_get_page', arguments: { id: 42 } },
        { type: 'function_call', id: 'call_2', name: 'wiki_list_tags', arguments: {} },
        { type: 'function_result', call_id: 'call_1', name: 'wiki_get_page' },
        { type: 'function_result', call_id: 'call_2', name: 'wiki_list_tags' }
      ]
    })
  })

  it('rejects a stored pre-3.x Gemini model before provider egress', async () => {
    const id = '00000000-0000-4000-8000-000000000016'
    await insert({ id, transportKind: 'gemini-api', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', authMode: 'google-api-key' })
    await db('agentProviderProfileVersions').where({ id }).update({ model: 'gemini-2.5-flash' })
    let called = false
    const fetchImplementation = async (): Promise<Response> => {
      called = true
      return Response.json({})
    }
    await expect(new AgentProviderFactory(db, { get: () => 'gemini-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_MODEL' })
    expect(called).toBe(false)
  })


  it('maps Chat Completions native tools, calls, and results', async () => {
    const id = '00000000-0000-4000-8000-000000000014'
    await insert({ id, transportKind: 'openai-chat', baseUrl: 'https://chat.example.test/v1', authMode: 'bearer' })
    await db('agentProviderProfileVersions').where({ id }).update({ capabilities: JSON.stringify({ ...capabilities, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'tool-result' }) })
    const payloads: Record<string, unknown>[] = []
    const fetchImplementation = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return payloads.length === 1
        ? Response.json({ id: 'chatcmpl_1', object: 'chat.completion', created: 1, model: 'model-test', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'wiki_get_page', arguments: '{"id":42}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })
        : Response.json({ id: 'chatcmpl_2', object: 'chat.completion', created: 2, model: 'model-test', choices: [{ index: 0, message: { role: 'assistant', content: 'chat' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'chat-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const definition = { name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object' as const, properties: { id: { type: 'number' as const, description: 'Page ID' } } } }
    const first = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }], functions: [definition] }, { stream: false })
    if (first instanceof ReadableStream) throw new Error('Expected a buffered Chat Completions response')
    const [call] = first.results[0]?.functionCalls ?? []
    expect(call).toMatchObject({ id: 'call_1', function: { name: 'wiki_get_page', params: '{"id":42}' } })
    await provider.service.chat({
      chatPrompt: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', functionCalls: call ? [call] : [] },
        { role: 'function', functionId: 'call_1', result: '{"id":42}' }
      ],
      functions: [definition]
    }, { stream: false })
    expect(payloads[0]).toMatchObject({ parallel_tool_calls: true, tools: [{ type: 'function', function: { name: 'wiki_get_page' } }] })
    expect(payloads[1]).toMatchObject({ messages: expect.arrayContaining([{ role: 'tool', tool_call_id: 'call_1', content: '{"id":42}' }]) })
  })

  it('keeps legacy completions buffered for prompt-emulated tools', async () => {
    const id = '00000000-0000-4000-8000-000000000013'
    await insert({ id, transportKind: 'legacy-completions', baseUrl: 'https://legacy.example.test/v1', authMode: 'api-key-header' })
    let payload: Record<string, unknown> = {}
    let headers = new Headers()
    const fetchImplementation = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      headers = new Headers(init?.headers)
      return Response.json({ choices: [{ text: 'legacy' }], usage: { prompt_tokens: 4, completion_tokens: 2 } })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'legacy-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const response = await provider.service.chat({ chatPrompt: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }] }, { stream: true })
    expect(response).not.toBeInstanceOf(ReadableStream)
    expect(payload).toMatchObject({ model: 'model-test', prompt: 'system: system\n\nuser: hello', stream: false })
    expect(headers.get('x-api-key')).toBe('legacy-key')
    if (!(response instanceof ReadableStream)) expect(response).toMatchObject({ results: [{ content: 'legacy' }], modelUsage: { tokens: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } } })
    await expect(provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }], functions: [{ name: 'pages.get', description: 'read' }] })).rejects.toMatchObject({ code: 'INVALID_LEGACY_PROMPT' })
  })
})

describe('OpenResponses protocol validation', () => {
  const request = (overrides: Record<string, unknown> = {}): RequestInit => ({
    method: 'POST',
    body: JSON.stringify({ model: 'model-test', input: [{ role: 'user', content: 'hello' }], store: false, stream: false, ...overrides })
  })

  it('rejects unknown request fields before provider egress', async () => {
    let calls = 0
    const transport = createOpenResponsesFetch(async () => {
      calls += 1
      return Response.json({})
    })
    await expect(transport('https://openresponses.example.test/v1/responses', request({ unsupported: true }))).rejects.toMatchObject({ code: 'INVALID_OPENRESPONSES_PROTOCOL' })
    expect(calls).toBe(0)
  })

  it('rejects malformed buffered responses before Ax parsing', async () => {
    const transport = createOpenResponsesFetch(async () => Response.json({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'model-test',
      output: [{ id: 'unknown_1', type: 'provider_private_item', status: 'completed' }]
    }))
    await expect(transport('https://openresponses.example.test/v1/responses', request())).rejects.toMatchObject({ code: 'INVALID_OPENRESPONSES_PROTOCOL' })
  })

  it('validates streaming event names, sequences, terminal response, and marker', async () => {
    const terminal = {
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'model-test',
      output: []
    }
    const validBody = [
      'event: response.in_progress',
      'data: {"type":"response.in_progress","sequence_number":0}',
      '',
      'event: response.completed',
      `data: ${JSON.stringify({ type: 'response.completed', sequence_number: 1, response: terminal })}`,
      '',
      'data: [DONE]',
      ''
    ].join('\n')
    const validTransport = createOpenResponsesFetch(async () => new Response(validBody, { headers: { 'content-type': 'text/event-stream' } }))
    await expect((await validTransport('https://openresponses.example.test/v1/responses', request({ stream: true }))).text()).resolves.toContain('[DONE]')

    const invalidBody = 'event: response.output_text.delta\ndata: {"type":"response.output_text.done","sequence_number":0}\n\n'
    const invalidTransport = createOpenResponsesFetch(async () => new Response(invalidBody, { headers: { 'content-type': 'text/event-stream' } }))
    await expect((await invalidTransport('https://openresponses.example.test/v1/responses', request({ stream: true }))).text()).rejects.toMatchObject({ code: 'INVALID_OPENRESPONSES_PROTOCOL' })
  })
})

describe('Gemini Interactions protocol validation', () => {
  const service = (implementation: typeof fetch) => createGeminiInteractionsService({
    apiKey: 'gemini-key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.7-flash',
    fetch: implementation,
    timeoutMs: 10_000
  })

  it('maps buffered text, usage, and encrypted continuation state', async () => {
    let body: Record<string, unknown> = {}
    const gemini = service((async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        id: 'interaction_buffered',
        model: 'gemini-3.7-flash',
        status: 'completed',
        steps: [
          { type: 'thought', signature: 'buffered-signature' },
          { type: 'model_output', content: [{ type: 'text', text: 'buffered' }] }
        ],
        usage: { total_input_tokens: 2, total_output_tokens: 1, total_tokens: 3 }
      })
    }) as typeof fetch)
    const response = await gemini.chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: false })
    if (response instanceof ReadableStream) throw new Error('Expected a buffered Gemini Interactions response')
    expect(body).toMatchObject({ model: 'gemini-3.7-flash', store: false, stream: false, generation_config: { thinking_summaries: 'none' } })
    expect(response).toMatchObject({
      remoteId: 'interaction_buffered',
      results: [{ content: 'buffered', thoughtBlocks: [{ encrypted: true }] }],
      modelUsage: { tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
    })
  })

  it('fails closed when a stream ends without the terminal marker', async () => {
    const body = [
      `event: interaction.created\ndata: ${JSON.stringify({ event_type: 'interaction.created', interaction: { id: 'interaction_incomplete', model: 'gemini-3.7-flash', status: 'in_progress' } })}`,
      `event: interaction.completed\ndata: ${JSON.stringify({ event_type: 'interaction.completed', interaction: { id: 'interaction_incomplete', model: 'gemini-3.7-flash', status: 'completed', steps: [], usage: { total_input_tokens: 1, total_output_tokens: 0, total_tokens: 1 } } })}`
    ].join('\n\n')
    const gemini = service((async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch)
    const response = await gemini.chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected a streaming Gemini Interactions response')
    await expect((async () => {
      for await (const item of response) void item
    })()).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
  })

  it('rejects corrupted stored Interactions steps before egress', async () => {
    let called = false
    const gemini = service((async () => {
      called = true
      return Response.json({})
    }) as typeof fetch)
    await expect(gemini.chat({
      chatPrompt: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'answer', thoughtBlocks: [{ data: 'wiki.gemini.interactions.v1:not-json', encrypted: true }] },
        { role: 'user', content: 'continue' }
      ]
    }, { stream: false })).rejects.toMatchObject({ code: 'AGENT_PROVIDER_STATE_CORRUPT' })
    expect(called).toBe(false)
  })
})
