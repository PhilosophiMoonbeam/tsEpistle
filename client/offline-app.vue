<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import OfflineLibrary from './components/pwa/offline-library.vue'
import {
  OfflineStorageError,
  openOfflineStorage,
  type OfflineStorage
} from './helpers/offline-storage.ts'
import type { OfflineStorageEstimate } from '../shared/offline.ts'
import {
  promptPwaInstall,
  pwaState,
  requestPwaUpdate,
  retryServerConnection
} from './helpers/pwa.ts'
import { createModalFocusScope, type ModalFocusScope } from './components/common/modal-focus-scope.ts'

type StorageState = 'uninspected' | 'checking' | 'available' | 'unavailable' | 'unsupported-schema' | 'blocked-upgrade' | 'quota'
const browserAvailable = typeof window !== 'undefined' && typeof navigator !== 'undefined'
type OfflinePageSelector = {
  readonly siteId: string
  readonly pageId: number
  readonly locale: string
}

type OfflineSelectorParse = {
  readonly selector: OfflinePageSelector | null
  readonly error: string
}

const OFFLINE_DOCUMENT_PATH = '/_offline'
const OFFLINE_LOCALE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,34}$/u

const parseOfflineSelector = (): OfflineSelectorParse => {
  if (!browserAvailable || window.location.pathname !== OFFLINE_DOCUMENT_PATH) return { selector: null, error: '' }
  const url = new URL(window.location.href)
  const entries = [...url.searchParams.entries()]
  if (entries.length === 0 && !url.hash) return { selector: null, error: '' }
  if (url.hash || entries.length !== 3 || entries.some(([key]) => !['site', 'pageId', 'locale'].includes(key)))
    return { selector: null, error: 'This local page link is invalid or incomplete.' }
  const siteValues = url.searchParams.getAll('site')
  const pageIdValues = url.searchParams.getAll('pageId')
  const localeValues = url.searchParams.getAll('locale')
  if (siteValues.length !== 1 || pageIdValues.length !== 1 || localeValues.length !== 1)
    return { selector: null, error: 'This local page link is invalid or incomplete.' }
  const siteId = siteValues[0]
  const pageIdText = pageIdValues[0]
  const locale = localeValues[0]
  if (
    siteId !== window.location.origin ||
    !/^[1-9]\d*$/u.test(pageIdText) ||
    !Number.isSafeInteger(Number(pageIdText)) ||
    Number(pageIdText) < 1 ||
    !OFFLINE_LOCALE_PATTERN.test(locale)
  )
    return { selector: null, error: 'This local page link is invalid or belongs to another site.' }
  return { selector: { siteId, pageId: Number(pageIdText), locale }, error: '' }
}

const parsedOfflineSelector = parseOfflineSelector()
const offlineSelector = parsedOfflineSelector.selector

const offlineStorage = shallowRef<OfflineStorage | null>(null)
const storageEstimate = shallowRef<OfflineStorageEstimate | null>(null)
const storageState = ref<StorageState>('uninspected')
const storageMessage = ref('Local storage has not been checked yet.')
const storageBusy = ref(false)
const persistenceBusy = ref(false)
const clearBusy = ref(false)
const clearDialogOpen = ref(false)
const clearDialog = ref<HTMLElement | null>(null)
const clearExpectedGeneration = ref<number | null>(null)
const clearRestoreTarget = shallowRef<HTMLElement | null>(null)
const clearDeviceToken = ref(0)
let clearFocusScope: ModalFocusScope | null = null
const removeNotice = ref('')
const clearNotice = ref('')
const isRetrying = ref(false)
const isInstalling = ref(false)
const isUpdating = ref(false)
const libraryRefreshToken = ref(0)
const libraryNotice = ref(parsedOfflineSelector.error)
let storageOpenToken = 0

const connectionLabel = computed(() => {
  const labels: Record<string, string> = {
    checking: 'Checking the server',
    online: 'Server reachable',
    offline: 'Waiting for a connection',
    'server-unavailable': 'Server unavailable'
  }
  return labels[pwaState.connectionState] ?? 'Connection status unknown'
})

const connectionMessage = computed(() => {
  if (pwaState.connectionState === 'checking') return 'Checking the server without opening an account session.'
  if (pwaState.connectionState === 'online' && pwaState.serverReachable === true)
    return 'The server answered a neutral probe. This does not sign you in or change local page scope.'
  if (pwaState.connectionState === 'offline') return 'The browser reports no network path. Downloaded guest pages remain available on this device.'
  if (pwaState.onlineHint) return 'The browser hint is positive, but a server request has not succeeded.'
  return 'The server could not be reached. Local guest snapshots remain bounded and read-only.'
})

