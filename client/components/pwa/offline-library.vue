<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { OfflinePageSnapshotV1, OfflineSearchDocumentV1, OfflineSnapshotRecord } from '../../../shared/offline.ts'
import type { OfflineStorage } from '../../helpers/offline-storage.ts'
import { searchOfflineDocumentsAsync, type OfflineSearchResult } from '../../helpers/offline-search.ts'
import { renderOfflineHtmlFragment } from '../../helpers/offline-renderer.ts'

type OfflinePageSelector = {
  readonly siteId: string
  readonly pageId: number
  readonly locale: string
}

const props = defineProps<{
  storage: OfflineStorage | null
  storageState: string
  storageMessage?: string
  refreshToken?: number
  requestedSelector?: OfflinePageSelector | null
}>()

const emit = defineEmits<{
  changed: []
  error: [message: string]
  'retry-storage': []
}>()

const OFFLINE_DOCUMENT_PATH = '/_offline'
const OFFLINE_LOCALE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,34}$/u

const records = shallowRef<OfflineSnapshotRecord[]>([])
const searchQuery = ref('')
const searchResults = shallowRef<OfflineSearchResult[]>([])
const selectedKey = ref<string | null>(null)
const selectedHeading = ref<HTMLElement | null>(null)
const renderTarget = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const readerOpener = ref<HTMLElement | null>(null)
const readerOpenerKey = ref<string | null>(null)
const requestedSelectorConsumed = ref<string | null>(null)
const loading = ref(false)
const searching = ref(false)
const removingKey = ref<string | null>(null)
const loadError = ref('')
const renderError = ref('')
const clock = ref(Date.now())
const shareStatus = ref('')
const sharing = ref(false)
let loadToken = 0
let searchController: AbortController | null = null
let clockTimer: number | undefined

const currentOrigin = (): string | null => typeof window === 'undefined' ? null : window.location.origin

const isOfflineLocale = (value: string): boolean => OFFLINE_LOCALE_PATTERN.test(value)

const recordKey = (record: Pick<OfflineSnapshotRecord, 'siteId' | 'pageId' | 'locale'>): string =>
  `${record.siteId}\u0000${record.pageId}\u0000${record.locale}`

const recordDomKey = (record: Pick<OfflineSnapshotRecord, 'siteId' | 'pageId' | 'locale'>): string =>
  encodeURIComponent(recordKey(record))

const isExpired = (record: OfflineSnapshotRecord, at = clock.value): boolean => {
  if (!record.snapshot.expiresAt) return false
  const expiry = Date.parse(record.snapshot.expiresAt)
  return Number.isFinite(expiry) && expiry <= at
}

const isExpiringSoon = (record: OfflineSnapshotRecord, at = clock.value): boolean => {
  if (!record.snapshot.expiresAt || isExpired(record, at)) return false
  const expiry = Date.parse(record.snapshot.expiresAt)
  return Number.isFinite(expiry) && expiry - at <= 7 * 24 * 60 * 60 * 1000
}

const isValidSnapshotRecord = (record: OfflineSnapshotRecord, origin: string): boolean =>
  record.siteId === origin &&
  record.pageId === record.snapshot.pageId &&
  record.locale === record.snapshot.locale &&
  Number.isSafeInteger(record.pageId) &&
  record.pageId > 0 &&
  isOfflineLocale(record.locale)

const isValidSelector = (selector: OfflinePageSelector, origin: string): boolean =>
  selector.siteId === origin &&
  Number.isSafeInteger(selector.pageId) &&
  selector.pageId > 0 &&
  isOfflineLocale(selector.locale)

const offlineSelectorUrl = (selector: OfflinePageSelector): string | null => {
  const origin = currentOrigin()
  if (!origin || !isValidSelector(selector, origin)) return null
  const url = new URL(OFFLINE_DOCUMENT_PATH, origin)
  url.searchParams.set('site', origin)
  url.searchParams.set('pageId', String(selector.pageId))
  url.searchParams.set('locale', selector.locale)
  return url.href
}

