import { createHash } from 'node:crypto'
import { describe, expect, it } from '../bun-test.mts'

import {
  SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT,
  SITE_LOGO_PIPELINE_VERSION,
  SITE_LOGO_SOURCE_BYTE_LIMIT,
  SiteLogoProcessingError,
  type SiteLogoProcessingErrorCode,
  assertArtifactBudgets,
  crc32,
  domainDigest64,
  encodeParticleV1,
  encodeRgbaPng,
  frameOrdinaryLogo,
  padRaster,
  parseParticleV1,
  processSiteLogoSource,
  rasterizeParticles,
  reconstructedMaskIou,
  removeNeutralMatte,
  resizeLinearPremultiplied,
  roundHalfAwayFromZero,
  trimTransparent
} from '../../helpers/site-logo-processing.ts'
import {
  FIXED_SAMPLE_DIGEST64,
  FIXED_SEED_DIGEST64,
  FIXED_VECTOR_BINARY_HEX,
  FIXED_VECTOR_BINARY_SHA256,
  FIXED_VECTOR_IOU,
  FIXED_VECTOR_RECORDS,
  FIXED_VECTOR_SOURCE_HASH,
  FIXED_VECTOR_STATIC_PNG_SHA256,
  SQUARE_BADGE_VECTOR,
  decodeFixtureRgba,
  decompressionBombFixture,
  encodeFixture,
  fixedVectorRaster,
  fixedVectorStaticRaster,
  fixtureMetadata,
  lowResolutionDetailedEmblemFixture,
  neutralMatteFixture,
  opaqueMatteDetachedFixture,
  opaqueMatteDetachedRaster,
  orientedProfiledJpegFixture,
  oversizedDimensionFixture,
  rgbaImage,
  sha256,
  squareBadgeFixture,
  sparseVisibleFixture,
  tallFineDetailFixture,
  transparentContrastFixture,
  transparentLowAlphaContrastFixture,
  transparentMulticolorDetachedFixture
} from './site-logo-processing.fixtures.ts'

const expectCode = async (promise: Promise<unknown>, code: SiteLogoProcessingErrorCode): Promise<void> => {
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

const containsRgba = (data: Buffer, pixel: readonly [number, number, number, number]): boolean => {
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset] === pixel[0] && data[offset + 1] === pixel[1] && data[offset + 2] === pixel[2] && data[offset + 3] === pixel[3]) return true
  }
  return false
}

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
  it('uses pipeline version two and rounds every tie away from zero', () => {
    expect(SITE_LOGO_PIPELINE_VERSION).toBe(2)
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

  it('matches the literal 8x8 core and contrast-ring rasters, IoU, and deterministic static PNG hash', () => {
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
    expect(FIXED_VECTOR_IOU).toBeGreaterThanOrEqual(0.9)
    expect(sha256(encodeRgbaPng(expectedStatic))).toBe(FIXED_VECTOR_STATIC_PNG_SHA256)
  })

  it('retains the quantitative square-badge normalization and dynamic-count vector', () => {
    const vector = SQUARE_BADGE_VECTOR
    expect(
      createHash('sha256')
        .update(rgbaImage(vector.sourceWidth, vector.sourceHeight, vector.sourceRgba))
        .digest('hex')
    ).toBe(vector.sourceSha256)
    expect(vector.sourceByteLength).toBe(4_194_304)
    expect(vector.normalizedWidth * vector.normalizedHeight).toBe(vector.normalizedPixelCount)
    expect(Math.min(16_000, Math.max(4_000, roundHalfAwayFromZero(16_000 * Math.sqrt(vector.occupancy)), 12))).toBe(vector.particleCount)
  })
})

