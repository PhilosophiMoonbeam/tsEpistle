import { createHash } from 'node:crypto'
import { deflateSync, gzipSync } from 'node:zlib'
import sharp, { type Metadata } from 'sharp'

export const SITE_LOGO_PIPELINE_VERSION = 4

export const SITE_LOGO_SOURCE_BYTE_LIMIT = 5_242_880
export const SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT = 192_056
export const SITE_LOGO_PARTICLE_GZIP_BYTE_LIMIT = 176 * 1024
export const SITE_LOGO_PNG_BYTE_LIMIT = 512 * 1024
export const SITE_LOGO_STATIC_PNG_BYTE_LIMIT = 1024 * 1024

const MAX_INPUT_PIXELS = 16_777_216
const MAX_INPUT_DIMENSION = 4096
const MIN_INPUT_DIMENSION = 64
const MAX_PARTICLES = 16_000
const MAX_GENERATED_PARTICLES = 4_000
const MIN_GENERATED_PARTICLES = 1_000
const RESERVED_PARTICLES_PER_COMPONENT = 4
const PARTICLE_HEADER_BYTES = 56
const PARTICLE_BYTES = 12
const MIN_RECONSTRUCTED_MASK_IOU = 0.75
const PARTICLE_FLAGS = 0x07
const PARTICLE_REFERENCE_LONG_AXIS = 1024
const PARTICLE_PADDING_RATIO = 0.04
const MAX_NORMALIZED_LONG_AXIS = PARTICLE_REFERENCE_LONG_AXIS + 2 * Math.round(PARTICLE_PADDING_RATIO * PARTICLE_REFERENCE_LONG_AXIS)
const MAX_RASTERIZED_CORE_SCALE = MAX_NORMALIZED_LONG_AXIS / PARTICLE_REFERENCE_LONG_AXIS
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const
const SQRT_32 = Math.sqrt(32)
const UINT64_SCALE = 2 ** 64

export type SiteLogoProcessingErrorCode =
  | 'UNSUPPORTED_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'INVALID_IMAGE'
  | 'NO_VISIBLE_PIXELS'
  | 'UNSUITABLE_LOGO'
  | 'PROCESSING_FAILED'
  | 'ARTIFACT_TOO_LARGE'

export class SiteLogoProcessingError extends Error {
  readonly code: SiteLogoProcessingErrorCode

  constructor(code: SiteLogoProcessingErrorCode, message = code) {
    super(message)
    this.name = 'SiteLogoProcessingError'
    this.code = code
  }
}

export interface SiteLogoArtifacts {
  readonly logoPng: Buffer
  readonly particleV1: Buffer
  readonly effectStaticPng: Buffer
  readonly normalizedWidth: number
  readonly normalizedHeight: number
  readonly particleCount: number
  readonly medianStroke: number
  readonly auraColor?: string
}

export interface RgbaRaster {
  readonly width: number
  readonly height: number
  readonly data: Buffer
}

export interface ParticleRecord {
  readonly sourceIndex: number
  readonly x: number
  readonly y: number
  readonly xEncoded: number
  readonly yEncoded: number
  readonly depth: number
  readonly rgba: readonly [number, number, number, number]
  readonly size: number
  readonly seed: number
}

export interface ParsedParticleV1 {
  readonly width: number
  readonly height: number
  readonly count: number
  readonly records: readonly ParticleRecord[]
}

interface Oklab {
  readonly l: number
  readonly a: number
  readonly b: number
}

interface HeapEntry {
  readonly priority: number
  readonly index: number
}

interface Component {
  readonly label: number
  readonly indices: readonly number[]
  readonly alphaMass: number
}

const fail = (code: SiteLogoProcessingErrorCode): never => {
  throw new SiteLogoProcessingError(code)
}

export const roundHalfAwayFromZero = (value: number): number => (value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5))

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value))
const byte = (value: number): number => clamp(roundHalfAwayFromZero(value), 0, 255)

const srgbToLinear = (value: number): number => {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

const linearToSrgbByte = (value: number): number => {
  const channel = clamp(value, 0, 1)
  return byte(255 * (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055))
}

export const rgbaToOklab = (r: number, g: number, b: number): Oklab => {
  const red = srgbToLinear(r)
  const green = srgbToLinear(g)
  const blue = srgbToLinear(b)
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  }
}

const oklabDistance = (left: Oklab, right: Oklab): number => Math.hypot(left.l - right.l, left.a - right.a, left.b - right.b)

const weightedMedian = (values: readonly { value: number; weight: number }[]): number => {
  const ordered = [...values].sort((left, right) => left.value - right.value)
  const total = ordered.reduce((sum, item) => sum + item.weight, 0)
  let cumulative = 0
  for (const item of ordered) {
    cumulative += item.weight
    if (cumulative * 2 >= total) return item.value
  }
  return ordered.at(-1)?.value ?? 0
}

const inputFormat = (bytes: Buffer): 'png' | 'jpeg' | 'webp' => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8
    let sawHeader = false
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset)
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (type === 'acTL') return fail('UNSUPPORTED_IMAGE')
      const end = offset + 12 + length
      if (end > bytes.length) return fail('INVALID_IMAGE')
      if (!sawHeader && type !== 'IHDR') return fail('INVALID_IMAGE')
      sawHeader = true
      if (type === 'IEND') {
        if (length !== 0 || end !== bytes.length) return fail('INVALID_IMAGE')
        return 'png'
      }
      offset = end
    }
    return fail('INVALID_IMAGE')
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return fail('INVALID_IMAGE')
    return 'jpeg'
  }

  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString('ascii', offset, offset + 4)
      const length = bytes.readUInt32LE(offset + 4)
      if (type === 'ANIM' || type === 'ANMF') return fail('UNSUPPORTED_IMAGE')
      if (type === 'VP8X' && length >= 1 && (bytes[offset + 8]! & 0x02) !== 0) return fail('UNSUPPORTED_IMAGE')
      offset += 8 + length + (length & 1)
      if (offset > bytes.length) return fail('INVALID_IMAGE')
    }
    if (offset !== bytes.length || bytes.readUInt32LE(4) + 8 !== bytes.length) return fail('INVALID_IMAGE')
    return 'webp'
  }

  return fail('UNSUPPORTED_IMAGE')
}

const validateMetadata = (metadata: Metadata, format: 'png' | 'jpeg' | 'webp'): void => {
  if (metadata.format !== format) fail('INVALID_IMAGE')
  const pages = metadata.pages ?? 1
  if (pages !== 1) fail('UNSUPPORTED_IMAGE')
  if (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height) fail('UNSUPPORTED_IMAGE')
  if (metadata.channels !== undefined && metadata.channels > 4) fail('INVALID_IMAGE')
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS) fail('IMAGE_TOO_LARGE')
}