const requestedSelectorKey = computed(() => {
  const selector = props.requestedSelector
  return selector ? recordKey(selector) : null
})

const activeRecords = computed(() => records.value.filter(record => !isExpired(record)))
const selectedRecord = computed(() => activeRecords.value.find(record => recordKey(record) === selectedKey.value) ?? null)
const selectedSnapshot = computed<OfflinePageSnapshotV1 | null>(() => selectedRecord.value?.snapshot ?? null)
const selectedOfflineUrl = computed(() => {
  const record = selectedRecord.value
  return record ? offlineSelectorUrl({ siteId: record.siteId, pageId: record.pageId, locale: record.locale }) ?? '' : ''
})
const selectedOfflineText = computed(() => {
  const snapshot = selectedSnapshot.value
  if (!snapshot) return ''
  return (snapshot.description.trim() || snapshot.searchText.trim()).replace(/\s+/gu, ' ').slice(0, 320)
})
const canUseNativeShare = computed(() => {
  if (!selectedSnapshot.value || !selectedOfflineUrl.value || typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false
  const payload = {
    title: selectedSnapshot.value.title || 'Untitled page',
    text: `${selectedOfflineText.value}\n\nThis is a local copy saved on this device.`.trim(),
    url: selectedOfflineUrl.value
  }
  return typeof navigator.canShare !== 'function' || navigator.canShare(payload)
})

const copyToClipboard = async (value: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const input = document.createElement('textarea')
  input.value = value
  input.readOnly = true
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Copy is unavailable.')
  } finally {
    input.remove()
  }
}

const shareSelected = async (): Promise<void> => {
  const snapshot = selectedSnapshot.value
  const url = selectedOfflineUrl.value
  if (!snapshot || !url || typeof navigator.share !== 'function' || sharing.value) return
  sharing.value = true
  shareStatus.value = ''
  try {
    await navigator.share({
      title: snapshot.title || 'Untitled page',
      text: `${selectedOfflineText.value}\n\nThis is a local copy saved on this device.`.trim(),
      url
    })
    shareStatus.value = 'Saved copy shared.'
  } catch (error) {
    if (!(error && typeof error === 'object' && Reflect.get(error, 'name') === 'AbortError')) {
      shareStatus.value = 'Sharing is unavailable. Copy the local link or page text instead.'
    }
  } finally {
    sharing.value = false
  }
}

const copySelectedLink = async (): Promise<void> => {
  try {
    await copyToClipboard(selectedOfflineUrl.value)
    shareStatus.value = 'Local link copied.'
  } catch {
    shareStatus.value = 'The local link could not be copied.'
  }
}

const copySelectedText = async (): Promise<void> => {
  const snapshot = selectedSnapshot.value
  if (!snapshot) return
  try {
    const text = [snapshot.title, selectedOfflineText.value, 'This is a local copy saved on this device.'].filter(Boolean).join('\n\n')
    await copyToClipboard(text)
    shareStatus.value = 'Page text copied.'
  } catch {
    shareStatus.value = 'The page text could not be copied.'
  }
}
const resultRecords = computed(() => {
  const byKey = new Map(activeRecords.value.map(record => [recordKey(record), record]))
  if (!searchQuery.value.trim()) return activeRecords.value
  return searchResults.value
    .map(result => byKey.get(recordKey(result.document)))
    .filter((record): record is OfflineSnapshotRecord => record !== undefined && !isExpired(record))
})

const searchDetail = computed(() => {
  const count = activeRecords.value.length
  if (searching.value) return `Searching ${count} downloaded pages.`
  if (searchQuery.value.trim()) {
    return resultRecords.value.length === 0
      ? `No downloaded pages match “${searchQuery.value.trim().slice(0, 120)}”.`
      : `${resultRecords.value.length} matching page${resultRecords.value.length === 1 ? '' : 's'} in ${count} downloaded pages.`
  }
  return `${count} downloaded page${count === 1 ? '' : 's'} on this device. Search never includes server or Agent results.`
})