const storageDetail = computed(() => {
  if (storageState.value === 'checking') return 'Opening the versioned local notebook…'
  if (storageState.value !== 'available') return storageMessage.value
  const estimate = storageEstimate.value
  if (!estimate) return storageMessage.value
  const browserPart =
    estimate.usageBytes === null || estimate.quotaBytes === null
      ? 'The browser did not provide a complete capacity estimate.'
      : `${formatBytes(estimate.usageBytes)} used of an estimated ${formatBytes(estimate.quotaBytes)}.`
  return `${browserPart} This notebook manages ${formatBytes(estimate.managedBytes)} across ${estimate.snapshotCount} downloaded page${estimate.snapshotCount === 1 ? '' : 's'}.`
})

const lockedDraftDetail = computed(() => {
  const count = storageEstimate.value?.lockedDraftCount
  if (count === undefined) return 'The count is unavailable until local storage opens.'
  if (count === 0) return 'No opaque account-owned draft envelopes are currently counted.'
  return `${count} opaque account-owned draft envelope${count === 1 ? '' : 's'} is present. Titles, routes, and source text stay hidden until the same account is verified online.`
})

const installDetail = computed(() => {
  if (pwaState.isStandalone || pwaState.installed || pwaState.installAvailability === 'installed') return 'This app is already running in an installed window.'
  if (pwaState.installPromptAvailable) return 'Your browser exposed an optional install action. It is safe to dismiss it and continue in the browser.'
  if (browserAvailable && /iPad|iPhone|iPod/u.test(navigator.userAgent)) return 'On iPhone or iPad, use Share, then Add to Home Screen. Availability varies by browser.'
  return 'Use your browser’s install or add-to-home-screen menu when it offers one. No prompt is promised.'
})

const installMessage = computed(() => {
  if (pwaState.installError) return pwaState.installError
  if (pwaState.installed || pwaState.isStandalone) return 'Installation is active for this browser window.'
  return 'Installation is optional and depends on browser capability.'
})

const updateMessage = computed(() => {
  if (pwaState.updateError) return pwaState.updateError
  if (pwaState.updateReady || pwaState.reloadNeeded) return 'A newer neutral shell is ready. Reload is requested only after this client reports that it is safe.'
  if (pwaState.offlineReady) return 'The neutral shell and its explicit build assets are ready for offline navigation.'
  return 'The offline shell is checking for an update when the browser exposes one.'
})

const pwaError = computed(() => pwaState.error ?? '')

const hasUpdateNotice = computed(() => Boolean(pwaState.updateReady || pwaState.reloadNeeded || pwaState.updateError))

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
    return { state: 'unsupported-schema', message: 'A newer offline database schema is present. It is preserved, but this build will not write or render records from it.' }
  if (code === 'blocked-upgrade')
    return { state: 'blocked-upgrade', message: 'Another tab is holding the offline database open. Close that tab or retry the local notebook.' }
  if (code === 'quota') return { state: 'quota', message: 'The browser declined local storage because its quota is full. No records were evicted silently.' }
  return {
    state: 'unavailable',
    message: error instanceof Error && error.message.trim() ? error.message : 'This browser could not open the local offline notebook. Downloaded pages remain on the server.'
  }
}

