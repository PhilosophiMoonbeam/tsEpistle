import { describe, expect, it } from '../../../server/test/bun-test.mts'
import {
  addExplosionDisplacement,
  explosionEnvelope,
  LOGO_POINTER_EXPLOSION_HOLD_SECONDS,
  LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS,
  LOGO_POINTER_EXPLOSION_MAX_SCALE,
  LOGO_POINTER_EXPLOSION_MIN_SCALE,
  LOGO_POINTER_EXPLOSION_RECOVERY_END_SECONDS
} from './particle-explosion'

const displacement = (scale: number, baseX: number, baseY: number): Float32Array => {
  const output = new Float32Array(2)
  addExplosionDisplacement(output, 0, baseX, baseY, 0, 0, 800, 800, 800, 0.25, 0.2, scale, 0.8)
  return output
}

const magnitude = (value: Float32Array): number => Math.hypot(value[0]!, value[1]!)

describe('particle explosion envelope', () => {
  it('has bounded analytic endpoints, a monotone recovery tail, and a zero tail', () => {
    expect(explosionEnvelope(Number.NaN)).toBe(0)
    expect(explosionEnvelope(-1)).toBe(0)
    expect(explosionEnvelope(0)).toBe(0)
    expect(explosionEnvelope(LOGO_POINTER_EXPLOSION_HOLD_SECONDS)).toBeCloseTo(1, 12)

    let previous = explosionEnvelope(LOGO_POINTER_EXPLOSION_HOLD_SECONDS)
    for (const age of [LOGO_POINTER_EXPLOSION_HOLD_SECONDS + 0.000001, 0.5, 0.8, 1.2, 1.8, 2.4, LOGO_POINTER_EXPLOSION_RECOVERY_END_SECONDS - 0.000001]) {
      const value = explosionEnvelope(age)
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(previous)
      previous = value
    }

    expect(explosionEnvelope(LOGO_POINTER_EXPLOSION_RECOVERY_END_SECONDS)).toBe(0)
    expect(explosionEnvelope(LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS)).toBe(0)
    expect(explosionEnvelope(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('regularizes the radial center without producing non-finite displacement', () => {
    const output = new Float32Array([3, -4])
    addExplosionDisplacement(output, 0, 0, 0, 0, 0, 800, 600, 800, 0, 0.2, 1.2, 0.8)
    expect(output).toEqual(new Float32Array([3, -4]))

    const nearCenter = displacement(1, 0.000001, -0.000001)
    expect(nearCenter.every(Number.isFinite)).toBe(true)
  })

  it('adds overlapping slots and lets a larger scale reach a farther particle', () => {
    const one = displacement(1, 40, 20)
    const overlap = new Float32Array(2)
    addExplosionDisplacement(overlap, 0, 40, 20, 0, 0, 800, 800, 800, 0.25, 0.2, 1, 0.8)
    addExplosionDisplacement(overlap, 0, 40, 20, 0, 0, 800, 800, 800, 0.25, 0.2, 1, 0.8)
    expect(overlap[0]).toBeCloseTo(one[0]! * 2, 5)
    expect(overlap[1]).toBeCloseTo(one[1]! * 2, 5)

    const small = displacement(LOGO_POINTER_EXPLOSION_MIN_SCALE, 250, 0)
    const large = displacement(LOGO_POINTER_EXPLOSION_MAX_SCALE, 250, 0)
    expect(magnitude(small)).toBe(0)
    expect(magnitude(large)).toBeGreaterThan(0)
  })
})
