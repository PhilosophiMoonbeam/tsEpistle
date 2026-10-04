<template lang='pug'>
section.pwa-status-panel(
  role='region'
  :aria-label='$t(`common:offline.status.panelLabel`, { status: connectionLabel($t), defaultValue: `Connection and offline access: {{status}}`, interpolation: { escapeValue: false } })'
)
  .pwa-status-panel__body
    .pwa-status-panel__heading
      div
        p.pwa-status-panel__eyebrow {{ $t('common:offline.status.eyebrow', { defaultValue: 'This device' }) }}
        h2 {{ $t('common:offline.status.title', { defaultValue: 'Connection and offline access' }) }}
      v-icon(:icon='connectionPresentation.icon', :color='connectionPresentation.tone', size='22', aria-hidden='true')

    //- The only live region in the panel; the notes below are plain text.
    .pwa-status-panel__summary(role='status', aria-live='polite', aria-atomic='true')
      span.pwa-status-panel__summary-dot(:class='`pwa-status-panel__summary-dot--${connectionPresentation.tone}`', aria-hidden='true')
      div
        strong {{ connectionLabel($t) }}
        p {{ msg($t, summaryDescription) }}

    dl.pwa-status-panel__facts
      div
        dt {{ $t('common:offline.status.browserConnection', { defaultValue: 'Browser connection' }) }}
        dd(:class='`pwa-status-panel__value--${networkHintTone}`') {{ msg($t, networkHint) }}
      div
        dt {{ $t('common:offline.status.server', { defaultValue: 'Server' }) }}
        dd(:class='`pwa-status-panel__value--${serverStatusTone}`') {{ msg($t, serverStatus) }}
      div
        dt {{ $t('common:offline.status.offlineAccess', { defaultValue: 'Offline access' }) }}
        dd {{ msg($t, offlineShell) }}

    v-alert.pwa-status-panel__alert(
      v-if='pwaState.error && pwaState.error !== pwaState.updateError'
      type='error'
      variant='tonal'
      density='compact'
      role='alert'
    ) {{ pwaState.error }}
    v-alert.pwa-status-panel__alert(
      v-if='pwaState.updateError'
      type='error'
      variant='tonal'
      density='compact'
      role='alert'
    )
      strong {{ $t('common:offline.status.updateError', { defaultValue: 'Update error.' }) }}
      |  {{ pwaState.updateError }}
    v-alert.pwa-status-panel__alert(
      v-if='pwaState.installError'
      type='error'
      variant='tonal'
      density='compact'
      role='alert'
    )
      strong {{ $t('common:offline.status.installError', { defaultValue: 'Install error.' }) }}
      |  {{ pwaState.installError }}

    .pwa-status-panel__actions
      v-btn(
        variant='outlined'
        prepend-icon='mdi-refresh'
        :loading='isRetrying'
        :disabled='isRetrying'
        @click='retryConnection'
      ) {{ isRetrying ? $t('common:offline.status.checking', { defaultValue: 'Checking…' }) : $t('common:offline.status.checkConnection', { defaultValue: 'Check connection' }) }}
      v-btn(
        v-if='startupRefreshDeferred || (pwaState.updateReady && (pwaState.preparation === `deferred` || pwaState.preparation === `error`))'
        color='primary'
        variant='tonal'
        prepend-icon='mdi-update'
        :loading='isUpdating'
        :disabled='isUpdating || pwaState.reloadSafe === false'
        @click='applyUpdate'
      ) {{ msg($t, updateActionLabel) }}

    p.pwa-status-panel__note(v-if='updateNote') {{ msg($t, updateNote) }}

    section.pwa-status-panel__install(
      v-if='showInstallSection'
      aria-labelledby='pwa-status-install-title'
    )
      h3#pwa-status-install-title {{ siteText($t, 'installTitle') }}
      p(v-if='pwaState.isStandalone') {{ siteText($t, 'standalone') }}
      p(v-else-if='installCompleted') {{ siteText($t, 'installed') }}
      template(v-else-if='canInstall')
        p {{ siteText($t, 'installHint') }}
        v-btn(
          color='primary'
          variant='tonal'
          prepend-icon='mdi-download-outline'
          :loading='isInstalling'
          :disabled='isInstalling'
          @click='installApplication'
        ) {{ isInstalling ? $t('common:offline.status.opening', { defaultValue: 'Opening…' }) : siteText($t, 'installAction') }}
      p(v-else-if='manualInstallGuidance') {{ $t('common:offline.status.manualInstall', { defaultValue: 'Open Share or your browser menu and choose Add to Home Screen, if available.' }) }}
      p(v-else) {{ siteText($t, 'installUnavailable') }}

    //- Same-site links use a chevron; an external-link arrow would suggest a new tab.
    .pwa-status-panel__links(v-if='showLinks')
      a.pwa-status-panel__library(href='/p/offline')
        v-icon(icon='mdi-tune-variant', size='18', aria-hidden='true')
        span {{ $t('common:offline.summary.settingsLink', { defaultValue: 'Offline settings' }) }}
        v-icon.pwa-status-panel__chevron(icon='mdi-chevron-right', size='18', aria-hidden='true')
      a.pwa-status-panel__library(href='/p/offline#downloaded-pages-title')
        v-icon(icon='mdi-cloud-check-outline', size='18', aria-hidden='true')
        span {{ $t('common:offline.summary.savedPagesLink', { defaultValue: 'Saved pages' }) }}
        v-icon.pwa-status-panel__chevron(icon='mdi-chevron-right', size='18', aria-hidden='true')
