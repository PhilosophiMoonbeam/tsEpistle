import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import {
  type AgentActionName,
  type AgentCurrentPageHint,
  type AgentEventData,
  type AgentEventType,
  type AgentExecutionMode,
  type AgentGenerationTool,
  type AgentGoogleSearchGrounding,
  type AgentGoalBudgetLimitReason,
  type AgentGoalTokenTier,
  type AgentRunStatus,
  type AgentToolContextExclusion,
  isTerminalAgentRunStatus
} from '../../shared/agents/contracts.ts'
import { type AgentKnowledgeContext, AgentKnowledgeContextSchema } from '../../shared/agents/knowledge-context.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import {
  agentCompactionBindingMatches,
  agentGroundedExpiry,
  agentCompactionMinimumExpiry,
  agentCompactionSha256,
  agentCompactionSourceDigest,
  agentCompactionSourcePrefixes,
  isAgentCompactionOutcome,
  type AgentCompactionCanonicalSource,
  type AgentCompactionCheckpoint,
  type AgentCompactionContext,
  type AgentCompactionExposure,
  type AgentCompactionReceipt,
  readAgentCompactionCheckpoint,
  readAgentCompactionMetadata
} from './compaction.ts'
import {
  type AgentApprovalContinuationCheckpoint,
  type AgentQuotaLimits,
  type AgentQuotaRequest,
  AgentQuotaSettlementError,
  type AgentRunClaim,
  AgentRunCoordinator,
  type AgentRunRecord,
  acquireAgentCoordinatorAdvisoryLocks,
  admitAgentRunInTransaction,
  ensureAgentRunQuota,
  getOwnedAgentRun,
  normalizeAgentGenerationTools,
  persistAgentRunQuotaSettlementIntent,
  readAgentApprovalContinuation,
  terminalizeAgentRun
} from './coordinator.ts'
import {
  type AgentGoalLimits,
  type AgentGoalRecord,
  assessAgentRunCompletion,
  DEFAULT_AGENT_GOAL_LIMITS,
  decodeCompletionAssessment,
  emitGoalEvent,
  encodedCompletionAssessment,
  getOwnedAgentGoal,
  isSelectedAgentGoalBudgetPolicyVersion,
  insertAgentGoal,
  selectAgentGoalTokenBudget,
  updateGoalStatus
} from './goals.ts'
import {
  AGENT_MEDIA_METADATA_COLUMNS,
  AGENT_MEDIA_PROMPT_MAX_BYTES,
  AGENT_MEDIA_PROMPT_MAX_FILES,
  type AgentMediaMetadata,
  type AgentMediaSource,
  assertAgentMediaCapability,
  ownedAgentMediaSource,
  storeAgentMedia
} from './media.ts'
import { type AgentMemorySnapshot, decodeAgentMemorySnapshot } from './memory.ts'
import {
  type AgentChildBudgetReservation,
  AgentChildBudgetReservations,
  type AgentChildBudgetUsage,
  type AgentEvidenceSeed,
  type AgentOrchestrationLimits,
  type AgentResearchSynthesisContext,
  type AgentResearchTask,
  DEFAULT_AGENT_ORCHESTRATION_LIMITS,
  parseAgentTaskPlan,
  parseRecentPageEvidenceBatch,
  plannerPrompt,
  SUBAGENT_READ_ACTIONS,
  shouldPlanAgentResearch,
  subagentPrompt,
  validateChildEvidencePacket
} from './orchestration.ts'
import { AgentExecutionFailure, classifyAgentExecutionFailure, normalizeAgentExecutionFailureDiagnostics } from './providers/execution-failure.ts'
import {
  type AgentProviderContinuationDialect,
  type AgentProviderContinuationEnvelope,
  agentProviderContinuationDialect,
  decodeAgentProviderContinuation
} from './providers/factory.ts'
import { AgentProviderPoliciesSchema, type AgentProviderTransportKind } from './providers/registry.ts'
import { assertAgentTokenUsage, readAgentUsageEvent } from './providers/usage.ts'
import type {
  AgentConversationTitleGenerator,
  AgentConversationTitleResult,
  AgentGoalBudgetClassificationResult,
  AgentGoalBudgetClassifier
} from './providers/utility.ts'
import { AgentRepositoryError, appendAgentEvent, validateAgentGoogleSearchGrounding } from './repository.ts'
import { publishAgentGoogleSearchSuggestions } from './sse.ts'
import { SkillValidationError } from './skills/parser.ts'
import { lockSkillAdmissionPrincipal, resolveSelectedSkillVersionIdsInTransaction, validateSelectedSkillVersionIdsInTransaction } from './skills/runtime.ts'
import {
  type AgentTaskRecord,
  cancelAgentRunTasks,
  createAgentRunTasks,
  failAgentRunTask,
  finishAgentRunTask,
  listAgentRunTasks,
  recoverAgentRunTasks,
  startAgentRunTask
} from './tasks.ts'

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export interface AgentDispatchUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly costMicros: number
}

export interface AgentDispatchExposure {
  readonly tokens: number
  readonly costMicros: number
}

interface AgentUsageTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costMicros: number
}
const GOAL_ACCOUNTING_ERROR_MESSAGE = 'Goal quota accounting is incomplete or invalid'

const goalAccountingFailure = (): never => {
  throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', GOAL_ACCOUNTING_ERROR_MESSAGE, 500)
}

const goalAccountingInteger = (value: unknown): number => {
  if (typeof value !== 'number' && typeof value !== 'string') return goalAccountingFailure()
  if (typeof value === 'string' && value.trim().length === 0) return goalAccountingFailure()
  let numeric: number
  try {
    numeric = Number(value)
  } catch {
    return goalAccountingFailure()
  }
  if (!Number.isSafeInteger(numeric) || numeric < 0) return goalAccountingFailure()
  return numeric
}
const goalAccountingSum = (left: number, right: number, _label: string): number => {
  const sum = left + right
  if (!Number.isSafeInteger(sum) || sum < 0) return goalAccountingFailure()
  return sum
}
export interface AgentDispatchBudgetReservation {
  readonly id: number
  readonly tokens: number
  readonly costMicros: number
}

export interface AgentDispatchBudget {
  reserveSequence?(maximum: AgentQuotaRequest): Promise<AgentDispatchBudgetSequence>
  reserve(maximum: AgentQuotaRequest): Promise<AgentDispatchBudgetReservation>
  reconcile(reservation: AgentDispatchBudgetReservation, actual: AgentDispatchUsage): Promise<void>
  release(reservation: AgentDispatchBudgetReservation): Promise<void>
  consumeTool(): Promise<void>
  readonly unsettledExposure: AgentDispatchExposure
}

export interface AgentDispatchBudgetSequence extends AgentDispatchBudget {
  /** Release only undispatched sequence capacity; in-flight reservations remain accountable. */
  close(): Promise<void>
}

class AgentRunDispatchBudget implements AgentDispatchBudget {
  readonly #knex: Knex
  readonly #runId: string
  readonly #ownerId: number
  readonly #providerProfileVersionId: string
  readonly #maximumToolCalls: number | undefined
  #limits: AgentQuotaLimits | undefined
  #expiresAt: Date | undefined
  readonly #active = new Map<number, AgentQuotaRequest>()
  #consumedInputTokens = 0
  #consumedOutputTokens = 0
  #maximumTokens: number | undefined
  #consumedTotalTokens = 0
  #consumedCostMicros = 0
  #consumedToolCalls = 0
  #heldTokens = 0
  #heldCostMicros = 0
  #nextId = 1
  #tail = Promise.resolve()

  constructor(
    knex: Knex,
    claim: AgentRunClaim,
    maximumTokens?: number,
    maximumToolCalls?: number,
    initialUsage: Readonly<AgentUsageTotals> = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 }
  ) {
    this.#knex = knex
    this.#runId = claim.id
    this.#ownerId = claim.ownerId
    this.#providerProfileVersionId = claim.providerProfileVersionId
    this.#maximumTokens = maximumTokens
    this.#maximumToolCalls = maximumToolCalls
    this.#consumedInputTokens = nonNegativeUsage(initialUsage.inputTokens, 'Persisted provider input tokens')
    this.#consumedOutputTokens = nonNegativeUsage(initialUsage.outputTokens, 'Persisted provider output tokens')
    this.#consumedTotalTokens = nonNegativeUsage(initialUsage.totalTokens, 'Persisted provider total tokens')
    assertAgentTokenUsage(this.#consumedInputTokens, this.#consumedOutputTokens, this.#consumedTotalTokens)
    this.#consumedCostMicros = nonNegativeUsage(initialUsage.costMicros, 'Persisted provider cost')
  }
  setMaximumTokens(maximumTokens: number): void {
    if (!Number.isSafeInteger(maximumTokens) || maximumTokens < 0)
      throw new AgentRepositoryError('INVALID_AGENT_USAGE', 'Goal token allowance must be a non-negative safe integer', 500)
    this.#maximumTokens = maximumTokens
  }

  async #initialize(): Promise<void> {
    if (this.#limits !== undefined) return
    const [version, reservation] = await Promise.all([
      this.#knex('agentProviderProfileVersions').where({ id: this.#providerProfileVersionId }).first('policies') as Promise<{ policies: string } | undefined>,
      this.#knex('agentQuotaReservations')
        .where({ runId: this.#runId, ownerId: this.#ownerId, status: 'reserved' })
        .first('reservedTokens', 'reservedCostMicros', 'expiresAt') as Promise<
        { reservedTokens: number | string; reservedCostMicros: number | string; expiresAt: Date | string } | undefined
      >
    ])
    if (!version || !reservation) throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', 'Agent dispatch quota configuration is missing', 500)
    let policies
    try {
      policies = AgentProviderPoliciesSchema.parse(JSON.parse(version.policies))
    } catch {
      throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored provider policies are invalid', 500)
    }
    this.#limits = { dailyTokens: policies.dailyTokens, dailyCostMicros: policies.dailyCostMicros }
    this.#heldTokens = nonNegativeUsage(Number(reservation.reservedTokens), 'Held dispatch token exposure')
    this.#heldCostMicros = nonNegativeUsage(Number(reservation.reservedCostMicros), 'Held dispatch cost exposure')
    this.#expiresAt = new Date(reservation.expiresAt)
    if (!Number.isFinite(this.#expiresAt.valueOf())) throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', 'Agent quota expiration is invalid', 500)
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release: () => void = () => undefined
    this.#tail = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
  async reserveSequence(maximum: AgentQuotaRequest): Promise<AgentDispatchBudgetSequence> {
    const parent = await this.reserve(maximum)
    let closed = false
    const children = new Set<number>()
    const budget = this
    const reserve = async (requested: AgentQuotaRequest): Promise<AgentDispatchBudgetReservation> =>
      this.#exclusive(async () => {
        if (closed) throw new AgentRepositoryError('DISPATCH_RESERVATION_INVALID', 'Provider dispatch sequence is closed', 500)
        const remaining = this.#active.get(parent.id)
        if (!remaining) throw new AgentRepositoryError('DISPATCH_RESERVATION_INVALID', 'Provider dispatch sequence is not active', 500)
        const tokens = nonNegativeUsage(requested.tokens, 'Dispatch token exposure')
        const costMicros = nonNegativeUsage(requested.costMicros, 'Dispatch cost exposure')
        if (tokens > remaining.tokens || costMicros > remaining.costMicros)
          throw new AgentRepositoryError('DISPATCH_RESERVATION_EXCEEDED', 'Provider dispatch exceeds its sequence reservation', 502)
        this.#active.set(parent.id, { tokens: remaining.tokens - tokens, costMicros: remaining.costMicros - costMicros })
        const child = { id: this.#nextId++, tokens, costMicros }
        this.#active.set(child.id, { tokens, costMicros })
        children.add(child.id)
        return child
      })
    const assertChild = (reservation: AgentDispatchBudgetReservation): void => {
      if (!children.has(reservation.id))
        throw new AgentRepositoryError('DISPATCH_RESERVATION_INVALID', 'Provider dispatch reservation does not belong to this sequence', 500)
    }
    return {
      reserve,
      reconcile: async (reservation, actual) => {
        if (closed) throw new AgentRepositoryError('DISPATCH_RESERVATION_INVALID', 'Provider dispatch sequence is closed', 500)
        assertChild(reservation)
        await budget.reconcile(reservation, actual)
        children.delete(reservation.id)
      },
      release: async reservation => {
        if (closed) throw new AgentRepositoryError('DISPATCH_RESERVATION_INVALID', 'Provider dispatch sequence is closed', 500)
        assertChild(reservation)
        await budget.release(reservation)
        children.delete(reservation.id)
      },
      consumeTool: async () => {
        if (closed) throw new AgentRepositoryError('DISPATCH_RESERVATION_INVALID', 'Provider dispatch sequence is closed', 500)
        await budget.consumeTool()
      },
      get unsettledExposure() {
        let tokens = 0
        let costMicros = 0
        const remaining = budget.#active.get(parent.id)
        if (remaining) {
          tokens = safeUsageSum(tokens, remaining.tokens, 'Sequence token exposure')
          costMicros = safeUsageSum(costMicros, remaining.costMicros, 'Sequence cost exposure')
        }
        for (const id of children) {
          const exposure = budget.#active.get(id)
          if (!exposure) continue
          tokens = safeUsageSum(tokens, exposure.tokens, 'Sequence token exposure')
          costMicros = safeUsageSum(costMicros, exposure.costMicros, 'Sequence cost exposure')
        }
        return { tokens, costMicros }
      },
      close: async () => {
        if (closed) throw new AgentRepositoryError('DISPATCH_RESERVATION_INVALID', 'Provider dispatch sequence is already closed', 500)
        closed = true
        await budget.#exclusive(async () => {
          if (!budget.#active.delete(parent.id)) throw new AgentRepositoryError('DISPATCH_RESERVATION_INVALID', 'Provider dispatch sequence is not active', 500)
        })
      }
    }
  }
  async reserve(maximum: AgentQuotaRequest): Promise<AgentDispatchBudgetReservation> {
    return this.#exclusive(async () => {
      await this.#initialize()
      const tokens = nonNegativeUsage(maximum.tokens, 'Dispatch token exposure')
      const costMicros = nonNegativeUsage(maximum.costMicros, 'Dispatch cost exposure')
      let activeTokens = 0
      let activeCostMicros = 0
      for (const exposure of this.#active.values()) {
        activeTokens = safeUsageSum(activeTokens, exposure.tokens, 'Active dispatch token exposure')
        activeCostMicros = safeUsageSum(activeCostMicros, exposure.costMicros, 'Active dispatch cost exposure')
      }
      const target = {
        tokens: safeUsageSum(this.#consumedTotalTokens, safeUsageSum(activeTokens, tokens, 'Dispatch token exposure'), 'Dispatch token target'),
        costMicros: safeUsageSum(this.#consumedCostMicros, safeUsageSum(activeCostMicros, costMicros, 'Dispatch cost exposure'), 'Dispatch cost target')
      }
      if (this.#maximumTokens !== undefined && target.tokens > this.#maximumTokens) {
        throw new AgentRepositoryError('AGENT_TOKEN_BUDGET_LIMITED', 'Agent goal token budget was exhausted', 409)
      }
      if (target.tokens > this.#heldTokens || target.costMicros > this.#heldCostMicros) {
        const limits = this.#limits
        const expiresAt = this.#expiresAt
        if (!limits || !expiresAt) throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', 'Agent dispatch quota was not initialized', 500)
        await ensureAgentRunQuota(this.#knex, this.#runId, this.#ownerId, target, limits, expiresAt)
        this.#heldTokens = Math.max(this.#heldTokens, target.tokens)
        this.#heldCostMicros = Math.max(this.#heldCostMicros, target.costMicros)
      }
      const reservation = { id: this.#nextId++, tokens, costMicros }
      this.#active.set(reservation.id, { tokens, costMicros })
      return reservation
    })
  }

  async reconcile(reservation: AgentDispatchBudgetReservation, actual: AgentDispatchUsage): Promise<void> {
    await this.#exclusive(async () => {
      const held = this.#active.get(reservation.id)
      if (!held) throw new AgentRepositoryError('DISPATCH_RESERVATION_INVALID', 'Provider dispatch reservation is not active', 500)
      const inputTokens = nonNegativeUsage(actual.inputTokens, 'Dispatch input token usage')
      const outputTokens = nonNegativeUsage(actual.outputTokens, 'Dispatch output token usage')
      const totalTokens = nonNegativeUsage(actual.totalTokens, 'Dispatch total token usage')
      const costMicros = nonNegativeUsage(actual.costMicros, 'Dispatch cost usage')
      assertAgentTokenUsage(inputTokens, outputTokens, totalTokens)
      const consumedTokensAfter = safeUsageSum(this.#consumedTotalTokens, totalTokens, 'Consumed dispatch tokens')
      const consumedCostAfter = safeUsageSum(this.#consumedCostMicros, costMicros, 'Consumed dispatch cost')
      const exceedsGoal = this.#maximumTokens !== undefined && consumedTokensAfter > this.#maximumTokens
      const exceedsReservation = totalTokens > held.tokens || costMicros > held.costMicros
      if (exceedsGoal || exceedsReservation) {
        this.#active.delete(reservation.id)
        this.#consumedInputTokens = safeUsageSum(this.#consumedInputTokens, inputTokens, 'Consumed dispatch input tokens')
        this.#consumedOutputTokens = safeUsageSum(this.#consumedOutputTokens, outputTokens, 'Consumed dispatch output tokens')
        this.#consumedTotalTokens = consumedTokensAfter
        this.#consumedCostMicros = consumedCostAfter
        if (exceedsGoal) throw new AgentRepositoryError('AGENT_TOKEN_BUDGET_LIMITED', 'Agent goal token budget was exhausted', 409)
        throw new AgentRepositoryError('DISPATCH_RESERVATION_EXCEEDED', 'Provider usage exceeded its dispatch reservation', 502)
      }
      this.#active.delete(reservation.id)
      this.#consumedInputTokens = safeUsageSum(this.#consumedInputTokens, inputTokens, 'Consumed dispatch input tokens')
      this.#consumedOutputTokens = safeUsageSum(this.#consumedOutputTokens, outputTokens, 'Consumed dispatch output tokens')
      this.#consumedTotalTokens = consumedTokensAfter
      this.#consumedCostMicros = consumedCostAfter
    })
  }

  async release(reservation: AgentDispatchBudgetReservation): Promise<void> {
    await this.#exclusive(async () => {
      if (!this.#active.delete(reservation.id))
        throw new AgentRepositoryError('DISPATCH_RESERVATION_INVALID', 'Provider dispatch reservation is not active', 500)
    })
  }
  async consumeTool(): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#maximumToolCalls !== undefined && this.#consumedToolCalls >= this.#maximumToolCalls) {
        throw new AgentRepositoryError('AGENT_BUDGET_LIMITED', 'Agent goal action budget was exhausted', 409)
      }
      this.#consumedToolCalls += 1
    })
  }

  get consumed(): AgentUsageTotals {
    return {
      inputTokens: this.#consumedInputTokens,
      outputTokens: this.#consumedOutputTokens,
      totalTokens: this.#consumedTotalTokens,
      costMicros: this.#consumedCostMicros
    }
  }
  get unsettledExposure(): AgentDispatchExposure {
    let tokens = 0
    let costMicros = 0
    for (const exposure of this.#active.values()) {
      tokens = safeUsageSum(tokens, exposure.tokens, 'Unsettled dispatch token exposure')
      costMicros = safeUsageSum(costMicros, exposure.costMicros, 'Unsettled dispatch cost exposure')
    }
    return { tokens, costMicros }
  }
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

const parsedContextExclusion = (data: Readonly<Record<string, unknown>>, code: string): AgentToolContextExclusion | undefined => {
  if (!Object.hasOwn(data, 'contextExclusion')) return undefined
  const value = data.contextExclusion
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AgentRepositoryError(code, 'Agent tool context exclusion is invalid', 500)
  const status = Reflect.get(value, 'status')
  const reason = Reflect.get(value, 'reason')
  const keys = Object.keys(value)
  if ((status !== 'omitted' && status !== 'not_executed') || reason !== 'tool_result_capacity' || keys.some(key => key !== 'status' && key !== 'reason'))
    throw new AgentRepositoryError(code, 'Agent tool context exclusion is invalid', 500)
  return {
    status,
    reason
  }
}

const persistedResearchEvidence = (data: Readonly<Record<string, unknown>>, task: AgentTaskRecord): PersistedResearchEvidence | null => {
  const exclusion = parsedContextExclusion(data, 'AGENT_EVENT_CORRUPT')
  if (exclusion !== undefined) return null
  if (
    task.subagentRunId === null ||
    data.taskId !== task.id ||
    data.subagentRunId !== task.subagentRunId ||
    (data.rootRunId !== undefined && data.rootRunId !== task.runId) ||
    typeof data.actionCallId !== 'string' ||
    data.actionCallId.length === 0
  )
    return null
  const actionName = data.actionName
  if (actionName !== 'pages.get' && actionName !== 'pages.getVersion' && actionName !== 'pages.listRecent') return null
  if (typeof data.result !== 'string') return null
  let output: unknown
  try {
    output = JSON.parse(data.result)
  } catch {
    return null
  }
  if (actionName === 'pages.listRecent') {
    const batch = parseRecentPageEvidenceBatch(output)
    if (batch === null || batch.pages.length === 0) return null
    return {
      seed: {
        taskId: task.id,
        subagentRunId: task.subagentRunId,
        actionCallId: data.actionCallId,
        actionName,
        output: batch as unknown as Readonly<Record<string, unknown>>
      },
      revisions: new Map(batch.pages.map(page => [page.citation.evidenceId, page.sourceRevision]))
    }
  }
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return null
  const page = output as Record<string, unknown>
  if ((typeof page.sourceRevision !== 'string' && typeof page.sourceRevision !== 'number') || typeof page.citation !== 'object' || page.citation === null)
    return null
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
      actionName,
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
  readonly googleSearchEnabled: boolean
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
  resolve(
    transaction: Knex.Transaction,
    input: { readonly ownerId: number; readonly sessionId: string; readonly profileResolutionToken: string }
  ): Promise<AgentResolvedAdmission>
  resolveCurrent(transaction: Knex.Transaction, input: { readonly ownerId: number; readonly sessionId: string }): Promise<AgentResolvedAdmission>
}
export interface AgentEngineMessage {
  readonly canonicalSource?: AgentCompactionCanonicalSource
  readonly attachments?: readonly AgentMediaSource[]
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly providerState?: {
    readonly thoughtBlocks: AgentProviderContinuationEnvelope['thoughtBlocks']
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
  readonly state: 'complete' | 'omitted' | 'not_executed' | 'failed' | 'running'
  readonly input: unknown
  readonly target: Readonly<Record<string, unknown>> | null
  readonly cacheHit: boolean
  readonly duplicateOfActionCallId: string | null
  readonly contextExclusion?: AgentToolContextExclusion
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

export interface AgentRecoveredAction {
  readonly actionCallId: string
  readonly actionName: AgentActionName
  readonly actionInput: unknown
  readonly output: unknown
}

export interface AgentEngineRequest {
  readonly compaction?: AgentCompactionContext
  readonly googleSearchEnabled: boolean
  readonly generationTools?: readonly AgentGenerationTool[]
  readonly authorizeMedia?: () => Promise<void>
  readonly mediaRequest?: { readonly kind: 'image' | 'transcription' | 'video' | 'music' }
  readonly run: AgentRunClaim
  readonly purpose?: 'root' | 'planner' | 'subagent'
  readonly actionAllowlist?: readonly AgentActionName[]
  readonly task?: AgentResearchTask
  readonly subagentRunId?: string
  readonly research?: AgentResearchSynthesisContext
  readonly limits?: {
    readonly maxTokens?: number
    readonly maxTurns: number
    readonly maxToolCalls: number
    readonly maxOutputTokens?: number
  }
  readonly messages: readonly AgentEngineMessage[]
  readonly memory: AgentMemorySnapshot
  readonly currentPage?: AgentCurrentPageHint
  readonly knowledgeContext?: AgentKnowledgeContext
  readonly skills: readonly AgentEngineSkill[]
  readonly dispatchBudget?: AgentDispatchBudget
  readonly priorActivity?: readonly AgentPriorRunActivity[]
  readonly recoveredAction?: AgentRecoveredAction
  readonly signal: AbortSignal
}

export interface AgentEngineSink {
  commitCompaction?(receipt: AgentCompactionReceipt): Promise<void>
  googleSearchSuggestions?(suggestions: readonly string[]): Promise<void>
  media?(
    images: readonly {
      readonly payload: Buffer
      readonly mimeType: string
      readonly filename: string
      readonly kind?: 'generated-image' | 'generated-video' | 'generated-audio'
    }[]
  ): Promise<void>
  text(delta: string): Promise<void>
  event(type: AgentEventType, data: AgentEventData): Promise<void>
}

export interface AgentEngineResult {
  readonly outputLimited?: true
  readonly citations?: readonly Readonly<Record<string, unknown>>[]
  readonly googleSearchGrounding?: AgentGoogleSearchGrounding
  readonly suggestions?: readonly Readonly<Record<string, unknown>>[]
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly costMicros: number
  readonly providerState?: AgentProviderContinuationEnvelope
  readonly authoritySha256?: string
  readonly contextLimit?: {
    readonly reason: 'tool_result_capacity'
    readonly omittedActionCallIds: readonly string[]
  }
}

export interface AgentEnginePreflight {
  readonly compactionExposure?: AgentCompactionExposure
  readonly requiredTotalExposureTokens?: number
  readonly requiredCostMicros?: number
  readonly admissible: boolean
  readonly inputExposureTokens: number
  readonly outputExposureTokens: number
  readonly totalExposureTokens: number
}

export interface AgentEngine {
  preflight(request: AgentEngineRequest): Promise<AgentEnginePreflight>
  execute(request: AgentEngineRequest, sink: AgentEngineSink): Promise<AgentEngineResult>
  resumeAction?(request: AgentEngineRequest, checkpoint: AgentApprovalContinuationCheckpoint, sink: AgentEngineSink): Promise<AgentEngineResult>
}

export interface SubmitAgentMessageInput {
  readonly generationTools?: readonly AgentGenerationTool[]
  readonly attachmentIds?: readonly string[]
  readonly responseMode?: 'text' | 'image' | 'video' | 'music'
  readonly transcription?: boolean
  readonly ownerId: number
  readonly sessionId: string
  readonly profileResolutionToken: string
  readonly clientRequestId: string
  readonly expectedSessionVersion: number
  readonly content: string
  readonly invokedSkillVersionIds?: readonly string[]
  readonly currentPage?: Readonly<Record<string, unknown>>
  readonly knowledgeContext?: AgentKnowledgeContext
}
export interface CreateAgentGoalInput {
  readonly generationTools?: readonly AgentGenerationTool[]
  readonly goalId: string
  readonly ownerId: number
  readonly sessionId: string
  readonly profileResolutionToken: string
  readonly clientRequestId: string
  readonly expectedSessionVersion: number
  readonly objective: string
  readonly invokedSkillVersionIds?: readonly string[]
  readonly currentPage?: Readonly<Record<string, unknown>>
  readonly knowledgeContext?: AgentKnowledgeContext
}
export interface ResumeAgentGoalInput {
  readonly goalId: string
  readonly ownerId: number
  readonly expectedVersion: number
  readonly runId: string
  readonly clientRequestId: string
}
export interface RenewAgentGoalBudgetInput {
  readonly goalId: string
  readonly ownerId: number
  readonly expectedVersion: number
  readonly runId: string
  readonly clientRequestId: string
  readonly confirmed: true
}
export interface MutateAgentGoalInput {
  readonly goalId: string
  readonly ownerId: number
  readonly expectedVersion: number
}

export interface AgentProductRuntimeOptions {
  readonly authorizeMedia?: (ownerId: number) => Promise<void>
  readonly workerId: string
  readonly globalConcurrency: number
  readonly perUserConcurrency: number
  readonly leaseMilliseconds?: number
  readonly heartbeatMilliseconds?: number
  readonly orchestration?: AgentOrchestrationLimits
  readonly utilityModel?: AgentConversationTitleGenerator & Partial<AgentGoalBudgetClassifier>
  readonly goals?: AgentGoalLimits
  readonly logger?: { readonly error: (value: unknown) => void }
}

interface RuntimeMessageRow {
  id: string
  ordinal: number
  role: 'user' | 'assistant'
  content: string
  citations: string | null
  isVisible: boolean
  createdAt: Date | string
  googleSearchGrounding: string | null
  runId: string | null
  providerStateCiphertext: Uint8Array | null
  providerStateSha256: string | null
  originOwnerId: number | null
  originSessionId: string | null
  originProviderProfileVersionId: string | null
  originTransportKind: string | null
  originModel: string | null
  originCapabilityRevision: string | null
}
interface RuntimeSkillRow {
  id: string
  name: string
  skillMarkdown: string
}
interface RuntimeContextRow {
  data: string
}
interface RuntimeSessionRow {
  memorySnapshot: string
  title: string
  titleSource: 'none' | 'manual' | 'utility' | 'fallback'
  version: number
}
interface RuntimePriorEventRow {
  runId: string
  status: string
  userMessageOrdinal: number
  assistantMessageOrdinal: number
  sequence: number
  type: 'model.turn' | 'evidence.provenance' | 'tool.started' | 'tool.completed' | 'tool.notExecuted' | 'tool.failed'
  data: string
}

interface MutablePriorToolActivity {
  actionCallId: string
  actionName: string
  state: 'complete' | 'omitted' | 'not_executed' | 'failed' | 'running'
  input: unknown
  target: Record<string, unknown> | null
  cacheHit: boolean
  duplicateOfActionCallId: string | null
  contextExclusion?: AgentToolContextExclusion
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

const runtimeGroundingExpiry = (message: RuntimeMessageRow, inherited: string | null): string | null =>
  agentCompactionMinimumExpiry(message.googleSearchGrounding === null ? null : agentGroundedExpiry(message.createdAt), inherited)

const runtimeCanonicalSource = (
  message: RuntimeMessageRow,
  attachments: readonly AgentMediaMetadata[],
  inheritedExpiry: string | null
): AgentCompactionCanonicalSource => {
  const groundedExpiresAt = runtimeGroundingExpiry(message, inheritedExpiry)
  return {
    id: message.id,
    ordinal: Number(message.ordinal),
    sourceSha256: agentCompactionSourceDigest({
      id: message.id,
      ordinal: Number(message.ordinal),
      role: message.role,
      content: message.content,
      citations: message.citations,
      isVisible: message.isVisible,
      attachments: [...attachments]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(item => ({
          id: item.id,
          kind: item.kind,
          filename: item.filename,
          mimeType: item.mimeType,
          byteLength: Number(item.byteLength),
          sha256: item.sha256
        })),
      providerStateSha256: message.providerStateSha256,
      googleSearchGroundingSha256: message.googleSearchGrounding === null ? null : agentCompactionSha256(message.googleSearchGrounding),
      groundedExpiresAt
    }),
    groundedExpiresAt
  }
}

const assertNoTransientGoogleSearchSuggestions = (value: unknown): void => {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }]
  let visited = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    visited += 1
    if (visited > 20_000 || current.depth > 32)
      throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Inference engine output nesting exceeds its validation limit', 500)
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 })
      continue
    }
    if (typeof current.value !== 'object' || current.value === null) continue
    for (const [key, nested] of Object.entries(current.value)) {
      if (key === 'searchSuggestions' || key === 'search_suggestions')
        throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Raw Google Search suggestions cannot enter durable agent state', 500)
      pending.push({ value: nested, depth: current.depth + 1 })
    }
  }
}

