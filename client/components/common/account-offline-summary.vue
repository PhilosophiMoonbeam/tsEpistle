<template lang='pug'>
section.account-offline-summary(:aria-busy='loading ? `true` : `false`')
  .account-offline-summary__status(role='status')
    template(v-if='loading')
      span.account-offline-summary__muted Checking saved pages…
    template(v-else-if='error')
      span.account-offline-summary__error {{ error }}
      v-btn(size='small', variant='text', color='primary', @click='load') Try again
    template(v-else)
      .account-offline-summary__metric
        span.account-offline-summary__count(:aria-label='`Saved pages: ${pageCount}`') {{ pageCount }}
        span.account-offline-summary__count-label {{ pageCount === 1 ? `page saved on this device` : `pages saved on this device` }}
      .account-offline-summary__sync
        v-icon(:color='syncTone', size='16') {{ syncIcon }}
        span.account-offline-summary__sync-label(:class='`account-offline-summary__sync-label--${syncTone}`') {{ syncLabel }}
        span.account-offline-summary__sync-time(v-if='syncTime') {{ syncTime }}
  v-list-item.account-offline-summary__manage(
    href='/p/offline'
    data-no-wiki-navigation
    aria-label='Manage offline access'
  )
    template(v-slot:prepend): v-icon(size='20', aria-hidden='true') mdi-book-open-page-variant-outline
    v-list-item-title Manage offline access
    template(v-slot:append): v-icon(size='18', aria-hidden='true') mdi-chevron-right
</template>

<script setup lang='ts'>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { openOfflineStorage, subscribeOfflineStorageChanges, type OfflineStorage } from '../../helpers/offline-storage.ts'
import {
  currentOfflineReadingEpoch,
  currentOfflineReadingHandle,
  isCurrentOfflineReadingHandle,
  type OfflineReadingHandleV1
} from '../../helpers/offline-session.ts'
import type { OfflineSnapshotRecord, OfflineSyncDiagnostics } from '../../../shared/offline.ts'

type VisibleRecord = OfflineSnapshotRecord & { readonly audience: 'public' | 'private' }

const loading = ref(true)
const error = ref('')
const pageCount = ref(0)
const diagnostics = shallowRef<OfflineSyncDiagnostics | null>(null)
let storage: OfflineStorage | null = null
let disposed = false
let sequence = 0
let unsubscribe: (() => void) | undefined

const selectorKey = (record: VisibleRecord): string => `${record.siteId}\u0000${record.pageId}\u0000${record.locale}`

const syncState = computed<{ readonly label: string; readonly tone: 'success' | 'warning' | 'error' | 'muted'; readonly icon: string }>(() => {
  const d = diagnostics.value
  if (!d) return { label: 'Not synced yet', tone: 'muted', icon: 'mdi-progress-clock' }
  if (d.status === 'running') return { label: 'Syncing…', tone: 'success', icon: 'mdi-progress-sync' }
  if (d.status === 'complete' && d.pendingCount === 0) return { label: 'Sync is current', tone: 'success', icon: 'mdi-check-circle-outline' }
  if (d.status === 'complete' && d.pendingCount > 0) return { label: `${d.pendingCount} page${d.pendingCount === 1 ? '' : 's'} pending sync`, tone: 'warning', icon: 'mdi-progress-clock' }
  if (d.status === 'partial') return { label: `Last sync partial · ${d.pendingCount} pending`, tone: 'warning', icon: 'mdi-alert-outline' }
  if (d.status === 'offline') return { label: 'Offline · will sync when reconnected', tone: 'warning', icon: 'mdi-cloud-offline-outline' }
  if (d.status === 'error') return { label: 'Sync error · will retry', tone: 'error', icon: 'mdi-alert-circle-outline' }
  return { label: 'Not synced yet', tone: 'muted', icon: 'mdi-help-circle-outline' }
})

