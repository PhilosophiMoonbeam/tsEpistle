import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import type { Knex } from 'knex'
import { Agent, fetch as undiciFetch } from 'undici'
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
import {
  agentProviderReasoningEfforts,
  type AgentReasoningEffort
} from '../../../shared/agents/contracts.ts'
import {
  AgentProviderAdapterConfigSchema,
  AgentProviderCapabilitiesSchema,
  type AgentProviderCapabilities,
  type AgentProviderTransportKind
} from './registry.ts'
import { AgentRepositoryError } from '../repository.ts'
import { createOpenResponsesFetch } from './openresponses.ts'
import { createGeminiInteractionsService, isGeminiInteractionsModel, preserveGeminiInteractionState } from './gemini-interactions.ts'
import type { AgentSecretRegistry } from './secrets.ts'

const MAX_RETRY_AFTER_MS = 300_000
const MAX_PROVIDER_ERROR_BYTES = 64 * 1_024
const OPENAI_REASONING_STATE_PREFIX = 'wiki.openai.reasoning.v1:'
const MAX_PROVIDER_STATE_ITEM_BYTES = 256 * 1_024

type ProviderThoughtBlock = NonNullable<AxChatResponseResult['thoughtBlocks']>[number]

const openAIReasoningState = (resultId: string, block: ProviderThoughtBlock): ProviderThoughtBlock => {
  if (!/^rs_[A-Za-z0-9_-]{1,256}$/.test(resultId) || typeof block.data !== 'string' || Buffer.byteLength(block.data, 'utf8') > MAX_PROVIDER_STATE_ITEM_BYTES) {
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
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !/^rs_[A-Za-z0-9_-]{1,256}$/.test(value[0]) || typeof value[1] !== 'string') throw new Error('invalid')
    return { type: 'reasoning', id: value[0], content: [], summary: [], encrypted_content: value[1] }
  } catch {
    throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation is invalid', 500)
  }
}

const restoreOpenAIReasoningInput = (input: AxAIOpenAIResponsesRequest<string>['input']): AxAIOpenAIResponsesRequest<string>['input'] => Array.isArray(input)
  ? input.map(restoreOpenAIReasoningItem) as AxAIOpenAIResponsesRequest<string>['input']
  : input

export class AgentProviderAttemptError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterMilliseconds: number | null
  readonly retryable: boolean
  readonly parameter: string | null
  constructor (code: string, status: number, retryAfterMilliseconds: number | null, parameter: string | null = null) {
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
export interface AgentProviderService {
  readonly service: Pick<AxAIService, 'chat'>
  readonly capabilities: AgentProviderCapabilities
  readonly transportKind: AgentProviderTransportKind
  readonly model: string
  readonly capabilityRevision: string
  readonly pricingRevision: string
  readonly preserveThoughtBlock: (resultId: string, block: ProviderThoughtBlock) => ProviderThoughtBlock | null
}

const blockedProviderAddresses = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blockedProviderAddresses.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
] as const) blockedProviderAddresses.addSubnet(network, prefix, 'ipv6')

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

const providerFailure = async (response: Response): Promise<{ code: string; parameter: string | null }> => {
  const fallback = { code: `HTTP_${response.status}`, parameter: null }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_PROVIDER_ERROR_BYTES) return fallback
  try {
    const bytes = new Uint8Array(await response.clone().arrayBuffer())
    if (bytes.byteLength > MAX_PROVIDER_ERROR_BYTES) return fallback
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
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
        void resolve(hostname, { all: true, verbatim: true }).then(addresses => {
          try {
            assertPublicProviderAddresses(addresses)
            if (options.all) callback(null, addresses)
            else {
              const matching = options.family === 4 || options.family === 6
                ? addresses.find(address => address.family === options.family)
                : addresses[0]
              if (!matching) return callback(Object.assign(new Error('Provider hostname has no address in the requested family'), { code: 'ENOTFOUND' }), '', 0)
              callback(null, matching.address, matching.family)
            }
          } catch (error: unknown) {
            callback(error instanceof Error ? error : new Error('Provider DNS validation failed'), '', 0)
          }
        }, error => callback(error instanceof Error ? error : new Error('Provider DNS resolution failed'), '', 0))
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

export const createGuardedProviderFetch = (baseUrl: string, endpoint: ProviderEndpoint, additionalHeaders: Readonly<Record<string, string>>, implementation: typeof fetch = undiciFetch as unknown as typeof fetch, resolve: typeof lookup = lookup): typeof fetch => {
  const base = new URL(baseUrl)
  const dispatcher = pinnedProviderDispatcher(resolve)
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.protocol !== 'https:' || url.origin !== base.origin || !providerEndpointAllowed(base, url, endpoint) || url.hash || url.username || url.password) throw new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Provider request destination is not allowlisted', 502)
    assertPublicProviderAddresses(await resolve(url.hostname, { all: true, verbatim: true }))
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(additionalHeaders)) headers.set(name, value)
    const response = await implementation(url, { ...init, headers, redirect: 'manual', credentials: 'omit', dispatcher } as RequestInit)
    if (response.status >= 300 && response.status < 400) throw new AgentProviderAttemptError('PROVIDER_REDIRECT_DENIED', response.status, null)
    if (!response.ok) {
      const failure = await providerFailure(response)
      throw new AgentProviderAttemptError(failure.code, response.status, retryAfter(response.headers.get('retry-after')), failure.parameter)
    }
    return response
  }
}

