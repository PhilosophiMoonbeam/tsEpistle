import type { lookup } from 'node:dns/promises'
import { axGlobals } from '@ax-llm/ax'
import createKnex from 'knex'
import { createNoopMeter, ProxyTracerProvider, type Meter, type Span } from '@opentelemetry/api'
import { describe, expect, it, vi } from '../bun-test.mts'
import {
  DecisionProviderClient,
  DecisionProviderFailure,
  DecisionProviderRegistry,
  decisionCostMicros,
  estimateDecisionCost,
  normalizeDecisionAnswer,
  validateDecisionProviderConfig,
  type DecisionProviderRuntime
} from '../../agents/decision-providers.ts'
import {
  DecisionProviderWriteSchema,
  DecisionUsageSchema,
  TYPESAFE_JEV_PRICING,
  type DecisionBatchRequest,
  type DecisionRequest
} from '../../../shared/agents/decision-providers.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import { withAgentSourceAuthorization } from '../../agents/source-authorization.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'

const publicDns = (async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof lookup
const request: DecisionRequest = {
  state: { message: 'Explain the title', priorTurns: [] },
  instructions: 'Choose the required effort.',
  criteria: { simple: { description: 'Short factual answer' }, complex: ['Multi-step analysis', 'Cross-document synthesis'] }
}
const batchRequest: DecisionBatchRequest = {
  state: request.state,
  questions: {
    effort: { instructions: request.instructions, criteria: request.criteria },
    evidence: { instructions: 'Does the supplied evidence support the answer?', criteria: { supported: 'Supported', unsupported: 'Unsupported' } }
  }
}
const native: DecisionProviderRuntime = {
  id: 'native-test',
  revision: 3,
  config: { kind: 'typesafe', model: 'jev-latest', timeoutMs: 1_000, pricing: TYPESAFE_JEV_PRICING }
}
const answer = { choice: 'simple', probabilities: { simple: 0.8, complex: 0.2 }, confidence: 0.6 }
const batchAnswers = {
  effort: { type: 'choice', ...answer },
  evidence: { type: 'choice', choice: 'unsupported', probabilities: { supported: 0, unsupported: 1 }, confidence: 0.1 }
}
const nativePayload = (value: unknown = answer) => ({
  model: 'jev-1.13.0',
  answers: { decision: { type: 'choice', ...(value as object) } },
  usage: { input_tokens: 100, output_tokens: 5 }
})
const fakeFetch = (handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(new URL(String(input)), init ?? {}), {
    preconnect: () => {}
  }) as typeof fetch
const custom = (dialect: 'chat-completions' | 'completions'): DecisionProviderRuntime => ({
  id: 'custom-test',
  revision: 2,
  config: {
    kind: 'openai-compatible',
    baseUrl: 'https://classifier.example/v1',
    dialect,
    model: 'decision-model',
    timeoutMs: 1_000,
    maxOutputTokens: 1_024,
    pricing: null
  }
})

// Contract fixtures cross real Ax request builders/decoders; no remote credentials or provider calls.
describe('decision provider protocols', () => {
  it('uses native System One with structured criteria, discovery, measured usage and a separately labeled price estimate', async () => {
    const urls: string[] = []
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch((url, init) => {
        urls.push(url.href)
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-native-key')
        expect(init.redirect).toBe('manual')
        expect(init.credentials).toBe('omit')
        expect(Reflect.get(init, 'dispatcher')).toBeDefined()
        if (url.pathname === '/v1/models') {
          expect(init.method).toBe('GET')
          return Response.json({ models: [{ name: 'jev-latest', description: 'Stable model', release_date: '2026-09-10' }] })
        }
        expect(JSON.parse(String(init.body))).toEqual({
          model: 'jev-latest',
          state: request.state,
          questions: { decision: { type: 'choice', instructions: request.instructions, criteria: request.criteria } }
        })
        return Response.json(nativePayload())
      })
    })
    const result = await client.execute(native, 'fixture-native-key', request, { check: true })
    expect(urls).toEqual(['https://api.typesafe.ai/v1/models', 'https://api.typesafe.ai/v1/systemone'])
    expect(result).toMatchObject({
      providerId: 'native-test',
      providerRevision: 3,
      model: 'jev-1.13.0',
      choice: 'simple',
      probabilities: answer.probabilities,
      confidence: 0.6,
      usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, totalTokensSource: 'derived' },
      availableModels: ['jev-latest'],
      estimatedCostMicros: 5
    })
    expect(result.estimatedCost?.amount).toBeCloseTo(0.0000042, 12)
    expect(result.estimatedCost).toMatchObject({ source: 'https://docs.typesafe.ai/models', verifiedAt: '2026-10-04' })
    expect(Number.isFinite(result.latencyMs)).toBe(true)
  })

  it('verifies a pinned Jev version by inference even when account discovery only lists aliases', async () => {
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(url =>
        Response.json(
          url.pathname.endsWith('/models') ? { models: [{ name: 'jev-latest', description: 'Stable', release_date: '2026-09-10' }] } : nativePayload()
        )
      )
    })
    await expect(client.execute({ ...native, config: { ...native.config, model: 'jev-1.13.0' } }, 'fixture', request, { check: true })).resolves.toMatchObject({
      model: 'jev-1.13.0',
      availableModels: ['jev-latest']
    })
  })

  for (const check of [false, true]) {
    it(`rejects an undiscovered Jev pin when inference reports a different version (check=${check})`, async () => {
      const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(url =>
        Response.json(
          url.pathname.endsWith('/models') ? { models: [{ name: 'jev-latest', description: 'Stable', release_date: '2026-09-10' }] } : nativePayload()
        )
      )
    })
      const error = await client
        .execute({ ...native, config: { ...native.config, model: 'jev-9.99.0' } }, 'fixture-secret', request, { check })
        .catch(value => value)
      expect(error).toBeInstanceOf(DecisionProviderFailure)
      expect(error).toMatchObject({
        code: 'DECISION_MODEL_MISMATCH',
        providerRevision: 3,
        usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, totalTokensSource: 'derived' },
        estimatedCostMicros: 5
      })
      expect(JSON.stringify(error)).not.toContain('fixture-secret')
    })
  }

  for (const model of ['jev-latest', 'jev-preview', 'unrelated-model']) {
    it(`rejects a native alias that does not report a concrete Jev version: ${model}`, async () => {
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() => Response.json({ ...nativePayload(), model }))
      })
      await expect(client.execute(native, 'fixture', request)).rejects.toMatchObject({
        code: 'DECISION_MODEL_MISMATCH',
        usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, totalTokensSource: 'derived' }
      })
    })
  }

  for (const dialect of ['chat-completions', 'completions'] as const) {
    it(`supports the administrator-selected ${dialect} contract without requiring sampling parameters`, async () => {
      const paths: string[] = []
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch((url, init) => {
          paths.push(url.pathname)
          if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'decision-model' }] })
          const body = JSON.parse(String(init.body))
          // A compatible provider may reject sampling controls (for example,
          // a reasoning model); both dialects must work without assuming support.
          if (Object.hasOwn(body, 'temperature') || Object.hasOwn(body, 'top_p'))
            return Response.json({ error: { code: 'unsupported_parameter' } }, { status: 400 })
          expect(body.model).toBe('decision-model')
          // Chat Completions defaults to nonstreaming when stream is omitted.
          expect(body.stream ?? false).toBe(false)
          expect(dialect === 'completions' ? body.max_tokens : body.max_completion_tokens).toBe(1_024)
          if (dialect === 'completions') {
            expect(typeof body.prompt).toBe('string')
            expect(body.prompt).toContain(JSON.stringify(request))
            expect(body).not.toHaveProperty('messages')
          } else {
            expect(body.messages[1]).toEqual({ role: 'user', content: JSON.stringify(request) })
            expect(body).not.toHaveProperty('prompt')
            expect(body.response_format.type).toBe('json_schema')
            expect(body.response_format.json_schema).toMatchObject({ name: 'decision', strict: true, schema: { additionalProperties: false } })
          }
          return Response.json({
            id: 'completion-fixture',
            object: dialect === 'completions' ? 'text_completion' : 'chat.completion',
            created: 0,
            model: 'decision-model',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                ...(dialect === 'completions' ? { text: JSON.stringify(answer) } : { message: { role: 'assistant', content: JSON.stringify(answer) } })
              }
            ],
            usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 }
          })
        })
      })
      const result = await client.execute(custom(dialect), 'fixture-compatible-key', request, { check: true })
      expect(paths).toEqual(['/v1/models', `/v1/${dialect === 'completions' ? 'completions' : 'chat/completions'}`])
      expect(result).toMatchObject({
        choice: 'simple',
        usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220, totalTokensSource: 'reported' },
        estimatedCost: null,
        estimatedCostMicros: null
      })
    })
  }

  it('keeps private compatible decoder failures out of inherited debug logs and recording traces', async () => {
    const prior = { debug: axGlobals.debug, logger: axGlobals.logger, tracer: axGlobals.tracer }
    const tracer = new ProxyTracerProvider().getTracer('decision-inherited-fixture')
    const span = new ProxyTracerProvider().getTracer('decision-recording-fixture').startSpan('private-decision')
    const captured: unknown[] = []
    const recording = vi.spyOn(span, 'isRecording').mockReturnValue(true)
    const exceptions = vi.spyOn(span, 'recordException').mockImplementation(exception => {
      captured.push(exception)
    })
    const statuses = vi.spyOn(span, 'setStatus').mockImplementation(status => {
      captured.push(status)
      return span
    })
    const events = vi.spyOn(span, 'addEvent').mockImplementation((name, attributes) => {
      captured.push({ name, attributes })
      return span
    })
    const activeSpans = vi.spyOn(tracer, 'startActiveSpan').mockImplementation(((...args: unknown[]) => {
      const callback = args[args.length - 1] as (current: Span) => unknown
      return callback(span)
    }) as typeof tracer.startActiveSpan)
    const logger = vi.fn()
    axGlobals.debug = true
    axGlobals.logger = logger
    axGlobals.tracer = tracer
    try {
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() =>
          Response.json({
            id: 'private-refusal-fixture',
            object: 'chat.completion',
            created: 0,
            model: 'decision-model',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify(answer),
                  refusal: 'PRIVATE_DECISION_RESPONSE_DO_NOT_RECORD'
                }
              }
            ],
            usage: { prompt_tokens: 100, completion_tokens: 5 }
          })
        )
      })
      const failure = await client
        .execute(custom('chat-completions'), 'fixture-private-key', { ...request, state: 'PRIVATE_DECISION_STATE_DO_NOT_RECORD' })
        .catch((value: unknown) => value)
      expect(failure).toBeInstanceOf(DecisionProviderFailure)
      expect(failure).toMatchObject({ usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, totalTokensSource: 'derived' } })
      expect(JSON.stringify(failure)).not.toContain('PRIVATE_DECISION')
      expect(logger).not.toHaveBeenCalled()
      expect(captured).toEqual([])
    } finally {
      axGlobals.debug = prior.debug
      axGlobals.logger = prior.logger
      axGlobals.tracer = prior.tracer
      activeSpans.mockRestore()
      events.mockRestore()
      statuses.mockRestore()
      exceptions.mockRestore()
      recording.mockRestore()
    }
  })

  it('keeps unexpected compatible tool names out of inherited metrics while retaining the measured rejection receipt', async () => {
    const prior = { meter: axGlobals.meter, onUsage: axGlobals.onUsage }
    const captured: unknown[] = []
    // Inherit no-op observables without mutating the shared no-op Meter instance.
    const meter = Object.create(createNoopMeter()) as Meter
    meter.createCounter = name => ({
      add(value, attributes) {
        captured.push({ name, value, attributes })
      }
    })
    meter.createHistogram = name => ({
      record(value, attributes) {
        captured.push({ name, value, attributes })
      }
    })
    meter.createUpDownCounter = meter.createCounter
    meter.createGauge = meter.createHistogram
    const observed: unknown[] = []
    let transportCalls = 0
    const preDispatch = vi.fn(async () => {})
    axGlobals.meter = meter
    axGlobals.onUsage = event => {
      observed.push(event)
    }
    try {
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() => {
          transportCalls++
          return Response.json({
            id: 'PRIVATE_FUNCTION_RESPONSE_FIXTURE',
            object: 'chat.completion',
            created: 0,
            model: 'decision-model',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify(answer),
                  tool_calls: [{ id: 'private-tool-fixture', type: 'function', function: { name: 'PRIVATE_FUNCTION_NAME_FIXTURE', arguments: '{}' } }]
                }
              }
            ],
            usage: { prompt_tokens: 100, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 'PRIVATE_FUNCTION_USAGE_FIXTURE' } }
          })
        })
      })
      const base = custom('chat-completions')
      const failure = await client
        .execute({ ...base, config: { ...base.config, pricing: TYPESAFE_JEV_PRICING } }, 'fixture-key', request, { onPreDispatch: preDispatch })
        .catch((value: unknown) => value)
      expect(failure).toBeInstanceOf(DecisionProviderFailure)
      expect(failure).toMatchObject({
        code: 'INVALID_DECISION_RESPONSE',
        usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, totalTokensSource: 'derived' },
        estimatedCostMicros: 5
      })
      expect(transportCalls).toBe(1)
      expect(preDispatch).toHaveBeenCalledTimes(1)
      expect(observed).toEqual([
        expect.objectContaining({
          operation: 'chat',
          model: 'decision-model',
          streaming: false,
          tokens: expect.objectContaining({ promptTokens: 100, completionTokens: 5, totalTokens: 105 })
        })
      ])
      expect(JSON.stringify(observed)).not.toContain('PRIVATE_FUNCTION')
      expect(JSON.stringify(failure)).not.toContain('PRIVATE_FUNCTION')
      expect(captured).toEqual([])
    } finally {
      axGlobals.meter = prior.meter
      axGlobals.onUsage = prior.onUsage
    }
  })

  for (const snapshot of [native, custom('chat-completions'), custom('completions')]) {
    it(`keeps ${snapshot.config.kind}${snapshot.config.kind === 'openai-compatible' ? ` ${snapshot.config.dialect}` : ''} paid dispatch and receipts independent of global runtime hooks`, async () => {
      const prior = { rateLimiter: axGlobals.rateLimiter, onUsage: axGlobals.onUsage }
      let limiterCalls = 0
      let transportCalls = 0
      const observed: unknown[] = []
      axGlobals.rateLimiter = async next => {
        limiterCalls++
        await next()
        return next()
      }
      axGlobals.onUsage = event => {
        observed.push(event)
        throw new Error('Usage telemetry is unavailable')
      }
      try {
        const client = new DecisionProviderClient({
          resolve: publicDns,
          fetch: fakeFetch(() => {
            transportCalls++
            return Response.json(
              snapshot.config.kind === 'typesafe'
                ? nativePayload()
                : {
                    id: 'PRIVATE_DECISION_PAYLOAD',
                    object: snapshot.config.dialect === 'completions' ? 'text_completion' : 'chat.completion',
                    created: 0,
                    model: 'decision-model',
                    choices: [
                      {
                        index: 0,
                        finish_reason: 'stop',
                        ...(snapshot.config.dialect === 'completions'
                          ? { text: JSON.stringify(answer) }
                          : { message: { role: 'assistant', content: JSON.stringify(answer) } })
                      }
                    ],
                    usage: { prompt_tokens: 100, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 'PRIVATE_DECISION_PAYLOAD' } }
                  }
            )
          })
        })
        const result = await client.execute(snapshot, 'fixture-key', { ...request, state: 'PRIVATE_DECISION_PAYLOAD' })
        expect(result).toMatchObject({ choice: 'simple', usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, totalTokensSource: 'derived' } })
        expect(transportCalls).toBe(1)
        expect(limiterCalls).toBe(0)
        expect(JSON.stringify(observed)).not.toContain('PRIVATE_DECISION_PAYLOAD')
      } finally {
        axGlobals.rateLimiter = prior.rateLimiter
        axGlobals.onUsage = prior.onUsage
      }
    })
  }

  it('preserves custom alias resolution as observed model identity without assigning a price', async () => {
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch((url, init) => {
        if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'decision-model' }] })
        expect(JSON.parse(String(init.body)).model).toBe('decision-model')
        return Response.json({
          id: 'alias-fixture',
          object: 'chat.completion',
          created: 0,
          model: 'decision-model-2026-09-10',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 }
        })
      })
    })
    expect(await client.execute(custom('chat-completions'), 'fixture', request, { check: true })).toMatchObject({
      model: 'decision-model-2026-09-10',
      availableModels: ['decision-model'],
      estimatedCost: null
    })
  })

  for (const model of ['', ' decision-model', 'decision-model\ninjected', 'decision-fixture-secret']) {
    it(`rejects unsafe observed custom model identity ${JSON.stringify(model)} while retaining usage`, async () => {
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() =>
          Response.json({
            id: 'invalid-model',
            object: 'chat.completion',
            created: 0,
            model,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
            usage: { prompt_tokens: 100, completion_tokens: 10 }
          })
        )
      })
      const priorObserver = axGlobals.onUsage
      const observer = vi.fn()
      axGlobals.onUsage = observer
      try {
        const error = await client.execute(custom('chat-completions'), 'fixture-secret', request).catch(value => value)
        expect(error).toBeInstanceOf(DecisionProviderFailure)
        expect(error).toMatchObject({ usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, totalTokensSource: 'derived' } })
        expect(JSON.stringify(error)).not.toContain('fixture-secret')
        expect(observer).not.toHaveBeenCalled()
      } finally {
        axGlobals.onUsage = priorObserver
      }
    })
  }

  for (const snapshot of [native, custom('chat-completions')]) {
    it(`does not publish credential-reflecting ${snapshot.config.kind} model catalogs`, async () => {
      let calls = 0
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() => {
          calls++
          return Response.json(
            snapshot.config.kind === 'typesafe'
              ? { models: [{ name: 'fixture-secret', description: 'Reflected token', release_date: '2026-09-10' }] }
              : { data: [{ id: 'fixture-secret' }] }
          )
        })
      })
      const error = await client.execute(snapshot, 'fixture-secret', request, { check: true }).catch(value => value)
      expect(error).toMatchObject({ code: 'INVALID_DECISION_RESPONSE', usage: null })
      expect(JSON.stringify(error)).not.toContain('fixture-secret')
      expect(calls).toBe(1)
    })
  }

  for (const credential of [' fixture', 'fixture ', 'fixture\nkey', 'fixture key', 'fixtureékey', 'x'.repeat(65_537)]) {
    it(`rejects an unusable bearer credential before DNS or network (length=${credential.length})`, async () => {
      let calls = 0
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() => {
          calls++
          return Response.json(nativePayload())
        })
      })
      await expect(client.execute(native, credential, request)).rejects.toMatchObject({ code: 'DECISION_CREDENTIAL_UNAVAILABLE', status: 503, usage: null })
      await expect(client.executeBatch(native, credential, batchRequest)).rejects.toMatchObject({
        code: 'DECISION_CREDENTIAL_UNAVAILABLE',
        status: 503,
        usage: null
      })
      expect(calls).toBe(0)
    })
  }

  it('preserves independent compatible totals and conservatively estimates unclassified residual tokens', async () => {
    const base = custom('chat-completions')
    const snapshot = { ...base, config: { ...base.config, pricing: { ...TYPESAFE_JEV_PRICING, inputPerMillion: 2, outputPerMillion: 5, perRequest: 0.01 } } }
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(() =>
        Response.json({
          id: 'residual-fixture',
          object: 'chat.completion',
          created: 0,
          model: 'decision-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
          usage: { prompt_tokens: 123, completion_tokens: 12, total_tokens: 190 }
        })
      )
    })
    const result = await client.execute(snapshot, 'fixture', request)
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' })
    expect(result.estimatedCost?.amount).toBeCloseTo(0.010581, 12)
    expect(result.estimatedCostMicros).toBe(10581)
  })

  it('derives a safe native total only when the protocol omits it', async () => {
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(() => Response.json({ ...nativePayload(), usage: { input_tokens: 123, output_tokens: 12 } }))
    })
    expect((await client.execute(native, 'fixture', request)).usage).toEqual({
      inputTokens: 123,
      outputTokens: 12,
      totalTokens: 135,
      totalTokensSource: 'derived'
    })
  })

  for (const usage of [
    { input_tokens: 123, output_tokens: 12, total_tokens: -1 },
    { input_tokens: 123, output_tokens: 12, total_tokens: 134 },
    { input_tokens: 123, output_tokens: 12, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { input_tokens: 123, output_tokens: 12, total_tokens: null },
    { input_tokens: 123, output_tokens: 12, total_tokens: '190' },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }
  ]) {
    it(`refuses malformed or overflowing native totals ${JSON.stringify(usage)}`, async () => {
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() => Response.json({ ...nativePayload(), usage }))
      })
      await expect(client.execute(native, 'fixture', request)).rejects.toMatchObject({ usage: null, estimatedCost: null, estimatedCostMicros: null })
    })
    it(`refuses malformed or overflowing compatible totals ${JSON.stringify(usage)}`, async () => {
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() =>
          Response.json({
            id: 'invalid-total',
            object: 'chat.completion',
            created: 0,
            model: 'decision-model',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
            usage: {
              prompt_tokens: usage.input_tokens,
              completion_tokens: usage.output_tokens,
              ...('total_tokens' in usage ? { total_tokens: usage.total_tokens } : {})
            }
          })
        )
      })
      await expect(client.execute(custom('chat-completions'), 'fixture', request)).rejects.toMatchObject({
        usage: null,
        estimatedCost: null,
        estimatedCostMicros: null
      })
    })
  }

  it('rejects account-unavailable configured models before inference', async () => {
    let requests = 0
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(() => {
        requests++
        return Response.json({ models: [{ name: 'jev-latest', description: 'Stable', release_date: '2026-09-10' }] })
      })
    })
    await expect(client.execute({ ...native, config: { ...native.config, model: 'jev-preview' } }, 'fixture', request, { check: true })).rejects.toMatchObject({
      code: 'DECISION_MODEL_UNAVAILABLE',
      usage: null
    })
    expect(requests).toBe(1)
  })

  it('preserves billed native usage when Ax rejects an unknown choice', async () => {
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(() => Response.json(nativePayload({ ...answer, choice: 'untrusted-unknown-label' })))
    })
    try {
      await client.execute(native, 'fixture-secret-not-for-error', request)
      throw new Error('Expected invalid decision')
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionProviderFailure)
      expect(error).toMatchObject({ usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, totalTokensSource: 'derived' }, estimatedCostMicros: 5 })
      expect(JSON.stringify(error)).not.toContain('fixture-secret-not-for-error')
      expect(JSON.stringify(error)).not.toContain('untrusted-unknown-label')
    }
  })

  it('rejects malformed usage instead of pretending a billed decision consumed zero tokens', async () => {
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(() => Response.json({ ...nativePayload(), usage: { input_tokens: -1, output_tokens: 5 } }))
    })
    await expect(client.execute(native, 'fixture', request)).rejects.toMatchObject({ usage: null, estimatedCost: null })
  })

  for (const failure of ['invalid-decision', 'nonmaximal-generated-choice', 'ax-refusal'] as const) {
    it(`retains billed compatible usage and redacts provider content after ${failure}`, async () => {
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() =>
          Response.json({
            id: 'bad-decision',
            object: 'chat.completion',
            created: 0,
            model: 'decision-model',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify(
                    failure === 'nonmaximal-generated-choice'
                      ? { ...answer, choice: 'complex' }
                      : { ...answer, probabilities: { simple: 0.8, complex: 0.2, unauthorized: 0 } }
                  ),
                  ...(failure === 'ax-refusal' ? { refusal: 'sensitive-provider-refusal' } : {})
                }
              }
            ],
            usage: { prompt_tokens: 123, completion_tokens: 12, total_tokens: 190 }
          })
        )
      })
      const base = custom('chat-completions')
      const snapshot = { ...base, config: { ...base.config, pricing: { ...TYPESAFE_JEV_PRICING, inputPerMillion: 2, outputPerMillion: 5, perRequest: 0.01 } } }
      const error = await client.execute(snapshot, 'fixture-secret', request).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(DecisionProviderFailure)
      expect(error).toMatchObject({
        code: failure === 'ax-refusal' ? 'DECISION_PROVIDER_FAILED' : 'INVALID_DECISION_RESPONSE',
        usage: { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' },
        estimatedCostMicros: 10581
      })
      expect((error as DecisionProviderFailure).estimatedCost?.amount).toBeCloseTo(0.010581, 12)
      expect(JSON.stringify(error)).not.toContain('sensitive-provider-refusal')
      expect(JSON.stringify(error)).not.toContain('fixture-secret')
      expect(JSON.stringify(error)).not.toContain('unauthorized')
    })
  }

  it('rejects DNS rebinding answers with any prohibited address before sending credentials', async () => {
    let calls = 0
    const resolve = (async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]) as unknown as typeof lookup
    const client = new DecisionProviderClient({
      resolve,
      fetch: fakeFetch(() => {
          calls++
          return Response.json(nativePayload())
        })
    })
    await expect(client.execute(native, 'fixture', request)).rejects.toMatchObject({ code: 'DECISION_EGRESS_DENIED' })
    await expect(client.executeBatch(native, 'fixture', batchRequest)).rejects.toMatchObject({ code: 'DECISION_EGRESS_DENIED' })
    expect(calls).toBe(0)
  })

  it('denies redirects without following or exposing provider errors', async () => {
    let calls = 0
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(() => {
        calls++
        return new Response('credential echo fixture-private', { status: 302, headers: { location: 'https://evil.example/' } })
      })
    })
    const error = await client.execute(native, 'fixture-private', request).catch(value => value)
    expect(error).toMatchObject({ code: 'DECISION_PROVIDER_UNAVAILABLE', providerStatus: 302, usage: null })
    expect(error.message).not.toContain('fixture-private')
    expect(calls).toBe(1)
    const batchError = await client.executeBatch(native, 'fixture-private', batchRequest).catch((value: unknown) => value)
    expect(batchError).toMatchObject({ code: 'DECISION_PROVIDER_UNAVAILABLE', providerStatus: 302, usage: null })
    expect(JSON.stringify(batchError)).not.toContain('fixture-private')
    expect(calls).toBe(2)
  })

  it('preserves a rate-limit status without retrying, exposing the error body, or inventing usage', async () => {
    let calls = 0
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(() => {
        calls++
        return new Response('private-provider-detail fixture-private', { status: 429 })
      })
    })
    const failure = await client.executeBatch(native, 'fixture-private', batchRequest).catch((value: unknown) => value)
    expect(failure).toBeInstanceOf(DecisionProviderFailure)
    expect(failure).toMatchObject({ code: 'DECISION_PROVIDER_UNAVAILABLE', status: 502, providerStatus: 429, usage: null })
    expect(JSON.stringify(failure)).not.toContain('fixture-private')
    expect(JSON.stringify(failure)).not.toContain('private-provider-detail')
    expect(calls).toBe(1)
  })

  for (const mode of ['malformed-json', 'failed-stream'] as const) {
    it(`keeps only safe native identifiers after a successful HTTP response with ${mode}`, async () => {
      let calls = 0
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() => {
          calls++
          const body =
            mode === 'malformed-json'
              ? 'private-provider-detail fixture-private'
              : new ReadableStream({
                  start(controller) {
                    controller.error(
                      Object.assign(new TypeError('private-provider-detail fixture-private'), {
                        code: 'fixture-private',
                        cause: Object.assign(new Error('private-provider-detail fixture-private'), { code: 'UND_ERR_SOCKET' })
                      })
                    )
                  }
                })
          return new Response(body, { headers: { 'content-type': 'application/json' } })
        })
      })
      const failure = await client.executeBatch(native, 'fixture-private', batchRequest).catch((value: unknown) => value)
      expect(failure).toBeInstanceOf(DecisionProviderFailure)
      expect(failure).toMatchObject({
        code: 'DECISION_PROVIDER_FAILED',
        status: 502,
        providerStatus: 200,
        nativeErrorName: mode === 'malformed-json' ? 'SyntaxError' : 'TypeError',
        transportErrorCode: mode === 'malformed-json' ? null : 'UND_ERR_SOCKET',
        usage: null
      })
      expect(JSON.stringify(failure)).not.toContain('fixture-private')
      expect(JSON.stringify(failure)).not.toContain('private-provider-detail')
      expect(calls).toBe(1)
    })
  }

  it('bounds response bodies even without Content-Length', async () => {
    const client = new DecisionProviderClient({ resolve: publicDns, fetch: fakeFetch(() => new Response('x'.repeat(256 * 1_024 + 1))) })
    await expect(client.execute(native, 'fixture', request)).rejects.toMatchObject({ code: 'INVALID_DECISION_RESPONSE' })
    await expect(client.executeBatch(native, 'fixture', batchRequest)).rejects.toMatchObject({ code: 'INVALID_DECISION_RESPONSE' })
  })

  it.each(['DNS', 'source authorization', 'transport', 'response body'] as const)(
    'honors Ax cancellation during compatible %s without publishing an incomplete receipt or dispatching queued work',
    async boundary => {
      const previous = axGlobals.abortSignal
      const sdkAbort = new AbortController()
      const hostAbort = new AbortController()
      axGlobals.abortSignal = sdkAbort.signal
      const entered = Promise.withResolvers<void>()
      const dnsReady = Promise.withResolvers<{ address: string; family: number }[]>()
      const sourceReady = Promise.withResolvers<void>()
      const transportReady = Promise.withResolvers<Response>()
      const lateBodyCancelled = Promise.withResolvers<void>()
      const onRequestDispatched = vi.fn()
      let transportSignal: AbortSignal | null | undefined
      let body: ReadableStreamDefaultController<Uint8Array> | undefined
      let calls = 0
      const payload = {
        model: 'decision-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 100, completion_tokens: 5 }
      }
      const client = new DecisionProviderClient({
        resolve: (async () => {
          if (boundary === 'DNS') {
            entered.resolve()
            return dnsReady.promise
          }
          return [{ address: '93.184.216.34', family: 4 }]
        }) as unknown as typeof lookup,
        fetch: fakeFetch((_url, init) => {
          calls++
          transportSignal = init.signal
          if (boundary === 'transport') {
            entered.resolve()
            return transportReady.promise
          }
          if (boundary === 'response body')
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  body = controller
                  controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)))
                },
                pull() {
                  // Complete JSON is not a receipt until the next read proves EOF.
                  entered.resolve()
                }
              })
            )
          return Response.json(payload)
        })
      })
      const completed = withAgentSourceAuthorization(
        async () => {
          if (boundary === 'source authorization') {
            entered.resolve()
            await sourceReady.promise
          }
        },
        () =>
          client.execute(custom('chat-completions'), 'fixture', request, {
            signal: hostAbort.signal,
            onRequestDispatched
          })
      ).catch((error: unknown) => error)
      try {
        await entered.promise
        sdkAbort.abort('private-sdk-cancellation-reason')
        dnsReady.resolve([{ address: '93.184.216.34', family: 4 }])
        sourceReady.resolve()
        const checkpoint = new Promise<'stalled'>(resolve => {
          // The completed cancellation must beat the next event-loop turn,
          // not an elapsed wall-clock delay or the host's later deadline.
          setImmediate(() => resolve('stalled'))
        })
        const failure = await Promise.race([completed, checkpoint])
        expect(failure).not.toBe('stalled')
        expect(failure).toMatchObject({ code: 'DECISION_ABORTED', status: 499 })
        expect(Reflect.get(failure as object, 'usage') ?? null).toBeNull()
        expect(hostAbort.signal.aborted).toBe(false)
        expect(JSON.stringify(failure)).not.toContain('private-sdk-cancellation-reason')
        const dispatched = boundary === 'transport' || boundary === 'response body'
        expect(calls).toBe(dispatched ? 1 : 0)
        expect(onRequestDispatched).toHaveBeenCalledTimes(dispatched ? 1 : 0)
        if (dispatched) expect(transportSignal?.aborted).toBe(true)
        if (boundary === 'transport') {
          transportReady.resolve(
            new Response(
              new ReadableStream({
                cancel() {
                  lateBodyCancelled.resolve()
                }
              })
            )
          )
          expect(
            await Promise.race([lateBodyCancelled.promise.then(() => 'cancelled'), new Promise<'stalled'>(resolve => setImmediate(() => resolve('stalled')))])
          ).toBe('cancelled')
        }
      } finally {
        axGlobals.abortSignal = previous
        dnsReady.resolve([{ address: '93.184.216.34', family: 4 }])
        sourceReady.resolve()
        transportReady.resolve(Response.json(payload))
        try {
          body?.close()
        } catch {
          // Cancellation may already have closed the fixture stream.
        }
        await completed
      }
    }
  )

  it.each(['cancelled body', 'oversized declared body', 'HTTP rejection'] as const)(
    'settles a %s without awaiting stalled transport cleanup or inventing usage',
    async mode => {
      const reading = Promise.withResolvers<void>()
      const cancelling = Promise.withResolvers<void>()
      const cleanupReady = Promise.withResolvers<void>()
      const controller = new AbortController()
      const onRequestDispatched = vi.fn()
      let calls = 0
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() => {
          calls++
          return new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(new TextEncoder().encode(JSON.stringify(nativePayload())))
              },
              pull() {
                reading.resolve()
              },
              cancel() {
                cancelling.resolve()
                return cleanupReady.promise
              }
            }),
            mode === 'HTTP rejection' ? { status: 429 } : mode === 'oversized declared body' ? { headers: { 'content-length': String(256 * 1_024 + 1) } } : {}
          )
        })
      })
      const completed = client
        .execute(native, 'fixture', request, {
          signal: controller.signal,
          onRequestDispatched
        })
        .catch((error: unknown) => error)
      try {
        if (mode === 'cancelled body') {
          await reading.promise
          controller.abort()
        }
        await cancelling.promise
        // Cleanup stays unresolved across the next event-loop turn.
        const failure = await Promise.race([completed, new Promise<'stalled'>(resolve => setImmediate(() => resolve('stalled')))])
        expect(failure).not.toBe('stalled')
        expect(failure).toBeInstanceOf(DecisionProviderFailure)
        expect(failure).toMatchObject({
          code: mode === 'cancelled body' ? 'DECISION_ABORTED' : mode === 'HTTP rejection' ? 'DECISION_PROVIDER_UNAVAILABLE' : 'INVALID_DECISION_RESPONSE',
          usage: null,
          estimatedCost: null,
          estimatedCostMicros: null
        })
        expect(calls).toBe(1)
        expect(onRequestDispatched).toHaveBeenCalledTimes(1)
      } finally {
        cleanupReady.resolve()
        await completed
      }
    }
  )

  it('propagates abort and bounds stalled DNS resolution by the configured timeout', async () => {
    const unresolved = (async () => Promise.withResolvers<never>().promise) as unknown as typeof lookup
    const client = new DecisionProviderClient({
      resolve: unresolved,
      fetch: fakeFetch(() => {
        throw new Error('Network must not start')
      })
    })
    await expect(client.execute({ ...native, config: { ...native.config, timeoutMs: 100 } }, 'fixture', request)).rejects.toMatchObject({
      code: 'DECISION_TIMEOUT'
    })
    await expect(client.executeBatch({ ...native, config: { ...native.config, timeoutMs: 100 } }, 'fixture', batchRequest)).rejects.toMatchObject({
      code: 'DECISION_TIMEOUT'
    })
    const controller = new AbortController()
    const pending = client.execute(native, 'fixture', request, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'DECISION_ABORTED' })
    const batchController = new AbortController()
    const batchPending = client.executeBatch(native, 'fixture', batchRequest, { signal: batchController.signal })
    batchController.abort()
    await expect(batchPending).rejects.toMatchObject({ code: 'DECISION_ABORTED', usage: null })
  })
})

