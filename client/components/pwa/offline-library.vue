<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type {
  OfflinePagePolicyRecord,
  OfflinePageSnapshotV1,
  OfflinePolicySnapshot,
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
import { offlinePageHref, offlineRecordAtUrl } from '../../helpers/offline-routes.ts'
import { renderOfflineHtmlFragment } from '../../helpers/offline-renderer.ts'
import {
  createOfflineSyncUnavailableResult,
  OFFLINE_SYNC_COORDINATOR_KEY,
  type OfflineSyncResult,
  type OfflineSyncService
} from '../../helpers/offline-sync.ts'

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
  showSettings?: boolean
  navigateOnOpen?: boolean
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
  selected: [record: OfflineSnapshotRecord | null]
  busy: [value: boolean]
}>()

const offlineSyncResultDetail = (result: OfflineSyncResult, fallback: string): string => {
  const detail = result.outcome === 'unavailable'
    ? result.error
    : result.error ?? result.diagnostics?.lastError
  const normalized = typeof detail === 'string' ? detail.trim() : ''
  return (normalized || fallback).slice(0, 512)
}

const offlineSyncService = inject<OfflineSyncService>(OFFLINE_SYNC_COORDINATOR_KEY)
const OFFLINE_DOCUMENT_PATH = '/_offline'
const OFFLINE_LOCALE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,34}$/u

const records = shallowRef<readonly OfflineSnapshotRecord[]>([])
const corpus = shallowRef<OfflineSnapshotCorpus | null>(null)
const preparedCorpus = shallowRef<OfflineSearchCorpus | null>(null)
const corpusRevision = ref<number | null>(null)
const policy = shallowRef<OfflinePolicySnapshot | null>(null)
const policyLoading = ref(false)
const policyMutationLoading = ref(false)
const policyError = ref('')
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
const refreshing = ref(false)
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

const isSameOfflinePage = (
  left: Pick<OfflineSnapshotRecord, 'siteId' | 'pageId'>,
  right: Pick<OfflineSnapshotRecord, 'siteId' | 'pageId'>
): boolean => left.siteId === right.siteId && left.pageId === right.pageId

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
  const record = records.value.find(record => recordKey(record) === recordKey(selector))
  const path = record ? offlinePageHref(record, origin) : null
  return path ? new URL(path, origin).href : null
}

const selectorFromUrl = (): OfflinePageSelector | null => {
  if (typeof window === 'undefined') return null
  if (new URL(window.location.href).searchParams.has('saved')) return null
  if (window.location.pathname !== OFFLINE_DOCUMENT_PATH) {
    return offlineRecordAtUrl(activeRecords.value, window.location.href, window.location.origin, siteConfig.lang) ?? null
  }
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

const activeRecords = computed(() => records.value.filter((record: OfflineSnapshotRecord) => !isExpired(record)))
const selectedRecord = computed(() => activeRecords.value.find((record: OfflineSnapshotRecord) => recordKey(record) === selectedKey.value) ?? null)
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
    text: `${selectedOfflineText.value}\n\nOpen this page online, or from a saved copy on your device.`.trim(),
    url: selectedOfflineUrl.value
  }
  return typeof navigator.canShare !== 'function' || navigator.canShare(payload)
})
const policyByKey = computed(() => new Map(
  policy.value?.pages.map((record: OfflinePagePolicyRecord) => [recordKey(record), record] as const) ?? []
))
const policyForRecord = (record: OfflineSnapshotRecord): OfflinePagePolicyRecord | null =>
  policyByKey.value.get(recordKey(record)) ?? null
const automaticSavingEnabled = computed(() => policy.value?.state.automaticSavingEnabled === true)
const selectedTags = computed(() => policy.value?.state.selectedTags ?? [])
const syncDiagnostics = computed(() => policy.value?.state.syncDiagnostics ?? null)
const syncDiagnosticsDetail = computed(() => {
  const diagnostics = syncDiagnostics.value
  if (!diagnostics) return 'Offline sync has not reported a status yet.'
  const pending = `${diagnostics.pendingCount} pending`
  const retained = `${diagnostics.retainedCount} retained`
  const removed = `${diagnostics.removedCount} removed`
  const timing = diagnostics.lastSuccessAt
    ? ` Last successful sync ${formatDate(diagnostics.lastSuccessAt)}.`
    : diagnostics.lastAttemptAt
      ? ` Last attempted sync ${formatDate(diagnostics.lastAttemptAt)}.`
      : ''
  const error = diagnostics.lastError ? ` ${diagnostics.lastError}` : ''
  return `Sync ${diagnostics.status}: ${pending}, ${retained}, ${removed}.${timing}${error}`
})
const provenanceLabelForPolicy = (entry: OfflinePagePolicyRecord | null): string => {
  if (!entry) return 'Policy details unavailable'
  const sources: string[] = []
  if (entry.manual) sources.push('Manual')
  if (entry.automatic) sources.push('Automatic')
  if (entry.tag) sources.push(entry.tagNames.length ? `Tag: ${entry.tagNames.join(', ')}` : 'Tag subscription')
  return sources.length ? sources.join(' + ') : 'No active intent'
}
const provenanceLabel = (record: OfflineSnapshotRecord): string => provenanceLabelForPolicy(policyForRecord(record))
const availabilityLabel = (record: OfflineSnapshotRecord): string =>
  policyForRecord(record)?.availability ?? 'unknown'
const storageChecking = computed(() => props.storageState === 'uninspected' || props.storageState === 'checking')
const storageUnavailable = computed(() => !storageChecking.value && (!props.storage || props.storageState !== 'available'))
const resultRecords = computed(() => {
  const byKey = new Map(activeRecords.value.map((record: OfflineSnapshotRecord) => [recordKey(record), record]))
  return searchResults.value
    .map((result: OfflineSearchResult) => byKey.get(recordKey(result.document)))
    .filter((record): record is OfflineSnapshotRecord => record !== undefined && !isExpired(record))
})
type MissingPolicyPageStatus = 'pending' | 'denied' | 'stale'
type MissingPolicyPage = {
  readonly page: OfflinePagePolicyRecord
  readonly status: MissingPolicyPageStatus
}

