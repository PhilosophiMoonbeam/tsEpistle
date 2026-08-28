import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

import {
  AGENT_TASK_KINDS,
  type AgentChildEvidencePacket,
  type AgentEventType,
  type AgentTaskKind,
  type AgentTaskOutcome,
  type AgentTaskStatus,
  type AgentTaskView
} from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { parseChildEvidencePacket, type AgentResearchTask, type AgentValidatedPacket } from './orchestration.ts'
import type { AgentRunClaim } from './coordinator.ts'
import { AgentRepositoryError, appendAgentEvent } from './repository.ts'

interface AgentTaskRow {
  id: string
  runId: string
  parentTaskId: string | null
  subagentRunId: string | null
  ordinal: number
  depth: number
  kind: AgentTaskKind
  title: string
  question: string
  sourceScope: string
  requiredEvidenceCount: number
  required: boolean
  status: AgentTaskStatus
  outcome: AgentTaskOutcome | null
  attempt: number
  evidenceCount: number
  authoritySha256: string | null
  resultSha256: string | null
  result: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: Date | string
  updatedAt: Date | string
  startedAt: Date | string | null
  completedAt: Date | string | null
}

export interface AgentTaskRecord extends AgentResearchTask {
  readonly runId: string
  readonly subagentRunId: string | null
  readonly ordinal: number
  readonly status: AgentTaskStatus
  readonly outcome: AgentTaskOutcome | null
  readonly attempt: number
  readonly evidenceCount: number
  readonly authoritySha256: string | null
  readonly packet: AgentChildEvidencePacket | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
}

export interface AgentTaskPlanUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costMicros: number
}

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const nullableIso = (value: Date | string | null): string | null => value === null ? null : iso(value)

const parsedScope = (value: string): readonly string[] => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== 'string')) throw new Error('invalid')
    return parsed
  } catch {
    throw new AgentRepositoryError('AGENT_TASK_CORRUPT', 'Stored task scope is invalid', 500)
  }
}

const parsedPacket = (value: string | null, expectedSha256: string | null): AgentChildEvidencePacket | null => {
  if (value === null) return null
  if (expectedSha256 === null || createHash('sha256').update(value).digest('hex') !== expectedSha256) throw new AgentRepositoryError('AGENT_TASK_CORRUPT', 'Stored task result hash is invalid', 500)
  try {
    return parseChildEvidencePacket(value)
  } catch {
    throw new AgentRepositoryError('AGENT_TASK_CORRUPT', 'Stored task result is invalid', 500)
  }
}

const validTaskRow = (row: AgentTaskRow): AgentTaskRow => {
  const statuses: readonly AgentTaskStatus[] = ['pending', 'running', 'blocked', 'completed', 'failed', 'cancelled']
  const outcomes: readonly AgentTaskOutcome[] = ['completed', 'blocked', 'partial', 'failed']
  if (!AGENT_TASK_KINDS.includes(row.kind) || !statuses.includes(row.status) || (row.outcome !== null && !outcomes.includes(row.outcome)) || row.depth !== 1) {
    throw new AgentRepositoryError('AGENT_TASK_CORRUPT', 'Stored task lifecycle state is invalid', 500)
  }
  if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || !Number.isSafeInteger(row.requiredEvidenceCount) || row.requiredEvidenceCount < 1 || row.requiredEvidenceCount > 4 || !Number.isSafeInteger(row.attempt) || row.attempt < 0 || !Number.isSafeInteger(row.evidenceCount) || row.evidenceCount < 0) {
    throw new AgentRepositoryError('AGENT_TASK_CORRUPT', 'Stored task counters are invalid', 500)
  }
  if (row.authoritySha256 !== null && !/^[a-f0-9]{64}$/u.test(row.authoritySha256)) {
    throw new AgentRepositoryError('AGENT_TASK_CORRUPT', 'Stored task authority hash is invalid', 500)
  }
  return row
}

