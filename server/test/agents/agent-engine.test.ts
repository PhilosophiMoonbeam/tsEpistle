import { describe, expect, it, vi } from 'vitest'
import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { AxAgentEngine, type AgentActionSessionProvider } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { WIKI_AGENT_SOUL } from '../../agents/soul.ts'

const request = (signal: AbortSignal): AgentEngineRequest => ({
  run: {
    id: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', userMessageId: '00000000-0000-4000-8000-000000000003', assistantMessageId: '00000000-0000-4000-8000-000000000004', ownerId: 7, clientRequestId: '00000000-0000-4000-8000-000000000005', clientRequestSha256: 'a'.repeat(64), status: 'running', providerProfileVersionId: '00000000-0000-4000-8000-000000000006', transportKind: 'openai-responses', model: 'gpt-test', executionMode: 'agent', capabilityRevision: 'cap-1', pricingRevision: 'price-1', promptVersion: 1, attempts: 1, maxAttempts: 3, eventSequence: 0, leaseOwner: 'worker', leaseToken: '00000000-0000-4000-8000-000000000007', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequestedAt: null, sideEffectsStarted: false, errorCode: null, errorMessage: null
  },
  messages: [{ role: 'user', content: 'Read page 42' }],
  memory: { user: ['Prefers concise, evidence-first answers.'], agent: ['Wiki project uses PostgreSQL and pnpm.'] },
  currentPage: { id: 42, locale: 'en', path: 'guide', observedUpdatedAt: '2026-08-17T00:00:00.000Z' },
  skills: [{ id: '00000000-0000-4000-8000-000000000008', name: 'wiki-reader', skillMarkdown: '# Reader\nUse page tools.' }],
  signal
})

describe('Ax agent engine', () => {
  it('runs bounded provider tool turns and returns encrypted continuation only', async () => {
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'call-1', type: 'function', function: { name: 'pages_get', params: '{"id":' } }, { id: 'call-1', type: 'function', function: { name: '', params: '42}' } }], thoughtBlocks: [{ data: 'encrypted-state', encrypted: true }, { data: 'hidden thought', encrypted: false }] }], modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } } },
      { results: [{ index: 0, content: 'The install steps are documented.[[cite:page:42:section:1]]' }], modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 8, completionTokens: 4, totalTokens: 12 } } }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return responses.shift()!
    })
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: false, functions: true, parallelFunctions: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }, transportKind: 'openai-responses', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const invoke = vi.fn(async () => ({
      id: 42,
      title: 'Guide',
      citation: { evidenceId: 'page:42', label: 'Guide', href: '/en/guide' },
      citationSections: [{ evidenceId: 'page:42:section:1', label: 'Guide › Install', href: '/en/guide#install' }]
    }))
    const close = vi.fn()
    const actions: AgentActionSessionProvider = {
      open: async () => ({ functions: [{ name: 'pages.get', title: 'Read page', description: 'Reads a page', parameters: { type: 'object', properties: { id: { type: 'number' } } }, risk: 'read' }], invoke, snapshot: async () => ({}), close })
    }
    const engine = new AxAgentEngine(factory, actions)
    const text = vi.fn(async () => {})
    const event = vi.fn(async () => {})
    const result = await engine.execute(request(new AbortController().signal), { text, event })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledWith('pages.get', { id: 42 }, expect.objectContaining({ aborted: false }), 'call-1')
    expect(calls[0]?.functions).toContainEqual(expect.objectContaining({ name: 'pages_get' }))
    expect(calls[0]?.chatPrompt?.[0]).toEqual(expect.objectContaining({ role: 'system', content: expect.stringMatching(new RegExp(`^${WIKI_AGENT_SOUL.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n\\n`)) }))
    expect(calls[0]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('"id":42,"locale":"en","path":"guide"') }))
    expect(calls[0]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('"userProfile":["Prefers concise, evidence-first answers."]') }))
    expect(calls[1]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'assistant', functionCalls: [expect.objectContaining({ function: expect.objectContaining({ name: 'pages_get' }) })] }))
    expect(calls[1]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'function', functionId: 'call-1', result: expect.stringContaining('"citationSections"') }))
    expect(text).toHaveBeenCalledWith('The install steps are documented.[[cite:page:42:section:1]]')
    expect(event.mock.calls.map(([type]) => type)).toEqual(['tool.started', 'tool.completed'])
    expect(result).toMatchObject({
      inputTokens: 13,
      outputTokens: 6,
      citations: [{ evidenceId: 'page:42:section:1', kind: 'page', label: 'Guide › Install', href: '/en/guide#install' }],
      providerState: { thoughtBlocks: [{ data: 'encrypted-state', encrypted: true }] }
    })
    expect(JSON.stringify(result)).not.toContain('hidden thought')
    expect(close).toHaveBeenCalledOnce()
  })

  it('loads the visible skill catalog before the model chooses task actions', async () => {
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return { results: [{ index: 0, content: 'Ready.' }] }
    })
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: false, functions: true, parallelFunctions: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }, transportKind: 'openai-responses', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
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
    expect(calls[0]?.functions).toContainEqual(expect.objectContaining({ name: 'skills_read' }))
    const system = calls[0]?.chatPrompt.find(message => message.role === 'system')
    expect(system?.content).toContain('"name":"wiki-authoring"')
    expect(system?.content).toContain('load an applicable skill')
    expect(system?.content).toContain('very next action must be pages.applyProposal')
    expect(system?.content).toContain('[[cite:EVIDENCE_ID]]')
  })

  it('fails closed when a generation-only provider emits a tool call', async () => {
    const factory = { create: async () => ({ service: { chat: async () => ({ results: [{ index: 0, functionCalls: [{ id: 'call-1', type: 'function', function: { name: 'pages.get', params: '{}' } }] }] }) }, capabilities: { streaming: false, functions: true, parallelFunctions: false, structuredOutput: 'tool-result', usage: 'terminal', cancellation: true, maxContextTokens: 10_000, maxOutputTokens: 1_000 }, transportKind: 'openai-chat', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const input = request(new AbortController().signal)
    const generationOnly = { ...input, run: { ...input.run, executionMode: 'generation-only' } }
    await expect(new AxAgentEngine(factory).execute(generationOnly, { text: async () => {}, event: async () => {} })).rejects.toMatchObject({ code: 'UNEXPECTED_PROVIDER_TOOL_CALL' })
  })
})
