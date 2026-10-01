import { describe, expect, it } from '../bun-test.mts'
import { AGENT_TERMINAL_RUN_STATUSES, isTerminalAgentRunStatus, type AgentRunStatus } from '../../../shared/agents/contracts.ts'

describe('shared agent lifecycle contracts', () => {
  it('owns the complete terminal run status set', () => {
    expect([...AGENT_TERMINAL_RUN_STATUSES].sort()).toEqual(['cancelled', 'failed', 'partial', 'recovery_required', 'succeeded'])

    const cases: readonly (readonly [AgentRunStatus, boolean])[] = [
      ['succeeded', true],
      ['partial', true],
      ['failed', true],
      ['cancelled', true],
      ['recovery_required', true],
      ['queued', false],
      ['running', false],
      ['awaiting_approval', false]
    ]
    for (const [status, terminal] of cases) expect(isTerminalAgentRunStatus(status)).toBe(terminal)
  })
})