const taskRecord = (input: AgentTaskRow): AgentTaskRecord => {
  const row = validTaskRow(input)
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    title: row.title,
    question: row.question,
    sourceScope: parsedScope(row.sourceScope),
    requiredEvidenceCount: row.requiredEvidenceCount,
    subagentRunId: row.subagentRunId,
    ordinal: row.ordinal,
    status: row.status,
    outcome: row.outcome,
    attempt: row.attempt,
    evidenceCount: row.evidenceCount,
    authoritySha256: row.authoritySha256,
    packet: parsedPacket(row.result, row.resultSha256),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: iso(row.createdAt),
    startedAt: nullableIso(row.startedAt),
    completedAt: nullableIso(row.completedAt)
  }
}

const taskView = (input: AgentTaskRow): AgentTaskView => {
  const row = validTaskRow(input)
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    title: row.title,
    question: row.question,
    sourceScope: parsedScope(row.sourceScope),
    requiredEvidenceCount: row.requiredEvidenceCount,
    status: row.status,
    subagentRunId: row.subagentRunId,
    attempt: row.attempt,
    outcome: row.outcome,
    evidenceCount: row.evidenceCount,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: iso(row.createdAt),
    startedAt: nullableIso(row.startedAt),
    completedAt: nullableIso(row.completedAt)
  }
}

const eventData = (row: Pick<AgentTaskRow, 'id' | 'runId' | 'subagentRunId' | 'kind' | 'title' | 'status' | 'outcome' | 'attempt' | 'evidenceCount' | 'errorCode'>): Record<string, string | number | null> => ({
  rootRunId: row.runId,
  taskId: row.id,
  subagentRunId: row.subagentRunId,
  kind: row.kind,
  title: row.title,
  status: row.status,
  outcome: row.outcome,
  attempt: row.attempt,
  evidenceCount: row.evidenceCount,
  errorCode: row.errorCode
})

const appendTaskEvent = async (transaction: Knex.Transaction, claim: AgentRunClaim, type: AgentEventType, row: AgentTaskRow): Promise<void> => {
  await appendAgentEvent(transaction, {
    id: randomUUID(),
    runId: claim.id,
    ownerId: claim.ownerId,
    type,
    attempt: claim.attempts,
    data: eventData(row),
    ...(claim.leaseToken === null ? {} : { leaseToken: claim.leaseToken })
  })
}

export const listAgentRunTasks = async (knex: Knex | Knex.Transaction, runId: string): Promise<readonly AgentTaskRecord[]> => {
  const rows = await knex<AgentTaskRow>('agentRunTasks').where({ runId }).orderBy('ordinal')
  return rows.map(taskRecord)
}

export const listAgentTaskViews = async (knex: Knex, ownerId: number, sessionId: string): Promise<readonly AgentTaskView[]> => {
  const rows = await knex<AgentTaskRow>('agentRunTasks as tasks')
    .join('agentRuns as runs', 'runs.id', 'tasks.runId')
    .where('runs.ownerId', ownerId)
    .andWhere('runs.sessionId', sessionId)
    .select('tasks.*')
    .orderBy('runs.queuedAt')
    .orderBy('tasks.ordinal')
  return rows.map(taskView)
}

export const createAgentRunTasks = async (knex: Knex, claim: AgentRunClaim, tasks: readonly AgentResearchTask[], plannerUsage: AgentTaskPlanUsage): Promise<readonly AgentTaskRecord[]> => knex.transaction(async transaction => {
  const run = await transaction('agentRuns').where({ id: claim.id, ownerId: claim.ownerId, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken, status: 'running' }).whereNull('cancelRequestedAt').forUpdate().first('id')
  if (!run) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost before creating its task plan', 409)
  const existing = await transaction<AgentTaskRow>('agentRunTasks').where({ runId: claim.id }).orderBy('ordinal')
  if (existing.length > 0) return existing.map(taskRecord)
  const now = new Date()
  const rows: AgentTaskRow[] = tasks.map((task, ordinal) => ({
    id: task.id,
    runId: claim.id,
    parentTaskId: null,
    subagentRunId: null,
    ordinal,
    depth: 1,
    kind: task.kind,
    title: task.title,
    question: task.question,
    sourceScope: canonicalJson(task.sourceScope),
    requiredEvidenceCount: task.requiredEvidenceCount,
    required: true,
    status: 'pending',
    outcome: null,
    attempt: 0,
    evidenceCount: 0,
    authoritySha256: null,
    resultSha256: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null
  }))
  await appendAgentEvent(transaction, {
    id: randomUUID(),
    runId: claim.id,
    ownerId: claim.ownerId,
    type: 'task.planCreated',
    attempt: claim.attempts,
    data: {
      rootRunId: claim.id,
      accepted: true,
      taskCount: rows.length,
      inputTokens: plannerUsage.inputTokens,
      outputTokens: plannerUsage.outputTokens,
      costMicros: plannerUsage.costMicros
    },
    leaseToken: claim.leaseToken
  })
  if (rows.length > 0) await transaction('agentRunTasks').insert(rows)
  for (const row of rows) await appendTaskEvent(transaction, claim, 'task.created', row)
  return rows.map(taskRecord)
})

