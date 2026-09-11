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
  options: { readonly streaming?: boolean; readonly usage?: 'stream' | 'terminal' | 'estimated' } = {}
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
        maxOutputTokens: 4_000
      },
      transportKind: 'openai-responses',
      model: 'gpt-test',
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1',
      pricing
    })
  }) as unknown as AgentProviderFactory

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

  it('marks third-turn context admission after one plus ten completed tool calls without dispatching a third model turn', async () => {
    const calls = Array.from({ length: 10 }, (_, index) => ({
      id: `second-${index}`,
      type: 'function' as const,
      function: { name: 'wiki_get_page', params: JSON.stringify({ id: index + 2 }) }
    }))
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'first', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }] },
      { results: [{ index: 0, functionCalls: calls }] }
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
    const error = await new AxAgentEngine(
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
    )
      .execute(
        {
          ...baseRequest(new AbortController().signal),
          limits: { maxTurns: 3, maxToolCalls: 11, maxOutputTokens: 100 }
        },
        { text: async () => {}, event: async () => {} }
      )
      .catch(value => value)

    expect(error).toMatchObject({ code: 'AGENT_CONTEXT_TOO_LARGE', stage: 'context_admission' })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledTimes(11)
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
  it('reconciles charged provider usage before rejecting a post-response capability violation', async () => {
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
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })

    expect(reconcile).toHaveBeenCalledWith(reservation, { inputTokens: 7, outputTokens: 5, totalTokens: 12, costMicros: 17 })
    expect(release).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })
  it('propagates reconciliation failure after a provider response validation error', async () => {
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

    expect(error).toMatchObject({ code: 'PROVIDER_REQUEST_FAILED', stage: 'usage_reconciliation' })
    expect(reconcile).toHaveBeenCalledWith(reservation, { inputTokens: 7, outputTokens: 5, totalTokens: 12, costMicros: 17 })
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
