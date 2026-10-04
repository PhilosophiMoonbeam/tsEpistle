<template lang="pug">
section.wiki-page-links(:aria-busy="loading || loadingMore ? 'true' : undefined" aria-labelledby="wiki-page-links-title")
  .wiki-page-links__heading
    h2#wiki-page-links-title {{ $t('common:pageLinks.title') }}
    span.wiki-page-links__revision(v-if="!stale") {{ $t('common:pageLinks.current') }}

  .wiki-page-links__directions(role="group" :aria-label="$t('common:pageLinks.direction')")
    button.wiki-page-links__direction(
      type="button"
      :aria-pressed="direction === 'incoming' ? 'true' : 'false'"
      @click="setDirection('incoming')"
    )
      span {{ $t('common:pageLinks.incoming') }}
      small {{ $t('common:pageLinks.incomingHint') }}
    button.wiki-page-links__direction(
      type="button"
      :aria-pressed="direction === 'outgoing' ? 'true' : 'false'"
      @click="setDirection('outgoing')"
    )
      span {{ $t('common:pageLinks.outgoing') }}
      small {{ $t('common:pageLinks.outgoingHint') }}

  async-state(v-if="loading && items.length === 0 && !stale" state="loading" :title="loadingTitle")
  async-state(v-else-if="error && items.length === 0 && !stale" state="error" :title="$t('common:pageLinks.loadError')" :message="error" :retry-label="$t('common:page.tryAgain')" @retry="refresh")

  .wiki-page-links__stale(v-else-if="stale" role="status" aria-live="polite")
    p {{ staleMessage }}
    v-alert(v-if="error" type="error" variant="tonal" density="compact" role="alert") {{ error }}
    v-btn(
      type="button"
      size="small"
      variant="outlined"
      prepend-icon="mdi-refresh"
      :loading="loading"
      :disabled="loading || loadingMore"
      @click="requiresPageReload ? reloadPage() : refresh()"
    ) {{ requiresPageReload ? $t('common:pageLinks.reloadPage') : $t('common:pageLinks.refresh') }}

  div#wiki-page-links-results(v-else)
    .wiki-page-links__inventory(v-if="items.length > 0")
      v-text-field(v-model="loadedFilter" :label="$t('common:pageLinks.filterLoadedPages')" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable)
      span.wiki-page-links__loaded(role="status" aria-live="polite") {{ filteredItems.length }} / {{ items.length }} {{ $t('common:pageLinks.loaded') }}
    p.wiki-page-links__no-matches(v-if="items.length > 0 && filteredItems.length === 0" role="status") {{ $t('common:pageLinks.noLoadedMatches') }}
    async-state(v-if="items.length === 0 && !hasMore" state="empty" :title="emptyTitle" :message="emptyMessage" announce)
    ul.wiki-page-links__list(v-else-if="filteredItems.length > 0" :aria-label="listLabel")
      li.wiki-page-links__item(v-for="item in filteredItems" :key="item.id")
        a.wiki-page-links__title(:href="pageHref({ visibility: 'public', locale: item.locale, path: item.path })")
          bdi(dir="auto") {{ item.title || item.path }}
        span.wiki-page-links__path
          bdi(dir="ltr") {{ item.locale }}/{{ item.path }}

    v-alert(v-if="error && items.length > 0" class="mt-3" type="error" variant="tonal" density="compact" role="alert") {{ error }}
    .wiki-page-links__more(v-if="hasMore && !stale")
      v-btn(
        type="button"
        variant="outlined"
        prepend-icon="mdi-chevron-down"
        :loading="loadingMore"
        :disabled="loading || loadingMore || nextCursor === null"
        @click="loadMore"
      ) {{ error ? $t('common:pageLinks.loadMoreRetry') : $t('common:pageLinks.loadMore') }}
</template>

<script setup lang="ts">
import i18next from 'i18next'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AsyncState from './common/async-state.vue'
import { pageHref } from '../helpers/admin-pages.ts'
import { fetchPageLinks, PageLinksApiError, type PageLinksResponse } from '../helpers/page-links-api.ts'
import type { PageLinksDirection, PageLinkItem } from '../../shared/page-links.ts'

const props = defineProps<{
  pageId: number
  locale: string
  sourceRevision: string
}>()

