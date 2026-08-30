import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { AxChatRequest, AxChatResponse, AxChatResponseResult } from '@ax-llm/ax'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { AgentRepositoryError } from '../repository.ts'
import { AgentProviderAttemptError, AgentProviderFactory, type AgentProviderService } from './factory.ts'
import { parsePromptToolCall, promptToolInstructions, promptToolResultMessage } from './prompt-tools.ts'
import type { AgentProviderRegistry } from './registry.ts'

const MAX_SMOKE_OUTPUT = 16_000
const MAX_LATEST_PROFILE_COUNT = 100
const PROBE_TOOL = {
  name: 'wiki_conformance_echo',
  description: 'Echo the supplied conformance token. Use only when explicitly requested by the provider connection check.',
  parameters: {
    type: 'object',
    properties: { token: { type: 'string', description: 'The exact conformance token from the request.' } },
    required: ['token'],
    additionalProperties: false
  }
} as const satisfies NonNullable<AxChatRequest['functions']>[number]

interface AgentProviderConformanceCheck {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface AgentProviderConformanceReport {
  readonly id: string
  readonly profileVersionId: string
  readonly status: 'passed' | 'failed'
  readonly checks: readonly AgentProviderConformanceCheck[]
  readonly errorCode: string | null
  readonly message: string | null
  readonly startedAt: string
  readonly completedAt: string
}

interface ReportRow {
  id: string
  profileVersionId: string
  status: 'passed' | 'failed'
  checks: string
  errorCode: string | null
  startedAt: Date | string
  completedAt: Date | string
}

const reportView = (row: ReportRow): AgentProviderConformanceReport => {
  const checks = JSON.parse(row.checks) as AgentProviderConformanceReport['checks']
  return {
    id: row.id,
    profileVersionId: row.profileVersionId,
    status: row.status,
    checks,
    errorCode: row.errorCode,
    message: checks.find(check => !check.passed && check.detail)?.detail ?? null,
    startedAt: new Date(row.startedAt).toISOString(),
    completedAt: new Date(row.completedAt).toISOString()
  }
}

const nestedError = (error: unknown): unknown => {
  let current = error
  for (let depth = 0; depth < 4; depth++) {
    if (current instanceof AgentProviderAttemptError || current instanceof AgentRepositoryError) return current
    if (typeof current !== 'object' || current === null) return current
    const original = Reflect.get(current, 'originalError')
    if (original === undefined || original === current) return current
    current = original
  }
  return current
}

const errorCode = (error: unknown): string => {
  const value = nestedError(error)
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'code') === 'string' &&
    /^[A-Z0-9_.-]{1,128}$/i.test(String(Reflect.get(value, 'code')))
  )
    return String(Reflect.get(value, 'code'))
  return 'PROVIDER_CONNECTION_FAILED'
}

const failureDetail = (error: unknown): string => {
  const value = nestedError(error)
  if (value instanceof AgentProviderAttemptError) {
    const suffix = value.code === `HTTP_${value.status}` ? '' : ` (${value.code})`
    if (value.status === 400 && value.parameter) return `Provider rejected the “${value.parameter}” setting${suffix}.`
    if (value.status === 401) return `Provider rejected the API key${suffix}.`
    if (value.status === 403) return `Provider denied access for this API key or model${suffix}.`
    if (value.status === 404) return `Provider endpoint or model was not found${suffix}.`
    if (value.status === 408) return `Provider connection check timed out${suffix}.`
    if (value.status === 429) return `Provider rate limit blocked the connection check${suffix}.`
    if (value.status >= 500) return `Provider was unavailable during the connection check${suffix}.`
    return `Provider connection check failed with HTTP ${value.status}${suffix}.`
  }
  if (value instanceof AgentRepositoryError) return value.message
  return 'Provider connection check failed.'
}

interface ConsumedCall {
  readonly id: string
  readonly name: string
  readonly params: string | object
}

interface ConsumedResponse {
  readonly content: string
  readonly calls: readonly ConsumedCall[]
  readonly thoughtBlocks: NonNullable<AxChatResponseResult['thoughtBlocks']>
}

