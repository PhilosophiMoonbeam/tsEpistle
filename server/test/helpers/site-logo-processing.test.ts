import {
  assertArtifactBudgets,
  crc32,
  domainDigest64,
  encodeParticleV1,
  encodeRgbaPng,
  padRaster,
  parseParticleV1,
  processSiteLogoSource,
  type RgbaRaster,
  rasterizeParticles,
  reconstructedMaskIou,
  removeNeutralMatte,
  resizeLinearPremultiplied,
  roundHalfAwayFromZero,
  SiteLogoProcessingError,
  trimTransparent
} from '../../helpers/site-logo-processing.ts'
import {
  SITE_LOGO_CANONICAL_LONG_AXIS,
  SITE_LOGO_FAVICON_ICO_BYTE_LIMIT,
  SITE_LOGO_ICON_PNG_BYTE_LIMIT,
  SITE_LOGO_ICON_SIZES,
  SITE_LOGO_MAX_INPUT_DIMENSION,
  SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT,
  SITE_LOGO_PIPELINE_VERSION,
  SITE_LOGO_PNG_BYTE_LIMIT,
  SITE_LOGO_SOURCE_BYTE_LIMIT,
  SITE_LOGO_STATIC_PNG_BYTE_LIMIT,
  type SiteLogoErrorCode
} from '../../../shared/site-logo.ts'
import { describe, expect, it } from '../bun-test.mts'
import {
  alphaAwareIconFixture,
  decodeFixtureRgba,
  decompressionBombFixture,
  encodeFixture,
  FIXED_SAMPLE_DIGEST64,
  FIXED_SEED_DIGEST64,
  FIXED_VECTOR_BINARY_HEX,
  FIXED_VECTOR_BINARY_SHA256,
  FIXED_VECTOR_IOU,
  FIXED_VECTOR_RECORDS,
  FIXED_VECTOR_SOURCE_HASH,
  FIXED_VECTOR_STATIC_PNG_SHA256,
  fixedVectorRaster,
  fixedVectorStaticRaster,
  fixtureMetadata,
  LOW_RESOLUTION_EMBLEM_VECTOR,
  lowResolutionDetailedEmblemFixture,
  neutralMatteFixture,
  opaqueMatteDetachedFixture,
  opaqueMatteDetachedRaster,
  onePixelFixture,
  orientedProfiledJpegFixture,
  oversizedDimensionFixture,
  rgbaImage,
  SQUARE_BADGE_VECTOR,
  sha256,
  sparseVisibleFixture,
  squareBadgeFixture,
  tallFineDetailFixture,
  transparentContrastFixture,
  transparentLowAlphaContrastFixture,
  transparentMulticolorDetachedFixture,
  extremeAspectFixture,
  highEntropyFixture
} from './site-logo-processing.fixtures.ts'

const expectCode = async (promise: Promise<unknown>, code: SiteLogoErrorCode): Promise<void> => {
  try {
    await promise
  } catch (error: unknown) {
    if (!(error instanceof SiteLogoProcessingError)) throw error
    expect(error.code).toBe(code)
    return
  }
  throw new Error(`Expected ${code}`)
}

const GENERATED_CORPUS_TIMEOUT_MS = 20_000

const rgbaAt = (data: Buffer, width: number, x: number, y: number): number[] => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]

const normalizedNativeAlphaRaster = async (source: Buffer): Promise<RgbaRaster> => {
  const trimmed = trimTransparent(removeNeutralMatte(await decodeFixtureRgba(source), true))
  const scale = 1024 / Math.max(trimmed.width, trimmed.height)
  const working = resizeLinearPremultiplied(
    trimmed,
    Math.max(1, roundHalfAwayFromZero(scale * trimmed.width)),
    Math.max(1, roundHalfAwayFromZero(scale * trimmed.height))
  )
  return padRaster(working, roundHalfAwayFromZero(0.04 * Math.max(working.width, working.height)))
}

const particleMaskIou = (source: RgbaRaster, particleV1: Buffer): number => {
  const parsed = parseParticleV1(particleV1)
  const coreScale = Math.max(parsed.width, parsed.height) / 1024
  return reconstructedMaskIou(source, rasterizeParticles(parsed.width, parsed.height, parsed.records, coreScale).alpha)
}

interface OpaqueIconSummary {
  readonly opaquePixels: number
  readonly foregroundPixels: number
  readonly foregroundArea: number
  readonly contained: boolean
  readonly safe: boolean
}