const libraryMessage = computed(() => {
  if (loading.value) return 'Reading guest snapshots from this device…'
  if (loadError.value) return loadError.value
  if (props.storageState !== 'available') return props.storageMessage ?? 'Offline storage is unavailable; no local pages were opened.'
  if (!activeRecords.value.length) return 'When you save an eligible public page, it will appear here with its revision and expiry.'
  if (searchQuery.value.trim() && !resultRecords.value.length) return 'Try a different phrase after saving an eligible guest-readable page.'
  return ''
})

const storageUnavailable = computed(() => !props.storage || props.storageState !== 'available')

const normalizeError = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

const toSearchDocument = (record: OfflineSnapshotRecord): OfflineSearchDocumentV1 => ({
  schemaVersion: record.snapshot.schemaVersion,
  siteId: record.siteId,
  pageId: record.snapshot.pageId,
  locale: record.snapshot.locale,
  path: record.snapshot.path,
  canonicalPath: record.snapshot.canonicalPath,
  title: record.snapshot.title,
  description: record.snapshot.description,
  searchText: record.snapshot.searchText,
  capturedAt: record.snapshot.capturedAt,
  byteSize: record.byteSize
})


const runSearch = async (): Promise<void> => {
  searchController?.abort()
  searchController = null
  const query = searchQuery.value.trim()
  if (!query) {
    searchResults.value = []
    searching.value = false
    return
  }
  const controller = new AbortController()
  searchController = controller
  searching.value = true
  try {
    const documents = activeRecords.value.map(toSearchDocument)
    const ranked = await searchOfflineDocumentsAsync(documents, query, { signal: controller.signal, limit: 50 })
    if (controller.signal.aborted || searchController !== controller) return
    searchResults.value = ranked
  } catch (error) {
    if (controller.signal.aborted || searchController !== controller) return
    searchResults.value = []
    emit('error', normalizeError(error, 'Downloaded-page search could not be completed.'))
  } finally {
    if (searchController === controller) {
      searchController = null
      searching.value = false
    }
  }
}

const rememberReaderOpener = (record: OfflineSnapshotRecord, event?: MouseEvent): void => {
  const currentTarget = event?.currentTarget
  readerOpenerKey.value = recordKey(record)
  readerOpener.value = currentTarget instanceof HTMLElement ? currentTarget : null
}

let focusRestoreToken = 0
const restoreReaderFocus = async (key: string | null, opener: HTMLElement | null): Promise<void> => {
  if (!key && !opener) return
  const token = ++focusRestoreToken
  await nextTick()
  if (token !== focusRestoreToken) return
  const fallback = key
    ? document.querySelector<HTMLElement>(`[data-offline-record-key="${encodeURIComponent(key)}"]`)
    : null
  const target = opener?.isConnected ? opener : fallback?.isConnected ? fallback : searchInput.value
  target?.focus({ preventScroll: true })
}

