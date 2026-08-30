import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { AGENT_TERMINAL_RUN_STATUSES } from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { AgentRepositoryError } from './repository.ts'
import { reconcileAgentRunQuota } from './coordinator.ts'

const TERMINAL_PROPOSAL_STATUSES = ['denied', 'expired', 'applied', 'failed', 'cancelled'] as const
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const PROPOSAL_RECOVERY_MILLISECONDS = 5 * 60_000
const before = (now: Date, days: number): Date => new Date(now.valueOf() - days * 86_400_000)

export interface AgentMaintenancePolicy {
  readonly batchSize: number
  readonly savedSessionDays: number
  readonly mcpContentDays: number
  readonly auditDays: number
  readonly compactDeltaDays: number
}

export const DEFAULT_AGENT_MAINTENANCE_POLICY: AgentMaintenancePolicy = {
  batchSize: 100,
  savedSessionDays: 90,
  mcpContentDays: 7,
  auditDays: 90,
  compactDeltaDays: 1
}

const boundedPolicy = (policy: AgentMaintenancePolicy): AgentMaintenancePolicy => {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new AgentRepositoryError('INVALID_MAINTENANCE_POLICY', `${name} must be a positive safe integer`, 400)
  }
  return { ...policy, batchSize: Math.min(policy.batchSize, 1_000) }
}

export interface AgentMaintenanceResult {
  readonly cancelledRuns: number
  readonly recoveredRuns: number
  readonly requeuedRuns: number
  readonly recoveredProposalExecutions: number
  readonly expiredApprovals: number
  readonly expiredArtifacts: number
  readonly tombstonedSessions: number
  readonly purgedSessions: number
  readonly scrubbedMcpProposals: number
  readonly purgedMcpProposals: number
  readonly scrubbedSkillUses: number
  readonly purgedSkillUses: number
  readonly purgedUsageRows: number
  readonly compactedEvents: number
  readonly reconciledReservations: number
}

const tombstoneOwnedSessions = async (transaction: Knex.Transaction, ownerId: number, sessionIds: readonly string[], now: Date): Promise<number> => {
  if (sessionIds.length === 0) return 0
  await transaction('agentRuns')
    .where({ ownerId, status: 'queued' })
    .whereIn('sessionId', sessionIds)
    .update({ status: 'cancelled', cancelRequestedAt: now, completedAt: now, updatedAt: now, leaseOwner: null, leaseToken: null, leaseExpiresAt: null })
  await transaction('agentRuns')
    .where({ ownerId })
    .whereIn('sessionId', sessionIds)
    .whereIn('status', ['running', 'awaiting_approval'])
    .update({ cancelRequestedAt: now, updatedAt: now })
  const proposalIds = await transaction('agentProposals').whereIn('sessionId', sessionIds).whereIn('status', ['pending', 'approved']).pluck<string>('id')
  if (proposalIds.length > 0) {
    await transaction('agentProposals').whereIn('id', proposalIds).update({ status: 'cancelled' })
    await transaction('agentApprovals').whereIn('proposalId', proposalIds).where({ status: 'pending' }).update({ status: 'cancelled', decidedAt: now })
  }
  const changed = await transaction('agentSessions')
    .where({ ownerId })
    .whereIn('id', sessionIds)
    .whereNull('deletedAt')
    .update({ deletedAt: now, updatedAt: now, version: transaction.raw('?? + 1', ['version']) })
  return changed
}

export const requestAgentSessionDeletion = async (knex: Knex, ownerId: number, sessionId: string, now = new Date()): Promise<void> => {
  await knex.transaction(async transaction => {
    const session = (await transaction('agentSessions').where({ id: sessionId, ownerId }).forUpdate().first('id', 'deletedAt')) as
      | { id: string; deletedAt: Date | string | null }
      | undefined
    if (!session) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent resource was not found', 404)
    if (session.deletedAt !== null) return
    const changed = await tombstoneOwnedSessions(transaction, ownerId, [sessionId], now)
    if (changed !== 1) throw new AgentRepositoryError('SESSION_VERSION_CHANGED', 'Agent session changed concurrently', 409)
  })
}

export const requestAgentHistoryReset = async (knex: Knex, ownerId: number, now = new Date()): Promise<number> =>
  knex.transaction(async transaction => {
    const sessionIds = await transaction('agentSessions').where({ ownerId }).whereNull('deletedAt').orderBy('id').forUpdate().pluck<string>('id')
    return tombstoneOwnedSessions(transaction, ownerId, sessionIds, now)
  })

