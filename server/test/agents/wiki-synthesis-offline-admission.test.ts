import { setImmediate } from 'node:timers/promises'
import createKnex, { type Knex } from 'knex'
import { Agent, MockAgent, type Dispatcher } from 'undici/index.js'
import { ax, axGlobals, type AxAIServiceOptions } from '@ax-llm/ax'
import { createNoopMeter, ProxyTracerProvider, type Meter, type Span } from '@opentelemetry/api'
import { AgentProviderRegistry, type AgentProviderTransportKind } from '../../agents/providers/registry.ts'
import { AgentProviderFactory } from '../../agents/providers/factory.ts'
import { createWikiOfflineDispatchAdmission, type WikiOfflineAdmission } from '../../agents/providers/wiki-synthesis-offline-admission.ts'
import type { AgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { createRoutingTables } from './runtime-routing.fixture.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

// A public numeric address needs no DNS service; every HTTP dispatch is intercepted.
const origin = 'https://93.184.216.34'
const secrets: AgentSecretRegistry = {
  has: reference => reference === 'env:OFFLINE_PRICING_FIXTURE',
  get: () => 'unpaid-offline-pricing-fixture',
  store: () => {
    throw new Error('No managed credentials in this fixture')
  },
  delete: () => false
}
const measuredResponse = {
  id: 'msg_fixture',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'Synthetic fixture sentence.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 }
}


const waitForEntry = async (entry: Promise<void>, operation: Promise<unknown>): Promise<void> => {
  await Promise.race([
    entry,
    operation.then(() => { throw new Error('Offline operation settled before entering its expected callback') })
  ])
}

const privateMetadata = 'PRIVATE_OFFLINE_TELEMETRY_DO_NOT_EXPORT'
const dialects: readonly { kind: AgentProviderTransportKind; path: string; model: string; costMicros: number }[] = [
  { kind: 'openai-chat', path: '/v1/chat/completions', model: 'gpt-4o', costMicros: 21 },
  { kind: 'openai-responses', path: '/v1/responses', model: 'gpt-4o', costMicros: 21 },
  { kind: 'openresponses', path: '/v1/responses', model: 'gpt-4o', costMicros: 21 },
  { kind: 'anthropic-messages', path: '/v1/messages', model: 'claude-test', costMicros: 21 },
  { kind: 'gemini-api', path: '/v1/models/gemini-3.1-flash:generateContent', model: 'gemini-3.1-flash', costMicros: 23 },
  { kind: 'legacy-completions', path: '/v1/completions', model: 'legacy-test', costMicros: 40 }
]

const dialectResponse = (kind: AgentProviderTransportKind, rejected = false): Record<string, unknown> => {
  if (kind === 'anthropic-messages') return {
    ...measuredResponse,
    id: `${privateMetadata}_message`,
    stop_reason: rejected ? 'refusal' : 'end_turn',
    usage: { ...measuredResponse.usage, speed: `${privateMetadata}_speed` }
  }
  if (kind === 'gemini-api') return {
    responseId: `${privateMetadata}_response`,
    modelVersion: `${privateMetadata}_model_version`,
    candidates: [{
      index: 0,
      finishReason: rejected ? 'SAFETY' : 'STOP',
      content: { role: 'model', parts: [{ text: 'Synthetic fixture sentence.', thoughtSignature: `${privateMetadata}_signed_state` }] }
    }],
    usageMetadata: {
      promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, cachedContentTokenCount: 6, thoughtsTokenCount: 0,
      serviceTier: `${privateMetadata}_tier`
    }
  }
  if (kind === 'legacy-completions') return {
    id: `${privateMetadata}_completion`,
    choices: [{ text: rejected ? { invalid: true } : 'Synthetic fixture sentence.' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  }
  const usage = {
    ...(kind === 'openai-chat' ? { prompt_tokens: 10, completion_tokens: 2 } : { input_tokens: 10, output_tokens: 2 }),
    total_tokens: 12,
    ...(kind === 'openai-chat'
      ? { prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 } }
      : { input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 } }),
    completion_tokens_details: { reasoning_tokens: `${privateMetadata}_reasoning` },
    output_tokens_details: { reasoning_tokens: `${privateMetadata}_output_reasoning` }
  }
  if (kind === 'openai-chat') return {
    id: `${privateMetadata}_chat`,
    object: 'chat.completion', created: 0, model: 'gpt-4o', usage,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic fixture sentence.', refusal: rejected ? 'Synthetic refusal.' : null }, finish_reason: 'stop' }]
  }
  return {
    id: `${privateMetadata}_response`,
    object: 'response', created_at: 0, status: 'completed', model: 'gpt-4o', usage,
    output: [{
      id: `${privateMetadata}_output_message`, type: 'message', role: 'assistant', status: 'completed',
      content: rejected ? [{ type: 'refusal', refusal: 'Synthetic refusal.' }] : [{ type: 'output_text', text: 'Synthetic fixture sentence.', annotations: [] }]
    }]
  }
}
describe('offline synthesis measured pricing admission', () => {
  let db: Knex
  let mock: MockAgent
  let restoreDispatch: (() => void) | undefined
  let registry: AgentProviderRegistry
  let profileVersionId: string
  let profileInput: Parameters<AgentProviderRegistry['create']>[0]
  let admitted: WikiOfflineAdmission | undefined

  beforeEach(async () => {
    admitted = undefined
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    await createRoutingTables(db)
    registry = new AgentProviderRegistry(db, secrets, { currentKeyId: 'fixture', keys: { fixture: 'offline-pricing-profile-resolution-secret' } })
    profileInput = {
      displayName: 'Offline measured pricing',
      exposureMode: 'all_agent_users',
      actorId: 1,
      transportKind: 'anthropic-messages',
      model: 'claude-test',
      utilityModel: null,
      baseUrl: `${origin}/v1`,
      authMode: 'anthropic-api-key',
      secretReference: 'env:OFFLINE_PRICING_FIXTURE',
      adapterConfig: { timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {} },
      capabilities: {
        streaming: false,
        toolCalling: 'native',
        parallelToolCalls: false,
        structuredOutput: 'native-json-schema',
        usage: 'terminal',
        cancellation: true,
        maxContextTokens: 32_000,
        maxOutputTokens: 4_000
      },
      capabilityRevision: 'fixture-v1',
      pricingRevision: 'cache-v2|2000000|5000000|100000|3000000',
      policies: {
        allowedModes: ['agent'],
        dailyTokens: 1_000_000,
        dailyCostMicros: 10_000_000,
        reservationTokens: 10_000,
        reservationCostMicros: 100_000,
        reservationMilliseconds: 60_000,
        promptVersion: 1,
        maxAttempts: 1
      }
    }
    const profile = await registry.create(profileInput)
    profileVersionId = (await db('agentProviderProfiles').where({ id: profile.id }).first('currentVersionId')).currentVersionId
    await registry.setConformed(profile.id, profileVersionId, true, 1)
    await registry.setEnabled(profile.id, true, 1, profileVersionId)

    const internalAgent = new Agent()
    mock = new MockAgent({ agent: internalAgent })
    mock.disableNetConnect()
    const originalDispatch = Agent.prototype.dispatch
    const intercepted = vi.spyOn(Agent.prototype, 'dispatch').mockImplementation(function (
      this: Agent,
      options: Agent.DispatchOptions,
      handler: Dispatcher.DispatchHandler
    ): boolean {
      // MockAgent itself forwards through its encapsulated Agent; do not recurse.
      return this === internalAgent ? originalDispatch.call(this, options, handler) : mock.dispatch(options, handler)
    })
    restoreDispatch = () => intercepted.mockRestore()
  })

  afterEach(async () => {
    try {
      await admitted?.close()
    } finally {
      restoreDispatch?.()
      restoreDispatch = undefined
      await mock?.close()
      await db?.destroy()
    }
  })

  const admit = async (maximumCostMicros = 100_000): Promise<WikiOfflineAdmission> => {
    admitted = await createWikiOfflineDispatchAdmission(db, {
      ownerId: 7,
      profileVersionId,
      registry,
      secrets,
      label: 'cache accounting fixture',
      maximumCalls: 1,
      maximumTokens: 10_000,
      maximumCostMicros,
      maximumOutputTokens: 8
    })
    return admitted
  }
  const request = { chatPrompt: [{ role: 'user' as const, content: 'Return one synthetic fixture sentence.' }], modelConfig: { maxTokens: 8 } }
  const selectDialect = async (fixture: (typeof dialects)[number]): Promise<void> => {
    const profile = await registry.create({
      ...profileInput,
      transportKind: fixture.kind,
      model: fixture.model,
      authMode: fixture.kind === 'anthropic-messages' ? 'anthropic-api-key' : fixture.kind === 'gemini-api' ? 'google-api-key' : 'bearer',
      capabilities: {
        ...profileInput.capabilities,
        ...(fixture.kind === 'legacy-completions' ? { toolCalling: 'prompt', structuredOutput: 'prompt-only' } : {})
      }
    })
    profileVersionId = (await db('agentProviderProfiles').where({ id: profile.id }).first('currentVersionId')).currentVersionId
    await registry.setConformed(profile.id, profileVersionId, true, 1)
    await registry.setEnabled(profile.id, true, 1, profileVersionId)
  }

  it.each(dialects.flatMap(fixture => ['global', 'scoped'].map(hooks => ({ ...fixture, hooks }))))(
    'keeps $kind private telemetry out of global usage and $hooks metric observers without rewriting native content/state',
    async fixture => {
      await selectDialect(fixture)
      const events: unknown[] = []
      const metrics: unknown[] = []
      const meter = Object.create(createNoopMeter()) as Meter
      meter.createCounter = name => ({ add: (value, attributes) => { metrics.push({ name, value, attributes }) } })
      meter.createHistogram = name => ({ record: (value, attributes) => { metrics.push({ name, value, attributes }) } })
      meter.createUpDownCounter = name => ({ add: (value, attributes) => { metrics.push({ name, value, attributes }) } })
      meter.createGauge = name => ({ record: (value, attributes) => { metrics.push({ name, value, attributes }) } })
      const priorUsage = axGlobals.onUsage
      const priorMeter = axGlobals.meter
      const observer: NonNullable<typeof axGlobals.onUsage> = event => { events.push(event) }
      axGlobals.onUsage = observer
      axGlobals.meter = meter
      mock.get(origin).intercept({ path: fixture.path, method: 'POST' }).reply(200, dialectResponse(fixture.kind), {
        headers: {
          'content-type': 'application/json',
          'x-request-id': `${privateMetadata}_request`,
          'anthropic-session-id': `${privateMetadata}_session`
        }
      })
      try {
        const admission = await admit()
        const response = await admission.service.chat(request, { stream: false, ...(fixture.hooks === 'scoped' ? { meter } : {}) })
        if (response instanceof ReadableStream) throw new Error('Expected the non-streaming fixture')
        expect(response.results[0]?.content).toBe('Synthetic fixture sentence.')
        const remoteId = fixture.kind === 'legacy-completions' ? 'legacy-completion'
          : fixture.kind === 'anthropic-messages' ? `${privateMetadata}_message`
            : fixture.kind === 'openai-chat' ? `${privateMetadata}_chat` : `${privateMetadata}_response`
        expect(response.remoteId).toBe(remoteId)
        if (fixture.kind !== 'legacy-completions') {
          expect(response.remoteRequestId).toBe(`${privateMetadata}_request`)
          expect(response.remoteSessionId).toBe(`${privateMetadata}_session`)
        }
        if (fixture.kind === 'gemini-api') {
          expect(response.results[0]?.thoughtBlocks?.[0]?.data).toContain(`"thoughtSignature":"${privateMetadata}_signed_state"`)
          expect(response.providerMetadata?.google?.modelVersion).toBe(`${privateMetadata}_model_version`)
        }
        expect(events).toHaveLength(1)
        expect(JSON.stringify(events)).not.toContain(privateMetadata)
        expect(metrics).toEqual([])
        expect(axGlobals.onUsage).toBe(observer)
        expect(axGlobals.meter).toBe(meter)
        expect(admission.summary()).toMatchObject({
          calls: 1, dispatchedCalls: 1, failedCalls: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12,
          costMicros: fixture.costMicros, unknownExposureTokens: 0, unknownExposureCostMicros: 0
        })
        mock.assertNoPendingInterceptors()
      } finally {
        axGlobals.onUsage = priorUsage
        axGlobals.meter = priorMeter
      }
    }
  )

  it('keeps native generator metrics private while returning and settling its measured answer', async () => {
    const metrics: unknown[] = []
    const meter = Object.create(createNoopMeter()) as Meter
    meter.createCounter = name => ({ add: (value, attributes) => { metrics.push({ name, value, attributes }) } })
    meter.createHistogram = name => ({ record: (value, attributes) => { metrics.push({ name, value, attributes }) } })
    meter.createUpDownCounter = name => ({ add: (value, attributes) => { metrics.push({ name, value, attributes }) } })
    meter.createGauge = name => ({ record: (value, attributes) => { metrics.push({ name, value, attributes }) } })
    const priorMeter = axGlobals.meter
    axGlobals.meter = meter
    mock
      .get(origin)
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(
        200,
        {
          ...measuredResponse,
          content: [{ type: 'text', text: 'Answer: Synthetic fixture sentence.' }]
        },
        { headers: { 'content-type': 'application/json' } }
      )
    try {
      const admission = await admit()
      const program = ax('"PRIVATE_OFFLINE_GENERATOR_DESCRIPTION_DO_NOT_EXPORT" query:string -> answer:string')
      const answer = await program.forward(
        admission.service,
        { query: 'Return one synthetic fixture sentence.' },
        {
          stream: false,
          maxRetries: 0,
          maxSteps: 1,
          functionCallMode: 'prompt',
          modelConfig: { maxTokens: 8 }
        }
      )
      expect(answer.answer).toBe('Synthetic fixture sentence.')
      expect(metrics).toEqual([])
      expect(axGlobals.meter).toBe(meter)
      expect(admission.summary()).toMatchObject({
        calls: 1,
        dispatchedCalls: 1,
        failedCalls: 0,
        totalTokens: 12,
        costMicros: 21,
        unknownExposureTokens: 0,
        unknownExposureCostMicros: 0
      })
      expect(await db('agentQuotaReservations').select('status', 'consumedTokens', 'consumedCostMicros')).toEqual([
          { status: 'consumed', consumedTokens: 12, consumedCostMicros: 21 }
        ])
      mock.assertNoPendingInterceptors()
    } finally {
      axGlobals.meter = priorMeter
    }
  })

  it.each(dialects.flatMap(fixture => [false, true].map(rejectHook => ({ ...fixture, rejectHook }))))(
    'settles complete $kind usage exactly once before refusal/answer decoding fails with hook rejection $rejectHook and permits measured shared spending',
    async fixture => {
      await selectDialect(fixture)
      mock.get(origin).intercept({ path: fixture.path, method: 'POST' }).reply(200, dialectResponse(fixture.kind, true), {
        headers: { 'content-type': 'application/json' }
      })
      mock.get(origin).intercept({ path: fixture.path, method: 'POST' }).reply(200, dialectResponse(fixture.kind), {
        headers: { 'content-type': 'application/json' }
      })
      const sharedAllowance = { calls: 0, tokens: 0, costMicros: 0 }
      admitted = await createWikiOfflineDispatchAdmission(db, {
        ownerId: 7, profileVersionId, registry, secrets, label: 'measured decoder failure',
        maximumCalls: 2, maximumTokens: 10_000, maximumCostMicros: 100_000, maximumOutputTokens: 8, sharedAllowance
      })
      const rateLimiter: NonNullable<AxAIServiceOptions['rateLimiter']> = async next => {
        await next()
        throw new Error('Synthetic hook failure after the genuine provider body')
      }
      const first = admitted.service.chat(request, { stream: false, ...(fixture.rejectHook ? { rateLimiter } : {}) })
      const second = admitted.service.chat(request, { stream: false })
      const outcomes = await Promise.allSettled([first, second])
      expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'fulfilled'])
      await expect(first).rejects.toThrow('Offline inference failed')
      expect(admitted.summary()).toMatchObject({
        calls: 2, dispatchedCalls: 2, failedCalls: 1, inputTokens: 20, outputTokens: 4, totalTokens: 24,
        costMicros: fixture.costMicros * 2, unknownExposureTokens: 0, unknownExposureCostMicros: 0
      })
      expect(sharedAllowance).toMatchObject({ calls: 2, tokens: 24, costMicros: fixture.costMicros * 2 })
      const settledRuns = await db('agentRuns').select('status', 'totalTokens', 'estimatedCostMicros')
      expect(settledRuns).toHaveLength(2)
      expect(settledRuns).toEqual(expect.arrayContaining([
        { status: 'failed', totalTokens: 12, estimatedCostMicros: fixture.costMicros },
        { status: 'succeeded', totalTokens: 12, estimatedCostMicros: fixture.costMicros }
      ]))
      expect(await db('agentQuotaReservations').select('status', 'consumedTokens', 'consumedCostMicros')).toEqual([
        { status: 'consumed', consumedTokens: 12, consumedCostMicros: fixture.costMicros },
        { status: 'consumed', consumedTokens: 12, consumedCostMicros: fixture.costMicros }
      ])
      const journal = (await db('agentEvents').where({ type: 'usage.updated' }).select('data')).map(row => JSON.parse(row.data))
      expect(journal).toHaveLength(4)
      expect(journal.filter(receipt => !receipt.unknownExposure)).toEqual([
        expect.objectContaining({ receiptTotalTokens: 12, receiptCostMicros: fixture.costMicros, unsettledExposureTokens: 0 }),
        expect.objectContaining({ receiptTotalTokens: 12, receiptCostMicros: fixture.costMicros, unsettledExposureTokens: 0 })
      ])
      mock.assertNoPendingInterceptors()
    }
  )

  it.each(dialects.flatMap(fixture => ['missing usage', 'truncated JSON'].map(failure => ({ ...fixture, failure }))))(
    'halts shared $kind spending after a complete HTTP 200 with $failure instead of inventing a measured receipt',
    async fixture => {
      await selectDialect(fixture)
      const payload = dialectResponse(fixture.kind)
      delete payload.usage
      delete payload.usageMetadata
      const body = fixture.failure === 'missing usage' ? JSON.stringify(payload) : JSON.stringify(dialectResponse(fixture.kind)).slice(0, -1)
      mock.get(origin).intercept({ path: fixture.path, method: 'POST' }).reply(200, body, { headers: { 'content-type': 'application/json' } })
      const sharedAllowance = { calls: 0, tokens: 0, costMicros: 0 }
      admitted = await createWikiOfflineDispatchAdmission(db, {
        ownerId: 7, profileVersionId, registry, secrets, label: 'unmeasured decoder failure',
        maximumCalls: 2, maximumTokens: 10_000, maximumCostMicros: 100_000, maximumOutputTokens: 8, sharedAllowance
      })
      const outcomes = await Promise.allSettled([
        admitted.service.chat(request, { stream: false }),
        admitted.service.chat(request, { stream: false })
      ])
      expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected'])
      const summary = admitted.summary()
      expect(summary).toMatchObject({ calls: 1, dispatchedCalls: 1, failedCalls: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 })
      expect(summary.unknownExposureTokens).toBeGreaterThan(8)
      expect(sharedAllowance).toMatchObject({ calls: 1, tokens: summary.unknownExposureTokens, costMicros: summary.unknownExposureCostMicros })
      expect(await db('agentRuns').select('status', 'totalTokens', 'estimatedCostMicros')).toEqual([
        { status: 'failed', totalTokens: 0, estimatedCostMicros: null }
      ])
      expect(await db('agentEvents').where({ type: 'usage.updated' }).select('id')).toHaveLength(1)
      mock.assertNoPendingInterceptors()
    }
  )

  it.each([
    { fresh: 2, creation: 2, expectedCost: 21 },
    { fresh: 4, creation: 0, expectedCost: 19 },
    { fresh: 4, creation: undefined, expectedCost: 23 }
  ])('settles full input once with cache creation $creation and keeps unknown counters conservative', async fixture => {
    mock
      .get(origin)
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(
        200,
        {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Synthetic fixture sentence.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: fixture.fresh,
            output_tokens: 2,
            cache_read_input_tokens: 6,
            ...(fixture.creation === undefined ? {} : { cache_creation_input_tokens: fixture.creation })
          }
        },
        { headers: { 'content-type': 'application/json' } }
      )
    const admission = await admit()
    await admission.service.chat(request, { stream: false })
    expect(admission.summary()).toMatchObject({
      calls: 1,
      dispatchedCalls: 1,
      failedCalls: 0,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      costMicros: fixture.expectedCost,
      unknownExposureTokens: 0,
      unknownExposureCostMicros: 0
    })
    const quota = await db('agentQuotaReservations').first()
    expect(quota).toMatchObject({ status: 'consumed', consumedTokens: 12, consumedCostMicros: fixture.expectedCost })
    const run = await db('agentRuns').first()
    expect(run).toMatchObject({
      status: 'succeeded',
      totalTokens: 12,
      estimatedCostMicros: fixture.expectedCost,
      pricingRevision: 'cache-v2|2000000|5000000|100000|3000000'
    })
    const journal = (await db('agentEvents').where({ type: 'usage.updated' }).orderBy('sequence')).map(row => JSON.parse(row.data))
    expect(journal[0]).toMatchObject({ unknownExposure: true, receiptCostMicros: 0 })
    expect(journal[0].costMicros).toBe(journal[0].totalTokens * 3 + 16)
    expect(journal[1]).toMatchObject({ unknownExposure: false, inputTokens: 10, totalTokens: 12, costMicros: fixture.expectedCost })
    mock.assertNoPendingInterceptors()
  })

  it.each(['length', 'content_filter'] as const)('settles a measured %s terminal once without admitting it as a candidate', async finishReason => {
    mock
      .get(origin)
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(
        200,
        {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Synthetic fixture sentence.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 }
        },
        { headers: { 'content-type': 'application/json' } }
      )
    const originalCreate = AgentProviderFactory.prototype.create
    // Preserve the real admitted wire call and receipt; vary only the normalized
    // terminal supplied by provider dialects (including Responses content filters).
    const factory = vi.spyOn(AgentProviderFactory.prototype, 'create').mockImplementation(async function (
      this: AgentProviderFactory,
      ...args: Parameters<AgentProviderFactory['create']>
    ) {
      const provider = await originalCreate.apply(this, args)
      const chat = provider.service.chat
      return {
        ...provider,
        service: {
          ...provider.service,
          chat: async (...chatArgs: Parameters<typeof chat>) => {
            const response = await chat(...chatArgs)
            if (response instanceof ReadableStream) throw new Error('Expected the non-streaming fixture')
            return { ...response, results: response.results.map(result => ({ ...result, finishReason })) }
          }
        }
      }
    })
    try {
      const admission = await admit()
      await expect(admission.service.chat(request, { stream: false })).rejects.toThrow('Offline inference failed')
      expect(admission.summary()).toMatchObject({
        calls: 1,
        dispatchedCalls: 1,
        failedCalls: 1,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        costMicros: 21,
        unknownExposureTokens: 0,
        unknownExposureCostMicros: 0
      })
      expect(await db('agentQuotaReservations').first()).toMatchObject({ status: 'consumed', consumedTokens: 12, consumedCostMicros: 21 })
      expect(await db('agentRuns').first()).toMatchObject({ status: 'failed', totalTokens: 12, estimatedCostMicros: 21 })
      const receipts = (await db('agentEvents').where({ type: 'usage.updated' }).orderBy('sequence')).map(row => JSON.parse(row.data))
      expect(receipts).toHaveLength(2)
      expect(receipts[1]).toMatchObject({
        unknownExposure: false,
        receiptTotalTokens: 12,
        receiptCostMicros: 21,
        unsettledExposureTokens: 0,
        unsettledExposureCostMicros: 0
      })
      mock.assertNoPendingInterceptors()
    } finally {
      factory.mockRestore()
    }
  })

  it('retains worst-case paid exposure after failed dispatch instead of discounting unmeasured usage', async () => {
    mock
      .get(origin)
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(
        503,
        {
          type: 'error',
          error: { type: 'overloaded_error', message: 'Synthetic failure' }
        },
        { headers: { 'content-type': 'application/json' } }
      )
    const admission = await admit()
    await expect(admission.service.chat(request, { stream: false })).rejects.toThrow('Offline inference failed')
    const summary = admission.summary()
    expect(summary).toMatchObject({ calls: 1, dispatchedCalls: 1, failedCalls: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 })
    expect(summary.unknownExposureTokens).toBeGreaterThan(8)
    expect(summary.unknownExposureCostMicros).toBe(summary.unknownExposureTokens * 3 + 16)
    expect(await db('agentQuotaReservations').first()).toMatchObject({
      status: 'consumed',
      consumedTokens: summary.unknownExposureTokens,
      consumedCostMicros: summary.unknownExposureCostMicros
    })
    mock.assertNoPendingInterceptors()
  })

  it.each(['provider failure', 'limiter rejection'] as const)('halts queued teacher spending after unmeasured %s with shared allowance remaining', async failure => {
    const sent = Promise.withResolvers<void>()
    const respond = Promise.withResolvers<void>()
    let nativeSettled = false
    const rateLimiter: NonNullable<AxAIServiceOptions['rateLimiter']> = async next => {
      const pending = next()
      pending.then(
        () => { nativeSettled = true },
        () => { nativeSettled = true }
      )
      await waitForEntry(sent.promise, pending)
      throw new Error('Scoped limiter rejected in-flight HTTP')
    }
    mock
      .get(origin)
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(async () => {
        sent.resolve()
        if (failure === 'limiter rejection') await respond.promise
        return {
          statusCode: 503,
          data: { type: 'error', error: { type: 'overloaded_error', message: 'Synthetic failure' } },
          responseOptions: { headers: { 'content-type': 'application/json' } }
        }
      })
    const sharedAllowance = { calls: 0, tokens: 0, costMicros: 0 }
    const input = {
      ownerId: 7,
      profileVersionId,
      registry,
      secrets,
      maximumCalls: 3,
      maximumTokens: 10_000,
      maximumCostMicros: 100_000,
      maximumOutputTokens: 8,
      sharedAllowance
    }
    admitted = await createWikiOfflineDispatchAdmission(db, { ...input, label: 'student' })
    const teacher = await createWikiOfflineDispatchAdmission(db, { ...input, label: 'teacher' })
    try {
      const outcomes = await Promise.allSettled([
        admitted.service.chat(request, { stream: false, ...(failure === 'limiter rejection' ? { rateLimiter } : {}) }),
        teacher.service.chat(request, { stream: false })
      ])
      expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected'])
      if (failure === 'limiter rejection') expect(nativeSettled).toBe(true)
      expect(admitted.summary()).toMatchObject({ calls: 1, dispatchedCalls: 1, failedCalls: 1 })
      expect(admitted.summary().unknownExposureTokens).toBeGreaterThan(8)
      expect(teacher.summary()).toMatchObject({
        calls: 0,
        dispatchedCalls: 0,
        failedCalls: 0,
        totalTokens: 0,
        costMicros: 0,
        unknownExposureTokens: 0,
        unknownExposureCostMicros: 0
      })
      expect(sharedAllowance.calls).toBe(1)
      expect(sharedAllowance.tokens).toBe(admitted.summary().unknownExposureTokens)
      expect(await db('agentQuotaReservations').select('status')).toEqual([{ status: 'consumed' }])
      const journal = (await db('agentEvents').where({ type: 'usage.updated' }).orderBy('sequence')).map(row => JSON.parse(row.data))
      expect(journal).toHaveLength(1)
      expect(journal[0]).toMatchObject({ unknownExposure: true, unsettledExposureTokens: sharedAllowance.tokens })
      expect(await db('agentRuns').select('status', 'totalTokens', 'estimatedCostMicros')).toEqual([
        { status: 'failed', totalTokens: 0, estimatedCostMicros: null }
      ])
      respond.resolve()
      await setImmediate()
      mock.assertNoPendingInterceptors()
    } finally {
      sent.resolve()
      respond.resolve()
      await teacher.close()
    }
  })

  it('honors a forward-scoped limiter denial before admitting or dispatching provider work', async () => {
    let lateNext: (() => Promise<unknown>) | undefined
    const rateLimiter = vi.fn<NonNullable<AxAIServiceOptions['rateLimiter']>>(async next => {
      lateNext = next
      throw new Error('Scoped limiter denied')
    })
    const admission = await admit()
    await expect(admission.service.chat(request, { stream: false, rateLimiter })).rejects.toThrow('Offline inference failed')
    expect(rateLimiter).toHaveBeenCalledTimes(1)
    await admission.close()
    await expect(lateNext!()).rejects.toThrow('Offline inference failed')
    expect(admission.summary()).toMatchObject({
      calls: 0,
      dispatchedCalls: 0,
      failedCalls: 0,
      totalTokens: 0,
      costMicros: 0,
      unknownExposureTokens: 0,
      unknownExposureCostMicros: 0
    })
    expect(await db('agentRuns').select('id')).toEqual([])
    expect(await db('agentQuotaReservations').select('runId')).toEqual([])
  })

  it.each([
    { boundary: 'admission', guard: 1, calls: 0 },
    { boundary: 'committed pre-dispatch guard', guard: 2, calls: 1 }
  ])('drains a rejected limiter next at the $boundary boundary before finalizing or closing', async fixture => {
    const admission = await admit()
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const denied = Promise.withResolvers<void>()
    const resolve = registry.resolveRoutingCandidate.bind(registry)
    let guards = 0
    const authority = vi.spyOn(registry, 'resolveRoutingCandidate').mockImplementation(async (...args) => {
      const resolved = await resolve(...args)
      if (++guards === fixture.guard) {
        entered.resolve()
        await resume.promise
      }
      return resolved
    })
    const http = vi.spyOn(mock, 'dispatch')
    let native: Promise<unknown> | undefined
    let finished = false
    const rateLimiter: NonNullable<AxAIServiceOptions['rateLimiter']> = async next => {
      native = next()
      void native.catch(() => {})
      await waitForEntry(entered.promise, native)
      denied.resolve()
      throw new Error('Scoped limiter rejected after next')
    }
    const running = admission.service.chat(request, { stream: false, rateLimiter }).finally(() => {
      finished = true
    })
    const outcome = Promise.allSettled([running])
    let closing: Promise<void> | undefined
    try {
      await waitForEntry(denied.promise, running)
      // Flush the hook's rejection chain while the real transaction is still fenced.
      await setImmediate()
      expect(finished).toBe(false)
      closing = admission.close()
      await setImmediate()
      expect(finished).toBe(false)
      expect(http).not.toHaveBeenCalled()
      resume.resolve()
      await expect(running).rejects.toThrow('Offline inference failed')
      await native?.catch(() => {})
      await closing
      expect(http).not.toHaveBeenCalled()
      expect(admission.summary()).toMatchObject({
        calls: fixture.calls,
        dispatchedCalls: 0,
        failedCalls: fixture.calls,
        totalTokens: 0,
        costMicros: 0,
        unknownExposureTokens: 0,
        unknownExposureCostMicros: 0
      })
      if (fixture.calls) {
        expect(await db('agentRuns').select('status', 'totalTokens')).toEqual([{ status: 'failed', totalTokens: 0 }])
        expect(await db('agentQuotaReservations').select('status', 'consumedTokens', 'consumedCostMicros')).toEqual([
          { status: 'released', consumedTokens: 0, consumedCostMicros: 0 }
        ])
        const journal = (await db('agentEvents').where({ type: 'usage.updated' }).orderBy('sequence')).map(row => JSON.parse(row.data))
        expect(journal).toHaveLength(2)
        expect(journal[0]).toMatchObject({ unknownExposure: true })
        expect(journal[1]).toMatchObject({ unknownExposure: false, totalTokens: 0, costMicros: 0 })
      } else {
        expect(await db('agentRuns').select('id')).toEqual([])
        expect(await db('agentQuotaReservations').select('runId')).toEqual([])
        expect(await db('agentEvents').where({ type: 'usage.updated' }).select('id')).toEqual([])
      }
    } finally {
      entered.resolve()
      denied.resolve()
      resume.resolve()
      await outcome
      await closing
      authority.mockRestore()
      http.mockRestore()
    }
  })

  it.each(['caller abort', 'close'] as const)('bounds a limiter stalled before next by %s and rejects its late next', async cancellation => {
    const admission = await admit()
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const stalled = Promise.withResolvers<never>()
    const stalledOutcome = Promise.allSettled([stalled.promise])
    let lateNext: (() => Promise<unknown>) | undefined
    const rateLimiter: NonNullable<AxAIServiceOptions['rateLimiter']> = next => {
      lateNext = next
      entered.resolve()
      return stalled.promise
    }
    const running = admission.service.chat(request, { stream: false, rateLimiter, abortSignal: controller.signal })
    // Observe without running Bun's synchronously waiting rejection matcher:
    // cancellation must happen before the assertion is evaluated.
    const outcome = Promise.allSettled([running])
    let closing: Promise<void> | undefined
    try {
      await waitForEntry(entered.promise, running)
      if (cancellation === 'caller abort') controller.abort()
      closing = cancellation === 'close' ? admission.close() : undefined
      await expect(running).rejects.toThrow('Offline inference failed')
      await closing
      await expect(lateNext!()).rejects.toThrow('Offline inference failed')
      expect(admission.summary()).toMatchObject({ calls: 0, dispatchedCalls: 0, failedCalls: 0, unknownExposureTokens: 0, unknownExposureCostMicros: 0 })
      expect(await db('agentRuns').select('id')).toEqual([])
      expect(await db('agentQuotaReservations').select('runId')).toEqual([])
    } finally {
      controller.abort()
      entered.resolve()
      stalled.reject(new Error('Stalled limiter fixture released'))
      await stalledOutcome
      await outcome
      await closing
      await admission.close()
    }
  })

  it.each(['reject', 'return', 'duplicate next', 'caller abort', 'close'] as const)(
    'settles a completed native receipt exactly once when the limiter outcome is %s',
    async hookOutcome => {
      mock
        .get(origin)
        .intercept({ path: '/v1/messages', method: 'POST' })
        .reply(200, measuredResponse, { headers: { 'content-type': 'application/json' } })
      const admission = await admit()
      const controller = new AbortController()
      const completed = Promise.withResolvers<void>()
      const stalled = Promise.withResolvers<never>()
      const stalledOutcome = Promise.allSettled([stalled.promise])
      let lateNext: (() => Promise<unknown>) | undefined
      const rateLimiter: NonNullable<AxAIServiceOptions['rateLimiter']> = async next => {
        lateNext = next
        const native = next()
        if (hookOutcome === 'duplicate next') await expect(next()).rejects.toThrow('Offline inference failed')
        await native
        completed.resolve()
        if (hookOutcome === 'reject') throw new Error('Scoped limiter rejected a completed native response')
        if (hookOutcome === 'caller abort' || hookOutcome === 'close') return stalled.promise
        // Hook output is not provider authority; the genuine native result wins.
        return {} as never
      }
      const running = admission.service.chat(request, { stream: false, rateLimiter, abortSignal: controller.signal })
      const outcome = Promise.allSettled([running])
      let closing: Promise<void> | undefined
      try {
        await waitForEntry(completed.promise, running)
        if (hookOutcome === 'caller abort') controller.abort()
        closing = hookOutcome === 'close' ? admission.close() : undefined
        const failed = hookOutcome === 'reject' || hookOutcome === 'caller abort' || hookOutcome === 'close'
        if (failed) await expect(running).rejects.toThrow('Offline inference failed')
        else {
          const response = await running
          if (response instanceof ReadableStream) throw new Error('Expected the non-streaming fixture')
          expect(response.results[0]?.content).toBe('Synthetic fixture sentence.')
        }
        await outcome
        await closing
        await expect(lateNext!()).rejects.toThrow('Offline inference failed')
        expect(admission.summary()).toMatchObject({
          calls: 1,
          dispatchedCalls: 1,
          failedCalls: failed ? 1 : 0,
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          costMicros: 21,
          unknownExposureTokens: 0,
          unknownExposureCostMicros: 0
        })
        expect(await db('agentRuns').select('status', 'totalTokens', 'estimatedCostMicros')).toEqual([
          { status: failed ? 'failed' : 'succeeded', totalTokens: 12, estimatedCostMicros: 21 }
        ])
        expect(await db('agentQuotaReservations').select('status', 'consumedTokens', 'consumedCostMicros')).toEqual([
          { status: 'consumed', consumedTokens: 12, consumedCostMicros: 21 }
        ])
        const receipts = (await db('agentEvents').where({ type: 'usage.updated' }).orderBy('sequence')).map(row => JSON.parse(row.data))
        expect(receipts).toHaveLength(2)
        expect(receipts[1]).toMatchObject({ unknownExposure: false, receiptTotalTokens: 12, receiptCostMicros: 21, unsettledExposureTokens: 0 })
      } finally {
        controller.abort()
        completed.resolve()
        stalled.reject(new Error('Stalled completed limiter fixture released'))
        await stalledOutcome
        await outcome
        await closing
        await admission.close()
      }
      mock.assertNoPendingInterceptors()
    }
  )

  it('keeps a cancelled shared queue entry behind native work when a limiter returns before next settles', async () => {
    const sharedAllowance = { calls: 0, tokens: 0, costMicros: 0 }
    const input = {
      ownerId: 7,
      profileVersionId,
      registry,
      secrets,
      maximumCalls: 3,
      maximumTokens: 10_000,
      maximumCostMicros: 100_000,
      maximumOutputTokens: 8,
      sharedAllowance
    }
    admitted = await createWikiOfflineDispatchAdmission(db, { ...input, label: 'started student' })
    const cancelled = await createWikiOfflineDispatchAdmission(db, { ...input, label: 'cancelled teacher' })
    const sibling = await createWikiOfflineDispatchAdmission(db, { ...input, label: 'queued comparison' })
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const resolve = registry.resolveRoutingCandidate.bind(registry)
    let firstGuard = true
    const authority = vi.spyOn(registry, 'resolveRoutingCandidate').mockImplementation(async (...args) => {
      const resolved = await resolve(...args)
      if (firstGuard) {
        firstGuard = false
        entered.resolve()
        await resume.promise
      }
      return resolved
    })
    const http = vi.spyOn(mock, 'dispatch')
    mock
        .get(origin)
        .intercept({ path: '/v1/messages', method: 'POST' })
        .reply(200, measuredResponse, { headers: { 'content-type': 'application/json' } })
    const firstLimiter: NonNullable<AxAIServiceOptions['rateLimiter']> = async next => {
      void next().catch(() => {})
      return {} as never
    }
    const siblingLimiter = vi.fn<NonNullable<AxAIServiceOptions['rateLimiter']>>(async next => next())
    const controller = new AbortController()
    const first = admitted.service.chat(request, { stream: false, rateLimiter: firstLimiter })
    const firstOutcome = Promise.allSettled([first])
    const second = cancelled.service.chat(request, { stream: false, abortSignal: controller.signal })
    const secondOutcome = Promise.allSettled([second])
    const third = sibling.service.chat(request, { stream: false, rateLimiter: siblingLimiter })
    const thirdOutcome = Promise.allSettled([third])
    let closing: Promise<void> | undefined
    try {
      await waitForEntry(entered.promise, first)
      controller.abort()
      await expect(second).rejects.toThrow('Offline inference failed')
      await setImmediate()
      expect(siblingLimiter).not.toHaveBeenCalled()
      expect(http).not.toHaveBeenCalled()
      closing = admitted.close()
      await setImmediate()
      expect(siblingLimiter).not.toHaveBeenCalled()
      resume.resolve()
      await expect(first).rejects.toThrow('Offline inference failed')
      await closing
      await third
      expect(siblingLimiter).toHaveBeenCalledTimes(1)
      expect(http).toHaveBeenCalledTimes(1)
      expect(admitted.summary()).toMatchObject({ calls: 0, dispatchedCalls: 0 })
      expect(cancelled.summary()).toMatchObject({ calls: 0, dispatchedCalls: 0 })
      expect(sibling.summary()).toMatchObject({ calls: 1, dispatchedCalls: 1, totalTokens: 12, costMicros: 21 })
      expect(sharedAllowance).toMatchObject({ calls: 1, tokens: 12, costMicros: 21 })
      expect(await db('agentRuns').select('status', 'totalTokens')).toEqual([{ status: 'succeeded', totalTokens: 12 }])
      expect(await db('agentQuotaReservations').select('status', 'consumedTokens')).toEqual([{ status: 'consumed', consumedTokens: 12 }])
      expect(await db('agentEvents').where({ type: 'usage.updated' }).select('id')).toHaveLength(2)
      mock.assertNoPendingInterceptors()
    } finally {
      controller.abort()
      entered.resolve()
      resume.resolve()
      await firstOutcome
      await secondOutcome
      await thirdOutcome
      await closing
      authority.mockRestore()
      http.mockRestore()
      await cancelled.close()
      await sibling.close()
    }
  })

  it.each(['global', 'scoped'] as const)('isolates native function-name reflection from an exporting %s meter', async source => {
    const privateFunction = 'PRIVATE_OFFLINE_PROVIDER_FUNCTION_DO_NOT_EXPORT'
    const captured: unknown[] = []
    const meter = Object.create(createNoopMeter()) as Meter
    meter.createCounter = name => ({
      add: (value, attributes) => { captured.push({ name, value, attributes }) }
    })
    meter.createHistogram = name => ({
      record: (value, attributes) => { captured.push({ name, value, attributes }) }
    })
    meter.createUpDownCounter = name => ({
      add: (value, attributes) => { captured.push({ name, value, attributes }) }
    })
    meter.createGauge = name => ({
      record: (value, attributes) => { captured.push({ name, value, attributes }) }
    })
    const priorMeter = axGlobals.meter
    axGlobals.meter = meter
    mock
      .get(origin)
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(
        200,
        { ...measuredResponse, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool_fixture', name: privateFunction, input: {} }] },
        { headers: { 'content-type': 'application/json' } }
      )
    try {
      const admission = await admit()
      const options = { stream: false, ...(source === 'scoped' ? { meter } : {}) }
      admission.service.validateChatRequest?.(request, options)
      const response = await admission.service.chat(request, options)
      if (response instanceof ReadableStream) throw new Error('Expected the non-streaming fixture')
      expect(response.results[0]?.functionCalls?.[0]?.function.name).toBe(privateFunction)
      expect(captured).toEqual([])
      expect(admission.summary()).toMatchObject({
        calls: 1, dispatchedCalls: 1, totalTokens: 12, costMicros: 21, unknownExposureTokens: 0, unknownExposureCostMicros: 0
      })
      expect(await db('agentQuotaReservations').select('status', 'consumedTokens', 'consumedCostMicros')).toEqual([
          { status: 'consumed', consumedTokens: 12, consumedCostMicros: 21 }
        ])
      expect(await db('agentEvents').where({ type: 'usage.updated' }).select('id')).toHaveLength(2)
      mock.assertNoPendingInterceptors()
    } finally {
      axGlobals.meter = priorMeter
    }
  })

  it('isolates private failed native inference from an inherited recording tracer without releasing paid exposure', async () => {
    const privatePrompt = 'PRIVATE_OFFLINE_PROMPT_DO_NOT_RECORD'
    const privateFailure = 'PRIVATE_OFFLINE_PROVIDER_ERROR_DO_NOT_RECORD'
    const priorTracer = axGlobals.tracer
    const inheritedTracer = new ProxyTracerProvider().getTracer('offline-admission-inherited')
    const backingTracer = new ProxyTracerProvider().getTracer('offline-admission-span-fixture')
    const captured: unknown[] = []
    const inheritedSpans = vi.spyOn(inheritedTracer, 'startSpan').mockImplementation(() => {
      const span = backingTracer.startSpan('offline-private-native-fixture')
      vi.spyOn(span, 'isRecording').mockReturnValue(true)
      vi.spyOn(span, 'recordException').mockImplementation(exception => {
        captured.push(exception)
      })
      vi.spyOn(span, 'setAttribute').mockImplementation((key, value) => {
        captured.push({ key, value })
        return span
      })
      vi.spyOn(span, 'setAttributes').mockImplementation(attributes => {
        captured.push(attributes)
        return span
      })
      vi.spyOn(span, 'addEvent').mockImplementation((name, attributes) => {
        captured.push({ name, attributes })
        return span
      })
      return span
    })
    const inheritedActiveSpans = vi.spyOn(inheritedTracer, 'startActiveSpan').mockImplementation(((...args: unknown[]) => {
      const callback = args[args.length - 1] as (span: Span) => unknown
      return callback(inheritedTracer.startSpan('offline-private-active-fixture'))
    }) as typeof inheritedTracer.startActiveSpan)
    mock
      .get(origin)
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(
        503,
        {
          type: 'error',
          error: { type: 'overloaded_error', message: privateFailure }
        },
        { headers: { 'content-type': 'application/json' } }
      )
    axGlobals.tracer = inheritedTracer
    try {
      const admission = await admit()
      const privateRequest = { ...request, chatPrompt: [{ role: 'user' as const, content: privatePrompt }] }
      const options = { stream: false, tracer: new ProxyTracerProvider().getTracer('offline-program-private') }
      admission.service.validateChatRequest?.(privateRequest, options)
      await expect(admission.service.chat(privateRequest, options)).rejects.toThrow('Offline inference failed')
      expect(inheritedSpans.mock.calls.length).toBe(0)
      expect(inheritedActiveSpans.mock.calls.length).toBe(0)
      expect(captured).toEqual([])
      const summary = admission.summary()
      expect(summary).toMatchObject({ calls: 1, dispatchedCalls: 1, failedCalls: 1, totalTokens: 0, costMicros: 0 })
      expect(summary.unknownExposureTokens).toBeGreaterThan(8)
      expect(await db('agentQuotaReservations').first()).toMatchObject({
      status: 'consumed',
      consumedTokens: summary.unknownExposureTokens,
      consumedCostMicros: summary.unknownExposureCostMicros
    })
      expect(await db('agentRuns').first()).toMatchObject({ status: 'failed', errorCode: 'OFFLINE_INFERENCE_FAILED' })
      mock.assertNoPendingInterceptors()
    } finally {
      axGlobals.tracer = priorTracer
      inheritedSpans.mockRestore()
      inheritedActiveSpans.mockRestore()
    }
  })

  it('denies worst-case admission before HTTP even when cache reads would be free or cheap', async () => {
    const admission = await admit(1)
    await expect(admission.service.chat(request, { stream: false })).rejects.toThrow('Offline inference failed')
    expect(admission.summary()).toMatchObject({
      calls: 0,
      dispatchedCalls: 0,
      failedCalls: 0,
      totalTokens: 0,
      costMicros: 0,
      unknownExposureTokens: 0,
      unknownExposureCostMicros: 0
    })
    expect(await db('agentRuns').select('id')).toEqual([])
    expect(await db('agentQuotaReservations').select('runId')).toEqual([])
  })
})
