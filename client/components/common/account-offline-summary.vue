<template lang='pug'>
section.account-offline-summary(:aria-busy='loading ? `true` : `false`', :aria-label='$t(`common:offline.summary.region`, { defaultValue: `Offline reading` })')
  dl.account-offline-summary__facts
    .account-offline-summary__fact
      dt
        v-icon(:icon='connection.icon', :class='`account-offline-summary__tone--${connection.tone}`', size='18', aria-hidden='true')
        span {{ $t('common:offline.summary.connection', { defaultValue: 'Connection' }) }}
      dd(:class='`account-offline-summary__tone--${connection.tone}`') {{ connectionLabel($t) }}
    .account-offline-summary__fact
      dt
        v-icon(:icon='pageCount > 0 ? `mdi-cloud-check` : `mdi-cloud-outline`', :class='pageCount > 0 ? `account-offline-summary__tone--saved` : ``', size='18', aria-hidden='true')
        span {{ $t('common:offline.summary.savedOffline', { defaultValue: 'Saved offline' }) }}
      dd(role='status')
        template(v-if='loading') {{ $t('common:offline.summary.checking', { defaultValue: 'Checking…' }) }}
        span.account-offline-summary__error(v-else-if='error') {{ error }}
        template(v-else) {{ pageCountLabel($t) }}
    .account-offline-summary__fact(v-if='!loading && !error')
      dt
        v-icon(:icon='syncState.icon', :class='`account-offline-summary__tone--${syncState.tone}`', size='18', aria-hidden='true')
        span {{ $t('common:offline.summary.sync', { defaultValue: 'Sync' }) }}
      dd
        span(:class='`account-offline-summary__tone--${syncState.tone}`') {{ syncLabel($t) }}
        span.account-offline-summary__time(v-if='syncTime') {{ lastSyncedLabel($t) }}
  .account-offline-summary__actions
    v-btn(
      v-if='error'
      size='small'
      variant='text'
      color='primary'
      @click='load'
    ) {{ $t('common:offline.summary.tryAgain', { defaultValue: 'Try again' }) }}
    v-tooltip(location='bottom', :disabled='!syncBlockedReason($t)', :open-on-click='Boolean(syncBlockedReason($t))')
      template(v-slot:activator='{ props }')
        v-btn.account-offline-summary__sync-now(
          v-bind='props'
          size='small'
          variant='tonal'
          prepend-icon='mdi-cloud-sync-outline'
          :loading='syncing'
          :aria-disabled='syncBlockedReason($t) ? `true` : undefined'
          :class='{ "account-offline-summary__action--blocked": Boolean(syncBlockedReason($t)) }'
          @click='syncNow'
        ) {{ $t('common:offline.summary.syncNow', { defaultValue: 'Sync now' }) }}
      span {{ syncBlockedReason($t) }}
    v-btn.account-offline-summary__install(
      v-if='canInstall'
      size='small'
      variant='tonal'
      color='primary'
      prepend-icon='mdi-download-outline'
      :loading='installing'
      @click='installApp'
    ) {{ $t('common:offline.summary.installApp', { defaultValue: 'Install app' }) }}
  p.account-offline-summary__note(v-if='canInstall') {{ installHintLabel($t) }}
  p.account-offline-summary__error(v-if='pwaState.installError', role='alert') {{ pwaState.installError }}
  v-list-item.account-offline-summary__link.account-offline-summary__saved(
    href='/p/offline#downloaded-pages-title'
    data-no-wiki-navigation
  )
    template(v-slot:prepend): v-icon(size='20', aria-hidden='true') mdi-cloud-check-outline
    v-list-item-title {{ $t('common:offline.summary.savedPagesLink', { defaultValue: 'Saved pages' }) }}
    template(v-slot:append): v-icon(size='18', aria-hidden='true') mdi-chevron-right
  v-list-item.account-offline-summary__link.account-offline-summary__manage(
    href='/p/offline'
    data-no-wiki-navigation
  )
    template(v-slot:prepend): v-icon(size='20', aria-hidden='true') mdi-tune-variant
    v-list-item-title {{ $t('common:offline.summary.settingsLink', { defaultValue: 'Offline settings' }) }}
    template(v-slot:append): v-icon(size='18', aria-hidden='true') mdi-chevron-right
</template>

<script setup lang='ts'>
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { openOfflineStorage, subscribeOfflineStorageChanges, type OfflineStorage } from '../../helpers/offline-storage.ts'
import { OFFLINE_SYNC_COORDINATOR_KEY, type OfflineSyncService } from '../../helpers/offline-sync.ts'
import {
  currentOfflineReadingEpoch,
  currentOfflineReadingHandle,
  isCurrentOfflineReadingHandle,
  type OfflineReadingHandleV1
} from '../../helpers/offline-session.ts'
import { offlineSyncPresentation, translateConnection, type OfflineTranslate } from '../../helpers/offline-sync-status.ts'
import { promptPwaInstall, pwaConnectionPresentation, pwaState } from '../../helpers/pwa.ts'
import { helpers } from '../../helpers/index.ts'
import { wikiStore } from '../../store/index.ts'
import type { OfflineSnapshotRecord, OfflineSyncDiagnostics } from '../../../shared/offline.ts'