const decodeSource = async (bytes: Buffer): Promise<{ raster: RgbaRaster; hasNativeAlpha: boolean }> => {
  const format = inputFormat(bytes)
  const options = {
    failOn: 'warning' as const,
    limitInputPixels: MAX_INPUT_PIXELS,
    limitInputChannels: 4,
    unlimited: false,
    autoOrient: true
  }

  let metadata: Metadata
  try {
    metadata = await sharp(bytes, options).metadata()
    validateMetadata(metadata, format)
    const decoded = await sharp(bytes, options).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    if (
      decoded.info.channels !== 4 ||
      decoded.info.width < MIN_INPUT_DIMENSION ||
      decoded.info.width > MAX_INPUT_DIMENSION ||
      decoded.info.height < MIN_INPUT_DIMENSION ||
      decoded.info.height > MAX_INPUT_DIMENSION ||
      decoded.info.width * decoded.info.height > MAX_INPUT_PIXELS ||
      decoded.data.length !== decoded.info.width * decoded.info.height * 4
    )
      fail('INVALID_IMAGE')
    return {
      raster: { width: decoded.info.width, height: decoded.info.height, data: Buffer.from(decoded.data) },
      hasNativeAlpha: metadata.hasAlpha === true
    }
  } catch (error: unknown) {
    if (error instanceof SiteLogoProcessingError) throw error
    if (error instanceof Error && error.message === 'Input image exceeds pixel limit') fail('IMAGE_TOO_LARGE')
    return fail('INVALID_IMAGE')
  }
}

const borderIndices = (width: number, height: number, band: number): number[] => {
  const result: number[] = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < band || x >= width - band || y < band || y >= height - band) result.push(y * width + x)
    }
  }
  return result
}

const pixelLab = (data: Buffer, index: number): Oklab => {
  const offset = index * 4
  return rgbaToOklab(data[offset]!, data[offset + 1]!, data[offset + 2]!)
}

const neighbors8 = (index: number, width: number, height: number, visit: (neighbor: number) => void): void => {
  const x = index % width
  const y = Math.floor(index / width)
  for (let dy = -1; dy <= 1; dy += 1) {
    const nextY = y + dy
    if (nextY < 0 || nextY >= height) continue
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue
      const nextX = x + dx
      if (nextX >= 0 && nextX < width) visit(nextY * width + nextX)
    }
  }
}

const labelMaskedAlphaComponents = (data: Buffer, width: number, height: number, mask: Uint8Array): { labels: Int32Array; alphaMasses: number[] } => {
  const labels = new Int32Array(width * height)
  labels.fill(-1)
  const alphaMasses: number[] = []
  const queue = new Int32Array(width * height)
  for (let start = 0; start < width * height; start += 1) {
    if (labels[start] !== -1 || !mask[start] || data[start * 4 + 3] === 0) continue
    const label = alphaMasses.length
    let read = 0
    let write = 1
    let alphaMass = 0
    queue[0] = start
    labels[start] = label
    while (read < write) {
      const index = queue[read++]!
      alphaMass += data[index * 4 + 3]!
      neighbors8(index, width, height, neighbor => {
        if (labels[neighbor] === -1 && mask[neighbor] && data[neighbor * 4 + 3] !== 0) {
          labels[neighbor] = label
          queue[write++] = neighbor
        }
      })
    }
    alphaMasses.push(alphaMass)
  }
  return { labels, alphaMasses }
}

export const removeNeutralMatte = (raster: RgbaRaster, hasNativeAlpha: boolean): RgbaRaster => {
  if (hasNativeAlpha) return { ...raster, data: Buffer.from(raster.data) }
  const { width, height } = raster
  const data = Buffer.from(raster.data)
  const band = clamp(roundHalfAwayFromZero(0.03 * Math.min(width, height)), 2, 24)
  const border = borderIndices(width, height, band)
  const qualifying = border
    .map(index => ({ index, lab: pixelLab(data, index), weight: data[index * 4 + 3]! / 255 }))
    .filter(item => Math.hypot(item.lab.a, item.lab.b) <= 0.03 && item.weight > 0)
  if (qualifying.length === 0) return { width, height, data }

  const matte: Oklab = {
    l: weightedMedian(qualifying.map(item => ({ value: item.lab.l, weight: item.weight }))),
    a: weightedMedian(qualifying.map(item => ({ value: item.lab.a, weight: item.weight }))),
    b: weightedMedian(qualifying.map(item => ({ value: item.lab.b, weight: item.weight })))
  }
  const distances = new Float32Array(width * height)
  for (let index = 0; index < distances.length; index += 1) distances[index] = oklabDistance(pixelLab(data, index), matte)

  const connectedCore = new Uint8Array(width * height)
  const featherConnected = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let read = 0
  let write = 0
  const seed = (index: number): void => {
    if (!featherConnected[index] && distances[index]! < 0.07) {
      featherConnected[index] = 1
      queue[write++] = index
    }
  }
  for (let x = 0; x < width; x += 1) {
    seed(x)
    seed((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    seed(y * width)
    seed(y * width + width - 1)
  }
  while (read < write) {
    const index = queue[read++]!
    if (distances[index]! <= 0.035) connectedCore[index] = 1
    neighbors8(index, width, height, neighbor => {
      if (!featherConnected[neighbor] && distances[neighbor]! < 0.07) {
        featherConnected[neighbor] = 1
        queue[write++] = neighbor
      }
    })
  }

  const edgeCoverage = (indices: readonly number[]): number => indices.reduce((count, index) => count + connectedCore[index]!, 0) / indices.length
  const top = Array.from({ length: width }, (_, x) => x)
  const bottom = Array.from({ length: width }, (_, x) => (height - 1) * width + x)
  const left = Array.from({ length: height }, (_, y) => y * width)
  const right = Array.from({ length: height }, (_, y) => y * width + width - 1)
  const totalBorder = [...top, ...bottom, ...left.slice(1, -1), ...right.slice(1, -1)]
  if (edgeCoverage(totalBorder) < 0.85 || edgeCoverage(top) < 0.7 || edgeCoverage(bottom) < 0.7 || edgeCoverage(left) < 0.7 || edgeCoverage(right) < 0.7)
    return { width, height, data }

  const originalTotal = data.reduce((sum, value, offset) => (offset % 4 === 3 ? sum + value : sum), 0)
  const meaningfulThreshold = originalTotal * 0.0025
  const foregroundMask = new Uint8Array(width * height)
  for (let index = 0; index < foregroundMask.length; index += 1) {
    if (distances[index]! > 0.035 && data[index * 4 + 3] !== 0) foregroundMask[index] = 1
  }
  const foregroundComponents = labelMaskedAlphaComponents(data, width, height, foregroundMask)
  const meaningfulForeground = Uint8Array.from(foregroundComponents.alphaMasses, alphaMass => (alphaMass >= meaningfulThreshold ? 1 : 0))
  for (let index = 0; index < featherConnected.length; index += 1) {
    if (!featherConnected[index]) continue
    const distance = distances[index]!
    const scale = distance <= 0.035 ? 0 : clamp((distance - 0.035) / 0.035, 0, 1)
    data[index * 4 + 3] = byte(data[index * 4 + 3]! * scale)
  }
  const retainedAlpha = data.reduce((sum, value, offset) => (offset % 4 === 3 ? sum + value : sum), 0)
  const retainedFraction = retainedAlpha / (255 * width * height)
  if (retainedFraction < 0.02 || retainedFraction > 0.85) fail('UNSUITABLE_LOGO')

  const retainedComponentMasses = new Float64Array(foregroundComponents.alphaMasses.length)
  for (let index = 0; index < foregroundComponents.labels.length; index += 1) {
    const label = foregroundComponents.labels[index]!
    if (label < 0) continue
    const retainedComponentMass = retainedComponentMasses[label] ?? fail('PROCESSING_FAILED')
    const retainedPixelAlpha = data[index * 4 + 3] ?? fail('PROCESSING_FAILED')
    retainedComponentMasses[label] = retainedComponentMass + retainedPixelAlpha
  }
  for (let label = 0; label < meaningfulForeground.length; label += 1) {
    if (meaningfulForeground[label] && retainedComponentMasses[label]! < meaningfulThreshold) fail('UNSUITABLE_LOGO')
  }
  return { width, height, data }
}

export const trimTransparent = (raster: RgbaRaster): RgbaRaster => {
  let left = raster.width
  let top = raster.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (raster.data[(y * raster.width + x) * 4 + 3] === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) fail('NO_VISIBLE_PIXELS')
  const width = right - left + 1
  const height = bottom - top + 1
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    raster.data.copy(data, y * width * 4, ((top + y) * raster.width + left) * 4, ((top + y) * raster.width + left + width) * 4)
  }
  return { width, height, data }
}

const sinc = (value: number): number => (value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value))
const lanczos3 = (value: number): number => (Math.abs(value) < 3 ? sinc(value) * sinc(value / 3) : 0)

