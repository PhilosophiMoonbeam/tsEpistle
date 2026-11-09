import sharp, { type Metadata, type Sharp } from 'sharp'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const ASSET_IMAGE_TRANSFORM_LIMITS = {
  inputBytes: 25 * 1024 * 1024,
  inputDimension: 10_000,
  inputPixelsPerFrame: 25_000_000,
  inputFrames: 100,
  inputTotalPixels: 100_000_000,
  outputDimension: 8_192,
  outputPixels: 25_000_000,
  outputTotalPixels: 100_000_000,
  outputBytes: 25 * 1024 * 1024,
  processingSeconds: 12,
  operations: 16
} as const

export type AssetImageFormat = 'png' | 'jpeg' | 'webp' | 'gif'
export type AssetImageAspectPolicy = 'preserve' | 'stretch'
export type AssetImageAnimationPolicy = 'preserve' | 'first-frame'

export type AssetImageOperation =
  | { type: 'crop'; left: number; top: number; width: number; height: number }
  | { type: 'rotate'; turns: 1 | 2 | 3 }
  | { type: 'mirror'; axis: 'horizontal' | 'vertical' }
  | { type: 'fill'; left: number; top: number; width: number; height: number; color: string }

export type AssetImageTransformOptions = {
  width: number
  height: number
  aspectPolicy: AssetImageAspectPolicy
  format: AssetImageFormat
  quality: number
  animationPolicy: AssetImageAnimationPolicy
  operations?: AssetImageOperation[]
}

export type AssetImageTransformResult = {
  data: Buffer
  width: number
  height: number
  format: AssetImageFormat
  frames: number
  editWidth: number
  editHeight: number
}

export type AssetImageTransformErrorCode =
  | 'ASSET_IMAGE_INVALID'
  | 'ASSET_IMAGE_UNSUPPORTED'
  | 'ASSET_IMAGE_TOO_LARGE'
  | 'ASSET_IMAGE_OUTPUT_TOO_LARGE'
  | 'ASSET_IMAGE_PROCESSING_LIMIT'

export class AssetImageTransformError extends Error {
  readonly code: AssetImageTransformErrorCode

  constructor(code: AssetImageTransformErrorCode, message: string) {
    super(message)
    this.name = code
    this.code = code
  }
}

function fail(code: AssetImageTransformErrorCode, message: string): never {
  throw new AssetImageTransformError(code, message)
}

const outputCodecAvailable = (format: AssetImageFormat): boolean => {
  const codecs = sharp.format as unknown as Record<string, { output?: { buffer?: boolean } }>
  return codecs[format]?.output?.buffer === true
}

const inputBytes = (source: Buffer | Uint8Array): Buffer => {
  if (Buffer.isBuffer(source)) return source
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength)
}

const validateDimensions = (width: number, height: number): void => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > ASSET_IMAGE_TRANSFORM_LIMITS.outputDimension ||
    height > ASSET_IMAGE_TRANSFORM_LIMITS.outputDimension ||
    width * height > ASSET_IMAGE_TRANSFORM_LIMITS.outputPixels
  ) {
    fail('ASSET_IMAGE_TOO_LARGE', 'Requested image dimensions exceed the processing limit.')
  }
}

const validateOptions = (options: AssetImageTransformOptions): void => {
  validateDimensions(options.width, options.height)
  if (options.aspectPolicy !== 'preserve' && options.aspectPolicy !== 'stretch') {
    fail('ASSET_IMAGE_INVALID', 'Choose whether to preserve or unlock the image aspect ratio.')
  }
  if (!['png', 'jpeg', 'webp', 'gif'].includes(options.format)) {
    fail('ASSET_IMAGE_UNSUPPORTED', 'The selected output image format is not supported.')
  }
  if (!Number.isSafeInteger(options.quality) || options.quality < 1 || options.quality > 100) {
    fail('ASSET_IMAGE_INVALID', 'Image quality must be an integer from 1 to 100.')
  }
  if (options.animationPolicy !== 'preserve' && options.animationPolicy !== 'first-frame') {
    fail('ASSET_IMAGE_INVALID', 'Choose whether to preserve animation or explicitly use its first frame.')
  }
  if (!outputCodecAvailable(options.format)) {
    fail('ASSET_IMAGE_UNSUPPORTED', 'The selected output image codec is unavailable.')
  }
}