const hasEffectivePolicyIntent = (page: OfflinePagePolicyRecord): boolean =>
  page.siteId === currentOrigin() &&
  !page.excluded &&
  (page.manual || page.tag || (automaticSavingEnabled.value && page.automatic))

const missingPolicyPageStatus = (page: OfflinePagePolicyRecord): MissingPolicyPageStatus => {
  if (page.availability === 'ineligible') return 'denied'
  if (page.availability === 'unknown') return 'pending'
  return 'stale'
}

const missingPolicyPages = computed<MissingPolicyPage[]>(() => {
  if (!policy.value || !hasCorpus.value) return []
  const bodyKeys = new Set(activeRecords.value.map(recordKey))
  return policy.value.pages
    .filter((page: OfflinePagePolicyRecord) => hasEffectivePolicyIntent(page) && !bodyKeys.has(recordKey(page)))
    .map((page: OfflinePagePolicyRecord) => ({ page, status: missingPolicyPageStatus(page) }))
})
const missingPolicyStatusLabel = (status: MissingPolicyPageStatus): string =>
  status === 'pending' ? 'Pending snapshot' : status === 'denied' ? 'Download denied' : 'Snapshot stale'

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
      text: `${selectedOfflineText.value}\n\nOpen this page online, or from a saved copy on your device.`.trim(),
      url
    })
    if (operation === readerToken && selectedKey.value === key && readerReady.value)
      shareStatus.value = 'Excerpt and page link shared.'
  } catch (error) {
    if (!isAbortError(error) && operation === readerToken && selectedKey.value === key)
      shareStatus.value = 'Sharing is unavailable. Copy the page link or full page text instead.'
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
    if (operation === readerToken && selectedKey.value === key && readerReady.value) shareStatus.value = 'Page link copied.'
  } catch {
    if (operation === readerToken && selectedKey.value === key) shareStatus.value = 'The page link could not be copied.'
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
  if (typeof window === 'undefined' || props.navigateOnOpen) return
  window.history.replaceState(window.history.state, '', '/?saved=1')
}

