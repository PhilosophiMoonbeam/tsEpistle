<template>
  <section :aria-labelledby="headingId" :aria-busy="busy">
    <h3 :id="headingId">Optional feedback board configuration</h3><p>Off until explicitly configured. This anchor remains an ordinary canonical page. Descendants, existing pages and votes are never automatically enrolled.</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <form @submit.prevent="save"><fieldset :disabled="busy || !ready"><legend>{{ board ? `Board revision ${board.boardRevision}` : 'Create explicit board' }}</legend><label>Name<input v-model="name" maxlength="200" required /></label><label><input v-model="enabled" type="checkbox" /> Deliberately enable board discovery and submissions</label><button type="submit">{{ board ? 'Save board configuration' : 'Create optional board' }}</button></fieldset></form>
    <details><summary>Load an existing disabled board by its exact ID</summary><form @submit.prevent="loadById"><label>Board UUID<input v-model="lookupId" required /></label><button type="submit" :disabled="busy || !ready">Inspect board on this anchor</button></form></details>
    <template v-if="board"><p>Board ID {{ board.id }}. Metadata is retained until explicit authorized deletion; there is no automatic timed purge.</p><form @submit.prevent="saveCategory"><fieldset :disabled="busy || !ready"><legend>Board-only taxonomy — never canonical page tags</legend><label>Category<select v-model="categoryId" @change="selectCategory"><option value="">New category</option><option v-for="category in board.categories" :key="category.id" :value="category.id">{{ category.label }}{{ category.active ? '' : ' (retired)' }}</option></select></label><label>Label<input v-model="categoryLabel" maxlength="200" required /></label><label>Display order<input v-model.number="displayOrder" type="number" min="0" max="100000" required /></label><label><input v-model="categoryActive" type="checkbox" /> Active category</label><p>Retired categories remain intelligible in authorized history; canonical tags are unchanged.</p><button type="submit">Save category</button></fieldset></form><button type="button" :disabled="busy || !ready" @click="remove">Explicitly delete board metadata only</button></template>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue'
import { governanceApi, governanceOwnerMatches, PageGovernanceError } from '../../helpers/page-governance-api.ts'
import { requestConfirmation } from '../common/confirm-dialog.ts'
import type { FeedbackBoard } from '../../../shared/page-feedback.ts'
const props = defineProps<{ pageId: number; initialBoard: FeedbackBoard | null; ready: boolean; authorityKey: string }>()
const emit = defineEmits<{ changed: [board: FeedbackBoard | null]; dirty: [value: boolean]; busy: [value: boolean] }>()
const headingId = `board-settings-${useId()}`, board = ref<FeedbackBoard | null>(props.initialBoard), name = ref(props.initialBoard?.name ?? ''), enabled = ref(props.initialBoard?.enabled ?? false), lookupId = ref(''), categoryId = ref(''), categoryLabel = ref(''), categoryActive = ref(true), displayOrder = ref(0), busy = ref(false), error = ref(''), message = ref('')
let generation = 0, disposed = false
watch(busy, value => emit('busy', value))
watch([name, enabled, categoryLabel, categoryActive, displayOrder], () => emit('dirty', true))
function adopt(value: FeedbackBoard | null) { board.value = value; name.value = value?.name ?? ''; enabled.value = value?.enabled ?? false; categoryId.value = ''; categoryLabel.value = ''; categoryActive.value = true; displayOrder.value = 0; queueMicrotask(() => emit('dirty', false)) }
watch(() => [props.pageId, props.authorityKey, props.ready], () => { generation++; busy.value = false; error.value = ''; message.value = ''; adopt(props.initialBoard) })
watch(() => props.initialBoard, value => { if (!busy.value && board.value?.id !== value?.id) adopt(value) })
onBeforeUnmount(() => { disposed = true; generation++; emit('dirty', false); emit('busy', false) })
async function perform(action: (current: number) => Promise<void>) {
  if (busy.value || !props.ready || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true; error.value = ''
  try { await action(current) }
  catch (cause) {
    if (!disposed && current === generation) {
      error.value = cause instanceof Error ? cause.message : 'Board change failed. Reload current state before retry.'
      if (cause instanceof PageGovernanceError && [401, 403, 404].includes(cause.status)) { adopt(null); lookupId.value = ''; emit('changed', null) }
    }
  } finally { if (!disposed && current === generation) busy.value = false }
}
async function save() { await perform(async current => { const value = await governanceApi.configureBoard({ boardPageId: props.pageId, name: name.value, enabled: enabled.value, ...(board.value ? { boardId: board.value.id, expectedBoardRevision: board.value.boardRevision } : {}) }); if (!disposed && current === generation && props.ready) { adopt(value); emit('changed', value); message.value = 'Explicit board configuration saved. No canonical pages were converted.' } }) }
async function loadById() { await perform(async current => { const value = await governanceApi.boardConfig(lookupId.value); if (!disposed && current === generation && props.ready) { if (value.boardPageId !== props.pageId || !value.canManage) throw new Error('This board is not manageable on this canonical anchor.'); adopt(value); emit('changed', value) } }) }
function selectCategory() { const value = board.value?.categories.find(category => category.id === categoryId.value); categoryLabel.value = value?.label ?? ''; categoryActive.value = value?.active ?? true; displayOrder.value = value?.displayOrder ?? 0 }
async function saveCategory() { if (!board.value) return; const value = board.value; await perform(async current => { await governanceApi.category({ boardId: value.id, expectedBoardRevision: value.boardRevision, ...(categoryId.value ? { categoryId: categoryId.value } : {}), label: categoryLabel.value, active: categoryActive.value, displayOrder: displayOrder.value }); if (disposed || current !== generation || !props.ready) return; const loaded = await governanceApi.boardConfig(value.id); if (!disposed && current === generation && props.ready) { adopt(loaded); emit('changed', loaded); message.value = 'Board category saved; canonical page tags preserved.' } }) }
async function remove() {
  if (!board.value) return
  const value = board.value
  await perform(async current => {
    if (!(await requestConfirmation({ title: 'Permanently delete board-only memberships, votes and audit metadata? Canonical source and history are not deleted. This cannot be undone.', confirmLabel: 'Delete board metadata only', cancelLabel: 'Retain metadata' })) || current !== generation || !props.ready || !governanceOwnerMatches(props.authorityKey)) return
    await governanceApi.removeMetadata({ boardId: value.id, expectedBoardRevision: value.boardRevision, confirmed: true })
    if (!disposed && current === generation && props.ready) { adopt(null); emit('changed', null); message.value = 'Board-only metadata deleted by explicit authorized request. Canonical pages remain.' }
  })
}
</script>
<style scoped>
fieldset { display: grid; gap: .75rem; padding: 1rem; margin-block: 1rem; border: 1px solid rgb(var(--v-theme-outline)); } label { display: grid; gap: .4rem; } label:has(input[type=checkbox]) { display: flex; align-items: start; } input:not([type=checkbox]),select { border: 1px solid currentColor; padding: .5rem; max-width: 100%; color: inherit; background: rgb(var(--v-theme-surface)); } button { min-height: 44px; padding: .5rem 1rem; border: 1px solid currentColor; justify-self: start; } summary { min-height: 44px; cursor: pointer; padding-block: .5rem; } :is(button,a,input,select,summary):focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
</style>