describe('site logo masking, normalization, and framing', () => {
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

  it('adds one adaptive exterior keyline without changing source-region bytes', () => {
    const source = { width: 64, height: 32, data: rgbaImage(64, 32, [250, 250, 250, 255]) }
    const framed = frameOrdinaryLogo(source)
    const padding = roundHalfAwayFromZero(0.1 * 64)
    expect(framed.keylineAdded).toBe(true)
    expect(framed.raster.width).toBe(64 + 2 * padding)
    expect(framed.raster.height).toBe(32 + 2 * padding)
    for (let y = 0; y < source.height; y += 1) {
      const actual = framed.raster.data.subarray(
        ((y + padding) * framed.raster.width + padding) * 4,
        ((y + padding) * framed.raster.width + padding + source.width) * 4
      )
      expect(actual).toEqual(source.data.subarray(y * source.width * 4, (y + 1) * source.width * 4))
    }
    expect(framed.raster.data[(padding * framed.raster.width + padding - 1) * 4 + 3]).toBe(255)
    expect(framed.raster.data[3]).toBe(0)
  })
})

describe('site logo source processing and hard gates', () => {
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

  it('rejects tiny, fully transparent, and sampling-infeasible decoded images with safe codes', async () => {
    const tiny = await encodeFixture('png', 63, 64)
    await expectCode(processSiteLogoSource(tiny, sha256(tiny)), 'INVALID_IMAGE')
    const transparent = await encodeFixture('png', 256, 256, [0, 0, 0, 0])
    await expectCode(processSiteLogoSource(transparent, sha256(transparent)), 'NO_VISIBLE_PIXELS')
    const sparse = await sparseVisibleFixture()
    await expectCode(processSiteLogoSource(sparse, sha256(sparse)), 'UNSUITABLE_LOGO')
  })

  it('rejects a valid over-dimension image and a compressed pixel-count bomb before processing', async () => {
    const oversized = await oversizedDimensionFixture()
    expect(await fixtureMetadata(oversized)).toMatchObject({ width: 4097, height: 64 })
    expect(oversized.length).toBeLessThan(SITE_LOGO_SOURCE_BYTE_LIMIT)
    await expectCode(processSiteLogoSource(oversized, sha256(oversized)), 'INVALID_IMAGE')
    const bomb = await decompressionBombFixture()
    expect(await fixtureMetadata(bomb)).toMatchObject({ width: 4097, height: 4096 })
    expect(bomb.length).toBeLessThan(SITE_LOGO_SOURCE_BYTE_LIMIT)
    await expectCode(processSiteLogoSource(bomb, sha256(bomb)), 'IMAGE_TOO_LARGE')
  })

  it(
    'accepts a transparent multicolor WebP wordmark with a detached component and preserves record order and source colors',
    async () => {
      const source = await transparentMulticolorDetachedFixture()
      const artifacts = await processSiteLogoSource(source, sha256(source))
      expect({ width: artifacts.normalizedWidth, height: artifacts.normalizedHeight }).toEqual({ width: 1106, height: 606 })
      const parsed = parseParticleV1(artifacts.particleV1)
      const sourceIndices = parsed.records.map(record => Math.round(record.y) * parsed.width + Math.round(record.x))
      expect(sourceIndices.every((sourceIndex, index) => index === 0 || sourceIndex > sourceIndices[index - 1]!)).toBe(true)
      const logo = await decodeFixtureRgba(artifacts.logoPng)
      expect({ width: logo.width, height: logo.height }).toEqual({ width: 1228, height: 728 })
      expect(containsRgba(logo.data, [220, 40, 60, 255])).toBe(true)
      expect(containsRgba(logo.data, [30, 180, 90, 255])).toBe(true)
      expect(containsRgba(logo.data, [30, 110, 220, 255])).toBe(true)
      expect(containsRgba(logo.data, [245, 180, 30, 255])).toBe(true)
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )
  it(
    'accepts a detailed 481px transparent emblem by scaling its reconstruction footprint to the normalized canvas',
    async () => {
      const source = await lowResolutionDetailedEmblemFixture()
      const artifacts = await processSiteLogoSource(source, sha256(source))
      expect({ width: artifacts.normalizedWidth, height: artifacts.normalizedHeight }).toEqual({ width: 460, height: 461 })
      expect(parseParticleV1(artifacts.particleV1)).toMatchObject({
        width: artifacts.normalizedWidth,
        height: artifacts.normalizedHeight,
        count: artifacts.particleCount
      })
      const logo = await decodeFixtureRgba(artifacts.logoPng)
      expect({ width: logo.width, height: logo.height }).toEqual({ width: 512, height: 513 })
      expect(rgbaAt(logo.data, logo.width, 0, 0)).toEqual([0, 0, 0, 0])
      expect(containsRgba(logo.data, [249, 161, 52, 255])).toBe(true)
      expect(containsRgba(logo.data, [75, 81, 93, 255])).toBe(true)
      const effect = await decodeFixtureRgba(artifacts.effectStaticPng)
      expect({ width: effect.width, height: effect.height }).toEqual({ width: 460, height: 461 })
      expect(rgbaAt(effect.data, effect.width, 0, 0)).toEqual([0, 0, 0, 0])
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'accepts the exact square-badge vector and preserves its ordinary-logo source region',
    async () => {
      const source = await squareBadgeFixture()
      const artifacts = await processSiteLogoSource(source, sha256(source))
      expect({
        width: artifacts.normalizedWidth,
        height: artifacts.normalizedHeight,
        count: artifacts.particleCount
      }).toEqual({
        width: SQUARE_BADGE_VECTOR.normalizedWidth,
        height: SQUARE_BADGE_VECTOR.normalizedHeight,
        count: SQUARE_BADGE_VECTOR.particleCount
      })
      const logo = await decodeFixtureRgba(artifacts.logoPng)
      expect({ width: logo.width, height: logo.height }).toEqual({ width: 1228, height: 1228 })
      expect(rgbaAt(logo.data, logo.width, 0, 0)).toEqual([0, 0, 0, 0])
      for (const [x, y] of [
        [102, 102],
        [1125, 102],
        [102, 1125],
        [1125, 1125],
        [614, 614]
      ])
        expect(rgbaAt(logo.data, logo.width, x!, y!)).toEqual([...SQUARE_BADGE_VECTOR.sourceRgba])
      const effect = await decodeFixtureRgba(artifacts.effectStaticPng)
      expect({ width: effect.width, height: effect.height }).toEqual({
        width: SQUARE_BADGE_VECTOR.normalizedWidth,
        height: SQUARE_BADGE_VECTOR.normalizedHeight
      })
      expect(rgbaAt(effect.data, effect.width, 0, 0)).toEqual([0, 0, 0, 0])
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'accepts both neutral matte polarities without retaining a matte rectangle',
    async () => {
      for (const [polarity, foreground] of [
        ['dark-on-white', [12, 12, 12, 255]],
        ['light-on-black', [245, 245, 245, 255]]
      ] as const) {
        const source = await neutralMatteFixture(polarity)
        const artifacts = await processSiteLogoSource(source, sha256(source))
        expect({ width: artifacts.normalizedWidth, height: artifacts.normalizedHeight }).toEqual({ width: 692, height: 436 })
        const logo = await decodeFixtureRgba(artifacts.logoPng)
        expect({ width: logo.width, height: logo.height }).toEqual({ width: 768, height: 512 })
        expect(rgbaAt(logo.data, logo.width, 0, 0)).toEqual([0, 0, 0, 0])
        expect(rgbaAt(logo.data, logo.width, 384, 256)).toEqual([...foreground])
      }
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'rejects an opaque matte source rather than publishing after its meaningful detached glyph is lost',
    async () => {
      const source = await opaqueMatteDetachedFixture()
      await expectCode(processSiteLogoSource(source, sha256(source)), 'UNSUITABLE_LOGO')
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'adds deterministic neutral rings to static near-white and near-black particles without a backplate',
    async () => {
      for (const [polarity, foreground, keyline] of [
        ['near-white', [250, 250, 250, 255], [0, 0, 0, 255]],
        ['near-black', [5, 5, 5, 255], [255, 255, 255, 255]]
      ] as const) {
        const source = await transparentContrastFixture(polarity)
        const artifacts = await processSiteLogoSource(source, sha256(source))
        expect({ width: artifacts.normalizedWidth, height: artifacts.normalizedHeight }).toEqual({ width: 692, height: 436 })
        const logo = await decodeFixtureRgba(artifacts.logoPng)
        expect({ width: logo.width, height: logo.height }).toEqual({ width: 768, height: 512 })
        expect(rgbaAt(logo.data, logo.width, 384, 256)).toEqual([...foreground])
        expect(rgbaAt(logo.data, logo.width, 63, 256)).toEqual([...keyline])
        expect(rgbaAt(logo.data, logo.width, 0, 0)).toEqual([0, 0, 0, 0])
        const effect = await decodeFixtureRgba(artifacts.effectStaticPng)
        expect(containsRgba(effect.data, foreground)).toBe(true)
        expect(containsRgba(effect.data, keyline)).toBe(true)
        expect(rgbaAt(effect.data, effect.width, 0, 0)).toEqual([0, 0, 0, 0])
      }
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'rejects publication when low-alpha particles cannot reach contrast coverage on both surfaces',
    async () => {
      const source = await transparentLowAlphaContrastFixture()
      await expectCode(processSiteLogoSource(source, sha256(source)), 'UNSUITABLE_LOGO')
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'accepts a 1:4 tall fine-detail mark without changing its authoritative aspect',
    async () => {
      const source = await tallFineDetailFixture()
      const artifacts = await processSiteLogoSource(source, sha256(source))
      expect({ width: artifacts.normalizedWidth, height: artifacts.normalizedHeight }).toEqual({ width: 338, height: 1106 })
      expect((artifacts.normalizedWidth - 82) / (artifacts.normalizedHeight - 82)).toBe(0.25)
      expect(artifacts.particleCount).toBeGreaterThanOrEqual(4_000)
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'accepts and auto-orients a profiled EXIF JPEG before normalization',
    async () => {
      const source = await orientedProfiledJpegFixture()
      expect(await fixtureMetadata(source)).toEqual({ width: 1200, height: 720, orientation: 6, hasProfile: true })
      const artifacts = await processSiteLogoSource(source, sha256(source))
      expect({ width: artifacts.normalizedWidth, height: artifacts.normalizedHeight }).toEqual({ width: 696, height: 1106 })
      const logo = await decodeFixtureRgba(artifacts.logoPng)
      expect({ width: logo.width, height: logo.height }).toEqual({ width: 818, height: 1228 })
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it(
    'produces byte-identical complete artifacts for identical PNG bytes and hash',
    async () => {
      const source = await encodeFixture('png')
      const digest = sha256(source)
      const first = await processSiteLogoSource(source, digest)
      const second = await processSiteLogoSource(Buffer.from(source), digest)
      expect(first).toEqual(second)
      const artifactHashes = (artifacts: typeof first): string[] => [artifacts.logoPng, artifacts.particleV1, artifacts.effectStaticPng].map(sha256)
      expect(artifactHashes(first)).toEqual(artifactHashes(second))
      expect(new Set(artifactHashes(first)).size).toBe(3)
      expect(first.particleCount).toBeGreaterThanOrEqual(4_000)
      expect(first.particleV1.length).toBeLessThanOrEqual(SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT)
      expect(parseParticleV1(first.particleV1)).toMatchObject({
        width: first.normalizedWidth,
        height: first.normalizedHeight,
        count: first.particleCount
      })
      expect(first.logoPng.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(first.effectStaticPng.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(() => assertArtifactBudgets(first)).not.toThrow()
    },
    GENERATED_CORPUS_TIMEOUT_MS
  )

  it('enforces raw, gzip, ordinary PNG, and static PNG publication budgets', () => {
    const base = { logoPng: Buffer.alloc(1), particleV1: Buffer.alloc(1), effectStaticPng: Buffer.alloc(1) }
    expect(() => assertArtifactBudgets(base)).not.toThrow()
    expect(() => assertArtifactBudgets({ ...base, particleV1: Buffer.alloc(SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT + 1) })).toThrow('ARTIFACT_TOO_LARGE')
    expect(() => assertArtifactBudgets({ ...base, logoPng: Buffer.alloc(512 * 1024 + 1) })).toThrow('ARTIFACT_TOO_LARGE')
    expect(() => assertArtifactBudgets({ ...base, effectStaticPng: Buffer.alloc(1024 * 1024 + 1) })).toThrow('ARTIFACT_TOO_LARGE')
  })
})
