import type { lookup } from 'node:dns/promises'
import createKnex from 'knex'
import type { AgentMediaProviderConfig } from '../../../shared/agents/media-providers.ts'
import { AgentProviderFactory, createGuardedProviderFetch, deriveAgentProviderResourceLimits, type AgentProviderFetch } from '../../agents/providers/factory.ts'
import { createGoogleInteractionsMediaTransport } from '../../agents/providers/google-interactions-media.ts'
import { describe, expect, it } from '../bun-test.mts'

const baseUrl = 'https://generativelanguage.googleapis.com/v1beta'
const resolve = (async () => [{ address: '142.250.1.1', family: 4 }]) as unknown as typeof lookup
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPQSNnyHwAEOAJA4ywNkQAAAABJRU5ErkJggg==',
  'base64'
)
// A complete one-frame 16x16 H.264 fragmented MP4, not just an ftyp signature.
const video = Buffer.from(
  'AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC5G1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHndHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAABg21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAQAAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAS5taW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADuc3RibAAAAKJzdHNkAAAAAAAAAAEAAACSYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjIuMTEuMTAwIGxpYngyNjQAAAAAAAAAAAAAABj//wAAACxhdmNDAULACv/hABVnQsAK2nsBEAAAAwAQAAADACDxImoBAARozg/IAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDAAAABwbW9vZgAAABBtZmhkAAAAAAAAAAEAAABYdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADCAAAQAAAAAJgAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAGHRydW4AAAAFAAAAAQAAAHgCAAAAAAACaG1kYXQAAAJFBgX//0HcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAAATZYiEOhGKAAIxccAAQ8o4AAgF4AAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAAADCAEBAQAAABBtZnJvAAAAAAAAAEM=',
  'base64'
)
// Complete mono 8 kHz, 16-bit PCM WAV with eight silence samples.
const audio = Buffer.alloc(60)
audio.write('RIFF', 0)
audio.writeUInt32LE(audio.length - 8, 4)
audio.write('WAVEfmt ', 8)
audio.writeUInt32LE(16, 16)
audio.writeUInt16LE(1, 20)
audio.writeUInt16LE(1, 22)
audio.writeUInt32LE(8_000, 24)
audio.writeUInt32LE(16_000, 28)
audio.writeUInt16LE(2, 32)
audio.writeUInt16LE(16, 34)
audio.write('data', 36)
audio.writeUInt32LE(16, 40)

const configuration = (kind: 'video' | 'music', model = kind === 'video' ? 'gemini-omni-1.1-flash' : 'lyria-3.5'): AgentMediaProviderConfig => ({
  kind,
  api: 'gemini-interactions',
  model,
  baseUrl,
  timeoutMs: 5_000,
  maxInputTokens: 200,
  maxOutputTokens: 300,
  pricing:
    kind === 'video'
      ? { kind: 'tokens', pricingRevision: 'video-1|1000000|2000000', textOutputMicrosPerMillionTokens: 1_000_000 }
      : { kind: 'fixed', pricingRevision: 'music-1', costMicros: 30_000 }
})
const reportedUsage = {
  total_input_tokens: 4,
  total_output_tokens: 6,
  total_tokens: 10,
  total_thought_tokens: 0,
  total_tool_use_tokens: 0,
  total_cached_tokens: 0,
  input_tokens_by_modality: [{ modality: 'text', tokens: 4 }],
  output_tokens_by_modality: [
    { modality: 'text', tokens: 1 },
    { modality: 'video', tokens: 5 }
  ]
}
const mediaPart = (kind: 'video' | 'music') => ({
  type: kind === 'video' ? 'video' : 'audio',
  mime_type: kind === 'video' ? 'video/mp4' : 'audio/wav',
  data: (kind === 'video' ? video : audio).toString('base64')
})
// Official REST Resource:Interaction and ModelOutputStep, not SDK output_video/output_audio shortcuts.
// https://ai.google.dev/api/interactions.md.txt
const completed = (config: AgentMediaProviderConfig, overrides: Record<string, unknown> = {}) => ({
  object: 'interaction',
  id: 'interaction_generated_1',
  model: config.model,
  status: 'completed',
  created: '2026-10-06T00:00:00Z',
  updated: '2026-10-06T00:00:01Z',
  steps: [
    { type: 'user_input', content: [{ type: 'text', text: 'Do not expose echoed input' }] },
    { type: 'thought', signature: 'private-signature', summary: [{ type: 'text', text: 'Do not expose private thought' }] },
    { type: 'model_output', content: [{ type: 'text', text: 'Ready.' }, mediaPart(config.kind as 'video' | 'music')] }
  ],
  usage: config.kind === 'video' ? reportedUsage : { total_input_tokens: 4, total_output_tokens: 6, total_tokens: 10 },
  ...overrides
})
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>
const setup = (config: AgentMediaProviderConfig, handler: Handler) => {
  const requests: { url: string; init: RequestInit }[] = []
  const wire = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = { url: String(input), init: init || {} }
      requests.push(request)
      return handler(request.url, request.init)
    },
    { preconnect: () => {} }
  ) as AgentProviderFetch
  const limits = { ...deriveAgentProviderResourceLimits(config.maxOutputTokens), rawBodyBytes: 90 * 1_024 * 1_024, rawChunkBytes: 90 * 1_024 * 1_024 }
  return {
    requests,
    transport: createGoogleInteractionsMediaTransport({
      config,
      apiKey: 'media-key',
      fetch: createGuardedProviderFetch(baseUrl, 'google-interactions', {}, wire, resolve, limits, undefined, config.model)
    })
  }
}

