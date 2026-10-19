import { execFile } from 'node:child_process'
import type { lookup } from 'node:dns/promises'
import { promisify } from 'node:util'
import createKnex, { type Knex } from 'knex'
import sharp from 'sharp'
import { z } from 'zod'
import { ai, AxAIGoogleGeminiModel, type AxChatRequest, type AxChatResponse } from '@ax-llm/ax'
import { AGENT_TOOL_NAMES } from '../../../shared/agents/contracts.ts'
import { AxAgentEngine, type AgentActionSessionProvider } from '../../agents/providers/engine.ts'
import { AgentProviderFactory, type AgentProviderFetch, type AgentProviderService } from '../../agents/providers/factory.ts'
import { createGeminiMediaTransport } from '../../agents/providers/gemini-media.ts'
import { ACTION_CATALOG } from '../../agents/actions/catalog.ts'
import { issueWikiLineSnapshot, WikiLineSnapshotV1Schema } from '../../agents/patch/wiki-line-patch.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import { prepareAgentPdf } from '../../agents/pdf-preparation.ts'
import { fixtureDecisionProviders, fullAxFixtureService } from './synthesis-fixture.ts'
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
const setup = (response: () => Response, llm?: { readonly provider: AgentProviderService; readonly actions: AgentActionSessionProvider }) => {
  const urls: string[] = []
  const wire: { readonly url: string; readonly body: unknown }[] = []
  const fetch = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      wire.push({ url, body: init?.body })
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
    ...(llm === undefined ? {} : { create: async () => llm.provider }),
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
  return { urls, wire, engine: new AxAgentEngine(factory, llm?.actions, undefined, { decisionProviders: fixtureDecisionProviders }) }
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

  it('blocks copied private Wiki bytes at final media dispatch after an authorized collector delivery', async () => {
    const privateFact = 'PRIVATE-WIKI-IMAGE: use the unreleased copper observatory design.'
    const snapshot = issueWikiLineSnapshot({
      page: { id: 42, locale: 'en', path: 'private-observatory', contentType: 'markdown' },
      sourceRevision: '1', source: `# Observatory\n\n${privateFact}`,
      requesterScope: 'fixture-owner-7', signingSecret: Buffer.alloc(32, 7)
    })
    const originalSnapshot = JSON.stringify(snapshot)
    let sourceAuthorized = true
    let revokedAtMediaDispatch = false
    const sourceChecks: boolean[] = []
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        authoritySha256: null,
        functions: [{
          name: 'pages.readForPatch', title: 'Read observatory source', description: 'Read the authorized observatory source.',
          risk: 'read', group: 'core', capability: ACTION_CATALOG['pages.readForPatch'].capability,
          parameters: z.toJSONSchema(ACTION_CATALOG['pages.readForPatch'].input)
        }],
        invoke: async () => snapshot,
        validateObservation: async (name, observed, signal) => {
          const valid = !signal.aborted && sourceAuthorized && name === 'pages.readForPatch' && JSON.stringify(observed) === originalSnapshot
          sourceChecks.push(valid)
          return valid
        },
        snapshot: async () => ({}),
        close: () => {}
      })
    }
    const collectorRequests: Readonly<AxChatRequest>[] = []
    let copiedPrompt: string | undefined
    const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
      collectorRequests.push(input)
      let functionCall: { id: string; type: 'function'; function: { name: string; params: string } }
      if (collectorRequests.length === 1) {
        const read = input.functions?.find(tool => tool.name === AGENT_TOOL_NAMES['pages.readForPatch'])
        if (!read) throw new Error('Expected the admitted source read')
        functionCall = { id: 'private-source', type: 'function', function: { name: read.name, params: '{"pageId":42}' } }
      } else if (collectorRequests.length === 2) {
        const source = input.chatPrompt.find(message => message.role === 'function' && message.functionId === 'private-source')
        const image = input.functions?.find(tool => tool.name === 'wiki_generate_image')
        if (source?.role !== 'function' || !image) throw new Error('Expected a genuine source delivery and admitted image tool')
        copiedPrompt = WikiLineSnapshotV1Schema.parse(JSON.parse(source.result)).disclosed.flatMap(range => range.lines.map(line => line.text)).join('\n')
        functionCall = { id: 'private-image', type: 'function', function: { name: image.name, params: JSON.stringify({ prompt: copiedPrompt }) } }
      } else throw new Error('Unexpected collector dispatch after revoked media authority')
      return {
        results: [{ index: 0, finishReason: 'function_call', functionCalls: [functionCall] }],
        modelUsage: { ai: 'test', model: 'gemini-3.8-flash', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
      }
    })
    const fixture = setup(output, {
      actions,
      provider: {
        service: fullAxFixtureService(chat),
        capabilities: {
          streaming: false, toolCalling: 'native', parallelToolCalls: false, structuredOutput: 'native-json-schema',
          usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 512
        },
        mediaInputs: { images: false, documents: false, audio: false, video: false },
        transportKind: 'gemini-api', model: 'gemini-3.8-flash', continuationDialect: null,
        capabilityRevision: 'cap-1', pricingRevision: 'main-1',
        pricing: { revision: 'main-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 },
        preserveCachePrefix: false, preserveThoughtBlock: (_id, block) => block
      }
    })
    const dispatchBudget = budget()
    dispatchBudget.reserve.mockImplementation(async exposure => {
      if (fixture.urls.some(url => url.endsWith(':countTokens'))) {
        sourceAuthorized = false
        revokedAtMediaDispatch = true
      }
      return { id: 1, ...exposure }
    })
    const media = vi.fn(async () => [])
    const text = vi.fn(async () => {})
    const event = vi.fn(async (_type: string, _data: unknown) => {})
    const { mediaRequest: _directMediaRequest, ...base } = request()
    const failure = await fixture.engine.execute({
      ...base, dispatchBudget, generationTools: ['image'],
      messages: [{ role: 'user', content: 'Read the authorized observatory design and generate an image from that design.' }],
      limits: { maxTurns: 4, maxToolCalls: 4, maxTokens: 1_000_000, maxOutputTokens: 512 }
    }, { media, text, event }).then(() => undefined, (error: unknown) => error)
    expect(revokedAtMediaDispatch).toBe(true)
    expect(copiedPrompt).toContain(privateFact)
    expect(JSON.stringify(collectorRequests[1])).toContain(privateFact)
    expect(fixture.urls).toEqual([`${origin}/v1beta/models/gemini-3.1-flash-image:countTokens`])
    expect(String(fixture.wire[0]?.body)).toContain(privateFact)
    expect(failure).toMatchObject({ code: 'AGENT_EVIDENCE_INVALID' })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(sourceChecks).toContain(true)
    expect(sourceChecks).toContain(false)
    expect(media).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(event.mock.calls.some(([type, data]) => type === 'tool.completed' && typeof data === 'object' && data !== null && 'actionName' in data && data.actionName === 'media.generateImage')).toBe(false)
    expect(dispatchBudget.release).toHaveBeenCalledWith(expect.objectContaining({ tokens: 4_100 }))
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

  it.each([
    ['releases an unsent inline-file request when file authority expires during final production DNS', true],
    ['retains dispatched inline-file exposure after a real HTTP 503 without a usage receipt', false]
  ] as const)('%s', async (_name, expireDuringDns) => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    try {
      await seed(db, false)
      await db('agentProviderProfileVersions').where({ id: versionId }).update({
        transportKind: 'openai-responses', model: 'gpt-4.1-mini', utilityModel: null,
        baseUrl: 'https://api.openai.com/v1', authMode: 'bearer',
        adapterConfig: JSON.stringify({
          timeoutMs: 5_000, maxRetries: 0, additionalHeaders: {},
          mediaInputs: { images: true, documents: false, audio: false, video: false }
        }),
        capabilities: JSON.stringify({ ...capabilities, maxContextTokens: 100_000, maxOutputTokens: 1_024 }),
        capabilityRevision: 'wiki-protocol-capabilities-v4:openai-responses'
      })
      const held = new Map<number, { readonly tokens: number; readonly costMicros: number }>()
      let reservationId = 0
      const dispatchBudget = {
        reserve: vi.fn(async (maximum: { tokens: number; costMicros: number }) => {
          const reservation = { id: ++reservationId, ...maximum }
          held.set(reservation.id, maximum)
          return reservation
        }),
        release: vi.fn(async (reservation: { id: number }) => { held.delete(reservation.id) }),
        reconcile: vi.fn(async (reservation: { id: number }) => { held.delete(reservation.id) }),
        consumeTool: vi.fn(async () => {}),
        get unsettledExposure() {
          let tokens = 0
          let costMicros = 0
          for (const exposure of held.values()) {
            tokens += exposure.tokens
            costMicros += exposure.costMicros
          }
          return { tokens, costMicros }
        }
      }
      const wire: { readonly url: string; readonly body: unknown }[] = []
      const implementation = Object.assign(
        async (input: URL | RequestInfo, init?: RequestInit) => {
          wire.push({ url: String(input), body: init?.body })
          return new Response(null, { status: 503 })
        },
        { preconnect: () => {} }
      ) as AgentProviderFetch
      let fileAvailable = true
      let revokedDuringFinalDns = false
      let reachedFinalDns = false
      const fileChecks: boolean[] = []
      const authorizePayload = vi.fn(async (signal: AbortSignal) => {
        signal.throwIfAborted()
        fileChecks.push(fileAvailable)
        if (!fileAvailable) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'The selected file binding expired during DNS.', 500)
      })
      const loadPayload = vi.fn(async (signal: AbortSignal) => {
        signal.throwIfAborted()
        expect(fileAvailable).toBe(true)
        return png
      })
      const resolve = (async (hostname: string) => {
        if (hostname === 'api.openai.com' && loadPayload.mock.calls.length > 0 && dispatchBudget.reserve.mock.calls.length > 0) {
          reachedFinalDns = true
          if (expireDuringDns) {
            fileAvailable = false
            revokedDuringFinalDns = true
          }
        }
        return [{ address: '93.184.216.34', family: 4 }]
      }) as unknown as typeof lookup
      const engine = new AxAgentEngine(new AgentProviderFactory(db, { get: async () => 'fixture-key' }, implementation, resolve), undefined, undefined, {
        decisionProviders: fixtureDecisionProviders
      })
      const { mediaRequest: _mediaRequest, ...base } = request()
      const text = vi.fn(async () => {})
      const failure = await engine.execute({
        ...base,
        run: {
          ...base.run, transportKind: 'openai-responses', model: 'gpt-4.1-mini',
          capabilityRevision: 'wiki-protocol-capabilities-v4:openai-responses', pricingRevision: 'fixture-main|1000000|2000000'
        },
        generationTools: [], mediaBindings: {}, dispatchBudget,
        messages: [{
          role: 'user', content: 'Describe the authorized private image.',
          attachments: [{
            id: '00000000-0000-4000-8000-000000000088', filename: 'private-pixel.png',
            mimeType: 'image/png', byteLength: png.length, authorizePayload, loadPayload
          }]
        }],
        limits: { maxTurns: 2, maxToolCalls: 1, maxTokens: 1_000_000, maxOutputTokens: 512 }
      }, { text, event: async () => {} }).then(() => undefined, (error: unknown) => error)
      expect(reachedFinalDns).toBe(true)
      expect(loadPayload).toHaveBeenCalledOnce()
      expect(dispatchBudget.reserve).toHaveBeenCalledOnce()
      expect(dispatchBudget.reconcile).not.toHaveBeenCalled()
      expect(fileChecks).toContain(true)
      if (expireDuringDns) {
        expect(revokedDuringFinalDns).toBe(true)
        expect(wire).toEqual([])
        expect(failure).toMatchObject({ code: 'AGENT_MEDIA_CORRUPT' })
        expect(fileChecks).toContain(false)
        expect(dispatchBudget.release).toHaveBeenCalledOnce()
        expect(dispatchBudget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
      } else {
        expect(revokedDuringFinalDns).toBe(false)
        expect(fileChecks).not.toContain(false)
        expect(wire).toHaveLength(1)
        expect(wire[0]?.url).toBe('https://api.openai.com/v1/responses')
        expect(String(wire[0]?.body)).toContain(png.toString('base64'))
        expect(failure).toMatchObject({ stage: 'provider_request' })
        expect(dispatchBudget.release).not.toHaveBeenCalled()
        const reservation = await dispatchBudget.reserve.mock.results[0]!.value
        expect(dispatchBudget.unsettledExposure).toEqual({ tokens: reservation.tokens, costMicros: reservation.costMicros })
      }
      expect(text).not.toHaveBeenCalled()
      expect(await db('agentProviderProfiles').where({ id: 'profile' }).first('status')).toEqual({ status: 'enabled' })
    } finally {
      await db.destroy()
    }
  })

  for (const mimeType of ['image/png', 'application/pdf'] as const)
    for (const legacy of [true, false])
      for (const historical of [false, true])
        for (const revokeAt of mimeType === 'image/png' && !legacy && !historical
          ? [null, 'before-final-count', 'final-count', 'publication', 'profile-last-payload']
          : [null])
          for (const operationOnly of mimeType === 'image/png' && !legacy && !historical && revokeAt === null ? [false, true] : [false])
            for (const recountRevocation of mimeType === 'image/png' && !legacy && !historical && revokeAt === null && !operationOnly
              ? [null, 'aggregate', 'persisted']
              : [null])
              for (const receiptRevocation of mimeType === 'image/png' &&
              !legacy &&
              !historical &&
              revokeAt === null &&
              !operationOnly &&
              recountRevocation === null
                ? [null, 'dispatch', 'publication']
                : [null])
                it(`publishes attributed native ${mimeType} content from ${historical ? 'historical' : 'current'} input with ${legacy ? 'legacy' : 'explicit'} policy${revokeAt ? `; blocks revocation at ${revokeAt}` : ''}${operationOnly ? '; preserves a delivered image-edit receipt without claiming output pixels' : ''}${recountRevocation ? `; blocks multi-file recount after ${recountRevocation}` : ''}${receiptRevocation ? `; fences receipt grant revoked during ${receiptRevocation} payload authorization` : ''}`, async () => {
                  if (mimeType === 'image/png') expect(await sharp(png).raw().toBuffer()).toHaveLength(4)
                  const payload = mimeType === 'image/png' ? png : pdf()
                  const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
                  try {
                    await seed(db, legacy)
                    const remote = {
                      name: 'files/context',
                      uri: `${origin}/v1beta/files/context`,
                      mimeType,
                      state: 'ACTIVE',
                      sizeBytes: String(payload.length)
                    }
                    const finalRemote = { ...remote, name: 'files/final-context', uri: `${origin}/v1beta/files/final-context` }
                    const wire: { url: string; init: RequestInit }[] = []
                    const dispatchBudget = budget()
                    let uploadCount = 0
                    let revoked = false
                    let countCalls = 0
                    let receiptReadable = true
                    const authorizePayload = vi.fn(async (signal: AbortSignal) => {
                      signal.throwIfAborted()
                      if (revoked) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Attachment is detached from its admitted input binding.', 500)
                      const generations = wire.filter(({ url }) => url.includes(':streamGenerateContent')).length
                      if (revokeAt === 'profile-last-payload' && countCalls === 2 && generations === 1)
                        await db('agentProviderProfiles').where({ id: 'profile' }).update({ status: 'disabled' })
                      if (
                        (receiptRevocation === 'dispatch' && countCalls === 2 && generations === 1) ||
                        (receiptRevocation === 'publication' && generations === 3)
                      ) {
                        await Promise.resolve()
                        receiptReadable = false
                      }
                    })
                    const loadPayload = vi.fn(async (signal: AbortSignal) => {
                      signal.throwIfAborted()
                      return payload
                    })
                    const recordPromptTokens = vi.fn(async (_tokens: number) => {
                      if (recountRevocation === 'persisted') revoked = true
                    })
                    const implementation = Object.assign(
                      async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
                        const url = String(input)
                        wire.push({ url, init: init ?? {} })
                        if (url === `${origin}/upload/v1beta/files`) {
                          uploadCount++
                          return new Response(null, {
                            headers: { 'x-goog-upload-url': `${origin}/upload/v1beta/files?upload_id=context&upload_protocol=resumable` }
                          })
                        }
                        if (url === `${origin}/upload/v1beta/files?upload_id=context&upload_protocol=resumable`) {
                          expect(Buffer.from(init?.body as Uint8Array)).toEqual(payload)
                          expect(authorizePayload.mock.calls.length).toBeGreaterThanOrEqual(2)
                          expect(dispatchBudget.reserve).toHaveBeenCalledTimes(recountRevocation === null ? uploadCount - 1 : 0)
                          if (revokeAt === 'before-final-count' && uploadCount === 2) revoked = true
                          return Response.json({ file: uploadCount === 1 ? remote : finalRemote })
                        }
                        if (url === `${origin}/v1beta/models/${model}:countTokens`) {
                          countCalls++
                          if (recountRevocation === 'aggregate' && countCalls === 1) revoked = true
                          if (revokeAt === 'final-count' && countCalls === 2) revoked = true
                          return Response.json({ totalTokens: 258 })
                        }
                        if (url === `${origin}/v1beta/models/${model}:streamGenerateContent?alt=sse`) {
                          const generation = JSON.parse(String(init?.body))
                          const schema = generation.generationConfig?.responseJsonSchema
                          const coverage = schema?.properties?.verdict !== undefined
                          const synthesis = schema?.properties?.claims !== undefined
                          expect(dispatchBudget.reserve).toHaveBeenCalledTimes(coverage ? 4 : synthesis ? 2 : 1)
                          if (synthesis) {
                            expect(generation.generationConfig.responseMimeType).toBe('application/json')
                            expect(generation.generationConfig.responseJsonSchema.properties).toMatchObject({
                              claims: { type: 'array' },
                              unresolvedFacets: { type: 'array' },
                              observations: { type: 'array' }
                            })
                            expect(wire.filter(operation => operation.url === remote.uri && operation.init.method === 'DELETE')).toHaveLength(1)
                          }
                          if (coverage && revokeAt === 'publication') revoked = true
                          // Collector and typed synthesis both stream on this profile. The
                          // response must follow the actual request's schema, not its URL.
                          const content = coverage
                            ? JSON.stringify({ verdict: 'complete', feedback: '' })
                            : synthesis
                              ? JSON.stringify(
                                  operationOnly
                                    ? {
                                        claims: [],
                                        attachmentClaims: [],
                                        unresolvedFacets: [],
                                        observations: ['1 image artifact generated.'],
                                        recommendations: ''
                                      }
                                    : {
                                        claims: [],
                                        attachmentClaims: [
                                          {
                                            mediaId: '00000000-0000-4000-8000-000000000088',
                                            statement:
                                              mimeType === 'image/png' ? 'The provided image contains a single pixel.' : 'The provided document has one page.'
                                          }
                                        ],
                                        unresolvedFacets: [],
                                        observations:
                                          receiptRevocation === null
                                            ? []
                                            : [
                                                'Wiki proposal application status: applied.',
                                                `Proposal: 00000000-0000-4000-8000-000000000020; result hash: ${'b'.repeat(64)}.`
                                              ],
                                        recommendations: ''
                                      }
                                )
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
                        if ((url === remote.uri || url === finalRemote.uri) && init?.method === 'DELETE') return new Response(null, { status: 204 })
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
                            name: operationOnly ? 'media.generateImage' : 'pages.get',
                            description: ACTION_CATALOG[operationOnly ? 'media.generateImage' : 'pages.get'].descriptor.description,
                            risk: 'read',
                            group: 'core',
                            capability: ACTION_CATALOG[operationOnly ? 'media.generateImage' : 'pages.get'].capability,
                            parameters: z.toJSONSchema(ACTION_CATALOG[operationOnly ? 'media.generateImage' : 'pages.get'].input)
                          },
                          ...(receiptRevocation === null
                            ? []
                            : [
                                {
                                  name: 'pages.applyProposal' as const,
                                  description: ACTION_CATALOG['pages.applyProposal'].descriptor.description,
                                  risk: ACTION_CATALOG['pages.applyProposal'].descriptor.risk,
                                  group: ACTION_CATALOG['pages.applyProposal'].group,
                                  capability: ACTION_CATALOG['pages.applyProposal'].capability,
                                  parameters: z.toJSONSchema(ACTION_CATALOG['pages.applyProposal'].input)
                                }
                              ])
                        ],
                        authoritySha256: null,
                        invoke: async () => {
                          throw new Error('The media fixture must not execute Wiki actions')
                        },
                        snapshot: async () => ({}),
                        validateObservation: async () => receiptReadable,
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
                      authorizeDispatch: async () => {
                        const profile = await db('agentProviderProfiles').where({ id: 'profile', status: 'enabled' }).first('id')
                        if (!profile) throw new AgentRepositoryError('PROFILE_VERSION_CHANGED', 'Provider disabled before dispatch.', 409)
                      },
                      ...(operationOnly
                        ? {
                            recoveredAction: {
                              actionCallId: '00000000-0000-4000-8000-000000000099',
                              actionName: 'media.generateImage',
                              actionInput: { prompt: 'Edit the provided image.', attachmentIds: ['00000000-0000-4000-8000-000000000088'] },
                              output: { generated: true, count: 1 }
                            }
                          }
                        : {}),
                      ...(receiptRevocation === null
                        ? {}
                        : {
                            recoveredAction: {
                              actionCallId: '00000000-0000-4000-8000-000000000098',
                              actionName: 'pages.applyProposal',
                              actionInput: { proposalId: '00000000-0000-4000-8000-000000000020', approvalId: '00000000-0000-4000-8000-000000000021' },
                              output: { proposalId: '00000000-0000-4000-8000-000000000020', status: 'applied', resultHash: 'b'.repeat(64), page: null }
                            }
                          }),
                      messages: [
                        {
                          role: 'user',
                          content: operationOnly ? 'Edit the attached image.' : 'Briefly describe the attached file.',
                          attachments: [
                            {
                              id: '00000000-0000-4000-8000-000000000088',
                              filename: mimeType === 'image/png' ? 'pixel.png' : 'brief.pdf',
                              mimeType,
                              byteLength: payload.length,
                              ...(mimeType === 'application/pdf' ? { preparePdf: (signal: AbortSignal) => prepareAgentPdf(payload, signal) } : { loadPayload }),
                              authorizePayload,
                              recordPromptTokens
                            },
                            ...(recountRevocation === null
                              ? []
                              : [
                                  {
                                    id: '00000000-0000-4000-8000-000000000089',
                                    filename: 'second-pixel.png',
                                    mimeType,
                                    byteLength: payload.length,
                                    loadPayload,
                                    authorizePayload,
                                    recordPromptTokens
                                  }
                                ])
                          ]
                        },
                        ...(historical
                          ? [
                              {
                                role: 'assistant' as const,
                                content: 'I can inspect that file.',
                                attachments: [
                                  {
                                    id: '00000000-0000-4000-8000-000000000090',
                                    filename: 'generated-not-input.png',
                                    mimeType: 'image/png',
                                    byteLength: png.length,
                                    loadPayload: async () => {
                                      throw new Error('Assistant-generated artifacts must not be replayed as user input')
                                    }
                                  }
                                ]
                              },
                              { role: 'user' as const, content: 'Briefly describe the file attached earlier.' }
                            ]
                          : [])
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
                    if (recountRevocation !== null) {
                      await expect(engine.execute(engineRequest, { text, event: async () => {} })).rejects.toMatchObject({ code: 'AGENT_MEDIA_CORRUPT' })
                      expect(countCalls).toBe(recountRevocation === 'aggregate' ? 1 : 2)
                      expect(recordPromptTokens).toHaveBeenCalledTimes(recountRevocation === 'aggregate' ? 0 : 1)
                      expect(text).not.toHaveBeenCalled()
                      expect(wire.filter(({ url }) => url.includes(':streamGenerateContent'))).toHaveLength(0)
                      expect(wire.filter(({ init }) => init.method === 'DELETE')).toHaveLength(2)
                      return
                    }
                    if (receiptRevocation !== null) {
                      await expect(engine.execute(engineRequest, { text, event: async () => {} })).rejects.toMatchObject({ code: 'AGENT_EVIDENCE_INVALID' })
                      expect(text).not.toHaveBeenCalled()
                      expect(wire.filter(({ url }) => url.includes(':streamGenerateContent'))).toHaveLength(receiptRevocation === 'dispatch' ? 1 : 3)
                      expect(wire.filter(({ init }) => init.method === 'DELETE')).toHaveLength(2)
                      return
                    }
                    if (revokeAt !== null) {
                      await expect(engine.execute(engineRequest, { text, event: async () => {} })).rejects.toMatchObject({
                        code: revokeAt === 'profile-last-payload' ? 'PROVIDER_REQUEST_FAILED' : 'AGENT_MEDIA_CORRUPT'
                      })
                      expect(text).not.toHaveBeenCalled()
                      expect(wire.filter(({ url, init }) => (url === remote.uri || url === finalRemote.uri) && init.method === 'DELETE')).toHaveLength(2)
                      const generations = wire.filter(({ url }) => url === `${origin}/v1beta/models/${model}:streamGenerateContent?alt=sse`)
                      expect(generations).toHaveLength(revokeAt === 'publication' ? 3 : 1)
                      expect(countCalls).toBe(revokeAt === 'before-final-count' ? 1 : 2)
                      return
                    }
                    const result = await engine.execute(engineRequest, { text, event: async () => {} })
                    expect(result.totalTokens).toBe(operationOnly ? 1_010 : 1_515)
                    const published = text.mock.calls.map(([content]) => content).join('')
                    if (operationOnly) {
                      expect(published).toContain('1 image artifact generated.')
                      expect(published).not.toContain('single pixel')
                      expect(published).not.toMatch(/no Wiki|unable|cannot|partial/iu)
                    } else {
                      expect(published).toContain(mimeType === 'image/png' ? 'single pixel' : 'one page')
                    }
                    expect(published).not.toContain('The attachment is available.')
                    expect(published).not.toContain('[[cite:')
                    expect(published).not.toContain('"unresolvedFacets"')
                    expect(wire.filter(({ url }) => url === `${origin}/upload/v1beta/files`)).toHaveLength(2)
                    expect(wire.filter(({ url }) => url === `${origin}/upload/v1beta/files?upload_id=context&upload_protocol=resumable`)).toHaveLength(2)
                    const counts = wire.filter(({ url }) => url === `${origin}/v1beta/models/${model}:countTokens`)
                    expect(counts).toHaveLength(2)
                    const count = JSON.parse(String(counts[0]?.init.body))
                    expect(count.contents[0].parts).toEqual([{ fileData: { fileUri: remote.uri, mimeType } }])
                    expect(JSON.parse(String(counts[1]?.init.body)).contents[0].parts).toEqual([{ fileData: { fileUri: finalRemote.uri, mimeType } }])
                    const generations = wire.filter(({ url }) => url === `${origin}/v1beta/models/${model}:streamGenerateContent?alt=sse`)
                    expect(generations).toHaveLength(operationOnly ? 2 : 3)
                    const generation = JSON.parse(String(generations[0]?.init.body))
                    expect(generation.contents.find((content: { role: string }) => content.role === 'user').parts).toEqual(
                      expect.arrayContaining([{ fileData: { fileUri: remote.uri, mimeType } }])
                    )
                    expect(JSON.stringify(generation)).not.toContain('wiki-media:')
                    expect(JSON.stringify(generation)).not.toContain(payload.toString('base64'))
                    const synthesis = JSON.parse(String(generations[1]?.init.body))
                    expect(synthesis.contents.flatMap((content: { parts: unknown[] }) => content.parts)).toContainEqual({
                      fileData: { fileUri: finalRemote.uri, mimeType }
                    })
                    expect(JSON.stringify(synthesis)).not.toContain(remote.uri)
                    expect(JSON.stringify(synthesis)).not.toContain(payload.toString('base64'))
                    expect(wire.filter(({ url, init }) => url === remote.uri && init.method === 'DELETE')).toHaveLength(1)
                    expect(wire.filter(({ url, init }) => url === finalRemote.uri && init.method === 'DELETE')).toHaveLength(1)
                    expect(recordPromptTokens).toHaveBeenCalledWith(258)
                    expect(recordPromptTokens).toHaveBeenCalledTimes(2)
                    expect(dispatchBudget.reconcile).toHaveBeenCalledWith(
                      expect.anything(),
                      expect.objectContaining({ inputTokens: 500, outputTokens: 5, totalTokens: 505 })
                    )
                    expect(dispatchBudget.reconcile).toHaveBeenCalledTimes(operationOnly ? 2 : 4)
                    if (!operationOnly) {
                      expect(dispatchBudget.reserve).toHaveBeenCalledWith({ tokens: 64_000, costMicros: 0 })
                      expect(dispatchBudget.reconcile).toHaveBeenCalledWith(
                        expect.anything(),
                        expect.objectContaining({
                          inputTokens: 0,
                          outputTokens: 0,
                          totalTokens: 0,
                          costMicros: 0
                        })
                      )
                    }
                    expect(close).toHaveBeenCalledTimes(2)
                    expect(dispatchBudget.release).not.toHaveBeenCalled()
                    if (mimeType === 'image/png') expect(loadPayload).toHaveBeenCalledTimes(2)
                  } finally {
                    await db.destroy()
                  }
                })

  it('keeps tool-only image references outside native attachment-content authority', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    try {
      await seed(db, false)
      await db('agentProviderProfileVersions')
        .where({ id: versionId })
        .update({
          adapterConfig: JSON.stringify({
            timeoutMs: 120_000,
            maxRetries: 0,
            additionalHeaders: {},
            mediaInputs: { images: false, documents: true, audio: false, video: false }
          })
        })
      const generations: unknown[] = []
      const implementation = Object.assign(
        async (input: URL | RequestInfo, init?: RequestInit) => {
          expect(String(input)).toBe(`${origin}/v1beta/models/${model}:streamGenerateContent?alt=sse`)
          const generation = JSON.parse(String(init?.body))
          generations.push(generation)
          const synthesis = generation.generationConfig?.responseJsonSchema !== undefined
          return new Response(
            `data: ${JSON.stringify({
              candidates: [
                {
                  index: 0,
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: [
                      {
                        text: synthesis
                          ? JSON.stringify({ claims: [], attachmentClaims: [], observations: [], unresolvedFacets: [0], recommendations: '' })
                          : 'Collector prose claims the unavailable image is red.'
                      }
                    ]
                  }
                }
              ],
              usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 5, totalTokenCount: 505 }
            })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } }
          )
        },
        { preconnect: () => {} }
      ) as AgentProviderFetch
      const resolve = (async () => [{ address: '142.250.1.1', family: 4 }]) as unknown as typeof lookup
      const action = ACTION_CATALOG['media.generateImage']
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            {
              name: 'media.generateImage',
              description: action.descriptor.description,
              risk: action.descriptor.risk,
              group: action.group,
              capability: action.capability,
              parameters: z.toJSONSchema(action.input)
            }
          ],
          authoritySha256: null,
          invoke: async () => {
            throw new Error('This description request must not generate an image')
          },
          snapshot: async () => ({}),
          close: () => {}
        })
      }
      const engine = new AxAgentEngine(new AgentProviderFactory(db, { get: async () => 'fixture-key' }, implementation, resolve), actions, undefined, {
        decisionProviders: fixtureDecisionProviders
      })
      const { mediaRequest: _mediaRequest, ...base } = request()
      const loadPayload = vi.fn(async () => {
        throw new Error('Tool-only references have no native content permission')
      })
      const text = vi.fn(async (_content: string) => {})
      await engine.execute(
        {
          ...base,
          generationTools: [],
          mediaBindings: {},
          messages: [
            {
              role: 'user',
              content: 'Describe the attached image.',
              attachments: [
                {
                  id: '00000000-0000-4000-8000-000000000088',
                  filename: 'pixel.png',
                  mimeType: 'image/png',
                  byteLength: png.length,
                  loadPayload
                }
              ]
            }
          ]
        },
        { text, event: async () => {} }
      )
      expect(generations).toHaveLength(2)
      for (const generation of generations) expect(JSON.stringify(generation)).not.toMatch(/fileData|inlineData|wiki-media:/u)
      expect(loadPayload).not.toHaveBeenCalled()
      expect(text.mock.calls.map(([content]) => content).join('')).not.toMatch(/image is red|Collector prose|Provided file/u)
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
