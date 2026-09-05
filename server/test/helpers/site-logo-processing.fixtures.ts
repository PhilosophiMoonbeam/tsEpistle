import { createHash } from 'node:crypto'
import sharp from 'sharp'

import type { ParticleRecord, RgbaRaster } from '../../helpers/site-logo-processing.ts'

export const FIXED_VECTOR_SOURCE_HASH = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
export const FIXED_SAMPLE_DIGEST64 = 0x6d6c4ab519d7928bn
export const FIXED_SEED_DIGEST64 = 0x2cf3279b3fcf3227n

export const FIXED_VECTOR_RECORDS: readonly ParticleRecord[] = [
  {
    sourceIndex: 26,
    x: 2,
    y: 3,
    xEncoded: -14_043,
    yEncoded: 4_681,
    depth: -19,
    rgba: [220, 40, 60, 200],
    size: 85,
    seed: 1_234
  },
  {
    sourceIndex: 37,
    x: 5,
    y: 4,
    xEncoded: 14_043,
    yEncoded: -4_681,
    depth: 77,
    rgba: [30, 110, 220, 160],
    size: 120,
    seed: 54_321
  }
]

export const FIXED_VECTOR_BINARY_HEX =
  '545345500107380008000000080000000200000018000000cf8f46fd3800000040000000420000004a0000004c000000500000000000000025c94912db36b7eded4ddc283cc81e6edca05578d20431d4'
export const FIXED_VECTOR_BINARY_SHA256 = 'e0545ed550cadb34caaacf314afcfcf6800ca1fdfe7a3e46ce304a09f2ad6185'
export const FIXED_VECTOR_RASTER_BASE64 =
  '3Cg8bdwoPLu/M1XCVVquoh9t25webtybHm7ccx5u3B7cKDzIwDJTzmBWpelaWKnrRWC8yR5u3KAebtygHm7cmdwoPMh7TI7hWlip61pYqetYWavmHm7coB5u3KAebtyg3Cg8yF5WpulaWKnrWlip61hZq+YebtygHm7coB5u3KDcKDzIXlam6VpYqetaWKnrRWC8yR5u3KAebtygHm7coNwoPG11TpPUWFmr5kVgvMkfbduhHm7coB5u3KAebtygAAAAAB5u3B4ebtyZHm7coB5u3KAebtygHm7coB5u3JkAAAAAAAAAAB5u3B4ebtxzHm7cmx5u3JsebtxzHm7cHg=='
export const FIXED_VECTOR_STATIC_RASTER_BASE64 =
  'AAAAuwAAAMgAAADZAAAA5QAAALYAAACgAAAAmwAAAE5BDBLIfRci2UAMEusZFCbrDC1b5hE/f6UHGDCgAAAAoMMjNcpKDRTpSh0061VWpesUS5brGl+/uB5s2aAHGDCgoR0s0UYNE+tSOWzrVVeo6xRLlusaX7+4Hm7coBJBg6AqCAvRQAwS6004a+spT5zrFU2Z5h1r1qUebtygEkGDoAAAAL0AAADpBBAh6xVLl+YaYcG2Hm7coB5s2aAHGDCgAAAADQAAAG4AAAC4BhcvpRJBg6ASQYOgBxgwoAAAAKAAAAAAAAAAAAAAAE4AAACbAAAAoAAAAKAAAACbAAAATg=='
export const FIXED_VECTOR_STATIC_PNG_SHA256 = 'dbbe1e045079b0c9aa4c1a8212c6da58139436810a124be91f55e13672aacbd6'
export const FIXED_VECTOR_IOU = 0.9990365472862591

export const fixedVectorRaster = (): RgbaRaster => ({
  width: 8,
  height: 8,
  data: Buffer.from(FIXED_VECTOR_RASTER_BASE64, 'base64')
})

export const fixedVectorStaticRaster = (): RgbaRaster => ({
  width: 8,
  height: 8,
  data: Buffer.from(FIXED_VECTOR_STATIC_RASTER_BASE64, 'base64')
})

export const SQUARE_BADGE_VECTOR = {
  sourceWidth: 1024,
  sourceHeight: 1024,
  sourceRgba: [17, 83, 191, 255] as const,
  sourceByteLength: 4_194_304,
  sourceSha256: 'cbddb7ad4cbc96a0faf241c4fd7a3c7955cfb58f509b10f30be2a93e61e631ff',
  padding: 41,
  normalizedWidth: 1106,
  normalizedHeight: 1106,
  normalizedPixelCount: 1_223_236,
  occupancy: 1_048_576 / 1_223_236,
  particleCount: 7_407
} as const

