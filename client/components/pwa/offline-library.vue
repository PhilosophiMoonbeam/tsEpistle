<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type {
  OfflinePageSnapshotV1,
  OfflineSearchDocumentV1,
  OfflineSnapshotCorpus,
  OfflineSnapshotRecord
} from '../../../shared/offline.ts'
import {
  prepareOfflineSearchCorpus,
  searchPreparedOfflineDocumentsAsync,
  type OfflineSearchCorpus,
  type OfflineSearchResult
} from '../../helpers/offline-search.ts'
import {
  subscribeOfflineStorageChanges,
  type OfflineStorage
} from '../../helpers/offline-storage.ts'
import { renderOfflineHtmlFragment } from '../../helpers/offline-renderer.ts'

type OfflinePageSelector = {
  readonly siteId: string
  readonly pageId: number
  readonly locale: string
}

type ReaderHistoryMode = 'none' | 'initial' | 'pushed' | 'history'
type ReaderCloseOptions = { readonly fromHistory?: boolean; readonly restoreFocus?: boolean }
type ReaderOpenOptions = { readonly history?: ReaderHistoryMode }

type FocusAfterRemove = {
  readonly nextKey: string | null
  readonly previousKey: string | null
}

const props = defineProps<{
  storage: OfflineStorage | null
  storageState: string
  storageMessage?: string
  refreshToken?: number
  clearDeviceToken?: number
  requestedSelector?: OfflinePageSelector | null
}>()

const emit = defineEmits<{
  changed: []
  error: [message: string]
  'retry-storage': []
}>()

const OFFLINE_DOCUMENT_PATH = '/_offline'
const OFFLINE_LOCALE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,34}$/u

const records = shallowRef<readonly OfflineSnapshotRecord[]>([])
const corpus = shallowRef<OfflineSnapshotCorpus | null>(null)
const preparedCorpus = shallowRef<OfflineSearchCorpus | null>(null)
const corpusRevision = ref<number | null>(null)
const sessionGeneration = ref<number | null>(null)
const hasCorpus = ref(false)
const searchQuery = ref('')
const searchResults = shallowRef<OfflineSearchResult[]>([])
const searchHasMore = ref(false)
const selectedKey = ref<string | null>(null)
const selectedHeading = ref<HTMLElement | null>(null)
const renderTarget = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const copyFallbackInput = ref<HTMLTextAreaElement | null>(null)
const readerOpener = ref<HTMLElement | null>(null)
const readerOpenerKey = ref<string | null>(null)
const requestedSelectorConsumed = ref<string | null>(null)
const loading = ref(false)
const searching = ref(false)
const removingKey = ref<string | null>(null)
const loadError = ref('')
const searchError = ref('')
const readerState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const readerMessage = ref('')
const shareStatus = ref('')
const copyFallbackText = ref('')
const sharing = ref(false)
const clock = ref(Date.now())
const listScrollTop = ref<number | null>(null)
const historyMode = ref<ReaderHistoryMode>('none')
const focusAfterRemove = ref<FocusAfterRemove | null>(null)
let loadToken = 0
let searchRequestId = 0
let readerToken = 0
let searchController: AbortController | null = null
let preparationController: AbortController | null = null
let clockTimer: number | undefined
let unsubscribeStorageChanges: (() => void) | undefined

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

const selectorFromUrl = (): OfflinePageSelector | null => {
  if (typeof window === 'undefined' || window.location.pathname !== OFFLINE_DOCUMENT_PATH) return null
  const url = new URL(window.location.href)
  const entries = [...url.searchParams.entries()]
  if (!entries.length || url.hash || entries.length !== 3 || entries.some(([key]) => !['site', 'pageId', 'locale'].includes(key))) return null
  const siteValues = url.searchParams.getAll('site')
  const pageValues = url.searchParams.getAll('pageId')
  const localeValues = url.searchParams.getAll('locale')
  if (siteValues.length !== 1 || pageValues.length !== 1 || localeValues.length !== 1) return null
  const pageId = Number(pageValues[0])
  const selector = { siteId: siteValues[0], pageId, locale: localeValues[0] }
  return currentOrigin() && isValidSelector(selector, currentOrigin() as string) ? selector : null
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
const readerReady = computed(() => Boolean(selectedSnapshot.value && readerState.value === 'ready'))
const canUseNativeShare = computed(() => {
  if (!readerReady.value || !selectedOfflineUrl.value || typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false
  const payload = {
    title: selectedSnapshot.value?.title || 'Saved page',
    text: `${selectedOfflineText.value}\n\nThis local link opens only where this page was saved.`.trim(),
    url: selectedOfflineUrl.value
  }
  return typeof navigator.canShare !== 'function' || navigator.canShare(payload)
})

const storageChecking = computed(() => props.storageState === 'uninspected' || props.storageState === 'checking')
const storageUnavailable = computed(() => !storageChecking.value && (!props.storage || props.storageState !== 'available'))
const resultRecords = computed(() => {
  const byKey = new Map(activeRecords.value.map(record => [recordKey(record), record]))
  return searchResults.value
    .map(result => byKey.get(recordKey(result.document)))
    .filter((record): record is OfflineSnapshotRecord => record !== undefined && !isExpired(record))
})

const searchDetail = computed(() => {
  if (storageChecking.value || loading.value || !hasCorpus.value) return 'Checking saved pages on this device.'
  if (searching.value) return `Searching ${activeRecords.value.length} saved page${activeRecords.value.length === 1 ? '' : 's'}…`
  if (searchError.value) return 'Search could not be completed. Your saved pages were not changed.'
  if (searchQuery.value.trim()) {
    if (!resultRecords.value.length) return `No saved pages match “${searchQuery.value.trim().slice(0, 120)}”.`
    const more = searchHasMore.value ? ' More matches are available.' : ''
    return `${resultRecords.value.length} matching saved page${resultRecords.value.length === 1 ? '' : 's'}.${more}`
  }
  if (!activeRecords.value.length) return 'No saved pages yet.'
  const more = searchHasMore.value ? ' Showing the first 50.' : ''
  return `${activeRecords.value.length} saved page${activeRecords.value.length === 1 ? '' : 's'} on this device.${more}`
})

const libraryMessage = computed(() => {
  if (storageChecking.value) return 'Checking local storage without opening an account session.'
  if (storageUnavailable.value) return props.storageMessage ?? 'Saved pages are unavailable on this device right now.'
  if (loading.value) return 'Reading saved pages without changing them…'
  if (loadError.value) return loadError.value
  if (searchError.value) return 'Try Search again. Saved pages remain unchanged.'
  if (!activeRecords.value.length) return 'When you save an eligible public page, it appears here with its saved version and known expiry.'
  if (searchQuery.value.trim() && !resultRecords.value.length) return 'Try a different phrase or clear the search to see every saved page.'
  return ''
})

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

const copyToClipboard = async (value: string): Promise<void> => {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const input = document.createElement('textarea')
  input.value = value
  input.readOnly = true
  input.setAttribute('aria-hidden', 'true')
  input.style.position = 'fixed'
  input.style.insetInlineStart = '-10000px'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Copy is unavailable.')
  } finally {
    input.remove()
  }
}

const revealCopyFallback = async (text: string): Promise<void> => {
  copyFallbackText.value = text
  await nextTick()
  copyFallbackInput.value?.focus({ preventScroll: true })
  copyFallbackInput.value?.select()
}

const committedReaderText = (): string => {
  const snapshot = selectedSnapshot.value
  const body = renderTarget.value?.textContent?.replace(/\u00a0/gu, ' ').trim() ?? ''
  if (!snapshot) return body
  return [snapshot.title.trim(), body].filter(Boolean).join('\n\n')
}

const isAbortError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && Reflect.get(error, 'name') === 'AbortError')

