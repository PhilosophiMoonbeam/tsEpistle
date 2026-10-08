import type { LookupAddress } from 'node:dns'
import { ax, axGlobals, f } from '@ax-llm/ax'
import createKnex, { type Knex } from 'knex'
import { z } from 'zod'
import { AgentProviderFactory, createGuardedProviderFetch, deriveAgentProviderResourceLimits } from '../../agents/providers/factory.ts'
import { createOpenResponsesFetch } from '../../agents/providers/openresponses.ts'
import { parsePromptToolCall, promptToolInstructions, promptToolResultMessage } from '../../agents/providers/prompt-tools.ts'
import { readAgentProviderUsage } from '../../agents/providers/usage.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

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
      table.string('utilityModel').nullable()
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
    ['openai-responses', 'https://responses.example.test/v1', 'model-test'],
    ['openresponses', 'https://openresponses.example.test/v1', 'model-test'],
    ['openai-chat', 'https://chat.example.test/v1', 'model-test'],
    ['anthropic-messages', 'https://anthropic.example.test/v1', 'claude-sonnet-4-6'],
    ['gemini-api', 'https://gemini.example.test/v1beta', 'gemini-3.7-flash'],
    ['legacy-completions', 'https://legacy.example.test/v1', 'model-test']
  ] as const)('keeps %s private payloads out of inherited and caller-enabled SDK logging without retrying a failed dispatch', async (transportKind, baseUrl, model) => {
    const id = '00000000-0000-4000-8000-000000000043'
    await insert({
      id, transportKind, baseUrl, model,
      authMode: transportKind === 'gemini-api' ? 'google-api-key' : transportKind === 'anthropic-messages' ? 'anthropic-api-key' : 'bearer'
    })
    let calls = 0
    const privateText = 'private transport prompt'
    const logger = vi.fn()
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const previousDebug = axGlobals.debug
    axGlobals.debug = true
    try {
      const provider = await new AgentProviderFactory(db, { get: () => 'private-transport-key' }, (async () => {
        calls++
        return Response.json({ error: { code: 'temporary_provider_failure', message: 'private provider response' } }, { status: 503 })
      }) as typeof fetch, publicResolver as never).create(id)
      expect(provider.service.getOptions()).toMatchObject({ debug: false, verbose: false })
      const request = { chatPrompt: [{ role: 'user' as const, content: privateText }] }
      // Global defaults, mutable service defaults and per-call overrides must
      // all stay below the host's private, single-dispatch accounting boundary.
      await expect(provider.service.chat(request, { stream: false, logger })).rejects.toThrow()
      provider.service.setOptions({ debug: true, verbose: true, logger, retry: { maxRetries: 3 } })
      expect(provider.service.getOptions()).toMatchObject({ debug: false, verbose: false, retry: { maxRetries: 0 } })
      await expect(provider.service.chat(request, { stream: false, debug: true, verbose: true, logger, retry: { maxRetries: 3 } })).rejects.toThrow()
      expect(calls).toBe(2)
      expect(logger).not.toHaveBeenCalled()
      expect(consoleLog).not.toHaveBeenCalled()
    } finally {
      axGlobals.debug = previousDebug
      consoleLog.mockRestore()
    }
  })

  it.each([
    ['openai-responses', 'https://api.openai.com/v1', 'gpt-4o'],
    ['openresponses', 'https://openresponses.example.test/v1', 'model-test'],
    ['openai-chat', 'https://chat.example.test/v1', 'model-test'],
    ['anthropic-messages', 'https://api.anthropic.com/v1', 'claude-sonnet-4-6']
  ] as const)('runs native structured Ax generation through spread-safe guarded %s metadata', async (transportKind, baseUrl, model) => {
    const id = '00000000-0000-4000-8000-000000000040'
    await insert({ id, transportKind, baseUrl, model, authMode: transportKind === 'anthropic-messages' ? 'anthropic-api-key' : 'bearer' })
    await db('agentProviderProfileVersions').where({ id }).update({
      capabilities: JSON.stringify({ ...capabilities, toolCalling: 'native', structuredOutput: 'native-json-schema' })
    })
    const requests: { url: string; body: Record<string, unknown> }[] = []
    const output = '{"claims":[{"evidenceId":"source-42","statement":"The threshold is 42."}],"unresolvedFacets":[1]}'
    const provider = await new AgentProviderFactory(db, { get: () => 'structured-key' }, (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      if (transportKind === 'anthropic-messages')
        return Response.json({
          id: 'msg_structured', type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text: output }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 9, output_tokens: 7 }
        })
      if (transportKind === 'openai-chat')
        return Response.json({
          id: 'chat_structured', object: 'chat.completion', created: 1, model,
          choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 }
        })
      return Response.json({
        id: 'resp_structured', object: 'response', created_at: 1, status: 'completed', error: null,
        incomplete_details: null, instructions: null, max_output_tokens: null, model,
        parallel_tool_calls: false, previous_response_id: null,
        output: [{ type: 'message', id: 'msg_structured', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: output, annotations: [] }] }],
        usage: { input_tokens: 9, output_tokens: 7, total_tokens: 16 }
      })
    }) as typeof fetch, publicResolver as never).create(id, { reasoningEffort: 'low' })
    const program = ax(f()
      .input('userRequest', f.string())
      .output('claims', f.object({ evidenceId: f.string(), statement: f.string() }).array())
      .output('unresolvedFacets', f.number().array())
      .useStructured().build(), { maxRetries: 0, maxSteps: 1, asyncMode: 'off', sampleCount: 1 })
    let admittedChats = 0
    const hostedService = {
      ...provider.service,
      chat: async (...args: Parameters<typeof provider.service.chat>) => {
        admittedChats++
        return provider.service.chat(...args)
      }
    }
    expect(await program.forward(hostedService, { userRequest: 'Report the threshold.' }, { stream: false, structuredOutputMode: 'native' })).toEqual({
      claims: [{ evidenceId: 'source-42', statement: 'The threshold is 42.' }], unresolvedFacets: [1]
    })
    expect(admittedChats).toBe(1)
    expect(requests).toHaveLength(1)
    const body = requests[0]!.body
    const format = z.object({ schema: z.unknown() })
    const schema = transportKind === 'anthropic-messages'
      ? z.object({ output_config: z.object({ format }) }).parse(body).output_config.format.schema
      : transportKind === 'openai-chat'
        ? z.object({ response_format: z.object({ json_schema: format }) }).parse(body).response_format.json_schema.schema
        : z.object({ text: z.object({ format }) }).parse(body).text.format.schema
    expect(schema).toMatchObject({
      type: 'object', required: ['claims', 'unresolvedFacets'], additionalProperties: false,
      properties: { claims: { type: 'array', items: {
        type: 'object', required: ['evidenceId', 'statement'], additionalProperties: false,
        properties: { evidenceId: { type: 'string' }, statement: { type: 'string' } }
      } } }
    })
    expect(body).not.toHaveProperty('tools')
    expect(provider.service.getLastUsedChatModel()).toBe(model)
    expect(program.getUsage()).toMatchObject([{ tokens: { promptTokens: 9, completionTokens: 7, totalTokens: 16 } }])
    if (transportKind === 'anthropic-messages') {
      expect(body.cache_control).toEqual({ type: 'ephemeral' })
      expect(body.output_config).toHaveProperty('effort', 'low')
    }
  })

  it.each([
    ['openai-responses', 'https://api.openai.com/v1'],
    ['openresponses', 'https://openresponses.example.test/v1'],
    ['openai-chat', 'https://chat.example.test/v1'],
    ['anthropic-messages', 'https://api.anthropic.com/v1'],
    ['gemini-api', 'https://generativelanguage.googleapis.com/v1beta'],
    ['legacy-completions', 'https://legacy.example.test/v1']
  ] as const)('rejects unadmitted non-chat operations and undeclared native schema on %s before egress', async (transportKind, baseUrl) => {
    const id = '00000000-0000-4000-8000-000000000041'
    await insert({ id, transportKind, baseUrl, authMode: 'bearer', model: transportKind === 'gemini-api' ? 'gemini-3.7-flash' : 'model-test' })
    let calls = 0
    const provider = await new AgentProviderFactory(db, { get: () => 'guard-key' }, (async () => {
      calls++
      throw new Error('Unadmitted operation reached the provider')
    }) as typeof fetch, publicResolver as never).create(id)
    await expect(provider.service.embed({ texts: ['private text'] })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER_OPERATION' })
    await expect(provider.service.transcribe({ audio: { data: 'AQID', format: 'wav' } })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER_OPERATION' })
    await expect(provider.service.speak({ text: 'private speech' })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER_OPERATION' })
    await expect(provider.service.openChatSession!({ chatPrompt: [{ role: 'user', content: 'private session' }] }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER_OPERATION' })
    const nativeProgram = ax(f().input('userRequest', f.string()).output('answerText', f.string()).useStructured().build(),
      { maxRetries: 0, maxSteps: 1, asyncMode: 'off' })
    await expect(nativeProgram.forward(provider.service, { userRequest: 'Private answer.' }, { structuredOutputMode: 'native' }))
      .rejects.toThrow()
    expect(calls).toBe(0)
  })

  it.each([
    ['openresponses', 'max'],
    ['anthropic-messages', 'minimal'],
    ['gemini-api', 'none'],
    ['legacy-completions', 'low'],
    ['openai-chat', 'invalid']
  ] as const)('rejects invalid default effort %s/%s without egress even when explicit profile effort exists', async (transportKind, effort) => {
    const id = '00000000-0000-4000-8000-000000000042'
    await insert({ id, transportKind, baseUrl: 'https://provider.example.test/v1', authMode: 'bearer', model: transportKind === 'gemini-api' ? 'gemini-3.7-flash' : 'model-test' })
    if (transportKind !== 'legacy-completions')
      await db('agentProviderProfileVersions').where({ id }).update({
        adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {}, agentReasoningEffort: 'low' })
      })
    let calls = 0
    const factory = new AgentProviderFactory(db, { get: () => 'override-key' }, (async () => {
      calls++
      throw new Error('Invalid override reached the provider')
    }) as typeof fetch, publicResolver as never)
    await expect(factory.create(id, { reasoningEffort: effort as never })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_REQUEST', status: 400 })
    expect(calls).toBe(0)
  })

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

  for (const model of ['gemini-3.8-live', 'gemini-omni-1.1-flash', 'lyria-3.5'])
    it(`rejects the non-chat Gemini model ${model} on the LLM factory without media fallback or egress`, async () => {
      const id = '00000000-0000-4000-8000-000000000016'
      await insert({ id, transportKind: 'gemini-api', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', authMode: 'google-api-key' })
      await db('agentProviderProfileVersions').where({ id }).update({ model })
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
    let bypassCalls = 0
    const bypass = (async () => {
      bypassCalls++
      throw new Error('Caller-supplied fetch must not bypass guarded dispatch')
    }) as typeof fetch
    provider.service.setOptions({
      fetch: bypass, corsProxy: 'https://unadmitted.example.test', retry: { maxRetries: 99 }, timeout: 99_999,
      includeRequestBodyInErrors: true, excludeContentFromTrace: false, customLabels: { workflow: 'guarded-native' }
    })
    expect(provider.service.getOptions()).toMatchObject({
      timeout: 10_000, retry: { maxRetries: 0 }, includeRequestBodyInErrors: false, excludeContentFromTrace: true,
      customLabels: { workflow: 'guarded-native' }
    })
    const definition = {
      name: 'wiki_get_page',
      description: 'Read a page',
      parameters: { type: 'object' as const, properties: { id: { type: 'number' as const, description: 'Page ID' } } }
    }
    const first = await provider.service.chat(
      { model: 'unadmitted-model', chatPrompt: [{ role: 'user', content: 'hello' }], functions: [definition], modelConfig: { maxTokens: 99_999 } },
      { stream: false, fetch: bypass, retry: { maxRetries: 99 }, corsProxy: 'https://unadmitted.example.test' }
    )
    expect(bypassCalls).toBe(0)
    expect(payloads[0]).toMatchObject({ model: 'model-test' })
    expect(payloads[0]?.max_completion_tokens ?? payloads[0]?.max_tokens).toBe(4_000)
    expect(provider.service.getLastUsedChatModel()).toBe('model-test')
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

  it.each(['model-test', 'gpt-5-mini'])('keeps %s legacy native prompts buffered and supports parsed-field Ax generation without native functions', async model => {
    const id = '00000000-0000-4000-8000-000000000013'
    await insert({ id, transportKind: 'legacy-completions', baseUrl: 'https://legacy.example.test/v1', authMode: 'api-key-header', model })
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
    expect(payloads[0]).toMatchObject({ model, prompt: 'system: system\n\nuser: hello', stream: false })
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
    expect(payloads[2]).toMatchObject({ model, stream: false })
    expect(payloads[2]?.prompt).toContain('<wiki-tool-result>')
    expect(payloads[2]?.prompt).not.toContain('Available action catalog')
    expect(final).toMatchObject({ results: [{ content: 'ACKNOWLEDGED receipt-42' }] })
    await expect(
      Promise.resolve(provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }], functions: [{ name: 'pages.get', description: 'read' }] }))
    ).rejects.toMatchObject({ code: 'INVALID_LEGACY_PROMPT' })
    expect(payloads).toHaveLength(3)
    const program = ax('userRequest:string -> answerText:string', { maxRetries: 0, maxSteps: 1, asyncMode: 'off' })
    expect(await program.forward({ ...provider.service }, { userRequest: 'Acknowledge the receipt.' }, { stream: false })).toEqual({
      answerText: 'ACKNOWLEDGED receipt-42'
    })
    expect(payloads).toHaveLength(4)
    expect(payloads[3]).not.toHaveProperty('tools')
    expect(provider.service.getLastUsedChatModel()).toBe(model)
    expect(program.getUsage()).toMatchObject([{ tokens: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } }])
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

describe('explicitly bound Google media egress', () => {
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta'
  const model = 'gemini-omni-flash-preview'
  const request = (overrides: Record<string, unknown> = {}): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': 'media-secret' },
    body: JSON.stringify({ model, input: [{ type: 'text', text: 'Generate' }], store: false, stream: false, background: false, ...overrides })
  })

  it('allows only the configured stateless Interactions model and endpoint, retaining API key headers and manual redirect policy', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const wire = Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        requests.push({ url: String(input), init: init || {} })
        return Response.json({ accepted: true })
      },
      { preconnect: () => {} }
    ) as typeof fetch
    const guard = createGuardedProviderFetch(baseUrl, 'google-interactions', {}, wire, publicResolver as never, undefined, undefined, model)
    const accepted = await guard(`${baseUrl}/interactions`, request())
    expect(await accepted.json()).toEqual({ accepted: true })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${baseUrl}/interactions`)
    expect(requests[0]?.init.redirect).toBe('manual')
    expect(requests[0]?.init.credentials).toBe('omit')
    expect(new Headers(requests[0]?.init.headers).get('x-goog-api-key')).toBe('media-secret')
    for (const path of [
      '/interactions/interaction_1',
      '/interactions?key=secret',
      '/interactions#fragment',
      '/models/gemini-omni-flash-preview:generateContent',
      '/models/gemini-omni-flash-preview:countTokens',
      '/models/gemini-2.5-flash:generateContent',
      '/files/file1'
    ])
      await expect(guard(`${baseUrl}${path}`, request())).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    for (const overrides of [
      { model: 'gemini-omni-1.1-flash' },
      { model: 'arbitrary-model' },
      { model: 'lyria-3.5' },
      { store: true },
      { stream: true },
      { background: true },
      { previous_interaction_id: 'interaction_1' },
      { continuation_token: 'token' },
      { tools: [] }
    ])
      await expect(guard(`${baseUrl}/interactions`, request(overrides))).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    for (const destination of [
      'https://evil.example/v1beta/interactions',
      'http://generativelanguage.googleapis.com/v1beta/interactions',
      'https://user@generativelanguage.googleapis.com/v1beta/interactions'
    ])
      await expect(guard(destination, request())).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    for (const init of [
      { ...request(), method: 'GET' },
      { ...request(), body: '{}' },
      { ...request(), body: new Uint8Array(8) },
      { ...request(), body: new FormData() },
      { ...request(), body: '{"model":' },
      { ...request(), headers: { 'content-type': 'text/plain', 'x-goog-api-key': 'secret' } },
      { ...request(), body: JSON.stringify({ model, input: 'x'.repeat(15 * 1_024 * 1_024), store: false, stream: false, background: false }) }
    ])
      await expect(guard(`${baseUrl}/interactions`, init)).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    await expect(guard(new Request(`${baseUrl}/interactions`, request()))).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    expect(requests).toHaveLength(1)
  })

  it('requires explicit model binding and an exact official base before forwarding credentials', async () => {
    let calls = 0
    const wire = Object.assign(
      async () => {
        calls++
        return Response.json({})
      },
      { preconnect: () => {} }
    ) as typeof fetch
    const unbound = createGuardedProviderFetch(baseUrl, 'google-interactions', {}, wire, publicResolver as never)
    await expect(unbound(`${baseUrl}/interactions`, request())).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    for (const base of ['https://proxy.example/v1beta', `${baseUrl}/`, `${baseUrl}?key=secret`]) {
      const guard = createGuardedProviderFetch(base, 'google-interactions', {}, wire, publicResolver as never, undefined, undefined, model)
      await expect(guard(`${new URL(base).origin}/v1beta/interactions`, request())).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    }
    expect(calls).toBe(0)
  })

  it('pins Gemini image generation and count to the selected alternate model while input-only guards cannot generate', async () => {
    let calls = 0
    const wire = Object.assign(
      async () => {
        calls++
        return Response.json({})
      },
      { preconnect: () => {} }
    ) as typeof fetch
    const selected = 'gemini-2.5-flash-image'
    const guard = createGuardedProviderFetch(baseUrl, 'gemini-media', {}, wire, publicResolver as never, undefined, undefined, selected, {
      generateModels: [selected],
      countModels: [selected],
      files: false
    })
    for (const method of ['generateContent', 'countTokens']) await guard(`${baseUrl}/models/${selected}:${method}`, { method: 'POST', body: '{}' })
    for (const other of ['gemini-3.1-flash-image', 'gemini-2.5-flash', 'arbitrary-model'])
      for (const method of ['generateContent', 'countTokens'])
        await expect(guard(`${baseUrl}/models/${other}:${method}`, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    await expect(guard(`${baseUrl}/models/${selected}:streamGenerateContent?alt=sse`, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
    await expect(guard(`${baseUrl}/models/${selected}:generateContent?key=secret`, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
    await expect(guard('https://generativelanguage.googleapis.com/upload/v1beta/files', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
    const input = createGuardedProviderFetch(baseUrl, 'gemini-media', {}, wire, publicResolver as never, undefined, undefined, undefined, {
      generateModels: [],
      countModels: ['gemini-2.5-flash'],
      files: true
    })
    await input(`${baseUrl}/models/gemini-2.5-flash:countTokens`, { method: 'POST', body: '{}' })
    await expect(input(`${baseUrl}/models/gemini-2.5-flash:generateContent`, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
    await expect(input(`${baseUrl}/models/gemini-2.5-pro:countTokens`, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
    const missingPolicy = createGuardedProviderFetch(baseUrl, 'gemini-media', {}, wire, publicResolver as never, undefined, undefined, selected)
    for (const path of [
      `${baseUrl}/models/${selected}:generateContent`,
      `${baseUrl}/models/${selected}:countTokens`,
      'https://generativelanguage.googleapis.com/upload/v1beta/files'
    ])
      await expect(missingPolicy(path, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    expect(calls).toBe(3)
  })

  it('rejects private or mixed DNS answers and disables unpinned preconnect for bound media', async () => {
    let calls = 0
    const wire = Object.assign(
      async () => {
        calls++
        return Response.json({})
      },
      {
        preconnect: () => {
          calls++
        }
      }
    ) as typeof fetch
    for (const addresses of [
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '10.0.0.1', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: '::1', family: 6 }],
      [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 }
      ],
      []
    ]) {
      const guard = createGuardedProviderFetch(baseUrl, 'google-interactions', {}, wire, (async () => addresses) as never, undefined, undefined, model)
      await expect(guard(`${baseUrl}/interactions`, request())).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
      expect(() => guard.preconnect(baseUrl)).toThrow()
    }
    expect(calls).toBe(0)
  })

  it('bounds bound-media response bytes even without a truthful Content-Length and cancels overflowing bodies', async () => {
    for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'application/json', 'content-length': '2' }] as Record<string, string>[]) {
      let cancelled = 0
      const wire = Object.assign(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(9))
              },
              cancel() {
                cancelled++
              }
            }),
            { headers }
          ),
        { preconnect: () => {} }
      ) as typeof fetch
      const guard = createGuardedProviderFetch(baseUrl, 'google-interactions', {}, wire, publicResolver as never, tinyProviderLimits(), undefined, model)
      const response = await guard(`${baseUrl}/interactions`, request())
      await expect(response.text()).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
      expect(cancelled).toBe(1)
    }
  })
})
