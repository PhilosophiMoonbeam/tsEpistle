import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { describe, expect, it, vi } from '../bun-test.mts'

import { AxAgentEngine, type AgentActionSessionProvider } from '../../agents/providers/engine.ts'
import { AgentProviderAttemptError, type AgentProviderFactory, type AgentProviderService } from '../../agents/providers/factory.ts'
import { AgentExecutionFailure } from '../../agents/providers/execution-failure.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { AgentChildBudgetReservations, MAX_AGENT_CHILD_OUTPUT_CHARACTERS, type AgentOrchestrationLimits } from '../../agents/orchestration.ts'

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
    readonly maxOutputTokens?: number
    readonly preserveThoughtBlock?: AgentProviderService['preserveThoughtBlock']
  } = {}
): AgentProviderFactory =>
  ({
    create: async () => ({
      service: { chat },
      capabilities: {
        streaming: options.streaming ?? false,
        toolCalling: 'native',
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema',
        usage: options.usage ?? 'estimated',
        cancellation: true,
        maxContextTokens: 100_000,
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
      { results: [{ index: 0, functionCalls: calls }] },
      { results: [{ index: 0, content: 'The available evidence is incomplete.' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const invoke = vi.fn(async () => ({ content: 'x'.repeat(3_000) }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const result = await new AxAgentEngine(
      {
        create: async () => ({
          service: { chat },
          capabilities: {
            streaming: false,
            toolCalling: 'native',
            parallelToolCalls: true,
            structuredOutput: 'native-json-schema',
            usage: 'estimated',
            cancellation: true,
            maxContextTokens: 25_000,
            maxOutputTokens: 1_000
          },
          transportKind: 'openai-responses',
          model: 'gpt-test',
          capabilityRevision: 'cap-1',
          pricingRevision: 'price-1',
          pricing
        })
      } as unknown as AgentProviderFactory,
      actions
    ).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTurns: 3, maxToolCalls: 11, maxOutputTokens: 100 }
      },
      { text: async () => {}, event: async () => {} }
    )

    const omittedActionCallIds = result.contextLimit?.omittedActionCallIds
    expect(result.contextLimit?.reason).toBe('tool_result_capacity')
    expect(Array.isArray(omittedActionCallIds)).toBe(true)
    expect(omittedActionCallIds?.length).toBeGreaterThan(0)
    expect(chat).toHaveBeenCalledTimes(3)
    const synthesisRequest = chat.mock.calls[2]?.[0] as AxChatRequest<unknown> | undefined
    expect(synthesisRequest).toBeDefined()
    expect(synthesisRequest).not.toHaveProperty('functions')
    const closedProviderCallIds = new Set(
      (synthesisRequest?.chatPrompt ?? []).filter(message => message.role === 'function').map(message => message.functionId)
    )
    for (const callId of ['first', ...calls.map(call => call.id)]) expect(closedProviderCallIds.has(callId)).toBe(true)
    const synthesisResults = (synthesisRequest?.chatPrompt ?? []).filter(message => message.role === 'function').map(message => message.result)
    expect(synthesisResults.some(result => result.includes('"status":"omitted"'))).toBe(true)
    expect(synthesisResults.some(result => result.includes('"status":"not_executed"'))).toBe(true)
    expect(invoke.mock.calls.length).toBeGreaterThan(0)
    expect(invoke.mock.calls.length).toBeLessThan(11)
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
              claims: [{ text: 'Alpha requires review. [[cite:page:1]]', evidenceIds: ['page:1'], sourceRevisionIds: ['rev-1'], confidence: 'high' }],
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
      sourceRevision: 'rev-1',
      title: 'Alpha',
      contentType: 'markdown',
      content: 'Alpha requires review.',
      citation: { evidenceId: 'page:1', label: 'Alpha', href: '/en/alpha' },
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

  it('dispatches only the covered action when the root tool budget is one', async () => {
    const chat = vi.fn(
      async () =>
        ({
          results: [
            {
              index: 0,
              functionCalls: [
                { id: 'first', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } },
                { id: 'second', type: 'function', function: { name: 'wiki_get_page', params: '{"id":2}' } }
              ]
            }
          ],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        }) satisfies AxChatResponse
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

    await expect(
      Promise.resolve(
        new AxAgentEngine(factoryFor(chat), actions).execute(
          {
            ...baseRequest(new AbortController().signal),
            limits: { maxTokens: 100, maxTurns: 2, maxToolCalls: 1, maxOutputTokens: 10 }
          },
          { text: async () => {}, event: async () => {} }
        )
      )
    ).rejects.toMatchObject({ code: 'AGENT_BUDGET_LIMITED' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch actions from the final available model turn', async () => {
    const chat = vi.fn(
      async () =>
        ({
          results: [
            {
              index: 0,
              functionCalls: [{ id: 'too-late', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }]
            }
          ],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        }) satisfies AxChatResponse
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

    await expect(
      Promise.resolve(
        new AxAgentEngine(factoryFor(chat), actions).execute(
          {
            ...baseRequest(new AbortController().signal),
            limits: { maxTokens: 100, maxTurns: 1, maxToolCalls: 1, maxOutputTokens: 10 }
          },
          { text: async () => {}, event: async () => {} }
        )
      )
    ).rejects.toMatchObject({ code: 'AGENT_TURN_LIMIT' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects root synthesis until every completed task has cited coverage', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1]]' }] },
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1]] Beta requires audit. [[cite:page:2]]' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
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
            evidenceIds: ['page:1'],
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
            evidenceIds: ['page:2'],
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
              sourceRevision: 'rev-1',
              content: 'Alpha requires review.',
              citation: { evidenceId: 'page:1', label: 'Alpha', href: '/en/alpha' },
              citationSections: []
            }
          },
          {
            taskId: '00000000-0000-4000-8000-000000000022',
            subagentRunId: '00000000-0000-4000-8000-000000000032',
            actionCallId: 'beta-read',
            actionName: 'pages.get',
            output: {
              sourceRevision: 'rev-2',
              content: 'Beta requires audit.',
              citation: { evidenceId: 'page:2', label: 'Beta', href: '/en/beta' },
              citationSections: []
            }
          }
        ]
      }
    }
    const text = vi.fn(async () => {})

    await new AxAgentEngine(factoryFor(chat)).execute(request, { text, event })

    expect(chat).toHaveBeenCalledTimes(2)
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toEqual([
      expect.objectContaining({ accepted: false, issues: expect.arrayContaining([expect.stringContaining('Review beta')]) }),
      expect.objectContaining({ accepted: true, finalCitationIds: ['page:1', 'page:2'] })
    ])
    expect(text).toHaveBeenCalledWith('Alpha requires review. [[cite:page:1]] Beta requires audit. [[cite:page:2]]')
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
          evidenceIds: ['page:1', 'page:2'],
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
        sourceRevision: `rev-${id}`,
        title: id === 1 ? 'Alpha' : 'Beta',
        contentType: 'markdown',
        content: id === 1 ? 'Alpha requires review.' : 'Beta requires audit.',
        citation: { evidenceId: `page:${id}`, label: id === 1 ? 'Alpha' : 'Beta', href: `/en/${id === 1 ? 'alpha' : 'beta'}` },
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
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1]] Beta requires audit. [[cite:page:2]]' }] },
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1]] However, beta requires audit. [[cite:page:2]]' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
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
                  evidenceIds: ['page:1', 'page:2'],
                  explanation: 'Alpha requires review while beta requires audit.'
                }
              ],
              unanswered: [],
              recommendedFollowups: []
            },
            evidenceIds: ['page:1', 'page:2'],
            conflictEvidenceGroups: [['page:1', 'page:2']]
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
              sourceRevision: 'rev-1',
              content: 'Alpha requires review.',
              citation: { evidenceId: 'page:1', label: 'Alpha', href: '/en/alpha' },
              citationSections: []
            }
          },
          {
            taskId,
            subagentRunId: '00000000-0000-4000-8000-000000000053',
            actionCallId: 'beta-read',
            actionName: 'pages.get',
            output: {
              sourceRevision: 'rev-2',
              content: 'Beta requires audit.',
              citation: { evidenceId: 'page:2', label: 'Beta', href: '/en/beta' },
              citationSections: []
            }
          }
        ]
      }
    }
    const text = vi.fn(async () => {})

    await new AxAgentEngine(factoryFor(chat)).execute(request, { text, event })

    expect(chat).toHaveBeenCalledTimes(2)
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toEqual([
      expect.objectContaining({ accepted: false, issues: expect.arrayContaining([expect.stringContaining('explicitly disclosing')]) }),
      expect.objectContaining({ accepted: true, finalCitationIds: ['page:1', 'page:2'] })
    ])
    expect(text).toHaveBeenCalledWith('Alpha requires review. [[cite:page:1]] However, beta requires audit. [[cite:page:2]]')
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
    const admitted = reserve.mock.calls[0]?.[0]
    expect(admitted).toBeDefined()
    expect(admitted).toMatchObject({ tokens: 5_326, costMicros: 10_652 })
    expect(result).toMatchObject({ inputTokens: 1_326, outputTokens: 4_000, totalTokens: 5_326, costMicros: 9_326 })
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ tokens: 5_326, costMicros: 10_652 }), {
      inputTokens: 1_326,
      outputTokens: 4_000,
      totalTokens: 5_326,
      costMicros: 9_326
    })
    expect(admitted!.costMicros - result.costMicros).toBe(1_326)
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
      await expect(
        new AxAgentEngine(factory).execute(
          { ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget },
          { text: async () => {}, event: async () => {} }
        )
      ).rejects.toMatchObject({ message: 'Agent inference failed' })
      return { release, reconcile }
    }

    const lost = await runCase(
      vi.fn(async () => {
        throw new Error('lost response')
      })
    )
    expect(lost.reconcile).not.toHaveBeenCalled()
    expect(lost.release).not.toHaveBeenCalled()

    const stream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'partial' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
        })
        controller.error(new Error('stream lost'))
      }
    })
    const interrupted = await runCase(
      vi.fn(async () => stream),
      factoryFor(
        vi.fn(async () => stream),
        { streaming: true, usage: 'stream' }
      )
    )
    expect(interrupted.reconcile).not.toHaveBeenCalled()
    expect(interrupted.release).not.toHaveBeenCalled()

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
    const responses: AxChatResponse[] = [
      {
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
      },
      {
        results: [{ index: 0, content: 'replaced' }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
      }
    ]
    const invoke = vi.fn(async (_name: string, input: unknown) => ({ input }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const result = await new AxAgentEngine(
      factoryFor(async () => responses.shift()!),
      actions
    ).execute({ ...baseRequest(new AbortController().signal), purpose: 'root' }, { text: async () => {}, event: async () => {} })
    expect(result).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    expect(invoke).toHaveBeenCalledWith('pages.get', argumentSmall, expect.any(AbortSignal), 'replace')
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
    const invoke = vi.fn(async (_name: string, input: unknown) => ({ input }))
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
    const finalResponse = {
      results: [{ index: 0, content: 'ok' }],
      modelUsage: { ...usage, tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
    } satisfies AxChatResponse
    let exactDispatches = 0
    const exactChat: AgentProviderService['service']['chat'] = vi.fn(async () => {
      exactDispatches += 1
      return exactDispatches === 1 ? responseStream(firstStreamResponses) : finalResponse
    })
    await new AxAgentEngine(
      factoryFor(exactChat, {
        streaming: true,
        usage: 'stream',
        maxOutputTokens: 4_096
      }),
      actions
    ).execute({ ...baseRequest(new AbortController().signal), purpose: 'root' }, { text: async () => {}, event: async () => {} })
    expect(invoke).toHaveBeenCalledWith('pages.get', { x: argumentValue }, expect.any(AbortSignal), 'exact-argument')

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
      const responses: AxChatResponse[] = [
        {
          results: [{ index: 0, functionCalls: [{ id: 'exact', type: 'function', function: { name: 'wiki_get_page', params } }] }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        },
        {
          results: [{ index: 0, content: 'ok' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
        }
      ]
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
      await new AxAgentEngine(
        factoryFor(async () => responses.shift()!),
        actions
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'root' }, { text: async () => {}, event: async () => {} })
      expect(invoke).toHaveBeenCalledOnce()
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
              results: [{ id: 'signature-exact', index: 0, thoughtBlocks: [{ data: 'x', encrypted: true, signature: 's'.repeat(32_768) }] }],
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
                  results: [{ id: 'signature-next', index: 0, thoughtBlocks: [{ data: 'x', encrypted: true, signature: 's'.repeat(32_769) }] }],
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

    const first = reservations.reserve()
    const second = reservations.reserve()
    const third = reservations.reserve()

    expect(first).toEqual(
      expect.objectContaining({
        totalTokens: 4,
        outputCharacters: MAX_AGENT_CHILD_OUTPUT_CHARACTERS
      })
    )
    expect(second).toEqual(
      expect.objectContaining({
        totalTokens: 4,
        outputCharacters: 80_000 - MAX_AGENT_CHILD_OUTPUT_CHARACTERS
      })
    )
    expect(third).toBeNull()

    reservations.release(first!, { totalTokens: 3, outputCharacters: 20_000 })
    reservations.release(second!, { totalTokens: 3, outputCharacters: 10_000 })
    expect(reservations.consumed).toEqual({ totalTokens: 6, outputCharacters: 30_000 })

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

    expect(reservations.reserve()).toEqual(expect.objectContaining({ totalTokens: 4 }))
    expect(reservations.reserve()).toEqual(expect.objectContaining({ totalTokens: 4 }))
    expect(reservations.reserve()).toEqual(expect.objectContaining({ totalTokens: 2 }))
    expect(reservations.reserve()).toBeNull()
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
