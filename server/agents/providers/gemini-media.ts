import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { ai, type AxAIGoogleGeminiModel, type AxChatRequest } from '@ax-llm/ax'

import { AgentRepositoryError } from '../repository.ts'
import { AgentProviderAttemptError, type AgentProviderFetch } from './factory.ts'

export const GEMINI_MEDIA_INPUT_LIMIT = 10 * 1_024 * 1_024
export const GEMINI_PDF_INPUT_LIMIT = 48_000_000
export const GEMINI_MEDIA_OUTPUT_LIMIT = 16 * 1_024 * 1_024
export const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image'
export const GEMINI_TRANSCRIPTION_MODEL = 'gemini-3.5-transcribe'
export const GEMINI_VIDEO_MODEL = 'gemini-omni-1.1-flash'
export const GEMINI_MUSIC_MODEL = 'lyria-3.5'
export const GEMINI_VIDEO_OUTPUT_LIMIT = 64 * 1_024 * 1_024
export const GEMINI_VIDEO_RESPONSE_LIMIT = 90 * 1_024 * 1_024
export const GEMINI_MUSIC_OUTPUT_LIMIT = 16 * 1_024 * 1_024
export const GEMINI_MUSIC_RESPONSE_LIMIT = 24 * 1_024 * 1_024
const GENERATED_MEDIA_TOKEN_LIMIT = 65_536
const ORIGIN = 'https://generativelanguage.googleapis.com'
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const AUDIO_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/flac'])
const FILE_NAME = /^files\/[a-zA-Z0-9_-]{1,128}$/u
const MAX_TEXT = 64 * 1_024

export interface GeminiMediaInput {
  bytes: Uint8Array
  mimeType: string
  displayName?: string
}
export interface GeminiMediaFile {
  name: string
  uri: string
  mimeType: string
}
export interface GeminiMediaUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}
export interface GeminiMediaOptions {
  apiKey: string
  baseUrl: string
  timeoutMs: number
  maxInputTokens?: number
  maxOutputTokens?: number
  /** Must be the factory's DNS-pinned, origin/path-approved provider fetch. */
  fetch: AgentProviderFetch
}
export type GeminiMediaContent = { type: 'text'; text: string } | { type: 'image' | 'audio' | 'document'; uri: string; mime_type: string }
export interface GeminiGeneratedMediaResult {
  text: string
  usage: GeminiMediaUsage
  files: { bytes: Buffer; mimeType: string }[]
  usageSource: 'reported' | 'estimated'
  outputTokensByModality?: { text: number; video: number }
}
export interface GeminiMediaTokenLimits {
  maxInputTokens?: number
  maxOutputTokens?: number
  onDispatch?: () => void
  beforeDispatch?: (usage: GeminiMediaUsage) => Promise<void>
  beforeUpload?: () => Promise<void>
}

const invalid = (): AgentRepositoryError => new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Gemini returned an invalid media response', 502)
const inputError = (): AgentRepositoryError => new AgentRepositoryError('INVALID_MEDIA_INPUT', 'The media file or prompt is not supported', 400)
const denied = (): AgentRepositoryError => new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Gemini media requires the official Google endpoint', 502)
const fileSchema = z.object({
  name: z.string().regex(FILE_NAME),
  uri: z.string().max(512),
  mimeType: z.string().max(128),
  state: z.enum(['PROCESSING', 'ACTIVE', 'FAILED']),
  sizeBytes: z.string().regex(/^\d+$/u).optional()
})
// Ax 25 does not expose Gemini transcription usage or normalize Gemini image
// inlineData. Only those missing fields are read by this application bridge.
const usageSchema = z
  .object({
    promptTokenCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    candidatesTokenCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    totalTokenCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    thoughtsTokenCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .refine(value => value.totalTokenCount >= value.promptTokenCount + value.candidatesTokenCount + (value.thoughtsTokenCount ?? 0))
const inlineImageSchema = z.strictObject({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z.string().max(GEMINI_MEDIA_OUTPUT_LIMIT)
})
const mediaEnvelopeSchema = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.literal('STOP'),
        content: z.object({ parts: z.array(z.record(z.string(), z.unknown())).min(1).max(64) })
      })
    )
    .length(1),
  usageMetadata: usageSchema
})

