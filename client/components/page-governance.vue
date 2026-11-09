<template>
  <div class="page-governance">
    <p v-if="admitted && directoryLoading" role="status">Checking optional page feedback…</p>
    <div v-if="admitted && error" role="alert"><p>Optional page feedback is unavailable: {{ error }}</p><button type="button" :disabled="directoryLoading" @click="loadBoards">Retry current feedback access</button></div>
    <feedback-board v-if="board?.enabled && admitted" :key="`${board.id}:${authorityKey}`" :board="board" :locale="locale" :ready="admitted" :authenticated="authenticated" :authority-key="authorityKey" @dirty="setDirty('feedback', $event)" @busy="setBusy('feedback', $event)" @unavailable="board = null; error = 'Current feedback access is unavailable. Reload current authority before continuing.'" />
    <details v-if="writer && authenticated" @toggle="openChanged"><summary>Page review routing and lifecycle governance</summary><p v-if="!admitted" role="status">Current online account and canonical page authority are required. Reconnect and reload before making changes.</p><template v-if="opened && admitted"><p v-if="error" role="alert">{{ error }}</p><button v-if="error" type="button" @click="loadBoards">Reload board configuration</button><page-review-routing :page-id="pageId" :source-revision="sourceRevision" :ready="admitted" :authority-key="authorityKey" :attestation-href="attestationHref" @dirty="setDirty('review', $event)" @busy="setBusy('review', $event)" /><page-lifecycle :page-id="pageId" :page-locale="locale" :page-path="path" :ready="admitted" :authority-key="authorityKey" @dirty="setDirty('lifecycle', $event)" @busy="setBusy('lifecycle', $event)" /><feedback-board-settings v-if="manage" :page-id="pageId" :initial-board="board" :ready="admitted" :authority-key="authorityKey" @changed="board = $event" @dirty="setDirty('board', $event)" @busy="setBusy('board', $event)" /></template></details>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { wikiStore } from '../store/index.ts'
import { governanceApi } from '../helpers/page-governance-api.ts'
import type { FeedbackBoard as FeedbackBoardView } from '../../shared/page-feedback.ts'
import FeedbackBoard from './feedback/feedback-board.vue'
import FeedbackBoardSettings from './feedback/feedback-board-settings.vue'
import PageReviewRouting from './page-review-routing.vue'
import PageLifecycle from './page-lifecycle.vue'
const props = defineProps<{ pageId: number; sourceRevision: string; locale: string; path: string; ready: boolean; writer: boolean; manage: boolean; attestationHref: string }>()
const emit = defineEmits<{ dirty: [value: boolean]; busy: [value: boolean] }>()
const board = ref<FeedbackBoardView | null>(null), error = ref(''), opened = ref(false), dirty = reactive<Record<string, boolean>>({}), pending = reactive<Record<string, boolean>>({})
const directoryLoading = ref(false)
const authenticated = computed(() => wikiStore.authRefreshSettled && !wikiStore.authRefreshPending && wikiStore.authRefreshOutcome === 'authenticated' && wikiStore.user.authenticated && wikiStore.user.id > 0)
const admitted = computed(() => props.ready && wikiStore.authRefreshSettled && !wikiStore.authRefreshPending && (authenticated.value || wikiStore.authRefreshOutcome === 'anonymous'))
const authorityKey = computed(() => JSON.stringify([wikiStore.user.id,wikiStore.user.authVersion,wikiStore.offlineIdentityEpoch,wikiStore.authRefreshOutcome,wikiStore.authRefreshPending,wikiStore.user.permissions,props.pageId,props.sourceRevision,props.locale,props.path,admitted.value]))
let generation = 0, controller: AbortController | null = null, disposed = false
function setDirty(key: string, value: boolean) { dirty[key] = value; emit('dirty', Object.values(dirty).some(Boolean)) }
function setBusy(key: string, value: boolean) { pending[key] = value; emit('busy', Object.values(pending).some(Boolean)) }
function openChanged(event: Event) { if (event.target instanceof HTMLDetailsElement && event.target.open) opened.value = true }
async function loadBoards() {
  const current = ++generation; controller?.abort(); board.value = null; error.value = ''
  if (!admitted.value) { directoryLoading.value = false; return }
  directoryLoading.value = true
  controller = new AbortController()
  try { const boards = await governanceApi.boards(controller.signal); if (!disposed && current === generation && admitted.value) board.value = boards.find(item => item.boardPageId === props.pageId) ?? null }
  catch (cause) { if (!disposed && current === generation && !(cause instanceof Error && cause.name === 'AbortError')) error.value = cause instanceof Error ? cause.message : 'Board configuration unavailable.' }
  finally { if (!disposed && current === generation) directoryLoading.value = false }
}
function protectUnload(event: BeforeUnloadEvent) { if (Object.values(dirty).some(Boolean) || Object.values(pending).some(Boolean)) { event.preventDefault(); event.returnValue = '' } }
watch(authorityKey, () => { for (const key of Object.keys(dirty)) delete dirty[key]; for (const key of Object.keys(pending)) delete pending[key]; emit('dirty', false); emit('busy', false); void loadBoards() }, { immediate: true })
window.addEventListener('beforeunload', protectUnload)
onBeforeUnmount(() => { disposed = true; generation++; controller?.abort(); window.removeEventListener('beforeunload', protectUnload); emit('dirty', false); emit('busy', false) })
</script>
<style scoped>
.page-governance { margin-block: 1rem; } summary { cursor: pointer; min-height: 44px; padding-block: .6rem; font-weight: 600; } summary:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
</style>