describe('Google Interactions media protocol', () => {
  for (const kind of ['video', 'music'] as const)
    it(`decodes completed ${kind} model_output bytes and reported usage via one stateless configured Interactions POST`, async () => {
      const config = configuration(kind, kind === 'video' ? 'gemini-omni-flash-preview' : 'lyria-3-pro-preview')
      const { requests, transport } = setup(config, url => {
        expect(url).toBe(`${baseUrl}/interactions`)
        return Response.json(completed(config))
      })
      const result = await transport.generate({ prompt: 'A peaceful sunset' })
      expect(result).toEqual({
        text: 'Ready.',
        files: [{ bytes: kind === 'video' ? video : audio, mimeType: kind === 'video' ? 'video/mp4' : 'audio/wav' }],
        usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        usageSource: 'reported',
        ...(kind === 'video' ? { outputTokensByModality: { text: 1, video: 5 } } : {})
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.init.method).toBe('POST')
      expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
        model: config.model,
        input: [{ type: 'text', text: 'A peaceful sunset' }],
        store: false,
        stream: false,
        background: false,
        generation_config: { max_output_tokens: 300 }
      })
      expect(requests[0]?.init.redirect).toBe('manual')
      expect(requests[0]?.init.credentials).toBe('omit')
      expect(new Headers(requests[0]?.init.headers).get('x-goog-api-key')).toBe('media-key')
    })

  it('validates reference images, authorizes transfer and awaits full exposure reservation before exactly one paid dispatch', async () => {
    const config = configuration('video')
    const order: string[] = []
    const { transport, requests } = setup(config, () => {
      order.push('paid')
      return Response.json(completed(config))
    })
    await transport.generate({
      prompt: 'Animate',
      files: [{ bytes: png, mimeType: 'image/png' }],
      maxInputTokens: 100,
      maxOutputTokens: 120,
      beforeUpload: async () => {
        order.push('authorize')
      },
      beforeDispatch: async exposure => {
        expect(exposure).toEqual({ inputTokens: 100, outputTokens: 120, totalTokens: 220 })
        await Promise.resolve()
        order.push('reserve')
      },
      onDispatch: () => {
        order.push('dispatch')
      }
    })
    expect(order).toEqual(['authorize', 'reserve', 'dispatch', 'paid'])
    expect(requests).toHaveLength(1)
    expect(JSON.parse(String(requests[0]?.init.body)).input).toEqual([
      { type: 'text', text: 'Animate' },
      { type: 'image', mime_type: 'image/png', data: png.toString('base64') }
    ])
  })

  for (const kind of ['video', 'music'] as const)
    it(`labels absent ${kind} usage as estimated and retains the entire reserved configured exposure`, async () => {
      const config = configuration(kind)
      const { transport } = setup(config, () => Response.json(completed(config, { usage: undefined })))
      const result = await transport.generate({
        prompt: 'Generate',
        maxInputTokens: 1_000,
        maxOutputTokens: 1_000,
        beforeDispatch: async exposure => {
          expect(exposure).toEqual({ inputTokens: 200, outputTokens: 300, totalTokens: 500 })
        }
      })
      expect(result.usageSource).toBe('estimated')
      expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 300, totalTokens: 500 })
      expect(result).not.toHaveProperty('outputTokensByModality')
    })

  it('accounts reported thought tokens without revealing thought signatures or inventing modality allocation', async () => {
    const config = configuration('video')
    const { transport } = setup(config, () =>
      Response.json(
        completed(config, {
          usage: { ...reportedUsage, total_thought_tokens: 3, total_tokens: 13 }
        })
      )
    )
    const result = await transport.generate({ prompt: 'Generate' })
    expect(result.text).toBe('Ready.')
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 9, totalTokens: 13 })
    expect(result.usageSource).toBe('reported')
    expect(result).not.toHaveProperty('outputTokensByModality')
    expect(result).not.toHaveProperty('thoughtBlocks')
  })

  it('accepts a validated zero-token music receipt without substituting estimated token usage for fixed pricing', async () => {
    const config = configuration('music')
    const { transport } = setup(config, () =>
      Response.json(
        completed(config, {
          usage: { total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0 }
        })
      )
    )
    const result = await transport.generate({ prompt: 'Generate music' })
    expect(result.files).toEqual([{ bytes: audio, mimeType: 'audio/wav' }])
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(result.usageSource).toBe('reported')
  })

  for (const [usage, code] of [
    [null, 'INVALID_PROVIDER_RESPONSE'],
    [{}, 'INVALID_PROVIDER_RESPONSE'],
    [{ ...reportedUsage, total_tokens: 1 }, 'PROVIDER_USAGE_INVALID'],
    [{ ...reportedUsage, total_input_tokens: -1 }, 'INVALID_PROVIDER_RESPONSE'],
    [{ ...reportedUsage, total_output_tokens: 0.5 }, 'INVALID_PROVIDER_RESPONSE'],
    [{ ...reportedUsage, total_thought_tokens: 3 }, 'PROVIDER_USAGE_INVALID'],
    [{ ...reportedUsage, total_tool_use_tokens: 1 }, 'INVALID_PROVIDER_RESPONSE'],
    [{ ...reportedUsage, total_cached_tokens: 5 }, 'INVALID_PROVIDER_RESPONSE'],
    [{ ...reportedUsage, output_tokens_by_modality: [{ modality: 'video', tokens: 7 }] }, 'INVALID_PROVIDER_RESPONSE'],
    [
      {
        ...reportedUsage,
        output_tokens_by_modality: [
          { modality: 'video', tokens: 2 },
          { modality: 'video', tokens: 3 }
        ]
      },
      'INVALID_PROVIDER_RESPONSE'
    ]
  ] as const)
    it('rejects malformed reported accounting rather than relabeling it as an estimate', async () => {
      const config = configuration('video')
      const { transport, requests } = setup(config, () => Response.json(completed(config, { usage })))
      await expect(transport.generate({ prompt: 'Generate' })).rejects.toMatchObject({ code })
      expect(requests).toHaveLength(1)
    })

  it('rejects a valid receipt exceeding reserved exposure after one paid dispatch', async () => {
    const config = configuration('video')
    const { transport, requests } = setup(config, () =>
      Response.json(
        completed(config, {
          usage: { total_input_tokens: 4, total_output_tokens: 301, total_tokens: 305 }
        })
      )
    )
    let dispatched = 0
    await expect(
      transport.generate({
        prompt: 'Generate',
        onDispatch: () => {
          dispatched++
        }
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_USAGE_INVALID' })
    expect(dispatched).toBe(1)
    expect(requests).toHaveLength(1)
  })

  for (const overrides of [
    { object: undefined },
    { id: undefined },
    { id: '' },
    { model: undefined },
    { model: 'gemini-omni-flash-preview' },
    { status: 'incomplete' },
    { status: 'in_progress' },
    { status: 'failed' },
    { continuation_token: 'resume' },
    { steps: undefined, outputs: [mediaPart('video')] },
    { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'No media' }] }] },
    { steps: [{ type: 'provider_private', content: [mediaPart('video')] }] },
    {
      steps: [
        { type: 'tool_call', name: 'fetch_url', arguments: {} },
        { type: 'model_output', content: [mediaPart('video')] }
      ]
    }
  ])
    it('requires a completed matching interaction identity and official model_output steps', async () => {
      const config = configuration('video')
      const { transport, requests } = setup(config, () => Response.json(completed(config, overrides)))
      await expect(transport.generate({ prompt: 'Generate' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
      expect(requests).toHaveLength(1)
    })

  for (const part of [
    { ...mediaPart('video'), data: `${video.toString('base64')}\n` },
    { ...mediaPart('video'), data: Buffer.from('<script/>').toString('base64') },
    { ...mediaPart('video'), uri: 'https://evil.example/video' },
    { type: 'video', mime_type: 'video/mp4', uri: 'https://evil.example/video' },
    { ...mediaPart('video'), mime_type: 'video/webm' },
    mediaPart('music'),
    { type: 'function_call', name: 'fetch_url', arguments: {} }
  ])
    it('rejects malformed signatures, noncanonical base64, mismatched media, remote URLs and tools', async () => {
      const config = configuration('video')
      const { transport } = setup(config, () => Response.json(completed(config, { steps: [{ type: 'model_output', content: [part] }] })))
      await expect(transport.generate({ prompt: 'Generate' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    })

  it('rejects an invalid audio signature despite a valid completed envelope and usage', async () => {
    const config = configuration('music')
    const { transport } = setup(config, () =>
      Response.json(
        completed(config, {
          steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: Buffer.alloc(60).toString('base64') }] }]
        })
      )
    )
    await expect(transport.generate({ prompt: 'Generate' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
  })

  for (const failure of ['authorization', 'reservation', 'cancel'] as const)
    it(`does not dispatch after ${failure} before paid egress`, async () => {
      const config = configuration('video')
      const controller = new AbortController()
      const { transport, requests } = setup(config, () => {
        throw new Error('must not fetch')
      })
      let dispatched = 0
      await expect(
        transport.generate(
          {
            prompt: 'Animate',
            files: [{ bytes: png, mimeType: 'image/png' }],
            beforeUpload: async () => {
              if (failure === 'authorization') throw new Error('revoked')
            },
            beforeDispatch: async () => {
              if (failure === 'reservation') throw new Error('budget exceeded')
              if (failure === 'cancel') controller.abort()
            },
            onDispatch: () => {
              dispatched++
            }
          },
          controller.signal
        )
      ).rejects.toThrow()
      expect(dispatched).toBe(0)
      expect(requests).toHaveLength(0)
    })

  it('cancels an in-flight response body without repeating the paid dispatch', async () => {
    const config = configuration('video')
    const controller = new AbortController()
    let cancelled = 0
    const { transport, requests } = setup(
      config,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              controller.abort()
            },
            cancel() {
              cancelled++
            }
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    let dispatched = 0
    await expect(
      transport.generate(
        {
          prompt: 'Generate',
          onDispatch: () => {
            dispatched++
          }
        },
        controller.signal
      )
    ).rejects.toMatchObject({ code: 'AGENT_MEDIA_CANCELLED' })
    expect(cancelled).toBe(1)
    expect(dispatched).toBe(1)
    expect(requests).toHaveLength(1)
  })

  for (const status of [302, 429, 503])
    it(`does not retry or follow a paid ${status} response`, async () => {
      const config = configuration('video')
      const { transport, requests } = setup(
        config,
        () => new Response(null, { status, headers: { location: 'https://evil.example/private', 'retry-after': '0' } })
      )
      await expect(transport.generate({ prompt: 'Generate' })).rejects.toMatchObject({
        code: status === 302 ? 'PROVIDER_REDIRECT_DENIED' : `HTTP_${status}`,
        status
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe(`${baseUrl}/interactions`)
    })

  it('rejects unsupported input modalities and malformed images before authorization, reservation or egress', async () => {
    const config = configuration('video')
    const { transport, requests } = setup(config, () => {
      throw new Error('must not fetch')
    })
    let callbacks = 0
    for (const files of [
      [{ bytes: audio, mimeType: 'audio/wav' }],
      [{ bytes: video, mimeType: 'video/mp4' }],
      [{ bytes: png, mimeType: 'image/svg+xml' }],
      [{ bytes: Buffer.from('<svg/>'), mimeType: 'image/png' }],
      [{ bytes: png, mimeType: 'image/png; charset=utf-8' }],
      Array(5).fill({ bytes: png, mimeType: 'image/png' })
    ]) {
      await expect(
        transport.generate({
          prompt: 'Animate',
          files,
          beforeUpload: async () => {
            callbacks++
          },
          beforeDispatch: async () => {
            callbacks++
          },
          onDispatch: () => {
            callbacks++
          }
        })
      ).rejects.toMatchObject({ code: 'INVALID_MEDIA_INPUT' })
    }
    expect(callbacks).toBe(0)
    expect(requests).toHaveLength(0)
  })

  it('rejects unsupported models and API operations at construction with no egress', () => {
    let calls = 0
    const fetch = Object.assign(
      async () => {
        calls++
        return Response.json({})
      },
      { preconnect: () => {} }
    ) as AgentProviderFetch
    for (const config of [
      configuration('video', 'gemini-2.5-flash'),
      configuration('music', 'veo-3.1-generate-preview'),
      { ...configuration('video'), kind: 'image' },
      { ...configuration('video'), baseUrl: 'https://proxy.example/v1beta' }
    ])
      expect(() => createGoogleInteractionsMediaTransport({ config: config as AgentMediaProviderConfig, apiKey: 'key', fetch })).toThrow()
    expect(calls).toBe(0)
  })
})

describe('Interactions independent factory dispatch', () => {
  it('binds Omni and Lyria without any LLM profile and never routes generation through Ax GenerateContent', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    try {
      await db.schema.createTable('users', table => {
        table.integer('id').primary()
        table.boolean('isActive')
        table.integer('authVersion')
      })
      await db.schema.createTable('groups', table => {
        table.integer('id').primary()
        table.text('permissions')
      })
      await db.schema.createTable('userGroups', table => {
        table.integer('userId')
        table.integer('groupId')
      })
      await db.schema.createTable('agentMediaProviderConfiguration', table => {
        table.integer('id').primary()
        table.integer('revision')
      })
      await db.schema.createTable('agentMediaProviders', table => {
        table.string('id').primary()
        table.string('currentVersionId')
        table.boolean('enabled')
        table.string('exposureMode')
        table.timestamp('deletedAt').nullable()
      })
      await db.schema.createTable('agentMediaProviderVersions', table => {
        table.string('id').primary()
        table.string('providerId')
        table.text('config')
        table.string('secretReference')
      })
      await db.schema.createTable('agentProviderSecrets', table => {
        table.string('id').primary()
        table.string('algorithm')
        table.binary('nonce')
        table.binary('authTag')
        table.binary('ciphertext')
      })
      const secretId = '00000000-0000-4000-8000-000000000201'
      await db('users').insert({ id: 7, isActive: true, authVersion: 0 })
      await db('groups').insert({ id: 3, permissions: JSON.stringify(['use:agents']) })
      await db('userGroups').insert({ userId: 7, groupId: 3 })
      await db('agentMediaProviderConfiguration').insert({ id: 1, revision: 1 })
      await db('agentProviderSecrets').insert({
        id: secretId,
        algorithm: 'aes-256-gcm',
        nonce: Buffer.alloc(12),
        authTag: Buffer.alloc(16),
        ciphertext: Buffer.from('encrypted')
      })
      for (const [kind, versionId] of [
        ['video', '00000000-0000-4000-8000-000000000202'],
        ['music', '00000000-0000-4000-8000-000000000203']
      ] as const) {
        const config = configuration(kind)
        await db('agentMediaProviders').insert({ id: kind, currentVersionId: versionId, enabled: true, exposureMode: 'all_agent_users' })
        await db('agentMediaProviderVersions').insert({
          id: versionId,
          providerId: kind,
          config: JSON.stringify(config),
          secretReference: `managed:${secretId}`
        })
        const order: string[] = []
        const factory = new AgentProviderFactory(
          db,
          { get: async () => 'media-only-key' },
          Object.assign(
            async (url: URL | RequestInfo, init?: RequestInit) => {
              expect(String(url)).toBe(`${baseUrl}/interactions`)
              expect(JSON.parse(String(init?.body)).model).toBe(config.model)
              expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('media-only-key')
              order.push('paid')
              return Response.json(completed(config))
            },
            { preconnect: () => {} }
          ) as AgentProviderFetch,
          resolve
        )
        const binding = await factory.createMediaBinding(7, kind, versionId)
        expect(binding.config).toEqual(config)
        const result = await binding.transport.generate({
          prompt: 'Generate',
          beforeDispatch: async exposure => {
            expect(exposure).toEqual({ inputTokens: 200, outputTokens: 300, totalTokens: 500 })
            order.push('reserve')
          },
          onDispatch: () => {
            order.push('dispatch')
          }
        })
        expect(result.files[0]?.bytes).toEqual(kind === 'video' ? video : audio)
        expect(result.usageSource).toBe('reported')
        expect(order).toEqual(['reserve', 'dispatch', 'paid'])
      }
    } finally {
      await db.destroy()
    }
  })
})