const shareSelected = async (): Promise<void> => {
  const snapshot = selectedSnapshot.value
  const url = selectedOfflineUrl.value
  const operation = readerToken
  const key = selectedKey.value
  if (!snapshot || !url || !readerReady.value || typeof navigator.share !== 'function' || sharing.value) return
  sharing.value = true
  shareStatus.value = ''
  try {
    await navigator.share({
      title: snapshot.title || 'Saved page',
      text: `${selectedOfflineText.value}\n\nThis local link opens only where this page was saved.`.trim(),
      url
    })
    if (operation === readerToken && selectedKey.value === key && readerReady.value)
      shareStatus.value = 'Excerpt and local link shared.'
  } catch (error) {
    if (!isAbortError(error) && operation === readerToken && selectedKey.value === key)
      shareStatus.value = 'Sharing is unavailable. Copy the local link or full page text instead.'
  } finally {
    sharing.value = false
  }
}

const copySelectedLink = async (): Promise<void> => {
  const operation = readerToken
  const key = selectedKey.value
  const url = selectedOfflineUrl.value
  if (!readerReady.value || !url) return
  try {
    await copyToClipboard(url)
    if (operation === readerToken && selectedKey.value === key && readerReady.value) shareStatus.value = 'Local link copied.'
  } catch {
    if (operation === readerToken && selectedKey.value === key) shareStatus.value = 'The local link could not be copied.'
  }
}

const copySelectedText = async (): Promise<void> => {
  if (!readerReady.value || !selectedSnapshot.value) return
  const operation = readerToken
  const key = selectedKey.value
  const text = committedReaderText()
  if (!text) return
  try {
    await copyToClipboard(text)
    if (operation === readerToken && selectedKey.value === key && readerReady.value) {
      copyFallbackText.value = ''
      shareStatus.value = 'Full page text copied.'
    }
  } catch {
    if (operation !== readerToken || selectedKey.value !== key || !readerReady.value) return
    await revealCopyFallback(text)
    if (operation === readerToken && selectedKey.value === key) shareStatus.value = 'Clipboard access was denied. The full page text is selected below.'
  }
}