const direction = ref<PageLinksDirection>('incoming')
const items = ref<PageLinkItem[]>([])
const loadedFilter = ref<string | null>('')
const filteredItems = computed(() => {
  const query = (loadedFilter.value ?? '').trim().toLocaleLowerCase()
  return query ? items.value.filter(item => `${item.title} ${item.locale}/${item.path}`.toLocaleLowerCase().includes(query)) : items.value
})
const nextCursor = ref<string | null>(null)
const hasMore = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')
const stale = ref(false)
const staleMessage = ref('')
const requiresPageReload = ref(false)
const seenCursors = new Set<string>()
let requestSequence = 0
let contextSequence = 0
let activeController: AbortController | null = null
let disposed = false

const t = (key: string): string => i18next.t(`common:pageLinks.${key}`)
const incoming = computed(() => direction.value === 'incoming')
const loadingTitle = computed(() => incoming.value ? t('loadingIncoming') : t('loadingOutgoing'))
const emptyTitle = computed(() => incoming.value ? t('emptyIncoming') : t('emptyOutgoing'))
const emptyMessage = computed(() => incoming.value ? t('emptyIncomingMessage') : t('emptyOutgoingMessage'))
const listLabel = computed(() => incoming.value ? t('listIncoming') : t('listOutgoing'))



const clearResults = (): void => {
  items.value = []
  loadedFilter.value = ''
  nextCursor.value = null
  hasMore.value = false
  seenCursors.clear()
}

const markStale = (message: string, responseRevision?: string): void => {
  clearResults()
  stale.value = true
  staleMessage.value = message
  requiresPageReload.value = responseRevision !== undefined && responseRevision !== props.sourceRevision
  if (requiresPageReload.value) staleMessage.value = t('pageChanged')
}


const currentContext = (sequence: number, pageId: number, currentDirection: PageLinksDirection, revision: string): boolean =>
  !disposed && contextSequence === sequence && props.pageId === pageId && direction.value === currentDirection && props.sourceRevision === revision

const acceptResponse = (
  response: PageLinksResponse,
  request: { sequence: number; pageId: number; direction: PageLinksDirection; revision: string; cursor?: string }
): void => {
  if (!currentContext(request.sequence, request.pageId, request.direction, request.revision)) return
  if (response.state === 'refresh') {
    markStale(t('graphNotReady'), response.sourceRevision)
    return
  }
  if (response.sourceRevision !== request.revision) {
    markStale(t('pageChanged'), response.sourceRevision)
    return
  }

  if (request.cursor !== undefined) {
    if (seenCursors.has(request.cursor)) {
      markStale(t('continuationUnsafe'))
      return
    }
    seenCursors.add(request.cursor)
  }
  if (response.nextCursor !== null && seenCursors.has(response.nextCursor)) {
    markStale(t('continuationUnsafe'))
    return
  }

  items.value = request.cursor === undefined ? response.items : [...items.value, ...response.items]
  nextCursor.value = response.nextCursor
  hasMore.value = response.hasMore
  stale.value = false
  staleMessage.value = ''
  requiresPageReload.value = false
  error.value = ''
}

const requestPage = async (cursor?: string): Promise<void> => {
  if (loading.value || loadingMore.value || stale.value) return
  if (!Number.isSafeInteger(props.pageId) || props.pageId < 1) {
    error.value = t('invalidPage')
    return
  }
  const sequence = contextSequence
  const pageId = props.pageId
  const currentDirection = direction.value
  const revision = props.sourceRevision
  const isContinuation = cursor !== undefined
  const requestSequenceValue = ++requestSequence
  activeController?.abort()
  const controller = new AbortController()
  activeController = controller
  if (isContinuation) loadingMore.value = true
  else loading.value = true
  error.value = ''

  try {
    const response = await fetchPageLinks(window.fetch.bind(window), pageId, currentDirection, {
      ...(cursor === undefined ? {} : { cursor }),
      signal: controller.signal
    })
    if (controller.signal.aborted || requestSequenceValue !== requestSequence) return
    acceptResponse(response, { sequence, pageId, direction: currentDirection, revision, ...(cursor === undefined ? {} : { cursor }) })
  } catch (cause) {
    if (controller.signal.aborted || requestSequenceValue !== requestSequence || !currentContext(sequence, pageId, currentDirection, revision)) return
    error.value = cause instanceof Error ? cause.message : t('loadError')
    if (cause instanceof PageLinksApiError && (cause.status === 409 || cause.code === 'INVALID_PAGE_LINK_CURSOR')) {
      markStale(t('changedWhileLoading'))
    }
  } finally {
    if (!disposed && requestSequenceValue === requestSequence) {
      loading.value = false
      loadingMore.value = false
      activeController = null
    }
  }
}