const summarizeOpaqueIcon = (data: Buffer, size: number, foreground: readonly [number, number, number, number], maskable: boolean): OpaqueIconSummary => {
  let opaquePixels = 0
  let foregroundPixels = 0
  let left = size
  let top = size
  let right = -1
  let bottom = -1
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4
      if (data[offset + 3] === 255) opaquePixels += 1
      if (data[offset] === foreground[0] && data[offset + 1] === foreground[1] && data[offset + 2] === foreground[2] && data[offset + 3] === foreground[3]) {
        foregroundPixels += 1
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    }
  }
  const foregroundArea = right < left || bottom < top ? 0 : (right - left + 1) * (bottom - top + 1)
  const contained = left >= 0 && top >= 0 && right < size && bottom < size && foregroundPixels === foregroundArea && foregroundArea > 0
  const center = size / 2
  const maxDistance = 0.4 * size
  const rightEdge = right + 1
  const bottomEdge = bottom + 1
  const safe =
    !maskable ||
    (contained &&
      [
        [left, top],
        [rightEdge, top],
        [left, bottomEdge],
        [rightEdge, bottomEdge]
      ].every(([x, y]) => Math.hypot(x - center, y - center) <= maxDistance + 1e-9))
  return { opaquePixels, foregroundPixels, foregroundArea, contained, safe }
}
const TRANSPARENT_ICON_ROLES: Record<string, true> = { favicon16: true, favicon32: true, tile150: true, app192: true, app512: true }

const fakePngWithActl = (): Buffer => {
  const header = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(256, 16)
  header.writeUInt32BE(256, 20)
  return Buffer.concat([header, Buffer.from([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0])])
}

const animatedWebpHeader = (): Buffer => {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(22, 4)
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8X', 12, 'ascii')
  bytes.writeUInt32LE(10, 16)
  bytes[20] = 0x02
  return bytes
}

