import { describe, expect, expectTypeOf, it } from '../bun-test.mts'
import {
  AGENT_ACTION_NAMES,
  AGENT_TERMINAL_RUN_STATUSES,
  AGENT_TOOL_CALL_NAMES,
  AGENT_TOOL_CONTROL_NAMES,
  isTerminalAgentRunStatus,
  TOOL_DISCOVERY_CONTROL_NAME,
  type AgentActionName,
  type AgentRunStatus,
  type AgentToolCallName,
  type AgentToolControlName,
  type DecideAgentApprovalRequest
} from '../../../shared/agents/contracts.ts'

describe('shared agent lifecycle contracts', () => {
  it('owns the complete terminal run status set', () => {
    expect(AGENT_TERMINAL_RUN_STATUSES).toEqual(['succeeded', 'partial', 'failed', 'cancelled', 'recovery_required'])

    const statuses: readonly AgentRunStatus[] = ['queued', 'running', 'awaiting_approval', ...AGENT_TERMINAL_RUN_STATUSES]
    expect(statuses.filter(isTerminalAgentRunStatus)).toEqual(AGENT_TERMINAL_RUN_STATUSES)
  })

  it('keeps discovery controls in the shared tool-call vocabulary', () => {
    expect(TOOL_DISCOVERY_CONTROL_NAME).toBe('wiki_enable_tools')
    expect(AGENT_TOOL_CONTROL_NAMES).toEqual([TOOL_DISCOVERY_CONTROL_NAME])
    expect(AGENT_TOOL_CALL_NAMES).toEqual([...AGENT_ACTION_NAMES, TOOL_DISCOVERY_CONTROL_NAME])

    const controlName: AgentToolControlName = TOOL_DISCOVERY_CONTROL_NAME
    const callNames: readonly AgentToolCallName[] = AGENT_TOOL_CALL_NAMES
    const actionName: AgentActionName = 'pages.search'
    expect(callNames.at(-1)).toBe(controlName)
    expect(callNames).toContain(actionName)
    expectTypeOf<AgentToolCallName>().toEqualTypeOf<AgentActionName | AgentToolControlName>()
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