const clearOfflineSelector = (): void => {
  if (typeof window === 'undefined' || window.location.pathname !== OFFLINE_DOCUMENT_PATH) return
  const url = new URL(window.location.href)
  for (const key of ['site', 'pageId', 'locale']) url.searchParams.delete(key)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

const loadRecords = async (): Promise<void> => {
  const storage = props.storage
  const token = ++loadToken
  searchController?.abort()
  searchController = null
  searchResults.value = []
  if (!storage || props.storageState !== 'available') {
    if (selectedKey.value) closeRecord()
    records.value = []
    selectedKey.value = null
    loadError.value = ''
    loading.value = false
    return
  }
  const origin = currentOrigin()
  if (!origin) {
    records.value = []
    selectedKey.value = null
    loadError.value = 'The current site identity is unavailable; local pages cannot be opened safely.'
    loading.value = false
    return
  }
  const selector = props.requestedSelector
  if (selector && !isValidSelector(selector, origin)) {
    if (selectedKey.value) closeRecord()
    records.value = []
    selectedKey.value = null
    loadError.value = 'The requested local page selector is invalid or belongs to another site.'
    emit('error', loadError.value)
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const expectedSessionGeneration = await storage.currentSessionGeneration()
    const loaded = await storage.listSnapshots(origin, { expectedSessionGeneration })
    if (token !== loadToken) return
    const cleanup = new Map<string, { siteId: string; pageId: number; locale: string }>()
    const validRecords: OfflineSnapshotRecord[] = []
    for (const record of loaded) {
      const key = recordKey({ siteId: origin, pageId: record.pageId, locale: record.locale })
      if (!isValidSnapshotRecord(record, origin) || isExpired(record)) {
        cleanup.set(key, { siteId: origin, pageId: record.pageId, locale: record.locale })
        continue
      }
      validRecords.push(record)
    }
    for (const candidate of cleanup.values()) {
      if (token !== loadToken) return
      await storage.removeSnapshot(candidate.siteId, candidate.pageId, candidate.locale, { expectedSessionGeneration })
    }
    const currentSessionGeneration = await storage.currentSessionGeneration()
    if (currentSessionGeneration !== expectedSessionGeneration) throw new Error('Downloaded pages belong to an obsolete session.')
    if (token !== loadToken) return
    records.value = validRecords
      .filter(record => !isExpired(record))
      .sort((left, right) => {
        const capturedOrder = right.snapshot.capturedAt.localeCompare(left.snapshot.capturedAt)
        if (capturedOrder !== 0) return capturedOrder
        const titleOrder = left.snapshot.title.localeCompare(right.snapshot.title)
        if (titleOrder !== 0) return titleOrder
        return recordKey(left).localeCompare(recordKey(right))
      })
    if (selectedKey.value && !records.value.some(record => recordKey(record) === selectedKey.value)) closeRecord()
    if (cleanup.size) emit('changed')
    await runSearch()
    const selectorKey = requestedSelectorKey.value
    if (selector && selectorKey && requestedSelectorConsumed.value !== selectorKey) {
      requestedSelectorConsumed.value = selectorKey
      const selected = records.value.find(record => recordKey(record) === selectorKey)
      if (!selected) {
        emit('error', 'The requested downloaded page is no longer available on this device.')
        return
      }
      await openRecord(selected)
    }
  } catch (error) {
    if (token !== loadToken) return
    if (selectedKey.value) closeRecord()
    records.value = []
    selectedKey.value = null
    loadError.value = normalizeError(error, 'Downloaded pages could not be read from this device.')
    emit('error', loadError.value)
  } finally {
    if (token === loadToken) loading.value = false
  }
}

const openRecord = async (record: OfflineSnapshotRecord, event?: MouseEvent): Promise<void> => {
  const key = recordKey(record)
  rememberReaderOpener(record, event)
  const origin = currentOrigin()
  if (!origin || !isValidSnapshotRecord(record, origin)) {
    closeRecord()
    emit('error', 'This downloaded page record is invalid and cannot be opened.')
    return
  }
  if (isExpired(record)) {
    closeRecord()
    emit('error', 'This snapshot has reached its known publication expiry and cannot be opened offline.')
    void loadRecords()
    return
  }
  selectedKey.value = key
  renderError.value = ''
  await nextTick()
  const target = renderTarget.value
  if (!target || selectedKey.value !== key) return
  try {
    await renderOfflineHtmlFragment(target, record.snapshot)
    await nextTick()
    selectedHeading.value?.focus()
    if (requestedSelectorKey.value === key) {
      requestedSelectorConsumed.value = key
      clearOfflineSelector()
    }
  } catch (error) {
    target.replaceChildren()
    renderError.value = normalizeError(error, 'This downloaded page failed its integrity or safety checks.')
    emit('error', renderError.value)
  }
}

const closeRecord = (): void => {
  const key = readerOpenerKey.value ?? selectedKey.value
  const opener = readerOpener.value
  selectedKey.value = null
  renderError.value = ''
  readerOpener.value = null
  readerOpenerKey.value = null
  void restoreReaderFocus(key, opener)
}

watch(clock, () => {
  const selected = selectedKey.value ? records.value.find(record => recordKey(record) === selectedKey.value) : null
  if (selected && isExpired(selected)) closeRecord()
  if (records.value.some(record => isExpired(record))) void loadRecords()
})

const removeRecord = async (record: OfflineSnapshotRecord): Promise<void> => {
  const storage = props.storage
  if (!storage || removingKey.value) return
  const key = recordKey(record)
  removingKey.value = key
  try {
    const expectedSessionGeneration = await storage.currentSessionGeneration()
    await storage.removeSnapshot(record.siteId, record.pageId, record.locale, { expectedSessionGeneration })
    records.value = records.value.filter(candidate => recordKey(candidate) !== key)
    if (selectedKey.value === key) closeRecord()
    emit('changed')
    await runSearch()
  } catch (error) {
    emit('error', normalizeError(error, 'The downloaded page could not be removed.'))
  } finally {
    if (removingKey.value === key) removingKey.value = null
  }
}

const retryStorage = (): void => emit('retry-storage')

const formatBytes = (value: number): string => {
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

const formatDate = (value: string): string => {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.valueOf())) return 'date unavailable'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(parsed)
}

