import { createApp } from 'vue'
import i18next from 'i18next'
import OfflineApp from './offline-app.vue'
import NavHeader from './components/common/nav-header.vue'
import SearchResults from './components/common/search-results.vue'
import PageSelector from './components/common/page-selector.vue'
import Notify from './components/common/notify.vue'
import { pinia } from './store/index.ts'
import { createAppVuetify } from './helpers/app-vuetify.ts'
import { installThemeSwitchGuard } from './helpers/theme.ts'
import helpersPlugin from './helpers/index.ts'
import { fallbackLocalizationLabel } from './modules/localization.ts'
import { applyReaderLayout } from './helpers/reader-layout.ts'
import { preparePwaStartup, setReloadSafetyProvider } from './helpers/pwa.ts'

export async function mountOfflineApp(appearance: string): Promise<void> {
  setReloadSafetyProvider(() => ({ safe: true, revision: 'offline-reader', actorEpoch: 'neutral' }))
  if (
    (await preparePwaStartup('__TSEPISTLE_PWA_RELEASE__', {
      onNeedReload: () => window.location.reload()
    })) === 'reloading'
  )
    return
  // Bundled labels let the shared shell mount immediately without a locale API.
  await i18next.init({
    lng: siteConfig.lang,
    fallbackLng: 'en',
    resources: {},
    parseMissingKeyHandler: (key, fallback) => fallback ?? fallbackLocalizationLabel(key)
  })
  const app = createApp(OfflineApp)
  const vuetify = createAppVuetify(appearance)
  app.use(pinia).use(vuetify).use(helpersPlugin)
  app.config.globalProperties.$i18n = i18next
  app.config.globalProperties.$t = (key, options) => {
    const text = typeof options?.defaultValue === 'string' ? options.defaultValue : fallbackLocalizationLabel(key)
    // Bundled defaults use i18next placeholders such as {{count}}.
    return options ? text.replace(/\{\{\s*(\w+)\s*\}\}/gu, (match, name: string) => (name in options ? String(options[name]) : match)) : text
  }
  app.component('NavHeader', NavHeader)
  app.component('SearchResults', SearchResults)
  app.component('PageSelector', PageSelector)
  app.component('Notify', Notify)
  app.onUnmount(installThemeSwitchGuard(vuetify.theme))
  applyReaderLayout(siteConfig.readerLayout)
  window.WIKI = app
  app.mount('#offline-app')
}