const resizeContributions = (sourceSize: number, targetSize: number): ReadonlyArray<ReadonlyArray<{ index: number; weight: number }>> => {
  const scale = targetSize / sourceSize
  const support = scale < 1 ? 3 / scale : 3
  const kernelScale = scale < 1 ? scale : 1
  return Array.from({ length: targetSize }, (_, target) => {
    const center = (target + 0.5) / scale - 0.5
    const first = Math.ceil(center - support)
    const last = Math.floor(center + support)
    const byIndex = new Map<number, number>()
    for (let source = first; source <= last; source += 1) {
      const index = clamp(source, 0, sourceSize - 1)
      const weight = lanczos3((center - source) * kernelScale) * kernelScale
      byIndex.set(index, (byIndex.get(index) ?? 0) + weight)
    }
    const sum = [...byIndex.values()].reduce((total, weight) => total + weight, 0)
    return [...byIndex].map(([index, weight]) => ({ index, weight: weight / sum }))
  })
}

export const resizeLinearPremultiplied = (raster: RgbaRaster, width: number, height: number): RgbaRaster => {
  if (width === raster.width && height === raster.height) return { width, height, data: Buffer.from(raster.data) }
  if (width < 1 || height < 1 || width > raster.width || height > raster.height) fail('PROCESSING_FAILED')
  const horizontal = resizeContributions(raster.width, width)
  const vertical = resizeContributions(raster.height, height)
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let alpha = 0
      let red = 0
      let green = 0
      let blue = 0
      for (const yc of vertical[y]!) {
        for (const xc of horizontal[x]!) {
          const weight = yc.weight * xc.weight
          const offset = (yc.index * raster.width + xc.index) * 4
          const sourceAlpha = raster.data[offset + 3]! / 255
          alpha += weight * sourceAlpha
          red += weight * sourceAlpha * srgbToLinear(raster.data[offset]!)
          green += weight * sourceAlpha * srgbToLinear(raster.data[offset + 1]!)
          blue += weight * sourceAlpha * srgbToLinear(raster.data[offset + 2]!)
        }
      }
      const output = (y * width + x) * 4
      const clampedAlpha = clamp(alpha, 0, 1)
      data[output + 3] = byte(255 * clampedAlpha)
      if (clampedAlpha > 0) {
        data[output] = linearToSrgbByte(red / alpha)
        data[output + 1] = linearToSrgbByte(green / alpha)
        data[output + 2] = linearToSrgbByte(blue / alpha)
      }
    }
  }
  return { width, height, data }
}

export const padRaster = (raster: RgbaRaster, padding: number): RgbaRaster => {
  const width = raster.width + 2 * padding
  const height = raster.height + 2 * padding
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < raster.height; y += 1) {
    raster.data.copy(data, ((y + padding) * width + padding) * 4, y * raster.width * 4, (y + 1) * raster.width * 4)
  }
  return { width, height, data }
}

const findMeaningfulComponents = (raster: RgbaRaster): { components: readonly Component[]; labels: Int32Array; eligible: Int32Array } => {
  const count = raster.width * raster.height
  const labels = new Int32Array(count)
  labels.fill(-1)
  const eligibleValues: number[] = []
  let totalAlpha = 0
  for (let index = 0; index < count; index += 1) {
    const alpha = raster.data[index * 4 + 3]!
    if (alpha > 0) {
      eligibleValues.push(index)
      totalAlpha += alpha
    }
  }
  if (eligibleValues.length < MIN_GENERATED_PARTICLES) fail('UNSUITABLE_LOGO')

  const queue = new Int32Array(count)
  const found: { indices: number[]; alphaMass: number }[] = []
  for (const start of eligibleValues) {
    if (labels[start] !== -1) continue
    const label = found.length
    let read = 0
    let write = 1
    let alphaMass = 0
    const indices: number[] = []
    labels[start] = label
    queue[0] = start
    while (read < write) {
      const index = queue[read++]!
      indices.push(index)
      alphaMass += raster.data[index * 4 + 3]!
      neighbors8(index, raster.width, raster.height, neighbor => {
        if (labels[neighbor] === -1 && raster.data[neighbor * 4 + 3] !== 0) {
          labels[neighbor] = label
          queue[write++] = neighbor
        }
      })
    }
    found.push({ indices, alphaMass })
  }

  const meaningful = found.filter(component => component.alphaMass >= totalAlpha * 0.0025)
  if (meaningful.length > Math.floor(MAX_GENERATED_PARTICLES / RESERVED_PARTICLES_PER_COMPONENT)) fail('UNSUITABLE_LOGO')
  const labelMap = new Int32Array(found.length)
  labelMap.fill(-1)
  meaningful.forEach((component, label) => {
    labelMap[found.indexOf(component)] = label
  })
  for (const index of eligibleValues) labels[index] = labelMap[labels[index]!]!
  return {
    components: meaningful.map((component, label) => ({ label, indices: component.indices, alphaMass: component.alphaMass })),
    labels,
    eligible: Int32Array.from(eligibleValues)
  }
}