const expiryLabel = (record: OfflineSnapshotRecord): string => {
  if (!record.snapshot.expiresAt) return 'No known expiry'
  const expiry = Date.parse(record.snapshot.expiresAt)
  if (!Number.isFinite(expiry) || expiry <= clock.value) return 'Expiry unavailable'
  return `Expires ${formatDate(record.snapshot.expiresAt)}`
}

watch(
  () => [props.storage, props.storageState, props.refreshToken, requestedSelectorKey.value],
  () => {
    void loadRecords()
  }
)
watch(requestedSelectorKey, (value, previous) => {
  if (value !== previous) requestedSelectorConsumed.value = null
})
watch(searchQuery, () => {
  void runSearch()
})

onMounted(() => {
  clockTimer = window.setInterval(() => {
    clock.value = Date.now()
  }, 60_000)
  void loadRecords()
})

onBeforeUnmount(() => {
  loadToken += 1
  searchController?.abort()
  if (clockTimer !== undefined) window.clearInterval(clockTimer)
})

</script>
<template>
  <section class="offline-library" aria-labelledby="downloaded-pages-title">
    <div class="library-heading">
      <div>
        <p class="section-kicker">Local index <span aria-hidden="true">01</span></p>
        <h2 id="downloaded-pages-title">Downloaded pages</h2>
      </div>
      <span class="count-note" aria-label="Downloaded page count">{{ activeRecords.length }} stored</span>
    </div>

    <p class="scope-note">Guest-readable snapshots only · saved deliberately on this device · no account or private content.</p>

    <div class="search-field">
      <label for="downloaded-pages-search">Downloaded pages</label>
      <input
        id="downloaded-pages-search"
        ref="searchInput"
        v-model="searchQuery"
        type="search"
        autocomplete="off"
        spellcheck="false"
        placeholder="Search this device"
        aria-describedby="downloaded-pages-search-detail"
      />
      <p id="downloaded-pages-search-detail" class="field-hint" role="status" aria-live="polite">{{ searchDetail }}</p>
    </div>

    <div v-if="storageUnavailable" class="library-message" role="status" aria-live="polite">
      <span class="empty-rule" aria-hidden="true"></span>
      <h3>Local pages are unavailable</h3>
      <p>{{ libraryMessage }}</p>
      <button class="secondary-button" type="button" @click="retryStorage">Retry local storage</button>
    </div>

    <div v-else-if="loading" class="library-message" role="status" aria-live="polite">
      <span class="loading-mark" aria-hidden="true">…</span>
      <h3>Opening the field notebook</h3>
      <p>{{ libraryMessage }}</p>
    </div>

    <div v-else-if="loadError" class="library-message is-error" role="alert">
      <span class="empty-rule" aria-hidden="true"></span>
      <h3>Downloaded pages could not be read</h3>
      <p>{{ libraryMessage }}</p>
      <button class="secondary-button" type="button" @click="retryStorage">Retry local storage</button>
    </div>

    <div v-else-if="!resultRecords.length" class="library-message" role="status" aria-live="polite">
      <span class="empty-rule" aria-hidden="true"></span>
      <h3>{{ searchQuery.trim() ? 'No matching pages yet' : 'Your local index is empty' }}</h3>
      <p>{{ libraryMessage }}</p>
      <small>Only explicit downloads are kept. Ordinary reader visits are never cached as offline pages.</small>
    </div>

    <ol v-else class="page-list" aria-label="Downloaded guest pages">
      <li v-for="record in resultRecords" :key="recordKey(record)" class="page-list-item">
        <article class="page-card" :data-selected="selectedKey === recordKey(record)">
          <button
            :data-offline-record-key="recordDomKey(record)"
            class="page-card-main"
            type="button"
            :aria-current="selectedKey === recordKey(record) ? 'page' : undefined"
            :aria-label="`Open downloaded page ${record.snapshot.title}`"
            @click="openRecord(record, $event)"
          >
            <span class="page-card-kicker">{{ record.snapshot.locale }} <span aria-hidden="true">/</span> {{ formatBytes(record.byteSize) }}</span>
            <strong class="page-card-title">{{ record.snapshot.title || 'Untitled page' }}</strong>
            <span v-if="record.snapshot.description" class="page-card-description">{{ record.snapshot.description }}</span>
            <span class="page-card-meta">
              <span>{{ `Captured ${formatDate(record.snapshot.capturedAt)}` }}</span>
              <span>{{ `Revision ${record.snapshot.sourceRevision}` }}</span>
            </span>
            <span class="page-card-expiry" :data-expiring="isExpiringSoon(record) ? 'soon' : 'current'">
              {{ expiryLabel(record) }}
            </span>
          </button>
          <div class="page-card-actions">
            <button class="secondary-button" type="button" :data-offline-record-key="recordDomKey(record)" @click="openRecord(record, $event)">Open page</button>
            <button class="text-button" type="button" :disabled="removingKey === recordKey(record)" @click="removeRecord(record)">
              {{ removingKey === recordKey(record) ? 'Removing…' : 'Remove' }}
            </button>
          </div>
        </article>
      </li>
    </ol>
    <article v-if="selectedRecord && selectedSnapshot" class="offline-reader" aria-labelledby="offline-reader-title">
      <div class="reader-heading">
        <div>
          <p class="section-kicker">Local reading copy <span aria-hidden="true">02</span></p>
          <h3 id="offline-reader-title" ref="selectedHeading" tabindex="-1">{{ selectedSnapshot.title || 'Untitled page' }}</h3>
        </div>
        <div class="reader-actions">
          <button v-if="canUseNativeShare" class="text-button" type="button" :disabled="sharing" @click="shareSelected">
            {{ sharing ? 'Sharing…' : 'Share' }}
          </button>
          <button class="text-button" type="button" @click="copySelectedLink">Copy local link</button>
          <button class="text-button" type="button" @click="copySelectedText">Copy page text</button>
          <span class="sr-only" role="status" aria-live="polite">{{ shareStatus }}</span>
          <button class="text-button" type="button" @click="closeRecord">Close page</button>
        </div>
      </div>
      <p v-if="selectedSnapshot.description" class="reader-description">{{ selectedSnapshot.description }}</p>
      <p class="reader-meta">
        {{ selectedSnapshot.locale }} · {{ selectedSnapshot.path }} · Revision {{ selectedSnapshot.sourceRevision }} · {{ expiryLabel(selectedRecord) }}
      </p>
      <div ref="renderTarget" class="offline-page-body" aria-label="Downloaded page content"></div>
      <p v-if="renderError" class="reader-error" role="alert">{{ renderError }}</p>
      <p class="reader-footnote">This is a guest snapshot captured on this device. Links navigate only after an explicit click; server-only tools remain unavailable here.</p>
    </article>
  </section>
