import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { AgentActionName, AgentEventData, AgentExecutionMode, AgentRunStatus } from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { AgentRepositoryError } from './repository.ts'

const ACTIVE_STATUSES: readonly AgentRunStatus[] = ['queued', 'running', 'awaiting_approval']
const TERMINAL_STATUSES: readonly AgentRunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled', 'recovery_required']
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const dateValue = (value: Date | string | null): number | null => value === null ? null : new Date(value).valueOf()
const isPostgres = (knex: Knex | Knex.Transaction): boolean => knex.client.config.client === 'pg' || knex.client.config.client === 'postgresql'

const ACTION_CONTINUATION_KEY = '__wikiApprovalContinuation'
const MAX_ACTION_CONTINUATION_BYTES = 96 * 1_024
const MAX_RUNTIME_STATE_BYTES = 256 * 1_024
const SHA256 = /^[a-f0-9]{64}$/

export interface AgentApprovalContinuationCheckpoint {
  readonly version: 1
  readonly runId: string
  readonly ownerId: number
  readonly attempt: number
  readonly actionCallId: string
  readonly actionName: AgentActionName
  readonly actionInput: unknown
  readonly actionInputSha256: string
  readonly proposalId: string
  readonly approvalId: string
  readonly proposalInputHash: string
  readonly authorityVersion: 1
  readonly authoritySha256: string
  readonly checkpointSha256: string
}

type RuntimeState = Record<string, unknown>
type CheckpointBody = Omit<AgentApprovalContinuationCheckpoint, 'checkpointSha256'>

const runtimeState = (value: Uint8Array | null): RuntimeState => {
  if (value === null) return {}
  if (value.byteLength > MAX_RUNTIME_STATE_BYTES) throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_CORRUPT', 'Stored runtime state is too large', 500)
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid runtime state')
    return parsed as RuntimeState
  } catch {
    throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_CORRUPT', 'Stored runtime state is invalid', 500)
  }
}

const checkpointHash = (body: CheckpointBody): string => sha256(canonicalJson(body))

const decodeActionContinuation = (state: RuntimeState): AgentApprovalContinuationCheckpoint | null => {
  const value = state[ACTION_CONTINUATION_KEY]
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_CORRUPT', 'Stored action continuation is invalid', 500)
  }
  const checkpoint = value as unknown as AgentApprovalContinuationCheckpoint
  const {
    version,
    runId,
    ownerId,
    attempt,
    actionCallId,
    actionName,
    actionInput,
    actionInputSha256,
    proposalId,
    approvalId,
    proposalInputHash,
    authorityVersion,
    authoritySha256,
    checkpointSha256
  } = checkpoint
  const body: CheckpointBody = { version, runId, ownerId, attempt, actionCallId, actionName, actionInput, actionInputSha256, proposalId, approvalId, proposalInputHash, authorityVersion, authoritySha256 }
  let hashesValid = false
  let encodedBytes = Number.POSITIVE_INFINITY
  try {
    encodedBytes = Buffer.byteLength(canonicalJson(value), 'utf8')
    hashesValid = sha256(canonicalJson(actionInput)) === actionInputSha256 && checkpointHash(body) === checkpointSha256
  } catch {
    hashesValid = false
  }
  if (
    encodedBytes > MAX_ACTION_CONTINUATION_BYTES ||
    Object.keys(value).length !== 14 ||
    version !== 1 ||
    typeof runId !== 'string' ||
    !Number.isSafeInteger(ownerId) ||
    ownerId < 1 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    typeof actionCallId !== 'string' ||
    actionCallId.length < 1 ||
    actionCallId.length > 128 ||
    typeof actionName !== 'string' ||
    typeof proposalId !== 'string' ||
    typeof approvalId !== 'string' ||
    !SHA256.test(actionInputSha256) ||
    !SHA256.test(proposalInputHash) ||
    authorityVersion !== 1 ||
    !SHA256.test(authoritySha256) ||
    !SHA256.test(checkpointSha256) ||
    !hashesValid
  ) throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_CORRUPT', 'Stored action continuation failed validation', 500)
  return checkpoint
}

const encodedRuntimeState = (state: RuntimeState): Buffer => {
  const encoded = canonicalJson(state)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RUNTIME_STATE_BYTES) throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_TOO_LARGE', 'Runtime state with action continuation exceeds its size limit', 500)
  return Buffer.from(encoded)
}

const advisoryLock = async (transaction: Knex.Transaction, ownerId?: number): Promise<void> => {
  if (!isPostgres(transaction)) return
  await transaction.raw('SELECT pg_advisory_xact_lock(?)', [0x57494b49])
  if (ownerId !== undefined) await transaction.raw('SELECT pg_advisory_xact_lock(?)', [ownerId])
}

export interface AgentRunRecord {
  readonly id: string
  readonly sessionId: string
  readonly userMessageId: string
  readonly assistantMessageId: string
  readonly ownerId: number
  readonly goalId: string | null
  readonly goalContinuation: number | null
  readonly clientRequestId: string
  readonly clientRequestSha256: string
  readonly status: AgentRunStatus
  readonly providerProfileVersionId: string
  readonly transportKind: string
  readonly model: string
  readonly executionMode: string
  readonly capabilityRevision: string
  readonly pricingRevision: string
  readonly promptVersion: number
  readonly attempts: number
  readonly maxAttempts: number
  readonly eventSequence: number
  readonly leaseOwner: string | null
  readonly leaseToken: string | null
  readonly leaseExpiresAt: string | null
  readonly cancelRequestedAt: string | null
  readonly sideEffectsStarted: boolean
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly queuedAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
}

