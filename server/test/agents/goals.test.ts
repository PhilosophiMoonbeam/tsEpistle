import { createHash } from 'node:crypto'
import { describe, expect, it } from '../bun-test.mts'

import {
  agentGoalRecord,
  agentGoalTokenAllowance,
  assessAgentRunCompletion,
  decodeCompletionAssessment,
  encodedCompletionAssessment
} from '../../agents/goals.ts'
import type { AgentTaskRecord } from '../../agents/tasks.ts'

const task = (overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord => ({
  id: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
  subagentRunId: '00000000-0000-4000-8000-000000000003',
  ordinal: 0,
  kind: 'source_scout',
  title: 'Inspect the runbook',
  question: 'Which recovery steps are authoritative?',
  sourceScope: ['incident-runbook'],
  requiredEvidenceCount: 1,
  status: 'completed',
  outcome: 'completed',
  attempt: 1,
  evidenceCount: 1,
  authoritySha256: 'a'.repeat(64),
  packet: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  startedAt: '2026-09-01T00:00:01.000Z',
  completedAt: '2026-09-01T00:00:02.000Z',
  ...overrides
})

const renewableGoalRow = ({ status = 'budget_limited', budgetLimitReason = 'tokens' }: { status?: string; budgetLimitReason?: string | null } = {}) => {
  const objective = 'Continue the deployment investigation'
  return {
    id: '00000000-0000-4000-8000-000000000011',
    sessionId: '00000000-0000-4000-8000-000000000012',
    ownerId: 7,
    createdByUserId: 7,
    objective,
    objectiveSha256: createHash('sha256').update(objective).digest('hex'),
    status,
    version: 3,
    continuationCount: 1,
    maxContinuations: 4,
    consumedTokens: 500,
    maxTokens: 500,
    consumedToolCalls: 1,
    maxToolCalls: 10,
    budgetPolicyVersion: 1,
    budgetSelection: 'utility',
    tokenTier: 'standard',
    tokenAllowance: 250,
    budgetCycle: 1,
    budgetLimitReason,
    completionOutcome: null,
    completionAssessment: null,
    completionAssessmentSha256: null,
    errorCode: 'GOAL_BUDGET_LIMITED',
    errorMessage: 'Goal token budget was exhausted',
    startedAt: '2026-09-01T00:00:00.000Z',
    deadlineAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-01T01:00:00.000Z',
    completedAt: '2026-09-01T01:00:00.000Z'
  }
}
const legacyGoalRow = ({
  status = 'budget_limited',
  budgetLimitReason = 'tokens',
  budgetPolicyVersion = null,
  budgetSelection = 'legacy',
  tokenTier = null,
  tokenAllowance = null,
  budgetCycle = 0
}: {
  status?: string
  budgetLimitReason?: string | null
  budgetPolicyVersion?: number | null
  budgetSelection?: string
  tokenTier?: string | null
  tokenAllowance?: number | string | null
  budgetCycle?: number
} = {}) => ({
  ...renewableGoalRow({ status, budgetLimitReason }),
  budgetPolicyVersion,
  budgetSelection,
  tokenTier,
  tokenAllowance,
  budgetCycle
})

describe('agent durable goal completion assessment', () => {
  it('completes only after tasks, evidence, proposals, and usage reconcile', () => {
    expect(
      assessAgentRunCompletion({
        tasks: [task()],
        pendingProposalCount: 0,
        evidenceGatePassed: true,
        usageReconciled: true
      })
    ).toEqual({ outcome: 'complete', issues: [] })

    expect(
      assessAgentRunCompletion({
        tasks: [task({ evidenceCount: 0 })],
        pendingProposalCount: 0,
        evidenceGatePassed: false,
        usageReconciled: false
      })
    ).toEqual({
      outcome: 'retry',
      issues: [
        { code: 'REQUIRED_EVIDENCE_MISSING', message: 'Research task “Inspect the runbook” did not satisfy its evidence requirement.', retryable: true },
        { code: 'EVIDENCE_GATE_FAILED', message: 'The answer did not pass citation and evidence validation.', retryable: true },
        { code: 'USAGE_NOT_RECONCILED', message: 'Aggregate usage has not been reconciled.', retryable: true }
      ]
    })
  })

  it('blocks while a required human proposal remains pending', () => {
    const assessment = assessAgentRunCompletion({
      tasks: [],
      pendingProposalCount: 1,
      evidenceGatePassed: true,
      usageReconciled: true
    })
    expect(assessment).toEqual({
      outcome: 'blocked',
      issues: [{ code: 'APPROVAL_PENDING', message: 'A required proposal is still awaiting resolution.', retryable: false }]
    })
  })

  it('blocks durable continuation when a required research task is suspended', () => {
    const assessment = assessAgentRunCompletion({
      tasks: [
        task({
          status: 'blocked',
          outcome: 'blocked',
          evidenceCount: 0,
          errorCode: 'SOURCE_UNAVAILABLE',
          errorMessage: 'The required source is unavailable.'
        })
      ],
      pendingProposalCount: 0,
      evidenceGatePassed: true,
      usageReconciled: true
    })
    expect(assessment).toEqual({
      outcome: 'blocked',
      issues: [
        {
          code: 'REQUIRED_TASK_BLOCKED',
          message: 'Research task “Inspect the runbook” is blocked and needs new external input or conditions.',
          retryable: false
        }
      ]
    })
  })

  it('hash-binds the host assessment and rejects tampering', () => {
    const assessment = assessAgentRunCompletion({ tasks: [], pendingProposalCount: 0, evidenceGatePassed: true, usageReconciled: true })
    const encoded = encodedCompletionAssessment(assessment)
    expect(decodeCompletionAssessment(encoded.encoded, assessment.outcome, encoded.sha256)).toEqual(assessment)
    expect(() => decodeCompletionAssessment(`${encoded.encoded} `, assessment.outcome, encoded.sha256)).toThrow('integrity check failed')
    expect(() => decodeCompletionAssessment(encoded.encoded, 'retry', encoded.sha256)).toThrow('does not match')
  })
  it('derives all three policy v2 token allowances from the configured ceiling', () => {
    expect(agentGoalTokenAllowance(384_000, 'small')).toBe(64_000)
    expect(agentGoalTokenAllowance(384_000, 'standard')).toBe(192_000)
    expect(agentGoalTokenAllowance(384_000, 'extended')).toBe(384_000)
  })

  it('exposes renewal only when a selected token budget is the limiting reason', () => {
    expect(agentGoalRecord(renewableGoalRow()).canRenewTokenBudget).toBe(true)
    expect(agentGoalRecord({ ...renewableGoalRow(), budgetPolicyVersion: 2, tokenTier: 'small' }).canRenewTokenBudget).toBe(true)

    for (const reason of ['tool_calls', 'duration', 'continuations', 'quota', 'accounting', 'authority']) {
      expect(agentGoalRecord(renewableGoalRow({ budgetLimitReason: reason })).canRenewTokenBudget).toBe(false)
    }
    expect(agentGoalRecord(renewableGoalRow({ status: 'active' })).canRenewTokenBudget).toBe(false)
  })
  it('decodes validated lifecycle reasons on legacy goals without enabling renewal', () => {
    expect(agentGoalRecord(legacyGoalRow({ status: 'budget_limited', budgetLimitReason: 'tokens' }))).toMatchObject({
      budgetPolicyVersion: null,
      budgetSelection: 'legacy',
      tokenTier: null,
      tokenAllowance: null,
      budgetCycle: 0,
      budgetLimitReason: 'tokens',
      canRenewTokenBudget: false
    })
    for (const budgetLimitReason of ['accounting', 'authority']) {
      expect(agentGoalRecord(legacyGoalRow({ status: 'blocked', budgetLimitReason }))).toMatchObject({
        budgetPolicyVersion: null,
        budgetSelection: 'legacy',
        tokenTier: null,
        tokenAllowance: null,
        budgetCycle: 0,
        budgetLimitReason,
        canRenewTokenBudget: false
      })
    }
    expect(() => agentGoalRecord(legacyGoalRow({ budgetLimitReason: 'unknown' }))).toThrow('Stored agent goal counters are invalid')
    expect(() => agentGoalRecord({ ...renewableGoalRow(), budgetPolicyVersion: 1, tokenTier: 'small' })).toThrow('Stored agent goal budget policy is invalid')
    expect(() => agentGoalRecord(legacyGoalRow({ tokenTier: 'standard' }))).toThrow('Stored agent goal budget policy is invalid')
    expect(() => agentGoalRecord(legacyGoalRow({ budgetCycle: 1 }))).toThrow('Stored agent goal budget policy is invalid')
  })
})