const validatedContextLimit = (value: unknown): NonNullable<AgentEngineResult['contextLimit']> | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Inference engine emitted an invalid context limit', 500)
  }
  let reason: unknown
  let omittedActionCallIds: unknown
  try {
    reason = Reflect.get(value, 'reason')
    omittedActionCallIds = Reflect.get(value, 'omittedActionCallIds')
  } catch {
    throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Inference engine emitted an invalid context limit', 500)
  }
  if (
    reason !== 'tool_result_capacity' ||
    !Array.isArray(omittedActionCallIds) ||
    omittedActionCallIds.some(actionCallId => typeof actionCallId !== 'string')
  ) {
    throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Inference engine emitted an invalid context limit', 500)
  }
  return { reason, omittedActionCallIds: [...omittedActionCallIds] }
}

const safeLogNonNegativeInteger = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0)

const safeLogStatus = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : 500)

const priorRunActivity = (rows: readonly RuntimePriorEventRow[]): readonly AgentPriorRunActivity[] => {
  const runs = new Map<
    string,
    {
      status: string
      userMessageOrdinal: number
      assistantMessageOrdinal: number
      modelTurns: number
      rejectedEvidenceDrafts: number
      tools: MutablePriorToolActivity[]
      toolsById: Map<string, MutablePriorToolActivity>
    }
  >()
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
      if (!isAgentCompactionOutcome(data.outcome)) run.modelTurns += 1
      continue
    }
    if (row.type === 'evidence.provenance') {
      if (data.accepted === false) run.rejectedEvidenceDrafts += 1
      continue
    }
    const actionCallId = typeof data.actionCallId === 'string' ? data.actionCallId : ''
    if (!actionCallId) continue
    if (row.type === 'tool.started') {
      if (run.toolsById.has(actionCallId)) throw new AgentRepositoryError('AGENT_PRIOR_ACTIVITY_CORRUPT', 'Stored tool activity was started twice', 500)
      let input: unknown = null
      if (typeof data.input === 'string') {
        try {
          input = JSON.parse(data.input)
        } catch {
          input = null
        }
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
    if (!tool) throw new AgentRepositoryError('AGENT_PRIOR_ACTIVITY_CORRUPT', 'Stored tool activity has no start boundary', 500)
    if (tool.state !== 'running') throw new AgentRepositoryError('AGENT_PRIOR_ACTIVITY_CORRUPT', 'Stored tool activity has multiple terminal events', 500)
    if (data.actionName !== undefined && data.actionName !== tool.actionName)
      throw new AgentRepositoryError('AGENT_PRIOR_ACTIVITY_CORRUPT', 'Stored tool activity action is invalid', 500)
    const exclusion = parsedContextExclusion(data, 'AGENT_PRIOR_ACTIVITY_CORRUPT')
    if (row.type === 'tool.failed') {
      if (exclusion !== undefined) throw new AgentRepositoryError('AGENT_PRIOR_ACTIVITY_CORRUPT', 'Stored failed tool activity has a context exclusion', 500)
      tool.state = 'failed'
      continue
    }
    if (row.type === 'tool.notExecuted') {
      if (exclusion?.status !== 'not_executed' || Object.hasOwn(data, 'result'))
        throw new AgentRepositoryError('AGENT_PRIOR_ACTIVITY_CORRUPT', 'Stored not-executed tool activity has an invalid exclusion', 500)
      tool.state = 'not_executed'
      tool.contextExclusion = exclusion
      continue
    }
    if (exclusion?.status === 'not_executed')
      throw new AgentRepositoryError('AGENT_PRIOR_ACTIVITY_CORRUPT', 'Stored completed tool activity is marked not executed', 500)
    tool.state = exclusion?.status ?? 'complete'
    if (exclusion !== undefined) tool.contextExclusion = exclusion
    tool.cacheHit = data.cacheHit === true
    tool.duplicateOfActionCallId = typeof data.reusedActionCallId === 'string' ? data.reusedActionCallId : null
    if (typeof data.result === 'string') {
      try {
        const result: unknown = JSON.parse(data.result)
        if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
          const candidate = result as Record<string, unknown>
          tool.target = Object.fromEntries(
            ['id', 'title', 'path', 'sourceRevision'].flatMap(key => (candidate[key] === undefined ? [] : [[key, candidate[key]]]))
          )
        }
      } catch {
        /* diagnostic context remains useful without a target */
      }
    }
  }
  return [...runs.entries()].slice(-8).map(([runId, run]) => {
    const firstReadByTarget = new Map<string, string>()
    for (const tool of run.tools) {
      if (tool.state !== 'complete' || tool.duplicateOfActionCallId !== null || (tool.actionName !== 'pages.get' && tool.actionName !== 'pages.getVersion'))
        continue
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

const generationToolsHint = (value: string | undefined): readonly AgentGenerationTool[] | undefined => {
  if (value === undefined) return undefined
  try {
    if (Buffer.byteLength(value, 'utf8') > 32 * 1024) throw new Error('context too large')
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid context')
    return normalizeAgentGenerationTools(Reflect.get(parsed, 'generationTools'))
  } catch {
    throw new AgentRepositoryError('AGENT_RUN_CONTEXT_CORRUPT', 'Stored generation tool preferences are invalid.', 500)
  }
}
const assertGenerationToolCapabilities = async (
  db: Knex | Knex.Transaction,
  versionId: string,
  tools: readonly AgentGenerationTool[] | undefined,
  executionMode: AgentExecutionMode
): Promise<void> => {
  if (tools?.length && executionMode !== 'agent')
    throw new AgentRepositoryError('INVALID_GENERATION_TOOLS', 'This conversation mode cannot use generation tools.', 400)
  for (const tool of tools ?? [])
    await assertAgentMediaCapability(db, versionId, tool === 'image' ? 'imageGeneration' : tool === 'video' ? 'videoGeneration' : 'musicGeneration')
}

const knowledgeContextHint = (value: string | undefined): AgentKnowledgeContext | undefined => {
  if (value === undefined) return undefined
  try {
    if (Buffer.byteLength(value, 'utf8') > 32 * 1024) throw new Error('context too large')
    const parsed: unknown = JSON.parse(value)
    const context = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'knowledgeContext') : undefined
    return context === undefined ? undefined : AgentKnowledgeContextSchema.parse(context)
  } catch {
    throw new AgentRepositoryError('AGENT_RUN_CONTEXT_CORRUPT', 'Stored source context is invalid', 500)
  }
}

const currentPageHint = (value: string | undefined): AgentCurrentPageHint | undefined => {
  if (value === undefined) return undefined
  if (Buffer.byteLength(value, 'utf8') > 32 * 1_024) throw new AgentRepositoryError('AGENT_RUN_CONTEXT_CORRUPT', 'Stored run context is too large', 500)
  try {
    const parsed: unknown = JSON.parse(value)
    const currentPage = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'currentPage') : undefined
    if (currentPage === undefined) return undefined
    if (typeof currentPage !== 'object' || currentPage === null) throw new Error('invalid page context')
    const id = Reflect.get(currentPage, 'id')
    const locale = Reflect.get(currentPage, 'locale')
    const path = Reflect.get(currentPage, 'path')
    const observedUpdatedAt = Reflect.get(currentPage, 'observedUpdatedAt')
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      typeof locale !== 'string' ||
      locale.length < 1 ||
      locale.length > 16 ||
      typeof path !== 'string' ||
      path.length < 1 ||
      path.length > 1_024 ||
      typeof observedUpdatedAt !== 'string' ||
      !Number.isFinite(Date.parse(observedUpdatedAt))
    )
      throw new Error('invalid page context')
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
const safeUsageSum = (left: number, right: number, label: string): number => {
  const sum = left + right
  if (!Number.isSafeInteger(sum) || sum < 0) throw new AgentRepositoryError('INVALID_AGENT_USAGE', `${label} exceeds the supported range`, 500)
  return sum
}
interface GoalBudgetCheckpoint {
  readonly goalId: string
  readonly runId: string
  readonly tier: AgentGoalTokenTier
  readonly selection: 'utility' | 'fallback'
  readonly budgetCycle: number
  readonly tokenAllowance: number
  readonly classifier: AgentUsageTotals
  readonly cumulative: AgentUsageTotals
}

const goalBudgetCheckpointFailure = (): never => {
  throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', GOAL_ACCOUNTING_ERROR_MESSAGE, 500)
}

const goalBudgetCheckpointUsage = (data: AgentEventData, expectedGoalId?: string, expectedRunId?: string): GoalBudgetCheckpoint | null => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return goalBudgetCheckpointFailure()
  const utility = Reflect.get(data, 'utility')
  if (typeof utility !== 'object' || utility === null || Array.isArray(utility)) return null
  if (Reflect.get(utility, 'purpose') !== 'goal_budget') return null
  const goalBudget = Reflect.get(utility, 'goalBudget')
  if (typeof goalBudget !== 'object' || goalBudget === null || Array.isArray(goalBudget)) return goalBudgetCheckpointFailure()
  const goalId = Reflect.get(goalBudget, 'goalId')
  const runId = Reflect.get(data, 'runId')
  const tier = Reflect.get(goalBudget, 'tier')
  const selection = Reflect.get(goalBudget, 'selection')
  const budgetCycle = Reflect.get(goalBudget, 'budgetCycle')
  const tokenAllowance = Reflect.get(goalBudget, 'tokenAllowance')
  if (
    typeof goalId !== 'string' ||
    !UUID.test(goalId) ||
    (expectedGoalId !== undefined && goalId !== expectedGoalId) ||
    typeof runId !== 'string' ||
    !UUID.test(runId) ||
    (expectedRunId !== undefined && runId !== expectedRunId) ||
    (tier !== 'small' && tier !== 'standard' && tier !== 'extended') ||
    (selection !== 'utility' && selection !== 'fallback') ||
    !Number.isSafeInteger(budgetCycle) ||
    budgetCycle !== 1 ||
    !Number.isSafeInteger(tokenAllowance) ||
    tokenAllowance < 1
  )
    return goalBudgetCheckpointFailure()
  let cumulative: AgentUsageTotals
  let classifier: AgentUsageTotals
  try {
    const usage = readAgentUsageEvent(data)
    const inputTokens = nonNegativeUsage(Number(Reflect.get(goalBudget, 'inputTokens')), 'Goal classifier input tokens')
    const outputTokens = nonNegativeUsage(Number(Reflect.get(goalBudget, 'outputTokens')), 'Goal classifier output tokens')
    const totalTokens = nonNegativeUsage(Number(Reflect.get(goalBudget, 'totalTokens')), 'Goal classifier total tokens')
    const costMicros = nonNegativeUsage(Number(Reflect.get(goalBudget, 'costMicros')), 'Goal classifier cost')
    assertAgentTokenUsage(inputTokens, outputTokens, totalTokens)
    classifier = { inputTokens, outputTokens, totalTokens, costMicros }
    cumulative = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costMicros: usage.costMicros
    }
  } catch {
    return goalBudgetCheckpointFailure()
  }
  return { goalId, runId, tier, selection, budgetCycle, tokenAllowance, classifier, cumulative }
}

const zeroUsage = (): AgentUsageTotals => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 })

const goalBudgetLimitReason = (
  goal: Pick<AgentGoalRecord, 'maxTokens' | 'maxToolCalls' | 'maxContinuations' | 'continuationCount' | 'deadlineAt'>,
  usage: { readonly tokens: number; readonly toolCalls: number },
  now: Date,
  tokenFence = false
): AgentGoalBudgetLimitReason => {
  if (usage.toolCalls >= goal.maxToolCalls) return 'tool_calls'
  if (goal.continuationCount >= goal.maxContinuations) return 'continuations'
  if (new Date(goal.deadlineAt).valueOf() <= now.valueOf()) return 'duration'
  if (usage.tokens >= goal.maxTokens || tokenFence) return 'tokens'
  return 'authority'
}