interface RunRow extends Omit<AgentRunRecord, 'status' | 'leaseExpiresAt' | 'cancelRequestedAt' | 'queuedAt' | 'startedAt' | 'completedAt'> {
  status: string
  leaseExpiresAt: Date | string | null
  cancelRequestedAt: Date | string | null
  queuedAt: Date | string
  startedAt: Date | string | null
  completedAt: Date | string | null
  runtimeStateCiphertext?: Uint8Array | null
}

const runStatus = (value: string): AgentRunStatus => {
  if (ACTIVE_STATUSES.includes(value as AgentRunStatus) || TERMINAL_STATUSES.includes(value as AgentRunStatus)) return value as AgentRunStatus
  throw new AgentRepositoryError('AGENT_RUN_CORRUPT', 'Agent run status is invalid', 500)
}

const runRecord = (row: RunRow): AgentRunRecord => ({
  ...row,
  status: runStatus(row.status),
  leaseExpiresAt: row.leaseExpiresAt === null ? null : new Date(row.leaseExpiresAt).toISOString(),
  cancelRequestedAt: row.cancelRequestedAt === null ? null : new Date(row.cancelRequestedAt).toISOString(),
  queuedAt: new Date(row.queuedAt).toISOString(),
  startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
  completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString()
})

export const getOwnedAgentRun = async (knex: Knex | Knex.Transaction, ownerId: number, runId: string): Promise<AgentRunRecord> => {
  const row = await knex<RunRow>('agentRuns').where({ id: runId, ownerId }).first()
  if (!row) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent run was not found', 404)
  return runRecord(row)
}

export interface AgentQuotaLimits {
  readonly dailyTokens: number
  readonly dailyCostMicros: number
}

export interface AgentQuotaRequest {
  readonly tokens: number
  readonly costMicros: number
}

const nonNegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new AgentRepositoryError('INVALID_AGENT_QUOTA', `${name} must be a non-negative safe integer`, 400)
  return value
}

const dayKey = (date: Date): string => date.toISOString().slice(0, 10)

const reserveQuotaInTransaction = async (transaction: Knex.Transaction, runId: string, ownerId: number, request: AgentQuotaRequest, limits: AgentQuotaLimits, now: Date, expiresAt: Date): Promise<void> => {
  const tokens = nonNegativeInteger(request.tokens, 'Reserved tokens')
  const costMicros = nonNegativeInteger(request.costMicros, 'Reserved cost')
  const tokenLimit = nonNegativeInteger(limits.dailyTokens, 'Daily token limit')
  const costLimit = nonNegativeInteger(limits.dailyCostMicros, 'Daily cost limit')
  await advisoryLock(transaction, ownerId)

  const existingReservation = await transaction('agentQuotaReservations').where({ runId }).first() as { ownerId: number, reservedTokens: number | string, reservedCostMicros: number | string } | undefined
  if (existingReservation) {
    if (existingReservation.ownerId !== ownerId || Number(existingReservation.reservedTokens) !== tokens || Number(existingReservation.reservedCostMicros) !== costMicros) throw new AgentRepositoryError('QUOTA_RESERVATION_MISMATCH', 'Run quota reservation does not match its retry', 409)
    return
  }

  const day = dayKey(now)
  let daily = await transaction('agentQuotaDaily').where({ ownerId, day }).forUpdate().first() as { reservedTokens: number | string, consumedTokens: number | string, reservedCostMicros: number | string, consumedCostMicros: number | string } | undefined
  if (!daily) {
    await transaction('agentQuotaDaily').insert({ ownerId, day, reservedTokens: 0, consumedTokens: 0, reservedCostMicros: 0, consumedCostMicros: 0, updatedAt: now }).onConflict(['ownerId', 'day']).ignore()
    daily = await transaction('agentQuotaDaily').where({ ownerId, day }).forUpdate().first()
  }
  if (!daily) throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', 'Agent daily quota row is missing', 500)
  const reservedTokens = Number(daily.reservedTokens)
  const consumedTokens = Number(daily.consumedTokens)
  const reservedCost = Number(daily.reservedCostMicros)
  const consumedCost = Number(daily.consumedCostMicros)
  if (reservedTokens + consumedTokens + tokens > tokenLimit || reservedCost + consumedCost + costMicros > costLimit) throw new AgentRepositoryError('AGENT_QUOTA_EXHAUSTED', 'Agent daily quota is exhausted', 429)

  await transaction('agentQuotaDaily').where({ ownerId, day }).update({ reservedTokens: reservedTokens + tokens, reservedCostMicros: reservedCost + costMicros, updatedAt: now })
  await transaction('agentQuotaReservations').insert({ runId, ownerId, day, reservedTokens: tokens, reservedCostMicros: costMicros, consumedTokens: 0, consumedCostMicros: 0, status: 'reserved', expiresAt, heartbeatAt: now, reconciledAt: null })
}

export const reserveAgentRunQuota = async (knex: Knex, runId: string, ownerId: number, request: AgentQuotaRequest, limits: AgentQuotaLimits, expiresAt: Date, now = new Date()): Promise<void> => knex.transaction(transaction => reserveQuotaInTransaction(transaction, runId, ownerId, request, limits, now, expiresAt))

export interface ReconcileAgentQuotaInput {
  readonly runId: string
  readonly ownerId: number
  readonly consumedTokens: number
  readonly consumedCostMicros: number
  readonly status: 'consumed' | 'released'
  readonly now?: Date
}

