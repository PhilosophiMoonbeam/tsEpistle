import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

import type { AgentActionName } from '../../../shared/agents/contracts.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import type { ActionAuthority } from '../actions/kernel.ts'

export type ProposalRisk = 'proposal' | 'destructive-write'
export type ProposalStatus = 'pending' | 'approved' | 'denied' | 'applying' | 'applied' | 'expired' | 'cancelled' | 'failed' | 'recovery_required'
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'

export interface ProposalBaseContract {
  readonly pageId?: number
  readonly baseSourceRevision?: string
  readonly baseLineEnding?: 'lf' | 'crlf'
  readonly baseFinalNewline?: boolean
  readonly baseRawSha256?: string
  readonly baseCanonicalSha256?: string
  readonly disclosedRangesSha256?: string
  readonly patchFormat?: 'wiki-line-patch-v1'
  readonly patchEngineVersion?: number
  readonly patch?: string
  readonly patchSha256?: string
  readonly resultRawSha256?: string
  readonly resultCanonicalSha256?: string
  readonly diffRendererVersion?: number
  readonly diff?: string
  readonly diffSha256?: string
}

export interface ProposalScope {
  readonly runId?: string
  readonly sessionId?: string
}

export interface ProposalDraft extends ProposalBaseContract, ProposalScope {
  readonly authority: ActionAuthority
  readonly actionCallId: string
  readonly risk: ProposalRisk
  readonly input: unknown
  readonly operation: unknown
  readonly summary: string
  readonly ttlMs?: number
}

export interface ProposalRecord extends ProposalBaseContract {
  readonly id: string
  readonly sourceKind: 'agent' | 'mcp'
  readonly actionCallId: string
  readonly runId: string | null
  readonly sessionId: string | null
  readonly requesterUserId: number | null
  readonly requesterApiKeyId: number | null
  readonly requesterRequestId: string
  readonly actionName: AgentActionName
  readonly risk: ProposalRisk
  readonly summary: string
  readonly status: ProposalStatus
  readonly input: string | null
  readonly inputHash: string
  readonly authorityVersion: number
  readonly operation: string
  readonly operationSha256: string
  readonly authoritySha256: string
  readonly expiresAt: Date | string
  readonly createdAt: Date | string
  readonly appliedAt: Date | string | null
  readonly contentPurgedAt: Date | string | null
  readonly applyResult: string | null
}

export interface ApprovalRecord {
  readonly id: string
  readonly proposalId: string
  readonly runId: string | null
  readonly requesterUserId: number | null
  readonly requesterApiKeyId: number | null
  readonly status: ApprovalStatus
  readonly inputHash: string
  readonly authorityVersion: number
  readonly authoritySha256: string
  readonly patchSha256: string | null
  readonly resultCanonicalSha256: string | null
  readonly diffSha256: string | null
  readonly operationSha256: string
  readonly requestedAt: Date | string
  readonly expiresAt: Date | string
  readonly decidedAt: Date | string | null
  readonly approvedByUserId: number | null
  readonly decisionNote: string | null
}

export interface PersistedProposal {
  readonly proposal: ProposalRecord
  readonly approval: ApprovalRecord
  readonly replayed: boolean
  readonly summary: string
}

export class AgentProposalError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value
const nullable = <T>(value: T | undefined): T | null => value === undefined ? null : value

const assertHex = (value: string | undefined, label: string): void => {
  if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) throw new AgentProposalError('INVALID_PROPOSAL', `${label} must be a SHA-256 hash`, 400)
}

const assertStoredOperation = (proposal: ProposalRecord): void => {
  if (!/^[a-f0-9]{64}$/.test(proposal.operationSha256) || sha256(proposal.operation) !== proposal.operationSha256) {
    throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal operation hash does not match', 500)
  }
}

