import type { LookupAddress } from 'node:dns'
import type { AxChatRequest } from '@ax-llm/ax'
import createKnex, { type Knex } from 'knex'
import { AgentProviderFactory, agentProviderCostMicros, createGuardedProviderFetch, deriveAgentProviderResourceLimits } from '../../agents/providers/factory.ts'
import { createGeminiInteractionsService, geminiInteractionCompactionPrefix } from '../../agents/providers/gemini-interactions.ts'
import { createOpenResponsesFetch } from '../../agents/providers/openresponses.ts'
import { parsePromptToolCall, promptToolInstructions, promptToolResultMessage } from '../../agents/providers/prompt-tools.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

const publicResolver = async (): Promise<LookupAddress[]> => [{ address: '93.184.216.34', family: 4 }]
const capabilities = {
  streaming: false,
  toolCalling: 'prompt',
  parallelToolCalls: false,
  structuredOutput: 'prompt-only',
  usage: 'terminal',
  cancellation: true,
  maxContextTokens: 100_000,
  maxOutputTokens: 4_000
}
const tinyProviderLimits = () => {
  const limits = deriveAgentProviderResourceLimits(1)
  return { ...limits, rawBodyBytes: 8, rawChunkBytes: 8 }
}

describe('additional provider transports', () => {
  let db: Knex
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.string('transportKind')
      table.string('model')
      table.string('baseUrl')
      table.string('authMode')
      table.string('secretReference')
      table.text('adapterConfig')
      table.text('capabilities')
      table.string('capabilityRevision')
      table.string('pricingRevision')
      table.boolean('conformed')
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
      pricingRevision: 'price-1|1000000|2000000',
      conformed: true
    })
  }

  it.each([
    ['openai-responses', '00000000-0000-4000-8000-000000000017', 'responses.example.test'],
    ['openresponses', '00000000-0000-4000-8000-000000000011', 'openresponses.example.test']
  ] as const)('runs %s through the storage-off Responses protocol with a no-tools native final', async (transportKind, id, host) => {
    const baseUrl = `https://${host}/v1`
    await insert({ id, transportKind, baseUrl, authMode: 'bearer' })
    await db('agentProviderProfileVersions')
      .where({ id })
      .update({
        adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {}, agentReasoningEffort: 'xhigh' }),
        capabilities: JSON.stringify({ ...capabilities, toolCalling: 'native', parallelToolCalls: true })
      })
    let payload: Record<string, unknown> = {}
    const payloads: Record<string, unknown>[] = []
    const fetchImplementation = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      payloads.push(payload)
      const actionTurn = payloads.length === 1
      return Response.json({
        id: actionTurn ? 'resp_1' : 'resp_2',
        object: 'response',
        created_at: 1,
        status: 'completed',
        error: null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        model: 'model-test',
        parallel_tool_calls: false,
        previous_response_id: null,
        output: actionTurn
          ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'wiki_get_page', arguments: '{"id":42}', status: 'completed' }]
          : [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'open', annotations: [] }] }],
        usage: {
          input_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 3
        }
      })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const response = await provider.service.chat(
      {
        chatPrompt: [{ role: 'user', content: 'hello' }],
        functions: [
          { name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Page ID' } } } }
        ]
      },
      { stream: false }
    )
    if (response instanceof ReadableStream) throw new Error('Expected a buffered Responses action response')
    const call = response.results[0]?.functionCalls?.[0]
    expect(call).toMatchObject({ id: 'call_1', function: { name: 'wiki_get_page' } })
    if (!call) throw new Error('Responses did not return the native action call')
    expect(payloads[0]).toMatchObject({
      store: false,
      previous_response_id: null,
      parallel_tool_calls: true,
      reasoning: { effort: 'xhigh' },
      tools: [{ type: 'function', name: 'wiki_get_page', strict: false }]
    })
    expect(payloads[0]?.include).toContain('reasoning.encrypted_content')
    await provider.service.chat(
      {
        chatPrompt: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', functionCalls: [call] },
          { role: 'function', functionId: call.id, result: '{"id":42}' }
        ]
      },
      { stream: false }
    )
    expect(payload).not.toHaveProperty('tools')
    expect(payload.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: call.id }))
    const firstContinuation = provider.preserveThoughtBlock('rs_1', { data: 'encrypted-reasoning', encrypted: true })
    const secondContinuation = provider.preserveThoughtBlock('rs_2', { data: 'encrypted-reasoning-2', encrypted: true })
    if (!firstContinuation || !secondContinuation) throw new Error('OpenResponses continuation state was not preserved')
    await provider.service.chat(
      {
        chatPrompt: [
          { role: 'assistant', content: 'draft', thoughtBlocks: [firstContinuation, secondContinuation] },
          { role: 'user', content: 'correct' }
        ]
      },
      { stream: false }
    )
    const continuationInput = payload.input
    expect(continuationInput).toContainEqual({
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      content: [],
      encrypted_content: 'encrypted-reasoning'
    })
    expect(continuationInput).toContainEqual({
      type: 'reasoning',
      id: 'rs_2',
      summary: [],
      content: [],
      encrypted_content: 'encrypted-reasoning-2'
    })
  })
  it('maps Anthropic native tools, tool use, and tool results', async () => {
    const id = '00000000-0000-4000-8000-000000000012'
    await insert({ id, transportKind: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', authMode: 'anthropic-api-key' })
    await db('agentProviderProfileVersions')
      .where({ id })
      .update({
        adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {}, agentReasoningEffort: 'high' }),
        capabilities: JSON.stringify({ ...capabilities, toolCalling: 'native', parallelToolCalls: true })
      })
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const fetchImplementation = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return requests.length === 1
        ? Response.json({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'wiki_get_page', input: { id: 42 } }],
            model: 'model-test',
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 2, output_tokens: 1 }
          })
        : Response.json({
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'anthropic' }],
            model: 'model-test',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 1 }
          })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'anthropic-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const definition = {
      name: 'wiki_get_page',
      description: 'Read a page',
      parameters: { type: 'object' as const, properties: { id: { type: 'number' as const, description: 'Page ID' } } }
    }
    const first = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }], functions: [definition] }, { stream: false })
    if (first instanceof ReadableStream) throw new Error('Expected a buffered Anthropic response')
    const [call] = first.results[0]?.functionCalls ?? []
    expect(call).toMatchObject({ id: 'toolu_1', function: { name: 'wiki_get_page' } })
    await provider.service.chat(
      {
        chatPrompt: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', functionCalls: call ? [call] : [] },
          { role: 'function', functionId: 'toolu_1', result: '{"id":42}' }
        ]
      },
      { stream: false }
    )
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(requests[0]?.headers.get('x-api-key')).toBe('anthropic-key')
    expect(requests[0]?.headers.get('anthropic-version')).toBeTruthy()
    expect(requests[0]?.body).toMatchObject({ output_config: { effort: 'high' }, tools: [{ name: 'wiki_get_page', input_schema: { type: 'object' } }] })
    expect(requests[1]?.body).not.toHaveProperty('tools')
    expect(JSON.stringify(requests[1]?.body)).toContain('tool_result')
    expect(JSON.stringify(requests[1]?.body)).toContain('toolu_1')
  })

  it('buffers Gemini Interactions action turns atomically with stateless exact-step continuation', async () => {
    const id = '00000000-0000-4000-8000-000000000015'
    await insert({ id, transportKind: 'gemini-api', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', authMode: 'google-api-key' })
    await db('agentProviderProfileVersions')
      .where({ id })
      .update({
        model: 'gemini-3.7-flash',
        adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {}, agentReasoningEffort: 'medium' }),
        capabilities: JSON.stringify({
          ...capabilities,
          streaming: true,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'stream'
        })
      })
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const firstSteps = [
      { type: 'thought', signature: 'opaque-signature' },
      { type: 'function_call', id: 'call_1', name: 'wiki_get_page', arguments: { id: 42 } },
      { type: 'function_call', id: 'call_2', name: 'wiki_list_tags', arguments: {} }
    ]
    const firstResponse = {
      id: '',
      model: 'gemini-3.7-flash',
      status: 'requires_action',
      steps: firstSteps,
      usage: { total_input_tokens: 3, total_output_tokens: 2, total_tokens: 5 }
    }
    const finalEvents = [
      { event_type: 'interaction.created', interaction: { id: 'interaction_final', model: 'gemini-3.7-flash', status: 'in_progress', object: 'interaction' } },
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [{ type: 'text', text: 'gemini' }] } },
      { event_type: 'step.stop', index: 0 },
      {
        event_type: 'interaction.completed',
        interaction: {
          id: 'interaction_final',
          status: 'completed',
          usage: { total_input_tokens: 6, total_output_tokens: 1, total_tokens: 7 }
        }
      }
    ]
    const finalBody = `${finalEvents.map(event => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}`).join('\n\n')}\n\nevent: done\ndata: [DONE]\n\n`
    const fetchImplementation = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return requests.length === 1 ? Response.json(firstResponse) : new Response(finalBody, { headers: { 'content-type': 'text/event-stream' } })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'gemini-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const definitions: NonNullable<AxChatRequest['functions']> = [
      { name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Page ID' } } } },
      { name: 'wiki_list_tags', description: 'List tags', parameters: { type: 'object', properties: {} } }
    ]
    const consume = async (value: Awaited<ReturnType<typeof provider.service.chat>>) => {
      if (value instanceof ReadableStream) throw new Error('Expected an atomic Gemini Interactions action response')
      return [value]
    }
    const first = await consume(
      await provider.service.chat(
        {
          chatPrompt: [
            { role: 'system', content: 'Use Wiki actions.' },
            { role: 'user', content: 'hello' }
          ],
          functions: definitions,
          functionCall: 'auto',
          responseFormat: { type: 'json_schema', schema: { type: 'object' } }
        },
        { stream: true }
      )
    )
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
    const finalResponse = await provider.service.chat(
      {
        chatPrompt: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', functionCalls: calls, thoughtBlocks: [continuation] },
          { role: 'function', functionId: 'call_1', result: '{"id":42}' },
          { role: 'function', functionId: 'call_2', result: '[]' }
        ]
      },
      { stream: true }
    )
    if (!(finalResponse instanceof ReadableStream)) throw new Error('Expected a streaming Gemini Interactions no-tools final')
    const final = await Array.fromAsync(finalResponse)
    expect(
      final
        .flatMap(item => item.results)
        .map(result => result.content ?? '')
        .join('')
    ).toBe('gemini')
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
      stream: false,
      system_instruction: 'Use Wiki actions.',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'hello' }] }],
      tools: [
        { type: 'function', name: 'wiki_get_page' },
        { type: 'function', name: 'wiki_list_tags' }
      ],
      response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object' } },
      generation_config: { thinking_level: 'medium', thinking_summaries: 'none', tool_choice: 'auto' }
    })
    expect(requests[0]?.body).not.toHaveProperty('tool_choice')
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
    expect(requests[1]?.body).not.toHaveProperty('tools')
    expect(requests[1]?.body).toMatchObject({ generation_config: { tool_choice: 'none' } })
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
    await expect(
      Promise.resolve(new AgentProviderFactory(db, { get: () => 'gemini-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id))
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_MODEL' })
    expect(called).toBe(false)
  })

  it('maps Chat Completions native tools, calls, and results', async () => {
    const id = '00000000-0000-4000-8000-000000000014'
    await insert({ id, transportKind: 'openai-chat', baseUrl: 'https://chat.example.test/v1', authMode: 'bearer' })
    await db('agentProviderProfileVersions')
      .where({ id })
      .update({
        adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {}, agentReasoningEffort: 'max' }),
        capabilities: JSON.stringify({ ...capabilities, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'tool-result' })
      })
    const payloads: Record<string, unknown>[] = []
    const fetchImplementation = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return payloads.length === 1
        ? Response.json({
            id: 'chatcmpl_1',
            object: 'chat.completion',
            created: 1,
            model: 'model-test',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'wiki_get_page', arguments: '{"id":42}' } }]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
          })
        : Response.json({
            id: 'chatcmpl_2',
            object: 'chat.completion',
            created: 2,
            model: 'model-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'chat' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }
          })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'chat-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const definition = {
      name: 'wiki_get_page',
      description: 'Read a page',
      parameters: { type: 'object' as const, properties: { id: { type: 'number' as const, description: 'Page ID' } } }
    }
    const first = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }], functions: [definition] }, { stream: false })
    if (first instanceof ReadableStream) throw new Error('Expected a buffered Chat Completions response')
    const [call] = first.results[0]?.functionCalls ?? []
    expect(call).toMatchObject({ id: 'call_1', function: { name: 'wiki_get_page', params: '{"id":42}' } })
    await provider.service.chat(
      {
        chatPrompt: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', functionCalls: call ? [call] : [] },
          { role: 'function', functionId: 'call_1', result: '{"id":42}' }
        ]
      },
      { stream: false }
    )
    expect(payloads[0]).toMatchObject({
      parallel_tool_calls: true,
      reasoning_effort: 'max',
      tools: [{ type: 'function', function: { name: 'wiki_get_page' } }]
    })
    expect(payloads[1]).toMatchObject({ messages: expect.arrayContaining([{ role: 'tool', tool_call_id: 'call_1', content: '{"id":42}' }]) })
    expect(payloads[1]).not.toHaveProperty('tools')
  })

  it('keeps legacy completions buffered for single-call prompt tool rounds without native functions', async () => {
    const id = '00000000-0000-4000-8000-000000000013'
    await insert({ id, transportKind: 'legacy-completions', baseUrl: 'https://legacy.example.test/v1', authMode: 'api-key-header' })
    const payloads: Record<string, unknown>[] = []
    let headers = new Headers()
    const fetchImplementation = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      payloads.push(payload)
      headers = new Headers(init?.headers)
      let text = 'ACKNOWLEDGED receipt-42'
      if (payloads.length === 1) text = 'legacy'
      else if (payloads.length === 2) text = '<wiki-tool-call>{"name":"wiki_get_page","arguments":{"id":42}}</wiki-tool-call>'
      return Response.json({ choices: [{ text }], usage: { prompt_tokens: 4, completion_tokens: 2 } })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'legacy-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const response = await provider.service.chat(
      {
        chatPrompt: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'hello' }
        ]
      },
      { stream: true }
    )
    expect(response).not.toBeInstanceOf(ReadableStream)
    expect(payloads[0]).toMatchObject({ model: 'model-test', prompt: 'system: system\n\nuser: hello', stream: false })
    expect(headers.get('x-api-key')).toBe('legacy-key')
    if (!(response instanceof ReadableStream))
      expect(response).toMatchObject({ results: [{ content: 'legacy' }], modelUsage: { tokens: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } } })

    const definition = {
      name: 'wiki_get_page',
      description: 'Read a page',
      parameters: { type: 'object' as const, properties: { id: { type: 'number' as const, description: 'Page ID' } } }
    }
    const toolTurn = await provider.service.chat(
      {
        chatPrompt: [
          { role: 'system', content: promptToolInstructions([definition]) },
          { role: 'user', content: 'Call wiki_get_page with ID 42.' }
        ]
      },
      { stream: true }
    )
    if (toolTurn instanceof ReadableStream) throw new Error('Legacy completions unexpectedly streamed prompt tools')
    const call = parsePromptToolCall(toolTurn.results[0]?.content ?? '', new Set([definition.name]))
    expect(call).toEqual({ name: 'wiki_get_page', params: { id: 42 } })
    if (!call) throw new Error('Legacy completions did not return the prompt action')
    const final = await provider.service.chat(
      {
        chatPrompt: [
          { role: 'system', content: 'No actions are available for this final response.' },
          { role: 'user', content: 'Use the action result and reply with its receipt.' },
          { role: 'assistant', content: toolTurn.results[0]?.content ?? '' },
          { role: 'user', content: promptToolResultMessage('legacy-call', call.name, { receipt: 'receipt-42' }) }
        ]
      },
      { stream: true }
    )
    expect(final).not.toBeInstanceOf(ReadableStream)
    expect(payloads[2]).toMatchObject({ model: 'model-test', stream: false })
    expect(payloads[2]?.prompt).toContain('<wiki-tool-result>')
    expect(payloads[2]?.prompt).not.toContain('Available action catalog')
    expect(final).toMatchObject({ results: [{ content: 'ACKNOWLEDGED receipt-42' }] })
    await expect(
      Promise.resolve(provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }], functions: [{ name: 'pages.get', description: 'read' }] }))
    ).rejects.toMatchObject({ code: 'INVALID_LEGACY_PROMPT' })
    expect(payloads).toHaveLength(3)
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
    await expect(Promise.resolve(transport('https://openresponses.example.test/v1/responses', request({ unsupported: true })))).rejects.toMatchObject({
      code: 'INVALID_OPENRESPONSES_PROTOCOL'
    })
    expect(calls).toBe(0)
  })

  it('rejects malformed buffered responses before Ax parsing', async () => {
    const transport = createOpenResponsesFetch(async () =>
      Response.json({
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'model-test',
        output: [{ id: 'unknown_1', type: 'provider_private_item', status: 'completed' }]
      })
    )
    await expect(Promise.resolve(transport('https://openresponses.example.test/v1/responses', request()))).rejects.toMatchObject({
      code: 'INVALID_OPENRESPONSES_PROTOCOL'
    })
  })

  it('rejects raw over-limit buffered JSON and SSE before protocol parsing', async () => {
    for (const stream of [false, true]) {
      let limitCalls = 0
      let cancelCalls = 0
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(new Uint8Array(9))
          },
          cancel() {
            cancelCalls += 1
            return Promise.reject(new Error('hostile transport cancellation'))
          }
        },
        { highWaterMark: 0 }
      )
      const guarded = createGuardedProviderFetch(
        'https://openresponses.example.test/v1',
        '/responses',
        {},
        (async () =>
          new Response(body, {
            headers: {
              'content-type': stream ? 'text/event-stream' : 'application/json',
              'content-length': 'false'
            }
          })) as typeof fetch,
        publicResolver as never,
        tinyProviderLimits(),
        () => {
          limitCalls += 1
        }
      )
      const transport = createOpenResponsesFetch(guarded)
      if (stream) {
        const response = await transport('https://openresponses.example.test/v1/responses', request({ stream: true }))
        await expect(Promise.resolve(response.text())).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
      } else {
        await expect(Promise.resolve(transport('https://openresponses.example.test/v1/responses', request()))).rejects.toMatchObject({
          code: 'INVALID_OPENRESPONSES_PROTOCOL'
        })
      }
      expect(limitCalls).toBe(1)
      expect(cancelCalls).toBe(1)
      expect(body.locked).toBe(false)
    }
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
    expect(await (await validTransport('https://openresponses.example.test/v1/responses', request({ stream: true }))).text()).toContain('[DONE]')

    const invalidBody = 'event: response.output_text.delta\ndata: {"type":"response.output_text.done","sequence_number":0}\n\n'
    const invalidTransport = createOpenResponsesFetch(async () => new Response(invalidBody, { headers: { 'content-type': 'text/event-stream' } }))
    await expect(
      Promise.resolve((await invalidTransport('https://openresponses.example.test/v1/responses', request({ stream: true }))).text())
    ).rejects.toMatchObject({ code: 'INVALID_OPENRESPONSES_PROTOCOL' })
  })
})

describe('Gemini Interactions protocol validation', () => {
  const service = (implementation: typeof fetch, model = 'gemini-3.7-flash') =>
    createGeminiInteractionsService({
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model,
      fetch: implementation,
      timeoutMs: 10_000,
      streamRetryDelayMs: 0
    })

  it('accepts the documented initially empty thought signature and waits for terminal usage', async () => {
    const events = [
      {
        event_type: 'interaction.created',
        interaction: { id: 'interaction_thought', model: 'gemini-3.7-flash', status: 'in_progress', object: 'interaction' }
      },
      { event_type: 'step.start', index: 0, step: { type: 'thought', signature: '' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'opaque-signature' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [{ type: 'text', text: 'Hello' }] } },
      { event_type: 'step.stop', index: 1 },
      {
        event_type: 'interaction.completed',
        interaction: {
          id: 'interaction_thought',
          status: 'completed',
          usage: { total_input_tokens: 1, total_output_tokens: 1, total_thought_tokens: 1, total_tokens: 3 }
        }
      }
    ]
    const body = `${events.map(event => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}`).join('\n\n')}\n\nevent: done\ndata: [DONE]\n\n`
    const gemini = service((async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch)
    const response = await gemini.chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected streaming response')
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    expect(chunks[0]?.results[0]?.content).toBe('Hello')
    expect(chunks.at(-1)?.modelUsage?.tokens?.totalTokens).toBe(3)
  })

  it('places required native tool selection inside generation_config', async () => {
    let body: Record<string, unknown> = {}
    const gemini = service((async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        model: 'gemini-3.7-flash',
        status: 'requires_action',
        steps: [{ type: 'function_call', id: 'call', name: 'lookup', arguments: {} }],
        usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 }
      })
    }) as typeof fetch)
    await gemini.chat(
      {
        chatPrompt: [{ role: 'user', content: 'Look up the answer' }],
        functions: [{ name: 'lookup', description: 'Look up the answer', parameters: { type: 'object', properties: {} } }],
        functionCall: 'required'
      },
      { stream: false }
    )
    expect(body).not.toHaveProperty('tool_choice')
    expect(body.generation_config).toMatchObject({ tool_choice: 'any', thinking_summaries: 'none' })
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
    await expect(
      Promise.resolve(
        (async () => {
          for await (const item of response) void item
        })()
      )
    ).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      agentDiagnostics: { transportKind: 'gemini-api', providerErrorCode: 'protocol_stream_missing_terminal' }
    })
  })

  it('retries one transient error emitted before an interaction is created', async () => {
    const error = `event: error\ndata: ${JSON.stringify({ event_type: 'error', error: { code: 'service_unavailable', message: 'retry later' } })}\n\n`
    const events = [
      {
        event_type: 'interaction.created',
        interaction: { id: 'interaction_retry', model: 'gemini-3.7-flash', status: 'in_progress' }
      },
      { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Recovered' } },
      { event_type: 'step.stop', index: 0 },
      {
        event_type: 'interaction.completed',
        interaction: {
          id: 'interaction_retry',
          status: 'completed',
          usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 }
        }
      }
    ]
    const success = `${events.map(event => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}`).join('\n\n')}\n\nevent: done\ndata: [DONE]\n\n`
    const responses = [error, success]
    const fetchImplementation = vi.fn(async () => new Response(responses.shift(), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await service(fetchImplementation as typeof fetch).chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected streaming response')
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(
      chunks
        .flatMap(chunk => chunk.results)
        .map(result => result.content ?? '')
        .join('')
    ).toBe('Recovered')
  })

  it('returns the classified failure when the single retry also fails', async () => {
    const error = `event: error\ndata: ${JSON.stringify({ event_type: 'error', error: { code: 'gateway_timeout', message: 'retry later' } })}\n\n`
    const fetchImplementation = vi.fn(async () => new Response(error, { headers: { 'content-type': 'text/event-stream' } }))
    const response = await service(fetchImplementation as typeof fetch).chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected streaming response')
    await expect(
      Promise.resolve(
        (async () => {
          for await (const item of response) void item
        })()
      )
    ).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      status: 504,
      agentDiagnostics: { transportKind: 'gemini-api', providerErrorCode: 'gateway_timeout' }
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('does not retry after the response stream is cancelled during backoff', async () => {
    const error = `event: error\ndata: ${JSON.stringify({ event_type: 'error', error: { code: 'service_unavailable' } })}\n\n`
    const fetchImplementation = vi.fn(async () => new Response(error, { headers: { 'content-type': 'text/event-stream' } }))
    const response = await createGeminiInteractionsService({
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3.7-flash',
      fetch: fetchImplementation as typeof fetch,
      timeoutMs: 10_000,
      streamRetryDelayMs: 60_000
    }).chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected streaming response')
    await new Promise(resolve => setTimeout(resolve, 0))
    await response.cancel(new Error('consumer cancelled'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('does not retry after the caller aborts during backoff', async () => {
    const error = `event: error\ndata: ${JSON.stringify({ event_type: 'error', error: { code: 'service_unavailable' } })}\n\n`
    const fetchImplementation = vi.fn(async () => new Response(error, { headers: { 'content-type': 'text/event-stream' } }))
    const abortController = new AbortController()
    const response = await createGeminiInteractionsService({
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3.7-flash',
      fetch: fetchImplementation as typeof fetch,
      timeoutMs: 10_000,
      streamRetryDelayMs: 60_000
    }).chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: true, abortSignal: abortController.signal })
    if (!(response instanceof ReadableStream)) throw new Error('Expected streaming response')
    const reader = response.getReader()
    const reading = reader.read()
    await new Promise(resolve => setTimeout(resolve, 0))
    abortController.abort(new Error('caller aborted'))
    await expect(reading).rejects.toThrow('caller aborted')
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('classifies nontransient and post-creation stream errors without retrying', async () => {
    for (const testCase of [
      { code: 'invalid_request', expectedCode: 'PROVIDER_REQUEST_REJECTED', status: 400, created: false },
      { code: 'service_unavailable', expectedCode: 'PROVIDER_UNAVAILABLE', status: 503, created: true }
    ] as const) {
      const frames = [
        ...(testCase.created
          ? [
              `event: interaction.created\ndata: ${JSON.stringify({
                event_type: 'interaction.created',
                interaction: { id: 'interaction_failed', model: 'gemini-3.7-flash', status: 'in_progress' }
              })}`
            ]
          : []),
        `event: error\ndata: ${JSON.stringify({ event_type: 'error', error: { code: testCase.code, message: 'safe test message' } })}`
      ]
      const fetchImplementation = vi.fn(async () => new Response(`${frames.join('\n\n')}\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
      const response = await service(fetchImplementation as typeof fetch).chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: true })
      if (!(response instanceof ReadableStream)) throw new Error('Expected streaming response')
      await expect(
        Promise.resolve(
          (async () => {
            for await (const item of response) void item
          })()
        )
      ).rejects.toMatchObject({
        code: testCase.expectedCode,
        status: testCase.status,
        agentDiagnostics: { transportKind: 'gemini-api', providerErrorCode: testCase.code }
      })
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    }
  })

  it('accepts live stateless empty interaction IDs without manufacturing a remote ID', async () => {
    const events = [
      { event_type: 'interaction.created', interaction: { id: '', model: 'gemini-3.7-flash', status: 'in_progress', object: 'interaction' } },
      { event_type: 'interaction.status_update', interaction_id: '', status: 'in_progress' },
      { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Hello' } },
      { event_type: 'step.stop', index: 0 },
      {
        event_type: 'interaction.completed',
        interaction: { id: '', model: 'gemini-3.7-flash', status: 'completed', usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 } }
      }
    ]
    const body = `${events.map(event => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}`).join('\n\n')}\n\nevent: done\ndata: [DONE]\n\n`
    const gemini = service((async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch)
    const response = await gemini.chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: true })
    if (!(response instanceof ReadableStream)) throw new Error('Expected streaming response')
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    expect(chunks[0]?.results[0]?.content).toBe('Hello')
    expect(chunks.at(-1)?.modelUsage?.tokens?.totalTokens).toBe(2)
    expect(chunks.every(chunk => chunk.remoteId === undefined && chunk.results.every(result => result.id === undefined))).toBe(true)
  })

  it('accepts omitted stateless buffered IDs', async () => {
    const gemini = service((async () =>
      Response.json({
        model: 'gemini-3.7-flash',
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hello' }] }],
        usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 }
      })) as typeof fetch)
    const response = await gemini.chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: false })
    if (response instanceof ReadableStream) throw new Error('Expected buffered response')
    expect(response.remoteId).toBeUndefined()
    expect(response.results[0]?.id).toBeUndefined()
    expect(response.results[0]?.content).toBe('Hello')
  })

  it('accepts live non-grounding invocation metadata while forcing native action turns to be atomic', async () => {
    const model = 'gemini-3.8-flash'
    const usage = {
      total_input_tokens: 47,
      total_output_tokens: 14,
      total_tokens: 108,
      total_cached_tokens: 0,
      total_tool_use_tokens: 0,
      total_thought_tokens: 47,
      raw_prompt_token: 87,
      input_tokens_by_modality: [{ modality: 'text', tokens: 47 }],
      model_invocation_token_counts: [
        {
          prompt_tokens_details: [{ modality: 'text', tokens: 87 }],
          candidates_tokens_details: [{ modality: 'text', tokens: 20 }],
          thoughts_tokens_details: [{ modality: 'text', tokens: 47 }]
        }
      ],
      non_grounding_model_invocation_token_counts: [
        {
          prompt_tokens_details: [{ modality: 'text', tokens: 87 }],
          candidates_tokens_details: [{ modality: 'text', tokens: 20 }],
          thoughts_tokens_details: [{ modality: 'text', tokens: 47 }]
        }
      ]
    }
    const toolStep = { type: 'function_call', id: 'wiki-call', name: 'wiki_get_page', arguments: { id: 42 } }
    const expectedToolCall = [{ id: 'wiki-call', type: 'function', function: { name: 'wiki_get_page', params: { id: 42 } } }]
    const expectedTokens = { promptTokens: 47, completionTokens: 14, totalTokens: 108 }
    const request: AxChatRequest = {
      chatPrompt: [{ role: 'user', content: 'Look up the page' }],
      functions: [
        {
          name: 'wiki_get_page',
          description: 'Read a page',
          parameters: { type: 'object', properties: { id: { type: 'number', description: 'Page ID' } } }
        }
      ]
    }
    expect(
      agentProviderCostMicros(
        { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 },
        expectedTokens.promptTokens,
        expectedTokens.completionTokens,
        expectedTokens.totalTokens
      )
    ).toBe(169)

    const bufferedGemini = service(
      (async () =>
        Response.json({
          model,
          status: 'requires_action',
          steps: [{ type: 'thought', signature: 'buffered-signature' }, toolStep],
          usage
        })) as typeof fetch,
      model
    )
    const buffered = await bufferedGemini.chat(request, { stream: false })
    if (buffered instanceof ReadableStream) throw new Error('Expected buffered response')
    expect(buffered.results[0]?.functionCalls).toEqual(expectedToolCall)
    expect(buffered.modelUsage?.tokens).toEqual(expectedTokens)

    let requestedStream: unknown
    const atomicGemini = service(
      (async (_input, init) => {
        requestedStream = JSON.parse(String(init?.body)).stream
        return Response.json({
          model,
          status: 'requires_action',
          steps: [{ type: 'thought', signature: 'atomic-signature' }, toolStep],
          usage
        })
      }) as typeof fetch,
      model
    )
    const atomic = await atomicGemini.chat(request, { stream: true })
    if (atomic instanceof ReadableStream) throw new Error('Expected an atomic action response')
    expect(requestedStream).toBe(false)
    expect(atomic.results[0]?.functionCalls).toEqual(expectedToolCall)
    expect(atomic.modelUsage?.tokens).toEqual(expectedTokens)
  })

  it('rejects oversized non-grounding invocation metadata', async () => {
    const gemini = service((async () =>
      Response.json({
        model: 'gemini-3.7-flash',
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hello' }] }],
        usage: {
          total_input_tokens: 1,
          total_output_tokens: 1,
          total_tokens: 2,
          non_grounding_model_invocation_token_counts: Array.from({ length: 65 }, () => ({
            prompt_tokens_details: [{ modality: 'text', tokens: 1 }]
          }))
        }
      })) as typeof fetch)
    await expect(gemini.chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: false })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE'
    })
  })

  it('accepts a stateless buffered empty ID while retaining nonempty tool call IDs', async () => {
    for (const callId of ['valid-call', '']) {
      const gemini = service((async () =>
        Response.json({
          id: '',
          model: 'gemini-3.7-flash',
          status: 'requires_action',
          steps: [{ type: 'function_call', id: callId, name: 'lookup', arguments: {} }],
          usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 }
        })) as typeof fetch)
      const response = gemini.chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: false })
      if (!callId) {
        await expect(response).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
        continue
      }
      const result = await response
      if (result instanceof ReadableStream) throw new Error('Expected buffered response')
      expect(result.remoteId).toBeUndefined()
      expect(result.results[0]?.id).toBeUndefined()
      expect(result.results[0]?.functionCalls?.[0]?.id).toBe('valid-call')
    }
  })

  it('replays authoritative visible history when an intact combined continuation has stale presentation text', async () => {
    let body: Record<string, unknown> = {}
    const gemini = service((async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        model: 'gemini-3.7-flash',
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Created a draft.' }] }],
        usage: { total_input_tokens: 3, total_output_tokens: 1, total_tokens: 4 }
      })
    }) as typeof fetch)
    const providerContent = 'Provider answer.'
    const publishedContent = `${providerContent}\n\nPartial context coverage: one result was omitted.`
    const combinedState = {
      data: `wiki.gemini.interactions.v1:${JSON.stringify({
        steps: [
          { type: 'user_input', content: [{ type: 'text', text: 'Analyze the template.' }] },
          { type: 'model_output', content: [{ type: 'text', text: providerContent }] }
        ],
        assistantStepStart: 1
      })}`,
      encrypted: true
    }
    expect(geminiInteractionCompactionPrefix({ role: 'assistant', content: publishedContent, thoughtBlocks: [combinedState] })).toEqual([])
    await gemini.chat(
      {
        chatPrompt: [
          { role: 'user', content: 'Analyze the template.' },
          { role: 'assistant', content: publishedContent, thoughtBlocks: [combinedState] },
          { role: 'user', content: 'Create the updated template as a new page.' }
        ]
      },
      { stream: false }
    )
    expect(body.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'Analyze the template.' }] },
      { type: 'model_output', content: [{ type: 'text', text: publishedContent }] },
      { type: 'user_input', content: [{ type: 'text', text: 'Create the updated template as a new page.' }] }
    ])
  })

  it('still rejects a mismatched active-turn continuation before egress', async () => {
    let called = false
    const gemini = service((async () => {
      called = true
      return Response.json({})
    }) as typeof fetch)
    const activeState = {
      data: `wiki.gemini.interactions.v1:${JSON.stringify({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Provider answer.' }] }],
        assistantStepStart: 0
      })}`,
      encrypted: true
    }
    await expect(
      gemini.chat(
        {
          chatPrompt: [
            { role: 'user', content: 'Analyze the template.' },
            { role: 'assistant', content: 'Modified answer.', thoughtBlocks: [activeState] },
            { role: 'user', content: 'Continue.' }
          ]
        },
        { stream: false }
      )
    ).rejects.toMatchObject({ code: 'AGENT_PROVIDER_STATE_CORRUPT' })
    expect(called).toBe(false)
  })

  it('does not discard a stale combined continuation when its presentation slice contains an action call', async () => {
    let called = false
    const gemini = service((async () => {
      called = true
      return Response.json({})
    }) as typeof fetch)
    const callBearingState = {
      data: `wiki.gemini.interactions.v1:${JSON.stringify({
        steps: [
          { type: 'user_input', content: [{ type: 'text', text: 'Analyze the template.' }] },
          { type: 'function_call', id: 'call-1', name: 'wiki_get_page', arguments: { id: 181 } },
          { type: 'model_output', content: [{ type: 'text', text: 'Visible answer.' }] }
        ],
        assistantStepStart: 1
      })}`,
      encrypted: true
    }
    await expect(
      gemini.chat(
        {
          chatPrompt: [
            { role: 'user', content: 'Analyze the template.' },
            { role: 'assistant', content: 'Visible answer.', thoughtBlocks: [callBearingState] },
            { role: 'user', content: 'Continue.' }
          ]
        },
        { stream: false }
      )
    ).rejects.toMatchObject({ code: 'AGENT_PROVIDER_STATE_CORRUPT' })
    expect(called).toBe(false)
  })

  it('rejects corrupted stored Interactions steps before egress', async () => {
    let called = false
    const gemini = service((async () => {
      called = true
      return Response.json({})
    }) as typeof fetch)
    await expect(
      Promise.resolve(
        gemini.chat(
          {
            chatPrompt: [
              { role: 'user', content: 'hello' },
              { role: 'assistant', content: 'answer', thoughtBlocks: [{ data: 'wiki.gemini.interactions.v1:not-json', encrypted: true }] },
              { role: 'user', content: 'continue' }
            ]
          },
          { stream: false }
        )
      )
    ).rejects.toMatchObject({ code: 'AGENT_PROVIDER_STATE_CORRUPT' })
    expect(called).toBe(false)
  })
})
