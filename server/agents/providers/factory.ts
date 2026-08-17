import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Knex } from 'knex'
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
  type AxAIOpenAIChatRequest,
  type AxAIOpenAIResponsesRequest
} from '@ax-llm/ax'
import {
  AgentProviderAdapterConfigSchema,
  AgentProviderCapabilitiesSchema,
  type AgentProviderCapabilities,
  type AgentProviderTransportKind
} from './registry.ts'
import { AgentRepositoryError } from '../repository.ts'

const MAX_RETRY_AFTER_MS = 300_000
const MAX_PROVIDER_ERROR_BYTES = 64 * 1_024

export class AgentProviderAttemptError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterMilliseconds: number | null
  readonly retryable: boolean
  constructor (code: string, status: number, retryAfterMilliseconds: number | null) {
    super('Provider request failed')
    this.name = 'AgentProviderAttemptError'
    this.code = code
    this.status = status
    this.retryAfterMilliseconds = retryAfterMilliseconds
    this.retryable = status === 408 || status === 409 || status === 429 || status >= 500
  }
}

export interface AgentProviderSecretProvider {
  get(reference: string): string | null
}

export class EnvironmentAgentProviderSecretProvider implements AgentProviderSecretProvider {
  get(reference: string): string | null {
    const name = /^env:([A-Z][A-Z0-9_]{0,127})$/.exec(reference)?.[1]
    if (!name) return null
    const value = process.env[name]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
}

interface ProviderVersionRow {
  id: string
  transportKind: AgentProviderTransportKind
  model: string
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
}

const isPrivateAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number)
    const a = octets[0] ?? -1
    const b = octets[1] ?? -1
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  }
  const value = address.toLowerCase()
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)
}

const retryAfter = (value: string | null, now = Date.now()): number | null => {
  if (!value) return null
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(value) - now
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(milliseconds))
}

const providerCode = async (response: Response): Promise<string> => {
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_PROVIDER_ERROR_BYTES) return `HTTP_${response.status}`
  try {
    const bytes = new Uint8Array(await response.clone().arrayBuffer())
    if (bytes.byteLength > MAX_PROVIDER_ERROR_BYTES) return `HTTP_${response.status}`
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof value === 'object' && value !== null) {
      const error = Reflect.get(value, 'error')
      const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : Reflect.get(value, 'code')
      if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(code)) return code
    }
  } catch { /* response details are deliberately discarded */ }
  return `HTTP_${response.status}`
}
export const createGuardedProviderFetch = (baseUrl: string, endpoint: '/responses' | '/chat/completions' | '/messages' | '/completions', additionalHeaders: Readonly<Record<string, string>>, implementation: typeof fetch = fetch, resolve: typeof lookup = lookup): typeof fetch => {
  const base = new URL(baseUrl)
  const allowedPath = `${base.pathname.replace(/\/$/, '')}${endpoint}`
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.protocol !== 'https:' || url.origin !== base.origin || url.pathname !== allowedPath || url.search || url.hash || url.username || url.password) throw new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Provider request destination is not allowlisted', 502)
    const addresses = await resolve(url.hostname, { all: true, verbatim: true })
    if (addresses.length === 0 || addresses.some(entry => isPrivateAddress(entry.address))) throw new AgentRepositoryError('PROVIDER_EGRESS_DENIED', 'Provider hostname resolved to a prohibited address', 502)
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(additionalHeaders)) headers.set(name, value)
    const response = await implementation(url, { ...init, headers, redirect: 'manual', credentials: 'omit' })
    if (response.status >= 300 && response.status < 400) throw new AgentProviderAttemptError('PROVIDER_REDIRECT_DENIED', response.status, null)
    if (!response.ok) throw new AgentProviderAttemptError(await providerCode(response), response.status, retryAfter(response.headers.get('retry-after')))
    return response
  }
}