const validateDraft = (draft: ProposalDraft): void => {
  const authority = draft.authority
  if (authority.actionName === 'pages.applyProposal' || !authority.actionName.startsWith('pages.prepare')) {
    throw new AgentProposalError('INVALID_PROPOSAL_ACTION', 'Only page preparation actions can create proposals', 400)
  }
  if (authority.transport === 'agent') {
    if (authority.requester.kind !== 'user' || !draft.runId || !draft.sessionId) {
      throw new AgentProposalError('INVALID_PROPOSAL_SCOPE', 'Agent proposals require a user, run, and session', 400)
    }
  } else if (authority.requester.kind !== 'apiKey' || draft.runId !== undefined || draft.sessionId !== undefined) {
    throw new AgentProposalError('INVALID_PROPOSAL_SCOPE', 'MCP proposals require one API key and no run or session', 400)
  }
  if (!draft.actionCallId || draft.actionCallId.length > 128) throw new AgentProposalError('INVALID_PROPOSAL', 'Proposal action call identity is invalid', 400)
  if (draft.summary.length < 1 || draft.summary.length > 4_000) throw new AgentProposalError('INVALID_PROPOSAL', 'Proposal summary is invalid', 400)
  if (draft.ttlMs !== undefined && (!Number.isSafeInteger(draft.ttlMs) || draft.ttlMs < 60_000 || draft.ttlMs > 86_400_000)) {
    throw new AgentProposalError('INVALID_PROPOSAL', 'Proposal expiry is invalid', 400)
  }
  if (draft.baseSourceRevision !== undefined && !/^[1-9][0-9]*$/.test(draft.baseSourceRevision)) {
    throw new AgentProposalError('INVALID_PROPOSAL', 'Base source revision is invalid', 400)
  }
  assertHex(draft.baseRawSha256, 'baseRawSha256')
  assertHex(draft.baseCanonicalSha256, 'baseCanonicalSha256')
  assertHex(draft.disclosedRangesSha256, 'disclosedRangesSha256')
  assertHex(draft.patchSha256, 'patchSha256')
  assertHex(draft.resultRawSha256, 'resultRawSha256')
  assertHex(draft.resultCanonicalSha256, 'resultCanonicalSha256')
  assertHex(draft.diffSha256, 'diffSha256')
}

const canonicalProposalEnvelope = (draft: ProposalDraft): string => canonicalJson({
  version: 1,
  sourceKind: draft.authority.transport,
  requester: draft.authority.requester,
  requesterRequestId: draft.authority.requestId,
  runId: draft.runId ?? null,
  sessionId: draft.sessionId ?? null,
  actionName: draft.authority.actionName,
  actionCallId: draft.actionCallId,
  risk: draft.risk,
  input: draft.input,
  summary: draft.summary,
  operation: draft.operation,
  authorityVersion: draft.authority.version,
  authoritySha256: draft.authority.authoritySha256,
  pageId: draft.pageId ?? null,
  baseSourceRevision: draft.baseSourceRevision ?? null,
  baseLineEnding: draft.baseLineEnding ?? null,
  baseFinalNewline: draft.baseFinalNewline ?? null,
  baseRawSha256: draft.baseRawSha256 ?? null,
  baseCanonicalSha256: draft.baseCanonicalSha256 ?? null,
  disclosedRangesSha256: draft.disclosedRangesSha256 ?? null,
  patchFormat: draft.patchFormat ?? null,
  patchEngineVersion: draft.patchEngineVersion ?? null,
  patchSha256: draft.patchSha256 ?? null,
  resultRawSha256: draft.resultRawSha256 ?? null,
  resultCanonicalSha256: draft.resultCanonicalSha256 ?? null,
  diffRendererVersion: draft.diffRendererVersion ?? null,
  diffSha256: draft.diffSha256 ?? null
})

const proposalLookup = (knex: Knex | Knex.Transaction, draft: ProposalDraft) => {
  const query = knex<ProposalRecord>('agentProposals').where('actionCallId', draft.actionCallId)
  if (draft.authority.transport === 'agent') return query.where('sourceKind', 'agent').where('runId', draft.runId!)
  const apiKeyId = draft.authority.requester.kind === 'apiKey' ? draft.authority.requester.apiKeyId : 0
  return query.where('sourceKind', 'mcp').where('requesterRequestId', draft.authority.requestId).where('requesterApiKeyId', apiKeyId)
}