</template>

<script setup lang='ts'>
import { computed, ref } from 'vue'
import { pwaConnectionPresentation, pwaState, promptPwaInstall, requestPwaUpdate, retryServerConnection, startupRefreshDeferred } from '../../helpers/pwa'
import { translateConnection } from '../../helpers/offline-sync-status.ts'
import { wikiStore } from '../../store/index.ts'

const { showLinks = true } = defineProps<{ showLinks?: boolean }>()

/** A locale key under `common:offline.status` and its English default. */
type StatusMessage = readonly [key: string, text: string]
type Translate = (key: string, options?: Record<string, unknown>) => string

const msg = (t: Translate, message: StatusMessage): string => t(`common:offline.status.${message[0]}`, { defaultValue: message[1] })

const isRetrying = ref(false)
const isInstalling = ref(false)
const isUpdating = ref(false)

const siteTitle = computed(() => wikiStore.site.title?.trim() || (typeof siteConfig === 'undefined' ? '' : siteConfig.title?.trim() ?? '') || 'this wiki')

// Defaults stay in script: a `{{site}}` placeholder inside a template mustache would end the interpolation.
const SITE_TEXT = {
  installTitle: 'Install {{site}}',
  standalone: 'You are using {{site}} in its own window.',
  installed: 'Installed. Open {{site}} from your apps or home screen.',
  installHint: 'Add {{site}} to your apps or home screen.',
  installAction: 'Install {{site}}',
  installUnavailable: 'Your browser does not offer installation right now. You can keep using {{site}} here.'
} as const
const siteText = (t: Translate, key: keyof typeof SITE_TEXT): string =>
  t(`common:offline.status.${key}`, { site: siteTitle.value, defaultValue: SITE_TEXT[key], interpolation: { escapeValue: false } })

const installCompleted = computed(() => pwaState.appInstalled === true || pwaState.installed === true || pwaState.installAvailability === 'installed')

const canInstall = computed(() => {
  return pwaState.installPromptAvailable && pwaState.installAvailability === 'available' && !installCompleted.value && !pwaState.isStandalone
})

const manualInstallGuidance = computed(() => {
  if (canInstall.value || installCompleted.value || pwaState.isStandalone) return false
  if (typeof navigator === 'undefined') return false
  // Safari's standalone property is the only browser-specific install signal
  // we use. No user-agent guess is needed for generic manual guidance.
  return 'standalone' in navigator
})

const showInstallSection = true

const connectionPresentation = computed(() => pwaConnectionPresentation(pwaState))
const connectionLabel = (t: Translate): string => translateConnection(connectionPresentation.value, t)

const networkHintTone = computed<'success' | 'warning' | 'error'>(() => {
  if (pwaState.onlineHint === true) return 'warning'
  if (pwaState.onlineHint === false) return 'error'
  return 'warning'
})

const serverStatus = computed<StatusMessage>(() => {
  if (pwaState.connection === 'checking') return ['checking', 'Checking…']
  if (pwaState.serverHealthy === true) return ['serverAvailable', 'Available']
  if (pwaState.serverReachable === true) return ['serverDegraded', 'Responded, but unavailable']
  if (pwaState.serverReachable === false) return ['serverUnavailable', 'Unavailable']
  return ['serverNotChecked', 'Not checked']
})

const serverStatusTone = computed<'success' | 'warning' | 'error'>(() => {
  if (pwaState.connection === 'online' && pwaState.serverHealthy === true) return 'success'
  if (pwaState.connection === 'server-unavailable' || pwaState.serverReachable === false || pwaState.serverHealthy === false) return 'error'
  return 'warning'
})

