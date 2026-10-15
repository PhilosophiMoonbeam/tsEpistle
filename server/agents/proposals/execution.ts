import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

import { canonicalJson } from '../../helpers/canonical-json.ts'
import type { ActionAuthority } from '../actions/kernel.ts'
import { AgentProposalError, type ApprovalRecord, type ApprovalStatus, type ProposalRecord, type ProposalStatus } from './repository.ts'

interface ExecutionRow {
  readonly id: string
  readonly proposalId: string
  readonly runId: string | null
  readonly actionName: string
  readonly requesterUserId: number | null
  readonly requesterApiKeyId: number | null
  readonly approvedByUserId: number
  readonly idempotencyKey: string
  readonly leaseToken: string | null
  readonly status: string
  readonly inputHash: string
  readonly startedAt: Date | string
  readonly completedAt: Date | string | null
  readonly result: string | null
  readonly error: string | null
}

export interface LockedProposalContext {
  readonly transaction: Knex.Transaction
  readonly proposal: ProposalRecord
  readonly approval: ApprovalRecord
  readonly input: unknown
}
export interface ProposalExecutionContext {
  readonly proposal: ProposalRecord
  readonly approval: ApprovalRecord
  readonly input: unknown
}

export interface DecideProposalInput {
  readonly proposalId: string
  readonly approvalId: string
  readonly userId: number
  readonly decision: 'approved' | 'denied'
  readonly decisionNote?: string
  readonly authorize: (context: LockedProposalContext & { readonly userId: number }) => Promise<void>
}

export interface ApplyProposalInput {
  readonly proposalId: string
  readonly approvalId: string
  readonly authority: ActionAuthority
  readonly signal: AbortSignal
  readonly leaseToken?: string
  readonly reauthorize: (context: LockedProposalContext & { readonly approverUserId: number; readonly authority: ActionAuthority }) => Promise<void>
  readonly mutate: (context: ProposalExecutionContext) => Promise<unknown>
  readonly reconcile: (context: ProposalExecutionContext) => Promise<unknown | null>
}

