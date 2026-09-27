<template lang="pug">
section.wiki-page-ratings(:aria-busy="loading || submitting ? 'true' : undefined" aria-labelledby="wiki-page-ratings-title")
  .wiki-page-ratings__heading
    h2#wiki-page-ratings-title Page rating
    span.wiki-page-ratings__mode(v-if="view && !stale") {{ view.kind === 'thumbs' ? 'Thumbs' : 'Stars' }}

  v-alert(v-if="!ratingsEnabled" type="info" variant="tonal" density="compact" role="status") Ratings are not available on this site.
  v-alert(v-else-if="!isHuman" type="info" variant="tonal" density="compact" role="status") Sign in with a personal account to view or cast a rating.

  async-state(v-else-if="loading && !view" state="loading" title="Loading page rating")
  async-state(v-else-if="!view && error && !stale" state="error" title="Page rating could not be loaded" :message="error" retry-label="Try again" @retry="refresh")

  template(v-else-if="view && !stale")
    v-alert(v-if="error" type="error" variant="tonal" density="compact" role="alert") {{ error }}
    v-alert(v-if="view.count === 0" type="info" variant="tonal" density="compact" role="status") No ratings have been cast on this page yet.
    .wiki-page-ratings__summary(aria-live="polite" aria-atomic="true")
      strong {{ summary }}
      span(v-if="view.ownVote !== null") Your rating: {{ view.kind === 'stars' ? `${view.ownVote} out of 5 stars` : (view.ownVote === 1 ? 'Helpful' : 'Not helpful') }}.
      span(v-else-if="!isHuman") Sign in with a personal account to rate this page.
    .wiki-page-ratings__controls(v-if="view.kind === 'thumbs'" role="group" aria-label="Rate this page")
      v-btn(
        type="button"
        size="small"
        :variant="view.ownVote === 1 ? 'tonal' : 'outlined'"
        :color="view.ownVote === 1 ? 'primary' : undefined"
        :disabled="!canVote"
        :loading="submitting && pendingVote === 1"
        :aria-pressed="view.ownVote === 1 ? 'true' : 'false'"
        :aria-label="`Rate this page as helpful, ${view.distribution['1']} votes`"
        @click="saveVote(1)"
      )
        v-icon(start aria-hidden="true") mdi-thumb-up-outline
        | Helpful · {{ view.distribution['1'] }}
      v-btn(
        type="button"
        size="small"
        :variant="view.ownVote === -1 ? 'tonal' : 'outlined'"
        :color="view.ownVote === -1 ? 'primary' : undefined"
        :disabled="!canVote"
        :loading="submitting && pendingVote === -1"
        :aria-pressed="view.ownVote === -1 ? 'true' : 'false'"
        :aria-label="`Rate this page as not helpful, ${view.distribution['-1']} votes`"
        @click="saveVote(-1)"
      )
        v-icon(start aria-hidden="true") mdi-thumb-down-outline
        | Not helpful · {{ view.distribution['-1'] }}

    .wiki-page-ratings__controls(v-else role="group" aria-label="Choose your star rating")
      v-btn(
        v-for="value in starValues"
        :key="value"
        type="button"
        icon
        size="small"
        variant="text"
        :color="view.ownVote !== null && value <= view.ownVote ? 'primary' : undefined"
        :loading="submitting && pendingVote === value"
        :aria-pressed="view.ownVote === value ? 'true' : 'false'"
        :aria-label="`Rate this page ${value} out of 5 stars`"
        @click="saveVote(value)"
      )
        v-icon(aria-hidden="true") {{ view.ownVote !== null && value <= view.ownVote ? 'mdi-star' : 'mdi-star-outline' }}
      span.wiki-page-ratings__score(v-if="view.score !== null") Average {{ view.score.toFixed(1) }} / 5

    .wiki-page-ratings__footer
      span(v-if="isHuman && loading") Refreshing current rating totals…
      v-btn(
        v-if="view.ownVote !== null"
        type="button"
        size="small"
        variant="text"
        :disabled="!canVote"
        :loading="submitting && pendingVote === null"
        @click="removeVote"
      ) Remove my rating
    p.wiki-page-ratings__feedback(v-if="feedback" role="status" aria-live="polite" aria-atomic="true") {{ feedback }}

  .wiki-page-ratings__stale(v-else-if="stale" role="status" aria-live="polite")
    p {{ staleMessage }}
    v-alert(v-if="error" type="error" variant="tonal" density="compact" role="alert") {{ error }}
    v-btn(type="button" size="small" variant="outlined" prepend-icon="mdi-refresh" :loading="loading" :disabled="loading || submitting" @click="refresh") Refresh rating
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AsyncState from './common/async-state.vue'
import { fetchPageRating, PageRatingApiError, putPageRating, removePageRating } from '../helpers/page-ratings-api.ts'
import type { PageRatingView, PageRatingVote } from '../../shared/page-ratings.ts'
import { wikiStore } from '../store/index.ts'

