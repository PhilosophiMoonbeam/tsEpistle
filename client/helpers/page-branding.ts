import { PageBrandingViewSchema, type PageBrandingView } from '../../shared/page-branding.ts'

export type PageBrandingStyle = Record<string, string>

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/i

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
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.origin}${decodeURIComponent(url.pathname)}`
  } catch {
    return null
  }
}

export interface SiteLogoIdentity {
  logoUrl?: string | null
  /** Hash of uploaded source bytes from resolveActiveBranding, not the rendered logo URL hash. */
  logoSourceSha256?: string | null
}

/**
 * Matches genuine source hashes when both are available; a mismatch wins over
 * path equality. Otherwise only the same canonical public URL matches, never a
 * shared filename or a digest inferred from a URL.
 */
export const brandingDuplicatesSiteLogo = (
  branding: Pick<PageBrandingView, 'imageUrl' | 'sourceSha256'> | null | undefined,
  site: SiteLogoIdentity | null | undefined
): boolean => {
  if (!branding || !site) return false
  if (!branding.imageUrl?.trim() || !site.logoUrl?.trim()) return false
  const brandingPath = comparablePath(branding.imageUrl)
  const sitePath = comparablePath(site.logoUrl)
  if (brandingPath === null || sitePath === null) return false
  if (
    typeof branding.sourceSha256 === 'string' && SHA256_PATTERN.test(branding.sourceSha256) &&
    typeof site.logoSourceSha256 === 'string' && SHA256_PATTERN.test(site.logoSourceSha256)
  ) {
    return branding.sourceSha256.toLowerCase() === site.logoSourceSha256.toLowerCase()
  }
  return brandingPath === sitePath
}