export const sobelAlpha = (raster: RgbaRaster): Float32Array => {
  const result = new Float32Array(raster.width * raster.height)
  const kernelsX = [-1, 0, 1, -2, 0, 2, -1, 0, 1]
  const kernelsY = [-1, -2, -1, 0, 0, 0, 1, 2, 1]
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      let gx = 0
      let gy = 0
      let kernel = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const px = x + dx
          const py = y + dy
          const alpha = px < 0 || px >= raster.width || py < 0 || py >= raster.height ? 0 : raster.data[(py * raster.width + px) * 4 + 3]! / 255
          gx += alpha * kernelsX[kernel]!
          gy += alpha * kernelsY[kernel]!
          kernel += 1
        }
      }
      result[y * raster.width + x] = clamp(Math.hypot(gx, gy) / SQRT_32, 0, 1)
    }
  }
  return result
}

export const domainDigest64 = (domain: 'sample' | 'seed', sourceHash: string, index: number): bigint => {
  if (!/^[0-9a-f]{64}$/.test(sourceHash) || !Number.isInteger(index) || index < 0 || index > 0xffffffff) fail('INVALID_IMAGE')
  const indexBytes = Buffer.allocUnsafe(4)
  indexBytes.writeUInt32BE(index)
  const digest = createHash('sha256').update(`tsEpistle-logo-v1/${domain}`).update(Buffer.from(sourceHash, 'hex')).update(indexBytes).digest()
  return digest.readBigUInt64BE(0)
}

const worseThan = (left: HeapEntry, right: HeapEntry): boolean =>
  left.priority > right.priority || (left.priority === right.priority && left.index > right.index)

const heapPushLowest = (heap: HeapEntry[], entry: HeapEntry, limit: number): void => {
  if (limit <= 0) return
  if (heap.length < limit) {
    heap.push(entry)
    let child = heap.length - 1
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (worseThan(heap[parent]!, heap[child]!)) break
      ;[heap[parent], heap[child]] = [heap[child]!, heap[parent]!]
      child = parent
    }
    return
  }
  if (worseThan(entry, heap[0]!)) return
  heap[0] = entry
  let parent = 0
  while (true) {
    const left = parent * 2 + 1
    const right = left + 1
    if (left >= heap.length) break
    let child = left
    if (right < heap.length && worseThan(heap[right]!, heap[left]!)) child = right
    if (worseThan(heap[parent]!, heap[child]!)) break
    ;[heap[parent], heap[child]] = [heap[child]!, heap[parent]!]
    parent = child
  }
}

const particlePriority = (sourceHash: string, index: number, weight: number): number => {
  const hash = domainDigest64('sample', sourceHash, index)
  const uniform = Number(hash + 1n) / UINT64_SCALE
  return -Math.log(uniform) / weight
}

export const sampleParticles = (raster: RgbaRaster, sourceHash: string): readonly ParticleRecord[] => {
  const { components, labels, eligible } = findMeaningfulComponents(raster)
  const edge = sobelAlpha(raster)
  let alphaSum = 0
  for (const index of eligible) alphaSum += raster.data[index * 4 + 3]! / 255
  const occupancy = alphaSum / (raster.width * raster.height)
  const count = Math.min(
    MAX_GENERATED_PARTICLES,
    Math.max(
      MIN_GENERATED_PARTICLES,
      roundHalfAwayFromZero(MAX_GENERATED_PARTICLES * Math.sqrt(occupancy)),
      RESERVED_PARTICLES_PER_COMPONENT * components.length
    )
  )
  if (eligible.length < count) fail('UNSUITABLE_LOGO')

  const reservedHeaps = components.map((): HeapEntry[] => [])
  for (const index of eligible) {
    const label = labels[index]!
    if (label < 0) continue
    const alpha = raster.data[index * 4 + 3]! / 255
    heapPushLowest(
      reservedHeaps[label]!,
      { priority: particlePriority(sourceHash, index, alpha * (1 + 3 * edge[index]!)), index },
      RESERVED_PARTICLES_PER_COMPONENT
    )
  }
  if (reservedHeaps.some(heap => heap.length !== RESERVED_PARTICLES_PER_COMPONENT)) fail('UNSUITABLE_LOGO')
  const reserved = new Set<number>(reservedHeaps.flatMap(heap => heap.map(item => item.index)))
  const remaining = count - reserved.size
  const selectedIndices: number[] = []
  if (remaining > 0) {
    const cellSize = Math.max(1, roundHalfAwayFromZero(Math.sqrt(eligible.length / count)))
    const cellColumns = Math.ceil(raster.width / cellSize)
    const primaryByCell = new Map<number, { distanceSquared: number; hash: bigint; index: number }>()
    for (const index of eligible) {
      const x = index % raster.width
      const y = Math.floor(index / raster.width)
      const cellX = Math.floor(x / cellSize)
      const cellY = Math.floor(y / cellSize)
      const cell = cellY * cellColumns + cellX
      const centerX2 = cellX * cellSize + Math.min((cellX + 1) * cellSize, raster.width) - 1
      const centerY2 = cellY * cellSize + Math.min((cellY + 1) * cellSize, raster.height) - 1
      const dx2 = 2 * x - centerX2
      const dy2 = 2 * y - centerY2
      const distanceSquared = dx2 * dx2 + dy2 * dy2
      const primary = primaryByCell.get(cell)
      if (primary && distanceSquared > primary.distanceSquared) continue
      const hash = domainDigest64('sample', sourceHash, index)
      if (primary && distanceSquared === primary.distanceSquared && (hash > primary.hash || (hash === primary.hash && index >= primary.index))) continue
      if (primary) {
        primary.distanceSquared = distanceSquared
        primary.hash = hash
        primary.index = index
      } else {
        primaryByCell.set(cell, { distanceSquared, hash, index })
      }
    }

    const primaryIndices = [...primaryByCell.values()].map(candidate => candidate.index).filter(index => !reserved.has(index))
    if (primaryIndices.length >= remaining) {
      const selectedEntries: HeapEntry[] = []
      for (const index of primaryIndices) {
        const alpha = raster.data[index * 4 + 3]! / 255
        heapPushLowest(selectedEntries, { priority: particlePriority(sourceHash, index, alpha * (1 + 3 * edge[index]!)), index }, remaining)
      }
      selectedIndices.push(...selectedEntries.map(entry => entry.index))
    } else {
      selectedIndices.push(...primaryIndices)
      const supplement: HeapEntry[] = []
      const supplementCount = remaining - primaryIndices.length
      for (const index of eligible) {
        if (reserved.has(index)) continue
        const x = index % raster.width
        const y = Math.floor(index / raster.width)
        const cell = Math.floor(y / cellSize) * cellColumns + Math.floor(x / cellSize)
        if (primaryByCell.get(cell)?.index === index) continue
        const alpha = raster.data[index * 4 + 3]! / 255
        heapPushLowest(supplement, { priority: particlePriority(sourceHash, index, alpha * (1 + 3 * edge[index]!)), index }, supplementCount)
      }
      selectedIndices.push(...supplement.map(entry => entry.index))
    }
  }
  if (selectedIndices.length !== remaining) fail('UNSUITABLE_LOGO')

  const selected = [...reserved, ...selectedIndices].sort((left, right) => left - right)
  return selected.map(index => {
    const x = index % raster.width
    const y = Math.floor(index / raster.width)
    const xNorm = (2 * x) / (raster.width - 1) - 1
    const yNorm = 1 - (2 * y) / (raster.height - 1)
    const offset = index * 4
    const alpha = raster.data[offset + 3]! / 255
    return {
      sourceIndex: index,
      x,
      y,
      xEncoded: roundHalfAwayFromZero(clamp(xNorm, -1, 1) * 32767),
      yEncoded: roundHalfAwayFromZero(clamp(yNorm, -1, 1) * 32767),
      depth: roundHalfAwayFromZero(127 * (2 * edge[index]! - 1)),
      rgba: [raster.data[offset]!, raster.data[offset + 1]!, raster.data[offset + 2]!, raster.data[offset + 3]!] as const,
      size: 1 + roundHalfAwayFromZero(254 * alpha),
      seed: 1 + Number(domainDigest64('seed', sourceHash, index) % 65_535n)
    }
  })
}