const recoverRuns = async (knex: Knex, now: Date, batchSize: number): Promise<{ cancelled: number; recovered: number; requeued: number }> =>
  knex.transaction(async transaction => {
    const rows = (await transaction('agentRuns')
      .where(query =>
        query
          .whereNotNull('cancelRequestedAt')
          .whereIn('status', ['queued', 'running', 'awaiting_approval'])
          .orWhere(subquery => subquery.whereIn('status', ['running', 'awaiting_approval']).andWhere('leaseExpiresAt', '<=', now))
      )
      .orderBy('updatedAt')
      .limit(batchSize)
      .forUpdate()) as Array<{ id: string; status: string; sideEffectsStarted: boolean; cancelRequestedAt: Date | string | null }>
    let cancelled = 0
    let recovered = 0
    let requeued = 0
    for (const row of rows) {
      if (row.cancelRequestedAt !== null) {
        cancelled += await transaction('agentRuns')
          .where({ id: row.id, status: row.status })
          .update({ status: 'cancelled', completedAt: now, updatedAt: now, leaseOwner: null, leaseToken: null, leaseExpiresAt: null })
      } else if (row.status === 'running' && row.sideEffectsStarted) {
        recovered += await transaction('agentRuns').where({ id: row.id, status: 'running' }).update({
          status: 'recovery_required',
          completedAt: now,
          updatedAt: now,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          errorCode: 'LEASE_LOST_AFTER_SIDE_EFFECT',
          errorMessage: 'Run lease expired after a side effect may have started'
        })
      } else if (row.status === 'running') {
        requeued += await transaction('agentRuns')
          .where({ id: row.id, status: 'running' })
          .update({ status: 'queued', availableAt: now, updatedAt: now, leaseOwner: null, leaseToken: null, leaseExpiresAt: null })
      } else {
        await transaction('agentRuns')
          .where({ id: row.id, status: 'awaiting_approval' })
          .update({ leaseOwner: null, leaseToken: null, leaseExpiresAt: now, updatedAt: now })
      }
    }
    return { cancelled, recovered, requeued }
  })

const recoverProposalExecutions = async (knex: Knex, now: Date, batchSize: number): Promise<number> =>
  knex.transaction(async transaction => {
    const rows = await transaction('agentActionExecutions')
      .where({ status: 'applying' })
      .andWhere('startedAt', '<=', new Date(now.valueOf() - PROPOSAL_RECOVERY_MILLISECONDS))
      .orderBy('startedAt')
      .limit(batchSize)
      .forUpdate()
      .select<{ id: string; proposalId: string }[]>('id', 'proposalId')
    let recovered = 0
    for (const row of rows) {
      const executionChanged = await transaction('agentActionExecutions').where({ id: row.id, status: 'applying' }).update({ status: 'recovery_required' })
      if (executionChanged !== 1) continue
      const proposalChanged = await transaction('agentProposals').where({ id: row.proposalId, status: 'applying' }).update({ status: 'recovery_required' })
      if (proposalChanged !== 1)
        throw new AgentRepositoryError('PROPOSAL_RECOVERY_CORRUPT', 'Applying proposal execution has no matching applying proposal', 500)
      recovered += 1
    }
    return recovered
  })

const expireApprovals = async (knex: Knex, now: Date, batchSize: number): Promise<number> =>
  knex.transaction(async transaction => {
    const proposalIds = await transaction('agentProposals')
      .whereIn('status', ['pending', 'approved'])
      .andWhere('expiresAt', '<=', now)
      .orderBy('expiresAt')
      .limit(batchSize)
      .forUpdate()
      .pluck<string>('id')
    if (proposalIds.length === 0) return 0
    await transaction('agentProposals').whereIn('id', proposalIds).whereIn('status', ['pending', 'approved']).update({ status: 'expired' })
    await transaction('agentApprovals').whereIn('proposalId', proposalIds).where({ status: 'pending' }).update({ status: 'expired', decidedAt: now })
    return proposalIds.length
  })

