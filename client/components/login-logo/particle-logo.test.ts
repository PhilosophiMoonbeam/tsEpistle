import { describe, expect, it } from '../../../server/test/bun-test.mts'
import type { LogoEffectDescriptor } from '../../../shared/site-logo.ts'
import { PARTICLE_ATTRIBUTE_ITEM_SIZES, PARTICLE_V1_MAX_BYTES, parseParticleV1 } from './particle-logo.ts'

const VECTOR_HEX =
  '545345500107380008000000080000000200000018000000cf8f46fd3800000040000000420000004a0000004c000000500000000000000025c94912db36b7eded4ddc283cc81e6edca05578d20431d4'
const HASH = '0'.repeat(64)
const descriptor: LogoEffectDescriptor = {
  logoUrl: `/_site-logo/${HASH}/logo.png`,
  particleUrl: `/_site-logo/${HASH}/particle.bin`,
  staticUrl: `/_site-logo/${HASH}/effect.png`,
  width: 8,
  height: 8,
  aspect: 1,
  count: 2,
  medianStroke: 2
}

const vector = (): ArrayBuffer => {
  const bytes = new Uint8Array(VECTOR_HEX.length / 2)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(VECTOR_HEX.slice(2 * index, 2 * index + 2), 16)
  return bytes.buffer
}

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const replacePayloadCrc = (buffer: ArrayBuffer): void => {
  const bytes = new Uint8Array(buffer)
  new DataView(buffer).setUint32(24, crc32(bytes.subarray(56)), true)
}

const withHeaderValue = (offset: number, value: number, size: 1 | 2 | 4 = 4): ArrayBuffer => {
  const buffer = vector()
  const view = new DataView(buffer)
  if (size === 1) view.setUint8(offset, value)
  else if (size === 2) view.setUint16(offset, value, true)
  else view.setUint32(offset, value, true)
  return buffer
}

const invalidDescriptor = (change: Partial<LogoEffectDescriptor>): LogoEffectDescriptor => ({ ...descriptor, ...change })

const expectInvalid = (buffer: ArrayBuffer, effect: LogoEffectDescriptor = descriptor): void => {
  expect(() => parseParticleV1(buffer, effect)).toThrow('Invalid particle logo data')
}

describe('particle-v1 browser parser', () => {
  it('parses the deterministic v1 vector into zero-copy SoA attribute views', () => {
    const source = vector()
    const before = new Uint8Array(source).slice()

    const parsed = parseParticleV1(source, descriptor)

    expect(parsed.buffer).toBe(source)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect({ width: parsed.width, height: parsed.height, count: parsed.count }).toEqual({ width: 8, height: 8, count: 2 })
    expect(Array.from(parsed.xy)).toEqual([-14_043, 4_681, 14_043, -4_681])
    expect(Array.from(parsed.depth)).toEqual([-19, 77])
    expect(Array.from(parsed.rgba)).toEqual([220, 40, 60, 200, 30, 110, 220, 160])
    expect(Array.from(parsed.size)).toEqual([85, 120])
    expect(Array.from(parsed.seed)).toEqual([1_234, 54_321])
    expect(PARTICLE_ATTRIBUTE_ITEM_SIZES).toEqual({ xy: 2, depth: 1, rgba: 4, size: 1, seed: 1 })
    expect([parsed.xy.byteOffset, parsed.depth.byteOffset, parsed.rgba.byteOffset, parsed.size.byteOffset, parsed.seed.byteOffset]).toEqual([
      56, 64, 66, 74, 76
    ])
    for (const view of [parsed.xy, parsed.depth, parsed.rgba, parsed.size, parsed.seed]) expect(view.buffer).toBe(source)
    expect(new Uint8Array(source)).toEqual(before)
  })

  it('rejects truncated, trailing, and over-limit inputs', () => {
    const valid = vector()
    expectInvalid(valid.slice(0, 55))
    expectInvalid(valid.slice(0, valid.byteLength - 1))
    const trailing = new Uint8Array(valid.byteLength + 1)
    trailing.set(new Uint8Array(valid))
    expectInvalid(trailing.buffer)
    expectInvalid(new ArrayBuffer(PARTICLE_V1_MAX_BYTES + 1))
  })

  it('rejects every fixed header and block-layout mismatch', () => {
    const malformed = [
      withHeaderValue(0, 0, 1),
      withHeaderValue(4, 2, 1),
      withHeaderValue(5, 0x03, 1),
      withHeaderValue(5, 0x0f, 1),
      withHeaderValue(6, 55, 2),
      withHeaderValue(8, 1),
      withHeaderValue(12, 4097),
      withHeaderValue(16, 0),
      withHeaderValue(16, 16_001),
      withHeaderValue(20, 23),
      withHeaderValue(28, 57),
      withHeaderValue(32, 63),
      withHeaderValue(36, 67),
      withHeaderValue(40, 73),
      withHeaderValue(44, 75),
      withHeaderValue(48, 81),
      withHeaderValue(52, 1)
    ]
    for (const buffer of malformed) expectInvalid(buffer)
  })

  it('rejects payload corruption through CRC-32/ISO-HDLC', () => {
    const corrupt = vector()
    new Uint8Array(corrupt)[60] ^= 0xff
    expectInvalid(corrupt)
  })

  it('rejects descriptor dimension, count, and finite-range mismatches', () => {
    for (const effect of [
      invalidDescriptor({ width: 9, aspect: 9 / 8 }),
      invalidDescriptor({ height: 9, aspect: 8 / 9 }),
      invalidDescriptor({ count: 3 }),
      invalidDescriptor({ aspect: Number.NaN }),
      invalidDescriptor({ medianStroke: Number.POSITIVE_INFINITY })
    ])
      expectInvalid(vector(), effect)
  })

  it('rejects every record sentinel after a valid CRC', () => {
    const sentinels: readonly [number, (view: DataView, offset: number) => void][] = [
      [56, (view, offset) => view.setInt16(offset, -32_768, true)],
      [58, (view, offset) => view.setInt16(offset, -32_768, true)],
      [64, (view, offset) => view.setInt8(offset, -128)],
      [69, (view, offset) => view.setUint8(offset, 0)],
      [74, (view, offset) => view.setUint8(offset, 0)],
      [76, (view, offset) => view.setUint16(offset, 0, true)]
    ]
    for (const [offset, write] of sentinels) {
      const source = vector()
      write(new DataView(source), offset)
      replacePayloadCrc(source)
      const before = new Uint8Array(source).slice()
      expectInvalid(source)
      expect(new Uint8Array(source)).toEqual(before)
    }
  })
})