async function refreshStorageStatus(): Promise<void> {
  const storage = offlineStorage.value
  if (!storage) return
  try {
    storageEstimate.value = await storage.storageStatus()
    storageState.value = 'available'
  } catch (error) {
    const failure = storageFailure(error)
    storageState.value = failure.state
    storageMessage.value = failure.message
    storageEstimate.value = null
    if (failure.state === 'unsupported-schema' || failure.state === 'blocked-upgrade') {
      storage.close()
      offlineStorage.value = null
    }
  }
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
  storageMessage.value = 'Opening the versioned local notebook without an account session.'
  try {
    const opened = await openOfflineStorage()
    if (token !== storageOpenToken) {
      opened.close()
      return
    }
    offlineStorage.value = opened
    await refreshStorageStatus()
    if (offlineStorage.value) libraryRefreshToken.value += 1
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
  storageMessage.value = 'Asking the browser for durable storage; denial is normal degradation.'
  try {
    const granted = await storage.requestPersistence()
    await refreshStorageStatus()
    if (storageState.value === 'available') {
      storageMessage.value = granted
        ? 'Persistent storage is granted or was accepted by the browser.'
        : 'Persistent storage was not granted. The browser may still retain this bounded notebook.'
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
      await storage.removeSnapshot(record.siteId, record.pageId, record.locale, { expectedSessionGeneration })
    }
    libraryRefreshToken.value += 1
    await refreshStorageStatus()
    removeNotice.value = 'Saved pages were removed. Locked drafts and submission recovery were not changed.'
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
  // Restore the trigger before marking the action busy; the button is disabled
  // while the strict clear runs and must not swallow logical focus.
  closeClearDialog()
  clearBusy.value = true
  clearNotice.value = 'Clearing saved pages, locked drafts, and submission recovery…'
  // Invalidate all local projections before the strict generation-fenced clear.
  clearDeviceToken.value += 1
  try {
    const nextGeneration = await storage.clearDeviceData({ expectedSessionGeneration })
    libraryRefreshToken.value += 1
    await refreshStorageStatus()
    clearNotice.value = `Offline data was cleared on this device. Local generation ${nextGeneration} is active; server data was not deleted.`
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

async function retryConnection(): Promise<void> {
  if (isRetrying.value) return
  isRetrying.value = true
  try {
    await retryServerConnection()
  } finally {
    isRetrying.value = false
  }
}

async function installApplication(): Promise<void> {
  if (isInstalling.value || !pwaState.installPromptAvailable) return
  isInstalling.value = true
  try {
    await promptPwaInstall()
  } finally {
    isInstalling.value = false
  }
}

async function acceptUpdate(): Promise<void> {
  if (isUpdating.value) return
  isUpdating.value = true
  try {
    await requestPwaUpdate()
  } finally {
    isUpdating.value = false
  }
}

function handleLibraryError(message: string): void {
  libraryNotice.value = message
}

function handleLibraryChanged(): void {
  libraryNotice.value = ''
  void refreshStorageStatus()
}

watch(clearDialogOpen, async isOpen => {
  if (!isOpen) {
    await nextTick()
    if (clearDialogOpen.value) return
    clearFocusScope?.deactivate({ restoreFocus: true })
    clearFocusScope = null
    clearRestoreTarget.value = null
    return
  }
  await nextTick()
  if (!clearDialogOpen.value) return
  const root = clearDialog.value
  if (!root) return
  clearFocusScope?.deactivate({ restoreFocus: false })
  clearFocusScope = createModalFocusScope({
    root,
    restoreTarget: () => clearRestoreTarget.value,
    onEscape: () => {
      if (!clearBusy.value) cancelClearDeviceData()
    }
  })
})

onMounted(() => {
  void openStorage()
})

onBeforeUnmount(() => {
  storageOpenToken += 1
  clearFocusScope?.deactivate({ restoreFocus: false })
  clearFocusScope = null
  clearRestoreTarget.value = null
  offlineStorage.value?.close()
  offlineStorage.value = null
})
</script>

<template>
  <main class="offline-shell" aria-labelledby="offline-title">
    <header class="notebook-header">
      <a class="wordmark" href="/" aria-label="tsEpistle home">
        <span class="brand-mark" aria-hidden="true"><span></span></span>
        <span>tsEpistle</span>
      </a>
      <p class="eyebrow">FIELD NOTE <span aria-hidden="true">/</span> LOCAL RECOVERY</p>
      <div class="connection-status" :data-state="pwaState.connectionState" role="status" aria-live="polite">
        <span class="status-dot" aria-hidden="true"></span>
        <span>{{ connectionLabel }}</span>
      </div>
    </header>

    <section class="intro" aria-describedby="offline-description">
      <div class="intro-copy-block">
        <p class="section-kicker">A quiet place between requests</p>
        <h1 id="offline-title">Your saved pages, close at hand.</h1>
        <p id="offline-description" class="intro-copy">
          Search public pages saved on this device first. Connection and installation details stay in the notebook margin.
        </p>
      </div>
      <div class="intro-actions">
        <button class="primary-button" type="button" :disabled="isRetrying" @click="retryConnection">
          <span>{{ isRetrying ? 'Checking…' : 'Check the server' }}</span>
        </button>
        <p class="connection-detail">{{ connectionMessage }}</p>
      </div>
      <p v-if="pwaError" class="connection-detail" role="status">{{ pwaError }}</p>
    </section>
    <div class="notebook-grid">
      <section class="surface library-surface" aria-labelledby="downloaded-pages-title">
        <OfflineLibrary
          :storage="offlineStorage"
          :storage-state="storageState"
          :storage-message="storageMessage"
          :refresh-token="libraryRefreshToken"
          :clear-device-token="clearDeviceToken"
          :requested-selector="offlineSelector"
          @changed="handleLibraryChanged"
          @error="handleLibraryError"
          @retry-storage="openStorage"
        />
        <p v-if="libraryNotice" class="connection-detail library-notice" role="alert">{{ libraryNotice }}</p>
      </section>

      <aside class="side-stack" aria-label="Offline capability notes">
        <section class="surface note-surface" aria-labelledby="drafts-title">
          <p class="section-kicker">Protected workspace <span aria-hidden="true">02</span></p>
          <h2 id="drafts-title">Locked drafts</h2>
          <p class="note-lead">
            <strong class="locked-count">{{ storageEstimate?.lockedDraftCount ?? '—' }}</strong>
            {{ storageEstimate?.lockedDraftCount === 1 ? 'opaque draft envelope' : 'opaque draft envelopes' }}
          </p>
          <p class="note-detail">{{ lockedDraftDetail }}</p>
        </section>

        <section class="surface utility-surface" aria-labelledby="storage-title">
          <div class="surface-heading compact">
            <div>
              <p class="section-kicker">Device capacity <span aria-hidden="true">03</span></p>
              <h2 id="storage-title">Storage</h2>
            </div>
            <span class="utility-icon" aria-hidden="true">+</span>
          </div>
          <p class="utility-copy">{{ storageDetail }}</p>
          <p v-if="storageEstimate?.persisted !== null && storageEstimate?.persisted !== undefined" class="field-hint">
            Persistent storage: {{ storageEstimate.persisted ? 'granted' : 'not granted' }}. Browser eviction remains possible.
          </p>
          <div class="utility-actions">
            <button class="secondary-button" type="button" :disabled="storageState === 'checking' || storageBusy" @click="openStorage">
              {{ storageState === 'checking' ? 'Checking…' : 'Refresh storage' }}
            </button>
            <button class="secondary-button" type="button" :disabled="!offlineStorage || persistenceBusy" @click="requestPersistence">
              {{ persistenceBusy ? 'Requesting…' : 'Request persistent storage' }}
            </button>
            <button class="text-button" type="button" :disabled="!offlineStorage || clearBusy || storageEstimate?.snapshotCount === 0" @click="removeDownloadedPages">
              {{ clearBusy ? 'Removing…' : 'Remove downloaded pages' }}
            </button>
            <button class="text-button danger-button" type="button" :disabled="!offlineStorage || clearBusy" @click="beginClearDeviceData">
              Clear offline data on this device
            </button>
          </div>
          <p v-if="removeNotice" class="utility-status" role="status" aria-live="polite">{{ removeNotice }}</p>
          <p v-if="clearNotice" class="utility-status" role="status" aria-live="polite">{{ clearNotice }}</p>
          <p class="field-hint">Removing downloaded pages leaves locked drafts and submission recovery alone. Browser storage is not a backup.</p>

        </section>
        <section class="surface utility-surface install-surface" aria-labelledby="install-title">
          <div class="surface-heading compact">
            <div>
              <p class="section-kicker">Optional doorway <span aria-hidden="true">04</span></p>
              <h2 id="install-title">Install</h2>
            </div>
            <span class="utility-icon" aria-hidden="true">↗</span>
          </div>
          <p class="utility-copy">{{ installDetail }}</p>
          <button v-if="pwaState.installPromptAvailable" class="secondary-button" type="button" :disabled="isInstalling" @click="installApplication">
            {{ isInstalling ? 'Opening install…' : 'Install tsEpistle' }}
          </button>
          <p class="field-hint">{{ installMessage }}</p>
        </section>

        <section v-if="hasUpdateNotice || pwaState.offlineReady" class="surface utility-surface update-surface" aria-labelledby="update-title">
          <div class="surface-heading compact">
            <div>
              <p class="section-kicker">Build lifecycle <span aria-hidden="true">05</span></p>
              <h2 id="update-title">{{ pwaState.updateReady || pwaState.reloadNeeded ? 'App update' : 'Offline ready' }}</h2>
            </div>
            <span class="utility-icon" aria-hidden="true">↻</span>
          </div>
          <p class="utility-copy">{{ updateMessage }}</p>
          <button v-if="pwaState.updateReady || pwaState.reloadNeeded || pwaState.updateError" class="secondary-button" type="button" :disabled="isUpdating" @click="acceptUpdate">
            {{ isUpdating ? 'Preparing safe reload…' : pwaState.updateError ? 'Retry update check' : 'Apply update safely' }}
          </button>
          <p class="field-hint">The neutral client acknowledges reload safety; no editor memory or publish request is present here.</p>
        </section>
      </aside>
    </div>
    <div v-if="clearDialogOpen" class="clear-dialog-backdrop" role="presentation" @keydown.esc.prevent="cancelClearDeviceData">
      <section ref="clearDialog" class="clear-dialog" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="clear-device-title" aria-describedby="clear-device-description">
        <p class="section-kicker">Destructive device action</p>
        <h2 id="clear-device-title">Clear offline data on this device?</h2>
        <p id="clear-device-description">
          This removes downloaded pages, locked drafts, and unresolved submission recovery from this browser.
          It does not delete anything from the server.
        </p>
        <p class="clear-dialog-warning">Cancel leaves every local record and generation unchanged.</p>
        <div class="clear-dialog-actions">
          <button class="secondary-button" type="button" :disabled="clearBusy" @click="cancelClearDeviceData">Cancel</button>
          <button class="primary-button danger-button" type="button" :disabled="clearBusy" @click="confirmClearDeviceData">Clear offline data</button>
        </div>
      </section>
    </div>

    <footer class="offline-footer">
      <p><strong>Server authority stays online.</strong> Local pages are bounded, explicit, and never a permission decision.</p>
      <p class="footer-mark">OFFLINE / NEUTRAL / NO ACCOUNT DATA</p>
    </footer>
  </main>
</template>

<style>
:root {
  color-scheme: light dark;
  --offline-paper: #f5f1e8;
  --offline-paper-raised: #fffdf8;
  --offline-paper-sunken: #ebe5d9;
  --offline-ink: #1c2829;
  --offline-muted: #536260;
  --offline-faint: #596762;
  --offline-accent: #1d6f69;
  --offline-accent-strong: #0e4f4b;
  --offline-warm: #8b3022;
  --offline-danger-background: #8b3022;
  --offline-danger-foreground: #fff8f3;
  --offline-border: rgba(28, 40, 41, .16);
  --offline-border-strong: rgba(28, 40, 41, .32);
  --offline-focus: #b3482d;
  --offline-shadow: 0 1.25rem 3rem rgba(38, 48, 45, .1);
  --offline-shadow-small: 0 .35rem 1.1rem rgba(38, 48, 45, .08);
  --offline-radius: 1.2rem;
  --offline-mono: ui-monospace, 'SFMono-Regular', Consolas, monospace;
  --offline-body: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  --offline-heading: ui-serif, Georgia, 'Times New Roman', serif;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-width: 20rem;
  min-height: 100%;
}

body {
  margin: 0;
  background: var(--offline-paper);
  color: var(--offline-ink);
  font-family: var(--offline-body);
  text-rendering: optimizeLegibility;
}

button,
input {
  font: inherit;
}

button,
a,
input {
  -webkit-tap-highlight-color: transparent;
}

button {
  min-block-size: 2.75rem;
  border: 0;
}

button:focus-visible,
a:focus-visible,
input:focus-visible {
  outline: .2rem solid var(--offline-focus);
  outline-offset: .2rem;
}

button:disabled {
  cursor: not-allowed;
  opacity: .56;
}

.offline-shell {
  position: relative;
  isolation: isolate;
  inline-size: min(100%, 88rem);
  max-inline-size: 100vw;
  min-block-size: 100vh;
  min-block-size: 100dvh;
  margin: 0 auto;
  padding-block: max(1rem, env(safe-area-inset-top)) max(1.3rem, env(safe-area-inset-bottom));
  padding-inline: max(.9rem, env(safe-area-inset-left)) max(.9rem, env(safe-area-inset-right));
}

.offline-shell::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  background-image:
    linear-gradient(rgba(28, 40, 41, .045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(28, 40, 41, .045) 1px, transparent 1px);
  background-position: center top;
  background-size: 2.25rem 2.25rem;
  content: '';
  mask-image: linear-gradient(to bottom, black, transparent 83%);
  pointer-events: none;
}

.notebook-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 1rem 2rem;
  align-items: center;
  padding-block-end: 1.15rem;
  border-block-end: 1px solid var(--offline-border);
}

.wordmark {
  display: inline-flex;
  min-block-size: 2.75rem;
  align-items: center;
  gap: .65rem;
  color: var(--offline-ink);
  font-family: var(--offline-heading);
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: -.04em;
  text-decoration: none;
}

.brand-mark {
  position: relative;
  display: inline-grid;
  width: 1.7rem;
  height: 1.7rem;
  place-items: center;
  border: 1px solid var(--offline-accent);
  border-radius: .25rem .65rem .25rem .65rem;
  background: color-mix(in srgb, var(--offline-accent) 11%, transparent);
  transform: rotate(-7deg);
}

.brand-mark::before,
.brand-mark::after,
.brand-mark span {
  position: absolute;
  display: block;
  width: .75rem;
  height: 1px;
  background: var(--offline-accent);
  content: '';
}

.brand-mark::before {
  transform: translateY(-.28rem) rotate(12deg);
}

.brand-mark::after {
  transform: translateY(.28rem) rotate(-12deg);
}

.brand-mark span {
  transform: rotate(90deg);
}

.eyebrow,
.section-kicker,
.footer-mark {
  margin: 0;
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .68rem;
  font-weight: 700;
  letter-spacing: .13em;
  line-height: 1.5;
  text-transform: uppercase;
}

.eyebrow {
  justify-self: center;
}

.connection-status {
  display: inline-flex;
  min-block-size: 2.75rem;
  align-items: center;
  justify-self: end;
  gap: .55rem;
  padding: .5rem .8rem;
  border: 1px solid var(--offline-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--offline-paper-raised) 72%, transparent);
  color: var(--offline-muted);
  font-family: var(--offline-mono);
  font-size: .72rem;
  font-weight: 700;
  letter-spacing: .03em;
}

.connection-status[data-state='online'] {
  border-color: color-mix(in srgb, var(--offline-accent) 44%, var(--offline-border));
  color: var(--offline-accent-strong);
}

.connection-status[data-state='server-unavailable'] {
  border-color: color-mix(in srgb, var(--offline-warm) 55%, var(--offline-border));
  color: color-mix(in srgb, var(--offline-warm) 80%, var(--offline-ink));
}

.status-dot {
  width: .55rem;
  height: .55rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--offline-faint);
  box-shadow: 0 0 0 .24rem color-mix(in srgb, var(--offline-faint) 15%, transparent);
}

.connection-status[data-state='online'] .status-dot {
  background: var(--offline-accent);
  box-shadow: 0 0 0 .24rem color-mix(in srgb, var(--offline-accent) 18%, transparent);
}

.connection-status[data-state='server-unavailable'] .status-dot {
  background: var(--offline-warm);
  box-shadow: 0 0 0 .24rem color-mix(in srgb, var(--offline-warm) 17%, transparent);
}

.intro {
  max-inline-size: 57rem;
  padding-block: 1.1rem .9rem;
}

.intro .section-kicker { color: var(--offline-accent); }

.intro h1 {
  max-inline-size: 22ch;
  margin: .35rem 0 .55rem;
  font-family: var(--offline-heading);
  font-size: clamp(1.9rem, 5vw, 3.35rem);
  font-weight: 550;
  letter-spacing: -.06em;
  line-height: 1;
  text-wrap: balance;
}

.intro-copy {
  max-inline-size: 58ch;
  margin: 0;
  color: var(--offline-muted);
  font-size: clamp(.9rem, 1.45vw, 1.08rem);
  line-height: 1.45;
  text-wrap: pretty;
}

.intro-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .6rem .85rem;
  align-items: center;
  margin-block-start: .75rem;
}

