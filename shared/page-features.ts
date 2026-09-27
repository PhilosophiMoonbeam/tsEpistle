import { z } from 'zod'

export const PAGE_FEATURES_SCHEMA_VERSION = 1 as const

export const PageFeaturesSchema = z.strictObject({
  schemaVersion: z.literal(PAGE_FEATURES_SCHEMA_VERSION),
  linksVisible: z.boolean(),
  ratingsAllowed: z.boolean(),
  lastEditorVisible: z.boolean()
})

export type PageFeatures = z.infer<typeof PageFeaturesSchema>

export const DEFAULT_PAGE_FEATURES: PageFeatures = Object.freeze({
  schemaVersion: PAGE_FEATURES_SCHEMA_VERSION,
  linksVisible: false,
  ratingsAllowed: true,
  lastEditorVisible: false
})

const FAIL_CLOSED_PAGE_FEATURES: PageFeatures = Object.freeze({
  schemaVersion: PAGE_FEATURES_SCHEMA_VERSION,
  linksVisible: false,
  ratingsAllowed: false,
  lastEditorVisible: false
})

export const parsePageFeatures = (input: unknown): PageFeatures | null => {
  const parsed = PageFeaturesSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}

/** Missing metadata uses legacy defaults; malformed explicit metadata disables every page feature. */
export const normalizePageFeatures = (input: unknown): PageFeatures => {
  if (input === undefined) return DEFAULT_PAGE_FEATURES
  return parsePageFeatures(input) ?? FAIL_CLOSED_PAGE_FEATURES
}
