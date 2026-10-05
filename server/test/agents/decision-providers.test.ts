import type { lookup } from 'node:dns/promises'
import { describe, expect, it } from '../bun-test.mts'
import {
  DecisionProviderClient,
  DecisionProviderFailure,
  decisionCostMicros,
  estimateDecisionCost,
  normalizeDecisionAnswer,
  validateDecisionProviderConfig,
  type DecisionProviderRuntime
} from '../../agents/decision-providers.ts'
import { DecisionProviderWriteSchema, DecisionUsageSchema, TYPESAFE_JEV_PRICING, type DecisionRequest } from '../../../shared/agents/decision-providers.ts'

const publicDns = (async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof lookup
const request: DecisionRequest = {
  state: { message: 'Explain the title', priorTurns: [] },
  instructions: 'Choose the required effort.',
  criteria: { simple: { description: 'Short factual answer' }, complex: ['Multi-step analysis', 'Cross-document synthesis'] }
}
const native: DecisionProviderRuntime = {
  id: 'native-test',
  revision: 3,
  config: { kind: 'typesafe', model: 'jev-latest', timeoutMs: 1_000, pricing: TYPESAFE_JEV_PRICING }
}
const answer = { choice: 'simple', probabilities: { simple: 0.8, complex: 0.2 }, confidence: 0.6 }
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
      const error = await client.execute(custom('chat-completions'), 'fixture-secret', request).catch(value => value)
      expect(error).toBeInstanceOf(DecisionProviderFailure)
      expect(error).toMatchObject({ usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, totalTokensSource: 'derived' } })
      expect(JSON.stringify(error)).not.toContain('fixture-secret')
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

  for (const failure of ['invalid-decision', 'ax-refusal'] as const) {
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
                  content: JSON.stringify({ ...answer, probabilities: { simple: 0.8, complex: 0.2, unauthorized: 0 } }),
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
    expect(error).toMatchObject({ code: 'DECISION_PROVIDER_UNAVAILABLE', usage: null })
    expect(error.message).not.toContain('fixture-private')
    expect(calls).toBe(1)
  })

  it('bounds response bodies even without Content-Length', async () => {
    const client = new DecisionProviderClient({ resolve: publicDns, fetch: fakeFetch(() => new Response('x'.repeat(256 * 1_024 + 1))) })
    await expect(client.execute(native, 'fixture', request)).rejects.toMatchObject({ code: 'INVALID_DECISION_RESPONSE' })
  })

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
    const controller = new AbortController()
    const pending = client.execute(native, 'fixture', request, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'DECISION_ABORTED' })
  })
})

describe('decision validation and cost semantics', () => {
  it('normalizes tolerated rounding without changing labels or reporting probabilities as confidence', () => {
    const result = normalizeDecisionAnswer({ ...answer, probabilities: { simple: 0.79, complex: 0.2 } }, request.criteria)
    expect(result.probabilities.simple).toBeCloseTo(0.797979797979798)
    expect(result.probabilities.simple! + result.probabilities.complex!).toBeCloseTo(1)
    expect(result.confidence).toBe(0.6)
  })
  it('rejects unknown, missing, negative, nonfinite and nonsumming probabilities and a nonmaximal choice', () => {
    for (const value of [
      { ...answer, choice: 'unknown' },
      { ...answer, probabilities: { simple: 1 } },
      { ...answer, probabilities: { simple: 0.8, complex: 0.2, extra: 0 } },
      { ...answer, probabilities: { simple: Infinity, complex: 0 } },
      { ...answer, probabilities: { simple: NaN, complex: 0 } },
      { ...answer, probabilities: { simple: 1.1, complex: -0.1 } },
      { ...answer, probabilities: { simple: 0.7, complex: 0.2 } },
      { ...answer, choice: 'complex' },
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