.connection-detail {
  max-width: 34rem;
  margin: 0;
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .75rem;
  line-height: 1.55;
}

.primary-button,
.secondary-button,
.text-button {
  min-block-size: 2.75rem;
  cursor: pointer;
  font-weight: 700;
}

.primary-button {
  padding-inline: 1.15rem;
  border-radius: .45rem .95rem .45rem .95rem;
  background: var(--offline-accent-strong);
  color: #f8fbf5;
  box-shadow: 0 .5rem 1.1rem color-mix(in srgb, var(--offline-accent-strong) 25%, transparent);
}
.primary-button.danger-button {
  background: var(--offline-danger-background);
  color: var(--offline-danger-foreground);
  box-shadow: 0 .5rem 1.1rem color-mix(in srgb, var(--offline-danger-background) 25%, transparent);
}

.secondary-button {
  padding-inline: .95rem;
  border: 1px solid var(--offline-border-strong);
  border-radius: .45rem;
  background: var(--offline-paper-raised);
  color: var(--offline-ink);
}

.text-button {
  padding-inline: .35rem;
  background: transparent;
  color: var(--offline-muted);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 42%, transparent);
  text-underline-offset: .2em;
}

.notebook-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.22fr) minmax(19rem, .78fr);
  gap: 1.25rem;
  align-items: start;
}