describe('native decision batches', () => {
  it('preserves native nonargmax choices and inclusive rounding boundaries without conflating confidence or duplicating paid usage', async () => {
    for (const probabilities of [
      { simple: 0.4, complex: 0.6 },
      { simple: 0.39, complex: 0.6 },
      { simple: 0.41, complex: 0.6 }
    ]) {
      let calls = 0
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() => {
          calls++
          return Response.json({
            model: 'jev-1.13.0',
            answers: { ...batchAnswers, effort: { ...batchAnswers.effort, probabilities, confidence: 0.9 } },
            usage: { input_tokens: 100, output_tokens: 5, total_tokens: 120 }
          })
        })
      })
      const result = await client.executeBatch({ ...native, config: { ...native.config, model: 'jev-1.13.0' } }, 'fixture', batchRequest)
      expect(result).toMatchObject({
        providerId: native.id,
        providerRevision: native.revision,
        model: 'jev-1.13.0',
        answers: {
          effort: { choice: 'simple', probabilities, confidence: 0.9 },
          evidence: { choice: 'unsupported', probabilities: { supported: 0, unsupported: 1 }, confidence: 0.1 }
        },
        usage: { inputTokens: 100, outputTokens: 5, totalTokens: 120, totalTokensSource: 'reported' },
        estimatedCostMicros: 5
      })
      expect(result.estimatedCost?.amount).toBeCloseTo(0.00000483, 12)
      expect(calls).toBe(1)
    }
  })

  for (const [name, answers] of [
    ['missing answer', { effort: batchAnswers.effort }],
    ['extra answer', { ...batchAnswers, extra: batchAnswers.effort }],
    ['wrong question identity', { effort: batchAnswers.effort, Evidence: batchAnswers.evidence }],
    ['malformed answer map', [batchAnswers.effort, batchAnswers.evidence]],
    ['missing answer type', { ...batchAnswers, effort: answer }],
    ['wrong answer type', { ...batchAnswers, evidence: { ...batchAnswers.evidence, type: 'noul' } }],
    ['unknown choice', { ...batchAnswers, evidence: { ...batchAnswers.evidence, choice: 'fixture-secret-reflected' } }],
    ['missing probability', { ...batchAnswers, evidence: { ...batchAnswers.evidence, probabilities: { unsupported: 1 } } }],
    ['extra probability', { ...batchAnswers, evidence: { ...batchAnswers.evidence, probabilities: { supported: 0, unsupported: 1, extra: 0 } } }],
    ['out of range probability', { ...batchAnswers, effort: { ...batchAnswers.effort, probabilities: { simple: 1.1, complex: -0.1 } } }],
    ['nonfinite probability', { ...batchAnswers, effort: { ...batchAnswers.effort, probabilities: { simple: Infinity, complex: 0 } } }],
    ['probabilities outside rounding tolerance', { ...batchAnswers, effort: { ...batchAnswers.effort, probabilities: { simple: 0.789, complex: 0.2 } } }],
    ['missing confidence', { ...batchAnswers, evidence: { type: 'choice', choice: 'unsupported', probabilities: { supported: 0, unsupported: 1 } } }],
    ['out of range confidence', { ...batchAnswers, evidence: { ...batchAnswers.evidence, confidence: 1.1 } }],
    ['unexpected answer field', { ...batchAnswers, evidence: { ...batchAnswers.evidence, explanation: 'fixture-secret-reflected' } }]
  ] as const) {
    it(`fails closed on ${name} while retaining known billed batch usage and redacting provider content`, async () => {
      let calls = 0
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() => {
          calls++
          return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 5, total_tokens: 120 } })
        })
      })
      const failure = await client.executeBatch(native, 'fixture-secret', batchRequest).catch((value: unknown) => value)
      expect(failure).toBeInstanceOf(DecisionProviderFailure)
      expect(failure).toMatchObject({
        code: 'INVALID_DECISION_RESPONSE',
        providerRevision: native.revision,
        usage: { inputTokens: 100, outputTokens: 5, totalTokens: 120, totalTokensSource: 'reported' },
        estimatedCostMicros: 5
      })
      expect(JSON.stringify(failure)).not.toContain('fixture-secret')
      expect(calls).toBe(1)
    })
  }

  for (const usage of [
    { input_tokens: 100 },
    { output_tokens: 5 },
    { input_tokens: 100, output_tokens: 5, total_tokens: 104 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }
  ]) {
    it(`rejects incomplete or inconsistent batch accounting ${JSON.stringify(usage)}`, async () => {
      const client = new DecisionProviderClient({
        resolve: publicDns,
        fetch: fakeFetch(() => Response.json({ model: 'jev-1.13.0', answers: batchAnswers, usage }))
      })
      await expect(client.executeBatch(native, 'fixture', batchRequest)).rejects.toMatchObject({
        usage: null,
        estimatedCost: null,
        estimatedCostMicros: null
      })
    })
  }

  it('retains batch usage when the paid response does not honor the selected model pin', async () => {
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(() => Response.json({ model: 'jev-1.13.0', answers: batchAnswers, usage: { input_tokens: 100, output_tokens: 5 } }))
    })
    await expect(client.executeBatch({ ...native, config: { ...native.config, model: 'jev-9.99.0' } }, 'fixture', batchRequest)).rejects.toMatchObject({
      code: 'DECISION_MODEL_MISMATCH',
      usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, totalTokensSource: 'derived' },
      estimatedCostMicros: 5
    })
  })

  it('rejects a committed Registry disable and revision change during final DNS or source authorization for decisions and batches without a caller admission hook', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    try {
      await db.schema.createTable('agentDecisionProviders', table => {
        table.uuid('id').primary()
        table.string('displayName')
        table.integer('revision')
        table.text('config')
        table.string('secretReference').nullable()
        table.boolean('enabled')
        table.boolean('isDefault')
      })
      const id = '00000000-0000-4000-8000-000000000047'
      await db('agentDecisionProviders').insert({
        id, displayName: 'Native decision fixture', revision: native.revision,
        config: JSON.stringify(native.config), secretReference: null, enabled: true, isDefault: true
      })
      const secrets = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'fixture', keys: { fixture: Buffer.alloc(32, 7) } })
      for (const [batched, boundary] of [[false, 'DNS'], [true, 'DNS'], [false, 'source authorization'], [true, 'source authorization']] as const) {
        await db('agentDecisionProviders').where({ id }).update({ enabled: true, revision: native.revision })
        const resolving = Promise.withResolvers<void>()
        const dnsReady = Promise.withResolvers<{ address: string; family: number }[]>()
        const sourceAuthorizing = Promise.withResolvers<void>()
        const sourceReady = Promise.withResolvers<void>()
        const authorizeSources = vi.fn(async () => {
          sourceAuthorizing.resolve()
          await sourceReady.promise
        })
        const outgoing: RequestInit[] = []
        const onRequestDispatched = vi.fn()
        const registry = new DecisionProviderRegistry(db, secrets, {
          environmentKey: () => 'still-valid-native-key',
          resolve: (async () => {
            resolving.resolve()
            return boundary === 'DNS' ? dnsReady.promise : [{ address: '93.184.216.34', family: 4 }]
          }) as unknown as typeof lookup,
          fetch: fakeFetch((_url, init) => {
            outgoing.push(init)
            return Response.json(batched
              ? { model: 'jev-1.13.0', answers: batchAnswers, usage: { input_tokens: 100, output_tokens: 5 } }
              : nativePayload())
          })
        })
        const running = withAgentSourceAuthorization(boundary === 'source authorization' ? authorizeSources : undefined, async () => batched
          ? registry.decideBatch(batchRequest, { providerId: id, providerRevision: native.revision, onRequestDispatched })
          : registry.decide(request, { providerId: id }))
        const pending = running.catch((error: unknown) => error)
        if (boundary === 'DNS') await resolving.promise
        else await sourceAuthorizing.promise
        try {
          await db('agentDecisionProviders').where({ id }).update({ enabled: false, revision: native.revision + 1 })
        } finally {
          dnsReady.resolve([{ address: '93.184.216.34', family: 4 }])
          sourceReady.resolve()
        }
        const failure = await pending
        expect(failure).toBeInstanceOf(AgentRepositoryError)
        expect(failure).not.toBeInstanceOf(DecisionProviderFailure)
        expect(failure).toMatchObject({ code: 'DECISION_PROVIDER_REVISION_CHANGED', status: 409 })
        expect(failure).not.toHaveProperty('usage')
        expect(failure).not.toHaveProperty('estimatedCost')
        expect(outgoing).toEqual([])
        expect(onRequestDispatched).not.toHaveBeenCalled()
        expect(authorizeSources).toHaveBeenCalledTimes(boundary === 'source authorization' ? 1 : 0)
      }
    } finally {
      await db.destroy()
    }
  })

  it.each(['DNS', 'pre-dispatch authorization'] as const)(
    'retains source-only denial during native Decision %s without actual-send proof or a paid receipt',
    async boundary => {
      const resolving = Promise.withResolvers<void>()
      const dnsReady = Promise.withResolvers<{ address: string; family: number }[]>()
      const authorizing = Promise.withResolvers<void>()
      const authorizationReady = Promise.withResolvers<void>()
      const outgoing: RequestInit[] = []
      const client = new DecisionProviderClient({
        resolve: (async () => {
          resolving.resolve()
          if (boundary === 'DNS') return dnsReady.promise
          return [{ address: '93.184.216.34', family: 4 }]
        }) as unknown as typeof lookup,
        fetch: fakeFetch((_url, init) => {
          outgoing.push(init)
          return Response.json({ model: 'jev-1.13.0', answers: batchAnswers, usage: { input_tokens: 100, output_tokens: 5 } })
        })
      })
      let readable = true
      const denial = new AgentRepositoryError('AGENT_EVIDENCE_INVALID', 'Copied Wiki source access was revoked', 403)
      const authorize = vi.fn(async () => {
        if (!readable) throw denial
      })
      const onPreDispatch = vi.fn(async () => {
        authorizing.resolve()
        if (boundary === 'pre-dispatch authorization') await authorizationReady.promise
      })
      const onRequestDispatched = vi.fn()
      await authorize()
      const pending = withAgentSourceAuthorization(authorize, async () => client.executeBatch(native, 'still-valid-native-key', {
        ...batchRequest,
        state: { source: 'Copied private Wiki evidence and proposed answer' }
      }, { onPreDispatch, onRequestDispatched })).catch((error: unknown) => error)
      if (boundary === 'DNS') await resolving.promise
      else await authorizing.promise
      readable = false
      dnsReady.resolve([{ address: '93.184.216.34', family: 4 }])
      authorizationReady.resolve()
      const failure = await pending
      expect(failure).toBe(denial)
      expect(failure).not.toBeInstanceOf(DecisionProviderFailure)
      expect(failure).not.toHaveProperty('usage')
      expect(failure).not.toHaveProperty('estimatedCost')
      expect(outgoing).toEqual([])
      expect(onRequestDispatched).not.toHaveBeenCalled()
      expect(onPreDispatch).toHaveBeenCalledTimes(1)
      expect(authorize).toHaveBeenCalledTimes(2)
    }
  )

  it('keeps native model discovery available under revoked source rights while denying the following source-bearing check', async () => {
    const outgoing: { method: string | undefined; path: string }[] = []
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch((url, init) => {
        outgoing.push({ method: init.method, path: url.pathname })
        return Response.json(url.pathname === '/v1/models'
          ? { models: [{ name: 'jev-latest', description: 'Stable', release_date: '2026-09-10' }] }
          : nativePayload())
      })
    })
    const denial = new AgentRepositoryError('AGENT_EVIDENCE_INVALID', 'Wiki source access was revoked', 403)
    const authorize = vi.fn(async () => {
      throw denial
    })
    const onRequestDispatched = vi.fn()
    const failure = await withAgentSourceAuthorization(authorize, async () =>
      client.execute(native, 'still-valid-native-key', request, { check: true, onRequestDispatched })
    ).catch((error: unknown) => error)
    expect(failure).toBe(denial)
    expect(outgoing).toEqual([{ method: 'GET', path: '/v1/models' }])
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(onRequestDispatched).not.toHaveBeenCalled()
  })

  it('redacts a rejected final source guard without posting raw state or manufacturing a paid receipt', async () => {
    const outgoing: RequestInit[] = []
    let dnsAdmitted = false
    const client = new DecisionProviderClient({
      resolve: (async () => {
        dnsAdmitted = true
        return [{ address: '93.184.216.34', family: 4 }]
      }) as unknown as typeof lookup,
      fetch: fakeFetch((_url, init) => {
          outgoing.push(init)
          return Response.json({ model: 'jev-1.13.0', answers: batchAnswers, usage: { input_tokens: 100, output_tokens: 5 } })
        })
    })
    const failure = await client
      .executeBatch({ ...native, config: { ...native.config, model: 'jev-1.13.0' } }, 'fixture-secret', batchRequest, {
        onPreDispatch: async () => {
          expect(dnsAdmitted).toBe(true)
          throw new Error('private-source-guard-detail')
        }
      })
      .catch((value: unknown) => value)
    expect(failure).toMatchObject({ code: 'DECISION_PRE_DISPATCH_REJECTED' })
    expect(failure).not.toBeInstanceOf(DecisionProviderFailure)
    expect(String(failure)).not.toContain('private-source-guard-detail')
    expect(JSON.stringify(failure)).not.toContain('fixture-secret')
    expect(outgoing).toEqual([])
  })

  it('cancels a stalled final source guard before any credential-bearing POST', async () => {
    const entered = Promise.withResolvers<void>()
    const outgoing: RequestInit[] = []
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch((_url, init) => {
          outgoing.push(init)
          return Response.json({ model: 'jev-1.13.0', answers: batchAnswers, usage: { input_tokens: 100, output_tokens: 5 } })
        })
    })
    const controller = new AbortController()
    const pending = client.executeBatch({ ...native, config: { ...native.config, model: 'jev-1.13.0' } }, 'fixture-secret', batchRequest, {
      signal: controller.signal,
      onPreDispatch: async () => {
        entered.resolve()
        await Promise.withResolvers<never>().promise
      }
    })
    await entered.promise
    controller.abort('private-cancellation-detail')
    const failure = await pending.catch((value: unknown) => value)
    expect(failure).toMatchObject({ code: 'DECISION_ABORTED', status: 499 })
    expect(failure).not.toBeInstanceOf(DecisionProviderFailure)
    expect(String(failure)).not.toContain('private-cancellation-detail')
    expect(outgoing).toEqual([])
  })

  it('reports a final source guard deadline as an unbilled timeout rather than caller cancellation', async () => {
    const entered = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const timeout = new AbortController()
    const nativeTimeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const outgoing: RequestInit[] = []
    const onRequestDispatched = vi.fn()
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch((_url, init) => {
          outgoing.push(init)
          return Response.json({ model: 'jev-1.13.0', answers: batchAnswers, usage: { input_tokens: 100, output_tokens: 5 } })
        })
    })
    const completed = client
      .executeBatch({ ...native, config: { ...native.config, timeoutMs: 100 } }, 'fixture', batchRequest, {
        onPreDispatch: async () => {
          entered.resolve()
          await ready.promise
        },
        onRequestDispatched
      })
      .catch((error: unknown) => error)
    try {
      await entered.promise
      timeout.abort(new DOMException('Fixture deadline', 'TimeoutError'))
      const failure = await completed
      expect(failure).toMatchObject({ code: 'DECISION_TIMEOUT', status: 502 })
      expect(failure).not.toBeInstanceOf(DecisionProviderFailure)
      expect(failure).not.toHaveProperty('usage')
      expect(outgoing).toEqual([])
      expect(onRequestDispatched).not.toHaveBeenCalled()
    } finally {
      ready.resolve()
      nativeTimeout.mockRestore()
      await completed
    }
  })

  it('cancels an in-flight batch without retrying or fabricating usage when its transport stalls', async () => {
    const started = Promise.withResolvers<void>()
    let calls = 0
    const onRequestDispatched = vi.fn()
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(() => {
        calls++
        expect(onRequestDispatched).toHaveBeenCalledTimes(1)
        started.resolve()
        return Promise.withResolvers<Response>().promise
      })
    })
    const controller = new AbortController()
    const pending = client.executeBatch(native, 'fixture', batchRequest, { signal: controller.signal, onRequestDispatched })
    await started.promise
    controller.abort('sensitive-cancellation-reason')
    const failure = await pending.catch((value: unknown) => value)
    expect(failure).toMatchObject({ code: 'DECISION_ABORTED', status: 499, usage: null, estimatedCost: null })
    expect(failure).toBeInstanceOf(DecisionProviderFailure)
    expect(onRequestDispatched).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(failure)).not.toContain('sensitive-cancellation-reason')
    expect(calls).toBe(1)
  })

  it('denies invalid question identities and unsupported provider kinds before credential-bearing dispatch', async () => {
    let calls = 0
    const client = new DecisionProviderClient({
      resolve: publicDns,
      fetch: fakeFetch(() => {
        calls++
        throw new Error('No request may be dispatched')
      })
    })
    for (const ids of [
      [],
      ['', 'evidence'],
      [' effort'],
      ['effort\n'],
      ['__proto__'],
      ['constructor'],
      ['prototype'],
      ['x'.repeat(256)],
      Array.from({ length: 256 }, (_, index) => `q${index}`)
    ]) {
      const questions = Object.fromEntries(ids.map(id => [id, batchRequest.questions.effort!]))
      await expect(client.executeBatch(native, 'fixture', { state: batchRequest.state, questions })).rejects.toMatchObject({ code: 'INVALID_DECISION_REQUEST' })
    }
    await expect(client.executeBatch(custom('chat-completions'), 'fixture', batchRequest)).rejects.toMatchObject({ code: 'DECISION_BATCH_UNSUPPORTED' })
    expect(calls).toBe(0)
  })
})

