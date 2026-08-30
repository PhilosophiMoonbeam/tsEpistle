import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { AgentActionName, AgentCurrentPageHint, AgentEventData, AgentEventType, AgentExecutionMode } from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import {
  AgentRunCoordinator,
  admitAgentRun,
  admitAgentRunInTransaction,
  reconcileAgentRunQuota,
  readAgentApprovalContinuation,
  getOwnedAgentRun,
  type AgentQuotaLimits,
  type AgentQuotaRequest,
  type AgentApprovalContinuationCheckpoint,
  type AgentRunClaim,
  type AgentRunRecord
} from './coordinator.ts'
import { AgentRepositoryError } from './repository.ts'
import {
  DEFAULT_AGENT_GOAL_LIMITS,
  assessAgentRunCompletion,
  emitGoalEvent,
  decodeCompletionAssessment,
  encodedCompletionAssessment,
  getOwnedAgentGoal,
  insertAgentGoal,
  updateGoalStatus,
  type AgentGoalLimits,
  type AgentGoalRecord
} from './goals.ts'
import { decodeAgentMemorySnapshot, type AgentMemorySnapshot } from './memory.ts'
import { SkillRuntime } from './skills/runtime.ts'
import type { AgentConversationTitleGenerator, AgentConversationTitleResult } from './providers/utility.ts'
import {
  AgentChildBudgetReservations,
  SUBAGENT_READ_ACTIONS,
  DEFAULT_AGENT_ORCHESTRATION_LIMITS,
  parseAgentTaskPlan,
  plannerPrompt,
  shouldPlanAgentResearch,
  subagentPrompt,
  validateChildEvidencePacket,
  type AgentChildBudgetReservation,
  type AgentChildBudgetUsage,
  type AgentEvidenceSeed,
  type AgentOrchestrationLimits,
  type AgentResearchSynthesisContext,
  type AgentResearchTask
} from './orchestration.ts'
import {
  cancelAgentRunTasks,
  createAgentRunTasks,
  failAgentRunTask,
  finishAgentRunTask,
  listAgentRunTasks,
  recoverAgentRunTasks,
  startAgentRunTask,
  type AgentTaskRecord
} from './tasks.ts'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

interface AgentUsageTotals {
  inputTokens: number
  outputTokens: number
  costMicros: number
}


interface PersistedResearchEvidence {
  readonly seed: AgentEvidenceSeed
  readonly revisions: ReadonlyMap<string, string>
}

const EMPTY_MEMORY: AgentMemorySnapshot = { agent: [], user: [] }

const researchTask = (task: AgentTaskRecord): AgentResearchTask => ({
  id: task.id,
  kind: task.kind,
  title: task.title,
  question: task.question,
  sourceScope: task.sourceScope,
  requiredEvidenceCount: task.requiredEvidenceCount
})

const persistedResearchEvidence = (
  data: Readonly<Record<string, unknown>>,
  task: AgentTaskRecord
): PersistedResearchEvidence | null => {
  if (task.subagentRunId === null || data.taskId !== task.id || data.subagentRunId !== task.subagentRunId || typeof data.actionCallId !== 'string') return null
  if (data.actionName !== 'pages.get' && data.actionName !== 'pages.getVersion') return null
  if (typeof data.result !== 'string') return null
  let output: unknown
  try {
    output = JSON.parse(data.result)
  } catch {
    return null
  }
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return null
  const page = output as Record<string, unknown>
  if ((typeof page.sourceRevision !== 'string' && typeof page.sourceRevision !== 'number') || typeof page.citation !== 'object' || page.citation === null) return null
  const revision = String(page.sourceRevision)
  const citations = [page.citation, ...(Array.isArray(page.citationSections) ? page.citationSections : [])]
  const revisions = new Map<string, string>()
  for (const citation of citations) {
    if (typeof citation !== 'object' || citation === null) continue
    const evidenceId = Reflect.get(citation, 'evidenceId')
    if (typeof evidenceId === 'string' && evidenceId.length > 0) revisions.set(evidenceId, revision)
  }
  if (revisions.size === 0) return null
  return {
    seed: {
      taskId: task.id,
      subagentRunId: task.subagentRunId,
      actionCallId: data.actionCallId,
      actionName: data.actionName,
      output: page
    },
    revisions
  }
}

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
  resolveCurrent?(input: { readonly ownerId: number, readonly sessionId: string }): Promise<AgentResolvedAdmission>
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
export interface AgentPriorToolActivity {
  readonly actionCallId: string
  readonly actionName: string
  readonly state: 'complete' | 'failed' | 'running'
  readonly input: unknown
  readonly target: Readonly<Record<string, unknown>> | null
  readonly cacheHit: boolean
  readonly duplicateOfActionCallId: string | null
}

export interface AgentPriorRunActivity {
  readonly runId: string
  readonly status: string
  readonly userMessageOrdinal: number
  readonly assistantMessageOrdinal: number
  readonly modelTurns: number
  readonly rejectedEvidenceDrafts: number
  readonly tools: readonly AgentPriorToolActivity[]
}


export interface AgentEngineRequest {
  readonly run: AgentRunClaim
  readonly purpose?: 'root' | 'planner' | 'subagent'
  readonly actionAllowlist?: readonly AgentActionName[]
  readonly task?: AgentResearchTask
  readonly subagentRunId?: string
  readonly research?: AgentResearchSynthesisContext
  readonly limits?: {
    readonly maxTurns: number
    readonly maxToolCalls: number
    readonly maxOutputTokens?: number
  }
  readonly messages: readonly AgentEngineMessage[]
  readonly memory: AgentMemorySnapshot
  readonly currentPage?: AgentCurrentPageHint
  readonly skills: readonly AgentEngineSkill[]
  readonly priorActivity?: readonly AgentPriorRunActivity[]
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
  readonly authoritySha256?: string
}

export interface AgentEngine {
  execute(request: AgentEngineRequest, sink: AgentEngineSink): Promise<AgentEngineResult>
  resumeAction?(request: AgentEngineRequest, checkpoint: AgentApprovalContinuationCheckpoint, sink: AgentEngineSink): Promise<AgentEngineResult>
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
export interface CreateAgentGoalInput {
  readonly goalId: string
  readonly ownerId: number
  readonly sessionId: string
  readonly profileResolutionToken: string
  readonly clientRequestId: string
  readonly expectedSessionVersion: number
  readonly objective: string
  readonly invokedSkillVersionIds?: readonly string[]
  readonly currentPage?: Readonly<Record<string, unknown>>
}

export interface ResumeAgentGoalInput {
  readonly goalId: string
  readonly ownerId: number
  readonly expectedVersion: number
  readonly runId: string
  readonly clientRequestId: string
}

export interface MutateAgentGoalInput {
  readonly goalId: string
  readonly ownerId: number
  readonly expectedVersion: number
}


export interface AgentProductRuntimeOptions {
  readonly workerId: string
  readonly globalConcurrency: number
  readonly perUserConcurrency: number
  readonly leaseMilliseconds?: number
  readonly heartbeatMilliseconds?: number
  readonly utilityModel?: AgentConversationTitleGenerator
  readonly orchestration?: AgentOrchestrationLimits
  readonly goals?: AgentGoalLimits
}

interface RuntimeMessageRow { role: 'user' | 'assistant'; content: string; providerStateCiphertext: Uint8Array | null }
interface RuntimeSkillRow { id: string; name: string; skillMarkdown: string }
interface RuntimeContextRow { data: string }
interface RuntimeSessionRow { memorySnapshot: string; title: string; titleSource: 'none' | 'manual' | 'utility' | 'fallback'; version: number }
interface RuntimePriorEventRow {
  runId: string
  status: string
  userMessageOrdinal: number
  assistantMessageOrdinal: number
  sequence: number
  type: 'model.turn' | 'evidence.provenance' | 'tool.started' | 'tool.completed' | 'tool.failed'
  data: string
}

interface MutablePriorToolActivity {
  actionCallId: string
  actionName: string
  state: 'complete' | 'failed' | 'running'
  input: unknown
  target: Record<string, unknown> | null
  cacheHit: boolean
  duplicateOfActionCallId: string | null
}

const parsedObject = (value: string, code: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new AgentRepositoryError(code, 'Stored agent diagnostic context is invalid', 500)
  }
}

