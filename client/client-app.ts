import { applyReaderLayout } from './helpers/reader-layout.ts'
import { createApp, shallowRef, watch } from 'vue'
import type { AsyncComponentLoader } from 'vue'
import { createVuetify } from 'vuetify'
import * as vuetifyLocaleMessages from 'vuetify/locale'
import Hammer from 'hammerjs'
import moment from 'moment-timezone'
import helpersPlugin, { applyUserPresentation } from './helpers/index.ts'
import boot from './modules/boot.ts'
import localization from './modules/localization.ts'
import { pinia, wikiStore } from './store/index.ts'
import { router } from './router'
import { registerPwa, setReloadSafetyProvider, pwaState } from './helpers/pwa.ts'
import { createWikiThemes, resolveThemeName, WIKI_THEME_VARIATIONS } from './helpers/theme.ts'
import { normalizeThemeColors } from '../shared/theme-colors.ts'
import { createAsyncComponent } from './components/common/async-component-state.vue'
import { openOfflineStorage, type OfflineStorage } from './helpers/offline-storage.ts'
import { createOfflineSyncCoordinator, type OfflineSyncCoordinator } from './helpers/offline-sync.ts'

type OfflineSyncService = {
  reconcile: (reason?: string) => Promise<unknown>
}
const OFFLINE_SYNC_COORDINATOR_KEY = 'offline-sync-coordinator'
const offlineSyncCoordinator = shallowRef<OfflineSyncCoordinator | null>(null)
let offlineSyncStorage: OfflineStorage | null = null
let offlineSyncStartToken = 0
let offlineSyncStartPromise: Promise<OfflineSyncCoordinator | null> | null = null
let offlineSyncPendingReconcile: Promise<unknown> | null = null
let stopOfflinePwaWatch: (() => void) | null = null
let pendingOfflineSyncReason: string | null = null
let offlineSyncLifecycleAttached = false

const handleOfflinePageHide = (event: PageTransitionEvent): void => {
  if (event.persisted) return
  stopOfflineSync()
}

const handleOfflinePageShow = (event: PageTransitionEvent): void => {
  if (!event.persisted) return
  void offlineSyncCoordinator.value?.reconcile('pageshow')
}

const attachOfflineSyncLifecycle = (): void => {
  if (offlineSyncLifecycleAttached) return
  window.addEventListener('pagehide', handleOfflinePageHide)
  window.addEventListener('pageshow', handleOfflinePageShow)
  offlineSyncLifecycleAttached = true
}

const detachOfflineSyncLifecycle = (): void => {
  if (!offlineSyncLifecycleAttached) return
  window.removeEventListener('pagehide', handleOfflinePageHide)
  window.removeEventListener('pageshow', handleOfflinePageShow)
  offlineSyncLifecycleAttached = false
}

const stopOfflineSync = (): void => {
  offlineSyncStartToken += 1
  offlineSyncPendingReconcile = null
  pendingOfflineSyncReason = null
  stopOfflinePwaWatch?.()
  stopOfflinePwaWatch = null
  offlineSyncCoordinator.value?.dispose()
  offlineSyncCoordinator.value = null
  offlineSyncStorage?.close()
  offlineSyncStorage = null
  detachOfflineSyncLifecycle()
}

const startOfflineSync = (): Promise<OfflineSyncCoordinator | null> => {
  const current = offlineSyncCoordinator.value
  if (current) return Promise.resolve(current)
  if (offlineSyncStartPromise) return offlineSyncStartPromise

  attachOfflineSyncLifecycle()
  const token = ++offlineSyncStartToken
  const started = (async (): Promise<OfflineSyncCoordinator | null> => {
    let storage: OfflineStorage | null = null
    let coordinator: OfflineSyncCoordinator | null = null
    try {
      storage = await openOfflineStorage()
      if (token !== offlineSyncStartToken) {
        storage.close()
        return null
      }
      coordinator = createOfflineSyncCoordinator({
        storage,
        siteId: window.location.origin,
        fetchImpl: window.fetch.bind(window),
        isOnline: () => pwaState.connectionState === 'online',
        isForeground: () => typeof document === 'undefined' || document.visibilityState === 'visible',
        isRetired: () => pwaState.mode === 'retirement'
      })
      offlineSyncStorage = storage
      offlineSyncCoordinator.value = coordinator
      stopOfflinePwaWatch = watch(() => pwaState.connectionState, state => {
        if (state === 'online') void coordinator?.reconcile('online')
      })
      coordinator.start()
      return coordinator
    } catch {
      stopOfflinePwaWatch?.()
      stopOfflinePwaWatch = null
      if (offlineSyncCoordinator.value === coordinator) {
        coordinator?.dispose()
        offlineSyncCoordinator.value = null
        offlineSyncStorage = null
      }
      storage?.close()
      return null
    }
  })()
  let sharedPromise: Promise<OfflineSyncCoordinator | null>
  sharedPromise = started.finally(() => {
    if (offlineSyncStartPromise === sharedPromise) offlineSyncStartPromise = null
  })
  offlineSyncStartPromise = sharedPromise
  return sharedPromise
}

const reconcileAfterOfflineSyncStartup = (reason: string): Promise<unknown> => {
  pendingOfflineSyncReason = reason
  if (offlineSyncPendingReconcile) return offlineSyncPendingReconcile
  let sharedPromise: Promise<unknown>
  sharedPromise = startOfflineSync().then(coordinator => {
    if (!coordinator) return null
    const pendingReason = pendingOfflineSyncReason
    pendingOfflineSyncReason = null
    return pendingReason ? coordinator.reconcile(pendingReason) : null
  }).finally(() => {
    if (offlineSyncPendingReconcile === sharedPromise) offlineSyncPendingReconcile = null
  })
  offlineSyncPendingReconcile = sharedPromise
  return sharedPromise
}

const offlineSyncService: OfflineSyncService = {
  reconcile (reason = 'manual'): Promise<unknown> {
    const coordinator = offlineSyncCoordinator.value
    if (coordinator) return coordinator.reconcile(reason)
    return reconcileAfterOfflineSyncStartup(reason)
  }
}

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

applyReaderLayout(siteConfig.readerLayout)
// Auth is fail-closed in the store and must not prevent the neutral shell from
// mounting when the server is slow or unavailable.
const authRefresh = wikiStore.refreshAuth()

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
app.provide(OFFLINE_SYNC_COORDINATOR_KEY, offlineSyncService)

window.Hammer = Hammer
window.WIKI = app
window.boot = boot

moment.locale(siteConfig.lang)
applyUserPresentation(wikiStore.user)

app.mount('#root')
void startOfflineSync()
void authRefresh.then(outcome => {
  if (outcome === 'authenticated') {
    applyUserPresentation(wikiStore.user)
    vuetify.theme.global.name.value = resolveThemeName(wikiStore.user.appearance, siteConfig.darkMode)
  }
})

boot.onDOMReady(() => {
  // Non-editor documents have no mutable editor facts to protect. The editor
  // coordinator replaces this provider with its complete safety snapshot.
  setReloadSafetyProvider(() => ({ safe: true, revision: 'client-app-ready', actorEpoch: 'client' }))
  void registerPwa({
    onNeedReload: () => {
      window.location.reload()
    }
  })
})
