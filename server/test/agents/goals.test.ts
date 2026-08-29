import { describe, expect, it } from '../bun-test.mts'

import { assessAgentRunCompletion, decodeCompletionAssessment, encodedCompletionAssessment } from '../../agents/goals.ts'
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

describe('agent durable goal completion assessment', () => {
  it('completes only after tasks, evidence, proposals, and usage reconcile', () => {
    expect(assessAgentRunCompletion({
      tasks: [task()],
      pendingProposalCount: 0,
      evidenceGatePassed: true,
      usageReconciled: true
    })).toEqual({ outcome: 'complete', issues: [] })

    expect(assessAgentRunCompletion({
      tasks: [task({ evidenceCount: 0 })],
      pendingProposalCount: 0,
      evidenceGatePassed: false,
      usageReconciled: false
    })).toEqual({
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
      tasks: [task({
        status: 'blocked',
        outcome: 'blocked',
        evidenceCount: 0,
        errorCode: 'SOURCE_UNAVAILABLE',
        errorMessage: 'The required source is unavailable.'
      })],
      pendingProposalCount: 0,
      evidenceGatePassed: true,
      usageReconciled: true
    })
    expect(assessment).toEqual({
      outcome: 'blocked',
      issues: [{
        code: 'REQUIRED_TASK_BLOCKED',
        message: 'Research task “Inspect the runbook” is blocked and needs new external input or conditions.',
        retryable: false
      }]
    })
  })

  it('hash-binds the host assessment and rejects tampering', () => {
    const assessment = assessAgentRunCompletion({ tasks: [], pendingProposalCount: 0, evidenceGatePassed: true, usageReconciled: true })
    const encoded = encodedCompletionAssessment(assessment)
    expect(decodeCompletionAssessment(encoded.encoded, assessment.outcome, encoded.sha256)).toEqual(assessment)
    expect(() => decodeCompletionAssessment(`${encoded.encoded} `, assessment.outcome, encoded.sha256)).toThrow('integrity check failed')
    expect(() => decodeCompletionAssessment(encoded.encoded, 'retry', encoded.sha256)).toThrow('does not match')
  })
})