const consume = async (
  response: AxChatResponse | ReadableStream<AxChatResponse>,
  usageMode: 'stream' | 'terminal' | 'estimated',
  provider: AgentProviderService
): Promise<ConsumedResponse> => {
  let content = ''
  let usageObserved = false
  const calls = new Map<string, ConsumedCall>()
  const thoughtBlocks = new Map<string, NonNullable<AxChatResponseResult['thoughtBlocks']>[number]>()
  const accept = (value: AxChatResponse): void => {
    for (const result of value.results) {
      if (result.content) content += result.content
      if (Buffer.byteLength(content, 'utf8') > MAX_SMOKE_OUTPUT)
        throw new AgentRepositoryError('CONFORMANCE_OUTPUT_TOO_LARGE', 'Provider conformance output exceeded its limit', 502)
      for (const call of result.functionCalls ?? []) {
        if (typeof call.id !== 'string' || call.id.length < 1 || call.id.length > 256)
          throw new AgentRepositoryError('CONFORMANCE_TOOL_INVALID', 'Provider returned an invalid action call ID', 502)
        const prior = calls.get(call.id)
        const name = call.function.name || prior?.name
        if (!name) throw new AgentRepositoryError('CONFORMANCE_TOOL_INVALID', 'Provider omitted the conformance action name', 502)
        if (prior && call.function.name && prior.name !== call.function.name)
          throw new AgentRepositoryError('CONFORMANCE_TOOL_INVALID', 'Provider changed the conformance action name while streaming', 502)
        const next = call.function.params ?? ''
        const params = typeof prior?.params === 'string' && typeof next === 'string' ? `${prior.params}${next}` : next
        if (Buffer.byteLength(typeof params === 'string' ? params : JSON.stringify(params), 'utf8') > MAX_SMOKE_OUTPUT)
          throw new AgentRepositoryError('CONFORMANCE_TOOL_INVALID', 'Provider conformance action arguments exceeded their limit', 502)
        calls.set(call.id, { id: call.id, name, params })
      }
      for (const [index, block] of (result.thoughtBlocks ?? []).entries()) {
        const preserved = provider.preserveThoughtBlock(result.id ?? '', block)
        if (preserved !== null) thoughtBlocks.set(preserved.signature ?? `${result.id ?? result.index}:${index}`, preserved)
      }
    }
    const tokens = value.modelUsage?.tokens
    if (tokens) {
      if (
        ![tokens.promptTokens, tokens.completionTokens, tokens.totalTokens].every(token => Number.isSafeInteger(token) && token >= 0) ||
        tokens.totalTokens < tokens.promptTokens + tokens.completionTokens
      ) {
        throw new AgentRepositoryError('CONFORMANCE_USAGE_INVALID', 'Provider conformance returned invalid usage accounting', 502)
      }
      usageObserved = true
    }
  }
  if (response instanceof ReadableStream) {
    const reader = response.getReader()
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        accept(item.value)
      }
    } finally {
      reader.releaseLock()
    }
  } else accept(response)
  if (usageMode !== 'estimated' && !usageObserved)
    throw new AgentRepositoryError('CONFORMANCE_USAGE_MISSING', 'Provider conformance did not return its declared usage accounting', 502)
  return { content, calls: [...calls.values()], thoughtBlocks: [...thoughtBlocks.values()] }
}

const requireText = (response: ConsumedResponse, emptyMessage = 'Provider conformance returned no text'): string => {
  if (response.calls.length > 0) throw new AgentRepositoryError('CONFORMANCE_UNEXPECTED_TOOL', 'Provider emitted an unexpected action during conformance', 502)
  if (response.content.trim().length === 0) throw new AgentRepositoryError('CONFORMANCE_EMPTY_OUTPUT', emptyMessage, 502)
  return response.content
}

const parseParams = (params: string | object): Readonly<Record<string, unknown>> => {
  let value: unknown = params
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      throw new AgentRepositoryError('CONFORMANCE_TOOL_INVALID', 'Provider returned invalid conformance action JSON', 502)
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new AgentRepositoryError('CONFORMANCE_TOOL_INVALID', 'Provider returned invalid conformance action arguments', 502)
  return value as Readonly<Record<string, unknown>>
}

const verifyCancellation = async (provider: Awaited<ReturnType<AgentProviderFactory['create']>>): Promise<void> => {
  if (!provider.capabilities.cancellation)
    throw new AgentRepositoryError('CONFORMANCE_CANCELLATION_UNDECLARED', 'Provider profile must declare cancellation support', 502)
  const controller = new AbortController()
  controller.abort(new Error('provider conformance cancellation probe'))
  try {
    await provider.service.chat(
      { chatPrompt: [{ role: 'user', content: 'This pre-cancelled request must not be dispatched.' }], model: provider.model },
      { stream: false, abortSignal: controller.signal }
    )
  } catch {
    return
  }
  throw new AgentRepositoryError('CONFORMANCE_CANCELLATION_IGNORED', 'Provider accepted a request whose signal was already aborted', 502)
}
const providerChat = async (provider: AgentProviderService, request: Readonly<AxChatRequest>): Promise<ConsumedResponse> =>
  consume(
    await provider.service.chat(request, {
      stream: provider.capabilities.streaming,
      abortSignal: AbortSignal.timeout(30_000),
      functionCallMode: 'native'
    }),
    provider.capabilities.usage,
    provider
  )