</template>

<style scoped>
.offline-library {
  min-width: 0;
}

.library-heading,
.reader-heading {
  display: flex;
  gap: 1rem;
  align-items: start;
  justify-content: space-between;
  padding-block-end: 1.1rem;
  border-block-end: 1px solid var(--offline-border);
}

.reader-actions {
  display: flex;
  align-items: center;
  gap: .45rem;
  flex-shrink: 0;
}

.offline-library h2,
.offline-library h3 {
  margin: .35rem 0 0;
  font-family: var(--offline-heading);
  font-weight: 500;
  letter-spacing: -.055em;
  line-height: 1;
}

.offline-library h2 {
  font-size: clamp(1.7rem, 3vw, 2.55rem);
}

.offline-library h3 {
  font-size: clamp(1.45rem, 3vw, 2.15rem);
}

.count-note {
  padding-block-start: .35rem;
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .7rem;
  white-space: nowrap;
}

.scope-note {
  margin: 1rem 0 0;
  color: var(--offline-muted);
  font-family: var(--offline-mono);
  font-size: .7rem;
  line-height: 1.55;
}

.search-field {
  display: grid;
  gap: .55rem;
  max-width: 38rem;
  margin-block: 1.35rem 1rem;
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

.library-message {
  display: grid;
  min-height: 15rem;
  align-content: center;
  justify-items: start;
  gap: .7rem;
  margin-block-start: 1rem;
  padding: clamp(1.4rem, 4vw, 2.25rem);
  border: 1px dashed var(--offline-border-strong);
  border-radius: .8rem;
  background: var(--offline-paper-sunken);
}

.library-message.is-error,
.reader-error {
  border-color: color-mix(in srgb, var(--offline-warm) 65%, var(--offline-border));
}

.library-message p,
.library-message small {
  max-width: 34rem;
  margin: 0;
  color: var(--offline-muted);
  line-height: 1.6;
}

.library-message small {
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .69rem;
}

.empty-rule {
  width: 3.5rem;
  height: .2rem;
  margin-block-end: .4rem;
  background: var(--offline-warm);
}

.loading-mark {
  color: var(--offline-accent);
  font-family: var(--offline-mono);
  font-size: 1.5rem;
  line-height: 1;
}

.page-list {
  display: grid;
  gap: .7rem;
  margin: 1rem 0 0;
  padding: 0;
  list-style: none;
}

.page-card {
  display: grid;
  gap: .75rem;
  padding: 1rem;
  border: 1px solid var(--offline-border);
  border-radius: .8rem;
  background: color-mix(in srgb, var(--offline-paper-raised) 88%, transparent);
  transition: border-color .18s ease, background-color .18s ease;
}

.page-card[data-selected='true'] {
  border-color: var(--offline-accent);
  background: color-mix(in srgb, var(--offline-accent) 8%, var(--offline-paper-raised));
}

.page-card-main {
  display: grid;
  gap: .4rem;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: start;
  cursor: pointer;
}

.page-card-kicker,
.page-card-meta,
.page-card-expiry {
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .68rem;
  line-height: 1.45;
}

.page-card-title {
  overflow: hidden;
  color: var(--offline-ink);
  font-family: var(--offline-heading);
  font-size: 1.3rem;
  font-weight: 600;
  letter-spacing: -.025em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-card-description {
  display: -webkit-box;
  overflow: hidden;
  color: var(--offline-muted);
  font-size: .84rem;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.page-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: .35rem .8rem;
}

.page-card-expiry[data-expiring='soon'] {
  color: var(--offline-warm);
}

.page-card-expiry[data-expiring='expired'] {
  color: var(--offline-warm);
  font-weight: 700;
}

.page-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .55rem .85rem;
  align-items: center;
}

.primary-button,
.secondary-button,
.text-button {
  min-block-size: 2.75rem;
  cursor: pointer;
  font-weight: 700;
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
  border: 0;
  background: transparent;
  color: var(--offline-muted);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 42%, transparent);
  text-underline-offset: .2em;
}

