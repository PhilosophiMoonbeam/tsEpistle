import { createVuetify } from 'vuetify'
import * as vuetifyLocaleMessages from 'vuetify/locale'
import { createWikiThemes, resolveThemeName, WIKI_THEME_VARIATIONS } from './theme.ts'
import { normalizeThemeColors } from '../../shared/theme-colors.ts'

export function createAppVuetify(appearance = '') {
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

return createVuetify({
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
      variant: 'flat'
    },
    VBtn: {
      elevation: 0,
      rounded: 'lg'
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
      rounded: 'pill',
      variant: 'tonal'
    },
    VDialog: {
      scrim: 'black',
      transition: 'dialog-transition'
    },
    VMenu: {
      offset: 6,
      transition: 'fade-transition'
    },
    VTooltip: {
      location: 'bottom',
      offset: 6,
      openDelay: 200,
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
    defaultTheme: resolveThemeName(appearance, siteConfig.darkMode),
    variations: WIKI_THEME_VARIATIONS,
    themes: createWikiThemes(normalizeThemeColors(siteConfig.themeColors)),
    transition: false
  }
})

}
