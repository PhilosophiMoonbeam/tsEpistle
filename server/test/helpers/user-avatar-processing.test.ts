import sharp from 'sharp'

import { describe, expect, it } from '../bun-test.mts'
import { decompressionBombFixture, encodeFixture, orientedProfiledJpegFixture, oversizedDimensionFixture } from './site-logo-processing.fixtures.ts'
import {
  normalizeUserAvatar,
  UserAvatarProcessingError,
  USER_AVATAR_MAX_OUTPUT_BYTES,
  USER_AVATAR_OUTPUT_DIMENSION,
  USER_AVATAR_SOURCE_BYTE_LIMIT
} from '../../helpers/user-avatar-processing.ts'

const expectProcessingCode = async (input: Buffer, code: UserAvatarProcessingError['code']): Promise<void> => {
  await expect(normalizeUserAvatar(input)).rejects.toMatchObject({ code })
}

describe('self-service avatar image processing', () => {
  it('canonicalizes each supported static format to bounded metadata-free JPEG', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const source = await encodeFixture(format, 800, 400, [18, 72, 164, 190])
      const output = await normalizeUserAvatar(source)
      const metadata = await sharp(output).metadata()

      expect(metadata.format).toBe('jpeg')
      expect(metadata.width).toBeLessThanOrEqual(USER_AVATAR_OUTPUT_DIMENSION)
      expect(metadata.height).toBeLessThanOrEqual(USER_AVATAR_OUTPUT_DIMENSION)
      expect(metadata.orientation).toBeUndefined()
      expect(metadata.exif).toBeUndefined()
      expect(metadata.icc).toBeUndefined()
      expect(output.length).toBeGreaterThan(0)
      expect(output.length).toBeLessThanOrEqual(USER_AVATAR_MAX_OUTPUT_BYTES)
      expect(output.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
      expect(output.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
    }
  })

  it('applies orientation before resizing and strips source metadata', async () => {
    const output = await normalizeUserAvatar(await orientedProfiledJpegFixture())
    const metadata = await sharp(output).metadata()

    expect(metadata.format).toBe('jpeg')
    expect(metadata.width).toBe(307)
    expect(metadata.height).toBe(USER_AVATAR_OUTPUT_DIMENSION)
    expect(metadata.orientation).toBeUndefined()
    expect(metadata.icc).toBeUndefined()
  })

  it('rejects unsupported, polyglot, oversized, and decompression-bomb inputs', async () => {
    await expectProcessingCode(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'UNSUPPORTED_IMAGE')

    const jpeg = await encodeFixture('jpeg', 32, 32)
    await expectProcessingCode(Buffer.concat([jpeg, Buffer.from('trailing bytes')]), 'INVALID_IMAGE')

    await expectProcessingCode(Buffer.alloc(USER_AVATAR_SOURCE_BYTE_LIMIT + 1), 'IMAGE_TOO_LARGE')
    await expectProcessingCode(await oversizedDimensionFixture(), 'IMAGE_TOO_LARGE')
    await expectProcessingCode(await decompressionBombFixture(), 'IMAGE_TOO_LARGE')
  })
})
