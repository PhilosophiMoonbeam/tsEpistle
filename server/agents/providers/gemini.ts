import { randomUUID } from 'node:crypto'
import {
  ai,
  type AxAIGoogleGeminiChatRequest,
  type AxAIGoogleGeminiContentPart,
  type AxAIGoogleGeminiModel,
  type AxAIService,
  type AxAIServiceOptions,
  type AxChatRequest,
  type AxChatResponse
} from '@ax-llm/ax'
import { z } from 'zod'
import type { AgentReasoningEffort } from '../../../shared/agents/contracts.ts'
import { AgentRepositoryError } from '../repository.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import type { AgentProviderFetch, AgentProviderResourceLimits, AgentProviderService, ProviderThoughtBlock } from './factory.ts'
import { assertAgentTokenUsage } from './usage.ts'

const STATE_PREFIX = 'wiki.gemini.generate-content.v1:'
const MAX_STATE_BYTES = 256 * 1_024
const Signature = z.string().min(1).max(MAX_STATE_BYTES)
const NativePart = z
  .strictObject({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: Signature.optional(),
    thought_signature: Signature.optional(),
    functionCall: z
      .strictObject({ id: z.string().min(1).max(256).optional(), name: z.string().min(1).max(256), args: z.record(z.string(), z.unknown()) })
      .optional()
  })
  .refine(part => (part.text !== undefined) !== (part.functionCall !== undefined))
const MAX_PARTS = 16_384
const NativeParts = z.array(NativePart).min(1).max(MAX_PARTS)
type Part = z.infer<typeof NativePart>

export const isGeminiChatModel = (model: string): boolean =>
  /^gemini-(?:[23](?:\.[0-9]+)?)(?:-[a-z0-9][a-z0-9._-]*)?$/u.test(model) && !/(?:-(?:live|image|tts|transcribe)(?:-|$))/u.test(model)

const invalid = (): AgentRepositoryError => new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Gemini returned an invalid or incomplete response', 502)
const invalidUsage = (): AgentRepositoryError => new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Provider returned incomplete or invalid token usage', 502)

/** Adapt the validated exclusive native variants without dropping either signature spelling. */
const replayPart = (part: Part): AxAIGoogleGeminiContentPart & { thoughtSignature?: string } => {
  const metadata = {
    ...(part.thought === undefined ? {} : { thought: part.thought }),
    ...(part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature }),
    ...(part.thought_signature === undefined ? {} : { thought_signature: part.thought_signature })
  }
  if (part.text !== undefined) return { ...metadata, text: part.text }
  if (part.functionCall !== undefined) {
    const { id, name, args } = part.functionCall
    return { ...metadata, functionCall: { name, args, ...(id === undefined ? {} : { id }) } }
  }
  throw invalid()
}
const token = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const decodeParts = (block: ProviderThoughtBlock): Part[] => {
  if (block.encrypted !== true || typeof block.data !== 'string' || !block.data.startsWith(STATE_PREFIX) || Buffer.byteLength(block.data) > MAX_STATE_BYTES)
    throw invalid()
  try {
    return NativeParts.parse(JSON.parse(block.data.slice(STATE_PREFIX.length)))
  } catch {
    throw invalid()
  }
}
export const isGeminiContinuation = (block: ProviderThoughtBlock): boolean => {
  try {
    decodeParts(block)
    return true
  } catch {
    return false
  }
}
export const preserveGeminiContinuation = (block: ProviderThoughtBlock): ProviderThoughtBlock => {
  decodeParts(block)
  return { data: block.data, encrypted: true }
}

interface GeminiWireState {
  parts: Part[]
  partsBytes: number
  terminal: boolean
  usage: boolean
  usageReceipt?: readonly number[]
  usageFrames: ({ cached: number; reported: boolean } | undefined)[]
  emittedState: boolean
}