export const recoverAgentRunTasks = async (knex: Knex, claim: AgentRunClaim): Promise<void> => knex.transaction(async transaction => {
  const rows = await transaction<AgentTaskRow>('agentRunTasks').where({ runId: claim.id, status: 'running' }).forUpdate()
  for (const row of rows) {
    const failed = { ...row, status: 'pending' as const, subagentRunId: null, updatedAt: new Date(), errorCode: 'SUBAGENT_ATTEMPT_SUPERSEDED', errorMessage: 'The prior subagent attempt lost its root run lease' }
    await transaction('agentRunTasks').where({ id: row.id, runId: claim.id, status: 'running', subagentRunId: row.subagentRunId }).update({ status: failed.status, subagentRunId: null, updatedAt: failed.updatedAt, errorCode: failed.errorCode, errorMessage: failed.errorMessage })
    await appendTaskEvent(transaction, claim, 'subagent.failed', { ...failed, subagentRunId: row.subagentRunId })
  }
})

export const startAgentRunTask = async (knex: Knex, claim: AgentRunClaim, taskId: string, subagentRunId: string): Promise<AgentTaskRecord> => knex.transaction(async transaction => {
  const row = await transaction<AgentTaskRow>('agentRunTasks').where({ id: taskId, runId: claim.id }).forUpdate().first()
  if (!row || row.status !== 'pending' || row.depth !== 1) throw new AgentRepositoryError('AGENT_TASK_STATE_CHANGED', 'Agent task cannot be started from its current state', 409)
  const now = new Date()
  const started: AgentTaskRow = { ...row, status: 'running', subagentRunId, attempt: row.attempt + 1, errorCode: null, errorMessage: null, startedAt: now, completedAt: null, updatedAt: now }
  const changed = await transaction('agentRunTasks').where({ id: taskId, runId: claim.id, status: 'pending', attempt: row.attempt }).update({ status: started.status, subagentRunId, attempt: started.attempt, errorCode: null, errorMessage: null, startedAt: now, completedAt: null, updatedAt: now })
  if (changed !== 1) throw new AgentRepositoryError('AGENT_TASK_STATE_CHANGED', 'Agent task state changed concurrently', 409)
  await appendTaskEvent(transaction, claim, 'task.started', started)
  await appendTaskEvent(transaction, claim, 'subagent.started', started)
  return taskRecord(started)
})

const taskStatusForOutcome: Readonly<Record<AgentTaskOutcome, AgentTaskStatus>> = {
  completed: 'completed',
  partial: 'completed',
  blocked: 'blocked',
  failed: 'failed'
}

