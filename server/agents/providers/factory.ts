import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import type { Knex } from 'knex'
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import {
  AxAIAnthropic,
  AxAIAnthropicModel,
  AxAIOpenAIEmbedModel,
  AxAIOpenAIBase,
  AxAIOpenAIResponsesBase,
  axAIOpenAIDefaultConfig,
  axAIOpenAIResponsesDefaultConfig,
  type AxAIFeatures,
  type AxAIService,
  type AxAIServiceOptions,
  type AxChatRequest,
  type AxChatResponse,
  type AxChatResponseResult,
  type AxAIOpenAIChatRequest,
  type AxAIOpenAIResponsesRequest
} from '@ax-llm/ax'
import { agentProviderReasoningEfforts, type AgentReasoningEffort } from '../../../shared/agents/contracts.ts'
import { assertAgentTokenUsage } from './usage.ts'
import {
  AgentProviderAdapterConfigSchema,
  AgentProviderCapabilitiesSchema,
  AgentProviderPricingRevisionSchema,
  type AgentProviderCapabilities,
  type AgentProviderTransportKind
} from './registry.ts'
import { AgentRepositoryError } from '../repository.ts'
import { createOpenResponsesFetch } from './openresponses.ts'
import {
  createGeminiInteractionsService,
  isGeminiInteractionsModel,
  isGeminiInteractionContinuation,
  preserveGeminiInteractionState
} from './gemini-interactions.ts'
import type { AgentSecretRegistry } from './secrets.ts'

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
  'gemini-interactions-v1',
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
type ProviderRequestWithLimits = object & { readonly [PROVIDER_RESOURCE_LIMITS]?: AgentProviderResourceLimits }
export const attachAgentProviderResourceLimits = <T extends object>(request: T, limits: AgentProviderResourceLimits): T => {
  Object.defineProperty(request, PROVIDER_RESOURCE_LIMITS, { configurable: false, enumerable: false, value: limits, writable: false })
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
        ? 'gemini-interactions-v1'
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
  return {
    data: `${OPENAI_REASONING_STATE_PREFIX}${JSON.stringify([resultId, block.data])}`,
    encrypted: true
  }
}

const restoreOpenAIReasoningItem = (item: unknown): unknown => {
  if (typeof item !== 'object' || item === null || Reflect.get(item, 'type') !== 'reasoning') return item
  const content = Reflect.get(item, 'content')
  if (typeof content !== 'string' || !content.startsWith(OPENAI_REASONING_STATE_PREFIX)) return item
  try {
    const encoded = content.slice(OPENAI_REASONING_STATE_PREFIX.length)
    if (Buffer.byteLength(encoded, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES) throw new Error('too large')
    const value: unknown = JSON.parse(encoded)
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'string' ||
      !/^rs_[A-Za-z0-9_-]{1,256}$/u.test(value[0]) ||
      Buffer.byteLength(value[0], 'utf8') > MAX_PROVIDER_IDENTIFIER_BYTES ||
      typeof value[1] !== 'string'
    )
      throw new Error('invalid')
    return { type: 'reasoning', id: value[0], content: [], summary: [], encrypted_content: value[1] }
  } catch {
    throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation is invalid', 500)
  }
}

const restoreOpenAIReasoningInput = (input: AxAIOpenAIResponsesRequest<string>['input']): AxAIOpenAIResponsesRequest<string>['input'] =>
  Array.isArray(input) ? (input.map(restoreOpenAIReasoningItem) as AxAIOpenAIResponsesRequest<string>['input']) : input
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
        : dialect === 'gemini-interactions-v1'
          ? !isGeminiInteractionContinuation(block)
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
    return { thoughtBlocks: validateContinuationBlocks(expectedDialect, thoughtBlocks, 'stored') }
  }
  if (!Array.isArray(thoughtBlocks)) return undefined
  if (expectedDialect !== 'openai-responses-reasoning-v1' && expectedDialect !== 'openresponses-reasoning-v1' && expectedDialect !== 'gemini-interactions-v1')
    return undefined
  return { thoughtBlocks: validateContinuationBlocks(expectedDialect, thoughtBlocks, 'stored') }
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
    pricing.outputMicrosPerMillionTokens < 0
  )
    throw new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Provider pricing is invalid', 502)
  const residualTokens = totalTokens - inputTokens - outputTokens
  const maximumRate = Math.max(pricing.inputMicrosPerMillionTokens, pricing.outputMicrosPerMillionTokens)
  const numerator =
    BigInt(inputTokens) * BigInt(pricing.inputMicrosPerMillionTokens) +
    BigInt(outputTokens) * BigInt(pricing.outputMicrosPerMillionTokens) +
    BigInt(residualTokens) * BigInt(maximumRate)
  const cost = (numerator + 999_999n) / 1_000_000n
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Provider usage cost exceeds the supported range', 502)
  return Number(cost)
}

