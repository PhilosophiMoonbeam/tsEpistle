import type { LogoEffectDescriptor } from '../../../shared/site-logo.ts'

export type { LogoEffectDescriptor } from '../../../shared/site-logo.ts'

export interface ParsedLogoParticles {
  /** The exact fetched buffer. All attribute views below share this storage. */
  readonly buffer: ArrayBuffer
  readonly width: number
  readonly height: number
  readonly count: number
  /** Signed normalized XY pairs, suitable for an item-size 2 normalized attribute. */
  readonly xy: Int16Array
  /** Signed normalized depth values, suitable for an item-size 1 normalized attribute. */
  readonly depth: Int8Array
  /** Straight-alpha sRGB colors, suitable for an item-size 4 normalized attribute. */
  readonly rgba: Uint8Array
  /** Encoded particle sizes in the inclusive range 1..255. */
  readonly size: Uint8Array
  /** Encoded deterministic seeds in the inclusive range 1..65535. */
  readonly seed: Uint16Array
}

export const PARTICLE_V1_MAX_BYTES = 192_056
export const PARTICLE_ATTRIBUTE_ITEM_SIZES = Object.freeze({
  xy: 2,
  depth: 1,
  rgba: 4,
  size: 1,
  seed: 1
} as const)

const PARTICLE_HEADER_BYTES = 56
const PARTICLE_BYTES_PER_RECORD = 12
const PARTICLE_V1_FLAGS = 0x07
const MAX_DIMENSION = 4096
const MAX_PARTICLES = 16_000
const MAX_PAYLOAD_BYTES = 192_000

let crcTable: Uint32Array | undefined

const getCrcTable = (): Uint32Array => {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  crcTable = table
  return table
}

const crc32 = (bytes: Uint8Array): number => {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const value of bytes) crc = (crc >>> 8) ^ table[(crc ^ value) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}

const invalidParticleData = (): never => {
  throw new Error('Invalid particle logo data')
}

const isNativeLittleEndian = (): boolean => {
  const word = new Uint16Array(1)
  word[0] = 1
  return new Uint8Array(word.buffer)[0] === 1
}

const LOGO_URL_PATTERN = /^\/_site-logo\/[0-9a-f]{64}\/logo\.png$/
const PARTICLE_URL_PATTERN = /^\/_site-logo\/[0-9a-f]{64}\/particle\.bin$/
const STATIC_URL_PATTERN = /^\/_site-logo\/[0-9a-f]{64}\/effect\.png$/
const AURA_COLOR_PATTERN = /^#[0-9a-f]{6}$/
const REQUIRED_KEYS = ['logoUrl', 'particleUrl', 'staticUrl', 'width', 'height', 'aspect', 'count', 'medianStroke'] as const
const ALLOWED_KEYS: Record<string, true> = Object.fromEntries([...REQUIRED_KEYS, 'auraColor'].map(key => [key, true]))

const isIntegerInRange = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum

export function isLogoEffectDescriptor(value: unknown): value is LogoEffectDescriptor {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false

  const descriptor = value as Record<string, unknown>
  const keys = Object.keys(descriptor)
  if (REQUIRED_KEYS.some(key => !Object.hasOwn(descriptor, key))) return false
  if (keys.some(key => ALLOWED_KEYS[key] !== true)) return false
  if (
    typeof descriptor.logoUrl !== 'string' ||
    !LOGO_URL_PATTERN.test(descriptor.logoUrl) ||
    typeof descriptor.particleUrl !== 'string' ||
    !PARTICLE_URL_PATTERN.test(descriptor.particleUrl) ||
    typeof descriptor.staticUrl !== 'string' ||
    !STATIC_URL_PATTERN.test(descriptor.staticUrl) ||
    !isIntegerInRange(descriptor.width, 2, 4096) ||
    !isIntegerInRange(descriptor.height, 2, 4096) ||
    !isIntegerInRange(descriptor.count, 1, 16_000) ||
    typeof descriptor.aspect !== 'number' ||
    !Number.isFinite(descriptor.aspect) ||
    descriptor.aspect !== descriptor.width / descriptor.height ||
    typeof descriptor.medianStroke !== 'number' ||
    !Number.isFinite(descriptor.medianStroke) ||
    descriptor.medianStroke <= 0 ||
    descriptor.medianStroke > Math.max(descriptor.width, descriptor.height)
  )
    return false

  return !Object.hasOwn(descriptor, 'auraColor') || (typeof descriptor.auraColor === 'string' && AURA_COLOR_PATTERN.test(descriptor.auraColor))
}

