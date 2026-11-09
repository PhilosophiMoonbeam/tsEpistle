<template>
  <details class="feedback-triage" @toggle="opened">
    <summary>Proposal history and actions</summary>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="stale" role="status">The board, idea or canonical source revision changed. Your unsent draft is retained, but no action will silently rebase it.</p>
    <button v-if="stale" type="button" :disabled="busy || !ready || uncertain" @click="reviewCurrent">Review current snapshot and discard stale board draft</button>
    <ol v-if="history.length"><li v-for="event in history" :key="event.id"><time>{{ event.createdAt }}</time> — {{ event.kind }} {{ event.toState }}<p>{{ event.explanation }}</p></li></ol>
    <form v-if="idea.canModerate || idea.canWithdraw || idea.canRestore" @submit.prevent="transition">
      <fieldset :disabled="busy || !ready || uncertain"><legend>Change board status, not canonical source</legend>
        <label>Status <select v-model="target"><option v-for="state in allowedStates" :key="state" :value="state">{{ state }}</option></select></label>
        <label>Explanation <textarea v-model="explanation" required maxlength="2000" rows="3" /></label>
        <p v-if="target === 'withdrawn'">Withdrawal hides this board membership only. The canonical page, its access and history remain unchanged. Board metadata is retained until explicit authorized deletion.</p>
        <p v-if="idea.state === 'withdrawn'">Restore returns the proposal to proposed. Author restore is available only within 30 days and never reverses moderator withdrawal.</p>
        <label v-if="idea.canModerate"><input v-model="withComment" type="checkbox" /> Also post a native discussion comment when applying this transition</label>
        <label v-if="withComment">Unsent discussion draft <textarea v-model="comment" required minlength="2" maxlength="50000" rows="4" /></label>
        <p v-if="withComment">Nothing is posted until you choose Apply status and post comment. Current native discussion permissions must admit the comment or the entire transition fails.</p>
        <button type="submit" :disabled="stale || !explanation.trim() || target === idea.state">{{ withComment ? 'Apply status and post comment' : 'Apply explained status' }}</button>
      </fieldset>
    </form>
    <p v-if="uncertain" role="status">The transition outcome is unconfirmed. Do not submit it again before inspecting its receipt.</p>
    <button v-if="uncertain" type="button" :disabled="busy || !ready" @click="inspectReceipt">Inspect transition receipt</button>
    <form v-if="idea.canModerate" @submit.prevent="categorize"><fieldset :disabled="busy || !ready || uncertain"><legend>Board-only category</legend><label>Category <select v-model="categoryId"><option value="">Uncategorized</option><option v-for="category in board.categories.filter(item => item.active)" :key="category.id" :value="category.id">{{ category.label }}</option></select></label><p v-if="idea.categoryLabel && !board.categories.some(item => item.id === idea.categoryId && item.active)">Removed category: {{ idea.categoryLabel }}</p><button type="submit">Save category; preserve canonical tags</button></fieldset></form>
    <form v-if="idea.canModerate" @submit.prevent="moveMembership"><fieldset :disabled="busy || !ready || uncertain"><legend>Explicit membership move — not a canonical page move</legend><button type="button" @click="loadDestinations">Load currently permitted destination boards</button><label>Destination board<select v-model="destinationBoardId" required><option value="">Choose an enabled board</option><option v-for="destination in destinations.filter(item => item.id !== board.id && item.canManage)" :key="destination.id" :value="destination.id">{{ destination.name }}</option></select></label><label>Membership move explanation<textarea v-model="moveExplanation" required maxlength="2000" rows="2" /></label><p>The same idea ID and retained votes follow; no page access or source changes, no silent vote reset. Both board revisions are checked.</p><button type="submit">Move membership deliberately</button><button type="button" @click="removeMembership">Permanently delete this idea's board-only metadata</button></fieldset></form>
    <a v-if="idea.canEditSource" :href="pageHref(idea, '/e')">Edit in canonical editor</a>
  </details>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { z } from 'zod'
