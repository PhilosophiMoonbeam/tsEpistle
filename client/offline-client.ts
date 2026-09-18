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
import { registerPwa, setReloadSafetyProvider } from './helpers/pwa.ts'

export async function mountOfflineApp(appearance: string): Promise<void> {
  // Bundled labels let the shared shell mount immediately without a locale API.
  await i18next.init({ lng: siteConfig.lang, fallbackLng: 'en', resources: {},
    parseMissingKeyHandler: (key, fallback) => fallback ?? fallbackLocalizationLabel(key) })
  const app = createApp(OfflineApp)
  const vuetify = createAppVuetify(appearance)
  app.use(pinia).use(vuetify).use(helpersPlugin)
  app.config.globalProperties.$i18n = i18next
  app.config.globalProperties.$t = (key, options) => typeof options?.defaultValue === 'string' ? options.defaultValue : fallbackLocalizationLabel(key)
  app.component('NavHeader', NavHeader)
  app.component('SearchResults', SearchResults)
  app.component('PageSelector', PageSelector)
  app.component('Notify', Notify)
  app.onUnmount(installThemeSwitchGuard(vuetify.theme))
  applyReaderLayout(siteConfig.readerLayout)
  window.WIKI = app
  setReloadSafetyProvider(() => ({ safe: true, revision: 'offline-reader', actorEpoch: 'neutral' }))
  app.mount('#offline-app')
  void registerPwa({ onNeedReload: () => window.location.reload() })
}