const readPersisted = async (knex: Knex | Knex.Transaction, draft: ProposalDraft, inputHash: string, replayed: boolean): Promise<PersistedProposal | null> => {
  const proposal = await proposalLookup(knex, draft).first()
  if (!proposal) return null
  assertStoredOperation(proposal)
  if (proposal.inputHash !== inputHash) throw new AgentProposalError('IDEMPOTENCY_MISMATCH', 'Proposal request ID was reused with different immutable input', 409)
  const approval = await knex<ApprovalRecord>('agentApprovals').where({ proposalId: proposal.id }).first()
  if (!approval) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal approval is missing', 500)
  if (approval.operationSha256 !== proposal.operationSha256) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal approval operation hash does not match', 500)
  return { proposal, approval, replayed, summary: draft.summary }
}
const readRecoverable = async (knex: Knex | Knex.Transaction, draft: ProposalDraft): Promise<PersistedProposal | null> => {
  if (draft.authority.transport !== 'agent') return null
  const run = await knex('agentRuns').where({ id: draft.runId! }).first('status', 'attempts') as { status: string; attempts: number } | undefined
  if (!run || (run.status !== 'awaiting_approval' && Number(run.attempts) <= 1)) return null
  const matching = knex<ProposalRecord>('agentProposals')
    .where({
      sourceKind: 'agent',
      runId: draft.runId!,
      actionName: draft.authority.actionName,
      input: canonicalJson(draft.input),
      operation: canonicalJson(draft.operation)
    })
  const decided = await matching.clone().whereIn('status', ['approved', 'denied', 'expired']).orderBy('createdAt').first()
  const proposal = decided ?? await matching.where({ status: 'pending' }).orderBy('createdAt').first()
  if (!proposal) return null
  assertStoredOperation(proposal)
  const expectedInputHash = sha256(canonicalProposalEnvelope({ ...draft, actionCallId: proposal.actionCallId }))
  if (proposal.inputHash !== expectedInputHash) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Recoverable proposal does not match its immutable payload', 500)
  const approval = await knex<ApprovalRecord>('agentApprovals').where({ proposalId: proposal.id }).first()
  if (!approval || approval.operationSha256 !== proposal.operationSha256) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Recoverable proposal approval is invalid', 500)
  return { proposal, approval, replayed: true, summary: proposal.summary }
}


export const persistProposal = async (knex: Knex, draft: ProposalDraft): Promise<PersistedProposal> => {
  validateDraft(draft)
  const envelope = canonicalProposalEnvelope(draft)
  const inputHash = sha256(envelope)
  const prior = await readPersisted(knex, draft, inputHash, true)
  if (prior) return prior
  const recoverable = await readRecoverable(knex, draft)
  if (recoverable) return recoverable

  return knex.transaction(async transaction => {
    const existing = await readPersisted(transaction, draft, inputHash, true)
    if (existing) return existing
    const recoverable = await readRecoverable(transaction, draft)
    if (recoverable) return recoverable

    const proposalId = randomUUID()
    const approvalId = randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.valueOf() + (draft.ttlMs ?? 15 * 60_000)).toISOString()
    const requesterUserId = draft.authority.requester.kind === 'user' ? draft.authority.requester.userId : null
    const requesterApiKeyId = draft.authority.requester.kind === 'apiKey' ? draft.authority.requester.apiKeyId : null
    const proposalInput = canonicalJson(draft.input)
    const operation = canonicalJson(draft.operation)
    const operationSha256 = sha256(operation)
    const proposalRow = {
      id: proposalId,
      sourceKind: draft.authority.transport,
      runId: nullable(draft.runId),
      sessionId: nullable(draft.sessionId),
      requesterUserId,
      requesterApiKeyId,
      requesterRequestId: draft.authority.requestId,
      actionCallId: draft.actionCallId,
      actionName: draft.authority.actionName,
      risk: draft.risk,
      summary: draft.summary,
      status: 'pending',
      input: proposalInput,
      inputHash,
      authorityVersion: draft.authority.version,
      authoritySha256: draft.authority.authoritySha256,
      pageId: nullable(draft.pageId),
      baseSourceRevision: nullable(draft.baseSourceRevision),
      baseLineEnding: nullable(draft.baseLineEnding),
      baseFinalNewline: nullable(draft.baseFinalNewline),
      baseRawSha256: nullable(draft.baseRawSha256),
      baseCanonicalSha256: nullable(draft.baseCanonicalSha256),
      disclosedRangesSha256: nullable(draft.disclosedRangesSha256),
      patchFormat: nullable(draft.patchFormat),
      patchEngineVersion: nullable(draft.patchEngineVersion),
      patchSha256: nullable(draft.patchSha256),
      patch: nullable(draft.patch),
      operation,
      operationSha256,
      resultRawSha256: nullable(draft.resultRawSha256),
      resultCanonicalSha256: nullable(draft.resultCanonicalSha256),
      diffRendererVersion: nullable(draft.diffRendererVersion),
      diffSha256: nullable(draft.diffSha256),
      diff: nullable(draft.diff),
      expiresAt,
      createdAt: now.toISOString(),
      appliedAt: null,
      contentPurgedAt: null,
      applyResult: null
    }
    await transaction('agentProposals').insert(proposalRow).onConflict().ignore()
    const storedProposal = await proposalLookup(transaction, draft).first()
    if (!storedProposal) throw new AgentProposalError('PROPOSAL_LEDGER_WRITE_FAILED', 'Proposal could not be persisted', 500)
    if (storedProposal.inputHash !== inputHash) {
      throw new AgentProposalError('IDEMPOTENCY_MISMATCH', 'Proposal request ID was reused with different immutable input', 409)
    }
    if (storedProposal.id !== proposalId) {
      const winner = await readPersisted(transaction, draft, inputHash, true)
      if (!winner) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal approval is missing', 500)
      return winner
    }
    await transaction('agentApprovals').insert({
      id: approvalId,
      proposalId,
      runId: nullable(draft.runId),
      requesterUserId,
      requesterApiKeyId,
      status: 'pending',
      inputHash,
      authorityVersion: draft.authority.version,
      authoritySha256: draft.authority.authoritySha256,
      patchSha256: nullable(draft.patchSha256),
      resultCanonicalSha256: nullable(draft.resultCanonicalSha256),
      diffSha256: nullable(draft.diffSha256),
      operationSha256,
      requestedAt: now.toISOString(),
      expiresAt,
      decidedAt: null,
      approvedByUserId: null,
      decisionNote: null
    })
    const created = await readPersisted(transaction, draft, inputHash, false)
    if (!created) throw new AgentProposalError('PROPOSAL_LEDGER_WRITE_FAILED', 'Proposal could not be persisted', 500)
    return created
  })
}

