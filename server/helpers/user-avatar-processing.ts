import sharp, { type Metadata } from 'sharp'

export const USER_AVATAR_SOURCE_BYTE_LIMIT = 1024 * 1024
export const USER_AVATAR_MAX_INPUT_DIMENSION = 4096
export const USER_AVATAR_MAX_INPUT_PIXELS = 16_777_216
export const USER_AVATAR_MAX_OUTPUT_BYTES = 1024 * 1024
export const USER_AVATAR_OUTPUT_DIMENSION = 512

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8])
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii')
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii')

type AvatarImageFormat = 'png' | 'jpeg' | 'webp'

export type UserAvatarProcessingErrorCode = 'UNSUPPORTED_IMAGE' | 'IMAGE_TOO_LARGE' | 'INVALID_IMAGE' | 'PROCESSING_FAILED'

export class UserAvatarProcessingError extends Error {
  readonly code: UserAvatarProcessingErrorCode
  readonly status: number

  constructor(code: UserAvatarProcessingErrorCode, message: string, status: number) {
    super(message)
    this.name = 'UserAvatarProcessingError'
    this.code = code
    this.status = status
  }
}

const fail = (code: UserAvatarProcessingErrorCode): never => {
  const messages: Record<UserAvatarProcessingErrorCode, string> = {
    UNSUPPORTED_IMAGE: 'Only static PNG, JPEG, and WebP images are supported.',
    IMAGE_TOO_LARGE: 'Avatar image exceeds the allowed size or dimensions.',
    INVALID_IMAGE: 'Avatar image is invalid or could not be decoded.',
    PROCESSING_FAILED: 'Avatar image could not be processed.'
  }
  throw new UserAvatarProcessingError(code, messages[code], code === 'IMAGE_TOO_LARGE' ? 413 : code === 'UNSUPPORTED_IMAGE' ? 400 : 400)
}

const isStandaloneMarker = (marker: number): boolean => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
const isStartOfFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)

/** JPEG framing check that rejects bytes after the final EOI marker. */
const hasExactJpegFraming = (bytes: Buffer): boolean => {
  if (bytes.length < 4 || !bytes.subarray(0, 2).equals(JPEG_SIGNATURE)) return false

  let offset = 2
  let sawFrame = false
  let sawScan = false
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) return false
    const marker = bytes[offset++]!
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length
    if (marker === 0x00 || marker === 0xd8) return false
    if (isStandaloneMarker(marker)) continue
    if (offset + 2 > bytes.length) return false
    const segmentLength = bytes.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false
    if (isStartOfFrame(marker)) sawFrame = true
    offset += segmentLength

    if (marker !== 0xda) continue
    sawScan = true
    let resumeAtMarker = false
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const markerStart = offset
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
      if (offset >= bytes.length) return false
      const scanMarker = bytes[offset++]!
      if (scanMarker === 0x00 || isStandaloneMarker(scanMarker)) continue
      if (scanMarker === 0xd9) return sawFrame && offset === bytes.length
      offset = markerStart
      resumeAtMarker = true
      break
    }
    if (!resumeAtMarker) return false
  }
  return false
}