const crc32Table = new Uint32Array(256)
for (let index = 0; index < crc32Table.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crc32Table[index] = value >>> 0
}

export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const value of bytes) crc = (crc >>> 8) ^ crc32Table[(crc ^ value) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}

export const encodeParticleV1 = (width: number, height: number, records: readonly ParticleRecord[]): Buffer => {
  const count = records.length
  if (width < 2 || width > 4096 || height < 2 || height > 4096 || count < 1 || count > MAX_PARTICLES) fail('PROCESSING_FAILED')
  const payloadLength = PARTICLE_BYTES * count
  const result = Buffer.alloc(PARTICLE_HEADER_BYTES + payloadLength)
  result.write('TSEP', 0, 'ascii')
  result[4] = 1
  result[5] = PARTICLE_FLAGS
  result.writeUInt16LE(PARTICLE_HEADER_BYTES, 6)
  result.writeUInt32LE(width, 8)
  result.writeUInt32LE(height, 12)
  result.writeUInt32LE(count, 16)
  result.writeUInt32LE(payloadLength, 20)
  const xyOffset = PARTICLE_HEADER_BYTES
  const depthOffset = xyOffset + 4 * count
  const rgbaOffset = depthOffset + count
  const sizeOffset = rgbaOffset + 4 * count
  const seedOffset = sizeOffset + count
  result.writeUInt32LE(xyOffset, 28)
  result.writeUInt32LE(depthOffset, 32)
  result.writeUInt32LE(rgbaOffset, 36)
  result.writeUInt32LE(sizeOffset, 40)
  result.writeUInt32LE(seedOffset, 44)
  result.writeUInt32LE(result.length, 48)
  result.writeUInt32LE(0, 52)
  records.forEach((record, index) => {
    result.writeInt16LE(record.xEncoded, xyOffset + 4 * index)
    result.writeInt16LE(record.yEncoded, xyOffset + 4 * index + 2)
    result.writeInt8(record.depth, depthOffset + index)
    for (let channel = 0; channel < 4; channel += 1) result[rgbaOffset + 4 * index + channel] = record.rgba[channel]!
    result[sizeOffset + index] = record.size
    result.writeUInt16LE(record.seed, seedOffset + 2 * index)
  })
  result.writeUInt32LE(crc32(result.subarray(PARTICLE_HEADER_BYTES)), 24)
  return result
}

export const parseParticleV1 = (input: Buffer | Uint8Array): ParsedParticleV1 => {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (bytes.length < PARTICLE_HEADER_BYTES || bytes.length > SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT) fail('INVALID_IMAGE')
  if (bytes.toString('ascii', 0, 4) !== 'TSEP' || bytes[4] !== 1 || bytes[5] !== PARTICLE_FLAGS || bytes.readUInt16LE(6) !== PARTICLE_HEADER_BYTES)
    fail('INVALID_IMAGE')
  const width = bytes.readUInt32LE(8)
  const height = bytes.readUInt32LE(12)
  const count = bytes.readUInt32LE(16)
  if (width < 2 || width > 4096 || height < 2 || height > 4096 || count < 1 || count > MAX_PARTICLES) fail('INVALID_IMAGE')
  const payloadLength = PARTICLE_BYTES * count
  const xyOffset = PARTICLE_HEADER_BYTES
  const depthOffset = xyOffset + 4 * count
  const rgbaOffset = depthOffset + count
  const sizeOffset = rgbaOffset + 4 * count
  const seedOffset = sizeOffset + count
  const fileLength = seedOffset + 2 * count
  if (
    payloadLength > MAX_PARTICLES * PARTICLE_BYTES ||
    bytes.readUInt32LE(20) !== payloadLength ||
    bytes.readUInt32LE(28) !== xyOffset ||
    bytes.readUInt32LE(32) !== depthOffset ||
    bytes.readUInt32LE(36) !== rgbaOffset ||
    bytes.readUInt32LE(40) !== sizeOffset ||
    bytes.readUInt32LE(44) !== seedOffset ||
    bytes.readUInt32LE(48) !== fileLength ||
    bytes.readUInt32LE(52) !== 0 ||
    bytes.length !== fileLength ||
    bytes.readUInt32LE(24) !== crc32(bytes.subarray(PARTICLE_HEADER_BYTES))
  )
    fail('INVALID_IMAGE')

  const records: ParticleRecord[] = []
  for (let index = 0; index < count; index += 1) {
    const xEncoded = bytes.readInt16LE(xyOffset + 4 * index)
    const yEncoded = bytes.readInt16LE(xyOffset + 4 * index + 2)
    const depth = bytes.readInt8(depthOffset + index)
    const alpha = bytes[rgbaOffset + 4 * index + 3]!
    const size = bytes[sizeOffset + index]!
    const seed = bytes.readUInt16LE(seedOffset + 2 * index)
    if (xEncoded === -32768 || yEncoded === -32768 || depth === -128 || alpha === 0 || size === 0 || seed === 0) fail('INVALID_IMAGE')
    records.push({
      sourceIndex: index,
      x: ((xEncoded / 32767 + 1) * (width - 1)) / 2,
      y: ((1 - yEncoded / 32767) * (height - 1)) / 2,
      xEncoded,
      yEncoded,
      depth,
      rgba: [bytes[rgbaOffset + 4 * index]!, bytes[rgbaOffset + 4 * index + 1]!, bytes[rgbaOffset + 4 * index + 2]!, alpha],
      size,
      seed
    })
  }
  return { width, height, count, records }
}

