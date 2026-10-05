import type { LookupAddress } from 'node:dns'
import type { AxChatRequest } from '@ax-llm/ax'
import createKnex, { type Knex } from 'knex'
import { AgentProviderFactory, createGuardedProviderFetch, deriveAgentProviderResourceLimits } from '../../agents/providers/factory.ts'
import { createOpenResponsesFetch } from '../../agents/providers/openresponses.ts'
import { parsePromptToolCall, promptToolInstructions, promptToolResultMessage } from '../../agents/providers/prompt-tools.ts'
import { readAgentProviderUsage } from '../../agents/providers/usage.ts'
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

  const insert = async (values: { id: string; transportKind: string; baseUrl: string; authMode: string; model?: string }): Promise<void> => {
    await db('agentProviderProfileVersions').insert({
      ...values,
      model: values.model ?? 'model-test',
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
    expect(provider.preserveCachePrefix).toBe(true)
    expect(provider.pricing.cacheWritePremium).toBe(true)
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
    expect(requests[0]?.body).toMatchObject({
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'high' },
      tools: [{ name: 'wiki_get_page', input_schema: { type: 'object' } }]
    })
    expect(requests[1]?.body).not.toHaveProperty('tools')
    expect(requests[1]?.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"id":42}' }])
        })
      ])
    )
  })
  it('enables cache-aware prefix retention and write pricing only for recognized official transports', async () => {
    const profiles = [
      {
        id: '00000000-0000-4000-8000-000000000021',
        transportKind: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        authMode: 'bearer',
        model: 'gpt-5.6-terra',
        preserveCachePrefix: true,
        cacheWritePremium: true
      },
      {
        id: '00000000-0000-4000-8000-000000000022',
        transportKind: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        authMode: 'bearer',
        model: 'gpt-5.5',
        preserveCachePrefix: true,
        cacheWritePremium: false
      },
      {
        id: '00000000-0000-4000-8000-000000000023',
        transportKind: 'openresponses',
        baseUrl: 'https://api.openai.com/v1',
        authMode: 'bearer',
        model: 'gpt-5.6-terra',
        preserveCachePrefix: false,
        cacheWritePremium: false
      },
      {
        id: '00000000-0000-4000-8000-000000000024',
        transportKind: 'openai-responses',
        baseUrl: 'https://openai.compat.test/v1',
        authMode: 'bearer',
        model: 'gpt-5.6-terra',
        preserveCachePrefix: false,
        cacheWritePremium: false
      },
      {
        id: '00000000-0000-4000-8000-000000000025',
        transportKind: 'legacy-completions',
        baseUrl: 'https://api.openai.com/v1',
        authMode: 'bearer',
        model: 'gpt-5.6-terra',
        preserveCachePrefix: false,
        cacheWritePremium: false
      },
      {
        id: '00000000-0000-4000-8000-000000000026',
        transportKind: 'gemini-api',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        authMode: 'google-api-key',
        model: 'gemini-3.8-flash',
        preserveCachePrefix: true,
        cacheWritePremium: false
      },
      {
        id: '00000000-0000-4000-8000-000000000027',
        transportKind: 'gemini-api',
        baseUrl: 'https://gemini.compat.test/v1beta',
        authMode: 'google-api-key',
        model: 'gemini-3.8-flash',
        preserveCachePrefix: false,
        cacheWritePremium: false
      },
      {
        id: '00000000-0000-4000-8000-000000000028',
        transportKind: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com/proxy/v1',
        authMode: 'anthropic-api-key',
        model: 'claude-test',
        preserveCachePrefix: false,
        cacheWritePremium: false
      }
    ] as const
    const factory = new AgentProviderFactory(db, { get: () => 'transport-key' }, undefined, publicResolver as never)
    for (const profile of profiles) {
      const { preserveCachePrefix, cacheWritePremium, ...settings } = profile
      await insert(settings)
      const provider = await factory.create(profile.id)
      expect(provider.preserveCachePrefix).toBe(preserveCachePrefix)
      expect(provider.pricing.cacheWritePremium).toBe(cacheWritePremium ? true : undefined)
    }
  })
  it('keeps official Responses caching implicit without adding cache extension fields', async () => {
    const id = '00000000-0000-4000-8000-000000000031'
    await insert({
      id,
      transportKind: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      authMode: 'bearer',
      model: 'gpt-5.6-terra'
    })
    let requestBody: Record<string, unknown> | undefined
    let cachedTokenCount: number | undefined = 0
    const fetchImplementation = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        id: 'resp_implicit',
        object: 'response',
        created_at: 1,
        status: 'completed',
        error: null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        model: 'gpt-5.6-terra',
        parallel_tool_calls: false,
        previous_response_id: null,
        output: [
          { type: 'message', id: 'msg_implicit', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'implicit', annotations: [] }] }
        ],
        usage: {
          input_tokens: 2,
          input_tokens_details: cachedTokenCount === undefined ? {} : { cached_tokens: cachedTokenCount },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 3
        }
      })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'openai-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const usage = async () => {
      const response = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }] }, { stream: false })
      if (response instanceof ReadableStream) throw new Error('Expected buffered Responses output')
      return readAgentProviderUsage('openai-responses', response)
    }
    expect(await usage()).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 })
    cachedTokenCount = undefined
    expect(await usage()).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 })
    cachedTokenCount = 1
    expect(await usage()).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3, cachedInputTokens: 1 })
    expect(provider.preserveCachePrefix).toBe(true)
    expect(provider.pricing.cacheWritePremium).toBe(true)
    expect(requestBody).not.toHaveProperty('prompt_cache_options')
    expect(requestBody).not.toHaveProperty('prompt_cache_key')
    expect(requestBody).not.toHaveProperty('prompt_cache_retention')
  })

  it('rejects a stored non-chat Gemini model before provider egress', async () => {
    const id = '00000000-0000-4000-8000-000000000016'
    await insert({ id, transportKind: 'gemini-api', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', authMode: 'google-api-key' })
    await db('agentProviderProfileVersions').where({ id }).update({ model: 'gemini-3.8-live' })
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
      return Response.json({ choices: [{ text }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })
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
  it('preserves legacy reported totals and does not fabricate usage for absent or malformed receipts', async () => {
    const id = '00000000-0000-4000-8000-000000000030'
    await insert({ id, transportKind: 'legacy-completions', baseUrl: 'https://legacy.example.test/v1', authMode: 'api-key-header' })
    const replies: Array<{ readonly usage?: unknown }> = [
      { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 99 } },
      {},
      { usage: { prompt_tokens: 4, completion_tokens: '2', total_tokens: 6 } }
    ]
    const fetchImplementation = async (): Promise<Response> => {
      const reply = replies.shift()
      if (!reply) throw new Error('No legacy test response remains')
      return Response.json({ choices: [{ text: 'legacy' }], ...(reply.usage === undefined ? {} : { usage: reply.usage }) })
    }
    const provider = await new AgentProviderFactory(db, { get: () => 'legacy-key' }, fetchImplementation as typeof fetch, publicResolver as never).create(id)
    const request = { chatPrompt: [{ role: 'user' as const, content: 'hello' }] }
    const reported = await provider.service.chat(request, { stream: false })
    expect(reported).toMatchObject({ modelUsage: { tokens: { promptTokens: 4, completionTokens: 2, totalTokens: 99 } } })
    const missing = await provider.service.chat(request, { stream: false })
    expect(missing).not.toHaveProperty('modelUsage')
    await expect(Promise.resolve(provider.service.chat(request, { stream: false }))).rejects.toMatchObject({ code: 'PROVIDER_USAGE_INVALID' })
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

    const eventFrame = (type: string, sequence: number, response?: Record<string, unknown>): string =>
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...(response === undefined ? {} : { response }) })}`
    const completedFrame = eventFrame('response.completed', 1, terminal)
    const doneFrame = 'data: [DONE]'
    for (const frames of [
      // A matching but unsupported event isolates the event-membership guard.
      [eventFrame('response.provider_private', 0), completedFrame, doneFrame],
      // Equal and decreasing sequences otherwise have a valid terminal and marker.
      [eventFrame('response.in_progress', 1), completedFrame, doneFrame],
      [eventFrame('response.in_progress', 2), completedFrame, doneFrame],
      [
        eventFrame('response.in_progress', 0),
        eventFrame('response.completed', 1, { ...terminal, output: [{ id: 'unknown_1', type: 'provider_private_item', status: 'completed' }] }),
        doneFrame
      ],
      // A marker without a terminal response must fail before EOF.
      [doneFrame],
      // A valid terminal response cannot substitute for the required marker.
      [eventFrame('response.in_progress', 0), completedFrame]
    ]) {
      const body = `${frames.join('\n\n')}\n\n`
      const transport = createOpenResponsesFetch(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
      await expect(
        Promise.resolve((await transport('https://openresponses.example.test/v1/responses', request({ stream: true }))).text())
      ).rejects.toMatchObject({ code: 'INVALID_OPENRESPONSES_PROTOCOL' })
    }
  })
})