const inputFormat = (bytes: Buffer): AvatarImageFormat => {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    let offset = PNG_SIGNATURE.length
    let sawHeader = false
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset)
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      const end = offset + 12 + length
      if (end < offset || end > bytes.length) fail('INVALID_IMAGE')
      if (!sawHeader && type !== 'IHDR') fail('INVALID_IMAGE')
      if (type === 'IHDR' && length !== 13) fail('INVALID_IMAGE')
      if (type === 'acTL') fail('UNSUPPORTED_IMAGE')
      sawHeader = true
      offset = end
      if (type === 'IEND') {
        if (length !== 0 || offset !== bytes.length || !sawHeader) fail('INVALID_IMAGE')
        return 'png'
      }
    }
    fail('INVALID_IMAGE')
  }

  if (bytes.length >= 4 && bytes.subarray(0, 2).equals(JPEG_SIGNATURE)) {
    if (!hasExactJpegFraming(bytes)) fail('INVALID_IMAGE')
    return 'jpeg'
  }

  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(RIFF_SIGNATURE) && bytes.subarray(8, 12).equals(WEBP_SIGNATURE)) {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) fail('INVALID_IMAGE')
    let offset = 12
    let sawImageChunk = false
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString('ascii', offset, offset + 4)
      const length = bytes.readUInt32LE(offset + 4)
      const end = offset + 8 + length + (length & 1)
      if (end < offset || end > bytes.length) fail('INVALID_IMAGE')
      if (type === 'ANIM' || type === 'ANMF') fail('UNSUPPORTED_IMAGE')
      if (type === 'VP8 ' || type === 'VP8L' || type === 'VP8X') sawImageChunk = true
      if (type === 'VP8X' && length >= 1 && (bytes[offset + 8]! & 0x02) !== 0) fail('UNSUPPORTED_IMAGE')
      offset = end
    }
    if (offset !== bytes.length || !sawImageChunk) fail('INVALID_IMAGE')
    return 'webp'
  }

  return fail('UNSUPPORTED_IMAGE')
}

const validateMetadata = (metadata: Metadata, format: AvatarImageFormat): void => {
  if (metadata.format !== format) fail('INVALID_IMAGE')
  const pages = metadata.pages ?? 1
  if (pages !== 1 || (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height)) fail('UNSUPPORTED_IMAGE')
  const width = metadata.width
  const height = metadata.height
  if (width === undefined || height === undefined || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    fail('INVALID_IMAGE')
  if (width > USER_AVATAR_MAX_INPUT_DIMENSION || height > USER_AVATAR_MAX_INPUT_DIMENSION || width * height > USER_AVATAR_MAX_INPUT_PIXELS)
    fail('IMAGE_TOO_LARGE')
  if (metadata.channels !== undefined && (!Number.isSafeInteger(metadata.channels) || metadata.channels < 1 || metadata.channels > 4)) fail('INVALID_IMAGE')
}

const sharpOptions = {
  failOn: 'warning' as const,
  limitInputPixels: USER_AVATAR_MAX_INPUT_PIXELS,
  limitInputChannels: 4,
  unlimited: false
}

export const normalizeUserAvatar = async (source: Buffer | Uint8Array): Promise<Buffer> => {
  if (!Buffer.isBuffer(source) && source.byteLength > USER_AVATAR_SOURCE_BYTE_LIMIT) fail('IMAGE_TOO_LARGE')
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source)
  if (bytes.length === 0) fail('INVALID_IMAGE')
  if (bytes.length > USER_AVATAR_SOURCE_BYTE_LIMIT) fail('IMAGE_TOO_LARGE')
  const format = inputFormat(bytes)
  try {
    const metadata = await sharp(bytes, sharpOptions).metadata()
    validateMetadata(metadata, format)
    const decoded = await sharp(bytes, sharpOptions).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const width = Number(decoded.info.width)
    const height = Number(decoded.info.height)
    if (
      decoded.info.channels !== 4 ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > USER_AVATAR_MAX_INPUT_DIMENSION ||
      height > USER_AVATAR_MAX_INPUT_DIMENSION ||
      width * height > USER_AVATAR_MAX_INPUT_PIXELS ||
      decoded.data.length !== width * height * 4
    )
      fail('INVALID_IMAGE')

    const canonical = await sharp(decoded.data, { raw: { width, height, channels: 4 } })
      .resize({ width: USER_AVATAR_OUTPUT_DIMENSION, height: USER_AVATAR_OUTPUT_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 85, chromaSubsampling: '4:4:4', progressive: false })
      .toBuffer()
    if (canonical.length === 0 || canonical.length > USER_AVATAR_MAX_OUTPUT_BYTES || !hasExactJpegFraming(canonical)) fail('PROCESSING_FAILED')
    return canonical
  } catch (error: unknown) {
    if (error instanceof UserAvatarProcessingError) throw error
    if (error instanceof Error && /pixel limit|too large|memory/i.test(error.message)) fail('IMAGE_TOO_LARGE')
    return fail('INVALID_IMAGE')
  }
}