const runSearch = async (): Promise<void> => {
  searchController?.abort()
  const controller = new AbortController()
  searchController = controller
  const requestId = ++searchRequestId
  const prepared = preparedCorpus.value
  const revision = corpusRevision.value
  const generation = sessionGeneration.value
  searching.value = true
  searchError.value = ''
  try {
    if (!prepared || revision === null || generation === null) throw new Error('Saved pages are still being checked.')
    const response = await searchPreparedOfflineDocumentsAsync(prepared, searchQuery.value, {
      signal: controller.signal,
      limit: 50
    })
    if (controller.signal.aborted || requestId !== searchRequestId || searchController !== controller) return
    if (revision !== corpusRevision.value || generation !== sessionGeneration.value) return
    searchResults.value = response.results
    searchHasMore.value = response.hasMore
  } catch (error) {
    if (controller.signal.aborted || requestId !== searchRequestId || searchController !== controller || isAbortError(error)) return
    searchResults.value = []
    searchHasMore.value = false
    searchError.value = normalizeError(error, 'Saved-page search could not be completed.')
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
  if (!key && !opener && !searchInput.value) return
  const token = ++focusRestoreToken
  await nextTick()
  if (token !== focusRestoreToken) return
  const fallback = key
    ? document.querySelector<HTMLElement>(`button[data-offline-record-key="${encodeURIComponent(key)}"]`)
    : null
  const target = opener?.isConnected ? opener : fallback?.isConnected ? fallback : searchInput.value
  target?.focus({ preventScroll: true })
  if (typeof window !== 'undefined' && listScrollTop.value !== null) window.scrollTo({ top: listScrollTop.value, behavior: 'auto' })
}

const clearOfflineSelector = (): void => {
  if (typeof window === 'undefined' || window.location.pathname !== OFFLINE_DOCUMENT_PATH) return
  const url = new URL(window.location.href)
  for (const key of ['site', 'pageId', 'locale']) url.searchParams.delete(key)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

const setSelectionUrl = (record: OfflineSnapshotRecord, mode: ReaderHistoryMode): void => {
  const selector = { siteId: record.siteId, pageId: record.pageId, locale: record.locale }
  const href = offlineSelectorUrl(selector)
  if (!href || typeof window === 'undefined') return
  if (mode === 'initial' || mode === 'history') {
    historyMode.value = mode
    return
  }
  const current = selectorFromUrl()
  if (current && recordKey(current) === recordKey(selector)) {
    historyMode.value = historyMode.value === 'none' ? 'initial' : historyMode.value
    return
  }
  const currentState = window.history.state
  const nextState = currentState && typeof currentState === 'object' ? { ...currentState, offlineSelection: recordKey(selector) } : { offlineSelection: recordKey(selector) }
  window.history.pushState(nextState, '', href)
  historyMode.value = 'pushed'
}

const activeRecordForKey = (key: string | null): OfflineSnapshotRecord | null =>
  key ? activeRecords.value.find(record => recordKey(record) === key) ?? null : null

const isReaderCurrent = (operation: number, key: string, generation: number, revision: number): boolean =>
  operation === readerToken && selectedKey.value === key && sessionGeneration.value === generation && corpusRevision.value === revision && Boolean(activeRecordForKey(key))

const decorateReaderTree = (target: HTMLElement): void => {
  target.setAttribute('dir', 'auto')
  for (const pre of [...target.querySelectorAll('pre')]) {
    if (pre.parentElement?.classList.contains('offline-code-region')) continue
    const region = document.createElement('div')
    region.className = 'offline-code-region'
    region.tabIndex = 0
    region.setAttribute('role', 'region')
    region.setAttribute('aria-label', 'Scrollable code block')
    pre.replaceWith(region)
    region.append(pre)
  }
  for (const table of [...target.querySelectorAll('table')]) {
    if (table.parentElement?.classList.contains('offline-table-region')) continue
    const region = document.createElement('div')
    region.className = 'offline-table-region'
    region.tabIndex = 0
    region.setAttribute('role', 'region')
    region.setAttribute('aria-label', 'Scrollable table')
    table.replaceWith(region)
    region.append(table)
  }
}

const finishReaderError = (operation: number, key: string, message: string): void => {
  if (operation !== readerToken || selectedKey.value !== key) return
  renderTarget.value?.replaceChildren()
  readerState.value = 'error'
  readerMessage.value = message
  copyFallbackText.value = ''
}

const openRecord = async (record: OfflineSnapshotRecord, event?: MouseEvent, options: ReaderOpenOptions = {}): Promise<void> => {
  const key = recordKey(record)
  const origin = currentOrigin()
  const storage = props.storage
  const view = corpus.value
  const mode = options.history ?? 'pushed'
  if (event) {
    rememberReaderOpener(record, event)
    if (typeof window !== 'undefined' && selectedKey.value === null) listScrollTop.value = window.scrollY
  }
  if (!origin || !isValidSnapshotRecord(record, origin)) {
    emit('error', 'This saved page is invalid and cannot be opened.')
    return
  }
  if (isExpired(record)) {
    emit('error', 'This saved page has expired and cannot be opened.')
    return
  }
  if (!storage || !view || view.sessionGeneration !== sessionGeneration.value || view.corpusRevision !== corpusRevision.value) {
    emit('error', 'Saved pages changed before this page could open. Try again.')
    return
  }
  setSelectionUrl(record, mode)
  const operation = ++readerToken
  selectedKey.value = key
  readerState.value = 'loading'
  readerMessage.value = 'Opening the saved page…'
  shareStatus.value = ''
  copyFallbackText.value = ''
  renderTarget.value?.replaceChildren()
  const generation = view.sessionGeneration
  const revision = view.corpusRevision
  await nextTick()
  if (!isReaderCurrent(operation, key, generation, revision)) return
  const staging = document.createElement('div')
  staging.setAttribute('dir', 'auto')
  try {
    await renderOfflineHtmlFragment(staging, record.snapshot)
    if (!isReaderCurrent(operation, key, generation, revision)) return
    const verifiedView = await storage.readSnapshotCorpus({ expectedSessionGeneration: generation })
    if (!isReaderCurrent(operation, key, generation, revision)) return
    const verifiedRecord = verifiedView.snapshots.find(candidate => recordKey(candidate) === key)
    if (verifiedView.corpusRevision !== revision || !verifiedRecord || isExpired(verifiedRecord)) {
      finishReaderError(operation, key, 'This saved page changed or expired before it finished opening.')
      return
    }
    const opened = await storage.markSnapshotOpened(
      { siteId: verifiedRecord.siteId, pageId: verifiedRecord.pageId, locale: verifiedRecord.locale },
      { expectedSessionGeneration: generation }
    )
    if (!isReaderCurrent(operation, key, generation, revision) || !opened) {
      finishReaderError(operation, key, 'This saved page is no longer available on this device.')
      return
    }
    const committedView = await storage.readSnapshotCorpus({ expectedSessionGeneration: generation })
    if (!isReaderCurrent(operation, key, generation, revision)) return
    const committedRecord = committedView.snapshots.find(candidate => recordKey(candidate) === key)
    if (committedView.corpusRevision !== revision || !committedRecord || isExpired(committedRecord)) {
      finishReaderError(operation, key, 'This saved page changed before it could be committed for reading.')
      return
    }
    decorateReaderTree(staging)
    const target = renderTarget.value
    if (!target || !isReaderCurrent(operation, key, generation, revision)) return
    target.replaceChildren(...Array.from(staging.childNodes))
    target.setAttribute('dir', 'auto')
    readerState.value = 'ready'
    readerMessage.value = 'Saved page ready to read.'
    await nextTick()
    if (!isReaderCurrent(operation, key, generation, revision)) return
    selectedHeading.value?.focus({ preventScroll: true })
  } catch (error) {
    if (operation !== readerToken || selectedKey.value !== key) return
    finishReaderError(operation, key, normalizeError(error, 'This saved page failed its integrity or safety checks.'))
    emit('error', readerMessage.value)
  }
}

const closeRecord = (options: ReaderCloseOptions = {}): void => {
  const key = readerOpenerKey.value ?? selectedKey.value
  const opener = readerOpener.value
  const shouldRestore = options.restoreFocus !== false
  const shouldGoBack = !options.fromHistory && (historyMode.value === 'pushed' || historyMode.value === 'history')
  ++readerToken
  renderTarget.value?.replaceChildren()
  selectedKey.value = null
  readerState.value = 'idle'
  readerMessage.value = ''
  shareStatus.value = ''
  copyFallbackText.value = ''
  readerOpener.value = null
  readerOpenerKey.value = null
  const mode = historyMode.value
  historyMode.value = 'none'
  if (shouldGoBack && typeof window !== 'undefined') {
    window.history.back()
  } else if (!options.fromHistory && mode !== 'none') {
    clearOfflineSelector()
  }
  if (shouldRestore) void restoreReaderFocus(key, opener)
}

const retryReader = (): void => {
  const record = selectedRecord.value
  if (!record) return
  const mode: ReaderHistoryMode = historyMode.value === 'initial' ? 'initial' : 'history'
  void openRecord(record, undefined, { history: mode })
}
const loadRecords = async (): Promise<void> => {
  const storage = props.storage
  const token = ++loadToken
  preparationController?.abort()
  preparationController = null
  searchController?.abort()
  searchController = null
  searching.value = false
  if (!storage || props.storageState !== 'available') {
    loading.value = false
    loadError.value = ''
    return
  }
  const origin = currentOrigin()
  if (!origin) {
    hasCorpus.value = false
    records.value = []
    loadError.value = 'The current site identity is unavailable; saved pages cannot be opened safely.'
    loading.value = false
    return
  }
  const selector = props.requestedSelector
  if (selector && !isValidSelector(selector, origin)) {
    hasCorpus.value = false
    records.value = []
    loadError.value = 'The requested saved-page link is invalid or belongs to another site.'
    emit('error', loadError.value)
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const loaded = await storage.readSnapshotCorpus()
    const loadedAt = Date.now()
    const previousRevision = corpusRevision.value
    const previousGeneration = sessionGeneration.value
    const sameCommittedCorpus =
      previousRevision === loaded.corpusRevision &&
      previousGeneration === loaded.sessionGeneration &&
      preparedCorpus.value !== null &&
      !records.value.some(record => isExpired(record, loadedAt))
    const validRecords = loaded.snapshots
      .filter(record => isValidSnapshotRecord(record, origin) && !isExpired(record, loadedAt))
      .sort((left, right) => {
        const capturedOrder = right.snapshot.capturedAt.localeCompare(left.snapshot.capturedAt)
        if (capturedOrder !== 0) return capturedOrder
        const titleOrder = left.snapshot.title.localeCompare(right.snapshot.title)
        if (titleOrder !== 0) return titleOrder
        return recordKey(left).localeCompare(recordKey(right))
      })
    const nextCorpus = Object.freeze({
      snapshots: Object.freeze(validRecords.map(record => ({ ...record, snapshot: { ...record.snapshot } }))),
      sessionGeneration: loaded.sessionGeneration,
      corpusRevision: loaded.corpusRevision
    }) as OfflineSnapshotCorpus
    if (
      selectedKey.value &&
      previousRevision !== null &&
      (previousRevision !== loaded.corpusRevision || previousGeneration !== loaded.sessionGeneration)
    ) {
      ++readerToken
      renderTarget.value?.replaceChildren()
      readerState.value = 'error'
      readerMessage.value = 'Saved pages changed on this device. Retry opening this page to verify the new saved version.'
    }
    let prepared = preparedCorpus.value
    if (!sameCommittedCorpus) {
      const controller = new AbortController()
      preparationController = controller
      try {
        prepared = await prepareOfflineSearchCorpus(validRecords.map(toSearchDocument), { signal: controller.signal })
        if (token !== loadToken || preparationController !== controller) return
      } finally {
        if (preparationController === controller) preparationController = null
      }
    }
    if (token !== loadToken || !prepared) return
    records.value = validRecords
    corpus.value = nextCorpus
    preparedCorpus.value = prepared
    corpusRevision.value = loaded.corpusRevision
    sessionGeneration.value = loaded.sessionGeneration
    hasCorpus.value = true
    if (selectedKey.value && !activeRecordForKey(selectedKey.value)) {
      closeRecord({ fromHistory: true })
      clearOfflineSelector()
    }
    await runSearch()
    if (token !== loadToken) return
    const selectorKey = requestedSelectorKey.value
    if (selector && selectorKey && requestedSelectorConsumed.value !== selectorKey) {
      requestedSelectorConsumed.value = selectorKey
      const selected = activeRecords.value.find(record => recordKey(record) === selectorKey)
      if (!selected) {
        emit('error', 'The requested saved page is no longer available on this device.')
        return
      }
      await openRecord(selected, undefined, { history: 'initial' })
    }
  } catch (error) {
    if (token !== loadToken || isAbortError(error)) return
    loadError.value = normalizeError(error, 'Saved pages could not be read from this device.')
    emit('error', loadError.value)
  } finally {
    if (token === loadToken) loading.value = false
  }
}

const focusAfterRemoval = async (): Promise<void> => {
  const focus = focusAfterRemove.value
  focusAfterRemove.value = null
  if (!focus) return
  await nextTick()
  const targetKey = focus.nextKey ?? focus.previousKey
  const target = (targetKey
    ? document.querySelector<HTMLElement>(`button[data-offline-record-key="${encodeURIComponent(targetKey)}"]`)
    : null) ?? searchInput.value
  target?.focus({ preventScroll: true })
}

const removeRecord = async (record: OfflineSnapshotRecord): Promise<void> => {
  const storage = props.storage
  if (!storage || removingKey.value) return
  const key = recordKey(record)
  const visible = resultRecords.value
  const index = visible.findIndex(candidate => recordKey(candidate) === key)
  const focusedRow = document.activeElement instanceof HTMLElement && document.activeElement.closest(`[data-offline-record-key="${recordDomKey(record)}"]`)
  if (focusedRow && index >= 0) {
    focusAfterRemove.value = {
      nextKey: visible[index + 1] ? recordKey(visible[index + 1]) : null,
      previousKey: visible[index - 1] ? recordKey(visible[index - 1]) : null
    }
  }
  removingKey.value = key
  try {
    const generation = sessionGeneration.value ?? await storage.currentSessionGeneration()
    await storage.removeSnapshot(record.siteId, record.pageId, record.locale, { expectedSessionGeneration: generation })
    records.value = records.value.filter(candidate => recordKey(candidate) !== key)
    searchResults.value = searchResults.value.filter(result => recordKey(result.document) !== key)
    if (selectedKey.value === key) {
      closeRecord({ fromHistory: true })
      clearOfflineSelector()
    }
    emit('changed')
    await focusAfterRemoval()
    void loadRecords()
  } catch (error) {
    emit('error', normalizeError(error, 'The saved page could not be removed.'))
  } finally {
    if (removingKey.value === key) removingKey.value = null
  }
}

const invalidateLocalProjection = (): void => {
  ++loadToken
  ++readerToken
  preparationController?.abort()
  preparationController = null
  searchController?.abort()
  searchController = null
  searchResults.value = []
  searchHasMore.value = false
  corpus.value = null
  preparedCorpus.value = null
  corpusRevision.value = null
  sessionGeneration.value = null
  hasCorpus.value = false
  loading.value = false
  searchError.value = ''
  searching.value = false
  renderTarget.value?.replaceChildren()
  selectedKey.value = null
  readerState.value = 'idle'
  copyFallbackText.value = ''
  clearOfflineSelector()
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
  if (!Number.isFinite(expiry) || expiry <= clock.value) return 'Expired'
  return `Expires ${formatDate(record.snapshot.expiresAt)}`
}

const handlePopState = (): void => {
  const selector = selectorFromUrl()
  if (!selector) {
    if (selectedKey.value) closeRecord({ fromHistory: true })
    return
  }
  const key = recordKey(selector)
  const selected = activeRecordForKey(key)
  historyMode.value = 'history'
  if (!selected) {
    if (selectedKey.value) closeRecord({ fromHistory: true })
    emit('error', 'The requested saved page is no longer available on this device.')
    return
  }
  void openRecord(selected, undefined, { history: 'history' })
}

watch(searchQuery, () => {
  void runSearch()
})

watch(
  () => [props.storage, props.storageState, props.refreshToken],
  () => {
    void loadRecords()
  }
)

watch(() => props.clearDeviceToken, (value, previous) => {
  if (value !== previous) invalidateLocalProjection()
})

watch(requestedSelectorKey, (value, previous) => {
  if (value !== previous) requestedSelectorConsumed.value = null
})

watch(clock, () => {
  if (selectedKey.value && !activeRecordForKey(selectedKey.value)) {
    closeRecord({ fromHistory: true })
    clearOfflineSelector()
  }
  if (records.value.some(record => isExpired(record))) void loadRecords()
})

onMounted(() => {
  clockTimer = window.setInterval(() => { clock.value = Date.now() }, 60_000)
  window.addEventListener('popstate', handlePopState)
  unsubscribeStorageChanges = subscribeOfflineStorageChanges(() => { void loadRecords() })
  void loadRecords()
})

onBeforeUnmount(() => {
  ++loadToken
  ++readerToken
  preparationController?.abort()
  preparationController = null
  searchController?.abort()
  searchController = null
  window.removeEventListener('popstate', handlePopState)
  unsubscribeStorageChanges?.()
  if (clockTimer !== undefined) window.clearInterval(clockTimer)
})
</script>

<template>
  <section class="offline-library" aria-labelledby="downloaded-pages-title">
    <div class="library-heading">
      <div>
        <p class="section-kicker">Local index <span aria-hidden="true">01</span></p>
        <h2 id="downloaded-pages-title">Saved pages</h2>
      </div>
      <span class="count-note" aria-label="Saved page count">{{ hasCorpus ? activeRecords.length : '—' }}</span>
    </div>

    <p class="scope-note">Public pages saved deliberately on this device. Search stays local and never includes an account or private content.</p>

    <div class="search-field">
      <label for="downloaded-pages-search">Search saved pages</label>
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
      <p id="downloaded-pages-search-detail" class="field-hint" role="status" aria-live="polite" aria-atomic="true">{{ searchDetail }}</p>
    </div>

    <div v-if="storageChecking && !activeRecords.length && !selectedRecord" class="library-message" role="status" aria-live="polite">
      <span class="loading-mark" aria-hidden="true">…</span>
      <h3>Checking saved pages</h3>
      <p>{{ libraryMessage }}</p>
    </div>

    <div v-else-if="storageUnavailable && !activeRecords.length && !selectedRecord" class="library-message is-error" role="alert">
      <span class="empty-rule" aria-hidden="true"></span>
      <h3>Saved pages are unavailable</h3>
      <p>{{ libraryMessage }}</p>
      <button class="secondary-button" type="button" @click="retryStorage">Retry saved pages</button>
    </div>

    <div v-else-if="loading && !selectedRecord && !activeRecords.length" class="library-message" role="status" aria-live="polite">
      <span class="loading-mark" aria-hidden="true">…</span>
      <h3>Reading saved pages</h3>
      <p>{{ libraryMessage }}</p>
    </div>

    <div v-else-if="loadError && !selectedRecord && !activeRecords.length" class="library-message is-error" role="alert">
      <span class="empty-rule" aria-hidden="true"></span>
      <h3>Saved pages could not be read</h3>
      <p>{{ libraryMessage }}</p>
      <button class="secondary-button" type="button" @click="retryStorage">Retry saved pages</button>
    </div>

    <article v-else-if="selectedRecord && selectedSnapshot" class="offline-reader" :lang="selectedSnapshot.locale" dir="auto" aria-labelledby="offline-reader-title" aria-describedby="offline-reader-status">
      <div class="reader-heading">
        <div class="reader-title-block">
          <p class="section-kicker">Local reading copy <span aria-hidden="true">02</span></p>
          <h3 id="offline-reader-title" ref="selectedHeading" tabindex="-1">{{ selectedSnapshot.title || 'Untitled page' }}</h3>
        </div>
        <div class="reader-actions" aria-label="Saved page actions">
          <button v-if="canUseNativeShare" class="text-button" type="button" :disabled="sharing || !readerReady" @click="shareSelected">
            {{ sharing ? 'Sharing…' : 'Share excerpt + local link' }}
          </button>
          <button class="text-button" type="button" :disabled="!readerReady" @click="copySelectedLink">Copy local link</button>
          <button class="text-button" type="button" :disabled="!readerReady" @click="copySelectedText">Copy full page text</button>
          <button class="text-button" type="button" @click="closeRecord()">Back to saved pages</button>
        </div>
      </div>
      <p v-if="selectedSnapshot.description" class="reader-description">{{ selectedSnapshot.description }}</p>
      <p class="reader-meta">
        <span>{{ selectedSnapshot.locale }}</span><span aria-hidden="true"> · </span><bdi>{{ selectedSnapshot.path }}</bdi><span aria-hidden="true"> · </span><span>Saved version</span><span aria-hidden="true"> </span><bdi>{{ selectedSnapshot.sourceRevision }}</bdi><span aria-hidden="true"> · </span>{{ expiryLabel(selectedRecord) }}
      </p>
      <p v-if="storageUnavailable || loadError" class="library-inline-error" role="alert">
        <span>{{ storageUnavailable ? libraryMessage : loadError }}</span>
        <button class="text-button" type="button" @click="retryStorage">Retry saved pages</button>
      </p>
      <p id="offline-reader-status" class="reader-status" :class="`is-${readerState}`" role="status" aria-live="polite" aria-atomic="true">{{ readerMessage }}</p>
      <div ref="renderTarget" class="offline-page-body" aria-label="Saved page content" :aria-busy="readerState === 'loading' ? 'true' : 'false'"></div>
      <div v-if="readerState === 'error'" class="reader-error" role="alert">
        <p>{{ readerMessage }}</p>
        <button class="secondary-button" type="button" @click="retryReader">Retry opening this page</button>
      </div>
      <textarea
        v-if="copyFallbackText"
        ref="copyFallbackInput"
        class="copy-fallback"
        readonly
        rows="8"
        aria-label="Full saved page text for manual copying"
        :value="copyFallbackText"
      ></textarea>
      <p v-if="shareStatus" class="reader-status" role="status" aria-live="polite">{{ shareStatus }}</p>
      <p class="reader-footnote">This is a saved public page on this device. The local link opens only where the same download exists; it is not a backup or a server recall.</p>
    </article>

    <div v-else-if="searchError" class="library-message is-error" role="alert">
      <span class="empty-rule" aria-hidden="true"></span>
      <h3>Search is unavailable</h3>
      <p>{{ libraryMessage }}</p>
      <button class="secondary-button" type="button" @click="runSearch">Search again</button>
    </div>

    <div v-else-if="!resultRecords.length" class="library-message" role="status" aria-live="polite">
      <span class="empty-rule" aria-hidden="true"></span>
      <h3>{{ searchQuery.trim() ? 'No matching saved pages' : 'No saved pages yet' }}</h3>
      <p v-if="storageUnavailable || loadError" class="library-inline-error" role="alert">
        <span>{{ storageUnavailable ? libraryMessage : loadError }}</span>
        <button class="text-button" type="button" @click="retryStorage">Retry saved pages</button>
      </p>
      <small>Only explicit downloads are kept. Ordinary reader visits are never cached as saved pages.</small>
    </div>

    <ol v-else class="page-list" aria-label="Saved public pages">
      <li v-if="storageUnavailable || loadError" class="page-list-notice" role="alert">
        <span>{{ storageUnavailable ? libraryMessage : loadError }}</span>
        <button class="text-button" type="button" @click="retryStorage">Retry saved pages</button>
      </li>
      <li v-for="record in resultRecords" :key="recordKey(record)" class="page-list-item">
        <article class="page-card" :data-selected="selectedKey === recordKey(record)" :data-offline-record-key="recordDomKey(record)">
          <div class="page-card-main">
            <span class="page-card-kicker">{{ record.snapshot.locale }} <span aria-hidden="true">/</span> {{ formatBytes(record.byteSize) }}</span>
            <strong class="page-card-title">{{ record.snapshot.title || 'Untitled page' }}</strong>
            <span v-if="record.snapshot.description" class="page-card-description">{{ record.snapshot.description }}</span>
            <span class="page-card-meta">
              <span>{{ `Saved ${formatDate(record.snapshot.capturedAt)}` }}</span>
              <span>Saved version <bdi>{{ record.snapshot.sourceRevision }}</bdi></span>
            </span>
            <span class="page-card-expiry" :data-expiring="isExpiringSoon(record) ? 'soon' : 'current'">{{ expiryLabel(record) }}</span>
          </div>
          <div class="page-card-actions">
            <button class="secondary-button" type="button" :data-offline-record-key="recordDomKey(record)" :aria-label="`Open saved page ${record.snapshot.title || 'Untitled page'}`" @click="openRecord(record, $event)">Open page</button>
            <button class="text-button" type="button" :disabled="removingKey === recordKey(record)" @click="removeRecord(record)">
              {{ removingKey === recordKey(record) ? 'Removing…' : 'Remove page' }}
            </button>
          </div>
        </article>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.offline-library {
  min-width: 0;
  max-inline-size: 100%;
}

.library-heading,
.reader-heading {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  justify-content: space-between;
  padding-block-end: .85rem;
  border-block-end: 1px solid var(--offline-border);
}

.library-heading > div,
.reader-title-block {
  min-inline-size: 0;
}

.offline-library h2,
.offline-library h3 {
  margin: .3rem 0 0;
  font-family: var(--offline-heading);
  font-weight: 600;
  letter-spacing: -.045em;
  line-height: 1.05;
}

.offline-library h2 { font-size: clamp(1.55rem, 4vw, 2.25rem); }
.offline-library h3 { font-size: clamp(1.35rem, 3.5vw, 1.9rem); }

.count-note {
  flex: 0 0 auto;
  padding-block-start: .3rem;
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .75rem;
  white-space: nowrap;
}

.scope-note,
.reader-footnote {
  margin: .8rem 0 0;
  color: var(--offline-muted);
  font-family: var(--offline-mono);
  font-size: .75rem;
  line-height: 1.5;
}

.search-field {
  display: grid;
  gap: .45rem;
  max-inline-size: 42rem;
  margin-block: 1rem .8rem;
}

.search-field label {
  color: var(--offline-muted);
  font-family: var(--offline-mono);
  font-size: .78rem;
  font-weight: 700;
  letter-spacing: .025em;
}

.search-field input {
  min-block-size: 2.9rem;
  inline-size: 100%;
  max-inline-size: 100%;
  padding: .55rem .8rem;
  border: 1px solid var(--offline-border-strong);
  border-radius: .5rem;
  background: var(--offline-paper);
  color: var(--offline-ink);
}

.search-field input::placeholder { color: var(--offline-faint); }

.field-hint,
.library-status,
.reader-status {
  margin: 0;
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .75rem;
  line-height: 1.5;
}

.library-message {
  display: grid;
  min-block-size: 11rem;
  align-content: center;
  justify-items: start;
  gap: .65rem;
  margin-block-start: .8rem;
  padding: clamp(1.15rem, 4vw, 1.9rem);
  border: 1px dashed var(--offline-border-strong);
  border-radius: .7rem;
  background: var(--offline-paper-sunken);
}

.library-message.is-error,
.reader-error { border-color: color-mix(in srgb, var(--offline-warm) 68%, var(--offline-border)); }

.library-message p,
.library-message small {
  max-inline-size: 42rem;
  margin: 0;
  color: var(--offline-muted);
  line-height: 1.55;
}

.library-message small {
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .75rem;
}

.library-inline-error,
.page-list-notice {
  display: flex;
  flex-wrap: wrap;
  gap: .55rem .8rem;
  align-items: center;
  margin: .75rem 0 0;
  padding: .65rem .8rem;
  border: 1px solid color-mix(in srgb, var(--offline-warm) 68%, var(--offline-border));
  border-radius: .5rem;
  background: color-mix(in srgb, var(--offline-warm) 7%, var(--offline-paper));
  color: var(--offline-muted);
  font-size: .83rem;
  line-height: 1.45;
}

.library-inline-error .text-button,
.page-list-notice .text-button {
  flex: 0 0 auto;
}

.empty-rule {
  inline-size: 3.5rem;
  block-size: .2rem;
  margin-block-end: .2rem;
  background: var(--offline-warm);
}

.loading-mark {
  color: var(--offline-accent);
  font-family: var(--offline-mono);
  font-size: 1.4rem;
  line-height: 1;
}

.page-list {
  display: grid;
  gap: .65rem;
  margin: .8rem 0 0;
  padding: 0;
  list-style: none;
}

.page-card {
  display: grid;
  gap: .65rem;
  min-inline-size: 0;
  padding: .85rem;
  border: 1px solid var(--offline-border);
  border-radius: .7rem;
  background: color-mix(in srgb, var(--offline-paper-raised) 92%, transparent);
  transition: border-color .18s ease, background-color .18s ease;
}

.page-card[data-selected='true'] {
  border-color: var(--offline-accent);
  background: color-mix(in srgb, var(--offline-accent) 8%, var(--offline-paper-raised));
}

.page-card-main {
  display: grid;
  gap: .32rem;
  min-inline-size: 0;
}

.page-card-kicker,
.page-card-meta,
.page-card-expiry {
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .75rem;
  line-height: 1.45;
}

.page-card-title {
  overflow: hidden;
  color: var(--offline-ink);
  font-family: var(--offline-heading);
  font-size: 1.18rem;
  font-weight: 650;
  letter-spacing: -.02em;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.page-card-description {
  display: -webkit-box;
  overflow: hidden;
  color: var(--offline-muted);
  font-size: .88rem;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  line-clamp: 2;
  -webkit-line-clamp: 2;
}

.page-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: .25rem .75rem;
}

.page-card-expiry[data-expiring='soon'] { color: var(--offline-warm); }

.page-card-actions,
.reader-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .45rem .7rem;
  align-items: center;
  min-inline-size: 0;
}

.primary-button,
.secondary-button,
.text-button {
  min-block-size: 2.75rem;
  cursor: pointer;
  font-weight: 700;
}

.secondary-button {
  max-inline-size: 100%;
  padding-inline: .9rem;
  border: 1px solid var(--offline-border-strong);
  border-radius: .45rem;
  background: var(--offline-paper-raised);
  color: var(--offline-ink);
  overflow-wrap: anywhere;
}

.text-button {
  max-inline-size: 100%;
  padding-inline: .3rem;
  border: 0;
  background: transparent;
  color: var(--offline-muted);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 42%, transparent);
  text-underline-offset: .2em;
  overflow-wrap: anywhere;
}

