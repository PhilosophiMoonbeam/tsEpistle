import type { LookupAddress } from 'node:dns'
import createKnex, { type Knex } from 'knex'
import { AgentExecutionFailure, classifyAgentExecutionFailure } from '../../agents/providers/execution-failure.ts'
import {
  AgentProviderAttemptError,
  AgentProviderFactory,
  agentProviderCostMicros,
  createGuardedProviderFetch,
  decodeAgentProviderContinuation,
  deriveAgentProviderResourceLimits,
  encodeAgentProviderContinuation
} from '../../agents/providers/factory.ts'
import { readAgentProviderUsage, readAgentUsageEvent } from '../../agents/providers/usage.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import type { AgentMediaProviderConfig } from '../../../shared/agents/media-providers.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { afterEach, describe, expect, it } from '../bun-test.mts'

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
  it('bounds configured GenerateContent image responses and denies cross-protocol media endpoints', async () => {
    const largerBody = new Uint8Array(16 * 1024 * 1024 + 1)
    const limits = { ...deriveAgentProviderResourceLimits(65_536), rawBodyBytes: 64 * 1024 * 1024, rawChunkBytes: 64 * 1024 * 1024 }
    let called = 0
    const guarded = createGuardedProviderFetch(
      'https://generativelanguage.googleapis.com/v1beta',
      'gemini-media',
      {},
      (async () => {
        called++
        return new Response(largerBody)
      }) as typeof fetch,
      publicResolver as never,
      limits,
      undefined,
      'gemini-3.1-flash-image',
      { generateModels: ['gemini-3.1-flash-image'], countModels: ['gemini-3.1-flash-image'], files: false }
    )
    for (const model of ['gemini-omni-1.1-flash', 'lyria-3.5']) {
      await expect(
        Promise.resolve(guarded('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', body: JSON.stringify({ model }) }))
      ).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    }
    expect(called).toBe(0)
    const image = await guarded('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent', {
      method: 'POST',
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Draw a tree.' }] }] })
    })
    await expect(image.arrayBuffer()).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
  })
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

  it('allows only exact Gemini GenerateContent paths and query dialects for the configured model', async () => {
    let called = 0
    const implementation = async (): Promise<Response> => {
      called++
      return Response.json({ ok: true })
    }
    const base = 'https://generativelanguage.googleapis.com/v1beta'
    const guarded = createGuardedProviderFetch(
      base,
      'gemini-chat',
      {},
      implementation as typeof fetch,
      publicResolver as never,
      deriveAgentProviderResourceLimits(100),
      undefined,
      'gemini-3.7-flash'
    )
    const init = { method: 'POST', body: '{}' }
    await guarded(`${base}/models/gemini-3.7-flash:generateContent`, init)
    await guarded(`${base}/models/gemini-3.7-flash:streamGenerateContent?alt=sse`, init)
    for (const path of [
      '/interactions',
      '/interactions/id',
      '/models/gemini-3.8-flash:generateContent',
      '/models/gemini-3.7-flash:generateContent?key=credential',
      '/models/gemini-3.7-flash:streamGenerateContent',
      '/models/gemini-3.7-flash:streamGenerateContent?alt=sse&key=credential',
      '/models/gemini-3.7-flash:countTokens'
    ]) {
      await expect(Promise.resolve(guarded(base + path, init))).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    }
    await expect(Promise.resolve(guarded(`${base}/models/gemini-3.7-flash:generateContent`, { ...init, method: 'GET' }))).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
    await expect(Promise.resolve(guarded('https://other.example.test/v1beta/models/gemini-3.7-flash:generateContent', init))).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
    expect(called).toBe(2)
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
      readAgentProviderUsage('legacy-completions', {
        results: [],
        modelUsage: { ai: 'test', model: 'model-test', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 4_580 } }
      })
    ).toEqual({ inputTokens: 3, outputTokens: 309, totalTokens: 4_580 })
    expect(readAgentProviderUsage('legacy-completions', { results: [] })).toBeNull()
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
    const premium = { revision: 'cached-write', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000, cacheWritePremium: true }
    expect(agentProviderCostMicros(premium, 1, 0, 1)).toBe(2)
    expect(agentProviderCostMicros(premium, 1, 0, 2)).toBe(4)
    expect(agentProviderCostMicros({ ...premium, inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 1_000_000 }, 1, 1, 4)).toBe(9)
    expect(() => agentProviderCostMicros(premium, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_USAGE_INVALID', status: 502 })
    )
  })

  it('rejects totals below a safe directional sum and unsafe accounting', () => {
    expect(() =>
      readAgentProviderUsage('legacy-completions', {
        results: [],
        modelUsage: { ai: 'test', model: 'model-test', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 311 } }
      })
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_USAGE_INVALID', status: 502 }))
    expect(() => readAgentUsageEvent({ usageVersion: 2, inputTokens: 3, outputTokens: 309, totalTokens: 311, costMicros: 1 })).toThrow(
      expect.objectContaining({ code: 'AGENT_EVENT_CORRUPT', status: 500 })
    )
    expect(() => readAgentUsageEvent({ usageVersion: 2, inputTokens: 3, outputTokens: 309, totalTokens: 4_580 })).toThrow(
      expect.objectContaining({ code: 'AGENT_EVENT_CORRUPT', status: 500 })
    )
    expect(() =>
      readAgentProviderUsage('legacy-completions', {
        results: [],
        modelUsage: {
          ai: 'test',
          model: 'model-test',
          tokens: { promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER }
        }
      })
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_USAGE_INVALID', status: 502 }))
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
        readAgentProviderUsage('legacy-completions', { results: [], modelUsage: { tokens: { promptTokens: 3, completionTokens: 2 } } })
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
        readAgentProviderUsage('legacy-completions', {
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

    const providerError = new AgentRepositoryError('PROVIDER_UNAVAILABLE', 'private upstream message', 503)
    Object.defineProperty(providerError, 'agentDiagnostics', {
      value: { transportKind: 'gemini-api', providerErrorCode: 'service_unavailable', arbitrary: 'secret' }
    })
    expect(classifyAgentExecutionFailure(providerError, 'provider_stream')).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      providerStatus: 503,
      diagnostics: { transportKind: 'gemini-api', providerErrorCode: 'service_unavailable' }
    })
  })
})
it('normalizes root token budget failures as safe 409 execution errors', () => {
  const failure = classifyAgentExecutionFailure(
    new AgentRepositoryError('AGENT_TOKEN_BUDGET_LIMITED', 'Agent token budget was exhausted', 409),
    'dispatch_admission'
  )
  expect(failure).toMatchObject({
    code: 'AGENT_TOKEN_BUDGET_LIMITED',
    stage: 'dispatch_admission',
    status: 409,
    message: 'Agent inference failed'
  })
})

