import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import {
  ai,
  type AxAIAnthropicModel,
  type AxAIFeatures,
  type AxAIOpenAIResponsesModel,
  type AxAIOpenAIResponsesRequest,
  type AxAIService,
  type AxAIServiceOptions,
  type AxChatRequest,
  type AxChatResponse,
  type AxChatResponseResult
} from '@ax-llm/ax'
import type { Knex } from 'knex'
// The explicit entry point avoids Bun's built-in shim, which ignores dispatchers.
import { Agent, type RequestInit as UndiciRequestInit, fetch as undiciFetch } from 'undici/index.js'
import { type AgentReasoningEffort, agentProviderReasoningEfforts } from '../../../shared/agents/contracts.ts'
import { type AgentMediaInputs, type AgentMediaKind, type AgentMediaProviderConfig } from '../../../shared/agents/media-providers.ts'
import { assertAgentMediaBinding } from '../media-providers.ts'
import { AgentRepositoryError } from '../repository.ts'
import { createGeminiAxService, isGeminiChatModel, isGeminiContinuation, preserveGeminiContinuation } from './gemini.ts'
import {
  createGeminiMediaTransport,
  type GeminiMediaInputTransport,
  GEMINI_MEDIA_INPUT_LIMIT,
  GEMINI_MEDIA_OUTPUT_LIMIT,
  GEMINI_PDF_INPUT_LIMIT,
  GEMINI_VIDEO_RESPONSE_LIMIT,
  GEMINI_MUSIC_RESPONSE_LIMIT
} from './gemini-media.ts'
import { createGoogleInteractionsMediaTransport } from './google-interactions-media.ts'
import { createIndependentImageMediaTransport } from './independent-image-media.ts'
import type { AgentMediaTransport } from './media-transport.ts'
import { createOpenResponsesFetch } from './openresponses.ts'
import {
  AgentProviderAdapterConfigSchema,
  agentProviderMediaInputs,
  type AgentProviderCapabilities,
  AgentProviderCapabilitiesSchema,
  AgentProviderPricingRevisionSchema,
  type AgentProviderTransportKind
} from './registry.ts'
import type { AgentSecretRegistry } from './secrets.ts'
import { assertAgentTokenUsage } from './usage.ts'

const MAX_RETRY_AFTER_MS = 300_000
const MAX_PROVIDER_ERROR_BYTES = 64 * 1_024
const OPENAI_REASONING_STATE_PREFIX = 'wiki.openai.reasoning.v1:'
const MAX_PROVIDER_STATE_ITEM_BYTES = 256 * 1_024
const MAX_PROVIDER_CONTINUATION_BYTES = 256 * 1_024
const MAX_PROVIDER_CONTINUATION_BLOCKS = 128
const MAX_PROVIDER_IDENTIFIER_BYTES = 256
const MAX_PROVIDER_RESPONSE_FRAGMENTS = 65_536
const MAX_PROVIDER_RESULT_RECORDS = 65_536
const MAX_STRUCTURED_DEPTH = 64
const MAX_STRUCTURED_VALUES = 16_384
const MAX_STRUCTURED_BYTES = 65_536

export const AGENT_PROVIDER_CONTINUATION_DIALECTS = [
  'openai-responses-reasoning-v1',
  'openresponses-reasoning-v1',
  'gemini-generate-content-v1',
  'openai-chat-ax-encrypted-v1',
  'anthropic-messages-ax-encrypted-v1'
] as const
export type AgentProviderContinuationDialect = (typeof AGENT_PROVIDER_CONTINUATION_DIALECTS)[number]

export interface AgentProviderResourceLimits {
  readonly maxOutputTokens: number
  readonly retainedBytes: number
  readonly contentBytes: number
  readonly argumentBytes: number
  readonly continuationBytes: number
  readonly fragmentBytes: number
  readonly rawBodyBytes: number
  readonly rawChunkBytes: number
  readonly incomingBytes: number
  readonly maxCalls: number
  readonly maxContinuationBlocks: number
  readonly maxResponseFragments: number
  readonly maxResultRecords: number
  readonly maxArgumentFragments: number
  readonly maxThoughtFragments: number
  readonly maxStructuredDepth: number
  readonly maxStructuredValues: number
  readonly maxStructuredBytes: number
}

export const deriveAgentProviderResourceLimits = (maxOutputTokens: number): AgentProviderResourceLimits => {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Provider output token limit is invalid', 500)
  }
  const retainedBytes = Math.min(4 * 1_024 * 1_024, Math.max(64 * 1_024, 32 * maxOutputTokens))
  const fragmentBytes = Math.min(65_536, Math.max(1_024, 8 * maxOutputTokens))
  const rawBodyBytes = Math.min(32 * 1_024 * 1_024, 8 * retainedBytes + 512 * fragmentBytes)
  const rawChunkBytes = Math.min(512 * 1_024, Math.max(4_096, 16 * maxOutputTokens))
  return Object.freeze({
    maxOutputTokens,
    retainedBytes,
    contentBytes: Math.min(retainedBytes, 384_000),
    argumentBytes: Math.min(retainedBytes, 65_536),
    continuationBytes: Math.min(retainedBytes, 262_144),
    fragmentBytes,
    rawBodyBytes,
    rawChunkBytes,
    incomingBytes: 8 * retainedBytes,
    maxCalls: 32,
    maxContinuationBlocks: MAX_PROVIDER_CONTINUATION_BLOCKS,
    maxResponseFragments: MAX_PROVIDER_RESPONSE_FRAGMENTS,
    maxResultRecords: MAX_PROVIDER_RESULT_RECORDS,
    maxArgumentFragments: MAX_PROVIDER_RESPONSE_FRAGMENTS,
    maxThoughtFragments: MAX_PROVIDER_RESPONSE_FRAGMENTS,
    maxStructuredDepth: MAX_STRUCTURED_DEPTH,
    maxStructuredValues: MAX_STRUCTURED_VALUES,
    maxStructuredBytes: MAX_STRUCTURED_BYTES
  })
}

export interface AgentProviderContinuationEnvelope {
  readonly schemaVersion: 1
  readonly continuationDialect: AgentProviderContinuationDialect
  readonly thoughtBlocks: readonly ProviderThoughtBlock[]
}

const PROVIDER_RESOURCE_LIMITS = Symbol('agent provider resource limits')
type ProviderRequestWithLimits = object & {
  readonly [PROVIDER_RESOURCE_LIMITS]?: AgentProviderResourceLimits
}
export const attachAgentProviderResourceLimits = <T extends object>(request: T, limits: AgentProviderResourceLimits): T => {
  Object.defineProperty(request, PROVIDER_RESOURCE_LIMITS, {
    configurable: false,
    enumerable: false,
    value: limits,
    writable: false
  })
  return request
}
export const readAgentProviderResourceLimits = (request: object): AgentProviderResourceLimits | undefined =>
  (request as ProviderRequestWithLimits)[PROVIDER_RESOURCE_LIMITS]

const providerContinuationDialect = (transportKind: AgentProviderTransportKind): AgentProviderContinuationDialect | null =>
  transportKind === 'openai-responses'
    ? 'openai-responses-reasoning-v1'
    : transportKind === 'openresponses'
      ? 'openresponses-reasoning-v1'
      : transportKind === 'gemini-api'
        ? 'gemini-generate-content-v1'
        : transportKind === 'openai-chat'
          ? 'openai-chat-ax-encrypted-v1'
          : transportKind === 'anthropic-messages'
            ? 'anthropic-messages-ax-encrypted-v1'
            : null

export { providerContinuationDialect as agentProviderContinuationDialect }
export type AgentProviderFetch = typeof fetch

export type ProviderThoughtBlock = NonNullable<AxChatResponseResult['thoughtBlocks']>[number]
const disabledProviderPreconnect: typeof fetch.preconnect = () => {
  throw new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Provider preconnect is disabled because it cannot enforce DNS pinning', 502)
}

const openAIReasoningState = (resultId: string, block: ProviderThoughtBlock): ProviderThoughtBlock => {
  if (
    !/^rs_[A-Za-z0-9_-]{1,256}$/u.test(resultId) ||
    Buffer.byteLength(resultId, 'utf8') > MAX_PROVIDER_IDENTIFIER_BYTES ||
    block.encrypted !== true ||
    typeof block.data !== 'string' ||
    Buffer.byteLength(block.data, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES
  ) {
    throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider returned invalid reasoning continuation state', 502)
  }
  const data = `${OPENAI_REASONING_STATE_PREFIX}${JSON.stringify([resultId, block.data])}`
  return { data, encrypted: true }
}

const restoredOpenAIReasoningItem = (encoded: string): Record<string, unknown> => {
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES + MAX_PROVIDER_IDENTIFIER_BYTES + 64) throw new Error('too large')
  const value: unknown = JSON.parse(encoded)
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    !/^rs_[A-Za-z0-9_-]{1,256}$/u.test(value[0]) ||
    Buffer.byteLength(value[0], 'utf8') > MAX_PROVIDER_IDENTIFIER_BYTES ||
    typeof value[1] !== 'string' ||
    Buffer.byteLength(value[1], 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES
  )
    throw new Error('invalid')
  return {
    type: 'reasoning',
    id: value[0],
    content: [],
    summary: [],
    encrypted_content: value[1]
  }
}

