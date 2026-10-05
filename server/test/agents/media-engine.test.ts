import { AxAgentEngine } from '../../agents/providers/engine.ts'
import { type AgentProviderFactory, type AgentProviderFetch } from '../../agents/providers/factory.ts'
import { createGeminiMediaTransport } from '../../agents/providers/gemini-media.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

const origin = 'https://generativelanguage.googleapis.com'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPQSNnyHwAEOAJA4ywNkQAAAABJRU5ErkJggg==',
  'base64'
)
const pricing = { revision: 'image-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
const capabilities = {
  streaming: false,
  toolCalling: 'native' as const,
  parallelToolCalls: false,
  structuredOutput: 'native-json-schema' as const,
  usage: 'terminal' as const,
  cancellation: true,
  maxContextTokens: 100_000,
  maxOutputTokens: 4_000
}
const request = (kind: 'image' | 'video' | 'music' = 'image'): AgentEngineRequest => ({
  authorizeMedia: async () => {},
  mediaRequest: { kind },
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
    transportKind: 'gemini-api',
    model: 'gemini-3.8-flash',
    executionMode: 'agent',
    googleSearchEnabled: false,
    capabilityRevision: 'cap-1',
    pricingRevision: 'main-1',
    totalTokens: 0,
    promptVersion: 1,
    attempts: 1,
    maxAttempts: 3,
    eventSequence: 0,
    leaseOwner: 'worker',
    leaseToken: '00000000-0000-4000-8000-000000000007',
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    cancelRequestedAt: null,
    sideEffectsStarted: false,
    errorCode: null,
    errorMessage: null,
    queuedAt: '2026-08-17T00:00:00.000Z',
    startedAt: '2026-08-17T00:00:00.000Z',
    completedAt: null
  },
  messages: [{ role: 'user', content: 'A copper observatory at dusk' }],
  memory: { user: [], agent: [] },
  skills: [],
  signal: new AbortController().signal
})
const budget = () => ({
  reserve: vi.fn(async (input: { tokens: number; costMicros: number }) => ({ id: 1, ...input })),
  reconcile: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  consumeTool: vi.fn(async () => {}),
  unsettledExposure: { tokens: 0, costMicros: 0 }
})
const setup = (response: () => Response) => {
  const urls: string[] = []
  const fetch = Object.assign(
    async (input: URL | RequestInfo) => {
      const url = String(input)
      urls.push(url)
      return url.endsWith(':countTokens') ? Response.json({ totalTokens: 100 }) : response()
    },
    { preconnect: () => {} }
  ) as AgentProviderFetch
  const transport = createGeminiMediaTransport({
    apiKey: 'test-key',
    baseUrl: `${origin}/v1beta`,
    timeoutMs: 5_000,
    maxInputTokens: 100_000,
    maxOutputTokens: 4_000,
    fetch
  })
  const factory = {
    createMedia: async () => ({
      config: {},
      capabilities,
      pricing: {
        imageGeneration: pricing,
        videoGeneration: { ...pricing, textOutputMicrosPerMillionTokens: 1_000_000 },
        musicGeneration: { costMicrosPerSong: 80_000 }
      },
      transport
    })
  } as unknown as AgentProviderFactory
  return { urls, engine: new AxAgentEngine(factory) }
}
const output = () =>
  Response.json({
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, thoughtsTokenCount: 3, totalTokenCount: 13 }
  })

describe('Ax media protocol and engine accounting boundary', () => {
  it('settles reported image and thought usage before publishing private bytes', async () => {
    const { engine, urls } = setup(output)
    const dispatchBudget = budget()
    const order: string[] = []
    dispatchBudget.reconcile.mockImplementation(async () => {
      order.push('settle')
    })
    const media = vi.fn(async () => {
      order.push('publish')
    })
    const result = await engine.execute({ ...request(), dispatchBudget }, { media, text: async () => {}, event: async () => {} })
    expect(urls).toEqual([`${origin}/v1beta/models/gemini-3.1-flash-image:countTokens`, `${origin}/v1beta/models/gemini-3.1-flash-image:generateContent`])
    expect(dispatchBudget.reserve).toHaveBeenCalledWith({ tokens: 4_100, costMicros: 8_100 })
    expect(dispatchBudget.reconcile).toHaveBeenCalledWith(expect.anything(), { inputTokens: 4, outputTokens: 9, totalTokens: 13, costMicros: 22 })
    expect(order).toEqual(['settle', 'publish'])
    expect(media).toHaveBeenCalledWith([{ payload: png, mimeType: 'image/png', filename: 'generated-image-1.png' }])
    expect(result.totalTokens).toBe(13)
    expect(dispatchBudget.release).not.toHaveBeenCalled()
  })

  it('retains dispatched exposure and publishes no bytes when usage cannot be trusted', async () => {
    const { engine, urls } = setup(() =>
      Response.json({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }]
      })
    )
    const dispatchBudget = budget()
    const media = vi.fn(async () => {})
    await expect(engine.execute({ ...request(), dispatchBudget }, { media, text: async () => {}, event: async () => {} })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE'
    })
    expect(urls).toHaveLength(2)
    expect(dispatchBudget.reserve).toHaveBeenCalledTimes(1)
    expect(dispatchBudget.release).not.toHaveBeenCalled()
    expect(dispatchBudget.reconcile).not.toHaveBeenCalled()
    expect(media).not.toHaveBeenCalled()
  })

  it('releases admission when fresh authorization is revoked before Ax inference', async () => {
    const { engine, urls } = setup(output)
    const dispatchBudget = budget()
    let checks = 0
    const authorizeMedia = async () => {
      if (++checks === 2) throw new AgentRepositoryError('AGENT_MEDIA_DISABLED', 'Media permission revoked', 403)
    }
    await expect(
      engine.execute(
        { ...request(), authorizeMedia, dispatchBudget },
        {
          media: async () => {},
          text: async () => {},
          event: async () => {}
        }
      )
    ).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED' })
    expect(urls).toEqual([`${origin}/v1beta/models/gemini-3.1-flash-image:countTokens`])
    expect(dispatchBudget.reserve).toHaveBeenCalledTimes(1)
    expect(dispatchBudget.release).toHaveBeenCalledTimes(1)
    expect(dispatchBudget.reconcile).not.toHaveBeenCalled()
  })

  for (const kind of ['video', 'music'] as const)
    it(`preserves the explicit ${kind} incompatibility without reservation, dispatch, or publication`, async () => {
      const { engine, urls } = setup(output)
      const dispatchBudget = budget()
      const media = vi.fn(async () => {})
      await expect(
        engine.execute(
          { ...request(kind), dispatchBudget },
          {
            media,
            text: async () => {},
            event: async () => {}
          }
        )
      ).rejects.toMatchObject({ code: 'AGENT_MEDIA_UNSUPPORTED' })
      expect(urls).toEqual([])
      expect(dispatchBudget.reserve).not.toHaveBeenCalled()
      expect(dispatchBudget.reconcile).not.toHaveBeenCalled()
      expect(dispatchBudget.release).not.toHaveBeenCalled()
      expect(media).not.toHaveBeenCalled()
    })
})
