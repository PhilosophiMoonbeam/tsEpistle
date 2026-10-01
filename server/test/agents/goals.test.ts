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
    const completeInput = {
      tasks: [task()],
      pendingProposalCount: 0,
      evidenceGatePassed: true,
      usageReconciled: true
    }
    expect(assessAgentRunCompletion(completeInput)).toEqual({ outcome: 'complete', issues: [] })

    for (const { overrides, code } of [
      { overrides: { tasks: [task({ evidenceCount: 0 })] }, code: 'REQUIRED_EVIDENCE_MISSING' },
      { overrides: { evidenceGatePassed: false }, code: 'EVIDENCE_GATE_FAILED' },
      { overrides: { usageReconciled: false }, code: 'USAGE_NOT_RECONCILED' }
    ]) {
      const assessment = assessAgentRunCompletion({ ...completeInput, ...overrides })
      expect(assessment.outcome).toBe('retry')
      expect(assessment.issues.map(({ code, message, retryable }) => ({ code, message, retryable }))).toEqual([
        { code, message: expect.any(String), retryable: true }
      ])
    }

    const assessment = assessAgentRunCompletion({
      ...completeInput,
      tasks: [task({ evidenceCount: 0 })],
      evidenceGatePassed: false,
      usageReconciled: false
    })
    expect(assessment.outcome).toBe('retry')
    expect(assessment.issues.map(({ code, message, retryable }) => ({ code, message, retryable })).sort((left, right) => left.code.localeCompare(right.code))).toEqual([
      { code: 'EVIDENCE_GATE_FAILED', message: expect.any(String), retryable: true },
      { code: 'REQUIRED_EVIDENCE_MISSING', message: expect.any(String), retryable: true },
      { code: 'USAGE_NOT_RECONCILED', message: expect.any(String), retryable: true }
    ])
  })

  it('blocks while a required human proposal remains pending', () => {
    const assessment = assessAgentRunCompletion({
      tasks: [],
      pendingProposalCount: 1,
      evidenceGatePassed: true,
      usageReconciled: true
    })
    expect(assessment.outcome).toBe('blocked')
    expect(assessment.issues.map(({ code, message, retryable }) => ({ code, message, retryable }))).toEqual([
      { code: 'APPROVAL_PENDING', message: expect.any(String), retryable: false }
    ])
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
    expect(assessment.outcome).toBe('blocked')
    expect(assessment.issues.map(({ code, message, retryable }) => ({ code, message, retryable }))).toEqual([
      { code: 'REQUIRED_TASK_BLOCKED', message: expect.any(String), retryable: false }
    ])
  })

  it('hash-binds the host assessment and rejects tampering', () => {
    const assessment = assessAgentRunCompletion({ tasks: [], pendingProposalCount: 0, evidenceGatePassed: true, usageReconciled: true })
    const encoded = encodedCompletionAssessment(assessment)
    expect(decodeCompletionAssessment(encoded.encoded, assessment.outcome, encoded.sha256)).toEqual(assessment)
    expect(() => decodeCompletionAssessment(`${encoded.encoded} `, assessment.outcome, encoded.sha256)).toThrow(
      expect.objectContaining({ code: 'AGENT_COMPLETION_CORRUPT', status: 500 })
    )
    expect(() => decodeCompletionAssessment(encoded.encoded, 'retry', encoded.sha256)).toThrow(
      expect.objectContaining({ code: 'AGENT_COMPLETION_CORRUPT', status: 500 })
    )
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
    expect(() => agentGoalRecord(legacyGoalRow({ budgetLimitReason: 'unknown' }))).toThrow(
      expect.objectContaining({ code: 'AGENT_GOAL_CORRUPT', status: 500 })
    )
    expect(() => agentGoalRecord({ ...renewableGoalRow(), budgetPolicyVersion: 1, tokenTier: 'small' })).toThrow(
      expect.objectContaining({ code: 'AGENT_GOAL_CORRUPT', status: 500 })
    )
    expect(() => agentGoalRecord(legacyGoalRow({ tokenTier: 'standard' }))).toThrow(
      expect.objectContaining({ code: 'AGENT_GOAL_CORRUPT', status: 500 })
    )
    expect(() => agentGoalRecord(legacyGoalRow({ budgetCycle: 1 }))).toThrow(
      expect.objectContaining({ code: 'AGENT_GOAL_CORRUPT', status: 500 })
    )
  })
})
