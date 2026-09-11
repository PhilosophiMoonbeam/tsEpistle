import { afterEach, describe, expect, it } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import type { LookupAddress } from 'node:dns'
import {
  AgentProviderAttemptError,
  AgentProviderFactory,
  agentProviderCostMicros,
  createGuardedProviderFetch,
  decodeAgentProviderContinuation,
  deriveAgentProviderResourceLimits,
  encodeAgentProviderContinuation
} from '../../agents/providers/factory.ts'
import { AgentExecutionFailure, classifyAgentExecutionFailure } from '../../agents/providers/execution-failure.ts'
import { readAgentProviderUsage, readAgentUsageEvent } from '../../agents/providers/usage.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'

const publicResolver = async (): Promise<LookupAddress[]> => [{ address: '93.184.216.34', family: 4 }]
const privateResolver = async (): Promise<LookupAddress[]> => [{ address: '127.0.0.1', family: 4 }]
const tinyProviderLimits = () => {
  const limits = deriveAgentProviderResourceLimits(1)
  return { ...limits, rawBodyBytes: 8, rawChunkBytes: 8 }
}

const openAIResponsesStream = (
  responseId: string,
  usage: { readonly input_tokens: number; readonly output_tokens: number; readonly total_tokens: number },
  output: readonly Record<string, unknown>[] = []
): string => {
  const response = {
    id: responseId,
    object: 'response',
    created_at: 1,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: 'gpt-test',
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    usage
  }
  const frames = [
    `event: response.created\ndata: ${JSON.stringify({
      type: 'response.created',
      response: { id: responseId, object: 'response', created_at: 1, status: 'in_progress', model: 'gpt-test' }
    })}`
  ]
  for (const item of output) {
    frames.push(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}`)
    frames.push(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}`)
  }
  frames.push(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}`, 'data: [DONE]')
  return `${frames.join('\n\n')}\n\n`
}

describe('guarded provider fetch', () => {
  it('allows only the configured HTTPS endpoint and rejects private DNS results', async () => {
    let called = 0
    const implementation = async (): Promise<Response> => {
      called++
      return Response.json({ ok: true })
    }
    const guarded = createGuardedProviderFetch('https://provider.example.test/v1', '/responses', {}, implementation as typeof fetch, publicResolver as never)
    await expect(Promise.resolve(guarded('https://other.example.test/v1/responses'))).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    await expect(Promise.resolve(guarded('https://provider.example.test/v1/chat/completions'))).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    const privateGuarded = createGuardedProviderFetch(
      'https://provider.example.test/v1',
      '/responses',
      {},
      implementation as typeof fetch,
      privateResolver as never
    )
    await expect(Promise.resolve(privateGuarded('https://provider.example.test/v1/responses'))).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    expect(called).toBe(0)
  })

  it('allows only the exact Gemini Interactions endpoint', async () => {
    let called = 0
    const implementation = async (): Promise<Response> => {
      called++
      return Response.json({ ok: true })
    }
    const guarded = createGuardedProviderFetch(
      'https://generativelanguage.googleapis.com/v1beta',
      '/interactions',
      {},
      implementation as typeof fetch,
      publicResolver as never
    )
    expect(await guarded('https://generativelanguage.googleapis.com/v1beta/interactions')).toBeInstanceOf(Response)
    await expect(Promise.resolve(guarded('https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse'))).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
    await expect(Promise.resolve(guarded('https://generativelanguage.googleapis.com/v1beta/interactions/interaction_1'))).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
    await expect(Promise.resolve(guarded('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent'))).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
    await expect(Promise.resolve(guarded('https://other.example.test/v1beta/interactions'))).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    expect(called).toBe(1)
  })

  it('blocks redirects and exposes only bounded retry metadata for provider failures', async () => {
    const redirect = createGuardedProviderFetch(
      'https://provider.example.test/v1',
      '/responses',
      {},
      (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })) as typeof fetch,
      publicResolver as never
    )
    await expect(Promise.resolve(redirect('https://provider.example.test/v1/responses'))).rejects.toMatchObject({
      code: 'PROVIDER_REDIRECT_DENIED',
      status: 302
    })
    const failed = createGuardedProviderFetch(
      'https://provider.example.test/v1',
      '/responses',
      {},
      (async () =>
        Response.json({ error: { code: 'rate_limit', message: 'secret provider detail' } }, { status: 429, headers: { 'retry-after': '2' } })) as typeof fetch,
      publicResolver as never
    )
    const error = (await failed('https://provider.example.test/v1/responses').catch(error => error)) as AgentProviderAttemptError
    expect(error).toMatchObject({ code: 'rate_limit', status: 429, retryAfterMilliseconds: 2_000, retryable: true, message: 'Provider request failed' })
    expect(JSON.stringify(error)).not.toContain('secret provider detail')
    const invalid = createGuardedProviderFetch(
      'https://provider.example.test/v1',
      '/responses',
      {},
      (async () =>
        Response.json({ error: { code: 'unsupported_value', param: 'temperature', message: 'Unsupported value' } }, { status: 400 })) as typeof fetch,
      publicResolver as never
    )
    await expect(Promise.resolve(invalid('https://provider.example.test/v1/responses'))).rejects.toMatchObject({
      code: 'unsupported_value',
      status: 400,
      parameter: 'temperature',
      message: 'Provider request failed'
    })
    const googleFailure = createGuardedProviderFetch(
      'https://provider.example.test/v1',
      '/responses',
      {},
      (async () => Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'secret provider detail' } }, { status: 429 })) as typeof fetch,
      publicResolver as never
    )
    await expect(Promise.resolve(googleFailure('https://provider.example.test/v1/responses'))).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
      status: 429,
      message: 'Provider request failed'
    })
  })
  it('accepts exact UTF-8 raw limits with missing and nonnumeric content lengths', async () => {
    const exact = new TextEncoder().encode('€€ab')
    expect(exact.byteLength).toBe(8)
    for (const contentLength of [undefined, 'false']) {
      let limitCalls = 0
      const guarded = createGuardedProviderFetch(
        'https://provider.example.test/v1',
        '/responses',
        {},
        (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(exact)
                controller.close()
              }
            }),
            {
              headers: {
                'content-type': 'application/json',
                ...(contentLength === undefined ? {} : { 'content-length': contentLength })
              }
            }
          )) as typeof fetch,
        publicResolver as never,
        tinyProviderLimits(),
        () => {
          limitCalls += 1
        }
      )
      const response = await guarded('https://provider.example.test/v1/responses')
      expect(await response.text()).toBe('€€ab')
      expect(limitCalls).toBe(0)
    }
  })

  it('rejects the next raw byte before downstream parsing and bounds open-source cancel/release once', async () => {
    let cancelCalls = 0
    let limitCalls = 0
    const cancellation = new AbortController()
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new Uint8Array(9))
        },
        cancel() {
          cancelCalls += 1
          return Promise.reject(new Error('hostile raw cancel'))
        }
      },
      { highWaterMark: 0 }
    )
    const guarded = createGuardedProviderFetch(
      'https://provider.example.test/v1',
      '/responses',
      {},
      (async () => new Response(body, { headers: { 'content-type': 'application/json', 'content-length': 'false' } })) as typeof fetch,
      publicResolver as never,
      tinyProviderLimits(),
      error => {
        limitCalls += 1
        cancellation.abort(error)
      }
    )
    const response = await guarded('https://provider.example.test/v1/responses', { signal: cancellation.signal })
    await expect(Promise.resolve(response.text())).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    expect(cancellation.signal.aborted).toBe(true)
    expect(limitCalls).toBe(1)
    expect(cancelCalls).toBe(1)
    expect(body.locked).toBe(false)
  })

  it('cuts off an endless raw stream at the body ceiling without waiting for hostile cancel', async () => {
    let produced = 0
    let cancelCalls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          produced += 1
          controller.enqueue(new Uint8Array([0x61]))
        },
        cancel() {
          cancelCalls += 1
          return new Promise<void>(() => {})
        }
      },
      { highWaterMark: 0 }
    )
    const guarded = createGuardedProviderFetch(
      'https://provider.example.test/v1',
      '/responses',
      {},
      (async () => new Response(body, { headers: { 'content-type': 'application/json' } })) as typeof fetch,
      publicResolver as never,
      tinyProviderLimits()
    )
    const response = await guarded('https://provider.example.test/v1/responses')
    await expect(Promise.resolve(response.text())).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    expect(produced).toBe(9)
    expect(cancelCalls).toBe(1)
    expect(body.locked).toBe(false)
  })

  it('rejects an already-closed raw source without invoking cancellation and releases its reader', async () => {
    let cancelCalls = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9))
        controller.close()
      },
      cancel() {
        cancelCalls += 1
      }
    })
    const guarded = createGuardedProviderFetch(
      'https://provider.example.test/v1',
      '/responses',
      {},
      (async () => new Response(body, { headers: { 'content-type': 'application/json', 'content-length': 'false' } })) as typeof fetch,
      publicResolver as never,
      tinyProviderLimits()
    )
    const response = await guarded('https://provider.example.test/v1/responses')
    await expect(Promise.resolve(response.text())).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    expect(cancelCalls).toBe(0)
    expect(body.locked).toBe(false)
  })
  it('rejects a declared over-limit body before constructing a downstream stream', async () => {
    let cancelCalls = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x61]))
      },
      cancel() {
        cancelCalls += 1
      }
    })
    const guarded = createGuardedProviderFetch(
      'https://provider.example.test/v1',
      '/responses',
      {},
      (async () => new Response(body, { headers: { 'content-length': '9' } })) as typeof fetch,
      publicResolver as never,
      tinyProviderLimits()
    )
    await expect(Promise.resolve(guarded('https://provider.example.test/v1/responses'))).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    expect(cancelCalls).toBe(1)
    expect(body.locked).toBe(false)
  })
})

describe('provider usage accounting', () => {
  it('preserves independent provider totals and conservatively prices residual tokens', () => {
    expect(
      readAgentProviderUsage({
        results: [],
        modelUsage: { ai: 'test', model: 'model-test', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 4_580 } }
      })
    ).toEqual({ inputTokens: 3, outputTokens: 309, totalTokens: 4_580 })
    expect(readAgentProviderUsage({ results: [] })).toBeNull()
    expect(readAgentUsageEvent({ usageVersion: 2, inputTokens: 3, outputTokens: 309, totalTokens: 4_580, costMicros: 9 })).toEqual({
      inputTokens: 3,
      outputTokens: 309,
      totalTokens: 4_580,
      costMicros: 9
    })
    expect(agentProviderCostMicros({ revision: 'high-input', inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 1_000_000 }, 1, 1, 4)).toBe(
      7
    )
    expect(agentProviderCostMicros({ revision: 'rounding', inputMicrosPerMillionTokens: 1_000_001, outputMicrosPerMillionTokens: 1_000_000 }, 0, 0, 1)).toBe(2)
  })

  it('rejects totals below a safe directional sum and unsafe accounting', () => {
    expect(() =>
      readAgentProviderUsage({
        results: [],
        modelUsage: { ai: 'test', model: 'model-test', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 311 } }
      })
    ).toThrow('Provider returned incomplete or invalid token usage')
    expect(() => readAgentUsageEvent({ usageVersion: 2, inputTokens: 3, outputTokens: 309, totalTokens: 311, costMicros: 1 })).toThrow(
      'Stored agent usage event data is invalid'
    )
    expect(() => readAgentUsageEvent({ usageVersion: 2, inputTokens: 3, outputTokens: 309, totalTokens: 4_580 })).toThrow(
      'Stored agent usage event data is invalid'
    )
    expect(() =>
      readAgentProviderUsage({
        results: [],
        modelUsage: {
          ai: 'test',
          model: 'model-test',
          tokens: { promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER }
        }
      })
    ).toThrow('Provider returned incomplete or invalid token usage')
    expect(readAgentUsageEvent({ inputTokens: 3, outputTokens: 309 })).toEqual({
      inputTokens: 3,
      outputTokens: 309,
      totalTokens: 312,
      costMicros: 0
    })
  })

  it('classifies usage diagnostics without retaining malformed values', () => {
    const missing = (() => {
      try {
        readAgentProviderUsage({ results: [], modelUsage: { tokens: { promptTokens: 3, completionTokens: 2 } } })
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(classifyAgentExecutionFailure(missing, 'provider_response').diagnostics).toEqual({
      usageIssue: 'missing',
      usageField: 'totalTokens'
    })

    const unsafe = (() => {
      try {
        readAgentProviderUsage({
          results: [],
          modelUsage: { tokens: { promptTokens: Number.MAX_SAFE_INTEGER + 1, completionTokens: 2, totalTokens: Number.MAX_SAFE_INTEGER + 1 } }
        })
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(classifyAgentExecutionFailure(unsafe, 'provider_response').diagnostics).toEqual({
      usageIssue: 'unsafe_integer',
      usageField: 'inputTokens'
    })

    const sanitized = new AgentExecutionFailure('PROVIDER_USAGE_INVALID', 'provider_response', undefined, {
      usageIssue: 'unsafe_integer',
      usageField: 'inputTokens',
      prior: { inputTokens: -1, outputTokens: 3, totalTokens: 4, raw: 'secret' },
      current: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 2, totalTokens: 3 },
      context: { inputBytes: 10, limitBytes: Number.MAX_SAFE_INTEGER + 1, arbitrary: 'secret' },
      providerTurn: 1.5,
      transportKind: 'not-a-transport'
    })
    expect(sanitized.diagnostics).toEqual({
      usageIssue: 'unsafe_integer',
      usageField: 'inputTokens',
      prior: { outputTokens: 3, totalTokens: 4 },
      current: { outputTokens: 2, totalTokens: 3 },
      context: { inputBytes: 10 }
    })
  })
})

describe('provider continuation wire', () => {
  it('round-trips supported Responses continuation state and rejects a dialect mix-up', () => {
    const block = {
      data: `wiki.openai.reasoning.v1:${JSON.stringify(['rs_1', 'opaque'])}`,
      encrypted: true
    } as const
    const encoded = encodeAgentProviderContinuation('openai-responses-reasoning-v1', [block])
    expect(encoded).toMatchObject({ schemaVersion: 1, continuationDialect: 'openai-responses-reasoning-v1', thoughtBlocks: [block] })
    expect(decodeAgentProviderContinuation(encoded, 'openai-responses-reasoning-v1')).toEqual({ thoughtBlocks: [block] })
    expect(decodeAgentProviderContinuation(encoded, 'openresponses-reasoning-v1')).toBeUndefined()
  })
})

describe('Ax provider factory', () => {
  let db: Knex | undefined
  afterEach(async () => db?.destroy())

  it('loads OpenAI Responses settings and forces storage-off encrypted reasoning requests', async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.string('transportKind').notNullable()
      table.string('model').notNullable()
      table.string('utilityModel').nullable()
      table.string('baseUrl').notNullable()
      table.string('authMode').notNullable()
      table.string('secretReference').nullable()
      table.text('adapterConfig').notNullable()
      table.text('capabilities').notNullable()
      table.string('capabilityRevision').notNullable()
      table.string('pricingRevision').notNullable()
      table.boolean('conformed').notNullable()
    })
    await db('agentProviderProfileVersions').insert({
      id: '00000000-0000-4000-8000-000000000001',
      transportKind: 'openai-responses',
      model: 'gpt-test',
      utilityModel: 'gpt-test-mini',
      baseUrl: 'https://provider.example.test/v1',
      authMode: 'bearer',
      secretReference: 'env:TEST_PROVIDER_KEY',
      adapterConfig: JSON.stringify({
        timeoutMs: 10_000,
        maxRetries: 0,
        temperature: 0.42,
        agentReasoningEffort: 'high',
        utilityReasoningEffort: 'low',
        additionalHeaders: { 'x-tenant': 'wiki' }
      }),
      capabilities: JSON.stringify({
        streaming: true,
        toolCalling: 'native',
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema',
        usage: 'terminal',
        cancellation: true,
        maxContextTokens: 100_000,
        maxOutputTokens: 4_000
      }),
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1|1000000|2000000',
      conformed: true
    })
    let request: { url: URL; init?: RequestInit } | undefined
    const implementation = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      request = { url: new URL(typeof input === 'string' || input instanceof URL ? input : input.url), init }
      return Response.json({
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        status: 'completed',
        error: null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        model: 'gpt-test',
        parallel_tool_calls: true,
        previous_response_id: null,
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2
        }
      })
    }
    const factory = new AgentProviderFactory(
      db,
      { get: reference => (reference === 'env:TEST_PROVIDER_KEY' ? 'test-key' : null) },
      implementation as typeof fetch,
      publicResolver as never
    )
    const provider = await factory.create('00000000-0000-4000-8000-000000000001')
    expect(provider.pricing).toEqual({ revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 })
    const result = await provider.service.chat(
      {
        chatPrompt: [{ role: 'user', content: 'hello' }],
        model: 'gpt-test',
        functions: [
          { name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Page ID' } } } }
        ]
      },
      { stream: false }
    )
    expect(result).not.toBeInstanceOf(ReadableStream)
    expect(request?.url.href).toBe('https://provider.example.test/v1/responses')
    expect(new Headers(request?.init?.headers).get('x-tenant')).toBe('wiki')
    expect(new Headers(request?.init?.headers).get('authorization')).toBe('Bearer test-key')
    expect(request?.init).toMatchObject({ redirect: 'manual', credentials: 'omit' })
    const payload = JSON.parse(String(request?.init?.body)) as Record<string, unknown>
    expect(payload).toMatchObject({
      model: 'gpt-test',
      store: false,
      previous_response_id: null,
      parallel_tool_calls: true,
      reasoning: { effort: 'high' },
      tools: [{ type: 'function', name: 'wiki_get_page', strict: false }]
    })
    expect(payload.include).toContain('reasoning.encrypted_content')
    expect(payload).not.toHaveProperty('temperature')
    expect(payload).not.toHaveProperty('top_p')
    const utilityProvider = await factory.create('00000000-0000-4000-8000-000000000001', { purpose: 'utility' })
    expect(utilityProvider.model).toBe('gpt-test-mini')
    await utilityProvider.service.chat({ chatPrompt: [{ role: 'user', content: 'title' }], model: utilityProvider.model }, { stream: false })
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({ model: 'gpt-test-mini', store: false, reasoning: { effort: 'low' } })
    const continuation = provider.preserveThoughtBlock('rs_1', { data: 'encrypted-reasoning', encrypted: true })
    await provider.service.chat(
      {
        chatPrompt: [
          { role: 'assistant', content: 'Prior answer', thoughtBlocks: [continuation] },
          { role: 'user', content: 'Continue' }
        ],
        model: 'gpt-test'
      },
      { stream: false }
    )
    const continuationPayload = JSON.parse(String(request?.init?.body)) as { input: unknown[] }
    expect(continuationPayload.input).toContainEqual({
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      content: [],
      encrypted_content: 'encrypted-reasoning'
    })
    await db('agentProviderProfileVersions').where({ id: '00000000-0000-4000-8000-000000000001' }).update({ pricingRevision: 'price-2|0|2000000' })
    await expect(Promise.resolve(factory.create('00000000-0000-4000-8000-000000000001'))).rejects.toMatchObject({ code: 'PROVIDER_PRICING_INVALID' })
  })

  it('resets stateful Ax usage for each streamed factory request while retaining within-response receipts', async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.string('transportKind').notNullable()
      table.string('model').notNullable()
      table.string('utilityModel').nullable()
      table.string('baseUrl').notNullable()
      table.string('authMode').notNullable()
      table.string('secretReference').nullable()
      table.text('adapterConfig').notNullable()
      table.text('capabilities').notNullable()
      table.string('capabilityRevision').notNullable()
      table.string('pricingRevision').notNullable()
      table.boolean('conformed').notNullable()
    })
    const id = '00000000-0000-4000-8000-000000000013'
    await db('agentProviderProfileVersions').insert({
      id,
      transportKind: 'openai-responses',
      model: 'gpt-test',
      utilityModel: null,
      baseUrl: 'https://provider.example.test/v1',
      authMode: 'bearer',
      secretReference: 'env:STREAM_KEY',
      adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {}, agentReasoningEffort: 'high' }),
      capabilities: JSON.stringify({
        streaming: true,
        toolCalling: 'native',
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema',
        usage: 'stream',
        cancellation: true,
        maxContextTokens: 100_000,
        maxOutputTokens: 4_000
      }),
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1|1000000|2000000',
      conformed: true
    })
    const outputs = [
      openAIResponsesStream('resp_tool', { input_tokens: 3, output_tokens: 412, total_tokens: 25_133 }, [
        { type: 'function_call', id: 'fc_item', call_id: 'call_1', name: 'wiki_get_page', arguments: '{"id":42}', status: 'completed' }
      ]),
      openAIResponsesStream('resp_independent', { input_tokens: 3, output_tokens: 20, total_tokens: 43 })
    ]
    const implementation = async (): Promise<Response> => new Response(outputs.shift(), { headers: { 'content-type': 'text/event-stream' } })
    const provider = await new AgentProviderFactory(db, { get: () => 'stream-key' }, implementation as typeof fetch, publicResolver as never).create(id)
    const first = await provider.service.chat(
      {
        chatPrompt: [{ role: 'user', content: 'Read page 42' }],
        model: provider.model,
        functions: [{ name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object' } }]
      },
      { stream: true }
    )
    if (!(first instanceof ReadableStream)) throw new Error('Expected first request to stream')
    const firstItems = []
    for await (const item of first) firstItems.push(item)
    expect(firstItems.some(item => item.results.some(result => result.functionCalls?.some(call => call.id === 'call_1')))).toBe(true)
    expect(readAgentProviderUsage(firstItems.at(-1)!)).toEqual({ inputTokens: 3, outputTokens: 412, totalTokens: 25_133 })
    const second = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'Independent request' }], model: provider.model }, { stream: true })
    if (!(second instanceof ReadableStream)) throw new Error('Expected second request to stream')
    const secondItems = []
    for await (const item of second) secondItems.push(item)
    expect(secondItems.map(readAgentProviderUsage).filter((usage): usage is NonNullable<typeof usage> => usage !== null)).toEqual([
      { inputTokens: 3, outputTokens: 20, totalTokens: 43 }
    ])
  })

  it('loads an admitted version snapshot after the profile pointer advances', async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfiles', table => {
      table.uuid('id').primary()
      table.uuid('currentVersionId').notNullable()
    })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.uuid('profileId').notNullable()
      table.string('transportKind').notNullable()
      table.string('model').notNullable()
      table.string('utilityModel').nullable()
      table.string('baseUrl').notNullable()
      table.string('authMode').notNullable()
      table.string('secretReference').nullable()
      table.text('adapterConfig').notNullable()
      table.text('capabilities').notNullable()
      table.string('capabilityRevision').notNullable()
      table.string('pricingRevision').notNullable()
      table.boolean('conformed').notNullable()
    })
    const profileId = '00000000-0000-4000-8000-000000000010'
    const admittedVersionId = '00000000-0000-4000-8000-000000000011'
    const editedVersionId = '00000000-0000-4000-8000-000000000012'
    const stored = {
      profileId,
      transportKind: 'openai-responses',
      utilityModel: null,
      baseUrl: 'https://provider.example.test/v1',
      authMode: 'bearer',
      adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {} }),
      capabilities: JSON.stringify({
        streaming: true,
        toolCalling: 'native',
        parallelToolCalls: false,
        structuredOutput: 'native-json-schema',
        usage: 'terminal',
        cancellation: true,
        maxContextTokens: 100_000,
        maxOutputTokens: 4_000
      }),
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1|1000000|2000000',
      conformed: true
    }
    await db('agentProviderProfileVersions').insert({ ...stored, id: admittedVersionId, model: 'admitted-model', secretReference: 'env:ADMITTED_KEY' })
    await db('agentProviderProfiles').insert({ id: profileId, currentVersionId: admittedVersionId })

    await db.transaction(async transaction => {
      await transaction('agentProviderProfileVersions').insert({
        ...stored,
        id: editedVersionId,
        model: 'edited-model',
        secretReference: 'env:EDITED_KEY',
        conformed: false
      })
      await transaction('agentProviderProfiles').where({ id: profileId, currentVersionId: admittedVersionId }).update({ currentVersionId: editedVersionId })
    })

    const requestedReferences: string[] = []
    const factory = new AgentProviderFactory(
      db,
      {
        get: reference => {
          requestedReferences.push(reference)
          return reference === 'env:ADMITTED_KEY' ? 'admitted-secret' : null
        }
      },
      undefined,
      publicResolver as never
    )
    const provider = await factory.create(admittedVersionId)

    expect(provider.model).toBe('admitted-model')
    expect(requestedReferences).toEqual(['env:ADMITTED_KEY'])
    const revokedFactory = new AgentProviderFactory(db, { get: () => null }, undefined, publicResolver as never)
    await expect(Promise.resolve(revokedFactory.create(admittedVersionId))).rejects.toMatchObject({ code: 'PROFILE_SECRET_UNAVAILABLE' })
  })
  it('fails closed for missing provider settings', async () => {
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
    const factory = new AgentProviderFactory(db, { get: () => null })
    await expect(Promise.resolve(factory.create('00000000-0000-4000-8000-000000000099'))).rejects.toBeInstanceOf(AgentRepositoryError)
  })
})
