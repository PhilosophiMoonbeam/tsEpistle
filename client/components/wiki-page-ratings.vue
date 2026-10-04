<template lang="pug">
section.wiki-page-ratings(:aria-busy="loading || submitting ? 'true' : undefined" aria-labelledby="wiki-page-ratings-title")
  header.wiki-page-ratings__heading
    h2#wiki-page-ratings-title {{ $t('common:pageRatings.title') }}
    p.wiki-page-ratings__aggregate(v-if="view && !stale") {{ summary }}
    p.wiki-page-ratings__prompt(v-else-if="!isHuman") {{ $t('common:pageRatings.signInToRate') }}

  template(v-if="isHuman")
    async-state.wiki-page-ratings__loading(v-if="loading && !view" state="loading" :title="$t('common:pageRatings.loading')")

    .wiki-page-ratings__load-error(v-else-if="!view && error && !stale")
      p.wiki-page-ratings__error(role="alert") {{ error }}
      v-btn(type="button" size="small" variant="text" prepend-icon="mdi-refresh" @click="refresh") {{ $t('common:page.tryAgain') }}

    .wiki-page-ratings__stale(v-else-if="stale")
      p(role="status" aria-live="polite") {{ staleMessage }}
      p.wiki-page-ratings__error(v-if="error" role="alert") {{ error }}
      v-btn(type="button" size="small" variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="loading || submitting" @click="refresh") {{ $t('common:pageRatings.refresh') }}

    template(v-else-if="view")
      p.wiki-page-ratings__error(v-if="error" role="alert") {{ error }}

      .wiki-page-ratings__controls.wiki-page-ratings__controls--thumbs(
        v-if="view.kind === 'thumbs'"
        :class="{ 'wiki-page-ratings__controls--voted': view.ownVote !== null }"
        role="group"
        :aria-label="$t('common:pageRatings.rateThisPage')"
      )
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
          :aria-label="$t('common:pageRatings.rateHelpful', { count: view.distribution['1'] })"
          @click="saveVote(1)"
        )
          v-icon(aria-hidden="true") {{ view.ownVote === 1 ? 'mdi-thumb-up' : 'mdi-thumb-up-outline' }}
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
          :aria-label="$t('common:pageRatings.rateNotHelpful', { count: view.distribution['-1'] })"
          @click="saveVote(-1)"
        )
          v-icon(aria-hidden="true") {{ view.ownVote === -1 ? 'mdi-thumb-down' : 'mdi-thumb-down-outline' }}
        v-tooltip(v-if="view.ownVote !== null" location="bottom")
          template(#activator="{ props: tooltipProps }")
            v-btn(
              v-bind="tooltipProps"
              class="wiki-page-ratings__remove"
              type="button"
              size="small"
              variant="outlined"
              :disabled="!canVote"
              :loading="submitting && pendingVote === null"
              :aria-label="$t('common:pageRatings.removeMine')"
              @click="removeVote"
            )
              v-icon(aria-hidden="true") mdi-close-circle-outline
          span {{ $t('common:pageRatings.removeMine') }}
      .wiki-page-ratings__balance(
        v-if="view.kind === 'thumbs' && view.ownVote !== null && view.count > 0"
        role="img"
        :aria-label="$t('common:pageRatings.balance', { helpful: view.distribution['1'], notHelpful: view.distribution['-1'] })"
      )
        .wiki-page-ratings__balance-positive(:style="{ flexGrow: view.distribution['1'] }" aria-hidden="true")
        .wiki-page-ratings__balance-negative(:style="{ flexGrow: view.distribution['-1'] }" aria-hidden="true")

      .wiki-page-ratings__controls.wiki-page-ratings__controls--stars(v-if="view.kind === 'stars'" role="group" :aria-label="$t('common:pageRatings.chooseStars')")
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
          :aria-label="$t('common:pageRatings.rateStars', { count: value })"
          @click="saveVote(value)"
        )
          v-icon(aria-hidden="true") {{ view.ownVote !== null && value <= view.ownVote ? 'mdi-star' : 'mdi-star-outline' }}

      .wiki-page-ratings__personal(v-if="(view.kind === 'stars' && view.ownVote !== null) || submitting || loading || feedback")
        p.wiki-page-ratings__own-vote(v-if="view.kind === 'stars' && view.ownVote !== null") {{ $t('common:pageRatings.yours', { value: view.ownVote }) }}
        span.wiki-page-ratings__feedback(v-if="submitting || loading || feedback" role="status" aria-live="polite" aria-atomic="true")
          v-progress-circular(v-if="submitting || loading" color="primary" :size="16" :width="2" indeterminate aria-hidden="true")
          | {{ submitting ? $t('common:pageRatings.saving') : (loading ? $t('common:pageRatings.refreshing') : feedback) }}
        v-btn(
          v-if="view.kind === 'stars' && view.ownVote !== null"
          class="wiki-page-ratings__remove"
          type="button"
          size="small"
          variant="outlined"
          :disabled="!canVote"
          :loading="submitting && pendingVote === null"
          :aria-label="$t('common:pageRatings.removeMine')"
          @click="removeVote"
        ) {{ $t('common:pageRatings.remove') }}
