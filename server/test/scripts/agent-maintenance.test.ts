import { describe, expect, it } from '../bun-test.mts'

import type { AgentMaintenanceResult } from '../../agents/maintenance.ts'
import { runAgentMaintenanceBatches } from '../../scripts/agent-maintenance.ts'

const maintenanceBatch = (changes: Partial<AgentMaintenanceResult> = {}): AgentMaintenanceResult => ({
  cancelledRuns: 0,
  recoveredRuns: 0,
  requeuedRuns: 0,
  recoveredProposalExecutions: 0,
  expiredApprovals: 0,
  expiredArtifacts: 0,
  tombstonedSessions: 0,
  purgedSessions: 0,
  scrubbedMcpProposals: 0,
  purgedMcpProposals: 0,
  scrubbedSkillUses: 0,
  purgedSkillUses: 0,
  purgedUsageRows: 0,
  compactedEvents: 0,
  reconciledReservations: 0,
  ...changes
})

describe('agent maintenance script draining', () => {
  it('reports exhaustion and a scheduler-visible failure when the only allowed batch changes rows', async () => {
    let calls = 0
    const result = await runAgentMaintenanceBatches(async () => {
      calls += 1
      return maintenanceBatch({ tombstonedSessions: 1 })
    }, 1)

    expect(calls).toBe(1)
    expect(result).toMatchObject({
      exitCode: 1,
      summary: {
        maintenance: 'exhausted',
        truncated: true,
        zeroChangeBatchObserved: false,
        batches: 1,
        maxBatches: 1,
        totals: { tombstonedSessions: 1 },
        remainingRisk: {
          reason: 'max_batches_reached',
          rowsMayRemain: true
        }
      }
    })
  })

  it('reports complete only after a changed batch is followed by a zero-change batch', async () => {
    const batches = [maintenanceBatch({ tombstonedSessions: 1 }), maintenanceBatch()]
    let calls = 0
    const result = await runAgentMaintenanceBatches(async () => batches[calls++]!, 2)

    expect(calls).toBe(2)
    expect(result).toMatchObject({
      exitCode: 0,
      summary: {
        maintenance: 'complete',
        truncated: false,
        zeroChangeBatchObserved: true,
        batches: 2,
        maxBatches: 2,
        totals: { tombstonedSessions: 1 },
        remainingRisk: null
      }
    })
  })
})
