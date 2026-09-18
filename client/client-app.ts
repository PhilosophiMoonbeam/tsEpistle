import { rememberOfflinePresentation } from './helpers/offline-presentation.ts'
import { applyReaderLayout } from './helpers/reader-layout.ts'
import { createApp, shallowRef, watch } from 'vue'
import type { AsyncComponentLoader } from 'vue'
import { createAppVuetify } from './helpers/app-vuetify.ts'
import Hammer from 'hammerjs'
import moment from 'moment-timezone'
import helpersPlugin, { applyUserPresentation } from './helpers/index.ts'
import boot from './modules/boot.ts'
import localization from './modules/localization.ts'
import { pinia, wikiStore } from './store/index.ts'
import { router } from './router'
import { registerPwa, setReloadSafetyProvider, pwaState } from './helpers/pwa.ts'
import { installThemeSwitchGuard, resolveThemeName } from './helpers/theme.ts'
import { createAsyncComponent } from './components/common/async-component-state.vue'
import { openOfflineStorage, type OfflineStorage } from './helpers/offline-storage.ts'
import {
  createOfflineSyncCoordinator,
  createOfflineSyncUnavailableResult,
  type OfflineSyncCoordinator,
  type OfflineSyncResult,
  type OfflineSyncService
} from './helpers/offline-sync.ts'

const OFFLINE_SYNC_COORDINATOR_KEY = 'offline-sync-coordinator'
const offlineSyncCoordinator = shallowRef<OfflineSyncCoordinator | null>(null)
let offlineSyncStorage: OfflineStorage | null = null
let offlineSyncStartToken = 0
let offlineSyncStartPromise: Promise<OfflineSyncCoordinator | null> | null = null
let offlineSyncPendingReconcile: Promise<OfflineSyncResult> | null = null
let stopOfflinePwaWatch: (() => void) | null = null
let pendingOfflineSyncReason: string | null = null
let offlineSyncStartError: string | null = null
let offlineSyncLifecycleAttached = false

const observeOfflineSync = (coordinator: OfflineSyncCoordinator | null, reason: string): void => {
  coordinator?.observe(reason)
}
const handleOfflinePageHide = (event: PageTransitionEvent): void => {
  if (event.persisted) return
  stopOfflineSync()
}

const handleOfflinePageShow = (event: PageTransitionEvent): void => {
  if (!event.persisted) return
  observeOfflineSync(offlineSyncCoordinator.value, 'pageshow')
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
    try {
      storage = await openOfflineStorage()
      if (token !== offlineSyncStartToken) {
        storage.close()
        return null
      }
      const coordinator = createOfflineSyncCoordinator({
        storage,
        siteId: window.location.origin,
        fetchImpl: window.fetch.bind(window),
        isOnline: () => pwaState.connectionState === 'online',
        isForeground: () => typeof document === 'undefined' || document.visibilityState === 'visible',
        isRetired: () => pwaState.mode === 'retirement'
      })
      offlineSyncStartError = null
      offlineSyncStorage = storage
      offlineSyncCoordinator.value = coordinator
      stopOfflinePwaWatch = watch(
        () => pwaState.connectionState,
        state => {
          if (state === 'online') observeOfflineSync(coordinator, 'online')
          else coordinator.invalidateIdentity()
        }
      )
      coordinator.start()
      return coordinator
    } catch (error) {
      offlineSyncStartError = error instanceof Error && error.message.trim() ? error.message : 'Offline storage is unavailable.'
      stopOfflinePwaWatch?.()
      stopOfflinePwaWatch = null
      offlineSyncCoordinator.value?.dispose()
      offlineSyncCoordinator.value = null
      offlineSyncStorage = null
      storage?.close()
      detachOfflineSyncLifecycle()
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

const reconcileAfterOfflineSyncStartup = (reason: string): Promise<OfflineSyncResult> => {
  pendingOfflineSyncReason = reason
  if (offlineSyncPendingReconcile) return offlineSyncPendingReconcile
  const started: Promise<OfflineSyncResult> = startOfflineSync().then<OfflineSyncResult>(async (coordinator): Promise<OfflineSyncResult> => {
    if (!coordinator) return createOfflineSyncUnavailableResult(offlineSyncStartError ?? 'Offline storage is unavailable.')
    const pendingReason = pendingOfflineSyncReason
    pendingOfflineSyncReason = null
    return await (pendingReason ? coordinator.reconcile(pendingReason) : coordinator.reconcile(reason))
  })
  let sharedPromise: Promise<OfflineSyncResult>
  sharedPromise = started.finally(() => {
    if (offlineSyncPendingReconcile === sharedPromise) offlineSyncPendingReconcile = null
  })
  offlineSyncPendingReconcile = sharedPromise
  return sharedPromise
}

const offlineSyncService: OfflineSyncService = {
  async reconcile(reason = 'manual'): Promise<OfflineSyncResult> {
    const coordinator = offlineSyncCoordinator.value
    if (coordinator) return await coordinator.reconcile(reason)
    return await reconcileAfterOfflineSyncStartup(reason)
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
rememberOfflinePresentation()
watch(() => wikiStore.user.appearance, appearance => rememberOfflinePresentation(appearance))
// Auth is fail-closed in the store and must not prevent the neutral shell from
// mounting when the server is slow or unavailable.
const authRefresh = wikiStore.refreshAuth()

const vuetify = createAppVuetify(wikiStore.user.appearance)

const i18n = await localization.init()
const app = createApp({})

for (const [name, component] of registrations) app.component(name, component)

app.use(pinia)
app.use(router)
app.use(vuetify)
app.use(i18n)
app.use(helpersPlugin)
app.provide(OFFLINE_SYNC_COORDINATOR_KEY, offlineSyncService)

const removeThemeSwitchGuard = installThemeSwitchGuard(vuetify.theme)
app.onUnmount(removeThemeSwitchGuard)

window.Hammer = Hammer
window.WIKI = app
window.boot = boot

moment.locale(siteConfig.lang)
applyUserPresentation(wikiStore.user)

// Mutable screens replace this default during mount with their safety snapshot.
setReloadSafetyProvider(() => ({ safe: true, revision: 'client-app-ready', actorEpoch: 'client' }))
app.mount('#root')
void startOfflineSync()
void authRefresh.then(outcome => {
  if (outcome === 'authenticated') {
    applyUserPresentation(wikiStore.user)
    rememberOfflinePresentation(wikiStore.user.appearance)
    void vuetify.theme.change(resolveThemeName(wikiStore.user.appearance, siteConfig.darkMode), false)
  }
})

boot.onDOMReady(() => {
  void registerPwa({
    onNeedReload: () => {
      window.location.reload()
    }
  })
})