const validRaster = (bytes: Uint8Array, mime: string): boolean => {
  const buffer = Buffer.from(bytes)
  if (mime === 'image/png')
    return buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR'
  if (mime === 'image/jpeg') return buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
  if (mime === 'image/webp') return buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
  return mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))
}
const validateInput = (input: GeminiMediaInput): void => {
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > (input.mimeType === 'application/pdf' ? GEMINI_PDF_INPUT_LIMIT : GEMINI_MEDIA_INPUT_LIMIT) ||
    (!IMAGE_TYPES.has(input.mimeType) && !AUDIO_TYPES.has(input.mimeType) && input.mimeType !== 'application/pdf') ||
    (IMAGE_TYPES.has(input.mimeType) && !validRaster(input.bytes, input.mimeType)) ||
    (input.mimeType === 'application/pdf' && Buffer.from(input.bytes).toString('ascii', 0, 5) !== '%PDF-') ||
    (input.displayName !== undefined &&
      (input.displayName.length > 128 || Array.from(input.displayName).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)))
  )
    throw inputError()
}
const decodeImage = (data: string, mimeType: string): { bytes: Buffer; mimeType: string } => {
  if (data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(data)) throw invalid()
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || bytes.length > GEMINI_MEDIA_INPUT_LIMIT || bytes.toString('base64') !== data || !validRaster(bytes, mimeType)) throw invalid()
  return { bytes, mimeType }
}