const inputMetadata = async (bytes: Buffer): Promise<Metadata> => {
  try {
    return await sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: ASSET_IMAGE_TRANSFORM_LIMITS.inputPixelsPerFrame,
      limitInputChannels: 4,
      unlimited: false,
      animated: true,
      sequentialRead: true
    }).metadata()
  } catch (error: unknown) {
    if (error instanceof Error && /pixel limit|too large|memory/i.test(error.message)) {
      fail('ASSET_IMAGE_TOO_LARGE', 'The source image exceeds the decoding limit.')
    }
    fail('ASSET_IMAGE_INVALID', 'The source is not a supported, valid raster image.')
  }
}

const validateMetadata = (metadata: Metadata): { frames: number; format: AssetImageFormat } => {
  const format = metadata.format
  if (format !== 'png' && format !== 'jpeg' && format !== 'webp' && format !== 'gif') {
    fail('ASSET_IMAGE_UNSUPPORTED', 'Only PNG, JPEG, WebP, and GIF source images can be transformed.')
  }
  const width = metadata.width
  const height = metadata.height
  const frames = metadata.pages ?? 1
  const frameHeight = metadata.pageHeight ?? height
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(frames) ||
    !Number.isSafeInteger(frameHeight) ||
    !width ||
    !height ||
    !frameHeight ||
    frames < 1
  ) {
    fail('ASSET_IMAGE_INVALID', 'The source image has invalid dimensions or frame metadata.')
  }
  if (
    width > ASSET_IMAGE_TRANSFORM_LIMITS.inputDimension ||
    frameHeight > ASSET_IMAGE_TRANSFORM_LIMITS.inputDimension ||
    width * frameHeight > ASSET_IMAGE_TRANSFORM_LIMITS.inputPixelsPerFrame ||
    frames > ASSET_IMAGE_TRANSFORM_LIMITS.inputFrames ||
    width * frameHeight * frames > ASSET_IMAGE_TRANSFORM_LIMITS.inputTotalPixels
  ) {
    fail('ASSET_IMAGE_TOO_LARGE', 'The source image exceeds the bounded pixel or frame limit.')
  }
  if (metadata.channels !== undefined && (metadata.channels < 1 || metadata.channels > 4)) {
    fail('ASSET_IMAGE_UNSUPPORTED', 'The source image has an unsupported color layout.')
  }
  return { frames, format }
}

