<template>
  <details @toggle="focusTitle">
    <summary>Submit a proposal</summary>
    <p v-if="!authenticated"><a href="/login">Sign in to submit</a>. Board membership does not grant page creation or source editing authority.</p>
    <form v-else @submit.prevent="openCreate">
      <fieldset :disabled="!ready || busy"><legend>Use a full canonical page</legend>
        <label>Proposed title for optional duplicate discovery <input ref="titleInput" v-model="title" type="search" maxlength="200" @input="suggest" /></label>
        <p v-if="suggesting" role="status">Looking for similar permitted proposals…</p>
        <ul v-if="suggestions.length" aria-label="Possible duplicates"><li v-for="idea in suggestions" :key="idea.id"><a :href="pageHref(idea)">{{ idea.title }}</a> — {{ idea.state }}</li></ul>
        <p>Suggestions are optional. Nothing is merged, voted on or subscribed automatically.</p>
        <label><input v-model="acknowledged" type="checkbox" required /> Explicitly attach the page I create to {{ board.name }}. Native access, publication and approval rules remain authoritative.</label>
        <button type="submit" :disabled="!acknowledged">Choose location and open full editor</button>
      </fieldset>
    </form>
    <details v-if="authenticated"><summary>Submit an existing page I can currently edit</summary><form @submit.prevent="attach"><fieldset :disabled="!ready || busy"><legend>Exact canonical page snapshot</legend><label>Canonical page ID <input v-model.number="existingId" type="number" min="1" required /></label><label>Current source revision <input v-model="sourceRevision" inputmode="numeric" pattern="[1-9][0-9]*" required /></label><label><input v-model="existingAcknowledged" type="checkbox" required /> I deliberately attach this existing canonical page; membership does not change its permissions.</label><button type="submit" :disabled="!existingAcknowledged">Attach existing page</button></fieldset></form></details>
    <p v-if="error" role="alert">{{ error }}</p>
    <page-selector v-model="createOpen" mode="create" :path="seedPath" :locale="locale" :open-handler="create" />
  </details>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import PageSelector from '../common/page-selector.vue'
import { governanceApi, governanceOwnerMatches } from '../../helpers/page-governance-api.ts'
import { pageHref } from '../../helpers/admin-pages.ts'
import type { FeedbackBoard, FeedbackIdea } from '../../../shared/page-feedback.ts'
const props = defineProps<{ board: FeedbackBoard; locale: string; ready: boolean; authenticated: boolean; authorityKey: string }>()
const emit = defineEmits<{ submitted: []; dirty: [value: boolean]; busy: [value: boolean] }>()
const title = ref(''), titleInput = ref<HTMLInputElement | null>(null), acknowledged = ref(false), existingAcknowledged = ref(false), existingId = ref<number | null>(null), sourceRevision = ref(''), suggestions = ref<FeedbackIdea[]>([]), suggesting = ref(false), createOpen = ref(false), busy = ref(false), error = ref('')
const seedPath = computed(() => title.value.trim().toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '') || 'proposal')
let generation = 0, suggestionGeneration = 0, controller: AbortController | null = null, disposed = false
let createReturnFocus: HTMLElement | null = null
watch(createOpen, (open, previous) => {
  if (open) { createReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; return }
  if (!previous) return
  const owner = props.authorityKey, target = createReturnFocus
  void nextTick(() => {
    if (!disposed && props.authorityKey === owner && governanceOwnerMatches(owner)) {
      if (target?.isConnected && !target.matches(':disabled')) target.focus()
      else titleInput.value?.focus()
    }
  })
})
watch(() => [props.board.id, props.authorityKey], () => { generation++; suggestionGeneration++; controller?.abort(); title.value = ''; acknowledged.value = false; existingAcknowledged.value = false; existingId.value = null; sourceRevision.value = ''; suggestions.value = []; createOpen.value = false; busy.value = false; error.value = ''; suggesting.value = false })
watch(() => props.ready, ready => { if (!ready) { generation++; suggestionGeneration++; controller?.abort(); createOpen.value = false; busy.value = false; suggesting.value = false } })
watch([title, existingId, sourceRevision, acknowledged, existingAcknowledged], () => emit('dirty', Boolean(title.value || existingId.value || sourceRevision.value || acknowledged.value || existingAcknowledged.value)))
watch(busy, value => emit('busy', value))
onBeforeUnmount(() => { disposed = true; generation++; controller?.abort(); emit('dirty', false); emit('busy', false) })
function focusTitle(event: Event) { if (event.target instanceof HTMLDetailsElement && event.target.open) titleInput.value?.focus() }
async function suggest() {
  const request = ++suggestionGeneration, current = generation; controller?.abort(); suggestions.value = []
  if (!props.ready || !title.value.trim()) { suggesting.value = false; return }
  controller = new AbortController(); suggesting.value = true
  try { const result = await governanceApi.duplicates(props.board.id, title.value, controller.signal); if (!disposed && current === generation && request === suggestionGeneration && props.ready) suggestions.value = result }
  catch (cause) { if (!disposed && current === generation && request === suggestionGeneration && !(cause instanceof Error && cause.name === 'AbortError')) error.value = cause instanceof Error ? cause.message : 'Suggestions unavailable. You may still submit.' }
  finally { if (!disposed && current === generation && request === suggestionGeneration) suggesting.value = false }
}
function openCreate() { if (props.ready && props.authenticated && acknowledged.value && governanceOwnerMatches(props.authorityKey)) createOpen.value = true }
function create(selection: { path: string; locale: string }): boolean {
  if (!props.ready || !props.authenticated || !acknowledged.value || !governanceOwnerMatches(props.authorityKey)) return false
  const query = new URLSearchParams({ feedbackBoard: props.board.id, feedbackBoardRevision: props.board.boardRevision })
  window.location.assign(`/e/${encodeURIComponent(selection.locale)}/${selection.path.split('/').map(encodeURIComponent).join('/')}?${query}`)
  return true
}
async function attach() {
  if (!props.ready || !props.authenticated || busy.value || !existingAcknowledged.value || !existingId.value || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true; error.value = ''
  try { await governanceApi.attach({ boardId: props.board.id, pageId: existingId.value, expectedBoardRevision: props.board.boardRevision, expectedSourceRevision: sourceRevision.value, acknowledged: true }); if (!disposed && current === generation && props.ready) { existingAcknowledged.value = false; emit('submitted') } }
  catch (cause) { if (!disposed && current === generation) error.value = cause instanceof Error ? cause.message : 'Submission failed. Reload current state before retrying.' }
  finally { if (!disposed && current === generation) busy.value = false }
}
</script>
<style scoped>
summary { cursor: pointer; min-height: 44px; padding-block: .6rem; } fieldset { display: grid; gap: .75rem; padding: 1rem; border: 1px solid rgb(var(--v-theme-outline)); } label { display: grid; gap: .4rem; } label:has(input[type=checkbox]) { display: flex; align-items: start; } input:not([type=checkbox]) { padding: .5rem; border: 1px solid currentColor; } button { justify-self: start; border: 1px solid currentColor; padding: .5rem 1rem; min-height: 44px; } :is(summary, input, button, a):focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
</style>
