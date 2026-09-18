<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue'
import OfflineLibrary from './components/pwa/offline-library.vue'
import OfflineSettings from './components/pwa/offline-settings.vue'
import { openOfflineStorage, type OfflineStorage } from './helpers/offline-storage.ts'
import { createOfflineSyncCoordinator, createOfflineSyncUnavailableResult, OFFLINE_SYNC_COORDINATOR_KEY, type OfflineSyncCoordinator, type OfflineSyncService } from './helpers/offline-sync.ts'
import { pwaState, retryServerConnection } from './helpers/pwa.ts'
import { wikiStore } from './store/index.ts'
import type { OfflineSnapshotRecord } from '../shared/offline.ts'

const settings = window.location.pathname === '/p/offline'
const siteTitle = siteConfig.title
const storage = shallowRef<OfflineStorage | null>(null)
const storageState = ref('checking')
const message = ref('')
const selected = shallowRef<OfflineSnapshotRecord | null>(null)
const drawer = ref(window.innerWidth >= 960)
const retrying = ref(false)
let coordinator: OfflineSyncCoordinator | null = null
let disposed = false
let restored = false
const requestedSelector = (() => {
  if (window.location.pathname !== '/_offline') return null
  const url = new URL(window.location.href)
  if (!url.search) {
    window.history.replaceState(window.history.state, '', url.hash === '#offline-policy-title' ? '/p/offline' : '/?saved=1')
    return null
  }
  const pageId = Number(url.searchParams.get('pageId'))
  const locale = url.searchParams.get('locale') ?? ''
  if (url.searchParams.get('site') !== window.location.origin || !Number.isSafeInteger(pageId) || pageId < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,34}$/.test(locale)) {
    message.value = 'This saved-page link is invalid. Choose a saved page below.'
    return null
  }
  return { siteId: window.location.origin, pageId, locale }
})()
const settingsView = settings || window.location.pathname === '/p/offline'
const service: OfflineSyncService = {
  reconcile: reason => coordinator?.reconcile(reason) ?? Promise.resolve(createOfflineSyncUnavailableResult('Offline storage is not ready yet.'))
}
provide(OFFLINE_SYNC_COORDINATOR_KEY, service)
const connectionMessage = computed(() => pwaState.connectionState === 'online'
  ? 'Connected. Saved pages are syncing.'
  : 'You’re offline. Saved pages are available; account actions and syncing will resume when you reconnect.')

async function openStorage(): Promise<void> {
  storageState.value = 'checking'
  try {
    const opened = await openOfflineStorage()
    if (disposed) { opened.close(); return }
    coordinator?.dispose()
    storage.value?.close()
    storage.value = opened
    storageState.value = 'available'
    coordinator = createOfflineSyncCoordinator({ storage: opened, siteId: window.location.origin,
      fetchImpl: window.fetch.bind(window), isOnline: () => pwaState.connectionState === 'online',
      isForeground: () => document.visibilityState === 'visible', isRetired: () => pwaState.mode === 'retirement' })
    coordinator.start()
  } catch {
    storageState.value = 'unavailable'
    message.value = 'Saved pages could not be opened on this device. Try again or reconnect.'
  }
}
async function retry(): Promise<void> {
  retrying.value = true
  try { await retryServerConnection(); await restoreServerPage() } finally { retrying.value = false }
}
async function restoreServerPage(): Promise<void> {
  if (settingsView || restored || pwaState.connectionState !== 'online') return
  const url = new URL(window.location.href)
  if (url.pathname === '/_offline' && requestedSelector) return
  if (url.pathname === '/_offline') url.pathname = '/'
  url.searchParams.delete('saved')
  restored = true
  try {
    // A health probe alone does not prove this document can be reached. This
    // fetch cannot receive a navigation fallback from the service worker.
    const response = await fetch(url, { credentials: 'same-origin',
      headers: { Accept: 'text/html', 'X-Wiki-Navigation': '1' }, signal: AbortSignal.timeout(8000) })
    await response.body?.cancel()
    if (!disposed && new URL(window.location.href).pathname === new URL(response.url).pathname) window.location.replace(url.href)
    else if (!disposed && response.redirected) window.location.replace(url.href)
    else restored = false
  } catch { restored = false }
}
watch(() => pwaState.connectionState, state => {
  if (state !== 'online') { coordinator?.invalidateIdentity(); return }
  coordinator?.observe('online')
  void restoreServerPage()
})
function selectRecord(record: OfflineSnapshotRecord | null): void {
  selected.value = record
  if (!record) return
  wikiStore.page.title = record.snapshot.title
  void restoreServerPage()
}
onMounted(() => {
  wikiStore.page.mode = settingsView ? 'profile' : 'view'
  document.title = `${settingsView ? 'Offline access' : 'Saved pages'} | ${siteTitle}`
  void openStorage()
})
onBeforeUnmount(() => { disposed = true; coordinator?.dispose(); storage.value?.close() })
</script>

