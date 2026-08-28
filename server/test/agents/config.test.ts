import { describe, expect, it } from 'vitest'

import { parseAgentOperationalLimits } from '../../agents/config.ts'

const base = {
  provider: { enabled: false },
  retention: {},
  sse: {}
}

describe('agent operational limits', () => {
  it('applies conservative bounded defaults', () => {
    expect(parseAgentOperationalLimits(base)).toMatchObject({
      provider: { globalConcurrency: 4, perUserConcurrency: 1, pollingMilliseconds: 1_000 },
      orchestration: {
        enabled: false,
        maxConcurrentChildren: 3,
        maxChildren: 6,
        plannerTurns: 2,
        childTurns: 4,
        childToolCalls: 8,
        plannerTimeoutMilliseconds: 30_000,
        childTimeoutMilliseconds: 120_000,
        plannerMaxOutputTokens: 1_024,
        childMaxOutputTokens: 2_048,
        maxAggregateChildTokens: 12_000,
        maxAggregateChildOutputCharacters: 96_000
      },
      retention: { temporarySessionHours: 24, savedSessionDays: 90, mcpContentDays: 7, auditDays: 90, maintenanceBatchSize: 100 },
      sse: { maximumConnectionsPerUser: 3 }
    })
  })

  it.each([
    { ...base, provider: { globalConcurrency: 0 } },
    { ...base, provider: { globalConcurrency: 4, perUserConcurrency: 5 } },
    { ...base, provider: { pollingMilliseconds: 61_000 } },
    { ...base, orchestration: { maxChildren: 2, maxConcurrentChildren: 3 } },
    { ...base, orchestration: { childTurns: 9 } },
    { ...base, orchestration: { childTimeoutMilliseconds: 9_999 } },
    { ...base, orchestration: { maxAggregateChildTokens: 999 } },
    { ...base, retention: { temporarySessionHours: 0 } },
    { ...base, retention: { savedSessionDays: 0 } },
    { ...base, retention: { maintenanceBatchSize: 10_001 } },
    { ...base, sse: { maximumConnectionsPerUser: 21 } }
  ])('rejects invalid or unbounded limits', value => {
    expect(() => parseAgentOperationalLimits(value)).toThrow()
  })
})