// Validate the whole program before decoding pixels. Every region addresses the
// EXIF-oriented image produced by all preceding edits, before the final resize.
const operationGeometry = (operations: unknown, initialWidth: number, initialHeight: number): { width: number; height: number } => {
  if (!Array.isArray(operations) || operations.length > ASSET_IMAGE_TRANSFORM_LIMITS.operations) {
    fail('ASSET_IMAGE_INVALID', 'Use at most 16 image operations.')
  }
  let width = initialWidth
  let height = initialHeight
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) fail('ASSET_IMAGE_INVALID', 'Invalid image operation.')
    const keys = Object.keys(operation)
    if (operation.type === 'rotate') {
      if (keys.some(key => !['type', 'turns'].includes(key)) || ![1, 2, 3].includes(operation.turns)) fail('ASSET_IMAGE_INVALID', 'Rotation must be one, two or three quarter turns.')
      if (operation.turns !== 2) [width, height] = [height, width]
    } else if (operation.type === 'mirror') {
      if (keys.some(key => !['type', 'axis'].includes(key)) || !['horizontal', 'vertical'].includes(operation.axis)) fail('ASSET_IMAGE_INVALID', 'Choose a mirror axis.')
    } else if (operation.type === 'crop' || operation.type === 'fill') {
      const fields = operation.type === 'fill' ? ['type', 'left', 'top', 'width', 'height', 'color'] : ['type', 'left', 'top', 'width', 'height']
      if (keys.some(key => !fields.includes(key)) ||
        ![operation.left, operation.top, operation.width, operation.height].every(Number.isSafeInteger) ||
        operation.left < 0 || operation.top < 0 || operation.width < 1 || operation.height < 1 ||
        operation.left + operation.width > width || operation.top + operation.height > height ||
        (operation.type === 'fill' && (typeof operation.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(operation.color)))) {
        fail('ASSET_IMAGE_INVALID', 'Image regions must be nonempty integer rectangles inside the current image; fill must be an opaque RGB color.')
      }
      if (operation.type === 'crop') { width = operation.width; height = operation.height }
    } else {
      fail('ASSET_IMAGE_INVALID', 'Unknown image operation.')
    }
  }
  return { width, height }
}

const encode = (image: Sharp, format: AssetImageFormat, quality: number): Sharp => {
  switch (format) {
    case 'png':
      return image.png({ palette: true, quality, effort: 7 })
    case 'jpeg':
      return image.jpeg({ quality, chromaSubsampling: '4:4:4', progressive: false })
    case 'webp':
      return image.webp({ quality, effort: 5 })
    case 'gif':
      return image.gif({ effort: 7 })
  }
  return fail('ASSET_IMAGE_UNSUPPORTED', 'The selected output image format is not supported.')
}