const axFeatures = (capabilities: AgentProviderCapabilities): AxAIFeatures => ({
  functions: capabilities.functions,
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
  readonly #secrets: AgentProviderSecretProvider
  readonly #fetch: typeof fetch
  readonly #resolve: typeof lookup
  constructor (knex: Knex, secrets: AgentProviderSecretProvider, fetchImplementation: typeof fetch = fetch, resolve: typeof lookup = lookup) {
    this.#knex = knex
    this.#secrets = secrets
    this.#fetch = fetchImplementation
    this.#resolve = resolve
  }
  async create(profileVersionId: string, loadOptions: { readonly requireConformed?: boolean } = {}): Promise<AgentProviderService> {
    const query = this.#knex<ProviderVersionRow>('agentProviderProfileVersions').where({ id: profileVersionId })
    if (loadOptions.requireConformed !== false) query.andWhere({ conformed: true })
    const row = await query.first()
    if (!row || !row.secretReference) throw new AgentRepositoryError('PROFILE_VERSION_UNAVAILABLE', 'Provider profile version is unavailable', 409)
    const secret = this.#secrets.get(row.secretReference)
    if (!secret) throw new AgentRepositoryError('PROFILE_SECRET_UNAVAILABLE', 'Provider profile secret is unavailable', 503)
    let adapterConfig: ReturnType<typeof AgentProviderAdapterConfigSchema.parse>
    let capabilities: AgentProviderCapabilities
    try {
      adapterConfig = AgentProviderAdapterConfigSchema.parse(JSON.parse(row.adapterConfig))
      capabilities = AgentProviderCapabilitiesSchema.parse(JSON.parse(row.capabilities))
    } catch {
      throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored provider profile data is invalid', 500)
    }
    const options = {
      fetch: createGuardedProviderFetch(
        row.baseUrl,
        row.transportKind === 'openai-responses' || row.transportKind === 'openresponses'
          ? '/responses'
          : row.transportKind === 'anthropic-messages'
            ? '/messages'
            : row.transportKind === 'legacy-completions'
              ? '/completions'
              : '/chat/completions',
        adapterConfig.additionalHeaders,
        this.#fetch,
        this.#resolve
      ),
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
        model: row.model,
        store: false,
        ...(adapterConfig.reasoningEffort === undefined ? {} : { reasoningEffort: adapterConfig.reasoningEffort }),
        ...(adapterConfig.temperature === undefined ? {} : { temperature: adapterConfig.temperature })
      }
      service = new AxAIOpenAIResponsesBase<string, AxAIOpenAIEmbedModel, string, AxAIOpenAIResponsesRequest<string>>({
        apiKey: secret,
        apiURL: row.baseUrl,
        config,
        options,
        modelInfo: [],
        supportFor: features,
        responsesReqUpdater: request => ({ ...request, store: false, previous_response_id: null, include: [...new Set([...(request.include ?? []), 'reasoning.encrypted_content' as const])] })
      })
    } else if (row.transportKind === 'openai-chat') {
      const config = {
        ...axAIOpenAIDefaultConfig(),
        model: row.model,
        ...(adapterConfig.temperature === undefined ? {} : { temperature: adapterConfig.temperature })
      }
      service = new AxAIOpenAIBase<string, AxAIOpenAIEmbedModel, string, AxAIOpenAIChatRequest<string>>({
        apiKey: secret,
        apiURL: row.baseUrl,
        config,
        options,
        modelInfo: [],
        supportFor: features
      })
    } else if (row.transportKind === 'anthropic-messages') {
      service = new AxAIAnthropic({
        apiKey: secret,
        config: {
          model: row.model as AxAIAnthropicModel,
          ...(adapterConfig.temperature === undefined ? {} : { temperature: adapterConfig.temperature })
        },
        options
      })
    } else if (row.transportKind === 'legacy-completions') {
      service = createLegacyCompletionService(row, secret, adapterConfig, options.fetch)
    } else {
      throw new AgentRepositoryError('UNSUPPORTED_PROVIDER_TRANSPORT', 'Provider transport is not supported by this factory', 409)
    }
    return { service, capabilities, transportKind: row.transportKind, model: row.model, capabilityRevision: row.capabilityRevision, pricingRevision: row.pricingRevision }
  }
}
