import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ai, AxAIGoogleGeminiModel } from '@ax-llm/ax'
import { AxAgentEngine } from '../../agents/providers/engine.ts'
import { type AgentProviderFactory, type AgentProviderFetch } from '../../agents/providers/factory.ts'
import { createGeminiMediaTransport } from '../../agents/providers/gemini-media.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import { fixtureDecisionProviders } from './synthesis-fixture.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import type { AgentMediaGenerationInput } from '../../agents/providers/media-transport.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

const origin = 'https://generativelanguage.googleapis.com'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPQSNnyHwAEOAJA4ywNkQAAAABJRU5ErkJggg==',
  'base64'
)
const request = (kind: 'image' | 'video' | 'music' = 'image'): AgentEngineRequest => ({
  authorizeMedia: async () => {},
  mediaBindings: { [kind]: '00000000-0000-4000-8000-000000000099' },
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
    imageModel: 'gemini-3.1-flash-image',
    fetch
  })
  const factory = {
    createMediaBinding: async (_ownerId: number, kind: string) => {
      if (kind !== 'image') throw new AgentRepositoryError('AGENT_MEDIA_DISABLED', 'No provider is bound for this operation', 403)
      return {
        config: {
          kind: 'image',
          api: 'gemini-generate-content',
          model: 'gemini-3.1-flash-image',
          baseUrl: `${origin}/v1beta`,
          timeoutMs: 5000,
          maxInputTokens: 100000,
          maxOutputTokens: 4000,
          pricing: { kind: 'tokens', pricingRevision: 'image-v1|1000000|2000000' }
        },
        transport: {
          generate: async (input: AgentMediaGenerationInput, signal?: AbortSignal) => {
            const result = await transport.generateImage(
              { ...input, prompt: input.prompt ?? '', ...(input.files === undefined ? {} : { images: input.files }) },
              signal
            )
            return { ...result, files: result.images, usageSource: 'reported' as const }
          }
        }
      }
    }
  } as unknown as AgentProviderFactory
  return { urls, engine: new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }) }
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
    expect(media).toHaveBeenCalledWith([{ payload: png, mimeType: 'image/png', kind: 'generated-image', filename: 'generated-image-1.png' }])
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
    it(`rejects unbound ${kind} without reservation, dispatch, or publication`, async () => {
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
      ).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED' })
      expect(urls).toEqual([])
      expect(dispatchBudget.reserve).not.toHaveBeenCalled()
      expect(dispatchBudget.reconcile).not.toHaveBeenCalled()
      expect(dispatchBudget.release).not.toHaveBeenCalled()
      expect(media).not.toHaveBeenCalled()
    })

  for (const scenario of ['audio/webm', 'video/webm', 'openai-chat-webm'] as const)
    it(`enforces native format admission for decoded ${scenario}`, async () => {
      const mimeType = scenario === 'video/webm' ? 'video/webm' : 'audio/webm'
      const args =
        mimeType === 'audio/webm'
          ? ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.1', '-c:a', 'libopus']
          : ['-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=10', '-t', '0.1', '-c:v', 'libvpx-vp9', '-an']
      const { stdout } = await promisify(execFile)('ffmpeg', ['-v', 'error', ...args, '-f', 'webm', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 })
      const wire: unknown[] = []
      const service = ai({
        name: 'google-gemini',
        apiKey: 'fixture',
        config: { model: AxAIGoogleGeminiModel.Gemini25Flash, stream: false },
        options: {
          fetch: async (_url, init) => {
            wire.push(JSON.parse(String(init?.body)))
            return Response.json({
              candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Media analyzed.' }] } }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
            })
          }
        }
      })
      const upload = vi.fn(async () => ({ name: 'files/context', uri: `${origin}/v1beta/files/context`, mimeType }))
      const remove = vi.fn(async () => {})
      const dispatchBudget = budget()
      const factory = {
        create: async () => ({
          service,
          model: AxAIGoogleGeminiModel.Gemini25Flash,
          transportKind: scenario === 'openai-chat-webm' ? 'openai-chat' : 'gemini-api',
          capabilityRevision: 'fixture',
          pricingRevision: 'fixture',
          pricing: { revision: 'fixture', inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 2000000 },
          mediaInputs: { images: false, documents: false, audio: true, video: true },
          nativeMediaCapabilities: service.getFeatures().media,
          capabilities: {
            streaming: false,
            toolCalling: 'native',
            parallelToolCalls: false,
            structuredOutput: 'native-json-schema',
            usage: 'terminal',
            cancellation: true,
            maxContextTokens: 100000,
            maxOutputTokens: 4000
          }
        }),
        createMediaInput: async () => ({ config: { attachments: true }, transport: { upload, countTokens: async () => 20, delete: remove } })
      } as unknown as AgentProviderFactory
      const { mediaRequest: _mediaRequest, ...base } = request()
      const pending = new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
        {
          ...base,
          mediaBindings: {},
          dispatchBudget,
          run: { ...base.run, executionMode: 'generation-only' },
          messages: [
            {
              role: 'user',
              content: 'Analyze this media',
              attachments: [
                {
                  id: '00000000-0000-4000-8000-000000000088',
                  filename: 'context.webm',
                  mimeType,
                  byteLength: stdout.length,
                  payload: stdout
                }
              ]
            }
          ]
        },
        { text: async () => {}, event: async () => {} }
      )
      if (scenario === 'openai-chat-webm') {
        await expect(pending).rejects.toMatchObject({ code: 'AGENT_MEDIA_INPUT_UNSUPPORTED' })
        expect(upload).not.toHaveBeenCalled()
        expect(wire).toEqual([])
        expect(dispatchBudget.reserve).not.toHaveBeenCalled()
        return
      }
      const result = await pending
      expect(result.totalTokens).toBe(12)
      expect(upload).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(wire)).toContain(`${origin}/v1beta/files/context`)
      expect(JSON.stringify(wire)).toContain(mimeType)
      expect(JSON.stringify(wire)).not.toContain(stdout.toString('base64'))
      expect(remove).toHaveBeenCalledTimes(1)
    })
})
