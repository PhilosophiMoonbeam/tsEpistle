<template lang='pug'>
section.pwa-status-panel(
  role='region'
  :aria-label='panelLabel'
)
  .pwa-status-panel__body
    .pwa-status-panel__heading
      div
        p.pwa-status-panel__eyebrow Connection · shell · install
        h2 Offline app status
      v-icon(:icon='connectionPresentation.icon', :color='connectionPresentation.tone', size='22', aria-hidden='true')

    .pwa-status-panel__summary(role='status', aria-live='polite', aria-atomic='true')
      span.pwa-status-panel__summary-dot(:class='`pwa-status-panel__summary-dot--${connectionPresentation.tone}`', aria-hidden='true')
      div
        strong {{ summaryLabel }}
        p {{ summaryDescription }}

    dl.pwa-status-panel__facts
      div
        dt Network hint
        dd(:class='`pwa-status-panel__value--${networkHintTone}`') {{ networkHintLabel }}
      div
        dt Server
        dd(:class='`pwa-status-panel__value--${serverStatusTone}`') {{ serverStatusLabel }}
      div
        dt Offline app shell
        dd {{ offlineShellLabel }}

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
      strong Update error.
      |  {{ pwaState.updateError }}
    v-alert.pwa-status-panel__alert(
      v-if='pwaState.installError'
      type='error'
      variant='tonal'
      density='compact'
      role='alert'
    )
      strong Install error.
      |  {{ pwaState.installError }}

    .pwa-status-panel__actions
      v-btn(
        variant='outlined'
        prepend-icon='mdi-refresh'
        :loading='isRetrying'
        :disabled='isRetrying'
        @click='retryConnection'
      ) {{ isRetrying ? `Checking…` : `Check the server` }}
      v-btn(
        v-if='pwaState.updateReady'
        color='primary'
        variant='tonal'
        prepend-icon='mdi-update'
        :loading='isUpdating'
        :disabled='isUpdating || pwaState.reloadSafe === false'
        @click='applyUpdate'
      ) {{ isUpdating ? `Applying…` : `Apply app update` }}

    p.pwa-status-panel__note(v-if='pwaState.updateReady && pwaState.reloadSafe === false', role='status')
      | Update ready. It will wait until the app reports a safe reload point.
    p.pwa-status-panel__note(v-else-if='pwaState.updateReady', role='status')
      | Update ready. The app checks reload safety before activation; no changes are replayed automatically.
    p.pwa-status-panel__note(v-else-if='pwaState.reloadNeeded', role='status')
      | A newer app shell is active. Reload is deferred until it is safe for this page.
    p.pwa-status-panel__note(v-else-if='pwaState.updateState === `checking` || pwaState.updateState === `activating`', role='status')
      | Checking the app update without interrupting this page.

    section.pwa-status-panel__install(
      v-if='showInstallSection'
      aria-labelledby='pwa-status-install-title'
    )
      h3#pwa-status-install-title Install availability
      p(v-if='pwaState.isStandalone') This page is running in a standalone window. It may be an installed app or a manually added shortcut.
      p(v-else-if='installCompleted') Installation completed. Open tsEpistle from your app launcher to use its standalone window.
      template(v-else-if='canInstall')
        p Your browser exposed an optional install action.
        v-btn(
          color='primary'
          variant='tonal'
          prepend-icon='mdi-download-outline'
          :loading='isInstalling'
          :disabled='isInstalling'
          @click='installApplication'
        ) {{ isInstalling ? `Opening…` : `Install tsEpistle` }}
      p(v-else-if='manualInstallGuidance')
        | No native prompt was exposed. If this browser offers it, use Share or its browser menu and choose Add to Home Screen.
      p(v-else) Installation is not available in this browser right now. Availability depends on browser and platform support.

    .pwa-status-panel__links
      a.pwa-status-panel__library(href='/_offline#offline-policy-title')
        v-icon(icon='mdi-tune-variant', size='18', aria-hidden='true')
        span Manage automatic saving
        v-icon(icon='mdi-arrow-top-right', size='16', aria-hidden='true')
      a.pwa-status-panel__library(href='/_offline')
        v-icon(icon='mdi-book-open-page-variant-outline', size='18', aria-hidden='true')
        span Saved pages
        v-icon(icon='mdi-arrow-top-right', size='16', aria-hidden='true')
</template>

<script setup lang='ts'>
import { computed, ref } from 'vue'
import { pwaConnectionPresentation, pwaState, promptPwaInstall, requestPwaUpdate, retryServerConnection } from '../../helpers/pwa'

const isRetrying = ref(false)
const isInstalling = ref(false)
const isUpdating = ref(false)

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

const networkHintTone = computed<'success' | 'warning' | 'error'>(() => {
  if (pwaState.onlineHint === true) return 'warning'
  if (pwaState.onlineHint === false) return 'error'
  return 'warning'
})

const serverStatusLabel = computed(() => {
  if (pwaState.connection === 'checking') return 'Checking directly'
  if (pwaState.serverHealthy === true) return 'Verified available'
  if (pwaState.serverReachable === true) return 'Responded, but unavailable'
  if (pwaState.serverReachable === false) return 'Unavailable'
  return 'Not verified'
})

const serverStatusTone = computed<'success' | 'warning' | 'error'>(() => {
  if (pwaState.connection === 'online' && pwaState.serverHealthy === true) return 'success'
  if (pwaState.connection === 'server-unavailable' || pwaState.serverReachable === false || pwaState.serverHealthy === false) return 'error'
  return 'warning'
})

const offlineShellLabel = computed(() => {
  if (pwaState.offlineReady) return pwaState.controlled ? 'Ready and active' : 'Ready after warm-up'
  if (pwaState.registrationState === 'unsupported') return 'Not supported by this browser'
  if (pwaState.registrationState === 'error') return 'Registration failed'
  return 'Not ready yet'
})

const summaryDescription = computed(() => {
  if (pwaState.connection === 'checking') return 'Checking the server directly; a network hint alone is not proof.'
  if (pwaState.connection === 'offline') return 'The browser reports no network path. Server availability is not inferred from that hint.'
  if (pwaState.connection === 'server-unavailable') return 'The server could not be reached or did not pass its health check.'
  if (pwaState.connection === 'online' && pwaState.serverReachable === true && pwaState.serverHealthy === true) {
    return 'A direct request verified the server. The browser network hint is shown separately.'
  }
  return 'The server has not been verified yet.'
})

const panelLabel = computed(() => `Offline app and connection status: ${connectionPresentation.value.label}`)
const networkHintLabel = computed(() => {
  if (pwaState.onlineHint === true) return 'Network path reported'
  if (pwaState.onlineHint === false) return 'No network path reported'
  return 'Network status unavailable'
})

const summaryLabel = computed(() => connectionPresentation.value.label)

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
  if (!pwaState.updateReady || pwaState.reloadSafe === false || isUpdating.value) return
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
  box-shadow: var(--wiki-shadow-md) !important;
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
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 56%, transparent);
  font-size: .6875rem;
  font-weight: 700;
  letter-spacing: .09em;
  line-height: 1.2;
  text-transform: uppercase;
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
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
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
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
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
