import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from '../bun-test.mts'
import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { registerMemoryAction } from '../../agents/actions/memory.ts'
import type { ActionHandler, ActionHandlerContext, ActionKernel } from '../../agents/actions/kernel.ts'
import type { AgentMemoryRepository } from '../../agents/memory.ts'
import { AxAgentEngine, type AgentActionSessionProvider } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory, ProviderThoughtBlock } from '../../agents/providers/factory.ts'
import { invokingAgentRunLease, type AgentApprovalContinuationCheckpoint, type AgentRunLeaseIdentity } from '../../agents/coordinator.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { WIKI_AGENT_SOUL } from '../../agents/soul.ts'
import { reduceAgentEvents } from '../../agents/projection.ts'
import type { AgentEvent } from '../../../shared/agents/contracts.ts'

const pricing = { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } as const

const request = (signal: AbortSignal): AgentEngineRequest => ({
  run: {
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
    errorCode: null,
    errorMessage: null,
    queuedAt: '2026-08-17T00:00:00.000Z',
    startedAt: '2026-08-17T00:00:00.000Z',
    completedAt: null
  },
  messages: [{ role: 'user', content: 'Read page 42' }],
  memory: { user: ['Prefers concise, evidence-first answers.'], agent: ['Wiki project uses PostgreSQL and Bun.'] },
  currentPage: { id: 42, locale: 'en', path: 'guide', observedUpdatedAt: '2026-08-17T00:00:00.000Z' },
  skills: [{ id: '00000000-0000-4000-8000-000000000008', name: 'wiki-reader', skillMarkdown: '# Reader\nUse page tools.' }],
  priorActivity: [
    {
      runId: '00000000-0000-4000-8000-000000000009',
      status: 'succeeded',
      userMessageOrdinal: 1,
      assistantMessageOrdinal: 2,
      modelTurns: 3,
      rejectedEvidenceDrafts: 1,
      tools: [
        {
          actionCallId: 'prior-get',
          actionName: 'pages.get',
          state: 'complete',
          input: { id: 6 },
          target: { id: 6, title: 'Incident Runbook', sourceRevision: '1' },
          cacheHit: false,
          duplicateOfActionCallId: null
        }
      ]
    }
  ],
  signal
})