/** Ax 25's native parser is retained; this guard validates EOF/usage and retains exact signed parts it otherwise discards. */
const acceptPayload = (value: unknown, state: GeminiWireState, buffered: boolean, limits: AgentProviderResourceLimits): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  const payload = value as Record<string, unknown>
  if (payload.error !== undefined || payload.promptFeedback !== undefined) throw invalid()
  const candidates = payload.candidates
  if (!Array.isArray(candidates) || candidates.length > 1 || (buffered && candidates.length !== 1)) throw invalid()
  for (const raw of candidates) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || (raw.index !== undefined && raw.index !== 0)) throw invalid()
    if (state.terminal && raw.content?.parts?.length) throw invalid()
    const content = raw.content
    if (content !== undefined) {
      if (typeof content !== 'object' || content === null || Array.isArray(content) || content.role !== 'model' || !Array.isArray(content.parts))
        throw invalid()
      if (content.parts.length) {
        const parsed = NativeParts.safeParse(content.parts)
        if (!parsed.success || parsed.data.length > MAX_PARTS - state.parts.length) throw invalid()
        for (const part of parsed.data) {
          if (part.functionCall && part.functionCall.id === undefined) part.functionCall.id = randomUUID()
        }
        content.parts = parsed.data
        for (const part of parsed.data) {
          state.partsBytes += Buffer.byteLength(JSON.stringify(part)) + (state.parts.length ? 1 : 0)
          state.parts.push(part)
        }
        if (state.partsBytes > Math.min(MAX_STATE_BYTES - STATE_PREFIX.length, limits.continuationBytes)) throw invalid()
        // Ax overwrites content when a candidate has multiple text parts. Merge only
        // unsigned display parts for its parser; signed replay retains original parts.
        const visible = parsed.data.filter(part => part.text !== undefined && part.thought !== true)
        if (visible.length > 1) {
          const first = content.parts.findIndex((part: Part) => part.text !== undefined && part.thought !== true)
          content.parts = content.parts.filter((part: Part, index: number) => index === first || part.text === undefined || part.thought === true)
          content.parts[first] = { text: visible.map(part => part.text).join('') }
        }
      }
    }
    if (raw.finishReason !== undefined) {
      if (state.terminal || !['STOP', 'MAX_TOKENS'].includes(raw.finishReason)) throw invalid()
      state.terminal = true
    }
  }
  if (payload.usageMetadata !== undefined) {
    const usage = payload.usageMetadata
    if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) throw invalidUsage()
    const {
      promptTokenCount: input,
      candidatesTokenCount: output,
      totalTokenCount: total,
      cachedContentTokenCount: cached = 0,
      thoughtsTokenCount: thoughts = 0
    } = usage as Record<string, unknown>
    if (!token(input) || !token(output) || !token(total) || !token(cached) || !token(thoughts) || cached > input || thoughts > total) throw invalidUsage()
    assertAgentTokenUsage(input, output, total)
    const receipt = [input, output, total, cached, thoughts]
    if (state.usageReceipt?.some((prior, index) => receipt[index]! < prior)) throw invalidUsage()
    state.usageReceipt = receipt
    state.usage = true
    state.usageFrames.push({ cached, reported: Object.hasOwn(usage, 'cachedContentTokenCount') })
  } else {
    state.usageFrames.push(undefined)
  }
  if (buffered && (!state.terminal || !state.usage)) throw invalid()
  return payload
}

const checkedResponse = async (response: Response, state: GeminiWireState, limits: AgentProviderResourceLimits): Promise<Response> => {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType === 'application/json') {
    const payload = acceptPayload(await response.json(), state, true, limits)
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return Response.json(payload, { status: response.status, headers })
  }
  if (mediaType !== 'text/event-stream' || response.body === null) throw invalid()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  let pending = ''
  let fragments = 0
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending = (pending + decoder.decode(chunk, { stream: true })).replace(/\r\n/gu, '\n')
        let end: number
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, end)
          pending = pending.slice(end + 2)
          if (++fragments > limits.maxResponseFragments || Buffer.byteLength(frame) > limits.rawChunkBytes) throw invalid()
          const lines = frame.split('\n')
          const data = lines
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n')
          if (!data) {
            if (lines.some(line => line.length && !line.startsWith(':'))) throw invalid()
            continue
          }
          if (data === '[DONE]') throw invalid()
          let value: unknown
          try {
            value = JSON.parse(data)
          } catch {
            throw invalid()
          }
          const payload = acceptPayload(value, state, false, limits)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        }
        if (Buffer.byteLength(pending) > limits.rawChunkBytes) throw invalid()
      },
      flush() {
        pending += decoder.decode()
        if (pending.trim() || !state.terminal || !state.usage) throw invalid()
      }
    })
  )
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(body, { status: response.status, headers })
}