interface ParticleContrastPresentation {
  readonly useRing: boolean
  readonly ringWidth: number
  readonly ringNeutral: 0 | 255
  readonly lightCovered: boolean
  readonly darkCovered: boolean
}

const rasterizeParticleLayers = (
  width: number,
  height: number,
  records: readonly ParticleRecord[],
  includeContrastRings: boolean,
  coreScale: number
): { rgba: Buffer; alpha: Float64Array; contrastRgba?: Buffer } => {
  const rgba = Buffer.alloc(width * height * 4)
  const contrastRgba = includeContrastRings ? Buffer.alloc(width * height * 4) : undefined
  const reconstructedAlpha = new Float64Array(width * height)
  const sampleWidth = width * 64
  const alpha = new Float64Array(sampleWidth)
  const red = new Float64Array(sampleWidth)
  const green = new Float64Array(sampleWidth)
  const blue = new Float64Array(sampleWidth)
  const contrastAlpha = includeContrastRings ? new Float64Array(sampleWidth) : undefined
  const contrastRed = includeContrastRings ? new Float64Array(sampleWidth) : undefined
  const contrastGreen = includeContrastRings ? new Float64Array(sampleWidth) : undefined
  const contrastBlue = includeContrastRings ? new Float64Array(sampleWidth) : undefined
  const presentations = includeContrastRings ? records.map(particleContrastPresentation) : undefined

  for (let y = 0; y < height; y += 1) {
    alpha.fill(0)
    red.fill(0)
    green.fill(0)
    blue.fill(0)
    contrastAlpha?.fill(0)
    contrastRed?.fill(0)
    contrastGreen?.fill(0)
    contrastBlue?.fill(0)
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const record = records[recordIndex]!
      const presentation = presentations?.[recordIndex]
      const radius = ((1 + 15 * ((record.size - 1) / 254)) * coreScale) / 2
      const outerRadius = radius + (presentation?.useRing ? presentation.ringWidth : 0)
      if (y + 1 < record.y - outerRadius || y > record.y + outerRadius) continue
      const firstX = Math.max(0, Math.floor(record.x - outerRadius))
      const lastX = Math.min(width - 1, Math.floor(record.x + outerRadius))
      const sourceAlpha = record.rgba[3] / 255
      const inverse = 1 - sourceAlpha
      const radiusSquared = radius * radius
      const outerRadiusSquared = outerRadius * outerRadius
      for (let x = firstX; x <= lastX; x += 1) {
        for (let subY = 0; subY < 8; subY += 1) {
          const dy = y + (subY + 0.5) / 8 - record.y
          for (let subX = 0; subX < 8; subX += 1) {
            const dx = x + (subX + 0.5) / 8 - record.x
            const distanceSquared = dx * dx + dy * dy
            if (distanceSquared > outerRadiusSquared) continue
            const sample = x * 64 + subY * 8 + subX
            const inCore = distanceSquared <= radiusSquared
            if (inCore) {
              alpha[sample] = sourceAlpha + alpha[sample]! * inverse
              red[sample] = (record.rgba[0] / 255) * sourceAlpha + red[sample]! * inverse
              green[sample] = (record.rgba[1] / 255) * sourceAlpha + green[sample]! * inverse
              blue[sample] = (record.rgba[2] / 255) * sourceAlpha + blue[sample]! * inverse
            }
            if (contrastAlpha && contrastRed && contrastGreen && contrastBlue && (inCore || presentation?.useRing)) {
              const channel = inCore ? undefined : presentation!.ringNeutral / 255
              contrastAlpha[sample] = sourceAlpha + contrastAlpha[sample]! * inverse
              contrastRed[sample] = (channel ?? record.rgba[0] / 255) * sourceAlpha + contrastRed[sample]! * inverse
              contrastGreen[sample] = (channel ?? record.rgba[1] / 255) * sourceAlpha + contrastGreen[sample]! * inverse
              contrastBlue[sample] = (channel ?? record.rgba[2] / 255) * sourceAlpha + contrastBlue[sample]! * inverse
            }
          }
        }
      }
    }

    for (let x = 0; x < width; x += 1) {
      let sumAlpha = 0
      let sumRed = 0
      let sumGreen = 0
      let sumBlue = 0
      let sumContrastAlpha = 0
      let sumContrastRed = 0
      let sumContrastGreen = 0
      let sumContrastBlue = 0
      for (let sample = x * 64; sample < (x + 1) * 64; sample += 1) {
        sumAlpha += alpha[sample]!
        sumRed += red[sample]!
        sumGreen += green[sample]!
        sumBlue += blue[sample]!
        if (contrastAlpha && contrastRed && contrastGreen && contrastBlue) {
          sumContrastAlpha += contrastAlpha[sample]!
          sumContrastRed += contrastRed[sample]!
          sumContrastGreen += contrastGreen[sample]!
          sumContrastBlue += contrastBlue[sample]!
        }
      }
      const pixelAlpha = sumAlpha / 64
      const offset = (y * width + x) * 4
      reconstructedAlpha[y * width + x] = pixelAlpha
      rgba[offset + 3] = byte(255 * pixelAlpha)
      if (pixelAlpha > 0) {
        rgba[offset] = byte((255 * (sumRed / 64)) / pixelAlpha)
        rgba[offset + 1] = byte((255 * (sumGreen / 64)) / pixelAlpha)
        rgba[offset + 2] = byte((255 * (sumBlue / 64)) / pixelAlpha)
      }
      const contrastPixelAlpha = sumContrastAlpha / 64
      if (contrastRgba && contrastPixelAlpha > 0) {
        contrastRgba[offset] = byte((255 * (sumContrastRed / 64)) / contrastPixelAlpha)
        contrastRgba[offset + 1] = byte((255 * (sumContrastGreen / 64)) / contrastPixelAlpha)
        contrastRgba[offset + 2] = byte((255 * (sumContrastBlue / 64)) / contrastPixelAlpha)
        contrastRgba[offset + 3] = byte(255 * contrastPixelAlpha)
      }
    }
  }
  return { rgba, alpha: reconstructedAlpha, ...(contrastRgba ? { contrastRgba } : {}) }
}

