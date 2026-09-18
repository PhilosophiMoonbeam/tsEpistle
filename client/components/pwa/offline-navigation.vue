<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { openOfflineStorage, subscribeOfflineStorageChanges, type OfflineStorage } from '../../helpers/offline-storage.ts'
import { offlineNavigationEntries } from '../../helpers/offline-routes.ts'
import { pwaState } from '../../helpers/pwa.ts'
import type { OfflineSnapshotRecord } from '../../../shared/offline.ts'

const props = defineProps<{ activePath?: string }>()
const emit = defineEmits<{ navigate: [] }>()
const records = shallowRef<readonly OfflineSnapshotRecord[]>([])
const loading = ref(true)
const error = ref('')
const clock = ref(Date.now())
const pages = computed(() => offlineNavigationEntries(records.value, window.location.origin, clock.value))
const connectionLabel = computed(() => pwaState.connectionState === 'online' ? 'Saved on this device'
  : pwaState.connectionState === 'checking' ? 'Checking connection'
  : pwaState.connectionState === 'server-unavailable' ? 'Server unavailable' : 'You’re offline')
let storage: OfflineStorage | null = null
let disposed = false
let sequence = 0
let unsubscribe: (() => void) | undefined
let expiryTimer: ReturnType<typeof setInterval> | undefined

async function loadPages(): Promise<void> {
  const current = storage
  if (!current) return
  const token = ++sequence
  try {
    const corpus = await current.readSnapshotCorpus()
    if (disposed || token !== sequence) return
    records.value = corpus.snapshots
    clock.value = Date.now()
    error.value = ''
  } catch {
    if (disposed || token !== sequence) return
    records.value = []
    error.value = 'Saved pages could not be read from this device.'
  } finally {
    if (!disposed && token === sequence) loading.value = false
  }
}
async function openStorage(): Promise<void> {
  loading.value = true
  error.value = ''
  const token = ++sequence
  storage?.close()
  storage = null
  try {
    const opened = await openOfflineStorage()
    if (disposed || token !== sequence) { opened.close(); return }
    storage = opened
    await loadPages()
  } catch {
    if (disposed || token !== sequence) return
    records.value = []
    loading.value = false
    error.value = 'Saved pages could not be read from this device.'
  }
}
function navigate(event: MouseEvent | KeyboardEvent): void {
  if (!event.defaultPrevented && (!('button' in event) || event.button === 0) && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) emit('navigate')
}
onMounted(() => {
  unsubscribe = subscribeOfflineStorageChanges(() => { void loadPages() })
  expiryTimer = setInterval(() => { clock.value = Date.now() }, 30_000)
  void openStorage()
})
onBeforeUnmount(() => {
  disposed = true
  sequence += 1
  unsubscribe?.()
  clearInterval(expiryTimer)
  storage?.close()
})
</script>

<template>
  <nav class="offline-navigation" aria-label="Browse saved pages">
    <div class="offline-navigation__heading">
      <h2>Browse</h2>
      <span v-if="!loading && !error" class="offline-navigation__count" aria-label="Saved page count">{{ pages.length }}</span>
    </div>
    <div class="nav-sidebar-offline" role="status">
      <v-icon size="18" aria-hidden="true">mdi-book-open-page-variant-outline</v-icon>
      <p><strong>{{ connectionLabel }}</strong><span>Only pages saved on this device are listed.</span></p>
    </div>
    <p v-if="loading" class="offline-navigation__message" role="status">Opening saved pages…</p>
    <div v-else-if="error" class="offline-navigation__message" role="status">
      <p>{{ error }}</p>
      <v-btn size="small" variant="text" @click="openStorage">Try again</v-btn>
    </div>
    <p v-else-if="!pages.length" class="offline-navigation__message">No saved pages yet. Save pages while connected to browse them here.</p>
    <v-list v-else class="offline-navigation__pages" nav density="compact">
      <v-list-item v-for="page in pages" :key="page.key" :href="page.href" data-no-wiki-navigation
        :active="props.activePath === page.href" :aria-current="props.activePath === page.href ? 'page' : undefined" @click="navigate">
        <template #prepend><v-icon size="20">mdi-file-document-outline</v-icon></template>
        <v-list-item-title>{{ page.title }}</v-list-item-title>
        <v-list-item-subtitle>{{ page.locale }}</v-list-item-subtitle>
      </v-list-item>
    </v-list>
    <v-divider class="mx-3" />
    <v-list nav density="compact">
      <v-list-item href="/p/offline" data-no-wiki-navigation prepend-icon="mdi-cloud-sync-outline" title="Offline access"
        :active="props.activePath === '/p/offline'" @click="navigate" />
    </v-list>
  </nav>
</template>

<style scoped>
.offline-navigation__heading { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: 1.1rem 1.25rem .5rem; }
.offline-navigation__heading h2 { margin: 0; font: 600 1rem var(--wiki-font-body); }
.offline-navigation__count { color: rgb(var(--v-theme-on-surface-variant)); font-size: .8125rem; font-variant-numeric: tabular-nums; }
.nav-sidebar-offline { display: flex; gap: .65rem; align-items: flex-start; padding: .5rem 1.25rem 1rem; color: rgb(var(--v-theme-on-surface-variant)); font-size: .8125rem; line-height: 1.5; }
.nav-sidebar-offline p { margin: 0; }
.nav-sidebar-offline strong { display: block; color: rgb(var(--v-theme-on-surface)); font-weight: 600; }
.nav-sidebar-offline span { display: block; margin-top: .2rem; }
.offline-navigation__message { margin: 0; padding: .5rem 1.25rem 1.25rem; font-size: .875rem; line-height: 1.6; color: rgb(var(--v-theme-on-surface-variant)); }
.offline-navigation__pages :deep(.v-list-item-title) { white-space: normal; line-height: 1.4; overflow-wrap: anywhere; }
.offline-navigation__pages :deep(.v-list-item__prepend > .v-icon) { margin-inline-end: .75rem; }
</style>