/** Temporary Files API uploads are removed after each generation, including failures and cancellation. */
export const createGeminiMediaTransport = (options: GeminiMediaOptions) => {
  let base: URL
  try {
    base = new URL(options.baseUrl)
  } catch {
    throw denied()
  }
  if (base.origin !== ORIGIN || !['/v1beta', '/v1beta/'].includes(base.pathname) || base.search || base.hash || base.username || base.password) throw denied()
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000) throw inputError()
  const tokenLimit = (value: number | undefined): void => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000)) throw inputError()
  }
  tokenLimit(options.maxInputTokens)
  tokenLimit(options.maxOutputTokens)
  const operationSignal = (signal?: AbortSignal): AbortSignal => AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(signal ? [signal] : [])])
  const request = async (url: string, init: RequestInit, signal: AbortSignal): Promise<Response> => {
    signal.throwIfAborted()
    const headers = new Headers(init.headers)
    headers.set('x-goog-api-key', options.apiKey)
    let response: Response
    try {
      response = await options.fetch(url, {
        ...init,
        headers,
        signal,
        redirect: 'manual',
        credentials: 'omit'
      })
    } catch (error) {
      if (signal.aborted) throw new AgentRepositoryError('AGENT_MEDIA_CANCELLED', 'The media request was cancelled or timed out', 408)
      if (error instanceof AgentRepositoryError || error instanceof AgentProviderAttemptError) throw error
      throw new AgentRepositoryError('AGENT_MEDIA_PROVIDER_FAILED', 'The media provider request failed', 502)
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw denied()
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new AgentRepositoryError('AGENT_MEDIA_PROVIDER_FAILED', 'The media provider request failed', 502)
    }
    return response
  }
  const json = async (response: Response, signal: AbortSignal, limit = GEMINI_MEDIA_OUTPUT_LIMIT): Promise<unknown> => {
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' || !response.body) {
      await response.body?.cancel()
      throw invalid()
    }
    const declared = response.headers.get('content-length')
    if (declared && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
      await response.body.cancel()
      throw invalid()
    }
    const reader = response.body.getReader()
    let size = 0
    const chunks: Uint8Array[] = []
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
        size += chunk.value.byteLength
        if (size > limit) throw invalid()
        chunks.push(chunk.value)
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      } catch {
        throw invalid()
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  const remove = async (name: string, signal?: AbortSignal): Promise<void> => {
    if (!FILE_NAME.test(name)) throw inputError()
    const response = await request(`${ORIGIN}/v1beta/${name}`, { method: 'DELETE' }, operationSignal(signal))
    await response.body?.cancel()
  }
  const cleanup = async (names: readonly string[]): Promise<void> => {
    // A caller's abort must not cancel deletion. Google's 48-hour expiry is the fallback if deletion fails.
    const signal = AbortSignal.timeout(Math.min(options.timeoutMs, 5_000))
    await Promise.allSettled(names.map(name => remove(name, signal)))
  }
  const upload = async (input: GeminiMediaInput, signal?: AbortSignal): Promise<GeminiMediaFile> => {
    validateInput(input)
    const activeSignal = operationSignal(signal)
    let uploadedName: string | undefined
    try {
      const started = await request(
        `${ORIGIN}/upload/v1beta/files`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-upload-protocol': 'resumable',
            'x-goog-upload-command': 'start',
            'x-goog-upload-header-content-length': String(input.bytes.byteLength),
            'x-goog-upload-header-content-type': input.mimeType
          },
          body: JSON.stringify({
            file: {
              display_name: input.displayName || 'Wiki Agent attachment'
            }
          })
        },
        activeSignal
      )
      const location = started.headers.get('x-goog-upload-url')
      await started.body?.cancel()
      if (!location || location.length > 2_048) throw denied()
      let destination: URL
      try {
        destination = new URL(location)
      } catch {
        throw denied()
      }
      if (
        destination.origin !== ORIGIN ||
        destination.pathname !== '/upload/v1beta/files' ||
        destination.hash ||
        destination.username ||
        destination.password ||
        [...destination.searchParams.keys()].some(key => !['upload_id', 'upload_protocol'].includes(key)) ||
        !/^[A-Za-z0-9_-]{1,1024}$/u.test(destination.searchParams.get('upload_id') || '') ||
        destination.searchParams.getAll('upload_id').length !== 1 ||
        destination.searchParams.getAll('upload_protocol').length > 1 ||
        (destination.searchParams.has('upload_protocol') && destination.searchParams.get('upload_protocol') !== 'resumable')
      )
        throw denied()
      const uploaded = await json(
        await request(
          destination.href,
          {
            method: 'POST',
            headers: {
              'content-type': input.mimeType,
              'content-length': String(input.bytes.byteLength),
              'x-goog-upload-offset': '0',
              'x-goog-upload-command': 'upload, finalize'
            },
            body: Buffer.from(input.bytes)
          },
          activeSignal
        ),
        activeSignal,
        64 * 1_024
      )
      const uploadedIdentity = z.object({ file: z.object({ name: z.string().regex(FILE_NAME) }) }).safeParse(uploaded)
      if (uploadedIdentity.success) uploadedName = uploadedIdentity.data.file.name
      const wrapper = z.object({ file: fileSchema }).safeParse(uploaded)
      if (!wrapper.success) throw invalid()
      let file = wrapper.data.file
      uploadedName = file.name
      for (let poll = 0; ; poll++) {
        if (
          file.uri !== `${ORIGIN}/v1beta/${file.name}` ||
          file.name !== uploadedName ||
          file.mimeType !== input.mimeType ||
          (file.sizeBytes !== undefined && Number(file.sizeBytes) !== input.bytes.byteLength)
        )
          throw invalid()
        if (file.state === 'ACTIVE') return { name: file.name, uri: file.uri, mimeType: file.mimeType }
        if (file.state === 'FAILED' || poll >= 30)
          throw new AgentRepositoryError('AGENT_MEDIA_PROCESSING_FAILED', 'The media provider could not process this file', 502)
        await delay(250, undefined, { signal: activeSignal })
        const next = fileSchema.safeParse(
          await json(await request(`${ORIGIN}/v1beta/${uploadedName}`, { method: 'GET' }, activeSignal), activeSignal, 64 * 1_024)
        )
        if (!next.success) throw invalid()
        file = next.data
      }
    } catch (error) {
      if (uploadedName) await cleanup([uploadedName])
      throw error
    }
  }
  type CountPart = { text: string } | { fileData: { fileUri: string; mimeType: string } } | { inlineData: { data: string; mimeType: string } }
  const countParts = async (model: string, parts: readonly CountPart[], signal: AbortSignal): Promise<number> => {
    const parsed = z.object({ totalTokens: z.number().int().nonnegative().max(10_000_000) }).safeParse(
      await json(
        await request(
          `${ORIGIN}/v1beta/models/${model}:countTokens`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts }] })
          },
          signal
        ),
        signal,
        64 * 1_024
      )
    )
    if (!parsed.success) throw invalid()
    return parsed.data.totalTokens
  }
  const countTokens = async (model: string, input: readonly GeminiMediaContent[], signal?: AbortSignal): Promise<number> => {
    // Count both supported Gemini families, including the dedicated image/audio models.
    if (!/^gemini-[23](?:\.[0-9]+)?(?:-[a-z0-9][a-z0-9._-]*)?$/u.test(model) || model.length > 128 || input.length > 32) throw inputError()
    const parts = input.map(block => {
      if (block.type === 'text') {
        if (typeof block.text !== 'string' || block.text.length > MAX_TEXT) throw inputError()
        return { text: block.text }
      }
      const name = block.uri.startsWith(`${ORIGIN}/v1beta/`) ? block.uri.slice(`${ORIGIN}/v1beta/`.length) : ''
      if (
        !FILE_NAME.test(name) ||
        (block.type === 'document'
          ? block.mime_type !== 'application/pdf'
          : block.type === 'image'
            ? !IMAGE_TYPES.has(block.mime_type)
            : !AUDIO_TYPES.has(block.mime_type))
      )
        throw inputError()
      return { fileData: { fileUri: block.uri, mimeType: block.mime_type } }
    })
    return countParts(model, parts, operationSignal(signal))
  }
  const infer = async (
    model: typeof GEMINI_IMAGE_MODEL | typeof GEMINI_TRANSCRIPTION_MODEL,
    parts: readonly CountPart[],
    overrides: GeminiMediaTokenLimits,
    signal: AbortSignal,
    audio?: { data: string; mimeType: string }
  ) => {
    tokenLimit(overrides.maxInputTokens)
    tokenLimit(overrides.maxOutputTokens)
    const maxInputTokens = Math.min(overrides.maxInputTokens ?? options.maxInputTokens ?? 10_000_000, options.maxInputTokens ?? 10_000_000)
    const maxOutputTokens = Math.min(
      overrides.maxOutputTokens ?? options.maxOutputTokens ?? GENERATED_MEDIA_TOKEN_LIMIT,
      options.maxOutputTokens ?? GENERATED_MEDIA_TOKEN_LIMIT
    )
    if (overrides.maxInputTokens !== undefined || options.maxInputTokens !== undefined || overrides.beforeDispatch) {
      const inputTokens = await countParts(model, parts, signal)
      if (inputTokens > maxInputTokens) throw new AgentRepositoryError('AGENT_MEDIA_CONTEXT_LIMIT', 'The media exceeds this provider’s input token limit', 413)
      await overrides.beforeDispatch?.({ inputTokens, outputTokens: maxOutputTokens, totalTokens: inputTokens + maxOutputTokens })
    }
    signal.throwIfAborted()
    let usage: GeminiMediaUsage | undefined
    const images: { bytes: Buffer; mimeType: string }[] = []
    let bridgeError: unknown
    // Ax owns GenerateContent serialization and text normalization. This bridge
    // adds only unsupported image settings, transcription caps, and media fields.
    const mediaFetch = Object.assign(
      async (destination: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        try {
          if (String(destination) !== `${ORIGIN}/v1beta/models/${model}:generateContent` || init?.method !== 'POST' || typeof init.body !== 'string')
            throw denied()
          const body = JSON.parse(init.body) as { generationConfig?: Record<string, unknown> }
          body.generationConfig = {
            ...body.generationConfig,
            maxOutputTokens,
            ...(audio ? {} : { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } })
          }
          if (!audio) delete body.generationConfig.responseMimeType
          const serialized = JSON.stringify(body)
          if (Buffer.byteLength(serialized) > 4 * Math.ceil(GEMINI_MEDIA_INPUT_LIMIT / 3) * 4 + MAX_TEXT * 4) throw inputError()
          signal.throwIfAborted()
          overrides.onDispatch?.()
          const raw = await json(await request(String(destination), { ...init, body: serialized }, signal), signal)
          const parsed = mediaEnvelopeSchema.safeParse(raw)
          if (!parsed.success) throw invalid()
          const measured = parsed.data.usageMetadata
          usage = {
            inputTokens: measured.promptTokenCount,
            outputTokens: measured.candidatesTokenCount + (measured.thoughtsTokenCount ?? 0),
            totalTokens: measured.totalTokenCount
          }
          for (const part of parsed.data.candidates[0]!.content.parts) {
            if ('text' in part && (typeof part.text !== 'string' || part.text.length > MAX_TEXT)) throw invalid()
            if ('audioTranscription' in part && (!audio || !z.object({ text: z.string().max(MAX_TEXT) }).safeParse(part.audioTranscription).success))
              throw invalid()
            if ('functionCall' in part || 'fileData' in part || 'executableCode' in part || 'codeExecutionResult' in part) throw invalid()
            if ('inlineData' in part) {
              if (audio || part.thought === true) throw invalid()
              const image = inlineImageSchema.safeParse(part.inlineData)
              if (!image.success) throw invalid()
              images.push(decodeImage(image.data.data, image.data.mimeType))
            } else if (!('text' in part) && !(audio && 'audioTranscription' in part)) throw invalid()
          }
          return Response.json(raw)
        } catch (error) {
          bridgeError = error
          throw error
        }
      },
      { preconnect: () => {} }
    ) as AgentProviderFetch
    const service = ai({
      name: 'google-gemini',
      apiKey: options.apiKey,
      config: { model: model as AxAIGoogleGeminiModel, stream: false, safetySettings: [] },
      options: { debug: false, verbose: false, excludeContentFromTrace: true, retry: { maxRetries: 0 }, fetch: mediaFetch }
    })
    try {
      let text: string
      if (audio) {
        const result = await service.transcribe(
          {
            model: GEMINI_TRANSCRIPTION_MODEL,
            audio,
            prompt: 'Generate a transcript of the speech in this audio.'
          },
          { fetch: mediaFetch, abortSignal: signal, timeout: options.timeoutMs }
        )
        text = result.text
      } else {
        const content: Extract<AxChatRequest['chatPrompt'][number], { role: 'user' }>['content'] = parts.map(part => {
          if ('text' in part) return { type: 'text' as const, text: part.text }
          if (!('inlineData' in part)) throw inputError()
          return { type: 'image' as const, image: part.inlineData.data, mimeType: part.inlineData.mimeType }
        })
        const result = await service.chat(
          { model: GEMINI_IMAGE_MODEL, chatPrompt: [{ role: 'user', content }] },
          { stream: false, fetch: mediaFetch, abortSignal: signal, timeout: options.timeoutMs }
        )
        if (result instanceof ReadableStream || result.results.length !== 1 || result.results[0]?.functionCalls?.length) throw invalid()
        text = result.results[0]?.content ?? ''
      }
      signal.throwIfAborted()
      if (!usage || text.length > MAX_TEXT || (audio ? !text.trim() : images.length === 0 || images.length > 4)) throw invalid()
      return { text, images, usage }
    } catch (error) {
      if (signal.aborted) throw new AgentRepositoryError('AGENT_MEDIA_CANCELLED', 'The media request was cancelled or timed out', 408)
      if (bridgeError) throw bridgeError
      if (error instanceof AgentRepositoryError || error instanceof AgentProviderAttemptError) throw error
      throw new AgentRepositoryError('AGENT_MEDIA_PROVIDER_FAILED', 'The media provider request failed', 502)
    }
  }
  const unsupported = async (kind: 'video' | 'music'): Promise<GeminiGeneratedMediaResult> => {
    // Exact configured Omni/Lyria models have no documented non-retired endpoint.
    // Never substitute Veo, realtime Lyria, or another differently priced model.
    throw new AgentRepositoryError('AGENT_MEDIA_UNSUPPORTED', `The configured Gemini ${kind} model has no supported non-Interactions API`, 409)
  }
  return {
    upload,
    countTokens,
    delete: remove,
    generateVideo: (_input: { prompt: string; images?: readonly GeminiMediaInput[] } & GeminiMediaTokenLimits, _signal?: AbortSignal) => unsupported('video'),
    generateMusic: (_input: { prompt: string; images?: readonly GeminiMediaInput[] } & GeminiMediaTokenLimits, _signal?: AbortSignal) => unsupported('music'),
    generateImage: async (input: { prompt: string; images?: readonly GeminiMediaInput[] } & GeminiMediaTokenLimits, signal?: AbortSignal) => {
      if (!input.prompt.trim() || input.prompt.length > MAX_TEXT || (input.images?.length || 0) > 4) throw inputError()
      for (const image of input.images || []) {
        validateInput(image)
        if (!IMAGE_TYPES.has(image.mimeType)) throw inputError()
      }
      const activeSignal = operationSignal(signal)
      const parts: CountPart[] = [{ text: input.prompt }]
      for (const image of input.images || []) {
        await input.beforeUpload?.()
        activeSignal.throwIfAborted()
        parts.push({
          inlineData: { data: Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString('base64'), mimeType: image.mimeType }
        })
      }
      return infer(GEMINI_IMAGE_MODEL, parts, input, activeSignal)
    },
    transcribe: async (input: GeminiMediaInput & GeminiMediaTokenLimits, signal?: AbortSignal): Promise<{ text: string; usage: GeminiMediaUsage }> => {
      validateInput(input)
      if (!AUDIO_TYPES.has(input.mimeType)) throw inputError()
      const activeSignal = operationSignal(signal)
      await input.beforeUpload?.()
      activeSignal.throwIfAborted()
      const audio = { data: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength).toString('base64'), mimeType: input.mimeType }
      const parts: CountPart[] = [{ inlineData: audio }, { text: 'Generate a transcript of the speech in this audio.' }]
      const result = await infer(GEMINI_TRANSCRIPTION_MODEL, parts, input, activeSignal, audio)
      return { text: result.text, usage: result.usage }
    }
  }
}