const restoreOpenAIReasoningItem = (item: unknown): unknown => {
  if (typeof item !== 'object' || item === null || Reflect.get(item, 'type') !== 'reasoning') return item
  const content = Reflect.get(item, 'content')
  const encryptedContent = Reflect.get(item, 'encrypted_content')
  const prefixedState =
    typeof content === 'string' && content.startsWith(OPENAI_REASONING_STATE_PREFIX)
      ? content
      : typeof encryptedContent === 'string' && encryptedContent.startsWith(OPENAI_REASONING_STATE_PREFIX)
        ? encryptedContent
        : null
  if (prefixedState === null) return item
  try {
    const encoded = prefixedState.slice(OPENAI_REASONING_STATE_PREFIX.length)
    try {
      return restoredOpenAIReasoningItem(encoded)
    } catch {
      const segments = prefixedState
        .slice(OPENAI_REASONING_STATE_PREFIX.length)
        .split(OPENAI_REASONING_STATE_PREFIX)
        .map(segment => restoredOpenAIReasoningItem(segment))
      if (segments.length === 0) throw new Error('invalid')
      return segments
    }
  } catch {
    throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation is invalid', 500)
  }
}

const restoreOpenAIReasoningInput = (input: AxAIOpenAIResponsesRequest<string>['input']): AxAIOpenAIResponsesRequest<string>['input'] =>
  Array.isArray(input)
    ? (input.flatMap(item => {
        const restored = restoreOpenAIReasoningItem(item)
        return Array.isArray(restored) ? restored : [restored]
      }) as AxAIOpenAIResponsesRequest<string>['input'])
    : input

const continuationBlockBytes = (block: ProviderThoughtBlock): number => {
  if (typeof block.data !== 'string' || block.encrypted !== true || Buffer.byteLength(block.data, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES)
    throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider returned invalid continuation state', 502)
  if (block.signature !== undefined && (typeof block.signature !== 'string' || Buffer.byteLength(block.signature, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES))
    throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider returned invalid continuation signature', 502)
  return Buffer.byteLength(block.data, 'utf8') + (block.signature === undefined ? 0 : Buffer.byteLength(block.signature, 'utf8')) + 32
}

const isOpenAIReasoningBlock = (block: ProviderThoughtBlock): boolean => {
  if (block.encrypted !== true || typeof block.data !== 'string' || Buffer.byteLength(block.data, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES) return false
  if (!block.data.startsWith(OPENAI_REASONING_STATE_PREFIX)) return false
  try {
    const value: unknown = JSON.parse(block.data.slice(OPENAI_REASONING_STATE_PREFIX.length))
    return (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      /^rs_[A-Za-z0-9_-]{1,256}$/u.test(value[0]) &&
      Buffer.byteLength(value[0], 'utf8') <= MAX_PROVIDER_IDENTIFIER_BYTES &&
      typeof value[1] === 'string' &&
      Buffer.byteLength(value[1], 'utf8') <= MAX_PROVIDER_STATE_ITEM_BYTES
    )
  } catch {
    return false
  }
}

const validateContinuationBlocks = (
  dialect: AgentProviderContinuationDialect,
  value: unknown,
  source: 'provider' | 'stored'
): readonly ProviderThoughtBlock[] => {
  const fail = (): never => {
    throw new AgentRepositoryError(
      source === 'provider' ? 'INVALID_PROVIDER_RESPONSE' : 'AGENT_PROVIDER_STATE_CORRUPT',
      source === 'provider' ? 'Provider returned invalid continuation state' : 'Stored provider continuation is invalid',
      source === 'provider' ? 502 : 500
    )
  }
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_CONTINUATION_BLOCKS) fail()
  const candidates: readonly unknown[] = value as readonly unknown[]
  let aggregate = 0
  const blocks: ProviderThoughtBlock[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) fail()
    const block = candidate as ProviderThoughtBlock
    let bytes = 0
    try {
      bytes = continuationBlockBytes(block)
    } catch {
      return fail()
    }
    if (
      dialect === 'openai-responses-reasoning-v1' || dialect === 'openresponses-reasoning-v1'
        ? !isOpenAIReasoningBlock(block)
        : dialect === 'gemini-generate-content-v1'
          ? !isGeminiContinuation(block)
          : block.encrypted !== true
    )
      fail()
    aggregate += bytes
    if (!Number.isSafeInteger(aggregate) || aggregate > MAX_PROVIDER_CONTINUATION_BYTES) fail()
    blocks.push(
      Object.freeze({
        data: block.data,
        encrypted: true,
        ...(block.signature === undefined ? {} : { signature: block.signature })
      })
    )
  }
  return Object.freeze(blocks)
}

export const encodeAgentProviderContinuation = (
  dialect: AgentProviderContinuationDialect | null | undefined,
  thoughtBlocks: readonly ProviderThoughtBlock[]
): AgentProviderContinuationEnvelope | undefined => {
  if (dialect === null || dialect === undefined) return undefined
  const blocks = validateContinuationBlocks(dialect, thoughtBlocks, 'provider')
  const envelope: AgentProviderContinuationEnvelope = Object.freeze({
    schemaVersion: 1,
    continuationDialect: dialect,
    thoughtBlocks: blocks
  })
  let encoded: string
  try {
    encoded = JSON.stringify(envelope)
  } catch {
    throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider returned invalid continuation state', 502)
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROVIDER_CONTINUATION_BYTES)
    throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider continuation state exceeds the byte limit', 502)
  return envelope
}

export const decodeAgentProviderContinuation = (
  value: unknown,
  expectedDialect: AgentProviderContinuationDialect | null | undefined
): { readonly thoughtBlocks: readonly ProviderThoughtBlock[] } | undefined => {
  if (expectedDialect === null || expectedDialect === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  let schemaVersion: unknown
  let dialect: unknown
  let thoughtBlocks: unknown
  try {
    schemaVersion = Reflect.get(value, 'schemaVersion')
    dialect = Reflect.get(value, 'continuationDialect')
    thoughtBlocks = Reflect.get(value, 'thoughtBlocks')
  } catch {
    return undefined
  }
  if (schemaVersion !== undefined || dialect !== undefined) {
    if (dialect !== expectedDialect) return undefined
    if (schemaVersion !== 1) throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation is invalid', 500)
    return {
      thoughtBlocks: validateContinuationBlocks(expectedDialect, thoughtBlocks, 'stored')
    }
  }
  if (!Array.isArray(thoughtBlocks)) return undefined
  if (expectedDialect !== 'openai-responses-reasoning-v1' && expectedDialect !== 'openresponses-reasoning-v1') return undefined
  return {
    thoughtBlocks: validateContinuationBlocks(expectedDialect, thoughtBlocks, 'stored')
  }
}

export class AgentProviderAttemptError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterMilliseconds: number | null
  readonly retryable: boolean
  readonly parameter: string | null
  constructor(code: string, status: number, retryAfterMilliseconds: number | null, parameter: string | null = null) {
    super('Provider request failed')
    this.name = 'AgentProviderAttemptError'
    this.code = code
    this.status = status
    this.retryAfterMilliseconds = retryAfterMilliseconds
    this.retryable = status === 408 || status === 409 || status === 429 || status >= 500
    this.parameter = parameter
  }
}

interface ProviderVersionRow {
  id: string
  transportKind: AgentProviderTransportKind
  model: string
  utilityModel: string | null
  baseUrl: string
  authMode: string
  secretReference: string | null
  adapterConfig: string
  capabilities: string
  capabilityRevision: string
  pricingRevision: string
  conformed: boolean
}

export interface AgentProviderPricing {
  readonly revision: string
  readonly inputMicrosPerMillionTokens: number
  readonly outputMicrosPerMillionTokens: number
  readonly cacheWritePremium?: boolean
}

export const parseAgentProviderPricing = (value: string): AgentProviderPricing => {
  if (!AgentProviderPricingRevisionSchema.safeParse(value).success) {
    throw new AgentRepositoryError('PROVIDER_PRICING_INVALID', 'Provider pricing revision must include immutable positive input and output token rates', 500)
  }
  const [revision, inputRate, outputRate] = value.split('|')
  return {
    revision: revision!,
    inputMicrosPerMillionTokens: Number(inputRate),
    outputMicrosPerMillionTokens: Number(outputRate)
  }
}

export const agentProviderCostMicros = (pricing: AgentProviderPricing, inputTokens: number, outputTokens: number, totalTokens: number): number => {
  assertAgentTokenUsage(inputTokens, outputTokens, totalTokens)
  if (
    !Number.isSafeInteger(pricing.inputMicrosPerMillionTokens) ||
    pricing.inputMicrosPerMillionTokens < 0 ||
    !Number.isSafeInteger(pricing.outputMicrosPerMillionTokens) ||
    pricing.outputMicrosPerMillionTokens < 0 ||
    (pricing.cacheWritePremium !== undefined && typeof pricing.cacheWritePremium !== 'boolean')
  )
    throw new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Provider pricing is invalid', 502)

  const inputRate = BigInt(pricing.inputMicrosPerMillionTokens)
  const outputRate = BigInt(pricing.outputMicrosPerMillionTokens)
  const input = BigInt(inputTokens)
  const output = BigInt(outputTokens)
  const residual = BigInt(totalTokens - inputTokens - outputTokens)
  let numerator: bigint
  let denominator: bigint
  if (pricing.cacheWritePremium === true) {
    numerator = 5n * input * inputRate + 4n * output * outputRate + residual * (5n * inputRate > 4n * outputRate ? 5n * inputRate : 4n * outputRate)
    denominator = 4_000_000n
  } else {
    const maximumRate = inputRate > outputRate ? inputRate : outputRate
    numerator = input * inputRate + output * outputRate + residual * maximumRate
    denominator = 1_000_000n
  }
  const cost = (numerator + denominator - 1n) / denominator
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Provider usage cost exceeds the supported range', 502)
  return Number(cost)
}

export interface AgentProviderService {
  readonly service: AxAIService
  readonly capabilities: AgentProviderCapabilities
  readonly mediaInputs: AgentMediaInputs
  /** Actual configured Ax model facts, resolved eagerly before attachment admission. */
  readonly nativeMediaCapabilities?: AxAIFeatures['media'] | undefined
  readonly transportKind: AgentProviderTransportKind
  readonly continuationDialect?: AgentProviderContinuationDialect | null
  readonly model: string
  /** Applied default after explicit purpose-specific profile configuration wins. */
  readonly reasoningEffort?: AgentReasoningEffort
  readonly capabilityRevision: string
  readonly pricingRevision: string
  readonly pricing: AgentProviderPricing
  readonly preserveCachePrefix: boolean
  readonly preserveThoughtBlock: (resultId: string, block: ProviderThoughtBlock) => ProviderThoughtBlock | null
}

const blockedProviderAddresses = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const)
  blockedProviderAddresses.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const)
  blockedProviderAddresses.addSubnet(network, prefix, 'ipv6')

