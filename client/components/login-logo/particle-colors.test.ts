import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { updateParticleColors } from './particle-colors'

const toSrgb = (value: number): number => (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055)
const toLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
const seedOpacity = (seed: number): number => {
  const t = Math.min(1, Math.max(0, seed / 65535 / 0.94))
  return 0.66 + (0.94 - 0.66) * t * t * (3 - 2 * t)
}
const color = (rgba: number[], seed = 65535): Float32Array => {
  const target = new Float32Array(4)
  updateParticleColors({ count: 1, rgba: new Uint8Array(rgba), seed: new Uint16Array([seed]) }, target)
  return target
}

const roundTripCases = [
  ['black', [0, 0, 0]],
  ['white', [255, 255, 255]],
  ['pale cool', [230, 245, 255]],
  ['warm orange', [255, 128, 32]],
  ['red primary', [255, 0, 0]],
  ['green primary', [0, 255, 0]],
  ['blue primary', [0, 0, 255]],
  ['midgray', [128, 128, 128]],
  ['byte 10 below the EOTF boundary', [10, 10, 10]],
  ['byte 11 above the EOTF boundary', [11, 11, 11]]
] as const

describe('cached particle colors', () => {
  it('round-trips source sRGB channels through the cached linear values and OETF', () => {
    for (const seed of [0, 30000, 65535]) {
      for (const [name, rgb] of roundTripCases) {
        const result = color([...rgb, 255], seed)

        for (let channel = 0; channel < 3; channel += 1) {
          const sourceSrgb = rgb[channel]! / 255
          expect(result[channel], `${name} channel ${channel} linear value`).toBeCloseTo(toLinear(sourceSrgb), 7)
          expect(toSrgb(result[channel]!), `${name} channel ${channel} OETF round-trip`).toBeCloseTo(sourceSrgb, 6)
        }
      }
    }
  })

  it('scales alpha independently for opaque, partial, faint, and transparent source pixels', () => {
    const rgb = [245, 240, 235]
    const opaque = color([...rgb, 255])
    const expectedOpacity = seedOpacity(65535)

    for (const alpha of [255, 128, 16, 0]) {
      const result = color([...rgb, alpha])

      expect(Array.from(result.slice(0, 3))).toEqual(Array.from(opaque.slice(0, 3)))
      expect(result[3]).toBeCloseTo(Math.fround((alpha / 255) * expectedOpacity), 7)
    }
  })

  it('reuses a caller-provided target without mutating source bytes or seeds', () => {
    const rgba = new Uint8Array([230, 245, 255, 128, 255, 128, 10, 0])
    const seed = new Uint16Array([0, 65535])
    const source = { count: 2, rgba, seed }
    const originalRgba = rgba.slice()
    const originalSeed = seed.slice()
    const target = new Float32Array(8)
    const expected = new Float32Array([...color([230, 245, 255, 128], 0), ...color([255, 128, 10, 0], 65535)])

    target.fill(Number.NaN)
    updateParticleColors(source, target)
    expect(target).toEqual(expected)

    target.fill(-1)
    updateParticleColors(source, target)
    expect(target).toEqual(expected)
    expect(rgba).toEqual(originalRgba)
    expect(seed).toEqual(originalSeed)
  })
})