const tombstoneExpiredSessions = async (knex: Knex, now: Date, savedCutoff: Date, batchSize: number): Promise<number> => {
  const ids = await knex('agentSessions')
    .whereNull('deletedAt')
    .whereNull('folderId')
    .where(expired => {
      expired
        .where(temporary => temporary.where({ retention: 'temporary' }).andWhere('expiresAt', '<=', now))
        .orWhere(saved => saved.where({ retention: 'saved' }).andWhere('lastActivityAt', '<=', savedCutoff))
    })
    .whereNotExists(function activeRun() {
      this.select(knex.raw('1'))
        .from('agentRuns')
        .where('agentRuns.sessionId', knex.ref('agentSessions.id'))
        .whereIn('agentRuns.status', ['queued', 'running', 'awaiting_approval'])
    })
    .orderBy('lastActivityAt')
    .limit(batchSize)
    .pluck<string>('id')
  if (ids.length === 0) return 0
  return knex('agentSessions')
    .whereIn('id', ids)
    .whereNull('deletedAt')
    .whereNotExists(function activeRun() {
      this.select(knex.raw('1'))
        .from('agentRuns')
        .where('agentRuns.sessionId', knex.ref('agentSessions.id'))
        .whereIn('agentRuns.status', ['queued', 'running', 'awaiting_approval'])
    })
    .update({ deletedAt: now, updatedAt: now })
}

const purgeTombstonedSessions = async (knex: Knex, batchSize: number): Promise<number> => {
  const ids = await knex('agentSessions')
    .whereNotNull('deletedAt')
    .whereNotExists(function activeRun() {
      this.select(knex.raw('1'))
        .from('agentRuns')
        .where('agentRuns.sessionId', knex.ref('agentSessions.id'))
        .whereIn('agentRuns.status', ['queued', 'running', 'awaiting_approval'])
    })
    .orderBy('deletedAt')
    .limit(batchSize)
    .pluck<string>('id')
  if (ids.length === 0) return 0
  return knex('agentSessions')
    .whereIn('id', ids)
    .whereNotExists(function activeRun() {
      this.select(knex.raw('1'))
        .from('agentRuns')
        .where('agentRuns.sessionId', knex.ref('agentSessions.id'))
        .whereIn('agentRuns.status', ['queued', 'running', 'awaiting_approval'])
    })
    .delete()
}

const scrubMcpProposals = async (knex: Knex, cutoff: Date, now: Date, batchSize: number): Promise<number> =>
  knex.transaction(async transaction => {
    const ids = await transaction('agentProposals')
      .where({ sourceKind: 'mcp' })
      .whereIn('status', TERMINAL_PROPOSAL_STATUSES)
      .whereNull('contentPurgedAt')
      .andWhere('createdAt', '<=', cutoff)
      .orderBy('createdAt')
      .limit(batchSize)
      .forUpdate()
      .pluck<string>('id')
    if (ids.length === 0) return 0
    await transaction('agentProposals').whereIn('id', ids).update({ input: null, patch: null, diff: null, applyResult: null, contentPurgedAt: now })
    await transaction('agentApprovals').whereIn('proposalId', ids).update({ decisionNote: null })
    await transaction('agentActionExecutions').whereIn('proposalId', ids).update({ result: null, error: null })
    return ids.length
  })

const purgeMcpProposals = async (knex: Knex, cutoff: Date, batchSize: number): Promise<number> => {
  const ids = await knex('agentProposals')
    .where({ sourceKind: 'mcp' })
    .whereIn('status', TERMINAL_PROPOSAL_STATUSES)
    .andWhere('createdAt', '<=', cutoff)
    .orderBy('createdAt')
    .limit(batchSize)
    .pluck<string>('id')
  if (ids.length === 0) return 0
  return knex('agentProposals').whereIn('id', ids).delete()
}

const scrubSkillUses = async (knex: Knex, cutoff: Date, batchSize: number): Promise<number> => {
  const ids = await knex('agentSkillUses')
    .whereNull('sessionId')
    .whereNull('runId')
    .whereNotNull('requesterApiKeyId')
    .whereNotNull('resourcePath')
    .andWhere('createdAt', '<=', cutoff)
    .orderBy('createdAt')
    .limit(batchSize)
    .pluck<string>('id')
  if (ids.length === 0) return 0
  return knex('agentSkillUses').whereIn('id', ids).update({ resourcePath: null, externalSessionSha256: null })
}

const purgeSkillUses = async (knex: Knex, cutoff: Date, batchSize: number): Promise<number> => {
  const ids = await knex('agentSkillUses')
    .whereNull('sessionId')
    .whereNull('runId')
    .whereNotNull('requesterApiKeyId')
    .andWhere('createdAt', '<=', cutoff)
    .orderBy('createdAt')
    .limit(batchSize)
    .pluck<string>('id')
  if (ids.length === 0) return 0
  return knex('agentSkillUses').whereIn('id', ids).delete()
}