export const transformAssetImage = async (
  source: Buffer | Uint8Array,
  options: AssetImageTransformOptions
): Promise<AssetImageTransformResult> => {
  const deadline = Date.now() + ASSET_IMAGE_TRANSFORM_LIMITS.processingSeconds * 1000
  validateOptions(options)
  const bytes = inputBytes(source)
  if (bytes.length < 1) fail('ASSET_IMAGE_INVALID', 'The source image is empty.')
  if (bytes.length > ASSET_IMAGE_TRANSFORM_LIMITS.inputBytes) {
    fail('ASSET_IMAGE_TOO_LARGE', 'The source image exceeds the input byte limit.')
  }
  operationGeometry(options.operations === undefined ? [] : options.operations, ASSET_IMAGE_TRANSFORM_LIMITS.inputDimension, ASSET_IMAGE_TRANSFORM_LIMITS.inputDimension)

  const metadata = await inputMetadata(bytes)
  const input = validateMetadata(metadata)
  const animated = input.frames > 1
  const operations = options.operations === undefined ? [] : options.operations
  const swapped = (metadata.orientation ?? 1) >= 5
  const initialWidth = swapped ? (metadata.pageHeight ?? metadata.height)! : metadata.width!
  const initialHeight = swapped ? metadata.width! : (metadata.pageHeight ?? metadata.height)!
  const geometry = operationGeometry(operations, initialWidth, initialHeight)
  const opaqueFill = operations.some(operation => operation.type === 'fill')
  if (animated && operations.length > 0 && options.animationPolicy !== 'first-frame') {
    fail('ASSET_IMAGE_UNSUPPORTED', 'Image edits on animated input require explicit first-frame conversion.')
  }
  if (opaqueFill && options.format !== 'png' && options.format !== 'webp') {
    fail('ASSET_IMAGE_UNSUPPORTED', 'Opaque fill requires lossless PNG or WebP output.')
  }
  if (animated && options.animationPolicy === 'preserve' && options.format !== 'gif') {
    fail('ASSET_IMAGE_UNSUPPORTED', 'Animated input can be preserved only as GIF; select first-frame conversion to change formats.')
  }

  const sharpOptions = {
    failOn: 'warning' as const,
    limitInputPixels: ASSET_IMAGE_TRANSFORM_LIMITS.inputPixelsPerFrame,
    limitInputChannels: 4,
    unlimited: false,
    animated: animated && options.animationPolicy === 'preserve',
    sequentialRead: true
  }
  const chunks: Buffer[] = []
  let outputBytes = 0
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += bytes.length
      if (outputBytes > ASSET_IMAGE_TRANSFORM_LIMITS.outputBytes) {
        callback(new AssetImageTransformError('ASSET_IMAGE_OUTPUT_TOO_LARGE', 'The transformed image exceeds the output byte limit.'))
        return
      }
      chunks.push(bytes)
      callback()
    }
  })
  const remainingProcessingTime = (): number => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) fail('ASSET_IMAGE_PROCESSING_LIMIT', 'Image transformation exceeded the processing time limit.')
    return remaining
  }
  const bounded = (image: Sharp): Sharp =>
    image.timeout({ seconds: Math.max(1, Math.ceil(remainingProcessingTime() / 1000)) })
  let image = sharp(bytes, sharpOptions).rotate()
  try {
    if (operations.length > 0) {
      // Separate native pipelines are essential: Sharp otherwise coalesces or
      // reorders repeated rotate/extract/flip operations.
      let pixels = await bounded(image.toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' })).toBuffer({ resolveWithObject: true })
      for (const operation of operations) {
        bounded(image)
        if (operation.type === 'fill') {
          const rgba = Buffer.from(`${operation.color.slice(1)}ff`, 'hex')
          const rowBytes = operation.width * 4
          for (let y = operation.top; y < operation.top + operation.height; y++) {
            remainingProcessingTime()
            const offset = (y * pixels.info.width + operation.left) * 4
            // Each native write is bounded by one admitted input row, with no
            // intermediate raster or per-pixel JavaScript work.
            pixels.data.fill(rgba, offset, offset + rowBytes)
          }
        } else {
          image = sharp(pixels.data, { raw: { width: pixels.info.width, height: pixels.info.height, channels: 4 } })
          if (operation.type === 'crop') image = image.extract({ left: operation.left, top: operation.top, width: operation.width, height: operation.height })
          else if (operation.type === 'rotate') image = image.rotate(operation.turns * 90)
          else image = operation.axis === 'horizontal' ? image.flop() : image.flip()
          pixels = await bounded(image.raw()).toBuffer({ resolveWithObject: true })
        }
      }
      image = sharp(pixels.data, { raw: { width: pixels.info.width, height: pixels.info.height, channels: 4 } })
    }
    image = bounded(image.resize({
      width: options.width,
      height: options.height,
      fit: options.aspectPolicy === 'stretch' ? 'fill' : 'inside',
      ...(opaqueFill ? { kernel: sharp.kernel.nearest } : {}),
      withoutEnlargement: false
    }))
  } catch (error: unknown) {
    if (error instanceof AssetImageTransformError) throw error
    if (error instanceof Error && /timeout|timed out/i.test(error.message)) fail('ASSET_IMAGE_PROCESSING_LIMIT', 'Image transformation exceeded the processing time limit.')
    fail('ASSET_IMAGE_INVALID', 'The source image could not be safely edited.')
  }
  const resized = opaqueFill
    ? options.format === 'webp' ? image.webp({ lossless: true, effort: 5 }) : image.png()
    : encode(image, options.format, options.quality)

  try {
    await pipeline(resized, sink)
  } catch (error: unknown) {
    if (error instanceof AssetImageTransformError) throw error
    if (error instanceof Error && /timed out|timeout/i.test(error.message)) {
      fail('ASSET_IMAGE_PROCESSING_LIMIT', 'Image transformation exceeded the processing time limit.')
    }
    if (error instanceof Error && /pixel limit|too large|memory/i.test(error.message)) {
      fail('ASSET_IMAGE_TOO_LARGE', 'The source image exceeds the decoding limit.')
    }
    fail('ASSET_IMAGE_INVALID', 'The source image could not be safely transformed.')
  }

  if (!outputBytes) fail('ASSET_IMAGE_INVALID', 'The image codec produced no valid output.')

  const data = Buffer.concat(chunks, outputBytes)
  let outputMetadata: Metadata | undefined
  try {
    outputMetadata = await sharp(data, {
      failOn: 'warning',
      limitInputPixels: ASSET_IMAGE_TRANSFORM_LIMITS.outputPixels,
      unlimited: false,
      animated: true,
      sequentialRead: true
    }).metadata()
    if (outputMetadata.format !== options.format) {
      fail('ASSET_IMAGE_INVALID', 'The image codec produced a different output format.')
    }
  } catch (error: unknown) {
    if (error instanceof AssetImageTransformError) throw error
    fail('ASSET_IMAGE_INVALID', 'The image codec produced an invalid output image.')
  }

  if (!outputMetadata) fail('ASSET_IMAGE_INVALID', 'The image codec produced an invalid output image.')
  const outputFrames = outputMetadata.pages ?? 1
  const outputWidth = outputMetadata.width
  const outputHeight = outputMetadata.pageHeight ?? outputMetadata.height
  if (
    !Number.isSafeInteger(outputFrames) ||
    outputFrames < 1 ||
    outputFrames > ASSET_IMAGE_TRANSFORM_LIMITS.inputFrames ||
    !Number.isSafeInteger(outputWidth) ||
    !Number.isSafeInteger(outputHeight) ||
    !outputWidth ||
    !outputHeight
  ) {
    fail('ASSET_IMAGE_INVALID', 'The image codec produced invalid dimensions or frame metadata.')
  }
  if (
    outputWidth > ASSET_IMAGE_TRANSFORM_LIMITS.outputDimension ||
    outputHeight > ASSET_IMAGE_TRANSFORM_LIMITS.outputDimension ||
    outputWidth * outputHeight > ASSET_IMAGE_TRANSFORM_LIMITS.outputPixels ||
    outputWidth * outputHeight * outputFrames > ASSET_IMAGE_TRANSFORM_LIMITS.outputTotalPixels
  ) {
    fail('ASSET_IMAGE_TOO_LARGE', 'Transformed image dimensions exceed the output pixel or frame limit.')
  }
  if (animated && options.animationPolicy === 'preserve' && outputFrames !== input.frames) {
    fail('ASSET_IMAGE_INVALID', 'The image codec could not preserve every animation frame.')
  }
  if ((!animated || options.animationPolicy === 'first-frame') && outputFrames !== 1) {
    fail('ASSET_IMAGE_INVALID', 'The image codec produced unexpected animation frames.')
  }
  if (opaqueFill) {
    if (outputMetadata.exif || outputMetadata.xmp || outputMetadata.iptc || outputMetadata.icc || outputMetadata.orientation) {
      fail('ASSET_IMAGE_INVALID', 'Opaque output retained unexpected source metadata.')
    }
    try {
      await bounded(sharp(data, { failOn: 'warning', limitInputPixels: ASSET_IMAGE_TRANSFORM_LIMITS.outputPixels }).raw()).toBuffer()
    } catch (error: unknown) {
      if (error instanceof AssetImageTransformError) throw error
      if (error instanceof Error && /timed out|timeout/i.test(error.message)) fail('ASSET_IMAGE_PROCESSING_LIMIT', 'Image verification exceeded the processing time limit.')
      fail('ASSET_IMAGE_INVALID', 'Opaque output could not be completely decoded.')
    }
  }

  if (Date.now() > deadline) fail('ASSET_IMAGE_PROCESSING_LIMIT', 'Image transformation exceeded the processing time limit.')
  return { data, width: outputWidth, height: outputHeight, format: options.format, frames: outputFrames, editWidth: geometry.width, editHeight: geometry.height }
}