export const LOW_RESOLUTION_EMBLEM_VECTOR = {
  sourceWidth: 481,
  sourceHeight: 481,
  normalizedWidth: 460,
  normalizedHeight: 461,
  particleCount: 4_704
} as const

export const rgbaImage = (width: number, height: number, pixel: readonly [number, number, number, number]): Buffer => {
  const data = Buffer.alloc(width * height * 4)
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = pixel[0]
    data[offset + 1] = pixel[1]
    data[offset + 2] = pixel[2]
    data[offset + 3] = pixel[3]
  }
  return data
}

export const encodeFixture = async (
  format: 'png' | 'jpeg' | 'webp',
  width = 512,
  height = 512,
  pixel: readonly [number, number, number, number] = [17, 83, 191, 255]
): Promise<Buffer> => {
  const image = sharp(rgbaImage(width, height, pixel), { raw: { width, height, channels: 4 } })
  if (format === 'png') return await image.png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer()
  if (format === 'jpeg')
    return await image
      .flatten({ background: pixel.slice(0, 3) })
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer()
  return await image.webp({ lossless: true }).toBuffer()
}

const paintRectangle = (
  data: Buffer,
  width: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  pixel: readonly [number, number, number, number]
): void => {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 4
      data[offset] = pixel[0]
      data[offset + 1] = pixel[1]
      data[offset + 2] = pixel[2]
      data[offset + 3] = pixel[3]
    }
  }
}

const paintCircle = (data: Buffer, width: number, centerX: number, centerY: number, radius: number, pixel: readonly [number, number, number, number]): void => {
  const radiusSquared = radius * radius
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      const dx = x - centerX
      const dy = y - centerY
      if (dx * dx + dy * dy > radiusSquared) continue
      const offset = (y * width + x) * 4
      data[offset] = pixel[0]
      data[offset + 1] = pixel[1]
      data[offset + 2] = pixel[2]
      data[offset + 3] = pixel[3]
    }
  }
}

const encodeRgbaFixture = async (data: Buffer, width: number, height: number, format: 'png-alpha' | 'png-opaque' | 'webp-alpha'): Promise<Buffer> => {
  const image = sharp(data, { raw: { width, height, channels: 4 } })
  if (format === 'png-alpha') return await image.png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer()
  if (format === 'png-opaque') return await image.removeAlpha().png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer()
  return await image.webp({ lossless: true }).toBuffer()
}

export const transparentMulticolorDetachedFixture = async (): Promise<Buffer> => {
  const width = 1280
  const height = 640
  const data = rgbaImage(width, height, [0, 0, 0, 0])
  paintRectangle(data, width, 80, 192, 400, 576, [220, 40, 60, 255])
  paintRectangle(data, width, 416, 192, 736, 576, [30, 180, 90, 255])
  paintRectangle(data, width, 752, 192, 1120, 576, [30, 110, 220, 255])
  paintCircle(data, width, 1040, 100, 56, [245, 180, 30, 255])
  return await encodeRgbaFixture(data, width, height, 'webp-alpha')
}
export const lowResolutionDetailedEmblemFixture = async (): Promise<Buffer> => {
  const width = 481
  const height = 481
  const data = rgbaImage(width, height, [0, 0, 0, 0])
  const orange = [249, 161, 52, 255] as const
  const graphite = [75, 81, 93, 255] as const
  paintCircle(data, width, 270, 280, 175, orange)
  paintCircle(data, width, 270, 280, 116, [0, 0, 0, 0])
  paintRectangle(data, width, 30, 65, 325, 115, graphite)
  paintCircle(data, width, 55, 90, 35, graphite)
  paintRectangle(data, width, 145, 105, 178, 435, graphite)
  paintCircle(data, width, 115, 155, 10, orange)
  paintCircle(data, width, 235, 45, 8, [249, 161, 52, 160])
  paintCircle(data, width, 105, 35, 6, graphite)
  return await encodeRgbaFixture(data, width, height, 'png-alpha')
}

export const squareBadgeFixture = async (): Promise<Buffer> =>
  await encodeRgbaFixture(
    rgbaImage(SQUARE_BADGE_VECTOR.sourceWidth, SQUARE_BADGE_VECTOR.sourceHeight, SQUARE_BADGE_VECTOR.sourceRgba),
    SQUARE_BADGE_VECTOR.sourceWidth,
    SQUARE_BADGE_VECTOR.sourceHeight,
    'png-alpha'
  )