.offline-reader {
  min-inline-size: 0;
  margin-block-start: .2rem;
  padding: clamp(1rem, 3vw, 1.8rem);
  border: 1px solid var(--offline-border-strong);
  border-radius: .8rem;
  background: var(--offline-paper-raised);
}

.reader-heading { padding-block-end: .75rem; }
.reader-heading h3 { max-inline-size: 34ch; overflow-wrap: anywhere; }

.reader-meta {
  display: flex;
  flex-wrap: wrap;
  gap: .15rem;
  margin: .8rem 0 0;
  color: var(--offline-faint);
  font-family: var(--offline-mono);
  font-size: .75rem;
  line-height: 1.55;
}

.reader-description {
  max-inline-size: 70ch;
  margin: .9rem 0 0;
  color: var(--offline-muted);
  font-size: .95rem;
  line-height: 1.55;
}

.reader-status { margin-block-start: .65rem; }
.reader-status.is-error { color: var(--offline-warm); }

.offline-page-body {
  max-inline-size: 75ch;
  min-inline-size: 0;
  margin-block: 1.15rem;
  color: var(--offline-ink);
  font-family: var(--offline-body);
  font-size: 1rem;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.offline-page-body :deep(:where(p, ul, ol, blockquote, dl, figure)) { margin-block: 0 1rem; }
.offline-page-body :deep(:where(h1, h2, h3, h4, h5, h6)) {
  margin-block: 1.45rem .6rem;
  font-family: var(--offline-heading);
  font-weight: 650;
  letter-spacing: -.025em;
  line-height: 1.15;
  overflow-wrap: anywhere;
}
.offline-page-body :deep(:where(h1)) { font-size: 1.75rem; }
.offline-page-body :deep(:where(h2)) { font-size: 1.45rem; }
.offline-page-body :deep(:where(h3, h4, h5, h6)) { font-size: 1.18rem; }
.offline-page-body :deep(:where(a)) {
  color: var(--offline-accent-strong);
  text-decoration-thickness: .08em;
  text-underline-offset: .15em;
}
.offline-page-body :deep(:where(pre, code)) { font-family: var(--offline-mono); font-size: .9em; }
.offline-page-body :deep(:where(.offline-code-region, .offline-table-region)) {
  max-inline-size: 100%;
  margin-block: 0 1rem;
  overflow: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.offline-page-body :deep(:where(.offline-code-region)) {
  padding: .8rem;
  border: 1px solid var(--offline-border);
  border-radius: .5rem;
  background: var(--offline-paper-sunken);
  white-space: pre;
}
.offline-page-body :deep(:where(.offline-code-region pre)) { margin: 0; }
.offline-page-body :deep(:where(blockquote)) {
  margin-inline: 0;
  padding-inline-start: 1rem;
  border-inline-start: .2rem solid var(--offline-warm);
  color: var(--offline-muted);
}
.offline-page-body :deep(:where(.offline-table-region)) { border: 1px solid var(--offline-border); }
.offline-page-body :deep(:where(table)) { min-inline-size: max-content; border-collapse: collapse; }
.offline-page-body :deep(:where(th, td)) {
  padding: .4rem .6rem;
  border: 1px solid var(--offline-border-strong);
  text-align: start;
  vertical-align: top;
}

.reader-error {
  display: grid;
  gap: .65rem;
  margin-block: .8rem;
  padding: .8rem;
  border: 1px solid var(--offline-warm);
  border-radius: .5rem;
  color: var(--offline-warm);
}
.reader-error p { margin: 0; line-height: 1.5; }
.reader-footnote { max-inline-size: 75ch; }
.copy-fallback {
  display: block;
  inline-size: 100%;
  max-inline-size: 75ch;
  min-block-size: 10rem;
  margin-block: .8rem;
  padding: .75rem;
  border: 1px solid var(--offline-border-strong);
  border-radius: .45rem;
  background: var(--offline-paper);
  color: var(--offline-ink);
  font: .9rem/1.55 var(--offline-mono);
  resize: vertical;
}

@media (max-width: 560px) {
  .library-heading,
  .reader-heading { flex-direction: column; gap: .55rem; }
  .count-note { padding-block-start: 0; }
  .reader-actions { align-items: stretch; inline-size: 100%; }
  .reader-actions .text-button { flex: 1 1 auto; }
  .page-card-actions { align-items: stretch; }
  .page-card-actions .secondary-button,
  .page-card-actions .text-button { flex: 1 1 10rem; }
}

@media (forced-colors: active) {
  .page-card,
  .offline-reader,
  .search-field input,
  .library-message,
  .library-inline-error,
  .page-list-notice,
  .copy-fallback,
  .offline-page-body :deep(:where(.offline-code-region, .offline-table-region)) { border-color: CanvasText; box-shadow: none; }
  .page-card[data-selected='true'] { border-color: Highlight; }
  .offline-page-body :deep(:where(th, td)) { border-color: CanvasText; }
}

@media (prefers-reduced-motion: reduce) {
  .page-card { transition: none; }
}
</style>
