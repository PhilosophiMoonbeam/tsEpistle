import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { AgentCurrentPageHint, AgentEventData, AgentEventType, AgentExecutionMode } from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import {
  AgentRunCoordinator,
  admitAgentRun,
  reconcileAgentRunQuota,
  type AgentQuotaLimits,
  type AgentQuotaRequest,
  type AgentRunClaim,
  type AgentRunRecord
} from './coordinator.ts'
import { AgentRepositoryError } from './repository.ts'
import { decodeAgentMemorySnapshot, type AgentMemorySnapshot } from './memory.ts'
import { SkillRuntime } from './skills/runtime.ts'
import type { AgentConversationTitleGenerator, AgentConversationTitleResult } from './providers/utility.ts'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export interface AgentResolvedAdmission {
  readonly profileResolutionSha256: string
  readonly providerProfileVersionId: string
  readonly transportKind: string
  readonly model: string
  readonly executionMode: AgentExecutionMode
  readonly profilePolicyVersion: number
  readonly defaultGeneration: number
  readonly capabilityRevision: string
  readonly pricingRevision: string
  readonly promptVersion: number
  readonly quota: AgentQuotaRequest
  readonly quotaLimits: AgentQuotaLimits
  readonly reservationMilliseconds: number
}

export interface AgentAdmissionResolver {
  resolve(input: { readonly ownerId: number; readonly sessionId: string; readonly profileResolutionToken: string }): Promise<AgentResolvedAdmission>
}

export interface AgentEngineMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly providerState?: {
    readonly thoughtBlocks: readonly {
      readonly data: string
      readonly encrypted: true
      readonly signature?: string
    }[]
  }
}

export interface AgentEngineSkill {
  readonly id: string
  readonly name: string
  readonly skillMarkdown: string
}

export interface AgentEngineRequest {
  readonly run: AgentRunClaim
  readonly messages: readonly AgentEngineMessage[]
  readonly memory: AgentMemorySnapshot
  readonly currentPage?: AgentCurrentPageHint
  readonly skills: readonly AgentEngineSkill[]
  readonly signal: AbortSignal
}

export interface AgentEngineSink {
  text(delta: string): Promise<void>
  event(type: AgentEventType, data: AgentEventData): Promise<void>
}

export interface AgentEngineResult {
  readonly citations?: readonly Readonly<Record<string, unknown>>[]
  readonly suggestions?: readonly Readonly<Record<string, unknown>>[]
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costMicros: number
  readonly providerState?: Readonly<Record<string, unknown>>
}

export interface AgentEngine {
  execute(request: AgentEngineRequest, sink: AgentEngineSink): Promise<AgentEngineResult>
}

export interface SubmitAgentMessageInput {
  readonly ownerId: number
  readonly sessionId: string
  readonly profileResolutionToken: string
  readonly clientRequestId: string
  readonly expectedSessionVersion: number
  readonly content: string
  readonly invokedSkillVersionIds?: readonly string[]
  readonly currentPage?: Readonly<Record<string, unknown>>
}

export interface AgentProductRuntimeOptions {
  readonly workerId: string
  readonly globalConcurrency: number
  readonly perUserConcurrency: number
  readonly leaseMilliseconds?: number
  readonly heartbeatMilliseconds?: number
  readonly utilityModel?: AgentConversationTitleGenerator
}

interface RuntimeMessageRow { role: 'user' | 'assistant'; content: string; providerStateCiphertext: Uint8Array | null }
interface RuntimeSkillRow { id: string; name: string; skillMarkdown: string }
interface RuntimeContextRow { data: string }
interface RuntimeSessionRow { memorySnapshot: string; title: string; version: number }

const currentPageHint = (value: string | undefined): AgentCurrentPageHint | undefined => {
  if (value === undefined) return undefined
  if (Buffer.byteLength(value, 'utf8') > 16 * 1_024) throw new AgentRepositoryError('AGENT_RUN_CONTEXT_CORRUPT', 'Stored run context is too large', 500)
  try {
    const parsed: unknown = JSON.parse(value)
    const currentPage = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'currentPage') : undefined
    if (currentPage === undefined) return undefined
    if (typeof currentPage !== 'object' || currentPage === null) throw new Error('invalid page context')
    const id = Reflect.get(currentPage, 'id')
    const locale = Reflect.get(currentPage, 'locale')
    const path = Reflect.get(currentPage, 'path')
    const observedUpdatedAt = Reflect.get(currentPage, 'observedUpdatedAt')
    if (!Number.isSafeInteger(id) || id < 1 || typeof locale !== 'string' || locale.length < 1 || locale.length > 16 || typeof path !== 'string' || path.length < 1 || path.length > 1_024 || typeof observedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(observedUpdatedAt))) throw new Error('invalid page context')
    return { id, locale, path, observedUpdatedAt }
  } catch (error) {
    if (error instanceof AgentRepositoryError) throw error
    throw new AgentRepositoryError('AGENT_RUN_CONTEXT_CORRUPT', 'Stored run context is invalid', 500)
  }
}