describe('Ax agent engine', () => {
  it('accepts an independent provider total from a completed response', async () => {
    const response = {
      results: [{ index: 0, content: 'Real receipt answer.' }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 4_580 } }
    } satisfies AxChatResponse
    const chat = vi.fn(async () => response)
    const factory = {
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
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const text = vi.fn(async () => {})
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })

    const result = await new AxAgentEngine(factory).execute({ ...request(new AbortController().signal), purpose: 'planner' }, { text, event })

    expect(text).toHaveBeenCalledWith('Real receipt answer.')
    expect(result).toMatchObject({ inputTokens: 3, outputTokens: 309, totalTokens: 4_580, costMicros: 9_157 })
    expect(event).toHaveBeenCalledWith('model.turn', expect.objectContaining({ usageVersion: 2, inputTokens: 3, outputTokens: 309, totalTokens: 4_580 }))
  })
  it('runs bounded provider tool turns and returns encrypted continuation only', async () => {
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const responses: AxChatResponse[] = [
      {
        results: [
          {
            index: 0,
            id: 'rs_1',
            content: 'Let me check.',
            functionCalls: [
              { id: 'call-1', type: 'function', function: { name: 'wiki_get_page', params: '{"id":' } },
              { id: 'call-1', type: 'function', function: { name: '', params: '42}' } }
            ],
            thoughtBlocks: [
              { data: 'encrypted-state', encrypted: true },
              { data: 'hidden thought', encrypted: false }
            ]
          }
        ],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } }
      },
      {
        results: [{ index: 0, content: 'The install steps are documented.[[cite:page:42:revision:1:section:1]]' }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 8, completionTokens: 4, totalTokens: 12 } }
      }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return responses.shift()!
    })
    const factory = {
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
        continuationDialect: 'openai-responses-reasoning-v1',
        pricingRevision: 'price-1',
        pricing,
        preserveThoughtBlock: (resultId: string, block: ProviderThoughtBlock) => {
          if (block.encrypted !== true || typeof block.data !== 'string' || !/^rs_[A-Za-z0-9_-]{1,256}$/u.test(resultId)) return null
          return { data: `wiki.openai.reasoning.v1:${JSON.stringify([resultId, block.data])}`, encrypted: true }
        }
      })
    } as unknown as AgentProviderFactory
    const invoke = vi.fn(async () => ({
      id: 42,
      title: 'Guide',
      contentType: 'markdown',
      content: '# Guide\n\n## Install\nThe install steps are documented.',
      citation: { evidenceId: 'page:42:revision:1', label: 'Guide', href: '/en/guide' },
      citationSections: [{ evidenceId: 'page:42:revision:1:section:1', label: 'Guide › Install', href: '/en/guide#install' }]
    }))
    const publicationOrder: string[] = []
    const close = vi.fn(() => {
      publicationOrder.push('close')
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.get',
            title: 'Read page',
            description: 'Reads a page',
            parameters: { type: 'object', properties: { id: { type: 'number' } } },
            risk: 'read'
          }
        ],
        invoke,
        snapshot: async () => ({}),
        close
      })
    }
    const engine = new AxAgentEngine(factory, actions)
    const text = vi.fn(async () => {
      publicationOrder.push('text')
    })
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    const result = await engine.execute(request(new AbortController().signal), { text, event })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledWith('pages.get', { id: 42 }, expect.objectContaining({ aborted: false }), 'call-1')
    expect(calls[0]?.functions).toContainEqual(expect.objectContaining({ name: 'wiki_get_page' }))
    expect(calls[0]?.chatPrompt?.[0]).toEqual(
      expect.objectContaining({
        role: 'system',
        content: expect.stringMatching(new RegExp(`^${WIKI_AGENT_SOUL.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n\\n`))
      })
    )
    expect(calls[0]?.chatPrompt).toContainEqual(
      expect.objectContaining({ role: 'system', content: expect.stringContaining('"id":42,"locale":"en","path":"guide"') })
    )
    expect(calls[0]?.chatPrompt).toContainEqual(
      expect.objectContaining({ role: 'system', content: expect.stringContaining('"userProfile":["Prefers concise, evidence-first answers."]') })
    )
    expect(calls[0]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('"rejectedEvidenceDrafts":1') }))
    expect(calls[1]?.chatPrompt).toContainEqual(
      expect.objectContaining({ role: 'assistant', functionCalls: [expect.objectContaining({ function: expect.objectContaining({ name: 'wiki_get_page' }) })] })
    )
    expect(calls[1]?.chatPrompt).toContainEqual(
      expect.objectContaining({ role: 'function', functionId: 'call-1', result: expect.stringContaining('"citationSections"') })
    )
    expect(calls[1]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'Let me check.' }))
    expect(text).toHaveBeenCalledWith('The install steps are documented.[[cite:page:42:revision:1:section:1]]')
    expect(text).not.toHaveBeenCalledWith('Let me check.')
    expect(event.mock.calls.map(([type]) => type)).toEqual(['model.turn', 'tool.started', 'tool.completed', 'model.turn', 'evidence.provenance'])
    expect(event).toHaveBeenLastCalledWith(
      'evidence.provenance',
      expect.objectContaining({
        accepted: true,
        retrievals: [{ actionCallId: 'call-1', actionName: 'pages.get', evidenceIds: ['page:42:revision:1', 'page:42:revision:1:section:1'] }],
        claims: [
          expect.objectContaining({
            claim: 'The install steps are documented.',
            evidenceId: 'page:42:revision:1:section:1',
            pageEvidenceId: 'page:42:revision:1',
            supported: true
          })
        ],
        finalCitationIds: ['page:42:revision:1:section:1']
      })
    )
    expect(result).toMatchObject({
      inputTokens: 13,
      outputTokens: 6,
      totalTokens: 19,
      citations: [{ evidenceId: 'page:42:revision:1:section:1', kind: 'page', label: 'Guide › Install', href: '/en/guide#install' }],
      providerState: {
        schemaVersion: 1,
        continuationDialect: 'openai-responses-reasoning-v1',
        thoughtBlocks: [{ data: 'wiki.openai.reasoning.v1:["rs_1","encrypted-state"]', encrypted: true }]
      }
    })
    expect(JSON.stringify(result)).not.toContain('hidden thought')
    expect(close).toHaveBeenCalledOnce()
    expect(publicationOrder).toEqual(['close', 'text'])
  })
  it('finalizes actions before publication and preserves the primary provider failure over cleanup failure', async () => {
    const response = {
      results: [{ index: 0, content: 'Planner answer.' }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
    } satisfies AxChatResponse
    const chat = vi.fn(async () => response)
    const factory = {
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
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const close = vi.fn(() => {
      throw new Error('cleanup failed')
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [],
        invoke: async () => ({}),
        snapshot: async () => ({}),
        close,
        authoritySha256: null
      })
    }
    const text = vi.fn(async () => {})
    const engine = new AxAgentEngine(factory, actions)

    await expect(engine.execute({ ...request(new AbortController().signal) }, { text, event: async () => {} })).rejects.toMatchObject({
      code: 'ACTION_SESSION_CLOSE_FAILED',
      stage: 'action_cleanup',
      message: 'Agent inference failed'
    })
    expect(text).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()

    close.mockClear()
    chat.mockImplementationOnce(async () => {
      throw new Error('provider failed')
    })
    await expect(engine.execute({ ...request(new AbortController().signal) }, { text, event: async () => {} })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
      stage: 'provider_request',
      message: 'Agent inference failed'
    })
    expect(close).toHaveBeenCalledOnce()
  })
  it('compacts retrieval projections so tool results continue within a goal token budget', async () => {
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const responses: AxChatResponse[] = [
      {
        results: [
          {
            index: 0,
            functionCalls: [{ id: 'budget-search', type: 'function', function: { name: 'wiki_search_pages', params: '{"query":"recipes","limit":20}' } }]
          }
        ],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } }
      },
      {
        results: [{ index: 0, functionCalls: [{ id: 'budget-page', type: 'function', function: { name: 'wiki_get_page', params: '{"id":42}' } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 6_000, completionTokens: 20, totalTokens: 6_020 } }
      },
      {
        results: [{ index: 0, content: 'Budget evidence is available.[[cite:page:42:revision:1:section:1]]' }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 7_000, completionTokens: 30, totalTokens: 7_030 } }
      }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return responses.shift()!
    })
    const factory = {
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
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.search',
            title: 'Search pages',
            description: 'Searches visible pages',
            parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
            risk: 'read'
          },
          {
            name: 'pages.get',
            title: 'Read page',
            description: 'Reads a visible page',
            parameters: { type: 'object', properties: { id: { type: 'number' } } },
            risk: 'read'
          }
        ],
        invoke: async (actionName: string) =>
          actionName === 'pages.search'
            ? {
                results: [
                  {
                    id: 42,
                    title: 'Search candidate',
                    knowledge: {
                      state: 'complete',
                      summary: 'A concise provider-facing search summary.',
                      entities: [{ name: 'Internal review detail' }],
                      provenance: { fields: 'review metadata '.repeat(3_000) }
                    }
                  }
                ],
                suggestions: [],
                totalInWindow: 1,
                windowLimit: 100,
                windowTruncated: false,
                nextOffset: null
              }
            : {
                id: 42,
                title: 'Budget Guide',
                contentType: 'markdown',
                content: `# Budget Guide\n\n## Evidence\n${'Budget evidence remains available. '.repeat(1_200)}`,
                knowledge: {
                  state: 'complete',
                  summary: 'Budget evidence page.',
                  relationships: [{ predicate: 'internal-review-detail' }],
                  provenance: { fields: 'page review metadata '.repeat(3_000) }
                },
                citation: { evidenceId: 'page:42:revision:1', label: 'Budget Guide', href: '/en/budget-guide' },
                citationSections: [{ evidenceId: 'page:42:revision:1:section:1', label: 'Budget Guide › Evidence', href: '/en/budget-guide#evidence' }]
              },
        snapshot: async () => ({}),
        close: () => undefined
      })
    }
    let consumedTokens = 0
    let reservationId = 0
    const reservedMaximums: number[] = []
    const admittedTotals: number[] = []
    const dispatchBudget = {
      reserve: async (maximum: { readonly tokens: number; readonly costMicros: number }) => {
        admittedTotals.push(consumedTokens + maximum.tokens)
        if (consumedTokens + maximum.tokens > 64_000) throw new Error('goal reservation exceeds remaining tokens')
        reservedMaximums.push(maximum.tokens)
        return { id: ++reservationId, ...maximum }
      },
      reconcile: async (
        _reservation: { readonly id: number; readonly tokens: number; readonly costMicros: number },
        actual: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number; readonly costMicros: number }
      ) => {
        consumedTokens += actual.totalTokens
      },
      release: async (_reservation: { readonly id: number; readonly tokens: number; readonly costMicros: number }) => undefined,
      consumeTool: async () => undefined,
      unsettledExposure: { tokens: 0, costMicros: 0 }
    } satisfies NonNullable<AgentEngineRequest['dispatchBudget']>
    const engine = new AxAgentEngine(factory, actions)
    const result = await engine.execute(
      {
        ...request(new AbortController().signal),
        dispatchBudget,
        limits: { maxTokens: 64_000, maxTurns: 12, maxToolCalls: 32, maxOutputTokens: 4_000 }
      },
      { text: async () => undefined, event: async () => undefined }
    )
    expect(chat).toHaveBeenCalledTimes(3)
    expect(reservedMaximums).toHaveLength(3)
    expect(admittedTotals).toHaveLength(3)
    expect(admittedTotals.every(total => total <= 64_000)).toBe(true)
    expect(JSON.stringify(calls[1]?.chatPrompt)).toContain('A concise provider-facing search summary.')
    expect(JSON.stringify(calls[2]?.chatPrompt)).toContain('Budget evidence remains available.')
    expect(JSON.stringify(calls[2]?.chatPrompt)).not.toContain('review metadata')
    expect(JSON.stringify(calls[2]?.chatPrompt)).not.toContain('Internal review detail')
    expect(JSON.stringify(calls[2]?.chatPrompt)).not.toContain('internal-review-detail')
    expect(result).toMatchObject({
      inputTokens: 13_003,
      outputTokens: 54,
      totalTokens: 13_057,
      citations: [{ evidenceId: 'page:42:revision:1:section:1', kind: 'page', label: 'Budget Guide › Evidence', href: '/en/budget-guide#evidence' }]
    })
  })
  it('accepts a citation placed after sentence punctuation and rejects an uncited page answer', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'get-1', type: 'function', function: { name: 'wiki_get_page', params: '{"id":6}' } }] }] },
      { results: [{ index: 0, content: 'Amber Falcon.' }] },
      { results: [{ index: 0, content: 'Amber Falcon is a synthetic incident. [[cite:page:6:revision:1:section:1]]' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
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
    const invoke = vi.fn(async () => ({
      id: 6,
      sourceRevision: '1',
      title: 'Incident Runbook',
      contentType: 'markdown',
      content: '# Incident Runbook\n\nAmber Falcon is a synthetic incident.',
      citation: { evidenceId: 'page:6:revision:1', label: 'Incident Runbook', href: '/en/runbook' },
      citationSections: [{ evidenceId: 'page:6:revision:1:section:1', label: 'Incident Runbook', href: '/en/runbook#incident-runbook' }]
    }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Reads a page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn()
      })
    }
    const text = vi.fn(async () => {})
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    await new AxAgentEngine(factory, actions).execute(request(new AbortController().signal), { text, event })

    expect(chat).toHaveBeenCalledTimes(3)
    expect(text).toHaveBeenCalledWith('Amber Falcon is a synthetic incident. [[cite:page:6:revision:1:section:1]]')
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toEqual([
      expect.objectContaining({
        accepted: false,
        issues: ['A final answer following a successful page read must include at least one citation.']
      }),
      expect.objectContaining({
        accepted: true,
        issues: [],
        claims: [expect.objectContaining({ claim: 'Amber Falcon is a synthetic incident.', supported: true })]
      })
    ])
  })

  it('reuses identical page reads while preserving every model-requested action in diagnostics', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'get-1', type: 'function', function: { name: 'wiki_get_page', params: '{"id":6}' } }] }] },
      { results: [{ index: 0, functionCalls: [{ id: 'get-2', type: 'function', function: { name: 'wiki_get_page', params: '{"id":6}' } }] }] },
      { results: [{ index: 0, content: 'Amber Falcon is a synthetic incident.[[cite:page:6:revision:1:section:1]]' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
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
    const page = {
      id: 6,
      sourceRevision: '1',
      title: 'Incident Runbook',
      contentType: 'markdown',
      content: '# Incident Runbook\n\nAmber Falcon is a synthetic incident.',
      citation: { evidenceId: 'page:6:revision:1', label: 'Incident Runbook', href: '/en/runbook' },
      citationSections: [{ evidenceId: 'page:6:revision:1:section:1', label: 'Incident Runbook', href: '/en/runbook#incident-runbook' }]
    }
    const invoke = vi.fn(async () => page)
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Reads a page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn()
      })
    }
    const event = vi.fn(async (...args: [string, Record<string, unknown>]) => {
      void args
    })
    await new AxAgentEngine(factory, actions).execute(request(new AbortController().signal), { text: async () => {}, event })

    expect(invoke).toHaveBeenCalledOnce()
    expect(event.mock.calls.filter(([type]) => type === 'tool.started').map(([, data]) => data)).toEqual([
      expect.objectContaining({ actionCallId: 'get-1', turn: 1, input: '{"id":6}' }),
      expect.objectContaining({ actionCallId: 'get-2', turn: 2, input: '{"id":6}' })
    ])
    expect(event.mock.calls.filter(([type]) => type === 'tool.completed').map(([, data]) => data)).toEqual([
      expect.objectContaining({ actionCallId: 'get-1', cacheHit: false, reusedActionCallId: null, summary: 'Incident Runbook' }),
      expect.objectContaining({ actionCallId: 'get-2', cacheHit: true, reusedActionCallId: 'get-1', summary: 'Incident Runbook · Reused earlier read' })
    ])
    expect(event.mock.calls.filter(([type]) => type === 'model.turn').map(([, data]) => data)).toEqual([
      expect.objectContaining({ turn: 1, outcome: 'tool_calls', actionCallIds: ['get-1'] }),
      expect.objectContaining({ turn: 2, outcome: 'tool_calls', actionCallIds: ['get-2'] }),
      expect.objectContaining({ turn: 3, outcome: 'answer_accepted', actionCallIds: [] })
    ])
  })

  it('rejects search-result citations until the page is read and records grouped claim provenance', async () => {
    const providerCalls: Readonly<AxChatRequest<unknown>>[] = []
    const responses: AxChatResponse[] = [
      {
        results: [
          {
            index: 0,
            functionCalls: [
              { id: 'search-1', type: 'function', function: { name: 'wiki_search_pages', params: '{"query":"Amber Falcon","limit":10,"offset":0}' } }
            ]
          }
        ]
      },
      { results: [{ index: 0, content: 'Amber Falcon is a synthetic incident drill.[[cite:page:6:revision:1]]' }] },
      { results: [{ index: 0, functionCalls: [{ id: 'get-1', type: 'function', function: { name: 'wiki_get_page', params: '{"id":6}' } }] }] },
      {
        results: [
          {
            index: 0,
            content:
              'The Incident Runbook describes Amber Falcon as a synthetic incident drill[[cite:page:6:revision:1:section:1]] and gives the response sequence: confirm the alert and freeze deployments.[[cite:page:6:revision:1:section:2]]'
          }
        ]
      }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      providerCalls.push(input)
      return responses.shift()!
    })
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
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
    const invoke = vi.fn(async (name: string) =>
      name === 'pages.search'
        ? {
            results: [
              {
                id: 6,
                title: 'Incident Runbook',
                citation: { evidenceId: 'page:6:revision:1', label: 'Incident Runbook', href: '/en/agent-shakedown/incident-runbook' }
              }
            ]
          }
        : {
            id: 6,
            title: 'Incident Runbook',
            contentType: 'markdown',
            content: '# Incident Runbook\n\nAmber Falcon is a synthetic incident drill.\n\n## Response sequence\nConfirm the alert and freeze deployments.',
            citation: { evidenceId: 'page:6:revision:1', label: 'Incident Runbook', href: '/en/agent-shakedown/incident-runbook' },
            citationSections: [
              {
                evidenceId: 'page:6:revision:1:section:1',
                label: 'Incident Runbook',
                href: '/en/agent-shakedown/incident-runbook#incident-runbook'
              },
              {
                evidenceId: 'page:6:revision:1:section:2',
                label: 'Incident Runbook › Response sequence',
                href: '/en/agent-shakedown/incident-runbook#response-sequence'
              }
            ]
          }
    )
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          { name: 'pages.search', title: 'Search pages', description: 'Searches pages', parameters: { type: 'object', properties: {} }, risk: 'read' },
          { name: 'pages.get', title: 'Read page', description: 'Reads a page', parameters: { type: 'object', properties: {} }, risk: 'read' }
        ],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn()
      })
    }
    const text = vi.fn(async () => {})
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    const result = await new AxAgentEngine(factory, actions).execute(request(new AbortController().signal), { text, event })

    expect(chat).toHaveBeenCalledTimes(4)
    expect(text).toHaveBeenCalledOnce()
    expect(text).not.toHaveBeenCalledWith(expect.stringContaining('Amber Falcon is a synthetic incident drill.[[cite:page:6:revision:1]]'))
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(['pages.search', 'pages.get'])
    expect(providerCalls[2]?.chatPrompt).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('was not produced by a successful page read')
      })
    )
    const provenance = event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)
    expect(provenance).toHaveLength(2)
    expect(provenance[0]).toMatchObject({
      accepted: false,
      retrievals: [{ actionCallId: 'search-1', actionName: 'pages.search', evidenceIds: ['page:6:revision:1'] }],
      claims: [{ evidenceId: 'page:6:revision:1', pageEvidenceId: null, supported: false }]
    })
    expect(provenance[1]).toMatchObject({
      accepted: true,
      retrievals: [
        { actionCallId: 'search-1', actionName: 'pages.search', evidenceIds: ['page:6:revision:1'] },
        {
          actionCallId: 'get-1',
          actionName: 'pages.get',
          evidenceIds: ['page:6:revision:1', 'page:6:revision:1:section:1', 'page:6:revision:1:section:2']
        }
      ],
      claims: [
        expect.objectContaining({
          evidenceId: 'page:6:revision:1:section:1',
          pageEvidenceId: 'page:6:revision:1',
          supported: true
        }),
        expect.objectContaining({
          evidenceId: 'page:6:revision:1:section:2',
          pageEvidenceId: 'page:6:revision:1',
          supported: true
        })
      ],
      finalCitationIds: ['page:6:revision:1:section:1', 'page:6:revision:1:section:2']
    })
    expect(result.citations).toEqual([
      {
        evidenceId: 'page:6:revision:1:section:1',
        kind: 'page',
        label: 'Incident Runbook',
        href: '/en/agent-shakedown/incident-runbook#incident-runbook'
      },
      {
        evidenceId: 'page:6:revision:1:section:2',
        kind: 'page',
        label: 'Incident Runbook › Response sequence',
        href: '/en/agent-shakedown/incident-runbook#response-sequence'
      }
    ])
  })

  it('retains revision-scoped evidence for current, historical, and canonical OKF reads', async () => {
    const responses: AxChatResponse[] = [
      {
        results: [
          {
            index: 0,
            functionCalls: [
              { id: 'get-current', type: 'function', function: { name: 'wiki_get_page', params: '{"id":42}' } },
              {
                id: 'get-history',
                type: 'function',
                function: { name: 'wiki_get_page_version', params: '{"id":42,"versionId":"version-amber"}' }
              },
              {
                id: 'get-okf',
                type: 'function',
                function: { name: 'wiki_get_page_okf', params: '{"id":42,"versionId":"version-quartz"}' }
              }
            ]
          }
        ]
      },
      { results: [{ index: 0, content: 'Quartz migration was approved.[[cite:page:42:revision:30]]' }] },
      {
        results: [
          {
            index: 0,
            content:
              'Current Cobalt rollout is active.[[cite:page:42:revision:30:section:1]] Historical Amber rollback is archived.[[cite:page:42:revision:10:section:1]] Quartz migration was approved.[[cite:page:42:revision:20]]'
          }
        ]
      }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
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
    const invoke = vi.fn(async (name: string) => {
      if (name === 'pages.get') {
        return {
          id: 42,
          sourceRevision: '30',
          title: 'Guide',
          contentType: 'markdown',
          content: '# Guide\n\n## Current\nCobalt rollout is active.',
          citation: { evidenceId: 'page:42:revision:30', label: 'Guide', href: '/en/guide' },
          citationSections: [{ evidenceId: 'page:42:revision:30:section:1', label: 'Guide › Current', href: '/en/guide#current' }]
        }
      }
      if (name === 'pages.getVersion') {
        return {
          id: 42,
          versionId: 'version-amber',
          sourceRevision: '10',
          title: 'Guide',
          contentType: 'markdown',
          content: '# Guide\n\n## Historical\nAmber rollback is archived.',
          citation: { evidenceId: 'page:42:revision:10', label: 'Guide', href: '/en/guide?version=version-amber' },
          citationSections: [
            {
              evidenceId: 'page:42:revision:10:section:1',
              label: 'Guide › Historical',
              href: '/en/guide?version=version-amber#historical'
            }
          ]
        }
      }
      return {
        pageId: 42,
        versionId: 'version-quartz',
        sourceRevision: '20',
        resourceUri: 'wiki://pages/42/versions/version-quartz/revisions/20/okf',
        conceptId: 'wiki-page-42',
        filePath: 'guide.md',
        sha256: 'b'.repeat(64),
        mediaType: 'text/markdown',
        document: '---\ntitle: Guide\n---\n# Guide\n\nQuartz migration was approved.',
        authority: { state: 'valid', metadata: { title: 'Guide' }, trust: { verified: true } },
        knowledge: null,
        citation: { evidenceId: 'page:42:revision:20', label: 'Guide', href: '/en/guide?version=version-quartz' }
      }
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          { name: 'pages.get', title: 'Read page', description: 'Reads current page', parameters: { type: 'object', properties: {} }, risk: 'read' },
          {
            name: 'pages.getVersion',
            title: 'Read page version',
            description: 'Reads historical page',
            parameters: { type: 'object', properties: {} },
            risk: 'read'
          },
          {
            name: 'pages.getOkf',
            title: 'Read canonical OKF',
            description: 'Reads canonical exact-revision document',
            parameters: { type: 'object', properties: {} },
            risk: 'read'
          }
        ],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn()
      })
    }
    const text = vi.fn(async () => {})
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    const result = await new AxAgentEngine(factory, actions).execute(request(new AbortController().signal), { text, event })

    expect(chat).toHaveBeenCalledTimes(3)
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(['pages.get', 'pages.getVersion', 'pages.getOkf'])
    expect(text).toHaveBeenCalledWith(
      'Current Cobalt rollout is active.[[cite:page:42:revision:30:section:1]] Historical Amber rollback is archived.[[cite:page:42:revision:10:section:1]] Quartz migration was approved.[[cite:page:42:revision:20]]'
    )
    const provenance = event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)
    expect(provenance).toHaveLength(2)
    expect(provenance[0]).toMatchObject({
      accepted: false,
      issues: ['Citation page:42:revision:30 does not lexically support its immediately preceding claim.'],
      claims: [
        expect.objectContaining({
          evidenceId: 'page:42:revision:30',
          pageEvidenceId: 'page:42:revision:30',
          sourceActionName: 'pages.get',
          supported: false
        })
      ]
    })
    expect(provenance[1]).toMatchObject({
      accepted: true,
      retrievals: [
        {
          actionCallId: 'get-current',
          actionName: 'pages.get',
          evidenceIds: ['page:42:revision:30', 'page:42:revision:30:section:1']
        },
        {
          actionCallId: 'get-history',
          actionName: 'pages.getVersion',
          evidenceIds: ['page:42:revision:10', 'page:42:revision:10:section:1']
        },
        { actionCallId: 'get-okf', actionName: 'pages.getOkf', evidenceIds: ['page:42:revision:20'] }
      ],
      claims: [
        expect.objectContaining({
          evidenceId: 'page:42:revision:30:section:1',
          pageEvidenceId: 'page:42:revision:30',
          sourceActionName: 'pages.get',
          supported: true
        }),
        expect.objectContaining({
          evidenceId: 'page:42:revision:10:section:1',
          pageEvidenceId: 'page:42:revision:10',
          sourceActionName: 'pages.getVersion',
          supported: true
        }),
        expect.objectContaining({
          evidenceId: 'page:42:revision:20',
          pageEvidenceId: 'page:42:revision:20',
          sourceActionName: 'pages.getOkf',
          supported: true
        })
      ],
      finalCitationIds: ['page:42:revision:30:section:1', 'page:42:revision:10:section:1', 'page:42:revision:20']
    })
    expect(result.citations).toEqual([
      { evidenceId: 'page:42:revision:30:section:1', kind: 'page', label: 'Guide › Current', href: '/en/guide#current' },
      {
        evidenceId: 'page:42:revision:10:section:1',
        kind: 'page',
        label: 'Guide › Historical',
        href: '/en/guide?version=version-amber#historical'
      },
      { evidenceId: 'page:42:revision:20', kind: 'page', label: 'Guide', href: '/en/guide?version=version-quartz' }
    ])
  })
  it('requires exact field-bound Unicode title proof and rejects altered or mismatched assertions', async () => {
    const runTitleCase = async (input: {
      readonly actionName: 'pages.get' | 'pages.getVersion'
      readonly title: string
      readonly sourceRevision: string
      readonly answer: string
      readonly citationId?: string
      readonly citationSections?: readonly Readonly<Record<string, string>>[]
    }) => {
      const citationId = input.citationId ?? `page:42:revision:${input.sourceRevision}`
      const providerName = input.actionName === 'pages.get' ? 'wiki_get_page' : 'wiki_get_page_version'
      const responses: AxChatResponse[] = [
        {
          results: [
            {
              index: 0,
              functionCalls: [
                {
                  id: 'title-read',
                  type: 'function',
                  function: { name: providerName, params: input.actionName === 'pages.get' ? '{"id":42}' : '{"id":42,"versionId":9}' }
                }
              ]
            }
          ]
        },
        { results: [{ index: 0, content: `${input.answer}[[cite:${citationId}]]` }] }
      ]
      const chat = vi.fn(async () => responses.shift()!)
      const factory = {
        create: async () => ({
          service: { chat },
          capabilities: {
            streaming: false,
            toolCalling: 'native',
            parallelToolCalls: true,
            structuredOutput: 'native-json-schema',
            usage: 'estimated',
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
      const invoke = vi.fn(async () => ({
        id: 42,
        locale: 'en',
        path: 'home',
        sourceRevision: input.sourceRevision,
        title: input.title,
        contentType: 'markdown',
        content: `# ${input.title}\n\nThe page is available.`,
        citation: { evidenceId: citationId, label: input.title, href: '/en/home' },
        citationSections: input.citationSections ?? []
      }))
      const close = vi.fn()
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            {
              name: input.actionName,
              title: 'Read page',
              description: 'Reads a page',
              parameters: { type: 'object', properties: {} },
              risk: 'read'
            }
          ],
          invoke,
          snapshot: async () => ({}),
          close
        })
      }
      const text = vi.fn(async () => {})
      const event = vi.fn(async (...args: [string, unknown]) => {
        void args
      })
      const currentPage = { id: 42, locale: 'en', path: 'home', observedUpdatedAt: '2026-08-17T00:00:00.000Z' }
      let result: unknown
      let error: unknown
      try {
        result = await new AxAgentEngine(factory, actions).execute(
          {
            ...request(new AbortController().signal),
            currentPage,
            limits: { maxTurns: 2, maxToolCalls: 1, maxOutputTokens: 2_000 }
          },
          { text, event }
        )
      } catch (caught) {
        error = caught
      }
      return { result, error, text, event, invoke, close }
    }

    const accepted = await runTitleCase({
      actionName: 'pages.get',
      title: 'Homepage |🏘️',
      sourceRevision: '7',
      answer: 'The current page title is **Homepage |🏘️**.'
    })
    expect(accepted.error).toBeUndefined()
    expect(accepted.text).toHaveBeenCalledWith('The current page title is **Homepage |🏘️**.[[cite:page:42:revision:7]]')
    expect(accepted.result).toMatchObject({ citations: [{ evidenceId: 'page:42:revision:7' }] })

    const suffix = 'The current page title is Homepage |🏘️.'
    const oversizedTailAttack = `The current page title is WRONG ${'x'.repeat(4_100)}${suffix}`
    for (const answer of [
      'The current page title is **Homepage |🏠**.',
      'The current page title is Homepage.',
      'The current page title is Homepage |🏘️ and deployment is safe.',
      'The current page title is not Homepage |🏘️.',
      'The page title is Homepage |🏘️!!',
      'The page title is Homepage |🏘️?!',
      '**The page title is Homepage |🏘️**.',
      '- The page title is Homepage |🏘️.',
      'Deployment Guide |🏠 is the title.',
      oversizedTailAttack
    ]) {
      const rejected = await runTitleCase({ actionName: 'pages.get', title: 'Homepage |🏘️', sourceRevision: '7', answer })
      expect(rejected.error).toMatchObject({
        code: 'AGENT_EVIDENCE_INVALID',
        stage: 'provider_response',
        status: 409,
        message: 'Agent inference failed'
      })
      expect(rejected.text).not.toHaveBeenCalled()
    }

    const historical = await runTitleCase({
      actionName: 'pages.getVersion',
      title: 'Archive |📦',
      sourceRevision: '6',
      answer: 'The page’s title is “Archive |📦”.'
    })
    expect(historical.error).toBeUndefined()
    expect(historical.text).toHaveBeenCalledWith('The page’s title is “Archive |📦”.[[cite:page:42:revision:6]]')
    const semanticCurrent = await runTitleCase({
      actionName: 'pages.get',
      title: 'Homepage |🏘️',
      sourceRevision: '12',
      answer: 'The current page is titled Homepage |🏘️.'
    })
    expect(semanticCurrent.error).toBeUndefined()

    const semanticCurrentNamed = await runTitleCase({
      actionName: 'pages.get',
      title: 'Homepage |🏘️',
      sourceRevision: '13',
      answer: 'The current page is named Homepage |🏘️.'
    })
    expect(semanticCurrentNamed.error).toBeUndefined()

    const semanticWrongEmoji = await runTitleCase({
      actionName: 'pages.get',
      title: 'Homepage |🏘️',
      sourceRevision: '14',
      answer: 'The current page is titled Homepage |🏠.'
    })
    expect(semanticWrongEmoji.error).toMatchObject({ code: 'AGENT_EVIDENCE_INVALID', stage: 'provider_response' })

    const semanticHistorical = await runTitleCase({
      actionName: 'pages.getVersion',
      title: 'Archive |📦',
      sourceRevision: '15',
      answer: 'The page is titled Archive |📦.'
    })
    expect(semanticHistorical.error).toBeUndefined()

    const semanticHistoricalAsCurrent = await runTitleCase({
      actionName: 'pages.getVersion',
      title: 'Archive |📦',
      sourceRevision: '15',
      answer: 'The current page is named Archive |📦.'
    })
    expect(semanticHistoricalAsCurrent.error).toMatchObject({ code: 'AGENT_EVIDENCE_INVALID', stage: 'provider_response' })

    const punctuation = await runTitleCase({
      actionName: 'pages.get',
      title: 'Runbook v2.0 — Hello. World',
      sourceRevision: '8',
      answer: 'The page title is "Runbook v2.0 — Hello. World".'
    })
    const collapsedWhitespace = await runTitleCase({
      actionName: 'pages.get',
      title: 'Alpha Beta',
      sourceRevision: '9',
      answer: 'The page title is Alpha   Beta.'
    })
    expect(collapsedWhitespace.error).toMatchObject({ code: 'AGENT_EVIDENCE_INVALID', stage: 'provider_response' })

    const repeatedWhitespace = await runTitleCase({
      actionName: 'pages.get',
      title: 'Alpha   Beta',
      sourceRevision: '10',
      answer: 'The page title is Alpha   Beta.'
    })
    expect(repeatedWhitespace.error).toBeUndefined()

    for (const [title, answer] of [
      ['Title', 'The page title is **Title!**.'],
      ['Title!', 'The page title is Title!!'],
      ['What?', 'The page title is What?!']
    ] as const) {
      const rejected = await runTitleCase({ actionName: 'pages.get', title, sourceRevision: '11', answer })
      expect(rejected.error).toMatchObject({ code: 'AGENT_EVIDENCE_INVALID', stage: 'provider_response' })
    }
    expect(punctuation.error).toBeUndefined()
    expect(punctuation.text).toHaveBeenCalledWith('The page title is "Runbook v2.0 — Hello. World".[[cite:page:42:revision:8]]')

    const historicalAsCurrent = await runTitleCase({
      actionName: 'pages.getVersion',
      title: 'Archive |📦',
      sourceRevision: '6',
      answer: 'The current page title is Archive |📦.'
    })
    expect(historicalAsCurrent.error).toMatchObject({ code: 'AGENT_EVIDENCE_INVALID', stage: 'provider_response' })

    const sectionCitation = await runTitleCase({
      actionName: 'pages.get',
      title: 'Homepage |🏘️',
      sourceRevision: '7',
      answer: 'The page title is Homepage |🏘️.',
      citationId: 'page:42:revision:7:section:1',
      citationSections: [{ evidenceId: 'page:42:revision:7:section:1', label: 'Homepage', href: '/en/home#homepage' }]
    })
    expect(sectionCitation.error).toMatchObject({ code: 'AGENT_EVIDENCE_INVALID', stage: 'provider_response' })
  })


  it('regenerates a cross-section attribution that does not support the associated claim', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'get-1', type: 'function', function: { name: 'wiki_get_page', params: '{"id":6}' } }] }] },
      {
        results: [
          {
            index: 0,
            content:
              'Amber Falcon is a synthetic incident and its response sequence confirms alerts, freezes deployments, and drains the queue.[[cite:page:6:revision:1:section:2]]'
          }
        ]
      },
      { results: [{ index: 0, content: 'Amber Falcon is a synthetic incident drill.[[cite:page:6:revision:1:section:1]]' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
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
    const invoke = vi.fn(async () => ({
      id: 6,
      title: 'Incident Runbook',
      contentType: 'markdown',
      content:
        '# Incident Runbook\n\nAmber Falcon is a synthetic incident drill.\n\n## Response sequence\nConfirm alerts, freeze deployments, and drain the queue.',
      citation: { evidenceId: 'page:6:revision:1', label: 'Incident Runbook', href: '/en/runbook' },
      citationSections: [
        { evidenceId: 'page:6:revision:1:section:1', label: 'Incident Runbook', href: '/en/runbook#incident-runbook' },
        { evidenceId: 'page:6:revision:1:section:2', label: 'Incident Runbook › Response sequence', href: '/en/runbook#response-sequence' }
      ]
    }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Reads a page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn()
      })
    }
    const text = vi.fn(async () => {})
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    const result = await new AxAgentEngine(factory, actions).execute(request(new AbortController().signal), { text, event })

    expect(chat).toHaveBeenCalledTimes(3)
    expect(text).toHaveBeenCalledOnce()
    expect(text).toHaveBeenCalledWith('Amber Falcon is a synthetic incident drill.[[cite:page:6:revision:1:section:1]]')
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toEqual([
      expect.objectContaining({
        accepted: false,
        issues: ['Citation page:6:revision:1:section:2 does not lexically support its immediately preceding claim.'],
        claims: [expect.objectContaining({ evidenceId: 'page:6:revision:1:section:2', supported: false })]
      }),
      expect.objectContaining({
        accepted: true,
        claims: [expect.objectContaining({ evidenceId: 'page:6:revision:1:section:1', supported: true })],
        finalCitationIds: ['page:6:revision:1:section:1']
      })
    ])
    expect(result.citations).toEqual([
      { evidenceId: 'page:6:revision:1:section:1', kind: 'page', label: 'Incident Runbook', href: '/en/runbook#incident-runbook' }
    ])
  })

  it('withholds unsupported verification language until the draft removes it', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, content: 'I verified it: Amber Falcon is a synthetic incident.' }] },
      { results: [{ index: 0, content: 'I do not have read evidence for that claim.' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: true,
          toolCalling: 'native',
          parallelToolCalls: false,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
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
    const text = vi.fn(async () => {})
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    await new AxAgentEngine(factory).execute(request(new AbortController().signal), { text, event })

    expect(chat).toHaveBeenCalledTimes(2)
    expect(text).toHaveBeenCalledOnce()
    expect(text).toHaveBeenCalledWith('I do not have read evidence for that claim.')
    expect(text).not.toHaveBeenCalledWith(expect.stringContaining('I verified it'))
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toEqual([
      expect.objectContaining({ accepted: false, issues: ['Source-verification language requires a successful page read and an associated citation.'] }),
      expect.objectContaining({ accepted: true, issues: [] })
    ])
  })

  it('loads the visible skill catalog before the model chooses task actions', async () => {
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return { results: [{ index: 0, content: 'Ready.' }] }
    })
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
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
    const invoke = vi.fn(async (name: string) =>
      name === 'skills.list'
        ? {
            skills: [
              {
                name: 'wiki-authoring',
                description: 'Create and edit compatible Wiki pages',
                versionId: '00000000-0000-4000-8000-000000000009',
                contentHash: 'b'.repeat(64)
              }
            ]
          }
        : {}
    )
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          { name: 'skills.list', title: 'List skills', description: 'Lists visible skills', parameters: { type: 'object', properties: {} }, risk: 'read' },
          { name: 'skills.read', title: 'Read skill', description: 'Reads one skill', parameters: { type: 'object', properties: {} }, risk: 'read' }
        ],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn()
      })
    }

    await new AxAgentEngine(factory, actions).execute(request(new AbortController().signal), { text: async () => {}, event: async () => {} })

    expect(invoke).toHaveBeenCalledWith('skills.list', {}, expect.objectContaining({ aborted: false }), 'skill-catalog-bootstrap')
    expect(calls[0]?.functions).toContainEqual(expect.objectContaining({ name: 'wiki_read_skill' }))
    const system = calls[0]?.chatPrompt.find(message => message.role === 'system')
    expect(system?.content).toContain('"name":"wiki-authoring"')
    expect(system?.content).toContain('load an applicable skill')
    expect(system?.content).toContain('very next action must be wiki_apply_page_proposal')
    expect(system?.content).toContain('[[cite:EVIDENCE_ID]]')
    expect(system?.content).toContain('candidate metadata, not read evidence')
    expect(system?.content).toContain('group them into one readable sentence or paragraph')
    expect(system?.content).toContain('authoritative Open Knowledge Format metadata is revision-bound source authority')
    expect(system?.content).toContain('missing or invalid authority remains explicit')
    expect(system?.content).toContain('visibly separate from the derived KnowledgeProjectionView utility projection')
    expect(system?.content).toContain('wiki_get_page_okf')
    expect(system?.content).toContain('lossless interoperability or a memory read')
    expect(system?.content).toContain('canonical document for an exact source revision')
  })

  it('emulates one strict tool call for providers without native tools', async () => {
    const providerCalls: Readonly<AxChatRequest<unknown>>[] = []
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, content: '<wiki-tool-call>{"name":"wiki_get_page","arguments":{"id":42}}</wiki-tool-call>' }] },
      { results: [{ index: 0, content: 'The page is ready.' }] }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      providerCalls.push(input)
      return responses.shift()!
    })
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'prompt',
          parallelToolCalls: false,
          structuredOutput: 'prompt-only',
          usage: 'estimated',
          cancellation: true,
          maxContextTokens: 12_000,
          maxOutputTokens: 1_000
        },
        transportKind: 'legacy-completions',
        model: 'text-test',
        capabilityRevision: 'cap-2',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const invoke = vi.fn(async () => ({ id: 42, title: 'Guide' }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.get',
            title: 'Read page',
            description: 'Reads a page',
            parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
            risk: 'read'
          }
        ],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn()
      })
    }
    const text = vi.fn(async () => {})

    await new AxAgentEngine(factory, actions).execute(request(new AbortController().signal), { text, event: async () => {} })

    expect(providerCalls[0]).not.toHaveProperty('functions')
    expect(providerCalls[0]?.chatPrompt[0]).toEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('strict text tool protocol') }))
    expect(providerCalls[0]?.chatPrompt[0]).toEqual(expect.objectContaining({ content: expect.stringContaining('"name":"wiki_get_page"') }))
    expect(invoke).toHaveBeenCalledWith('pages.get', { id: 42 }, expect.objectContaining({ aborted: false }), expect.any(String))
    expect(providerCalls[1]?.chatPrompt).toContainEqual({
      role: 'assistant',
      content: '<wiki-tool-call>{"name":"wiki_get_page","arguments":{"id":42}}</wiki-tool-call>'
    })
    expect(providerCalls[1]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'user', content: expect.stringContaining('<wiki-tool-result>') }))
    expect(providerCalls[1]?.chatPrompt.some(message => message.role === 'function')).toBe(false)
    expect(text).toHaveBeenCalledOnce()
    expect(text).toHaveBeenCalledWith('The page is ready.')
  })

  it('resumes one reclaimed pre-fence approval action identity and feeds its durable result back into synthesis', async () => {
    let providerContent = 'The reclaimed page was created.'
    let providerFailure = false
    const providerCalls: Readonly<AxChatRequest<unknown>>[] = []
    const create = vi.fn(async () => ({
      service: {
        chat: async (input: Readonly<AxChatRequest<unknown>>) => {
          if (providerFailure) throw new Error('synthesis transport failed')
          providerCalls.push(input)
          return {
            results: [{ index: 0, content: providerContent }],
            modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } }
          }
        }
      },
      capabilities: {
        streaming: false,
        toolCalling: 'native' as const,
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema' as const,
        usage: 'terminal' as const,
        cancellation: true,
        maxContextTokens: 100_000,
        maxOutputTokens: 4_000
      },
      transportKind: 'openai-responses' as const,
      model: 'gpt-test',
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1',
      pricing
    }))
    const factory = { create } as unknown as AgentProviderFactory
    const proposalIds = new Set<string>()
    const apply = vi.fn(async () => {})
    const invokedLeases: AgentRunLeaseIdentity[] = []
    const invoke = vi.fn(async (_actionName: string, _input: unknown, invocationSignal: AbortSignal, _actionCallId: string) => {
      const invocationLease = invokingAgentRunLease(invocationSignal)
      if (invocationLease === null) throw new Error('continued action invocation must retain its captured run lease identity')
      invokedLeases.push(invocationLease)
      proposalIds.add('00000000-0000-4000-8000-000000000010')
      await apply()
      return {
        proposalId: '00000000-0000-4000-8000-000000000010',
        approvalId: '00000000-0000-4000-8000-000000000011',
        actionName: 'pages.prepareCreate',
        status: 'applied',
        inputHash: 'b'.repeat(64),
        diffHash: null,
        summary: 'Create en/reclaimed',
        expiresAt: '2026-08-17T00:15:00.000Z'
      }
    })
    const close = vi.fn()
    let actionAuthoritySha256 = 'c'.repeat(64)
    const open = vi.fn(async () => ({
      authoritySha256: actionAuthoritySha256,
      functions: [
        {
          name: 'pages.prepareCreate',
          title: 'Prepare page',
          description: 'Prepares a page proposal',
          parameters: { type: 'object', properties: {} },
          risk: 'proposal' as const
        }
      ],
      invoke,
      snapshot: async () => ({}),
      close
    }))
    const actions: AgentActionSessionProvider = { open }
    const signal = new AbortController().signal
    const initial = request(signal)
    const resumed = {
      ...initial,
      purpose: 'root' as const,
      run: { ...initial.run, status: 'running' as const, leaseOwner: 'worker-2', leaseToken: '00000000-0000-4000-8000-000000000012' }
    }
    const actionInput = {
      path: 'reclaimed',
      locale: 'en',
      title: 'Reclaimed',
      description: '',
      content: '# Reclaimed',
      contentType: 'markdown',
      isPublished: true,
      tags: []
    }
    const checkpointBody: Omit<AgentApprovalContinuationCheckpoint, 'checkpointSha256'> = {
      version: 1,
      runId: resumed.run.id,
      ownerId: resumed.run.ownerId,
      attempt: resumed.run.attempts,
      actionCallId: 'proposal-call-1',
      actionName: 'pages.prepareCreate',
      actionInput,
      actionInputSha256: createHash('sha256').update(canonicalJson(actionInput)).digest('hex'),
      proposalId: '00000000-0000-4000-8000-000000000010',
      approvalId: '00000000-0000-4000-8000-000000000011',
      proposalInputHash: 'b'.repeat(64),
      authorityVersion: 1,
      authoritySha256: actionAuthoritySha256
    }
    const checkpoint: AgentApprovalContinuationCheckpoint = {
      ...checkpointBody,
      checkpointSha256: createHash('sha256').update(canonicalJson(checkpointBody)).digest('hex')
    }
    const event = vi.fn(async () => {})
    const text = vi.fn(async () => {})
    const sink = { text, event }
    const engine = new AxAgentEngine(factory, actions)

    await expect(
      engine.resumeAction(
        {
          ...resumed,
          run: { ...resumed.run, ownerId: resumed.run.ownerId + 1 }
        },
        checkpoint,
        sink
      )
    ).rejects.toMatchObject({ code: 'AGENT_ACTION_CONTINUATION_MISMATCH', status: 409 })
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()

    actionAuthoritySha256 = 'e'.repeat(64)
    await expect(engine.resumeAction(resumed, checkpoint, sink)).rejects.toMatchObject({ code: 'AGENT_ACTION_CONTINUATION_MISMATCH', status: 409 })
    expect(open).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    open.mockClear()
    close.mockClear()
    actionAuthoritySha256 = checkpoint.authoritySha256
    invoke.mockRejectedValueOnce(new Error('continued action invocation failed'))
    await expect(engine.resumeAction(resumed, checkpoint, sink)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED', status: 502 })
    expect(open).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    open.mockClear()
    invoke.mockClear()
    close.mockClear()

    await expect(engine.resumeAction(resumed, checkpoint, sink)).resolves.toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      costMicros: 11
    })

    expect(open).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('pages.prepareCreate', checkpoint.actionInput, signal, 'proposal-call-1')
    expect(proposalIds).toEqual(new Set([checkpoint.proposalId]))
    expect(apply).toHaveBeenCalledOnce()
    expect(invokedLeases).toEqual([
      {
        id: resumed.run.id,
        ownerId: resumed.run.ownerId,
        attempts: resumed.run.attempts,
        leaseOwner: resumed.run.leaseOwner,
        leaseToken: resumed.run.leaseToken
      }
    ])
    expect(invokingAgentRunLease(signal)).toBeNull()
    expect(event.mock.calls.map(([type]) => type)).toEqual(['tool.completed', 'model.turn', 'evidence.provenance'])
    const completed = event.mock.calls.find(([type]) => type === 'tool.completed')?.[1] as { result: string } | undefined
    expect(completed).toBeDefined()
    expect(JSON.parse(completed!.result)).toMatchObject({ proposalId: checkpoint.proposalId, status: 'applied' })
    expect(JSON.parse(completed!.result).status).not.toBe('recovery_required')
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0]?.chatPrompt).toContainEqual({
      role: 'assistant',
      functionCalls: [
        {
          id: checkpoint.actionCallId,
          type: 'function',
          function: { name: 'wiki_prepare_page_create', params: canonicalJson(checkpoint.actionInput) }
        }
      ]
    })
    expect(providerCalls[0]?.chatPrompt).toContainEqual(
      expect.objectContaining({
        role: 'function',
        functionId: checkpoint.actionCallId,
        result: expect.stringContaining(`"proposalId":"${checkpoint.proposalId}"`)
      })
    )
    expect(text).toHaveBeenCalledWith('The reclaimed page was created.')
    expect(close).toHaveBeenCalledTimes(2)

    providerContent = ''
    text.mockClear()
    event.mockClear()
    await expect(engine.resumeAction(resumed, checkpoint, sink)).rejects.toMatchObject({
      code: 'AGENT_ACTION_RECOVERY_REQUIRED',
      status: 409
    })
    expect(text).not.toHaveBeenCalled()
    expect(event.mock.calls.map(([type]) => type)).toEqual(['tool.completed', 'model.turn', 'evidence.provenance'])

    providerContent = 'unused'
    providerFailure = true
    event.mockClear()
    await expect(engine.resumeAction(resumed, checkpoint, sink)).rejects.toMatchObject({
      code: 'AGENT_ACTION_RECOVERY_REQUIRED',
      status: 409
    })
    expect(event.mock.calls.map(([type]) => type)).toEqual(['tool.completed'])
  })

  it('fails closed when a generation-only provider emits a tool call', async () => {
    const factory = {
      create: async () => ({
        service: {
          chat: async () => ({ results: [{ index: 0, functionCalls: [{ id: 'call-1', type: 'function', function: { name: 'pages.get', params: '{}' } }] }] })
        },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: false,
          structuredOutput: 'tool-result',
          usage: 'estimated',
          cancellation: true,
          maxContextTokens: 10_000,
          maxOutputTokens: 1_000
        },
        transportKind: 'openai-chat',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const invoke = vi.fn(async () => ({}))
    const open = vi.fn(async () => ({
      functions: [{ name: 'pages.get', title: 'Read page', description: 'Reads a page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
      invoke,
      snapshot: async () => ({}),
      close: vi.fn(),
      authoritySha256: null
    }))
    const actions = { open } as unknown as AgentActionSessionProvider
    const input = request(new AbortController().signal)
    const generationOnly = { ...input, run: { ...input.run, executionMode: 'generation-only' } }
    const text = vi.fn(async () => {})
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    await expect(new AxAgentEngine(factory, actions).execute(generationOnly, { text, event })).rejects.toMatchObject({
      code: 'UNEXPECTED_PROVIDER_TOOL_CALL'
    })
    expect(open).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(event).not.toHaveBeenCalled()
  })

  it('aborts a blocked provider when the host deadline signal fires', async () => {
    const deadline = new AbortController()
    let providerStarted: () => void = () => undefined
    const started = new Promise<void>(resolve => {
      providerStarted = resolve
    })
    const chat = vi.fn(async (_input: unknown, options?: { abortSignal?: AbortSignal }) => {
      providerStarted()
      return new Promise<never>((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => reject(options.abortSignal!.reason), { once: true })
      })
    })
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: false,
          structuredOutput: 'tool-result',
          usage: 'estimated',
          cancellation: true,
          maxContextTokens: 10_000,
          maxOutputTokens: 1_000
        },
        transportKind: 'openai-chat',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const execution = new AxAgentEngine(factory).execute(request(deadline.signal), { text: async () => {}, event: async () => {} })
    await started
    deadline.abort(new Error('goal deadline reached'))

    await expect(execution).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' })
    expect(chat).toHaveBeenCalledOnce()
  })
  it('keeps only a contiguous newest conversation suffix within provider capacity and rejects an irreducibly oversized latest turn', async () => {
    const chat = vi.fn(
      async (_input: Readonly<AxChatRequest<unknown>>) =>
        ({
          results: [{ index: 0, content: 'Bounded answer.' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 7, completionTokens: 2, totalTokens: 9 } }
        }) satisfies AxChatResponse
    )
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: false,
          structuredOutput: 'tool-result',
          usage: 'terminal',
          cancellation: true,
          maxContextTokens: 24_000,
          maxOutputTokens: 1_000
        },
        transportKind: 'openai-chat',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const input = request(new AbortController().signal)
    const messages = [
      { role: 'user' as const, content: 'older context that would fit' },
      { role: 'assistant' as const, content: 'older answer' },
      { role: 'user' as const, content: `omitted recent context:${'x'.repeat(16_000)}` },
      { role: 'assistant' as const, content: 'omitted recent answer' },
      { role: 'user' as const, content: 'latest user turn' }
    ]
    const boundedRequest: AgentEngineRequest = {
      ...input,
      run: { ...input.run, executionMode: 'generation-only' },
      messages,
      limits: { maxTurns: 1, maxToolCalls: 0, maxOutputTokens: 1_000 },
      priorActivity: [
        { runId: 'older', status: 'succeeded', userMessageOrdinal: 1, assistantMessageOrdinal: 2, modelTurns: 1, rejectedEvidenceDrafts: 0, tools: [] },
        { runId: 'newer', status: 'succeeded', userMessageOrdinal: 3, assistantMessageOrdinal: 4, modelTurns: 1, rejectedEvidenceDrafts: 0, tools: [] }
      ]
    }

    await new AxAgentEngine(factory).execute(boundedRequest, { text: async () => {}, event: async () => {} })

    const providerRequest = chat.mock.calls[0]?.[0] as AxChatRequest<unknown>
    expect(Buffer.byteLength(JSON.stringify(providerRequest), 'utf8')).toBeLessThanOrEqual(23_000)
    expect(providerRequest.chatPrompt).toContainEqual(expect.objectContaining({ role: 'user', content: 'latest user turn' }))
    expect(providerRequest.chatPrompt).not.toContainEqual(expect.objectContaining({ role: 'user', content: 'older context that would fit' }))
    expect(providerRequest.chatPrompt).not.toContainEqual(
      expect.objectContaining({ role: 'user', content: expect.stringContaining('omitted recent context:') })
    )
    const systemContent = String(providerRequest.chatPrompt?.[0]?.content)
    expect(systemContent.indexOf('"runId":"older"')).toBeLessThan(systemContent.indexOf('"runId":"newer"'))

    chat.mockClear()
    await expect(
      Promise.resolve(
        new AxAgentEngine(factory).execute(
          { ...boundedRequest, messages: [{ role: 'user', content: 'x'.repeat(24_000) }] },
          { text: async () => {}, event: async () => {} }
        )
      )
    ).rejects.toMatchObject({
      code: 'AGENT_CONTEXT_TOO_LARGE',
      status: 413
    })
    expect(chat).not.toHaveBeenCalled()
  })
  it('uses cumulative streamed usage maxima without double-counting chunks', async () => {
    const stream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'A' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 100, totalTokens: 103 } }
        })
        controller.enqueue({
          results: [{ index: 0, content: 'B' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 200, totalTokens: 500 } }
        })
        controller.enqueue({
          results: [{ index: 0, content: 'C' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 4_580 } }
        })
        controller.close()
      }
    })
    const chat = vi.fn(async () => stream)
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: true,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'stream',
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
    const text = vi.fn(async (_delta: string) => {})
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })

    const result = await new AxAgentEngine(factory).execute({ ...request(new AbortController().signal), purpose: 'planner' }, { text, event })

    expect(text.mock.calls.map(([delta]) => delta).join('')).toBe('ABC')
    expect(result).toMatchObject({ inputTokens: 3, outputTokens: 309, totalTokens: 4_580, costMicros: 9_157 })
    expect(event).toHaveBeenCalledWith('model.turn', expect.objectContaining({ usageVersion: 2, inputTokens: 3, outputTokens: 309, totalTokens: 4_580 }))
  })

  it('presents only the validated streamed draft in bounded deltas whose concatenation is final content', async () => {
    const rejected = 'Unsupported claim. [[cite:missing]]'
    const accepted = 'Validated answer. '.repeat(1_000)
    let cancelCalls = 0
    const streamed = (content: string, inputTokens: number, outputTokens: number): ReadableStream<AxChatResponse> =>
      new ReadableStream<AxChatResponse>({
        start(controller) {
          for (let index = 0; index < content.length; index++) {
            controller.enqueue({
              results: [{ index: 0, content: content[index] }],
              ...(index + 1 === content.length
                ? {
                    modelUsage: {
                      ai: 'test',
                      model: 'gpt-test',
                      tokens: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens }
                    }
                  }
                : {})
            })
          }
          controller.close()
        },
        cancel() {
          cancelCalls += 1
        }
      })
    const responses = [streamed(rejected, 5, 2), streamed(accepted, 8, 4)]
    const chat = vi.fn(async () => responses.shift()!)
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: true,
          toolCalling: 'native',
          parallelToolCalls: false,
          structuredOutput: 'tool-result',
          usage: 'stream',
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
    const text = vi.fn(async (_delta: string) => {})
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    const input = request(new AbortController().signal)

    const result = await new AxAgentEngine(factory).execute({ ...input, run: { ...input.run, executionMode: 'generation-only' } }, { text, event })
    expect(cancelCalls).toBe(0)

    const deltas = text.mock.calls.map(([delta]) => delta)
    expect(deltas.join('')).toBe(accepted)
    expect(deltas.join('')).not.toContain(rejected)
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.length).toBeLessThanOrEqual(64)
    expect(deltas.every(delta => delta.length <= 16_000)).toBe(true)
    expect(event.mock.calls.filter(([type]) => type === 'model.turn').map(([, data]) => data)).toEqual([
      expect.objectContaining({ outcome: 'answer_rejected', content: rejected }),
      expect.objectContaining({ outcome: 'answer_accepted', content: accepted.slice(0, 32_000) })
    ])
    expect(result).toMatchObject({ inputTokens: 13, outputTokens: 6, totalTokens: 19 })
  })
  it.each(['native', 'prompt'] as const)('keeps core tools available and unlocks one frozen category on the next %s turn', async mode => {
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const events: Array<readonly [string, unknown]> = []
    const responses: AxChatResponse[] =
      mode === 'native'
        ? [
            {
              results: [
                {
                  index: 0,
                  functionCalls: [
                    {
                      id: 'enable-explore',
                      function: { name: 'wiki_enable_tools', params: { category: 'explore' } }
                    }
                  ]
                }
              ]
            },
            {
              results: [
                {
                  index: 0,
                  functionCalls: [
                    {
                      id: 'search-tags',
                      function: { name: 'wiki_search_tags', params: { query: 'alpha', limit: 1 } }
                    }
                  ]
                }
              ]
            },
            { results: [{ index: 0, content: 'The category lookup is complete.' }] }
          ]
        : [
            { results: [{ index: 0, content: '<wiki-tool-call>{"name":"wiki_enable_tools","arguments":{"category":"explore"}}</wiki-tool-call>' }] },
            {
              results: [
                {
                  index: 0,
                  content: '<wiki-tool-call>{"name":"wiki_search_tags","arguments":{"query":"alpha","limit":1}}</wiki-tool-call>'
                }
              ]
            },
            { results: [{ index: 0, content: 'The category lookup is complete.' }] }
          ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return responses.shift()!
    })
    const functions = Object.freeze([
      Object.freeze({
        name: 'pages.get' as const,
        title: 'Read page',
        description: 'Read one page',
        parameters: { type: 'object', properties: { id: { type: 'number' } } },
        risk: 'read',
        group: 'core' as const
      }),
      Object.freeze({
        name: 'pages.searchTags' as const,
        title: 'Search tags',
        description: 'Search visible tags',
        parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
        risk: 'read',
        group: 'explore' as const
      })
    ])
    const invoke = vi.fn(async (name: string) => (name === 'pages.searchTags' ? { tags: ['alpha'] } : {}))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions,
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: mode,
          parallelToolCalls: false,
          structuredOutput: mode === 'native' ? 'native-json-schema' : 'prompt-only',
          usage: 'estimated',
          cancellation: true,
          maxContextTokens: 100_000,
          maxOutputTokens: 1_024
        },
        transportKind: mode === 'native' ? 'openai-responses' : 'legacy-completions',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory

    await new AxAgentEngine(factory, actions).execute(
      { ...request(new AbortController().signal), limits: { maxTurns: 4, maxToolCalls: 3, maxOutputTokens: 256 } },
      {
        text: async () => {},
        event: async (type: string, data: unknown) => {
          events.push([type, data])
        }
      }
    )

    expect(Object.isFrozen(functions)).toBe(true)
    expect(Object.isFrozen(functions[0])).toBe(true)
    expect(Object.isFrozen(functions[1])).toBe(true)
    expect(invoke).toHaveBeenCalledWith(
      'pages.searchTags',
      { query: 'alpha', limit: 1 },
      expect.any(AbortSignal),
      mode === 'native' ? 'search-tags' : expect.any(String)
    )
    const startedInputs = events
      .filter(([type]) => type === 'tool.started')
      .map(([, data]) => {
        if (typeof data !== 'object' || data === null || !('input' in data) || typeof data.input !== 'string') return undefined
        return data.input
      })
    expect(startedInputs).toEqual(['{"category":"explore"}', '{"limit":1,"query":"alpha"}'])
    expect(calls).toHaveLength(3)
    if (mode === 'native') {
      expect(calls[0]?.functions?.map(functionCall => functionCall.name)).toEqual(['wiki_get_page', 'wiki_enable_tools'])
      expect(calls[1]?.functions?.map(functionCall => functionCall.name)).toEqual(['wiki_get_page', 'wiki_search_tags', 'wiki_enable_tools'])
    } else {
      expect(calls[0]).not.toHaveProperty('functions')
      expect(calls[1]).not.toHaveProperty('functions')
      expect(calls[0]?.chatPrompt[0]).toEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('wiki_enable_tools') }))
      expect(calls[1]?.chatPrompt[0]).toEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('wiki_search_tags') }))
    }
  })
  it.each(['native', 'prompt'] as const)(
    'rejects a category whose prospective schema cannot fit while keeping core synthesis available on the %s protocol',
    async mode => {
      const largeSchema = 'schema '.repeat(20_000)
      const responses: AxChatResponse[] =
        mode === 'native'
          ? [
              {
                results: [
                  {
                    index: 0,
                    functionCalls: [
                      {
                        id: 'enable-large',
                        type: 'function',
                        function: { name: 'wiki_enable_tools', params: { category: 'explore' } }
                      }
                    ]
                  }
                ]
              },
              { results: [{ index: 0, content: 'Core tools remain available.' }] }
            ]
          : [
              { results: [{ index: 0, content: '<wiki-tool-call>{"name":"wiki_enable_tools","arguments":{"category":"explore"}}</wiki-tool-call>' }] },
              { results: [{ index: 0, content: 'Core tools remain available.' }] }
            ]
      const calls: Readonly<AxChatRequest<unknown>>[] = []
      const events: Array<readonly [string, unknown]> = []
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
        calls.push(input)
        return responses.shift()!
      })
      const functions = Object.freeze([
        Object.freeze({
          name: 'pages.get' as const,
          title: 'Read page',
          description: 'Read one page',
          parameters: { type: 'object', properties: { id: { type: 'number' } } },
          risk: 'read',
          group: 'core' as const
        }),
        Object.freeze({
          name: 'pages.searchTags' as const,
          title: 'Search tags',
          description: 'Small category description',
          parameters: { type: 'object', properties: { schema: { type: 'string', description: largeSchema } } },
          risk: 'read',
          group: 'explore' as const
        })
      ])
      const invoke = vi.fn(async () => ({ tags: ['unused'] }))
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions,
          invoke,
          snapshot: async () => ({}),
          close: vi.fn(),
          authoritySha256: null
        })
      }
      const factory = {
        create: async () => ({
          service: { chat },
          capabilities: {
            streaming: false,
            toolCalling: mode,
            parallelToolCalls: false,
            structuredOutput: mode === 'native' ? 'native-json-schema' : 'prompt-only',
            usage: 'estimated',
            cancellation: true,
            maxContextTokens: 100_000,
            maxOutputTokens: 1_024
          },
          transportKind: mode === 'native' ? 'openai-responses' : 'legacy-completions',
          model: 'gpt-test',
          capabilityRevision: 'cap-1',
          pricingRevision: 'price-1',
          pricing
        })
      } as unknown as AgentProviderFactory

      const result = await new AxAgentEngine(factory, actions).execute(
        { ...request(new AbortController().signal), limits: { maxTurns: 4, maxToolCalls: 2, maxOutputTokens: 256 } },
        {
          text: async () => {},
          event: async (type: string, data: unknown) => {
            events.push([type, data])
          }
        }
      )

      expect(invoke).not.toHaveBeenCalled()
      expect(calls).toHaveLength(2)
      const failedData = events.find(([type]) => type === 'tool.failed')?.[1]
      let failedActionCallId: string | undefined
      if (typeof failedData === 'object' && failedData !== null && 'actionCallId' in failedData && typeof failedData.actionCallId === 'string')
        failedActionCallId = failedData.actionCallId
      if (failedActionCallId === undefined) throw new Error('capacity failure did not retain the started action call identity')
      expect(result.contextLimit).toEqual({ reason: 'tool_result_capacity', omittedActionCallIds: [failedActionCallId] })
      expect(events.filter(([type]) => type === 'tool.completed')).toHaveLength(0)
      expect(events.filter(([type]) => type === 'tool.failed').map(([, data]) => data)).toEqual([
        expect.objectContaining({ actionCallId: failedActionCallId, errorCode: 'AGENT_CONTEXT_TOO_LARGE' })
      ])
      if (mode === 'native') expect(failedActionCallId).toBe('enable-large')
      if (mode === 'native') {
        expect(calls[0]?.functions?.map(functionCall => functionCall.name)).toEqual(['wiki_get_page', 'wiki_enable_tools'])
        expect(calls[1]).not.toHaveProperty('functions')
      } else {
        expect(calls[1]).not.toHaveProperty('functions')
      }
    }
  )

  it('moves to synthesis when a later same-batch result exhausts prospective capacity', async () => {
    const largeDescription = 'large result '.repeat(10_000)
    const responses: AxChatResponse[] = [
      {
        results: [
          {
            index: 0,
            functionCalls: [
              {
                id: 'enable-explore',
                type: 'function',
                function: { name: 'wiki_enable_tools', params: { category: 'explore' } }
              },
              {
                id: 'large-search',
                type: 'function',
                function: { name: 'wiki_search_pages', params: { query: 'large' } }
              }
            ]
          }
        ]
      },
      { results: [{ index: 0, content: 'The search was capacity limited.' }] }
    ]
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const events: Array<readonly [string, unknown]> = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return responses.shift()!
    })
    const functions = Object.freeze([
      Object.freeze({
        name: 'pages.search' as const,
        title: 'Search pages',
        description: 'Search pages',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        risk: 'read',
        group: 'core' as const
      }),
      Object.freeze({
        name: 'pages.searchTags' as const,
        title: 'Search tags',
        description: 'Search visible tags',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        risk: 'read',
        group: 'explore' as const
      })
    ])
    const invoke = vi.fn(async () => ({
      results: [
        {
          id: 1,
          locale: 'en',
          path: 'large',
          title: 'Large result',
          description: largeDescription,
          contentType: 'markdown'
        }
      ]
    }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions,
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
          cancellation: true,
          maxContextTokens: 100_000,
          maxOutputTokens: 1_024
        },
        transportKind: 'openai-responses',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory

    const result = await new AxAgentEngine(factory, actions).execute(
      { ...request(new AbortController().signal), limits: { maxTurns: 4, maxToolCalls: 3, maxOutputTokens: 256 } },
      {
        text: async () => {},
        event: async (type: string, data: unknown) => {
          events.push([type, data])
        }
      }
    )

    expect(invoke).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(2)
    expect(calls[1]).not.toHaveProperty('functions')
    expect(result.contextLimit).toEqual({ reason: 'tool_result_capacity', omittedActionCallIds: ['large-search'] })
    expect(events.filter(([type]) => type === 'tool.completed').map(([, data]) => data)).toEqual([
      expect.objectContaining({ actionCallId: 'enable-explore', summary: 'Enabled explore tools for the next turn' }),
      expect.objectContaining({ actionCallId: 'large-search' })
    ])
  })
  it.each(['native', 'prompt'] as const)('keeps depth-one child authority read-only on the %s protocol', async mode => {
    const taskId = '00000000-0000-4000-8000-000000000081'
    const subagentRunId = '00000000-0000-4000-8000-000000000082'
    const packet = JSON.stringify({
      taskId,
      outcome: 'completed',
      claims: [{ text: 'Alpha is ready. [[cite:page:1]]', evidenceIds: ['page:1'], sourceRevisionIds: ['rev-1'], confidence: 'high' }],
      conflicts: [],
      unanswered: [],
      recommendedFollowups: []
    })
    const responses: AxChatResponse[] =
      mode === 'native'
        ? [
            {
              results: [
                {
                  index: 0,
                  functionCalls: [{ id: 'child-read', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }]
                }
              ]
            },
            { results: [{ index: 0, content: packet }] }
          ]
        : [
            { results: [{ index: 0, content: '<wiki-tool-call>{"name":"wiki_get_page","arguments":{"id":1}}</wiki-tool-call>' }] },
            { results: [{ index: 0, content: packet }] }
          ]
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return responses.shift()!
    })
    const functions = Object.freeze([
      Object.freeze({
        name: 'pages.get' as const,
        title: 'Read page',
        description: 'Read one page',
        parameters: { type: 'object', properties: { id: { type: 'number' } } },
        risk: 'read',
        group: 'core' as const
      }),
      Object.freeze({
        name: 'pages.searchTags' as const,
        title: 'Search tags',
        description: 'Search visible tags',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        risk: 'read',
        group: 'explore' as const
      }),
      Object.freeze({
        name: 'pages.prepareCreate' as const,
        title: 'Prepare page',
        description: 'Prepare a page proposal',
        parameters: { type: 'object', properties: {} },
        risk: 'proposal',
        group: 'authoring' as const
      })
    ])
    const invoke = vi.fn(async () => ({
      id: 1,
      sourceRevision: 'rev-1',
      title: 'Alpha',
      contentType: 'markdown',
      content: 'Alpha is ready.',
      citation: { evidenceId: 'page:1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions,
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: 'd'.repeat(64)
      })
    }
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: mode,
          parallelToolCalls: false,
          structuredOutput: mode === 'native' ? 'native-json-schema' : 'prompt-only',
          usage: 'estimated',
          cancellation: true,
          maxContextTokens: 100_000,
          maxOutputTokens: 1_024
        },
        transportKind: mode === 'native' ? 'openai-responses' : 'legacy-completions',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const text = vi.fn(async () => {})
    const result = await new AxAgentEngine(factory, actions).execute(
      {
        ...request(new AbortController().signal),
        purpose: 'subagent',
        task: {
          id: taskId,
          kind: 'source_scout',
          title: 'Review alpha',
          question: 'What is alpha status?',
          sourceScope: ['alpha'],
          requiredEvidenceCount: 1
        },
        subagentRunId,
        actionAllowlist: ['pages.get', 'pages.searchTags'],
        limits: { maxTurns: 3, maxToolCalls: 2, maxOutputTokens: 512 }
      },
      { text, event: async () => {} }
    )

    expect(result.authoritySha256).toBe('d'.repeat(64))
    expect(Object.isFrozen(functions)).toBe(true)
    expect(invoke).toHaveBeenCalledWith(
      'pages.get',
      { id: 1 },
      expect.any(AbortSignal),
      expect.stringMatching(new RegExp(`^sa_${subagentRunId}_[a-f0-9]{24}$`, 'u'))
    )
    expect(invoke).toHaveBeenCalledOnce()
    expect(text.mock.calls.map(([delta]) => delta).join('')).toBe(packet)
    expect(calls).toHaveLength(2)
    if (mode === 'native') {
      expect(calls[0]?.functions?.map(functionCall => functionCall.name)).toEqual(['wiki_get_page', 'wiki_enable_tools'])
      expect(calls[0]?.functions?.map(functionCall => functionCall.name)).not.toContain('wiki_prepare_page_create')
    } else {
      expect(calls[0]).not.toHaveProperty('functions')
      expect(calls[0]?.chatPrompt[0]).toEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('"name":"wiki_get_page"') }))
      expect(calls[0]?.chatPrompt[0]).toEqual(expect.objectContaining({ content: expect.not.stringContaining('wiki_prepare_page_create') }))
    }
  })
  it('keeps a recent-page window and ten page reads available for one grounded completion', async () => {
    const readCalls = Array.from({ length: 10 }, (_, index) => ({
      id: `read-${index + 1}`,
      type: 'function' as const,
      function: { name: 'wiki_get_page', params: JSON.stringify({ id: index + 1 }) }
    }))
    const answer = Array.from({ length: 10 }, (_, index) => `Recent page ${index + 1} is documented.[[cite:page:${index + 1}]]`).join(' ')
    const responses: AxChatResponse[] = [
      {
        results: [
          {
            index: 0,
            functionCalls: [{ id: 'recent', type: 'function', function: { name: 'wiki_list_recent_pages', params: '{"locale":"en","limit":10}' } }]
          }
        ]
      },
      { results: [{ index: 0, functionCalls: readCalls }] },
      { results: [{ index: 0, content: answer }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const invoke = vi.fn(async (name: string, input: unknown) => {
      if (name === 'pages.listRecent') {
        return {
          pages: Array.from({ length: 10 }, (_, index) => ({
            id: index + 1,
            locale: 'en',
            path: `recent/${index + 1}`,
            title: `Recent page ${index + 1}`,
            description: '',
            contentType: 'markdown',
            sourceRevision: `rev-${index + 1}`,
            citation: { evidenceId: `page:${index + 1}`, label: `Recent page ${index + 1}`, href: `/en/recent/${index + 1}` }
          }))
        }
      }
      const id = typeof input === 'object' && input !== null && typeof Reflect.get(input, 'id') === 'number' ? Number(Reflect.get(input, 'id')) : 0
      return {
        id,
        title: `Recent page ${id}`,
        contentType: 'markdown',
        content: `Recent page ${id} is documented.`,
        citation: { evidenceId: `page:${id}`, label: `Recent page ${id}`, href: `/en/recent/${id}` },
        citationSections: []
      }
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.listRecent',
            title: 'List recent pages',
            description: 'List recently changed pages',
            parameters: { type: 'object', properties: { locale: { type: 'string' }, limit: { type: 'number' } } },
            risk: 'read',
            group: 'core'
          },
          {
            name: 'pages.get',
            title: 'Read page',
            description: 'Read one page',
            parameters: { type: 'object', properties: { id: { type: 'number' } } },
            risk: 'read',
            group: 'core'
          }
        ],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
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
    const text = vi.fn(async () => {})
    const result = await new AxAgentEngine(factory, actions).execute(
      {
        ...request(new AbortController().signal),
        limits: { maxTurns: 3, maxToolCalls: 11, maxOutputTokens: 1_024 }
      },
      { text, event: async () => {} }
    )

    expect(chat).toHaveBeenCalledTimes(3)
    expect(invoke).toHaveBeenCalledTimes(11)
    expect(result.contextLimit).toBeUndefined()
    expect(result.citations).toHaveLength(10)
    expect(text.mock.calls.map(([delta]) => delta).join('')).toBe(answer)
  })
  it('keeps an oversized omitted source out of citations and corrects the capacity-limited synthesis', async () => {
    const largePayload = 'Large source payload '.repeat(2_000)
    const responses: AxChatResponse[] = [
      {
        results: [
          {
            index: 0,
            functionCalls: [
              { id: 'small', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } },
              { id: 'large', type: 'function', function: { name: 'wiki_get_page', params: '{"id":2}' } }
            ]
          }
        ]
      },
      { results: [{ index: 0, content: 'Large source is authoritative.[[cite:page:2]]' }] },
      { results: [{ index: 0, content: 'Small source is available.[[cite:page:1]]' }] }
    ]
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return responses.shift()!
    })
    const invoke = vi.fn(async (_name: string, input: unknown) => {
      const id = typeof input === 'object' && input !== null && typeof Reflect.get(input, 'id') === 'number' ? Number(Reflect.get(input, 'id')) : 0
      return {
        id,
        title: id === 1 ? 'Small source' : 'Large source',
        contentType: 'markdown',
        content: id === 1 ? 'Small source is available.' : largePayload,
        citation: { evidenceId: `page:${id}`, label: id === 1 ? 'Small source' : 'Large source', href: `/en/source/${id}` },
        citationSections: []
      }
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.get',
            title: 'Read page',
            description: 'Read one page',
            parameters: { type: 'object', properties: { id: { type: 'number' } } },
            risk: 'read',
            group: 'core'
          }
        ],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
          cancellation: true,
          maxContextTokens: 24_000,
          maxOutputTokens: 1_000
        },
        transportKind: 'openai-responses',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const text = vi.fn(async () => {})
    const result = await new AxAgentEngine(factory, actions).execute(
      {
        ...request(new AbortController().signal),
        limits: { maxTurns: 4, maxToolCalls: 2, maxOutputTokens: 500 }
      },
      { text, event }
    )

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(chat).toHaveBeenCalledTimes(3)
    expect(calls[2]?.chatPrompt).not.toContainEqual(expect.objectContaining({ content: expect.stringContaining('Large source payload') }))
    expect(result).toMatchObject({
      contextLimit: { reason: 'tool_result_capacity', omittedActionCallIds: ['large'] },
      citations: [{ evidenceId: 'page:1', kind: 'page', label: 'Small source', href: '/en/source/1' }]
    })
    expect(text).toHaveBeenCalledOnce()
    expect(text).toHaveBeenCalledWith('Small source is available.[[cite:page:1]]')
    const provenance = event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)
    expect(provenance).toEqual([
      expect.objectContaining({
        accepted: false,
        issues: [expect.stringContaining('page:2 was not produced by a successful page read')]
      }),
      expect.objectContaining({ accepted: true, finalCitationIds: ['page:1'] })
    ])
  })
})