export const rasterizeParticles = (
  width: number,
  height: number,
  records: readonly ParticleRecord[],
  coreScale = 1
): { rgba: Buffer; alpha: Float64Array; staticRgba: Buffer } => {
  if (!Number.isFinite(coreScale) || coreScale <= 0 || coreScale > MAX_RASTERIZED_CORE_SCALE) fail('PROCESSING_FAILED')
  const layers = rasterizeParticleLayers(width, height, records, true, coreScale)
  const staticRgba = layers.contrastRgba ?? fail('PROCESSING_FAILED')
  return { rgba: layers.rgba, alpha: layers.alpha, staticRgba }
}

export const reconstructedMaskIou = (source: RgbaRaster, reconstructedAlpha: Float64Array): number => {
  if (reconstructedAlpha.length !== source.width * source.height) fail('PROCESSING_FAILED')
  let intersection = 0
  let union = 0
  for (let index = 0; index < reconstructedAlpha.length; index += 1) {
    const original = source.data[index * 4 + 3]! / 255
    const reconstructed = reconstructedAlpha[index]!
    intersection += Math.min(original, reconstructed)
    union += Math.max(original, reconstructed)
  }
  return union === 0 ? 0 : intersection / union
}

const pngChunk = (type: string, data: Buffer): Buffer => {
  const typeBytes = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length)
  return chunk
}

const paeth = (left: number, above: number, upperLeft: number): number => {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft
}

const filteredRow = (data: Buffer, row: number, width: number, filter: number): Buffer => {
  const stride = width * 4
  const result = Buffer.allocUnsafe(stride + 1)
  result[0] = filter
  for (let column = 0; column < stride; column += 1) {
    const value = data[row * stride + column]!
    const left = column >= 4 ? data[row * stride + column - 4]! : 0
    const above = row > 0 ? data[(row - 1) * stride + column]! : 0
    const upperLeft = row > 0 && column >= 4 ? data[(row - 1) * stride + column - 4]! : 0
    const prediction =
      filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft)
    result[column + 1] = (value - prediction + 256) & 0xff
  }
  return result
}

