import sharp from 'sharp'
import type { AgentMediaProviderConfig } from '../../../shared/agents/media-providers.ts'
import type { AgentProviderFetch } from '../../agents/providers/factory.ts'
import { createIndependentImageMediaTransport } from '../../agents/providers/independent-image-media.ts'
import { describe, expect, it } from '../bun-test.mts'

const config = (api: 'openai-images' | 'stability-images' = 'openai-images', model = 'gpt-image-1.5'): AgentMediaProviderConfig => ({
  kind: 'image',
  api,
  model: api === 'stability-images' ? 'stable-image-core' : model,
  baseUrl: api === 'stability-images' ? 'https://api.stability.ai/v2beta' : 'https://api.openai.com/v1',
  timeoutMs: 10_000,
  maxInputTokens: 4096,
  maxOutputTokens: 8192,
  pricing:
    api === 'stability-images'
      ? { kind: 'fixed', pricingRevision: 'configured', costMicros: 12345 }
      : { kind: 'tokens', pricingRevision: 'configured|5000000|40000000' }
})
const raster = async (): Promise<Buffer> =>
  sharp({ create: { width: 2, height: 2, channels: 4, background: '#fff' } })
    .png()
    .toBuffer()
const transport = (fetch: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>, profile = config()) =>
  createIndependentImageMediaTransport({ config: profile, apiKey: 'private-key', fetch: Object.assign(fetch, { preconnect: () => {} }) as AgentProviderFetch })
const imageResponse = (png: Buffer, usage: unknown = { input_tokens: 7, output_tokens: 11, total_tokens: 18 }): Response =>
  Response.json({ data: [{ b64_json: png.toString('base64') }], ...(usage === undefined ? {} : { usage }) })