export const reconcileAgentRunQuota = async (knex: Knex, input: ReconcileAgentQuotaInput): Promise<void> => {
  const consumedTokens = nonNegativeInteger(input.consumedTokens, 'Consumed tokens')
  const consumedCost = nonNegativeInteger(input.consumedCostMicros, 'Consumed cost')
  const now = input.now ?? new Date()
  await knex.transaction(async transaction => {
    await advisoryLock(transaction, input.ownerId)
    const reservation = await transaction('agentQuotaReservations').where({ runId: input.runId, ownerId: input.ownerId }).forUpdate().first() as { day: string, reservedTokens: number | string, reservedCostMicros: number | string, consumedTokens: number | string, consumedCostMicros: number | string, status: string } | undefined
    if (!reservation) throw new AgentRepositoryError('QUOTA_RESERVATION_NOT_FOUND', 'Agent quota reservation was not found', 404)
    if (reservation.status !== 'reserved') {
      if (reservation.status === input.status && Number(reservation.consumedTokens) === consumedTokens && Number(reservation.consumedCostMicros) === consumedCost) return
      throw new AgentRepositoryError('QUOTA_RESERVATION_RECONCILED', 'Agent quota reservation was already reconciled differently', 409)
    }
    if (input.status === 'released' && (consumedTokens !== 0 || consumedCost !== 0)) throw new AgentRepositoryError('INVALID_AGENT_QUOTA', 'Released quota cannot record consumption', 400)
    const daily = await transaction('agentQuotaDaily').where({ ownerId: input.ownerId, day: reservation.day }).forUpdate().first() as { reservedTokens: number | string, consumedTokens: number | string, reservedCostMicros: number | string, consumedCostMicros: number | string } | undefined
    if (!daily) throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', 'Agent daily quota row is missing', 500)
    const reservedTokens = Number(reservation.reservedTokens)
    const reservedCost = Number(reservation.reservedCostMicros)
    if (Number(daily.reservedTokens) < reservedTokens || Number(daily.reservedCostMicros) < reservedCost) throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', 'Agent daily quota counters are inconsistent', 500)
    await transaction('agentQuotaDaily').where({ ownerId: input.ownerId, day: reservation.day }).update({
      reservedTokens: Number(daily.reservedTokens) - reservedTokens,
      consumedTokens: Number(daily.consumedTokens) + consumedTokens,
      reservedCostMicros: Number(daily.reservedCostMicros) - reservedCost,
      consumedCostMicros: Number(daily.consumedCostMicros) + consumedCost,
      updatedAt: now
    })
    await transaction('agentQuotaReservations').where({ runId: input.runId, status: 'reserved' }).update({ status: input.status, consumedTokens, consumedCostMicros: consumedCost, reconciledAt: now, heartbeatAt: now })
  })
}

export interface AdmitAgentRunInput {
  readonly id?: string
  readonly userMessageId?: string
  readonly assistantMessageId?: string
  readonly queuedEventId?: string
  readonly goalId?: string
  readonly goalContinuation?: number
  readonly userMessageVisible?: boolean
  readonly ownerId: number
  readonly sessionId: string
  readonly clientRequestId: string
  readonly expectedSessionVersion: number
  readonly profileResolutionSha256: string
  readonly content: string
  readonly currentPage?: Readonly<Record<string, unknown>>
  readonly providerProfileVersionId: string
  readonly transportKind: string
  readonly model: string
  readonly executionMode: AgentExecutionMode
  readonly profilePolicyVersion: number
  readonly defaultGeneration: number
  readonly capabilityRevision: string
  readonly pricingRevision: string
  readonly promptVersion: number
  readonly skillVersionIds: readonly string[]
  readonly quota: AgentQuotaRequest
  readonly quotaLimits: AgentQuotaLimits
  readonly maxAttempts?: number
  readonly reservationExpiresAt: Date
  readonly now?: Date
}

const admissionEnvelope = (input: AdmitAgentRunInput): string => canonicalJson({
  sessionId: input.sessionId,
  clientRequestId: input.clientRequestId,
  expectedSessionVersion: input.expectedSessionVersion,
  profileResolutionSha256: input.profileResolutionSha256,
  goalId: input.goalId ?? null,
  goalContinuation: input.goalContinuation ?? null,
  userMessageVisible: input.userMessageVisible ?? true,
  content: input.content,
  currentPage: input.currentPage ?? null,
  providerProfileVersionId: input.providerProfileVersionId,
  transportKind: input.transportKind,
  model: input.model,
  executionMode: input.executionMode,
  profilePolicyVersion: input.profilePolicyVersion,
  defaultGeneration: input.defaultGeneration,
  capabilityRevision: input.capabilityRevision,
  pricingRevision: input.pricingRevision,
  promptVersion: input.promptVersion,
  skillVersionIds: input.skillVersionIds,
  quota: input.quota
})

const nextMessageOrdinal = async (transaction: Knex.Transaction, sessionId: string): Promise<number> => {
  const latest = await transaction('agentMessages').where({ sessionId }).max('ordinal as ordinal').first() as { ordinal: number | string | null } | undefined
  return Number(latest?.ordinal ?? 0) + 1
}

const queuedEventData = (runId: string, currentPage?: Readonly<Record<string, unknown>>): { data: string, dataSha256: string } => {
  const value: AgentEventData = { runId, status: 'queued', ...(currentPage === undefined ? {} : { currentPage }) }
  const data = canonicalJson(value)
  return { data, dataSha256: sha256(data) }
}

