import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

import {
  AGENT_GOAL_STATUSES,
  type AgentCompletionAssessment,
  type AgentCompletionIssue,
  type AgentGoalStatus,
  type AgentGoalView
} from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import type { AgentRunRecord } from './coordinator.ts'
import { AgentRepositoryError, appendAgentEvent } from './repository.ts'
import type { AgentTaskRecord } from './tasks.ts'

const OPEN_GOAL_STATUSES: readonly AgentGoalStatus[] = ['active', 'paused', 'blocked']
const TERMINAL_GOAL_STATUSES: readonly AgentGoalStatus[] = ['budget_limited', 'completed', 'cancelled', 'failed']
const SHA256 = /^[a-f0-9]{64}$/u

export interface AgentGoalLimits {
  readonly enabled: boolean
  readonly maxContinuations: number
  readonly maxTokens: number
  readonly maxToolCalls: number
  readonly maxDurationMilliseconds: number
}

export const DEFAULT_AGENT_GOAL_LIMITS = {
  enabled: false,
  maxContinuations: 3,
  maxTokens: 48_000,
  maxToolCalls: 96,
  maxDurationMilliseconds: 60 * 60_000
} as const satisfies AgentGoalLimits

interface AgentGoalRow {
  id: string
  sessionId: string
  ownerId: number
  createdByUserId: number
  objective: string
  objectiveSha256: string
  status: string
  version: number
  continuationCount: number
  maxContinuations: number
  consumedTokens: number | string
  maxTokens: number | string
  consumedToolCalls: number
  maxToolCalls: number
  completionOutcome: string | null
  completionAssessment: string | null
  completionAssessmentSha256: string | null
  errorCode: string | null
  errorMessage: string | null
  startedAt: Date | string
  deadlineAt: Date | string
  updatedAt: Date | string
  completedAt: Date | string | null
}

