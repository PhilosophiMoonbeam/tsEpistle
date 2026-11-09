<template>
  <section class="feedback-board" :aria-labelledby="headingId" :aria-busy="loading">
    <h2 :id="headingId" tabindex="-1" ref="heading">{{ board.name }}</h2>
    <p>Proposals are ordinary canonical pages with independently checked access. Priority votes are not helpfulness ratings or accuracy verification.</p>
    <form class="feedback-filters" @submit.prevent="applyFilters">
      <label>Search permitted proposals <input v-model="search" type="search" maxlength="200" /></label>
      <label>Sort <select v-model="sort" @change="applyFilters"><option value="top">Top</option><option value="trending">Trending — current seven-day votes</option><option value="newest">Newest</option></select></label>
      <fieldset><legend>Explicit statuses (none selected uses sort defaults)</legend><label v-for="state in states" :key="state"><input v-model="statuses" :value="state" type="checkbox" @change="applyFilters" /> {{ state }}</label></fieldset>
      <fieldset v-if="board.categories.some(item => item.active)"><legend>Categories (none selected means all)</legend><label v-for="category in board.categories.filter(item => item.active)" :key="category.id"><input v-model="categoryIds" :value="category.id" type="checkbox" @change="applyFilters" /> {{ category.label }}</label></fieldset>
      <label>Results per page (1–100)<input v-model.number="limit" type="number" min="1" max="100" required /></label>
      <button type="submit">Search</button>
      <button v-if="search" type="button" @click="search = ''; applyFilters()">Clear search; keep explicit filters</button>
      <button type="button" @click="clear">Clear search and filters</button>
    </form>
    <p v-if="loading" role="status">Loading permitted proposals…</p>
    <div v-if="error" role="alert"><p>{{ error }}</p><button type="button" :disabled="loading || !ready" @click="reload">Reload current results</button></div>
    <template v-if="result && !error">
      <p v-if="result.state === 'empty'" role="status">This board has no currently visible proposals.</p>
      <p v-else-if="result.state === 'no-matches'" role="status">No permitted proposals match these filters. Clear the filters to try again.</p>
      <p v-else role="status">{{ result.total }} permitted matching proposals</p>
      <ol class="feedback-ideas"><li v-for="idea in result.items" :key="idea.id"><article :aria-labelledby="`${headingId}-${idea.id}`"><h3 :id="`${headingId}-${idea.id}`"><a :href="pageHref(idea)">{{ idea.title }}</a></h3><p>{{ idea.state }} · {{ idea.categoryLabel || 'Uncategorized' }} · {{ idea.voteCount }} priority votes</p>
        <button type="button" :aria-pressed="idea.voted" :disabled="!authenticated || !ready || loading || busy || (!idea.voted && ['closed','withdrawn'].includes(idea.state))" @click="vote(idea)">{{ idea.voted ? 'Retract my priority vote' : 'I would prioritize this proposal' }}</button>
        <label><input type="checkbox" :checked="idea.subscribed" :disabled="!authenticated || !ready || loading || busy" @change="subscribe(idea, $event)" /> Notify me of status changes</label>
        <feedback-triage :board="result.board" :idea="idea" :ready="ready && !loading" :authority-key="authorityKey" @changed="reload" @dirty="setDirty(idea.id, $event)" @busy="setBusy(idea.id, $event)" />
      </article></li></ol>
      <button v-if="result.nextCursor" type="button" :disabled="loading || !ready" @click="next">Next results</button>
    </template>
    <p v-if="!authenticated"><a href="/login">Sign in to vote or subscribe</a>.</p>
    <p v-else>Voting does not subscribe you. Status subscriptions also require your separate <a href="/p/notifications">per-channel feedback notification consent</a>; no channel is enabled here.</p>
    <feedback-submit v-if="board.canSubmit || !authenticated" :board="result?.board ?? board" :locale="locale" :ready="ready && !loading" :authenticated="authenticated" :authority-key="authorityKey" @submitted="reload" @dirty="setDirty('submit', $event)" @busy="setBusy('submit', $event)" />
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { feedbackQueryString, normalizeFeedbackQuery, parseFeedbackQueryString, type FeedbackBoard, type FeedbackIdea, type FeedbackList, type FeedbackQuery, type FeedbackSort, type FeedbackState } from '../../../shared/page-feedback.ts'
import { governanceApi, governanceOwnerMatches, PageGovernanceError } from '../../helpers/page-governance-api.ts'
import FeedbackSubmit from './feedback-submit.vue'
import FeedbackTriage from './feedback-triage.vue'
import { pageHref } from '../../helpers/admin-pages.ts'
const props = defineProps<{ board: FeedbackBoard; locale: string; ready: boolean; authenticated: boolean; authorityKey: string }>()
const headingId = `feedback-${useId()}`, heading = ref<HTMLElement | null>(null), search = ref(''), sort = ref<FeedbackSort>('top'), statuses = ref<FeedbackState[]>([]), categoryIds = ref<string[]>([]), limit = ref(20), result = ref<FeedbackList | null>(null), loading = ref(false), busy = ref(false), error = ref('')
const emit = defineEmits<{ dirty: [value: boolean]; busy: [value: boolean]; unavailable: [] }>()
const childDirty: Record<string, boolean> = {}, childBusy: Record<string, boolean> = {}
function setDirty(key: string, value: boolean) { childDirty[key] = value; emit('dirty', Object.values(childDirty).some(Boolean)) }
function setBusy(key: string, value: boolean) { childBusy[key] = value; emit('busy', busy.value || Object.values(childBusy).some(Boolean)) }
watch(busy, value => emit('busy', value || Object.values(childBusy).some(Boolean)))
function reportFailure(cause: unknown, current: number, fallback: string) {
  if (disposed || current !== generation || (cause instanceof Error && cause.name === 'AbortError')) return
  error.value = cause instanceof Error ? cause.message : fallback
  if (cause instanceof PageGovernanceError && [401, 403, 404].includes(cause.status)) { result.value = null; emit('unavailable') }
}
const states: FeedbackState[] = ['proposed','planned','in-progress','completed','closed','withdrawn']
const queryKeys = ['q','sort','statuses','categoryIds','cursor','limit']
let query: FeedbackQuery = normalizeFeedbackQuery({}), generation = 0, mutationRequest = 0, controller: AbortController | null = null, disposed = false
function fromUrl() {
  const params = new URLSearchParams(window.location.search), selected = new URLSearchParams()
  for (const key of queryKeys) for (const value of params.getAll(key)) selected.append(key, value)
  query = parseFeedbackQueryString(selected)
  search.value = query.q ?? ''
  sort.value = query.sort
  statuses.value = query.statuses ? [...query.statuses] : []
  categoryIds.value = query.categoryIds ? [...query.categoryIds] : []
  limit.value = query.limit
}
function updateUrl() { const url = new URL(window.location.href); for (const key of queryKeys) url.searchParams.delete(key); for (const [key, value] of new URLSearchParams(feedbackQueryString(query))) url.searchParams.set(key, value); window.history.pushState(null, '', url); }
function applyFilters() {
  try {
    query = normalizeFeedbackQuery({ q: search.value, sort: sort.value, limit: limit.value,
      ...(statuses.value.length ? { statuses: statuses.value } : {}),
      ...(categoryIds.value.length ? { categoryIds: categoryIds.value } : {}) })
    updateUrl()
    void load()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Invalid filters.' }
}
function clear() { search.value = ''; sort.value = 'top'; statuses.value = []; categoryIds.value = []; limit.value = 20; applyFilters() }
function next() { if (!result.value?.nextCursor || loading.value) return; query = { ...query, cursor: result.value.nextCursor }; updateUrl(); void load(true) }
function reload() { query = { ...query, cursor: undefined }; updateUrl(); void load() }
function navigate() { try { fromUrl(); void load() } catch (cause) { controller?.abort(); generation++; result.value = null; error.value = cause instanceof Error ? cause.message : 'Invalid board URL.' } }
async function load(focus = false) {
  const current = ++generation; controller?.abort(); error.value = ''
  if (!props.ready) { result.value = null; loading.value = false; return }
  controller = new AbortController(); loading.value = true
  try { const loaded = await governanceApi.board(props.board.id, query, controller.signal); if (!disposed && current === generation && props.ready) { if (loaded.board.id !== props.board.id) throw new Error('Board identity changed.'); result.value = loaded; if (focus) heading.value?.focus() } }
  catch (cause) { reportFailure(cause, current, 'Board unavailable.') }
  finally { if (!disposed && current === generation) loading.value = false }
}
async function vote(idea: FeedbackIdea) {
  if (busy.value || loading.value || !props.ready || !props.authenticated || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation, mutation = ++mutationRequest; busy.value = true; error.value = ''
  try { await governanceApi.vote({ boardId: props.board.id, ideaId: idea.id, voted: !idea.voted, expectedIdeaRevision: idea.ideaRevision }); if (!disposed && current === generation && props.ready) reload() }
  catch (cause) { reportFailure(cause, current, 'Vote not confirmed. Reload before retrying.') }
  finally { if (!disposed && mutation === mutationRequest) busy.value = false }
}
async function subscribe(idea: FeedbackIdea, event: Event) {
  const input = event.target; if (!(input instanceof HTMLInputElement)) return
  const subscribed = input.checked; input.checked = idea.subscribed
  if (busy.value || loading.value || !props.ready || !props.authenticated || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation, mutation = ++mutationRequest; busy.value = true; error.value = ''
  try { await governanceApi.subscribe({ boardId: props.board.id, ideaId: idea.id, subscribed }); if (!disposed && current === generation && props.ready) reload() }
  catch (cause) { reportFailure(cause, current, 'Subscription not confirmed.') }
  finally { if (!disposed && mutation === mutationRequest) busy.value = false }
}
watch(() => [props.board.id, props.authorityKey, props.ready], () => { result.value = null; mutationRequest++; busy.value = false; navigate() })
onMounted(() => { window.addEventListener('popstate', navigate); navigate() })
onBeforeUnmount(() => { disposed = true; generation++; controller?.abort(); window.removeEventListener('popstate', navigate) })
</script>
<style scoped>
.feedback-board { margin-block: 1.5rem; padding-block: 1rem; border-block: 1px solid rgb(var(--v-theme-outline)); } .feedback-filters { display: flex; flex-wrap: wrap; gap: 1rem; align-items: end; } .feedback-filters > label { flex: 1 1 12rem; } label { display: grid; gap: .4rem; } label:has(input[type=checkbox]) { display: flex; align-items: start; } fieldset { display: flex; flex-wrap: wrap; gap: .75rem; width: 100%; border: 1px solid currentColor; padding: .75rem; } input:not([type=checkbox]), select { border: 1px solid currentColor; padding: .5rem; max-width: 100%; background: rgb(var(--v-theme-surface)); color: inherit; } button { min-height: 44px; border: 1px solid currentColor; padding: .5rem 1rem; } .feedback-ideas { list-style: none; padding: 0; } .feedback-ideas article { padding-block: 1rem; border-block-end: 1px solid rgb(var(--v-theme-outline)); overflow-wrap: anywhere; } .feedback-ideas label { margin-block: .75rem; } :is(a, button, input, select):focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
</style>