export const admitAgentRunInTransaction = async (transaction: Knex.Transaction, input: AdmitAgentRunInput): Promise<{ readonly run: AgentRunRecord, readonly replayed: boolean }> => {
  if (!/^[a-f0-9]{64}$/.test(input.profileResolutionSha256)) throw new AgentRepositoryError('INVALID_PROFILE_RESOLUTION', 'Profile resolution hash is invalid', 400)
  if (input.content.length < 1 || input.content.length > 32_000) throw new AgentRepositoryError('INVALID_AGENT_MESSAGE', 'Agent message content is invalid', 400)
  if ((input.goalId === undefined) !== (input.goalContinuation === undefined) || (input.goalContinuation !== undefined && (!Number.isSafeInteger(input.goalContinuation) || input.goalContinuation < 0))) {
    throw new AgentRepositoryError('INVALID_AGENT_GOAL', 'Agent goal association is invalid', 400)
  }
  const inputHash = sha256(admissionEnvelope(input))
  const now = input.now ?? new Date()
  await advisoryLock(transaction, input.ownerId)
  const retry = await transaction<RunRow>('agentRuns').where({ sessionId: input.sessionId, clientRequestId: input.clientRequestId, ownerId: input.ownerId }).first()
  if (retry) {
    if (retry.clientRequestSha256 !== inputHash) throw new AgentRepositoryError('RUN_IDEMPOTENCY_MISMATCH', 'Client request ID was reused with different input', 409)
    return { run: runRecord(retry), replayed: true }
  }
  const session = await transaction('agentSessions').where({ id: input.sessionId, ownerId: input.ownerId }).whereNull('deletedAt').forUpdate().first() as { version: number } | undefined
  if (!session) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent resource was not found', 404)
  if (session.version !== input.expectedSessionVersion) throw new AgentRepositoryError('SESSION_VERSION_CHANGED', 'Agent session changed concurrently', 409)
  const active = await transaction('agentRuns').where({ sessionId: input.sessionId }).whereIn('status', ACTIVE_STATUSES).first('id')
  if (active) throw new AgentRepositoryError('SESSION_RUN_ACTIVE', 'Agent session already has an active run', 409)

  const runId = input.id ?? randomUUID()
  const userMessageId = input.userMessageId ?? randomUUID()
  const assistantMessageId = input.assistantMessageId ?? randomUUID()
  const ordinal = await nextMessageOrdinal(transaction, input.sessionId)
  await transaction('agentMessages').insert([
    { id: userMessageId, sessionId: input.sessionId, runId: null, ordinal, role: 'user', status: 'complete', content: input.content, citations: null, isVisible: input.userMessageVisible ?? true, createdAt: now, updatedAt: now },
    { id: assistantMessageId, sessionId: input.sessionId, runId: null, ordinal: ordinal + 1, role: 'assistant', status: 'pending', content: '', citations: null, isVisible: true, createdAt: now, updatedAt: now }
  ])
  const row = {
    id: runId,
    sessionId: input.sessionId,
    userMessageId,
    assistantMessageId,
    ownerId: input.ownerId,
    clientRequestId: input.clientRequestId,
    clientRequestSha256: inputHash,
    profileResolutionSha256: input.profileResolutionSha256,
    goalId: input.goalId ?? null,
    goalContinuation: input.goalContinuation ?? null,
    status: 'queued',
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    eventSequence: 1,
    availableAt: now,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    cancelRequestedAt: null,
    sideEffectsStarted: false,
    providerProfileVersionId: input.providerProfileVersionId,
    transportKind: input.transportKind,
    model: input.model,
    executionMode: input.executionMode,
    profilePolicyVersion: input.profilePolicyVersion,
    defaultGeneration: input.defaultGeneration,
    capabilityRevision: input.capabilityRevision,
    pricingRevision: input.pricingRevision,
    promptVersion: input.promptVersion,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostMicros: null,
    completionOutcome: null,
    completionAssessment: null,
    completionAssessmentSha256: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: now,
    startedAt: null,
    updatedAt: now,
    completedAt: null
  }
  await transaction('agentRuns').insert(row)
  await transaction('agentMessages').whereIn('id', [userMessageId, assistantMessageId]).update({ runId })
  if (input.skillVersionIds.length > 0) await transaction('agentRunSkills').insert(input.skillVersionIds.map((skillVersionId, ordinal) => ({ runId, skillVersionId, ordinal })))
  await reserveQuotaInTransaction(transaction, runId, input.ownerId, input.quota, input.quotaLimits, now, input.reservationExpiresAt)
  const event = queuedEventData(runId, input.currentPage)
  await transaction('agentEvents').insert({ id: input.queuedEventId ?? randomUUID(), runId, sequence: 1, type: 'run.queued', attempt: 0, schemaVersion: 1, dataSha256: event.dataSha256, data: event.data, createdAt: now })
  if (transaction.client.config.client === 'pg' || transaction.client.config.client === 'postgresql') {
    await transaction.raw("SELECT pg_notify('wiki_agent_events', ?)", [runId])
  }
  await transaction('agentSessions').where({ id: input.sessionId }).update({ lastActivityAt: now, updatedAt: now })
  return { run: runRecord(row), replayed: false }
}

export const admitAgentRun = async (knex: Knex, input: AdmitAgentRunInput): Promise<{ readonly run: AgentRunRecord, readonly replayed: boolean }> =>
  knex.transaction(transaction => admitAgentRunInTransaction(transaction, input))

export interface AgentRunClaim extends AgentRunRecord {
  readonly leaseOwner: string
  readonly leaseToken: string
  readonly leaseExpiresAt: string
}

interface PersistAgentApprovalContinuationInput {
  readonly runId: string
  readonly ownerId: number
  readonly attempt: number
  readonly leaseToken: string
  readonly actionCallId: string
  readonly actionName: AgentActionName
  readonly actionInput: unknown
  readonly proposalId: string
  readonly approvalId: string
  readonly proposalInputHash: string
  readonly authorityVersion: 1
  readonly authoritySha256: string
}