const assertPublicProviderAddresses = (addresses: readonly { readonly address: string; readonly family: number }[]): void => {
  if (addresses.length === 0) throw new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Provider hostname did not resolve to a public address', 502)
  for (const entry of addresses) {
    const family = isIP(entry.address)
    if ((family !== 4 && family !== 6) || blockedProviderAddresses.check(entry.address, family === 4 ? 'ipv4' : 'ipv6')) {
      throw new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Provider hostname resolved to a prohibited address', 502)
    }
  }
}

const retryAfter = (value: string | null, now = Date.now()): number | null => {
  if (!value) return null
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(value) - now
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(milliseconds))
}
const readBoundedResponseBytes = async (response: Response, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> => {
  const body = response.body
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  try {
    while (true) {
      signal?.throwIfAborted()
      const item = await reader.read()
      signal?.throwIfAborted()
      if (item.done) break
      const value = item.value
      if (
        !(value instanceof Uint8Array) ||
        chunks.length >= MAX_PROVIDER_RESPONSE_FRAGMENTS ||
        value.byteLength > maximumBytes ||
        total > maximumBytes - value.byteLength
      ) {
        void reader.cancel('provider body limit').catch(() => {})
        return null
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch {
    return null
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // The body reader is already unusable.
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const boundedProviderResponseBody = (
  body: ReadableStream<Uint8Array>,
  limits: AgentProviderResourceLimits,
  onLimit?: (error: AgentRepositoryError) => void,
  signal?: AbortSignal
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  let total = 0
  let finished = false
  let cancellationRequested = false
  let readerReleased = false
  let onAbort: (() => void) | undefined
  const releaseReader = (): void => {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    if (readerReleased) return
    readerReleased = true
    try {
      reader.releaseLock()
    } catch {
      // The body reader is already unusable.
    }
  }
  const cancel = (reason: unknown): void => {
    finished = true
    if (!cancellationRequested) {
      cancellationRequested = true
      void reader.cancel(reason).catch(() => {})
    }
    releaseReader()
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Under Bun, Undici closes the socket on abort but a pending body read may
      // remain unresolved. Terminate our stream and its reader explicitly.
      onAbort = () => {
        if (finished) return
        const reason: unknown = signal?.reason ?? new DOMException('The request was aborted', 'AbortError')
        cancel(reason)
        controller.error(reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    },
    async pull(controller) {
      if (finished) return
      const item = await reader.read().catch(error => {
        if (finished) return null
        finished = true
        releaseReader()
        controller.error(error)
        return null
      })
      if (finished || item === null) return
      if (item.done) {
        finished = true
        releaseReader()
        controller.close()
        return
      }
      const value = item.value
      if (!(value instanceof Uint8Array) || value.byteLength > limits.rawChunkBytes || total > limits.rawBodyBytes - value.byteLength) {
        const error = new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider response exceeded its byte limit', 502)
        finished = true
        onLimit?.(error)
        cancel(error)
        controller.error(error)
        return
      }
      total += value.byteLength
      controller.enqueue(value)
    },
    cancel
  })
}

const guardedSuccessfulResponse = (
  response: Response,
  limits: AgentProviderResourceLimits,
  onLimit?: (error: AgentRepositoryError) => void,
  signal?: AbortSignal
): Response => {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > limits.rawBodyBytes) {
    const error = new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider response exceeded its byte limit', 502)
    const body = response.body
    if (body !== null) void body.cancel(error).catch(() => {})
    onLimit?.(error)
    throw error
  }
  if (response.body === null) return response
  return new Response(boundedProviderResponseBody(response.body, limits, onLimit, signal), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

const providerFailure = async (response: Response, signal?: AbortSignal): Promise<{ code: string; parameter: string | null }> => {
  const fallback = { code: `HTTP_${response.status}`, parameter: null }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_PROVIDER_ERROR_BYTES) {
    await response.body?.cancel().catch(() => {})
    return fallback
  }
  try {
    const bytes = await readBoundedResponseBytes(response, MAX_PROVIDER_ERROR_BYTES, signal)
    if (bytes === null) return fallback
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (typeof value !== 'object' || value === null) return fallback
    const error = Reflect.get(value, 'error')
    const detail = typeof error === 'object' && error !== null ? error : value
    const rawCode = Reflect.get(detail, 'code')
    const rawStatus = Reflect.get(detail, 'status')
    const providerCode = typeof rawCode === 'string' ? rawCode : rawStatus
    const rawParameter = Reflect.get(detail, 'param')
    const code = typeof providerCode === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(providerCode) ? providerCode : fallback.code
    const parameter = typeof rawParameter === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(rawParameter) ? rawParameter : null
    return { code, parameter }
  } catch {
    return fallback
  }
}
const providerDispatchers = new WeakMap<typeof lookup, Agent>()
const pinnedProviderDispatcher = (resolve: typeof lookup): Agent => {
  const existing = providerDispatchers.get(resolve)
  if (existing) return existing
  const dispatcher = new Agent({
    // Reuse idle connections between chat turns, not just adjacent tool calls.
    // Provider keep-alive hints still apply; never retain an idle socket indefinitely.
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connect: {
      lookup: (hostname, options, callback) => {
        void resolve(hostname, { all: true, verbatim: true }).then(
          addresses => {
            try {
              assertPublicProviderAddresses(addresses)
              if (options.all) callback(null, addresses)
              else {
                const matching = options.family === 4 || options.family === 6 ? addresses.find(address => address.family === options.family) : addresses[0]
                if (!matching)
                  return callback(Object.assign(new Error('Provider hostname has no address in the requested family'), { code: 'ENOTFOUND' }), '', 0)
                callback(null, matching.address, matching.family)
              }
            } catch (error: unknown) {
              callback(error instanceof Error ? error : new Error('Provider DNS validation failed'), '', 0)
            }
          },
          error => callback(error instanceof Error ? error : new Error('Provider DNS resolution failed'), '', 0)
        )
      }
    }
  })
  providerDispatchers.set(resolve, dispatcher)
  return dispatcher
}
type ProviderEndpoint =
  | '/responses'
  | '/chat/completions'
  | '/messages'
  | '/completions'
  | 'gemini-chat'
  | 'gemini-media'
  | 'google-interactions'
  | 'openai-images'
  | 'stability-images'
interface MediaEgressPolicy {
  readonly generateModels: readonly string[]
  readonly countModels: readonly string[]
  readonly files: boolean
}
const exactProviderBase = (base: URL, origin: string, path: string): boolean =>
  base.protocol === 'https:' && base.origin === origin && base.pathname === path && !base.search && !base.hash && !base.username && !base.password

const isOpenAIGpt56OrLater = (model: string): boolean => {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:[-.]|$)/u.exec(model)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 5 || (major === 5 && minor >= 6)
}

const isOpenAICacheCapableModel = (model: string): boolean => isOpenAIGpt56OrLater(model) || /^(?:gpt-(?:5(?:\.\d+)?|4\.1|4o)|o[134])(?:[-.]|$)/u.test(model)

const isNonnegativeSafeTokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const geminiGenerateEndpointAllowed = (base: URL, url: URL, init?: RequestInit, model?: string): boolean => {
  if (init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') return false
  const prefix = `${base.pathname.replace(/\/$/u, '')}/models/`
  if (!url.pathname.startsWith(prefix)) return false
  const relative = url.pathname.slice(prefix.length)
  const match = /^([a-z0-9][a-z0-9._-]{0,254}):(generateContent|streamGenerateContent)$/u.exec(relative)
  if (!match || (model !== undefined && match[1] !== model)) return false
  return match[2] === 'generateContent' ? !url.search : url.search === '?alt=sse'
}

const geminiMediaEndpointAllowed = (base: URL, url: URL, init?: RequestInit, policy?: MediaEgressPolicy): boolean => {
  if (!policy || base.origin !== 'https://generativelanguage.googleapis.com' || !['/v1beta', '/v1beta/'].includes(base.pathname)) return false
  const method = init?.method?.toUpperCase() || 'GET'
  const body = init?.body
  if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) return false
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body instanceof Uint8Array ? body.byteLength : 0
  const pdfUpload = url.pathname === '/upload/v1beta/files' && new Headers(init?.headers).get('content-type') === 'application/pdf'
  const maximum =
    url.pathname.includes(':generateContent') || url.pathname.includes(':countTokens')
      ? 4 * Math.ceil(GEMINI_MEDIA_INPUT_LIMIT / 3) * 4 + 262_144
      : pdfUpload
        ? GEMINI_PDF_INPUT_LIMIT
        : GEMINI_MEDIA_INPUT_LIMIT
  if (length > maximum) return false
  const allowed = policy
  if (geminiGenerateEndpointAllowed(base, url, init)) {
    const configuredModel = url.pathname.slice('/v1beta/models/'.length).split(':', 1)[0]!
    return !url.search && allowed.generateModels.includes(configuredModel) && url.pathname.endsWith(':generateContent')
  }
  const countedModel = /^\/v1beta\/models\/([a-z0-9][a-z0-9._-]{0,127}):countTokens$/u.exec(url.pathname)?.[1]
  if (countedModel) return allowed.countModels.includes(countedModel) && method === 'POST' && !url.search && typeof body === 'string'
  if (!allowed.files) return false
  if (/^\/v1beta\/files\/[A-Za-z0-9_-]{1,128}$/u.test(url.pathname)) return ['GET', 'DELETE'].includes(method) && !url.search && length === 0
  if (url.pathname !== '/upload/v1beta/files' || method !== 'POST') return false
  if (!url.search) return true
  return (
    [...url.searchParams.keys()].every(key => ['upload_id', 'upload_protocol'].includes(key)) &&
    url.searchParams.getAll('upload_id').length === 1 &&
    /^[A-Za-z0-9_-]{1,1024}$/u.test(url.searchParams.get('upload_id') || '') &&
    url.searchParams.getAll('upload_protocol').length <= 1 &&
    (!url.searchParams.has('upload_protocol') || url.searchParams.get('upload_protocol') === 'resumable')
  )
}

const multipartModelAllowed = (body: Uint8Array, headers: Headers, model: string): boolean => {
  const match = /^multipart\/form-data;\s*boundary=([A-Za-z0-9_.-]{1,70})$/u.exec(headers.get('content-type') ?? '')
  if (!match) return false
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  const boundary = Buffer.from(`--${match[1]}`)
  let offset = 0
  let modelParts = 0
  while (offset < bytes.length) {
    if (!bytes.subarray(offset, offset + boundary.length).equals(boundary)) return false
    offset += boundary.length
    if (bytes.subarray(offset, offset + 4).toString('ascii') === '--\r\n') return modelParts === 1 && offset + 4 === bytes.length
    if (bytes.subarray(offset, offset + 2).toString('ascii') !== '\r\n') return false
    offset += 2
    const headerEnd = bytes.indexOf('\r\n\r\n', offset)
    if (headerEnd < offset || headerEnd - offset > 4_096) return false
    const header = bytes.toString('utf8', offset, headerEnd)
    const next = bytes.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), headerEnd + 4)
    if (next === -1) return false
    if (/(?:^|\r\n)Content-Disposition:\s*form-data;\s*name="model"(?:;[^\r\n]*)?(?:\r\n|$)/iu.test(header)) {
      modelParts++
      if (modelParts !== 1 || bytes.toString('utf8', headerEnd + 4, next) !== model) return false
    }
    offset = next + 2
  }
  return false
}

const independentMediaEndpointAllowed = (
  base: URL,
  url: URL,
  endpoint: ProviderEndpoint,
  init: RequestInit | undefined,
  model: string | undefined
): boolean => {
  if (!model || init?.method?.toUpperCase() !== 'POST' || url.search) return false
  const body = init.body
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) return false
  const headers = new Headers(init.headers)
  if (endpoint === 'stability-images') {
    return (
      exactProviderBase(base, 'https://api.stability.ai', '/v2beta') &&
      url.pathname === '/v2beta/stable-image/generate/core' &&
      body instanceof Uint8Array &&
      body.byteLength <= 128 * 1_024 &&
      /^multipart\/form-data;\s*boundary=[A-Za-z0-9_.-]{1,70}$/u.test(headers.get('content-type') ?? '')
    )
  }
  if (endpoint === 'openai-images') {
    if (!exactProviderBase(base, 'https://api.openai.com', '/v1')) return false
    if (url.pathname === '/v1/images/edits')
      return body instanceof Uint8Array && body.byteLength <= GEMINI_MEDIA_INPUT_LIMIT + 256 * 1_024 && multipartModelAllowed(body, headers, model)
    if (url.pathname !== '/v1/images/generations') return false
  } else if (endpoint === 'google-interactions') {
    if (!exactProviderBase(base, 'https://generativelanguage.googleapis.com', '/v1beta') || url.pathname !== '/v1beta/interactions') return false
  } else return false
  if (
    typeof body !== 'string' ||
    Buffer.byteLength(body) > (endpoint === 'google-interactions' ? 4 * Math.ceil(GEMINI_MEDIA_INPUT_LIMIT / 3) + 80 * 1_024 : 256 * 1_024) ||
    headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json'
  )
    return false
  try {
    const value: unknown = JSON.parse(body)
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Reflect.get(value, 'model') === model &&
      (endpoint !== 'google-interactions' ||
        (Reflect.get(value, 'store') === false &&
          Reflect.get(value, 'stream') === false &&
          Reflect.get(value, 'background') === false &&
          !Object.hasOwn(value, 'previous_interaction_id') &&
          !Object.hasOwn(value, 'tools') &&
          !Object.hasOwn(value, 'continuation_token')))
    )
  } catch {
    return false
  }
}

const providerEndpointAllowed = (
  base: URL,
  url: URL,
  endpoint: ProviderEndpoint,
  init?: RequestInit,
  model?: string,
  mediaPolicy?: MediaEgressPolicy
): boolean => {
  if (endpoint === 'gemini-media') return geminiMediaEndpointAllowed(base, url, init, mediaPolicy)
  if (endpoint === 'gemini-chat') return geminiGenerateEndpointAllowed(base, url, init, model)
  if (endpoint === 'google-interactions' || endpoint === 'openai-images' || endpoint === 'stability-images')
    return independentMediaEndpointAllowed(base, url, endpoint, init, model)
  const basePath = base.pathname.replace(/\/$/, '')
  return url.pathname === `${basePath}${endpoint}` && url.search.length === 0
}

export const createGuardedProviderFetch = (
  baseUrl: string,
  endpoint: ProviderEndpoint,
  additionalHeaders: Readonly<Record<string, string>>,
  implementation: AgentProviderFetch = undiciFetch as unknown as AgentProviderFetch,
  resolve: typeof lookup = lookup,
  limits: AgentProviderResourceLimits = deriveAgentProviderResourceLimits(4_096),
  onLimit?: (error: AgentRepositoryError) => void,
  model?: string,
  mediaPolicy?: MediaEgressPolicy,
  authorizeDispatch?: () => Promise<void>
): AgentProviderFetch => {
  const base = new URL(baseUrl)
  const dispatcher = pinnedProviderDispatcher(resolve)
  return Object.assign(
    async (input: Parameters<AgentProviderFetch>[0], init?: Parameters<AgentProviderFetch>[1]): Promise<Response> => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (
        url.protocol !== 'https:' ||
        url.origin !== base.origin ||
        !providerEndpointAllowed(base, url, endpoint, init, model, mediaPolicy) ||
        url.hash ||
        url.username ||
        url.password ||
        (['gemini-media', 'gemini-chat', 'google-interactions', 'openai-images', 'stability-images'].includes(endpoint) &&
          typeof input !== 'string' &&
          !(input instanceof URL))
      )
        throw new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Provider request destination is not allowlisted', 502)
      if (endpoint === 'gemini-chat' && (typeof init?.body !== 'string' || Buffer.byteLength(init.body) > limits.rawBodyBytes))
        throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Provider request exceeded its byte limit', 500)
      assertPublicProviderAddresses(await resolve(url.hostname, { all: true, verbatim: true }))
      const headers = new Headers(init?.headers)
      for (const [name, value] of Object.entries(additionalHeaders)) headers.set(name, value)
      const signal = init?.signal ?? (typeof input === 'string' || input instanceof URL ? undefined : input.signal)
      signal?.throwIfAborted()
      // Authorization is fresh at host dispatch, not atomic with a remote RPC.
      // The dispatcher independently validates connection-time DNS addresses.
      if (authorizeDispatch) await authorizeDispatch()
      signal?.throwIfAborted()
      const response = (await (implementation as unknown as typeof undiciFetch)(url, {
        ...init,
        ...(signal ? { signal } : {}),
        headers,
        redirect: 'manual',
        credentials: 'omit',
        dispatcher
      } as unknown as UndiciRequestInit)) as unknown as Response
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {})
        throw new AgentProviderAttemptError('PROVIDER_REDIRECT_DENIED', response.status, null)
      }
      if (!response.ok) {
        const failure = await providerFailure(response, signal)
        throw new AgentProviderAttemptError(failure.code, response.status, retryAfter(response.headers.get('retry-after')), failure.parameter)
      }
      const mediaBodyLimit = GEMINI_MEDIA_OUTPUT_LIMIT
      return guardedSuccessfulResponse(
        response,
        endpoint === 'gemini-media'
          ? {
              ...limits,
              rawBodyBytes: Math.min(limits.rawBodyBytes, mediaBodyLimit),
              rawChunkBytes: Math.min(limits.rawChunkBytes, mediaBodyLimit)
            }
          : limits,
        onLimit,
        signal
      )
    },
    { preconnect: disabledProviderPreconnect }
  )
}