.surface {
  border: 1px solid var(--offline-border);
  border-radius: var(--offline-radius);
  background: color-mix(in srgb, var(--offline-paper-raised) 88%, transparent);
  box-shadow: var(--offline-shadow-small);
}

.library-surface {
  min-block-size: 0;
  padding: clamp(1rem, 2.4vw, 1.7rem);
}

.surface-heading {
  display: flex;
  gap: 1rem;
  align-items: start;
  justify-content: space-between;
  padding-block-end: 1.4rem;
  border-block-end: 1px solid var(--offline-border);
}

.surface-heading.compact {
  padding-block-end: .95rem;
}

.surface h2 {
  margin: .35rem 0 0;
  font-family: var(--offline-heading);
  font-size: clamp(1.7rem, 3vw, 2.55rem);
  font-weight: 500;
  letter-spacing: -.055em;
  line-height: 1;
}

.surface h3 {
  margin: 0;
  font-family: var(--offline-heading);
  font-size: 1.65rem;
  font-weight: 500;
  letter-spacing: -.04em;
}

.count-note {
  padding-block-start: .35rem;
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .7rem;
  white-space: nowrap;
}

.search-field {
  display: grid;
  gap: .55rem;
  max-width: 38rem;
  margin-block: 1.5rem 1rem;
}

