import { describe, expect, it, vi } from 'vitest'
import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { AxAgentEngine, type AgentActionSessionProvider } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'

const request = (signal: AbortSignal): AgentEngineRequest => ({
  run: {
    id: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', userMessageId: '00000000-0000-4000-8000-000000000003', assistantMessageId: '00000000-0000-4000-8000-000000000004', ownerId: 7, clientRequestId: '00000000-0000-4000-8000-000000000005', clientRequestSha256: 'a'.repeat(64), status: 'running', providerProfileVersionId: '00000000-0000-4000-8000-000000000006', transportKind: 'openai-responses', model: 'gpt-test', executionMode: 'agent', capabilityRevision: 'cap-1', pricingRevision: 'price-1', promptVersion: 1, attempts: 1, maxAttempts: 3, eventSequence: 0, leaseOwner: 'worker', leaseToken: '00000000-0000-4000-8000-000000000007', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequestedAt: null, sideEffectsStarted: false, errorCode: null, errorMessage: null
  },
  messages: [{ role: 'user', content: 'Read page 42' }],
  skills: [{ id: '00000000-0000-4000-8000-000000000008', name: 'wiki-reader', skillMarkdown: '# Reader\nUse page tools.' }],
  signal
})

describe('Ax agent engine', () => {
  it('runs bounded provider tool turns and returns encrypted continuation only', async () => {
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'call-1', type: 'function', function: { name: 'pages.get', params: '{"id":42}' } }], thoughtBlocks: [{ data: 'encrypted-state', encrypted: true }, { data: 'hidden thought', encrypted: false }] }], modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } } },
      { results: [{ index: 0, content: 'The page title is Guide.' }], modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 8, completionTokens: 4, totalTokens: 12 } } }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return responses.shift()!
    })
    const factory = { create: async () => ({ service: { chat }, capabilities: { streaming: false, functions: true, parallelFunctions: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }, transportKind: 'openai-responses', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const invoke = vi.fn(async () => ({ id: 42, title: 'Guide' }))
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
    expect(calls[1]?.chatPrompt).toContainEqual(expect.objectContaining({ role: 'function', functionId: 'call-1', result: '{"id":42,"title":"Guide"}' }))
    expect(text).toHaveBeenCalledWith('The page title is Guide.')
    expect(event.mock.calls.map(([type]) => type)).toEqual(['tool.started', 'tool.completed'])
    expect(result).toMatchObject({ inputTokens: 13, outputTokens: 6, providerState: { thoughtBlocks: [{ data: 'encrypted-state', encrypted: true }] } })
    expect(JSON.stringify(result)).not.toContain('hidden thought')
    expect(close).toHaveBeenCalledOnce()
  })

  it('fails closed when a generation-only provider emits a tool call', async () => {
    const factory = { create: async () => ({ service: { chat: async () => ({ results: [{ index: 0, functionCalls: [{ id: 'call-1', type: 'function', function: { name: 'pages.get', params: '{}' } }] }] }) }, capabilities: { streaming: false, functions: true, parallelFunctions: false, structuredOutput: 'tool-result', usage: 'terminal', cancellation: true, maxContextTokens: 10_000, maxOutputTokens: 1_000 }, transportKind: 'openai-chat', model: 'gpt-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1' }) } as unknown as AgentProviderFactory
    const input = request(new AbortController().signal)
    const generationOnly = { ...input, run: { ...input.run, executionMode: 'generation-only' } }
    await expect(new AxAgentEngine(factory).execute(generationOnly, { text: async () => {}, event: async () => {} })).rejects.toMatchObject({ code: 'UNEXPECTED_PROVIDER_TOOL_CALL' })
  })
})
