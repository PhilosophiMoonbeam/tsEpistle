<template lang="pug">
section.wiki-page-ratings(:aria-busy="loading || submitting ? 'true' : undefined" aria-labelledby="wiki-page-ratings-title")
  header.wiki-page-ratings__heading
    h2#wiki-page-ratings-title Page rating
    p.wiki-page-ratings__aggregate(v-if="view && !stale") {{ summary }}
    p.wiki-page-ratings__prompt(v-else-if="!isHuman") Sign in with a personal account to rate.

  template(v-if="isHuman")
    .wiki-page-ratings__loading(v-if="loading && !view" role="status" aria-live="polite")
      v-progress-circular(color="primary" :size="18" :width="2" indeterminate aria-hidden="true")
      span Loading page rating…

    .wiki-page-ratings__load-error(v-else-if="!view && error && !stale")
      p.wiki-page-ratings__error(role="alert") {{ error }}
      v-btn(type="button" size="small" variant="text" prepend-icon="mdi-refresh" @click="refresh") Try again

    .wiki-page-ratings__stale(v-else-if="stale")
      p(role="status" aria-live="polite") {{ staleMessage }}
      p.wiki-page-ratings__error(v-if="error" role="alert") {{ error }}
      v-btn(type="button" size="small" variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="loading || submitting" @click="refresh") Refresh rating

    template(v-else-if="view")
      p.wiki-page-ratings__error(v-if="error" role="alert") {{ error }}

      .wiki-page-ratings__controls.wiki-page-ratings__controls--thumbs(v-if="view.kind === 'thumbs'" role="group" aria-label="Rate this page")
        v-btn(
          class="wiki-page-ratings__choice"
          :class="{ 'wiki-page-ratings__choice--selected': view.ownVote === 1 }"
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
          v-icon(start aria-hidden="true") {{ view.ownVote === 1 ? 'mdi-thumb-up' : 'mdi-thumb-up-outline' }}
          span.wiki-page-ratings__choice-label Helpful
          span.wiki-page-ratings__choice-count(aria-hidden="true") {{ view.distribution['1'] }}
        v-btn(
          class="wiki-page-ratings__choice"
          :class="{ 'wiki-page-ratings__choice--selected': view.ownVote === -1 }"
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
          v-icon(start aria-hidden="true") {{ view.ownVote === -1 ? 'mdi-thumb-down' : 'mdi-thumb-down-outline' }}
          span.wiki-page-ratings__choice-label Not helpful
          span.wiki-page-ratings__choice-count(aria-hidden="true") {{ view.distribution['-1'] }}

      .wiki-page-ratings__controls.wiki-page-ratings__controls--stars(v-else role="group" aria-label="Choose your star rating")
        v-btn(
          v-for="value in starValues"
          :key="value"
          class="wiki-page-ratings__star"
          :class="{ 'wiki-page-ratings__star--selected': view.ownVote === value }"
          type="button"
          icon
          size="small"
          variant="text"
          :color="view.ownVote !== null && value <= view.ownVote ? 'primary' : undefined"
          :disabled="!canVote"
          :loading="submitting && pendingVote === value"
          :aria-pressed="view.ownVote === value ? 'true' : 'false'"
          :aria-label="`Rate this page ${value} out of 5 stars`"
          @click="saveVote(value)"
        )
          v-icon(aria-hidden="true") {{ view.ownVote !== null && value <= view.ownVote ? 'mdi-star' : 'mdi-star-outline' }}

      .wiki-page-ratings__personal(v-if="view.ownVote !== null || submitting || loading || feedback")
        p.wiki-page-ratings__own-vote(v-if="view.ownVote !== null") Yours: {{ view.kind === 'stars' ? `${view.ownVote}/5` : (view.ownVote === 1 ? 'Helpful' : 'Not helpful') }}
        span.wiki-page-ratings__feedback(v-if="submitting || loading || feedback" role="status" aria-live="polite" aria-atomic="true")
          v-progress-circular(v-if="submitting || loading" color="primary" :size="16" :width="2" indeterminate aria-hidden="true")
          | {{ submitting ? 'Saving your rating…' : (loading ? 'Refreshing rating totals…' : feedback) }}
        v-btn(
          v-if="view.ownVote !== null"
          class="wiki-page-ratings__remove"
          type="button"
          size="small"
          variant="outlined"
          :disabled="!canVote"
          :loading="submitting && pendingVote === null"
          aria-label="Remove my rating"
          @click="removeVote"
        ) Remove
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
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
const canVote = computed(() => isHuman.value && view.value !== null && !loading.value && !submitting.value && !stale.value)
const summary = computed(() => {
  const rating = view.value
  if (!rating || rating.count === 0) return 'No ratings yet'
  if (rating.kind === 'thumbs') return `${rating.count} ${rating.count === 1 ? 'vote' : 'votes'}`
  return `${rating.score === null ? '' : `${rating.score.toFixed(1)}/5 · `}${rating.count} ${rating.count === 1 ? 'rating' : 'ratings'}`
})

const currentContext = (generation: number, pageId: number): boolean =>
  !disposed && contextSequence === generation && props.pageId === pageId

const fetchCurrentRating = async (keepStaleOnFailure = false): Promise<void> => {
  const pageId = props.pageId
  if (!isHuman.value || !Number.isSafeInteger(pageId) || pageId < 1) return

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
  if (loading.value || submitting.value || !isHuman.value) return
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
  [() => props.pageId, isHuman],
  ([pageId, human]) => {
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
    if (human && Number.isSafeInteger(pageId) && pageId > 0) void fetchCurrentRating()
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
  box-sizing: border-box;
  display: grid;
  gap: 4px;
  width: 100%;
  min-width: 0;
  padding: 12px 8px;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs);
  color: rgb(var(--v-theme-on-surface));
}

.wiki-page-ratings__heading {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 8px;
}

.wiki-page-ratings__heading h2 {
  min-width: 0;
  margin: 0;
  font-family: var(--wiki-font-display);
  font-size: 1.05rem;
  font-weight: 560;
  letter-spacing: -.02em;
  line-height: 1.2;
}

.wiki-page-ratings__aggregate,
.wiki-page-ratings__prompt {
  min-width: 0;
  margin: 0;
  font-size: .78rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__aggregate {
  flex: 0 1 auto;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 78%, transparent);
  font-variant-numeric: tabular-nums;
  text-align: end;
}

.wiki-page-ratings__prompt {
  flex: 1 1 100%;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 78%, transparent);
}

.wiki-page-ratings__loading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 78%, transparent);
  font-size: .78rem;
  line-height: 1.4;
}

