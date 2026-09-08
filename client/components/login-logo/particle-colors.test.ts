import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { updateParticleColors } from './particle-colors'

const toSrgb = (value: number): number => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
const toLinear = (value: number): number => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
const color = (rgba: number[], seed = 65535, background = { r: 1, g: 1, b: 1 }): Float32Array => {
  const target = new Float32Array(4)
  updateParticleColors({ count: 1, rgba: new Uint8Array(rgba), seed: new Uint16Array([seed]) }, background, target)
  return target
}

describe('cached particle colors', () => {
  it('gives pale cores three-to-one light contrast while preserving their source hue', () => {
    for (const seed of [0, 30000, 65535]) {
      const result = color([230, 245, 255, 255], seed)
      const alpha = result[3]!
      const rgb = Array.from(result.slice(0, 3), toSrgb)
      const displayed = rgb.map(value => toLinear(value * alpha + 1 - alpha))
      const luminance = displayed[0]! * 0.2126 + displayed[1]! * 0.7152 + displayed[2]! * 0.0722
      const contrast = 1.05 / (luminance + 0.05)
      expect(contrast).toBeGreaterThanOrEqual(3)
      expect(contrast).toBeLessThan(3.1)
      expect(rgb[0]! / rgb[2]!).toBeCloseTo(230 / 255, 6)
      expect(rgb[1]! / rgb[2]!).toBeCloseTo(245 / 255, 6)
    }
  })

  it('keeps saturated colors with sufficient contrast and the full opacity range', () => {
    expect(Array.from(color([0, 0, 255, 255]))).toEqual([0, 0, 1, Math.fround(0.94)])
    expect(color([0, 0, 255, 255], 0)[3]).toBe(Math.fround(0.66))
  })

  it('retains partial source alpha and bounds unattainable contrast without becoming opaque', () => {
    const partial = color([255, 255, 255, 128])
    expect(partial[3]).toBeCloseTo(128 / 255 * 0.94, 7)
    const translucent = color([255, 255, 255, 16])
    expect(Array.from(translucent.slice(0, 3))).toEqual([0, 0, 0])
    expect(translucent[3]).toBeCloseTo(16 / 255 * 0.94, 7)
    expect(Array.from(color([255, 255, 255, 0]))).toEqual([0, 0, 0, 0])
  })

  it('preserves luminous dark-surface tint and the original luminance branch boundary', () => {
    const blackSurface = { r: 0, g: 0, b: 0 }
    expect(Array.from(color([0, 0, 0, 255], 65535, blackSurface))).toEqual([
      Math.fround(0.68 * 0.52), Math.fround(0.76 * 0.52), Math.fround(0.82 * 0.52), Math.fround(0.94)
    ])
    expect(Array.from(color([255, 255, 255, 255], 65535, blackSurface))).toEqual([1, 1, 1, Math.fround(0.94)])
    const boundary = color([255, 255, 255, 255], 65535, { r: 0.35, g: 0.35, b: 0.35 })
    const light = color([255, 255, 255, 255], 65535, { r: 0.35001, g: 0.35001, b: 0.35001 })
    expect(boundary[0]).toBeGreaterThan(0.9)
    expect(light[0]).toBeLessThan(0.1)
  })

  it('fills an existing cache without mutating any source data and can restore an earlier theme', () => {
    const rgba = new Uint8Array([230, 245, 255, 255, 0, 0, 255, 128])
    const seed = new Uint16Array([0, 65535])
    const source = { count: 2, rgba, seed }
    const original = rgba.slice()
    const cache = new Float32Array(8)
    updateParticleColors(source, { r: 1, g: 1, b: 1 }, cache)
    const light = cache.slice()
    updateParticleColors(source, { r: 0, g: 0, b: 0 }, cache)
    expect(cache).not.toEqual(light)
    updateParticleColors(source, { r: 1, g: 1, b: 1 }, cache)
    expect(cache).toEqual(light)
    expect(rgba).toEqual(original)
    expect(seed).toEqual(new Uint16Array([0, 65535]))
  })
})
