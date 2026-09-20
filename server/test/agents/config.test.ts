import { describe, expect, it } from '../bun-test.mts'

import { parseAgentOperationalLimits } from '../../agents/config.ts'

const base = {
  provider: { enabled: false },
  retention: {},
  sse: {}
}

describe('agent operational limits', () => {
  it('keeps optional background execution disabled without operator opt-in', () => {
    const limits = parseAgentOperationalLimits(base)
    expect(limits.orchestration.enabled).toBe(false)
    expect(limits.goals.enabled).toBe(false)
  })

  it('uses the goal ceiling consistently with omitted and partial goal configuration', () => {
    expect(parseAgentOperationalLimits(base).goals.maxTokens).toBe(384_000)
    expect(parseAgentOperationalLimits({ ...base, goals: { enabled: true } }).goals.maxTokens).toBe(384_000)
  })

  it('preserves an explicit operator goal ceiling', () => {
    expect(parseAgentOperationalLimits({ ...base, goals: { maxTokens: 60_000 } }).goals.maxTokens).toBe(60_000)
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
