import { describe, expect, it, vi } from '../bun-test.mts'
import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { AxAgentEngine, type AgentActionSessionProvider } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { WIKI_AGENT_SOUL } from '../../agents/soul.ts'

const request = (signal: AbortSignal): AgentEngineRequest => ({
  run: {
    id: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', userMessageId: '00000000-0000-4000-8000-000000000003', assistantMessageId: '00000000-0000-4000-8000-000000000004', ownerId: 7, clientRequestId: '00000000-0000-4000-8000-000000000005', clientRequestSha256: 'a'.repeat(64), status: 'running', providerProfileVersionId: '00000000-0000-4000-8000-000000000006', transportKind: 'openai-responses', model: 'gpt-test', executionMode: 'agent', capabilityRevision: 'cap-1', pricingRevision: 'price-1', promptVersion: 1, attempts: 1, maxAttempts: 3, eventSequence: 0, leaseOwner: 'worker', leaseToken: '00000000-0000-4000-8000-000000000007', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequestedAt: null, sideEffectsStarted: false, errorCode: null, errorMessage: null, queuedAt: '2026-08-17T00:00:00.000Z', startedAt: '2026-08-17T00:00:00.000Z', completedAt: null
  },
  messages: [{ role: 'user', content: 'Read page 42' }],
  memory: { user: ['Prefers concise, evidence-first answers.'], agent: ['Wiki project uses PostgreSQL and Bun.'] },
  currentPage: { id: 42, locale: 'en', path: 'guide', observedUpdatedAt: '2026-08-17T00:00:00.000Z' },
  skills: [{ id: '00000000-0000-4000-8000-000000000008', name: 'wiki-reader', skillMarkdown: '# Reader\nUse page tools.' }],
  priorActivity: [{
    runId: '00000000-0000-4000-8000-000000000009',
    status: 'succeeded',
    userMessageOrdinal: 1,
    assistantMessageOrdinal: 2,
    modelTurns: 3,
    rejectedEvidenceDrafts: 1,
    tools: [{
      actionCallId: 'prior-get',
      actionName: 'pages.get',
      state: 'complete',
      input: { id: 6 },
      target: { id: 6, title: 'Incident Runbook', sourceRevision: '1' },
      cacheHit: false,
      duplicateOfActionCallId: null
    }]
  }],
  signal
})