describe('site logo deterministic primitives', () => {
  it('uses pipeline version seven and rounds every tie away from zero', () => {
    expect(SITE_LOGO_PIPELINE_VERSION).toBe(7)
    expect([-2.5, -1.5, -0.5, 0.5, 1.5, 2.5].map(roundHalfAwayFromZero)).toEqual([-3, -2, -1, 1, 2, 3])
  })

  it('uses domain-separated SHA-256 with an unsigned big-endian index and digest prefix', () => {
    expect(domainDigest64('sample', FIXED_VECTOR_SOURCE_HASH, 0)).toBe(FIXED_SAMPLE_DIGEST64)
    expect(domainDigest64('seed', FIXED_VECTOR_SOURCE_HASH, 0xffff_ffff)).toBe(FIXED_SEED_DIGEST64)
    expect(domainDigest64('sample', FIXED_VECTOR_SOURCE_HASH, 0)).not.toBe(domainDigest64('seed', FIXED_VECTOR_SOURCE_HASH, 0))
  })

  it('packs the exact v1 block layout, payload CRC, and immutable binary vector', () => {
    const binary = encodeParticleV1(8, 8, FIXED_VECTOR_RECORDS)
    expect(binary.toString('hex')).toBe(FIXED_VECTOR_BINARY_HEX)
    expect(sha256(binary)).toBe(FIXED_VECTOR_BINARY_SHA256)
    expect(binary.length).toBe(56 + 12 * FIXED_VECTOR_RECORDS.length)
    expect(binary.readUInt32LE(20)).toBe(24)
    expect(binary.readUInt32LE(24)).toBe(crc32(binary.subarray(56)))
    expect([...Array.from({ length: 5 }, (_, index) => binary.readUInt32LE(28 + 4 * index))]).toEqual([56, 64, 66, 74, 76])
    expect(binary.readUInt32LE(48)).toBe(80)
    expect(binary.readUInt32LE(52)).toBe(0)

    const parsed = parseParticleV1(binary)
    expect({ width: parsed.width, height: parsed.height, count: parsed.count }).toEqual({ width: 8, height: 8, count: 2 })
    expect(
      parsed.records.map(record => ({
        xEncoded: record.xEncoded,
        yEncoded: record.yEncoded,
        depth: record.depth,
        rgba: record.rgba,
        size: record.size,
        seed: record.seed
      }))
    ).toEqual(
      FIXED_VECTOR_RECORDS.map(record => ({
        xEncoded: record.xEncoded,
        yEncoded: record.yEncoded,
        depth: record.depth,
        rgba: record.rgba,
        size: record.size,
        seed: record.seed
      }))
    )
  })

  it('retains the particle-v1 16,000-record format limit independently of the lower generation budget', () => {
    const records = Array.from({ length: 16_000 }, (_, sourceIndex) => ({
      ...FIXED_VECTOR_RECORDS[sourceIndex % FIXED_VECTOR_RECORDS.length]!,
      sourceIndex
    }))
    expect(parseParticleV1(encodeParticleV1(8, 8, records)).count).toBe(16_000)
    expect(() => encodeParticleV1(8, 8, [...records, records[0]!])).toThrow(SiteLogoProcessingError)
  })

  it('rejects missing or unknown flag bits, corrupt CRC, sentinels, and trailing bytes', () => {
    const valid = encodeParticleV1(8, 8, FIXED_VECTOR_RECORDS)
    for (const flags of [0x00, 0x03, 0x06, 0x0f]) {
      const invalid = Buffer.from(valid)
      invalid[5] = flags
      expect(() => parseParticleV1(invalid)).toThrow(SiteLogoProcessingError)
    }
    const corrupt = Buffer.from(valid)
    corrupt[60] ^= 0xff
    expect(() => parseParticleV1(corrupt)).toThrow(SiteLogoProcessingError)
    expect(() => parseParticleV1(Buffer.concat([valid, Buffer.from([0])]))).toThrow(SiteLogoProcessingError)
    const sentinel = Buffer.from(valid)
    sentinel.writeInt16LE(-32768, 56)
    sentinel.writeUInt32LE(crc32(sentinel.subarray(56)), 24)
    expect(() => parseParticleV1(sentinel)).toThrow(SiteLogoProcessingError)
  })

  it('matches the literal 8x8 core and 2/3-diameter contrast-ring rasters, IoU, and deterministic static PNG hash', () => {
    const parsed = parseParticleV1(Buffer.from(FIXED_VECTOR_BINARY_HEX, 'hex'))
    const rasterized = rasterizeParticles(8, 8, parsed.records)
    const expected = fixedVectorRaster()
    const expectedStatic = fixedVectorStaticRaster()
    const decodedSourceIndices = parsed.records.map(record => Math.round(record.y) * parsed.width + Math.round(record.x))
    expect(decodedSourceIndices).toEqual(FIXED_VECTOR_RECORDS.map(record => record.sourceIndex))
    expect(decodedSourceIndices).toEqual([...decodedSourceIndices].sort((left, right) => left - right))
    expect(rasterized.rgba).toEqual(expected.data)
    expect(rasterized.staticRgba).toEqual(expectedStatic.data)
    expect(reconstructedMaskIou(expected, rasterized.alpha)).toBe(FIXED_VECTOR_IOU)
    expect(FIXED_VECTOR_IOU).toBeGreaterThanOrEqual(0.75)
    expect(sha256(encodeRgbaPng(expectedStatic))).toBe(FIXED_VECTOR_STATIC_PNG_SHA256)
  })

  it('rejects particle core scales outside the normalized pipeline range', () => {
    for (const coreScale of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1107 / 1024])
      expect(() => rasterizeParticles(8, 8, FIXED_VECTOR_RECORDS, coreScale)).toThrow('PROCESSING_FAILED')
  })
})