.search-field label {
  color: var(--offline-muted);
  font-family: var(--offline-mono);
  font-size: .75rem;
  font-weight: 700;
  letter-spacing: .035em;
}

.search-field input {
  min-block-size: 2.9rem;
  width: 100%;
  padding: .55rem .8rem;
  border: 1px solid var(--offline-border-strong);
  border-radius: .5rem;
  background: var(--offline-paper);
  color: var(--offline-ink);
}

.search-field input::placeholder {
  color: var(--offline-faint);
}

.field-hint {
  margin: 0;
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .69rem;
  line-height: 1.55;
}

.empty-state {
  display: grid;
  min-height: 17rem;
  align-content: center;
  justify-items: start;
  gap: .7rem;
  margin-block-start: 1rem;
  padding: clamp(1.4rem, 4vw, 2.25rem);
  border: 1px dashed var(--offline-border-strong);
  border-radius: .8rem;
  background: var(--offline-paper-sunken);
}

.empty-rule {
  width: 3.5rem;
  height: .2rem;
  margin-block-end: .4rem;
  background: var(--offline-warm);
}

.empty-state p,
.empty-state small {
  max-width: 34rem;
  margin: 0;
  color: var(--offline-muted);
  line-height: 1.6;
}

.empty-state small {
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .69rem;
}