describe('Ax agent engine', () => {
  it('runs bounded provider tool turns and returns encrypted continuation only', async () => {
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, content: 'Let me check.', functionCalls: [{ id: 'call-1', type: 'function', function: { name: 'wiki_get_page', params: '{"id":' } }, { id: 'call-1', type: 'function', function: { name: '', params: '42}' } }], thoughtBlocks: [{ data: 'encrypted-state', encrypted: true }, { data: 'hidden thought', encrypted: false }] }], modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } } },
      { results: [{ index: 0, content: 'The install steps are documented.[[cite:page:42:section:1]]' }], modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 8, completionTokens: 4, totalTokens: 12 } } }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return responses.shift()!
    })
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: false, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }, transportKind: 'openai-responses', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const invoke = vi.fn(async () => ({
      id: 42,
      title: 'Guide',
      contentType: 'markdown',
      content: '# Guide\n\n## Install\nThe install steps are documented.',
      citation: { evidenceId: 'page:42', label: 'Guide', href: '/en/guide' },
      citationSections: [{ evidenceId: 'page:42:section:1', label: 'Guide › Install', href: '/en/guide#install' }]
    }))
    const close = vi.fn()
    const actions: AgentActionSessionProvider = {
      open: async () => ({ functions: [{ name: 'pages.get', title: 'Read page', description: 'Reads a page', parameters: { type: 'object', properties: { id: { type: 'number' } } }, risk: 'read' }], invoke, snapshot: async () => ({}), close })
    }
    const engine = new AxAgentEngine(factory, actions)
    const text = vi.fn(async () => {})
    const event = vi.fn(async (...args: [string, unknown]) => { void args })
    const result = await engine.execute(request(new AbortController().signal), { text, event })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledWith('pages.get', { id: 42 }, expect.objectContaining({ aborted: false }), 'call-1')
    expect(calls[0]?.functions).toContainEqual(expect.objectContaining({ name: 'wiki_get_page' }))
    expect(calls[0]?.chatPrompt?.[0]).toEqual(expect.objectContaining({ role: 'system', content: expect.stringMatching(new RegExp(`^${WIKI_AGENT_SOUL.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n\\n`)) }))
    expect(calls[0]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('"id":42,"locale":"en","path":"guide"') }))
    expect(calls[0]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('"userProfile":["Prefers concise, evidence-first answers."]') }))
    expect(calls[0]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('"rejectedEvidenceDrafts":1') }))
    expect(calls[1]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'assistant', functionCalls: [expect.objectContaining({ function: expect.objectContaining({ name: 'wiki_get_page' }) })] }))
    expect(calls[1]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'function', functionId: 'call-1', result: expect.stringContaining('"citationSections"') }))
    expect(calls[1]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'Let me check.' }))
    expect(text).toHaveBeenCalledWith('The install steps are documented.[[cite:page:42:section:1]]')
    expect(text).not.toHaveBeenCalledWith('Let me check.')
    expect(event.mock.calls.map(([type]) => type)).toEqual(['model.turn', 'tool.started', 'tool.completed', 'model.turn', 'evidence.provenance'])
    expect(event).toHaveBeenLastCalledWith('evidence.provenance', expect.objectContaining({
      accepted: true,
      retrievals: [{ actionCallId: 'call-1', actionName: 'pages.get', evidenceIds: ['page:42', 'page:42:section:1'] }],
      claims: [expect.objectContaining({ claim: 'The install steps are documented.', evidenceId: 'page:42:section:1', pageEvidenceId: 'page:42', supported: true })],
      finalCitationIds: ['page:42:section:1']
    }))
    expect(result).toMatchObject({
      inputTokens: 13,
      outputTokens: 6,
      citations: [{ evidenceId: 'page:42:section:1', kind: 'page', label: 'Guide › Install', href: '/en/guide#install' }],
      providerState: { thoughtBlocks: [{ data: 'encrypted-state', encrypted: true }] }
    })
    expect(JSON.stringify(result)).not.toContain('hidden thought')
    expect(close).toHaveBeenCalledOnce()
  })
  it('accepts a citation placed after sentence punctuation and rejects an uncited page answer', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'get-1', type: 'function', function: { name: 'wiki_get_page', params: '{"id":6}' } }] }] },
      { results: [{ index: 0, content: 'Amber Falcon.' }] },
      { results: [{ index: 0, content: 'Amber Falcon is a synthetic incident. [[cite:page:6:section:1]]' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: false, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }, transportKind: 'openai-responses', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const invoke = vi.fn(async () => ({
      id: 6,
      sourceRevision: '1',
      title: 'Incident Runbook',
      contentType: 'markdown',
      content: '# Incident Runbook\n\nAmber Falcon is a synthetic incident.',
      citation: { evidenceId: 'page:6', label: 'Incident Runbook', href: '/en/runbook' },
      citationSections: [{ evidenceId: 'page:6:section:1', label: 'Incident Runbook', href: '/en/runbook#incident-runbook' }]
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
    const event = vi.fn(async (...args: [string, unknown]) => { void args })
    await new AxAgentEngine(factory, actions).execute(request(new AbortController().signal), { text, event })

    expect(chat).toHaveBeenCalledTimes(3)
    expect(text).toHaveBeenCalledWith('Amber Falcon is a synthetic incident. [[cite:page:6:section:1]]')
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
      { results: [{ index: 0, content: 'Amber Falcon is a synthetic incident.[[cite:page:6:section:1]]' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: false, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }, transportKind: 'openai-responses', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const page = {
      id: 6,
      sourceRevision: '1',
      title: 'Incident Runbook',
      contentType: 'markdown',
      content: '# Incident Runbook\n\nAmber Falcon is a synthetic incident.',
      citation: { evidenceId: 'page:6', label: 'Incident Runbook', href: '/en/runbook' },
      citationSections: [{ evidenceId: 'page:6:section:1', label: 'Incident Runbook', href: '/en/runbook#incident-runbook' }]
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
    const event = vi.fn(async (...args: [string, Record<string, unknown>]) => { void args })
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
      { results: [{ index: 0, functionCalls: [{ id: 'search-1', type: 'function', function: { name: 'wiki_search_pages', params: '{"query":"Amber Falcon","limit":10,"offset":0}' } }] }] },
      { results: [{ index: 0, content: 'Amber Falcon is a synthetic incident drill.[[cite:page:6]]' }] },
      { results: [{ index: 0, functionCalls: [{ id: 'get-1', type: 'function', function: { name: 'wiki_get_page', params: '{"id":6}' } }] }] },
      { results: [{ index: 0, content: 'The Incident Runbook describes Amber Falcon as a synthetic incident drill[[cite:page:6:section:1]] and gives the response sequence: confirm the alert and freeze deployments.[[cite:page:6:section:2]]' }] }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      providerCalls.push(input)
      return responses.shift()!
    })
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: false, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }, transportKind: 'openai-responses', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const invoke = vi.fn(async (name: string) => name === 'pages.search'
      ? {
          results: [{
            id: 6,
            title: 'Incident Runbook',
            citation: { evidenceId: 'page:6', label: 'Incident Runbook', href: '/en/agent-shakedown/incident-runbook' }
          }]
        }
      : {
          id: 6,
          title: 'Incident Runbook',
          contentType: 'markdown',
          content: '# Incident Runbook\n\nAmber Falcon is a synthetic incident drill.\n\n## Response sequence\nConfirm the alert and freeze deployments.',
          citation: { evidenceId: 'page:6', label: 'Incident Runbook', href: '/en/agent-shakedown/incident-runbook' },
          citationSections: [
            { evidenceId: 'page:6:section:1', label: 'Incident Runbook', href: '/en/agent-shakedown/incident-runbook#incident-runbook' },
            { evidenceId: 'page:6:section:2', label: 'Incident Runbook › Response sequence', href: '/en/agent-shakedown/incident-runbook#response-sequence' }
          ]
        })
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
    const event = vi.fn(async (...args: [string, unknown]) => { void args })
    const result = await new AxAgentEngine(factory, actions).execute(request(new AbortController().signal), { text, event })

    expect(chat).toHaveBeenCalledTimes(4)
    expect(text).toHaveBeenCalledOnce()
    expect(text).not.toHaveBeenCalledWith(expect.stringContaining('Amber Falcon is a synthetic incident drill.[[cite:page:6]]'))
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(['pages.search', 'pages.get'])
    expect(providerCalls[2]?.chatPrompt).toContainEqual(expect.objectContaining({
      role: 'user',
      content: expect.stringContaining('was not produced by a successful page read')
    }))
    const provenance = event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)
    expect(provenance).toHaveLength(2)
    expect(provenance[0]).toMatchObject({
      accepted: false,
      retrievals: [{ actionCallId: 'search-1', actionName: 'pages.search', evidenceIds: ['page:6'] }],
      claims: [{ evidenceId: 'page:6', pageEvidenceId: null, supported: false }]
    })
    expect(provenance[1]).toMatchObject({
      accepted: true,
      retrievals: [
        { actionCallId: 'search-1', actionName: 'pages.search', evidenceIds: ['page:6'] },
        { actionCallId: 'get-1', actionName: 'pages.get', evidenceIds: ['page:6', 'page:6:section:1', 'page:6:section:2'] }
      ],
      claims: [
        expect.objectContaining({ evidenceId: 'page:6:section:1', pageEvidenceId: 'page:6', supported: true }),
        expect.objectContaining({ evidenceId: 'page:6:section:2', pageEvidenceId: 'page:6', supported: true })
      ],
      finalCitationIds: ['page:6:section:1', 'page:6:section:2']
    })
    expect(result.citations).toEqual([
      { evidenceId: 'page:6:section:1', kind: 'page', label: 'Incident Runbook', href: '/en/agent-shakedown/incident-runbook#incident-runbook' },
      { evidenceId: 'page:6:section:2', kind: 'page', label: 'Incident Runbook › Response sequence', href: '/en/agent-shakedown/incident-runbook#response-sequence' }
    ])
  })

  it('regenerates a cross-section attribution that does not support the associated claim', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'get-1', type: 'function', function: { name: 'wiki_get_page', params: '{"id":6}' } }] }] },
      { results: [{ index: 0, content: 'Amber Falcon is a synthetic incident and its response sequence confirms alerts, freezes deployments, and drains the queue.[[cite:page:6:section:2]]' }] },
      { results: [{ index: 0, content: 'Amber Falcon is a synthetic incident drill.[[cite:page:6:section:1]]' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: false, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }, transportKind: 'openai-responses', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const invoke = vi.fn(async () => ({
      id: 6,
      title: 'Incident Runbook',
      contentType: 'markdown',
      content: '# Incident Runbook\n\nAmber Falcon is a synthetic incident drill.\n\n## Response sequence\nConfirm alerts, freeze deployments, and drain the queue.',
      citation: { evidenceId: 'page:6', label: 'Incident Runbook', href: '/en/runbook' },
      citationSections: [
        { evidenceId: 'page:6:section:1', label: 'Incident Runbook', href: '/en/runbook#incident-runbook' },
        { evidenceId: 'page:6:section:2', label: 'Incident Runbook › Response sequence', href: '/en/runbook#response-sequence' }
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
    const event = vi.fn(async (...args: [string, unknown]) => { void args })
    const result = await new AxAgentEngine(factory, actions).execute(request(new AbortController().signal), { text, event })

    expect(chat).toHaveBeenCalledTimes(3)
    expect(text).toHaveBeenCalledOnce()
    expect(text).toHaveBeenCalledWith('Amber Falcon is a synthetic incident drill.[[cite:page:6:section:1]]')
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toEqual([
      expect.objectContaining({
        accepted: false,
        issues: ['Citation page:6:section:2 does not lexically support its immediately preceding claim.'],
        claims: [expect.objectContaining({ evidenceId: 'page:6:section:2', supported: false })]
      }),
      expect.objectContaining({
        accepted: true,
        claims: [expect.objectContaining({ evidenceId: 'page:6:section:1', supported: true })],
        finalCitationIds: ['page:6:section:1']
      })
    ])
    expect(result.citations).toEqual([{ evidenceId: 'page:6:section:1', kind: 'page', label: 'Incident Runbook', href: '/en/runbook#incident-runbook' }])
  })

  it('withholds unsupported verification language until the draft removes it', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, content: 'I verified it: Amber Falcon is a synthetic incident.' }] },
      { results: [{ index: 0, content: 'I do not have read evidence for that claim.' }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: true, toolCalling: 'native', parallelToolCalls: false, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }, transportKind: 'openai-responses', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const text = vi.fn(async () => {})
    const event = vi.fn(async (...args: [string, unknown]) => { void args })
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
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: false, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }, transportKind: 'openai-responses', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const invoke = vi.fn(async (name: string) => name === 'skills.list'
      ? { skills: [{ name: 'wiki-authoring', description: 'Create and edit compatible Wiki pages', versionId: '00000000-0000-4000-8000-000000000009', contentHash: 'b'.repeat(64) }] }
      : {})
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
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: false, toolCalling: 'prompt', parallelToolCalls: false, structuredOutput: 'prompt-only', usage: 'estimated', cancellation: true, maxContextTokens: 10_000, maxOutputTokens: 1_000 }, transportKind: 'legacy-completions', model: 'text-test', capabilityRevision: 'cap-2', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const invoke = vi.fn(async () => ({ id: 42, title: 'Guide' }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Reads a page', parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }, risk: 'read' }],
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
    expect(providerCalls[1]?.chatPrompt).toContainEqual({ role: 'assistant', content: '<wiki-tool-call>{"name":"wiki_get_page","arguments":{"id":42}}</wiki-tool-call>' })
    expect(providerCalls[1]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'user', content: expect.stringContaining('<wiki-tool-result>') }))
    expect(providerCalls[1]?.chatPrompt.some(message => message.role === 'function')).toBe(false)
    expect(text).toHaveBeenCalledOnce()
    expect(text).toHaveBeenCalledWith('The page is ready.')
  })

  it('fails closed when a generation-only provider emits a tool call', async () => {
    const factory = { create: async () => ({ service: { chat: async () => ({ results: [{ index: 0, functionCalls: [{ id: 'call-1', type: 'function', function: { name: 'pages.get', params: '{}' } }] }] }) }, capabilities: { streaming: false, toolCalling: 'native', parallelToolCalls: false, structuredOutput: 'tool-result', usage: 'terminal', cancellation: true, maxContextTokens: 10_000, maxOutputTokens: 1_000 }, transportKind: 'openai-chat', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const input = request(new AbortController().signal)
    const generationOnly = { ...input, run: { ...input.run, executionMode: 'generation-only' } }
    await expect(Promise.resolve(new AxAgentEngine(factory).execute(generationOnly, { text: async () => {}, event: async () => {} }))).rejects.toMatchObject({ code: 'UNEXPECTED_PROVIDER_TOOL_CALL' })
  })
})
