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
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

type StorageState = 'uninspected' | 'checking' | 'available' | 'unavailable' | 'unsupported-schema' | 'blocked-upgrade' | 'quota'
const browserAvailable = typeof window !== 'undefined' && typeof navigator !== 'undefined'
const settingsRoot = ref<HTMLElement | { $el?: HTMLElement } | null>(null)
const offlineSyncService = inject<OfflineSyncService>(OFFLINE_SYNC_COORDINATOR_KEY)
const offlineStorage = shallowRef<OfflineStorage | null>(null)
const storageEstimate = shallowRef<OfflineStorageEstimate | null>(null)
const storageState = ref<StorageState>('uninspected')
const storageMessage = ref(t('common:offlineSettings.offlineStorageHasNot'))
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
  'setup-required': t('common:offlineSettings.notSetUp'),
  locked: t('common:offlineSettings.locked'),
  unlocked: t('common:offlineSettings.unlocked'),
  unavailable: t('common:offlineSettings.unavailable')
}[readingState.value]))
const readingStateDescription = computed(() => ({
  'setup-required': t('common:offlineSettings.enablePrivateOfflineReading'),
  locked: t('common:offlineSettings.privateVaultSavedDevice'),
  unlocked: t('common:offlineSettings.privateOfflinePagesAvailable'),
  unavailable: t('common:offlineSettings.privateOfflineReadingUnavailable')
}[readingState.value]))
const removalNeedsUnlock = computed(() => readingState.value === 'locked' || readingState.value === 'unavailable')
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
    ? ` ${t('common:offlineSettings.browserStorage', { usageBytes: formatBytes(estimate.usageBytes), quotaBytes: formatBytes(estimate.quotaBytes), interpolation: { escapeValue: false } })}` : ''
  return t('common:offlineSettings.savedPageUsing', { count: estimate.snapshotCount, managedBytes: formatBytes(estimate.managedBytes), capacity, interpolation: { escapeValue: false } })
})

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return t('common:offlineSettings.unknownSize')
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
    return { state: 'unsupported-schema', message: t('common:offlineSettings.savedDataNeedsNewer') }
  if (code === 'blocked-upgrade')
    return { state: 'blocked-upgrade', message: t('common:offlineSettings.anotherTabHoldingOffline') }
  if (code === 'quota') return { state: 'quota', message: t('common:offlineSettings.browserDeclinedLocalStorage') }
  return {
    state: 'unavailable',
    message: error instanceof Error && error.message.trim() ? error.message : t('common:offlineSettings.browserCouldNotOpen')
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
    readingMessage.value = t('common:offlineSettings.privateOfflineReadingUnavailable2')
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
    enrollmentNotice.value = t('common:offlineSettings.privateOfflineReadingEnabled')
    readingState.value = 'unlocked'
  } catch {
    if (!controller.signal.aborted) enrollmentNotice.value = t('common:offlineSettings.privateOfflineReadingCould')
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
    enrollmentNotice.value = t('common:offlineSettings.confirmationCouldNotAccepted')
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
    readingMessage.value = t('common:offlineSettings.privateOfflineReadingUnlocked')
  } catch {
    if (!controller.signal.aborted) {
      readingMessage.value = t('common:offlineSettings.privateOfflineVaultCould')
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
  readingMessage.value = t('common:offlineSettings.privateOfflineReadingLocked')
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
  storageMessage.value = t('common:offlineSettings.openingOfflineStorage')
  try {
    const opened = await openOfflineStorage()
    if (token !== storageOpenToken) {
      opened.close()
      return
    }
    offlineStorage.value = opened
    const storageAvailable = await refreshStorageStatus()
    if (token === storageOpenToken && offlineStorage.value === opened && storageAvailable) {
      storageMessage.value = t('common:offlineSettings.changesSavedAutomaticallyDevice')
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
  storageMessage.value = t('common:offlineSettings.requestingPersistentStorage')
  try {
    const granted = await storage.requestPersistence()
    const storageAvailable = await refreshStorageStatus()
    if (storageAvailable) {
      storageMessage.value = granted
        ? t('common:offlineSettings.persistentStorageGrantedWas')
        : t('common:offlineSettings.persistentStorageWasNot')
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
  if (!storage || clearBusy.value || readingBusy.value) return
  clearBusy.value = true
  removeNotice.value = ''
  try {
    if (!browserAvailable) return
    const origin = window.location.origin
    const handle = currentOfflineReadingHandle()
    const vault = await storage.getReadingVault()
    if (vault && (!handle || !isCurrentOfflineReadingHandle(handle) || handle.context.canonicalOrigin !== origin)) {
      removeNotice.value = t('common:offlineSettings.unlockBeforeRemovingPages', { defaultValue: 'Unlock private reading before removing saved pages.' })
      await refreshReadingState()
      return
    }
    const corpus = await storage.readSnapshotCorpus()
    const expectedSessionGeneration = corpus.sessionGeneration
    const currentRemoval = (): void => {
      if (offlineStorage.value !== storage || currentOfflineReadingHandle() !== handle ||
        (handle && (!isCurrentOfflineReadingHandle(handle) || handle.sessionGeneration !== expectedSessionGeneration)))
        throw new OfflineStorageError('generation-fenced', t('common:offlineLibrary.savedPagesChangedDevice'))
    }
    currentRemoval()
    const privateCorpus = handle
      ? await storage.readSnapshotCorpus({ readingHandle: handle, expectedSessionGeneration })
      : null
    currentRemoval()
    const scopes = [
      { records: corpus.snapshots, siteId: origin, readingHandle: undefined },
      ...(handle && privateCorpus ? [{ records: privateCorpus.snapshots, siteId: handle.context.siteId, readingHandle: handle }] : [])
    ]
    for (const scope of scopes) {
      const removedPages = new Set<number>()
      for (const record of scope.records) {
        if (record.siteId !== scope.siteId || removedPages.has(record.pageId)) continue
        currentRemoval()
        const options = { expectedSessionGeneration, ...(scope.readingHandle ? { readingHandle: scope.readingHandle } : {}) }
        const currentPolicy = await storage.readOfflinePolicy(options)
        currentRemoval()
        await storage.removeOfflinePage(
          { siteId: record.siteId, pageId: record.pageId, locale: record.locale },
          { ...options, expectedPolicyRevision: currentPolicy.state.policyRevision }
        )
        removedPages.add(record.pageId)
      }
    }
    currentRemoval()
    for (const scope of scopes) {
      const remaining = await storage.readSnapshotCorpus({
        expectedSessionGeneration,
        ...(scope.readingHandle ? { readingHandle: scope.readingHandle } : {})
      })
      currentRemoval()
      if (remaining.snapshots.some(record => record.siteId === scope.siteId))
        throw new OfflineStorageError('transaction', t('common:offlineSettings.savedPagesRemain', { defaultValue: 'Some saved pages remain. Refresh the library before trying again.' }))
    }
    const completion = handle
      ? t('common:offlineSettings.savedPagesRemovedScope', { defaultValue: 'Public saved pages for this site and saved pages in the unlocked private vault were removed.' })
      : t('common:offlineSettings.publicSavedPagesRemoved', { defaultValue: 'Public saved pages for this site were removed.' })
    const syncResult = offlineSyncService
      ? await offlineSyncService.reconcile('manual')
      : createOfflineSyncUnavailableResult(t('common:offlineSettings.synchronizationWillResumeWhen'))
    currentRemoval()
    if (syncResult.outcome === 'error') {
      removeNotice.value = `${completion} ${syncResult.diagnostics?.lastError ?? ''}`.trim()
    } else if (syncResult.outcome === 'unavailable') {
      removeNotice.value = `${completion} ${t('common:offlineSettings.removalSyncUnavailable', { defaultValue: 'Synchronization will resume when available: {{error}}', error: syncResult.error, interpolation: { escapeValue: false } })}`
    } else if (syncResult.outcome === 'offline') {
      removeNotice.value = `${completion} ${t('common:offlineSettings.removalSyncOffline', { defaultValue: 'Synchronization will resume when you are online.' })}`
    } else {
      removeNotice.value = completion
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
  clearNotice.value = t('common:offlineSettings.clearingSavedPagesLocked')
  // Invalidate all local projections before the strict generation-fenced clear.
  lockOfflineReading()
  clearDeviceToken.value += 1
  try {
    await storage.clearDeviceData({ expectedSessionGeneration })
    libraryRefreshToken.value += 1
    await refreshStorageStatus()
    await refreshReadingState()
    clearNotice.value = t('common:offlineSettings.offlineDataWasCleared')
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

async function focusSettingsFragment(): Promise<void> {
  if (!browserAvailable) return
  await nextTick()
  const root = settingsRoot.value instanceof HTMLElement ? settingsRoot.value : settingsRoot.value?.$el
  if (!root || !window.location.hash) return
  let id: string
  try {
    id = decodeURIComponent(window.location.hash.slice(1))
  } catch {
    return
  }
  const target = document.getElementById(id)
  if (!target || !root.contains(target) || target.closest('[hidden], [inert]')) return
  for (let ancestor = target.parentElement; ancestor && root.contains(ancestor); ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
  }
  target.setAttribute('tabindex', '-1')
  target.scrollIntoView({ block: 'start' })
  target.focus({ preventScroll: true })
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
  window.addEventListener('hashchange', focusSettingsFragment)
  void focusSettingsFragment()
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
  window.removeEventListener('hashchange', focusSettingsFragment)
  clearFocusScope?.deactivate({ restoreFocus: false })
  clearFocusScope = null
  clearRestoreTarget.value = null
  offlineStorage.value?.close()
  offlineStorage.value = null
})
</script>

<template>
  <v-container ref="settingsRoot" class="offline-settings" fluid>
    <header class="offline-settings__heading">
      <v-avatar size="56" color="primary" variant="tonal"><v-icon size="30">mdi-cloud-check-outline</v-icon></v-avatar>
      <div>
        <h1 class="text-headline-medium font-weight-bold">{{ $t('common:offlineSettings.offlineAccess') }}</h1>
        <p class="text-body-large text-medium-emphasis">{{ $t('common:offlineSettings.keepReadingWhenConnection') }}</p>
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
      <aside class="offline-settings__utilities" :aria-label="$t('common:offlineSettings.deviceSettings')">
        <v-card class="offline-settings__reading" variant="flat">
          <div class="offline-settings__reading-heading">
            <h2 id="offline-private-reading-title" class="text-title-large" tabindex="-1">{{ $t('common:offlineSettings.privateOfflineReading') }}</h2>
            <v-chip size="small" :color="readingState === 'unlocked' ? 'success' : 'default'" variant="tonal">{{ readingStateLabel }}</v-chip>
          </div>
          <p>{{ readingStateDescription }}</p>
          <p v-if="readingMessage" class="offline-settings__notice" role="status">{{ readingMessage }}</p>
          <template v-if="readingState === 'setup-required' && !enrollmentConfirming">
            <p v-if="!verifiedAccount" class="text-medium-emphasis">{{ $t('common:offlineSettings.signReconnectOnceEnable') }}</p>
            <div class="offline-settings__actions">
              <v-btn variant="tonal" color="primary" :disabled="!verifiedAccount || readingBusy" :loading="readingBusy" @click="beginEnrollment">
                {{ $t('common:offlineSettings.setUpPrivateReading') }}
              </v-btn>
            </div>
          </template>
          <template v-else-if="readingState === 'locked'">
            <v-text-field
              v-model="unlockSecret"
              class="offline-settings__secret-field"
              :label="$t('common:offlineSettings.unlockSecret')"
              type="password"
              autocomplete="off"
              spellcheck="false"
              :disabled="readingBusy"
              @keyup.enter="unlockReading"
            />
            <div class="offline-settings__actions">
              <v-btn variant="tonal" color="primary" :disabled="readingBusy || !unlockSecret" :loading="readingBusy" @click="unlockReading">{{ $t('common:offlineSettings.unlockPrivatePages') }}</v-btn>
            </div>
          </template>
          <template v-else-if="readingState === 'unlocked'">
            <p class="text-medium-emphasis">{{ $t('common:offlineSettings.privatePagesStayEncrypted') }}</p>
            <div class="offline-settings__actions">
              <v-btn variant="outlined" :disabled="readingBusy" @click="lockReading">{{ $t('common:offlineSettings.lockPrivatePages') }}</v-btn>
            </div>
          </template>
          <template v-if="enrollmentConfirming">
            <v-alert type="warning" variant="tonal" role="alert">
              {{ $t('common:offlineSettings.saveSecretSomewhereSafe') }}
              <code class="offline-settings__secret">{{ enrollmentSecret }}</code>
            </v-alert>
            <v-text-field
              v-model="enrollmentConfirmation"
              :label="$t('common:offlineSettings.reEnterSecretExactly')"
              autocomplete="off"
              spellcheck="false"
              :disabled="!readingBusy"
              @keyup.enter="confirmEnrollment"
            />
            <div class="offline-settings__actions">
              <v-btn variant="tonal" color="primary" :disabled="!enrollmentConfirmation || !readingBusy" @click="confirmEnrollment">{{ $t('common:offlineSettings.confirmSave') }}</v-btn>
              <v-btn variant="text" :disabled="!readingBusy" @click="cancelEnrollment">{{ $t('common:actions.cancel') }}</v-btn>
            </div>
          </template>
          <p v-if="enrollmentNotice" class="offline-settings__notice" role="status">{{ enrollmentNotice }}</p>
        </v-card>
        <PwaStatus :show-links="false" />
        <v-card class="offline-settings__storage" variant="flat">
          <h2 class="text-title-large">{{ $t('common:offlineSettings.deviceStorage') }}</h2>
          <p>{{ storageDetail }}</p>
          <p v-if="storageEstimate?.persisted !== null && storageEstimate?.persisted !== undefined" class="text-medium-emphasis">
            {{ storageEstimate.persisted ? $t('common:offlineSettings.persistentStorageEnabled') : $t('common:offlineSettings.persistentStorageHasNot') }}
          </p>
          <div class="offline-settings__actions">
            <v-btn variant="outlined" :loading="storageBusy" :disabled="clearBusy || persistenceBusy" @click="openStorage">{{ $t('common:offlineSettings.refreshStorage') }}</v-btn>
            <v-btn variant="tonal" :disabled="!offlineStorage || clearBusy" :loading="persistenceBusy" @click="requestPersistence">{{ $t('common:offlineSettings.keepStorageDevice') }}</v-btn>
          </div>
          <p v-if="storageMessage && storageState === 'available' && !storageBusy" class="text-medium-emphasis" role="status">{{ storageMessage }}</p>
          <v-divider class="my-4" />
          <h3 class="text-title-medium">{{ $t('common:offlineSettings.removeLocalData') }}</h3>
          <p>{{ $t('common:offlineSettings.removingSavedPagesLeaves') }}</p>
          <p>{{ $t('common:offlineSettings.removalScope', { defaultValue: 'Removes public saved pages for this site and pages in the currently unlocked private vault. Other vaults and sites are unchanged.' }) }}</p>
          <p v-if="removalNeedsUnlock"><a href="#offline-private-reading-title">{{ $t('common:offlineSettings.unlockBeforeRemovingPages', { defaultValue: 'Unlock private reading before removing saved pages.' }) }}</a></p>
          <div class="offline-settings__actions">
            <v-btn variant="text" :disabled="!offlineStorage || clearBusy || readingBusy || removalNeedsUnlock || persistenceBusy || storageEstimate?.snapshotCount === 0" @click="removeDownloadedPages">{{ $t('common:offlineSettings.removeSavedPages') }}</v-btn>
            <v-btn color="error" variant="text" :disabled="!offlineStorage || clearBusy || persistenceBusy" @click="beginClearDeviceData">{{ $t('common:offlineSettings.clearOfflineDataDevice') }}</v-btn>
          </div>
          <p v-if="removeNotice" class="offline-settings__notice" role="status">{{ removeNotice }}</p>
          <p v-if="clearNotice" class="offline-settings__notice" role="status">{{ clearNotice }}</p>
          <p v-if="storageEstimate?.lockedDraftCount" class="text-medium-emphasis">{{ $t('common:offlineSettings.localDraftProtectedReconnect', { count: storageEstimate.lockedDraftCount, interpolation: { escapeValue: false } }) }}</p>
        </v-card>
      </aside>
    </div>
    <div v-if="clearDialogOpen" class="offline-settings__backdrop" role="presentation" @keydown.esc.prevent="cancelClearDeviceData">
      <section ref="clearDialog" class="offline-settings__dialog" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="clear-device-title" aria-describedby="clear-device-description">
        <h2 id="clear-device-title" class="text-title-large">{{ $t('common:offlineSettings.clearOfflineDataDevice2') }}</h2>
        <p id="clear-device-description">{{ $t('common:offlineSettings.removesSavedPagesLocal') }}</p>
        <div class="offline-settings__actions">
          <v-btn variant="outlined" :disabled="clearBusy" @click="cancelClearDeviceData">{{ $t('common:actions.cancel') }}</v-btn>
          <v-btn color="error" variant="flat" :disabled="clearBusy" @click="confirmClearDeviceData">{{ $t('common:offlineSettings.clearOfflineData') }}</v-btn>
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
