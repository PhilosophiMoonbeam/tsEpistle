import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import { AgentMediaProviderConfigSchema } from '../../../shared/agents/media-providers.ts'
import { AgentRepositoryError } from '../repository.ts'
import type { AgentMediaGenerationInput, AgentMediaResult, AgentMediaTransport, AgentMediaTransportOptions, AgentMediaUsage } from './media-transport.ts'

const INPUT_LIMIT = 10 * 1_024 * 1_024
const OUTPUT_LIMIT = 10 * 1_024 * 1_024
const REQUEST_LIMIT = INPUT_LIMIT + 256 * 1_024
const JSON_LIMIT = Math.ceil(OUTPUT_LIMIT / 3) * 4 + 64 * 1_024
const PIXEL_LIMIT = 16_777_216
const imageTypes: Readonly<Record<string, string>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }
const invalidInput = (): AgentRepositoryError => new AgentRepositoryError('INVALID_MEDIA_INPUT', 'The image file or prompt is not supported', 400)
const invalidResponse = (): AgentRepositoryError =>
  new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'The image provider returned an invalid response', 502)
const denied = (): AgentRepositoryError => new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Image generation requires the official provider endpoint', 502)
const failed = (): AgentRepositoryError => new AgentRepositoryError('AGENT_MEDIA_PROVIDER_FAILED', 'The image provider request failed', 502)
const cancelled = (): AgentRepositoryError => new AgentRepositoryError('AGENT_MEDIA_CANCELLED', 'The media request was cancelled or timed out', 408)
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const usageSchema = z
  .object({ input_tokens: tokens, output_tokens: tokens, total_tokens: tokens })
  .refine(value => Number.isSafeInteger(value.input_tokens + value.output_tokens) && value.total_tokens === value.input_tokens + value.output_tokens)
const responseSchema = z.object({
  data: z
    .array(
      z.object({
        b64_json: z
          .string()
          .min(4)
          .max(Math.ceil(OUTPUT_LIMIT / 3) * 4),
        url: z.never().optional()
      })
    )
    .length(1),
  output_format: z.literal('png').optional(),
  usage: usageSchema.optional()
})

// Metadata alone accepts truncated images. stats() forces a full raster decode,
// with a bounded pixel count, before either reference upload or artifact storage.
const validateRaster = async (bytes: Uint8Array, mimeType: string, error: () => AgentRepositoryError): Promise<void> => {
  if (!bytes.byteLength || bytes.byteLength > INPUT_LIMIT || !Object.values(imageTypes).includes(mimeType)) throw error()
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: PIXEL_LIMIT, animated: false })
    const metadata = await image.metadata()
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > 8192 ||
      metadata.height > 8192 ||
      metadata.width * metadata.height > PIXEL_LIMIT ||
      (metadata.pages ?? 1) !== 1 ||
      imageTypes[metadata.format ?? ''] !== mimeType
    )
      throw error()
    await image.stats()
  } catch {
    throw error()
  }
}