const createAnthropicEffortFetch = (implementation: typeof fetch, effort: AgentReasoningEffort | undefined): typeof fetch => {
  if (effort === undefined) return implementation
  return async (input, init): Promise<Response> => {
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
  }
}

const geminiThinkingLevel = (effort: AgentReasoningEffort): 'minimal' | 'low' | 'medium' | 'high' => {
  if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high') return effort
  throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored Gemini reasoning effort is invalid', 500)
}


const axFeatures = (capabilities: AgentProviderCapabilities): AxAIFeatures => ({
  functions: capabilities.toolCalling === 'native',
  streaming: capabilities.streaming,
  structuredOutputs: capabilities.structuredOutput === 'native-json-schema',
  media: { images: { supported: false, formats: [] }, audio: { supported: false, formats: [] }, files: { supported: false, formats: [], uploadMethod: 'none' }, urls: { supported: false, webSearch: false, contextFetching: false } },
  caching: { supported: false, types: [] },
  thinking: false,
  multiTurn: true
})

const legacyPrompt = (request: Readonly<AxChatRequest<unknown>>): string => request.chatPrompt.map(message => {
  if (message.role === 'function') throw new AgentRepositoryError('INVALID_LEGACY_PROMPT', 'Legacy completions do not accept tool results', 400)
  if (typeof message.content !== 'string') throw new AgentRepositoryError('INVALID_LEGACY_PROMPT', 'Legacy completions require text-only messages', 400)
  return `${message.role}: ${message.content}`
}).join('\n\n')

const createLegacyCompletionService = (row: ProviderVersionRow, secret: string, config: ReturnType<typeof AgentProviderAdapterConfigSchema.parse>, guardedFetch: typeof fetch): Pick<AxAIService, 'chat'> => ({
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
    if (typeof payload !== 'object' || payload === null || !Array.isArray(Reflect.get(payload, 'choices'))) throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider returned an invalid completion', 502)
    const first: unknown = Reflect.get(payload, 'choices')[0]
    const text = typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : undefined
    if (typeof text !== 'string' || text.length > 128_000) throw new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', 'Provider returned an invalid completion', 502)
    const rawUsage: unknown = Reflect.get(payload, 'usage')
    const promptTokens = typeof rawUsage === 'object' && rawUsage !== null && Number.isSafeInteger(Reflect.get(rawUsage, 'prompt_tokens')) ? Number(Reflect.get(rawUsage, 'prompt_tokens')) : 0
    const completionTokens = typeof rawUsage === 'object' && rawUsage !== null && Number.isSafeInteger(Reflect.get(rawUsage, 'completion_tokens')) ? Number(Reflect.get(rawUsage, 'completion_tokens')) : 0
    return { results: [{ index: 0, content: text, finishReason: 'stop' }], modelUsage: { ai: 'legacy-completions', model: row.model, tokens: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } } }
  }
})