describe('Agent event projection', () => {
  it('keeps completed tools and terminal suggestions after more than 1,000 legal events', () => {
    const runId = '00000000-0000-4000-8000-000000000099'
    let sequence = 0
    const event = (type: AgentEvent['type'], data: AgentEvent['data']): AgentEvent => ({
      id: `event-${sequence + 1}`,
      runId,
      sequence: ++sequence,
      type,
      attempt: 1,
      schemaVersion: 1,
      data,
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    const events: AgentEvent[] = [event('model.turn', { turn: 1 })]
    for (let index = 0; index < 512; index += 1) {
      const actionCallId = `child-tool-${index}`
      events.push(
        event('tool.started', { actionCallId, actionName: 'pages.get', risk: 'read', title: `Read page ${index}` }),
        event('tool.completed', { actionCallId, result: '{}', summary: `Read page ${index}` })
      )
    }
    events.push(event('run.completed', { runId }), event('suggestions.updated', { suggestions: [{ id: 'next', label: 'Next step', prompt: 'Continue' }] }))

    const reduced = reduceAgentEvents(events, runId)

    expect(events[999]?.type).toBe('tool.started')
    expect(events[1_000]?.type).toBe('tool.completed')
    expect(events.length).toBeGreaterThan(1_000)
    expect(reduced.tools).toHaveLength(512)
    expect(reduced.tools.every(tool => tool.state === 'complete' && tool.completedAt !== null)).toBe(true)
    expect(reduced.suggestions).toEqual([{ id: 'next', label: 'Next step', prompt: 'Continue' }])
  })
})

describe('Memory action side-effect fencing', () => {
  it('fences every repository mutation immediately before dispatch', async () => {
    const events: string[] = []
    const repositoryResult = { memories: ['remembered'] }
    const manage = vi.fn(async (_userId: number, _input: unknown) => {
      events.push('manage')
      return repositoryResult
    })
    let registeredHandler: ActionHandler | undefined
    const kernel = {
      register: (name: string, handler: ActionHandler) => {
        expect(name).toBe('memory.manage')
        registeredHandler = handler
      }
    } as unknown as ActionKernel
    registerMemoryAction(kernel, { manage } as unknown as AgentMemoryRepository)
    expect(registeredHandler).toBeDefined()
    const invoke = registeredHandler as ActionHandler
    const mutations = [
      { action: 'add', target: 'user', content: 'remembered' },
      { action: 'replace', target: 'agent', oldText: 'remembered', content: 'updated' },
      { action: 'remove', target: 'user', oldText: 'updated' }
    ] as const
    const context = (fenceSideEffect: () => Promise<void>) =>
      ({
        authority: { requester: { kind: 'user', userId: 7 } },
        fenceSideEffect
      }) as unknown as ActionHandlerContext
    const fenceSideEffect = vi.fn(async () => {
      events.push('fence')
    })

    for (const mutation of mutations) {
      await expect(invoke(mutation, context(fenceSideEffect))).resolves.toBe(repositoryResult)
    }

    expect(events).toEqual(['fence', 'manage', 'fence', 'manage', 'fence', 'manage'])
    expect(manage.mock.calls).toEqual(mutations.map(mutation => [7, mutation]))

    const leaseLost = new Error('lease lost before side-effect dispatch')
    const rejectedFence = vi.fn(async () => {
      throw leaseLost
    })
    await expect(invoke(mutations[0], context(rejectedFence))).rejects.toBe(leaseLost)
    expect(manage).toHaveBeenCalledTimes(mutations.length)
  })
})
