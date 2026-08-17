import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { AxChatResponse } from '@ax-llm/ax'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { AgentRepositoryError } from '../repository.ts'
import { AgentProviderAttemptError, AgentProviderFactory } from './factory.ts'
import type { AgentProviderRegistry } from './registry.ts'

const MAX_SMOKE_OUTPUT = 16_000

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
  if (typeof value === 'object' && value !== null && typeof Reflect.get(value, 'code') === 'string' && /^[A-Z0-9_.-]{1,128}$/i.test(String(Reflect.get(value, 'code')))) return String(Reflect.get(value, 'code'))
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

const consume = async (response: AxChatResponse | ReadableStream<AxChatResponse>, usageMode: 'stream' | 'terminal' | 'estimated'): Promise<string> => {
  let output = ''
  let usageObserved = false
  const accept = (value: AxChatResponse): void => {
    for (const result of value.results) {
      if (result.functionCalls?.length) throw new AgentRepositoryError('CONFORMANCE_UNEXPECTED_TOOL', 'Provider emitted an unexpected action during conformance', 502)
      if (result.content) output += result.content
      if (output.length > MAX_SMOKE_OUTPUT) throw new AgentRepositoryError('CONFORMANCE_OUTPUT_TOO_LARGE', 'Provider conformance output exceeded its limit', 502)
    }
    const tokens = value.modelUsage?.tokens
    if (tokens) {
      if (![tokens.promptTokens, tokens.completionTokens, tokens.totalTokens].every(token => Number.isSafeInteger(token) && token >= 0) || tokens.totalTokens < tokens.promptTokens + tokens.completionTokens) {
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
    } finally { reader.releaseLock() }
  } else accept(response)
  if (output.trim().length === 0) throw new AgentRepositoryError('CONFORMANCE_EMPTY_OUTPUT', 'Provider conformance returned no text', 502)
  if (usageMode !== 'estimated' && !usageObserved) throw new AgentRepositoryError('CONFORMANCE_USAGE_MISSING', 'Provider conformance did not return its declared usage accounting', 502)
  return output
}

const verifyCancellation = async (provider: Awaited<ReturnType<AgentProviderFactory['create']>>): Promise<void> => {
  if (!provider.capabilities.cancellation) throw new AgentRepositoryError('CONFORMANCE_CANCELLATION_UNDECLARED', 'Provider profile must declare cancellation support', 502)
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

export class AgentProviderConformanceRunner {
  readonly #knex: Knex
  readonly #factory: AgentProviderFactory
  readonly #registry: Pick<AgentProviderRegistry, 'setConformed'>

  constructor (knex: Knex, factory: AgentProviderFactory, registry: Pick<AgentProviderRegistry, 'setConformed'>) {
    this.#knex = knex
    this.#factory = factory
    this.#registry = registry
  }

  async run(profileId: string, actorId: number): Promise<AgentProviderConformanceReport> {
    const current = await this.#knex('agentProviderProfiles').where({ id: profileId }).whereNull('deletedAt').first('currentVersionId') as { currentVersionId: string | null } | undefined
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
      const signal = AbortSignal.timeout(30_000)
      const response = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'Reply with a short acknowledgement.' }], model: provider.model }, { stream: provider.capabilities.streaming, abortSignal: signal })
      checks.push({ name: provider.capabilities.streaming ? 'stream-response' : 'buffered-response', passed: true })
      await consume(response, provider.capabilities.usage)
      checks.push({ name: 'bounded-text-output', passed: true }, { name: 'declared-usage', passed: true })
      status = 'passed'
    } catch (error) {
      failureCode = errorCode(error)
      checks.push({ name: 'provider-smoke', passed: false, detail: failureDetail(error) })
    }
    const completedAt = new Date()
    await this.#knex('agentProviderConformanceReports').insert({ id, profileVersionId, status, checks: canonicalJson(checks), errorCode: failureCode, actorId, startedAt, completedAt })
    await this.#registry.setConformed(profileId, profileVersionId, status === 'passed', actorId)
    const row = await this.#knex<ReportRow>('agentProviderConformanceReports').where({ id }).first()
    if (!row) throw new AgentRepositoryError('CONFORMANCE_REPORT_MISSING', 'Provider conformance report was not persisted', 500)
    return reportView(row)
  }

  async list(profileId: string, limit = 20): Promise<readonly AgentProviderConformanceReport[]> {
    const profile = await this.#knex('agentProviderProfiles').where({ id: profileId }).whereNull('deletedAt').first('currentVersionId') as { currentVersionId: string | null } | undefined
    if (!profile?.currentVersionId) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Provider profile was not found', 404)
    const rows = await this.#knex<ReportRow>('agentProviderConformanceReports').where({ profileVersionId: profile.currentVersionId }).orderBy('completedAt', 'desc').limit(Math.max(1, Math.min(100, limit)))
    return rows.map(reportView)
  }

  async latest(profileId: string): Promise<AgentProviderConformanceReport | null> {
    return (await this.list(profileId, 1))[0] ?? null
  }
}