describe('external MCP execution failure boundary', () => {
  it('retains application-owned failures through nested Ax error wrappers with host-owned HTTP statuses', () => {
    const cases = [
      ['EXTERNAL_MCP_ACCESS_DENIED', 403],
      ['EXTERNAL_MCP_NATIVE_TOOLS_REQUIRED', 409],
      ['EXTERNAL_MCP_TOOL_COLLISION', 409],
      ['EXTERNAL_MCP_CATALOG_LIMIT', 413],
      ['EXTERNAL_MCP_RESULT_LIMIT', 413],
      ['EXTERNAL_MCP_BUDGET_REQUIRED', 409],
      ['EXTERNAL_MCP_SIDE_EFFECT_FENCE_REQUIRED', 409],
      ['EXTERNAL_MCP_CALL_FAILED', 502],
      ['EXTERNAL_MCP_MODALITY_UNSUPPORTED', 409]
    ] as const
    const privateDetails = 'https://private-endpoint.example/mcp?api_key=sk-secret-credential'
    for (const [code, status] of cases) {
      const applicationError = new AgentRepositoryError(code, privateDetails, 401)
      Object.assign(applicationError, { agentDiagnostics: { providerErrorCode: 'sk_secret_credential', transportKind: 'gemini-api' } })
      const functionError = Object.assign(new Error(privateDetails), { originalError: applicationError })
      const generationError = new Error(privateDetails, { cause: functionError })
      const failure = classifyAgentExecutionFailure(generationError, 'provider_response')
      expect(failure).toMatchObject({ code, status, stage: 'provider_response' })
      expect(failure.providerStatus).toBeUndefined()
      expect(failure.diagnostics).toBeUndefined()
      expect(failure.message.length).toBeGreaterThan(0)
      expect(failure.message).not.toBe(new AgentExecutionFailure('PROVIDER_REQUEST_FAILED', 'provider_response').message)
      expect(JSON.stringify({ ...failure, message: failure.message })).not.toContain(privateDetails)
      expect(failure.cause).toBeUndefined()
    }
  })

  it('does not trust remote codes, statuses, messages or arbitrary external prefixes', () => {
    const privateDetails = 'https://private-endpoint.example/mcp?api_key=sk-secret-credential'
    const errors = [
      new AgentRepositoryError('EXTERNAL_MCP_REMOTE_SECRET', privateDetails, 403),
      new AgentRepositoryError('EXTERNAL_ARBITRARY_CODE', privateDetails, 429),
      Object.assign(new Error(privateDetails), { code: 'EXTERNAL_MCP_ACCESS_DENIED', status: 403 }),
      { originalError: Object.assign(new Error(privateDetails), { code: 'remote_failure', status: 401 }) }
    ]
    for (const error of errors) {
      if (error instanceof AgentRepositoryError) Object.assign(error, { agentDiagnostics: { providerErrorCode: 'sk_secret_credential' } })
      const failure = classifyAgentExecutionFailure(error, 'provider_response')
      expect(failure).toMatchObject({ code: 'PROVIDER_REQUEST_FAILED', status: 502 })
      expect(failure.providerStatus).toBeUndefined()
      expect(failure.diagnostics).toBeUndefined()
      expect(JSON.stringify({ ...failure, message: failure.message })).not.toContain(privateDetails)
      expect(failure.cause).toBeUndefined()
    }
  })

  it('preserves cleanup precedence and already-classified uncertainty', () => {
    const applicationError = new AgentRepositoryError('EXTERNAL_MCP_ACCESS_DENIED', 'private details', 403)
    expect(classifyAgentExecutionFailure(applicationError, 'action_cleanup')).toMatchObject({
      code: 'ACTION_SESSION_CLOSE_FAILED',
      status: 502
    })
    const uncertain = new AgentExecutionFailure('EXTERNAL_MCP_CALL_FAILED', 'provider_response')
    expect(classifyAgentExecutionFailure(uncertain, 'action_cleanup')).toBe(uncertain)
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

const mediaProviderId = '00000000-0000-4000-8000-000000000041'
const mediaVersionId = '00000000-0000-4000-8000-000000000042'
const mediaImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPQSNnyHwAEOAJA4ywNkQAAAABJRU5ErkJggg==',
  'base64'
)
const imageConfig: AgentMediaProviderConfig = {
  kind: 'image',
  api: 'openai-images',
  model: 'gpt-image-2',
  baseUrl: 'https://api.openai.com/v1',
  timeoutMs: 10_000,
  maxInputTokens: 1_000,
  maxOutputTokens: 2_000,
  pricing: { kind: 'tokens', pricingRevision: 'image-v2|1000000|2000000' }
}
const seedMediaProvider = async (db: Knex): Promise<DatabaseAgentSecretRegistry> => {
  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.boolean('isActive')
    table.integer('authVersion')
  })
  await db.schema.createTable('groups', table => {
    table.integer('id').primary()
    table.text('permissions')
  })
  await db.schema.createTable('userGroups', table => {
    table.integer('userId')
    table.integer('groupId')
  })
  await db.schema.createTable('agentMediaProviderConfiguration', table => {
    table.integer('id').primary()
    table.integer('revision')
  })
  await db.schema.createTable('agentMediaProviders', table => {
    table.uuid('id').primary()
    table.string('displayName')
    table.uuid('currentVersionId')
    table.integer('revision')
    table.boolean('enabled')
    table.boolean('isDefault')
    table.string('exposureMode')
    table.dateTime('deletedAt').nullable()
  })
  await db.schema.createTable('agentMediaProviderVersions', table => {
    table.uuid('id').primary()
    table.uuid('providerId')
    table.integer('version')
    table.text('config')
    table.string('secretReference')
  })
  await db.schema.createTable('agentMediaProviderGrants', table => {
    table.uuid('providerId')
    table.integer('groupId')
  })
  await db.schema.createTable('agentProviderSecrets', table => {
    table.uuid('id').primary()
    table.string('keyId')
    table.string('algorithm')
    table.binary('nonce')
    table.binary('ciphertext')
    table.binary('authTag')
    table.integer('createdBy')
    table.dateTime('createdAt')
  })
  await db('users').insert({ id: 7, isActive: true, authVersion: 1 })
  await db('groups').insert({ id: 100, permissions: JSON.stringify(['use:agents']) })
  await db('userGroups').insert({ userId: 7, groupId: 100 })
  await db('agentMediaProviderConfiguration').insert({ id: 1, revision: 1 })
  const secrets = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 11) } })
  const secretReference = await db.transaction(transaction => secrets.store('independent-media-key', 7, transaction))
  await db('agentMediaProviders').insert({
    id: mediaProviderId,
    displayName: 'Independent images',
    currentVersionId: mediaVersionId,
    revision: 1,
    enabled: true,
    isDefault: true,
    exposureMode: 'groups',
    deletedAt: null
  })
  await db('agentMediaProviderVersions').insert({
    id: mediaVersionId,
    providerId: mediaProviderId,
    version: 1,
    config: JSON.stringify(imageConfig),
    secretReference
  })
  await db('agentMediaProviderGrants').insert({ providerId: mediaProviderId, groupId: 100 })
  return secrets
}

