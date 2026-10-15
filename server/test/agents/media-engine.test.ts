import { execFile } from 'node:child_process'
import type { lookup } from 'node:dns/promises'
import { promisify } from 'node:util'
import createKnex, { type Knex } from 'knex'
import sharp from 'sharp'
import { z } from 'zod'
import { ai, AxAIGoogleGeminiModel } from '@ax-llm/ax'
import { AxAgentEngine, type AgentActionSessionProvider } from '../../agents/providers/engine.ts'
import { AgentProviderFactory, type AgentProviderFetch } from '../../agents/providers/factory.ts'
import { createGeminiMediaTransport } from '../../agents/providers/gemini-media.ts'
import { ACTION_CATALOG } from '../../agents/actions/catalog.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import { prepareAgentPdf } from '../../agents/pdf-preparation.ts'
import { fixtureDecisionProviders } from './synthesis-fixture.ts'
import { PdfFixtureDocument } from './pdf-fixture.ts'
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

describe('ordinary Gemini attachment setup through the production factory', () => {
  const model = 'gemini-3.8-flash'
  const versionId = '00000000-0000-4000-8000-000000000006'
  const capabilities = {
    streaming: true,
    toolCalling: 'native',
    parallelToolCalls: true,
    structuredOutput: 'native-json-schema',
    usage: 'stream',
    cancellation: true,
    maxContextTokens: 400_000,
    maxOutputTokens: 32_768
  }
  const pdf = (): Buffer => {
    const document = new PdfFixtureDocument()
    const catalog = document.reserveObject()
    const pages = document.reserveObject()
    const page = document.reserveObject()
    const content = document.addStream('', Buffer.alloc(0))
    document.setObject(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`)
    document.setObject(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`)
    document.setObject(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${content} 0 R >>`)
    return document.toBuffer(catalog)
  }
  const seed = async (db: Knex, legacy: boolean): Promise<void> => {
    await db.schema.createTable('agentProviderProfiles', table => {
      table.uuid('id').primary()
      table.uuid('currentVersionId')
      table.boolean('conformed')
      table.string('status')
      table.dateTime('deletedAt').nullable()
    })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.uuid('profileId')
      table.string('transportKind')
      table.string('model')
      table.string('utilityModel').nullable()
      table.string('baseUrl')
      table.string('authMode')
      table.string('secretReference')
      table.text('adapterConfig')
      table.text('capabilities')
      table.string('capabilityRevision')
      table.string('pricingRevision')
      table.boolean('conformed')
    })
    await db('agentProviderProfiles').insert({ id: 'profile', currentVersionId: versionId, conformed: true, status: 'enabled', deletedAt: null })
    await db('agentProviderProfileVersions').insert({
      id: versionId,
      profileId: 'profile',
      transportKind: 'gemini-api',
      model,
      utilityModel: 'gemini-3.1-flash-lite',
      baseUrl: `${origin}/v1beta`,
      authMode: 'google-api-key',
      secretReference: 'fixture-llm-input',
      adapterConfig: JSON.stringify({
        timeoutMs: 120_000,
        maxRetries: 0,
        additionalHeaders: {},
        ...(legacy ? { media: { attachments: true } } : { mediaInputs: { images: true, documents: true, audio: false, video: false } })
      }),
      capabilities: JSON.stringify(capabilities),
      capabilityRevision: 'wiki-protocol-capabilities-v4:gemini-api',
      pricingRevision: 'fixture-main|1000000|2000000',
      conformed: true
    })
  }

  for (const mimeType of ['image/png', 'application/pdf'] as const)
    for (const legacy of [true, false])
      it(`uploads, natively counts and dispatches a lazy ${mimeType} with ${legacy ? 'historical' : 'explicit'} input policy`, async () => {
        if (mimeType === 'image/png') expect(await sharp(png).raw().toBuffer()).toHaveLength(4)
        const payload = mimeType === 'image/png' ? png : pdf()
        const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
        try {
          await seed(db, legacy)
          const remote = { name: 'files/context', uri: `${origin}/v1beta/files/context`, mimeType, state: 'ACTIVE', sizeBytes: String(payload.length) }
          const wire: { url: string; init: RequestInit }[] = []
          const dispatchBudget = budget()
          const authorizePayload = vi.fn(async (signal: AbortSignal) => signal.throwIfAborted())
          const loadPayload = vi.fn(async (signal: AbortSignal) => {
            signal.throwIfAborted()
            return payload
          })
          const recordPromptTokens = vi.fn(async (_tokens: number) => {})
          const implementation = Object.assign(
            async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
              const url = String(input)
              wire.push({ url, init: init ?? {} })
              if (url === `${origin}/upload/v1beta/files`)
                return new Response(null, { headers: { 'x-goog-upload-url': `${origin}/upload/v1beta/files?upload_id=context&upload_protocol=resumable` } })
              if (url === `${origin}/upload/v1beta/files?upload_id=context&upload_protocol=resumable`) {
                expect(Buffer.from(init?.body as Uint8Array)).toEqual(payload)
                expect(authorizePayload.mock.calls.length).toBeGreaterThanOrEqual(2)
                expect(dispatchBudget.reserve).not.toHaveBeenCalled()
                return Response.json({ file: remote })
              }
              if (url === `${origin}/v1beta/models/${model}:countTokens`) return Response.json({ totalTokens: 258 })
              if (url === `${origin}/v1beta/models/${model}:streamGenerateContent?alt=sse`) {
                const generation = JSON.parse(String(init?.body))
                const synthesis = generation.generationConfig?.responseJsonSchema !== undefined
                expect(dispatchBudget.reserve).toHaveBeenCalledTimes(synthesis ? 2 : 1)
                if (synthesis) {
                  expect(generation.generationConfig.responseMimeType).toBe('application/json')
                  expect(generation.generationConfig.responseJsonSchema.properties).toMatchObject({
                    claims: { type: 'array' },
                    unresolvedFacets: { type: 'array' },
                    observations: { type: 'array' }
                  })
                  expect(wire.filter(operation => operation.url === remote.uri && operation.init.method === 'DELETE')).toHaveLength(1)
                }
                // Collector and typed synthesis both stream on this profile. The
                // response must follow the actual request's schema, not its URL.
                const content = synthesis
                  ? JSON.stringify({ claims: [], unresolvedFacets: [0], observations: [], recommendations: '' })
                  : 'The attachment is available.'
                return new Response(
                  `data: ${JSON.stringify({
                    responseId: synthesis ? 'fixture-synthesis-response' : 'fixture-response',
                    modelVersion: model,
                    candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: content }] } }],
                    usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 5, totalTokenCount: 505 }
                  })}\n\n`,
                  { headers: { 'content-type': 'text/event-stream' } }
                )
              }
              if (url === remote.uri && init?.method === 'DELETE') return new Response(null, { status: 204 })
              throw new Error('Unexpected fixture provider operation')
            },
            { preconnect: () => {} }
          ) as AgentProviderFetch
          const resolve = (async () => [{ address: '142.250.1.1', family: 4 }]) as unknown as typeof lookup
          const factory = new AgentProviderFactory(db, { get: async () => 'fixture-key' }, implementation, resolve)
          const close = vi.fn()
          const actions: AgentActionSessionProvider = {
            open: async () => ({
              functions: [
                {
                  name: 'pages.get',
                  description: ACTION_CATALOG['pages.get'].descriptor.description,
                  risk: 'read',
                  group: 'core',
                  capability: ACTION_CATALOG['pages.get'].capability,
                  parameters: z.toJSONSchema(ACTION_CATALOG['pages.get'].input)
                }
              ],
              authoritySha256: null,
              invoke: async () => {
                throw new Error('The media fixture must not execute Wiki actions')
              },
              snapshot: async () => ({}),
              close
            })
          }
          const engine = new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders })
          const { mediaRequest: _mediaRequest, ...base } = request()
          const text = vi.fn(async (_content: string) => {})
          const engineRequest: AgentEngineRequest = {
            ...base,
            generationTools: [],
            mediaBindings: {},
            dispatchBudget,
            messages: [
              {
                role: 'user',
                content: 'Briefly describe the attached file.',
                attachments: [
                  {
                    id: '00000000-0000-4000-8000-000000000088',
                    filename: mimeType === 'image/png' ? 'pixel.png' : 'brief.pdf',
                    mimeType,
                    byteLength: payload.length,
                    ...(mimeType === 'application/pdf' ? { preparePdf: (signal: AbortSignal) => prepareAgentPdf(payload, signal) } : { loadPayload }),
                    authorizePayload,
                    recordPromptTokens
                  }
                ]
              }
            ]
          }
          expect(await engine.preflight(engineRequest)).toMatchObject({
            admissible: true,
            inputExposureTokens: 383_616,
            outputExposureTokens: 16_384,
            totalExposureTokens: 400_000,
            inputExposureUsesFullWindowBound: true
          })
          expect(wire).toEqual([])
          expect(dispatchBudget.reserve).not.toHaveBeenCalled()
          const result = await engine.execute(engineRequest, { text, event: async () => {} })
          expect(result.totalTokens).toBe(1_010)
          const published = text.mock.calls.map(([content]) => content).join('')
          expect(published.trim().length).toBeGreaterThan(0)
          expect(published).not.toContain('The attachment is available.')
          expect(published).not.toContain('[[cite:')
          expect(published).not.toContain('"unresolvedFacets"')
          expect(wire.filter(({ url }) => url === `${origin}/upload/v1beta/files`)).toHaveLength(1)
          expect(wire.filter(({ url }) => url === `${origin}/upload/v1beta/files?upload_id=context&upload_protocol=resumable`)).toHaveLength(1)
          const counts = wire.filter(({ url }) => url === `${origin}/v1beta/models/${model}:countTokens`)
          expect(counts).toHaveLength(1)
          const count = JSON.parse(String(counts[0]?.init.body))
          expect(count.contents[0].parts).toEqual([{ fileData: { fileUri: remote.uri, mimeType } }])
          const generations = wire.filter(({ url }) => url === `${origin}/v1beta/models/${model}:streamGenerateContent?alt=sse`)
          expect(generations).toHaveLength(2)
          const generation = JSON.parse(String(generations[0]?.init.body))
          expect(generation.contents.find((content: { role: string }) => content.role === 'user').parts).toEqual(
            expect.arrayContaining([{ fileData: { fileUri: remote.uri, mimeType } }])
          )
          expect(JSON.stringify(generation)).not.toContain('wiki-media:')
          expect(JSON.stringify(generation)).not.toContain(payload.toString('base64'))
          const synthesis = JSON.parse(String(generations[1]?.init.body))
          expect(JSON.stringify(synthesis)).not.toContain(remote.uri)
          expect(JSON.stringify(synthesis)).not.toContain(payload.toString('base64'))
          expect(wire.filter(({ url, init }) => url === remote.uri && init.method === 'DELETE')).toHaveLength(1)
          expect(recordPromptTokens).toHaveBeenCalledWith(258)
          expect(recordPromptTokens).toHaveBeenCalledTimes(1)
          expect(dispatchBudget.reconcile).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ inputTokens: 500, outputTokens: 5, totalTokens: 505 })
          )
          expect(dispatchBudget.reconcile).toHaveBeenCalledTimes(2)
          expect(close).toHaveBeenCalledTimes(2)
          expect(dispatchBudget.release).not.toHaveBeenCalled()
          if (mimeType === 'image/png') expect(loadPayload).toHaveBeenCalledTimes(1)
        } finally {
          await db.destroy()
        }
      })

  it('does not label an oversized serialized media frame as a whole-window bound', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    try {
      await seed(db, false)
      let providerCalls = 0
      const implementation = Object.assign(
        async () => {
          providerCalls++
          throw new Error('Preflight must not transfer attachments or call a provider')
        },
        {
          preconnect: () => {
            providerCalls++
          }
        }
      ) as AgentProviderFetch
      const resolve = (async () => [{ address: '142.250.1.1', family: 4 }]) as unknown as typeof lookup
      const engine = new AxAgentEngine(new AgentProviderFactory(db, { get: () => 'fixture-key' }, implementation, resolve))
      const { mediaRequest: _mediaRequest, ...base } = request()
      const result = await engine.preflight({
        ...base,
        generationTools: [],
        mediaBindings: {},
        messages: [
          { role: 'user', content: 'Canonical history. '.repeat(8_000) },
          { role: 'user', content: 'More canonical history. '.repeat(8_000) },
          {
            role: 'user',
            content: 'Final canonical history. '.repeat(8_000),
            attachments: [{ id: '00000000-0000-4000-8000-000000000088', filename: 'pixel.png', mimeType: 'image/png', byteLength: png.length, payload: png }]
          }
        ]
      })
      expect(result.admissible).toBe(false)
      expect(result.inputExposureTokens + result.outputExposureTokens).toBeGreaterThan(capabilities.maxContextTokens)
      expect(result.inputExposureUsesFullWindowBound).not.toBe(true)
      expect(providerCalls).toBe(0)
    } finally {
      await db.destroy()
    }
  })
})
