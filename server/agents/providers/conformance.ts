import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { AxChatResponse } from '@ax-llm/ax'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { AgentRepositoryError } from '../repository.ts'
import { AgentProviderFactory } from './factory.ts'
import type { AgentProviderRegistry } from './registry.ts'

const MAX_SMOKE_OUTPUT = 16_000

export interface AgentProviderConformanceReport {
  readonly id: string
  readonly profileVersionId: string
  readonly status: 'passed' | 'failed'
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[]
  readonly errorCode: string | null
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

const reportView = (row: ReportRow): AgentProviderConformanceReport => ({
  id: row.id,
  profileVersionId: row.profileVersionId,
  status: row.status,
  checks: JSON.parse(row.checks) as AgentProviderConformanceReport['checks'],
  errorCode: row.errorCode,
  startedAt: new Date(row.startedAt).toISOString(),
  completedAt: new Date(row.completedAt).toISOString()
})

const errorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string' && /^[A-Z0-9_.-]{1,128}$/i.test(String(Reflect.get(error, 'code')))) return String(Reflect.get(error, 'code'))
  return 'PROVIDER_CONFORMANCE_FAILED'
}

const consume = async (response: AxChatResponse | ReadableStream<AxChatResponse>): Promise<string> => {
  let output = ''
  const accept = (value: AxChatResponse): void => {
    for (const result of value.results) {
      if (result.functionCalls?.length) throw new AgentRepositoryError('CONFORMANCE_UNEXPECTED_TOOL', 'Provider emitted an unexpected action during conformance', 502)
      if (result.content) output += result.content
      if (output.length > MAX_SMOKE_OUTPUT) throw new AgentRepositoryError('CONFORMANCE_OUTPUT_TOO_LARGE', 'Provider conformance output exceeded its limit', 502)
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
  return output
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

  async run(profileId: string, profileVersionId: string, actorId: number): Promise<AgentProviderConformanceReport> {
    const current = await this.#knex('agentProviderProfiles').where({ id: profileId, currentVersionId: profileVersionId }).first('id')
    if (!current) throw new AgentRepositoryError('PROFILE_VERSION_CHANGED', 'Provider profile version changed before conformance', 409)
    const id = randomUUID()
    const startedAt = new Date()
    const checks: { name: string; passed: boolean }[] = []
    let status: 'passed' | 'failed' = 'failed'
    let failureCode: string | null = null
    try {
      const provider = await this.#factory.create(profileVersionId, { requireConformed: false })
      checks.push({ name: 'profile-load', passed: true })
      const signal = AbortSignal.timeout(30_000)
      const response = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'Reply with a short acknowledgement.' }], model: provider.model }, { stream: provider.capabilities.streaming, abortSignal: signal })
      checks.push({ name: provider.capabilities.streaming ? 'stream-response' : 'buffered-response', passed: true })
      await consume(response)
      checks.push({ name: 'bounded-text-output', passed: true })
      status = 'passed'
    } catch (error) {
      failureCode = errorCode(error)
      checks.push({ name: 'provider-smoke', passed: false })
    }
    const completedAt = new Date()
    await this.#knex('agentProviderConformanceReports').insert({ id, profileVersionId, status, checks: canonicalJson(checks), errorCode: failureCode, actorId, startedAt, completedAt })
    await this.#registry.setConformed(profileId, profileVersionId, status === 'passed', actorId)
    const row = await this.#knex<ReportRow>('agentProviderConformanceReports').where({ id }).first()
    if (!row) throw new AgentRepositoryError('CONFORMANCE_REPORT_MISSING', 'Provider conformance report was not persisted', 500)
    return reportView(row)
  }

  async list(profileVersionId: string, limit = 20): Promise<readonly AgentProviderConformanceReport[]> {
    const rows = await this.#knex<ReportRow>('agentProviderConformanceReports').where({ profileVersionId }).orderBy('completedAt', 'desc').limit(Math.max(1, Math.min(100, limit)))
    return rows.map(reportView)
  }
}