describe('site logo masking and particle normalization', () => {
  it('removes only an edge-connected neutral matte and trims its transparent padding', () => {
    const width = 96
    const height = 96
    const data = rgbaImage(width, height, [250, 250, 250, 255])
    for (let y = 18; y < 78; y += 1) {
      for (let x = 18; x < 78; x += 1) {
        const offset = (y * width + x) * 4
        data[offset] = 180
        data[offset + 1] = 20
        data[offset + 2] = 40
      }
    }
    const removed = removeNeutralMatte({ width, height, data }, false)
    expect(removed.data[3]).toBe(0)
    expect(removed.data[(48 * width + 48) * 4 + 3]).toBe(255)
    const trimmed = trimTransparent(removed)
    expect(trimmed.width).toBe(60)
    expect(trimmed.height).toBe(60)
  })

  it('preserves a chromatic full-bleed badge and native alpha', () => {
    const badge = { width: 96, height: 96, data: rgbaImage(96, 96, [17, 83, 191, 255]) }
    expect(removeNeutralMatte(badge, false).data).toEqual(badge.data)
    const alphaLogo = { width: 96, height: 96, data: rgbaImage(96, 96, [250, 250, 250, 255]) }
    expect(removeNeutralMatte(alphaLogo, true).data).toEqual(alphaLogo.data)
  })

  it('preserves a matte candidate below per-edge coverage and feathers only its connected transition', () => {
    const interrupted = rgbaImage(96, 96, [250, 250, 250, 255])
    for (let x = 0; x < 30; x += 1) {
      const offset = x * 4
      interrupted[offset] = 180
      interrupted[offset + 1] = 20
      interrupted[offset + 2] = 40
    }
    expect(removeNeutralMatte({ width: 96, height: 96, data: interrupted }, false).data).toEqual(interrupted)

    const feathered = rgbaImage(96, 96, [250, 250, 250, 255])
    for (let y = 18; y < 78; y += 1) {
      for (let x = 18; x < 78; x += 1) {
        const offset = (y * 96 + x) * 4
        const transition = x < 20 || x >= 76 || y < 20 || y >= 76
        feathered[offset] = transition ? 235 : 180
        feathered[offset + 1] = transition ? 235 : 20
        feathered[offset + 2] = transition ? 235 : 40
      }
    }
    const removed = removeNeutralMatte({ width: 96, height: 96, data: feathered }, false)
    expect(removed.data[(48 * 96 + 18) * 4 + 3]).toBeGreaterThan(0)
    expect(removed.data[(48 * 96 + 18) * 4 + 3]).toBeLessThan(255)
    expect(removed.data[(48 * 96 + 48) * 4 + 3]).toBe(255)
  })

  it('rejects matte removal outside alpha bounds and before a meaningful near-matte detached glyph can disappear', () => {
    const sparse = rgbaImage(96, 96, [250, 250, 250, 255])
    const dense = rgbaImage(96, 96, [250, 250, 250, 255])
    for (let y = 44; y < 52; y += 1) {
      for (let x = 44; x < 52; x += 1) {
        const offset = (y * 96 + x) * 4
        sparse[offset] = sparse[offset + 1] = sparse[offset + 2] = 10
      }
    }
    for (let y = 2; y < 94; y += 1) {
      for (let x = 2; x < 94; x += 1) {
        const offset = (y * 96 + x) * 4
        dense[offset] = dense[offset + 1] = dense[offset + 2] = 10
      }
    }
    expect(() => removeNeutralMatte({ width: 96, height: 96, data: sparse }, false)).toThrow('UNSUITABLE_LOGO')
    expect(() => removeNeutralMatte({ width: 96, height: 96, data: dense }, false)).toThrow('UNSUITABLE_LOGO')
    expect(() => removeNeutralMatte(opaqueMatteDetachedRaster(), false)).toThrow('UNSUITABLE_LOGO')
  })

  it('uses deterministic linear-light premultiplied resize and exact four-percent padding', () => {
    const source = {
      width: 4,
      height: 2,
      data: Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 128, 0, 0, 255, 128, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 128, 0, 0, 255, 128])
    }
    const first = resizeLinearPremultiplied(source, 2, 1)
    const second = resizeLinearPremultiplied(source, 2, 1)
    expect(first).toEqual(second)
    const paddingSource = { width: 100, height: 50, data: rgbaImage(100, 50, [17, 83, 191, 255]) }
    const padding = roundHalfAwayFromZero(0.04 * Math.max(paddingSource.width, paddingSource.height))
    const padded = padRaster(paddingSource, padding)
    expect(padding).toBe(4)
    expect({ width: padded.width, height: padded.height }).toEqual({ width: 108, height: 58 })
    expect(padded.data.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 0]))
    expect(padded.data.subarray((padding * padded.width + padding) * 4, (padding * padded.width + padding) * 4 + 4)).toEqual(Buffer.from([17, 83, 191, 255]))
  })
})