import { governanceApi, governanceRequest, governanceOwnerMatches, PageGovernanceError } from '../../helpers/page-governance-api.ts'
import { requestConfirmation } from '../common/confirm-dialog.ts'
import { pageHref } from '../../helpers/admin-pages.ts'
import type { FeedbackBoard, FeedbackIdea, FeedbackState } from '../../../shared/page-feedback.ts'
const props = defineProps<{ board: FeedbackBoard; idea: FeedbackIdea; ready: boolean; authorityKey: string }>()
const emit = defineEmits<{ changed: []; dirty: [value: boolean]; busy: [value: boolean] }>()
const target = ref<FeedbackState>(props.idea.canRestore ? 'proposed' : props.idea.canModerate ? props.idea.state : 'withdrawn'), explanation = ref(''), withComment = ref(false), comment = ref(''), categoryId = ref(props.idea.categoryId ?? ''), error = ref(''), busy = ref(false), uncertain = ref(false), requestId = ref('')
const history = ref<Array<{ id: string; kind: string; toState: string | null; explanation: string | null; createdAt: string }>>([])
const destinations = ref<FeedbackBoard[]>([]), destinationBoardId = ref(''), moveExplanation = ref('')
const reviewedRevisions = ref([props.board.boardRevision, props.idea.ideaRevision, props.idea.sourceRevision])
const stale = computed(() => reviewedRevisions.value.join(':') !== [props.board.boardRevision, props.idea.ideaRevision, props.idea.sourceRevision].join(':'))
let generation = 0, disposed = false
function recheckAfterAccessFailure(cause: unknown, current: number) {
  if (!disposed && current === generation && cause instanceof PageGovernanceError && [401, 403, 404].includes(cause.status)) {
    history.value = []
    destinations.value = []
    emit('changed')
  }
}
const allowedStates = computed<FeedbackState[]>(() => props.idea.state === 'withdrawn' ? props.idea.canRestore ? ['proposed'] : [] : props.idea.canModerate ? ['proposed', 'planned', 'in-progress', 'completed', 'closed', 'withdrawn'] : ['withdrawn'])
watch(() => [props.idea.id, props.authorityKey], () => { generation++; history.value = []; error.value = ''; busy.value = false; uncertain.value = false; requestId.value = ''; explanation.value = ''; comment.value = ''; withComment.value = false; destinations.value = []; destinationBoardId.value = ''; moveExplanation.value = ''; reviewedRevisions.value = [props.board.boardRevision, props.idea.ideaRevision, props.idea.sourceRevision]; target.value = props.idea.canRestore ? 'proposed' : props.idea.canModerate ? props.idea.state : 'withdrawn'; categoryId.value = props.idea.categoryId ?? '' })
watch([explanation, comment, moveExplanation, withComment, categoryId], () => emit('dirty', Boolean(explanation.value || comment.value || moveExplanation.value || withComment.value || categoryId.value !== (props.idea.categoryId ?? ''))))
watch(busy, value => emit('busy', value))
onBeforeUnmount(() => { disposed = true; generation++; emit('dirty', false); emit('busy', false) })
async function opened(event: Event) {
  if (!(event.target instanceof HTMLDetailsElement) || !event.target.open || !props.ready || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation
  try {
    const result = await governanceRequest(window.fetch.bind(window), `/_api/page-feedback/boards/${encodeURIComponent(props.board.id)}/ideas/${encodeURIComponent(props.idea.id)}`, z.object({ history: z.array(z.strictObject({ id: z.string(), kind: z.string(), fromState: z.string().nullable(), toState: z.string().nullable(), explanation: z.string().nullable(), categoryLabel: z.string().nullable(), createdAt: z.string() })) }))
    if (!disposed && current === generation && props.ready) history.value = result.history
  } catch (cause) { recheckAfterAccessFailure(cause, current); if (!disposed && current === generation) error.value = cause instanceof Error ? cause.message : 'History could not be loaded.' }
}
async function transition() {
  if (busy.value || !props.ready || uncertain.value || stale.value || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true; error.value = ''; requestId.value = crypto.randomUUID()
  try {
    await governanceApi.transition({ boardId: props.board.id, ideaId: props.idea.id, requestId: requestId.value, expectedBoardRevision: props.board.boardRevision, expectedIdeaRevision: props.idea.ideaRevision, expectedSourceRevision: props.idea.sourceRevision, targetState: target.value, explanation: explanation.value, ...(withComment.value ? { comment: { content: comment.value, replyTo: 0 } } : {}) })
    if (!disposed && current === generation && props.ready) { explanation.value = ''; comment.value = ''; withComment.value = false; emit('changed') }
  } catch (cause) { recheckAfterAccessFailure(cause, current); if (!disposed && current === generation) { error.value = cause instanceof Error ? cause.message : 'Transition failed.'; uncertain.value = true } }
  finally { if (!disposed && current === generation) busy.value = false }
}
async function inspectReceipt() {
  if (!props.ready || busy.value || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true
  try { const result = await governanceApi.receipt(props.board.id, props.idea.id, requestId.value); if (!disposed && current === generation && props.ready) { uncertain.value = false; error.value = result ? 'The transition committed. Reloaded current state.' : 'No committed receipt exists. Review the current state before another explicit transition.'; emit('changed') } }
  catch (cause) { recheckAfterAccessFailure(cause, current); if (!disposed && current === generation) error.value = cause instanceof Error ? cause.message : 'Receipt unavailable.' }
  finally { if (!disposed && current === generation) busy.value = false }
}
async function categorize() {
  if (busy.value || !props.ready || uncertain.value || stale.value || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true
  try { await governanceApi.setCategory({ boardId: props.board.id, ideaId: props.idea.id, categoryId: categoryId.value || null, expectedBoardRevision: props.board.boardRevision, expectedIdeaRevision: props.idea.ideaRevision, expectedSourceRevision: props.idea.sourceRevision }); if (!disposed && current === generation && props.ready) emit('changed') }
  catch (cause) { recheckAfterAccessFailure(cause, current); if (!disposed && current === generation) error.value = cause instanceof Error ? cause.message : 'Category failed.' }
  finally { if (!disposed && current === generation) busy.value = false }
}
async function loadDestinations() {
  if (busy.value || !props.ready || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true
  try { const boards = await governanceApi.boards(); if (!disposed && current === generation && props.ready) destinations.value = boards }
  catch (cause) { recheckAfterAccessFailure(cause, current); if (!disposed && current === generation) error.value = cause instanceof Error ? cause.message : 'Destination boards unavailable.' }
  finally { if (!disposed && current === generation) busy.value = false }
}
async function moveMembership() {
  const destination = destinations.value.find(item => item.id === destinationBoardId.value)
  if (busy.value || !props.ready || uncertain.value || stale.value || !destination || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true
  try { await governanceApi.moveIdea({ boardId: props.board.id, ideaId: props.idea.id, destinationBoardId: destination.id, expectedBoardRevision: props.board.boardRevision, expectedDestinationBoardRevision: destination.boardRevision, expectedIdeaRevision: props.idea.ideaRevision, expectedSourceRevision: props.idea.sourceRevision, explanation: moveExplanation.value }); if (!disposed && current === generation && props.ready) emit('changed') }
  catch (cause) { recheckAfterAccessFailure(cause, current); if (!disposed && current === generation) error.value = cause instanceof Error ? cause.message : 'Membership move not confirmed. Reload both boards before retrying.' }
  finally { if (!disposed && current === generation) busy.value = false }
}
async function removeMembership() {
  if (busy.value || !props.ready || uncertain.value || stale.value || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true
  try {
    if (!(await requestConfirmation({ title: 'Permanently delete this idea’s board-only membership, votes and audit metadata? Its canonical source and history remain. This is not withdrawal and cannot be undone.', confirmLabel: 'Delete board metadata only', cancelLabel: 'Retain idea metadata' })) || current !== generation || !props.ready || stale.value || !governanceOwnerMatches(props.authorityKey)) return
    await governanceApi.removeMetadata({ boardId: props.board.id, ideaId: props.idea.id, expectedBoardRevision: props.board.boardRevision, expectedIdeaRevision: props.idea.ideaRevision, expectedSourceRevision: props.idea.sourceRevision, confirmed: true })
    if (!disposed && current === generation && props.ready) emit('changed')
  } catch (cause) { recheckAfterAccessFailure(cause, current); if (!disposed && current === generation) error.value = cause instanceof Error ? cause.message : 'Metadata deletion failed.' }
  finally { if (!disposed && current === generation) busy.value = false }
}
async function reviewCurrent() {
  if (busy.value || !props.ready || uncertain.value || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation
  if (!(await requestConfirmation({ title: 'Discard this stale board draft after reviewing the current canonical page and board state? No source or native discussion is changed.', confirmLabel: 'Use current snapshot; discard board draft', cancelLabel: 'Keep unsent draft' })) || current !== generation || !props.ready || !governanceOwnerMatches(props.authorityKey)) return
  explanation.value = ''
  comment.value = ''
  withComment.value = false
  moveExplanation.value = ''
  target.value = props.idea.canRestore ? 'proposed' : props.idea.canModerate ? props.idea.state : 'withdrawn'
  categoryId.value = props.idea.categoryId ?? ''
  reviewedRevisions.value = [props.board.boardRevision, props.idea.ideaRevision, props.idea.sourceRevision]
}
</script>
<style scoped>
.feedback-triage { margin-block: 1rem; } summary { cursor: pointer; min-height: 44px; } fieldset { display: grid; gap: .75rem; margin-block: 1rem; padding: 1rem; border: 1px solid rgb(var(--v-theme-outline)); } label { display: grid; gap: .3rem; } label:has(input[type=checkbox]) { display: flex; align-items: start; } textarea, select { border: 1px solid currentColor; padding: .5rem; max-width: 100%; color: inherit; background: rgb(var(--v-theme-surface)); } button { min-height: 44px; padding: .5rem 1rem; border: 1px solid currentColor; justify-self: start; } :is(button, summary, a, input, textarea, select):focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
</style>