export function parseParticleV1(buffer: ArrayBuffer, descriptor: LogoEffectDescriptor): ParsedLogoParticles {
  if (!isLogoEffectDescriptor(descriptor) || !isNativeLittleEndian()) invalidParticleData()

  const [bytes, header] = ((): readonly [Uint8Array, DataView] => {
    try {
      return [new Uint8Array(buffer), new DataView(buffer)]
    } catch {
      return invalidParticleData()
    }
  })()

  if (bytes.byteLength < PARTICLE_HEADER_BYTES || bytes.byteLength > PARTICLE_V1_MAX_BYTES) invalidParticleData()
  if (
    bytes[0] !== 0x54 ||
    bytes[1] !== 0x53 ||
    bytes[2] !== 0x45 ||
    bytes[3] !== 0x50 ||
    bytes[4] !== 1 ||
    bytes[5] !== PARTICLE_V1_FLAGS ||
    header.getUint16(6, true) !== PARTICLE_HEADER_BYTES
  )
    invalidParticleData()

  const width = header.getUint32(8, true)
  const height = header.getUint32(12, true)
  const count = header.getUint32(16, true)
  if (
    width < 2 ||
    width > MAX_DIMENSION ||
    height < 2 ||
    height > MAX_DIMENSION ||
    count < 1 ||
    count > MAX_PARTICLES ||
    width !== descriptor.width ||
    height !== descriptor.height ||
    count !== descriptor.count
  )
    invalidParticleData()

  const payloadLength = PARTICLE_BYTES_PER_RECORD * count
  const xyOffset = PARTICLE_HEADER_BYTES
  const depthOffset = xyOffset + 4 * count
  const rgbaOffset = depthOffset + count
  const sizeOffset = rgbaOffset + 4 * count
  const seedOffset = sizeOffset + count
  const fileLength = seedOffset + 2 * count
  if (
    !Number.isSafeInteger(payloadLength) ||
    !Number.isSafeInteger(fileLength) ||
    payloadLength > MAX_PAYLOAD_BYTES ||
    fileLength > PARTICLE_V1_MAX_BYTES ||
    header.getUint32(20, true) !== payloadLength ||
    header.getUint32(28, true) !== xyOffset ||
    header.getUint32(32, true) !== depthOffset ||
    header.getUint32(36, true) !== rgbaOffset ||
    header.getUint32(40, true) !== sizeOffset ||
    header.getUint32(44, true) !== seedOffset ||
    header.getUint32(48, true) !== fileLength ||
    header.getUint32(52, true) !== 0 ||
    bytes.byteLength !== fileLength ||
    header.getUint32(24, true) !== crc32(bytes.subarray(PARTICLE_HEADER_BYTES))
  )
    invalidParticleData()

  const xy = new Int16Array(buffer, xyOffset, PARTICLE_ATTRIBUTE_ITEM_SIZES.xy * count)
  const depth = new Int8Array(buffer, depthOffset, count)
  const rgba = new Uint8Array(buffer, rgbaOffset, PARTICLE_ATTRIBUTE_ITEM_SIZES.rgba * count)
  const size = new Uint8Array(buffer, sizeOffset, count)
  const seed = new Uint16Array(buffer, seedOffset, count)

  for (const coordinate of xy) if (coordinate === -32_768) invalidParticleData()
  for (const value of depth) if (value === -128) invalidParticleData()
  for (let index = 3; index < rgba.length; index += PARTICLE_ATTRIBUTE_ITEM_SIZES.rgba) if (rgba[index] === 0) invalidParticleData()
  for (const value of size) if (value === 0) invalidParticleData()
  for (const value of seed) if (value === 0) invalidParticleData()

  return Object.freeze({ buffer, width, height, count, xy, depth, rgba, size, seed })
}