const createAnthropicEffortFetch = (
  implementation: AgentProviderFetch,
  effort: AgentReasoningEffort | undefined,
  automaticCaching: boolean
): AgentProviderFetch => {
  if (effort === undefined && !automaticCaching) return implementation
  return Object.assign(
    async (input: Parameters<AgentProviderFetch>[0], init?: Parameters<AgentProviderFetch>[1]): Promise<Response> => {
      if (typeof init?.body !== 'string') throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Anthropic request body is invalid', 500)
      let body: Record<string, unknown>
      try {
        const value: unknown = JSON.parse(init.body)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid')
        body = value as Record<string, unknown>
      } catch {
        throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Anthropic request body is invalid', 500)
      }
      const existing = body.output_config
      if (effort !== undefined && existing !== undefined && (typeof existing !== 'object' || existing === null || Array.isArray(existing))) {
        throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Anthropic output configuration is invalid', 500)
      }
      return implementation(input, {
        ...init,
        body: JSON.stringify({
          ...body,
          ...(automaticCaching ? { cache_control: { type: 'ephemeral' } } : {}),
          ...(effort === undefined
            ? {}
            : {
                output_config: {
                  ...(existing as Readonly<Record<string, unknown>> | undefined),
                  effort
                }
              })
        })
      })
    },
    { preconnect: implementation.preconnect }
  )
}

