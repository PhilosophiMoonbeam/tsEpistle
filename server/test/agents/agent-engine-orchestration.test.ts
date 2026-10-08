import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { AgentChildBudgetReservations, type AgentOrchestrationLimits } from '../../agents/orchestration.ts'

import { type AgentActionSessionProvider, AxAgentEngine } from '../../agents/providers/engine.ts'
import { AgentExecutionFailure } from '../../agents/providers/execution-failure.ts'
import { AgentProviderAttemptError, type AgentProviderFactory, type AgentProviderService } from '../../agents/providers/factory.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import type {
  AgentDispatchBudget,
  AgentDispatchBudgetReservation,
  AgentDispatchBudgetSequence,
  AgentDispatchUsage,
  AgentEngineRequest
} from '../../agents/runtime.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

import { fullAxFixtureService, synthesisFixtureAnswer, synthesisInputFromRequest, synthesisSourcesFromRequest, type SynthesisFixtureAnswer } from './synthesis-fixture.ts'
const pricing = { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } as const

const run = {
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  userMessageId: '00000000-0000-4000-8000-000000000003',
  assistantMessageId: '00000000-0000-4000-8000-000000000004',
  goalId: null,
  goalContinuation: null,
  ownerId: 7,
  clientRequestId: '00000000-0000-4000-8000-000000000005',
  clientRequestSha256: 'a'.repeat(64),
  status: 'running',
  providerProfileVersionId: '00000000-0000-4000-8000-000000000006',
  transportKind: 'openai-responses',
  model: 'gpt-test',
  executionMode: 'agent',
  capabilityRevision: 'cap-1',
  pricingRevision: 'price-1',
  totalTokens: 0,
  promptVersion: 1,
  attempts: 1,
  maxAttempts: 3,
  eventSequence: 0,
  leaseOwner: 'worker',
  leaseToken: '00000000-0000-4000-8000-000000000007',
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  cancelRequestedAt: null,
  sideEffectsStarted: false,
  availableAt: new Date().toISOString(),
  queuedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  completedAt: null,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostMicros: null,
  errorCode: null,
  errorMessage: null
} as const

const baseRequest = (signal: AbortSignal): AgentEngineRequest => ({
  run,
  messages: [{ role: 'user', content: 'Compare alpha and beta.' }],
  memory: { user: ['private preference'], agent: ['private note'] },
  skills: [],
  priorActivity: [],
  signal
})

const factoryFor = (
  chat: AgentProviderService['service']['chat'],
  options: {
    readonly streaming?: boolean
    readonly usage?: 'stream' | 'terminal' | 'estimated'
    readonly maxContextTokens?: number
    readonly maxOutputTokens?: number
    readonly preserveThoughtBlock?: AgentProviderService['preserveThoughtBlock']
  } = {}
): AgentProviderFactory =>
  ({
    create: async () => ({
      service: fullAxFixtureService(async (request, chatOptions) => {
        const response = await chat(request, chatOptions)
        if (response instanceof ReadableStream) return response
        return {
          ...response,
          results: response.results.map(result => ({
            ...result,
            ...(result.content === undefined ? {} : { content: synthesisFixtureAnswer(request, result.content) })
          }))
        }
      }, { model: 'gpt-test', streaming: options.streaming ?? false }),
      capabilities: {
        streaming: options.streaming ?? false,
        toolCalling: 'native',
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema',
        usage: options.usage ?? 'estimated',
        cancellation: true,
        maxContextTokens: options.maxContextTokens ?? 100_000,
        maxOutputTokens: options.maxOutputTokens ?? 4_000
      },
      transportKind: 'openai-responses',
      model: 'gpt-test',
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1',
      pricing,
      preserveThoughtBlock: options.preserveThoughtBlock
    })
  }) as unknown as AgentProviderFactory
const finishCollectionResponse = {
  results: [{ index: 0, functionCalls: [{ id: 'finish-collection', type: 'function', function: { name: 'wiki_finish_collection', params: '{}' } }] }],
  modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
} satisfies AxChatResponse
const offersCollectionFinish = (request: Readonly<AxChatRequest<unknown>>): boolean =>
  request.functions?.some(fn => fn.name === 'wiki_finish_collection') ?? false
const pageEvidenceActions = (
  validateObservation?: (actionName: string, output: unknown, signal: AbortSignal) => Promise<boolean>
): AgentActionSessionProvider =>
  ({
    open: async () => ({
      functions: [
        {
          name: 'pages.get',
          title: 'Read page',
          description: 'Read canonical page evidence',
          parameters: { type: 'object', properties: {} },
          risk: 'read'
        }
      ],
      invoke: async () => {
        throw new Error('No direct page read was expected')
      },
      snapshot: async () => ({}),
      close: () => undefined,
      authoritySha256: null,
      ...(validateObservation === undefined ? {} : { validateObservation })
    })
  }) as unknown as AgentActionSessionProvider
const utf8Chunks = (value: string, maximumBytes: number): readonly string[] => {
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (current.length > 0 && currentBytes + bytes > maximumBytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += bytes
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current)
  return chunks
}

const responseStream = (responses: readonly AxChatResponse[], cancel?: (reason: unknown) => Promise<void> | void): ReadableStream<AxChatResponse> => {
  let index = 0
  return new ReadableStream<AxChatResponse>(
    {
      pull(controller) {
        const response = responses[index]
        if (response === undefined) {
          controller.close()
          return
        }
        index += 1
        controller.enqueue(response)
      },
      cancel
    },
    { highWaterMark: 0 }
  )
}

