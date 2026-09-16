export const SITE_LOGO_PIPELINE_VERSION = 7 as const
export const SITE_LOGO_JOB_VERSION = 5 as const

export const SITE_LOGO_SOURCE_BYTE_LIMIT = 5_242_880 as const
export const SITE_LOGO_MIN_INPUT_DIMENSION = 1 as const
export const SITE_LOGO_MAX_INPUT_DIMENSION = 4_096 as const
export const SITE_LOGO_MAX_INPUT_PIXELS = 16_777_216 as const
export const SITE_LOGO_CANONICAL_LONG_AXIS = 1_024 as const

export const SITE_LOGO_PNG_BYTE_LIMIT = 5_242_880 as const
export const SITE_LOGO_ICON_PNG_BYTE_LIMIT = 2_097_152 as const
export const SITE_LOGO_FAVICON_ICO_BYTE_LIMIT = 16_384 as const
export const SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT = 192_056 as const
export const SITE_LOGO_PARTICLE_GZIP_BYTE_LIMIT = 180_224 as const
export const SITE_LOGO_STATIC_PNG_BYTE_LIMIT = 1_048_576 as const

export const SITE_LOGO_ICON_SIZES = Object.freeze({
  favicon16: 16,
  favicon32: 32,
  tile150: 150,
  apple180: 180,
  app192: 192,
  app512: 512,
  maskable512: 512
} as const)

export type SiteLogoEnhancementUnavailableReason = 'UNSUITABLE_LOGO' | 'ARTIFACT_TOO_LARGE' | 'PROCESSING_FAILED'

export interface LogoIconDescriptor {
  readonly favicon16Url: string
  readonly favicon32Url: string
  readonly tile150Url: string
  readonly apple180Url: string
  readonly app192Url: string
  readonly app512Url: string
  readonly maskable512Url: string
  readonly faviconIcoUrl: string
}

export interface LogoEffectDescriptor {
  readonly pipelineVersion: number
  readonly logoUrl: string
  readonly particleUrl: string
  readonly staticUrl: string
  readonly width: number
  readonly height: number
  readonly aspect: number
  readonly count: number
  readonly medianStroke: number
  readonly auraColor?: string
}

export type SiteLogoErrorCode =
  | 'UNSUPPORTED_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'INVALID_IMAGE'
  | 'NO_VISIBLE_PIXELS'
  | 'UNSUITABLE_LOGO'
  | 'PROCESSING_FAILED'
  | 'ARTIFACT_TOO_LARGE'

export type SiteLogoEnhancementStatus =
  | {
      readonly status: 'ready'
      readonly reason: null
    }
  | {
      readonly status: 'unavailable'
      readonly reason: SiteLogoEnhancementUnavailableReason
    }

export interface SiteLogoActiveStatus {
  readonly revisionId: string
  readonly logoUrl: string
  readonly logoIcons: LogoIconDescriptor | null
  readonly enhancement: SiteLogoEnhancementStatus
}
export interface SiteLogoStatus {
  readonly active: SiteLogoActiveStatus | null
  readonly candidate: {
    readonly revisionId: string
    readonly status: 'pending' | 'running' | 'ready' | 'failed'
    readonly errorCode: SiteLogoErrorCode | null
  } | null
  readonly statusUrl?: '/_api/site/logo'
}
