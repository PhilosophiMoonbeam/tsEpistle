<template lang="pug">
section.wiki-page-links(:aria-busy="loading || loadingMore ? 'true' : undefined" aria-labelledby="wiki-page-links-title")
  .wiki-page-links__heading
    h2#wiki-page-links-title Links
    span.wiki-page-links__revision(v-if="!stale") Current page links

  .wiki-page-links__directions(role="group" aria-label="Page link direction")
    button.wiki-page-links__direction(
      type="button"
      :aria-pressed="direction === 'incoming' ? 'true' : 'false'"
      @click="setDirection('incoming')"
    )
      span Incoming
      small Pages linking here
    button.wiki-page-links__direction(
      type="button"
      :aria-pressed="direction === 'outgoing' ? 'true' : 'false'"
      @click="setDirection('outgoing')"
    )
      span Outgoing
      small Pages linked from here

  async-state(v-if="loading && items.length === 0 && !stale" state="loading" :title="loadingTitle")
  async-state(v-else-if="error && items.length === 0 && !stale" state="error" title="Page links could not be loaded" :message="error" retry-label="Try again" @retry="refresh")

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
    ) {{ requiresPageReload ? 'Reload page' : 'Refresh links' }}

  div#wiki-page-links-results(v-else)
    async-state(v-if="items.length === 0 && !hasMore" state="empty" :title="emptyTitle" :message="emptyMessage" announce)
    ul.wiki-page-links__list(v-else-if="items.length > 0" :aria-label="listLabel")
      li.wiki-page-links__item(v-for="item in items" :key="item.id")
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
      ) {{ error ? 'Try loading more again' : 'Load more links' }}
</template>

<script setup lang="ts">
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

const incoming = computed(() => direction.value === 'incoming')
const loadingTitle = computed(() => incoming.value ? 'Loading incoming links' : 'Loading outgoing links')
const emptyTitle = computed(() => incoming.value ? 'No visible incoming links' : 'No visible outgoing links')
const emptyMessage = computed(() => incoming.value
  ? 'No readable, current pages link to this page.'
  : 'This page has no readable, current outgoing links.')
const listLabel = computed(() => incoming.value ? 'Pages linking to this page' : 'Pages linked from this page')



const clearResults = (): void => {
  items.value = []
  nextCursor.value = null
  hasMore.value = false
  seenCursors.clear()
}

const markStale = (message: string, responseRevision?: string): void => {
  clearResults()
  stale.value = true
  staleMessage.value = message
  requiresPageReload.value = responseRevision !== undefined && responseRevision !== props.sourceRevision
  if (requiresPageReload.value) staleMessage.value = 'This page changed after it was opened. Reload the page to see links for its current revision.'
}


const currentContext = (sequence: number, pageId: number, currentDirection: PageLinksDirection, revision: string): boolean =>
  !disposed && contextSequence === sequence && props.pageId === pageId && direction.value === currentDirection && props.sourceRevision === revision

const acceptResponse = (
  response: PageLinksResponse,
  request: { sequence: number; pageId: number; direction: PageLinksDirection; revision: string; cursor?: string }
): void => {
  if (!currentContext(request.sequence, request.pageId, request.direction, request.revision)) return
  if (response.state === 'refresh') {
    markStale('The current link graph is not ready for this page revision. Refresh to check again.', response.sourceRevision)
    return
  }
  if (response.sourceRevision !== request.revision) {
    markStale('This page changed after it was opened. Reload the page to see links for its current revision.', response.sourceRevision)
    return
  }

  if (request.cursor !== undefined) {
    if (seenCursors.has(request.cursor)) {
      markStale('The page-link continuation is no longer safe to use. Refresh the links before continuing.')
      return
    }
    seenCursors.add(request.cursor)
  }
  if (response.nextCursor !== null && seenCursors.has(response.nextCursor)) {
    markStale('The page-link continuation is no longer safe to use. Refresh the links before continuing.')
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
    error.value = 'Choose a valid page before loading links.'
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
    error.value = cause instanceof Error ? cause.message : 'Page links could not be loaded.'
    if (cause instanceof PageLinksApiError && (cause.status === 409 || cause.code === 'INVALID_PAGE_LINK_CURSOR')) {
      markStale('The current link graph or continuation changed while these links were loading. Refresh to check for the current view.')
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
  gap: .9rem;
  min-width: 0;
}

.wiki-page-links__heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: .75rem;
}

.wiki-page-links__heading h2 {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1rem;
  font-weight: 650;
  letter-spacing: -.02em;
}

.wiki-page-links__revision {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: .75rem;
}

.wiki-page-links__directions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .5rem;
}

.wiki-page-links__direction {
  display: grid;
  gap: .2rem;
  min-width: 0;
  padding: .65rem .75rem;
  border: 1px solid color-mix(in srgb, rgb(var(--v-border-color)) 45%, transparent);
  border-radius: var(--wiki-control-radius, .875rem);
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 90%, transparent);
  color: rgb(var(--v-theme-on-surface-variant));
  text-align: start;
  cursor: pointer;
}

.wiki-page-links__direction[aria-pressed='true'] {
  border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 52%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 9%, rgb(var(--v-theme-surface)));
  color: rgb(var(--v-theme-on-surface));
}

.wiki-page-links__direction span {
  font-size: .88rem;
  font-weight: 600;
}

.wiki-page-links__direction small {
  font-size: .72rem;
  line-height: 1.35;
}

.wiki-page-links__direction:focus-visible,
.wiki-page-links__title:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 3px;
}

.wiki-page-links__list {
  display: grid;
  gap: .45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.wiki-page-links__item {
  display: grid;
  gap: .15rem;
  min-width: 0;
  padding: .65rem .75rem;
  border-inline-start: 2px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 42%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 94%, transparent);
}

.wiki-page-links__title {
  width: fit-content;
  max-width: 100%;
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
  overflow-wrap: anywhere;
  text-decoration: underline;
  text-decoration-thickness: .08em;
  text-underline-offset: .16em;
}

.wiki-page-links__path {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: .72rem;
  overflow-wrap: anywhere;
}

.wiki-page-links__more {
  display: flex;
  justify-content: center;
  padding-block: .25rem;
}

.wiki-page-links__stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  padding: .8rem;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 32%, transparent);
  border-radius: var(--wiki-control-radius, .875rem);
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 7%, rgb(var(--v-theme-surface)));
}

.wiki-page-links__stale p {
  margin: 0;
  font-size: .84rem;
}

@media (max-width: 599.98px) {
  .wiki-page-links__stale {
    align-items: stretch;
    flex-direction: column;
  }
}

@media (forced-colors: active) {
  .wiki-page-links__direction,
  .wiki-page-links__item,
  .wiki-page-links__stale {
    border-color: CanvasText;
  }
}
</style>