const geminiThinkingLevel = (effort: AgentReasoningEffort): 'minimal' | 'low' | 'medium' | 'high' => {
  if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high') return effort
  throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored Gemini reasoning effort is invalid', 500)
}

const legacyPrompt = (request: Readonly<AxChatRequest<unknown>>): string =>
  request.chatPrompt
    .map(message => {
      if (message.role === 'function') throw new AgentRepositoryError('INVALID_LEGACY_PROMPT', 'Legacy completions do not accept tool results', 400)
      if (typeof message.content !== 'string') throw new AgentRepositoryError('INVALID_LEGACY_PROMPT', 'Legacy completions require text-only messages', 400)
      return `${message.role}: ${message.content}`
    })
    .join('\n\n')

const createLegacyCompletionService = (
  row: ProviderVersionRow,
  secret: string,
  config: ReturnType<typeof AgentProviderAdapterConfigSchema.parse>,
  guardedFetch: AgentProviderFetch,
  onError: (error: AgentRepositoryError) => void
): AxAIService => {
  const nativeFetch = async (_input: Parameters<AgentProviderFetch>[0], init?: RequestInit, canonicalPrompt?: string): Promise<Response> => {
    if (typeof init?.body !== 'string') throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Provider request body is invalid', 500)
    // This wire request is emitted by the real Ax client after validating our canonical chat.
    const request = JSON.parse(init.body) as {
      messages: AxChatRequest['chatPrompt']
      max_tokens?: number
      max_completion_tokens?: number
    }
    const maxTokens = request.max_completion_tokens ?? request.max_tokens
    const headers = new Headers({ 'content-type': 'application/json' })
    headers.set(row.authMode === 'api-key-header' ? 'x-api-key' : 'authorization', row.authMode === 'api-key-header' ? secret : `Bearer ${secret}`)
    const response = await guardedFetch(`${row.baseUrl.replace(/\/$/, '')}/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: row.model,
        prompt: canonicalPrompt ?? legacyPrompt({ chatPrompt: request.messages }),
        stream: false,
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens })
      }),
      ...(init.signal == null ? {} : { signal: init.signal })
    })
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null || !Array.isArray(Reflect.get(payload, 'choices')))
      throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider returned an invalid completion', 502)
    const first: unknown = Reflect.get(payload, 'choices')[0]
    const text = typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : undefined
    if (typeof text !== 'string' || text.length > 128_000)
      throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider returned an invalid completion', 502)
    let usage: Record<string, number> | undefined
    if (Object.hasOwn(payload, 'usage')) {
      const rawUsage: unknown = Reflect.get(payload, 'usage')
      if (typeof rawUsage !== 'object' || rawUsage === null || Array.isArray(rawUsage))
        throw new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Provider returned incomplete or invalid token usage', 502)
      const promptTokens: unknown = Reflect.get(rawUsage, 'prompt_tokens')
      const completionTokens: unknown = Reflect.get(rawUsage, 'completion_tokens')
      const totalTokens: unknown = Reflect.get(rawUsage, 'total_tokens')
      if (!isNonnegativeSafeTokenCount(promptTokens) || !isNonnegativeSafeTokenCount(completionTokens) || !isNonnegativeSafeTokenCount(totalTokens))
        throw new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Provider returned incomplete or invalid token usage', 502)
      assertAgentTokenUsage(promptTokens, completionTokens, totalTokens)
      usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens }
    }
    return Response.json({
      id: 'legacy-completion',
      object: 'chat.completion',
      created: 0,
      model: row.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      ...(usage === undefined ? {} : { usage })
    })
  }
  const completionFetch = (canonicalPrompt?: string): AgentProviderFetch => Object.assign(
    async (input: Parameters<AgentProviderFetch>[0], init?: RequestInit): Promise<Response> => {
      try {
        return await nativeFetch(input, init, canonicalPrompt)
      } catch (error) {
        if (error instanceof AgentRepositoryError) onError(error)
        throw error
      }
    },
    { preconnect: guardedFetch.preconnect }
  ) as AgentProviderFetch
  const service = ai({
    name: 'openai-compatible',
    apiKey: secret,
    apiURL: row.baseUrl,
    config: { model: row.model, stream: false },
    options: { fetch: completionFetch(), timeout: config.timeoutMs, retry: { maxRetries: 0 }, includeRequestBodyInErrors: false, excludeContentFromTrace: true }
  })
  const nativeFeatures = service.getFeatures(row.model)
  service.getFeatures = () => ({
    ...nativeFeatures,
    functions: false,
    functionEmulation: true,
    streaming: false,
    structuredOutputs: false,
    structuredOutputModes: [],
    thinking: false,
    hasThinkingBudget: false,
    hasShowThoughts: false,
    media: {
      images: { supported: false, formats: [] },
      audio: { supported: false, formats: [] },
      files: { supported: false, formats: [], uploadMethod: 'none' },
      urls: { supported: false, webSearch: false, contextFetching: false }
    },
    caching: { supported: false, types: [] }
  })
  const nativeChat = service.chat.bind(service)
  service.chat = (request, options) => {
    if (request.functions?.length || request.responseFormat)
      throw new AgentRepositoryError('INVALID_LEGACY_PROMPT', 'Legacy completions require prompt-only text output without native tools or schemas', 400)
    // Do not let OpenAI's model-specific message rewriting alter a legacy native prompt.
    const prompt = legacyPrompt(request)
    return nativeChat({ ...request, model: row.model }, { ...options, stream: false, fetch: completionFetch(prompt) })
  }
  return service
}

interface ProviderRequestScope {
  readonly limits: AgentProviderResourceLimits
  readonly onLimit: (error: AgentRepositoryError) => void
  readonly onError: (error: AgentRepositoryError) => void
}

const requestOutputTokens = (request: Readonly<AxChatRequest<unknown>>, ceiling: number): number => {
  const requested = request.modelConfig?.maxTokens
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1)
    throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Provider output token limit is invalid', 500)
  return Math.min(requested, ceiling)
}

type ProviderChatService = AxAIService & Pick<AgentProviderService, 'nativeMediaCapabilities'>

const createRequestScopedService = (
  capabilities: AgentProviderCapabilities,
  model: string,
  build: (scope: ProviderRequestScope) => ProviderChatService
): ProviderChatService => {
  const ceiling = capabilities.maxOutputTokens
  const featureService = build({ limits: deriveAgentProviderResourceLimits(ceiling), onLimit: () => {}, onError: () => {} })
  const defaults = featureService.getOptions()
  let lastService = featureService
  let nativeMediaCapabilities = featureService.getFeatures(model).media
  const safeOptions = (options: Readonly<AxAIServiceOptions>, fetch: AxAIServiceOptions['fetch']): AxAIServiceOptions => {
    const timeout = options.timeout ?? defaults.timeout ?? 300_000
    if (!Number.isSafeInteger(timeout) || timeout < 1)
      throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Provider timeout is invalid', 400)
    const locked: AxAIServiceOptions = {
      ...options,
      timeout: Math.min(timeout, defaults.timeout ?? 300_000),
      retry: { maxRetries: 0 },
      includeRequestBodyInErrors: false,
      excludeContentFromTrace: true
    }
    delete locked.corsProxy
    delete locked.webSocket
    if (fetch === undefined) delete locked.fetch
    else locked.fetch = fetch
    return locked
  }
  const unsupported = async (): Promise<never> => {
    throw new AgentRepositoryError('UNSUPPORTED_PROVIDER_OPERATION', 'This provider service permits admitted chat requests only', 400)
  }
  return {
    getId: () => featureService.getId(),
    getName: () => featureService.getName(),
    getFeatures: () => {
      const features = featureService.getFeatures(model)
      const functions = capabilities.toolCalling === 'native' && features.functions
      const nativeSchema = capabilities.structuredOutput === 'native-json-schema' && features.structuredOutputs === true
      return {
        ...features,
        functions,
        streaming: capabilities.streaming && features.streaming,
        structuredOutputs: nativeSchema,
        structuredOutputModes: features.structuredOutputModes?.filter(mode =>
          mode === 'native' ? nativeSchema : mode === 'function' ? functions && capabilities.structuredOutput !== 'prompt-only' : nativeSchema
        ) ?? [],
        asyncTools: false,
        nativeSteering: false,
        reasoningUpdates: false
      }
    },
    getModelList: () => featureService.getModelList(),
    getMetrics: () => lastService.getMetrics(),
    getLogger: () => featureService.getLogger(),
    getLastUsedChatModel: () => lastService.getLastUsedChatModel(),
    getLastUsedEmbedModel: () => lastService.getLastUsedEmbedModel(),
    getLastUsedModelConfig: () => lastService.getLastUsedModelConfig(),
    getEstimatedCost: usage => featureService.getEstimatedCost(usage),
    getOptions: () => featureService.getOptions(),
    setOptions: options => featureService.setOptions(safeOptions({ ...defaults, ...options }, defaults.fetch)),
    validateChatRequest: (request, options) => featureService.validateChatRequest?.({ ...request, model }, options),
    embed: unsupported,
    transcribe: unsupported,
    speak: unsupported,
    openChatSession: unsupported,
    get nativeMediaCapabilities() {
      return nativeMediaCapabilities
    },
    chat: async (request, options) => {
      const controller = new AbortController()
      let applicationError: AgentRepositoryError | undefined
      const onError = (error: AgentRepositoryError): void => {
        applicationError ??= error
      }
      const attached = readAgentProviderResourceLimits(request)
      const outputTokens = requestOutputTokens(request, ceiling)
      const limits = attached
        ? { ...attached, maxOutputTokens: Math.min(attached.maxOutputTokens, outputTokens) }
        : deriveAgentProviderResourceLimits(outputTokens)
      const onLimit = (error: AgentRepositoryError): void => {
        if (!controller.signal.aborted) controller.abort(error)
      }
      const defaultsSnapshot = featureService.getOptions()
      const signal = AbortSignal.any([
        controller.signal,
        ...(defaultsSnapshot.abortSignal ? [defaultsSnapshot.abortSignal] : []),
        ...(options?.abortSignal ? [options.abortSignal] : [])
      ])
      const boundedRequest = {
        ...request,
        model,
        modelConfig: { ...request.modelConfig, maxTokens: Math.min(limits.maxOutputTokens, requestOutputTokens(request, ceiling)) }
      }
      try {
        const service = build({ limits, onLimit, onError })
        const scopedOptions = safeOptions({ ...defaultsSnapshot, ...options, abortSignal: signal }, service.getOptions().fetch)
        const response = await service.chat(boundedRequest, scopedOptions)
        lastService = service
        // Always resolve the exact configured model, never a caller override.
        nativeMediaCapabilities = service.getFeatures(model).media
        return response
      } catch (error) {
        // Ax wraps custom-fetch failures; retain only errors recorded by our own boundary.
        throw applicationError ?? error
      }
    }
  }
}

export class AgentProviderFactory {
  readonly #knex: Knex
  readonly #secrets: Pick<AgentSecretRegistry, 'get'>
  readonly #fetch: AgentProviderFetch
  readonly #resolve: typeof lookup
  constructor(
    knex: Knex,
    secrets: Pick<AgentSecretRegistry, 'get'>,
    fetchImplementation: AgentProviderFetch = undiciFetch as unknown as AgentProviderFetch,
    resolve: typeof lookup = lookup
  ) {
    this.#knex = knex
    this.#secrets = secrets
    this.#fetch = fetchImplementation
    this.#resolve = resolve
  }
  async createMediaBinding(
    ownerId: number,
    kind: AgentMediaKind,
    profileVersionId: string
  ): Promise<{ transport: AgentMediaTransport; config: AgentMediaProviderConfig }> {
    const binding = await assertAgentMediaBinding(this.#knex, ownerId, kind, profileVersionId)
    const config = binding.config
    const apiKey = await this.#secrets.get(binding.secretReference)
    if (!apiKey) throw new AgentRepositoryError('PROFILE_SECRET_UNAVAILABLE', 'Media provider secret is unavailable', 503)
    const responseBytes =
      config.api === 'gemini-interactions'
        ? kind === 'video'
          ? GEMINI_VIDEO_RESPONSE_LIMIT
          : GEMINI_MUSIC_RESPONSE_LIMIT
        : config.api === 'openai-images'
          ? 4 * Math.ceil(GEMINI_MEDIA_INPUT_LIMIT / 3) + 64 * 1_024
          : config.api === 'stability-images'
            ? GEMINI_MEDIA_INPUT_LIMIT
            : GEMINI_MEDIA_OUTPUT_LIMIT
    const limits = {
      ...deriveAgentProviderResourceLimits(config.maxOutputTokens),
      rawBodyBytes: responseBytes,
      rawChunkBytes: responseBytes
    }
    const endpoint: ProviderEndpoint =
      config.api === 'gemini-generate-content'
        ? 'gemini-media'
        : config.api === 'gemini-interactions'
          ? 'google-interactions'
          : config.api === 'openai-images'
            ? 'openai-images'
            : 'stability-images'
    const transport: AgentMediaTransport = {
      generate: async (input, signal) => {
        // A transport arms its paid call before entering the guarded fetch.
        // Notify accounting only after DNS, live authorization and abort checks;
        // a proven no-HTTP denial must release, not consume, its reservation.
        let pendingDispatch: (() => void) | undefined
        const guarded = createGuardedProviderFetch(
          config.baseUrl,
          endpoint,
          {},
          Object.assign(
            (destination: Parameters<AgentProviderFetch>[0], init?: Parameters<AgentProviderFetch>[1]) => {
              const notify = pendingDispatch
              pendingDispatch = undefined
              notify?.()
              return this.#fetch(destination, init)
            },
            { preconnect: this.#fetch.preconnect }
          ),
          this.#resolve,
          limits,
          undefined,
          config.model,
          config.api === 'gemini-generate-content' ? { generateModels: [config.model], countModels: [config.model], files: false } : undefined,
          async () => {
            const current = await assertAgentMediaBinding(this.#knex, ownerId, kind, profileVersionId)
            if (current.secretReference !== binding.secretReference)
              throw new AgentRepositoryError('AGENT_MEDIA_DISABLED', 'Media binding is no longer current', 403)
          }
        )
        const scopedInput = {
          ...input,
          onDispatch: () => {
            pendingDispatch = input.onDispatch
          }
        }
        if (config.api === 'gemini-interactions')
          return createGoogleInteractionsMediaTransport({ config, apiKey, fetch: guarded }).generate(scopedInput, signal)
        if (config.api === 'openai-images' || config.api === 'stability-images')
          return createIndependentImageMediaTransport({ config, apiKey, fetch: guarded }).generate(scopedInput, signal)
        const gemini = createGeminiMediaTransport({
          apiKey,
          baseUrl: config.baseUrl,
          timeoutMs: config.timeoutMs,
          maxInputTokens: config.maxInputTokens,
          maxOutputTokens: config.maxOutputTokens,
          ...(kind === 'image' ? { imageModel: config.model } : { transcriptionModel: config.model }),
          countModels: [config.model],
          fetch: guarded
        })
        if (kind === 'image') {
          if (typeof scopedInput.prompt !== 'string') throw new AgentRepositoryError('INVALID_MEDIA_INPUT', 'Image generation requires a prompt', 400)
          const result = await gemini.generateImage(
            { ...scopedInput, prompt: scopedInput.prompt, ...(scopedInput.files === undefined ? {} : { images: scopedInput.files }) },
            signal
          )
          return { text: result.text, files: result.images, usage: result.usage, usageSource: 'reported' }
        }
        if (kind !== 'transcription' || scopedInput.files?.length !== 1 || (scopedInput.prompt !== undefined && scopedInput.prompt !== ''))
          throw new AgentRepositoryError('INVALID_MEDIA_INPUT', 'Transcription requires exactly one audio file', 400)
        const result = await gemini.transcribe({ ...scopedInput, ...scopedInput.files[0]! }, signal)
        return { text: result.text, files: [], usage: result.usage, usageSource: 'reported' }
      }
    }
    return { config, transport }
  }

  async createMediaInput(profileVersionId: string): Promise<{
    transport: GeminiMediaInputTransport
    config: { attachments: boolean }
    capabilities: AgentProviderCapabilities
  }> {
    const row = (await this.#knex('agentProviderProfileVersions as versions')
      .join('agentProviderProfiles as profiles', function () {
        this.on('profiles.id', '=', 'versions.profileId').andOn('profiles.currentVersionId', '=', 'versions.id')
      })
      .where({ 'versions.id': profileVersionId, 'versions.conformed': true, 'profiles.conformed': true, 'profiles.status': 'enabled' })
      .whereNull('profiles.deletedAt')
      .select('versions.*')
      .first()) as ProviderVersionRow | undefined
    if (!row || row.transportKind !== 'gemini-api' || row.authMode !== 'google-api-key' || !row.secretReference)
      throw new AgentRepositoryError('AGENT_MEDIA_DISABLED', 'Native media context is not enabled for this provider', 403)
    let adapterConfig: ReturnType<typeof AgentProviderAdapterConfigSchema.parse>
    let capabilities: AgentProviderCapabilities
    try {
      adapterConfig = AgentProviderAdapterConfigSchema.parse(JSON.parse(row.adapterConfig))
      capabilities = AgentProviderCapabilitiesSchema.parse(JSON.parse(row.capabilities))
    } catch {
      throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored provider profile data is invalid', 500)
    }
    const mediaInputs = agentProviderMediaInputs(row.transportKind, adapterConfig)
    if (!Object.values(mediaInputs).some(Boolean)) throw new AgentRepositoryError('AGENT_MEDIA_DISABLED', 'Native media context is disabled', 403)
    const apiKey = await this.#secrets.get(row.secretReference)
    if (!apiKey) throw new AgentRepositoryError('PROFILE_SECRET_UNAVAILABLE', 'Provider profile secret is unavailable', 503)
    const countModels = [row.model, ...(row.utilityModel ? [row.utilityModel] : [])]
    const limits = {
      ...deriveAgentProviderResourceLimits(capabilities.maxOutputTokens),
      rawBodyBytes: GEMINI_MEDIA_OUTPUT_LIMIT,
      rawChunkBytes: GEMINI_MEDIA_OUTPUT_LIMIT
    }
    const gemini = createGeminiMediaTransport({
      apiKey,
      baseUrl: row.baseUrl,
      timeoutMs: adapterConfig.timeoutMs,
      countModels,
      fetch: createGuardedProviderFetch(
        row.baseUrl,
        'gemini-media',
        adapterConfig.additionalHeaders,
        this.#fetch,
        this.#resolve,
        limits,
        undefined,
        undefined,
        {
          generateModels: [],
          countModels,
          files: true
        }
      )
    })
    const modalityByMime: Readonly<Record<string, keyof AgentMediaInputs>> = {
      'image/png': 'images',
      'image/jpeg': 'images',
      'image/webp': 'images',
      'image/gif': 'images',
      'application/pdf': 'documents',
      'audio/webm': 'audio',
      'audio/ogg': 'audio',
      'audio/wav': 'audio',
      'audio/mpeg': 'audio',
      'audio/mp3': 'audio',
      'audio/mp4': 'audio',
      'audio/aac': 'audio',
      'audio/flac': 'audio',
      'video/mp4': 'video',
      'video/webm': 'video'
    }
    return {
      config: { attachments: true },
      capabilities,
      transport: {
        async upload(input, signal) {
          const modality = Object.hasOwn(modalityByMime, input.mimeType) ? modalityByMime[input.mimeType] : undefined
          if (!modality || !mediaInputs[modality])
            throw new AgentRepositoryError('INVALID_MEDIA_INPUT', 'This LLM profile does not opt into this media input', 400)
          return gemini.upload(input, signal)
        },
        async countTokens(model, input, signal) {
          for (const block of input) {
            if (block.type === 'text') continue
            const modality = Object.hasOwn(modalityByMime, block.mime_type) ? modalityByMime[block.mime_type] : undefined
            if (!modality || !mediaInputs[modality])
              throw new AgentRepositoryError('INVALID_MEDIA_INPUT', 'This LLM profile does not opt into this media input', 400)
          }
          return gemini.countTokens(model, input, signal)
        },
        delete: gemini.delete
      }
    }
  }
  async create(
    profileVersionId: string,
    loadOptions: {
      readonly requireConformed?: boolean
      readonly purpose?: 'agent' | 'utility'
      /** Default only; explicit effort for the selected purpose takes precedence. */
      readonly reasoningEffort?: AgentReasoningEffort
    } = {}
  ): Promise<AgentProviderService> {
    const query = this.#knex<ProviderVersionRow>('agentProviderProfileVersions').where({ id: profileVersionId })
    if (loadOptions.requireConformed !== false) query.andWhere({ conformed: true })
    const row = await query.first()
    if (!row || !row.secretReference) throw new AgentRepositoryError('PROFILE_VERSION_UNAVAILABLE', 'Provider profile version is unavailable', 409)
    const secret = await this.#secrets.get(row.secretReference)
    if (!secret) throw new AgentRepositoryError('PROFILE_SECRET_UNAVAILABLE', 'Provider profile secret is unavailable', 503)
    const model = loadOptions.purpose === 'utility' ? (row.utilityModel ?? row.model) : row.model
    if (row.transportKind === 'gemini-api' && !isGeminiChatModel(model))
      throw new AgentRepositoryError('INVALID_PROVIDER_MODEL', 'Gemini requires a native GenerateContent chat model ID', 400)
    const providerBase = new URL(row.baseUrl)
    const officialOpenAIEndpoint =
      (row.transportKind === 'openai-responses' || row.transportKind === 'openai-chat') && exactProviderBase(providerBase, 'https://api.openai.com', '/v1')
    const automaticAnthropicCaching = row.transportKind === 'anthropic-messages' && exactProviderBase(providerBase, 'https://api.anthropic.com', '/v1')
    const officialGemini = row.transportKind === 'gemini-api' && exactProviderBase(providerBase, 'https://generativelanguage.googleapis.com', '/v1beta')
    const pricing = {
      ...parseAgentProviderPricing(row.pricingRevision),
      ...(automaticAnthropicCaching || (officialOpenAIEndpoint && isOpenAIGpt56OrLater(model)) ? { cacheWritePremium: true } : {})
    }
    const preserveCachePrefix = automaticAnthropicCaching || officialGemini || (officialOpenAIEndpoint && isOpenAICacheCapableModel(model))
    let adapterConfig: ReturnType<typeof AgentProviderAdapterConfigSchema.parse>
    let capabilities: AgentProviderCapabilities
    try {
      adapterConfig = AgentProviderAdapterConfigSchema.parse(JSON.parse(row.adapterConfig))
      capabilities = AgentProviderCapabilitiesSchema.parse(JSON.parse(row.capabilities))
    } catch {
      throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored provider profile data is invalid', 500)
    }
    if (loadOptions.reasoningEffort !== undefined && !agentProviderReasoningEfforts(row.transportKind).includes(loadOptions.reasoningEffort))
      throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Provider reasoning effort override is not supported by this transport', 400)
    const profileEffort = loadOptions.purpose === 'utility' ? adapterConfig.utilityReasoningEffort : adapterConfig.agentReasoningEffort
    if (profileEffort !== undefined && !agentProviderReasoningEfforts(row.transportKind).includes(profileEffort)) {
      throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored provider reasoning effort is invalid', 500)
    }
    const reasoningEffort = profileEffort ?? loadOptions.reasoningEffort
    const endpoint: ProviderEndpoint =
      row.transportKind === 'openai-responses' || row.transportKind === 'openresponses'
        ? '/responses'
        : row.transportKind === 'anthropic-messages'
          ? '/messages'
          : row.transportKind === 'legacy-completions'
            ? '/completions'
            : row.transportKind === 'gemini-api'
              ? 'gemini-chat'
              : '/chat/completions'
    const createTransportFetch = (scope: ProviderRequestScope): AgentProviderFetch => {
      const guardedFetch = createGuardedProviderFetch(
        row.baseUrl,
        endpoint,
        adapterConfig.additionalHeaders,
        this.#fetch,
        this.#resolve,
        scope.limits,
        scope.onLimit,
        row.transportKind === 'gemini-api' ? model : undefined
      )
      return row.transportKind === 'openresponses' ? createOpenResponsesFetch(guardedFetch) : guardedFetch
    }
    const createOptions = (scope: ProviderRequestScope, transportFetch: AgentProviderFetch) =>
      ({
        fetch: Object.assign(
          async (input: Parameters<AgentProviderFetch>[0], init?: RequestInit): Promise<Response> => {
            try {
              return await transportFetch(input, init)
            } catch (error) {
              if (error instanceof AgentRepositoryError) scope.onError(error)
              throw error
            }
          },
          { preconnect: transportFetch.preconnect }
        ) as AgentProviderFetch,
        timeout: adapterConfig.timeoutMs,
        retry: { maxRetries: 0 },
        includeRequestBodyInErrors: false,
        excludeContentFromTrace: true
      }) as const
    const legacyRow = { ...row, model }
    let service: ProviderChatService
    if (row.transportKind === 'openai-responses' || row.transportKind === 'openresponses' || row.transportKind === 'openai-chat') {
      service = createRequestScopedService(capabilities, model, scope => {
        const transport = createTransportFetch(scope)
        const configuredFetch = Object.assign(
          async (input: Parameters<AgentProviderFetch>[0], init?: RequestInit): Promise<Response> => {
            if (typeof init?.body !== 'string') throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Provider request body is invalid', 500)
            const body = JSON.parse(init.body)
            if (row.transportKind === 'openai-chat') {
              if (body.tools?.length) body.parallel_tool_calls = capabilities.parallelToolCalls
              if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort
            } else {
              body.input = restoreOpenAIReasoningInput(body.input)
              body.store = false
              body.previous_response_id = null
              body.include = [...new Set([...(body.include ?? []), 'reasoning.encrypted_content'])]
              if (body.tools) body.tools = body.tools.map((tool: { type: string }) => (tool.type === 'function' ? { ...tool, strict: false } : tool))
              if (reasoningEffort !== undefined) body.reasoning = { ...body.reasoning, effort: reasoningEffort }
              delete body.temperature
              delete body.top_p
            }
            return transport(input, { ...init, body: JSON.stringify(body) })
          },
          { preconnect: transport.preconnect }
        ) as AgentProviderFetch
        return row.transportKind === 'openai-chat'
          ? ai({
              name: 'openai-compatible',
              apiKey: secret,
              apiURL: row.baseUrl,
              config: { model, ...(adapterConfig.temperature === undefined ? {} : { temperature: adapterConfig.temperature }) },
              // A conformed custom deployment supplies the exact model's schema capability.
              modelInfo: [{ name: model, supported: { structuredOutputs: capabilities.structuredOutput === 'native-json-schema' } }],
              options: createOptions(scope, configuredFetch)
            })
          : ai({
              name: 'openai-responses',
              apiKey: secret,
              apiURL: row.baseUrl,
              config: {
                model: model as AxAIOpenAIResponsesModel,
                store: false,
                parallelToolCalls: capabilities.toolCalling === 'native' && capabilities.parallelToolCalls
              },
              options: createOptions(scope, configuredFetch)
            })
      })
    } else if (row.transportKind === 'anthropic-messages') {
      service = createRequestScopedService(capabilities, model, scope => {
        const transportFetch = createTransportFetch(scope)
        const configuredFetch = Object.assign(
          async (input: Parameters<AgentProviderFetch>[0], init?: RequestInit): Promise<Response> => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
            if (url.href !== 'https://api.anthropic.com/v1/messages')
              throw new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Anthropic request destination is not allowlisted', 502)
            return transportFetch(`${row.baseUrl.replace(/\/$/u, '')}/messages`, init)
          },
          { preconnect: transportFetch.preconnect }
        ) as AgentProviderFetch
        return ai({
          name: 'anthropic',
          apiKey: secret,
          config: { model: model as AxAIAnthropicModel, ...(adapterConfig.temperature === undefined ? {} : { temperature: adapterConfig.temperature }) },
          options: createOptions(scope, createAnthropicEffortFetch(configuredFetch, reasoningEffort, automaticAnthropicCaching))
        })
      })
    } else if (row.transportKind === 'gemini-api') {
      service = createRequestScopedService(capabilities, model, scope =>
        createGeminiAxService({
          apiKey: secret,
          baseUrl: row.baseUrl,
          model,
          fetch: createTransportFetch(scope),
          timeoutMs: adapterConfig.timeoutMs,
          maxOutputTokens: scope.limits.maxOutputTokens,
          limits: scope.limits,
          ...(adapterConfig.temperature === undefined ? {} : { temperature: adapterConfig.temperature }),
          ...(reasoningEffort === undefined ? {} : { thinkingLevel: geminiThinkingLevel(reasoningEffort) })
        })
      )
    } else if (row.transportKind === 'legacy-completions') {
      service = createRequestScopedService(capabilities, model, scope =>
        createLegacyCompletionService(legacyRow, secret, adapterConfig, createTransportFetch(scope), scope.onError)
      )
    } else {
      throw new AgentRepositoryError('UNSUPPORTED_PROVIDER_TRANSPORT', 'Provider transport is not supported by this factory', 409)
    }
    return {
      service,
      capabilities,
      mediaInputs: agentProviderMediaInputs(row.transportKind, adapterConfig),
      get nativeMediaCapabilities() {
        return service.nativeMediaCapabilities
      },
      transportKind: row.transportKind,
      continuationDialect: providerContinuationDialect(row.transportKind),
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      capabilityRevision: row.capabilityRevision,
      pricingRevision: row.pricingRevision,
      pricing,
      preserveCachePrefix,
      preserveThoughtBlock:
        row.transportKind === 'openai-responses' || row.transportKind === 'openresponses'
          ? (resultId, block) => (block.encrypted ? openAIReasoningState(resultId, block) : null)
          : row.transportKind === 'gemini-api'
            ? (_resultId, block) => preserveGeminiContinuation(block)
            : row.transportKind === 'openai-chat' || row.transportKind === 'anthropic-messages'
              ? (_resultId, block) => {
                  if (block.encrypted !== true || typeof block.data !== 'string' || Buffer.byteLength(block.data, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES)
                    return null
                  if (
                    block.signature !== undefined &&
                    (typeof block.signature !== 'string' || Buffer.byteLength(block.signature, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES)
                  )
                    return null
                  return {
                    data: block.data,
                    encrypted: true,
                    ...(block.signature === undefined ? {} : { signature: block.signature })
                  }
                }
              : () => null
    }
  }
}