export interface GeminiAxServiceOptions {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly fetch: AgentProviderFetch
  readonly timeoutMs: number
  readonly maxOutputTokens: number
  readonly limits: AgentProviderResourceLimits
  readonly temperature?: number
  readonly thinkingLevel?: Extract<AgentReasoningEffort, 'minimal' | 'low' | 'medium' | 'high'>
}

export const createGeminiAxService = (
  config: GeminiAxServiceOptions
): AxAIService & Pick<AgentProviderService, 'nativeMediaCapabilities'> => {
  const featureService = ai({
    name: 'google-gemini',
    apiKey: config.apiKey,
    config: { model: config.model as AxAIGoogleGeminiModel },
    options: { debug: false, verbose: false, fetch: config.fetch, timeout: config.timeoutMs, retry: { maxRetries: 0 }, includeRequestBodyInErrors: false, excludeContentFromTrace: true }
  })
  let lastService: AxAIService = featureService
  const safeOptions = (options: Readonly<AxAIServiceOptions>): AxAIServiceOptions => {
    const timeout = options.timeout ?? config.timeoutMs
    if (!Number.isSafeInteger(timeout) || timeout < 1)
      throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Provider timeout is invalid', 400)
    const locked: AxAIServiceOptions = {
      ...options,
      debug: false,
      verbose: false,
      fetch: config.fetch,
      timeout: Math.min(timeout, config.timeoutMs),
      retry: { maxRetries: 0 },
      includeRequestBodyInErrors: false,
      excludeContentFromTrace: true
    }
    delete locked.corsProxy
    delete locked.webSocket
    return locked
  }
  const unsupported = async (): Promise<never> => {
    throw new AgentRepositoryError('UNSUPPORTED_PROVIDER_OPERATION', 'This provider service permits admitted chat requests only', 400)
  }
  let nativeMediaCapabilities = featureService.getFeatures(config.model).media
  return {
    getId: () => featureService.getId(),
    getName: () => featureService.getName(),
    getFeatures: () => featureService.getFeatures(config.model),
    getModelList: () => featureService.getModelList(),
    getMetrics: () => lastService.getMetrics(),
    getLogger: () => featureService.getLogger(),
    getLastUsedChatModel: () => lastService.getLastUsedChatModel(),
    getLastUsedEmbedModel: () => lastService.getLastUsedEmbedModel(),
    getLastUsedModelConfig: () => lastService.getLastUsedModelConfig(),
    getEstimatedCost: usage => featureService.getEstimatedCost(usage),
    getOptions: () => featureService.getOptions(),
    setOptions: options => featureService.setOptions(safeOptions(options)),
    validateChatRequest: (request, options) => featureService.validateChatRequest?.({ ...request, model: config.model }, options),
    embed: unsupported,
    transcribe: unsupported,
    speak: unsupported,
    openChatSession: unsupported,
    get nativeMediaCapabilities() {
      return nativeMediaCapabilities
    },
    async chat(request: Readonly<AxChatRequest<unknown>>, options?: Readonly<AxAIServiceOptions>) {
      const defaults = featureService.getOptions()
      options = safeOptions({ ...defaults, ...options })
      const cancellation = new AbortController()
      const signal = AbortSignal.any([
        cancellation.signal,
        ...(defaults.abortSignal ? [defaults.abortSignal] : []),
        ...(options.abortSignal ? [options.abortSignal] : [])
      ])
      signal.throwIfAborted()
      const state: GeminiWireState = { parts: [], partsBytes: 2, terminal: false, usage: false, usageFrames: [], emittedState: false }
      const nativeAssistantParts = request.chatPrompt
        .filter(message => message.role === 'assistant')
        .map(message => {
          if (message.role !== 'assistant' || !message.thoughtBlocks?.length) return undefined
          if (message.thoughtBlocks.length !== 1) throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored Gemini continuation is invalid', 500)
          const parts = decodeParts(message.thoughtBlocks[0]!)
          const nativeCalls = parts.flatMap(part => (part.functionCall ? [part.functionCall] : []))
          const calls = message.functionCalls ?? []
          const display = parts
            .filter(part => part.thought !== true)
            .map(part => part.text ?? '')
            .join('')
          const matches =
            display === (message.content ?? '') &&
            nativeCalls.length === calls.length &&
            nativeCalls.every((call, index) => {
              const canonical = calls[index]!
              const params = typeof canonical.function.params === 'string' ? JSON.parse(canonical.function.params) : canonical.function.params
              return call.id === canonical.id && call.name === canonical.function.name && canonicalJson(call.args) === canonicalJson(params ?? {})
            })
          return matches ? parts : undefined
        })
      const transportFetch = Object.assign(
        async (input: Parameters<AgentProviderFetch>[0], init?: RequestInit): Promise<Response> => {
          // Gemini's released factory has no apiURL option. Rewrite only its exact
          // built-in endpoint into the configured base before the guarded fetch.
          const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
          const official = 'https://generativelanguage.googleapis.com/v1beta'
          const relative = url.href.slice(official.length)
          if (
            !url.href.startsWith(`${official}/models/${config.model}:`) ||
            !['/models/' + config.model + ':generateContent', '/models/' + config.model + ':streamGenerateContent?alt=sse'].includes(relative)
          )
            throw new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Gemini request destination is not allowlisted', 502)
          if (typeof init?.body !== 'string') throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Gemini request body is invalid', 500)
          const body = JSON.parse(init.body) as AxAIGoogleGeminiChatRequest
          const level = config.thinkingLevel
          // Match Ax's released model-family clamping while bypassing its
          // maxTokens/thinkingLevel incompatibility, not the application's ceiling.
          const thinkingConfig: NonNullable<AxAIGoogleGeminiChatRequest['generationConfig']['thinkingConfig']> = {}
          if (level !== undefined) {
            if (config.model.startsWith('gemini-3')) {
              thinkingConfig.thinkingLevel = config.model.includes('gemini-3-pro')
                ? level === 'minimal' || level === 'low'
                  ? 'low'
                  : 'high'
                : level === 'minimal' && /gemini-3\.(?:1-pro|7-flash|8-flash)/u.test(config.model)
                  ? 'low'
                  : level
            } else {
              thinkingConfig.thinkingBudget = ({ minimal: 200, low: 800, medium: 5_000, high: 10_000 } as const)[level]
            }
          }
          // Replace Ax's generated thinking defaults rather than passing present
          // undefined config keys to disable them.
          const { thinkingConfig: _defaultThinking, ...generationConfig } = body.generationConfig
          body.generationConfig = {
            ...generationConfig,
            maxOutputTokens: config.maxOutputTokens,
            ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
            ...(level === undefined ? {} : { thinkingConfig })
          }
          let assistantIndex = 0
          for (const content of body.contents ?? []) {
            if (content.role !== 'model') continue
            const native = nativeAssistantParts[assistantIndex++]
            if (native !== undefined) content.parts = native.map(replayPart)
          }
          // Ax's JSON-schema cleaner narrows union action arguments. The native
          // JSON-schema field supports them; preserve the application's original schema.
          for (const tool of body.tools ?? []) {
            if (Object.keys(tool).some(key => key !== 'function_declarations'))
              throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Native Gemini search tools are disabled', 500)
            for (const declaration of tool.function_declarations ?? []) {
              const original = request.functions?.find(fn => fn.name === declaration.name)
              if (original?.parameters) declaration.parametersJsonSchema = original.parameters
            }
          }
          if (request.responseFormat?.type === 'json_schema' && request.responseFormat.schema) {
            const schema = request.responseFormat.schema
            body.generationConfig.responseJsonSchema = schema.schema ?? schema
          }
          if (!request.functions?.length) {
            delete body.tools
            delete body.toolConfig
          }
          const response = await config.fetch(config.baseUrl.replace(/\/$/u, '') + relative, { ...init, body: JSON.stringify(body) })
          return checkedResponse(response, state, config.limits)
        },
        { preconnect: config.fetch.preconnect }
      ) as AgentProviderFetch
      const service = ai({
        name: 'google-gemini',
        apiKey: config.apiKey,
        config: { model: config.model as AxAIGoogleGeminiModel },
        options: {
          debug: false,
          verbose: false,
          fetch: transportFetch,
          timeout: config.timeoutMs,
          retry: { maxRetries: 0 },
          includeRequestBodyInErrors: false,
          excludeContentFromTrace: true
        }
      })
      // Capture the actual bound model's facts without another service or transport request.
      nativeMediaCapabilities = service.getFeatures(config.model).media
      const modelConfig = { ...request.modelConfig }
      delete modelConfig.maxTokens
      const chatPrompt = request.chatPrompt.map(message => {
        if (message.role !== 'assistant') return message
        const { thoughtBlocks: _thoughtBlocks, ...canonical } = message
        return canonical
      })
      // The application binds this service to its profile model; Ax's generic
      // public request permits unknown model keys, which must not override it.
      const { model: _model, ...profileRequest } = request
      const { thinkingTokenBudget: _thinkingTokenBudget, contextCache: _contextCache, ...chatOptions } = options ?? {}
      const response = await service.chat(
        { ...profileRequest, chatPrompt, modelConfig },
        { ...chatOptions, abortSignal: signal, showThoughts: false, fetch: transportFetch }
      )
      lastService = service
      const normalize = (chunk: AxChatResponse): AxChatResponse => {
        for (const result of chunk.results) delete result.thoughtBlocks
        const frameUsage = state.usageFrames.shift()
        if (chunk.modelUsage?.tokens && frameUsage?.reported && frameUsage.cached === 0) chunk.modelUsage.tokens.cacheReadTokens = 0
        // Retain one full native assistant part sequence only at the terminal
        // boundary. Streamed deltas are never concatenated as signature state.
        if (state.terminal && state.usage && !state.emittedState && chunk.results.length) {
          state.emittedState = true
          if (state.parts.some(part => part.thoughtSignature || part.thought_signature)) {
            const block = { data: STATE_PREFIX + JSON.stringify(state.parts), encrypted: true }
            decodeParts(block)
            chunk.results[0]!.thoughtBlocks = [block]
          }
        }
        return chunk
      }
      if (!(response instanceof ReadableStream)) return normalize(response)
      // Bind normalization and consumer cancellation to the same request signal
      // used by the pinned transport, including failures in our native guards.
      const reader = response.getReader()
      let closed = false
      let onAbort: (() => void) | undefined
      const finish = (): void => {
        closed = true
        if (onAbort) signal.removeEventListener('abort', onAbort)
        try {
          reader.releaseLock()
        } catch {
          /* an active read releases when it settles */
        }
      }
      return new ReadableStream<AxChatResponse>({
        start(controller) {
          onAbort = () => {
            if (closed) return
            const reason = signal.reason ?? new DOMException('The request was aborted', 'AbortError')
            void reader.cancel(reason).catch(() => {})
            finish()
            controller.error(reason)
          }
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        },
        async pull(controller) {
          if (closed) return
          try {
            const item = await reader.read()
            if (closed) return
            if (item.done) {
              finish()
              controller.close()
            } else controller.enqueue(normalize(item.value))
          } catch (error) {
            if (closed) return
            finish()
            cancellation.abort(error)
            controller.error(error)
          }
        },
        cancel(reason) {
          if (closed) return
          void reader.cancel(reason).catch(() => {})
          finish()
          cancellation.abort(reason ?? new DOMException('The stream was cancelled', 'AbortError'))
        }
      })
    }
  }
}