const verifyToolCalling = async (provider: AgentProviderService): Promise<'native-tool-round-trip' | 'prompt-tool-round-trip'> => {
  const token = randomUUID()
  const userMessage = `Call ${PROBE_TOOL.name} exactly once with token ${token}. After receiving the action result, reply with exactly ACKNOWLEDGED and do not call any action again.`
  if (provider.capabilities.toolCalling === 'native') {
    const first = await providerChat(provider, {
      chatPrompt: [{ role: 'user', content: userMessage }],
      model: provider.model,
      functions: [PROBE_TOOL],
      functionCall: { type: 'function', function: { name: PROBE_TOOL.name } }
    })
    const [call] = first.calls
    if (!call || first.calls.length !== 1 || call.name !== PROBE_TOOL.name || parseParams(call.params).token !== token)
      throw new AgentRepositoryError('CONFORMANCE_TOOL_INVALID', 'Provider did not return the required native conformance action', 502)
    const final = await providerChat(provider, {
      chatPrompt: [
        { role: 'user', content: userMessage },
        {
          role: 'assistant',
          ...(first.content ? { content: first.content } : {}),
          functionCalls: [{ id: call.id, type: 'function', function: { name: call.name, params: call.params } }],
          ...(first.thoughtBlocks.length === 0 ? {} : { thoughtBlocks: first.thoughtBlocks })
        },
        { role: 'function', functionId: call.id, result: JSON.stringify({ token, matched: true }) }
      ],
      model: provider.model,
      functions: [PROBE_TOOL],
      functionCall: 'auto'
    })
    requireText(final, 'Provider returned no final text after the native conformance action result')
    return 'native-tool-round-trip'
  }

  const instructions = promptToolInstructions([PROBE_TOOL])
  const first = await providerChat(provider, {
    chatPrompt: [
      { role: 'system', content: instructions },
      { role: 'user', content: userMessage }
    ],
    model: provider.model
  })
  if (first.calls.length > 0) throw new AgentRepositoryError('CONFORMANCE_TOOL_INVALID', 'Prompt tool provider emitted a native action call', 502)
  const call = parsePromptToolCall(first.content, new Set([PROBE_TOOL.name]))
  if (!call || call.name !== PROBE_TOOL.name || call.params.token !== token)
    throw new AgentRepositoryError('CONFORMANCE_TOOL_INVALID', 'Provider did not follow the prompt action protocol', 502)
  const final = await providerChat(provider, {
    chatPrompt: [
      { role: 'system', content: instructions },
      { role: 'user', content: userMessage },
      { role: 'assistant', content: first.content },
      { role: 'user', content: promptToolResultMessage(randomUUID(), call.name, { token, matched: true }) }
    ],
    model: provider.model
  })
  requireText(final, 'Provider returned no final text after the prompt conformance action result')
  if (parsePromptToolCall(final.content, new Set([PROBE_TOOL.name])) !== null)
    throw new AgentRepositoryError('CONFORMANCE_TOOL_INVALID', 'Provider repeated the prompt conformance action', 502)
  return 'prompt-tool-round-trip'
}

export class AgentProviderConformanceRunner {
  readonly #knex: Knex
  readonly #factory: AgentProviderFactory
  readonly #registry: Pick<AgentProviderRegistry, 'setConformed'>

  constructor(knex: Knex, factory: AgentProviderFactory, registry: Pick<AgentProviderRegistry, 'setConformed'>) {
    this.#knex = knex
    this.#factory = factory
    this.#registry = registry
  }