const refresh = (): void => {
  if (loading.value || loadingMore.value) return
  stale.value = false
  staleMessage.value = ''
  requiresPageReload.value = false
  clearResults()
  error.value = ''
  void requestPage()
}

const loadMore = (): void => {
  const cursor = nextCursor.value
  if (!hasMore.value || cursor === null || loading.value || loadingMore.value || stale.value) return
  void requestPage(cursor)
}

const setDirection = (next: PageLinksDirection): void => {
  if (direction.value !== next) direction.value = next
}

const reloadPage = (): void => window.location.reload()

watch(
  [() => props.pageId, () => props.locale, () => props.sourceRevision, direction],
  () => {
    contextSequence++
    requestSequence++
    activeController?.abort()
    activeController = null
    loading.value = false
    loadingMore.value = false
    error.value = ''
    stale.value = false
    staleMessage.value = ''
    requiresPageReload.value = false
    clearResults()
    void requestPage()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  disposed = true
  contextSequence++
  requestSequence++
  activeController?.abort()
  activeController = null
})
</script>

<style scoped>
.wiki-page-links {
  display: grid;
  gap: var(--wiki-space-3);
  min-width: 0;
  padding: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
}
.wiki-page-links__heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--wiki-space-2); }
.wiki-page-links__heading h2 { margin: 0; color: rgb(var(--v-theme-on-surface)); font-size: 1rem; font-weight: 650; }
.wiki-page-links__revision,
.wiki-page-links__loaded,
.wiki-page-links__path { color: var(--wiki-text-muted); font-size: .8125rem; }
.wiki-page-links__directions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--wiki-space-2); }
.wiki-page-links__direction {
  display: grid;
  gap: var(--wiki-space-1);
  min-width: 0;
  min-height: 44px;
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  color: var(--wiki-text-muted);
  text-align: start;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.wiki-page-links__direction[aria-pressed='true'] { border-color: var(--wiki-focus-color); background: var(--wiki-surface-raised); color: rgb(var(--v-theme-on-surface)); }
.wiki-page-links__direction span { font-size: .875rem; font-weight: 650; }
.wiki-page-links__direction small { font-size: .75rem; line-height: 1.4; }
.wiki-page-links__direction:focus-visible,
.wiki-page-links__title:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 2px; }
.wiki-page-links__inventory { display: grid; gap: var(--wiki-space-2); margin-bottom: var(--wiki-space-2); }
.wiki-page-links__list { max-height: 24rem; overflow-y: auto; overscroll-behavior: contain; margin: 0; padding: 0; list-style: none; }
.wiki-page-links__item { display: grid; gap: var(--wiki-space-1); min-width: 0; padding: var(--wiki-space-3) 0; border-bottom: 1px solid var(--wiki-surface-border); }
.wiki-page-links__title { width: fit-content; max-width: 100%; color: var(--wiki-primary-ink); font-weight: 600; overflow-wrap: anywhere; text-decoration: underline; text-underline-offset: .16em; }
.wiki-page-links__path { font-family: var(--wiki-font-mono); overflow-wrap: anywhere; }
.wiki-page-links__more { display: flex; justify-content: center; padding-top: var(--wiki-space-3); }
.wiki-page-links__stale { display: flex; flex-wrap: wrap; align-items: center; gap: var(--wiki-space-3); padding: var(--wiki-space-3); border: 1px solid var(--wiki-surface-border-strong); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); }
.wiki-page-links__stale p,
.wiki-page-links__no-matches { margin: 0; color: var(--wiki-text-muted); font-size: .875rem; }
@media (max-width: 599px) {
  .wiki-page-links { padding: var(--wiki-space-3); }
  .wiki-page-links :deep(.v-btn) { min-height: 44px; }
  .wiki-page-links__stale { align-items: stretch; flex-direction: column; }
}
@media (forced-colors: active) {
  .wiki-page-links, .wiki-page-links__direction, .wiki-page-links__item, .wiki-page-links__stale { border-color: CanvasText; }
}
</style>
