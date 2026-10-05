import { describe, expect, it } from '../../server/test/bun-test.mts'
import { isAgentProviderTransport } from './agent-provider-protocols.ts'

describe('agent provider transport input', () => {
  it('rejects unknown transport values before form state changes', () => {
    expect(isAgentProviderTransport('openresponses')).toBe(true)
    expect(isAgentProviderTransport('responses')).toBe(false)
    expect(isAgentProviderTransport(null)).toBe(false)
  })
})