const readBounded = async (response: Response, signal: AbortSignal, limit: number): Promise<Buffer> => {
  const declared = response.headers.get('content-length')
  if (!response.body || (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit))) {
    await response.body?.cancel().catch(() => {})
    throw invalidResponse()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  const abort = (): void => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit) throw invalidResponse()
      chunks.push(chunk.value)
    }
    if (length === 0) throw invalidResponse()
    return Buffer.concat(chunks, length)
  } catch {
    if (signal.aborted) throw cancelled()
    throw invalidResponse()
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** One paid request; no Files API upload, remote image download, redirect, or retry. */
export const createIndependentImageMediaTransport = (options: AgentMediaTransportOptions): AgentMediaTransport => {
  const parsed = AgentMediaProviderConfigSchema.safeParse(options.config)
  if (!parsed.success || parsed.data.kind !== 'image' || !['openai-images', 'stability-images'].includes(parsed.data.api)) throw invalidInput()
  const config = parsed.data
  const openai = config.api === 'openai-images'
  const origin = openai ? 'https://api.openai.com' : 'https://api.stability.ai'
  let base: URL
  try {
    base = new URL(config.baseUrl)
  } catch {
    throw denied()
  }
  if (
    base.origin !== origin ||
    !(openai ? ['/v1', '/v1/'] : ['', '/', '/v2beta', '/v2beta/']).includes(base.pathname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw denied()
  if (!options.apiKey || /[\r\n]/u.test(options.apiKey)) throw invalidInput()

  return {
    async generate(input: AgentMediaGenerationInput, signal?: AbortSignal): Promise<AgentMediaResult> {
      const operationSignal = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(signal ? [signal] : [])])
      try {
        operationSignal.throwIfAborted()
        const files = input.files ?? []
        const prompt = input.prompt
        if (
          typeof prompt !== 'string' ||
          !prompt.trim() ||
          prompt.length > (openai ? 32_000 : 10_000) ||
          Buffer.byteLength(prompt, 'utf8') > 128_000 ||
          files.length > 16 ||
          (!openai && files.length)
        )
          throw invalidInput()
        const limit = (value: number | undefined, configured: number): number => {
          if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > configured)) throw invalidInput()
          return value ?? configured
        }
        const maxInput = limit(input.maxInputTokens, config.maxInputTokens)
        const maxOutput = limit(input.maxOutputTokens, config.maxOutputTokens)
        let inputBytes = 0
        for (const file of files) {
          if (!(file.bytes instanceof Uint8Array)) throw invalidInput()
          inputBytes += file.bytes.byteLength
          if (inputBytes > INPUT_LIMIT) throw invalidInput()
          await validateRaster(file.bytes, file.mimeType, invalidInput)
          operationSignal.throwIfAborted()
        }
        const exposure: AgentMediaUsage = openai
          ? { inputTokens: maxInput, outputTokens: maxOutput, totalTokens: maxInput + maxOutput }
          : { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
        let body: string | Buffer<ArrayBuffer>
        const headers = new Headers({ authorization: `Bearer ${options.apiKey}`, accept: openai ? 'application/json' : 'image/*' })
        const path = openai ? (files.length ? '/v1/images/edits' : '/v1/images/generations') : '/v2beta/stable-image/generate/core'
        if (openai && !files.length) {
          headers.set('content-type', 'application/json')
          // GPT Image always returns b64_json. response_format is a legacy-only
          // parameter and is rejected by current GPT Image endpoints.
          body = JSON.stringify({ model: config.model, prompt, n: 1, output_format: 'png', size: '1024x1024' })
        } else {
          const boundary = `agent-media-${randomUUID()}`
          const parts: Buffer[] = []
          const field = (name: string, value: string): void => {
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
          }
          field('prompt', prompt)
          field('output_format', 'png')
          if (openai) {
            field('model', config.model)
            field('n', '1')
            field('size', '1024x1024')
            files.forEach((file, index) => {
              const extension = file.mimeType === 'image/jpeg' ? 'jpeg' : file.mimeType === 'image/webp' ? 'webp' : 'png'
              parts.push(
                Buffer.from(
                  `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference-${index}.${extension}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`
                )
              )
              parts.push(Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength), Buffer.from('\r\n'))
            })
          }
          parts.push(Buffer.from(`--${boundary}--\r\n`))
          const length = parts.reduce((sum, part) => sum + part.length, 0)
          if (length > (openai ? REQUEST_LIMIT : 128 * 1_024)) throw invalidInput()
          body = Buffer.concat(parts, length)
          headers.set('content-type', `multipart/form-data; boundary=${boundary}`)
        }
        operationSignal.throwIfAborted()
        await input.beforeUpload?.()
        operationSignal.throwIfAborted()
        await input.beforeDispatch?.(exposure)
        operationSignal.throwIfAborted()
        input.onDispatch?.()
        let response: Response
        try {
          response = await options.fetch(`${origin}${path}`, {
            method: 'POST',
            body,
            headers,
            signal: operationSignal,
            redirect: 'manual',
            credentials: 'omit'
          })
        } catch (error) {
          if (operationSignal.aborted) throw cancelled()
          if (error instanceof AgentRepositoryError) throw error
          throw failed()
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          if (response.status >= 300 && response.status < 400) throw denied()
          throw failed()
        }
        const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (!openai) {
          if (response.headers.get('finish-reason') !== 'SUCCESS' || mime !== 'image/png') {
            await response.body?.cancel().catch(() => {})
            throw invalidResponse()
          }
          const bytes = await readBounded(response, operationSignal, OUTPUT_LIMIT)
          await validateRaster(bytes, 'image/png', invalidResponse)
          operationSignal.throwIfAborted()
          // Core has no token receipt; configured fixed pricing is host-owned.
          return { text: '', usage: exposure, files: [{ bytes, mimeType: 'image/png' }], usageSource: 'estimated' }
        }
        if (mime !== 'application/json') {
          await response.body?.cancel().catch(() => {})
          throw invalidResponse()
        }
        const payload = await readBounded(response, operationSignal, JSON_LIMIT)
        let envelope: z.infer<typeof responseSchema>
        try {
          envelope = responseSchema.parse(JSON.parse(payload.toString('utf8')))
        } catch {
          throw invalidResponse()
        }
        const encoded = envelope.data[0]!.b64_json
        if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(encoded)) throw invalidResponse()
        const bytes = Buffer.from(encoded, 'base64')
        if (bytes.toString('base64') !== encoded) throw invalidResponse()
        await validateRaster(bytes, 'image/png', invalidResponse)
        operationSignal.throwIfAborted()
        const usage = envelope.usage
          ? { inputTokens: envelope.usage.input_tokens, outputTokens: envelope.usage.output_tokens, totalTokens: envelope.usage.total_tokens }
          : exposure
        return { text: '', usage, files: [{ bytes, mimeType: 'image/png' }], usageSource: envelope.usage ? 'reported' : 'estimated' }
      } catch (error) {
        if (operationSignal.aborted) throw cancelled()
        throw error
      }
    }
  }
}