</template>

<script setup lang="ts">
import i18next from 'i18next'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AsyncState from './common/async-state.vue'
import { fetchPageRating, PageRatingApiError, putPageRating, removePageRating } from '../helpers/page-ratings-api.ts'
import type { PageRatingView, PageRatingVote } from '../../shared/page-ratings.ts'
import { wikiStore } from '../store/index.ts'

const props = defineProps<{ pageId: number }>()
const t = (key: string, options?: Record<string, unknown>): string => i18next.t(`common:pageRatings.${key}`, options)
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
  if (!rating || rating.count === 0) return t('none')
  if (rating.kind === 'thumbs') return t('votes', { count: rating.count })
  const count = t('ratings', { count: rating.count })
  return rating.score === null ? count : `${t('score', { score: rating.score.toFixed(1) })} · ${count}`
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
    const result = await fetchPageRating(window.fetch.bind(window), pageId, t('loadError'), controller.signal)
    if (disposed || sequence !== requestSequence || controller.signal.aborted || props.pageId !== pageId) return
    view.value = result
    stale.value = false
    if (keepStaleOnFailure) {
      staleMessage.value = ''
      feedback.value = t('totalsRefreshed')
    }
  } catch (cause) {
    if (disposed || sequence !== requestSequence || controller.signal.aborted || props.pageId !== pageId) return
    error.value = cause instanceof Error ? cause.message : t('loadError')
    const conflict = cause instanceof PageRatingApiError && cause.status === 409
    const accessChanged = cause instanceof PageRatingApiError && (cause.status === 401 || cause.status === 403)
    stale.value = keepStaleOnFailure || conflict || accessChanged
    if (conflict) staleMessage.value = t('conflict')
    else if (accessChanged) staleMessage.value = t('accessChanged')
    else if (keepStaleOnFailure) staleMessage.value = t('refreshFailed')
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
    feedback.value = t('saved')
  } catch (cause) {
    if (!currentContext(generation, pageId)) return
    if (cause instanceof PageRatingApiError && cause.status === 409) {
      await refreshAfterMutationRejection(generation, pageId, t('modeChanged'))
    } else if (cause instanceof PageRatingApiError && (cause.status === 401 || cause.status === 403)) {
      await refreshAfterMutationRejection(generation, pageId, t('accessChangedTotals'))
    } else {
      error.value = cause instanceof Error ? cause.message : t('saveError')
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
    feedback.value = t('removed')
  } catch (cause) {
    if (!currentContext(generation, pageId)) return
    if (cause instanceof PageRatingApiError && cause.status === 409) {
      await refreshAfterMutationRejection(generation, pageId, t('modeChanged'))
    } else if (cause instanceof PageRatingApiError && (cause.status === 401 || cause.status === 403)) {
      await refreshAfterMutationRejection(generation, pageId, t('accessChangedTotals'))
    } else {
      error.value = cause instanceof Error ? cause.message : t('removeError')
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
  font-size: .875rem;
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
  color: var(--wiki-text-muted);
  font-variant-numeric: tabular-nums;
  text-align: end;
}

.wiki-page-ratings__prompt {
  flex: 1 1 100%;
  color: var(--wiki-text-muted);
}

/* Shared async-state, sized down for the narrow rail card. */
.wiki-page-ratings__loading {
  min-height: 0;
  padding: var(--wiki-space-3);
  justify-content: flex-start;
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

.wiki-page-ratings__controls--voted {
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
  justify-content: center;
}

.wiki-page-ratings__controls--thumbs :deep(.v-icon) {
  font-size: 1rem;
}

.wiki-page-ratings__controls--thumbs .wiki-page-ratings__remove {
  margin-inline-start: 0;
  padding: 2px 3px;
}

.wiki-page-ratings__balance {
  display: flex;
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
}

.wiki-page-ratings__balance-positive,
.wiki-page-ratings__balance-negative {
  flex-basis: 0;
  min-width: 0;
}

.wiki-page-ratings__balance-positive {
  background: rgb(var(--v-theme-success));
}

.wiki-page-ratings__balance-negative {
  background: rgb(var(--v-theme-error));
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
  color: var(--wiki-text-muted);
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

  .wiki-page-ratings__balance-positive {
    background: Highlight;
  }

  .wiki-page-ratings__balance-negative {
    background: CanvasText;
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