const syncLabel = computed(() => syncState.value.label)
const syncTone = computed(() => syncState.value.tone)
const syncIcon = computed(() => syncState.value.icon)
const syncTime = computed(() => {
  const d = diagnostics.value
  if (!d || !d.lastSuccessAt) return ''
  const when = new Date(d.lastSuccessAt)
  if (Number.isNaN(when.valueOf())) return ''
  return `· last synced ${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
})

const currentReading = (): { readonly handle: OfflineReadingHandleV1 | null; readonly epoch: number } => {
  const handle = currentOfflineReadingHandle()
  return { handle: handle && isCurrentOfflineReadingHandle(handle) ? handle : null, epoch: currentOfflineReadingEpoch() }
}

const readingIsCurrent = (handle: OfflineReadingHandleV1 | null, epoch: number): boolean => {
  if (disposed || currentOfflineReadingEpoch() !== epoch) return false
  const current = currentOfflineReadingHandle()
  return handle === null ? current === null : current === handle && isCurrentOfflineReadingHandle(handle)
}

async function load (): Promise<void> {
  const current = storage
  if (!current || disposed) return
  const token = ++sequence
  loading.value = true
  try {
    const origin = window.location.origin
    const reading = currentReading()
    const publicCorpus = await current.readSnapshotCorpus()
    if (disposed || token !== sequence || !readingIsCurrent(reading.handle, reading.epoch)) return
    const visible = new Map<string, VisibleRecord>()
    for (const record of publicCorpus.snapshots) {
      if (record.siteId !== origin || record.pageId !== record.snapshot.pageId || record.locale !== record.snapshot.locale) continue
      visible.set(selectorKey({ ...record, audience: 'public' }), { ...record, audience: 'public' })
    }
    if (reading.handle) {
      try {
        const privateCorpus = await current.readSnapshotCorpus({
          readingHandle: reading.handle,
          expectedSessionGeneration: reading.handle.sessionGeneration,
          expectedCorpusRevision: publicCorpus.corpusRevision
        })
        if (!readingIsCurrent(reading.handle, reading.epoch)) return
        for (const record of privateCorpus.snapshots) {
          if (record.siteId !== origin || record.pageId !== record.snapshot.pageId || record.locale !== record.snapshot.locale) continue
          visible.set(selectorKey({ ...record, audience: 'private' }), { ...record, audience: 'private' })
        }
      } catch {
        // Private corpus is unavailable without a verified reading session; public count stays authoritative.
      }
    }
    if (disposed || token !== sequence) return
    const policy = await current.readOfflinePolicy()
    if (disposed || token !== sequence) return
    pageCount.value = visible.size
    diagnostics.value = policy.state.syncDiagnostics
    error.value = ''
  } catch (err) {
    if (disposed || token !== sequence) return
    error.value = err instanceof Error && err.message.trim() ? err.message : 'Saved pages could not be read from this device.'
  } finally {
    if (token === sequence) loading.value = false
  }
}

onMounted(() => {
  unsubscribe = subscribeOfflineStorageChanges(() => {
    void load()
  })
  void openStorage()
})
onBeforeUnmount(() => {
  disposed = true
  sequence += 1
  unsubscribe?.()
  storage?.close()
})

async function openStorage (): Promise<void> {
  try {
    const opened = await openOfflineStorage()
    if (disposed) {
      opened.close()
      return
    }
    storage?.close()
    storage = opened
    await load()
  } catch (err) {
    if (disposed) return
    error.value = err instanceof Error && err.message.trim() ? err.message : 'Offline storage is not available on this device.'
    loading.value = false
  }
}
</script>

<style lang='scss' scoped>
.account-offline-summary {
  display: grid;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-2) var(--wiki-space-3);
}

.account-offline-summary__status {
  display: grid;
  gap: var(--wiki-space-2);
}

.account-offline-summary__metric {
  display: flex;
  align-items: baseline;
  gap: var(--wiki-space-2);
  min-width: 0;
}

.account-offline-summary__count {
  font-size: 1.5rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: rgb(var(--v-theme-on-surface));
}

.account-offline-summary__sync {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-1);
  min-width: 0;
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: .8125rem;
}

.account-offline-summary__sync-label--success { color: rgb(var(--v-theme-success)); }
.account-offline-summary__sync-label--error { color: rgb(var(--v-theme-error)); }

.account-offline-summary__error {
  color: rgb(var(--v-theme-error));
}

.account-offline-summary__manage {
  min-height: 40px;
}
</style>