const setSelectionUrl = (record: OfflineSnapshotRecord, mode: ReaderHistoryMode): void => {
  const selector = { siteId: record.siteId, pageId: record.pageId, locale: record.locale }
  const href = offlineSelectorUrl(selector)
  if (!href || typeof window === 'undefined') return
  if (mode === 'initial' || mode === 'history') {
    if (window.location.pathname === OFFLINE_DOCUMENT_PATH) window.history.replaceState(window.history.state, '', href)
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
  key ? activeRecords.value.find((record: OfflineSnapshotRecord) => recordKey(record) === key) ?? null : null

const isReaderCurrent = (
  operation: number,
  key: string,
  generation: number,
  revision: number,
  expectedPolicyRevision: number
): boolean =>
  operation === readerToken &&
  selectedKey.value === key &&
  sessionGeneration.value === generation &&
  corpusRevision.value === revision &&
  policy.value?.sessionGeneration === generation &&
  policy.value?.state.policyRevision === expectedPolicyRevision &&
  Boolean(activeRecordForKey(key))

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
  if (props.navigateOnOpen && origin) {
    const href = offlinePageHref(record, origin)
    if (href) window.location.assign(href)
    return
  }
  const storage = props.storage
  const view = corpus.value
  const currentPolicy = policy.value
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
  if (
    !storage ||
    !view ||
    !currentPolicy ||
    view.sessionGeneration !== sessionGeneration.value ||
    view.corpusRevision !== corpusRevision.value ||
    currentPolicy.sessionGeneration !== view.sessionGeneration
  ) {
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
  const expectedPolicyRevision = currentPolicy.state.policyRevision
  await nextTick()
  if (!isReaderCurrent(operation, key, generation, revision, expectedPolicyRevision)) return
  const staging = document.createElement('div')
  staging.setAttribute('dir', 'auto')
  try {
    await renderOfflineHtmlFragment(staging, record.snapshot)
    if (!isReaderCurrent(operation, key, generation, revision, expectedPolicyRevision)) return
    const verifiedView = await storage.readSnapshotCorpus({
      expectedSessionGeneration: generation,
      expectedPolicyRevision
    })
    if (!isReaderCurrent(operation, key, generation, revision, expectedPolicyRevision)) return
    const verifiedRecord = verifiedView.snapshots.find((candidate: OfflineSnapshotRecord) => recordKey(candidate) === key)
    if (verifiedView.corpusRevision !== revision || !verifiedRecord || isExpired(verifiedRecord)) {
      finishReaderError(operation, key, 'This saved page changed or expired before it finished opening.')
      return
    }
    const opened = await storage.markSnapshotOpened(
      { siteId: verifiedRecord.siteId, pageId: verifiedRecord.pageId, locale: verifiedRecord.locale },
      {
        expectedSessionGeneration: generation,
        expectedPolicyRevision
      }
    )
    if (!isReaderCurrent(operation, key, generation, revision, expectedPolicyRevision) || !opened) {
      finishReaderError(operation, key, 'This saved page is no longer available on this device.')
      return
    }
    const committedView = await storage.readSnapshotCorpus({
      expectedSessionGeneration: generation,
      expectedPolicyRevision
    })
    if (!isReaderCurrent(operation, key, generation, revision, expectedPolicyRevision)) return
    const committedRecord = committedView.snapshots.find((candidate: OfflineSnapshotRecord) => recordKey(candidate) === key)
    if (committedView.corpusRevision !== revision || !committedRecord || isExpired(committedRecord)) {
      finishReaderError(operation, key, 'This saved page changed before it could be committed for reading.')
      return
    }
    decorateReaderTree(staging)
    const target = renderTarget.value
    if (!target || !isReaderCurrent(operation, key, generation, revision, expectedPolicyRevision)) return
    target.replaceChildren(...Array.from(staging.childNodes))
    target.setAttribute('dir', 'auto')
    readerState.value = 'ready'
    readerMessage.value = 'Reading the saved version. Changes will sync when you reconnect.'
    document.title = `${record.snapshot.title || 'Untitled page'} | ${siteConfig.title}`
    emit('selected', record)
    await nextTick()
    if (!isReaderCurrent(operation, key, generation, revision, expectedPolicyRevision)) return
    selectedHeading.value?.focus({ preventScroll: true })
    if (window.location.hash) {
      try { document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView() } catch { /* malformed fragment */ }
    }
  } catch (error) {
    if (!isReaderCurrent(operation, key, generation, revision, expectedPolicyRevision)) return
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
  emit('selected', null)
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
    window.location.assign('/p/offline#downloaded-pages-title')
    return
  }
  if (shouldRestore) void restoreReaderFocus(key, opener)
}

const retryReader = (): void => {
  const record = selectedRecord.value
  if (!record) return
  const mode: ReaderHistoryMode = historyMode.value === 'initial' ? 'initial' : 'history'
  void openRecord(record, undefined, { history: mode })
}
const loadRecords = async (options: { preservePolicyError?: boolean } = {}): Promise<boolean> => {
  const storage = props.storage
  const preservePolicyError = options.preservePolicyError === true
  if (!preservePolicyError) policyError.value = ''
  const token = ++loadToken
  const readerOperationAtStart = readerToken
  const selectedKeyAtStart = selectedKey.value
  const previousPolicyRevision = policy.value?.state.policyRevision ?? null
  preparationController?.abort()
  preparationController = null
  searchController?.abort()
  searchController = null
  searching.value = false
  if (!storage || props.storageState !== 'available') {
    policy.value = null
    policyLoading.value = false
    loading.value = false
    loadError.value = ''
    return false
  }
  const origin = currentOrigin()
  if (!origin) {
    policy.value = null
    policyLoading.value = false
    hasCorpus.value = false
    records.value = []
    corpus.value = null
    preparedCorpus.value = null
    loadError.value = 'The current site identity is unavailable; saved pages cannot be opened safely.'
    loading.value = false
    return false
  }
  const selector = props.requestedSelector
  if (selector && !isValidSelector(selector, origin)) {
    policy.value = null
    policyLoading.value = false
    hasCorpus.value = false
    records.value = []
    corpus.value = null
    preparedCorpus.value = null
    loadError.value = 'The requested saved-page link is invalid or belongs to another site.'
    emit('error', loadError.value)
    loading.value = false
    return false
  }
  loading.value = true
  policyLoading.value = true
  loadError.value = ''
  try {
    const loadedPolicy = await storage.readOfflinePolicy()
    if (token !== loadToken) return false
    const loaded = await storage.readSnapshotCorpus({
      expectedSessionGeneration: loadedPolicy.sessionGeneration,
      expectedPolicyRevision: loadedPolicy.state.policyRevision
    })
    if (token !== loadToken) return false
    const loadedAt = Date.now()
    const previousRevision = corpusRevision.value
    const previousGeneration = sessionGeneration.value
    const sameCommittedCorpus =
      previousRevision === loaded.corpusRevision &&
      previousGeneration === loaded.sessionGeneration &&
      preparedCorpus.value !== null &&
      !records.value.some((record: OfflineSnapshotRecord) => isExpired(record, loadedAt))
    const validRecords = loaded.snapshots
      .filter((record: OfflineSnapshotRecord) => isValidSnapshotRecord(record, origin) && !isExpired(record, loadedAt))
      .sort((left: OfflineSnapshotRecord, right: OfflineSnapshotRecord) => {
        const capturedOrder = right.snapshot.capturedAt.localeCompare(left.snapshot.capturedAt)
        if (capturedOrder !== 0) return capturedOrder
        const titleOrder = left.snapshot.title.localeCompare(right.snapshot.title)
        if (titleOrder !== 0) return titleOrder
        return recordKey(left).localeCompare(recordKey(right))
      })
    const nextCorpus = Object.freeze({
      snapshots: Object.freeze(validRecords.map((record: OfflineSnapshotRecord) => ({ ...record, snapshot: { ...record.snapshot } }))),
      sessionGeneration: loaded.sessionGeneration,
      corpusRevision: loaded.corpusRevision
    }) as OfflineSnapshotCorpus
    if (
      token !== loadToken ||
      (
        selectedKey.value &&
        selectedKey.value === selectedKeyAtStart &&
        readerToken === readerOperationAtStart &&
        previousRevision !== null &&
        (
          previousRevision !== loaded.corpusRevision ||
          previousGeneration !== loaded.sessionGeneration ||
          previousPolicyRevision !== loadedPolicy.state.policyRevision
        )
      )
    ) {
      if (token !== loadToken) return false
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
        if (token !== loadToken || preparationController !== controller) return false
      } finally {
        if (preparationController === controller) preparationController = null
      }
    }
    if (token !== loadToken || !prepared) return false
    records.value = validRecords
    corpus.value = nextCorpus
    preparedCorpus.value = prepared
    corpusRevision.value = loaded.corpusRevision
    sessionGeneration.value = loaded.sessionGeneration
    hasCorpus.value = true
    policy.value = loadedPolicy
    if (!preservePolicyError) policyError.value = ''
    if (
      selectedKey.value &&
      !activeRecordForKey(selectedKey.value) &&
      selectedKey.value === selectedKeyAtStart &&
      readerToken === readerOperationAtStart
    ) {
      closeRecord({ fromHistory: true })
      clearOfflineSelector()
    }
    await runSearch()
    if (token !== loadToken) return false
    const routeRecord = !props.navigateOnOpen && !new URL(window.location.href).searchParams.has('saved')
      ? offlineRecordAtUrl(activeRecords.value, window.location.href, origin, siteConfig.lang) : undefined
    const requested = selector ?? routeRecord
    const selectorKey = requested ? recordKey(requested) : requestedSelectorKey.value
    if (requested && selectorKey && requestedSelectorConsumed.value !== selectorKey) {
      requestedSelectorConsumed.value = selectorKey
      const selected = activeRecords.value.find((record: OfflineSnapshotRecord) => recordKey(record) === selectorKey)
      if (!selected) {
        emit('error', 'The requested saved page is no longer available on this device.')
        return true
      }
      await openRecord(selected, undefined, { history: 'initial' })
      if (token !== loadToken) return false
    }
    if (!props.navigateOnOpen && !requested && window.location.pathname !== '/' && window.location.pathname !== OFFLINE_DOCUMENT_PATH) {
      emit('error', 'This page has not been saved on this device. You can open another saved page below or reconnect to continue.')
    }
    return true
  } catch (error) {
    if (token !== loadToken || isAbortError(error)) return false
    loadError.value = normalizeError(error, 'Saved pages could not be read from this device.')
    emit('error', loadError.value)
    return false
  } finally {
    if (token === loadToken) {
      loading.value = false
      policyLoading.value = false
    }
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

const removeLocalPageProjection = (selector: Pick<OfflineSnapshotRecord, 'siteId' | 'pageId' | 'locale'>): void => {
  const selectedWasRemoved =
    selectedKey.value !== null &&
    (selectedKey.value === recordKey(selector) ||
      records.value.some(record => recordKey(record) === selectedKey.value && isSameOfflinePage(record, selector)))
  records.value = records.value.filter(record => !isSameOfflinePage(record, selector))
  searchResults.value = searchResults.value.filter(result => !isSameOfflinePage(result.document, selector))
  if (corpus.value) {
    corpus.value = Object.freeze({
      ...corpus.value,
      snapshots: Object.freeze(corpus.value.snapshots.filter(record => !isSameOfflinePage(record, selector)))
    }) as OfflineSnapshotCorpus
  }
  preparedCorpus.value = null
  searchHasMore.value = false
  if (policy.value) {
    policy.value = {
      ...policy.value,
      pages: policy.value.pages.filter(page => !isSameOfflinePage(page, selector))
    }
  }
  if (selectedWasRemoved) {
    closeRecord({ fromHistory: true, restoreFocus: false })
    clearOfflineSelector()
  }
}

const reconcileAfterCommittedRemoval = async (): Promise<void> => {
  let syncFailure = ''
  try {
    const syncResult: OfflineSyncResult = offlineSyncService
      ? await offlineSyncService.reconcile('manual')
      : createOfflineSyncUnavailableResult('Offline synchronization is unavailable.')
    if (syncResult.outcome === 'error' || syncResult.outcome === 'unavailable') {
      const detail = offlineSyncResultDetail(syncResult, 'Offline synchronization could not be completed.')
      syncFailure = syncResult.outcome === 'unavailable'
        ? `Saved page removed locally, but offline sync is unavailable: ${detail}`
        : `Saved page removed locally, but offline sync failed: ${detail}`
      policyError.value = syncFailure
      emit('error', policyError.value)
    }
  } catch (error) {
    syncFailure = `Saved page removed locally, but offline sync failed: ${normalizeError(error, 'Offline synchronization could not be completed.').slice(0, 512)}`
    policyError.value = syncFailure
    emit('error', policyError.value)
  }

  let refreshed = false
  let refillDetail = ''
  try {
    refreshed = await loadRecords({ preservePolicyError: Boolean(syncFailure) })
  } catch (error) {
    refillDetail = normalizeError(error, 'Saved pages could not be refreshed.').slice(0, 512)
  }
  if (!refreshed && !refillDetail) refillDetail = loadError.value || (storageUnavailable.value ? libraryMessage.value : '')
  if (refillDetail) {
    policyError.value = syncFailure
      ? `${syncFailure} Saved-page list could not be refreshed: ${refillDetail}`
      : `Saved page removed locally, but the saved-page list could not be refreshed: ${refillDetail}`
    emit('error', policyError.value)
  }
}

const removeRecord = async (record: OfflineSnapshotRecord): Promise<void> => {
  const storage = props.storage
  if (!storage || removingKey.value || refreshing.value || policyMutationLoading.value) return
  const key = recordKey(record)
  const visible = resultRecords.value
  const index = visible.findIndex((candidate: OfflineSnapshotRecord) => recordKey(candidate) === key)
  const focusedRow = document.activeElement instanceof HTMLElement && document.activeElement.closest(`[data-offline-record-key="${recordDomKey(record)}"]`)
  if (focusedRow && index >= 0) {
    const next = visible.slice(index + 1).find(candidate => !isSameOfflinePage(candidate, record))
    const previous = visible.slice(0, index).reverse().find(candidate => !isSameOfflinePage(candidate, record))
    focusAfterRemove.value = {
      nextKey: next ? recordKey(next) : null,
      previousKey: previous ? recordKey(previous) : null
    }
  }
  removingKey.value = key
  policyMutationLoading.value = true
  let removalCommitted = false
  try {
    try {
      const generation = sessionGeneration.value ?? await storage.currentSessionGeneration()
      const currentPolicy = await storage.readOfflinePolicy({ expectedSessionGeneration: generation })
      await storage.removeOfflinePage(
        { siteId: record.siteId, pageId: record.pageId, locale: record.locale },
        {
          expectedSessionGeneration: generation,
          expectedPolicyRevision: currentPolicy.state.policyRevision
        }
      )
      removalCommitted = true
    } catch (error) {
      emit('error', normalizeError(error, 'The saved page could not be removed.'))
    }
    if (!removalCommitted) return
    removeLocalPageProjection(record)
    emit('changed')
    await reconcileAfterCommittedRemoval()
  } finally {
    policyMutationLoading.value = false
    if (removingKey.value === key) removingKey.value = null
    if (removalCommitted) await focusAfterRemoval()
  }
}

const toggleAutomaticSaving = async (): Promise<void> => {
  const storage = props.storage
  if (!storage || policyMutationLoading.value || refreshing.value) return
  policyMutationLoading.value = true
  policyError.value = ''
  let policyMutationCommitted = false
  try {
    const current = await storage.readOfflinePolicy()
    const state = await storage.setAutomaticSavingEnabled(!current.state.automaticSavingEnabled, {
      expectedSessionGeneration: current.sessionGeneration,
      expectedPolicyRevision: current.state.policyRevision
    })
    policyMutationCommitted = true
    policy.value = { ...current, state }
    emit('changed')
    const syncResult: OfflineSyncResult = offlineSyncService
      ? await offlineSyncService.reconcile('policy')
      : createOfflineSyncUnavailableResult('Offline synchronization is unavailable.')
    if (syncResult.outcome === 'error' || syncResult.outcome === 'unavailable') {
      const detail = offlineSyncResultDetail(syncResult, 'Offline synchronization could not be completed.')
      policyError.value = syncResult.outcome === 'unavailable'
        ? `Automatic offline saving was changed locally, but offline sync is unavailable: ${detail}`
        : `Automatic offline saving was changed locally, but offline sync failed: ${detail}`
      emit('error', policyError.value)
      await loadRecords({ preservePolicyError: true })
      return
    }
    await loadRecords()
  } catch (error) {
    const detail = normalizeError(error, 'Automatic offline saving could not be changed.').slice(0, 512)
    if (policyMutationCommitted) {
      policyError.value = `Automatic offline saving was changed locally, but offline sync failed: ${detail}`
    } else {
      policyError.value = detail
    }
    emit('error', policyError.value)
    await loadRecords({ preservePolicyError: true })
  } finally {
    policyMutationLoading.value = false
  }
}

const removeSelectedTag = async (tag: string): Promise<void> => {
  const storage = props.storage
  if (!storage || policyMutationLoading.value || refreshing.value) return
  policyMutationLoading.value = true
  policyError.value = ''
  let policyMutationCommitted = false
  try {
    const current = await storage.readOfflinePolicy()
    const nextTags = current.state.selectedTags.filter((candidate: string) => candidate !== tag)
    const state = await storage.setOfflineTagSubscriptions(nextTags, {
      expectedSessionGeneration: current.sessionGeneration,
      expectedPolicyRevision: current.state.policyRevision
    })
    policyMutationCommitted = true
    policy.value = { ...current, state }
    emit('changed')
    const syncResult: OfflineSyncResult = offlineSyncService
      ? await offlineSyncService.reconcile('tags')
      : createOfflineSyncUnavailableResult('Offline synchronization is unavailable.')
    if (syncResult.outcome === 'error' || syncResult.outcome === 'unavailable') {
      const detail = offlineSyncResultDetail(syncResult, 'Offline synchronization could not be completed.')
      policyError.value = syncResult.outcome === 'unavailable'
        ? `The offline tag subscription was removed locally, but offline sync is unavailable: ${detail}`
        : `The offline tag subscription was removed locally, but offline sync failed: ${detail}`
      emit('error', policyError.value)
      await loadRecords({ preservePolicyError: true })
      return
    }
    await loadRecords()
  } catch (error) {
    const detail = normalizeError(error, 'The offline tag subscription could not be removed.').slice(0, 512)
    if (policyMutationCommitted) {
      policyError.value = `The offline tag subscription was removed locally, but offline sync failed: ${detail}`
    } else {
      policyError.value = detail
    }
    emit('error', policyError.value)
    await loadRecords({ preservePolicyError: true })
  } finally {
    policyMutationLoading.value = false
  }
}

const refreshOfflineSync = async (): Promise<void> => {
  if (policyMutationLoading.value || refreshing.value) return
  refreshing.value = true
  policyError.value = ''
  try {
    const syncResult: OfflineSyncResult = offlineSyncService
      ? await offlineSyncService.reconcile('manual')
      : createOfflineSyncUnavailableResult('Offline synchronization is unavailable.')
    if (syncResult.outcome === 'error' || syncResult.outcome === 'unavailable') {
      const detail = offlineSyncResultDetail(syncResult, 'Offline synchronization could not be refreshed.')
      policyError.value = syncResult.outcome === 'unavailable'
        ? `Offline sync is unavailable: ${detail}`
        : `Offline sync could not be refreshed: ${detail}`
      emit('error', policyError.value)
      await loadRecords({ preservePolicyError: true })
      return
    }
    await loadRecords()
  } catch (error) {
    policyError.value = normalizeError(error, 'Offline sync could not be refreshed.').slice(0, 512)
    emit('error', policyError.value)
    await loadRecords({ preservePolicyError: true })
  } finally {
    refreshing.value = false
  }
}
const retryMissingPage = async (page: OfflinePagePolicyRecord): Promise<void> => {
  if (refreshing.value || policyMutationLoading.value || removingKey.value) return
  if (page.availability !== 'ineligible') {
    await refreshOfflineSync()
    return
  }
  const storage = props.storage
  if (!storage || storageUnavailable.value) {
    policyError.value = storageUnavailable.value
      ? props.storageMessage ?? 'Saved pages are unavailable on this device right now.'
      : 'Offline storage is unavailable.'
    emit('error', policyError.value)
    return
  }
  policyMutationLoading.value = true
  policyError.value = ''
  let resetCommitted = false
  try {
    const generation = sessionGeneration.value ?? await storage.currentSessionGeneration()
    const current = await storage.readOfflinePolicy({ expectedSessionGeneration: generation })
    const currentPage = current.pages.find(candidate => recordKey(candidate) === recordKey(page))
    if (!currentPage || currentPage.excluded) return
    await storage.setPageAvailability(
      { siteId: currentPage.siteId, pageId: currentPage.pageId, locale: currentPage.locale },
      'unknown',
      {
        expectedSessionGeneration: generation,
        expectedPolicyRevision: current.state.policyRevision
      }
    )
    resetCommitted = true
    emit('changed')
  } catch (error) {
    policyError.value = normalizeError(error, 'The denied page could not be queued for another attempt.').slice(0, 512)
    emit('error', policyError.value)
    await loadRecords({ preservePolicyError: true })
  } finally {
    policyMutationLoading.value = false
  }
  if (resetCommitted) await refreshOfflineSync()
}

const removeMissingPage = async (page: OfflinePagePolicyRecord): Promise<void> => {
  const storage = props.storage
  if (!storage || removingKey.value || refreshing.value || policyMutationLoading.value) return
  const key = recordKey(page)
  const visible = missingPolicyPages.value.map(item => item.page)
  const index = visible.findIndex(candidate => recordKey(candidate) === key)
  const focusedRow = document.activeElement instanceof HTMLElement && document.activeElement.closest(`[data-offline-record-key="${recordDomKey(page)}"]`)
  if (focusedRow && index >= 0) {
    const next = visible.slice(index + 1).find(candidate => !isSameOfflinePage(candidate, page))
    const previous = visible.slice(0, index).reverse().find(candidate => !isSameOfflinePage(candidate, page))
    focusAfterRemove.value = {
      nextKey: next ? recordKey(next) : null,
      previousKey: previous ? recordKey(previous) : null
    }
  }
  removingKey.value = key
  policyMutationLoading.value = true
  let removalCommitted = false
  try {
    try {
      const generation = sessionGeneration.value ?? await storage.currentSessionGeneration()
      const currentPolicy = await storage.readOfflinePolicy({ expectedSessionGeneration: generation })
      await storage.removeOfflinePage(
        { siteId: page.siteId, pageId: page.pageId, locale: page.locale },
        {
          expectedSessionGeneration: generation,
          expectedPolicyRevision: currentPolicy.state.policyRevision
        }
      )
      removalCommitted = true
    } catch (error) {
      emit('error', normalizeError(error, 'The selected page could not be removed.'))
    }
    if (!removalCommitted) return
    removeLocalPageProjection(page)
    emit('changed')
    await reconcileAfterCommittedRemoval()
  } finally {
    policyMutationLoading.value = false
    if (removingKey.value === key) removingKey.value = null
    if (removalCommitted) await focusAfterRemoval()
  }
}

const invalidateLocalProjection = (): void => {
  const key = readerOpenerKey.value ?? selectedKey.value
  const opener = readerOpener.value
  ++loadToken
  ++searchRequestId
  ++readerToken
  preparationController?.abort()
  preparationController = null
  searchController?.abort()
  searchController = null
  records.value = []
  searchResults.value = []
  searchHasMore.value = false
  corpus.value = null
  preparedCorpus.value = null
  corpusRevision.value = null
  sessionGeneration.value = null
  policy.value = null
  policyLoading.value = false
  hasCorpus.value = false
  loading.value = false
  searching.value = false
  loadError.value = ''
  searchError.value = ''
  renderTarget.value?.replaceChildren()
  selectedKey.value = null
  selectedHeading.value = null
  readerState.value = 'idle'
  readerMessage.value = ''
  shareStatus.value = ''
  copyFallbackText.value = ''
  requestedSelectorConsumed.value = null
  readerOpener.value = null
  readerOpenerKey.value = null
  historyMode.value = 'none'
  focusAfterRemove.value = null
  clearOfflineSelector()
  if (key || opener) void restoreReaderFocus(key, opener)
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

watch(() => Boolean(policyMutationLoading.value || refreshing.value || removingKey.value), value => emit('busy', value), { flush: 'sync' })

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
  if (records.value.some((record: OfflineSnapshotRecord) => isExpired(record))) void loadRecords()
})

onMounted(() => {
  clockTimer = window.setInterval(() => { clock.value = Date.now() }, 60_000)
  window.addEventListener('popstate', handlePopState)
  unsubscribeStorageChanges = subscribeOfflineStorageChanges(notice => {
    if (notice.kind === 'generation') {
      invalidateLocalProjection()
      void loadRecords()
      return
    }
    if (notice.kind !== 'policy' && notice.kind !== 'corpus') return
    void loadRecords({ preservePolicyError: Boolean(policyError.value) })
  })
  void loadRecords()
})

onBeforeUnmount(() => {
  ++loadToken
  ++searchRequestId
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
    <div v-if="!selectedRecord" class="library-heading">
      <div>
        <h2 id="downloaded-pages-title">Saved pages</h2>
      </div>
      <span class="count-note" aria-label="Saved page count">{{ hasCorpus ? activeRecords.length : '—' }}</span>
    </div>

    <p v-if="!selectedRecord" class="scope-note">Pages available on this device. Your saved copies stay available while the connection is interrupted.</p>
    <div v-if="!selectedRecord" class="search-field">
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
    <section v-if="showSettings" class="offline-policy" aria-labelledby="offline-policy-title">
      <div class="policy-heading">
        <div>
          <p class="section-kicker">Policy <span aria-hidden="true">03</span></p>
          <h3 id="offline-policy-title">Offline sync controls</h3>
        </div>
        <button class="text-button" type="button" :disabled="storageUnavailable || storageChecking || policyLoading || policyMutationLoading || refreshing" @click="refreshOfflineSync">
          {{ policyLoading || refreshing ? 'Refreshing…' : 'Refresh sync' }}
        </button>
      </div>
      <label class="policy-toggle">
        <input
          type="checkbox"
          :checked="automaticSavingEnabled"
          :disabled="storageUnavailable || storageChecking || policyLoading || policyMutationLoading || refreshing"
          @change="toggleAutomaticSaving"
        />
        <span>
          <strong>Save frequently visited and recently edited pages</strong>
          <small>Off by default. Save up to 10 eligible public pages, including your most recently edited page and the pages you visit most within 60 days. Removing a page excludes it from automatic saving and makes room for another. Manual saves and followed tags are managed separately.</small>
        </span>
      </label>
      <div class="policy-tags">
        <div class="policy-tags-heading">
          <strong>Followed tags</strong>
          <a class="text-button" href="/tags">Browse tags</a>
        </div>
        <span v-if="!selectedTags.length" class="policy-muted">None yet</span>
        <button
          v-for="tag in selectedTags"
          :key="`offline-tag-${tag}`"
          class="policy-tag"
          type="button"
          :aria-label="`Unfollow ${tag}`"
          :disabled="storageUnavailable || storageChecking || policyLoading || policyMutationLoading || refreshing"
          @click="removeSelectedTag(tag)"
        >
          #{{ tag }} <span aria-hidden="true">×</span>
        </button>
      </div>
      <p class="policy-diagnostics" role="status" aria-live="polite">{{ syncDiagnosticsDetail }}</p>
      <p v-if="policyError" class="library-inline-error" role="alert">{{ policyError }}</p>
    </section>
    <section v-if="showSettings && missingPolicyPages.length" class="offline-policy missing-pages" aria-labelledby="missing-pages-title">
      <div class="policy-heading">
        <div>
          <p class="section-kicker">Needs attention <span aria-hidden="true">04</span></p>
          <h3 id="missing-pages-title">Selected pages without a saved copy</h3>
        </div>
        <span class="policy-muted">{{ missingPolicyPages.length }} waiting</span>
      </div>
      <p class="policy-muted">These public pages are selected by an offline policy, but this device has no usable snapshot yet. Only the page identifier, locale, and saved policy sources are shown here.</p>
      <ul class="missing-page-list">
        <li v-for="entry in missingPolicyPages" :key="entry.page.key" class="missing-page-item">
          <div class="missing-page-main">
            <strong>Page #{{ entry.page.pageId }} · {{ entry.page.locale }}</strong>
            <span class="missing-page-status" :data-state="entry.status">{{ missingPolicyStatusLabel(entry.status) }}</span>
            <small>Sources: {{ provenanceLabelForPolicy(entry.page) }}</small>
          </div>
          <div class="missing-page-actions">
            <button
              class="secondary-button"
              type="button"
              :disabled="storageUnavailable || storageChecking || policyLoading || policyMutationLoading || refreshing || Boolean(removingKey)"
              @click="retryMissingPage(entry.page)"
            >
              {{ refreshing || policyLoading ? 'Refreshing…' : 'Retry sync' }}
            </button>
            <button
              class="text-button"
              type="button"
              :data-offline-record-key="recordDomKey(entry.page)"
              :disabled="storageUnavailable || storageChecking || policyLoading || policyMutationLoading || refreshing || Boolean(removingKey)"
              @click="removeMissingPage(entry.page)"
            >
              {{ removingKey === recordKey(entry.page) ? 'Removing…' : 'Remove / exclude' }}
            </button>
          </div>
        </li>
      </ul>
    </section>

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
          <p class="section-kicker">Saved on this device</p>
          <h1 id="offline-reader-title" ref="selectedHeading" tabindex="-1">{{ selectedSnapshot.title || 'Untitled page' }}</h1>
        </div>
        <div class="reader-actions" aria-label="Saved page actions">
          <button v-if="canUseNativeShare" class="text-button" type="button" :disabled="sharing || !readerReady" @click="shareSelected">
            {{ sharing ? 'Sharing…' : 'Share page' }}
          </button>
          <button class="text-button" type="button" :disabled="!readerReady" @click="copySelectedLink">Copy page link</button>
          <button class="text-button" type="button" :disabled="!readerReady" @click="copySelectedText">Copy full page text</button>
          <button class="text-button" type="button" @click="closeRecord()">Back to saved pages</button>
        </div>
      </div>
      <p v-if="selectedSnapshot.description" class="reader-description">{{ selectedSnapshot.description }}</p>
      <p class="reader-meta">
        <span>{{ selectedSnapshot.locale }}</span><span aria-hidden="true"> · </span><bdi>{{ selectedSnapshot.path }}</bdi><span aria-hidden="true"> · </span><span>Saved version</span><span aria-hidden="true"> </span><bdi>{{ selectedSnapshot.sourceRevision }}</bdi><span aria-hidden="true"> · </span>{{ expiryLabel(selectedRecord) }}
      </p>
      <p v-if="showSettings" class="reader-meta reader-policy-meta">
        <span>Provenance: {{ provenanceLabel(selectedRecord) }}</span><span aria-hidden="true"> · </span><span>Availability: {{ availabilityLabel(selectedRecord) }}</span>
      </p>
      <p v-if="storageUnavailable || loadError" class="library-inline-error" role="alert">
        <span>{{ storageUnavailable ? libraryMessage : loadError }}</span>
        <button class="text-button" type="button" @click="retryStorage">Retry saved pages</button>
      </p>
      <p id="offline-reader-status" class="reader-status" :class="`is-${readerState}`" role="status" aria-live="polite" aria-atomic="true">{{ readerMessage }}</p>
      <div ref="renderTarget" class="offline-page-body contents" aria-label="Saved page content" :aria-busy="readerState === 'loading' ? 'true' : 'false'"></div>
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
      <small>Automatic saving is opt-in and includes frequently visited pages and your most recently edited eligible page. Manual downloads and followed tags are listed with their sources above.</small>
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
              <span>Provenance: {{ provenanceLabel(record) }}</span>
              <span>Availability: {{ availabilityLabel(record) }}</span>
            </span>
            <span class="page-card-expiry" :data-expiring="isExpiringSoon(record) ? 'soon' : 'current'">{{ expiryLabel(record) }}</span>
          </div>
          <div class="page-card-actions">
            <button class="secondary-button" type="button" :data-offline-record-key="recordDomKey(record)" :aria-label="`Open saved page ${record.snapshot.title || 'Untitled page'}`" @click="openRecord(record, $event)">Open page</button>
            <button v-if="showSettings" class="text-button" type="button" :disabled="removingKey === recordKey(record) || policyMutationLoading || refreshing" @click="removeRecord(record)">
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
  --offline-paper: rgb(var(--v-theme-background));
  --offline-paper-raised: var(--wiki-surface-raised);
  --offline-paper-sunken: rgb(var(--v-theme-surface-variant));
  --offline-ink: rgb(var(--v-theme-on-surface));
  --offline-muted: var(--wiki-muted);
  --offline-faint: var(--wiki-muted);
  --offline-accent: rgb(var(--v-theme-primary));
  --offline-accent-strong: var(--wiki-accent-ink);
  --offline-warm: var(--wiki-accent-warm);
  --offline-border: var(--wiki-surface-border);
  --offline-border-strong: var(--wiki-surface-border);
  --offline-focus: rgb(var(--v-theme-primary));
  --offline-shadow: var(--wiki-shadow-sm);
  --offline-shadow-small: var(--wiki-shadow-xs);
  --offline-radius: 12px;
  --offline-mono: var(--wiki-font-body);
  --offline-body: var(--wiki-font-body);
  --offline-heading: var(--wiki-font-display);
  color: var(--offline-ink);
}
button { font: inherit; cursor: pointer; min-height: 44px; }
button:disabled { cursor: not-allowed; opacity: .55; }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--offline-focus); outline-offset: 3px; }
.secondary-button, .text-button { padding: .5rem .8rem; border-radius: 8px; color: var(--offline-accent-strong); }
.secondary-button { border: 1px solid var(--offline-border); background: var(--offline-paper-raised); }
.text-button { border: 0; background: transparent; }
.offline-reader h1 { font-family: var(--wiki-font-display); font-size: clamp(2rem, 4vw, 3rem); line-height: 1.16; }
.reader-actions { flex-wrap: wrap; }

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
.offline-policy {
  display: grid;
  gap: .8rem;
  margin-block: .95rem .8rem;
  padding: 1rem;
  border: 1px solid var(--offline-border-strong);
  border-radius: .7rem;
  background: var(--offline-paper-sunken);
}
.missing-pages {
  gap: .65rem;
  margin-block-start: .65rem;
  padding: .8rem;
}

.missing-pages > .policy-muted {
  margin: 0;
}

.missing-page-list {
  display: grid;
  gap: .45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.missing-page-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: .65rem 1rem;
  align-items: center;
  padding: .65rem .7rem;
  border: 1px solid var(--offline-border);
  border-radius: .55rem;
  background: var(--offline-paper);
}

.missing-page-main {
  display: grid;
  gap: .2rem;
  min-inline-size: 0;
}

.missing-page-main strong {
  color: var(--offline-ink);
  font-family: var(--offline-mono);
  font-size: .78rem;
  letter-spacing: .02em;
}

.missing-page-main small {
  color: var(--offline-faint);
  font-size: .74rem;
  line-height: 1.4;
}

.missing-page-status {
  color: var(--offline-accent-strong);
  font-family: var(--offline-mono);
  font-size: .72rem;
  line-height: 1.35;
}

.missing-page-status[data-state='denied'],
.missing-page-status[data-state='stale'] { color: var(--offline-warm); }

.missing-page-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .35rem .6rem;
  align-items: center;
  justify-content: flex-end;
}

