import { createApp } from 'vue'
import type { AsyncComponentLoader } from 'vue'
import { createVuetify } from 'vuetify'
import * as vuetifyLocaleMessages from 'vuetify/locale'
import Hammer from 'hammerjs'
import moment from 'moment-timezone'
import helpersPlugin from './helpers/index.ts'
import boot from './modules/boot.ts'
import localization from './modules/localization.ts'
import { pinia, wikiStore } from './store/index.ts'
import { router } from './router'
import { createWikiThemes, resolveThemeName, WIKI_THEME_VARIATIONS } from './helpers/theme.ts'
import { normalizeThemeColors } from '../shared/theme-colors.ts'
import { createAsyncComponent } from './components/common/async-component-state.vue'

const asyncComponent = (name: string, loader: AsyncComponentLoader) => [name, createAsyncComponent(loader)] as const

const registrations = [
  asyncComponent('Admin', () => import('./components/admin.vue')),
  asyncComponent('AdminHero', () => import('./components/common/admin-hero.vue')),
  asyncComponent('Comments', () => import('./components/comments.vue')),
  asyncComponent('Editor', () => import('./components/editor.vue')),
  asyncComponent('History', () => import('./components/history.vue')),
  asyncComponent('Loader', () => import('./components/common/loader.vue')),
  asyncComponent('Login', () => import('./components/login.vue')),
  asyncComponent('NavHeader', () => import('./components/common/nav-header.vue')),
  asyncComponent('NewPage', () => import('./components/new-page.vue')),
  asyncComponent('Notify', () => import('./components/common/notify.vue')),
  asyncComponent('NotFound', () => import('./components/not-found.vue')),
  asyncComponent('PageSelector', () => import('./components/common/page-selector.vue')),
  asyncComponent('PageUnlock', () => import('./components/page-unlock.vue')),
  asyncComponent('PageSource', () => import('./components/source.vue')),
  asyncComponent('Profile', () => import('./components/profile.vue')),
  asyncComponent('Register', () => import('./components/register.vue')),
  asyncComponent('SearchResults', () => import('./components/common/search-results.vue')),
  asyncComponent('SocialSharing', () => import('./components/common/social-sharing.vue')),
  asyncComponent('Tags', () => import('./components/tags.vue')),
  asyncComponent('Unauthorized', () => import('./components/unauthorized.vue')),
  asyncComponent('VCardChin', () => import('./components/common/v-card-chin.vue')),
  asyncComponent('VCardInfo', () => import('./components/common/v-card-info.vue')),
  asyncComponent('Welcome', () => import('./components/welcome.vue')),
  asyncComponent('WikiPage', () => import('./components/wiki-page.vue')),
  asyncComponent('VueScroll', () => import('./components/common/vue-scroll.vue')),
  asyncComponent('NavFooter', () => import('./themes/default/components/nav-footer.vue'))
]

wikiStore.refreshAuth()
const resolveVuetifyMessageLocale = (language: string): keyof typeof vuetifyLocaleMessages | undefined => {
  const languageParts = language.trim().toLowerCase().replaceAll('_', '-').split('-')
  const baseLanguage = languageParts[0]

  if (baseLanguage === 'sr') return languageParts.includes('latn') ? 'srLatn' : 'srCyrl'
  if (baseLanguage === 'zh') {
    const usesTraditionalCharacters =
      languageParts.includes('hant') || languageParts.includes('tw') || languageParts.includes('hk') || languageParts.includes('mo')
    return usesTraditionalCharacters ? 'zhHant' : 'zhHans'
  }

  return Object.hasOwn(vuetifyLocaleMessages, baseLanguage) ? (baseLanguage as keyof typeof vuetifyLocaleMessages) : undefined
}

const vuetifyMessageLocale = resolveVuetifyMessageLocale(siteConfig.lang)
const selectedVuetifyMessages = vuetifyMessageLocale
  ? { en: vuetifyLocaleMessages.en, [siteConfig.lang]: vuetifyLocaleMessages[vuetifyMessageLocale] }
  : { en: vuetifyLocaleMessages.en }

const vuetify = createVuetify({
  locale: {
    fallback: 'en',
    locale: siteConfig.lang,
    messages: selectedVuetifyMessages,
    rtl: { [siteConfig.lang]: siteConfig.rtl }
  },
  defaults: {
    VCard: {
      elevation: 0,
      rounded: 'lg',
      variant: 'elevated'
    },
    VBtn: {
      elevation: 0
    },
    VTextField: {
      baseColor: 'on-surface',
      color: 'primary',
      rounded: 'lg',
      variant: 'outlined'
    },
    VTextarea: {
      baseColor: 'on-surface',
      color: 'primary',
      rounded: 'lg',
      variant: 'outlined'
    },
    VSelect: {
      baseColor: 'on-surface',
      color: 'primary',
      rounded: 'lg',
      variant: 'outlined'
    },
    VAutocomplete: {
      baseColor: 'on-surface',
      color: 'primary',
      rounded: 'lg',
      variant: 'outlined'
    },
    VCombobox: {
      baseColor: 'on-surface',
      color: 'primary',
      rounded: 'lg',
      variant: 'outlined'
    },
    VChip: {
      rounded: 'lg',
      variant: 'tonal'
    },
    VDialog: {
      scrim: 'on-surface',
      transition: 'dialog-transition'
    },
    VMenu: {
      offset: 8,
      transition: 'fade-transition'
    },
    VTooltip: {
      location: 'bottom',
      offset: 8,
      openDelay: 400,
      transition: 'fade-transition'
    },
    VDataTable: {
      density: 'comfortable',
      hover: true
    },
    VNavigationDrawer: {
      elevation: 0
    },
    VAppBar: {
      elevation: 0
    }
  },
  theme: {
    defaultTheme: resolveThemeName(wikiStore.user.appearance, siteConfig.darkMode),
    variations: WIKI_THEME_VARIATIONS,
    themes: createWikiThemes(normalizeThemeColors(siteConfig.themeColors)),
    transition: { duration: '180ms' }
  }
})

const i18n = await localization.init()
const app = createApp({})

for (const [name, component] of registrations) app.component(name, component)

app.use(pinia)
app.use(router)
app.use(vuetify)
app.use(i18n)
app.use(helpersPlugin)

window.Hammer = Hammer
window.WIKI = app
window.boot = boot

moment.locale(siteConfig.lang)
if (wikiStore.user.dateFormat) {
  moment.updateLocale(moment.locale(), { longDateFormat: { L: wikiStore.user.dateFormat } } as moment.LocaleSpecification)
}
if (wikiStore.user.timezone) moment.tz.setDefault(wikiStore.user.timezone)

app.mount('#root')
