import sharp from 'sharp'
import { z } from 'zod'
import { AgentMediaProviderConfigSchema } from '../../../shared/agents/media-providers.ts'
import { AgentRepositoryError } from '../repository.ts'
import { AgentProviderAttemptError } from './factory.ts'
import {
  GEMINI_MEDIA_INPUT_LIMIT,
  GEMINI_VIDEO_OUTPUT_LIMIT,
  GEMINI_VIDEO_RESPONSE_LIMIT,
  GEMINI_MUSIC_OUTPUT_LIMIT,
  GEMINI_MUSIC_RESPONSE_LIMIT
} from './gemini-media.ts'
import type { AgentMediaResult, AgentMediaTransport, AgentMediaTransportOptions, AgentMediaUsage } from './media-transport.ts'
import { assertAgentTokenUsage } from './usage.ts'

const MAX_TEXT_BYTES = 64 * 1_024
const MAX_INPUT_PIXELS = 40_000_000
const INPUT_IMAGE_FORMATS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}
const invalidInput = (): AgentRepositoryError => new AgentRepositoryError('INVALID_MEDIA_INPUT', 'The media file or prompt is not supported', 400)
const invalidResponse = (): AgentRepositoryError => new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Google returned an invalid media interaction', 502)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const modalityTokens = z.array(z.object({ modality: z.enum(['text', 'image', 'audio', 'video', 'document']), tokens: count })).max(5)
// REST reference: https://ai.google.dev/api/interactions.md.txt#Resource:Interaction
// SDK output_video/output_audio convenience properties are not REST fields.
const usageSchema = z.object({
  total_input_tokens: count,
  total_output_tokens: count,
  total_tokens: count,
  total_thought_tokens: count.optional(),
  total_tool_use_tokens: count.optional(),
  total_cached_tokens: count.optional(),
  input_tokens_by_modality: modalityTokens.optional(),
  output_tokens_by_modality: modalityTokens.optional(),
  cached_tokens_by_modality: modalityTokens.optional(),
  tool_use_tokens_by_modality: modalityTokens.optional()
})
const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('model_output'), content: z.array(z.record(z.string(), z.unknown())).min(1).max(64) }),
  z.object({ type: z.literal('user_input'), content: z.array(z.record(z.string(), z.unknown())).max(64) }),
  z.object({
    type: z.literal('thought'),
    signature: z.string().max(262_144).optional(),
    summary: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
    content: z.array(z.record(z.string(), z.unknown())).max(64).optional()
  })
])
const envelopeSchema = z.object({
  object: z.literal('interaction'),
  id: z.string().min(1).max(2_048),
  model: z.string().min(1).max(128),
  status: z.literal('completed'),
  steps: z.array(stepSchema).min(1).max(128),
  usage: usageSchema.optional(),
  continuation_token: z.string().optional()
})

const readJson = async (response: Response, limit: number, signal: AbortSignal): Promise<unknown> => {
  const length = response.headers.get('content-length')
  if (
    response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' ||
    !response.body ||
    (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit))
  ) {
    await response.body?.cancel().catch(() => {})
    throw invalidResponse()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  const abort = (): void => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await reader.read()
      signal.throwIfAborted()
      if (item.done) break
      if (!(item.value instanceof Uint8Array) || chunks.length >= 65_536 || item.value.byteLength > limit - bytes) throw invalidResponse()
      bytes += item.value.byteLength
      chunks.push(item.value)
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown
    } catch {
      throw invalidResponse()
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const decodeMedia = (part: Record<string, unknown>, kind: 'video' | 'music', limit: number): AgentMediaResult['files'][number] => {
  const mime = part.mime_type
  const data = part.data
  if (
    typeof mime !== 'string' ||
    typeof data !== 'string' ||
    data.length === 0 ||
    data.length > 4 * Math.ceil(limit / 3) ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data) ||
    part.uri !== undefined ||
    (kind === 'video' ? mime !== 'video/mp4' : mime !== 'audio/mp3' && mime !== 'audio/mpeg' && mime !== 'audio/wav')
  )
    throw invalidResponse()
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0 || bytes.length > limit || bytes.toString('base64') !== data) throw invalidResponse()
  if (kind === 'video') {
    if (bytes.length < 24 || bytes.toString('ascii', 4, 8) !== 'ftyp' || bytes.readUInt32BE(0) < 16 || bytes.readUInt32BE(0) > bytes.length)
      throw invalidResponse()
  } else if (mime === 'audio/wav') {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw invalidResponse()
  } else if (bytes.length < 4 || !(bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))) throw invalidResponse()
  return { bytes, mimeType: mime === 'audio/mp3' ? 'audio/mpeg' : mime }
}