describe('decision validation and cost semantics', () => {
  it('preserves both inclusive rounding boundaries without treating probabilities as confidence', () => {
    for (const probabilities of [
      { simple: 0.79, complex: 0.2 },
      { simple: 0.81, complex: 0.2 }
    ]) {
      const result = normalizeDecisionAnswer({ ...answer, probabilities }, request.criteria)
      expect(result.probabilities).toEqual(probabilities)
      expect(result.confidence).toBe(0.6)
    }
  })
  it('rejects unknown choices, missing, extra, negative, nonfinite and nonsumming probabilities, and nonfinite confidence', () => {
    for (const value of [
      { ...answer, choice: 'unknown' },
      { ...answer, probabilities: { simple: 1 } },
      { ...answer, probabilities: { simple: 0.8, complex: 0.2, extra: 0 } },
      { ...answer, probabilities: { simple: Infinity, complex: 0 } },
      { ...answer, probabilities: { simple: NaN, complex: 0 } },
      { ...answer, probabilities: { simple: 1.1, complex: -0.1 } },
      { ...answer, probabilities: { simple: 0.7, complex: 0.2 } },
      { ...answer, confidence: Infinity }
    ])
      expect(() => normalizeDecisionAnswer(value, request.criteria)).toThrow()
  })
  it('validates explicit transports and refuses insecure URLs and unrecognized configuration fields', () => {
    for (const baseUrl of [
      'http://classifier.example/v1',
      'https://secret@classifier.example/v1',
      'https://127.0.0.1/v1',
      'https://classifier.example/v1?key=secret',
      'https://classifier.example/v1#fragment'
    ]) {
      expect(() => validateDecisionProviderConfig({ ...custom('chat-completions').config, baseUrl })).toThrow()
    }
    expect(() => validateDecisionProviderConfig({ kind: 'typesafe', model: 'jev-latest', baseUrl: 'https://evil.example' })).toThrow()
    expect(() => validateDecisionProviderConfig({ ...custom('chat-completions').config, dialect: 'automatic' })).toThrow()
    for (const model of ['gpt-4.1', 'jev', 'jev-1.13', 'jev-future', 'jev-latest/other']) {
      expect(() => validateDecisionProviderConfig({ kind: 'typesafe', model })).toThrow()
    }
    for (const secretValue of ['fixture key', 'fixture\nkey', 'fixtureékey']) {
      expect(DecisionProviderWriteSchema.safeParse({ displayName: 'Invalid credential', config: native.config, secretValue }).success).toBe(false)
    }
  })
  it('never assumes a price for unpriced providers and safely rounds estimated USD up to micros', () => {
    expect(estimateDecisionCost(null, { inputTokens: 100, outputTokens: 10, totalTokens: 110, totalTokensSource: 'derived' })).toBeNull()
    expect(
      decisionCostMicros(estimateDecisionCost(TYPESAFE_JEV_PRICING, { inputTokens: 1, outputTokens: 0, totalTokens: 1, totalTokensSource: 'derived' }))
    ).toBe(1)
    expect(() =>
      estimateDecisionCost(
        { ...TYPESAFE_JEV_PRICING, inputPerMillion: 1_000_000 },
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER, totalTokensSource: 'reported' }
      )
    ).toThrow()
  })
})

describe('decision usage consumer contract', () => {
  it('requires total provenance and rejects residuals mislabeled as derived', () => {
    expect(DecisionUsageSchema.safeParse({ inputTokens: 123, outputTokens: 12 }).success).toBe(false)
    expect(DecisionUsageSchema.safeParse({ inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'derived' }).success).toBe(false)
    expect(DecisionUsageSchema.safeParse({ inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }).success).toBe(true)
  })
})