.offline-reader {
  margin-block-start: 1.4rem;
  padding: clamp(1.1rem, 3vw, 2rem);
  border: 1px solid var(--offline-border-strong);
  border-radius: .9rem;
  background: var(--offline-paper-raised);
}

.reader-heading {
  padding-block-end: .85rem;
}

.reader-heading h3 {
  max-width: 30ch;
}

.reader-description {
  margin: 1rem 0 0;
  color: var(--offline-muted);
  font-size: .95rem;
  line-height: 1.6;
}

.reader-meta,
.reader-footnote,
.reader-error {
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .68rem;
  line-height: 1.55;
}

.reader-meta {
  margin: .85rem 0 0;
}

.offline-page-body {
  margin-block: 1.35rem;
  color: var(--offline-ink);
  font-family: var(--offline-body);
  font-size: 1rem;
  line-height: 1.72;
}

.offline-page-body :where(p, ul, ol, blockquote, pre, dl, table) {
  margin-block: 0 1rem;
}

.offline-page-body :where(h1, h2, h3, h4, h5, h6) {
  margin-block: 1.5rem .65rem;
  font-family: var(--offline-heading);
  font-weight: 600;
  letter-spacing: -.03em;
  line-height: 1.15;
}

.offline-page-body :where(a) {
  color: var(--offline-accent-strong);
  text-decoration-thickness: .08em;
  text-underline-offset: .15em;
}