export const encodeRgbaPng = (raster: RgbaRaster): Buffer => {
  if (raster.width < 1 || raster.height < 1 || raster.data.length !== raster.width * raster.height * 4) fail('PROCESSING_FAILED')
  const rows: Buffer[] = []
  for (let y = 0; y < raster.height; y += 1) {
    let best: Buffer | undefined
    let bestScore = Number.POSITIVE_INFINITY
    for (let filter = 0; filter <= 4; filter += 1) {
      const candidate = filteredRow(raster.data, y, raster.width, filter)
      let score = 0
      for (let offset = 1; offset < candidate.length; offset += 1) score += Math.abs(candidate[offset]! < 128 ? candidate[offset]! : candidate[offset]! - 256)
      if (score < bestScore) {
        best = candidate
        bestScore = score
      }
    }
    rows.push(best!)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(raster.width, 0)
  header.writeUInt32BE(raster.height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const relativeLuminance = (r: number, g: number, b: number): number => 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
const contrast = (left: number, right: number): number => (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)

const particleContrastPresentation = (record: ParticleRecord): ParticleContrastPresentation => {
  const alpha = record.rgba[3] / 255
  const luminance = relativeLuminance(record.rgba[0], record.rgba[1], record.rgba[2])
  const lightContrast = contrast(alpha * luminance + 1 - alpha, 1)
  const darkContrast = contrast(alpha * luminance, 0)
  const useRing = lightContrast < 3 || darkContrast < 3
  const ringNeutral: 0 | 255 = lightContrast <= darkContrast ? 0 : 255
  const ringLuminance = ringNeutral / 255
  const ringOnLight = contrast(alpha * ringLuminance + 1 - alpha, 1)
  const ringOnDark = contrast(alpha * ringLuminance, 0)
  return {
    useRing,
    ringWidth: 1.25 + 0.75 * clamp((3 - Math.min(lightContrast, darkContrast)) / 2, 0, 1),
    ringNeutral,
    lightCovered: lightContrast >= 3 || (useRing && ringOnLight >= 3),
    darkCovered: darkContrast >= 3 || (useRing && ringOnDark >= 3)
  }
}

const particlesMeetContrastCoverage = (records: readonly ParticleRecord[]): boolean => {
  let totalAlphaMass = 0
  let lightCoveredMass = 0
  let darkCoveredMass = 0
  for (const record of records) {
    const alphaMass = record.rgba[3] / 255
    const presentation = particleContrastPresentation(record)
    totalAlphaMass += alphaMass
    if (presentation.lightCovered) lightCoveredMass += alphaMass
    if (presentation.darkCovered) darkCoveredMass += alphaMass
  }
  return totalAlphaMass > 0 && lightCoveredMass / totalAlphaMass >= 0.95 && darkCoveredMass / totalAlphaMass >= 0.95
}

const distanceTransform1d = (values: Float64Array): Float64Array => {
  const length = values.length
  const result = new Float64Array(length)
  const locations = new Int32Array(length)
  const boundaries = new Float64Array(length + 1)
  const finiteLocations: number[] = []
  for (let index = 0; index < length; index += 1) if (values[index]! < 1e19) finiteLocations.push(index)
  if (finiteLocations.length === 0) {
    result.fill(1e20)
    return result
  }
  let k = 0
  locations[0] = finiteLocations[0]!
  boundaries[0] = Number.NEGATIVE_INFINITY
  boundaries[1] = Number.POSITIVE_INFINITY
  for (let candidate = 1; candidate < finiteLocations.length; candidate += 1) {
    const q = finiteLocations[candidate]!
    let separation = (values[q]! + q * q - (values[locations[k]!]! + locations[k]! * locations[k]!)) / (2 * q - 2 * locations[k]!)
    while (k > 0 && separation <= boundaries[k]!) {
      k -= 1
      separation = (values[q]! + q * q - (values[locations[k]!]! + locations[k]! * locations[k]!)) / (2 * q - 2 * locations[k]!)
    }
    k += 1
    locations[k] = q
    boundaries[k] = separation
    boundaries[k + 1] = Number.POSITIVE_INFINITY
  }
  k = 0
  for (let q = 0; q < length; q += 1) {
    while (boundaries[k + 1]! < q) k += 1
    result[q] = (q - locations[k]!) ** 2 + values[locations[k]!]!
  }
  return result
}

export const medianStrokeWidth = (raster: RgbaRaster): number => {
  const infinity = 1e20
  const horizontal = new Float64Array(raster.width * raster.height)
  for (let y = 0; y < raster.height; y += 1) {
    const row = new Float64Array(raster.width)
    for (let x = 0; x < raster.width; x += 1) row[x] = raster.data[(y * raster.width + x) * 4 + 3] === 0 ? 0 : infinity
    horizontal.set(distanceTransform1d(row), y * raster.width)
  }
  const distance = new Float64Array(raster.width * raster.height)
  for (let x = 0; x < raster.width; x += 1) {
    const column = new Float64Array(raster.height)
    for (let y = 0; y < raster.height; y += 1) column[y] = horizontal[y * raster.width + x]!
    const transformed = distanceTransform1d(column)
    for (let y = 0; y < raster.height; y += 1) distance[y * raster.width + x] = transformed[y]!
  }
  const radii: number[] = []
  for (let index = 0; index < distance.length; index += 1) {
    if (raster.data[index * 4 + 3] === 0) continue
    let maximum = true
    neighbors8(index, raster.width, raster.height, neighbor => {
      if (distance[neighbor]! > distance[index]!) maximum = false
    })
    if (maximum) radii.push(Math.sqrt(distance[index]!))
  }
  if (radii.length === 0) fail('UNSUITABLE_LOGO')
  radii.sort((left, right) => left - right)
  const middle = Math.floor(radii.length / 2)
  const median = radii.length % 2 === 1 ? radii[middle]! : (radii[middle - 1]! + radii[middle]!) / 2
  return 2 * median
}

export const deriveAuraColor = (raster: RgbaRaster): string | undefined => {
  let totalMass = 0
  let chromaticMass = 0
  let red = 0
  let green = 0
  let blue = 0
  for (let index = 0; index < raster.width * raster.height; index += 1) {
    const offset = index * 4
    const alpha = raster.data[offset + 3]! / 255
    if (alpha === 0) continue
    totalMass += alpha
    const lab = rgbaToOklab(raster.data[offset]!, raster.data[offset + 1]!, raster.data[offset + 2]!)
    if (Math.hypot(lab.a, lab.b) <= 0.03) continue
    chromaticMass += alpha
    red += alpha * srgbToLinear(raster.data[offset]!)
    green += alpha * srgbToLinear(raster.data[offset + 1]!)
    blue += alpha * srgbToLinear(raster.data[offset + 2]!)
  }
  if (totalMass === 0 || chromaticMass / totalMass < 0.1) return undefined
  return `#${[linearToSrgbByte(red / chromaticMass), linearToSrgbByte(green / chromaticMass), linearToSrgbByte(blue / chromaticMass)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')}`
}

export const assertArtifactBudgets = (artifacts: Pick<SiteLogoArtifacts, 'logoPng' | 'particleV1' | 'effectStaticPng'>): void => {
  if (
    artifacts.particleV1.length > SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT ||
    gzipSync(artifacts.particleV1, { level: 9 }).length > SITE_LOGO_PARTICLE_GZIP_BYTE_LIMIT ||
    artifacts.logoPng.length > SITE_LOGO_PNG_BYTE_LIMIT ||
    artifacts.effectStaticPng.length > SITE_LOGO_STATIC_PNG_BYTE_LIMIT
  )
    fail('ARTIFACT_TOO_LARGE')
}

const processUnlocked = async (sourceBytes: Buffer | Uint8Array, sourceHash: string): Promise<SiteLogoArtifacts> => {
  const bytes = Buffer.isBuffer(sourceBytes) ? Buffer.from(sourceBytes) : Buffer.from(sourceBytes)
  if (bytes.length > SITE_LOGO_SOURCE_BYTE_LIMIT) fail('IMAGE_TOO_LARGE')
  if (bytes.length === 0 || !/^[0-9a-f]{64}$/.test(sourceHash)) fail('INVALID_IMAGE')
  if (createHash('sha256').update(bytes).digest('hex') !== sourceHash) fail('INVALID_IMAGE')

  const decoded = await decodeSource(bytes)
  let visible = false
  for (let offset = 3; offset < decoded.raster.data.length; offset += 4)
    if (decoded.raster.data[offset] !== 0) {
      visible = true
      break
    }
  if (!visible) fail('NO_VISIBLE_PIXELS')
  const withoutMatte = removeNeutralMatte(decoded.raster, decoded.hasNativeAlpha)
  const trimmed = trimTransparent(withoutMatte)
  const scale = Math.min(1, PARTICLE_REFERENCE_LONG_AXIS / Math.max(trimmed.width, trimmed.height))
  const workingWidth = roundHalfAwayFromZero(scale * trimmed.width)
  const workingHeight = roundHalfAwayFromZero(scale * trimmed.height)
  const working = resizeLinearPremultiplied(trimmed, workingWidth, workingHeight)
  const particlePadding = roundHalfAwayFromZero(PARTICLE_PADDING_RATIO * Math.max(working.width, working.height))
  const normalized = padRaster(working, particlePadding)
  if (normalized.width > 4096 || normalized.height > 4096) fail('UNSUITABLE_LOGO')

  const records = sampleParticles(normalized, sourceHash)
  const particleV1 = encodeParticleV1(normalized.width, normalized.height, records)
  const parsed = parseParticleV1(particleV1)
  if (!particlesMeetContrastCoverage(parsed.records)) fail('UNSUITABLE_LOGO')
  const coreScale = Math.max(parsed.width, parsed.height) / PARTICLE_REFERENCE_LONG_AXIS
  const reconstruction = rasterizeParticles(parsed.width, parsed.height, parsed.records, coreScale)
  if (reconstructedMaskIou(normalized, reconstruction.alpha) < MIN_RECONSTRUCTED_MASK_IOU) fail('UNSUITABLE_LOGO')
  const logoPng = encodeRgbaPng(decoded.raster)
  if (logoPng.length > SITE_LOGO_PNG_BYTE_LIMIT) fail('ARTIFACT_TOO_LARGE')
  const effectStaticPng = encodeRgbaPng({ width: normalized.width, height: normalized.height, data: reconstruction.staticRgba })
  const auraColor = deriveAuraColor(working)
  const artifacts: SiteLogoArtifacts = {
    logoPng,
    particleV1,
    effectStaticPng,
    normalizedWidth: normalized.width,
    normalizedHeight: normalized.height,
    particleCount: records.length,
    medianStroke: medianStrokeWidth(normalized),
    ...(auraColor === undefined ? {} : { auraColor })
  }
  assertArtifactBudgets(artifacts)
  return artifacts
}

let processingTail: Promise<void> = Promise.resolve()

export const processSiteLogoSource = async (sourceBytes: Buffer | Uint8Array, sourceHash: string): Promise<SiteLogoArtifacts> => {
  const previous = processingTail
  let release!: () => void
  processingTail = new Promise<void>(resolve => {
    release = resolve
  })
  await previous
  try {
    return await processUnlocked(sourceBytes, sourceHash)
  } finally {
    release()
  }
}