const seedInputProvider = async (db: Knex): Promise<string> => {
  const versionId = '00000000-0000-4000-8000-000000000051'
  const profileId = '00000000-0000-4000-8000-000000000052'
  await db.schema.createTable('agentProviderProfiles', table => {
    table.uuid('id').primary()
    table.uuid('currentVersionId')
    table.boolean('conformed')
    table.string('status')
    table.dateTime('deletedAt').nullable()
  })
  await db.schema.createTable('agentProviderProfileVersions', table => {
    table.uuid('id').primary()
    table.uuid('profileId')
    table.string('transportKind')
    table.string('model')
    table.string('utilityModel').nullable()
    table.string('baseUrl')
    table.string('authMode')
    table.string('secretReference')
    table.text('adapterConfig')
    table.text('capabilities')
    table.boolean('conformed')
  })
  await db('agentProviderProfiles').insert({ id: profileId, currentVersionId: versionId, conformed: true, status: 'enabled', deletedAt: null })
  await db('agentProviderProfileVersions').insert({
    id: versionId,
    profileId,
    transportKind: 'gemini-api',
    model: 'gemini-3.7-flash',
    utilityModel: 'gemini-3.7-flash-lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authMode: 'google-api-key',
    secretReference: 'env:LLM_INPUT_KEY',
    adapterConfig: JSON.stringify({
      timeoutMs: 10_000,
      maxRetries: 0,
      additionalHeaders: {},
      mediaInputs: { images: true, documents: true, audio: false, video: false }
    }),
    capabilities: JSON.stringify({
      streaming: true,
      toolCalling: 'native',
      parallelToolCalls: false,
      structuredOutput: 'native-json-schema',
      usage: 'terminal',
      cancellation: true,
      maxContextTokens: 32_000,
      maxOutputTokens: 4_000
    }),
    conformed: true
  })
  return versionId
}