describe('Ax orchestration stages', () => {
  it('uses the same bounded root output exposure for preflight and actual generation on large provider profiles', async () => {
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => ({
      results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }]
    }) satisfies AxChatResponse)
    const engine = new AxAgentEngine(factoryFor(chat, { maxOutputTokens: 32_768 }))
    const request = baseRequest(new AbortController().signal)
    const preflight = await engine.preflight(request)
    const event = vi.fn(async () => {})
    const result = await engine.execute(request, { text: async () => {}, event })

    expect(preflight).toMatchObject({ admissible: true, outputExposureTokens: 16_384 })
    expect(chat.mock.calls[0]?.[0].modelConfig).toMatchObject({ maxTokens: 16_384 })
    expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
    expect(result.citations).toBeUndefined()
    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted' })])
  })

  it('classifies wrapped request, stream, and response failures at their engine boundaries', async () => {
    const wrappedRequest = Object.assign(new Error('provider request secret'), {
      cause: Object.assign(new Error('sdk wrapper secret'), {
        originalError: new AgentProviderAttemptError('provider_secret_code', 429, null, 'api_key')
      }),
      body: 'request body secret',
      headers: 'authorization secret'
    })
    const requestError = await new AxAgentEngine(
      factoryFor(
        vi.fn(async () => {
          throw wrappedRequest
        })
      )
    )
      .execute(baseRequest(new AbortController().signal), { text: async () => {}, event: async () => {} })
      .catch(error => error)
    expect(requestError).toBeInstanceOf(AgentExecutionFailure)
    expect(requestError).toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      stage: 'provider_request',
      providerStatus: 429,
      message: 'Agent inference failed'
    })
    expect(JSON.stringify(requestError)).not.toContain('provider_secret_code')
    expect(JSON.stringify(requestError)).not.toContain('api_key')
    expect(JSON.stringify(requestError)).not.toContain('request body secret')
    expect(JSON.stringify(requestError)).not.toContain('authorization secret')

    const streamFailure = Object.assign(new Error('provider stream secret'), {
      cause: new AgentProviderAttemptError('stream_secret_code', 503, null, 'token')
    })
    const stream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.error(streamFailure)
      }
    })
    const streamError = await new AxAgentEngine(factoryFor(async () => stream))
      .execute(baseRequest(new AbortController().signal), { text: async () => {}, event: async () => {} })
      .catch(error => error)
    expect(streamError).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', stage: 'provider_stream', providerStatus: 503 })
    expect(JSON.stringify(streamError)).not.toContain('stream_secret_code')
    expect(JSON.stringify(streamError)).not.toContain('token')

    const malformedResponse = {
      results: [{ index: 0, functionCalls: [{ id: '', type: 'function', function: { name: 'wiki_get_page', params: '{}' } }] }]
    } satisfies AxChatResponse
    const responseError = await new AxAgentEngine(factoryFor(async () => malformedResponse))
      .execute(baseRequest(new AbortController().signal), { text: async () => {}, event: async () => {} })
      .catch(error => error)
    expect(responseError).toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response', message: 'Agent inference failed' })
  })
  it('awaits one safe cancellation before releasing an incomplete provider stream', async () => {
    const reservation = { id: 'reservation', tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    let resolveCancelStarted!: () => void
    let resolveCancel!: () => void
    const cancelStarted = new Promise<void>(resolve => {
      resolveCancelStarted = resolve
    })
    let cancelReason: unknown
    let cancelCalls = 0
    const stream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'partial' }],
          modelUsage: null
        } as unknown as AxChatResponse)
      },
      cancel(reason) {
        cancelCalls += 1
        cancelReason = reason
        resolveCancelStarted()
        return new Promise<void>(resolve => {
          resolveCancel = resolve
        })
      }
    })
    const chat = vi.fn(async () => stream)
    const execution = new AxAgentEngine(factoryFor(chat, { streaming: true, usage: 'stream' })).execute(
      {
        ...baseRequest(new AbortController().signal),
        purpose: 'planner',
        dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      },
      { text: async () => {}, event: async () => {} }
    )
    let settled = false
    const observed = execution.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await cancelStarted
    expect(settled).toBe(false)
    expect(stream.locked).toBe(true)
    expect(cancelReason).toBe('provider stream failed')
    expect(cancelCalls).toBe(1)
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()

    resolveCancel()
    await expect(execution).rejects.toMatchObject({ code: 'PROVIDER_USAGE_INVALID', stage: 'provider_response' })
    await observed
    expect(reconcile).not.toHaveBeenCalled()
    expect(stream.locked).toBe(false)
    expect(release).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledOnce()
  })

  it('preserves the primary stream failure when cancellation rejects and releases the reader lock', async () => {
    const rawCancelFailure = new Error('raw cancellation secret')
    let cancelCalls = 0
    let cancelReason: unknown
    const stream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'partial' }],
          modelUsage: null
        } as unknown as AxChatResponse)
      },
      cancel(reason) {
        cancelCalls += 1
        cancelReason = reason
        return Promise.reject(rawCancelFailure)
      }
    })
    const chat = vi.fn(async () => stream)
    const error = await new AxAgentEngine(factoryFor(chat, { streaming: true, usage: 'stream' }))
      .execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: async () => {}, event: async () => {} })
      .catch(failure => failure)

    expect(error).toMatchObject({ code: 'PROVIDER_USAGE_INVALID', stage: 'provider_response', message: 'Agent inference failed' })
    expect(JSON.stringify(error)).not.toContain('raw cancellation secret')
    expect(cancelReason).toBe('provider stream failed')
    expect(cancelCalls).toBe(1)
    expect(chat).toHaveBeenCalledOnce()

    const releasedReader = stream.getReader()
    releasedReader.releaseLock()
  })

  it('switches to bounded synthesis after tool-result capacity and returns an explicit context limit', async () => {
    const calls = Array.from({ length: 10 }, (_, index) => ({
      id: `second-${index}`,
      type: 'function' as const,
      function: { name: 'wiki_get_page', params: JSON.stringify({ id: index + 2 }) }
    }))
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'first', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }] },
      { results: [{ index: 0, functionCalls: calls }] }
    ]
    const synthesisRequests: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      if (synthesisInputFromRequest(input) !== undefined) {
        synthesisRequests.push(input)
        return {
          results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }]
        } satisfies AxChatResponse
      }
      return responses.shift()!
    })
    const invoke = vi.fn(async (_name: string, _input: unknown, _signal: AbortSignal, actionCallId: string) => ({
      content: actionCallId === calls[0]!.id ? 'x'.repeat(120_000) : 'x'.repeat(3_000)
    }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const event = vi.fn(async () => {})
    const result = await new AxAgentEngine(factoryFor(chat, { maxOutputTokens: 1_000 }), actions).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTurns: 4, maxToolCalls: 11, maxOutputTokens: 100 }
      },
      { text: async () => {}, event }
    )

    expect(result.contextLimit).toEqual({ reason: 'tool_result_capacity', omittedActionCallIds: calls.map(call => call.id) })
    expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
    expect(result.citations).toBeUndefined()
    expect(synthesisRequests).toHaveLength(1)
    expect(synthesisRequests.flatMap(input => input.functions ?? []).map(fn => fn.name)).toEqual([])
    expect(synthesisRequests[0]?.modelConfig?.maxTokens).toBeLessThanOrEqual(100)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.map(call => call[3])).toEqual(['first', calls[0]!.id])
    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted' })])
  })
  it('runs the planner without actions, retries, or unbounded output', async () => {
    const chat = vi.fn(
      async () =>
        ({
          results: [{ index: 0, content: '{"tasks":[]}' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } }
        }) satisfies AxChatResponse
    )
    const open = vi.fn()
    const text = vi.fn(async () => {})
    const engine = new AxAgentEngine(factoryFor(chat), { open } as unknown as AgentActionSessionProvider)

    expect(
      await engine.execute(
        {
          ...baseRequest(new AbortController().signal),
          purpose: 'planner',
          actionAllowlist: [],
          limits: { maxTurns: 2, maxToolCalls: 0, maxOutputTokens: 1_024 }
        },
        { text, event: async () => {} }
      )
    ).toMatchObject({ inputTokens: 4, outputTokens: 2, totalTokens: 6, costMicros: 8 })

    expect(open).not.toHaveBeenCalled()
    expect(text).toHaveBeenCalledWith('{"tasks":[]}')
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: { maxTokens: 1_024 },
        chatPrompt: [expect.objectContaining({ role: 'system', content: expect.stringContaining('task-planning stage') }), expect.any(Object)]
      }),
      expect.objectContaining({ retry: { maxRetries: 0 } })
    )
    expect(chat.mock.calls[0]?.[0]).not.toHaveProperty('functions')
  })

  it('namespaces child action calls and returns the frozen authority hash', async () => {
    const taskId = '00000000-0000-4000-8000-000000000011'
    const subagentRunId = '00000000-0000-4000-8000-000000000012'
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'provider-call', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }] },
      {
        results: [
          {
            index: 0,
            content: JSON.stringify({
              taskId,
              outcome: 'completed',
              claims: [
                {
                  text: 'Alpha requires review. [[cite:page:1:revision:rev-1]]',
                  evidenceIds: ['page:1:revision:rev-1'],
                  sourceRevisionIds: ['rev-1'],
                  confidence: 'high'
                }
              ],
              conflicts: [],
              unanswered: [],
              recommendedFollowups: []
            })
          }
        ]
      }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const invoke = vi.fn(async () => ({
      id: 1,
      locale: 'en',
      path: 'alpha',
      sourceRevision: 'rev-1',
      title: 'Alpha',
      contentType: 'markdown',
      content: 'Alpha requires review.',
      citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }))
    const authoritySha256 = 'b'.repeat(64)
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256
      })
    }
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      purpose: 'subagent',
      task: { id: taskId, kind: 'source_scout', title: 'Review alpha', question: 'What does alpha require?', sourceScope: ['alpha'], requiredEvidenceCount: 1 },
      subagentRunId,
      actionAllowlist: ['pages.get'],
      limits: { maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 2_048 }
    }
    const text = vi.fn(async () => {})

    const result = await new AxAgentEngine(factoryFor(chat), actions).execute(request, { text, event: async () => {} })

    expect(invoke).toHaveBeenCalledWith(
      'pages.get',
      { id: 1 },
      expect.any(AbortSignal),
      expect.stringMatching(new RegExp(`^sa_${subagentRunId}_[a-f0-9]{24}$`, 'u'))
    )
    expect(result.authoritySha256).toBe(authoritySha256)
    expect(text).toHaveBeenCalledWith(expect.stringContaining('"taskId"'))
    const systemPrompt = (chat.mock.calls[0]?.[0] as AxChatRequest<unknown> | undefined)?.chatPrompt?.[0]
    expect(systemPrompt).toEqual(expect.objectContaining({ content: expect.not.stringContaining('private preference') }))
  })

  it('stops a two-turn child before an uncovered third dispatch at the aggregate token ceiling', async () => {
    const responses: AxChatResponse[] = [
      {
        results: [{ index: 0, functionCalls: [{ id: 'first', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
      },
      {
        results: [{ index: 0, functionCalls: [{ id: 'second', type: 'function', function: { name: 'wiki_get_page', params: '{"id":2}' } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } }
      }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const invoke = vi.fn(async () => ({ id: 1, sourceRevision: 'rev-1', title: 'Alpha', content: 'Alpha' }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const taskId = '00000000-0000-4000-8000-000000000031'

    await expect(
      Promise.resolve(
        new AxAgentEngine(factoryFor(chat), actions).execute(
          {
            ...baseRequest(new AbortController().signal),
            purpose: 'subagent',
            task: {
              id: taskId,
              kind: 'source_scout',
              title: 'Review alpha',
              question: 'What does alpha require?',
              sourceScope: ['alpha'],
              requiredEvidenceCount: 1
            },
            subagentRunId: '00000000-0000-4000-8000-000000000032',
            actionAllowlist: ['pages.get'],
            limits: { maxTokens: 4, maxTurns: 3, maxToolCalls: 3, maxOutputTokens: 4 }
          },
          { text: async () => {}, event: async () => {} }
        )
      )
    ).rejects.toMatchObject({ code: 'AGENT_CHILD_BUDGET_EXCEEDED' })

    expect(chat).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ modelConfig: { maxTokens: 1 } }))
  })

  it('consumes the 6000-token child allowance at dispatch while retaining the 2048-token output ceiling', async () => {
    const providerRequests: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      providerRequests.push(input)
      if (providerRequests.length !== 1) throw new Error('Exhausted child must not dispatch another provider request.')
      return {
        results: [{ index: 0, functionCalls: [{ id: 'read-alpha', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 5_999, completionTokens: 1, totalTokens: 6_000 } }
      } satisfies AxChatResponse
    })
    const invoke = vi.fn(async () => ({
      id: 1,
      locale: 'en',
      path: 'alpha',
      sourceRevision: 'rev-1',
      title: 'Alpha',
      contentType: 'markdown',
      content: 'Alpha requires review.',
      citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }))
    const close = vi.fn()
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close,
        authoritySha256: 'b'.repeat(64)
      })
    }
    const text = vi.fn(async () => {})
    await expect(
      new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions).execute(
        {
          ...baseRequest(new AbortController().signal),
          purpose: 'subagent',
          task: {
            id: '00000000-0000-4000-8000-000000000041',
            kind: 'source_scout',
            title: 'Review alpha',
            question: 'What does alpha require?',
            sourceScope: ['alpha'],
            requiredEvidenceCount: 1
          },
          subagentRunId: '00000000-0000-4000-8000-000000000042',
          actionAllowlist: ['pages.get'],
          limits: { maxTokens: 6_000, maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 2_048 }
        },
        { text, event: async () => {} }
      )
    ).rejects.toMatchObject({ code: 'AGENT_CHILD_BUDGET_EXCEEDED' })

    expect(providerRequests).toHaveLength(1)
    expect(providerRequests[0]!.modelConfig?.maxTokens).toBe(2_048)
    expect(JSON.stringify(providerRequests[0])).not.toContain('private preference')
    expect(JSON.stringify(providerRequests[0])).not.toContain('private note')
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(
      'pages.get',
      { id: 1 },
      expect.any(AbortSignal),
      expect.stringMatching(/^sa_00000000-0000-4000-8000-000000000042_[a-f0-9]{24}$/u)
    )
    expect(text).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('dispatches only the covered action when the root tool budget is one', async () => {
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => ({
      results: [synthesisInputFromRequest(input) === undefined
        ? {
            index: 0,
            functionCalls: [
              { id: 'first', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } },
              { id: 'second', type: 'function', function: { name: 'wiki_get_page', params: '{"id":2}' } }
            ]
          }
        : { index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    }) satisfies AxChatResponse)
    const invoke = vi.fn(async () => ({ id: 1, title: 'Alpha', content: 'Alpha' }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }

    const text = vi.fn(async () => {})
    const response = await new AxAgentEngine(factoryFor(chat), actions).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTokens: 60_000, maxTurns: 2, maxToolCalls: 1, maxOutputTokens: 10 }
      },
      { text, event: async () => {} }
    )
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('pages.get', { id: 1 }, expect.any(AbortSignal), 'first')
    expect(response.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
  })
  it('settles rejected tool-free synthesis after a read without another action or an unverified publication', async () => {
    const budget = new PublicationBudgetLedger(60_000)
    const unsupported = 'The second page confirms an unsupported conclusion.'
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => ({
      results: [
        synthesisInputFromRequest(input) === undefined
          ? { index: 0, functionCalls: [{ id: 'first-read', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }
          : { index: 0, content: synthesisFixtureAnswer(input, {
              claims: [{ evidenceId: 'page:1:revision:rev-1', statement: unsupported }]
            }) }
      ],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    }) satisfies AxChatResponse)
    const invoke = vi.fn(async () => ({
      id: 1,
      locale: 'en',
      path: 'alpha',
      title: 'Alpha',
      contentType: 'markdown',
      sourceRevision: 'rev-1',
      content: 'Alpha requires review.',
      citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        validateObservation: async () => true,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const text = vi.fn(async () => {})
    const event = vi.fn(async () => {})
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTokens: budget.maximumTokens, maxTurns: 2, maxToolCalls: 1, maxOutputTokens: 10 },
        dispatchBudget: budget
      },
      { text, event }
    )

    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('pages.get', { id: 1 }, expect.any(AbortSignal), 'first-read')
    expect(result).toMatchObject({ totalTokens: 4, costMicros: 6, executionLimit: { reason: 'evidence', publication: 'inability' } })
    expect(result.citations).toBeUndefined()
    expect(budget.tools).toBe(1)
    expect(budget.reconciled).toHaveLength(2)
    expect(budget.consumedTokens).toBe(4)
    expect(budget.consumedCostMicros).toBe(6)
    expect(budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
    expect(budget.allocatedTokens).toBe(budget.returnedTokens + budget.consumedTokens)
    expect(text.mock.calls.map(([delta]) => delta).join('')).not.toContain(unsupported)
    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_rejected', turn: 2, totalTokens: 2 })])
  })


  it('never publishes an uncited source premise smuggled through recommendations after a Wiki page was read', async () => {
    let turn = 0
    const draft = 'Alpha requires review, so publication can proceed after review.'
    const chat = vi.fn(
      async (input: Readonly<AxChatRequest<unknown>>) =>
        ({
          results: [
            ++turn === 1
              ? { index: 0, functionCalls: [{ id: 'read-alpha', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }
              : { index: 0, content: synthesisFixtureAnswer(input, {
                  claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha requires review.' }],
                  recommendations: draft
                }) }
          ]
        }) satisfies AxChatResponse
    )
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke: async () => ({
          id: 1,
          locale: 'en',
          path: 'alpha',
          title: 'Alpha',
          contentType: 'markdown',
          sourceRevision: 'rev-1',
          content: 'Alpha requires review.',
          citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
          citationSections: []
        }),
        validateObservation: async () => true,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const text = vi.fn(async () => {})
    const event = vi.fn(async () => {})
    const result = await new AxAgentEngine(factoryFor(chat), actions).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTurns: 2, maxToolCalls: 1, maxOutputTokens: 512 }
      },
      { text, event }
    )

    expect(result).toMatchObject({ executionLimit: { reason: 'evidence', publication: 'inability' } })
    expect(result.citations).toBeUndefined()
    expect(text.mock.calls.map(([delta]) => delta).join('')).toContain("I couldn't complete a source-verified answer")
    expect(text.mock.calls.map(([delta]) => delta).join('')).not.toContain('publication can proceed')
    expect(event.mock.calls).toContainEqual(['evidence.provenance', expect.objectContaining({ accepted: false })])
  })

  it('does not dispatch actions when the reserved synthesis quota is unavailable', async () => {
    const invoke = vi.fn(async () => ({ id: 1, title: 'Unverified', content: 'Must not be read' }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const reserveSequence = vi.fn(async () => {
      throw new AgentRepositoryError('AGENT_QUOTA_EXHAUSTED', 'Daily quota is exhausted', 409)
    })
    const reserve = vi.fn(async (amount: { tokens: number; costMicros: number }) => ({ id: 1, ...amount }))
    const reconcile = vi.fn(async () => {})
    const consumeTool = vi.fn(async () => {})
    const text = vi.fn(async () => {})
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      return {
        results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
      } satisfies AxChatResponse
    })
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTurns: 3, maxToolCalls: 2, maxOutputTokens: 128 },
        dispatchBudget: {
          reserveSequence,
          reserve,
          reconcile,
          release: vi.fn(async () => {}),
          consumeTool,
          unsettledExposure: { tokens: 0, costMicros: 0 }
        }
      },
      { text, event: async () => {} }
    )
    expect(reserveSequence).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledOnce()
    expect(chat.mock.calls.flatMap(([input]) => input.functions ?? []).map(fn => fn.name)).toEqual([])
    expect(reserve).toHaveBeenCalledOnce()
    expect(consumeTool).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { inputTokens: 3, outputTokens: 2, totalTokens: 5, costMicros: 7 })
    expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
    expect(result.citations).toBeUndefined()
  })

  it('does not dispatch actions from the final available model turn', async () => {
    const chat = vi.fn(
      async (input: Readonly<AxChatRequest<unknown>>) => {
        expect(synthesisInputFromRequest(input)).toBeDefined()
        return {
          results: [{
            index: 0,
            functionCalls: [{ id: 'too-late', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }]
          }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        } satisfies AxChatResponse
      }
    )
    const invoke = vi.fn(async () => ({ id: 1, title: 'Alpha', content: 'Alpha' }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const reserve = vi.fn(async (maximum: { tokens: number; costMicros: number }) => ({ id: 1, ...maximum }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const text = vi.fn(async () => {})

    await expect(
      Promise.resolve(
        new AxAgentEngine(factoryFor(chat), actions).execute(
          {
            ...baseRequest(new AbortController().signal),
            limits: { maxTokens: 60_000, maxTurns: 1, maxToolCalls: 1, maxOutputTokens: 10 },
            dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
          },
          { text, event: async () => {} }
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(invoke).not.toHaveBeenCalled()
    expect(chat.mock.calls.flatMap(([input]) => input.functions ?? []).map(fn => fn.name)).toEqual([])
    expect(reserve).toHaveBeenCalledOnce()
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
  })

  it('rejects root synthesis until every completed task has cited coverage', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1:revision:rev-1]]' }] },
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1:revision:rev-1]] Beta requires audit. [[cite:page:2:revision:rev-2]]' }] }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      if (offersCollectionFinish(input)) return finishCollectionResponse
      return responses.shift()!
    })
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      research: {
        packets: [
          {
            task: {
              id: '00000000-0000-4000-8000-000000000021',
              kind: 'source_scout',
              title: 'Review alpha',
              question: 'Alpha?',
              sourceScope: ['alpha'],
              requiredEvidenceCount: 1
            },
            packet: {
              taskId: '00000000-0000-4000-8000-000000000021',
              outcome: 'completed',
              claims: [],
              conflicts: [],
              unanswered: [],
              recommendedFollowups: []
            },
            evidenceIds: ['page:1:revision:rev-1'],
            conflictEvidenceGroups: []
          },
          {
            task: {
              id: '00000000-0000-4000-8000-000000000022',
              kind: 'source_scout',
              title: 'Review beta',
              question: 'Beta?',
              sourceScope: ['beta'],
              requiredEvidenceCount: 1
            },
            packet: {
              taskId: '00000000-0000-4000-8000-000000000022',
              outcome: 'completed',
              claims: [],
              conflicts: [],
              unanswered: [],
              recommendedFollowups: []
            },
            evidenceIds: ['page:2:revision:rev-2'],
            conflictEvidenceGroups: []
          }
        ],
        incompleteTasks: [],
        evidenceSeeds: [
          {
            taskId: '00000000-0000-4000-8000-000000000021',
            subagentRunId: '00000000-0000-4000-8000-000000000031',
            actionCallId: 'alpha-read',
            actionName: 'pages.get',
            output: {
              id: 1,
              locale: 'en',
              path: 'alpha',
              title: 'Alpha',
              contentType: 'markdown',
              sourceRevision: 'rev-1',
              content: 'Alpha requires review.',
              citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
              citationSections: []
            }
          },
          {
            taskId: '00000000-0000-4000-8000-000000000022',
            subagentRunId: '00000000-0000-4000-8000-000000000032',
            actionCallId: 'beta-read',
            actionName: 'pages.get',
            output: {
              id: 2,
              locale: 'en',
              path: 'beta',
              title: 'Beta',
              contentType: 'markdown',
              sourceRevision: 'rev-2',
              content: 'Beta requires audit.',
              citation: { evidenceId: 'page:2:revision:rev-2', label: 'Beta', href: '/en/beta' },
              citationSections: []
            }
          }
        ]
      }
    }
    const text = vi.fn(async () => {})
    const validateObservation = vi.fn(async () => true)

    await new AxAgentEngine(factoryFor(chat), pageEvidenceActions(validateObservation)).execute(request, { text, event })

    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })])
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toEqual([
      expect.objectContaining({ accepted: false, issues: expect.arrayContaining([expect.stringContaining('Review beta')]) }),
      expect.objectContaining({ accepted: true, finalCitationIds: ['page:1:revision:rev-1', 'page:2:revision:rev-2'] })
    ])
    expect(text.mock.calls.map(([delta]) => delta).join('')).toContain('Alpha requires review. [[cite:page:1:revision:rev-1]]')
    expect(text.mock.calls.map(([delta]) => delta).join('')).toContain('Beta requires audit. [[cite:page:2:revision:rev-2]]')
  })

  it('discloses an unresolved comparison side when the first and only turn publishes sourced partial findings', async () => {
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => ({
      results: [{ index: 0, content: synthesisFixtureAnswer(input, {
        claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha requires review.' }],
        unresolvedFacets: [0]
      }) }]
    }) satisfies AxChatResponse)
    const text = vi.fn(async () => {})
    const result = await new AxAgentEngine(factoryFor(chat), pageEvidenceActions(async () => true)).execute(
      {
        ...baseRequest(new AbortController().signal),
        messages: [{ role: 'user', content: 'Compare the publication requirements of Alpha and Beta.' }],
        limits: { maxTurns: 1, maxToolCalls: 1, maxOutputTokens: 512 },
        research: {
          packets: [],
          incompleteTasks: [],
          evidenceSeeds: [{
            taskId: '00000000-0000-4000-8000-000000000021',
            subagentRunId: '00000000-0000-4000-8000-000000000031',
            actionCallId: 'alpha-read',
            actionName: 'pages.get',
            output: {
              id: 1,
              locale: 'en',
              path: 'alpha',
              title: 'Alpha',
              contentType: 'markdown',
              sourceRevision: 'rev-1',
              content: 'Alpha requires review.',
              citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
              citationSections: []
            }
          }]
        }
      },
      { text, event: async () => {} }
    )

    const published = text.mock.calls.map(([delta]) => delta).join('')
    expect(published).toContain('Alpha requires review. [[cite:page:1:revision:rev-1]]')
    expect(result.citations).toEqual([expect.objectContaining({ evidenceId: 'page:1:revision:rev-1' })])
    expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'partial' })
    const disclosure = published.slice(published.indexOf('[[cite:page:1:revision:rev-1]]') + '[[cite:page:1:revision:rev-1]]'.length)
    expect(disclosure).toMatch(/Beta/iu)
    expect(disclosure).toMatch(/not established|unverified|unresolved|not verified|not supported/iu)
    expect(published).not.toContain('Beta requires audit.')
  })

  it.each([
    ['parent identity', '- Name: Maya Quinn{{padding}}\n  - Phone: 555-0100 x42', 'Name: Maya Quinn; Phone: 555-0100 x42'],
    [
      'required condition',
      '- Only after audit before 2026-10-15{{padding}}:\n  - Maya Quinn may approve release.',
      'Maya Quinn may approve release only after audit before 2026-10-15.'
    ],
    [
      'sibling field',
      '- Name: Maya Quinn\n  - Email: [maya@example.test](mailto:maya@example.test){{padding}}\n  - Phone: 555-0100 x42',
      'Name: Maya Quinn; Email: [maya@example.test](mailto:maya@example.test); Phone: 555-0100 x42'
    ],
    ['table header', 'Name{{padding}} | Phone\n--- | ---\nMaya Quinn | 555-0100 x42', 'Name: Maya Quinn; Phone: 555-0100 x42'],
    [
      'reference definition',
      '[maya]: mailto:maya@example.test "{{title}}"\n\n- Name: Maya Quinn\n  - Email: [maya@example.test][maya]',
      'Name: Maya Quinn; Email: [maya@example.test](mailto:maya@example.test)'
    ]
  ] as const)('adaptable child transfer requires a resident complete %s dependency', async (_dependency, template, fact) => {
    const citation = 'page:1:revision:rev-1'
    const answer = `${fact} [[cite:${citation}]]`
    const independentFact = 'The contact office opens at 09:00.'
    const independentAnswer = `${independentFact} [[cite:${citation}]]`
    for (const complete of [true, false]) {
      const content = `# Contacts\n\n${independentFact}\n\n${template.replace('{{padding}}', complete ? '' : ` <!--${'presentational padding '.repeat(700)}-->`).replace('{{title}}', complete ? 'Contact' : 'presentational padding '.repeat(700))}\n\n${'Neutral office background. '.repeat(900)}`
      const evidence = {
        id: 1,
        locale: 'en',
        path: 'contacts',
        title: 'Contacts',
        contentType: 'markdown',
        sourceRevision: 'rev-1',
        content,
        citation: { evidenceId: citation, label: 'Contacts', href: '/en/contacts' },
        citationSections: []
      }
      const text = vi.fn(async (_delta: string) => {})
      const event = vi.fn(async (..._args: [string, unknown]) => {})
      let turn = 0
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
        if (offersCollectionFinish(input)) return finishCollectionResponse
        const statement = ++turn === 1 ? fact : independentFact
        const sources = synthesisSourcesFromRequest(input)
        const source = sources.find(unit => unit.evidenceId === citation && (turn === 1 ? unit.packet.includes('Maya Quinn') : unit.text.includes(independentFact)))
        return {
          results: [{ index: 0, content: synthesisFixtureAnswer(input, {
            claims: [{ evidenceId: citation, sourceRevision: 'rev-1', unitId: source?.unitId ?? 'undelivered-contact-record', statement }],
            unresolvedFacets: turn > 1 ? [0] : []
          }) }]
        } satisfies AxChatResponse
      })
      const result = await new AxAgentEngine(
        factoryFor(chat),
        pageEvidenceActions(async () => true)
      ).execute(
        {
          ...baseRequest(new AbortController().signal),
          messages: [{ role: 'user', content: `Contact office lookup: what does the contact record establish about ${fact}?` }],
          limits: { maxTurns: 3, maxToolCalls: 1, maxOutputTokens: 512 },
          research: {
            packets: [],
            incompleteTasks: [],
            evidenceSeeds: [
              {
                taskId: '00000000-0000-4000-8000-000000000021',
                subagentRunId: '00000000-0000-4000-8000-000000000031',
                actionCallId: 'child-contact-read',
                actionName: 'pages.get',
                output: evidence
              }
            ]
          }
        },
        { text, event }
      )
      const published = text.mock.calls.map(([delta]) => delta).join('')
      if (complete) {
        expect(published).toBe(answer)
        expect(result.citations?.map(item => item.evidenceId)).toEqual([citation])
        expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(-1)?.[1]).toMatchObject({ accepted: true })
      } else {
        expect(published).not.toContain(`${fact} [[cite:${citation}]]`)
        expect(published).toContain(independentAnswer)
        expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'partial' })
        expect(result.citations?.map(item => item.evidenceId)).toEqual([citation])
        expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(0)?.[1]).toMatchObject({ accepted: false })
        expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(-1)?.[1]).toMatchObject({ accepted: true })
      }
    }
  })

  it('adaptable child transfer cannot summarize undelivered facts from a partial section', async () => {
    const citation = 'page:42:revision:1:section:1'
    const visibleFact = 'Maya Quinn handles northern orders.'
    const unseenFact = 'Noah Bell handles southern orders.'
    const content = `# Contacts\n\n${visibleFact}\n\n${unseenFact} ${'Operational background remains unchanged. '.repeat(900)}`
    const text = vi.fn(async (_delta: string) => {})
    const event = vi.fn(async (..._args: [string, unknown]) => {})
    let turn = 0
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      if (offersCollectionFinish(input)) return finishCollectionResponse
      const statement = ++turn === 1 ? unseenFact : visibleFact
      const source = synthesisSourcesFromRequest(input).find(unit => unit.evidenceId === citation && unit.text.includes(visibleFact))
      return {
        results: [{ index: 0, content: synthesisFixtureAnswer(input, {
          claims: [{ evidenceId: citation, sourceRevision: '1', unitId: source?.unitId ?? 'undelivered-contact-section', statement }],
          unresolvedFacets: turn > 1 ? [0] : []
        }) }]
      } satisfies AxChatResponse
    })
    const result = await new AxAgentEngine(
      factoryFor(chat),
      pageEvidenceActions(async () => true)
    ).execute(
      {
        ...baseRequest(new AbortController().signal),
        currentPage: { id: 42, locale: 'en', path: 'contacts' },
        messages: [{ role: 'user', content: 'Summarize the current page.' }],
        limits: { maxTurns: 3, maxToolCalls: 1, maxOutputTokens: 512 },
        research: {
          packets: [],
          incompleteTasks: [],
          evidenceSeeds: [
            {
              taskId: '00000000-0000-4000-8000-000000000021',
              subagentRunId: '00000000-0000-4000-8000-000000000031',
              actionCallId: 'child-partial-summary',
              actionName: 'pages.get',
              output: {
                id: 42,
                locale: 'en',
                path: 'contacts',
                title: 'Contacts',
                contentType: 'markdown',
                sourceRevision: '1',
                content,
                citation: { evidenceId: 'page:42:revision:1', label: 'Contacts', href: '/en/contacts' },
                citationSections: [{ evidenceId: citation, label: 'Contacts', href: '/en/contacts#contacts' }]
              }
            }
          ]
        }
      },
      { text, event }
    )
    const published = text.mock.calls.map(([delta]) => delta).join('')
    expect(published).not.toContain(unseenFact)
    expect(published).toContain(`${visibleFact} [[cite:${citation}]]`)
    expect(result.citations?.map(item => item.evidenceId)).toEqual([citation])
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(0)?.[1]).toMatchObject({ accepted: false })
  })
  it('does not trust child evidence seeds without a host page validator', async () => {
    const evidence = {
      id: 1,
      locale: 'en',
      path: 'alpha',
      title: 'Alpha',
      contentType: 'markdown',
      sourceRevision: 'rev-1',
      content: 'Alpha requires review.',
      citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1:revision:rev-1]]' }] }
    })
    const text = vi.fn(async () => {})
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      limits: { maxTurns: 1, maxToolCalls: 1, maxOutputTokens: 256 },
      research: {
        packets: [],
        incompleteTasks: [],
        evidenceSeeds: [
          {
            taskId: '00000000-0000-4000-8000-000000000021',
            subagentRunId: '00000000-0000-4000-8000-000000000031',
            actionCallId: 'alpha-read',
            actionName: 'pages.get',
            output: evidence
          }
        ]
      }
    }

    const response = await new AxAgentEngine(factoryFor(chat), pageEvidenceActions()).execute(request, { text, event: async () => {} })
    expect(response).toMatchObject({ executionLimit: { reason: 'evidence', publication: 'inability' } })
    expect(calls[0]?.chatPrompt.some(message => message.role === 'user' && message.content === 'Alpha requires review.')).toBe(false)
    expect(text.mock.calls.map(([delta]) => delta).join('')).not.toContain('Alpha requires review.')
  })

  it('accepts conflict-only specialist packets after two owned page reads', async () => {
    const taskId = '00000000-0000-4000-8000-000000000041'
    const subagentRunId = '00000000-0000-4000-8000-000000000042'
    const packet = JSON.stringify({
      taskId,
      outcome: 'completed',
      claims: [],
      conflicts: [
        {
          claim: 'The alpha and beta runbooks prescribe different review requirements.',
          evidenceIds: ['page:1:revision:rev-1', 'page:2:revision:rev-2'],
          explanation: 'Alpha requires review while beta requires audit.'
        }
      ],
      unanswered: [],
      recommendedFollowups: []
    })
    const responses: AxChatResponse[] = [
      {
        results: [
          {
            index: 0,
            functionCalls: [
              { id: 'alpha-call', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } },
              { id: 'beta-call', type: 'function', function: { name: 'wiki_get_page', params: '{"id":2}' } }
            ]
          }
        ]
      },
      { results: [{ index: 0, content: packet }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const invoke = vi.fn(async (_action: string, input: unknown) => {
      if (typeof input !== 'object' || input === null || !('id' in input) || typeof input.id !== 'number') throw new Error('Expected a numeric page id')
      const id = input.id
      return {
        id,
        locale: 'en',
        path: id === 1 ? 'alpha' : 'beta',
        sourceRevision: `rev-${id}`,
        title: id === 1 ? 'Alpha' : 'Beta',
        contentType: 'markdown',
        content: id === 1 ? 'Alpha requires review.' : 'Beta requires audit.',
        citation: { evidenceId: `page:${id}:revision:rev-${id}`, label: id === 1 ? 'Alpha' : 'Beta', href: `/en/${id === 1 ? 'alpha' : 'beta'}` },
        citationSections: []
      }
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: 'c'.repeat(64)
      })
    }
    const text = vi.fn(async () => {})

    await new AxAgentEngine(factoryFor(chat), actions).execute(
      {
        ...baseRequest(new AbortController().signal),
        purpose: 'subagent',
        task: {
          id: taskId,
          kind: 'conflict_check',
          title: 'Compare runbooks',
          question: 'Where do the runbooks disagree?',
          sourceScope: ['alpha', 'beta'],
          requiredEvidenceCount: 2
        },
        subagentRunId,
        actionAllowlist: ['pages.get'],
        limits: { maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 2_048 }
      },
      { text, event: async () => {} }
    )

    expect(invoke).toHaveBeenCalledTimes(2)
    const deltas = text.mock.calls.map(([delta]) => delta)
    expect(deltas.join('')).toBe(packet)
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.length).toBeLessThanOrEqual(64)
  })

  it('rejects root synthesis until validated conflicts are explicitly disclosed', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1:revision:rev-1]] Beta requires audit. [[cite:page:2:revision:rev-2]]' }] },
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1:revision:rev-1]] However, beta requires audit. [[cite:page:2:revision:rev-2]]' }] }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => offersCollectionFinish(input) ? finishCollectionResponse : responses.shift()!)
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    const taskId = '00000000-0000-4000-8000-000000000051'
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      research: {
        packets: [
          {
            task: {
              id: taskId,
              kind: 'conflict_check',
              title: 'Compare runbooks',
              question: 'Where do the runbooks disagree?',
              sourceScope: ['alpha', 'beta'],
              requiredEvidenceCount: 2
            },
            packet: {
              taskId,
              outcome: 'completed',
              claims: [],
              conflicts: [
                {
                  claim: 'The runbooks prescribe different review requirements.',
                  evidenceIds: ['page:1:revision:rev-1', 'page:2:revision:rev-2'],
                  explanation: 'Alpha requires review while beta requires audit.'
                }
              ],
              unanswered: [],
              recommendedFollowups: []
            },
            evidenceIds: ['page:1:revision:rev-1', 'page:2:revision:rev-2'],
            conflictEvidenceGroups: [['page:1:revision:rev-1', 'page:2:revision:rev-2']]
          }
        ],
        incompleteTasks: [],
        evidenceSeeds: [
          {
            taskId,
            subagentRunId: '00000000-0000-4000-8000-000000000052',
            actionCallId: 'alpha-read',
            actionName: 'pages.get',
            output: {
              id: 1,
              locale: 'en',
              path: 'alpha',
              title: 'Alpha',
              contentType: 'markdown',
              sourceRevision: 'rev-1',
              content: 'Alpha requires review.',
              citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
              citationSections: []
            }
          },
          {
            taskId,
            subagentRunId: '00000000-0000-4000-8000-000000000053',
            actionCallId: 'beta-read',
            actionName: 'pages.get',
            output: {
              id: 2,
              locale: 'en',
              path: 'beta',
              title: 'Beta',
              contentType: 'markdown',
              sourceRevision: 'rev-2',
              content: 'Beta requires audit.',
              citation: { evidenceId: 'page:2:revision:rev-2', label: 'Beta', href: '/en/beta' },
              citationSections: []
            }
          }
        ]
      }
    }
    const text = vi.fn(async () => {})

    await new AxAgentEngine(
      factoryFor(chat),
      pageEvidenceActions(async () => true)
    ).execute(request, { text, event })

    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })])
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toEqual([
      expect.objectContaining({ accepted: false, issues: expect.arrayContaining([expect.stringContaining('explicitly disclosing')]) }),
      expect.objectContaining({ accepted: true, finalCitationIds: ['page:1:revision:rev-1', 'page:2:revision:rev-2'] })
    ])
    expect(text.mock.calls.map(([delta]) => delta).join('')).toContain('Alpha requires review. [[cite:page:1:revision:rev-1]]')
    expect(text.mock.calls.map(([delta]) => delta).join('')).toContain('However, beta requires audit. [[cite:page:2:revision:rev-2]]')
  })
  it('keeps a post-dispatch reservation unsettled when rejecting a post-response capability violation', async () => {
    const response = {
      results: [
        {
          index: 0,
          functionCalls: [
            { id: 'first', type: 'function' as const, function: { name: 'wiki_get_page', params: '{"id":1}' } },
            { id: 'second', type: 'function' as const, function: { name: 'wiki_get_page', params: '{"id":2}' } }
          ]
        }
      ],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 7, completionTokens: 5, totalTokens: 12 } }
    } satisfies AxChatResponse
    const chat = vi.fn(async () => response)
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: false,
          structuredOutput: 'native-json-schema',
          usage: 'terminal',
          cancellation: true,
          maxContextTokens: 100_000,
          maxOutputTokens: 4_000
        },
        transportKind: 'openai-responses',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const reservation = { id: 'reservation', tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const consumeTool = vi.fn(async () => {})
    const invoke = vi.fn(async () => ({}))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }

    await expect(
      Promise.resolve(
        new AxAgentEngine(factory, actions).execute(
          {
            ...baseRequest(new AbortController().signal),
            dispatchBudget: { reserve, reconcile, release, consumeTool, unsettledExposure: { tokens: 0, costMicros: 0 } }
          },
          { text: async () => {}, event: async () => {} }
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })

    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })
  it('keeps a post-dispatch reservation unsettled when rejecting an invalid response', async () => {
    const response = {
      results: [{ index: 0, content: '<wiki-tool-call>not-json</wiki-tool-call>' }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 7, completionTokens: 5, totalTokens: 12 } }
    } satisfies AxChatResponse
    const chat = vi.fn(async () => response)
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'prompt',
          parallelToolCalls: false,
          structuredOutput: 'native-json-schema',
          usage: 'terminal',
          cancellation: true,
          maxContextTokens: 100_000,
          maxOutputTokens: 4_000
        },
        transportKind: 'openai-chat',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const reservation = { id: 'reservation', tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {
      throw new Error('accounting unavailable')
    })
    const release = vi.fn(async () => {})
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke: vi.fn(async () => ({})),
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }

    const error = await new AxAgentEngine(factory, actions)
      .execute(
        {
          ...baseRequest(new AbortController().signal),
          dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
        },
        { text: async () => {}, event: async () => {} }
      )
      .catch(value => value)

    expect(error).toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('preserves an active dispatch reservation when usage reconciliation fails', async () => {
    const response = {
      results: [{ index: 0, content: 'Bounded answer.' }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 7, completionTokens: 5, totalTokens: 12 } }
    } satisfies AxChatResponse
    const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {
      throw new Error('accounting unavailable')
    })
    const release = vi.fn(async () => {})
    const consumeTool = vi.fn(async () => {})

    await expect(
      Promise.resolve(
        new AxAgentEngine(factoryFor(vi.fn(async () => response))).execute(
          {
            ...baseRequest(new AbortController().signal),
            dispatchBudget: { reserve, reconcile, release, consumeTool, unsettledExposure: { tokens: 0, costMicros: 0 } }
          },
          { text: async () => {}, event: async () => {} }
        )
      )
    ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED', stage: 'usage_reconciliation', message: 'Agent inference failed' })

    expect(reconcile).toHaveBeenCalledWith(reservation, { inputTokens: 7, outputTokens: 5, totalTokens: 12, costMicros: 17 })
    expect(release).not.toHaveBeenCalled()
  })
  it('uses the admitted request and configured output exposure for estimated usage when the provider omits usage', async () => {
    const chat = vi.fn(async () => ({ results: [{ index: 0, content: 'Estimated answer.' }] }) satisfies AxChatResponse)
    const reserve = vi.fn(async (maximum: { readonly tokens: number; readonly costMicros: number }) => ({ id: 1, ...maximum }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const dispatchBudget = { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'estimated' })).execute(
      { ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget },
      { text: async () => {}, event: async () => {} }
    )
    const admitted = reserve.mock.calls[0]?.[0]
    expect(admitted).toBeDefined()
    const expectedAdmissionCost = admitted!.tokens * 2
    expect(admitted!.costMicros).toBe(expectedAdmissionCost)
    expect(result).toMatchObject({
      inputTokens: admitted!.tokens - 4_000,
      outputTokens: 4_000,
      totalTokens: admitted!.tokens,
      costMicros: expectedAdmissionCost
    })
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ tokens: admitted!.tokens, costMicros: expectedAdmissionCost }), {
      inputTokens: admitted!.tokens - 4_000,
      outputTokens: 4_000,
      totalTokens: admitted!.tokens,
      costMicros: expectedAdmissionCost
    })
    expect(release).not.toHaveBeenCalled()
  })
  it('prices a reported directional receipt below the conservative estimated exposure', async () => {
    const response = {
      results: [{ index: 0, content: 'Measured answer.' }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1_326, completionTokens: 4_000, totalTokens: 5_326 } }
    } satisfies AxChatResponse
    const chat = vi.fn(async () => response)
    const reserve = vi.fn(async (maximum: { readonly tokens: number; readonly costMicros: number }) => ({ id: 1, ...maximum }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const dispatchBudget = { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' })).execute(
      { ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget },
      { text: async () => {}, event: async () => {} }
    )
    const admitted = await reserve.mock.results[0]!.value
    expect(admitted).toBeDefined()
    expect(admitted.costMicros).toBeGreaterThanOrEqual(9_326)
    expect(admitted.costMicros).toBe(admitted.tokens * 2)
    expect(result).toMatchObject({ inputTokens: 1_326, outputTokens: 4_000, totalTokens: 5_326, costMicros: 9_326 })
    expect(reconcile).toHaveBeenCalledWith(admitted, {
      inputTokens: 1_326,
      outputTokens: 4_000,
      totalTokens: 5_326,
      costMicros: 9_326
    })
    expect(admitted.costMicros).toBeGreaterThan(result.costMicros)
    expect(release).not.toHaveBeenCalled()
  })

  it('rejects terminal, mismatched, and malformed provider usage without releasing a post-dispatch reservation', async () => {
    const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
    const runCase = async (
      response: AxChatResponse | ReadableStream<AxChatResponse>,
      options: { readonly streaming?: boolean; readonly usage?: 'stream' | 'terminal' | 'estimated' }
    ) => {
      const reserve = vi.fn(async () => reservation)
      const reconcile = vi.fn(async () => {})
      const release = vi.fn(async () => {})
      const dispatchBudget = { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      await expect(
        new AxAgentEngine(
          factoryFor(
            vi.fn(async () => response),
            options
          )
        ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget }, { text: async () => {}, event: async () => {} })
      ).rejects.toMatchObject({ code: 'PROVIDER_USAGE_INVALID' })
      return { release, reconcile }
    }

    const missing = await runCase({ results: [{ index: 0, content: 'missing' }] }, { usage: 'terminal' })
    const unsafe = await runCase(
      {
        results: [{ index: 0, content: 'unsafe' }],
        modelUsage: {
          ai: 'test',
          model: 'gpt-test',
          tokens: { promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER }
        }
      },
      { usage: 'terminal' }
    )
    expect(unsafe.reconcile).not.toHaveBeenCalled()
    expect(unsafe.release).not.toHaveBeenCalled()
    const underrun = await runCase(
      {
        results: [{ index: 0, content: 'underrun' }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 3, totalTokens: 4 } }
      },
      { usage: 'terminal' }
    )
    expect(underrun.reconcile).not.toHaveBeenCalled()
    expect(underrun.release).not.toHaveBeenCalled()
    expect(missing.reconcile).not.toHaveBeenCalled()
    expect(missing.release).not.toHaveBeenCalled()
    const malformedStream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'malformed' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: Number.NaN, completionTokens: 2, totalTokens: 2 } }
        } as unknown as AxChatResponse)
        controller.close()
      }
    })
    const malformed = await runCase(malformedStream, { streaming: true, usage: 'stream' })
    expect(malformed.reconcile).not.toHaveBeenCalled()
    expect(malformed.release).not.toHaveBeenCalled()
  })
  it('reconciles exactly additive provider usage once', async () => {
    const response = {
      results: [{ index: 0, content: 'Exactly accounted answer.' }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }
    } satisfies AxChatResponse
    const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const chat = vi.fn(async () => response)
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' })).execute(
      {
        ...baseRequest(new AbortController().signal),
        purpose: 'planner',
        dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      },
      { text: async () => {}, event: async () => {} }
    )

    expect(result).toMatchObject({ inputTokens: 2, outputTokens: 3, totalTokens: 5, costMicros: 8 })
    expect(reconcile).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledWith(reservation, { inputTokens: 2, outputTokens: 3, totalTokens: 5, costMicros: 8 })
    expect(release).not.toHaveBeenCalled()
  })

  it('cancels an internally inconsistent stream before releasing its reader and leaves exposure unsettled', async () => {
    const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    let cancelCalls = 0
    let resolveCancelStarted!: () => void
    let resolveCancel!: () => void
    const cancelStarted = new Promise<void>(resolve => {
      resolveCancelStarted = resolve
    })
    let cancelReason: unknown
    const stream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'partial' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }
        })
        controller.enqueue({
          results: [{ index: 0, content: 'remainder' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 3, totalTokens: 4 } }
        })
      },
      cancel(reason) {
        cancelCalls += 1
        cancelReason = reason
        resolveCancelStarted()
        return new Promise<void>(resolve => {
          resolveCancel = resolve
        })
      }
    })
    const chat = vi.fn(async () => stream)
    const text = vi.fn(async () => {})
    const execution = new AxAgentEngine(factoryFor(chat, { streaming: true, usage: 'stream' })).execute(
      {
        ...baseRequest(new AbortController().signal),
        purpose: 'planner',
        dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      },
      { text, event: async () => {} }
    )
    let settled = false
    const observed = execution.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await cancelStarted
    expect(settled).toBe(false)
    expect(stream.locked).toBe(true)
    expect(cancelReason).toBe('provider stream failed')
    expect(cancelCalls).toBe(1)
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()

    resolveCancel()
    await expect(execution).rejects.toMatchObject({ code: 'PROVIDER_USAGE_INVALID', stage: 'provider_response' })
    await observed
    expect(stream.locked).toBe(false)
    expect(text).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledOnce()
  })

  it('retains exposure for lost responses, interrupted streams, and reconciliation failures', async () => {
    const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
    const runCase = async (chat: AgentProviderService['service']['chat'], factory: AgentProviderFactory = factoryFor(chat)) => {
      const reserve = vi.fn(async () => reservation)
      const reconcile = vi.fn(async () => {
        throw new Error('accounting unavailable')
      })
      const release = vi.fn(async () => {})
      const dispatchBudget = { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      const text = vi.fn(async (_delta: string) => {})
      const event = vi.fn(async (_type: string, _data: unknown) => {})
      let failure: unknown
      await expect(
        new AxAgentEngine(factory)
          .execute({ ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget }, { text, event })
          .catch(error => {
            failure = error
            throw error
          })
      ).rejects.toMatchObject({ message: 'Agent inference failed' })
      return { release, reconcile, text, event, failure }
    }

    const lost = await runCase(
      vi.fn(async () => {
        throw new Error('lost response')
      })
    )
    expect(lost.reconcile).not.toHaveBeenCalled()
    expect(lost.release).not.toHaveBeenCalled()

    let pulls = 0
    const stream = new ReadableStream<AxChatResponse>(
      {
        pull(controller) {
          pulls += 1
          if (pulls === 1) {
            controller.enqueue({
              results: [{ index: 0, content: 'partial' }],
              modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
            })
          } else controller.error(new Error('stream lost'))
        }
      },
      { highWaterMark: 0 }
    )
    const interrupted = await runCase(
      vi.fn(async () => stream),
      factoryFor(
        vi.fn(async () => stream),
        { streaming: true, usage: 'stream' }
      )
    )
    expect(interrupted.reconcile).not.toHaveBeenCalled()
    expect(interrupted.release).not.toHaveBeenCalled()
    expect(pulls).toBe(2)
    expect(interrupted.failure).toMatchObject({ stage: 'provider_stream' })
    expect(interrupted.text).not.toHaveBeenCalled()
    expect(interrupted.event).not.toHaveBeenCalled()

    const rejected = await runCase(
      vi.fn(async () => ({
        results: [{ index: 0, content: 'answer' }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
      }))
    )
    expect(rejected.reconcile).toHaveBeenCalledOnce()
    expect(rejected.release).not.toHaveBeenCalled()
  })

  it('rejects an under-covered dispatch before calling the provider and releases only that pre-dispatch reservation', async () => {
    const chat = vi.fn(async () => ({ results: [{ index: 0, content: 'unused' }] }) satisfies AxChatResponse)
    const reserve = vi.fn(async () => ({ id: 1, tokens: 0, costMicros: 0 }))
    const release = vi.fn(async () => {})
    const dispatchBudget = {
      reserve,
      reconcile: vi.fn(async () => {}),
      release,
      consumeTool: vi.fn(async () => {}),
      unsettledExposure: { tokens: 0, costMicros: 0 }
    }
    await expect(
      new AxAgentEngine(factoryFor(chat)).execute(
        { ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget },
        { text: async () => {}, event: async () => {} }
      )
    ).rejects.toMatchObject({ stage: 'dispatch_admission' })
    expect(chat).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })
  it('accepts an exact multibyte content aggregate and rejects only its next byte', async () => {
    const content = `${'€'.repeat(43_690)}ab`
    expect(Buffer.byteLength(content, 'utf8')).toBe(131_072)
    const chunks = utf8Chunks(content, 32_768)
    expect(chunks.map(chunk => Buffer.byteLength(chunk, 'utf8'))).toEqual([32_766, 32_766, 32_766, 32_766, 8])
    expect(chunks.join('')).toBe(content)
    expect(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= 32_768)).toBe(true)
    const usage = { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    const exactResponses = chunks.map(chunk => ({ results: [{ index: 0, content: chunk }], modelUsage: usage }) satisfies AxChatResponse)
    const exactText = vi.fn(async () => {})
    const exact = await new AxAgentEngine(
      factoryFor(async () => responseStream(exactResponses), { streaming: true, usage: 'stream', maxOutputTokens: 4_096 })
    ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: exactText, event: async () => {} })
    expect(exact).toMatchObject({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    expect(exactText.mock.calls.map(([value]) => value).join('')).toBe(content)

    let signal: AbortSignal | undefined
    let cancelCalls = 0
    const overflowStream = responseStream([...exactResponses, { results: [{ index: 0, content: 'x' }], modelUsage: usage } satisfies AxChatResponse], () => {
      cancelCalls += 1
      return Promise.reject(new Error('hostile stream cancellation'))
    })
    const chat: AgentProviderService['service']['chat'] = vi.fn(async (_request, options) => {
      signal = options?.abortSignal
      return overflowStream
    })
    const reserve = vi.fn(async () => ({ id: 1, tokens: 200_000, costMicros: 200_000 }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const event = vi.fn(async () => {})
    const text = vi.fn(async () => {})
    await expect(
      new AxAgentEngine(factoryFor(chat, { streaming: true, usage: 'stream', maxOutputTokens: 4_096 })).execute(
        {
          ...baseRequest(new AbortController().signal),
          purpose: 'planner',
          dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
        },
        { text, event }
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(signal?.aborted).toBe(true)
    expect(cancelCalls).toBe(1)
    expect(text).not.toHaveBeenCalled()
    expect(event).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('retains bounded bytes when repeated argument fragments replace prior values', async () => {
    const argumentLarge = { value: 'x'.repeat(10_000) }
    const argumentSmall = { value: 'ok' }
    const collectionResponse: AxChatResponse = {
      results: [
        {
          index: 0,
          functionCalls: [
            { id: 'replace', type: 'function', function: { name: 'wiki_get_page', params: argumentLarge } },
            { id: 'replace', type: 'function', function: { name: 'wiki_get_page', params: argumentSmall } }
          ]
        }
      ],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    }
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) =>
      synthesisInputFromRequest(input) === undefined
        ? collectionResponse
        : {
            results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
            modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
          } satisfies AxChatResponse
    )
    const invoke = vi.fn(async (_name: string, _input: unknown) => ({}))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const event = vi.fn(async () => {})
    const result = await new AxAgentEngine(
      factoryFor(chat, { usage: 'terminal' }),
      actions
    ).execute({ ...baseRequest(new AbortController().signal), purpose: 'root', limits: { maxTurns: 2, maxToolCalls: 1 } }, { text: async () => {}, event })
    expect(result).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5, executionLimit: { reason: 'evidence', publication: 'inability' } })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('pages.get', argumentSmall, expect.any(AbortSignal), 'replace')
    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted', totalTokens: 3 })])
  })
  it('accepts an exact UTF-8 aggregate argument and rejects its next byte before tool execution', async () => {
    const argumentValue = `${'€'.repeat(21_842)}ab`
    const argument = `{"x":"${argumentValue}"}`
    expect(Buffer.byteLength(argument, 'utf8')).toBe(65_536)
    const chunks = utf8Chunks(argument, 32_768)
    expect(chunks.map(chunk => Buffer.byteLength(chunk, 'utf8'))).toEqual([32_766, 32_768, 2])
    expect(chunks.join('')).toBe(argument)
    expect(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= 32_768)).toBe(true)
    const usage = { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    const invoke = vi.fn(async (_name: string, _input: unknown) => ({}))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const firstStreamResponses: AxChatResponse[] = chunks.map(chunk => ({
      results: [{ index: 0, functionCalls: [{ id: 'exact-argument', type: 'function', function: { name: 'wiki_get_page', params: chunk } }] }],
      modelUsage: usage
    }))
    const exactChat: AgentProviderService['service']['chat'] = vi.fn(async input =>
      synthesisInputFromRequest(input) === undefined
        ? responseStream(firstStreamResponses)
        : {
            results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
            modelUsage: { ...usage, tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
          } satisfies AxChatResponse
    )
    const exactEvent = vi.fn(async () => {})
    const exact = await new AxAgentEngine(
      factoryFor(exactChat, {
        streaming: true,
        usage: 'stream',
        maxOutputTokens: 4_096
      }),
      actions
    ).execute({ ...baseRequest(new AbortController().signal), purpose: 'root', limits: { maxTurns: 2, maxToolCalls: 1 } }, { text: async () => {}, event: exactEvent })
    expect(exact).toMatchObject({ totalTokens: 5, executionLimit: { reason: 'evidence', publication: 'inability' } })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('pages.get', { x: argumentValue }, expect.any(AbortSignal), 'exact-argument')
    expect(exactEvent.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted', totalTokens: 3 })])

    const overflowResponses = chunks.map(chunk => ({
      results: [{ index: 0, functionCalls: [{ id: 'overflow-argument', type: 'function', function: { name: 'wiki_get_page', params: chunk } }] }],
      modelUsage: usage
    }))
    overflowResponses.push({
      results: [{ index: 0, functionCalls: [{ id: 'overflow-argument', type: 'function', function: { name: 'wiki_get_page', params: 'x' } }] }],
      modelUsage: usage
    })
    let cancelCalls = 0
    const overflowStream = responseStream(overflowResponses, () => (cancelCalls += 1))
    const overflowInvoke = vi.fn(async () => ({}))
    const overflowActions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
        invoke: overflowInvoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const overflowText = vi.fn(async () => {})
    const overflowEvent = vi.fn(async () => {})
    await expect(
      new AxAgentEngine(
        factoryFor(async () => overflowStream, { streaming: true, usage: 'stream', maxOutputTokens: 4_096 }),
        overflowActions
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'root' }, { text: overflowText, event: overflowEvent })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(cancelCalls).toBe(1)
    expect(overflowInvoke).not.toHaveBeenCalled()
    expect(overflowText).not.toHaveBeenCalled()
    expect(overflowEvent).not.toHaveBeenCalled()
  })
  it('accepts exact UTF-8 call IDs and call counts but rejects the next unit', async () => {
    const usage = { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    const exactId = `${'€'.repeat(85)}a`
    expect(Buffer.byteLength(exactId, 'utf8')).toBe(256)
    type FunctionCalls = NonNullable<AxChatResponse['results'][number]['functionCalls']>
    const run = async (functionCalls: FunctionCalls) => {
      const response = { results: [{ index: 0, functionCalls }], modelUsage: usage } as unknown as AxChatResponse
      return new AxAgentEngine(factoryFor(async () => response, { maxOutputTokens: 4_096 })).execute(
        { ...baseRequest(new AbortController().signal), purpose: 'planner' },
        { text: vi.fn(async () => {}), event: vi.fn(async () => {}) }
      )
    }
    await expect(run([{ id: exactId, type: 'function', function: { name: 'wiki_get_page', params: '' } }])).rejects.toMatchObject({
      code: 'UNEXPECTED_PROVIDER_TOOL_CALL'
    })
    await expect(run([{ id: `${exactId}x`, type: 'function', function: { name: 'wiki_get_page', params: '' } }])).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      stage: 'provider_response'
    })
    const exactCalls = Array.from({ length: 32 }, (_, index) => ({
      id: `call-${index}`,
      type: 'function' as const,
      function: { name: 'wiki_get_page', params: '' }
    }))
    await expect(run(exactCalls)).rejects.toMatchObject({ code: 'UNEXPECTED_PROVIDER_TOOL_CALL' })
    await expect(run([...exactCalls, { id: 'call-32', type: 'function' as const, function: { name: 'wiki_get_page', params: '' } }])).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      stage: 'provider_response'
    })
  })

  it('rejects exact next-byte, depth, value, and size breaches before action or sink work', async () => {
    const runInvalid = async (params: object, expectedCode = 'INVALID_PROVIDER_RESPONSE') => {
      const invoke = vi.fn(async () => ({}))
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
          invoke,
          snapshot: async () => ({}),
          close: vi.fn(),
          authoritySha256: null
        })
      }
      const response = {
        results: [{ index: 0, functionCalls: [{ id: 'bounded', type: 'function' as const, function: { name: 'wiki_get_page', params } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
      } satisfies AxChatResponse
      const text = vi.fn(async () => {})
      const event = vi.fn(async () => {})
      const reserve = vi.fn(async () => ({ id: 1, tokens: 200_000, costMicros: 200_000 }))
      const reconcile = vi.fn(async () => {})
      const release = vi.fn(async () => {})
      await expect(
        new AxAgentEngine(
          factoryFor(async () => response, { maxOutputTokens: 4_096 }),
          actions
        ).execute(
          {
            ...baseRequest(new AbortController().signal),
            dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
          },
          { text, event }
        )
      ).rejects.toMatchObject({ code: expectedCode, stage: 'provider_response' })
      expect(invoke).not.toHaveBeenCalled()
      expect(text).not.toHaveBeenCalled()
      expect(event).not.toHaveBeenCalled()
      expect(reconcile).not.toHaveBeenCalled()
      expect(release).not.toHaveBeenCalled()
    }

    const nested = (depth: number): Record<string, unknown> => {
      let value: Record<string, unknown> = { leaf: true }
      for (let index = 0; index < depth; index += 1) value = { next: value }
      return value
    }
    await runInvalid(nested(64))
    await runInvalid(Array.from({ length: 16_384 }, () => ''))
    await runInvalid({ value: 'x'.repeat(65_525) })
    await runInvalid({ value: '"'.repeat(32_762) + 'x' })
  })

  it('keeps exact structured depth/value/size boundaries admissible', async () => {
    const nested = (depth: number): Record<string, unknown> => {
      let value: Record<string, unknown> = { leaf: true }
      for (let index = 0; index < depth; index += 1) value = { next: value }
      return value
    }
    const cases: readonly object[] = [nested(63), Array.from({ length: 16_383 }, () => ''), { value: 'x'.repeat(65_524) }, { value: '"'.repeat(32_762) }]
    for (const params of cases) {
      const collectionResponse: AxChatResponse = {
        results: [{ index: 0, functionCalls: [{ id: 'exact', type: 'function', function: { name: 'wiki_get_page', params } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
      }
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) =>
        synthesisInputFromRequest(input) === undefined
          ? collectionResponse
          : {
              results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
              modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
            } satisfies AxChatResponse
      )
      const invoke = vi.fn(async () => ({}))
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
          invoke,
          snapshot: async () => ({}),
          close: vi.fn(),
          authoritySha256: null
        })
      }
      const event = vi.fn(async () => {})
      const result = await new AxAgentEngine(
        factoryFor(chat, { usage: 'terminal' }),
        actions
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'root', limits: { maxTurns: 2, maxToolCalls: 1 } }, { text: async () => {}, event })
      expect(result).toMatchObject({ totalTokens: 5, executionLimit: { reason: 'evidence', publication: 'inability' } })
      expect(invoke).toHaveBeenCalledOnce()
      expect(invoke).toHaveBeenCalledWith('pages.get', params, expect.any(AbortSignal), 'exact')
      expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted', totalTokens: 3 })])
    }
  })
})

describe('provider fragment boundaries', () => {
  it('enforces response, result, argument, and thought fragment counts at their exact next item', async () => {
    const usage = { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    const lazyStream = (count: number, make: (index: number) => AxChatResponse, onCancel?: () => void): ReadableStream<AxChatResponse> => {
      let index = 0
      return new ReadableStream<AxChatResponse>(
        {
          pull(controller) {
            if (index >= count) {
              controller.close()
              return
            }
            controller.enqueue(make(index))
            index += 1
          },
          cancel() {
            onCancel?.()
          }
        },
        { highWaterMark: 0 }
      )
    }
    const executeStream = async (
      stream: ReadableStream<AxChatResponse>,
      options: { readonly preserveThoughtBlock?: AgentProviderService['preserveThoughtBlock']; readonly maxOutputTokens?: number } = {}
    ) =>
      new AxAgentEngine(
        factoryFor(async () => stream, { streaming: true, usage: 'stream', maxOutputTokens: options.maxOutputTokens ?? 4_096, ...options })
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: vi.fn(async () => {}), event: vi.fn(async () => {}) })

    const exactResponses = lazyStream(65_536, () => ({ results: [], modelUsage: usage }) satisfies AxChatResponse)
    await executeStream(exactResponses)
    let responseCancelCalls = 0
    await expect(
      executeStream(
        lazyStream(
          65_537,
          () => ({ results: [], modelUsage: usage }) satisfies AxChatResponse,
          () => (responseCancelCalls += 1)
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(responseCancelCalls).toBe(1)

    const exactRecords = Array.from({ length: 65_536 }, () => ({ index: 0 }))
    await executeStream(
      responseStream([
        { results: exactRecords, modelUsage: usage },
        { results: [], modelUsage: usage }
      ] satisfies AxChatResponse[])
    )
    let resultCancelCalls = 0
    await expect(
      executeStream(
        responseStream(
          [
            { results: exactRecords, modelUsage: usage },
            { results: [{ index: 0 }], modelUsage: usage }
          ] satisfies AxChatResponse[],
          () => (resultCancelCalls += 1)
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(resultCancelCalls).toBe(1)
    const exactArguments = Array.from({ length: 65_536 }, () => ({
      id: 'argument',
      type: 'function' as const,
      function: { name: 'wiki_get_page', params: '' }
    }))

    let argumentCancelCalls = 0
    await expect(executeStream(responseStream([{ results: [{ index: 0, functionCalls: exactArguments }], modelUsage: usage }]))).rejects.toMatchObject({
      code: 'UNEXPECTED_PROVIDER_TOOL_CALL'
    })
    await expect(
      executeStream(
        responseStream(
          [
            {
              results: [
                {
                  index: 0,
                  functionCalls: [...exactArguments, { id: 'argument-next', type: 'function' as const, function: { name: 'wiki_get_page', params: '' } }]
                }
              ],
              modelUsage: usage
            }
          ],
          () => (argumentCancelCalls += 1)
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(argumentCancelCalls).toBe(1)

    const thought = { data: 'x', encrypted: true } as const
    await executeStream(
      responseStream([{ results: [{ id: 'thought', index: 0, thoughtBlocks: Array.from({ length: 65_536 }, () => thought) }], modelUsage: usage }]),
      { preserveThoughtBlock: (_resultId, block) => block, maxOutputTokens: 16_384 }
    )
    let thoughtCancelCalls = 0
    await expect(
      executeStream(
        responseStream(
          [
            {
              results: [{ id: 'thought', index: 0, thoughtBlocks: Array.from({ length: 65_537 }, () => thought) }],
              modelUsage: usage
            }
          ],
          () => (thoughtCancelCalls += 1)
        ),
        { preserveThoughtBlock: (_resultId, block) => block, maxOutputTokens: 16_384 }
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(thoughtCancelCalls).toBe(1)
  })
  it('enforces exact thought aggregate bytes, signatures, and capacity-sensitive replacement', async () => {
    const usage = { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    const preserveThoughtBlock: AgentProviderService['preserveThoughtBlock'] = (_resultId, block) => block
    const data = 'x'.repeat(32_700)
    const signature = 's'.repeat(36)
    const fullBlocks = Array.from({ length: 4 }, (_, index) => ({
      id: `shrink_${index}`,
      index: 0,
      thoughtBlocks: [{ data, encrypted: true, signature }]
    }))
    await new AxAgentEngine(
      factoryFor(
        async () =>
          responseStream([
            { results: fullBlocks, modelUsage: usage },
            {
              results: [{ id: 'shrink_3', index: 0, thoughtBlocks: [{ data: 'x', encrypted: true, signature: 'small' }] }],
              modelUsage: usage
            },
            {
              results: [{ id: 'shrink_new', index: 0, thoughtBlocks: [{ data: 'x'.repeat(32_662), encrypted: true, signature }] }],
              modelUsage: usage
            }
          ]),
        { streaming: true, usage: 'stream', maxOutputTokens: 4_096, preserveThoughtBlock }
      )
    ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: async () => {}, event: async () => {} })

    const growthBlocks = Array.from({ length: 4 }, (_, index) => ({
      id: `growth_${index}`,
      index: 0,
      thoughtBlocks: [{ data, encrypted: true, signature }]
    }))
    let growthCancelCalls = 0
    await expect(
      new AxAgentEngine(
        factoryFor(
          async () =>
            responseStream(
              [
                { results: growthBlocks, modelUsage: usage },
                {
                  results: [{ id: 'growth_3', index: 0, thoughtBlocks: [{ data, encrypted: true, signature: `${signature}s` }] }],
                  modelUsage: usage
                }
              ],
              () => (growthCancelCalls += 1)
            ),
          { streaming: true, usage: 'stream', maxOutputTokens: 4_096, preserveThoughtBlock }
        )
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: async () => {}, event: async () => {} })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(growthCancelCalls).toBe(1)

    await new AxAgentEngine(
      factoryFor(
        async () =>
          responseStream([
            {
              results: [{ id: 'signature-exact', index: 0, thoughtBlocks: [{ data: 'x', encrypted: true, signature: 's'.repeat(131_039) }] }],
              modelUsage: usage
            }
          ]),
        { streaming: true, usage: 'stream', maxOutputTokens: 4_096, preserveThoughtBlock }
      )
    ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: async () => {}, event: async () => {} })

    let signatureCancelCalls = 0
    await expect(
      new AxAgentEngine(
        factoryFor(
          async () =>
            responseStream(
              [
                {
                  results: [{ id: 'signature-next', index: 0, thoughtBlocks: [{ data: 'x', encrypted: true, signature: 's'.repeat(131_040) }] }],
                  modelUsage: usage
                }
              ],
              () => (signatureCancelCalls += 1)
            ),
          { streaming: true, usage: 'stream', maxOutputTokens: 4_096, preserveThoughtBlock }
        )
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: async () => {}, event: async () => {} })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(signatureCancelCalls).toBe(1)
  })
})

describe('engine preflight', () => {
  it('rejects the frozen oversized child at execution before reserving or dispatching after preflight', async () => {
    const chat = vi.fn(async () => {
      throw new Error('preflight must not call the provider')
    })
    const invoke = vi.fn(async () => {
      throw new Error('preflight must not invoke Wiki actions')
    })
    const close = vi.fn()
    const open = vi.fn(async () => ({
      authoritySha256: null,
      functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object' }, risk: 'read' }],
      invoke,
      snapshot: async () => ({}),
      close
    }))
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      purpose: 'subagent',
      actionAllowlist: ['pages.get'],
      task: {
        id: '00000000-0000-4000-8000-000000000021',
        kind: 'source_scout',
        title: 'Review alpha',
        question: 'What does alpha require?',
        sourceScope: ['alpha'],
        requiredEvidenceCount: 1
      },
      subagentRunId: '00000000-0000-4000-8000-000000000022',
      messages: [{ role: 'user', content: 'x'.repeat(8_000) }],
      limits: { maxTokens: 6_000, maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 2_048 }
    }
    const engine = new AxAgentEngine(factoryFor(chat), { open } as unknown as AgentActionSessionProvider)

    const result = await engine.preflight(request)

    expect(result.outputExposureTokens).toBe(2_048)
    expect(result.totalExposureTokens).toBe(result.inputExposureTokens + result.outputExposureTokens)
    expect(result.totalExposureTokens).toBeGreaterThan(6_000)
    expect(result.admissible).toBe(false)
    expect(open).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    const reserve = vi.fn(async (maximum: { readonly tokens: number; readonly costMicros: number }) => ({ id: 1, ...maximum }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const consumeTool = vi.fn(async () => {})
    const text = vi.fn(async () => {})
    await expect(
      engine.execute(
        {
          ...request,
          dispatchBudget: { reserve, reconcile, release, consumeTool, unsettledExposure: { tokens: 0, costMicros: 0 } }
        },
        { text, event: async () => {} }
      )
    ).rejects.toMatchObject({ code: 'AGENT_CHILD_BUDGET_EXCEEDED' })
    expect(reserve).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(consumeTool).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe('child aggregate budget reservations', () => {
  it('admits concurrent children atomically and reconstructs retry headroom from measured usage', () => {
    const limits = {
      enabled: true,
      maxConcurrentChildren: 3,
      maxChildren: 3,
      plannerTurns: 1,
      childTurns: 2,
      childToolCalls: 2,
      plannerTimeoutMilliseconds: 1_000,
      childTimeoutMilliseconds: 1_000,
      plannerMaxOutputTokens: 2,
      childMaxOutputTokens: 4,
      maxAggregateChildTokens: 10,
      maxAggregateChildOutputCharacters: 80_000
    } as const satisfies AgentOrchestrationLimits
    const reservations = new AgentChildBudgetReservations(limits, { totalTokens: 0, outputCharacters: 0 })

    const first = reservations.reserve(3)
    const second = reservations.reserve(2)
    const third = reservations.reserve(1)

    expect(first).toEqual(expect.objectContaining({ totalTokens: 3, maxOutputTokens: 3, outputCharacters: 26_666 }))
    expect(second).toEqual(expect.objectContaining({ totalTokens: 3, maxOutputTokens: 3, outputCharacters: 26_667 }))
    expect(third).toEqual(expect.objectContaining({ totalTokens: 4, maxOutputTokens: 4, outputCharacters: 26_667 }))

    reservations.release(first!, { totalTokens: 3, outputCharacters: 20_000 })
    reservations.release(second!, { totalTokens: 3, outputCharacters: 10_000 })
    reservations.release(third!, { totalTokens: 0, outputCharacters: 0 })

    const recovered = new AgentChildBudgetReservations(limits, reservations.consumed)
    const retry = recovered.reserve()
    expect(retry).toEqual(expect.objectContaining({ totalTokens: 4, outputCharacters: 50_000 }))
    recovered.release(retry!, { totalTokens: 4, outputCharacters: 50_000 })

    expect(recovered.consumed).toEqual({ totalTokens: 10, outputCharacters: 80_000 })
    expect(recovered.reserve()).toBeNull()
  })

  it('shares aggregate output headroom across the concurrent child batch', () => {
    const limits = {
      enabled: true,
      maxConcurrentChildren: 3,
      maxChildren: 3,
      plannerTurns: 1,
      childTurns: 2,
      childToolCalls: 2,
      plannerTimeoutMilliseconds: 1_000,
      childTimeoutMilliseconds: 1_000,
      plannerMaxOutputTokens: 2,
      childMaxOutputTokens: 4,
      maxAggregateChildTokens: 12,
      maxAggregateChildOutputCharacters: 96_000
    } as const satisfies AgentOrchestrationLimits
    const reservations = new AgentChildBudgetReservations(limits, { totalTokens: 0, outputCharacters: 0 })

    expect(reservations.reserve(3)).toEqual(expect.objectContaining({ totalTokens: 4, outputCharacters: 32_000 }))
    expect(reservations.reserve(2)).toEqual(expect.objectContaining({ totalTokens: 4, outputCharacters: 32_000 }))
    expect(reservations.reserve(1)).toEqual(expect.objectContaining({ totalTokens: 4, outputCharacters: 32_000 }))
  })
  it('uses aggregate token headroom smaller than the per-child ceiling', () => {
    const limits = {
      enabled: true,
      maxConcurrentChildren: 3,
      maxChildren: 3,
      plannerTurns: 1,
      childTurns: 2,
      childToolCalls: 2,
      plannerTimeoutMilliseconds: 1_000,
      childTimeoutMilliseconds: 1_000,
      plannerMaxOutputTokens: 2,
      childMaxOutputTokens: 4,
      maxAggregateChildTokens: 10,
      maxAggregateChildOutputCharacters: 200_000
    } as const satisfies AgentOrchestrationLimits
    const reservations = new AgentChildBudgetReservations(limits, { totalTokens: 0, outputCharacters: 0 })
    expect(reservations.reserve(3)).toEqual(expect.objectContaining({ totalTokens: 3, maxOutputTokens: 3 }))
    expect(reservations.reserve(2)).toEqual(expect.objectContaining({ totalTokens: 3, maxOutputTokens: 3 }))
    expect(reservations.reserve(1)).toEqual(expect.objectContaining({ totalTokens: 4, maxOutputTokens: 4 }))
    expect(reservations.reserve(1)).toBeNull()
  })

  it('rejects measured child usage above the held reservation without changing aggregate counters', () => {
    const limits = {
      enabled: true,
      maxConcurrentChildren: 1,
      maxChildren: 1,
      plannerTurns: 1,
      childTurns: 2,
      childToolCalls: 2,
      plannerTimeoutMilliseconds: 1_000,
      childTimeoutMilliseconds: 1_000,
      plannerMaxOutputTokens: 2,
      childMaxOutputTokens: 4,
      maxAggregateChildTokens: 4,
      maxAggregateChildOutputCharacters: 1_000
    } as const satisfies AgentOrchestrationLimits
    const reservations = new AgentChildBudgetReservations(limits, { totalTokens: 0, outputCharacters: 0 })
    const reservation = reservations.reserve()!

    expect(() => reservations.release(reservation, { totalTokens: 5, outputCharacters: 10 })).toThrow(
      expect.objectContaining({ code: 'AGENT_CHILD_BUDGET_EXCEEDED' })
    )
    expect(reservations.consumed).toEqual({ totalTokens: 0, outputCharacters: 0 })
    reservations.release(reservation, { totalTokens: 4, outputCharacters: 10 })
    expect(reservations.consumed).toEqual({ totalTokens: 4, outputCharacters: 10 })
  })
})

class PublicationBudgetLedger implements AgentDispatchBudget {
  readonly active = new Map<number, { tokens: number; costMicros: number }>()
  readonly reconciled: number[] = []
  readonly dispatched: AgentDispatchBudgetReservation[] = []
  readonly unusedAtDispatch: number[] = []
  readonly closedUnused: number[] = []
  consumedTokens = 0
  consumedCostMicros = 0
  allocatedTokens = 0
  returnedTokens = 0
  tools = 0
  #nextId = 1

  constructor(readonly maximumTokens: number) {}

  get unsettledExposure() {
    let tokens = 0
    let costMicros = 0
    for (const held of this.active.values()) {
      tokens += held.tokens
      costMicros += held.costMicros
    }
    return { tokens, costMicros }
  }

  async reserve(maximum: { tokens: number; costMicros: number }): Promise<AgentDispatchBudgetReservation> {
    expect(this.consumedTokens + this.unsettledExposure.tokens + maximum.tokens).toBeLessThanOrEqual(this.maximumTokens)
    const reservation = { id: this.#nextId++, ...maximum }
    this.active.set(reservation.id, maximum)
    this.allocatedTokens += maximum.tokens
    return reservation
  }

  async reconcile(reservation: AgentDispatchBudgetReservation, actual: AgentDispatchUsage) {
    expect(this.active.has(reservation.id)).toBe(true)
    expect(this.reconciled).not.toContain(reservation.id)
    expect(actual.totalTokens).toBeLessThanOrEqual(reservation.tokens)
    expect(actual.costMicros).toBeLessThanOrEqual(reservation.costMicros)
    this.active.delete(reservation.id)
    this.reconciled.push(reservation.id)
    this.consumedTokens += actual.totalTokens
    this.consumedCostMicros += actual.costMicros
    this.returnedTokens += reservation.tokens - actual.totalTokens
  }

  async release(reservation: AgentDispatchBudgetReservation) {
    expect(this.active.delete(reservation.id)).toBe(true)
    this.returnedTokens += reservation.tokens
  }

  async consumeTool() {
    this.tools++
  }

  async reserveSequence(maximum: { tokens: number; costMicros: number }): Promise<AgentDispatchBudgetSequence> {
    const parent = await this.reserve(maximum)
    let closed = false
    const children = new Set<number>()
    const ledger = this
    return {
      reserve: async requested => {
        expect(closed).toBe(false)
        const available = ledger.active.get(parent.id)!
        expect(requested.tokens).toBeLessThanOrEqual(available.tokens)
        expect(requested.costMicros).toBeLessThanOrEqual(available.costMicros)
        const child = { id: ledger.#nextId++, ...requested }
        ledger.active.set(parent.id, { tokens: available.tokens - requested.tokens, costMicros: available.costMicros - requested.costMicros })
        ledger.active.set(child.id, requested)
        children.add(child.id)
        ledger.dispatched.push(child)
        ledger.unusedAtDispatch.push(available.tokens - requested.tokens)
        return child
      },
      reconcile: async (reservation, actual) => {
        expect(children.delete(reservation.id)).toBe(true)
        await ledger.reconcile(reservation, actual)
      },
      release: async reservation => {
        expect(children.delete(reservation.id)).toBe(true)
        await ledger.release(reservation)
      },
      resizeUndispatched: async requested => {
        expect(closed).toBe(false)
        const available = ledger.active.get(parent.id)!
        const targetTokens = ledger.consumedTokens + ledger.unsettledExposure.tokens - available.tokens + requested.tokens
        if (targetTokens > ledger.maximumTokens)
          throw new AgentRepositoryError('AGENT_TOKEN_BUDGET_LIMITED', 'Publication quota cannot cover the requested unused capacity', 409)
        const difference = requested.tokens - available.tokens
        if (difference >= 0) ledger.allocatedTokens += difference
        else ledger.returnedTokens -= difference
        ledger.active.set(parent.id, requested)
      },
      close: async () => {
        expect(closed).toBe(false)
        expect(children.size).toBe(0)
        closed = true
        const unused = ledger.active.get(parent.id)!
        ledger.closedUnused.push(unused.tokens)
        ledger.returnedTokens += unused.tokens
        ledger.active.delete(parent.id)
      },
      consumeTool: () => ledger.consumeTool(),
      get unsettledExposure() {
        return ledger.unsettledExposure
      }
    }
  }
}

describe('bounded root publication accounting', () => {
  it('enforces the actual compact native source request boundary before consuming synthesis quota', async () => {
    const synthesisRequests: Readonly<AxChatRequest<unknown>>[] = []
    const collectionRequests: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      const final = synthesisInputFromRequest(input) !== undefined
      if (final) synthesisRequests.push(input)
      else collectionRequests.push(input)
      return {
        results: [final
          ? { index: 0, content: synthesisFixtureAnswer(input, {
              claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha requires review.' }]
            }, { bindings: { 'page:1:revision:rev-1': { text: 'Alpha requires review.' } } }) }
          : { index: 0, functionCalls: [{ id: 'read-alpha', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
      } satisfies AxChatResponse
    })
    const invoke = vi.fn(async () => ({
      id: 1,
      locale: 'en',
      path: 'alpha',
      title: 'Alpha',
      contentType: 'markdown',
      sourceRevision: 'rev-1',
      content: [
        'Alpha requires review.',
        'Background details. '.repeat(140),
        ...Array.from({ length: 24 }, (_, index) => `Background item ${index + 1} carries archival routing label BG-${index + 1}.`)
      ].join('\n\n'),
      citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        validateObservation: async () => true,
        snapshot: async () => ({}),
        close: () => {},
        authoritySha256: null
      })
    }
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      messages: [{ role: 'user', content: 'What does Alpha require?' }],
      limits: { maxTurns: 3, maxToolCalls: 1, maxOutputTokens: 512 }
    }
    const admittedBudget = new PublicationBudgetLedger(120_000)
    const admitted = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions).execute(
      { ...request, limits: { ...request.limits, maxTokens: admittedBudget.maximumTokens }, dispatchBudget: admittedBudget },
      { text: async () => {}, event: async () => {} }
    )
    expect(admitted.executionLimit).toBeUndefined()
    expect(admitted.citations).toEqual([expect.objectContaining({ evidenceId: 'page:1:revision:rev-1' })])
    expect(synthesisRequests).toHaveLength(1)
    const nativeRequest = synthesisRequests[0]!
    expect(nativeRequest.responseFormat?.schema).toBeDefined()
    const nativeRequestBytes = Buffer.byteLength(JSON.stringify(nativeRequest), 'utf8')
    expect(nativeRequestBytes + 512).toBeLessThanOrEqual(100_000)
    expect(Buffer.byteLength(JSON.stringify(collectionRequests[0]), 'utf8') + 512).toBeLessThan(nativeRequestBytes - 1)
    expect(admittedBudget.dispatched[0]?.tokens).toBe(nativeRequestBytes + 512)
    expect(admittedBudget.consumedTokens).toBe(10)
    expect(admittedBudget.consumedCostMicros).toBe(14)
    expect(admittedBudget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
    expect(admittedBudget.allocatedTokens).toBe(admittedBudget.returnedTokens + admittedBudget.consumedTokens)

    // Reuse the same source and native schema with a provider context one byte
    // below the observed encoded request. No duplicated-source overhead is assumed.
    const budget = new PublicationBudgetLedger(120_000)
    const text = vi.fn(async () => {})
    await expect(new AxAgentEngine(
      factoryFor(chat, { usage: 'terminal', maxContextTokens: nativeRequestBytes - 1 }),
      actions
    ).execute(
      { ...request, limits: { ...request.limits, maxTokens: budget.maximumTokens }, dispatchBudget: budget },
      { text, event: async () => {} }
    )).rejects.toMatchObject({ code: 'AGENT_CONTEXT_TOO_LARGE' })

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(synthesisRequests).toHaveLength(1)
    expect(collectionRequests).toHaveLength(2)
    expect(text).not.toHaveBeenCalled()
    expect(budget.tools).toBe(1)
    expect(budget.reconciled).toHaveLength(1)
    expect(budget.consumedTokens).toBe(5)
    expect(budget.consumedCostMicros).toBe(7)
    expect(budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
    expect(budget.allocatedTokens).toBe(budget.returnedTokens + budget.consumedTokens)
  })

  for (const outcome of ['first-accepted', 'repaired', 'exhausted', 'length'] as const) {
    it(`conserves draft and correction exposure when publication is ${outcome}`, async () => {
      const budget = new PublicationBudgetLedger(120_000)
      const accepted = { claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha requires review.' }] } satisfies SynthesisFixtureAnswer
      const rejected = { claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha does not require review.' }] } satisfies SynthesisFixtureAnswer
      let attempts = 0
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
        expect(input.modelConfig?.maxTokens).toBeLessThanOrEqual(512)
        const final = synthesisInputFromRequest(input) !== undefined
        if (final) {
          attempts++
          // A paid first draft retains the capacity for its possible repair
          // until the consumer accepts, rejects, or observes its length stop.
          if (attempts === 1) expect(budget.unusedAtDispatch[0]).toBeGreaterThan(512)
        }
        const answer = outcome === 'exhausted' || (outcome === 'repaired' && attempts === 1) ? rejected : accepted
        return {
          results: [final
            ? {
                index: 0,
                content: synthesisFixtureAnswer(input, answer),
                ...(outcome === 'length' ? { finishReason: 'length' as const } : {})
              }
            : { index: 0, functionCalls: [{ id: 'read-alpha', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
        } satisfies AxChatResponse
      })
      const invoke = vi.fn(async () => ({
        id: 1,
        locale: 'en',
        path: 'alpha',
        title: 'Alpha',
        contentType: 'markdown',
        sourceRevision: 'rev-1',
        content: 'Alpha requires review.',
        citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
        citationSections: []
      }))
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
          invoke,
          validateObservation: async () => true,
          snapshot: async () => ({}),
          close: () => {},
          authoritySha256: null
        })
      }
      const text = vi.fn(async () => {})
      const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions).execute(
        {
          ...baseRequest(new AbortController().signal),
          messages: [{ role: 'user', content: 'What does Alpha require?' }],
          limits: { maxTokens: budget.maximumTokens, maxTurns: 3, maxToolCalls: 1, maxOutputTokens: 512 },
          dispatchBudget: budget
        },
        { text, event: async () => {} }
      )
      const expectedTurns = outcome === 'first-accepted' || outcome === 'length' ? 2 : 3
      expect(attempts).toBe(expectedTurns - 1)
      expect(invoke).toHaveBeenCalledOnce()
      expect(budget.tools).toBe(1)
      expect(budget.dispatched).toHaveLength(expectedTurns - 1)
      expect(budget.reconciled).toHaveLength(expectedTurns)
      expect(budget.consumedTokens).toBe(expectedTurns * 5)
      expect(budget.consumedCostMicros).toBe(expectedTurns * 7)
      expect(result.totalTokens).toBe(budget.consumedTokens)
      expect(budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
      expect(budget.allocatedTokens).toBe(budget.returnedTokens + budget.consumedTokens)
      expect(budget.closedUnused).toHaveLength(1)
      const published = text.mock.calls.map(([delta]) => delta).join('')
      expect(published).not.toContain('does not require review')
      if (outcome === 'length') {
        expect(result.outputLimited).toBe(true)
        expect(result.suggestions).toEqual([expect.objectContaining({ id: 'continue-output-limit' })])
        expect(result.citations).toBeUndefined()
        expect(published).not.toContain('Alpha requires review.')
        expect(budget.closedUnused[0]).toBeGreaterThan(512)
      } else if (outcome === 'exhausted') {
        expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
        expect(result.citations).toBeUndefined()
      } else {
        expect(result.executionLimit).toBeUndefined()
        expect(result.citations).toEqual([expect.objectContaining({ evidenceId: 'page:1:revision:rev-1' })])
        expect(published).toContain('Alpha requires review.')
        if (outcome === 'first-accepted') expect(budget.closedUnused[0]).toBeGreaterThan(512)
      }
    })
  }

  for (const maxTurns of [1, 2]) {
    it(`accepts a valid single-pass answer under a ${maxTurns}-turn cap that cannot fund two full generations`, async () => {
      const synthesisRequests: Readonly<AxChatRequest<unknown>>[] = []
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
        expect(synthesisInputFromRequest(input)).toBeDefined()
        synthesisRequests.push(input)
        expect(input.modelConfig?.maxTokens).toBeLessThanOrEqual(128)
        return {
          results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
        } satisfies AxChatResponse
      })
      const engine = new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }))
      const request = { ...baseRequest(new AbortController().signal), limits: { maxTurns, maxToolCalls: 0, maxOutputTokens: 128 } }
      const preflight = await engine.preflight(request)
      expect(preflight).toMatchObject({ admissible: true, outputExposureTokens: 128 })
      const measured = await engine.execute(request, { text: async () => {}, event: async () => {} })
      expect(measured).toMatchObject({ totalTokens: 5, executionLimit: { reason: 'evidence', publication: 'inability' } })
      expect(synthesisRequests.flatMap(input => input.functions ?? []).map(fn => fn.name)).toEqual([])
      const nativeRequestBytes = Buffer.byteLength(JSON.stringify(synthesisRequests[0]), 'utf8')
      const budget = new PublicationBudgetLedger(nativeRequestBytes + 128)
      expect(budget.maximumTokens).toBeLessThan(nativeRequestBytes * 2)
      const text = vi.fn(async () => {})
      const event = vi.fn(async () => {})
      const result = await engine.execute(
        { ...request, limits: { ...request.limits, maxTokens: budget.maximumTokens }, dispatchBudget: budget },
        { text, event }
      )
      expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
      expect(result.citations).toBeUndefined()
      expect(synthesisRequests.flatMap(input => input.functions ?? []).map(fn => fn.name)).toEqual([])
      expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted', totalTokens: 5 })])
      expect(budget.dispatched[0]?.tokens).toBe(Buffer.byteLength(JSON.stringify(synthesisRequests[1]), 'utf8') + 128)
      expect(budget.consumedTokens).toBe(5)
      expect(budget.consumedCostMicros).toBe(7)
      expect(budget.reconciled).toHaveLength(1)
      expect(budget.dispatched).toHaveLength(1)
      expect(budget.unsettledExposure.tokens).toBe(0)
      expect(budget.allocatedTokens).toBe(budget.returnedTokens + result.totalTokens)
    })
  }
})