.side-stack {
  display: grid;
  gap: 1.25rem;
}

.note-surface,
.utility-surface {
  padding: 1.35rem;
}

.note-surface {
  position: relative;
  overflow: hidden;
  background: linear-gradient(145deg, color-mix(in srgb, var(--offline-accent) 12%, var(--offline-paper-raised)), var(--offline-paper-raised));
}

.note-surface::after {
  position: absolute;
  inset: auto -2.2rem -3.3rem auto;
  width: 8rem;
  height: 8rem;
  border: 1px solid color-mix(in srgb, var(--offline-accent) 28%, transparent);
  border-radius: 50%;
  box-shadow: 0 0 0 1.15rem color-mix(in srgb, var(--offline-accent) 8%, transparent), 0 0 0 2.3rem color-mix(in srgb, var(--offline-accent) 5%, transparent);
  content: '';
  pointer-events: none;
}

.note-lead,
.note-detail,
.utility-copy {
  position: relative;
  z-index: 1;
  line-height: 1.58;
}

.note-lead {
  margin: 1.2rem 0 .8rem;
  color: var(--offline-ink);
  font-size: 1.02rem;
}

.note-detail {
  margin: 0;
  color: var(--offline-muted);
  font-size: .84rem;
}

.utility-icon {
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 1px solid var(--offline-border-strong);
  border-radius: 50%;
  color: var(--offline-accent-strong);
  font-family: var(--offline-mono);
  font-size: 1rem;
}

.utility-copy {
  min-height: 3.2rem;
  margin: 1.05rem 0 .8rem;
  color: var(--offline-muted);
  font-size: .88rem;
}

.utility-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .55rem .85rem;
  align-items: center;
  margin-block: 1rem .8rem;
}
.utility-status {
  margin: .5rem 0 0;
  color: var(--offline-muted);
  font-family: var(--offline-mono);
  font-size: .75rem;
  line-height: 1.5;
}

.text-button.danger-button { color: var(--offline-danger-background); }

.clear-dialog-backdrop {
  position: fixed;
  z-index: 10;
  inset: 0;
  display: grid;
  place-items: center;
  padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
  background: color-mix(in srgb, var(--offline-ink) 48%, transparent);
}

.clear-dialog {
  inline-size: min(100%, 34rem);
  max-block-size: calc(100dvh - 2rem);
  overflow: auto;
  padding: clamp(1.2rem, 4vw, 2rem);
  border: 1px solid var(--offline-border-strong);
  border-radius: var(--offline-radius);
  background: var(--offline-paper-raised);
  color: var(--offline-ink);
  box-shadow: var(--offline-shadow);
}

.clear-dialog h2 {
  margin: .45rem 0 .85rem;
  font-family: var(--offline-heading);
  font-size: clamp(1.5rem, 5vw, 2.2rem);
  letter-spacing: -.045em;
  line-height: 1.05;
}

.clear-dialog p:not(.section-kicker) {
  margin: 0;
  color: var(--offline-muted);
  line-height: 1.55;
}

.clear-dialog-warning {
  margin-block-start: .75rem !important;
  color: var(--offline-warm) !important;
  font-family: var(--offline-mono);
  font-size: .78rem;
}

.clear-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .65rem;
  margin-block-start: 1.2rem;
}

.clear-dialog-actions > * { flex: 1 1 10rem; }

.install-surface {
  background: color-mix(in srgb, var(--offline-paper-raised) 95%, var(--offline-warm) 5%);
}

.offline-footer {
  display: flex;
  flex-wrap: wrap;
  gap: .75rem 2rem;
  justify-content: space-between;
  margin-block-start: 1.25rem;
  padding-block-start: 1.1rem;
  border-block-start: 1px solid var(--offline-border);
  color: var(--offline-faint);
  font-size: .77rem;
  line-height: 1.55;
}

.offline-footer p {
  max-width: 38rem;
  margin: 0;
}

.offline-footer strong {
  color: var(--offline-muted);
}

.footer-mark {
  align-self: end;
  font-size: .62rem;
  text-align: end;
}

