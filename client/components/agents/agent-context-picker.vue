<template>
  <div class="agent-context" :aria-label="$t('common:agentContextPicker.sourcesSearchScope')">
    <div class="agent-context__scope" role="group" :aria-label="$t('common:agentContextPicker.conversationSourceControls')">
      <v-menu content-class="agent-owned-overlay" location="top start">
        <template #activator="{ props: menuProps }">
          <v-tooltip location="top" :text="$t('common:agentContextPicker.searchScopeHelp')">
            <template #activator="{ props: tooltipProps }">
              <v-btn v-bind="mergeProps(menuProps, tooltipProps)" class="agent-context__control agent-context__scope-control" :disabled="disabled || connectionBlocked" variant="text" rounded="pill" size="small" prepend-icon="mdi-text-search" append-icon="mdi-chevron-down" :aria-label="$t('common:agentContextPicker.chooseAgentSearchScope')" type="button">{{ scopeLabel }}</v-btn>
            </template>
          </v-tooltip>
        </template>
        <v-list density="compact" :aria-label="$t('common:agentContextPicker.agentSearchScope')">
          <v-list-item :title="$t('common:agentContextPicker.allWiki')" :subtitle="$t('common:agentContextPicker.searchEveryPageYou')" prepend-icon="mdi-earth" :active="draft.scope.kind === 'all'" :disabled="disabled || connectionBlocked" @click="setScope({ kind: 'all' })" />
          <v-list-item v-if="currentPage" :title="$t('common:agentContextPicker.pageTree')" :subtitle="currentPage.path" prepend-icon="mdi-file-tree-outline" :active="draft.scope.kind === 'section'" :disabled="disabled || connectionBlocked" @click="setScope({ kind: 'section', locale: currentPage.locale, path: currentPage.path })" />
          <v-list-item :title="$t('common:agentContextPicker.selectedPages')" :subtitle="$t(draft.sources.length ? 'common:agentContextPicker.searchWithinSourcesAttached' : 'common:agentContextPicker.attachSourcesFirst')" prepend-icon="mdi-file-multiple-outline" :disabled="disabled || connectionBlocked || !draft.sources.length" :aria-disabled="disabled || connectionBlocked || !draft.sources.length ? 'true' : undefined" :active="draft.scope.kind === 'selected'" @click="setScope({ kind: 'selected' })" />
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
        :aria-label="$t('common:agentContextPicker.addSources')"
        @click="openSources"
      ><span aria-hidden="true">{{ $t('common:agentContextPicker.sources') }}</span></v-btn>
    </div>
    <!-- One compact source chip for the current page. The chip itself means the
         page is included, so no separate Included badge is rendered. -->
    <v-tooltip v-if="currentPage" location="top" :text="connectionBlocked
        ? $t('common:agentContext.pageNeedsConnection')
        : disabled
          ? $t('common:agentContext.pageBusy')
          : $t(draft.includeCurrentPage ? 'common:agentContext.pageIncluded' : 'common:agentContext.pageExcluded', { path: `${currentPage.locale}/${currentPage.path}` })">
      <template #activator="{ props: tooltipProps }">
        <button
          v-bind="tooltipProps"
          type="button"
          class="agent-context__page-chip"
          :class="{ 'agent-context__page-chip--excluded': !draft.includeCurrentPage }"
          :aria-disabled="disabled || connectionBlocked ? 'true' : undefined"
          :aria-pressed="draft.includeCurrentPage"
          :aria-label="$t('common:agentContext.includePage', { title: currentPageLabel })"
          @click="toggleCurrentPage"
        >
          <v-icon :icon="draft.includeCurrentPage ? 'mdi-file-check-outline' : 'mdi-file-hidden'" size="15" aria-hidden="true" />
          <span class="agent-context__page-copy">{{ currentPageLabel }}</span>
          <v-icon
            class="agent-context__page-state"
            :icon="draft.includeCurrentPage ? 'mdi-check' : 'mdi-minus'"
            size="14"
            aria-hidden="true"
          />
        </button>
      </template>
    </v-tooltip>
    <div v-if="draft.sources.length" class="agent-context__sources" role="region" tabindex="0" :aria-label="$t('common:agentContextPicker.pagesAttachedNextMessage')">
      <v-chip
        v-for="source in draft.sources"
        :key="source.id"
        size="small"
        closable
        role="button"
        :disabled="disabled || connectionBlocked"
        :close-label="$t('common:agentContextPicker.removeSource', { title: source.title, interpolation: { escapeValue: false } })"
        :aria-label="$t('common:agentContextPicker.previewAttachedSource', { title: source.title, interpolation: { escapeValue: false } })"
        :title="$t('common:agentContextPicker.previewAttachedSource', { title: source.title, interpolation: { escapeValue: false } })"
        variant="outlined"
        prepend-icon="mdi-file-document-outline"
        @click.stop="previewSource(source.id)"
        @click:close.stop="removeSource(source.id)"
      >
        <span class="agent-context__source-label">{{ source.title }} · {{ source.locale }}/{{ source.path }} · {{ source.sourceRevision }}<span v-if="source.excerptTruncated"> · {{ $t('common:agentContextPicker.excerptTruncated') }}</span></span>
        <v-icon class="agent-context__preview-icon" icon="mdi-eye-outline" size="14" aria-hidden="true" />
      </v-chip>
    </div>
    <p v-if="draft.sources.length === 8" class="agent-context__limit" role="status">{{ $t('common:agentContextPicker.eightSourcesAttachedRemove') }}</p>
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
            <h2 :id="`${sourceDialogId}-title`">{{ $t('common:agentContextPicker.sources') }} · {{ $t('common:agentContextPicker.addSources') }}</h2>
          </div>
          <div class="agent-context__dialog-corner">
            <v-tooltip location="bottom" content-class="agent-owned-overlay">
              <template #activator="{ props: confirmTip }">
                <v-btn
                  v-bind="confirmTip"
                  class="agent-context__dialog-confirm"
                  icon="mdi-check"
                  variant="text"
                  color="success"
                  :aria-label="selectedRows.length ? $t('common:agentContextPicker.addSelectedSource', { count: selectedRows.length, interpolation: { escapeValue: false } }) : $t('common:agentContextPicker.noPagesSelectedYet')"
                  :loading="addingSources"
                  :disabled="!selectedRows.length || addingSources || disabled || connectionBlocked"
                  type="button"
                  @click="addSources"
                />
              </template>
              <span>{{ $t('common:agentContextPicker.addSelectedPages') }}</span>
            </v-tooltip>
            <v-tooltip location="bottom" content-class="agent-owned-overlay">
              <template #activator="{ props: closeTip }">
                <v-btn
                  v-bind="closeTip"
                  class="agent-context__dialog-close"
                  icon="mdi-close"
                  variant="text"
                  :aria-label="$t('common:agentContextPicker.cancelAddingSources')"
                  type="button"
                  @click="cancelSources"
                />
              </template>
              <span>{{ $t('common:actions.cancel') }}</span>
            </v-tooltip>
          </div>
        </header>
        <v-card-text class="agent-context__dialog-body">
          <p :id="`${sourceDialogId}-description`" class="agent-context__dialog-guidance">{{ $t('common:agentContextPicker.selectUpEightPages') }} · {{ draft.sources.length + selectedRows.length }}/8 · {{ $t('common:agentContextPicker.contextCapacity') }}</p>
          <v-alert v-if="connectionBlocked" class="agent-context__connection-alert" type="warning" variant="tonal" density="compact" role="status">
            <span>{{ $t('common:agentContextPicker.connectionRequiredSearchAttach') }}</span>
            <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :loading="connectionRetrying" :disabled="connectionRetrying" type="button" @click="emit('retry-connection')">{{ $t('common:agentContextPicker.retryConnection') }}</v-btn>
          </v-alert>
          <v-text-field
            ref="sourceSearchInput"
            v-model="sourceQuery"
            class="agent-context__search"
            variant="outlined"
            :label="$t('common:agentContextPicker.searchPages')"
            :aria-label="$t('common:agentContextPicker.searchPages')"
            prepend-inner-icon="mdi-magnify"
            clearable
            hide-details="auto"
            autocomplete="off"
            :disabled="addingSources || disabled || connectionBlocked"
            @keydown.enter.prevent="queueSourceSearch(true)"
          />
          <p class="agent-context__search-scope" role="note"><v-icon icon="mdi-earth" size="15" aria-hidden="true" /> {{ $t('common:agentContextPicker.attachmentsDiscoveredAcrossAll', { scopeLabel, interpolation: { escapeValue: false } }) }}</p>
          <p v-if="!searchError" class="agent-context__status" role="status" aria-live="polite" aria-atomic="true">{{ sourceStatus }}</p>
          <v-alert v-if="attachmentError" class="agent-context__error" type="error" variant="tonal" density="compact" role="alert">
            {{ attachmentError }}
          </v-alert>

          <section v-if="selectedRows.length" class="agent-context__pending" :aria-labelledby="`${sourceDialogId}-pending-title`">
            <div class="agent-context__pending-heading">
              <h3 :id="`${sourceDialogId}-pending-title`">{{ $t('common:agentContextPicker.pendingAdditions') }}</h3>
              <span>{{ $t('common:agentContextPicker.n8', { selectedRowsCount: selectedRows.length, interpolation: { escapeValue: false } }) }}</span>
            </div>
            <div class="agent-context__pending-list">
              <v-chip v-for="row in selectedRows" :key="rowIdentity(row)" closable size="small" variant="tonal" :disabled="addingSources || disabled || connectionBlocked" :close-label="$t('common:agentContextPicker.removePendingSources', { title: row.title, interpolation: { escapeValue: false } })" @click:close="removePending(row)">
                <span class="agent-context__pending-label">{{ row.title }}<small>{{ row.locale }} · {{ row.path }}</small></span>
              </v-chip>
            </div>
          </section>

          <div class="agent-context__results" :aria-label="$t('common:agentContextPicker.pageSearchResults')">
            <div v-if="searchLoading" class="agent-context__results-state" role="status"><v-progress-circular indeterminate size="20" width="2" aria-hidden="true" /> {{ $t('common:agentContextPicker.searchingPages') }}</div>
            <v-alert v-else-if="searchError" class="agent-context__error agent-context__search-error" type="error" variant="tonal" density="compact" role="alert">
              <p>{{ searchError }}</p>
              <v-btn variant="text" :disabled="addingSources || disabled || connectionBlocked" type="button" @click="queueSourceSearch(true)">{{ $t('common:agentContextPicker.retrySearch') }}</v-btn>
            </v-alert>
            <div v-else-if="!sourceQuery.trim() || sourceQuery.trim().length < 2" class="agent-context__results-state">{{ $t('common:agentContextPicker.enterLeastTwoCharacters') }}</div>
            <div v-else-if="!sourceResult.results.length" class="agent-context__results-state">{{ $t('common:agentContextPicker.noAccessiblePagesMatched') }}</div>
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
                    <small :id="rowDomId(row)">{{ row.locale }} · {{ row.path }}<span v-if="row.visibility === 'private'"> {{ $t('common:agentContextPicker.private') }}</span></small>
                    <span v-if="isAttached(row)" class="agent-context__result-state-label">{{ $t('common:agentContextPicker.attached') }}</span>
                    <span v-else-if="isPending(row)" class="agent-context__result-state-label">{{ $t('common:agentContextPicker.pending') }}</span>
                    <span v-else-if="atCapacity" class="agent-context__result-state-label">{{ $t('common:agentContextPicker.eightSourceLimitReached') }}</span>
                  </span>
                </label>
              </li>
            </ul>
          </div>
          <p v-if="sourceResult.windowTruncated" class="agent-context__window-note" role="status">{{ $t('common:agentContextPicker.showingBoundedResultWindow', { windowLimit: sourceResult.windowLimit ? ` ${$t('common:agentContextPicker.of', { windowLimit: sourceResult.windowLimit, interpolation: { escapeValue: false } })}` : '', interpolation: { escapeValue: false } }) }}</p>
          <p v-if="moreError" class="agent-context__more-error" role="alert">{{ moreError }}</p>
          <v-btn
            v-if="sourceResult.nextCursor"
            class="agent-context__more"
            variant="text"
            :loading="loadingMore"
            :disabled="loadingMore || addingSources || disabled || connectionBlocked"
            type="button"
            @click="loadMoreSources"
          >{{ $t('common:agentContextPicker.moreResults') }}</v-btn>
        </v-card-text>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, mergeProps, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { AgentDraft, AgentSearchScope } from '../../helpers/agent-draft.ts'
