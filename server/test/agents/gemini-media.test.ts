import type { lookup } from 'node:dns/promises'
import createKnex, { type Knex } from 'knex'
import { AgentProviderFactory, type AgentProviderFetch, createGuardedProviderFetch } from '../../agents/providers/factory.ts'
import { createGeminiMediaTransport, GEMINI_MEDIA_INPUT_LIMIT, GEMINI_MEDIA_OUTPUT_LIMIT, GEMINI_PDF_INPUT_LIMIT } from '../../agents/providers/gemini-media.ts'
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
      ['/v1beta/files/abc:download', 'GET']
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
    const implementation = Object.assign(async () => { calls++; return Response.json({}) }, { preconnect: () => {} }) as AgentProviderFetch
    const guard = createGuardedProviderFetch(`${origin}/v1beta`, 'gemini-media', {}, implementation, resolve)
    const body = Buffer.alloc(GEMINI_MEDIA_INPUT_LIMIT + 1)
    body.write('%PDF-1.7')
    await guard(`${origin}/upload/v1beta/files?upload_id=abc`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body })
    for (const [path, type, bytes] of [
      ['/v1beta/interactions', 'application/pdf', body],
      ['/upload/v1beta/files?upload_id=abc', 'image/png', body],
      ['/upload/v1beta/files?upload_id=abc', 'application/pdf', Buffer.alloc(GEMINI_PDF_INPUT_LIMIT + 1)]
    ] as const)
      await expect(guard(`${origin}${path}`, { method: 'POST', headers: { 'content-type': type }, body: bytes })).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
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