@media (prefers-color-scheme: dark) {
  :root {
    --offline-paper: #151c1c;
    --offline-paper-raised: #1c2625;
    --offline-paper-sunken: #101616;
    --offline-ink: #eef1e8;
    --offline-muted: #b3c0b8;
    --offline-faint: #8b9a91;
    --offline-accent: #72c3b2;
    --offline-accent-strong: #83d2c0;
    --offline-warm: #e09668;
    --offline-danger-background: #f0a47b;
    --offline-danger-foreground: #1b2522;
    --offline-border: rgba(238, 241, 232, .16);
    --offline-border-strong: rgba(238, 241, 232, .34);
    --offline-focus: #f0a47b;
    --offline-shadow: 0 1.25rem 3rem rgba(0, 0, 0, .26);
    --offline-shadow-small: 0 .35rem 1.1rem rgba(0, 0, 0, .2);
  }

  .offline-shell::before {
    background-image:
      linear-gradient(rgba(238, 241, 232, .045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(238, 241, 232, .045) 1px, transparent 1px);
  }

  .primary-button {
    color: #102523;
  }
}

@media (max-width: 760px) {
  .notebook-header {
    grid-template-columns: 1fr auto;
    gap: .7rem 1rem;
  }

  .eyebrow {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-self: start;
    order: 3;
  }

  .connection-status {
    font-size: .66rem;
  }

  .notebook-grid {
    grid-template-columns: 1fr;
  }

  .library-surface {
    min-height: auto;
  }
}

@media (max-width: 480px) {
  .offline-shell {
    padding-block-start: max(.7rem, env(safe-area-inset-top));
    padding-inline: max(.7rem, env(safe-area-inset-left)) max(.7rem, env(safe-area-inset-right));
  }

  .intro { padding-block: .65rem .55rem; }
  .intro h1 {
    max-inline-size: 20ch;
    margin-block: .25rem .45rem;
    font-size: clamp(1.65rem, 8vw, 2.5rem);
  }
  .intro-copy {
    font-size: .88rem;
    line-height: 1.4;
  }
  .intro-actions {
    align-items: stretch;
    margin-block-start: .5rem;
  }
  .intro-actions .primary-button { inline-size: auto; }
  .utility-actions { align-items: stretch; flex-direction: column; }
  .utility-actions .secondary-button,
  .utility-actions .text-button { inline-size: 100%; }
  .connection-detail { max-inline-size: none; }
  .offline-footer { flex-direction: column; gap: .5rem; }
  .footer-mark { align-self: start; text-align: start; }
}

@media (orientation: landscape) and (max-height: 500px) {
  .offline-shell {
    padding-block-start: max(.45rem, env(safe-area-inset-top));
    padding-block-end: max(.75rem, env(safe-area-inset-bottom));
  }

  .notebook-header {
    gap: .45rem 1rem;
    padding-block-end: .55rem;
  }

  .intro {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(16rem, 20rem);
    column-gap: 1rem;
    align-items: center;
    padding-block: .35rem .3rem;
  }

  .intro h1 {
    max-inline-size: none;
    margin-block: .15rem .25rem;
    font-size: 1.55rem;
    line-height: 1.05;
  }

  .intro-copy {
    display: -webkit-box;
    max-inline-size: none;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    font-size: .78rem;
    line-height: 1.3;
  }

  .intro-actions {
    min-width: 0;
    align-items: stretch;
    flex-direction: column;
    gap: .2rem;
    margin-block-start: 0;
  }

  .intro-actions .connection-detail {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.2;
  }

  .intro > .connection-detail { grid-column: 1 / -1; }

  .library-surface {
    padding-block: .35rem;
    padding-inline: .65rem;
  }

  .offline-shell .offline-library .library-heading { padding-block-end: .2rem; }
  .offline-shell .offline-library h2 { font-size: 1.45rem; }
  .offline-shell .offline-library .scope-note {
    margin-block-start: .25rem;
    line-height: 1.3;
  }
  .offline-shell .offline-library .search-field {
    gap: .3rem;
    margin-block: .25rem .35rem;
  }
}

@media (orientation: landscape) and (max-height: 500px) and (min-width: 600px) {
  .notebook-header {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .eyebrow {
    grid-column: auto;
    grid-row: auto;
    justify-self: center;
    order: initial;
  }
}

@media (forced-colors: active) {
  :root {
    --offline-paper: Canvas;
    --offline-paper-raised: Canvas;
    --offline-paper-sunken: Canvas;
    --offline-ink: CanvasText;
    --offline-muted: CanvasText;
    --offline-faint: GrayText;
    --offline-accent: LinkText;
    --offline-accent-strong: LinkText;
    --offline-warm: CanvasText;
    --offline-danger-background: CanvasText;
    --offline-danger-foreground: Canvas;
    --offline-border: CanvasText;
    --offline-border-strong: CanvasText;
    --offline-focus: Highlight;
    --offline-shadow: none;
    --offline-shadow-small: none;
  }

  .offline-shell::before,
  .note-surface::after {
    display: none;
  }

  .surface,
  .connection-status,
  .search-field input,
  .clear-dialog,
  .empty-state {
    border-color: CanvasText;
    box-shadow: none;
  }

  button {
    border: 1px solid ButtonText;
    background: ButtonFace;
    color: ButtonText;
    box-shadow: none;
  }

  .primary-button {
    background: Highlight;
    color: HighlightText;
  }
  .primary-button.danger-button {
    background: Highlight;
    color: HighlightText;
  }

  .brand-mark,
  .brand-mark::before,
  .brand-mark::after,
  .brand-mark span,
  .empty-rule {
    background: transparent;
    border-color: CanvasText;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: .01ms !important;
  }
}
</style>