export const neutralMatteFixture = async (polarity: 'dark-on-white' | 'light-on-black'): Promise<Buffer> => {
  const width = 800
  const height = 480
  const background = polarity === 'dark-on-white' ? ([250, 250, 250, 255] as const) : ([5, 5, 5, 255] as const)
  const foreground = polarity === 'dark-on-white' ? ([12, 12, 12, 255] as const) : ([245, 245, 245, 255] as const)
  const data = rgbaImage(width, height, background)
  paintRectangle(data, width, 80, 48, 720, 432, foreground)
  return await encodeRgbaFixture(data, width, height, 'png-opaque')
}

export const opaqueMatteDetachedRaster = (): RgbaRaster => {
  const width = 800
  const height = 480
  const data = rgbaImage(width, height, [250, 250, 250, 255])
  paintRectangle(data, width, 120, 120, 680, 360, [24, 82, 180, 255])
  paintRectangle(data, width, 40, 40, 80, 80, [238, 238, 238, 255])
  return { width, height, data }
}

export const opaqueMatteDetachedFixture = async (): Promise<Buffer> => {
  const raster = opaqueMatteDetachedRaster()
  return await encodeRgbaFixture(raster.data, raster.width, raster.height, 'png-opaque')
}

export const transparentContrastFixture = async (polarity: 'near-white' | 'near-black'): Promise<Buffer> => {
  const width = 800
  const height = 480
  const foreground = polarity === 'near-white' ? ([250, 250, 250, 255] as const) : ([5, 5, 5, 255] as const)
  const data = rgbaImage(width, height, [0, 0, 0, 0])
  paintRectangle(data, width, 80, 48, 720, 432, foreground)
  return await encodeRgbaFixture(data, width, height, 'png-alpha')
}

export const transparentLowAlphaContrastFixture = async (): Promise<Buffer> => {
  const width = 512
  const height = 512
  const data = rgbaImage(width, height, [0, 0, 0, 0])
  paintRectangle(data, width, 32, 32, 480, 480, [250, 250, 250, 128])
  return await encodeRgbaFixture(data, width, height, 'png-alpha')
}

export const sparseVisibleFixture = async (): Promise<Buffer> => {
  const width = 256
  const height = 256
  const data = rgbaImage(width, height, [0, 0, 0, 0])
  paintRectangle(data, width, 112, 112, 144, 144, [17, 83, 191, 255])
  return await encodeRgbaFixture(data, width, height, 'png-alpha')
}

export const tallFineDetailFixture = async (): Promise<Buffer> => {
  const width = 320
  const height = 1280
  const data = rgbaImage(width, height, [0, 0, 0, 0])
  paintRectangle(data, width, 32, 128, 288, 1152, [70, 120, 210, 255])
  paintRectangle(data, width, 80, 160, 88, 1120, [230, 80, 65, 255])
  paintRectangle(data, width, 232, 160, 240, 1120, [65, 190, 125, 255])
  paintRectangle(data, width, 48, 384, 272, 396, [245, 190, 45, 255])
  paintRectangle(data, width, 48, 884, 272, 896, [245, 190, 45, 255])
  return await encodeRgbaFixture(data, width, height, 'png-alpha')
}

export const orientedProfiledJpegFixture = async (): Promise<Buffer> => {
  const width = 1200
  const height = 720
  return await sharp(rgbaImage(width, height, [32, 96, 192, 255]), { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer()
}

export const oversizedDimensionFixture = async (): Promise<Buffer> =>
  await sharp({
    create: {
      width: 4097,
      height: 64,
      channels: 4,
      background: { r: 17, g: 83, b: 191, alpha: 1 }
    }
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer()

export const decompressionBombFixture = async (): Promise<Buffer> =>
  await sharp({
    create: {
      width: 4097,
      height: 4096,
      channels: 4,
      background: { r: 17, g: 83, b: 191, alpha: 1 }
    }
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer()

export const fixtureMetadata = async (
  bytes: Buffer
): Promise<{ width: number | undefined; height: number | undefined; orientation: number | undefined; hasProfile: boolean }> => {
  const metadata = await sharp(bytes).metadata()
  return {
    width: metadata.width,
    height: metadata.height,
    orientation: metadata.orientation,
    hasProfile: metadata.icc !== undefined && metadata.icc.length > 0
  }
}

export const decodeFixtureRgba = async (bytes: Buffer): Promise<RgbaRaster> => {
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: decoded.info.width, height: decoded.info.height, data: Buffer.from(decoded.data) }
}

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