import { searchPages, type PageSearchResult, type PageSearchRow } from '../../helpers/pages-api.ts'
import { fetchWikiSource } from '../../helpers/wiki-source.ts'
import type { AgentCurrentPageHint } from '../../../shared/agents/contracts.ts'
import { AgentKnowledgeContextSchema } from '../../../shared/agents/knowledge-context.ts'
import type { WikiSource, WikiSourceSelector } from '../../../shared/wiki-source.ts'
import WikiSourcePreview from '../common/wiki-source-preview.vue'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const emptySearchResult = (): PageSearchResult => ({ results: [], suggestions: [], totalHits: 0, nextCursor: null })
const sourceDialogId = useId()

const props = defineProps<{
  draft: AgentDraft
  currentPage: AgentCurrentPageHint | null
  disabled?: boolean
  connectionBlocked?: boolean
  connectionRetrying?: boolean
  /** Title of the page the Agent opened over; the chip falls back to its path. */
  currentPageTitle?: string
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
const currentPageLabel = computed(() => props.currentPageTitle?.trim() || (props.currentPage ? `${props.currentPage.locale}/${props.currentPage.path}` : ''))
const toggleCurrentPage = (): void => {
  if (interactionBlocked.value) return
  emit('change', { includeCurrentPage: !props.draft.includeCurrentPage })
}

const scopeLabel = computed(() => props.draft.scope.kind === 'selected' ? t('common:agentContextPicker.selectedPages') : props.draft.scope.kind === 'section' ? t('common:agentContextPicker.within', { path: props.draft.scope.path, interpolation: { escapeValue: false } }) : props.draft.scope.kind === 'locale' ? t('common:agentContextPicker.pages', { locale: props.draft.scope.locale.toUpperCase(), interpolation: { escapeValue: false } }) : t('common:agentContextPicker.allWiki'))
const attachedIds = computed(() => new Set(props.draft.sources.map(source => source.id)))
const atCapacity = computed(() => props.draft.sources.length + selectedRows.value.length >= 8)
const sourceStatus = computed(() => {
  if (addingSources.value) return t('common:agentContextPicker.addingSource', { count: selectedRows.value.length, interpolation: { escapeValue: false } })
  if (searchLoading.value) return t('common:agentContextPicker.searchingPages')
  if (loadingMore.value) return t('common:agentContextPicker.loadingMoreResultsShown', { count: sourceResult.value.results.length, interpolation: { escapeValue: false } })
  if (selectedRows.value.length) return t('common:agentContextPicker.sourcePendingResultShown', { count: selectedRows.value.length, resultSummary: t('common:agentContextPicker.resultShown', { count: sourceResult.value.results.length }), interpolation: { escapeValue: false } })
  if (sourceQuery.value.trim().length >= 2) return t('common:agentContextPicker.resultShown', { count: sourceResult.value.results.length, interpolation: { escapeValue: false } })
  return t('common:agentContextPicker.noSourcesSelected')
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
  if (isAttached(row)) return t('common:agentContextPicker.alreadyAttachedConversation')
  if (isPending(row)) return t('common:agentContextPicker.selectedUncheckRemovePending')
  if (rowId(row) === null) return t('common:agentContextPicker.resultHasInvalidPage')
  if (atCapacity.value) return t('common:agentContextPicker.eightSourcesMaximumRemove')
  return ''
}
const canToggle = (row: PageSearchRow): boolean => !addingSources.value && !interactionBlocked.value && !isAttached(row) && (isPending(row) || (!atCapacity.value && rowId(row) !== null))
const rowAriaLabel = (row: PageSearchRow): string => {
  const state = isAttached(row) ? t('common:agentContextPicker.attached') : isPending(row) ? t('common:agentContextPicker.pendingAddition') : atCapacity.value ? t('common:agentContextPicker.unavailableEightSourceLimit') : ''
  return `${row.title}, ${row.locale}, ${row.path}${state ? `, ${state}` : ''}`
}
const setScope = (scope: AgentSearchScope): void => {
  if (interactionBlocked.value || (scope.kind === 'selected' && !props.draft.sources.length)) return
  emit('change', { scope })
}
const previewSource = (id: number): void => {
  if (interactionBlocked.value) return
  previewSelector.value = { id }
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
  } catch {
    if (disposed || controller.signal.aborted || interactionBlocked.value || generation !== requestGeneration || !sourcesOpen.value) return
    searchError.value = t('common:agentContextPicker.pageSearchCouldNot')
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
    moreError.value = value instanceof Error ? value.message : t('common:agentContextPicker.moreResultsCouldNot')
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
      attachmentError.value = t('common:agentContextPicker.eightSourcesMaximumRemove2')
      return
    }
    selectedRows.value = [...selectedRows.value, row]
  } else {
    selectedRows.value = selectedRows.value.filter(selected => rowId(selected) !== id)
  }
  attachmentError.value = ''
}
const transactionError = (row: PageSearchRow, value: unknown): Error => {
  const message = value instanceof Error && value.message ? value.message : t('common:agentContextPicker.sourceCouldNotLoaded')
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
      if (id === null) throw transactionError(row, new Error(t('common:agentContextPicker.pageIdentityInvalid')))
      try {
        const source = await fetchWikiSource({ id }, query, controller.signal)
        if (source.id !== id) throw new Error(t('common:agentContextPicker.returnedPageIdentityDid'))
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
      throw new Error(t('common:agentContextPicker.conversationAlreadyHasEight'))
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
    if (!context.success) throw new Error(context.error.issues[0]?.message || t('common:agentContextPicker.selectedSourcesDoNot'))
    if (disposed || controller.signal.aborted || resolveController !== controller || interactionBlocked.value || !sourcesOpen.value) return
    emit('change', { sources: mergedSources })
    successfulClose.value = true
    sourcesOpen.value = false
  } catch (value) {
    if (disposed || controller.signal.aborted || resolveController !== controller || interactionBlocked.value || !sourcesOpen.value) return
    attachmentError.value = value instanceof Error ? value.message : t('common:agentContextPicker.selectedSourcesCouldNot')
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
  border-radius: var(--wiki-control-radius) !important;
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
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  font: inherit;
  font-size: var(--wiki-label-size);
  line-height: 1.25;
}
.agent-context__page-chip > .v-icon:first-child { flex: 0 0 auto; color: var(--wiki-primary-ink); }
.agent-context__page-chip--excluded {
  border-style: dashed;
  color: var(--wiki-text-muted);
}
.agent-context__page-chip--excluded .agent-context__page-copy {
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}
.agent-context__page-chip--excluded > .v-icon:first-child { color: var(--wiki-text-muted); }
.agent-context__page-chip:focus-visible {
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: 2px;
}
.agent-context__page-chip[aria-disabled='true'] { cursor: default; opacity: .6; }
.agent-context__page-state {
  flex: 0 0 auto;
  color: var(--wiki-primary-ink);
}
.agent-context__page-chip--excluded .agent-context__page-state {
  color: var(--wiki-text-muted);
}
.agent-context__page-copy {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-context__sources {
  display: flex;
  order: 1;
  min-width: 0;
  max-width: 100%;
  max-height: 6rem;
  flex: 1 1 100%;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-1);
  overflow-y: scroll;
  scrollbar-gutter: stable;
  scrollbar-width: auto;
  overscroll-behavior: contain;
}
.agent-context__sources:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 2px; }
.agent-context__sources .v-chip { max-width: 100%; height: auto; min-height: 2.75rem; border-radius: var(--wiki-control-radius); }
.agent-context__source-label { overflow-wrap: anywhere; white-space: normal; padding-block: .35rem; }
.agent-context__preview-icon { flex: 0 0 auto; margin-inline-start: var(--wiki-space-1); color: var(--wiki-text-muted); }
.agent-context__sources .v-chip:not(.v-chip--disabled):is(:hover, :focus-within) {
  border-color: var(--wiki-surface-border-strong);
  background: var(--wiki-surface-sunken);
}
.agent-context__sources .v-chip:not(.v-chip--disabled):is(:hover, :focus-within) .agent-context__source-label {
  text-decoration: underline dotted;
  text-underline-offset: .2em;
}
.agent-context__sources .v-chip:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 2px; }
.agent-context__sources .v-chip:is(:hover, :focus-within) .agent-context__preview-icon { color: var(--wiki-primary-ink); }
.agent-context__limit {
  order: 2;
  flex: 1 1 100%;
  margin: var(--wiki-space-1) 0 0;
  color: var(--wiki-text-muted);
  font-size: .72rem;
  line-height: 1.3;
}
.agent-context__dialog { overflow: hidden; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius) !important; background: var(--wiki-surface-raised); }
.agent-context__dialog-header { display: flex; align-items: flex-start; gap: var(--wiki-space-3); padding: var(--wiki-space-5) var(--wiki-space-5) var(--wiki-space-3); border-bottom: 1px solid var(--wiki-surface-border); }
.agent-context__dialog-mark { display: grid; flex: 0 0 auto; width: 2.25rem; height: 2.25rem; place-items: center; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); color: var(--wiki-accent-ink, rgb(var(--v-theme-primary))); }
.agent-context__dialog-header h2 { margin: 0; color: rgb(var(--v-theme-on-surface)); font-family: var(--wiki-font-heading); font-size: 1.125rem; font-weight: 700; line-height: 1.35; }
.agent-context__dialog-corner { display: flex; flex: 0 0 auto; margin-inline-start: auto; align-items: center; gap: .1rem; }
.agent-context__dialog-corner .v-btn--icon { align-self: center; }
.agent-context__dialog-corner .v-btn--loading { flex: 0 0 auto; }
.agent-context__dialog-body { max-height: min(68vh, 38rem); padding: var(--wiki-space-4) var(--wiki-space-5) var(--wiki-space-2); }
.agent-context__dialog-guidance { margin: 0 0 var(--wiki-space-3); color: var(--wiki-text-muted); font-size: .82rem; line-height: 1.5; }
.agent-context__search { margin-bottom: .15rem; }
.agent-context__search :deep(.v-field) { touch-action: pan-y; }
.agent-context__search-scope { display: flex; align-items: center; gap: .35rem; margin: .25rem 0 0; color: var(--wiki-text-muted); font-size: .72rem; line-height: 1.4; }
.agent-context__status { min-height: 1.15rem; margin: .5rem 0 .35rem; color: var(--wiki-text-muted); font-size: .74rem; line-height: 1.4; }
.agent-context__error { margin: .45rem 0; }
.agent-context__search-error { margin: 0; }
.agent-context__search-error p { margin: 0 0 var(--wiki-space-2); }
.agent-context__search-error .v-btn { min-height: 44px; }
.agent-context__pending { margin: .6rem 0 .75rem; padding: .75rem; border: 1px solid var(--wiki-surface-border-strong); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); }
.agent-context__pending-heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; color: rgb(var(--v-theme-on-surface)); font-size: .76rem; }
.agent-context__pending-heading h3 { margin: 0; font-size: inherit; font-weight: 700; }
.agent-context__pending-heading span { color: var(--wiki-text-muted); font-size: .8125rem; }
.agent-context__pending-list { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .5rem; }
.agent-context__pending-label { display: inline-flex; max-width: 16rem; flex-direction: column; min-width: 0; overflow: hidden; text-align: start; }
.agent-context__pending-label small { color: var(--wiki-text-muted); font-size: .8125rem; overflow-wrap: anywhere; white-space: normal; }
.agent-context__results { --agent-context-results-rows: 6; min-height: 4.7rem; max-height: calc(var(--agent-context-results-rows) * 4rem + 1px); overflow-y: auto; touch-action: pan-y; overscroll-behavior-y: contain; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); }
.agent-context__results-state { display: flex; min-height: 4.7rem; align-items: center; justify-content: center; gap: .55rem; padding: 1rem; color: var(--wiki-text-muted); font-size: .8rem; text-align: center; }
.agent-context__result-list { display: grid; margin: 0; padding: 0; list-style: none; }
.agent-context__result + .agent-context__result { border-top: 1px solid var(--wiki-surface-border); }
.agent-context__result-label { display: flex; min-height: 3.65rem; align-items: center; gap: .7rem; padding: .6rem .75rem; cursor: pointer; touch-action: pan-y; }
.agent-context__result-label:hover { background: color-mix(in srgb, var(--wiki-accent-ink, rgb(var(--v-theme-primary))) 5%, transparent); }
.agent-context__result-label:focus-within { outline: 2px solid var(--wiki-accent-ink, rgb(var(--v-theme-primary))); outline-offset: -2px; }
.agent-context__result-label--disabled { cursor: not-allowed; opacity: .68; }
.agent-context__result-label input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.agent-context__checkbox { display: grid; flex: 0 0 auto; width: 1.15rem; height: 1.15rem; place-items: center; border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 50%, var(--wiki-surface-border)); border-radius: .25rem; background: var(--wiki-surface-raised); }
.agent-context__result-label input:checked + .agent-context__checkbox { border-color: var(--wiki-accent-ink, rgb(var(--v-theme-primary))); background: var(--wiki-accent-ink, rgb(var(--v-theme-primary))); box-shadow: inset 0 0 0 3px var(--wiki-surface-raised); }
.agent-context__result-copy { display: grid; min-width: 0; gap: .14rem; }
.agent-context__result-copy strong { color: rgb(var(--v-theme-on-surface)); font-size: .875rem; font-weight: 650; overflow-wrap: anywhere; }
.agent-context__result-copy small { color: var(--wiki-text-muted); font-size: .8125rem; overflow-wrap: anywhere; }
.agent-context__result-state-label { color: var(--wiki-accent-ink, rgb(var(--v-theme-primary))); font-size: .68rem; font-weight: 650; }
.agent-context__window-note, .agent-context__more-error { margin: .5rem 0 0; font-size: .72rem; line-height: 1.4; }
.agent-context__window-note { color: var(--wiki-text-muted); }
.agent-context__more-error { color: rgb(var(--v-theme-error)); }
.agent-context__more { margin-top: .35rem; }
@media (max-width: 639.98px) {
  .agent-context__results { --agent-context-results-rows: 3.5; }
  .agent-context__dialog-header { padding: var(--wiki-space-4) var(--wiki-space-3) var(--wiki-space-2); }
  .agent-context__dialog-body { max-height: 66vh; padding-inline: var(--wiki-space-3); }
  .agent-context__result-label { padding-inline: .55rem; }
}
</style>
