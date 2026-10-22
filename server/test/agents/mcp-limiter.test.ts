import { describe, expect, it } from '../bun-test.mts'
import { McpOwnerRateLimiter } from '../../agents/mcp-limiter.ts'

describe('MCP owner admission', () => {
  it('shares debt by owner and reports the remaining fixed window without extending it on rejection', () => {
    let now = 0
    const limiter = new McpOwnerRateLimiter(2, 60_000, 10, () => now)
    expect(limiter.consume(7)).toBe(0)
    expect(limiter.consume(7)).toBe(0)
    expect(limiter.consume(7)).toBe(60)
    expect(limiter.consume(8)).toBe(0)
    now = 59_001
    expect(limiter.consume(7)).toBe(1)
    now = 60_000
    expect(limiter.consume(7)).toBe(0)
    expect(limiter.consume(7)).toBe(0)
    expect(limiter.consume(7)).toBe(60)
  })

  it('evicts expired owners but never drops live debt when its bounded table fills', () => {
    let now = 0
    const limiter = new McpOwnerRateLimiter(1, 10_000, 2, () => now)
    expect(limiter.consume(1)).toBe(0)
    now = 2_000
    expect(limiter.consume(2)).toBe(0)
    expect(limiter.consume(3)).toBe(8)
    expect(limiter.consume(1)).toBe(8)
    now = 10_000
    expect(limiter.consume(3)).toBe(0)
    expect(limiter.consume(2)).toBe(2)
    expect(limiter.consume(4)).toBe(2)
    now = 12_000
    expect(limiter.consume(4)).toBe(0)
    expect(limiter.consume(3)).toBe(8)
    now = 22_000
    for (let owner = 100; owner < 200; owner++) {
      expect(limiter.consume(owner)).toBe(0)
      now += 10_000
    }
  })
})
