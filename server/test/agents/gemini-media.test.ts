import type { lookup } from 'node:dns/promises'
import createKnex, { type Knex } from 'knex'
import { ai, type AxAIGoogleGeminiModel } from '@ax-llm/ax'
import { AgentProviderAttemptError, AgentProviderFactory, type AgentProviderFetch, createGuardedProviderFetch } from '../../agents/providers/factory.ts'
import { createGeminiMediaTransport, GEMINI_MEDIA_INPUT_LIMIT, GEMINI_MEDIA_OUTPUT_LIMIT, GEMINI_PDF_INPUT_LIMIT } from '../../agents/providers/gemini-media.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

const origin = 'https://generativelanguage.googleapis.com'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPQSNnyHwAEOAJA4ywNkQAAAABJRU5ErkJggg==',
  'base64'
)
const file = (state = 'ACTIVE') => ({
  name: 'files/abc123',
  uri: `${origin}/v1beta/files/abc123`,
  mimeType: 'image/png',
  sizeBytes: String(png.length),
  state
})
const usage = { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 }
const generated = (parts: unknown[] = [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }]) => ({
  candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }],
  usageMetadata: usage
})

describe('Gemini media egress guard', () => {
  const resolve = (async () => [{ address: '142.250.1.1', family: 4 }]) as unknown as typeof lookup
  it('permits only explicit media methods and paths, keeping ordinary chat uploads disabled', async () => {
    const calls: string[] = []
    const implementation = Object.assign(
      async (input: URL | RequestInfo) => {
        calls.push(String(input))
        return Response.json({})
      },
      { preconnect: () => {} }
    ) as AgentProviderFetch
    const guard = createGuardedProviderFetch(`${origin}/v1beta`, 'gemini-media', {}, implementation, resolve)
    await guard(`${origin}/upload/v1beta/files`, {
      method: 'POST',
      body: '{}'
    })
    await guard(`${origin}/upload/v1beta/files?upload_id=abc&upload_protocol=resumable`, { method: 'POST', body: png })
    await guard(`${origin}/v1beta/files/abc`, { method: 'GET' })
    await guard(`${origin}/v1beta/files/abc`, { method: 'DELETE' })
    await guard(`${origin}/v1beta/models/gemini-3.1-flash-image:generateContent`, { method: 'POST', body: '{}' })
    await guard(`${origin}/v1beta/models/gemini-3.5-transcribe:countTokens`, { method: 'POST', body: '{}' })
    for (const [path, method] of [
      ['/v1beta/files', 'GET'],
      ['/v1beta/files/abc', 'POST'],
      ['/v1beta/interactions', 'GET'],
      ['/v1beta/interactions', 'POST'],
      ['/upload/v1beta/files', 'DELETE'],
      ['/upload/v1beta/files?upload_id=abc&api_key=secret', 'POST'],
      ['/v1beta/models', 'GET'],
      ['/v1beta/files/abc:download', 'GET'],
      ['/v1beta/files/abc:download?alt=media', 'GET']
    ])
      await expect(guard(`${origin}${path}`, { method })).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    await expect(
      guard(`${origin}/upload/v1beta/files`, {
        method: 'POST',
        body: Buffer.alloc(GEMINI_MEDIA_INPUT_LIMIT + 1)
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    const ordinary = createGuardedProviderFetch(`${origin}/v1beta`, 'gemini-chat', {}, implementation, resolve)
    await expect(ordinary(`${origin}/upload/v1beta/files`, { method: 'POST', body: png })).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    expect(calls).toHaveLength(6)
  })

  it('allows larger prepared PDFs only on the Files upload path', async () => {
    let calls = 0
    const implementation = Object.assign(
      async () => {
        calls++
        return Response.json({})
      },
      { preconnect: () => {} }
    ) as AgentProviderFetch
    const guard = createGuardedProviderFetch(`${origin}/v1beta`, 'gemini-media', {}, implementation, resolve)
    const body = Buffer.alloc(GEMINI_MEDIA_INPUT_LIMIT + 1)
    body.write('%PDF-1.7')
    await guard(`${origin}/upload/v1beta/files?upload_id=abc`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body })
    for (const [path, type, bytes] of [
      ['/v1beta/models/gemini-3.1-flash-image:generateContent', 'application/pdf', body],
      ['/upload/v1beta/files?upload_id=abc', 'image/png', body],
      ['/upload/v1beta/files?upload_id=abc', 'application/pdf', Buffer.alloc(GEMINI_PDF_INPUT_LIMIT + 1)]
    ] as const)
      await expect(guard(`${origin}${path}`, { method: 'POST', headers: { 'content-type': type }, body: bytes })).rejects.toMatchObject({
        code: 'PROVIDER_EGRESS_DENIED'
      })
    expect(calls).toBe(1)
  })
})

describe('Gemini media factory configuration', () => {
  let db: Knex
  const config = {
    timeoutMs: 5_000,
    maxRetries: 0,
    additionalHeaders: {},
    media: {
      attachments: true,
      imageGeneration: {
        model: 'gemini-3.1-flash-image' as const,
        pricingRevision: 'image-1|1000000|2000000'
      },
      transcription: {
        model: 'gemini-3.5-transcribe' as const,
        pricingRevision: 'speech-1|2000000|3000000'
      }
    }
  }
  beforeEach(async () => {
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    await db.schema.createTable('agentProviderProfiles', table => {
      table.string('id').primary()
      table.string('currentVersionId')
      table.string('status')
      table.boolean('conformed')
      table.timestamp('deletedAt').nullable()
    })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.string('id').primary()
      table.string('profileId')
      table.string('transportKind')
      table.string('authMode')
      table.string('secretReference')
      table.string('model')
      table.string('utilityModel')
      table.string('baseUrl')
      table.text('adapterConfig')
      table.text('capabilities')
      table.string('capabilityRevision')
      table.string('pricingRevision')
      table.boolean('conformed')
    })
    await db('agentProviderProfiles').insert({
      id: 'profile',
      currentVersionId: 'version',
      status: 'enabled',
      conformed: true
    })
    await db('agentProviderProfileVersions').insert({
      id: 'version',
      profileId: 'profile',
      transportKind: 'gemini-api',
      authMode: 'google-api-key',
      secretReference: 'test-secret',
      model: 'gemini-3.8-flash',
      baseUrl: `${origin}/v1beta`,
      adapterConfig: JSON.stringify(config),
      capabilities: JSON.stringify({
        streaming: false,
        toolCalling: 'native',
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema',
        usage: 'terminal',
        cancellation: true,
        maxContextTokens: 100_000,
        maxOutputTokens: 4_000
      }),
      capabilityRevision: 'cap-1',
      pricingRevision: 'main-1|1|1',
      conformed: true
    })
  })
  afterEach(async () => {
    await db.destroy()
  })

  it('returns explicitly configured capabilities with separate immutable model pricing', async () => {
    const factory = new AgentProviderFactory(db, {
      get: async () => 'test-key'
    })
    const media = await factory.createMedia('version')
    expect(media.config).toEqual(config.media)
    expect(media.pricing.imageGeneration?.revision).toBe('image-1')
    expect(media.pricing.transcription?.inputMicrosPerMillionTokens).toBe(2_000_000)
    expect((await factory.create('version')).mediaConfig).toEqual(config.media)
  })

  it('rejects absent media configuration, disabled/deleted/stale profiles, missing secrets, and custom origins', async () => {
    const factory = new AgentProviderFactory(db, {
      get: async () => 'test-key'
    })
    await db('agentProviderProfileVersions').update({
      adapterConfig: JSON.stringify({ ...config, media: undefined })
    })
    await expect(factory.createMedia('version')).rejects.toMatchObject({
      code: 'AGENT_MEDIA_DISABLED'
    })
    await db('agentProviderProfileVersions').update({
      adapterConfig: JSON.stringify(config)
    })
    for (const changed of [{ status: 'disabled' }, { conformed: false }, { currentVersionId: 'old' }, { deletedAt: new Date() }]) {
      await db('agentProviderProfiles').update(changed)
      await expect(factory.createMedia('version')).rejects.toMatchObject({
        code: 'AGENT_MEDIA_DISABLED'
      })
      await db('agentProviderProfiles').update({
        status: 'enabled',
        conformed: true,
        currentVersionId: 'version',
        deletedAt: null
      })
    }
    await expect(new AgentProviderFactory(db, { get: async () => null }).createMedia('version')).rejects.toMatchObject({ code: 'PROFILE_SECRET_UNAVAILABLE' })
    await db('agentProviderProfileVersions').update({
      baseUrl: 'https://proxy.example/v1beta'
    })
    await expect(factory.createMedia('version')).rejects.toMatchObject({
      code: 'PROVIDER_EGRESS_DENIED'
    })
  })
})
type Handler = (url: string, init: RequestInit) => Promise<Response> | Response
const setup = (handler: Handler) => {
  const requests: { url: string; init: RequestInit }[] = []
  const fetch = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init: init || {} })
      return handler(url, init || {})
    },
    { preconnect: () => {} }
  ) as AgentProviderFetch
  return {
    requests,
    transport: createGeminiMediaTransport({
      apiKey: 'test-key',
      baseUrl: `${origin}/v1beta`,
      timeoutMs: 5_000,
      fetch
    })
  }
}
const start = (url = `${origin}/upload/v1beta/files?upload_id=upload123&upload_protocol=resumable`) =>
  new Response(null, { headers: { 'x-goog-upload-url': url } })

