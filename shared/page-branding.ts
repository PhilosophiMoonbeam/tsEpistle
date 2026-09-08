import { z } from 'zod'

export const PAGE_BRANDING_VERSION = 1
export const PAGE_BRANDING_MAX_SOURCE_BYTES = 5_242_880
export const PAGE_BRANDING_MAX_INPUT_DIMENSION = 4_096
export const PAGE_BRANDING_MAX_INPUT_PIXELS = 16_777_216
export const PAGE_BRANDING_SAMPLE_DIMENSION = 64

const AssetIdSchema = z.number().finite().int().positive().safe()
const SourceSha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const BrandingDimensionSchema = z.number().finite().int().positive().max(PAGE_BRANDING_MAX_INPUT_DIMENSION)
const BrandingColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .transform(value => value.toUpperCase())
const BrandingMatteSchema = BrandingColorSchema.refine(value => value === '#FFFFFF' || value === '#181A1C')

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

const isSafePageBrandingImageUrl = (value: string): boolean => {
  if (value !== value.trim() || value.length > 1024 || !value.startsWith('/') || value.startsWith('//')) return false
  if (value.includes('\\') || value.includes('#') || hasControlCharacter(value)) return false

  const queryStart = value.indexOf('?')
  if (queryStart <= 1 || !/^v=[0-9a-f]{64}$/.test(value.slice(queryStart + 1))) return false
  if (value.indexOf('?', queryStart + 1) !== -1) return false

  try {
    const rawSegments = value.slice(1, queryStart).split('/')
    if (rawSegments.some(segment => segment.length === 0)) return false
    for (const [index, rawSegment] of rawSegments.entries()) {
      const decodedSegment = decodeURIComponent(rawSegment)
      if (
        (index === 0 && (decodedSegment.startsWith('_') || decodedSegment === 'api' || decodedSegment.startsWith('api/'))) ||
        decodedSegment === '.' ||
        decodedSegment === '..' ||
        decodedSegment.includes('\\') ||
        decodedSegment.includes('?') ||
        decodedSegment.includes('#') ||
        hasControlCharacter(decodedSegment) ||
        encodeURIComponent(decodedSegment) !== rawSegment
      )
        return false
    }
    return true
  } catch {
    return false
  }
}

export const PageBrandingAssignmentSchema = z.strictObject({
  assetId: AssetIdSchema
})

export type PageBrandingAssignment = z.infer<typeof PageBrandingAssignmentSchema>

export const AssetBrandingReadySchema = z
  .strictObject({
    version: z.literal(PAGE_BRANDING_VERSION),
    sourceSha256: SourceSha256Schema,
    state: z.literal('ready'),
    width: BrandingDimensionSchema,
    height: BrandingDimensionSchema,
    accent: BrandingColorSchema.nullable(),
    matte: BrandingMatteSchema.nullable()
  })
  .superRefine((value, context) => {
    if (value.width * value.height > PAGE_BRANDING_MAX_INPUT_PIXELS) {
      context.addIssue({ code: 'custom', path: ['width'], message: 'Branding image exceeds the input pixel limit.' })
    }
  })

export const AssetBrandingUnavailableSchema = z.strictObject({
  version: z.literal(PAGE_BRANDING_VERSION),
  sourceSha256: SourceSha256Schema,
  state: z.literal('unavailable'),
  reason: z.enum(['unsupported', 'invalid', 'too-large', 'processing-failed'])
})

export const AssetBrandingMetadataSchema = z.discriminatedUnion('state', [AssetBrandingReadySchema, AssetBrandingUnavailableSchema])

export type AssetBrandingMetadata = z.infer<typeof AssetBrandingMetadataSchema>

export const PageBrandingViewSchema = z
  .strictObject({
    assetId: AssetIdSchema,
    imageUrl: z.string().min(1).max(1024).refine(isSafePageBrandingImageUrl, 'Branding image URL must be a safe same-origin asset path.'),
    sourceSha256: SourceSha256Schema,
    width: BrandingDimensionSchema,
    height: BrandingDimensionSchema,
    accent: BrandingColorSchema.nullable(),
    matte: BrandingMatteSchema.nullable()
  })
  .superRefine((value, context) => {
    if (value.width * value.height > PAGE_BRANDING_MAX_INPUT_PIXELS) {
      context.addIssue({ code: 'custom', path: ['width'], message: 'Branding image exceeds the input pixel limit.' })
    }
    if (!value.imageUrl.endsWith(`?v=${value.sourceSha256}`)) {
      context.addIssue({ code: 'custom', path: ['imageUrl'], message: 'Branding image URL must be versioned by its source digest.' })
    }
  })

export type PageBrandingView = z.infer<typeof PageBrandingViewSchema>