export interface AgentProviderService {
  readonly service: Pick<AxAIService, 'chat'>
  readonly capabilities: AgentProviderCapabilities
  readonly transportKind: AgentProviderTransportKind
  readonly continuationDialect?: AgentProviderContinuationDialect | null
  readonly model: string
  readonly capabilityRevision: string
  readonly pricingRevision: string
  readonly pricing: AgentProviderPricing
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
const readBoundedResponseBytes = async (response: Response, maximumBytes: number): Promise<Uint8Array | null> => {
  const body = response.body
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
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
  onLimit?: (error: AgentRepositoryError) => void
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  let total = 0
  let finished = false
  let cancellationRequested = false
  let readerReleased = false
  const releaseReader = (): void => {
    if (readerReleased) return
    readerReleased = true
    try {
      reader.releaseLock()
    } catch {
      // The body reader is already unusable.
    }
  }
  const cancel = (reason: unknown): void => {
    if (!cancellationRequested) {
      cancellationRequested = true
      void reader.cancel(reason).catch(() => {})
    }
    releaseReader()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return
      const item = await reader.read().catch(error => {
        finished = true
        releaseReader()
        controller.error(error)
        return null
      })
      if (item === null) return
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

const guardedSuccessfulResponse = (response: Response, limits: AgentProviderResourceLimits, onLimit?: (error: AgentRepositoryError) => void): Response => {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > limits.rawBodyBytes) {
    const error = new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider response exceeded its byte limit', 502)
    const body = response.body
    if (body !== null) void body.cancel(error).catch(() => {})
    onLimit?.(error)
    throw error
  }
  if (response.body === null) return response
  return new Response(boundedProviderResponseBody(response.body, limits, onLimit), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

const providerFailure = async (response: Response): Promise<{ code: string; parameter: string | null }> => {
  const fallback = { code: `HTTP_${response.status}`, parameter: null }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_PROVIDER_ERROR_BYTES) return fallback
  try {
    const bytes = await readBoundedResponseBytes(response, MAX_PROVIDER_ERROR_BYTES)
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
type ProviderEndpoint = '/responses' | '/chat/completions' | '/messages' | '/completions' | '/interactions'

const providerEndpointAllowed = (base: URL, url: URL, endpoint: ProviderEndpoint): boolean => {
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
  onLimit?: (error: AgentRepositoryError) => void
): AgentProviderFetch => {
  const base = new URL(baseUrl)
  const dispatcher = pinnedProviderDispatcher(resolve)
  return Object.assign(
    async (input: Parameters<AgentProviderFetch>[0], init?: Parameters<AgentProviderFetch>[1]): Promise<Response> => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.protocol !== 'https:' || url.origin !== base.origin || !providerEndpointAllowed(base, url, endpoint) || url.hash || url.username || url.password)
        throw new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Provider request destination is not allowlisted', 502)
      assertPublicProviderAddresses(await resolve(url.hostname, { all: true, verbatim: true }))
      const headers = new Headers(init?.headers)
      for (const [name, value] of Object.entries(additionalHeaders)) headers.set(name, value)
      const response = (await (implementation as unknown as typeof undiciFetch)(url, {
        ...init,
        headers,
        redirect: 'manual',
        credentials: 'omit',
        dispatcher
      } as unknown as UndiciRequestInit)) as unknown as Response
      if (response.status >= 300 && response.status < 400) throw new AgentProviderAttemptError('PROVIDER_REDIRECT_DENIED', response.status, null)
      if (!response.ok) {
        const failure = await providerFailure(response)
        throw new AgentProviderAttemptError(failure.code, response.status, retryAfter(response.headers.get('retry-after')), failure.parameter)
      }
      return guardedSuccessfulResponse(response, limits, onLimit)
    },
    { preconnect: disabledProviderPreconnect }
  )
}

const createAnthropicEffortFetch = (implementation: AgentProviderFetch, effort: AgentReasoningEffort | undefined): AgentProviderFetch => {
  if (effort === undefined) return implementation
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
      if (existing !== undefined && (typeof existing !== 'object' || existing === null || Array.isArray(existing))) {
        throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Anthropic output configuration is invalid', 500)
      }
      return implementation(input, {
        ...init,
        body: JSON.stringify({
          ...body,
          output_config: { ...(existing as Readonly<Record<string, unknown>> | undefined), effort }
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

const axFeatures = (capabilities: AgentProviderCapabilities): AxAIFeatures => ({
  functions: capabilities.toolCalling === 'native',
  streaming: capabilities.streaming,
  structuredOutputs: capabilities.structuredOutput === 'native-json-schema',
  media: {
    images: { supported: false, formats: [] },
    audio: { supported: false, formats: [] },
    files: { supported: false, formats: [], uploadMethod: 'none' },
    urls: { supported: false, webSearch: false, contextFetching: false }
  },
  caching: { supported: false, types: [] },
  thinking: false,
  multiTurn: true
})

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
  guardedFetch: AgentProviderFetch
): Pick<AxAIService, 'chat'> => ({
  chat: async (request: Readonly<AxChatRequest<unknown>>, options?: Readonly<AxAIServiceOptions>): Promise<AxChatResponse> => {
    if (request.functions?.length) throw new AgentRepositoryError('INVALID_LEGACY_PROMPT', 'Legacy completions do not support tools', 400)
    const headers = new Headers({ 'content-type': 'application/json' })
    headers.set(row.authMode === 'api-key-header' ? 'x-api-key' : 'authorization', row.authMode === 'api-key-header' ? secret : `Bearer ${secret}`)
    const response = await guardedFetch(`${row.baseUrl.replace(/\/$/, '')}/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: row.model,
        prompt: legacyPrompt(request),
        stream: false,
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
        ...(request.modelConfig?.maxTokens === undefined ? {} : { max_tokens: request.modelConfig.maxTokens })
      }),
      ...(options?.abortSignal === undefined ? {} : { signal: options.abortSignal })
    })
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null || !Array.isArray(Reflect.get(payload, 'choices')))
      throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider returned an invalid completion', 502)
    const first: unknown = Reflect.get(payload, 'choices')[0]
    const text = typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : undefined
    if (typeof text !== 'string' || text.length > 128_000)
      throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider returned an invalid completion', 502)
    const rawUsage: unknown = Reflect.get(payload, 'usage')
    const promptTokens =
      typeof rawUsage === 'object' && rawUsage !== null && Number.isSafeInteger(Reflect.get(rawUsage, 'prompt_tokens'))
        ? Number(Reflect.get(rawUsage, 'prompt_tokens'))
        : 0
    const completionTokens =
      typeof rawUsage === 'object' && rawUsage !== null && Number.isSafeInteger(Reflect.get(rawUsage, 'completion_tokens'))
        ? Number(Reflect.get(rawUsage, 'completion_tokens'))
        : 0
    return {
      results: [{ index: 0, content: text, finishReason: 'stop' }],
      modelUsage: { ai: 'legacy-completions', model: row.model, tokens: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } }
    }
  }
})

interface ProviderRequestScope {
  readonly limits: AgentProviderResourceLimits
  readonly onLimit: (error: AgentRepositoryError) => void
}

const requestOutputTokens = (request: Readonly<AxChatRequest<unknown>>, ceiling: number): number => {
  const requested = request.modelConfig?.maxTokens
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1)
    throw new AgentRepositoryError('INVALID_PROVIDER_REQUEST', 'Provider output token limit is invalid', 500)
  return Math.min(requested, ceiling)
}

const createRequestScopedService = (ceiling: number, build: (scope: ProviderRequestScope) => Pick<AxAIService, 'chat'>): Pick<AxAIService, 'chat'> => ({
  chat: (request, options) => {
    const controller = new AbortController()
    const limits = readAgentProviderResourceLimits(request) ?? deriveAgentProviderResourceLimits(requestOutputTokens(request, ceiling))
    const onLimit = (error: AgentRepositoryError): void => {
      if (!controller.signal.aborted) controller.abort(error)
    }
    const signal = options?.abortSignal === undefined ? controller.signal : AbortSignal.any([options.abortSignal, controller.signal])
    const scopedOptions = { ...(options ?? {}), abortSignal: signal }
    return build({ limits, onLimit }).chat(request, scopedOptions)
  }
})

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
  async create(
    profileVersionId: string,
    loadOptions: { readonly requireConformed?: boolean; readonly purpose?: 'agent' | 'utility' } = {}
  ): Promise<AgentProviderService> {
    const query = this.#knex<ProviderVersionRow>('agentProviderProfileVersions').where({ id: profileVersionId })
    if (loadOptions.requireConformed !== false) query.andWhere({ conformed: true })
    const row = await query.first()
    if (!row || !row.secretReference) throw new AgentRepositoryError('PROFILE_VERSION_UNAVAILABLE', 'Provider profile version is unavailable', 409)
    const secret = await this.#secrets.get(row.secretReference)
    if (!secret) throw new AgentRepositoryError('PROFILE_SECRET_UNAVAILABLE', 'Provider profile secret is unavailable', 503)
    const pricing = parseAgentProviderPricing(row.pricingRevision)
    const model = loadOptions.purpose === 'utility' ? (row.utilityModel ?? row.model) : row.model
    if (row.transportKind === 'gemini-api' && !isGeminiInteractionsModel(model))
      throw new AgentRepositoryError('INVALID_PROVIDER_MODEL', 'Gemini Interactions requires a Gemini 3.x model ID', 400)
    let adapterConfig: ReturnType<typeof AgentProviderAdapterConfigSchema.parse>
    let capabilities: AgentProviderCapabilities
    try {
      adapterConfig = AgentProviderAdapterConfigSchema.parse(JSON.parse(row.adapterConfig))
      capabilities = AgentProviderCapabilitiesSchema.parse(JSON.parse(row.capabilities))
    } catch {
      throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored provider profile data is invalid', 500)
    }
    const reasoningEffort = loadOptions.purpose === 'utility' ? adapterConfig.utilityReasoningEffort : adapterConfig.agentReasoningEffort
    if (reasoningEffort !== undefined && !agentProviderReasoningEfforts(row.transportKind).includes(reasoningEffort)) {
      throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored provider reasoning effort is invalid', 500)
    }
    const endpoint: ProviderEndpoint =
      row.transportKind === 'openai-responses' || row.transportKind === 'openresponses'
        ? '/responses'
        : row.transportKind === 'anthropic-messages'
          ? '/messages'
          : row.transportKind === 'legacy-completions'
            ? '/completions'
            : row.transportKind === 'gemini-api'
              ? '/interactions'
              : '/chat/completions'
    const createTransportFetch = (scope: ProviderRequestScope): AgentProviderFetch => {
      const guardedFetch = createGuardedProviderFetch(
        row.baseUrl,
        endpoint,
        adapterConfig.additionalHeaders,
        this.#fetch,
        this.#resolve,
        scope.limits,
        scope.onLimit
      )
      return row.transportKind === 'openresponses' ? createOpenResponsesFetch(guardedFetch) : guardedFetch
    }
    const createOptions = (transportFetch: AgentProviderFetch) =>
      ({
        fetch: transportFetch,
        timeout: adapterConfig.timeoutMs,
        retry: { maxRetries: 0 },
        includeRequestBodyInErrors: false,
        excludeContentFromTrace: true
      }) as const
    const legacyRow = { ...row, model }
    let service: Pick<AxAIService, 'chat'>
    if (row.transportKind === 'openai-responses' || row.transportKind === 'openresponses') {
      service = createRequestScopedService(
        capabilities.maxOutputTokens,
        scope =>
          new AxAIOpenAIResponsesBase<string, AxAIOpenAIEmbedModel, string, AxAIOpenAIResponsesRequest<string>>({
            apiKey: secret,
            apiURL: row.baseUrl,
            config: {
              ...axAIOpenAIResponsesDefaultConfig(),
              model,
              store: false,
              parallelToolCalls: capabilities.toolCalling === 'native' && capabilities.parallelToolCalls,
              ...(reasoningEffort === undefined ? {} : { reasoningEffort })
            },
            options: createOptions(createTransportFetch(scope)),
            modelInfo: [],
            supportFor: axFeatures(capabilities),
            responsesReqUpdater: request => {
              const updated = {
                ...request,
                input: restoreOpenAIReasoningInput(request.input),
                store: false,
                previous_response_id: null,
                include: [...new Set([...(request.include ?? []), 'reasoning.encrypted_content' as const])],
                tools: request.tools == null ? null : request.tools.map(tool => (tool.type === 'function' ? { ...tool, strict: false } : tool))
              }
              delete updated.temperature
              delete updated.top_p
              return updated
            }
          })
      )
    } else if (row.transportKind === 'openai-chat') {
      service = createRequestScopedService(
        capabilities.maxOutputTokens,
        scope =>
          new AxAIOpenAIBase<string, AxAIOpenAIEmbedModel, string, AxAIOpenAIChatRequest<string>>({
            apiKey: secret,
            apiURL: row.baseUrl,
            config: {
              ...axAIOpenAIDefaultConfig(),
              model,
              ...(adapterConfig.temperature === undefined ? {} : { temperature: adapterConfig.temperature })
            },
            options: createOptions(createTransportFetch(scope)),
            modelInfo: [],
            supportFor: axFeatures(capabilities),
            chatReqUpdater: request => {
              const updated = {
                ...request,
                ...(request.tools?.length ? { parallel_tool_calls: capabilities.parallelToolCalls } : {})
              }
              // Ax's request type trails the current API, whose reasoning_effort also accepts max.
              if (reasoningEffort !== undefined) Reflect.set(updated, 'reasoning_effort', reasoningEffort)
              return updated
            }
          })
      )
    } else if (row.transportKind === 'anthropic-messages') {
      service = createRequestScopedService(capabilities.maxOutputTokens, scope => {
        const transportFetch = createTransportFetch(scope)
        const anthropicFetch = createAnthropicEffortFetch(transportFetch, reasoningEffort)
        return new AxAIAnthropic({
          apiKey: secret,
          config: {
            model: model as AxAIAnthropicModel,
            ...(adapterConfig.temperature === undefined ? {} : { temperature: adapterConfig.temperature })
          },
          options: { ...createOptions(transportFetch), fetch: anthropicFetch }
        })
      })
    } else if (row.transportKind === 'gemini-api') {
      service = createRequestScopedService(capabilities.maxOutputTokens, scope =>
        createGeminiInteractionsService({
          apiKey: secret,
          baseUrl: row.baseUrl,
          model,
          fetch: createTransportFetch(scope),
          timeoutMs: adapterConfig.timeoutMs,
          ...(reasoningEffort === undefined ? {} : { thinkingLevel: geminiThinkingLevel(reasoningEffort) })
        })
      )
    } else if (row.transportKind === 'legacy-completions') {
      service = createRequestScopedService(capabilities.maxOutputTokens, scope =>
        createLegacyCompletionService(legacyRow, secret, adapterConfig, createTransportFetch(scope))
      )
    } else {
      throw new AgentRepositoryError('UNSUPPORTED_PROVIDER_TRANSPORT', 'Provider transport is not supported by this factory', 409)
    }
    return {
      service,
      capabilities,
      transportKind: row.transportKind,
      continuationDialect: providerContinuationDialect(row.transportKind),
      model,
      capabilityRevision: row.capabilityRevision,
      pricingRevision: row.pricingRevision,
      pricing,
      preserveThoughtBlock:
        row.transportKind === 'openai-responses' || row.transportKind === 'openresponses'
          ? (resultId, block) => (block.encrypted ? openAIReasoningState(resultId, block) : null)
          : row.transportKind === 'gemini-api'
            ? (_resultId, block) => preserveGeminiInteractionState(block)
            : row.transportKind === 'openai-chat' || row.transportKind === 'anthropic-messages'
              ? (_resultId, block) => {
                  if (block.encrypted !== true || typeof block.data !== 'string' || Buffer.byteLength(block.data, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES)
                    return null
                  if (
                    block.signature !== undefined &&
                    (typeof block.signature !== 'string' || Buffer.byteLength(block.signature, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES)
                  )
                    return null
                  return { data: block.data, encrypted: true, ...(block.signature === undefined ? {} : { signature: block.signature }) }
                }
              : () => null
    }
  }
}