const nonNegativeUsage = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new AgentRepositoryError('INVALID_AGENT_USAGE', `${label} must be a non-negative safe integer`, 500)
  return value
}

const providerState = (value: Uint8Array | null): AgentEngineMessage['providerState'] => {
  if (value === null) return undefined
  if (value.byteLength > 256 * 1_024) throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation is too large', 500)
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value).toString('utf8'))
    const state = parsed as AgentEngineMessage['providerState']
    if (!state || !Array.isArray(state.thoughtBlocks) || state.thoughtBlocks.some(block => typeof block?.data !== 'string' || block.encrypted !== true || (block.signature !== undefined && typeof block.signature !== 'string'))) throw new Error('invalid state')
    return state
  } catch {
    throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation is invalid', 500)
  }
}

const uniqueSkillVersionsBySkill = async (
  knex: Knex,
  preferredSkillVersionIds: readonly string[],
  invokedSkillVersionIds: readonly string[]
): Promise<readonly string[]> => {
  const orderedVersionIds = [...new Set([...preferredSkillVersionIds, ...invokedSkillVersionIds])]
  if (orderedVersionIds.length === 0) return []
  const rows = await knex('agentSkillVersions')
    .whereIn('id', orderedVersionIds)
    .select('id', 'skillId') as Array<{ id: string, skillId: string }>
  const skillIdByVersionId = new Map(rows.map(row => [row.id, row.skillId]))
  if (skillIdByVersionId.size !== orderedVersionIds.length) {
    throw new AgentRepositoryError('SKILL_SELECTION_CHANGED', 'A selected skill version is no longer available', 409)
  }
  const selectedSkillIds = new Set<string>()
  return orderedVersionIds.filter(versionId => {
    const skillId = skillIdByVersionId.get(versionId)!
    if (selectedSkillIds.has(skillId)) return false
    selectedSkillIds.add(skillId)
    return true
  })
}

export class AgentProductRuntime {
  readonly #knex: Knex
  readonly #resolver: AgentAdmissionResolver
  readonly #engine: AgentEngine
  readonly #coordinator: AgentRunCoordinator
  readonly #skills: SkillRuntime
  readonly #utilityModel: AgentConversationTitleGenerator | undefined

  constructor (knex: Knex, resolver: AgentAdmissionResolver, engine: AgentEngine, options: AgentProductRuntimeOptions) {
    this.#knex = knex
    this.#resolver = resolver
    this.#engine = engine
    this.#coordinator = new AgentRunCoordinator(knex, options)
    this.#skills = new SkillRuntime(knex)
    this.#utilityModel = options.utilityModel
  }

  async submit (input: SubmitAgentMessageInput): Promise<{ readonly run: AgentRunRecord, readonly replayed: boolean }> {
    const resolved = await this.#resolver.resolve({ ownerId: input.ownerId, sessionId: input.sessionId, profileResolutionToken: input.profileResolutionToken })
    if (!Number.isSafeInteger(resolved.reservationMilliseconds) || resolved.reservationMilliseconds < 1) throw new AgentRepositoryError('INVALID_PROFILE_RESOLUTION', 'Quota reservation duration is invalid', 500)
    const preferredSkillVersionIds = await this.#skills.resolvePreferredVersionIdsForUser(input.ownerId)
    const skillVersionIds = await uniqueSkillVersionsBySkill(this.#knex, preferredSkillVersionIds, input.invokedSkillVersionIds ?? [])
    if (skillVersionIds.length > 8) throw new AgentRepositoryError('TOO_MANY_SKILLS', 'A run can use at most 8 skills', 400)
    return admitAgentRun(this.#knex, {
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      clientRequestId: input.clientRequestId,
      expectedSessionVersion: input.expectedSessionVersion,
      content: input.content,
      ...(input.currentPage === undefined ? {} : { currentPage: input.currentPage }),
      ...resolved,
      skillVersionIds,
      reservationExpiresAt: new Date(Date.now() + resolved.reservationMilliseconds)
    })
  }