const offlineShell = computed<StatusMessage>(() => {
  if (pwaState.offlineReady) return pwaState.controlled ? ['shellReady', 'Ready'] : ['shellNextVisit', 'Ready for your next visit']
  if (pwaState.registrationState === 'unsupported') return ['shellUnsupported', 'Not supported by this browser']
  if (pwaState.registrationState === 'error') return ['shellError', 'Could not set up offline access']
  return ['shellNotReady', 'Not ready yet']
})

const summaryDescription = computed<StatusMessage>(() => {
  if (pwaState.connection === 'checking') return ['summaryChecking', 'Checking whether the server is available.']
  if (pwaState.connection === 'offline') return ['summaryOffline', 'You are offline. Keep reading saved pages. Sync resumes when you reconnect.']
  if (pwaState.connection === 'server-unavailable') return ['summaryServerUnavailable', 'The server is temporarily unavailable. Your saved pages remain available here.']
  if (pwaState.connection === 'online' && pwaState.serverReachable === true && pwaState.serverHealthy === true) {
    return ['summaryConnected', 'The server is available. You can browse and sync saved pages.']
  }
  return ['summaryNotVerified', 'Check the connection to see whether the server is available.']
})

const networkHint = computed<StatusMessage>(() => {
  if (pwaState.onlineHint === true) return ['networkConnected', 'Reports a connection']
  if (pwaState.onlineHint === false) return ['networkDisconnected', 'Reports no connection']
  return ['networkUnknown', 'Unknown']
})

const updateActionLabel = computed<StatusMessage>(() => {
  if (isUpdating.value) return startupRefreshDeferred.value ? ['checking', 'Checking…'] : ['updateRetrying', 'Retrying…']
  return startupRefreshDeferred.value ? ['updateCheckAndRefresh', 'Check and refresh app'] : ['updateRetry', 'Retry app update']
})

/** One short note about the app update; it is not a live region. */
const updateNote = computed<StatusMessage | null>(() => {
  if (startupRefreshDeferred.value) {
    return pwaState.reloadSafe === false
      ? ['noteDeferredUnsafe', 'The update check was deferred. This page will not reload by itself. Refresh is paused until all open pages are safe.']
      : ['noteDeferred', 'The update check was deferred. This page will not reload by itself. Select Check and refresh when you are ready.']
  }
  if (pwaState.reloadNeeded) return ['noteReloadNeeded', 'The app has updated. This page reloads when your current work is safe.']
  if (pwaState.updateReady && pwaState.reloadSafe === false) return ['noteWaitingForWork', 'Update ready. It applies after your current work is safe.']
  if (pwaState.updateReady && pwaState.preparation === 'deferred') return ['noteWaitingForTabs', 'The update is waiting for all open pages to respond. Return to or close older tabs, then retry if needed.']
  if (pwaState.updateReady) return ['notePreparing', 'The app update is being prepared. This page may reload when all open pages are safe.']
  if (pwaState.updateState === 'checking' || pwaState.updateState === 'activating') return ['noteChecking', 'Checking for an app update without interrupting this page.']
  return null
})

const retryConnection = async (): Promise<void> => {
  if (isRetrying.value) return
  isRetrying.value = true
  try {
    await retryServerConnection()
  } finally {
    isRetrying.value = false
  }
}

const installApplication = async (): Promise<void> => {
  if (!canInstall.value || isInstalling.value) return
  isInstalling.value = true
  try {
    await promptPwaInstall()
  } finally {
    isInstalling.value = false
  }
}

const applyUpdate = async (): Promise<void> => {
  if ((!startupRefreshDeferred.value && !pwaState.updateReady) || pwaState.reloadSafe === false || isUpdating.value) return
  isUpdating.value = true
  try {
    await requestPwaUpdate()
  } finally {
    isUpdating.value = false
  }
}
</script>

<style scoped lang='scss'>
.pwa-status-panel__summary-dot {
  display: block;
  border-radius: 50%;
  background: rgb(var(--v-theme-on-surface-variant));
}
.pwa-status-panel__summary-dot--success { background: rgb(var(--v-theme-success)); }
.pwa-status-panel__summary-dot--warning { background: rgb(var(--v-theme-warning)); }
.pwa-status-panel__summary-dot--error { background: rgb(var(--v-theme-error)); }


.pwa-status-panel {
  width: 100%;
  max-width: 100%;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  color: rgb(var(--v-theme-on-surface));
  box-shadow: none !important;
}
.pwa-status-panel__body {
  padding: var(--wiki-space-4);
}