const assertContinuationLedger = async (knex: Knex | Knex.Transaction, checkpoint: AgentApprovalContinuationCheckpoint): Promise<void> => {
  const [proposal, approval] = await Promise.all([
    knex('agentProposals').where({ id: checkpoint.proposalId }).first('sourceKind', 'runId', 'requesterRequestId', 'requesterUserId', 'actionCallId', 'actionName', 'input', 'inputHash', 'authorityVersion', 'authoritySha256') as Promise<{
      sourceKind: string
      runId: string | null
      requesterRequestId: string
      requesterUserId: number | null
      actionCallId: string
      actionName: string
      input: string | null
      inputHash: string
      authorityVersion: number
      authoritySha256: string
    } | undefined>,
    knex('agentApprovals').where({ id: checkpoint.approvalId, proposalId: checkpoint.proposalId }).first('runId', 'requesterUserId', 'inputHash', 'authorityVersion', 'authoritySha256') as Promise<{
      runId: string | null
      requesterUserId: number | null
      inputHash: string
      authorityVersion: number
      authoritySha256: string
    } | undefined>
  ])
  if (
    !proposal ||
    !approval ||
    proposal.sourceKind !== 'agent' ||
    proposal.runId !== checkpoint.runId ||
    proposal.requesterRequestId !== checkpoint.runId ||
    approval.runId !== checkpoint.runId ||
    proposal.requesterUserId !== checkpoint.ownerId ||
    approval.requesterUserId !== checkpoint.ownerId ||
    proposal.actionCallId !== checkpoint.actionCallId ||
    proposal.actionName !== checkpoint.actionName ||
    proposal.input !== canonicalJson(checkpoint.actionInput) ||
    proposal.inputHash !== checkpoint.proposalInputHash ||
    approval.inputHash !== checkpoint.proposalInputHash ||
    Number(proposal.authorityVersion) !== checkpoint.authorityVersion ||
    Number(approval.authorityVersion) !== checkpoint.authorityVersion ||
    proposal.authoritySha256 !== checkpoint.authoritySha256 ||
    approval.authoritySha256 !== checkpoint.authoritySha256
  ) throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_MISMATCH', 'Action continuation does not match its proposal authority ledger', 409)
}

export const persistAgentApprovalContinuation = async (knex: Knex, input: PersistAgentApprovalContinuationInput): Promise<void> => {
  const actionInputSha256 = sha256(canonicalJson(input.actionInput))
  const body: CheckpointBody = {
    version: 1,
    runId: input.runId,
    ownerId: input.ownerId,
    attempt: input.attempt,
    actionCallId: input.actionCallId,
    actionName: input.actionName,
    actionInput: input.actionInput,
    actionInputSha256,
    proposalId: input.proposalId,
    approvalId: input.approvalId,
    proposalInputHash: input.proposalInputHash,
    authorityVersion: input.authorityVersion,
    authoritySha256: input.authoritySha256
  }
  const checkpoint: AgentApprovalContinuationCheckpoint = { ...body, checkpointSha256: checkpointHash(body) }
  if (Buffer.byteLength(canonicalJson(checkpoint), 'utf8') > MAX_ACTION_CONTINUATION_BYTES) {
    throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_TOO_LARGE', 'Action continuation exceeds its size limit', 500)
  }
  await knex.transaction(async transaction => {
    const run = await transaction('agentRuns')
      .where({ id: input.runId, ownerId: input.ownerId, attempts: input.attempt, leaseToken: input.leaseToken, status: 'running' })
      .whereNull('cancelRequestedAt')
      .forUpdate()
      .first('runtimeStateCiphertext') as { runtimeStateCiphertext: Uint8Array | null } | undefined
    if (!run) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost before approval suspension', 409)
    await assertContinuationLedger(transaction, checkpoint)
    const state = runtimeState(run.runtimeStateCiphertext)
    const prior = decodeActionContinuation(state)
    if (prior !== null && prior.checkpointSha256 !== checkpoint.checkpointSha256) {
      throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_EXISTS', 'Agent run already has a different action continuation', 409)
    }
    state[ACTION_CONTINUATION_KEY] = checkpoint
    const changed = await transaction('agentRuns')
      .where({ id: input.runId, ownerId: input.ownerId, attempts: input.attempt, leaseToken: input.leaseToken, status: 'running' })
      .whereNull('cancelRequestedAt')
      .update({ runtimeStateCiphertext: encodedRuntimeState(state), status: 'awaiting_approval', updatedAt: transaction.fn.now() })
    if (changed !== 1) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost before approval suspension', 409)
  })
}

export interface AgentRunLeaseIdentity {
  readonly id: string
  readonly ownerId: number
  readonly attempts: number
  readonly leaseOwner: string
  readonly leaseToken: string
}
const invokingAgentRunLeases = new WeakMap<AbortSignal, AgentRunLeaseIdentity>()

export const withInvokingAgentRunLease = async <T>(signal: AbortSignal, claim: AgentRunLeaseIdentity, invoke: () => Promise<T>): Promise<T> => {
  if (invokingAgentRunLeases.has(signal)) throw new AgentRepositoryError('AGENT_ACTION_SESSION_INVALID', 'Agent action signal is already bound to a run lease', 500)
  const identity: AgentRunLeaseIdentity = Object.freeze({
    id: claim.id,
    ownerId: claim.ownerId,
    attempts: claim.attempts,
    leaseOwner: claim.leaseOwner,
    leaseToken: claim.leaseToken
  })
  invokingAgentRunLeases.set(signal, identity)
  try {
    return await invoke()
  } finally {
    invokingAgentRunLeases.delete(signal)
  }
}

export const invokingAgentRunLease = (signal: AbortSignal): AgentRunLeaseIdentity | null => invokingAgentRunLeases.get(signal) ?? null