.offline-page-body :where(pre, code) {
  font-family: var(--offline-mono);
  font-size: .9em;
}

.offline-page-body :where(pre) {
  overflow: auto;
  padding: .85rem;
  border: 1px solid var(--offline-border);
  border-radius: .5rem;
  background: var(--offline-paper-sunken);
  white-space: pre-wrap;
}

.offline-page-body :where(blockquote) {
  margin-inline: 0;
  padding-inline-start: 1rem;
  border-inline-start: .2rem solid var(--offline-warm);
  color: var(--offline-muted);
}

.offline-page-body :where(table) {
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
}

.offline-page-body :where(th, td) {
  padding: .4rem .6rem;
  border: 1px solid var(--offline-border-strong);
  text-align: start;
}

.reader-error {
  margin: 0;
  padding: .75rem;
  border: 1px solid var(--offline-warm);
  border-radius: .5rem;
  color: var(--offline-warm);
}

.reader-footnote {
  margin: 1rem 0 0;
}

@media (max-width: 480px) {
  .page-card-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .page-card-actions .secondary-button,
  .page-card-actions .text-button {
    width: 100%;
  }

  .reader-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .reader-heading .text-button {
    align-self: start;
  }
}

@media (forced-colors: active) {
  .page-card,
  .offline-reader,
  .search-field input,
  .library-message {
    border-color: CanvasText;
    box-shadow: none;
  }

  .page-card[data-selected='true'] {
    border-color: Highlight;
  }

  .offline-page-body :where(th, td) {
    border-color: CanvasText;
  }
}

@media (prefers-reduced-motion: reduce) {
  .page-card {
    transition: none;
  }
}
</style>