const priorRunActivity = (rows: readonly RuntimePriorEventRow[]): readonly AgentPriorRunActivity[] => {
  const runs = new Map<string, {
    status: string
    userMessageOrdinal: number
    assistantMessageOrdinal: number
    modelTurns: number
    rejectedEvidenceDrafts: number
    tools: MutablePriorToolActivity[]
    toolsById: Map<string, MutablePriorToolActivity>
  }>()
  for (const row of rows) {
    let run = runs.get(row.runId)
    if (!run) {
      run = {
        status: row.status,
        userMessageOrdinal: Number(row.userMessageOrdinal),
        assistantMessageOrdinal: Number(row.assistantMessageOrdinal),
        modelTurns: 0,
        rejectedEvidenceDrafts: 0,
        tools: [],
        toolsById: new Map()
      }
      runs.set(row.runId, run)
    }
    const data = parsedObject(row.data, 'AGENT_PRIOR_ACTIVITY_CORRUPT')
    if (row.type === 'model.turn') {
      run.modelTurns += 1
      continue
    }
    if (row.type === 'evidence.provenance') {
      if (data.accepted === false) run.rejectedEvidenceDrafts += 1
      continue
    }
    const actionCallId = typeof data.actionCallId === 'string' ? data.actionCallId : ''
    if (!actionCallId) continue
    if (row.type === 'tool.started') {
      let input: unknown = null
      if (typeof data.input === 'string') {
        try { input = JSON.parse(data.input) } catch { input = null }
      }
      const tool: MutablePriorToolActivity = {
        actionCallId,
        actionName: typeof data.actionName === 'string' ? data.actionName : 'unknown',
        state: 'running',
        input,
        target: null,
        cacheHit: false,
        duplicateOfActionCallId: null
      }
      run.tools.push(tool)
      run.toolsById.set(actionCallId, tool)
      continue
    }
    const tool = run.toolsById.get(actionCallId)
    if (!tool) continue
    if (row.type === 'tool.failed') {
      tool.state = 'failed'
      continue
    }
    tool.state = 'complete'
    tool.cacheHit = data.cacheHit === true
    tool.duplicateOfActionCallId = typeof data.reusedActionCallId === 'string' ? data.reusedActionCallId : null
    if (typeof data.result === 'string') {
      try {
        const result: unknown = JSON.parse(data.result)
        if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
          const candidate = result as Record<string, unknown>
          tool.target = Object.fromEntries(['id', 'title', 'path', 'sourceRevision'].flatMap(key => candidate[key] === undefined ? [] : [[key, candidate[key]]]))
        }
      } catch { /* diagnostic context remains useful without a target */ }
    }
  }
  return [...runs.entries()].slice(0, 8).map(([runId, run]) => {
    const firstReadByTarget = new Map<string, string>()
    for (const tool of run.tools) {
      if (tool.duplicateOfActionCallId !== null || (tool.actionName !== 'pages.get' && tool.actionName !== 'pages.getVersion')) continue
      const id = tool.target?.id
      const sourceRevision = tool.target?.sourceRevision
      if ((typeof id !== 'number' && typeof id !== 'string') || (typeof sourceRevision !== 'number' && typeof sourceRevision !== 'string')) continue
      const key = `${tool.actionName}:${id}:${sourceRevision}`
      const first = firstReadByTarget.get(key)
      if (first) tool.duplicateOfActionCallId = first
      else firstReadByTarget.set(key, tool.actionCallId)
    }
    return {
      runId,
      status: run.status,
      userMessageOrdinal: run.userMessageOrdinal,
      assistantMessageOrdinal: run.assistantMessageOrdinal,
      modelTurns: run.modelTurns,
      rejectedEvidenceDrafts: run.rejectedEvidenceDrafts,
      tools: run.tools
    }
  })
}


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
  readonly #orchestration: AgentOrchestrationLimits
  readonly #goals: AgentGoalLimits

  constructor (knex: Knex, resolver: AgentAdmissionResolver, engine: AgentEngine, options: AgentProductRuntimeOptions) {
    this.#knex = knex
    this.#resolver = resolver
    this.#engine = engine
    this.#coordinator = new AgentRunCoordinator(knex, options)
    this.#skills = new SkillRuntime(knex)
    this.#utilityModel = options.utilityModel
    this.#orchestration = options.orchestration ?? DEFAULT_AGENT_ORCHESTRATION_LIMITS
    this.#goals = options.goals ?? DEFAULT_AGENT_GOAL_LIMITS
  }

  async #skillVersionIds(ownerId: number, invokedSkillVersionIds: readonly string[]): Promise<readonly string[]> {
    const preferredSkillVersionIds = await this.#skills.resolvePreferredVersionIdsForUser(ownerId)
    const skillVersionIds = await uniqueSkillVersionsBySkill(this.#knex, preferredSkillVersionIds, invokedSkillVersionIds)
    if (skillVersionIds.length > 8) throw new AgentRepositoryError('TOO_MANY_SKILLS', 'A run can use at most 8 skills', 400)
    return skillVersionIds
  }

  #assertResolvedAdmission(resolved: AgentResolvedAdmission): void {
    if (!Number.isSafeInteger(resolved.reservationMilliseconds) || resolved.reservationMilliseconds < 1) {
      throw new AgentRepositoryError('INVALID_PROFILE_RESOLUTION', 'Quota reservation duration is invalid', 500)
    }
  }

  async submit (input: SubmitAgentMessageInput): Promise<{ readonly run: AgentRunRecord, readonly replayed: boolean }> {
    const resolved = await this.#resolver.resolve({ ownerId: input.ownerId, sessionId: input.sessionId, profileResolutionToken: input.profileResolutionToken })
    this.#assertResolvedAdmission(resolved)
    const skillVersionIds = await this.#skillVersionIds(input.ownerId, input.invokedSkillVersionIds ?? [])
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

  async createGoal(input: CreateAgentGoalInput): Promise<{ readonly goal: AgentGoalRecord, readonly run: AgentRunRecord, readonly replayed: boolean }> {
    if (!this.#goals.enabled) throw new AgentRepositoryError('AGENT_GOALS_DISABLED', 'Durable goals are disabled', 404)
    const resolved = await this.#resolver.resolve({ ownerId: input.ownerId, sessionId: input.sessionId, profileResolutionToken: input.profileResolutionToken })
    this.#assertResolvedAdmission(resolved)
    const skillVersionIds = await this.#skillVersionIds(input.ownerId, input.invokedSkillVersionIds ?? [])
    const now = new Date()
    const created = await this.#knex.transaction(async transaction => {
      const goal = await insertAgentGoal(transaction, {
        id: input.goalId,
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        objective: input.objective,
        limits: this.#goals,
        now
      })
      const admitted = await admitAgentRunInTransaction(transaction, {
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
        expectedSessionVersion: input.expectedSessionVersion,
        content: goal.objective,
        ...(input.currentPage === undefined ? {} : { currentPage: input.currentPage }),
        ...resolved,
        goalId: goal.id,
        goalContinuation: 0,
        userMessageVisible: true,
        skillVersionIds,
        reservationExpiresAt: new Date(now.valueOf() + resolved.reservationMilliseconds),
        now
      })
      return { goal, ...admitted }
    })
    if (!created.replayed) await emitGoalEvent(this.#knex, { goal: created.goal, run: created.run, type: 'goal.created' })
    return created
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
    const empty: AgentConversationTitleResult = { title: '', source: 'fallback', inputTokens: 0, outputTokens: 0 }
    const titleMessages = [
      ...messages.map(message => ({ role: message.role, content: message.content })),
      { role: 'assistant' as const, content: assistantMessage }
    ]
    const userTurnCount = titleMessages.filter(message => message.role === 'user').length
    const titleMayBeGenerated = session.titleSource === 'none' ||
      ((session.titleSource === 'utility' || session.titleSource === 'fallback') && userTurnCount <= 2)
    if (!this.#utilityModel || !titleMayBeGenerated || userTurnCount < 1) return empty
    let generated: AgentConversationTitleResult
    try {
      generated = await this.#utilityModel.generateConversationTitle({
        profileVersionId: claim.providerProfileVersionId,
        messages: titleMessages,
        signal
      })
    } catch {
      return empty
    }
    if (generated.title.length > 0) {
      try {
        await this.#knex('agentSessions')
          .where({ id: claim.sessionId, ownerId: claim.ownerId, version: session.version, title: session.title, titleSource: session.titleSource })
          .whereNull('deletedAt')
          .update({
            title: generated.title,
            titleSource: generated.source,
            version: this.#knex.raw('?? + 1', ['version']),
            updatedAt: new Date()
          })
      } catch {
        return generated
      }
    }
    return generated
  }

  async #planResearch(claim: AgentRunClaim, userRequest: string, signal: AbortSignal): Promise<{ readonly tasks: readonly AgentTaskRecord[], readonly usage: AgentUsageTotals }> {
    let content = ''
    let result: AgentEngineResult
    const plannerSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#orchestration.plannerTimeoutMilliseconds)])
    try {
      result = await this.#engine.execute({
        run: claim,
        purpose: 'planner',
        actionAllowlist: [],
        limits: {
          maxTurns: this.#orchestration.plannerTurns,
          maxToolCalls: 0,
          maxOutputTokens: this.#orchestration.plannerMaxOutputTokens
        },
        messages: [{ role: 'user', content: plannerPrompt(userRequest, this.#orchestration.maxChildren) }],
        memory: EMPTY_MEMORY,
        skills: [],
        priorActivity: [],
        signal: plannerSignal
      }, {
        text: async delta => {
          if (plannerSignal.aborted) throw plannerSignal.reason
          if (typeof delta !== 'string' || delta.length === 0 || content.length + delta.length > 32_000) throw new AgentRepositoryError('AGENT_TASK_PLAN_INVALID', 'Task planner output is invalid', 409)
          content += delta
        },
        event: async () => {}
      })
    } catch (error) {
      if (signal.aborted) throw error
      return { tasks: [], usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 } }
    }
    const usage = {
      inputTokens: nonNegativeUsage(result.inputTokens, 'Planner input tokens'),
      outputTokens: nonNegativeUsage(result.outputTokens, 'Planner output tokens'),
      costMicros: nonNegativeUsage(result.costMicros, 'Planner cost')
    }
    let plan
    try {
      plan = parseAgentTaskPlan(content, this.#orchestration.maxChildren)
    } catch {
      await this.#appendPresentationEvent(claim, 'task.planCreated', {
        rootRunId: claim.id,
        accepted: false,
        taskCount: 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicros: usage.costMicros
      })
      return { tasks: [], usage }
    }
    return {
      tasks: await createAgentRunTasks(this.#knex, claim, plan.map(task => ({ id: randomUUID(), ...task })), usage),
      usage
    }
  }

  async #orchestrationTelemetry(claim: AgentRunClaim): Promise<{ readonly usage: AgentUsageTotals, readonly modelUsage: AgentUsageTotals, readonly budget: AgentChildBudgetUsage }> {
    const rows = await this.#knex('agentEvents')
      .where({ runId: claim.id })
      .whereIn('type', ['task.planCreated', 'model.turn'])
      .orderBy('sequence')
      .select('type', 'data', 'dataSha256') as Array<{ type: 'task.planCreated' | 'model.turn', data: string, dataSha256: string }>
    const usage: AgentUsageTotals = { inputTokens: 0, outputTokens: 0, costMicros: 0 }
    const modelUsage: AgentUsageTotals = { inputTokens: 0, outputTokens: 0, costMicros: 0 }
    let consumedOutputCharacters = 0
    let consumedTokens = 0
    for (const row of rows) {
      if (sha256(row.data) !== row.dataSha256) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored orchestration event hash is invalid', 500)
      let data: unknown
      try {
        data = JSON.parse(row.data)
      } catch {
        throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored orchestration event is invalid', 500)
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored orchestration event data is invalid', 500)
      const inputTokens = nonNegativeUsage(Number(Reflect.get(data, 'inputTokens')), 'Orchestration input tokens')
      const outputTokens = nonNegativeUsage(Number(Reflect.get(data, 'outputTokens')), 'Orchestration output tokens')
      if (row.type === 'task.planCreated') {
        usage.inputTokens += inputTokens
        usage.outputTokens += outputTokens
        usage.costMicros += nonNegativeUsage(Number(Reflect.get(data, 'costMicros')), 'Orchestration cost')
        continue
      }
      if (typeof Reflect.get(data, 'taskId') !== 'string' || typeof Reflect.get(data, 'subagentRunId') !== 'string') {
        modelUsage.inputTokens += inputTokens
        modelUsage.outputTokens += outputTokens
        continue
      }
      usage.inputTokens += inputTokens
      usage.outputTokens += outputTokens
      consumedTokens += inputTokens + outputTokens
      const turnContent = Reflect.get(data, 'content')
      if (typeof turnContent !== 'string') throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored subagent output telemetry is invalid', 500)
      const accountedOutputCharacters = Reflect.get(data, 'budgetOutputCharacters')
      consumedOutputCharacters += Reflect.get(data, 'contentTruncated') === true
        ? accountedOutputCharacters === undefined
          ? this.#orchestration.maxAggregateChildOutputCharacters + 1
          : nonNegativeUsage(Number(accountedOutputCharacters), 'Subagent output characters')
        : turnContent.length
    }
    const budget: AgentChildBudgetUsage = { outputCharacters: consumedOutputCharacters, tokens: consumedTokens }
    return { usage, modelUsage, budget }
  }

  async #executeResearchTask(
    claim: AgentRunClaim,
    task: AgentTaskRecord,
    memory: AgentMemorySnapshot,
    skills: readonly RuntimeSkillRow[],
    currentPage: AgentCurrentPageHint | undefined,
    reservations: AgentChildBudgetReservations,
    reservation: AgentChildBudgetReservation,
    signal: AbortSignal
  ): Promise<AgentUsageTotals> {
    const subagentRunId = randomUUID()
    const childSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#orchestration.childTimeoutMilliseconds)])
    let activeTask: AgentTaskRecord | undefined
    let content = ''
    let usage: AgentUsageTotals = { inputTokens: 0, outputTokens: 0, costMicros: 0 }
    const consumed = { outputCharacters: 0, tokens: 0 }
    const evidenceRevisions = new Map<string, string>()
    try {
      const startedTask = await startAgentRunTask(this.#knex, claim, task.id, subagentRunId)
      activeTask = startedTask
      const result = await this.#engine.execute({
        run: claim,
        purpose: 'subagent',
        task: researchTask(startedTask),
        subagentRunId,
        actionAllowlist: SUBAGENT_READ_ACTIONS,
        limits: {
          maxTurns: this.#orchestration.childTurns,
          maxToolCalls: this.#orchestration.childToolCalls,
          maxOutputTokens: reservation.outputTokens
        },
        messages: [{ role: 'user', content: subagentPrompt(startedTask) }],
        memory,
        skills,
        priorActivity: [],
        signal: childSignal,
        ...(currentPage === undefined ? {} : { currentPage })
      }, {
        text: async delta => {
          if (childSignal.aborted) throw childSignal.reason
          if (typeof delta !== 'string' || delta.length === 0 || content.length + delta.length > reservation.outputCharacters) throw new AgentRepositoryError('AGENT_CHILD_BUDGET_EXCEEDED', 'Subagent output exceeded its reserved allowance', 409)
          content += delta
        },
        event: async (type, data) => {
          if (childSignal.aborted) throw childSignal.reason
          const contextualData = { ...data, rootRunId: claim.id, taskId: task.id, subagentRunId }
          if (type === 'model.turn') {
            consumed.tokens += nonNegativeUsage(Number(Reflect.get(data, 'inputTokens')), 'Subagent input tokens') +
              nonNegativeUsage(Number(Reflect.get(data, 'outputTokens')), 'Subagent output tokens')
            const turnContent = Reflect.get(data, 'content')
            if (typeof turnContent !== 'string') throw new AgentRepositoryError('AGENT_CHILD_BUDGET_INVALID', 'Subagent output telemetry is invalid', 500)
            const turnOutputCharacters = Reflect.get(data, 'contentTruncated') === true
              ? reservation.outputCharacters + 1
              : turnContent.length
            const remainingOutputCharacters = reservation.outputCharacters - consumed.outputCharacters
            if (turnOutputCharacters > remainingOutputCharacters) {
              consumed.outputCharacters = reservation.outputCharacters
              await this.#appendPresentationEvent(claim, type, {
                ...contextualData,
                content: turnContent.slice(0, Math.max(0, remainingOutputCharacters)),
                contentTruncated: true,
                budgetOutputCharacters: Math.max(0, remainingOutputCharacters)
              })
              throw new AgentRepositoryError('AGENT_CHILD_BUDGET_EXCEEDED', 'Subagent output exceeded its reserved allowance', 409)
            }
            consumed.outputCharacters += turnOutputCharacters
          }
          if (type === 'tool.completed') {
            const evidence = persistedResearchEvidence(contextualData, startedTask)
            if (evidence !== null) {
              for (const [evidenceId, revision] of evidence.revisions) evidenceRevisions.set(evidenceId, revision)
            }
          }
          await this.#appendPresentationEvent(claim, type, contextualData)
        }
      })
      usage = {
        inputTokens: nonNegativeUsage(result.inputTokens, 'Subagent input tokens'),
        outputTokens: nonNegativeUsage(result.outputTokens, 'Subagent output tokens'),
        costMicros: nonNegativeUsage(result.costMicros, 'Subagent cost')
      }
      consumed.tokens = Math.max(consumed.tokens, usage.inputTokens + usage.outputTokens)
      consumed.outputCharacters = Math.max(consumed.outputCharacters, content.length)
      if (consumed.outputCharacters > reservation.outputCharacters) throw new AgentRepositoryError('AGENT_CHILD_BUDGET_EXCEEDED', 'Subagent output exceeded its reserved allowance', 409)
      const validated = validateChildEvidencePacket(content, researchTask(startedTask), evidenceRevisions)
      await finishAgentRunTask(this.#knex, claim, startedTask.id, subagentRunId, validated, result.authoritySha256 ?? null)
      return usage
    } catch (error) {
      if (signal.aborted) throw error
      if (activeTask === undefined) throw error
      const errorCode = childSignal.aborted
        ? 'SUBAGENT_TIMEOUT'
        : typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string'
          ? String(Reflect.get(error, 'code')).slice(0, 64)
          : 'SUBAGENT_FAILED'
      try {
        await failAgentRunTask(this.#knex, claim, activeTask.id, subagentRunId, errorCode)
      } catch (taskError) {
        if (typeof taskError === 'object' && taskError !== null && Reflect.get(taskError, 'code') !== 'AGENT_TASK_STATE_CHANGED') throw taskError
      }
      return usage
    } finally {
      reservations.release(reservation, consumed)
    }
  }

  async #executeResearchTasks(
    claim: AgentRunClaim,
    tasks: readonly AgentTaskRecord[],
    memory: AgentMemorySnapshot,
    skills: readonly RuntimeSkillRow[],
    currentPage: AgentCurrentPageHint | undefined,
    budget: AgentChildBudgetUsage,
    signal: AbortSignal
  ): Promise<AgentUsageTotals> {
    const pending = tasks.filter(task => task.status === 'pending')
    const totals: AgentUsageTotals = { inputTokens: 0, outputTokens: 0, costMicros: 0 }
    if (pending.length === 0) return totals
    const reservations = new AgentChildBudgetReservations(this.#orchestration, budget)
    const concurrency = Math.min(this.#orchestration.maxConcurrentChildren, pending.length)
    let cursor = 0
    while (cursor < pending.length) {
      const batch: Array<{ readonly task: AgentTaskRecord, readonly reservation: AgentChildBudgetReservation }> = []
      while (batch.length < concurrency) {
        const task = pending[cursor]
        if (!task) break
        const reservation = reservations.reserve()
        if (reservation === null) break
        batch.push({ task, reservation })
        cursor += 1
      }
      if (batch.length === 0) {
        for (; cursor < pending.length; cursor += 1) {
          const task = pending[cursor]
          if (!task) continue
          const subagentRunId = randomUUID()
          await startAgentRunTask(this.#knex, claim, task.id, subagentRunId)
          await failAgentRunTask(this.#knex, claim, task.id, subagentRunId, 'AGENT_CHILD_BUDGET_EXCEEDED')
        }
        break
      }
      const usages = await Promise.all(batch.map(({ task, reservation }) =>
        this.#executeResearchTask(claim, task, memory, skills, currentPage, reservations, reservation, signal)
      ))
      for (const taskUsage of usages) {
        totals.inputTokens += taskUsage.inputTokens
        totals.outputTokens += taskUsage.outputTokens
        totals.costMicros += taskUsage.costMicros
      }
    }
    return totals
  }

  async #researchContext(claim: AgentRunClaim, tasks: readonly AgentTaskRecord[]): Promise<AgentResearchSynthesisContext> {
    const eventRows = await this.#knex('agentEvents')
      .where({ runId: claim.id, type: 'tool.completed' })
      .orderBy('sequence')
      .select('data', 'dataSha256') as Array<{ data: string, dataSha256: string }>
    const taskById = new Map(tasks.map(task => [task.id, task]))
    const evidenceSeeds: AgentEvidenceSeed[] = []
    const evidenceByTask = new Map<string, Map<string, string>>()
    for (const row of eventRows) {
      if (sha256(row.data) !== row.dataSha256) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored subagent evidence event hash is invalid', 500)
      let data: unknown
      try {
        data = JSON.parse(row.data)
      } catch {
        throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored subagent evidence event is invalid', 500)
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
      const task = typeof Reflect.get(data, 'taskId') === 'string' ? taskById.get(String(Reflect.get(data, 'taskId'))) : undefined
      if (!task) continue
      const evidence = persistedResearchEvidence(data as Readonly<Record<string, unknown>>, task)
      if (evidence === null) continue
      evidenceSeeds.push(evidence.seed)
      const revisions = evidenceByTask.get(task.id) ?? new Map<string, string>()
      for (const [evidenceId, revision] of evidence.revisions) revisions.set(evidenceId, revision)
      evidenceByTask.set(task.id, revisions)
    }
    const packets = tasks.flatMap(task => {
      if (task.packet === null) return []
      const validated = validateChildEvidencePacket(canonicalJson(task.packet), researchTask(task), evidenceByTask.get(task.id) ?? new Map())
      return [{
        task: researchTask(task),
        packet: validated.packet,
        evidenceIds: validated.evidenceIds,
        conflictEvidenceGroups: validated.conflictEvidenceGroups
      }]
    })
    const incompleteTasks = tasks.flatMap(task => task.status === 'blocked' || task.status === 'failed' || task.status === 'cancelled'
      ? [{
          taskId: task.id,
          title: task.title,
          status: task.status,
          outcome: task.outcome,
          errorCode: task.errorCode
        }]
      : [])
    return { packets, incompleteTasks, evidenceSeeds }
  }

  async #execute(claim: AgentRunClaim, signal: AbortSignal): Promise<{ status: 'succeeded' | 'partial' | 'failed'; errorCode?: string; errorMessage?: string }> {
    let content = ''
    let quotaReconciled = false
    const orchestrationUsage: AgentUsageTotals = { inputTokens: 0, outputTokens: 0, costMicros: 0 }
    try {
      const [messageRows, skills, contextRow, sessionRow, priorEventRows] = await Promise.all([
        this.#knex('agentMessages').where({ sessionId: claim.sessionId }).andWhere('id', '!=', claim.assistantMessageId).orderBy('ordinal').select('role', 'content', 'providerStateCiphertext') as unknown as Promise<RuntimeMessageRow[]>,
        this.#knex('agentRunSkills').join('agentSkillVersions', 'agentSkillVersions.id', 'agentRunSkills.skillVersionId').join('agentSkills', 'agentSkills.id', 'agentSkillVersions.skillId').where('agentRunSkills.runId', claim.id).orderBy('agentRunSkills.ordinal').select('agentSkillVersions.id', 'agentSkills.name', 'agentSkillVersions.skillMarkdown') as unknown as Promise<RuntimeSkillRow[]>,
        this.#knex('agentEvents').where({ runId: claim.id, type: 'run.queued' }).orderBy('sequence').first('data') as unknown as Promise<RuntimeContextRow | undefined>,
        this.#knex('agentSessions').where({ id: claim.sessionId, ownerId: claim.ownerId }).whereNull('deletedAt').first('memorySnapshot', 'title', 'titleSource', 'version') as unknown as Promise<RuntimeSessionRow | undefined>,
        this.#knex('agentRuns as runs')
          .join('agentMessages as userMessages', 'userMessages.id', 'runs.userMessageId')
          .join('agentMessages as assistantMessages', 'assistantMessages.id', 'runs.assistantMessageId')
          .join('agentEvents as events', 'events.runId', 'runs.id')
          .where('runs.sessionId', claim.sessionId)
          .andWhere('runs.id', '!=', claim.id)
          .whereIn('events.type', ['model.turn', 'evidence.provenance', 'tool.started', 'tool.completed', 'tool.failed'])
          .orderBy('runs.queuedAt', 'desc')
          .orderBy('events.sequence')
          .limit(256)
          .select({
            runId: 'runs.id',
            status: 'runs.status',
            userMessageOrdinal: 'userMessages.ordinal',
            assistantMessageOrdinal: 'assistantMessages.ordinal',
            sequence: 'events.sequence',
            type: 'events.type',
            data: 'events.data'
          }) as unknown as Promise<RuntimePriorEventRow[]>
      ])
      if (!sessionRow) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent session was not found', 404)
      const currentPage = currentPageHint(contextRow?.data)
      const memory = decodeAgentMemorySnapshot(sessionRow.memorySnapshot)
      const priorActivity = priorRunActivity(priorEventRows)
      const messages: AgentEngineMessage[] = messageRows.map(message => {
        const state = providerState(message.providerStateCiphertext)
        return state === undefined
          ? { role: message.role, content: message.content }
          : { role: message.role, content: message.content, providerState: state }
      })
      const continuation = await readAgentApprovalContinuation(this.#knex, claim)
      if (claim.status === 'awaiting_approval' && continuation === null) {
        throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_MISSING', 'Awaiting approval run has no durable action continuation', 500)
      }
      if (continuation === null) {
        await this.#appendPresentationEvent(claim, 'run.attemptStarted', { runId: claim.id, attempt: claim.attempts })
        if (claim.attempts > 1) await this.#appendPresentationEvent(claim, 'run.attemptSuperseded', { runId: claim.id, supersededThroughAttempt: claim.attempts - 1 })
        await this.#appendPresentationEvent(claim, 'message.started', { messageId: claim.assistantMessageId }, { status: 'streaming', content: '', citations: null })
        await recoverAgentRunTasks(this.#knex, claim)
      }
      let tasks = await listAgentRunTasks(this.#knex, claim.id)
      if (continuation === null) {
        if ((!this.#orchestration.enabled || claim.executionMode !== 'agent') && tasks.some(task => task.status === 'pending' || task.status === 'running')) {
          await cancelAgentRunTasks(this.#knex, claim, 'ORCHESTRATION_DISABLED', 'Subagent orchestration is disabled')
          tasks = await listAgentRunTasks(this.#knex, claim.id)
        }
        const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')?.content ?? ''
        if (this.#orchestration.enabled && claim.executionMode === 'agent' && tasks.length === 0 && shouldPlanAgentResearch(latestUserMessage)) {
          tasks = (await this.#planResearch(claim, latestUserMessage, signal)).tasks
        }
      }
      let orchestrationTelemetry = await this.#orchestrationTelemetry(claim)
      if (continuation === null && this.#orchestration.enabled && claim.executionMode === 'agent' && tasks.some(task => task.status === 'pending')) {
        await this.#executeResearchTasks(claim, tasks, memory, skills, currentPage, orchestrationTelemetry.budget, signal)
        tasks = await listAgentRunTasks(this.#knex, claim.id)
        orchestrationTelemetry = await this.#orchestrationTelemetry(claim)
      }
      orchestrationUsage.inputTokens = orchestrationTelemetry.usage.inputTokens
      orchestrationUsage.outputTokens = orchestrationTelemetry.usage.outputTokens
      orchestrationUsage.costMicros = orchestrationTelemetry.usage.costMicros
      const research = tasks.length === 0 ? undefined : await this.#researchContext(claim, tasks)
      const engineRequest: AgentEngineRequest = {
        run: claim,
        purpose: 'root',
        messages,
        memory,
        skills,
        priorActivity,
        signal,
        ...(research === undefined ? {} : { research }),
        ...(currentPage === undefined ? {} : { currentPage })
      }
      const sink: AgentEngineSink = {
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
      }
      const result = continuation === null
        ? await this.#engine.execute(engineRequest, sink)
        : await (this.#engine.resumeAction?.(engineRequest, continuation, sink) ?? Promise.reject(new AgentRepositoryError('AGENT_ACTION_CONTINUATION_UNSUPPORTED', 'Inference engine cannot resume durable action continuations', 500)))
      if (signal.aborted) throw signal.reason
      orchestrationTelemetry = await this.#orchestrationTelemetry(claim)
      orchestrationUsage.inputTokens = orchestrationTelemetry.usage.inputTokens
      orchestrationUsage.outputTokens = orchestrationTelemetry.usage.outputTokens
      orchestrationUsage.costMicros = orchestrationTelemetry.usage.costMicros
      const modelUsage = {
        inputTokens: Math.max(orchestrationTelemetry.modelUsage.inputTokens, nonNegativeUsage(result.inputTokens, 'Model input tokens')),
        outputTokens: Math.max(orchestrationTelemetry.modelUsage.outputTokens, nonNegativeUsage(result.outputTokens, 'Model output tokens')),
        costMicros: nonNegativeUsage(result.costMicros, 'Model cost')
      }
      const titleUsage = continuation === null
        ? await this.#generateConversationTitle(claim, sessionRow, messages, content, signal)
        : { title: '', source: 'fallback' as const, inputTokens: 0, outputTokens: 0 }
      const inputTokens = nonNegativeUsage(modelUsage.inputTokens + titleUsage.inputTokens + orchestrationUsage.inputTokens, 'Input tokens')
      const outputTokens = nonNegativeUsage(modelUsage.outputTokens + titleUsage.outputTokens + orchestrationUsage.outputTokens, 'Output tokens')
      const costMicros = nonNegativeUsage(modelUsage.costMicros + orchestrationUsage.costMicros, 'Cost')
      const citations = result.citations === undefined ? null : canonicalJson(result.citations)
      const providerStateJson = result.providerState === undefined ? null : canonicalJson(result.providerState)
      if (providerStateJson !== null && Buffer.byteLength(providerStateJson, 'utf8') > 256 * 1_024) throw new AgentRepositoryError('AGENT_PROVIDER_STATE_TOO_LARGE', 'Provider continuation exceeds its size limit', 500)
      await this.#appendPresentationEvent(claim, 'message.completed', { messageId: claim.assistantMessageId }, { status: 'complete', content, citations, providerStateCiphertext: providerStateJson === null ? null : Buffer.from(providerStateJson), providerStateSha256: providerStateJson === null ? null : sha256(providerStateJson) })
      if (result.suggestions !== undefined) await this.#appendPresentationEvent(claim, 'suggestions.updated', { suggestions: result.suggestions })
      await this.#appendPresentationEvent(claim, 'usage.updated', {
        inputTokens,
        outputTokens,
        costMicros,
        model: modelUsage,
        orchestration: { ...orchestrationUsage, taskCount: tasks.length },
        utility: { inputTokens: titleUsage.inputTokens, outputTokens: titleUsage.outputTokens, purpose: 'conversation_title' }
      })
      await this.#knex('agentRuns').where({ id: claim.id, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken }).update({ inputTokens, outputTokens, estimatedCostMicros: costMicros, updatedAt: new Date() })
      await reconcileAgentRunQuota(this.#knex, { runId: claim.id, ownerId: claim.ownerId, consumedTokens: inputTokens + outputTokens, consumedCostMicros: costMicros, status: 'consumed' })
      quotaReconciled = true
      const pendingProposal = await this.#knex('agentProposals')
        .where({ runId: claim.id })
        .whereIn('status', ['pending', 'approved', 'applying'])
        .count<{ count: number | string }[]>({ count: '*' })
        .first()
      const completion = assessAgentRunCompletion({
        tasks,
        pendingProposalCount: Number(pendingProposal?.count ?? 0),
        evidenceGatePassed: true,
        usageReconciled: quotaReconciled
      })
      const encodedCompletion = encodedCompletionAssessment(completion)
      await this.#knex('agentRuns')
        .where({ id: claim.id, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
        .update({
          completionOutcome: completion.outcome,
          completionAssessment: encodedCompletion.encoded,
          completionAssessmentSha256: encodedCompletion.sha256,
          updatedAt: new Date()
        })
      await this.#appendPresentationEvent(claim, 'run.completionAssessed', {
        runId: claim.id,
        outcome: completion.outcome,
        issueCodes: completion.issues.map(issue => issue.code)
      })
      const partial = completion.outcome !== 'complete'
      await this.#appendPresentationEvent(claim, partial ? 'run.partial' : 'run.completed', { runId: claim.id, status: partial ? 'partial' : 'succeeded' })
      return { status: partial ? 'partial' : 'succeeded' }
    } catch (error) {
      if (signal.aborted) {
        try { await cancelAgentRunTasks(this.#knex, claim) } catch { /* coordinator cancellation remains authoritative */ }
      }
      let ownsRunningRun = false
      try {
        const owned = await this.#knex('agentRuns')
          .where({ id: claim.id, ownerId: claim.ownerId, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
          .first('status') as { status: string } | undefined
        ownsRunningRun = owned?.status === 'running'
        if (ownsRunningRun && !quotaReconciled) {
          const telemetry = await this.#orchestrationTelemetry(claim)
          const consumedTokens = telemetry.usage.inputTokens + telemetry.usage.outputTokens + telemetry.modelUsage.inputTokens + telemetry.modelUsage.outputTokens
          const consumedCostMicros = telemetry.usage.costMicros + telemetry.modelUsage.costMicros
          await reconcileAgentRunQuota(this.#knex, {
            runId: claim.id,
            ownerId: claim.ownerId,
            consumedTokens,
            consumedCostMicros,
            status: consumedTokens > 0 || consumedCostMicros > 0 ? 'consumed' : 'released'
          })
        }
      } catch { /* the retention reconciler owns missing/lost reservations */ }
      if (signal.aborted) throw error
      if (ownsRunningRun) {
        try { await this.#appendPresentationEvent(claim, 'run.failed', { runId: claim.id, status: 'failed', errorCode: 'AGENT_ENGINE_FAILED' }) } catch { /* the coordinator owns terminal recovery when the lease is already gone */ }
        await this.#knex('agentMessages').where({ id: claim.assistantMessageId, runId: claim.id }).update({ status: 'failed', updatedAt: new Date() })
      }
      return { status: 'failed', errorCode: 'AGENT_ENGINE_FAILED', errorMessage: 'Agent inference failed' }
    }
  }
  async #goalUsage(goalId: string): Promise<{ readonly tokens: number, readonly toolCalls: number }> {
    const runs = await this.#knex('agentRuns').where({ goalId }).select('id', 'inputTokens', 'outputTokens') as Array<{ id: string, inputTokens: number | string, outputTokens: number | string }>
    const runIds = runs.map(run => run.id)
    const toolCalls = runIds.length === 0
      ? 0
      : Number((await this.#knex('agentEvents').whereIn('runId', runIds).where({ type: 'tool.started' }).count<{ count: number | string }[]>({ count: '*' }).first())?.count ?? 0)
    return {
      tokens: runs.reduce((total, run) => total + Number(run.inputTokens) + Number(run.outputTokens), 0),
      toolCalls
    }
  }
  async #emitLatestGoalStatus(goal: AgentGoalRecord): Promise<void> {
    const run = await this.#knex('agentRuns').where({ goalId: goal.id, ownerId: goal.ownerId }).orderBy('goalContinuation', 'desc').first('id', 'attempts') as { id: string, attempts: number } | undefined
    if (run) await emitGoalEvent(this.#knex, { goal, run, type: 'goal.status' })
  }


  async #continueGoal(
    goal: AgentGoalRecord,
    input: { readonly expectedVersion?: number, readonly runId?: string, readonly clientRequestId?: string, readonly automatic: boolean }
  ): Promise<{ readonly goal: AgentGoalRecord, readonly run: AgentRunRecord | null, readonly replayed: boolean }> {
    if (!this.#goals.enabled) throw new AgentRepositoryError('AGENT_GOALS_DISABLED', 'Durable goals are disabled', 404)
    if (input.runId) {
      const existing = await this.#knex('agentRuns').where({ id: input.runId, ownerId: goal.ownerId, goalId: goal.id }).first('id', 'clientRequestId')
      if (existing) {
        if (existing.clientRequestId !== input.clientRequestId) throw new AgentRepositoryError('RUN_IDEMPOTENCY_MISMATCH', 'Run ID was reused with different input', 409)
        return { goal: await getOwnedAgentGoal(this.#knex, goal.ownerId, goal.id), run: await getOwnedAgentRun(this.#knex, goal.ownerId, existing.id), replayed: true }
      }
    }
    const fresh = await getOwnedAgentGoal(this.#knex, goal.ownerId, goal.id)
    if (input.expectedVersion !== undefined && fresh.version !== input.expectedVersion) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
    const allowed = input.automatic ? fresh.status === 'active' : fresh.status === 'paused' || fresh.status === 'blocked'
    if (!allowed) throw new AgentRepositoryError('INVALID_GOAL_TRANSITION', 'Agent goal cannot continue from its current state', 409)
    const usage = await this.#goalUsage(fresh.id)
    const limitReached = fresh.continuationCount >= fresh.maxContinuations ||
      usage.tokens >= fresh.maxTokens ||
      usage.toolCalls >= fresh.maxToolCalls ||
      new Date(fresh.deadlineAt).valueOf() <= Date.now()
    if (limitReached) {
      const limited = await updateGoalStatus(this.#knex, {
        ownerId: fresh.ownerId,
        goalId: fresh.id,
        expectedVersion: fresh.version,
        from: [fresh.status],
        to: 'budget_limited',
        completion: fresh.completion ?? { outcome: 'partial', issues: [{ code: 'GOAL_BUDGET_LIMITED', message: 'The goal reached its host-owned continuation budget.', retryable: false }] },
        consumedTokens: usage.tokens,
        consumedToolCalls: usage.toolCalls,
        errorCode: 'GOAL_BUDGET_LIMITED',
        errorMessage: 'Goal continuation budget was exhausted'
      })
      await this.#emitLatestGoalStatus(limited)
      return { goal: limited, run: null, replayed: false }
    }
    if (!this.#resolver.resolveCurrent) {
      const blocked = await updateGoalStatus(this.#knex, {
        ownerId: fresh.ownerId,
        goalId: fresh.id,
        expectedVersion: fresh.version,
        from: [fresh.status],
        to: 'blocked',
        completion: fresh.completion,
        consumedTokens: usage.tokens,
        consumedToolCalls: usage.toolCalls,
        errorCode: 'GOAL_RESOLUTION_UNAVAILABLE',
        errorMessage: 'Current provider admission cannot be resolved for a continuation'
      })
      await this.#emitLatestGoalStatus(blocked)
      return { goal: blocked, run: null, replayed: false }
    }
    const resolved = await this.#resolver.resolveCurrent({ ownerId: fresh.ownerId, sessionId: fresh.sessionId })
    this.#assertResolvedAdmission(resolved)
    const firstRun = await this.#knex('agentRuns')
      .where({ goalId: fresh.id, goalContinuation: 0, ownerId: fresh.ownerId })
      .first('providerProfileVersionId', 'transportKind', 'model', 'profilePolicyVersion', 'defaultGeneration', 'capabilityRevision', 'pricingRevision', 'promptVersion') as {
        providerProfileVersionId: string
        transportKind: string
        model: string
        profilePolicyVersion: number | string
        defaultGeneration: number | string
        capabilityRevision: string
        pricingRevision: string
        promptVersion: number
      } | undefined
    if (!firstRun) throw new AgentRepositoryError('AGENT_GOAL_CORRUPT', 'Agent goal has no initial run', 500)
    const configurationMatches = firstRun.providerProfileVersionId === resolved.providerProfileVersionId &&
      firstRun.transportKind === resolved.transportKind &&
      firstRun.model === resolved.model &&
      Number(firstRun.profilePolicyVersion) === resolved.profilePolicyVersion &&
      Number(firstRun.defaultGeneration) === resolved.defaultGeneration &&
      firstRun.capabilityRevision === resolved.capabilityRevision &&
      firstRun.pricingRevision === resolved.pricingRevision &&
      firstRun.promptVersion === resolved.promptVersion
    if (!configurationMatches) {
      const blocked = await updateGoalStatus(this.#knex, {
        ownerId: fresh.ownerId,
        goalId: fresh.id,
        expectedVersion: fresh.version,
        from: [fresh.status],
        to: 'blocked',
        completion: fresh.completion,
        consumedTokens: usage.tokens,
        consumedToolCalls: usage.toolCalls,
        errorCode: 'GOAL_CONFIGURATION_CHANGED',
        errorMessage: 'Provider configuration changed; start a new goal to use the new configuration'
      })
      await this.#emitLatestGoalStatus(blocked)
      return { goal: blocked, run: null, replayed: false }
    }
    const [session, skillVersionIds] = await Promise.all([
      this.#knex('agentSessions').where({ id: fresh.sessionId, ownerId: fresh.ownerId }).whereNull('deletedAt').first('version') as Promise<{ version: number } | undefined>,
      this.#knex('agentRunSkills').join('agentRuns', 'agentRuns.id', 'agentRunSkills.runId').where({ 'agentRuns.goalId': fresh.id, 'agentRuns.goalContinuation': 0 }).orderBy('agentRunSkills.ordinal').pluck<string>('agentRunSkills.skillVersionId')
    ])
    if (!session) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent session was not found', 404)
    const continuation = fresh.continuationCount + 1
    const runId = input.runId ?? randomUUID()
    const clientRequestId = input.clientRequestId ?? randomUUID()
    const previous = fresh.completion ?? { outcome: 'retry', issues: [{ code: 'PRIOR_RUN_FAILED', message: 'The prior run did not produce a completion assessment.', retryable: true }] }
    const content = `Continue this explicit durable goal using only actionable remaining work. Do not repeat completed work. The host, not the model, decides completion.\\n${canonicalJson({ objective: fresh.objective, previousCompletion: previous })}`
    const now = new Date()
    const admitted = await this.#knex.transaction(async transaction => {
      const locked = await getOwnedAgentGoal(transaction, fresh.ownerId, fresh.id, true)
      if (locked.version !== fresh.version || locked.status !== fresh.status) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
      const activeRun = await transaction('agentRuns').where({ goalId: locked.id }).whereIn('status', ['queued', 'running', 'awaiting_approval']).first('id')
      if (activeRun) throw new AgentRepositoryError('GOAL_RUN_ACTIVE', 'Agent goal already has an active run', 409)
      const changed = await transaction('agentGoals').where({ id: locked.id, ownerId: locked.ownerId, version: locked.version, status: locked.status }).update({
        status: 'active',
        version: locked.version + 1,
        continuationCount: continuation,
        consumedTokens: usage.tokens,
        consumedToolCalls: usage.toolCalls,
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
        completedAt: null
      })
      if (changed !== 1) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
      const result = await admitAgentRunInTransaction(transaction, {
        id: runId,
        ownerId: locked.ownerId,
        sessionId: locked.sessionId,
        clientRequestId,
        expectedSessionVersion: Number(session.version),
        content,
        ...resolved,
        goalId: locked.id,
        goalContinuation: continuation,
        userMessageVisible: false,
        skillVersionIds,
        reservationExpiresAt: new Date(now.valueOf() + resolved.reservationMilliseconds),
        now
      })
      return { ...result, goal: await getOwnedAgentGoal(transaction, locked.ownerId, locked.id) }
    })
    if (!admitted.replayed) {
      await emitGoalEvent(this.#knex, { goal: admitted.goal, run: admitted.run, type: 'run.resumed' })
      await emitGoalEvent(this.#knex, { goal: admitted.goal, run: admitted.run, type: 'goal.status' })
    }
    return admitted
  }

  async pauseGoal(input: MutateAgentGoalInput): Promise<AgentGoalRecord> {
    const goal = await updateGoalStatus(this.#knex, {
      ownerId: input.ownerId,
      goalId: input.goalId,
      expectedVersion: input.expectedVersion,
      from: ['active', 'blocked'],
      to: 'paused'
    })
    const run = await this.#knex('agentRuns').where({ goalId: goal.id, ownerId: goal.ownerId }).whereIn('status', ['queued', 'running', 'awaiting_approval']).orderBy('goalContinuation', 'desc').first('id', 'attempts') as { id: string, attempts: number } | undefined
    if (run) {
      await emitGoalEvent(this.#knex, { goal, run, type: 'run.interrupted' })
      await emitGoalEvent(this.#knex, { goal, run, type: 'goal.status' })
      await this.#coordinator.cancel(goal.ownerId, run.id)
    }
    return goal
  }

  async resumeGoal(input: ResumeAgentGoalInput): Promise<{ readonly goal: AgentGoalRecord, readonly run: AgentRunRecord | null, readonly replayed: boolean }> {
    const goal = await getOwnedAgentGoal(this.#knex, input.ownerId, input.goalId)
    return this.#continueGoal(goal, { expectedVersion: input.expectedVersion, runId: input.runId, clientRequestId: input.clientRequestId, automatic: false })
  }

  async cancelGoal(input: MutateAgentGoalInput): Promise<AgentGoalRecord> {
    const goal = await updateGoalStatus(this.#knex, {
      ownerId: input.ownerId,
      goalId: input.goalId,
      expectedVersion: input.expectedVersion,
      from: ['active', 'paused', 'blocked'],
      to: 'cancelled'
    })
    const run = await this.#knex('agentRuns').where({ goalId: goal.id, ownerId: goal.ownerId }).whereIn('status', ['queued', 'running', 'awaiting_approval']).orderBy('goalContinuation', 'desc').first('id', 'attempts') as { id: string, attempts: number } | undefined
    if (run) {
      await emitGoalEvent(this.#knex, { goal, run, type: 'goal.status' })
      await this.#coordinator.cancel(goal.ownerId, run.id)
    }
    return goal
  }

  async #advanceGoal(): Promise<void> {
    if (!this.#goals.enabled) return
    const candidates = await this.#knex('agentGoals').where({ status: 'active' }).orderBy('updatedAt').limit(8).select('id', 'ownerId') as Array<{ id: string, ownerId: number }>
    for (const candidate of candidates) {
      const activeRun = await this.#knex('agentRuns').where({ goalId: candidate.id }).whereIn('status', ['queued', 'running', 'awaiting_approval']).first('id')
      if (activeRun) continue
      const goal = await getOwnedAgentGoal(this.#knex, candidate.ownerId, candidate.id)
      const latest = await this.#knex('agentRuns').where({ goalId: goal.id, ownerId: goal.ownerId }).orderBy('goalContinuation', 'desc').first('id', 'attempts', 'status', 'completionOutcome', 'completionAssessment', 'completionAssessmentSha256') as {
        id: string
        attempts: number
        status: string
        completionOutcome: string | null
        completionAssessment: string | null
        completionAssessmentSha256: string | null
      } | undefined
      if (!latest) throw new AgentRepositoryError('AGENT_GOAL_CORRUPT', 'Agent goal has no run', 500)
      const usage = await this.#goalUsage(goal.id)
      const completion = decodeCompletionAssessment(latest.completionAssessment, latest.completionOutcome, latest.completionAssessmentSha256)
      if (latest.status === 'succeeded' && completion?.outcome === 'complete') {
        const completed = await updateGoalStatus(this.#knex, {
          ownerId: goal.ownerId,
          goalId: goal.id,
          expectedVersion: goal.version,
          from: ['active'],
          to: 'completed',
          completion,
          consumedTokens: usage.tokens,
          consumedToolCalls: usage.toolCalls
        })
        await emitGoalEvent(this.#knex, { goal: completed, run: latest, type: 'goal.status' })
        return
      }
      if (latest.status === 'cancelled') {
        const cancelled = await updateGoalStatus(this.#knex, {
          ownerId: goal.ownerId,
          goalId: goal.id,
          expectedVersion: goal.version,
          from: ['active'],
          to: 'cancelled',
          completion,
          consumedTokens: usage.tokens,
          consumedToolCalls: usage.toolCalls
        })
        await emitGoalEvent(this.#knex, { goal: cancelled, run: latest, type: 'goal.status' })
        return
      }
      if (latest.status === 'recovery_required' || completion?.outcome === 'blocked') {
        const blocked = await updateGoalStatus(this.#knex, {
          ownerId: goal.ownerId,
          goalId: goal.id,
          expectedVersion: goal.version,
          from: ['active'],
          to: 'blocked',
          completion,
          consumedTokens: usage.tokens,
          consumedToolCalls: usage.toolCalls,
          errorCode: latest.status === 'recovery_required' ? 'GOAL_RECOVERY_REQUIRED' : 'GOAL_BLOCKED',
          errorMessage: latest.status === 'recovery_required' ? 'A run requires operator recovery' : 'Goal completion is blocked'
        })
        await emitGoalEvent(this.#knex, { goal: blocked, run: latest, type: 'goal.status' })
        return
      }
      await this.#continueGoal({ ...goal, completion }, { automatic: true })
      return
    }
  }

  async runOnce(): Promise<boolean> {
    const ran = await this.#coordinator.runOnce((claim, signal) => this.#execute(claim, signal))
    await this.#advanceGoal()
    return ran
  }

  async cancel(ownerId: number, runId: string): Promise<AgentRunRecord> {
    const run = await getOwnedAgentRun(this.#knex, ownerId, runId)
    if (run.goalId) {
      const goal = await getOwnedAgentGoal(this.#knex, ownerId, run.goalId)
      if (goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked') {
        await updateGoalStatus(this.#knex, {
          ownerId,
          goalId: goal.id,
          expectedVersion: goal.version,
          from: [goal.status],
          to: 'cancelled'
        })
      }
    }
    return this.#coordinator.cancel(ownerId, runId)
  }

  shutdown (): Promise<void> {
    return this.#coordinator.shutdown()
  }
}