const recognizedLegacyContinuation = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return true
  if (Reflect.get(value, 'schemaVersion') !== undefined || Reflect.get(value, 'continuationDialect') !== undefined) return true
  const thoughtBlocks = Reflect.get(value, 'thoughtBlocks')
  if (!Array.isArray(thoughtBlocks)) return true
  return thoughtBlocks.every(block => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return false
    const data = Reflect.get(block, 'data')
    return typeof data === 'string' && (data.startsWith('wiki.openai.reasoning.v1:') || data.startsWith('wiki.gemini.interactions.v1:'))
  })
}

const continuationDialectForTransport = (transportKind: string): AgentProviderContinuationDialect | null =>
  agentProviderContinuationDialect(transportKind as AgentProviderTransportKind)

const providerState = (
  value: Uint8Array | null,
  stateSha256: string | null,
  expectedDialect: AgentProviderContinuationDialect | null
): AgentEngineMessage['providerState'] => {
  if (value === null || expectedDialect === null) return undefined
  if (value.byteLength > 256 * 1_024) throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation is too large', 500)
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value).toString('utf8'))
  } catch {
    if (stateSha256 === null) return undefined
    throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation is invalid', 500)
  }
  const parsedObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  const versioned =
    parsedObject !== null && (Reflect.get(parsedObject, 'schemaVersion') !== undefined || Reflect.get(parsedObject, 'continuationDialect') !== undefined)
  const storedDialect = parsedObject === null ? undefined : Reflect.get(parsedObject, 'continuationDialect')
  if (versioned && storedDialect !== expectedDialect) return undefined
  if (stateSha256 === null && versioned)
    throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation integrity is invalid', 500)
  if (stateSha256 !== null && (!/^[a-f0-9]{64}$/.test(stateSha256) || sha256(value) !== stateSha256))
    throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation integrity is invalid', 500)
  if (!recognizedLegacyContinuation(parsed)) return undefined
  try {
    return decodeAgentProviderContinuation(parsed, expectedDialect)
  } catch (error) {
    if (error instanceof AgentRepositoryError && error.code === 'AGENT_PROVIDER_STATE_CORRUPT') throw error
    throw new AgentRepositoryError('AGENT_PROVIDER_STATE_CORRUPT', 'Stored provider continuation is invalid', 500)
  }
}

export class AgentProductRuntime {
  readonly #knex: Knex
  readonly #resolver: AgentAdmissionResolver
  readonly #engine: AgentEngine
  readonly #coordinator: AgentRunCoordinator
  readonly #utilityModel: (AgentConversationTitleGenerator & Partial<AgentGoalBudgetClassifier>) | undefined
  readonly #orchestration: AgentOrchestrationLimits
  readonly #goals: AgentGoalLimits
  readonly #logger: AgentProductRuntimeOptions['logger']
  readonly #authorizeMedia: AgentProductRuntimeOptions['authorizeMedia']
  constructor(knex: Knex, resolver: AgentAdmissionResolver, engine: AgentEngine, options: AgentProductRuntimeOptions) {
    this.#knex = knex
    this.#resolver = resolver
    this.#engine = engine
    this.#coordinator = new AgentRunCoordinator(knex, options)
    this.#utilityModel = options.utilityModel
    this.#orchestration = options.orchestration ?? DEFAULT_AGENT_ORCHESTRATION_LIMITS
    this.#goals = options.goals ?? DEFAULT_AGENT_GOAL_LIMITS
    this.#logger = options.logger
    this.#authorizeMedia = options.authorizeMedia
  }

