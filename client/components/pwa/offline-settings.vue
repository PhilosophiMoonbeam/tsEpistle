<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import OfflineLibrary from './offline-library.vue'
import PwaStatus from './pwa-status.vue'
import { OfflineStorageError, openOfflineStorage, subscribeOfflineStorageChanges, type OfflineStorage } from '../../helpers/offline-storage.ts'
import { createOfflineSyncUnavailableResult, OFFLINE_SYNC_COORDINATOR_KEY, type OfflineSyncService } from '../../helpers/offline-sync.ts'
import {
  currentOfflineReadingHandle,
  decodeOfflineReadingSecret,
  enrollOfflineReading,
  isCurrentOfflineReadingHandle,
  lockOfflineReading,
  OFFLINE_READING_STATE_EVENT,
  OFFLINE_SESSION_INVALIDATED_EVENT,
  unlockOfflineReading
} from '../../helpers/offline-session.ts'
import { wikiStore } from '../../store/index.ts'
import type { OfflineStorageEstimate } from '../../../shared/offline.ts'
import { createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope.ts'
import { notifyReloadSafetyChanged, setReloadSafetyProvider } from '../../helpers/pwa.ts'

type StorageState = 'uninspected' | 'checking' | 'available' | 'unavailable' | 'unsupported-schema' | 'blocked-upgrade' | 'quota'
const browserAvailable = typeof window !== 'undefined' && typeof navigator !== 'undefined'
const offlineSyncService = inject<OfflineSyncService>(OFFLINE_SYNC_COORDINATOR_KEY)
const offlineStorage = shallowRef<OfflineStorage | null>(null)
const storageEstimate = shallowRef<OfflineStorageEstimate | null>(null)
const storageState = ref<StorageState>('uninspected')
const storageMessage = ref('Offline storage has not been checked yet.')
const storageBusy = ref(false)
type ReadingState = 'setup-required' | 'locked' | 'unlocked' | 'unavailable'
const readingState = ref<ReadingState>('unavailable')
const readingMessage = ref('')
const readingBusy = ref(false)
const unlockSecret = ref('')
const enrollmentSecret = ref('')
const enrollmentConfirmation = ref('')
const enrollmentNotice = ref('')
const enrollmentConfirming = ref(false)
let enrollmentController: AbortController | null = null
let unlockController: AbortController | null = null
let enrollmentResolver: ((confirmed: boolean) => void) | null = null
let stopReadingStateEvents: (() => void) | null = null
const persistenceBusy = ref(false)
const clearBusy = ref(false)
const clearDialogOpen = ref(false)
const clearDialog = ref<HTMLElement | null>(null)
const clearExpectedGeneration = ref<number | null>(null)
const clearRestoreTarget = shallowRef<HTMLElement | null>(null)
const clearDeviceToken = ref(0)
const removeNotice = ref('')
const clearNotice = ref('')
const libraryNotice = ref('')
const libraryRefreshToken = ref(0)
const verifiedAccount = computed(() => {
  if (
    wikiStore.authRefreshOutcome !== 'authenticated' ||
    wikiStore.offlineIdentityReady !== true ||
    wikiStore.user.authenticated !== true ||
    !Number.isSafeInteger(wikiStore.user.id) ||
    wikiStore.user.id < 1 ||
    !Number.isSafeInteger(wikiStore.user.authVersion) ||
    wikiStore.user.authVersion < 0
  )
    return null
  return { accountId: wikiStore.user.id, authVersion: wikiStore.user.authVersion }
})
const readingStateLabel = computed(() => ({
  'setup-required': 'Not set up',
  locked: 'Locked',
  unlocked: 'Unlocked',
  unavailable: 'Unavailable'
}[readingState.value]))
const readingStateDescription = computed(() => ({
  'setup-required': 'Enable private offline reading after the server verifies your account.',
  locked: 'A private vault is saved on this device. Enter its secret to unlock private pages.',
  unlocked: 'Private offline pages are available in this browser until you lock them.',
  unavailable: 'Private offline reading is unavailable until this device can open offline storage.'
}[readingState.value]))
const libraryBusy = ref(false)
let safetyRevision = 0
let ownsReloadSafety = false
let clearFocusScope: ModalFocusScope | null = null
let storageOpenToken = 0
let unsubscribeStorageChanges: (() => void) | null = null

const reloadBlocked = computed(() => storageBusy.value || persistenceBusy.value || clearBusy.value || clearDialogOpen.value || libraryBusy.value || readingBusy.value)
watch([storageBusy, persistenceBusy, clearBusy, clearDialogOpen, libraryBusy, readingBusy], () => {
  safetyRevision += 1
  if (ownsReloadSafety) notifyReloadSafetyChanged()
}, { flush: 'sync' })

const storageDetail = computed(() => {
  if (storageState.value !== 'available' || !storageEstimate.value) return storageMessage.value
  const estimate = storageEstimate.value
  const capacity = estimate.usageBytes !== null && estimate.quotaBytes !== null
    ? ` Browser storage: ${formatBytes(estimate.usageBytes)} of ${formatBytes(estimate.quotaBytes)}.` : ''
  return `${estimate.snapshotCount} saved page${estimate.snapshotCount === 1 ? '' : 's'} using ${formatBytes(estimate.managedBytes)}.${capacity}`
})

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'unknown size'
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KiB', 'MiB', 'GiB']
  let amount = value / 1024
  let unit = units[0]
  for (let index = 1; amount >= 1024 && index < units.length; index += 1) {
    amount /= 1024
    unit = units[index]
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`
}

function storageFailure(error: unknown): { state: StorageState; message: string } {
  const code = error instanceof OfflineStorageError ? error.code : ''
  if (code === 'unsupported-schema')
    return { state: 'unsupported-schema', message: 'Your saved data needs a newer version of tsEpistle. Update the app to access it; your data has been preserved.' }
  if (code === 'blocked-upgrade')
    return { state: 'blocked-upgrade', message: 'Another tab is holding the offline database open. Close that tab or try again.' }
  if (code === 'quota') return { state: 'quota', message: 'The browser declined local storage because its quota is full. No records were evicted silently.' }
  return {
    state: 'unavailable',
    message: error instanceof Error && error.message.trim() ? error.message : 'This browser could not open offline storage. Downloaded pages remain on the server.'
  }
}

async function refreshStorageStatus(): Promise<boolean> {
  const storage = offlineStorage.value
  if (!storage) return false
  try {
    const estimate = await storage.storageStatus()
    if (offlineStorage.value !== storage) return false
    storageEstimate.value = estimate
    storageState.value = 'available'
    return true
  } catch (error) {
    if (offlineStorage.value !== storage) return false
    const failure = storageFailure(error)
    storageState.value = failure.state
    storageMessage.value = failure.message
    storageEstimate.value = null
    if (failure.state === 'unsupported-schema' || failure.state === 'blocked-upgrade') {
      storage.close()
      offlineStorage.value = null
    }
    return false
  }
}
async function refreshReadingState(): Promise<void> {
  const storage = offlineStorage.value
  if (!storage || storageState.value !== 'available') {
    readingState.value = 'unavailable'
    return
  }
  try {
    const vault = await storage.getReadingVault()
    if (offlineStorage.value !== storage) return
    if (!vault) {
      readingState.value = 'setup-required'
      readingMessage.value = ''
      return
    }
    const handle = currentOfflineReadingHandle()
    readingState.value = handle && isCurrentOfflineReadingHandle(handle) ? 'unlocked' : 'locked'
    readingMessage.value = ''
  } catch {
    if (offlineStorage.value !== storage) return
    readingState.value = 'unavailable'
    readingMessage.value = 'Private offline reading is unavailable on this device.'
  }
}

function cancelEnrollment(): void {
  enrollmentController?.abort()
  enrollmentResolver?.(false)
  enrollmentResolver = null
  enrollmentConfirming.value = false
  enrollmentSecret.value = ''
  enrollmentConfirmation.value = ''
  readingBusy.value = false
}

async function beginEnrollment(): Promise<void> {
  const storage = offlineStorage.value
  const account = verifiedAccount.value
  if (!storage || !account || readingBusy.value || readingState.value !== 'setup-required') return
  readingBusy.value = true
  enrollmentNotice.value = ''
  enrollmentSecret.value = ''
  enrollmentConfirmation.value = ''
  enrollmentConfirming.value = false
  const controller = new AbortController()
  enrollmentController = controller
  let result: Awaited<ReturnType<typeof enrollOfflineReading>> | null = null
  try {
    const generation = await storage.currentSessionGeneration()
    if (enrollmentController !== controller || controller.signal.aborted) return
    result = await enrollOfflineReading(window.fetch.bind(window), storage, {
      expectedAccountId: account.accountId,
      expectedAuthVersion: account.authVersion,
      expectedSessionGeneration: generation,
      signal: controller.signal,
      confirmSecret: displaySecret =>
        new Promise<boolean>(resolve => {
          enrollmentSecret.value = displaySecret
          enrollmentConfirming.value = true
          enrollmentResolver = resolve
        })
    })
    if (controller.signal.aborted || enrollmentController !== controller) return
    enrollmentNotice.value = 'Private offline reading is enabled on this device.'
    readingState.value = 'unlocked'
  } catch {
    if (!controller.signal.aborted) enrollmentNotice.value = 'Private offline reading could not be enabled.'
    await refreshReadingState()
  } finally {
    result?.secret.fill(0)
    if (enrollmentController === controller) enrollmentController = null
    enrollmentResolver = null
    enrollmentConfirming.value = false
    enrollmentSecret.value = ''
    enrollmentConfirmation.value = ''
    readingBusy.value = false
  }
}

function confirmEnrollment(): void {
  if (!enrollmentResolver) return
  if (enrollmentConfirmation.value !== enrollmentSecret.value) {
    enrollmentNotice.value = 'The confirmation could not be accepted.'
    return
  }
  const resolver = enrollmentResolver
  enrollmentResolver = null
  enrollmentConfirming.value = false
  resolver(true)
}

async function unlockReading(): Promise<void> {
  const storage = offlineStorage.value
  if (!storage || readingBusy.value || readingState.value !== 'locked') return
  const entered = unlockSecret.value
  unlockSecret.value = ''
  readingBusy.value = true
  readingMessage.value = ''
  let secret: Uint8Array | null = null
  const controller = new AbortController()
  unlockController = controller
  try {
    secret = decodeOfflineReadingSecret(entered)
    await unlockOfflineReading(storage, secret, controller.signal)
    readingState.value = 'unlocked'
    readingMessage.value = 'Private offline reading is unlocked in this browser.'
  } catch {
    if (!controller.signal.aborted) {
      readingMessage.value = 'The private offline vault could not be unlocked.'
      await refreshReadingState()
    }
  } finally {
    secret?.fill(0)
    if (unlockController === controller) unlockController = null
    readingBusy.value = false
  }
}

function lockReading(): void {
  lockOfflineReading()
  unlockSecret.value = ''
  readingState.value = 'locked'
  readingMessage.value = 'Private offline reading is locked.'
}

async function openStorage(): Promise<void> {
  if (storageBusy.value) return
  storageBusy.value = true
  const token = ++storageOpenToken
  const previous = offlineStorage.value
  offlineStorage.value = null
  storageEstimate.value = null
  previous?.close()
  storageState.value = 'checking'
  storageMessage.value = 'Opening offline storage…'
  try {
    const opened = await openOfflineStorage()
    if (token !== storageOpenToken) {
      opened.close()
      return
    }
    offlineStorage.value = opened
    const storageAvailable = await refreshStorageStatus()
    if (token === storageOpenToken && offlineStorage.value === opened && storageAvailable) {
      storageMessage.value = 'Changes are saved automatically on this device.'
      libraryRefreshToken.value += 1
      await refreshReadingState()
    }
  } catch (error) {
    if (token !== storageOpenToken) return
    const failure = storageFailure(error)
    storageState.value = failure.state
    storageMessage.value = failure.message
  } finally {
    if (token === storageOpenToken) storageBusy.value = false
  }
}

async function requestPersistence(): Promise<void> {
  const storage = offlineStorage.value
  if (!storage || persistenceBusy.value) return
  persistenceBusy.value = true
  storageMessage.value = 'Requesting persistent storage…'
  try {
    const granted = await storage.requestPersistence()
    const storageAvailable = await refreshStorageStatus()
    if (storageAvailable) {
      storageMessage.value = granted
        ? 'Persistent storage is granted or was accepted by the browser.'
        : 'Persistent storage was not granted. The browser may still retain your saved pages.'
    }
  } catch (error) {
    const failure = storageFailure(error)
    storageState.value = failure.state
    storageMessage.value = failure.message
  } finally {
    persistenceBusy.value = false
  }
}
async function removeDownloadedPages(): Promise<void> {
  const storage = offlineStorage.value
  if (!storage || clearBusy.value) return
  clearBusy.value = true
  removeNotice.value = ''
  try {
    if (!browserAvailable) return
    const origin = window.location.origin
    const corpus = await storage.readSnapshotCorpus()
    const expectedSessionGeneration = corpus.sessionGeneration
    for (const record of corpus.snapshots) {
      if (record.siteId !== origin) continue
      const currentPolicy = await storage.readOfflinePolicy({ expectedSessionGeneration })
      await storage.removeOfflinePage(
        { siteId: record.siteId, pageId: record.pageId, locale: record.locale },
        {
          expectedSessionGeneration,
          expectedPolicyRevision: currentPolicy.state.policyRevision
        }
      )
    }
    const syncResult = offlineSyncService
      ? await offlineSyncService.reconcile('manual')
      : createOfflineSyncUnavailableResult('Synchronization will resume when the app reconnects.')
    if (syncResult.outcome === 'error') {
      removeNotice.value = syncResult.diagnostics?.lastError ?? 'Saved pages were removed, but local synchronization reported an error.'
    } else if (syncResult.outcome === 'unavailable') {
      removeNotice.value = `Saved pages were removed, but local synchronization is unavailable: ${syncResult.error}`
    } else if (syncResult.outcome === 'offline') {
      removeNotice.value = 'Saved pages were removed. Local synchronization will resume when the server is reachable.'
    } else {
      removeNotice.value = 'Saved pages were removed. Locked drafts and submission recovery were not changed.'
    }
    libraryRefreshToken.value += 1
    await refreshStorageStatus()
  } catch (error) {
    const failure = storageFailure(error)
    storageState.value = failure.state
    storageMessage.value = failure.message
    removeNotice.value = failure.message
  } finally {
    clearBusy.value = false
  }
}

async function beginClearDeviceData(event?: MouseEvent): Promise<void> {
  const storage = offlineStorage.value
  if (!storage || clearBusy.value || clearDialogOpen.value) return
  const trigger = event?.currentTarget
  clearRestoreTarget.value =
    trigger instanceof HTMLElement
      ? trigger
      : browserAvailable && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
  clearNotice.value = ''
  try {
    clearExpectedGeneration.value = await storage.currentSessionGeneration()
    clearDialogOpen.value = true
  } catch (error) {
    const failure = storageFailure(error)
    storageState.value = failure.state
    storageMessage.value = failure.message
    clearNotice.value = failure.message
    clearRestoreTarget.value = null
  }
}

function closeClearDialog(restoreFocus = true): void {
  const scope = clearFocusScope
  clearFocusScope = null
  scope?.deactivate({ restoreFocus })
  if (!scope && restoreFocus) {
    const target = clearRestoreTarget.value
    if (
      target?.isConnected &&
      !target.matches(':disabled') &&
      !target.closest('[inert], [aria-hidden="true"]')
    )
      target.focus({ preventScroll: true })
  }
  clearDialogOpen.value = false
  clearExpectedGeneration.value = null
  clearRestoreTarget.value = null
}

function cancelClearDeviceData(): void {
  if (clearBusy.value) return
  closeClearDialog()
}

async function confirmClearDeviceData(): Promise<void> {
  const storage = offlineStorage.value
  const expectedSessionGeneration = clearExpectedGeneration.value
  if (!storage || expectedSessionGeneration === null || clearBusy.value) return
  const restoreTarget = clearRestoreTarget.value
  // Keep reload blocked while moving from confirmation into the clear.
  // Vue applies the disabled button state after synchronous focus restoration.
  clearBusy.value = true
  closeClearDialog()
  clearNotice.value = 'Clearing saved pages, locked drafts, and submission recovery…'
  // Invalidate all local projections before the strict generation-fenced clear.
  lockOfflineReading()
  clearDeviceToken.value += 1
  try {
    await storage.clearDeviceData({ expectedSessionGeneration })
    libraryRefreshToken.value += 1
    await refreshStorageStatus()
    await refreshReadingState()
    clearNotice.value = 'Offline data was cleared on this device. Your server data was not deleted.'
  } catch (error) {
    const failure = storageFailure(error)
    storageState.value = failure.state
    storageMessage.value = failure.message
    clearNotice.value = failure.message
  } finally {
    clearBusy.value = false
    await nextTick()
    if (
      restoreTarget?.isConnected &&
      !restoreTarget.matches(':disabled') &&
      (document.activeElement === document.body || document.activeElement === document.documentElement)
    )
      restoreTarget.focus({ preventScroll: true })
  }
}
function handleLibraryChanged(): void {
  libraryNotice.value = ''
  void refreshStorageStatus()
}
function handleReadingStateEvent(): void {
  const handle = currentOfflineReadingHandle()
  if (!handle) {
    if (enrollmentConfirming.value) cancelEnrollment()
    unlockController?.abort()
  }
  void refreshReadingState()
}

watch(clearDialogOpen, async isOpen => {
  if (!isOpen) return
  await nextTick()
  if (!clearDialogOpen.value || !clearDialog.value) return
  clearFocusScope?.deactivate({ restoreFocus: false })
  clearFocusScope = createModalFocusScope({
    root: clearDialog.value,
    restoreTarget: () => clearRestoreTarget.value,
    onEscape: () => { if (!clearBusy.value) cancelClearDeviceData() }
  })
})

onMounted(() => {
  ownsReloadSafety = true
  setReloadSafetyProvider(() => ({
    safe: !reloadBlocked.value,
    revision: `offline-settings:${safetyRevision}`,
    actorEpoch: 'device-settings'
  }))
  unsubscribeStorageChanges = subscribeOfflineStorageChanges(() => {
    void refreshStorageStatus()
    void refreshReadingState()
  })
  window.addEventListener(OFFLINE_READING_STATE_EVENT, handleReadingStateEvent)
  window.addEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, handleReadingStateEvent)
  stopReadingStateEvents = () => {
    window.removeEventListener(OFFLINE_READING_STATE_EVENT, handleReadingStateEvent)
    window.removeEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, handleReadingStateEvent)
  }
  void openStorage()
})

onBeforeUnmount(() => {
  ownsReloadSafety = false
  setReloadSafetyProvider(null)
  storageOpenToken += 1
  cancelEnrollment()
  unlockController?.abort()
  unlockController = null
  unsubscribeStorageChanges?.()
  clearFocusScope?.deactivate({ restoreFocus: false })
  clearFocusScope = null
  clearRestoreTarget.value = null
  offlineStorage.value?.close()
  offlineStorage.value = null
})
</script>

<template>
  <v-container class="offline-settings" fluid>
    <header class="offline-settings__heading">
      <v-avatar size="56" color="primary" variant="tonal"><v-icon size="30">mdi-cloud-check-outline</v-icon></v-avatar>
      <div>
        <h1 class="text-headline-medium font-weight-bold">Offline access</h1>
        <p class="text-body-large text-medium-emphasis">Keep reading when your connection drops. These preferences apply to this browser and device.</p>
      </div>
    </header>
    <div class="offline-settings__layout">
      <v-card class="offline-settings__library" variant="flat">
        <OfflineLibrary
          :storage="offlineStorage"
          :storage-state="storageState"
          :storage-message="storageMessage"
          :refresh-token="libraryRefreshToken"
          :navigate-on-open="false"
          :show-settings="true"
          @changed="handleLibraryChanged"
          @busy="libraryBusy = $event"
          @error="libraryNotice = $event"
          @retry-storage="openStorage"
        />
        <p v-if="libraryNotice" class="offline-settings__notice" role="alert">{{ libraryNotice }}</p>
      </v-card>
      <aside class="offline-settings__utilities" aria-label="Device settings">
        <v-card class="offline-settings__reading" variant="flat">
          <div class="offline-settings__reading-heading">
            <h2 class="text-title-large">Private offline reading</h2>
            <v-chip size="small" :color="readingState === 'unlocked' ? 'success' : 'default'" variant="tonal">{{ readingStateLabel }}</v-chip>
          </div>
          <p>{{ readingStateDescription }}</p>
          <p v-if="readingMessage" class="offline-settings__notice" role="status">{{ readingMessage }}</p>
          <template v-if="readingState === 'setup-required' && !enrollmentConfirming">
            <p v-if="!verifiedAccount" class="text-medium-emphasis">Sign in and reconnect once to enable private offline reading. Public saved pages remain available.</p>
            <div class="offline-settings__actions">
              <v-btn variant="tonal" color="primary" :disabled="!verifiedAccount || readingBusy" :loading="readingBusy" @click="beginEnrollment">
                Set up private reading
              </v-btn>
            </div>
          </template>
          <template v-else-if="readingState === 'locked'">
            <v-text-field
              v-model="unlockSecret"
              class="offline-settings__secret-field"
              label="Unlock secret"
              type="password"
              autocomplete="off"
              spellcheck="false"
              :disabled="readingBusy"
              @keyup.enter="unlockReading"
            />
            <div class="offline-settings__actions">
              <v-btn variant="tonal" color="primary" :disabled="readingBusy || !unlockSecret" :loading="readingBusy" @click="unlockReading">Unlock private pages</v-btn>
            </div>
          </template>
          <template v-else-if="readingState === 'unlocked'">
            <p class="text-medium-emphasis">Private pages stay in encrypted local storage and are not sent in URLs or logs.</p>
            <div class="offline-settings__actions">
              <v-btn variant="outlined" :disabled="readingBusy" @click="lockReading">Lock private pages</v-btn>
            </div>
          </template>
          <template v-if="enrollmentConfirming">
            <v-alert type="warning" variant="tonal" role="alert">
              Save this secret somewhere safe. It is shown once and cannot be recovered.
              <code class="offline-settings__secret">{{ enrollmentSecret }}</code>
            </v-alert>
            <v-text-field
              v-model="enrollmentConfirmation"
              label="Re-enter secret exactly"
              autocomplete="off"
              spellcheck="false"
              :disabled="!readingBusy"
              @keyup.enter="confirmEnrollment"
            />
            <div class="offline-settings__actions">
              <v-btn variant="tonal" color="primary" :disabled="!enrollmentConfirmation || !readingBusy" @click="confirmEnrollment">Confirm and save</v-btn>
              <v-btn variant="text" :disabled="!readingBusy" @click="cancelEnrollment">Cancel</v-btn>
            </div>
          </template>
          <p v-if="enrollmentNotice" class="offline-settings__notice" role="status">{{ enrollmentNotice }}</p>
        </v-card>
        <PwaStatus :show-links="false" />
        <v-card class="offline-settings__storage" variant="flat">
          <h2 class="text-title-large">Device storage</h2>
          <p>{{ storageDetail }}</p>
          <p v-if="storageEstimate?.persisted !== null && storageEstimate?.persisted !== undefined" class="text-medium-emphasis">
            {{ storageEstimate.persisted ? 'Persistent storage is enabled.' : 'Persistent storage has not been granted by your browser.' }}
          </p>
          <div class="offline-settings__actions">
            <v-btn variant="outlined" :loading="storageBusy" :disabled="clearBusy || persistenceBusy" @click="openStorage">Refresh storage</v-btn>
            <v-btn variant="tonal" :disabled="!offlineStorage || clearBusy" :loading="persistenceBusy" @click="requestPersistence">Keep storage on this device</v-btn>
          </div>
          <p v-if="storageMessage && storageState === 'available' && !storageBusy" class="text-medium-emphasis" role="status">{{ storageMessage }}</p>
          <v-divider class="my-4" />
          <h3 class="text-title-medium">Remove local data</h3>
          <p>Removing saved pages leaves your local drafts and submission recovery intact. Server data is unchanged.</p>
          <div class="offline-settings__actions">
            <v-btn variant="text" :disabled="!offlineStorage || clearBusy || persistenceBusy || storageEstimate?.snapshotCount === 0" @click="removeDownloadedPages">Remove saved pages</v-btn>
            <v-btn color="error" variant="text" :disabled="!offlineStorage || clearBusy || persistenceBusy" @click="beginClearDeviceData">Clear offline data on this device</v-btn>
          </div>
          <p v-if="removeNotice" class="offline-settings__notice" role="status">{{ removeNotice }}</p>
          <p v-if="clearNotice" class="offline-settings__notice" role="status">{{ clearNotice }}</p>
          <p v-if="storageEstimate?.lockedDraftCount" class="text-medium-emphasis">{{ storageEstimate.lockedDraftCount }} local draft{{ storageEstimate.lockedDraftCount === 1 ? '' : 's' }} protected. Reconnect with the same account to access them.</p>
        </v-card>
      </aside>
    </div>
    <div v-if="clearDialogOpen" class="offline-settings__backdrop" role="presentation" @keydown.esc.prevent="cancelClearDeviceData">
      <section ref="clearDialog" class="offline-settings__dialog" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="clear-device-title" aria-describedby="clear-device-description">
        <h2 id="clear-device-title" class="text-title-large">Clear offline data on this device?</h2>
        <p id="clear-device-description">This removes saved pages, local drafts, and unresolved submission recovery from this browser. It does not delete anything from the server.</p>
        <div class="offline-settings__actions">
          <v-btn variant="outlined" :disabled="clearBusy" @click="cancelClearDeviceData">Cancel</v-btn>
          <v-btn color="error" variant="flat" :disabled="clearBusy" @click="confirmClearDeviceData">Clear offline data</v-btn>
        </div>
      </section>
    </div>
  </v-container>
</template>

<style scoped lang="scss">
.offline-settings {
  --offline-paper: var(--wiki-surface);
  --offline-paper-raised: var(--wiki-surface-raised);
  --offline-paper-sunken: var(--wiki-surface-sunken);
  --offline-ink: rgb(var(--v-theme-on-surface));
  --offline-muted: rgba(var(--v-theme-on-surface), .72);
  --offline-faint: rgba(var(--v-theme-on-surface), .65);
  --offline-accent: rgb(var(--v-theme-primary));
  --offline-accent-strong: rgb(var(--v-theme-primary));
  --offline-warm: rgb(var(--v-theme-warning));
  --offline-border: var(--wiki-surface-border);
  --offline-border-strong: var(--wiki-surface-border);
  --offline-focus: rgb(var(--v-theme-primary));
  --offline-mono: var(--wiki-font-mono, ui-monospace, monospace);
  --offline-body: var(--wiki-font-body);
  --offline-heading: var(--wiki-font-body);
  max-width: 1500px;
  padding: clamp(1rem, 3vw, 2rem);
  color: rgb(var(--v-theme-on-surface));
}
.offline-settings__heading { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
.offline-settings__heading p { margin: .4rem 0 0; max-width: 70ch; }
.offline-settings__layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); gap: 1.5rem; align-items: start; }
.offline-settings__library, .offline-settings__storage, .offline-settings__reading { min-width: 0; padding: 1.25rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); }
.offline-settings__reading-heading { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
.offline-settings__reading-heading h2 { margin: 0; }
.offline-settings__secret { display: block; margin-top: .75rem; padding: .75rem; overflow-wrap: anywhere; user-select: all; font-family: var(--offline-mono); font-size: .9rem; letter-spacing: .04em; }
.offline-settings__utilities { display: grid; gap: 1.25rem; min-width: 0; }
.offline-settings__storage p, .offline-settings__dialog p { margin: .75rem 0; line-height: 1.6; overflow-wrap: anywhere; }
.offline-settings__actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
.offline-settings__actions :deep(.v-btn) { height: auto; min-height: 40px; padding-block: .65rem; }
.offline-settings__actions :deep(.v-btn__content) { white-space: normal; }
.offline-settings__notice { margin-top: 1rem; font-size: .875rem; }
.offline-settings__backdrop { position: fixed; inset: 0; z-index: 2500; display: grid; place-items: center; padding: 1rem; background: rgba(0, 0, 0, .5); }
.offline-settings__dialog { width: min(100%, 520px); padding: 1.5rem; border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); box-shadow: var(--wiki-shadow-md); max-height: calc(100dvh - 2rem); overflow: auto; }
@media (max-width: 1100px) { .offline-settings__layout { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 600px) { .offline-settings__heading { align-items: flex-start; } .offline-settings__heading :deep(.v-avatar) { display: none; } }
</style>
