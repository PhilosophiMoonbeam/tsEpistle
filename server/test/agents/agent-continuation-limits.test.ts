import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { AxAgentEngine } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory, AgentProviderService } from '../../agents/providers/factory.ts'
import { createGeminiInteractionsService, preserveGeminiInteractionState } from '../../agents/providers/gemini-interactions.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

const model = 'gemini-3.8-flash'
const pricing = { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } as const
const usage = { total_input_tokens: 3, total_output_tokens: 2, total_tokens: 5 }

const run: AgentEngineRequest['run'] = {
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
  transportKind: 'gemini-api',
  model,
  executionMode: 'agent',
  googleSearchEnabled: false,
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
  queuedAt: '2026-09-20T00:00:00.000Z',
  startedAt: '2026-09-20T00:00:00.000Z',
  completedAt: null
}

const request = (overrides: Partial<AgentEngineRequest> = {}): AgentEngineRequest => ({
  googleSearchEnabled: false,
  run,
  messages: [{ role: 'user', content: 'Reply briefly.' }],
  memory: { user: [], agent: [] },
  skills: [],
  priorActivity: [],
  limits: { maxTurns: 1, maxToolCalls: 0, maxOutputTokens: 32_768 },
  signal: new AbortController().signal,
  ...overrides
})

const interaction = (id: string, content: string, signature?: string): Record<string, unknown> => ({
  id,
  model,
  status: 'completed',
  steps: [...(signature === undefined ? [] : [{ type: 'thought', signature }]), { type: 'model_output', content: [{ type: 'text', text: content }] }],
  usage
})

const adapter = (responses: readonly Record<string, unknown>[], inspectRequest?: (body: unknown) => void) => {
  const pending = [...responses]
  return createGeminiInteractionsService({
    apiKey: 'test-key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model,
    timeoutMs: 10_000,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (inspectRequest) inspectRequest(JSON.parse(String(init?.body)))
      const next = pending.shift()
      if (next === undefined) throw new Error('Unexpected Gemini fixture request')
      return Response.json(next)
    }) as typeof fetch
  })
}

const factory = (chat: AgentProviderService['service']['chat'], streaming = false): AgentProviderFactory =>
  ({
    create: async () => ({
      service: { chat },
      capabilities: {
        streaming,
        toolCalling: 'native',
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema',
        usage: 'terminal',
        cancellation: true,
        maxContextTokens: 1_000_000,
        maxOutputTokens: 32_768
      },
      transportKind: 'gemini-api',
      model,
      continuationDialect: 'gemini-interactions-v1',
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1',
      pricing,
      preserveThoughtBlock: (_resultId, block) => preserveGeminiInteractionState(block)
    })
  }) as unknown as AgentProviderFactory

const responseStream = (responses: readonly AxChatResponse[]): ReadableStream<AxChatResponse> => {
  let index = 0
  return new ReadableStream<AxChatResponse>(
    {
      pull(controller) {
        const response = responses[index++]
        if (response === undefined) controller.close()
        else controller.enqueue(response)
      }
    },
    { highWaterMark: 0 }
  )
}

const execute = async (chat: AgentProviderService['service']['chat'], streaming = false, overrides: Partial<AgentEngineRequest> = {}) => {
  const text = vi.fn(async (_delta: string) => {})
  const event = vi.fn(async () => {})
  const result = new AxAgentEngine(factory(chat, streaming)).execute(request(overrides), { text, event })
  return { result, text, event }
}

const buffered = async (service: AgentProviderService['service'], input: AxChatRequest): Promise<AxChatResponse> => {
  const response = await service.chat(input, { stream: false })
  if (response instanceof ReadableStream) throw new Error('Expected a buffered Gemini fixture response')
  return response
}

describe('agent continuation resource limits', () => {
  it('accepts, settles, and replays valid atomic Gemini state larger than the text-fragment limit', async () => {
    const native = adapter([interaction('interaction-1', 'Hello.', 's'.repeat(70_000))])
    const chat: AgentProviderService['service']['chat'] = async input => responseStream([await buffered(native, input)])
    const reconcile = vi.fn(async () => {})
    const { result, text } = await execute(chat, true, {
      dispatchBudget: {
        reserve: async maximum => ({ id: 1, ...maximum }),
        reconcile,
        release: async () => {},
        consumeTool: async () => {},
        unsettledExposure: { tokens: 0, costMicros: 0 }
      }
    })

    const accepted = await result
    expect(accepted).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5, costMicros: 7 })
    expect(reconcile).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), { inputTokens: 3, outputTokens: 2, totalTokens: 5, costMicros: 7 })
    expect(text).toHaveBeenCalledOnce()
    expect(text).toHaveBeenCalledWith('Hello.')
    expect(accepted.providerState?.thoughtBlocks).toHaveLength(1)
    const block = accepted.providerState?.thoughtBlocks[0]
    if (block === undefined) throw new Error('Engine did not preserve Gemini continuation state')
    expect(Buffer.byteLength(block.data, 'utf8')).toBeGreaterThan(65_536)

    const replayRequest = vi.fn()
    const replay = adapter([interaction('interaction-2', 'Again.')], replayRequest)
    await buffered(replay, {
      model,
      chatPrompt: [
        { role: 'assistant', content: 'Hello.', thoughtBlocks: [block] },
        { role: 'user', content: 'Continue.' }
      ]
    })
    expect(replayRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          expect.objectContaining({ type: 'thought', signature: 's'.repeat(70_000) }),
          { type: 'model_output', content: [{ type: 'text', text: 'Hello.' }] },
          { type: 'user_input', content: [{ type: 'text', text: 'Continue.' }] }
        ]
      })
    )
  })

  it('rejects cumulative Gemini continuation state over budget before accepting an answer', async () => {
    const native = adapter([interaction('interaction-1', 'A', 'a'.repeat(131_000)), interaction('interaction-2', 'B', 'b'.repeat(131_000))])
    const chat: AgentProviderService['service']['chat'] = async input => responseStream([await buffered(native, input), await buffered(native, input)])
    const { result, text } = await execute(chat, true)

    await expect(result).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(text).not.toHaveBeenCalled()
  })

  it('rejects malformed Gemini continuation state without accepting its visible answer', async () => {
    const native = adapter([interaction('interaction-1', 'Hello.', 'valid-signature')])
    const chat: AgentProviderService['service']['chat'] = async input => {
      const response = await buffered(native, input)
      return {
        ...response,
        results: response.results.map(result => ({
          ...result,
          thoughtBlocks: [{ data: 'wiki.gemini.interactions.v1:{', encrypted: true }]
        }))
      }
    }
    const { result, text } = await execute(chat)

    await expect(result).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(text).not.toHaveBeenCalled()
  })

  it('keeps the independent provider text-fragment limit unchanged', async () => {
    const native = adapter([interaction('interaction-1', 'x'.repeat(65_537))])
    const { result, text } = await execute(native.chat.bind(native))

    await expect(result).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(text).not.toHaveBeenCalled()
  })
})
