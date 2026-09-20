import type { SiteConfig } from '../env.d.ts'
import { normalizeThemeColors } from '../../shared/theme-colors.ts'
import { normalizeReaderLayout } from '../../shared/theme-policy.ts'
import product from '../../package.json'
import { offlineLogoPath, rememberOfflineLogo } from './offline-branding.ts'

const KEY = 'tsepistle.offline.presentation.v1'
// This allowlist is presentation only. Never persist bootstrap/session objects.
const publicPresentationTitle = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const normalized = Array.from(value.normalize('NFKC'))
    .filter(character => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f
    })
    .join('')
    .trim()
  return normalized.length <= 256 ? normalized : normalized.slice(0, 256)
}
export function rememberOfflinePresentation(appearance = ''): void {
  const logoUrl = offlineLogoPath(siteConfig.logoUrl, window.location.origin) ?? ''
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        title: publicPresentationTitle(siteConfig.title),
        themeColors: siteConfig.themeColors,
        readerLayout: siteConfig.readerLayout,
        lang: siteConfig.lang,
        rtl: siteConfig.rtl,
        appearance,
        logoUrl
      })
    )
  } catch {
    /* Storage is optional. */
  }
  void rememberOfflineLogo(logoUrl, window.location.origin)
}

export function offlinePresentation(): { config: SiteConfig; appearance: string } {
  let saved: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value as Record<string, unknown>
  } catch {
    /* Use bundled defaults. */
  }
  const revision = document.querySelector('meta[name="tsepistle-pwa-release"]')?.getAttribute('content') ?? ''
  return {
    appearance: ['light', 'dark', 'system'].includes(String(saved.appearance)) ? String(saved.appearance) : 'system',
    config: {
      title: publicPresentationTitle(saved.title) || 'tsEpistle',
      theme: 'default',
      darkMode: false,
      themeColors: normalizeThemeColors(saved.themeColors),
      readerLayout: normalizeReaderLayout(saved.readerLayout),
      tocPosition: 'left',
      lang: typeof saved.lang === 'string' && /^[a-zA-Z0-9-]{2,35}$/.test(saved.lang) ? saved.lang : 'en',
      rtl: saved.rtl === true,
      company: '',
      contentLicense: '',
      footerOverride: '',
      banner: { isEnabled: false, title: '', content: '' },
      logoUrl: offlineLogoPath(saved.logoUrl, window.location.origin) ?? '',
      logoEffect: null,
      product: {
        ...product.product,
        independentFork: true,
        description: product.description,
        revision,
        date: `${product.releaseDate}`,
        upstreamBase: 'Wiki.js 2.5.314',
        sourceUrl: `${product.product.sourceRepository}/tree/${revision}`
      },
      availableEditors: [],
      agentsEnabled: false,
      agentProviderEnabled: false,
      agentSkillsEnabled: false,
      agentGoalsEnabled: false,
      agentCsrfToken: ''
    }
  }
}