.wiki-page-ratings__load-error {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.wiki-page-ratings__error {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  color: rgb(var(--v-theme-error));
  font-size: .78rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__controls {
  min-width: 0;
}

.wiki-page-ratings__controls--thumbs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
}

.wiki-page-ratings__controls--thumbs :deep(.v-btn) {
  box-sizing: border-box;
  width: 100%;
  min-width: 30px;
  min-height: 30px;
  height: auto;
  padding: 2px 3px;
  font-size: .75rem;
}

.wiki-page-ratings__controls--thumbs :deep(.v-btn__content) {
  flex-wrap: wrap;
  justify-content: center;
  gap: .12rem .25rem;
  line-height: 1.15;
  white-space: normal;
}

.wiki-page-ratings__controls--thumbs :deep(.v-icon) {
  margin-inline-end: 0;
  font-size: 1rem;
}

.wiki-page-ratings__choice-label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__choice-count {
  color: color-mix(in srgb, currentColor 78%, transparent);
  font-size: .75em;
  font-variant-numeric: tabular-nums;
}

.wiki-page-ratings__choice--selected {
  border: 1px solid var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
}

.wiki-page-ratings__controls--stars {
  display: flex;
  width: 220px;
  max-width: 100%;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px;
}

.wiki-page-ratings__controls--stars :deep(.v-btn) {
  box-sizing: border-box;
  flex: 0 0 30px;
  width: 30px;
  min-width: 30px;
  height: 30px;
  min-height: 30px;
  padding: 0;
  border: 1px solid transparent;
}

.wiki-page-ratings__controls--stars :deep(.v-icon) {
  font-size: 1.25rem;
}

.wiki-page-ratings__star--selected {
  border-color: var(--wiki-accent-ink, rgb(var(--v-theme-primary))) !important;
  background-color: color-mix(in srgb, var(--wiki-accent-ink, rgb(var(--v-theme-primary))) 12%, var(--wiki-surface-raised));
}

.wiki-page-ratings :deep(.v-btn) {
  letter-spacing: normal;
  text-transform: none;
}

.wiki-page-ratings :deep(.v-btn:focus-visible) {
  outline: 2px solid var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
  outline-offset: 2px;
}

.wiki-page-ratings__personal {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.wiki-page-ratings__own-vote {
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 78%, transparent);
  font-size: .78rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__feedback {
  display: inline-flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 5px;
  margin: 0;
  color: rgb(var(--v-theme-success));
  font-size: .78rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__remove {
  min-width: 30px;
  min-height: 30px;
  height: 30px;
  margin-inline-start: auto;
  padding-inline: 10px;
}

.wiki-page-ratings__stale {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.wiki-page-ratings__stale > p:first-child {
  flex: 1 1 11rem;
  min-width: 0;
  margin: 0;
  font-size: .78rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__stale :deep(.v-btn),
.wiki-page-ratings__load-error :deep(.v-btn) {
  min-width: 30px;
  min-height: 30px;
  height: 30px;
}

@media (forced-colors: active) {
  .wiki-page-ratings {
    border-color: CanvasText;
    background: Canvas;
    color: CanvasText;
    box-shadow: none;
  }

  .wiki-page-ratings__choice--selected {
    border-color: Highlight !important;
    background: Highlight;
    color: HighlightText !important;
  }

  .wiki-page-ratings__star--selected {
    border-color: Highlight !important;
    background: Highlight;
    color: HighlightText !important;
  }

  .wiki-page-ratings :deep(.v-btn--variant-outlined) {
    border-color: ButtonText;
  }

  .wiki-page-ratings :deep(.v-btn--disabled) {
    color: GrayText;
  }

  .wiki-page-ratings :deep(.v-btn:focus-visible) {
    outline-color: Highlight;
  }
}
</style>
