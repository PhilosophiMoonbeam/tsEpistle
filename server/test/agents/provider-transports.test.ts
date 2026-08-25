import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import createKnex, { type Knex } from 'knex'
import type { LookupAddress } from 'node:dns'
import { AgentProviderFactory } from '../../agents/providers/factory.ts'
import { createOpenResponsesFetch } from '../../agents/providers/openresponses.ts'

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
      functions: [{ name: 'pages_get', description: 'Read a page', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Page ID' } } } }]
    }, { stream: false })
    expect(response).not.toBeInstanceOf(ReadableStream)
    expect(payload).toMatchObject({ store: false, previous_response_id: null, parallel_tool_calls: true, tools: [{ type: 'function', name: 'pages_get', strict: false }] })
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
        ? Response.json({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'pages_get', input: { id: 42 } }], model: 'model-test', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } })
        : Response.json({ id: 'msg_2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'anthropic' }], model: 'model-test', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 1 } })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'anthropic-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const definition = { name: 'pages_get', description: 'Read a page', parameters: { type: 'object' as const, properties: { id: { type: 'number' as const, description: 'Page ID' } } } }
    const first = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }], functions: [definition] }, { stream: false })
    if (first instanceof ReadableStream) throw new Error('Expected a buffered Anthropic response')
    const [call] = first.results[0]?.functionCalls ?? []
    expect(call).toMatchObject({ id: 'toolu_1', function: { name: 'pages_get' } })
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
    expect(requests[0]?.body).toMatchObject({ tools: [{ name: 'pages_get', input_schema: { type: 'object' } }] })
    expect(JSON.stringify(requests[1]?.body)).toContain('tool_result')
    expect(JSON.stringify(requests[1]?.body)).toContain('toolu_1')
  })


  it('maps Chat Completions native tools, calls, and results', async () => {
    const id = '00000000-0000-4000-8000-000000000014'
    await insert({ id, transportKind: 'openai-chat', baseUrl: 'https://chat.example.test/v1', authMode: 'bearer' })
    await db('agentProviderProfileVersions').where({ id }).update({ capabilities: JSON.stringify({ ...capabilities, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'tool-result' }) })
    const payloads: Record<string, unknown>[] = []
    const fetchImplementation = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return payloads.length === 1
        ? Response.json({ id: 'chatcmpl_1', object: 'chat.completion', created: 1, model: 'model-test', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'pages_get', arguments: '{"id":42}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })
        : Response.json({ id: 'chatcmpl_2', object: 'chat.completion', created: 2, model: 'model-test', choices: [{ index: 0, message: { role: 'assistant', content: 'chat' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'chat-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const definition = { name: 'pages_get', description: 'Read a page', parameters: { type: 'object' as const, properties: { id: { type: 'number' as const, description: 'Page ID' } } } }
    const first = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }], functions: [definition] }, { stream: false })
    if (first instanceof ReadableStream) throw new Error('Expected a buffered Chat Completions response')
    const [call] = first.results[0]?.functionCalls ?? []
    expect(call).toMatchObject({ id: 'call_1', function: { name: 'pages_get', params: '{"id":42}' } })
    await provider.service.chat({
      chatPrompt: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', functionCalls: call ? [call] : [] },
        { role: 'function', functionId: 'call_1', result: '{"id":42}' }
      ],
      functions: [definition]
    }, { stream: false })
    expect(payloads[0]).toMatchObject({ parallel_tool_calls: true, tools: [{ type: 'function', function: { name: 'pages_get' } }] })
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