describe('site logo source processing and v7 publication contract', () => {
  it('maps empty, unsupported, spoofed, animated, corrupt, and digest failures to safe codes', async () => {
    const empty = Buffer.alloc(0)
    await expectCode(processSiteLogoSource(empty, sha256(empty)), 'INVALID_IMAGE')
    await expectCode(processSiteLogoSource(Buffer.alloc(SITE_LOGO_SOURCE_BYTE_LIMIT + 1), '0'.repeat(64)), 'IMAGE_TOO_LARGE')
    const externalSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://invalid.example/logo.png"/></svg>')
    await expectCode(processSiteLogoSource(externalSvg, sha256(externalSvg)), 'UNSUPPORTED_IMAGE')
    for (const unsupported of [Buffer.from('GIF89a'), Buffer.from([0x42, 0x4d, 0, 0]), Buffer.from([0x49, 0x49, 0x2a, 0])])
      await expectCode(processSiteLogoSource(unsupported, sha256(unsupported)), 'UNSUPPORTED_IMAGE')
    const corrupt = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    await expectCode(processSiteLogoSource(corrupt, sha256(corrupt)), 'INVALID_IMAGE')
    const jpeg = await encodeFixture('jpeg')
    const spoofed = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), jpeg])
    await expectCode(processSiteLogoSource(spoofed, sha256(spoofed)), 'INVALID_IMAGE')
    const apng = fakePngWithActl()
    await expectCode(processSiteLogoSource(apng, sha256(apng)), 'UNSUPPORTED_IMAGE')
    const animatedWebp = animatedWebpHeader()
    await expectCode(processSiteLogoSource(animatedWebp, sha256(animatedWebp)), 'UNSUPPORTED_IMAGE')
    const valid = await encodeFixture('png')
    await expectCode(processSiteLogoSource(valid, 'f'.repeat(64)), 'INVALID_IMAGE')
  })

  it('publishes mandatory ordinary and icon artifacts when tiny enhancement inputs are unsuitable', async () => {
    const onePixel = await onePixelFixture()
    const tiny = await processSiteLogoSource(onePixel, sha256(onePixel))
    expect({ width: tiny.logoWidth, height: tiny.logoHeight }).toEqual({ width: 1, height: 1 })
    expect(tiny.enhancement).toEqual({ status: 'unavailable', reason: 'UNSUITABLE_LOGO' })
    expect(tiny.faviconIco.readUInt16LE(2)).toBe(1)
    expect(tiny.faviconIco.readUInt16LE(4)).toBe(2)
    const iconSummaries: Array<OpaqueIconSummary & { name: string; size: number }> = []
    for (const name of Object.keys(SITE_LOGO_ICON_SIZES) as Array<keyof typeof tiny.icons>) {
      const size = SITE_LOGO_ICON_SIZES[name]
      const icon = await decodeFixtureRgba(tiny.icons[name])
      iconSummaries.push({
        name,
        size,
        ...summarizeOpaqueIcon(icon.data, icon.width, [17, 83, 191, 255], name === 'maskable512')
      })
    }
    expect(iconSummaries.map(({ name, size }) => ({ name, size }))).toEqual(Object.entries(SITE_LOGO_ICON_SIZES).map(([name, size]) => ({ name, size })))
    expect(
      iconSummaries.every(summary =>
        TRANSPARENT_ICON_ROLES[summary.name] === true
          ? summary.opaquePixels < summary.size * summary.size && summary.foregroundPixels > 0 && summary.contained
          : summary.opaquePixels === summary.size * summary.size && summary.foregroundPixels > 0 && summary.contained && summary.safe
      )
    ).toBe(true)

    const sparse = await sparseVisibleFixture()
    const sparseArtifacts = await processSiteLogoSource(sparse, sha256(sparse))
    expect({ width: sparseArtifacts.logoWidth, height: sparseArtifacts.logoHeight }).toEqual({ width: 256, height: 256 })
    expect(sparseArtifacts.logoPng.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

    const transparent = await encodeFixture('png', 256, 256, [0, 0, 0, 0])
    await expectCode(processSiteLogoSource(transparent, sha256(transparent)), 'NO_VISIBLE_PIXELS')
  })

  it(
    'preserves native alpha for transparent icon roles and embeds exact favicon PNG payloads',
    async () => {
      const source = await alphaAwareIconFixture()
      const digest = sha256(source)
      const first = await processSiteLogoSource(source, digest)
      const second = await processSiteLogoSource(Buffer.from(source), digest)
      expect(await decodeFixtureRgba(first.logoPng)).toEqual(await decodeFixtureRgba(source))
      expect(first.logoPng).toEqual(second.logoPng)
      expect(first.enhancement).toEqual(second.enhancement)

      for (const [name, bytes] of Object.entries(first.icons)) {
        const raster = await decodeFixtureRgba(bytes)
        let transparentPixels = 0
        let partialPixels = 0
        let opaquePixels = 0
        for (let offset = 3; offset < raster.data.length; offset += 4) {
          const alpha = raster.data[offset]!
          if (alpha === 0) transparentPixels += 1
          else if (alpha === 255) opaquePixels += 1
          else partialPixels += 1
        }
        if (TRANSPARENT_ICON_ROLES[name] === true) {
          expect(rgbaAt(raster.data, raster.width, 0, 0)).toEqual([0, 0, 0, 0])
          expect(transparentPixels).toBeGreaterThan(0)
          expect(partialPixels).toBeGreaterThan(0)
          expect(opaquePixels).toBeGreaterThan(0)
        } else {
          expect(transparentPixels).toBe(0)
          expect(partialPixels).toBe(0)
          expect(opaquePixels).toBe(raster.width * raster.height)
        }
      }
      const faviconDirectoryEnd = 6 + 2 * 16
      const faviconNames = ['favicon16', 'favicon32'] as const
      for (const [index, name] of faviconNames.entries()) {
        const entry = 6 + index * 16
        const length = first.faviconIco.readUInt32LE(entry + 8)
        const offset = first.faviconIco.readUInt32LE(entry + 12)
        expect(first.faviconIco.subarray(offset, offset + length)).toEqual(first.icons[name])
        expect(offset).toBe(faviconDirectoryEnd + (index === 0 ? 0 : first.icons.favicon16.length))
      }
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it('preserves arbitrary 1:4096 and inverse aspect ratios in the canonical ordinary canvas', async () => {
    const tall = await extremeAspectFixture()
    const tallArtifacts = await processSiteLogoSource(tall, sha256(tall))
    expect({ width: tallArtifacts.logoWidth, height: tallArtifacts.logoHeight }).toEqual({ width: 1, height: SITE_LOGO_CANONICAL_LONG_AXIS })
    expect(tallArtifacts.enhancement).toEqual({ status: 'unavailable', reason: 'UNSUITABLE_LOGO' })
    const wide = await encodeFixture('png', 4096, 1, [17, 83, 191, 255])
    const wideArtifacts = await processSiteLogoSource(wide, sha256(wide))
    expect({ width: wideArtifacts.logoWidth, height: wideArtifacts.logoHeight }).toEqual({ width: SITE_LOGO_CANONICAL_LONG_AXIS, height: 1 })
    expect(wideArtifacts.enhancement).toEqual({ status: 'unavailable', reason: 'UNSUITABLE_LOGO' })
  })
  it(
    'publishes the exact mandatory bundle for a legal maximum-axis simple source',
    async () => {
      const source = await extremeAspectFixture()
      expect(await fixtureMetadata(source)).toMatchObject({ width: 1, height: SITE_LOGO_MAX_INPUT_DIMENSION })
      const artifacts = await processSiteLogoSource(source, sha256(source))

      expect(Object.keys(artifacts).sort()).toEqual(['enhancement', 'faviconIco', 'icons', 'logoHeight', 'logoPng', 'logoWidth'])
      expect({ width: artifacts.logoWidth, height: artifacts.logoHeight }).toEqual({
        width: 1,
        height: SITE_LOGO_CANONICAL_LONG_AXIS
      })
      const logo = await decodeFixtureRgba(artifacts.logoPng)
      expect({ width: logo.width, height: logo.height }).toEqual({ width: 1, height: SITE_LOGO_CANONICAL_LONG_AXIS })
      expect(logo.data).toEqual(rgbaImage(1, SITE_LOGO_CANONICAL_LONG_AXIS, [17, 83, 191, 255]))

      const decodedIcons = await Promise.all(
        Object.entries(artifacts.icons).map(async ([name, bytes]) => {
          const raster = await decodeFixtureRgba(bytes)
          return { name, width: raster.width, height: raster.height, raster }
        })
      )
      expect(decodedIcons.map(({ name, width, height }) => ({ name, width, height }))).toEqual(
        Object.entries(SITE_LOGO_ICON_SIZES).map(([name, size]) => ({ name, width: size, height: size }))
      )
      expect(
        decodedIcons.every(({ name, raster, width, height }) => {
          const summary = summarizeOpaqueIcon(raster.data, width, [17, 83, 191, 255], name === 'maskable512')
          return TRANSPARENT_ICON_ROLES[name] === true
            ? summary.opaquePixels < width * height && summary.foregroundPixels > 0 && summary.contained
            : summary.opaquePixels === width * height && summary.foregroundPixels > 0 && summary.contained && summary.safe
        })
      ).toBe(true)

      const favicon = artifacts.faviconIco
      const faviconDirectoryEnd = 6 + 2 * 16
      expect([favicon.readUInt16LE(0), favicon.readUInt16LE(2), favicon.readUInt16LE(4)]).toEqual([0, 1, 2])
      expect(
        [0, 1].map(index => {
          const entry = 6 + index * 16
          return {
            width: favicon[entry]!,
            height: favicon[entry + 1]!,
            colorCount: favicon[entry + 2]!,
            reserved: favicon[entry + 3]!,
            planes: favicon.readUInt16LE(entry + 4),
            bitsPerPixel: favicon.readUInt16LE(entry + 6),
            byteLength: favicon.readUInt32LE(entry + 8),
            byteOffset: favicon.readUInt32LE(entry + 12)
          }
        })
      ).toEqual([
        {
          width: SITE_LOGO_ICON_SIZES.favicon16,
          height: SITE_LOGO_ICON_SIZES.favicon16,
          colorCount: 0,
          reserved: 0,
          planes: 1,
          bitsPerPixel: 32,
          byteLength: artifacts.icons.favicon16.length,
          byteOffset: faviconDirectoryEnd
        },
        {
          width: SITE_LOGO_ICON_SIZES.favicon32,
          height: SITE_LOGO_ICON_SIZES.favicon32,
          colorCount: 0,
          reserved: 0,
          planes: 1,
          bitsPerPixel: 32,
          byteLength: artifacts.icons.favicon32.length,
          byteOffset: faviconDirectoryEnd + artifacts.icons.favicon16.length
        }
      ])
      expect(favicon.subarray(faviconDirectoryEnd)).toEqual(Buffer.concat([artifacts.icons.favicon16, artifacts.icons.favicon32]))
      expect(artifacts.enhancement).toEqual({ status: 'unavailable', reason: 'UNSUITABLE_LOGO' })
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it('classifies oriented axis and pixel resource overflow as IMAGE_TOO_LARGE', async () => {
    const oversized = await oversizedDimensionFixture()
    expect(await fixtureMetadata(oversized)).toMatchObject({ width: 4097, height: 64 })
    expect(oversized.length).toBeLessThan(SITE_LOGO_SOURCE_BYTE_LIMIT)
    await expectCode(processSiteLogoSource(oversized, sha256(oversized)), 'IMAGE_TOO_LARGE')
    const bomb = await decompressionBombFixture()
    expect(await fixtureMetadata(bomb)).toMatchObject({ width: 4097, height: 4096 })
    expect(bomb.length).toBeLessThan(SITE_LOGO_SOURCE_BYTE_LIMIT)
    await expectCode(processSiteLogoSource(bomb, sha256(bomb)), 'IMAGE_TOO_LARGE')
  })

  it(
    'downscales only the ordinary long axis while retaining high-entropy source pixels and exact icons',
    async () => {
      const highEntropy = await highEntropyFixture()
      const artifacts = await processSiteLogoSource(highEntropy, sha256(highEntropy))
      expect({ width: artifacts.logoWidth, height: artifacts.logoHeight }).toEqual({ width: 256, height: 256 })
      expect(Object.entries(artifacts.icons).map(([name, bytes]) => [name, bytes.length])).toHaveLength(7)
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'downscales a transparent multicolor wordmark and publishes its enhancement effect',
    async () => {
      const wordmark = await transparentMulticolorDetachedFixture()
      const wordmarkArtifacts = await processSiteLogoSource(wordmark, sha256(wordmark))
      expect({ width: wordmarkArtifacts.logoWidth, height: wordmarkArtifacts.logoHeight }).toEqual({ width: 1024, height: 512 })
      expect(wordmarkArtifacts.enhancement.status).toBe('ready')
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'preserves opaque matte fidelity without changing ordinary logo pixels',
    async () => {
      for (const [polarity, foreground, background] of [
        ['dark-on-white', [12, 12, 12, 255], [250, 250, 250, 255]],
        ['light-on-black', [245, 245, 245, 255], [5, 5, 5, 255]]
      ] as const) {
        const source = await neutralMatteFixture(polarity)
        const artifacts = await processSiteLogoSource(source, sha256(source))
        const logo = await decodeFixtureRgba(artifacts.logoPng)
        expect(logo).toEqual(await decodeFixtureRgba(source))
        expect(rgbaAt(logo.data, logo.width, 0, 0)).toEqual([...background])
        expect(rgbaAt(logo.data, logo.width, 400, 240)).toEqual([...foreground])
      }
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'keeps detached opaque mattes from publishing unsuitable enhancement data',
    async () => {
      const detached = await opaqueMatteDetachedFixture()
      const detachedArtifacts = await processSiteLogoSource(detached, sha256(detached))
      expect(detachedArtifacts.enhancement).toEqual({ status: 'unavailable', reason: 'UNSUITABLE_LOGO' })
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'reports unavailable enhancement when low-alpha contrast cannot be established',
    async () => {
      const lowAlpha = await transparentLowAlphaContrastFixture()
      const lowAlphaArtifacts = await processSiteLogoSource(lowAlpha, sha256(lowAlpha))
      expect(lowAlphaArtifacts.enhancement).toEqual({ status: 'unavailable', reason: 'UNSUITABLE_LOGO' })
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'retains the existing enhancement quality gates as an isolated ready result',
    async () => {
      const source = await lowResolutionDetailedEmblemFixture()
      const artifacts = await processSiteLogoSource(source, sha256(source))
      expect(artifacts.enhancement.status).toBe('ready')
      if (artifacts.enhancement.status !== 'ready') return
      expect({
        width: artifacts.enhancement.normalizedWidth,
        height: artifacts.enhancement.normalizedHeight,
        count: artifacts.enhancement.particleCount
      }).toEqual({
        width: LOW_RESOLUTION_EMBLEM_VECTOR.normalizedWidth,
        height: LOW_RESOLUTION_EMBLEM_VECTOR.normalizedHeight,
        count: LOW_RESOLUTION_EMBLEM_VECTOR.particleCount
      })
      const parsed = parseParticleV1(artifacts.enhancement.particleV1)
      expect(parsed).toMatchObject({
        width: artifacts.enhancement.normalizedWidth,
        height: artifacts.enhancement.normalizedHeight,
        count: artifacts.enhancement.particleCount
      })
      expect(particleMaskIou(await normalizedNativeAlphaRaster(source), artifacts.enhancement.particleV1)).toBeGreaterThanOrEqual(0.75)
      const logo = await decodeFixtureRgba(artifacts.logoPng)
      expect({ width: logo.width, height: logo.height }).toEqual({ width: 481, height: 481 })
      const effect = await decodeFixtureRgba(artifacts.enhancement.effectStaticPng)
      expect({ width: effect.width, height: effect.height }).toEqual({
        width: LOW_RESOLUTION_EMBLEM_VECTOR.normalizedWidth,
        height: LOW_RESOLUTION_EMBLEM_VECTOR.normalizedHeight
      })
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'auto-orients profiled EXIF input and preserves the arbitrary aspect in ordinary dimensions',
    async () => {
      const source = await orientedProfiledJpegFixture()
      expect(await fixtureMetadata(source)).toEqual({ width: 1200, height: 720, orientation: 6, hasProfile: true })
      const artifacts = await processSiteLogoSource(source, sha256(source))
      expect({ width: artifacts.logoWidth, height: artifacts.logoHeight }).toEqual({ width: 614, height: 1024 })
      expect(artifacts.enhancement.status).toBe('ready')
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'produces deterministic ordinary, icon, ICO, and optional enhancement bytes',
    async () => {
      const source = await squareBadgeFixture()
      const digest = sha256(source)
      const first = await processSiteLogoSource(source, digest)
      const second = await processSiteLogoSource(Buffer.from(source), digest)
      expect(first).toEqual(second)
      const artifactBytes = (artifacts: typeof first): Buffer[] => [
        artifacts.logoPng,
        ...Object.values(artifacts.icons),
        artifacts.faviconIco,
        ...(artifacts.enhancement.status === 'ready' ? [artifacts.enhancement.particleV1, artifacts.enhancement.effectStaticPng] : [])
      ]
      expect(artifactBytes(first).map(sha256)).toEqual(artifactBytes(second).map(sha256))
      expect(new Set(artifactBytes(first).map(sha256)).size).toBeGreaterThan(3)
      expect(first.logoPng.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(first.faviconIco.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
      expect(() => assertArtifactBudgets(first)).not.toThrow()
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it('enforces mandatory icon/ordinary budgets and optional enhancement budgets', async () => {
    const source = await onePixelFixture()
    const valid = await processSiteLogoSource(source, sha256(source))
    expect(() => assertArtifactBudgets({ ...valid, icons: { ...valid.icons, favicon16: Buffer.alloc(SITE_LOGO_ICON_PNG_BYTE_LIMIT + 1) } })).toThrow(
      'ARTIFACT_TOO_LARGE'
    )
    expect(() => assertArtifactBudgets({ ...valid, logoPng: Buffer.alloc(SITE_LOGO_PNG_BYTE_LIMIT + 1) })).toThrow('ARTIFACT_TOO_LARGE')
    expect(() => assertArtifactBudgets({ ...valid, faviconIco: Buffer.alloc(SITE_LOGO_FAVICON_ICO_BYTE_LIMIT + 1) })).toThrow('ARTIFACT_TOO_LARGE')
    if (valid.enhancement.status === 'ready') {
      expect(() =>
        assertArtifactBudgets({
          ...valid,
          enhancement: { ...valid.enhancement, effectStaticPng: Buffer.alloc(SITE_LOGO_STATIC_PNG_BYTE_LIMIT + 1) }
        })
      ).toThrow('ARTIFACT_TOO_LARGE')
      expect(valid.enhancement.particleV1.length).toBeLessThanOrEqual(SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT)
    }
  })
})