.missing-page-actions .secondary-button,
.missing-page-actions .text-button {
  min-block-size: 2.35rem;
}

.policy-heading {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  justify-content: space-between;
}

.policy-heading h3 {
  margin-block-start: .2rem;
  font-size: 1.15rem;
  letter-spacing: -.025em;
}

.policy-toggle {
  display: flex;
  gap: .7rem;
  align-items: flex-start;
  color: var(--offline-ink);
  cursor: pointer;
}

.policy-toggle input {
  flex: 0 0 auto;
  inline-size: 1.1rem;
  block-size: 1.1rem;
  margin-block-start: .15rem;
  accent-color: var(--offline-warm);
}

.policy-toggle span {
  display: grid;
  gap: .25rem;
}

.policy-toggle strong {
  font-size: .9rem;
  line-height: 1.35;
}

.policy-toggle small,
.policy-diagnostics,
.policy-muted {
  color: var(--offline-muted);
  font-size: .78rem;
  line-height: 1.5;
}

.policy-tags {
  display: flex;
  flex-wrap: wrap;
  gap: .45rem;
  align-items: center;
  padding-block-start: .35rem;
  border-block-start: 1px solid var(--offline-border);
}

.policy-tags-heading {
  display: flex;
  flex: 1 1 100%;
  gap: .75rem;
  align-items: center;
  justify-content: space-between;
}

.policy-tags-heading strong {
  color: var(--offline-muted);
  font-family: var(--offline-mono);
  font-size: .72rem;
  letter-spacing: .04em;
  text-transform: uppercase;
}

.policy-tag {
  min-block-size: 2rem;
  padding: .35rem .6rem;
  border: 1px solid var(--offline-border-strong);
  border-radius: 999px;
  background: var(--offline-paper);
  color: var(--offline-ink);
  cursor: pointer;
  font-family: var(--offline-mono);
  font-size: .75rem;
}

.policy-tag:disabled,
.policy-heading .text-button:disabled {
  cursor: wait;
  opacity: .55;
}

.policy-diagnostics {
  margin: 0;
}

.reader-policy-meta {
  margin-block-start: -.35rem;
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
.reader-heading h1 { max-inline-size: 34ch; overflow-wrap: anywhere; }

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
  margin-block-start: 1.5rem;
  max-width: var(--wiki-reader-copy-width, 85ch);
  overflow-wrap: anywhere;
}

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
  .reader-heading,
  .policy-heading { flex-direction: column; gap: .55rem; }
  .missing-page-item { grid-template-columns: 1fr; }
  .missing-page-actions { justify-content: flex-start; }
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
  .missing-page-item,
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