export class AgentProviderFactory {
  readonly #knex: Knex
  readonly #secrets: Pick<AgentSecretRegistry, 'get'>
  readonly #fetch: typeof fetch
  readonly #resolve: typeof lookup
  constructor (knex: Knex, secrets: Pick<AgentSecretRegistry, 'get'>, fetchImplementation: typeof fetch = undiciFetch as unknown as typeof fetch, resolve: typeof lookup = lookup) {
    this.#knex = knex
    this.#secrets = secrets
    this.#fetch = fetchImplementation
    this.#resolve = resolve
  }
  async create(profileVersionId: string, loadOptions: { readonly requireConformed?: boolean; readonly purpose?: 'agent' | 'utility' } = {}): Promise<AgentProviderService> {
    const query = this.#knex<ProviderVersionRow>('agentProviderProfileVersions').where({ id: profileVersionId })
    if (loadOptions.requireConformed !== false) query.andWhere({ conformed: true })
    const row = await query.first()
    if (!row || !row.secretReference) throw new AgentRepositoryError('PROFILE_VERSION_UNAVAILABLE', 'Provider profile version is unavailable', 409)
    const model = loadOptions.purpose === 'utility' ? row.utilityModel ?? row.model : row.model
    if (row.transportKind === 'gemini-api' && !isGeminiInteractionsModel(model)) throw new AgentRepositoryError('INVALID_PROVIDER_MODEL', 'Gemini Interactions requires a Gemini 3.x model ID', 400)
    const secret = await this.#secrets.get(row.secretReference)
    if (!secret) throw new AgentRepositoryError('PROFILE_SECRET_UNAVAILABLE', 'Provider profile secret is unavailable', 503)
    let adapterConfig: ReturnType<typeof AgentProviderAdapterConfigSchema.parse>
    let capabilities: AgentProviderCapabilities
    try {
      adapterConfig = AgentProviderAdapterConfigSchema.parse(JSON.parse(row.adapterConfig))
      capabilities = AgentProviderCapabilitiesSchema.parse(JSON.parse(row.capabilities))
    } catch {
      throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored provider profile data is invalid', 500)
    }
    const reasoningEffort = loadOptions.purpose === 'utility'
      ? adapterConfig.utilityReasoningEffort
      : adapterConfig.agentReasoningEffort
    if (reasoningEffort !== undefined && !agentProviderReasoningEfforts(row.transportKind).includes(reasoningEffort)) {
      throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored provider reasoning effort is invalid', 500)
    }
    const endpoint: ProviderEndpoint = row.transportKind === 'openai-responses' || row.transportKind === 'openresponses'
      ? '/responses'
      : row.transportKind === 'anthropic-messages'
        ? '/messages'
        : row.transportKind === 'legacy-completions'
          ? '/completions'
          : row.transportKind === 'gemini-api'
            ? '/interactions'
            : '/chat/completions'
    const guardedFetch = createGuardedProviderFetch(
      row.baseUrl,
      endpoint,
      adapterConfig.additionalHeaders,
      this.#fetch,
      this.#resolve
    )
    const transportFetch = row.transportKind === 'openresponses'
      ? createOpenResponsesFetch(guardedFetch)
      : guardedFetch
    const options = {
      fetch: transportFetch,
      timeout: adapterConfig.timeoutMs,
      retry: { maxRetries: 0 },
      includeRequestBodyInErrors: false,
      excludeContentFromTrace: true
    } as const
    const features = axFeatures(capabilities)
    let service: Pick<AxAIService, 'chat'>
    if (row.transportKind === 'openai-responses' || row.transportKind === 'openresponses') {
      const config = {
        ...axAIOpenAIResponsesDefaultConfig(),
        model,
        store: false,
        parallelToolCalls: capabilities.toolCalling === 'native' && capabilities.parallelToolCalls,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort })
      }
      service = new AxAIOpenAIResponsesBase<string, AxAIOpenAIEmbedModel, string, AxAIOpenAIResponsesRequest<string>>({
        apiKey: secret,
        apiURL: row.baseUrl,
        config,
        options,
        modelInfo: [],
        supportFor: features,
        responsesReqUpdater: request => {
          const updated = {
            ...request,
            input: restoreOpenAIReasoningInput(request.input),
            store: false,
            previous_response_id: null,
            include: [...new Set([...(request.include ?? []), 'reasoning.encrypted_content' as const])],
            tools: request.tools == null ? null : request.tools.map(tool => tool.type === 'function' ? { ...tool, strict: false } : tool)
          }
          delete updated.temperature
          delete updated.top_p
          return updated
        }
      })
    } else if (row.transportKind === 'openai-chat') {
      const config = {
        ...axAIOpenAIDefaultConfig(),
        model,
        ...(adapterConfig.temperature === undefined ? {} : { temperature: adapterConfig.temperature })
      }
      service = new AxAIOpenAIBase<string, AxAIOpenAIEmbedModel, string, AxAIOpenAIChatRequest<string>>({
        apiKey: secret,
        apiURL: row.baseUrl,
        config,
        options,
        modelInfo: [],
        supportFor: features,
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
    } else if (row.transportKind === 'anthropic-messages') {
      service = new AxAIAnthropic({
        apiKey: secret,
        config: {
          model: model as AxAIAnthropicModel,
          ...(adapterConfig.temperature === undefined ? {} : { temperature: adapterConfig.temperature })
        },
        options: { ...options, fetch: createAnthropicEffortFetch(options.fetch, reasoningEffort) }
      })
    } else if (row.transportKind === 'gemini-api') {
      service = createGeminiInteractionsService({
        apiKey: secret,
        baseUrl: row.baseUrl,
        model,
        fetch: options.fetch,
        timeoutMs: adapterConfig.timeoutMs,
        ...(reasoningEffort === undefined ? {} : { thinkingLevel: geminiThinkingLevel(reasoningEffort) })
      })
    } else if (row.transportKind === 'legacy-completions') {
      service = createLegacyCompletionService({ ...row, model }, secret, adapterConfig, options.fetch)
    } else {
      throw new AgentRepositoryError('UNSUPPORTED_PROVIDER_TRANSPORT', 'Provider transport is not supported by this factory', 409)
    }
    return {
      service,
      capabilities,
      transportKind: row.transportKind,
      model,
      capabilityRevision: row.capabilityRevision,
      pricingRevision: row.pricingRevision,
      preserveThoughtBlock: row.transportKind === 'openai-responses' || row.transportKind === 'openresponses'
        ? (resultId, block) => block.encrypted ? openAIReasoningState(resultId, block) : null
        : row.transportKind === 'gemini-api'
          ? (_resultId, block) => preserveGeminiInteractionState(block)
          : (_resultId, block) => block.encrypted ? { ...block } : null
    }
  }
}
