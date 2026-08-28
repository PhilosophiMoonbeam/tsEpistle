import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { describe, expect, it, vi } from 'vitest'

import { AxAgentEngine, type AgentActionSessionProvider } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory, AgentProviderService } from '../../agents/providers/factory.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'

const run = {
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  userMessageId: '00000000-0000-4000-8000-000000000003',
  assistantMessageId: '00000000-0000-4000-8000-000000000004',
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

const factoryFor = (chat: AgentProviderService['service']['chat']): AgentProviderFactory => ({
  create: async () => ({
    service: { chat },
    capabilities: {
      streaming: false,
      toolCalling: 'native',
      parallelToolCalls: true,
      structuredOutput: 'native-json-schema',
      usage: 'terminal',
      cancellation: true,
      maxContextTokens: 100_000,
      maxOutputTokens: 4_000
    },
    transportKind: 'openai-responses',
    model: 'gpt-test',
    capabilityRevision: 'cap-1',
    pricingRevision: 'price-1'
  })
}) as unknown as AgentProviderFactory

describe('Ax orchestration stages', () => {
  it('runs the planner without actions, retries, or unbounded output', async () => {
    const chat = vi.fn(async () => ({
      results: [{ index: 0, content: '{"tasks":[]}' }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } }
    } satisfies AxChatResponse))
    const open = vi.fn()
    const text = vi.fn(async () => {})
    const engine = new AxAgentEngine(factoryFor(chat), { open } as unknown as AgentActionSessionProvider)

    await expect(engine.execute({
      ...baseRequest(new AbortController().signal),
      purpose: 'planner',
      actionAllowlist: [],
      limits: { maxTurns: 2, maxToolCalls: 0, maxOutputTokens: 1_024 }
    }, { text, event: async () => {} })).resolves.toMatchObject({ inputTokens: 4, outputTokens: 2 })

    expect(open).not.toHaveBeenCalled()
    expect(text).toHaveBeenCalledWith('{"tasks":[]}')
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      modelConfig: { maxTokens: 1_024 },
      chatPrompt: [expect.objectContaining({ role: 'system', content: expect.stringContaining('task-planning stage') }), expect.any(Object)]
    }), expect.objectContaining({ retry: { maxRetries: 0 } }))
    expect(chat.mock.calls[0]?.[0]).not.toHaveProperty('functions')
  })

  it('namespaces child action calls and returns the frozen authority hash', async () => {
    const taskId = '00000000-0000-4000-8000-000000000011'
    const subagentRunId = '00000000-0000-4000-8000-000000000012'
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'provider-call', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }] },
      { results: [{ index: 0, content: JSON.stringify({
        taskId,
        outcome: 'completed',
        claims: [{ text: 'Alpha requires review. [[cite:page:1]]', evidenceIds: ['page:1'], sourceRevisionIds: ['rev-1'], confidence: 'high' }],
        conflicts: [],
        unanswered: [],
        recommendedFollowups: []
      }) }] }
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

    expect(invoke).toHaveBeenCalledWith('pages.get', { id: 1 }, expect.any(AbortSignal), expect.stringMatching(new RegExp(`^sa_${subagentRunId}_[a-f0-9]{24}$`, 'u')))
    expect(result.authoritySha256).toBe(authoritySha256)
    expect(text).toHaveBeenCalledWith(expect.stringContaining('"taskId"'))
    const systemPrompt = (chat.mock.calls[0]?.[0] as AxChatRequest<unknown>).chatPrompt?.[0]
    expect(systemPrompt).toEqual(expect.objectContaining({ content: expect.not.stringContaining('private preference') }))
  })

  it('rejects root synthesis until every completed task has cited coverage', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1]]' }] },
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1]] Beta requires audit. [[cite:page:2]]' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const event = vi.fn(async (...args: [string, unknown]) => { void args })
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      research: {
        packets: [
          {
            task: { id: '00000000-0000-4000-8000-000000000021', kind: 'source_scout', title: 'Review alpha', question: 'Alpha?', sourceScope: ['alpha'], requiredEvidenceCount: 1 },
            packet: { taskId: '00000000-0000-4000-8000-000000000021', outcome: 'completed', claims: [], conflicts: [], unanswered: [], recommendedFollowups: [] },
            evidenceIds: ['page:1'],
            conflictEvidenceGroups: []
          },
          {
            task: { id: '00000000-0000-4000-8000-000000000022', kind: 'source_scout', title: 'Review beta', question: 'Beta?', sourceScope: ['beta'], requiredEvidenceCount: 1 },
            packet: { taskId: '00000000-0000-4000-8000-000000000022', outcome: 'completed', claims: [], conflicts: [], unanswered: [], recommendedFollowups: [] },
            evidenceIds: ['page:2'],
            conflictEvidenceGroups: []
          }
        ],
        incompleteTasks: [],
        evidenceSeeds: [
          { taskId: '00000000-0000-4000-8000-000000000021', subagentRunId: '00000000-0000-4000-8000-000000000031', actionCallId: 'alpha-read', actionName: 'pages.get', output: { sourceRevision: 'rev-1', content: 'Alpha requires review.', citation: { evidenceId: 'page:1', label: 'Alpha', href: '/en/alpha' }, citationSections: [] } },
          { taskId: '00000000-0000-4000-8000-000000000022', subagentRunId: '00000000-0000-4000-8000-000000000032', actionCallId: 'beta-read', actionName: 'pages.get', output: { sourceRevision: 'rev-2', content: 'Beta requires audit.', citation: { evidenceId: 'page:2', label: 'Beta', href: '/en/beta' }, citationSections: [] } }
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
})