type VisibleRecord = OfflineSnapshotRecord & { readonly audience: 'public' | 'private' }

const syncService = inject<OfflineSyncService | null>(OFFLINE_SYNC_COORDINATOR_KEY, null)
const loading = ref(true)
const error = ref('')
const pageCount = ref(0)
const syncing = ref(false)
const installing = ref(false)
const diagnostics = shallowRef<OfflineSyncDiagnostics | null>(null)
let storage: OfflineStorage | null = null
let disposed = false
let sequence = 0
let unsubscribe: (() => void) | undefined

const selectorKey = (record: VisibleRecord): string => `${record.siteId}\u0000${record.pageId}\u0000${record.locale}`

const connection = computed(() => pwaConnectionPresentation(pwaState))
const connected = computed(() => pwaState.connection === 'online' && pwaState.serverReachable === true && pwaState.serverHealthy === true)
const connectionLabel = (t: OfflineTranslate): string => translateConnection(connection.value, t)
const syncState = computed(() => offlineSyncPresentation(diagnostics.value, syncing.value))
const syncLabel = (t: OfflineTranslate): string => syncState.value.label(t)
// Same formatter as the page's "Updated" line, so the time follows the
// user's chosen time zone and date/time format, not the browser's.
const syncTime = computed(() => {
  const lastSuccessAt = diagnostics.value?.lastSuccessAt
  if (!lastSuccessAt || Number.isNaN(Date.parse(lastSuccessAt))) return ''
  const formatted = helpers.formatMoment(lastSuccessAt, 'calendar')
  return typeof formatted === 'string' ? formatted : ''
})
const pageCountLabel = (t: OfflineTranslate): string =>
  pageCount.value === 1
    ? t('common:offline.summary.pageCountOne', { count: 1, defaultValue: '1 page on this device' })
    : t('common:offline.summary.pageCountOther', { count: pageCount.value, defaultValue: '{{count}} pages on this device' })

// Kept in script: a `{{name}}` default inside a template mustache would end the interpolation.
const lastSyncedLabel = (t: OfflineTranslate): string =>
  t('common:offline.summary.lastSynced', { time: syncTime.value, defaultValue: 'Last synced {{time}}', interpolation: { escapeValue: false } })
const installHintLabel = (t: OfflineTranslate): string =>
  t('common:offline.summary.installHint', { site: siteTitle.value, defaultValue: 'Add {{site}} to your apps or home screen.', interpolation: { escapeValue: false } })

const syncBlockedReason = (t: OfflineTranslate): string => {
  if (!syncService) return t('common:offline.summary.syncUnavailable', { defaultValue: 'Offline sync is not available in this browser.' })
  if (!connected.value) return t('common:offline.summary.syncNeedsConnection', { defaultValue: 'Sync needs a server connection.' })
  return ''
}

const siteTitle = computed(() => wikiStore.site.title?.trim() || (typeof siteConfig === 'undefined' ? '' : siteConfig.title?.trim() ?? '') || 'this wiki')
const canInstall = computed(() =>
  pwaState.installPromptAvailable && pwaState.installAvailability === 'available' && !pwaState.installed && !pwaState.isStandalone
)

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

async function syncNow (): Promise<void> {
  // aria-disabled keeps the button focusable so the tooltip can explain the reason.
  if (syncing.value || !syncService || !connected.value) return
  syncing.value = true
  try {
    await syncService.reconcile('manual')
  } catch {
    // The sync diagnostics written by the coordinator carry the failure detail.
  } finally {
    syncing.value = false
    if (!disposed) void load()
  }
}

async function installApp (): Promise<void> {
  if (!canInstall.value || installing.value) return
  installing.value = true
  try {
    await promptPwaInstall()
  } finally {
    installing.value = false
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

.account-offline-summary__facts {
  display: grid;
  gap: var(--wiki-space-2);
  margin: 0;
}

.account-offline-summary__fact {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--wiki-space-3);
  min-width: 0;
  font-size: .8125rem;

  dt {
    display: inline-flex;
    align-items: center;
    gap: var(--wiki-space-1);
    color: var(--wiki-text-muted);
  }

  dd {
    display: grid;
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-weight: 650;
    text-align: end;
    min-width: 0;
    overflow-wrap: anywhere;
  }
}

.account-offline-summary__time,
.account-offline-summary__note {
  color: var(--wiki-text-muted);
  font-size: .75rem;
  font-weight: 400;
}

.account-offline-summary__note {
  margin: 0;
}

.account-offline-summary__tone--success { color: rgb(var(--v-theme-success)); }
.account-offline-summary__tone--warning { color: rgb(var(--v-theme-warning)); }
.account-offline-summary__tone--error { color: rgb(var(--v-theme-error)); }
.account-offline-summary__tone--saved { color: var(--wiki-accent-warm); }
.account-offline-summary__tone--muted { color: var(--wiki-text-muted); }

.account-offline-summary__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
}

.account-offline-summary__actions :deep(.v-btn) {
  text-transform: none;
}

.account-offline-summary__action--blocked {
  cursor: default;
}

.account-offline-summary__error {
  color: rgb(var(--v-theme-error));
  margin: 0;
}

.account-offline-summary__link {
  min-height: 40px;
}
</style>