export const readAgentApprovalContinuation = async (knex: Knex, claim: AgentRunLeaseIdentity): Promise<AgentApprovalContinuationCheckpoint | null> => {
  const row = await knex('agentRuns')
    .where({ id: claim.id, ownerId: claim.ownerId, attempts: claim.attempts, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
    .whereIn('status', ['running', 'awaiting_approval'])
    .whereNull('cancelRequestedAt')
    .first('runtimeStateCiphertext') as { runtimeStateCiphertext: Uint8Array | null } | undefined
  if (!row) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost while loading its action continuation', 409)
  const checkpoint = decodeActionContinuation(runtimeState(row.runtimeStateCiphertext))
  if (checkpoint === null) return null
  if (checkpoint.runId !== claim.id || checkpoint.ownerId !== claim.ownerId || checkpoint.attempt !== claim.attempts) {
    throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_MISMATCH', 'Action continuation does not belong to the claimed run attempt', 409)
  }
  await assertContinuationLedger(knex, checkpoint)
  return checkpoint
}

export interface ClearAgentApprovalContinuationInput {
  readonly runId: string
  readonly ownerId: number
  readonly attempt: number
  readonly leaseOwner: string
  readonly leaseToken: string
}

export const clearAgentApprovalContinuation = async (knex: Knex, input: ClearAgentApprovalContinuationInput): Promise<void> => {
  await knex.transaction(async transaction => {
    const run = await transaction('agentRuns')
      .where({ id: input.runId, ownerId: input.ownerId, attempts: input.attempt, leaseOwner: input.leaseOwner, leaseToken: input.leaseToken })
      .whereIn('status', ['running', 'awaiting_approval'])
      .forUpdate()
      .first('runtimeStateCiphertext') as { runtimeStateCiphertext: Uint8Array | null } | undefined
    if (!run) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost while clearing its action continuation', 409)
    const state = runtimeState(run.runtimeStateCiphertext)
    if (decodeActionContinuation(state) === null) return
    delete state[ACTION_CONTINUATION_KEY]
    const changed = await transaction('agentRuns')
      .where({ id: input.runId, ownerId: input.ownerId, attempts: input.attempt, leaseOwner: input.leaseOwner, leaseToken: input.leaseToken })
      .whereIn('status', ['running', 'awaiting_approval'])
      .update({ runtimeStateCiphertext: Object.keys(state).length === 0 ? null : encodedRuntimeState(state), updatedAt: transaction.fn.now() })
    if (changed !== 1) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost while clearing its action continuation', 409)
  })
}

export interface ClaimAgentRunOptions {
  readonly workerId: string
  readonly globalConcurrency: number
  readonly perUserConcurrency: number
  readonly leaseMilliseconds?: number
  readonly now?: Date
}

const activeLeaseCount = async (transaction: Knex.Transaction, now: Date, ownerId?: number): Promise<number> => {
  const query = transaction('agentRuns').where({ status: 'running' }).where('leaseExpiresAt', '>', now)
  if (ownerId !== undefined) query.andWhere({ ownerId })
  const row = await query.count<{ count: number | string }[]>({ count: '*' }).first()
  return Number(row?.count ?? 0)
}

const recoveryLostSideEffect = async (transaction: Knex.Transaction, row: RunRow, now: Date): Promise<void> => {
  await transaction('agentRuns').where({ id: row.id, status: row.status, leaseToken: row.leaseToken }).update({ status: 'recovery_required', runtimeStateCiphertext: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, completedAt: now, updatedAt: now, errorCode: 'LEASE_LOST_AFTER_SIDE_EFFECT', errorMessage: 'Run lease expired after a side effect may have started' })
}
const hasReclaimableActionContinuation = async (transaction: Knex.Transaction, candidate: RunRow): Promise<boolean> => {
  if (candidate.status !== 'running' || candidate.sideEffectsStarted) return false
  if (candidate.runtimeStateCiphertext === undefined) throw new AgentRepositoryError('AGENT_RUN_CORRUPT', 'Agent run omitted its runtime continuation state', 500)
  const checkpoint = decodeActionContinuation(runtimeState(candidate.runtimeStateCiphertext))
  if (checkpoint === null) return false
  if (checkpoint.runId !== candidate.id || checkpoint.ownerId !== candidate.ownerId || checkpoint.attempt !== candidate.attempts) {
    throw new AgentRepositoryError('AGENT_ACTION_CONTINUATION_MISMATCH', 'Action continuation does not belong to the reclaimable run attempt', 409)
  }
  await assertContinuationLedger(transaction, checkpoint)
  return true
}

export const claimAgentRun = async (knex: Knex, options: ClaimAgentRunOptions): Promise<AgentRunClaim | null> => {
  const globalConcurrency = Math.max(1, Math.floor(options.globalConcurrency))
  const perUserConcurrency = Math.max(1, Math.floor(options.perUserConcurrency))
  const leaseMilliseconds = options.leaseMilliseconds ?? 60_000
  const now = options.now ?? new Date()
  return knex.transaction(async transaction => {
    await advisoryLock(transaction)
    if (await activeLeaseCount(transaction, now) >= globalConcurrency) return null
    const candidates = await transaction<RunRow>('agentRuns')
      .where(query => query.where(subquery => subquery.where({ status: 'queued' }).andWhere('availableAt', '<=', now)).orWhere(subquery => subquery.whereIn('status', ['running', 'awaiting_approval']).andWhere('leaseExpiresAt', '<=', now)))
      .whereNull('cancelRequestedAt')
      .orderBy('availableAt')
      .orderBy('queuedAt')
      .limit(32)
    for (const candidate of candidates) {
      if (candidate.status === 'running' && candidate.sideEffectsStarted) {
        await recoveryLostSideEffect(transaction, candidate, now)
        continue
      }
      const reclaimingContinuation = await hasReclaimableActionContinuation(transaction, candidate)
      if (candidate.status !== 'awaiting_approval' && await activeLeaseCount(transaction, now, candidate.ownerId) >= perUserConcurrency) continue
      if (candidate.attempts >= candidate.maxAttempts && candidate.status !== 'awaiting_approval' && !reclaimingContinuation) {
        await transaction('agentRuns').where({ id: candidate.id, status: candidate.status }).update({ status: 'failed', runtimeStateCiphertext: null, completedAt: now, updatedAt: now, errorCode: 'MAX_ATTEMPTS_EXCEEDED', errorMessage: 'Agent run exhausted its durable attempts' })
        continue
      }
      const leaseToken = randomUUID()
      const leaseExpiresAt = new Date(now.valueOf() + leaseMilliseconds)
      const nextStatus = candidate.status === 'awaiting_approval' ? 'awaiting_approval' : 'running'
      const attempts = candidate.status === 'awaiting_approval' || reclaimingContinuation ? candidate.attempts : candidate.attempts + 1
      const changed = await transaction('agentRuns').where({ id: candidate.id, status: candidate.status, eventSequence: candidate.eventSequence }).modify(query => {
        if (candidate.status !== 'queued') query.andWhere('leaseToken', candidate.leaseToken)
      }).update({ status: nextStatus, attempts, leaseOwner: options.workerId, leaseToken, leaseExpiresAt, startedAt: candidate.status === 'queued' ? now : candidate.startedAt, updatedAt: now })
      if (changed !== 1) continue
      return runRecord({ ...candidate, status: nextStatus, attempts, leaseOwner: options.workerId, leaseToken, leaseExpiresAt }) as AgentRunClaim
    }
    return null
  })
}

export const heartbeatAgentRun = async (knex: Knex, claim: AgentRunClaim, leaseMilliseconds = 60_000, now = new Date()): Promise<boolean> => {
  const leaseExpiresAt = new Date(now.valueOf() + leaseMilliseconds)
  const changed = await knex('agentRuns').where({ id: claim.id, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken }).whereIn('status', ['running', 'awaiting_approval']).whereNull('cancelRequestedAt').update({ leaseExpiresAt, updatedAt: now })
  if (changed === 1) await knex('agentQuotaReservations').where({ runId: claim.id, status: 'reserved' }).update({ heartbeatAt: now, expiresAt: leaseExpiresAt })
  return changed === 1
}

export interface TransitionAgentRunInput {
  readonly claim: AgentRunClaim
  readonly from: 'running' | 'awaiting_approval'
  readonly to: AgentRunStatus
  readonly errorCode?: string | null
  readonly errorMessage?: string | null
  readonly availableAt?: Date
  readonly now?: Date
}

const recordRunCancelled = async (
  transaction: Knex.Transaction,
  run: Pick<RunRow, 'id' | 'assistantMessageId' | 'attempts' | 'eventSequence'>,
  now: Date
): Promise<number> => {
  const sequence = Number(run.eventSequence) + 1
  const data = canonicalJson({ runId: run.id, status: 'cancelled' })
  await transaction('agentEvents').insert({
    id: randomUUID(),
    runId: run.id,
    sequence,
    type: 'run.cancelled',
    attempt: run.attempts,
    schemaVersion: 1,
    dataSha256: sha256(data),
    data,
    createdAt: now
  })
  await transaction('agentMessages')
    .where({ id: run.assistantMessageId, runId: run.id })
    .whereIn('status', ['pending', 'streaming'])
    .update({ status: 'cancelled', updatedAt: now })
  const changed = await transaction('agentRuns')
    .where({ id: run.id, status: 'cancelled', eventSequence: run.eventSequence })
    .update({ eventSequence: sequence, updatedAt: now })
  if (changed !== 1) throw new AgentRepositoryError('RUN_EVENT_FENCE_CHANGED', 'Agent run event fence changed concurrently', 409)
  if (isPostgres(transaction)) await transaction.raw("SELECT pg_notify('wiki_agent_events', ?)", [run.id])
  return sequence
}

export const transitionAgentRun = async (knex: Knex, input: TransitionAgentRunInput): Promise<AgentRunRecord> => knex.transaction(async transaction => {
  const allowed = input.from === 'running'
    ? ['awaiting_approval', 'succeeded', 'partial', 'failed', 'cancelled', 'queued', 'recovery_required']
    : ['running', 'cancelled', 'recovery_required']
  if (!allowed.includes(input.to)) throw new AgentRepositoryError('INVALID_RUN_TRANSITION', 'Agent run transition is invalid', 400)
  const now = input.now ?? new Date()
  const terminal = TERMINAL_STATUSES.includes(input.to)
  const patch: Record<string, unknown> = {
    status: input.to,
    updatedAt: now,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    completedAt: terminal ? now : null
  }
  if (terminal) patch.runtimeStateCiphertext = null
  if (input.to === 'queued') patch.availableAt = input.availableAt ?? now
  if (input.to !== 'running' && input.to !== 'awaiting_approval') {
    patch.leaseOwner = null
    patch.leaseToken = null
    patch.leaseExpiresAt = null
  }
  const changed = await transaction('agentRuns').where({ id: input.claim.id, status: input.from, leaseOwner: input.claim.leaseOwner, leaseToken: input.claim.leaseToken }).update(patch)
  if (changed !== 1) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost', 409)
  const row = await transaction<RunRow>('agentRuns').where({ id: input.claim.id }).first()
  if (!row) throw new AgentRepositoryError('AGENT_RUN_CORRUPT', 'Agent run disappeared after transition', 500)
  if (input.to !== 'cancelled') return runRecord(row)
  const eventSequence = await recordRunCancelled(transaction, row, now)
  return runRecord({ ...row, eventSequence })
})

export const markAgentRunSideEffectsStarted = async (knex: Knex, claim: AgentRunClaim, now = new Date()): Promise<void> => {
  const changed = await knex('agentRuns').where({ id: claim.id, status: 'running', leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken }).whereNull('cancelRequestedAt').update({ sideEffectsStarted: true, updatedAt: now })
  if (changed !== 1) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost before the side effect fence', 409)
}

export const requestAgentRunCancellation = async (knex: Knex, ownerId: number, runId: string, now = new Date()): Promise<AgentRunRecord> => knex.transaction(async transaction => {
  const row = await transaction<RunRow>('agentRuns').where({ id: runId, ownerId }).forUpdate().first()
  if (!row) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent resource was not found', 404)
  if (TERMINAL_STATUSES.includes(runStatus(row.status))) return runRecord(row)
  if (row.status === 'queued') {
    await transaction('agentRuns').where({ id: runId, status: 'queued' }).update({ status: 'cancelled', cancelRequestedAt: now, completedAt: now, updatedAt: now })
    const eventSequence = await recordRunCancelled(transaction, row, now)
    return runRecord({ ...row, status: 'cancelled', cancelRequestedAt: now, completedAt: now, eventSequence })
  }
  await transaction('agentRuns').where({ id: runId }).whereIn('status', ['running', 'awaiting_approval']).update({ cancelRequestedAt: now, updatedAt: now })
  return runRecord({ ...row, cancelRequestedAt: now })
})

export interface AgentRunHandlerResult {
  readonly status: 'succeeded' | 'partial' | 'failed' | 'awaiting_approval' | 'recovery_required'
  readonly errorCode?: string
  readonly errorMessage?: string
}

export type AgentRunHandler = (claim: AgentRunClaim, signal: AbortSignal) => Promise<AgentRunHandlerResult>
interface CurrentClaimState {
  readonly status: 'running' | 'awaiting_approval'
  readonly cancelRequestedAt: Date | string | null
}
const currentClaimState = async (knex: Knex, claim: AgentRunClaim): Promise<CurrentClaimState> => {
  const row = await knex('agentRuns')
    .where({ id: claim.id, ownerId: claim.ownerId, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
    .first('status', 'cancelRequestedAt') as { status: string, cancelRequestedAt: Date | string | null } | undefined
  if (!row || (row.status !== 'running' && row.status !== 'awaiting_approval')) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost', 409)
  return { status: row.status, cancelRequestedAt: row.cancelRequestedAt }
}


export interface AgentRunCoordinatorOptions extends ClaimAgentRunOptions {
  readonly heartbeatMilliseconds?: number
}

export class AgentRunCoordinator {
  readonly #controllers = new Map<string, AbortController>()
  readonly #drains = new Map<string, Promise<void>>()
  readonly #knex: Knex
  readonly #options: AgentRunCoordinatorOptions
  #stopped = false

  constructor (knex: Knex, options: AgentRunCoordinatorOptions) {
    this.#knex = knex
    this.#options = options
  }

  get stopped (): boolean { return this.#stopped }

  async runOnce (handler: AgentRunHandler): Promise<boolean> {
    if (this.#stopped) return false
    const claim = await claimAgentRun(this.#knex, this.#options)
    if (claim === null) return false
    const controller = new AbortController()
    this.#controllers.set(claim.id, controller)
    let markDrained: () => void = () => undefined
    const drained = new Promise<void>(resolve => { markDrained = resolve })
    this.#drains.set(claim.id, drained)
    const heartbeatEvery = this.#options.heartbeatMilliseconds ?? 10_000
    const heartbeat = async (): Promise<void> => {
      if (controller.signal.aborted) return
      try {
        const held = await heartbeatAgentRun(this.#knex, claim, this.#options.leaseMilliseconds)
        if (!held) controller.abort(new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost', 409))
      } catch (error) {
        controller.abort(error)
      }
    }
    const heartbeatTimer = setInterval(() => { void heartbeat() }, heartbeatEvery)
    heartbeatTimer.unref()
    try {
      const result = await handler(claim, controller.signal)
      const current = await currentClaimState(this.#knex, claim)
      if (current.cancelRequestedAt !== null) {
        await transitionAgentRun(this.#knex, { claim, from: current.status, to: 'cancelled' })
      } else if (!controller.signal.aborted && current.status !== result.status) {
        const to = current.status === 'awaiting_approval' && result.status !== 'recovery_required'
          ? 'recovery_required'
          : result.status
        await transitionAgentRun(this.#knex, { claim, from: current.status, to, errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null })
      }
    } catch (error) {
      try {
        const current = await currentClaimState(this.#knex, claim)
        if (current.cancelRequestedAt !== null) {
          await transitionAgentRun(this.#knex, { claim, from: current.status, to: 'cancelled' })
        } else if (!controller.signal.aborted) {
          void error
          await transitionAgentRun(this.#knex, {
            claim,
            from: current.status,
            to: current.status === 'awaiting_approval' ? 'recovery_required' : 'failed',
            errorCode: 'AGENT_RUN_HANDLER_FAILED',
            errorMessage: 'Agent run handler failed'
          })
        }
      } catch (transitionError) {
        if (!(transitionError instanceof AgentRepositoryError && transitionError.code === 'RUN_LEASE_LOST')) throw transitionError
      }
    } finally {
      clearInterval(heartbeatTimer)
      this.#controllers.delete(claim.id)
      markDrained()
      this.#drains.delete(claim.id)
    }
    return true
  }

  async cancel (ownerId: number, runId: string): Promise<AgentRunRecord> {
    const run = await requestAgentRunCancellation(this.#knex, ownerId, runId)
    if (run.cancelRequestedAt !== null && !TERMINAL_STATUSES.includes(run.status)) {
      this.#controllers.get(runId)?.abort(new AgentRepositoryError('RUN_CANCELLED', 'Agent run was cancelled', 409))
    }
    return run
  }

  async shutdown (): Promise<void> {
    this.#stopped = true
    const drains = [...this.#drains.values()]
    for (const controller of this.#controllers.values()) controller.abort(new Error('Agent run coordinator is shutting down'))
    await Promise.allSettled(drains)
    this.#controllers.clear()
  }
}

export const leaseHasExpired = (run: Pick<AgentRunRecord, 'leaseExpiresAt'>, now = new Date()): boolean => {
  const expiry = dateValue(run.leaseExpiresAt)
  return expiry !== null && expiry <= now.valueOf()
}
