import { describe, expect, expectTypeOf, it } from '../bun-test.mts'
import {
  AGENT_TERMINAL_RUN_STATUSES,
  isTerminalAgentRunStatus,
  type AgentRunStatus,
  type DecideAgentApprovalRequest
} from '../../../shared/agents/contracts.ts'

describe('shared agent lifecycle contracts', () => {
  it('owns the complete terminal run status set', () => {
    expect(AGENT_TERMINAL_RUN_STATUSES).toEqual(['succeeded', 'partial', 'failed', 'cancelled', 'recovery_required'])

    const statuses: readonly AgentRunStatus[] = ['queued', 'running', 'awaiting_approval', ...AGENT_TERMINAL_RUN_STATUSES]
    expect(statuses.filter(isTerminalAgentRunStatus)).toEqual(AGENT_TERMINAL_RUN_STATUSES)
  })

  it('matches the strict approval decision wire payload', () => {
    expectTypeOf<DecideAgentApprovalRequest>().toEqualTypeOf<{
      readonly decision: 'approved' | 'denied'
      readonly decisionNote?: string
      readonly confirmationPath?: string
    }>()

    const destructiveApproval = {
      decision: 'approved',
      decisionNote: 'Operator confirmed the destructive change',
      confirmationPath: 'docs/obsolete'
    } as const satisfies DecideAgentApprovalRequest
    const denial = { decision: 'denied', decisionNote: 'Keep the page' } as const satisfies DecideAgentApprovalRequest

    expect(destructiveApproval.confirmationPath).toBe('docs/obsolete')
    expect(denial.decision).toBe('denied')
  })
})