describe('Ax provider factory', () => {
  let db: Knex | undefined
  afterEach(async () => db?.destroy())

  it('generates from an independently bound image version without any LLM profile or conformance', async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    const secrets = await seedMediaProvider(db)
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const implementation = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), init })
      return Response.json({
        data: [{ b64_json: mediaImage.toString('base64') }],
        usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 }
      })
    }
    const factory = new AgentProviderFactory(db, secrets, implementation as typeof fetch, publicResolver as never)
    const bound = await factory.createMediaBinding(7, 'image', mediaVersionId)
    const dispatch: string[] = []
    const result = await bound.transport.generate({
      prompt: 'A blue tree',
      beforeDispatch: async () => {
        dispatch.push('reserved')
      },
      onDispatch: () => {
        dispatch.push('dispatched')
      }
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/images/generations')
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe('Bearer independent-media-key')
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ model: 'gpt-image-2', prompt: 'A blue tree', n: 1 })
    expect(result).toMatchObject({ usageSource: 'reported', usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 } })
    expect(result.files).toEqual([{ bytes: mediaImage, mimeType: 'image/png' }])
    expect(dispatch).toEqual(['reserved', 'dispatched'])

    const nextVersionId = '00000000-0000-4000-8000-000000000043'
    const secretReference = await db.transaction(transaction => secrets.store('revised-media-key', 7, transaction))
    await db('agentMediaProviderVersions').insert({
      id: nextVersionId,
      providerId: mediaProviderId,
      version: 2,
      secretReference,
      config: JSON.stringify({ ...imageConfig, model: 'gpt-image-1.5', pricing: { kind: 'fixed', pricingRevision: 'revised-image-price', costMicros: 30_000 } })
    })
    await db('agentMediaProviders').where({ id: mediaProviderId }).update({ currentVersionId: nextVersionId, revision: 2 })
    await expect(factory.createMediaBinding(7, 'image', mediaVersionId)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_CHANGED', status: 409 })
    const revised = await factory.createMediaBinding(7, 'image', nextVersionId)
    await revised.transport.generate({ prompt: 'A red tree' })
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({ model: 'gpt-image-1.5', prompt: 'A red tree' })
    expect(new Headers(requests[1]?.init?.headers).get('authorization')).toBe('Bearer revised-media-key')
    expect(revised.config.pricing).toEqual({ kind: 'fixed', pricingRevision: 'revised-image-price', costMicros: 30_000 })
    expect(bound.config.pricing).toEqual({ kind: 'tokens', pricingRevision: 'image-v2|1000000|2000000' })
    const historical = await db('agentMediaProviderVersions').where({ id: mediaVersionId }).first('config', 'secretReference')
    expect(JSON.parse(historical.config)).toEqual(imageConfig)
    expect(await secrets.get(historical.secretReference)).toBe('independent-media-key')
  })

  it.each(['grant', 'disabled', 'version', 'account'] as const)('rechecks live %s authority after binding and before media egress', async revocation => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    const secrets = await seedMediaProvider(db)
    let called = 0
    const implementation = async (): Promise<Response> => {
      called++
      return Response.json({ data: [{ b64_json: mediaImage.toString('base64') }] })
    }
    const factory = new AgentProviderFactory(db, secrets, implementation as typeof fetch, publicResolver as never)
    const bound = await factory.createMediaBinding(7, 'image', mediaVersionId)
    if (revocation === 'grant') await db('agentMediaProviderGrants').where({ providerId: mediaProviderId }).delete()
    if (revocation === 'disabled') await db('agentMediaProviders').where({ id: mediaProviderId }).update({ enabled: false })
    if (revocation === 'version')
      await db('agentMediaProviders').where({ id: mediaProviderId }).update({
        currentVersionId: '00000000-0000-4000-8000-000000000043'
      })
    if (revocation === 'account') await db('users').where({ id: 7 }).update({ isActive: false })
    await expect(bound.transport.generate({ prompt: 'Must not leave Wiki' })).rejects.toThrow()
    expect(called).toBe(0)
  })

  it.each([
    { revocation: 'grant', code: 'AGENT_MEDIA_DISABLED', status: 403 },
    { revocation: 'disabled', code: 'AGENT_MEDIA_DISABLED', status: 403 },
    { revocation: 'version', code: 'MEDIA_PROVIDER_CHANGED', status: 409 },
    { revocation: 'secret', code: 'AGENT_MEDIA_DISABLED', status: 403 },
    { revocation: 'account', code: 'AGENT_ACCESS_REVOKED', status: 403 }
  ] as const)('denies a committed $revocation revocation during DNS before credential-bearing media HTTP', async ({ revocation, code, status }) => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    const secrets = await seedMediaProvider(db)
    const resolving = Promise.withResolvers<void>()
    const resolved = Promise.withResolvers<LookupAddress[]>()
    const resolver = async (): Promise<LookupAddress[]> => {
      resolving.resolve()
      return resolved.promise
    }
    let called = 0
    let paidDispatch = false
    const implementation = async (): Promise<Response> => {
      called++
      return Response.json({ data: [{ b64_json: mediaImage.toString('base64') }] })
    }
    const factory = new AgentProviderFactory(db, secrets, implementation as typeof fetch, resolver as never)
    const bound = await factory.createMediaBinding(7, 'image', mediaVersionId)
    const generation = bound.transport
      .generate({
        prompt: 'Must not leave Wiki',
        onDispatch: () => {
          paidDispatch = true
        }
      })
      .then(
        () => undefined,
        (error: unknown) => error
      )
    await resolving.promise
    try {
      await db.transaction(async transaction => {
        if (revocation === 'grant') await transaction('agentMediaProviderGrants').where({ providerId: mediaProviderId }).delete()
        if (revocation === 'disabled') await transaction('agentMediaProviders').where({ id: mediaProviderId }).update({ enabled: false })
        if (revocation === 'version') {
          const nextVersionId = '00000000-0000-4000-8000-000000000043'
          const secretReference = await secrets.store('revised-media-key', 7, transaction)
          await transaction('agentMediaProviderVersions').insert({
            id: nextVersionId,
            providerId: mediaProviderId,
            version: 2,
            secretReference,
            config: JSON.stringify({ ...imageConfig, model: 'gpt-image-1.5' })
          })
          await transaction('agentMediaProviders').where({ id: mediaProviderId }).update({ currentVersionId: nextVersionId, revision: 2 })
        }
        if (revocation === 'secret') {
          const secretReference = await secrets.store('replacement-media-key', 7, transaction)
          await transaction('agentMediaProviderVersions').where({ id: mediaVersionId }).update({ secretReference })
        }
        if (revocation === 'account') await transaction('users').where({ id: 7 }).update({ isActive: false })
      })
    } finally {
      resolved.resolve(await publicResolver())
    }
    const denial = await generation
    expect(called).toBe(0)
    expect(paidDispatch).toBe(false)
    expect(denial).toBeInstanceOf(AgentRepositoryError)
    expect(denial).toMatchObject({ code, status })
  })

  it('uses the LLM credential and model for opted-in context input, without a media-generation profile', async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    const versionId = await seedInputProvider(db)
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const implementation = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), init })
      return Response.json({ totalTokens: 23 })
    }
    const factory = new AgentProviderFactory(
      db,
      { get: reference => (reference === 'env:LLM_INPUT_KEY' ? 'llm-input-key' : null) },
      implementation as typeof fetch,
      publicResolver as never
    )
    const bound = await factory.createMediaInput(versionId)
    const uri = 'https://generativelanguage.googleapis.com/v1beta/files/attachment'
    expect(
      await bound.transport.countTokens('gemini-3.7-flash', [
        { type: 'image', uri, mime_type: 'image/png' },
        { type: 'document', uri, mime_type: 'application/pdf' }
      ])
    ).toBe(23)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:countTokens')
    expect(new Headers(requests[0]?.init?.headers).get('x-goog-api-key')).toBe('llm-input-key')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: uri, mimeType: 'image/png' } }, { fileData: { fileUri: uri, mimeType: 'application/pdf' } }] }]
    })
    await expect(bound.transport.countTokens('gemini-3.7-flash', [{ type: 'audio', uri, mime_type: 'audio/wav' }])).rejects.toMatchObject({
      code: 'INVALID_MEDIA_INPUT',
      status: 400
    })
    await expect(bound.transport.upload({ bytes: new Uint8Array([1]), mimeType: 'video/mp4' })).rejects.toMatchObject({
      code: 'INVALID_MEDIA_INPUT',
      status: 400
    })
    await expect(bound.transport.countTokens('gemini-3.1-flash-image', [{ type: 'text', text: 'Not the admitted model' }])).rejects.toMatchObject({
      code: 'INVALID_MEDIA_INPUT',
      status: 400
    })
    expect(requests).toHaveLength(1)
  })

  it.each(['inputs', 'omitted', 'disabled', 'conformance', 'version'] as const)(
    'rejects native context transport when the current LLM %s is unavailable',
    async revocation => {
      db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
      const versionId = await seedInputProvider(db)
      if (revocation === 'inputs')
        await db('agentProviderProfileVersions')
          .where({ id: versionId })
          .update({
            adapterConfig: JSON.stringify({
              timeoutMs: 10_000,
              maxRetries: 0,
              additionalHeaders: {},
              mediaInputs: { images: false, documents: false, audio: false, video: false }
            })
          })
      if (revocation === 'omitted')
        await db('agentProviderProfileVersions')
          .where({ id: versionId })
          .update({
            adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {} })
          })
      if (revocation === 'disabled') await db('agentProviderProfiles').update({ status: 'disabled' })
      if (revocation === 'conformance') await db('agentProviderProfileVersions').where({ id: versionId }).update({ conformed: false })
      if (revocation === 'version')
        await db('agentProviderProfiles').update({
          currentVersionId: '00000000-0000-4000-8000-000000000053'
        })
      let called = 0
      const factory = new AgentProviderFactory(
        db,
        { get: () => 'llm-input-key' },
        (async () => {
          called++
          return Response.json({ totalTokens: 23 })
        }) as typeof fetch,
        publicResolver as never
      )
      await expect(factory.createMediaInput(versionId)).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED', status: 403 })
      expect(called).toBe(0)
    }
  )

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
    const continuation2 = provider.preserveThoughtBlock('rs_2', { data: 'encrypted-reasoning-2', encrypted: true })
    await provider.service.chat(
      {
        chatPrompt: [
          { role: 'assistant', content: 'Prior answer', thoughtBlocks: [continuation, continuation2] },
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
    expect(continuationPayload.input).toContainEqual({
      type: 'reasoning',
      id: 'rs_2',
      summary: [],
      content: [],
      encrypted_content: 'encrypted-reasoning-2'
    })
    const requestBeforeCorruptContinuation = request
    await expect(
      Promise.resolve(
        provider.service.chat(
          {
            chatPrompt: [
              { role: 'assistant', content: 'Corrupt draft', thoughtBlocks: [{ data: 'wiki.openai.reasoning.v1:not-json', encrypted: true }] },
              { role: 'user', content: 'Correct' }
            ],
            model: 'gpt-test'
          },
          { stream: false }
        )
      )
    ).rejects.toMatchObject({
      code: 'AGENT_PROVIDER_STATE_CORRUPT',
      status: 500,
      message: 'Stored provider continuation is invalid'
    })
    expect(request).toBe(requestBeforeCorruptContinuation)
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
    expect(readAgentProviderUsage('openai-responses', firstItems.at(-1)!)).toEqual({ inputTokens: 3, outputTokens: 412, totalTokens: 25_133 })
    const second = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'Independent request' }], model: provider.model }, { stream: true })
    if (!(second instanceof ReadableStream)) throw new Error('Expected second request to stream')
    const secondItems = []
    for await (const item of second) secondItems.push(item)
    expect(
      secondItems.map(item => readAgentProviderUsage('openai-responses', item)).filter((usage): usage is NonNullable<typeof usage> => usage !== null)
    ).toEqual([{ inputTokens: 3, outputTokens: 20, totalTokens: 43 }])
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
    const creation = Promise.resolve(factory.create('00000000-0000-4000-8000-000000000099'))
    await expect(creation).rejects.toBeInstanceOf(AgentRepositoryError)
    await expect(creation).rejects.toMatchObject({ code: 'PROFILE_VERSION_UNAVAILABLE', status: 409 })
  })
})