<template>
  <v-app class="offline-application">
    <a class="offline-skip" href="#offline-main">Skip to content</a>
    <nav-header :local-navigation="true">
      <template #mobileBrand>
        <v-btn icon="mdi-menu" aria-label="Open navigation" @click="drawer = !drawer" />
        <span>{{ settingsView ? 'Profile' : siteTitle }}</span>
      </template>
    </nav-header>
    <v-navigation-drawer v-model="drawer" :permanent="$vuetify.display.mdAndUp" :temporary="$vuetify.display.smAndDown" :width="256">
      <div class="offline-nav-title">{{ settingsView ? 'Your workspace' : 'Browse' }}</div>
      <v-list nav aria-label="Main Menu">
        <v-list-item href="/" prepend-icon="mdi-home-outline" title="Home" />
        <v-list-item href="/p/offline#downloaded-pages-title" prepend-icon="mdi-book-open-page-variant-outline" title="Saved pages" />
        <v-list-item href="/p/offline" prepend-icon="mdi-cloud-sync-outline" title="Offline access" :active="settingsView" />
      </v-list>
      <p class="offline-nav-note">Your saved public pages are available on this device. Reconnect to access other pages and account features.</p>
    </v-navigation-drawer>
    <v-main id="offline-main" tabindex="-1">
      <div class="offline-connection" role="status">
        <v-icon :icon="pwaState.connectionState === 'online' ? 'mdi-cloud-check-outline' : 'mdi-cloud-off-outline'" size="20" />
        <span>{{ connectionMessage }}</span>
        <v-btn size="small" variant="text" :loading="retrying" @click="retry">Reconnect</v-btn>
      </div>
      <OfflineSettings v-if="settingsView" />
      <div v-else class="offline-reading-surface">
        <v-alert v-if="message" class="mb-4" type="info" variant="tonal">{{ message }}</v-alert>
        <OfflineLibrary :storage="storage" :storage-state="storageState" :storage-message="message"
          :requested-selector="requestedSelector" @retry-storage="openStorage" @error="message = $event" @selected="selectRecord" />
      </div>
    </v-main>
    <search-results />
    <notify />
  </v-app>
</template>

<style scoped>
.offline-application { font-family: var(--wiki-font-body); }
.offline-skip { position: fixed; top: -10rem; z-index: 9999; background: var(--wiki-surface-raised); padding: 1rem; }
.offline-skip:focus { top: .5rem; }
.offline-nav-title { padding: 1.5rem 1rem .5rem; font: 600 1.2rem var(--wiki-font-display); }
.offline-nav-note { padding: 1rem; color: var(--wiki-muted); font-size: .85rem; }
.offline-connection { display: flex; align-items: center; gap: .75rem; padding: .6rem 1.5rem; border-bottom: 1px solid var(--wiki-surface-border); background: var(--wiki-surface-raised); font-size: .875rem; }
.offline-connection span { flex: 1; }
.offline-reading-surface { margin: clamp(1rem, 3vw, 2.5rem); padding: clamp(1rem, 3vw, 2.5rem); border: 1px solid var(--wiki-surface-border); border-radius: 12px; background: var(--wiki-surface-raised); box-shadow: var(--wiki-shadow-sm); }
@media (max-width: 600px) { .offline-connection { padding: .5rem .75rem; gap: .4rem; } .offline-reading-surface { margin: .75rem; padding: 1rem; } }
</style>
