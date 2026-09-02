/// <reference types="vite/client" />
import 'vuetify'

import type Hammer from 'hammerjs'
import type { i18n as I18next } from 'i18next'
import type moment from 'moment-timezone'
import type { App } from 'vue'
import type { helpers } from './helpers/index.ts'
import type boot from './modules/boot.ts'
import type { ProductMetadata } from '../shared/product.ts'
import type { SiteBannerConfig } from '../shared/site-banner.ts'
import type { PageEditorKey } from '../shared/page-editors.ts'
import type { ThemeColors } from '../shared/theme-colors.ts'
import type { PageGutterStyle } from '../shared/page-gutters.ts'

export type SiteConfig = {
  title: string
  theme: string
  darkMode: boolean
  themeColors: ThemeColors
  tocPosition: string
  gutterStyle: PageGutterStyle
  gutterCustomCss: string
  lang: string
  rtl: boolean
  company: string
  contentLicense: string
  footerOverride: string
  banner: SiteBannerConfig
  logoUrl: string
  product: ProductMetadata
  availableEditors: PageEditorKey[]
  agentsEnabled: boolean
  agentProviderEnabled: boolean
  agentSkillsEnabled: boolean
  agentGoalsEnabled: boolean
  agentCsrfToken: string
  path?: string
  devMode?: boolean
}

declare global {
  interface Window {
    WIKI: App<Element> | null
    boot: typeof boot
    Hammer: typeof Hammer
    siteConfig: SiteConfig
    siteLangs: Array<{ code: string; name: string }>
  }

  const siteConfig: SiteConfig
  const siteLangs: Window['siteLangs']
}

declare module 'vue' {
  interface ComponentCustomProperties {
    $helpers: typeof helpers
    $i18n: I18next
    $moment: typeof moment
    $t: (key: string, options?: Record<string, unknown>) => string
  }
}