describe('Ax-backed Gemini media transport', () => {
  it('generates private raster bytes through GenerateContent with measured usage and no tools', async () => {
    const { requests, transport } = setup(() =>
      Response.json(generated([{ text: 'A blue sky' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') }, thoughtSignature: 'opaque' }]))
    )
    const result = await transport.generateImage({ prompt: 'Draw a sky' })
    expect(result).toEqual({ text: 'A blue sky', images: [{ bytes: png, mimeType: 'image/png' }], usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${origin}/v1beta/models/gemini-3.1-flash-image:generateContent`)
    const body = JSON.parse(String(requests[0]?.init.body))
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Draw a sky' }] }])
    expect(body.generationConfig).toMatchObject({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' }, maxOutputTokens: 65536 })
    expect(body.generationConfig).not.toHaveProperty('responseMimeType')
    expect(body).not.toHaveProperty('tools')
    expect(requests[0]?.init.redirect).toBe('manual')
    expect(requests[0]?.init.credentials).toBe('omit')
    expect(new Headers(requests[0]?.init.headers).get('x-goog-api-key')).toBe('test-key')
  })

  it('passes reference images inline after fresh authorization without creating provider files', async () => {
    let checks = 0
    const { requests, transport } = setup(() => Response.json(generated()))
    await transport.generateImage({
      prompt: 'Make it blue',
      images: [
        { bytes: png, mimeType: 'image/png' },
        { bytes: png, mimeType: 'image/png' }
      ],
      beforeUpload: async () => {
        checks++
      }
    })
    expect(checks).toBe(2)
    expect(requests).toHaveLength(1)
    const parts = JSON.parse(String(requests[0]?.init.body)).contents[0].parts
    expect(parts.slice(1)).toEqual([
      { inlineData: { data: png.toString('base64'), mimeType: 'image/png' } },
      { inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }
    ])
  })

  it('does not transfer references or recorded speech after authorization revocation', async () => {
    for (const kind of ['image', 'audio'] as const) {
      const { requests, transport } = setup(() => {
        throw new Error('must not fetch')
      })
      const beforeUpload = async () => {
        throw new Error('Access revoked')
      }
      await expect(
        kind === 'image'
          ? transport.generateImage({ prompt: 'Edit', images: [{ bytes: png, mimeType: 'image/png' }], beforeUpload })
          : transport.transcribe({ bytes: Buffer.from('audio'), mimeType: 'audio/webm', beforeUpload })
      ).rejects.toThrow('Access revoked')
      expect(requests).toHaveLength(0)
    }
  })

  it('counts exactly the inline inference input, awaits admission, then marks one paid dispatch', async () => {
    const order: string[] = []
    const { requests, transport } = setup(url => {
      if (url.endsWith(':countTokens')) {
        order.push('count')
        return Response.json({ totalTokens: 100 })
      }
      order.push('paid')
      return Response.json(generated())
    })
    await transport.generateImage({
      prompt: 'Edit',
      images: [{ bytes: png, mimeType: 'image/png' }],
      maxInputTokens: 200,
      maxOutputTokens: 123,
      beforeUpload: async () => {
        order.push('authorize')
      },
      beforeDispatch: async exposure => {
        expect(exposure).toEqual({ inputTokens: 100, outputTokens: 123, totalTokens: 223 })
        await Promise.resolve()
        order.push('admit')
      },
      onDispatch: () => {
        order.push('dispatch')
      }
    })
    expect(order).toEqual(['authorize', 'count', 'admit', 'dispatch', 'paid'])
    const counted = JSON.parse(String(requests[0]?.init.body))
    const inferred = JSON.parse(String(requests[1]?.init.body))
    expect(counted.contents).toEqual(inferred.contents)
    expect(inferred.generationConfig.maxOutputTokens).toBe(123)
  })

  it('respects provider caps when a caller requests larger limits', async () => {
    const bodies: unknown[] = []
    const fetch = Object.assign(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return String(url).endsWith(':countTokens') ? Response.json({ totalTokens: 4 }) : Response.json(generated())
      },
      { preconnect: () => {} }
    ) as AgentProviderFetch
    const transport = createGeminiMediaTransport({
      apiKey: 'test-key',
      baseUrl: `${origin}/v1beta`,
      timeoutMs: 5000,
      maxInputTokens: 5,
      maxOutputTokens: 20,
      fetch
    })
    await transport.generateImage({
      prompt: 'Draw',
      maxInputTokens: 100,
      maxOutputTokens: 100,
      beforeDispatch: async exposure => {
        expect(exposure).toEqual({ inputTokens: 4, outputTokens: 20, totalTokens: 24 })
      }
    })
    expect(bodies[1]).toMatchObject({ generationConfig: { maxOutputTokens: 20 } })
  })

  for (const failure of ['count', 'context', 'admission', 'cancel'] as const)
    it(`does not dispatch paid inference after ${failure} failure`, async () => {
      const controller = new AbortController()
      let dispatched = false
      const { requests, transport } = setup(() =>
        failure === 'count' ? new Response(null, { status: 400 }) : Response.json({ totalTokens: failure === 'context' ? 201 : 100 })
      )
      await expect(
        transport.generateImage(
          {
            prompt: 'Draw',
            maxInputTokens: 200,
            maxOutputTokens: 123,
            beforeDispatch: async () => {
              if (failure === 'admission') throw new Error('Budget exceeded')
              if (failure === 'cancel') controller.abort()
            },
            onDispatch: () => {
              dispatched = true
            }
          },
          controller.signal
        )
      ).rejects.toThrow()
      expect(dispatched).toBe(false)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toContain(':countTokens')
    })

  it('preserves sanitized guarded failures without automatic inference retries', async () => {
    const failure = new AgentProviderAttemptError('invalid_argument', 400, null, 'generationConfig')
    const { requests, transport } = setup(() => {
      throw failure
    })
    await expect(transport.generateImage({ prompt: 'Draw' })).rejects.toBe(failure)
    expect(requests).toHaveLength(1)
  })

  it('uses Ax batch transcription for dedicated audioTranscription parts and retains usage and cap', async () => {
    const { requests, transport } = setup(url =>
      url.endsWith(':countTokens') ? Response.json({ totalTokens: 4 }) : Response.json(generated([{ audioTranscription: { text: 'Hello world.' } }]))
    )
    const result = await transport.transcribe({
      bytes: Buffer.from('test'),
      mimeType: 'audio/webm',
      maxOutputTokens: 123,
      beforeDispatch: async exposure => {
        expect(exposure).toEqual({ inputTokens: 4, outputTokens: 123, totalTokens: 127 })
      }
    })
    expect(result).toEqual({ text: 'Hello world.', usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } })
    expect(requests.map(row => row.url)).toEqual([
      `${origin}/v1beta/models/gemini-3.5-transcribe:countTokens`,
      `${origin}/v1beta/models/gemini-3.5-transcribe:generateContent`
    ])
    const counted = JSON.parse(String(requests[0]?.init.body))
    const inferred = JSON.parse(String(requests[1]?.init.body))
    expect(inferred.contents).toEqual(counted.contents)
    expect(inferred.contents[0].parts[0]).toEqual({ inlineData: { data: Buffer.from('test').toString('base64'), mimeType: 'audio/webm' } })
    expect(inferred.generationConfig).toEqual({ maxOutputTokens: 123 })
  })

  it('bills reported thought tokens without exposing thought text or signatures', async () => {
    const { transport } = setup(() =>
      Response.json({
        ...generated([
          { text: 'private thought', thought: true, thoughtSignature: 's'.repeat(985664) },
          { inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }
        ]),
        usageMetadata: { ...usage, thoughtsTokenCount: 3, totalTokenCount: 13 }
      })
    )
    const result = await transport.generateImage({ prompt: 'Draw' })
    expect(result.text).toBe('')
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 9, totalTokens: 13 })
    expect(result).not.toHaveProperty('thoughtBlocks')
  })

  for (const usageValue of [
    undefined,
    { ...usage, totalTokenCount: 1 },
    { ...usage, promptTokenCount: -1 },
    { ...usage, thoughtsTokenCount: 3 },
    { ...usage, candidatesTokenCount: 0.5 }
  ])
    it('rejects absent or inconsistent measured usage rather than inventing success accounting', async () => {
      const { transport } = setup(() => Response.json({ ...generated(), usageMetadata: usageValue }))
      await expect(transport.generateImage({ prompt: 'Draw' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    })

  for (const parts of [
    [{ functionCall: { name: 'fetch_url', args: {} } }],
    [{ fileData: { mimeType: 'image/png', fileUri: 'https://evil.example/image' } }],
    [{ inlineData: { mimeType: 'image/png', data: png.toString('base64'), uri: 'https://evil.example/image' } }],
    [{ inlineData: { mimeType: 'image/png', data: `${png.toString('base64')}\n` } }],
    [{ inlineData: { mimeType: 'image/png', data: Buffer.from('<script/>').toString('base64') } }],
    [{ inlineData: { mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') } }],
    [{ text: 'No image' }]
  ])
    it('refuses unrequested remote outputs, tools, malformed raster data, and missing images', async () => {
      const { transport } = setup(() => Response.json(generated(parts)))
      await expect(transport.generateImage({ prompt: 'Draw' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    })

  for (const finishReason of ['MAX_TOKENS', 'SAFETY'])
    it(`rejects ${finishReason} as incomplete media, including batch transcription`, async () => {
      for (const audio of [false, true]) {
        const { transport } = setup(() =>
          Response.json({
            ...generated(),
            candidates: [
              {
                finishReason,
                content: {
                  parts: audio ? [{ audioTranscription: { text: 'partial' } }] : [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }]
                }
              }
            ]
          })
        )
        await expect(
          audio ? transport.transcribe({ bytes: Buffer.from('audio'), mimeType: 'audio/webm' }) : transport.generateImage({ prompt: 'Draw' })
        ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
      }
    })

  it('rejects decoded images exceeding private storage limits', async () => {
    const oversized = Buffer.alloc(GEMINI_MEDIA_INPUT_LIMIT + 1)
    png.copy(oversized)
    const { transport } = setup(() => Response.json(generated([{ inlineData: { data: oversized.toString('base64'), mimeType: 'image/png' } }])))
    await expect(transport.generateImage({ prompt: 'Draw' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
  })

  it('bounds response bytes when Content-Length is absent or forged and cancels the body', async () => {
    for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'application/json', 'content-length': '2' }] as Record<string, string>[]) {
      let cancelled = false
      const { transport } = setup(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(GEMINI_MEDIA_OUTPUT_LIMIT + 1))
              },
              cancel() {
                cancelled = true
              }
            }),
            { headers }
          )
      )
      await expect(transport.generateImage({ prompt: 'Draw' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
      expect(cancelled).toBe(true)
    }
  })

  it('rejects provider redirects without following or exposing the destination', async () => {
    const { requests, transport } = setup(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/private' } }))
    await expect(transport.generateImage({ prompt: 'Draw' })).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    expect(requests).toHaveLength(1)
  })

  it('rejects invalid inputs and excess image references before egress', async () => {
    const { requests, transport } = setup(() => {
      throw new Error('must not fetch')
    })
    for (const input of [
      { bytes: Buffer.alloc(0), mimeType: 'image/png' },
      { bytes: Buffer.from('<svg/>'), mimeType: 'image/png' },
      { bytes: png, mimeType: 'image/svg+xml' },
      { bytes: png, mimeType: 'image/png; charset=utf-8' },
      { bytes: Buffer.alloc(GEMINI_PDF_INPUT_LIMIT + 1), mimeType: 'application/pdf' }
    ])
      await expect(transport.upload(input)).rejects.toMatchObject({ code: 'INVALID_MEDIA_INPUT' })
    await expect(transport.generateImage({ prompt: 'Draw', images: Array(5).fill({ bytes: png, mimeType: 'image/png' }) })).rejects.toMatchObject({
      code: 'INVALID_MEDIA_INPUT'
    })
    await expect(transport.transcribe({ bytes: Buffer.alloc(GEMINI_MEDIA_INPUT_LIMIT + 1), mimeType: 'audio/webm' })).rejects.toMatchObject({
      code: 'INVALID_MEDIA_INPUT'
    })
    expect(requests).toHaveLength(0)
  })
})

describe('Gemini Files API application integration', () => {
  it('uploads and counts Gemini 2.5 Flash PDF/image attachments before native Ax dispatch, then cleans up', async () => {
    for (const attachment of [
      { bytes: Buffer.from('%PDF-1.7\nfixture'), mimeType: 'application/pdf', type: 'document' as const },
      { bytes: png, mimeType: 'image/png', type: 'image' as const }
    ]) {
      const requests: { url: string; init: RequestInit }[] = []
      const wire = Object.assign(
        async (input: URL | RequestInfo, init?: RequestInit) => {
          const url = String(input)
          requests.push({ url, init: init || {} })
          if (init?.method === 'DELETE') return new Response(null, { status: 204 })
          if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 258 })
          if (url.endsWith(':generateContent'))
            return Response.json({
              ...generated([{ text: 'Attachment read.' }]),
              usageMetadata: { promptTokenCount: 258, candidatesTokenCount: 6, totalTokenCount: 264 }
            })
          if (url.includes('?'))
            return Response.json({ file: { ...file(), mimeType: attachment.mimeType, sizeBytes: String(attachment.bytes.length) } })
          return start()
        },
        { preconnect: () => {} }
      ) as AgentProviderFetch
      const resolve = (async () => [{ address: '142.250.1.1', family: 4 }]) as unknown as typeof lookup
      const transport = createGeminiMediaTransport({
        apiKey: 'test-key',
        baseUrl: `${origin}/v1beta`,
        timeoutMs: 5_000,
        fetch: createGuardedProviderFetch(`${origin}/v1beta`, 'gemini-media', {}, wire, resolve)
      })
      const remote = await transport.upload(attachment)
      try {
        const inputTokens = await transport.countTokens('gemini-2.5-flash', [
          { type: 'text', text: 'Read it.' },
          { type: attachment.type, uri: remote.uri, mime_type: remote.mimeType }
        ])
        expect(inputTokens).toBe(258)
        const service = ai({
          name: 'google-gemini',
          apiKey: 'test-key',
          config: { model: 'gemini-2.5-flash' as AxAIGoogleGeminiModel, stream: false, maxTokens: 16 },
          options: {
            fetch: createGuardedProviderFetch(`${origin}/v1beta`, 'gemini-chat', {}, wire, resolve),
            retry: { maxRetries: 0 }
          }
        })
        const response = await service.chat(
          {
            chatPrompt: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Read it.' },
                  { type: 'file', fileUri: remote.uri, mimeType: remote.mimeType }
                ]
              }
            ]
          },
          { stream: false }
        )
        if (response instanceof ReadableStream) throw new Error('Expected non-streaming response')
        expect(response.results[0]?.content).toBe('Attachment read.')
        const contents = [
          {
            role: 'user',
            parts: [{ text: 'Read it.' }, { fileData: { fileUri: remote.uri, mimeType: attachment.mimeType } }]
          }
        ]
        expect(JSON.parse(String(requests[2]?.init.body)).contents).toEqual(contents)
        expect(JSON.parse(String(requests[3]?.init.body)).contents).toEqual(contents)
        expect(Buffer.from(requests[1]?.init.body as Uint8Array)).toEqual(attachment.bytes)
      } finally {
        await transport.delete(remote.name)
      }
      expect(requests.map(request => [request.init.method, request.url])).toEqual([
        ['POST', `${origin}/upload/v1beta/files`],
        ['POST', `${origin}/upload/v1beta/files?upload_id=upload123&upload_protocol=resumable`],
        ['POST', `${origin}/v1beta/models/gemini-2.5-flash:countTokens`],
        ['POST', `${origin}/v1beta/models/gemini-2.5-flash:generateContent`],
        ['DELETE', remote.uri]
      ])
    }
  })

  it('rejects unsupported or unsafe count model names and bounded inputs before count egress', async () => {
    const { requests, transport } = setup(() => {
      throw new Error('must not fetch')
    })
    const input = [{ type: 'document' as const, uri: file().uri, mime_type: 'application/pdf' }]
    for (const model of [
      'gemini-1.5-flash',
      'gemini-4-flash',
      'gemini-omni-1.1-flash',
      'lyria-3.5',
      'models/gemini-2.5-flash',
      'gemini-2.5-flash?key=secret',
      'gemini-2.5-flash/other',
      'gemini-2.5-Flash',
      `gemini-2.5-${'a'.repeat(118)}`
    ])
      await expect(transport.countTokens(model, input)).rejects.toMatchObject({ code: 'INVALID_MEDIA_INPUT' })
    await expect(transport.countTokens('gemini-2.5-flash', Array(33).fill(input[0]))).rejects.toMatchObject({ code: 'INVALID_MEDIA_INPUT' })
    await expect(transport.countTokens('gemini-2.5-flash', [{ type: 'text', text: 'a'.repeat(64 * 1_024 + 1) }])).rejects.toMatchObject({
      code: 'INVALID_MEDIA_INPUT'
    })
    expect(requests).toHaveLength(0)
  })

  it('uploads prepared PDFs and images, polls processing, then deletes temporary files', async () => {
    const { requests, transport } = setup((url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      if (init.method === 'GET') return Response.json(file())
      return url.includes('?') ? Response.json({ file: file('PROCESSING') }) : start()
    })
    expect(await transport.upload({ bytes: png, mimeType: 'image/png' })).toEqual({
      name: 'files/abc123',
      uri: file().uri,
      mimeType: 'image/png'
    })
    await transport.delete('files/abc123')
    expect(requests.map(row => row.init.method)).toEqual(['POST', 'POST', 'GET', 'DELETE'])
    expect(new Headers(requests[0]?.init.headers).get('x-goog-upload-header-content-length')).toBe(String(png.length))
    expect(new Headers(requests[1]?.init.headers).get('x-goog-upload-command')).toBe('upload, finalize')
    expect(Buffer.from(requests[1]?.init.body as Uint8Array)).toEqual(png)
    const bytes = Buffer.alloc(GEMINI_MEDIA_INPUT_LIMIT + 1)
    bytes.write('%PDF-1.7')
    const pdf = setup(url =>
      url.includes('?') ? Response.json({ file: { ...file(), mimeType: 'application/pdf', sizeBytes: String(bytes.length) } }) : start()
    )
    expect((await pdf.transport.upload({ bytes, mimeType: 'application/pdf' })).mimeType).toBe('application/pdf')
  })

  it('counts validated PDF file references without paid generation or arbitrary remote URLs', async () => {
    const { requests, transport } = setup(() => Response.json({ totalTokens: 258 }))
    expect(await transport.countTokens('gemini-3.8-flash', [{ type: 'document', uri: file().uri, mime_type: 'application/pdf' }])).toBe(258)
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: file().uri, mimeType: 'application/pdf' } }] }]
    })
    await expect(
      transport.countTokens('gemini-3.8-flash', [{ type: 'image', uri: 'https://private.example/secret', mime_type: 'image/png' }])
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA_INPUT' })
    expect(requests).toHaveLength(1)
  })

  for (const destination of [
    'https://evil.example/upload/v1beta/files?upload_id=x',
    `${origin}/v1beta/models/gemini-3.1-flash-image:generateContent?upload_id=x`,
    `${origin}/upload/v1beta/files?upload_id=x&key=secret`,
    `${origin}/upload/v1beta/files?upload_id=x&upload_id=y`,
    `${origin}/upload/v1beta/files?upload_id=x#fragment`,
    'http://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x',
    'https://user@generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x'
  ])
    it('refuses credential crossing through an untrusted resumable destination', async () => {
      const { requests, transport } = setup(() => start(destination))
      await expect(transport.upload({ bytes: png, mimeType: 'image/png' })).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
      expect(requests).toHaveLength(1)
    })

  it('cleans failed and malformed known uploads', async () => {
    for (const metadata of [file('FAILED'), { name: 'files/abc123', state: 'FAILED' }]) {
      const { requests, transport } = setup((url, init) =>
        init.method === 'DELETE' ? new Response(null, { status: 204 }) : url.includes('?') ? Response.json({ file: metadata }) : start()
      )
      await expect(transport.upload({ bytes: png, mimeType: 'image/png' })).rejects.toThrow()
      expect(requests.at(-1)?.init.method).toBe('DELETE')
    }
  })

  it('cleans processing uploads on cancellation with a fresh signal', async () => {
    const controller = new AbortController()
    const { requests, transport } = setup((url, init) => {
      if (init.method === 'DELETE') {
        expect(init.signal?.aborted).toBe(false)
        return new Response(null, { status: 204 })
      }
      if (init.method === 'GET') {
        controller.abort()
        return Response.json(file())
      }
      if (url.includes('?')) return Response.json({ file: file('PROCESSING') })
      return start()
    })
    await expect(transport.upload({ bytes: png, mimeType: 'image/png' }, controller.signal)).rejects.toThrow()
    expect(requests.at(-1)?.init.method).toBe('DELETE')
  })

  it('refuses nonofficial origins before making requests', () => {
    expect(() =>
      createGeminiMediaTransport({ apiKey: 'key', baseUrl: 'https://proxy.example/v1beta', timeoutMs: 10, fetch: (() => {}) as unknown as AgentProviderFetch })
    ).toThrow()
  })
})

describe('Unavailable exact Gemini video/music models', () => {
  for (const kind of ['video', 'music'] as const)
    it(`reports ${kind} incompatibility before uploads, admission, or provider dispatch`, async () => {
      const { requests, transport } = setup(() => {
        throw new Error('must not fetch')
      })
      const callbacks: string[] = []
      const input = {
        prompt: 'A peaceful sunset',
        images: [{ bytes: png, mimeType: 'image/png' }],
        beforeUpload: async () => {
          callbacks.push('upload')
        },
        beforeDispatch: async () => {
          callbacks.push('admit')
        },
        onDispatch: () => {
          callbacks.push('dispatch')
        }
      }
      await expect(kind === 'video' ? transport.generateVideo(input) : transport.generateMusic(input)).rejects.toMatchObject({
        code: 'AGENT_MEDIA_UNSUPPORTED',
        status: 409
      })
      expect(callbacks).toEqual([])
      expect(requests).toHaveLength(0)
    })
})