  #logTerminalFailure(
    claim: AgentRunClaim,
    normalizedFailure: AgentExecutionFailure | null,
    errorCode: string,
    failureStage: string,
    providerStatus: number | undefined,
    unsettledExposure: AgentDispatchExposure
  ): void {
    const logger = this.#logger
    if (!logger) return
    const record: Record<string, unknown> = {
      event: 'agent.run.failed',
      runId: claim.id,
      attempt: safeLogNonNegativeInteger(claim.attempts),
      providerProfileVersionId: claim.providerProfileVersionId,
      errorCode,
      failureStage,
      status: safeLogStatus(normalizedFailure?.status),
      unsettledExposure: {
        tokens: safeLogNonNegativeInteger(unsettledExposure.tokens),
        costMicros: safeLogNonNegativeInteger(unsettledExposure.costMicros)
      }
    }
    if (providerStatus !== undefined) record.providerStatus = safeLogStatus(providerStatus)
    const diagnostics = normalizedFailure === null ? undefined : normalizeAgentExecutionFailureDiagnostics(normalizedFailure.diagnostics)
    if (diagnostics !== undefined) record.diagnostics = diagnostics
    try {
      // The text console formatter interpolates message values; objects otherwise
      // become "[object Object]" and hide these already-sanitized diagnostics.
      logger.error(JSON.stringify(record))
    } catch {
      /* logger failures must not change durable settlement */
    }
  }

  async #lockAdmissionContext(
    transaction: Knex.Transaction,
    ownerId: number,
    sessionId: string,
    expectedSessionVersion?: number
  ): Promise<{ readonly sessionVersion: number; readonly groupIds: readonly number[] }> {
    const session = (await transaction('agentSessions').where({ id: sessionId, ownerId }).whereNull('deletedAt').forUpdate().first('version')) as
      | { version: number | string }
      | undefined
    if (!session) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent resource was not found', 404)
    const sessionVersion = Number(session.version)
    if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 1)
      throw new AgentRepositoryError('AGENT_RUN_CORRUPT', 'Agent session version is invalid', 500)
    if (expectedSessionVersion !== undefined && sessionVersion !== expectedSessionVersion)
      throw new AgentRepositoryError('SESSION_VERSION_CHANGED', 'Agent session changed concurrently', 409)
    const groupIds = await lockSkillAdmissionPrincipal(transaction, ownerId)
    return { sessionVersion, groupIds }
  }

  async #skillVersionIds(
    transaction: Knex.Transaction,
    ownerId: number,
    groupIds: readonly number[],
    invokedSkillVersionIds: readonly string[]
  ): Promise<readonly string[]> {
    const skillVersionIds = await resolveSelectedSkillVersionIdsInTransaction(transaction, { userId: ownerId, groupIds }, invokedSkillVersionIds)
    if (skillVersionIds.length > 8) throw new AgentRepositoryError('TOO_MANY_SKILLS', 'A run can use at most 8 skills', 400)
    return skillVersionIds
  }

  #assertResolvedAdmission(resolved: AgentResolvedAdmission): void {
    if (!Number.isSafeInteger(resolved.reservationMilliseconds) || resolved.reservationMilliseconds < 1) {
      throw new AgentRepositoryError('INVALID_PROFILE_RESOLUTION', 'Quota reservation duration is invalid', 500)
    }
    if (typeof resolved.googleSearchEnabled !== 'boolean') throw new AgentRepositoryError('INVALID_PROFILE_RESOLUTION', 'Google Search consent is invalid', 500)
  }
  async #selectGoalBudgetWithCheckpoint(
    claim: AgentRunClaim,
    goal: AgentGoalRecord,
    classification: AgentGoalBudgetClassificationResult,
    dispatchBudget: AgentRunDispatchBudget
  ): Promise<AgentGoalRecord> {
    return this.#knex.transaction(async transaction => {
      await acquireAgentCoordinatorAdvisoryLocks(transaction, [claim.ownerId])
      const pending = await getOwnedAgentGoal(transaction, goal.ownerId, goal.id, true)
      if (pending.budgetSelection !== 'pending')
        throw new AgentRepositoryError('GOAL_BUDGET_ALREADY_SELECTED', 'Agent goal token tier is already selected', 409)
      const selected = await selectAgentGoalTokenBudget(transaction, {
        ownerId: goal.ownerId,
        goalId: goal.id,
        tier: classification.tier,
        selection: classification.selection,
        now: new Date()
      })
      if (selected.budgetSelection !== classification.selection || selected.tokenTier !== classification.tier || selected.tokenAllowance === null)
        throw new AgentRepositoryError('AGENT_GOAL_CORRUPT', 'Selected goal budget is invalid', 500)
      const cumulative = dispatchBudget.consumed
      await this.#appendPresentationEventInTransaction(transaction, claim, 'usage.updated', {
        usageVersion: 2,
        runId: claim.id,
        inputTokens: cumulative.inputTokens,
        outputTokens: cumulative.outputTokens,
        totalTokens: cumulative.totalTokens,
        costMicros: cumulative.costMicros,
        utility: {
          purpose: 'goal_budget',
          inputTokens: classification.inputTokens,
          outputTokens: classification.outputTokens,
          totalTokens: classification.totalTokens,
          costMicros: classification.costMicros,
          goalBudget: {
            goalId: selected.id,
            tier: selected.tokenTier,
            selection: selected.budgetSelection,
            inputTokens: classification.inputTokens,
            outputTokens: classification.outputTokens,
            totalTokens: classification.totalTokens,
            costMicros: classification.costMicros,
            budgetCycle: selected.budgetCycle,
            tokenAllowance: selected.tokenAllowance
          }
        }
      })
      return selected
    })
  }

  async #classifyGoalBudget(
    goal: AgentGoalRecord,
    claim: AgentRunClaim,
    signal: AbortSignal,
    dispatchBudget: AgentRunDispatchBudget
  ): Promise<{ readonly goal: AgentGoalRecord; readonly classification: AgentGoalBudgetClassificationResult }> {
    let classification: AgentGoalBudgetClassificationResult = {
      tier: 'extended',
      selection: 'fallback',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costMicros: 0
    }
    const utilityModel = this.#utilityModel
    if (utilityModel !== undefined && typeof utilityModel.classifyGoalBudget === 'function') {
      try {
        classification = await utilityModel.classifyGoalBudget({
          profileVersionId: claim.providerProfileVersionId,
          objective: goal.objective,
          signal,
          dispatchBudget
        })
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        try {
          await this.#blockGoalForAccounting(goal)
        } catch {
          /* Preserve the classifier failure; the next lifecycle pass rechecks the goal fence. */
        }
        throw error
      }
    }
    if (
      (classification.tier !== 'small' && classification.tier !== 'standard' && classification.tier !== 'extended') ||
      (classification.selection !== 'utility' && classification.selection !== 'fallback') ||
      (classification.selection === 'fallback' && classification.tier !== 'extended')
    ) {
      const error = new AgentRepositoryError('AGENT_QUOTA_CORRUPT', 'Goal budget classification result is invalid', 500)
      try {
        await this.#blockGoalForAccounting(goal)
      } catch {
        /* Preserve the classification failure. */
      }
      throw error
    }
    let inputTokens: number
    let outputTokens: number
    let totalTokens: number
    let costMicros: number
    try {
      inputTokens = nonNegativeUsage(classification.inputTokens, 'Goal classifier input tokens')
      outputTokens = nonNegativeUsage(classification.outputTokens, 'Goal classifier output tokens')
      totalTokens = nonNegativeUsage(classification.totalTokens, 'Goal classifier total tokens')
      costMicros = nonNegativeUsage(classification.costMicros, 'Goal classifier cost')
      assertAgentTokenUsage(inputTokens, outputTokens, totalTokens)
    } catch {
      const error = new AgentRepositoryError('AGENT_QUOTA_CORRUPT', 'Goal budget classification usage is invalid', 500)
      try {
        await this.#blockGoalForAccounting(goal)
      } catch {
        /* Preserve the classification failure. */
      }
      throw error
    }
    const validated = { ...classification, inputTokens, outputTokens, totalTokens, costMicros }
    return {
      goal: await this.#selectGoalBudgetWithCheckpoint(claim, goal, validated, dispatchBudget),
      classification: validated
    }
  }

  async submit(input: SubmitAgentMessageInput): Promise<{ readonly run: AgentRunRecord; readonly replayed: boolean }> {
    if (!input.content.trim() && input.attachmentIds?.length)
      input = {
        ...input,
        content:
          input.responseMode && input.responseMode !== 'text'
            ? `Create ${input.responseMode === 'music' ? 'music' : `a${input.responseMode === 'image' ? 'n' : ''} ${input.responseMode}`} using these attachments.`
            : 'Use the attached files.'
      }
    const generationTools = normalizeAgentGenerationTools(input.generationTools)
    const now = new Date()
    return this.#knex.transaction(async transaction => {
      await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
      const context = await this.#lockAdmissionContext(transaction, input.ownerId, input.sessionId, input.expectedSessionVersion)
      const resolved = await this.#resolver.resolve(transaction, {
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        profileResolutionToken: input.profileResolutionToken
      })
      this.#assertResolvedAdmission(resolved)
      await assertGenerationToolCapabilities(transaction, resolved.providerProfileVersionId, generationTools, resolved.executionMode)
      if (input.transcription) {
        if (input.attachmentIds?.length !== 1) throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Choose one audio recording.', 400)
        await assertAgentMediaCapability(transaction, resolved.providerProfileVersionId, 'transcription')
      } else {
        if (input.attachmentIds?.length && (!input.responseMode || input.responseMode === 'text'))
          await assertAgentMediaCapability(transaction, resolved.providerProfileVersionId, 'attachments')
        if (input.responseMode && input.responseMode !== 'text') {
          await assertAgentMediaCapability(
            transaction,
            resolved.providerProfileVersionId,
            input.responseMode === 'image' ? 'imageGeneration' : input.responseMode === 'video' ? 'videoGeneration' : 'musicGeneration'
          )
          if (input.attachmentIds?.length) {
            const files = (await transaction('agentMedia')
              .where({ ownerId: input.ownerId, sessionId: input.sessionId })
              .whereIn('id', input.attachmentIds)
              .select('mimeType')) as { mimeType: string }[]
            if (files.some(file => !file.mimeType.startsWith('image/')))
              throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Media generation accepts image attachments only.', 400)
          }
        }
      }
      const skillVersionIds = await this.#skillVersionIds(transaction, input.ownerId, context.groupIds, input.invokedSkillVersionIds ?? [])
      return admitAgentRunInTransaction(transaction, {
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
        expectedSessionVersion: context.sessionVersion,
        content: input.content,
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.transcription
          ? { mediaRequest: { kind: 'transcription' as const }, userMessageVisible: false, assistantMessageVisible: false }
          : input.responseMode && input.responseMode !== 'text'
            ? { mediaRequest: { kind: input.responseMode } }
            : {}),
        ...(generationTools === undefined ? {} : { generationTools }),
        ...(input.currentPage === undefined ? {} : { currentPage: input.currentPage }),
        ...(input.knowledgeContext === undefined ? {} : { knowledgeContext: input.knowledgeContext }),
        ...resolved,
        skillVersionIds,
        reservationExpiresAt: new Date(now.valueOf() + resolved.reservationMilliseconds),
        now
      })
    })
  }

  async createGoal(input: CreateAgentGoalInput): Promise<{ readonly goal: AgentGoalRecord; readonly run: AgentRunRecord; readonly replayed: boolean }> {
    if (!this.#goals.enabled) throw new AgentRepositoryError('AGENT_GOALS_DISABLED', 'Durable goals are disabled', 404)
    const generationTools = normalizeAgentGenerationTools(input.generationTools)
    const now = new Date()
    const created = await this.#knex.transaction(async transaction => {
      await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
      const context = await this.#lockAdmissionContext(transaction, input.ownerId, input.sessionId, input.expectedSessionVersion)
      const resolved = await this.#resolver.resolve(transaction, {
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        profileResolutionToken: input.profileResolutionToken
      })
      this.#assertResolvedAdmission(resolved)
      await assertGenerationToolCapabilities(transaction, resolved.providerProfileVersionId, generationTools, resolved.executionMode)
      const skillVersionIds = await this.#skillVersionIds(transaction, input.ownerId, context.groupIds, input.invokedSkillVersionIds ?? [])
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
        expectedSessionVersion: context.sessionVersion,
        content: goal.objective,
        ...(generationTools === undefined ? {} : { generationTools }),
        ...(input.currentPage === undefined ? {} : { currentPage: input.currentPage }),
        ...(input.knowledgeContext === undefined ? {} : { knowledgeContext: input.knowledgeContext }),
        ...resolved,
        quota: { ...resolved.quota, tokens: Math.min(resolved.quota.tokens, goal.maxTokens) },
        goalId: goal.id,
        goalContinuation: 0,
        userMessageVisible: true,
        skillVersionIds,
        reservationExpiresAt: new Date(Math.min(now.valueOf() + resolved.reservationMilliseconds, new Date(goal.deadlineAt).valueOf())),
        now
      })
      return { goal, ...admitted }
    })
    if (!created.replayed) await emitGoalEvent(this.#knex, { goal: created.goal, run: created.run, type: 'goal.created' })
    return created
  }

  async #appendPresentationEventInTransaction(
    transaction: Knex.Transaction,
    claim: AgentRunClaim,
    type: AgentEventType,
    data: AgentEventData,
    messagePatch?: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const now = new Date()
    const run = (await transaction('agentRuns')
      .where({ id: claim.id, ownerId: claim.ownerId, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
      .whereIn('status', ['running', 'awaiting_approval'])
      .whereNull('cancelRequestedAt')
      .forUpdate()
      .first('eventSequence', 'assistantMessageId')) as { eventSequence: number; assistantMessageId: string } | undefined
    if (!run) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost while recording output', 409)
    assertNoTransientGoogleSearchSuggestions(data)
    const encoded = canonicalJson(data)
    const sequence = Number(run.eventSequence) + 1
    await transaction('agentEvents').insert({
      id: randomUUID(),
      runId: claim.id,
      sequence,
      type,
      attempt: claim.attempts,
      schemaVersion: 1,
      dataSha256: sha256(encoded),
      data: encoded,
      createdAt: now
    })
    if (messagePatch)
      await transaction('agentMessages')
        .where({ id: run.assistantMessageId, runId: claim.id })
        .update({ ...messagePatch, updatedAt: now })
    const changed = await transaction('agentRuns')
      .where({ id: claim.id, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken, eventSequence: run.eventSequence })
      .whereNull('cancelRequestedAt')
      .whereIn('status', ['running', 'awaiting_approval'])
      .update({ eventSequence: sequence, updatedAt: now })
    if (changed !== 1) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run event fence changed concurrently', 409)
    if (transaction.client.config.client === 'pg' || transaction.client.config.client === 'postgresql')
      await transaction.raw("SELECT pg_notify('wiki_agent_events', ?)", [claim.id])
  }

  async #appendPresentationEvent(
    claim: AgentRunClaim,
    type: AgentEventType,
    data: AgentEventData,
    messagePatch?: Readonly<Record<string, unknown>>
  ): Promise<void> {
    await this.#knex.transaction(transaction => this.#appendPresentationEventInTransaction(transaction, claim, type, data, messagePatch))
  }

  async #generateConversationTitle(
    claim: AgentRunClaim,
    session: RuntimeSessionRow,
    messages: readonly AgentEngineMessage[],
    assistantMessage: string,
    signal: AbortSignal,
    dispatchBudget: AgentDispatchBudget
  ): Promise<AgentConversationTitleResult> {
    const empty: AgentConversationTitleResult = { title: '', source: 'fallback', inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 }
    const titleMessages = [
      ...messages.map(message => ({ role: message.role, content: message.content })),
      { role: 'assistant' as const, content: assistantMessage }
    ]
    const userTurnCount = titleMessages.filter(message => message.role === 'user').length
    const titleMayBeGenerated =
      session.titleSource === 'none' || ((session.titleSource === 'utility' || session.titleSource === 'fallback') && userTurnCount <= 2)
    if (!this.#utilityModel || !titleMayBeGenerated || userTurnCount < 1) return empty
    let generated: AgentConversationTitleResult
    try {
      generated = await this.#utilityModel.generateConversationTitle({
        profileVersionId: claim.providerProfileVersionId,
        messages: titleMessages,
        signal,
        dispatchBudget
      })
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      if (error instanceof AgentRepositoryError) throw error
      return empty
    }
    if (signal.aborted) throw signal.reason
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

  async #planResearch(
    claim: AgentRunClaim,
    userRequest: string,
    currentPage: AgentCurrentPageHint | undefined,
    knowledgeContext: AgentKnowledgeContext | undefined,
    memory: AgentMemorySnapshot,
    skills: readonly RuntimeSkillRow[],
    budget: AgentChildBudgetUsage,
    signal: AbortSignal,
    dispatchBudget: AgentDispatchBudget,
    maxTokens?: number
  ): Promise<{ readonly tasks: readonly AgentTaskRecord[]; readonly usage: AgentUsageTotals }> {
    let content = ''
    let result: AgentEngineResult
    const plannerSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#orchestration.plannerTimeoutMilliseconds)])
    try {
      result = await this.#engine.execute(
        {
          run: claim,
          purpose: 'planner',
          googleSearchEnabled: false,
          ...(currentPage === undefined ? {} : { currentPage }),
          ...(knowledgeContext === undefined ? {} : { knowledgeContext }),
          actionAllowlist: [],
          limits: {
            ...(maxTokens === undefined ? {} : { maxTokens }),
            maxTurns: this.#orchestration.plannerTurns,
            maxToolCalls: 0,
            maxOutputTokens: Math.min(this.#orchestration.plannerMaxOutputTokens, maxTokens ?? this.#orchestration.plannerMaxOutputTokens)
          },
          messages: [{ role: 'user', content: plannerPrompt(userRequest, this.#orchestration.maxChildren) }],
          memory: EMPTY_MEMORY,
          skills: [],
          priorActivity: [],
          dispatchBudget,
          signal: plannerSignal
        },
        {
          text: async delta => {
            if (plannerSignal.aborted) throw plannerSignal.reason
            if (typeof delta !== 'string' || delta.length === 0 || content.length + delta.length > 32_000)
              throw new AgentRepositoryError('AGENT_TASK_PLAN_INVALID', 'Task planner output is invalid', 409)
            content += delta
          },
          event: async () => {}
        }
      )
    } catch (error) {
      if (plannerSignal.aborted) throw plannerSignal.reason ?? error
      throw error
    }
    const usage = {
      inputTokens: nonNegativeUsage(result.inputTokens, 'Planner input tokens'),
      outputTokens: nonNegativeUsage(result.outputTokens, 'Planner output tokens'),
      totalTokens: nonNegativeUsage(result.totalTokens, 'Planner total tokens'),
      costMicros: nonNegativeUsage(result.costMicros, 'Planner cost')
    }
    assertAgentTokenUsage(usage.inputTokens, usage.outputTokens, usage.totalTokens)
    let plan
    try {
      if (result.outputLimited) throw new AgentRepositoryError('AGENT_TASK_PLAN_INVALID', 'The provider output limit prevented completion of the plan', 409)
      plan = parseAgentTaskPlan(content, this.#orchestration.maxChildren)
    } catch {
      await this.#appendPresentationEvent(claim, 'task.planCreated', {
        usageVersion: 2,
        rootRunId: claim.id,
        accepted: false,
        taskCount: 0,
        ...(result.outputLimited ? { reason: 'AGENT_OUTPUT_LIMITED' } : {}),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        costMicros: usage.costMicros
      })
      return { tasks: [], usage }
    }
    const proposed = plan.map(task => ({ id: randomUUID(), ...task }))
    if (proposed.length > 0) {
      const initialCount = Math.min(this.#orchestration.maxConcurrentChildren, proposed.length)
      const reservations = new AgentChildBudgetReservations(this.#orchestration, budget)
      const checked: Array<{ readonly reservation: AgentChildBudgetReservation }> = []
      let admissible = true
      try {
        for (let index = 0; index < initialCount; index += 1) {
          const task = proposed[index]
          if (!task) break
          const reservation = reservations.reserve(initialCount - index)
          if (reservation === null) {
            admissible = false
            break
          }
          checked.push({ reservation })
          const preflightSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#orchestration.childTimeoutMilliseconds)])
          const preflight = await this.#engine.preflight(
            this.#researchEngineRequest({
              claim,
              task,
              memory,
              skills,
              currentPage,
              knowledgeContext,
              reservation,
              signal: preflightSignal
            })
          )
          const requiredTotalExposureTokens = preflight.requiredTotalExposureTokens ?? preflight.totalExposureTokens
          if (
            !Number.isSafeInteger(preflight.inputExposureTokens) ||
            preflight.inputExposureTokens < 0 ||
            !Number.isSafeInteger(preflight.outputExposureTokens) ||
            preflight.outputExposureTokens < 1 ||
            !Number.isSafeInteger(preflight.totalExposureTokens) ||
            preflight.totalExposureTokens < 1 ||
            preflight.outputExposureTokens > reservation.maxOutputTokens ||
            !Number.isSafeInteger(requiredTotalExposureTokens) ||
            requiredTotalExposureTokens < 1 ||
            requiredTotalExposureTokens > reservation.totalTokens ||
            !preflight.admissible
          ) {
            admissible = false
            break
          }
        }
      } finally {
        for (const { reservation } of checked) reservations.release(reservation, { outputCharacters: 0, totalTokens: 0 })
      }
      if (!admissible) {
        await this.#appendPresentationEvent(claim, 'task.planCreated', {
          usageVersion: 2,
          rootRunId: claim.id,
          accepted: false,
          taskCount: 0,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          costMicros: usage.costMicros
        })
        return { tasks: [], usage }
      }
    }
    return {
      tasks: await createAgentRunTasks(this.#knex, claim, proposed, usage),
      usage
    }
  }

  async #orchestrationTelemetry(claim: AgentRunClaim): Promise<{
    readonly usage: AgentUsageTotals
    readonly modelUsage: AgentUsageTotals
    readonly goalBudgetUsage: AgentUsageTotals
    readonly modelTurns: number
    readonly budget: AgentChildBudgetUsage
    readonly planRejected: boolean
  }> {
    const rows = (await this.#knex('agentEvents')
      .where({ runId: claim.id })
      .whereIn('type', ['task.planCreated', 'model.turn', 'usage.updated'])
      .select('type', 'data', 'dataSha256')) as Array<{
      type: 'task.planCreated' | 'model.turn' | 'usage.updated'
      data: string
      dataSha256: string
    }>
    const usage: AgentUsageTotals = zeroUsage()
    const modelUsage: AgentUsageTotals = zeroUsage()
    const goalBudgetUsage: AgentUsageTotals = zeroUsage()
    let checkpointSeen = false
    let consumedOutputCharacters = 0
    let consumedTotalTokens = 0
    let modelTurns = 0
    let planRejected = false
    for (const row of rows) {
      if (sha256(row.data) !== row.dataSha256) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored orchestration event hash is invalid', 500)
      let data: unknown
      try {
        data = JSON.parse(row.data)
      } catch {
        throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored orchestration event is invalid', 500)
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data))
        throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored orchestration event data is invalid', 500)
      let eventUsage
      try {
        eventUsage = readAgentUsageEvent(data as AgentEventData)
      } catch {
        throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored orchestration usage is invalid', 500)
      }
      if (row.type === 'usage.updated') {
        const checkpoint = goalBudgetCheckpointUsage(data as AgentEventData, claim.goalId ?? undefined, claim.id)
        if (checkpoint !== null) {
          if (claim.goalId === null || checkpointSeen) throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', GOAL_ACCOUNTING_ERROR_MESSAGE, 500)
          checkpointSeen = true
          goalBudgetUsage.inputTokens = checkpoint.classifier.inputTokens
          goalBudgetUsage.outputTokens = checkpoint.classifier.outputTokens
          goalBudgetUsage.totalTokens = checkpoint.classifier.totalTokens
          goalBudgetUsage.costMicros = checkpoint.classifier.costMicros
        }
        continue
      }
      if (row.type === 'task.planCreated') {
        usage.inputTokens = safeUsageSum(usage.inputTokens, eventUsage.inputTokens, 'Orchestration input tokens')
        usage.outputTokens = safeUsageSum(usage.outputTokens, eventUsage.outputTokens, 'Orchestration output tokens')
        usage.totalTokens = safeUsageSum(usage.totalTokens, eventUsage.totalTokens, 'Orchestration total tokens')
        usage.costMicros = safeUsageSum(usage.costMicros, eventUsage.costMicros, 'Orchestration cost')
        if (Reflect.get(data, 'accepted') === false && Reflect.get(data, 'taskCount') === 0) planRejected = true
        continue
      }
      if (typeof Reflect.get(data, 'taskId') !== 'string' || typeof Reflect.get(data, 'subagentRunId') !== 'string') {
        if (!isAgentCompactionOutcome(Reflect.get(data, 'outcome'))) modelTurns += 1
        modelUsage.inputTokens = safeUsageSum(modelUsage.inputTokens, eventUsage.inputTokens, 'Model input tokens')
        modelUsage.outputTokens = safeUsageSum(modelUsage.outputTokens, eventUsage.outputTokens, 'Model output tokens')
        modelUsage.totalTokens = safeUsageSum(modelUsage.totalTokens, eventUsage.totalTokens, 'Model total tokens')
        modelUsage.costMicros = safeUsageSum(modelUsage.costMicros, eventUsage.costMicros, 'Model cost')
        continue
      }
      usage.inputTokens = safeUsageSum(usage.inputTokens, eventUsage.inputTokens, 'Orchestration input tokens')
      usage.outputTokens = safeUsageSum(usage.outputTokens, eventUsage.outputTokens, 'Orchestration output tokens')
      usage.totalTokens = safeUsageSum(usage.totalTokens, eventUsage.totalTokens, 'Orchestration total tokens')
      usage.costMicros = safeUsageSum(usage.costMicros, eventUsage.costMicros, 'Orchestration cost')
      consumedTotalTokens = safeUsageSum(consumedTotalTokens, eventUsage.totalTokens, 'Consumed child total tokens')
      const turnContent = Reflect.get(data, 'content')
      if (typeof turnContent !== 'string') throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored subagent output telemetry is invalid', 500)
      const accountedOutputCharacters = Reflect.get(data, 'budgetOutputCharacters')
      const turnOutputCharacters =
        Reflect.get(data, 'contentTruncated') === true
          ? accountedOutputCharacters === undefined
            ? this.#orchestration.maxAggregateChildOutputCharacters + 1
            : nonNegativeUsage(Number(accountedOutputCharacters), 'Subagent output characters')
          : turnContent.length
      consumedOutputCharacters = safeUsageSum(consumedOutputCharacters, turnOutputCharacters, 'Consumed child output characters')
    }
    const budget: AgentChildBudgetUsage = { outputCharacters: consumedOutputCharacters, totalTokens: consumedTotalTokens }
    return { usage, modelUsage, goalBudgetUsage, modelTurns, budget, planRejected }
  }

  async #goalBudgetCheckpoints(
    database: Knex | Knex.Transaction,
    goal: AgentGoalRecord
  ): Promise<{
    readonly runs: readonly { readonly id: string; readonly goalContinuation: number | string | null }[]
    readonly checkpoints: readonly GoalBudgetCheckpoint[]
  }> {
    const runs = (await database('agentRuns').where({ goalId: goal.id, ownerId: goal.ownerId }).select('id', 'goalContinuation')) as Array<{
      id: string
      goalContinuation: number | string | null
    }>
    if (runs.length === 0) return goalBudgetCheckpointFailure()
    const runIds = runs.map(run => run.id)
    const rows = (await database('agentEvents').whereIn('runId', runIds).where({ type: 'usage.updated' }).select('runId', 'data', 'dataSha256')) as Array<{
      runId: string
      data: string
      dataSha256: string
    }>
    const checkpoints: GoalBudgetCheckpoint[] = []
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.data)
      } catch {
        throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored goal budget checkpoint is invalid', 500)
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored goal budget checkpoint data is invalid', 500)
      const candidate = parsed as AgentEventData
      const utility = Reflect.get(candidate, 'utility')
      if (typeof utility !== 'object' || utility === null || Array.isArray(utility) || Reflect.get(utility, 'purpose') !== 'goal_budget') continue
      if (sha256(row.data) !== row.dataSha256) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored goal budget checkpoint hash is invalid', 500)
      const checkpoint = goalBudgetCheckpointUsage(candidate, goal.id, row.runId)
      if (checkpoint === null) throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', GOAL_ACCOUNTING_ERROR_MESSAGE, 500)
      checkpoints.push(checkpoint)
    }
    const modernSelected =
      isSelectedAgentGoalBudgetPolicyVersion(goal.budgetPolicyVersion) &&
      (goal.budgetSelection === 'utility' || goal.budgetSelection === 'fallback') &&
      goal.tokenTier !== null &&
      goal.tokenAllowance !== null &&
      goal.budgetCycle >= 1
    if (modernSelected) {
      const initialRun = runs.find(run => Number(run.goalContinuation) === 0)
      if (
        checkpoints.length !== 1 ||
        !initialRun ||
        !runs.some(run => run.id === checkpoints[0]?.runId) ||
        checkpoints[0]?.tier !== goal.tokenTier ||
        checkpoints[0]?.selection !== goal.budgetSelection ||
        checkpoints[0]?.tokenAllowance !== goal.tokenAllowance ||
        checkpoints[0]?.budgetCycle !== 1
      )
        return goalBudgetCheckpointFailure()
    } else if (checkpoints.length > 0) {
      return goalBudgetCheckpointFailure()
    }
    return { runs, checkpoints }
  }

  #researchEngineRequest(input: {
    readonly claim: AgentRunClaim
    readonly task: AgentResearchTask
    readonly memory: AgentMemorySnapshot
    readonly skills: readonly RuntimeSkillRow[]
    readonly currentPage: AgentCurrentPageHint | undefined
    readonly knowledgeContext: AgentKnowledgeContext | undefined
    readonly reservation: AgentChildBudgetReservation
    readonly signal: AbortSignal
    readonly subagentRunId?: string
    readonly dispatchBudget?: AgentDispatchBudget
  }): AgentEngineRequest {
    return {
      googleSearchEnabled: false,
      run: input.claim,
      purpose: 'subagent',
      task: input.task,
      ...(input.subagentRunId === undefined ? {} : { subagentRunId: input.subagentRunId }),
      actionAllowlist: SUBAGENT_READ_ACTIONS,
      limits: {
        maxTokens: input.reservation.totalTokens,
        maxTurns: this.#orchestration.childTurns,
        maxToolCalls: this.#orchestration.childToolCalls,
        maxOutputTokens: input.reservation.maxOutputTokens
      },
      messages: [{ role: 'user', content: subagentPrompt(input.task) }],
      memory: input.memory,
      skills: input.skills,
      priorActivity: [],
      ...(input.dispatchBudget === undefined ? {} : { dispatchBudget: input.dispatchBudget }),
      signal: input.signal,
      ...(input.currentPage === undefined ? {} : { currentPage: input.currentPage }),
      ...(input.knowledgeContext === undefined ? {} : { knowledgeContext: input.knowledgeContext })
    }
  }

  async #executeResearchTask(
    claim: AgentRunClaim,
    task: AgentTaskRecord,
    memory: AgentMemorySnapshot,
    skills: readonly RuntimeSkillRow[],
    currentPage: AgentCurrentPageHint | undefined,
    knowledgeContext: AgentKnowledgeContext | undefined,
    reservations: AgentChildBudgetReservations,
    reservation: AgentChildBudgetReservation,
    signal: AbortSignal,
    dispatchBudget: AgentDispatchBudget
  ): Promise<AgentUsageTotals> {
    const subagentRunId = randomUUID()
    const childSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#orchestration.childTimeoutMilliseconds)])
    let activeTask: AgentTaskRecord | undefined
    let content = ''
    let usage: AgentUsageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 }
    const consumed = { outputCharacters: 0, totalTokens: 0 }
    const evidenceRevisions = new Map<string, string>()
    try {
      const startedTask = await startAgentRunTask(this.#knex, claim, task.id, subagentRunId)
      activeTask = startedTask
      const result = await this.#engine.execute(
        this.#researchEngineRequest({
          claim,
          task: researchTask(startedTask),
          memory,
          skills,
          currentPage,
          knowledgeContext,
          reservation,
          signal: childSignal,
          subagentRunId,
          dispatchBudget
        }),
        {
          text: async delta => {
            if (childSignal.aborted) throw childSignal.reason
            if (typeof delta !== 'string' || delta.length === 0 || content.length + delta.length > reservation.outputCharacters)
              throw new AgentRepositoryError('AGENT_CHILD_BUDGET_EXCEEDED', 'Subagent output exceeded its reserved allowance', 409)
            content += delta
          },
          event: async (type, data) => {
            if (childSignal.aborted) throw childSignal.reason
            const contextualData = { ...data, rootRunId: claim.id, taskId: task.id, subagentRunId }
            if (type === 'model.turn') {
              let turnUsage
              try {
                turnUsage = readAgentUsageEvent(data)
              } catch {
                throw new AgentRepositoryError('AGENT_CHILD_BUDGET_INVALID', 'Subagent token usage telemetry is invalid', 500)
              }
              const nextConsumedTotalTokens = safeUsageSum(consumed.totalTokens, turnUsage.totalTokens, 'Consumed child total tokens')
              if (nextConsumedTotalTokens > reservation.totalTokens)
                throw new AgentRepositoryError('AGENT_CHILD_BUDGET_EXCEEDED', 'Subagent token usage exceeded its reserved allowance', 409)
              consumed.totalTokens = nextConsumedTotalTokens
              const turnContent = Reflect.get(data, 'content')
              if (typeof turnContent !== 'string') throw new AgentRepositoryError('AGENT_CHILD_BUDGET_INVALID', 'Subagent output telemetry is invalid', 500)
              const turnOutputCharacters = Reflect.get(data, 'contentTruncated') === true ? reservation.outputCharacters + 1 : turnContent.length
              const remainingOutputCharacters = reservation.outputCharacters - consumed.outputCharacters
              if (turnOutputCharacters > remainingOutputCharacters) {
                consumed.outputCharacters = reservation.outputCharacters
                const limited: Record<string, AgentEventData[string]> = {
                  ...contextualData,
                  content: turnContent.slice(0, Math.max(0, remainingOutputCharacters)),
                  contentTruncated: true,
                  budgetOutputCharacters: Math.max(0, remainingOutputCharacters)
                }
                if (data.outcome === 'context_compacted') {
                  limited.outcome = 'context_compaction_rejected'
                  limited.content = ''
                  delete limited.compaction
                }
                await this.#appendPresentationEvent(claim, type, limited)
                throw new AgentRepositoryError('AGENT_CHILD_BUDGET_EXCEEDED', 'Subagent output exceeded its reserved allowance', 409)
              }
              consumed.outputCharacters = safeUsageSum(consumed.outputCharacters, turnOutputCharacters, 'Consumed child output characters')
            }
            if (type === 'tool.completed') {
              const evidence = persistedResearchEvidence(contextualData, startedTask)
              if (evidence !== null) {
                for (const [evidenceId, revision] of evidence.revisions) evidenceRevisions.set(evidenceId, revision)
              }
            }
            await this.#appendPresentationEvent(claim, type, contextualData)
          }
        }
      )
      usage = {
        inputTokens: nonNegativeUsage(result.inputTokens, 'Subagent input tokens'),
        outputTokens: nonNegativeUsage(result.outputTokens, 'Subagent output tokens'),
        totalTokens: nonNegativeUsage(result.totalTokens, 'Subagent total tokens'),
        costMicros: nonNegativeUsage(result.costMicros, 'Subagent cost')
      }
      assertAgentTokenUsage(usage.inputTokens, usage.outputTokens, usage.totalTokens)
      if (usage.totalTokens !== consumed.totalTokens)
        throw new AgentRepositoryError('AGENT_CHILD_BUDGET_INVALID', 'Subagent aggregate usage does not match its turn telemetry', 500)
      if (consumed.totalTokens > reservation.totalTokens)
        throw new AgentRepositoryError('AGENT_CHILD_BUDGET_EXCEEDED', 'Subagent token usage exceeded its reserved allowance', 409)
      if (content.length > reservation.outputCharacters)
        throw new AgentRepositoryError('AGENT_CHILD_BUDGET_EXCEEDED', 'Subagent output exceeded its reserved allowance', 409)
      const packet = result.outputLimited
        ? canonicalJson({
            taskId: startedTask.id,
            outcome: 'blocked',
            claims: [],
            conflicts: [],
            unanswered: ['AGENT_OUTPUT_LIMITED: The provider output limit prevented completion of this research task.'],
            recommendedFollowups: ['Explicitly retry or narrow the research task.']
          })
        : content
      const validated = validateChildEvidencePacket(packet, researchTask(startedTask), evidenceRevisions)
      await finishAgentRunTask(this.#knex, claim, startedTask.id, subagentRunId, validated, result.authoritySha256 ?? null)
      return usage
    } catch (error) {
      if (signal.aborted) throw error
      if (activeTask === undefined) throw error
      const legacyCode =
        error instanceof AgentExecutionFailure
          ? null
          : typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string'
            ? String(Reflect.get(error, 'code'))
            : null
      const errorCode = childSignal.aborted
        ? 'SUBAGENT_TIMEOUT'
        : error instanceof AgentExecutionFailure
          ? error.code
          : legacyCode === 'AGENT_BUDGET_LIMITED' || legacyCode === 'AGENT_TOKEN_BUDGET_LIMITED' || legacyCode === 'AGENT_CHILD_BUDGET_EXCEEDED'
            ? legacyCode
            : 'SUBAGENT_FAILED'
      try {
        await failAgentRunTask(this.#knex, claim, activeTask.id, subagentRunId, errorCode)
      } catch (taskError) {
        if (typeof taskError === 'object' && taskError !== null && Reflect.get(taskError, 'code') !== 'AGENT_TASK_STATE_CHANGED') throw taskError
      }
      if (errorCode === 'AGENT_BUDGET_LIMITED' || errorCode === 'AGENT_TOKEN_BUDGET_LIMITED') throw error
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
    knowledgeContext: AgentKnowledgeContext | undefined,
    budget: AgentChildBudgetUsage,
    signal: AbortSignal,
    dispatchBudget: AgentDispatchBudget
  ): Promise<AgentUsageTotals> {
    const pending = tasks.filter(task => task.status === 'pending')
    const totals: AgentUsageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 }
    if (pending.length === 0) return totals
    const reservations = new AgentChildBudgetReservations(this.#orchestration, budget)
    const concurrency = Math.min(this.#orchestration.maxConcurrentChildren, pending.length)
    let cursor = 0
    while (cursor < pending.length) {
      const batch: Array<{ readonly task: AgentTaskRecord; readonly reservation: AgentChildBudgetReservation }> = []
      const batchCapacity = Math.min(concurrency, pending.length - cursor)
      while (batch.length < batchCapacity) {
        const task = pending[cursor]
        if (!task) break
        const reservation = reservations.reserve(batchCapacity - batch.length)
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
      const settlements = await Promise.allSettled(
        batch.map(({ task, reservation }) =>
          this.#executeResearchTask(claim, task, memory, skills, currentPage, knowledgeContext, reservations, reservation, signal, dispatchBudget)
        )
      )
      const rejected = settlements.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
      const usages = settlements.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
      for (const taskUsage of usages) {
        totals.inputTokens = safeUsageSum(totals.inputTokens, taskUsage.inputTokens, 'Child input tokens')
        totals.outputTokens = safeUsageSum(totals.outputTokens, taskUsage.outputTokens, 'Child output tokens')
        totals.totalTokens = safeUsageSum(totals.totalTokens, taskUsage.totalTokens, 'Child total tokens')
        totals.costMicros = safeUsageSum(totals.costMicros, taskUsage.costMicros, 'Child cost')
      }
    }
    return totals
  }

  async #researchContext(claim: AgentRunClaim, tasks: readonly AgentTaskRecord[]): Promise<AgentResearchSynthesisContext> {
    const eventRows = (await this.#knex('agentEvents')
      .where({ runId: claim.id, type: 'tool.completed' })
      .orderBy('sequence')
      .select('data', 'dataSha256')) as Array<{ data: string; dataSha256: string }>
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
      return [
        {
          task: researchTask(task),
          packet: validated.packet,
          evidenceIds: validated.evidenceIds,
          conflictEvidenceGroups: validated.conflictEvidenceGroups
        }
      ]
    })
    const incompleteTasks = tasks.flatMap(task =>
      task.status === 'blocked' || task.status === 'failed' || task.status === 'cancelled'
        ? [
            {
              taskId: task.id,
              title: task.title,
              status: task.status,
              outcome: task.outcome,
              errorCode: task.errorCode
            }
          ]
        : []
    )
    return { packets, incompleteTasks, evidenceSeeds }
  }

  async #execute(
    claim: AgentRunClaim,
    signal: AbortSignal
  ): Promise<{ status: 'succeeded' | 'partial' | 'failed'; errorCode?: string; errorMessage?: string }> {
    let content = ''
    let quotaReconciled = false
    const orchestrationUsage: AgentUsageTotals = zeroUsage()
    let dispatchBudget: AgentRunDispatchBudget | undefined
    let goalBudgetClassification: AgentGoalBudgetClassificationResult | null = null
    let classifierUsageForSettlement: AgentUsageTotals = zeroUsage()
    let goalDeadlineAt: number | null = null
    let goalDeadlineTimer: NodeJS.Timeout | undefined
    try {
      let goal = claim.goalId === null ? null : await getOwnedAgentGoal(this.#knex, claim.ownerId, claim.goalId)
      if (goal !== null) {
        const { checkpoints } = await this.#goalBudgetCheckpoints(this.#knex, goal)
        const currentCheckpoint = checkpoints.find(checkpoint => checkpoint.runId === claim.id)
        classifierUsageForSettlement = currentCheckpoint === undefined ? zeroUsage() : { ...currentCheckpoint.classifier }
      }
      goalDeadlineAt = goal === null ? null : new Date(goal.deadlineAt).valueOf()
      const deadlineRemaining = goalDeadlineAt === null ? null : goalDeadlineAt - Date.now()
      if (deadlineRemaining !== null && deadlineRemaining <= 0) throw new AgentRepositoryError('AGENT_BUDGET_LIMITED', 'Agent goal deadline was reached', 409)
      let executionSignal = signal
      if (deadlineRemaining !== null) {
        const deadline = new AbortController()
        goalDeadlineTimer = setTimeout(
          () => deadline.abort(new AgentRepositoryError('AGENT_BUDGET_LIMITED', 'Agent goal deadline was reached', 409)),
          deadlineRemaining
        )
        goalDeadlineTimer.unref()
        executionSignal = AbortSignal.any([signal, deadline.signal])
      }
      const [messageRows, skills, contextRow, sessionRow, priorEventRows] = await Promise.all([
        this.#knex('agentMessages as messages')
          .leftJoin('agentRuns as originRuns', function () {
            this.on('originRuns.id', '=', 'messages.runId').andOn('originRuns.sessionId', '=', 'messages.sessionId')
          })
          .where('messages.sessionId', claim.sessionId)
          .andWhere('messages.id', '!=', claim.assistantMessageId)
          .andWhere(visible => visible.where('messages.isVisible', true).orWhereNull('messages.isVisible').orWhere('messages.id', claim.userMessageId))
          .orderBy('messages.ordinal')
          .select({
            id: 'messages.id',
            ordinal: 'messages.ordinal',
            citations: 'messages.citations',
            isVisible: 'messages.isVisible',
            createdAt: 'messages.createdAt',
            role: 'messages.role',
            content: 'messages.content',
            googleSearchGrounding: 'messages.googleSearchGrounding',
            runId: 'messages.runId',
            providerStateCiphertext: 'messages.providerStateCiphertext',
            providerStateSha256: 'messages.providerStateSha256',
            originOwnerId: 'originRuns.ownerId',
            originSessionId: 'originRuns.sessionId',
            originProviderProfileVersionId: 'originRuns.providerProfileVersionId',
            originTransportKind: 'originRuns.transportKind',
            originModel: 'originRuns.model',
            originCapabilityRevision: 'originRuns.capabilityRevision'
          }) as unknown as Promise<RuntimeMessageRow[]>,
        this.#knex('agentRunSkills')
          .join('agentSkillVersions', 'agentSkillVersions.id', 'agentRunSkills.skillVersionId')
          .join('agentSkills', 'agentSkills.id', 'agentSkillVersions.skillId')
          .where('agentRunSkills.runId', claim.id)
          .orderBy('agentRunSkills.ordinal')
          .select('agentSkillVersions.id', 'agentSkills.name', 'agentSkillVersions.skillMarkdown') as unknown as Promise<RuntimeSkillRow[]>,
        this.#knex('agentEvents').where({ runId: claim.id, type: 'run.queued' }).orderBy('sequence').first('data') as unknown as Promise<
          RuntimeContextRow | undefined
        >,
        this.#knex('agentSessions')
          .where({ id: claim.sessionId, ownerId: claim.ownerId })
          .whereNull('deletedAt')
          .first('memorySnapshot', 'title', 'titleSource', 'version') as unknown as Promise<RuntimeSessionRow | undefined>,
        this.#knex('agentRuns as runs')
          .join('agentMessages as userMessages', 'userMessages.id', 'runs.userMessageId')
          .join('agentMessages as assistantMessages', 'assistantMessages.id', 'runs.assistantMessageId')
          .join('agentEvents as events', 'events.runId', 'runs.id')
          .where('runs.sessionId', claim.sessionId)
          .andWhere('runs.id', '!=', claim.id)
          .whereIn('events.type', ['model.turn', 'evidence.provenance', 'tool.started', 'tool.completed', 'tool.notExecuted', 'tool.failed'])
          .orderBy('runs.queuedAt', 'desc')
          .orderBy('events.sequence', 'desc')
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
      const generationTools = generationToolsHint(contextRow?.data)
      const knowledgeContext = knowledgeContextHint(contextRow?.data)
      const memory = decodeAgentMemorySnapshot(sessionRow.memorySnapshot)
      const priorActivity = priorRunActivity([...priorEventRows].reverse())
      const mediaIndex = messageRows.length
        ? await this.#knex<AgentMediaMetadata>('agentMedia')
            .where({ ownerId: claim.ownerId, sessionId: claim.sessionId })
            .whereIn(
              'messageId',
              messageRows.map(row => row.id)
            )
            .orderBy('createdAt', 'desc')
            .select(...AGENT_MEDIA_METADATA_COLUMNS)
        : []
      const modelTurnRows = (await this.#knex('agentEvents as events')
        .join('agentRuns as runs', 'runs.id', 'events.runId')
        .where({ 'runs.ownerId': claim.ownerId, 'runs.sessionId': claim.sessionId, 'events.type': 'model.turn' })
        .orderBy('events.createdAt', 'desc')
        .orderBy('events.sequence', 'desc')
        .select('events.runId', 'events.data', 'events.dataSha256')) as Array<{
        runId: string
        data: string
        dataSha256: string
      }>
      const inheritedExpiryByRun = new Map<string, string | null>()
      const checkpointCandidates: AgentCompactionCheckpoint[] = []
      for (const row of modelTurnRows) {
        if (sha256(row.data) !== row.dataSha256) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored model event hash is invalid', 500)
        const data = parsedObject(row.data, 'AGENT_EVENT_CORRUPT') as AgentEventData
        if (Object.hasOwn(data, 'groundedExpiresAt')) {
          const value = Reflect.get(data, 'groundedExpiresAt')
          if (value !== null && typeof value !== 'string') throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored model event expiry is invalid', 500)
          inheritedExpiryByRun.set(row.runId, agentCompactionMinimumExpiry(inheritedExpiryByRun.get(row.runId), value as string | null))
        }
        const checkpoint = typeof data.taskId === 'string' || typeof data.subagentRunId === 'string' ? null : readAgentCompactionCheckpoint(data)
        if (checkpoint !== null) {
          if (
            checkpoint.metadata.sourceRunId !== row.runId ||
            checkpoint.metadata.ownerId !== claim.ownerId ||
            checkpoint.metadata.sessionId !== claim.sessionId
          )
            throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored compaction producer binding is invalid', 500)
          readAgentUsageEvent(data)
          checkpointCandidates.push(checkpoint)
        }
      }
      const canonicalSources = messageRows.map(message =>
        runtimeCanonicalSource(
          message,
          mediaIndex.filter(item => item.messageId === message.id),
          message.role !== 'assistant' || message.runId === null ? null : (inheritedExpiryByRun.get(message.runId) ?? null)
        )
      )
      const sourcePrefixSha256 = agentCompactionSourcePrefixes(canonicalSources)
      const binding = {
        ownerId: claim.ownerId,
        sessionId: claim.sessionId,
        providerProfileVersionId: claim.providerProfileVersionId,
        transportKind: claim.transportKind,
        model: claim.model,
        capabilityRevision: claim.capabilityRevision
      }
      const nowMilliseconds = Date.now()
      const checkpoint = checkpointCandidates.find(candidate => {
        if (!agentCompactionBindingMatches(candidate.metadata, binding)) return false
        if (candidate.metadata.groundedExpiresAt !== null && Date.parse(candidate.metadata.groundedExpiresAt) <= nowMilliseconds) return false
        const index = canonicalSources.findIndex(
          source => source.id === candidate.metadata.throughMessageId && source.ordinal === candidate.metadata.throughOrdinal
        )
        return index >= 0 && sourcePrefixSha256[index] === candidate.metadata.sourceSha256
      })
      const effectiveGroundedExpiresAt = agentCompactionMinimumExpiry(
        ...canonicalSources.map(source =>
          source.groundedExpiresAt !== null && Date.parse(source.groundedExpiresAt) > nowMilliseconds ? source.groundedExpiresAt : null
        )
      )
      const compactionContext: AgentCompactionContext = {
        ...(checkpoint === undefined ? {} : { checkpoint }),
        sourcePrefixSha256,
        groundedExpiresAt: effectiveGroundedExpiresAt
      }
      const mediaRequest = claim.mediaRequest ? (JSON.parse(claim.mediaRequest) as { kind: 'image' | 'transcription' | 'video' | 'music' }) : undefined
      if (mediaRequest && !['image', 'transcription', 'video', 'music'].includes(mediaRequest.kind))
        throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Invalid media request.', 500)
      if (mediaRequest)
        await assertAgentMediaCapability(
          this.#knex,
          claim.providerProfileVersionId,
          mediaRequest.kind === 'image'
            ? 'imageGeneration'
            : mediaRequest.kind === 'video'
              ? 'videoGeneration'
              : mediaRequest.kind === 'music'
                ? 'musicGeneration'
                : 'transcription'
        )
      let includeMediaBytes = true
      if (!mediaRequest && mediaIndex.length) {
        try {
          await assertAgentMediaCapability(this.#knex, claim.providerProfileVersionId, 'attachments')
        } catch (error) {
          if (!(error instanceof AgentRepositoryError) || error.code !== 'AGENT_MEDIA_DISABLED') throw error
          includeMediaBytes = false
        }
      }
      const attachedRows = includeMediaBytes ? mediaIndex.filter(row => row.kind !== 'generated-video' && row.kind !== 'generated-audio') : []
      if (
        attachedRows.length > AGENT_MEDIA_PROMPT_MAX_FILES ||
        attachedRows.reduce((total, row) => total + Number(row.byteLength), 0) > AGENT_MEDIA_PROMPT_MAX_BYTES
      )
        throw new AgentRepositoryError(
          'AGENT_MEDIA_WINDOW_LIMIT',
          'This conversation exceeds the attachment window of 16 files or 1 GB. Start a new chat with the files needed for this request.',
          413
        )
      if (!includeMediaBytes && mediaIndex.some(row => row.messageId === claim.userMessageId && row.kind === 'attachment'))
        throw new AgentRepositoryError('AGENT_MEDIA_DISABLED', 'Attachments are disabled for this provider. Select a provider with attachments enabled.', 403)
      const retainedMediaIds = attachedRows.map(row => row.id)
      const messages: AgentEngineMessage[] = messageRows.map((message, index) => {
        const canonicalSource = canonicalSources[index]!
        const expired = canonicalSource.groundedExpiresAt !== null && Date.parse(canonicalSource.groundedExpiresAt) <= nowMilliseconds
        const stateOriginMatches =
          message.role === 'assistant' &&
          message.runId !== null &&
          message.originOwnerId === claim.ownerId &&
          message.originSessionId === claim.sessionId &&
          message.originProviderProfileVersionId === claim.providerProfileVersionId &&
          message.originTransportKind === claim.transportKind &&
          message.originModel === claim.model &&
          message.originCapabilityRevision === claim.capabilityRevision &&
          !expired
        let state: AgentEngineMessage['providerState']
        if (stateOriginMatches) {
          try {
            state = providerState(message.providerStateCiphertext, message.providerStateSha256, continuationDialectForTransport(claim.transportKind))
          } catch (error) {
            throw classifyAgentExecutionFailure(error, 'setup')
          }
        }
        const attachments = expired
          ? []
          : attachedRows.filter(row => row.messageId === message.id).map(row => ownedAgentMediaSource(this.#knex, claim.ownerId, claim.sessionId, row))
        return {
          canonicalSource,
          role: message.role,
          content:
            (expired ? '' : message.content) +
            (!expired && mediaIndex.some(item => item.messageId === message.id && !retainedMediaIds.includes(item.id))
              ? '\n[Attachment content is unavailable in this turn because of the media window or provider configuration. Do not infer its contents.]'
              : ''),
          ...(state ? { providerState: state } : {}),
          ...(attachments.length ? { attachments } : {})
        }
      })
      const continuation = await readAgentApprovalContinuation(this.#knex, claim)
      let orchestrationTelemetry = await this.#orchestrationTelemetry(claim)
      const persistedProviderUsage = {
        inputTokens: safeUsageSum(
          safeUsageSum(orchestrationTelemetry.usage.inputTokens, orchestrationTelemetry.modelUsage.inputTokens, 'Persisted provider input tokens'),
          classifierUsageForSettlement.inputTokens,
          'Persisted provider input tokens'
        ),
        outputTokens: safeUsageSum(
          safeUsageSum(orchestrationTelemetry.usage.outputTokens, orchestrationTelemetry.modelUsage.outputTokens, 'Persisted provider output tokens'),
          classifierUsageForSettlement.outputTokens,
          'Persisted provider output tokens'
        ),
        totalTokens: safeUsageSum(
          safeUsageSum(orchestrationTelemetry.usage.totalTokens, orchestrationTelemetry.modelUsage.totalTokens, 'Persisted provider total tokens'),
          classifierUsageForSettlement.totalTokens,
          'Persisted provider total tokens'
        ),
        costMicros: safeUsageSum(
          safeUsageSum(orchestrationTelemetry.usage.costMicros, orchestrationTelemetry.modelUsage.costMicros, 'Persisted provider cost'),
          classifierUsageForSettlement.costMicros,
          'Persisted provider cost'
        )
      }
      const startingGoalUsage = goal === null ? null : await this.#goalUsage(this.#knex, goal.id, claim.id)
      let startingGoalTokens = goal === null ? undefined : goal.maxTokens - (startingGoalUsage?.tokens ?? 0)
      const startingGoalToolCalls = goal === null ? undefined : goal.maxToolCalls - (startingGoalUsage?.toolCalls ?? 0)
      if (startingGoalToolCalls !== undefined && startingGoalToolCalls <= 0)
        throw new AgentRepositoryError('AGENT_BUDGET_LIMITED', 'Agent goal action budget was exhausted', 409)
      dispatchBudget = new AgentRunDispatchBudget(this.#knex, claim, startingGoalTokens, startingGoalToolCalls, persistedProviderUsage)
      if (goal !== null && goal.budgetSelection === 'pending') {
        const selected = await this.#classifyGoalBudget(goal, claim, executionSignal, dispatchBudget)
        goal = selected.goal
        goalBudgetClassification = selected.classification
        classifierUsageForSettlement = {
          inputTokens: selected.classification.inputTokens,
          outputTokens: selected.classification.outputTokens,
          totalTokens: selected.classification.totalTokens,
          costMicros: selected.classification.costMicros
        }
        startingGoalTokens = goal.maxTokens - (startingGoalUsage?.tokens ?? 0)
        dispatchBudget.setMaximumTokens(Math.max(0, startingGoalTokens))
        startingGoalTokens = Math.max(0, startingGoalTokens - dispatchBudget.consumed.totalTokens)
      }
      if (startingGoalTokens !== undefined && startingGoalTokens < 1)
        throw new AgentRepositoryError('AGENT_TOKEN_BUDGET_LIMITED', 'Agent goal token budget was exhausted', 409)
      if (claim.status === 'awaiting_approval' && continuation === null) {
        throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_MISSING', 'Awaiting approval run has no durable action continuation', 500)
      }
      const groundingRetention =
        mediaRequest === undefined && (claim.googleSearchEnabled || messageRows.some(message => message.googleSearchGrounding !== null))
          ? canonicalJson({ citations: [] })
          : null
      if (continuation === null) {
        await this.#appendPresentationEvent(claim, 'run.attemptStarted', { runId: claim.id, attempt: claim.attempts })
        if (claim.attempts > 1)
          await this.#appendPresentationEvent(claim, 'run.attemptSuperseded', { runId: claim.id, supersededThroughAttempt: claim.attempts - 1 })
        await this.#appendPresentationEvent(
          claim,
          'message.started',
          { messageId: claim.assistantMessageId },
          { status: 'streaming', content: '', citations: null, googleSearchGrounding: groundingRetention }
        )
        await recoverAgentRunTasks(this.#knex, claim)
      }
      let tasks = await listAgentRunTasks(this.#knex, claim.id)
      if (continuation === null) {
        if ((!this.#orchestration.enabled || claim.executionMode !== 'agent') && tasks.some(task => task.status === 'pending' || task.status === 'running')) {
          await cancelAgentRunTasks(this.#knex, claim, 'ORCHESTRATION_DISABLED', 'Subagent orchestration is disabled')
          tasks = await listAgentRunTasks(this.#knex, claim.id)
        }
        const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')?.content ?? ''
        if (
          !mediaRequest &&
          this.#orchestration.enabled &&
          claim.executionMode === 'agent' &&
          tasks.length === 0 &&
          !orchestrationTelemetry.planRejected &&
          shouldPlanAgentResearch(latestUserMessage)
        ) {
          tasks = (
            await this.#planResearch(
              claim,
              latestUserMessage,
              currentPage,
              knowledgeContext,
              memory,
              skills,
              orchestrationTelemetry.budget,
              executionSignal,
              dispatchBudget,
              startingGoalTokens
            )
          ).tasks
        }
      }
      if (continuation === null && this.#orchestration.enabled && claim.executionMode === 'agent' && tasks.some(task => task.status === 'pending')) {
        await this.#executeResearchTasks(
          claim,
          tasks,
          memory,
          skills,
          currentPage,
          knowledgeContext,
          orchestrationTelemetry.budget,
          executionSignal,
          dispatchBudget
        )
      }
      tasks = await listAgentRunTasks(this.#knex, claim.id)
      orchestrationTelemetry = await this.#orchestrationTelemetry(claim)
      orchestrationUsage.inputTokens = orchestrationTelemetry.usage.inputTokens
      orchestrationUsage.outputTokens = orchestrationTelemetry.usage.outputTokens
      orchestrationUsage.totalTokens = orchestrationTelemetry.usage.totalTokens
      orchestrationUsage.costMicros = orchestrationTelemetry.usage.costMicros
      const research = tasks.length === 0 ? undefined : await this.#researchContext(claim, tasks)
      const goalUsage = goal === null ? null : await this.#goalUsage(this.#knex, goal.id, claim.id)
      const currentRunEventTokens = safeUsageSum(
        orchestrationTelemetry.usage.totalTokens,
        orchestrationTelemetry.modelUsage.totalTokens,
        'Current run event tokens'
      )
      const remainingGoalTokens =
        goal === null ? null : goal.maxTokens - (goalUsage?.tokens ?? 0) - Math.max(currentRunEventTokens, dispatchBudget?.consumed.totalTokens ?? 0)
      const remainingGoalToolCalls = goal === null ? null : goal.maxToolCalls - (goalUsage?.toolCalls ?? 0)
      if (remainingGoalToolCalls !== null && remainingGoalToolCalls <= 0)
        throw new AgentRepositoryError('AGENT_BUDGET_LIMITED', 'Agent goal action budget was exhausted', 409)
      if (remainingGoalTokens !== null && remainingGoalTokens < 1)
        throw new AgentRepositoryError('AGENT_TOKEN_BUDGET_LIMITED', 'Agent goal token budget was exhausted', 409)
      const authorizeMedia = async (): Promise<void> => {
        executionSignal.throwIfAborted()
        if (!this.#authorizeMedia) throw new AgentRepositoryError('AGENT_MEDIA_DISABLED', 'Media authorization is unavailable.', 403)
        await this.#authorizeMedia(claim.ownerId)
        await this.#knex.transaction(async transaction => {
          const current = await this.#resolver.resolveCurrent(transaction, { ownerId: claim.ownerId, sessionId: claim.sessionId })
          if (current.providerProfileVersionId !== claim.providerProfileVersionId || current.executionMode !== claim.executionMode)
            throw new AgentRepositoryError('PROFILE_VERSION_CHANGED', 'Provider settings changed. Send the request again.', 409)
          const active = await transaction('agentRuns')
            .where({ id: claim.id, ownerId: claim.ownerId, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
            .whereIn('status', ['running', 'awaiting_approval'])
            .whereNull('cancelRequestedAt')
            .first('id')
          if (!active) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost.', 409)
        })
        executionSignal.throwIfAborted()
      }
      const googleSearchEnabled = mediaRequest === undefined && claim.googleSearchEnabled
      let googleSearchSuggestions: readonly string[] | undefined
      const engineRequest: AgentEngineRequest = {
        compaction: compactionContext,
        ...(generationTools === undefined ? {} : { generationTools }),
        authorizeMedia,
        ...(mediaRequest ? { mediaRequest } : {}),
        run: claim,
        purpose: 'root',
        googleSearchEnabled,
        messages,
        memory,
        skills,
        priorActivity,
        dispatchBudget,
        signal: executionSignal,
        ...(remainingGoalTokens === null || remainingGoalToolCalls === null
          ? {}
          : {
              limits: {
                maxTokens: remainingGoalTokens,
                maxTurns: 12,
                maxToolCalls: Math.min(32, remainingGoalToolCalls),
                maxOutputTokens: Math.min(32_768, remainingGoalTokens)
              }
            }),
        ...(research === undefined ? {} : { research }),
        ...(currentPage === undefined ? {} : { currentPage }),
        ...(knowledgeContext === undefined ? {} : { knowledgeContext })
      }
      const assertGroundedContextFresh = (): void => {
        if (effectiveGroundedExpiresAt !== null && Date.parse(effectiveGroundedExpiresAt) <= Date.now())
          throw new AgentRepositoryError('AGENT_CONTEXT_TOO_LARGE', 'Retained source context has expired; restart this turn from available history', 413)
      }
      const sink: AgentEngineSink = {
        commitCompaction: async receipt => {
          executionSignal.throwIfAborted()
          const metadata = readAgentCompactionMetadata(receipt.compaction)
          const storedCheckpoint = readAgentCompactionCheckpoint(receipt as unknown as AgentEventData)
          if (
            storedCheckpoint === null ||
            metadata.scope !== 'history' ||
            metadata.sourceRunId !== claim.id ||
            !agentCompactionBindingMatches(metadata, binding) ||
            receipt.outcome !== 'context_compacted' ||
            receipt.usageVersion !== 2 ||
            receipt.contentTruncated !== false ||
            receipt.actionCallIds.length !== 0 ||
            receipt.groundedExpiresAt !== metadata.groundedExpiresAt ||
            agentCompactionSha256(receipt.content) !== metadata.summarySha256
          )
            throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Inference engine emitted invalid compaction metadata', 500)
          readAgentUsageEvent(receipt as unknown as AgentEventData)
          const throughIndex = canonicalSources.findIndex(source => source.id === metadata.throughMessageId && source.ordinal === metadata.throughOrdinal)
          if (throughIndex < 0 || sourcePrefixSha256[throughIndex] !== metadata.sourceSha256)
            throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Inference engine compacted a non-canonical source prefix', 500)
          await this.#knex.transaction(async transaction => {
            const expectedSources = canonicalSources.slice(0, throughIndex + 1)
            const rows = (await transaction('agentMessages as messages')
              .leftJoin('agentRuns as originRuns', function () {
                this.on('originRuns.id', '=', 'messages.runId').andOn('originRuns.sessionId', '=', 'messages.sessionId')
              })
              .where('messages.sessionId', claim.sessionId)
              .andWhere('messages.ordinal', '<=', metadata.throughOrdinal)
              .andWhere('messages.id', '!=', claim.assistantMessageId)
              .andWhere(visible => visible.where('messages.isVisible', true).orWhereNull('messages.isVisible').orWhere('messages.id', claim.userMessageId))
              .orderBy('messages.ordinal')
              .select({
                id: 'messages.id',
                ordinal: 'messages.ordinal',
                role: 'messages.role',
                content: 'messages.content',
                citations: 'messages.citations',
                isVisible: 'messages.isVisible',
                createdAt: 'messages.createdAt',
                googleSearchGrounding: 'messages.googleSearchGrounding',
                runId: 'messages.runId',
                providerStateCiphertext: 'messages.providerStateCiphertext',
                providerStateSha256: 'messages.providerStateSha256',
                originOwnerId: 'originRuns.ownerId',
                originSessionId: 'originRuns.sessionId',
                originProviderProfileVersionId: 'originRuns.providerProfileVersionId',
                originTransportKind: 'originRuns.transportKind',
                originModel: 'originRuns.model',
                originCapabilityRevision: 'originRuns.capabilityRevision'
              })) as RuntimeMessageRow[]
            if (rows.length !== expectedSources.length || rows.some((row, index) => row.id !== expectedSources[index]!.id || row.isVisible === false))
              throw new AgentRepositoryError('AGENT_COMPACTION_SOURCE_CHANGED', 'Compaction source changed while summarizing', 409)
            const currentMedia = (await transaction<AgentMediaMetadata>('agentMedia')
              .where({ ownerId: claim.ownerId, sessionId: claim.sessionId })
              .whereIn(
                'messageId',
                rows.map(row => row.id)
              )
              .select(...AGENT_MEDIA_METADATA_COLUMNS)) as AgentMediaMetadata[]
            const sourceRunIds = rows.flatMap(row => (row.runId === null ? [] : [row.runId]))
            const currentExpiryByRun = new Map<string, string | null>()
            if (sourceRunIds.length > 0) {
              const expiryEvents = (await transaction('agentEvents')
                .whereIn('runId', sourceRunIds)
                .where({ type: 'model.turn' })
                .select('runId', 'data', 'dataSha256')) as Array<{ runId: string; data: string; dataSha256: string }>
              for (const event of expiryEvents) {
                if (sha256(event.data) !== event.dataSha256) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored model event hash is invalid', 500)
                const data = parsedObject(event.data, 'AGENT_EVENT_CORRUPT')
                if (!Object.hasOwn(data, 'groundedExpiresAt')) continue
                const value = Reflect.get(data, 'groundedExpiresAt')
                if (value !== null && typeof value !== 'string')
                  throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored model event expiry is invalid', 500)
                currentExpiryByRun.set(event.runId, agentCompactionMinimumExpiry(currentExpiryByRun.get(event.runId), value as string | null))
              }
            }
            const currentSources = rows.map(row =>
              runtimeCanonicalSource(
                row,
                currentMedia.filter(item => item.messageId === row.id),
                row.role !== 'assistant' || row.runId === null ? null : (currentExpiryByRun.get(row.runId) ?? null)
              )
            )
            const currentPrefix = agentCompactionSourcePrefixes(currentSources)
            if (
              currentPrefix.at(-1) !== metadata.sourceSha256 ||
              currentSources.some((source, index) => canonicalJson(source) !== canonicalJson(expectedSources[index]))
            )
              throw new AgentRepositoryError('AGENT_COMPACTION_SOURCE_CHANGED', 'Compaction source changed while summarizing', 409)
            const currentExpiry = agentCompactionMinimumExpiry(
              ...currentSources
                .filter(
                  (source, index) =>
                    (source.groundedExpiresAt === null || Date.parse(source.groundedExpiresAt) > nowMilliseconds) &&
                    (rows[index]!.content.length > 0 || currentMedia.some(item => item.messageId === source.id))
                )
                .map(source => source.groundedExpiresAt)
            )
            if (currentExpiry !== metadata.groundedExpiresAt || (currentExpiry !== null && Date.parse(currentExpiry) <= Date.now()))
              throw new AgentRepositoryError('AGENT_COMPACTION_SOURCE_EXPIRED', 'Compaction source expired while summarizing', 409)
            await this.#appendPresentationEventInTransaction(transaction, claim, 'model.turn', receipt as unknown as AgentEventData)
          })
        },
        media: async images => {
          if (images.length > 4) throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Too many generated media files.', 502)
          for (const image of images) {
            executionSignal.throwIfAborted()
            const fenced = await this.#knex('agentRuns')
              .where({ id: claim.id, ownerId: claim.ownerId, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
              .whereNull('cancelRequestedAt')
              .first('id')
            if (!fenced) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost.', 409)
            await storeAgentMedia(this.#knex, {
              ...image,
              ownerId: claim.ownerId,
              sessionId: claim.sessionId,
              messageId: claim.assistantMessageId,
              runId: claim.id,
              leaseOwner: claim.leaseOwner,
              leaseToken: claim.leaseToken,
              kind: image.kind ?? 'generated-image'
            })
          }
        },
        text: async delta => {
          if (executionSignal.aborted) throw executionSignal.reason
          assertGroundedContextFresh()
          if (typeof delta !== 'string' || delta.length === 0 || delta.length > 16_000 || content.length + delta.length > 128_000)
            throw new AgentRepositoryError('INVALID_ENGINE_DELTA', 'Inference engine emitted an invalid text delta', 500)
          content += delta
          await this.#appendPresentationEvent(claim, 'message.delta', { messageId: claim.assistantMessageId, delta }, { status: 'streaming', content })
        },
        event: async (type, data) => {
          if (executionSignal.aborted) throw executionSignal.reason
          let persisted = data
          if (type === 'model.turn') {
            const suppliedExpiry = Reflect.get(data, 'groundedExpiresAt')
            if (suppliedExpiry !== undefined && suppliedExpiry !== null && typeof suppliedExpiry !== 'string')
              throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Inference engine emitted an invalid grounding expiry', 500)
            const groundedExpiresAt = agentCompactionMinimumExpiry(effectiveGroundedExpiresAt, typeof suppliedExpiry === 'string' ? suppliedExpiry : null)
            persisted = {
              ...data,
              groundedExpiresAt,
              ...(groundedExpiresAt !== null && Date.parse(groundedExpiresAt) <= Date.now() ? { content: '', contentPurged: true } : {})
            }
          }
          await this.#appendPresentationEvent(claim, type, persisted)
        },
        googleSearchSuggestions: async suggestions => {
          if (executionSignal.aborted) throw executionSignal.reason
          assertGroundedContextFresh()
          if (!googleSearchEnabled)
            throw new AgentRepositoryError(
              'INVALID_ENGINE_RESULT',
              'Inference engine emitted Google Search suggestions when search was disabled for this dispatch',
              500
            )
          if (googleSearchSuggestions !== undefined)
            throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Inference engine emitted Google Search suggestions more than once', 500)
          googleSearchSuggestions = [...suggestions]
        }
      }
      if (mediaRequest || attachedRows.length) await authorizeMedia()
      const result =
        continuation === null
          ? await this.#engine.execute(engineRequest, sink)
          : await (this.#engine.resumeAction?.(engineRequest, continuation, sink) ??
              Promise.reject(
                new AgentRepositoryError('AGENT_ACTION_CONTINUATION_UNSUPPORTED', 'Inference engine cannot resume durable action continuations', 500)
              ))
      const resultModelUsage = {
        inputTokens: nonNegativeUsage(result.inputTokens, 'Model input tokens'),
        outputTokens: nonNegativeUsage(result.outputTokens, 'Model output tokens'),
        totalTokens: nonNegativeUsage(result.totalTokens, 'Model total tokens'),
        costMicros: nonNegativeUsage(result.costMicros, 'Model cost')
      }
      assertAgentTokenUsage(resultModelUsage.inputTokens, resultModelUsage.outputTokens, resultModelUsage.totalTokens)
      const modelUsage = {
        inputTokens: safeUsageSum(orchestrationTelemetry.modelUsage.inputTokens, resultModelUsage.inputTokens, 'Model input tokens'),
        outputTokens: safeUsageSum(orchestrationTelemetry.modelUsage.outputTokens, resultModelUsage.outputTokens, 'Model output tokens'),
        totalTokens: safeUsageSum(orchestrationTelemetry.modelUsage.totalTokens, resultModelUsage.totalTokens, 'Model total tokens'),
        costMicros: safeUsageSum(orchestrationTelemetry.modelUsage.costMicros, resultModelUsage.costMicros, 'Model cost')
      }
      assertGroundedContextFresh()
      const titleUsage =
        continuation === null && mediaRequest?.kind !== 'transcription'
          ? await this.#generateConversationTitle(claim, sessionRow, messages, content, executionSignal, dispatchBudget)
          : { title: '', source: 'fallback' as const, inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 }
      assertAgentTokenUsage(titleUsage.inputTokens, titleUsage.outputTokens, titleUsage.totalTokens)
      if (executionSignal.aborted) throw executionSignal.reason
      assertGroundedContextFresh()
      const inputTokens = safeUsageSum(
        safeUsageSum(orchestrationUsage.inputTokens, modelUsage.inputTokens, 'Input tokens'),
        titleUsage.inputTokens,
        'Input tokens'
      )
      const outputTokens = safeUsageSum(
        safeUsageSum(orchestrationUsage.outputTokens, modelUsage.outputTokens, 'Output tokens'),
        titleUsage.outputTokens,
        'Output tokens'
      )
      const totalTokens = safeUsageSum(
        safeUsageSum(orchestrationUsage.totalTokens, modelUsage.totalTokens, 'Total provider tokens'),
        titleUsage.totalTokens,
        'Total provider tokens'
      )
      const costMicros = safeUsageSum(safeUsageSum(orchestrationUsage.costMicros, modelUsage.costMicros, 'Cost'), titleUsage.costMicros, 'Cost')
      assertAgentTokenUsage(inputTokens, outputTokens, totalTokens)
      const dispatchedUsage = dispatchBudget?.consumed
      const measuredInputTokens = Math.max(inputTokens, dispatchedUsage?.inputTokens ?? 0)
      const measuredOutputTokens = Math.max(outputTokens, dispatchedUsage?.outputTokens ?? 0)
      const measuredTotalTokens = Math.max(
        totalTokens,
        dispatchedUsage?.totalTokens ?? 0,
        safeUsageSum(measuredInputTokens, measuredOutputTokens, 'Measured directional tokens')
      )
      const measuredCostMicros = Math.max(costMicros, dispatchedUsage?.costMicros ?? 0)
      assertAgentTokenUsage(measuredInputTokens, measuredOutputTokens, measuredTotalTokens)
      const unsettledExposure = dispatchBudget?.unsettledExposure ?? { tokens: 0, costMicros: 0 }
      const consumedTokens = safeUsageSum(measuredTotalTokens, unsettledExposure.tokens, 'Total provider tokens')
      const consumedCostMicros = safeUsageSum(measuredCostMicros, unsettledExposure.costMicros, 'Total provider cost')
      const googleSearchGrounding = result.googleSearchGrounding === undefined ? undefined : validateAgentGoogleSearchGrounding(result.googleSearchGrounding)
      if (googleSearchGrounding?.citations.some(citation => citation.endIndex > content.length))
        throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Google Search citation exceeds the accepted answer', 500)
      const citations = result.citations === undefined ? null : canonicalJson(result.citations)
      const outputLimitedValue: unknown = result.outputLimited
      if (outputLimitedValue !== undefined && outputLimitedValue !== true)
        throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Inference engine emitted an invalid output limit', 500)
      const outputLimited = outputLimitedValue === true ? true : undefined
      if (result.providerState !== undefined) assertNoTransientGoogleSearchSuggestions(result.providerState)
      if (
        result.providerState !== undefined &&
        claim.transportKind === 'gemini-api' &&
        decodeAgentProviderContinuation(result.providerState, 'gemini-interactions-v1') === undefined
      )
        throw new AgentRepositoryError('INVALID_ENGINE_RESULT', 'Inference engine returned invalid Gemini continuation state', 500)
      const providerStateJson = outputLimited === true || result.providerState === undefined ? null : canonicalJson(result.providerState)
      if (providerStateJson !== null && Buffer.byteLength(providerStateJson, 'utf8') > 256 * 1_024)
        throw new AgentRepositoryError('AGENT_PROVIDER_STATE_TOO_LARGE', 'Provider continuation exceeds its size limit', 500)
      await this.#appendPresentationEvent(claim, 'usage.updated', {
        usageVersion: 2,
        inputTokens: measuredInputTokens,
        outputTokens: measuredOutputTokens,
        totalTokens: measuredTotalTokens,
        costMicros: measuredCostMicros,
        model: modelUsage,
        orchestration: { ...orchestrationUsage, taskCount: tasks.length },
        utility: {
          inputTokens: titleUsage.inputTokens,
          outputTokens: titleUsage.outputTokens,
          totalTokens: titleUsage.totalTokens,
          costMicros: titleUsage.costMicros,
          purpose: 'conversation_title',
          goalBudget:
            goalBudgetClassification === null
              ? null
              : {
                  tier: goalBudgetClassification.tier,
                  selection: goalBudgetClassification.selection,
                  inputTokens: goalBudgetClassification.inputTokens,
                  outputTokens: goalBudgetClassification.outputTokens,
                  totalTokens: goalBudgetClassification.totalTokens,
                  costMicros: goalBudgetClassification.costMicros
                }
        }
      })
      if (result.suggestions !== undefined) await this.#appendPresentationEvent(claim, 'suggestions.updated', { suggestions: result.suggestions })
      const pendingProposal = await this.#knex('agentProposals')
        .where({ runId: claim.id })
        .whereIn('status', ['pending', 'approved', 'applying'])
        .count<{ count: number | string }[]>({ count: '*' })
        .first()
      const contextLimit = validatedContextLimit(result.contextLimit)
      const assessedCompletion = assessAgentRunCompletion({
        tasks,
        pendingProposalCount: Number(pendingProposal?.count ?? 0),
        evidenceGatePassed: true,
        usageReconciled: true
      })
      const completionIssues = [...assessedCompletion.issues]
      if (contextLimit !== undefined) {
        completionIssues.push({
          code: 'AGENT_CONTEXT_TOO_LARGE',
          message: 'The provider context capacity prevented delivery of all requested source evidence.',
          retryable: false
        })
      }
      if (outputLimited === true) {
        completionIssues.push({
          code: 'AGENT_OUTPUT_LIMITED',
          message: 'The provider output limit prevented completion. Send an explicit follow-up to continue.',
          retryable: false
        })
      }
      const completion =
        contextLimit === undefined && outputLimited === undefined
          ? assessedCompletion
          : {
              outcome: 'blocked' as const,
              issues: completionIssues
            }
      const encodedCompletion = encodedCompletionAssessment(completion)
      await this.#appendPresentationEvent(claim, 'run.completionAssessed', {
        runId: claim.id,
        outcome: completion.outcome,
        issueCodes: completion.issues.map(issue => issue.code)
      })
      assertGroundedContextFresh()
      if (googleSearchSuggestions !== undefined)
        await publishAgentGoogleSearchSuggestions(this.#knex, {
          ownerId: claim.ownerId,
          sessionId: claim.sessionId,
          runId: claim.id,
          suggestions: googleSearchSuggestions
        })
      const partial = completion.outcome !== 'complete'
      await persistAgentRunQuotaSettlementIntent(this.#knex, {
        runId: claim.id,
        ownerId: claim.ownerId,
        expected: { statuses: ['running', 'awaiting_approval'], leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken },
        consumedTokens,
        consumedCostMicros
      })
      assertGroundedContextFresh()
      await terminalizeAgentRun(this.#knex, {
        runId: claim.id,
        ownerId: claim.ownerId,
        expected: { statuses: ['running', 'awaiting_approval'], leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken },
        status: partial ? 'partial' : 'succeeded',
        assistant: {
          status: 'complete',
          content,
          citations,
          googleSearchGrounding: googleSearchGrounding === undefined ? groundingRetention : canonicalJson(googleSearchGrounding),
          providerStateCiphertext: providerStateJson === null ? null : Buffer.from(providerStateJson),
          providerStateSha256: providerStateJson === null ? null : sha256(providerStateJson)
        },
        eventData: {},
        quota: {
          consumedTokens,
          consumedCostMicros,
          status: 'consumed'
        },
        runPatch: {
          inputTokens: measuredInputTokens,
          outputTokens: measuredOutputTokens,
          totalTokens: measuredTotalTokens,
          estimatedCostMicros: measuredCostMicros,
          completionOutcome: completion.outcome,
          completionAssessment: encodedCompletion.encoded,
          completionAssessmentSha256: encodedCompletion.sha256
        }
      })
      quotaReconciled = true
      return { status: partial ? 'partial' : 'succeeded' }
    } catch (error) {
      if (error instanceof AgentQuotaSettlementError) throw error
      const normalizedFailure = error instanceof AgentExecutionFailure ? error : null
      let legacyCode: string | null = null
      if (normalizedFailure === null && typeof error === 'object' && error !== null) {
        try {
          const value: unknown = Reflect.get(error, 'code')
          if (typeof value === 'string') legacyCode = value
        } catch {
          legacyCode = null
        }
      }
      const reportedCode = normalizedFailure?.code ?? legacyCode
      const recoveryRequired = reportedCode === 'AGENT_ACTION_RECOVERY_REQUIRED'
      const deadlineBudgetLimited = goalDeadlineAt !== null && goalDeadlineAt <= Date.now()
      const tokenBudgetLimited = reportedCode === 'AGENT_TOKEN_BUDGET_LIMITED' && !deadlineBudgetLimited
      const budgetLimited =
        tokenBudgetLimited || reportedCode === 'AGENT_BUDGET_LIMITED' || reportedCode === 'AGENT_CHILD_BUDGET_EXCEEDED' || deadlineBudgetLimited
      const errorCode = recoveryRequired
        ? 'AGENT_ACTION_RECOVERY_REQUIRED'
        : tokenBudgetLimited
          ? 'AGENT_TOKEN_BUDGET_LIMITED'
          : budgetLimited
            ? 'AGENT_BUDGET_LIMITED'
            : (normalizedFailure?.code ?? 'AGENT_ENGINE_FAILED')
      const failureStage = normalizedFailure?.stage ?? 'unknown'
      const providerStatus = normalizedFailure?.providerStatus
      const errorMessage = recoveryRequired
        ? 'The approved action completed, but its assistant response requires recovery'
        : budgetLimited
          ? claim.goalId === null
            ? 'Agent request budget was exhausted'
            : 'Agent goal budget was exhausted'
          : (normalizedFailure?.message ?? 'Agent inference failed')
      let ownsActiveRun = false
      let ownedStatus: string | undefined
      try {
        const owned = (await this.#knex('agentRuns')
          .where({ id: claim.id, ownerId: claim.ownerId, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
          .first('status')) as { status: string } | undefined
        ownedStatus = owned?.status
        ownsActiveRun = ownedStatus === 'running' || ownedStatus === 'awaiting_approval'
      } catch {
        /* the retention reconciler owns unavailable reservations */
      }
      if (signal.aborted && ownedStatus === 'awaiting_approval') throw error
      if (signal.aborted || errorCode === 'AGENT_BUDGET_LIMITED' || errorCode === 'AGENT_TOKEN_BUDGET_LIMITED') {
        try {
          await cancelAgentRunTasks(this.#knex, claim)
        } catch {
          /* coordinator cancellation remains authoritative */
        }
      }
      try {
        if (ownsActiveRun && !quotaReconciled) {
          const telemetry = await this.#orchestrationTelemetry(claim)
          const persistedUsage = {
            inputTokens: safeUsageSum(
              safeUsageSum(telemetry.usage.inputTokens, telemetry.modelUsage.inputTokens, 'Persisted input tokens'),
              classifierUsageForSettlement.inputTokens,
              'Persisted input tokens'
            ),
            outputTokens: safeUsageSum(
              safeUsageSum(telemetry.usage.outputTokens, telemetry.modelUsage.outputTokens, 'Persisted output tokens'),
              classifierUsageForSettlement.outputTokens,
              'Persisted output tokens'
            ),
            totalTokens: safeUsageSum(
              safeUsageSum(telemetry.usage.totalTokens, telemetry.modelUsage.totalTokens, 'Persisted total tokens'),
              classifierUsageForSettlement.totalTokens,
              'Persisted total tokens'
            ),
            costMicros: safeUsageSum(
              safeUsageSum(telemetry.usage.costMicros, telemetry.modelUsage.costMicros, 'Persisted cost'),
              classifierUsageForSettlement.costMicros,
              'Persisted cost'
            )
          }
          const dispatchedUsage = dispatchBudget?.consumed
          const settledUsage =
            dispatchedUsage === undefined
              ? persistedUsage
              : (() => {
                  const inputTokens = Math.max(persistedUsage.inputTokens, dispatchedUsage.inputTokens)
                  const outputTokens = Math.max(persistedUsage.outputTokens, dispatchedUsage.outputTokens)
                  return {
                    inputTokens,
                    outputTokens,
                    totalTokens: Math.max(
                      persistedUsage.totalTokens,
                      dispatchedUsage.totalTokens,
                      safeUsageSum(inputTokens, outputTokens, 'Settled directional tokens')
                    ),
                    costMicros: Math.max(persistedUsage.costMicros, dispatchedUsage.costMicros)
                  }
                })()
          assertAgentTokenUsage(settledUsage.inputTokens, settledUsage.outputTokens, settledUsage.totalTokens)
          const unsettledExposure = dispatchBudget?.unsettledExposure ?? { tokens: 0, costMicros: 0 }
          const consumedTokens = safeUsageSum(settledUsage.totalTokens, unsettledExposure.tokens, 'Total provider tokens')
          const consumedCostMicros = safeUsageSum(settledUsage.costMicros, unsettledExposure.costMicros, 'Total provider cost')
          const unsettledEventData: { unsettledExposure?: { tokens: number; costMicros: number } } =
            unsettledExposure.tokens === 0 && unsettledExposure.costMicros === 0
              ? {}
              : { unsettledExposure: { tokens: unsettledExposure.tokens, costMicros: unsettledExposure.costMicros } }
          if (consumedTokens > 0 || consumedCostMicros > 0)
            await persistAgentRunQuotaSettlementIntent(this.#knex, {
              runId: claim.id,
              ownerId: claim.ownerId,
              expected: { statuses: ['running', 'awaiting_approval'], leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken },
              consumedTokens,
              consumedCostMicros
            })
          const terminalized = await terminalizeAgentRun(this.#knex, {
            runId: claim.id,
            ownerId: claim.ownerId,
            expected: { statuses: ['running', 'awaiting_approval'], leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken },
            status: recoveryRequired ? 'partial' : 'failed',
            assistant: { status: 'failed' },
            eventData: {
              errorCode,
              errorMessage,
              failureStage,
              ...unsettledEventData,
              ...(providerStatus === undefined ? {} : { providerStatus })
            },
            quota: {
              consumedTokens,
              consumedCostMicros,
              status: consumedTokens > 0 || consumedCostMicros > 0 ? 'consumed' : 'released'
            },
            runPatch: {
              inputTokens: settledUsage.inputTokens,
              outputTokens: settledUsage.outputTokens,
              totalTokens: settledUsage.totalTokens,
              estimatedCostMicros: settledUsage.costMicros
            },
            errorCode,
            errorMessage
          })
          quotaReconciled = true
          if (terminalized.status === (recoveryRequired ? 'partial' : 'failed'))
            this.#logTerminalFailure(claim, normalizedFailure, errorCode, failureStage, providerStatus, unsettledExposure)
        }
      } catch (settlementError) {
        if (settlementError instanceof AgentQuotaSettlementError) throw settlementError
        throw settlementError
      }
      if (signal.aborted) throw error
      if (recoveryRequired)
        return {
          status: 'partial',
          errorCode,
          errorMessage
        }
      return { status: 'failed', errorCode, errorMessage }
    } finally {
      clearTimeout(goalDeadlineTimer)
    }
  }
  async #goalUsage(database: Knex | Knex.Transaction, goalId: string, excludeRunId?: string): Promise<{ readonly tokens: number; readonly toolCalls: number }> {
    const rows = (await database('agentRuns as runs')
      .leftJoin('agentQuotaReservations as reservations', function () {
        this.on('reservations.runId', '=', 'runs.id').andOn('reservations.ownerId', '=', 'runs.ownerId')
      })
      .where('runs.goalId', goalId)
      .select(
        'runs.id',
        'runs.ownerId',
        'runs.status',
        'runs.totalTokens',
        'reservations.ownerId as reservationOwnerId',
        'reservations.reservedTokens as reservationReservedTokens',
        'reservations.consumedTokens as reservationConsumedTokens',
        'reservations.status as reservationStatus',
        'reservations.reconciledAt as reservationReconciledAt'
      )) as Array<{
      id: string
      ownerId: number | string
      status: string
      totalTokens: number | string
      reservationOwnerId: number | string | null
      reservationReservedTokens: number | string | null
      reservationConsumedTokens: number | string | null
      reservationStatus: string | null
      reservationReconciledAt: Date | string | null
    }>
    const firstRow = rows[0]
    if (!firstRow) return goalAccountingFailure()
    const ownerId = goalAccountingInteger(firstRow.ownerId)
    const goal = await getOwnedAgentGoal(database, ownerId, goalId)
    const { checkpoints } = await this.#goalBudgetCheckpoints(database, goal)
    const checkpointByRunId = new Map(checkpoints.map(checkpoint => [checkpoint.runId, checkpoint]))
    let tokens = 0
    const runs = rows.filter(run => run.id !== excludeRunId)
    const runIds = runs.map(run => run.id)
    for (const run of runs) {
      const status = run.status as AgentRunStatus
      const checkpointTokens = checkpointByRunId.get(run.id)?.classifier.totalTokens ?? 0
      if (!isTerminalAgentRunStatus(status)) {
        if (!['queued', 'running', 'awaiting_approval'].includes(run.status)) return goalAccountingFailure()
        const activeTotalTokens = goalAccountingInteger(run.totalTokens)
        const pendingTokens = run.reservationConsumedTokens === null ? 0 : goalAccountingInteger(run.reservationConsumedTokens)
        tokens = goalAccountingSum(tokens, Math.max(activeTotalTokens, pendingTokens, checkpointTokens), 'Goal aggregate token usage')
        continue
      }
      const runOwnerId = goalAccountingInteger(run.ownerId)
      if (
        run.reservationOwnerId === null ||
        run.reservationOwnerId === undefined ||
        goalAccountingInteger(run.reservationOwnerId) !== runOwnerId ||
        (run.reservationStatus !== 'consumed' && run.reservationStatus !== 'released') ||
        run.reservationReconciledAt === null ||
        run.reservationReconciledAt === undefined
      )
        return goalAccountingFailure()
      const totalTokens = goalAccountingInteger(run.totalTokens)
      const reconciledTokens = goalAccountingInteger(run.reservationConsumedTokens)
      if (run.reservationStatus === 'released' && reconciledTokens !== 0) return goalAccountingFailure()
      tokens = goalAccountingSum(tokens, Math.max(totalTokens, reconciledTokens, checkpointTokens), 'Goal aggregate token usage')
    }
    const toolCalls =
      runIds.length === 0
        ? 0
        : goalAccountingInteger(
            (await database('agentEvents').whereIn('runId', runIds).where({ type: 'tool.started' }).count<{ count: number | string }[]>({ count: '*' }).first())
              ?.count ?? 0
          )
    return { tokens, toolCalls }
  }
  async #emitLatestGoalStatus(goal: AgentGoalRecord): Promise<void> {
    const run = (await this.#knex('agentRuns').where({ goalId: goal.id, ownerId: goal.ownerId }).orderBy('goalContinuation', 'desc').first('id', 'attempts')) as
      | { id: string; attempts: number }
      | undefined
    if (run) await emitGoalEvent(this.#knex, { goal, run, type: 'goal.status' })
  }
  async #blockGoalForAccounting(goal: AgentGoalRecord): Promise<AgentGoalRecord> {
    if (goal.status === 'blocked' && goal.errorCode === 'GOAL_ACCOUNTING_UNAVAILABLE') return goal
    const blocked = await updateGoalStatus(this.#knex, {
      ownerId: goal.ownerId,
      goalId: goal.id,
      expectedVersion: goal.version,
      from: [goal.status],
      to: 'blocked',
      completion: goal.completion,
      consumedTokens: goal.consumedTokens,
      consumedToolCalls: goal.consumedToolCalls,
      budgetLimitReason: 'accounting',
      errorCode: 'GOAL_ACCOUNTING_UNAVAILABLE',
      errorMessage: 'Goal accounting must be reconciled before continuation.'
    })
    await this.#emitLatestGoalStatus(blocked)
    return blocked
  }
  async #renewalReceipt(transaction: Knex.Transaction, runId: string): Promise<Readonly<Record<string, unknown>> | null> {
    const rows = (await transaction('agentEvents').where({ runId, type: 'run.resumed' }).select('data', 'dataSha256').orderBy('sequence')) as Array<{
      data: string
      dataSha256: string
    }>
    let receipt: Readonly<Record<string, unknown>> | null = null
    for (const row of rows) {
      if (sha256(row.data) !== row.dataSha256) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored run receipt hash is invalid', 500)
      let parsed: unknown
      try {
        parsed = JSON.parse(row.data)
      } catch {
        throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored run receipt is invalid', 500)
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored run receipt is invalid', 500)
      if (Reflect.get(parsed, 'operation') !== 'renew_goal_budget') continue
      if (receipt !== null) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored run has duplicate renewal receipts', 500)
      receipt = parsed as Readonly<Record<string, unknown>>
    }
    return receipt
  }

  #assertRenewalReceiptMatches(receipt: Readonly<Record<string, unknown>> | null, input: RenewAgentGoalBudgetInput): void {
    if (
      receipt === null ||
      Reflect.get(receipt, 'operation') !== 'renew_goal_budget' ||
      Reflect.get(receipt, 'goalId') !== input.goalId ||
      Reflect.get(receipt, 'clientRequestId') !== input.clientRequestId ||
      Reflect.get(receipt, 'expectedVersion') !== input.expectedVersion ||
      Reflect.get(receipt, 'confirmed') !== true ||
      Reflect.get(receipt, 'status') !== 'active' ||
      !Number.isSafeInteger(Reflect.get(receipt, 'budgetCycle')) ||
      Number(Reflect.get(receipt, 'budgetCycle')) < 1 ||
      !Number.isSafeInteger(Reflect.get(receipt, 'maxTokens')) ||
      Number(Reflect.get(receipt, 'maxTokens')) < 1 ||
      !Number.isSafeInteger(Reflect.get(receipt, 'continuationCount')) ||
      Number(Reflect.get(receipt, 'continuationCount')) < 1
    )
      throw new AgentRepositoryError('RUN_IDEMPOTENCY_MISMATCH', 'Run ID was reused with different input', 409)
    const receiptVersion = Reflect.get(receipt, 'receiptVersion')
    if (receiptVersion === undefined) return
    const cycleStartedAtTokens = Reflect.get(receipt, 'cycleStartedAtTokens')
    const tokenAllowance = Reflect.get(receipt, 'tokenAllowance')
    if (
      receiptVersion !== 2 ||
      !Number.isSafeInteger(cycleStartedAtTokens) ||
      Number(cycleStartedAtTokens) < 0 ||
      !Number.isSafeInteger(tokenAllowance) ||
      Number(tokenAllowance) < 1 ||
      Number(cycleStartedAtTokens) + Number(tokenAllowance) !== Number(Reflect.get(receipt, 'maxTokens'))
    )
      throw new AgentRepositoryError('RUN_IDEMPOTENCY_MISMATCH', 'Run ID was reused with different input', 409)
  }

  async #continueGoal(
    goal: AgentGoalRecord,
    input: { readonly expectedVersion?: number; readonly runId?: string; readonly clientRequestId?: string; readonly automatic: boolean }
  ): Promise<{ readonly goal: AgentGoalRecord; readonly run: AgentRunRecord | null; readonly replayed: boolean }> {
    if (!this.#goals.enabled) throw new AgentRepositoryError('AGENT_GOALS_DISABLED', 'Durable goals are disabled', 404)
    const now = new Date()
    const result = await this.#knex.transaction(async transaction => {
      await acquireAgentCoordinatorAdvisoryLocks(transaction, [goal.ownerId])
      if (input.runId !== undefined) {
        const existing = (await transaction('agentRuns').where({ id: input.runId, ownerId: goal.ownerId, goalId: goal.id }).first('id', 'clientRequestId')) as
          | { id: string; clientRequestId: string }
          | undefined
        if (existing) {
          if (existing.clientRequestId !== input.clientRequestId)
            throw new AgentRepositoryError('RUN_IDEMPOTENCY_MISMATCH', 'Run ID was reused with different input', 409)
          const renewalReceipt = await this.#renewalReceipt(transaction, existing.id)
          if (renewalReceipt !== null)
            throw new AgentRepositoryError('RUN_IDEMPOTENCY_MISMATCH', 'Renewal receipts cannot be replayed as ordinary continuations', 409)
          return {
            goal: await getOwnedAgentGoal(transaction, goal.ownerId, goal.id),
            run: await getOwnedAgentRun(transaction, goal.ownerId, existing.id),
            replayed: true
          }
        }
      }
      const locked = await getOwnedAgentGoal(transaction, goal.ownerId, goal.id, true)
      if (input.expectedVersion !== undefined && locked.version !== input.expectedVersion)
        throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
      const allowed = input.automatic ? locked.status === 'active' : locked.status === 'paused' || locked.status === 'blocked'
      if (!allowed) throw new AgentRepositoryError('INVALID_GOAL_TRANSITION', 'Agent goal cannot continue from its current state', 409)
      const context = await this.#lockAdmissionContext(transaction, locked.ownerId, locked.sessionId)
      let usage: { readonly tokens: number; readonly toolCalls: number }
      try {
        usage = await this.#goalUsage(transaction, locked.id)
      } catch (error) {
        if (!(error instanceof AgentRepositoryError) || error.code !== 'AGENT_QUOTA_CORRUPT') throw error
        const blocked = await updateGoalStatus(transaction, {
          ownerId: locked.ownerId,
          goalId: locked.id,
          expectedVersion: locked.version,
          from: [locked.status],
          to: 'blocked',
          completion: locked.completion,
          consumedTokens: locked.consumedTokens,
          consumedToolCalls: locked.consumedToolCalls,
          budgetLimitReason: 'accounting',
          errorCode: 'GOAL_ACCOUNTING_UNAVAILABLE',
          errorMessage: 'Goal accounting must be reconciled before continuation.'
        })
        return { goal: blocked, run: null, replayed: false }
      }
      const latest = (await transaction('agentRuns')
        .where({ goalId: locked.id, ownerId: locked.ownerId })
        .orderBy('goalContinuation', 'desc')
        .first('errorCode')) as { errorCode: string | null } | undefined
      const tokenFence = latest?.errorCode === 'AGENT_TOKEN_BUDGET_LIMITED'
      const limited =
        locked.continuationCount >= locked.maxContinuations ||
        usage.tokens >= locked.maxTokens ||
        usage.toolCalls >= locked.maxToolCalls ||
        new Date(locked.deadlineAt).valueOf() <= now.valueOf() ||
        tokenFence
      if (limited) {
        const limitedGoal = await updateGoalStatus(transaction, {
          ownerId: locked.ownerId,
          goalId: locked.id,
          expectedVersion: locked.version,
          from: [locked.status],
          to: 'budget_limited',
          completion: locked.completion ?? {
            outcome: 'partial',
            issues: [{ code: 'GOAL_BUDGET_LIMITED', message: 'The goal reached its host-owned continuation budget.', retryable: false }]
          },
          consumedTokens: usage.tokens,
          consumedToolCalls: usage.toolCalls,
          budgetLimitReason: goalBudgetLimitReason(locked, usage, now, tokenFence),
          errorCode: 'GOAL_BUDGET_LIMITED',
          errorMessage: 'Goal continuation budget was exhausted'
        })
        return { goal: limitedGoal, run: null, replayed: false }
      }
      const firstRun = (await transaction('agentRuns')
        .where({ goalId: locked.id, goalContinuation: 0, ownerId: locked.ownerId })
        .first(
          'providerProfileVersionId',
          'transportKind',
          'model',
          'googleSearchEnabled',
          'profilePolicyVersion',
          'defaultGeneration',
          'capabilityRevision',
          'pricingRevision',
          'promptVersion'
        )) as
        | {
            providerProfileVersionId: string
            transportKind: string
            model: string
            googleSearchEnabled: boolean | number | null | undefined
            profilePolicyVersion: number | string
            defaultGeneration: number | string
            capabilityRevision: string
            pricingRevision: string
            promptVersion: number
          }
        | undefined
      if (!firstRun) throw new AgentRepositoryError('AGENT_GOAL_CORRUPT', 'Agent goal has no initial run', 500)
      const resolved = await this.#resolver.resolveCurrent(transaction, { ownerId: locked.ownerId, sessionId: locked.sessionId })
      this.#assertResolvedAdmission(resolved)
      const configurationMatches =
        firstRun.providerProfileVersionId === resolved.providerProfileVersionId &&
        firstRun.transportKind === resolved.transportKind &&
        firstRun.model === resolved.model &&
        (firstRun.googleSearchEnabled === true ||
          firstRun.googleSearchEnabled === false ||
          firstRun.googleSearchEnabled === 0 ||
          firstRun.googleSearchEnabled === undefined ||
          firstRun.googleSearchEnabled === null ||
          firstRun.googleSearchEnabled === 1) &&
        (firstRun.googleSearchEnabled === true || firstRun.googleSearchEnabled === 1) === resolved.googleSearchEnabled &&
        Number(firstRun.profilePolicyVersion) === resolved.profilePolicyVersion &&
        Number(firstRun.defaultGeneration) === resolved.defaultGeneration &&
        firstRun.capabilityRevision === resolved.capabilityRevision &&
        firstRun.pricingRevision === resolved.pricingRevision &&
        firstRun.promptVersion === resolved.promptVersion
      if (!configurationMatches) {
        const blocked = await updateGoalStatus(transaction, {
          ownerId: locked.ownerId,
          goalId: locked.id,
          expectedVersion: locked.version,
          from: [locked.status],
          to: 'blocked',
          completion: locked.completion,
          consumedTokens: usage.tokens,
          consumedToolCalls: usage.toolCalls,
          budgetLimitReason: 'authority',
          errorCode: 'GOAL_CONFIGURATION_CHANGED',
          errorMessage: 'Provider configuration changed; start a new goal to use the new configuration'
        })
        return { goal: blocked, run: null, replayed: false }
      }
      const skillVersionIds = (await transaction('agentRunSkills')
        .join('agentRuns', 'agentRuns.id', 'agentRunSkills.runId')
        .where({ 'agentRuns.goalId': locked.id, 'agentRuns.goalContinuation': 0, 'agentRuns.ownerId': locked.ownerId })
        .orderBy('agentRunSkills.ordinal')
        .pluck<string>('agentRunSkills.skillVersionId')) as string[]
      try {
        await validateSelectedSkillVersionIdsInTransaction(transaction, { userId: locked.ownerId, groupIds: context.groupIds }, skillVersionIds)
      } catch (error) {
        if (!(error instanceof SkillValidationError)) throw error
        const blocked = await updateGoalStatus(transaction, {
          ownerId: locked.ownerId,
          goalId: locked.id,
          expectedVersion: locked.version,
          from: [locked.status],
          to: 'blocked',
          consumedTokens: usage.tokens,
          consumedToolCalls: usage.toolCalls,
          budgetLimitReason: 'authority',
          errorCode: 'GOAL_CONFIGURATION_CHANGED',
          errorMessage: 'Selected skills changed; start a new goal to use the new configuration'
        })
        return { goal: blocked, run: null, replayed: false }
      }
      const activeRun = await transaction('agentRuns').where({ goalId: locked.id }).whereIn('status', ['queued', 'running', 'awaiting_approval']).first('id')
      if (activeRun) throw new AgentRepositoryError('GOAL_RUN_ACTIVE', 'Agent goal already has an active run', 409)
      const continuation = locked.continuationCount + 1
      const runId = input.runId ?? randomUUID()
      const clientRequestId = input.clientRequestId ?? randomUUID()
      const previous = locked.completion ?? {
        outcome: 'retry' as const,
        issues: [{ code: 'PRIOR_RUN_FAILED', message: 'The prior run did not produce a completion assessment.', retryable: true }]
      }
      const content = `Continue this explicit durable goal using only actionable remaining work. Do not repeat completed work. The host, not the model, decides completion.\n${canonicalJson(
        {
          objective: locked.objective,
          previousCompletion: previous
        }
      )}`
      const initialContext = (await transaction('agentEvents as events')
        .join('agentRuns as runs', 'runs.id', 'events.runId')
        .where({ 'runs.goalId': locked.id, 'runs.goalContinuation': 0, 'events.type': 'run.queued' })
        .orderBy('events.createdAt', 'asc')
        .first('events.data')) as { data: string } | undefined
      const generationTools = generationToolsHint(initialContext?.data)
      await assertGenerationToolCapabilities(transaction, resolved.providerProfileVersionId, generationTools, resolved.executionMode)
      const knowledgeContext = knowledgeContextHint(initialContext?.data)
      const currentPage = currentPageHint(initialContext?.data)
      const changed = await transaction('agentGoals')
        .where({ id: locked.id, ownerId: locked.ownerId, version: locked.version, status: locked.status })
        .update({
          status: 'active',
          version: locked.version + 1,
          continuationCount: continuation,
          consumedTokens: usage.tokens,
          consumedToolCalls: usage.toolCalls,
          budgetLimitReason: null,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
          completedAt: null
        })
      if (changed !== 1) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
      const admitted = await admitAgentRunInTransaction(transaction, {
        id: runId,
        ownerId: locked.ownerId,
        sessionId: locked.sessionId,
        clientRequestId,
        expectedSessionVersion: context.sessionVersion,
        content,
        ...(generationTools === undefined ? {} : { generationTools }),
        ...(knowledgeContext === undefined ? {} : { knowledgeContext }),
        ...(currentPage === undefined ? {} : { currentPage: { ...currentPage } }),
        ...resolved,
        quota: { ...resolved.quota, tokens: Math.min(resolved.quota.tokens, locked.maxTokens - usage.tokens) },
        goalId: locked.id,
        goalContinuation: continuation,
        userMessageVisible: false,
        skillVersionIds,
        reservationExpiresAt: new Date(Math.min(now.valueOf() + resolved.reservationMilliseconds, new Date(locked.deadlineAt).valueOf())),
        now
      })
      return { ...admitted, goal: await getOwnedAgentGoal(transaction, locked.ownerId, locked.id) }
    })
    if (!result.replayed) {
      if (result.run === null) await this.#emitLatestGoalStatus(result.goal)
      else {
        await emitGoalEvent(this.#knex, { goal: result.goal, run: result.run, type: 'run.resumed' })
        await emitGoalEvent(this.#knex, { goal: result.goal, run: result.run, type: 'goal.status' })
      }
    }
    return result
  }

  async pauseGoal(input: MutateAgentGoalInput): Promise<AgentGoalRecord> {
    const goal = await updateGoalStatus(this.#knex, {
      ownerId: input.ownerId,
      goalId: input.goalId,
      expectedVersion: input.expectedVersion,
      from: ['active', 'blocked'],
      to: 'paused'
    })
    const run = (await this.#knex('agentRuns')
      .where({ goalId: goal.id, ownerId: goal.ownerId })
      .whereIn('status', ['queued', 'running', 'awaiting_approval'])
      .orderBy('goalContinuation', 'desc')
      .first('id', 'attempts')) as { id: string; attempts: number } | undefined
    if (run) {
      await emitGoalEvent(this.#knex, { goal, run, type: 'run.interrupted' })
      await emitGoalEvent(this.#knex, { goal, run, type: 'goal.status' })
      await this.#coordinator.cancel(goal.ownerId, run.id)
    }
    return goal
  }

  async resumeGoal(input: ResumeAgentGoalInput): Promise<{ readonly goal: AgentGoalRecord; readonly run: AgentRunRecord | null; readonly replayed: boolean }> {
    const goal = await getOwnedAgentGoal(this.#knex, input.ownerId, input.goalId)
    return this.#continueGoal(goal, { expectedVersion: input.expectedVersion, runId: input.runId, clientRequestId: input.clientRequestId, automatic: false })
  }
  async renewGoalBudget(
    input: RenewAgentGoalBudgetInput
  ): Promise<{ readonly goal: AgentGoalRecord; readonly run: AgentRunRecord | null; readonly replayed: boolean }> {
    if (input.confirmed !== true)
      throw new AgentRepositoryError('GOAL_RENEWAL_CONFIRMATION_REQUIRED', 'Goal token budget renewal requires explicit confirmation', 400)
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      !UUID.test(input.goalId) ||
      !UUID.test(input.runId) ||
      !UUID.test(input.clientRequestId)
    )
      throw new AgentRepositoryError('INVALID_AGENT_GOAL_RENEWAL', 'Goal token budget renewal identifiers are invalid', 400)
    if (!this.#goals.enabled) throw new AgentRepositoryError('AGENT_GOALS_DISABLED', 'Durable goals are disabled', 404)
    const now = new Date()
    const result = await this.#knex.transaction(async transaction => {
      await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
      const existing = (await transaction('agentRuns')
        .where({ id: input.runId, ownerId: input.ownerId })
        .first('id', 'goalId', 'clientRequestId', 'goalContinuation')) as
        | { id: string; goalId: string | null; clientRequestId: string; goalContinuation: number | string | null }
        | undefined
      if (existing) {
        if (
          existing.goalId !== input.goalId ||
          existing.clientRequestId !== input.clientRequestId ||
          !Number.isSafeInteger(Number(existing.goalContinuation)) ||
          Number(existing.goalContinuation) < 1
        )
          throw new AgentRepositoryError('RUN_IDEMPOTENCY_MISMATCH', 'Run ID was reused with different input', 409)
        const receipt = await this.#renewalReceipt(transaction, existing.id)
        this.#assertRenewalReceiptMatches(receipt, input)
        return {
          goal: await getOwnedAgentGoal(transaction, input.ownerId, input.goalId),
          run: await getOwnedAgentRun(transaction, input.ownerId, existing.id),
          replayed: true
        }
      }
      const locked = await getOwnedAgentGoal(transaction, input.ownerId, input.goalId, true)
      if (locked.version !== input.expectedVersion) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
      const collision = await transaction('agentRuns')
        .where({ ownerId: input.ownerId, sessionId: locked.sessionId, clientRequestId: input.clientRequestId })
        .whereNot('id', input.runId)
        .first('id')
      if (collision) throw new AgentRepositoryError('RUN_IDEMPOTENCY_MISMATCH', 'Client request ID was reused with different input', 409)
      if (
        !isSelectedAgentGoalBudgetPolicyVersion(locked.budgetPolicyVersion) ||
        (locked.budgetSelection !== 'utility' && locked.budgetSelection !== 'fallback') ||
        locked.tokenTier === null ||
        locked.tokenAllowance === null ||
        locked.budgetCycle < 1 ||
        locked.status !== 'budget_limited' ||
        locked.budgetLimitReason !== 'tokens' ||
        !locked.canRenewTokenBudget
      )
        throw new AgentRepositoryError('GOAL_TOKEN_RENEWAL_UNAVAILABLE', 'Goal token budget renewal is not currently available', 409)
      const activeRun = await transaction('agentRuns')
        .where({ goalId: locked.id, ownerId: locked.ownerId })
        .whereIn('status', ['queued', 'running', 'awaiting_approval'])
        .first('id')
      if (activeRun) throw new AgentRepositoryError('GOAL_RUN_ACTIVE', 'Agent goal already has an active run', 409)
      const competingGoal = await transaction('agentGoals')
        .where({ sessionId: locked.sessionId })
        .whereIn('status', ['active', 'paused', 'blocked'])
        .whereNot('id', locked.id)
        .first('id')
      if (competingGoal) throw new AgentRepositoryError('SESSION_GOAL_ACTIVE', 'The conversation already has another open goal', 409)
      const context = await this.#lockAdmissionContext(transaction, locked.ownerId, locked.sessionId)
      let usage: { readonly tokens: number; readonly toolCalls: number }
      try {
        usage = await this.#goalUsage(transaction, locked.id)
      } catch (error) {
        if (!(error instanceof AgentRepositoryError) || error.code !== 'AGENT_QUOTA_CORRUPT') throw error
        const changed = await transaction('agentGoals')
          .where({ id: locked.id, ownerId: locked.ownerId, version: locked.version, status: locked.status })
          .update({
            status: 'blocked',
            version: locked.version + 1,
            consumedTokens: locked.consumedTokens,
            consumedToolCalls: locked.consumedToolCalls,
            budgetLimitReason: 'accounting',
            errorCode: 'GOAL_ACCOUNTING_UNAVAILABLE',
            errorMessage: 'Goal accounting must be reconciled before token budget renewal.',
            updatedAt: now
          })
        if (changed !== 1) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
        return { goal: await getOwnedAgentGoal(transaction, locked.ownerId, locked.id), run: null, replayed: false }
      }
      const latest = (await transaction('agentRuns')
        .where({ goalId: locked.id, ownerId: locked.ownerId })
        .orderBy('goalContinuation', 'desc')
        .first('errorCode')) as { errorCode: string | null } | undefined
      const tokenFence = latest?.errorCode === 'AGENT_TOKEN_BUDGET_LIMITED'
      if (usage.toolCalls >= locked.maxToolCalls) throw new AgentRepositoryError('GOAL_TOOL_BUDGET_EXHAUSTED', 'Goal action budget is exhausted', 409)
      if (locked.continuationCount >= locked.maxContinuations)
        throw new AgentRepositoryError('GOAL_CONTINUATION_BUDGET_EXHAUSTED', 'Goal continuation budget is exhausted', 409)
      if (new Date(locked.deadlineAt).valueOf() <= now.valueOf())
        throw new AgentRepositoryError('GOAL_DURATION_EXHAUSTED', 'Goal duration budget is exhausted', 409)
      if (usage.tokens < locked.maxTokens && !tokenFence)
        throw new AgentRepositoryError('GOAL_TOKEN_RENEWAL_UNAVAILABLE', 'Goal token budget has not been exhausted', 409)
      const firstRun = (await transaction('agentRuns')
        .where({ goalId: locked.id, goalContinuation: 0, ownerId: locked.ownerId })
        .first(
          'providerProfileVersionId',
          'transportKind',
          'model',
          'googleSearchEnabled',
          'profilePolicyVersion',
          'defaultGeneration',
          'capabilityRevision',
          'pricingRevision',
          'promptVersion'
        )) as
        | {
            providerProfileVersionId: string
            transportKind: string
            model: string
            googleSearchEnabled: boolean | number | null | undefined
            profilePolicyVersion: number | string
            defaultGeneration: number | string
            capabilityRevision: string
            pricingRevision: string
            promptVersion: number
          }
        | undefined
      if (!firstRun) throw new AgentRepositoryError('AGENT_GOAL_CORRUPT', 'Agent goal has no initial run', 500)
      const resolved = await this.#resolver.resolveCurrent(transaction, { ownerId: locked.ownerId, sessionId: locked.sessionId })
      this.#assertResolvedAdmission(resolved)
      const configurationMatches =
        firstRun.providerProfileVersionId === resolved.providerProfileVersionId &&
        firstRun.transportKind === resolved.transportKind &&
        firstRun.model === resolved.model &&
        (firstRun.googleSearchEnabled === true ||
          firstRun.googleSearchEnabled === false ||
          firstRun.googleSearchEnabled === 0 ||
          firstRun.googleSearchEnabled === undefined ||
          firstRun.googleSearchEnabled === null ||
          firstRun.googleSearchEnabled === 1) &&
        (firstRun.googleSearchEnabled === true || firstRun.googleSearchEnabled === 1) === resolved.googleSearchEnabled &&
        Number(firstRun.profilePolicyVersion) === resolved.profilePolicyVersion &&
        Number(firstRun.defaultGeneration) === resolved.defaultGeneration &&
        firstRun.capabilityRevision === resolved.capabilityRevision &&
        firstRun.pricingRevision === resolved.pricingRevision &&
        firstRun.promptVersion === resolved.promptVersion
      if (!configurationMatches) {
        const changed = await transaction('agentGoals')
          .where({ id: locked.id, ownerId: locked.ownerId, version: locked.version, status: locked.status })
          .update({
            status: 'blocked',
            version: locked.version + 1,
            consumedTokens: usage.tokens,
            consumedToolCalls: usage.toolCalls,
            budgetLimitReason: 'authority',
            errorCode: 'GOAL_CONFIGURATION_CHANGED',
            errorMessage: 'Provider configuration changed; start a new goal to use the new configuration',
            updatedAt: now
          })
        if (changed !== 1) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
        return { goal: await getOwnedAgentGoal(transaction, locked.ownerId, locked.id), run: null, replayed: false }
      }
      const skillVersionIds = (await transaction('agentRunSkills')
        .join('agentRuns', 'agentRuns.id', 'agentRunSkills.runId')
        .where({ 'agentRuns.goalId': locked.id, 'agentRuns.goalContinuation': 0, 'agentRuns.ownerId': locked.ownerId })
        .orderBy('agentRunSkills.ordinal')
        .pluck<string>('agentRunSkills.skillVersionId')) as string[]
      try {
        await validateSelectedSkillVersionIdsInTransaction(transaction, { userId: locked.ownerId, groupIds: context.groupIds }, skillVersionIds)
      } catch (error) {
        if (!(error instanceof SkillValidationError)) throw error
        const changed = await transaction('agentGoals')
          .where({ id: locked.id, ownerId: locked.ownerId, version: locked.version, status: locked.status })
          .update({
            status: 'blocked',
            version: locked.version + 1,
            consumedTokens: usage.tokens,
            consumedToolCalls: usage.toolCalls,
            budgetLimitReason: 'authority',
            errorCode: 'GOAL_CONFIGURATION_CHANGED',
            errorMessage: 'Selected skills changed; start a new goal to use the new configuration',
            updatedAt: now
          })
        if (changed !== 1) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
        return { goal: await getOwnedAgentGoal(transaction, locked.ownerId, locked.id), run: null, replayed: false }
      }
      const continuation = locked.continuationCount + 1
      const previous = locked.completion ?? {
        outcome: 'retry' as const,
        issues: [{ code: 'PRIOR_RUN_FAILED', message: 'The prior run did not produce a completion assessment.', retryable: true }]
      }
      const content = `Continue this explicit durable goal using only actionable remaining work. Do not repeat completed work. The host, not the model, decides completion.\n${canonicalJson(
        {
          objective: locked.objective,
          previousCompletion: previous
        }
      )}`
      const initialContext = (await transaction('agentEvents as events')
        .join('agentRuns as runs', 'runs.id', 'events.runId')
        .where({ 'runs.goalId': locked.id, 'runs.goalContinuation': 0, 'events.type': 'run.queued' })
        .orderBy('events.createdAt', 'asc')
        .first('events.data')) as { data: string } | undefined
      const generationTools = generationToolsHint(initialContext?.data)
      await assertGenerationToolCapabilities(transaction, resolved.providerProfileVersionId, generationTools, resolved.executionMode)
      const knowledgeContext = knowledgeContextHint(initialContext?.data)
      const currentPage = currentPageHint(initialContext?.data)
      const newMaxTokens = safeUsageSum(usage.tokens, locked.tokenAllowance, 'Renewed goal token budget')
      const changed = await transaction('agentGoals')
        .where({ id: locked.id, ownerId: locked.ownerId, version: locked.version, status: locked.status })
        .update({
          status: 'active',
          version: locked.version + 1,
          continuationCount: continuation,
          consumedTokens: usage.tokens,
          maxTokens: newMaxTokens,
          budgetCycle: locked.budgetCycle + 1,
          budgetLimitReason: null,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
          completedAt: null
        })
      if (changed !== 1) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
      const admitted = await admitAgentRunInTransaction(transaction, {
        id: input.runId,
        ownerId: locked.ownerId,
        sessionId: locked.sessionId,
        clientRequestId: input.clientRequestId,
        expectedSessionVersion: context.sessionVersion,
        content,
        ...(generationTools === undefined ? {} : { generationTools }),
        ...(knowledgeContext === undefined ? {} : { knowledgeContext }),
        ...(currentPage === undefined ? {} : { currentPage: { ...currentPage } }),
        ...resolved,
        quota: { ...resolved.quota, tokens: Math.min(resolved.quota.tokens, locked.tokenAllowance) },
        goalId: locked.id,
        goalContinuation: continuation,
        userMessageVisible: false,
        skillVersionIds,
        reservationExpiresAt: new Date(Math.min(now.valueOf() + resolved.reservationMilliseconds, new Date(locked.deadlineAt).valueOf())),
        now
      })
      if (admitted.replayed) throw new AgentRepositoryError('RUN_IDEMPOTENCY_MISMATCH', 'Renewal request was replayed without its renewal receipt', 409)
      const renewedGoal = await getOwnedAgentGoal(transaction, locked.ownerId, locked.id)
      await appendAgentEvent(transaction, {
        id: randomUUID(),
        runId: admitted.run.id,
        ownerId: locked.ownerId,
        type: 'run.resumed',
        attempt: admitted.run.attempts,
        data: {
          receiptVersion: 2,
          operation: 'renew_goal_budget',
          goalId: input.goalId,
          clientRequestId: input.clientRequestId,
          expectedVersion: input.expectedVersion,
          confirmed: true,
          budgetCycle: renewedGoal.budgetCycle,
          cycleStartedAtTokens: usage.tokens,
          tokenAllowance: locked.tokenAllowance,
          maxTokens: renewedGoal.maxTokens,
          status: renewedGoal.status,
          continuationCount: renewedGoal.continuationCount
        }
      })
      return { goal: renewedGoal, run: admitted.run, replayed: false }
    })
    if (!result.replayed) {
      if (result.run === null) await this.#emitLatestGoalStatus(result.goal)
      else await emitGoalEvent(this.#knex, { goal: result.goal, run: result.run, type: 'goal.status' })
    }
    return result
  }

  async cancelGoal(input: MutateAgentGoalInput): Promise<AgentGoalRecord> {
    const goal = await updateGoalStatus(this.#knex, {
      ownerId: input.ownerId,
      goalId: input.goalId,
      expectedVersion: input.expectedVersion,
      from: ['active', 'paused', 'blocked'],
      to: 'cancelled'
    })
    const run = (await this.#knex('agentRuns')
      .where({ goalId: goal.id, ownerId: goal.ownerId })
      .whereIn('status', ['queued', 'running', 'awaiting_approval'])
      .orderBy('goalContinuation', 'desc')
      .first('id', 'attempts')) as { id: string; attempts: number } | undefined
    if (run) {
      await emitGoalEvent(this.#knex, { goal, run, type: 'goal.status' })
      await this.#coordinator.cancel(goal.ownerId, run.id)
    }
    return goal
  }

  async #advanceGoal(): Promise<void> {
    if (!this.#goals.enabled) return
    const candidates = (await this.#knex('agentGoals').where({ status: 'active' }).orderBy('updatedAt').limit(8).select('id', 'ownerId')) as Array<{
      id: string
      ownerId: number
    }>
    for (const candidate of candidates) {
      const activeRun = await this.#knex('agentRuns').where({ goalId: candidate.id }).whereIn('status', ['queued', 'running', 'awaiting_approval']).first('id')
      if (activeRun) continue
      const goal = await getOwnedAgentGoal(this.#knex, candidate.ownerId, candidate.id)
      const latest = (await this.#knex('agentRuns')
        .where({ goalId: goal.id, ownerId: goal.ownerId })
        .orderBy('goalContinuation', 'desc')
        .first('id', 'attempts', 'status', 'errorCode', 'completionOutcome', 'completionAssessment', 'completionAssessmentSha256')) as
        | {
            id: string
            attempts: number
            status: string
            errorCode: string | null
            completionOutcome: string | null
            completionAssessment: string | null
            completionAssessmentSha256: string | null
          }
        | undefined
      if (!latest) throw new AgentRepositoryError('AGENT_GOAL_CORRUPT', 'Agent goal has no run', 500)
      let usage: { readonly tokens: number; readonly toolCalls: number }
      try {
        usage = await this.#goalUsage(this.#knex, goal.id)
      } catch (error) {
        if (!(error instanceof AgentRepositoryError) || error.code !== 'AGENT_QUOTA_CORRUPT') throw error
        await this.#blockGoalForAccounting(goal)
        return
      }
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
      if (latest.errorCode === 'AGENT_BUDGET_LIMITED' || latest.errorCode === 'AGENT_TOKEN_BUDGET_LIMITED') {
        const limited = await updateGoalStatus(this.#knex, {
          ownerId: goal.ownerId,
          goalId: goal.id,
          expectedVersion: goal.version,
          from: ['active'],
          to: 'budget_limited',
          completion: completion ?? {
            outcome: 'partial',
            issues: [{ code: 'GOAL_BUDGET_LIMITED', message: 'The goal reached its host-owned continuation budget.', retryable: false }]
          },
          consumedTokens: usage.tokens,
          consumedToolCalls: usage.toolCalls,
          budgetLimitReason: goalBudgetLimitReason(goal, usage, new Date(), latest.errorCode === 'AGENT_TOKEN_BUDGET_LIMITED'),
          errorCode: 'GOAL_BUDGET_LIMITED',
          errorMessage: 'Goal execution budget was exhausted'
        })
        await emitGoalEvent(this.#knex, { goal: limited, run: latest, type: 'goal.status' })
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

  shutdown(): Promise<void> {
    return this.#coordinator.shutdown()
  }
}
