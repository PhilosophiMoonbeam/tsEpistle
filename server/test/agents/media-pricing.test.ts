import { describe, expect, it } from '../bun-test.mts'
import { agentVideoCostMicros } from '../../agents/providers/media-pricing.ts'
const pricing = { revision: 'omni-v1', inputMicrosPerMillionTokens: 1500000, outputMicrosPerMillionTokens: 17500000, textOutputMicrosPerMillionTokens: 9000000 }
const usage = { inputTokens: 100, outputTokens: 1000, totalTokens: 1200 }
describe('video modality pricing', () => {
  it('uses exact complete modality receipts and the maximum rate for residuals', () => {
    expect(agentVideoCostMicros(pricing, usage, { text: 100, video: 900 })).toBe(18550)
    expect(agentVideoCostMicros(pricing, usage)).toBe(19400)
  })
  it('rejects inconsistent counts and unsafe rates instead of undercharging', () => {
    expect(() => agentVideoCostMicros(pricing, usage, { text: 10, video: 900 })).toThrow()
    expect(() => agentVideoCostMicros({ ...pricing, textOutputMicrosPerMillionTokens: -1 }, usage)).toThrow()
    expect(() => agentVideoCostMicros(pricing, { ...usage, totalTokens: 1 })).toThrow()
    expect(() =>
      agentVideoCostMicros(
        { ...pricing, outputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER },
        { inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER }
      )
    ).toThrow()
  })
})
