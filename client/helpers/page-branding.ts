import { PageBrandingViewSchema, type PageBrandingView } from '../../shared/page-branding.ts'
import { contrastRatio } from './theme.ts'

export type PageBrandingStyle = Record<string, string>

export interface PageBrandingTheme {
  surface: string
  onSurface: string
  dark: boolean
}

const PAGE_BRANDING_MIN_CONTRAST = 4.5
const PAGE_BRANDING_LARGE_TEXT_CONTRAST = 3
const PAGE_BRANDING_LIGHT_MIX = 0.04
const PAGE_BRANDING_DARK_MIX = 0.06
const PAGE_BRANDING_DIVIDER_MIX = 0.18
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

const DEFAULT_LIGHT_THEME: PageBrandingTheme = {
  surface: '#F8F9FA',
  onSurface: '#181A1C',
  dark: false
}

const DEFAULT_DARK_THEME: PageBrandingTheme = {
  surface: '#24272A',
  onSurface: '#F8F9FA',
  dark: true
}

const normalizeHex = (value: unknown, fallback: string): string => (typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value.toUpperCase() : fallback)

const mixHex = (base: string, mix: string, amount: number): string => {
  const channels = [1, 3, 5].map(index => {
    const baseChannel = Number.parseInt(base.slice(index, index + 2), 16)
    const mixChannel = Number.parseInt(mix.slice(index, index + 2), 16)
    return Math.round(baseChannel + (mixChannel - baseChannel) * amount)
      .toString(16)
      .padStart(2, '0')
  })
  return `#${channels.join('')}`.toUpperCase()
}

const normalizeTheme = (theme: PageBrandingTheme): PageBrandingTheme => {
  const fallback = theme.dark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME
  return {
    dark: theme.dark,
    surface: normalizeHex(theme.surface, fallback.surface),
    onSurface: normalizeHex(theme.onSurface, fallback.onSurface)
  }
}

const textRoles = (surface: string, text: string): Array<{ foreground: string; threshold: number }> => [
  { foreground: text, threshold: PAGE_BRANDING_LARGE_TEXT_CONTRAST },
  { foreground: text, threshold: PAGE_BRANDING_MIN_CONTRAST },
  { foreground: mixHex(surface, text, 0.65), threshold: PAGE_BRANDING_MIN_CONTRAST },
  { foreground: mixHex(surface, text, 0.68), threshold: PAGE_BRANDING_MIN_CONTRAST }
]

const textContrastRatios = (surface: string, text: string): number[] => textRoles(surface, text).map(role => contrastRatio(role.foreground, surface))

const textRemainsCompliant = (surface: string, text: string, baseline?: readonly number[]): boolean =>
  textRoles(surface, text).every((role, index) => {
    const ratio = contrastRatio(role.foreground, surface)
    return ratio >= role.threshold && (baseline === undefined || ratio >= baseline[index])
  })

export const normalizePageBrandingView = (value: unknown): PageBrandingView | null => {
  const result = PageBrandingViewSchema.safeParse(value)
  return result.success ? result.data : null
}

export const pageBrandingIdentity = (value: PageBrandingView | null): string | null => (value === null ? null : `${value.assetId}:${value.sourceSha256}`)

export const isPageBrandingAccentSafe = (value: PageBrandingView | null, theme: PageBrandingTheme = DEFAULT_LIGHT_THEME): boolean => {
  if (value?.accent === null || value?.accent === undefined) return false
  const activeTheme = normalizeTheme(theme)
  const baseline = textContrastRatios(activeTheme.surface, activeTheme.onSurface)
  if (!textRemainsCompliant(activeTheme.surface, activeTheme.onSurface)) return false
  const amount = activeTheme.dark ? PAGE_BRANDING_DARK_MIX : PAGE_BRANDING_LIGHT_MIX
  const compositedSurface = mixHex(activeTheme.surface, value.accent, amount)
  return textRemainsCompliant(compositedSurface, activeTheme.onSurface, baseline)
}

export const resolvePageBrandingStyle = (
  value: PageBrandingView | null,
  failedIdentity: string | null = null,
  theme: PageBrandingTheme = DEFAULT_LIGHT_THEME
): PageBrandingStyle => {
  const identity = pageBrandingIdentity(value)
  const accent = value?.accent
  const activeTheme = normalizeTheme(theme)
  if (
    value === null ||
    identity === null ||
    identity === failedIdentity ||
    accent === null ||
    accent === undefined ||
    !isPageBrandingAccentSafe(value, activeTheme)
  )
    return {}

  const amount = activeTheme.dark ? PAGE_BRANDING_DARK_MIX : PAGE_BRANDING_LIGHT_MIX
  const compositedSurface = mixHex(activeTheme.surface, accent, amount)
  return {
    '--page-branding-surface': compositedSurface,
    '--page-branding-divider': `color-mix(in srgb, ${accent} ${PAGE_BRANDING_DIVIDER_MIX * 100}%, var(--wiki-surface-border))`
  }
}

export const resolvePageBrandingMarkStyle = (value: PageBrandingView | null): PageBrandingStyle =>
  value?.matte === null || value?.matte === undefined ? {} : { '--page-branding-mark-matte': value.matte }