const compactEvents = async (knex: Knex, cutoff: Date, batchSize: number): Promise<number> => {
  const rows = await knex('agentEvents')
    .join('agentRuns', 'agentRuns.id', 'agentEvents.runId')
    .where('agentEvents.type', 'message.delta')
    .whereIn('agentRuns.status', AGENT_TERMINAL_RUN_STATUSES)
    .andWhere('agentEvents.createdAt', '<=', cutoff)
    .andWhereNot('agentEvents.data', canonicalJson({ compacted: true }))
    .orderBy('agentEvents.createdAt')
    .limit(batchSize)
    .select<{ id: string }[]>('agentEvents.id')
  const ids = rows.map(row => row.id)
  if (ids.length === 0) return 0
  const data = canonicalJson({ compacted: true })
  return knex('agentEvents')
    .whereIn('id', ids)
    .update({ data, dataSha256: sha256(data) })
}

const reconcileExpiredReservations = async (knex: Knex, now: Date, batchSize: number): Promise<number> => {
  const rows = await knex('agentQuotaReservations')
    .where({ status: 'reserved' })
    .andWhere('expiresAt', '<=', now)
    .orderBy('expiresAt')
    .limit(batchSize)
    .select<{ runId: string; ownerId: number }[]>('runId', 'ownerId')
  let reconciled = 0
  for (const row of rows) {
    await reconcileAgentRunQuota(knex, { runId: row.runId, ownerId: row.ownerId, consumedTokens: 0, consumedCostMicros: 0, status: 'released', now })
    reconciled += 1
  }
  return reconciled
}
const deleteExpiredRows = async (knex: Knex, table: string, column: string, cutoff: Date, batchSize: number): Promise<number> => {
  const ids = await knex(table).where(column, '<=', cutoff).orderBy(column).limit(batchSize).pluck<string>('id')
  if (ids.length === 0) return 0
  return knex(table).whereIn('id', ids).delete()
}

const expireArtifactPayloads = async (knex: Knex, now: Date, batchSize: number): Promise<number> => {
  const ids = await knex('agentArtifacts').whereNotNull('payload').andWhere('expiresAt', '<=', now).orderBy('expiresAt').limit(batchSize).pluck<string>('id')
  if (ids.length === 0) return 0
  return knex('agentArtifacts').whereIn('id', ids).update({ payload: null, metadata: null })
}

export const runAgentMaintenance = async (
  knex: Knex,
  inputPolicy: AgentMaintenancePolicy = DEFAULT_AGENT_MAINTENANCE_POLICY,
  now = new Date()
): Promise<AgentMaintenanceResult> => {
  const policy = boundedPolicy(inputPolicy)
  const recovered = await recoverRuns(knex, now, policy.batchSize)
  const recoveredProposalExecutions = await recoverProposalExecutions(knex, now, policy.batchSize)
  const expiredApprovals = await expireApprovals(knex, now, policy.batchSize)
  const expiredArtifacts = await expireArtifactPayloads(knex, now, policy.batchSize)
  const tombstonedSessions = await tombstoneExpiredSessions(knex, now, before(now, policy.savedSessionDays), policy.batchSize)
  const scrubbedMcpProposals = await scrubMcpProposals(knex, before(now, policy.mcpContentDays), now, policy.batchSize)
  const scrubbedSkillUses = await scrubSkillUses(knex, before(now, policy.mcpContentDays), policy.batchSize)
  const compactedEvents = await compactEvents(knex, before(now, policy.compactDeltaDays), policy.batchSize)
  const reconciledReservations = await reconcileExpiredReservations(knex, now, policy.batchSize)
  const purgedMcpProposals = await purgeMcpProposals(knex, before(now, policy.auditDays), policy.batchSize)
  const purgedSkillUses = await purgeSkillUses(knex, before(now, policy.auditDays), policy.batchSize)
  const purgedUsageRows = await deleteExpiredRows(knex, 'agentUsageLedger', 'createdAt', before(now, policy.auditDays), policy.batchSize)
  const purgedSessions = await purgeTombstonedSessions(knex, policy.batchSize)
  return {
    cancelledRuns: recovered.cancelled,
    recoveredProposalExecutions,
    recoveredRuns: recovered.recovered,
    requeuedRuns: recovered.requeued,
    expiredApprovals,
    expiredArtifacts,
    tombstonedSessions,
    purgedSessions,
    scrubbedMcpProposals,
    purgedMcpProposals,
    scrubbedSkillUses,
    purgedSkillUses,
    purgedUsageRows,
    compactedEvents,
    reconciledReservations
  }
}