const props = defineProps<{ pageId: number }>()
const starValues = [1, 2, 3, 4, 5] as const
const view = ref<PageRatingView | null>(null)
const loading = ref(false)
const submitting = ref(false)
const error = ref('')
const stale = ref(false)
const staleMessage = ref('')
const feedback = ref('')
const pendingVote = ref<number | null>(null)
let requestSequence = 0
let contextSequence = 0
let activeController: AbortController | null = null
let disposed = false

const ratingsEnabled = computed(() => typeof window !== 'undefined' && window.siteConfig?.featurePageRatings === true)
const isHuman = computed(() =>
  wikiStore.user.authenticated === true &&
  Number.isSafeInteger(wikiStore.user.id) &&
  wikiStore.user.id > 0 &&
  wikiStore.user.id !== 2 &&
  wikiStore.user.email !== 'api@localhost' &&
  wikiStore.authRefreshSettled === true &&
  wikiStore.authRefreshOutcome === 'authenticated' &&
  wikiStore.authRefreshPending === false
)
const canVote = computed(() => ratingsEnabled.value && isHuman.value && view.value !== null && !loading.value && !submitting.value && !stale.value)
const summary = computed(() => {
  const rating = view.value
  if (!rating) return ''
  if (rating.kind === 'thumbs') {
    return `${rating.count} ${rating.count === 1 ? 'vote' : 'votes'} · ${rating.distribution['1']} helpful · ${rating.distribution['-1']} not helpful`
  }
  return `${rating.count} ${rating.count === 1 ? 'rating' : 'ratings'} · ${rating.score === null ? 'No average yet' : `Average ${rating.score.toFixed(1)} out of 5`}`
})

const currentContext = (generation: number, pageId: number): boolean =>
  !disposed && contextSequence === generation && props.pageId === pageId

const fetchCurrentRating = async (keepStaleOnFailure = false): Promise<void> => {
  const pageId = props.pageId
  if (!ratingsEnabled.value || !isHuman.value || !Number.isSafeInteger(pageId) || pageId < 1) return

  const sequence = ++requestSequence
  activeController?.abort()
  const controller = new AbortController()
  activeController = controller
  loading.value = true
  error.value = ''
  feedback.value = ''
  if (!keepStaleOnFailure) {
    stale.value = false
    staleMessage.value = ''
  }

  try {
    const result = await fetchPageRating(window.fetch.bind(window), pageId, 'Page rating could not be loaded.', controller.signal)
    if (disposed || sequence !== requestSequence || controller.signal.aborted || props.pageId !== pageId) return
    view.value = result
    stale.value = false
    if (keepStaleOnFailure) {
      staleMessage.value = ''
      feedback.value = 'Current totals have been refreshed. Choose a rating again if you wish.'
    }
  } catch (cause) {
    if (disposed || sequence !== requestSequence || controller.signal.aborted || props.pageId !== pageId) return
    error.value = cause instanceof Error ? cause.message : 'Page rating could not be loaded.'
    const conflict = cause instanceof PageRatingApiError && cause.status === 409
    const accessChanged = cause instanceof PageRatingApiError && (cause.status === 401 || cause.status === 403)
    stale.value = keepStaleOnFailure || conflict || accessChanged
    if (conflict) staleMessage.value = 'The current rating could not be reconciled. Refresh before using these controls.'
    else if (accessChanged) staleMessage.value = 'Your session or rating access changed. Refresh current rating data before voting.'
    else if (keepStaleOnFailure) staleMessage.value = 'Current totals could not be refreshed. Try again before voting.'
  } finally {
    if (!disposed && sequence === requestSequence) {
      loading.value = false
      activeController = null
    }
  }
}

const refresh = (): void => {
  if (loading.value || submitting.value || !ratingsEnabled.value || !isHuman.value) return
  void fetchCurrentRating(stale.value)
}

const refreshAfterMutationRejection = async (generation: number, pageId: number, message: string): Promise<void> => {
  if (!currentContext(generation, pageId)) return
  stale.value = true
  staleMessage.value = message
  view.value = null
  await fetchCurrentRating(true)
}