export interface AppliedProposalResult {
  readonly proposalId: string
  readonly status: 'applied'
  readonly result: unknown
  readonly resultHash: string
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const dateValue = (value: Date | string): number => (value instanceof Date ? value.valueOf() : Date.parse(value))

const parseInput = (proposal: ProposalRecord): unknown => {
  if (proposal.contentPurgedAt !== null || proposal.input === null)
    throw new AgentProposalError('PROPOSAL_CONTENT_UNAVAILABLE', 'Proposal content is no longer available', 409)
  try {
    return JSON.parse(proposal.input)
  } catch {
    throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal input is invalid', 500)
  }
}

const lockProposal = async (transaction: Knex.Transaction, proposalId: string, approvalId: string): Promise<LockedProposalContext> => {
  const proposal = await transaction<ProposalRecord>('agentProposals').where({ id: proposalId }).forUpdate().first()
  const approval = await transaction<ApprovalRecord>('agentApprovals').where({ id: approvalId, proposalId }).forUpdate().first()
  if (!proposal || !approval) throw new AgentProposalError('PROPOSAL_NOT_FOUND', 'Proposal does not exist', 404)
  if (
    approval.inputHash !== proposal.inputHash ||
    approval.authorityVersion !== proposal.authorityVersion ||
    approval.authoritySha256 !== proposal.authoritySha256 ||
    approval.patchSha256 !== (proposal.patchSha256 ?? null) ||
    approval.resultCanonicalSha256 !== (proposal.resultCanonicalSha256 ?? null) ||
    approval.operationSha256 !== proposal.operationSha256 ||
    sha256(proposal.operation) !== proposal.operationSha256 ||
    approval.diffSha256 !== (proposal.diffSha256 ?? null)
  )
    throw new AgentProposalError('PROPOSAL_LEDGER_TAMPERED', 'Proposal approval does not match its immutable payload', 409)
  return { transaction, proposal, approval, input: parseInput(proposal) }
}

const updateStatuses = async (
  transaction: Knex.Transaction,
  proposalId: string,
  approvalId: string,
  fromProposal: ProposalStatus,
  fromApproval: ApprovalStatus,
  proposalPatch: Record<string, unknown>,
  approvalPatch: Record<string, unknown>
): Promise<void> => {
  const approvalUpdated = await transaction('agentApprovals').where({ id: approvalId, proposalId, status: fromApproval }).update(approvalPatch)
  const proposalUpdated = await transaction('agentProposals').where({ id: proposalId, status: fromProposal }).update(proposalPatch)
  if (approvalUpdated !== 1 || proposalUpdated !== 1) throw new AgentProposalError('PROPOSAL_STATE_CHANGED', 'Proposal state changed concurrently', 409)
}

export const decideProposal = async (knex: Knex, input: DecideProposalInput): Promise<{ proposal: ProposalRecord; approval: ApprovalRecord }> => {
  const result = await knex.transaction(async transaction => {
    const context = await lockProposal(transaction, input.proposalId, input.approvalId)
    if (context.proposal.status !== 'pending' || context.approval.status !== 'pending') {
      throw new AgentProposalError('PROPOSAL_NOT_PENDING', 'Proposal is no longer awaiting a decision', 409)
    }
    const now = new Date()
    if (dateValue(context.proposal.expiresAt) <= now.valueOf() || dateValue(context.approval.expiresAt) <= now.valueOf()) {
      await updateStatuses(
        transaction,
        input.proposalId,
        input.approvalId,
        'pending',
        'pending',
        { status: 'expired' },
        { status: 'expired', decidedAt: now.toISOString() }
      )
      return { expired: true as const }
    }
    if (context.proposal.sourceKind === 'agent' && context.proposal.requesterUserId !== input.userId) {
      throw new AgentProposalError('APPROVAL_FORBIDDEN', 'Only the owning interactive user can decide this proposal', 403)
    }
    if (input.decisionNote !== undefined && input.decisionNote.length > 4_000)
      throw new AgentProposalError('INVALID_DECISION_NOTE', 'Decision note is too long', 400)
    await input.authorize({ ...context, userId: input.userId })
    await updateStatuses(
      transaction,
      input.proposalId,
      input.approvalId,
      'pending',
      'pending',
      { status: input.decision },
      {
        status: input.decision,
        decidedAt: now.toISOString(),
        approvedByUserId: input.decision === 'approved' ? input.userId : null,
        decisionNote: input.decisionNote ?? null
      }
    )
    const proposal = await transaction<ProposalRecord>('agentProposals').where({ id: input.proposalId }).first()
    const approval = await transaction<ApprovalRecord>('agentApprovals').where({ id: input.approvalId }).first()
    if (!proposal || !approval) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal decision disappeared', 500)
    return { expired: false as const, proposal, approval }
  })
  if (result.expired) throw new AgentProposalError('PROPOSAL_EXPIRED', 'Proposal has expired', 409)
  return { proposal: result.proposal, approval: result.approval }
}

const assertApplyingAuthority = (proposal: ProposalRecord, authority: ActionAuthority): void => {
  if (authority.actionName !== 'pages.applyProposal')
    throw new AgentProposalError('INVALID_APPLY_AUTHORITY', 'Apply requires pages.applyProposal authority', 400)
  if (proposal.sourceKind !== authority.transport)
    throw new AgentProposalError('INVALID_APPLY_AUTHORITY', 'Proposal transport does not match apply authority', 403)
  if (authority.requester.kind === 'user') {
    if (proposal.requesterUserId !== authority.requester.userId || proposal.requesterApiKeyId !== null) {
      throw new AgentProposalError('INVALID_APPLY_AUTHORITY', 'Proposal requester does not match apply authority', 403)
    }
  } else if (proposal.requesterApiKeyId !== authority.requester.apiKeyId || proposal.requesterUserId !== null) {
    throw new AgentProposalError('INVALID_APPLY_AUTHORITY', 'Proposal requester does not match apply authority', 403)
  }
}

const completedResult = (execution: ExecutionRow): AppliedProposalResult | null => {
  if (execution.status !== 'committed' || execution.result === null) return null
  let result: unknown
  try {
    result = JSON.parse(execution.result)
  } catch {
    throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Committed execution result is invalid', 500)
  }
  return { proposalId: execution.proposalId, status: 'applied', result, resultHash: sha256(execution.result) }
}

export const readCommittedProposalResult = async (knex: Knex, proposal: ProposalRecord): Promise<{ readonly pageId: number | null } | null> =>
  knex.transaction(async transaction => {
    const stored = await transaction<ProposalRecord>('agentProposals').where({ id: proposal.id }).forUpdate().first()
    const approval = await transaction<ApprovalRecord>('agentApprovals').where({ proposalId: proposal.id }).forUpdate().first()
    if (
      !stored ||
      !approval ||
      approval.inputHash !== stored.inputHash ||
      approval.authorityVersion !== stored.authorityVersion ||
      approval.authoritySha256 !== stored.authoritySha256 ||
      approval.patchSha256 !== (stored.patchSha256 ?? null) ||
      approval.resultCanonicalSha256 !== (stored.resultCanonicalSha256 ?? null) ||
      approval.operationSha256 !== stored.operationSha256 ||
      sha256(stored.operation) !== stored.operationSha256 ||
      approval.diffSha256 !== (stored.diffSha256 ?? null)
    ) {
      throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal approval does not match its immutable payload', 500)
    }
    if (stored.inputHash !== proposal.inputHash || stored.operationSha256 !== proposal.operationSha256) {
      throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal changed while its result was read', 500)
    }
    if (stored.status !== 'applied') return null
    const execution = await transaction<ExecutionRow>('agentActionExecutions').where({ proposalId: stored.id }).first()
    const expectedKey = sha256(
      canonicalJson({
        version: 1,
        proposalId: stored.id,
        authoritySha256: stored.authoritySha256,
        inputHash: stored.inputHash
      })
    )
    if (
      !execution ||
      execution.status !== 'committed' ||
      execution.result === null ||
      execution.inputHash !== stored.inputHash ||
      execution.runId !== stored.runId ||
      execution.actionName !== stored.actionName ||
      execution.requesterUserId !== stored.requesterUserId ||
      execution.requesterApiKeyId !== stored.requesterApiKeyId ||
      execution.idempotencyKey !== expectedKey ||
      approval.status !== 'approved' ||
      approval.approvedByUserId === null ||
      execution.approvedByUserId !== approval.approvedByUserId ||
      stored.applyResult !== execution.result ||
      execution.completedAt === null ||
      (stored.resultCanonicalSha256 !== null && sha256(execution.result) !== stored.resultCanonicalSha256)
    ) {
      throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Committed proposal result does not match its approved execution', 500)
    }
    const completed = completedResult(execution)!
    if (
      canonicalJson(completed.result) !== execution.result ||
      typeof completed.result !== 'object' ||
      completed.result === null ||
      Array.isArray(completed.result)
    ) {
      throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Committed proposal result is not a canonical identity', 500)
    }
    const pageId = Reflect.get(completed.result, 'pageId')
    if (pageId !== undefined && (!Number.isSafeInteger(pageId) || pageId <= 0)) {
      throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Committed proposal page identity is invalid', 500)
    }
    let operation: unknown
    try {
      operation = JSON.parse(stored.operation)
    } catch {
      throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal operation is invalid', 500)
    }
    const approvedIdentity = typeof operation === 'object' && operation !== null ? Reflect.get(operation, 'resultIdentity') : undefined
    const operationKind = typeof operation === 'object' && operation !== null ? Reflect.get(operation, 'kind') : undefined
    if (
      typeof approvedIdentity !== 'object' ||
      approvedIdentity === null ||
      Array.isArray(approvedIdentity) ||
      (canonicalJson(completed.result) !== canonicalJson(approvedIdentity) &&
        !(
          stored.actionName === 'pages.prepareCreate' &&
          operationKind === 'create' &&
          stored.resultCanonicalSha256 === null &&
          pageId !== undefined &&
          canonicalJson(completed.result) === canonicalJson({ ...approvedIdentity, pageId })
        ))
    ) {
      throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Committed result does not match the approved operation identity', 500)
    }
    return { pageId: pageId ?? null }
  })

export const applyApprovedProposal = async (knex: Knex, input: ApplyProposalInput): Promise<AppliedProposalResult> => {
  if (input.signal.aborted) throw new AgentProposalError('ACTION_CANCELLED', 'Proposal apply was cancelled', 409)

  const commitResult = async (executionId: string, rawResult: unknown): Promise<AppliedProposalResult> =>
    knex.transaction(async transaction => {
      const execution = await transaction<ExecutionRow>('agentActionExecutions').where({ id: executionId, proposalId: input.proposalId }).forUpdate().first()
      if (!execution) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal execution claim disappeared', 500)
      const completed = completedResult(execution)
      if (completed) return completed
      if (execution.status !== 'applying' && execution.status !== 'recovery_required') {
        throw new AgentProposalError('PROPOSAL_EXECUTION_TERMINAL', 'Proposal execution is already terminal', 409)
      }
      const proposal = await transaction<ProposalRecord>('agentProposals').where({ id: input.proposalId }).forUpdate().first()
      if (!proposal || (proposal.status !== 'applying' && proposal.status !== 'recovery_required')) {
        throw new AgentProposalError('PROPOSAL_STATE_CHANGED', 'Proposal completion lost its execution fence', 409)
      }
      const result = canonicalJson(rawResult)
      const resultHash = sha256(result)
      if (proposal.resultCanonicalSha256 !== null && resultHash !== proposal.resultCanonicalSha256) {
        throw new AgentProposalError('PROPOSAL_RESULT_MISMATCH', 'Mutation result does not match the approved immutable proposal', 409)
      }
      const completedAt = new Date().toISOString()
      const executionUpdated = await transaction('agentActionExecutions')
        .where({ id: execution.id, inputHash: proposal.inputHash })
        .whereIn('status', ['applying', 'recovery_required'])
        .update({ status: 'committed', completedAt, result, error: null })
      const proposalUpdated = await transaction('agentProposals')
        .where({ id: proposal.id, inputHash: proposal.inputHash })
        .whereIn('status', ['applying', 'recovery_required'])
        .update({ status: 'applied', appliedAt: completedAt, applyResult: result })
      if (executionUpdated !== 1 || proposalUpdated !== 1)
        throw new AgentProposalError('PROPOSAL_STATE_CHANGED', 'Proposal completion lost its execution fence', 409)
      return { proposalId: proposal.id, status: 'applied', result: rawResult, resultHash }
    })

  const loadRecoveryContext = async (execution: ExecutionRow): Promise<ProposalExecutionContext> =>
    knex.transaction(async transaction => {
      const context = await lockProposal(transaction, input.proposalId, input.approvalId)
      assertApplyingAuthority(context.proposal, input.authority)
      if (context.approval.status !== 'approved' || context.approval.approvedByUserId === null) {
        throw new AgentProposalError('PROPOSAL_NOT_APPROVED', 'Proposal is not approved', 409)
      }
      if (context.proposal.status !== 'applying' && context.proposal.status !== 'recovery_required') {
        throw new AgentProposalError('PROPOSAL_STATE_CHANGED', 'Proposal execution state is inconsistent', 409)
      }
      if (execution.inputHash !== context.proposal.inputHash)
        throw new AgentProposalError('PROPOSAL_LEDGER_TAMPERED', 'Proposal execution input hash does not match', 409)
      return { proposal: context.proposal, approval: context.approval, input: context.input }
    })

  const prior = await knex<ExecutionRow>('agentActionExecutions').where({ proposalId: input.proposalId }).first()
  if (prior) {
    const completed = completedResult(prior)
    if (completed) return completed
    const recoveryContext = await loadRecoveryContext(prior)
    const recovered = await input.reconcile(recoveryContext)
    if (recovered !== null) return commitResult(prior.id, recovered)
    if (recoveryContext.proposal.actionName === 'pages.prepareCreate') {
      await knex.transaction(async transaction => {
        await transaction('agentActionExecutions').where({ id: prior.id, status: 'applying' }).update({ status: 'recovery_required' })
        await transaction('agentProposals').where({ id: input.proposalId, status: 'applying' }).update({ status: 'recovery_required' })
      })
      throw new AgentProposalError('PROPOSAL_RECOVERY_REQUIRED', 'Creation cannot be attributed to a stable page identity after interruption', 409)
    }
    throw new AgentProposalError(
      prior.status === 'recovery_required' ? 'PROPOSAL_RECOVERY_REQUIRED' : 'PROPOSAL_EXECUTION_IN_PROGRESS',
      prior.status === 'recovery_required'
        ? 'Proposal execution requires recovery before it can continue'
        : 'Proposal already has a non-terminal execution claim',
      409
    )
  }

  const claim = await knex.transaction(async transaction => {
    const context = await lockProposal(transaction, input.proposalId, input.approvalId)
    assertApplyingAuthority(context.proposal, input.authority)
    if (context.proposal.status !== 'approved' || context.approval.status !== 'approved' || context.approval.approvedByUserId === null) {
      throw new AgentProposalError('PROPOSAL_NOT_APPROVED', 'Proposal is not approved', 409)
    }
    if (dateValue(context.proposal.expiresAt) <= Date.now()) throw new AgentProposalError('PROPOSAL_EXPIRED', 'Proposal has expired', 409)
    if (input.signal.aborted) throw new AgentProposalError('ACTION_CANCELLED', 'Proposal apply was cancelled', 409)
    await input.reauthorize({ ...context, approverUserId: context.approval.approvedByUserId, authority: input.authority })
    const existing = await transaction<ExecutionRow>('agentActionExecutions').where({ proposalId: input.proposalId }).forUpdate().first()
    if (existing) throw new AgentProposalError('PROPOSAL_EXECUTION_IN_PROGRESS', 'Proposal already has a non-terminal execution claim', 409)

    const idempotencyKey = sha256(
      canonicalJson({
        version: 1,
        proposalId: context.proposal.id,
        authoritySha256: context.proposal.authoritySha256,
        inputHash: context.proposal.inputHash
      })
    )
    const executionId = randomUUID()
    const now = new Date().toISOString()
    await transaction('agentActionExecutions').insert({
      id: executionId,
      proposalId: context.proposal.id,
      runId: context.proposal.runId,
      actionName: context.proposal.actionName,
      requesterUserId: context.proposal.requesterUserId,
      requesterApiKeyId: context.proposal.requesterApiKeyId,
      approvedByUserId: context.approval.approvedByUserId,
      idempotencyKey,
      leaseToken: input.leaseToken ?? null,
      status: 'applying',
      inputHash: context.proposal.inputHash,
      startedAt: now,
      completedAt: null,
      result: null,
      error: null
    })
    const applying = await transaction('agentProposals').where({ id: context.proposal.id, status: 'approved' }).update({ status: 'applying' })
    if (applying !== 1) throw new AgentProposalError('PROPOSAL_STATE_CHANGED', 'Proposal state changed concurrently', 409)
    return {
      executionId,
      context: { proposal: { ...context.proposal, status: 'applying' as const }, approval: context.approval, input: context.input }
    }
  })

  try {
    if (input.signal.aborted) throw new AgentProposalError('ACTION_CANCELLED', 'Proposal apply was cancelled before mutation dispatch', 409)
    const rawResult = await input.mutate(claim.context)
    return await commitResult(claim.executionId, rawResult)
  } catch (error: unknown) {
    const recovered = await input.reconcile(claim.context)
    if (recovered !== null) return commitResult(claim.executionId, recovered)
    const recoveryRequired = claim.context.proposal.actionName === 'pages.prepareCreate'
    await knex.transaction(async transaction => {
      await transaction('agentActionExecutions')
        .where({ id: claim.executionId, status: 'applying' })
        .update({
          status: recoveryRequired ? 'recovery_required' : 'failed',
          completedAt: recoveryRequired ? null : transaction.fn.now(),
          error: recoveryRequired ? 'creation_identity_unavailable' : 'mutation_failed'
        })
      await transaction('agentProposals')
        .where({ id: input.proposalId, status: 'applying' })
        .update({ status: recoveryRequired ? 'recovery_required' : 'failed' })
    })
    if (recoveryRequired)
      throw new AgentProposalError('PROPOSAL_RECOVERY_REQUIRED', 'Creation may have committed but its stable page identity could not be proven', 409)
    throw error
  }
}