describe('Independent image API contracts', () => {
  it('edits inline raster references with the configured model and normalizes the provider token receipt', async () => {
    const png = await raster()
    let requests = 0
    const events: string[] = []
    const result = await transport(
      async (url, init) => {
        requests++
        events.push('fetch')
        expect(String(url)).toBe('https://api.openai.com/v1/images/edits')
        expect(init?.redirect).toBe('manual')
        const multipart = await new Request(String(url), init).formData()
        expect(multipart.get('model')).toBe('gpt-image-1-mini')
        expect(multipart.get('output_format')).toBe('png')
        const reference = multipart.get('image[]') as File
        expect(reference.type).toBe('image/png')
        expect(Buffer.from(await reference.arrayBuffer())).toEqual(png)
        return imageResponse(png)
      },
      config('openai-images', 'gpt-image-1-mini')
    ).generate({
      prompt: 'Paint the reference blue',
      files: [{ bytes: png, mimeType: 'image/png' }],
      beforeUpload: async () => {
        events.push('upload-check')
      },
      beforeDispatch: async usage => {
        expect(usage).toEqual({ inputTokens: 4096, outputTokens: 8192, totalTokens: 12288 })
        events.push('reserve')
      },
      onDispatch: () => {
        events.push('dispatch')
      }
    })
    expect(requests).toBe(1)
    expect(events).toEqual(['upload-check', 'reserve', 'dispatch', 'fetch'])
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 11, totalTokens: 18 })
    expect(result.usageSource).toBe('reported')
    expect(result.files).toEqual([{ bytes: png, mimeType: 'image/png' }])
  })

  it('generates base64 output without legacy response_format and labels missing usage as conservative estimates', async () => {
    const png = await raster()
    const result = await transport(
      async (url, init) => {
        expect(String(url)).toBe('https://api.openai.com/v1/images/generations')
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.model).toBe('gpt-image-2')
        expect(body.response_format).toBeUndefined()
        return Response.json({ data: [{ b64_json: png.toString('base64') }] })
      },
      config('openai-images', 'gpt-image-2')
    ).generate({ prompt: 'A blue square', maxInputTokens: 100, maxOutputTokens: 200 })
    expect(result.usageSource).toBe('estimated')
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 200, totalTokens: 300 })
  })

  it('rejects Stability reference images before admission hooks or any egress', async () => {
    let calls = 0
    const adapter = transport(async () => {
      calls++
      throw new Error('Unexpected egress')
    }, config('stability-images'))
    await expect(
      adapter.generate({
        prompt: 'A landscape',
        files: [{ bytes: await raster(), mimeType: 'image/png' }],
        beforeUpload: async () => {
          calls++
        },
        beforeDispatch: async () => {
          calls++
        },
        onDispatch: () => {
          calls++
        }
      })
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA_INPUT' })
    expect(calls).toBe(0)
  })

  it('uses standalone Stable Core multipart generation with a zero-token fixed-price receipt', async () => {
    const png = await raster()
    const result = await transport(async (url, init) => {
      expect(String(url)).toBe('https://api.stability.ai/v2beta/stable-image/generate/core')
      expect(new Headers(init?.headers).get('accept')).toBe('image/*')
      const body = await new Request(String(url), init).formData()
      expect(body.get('prompt')).toBe('A landscape')
      expect(body.get('output_format')).toBe('png')
      return new Response(png, { headers: { 'content-type': 'image/png', 'finish-reason': 'SUCCESS' } })
    }, config('stability-images')).generate({ prompt: 'A landscape' })
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(result.usageSource).toBe('estimated')
    expect(result.files[0]?.bytes).toEqual(png)
  })

  it('rejects corrupt raster references before any hook or request', async () => {
    let calls = 0
    const adapter = transport(async () => {
      calls++
      throw new Error('Unexpected egress')
    })
    const truncated = (await raster()).subarray(0, 40)
    await expect(
      adapter.generate({
        prompt: 'Edit',
        files: [{ bytes: truncated, mimeType: 'image/png' }],
        beforeUpload: async () => {
          calls++
        },
        onDispatch: () => {
          calls++
        }
      })
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA_INPUT' })
    expect(calls).toBe(0)
  })

  it('does not dispatch after admission is cancelled while reserving exposure', async () => {
    const controller = new AbortController()
    let calls = 0
    const adapter = transport(async () => {
      calls++
      throw new Error('Unexpected egress')
    })
    await expect(
      adapter.generate(
        {
          prompt: 'An image',
          beforeDispatch: async () => {
            controller.abort()
          },
          onDispatch: () => {
            calls++
          }
        },
        controller.signal
      )
    ).rejects.toMatchObject({ code: 'AGENT_MEDIA_CANCELLED' })
    expect(calls).toBe(0)
  })

  it('never follows a provider output URL or retries a paid request after invalid output', async () => {
    let calls = 0
    const adapter = transport(async () => {
      calls++
      return Response.json({ data: [{ url: 'https://evil.invalid/private' }] })
    })
    await expect(adapter.generate({ prompt: 'An image' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    expect(calls).toBe(1)
  })

  it('rejects inconsistent token receipts rather than recording fabricated measured usage', async () => {
    const png = await raster()
    await expect(
      transport(async () => imageResponse(png, { input_tokens: 7, output_tokens: 11, total_tokens: 3 })).generate({ prompt: 'An image' })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
  })

  it('requires Stable Core success and a fully decoded PNG, not a MIME header or magic bytes alone', async () => {
    const png = await raster()
    for (const [reason, bytes] of [
      ['CONTENT_FILTERED', png],
      ['SUCCESS', png.subarray(0, 40)]
    ] as const) {
      await expect(
        transport(async () => new Response(bytes, { headers: { 'content-type': 'image/png', 'finish-reason': reason } }), config('stability-images')).generate({
          prompt: 'An image'
        })
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    }
  })

  it('keeps provider errors and API credentials out of public failures without retrying', async () => {
    let calls = 0
    let dispatches = 0
    await expect(
      transport(async () => {
        calls++
        throw new Error('private-key: raw upstream diagnostic')
      }).generate({
        prompt: 'An image',
        onDispatch: () => {
          dispatches++
        }
      })
    ).rejects.toMatchObject({ code: 'AGENT_MEDIA_PROVIDER_FAILED', message: 'The image provider request failed' })
    expect(calls).toBe(1)
    expect(dispatches).toBe(1)
  })
})

describe('Independent image network boundaries', () => {
  it('rejects redirects without following or retrying them', async () => {
    let calls = 0
    await expect(
      transport(async () => {
        calls++
        return new Response(null, { status: 307, headers: { location: 'https://evil.invalid' } })
      }).generate({ prompt: 'An image' })
    ).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    expect(calls).toBe(1)
  })

  it('bounds provider response bodies before buffering oversized declared output', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      }
    })
    await expect(
      transport(
        async () => new Response(body, { headers: { 'content-type': 'image/png', 'finish-reason': 'SUCCESS', 'content-length': '10485761' } }),
        config('stability-images')
      ).generate({ prompt: 'An image' })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    expect(cancelled).toBe(true)
  })

  it('sanitizes stream failures rather than leaking upstream diagnostics', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('private-key: stream error'))
      }
    })
    await expect(
      transport(async () => new Response(body, { headers: { 'content-type': 'application/json' } })).generate({ prompt: 'An image' })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', message: 'The image provider returned an invalid response' })
  })
})
