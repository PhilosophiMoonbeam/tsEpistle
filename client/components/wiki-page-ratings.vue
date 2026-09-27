<template lang="pug">
section.wiki-page-ratings(:aria-busy="loading || submitting ? 'true' : undefined" aria-labelledby="wiki-page-ratings-title")
  header.wiki-page-ratings__heading
    h2#wiki-page-ratings-title Page rating
    p.wiki-page-ratings__prompt(v-if="!ratingsEnabled") Ratings are not available on this site.
    p.wiki-page-ratings__prompt(v-else-if="!isHuman") Sign in with a personal account to rate this page.
    p.wiki-page-ratings__prompt(v-else-if="view && !stale") {{ view.kind === 'thumbs' ? 'Was this page useful?' : 'How would you rate this page?' }}
    p.wiki-page-ratings__prompt(v-else-if="!stale") Reader feedback helps improve this page.

  template(v-if="ratingsEnabled && isHuman")
    template(v-if="loading && !view")
      .wiki-page-ratings__loading(role="status" aria-live="polite")
        v-progress-circular(color="primary" :size="20" :width="2" indeterminate aria-hidden="true")
        span Loading page rating…

    template(v-else-if="!view && error && !stale")
      .wiki-page-ratings__load-error
        p.wiki-page-ratings__error(role="alert") {{ error }}
        v-btn(type="button" size="small" variant="text" prepend-icon="mdi-refresh" @click="refresh") Try again

    template(v-else-if="view && !stale")
      p.wiki-page-ratings__error(v-if="error" role="alert") {{ error }}
      p.wiki-page-ratings__empty(v-if="view.count === 0") No ratings yet. Your response can be the first.

      .wiki-page-ratings__controls.wiki-page-ratings__controls--thumbs(v-if="view.kind === 'thumbs'" role="group" aria-label="Rate this page")
        v-btn(
          class="wiki-page-ratings__choice"
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
          span.wiki-page-ratings__choice-label Helpful
          span.wiki-page-ratings__choice-count(aria-hidden="true") {{ view.distribution['1'] }}
        v-btn(
          class="wiki-page-ratings__choice"
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
          span.wiki-page-ratings__choice-label Not helpful
          span.wiki-page-ratings__choice-count(aria-hidden="true") {{ view.distribution['-1'] }}

      .wiki-page-ratings__controls.wiki-page-ratings__controls--stars(v-else role="group" aria-label="Choose your star rating")
        v-btn(
          v-for="value in starValues"
          :key="value"
          class="wiki-page-ratings__star"
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

      .wiki-page-ratings__aggregate(aria-live="polite" aria-atomic="true")
        strong(v-if="view.kind === 'thumbs'") {{ view.count }} {{ view.count === 1 ? 'vote' : 'votes' }}
        strong(v-else) {{ summary }}
        span.wiki-page-ratings__own-vote(v-if="view.ownVote !== null") Your rating: {{ view.kind === 'stars' ? `${view.ownVote} out of 5 stars` : (view.ownVote === 1 ? 'Helpful' : 'Not helpful') }}.

      .wiki-page-ratings__footer
        span(v-if="isHuman && loading") Refreshing current rating totals…
        v-btn(
          v-if="view.ownVote !== null"
          class="wiki-page-ratings__remove"
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
      p.wiki-page-ratings__error(v-if="error" role="alert") {{ error }}
      v-btn(type="button" size="small" variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="loading || submitting" @click="refresh") Refresh rating
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
  box-sizing: border-box;
  display: grid;
  gap: var(--wiki-space-3);
  width: 100%;
  min-width: 0;
  padding: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs);
  color: rgb(var(--v-theme-on-surface));
}

.wiki-page-ratings__heading {
  display: grid;
  min-width: 0;
  gap: .25rem;
}

.wiki-page-ratings__heading h2 {
  margin: 0;
  font-family: var(--wiki-font-display);
  font-size: 1.05rem;
  font-weight: 560;
  letter-spacing: -.02em;
  line-height: 1.2;
}

.wiki-page-ratings__prompt {
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  font-size: .82rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__loading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: .8rem;
}

.wiki-page-ratings__load-error {
  display: grid;
  justify-items: start;
  gap: var(--wiki-space-1);
}

.wiki-page-ratings__error {
  margin: 0;
  color: rgb(var(--v-theme-error));
  font-size: .8rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__empty,
.wiki-page-ratings__own-vote,
.wiki-page-ratings__feedback {
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: .78rem;
  line-height: 1.4;
}

.wiki-page-ratings__controls {
  display: grid;
  min-width: 0;
}

.wiki-page-ratings__controls--thumbs {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--wiki-space-2);
}

.wiki-page-ratings__controls--thumbs :deep(.v-btn) {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 2.75rem;
  padding-inline: .35rem;
}

.wiki-page-ratings__controls--thumbs :deep(.v-btn__content) {
  flex-wrap: wrap;
  justify-content: center;
  gap: .12rem .25rem;
  line-height: 1.15;
  white-space: normal;
}

.wiki-page-ratings__choice-label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__choice-count {
  color: color-mix(in srgb, currentColor 72%, transparent);
  font-size: .75em;
  font-variant-numeric: tabular-nums;
}

.wiki-page-ratings__controls--stars {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: .25rem;
}

.wiki-page-ratings__controls--stars :deep(.v-btn) {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 2.75rem;
  aspect-ratio: 1;
  padding: 0;
}

.wiki-page-ratings__controls--stars :deep(.v-icon) {
  font-size: 1.25rem;
}

.wiki-page-ratings :deep(.v-btn) {
  letter-spacing: normal;
  text-transform: none;
}
.wiki-page-ratings :deep(.v-btn:focus-visible) {
  outline: 2px solid var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
  outline-offset: 2px;
}

.wiki-page-ratings__aggregate {
  display: grid;
  min-width: 0;
  gap: .15rem;
  padding-block-start: var(--wiki-space-2);
  border-block-start: 1px solid var(--wiki-surface-border);
}

.wiki-page-ratings__aggregate strong {
  font-size: .82rem;
  font-weight: 650;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__footer {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: .75rem;
}

.wiki-page-ratings__footer :deep(.v-btn) {
  min-width: 0;
  min-height: 2.75rem;
  margin-inline-start: auto;
  padding-inline: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 76%, transparent);
}

.wiki-page-ratings__feedback {
  color: rgb(var(--v-theme-success));
}

.wiki-page-ratings__stale {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-2);
  padding-block-start: var(--wiki-space-3);
  border-block-start: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 38%, var(--wiki-surface-border));
}

.wiki-page-ratings__stale > p:first-child {
  flex: 1 1 11rem;
  min-width: 0;
  margin: 0;
  font-size: .8rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.wiki-page-ratings__stale :deep(.v-btn) {
  min-width: 0;
  min-height: 2.75rem;
  padding-inline: var(--wiki-space-2);
}

@media (max-width: 20rem) {
  .wiki-page-ratings {
    gap: var(--wiki-space-2);
    padding: var(--wiki-space-2);
  }

  .wiki-page-ratings__controls--thumbs {
    gap: var(--wiki-space-1);
  }

  .wiki-page-ratings__controls--stars {
    gap: .125rem;
  }

  .wiki-page-ratings__stale {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (forced-colors: active) {
  .wiki-page-ratings {
    border-color: CanvasText;
    box-shadow: none;
  }

  .wiki-page-ratings__stale {
    border-block-start-color: CanvasText;
  }

  .wiki-page-ratings :deep(.v-btn:focus-visible) {
    outline-color: Highlight;
  }

  .wiki-page-ratings__controls--thumbs :deep(.v-btn--variant-outlined) {
    border-color: ButtonText;
  }
}
</style>