const saveVote = async (value: number): Promise<void> => {
  const current = view.value
  if (!canVote.value || !current) return
  let vote: PageRatingVote
  if (current.kind === 'thumbs') {
    if (value !== -1 && value !== 1) return
    vote = { kind: 'thumbs', value }
  } else {
    if (!Number.isSafeInteger(value) || value < 1 || value > 5) return
    vote = { kind: 'stars', value }
  }
  if (current.ownVote === value) return
  const pageId = props.pageId
  const generation = contextSequence
  submitting.value = true
  pendingVote.value = value
  error.value = ''
  feedback.value = ''
  try {
    const result = await putPageRating(window.fetch.bind(window), pageId, vote)
    if (!currentContext(generation, pageId)) return
    view.value = result
    stale.value = false
    feedback.value = 'Your rating was saved.'
  } catch (cause) {
    if (!currentContext(generation, pageId)) return
    if (cause instanceof PageRatingApiError && cause.status === 409) {
      await refreshAfterMutationRejection(generation, pageId, 'The active rating mode changed. Refreshing current totals before another vote.')
    } else if (cause instanceof PageRatingApiError && (cause.status === 401 || cause.status === 403)) {
      await refreshAfterMutationRejection(generation, pageId, 'Your session or rating access changed. Refresh current totals before voting.')
    } else {
      error.value = cause instanceof Error ? cause.message : 'Your rating could not be saved.'
    }
  } finally {
    if (currentContext(generation, pageId)) {
      submitting.value = false
      pendingVote.value = null
    }
  }
}

const removeVote = async (): Promise<void> => {
  if (!canVote.value || !view.value || view.value.ownVote === null) return
  const pageId = props.pageId
  const generation = contextSequence
  submitting.value = true
  pendingVote.value = null
  error.value = ''
  feedback.value = ''
  try {
    const result = await removePageRating(window.fetch.bind(window), pageId)
    if (!currentContext(generation, pageId)) return
    view.value = result
    stale.value = false
    feedback.value = 'Your rating was removed.'
  } catch (cause) {
    if (!currentContext(generation, pageId)) return
    if (cause instanceof PageRatingApiError && cause.status === 409) {
      await refreshAfterMutationRejection(generation, pageId, 'The active rating mode changed. Refreshing current totals before another vote.')
    } else if (cause instanceof PageRatingApiError && (cause.status === 401 || cause.status === 403)) {
      await refreshAfterMutationRejection(generation, pageId, 'Your session or rating access changed. Refresh current totals before voting.')
    } else {
      error.value = cause instanceof Error ? cause.message : 'Your rating could not be removed.'
    }
  } finally {
    if (currentContext(generation, pageId)) {
      submitting.value = false
      pendingVote.value = null
    }
  }
}

watch(
  [() => props.pageId, ratingsEnabled, isHuman],
  ([pageId, enabled, human]) => {
    contextSequence++
    requestSequence++
    activeController?.abort()
    activeController = null
    view.value = null
    loading.value = false
    submitting.value = false
    pendingVote.value = null
    error.value = ''
    stale.value = false
    staleMessage.value = ''
    feedback.value = ''
    if (enabled && human && Number.isSafeInteger(pageId) && pageId > 0) void fetchCurrentRating()
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
.wiki-page-ratings {
  display: grid;
  gap: .75rem;
  min-width: 0;
}

.wiki-page-ratings__heading,
.wiki-page-ratings__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
}

.wiki-page-ratings__heading h2 {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: .95rem;
  font-weight: 650;
  letter-spacing: -.015em;
}

.wiki-page-ratings__mode {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: .72rem;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.wiki-page-ratings__summary,
.wiki-page-ratings__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: .5rem;
}

.wiki-page-ratings__summary {
  color: rgb(var(--v-theme-on-surface-variant));
  flex-direction: column;
  align-items: flex-start;
  font-size: .82rem;
}

.wiki-page-ratings__summary strong {
  color: rgb(var(--v-theme-on-surface));
  font-size: .9rem;
  font-weight: 600;
}

.wiki-page-ratings__score {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: .8rem;
  margin-inline-start: .25rem;
}

.wiki-page-ratings__footer {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: .78rem;
}

.wiki-page-ratings__feedback {
  margin: 0;
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: .8rem;
}

.wiki-page-ratings__stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  padding: .75rem;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 32%, transparent);
  border-radius: var(--wiki-control-radius, .875rem);
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 7%, rgb(var(--v-theme-surface)));
}

.wiki-page-ratings__stale p {
  margin: 0;
  font-size: .82rem;
}

@media (max-width: 599.98px) {
  .wiki-page-ratings__stale {
    align-items: stretch;
    flex-direction: column;
  }
}

@media (forced-colors: active) {
  .wiki-page-ratings__stale {
    border-color: CanvasText;
  }
}
</style>
