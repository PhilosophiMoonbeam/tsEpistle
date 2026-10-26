/// <reference types="vite/client" />
import 'vuetify'

import type Hammer from 'hammerjs'
import type { i18n as I18next } from 'i18next'
import type moment from 'moment-timezone'
import type { App } from 'vue'
import type { PageEditorKey } from '../shared/page-editors.ts'
import type { ProductMetadata } from '../shared/product.ts'
import type { SiteBannerConfig } from '../shared/site-banner.ts'
import type { LogoEffectDescriptor } from '../shared/site-logo.ts'
import type { ThemeColors } from '../shared/theme-colors.ts'
import type { CodeTheme } from '../shared/theme-policy.ts'
import type { helpers } from './helpers/index.ts'
import type boot from './modules/boot.ts'

// These are type-only counterparts of client-app.ts's lazy registrations.
// Locally registered components (including LocalizedRichText) do not belong here.
import type Admin from './components/admin.vue'
import type AdminHero from './components/common/admin-hero.vue'
import type Comments from './components/comments.vue'
import type Editor from './components/editor.vue'
import type LiveNote from './components/notes/live-note.vue'
import type History from './components/history.vue'
import type Loader from './components/common/loader.vue'
import type Login from './components/login.vue'
import type NavHeader from './components/common/nav-header.vue'
import type NewPage from './components/new-page.vue'
import type Notify from './components/common/notify.vue'
import type NotFound from './components/not-found.vue'
import type PageSelector from './components/common/page-selector.vue'
import type PageUnlock from './components/page-unlock.vue'
import type PageSource from './components/source.vue'
import type Profile from './components/profile.vue'
import type Register from './components/register.vue'
import type SearchResults from './components/common/search-results.vue'
import type SocialSharing from './components/common/social-sharing.vue'
import type Tags from './components/tags.vue'
import type Unauthorized from './components/unauthorized.vue'
import type VCardChin from './components/common/v-card-chin.vue'
import type VCardInfo from './components/common/v-card-info.vue'
import type Welcome from './components/welcome.vue'
import type WikiPage from './components/wiki-page.vue'
import type VueScroll from './components/common/vue-scroll.vue'
import type NavFooter from './themes/default/components/nav-footer.vue'

export type SiteConfig = {
  title: string
  theme: string
  darkMode: boolean
  themeColors: ThemeColors
  initialAppearance?: 'light' | 'dark' | 'system'
  readerLayout?: import('../shared/theme-policy.ts').ReaderLayout
  codeTheme?: CodeTheme
  pageTransitions?: boolean
  showPageProgress?: boolean
  tocPosition: string
  lang: string
  localeRevision?: string
  rtl: boolean
  company: string
  contentLicense: string
  footerOverride: string
  banner: SiteBannerConfig
  logoUrl: string
  logoEffect: LogoEffectDescriptor | null
  /** SHA-256 of the active site logo's uploaded source; null for unmanaged logos. */
  product: ProductMetadata
  featurePageRatings: boolean
  availableEditors: PageEditorKey[]
  recommendedEditor?: PageEditorKey | null
  agentsEnabled: boolean
  agentProviderEnabled: boolean
  agentSkillsEnabled: boolean
  agentGoalsEnabled: boolean
  agentCsrfToken: string
  /** null in the bundled offline shell: no server-verified installation identity. */
  offlineDraftSiteId?: string | null
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
  interface GlobalComponents {
    Admin: typeof Admin
    AdminHero: typeof AdminHero
    Comments: typeof Comments
    Editor: typeof Editor
    LiveNote: typeof LiveNote
    History: typeof History
    Loader: typeof Loader
    Login: typeof Login
    NavHeader: typeof NavHeader
    NewPage: typeof NewPage
    Notify: typeof Notify
    NotFound: typeof NotFound
    PageSelector: typeof PageSelector
    PageUnlock: typeof PageUnlock
    PageSource: typeof PageSource
    Profile: typeof Profile
    Register: typeof Register
    SearchResults: typeof SearchResults
    SocialSharing: typeof SocialSharing
    Tags: typeof Tags
    Unauthorized: typeof Unauthorized
    VCardChin: typeof VCardChin
    VCardInfo: typeof VCardInfo
    Welcome: typeof Welcome
    WikiPage: typeof WikiPage
    VueScroll: typeof VueScroll
    NavFooter: typeof NavFooter
  }

  interface ComponentCustomProperties {
    $helpers: typeof helpers
    $i18n: I18next
    $moment: typeof moment
    $t: (key: string, options?: Record<string, unknown>) => string
  }
}
