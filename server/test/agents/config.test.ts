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
      retention: { temporarySessionHours: 24, savedSessionDays: 90, mcpContentDays: 7, auditDays: 90, maintenanceBatchSize: 100 },
      sse: { maximumConnectionsPerUser: 3 }
    })
  })

  it.each([
    { ...base, provider: { globalConcurrency: 0 } },
    { ...base, provider: { globalConcurrency: 4, perUserConcurrency: 5 } },
    { ...base, provider: { pollingMilliseconds: 61_000 } },
    { ...base, retention: { temporarySessionHours: 0 } },
    { ...base, retention: { savedSessionDays: 0 } },
    { ...base, retention: { maintenanceBatchSize: 10_001 } },
    { ...base, sse: { maximumConnectionsPerUser: 21 } }
  ])('rejects invalid or unbounded limits', value => {
    expect(() => parseAgentOperationalLimits(value)).toThrow()
  })
})
