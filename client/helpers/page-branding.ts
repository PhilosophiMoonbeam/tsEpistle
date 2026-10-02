import { PageBrandingViewSchema, type PageBrandingView } from '../../shared/page-branding.ts'

export type PageBrandingStyle = Record<string, string>

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

export const normalizePageBrandingView = (value: unknown): PageBrandingView | null => {
  const result = PageBrandingViewSchema.safeParse(value)
  return result.success ? result.data : null
}

export const pageBrandingIdentity = (value: PageBrandingView | null): string | null => (value === null ? null : `${value.assetId}:${value.sourceSha256}`)

export const resolvePageBrandingStyle = (value: PageBrandingView | null, failedIdentity: string | null = null, dark = false): PageBrandingStyle => {
  const identity = pageBrandingIdentity(value)
  const accent = value?.accent
  if (value === null || identity === null || identity === failedIdentity || typeof accent !== 'string' || !HEX_COLOR_PATTERN.test(accent)) return {}

  const red = Number.parseInt(accent.slice(1, 3), 16)
  const green = Number.parseInt(accent.slice(3, 5), 16)
  const blue = Number.parseInt(accent.slice(5, 7), 16)
  return {
    '--page-branding-rgb': `${red} ${green} ${blue}`,
    '--page-branding-alpha': dark ? '0.24' : '0.28'
  }
}

const comparablePath = (value: string): string | null => {
  try {
    const base = typeof window === 'undefined' ? 'http://wiki.invalid' : window.location.origin
    const url = new URL(value, base)
    return `${url.origin}${decodeURIComponent(url.pathname)}`
  } catch {
    return null
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/

export interface SiteLogoIdentity {
  logoUrl?: string | null
  /** SHA-256 of the site logo's uploaded source bytes (the processed logo URL uses a different hash). */
  logoSourceSha256?: string | null
}

/**
 * True when a page branding image is the site logo: the same uploaded source bytes,
 * or the same file path (query strings ignored).
 */
export const brandingDuplicatesSiteLogo = (
  branding: Pick<PageBrandingView, 'imageUrl' | 'sourceSha256'> | null | undefined,
  site: SiteLogoIdentity | null | undefined
): boolean => {
  if (!branding || !site) return false
  const siteSha = site.logoSourceSha256
  if (typeof siteSha === 'string' && SHA256_PATTERN.test(siteSha) && siteSha === branding.sourceSha256) return true
  if (!branding.imageUrl || !site.logoUrl) return false
  const brandingPath = comparablePath(branding.imageUrl)
  return brandingPath !== null && brandingPath === comparablePath(site.logoUrl)
}

/** Accepts only a well-formed source digest from server-rendered site config. */
export const normalizeSiteLogoSourceSha256 = (value: unknown): string | null => (typeof value === 'string' && SHA256_PATTERN.test(value) ? value : null)
