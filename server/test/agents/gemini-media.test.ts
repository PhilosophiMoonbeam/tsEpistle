import type { lookup } from 'node:dns/promises'
import createKnex, { type Knex } from 'knex'
import { AgentProviderAttemptError, AgentProviderFactory, type AgentProviderFetch, createGuardedProviderFetch } from '../../agents/providers/factory.ts'
import {
  createGeminiMediaTransport,
  GEMINI_MEDIA_INPUT_LIMIT,
  GEMINI_MEDIA_OUTPUT_LIMIT,
  GEMINI_MUSIC_MODEL,
  GEMINI_MUSIC_OUTPUT_LIMIT,
  GEMINI_PDF_INPUT_LIMIT,
  GEMINI_VIDEO_MODEL,
  GEMINI_VIDEO_OUTPUT_LIMIT
} from '../../agents/providers/gemini-media.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

const origin = 'https://generativelanguage.googleapis.com'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64')
const file = (state = 'ACTIVE') => ({
  name: 'files/abc123',
  uri: `${origin}/v1beta/files/abc123`,
  mimeType: 'image/png',
  sizeBytes: String(png.length),
  state
})
const usage = {
  total_input_tokens: 4,
  total_output_tokens: 6,
  total_tokens: 10
}
const generated = (content: unknown[] = [{ type: 'image', data: png.toString('base64'), mime_type: 'image/png' }]) => ({
  model: 'gemini-3.1-flash-image',
  status: 'completed',
  steps: [{ type: 'model_output', content }],
  usage
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
    await guard(`${origin}/v1beta/interactions`, {
      method: 'POST',
      body: '{}'
    })
    await guard(`${origin}/v1beta/models/gemini-3.5-transcribe:countTokens`, { method: 'POST', body: '{}' })
    for (const [path, method] of [
      ['/v1beta/files', 'GET'],
      ['/v1beta/files/abc', 'POST'],
      ['/v1beta/interactions', 'GET'],
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
    const ordinary = createGuardedProviderFetch(`${origin}/v1beta`, '/interactions', {}, implementation, resolve)
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
      ['/v1beta/interactions', 'application/pdf', body],
      ['/upload/v1beta/files?upload_id=abc', 'image/png', body],
      ['/upload/v1beta/files?upload_id=abc', 'application/pdf', Buffer.alloc(GEMINI_PDF_INPUT_LIMIT + 1)]
    ] as const)
      await expect(guard(`${origin}${path}`, { method: 'POST', headers: { 'content-type': type }, body: bytes })).rejects.toMatchObject({
        code: 'PROVIDER_EGRESS_DENIED'
      })
    expect(calls).toBe(1)
  })

  it('denies private DNS results before sending the API key or media', async () => {
    let fetched = false
    const implementation = Object.assign(
      async () => {
        fetched = true
        return Response.json({})
      },
      { preconnect: () => {} }
    ) as AgentProviderFetch
    const privateResolve = (async () => [{ address: '127.0.0.1', family: 4 }]) as unknown as typeof lookup
    const guard = createGuardedProviderFetch(`${origin}/v1beta`, 'gemini-media', {}, implementation, privateResolve)
    await expect(guard(`${origin}/upload/v1beta/files`, { method: 'POST', body: png })).rejects.toThrow()
    expect(fetched).toBe(false)
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

describe('Gemini media transport', () => {
  it('rechecks authorization before each upload and cleans up when access is revoked', async () => {
    let checks = 0
    const { requests, transport } = setup((url, init) =>
      init.method === 'DELETE' ? new Response(null, { status: 204 }) : url.includes('?') ? Response.json({ file: file() }) : start()
    )
    await expect(
      transport.generateImage({
        prompt: 'Edit',
        images: [
          { bytes: png, mimeType: 'image/png' },
          { bytes: png, mimeType: 'image/png' }
        ],
        beforeUpload: async () => {
          if (++checks === 2) throw new Error('Access revoked')
        }
      })
    ).rejects.toThrow('Access revoked')
    expect(checks).toBe(2)
    expect(requests).toHaveLength(3)
    expect(requests.at(-1)?.init.method).toBe('DELETE')
  })

  it('does not upload recorded speech when its fresh authorization check fails', async () => {
    const { requests, transport } = setup(() => start())
    await expect(
      transport.transcribe({
        bytes: Buffer.from('audio'),
        mimeType: 'audio/webm',
        beforeUpload: async () => {
          throw new Error('Access revoked')
        }
      })
    ).rejects.toThrow('Access revoked')
    expect(requests).toHaveLength(0)
  })

  it('counts multimodal Files API references without issuing a generation', async () => {
    const { requests, transport } = setup(() => Response.json({ totalTokens: 258 }))
    expect(await transport.countTokens('gemini-3.8-flash', [{ type: 'document', uri: file().uri, mime_type: 'application/pdf' }])).toBe(258)
    expect(requests[0]?.url).toBe(`${origin}/v1beta/models/gemini-3.8-flash:countTokens`)
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: file().uri, mimeType: 'application/pdf' } }] }]
    })
  })

  it('counts before paid media dispatch and applies the explicit output token limit', async () => {
    let dispatched = false
    const { requests, transport } = setup(url => {
      if (url.endsWith(':countTokens')) {
        expect(dispatched).toBe(false)
        return Response.json({ totalTokens: 100 })
      }
      expect(dispatched).toBe(true)
      return Response.json(generated())
    })
    await transport.generateImage({
      prompt: 'Draw',
      maxInputTokens: 200,
      maxOutputTokens: 123,
      onDispatch: () => {
        dispatched = true
      }
    })
    expect(JSON.parse(String(requests[1]?.init.body)).generation_config).toEqual({ max_output_tokens: 123 })
  })

  it('rejects over-budget and unsupported token counts without dispatching a paid interaction', async () => {
    for (const response of [Response.json({ totalTokens: 201 }), Response.json({ error: 'unsupported model' }, { status: 400 })]) {
      let dispatched = false
      const { requests, transport } = setup(() => response)
      await expect(
        transport.generateImage({
          prompt: 'Draw',
          maxInputTokens: 200,
          onDispatch: () => {
            dispatched = true
          }
        })
      ).rejects.toThrow()
      expect(dispatched).toBe(false)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toContain(':countTokens')
    }
  })

  it('preserves sanitized guarded HTTP failures for actionable provider diagnostics', async () => {
    const failure = new AgentProviderAttemptError('invalid_argument', 400, null, 'generation_config')
    const { transport } = setup(() => {
      throw failure
    })
    await expect(transport.generateVideo({ prompt: 'A landscape' })).rejects.toBe(failure)
  })

  it('awaits measured admission before dispatch and never generates when admission rejects', async () => {
    let admissions = 0
    const { requests, transport } = setup(() => Response.json({ totalTokens: 258 }))
    await expect(
      transport.generateImage({
        prompt: 'Draw',
        maxOutputTokens: 4_000,
        beforeDispatch: async exposure => {
          expect(exposure).toEqual({ inputTokens: 258, outputTokens: 4_000, totalTokens: 4_258 })
          await Promise.resolve()
          admissions++
          throw new Error('Budget exceeded')
        },
        onDispatch: () => {
          throw new Error('Must not dispatch')
        }
      })
    ).rejects.toThrow('Budget exceeded')
    expect(admissions).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain(':countTokens')
  })

  it('does not send arbitrary URL references to the token counter', async () => {
    const { requests, transport } = setup(() => Response.json({ totalTokens: 1 }))
    await expect(
      transport.countTokens('gemini-3.8-flash', [{ type: 'image', uri: 'https://private.example/secret', mime_type: 'image/png' }])
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA_INPUT' })
    expect(requests).toHaveLength(0)
  })

  it('generates raster outputs with measured usage and no stored interactions or tools', async () => {
    const { requests, transport } = setup(() =>
      Response.json(
        generated([
          { type: 'text', text: 'A blue sky' },
          {
            type: 'image',
            data: png.toString('base64'),
            mime_type: 'image/png'
          }
        ])
      )
    )
    const result = await transport.generateImage({ prompt: 'Draw a sky' })
    expect(result.images[0]?.bytes).toEqual(png)
    expect(result.text).toBe('A blue sky')
    expect(result.usage).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10
    })
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      model: 'gemini-3.1-flash-image',
      store: false,
      stream: false,
      input: [{ type: 'text', text: 'Draw a sky' }],
      response_format: { type: 'image', aspect_ratio: '1:1' }
    })
    expect(requests[0]?.init.redirect).toBe('manual')
    expect(new Headers(requests[0]?.init.headers).get('x-goog-api-key')).toBe('test-key')
  })

  it('discards large opaque image-edit signatures within the response byte limit', async () => {
    const result = generated()
    const { transport } = setup(() => Response.json({ ...result, steps: [{ type: 'thought', signature: 's'.repeat(985_664) }, ...result.steps] }))
    const response = await transport.generateImage({ prompt: 'Edit this image' })
    expect(response.images[0]?.bytes).toEqual(png)
    expect(response).not.toHaveProperty('steps')
    expect(response.usage.totalTokens).toBe(10)
  })

  it('uploads edits via resumable Files API, waits for ACTIVE, then deletes the file', async () => {
    const { requests, transport } = setup((url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      if (url.endsWith('/interactions')) return Response.json(generated())
      if (init.method === 'GET') return Response.json(file())
      if (url.includes('?')) return Response.json({ file: file('PROCESSING') })
      return start()
    })
    await transport.generateImage({
      prompt: 'Make it blue',
      images: [{ bytes: png, mimeType: 'image/png' }]
    })
    expect(requests.map(entry => entry.init.method)).toEqual(['POST', 'POST', 'GET', 'POST', 'DELETE'])
    expect(new Headers(requests[0]?.init.headers).get('x-goog-upload-header-content-length')).toBe(String(png.length))
    expect(new Headers(requests[1]?.init.headers).get('x-goog-upload-command')).toBe('upload, finalize')
    expect(Buffer.from(requests[1]?.init.body as Uint8Array)).toEqual(png)
    expect(JSON.parse(String(requests[3]?.init.body)).input[1]).toEqual({
      type: 'image',
      uri: file().uri,
      mime_type: 'image/png'
    })
  })

  it('transcribes audio with the dedicated model and deletes the upload', async () => {
    const { requests, transport } = setup((url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      if (url.endsWith('/interactions'))
        return Response.json({
          ...generated([{ type: 'text', text: 'Hello world.' }]),
          model: 'gemini-3.5-transcribe'
        })
      if (url.includes('?'))
        return Response.json({
          file: { ...file(), mimeType: 'audio/webm', sizeBytes: '4' }
        })
      return start()
    })
    expect(
      await transport.transcribe({
        bytes: Buffer.from('test'),
        mimeType: 'audio/webm'
      })
    ).toEqual({
      text: 'Hello world.',
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 }
    })
    expect(JSON.parse(String(requests[2]?.init.body))).toEqual({
      model: 'gemini-3.5-transcribe',
      store: false,
      stream: false,
      input: [{ type: 'audio', uri: file().uri, mime_type: 'audio/webm' }]
    })
    expect(requests[3]?.init.method).toBe('DELETE')
  })

  it('accepts PDF uploads for chat consumers', async () => {
    const bytes = Buffer.alloc(GEMINI_MEDIA_INPUT_LIMIT + 1)
    bytes.write('%PDF-1.7')
    const { transport } = setup(url =>
      url.includes('?')
        ? Response.json({
            file: { ...file(), mimeType: 'application/pdf', sizeBytes: String(bytes.length) }
          })
        : start()
    )
    expect(
      (
        await transport.upload({
          bytes,
          mimeType: 'application/pdf'
        })
      ).mimeType
    ).toBe('application/pdf')
  })

  for (const destination of [
    'https://evil.example/upload/v1beta/files?upload_id=x',
    `${origin}/v1beta/interactions?upload_id=x`,
    `${origin}/upload/v1beta/files?upload_id=x&key=secret`,
    `${origin}/upload/v1beta/files?upload_id=x&upload_id=y`,
    `${origin}/upload/v1beta/files?upload_id=x#fragment`,
    'http://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x',
    'https://user@generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x'
  ])
    it(`refuses an untrusted upload destination ${destination}`, async () => {
      const { requests, transport } = setup(() => start(destination))
      await expect(transport.upload({ bytes: png, mimeType: 'image/png' })).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
      expect(requests).toHaveLength(1)
    })

  it('refuses custom origins before making any request', () => {
    expect(() =>
      createGeminiMediaTransport({
        apiKey: 'key',
        baseUrl: 'https://proxy.example/v1beta',
        timeoutMs: 10,
        fetch: (() => {}) as unknown as AgentProviderFetch
      })
    ).toThrow('official Google endpoint')
  })

  it('rejects provider redirects without following or exposing their location', async () => {
    const { requests, transport } = setup(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/secret' }
        })
    )
    await expect(transport.generateImage({ prompt: 'Draw' })).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    expect(requests).toHaveLength(1)
  })

  it('rejects oversized, empty, forged raster, executable, and noncanonical media before egress', async () => {
    const { requests, transport } = setup(() => {
      throw new Error('must not fetch')
    })
    for (const input of [
      {
        bytes: Buffer.alloc(GEMINI_MEDIA_INPUT_LIMIT + 1),
        mimeType: 'application/pdf'
      },
      { bytes: Buffer.alloc(0), mimeType: 'image/png' },
      { bytes: Buffer.from('<svg/>'), mimeType: 'image/png' },
      { bytes: png, mimeType: 'image/svg+xml' },
      { bytes: png, mimeType: 'image/png; charset=utf-8' }
    ])
      await expect(transport.upload(input)).rejects.toMatchObject({
        code: 'INVALID_MEDIA_INPUT'
      })
    expect(requests).toHaveLength(0)
  })

  it('cleans up FAILED uploads and never calls the model', async () => {
    const { requests, transport } = setup((url, init) =>
      init.method === 'DELETE' ? new Response(null, { status: 204 }) : url.includes('?') ? Response.json({ file: file('FAILED') }) : start()
    )
    await expect(
      transport.generateImage({
        prompt: 'Draw',
        images: [{ bytes: png, mimeType: 'image/png' }]
      })
    ).rejects.toMatchObject({ code: 'AGENT_MEDIA_PROCESSING_FAILED' })
    expect(requests.at(-1)?.init.method).toBe('DELETE')
    expect(requests.some(entry => entry.url.endsWith('/interactions'))).toBe(false)
  })

  it('cleans up when cancelled while the file is processing using a fresh signal', async () => {
    const controller = new AbortController()
    const { requests, transport } = setup((url, init) => {
      if (init.method === 'DELETE') {
        expect(init.signal?.aborted).toBe(false)
        return new Response(null, { status: 204 })
      }
      if (url.includes('?')) {
        setTimeout(() => controller.abort(), 10)
        return Response.json({ file: file('PROCESSING') })
      }
      return start()
    })
    await expect(transport.upload({ bytes: png, mimeType: 'image/png' }, controller.signal)).rejects.toThrow()
    expect(requests.at(-1)?.init.method).toBe('DELETE')
  })

  it('cleans up edits on invalid model output', async () => {
    const { requests, transport } = setup((url, init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : url.endsWith('/interactions')
          ? Response.json({ error: { message: 'private provider detail' } })
          : url.includes('?')
            ? Response.json({ file: file() })
            : start()
    )
    await expect(
      transport.generateImage({
        prompt: 'Draw',
        images: [{ bytes: png, mimeType: 'image/png' }]
      })
    ).rejects.toMatchObject({
      message: 'Gemini returned an invalid media response'
    })
    expect(requests.at(-1)?.init.method).toBe('DELETE')
  })

  it('rejects missing or inconsistent measured usage', async () => {
    for (const usageValue of [undefined, { ...usage, total_tokens: 1 }, { ...usage, total_input_tokens: -1 }]) {
      const { transport } = setup(() => Response.json({ ...generated(), usage: usageValue }))
      await expect(transport.generateImage({ prompt: 'Draw' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    }
  })

  it('refuses function calls, URI outputs, extra block fields, malformed base64, and forged raster bytes', async () => {
    for (const content of [
      [{ type: 'function_call', name: 'fetch_url', arguments: {} }],
      [
        {
          type: 'image',
          mime_type: 'image/png',
          uri: 'https://evil.example/image'
        }
      ],
      [
        {
          type: 'image',
          mime_type: 'image/png',
          data: png.toString('base64'),
          uri: 'https://evil.example/image'
        }
      ],
      [
        {
          type: 'image',
          mime_type: 'image/png',
          data: `${png.toString('base64')}\n`
        }
      ],
      [
        {
          type: 'image',
          mime_type: 'image/png',
          data: Buffer.from('<script/>').toString('base64')
        }
      ]
    ]) {
      const { transport } = setup(() => Response.json(generated(content)))
      await expect(transport.generateImage({ prompt: 'Draw' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    }
  })

  it('cleans up a known file even when the provider omits its metadata on failure', async () => {
    const { requests, transport } = setup((url, init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : url.includes('?')
          ? Response.json({ file: { name: 'files/abc123', state: 'FAILED', error: { message: 'private detail' } } })
          : start()
    )
    await expect(transport.upload({ bytes: png, mimeType: 'image/png' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    expect(requests.at(-1)?.init.method).toBe('DELETE')
  })

  it('rejects decoded generated images larger than the private storage limit', async () => {
    const oversized = Buffer.alloc(GEMINI_MEDIA_INPUT_LIMIT + 1)
    png.copy(oversized)
    const { transport } = setup(() => Response.json(generated([{ type: 'image', data: oversized.toString('base64'), mime_type: 'image/png' }])))
    await expect(transport.generateImage({ prompt: 'Draw' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
  })

  it('bounds response bytes even if content length is absent or forged', async () => {
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
})

const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(400).fill(0)])
const videoUri = `${origin}/v1beta/files/video123:download?alt=media`
const avResponse = (kind: 'video' | 'music', measured: unknown = usage, content?: unknown[]) => ({
  model: kind === 'video' ? GEMINI_VIDEO_MODEL : GEMINI_MUSIC_MODEL,
  status: 'completed',
  steps: [
    { type: 'user_input', content: [{ type: 'text', text: 'A peaceful sunset.' }] },
    { type: 'thought', signature: 'opaque', content: [{ type: 'thought', text: 'Discard this reasoning.' }] },
    {
      type: 'model_output',
      content: content ?? [
        kind === 'video'
          ? { type: 'video', data: mp4.toString('base64'), mime_type: 'video/mp4' }
          : { type: 'audio', data: mp3.toString('base64'), mime_type: 'audio/mp3' }
      ]
    }
  ],
  ...(measured === 'absent' ? {} : { usage: measured })
})

describe('Gemini video and music transport', () => {
  for (const kind of ['video', 'music'] as const)
    it(`counts and admits ${kind} before dispatch, returning only private bytes`, async () => {
      const order: string[] = []
      const { transport, requests } = setup((url, init) => {
        if (url.endsWith(':countTokens')) {
          order.push('count')
          return Response.json({ totalTokens: 5 })
        }
        if (url.endsWith('/interactions')) {
          order.push('paid')
          return Response.json(avResponse(kind))
        }
        if (init.method === 'DELETE') {
          order.push('delete')
          return new Response(null, { status: 204 })
        }
        throw new Error('Unexpected media request')
      })
      const input = {
        prompt: 'A peaceful sunset.',
        beforeDispatch: async (exposure: { inputTokens: number; outputTokens: number; totalTokens: number }) => {
          order.push('reserve')
          expect(exposure).toEqual({ inputTokens: 5, outputTokens: 65536, totalTokens: 65541 })
        },
        onDispatch: () => {
          order.push('dispatch')
        }
      }
      const result = await (kind === 'video' ? transport.generateVideo(input) : transport.generateMusic(input))
      expect(order.slice(0, 4)).toEqual(['count', 'reserve', 'dispatch', 'paid'])
      expect(result.usageSource).toBe('reported')
      expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 })
      expect(result.files).toEqual([{ bytes: kind === 'video' ? mp4 : mp3, mimeType: kind === 'video' ? 'video/mp4' : 'audio/mpeg' }])
      expect(JSON.stringify(result)).not.toContain('generativelanguage.googleapis.com')
      const body = JSON.parse(String(requests.find(row => row.url.endsWith('/interactions'))!.init.body))
      expect(body).toMatchObject({
        model: kind === 'video' ? GEMINI_VIDEO_MODEL : GEMINI_MUSIC_MODEL,
        store: false,
        background: false,
        stream: false,
        generation_config: { max_output_tokens: 65536 }
      })
      expect(body.tools).toBeUndefined()
      if (kind === 'video') {
        expect(body.response_format).toEqual({ type: 'video', resolution: '720p', aspect_ratio: '16:9' })
        expect(requests).toHaveLength(2)
      } else expect(body.response_format).toBeUndefined()
    })

  it('keeps new model caps independent of legacy image limits and marks missing usage as estimated', async () => {
    let body: { generation_config: { max_output_tokens: number } } | undefined
    const fetch = Object.assign(
      async (url: unknown, init?: RequestInit) => {
        if (String(url).endsWith(':countTokens')) return Response.json({ totalTokens: 8 })
        body = JSON.parse(String(init?.body))
        return Response.json(avResponse('music', 'absent'))
      },
      { preconnect: () => {} }
    ) as AgentProviderFetch
    const transport = createGeminiMediaTransport({ apiKey: 'key', baseUrl: `${origin}/v1beta`, timeoutMs: 5000, maxInputTokens: 1, maxOutputTokens: 1, fetch })
    const result = await transport.generateMusic({ prompt: 'A song.' })
    expect(body?.generation_config.max_output_tokens).toBe(65536)
    expect(result.usageSource).toBe('estimated')
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 65536, totalTokens: 65544 })
  })

  for (const failure of ['count', 'context', 'admission', 'cancel'] as const)
    it(`does not make a paid call after ${failure} failure`, async () => {
      const controller = new AbortController()
      const { transport, requests } = setup(() =>
        failure === 'count' ? new Response(null, { status: 404 }) : Response.json({ totalTokens: failure === 'context' ? 65537 : 5 })
      )
      await expect(
        transport.generateMusic(
          {
            prompt: 'A song.',
            beforeDispatch: async () => {
              if (failure === 'admission') throw new Error('budget')
              if (failure === 'cancel') controller.abort()
            }
          },
          controller.signal
        )
      ).rejects.toThrow()
      expect(requests.some(row => row.url.endsWith('/interactions'))).toBe(false)
    })

  it('uploads reference images under fresh authorization and deletes them on rejection', async () => {
    const order: string[] = []
    const { transport } = setup((url, init) => {
      if (init.method === 'DELETE') {
        order.push('delete')
        return new Response(null, { status: 204 })
      }
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 5 })
      if (url.endsWith('/interactions')) throw new Error('must not dispatch')
      if (!url.includes('upload_id')) {
        order.push('upload')
        return start()
      }
      return Response.json({ file: file() })
    })
    await expect(
      transport.generateVideo({
        prompt: 'Animate this.',
        images: [{ bytes: png, mimeType: 'image/png' }],
        beforeUpload: async () => {
          order.push('authorize')
        },
        beforeDispatch: async () => {
          throw new Error('denied')
        }
      })
    ).rejects.toThrow()
    expect(order).toEqual(['authorize', 'upload', 'delete'])
  })

  for (const uri of [
    'https://evil.invalid/video.mp4',
    `${origin}/v1beta/files/video123:download?alt=media&key=leak`,
    `${origin}/v1beta/files/video123:download?alt=media&alt=media`,
    `${origin}/v1beta/files/video123:download?alt=media#fragment`,
    `${origin}/v1beta/files/%76ideo123:download?alt=media`
  ])
    it(`rejects unrequested video URI ${uri}`, async () => {
      const { transport, requests } = setup(url =>
        url.endsWith(':countTokens')
          ? Response.json({ totalTokens: 5 })
          : Response.json(avResponse('video', usage, [{ type: 'video', mime_type: 'video/mp4', uri }]))
      )
      await expect(transport.generateVideo({ prompt: 'A sunset.' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
      expect(requests).toHaveLength(2)
    })

  for (const failure of ['signature', 'usage', 'base64', 'mime', 'oversize'] as const)
    it(`rejects invalid inline video ${failure}`, async () => {
      const data = failure === 'oversize' ? Buffer.alloc(GEMINI_VIDEO_OUTPUT_LIMIT + 1) : failure === 'signature' ? Buffer.alloc(mp4.length) : mp4
      const { transport, requests } = setup(url =>
        url.endsWith(':countTokens')
          ? Response.json({ totalTokens: 5 })
          : Response.json(
              avResponse('video', failure === 'usage' ? { total_input_tokens: -1 } : usage, [
                { type: 'video', mime_type: failure === 'mime' ? 'text/html' : 'video/mp4', data: failure === 'base64' ? 'invalid!' : data.toString('base64') }
              ])
            )
      )
      await expect(transport.generateVideo({ prompt: 'A sunset.' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
      expect(requests).toHaveLength(2)
    })

  it('cleans uploaded references with an independent signal when inline generation is cancelled', async () => {
    const controller = new AbortController()
    let deleted = false
    const { transport } = setup((url, init) => {
      if (init.method === 'DELETE') {
        expect(init.signal?.aborted).toBe(false)
        deleted = true
        return new Response(null, { status: 204 })
      }
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 5 })
      if (url.endsWith('/interactions')) {
        controller.abort()
        return Response.json(avResponse('video'))
      }
      return url.includes('upload_id') ? Response.json({ file: file() }) : start()
    })
    await expect(transport.generateVideo({ prompt: 'A sunset.', images: [{ bytes: png, mimeType: 'image/png' }] }, controller.signal)).rejects.toThrow()
    expect(deleted).toBe(true)
  })

  it('returns complete video/text modality usage without losing thought tokens', async () => {
    const { transport } = setup((url, init) => {
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 5 })
      if (url.endsWith('/interactions'))
        return Response.json(
          avResponse('video', {
            ...usage,
            total_tokens: 13,
            total_thought_tokens: 3,
            output_tokens_by_modality: [
              { modality: 'video', tokens: 5 },
              { modality: 'text', tokens: 1 }
            ]
          })
        )
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      throw new Error('Unexpected media request')
    })
    const result = await transport.generateVideo({ prompt: 'A sunset.' })
    expect(result.outputTokensByModality).toEqual({ text: 1, video: 5 })
    expect(result.usage.totalTokens).toBe(13)
  })

  for (const [label, content] of [
    ['noncanonical base64', [{ type: 'audio', mime_type: 'audio/mp3', data: `${mp3.toString('base64')}!` }]],
    ['invalid audio', [{ type: 'audio', mime_type: 'audio/mpeg', data: Buffer.alloc(12).toString('base64') }]],
    [
      'multiple outputs',
      [
        { type: 'audio', mime_type: 'audio/mp3', data: mp3.toString('base64') },
        { type: 'audio', mime_type: 'audio/mp3', data: mp3.toString('base64') }
      ]
    ],
    ['unexpected video', [{ type: 'video', mime_type: 'video/mp4', uri: videoUri }]]
  ] as const)
    it(`rejects ${label} in music output`, async () => {
      const { transport } = setup(url =>
        url.endsWith(':countTokens') ? Response.json({ totalTokens: 5 }) : Response.json(avResponse('music', usage, [...content]))
      )
      await expect(transport.generateMusic({ prompt: 'A song.' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    })

  it('rejects music output above its decoded byte limit', async () => {
    const bytes = Buffer.alloc(GEMINI_MUSIC_OUTPUT_LIMIT + 1)
    bytes.write('ID3')
    const { transport } = setup(url =>
      url.endsWith(':countTokens')
        ? Response.json({ totalTokens: 5 })
        : Response.json(avResponse('music', usage, [{ type: 'audio', mime_type: 'audio/mp3', data: bytes.toString('base64') }]))
    )
    await expect(transport.generateMusic({ prompt: 'A song.' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
  })
})