/** Media-only stateless Interactions. Native LLM chat remains GenerateContent. */
export const createGoogleInteractionsMediaTransport = (options: AgentMediaTransportOptions): AgentMediaTransport => {
  const config = AgentMediaProviderConfigSchema.parse(options.config)
  if (config.api !== 'gemini-interactions' || (config.kind !== 'video' && config.kind !== 'music')) throw invalidInput()
  const kind = config.kind
  const outputLimit = kind === 'video' ? GEMINI_VIDEO_OUTPUT_LIMIT : GEMINI_MUSIC_OUTPUT_LIMIT
  const responseLimit = kind === 'video' ? GEMINI_VIDEO_RESPONSE_LIMIT : GEMINI_MUSIC_RESPONSE_LIMIT
  return {
    async generate(input, signal) {
      const activeSignal = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(signal ? [signal] : [])])
      const prompt = input.prompt
      const files = input.files ?? []
      if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_TEXT_BYTES || files.length > 4) throw invalidInput()
      for (const limit of [input.maxInputTokens, input.maxOutputTokens]) {
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw invalidInput()
      }
      const maxInputTokens = Math.min(config.maxInputTokens, input.maxInputTokens ?? config.maxInputTokens)
      const maxOutputTokens = Math.min(config.maxOutputTokens, input.maxOutputTokens ?? config.maxOutputTokens)
      // No documented Interactions countTokens endpoint exists. Reserve the entire
      // configured exposure, including unseen media/thought tokens, not pretend counts.
      const exposure: AgentMediaUsage = { inputTokens: maxInputTokens, outputTokens: maxOutputTokens, totalTokens: maxInputTokens + maxOutputTokens }
      if (Buffer.byteLength(prompt) > maxInputTokens)
        throw new AgentRepositoryError('AGENT_MEDIA_CONTEXT_LIMIT', 'The prompt exceeds the media input exposure limit', 413)
      let inputBytes = 0
      // Validate all files before invoking any upload/dispatch hook or doing egress.
      for (const file of files) {
        const format = INPUT_IMAGE_FORMATS[file.mimeType]
        if (
          !Object.hasOwn(INPUT_IMAGE_FORMATS, file.mimeType) ||
          !(file.bytes instanceof Uint8Array) ||
          file.bytes.byteLength === 0 ||
          file.bytes.byteLength > GEMINI_MEDIA_INPUT_LIMIT - inputBytes ||
          (file.displayName !== undefined &&
            (file.displayName.length > 128 || Array.from(file.displayName).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)))
        )
          throw invalidInput()
        inputBytes += file.bytes.byteLength
        try {
          const metadata = await sharp(file.bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', animated: false }).metadata()
          if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS) throw invalidInput()
          await sharp(file.bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', animated: false }).stats()
        } catch {
          throw invalidInput()
        }
      }
      activeSignal.throwIfAborted()
      const content: Array<Record<string, string>> = [{ type: 'text', text: prompt }]
      for (const file of files) {
        content.push({
          type: 'image',
          mime_type: file.mimeType,
          data: Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength).toString('base64')
        })
      }
      const body = JSON.stringify({
        model: config.model,
        input: content,
        store: false,
        stream: false,
        background: false,
        generation_config: { max_output_tokens: maxOutputTokens }
      })
      if (Buffer.byteLength(body) > 4 * Math.ceil(GEMINI_MEDIA_INPUT_LIMIT / 3) + MAX_TEXT_BYTES + 16_384) throw invalidInput()
      if (files.length) await input.beforeUpload?.()
      await input.beforeDispatch?.(exposure)
      activeSignal.throwIfAborted()
      input.onDispatch?.()
      try {
        // Exactly one paid POST; no polling, continuation, or fallback generation.
        const response = await options.fetch(`${config.baseUrl.replace(/\/$/u, '')}/interactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
          body,
          signal: activeSignal,
          redirect: 'manual',
          credentials: 'omit'
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new AgentRepositoryError('AGENT_MEDIA_PROVIDER_FAILED', 'The media provider request failed', 502)
        }
        const parsed = envelopeSchema.safeParse(await readJson(response, responseLimit, activeSignal))
        if (!parsed.success || parsed.data.model !== config.model || parsed.data.continuation_token) throw invalidResponse()
        const generated: AgentMediaResult['files'] = []
        const texts: string[] = []
        let textBytes = 0
        let mediaBytes = 0
        for (const step of parsed.data.steps) {
          if (step.type !== 'model_output') continue
          for (const part of step.content) {
            if (part.type === 'text') {
              if (typeof part.text !== 'string' || Buffer.byteLength(part.text) > MAX_TEXT_BYTES - textBytes) throw invalidResponse()
              textBytes += Buffer.byteLength(part.text)
              texts.push(part.text)
            } else {
              if (part.type !== (kind === 'video' ? 'video' : 'audio') || generated.length >= (kind === 'video' ? 1 : 16)) throw invalidResponse()
              const file = decodeMedia(part, kind, outputLimit - mediaBytes)
              mediaBytes += file.bytes.length
              generated.push(file)
            }
          }
        }
        if (generated.length === 0) throw invalidResponse()
        let usage = exposure
        let usageSource: AgentMediaResult['usageSource'] = 'estimated'
        let outputTokensByModality: AgentMediaResult['outputTokensByModality']
        const raw = parsed.data.usage
        if (raw !== undefined) {
          if ((raw.total_tool_use_tokens ?? 0) !== 0 || (raw.total_cached_tokens ?? 0) > raw.total_input_tokens) throw invalidResponse()
          const outputTokens = raw.total_output_tokens + (raw.total_thought_tokens ?? 0)
          assertAgentTokenUsage(raw.total_input_tokens, outputTokens, raw.total_tokens)
          const validateBreakdown = (entries: z.infer<typeof modalityTokens> | undefined, maximum: number): void => {
            if (!entries) return
            const seen = new Set<string>()
            let total = 0
            for (const entry of entries) {
              if (seen.has(entry.modality) || entry.tokens > maximum - total) throw invalidResponse()
              seen.add(entry.modality)
              total += entry.tokens
            }
          }
          validateBreakdown(raw.input_tokens_by_modality, raw.total_input_tokens)
          validateBreakdown(raw.cached_tokens_by_modality, raw.total_cached_tokens ?? 0)
          validateBreakdown(raw.output_tokens_by_modality, raw.total_output_tokens)
          validateBreakdown(raw.tool_use_tokens_by_modality, 0)
          usage = { inputTokens: raw.total_input_tokens, outputTokens, totalTokens: raw.total_tokens }
          usageSource = 'reported'
          if (
            kind === 'video' &&
            raw.output_tokens_by_modality &&
            raw.output_tokens_by_modality.every(entry => entry.modality === 'text' || entry.modality === 'video') &&
            raw.output_tokens_by_modality.reduce((sum, entry) => sum + entry.tokens, 0) === raw.total_output_tokens &&
            (raw.total_thought_tokens ?? 0) === 0
          ) {
            outputTokensByModality = {
              text: raw.output_tokens_by_modality.find(entry => entry.modality === 'text')?.tokens ?? 0,
              video: raw.output_tokens_by_modality.find(entry => entry.modality === 'video')?.tokens ?? 0
            }
          }
          if (usage.inputTokens > maxInputTokens || usage.outputTokens > maxOutputTokens || usage.totalTokens > exposure.totalTokens)
            throw new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Media usage exceeded its reserved exposure', 502)
        }
        activeSignal.throwIfAborted()
        return { text: texts.join('\n'), files: generated, usage, usageSource, ...(outputTokensByModality ? { outputTokensByModality } : {}) }
      } catch (error) {
        if (activeSignal.aborted) throw new AgentRepositoryError('AGENT_MEDIA_CANCELLED', 'The media request was cancelled or timed out', 408)
        if (error instanceof AgentRepositoryError || error instanceof AgentProviderAttemptError) throw error
        throw new AgentRepositoryError('AGENT_MEDIA_PROVIDER_FAILED', 'The media provider request failed', 502)
      }
    }
  }
}