export const finishAgentRunTask = async (
  knex: Knex,
  claim: AgentRunClaim,
  taskId: string,
  subagentRunId: string,
  validated: AgentValidatedPacket,
  authoritySha256: string | null
): Promise<AgentTaskRecord> => knex.transaction(async transaction => {
  const row = await transaction<AgentTaskRow>('agentRunTasks').where({ id: taskId, runId: claim.id }).forUpdate().first()
  const encoded = canonicalJson(validated.packet)
  const resultSha256 = createHash('sha256').update(encoded).digest('hex')
  if (!row) throw new AgentRepositoryError('AGENT_TASK_STATE_CHANGED', 'Agent task was not found', 409)
  if (row.status !== 'running' || row.subagentRunId !== subagentRunId) {
    if (row.resultSha256 === resultSha256 && row.subagentRunId === subagentRunId) return taskRecord(row)
    throw new AgentRepositoryError('AGENT_TASK_STATE_CHANGED', 'Agent task completion does not own the active subagent attempt', 409)
  }
  const now = new Date()
  const status = taskStatusForOutcome[validated.packet.outcome]
  const finished: AgentTaskRow = { ...row, status, outcome: validated.packet.outcome, evidenceCount: validated.evidenceCount, authoritySha256, resultSha256, result: encoded, errorCode: null, errorMessage: null, completedAt: now, updatedAt: now }
  const changed = await transaction('agentRunTasks').where({ id: taskId, runId: claim.id, status: 'running', subagentRunId }).update({ status, outcome: finished.outcome, evidenceCount: finished.evidenceCount, authoritySha256, resultSha256, result: encoded, errorCode: null, errorMessage: null, completedAt: now, updatedAt: now })
  if (changed !== 1) throw new AgentRepositoryError('AGENT_TASK_STATE_CHANGED', 'Agent task state changed concurrently', 409)
  const taskEvent: AgentEventType = status === 'blocked' ? 'task.blocked' : status === 'failed' ? 'task.failed' : 'task.completed'
  const subagentEvent: AgentEventType = status === 'blocked' ? 'subagent.suspended' : status === 'failed' ? 'subagent.failed' : 'subagent.completed'
  await appendTaskEvent(transaction, claim, taskEvent, finished)
  await appendTaskEvent(transaction, claim, subagentEvent, finished)
  return taskRecord(finished)
})

export const failAgentRunTask = async (knex: Knex, claim: AgentRunClaim, taskId: string, subagentRunId: string, errorCode: string): Promise<AgentTaskRecord> => knex.transaction(async transaction => {
  const row = await transaction<AgentTaskRow>('agentRunTasks').where({ id: taskId, runId: claim.id }).forUpdate().first()
  if (!row || row.status !== 'running' || row.subagentRunId !== subagentRunId) throw new AgentRepositoryError('AGENT_TASK_STATE_CHANGED', 'Agent task failure does not own the active subagent attempt', 409)
  const now = new Date()
  const failed: AgentTaskRow = { ...row, status: 'failed', outcome: 'failed', errorCode, errorMessage: 'Subagent research failed', completedAt: now, updatedAt: now }
  await transaction('agentRunTasks').where({ id: taskId, runId: claim.id, status: 'running', subagentRunId }).update({ status: failed.status, outcome: failed.outcome, errorCode, errorMessage: failed.errorMessage, completedAt: now, updatedAt: now })
  await appendTaskEvent(transaction, claim, 'task.failed', failed)
  await appendTaskEvent(transaction, claim, 'subagent.failed', failed)
  return taskRecord(failed)
})

export const cancelAgentRunTasks = async (knex: Knex, claim: AgentRunClaim, errorCode = 'RUN_CANCELLED', errorMessage = 'Root run was cancelled'): Promise<void> => knex.transaction(async transaction => {
  const rows = await transaction<AgentTaskRow>('agentRunTasks').where({ runId: claim.id }).whereIn('status', ['pending', 'running']).forUpdate()
  for (const row of rows) {
    const now = new Date()
    const cancelled: AgentTaskRow = { ...row, status: 'cancelled', errorCode, errorMessage, completedAt: now, updatedAt: now }
    await transaction('agentRunTasks').where({ id: row.id, runId: claim.id }).whereIn('status', ['pending', 'running']).update({ status: cancelled.status, errorCode: cancelled.errorCode, errorMessage: cancelled.errorMessage, completedAt: now, updatedAt: now })
    await appendTaskEvent(transaction, claim, 'task.cancelled', cancelled)
    if (row.subagentRunId !== null) await appendTaskEvent(transaction, claim, 'subagent.failed', cancelled)
  }
})
