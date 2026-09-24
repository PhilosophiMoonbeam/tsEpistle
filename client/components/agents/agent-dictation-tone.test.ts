import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { DICTATION_LOUD_DBFS, DICTATION_WARN_DBFS, dictationTone } from './agent-dictation-tone.ts'

describe('dictation tone thresholds', () => {
  it('keeps silent bars neutral', () => {
    expect(dictationTone(0, -96)).toBe('neutral')
    expect(dictationTone(0.05, -30)).toBe('neutral')
  })

  it('colors comfortable speech green', () => {
    expect(dictationTone(0.4, DICTATION_WARN_DBFS - 6)).toBe('safe')
  })

  it('colors approaching-loud speech yellow', () => {
    expect(dictationTone(0.5, DICTATION_WARN_DBFS)).toBe('warn')
    expect(dictationTone(0.7, DICTATION_LOUD_DBFS - 1)).toBe('warn')
  })

  it('colors near-clipping audio red', () => {
    expect(dictationTone(0.9, DICTATION_LOUD_DBFS)).toBe('loud')
    expect(dictationTone(1, -3)).toBe('loud')
  })

  it('falls back to level thresholds without a dB source', () => {
    expect(dictationTone(0.4, Number.NaN)).toBe('warn')
    expect(dictationTone(1, Number.NaN)).toBe('loud')
    expect(dictationTone(0.2, Number.NaN)).toBe('safe')
  })
})