export const proposalResult = (persisted: PersistedProposal): {
  proposalId: string
  approvalId: string
  actionName: string
  status: 'pending'
  inputHash: string
  diffHash: string | null
  summary: string
  expiresAt: string
} => {
  if (persisted.proposal.status !== 'pending' || persisted.approval.status !== 'pending') {
    throw new AgentProposalError('PROPOSAL_NOT_PENDING', 'Proposal is no longer pending', 409)
  }
  return {
    proposalId: persisted.proposal.id,
    actionName: persisted.proposal.actionName,
    approvalId: persisted.approval.id,
    status: 'pending',
    inputHash: persisted.proposal.inputHash,
    diffHash: persisted.proposal.diffSha256 ?? null,
    summary: persisted.summary,
    expiresAt: iso(persisted.proposal.expiresAt)
  }
}

export const getOwnedProposal = async (knex: Knex, ownerId: number, proposalId: string): Promise<PersistedProposal> => {
  const proposal = await knex<ProposalRecord>('agentProposals').where({ id: proposalId, requesterUserId: ownerId, sourceKind: 'agent' }).first()
  if (!proposal) throw new AgentProposalError('PROPOSAL_NOT_FOUND', 'Proposal was not found', 404)
  assertStoredOperation(proposal)
  const approval = await knex<ApprovalRecord>('agentApprovals').where({ proposalId: proposal.id, requesterUserId: ownerId }).first()
  if (!approval) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal approval is missing', 500)
  if (approval.operationSha256 !== proposal.operationSha256) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal approval operation hash does not match', 500)
  return { proposal, approval, replayed: true, summary: proposal.summary }
}

export const getMcpProposal = async (knex: Knex, apiKeyId: number, proposalId: string): Promise<PersistedProposal> => {
  const proposal = await knex<ProposalRecord>('agentProposals').where({ id: proposalId, requesterApiKeyId: apiKeyId, sourceKind: 'mcp' }).first()
  if (!proposal) throw new AgentProposalError('PROPOSAL_NOT_FOUND', 'Proposal was not found', 404)
  assertStoredOperation(proposal)
  const approval = await knex<ApprovalRecord>('agentApprovals').where({ proposalId: proposal.id, requesterApiKeyId: apiKeyId }).first()
  if (!approval) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal approval is missing', 500)
  if (approval.operationSha256 !== proposal.operationSha256) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal approval operation hash does not match', 500)
  return { proposal, approval, replayed: true, summary: proposal.summary }
}

export const getMcpProposalForApproval = async (knex: Knex, proposalId: string): Promise<PersistedProposal> => {
  const proposal = await knex<ProposalRecord>('agentProposals').where({ id: proposalId, sourceKind: 'mcp' }).first()
  if (!proposal) throw new AgentProposalError('PROPOSAL_NOT_FOUND', 'Proposal was not found', 404)
  assertStoredOperation(proposal)
  const approval = await knex<ApprovalRecord>('agentApprovals').where({ proposalId: proposal.id }).first()
  if (!approval) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal approval is missing', 500)
  if (approval.operationSha256 !== proposal.operationSha256) throw new AgentProposalError('PROPOSAL_LEDGER_CORRUPT', 'Proposal approval operation hash does not match', 500)
  return { proposal, approval, replayed: true, summary: proposal.summary }
}