  async run(profileId: string, actorId: number): Promise<AgentProviderConformanceReport> {
    const current = (await this.#knex('agentProviderProfiles').where({ id: profileId }).whereNull('deletedAt').first('currentVersionId')) as
      | { currentVersionId: string | null }
      | undefined
    if (!current?.currentVersionId) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Provider profile was not found', 404)
    const profileVersionId = current.currentVersionId
    const id = randomUUID()
    const startedAt = new Date()
    const checks: AgentProviderConformanceCheck[] = []
    let status: 'passed' | 'failed' = 'failed'
    let failureCode: string | null = null
    try {
      const provider = await this.#factory.create(profileVersionId, { requireConformed: false })
      checks.push({ name: 'profile-load', passed: true })
      await verifyCancellation(provider)
      checks.push({ name: 'pre-dispatch-cancellation', passed: true })
      const response = await providerChat(provider, { chatPrompt: [{ role: 'user', content: 'Reply with a short acknowledgement.' }], model: provider.model })
      checks.push({ name: provider.capabilities.streaming ? 'stream-response' : 'buffered-response', passed: true })
      requireText(response)
      checks.push({ name: 'bounded-text-output', passed: true }, { name: 'declared-usage', passed: true })
      const utilityProvider = await this.#factory.create(profileVersionId, { requireConformed: false, purpose: 'utility' })
      if (utilityProvider.model === provider.model) {
        checks.push({ name: 'utility-model-fallback', passed: true })
      } else {
        requireText(
          await providerChat(utilityProvider, { chatPrompt: [{ role: 'user', content: 'Reply with exactly READY.' }], model: utilityProvider.model }),
          'Utility model conformance returned no text'
        )
        checks.push({ name: 'utility-model-text-output', passed: true })
      }
      checks.push({ name: await verifyToolCalling(provider), passed: true })
      status = 'passed'
    } catch (error) {
      failureCode = errorCode(error)
      checks.push({ name: 'provider-smoke', passed: false, detail: failureDetail(error) })
    }
    const completedAt = new Date()
    await this.#knex('agentProviderConformanceReports').insert({
      id,
      profileVersionId,
      status,
      checks: canonicalJson(checks),
      errorCode: failureCode,
      actorId,
      startedAt,
      completedAt
    })
    await this.#registry.setConformed(profileId, profileVersionId, status === 'passed', actorId)
    const row = await this.#knex<ReportRow>('agentProviderConformanceReports').where({ id }).first()
    if (!row) throw new AgentRepositoryError('CONFORMANCE_REPORT_MISSING', 'Provider conformance report was not persisted', 500)
    return reportView(row)
  }

  async list(profileId: string, limit = 20): Promise<readonly AgentProviderConformanceReport[]> {
    const profile = (await this.#knex('agentProviderProfiles').where({ id: profileId }).whereNull('deletedAt').first('currentVersionId')) as
      | { currentVersionId: string | null }
      | undefined
    if (!profile?.currentVersionId) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Provider profile was not found', 404)
    const rows = await this.#knex<ReportRow>('agentProviderConformanceReports')
      .where({ profileVersionId: profile.currentVersionId })
      .orderBy('completedAt', 'desc')
      .limit(Math.max(1, Math.min(100, limit)))
    return rows.map(reportView)
  }

  async listLatest(profileIds: readonly string[]): Promise<readonly (AgentProviderConformanceReport | null)[]> {
    if (profileIds.length > MAX_LATEST_PROFILE_COUNT)
      throw new AgentRepositoryError(
        'CONFORMANCE_PROFILE_PROJECTION_OVERFLOW',
        `At most ${MAX_LATEST_PROFILE_COUNT} provider profiles can be projected at once`,
        500
      )
    if (profileIds.length === 0) return []

    const uniqueProfileIds = [...new Set(profileIds)]
    const profiles = (await this.#knex('agentProviderProfiles')
      .whereIn('id', uniqueProfileIds)
      .whereNull('deletedAt')
      .whereNotNull('currentVersionId')
      .select('id', 'currentVersionId')) as Array<{ id: string; currentVersionId: string }>
    const versionByProfileId = new Map(profiles.map(profile => [profile.id, profile.currentVersionId]))
    const currentVersionIds = [...new Set(profiles.map(profile => profile.currentVersionId))]
    if (currentVersionIds.length === 0) return profileIds.map(() => null)

    const rankedReports = this.#knex<ReportRow>('agentProviderConformanceReports')
      .whereIn('profileVersionId', currentVersionIds)
      .select('*')
      .rowNumber('reportRank', function rankLatestReport() {
        this.partitionBy('profileVersionId').orderBy('completedAt', 'desc').orderBy('id', 'desc')
      })
    const rows = (await this.#knex.from(rankedReports.as('rankedReports')).where({ reportRank: 1 }).select('*')) as Array<ReportRow & { reportRank: number }>
    const reportByVersionId = new Map(rows.map(row => [row.profileVersionId, reportView(row)]))

    return profileIds.map(profileId => {
      const currentVersionId = versionByProfileId.get(profileId)
      return currentVersionId ? (reportByVersionId.get(currentVersionId) ?? null) : null
    })
  }

  async latest(profileId: string): Promise<AgentProviderConformanceReport | null> {
    return (await this.list(profileId, 1))[0] ?? null
  }
}
