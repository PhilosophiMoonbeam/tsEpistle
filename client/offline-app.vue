<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

type ConnectionState = 'checking' | 'online' | 'offline' | 'server-unavailable'
type InstallAvailability = 'unavailable' | 'available' | 'installed'
type InstallPromptEvent = Event & {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type StorageState = 'uninspected' | 'checking' | 'available' | 'unavailable'

const connectionState = ref<ConnectionState>('checking')
const connectionMessage = ref('Checking the connection without opening an account session.')
const searchQuery = ref('')
const installAvailability = ref<InstallAvailability>('unavailable')
const installPrompt = shallowRef<InstallPromptEvent | null>(null)
const installMessage = ref('Installation is optional and depends on the browser.')
const storageState = ref<StorageState>('uninspected')
const storageUsage = ref<number | null>(null)
const storageQuota = ref<number | null>(null)
const storagePersistent = ref<boolean | null>(null)
const storageMessage = ref('Storage has not been inspected.')
const isRetrying = ref(false)
const isInstalling = ref(false)
const isStandalone = ref(false)

const browserAvailable = typeof window !== 'undefined' && typeof navigator !== 'undefined'

const connectionLabel = computed(() => {
  const labels: Record<ConnectionState, string> = {
    checking: 'Checking connection',
    online: 'Connection available',
    offline: 'Waiting for a connection',
    'server-unavailable': 'Server unavailable'
  }
  return labels[connectionState.value]
})


const searchDetail = computed(() => {
  if (searchQuery.value.trim()) return 'No downloaded pages match this search in the empty local library.'
  return 'Search is bounded to pages saved on this device; it never claims server or Agent search parity.'
})

const installDetail = computed(() => {
  if (isStandalone.value || installAvailability.value === 'installed') return 'This app is already running in an installed window.'
  if (installAvailability.value === 'available') return 'Your browser exposed an install action. It is safe to dismiss it and continue in the browser.'
  if (browserAvailable && /iPad|iPhone|iPod/.test(navigator.userAgent)) return 'On iPhone or iPad, use Share, then Add to Home Screen. Availability varies by browser.'
  return 'Use your browser’s install or add-to-home-screen menu when it offers one. No prompt is promised.'
})

const storageDetail = computed(() => {
  if (storageState.value === 'checking') return 'Reading the browser estimate…'
  if (storageState.value === 'unavailable') return storageMessage.value
  if (storageUsage.value === null || storageQuota.value === null) return storageMessage.value
  const usage = formatBytes(storageUsage.value)
  const quota = formatBytes(storageQuota.value)
  return `${usage} used of an estimated ${quota}. This estimate includes browser-managed origin data.`
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

function standaloneDisplay(): boolean {
  if (!browserAvailable) return false
  const mediaStandalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean }
  return mediaStandalone || navigatorWithStandalone.standalone === true
}

async function probeConnection(): Promise<boolean> {
  connectionState.value = 'checking'
  connectionMessage.value = 'Checking the connection without opening an account session.'
  try {
    const response = await fetch(`/_offline?offline-probe=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'text/html' }
    })
    if (!response.ok) {
      connectionState.value = 'server-unavailable'
      connectionMessage.value = `The server answered with HTTP ${response.status}.`
      return false
    }
    connectionState.value = 'online'
    connectionMessage.value = 'The server answered without creating an account session.'
    return true
  } catch {
    connectionState.value = navigator.onLine ? 'server-unavailable' : 'offline'
    connectionMessage.value = navigator.onLine
      ? 'The network hint is positive, but the server could not be reached.'
      : 'The browser reports no network path. This shell remains neutral and local-only.'
    return false
  }
}

async function retryConnection(): Promise<void> {
  if (isRetrying.value) return
  isRetrying.value = true
  try {
    const connected = await probeConnection()
    if (connected && browserAvailable && window.location.pathname === '/_offline') window.location.assign('/')
  } finally {
    isRetrying.value = false
  }
}

async function inspectStorage(): Promise<void> {
  if (!browserAvailable || !navigator.storage?.estimate) {
    storageState.value = 'unavailable'
    storageMessage.value = 'This browser does not expose a storage estimate.'
    return
  }
  storageState.value = 'checking'
  storageMessage.value = 'Reading a browser-provided estimate; no local records are opened.'
  try {
    const estimate = await navigator.storage.estimate()
    storageUsage.value = typeof estimate.usage === 'number' ? estimate.usage : null
    storageQuota.value = typeof estimate.quota === 'number' ? estimate.quota : null
    storagePersistent.value = navigator.storage.persisted ? await navigator.storage.persisted() : null
    storageState.value = storageUsage.value === null || storageQuota.value === null ? 'unavailable' : 'available'
    storageMessage.value = storageState.value === 'available' ? 'Storage estimate updated.' : 'The browser did not provide a complete estimate.'
  } catch {
    storageState.value = 'unavailable'
    storageMessage.value = 'The browser declined the storage estimate. This is normal degradation.'
  }
}

async function installApplication(): Promise<void> {
  if (!installPrompt.value || isInstalling.value) return
  isInstalling.value = true
  try {
    await installPrompt.value.prompt()
    const choice = await installPrompt.value.userChoice
    installMessage.value = choice.outcome === 'accepted' ? 'Installation accepted by the browser.' : 'Installation dismissed; the browser remains available.'
    if (choice.outcome === 'accepted') installAvailability.value = 'installed'
  } catch {
    installMessage.value = 'The browser closed the install action. You can use its install menu later.'
  } finally {
    installPrompt.value = null
    isInstalling.value = false
  }
}

function captureInstallPrompt(event: Event): void {
  event.preventDefault()
  installPrompt.value = event as InstallPromptEvent
  installAvailability.value = 'available'
  installMessage.value = 'The browser exposed an optional install action.'
}

function markInstalled(): void {
  installPrompt.value = null
  installAvailability.value = 'installed'
  installMessage.value = 'The browser reports that this app is installed.'
}

function handleOnlineHint(): void {
  if (connectionState.value === 'offline' || connectionState.value === 'server-unavailable') void probeConnection()
}

function handleOfflineHint(): void {
  connectionState.value = 'offline'
  connectionMessage.value = 'The browser reports no network path. This shell remains neutral and local-only.'
}

onMounted(() => {
  isStandalone.value = standaloneDisplay()
  window.addEventListener('beforeinstallprompt', captureInstallPrompt)
  window.addEventListener('appinstalled', markInstalled)
  window.addEventListener('online', handleOnlineHint)
  window.addEventListener('offline', handleOfflineHint)
  void probeConnection()
})

onBeforeUnmount(() => {
  if (!browserAvailable) return
  window.removeEventListener('beforeinstallprompt', captureInstallPrompt)
  window.removeEventListener('appinstalled', markInstalled)
  window.removeEventListener('online', handleOnlineHint)
  window.removeEventListener('offline', handleOfflineHint)
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
      <div class="connection-status" :data-state="connectionState" role="status" aria-live="polite">
        <span class="status-dot" aria-hidden="true"></span>
        <span>{{ connectionLabel }}</span>
      </div>
    </header>

    <section class="intro" aria-describedby="offline-description">
      <p class="section-kicker">A quiet place between requests</p>
      <h1 id="offline-title">Keep your place when the signal drops.</h1>
      <p id="offline-description" class="intro-copy">
        This is a neutral offline shell. It can show pages deliberately downloaded on this device; it cannot sign you in,
        restore permissions, recover private content, or publish changes while disconnected.
      </p>
      <div class="intro-actions">
        <button class="primary-button" type="button" :disabled="isRetrying" @click="retryConnection">
          <span>{{ isRetrying ? 'Checking…' : 'Retry connection' }}</span>
        </button>
        <p class="connection-detail">{{ connectionMessage }}</p>
      </div>
    </section>

    <div class="notebook-grid">
      <section class="surface library-surface" aria-labelledby="downloaded-pages-title">
        <div class="surface-heading">
          <div>
            <p class="section-kicker">Local index <span aria-hidden="true">01</span></p>
            <h2 id="downloaded-pages-title">Downloaded pages</h2>
          </div>
          <span class="count-note">0 saved</span>
        </div>
        <div class="search-field">
          <label for="downloaded-pages-search">Downloaded pages</label>
          <input
            id="downloaded-pages-search"
            v-model="searchQuery"
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search this device"
            aria-describedby="downloaded-pages-search-detail"
          />
          <p id="downloaded-pages-search-detail" class="field-hint">{{ searchDetail }}</p>
        </div>
        <div class="empty-state" role="status" aria-live="polite">
          <span class="empty-rule" aria-hidden="true"></span>
          <h3>{{ searchQuery.trim() ? 'No matching pages yet' : 'Your local index is empty' }}</h3>
          <p>
            {{ searchQuery.trim() ? 'Try a different phrase after saving an eligible page.' : 'When you save an eligible public page, it will appear here with its revision and expiry.' }}
          </p>
          <small>Only explicit downloads are kept. Ordinary reader visits are never cached as offline pages.</small>
        </div>
      </section>

      <aside class="side-stack" aria-label="Offline capability notes">
        <section class="surface note-surface" aria-labelledby="drafts-title">
          <p class="section-kicker">Protected workspace <span aria-hidden="true">02</span></p>
          <h2 id="drafts-title">Locked drafts</h2>
          <p class="note-lead">Account-owned drafts stay opaque until the same account is verified online.</p>
          <p class="note-detail">No titles, routes, source text, or permissions are shown in this neutral shell.</p>
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
          <p v-if="storagePersistent !== null" class="field-hint">
            Persistent storage: {{ storagePersistent ? 'granted' : 'not granted' }}. Browser eviction remains possible.
          </p>
          <div class="utility-actions">
            <button class="secondary-button" type="button" @click="inspectStorage">
              {{ storageState === 'checking' ? 'Inspecting…' : 'Check storage' }}
            </button>
            <button class="text-button" type="button" disabled title="There is no loaded library to clear in this neutral shell.">
              Clear device data
            </button>
          </div>
          <p class="field-hint">Nothing is loaded into the shell itself; clearing becomes available from the library after it has data.</p>
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
          <button v-if="installAvailability === 'available'" class="secondary-button" type="button" :disabled="isInstalling" @click="installApplication">
            {{ isInstalling ? 'Opening install…' : 'Install tsEpistle' }}
          </button>
          <p class="field-hint">{{ installMessage }}</p>
        </section>
      </aside>
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
  --offline-faint: #72807b;
  --offline-accent: #1d6f69;
  --offline-accent-strong: #0e4f4b;
  --offline-warm: #c2683f;
  --offline-border: rgba(28, 40, 41, .16);
  --offline-border-strong: rgba(28, 40, 41, .32);
  --offline-focus: #b3482d;
  --offline-shadow: 0 1.25rem 3rem rgba(38, 48, 45, .1);
  --offline-shadow-small: 0 .35rem 1.1rem rgba(38, 48, 45, .08);
  --offline-radius: 1.2rem;
  --offline-mono: 'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace;
  --offline-body: 'Avenir Next', 'Segoe UI', sans-serif;
  --offline-heading: Georgia, 'Times New Roman', serif;
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
  width: min(100%, 88rem);
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0 auto;
  padding-block: max(1.35rem, env(safe-area-inset-top)) max(1.8rem, env(safe-area-inset-bottom));
  padding-inline: max(1.15rem, env(safe-area-inset-left)) max(1.15rem, env(safe-area-inset-right));
  overflow: hidden;
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
  max-width: 57rem;
  padding-block: clamp(3.8rem, 9vw, 7.2rem) clamp(3rem, 7vw, 5.5rem);
}

.intro .section-kicker {
  color: var(--offline-accent);
}

.intro h1 {
  max-width: 12ch;
  margin: .7rem 0 1.2rem;
  font-family: var(--offline-heading);
  font-size: clamp(3rem, 7.2vw, 6.6rem);
  font-weight: 500;
  letter-spacing: -.07em;
  line-height: .93;
  text-wrap: balance;
}

.intro-copy {
  max-width: 53rem;
  margin: 0;
  color: var(--offline-muted);
  font-size: clamp(1.02rem, 1.8vw, 1.3rem);
  line-height: 1.62;
  text-wrap: pretty;
}

.intro-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .85rem 1rem;
  align-items: center;
  margin-block-start: 2rem;
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
  min-height: 31rem;
  padding: clamp(1.25rem, 3.2vw, 2.35rem);
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
  outline: 0;
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
    padding-block-start: max(.8rem, env(safe-area-inset-top));
  }

  .intro {
    padding-block: 3.25rem 2.7rem;
  }

  .intro h1 {
    max-width: 10ch;
    font-size: clamp(2.75rem, 15vw, 4.2rem);
  }

  .intro-actions,
  .utility-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .primary-button,
  .secondary-button,
  .text-button {
    width: 100%;
  }

  .connection-detail {
    max-width: none;
  }

  .offline-footer {
    flex-direction: column;
    gap: .5rem;
  }

  .footer-mark {
    align-self: start;
    text-align: start;
  }
}

@media (orientation: landscape) and (max-height: 500px) {
  .intro {
    padding-block: 2.4rem 2rem;
  }

  .intro h1 {
    max-width: 16ch;
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
