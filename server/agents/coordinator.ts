import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { AgentEventData, AgentExecutionMode, AgentRunStatus } from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { AgentRepositoryError } from './repository.ts'

const ACTIVE_STATUSES: readonly AgentRunStatus[] = ['queued', 'running', 'awaiting_approval']
const TERMINAL_STATUSES: readonly AgentRunStatus[] = ['succeeded', 'failed', 'cancelled', 'recovery_required']
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const dateValue = (value: Date | string | null): number | null => value === null ? null : new Date(value).valueOf()
const isPostgres = (knex: Knex | Knex.Transaction): boolean => knex.client.config.client === 'pg' || knex.client.config.client === 'postgresql'

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

const queuedEventData = (runId: string): { data: string, dataSha256: string } => {
  const value: AgentEventData = { runId, status: 'queued' }
  const data = canonicalJson(value)
  return { data, dataSha256: sha256(data) }
}

export const admitAgentRun = async (knex: Knex, input: AdmitAgentRunInput): Promise<{ readonly run: AgentRunRecord, readonly replayed: boolean }> => {
  if (!/^[a-f0-9]{64}$/.test(input.profileResolutionSha256)) throw new AgentRepositoryError('INVALID_PROFILE_RESOLUTION', 'Profile resolution hash is invalid', 400)
  if (input.content.length < 1 || input.content.length > 32_000) throw new AgentRepositoryError('INVALID_AGENT_MESSAGE', 'Agent message content is invalid', 400)
  const inputHash = sha256(admissionEnvelope(input))
  const now = input.now ?? new Date()
  return knex.transaction(async transaction => {
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
      { id: userMessageId, sessionId: input.sessionId, runId: null, ordinal, role: 'user', status: 'complete', content: input.content, citations: null, createdAt: now, updatedAt: now },
      { id: assistantMessageId, sessionId: input.sessionId, runId: null, ordinal: ordinal + 1, role: 'assistant', status: 'pending', content: '', citations: null, createdAt: now, updatedAt: now }
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
    const event = queuedEventData(runId)
    await transaction('agentEvents').insert({ id: input.queuedEventId ?? randomUUID(), runId, sequence: 1, type: 'run.queued', attempt: 0, schemaVersion: 1, dataSha256: event.dataSha256, data: event.data, createdAt: now })
    if (transaction.client.config.client === 'pg' || transaction.client.config.client === 'postgresql') {
      await transaction.raw("SELECT pg_notify('wiki_agent_events', ?)", [runId])
    }
    await transaction('agentSessions').where({ id: input.sessionId }).update({ lastActivityAt: now, updatedAt: now })
    return { run: runRecord(row), replayed: false }
  })
}

export interface AgentRunClaim extends AgentRunRecord {
  readonly leaseOwner: string
  readonly leaseToken: string
  readonly leaseExpiresAt: string
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
  await transaction('agentRuns').where({ id: row.id, status: row.status, leaseToken: row.leaseToken }).update({ status: 'recovery_required', leaseOwner: null, leaseToken: null, leaseExpiresAt: null, completedAt: now, updatedAt: now, errorCode: 'LEASE_LOST_AFTER_SIDE_EFFECT', errorMessage: 'Run lease expired after a side effect may have started' })
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
      if (candidate.status !== 'awaiting_approval' && await activeLeaseCount(transaction, now, candidate.ownerId) >= perUserConcurrency) continue
      if (candidate.attempts >= candidate.maxAttempts && candidate.status !== 'awaiting_approval') {
        await transaction('agentRuns').where({ id: candidate.id, status: candidate.status }).update({ status: 'failed', completedAt: now, updatedAt: now, errorCode: 'MAX_ATTEMPTS_EXCEEDED', errorMessage: 'Agent run exhausted its durable attempts' })
        continue
      }
      const leaseToken = randomUUID()
      const leaseExpiresAt = new Date(now.valueOf() + leaseMilliseconds)
      const nextStatus = candidate.status === 'awaiting_approval' ? 'awaiting_approval' : 'running'
      const attempts = candidate.status === 'awaiting_approval' ? candidate.attempts : candidate.attempts + 1
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

export const transitionAgentRun = async (knex: Knex, input: TransitionAgentRunInput): Promise<AgentRunRecord> => {
  const allowed = input.from === 'running'
    ? ['awaiting_approval', 'succeeded', 'failed', 'cancelled', 'queued', 'recovery_required']
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
  if (input.to === 'queued') patch.availableAt = input.availableAt ?? now
  if (input.to !== 'running' && input.to !== 'awaiting_approval') {
    patch.leaseOwner = null
    patch.leaseToken = null
    patch.leaseExpiresAt = null
  }
  const changed = await knex('agentRuns').where({ id: input.claim.id, status: input.from, leaseOwner: input.claim.leaseOwner, leaseToken: input.claim.leaseToken }).update(patch)
  if (changed !== 1) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost', 409)
  const row = await knex<RunRow>('agentRuns').where({ id: input.claim.id }).first()
  if (!row) throw new AgentRepositoryError('AGENT_RUN_CORRUPT', 'Agent run disappeared after transition', 500)
  return runRecord(row)
}

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
    return runRecord({ ...row, status: 'cancelled', cancelRequestedAt: now })
  }
  await transaction('agentRuns').where({ id: runId }).whereIn('status', ['running', 'awaiting_approval']).update({ cancelRequestedAt: now, updatedAt: now })
  return runRecord({ ...row, cancelRequestedAt: now })
})

export interface AgentRunHandlerResult {
  readonly status: 'succeeded' | 'failed' | 'awaiting_approval' | 'recovery_required'
  readonly errorCode?: string
  readonly errorMessage?: string
}

export type AgentRunHandler = (claim: AgentRunClaim, signal: AbortSignal) => Promise<AgentRunHandlerResult>

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
      if (controller.signal.aborted) return true
      await transitionAgentRun(this.#knex, { claim, from: claim.status === 'awaiting_approval' ? 'awaiting_approval' : 'running', to: result.status, errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null })
    } catch (error) {
      if (!controller.signal.aborted) {
        void error
        try {
          await transitionAgentRun(this.#knex, { claim, from: claim.status === 'awaiting_approval' ? 'awaiting_approval' : 'running', to: 'failed', errorCode: 'AGENT_RUN_HANDLER_FAILED', errorMessage: 'Agent run handler failed' })
        } catch (transitionError) {
          if (!(transitionError instanceof AgentRepositoryError && transitionError.code === 'RUN_LEASE_LOST')) throw transitionError
        }
      }
    } finally {
      clearInterval(heartbeatTimer)
      this.#controllers.delete(claim.id)
      markDrained()
      this.#drains.delete(claim.id)
    }
    return true
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