  async #appendPresentationEvent(claim: AgentRunClaim, type: AgentEventType, data: AgentEventData, messagePatch?: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#knex.transaction(async transaction => {
      const run = await transaction('agentRuns').where({ id: claim.id, ownerId: claim.ownerId, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken }).whereIn('status', ['running', 'awaiting_approval']).whereNull('cancelRequestedAt').forUpdate().first('eventSequence', 'assistantMessageId') as { eventSequence: number, assistantMessageId: string } | undefined
      if (!run) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost while recording output', 409)
      const encoded = canonicalJson(data)
      const sequence = Number(run.eventSequence) + 1
      await transaction('agentEvents').insert({ id: randomUUID(), runId: claim.id, sequence, type, attempt: claim.attempts, schemaVersion: 1, dataSha256: sha256(encoded), data: encoded, createdAt: new Date() })
      if (messagePatch) await transaction('agentMessages').where({ id: run.assistantMessageId, runId: claim.id }).update({ ...messagePatch, updatedAt: new Date() })
      const changed = await transaction('agentRuns').where({ id: claim.id, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken, eventSequence: run.eventSequence }).update({ eventSequence: sequence, updatedAt: new Date() })
      if (changed !== 1) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run event fence changed concurrently', 409)
      if (transaction.client.config.client === 'pg' || transaction.client.config.client === 'postgresql') await transaction.raw("SELECT pg_notify('wiki_agent_events', ?)", [claim.id])
    })
  }

  async #generateConversationTitle(claim: AgentRunClaim, session: RuntimeSessionRow, messages: readonly AgentEngineMessage[], assistantMessage: string, signal: AbortSignal): Promise<AgentConversationTitleResult> {
    const empty = { title: '', inputTokens: 0, outputTokens: 0 }
    const userMessage = messages.find(message => message.role === 'user')?.content
    if (!this.#utilityModel || session.title.trim().length > 0 || !userMessage) return empty
    let generated: AgentConversationTitleResult
    try {
      generated = await this.#utilityModel.generateConversationTitle({
        profileVersionId: claim.providerProfileVersionId,
        userMessage,
        assistantMessage,
        signal
      })
    } catch {
      return empty
    }
    if (generated.title.length > 0) {
      try {
        await this.#knex('agentSessions')
          .where({ id: claim.sessionId, ownerId: claim.ownerId, version: session.version, title: session.title })
          .whereNull('deletedAt')
          .update({
            title: generated.title,
            version: this.#knex.raw('?? + 1', ['version']),
            updatedAt: new Date()
          })
      } catch {
        return generated
      }
    }
    return generated
  }

  async #execute(claim: AgentRunClaim, signal: AbortSignal): Promise<{ status: 'succeeded' | 'failed'; errorCode?: string; errorMessage?: string }> {
    let content = ''
    let quotaReconciled = false
    try {
      const [messageRows, skills, contextRow, sessionRow] = await Promise.all([
        this.#knex('agentMessages').where({ sessionId: claim.sessionId }).andWhere('id', '!=', claim.assistantMessageId).orderBy('ordinal').select('role', 'content', 'providerStateCiphertext') as unknown as Promise<RuntimeMessageRow[]>,
        this.#knex('agentRunSkills').join('agentSkillVersions', 'agentSkillVersions.id', 'agentRunSkills.skillVersionId').join('agentSkills', 'agentSkills.id', 'agentSkillVersions.skillId').where('agentRunSkills.runId', claim.id).orderBy('agentRunSkills.ordinal').select('agentSkillVersions.id', 'agentSkills.name', 'agentSkillVersions.skillMarkdown') as unknown as Promise<RuntimeSkillRow[]>,
        this.#knex('agentEvents').where({ runId: claim.id, type: 'run.queued' }).orderBy('sequence').first('data') as unknown as Promise<RuntimeContextRow | undefined>,
        this.#knex('agentSessions').where({ id: claim.sessionId, ownerId: claim.ownerId }).whereNull('deletedAt').first('memorySnapshot', 'title', 'version') as unknown as Promise<RuntimeSessionRow | undefined>
      ])
      if (!sessionRow) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent session was not found', 404)
      const currentPage = currentPageHint(contextRow?.data)
      const memory = decodeAgentMemorySnapshot(sessionRow.memorySnapshot)
      const messages: AgentEngineMessage[] = messageRows.map(message => {
        const state = providerState(message.providerStateCiphertext)
        return state === undefined
          ? { role: message.role, content: message.content }
          : { role: message.role, content: message.content, providerState: state }
      })
      await this.#appendPresentationEvent(claim, 'run.attemptStarted', { runId: claim.id, attempt: claim.attempts })
      if (claim.attempts > 1) await this.#appendPresentationEvent(claim, 'run.attemptSuperseded', { runId: claim.id, supersededThroughAttempt: claim.attempts - 1 })
      await this.#appendPresentationEvent(claim, 'message.started', { messageId: claim.assistantMessageId }, { status: 'streaming', content: '', citations: null })
      const result = await this.#engine.execute({ run: claim, messages, memory, skills, signal, ...(currentPage === undefined ? {} : { currentPage }) }, {
        text: async delta => {
          if (signal.aborted) throw signal.reason
          if (typeof delta !== 'string' || delta.length === 0 || delta.length > 16_000 || content.length + delta.length > 128_000) throw new AgentRepositoryError('INVALID_ENGINE_DELTA', 'Inference engine emitted an invalid text delta', 500)
          content += delta
          await this.#appendPresentationEvent(claim, 'message.delta', { messageId: claim.assistantMessageId, delta }, { status: 'streaming', content })
        },
        event: async (type, data) => {
          if (signal.aborted) throw signal.reason
          await this.#appendPresentationEvent(claim, type, data)
        }
      })
      if (signal.aborted) throw signal.reason
      const titleUsage = await this.#generateConversationTitle(claim, sessionRow, messages, content, signal)
      const inputTokens = nonNegativeUsage(result.inputTokens + titleUsage.inputTokens, 'Input tokens')
      const outputTokens = nonNegativeUsage(result.outputTokens + titleUsage.outputTokens, 'Output tokens')
      const costMicros = nonNegativeUsage(result.costMicros, 'Cost')
      const citations = result.citations === undefined ? null : canonicalJson(result.citations)
      const providerStateJson = result.providerState === undefined ? null : canonicalJson(result.providerState)
      if (providerStateJson !== null && Buffer.byteLength(providerStateJson, 'utf8') > 256 * 1_024) throw new AgentRepositoryError('AGENT_PROVIDER_STATE_TOO_LARGE', 'Provider continuation exceeds its size limit', 500)
      await this.#appendPresentationEvent(claim, 'message.completed', { messageId: claim.assistantMessageId }, { status: 'complete', content, citations, providerStateCiphertext: providerStateJson === null ? null : Buffer.from(providerStateJson), providerStateSha256: providerStateJson === null ? null : sha256(providerStateJson) })
      if (result.suggestions !== undefined) await this.#appendPresentationEvent(claim, 'suggestions.updated', { suggestions: result.suggestions })
      await this.#appendPresentationEvent(claim, 'usage.updated', { inputTokens, outputTokens, costMicros })
      await this.#knex('agentRuns').where({ id: claim.id, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken }).update({ inputTokens, outputTokens, estimatedCostMicros: costMicros, updatedAt: new Date() })
      await reconcileAgentRunQuota(this.#knex, { runId: claim.id, ownerId: claim.ownerId, consumedTokens: inputTokens + outputTokens, consumedCostMicros: costMicros, status: 'consumed' })
      quotaReconciled = true
      await this.#appendPresentationEvent(claim, 'run.completed', { runId: claim.id, status: 'succeeded' })
      return { status: 'succeeded' }
    } catch (error) {
      let ownsRunningRun = false
      try {
        const owned = await this.#knex('agentRuns')
          .where({ id: claim.id, ownerId: claim.ownerId, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
          .first('status') as { status: string } | undefined
        ownsRunningRun = owned?.status === 'running'
        if (ownsRunningRun && !quotaReconciled) {
          await reconcileAgentRunQuota(this.#knex, { runId: claim.id, ownerId: claim.ownerId, consumedTokens: 0, consumedCostMicros: 0, status: 'released' })
        }
      } catch { /* the retention reconciler owns missing/lost reservations */ }
      if (signal.aborted) throw error
      void error
      if (ownsRunningRun) {
        try { await this.#appendPresentationEvent(claim, 'run.failed', { runId: claim.id, status: 'failed', errorCode: 'AGENT_ENGINE_FAILED' }) } catch { /* the coordinator owns terminal recovery when the lease is already gone */ }
        await this.#knex('agentMessages').where({ id: claim.assistantMessageId, runId: claim.id }).update({ status: 'failed', updatedAt: new Date() })
      }
      return { status: 'failed', errorCode: 'AGENT_ENGINE_FAILED', errorMessage: 'Agent inference failed' }
    }
  }

  runOnce (): Promise<boolean> {
    return this.#coordinator.runOnce((claim, signal) => this.#execute(claim, signal))
  }

  cancel (ownerId: number, runId: string): Promise<AgentRunRecord> {
    return this.#coordinator.cancel(ownerId, runId)
  }

  shutdown (): Promise<void> {
    return this.#coordinator.shutdown()
  }
}
