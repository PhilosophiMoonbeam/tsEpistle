<template>
  <div class="agent-context" aria-label="Sources and search scope">
    <div class="agent-context__scope" role="group" aria-label="Conversation source controls">
      <v-menu content-class="agent-owned-overlay" location="top start">
        <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" class="agent-context__control agent-context__scope-control" :disabled="disabled || connectionBlocked" variant="text" rounded="pill" size="small" prepend-icon="mdi-text-search" append-icon="mdi-chevron-down" aria-label="Choose Agent search scope" type="button">{{ scopeLabel }}</v-btn></template>
        <v-list density="compact" aria-label="Agent search scope">
          <v-list-item title="All Wiki" subtitle="Search every page you can access" prepend-icon="mdi-earth" :active="draft.scope.kind === 'all'" :disabled="disabled || connectionBlocked" @click="setScope({ kind: 'all' })" />
          <v-list-item v-if="currentPage" title="This page tree" :subtitle="currentPage.path" prepend-icon="mdi-file-tree-outline" :active="draft.scope.kind === 'section'" :disabled="disabled || connectionBlocked" @click="setScope({ kind: 'section', locale: currentPage.locale, path: currentPage.path })" />
          <v-list-item title="Selected pages" subtitle="Search within the sources attached here" prepend-icon="mdi-file-multiple-outline" :disabled="disabled || connectionBlocked || !draft.sources.length" :active="draft.scope.kind === 'selected'" @click="setScope({ kind: 'selected' })" />
        </v-list>
      </v-menu>
      <v-btn
        ref="sourcesActivator"
        class="agent-context__control agent-context__sources-control"
        size="small"
        variant="text"
        rounded="pill"
        prepend-icon="mdi-plus"
        :disabled="disabled || connectionBlocked"
        type="button"
        aria-label="Add sources"
        @click="openSources"
      ><span aria-hidden="true">Sources</span></v-btn>
    </div>
    <!-- One compact source chip for the current page. The chip itself means the
         page is included, so no separate Included badge is rendered. -->
    <button
      v-if="currentPage"
      type="button"
      class="agent-context__page-chip"
      :class="{ 'agent-context__page-chip--excluded': !draft.includeCurrentPage }"
      :disabled="disabled || connectionBlocked"
      :aria-pressed="draft.includeCurrentPage"
      :aria-label="draft.includeCurrentPage
        ? `Current page ${currentPage.locale}/${currentPage.path} is included in the next message; activate to exclude it`
        : `Current page ${currentPage.locale}/${currentPage.path} is excluded from the next message; activate to include it`"
      :title="draft.includeCurrentPage ? 'Included in the next message. Activate to exclude this page.' : 'Excluded from the next message. Activate to include this page.'"
      @click="emit('change', { includeCurrentPage: !draft.includeCurrentPage })"
    >
      <v-icon icon="mdi-file-link-outline" size="15" aria-hidden="true" />
      <span class="agent-context__page-copy" :title="`${currentPage.locale}/${currentPage.path}`">
        <strong>{{ currentPage.locale.toUpperCase() }}</strong>
        <span aria-hidden="true"> · </span>
        {{ currentPage.path }}
      </span>
      <v-icon
        class="agent-context__page-state"
        :icon="draft.includeCurrentPage ? 'mdi-check' : 'mdi-minus'"
        size="14"
        aria-hidden="true"
      />
    </button>
    <div v-if="draft.sources.length" class="agent-context__sources" aria-label="Pages attached to the next message">
      <v-chip v-for="source in draft.sources" :key="source.id" size="small" closable :disabled="disabled || connectionBlocked" :close-label="`Remove source ${source.title}`" :aria-label="`Preview attached source ${source.title}`" variant="outlined" prepend-icon="mdi-file-document-outline" @click.stop="previewSelector = { id: source.id }" @click:close.stop="removeSource(source.id)"><span class="agent-context__source-label">{{ source.title }}</span></v-chip>
    </div>
    <p v-if="draft.sources.length === 8" class="agent-context__limit" role="status">Eight sources attached. Remove one to add another.</p>
    <WikiSourcePreview v-if="previewSelector" :selector="previewSelector" @close="previewSelector = null" />

    <v-dialog
      content-class="agent-owned-overlay"
      :model-value="sourcesOpen"
      max-width="52rem"
      scrollable
      :aria-labelledby="`${sourceDialogId}-title`"
      :aria-describedby="`${sourceDialogId}-description`"
      @update:model-value="handleSourcesModel"
      @after-enter="focusSourceSearch"
      @after-leave="onSourcesAfterLeave"
    >
      <v-card class="agent-context__dialog" :aria-busy="addingSources">
        <header class="agent-context__dialog-header">
          <span class="agent-context__dialog-mark" aria-hidden="true"><v-icon icon="mdi-file-multiple-outline" size="22" /></span>
          <div>
            <h2 :id="`${sourceDialogId}-title`">Add sources</h2>
            <p :id="`${sourceDialogId}-description`">Search All Wiki to attach pages. This does not change the Agent search scope.</p>
          </div>
          <v-btn icon="mdi-close" variant="text" aria-label="Cancel adding sources" type="button" @click="cancelSources" />
        </header>
        <v-card-text class="agent-context__dialog-body">
          <p class="agent-context__dialog-guidance">Select up to eight pages to attach to this conversation. Your pending selections stay here while you search or load more results.</p>
          <v-alert v-if="connectionBlocked" class="agent-context__connection-alert" type="warning" variant="tonal" density="compact" role="status">
            <span>Connection required to search or attach sources.</span>
            <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :loading="connectionRetrying" :disabled="connectionRetrying" type="button" @click="emit('retry-connection')">Retry connection</v-btn>
          </v-alert>
          <v-text-field
            ref="sourceSearchInput"
            v-model="sourceQuery"
            class="agent-context__search"
            label="Search pages"
            placeholder="Search titles, paths, or page content"
            prepend-inner-icon="mdi-magnify"
            clearable
            hide-details="auto"
            autocomplete="off"
            :disabled="addingSources || disabled || connectionBlocked"
            @keydown.enter.prevent="queueSourceSearch(true)"
          />
          <p class="agent-context__search-scope" role="note"><v-icon icon="mdi-earth" size="15" aria-hidden="true" /> Attachments are discovered across All Wiki; your existing Agent scope remains {{ scopeLabel }}.</p>
          <p class="agent-context__status" role="status" aria-live="polite" aria-atomic="true">{{ sourceStatus }}</p>
          <v-alert v-if="searchError || attachmentError" class="agent-context__error" type="error" variant="tonal" density="compact" role="alert">
            {{ attachmentError || searchError }}
          </v-alert>

          <section v-if="selectedRows.length" class="agent-context__pending" aria-labelledby="agent-sources-pending-title">
            <div class="agent-context__pending-heading">
              <h3 id="agent-sources-pending-title">Pending additions</h3>
              <span>{{ selectedRows.length }} of 8</span>
            </div>
            <div class="agent-context__pending-list">
              <v-chip v-for="row in selectedRows" :key="rowIdentity(row)" closable size="small" variant="tonal" :disabled="addingSources || disabled || connectionBlocked" :close-label="`Remove ${row.title} from pending sources`" @click:close="removePending(row)">
                <span class="agent-context__pending-label">{{ row.title }}<small>{{ row.locale }} · {{ row.path }}</small></span>
              </v-chip>
            </div>
          </section>

          <div class="agent-context__results" aria-label="Page search results">
            <div v-if="searchLoading" class="agent-context__results-state" role="status"><v-progress-circular indeterminate size="20" width="2" aria-hidden="true" /> Searching pages…</div>
            <div v-else-if="!sourceQuery.trim() || sourceQuery.trim().length < 2" class="agent-context__results-state">Enter at least two characters to search pages.</div>
            <div v-else-if="!sourceResult.results.length" class="agent-context__results-state">No accessible pages matched this search.</div>
            <ul v-else class="agent-context__result-list">
              <li v-for="row in sourceResult.results" :key="rowIdentity(row)" class="agent-context__result">
                <label class="agent-context__result-label" :class="{ 'agent-context__result-label--disabled': !canToggle(row) }" :title="toggleReason(row)">
                  <input
                    type="checkbox"
                    :checked="isAttached(row) || isPending(row)"
                    :disabled="!canToggle(row)"
                    :aria-label="rowAriaLabel(row)"
                    :aria-describedby="rowDomId(row)"
                    @change="toggleSource(row, $event)"
                  />
                  <span class="agent-context__checkbox" aria-hidden="true" />
                  <span class="agent-context__result-copy">
                    <strong>{{ row.title }}</strong>
                    <small :id="rowDomId(row)">{{ row.locale }} · {{ row.path }}<span v-if="row.visibility === 'private'"> · Private</span></small>
                    <span v-if="isAttached(row)" class="agent-context__result-state-label">Attached</span>
                    <span v-else-if="isPending(row)" class="agent-context__result-state-label">Pending</span>
                    <span v-else-if="atCapacity" class="agent-context__result-state-label">Eight-source limit reached</span>
                  </span>
                </label>
              </li>
            </ul>
          </div>
          <p v-if="sourceResult.windowTruncated" class="agent-context__window-note" role="status">Showing a bounded result window{{ sourceResult.windowLimit ? ` of ${sourceResult.windowLimit}` : '' }}. Refine the search to find other pages.</p>
          <p v-if="moreError" class="agent-context__more-error" role="alert">{{ moreError }}</p>
          <v-btn
            v-if="sourceResult.nextCursor"
            class="agent-context__more"
            variant="text"
            :loading="loadingMore"
            :disabled="loadingMore || addingSources || disabled || connectionBlocked"
            type="button"
            @click="loadMoreSources"
          >More results</v-btn>
        </v-card-text>
        <v-card-actions class="agent-context__dialog-actions">
          <v-btn variant="text" type="button" @click="cancelSources">Cancel</v-btn>
          <v-spacer />
          <v-btn color="primary" variant="flat" :loading="addingSources" :disabled="!selectedRows.length || addingSources || disabled || connectionBlocked" type="button" @click="addSources">
            {{ selectedRows.length ? `Add ${selectedRows.length} source${selectedRows.length === 1 ? '' : 's'} and return` : 'Add sources and return' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { AgentDraft, AgentSearchScope } from '../../helpers/agent-draft.ts'
import { searchPages, type PageSearchResult, type PageSearchRow } from '../../helpers/pages-api.ts'
import { fetchWikiSource } from '../../helpers/wiki-source.ts'
import type { AgentCurrentPageHint } from '../../../shared/agents/contracts.ts'
import { AgentKnowledgeContextSchema } from '../../../shared/agents/knowledge-context.ts'
import type { WikiSource, WikiSourceSelector } from '../../../shared/wiki-source.ts'
import WikiSourcePreview from '../common/wiki-source-preview.vue'
const emptySearchResult = (): PageSearchResult => ({ results: [], suggestions: [], totalHits: 0, nextCursor: null })
const sourceDialogId = useId()

const props = defineProps<{
  draft: AgentDraft
  currentPage: AgentCurrentPageHint | null
  disabled?: boolean
  connectionBlocked?: boolean
  connectionRetrying?: boolean
}>()
const emit = defineEmits<{
  change: [patch: Partial<AgentDraft>]
  sourcesAdded: []
  'retry-connection': []
}>()

const previewSelector = ref<WikiSourceSelector | null>(null)
const sourcesOpen = ref(false)
const sourceQuery = ref('')
const sourceResult = ref<PageSearchResult>(emptySearchResult())
const selectedRows = ref<PageSearchRow[]>([])
const searchLoading = ref(false)
const loadingMore = ref(false)
const addingSources = ref(false)
const searchError = ref('')
const moreError = ref('')
const attachmentError = ref('')
const successfulClose = ref(false)
const sourceSearchInput = ref<{ focus?: () => void; $el?: HTMLElement } | null>(null)
const sourcesActivator = ref<{ focus?: () => void; $el?: HTMLElement } | HTMLElement | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchController: AbortController | null = null
let disposed = false
let moreController: AbortController | null = null
let resolveController: AbortController | null = null
let requestGeneration = 0
const interactionBlocked = computed(() => Boolean(props.disabled || props.connectionBlocked))

const scopeLabel = computed(() => props.draft.scope.kind === 'selected' ? 'Selected pages' : props.draft.scope.kind === 'section' ? `Within ${props.draft.scope.path}` : props.draft.scope.kind === 'locale' ? `${props.draft.scope.locale.toUpperCase()} pages` : 'All Wiki')
const attachedIds = computed(() => new Set(props.draft.sources.map(source => source.id)))
const atCapacity = computed(() => props.draft.sources.length + selectedRows.value.length >= 8)
const sourceStatus = computed(() => {
  if (addingSources.value) return `Adding ${selectedRows.value.length} source${selectedRows.value.length === 1 ? '' : 's'}…`
  if (searchLoading.value) return 'Searching pages…'
  if (loadingMore.value) return `Loading more results… ${sourceResult.value.results.length} shown`
  if (selectedRows.value.length) return `${selectedRows.value.length} source${selectedRows.value.length === 1 ? '' : 's'} pending. ${sourceResult.value.results.length} result${sourceResult.value.results.length === 1 ? '' : 's'} shown.`
  if (sourceQuery.value.trim().length >= 2) return `${sourceResult.value.results.length} result${sourceResult.value.results.length === 1 ? '' : 's'} shown.`
  return 'No sources selected.'
})

const normalizeSourceId = (value: string | number): number | null => {
  const id = typeof value === 'number' ? value : Number(value.trim())
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
const rowIdentity = (row: PageSearchRow): string => {
  const id = normalizeSourceId(row.id)
  return id === null ? `invalid:${String(row.id)}:${row.locale}:${row.path}` : `id:${id}`
}
const rowId = (row: PageSearchRow): number | null => normalizeSourceId(row.id)
const rowDomId = (row: PageSearchRow): string => `agent-source-row-${rowIdentity(row).replace(/[^A-Za-z0-9_-]/g, '-')}`
const isAttached = (row: PageSearchRow): boolean => {
  const id = rowId(row)
  return id !== null && attachedIds.value.has(id)
}
const dedupeRows = (rows: readonly PageSearchRow[]): PageSearchRow[] => {
  const known = new Set<number>()
  return rows.filter(row => {
    const id = rowId(row)
    if (id === null || known.has(id)) return false
    known.add(id)
    return true
  })
}
const isPending = (row: PageSearchRow): boolean => {
  const id = rowId(row)
  return id !== null && selectedRows.value.some(selected => rowId(selected) === id)
}
const toggleReason = (row: PageSearchRow): string => {
  if (isAttached(row)) return 'Already attached to this conversation'
  if (isPending(row)) return 'Selected; uncheck to remove from pending additions'
  if (rowId(row) === null) return 'This result has an invalid page identity'
  if (atCapacity.value) return 'Eight sources is the maximum; remove a pending or attached source first'
  return ''
}
const canToggle = (row: PageSearchRow): boolean => !addingSources.value && !interactionBlocked.value && !isAttached(row) && (isPending(row) || (!atCapacity.value && rowId(row) !== null))
const rowAriaLabel = (row: PageSearchRow): string => {
  const state = isAttached(row) ? 'Attached' : isPending(row) ? 'Pending addition' : atCapacity.value ? 'Unavailable, eight-source limit reached' : ''
  return `${row.title}, ${row.locale}, ${row.path}${state ? `, ${state}` : ''}`
}
const setScope = (scope: AgentSearchScope): void => {
  if (interactionBlocked.value) return
  emit('change', { scope })
}
const removeSource = (id: number): void => {
  if (interactionBlocked.value) return
  const sources = props.draft.sources.filter(source => source.id !== id)
  emit('change', { sources, ...(props.draft.scope.kind === 'selected' && !sources.length ? { scope: { kind: 'all' } } : {}) })
}
const clearSearchTimer = (): void => {
  if (searchTimer !== null) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
}
const abortDiscovery = (): void => {
  searchController?.abort()
  moreController?.abort()
  searchController = null
  moreController = null
}
const invalidateAll = (): void => {
  requestGeneration += 1
  clearSearchTimer()
  abortDiscovery()
  resolveController?.abort()
  resolveController = null
  searchLoading.value = false
  loadingMore.value = false
  addingSources.value = false
}
const resetTransient = (): void => {
  sourceQuery.value = ''
  sourceResult.value = emptySearchResult()
  selectedRows.value = []
  searchError.value = ''
  moreError.value = ''
  attachmentError.value = ''
}
const focusElement = (target: { focus?: () => void; $el?: HTMLElement } | HTMLElement | null): void => {
  if (target instanceof HTMLElement) {
    target.focus({ preventScroll: true })
    return
  }
  if (target?.focus) {
    target.focus()
    return
  }
  target?.$el?.querySelector<HTMLElement>('input,button')?.focus({ preventScroll: true })
}
const focusSourceSearch = (): void => {
  void nextTick(() => focusElement(sourceSearchInput.value))
}
const openSources = (): void => {
  if (interactionBlocked.value) return
  invalidateAll()
  resetTransient()
  successfulClose.value = false
  sourcesOpen.value = true
}
const cancelSources = (): void => {
  successfulClose.value = false
  sourcesOpen.value = false
  invalidateAll()
  resetTransient()
}
const handleSourcesModel = (open: boolean): void => {
  if (open) {
    if (!interactionBlocked.value) sourcesOpen.value = true
    return
  }
  if (!successfulClose.value) cancelSources()
  else sourcesOpen.value = false
}
const onSourcesAfterLeave = (): void => {
  const completed = successfulClose.value
  successfulClose.value = false
  if (completed) {
    addingSources.value = false
    resetTransient()
    emit('sourcesAdded')
    return
  }
  void nextTick(() => focusElement(sourcesActivator.value))
}
const queueSourceSearch = (immediate = false): void => {
  if (!sourcesOpen.value || interactionBlocked.value || addingSources.value) return
  clearSearchTimer()
  abortDiscovery()
  requestGeneration += 1
  const generation = requestGeneration
  const query = sourceQuery.value.trim()
  sourceResult.value = emptySearchResult()
  searchError.value = ''
  moreError.value = ''
  searchLoading.value = query.length >= 2
  loadingMore.value = false
  if (query.length < 2) return
  if (immediate) {
    void runSearch(query, generation)
    return
  }
  searchTimer = setTimeout(() => {
    searchTimer = null
    void runSearch(query, generation)
  }, 300)
}
const runSearch = async (query: string, generation: number): Promise<void> => {
  if (disposed || !sourcesOpen.value || interactionBlocked.value || generation !== requestGeneration || query.length < 2) return
  const controller = new AbortController()
  searchController = controller
  searchLoading.value = true
  try {
    const response = await searchPages(
      (url, init) => window.fetch(url, { ...init, signal: controller.signal }),
      query,
      { paginated: true }
    )
    if (disposed || controller.signal.aborted || interactionBlocked.value || generation !== requestGeneration || !sourcesOpen.value) return
    sourceResult.value = { ...response, results: dedupeRows(response.results) }
  } catch (value) {
    if (disposed || controller.signal.aborted || interactionBlocked.value || generation !== requestGeneration || !sourcesOpen.value) return
    searchError.value = value instanceof Error ? value.message : 'Page search could not be completed.'
  } finally {
    if (searchController === controller) searchController = null
    if (generation === requestGeneration) searchLoading.value = false
  }
}
const loadMoreSources = async (): Promise<void> => {
  if (disposed || loadingMore.value || addingSources.value || interactionBlocked.value || !sourceResult.value.nextCursor || sourceQuery.value.trim().length < 2) return
  const generation = requestGeneration
  const query = sourceQuery.value.trim()
  const cursor = sourceResult.value.nextCursor
  if (!cursor) return
  const controller = new AbortController()
  moreController = controller
  loadingMore.value = true
  moreError.value = ''
  try {
    const next = await searchPages(
      (url, init) => window.fetch(url, { ...init, signal: controller.signal }),
      query,
      { paginated: true, cursor }
    )
    if (disposed || controller.signal.aborted || interactionBlocked.value || generation !== requestGeneration || !sourcesOpen.value || query !== sourceQuery.value.trim()) return
    const existingResults = dedupeRows(sourceResult.value.results)
    const existingIds = new Set(existingResults.map(row => rowId(row)))
    const added = dedupeRows(next.results).filter(row => {
      const id = rowId(row)
      return id !== null && !existingIds.has(id)
    })
    sourceResult.value = { ...next, results: [...existingResults, ...added] }
  } catch (value) {
    if (disposed || controller.signal.aborted || interactionBlocked.value || generation !== requestGeneration || !sourcesOpen.value) return
    moreError.value = value instanceof Error ? value.message : 'More results could not be loaded. Try again.'
  } finally {
    if (moreController === controller) moreController = null
    if (generation === requestGeneration) loadingMore.value = false
  }
}
const removePending = (row: PageSearchRow): void => {
  const id = rowId(row)
  if (interactionBlocked.value || id === null || addingSources.value) return
  selectedRows.value = selectedRows.value.filter(selected => rowId(selected) !== id)
  attachmentError.value = ''
}
const toggleSource = (row: PageSearchRow, event: Event): void => {
  const checked = (event.target as HTMLInputElement | null)?.checked ?? false
  const id = rowId(row)
  if (id === null || addingSources.value || interactionBlocked.value || isAttached(row)) return
  if (checked) {
    if (isPending(row)) return
    if (props.draft.sources.length + selectedRows.value.length >= 8) {
      attachmentError.value = 'Eight sources is the maximum. Remove one before selecting another.'
      return
    }
    selectedRows.value = [...selectedRows.value, row]
  } else {
    selectedRows.value = selectedRows.value.filter(selected => rowId(selected) !== id)
  }
  attachmentError.value = ''
}
const transactionError = (row: PageSearchRow, value: unknown): Error => {
  const message = value instanceof Error && value.message ? value.message : 'This source could not be loaded.'
  return new Error(`${row.title}: ${message}`)
}
const addSources = async (): Promise<void> => {
  if (disposed || !sourcesOpen.value || interactionBlocked.value || addingSources.value || !selectedRows.value.length) return
  const pending = [...selectedRows.value]
  const query = sourceQuery.value.trim()
  const controller = new AbortController()
  resolveController = controller
  abortDiscovery()
  addingSources.value = true
  attachmentError.value = ''
  try {
    const hydrated = await Promise.all(pending.map(async row => {
      const id = rowId(row)
      if (id === null) throw transactionError(row, new Error('The page identity is invalid.'))
      try {
        const source = await fetchWikiSource({ id }, query, controller.signal)
        if (source.id !== id) throw new Error('The returned page identity did not match the selected page.')
        return source
      } catch (value) {
        if (controller.signal.aborted) throw value
        throw transactionError(row, value)
      }
    }))
    if (disposed || controller.signal.aborted || resolveController !== controller || interactionBlocked.value || !sourcesOpen.value) return
    const currentSources = [...props.draft.sources]
    const currentIds = new Set(currentSources.map(source => source.id))
    const additions = hydrated.filter(source => !currentIds.has(source.id))
    if (currentSources.length + additions.length > 8) {
      throw new Error('The conversation already has eight attached sources. Remove one and try again.')
    }
    const mergedSources: WikiSource[] = [...currentSources, ...additions]
    const context = AgentKnowledgeContextSchema.safeParse({
      scope: props.draft.scope,
      sources: mergedSources.map(source => ({
        id: source.id,
        locale: source.locale,
        path: source.path,
        title: source.title,
        visibility: source.visibility,
        sourceRevision: source.sourceRevision
      }))
    })
    if (!context.success) throw new Error(context.error.issues[0]?.message || 'The selected sources do not fit the Agent context limits.')
    if (disposed || controller.signal.aborted || resolveController !== controller || interactionBlocked.value || !sourcesOpen.value) return
    emit('change', { sources: mergedSources })
    successfulClose.value = true
    sourcesOpen.value = false
  } catch (value) {
    if (disposed || controller.signal.aborted || resolveController !== controller || interactionBlocked.value || !sourcesOpen.value) return
    attachmentError.value = value instanceof Error ? value.message : 'The selected sources could not be added. Deselect the failing page and try again.'
  } finally {
    if (resolveController === controller) {
      resolveController = null
      if (sourcesOpen.value) addingSources.value = false
    }
  }
}
watch(() => sourceQuery.value, () => queueSourceSearch())
watch([() => props.disabled, () => props.connectionBlocked], ([disabled, blocked], [previousDisabled, previousBlocked]) => {
  if (disabled || blocked) {
    invalidateAll()
    return
  }
  if ((previousDisabled || previousBlocked) && sourcesOpen.value && sourceQuery.value.trim().length >= 2) queueSourceSearch(true)
})
onBeforeUnmount(() => {
  disposed = true
  invalidateAll()
  sourcesOpen.value = false
})
</script>

<style scoped>
.agent-context {
  --agent-context-control-face-height: var(--agent-composer-control-face-height, max(36px, calc(var(--wiki-control-height, 44px) * .9)));
  --agent-context-control-hit-height: var(--agent-composer-control-hit-height, max(44px, var(--wiki-control-height, 44px)));
  --agent-context-control-hit-inset: calc((var(--agent-context-control-hit-height) - var(--agent-context-control-face-height)) / -2);
  display: contents;
}
.agent-context__scope {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex: 0 1 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: var(--wiki-space-1);
}
.agent-context__scope :deep(.v-btn__content) { max-width: min(28rem, 65vw); overflow: hidden; text-overflow: ellipsis; }
.agent-context__control {
  position: relative;
  box-sizing: border-box;
  min-width: max(44px, var(--agent-context-control-face-height));
  height: var(--agent-context-control-face-height);
  min-height: var(--agent-context-control-face-height);
  padding-inline: calc(var(--wiki-space-3) * .9);
  border-radius: var(--wiki-radius-pill) !important;
  font-size: var(--v-btn-size, .875rem);
  font-weight: 500;
  letter-spacing: .01em;
}
.agent-context__control::before {
  position: absolute;
  inset-block: var(--agent-context-control-hit-inset);
  inset-inline-start: 50%;
  width: 100%;
  min-width: var(--agent-context-control-hit-height);
  min-height: var(--agent-context-control-hit-height);
  border-radius: inherit;
  content: '';
  pointer-events: auto;
  transform: translateX(-50%);
}
.agent-context__page-chip {
  position: relative;
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  flex: 0 1 auto;
  align-items: center;
  gap: var(--wiki-space-1);
  min-height: var(--agent-context-control-face-height);
  padding: 0 var(--wiki-space-2);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, var(--wiki-surface-raised) 72%, transparent);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 76%, transparent);
  cursor: pointer;
  font: inherit;
  font-size: var(--wiki-label-size);
  line-height: 1.25;
}
.agent-context__page-chip > .v-icon:first-child { flex: 0 0 auto; color: var(--wiki-accent-warm); }
.agent-context__page-chip--excluded {
  border-style: dashed;
  opacity: .72;
}
.agent-context__page-chip--excluded .agent-context__page-copy strong {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
}
.agent-context__page-chip:focus-visible {
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: 2px;
}
.agent-context__page-chip:disabled { cursor: default; }
.agent-context__page-state {
  flex: 0 0 auto;
  color: rgb(var(--v-theme-primary));
}
.agent-context__page-chip--excluded .agent-context__page-state {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 55%, transparent);
}
.agent-context__page-copy {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-context__page-copy strong {
  color: rgb(var(--v-theme-on-surface));
  font-weight: var(--wiki-label-weight);
}
.agent-context__sources {
  display: flex;
  order: 1;
  min-width: 0;
  max-width: 100%;
  max-height: 4rem;
  flex: 1 1 100%;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-1);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.agent-context__sources .v-chip { max-width: 100%; border-radius: var(--wiki-radius-pill); }
.agent-context__source-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-context__limit {
  order: 2;
  flex: 1 1 100%;
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: .72rem;
  line-height: 1.3;
}
.agent-context__dialog { overflow: hidden; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius) !important; background: var(--wiki-surface-raised); }
.agent-context__dialog-header { display: flex; align-items: flex-start; gap: var(--wiki-space-3); padding: var(--wiki-space-5) var(--wiki-space-5) var(--wiki-space-3); border-bottom: 1px solid var(--wiki-surface-border); }
.agent-context__dialog-mark { display: grid; flex: 0 0 auto; width: 2.25rem; height: 2.25rem; place-items: center; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); color: var(--wiki-accent-ink, rgb(var(--v-theme-primary))); }
.agent-context__dialog-header h2 { margin: 0; color: rgb(var(--v-theme-on-surface)); font-family: var(--wiki-font-display); font-size: 1.45rem; font-weight: 500; letter-spacing: -.025em; line-height: 1.15; }
.agent-context__dialog-header p { max-width: 34rem; margin: .3rem 0 0; color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent); font-size: .78rem; line-height: 1.45; }
.agent-context__dialog-body { max-height: min(68vh, 38rem); padding: var(--wiki-space-4) var(--wiki-space-5) var(--wiki-space-2); }
.agent-context__dialog-guidance { margin: 0 0 var(--wiki-space-3); color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 74%, transparent); font-size: .82rem; line-height: 1.5; }
.agent-context__search { margin-bottom: .15rem; }
.agent-context__search-scope { display: flex; align-items: center; gap: .35rem; margin: .25rem 0 0; color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent); font-size: .72rem; line-height: 1.4; }
.agent-context__status { min-height: 1.15rem; margin: .5rem 0 .35rem; color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent); font-size: .74rem; line-height: 1.4; }
.agent-context__error { margin: .45rem 0; }
.agent-context__pending { margin: .6rem 0 .75rem; padding: .65rem .75rem; border: 1px solid color-mix(in srgb, var(--wiki-accent-ink, rgb(var(--v-theme-primary))) 30%, var(--wiki-surface-border)); border-radius: var(--wiki-control-radius); background: color-mix(in srgb, var(--wiki-accent-ink, rgb(var(--v-theme-primary))) 6%, var(--wiki-surface-raised)); }
.agent-context__pending-heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; color: rgb(var(--v-theme-on-surface)); font-size: .76rem; }
.agent-context__pending-heading h3 { margin: 0; font-size: inherit; font-weight: 700; }
.agent-context__pending-heading span { color: color-mix(in srgb, currentColor 70%, transparent); font-size: .7rem; }
.agent-context__pending-list { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .5rem; }
.agent-context__pending-label { display: inline-flex; max-width: 16rem; flex-direction: column; min-width: 0; overflow: hidden; text-align: start; }
.agent-context__pending-label small { overflow: hidden; color: color-mix(in srgb, currentColor 64%, transparent); font-size: .66rem; text-overflow: ellipsis; white-space: nowrap; }
.agent-context__results { min-height: 7rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: color-mix(in srgb, var(--wiki-surface-sunken) 42%, transparent); }
.agent-context__results-state { display: flex; min-height: 7rem; align-items: center; justify-content: center; gap: .55rem; padding: 1rem; color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent); font-size: .8rem; text-align: center; }
.agent-context__result-list { display: grid; margin: 0; padding: 0; list-style: none; }
.agent-context__result + .agent-context__result { border-top: 1px solid var(--wiki-surface-border); }
.agent-context__result-label { display: flex; min-height: 3.65rem; align-items: center; gap: .7rem; padding: .6rem .75rem; cursor: pointer; }
.agent-context__result-label:hover { background: color-mix(in srgb, var(--wiki-accent-ink, rgb(var(--v-theme-primary))) 5%, transparent); }
.agent-context__result-label:focus-within { outline: 2px solid var(--wiki-accent-ink, rgb(var(--v-theme-primary))); outline-offset: -2px; }
.agent-context__result-label--disabled { cursor: not-allowed; opacity: .68; }
.agent-context__result-label input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.agent-context__checkbox { display: grid; flex: 0 0 auto; width: 1.15rem; height: 1.15rem; place-items: center; border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 50%, var(--wiki-surface-border)); border-radius: .25rem; background: var(--wiki-surface-raised); }
.agent-context__result-label input:checked + .agent-context__checkbox { border-color: var(--wiki-accent-ink, rgb(var(--v-theme-primary))); background: var(--wiki-accent-ink, rgb(var(--v-theme-primary))); box-shadow: inset 0 0 0 3px var(--wiki-surface-raised); }
.agent-context__result-copy { display: grid; min-width: 0; gap: .14rem; }
.agent-context__result-copy strong { overflow: hidden; color: rgb(var(--v-theme-on-surface)); font-size: .8rem; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.agent-context__result-copy small { overflow: hidden; color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent); font-size: .7rem; text-overflow: ellipsis; white-space: nowrap; }
.agent-context__result-state-label { color: var(--wiki-accent-ink, rgb(var(--v-theme-primary))); font-size: .68rem; font-weight: 650; }
.agent-context__window-note, .agent-context__more-error { margin: .5rem 0 0; font-size: .72rem; line-height: 1.4; }
.agent-context__window-note { color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent); }
.agent-context__more-error { color: rgb(var(--v-theme-error)); }
.agent-context__more { margin-top: .35rem; }
.agent-context__dialog-actions { min-height: 4rem; padding: .75rem var(--wiki-space-5) max(.75rem, env(safe-area-inset-bottom)); border-top: 1px solid var(--wiki-surface-border); background: var(--wiki-surface-raised); }
@media (max-width: 639.98px) {
  .agent-context__dialog-header { padding: var(--wiki-space-4) var(--wiki-space-3) var(--wiki-space-2); }
  .agent-context__dialog-body { max-height: 66vh; padding-inline: var(--wiki-space-3); }
  .agent-context__dialog-actions { flex-wrap: wrap; gap: .35rem; padding-inline: var(--wiki-space-3); }
  .agent-context__dialog-actions :deep(.v-spacer) { display: none; }
  .agent-context__dialog-actions .v-btn:last-child { width: 100%; }
  .agent-context__result-label { padding-inline: .55rem; }
}
</style>