export interface AgentGoalRecord {
  readonly id: string
  readonly sessionId: string
  readonly ownerId: number
  readonly createdByUserId: number
  readonly objective: string
  readonly objectiveSha256: string
  readonly status: AgentGoalStatus
  readonly version: number
  readonly continuationCount: number
  readonly maxContinuations: number
  readonly consumedTokens: number
  readonly maxTokens: number
  readonly consumedToolCalls: number
  readonly maxToolCalls: number
  readonly completion: AgentCompletionAssessment | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly startedAt: string
  readonly deadlineAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const iso = (value: Date | string): string => new Date(value).toISOString()
const nullableIso = (value: Date | string | null): string | null => value === null ? null : iso(value)

export const decodeCompletionAssessment = (
  encoded: string | null,
  expectedOutcome: string | null,
  expectedSha256: string | null
): AgentCompletionAssessment | null => {
  if (encoded === null) {
    if (expectedOutcome !== null || expectedSha256 !== null) throw new AgentRepositoryError('AGENT_COMPLETION_CORRUPT', 'Agent completion assessment is incomplete', 500)
    return null
  }
  if (!expectedSha256 || !SHA256.test(expectedSha256) || sha256(encoded) !== expectedSha256) {
    throw new AgentRepositoryError('AGENT_COMPLETION_CORRUPT', 'Agent completion assessment integrity check failed', 500)
  }
  let value: unknown
  try { value = JSON.parse(encoded) } catch { throw new AgentRepositoryError('AGENT_COMPLETION_CORRUPT', 'Agent completion assessment is invalid', 500) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AgentRepositoryError('AGENT_COMPLETION_CORRUPT', 'Agent completion assessment is invalid', 500)
  const outcome = Reflect.get(value, 'outcome')
  const issues = Reflect.get(value, 'issues')
  if (!['complete', 'retry', 'blocked', 'partial'].includes(String(outcome)) || !Array.isArray(issues) || issues.some(issue => typeof issue !== 'object' || issue === null || typeof Reflect.get(issue, 'code') !== 'string' || typeof Reflect.get(issue, 'message') !== 'string' || typeof Reflect.get(issue, 'retryable') !== 'boolean')) {
    throw new AgentRepositoryError('AGENT_COMPLETION_CORRUPT', 'Agent completion assessment is invalid', 500)
  }
  if (expectedOutcome !== outcome) throw new AgentRepositoryError('AGENT_COMPLETION_CORRUPT', 'Agent completion outcome does not match its assessment', 500)
  return value as AgentCompletionAssessment
}

const parseAssessment = (row: AgentGoalRow): AgentCompletionAssessment | null =>
  decodeCompletionAssessment(row.completionAssessment, row.completionOutcome, row.completionAssessmentSha256)

export const agentGoalRecord = (row: AgentGoalRow): AgentGoalRecord => {
  if (!AGENT_GOAL_STATUSES.includes(row.status as AgentGoalStatus) || !SHA256.test(row.objectiveSha256) || sha256(row.objective) !== row.objectiveSha256) {
    throw new AgentRepositoryError('AGENT_GOAL_CORRUPT', 'Stored agent goal is invalid', 500)
  }
  const numeric = [row.version, row.continuationCount, row.maxContinuations, Number(row.consumedTokens), Number(row.maxTokens), row.consumedToolCalls, row.maxToolCalls]
  if (numeric.some(value => !Number.isSafeInteger(value) || value < 0) || row.version < 1 || Number(row.maxTokens) < 1 || row.maxToolCalls < 1) {
    throw new AgentRepositoryError('AGENT_GOAL_CORRUPT', 'Stored agent goal counters are invalid', 500)
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    ownerId: row.ownerId,
    createdByUserId: row.createdByUserId,
    objective: row.objective,
    objectiveSha256: row.objectiveSha256,
    status: row.status as AgentGoalStatus,
    version: Number(row.version),
    continuationCount: Number(row.continuationCount),
    maxContinuations: Number(row.maxContinuations),
    consumedTokens: Number(row.consumedTokens),
    maxTokens: Number(row.maxTokens),
    consumedToolCalls: Number(row.consumedToolCalls),
    maxToolCalls: Number(row.maxToolCalls),
    completion: parseAssessment(row),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: iso(row.startedAt),
    deadlineAt: iso(row.deadlineAt),
    updatedAt: iso(row.updatedAt),
    completedAt: nullableIso(row.completedAt)
  }
}

export const getOwnedAgentGoal = async (knex: Knex | Knex.Transaction, ownerId: number, goalId: string, lock = false): Promise<AgentGoalRecord> => {
  const query = knex<AgentGoalRow>('agentGoals').where({ id: goalId, ownerId })
  if (lock) query.forUpdate()
  const row = await query.first()
  if (!row) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent goal was not found', 404)
  return agentGoalRecord(row)
}

export const latestAgentGoalForSession = async (knex: Knex | Knex.Transaction, ownerId: number, sessionId: string): Promise<AgentGoalRecord | null> => {
  const row = await knex<AgentGoalRow>('agentGoals').where({ ownerId, sessionId }).orderBy('startedAt', 'desc').first()
  return row ? agentGoalRecord(row) : null
}

export interface InsertAgentGoalInput {
  readonly id: string
  readonly sessionId: string
  readonly ownerId: number
  readonly objective: string
  readonly limits: AgentGoalLimits
  readonly now?: Date
}

export const insertAgentGoal = async (transaction: Knex.Transaction, input: InsertAgentGoalInput): Promise<AgentGoalRecord> => {
  const objective = input.objective.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (objective.length < 1 || objective.length > 32_000) throw new AgentRepositoryError('INVALID_AGENT_GOAL', 'Agent goal objective is invalid', 400)
  const existing = await transaction<AgentGoalRow>('agentGoals').where({ id: input.id, ownerId: input.ownerId }).first()
  if (existing) {
    const goal = agentGoalRecord(existing)
    if (goal.sessionId !== input.sessionId || goal.objectiveSha256 !== sha256(objective)) throw new AgentRepositoryError('GOAL_IDEMPOTENCY_MISMATCH', 'Goal ID was reused with different input', 409)
    return goal
  }
  const open = await transaction('agentGoals').where({ sessionId: input.sessionId }).whereIn('status', OPEN_GOAL_STATUSES).first('id')
  if (open) throw new AgentRepositoryError('SESSION_GOAL_ACTIVE', 'The conversation already has an open goal', 409)
  const now = input.now ?? new Date()
  const row: AgentGoalRow = {
    id: input.id,
    sessionId: input.sessionId,
    ownerId: input.ownerId,
    createdByUserId: input.ownerId,
    objective,
    objectiveSha256: sha256(objective),
    status: 'active',
    version: 1,
    continuationCount: 0,
    maxContinuations: input.limits.maxContinuations,
    consumedTokens: 0,
    maxTokens: input.limits.maxTokens,
    consumedToolCalls: 0,
    maxToolCalls: input.limits.maxToolCalls,
    completionOutcome: null,
    completionAssessment: null,
    completionAssessmentSha256: null,
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    deadlineAt: new Date(now.valueOf() + input.limits.maxDurationMilliseconds),
    updatedAt: now,
    completedAt: null
  }
  await transaction('agentGoals').insert(row)
  return agentGoalRecord(row)
}

const issue = (code: string, message: string, retryable: boolean): AgentCompletionIssue => ({ code, message, retryable })

export const assessAgentRunCompletion = (input: {
  readonly tasks: readonly AgentTaskRecord[]
  readonly pendingProposalCount: number
  readonly evidenceGatePassed: boolean
  readonly usageReconciled: boolean
}): AgentCompletionAssessment => {
  const issues: AgentCompletionIssue[] = []
  for (const task of input.tasks) {
    if (task.status === 'pending' || task.status === 'running') issues.push(issue('REQUIRED_TASK_NOT_TERMINAL', `Research task “${task.title}” is not terminal.`, true))
    else if (task.status !== 'completed' || task.outcome !== 'completed') issues.push(issue('REQUIRED_TASK_INCOMPLETE', `Research task “${task.title}” did not complete.`, true))
    else if (task.evidenceCount < task.requiredEvidenceCount) issues.push(issue('REQUIRED_EVIDENCE_MISSING', `Research task “${task.title}” did not satisfy its evidence requirement.`, true))
  }
  if (!input.evidenceGatePassed) issues.push(issue('EVIDENCE_GATE_FAILED', 'The answer did not pass citation and evidence validation.', true))
  if (input.pendingProposalCount > 0) issues.push(issue('APPROVAL_PENDING', 'A required proposal is still awaiting resolution.', false))
  if (!input.usageReconciled) issues.push(issue('USAGE_NOT_RECONCILED', 'Aggregate usage has not been reconciled.', true))
  const outcome = issues.length === 0
    ? 'complete'
    : issues.some(entry => entry.code === 'APPROVAL_PENDING')
      ? 'blocked'
      : issues.some(entry => entry.retryable)
        ? 'retry'
        : 'partial'
  return { outcome, issues }
}

export const encodedCompletionAssessment = (assessment: AgentCompletionAssessment): { readonly encoded: string, readonly sha256: string } => {
  const encoded = canonicalJson(assessment)
  return { encoded, sha256: sha256(encoded) }
}

export const updateGoalStatus = async (knex: Knex, input: {
  readonly ownerId: number
  readonly goalId: string
  readonly expectedVersion?: number
  readonly from: readonly AgentGoalStatus[]
  readonly to: AgentGoalStatus
  readonly completion?: AgentCompletionAssessment | null
  readonly consumedTokens?: number
  readonly consumedToolCalls?: number
  readonly continuationCount?: number
  readonly errorCode?: string | null
  readonly errorMessage?: string | null
  readonly now?: Date
}): Promise<AgentGoalRecord> => knex.transaction(async transaction => {
  const goal = await getOwnedAgentGoal(transaction, input.ownerId, input.goalId, true)
  if (input.expectedVersion !== undefined && goal.version !== input.expectedVersion) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
  if (!input.from.includes(goal.status)) throw new AgentRepositoryError('INVALID_GOAL_TRANSITION', 'Agent goal transition is invalid', 409)
  const now = input.now ?? new Date()
  const terminal = TERMINAL_GOAL_STATUSES.includes(input.to)
  const completion = input.completion === undefined ? goal.completion : input.completion
  const assessment = completion === null ? null : encodedCompletionAssessment(completion)
  const changed = await transaction('agentGoals').where({ id: goal.id, ownerId: goal.ownerId, version: goal.version, status: goal.status }).update({
    status: input.to,
    version: goal.version + 1,
    continuationCount: input.continuationCount ?? goal.continuationCount,
    consumedTokens: input.consumedTokens ?? goal.consumedTokens,
    consumedToolCalls: input.consumedToolCalls ?? goal.consumedToolCalls,
    completionOutcome: completion?.outcome ?? null,
    completionAssessment: assessment?.encoded ?? null,
    completionAssessmentSha256: assessment?.sha256 ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    updatedAt: now,
    completedAt: terminal ? now : null
  })
  if (changed !== 1) throw new AgentRepositoryError('GOAL_VERSION_CHANGED', 'Agent goal changed concurrently', 409)
  return getOwnedAgentGoal(transaction, goal.ownerId, goal.id)
})

export const emitGoalEvent = async (knex: Knex, input: {
  readonly goal: AgentGoalRecord
  readonly run: Pick<AgentRunRecord, 'id' | 'attempts'>
  readonly type: 'goal.created' | 'goal.status' | 'run.interrupted' | 'run.resumed'
}): Promise<void> => {
  await appendAgentEvent(knex, {
    id: randomUUID(),
    runId: input.run.id,
    ownerId: input.goal.ownerId,
    attempt: input.run.attempts,
    type: input.type,
    data: {
      goalId: input.goal.id,
      status: input.goal.status,
      continuationCount: input.goal.continuationCount
    }
  })
}

export const projectAgentGoal = (goal: AgentGoalRecord, currentRunId: string | null): AgentGoalView => ({
  id: goal.id,
  sessionId: goal.sessionId,
  objective: goal.objective,
  status: goal.status,
  version: goal.version,
  currentRunId,
  continuationCount: goal.continuationCount,
  maxContinuations: goal.maxContinuations,
  consumedTokens: goal.consumedTokens,
  maxTokens: goal.maxTokens,
  consumedToolCalls: goal.consumedToolCalls,
  maxToolCalls: goal.maxToolCalls,
  startedAt: goal.startedAt,
  deadlineAt: goal.deadlineAt,
  completedAt: goal.completedAt,
  errorCode: goal.errorCode,
  errorMessage: goal.errorMessage,
  completion: goal.completion
})