.pwa-status-panel__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--wiki-space-3);
  margin-block-end: var(--wiki-space-3);
}
.pwa-status-panel__eyebrow {
  margin: 0 0 var(--wiki-space-1);
  color: var(--wiki-text-muted);
  font-size: .8125rem;
  font-weight: 600;
  letter-spacing: normal;
  line-height: 1.4;
  text-transform: none;
}

.pwa-status-panel h2,
.pwa-status-panel h3 {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-weight: 720;
  line-height: 1.25;
}

.pwa-status-panel h2 { font-size: 1rem; }
.pwa-status-panel h3 { font-size: .8125rem; }

.pwa-status-panel__summary {
  display: grid;
  grid-template-columns: .625rem minmax(0, 1fr);
  gap: var(--wiki-space-2);
  align-items: start;
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-surface-sunken) 72%, transparent);
}

.pwa-status-panel__summary-dot {
  width: .625rem;
  height: .625rem;
  margin-block-start: .28rem;
}

.pwa-status-panel__summary strong {
  display: block;
  font-size: .875rem;
  font-weight: 700;
}

.pwa-status-panel__summary p,
.pwa-status-panel__note,
.pwa-status-panel__install p {
  margin: var(--wiki-space-1) 0 0;
  color: var(--wiki-text-muted);
  font-size: .75rem;
  line-height: 1.45;
}

.pwa-status-panel__facts {
  display: grid;
  gap: var(--wiki-space-2);
  margin: var(--wiki-space-3) 0;
}

.pwa-status-panel__facts > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--wiki-space-3);
}

.pwa-status-panel__facts dt {
  color: var(--wiki-text-muted);
  font-size: .75rem;
}

.pwa-status-panel__facts dd {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: .75rem;
  font-weight: 650;
  text-align: end;
}

.pwa-status-panel__value--success { color: rgb(var(--v-theme-success)) !important; }
.pwa-status-panel__value--warning { color: rgb(var(--v-theme-warning)) !important; }
.pwa-status-panel__value--error { color: rgb(var(--v-theme-error)) !important; }

.pwa-status-panel__alert {
  margin-block: var(--wiki-space-2);
  font-size: .75rem;
}

.pwa-status-panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  margin-block-start: var(--wiki-space-3);
}

.pwa-status-panel__actions :deep(.v-btn),
.pwa-status-panel__install :deep(.v-btn) {
  min-height: max(44px, var(--wiki-control-height, 44px));
  text-transform: none;
}

.pwa-status-panel__note {
  margin-block-start: var(--wiki-space-2);
}

.pwa-status-panel__install {
  margin-block-start: var(--wiki-space-3);
  padding-block-start: var(--wiki-space-3);
  border-block-start: 1px solid var(--wiki-surface-border);
}

.pwa-status-panel__install :deep(.v-btn) {
  margin-block-start: var(--wiki-space-2);
}

.pwa-status-panel__links {
  display: grid;
  gap: var(--wiki-space-2);
  margin-block-start: var(--wiki-space-3);
}

.pwa-status-panel__library {
  display: flex;
  min-height: max(44px, var(--wiki-control-height, 44px));
  align-items: center;
  gap: var(--wiki-space-2);
  margin-block-start: 0;
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 22%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  color: var(--wiki-accent-ink);
  font-size: .8125rem;
  font-weight: 650;
  text-decoration: none;
  transition: background-color var(--wiki-motion-fast) var(--wiki-motion-ease), border-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.pwa-status-panel__library span { flex: 1 1 auto; min-width: 0; }

.pwa-status-panel__chevron { color: var(--wiki-text-muted); }

[dir='rtl'] .pwa-status-panel__chevron { transform: scaleX(-1); }

.pwa-status-panel__library:hover,
.pwa-status-panel__library:focus-visible {
  border-color: color-mix(in srgb, var(--wiki-ambient-accent) 48%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--wiki-ambient-accent) 9%, transparent);
}

.pwa-status-panel__library:focus-visible {
  outline: var(--wiki-focus-ring);
  outline-offset: 2px;
}

@media (max-width: 599px) {
  .pwa-status-panel__body { padding: var(--wiki-space-3) !important; }
}

@media (forced-colors: active) {
  .pwa-status-panel,
  .pwa-status-panel__summary,
  .pwa-status-panel__library {
    border-color: CanvasText;
  }

  .pwa-status-panel__summary-dot { background: CanvasText; }
}

@media (prefers-reduced-motion: reduce) {
  .pwa-status-panel__library { transition-duration: .01ms; }
}
</style>
