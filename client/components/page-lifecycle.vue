<template>
  <section class="page-lifecycle" :aria-labelledby="headingId" :aria-busy="busy">
    <h3 :id="headingId" tabindex="-1">Bounded page lifecycle rules</h3>
    <p>Default off. Limited unattended effects use the original human's current authority. No automatic publication, accuracy attestation, ownership change or administrator fallback.</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <button type="button" :disabled="busy || !ready" @click="loadRules()">Reload current rules</button>
    <ul aria-label="Available lifecycle rules"><li v-for="rule in rules" :key="rule.id"><button type="button" :disabled="busy || !ready" @click="inspect(rule.id)">{{ rule.id }} — {{ rule.status }}</button></li></ul>
    <button v-if="nextRulesCursor" type="button" :disabled="busy || !ready" @click="loadRules(nextRulesCursor)">More rules</button>
    <button type="button" :disabled="busy || !ready" @click="newRule()">New explicitly configured rule</button>
    <form @submit.prevent="previewRule">
      <fieldset :disabled="busy || !ready"><legend>{{ selected ? `Edit rule revision ${selected.rule.revision}` : 'New rule — no existing pages enrolled' }}</legend>
        <label>Selector <select v-model="selectorKind"><option value="ids">Explicit canonical page IDs (1–100)</option><option value="subtree">One locale and exact subtree</option><option value="tags">One locale and all selected tags</option></select></label>
        <label v-if="selectorKind === 'ids'">Canonical page IDs, comma separated<input v-model="pageIds" inputmode="numeric" required /></label>
        <template v-else><label>Locale<input v-model="locale" required maxlength="32" /></label><label v-if="selectorKind === 'subtree'">Canonical public subtree root<input v-model="rootPath" required maxlength="1024" /></label><label>{{ selectorKind === 'subtree' ? 'Optional required' : 'Required' }} existing tag IDs (all, max 10)<input v-model="selectorTags" inputmode="numeric" :required="selectorKind === 'tags'" /></label><p>Subtree matches exact segments, not similarly named prefixes. Dynamic selectors never include private namespaces.</p></template>
        <label>Condition <select v-model="conditionKind"><option value="body-inactive">Canonical body inactive</option><option value="comments-inactive">Native discussion creation inactive</option><option value="interval">Explicit anchored interval</option></select></label>
        <label>Elapsed UTC days (1–3650)<input v-model.number="days" type="number" min="1" max="3650" required /></label><label v-if="conditionKind === 'interval'">Exact normalized ISO UTC anchor<input v-model="anchor" placeholder="2026-11-08T12:00:00.000Z" required /></label>
        <label v-else><input v-model="startObserving" type="checkbox" /> Start observing currently unknown clocks from now for exactly the previewed permitted pages. Historical age remains unknown; known activity is never overwritten.</label>
        <fieldset><legend>Finite effects — executed in this order, maximum four</legend>
          <label><input v-model="addTags" type="checkbox" /> Add existing tags, preserving all unrelated tags</label><label v-if="addTags">Existing tag IDs, comma separated (1–10)<input v-model="effectTags" inputmode="numeric" required /></label>
          <label><input v-model="setNotice" type="checkbox" /> Set an escaped rule-owned reader notice</label><label v-if="setNotice">Literal notice text (1–1000 characters)<textarea v-model="notice" maxlength="1000" rows="3" required /></label>
          <label><input v-model="proposeMove" type="checkbox" /> Propose a move for a current human's native review — never auto-move</label><template v-if="proposeMove"><label>Literal destination root, same original locale<input v-model="destination" maxlength="1024" required /></label><label>Stable destination template<select v-model="moveTemplate"><option value="original-relative-path">Immutable original relative path</option><option value="page-id">Canonical page ID</option></select></label><p>Immutable origin is captured once. Archive paths are never nested from the page's later current path. Private move proposals are unsupported; use the manual native flow.</p></template>
          <label><input v-model="notify" type="checkbox" /> Queue a truthful outcome notification</label><label v-if="notify">Consented audience<select v-model="audience"><option value="watchers">Existing native watchers</option><option value="review-route">Explicitly enabled current review route</option></select></label>
        </fieldset>
        <label>Terminal policy<select v-model="terminalPolicy"><option value="keep">Keep; rearm only on real new activity / anchored cycle</option><option value="retire-after-success">Retire only after every effect succeeds and every move is actually fulfilled</option></select></label>
        <label><input v-model="enabled" type="checkbox" /> Deliberately enable this rule after save</label>
        <label v-if="selected"><input v-model="reown" type="checkbox" /> Deliberately re-own this rule as my current human account, with a fresh preview</label>
        <label v-if="selected"><input v-model="runAgain" type="checkbox" /> Explicit Run again: a new execution may duplicate completed effects and notifications. Moves still require a fresh human native review.</label>
        <button type="submit">Preview exact eligible targets and effects</button>
      </fieldset>
    </form>
    <section v-if="preview" class="lifecycle-preview" aria-label="Exact lifecycle preview">
      <h4>Preview — expires {{ preview.expiresAt }}</h4>
      <p v-if="preview.warning" role="status">{{ preview.warning }}</p>
      <p>Limit: 1000 currently eligible targets; broader selection is refused, not truncated. Unknown or future clocks do not fire early.</p>
      <p v-if="preview.pages.length === 0">No currently eligible pages. Nothing runs and the rule does not self-retire.</p>
      <ol><li v-for="page in preview.pages" :key="page.pageId">
        <strong>{{ page.localeCode }} / {{ page.path }}</strong> — source {{ page.sourceRevision }}
        <p v-if="page.clock === 'observed-baseline'">No {{ conditionKind === 'comments-inactive' ? 'native comment creation' : 'body change' }} observed since {{ page.anchorAt }}; historical age unknown.</p>
        <p v-else-if="page.historicalAgeUnknown">Historical activity age unknown; no unattended effect until a real event or explicit prospective observation.</p>
        <p>Clock: {{ page.clock }} · {{ page.anchorAt || 'No known anchor' }} · {{ page.due.state }} {{ page.due.state === 'due' ? page.due.dueAt : '' }}</p>
        <p v-if="page.protected">Protected: needs a current interactive unlocked human; no unattended effects.</p>
        <ul><li v-for="effect in page.effects" :key="effect.kind">{{ effect.kind }} — {{ effect.mode }} {{ effect.destinationPath || '' }} {{ effect.reason || '' }}</li></ul>
      </li></ol>
      <label><input v-model="unattendedConsent" type="checkbox" /> I explicitly consent to these listed limited effects under my continuing current authority. A move remains a human proposal, not an applied move.</label>
      <button type="button" :disabled="busy || !ready || !unattendedConsent" @click="save">Save exactly this preview</button>
    </section>
    <section v-if="selected" aria-label="Rule progress and action receipts"><h4>Actual rule state: {{ selected.rule.status }}</h4><p>{{ selected.rule.reason }}</p><p>Disabling/cancelling hides rule-owned notices and cancels unsent work; committed tags, moves and deliveries are not undone.</p><button type="button" :disabled="busy || !ready" @click="status('disable')">Disable future work</button><button type="button" :disabled="busy || !ready" @click="status('cancel')">Explicitly cancel pending work</button><button type="button" :disabled="busy || !ready" @click="inspect(selected.rule.id)">Refresh current receipts</button>
      <article v-for="cycle in selected.cycles" :key="cycle.id"><h5>Page {{ cycle.pageId }} — {{ cycle.status }}</h5><p>{{ cycle.reason }}</p><ol><li v-for="receipt in cycle.receipts" :key="receipt.effectIndex">{{ receipt.kind }} — {{ receipt.state }} {{ receipt.reason }}<button v-if="receipt.proposalId" type="button" :disabled="busy || !ready" @click="openProposal(receipt.proposalId)">Inspect human move proposal</button></li></ol><button v-if="['failed','partial','suspended'].includes(cycle.status)" type="button" :disabled="busy || !ready" @click="resume(cycle.id)">Explicitly resume uncommitted effects only</button></article>
      <button v-if="selected.nextCursor" type="button" :disabled="busy || !ready" @click="inspect(selected.rule.id, selected.nextCursor)">More cycle receipts</button>
    </section>
    <section v-if="proposal" class="lifecycle-preview" aria-label="Human move proposal"><h4>Move is {{ proposal.status }}, not automatically applied</h4><p>{{ proposal.sourceLocale }} / {{ proposal.sourcePath }} → {{ proposal.destinationLocale }} / {{ proposal.destinationPath }}</p><p>Proposed source revision {{ proposal.sourceRevision }}, current {{ proposal.currentSourceRevision }}. Expires {{ proposal.expiresAt }}. Source and destination authority are checked again in your interactive native move.</p><p v-if="proposal.requiresNewPreview" role="status">This proposal needs a fresh lifecycle preview. It cannot be fulfilled from this stale snapshot.</p><button type="button" :disabled="busy || !ready || proposal.requiresNewPreview" @click="moveOpen = true">Open native move and fresh optional incoming-link review</button><button type="button" :disabled="busy || !ready || proposal.status !== 'awaiting-human'" @click="refuse">Explicitly refuse this proposal</button>
      <page-selector v-model="moveOpen" mode="move" :path="proposal.destinationPath" :locale="proposal.destinationLocale" :source-page-id="proposal.pageId" :source-source-revision="proposal.currentSourceRevision" source-visibility="public" :open-handler="fulfill" @move-acknowledged="moved" />
    </section>
  </section>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { governanceApi, governanceOwnerMatches, captureGovernanceFetch, PageGovernanceError, type LifecycleInspection, type LifecycleProposal } from '../helpers/page-governance-api.ts'
import { movePage, type MovePageReceipt } from '../helpers/pages-api.ts'
import { PageLifecycleRuleDefinitionSchema, type PageLifecyclePreview, type PageLifecyclePreviewRequest, type PageLifecycleRuleDefinition } from '../../shared/page-lifecycle.ts'
import PageSelector from './common/page-selector.vue'
import { requestConfirmation } from './common/confirm-dialog.ts'
const props = defineProps<{ pageId: number; pageLocale: string; pagePath: string; ready: boolean; authorityKey: string }>()
const emit = defineEmits<{ dirty: [value: boolean]; busy: [value: boolean] }>()
const headingId = `lifecycle-${useId()}`, selectorKind = ref<'ids'|'subtree'|'tags'>('ids'), pageIds = ref(String(props.pageId)), locale = ref(props.pageLocale), rootPath = ref(props.pagePath), selectorTags = ref(''), conditionKind = ref<'body-inactive'|'comments-inactive'|'interval'>('body-inactive'), days = ref(90), anchor = ref(''), startObserving = ref(false), addTags = ref(false), effectTags = ref(''), setNotice = ref(false), notice = ref(''), proposeMove = ref(false), destination = ref(''), moveTemplate = ref<'original-relative-path'|'page-id'>('original-relative-path'), notify = ref(false), audience = ref<'watchers'|'review-route'>('watchers'), terminalPolicy = ref<'keep'|'retire-after-success'>('keep'), enabled = ref(false), runAgain = ref(false), reown = ref(false), unattendedConsent = ref(false), rules = ref<Array<LifecycleInspection['rule']>>([]), nextRulesCursor = ref<string | null>(null), selected = ref<LifecycleInspection | null>(null), proposal = ref<LifecycleProposal | null>(null), preview = ref<PageLifecyclePreview | null>(null), busy = ref(false), error = ref(''), message = ref(''), moveOpen = ref(false)
let generation = 0, disposed = false, previewRequest: PageLifecyclePreviewRequest | null = null, adopting = false, dirtyDraft = false
let moveReturnFocus: HTMLElement | null = null
watch(moveOpen, (open, previous) => {
  if (open) { moveReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; return }
  if (!previous) return
  const owner = props.authorityKey, target = moveReturnFocus
  void nextTick(() => {
    if (disposed || props.authorityKey !== owner || !governanceOwnerMatches(owner)) return
    if (target?.isConnected && !target.matches(':disabled')) target.focus()
    else document.getElementById(headingId)?.focus()
  })
})
const fields = [selectorKind,pageIds,locale,rootPath,selectorTags,conditionKind,days,anchor,startObserving,addTags,effectTags,setNotice,notice,proposeMove,destination,moveTemplate,notify,audience,terminalPolicy,enabled,runAgain,reown]
watch(fields, () => { if (adopting) return; preview.value = null; previewRequest = null; unattendedConsent.value = false; dirtyDraft = true; emit('dirty', true) })
watch(busy, value => emit('busy', value))
function ids(value: string) { return value.split(',').map(entry => Number(entry.trim())) }
function definition(): PageLifecycleRuleDefinition {
  return PageLifecycleRuleDefinitionSchema.parse({ version: 1, selector: selectorKind.value === 'ids' ? { kind: 'ids', pageIds: ids(pageIds.value) } : selectorKind.value === 'subtree' ? { kind: 'subtree', localeCode: locale.value, normalizedRootPath: rootPath.value, ...(selectorTags.value.trim() ? { allTagIds: ids(selectorTags.value) } : {}) } : { kind: 'tags', localeCode: locale.value, allTagIds: ids(selectorTags.value) }, condition: conditionKind.value === 'interval' ? { kind: 'interval', anchorAt: anchor.value, days: days.value } : { kind: conditionKind.value, days: days.value }, effects: [...(addTags.value ? [{ kind: 'add-tags', tagIds: ids(effectTags.value) }] : []), ...(setNotice.value ? [{ kind: 'set-notice', text: notice.value }] : []), ...(proposeMove.value ? [{ kind: 'propose-move', destinationRootPath: destination.value, destinationLocale: 'same', template: moveTemplate.value }] : []), ...(notify.value ? [{ kind: 'notify', audience: audience.value }] : [])], terminalPolicy: terminalPolicy.value })
}
function adopt(value: PageLifecycleRuleDefinition) {
  adopting = true
  selectorKind.value = value.selector.kind
  pageIds.value = value.selector.kind === 'ids' ? value.selector.pageIds.join(', ') : String(props.pageId)
  locale.value = value.selector.kind === 'ids' ? props.pageLocale : value.selector.localeCode
  rootPath.value = value.selector.kind === 'subtree' ? value.selector.normalizedRootPath : props.pagePath
  selectorTags.value = value.selector.kind === 'ids' ? '' : value.selector.allTagIds?.join(', ') ?? ''
  conditionKind.value = value.condition.kind
  days.value = value.condition.days
  anchor.value = value.condition.kind === 'interval' ? value.condition.anchorAt : ''
  startObserving.value = false
  addTags.value = false
  effectTags.value = ''
  setNotice.value = false
  notice.value = ''
  proposeMove.value = false
  destination.value = ''
  notify.value = false
  for (const effect of value.effects) {
    if (effect.kind === 'add-tags') { addTags.value = true; effectTags.value = effect.tagIds.join(', ') }
    else if (effect.kind === 'set-notice') { setNotice.value = true; notice.value = effect.text }
    else if (effect.kind === 'propose-move') { proposeMove.value = true; destination.value = effect.destinationRootPath; moveTemplate.value = effect.template }
    else { notify.value = true; audience.value = effect.audience }
  }
  terminalPolicy.value = value.terminalPolicy
  enabled.value = selected.value?.rule.status === 'enabled'
  runAgain.value = false
  reown.value = false
  preview.value = null
  previewRequest = null
  unattendedConsent.value = false
  dirtyDraft = false
  emit('dirty', false)
  queueMicrotask(() => { adopting = false })
}
async function perform(action: () => Promise<void>) {
  if (!props.ready || busy.value || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true; error.value = ''
  try { await action() }
  catch (cause) {
    if (!disposed && current === generation) {
      error.value = cause instanceof Error ? cause.message : 'Lifecycle request failed. Inspect current receipts before retrying.'
      if (cause instanceof PageGovernanceError && [401, 403, 404].includes(cause.status)) {
        rules.value = []; selected.value = null; proposal.value = null; preview.value = null; previewRequest = null; moveOpen.value = false; dirtyDraft = false
        emit('dirty', false)
      }
    }
  } finally { if (!disposed && current === generation) busy.value = false }
}
async function loadRules(cursor?: string) { const current = generation; await perform(async () => { const result = await governanceApi.rules(cursor); if (!disposed && current === generation && props.ready) { rules.value = cursor ? [...rules.value, ...result.rules] : result.rules; nextRulesCursor.value = result.nextCursor } }) }
async function inspect(ruleId: string, cursor?: string) {
  const current = generation
  await perform(async () => {
    if (!cursor && dirtyDraft && !(await requestConfirmation({ title: 'Discard the unsaved lifecycle draft and inspect the saved rule?', confirmLabel: 'Inspect saved rule', cancelLabel: 'Keep unsaved draft' }))) return
    if (current !== generation || !props.ready) return
    const result = await governanceApi.inspectLifecycle(ruleId, cursor)
    if (!disposed && current === generation && props.ready) {
      const prior = selected.value
      selected.value = cursor && prior?.rule.id === ruleId ? { ...result, cycles: [...prior.cycles, ...result.cycles] } : result
      if (!cursor) adopt(result.rule.definition)
      proposal.value = null
    }
  })
}
async function newRule(resetAuthority = false) {
  const current = generation
  if (!resetAuthority && dirtyDraft && !(await requestConfirmation({ title: 'Discard the unsaved lifecycle draft and configure a new rule?', confirmLabel: 'New rule', cancelLabel: 'Keep unsaved draft' }))) return
  if (current !== generation) return
  selected.value = null
  proposal.value = null
  adopt({ version: 1, selector: { kind: 'ids', pageIds: [props.pageId] }, condition: { kind: 'body-inactive', days: 90 }, effects: [], terminalPolicy: 'keep' })
  enabled.value = false
}
async function previewRule() { const current = generation; await perform(async () => { const request: PageLifecyclePreviewRequest = { definition: definition(), ...(selected.value ? { ruleId: selected.value.rule.id, expectedRevision: selected.value.rule.revision } : {}), startObserving: conditionKind.value !== 'interval' && startObserving.value, runAgain: runAgain.value, reown: reown.value }; const result = await governanceApi.previewLifecycle(request); if (!disposed && current === generation && props.ready) { preview.value = result; previewRequest = request; unattendedConsent.value = false } }) }
async function save() { if (!preview.value || !previewRequest || !unattendedConsent.value) return; if (Date.parse(preview.value.expiresAt) <= Date.now()) { error.value = 'Preview expired. Preview current authority and targets again.'; preview.value = null; return } const current = generation, request = previewRequest, token = preview.value.previewToken; await perform(async () => { const result = await governanceApi.saveLifecycle({ ...request, previewToken: token, unattendedConsent: true, enabled: enabled.value }); if (!disposed && current === generation && props.ready) { const fresh = await governanceApi.inspectLifecycle(result.ruleId); if (!disposed && current === generation && props.ready) { selected.value = fresh; adopt(fresh.rule.definition); message.value = 'Rule saved. Inspect actual receipts; save is not evidence that effects applied.' } } }) }
async function status(action: 'disable'|'cancel') {
  if (!selected.value) return
  const current = generation, rule = selected.value.rule
  await perform(async () => {
    if (!(await requestConfirmation({ title: action === 'cancel' ? 'Cancel pending lifecycle work? Committed effects remain.' : 'Disable future lifecycle work? Committed effects remain.', confirmLabel: action === 'cancel' ? 'Cancel pending work' : 'Disable rule', cancelLabel: 'Keep rule' })) || current !== generation || !props.ready || !governanceOwnerMatches(props.authorityKey)) return
    await governanceApi.lifecycleStatus(rule.id, rule.revision, action)
    const result = await governanceApi.inspectLifecycle(rule.id)
    if (!disposed && current === generation && props.ready) { selected.value = result; adopt(result.rule.definition) }
  })
}
async function resume(cycleId: string) {
  const current = generation
  await perform(async () => {
    if (!(await requestConfirmation({ title: 'Resume only uncommitted effects? Committed actions are never replayed; source changes may require a fresh preview.', confirmLabel: 'Explicitly resume', cancelLabel: 'Keep current outcome' })) || current !== generation || !props.ready || !governanceOwnerMatches(props.authorityKey)) return
    await governanceApi.resume(cycleId)
    if (!disposed && current === generation && props.ready) message.value = 'Resume requested. Refresh receipts to see the actual per-effect outcome.'
  })
}
async function openProposal(id: string) { const current = generation; await perform(async () => { const result = await governanceApi.proposal(id); if (!disposed && current === generation && props.ready) { proposal.value = result; moveOpen.value = false } }) }
async function refuse() {
  if (!proposal.value) return
  const current = generation, id = proposal.value.id
  await perform(async () => {
    await governanceApi.refuse(id)
    if (disposed || current !== generation || !props.ready) return
    const result = await governanceApi.proposal(id)
    if (!disposed && current === generation && props.ready) {
      proposal.value = result
      message.value = 'Proposal refused. No move occurred; earlier committed effects remain.'
    }
  })
}
async function fulfill(selection: { locale: string; path: string; reviewToken?: string }): Promise<boolean | void | MovePageReceipt> {
  const current = generation, value = proposal.value
  if (!props.ready || !value || value.requiresNewPreview || value.status !== 'awaiting-human' || !governanceOwnerMatches(props.authorityKey)) return false
  if (selection.path !== value.destinationPath || selection.locale !== value.destinationLocale) throw new Error('A changed destination needs a fresh lifecycle preview. This proposal cannot authorize another move.')
  const result = await movePage(captureGovernanceFetch(window.fetch.bind(window), props.authorityKey), value.pageId, selection.locale, selection.path, value.currentSourceRevision, 'Native move not confirmed. Inspect the proposal and current page before retrying.', selection.reviewToken, value.id)
  if (disposed || current !== generation || !props.ready) return false
  if (!selection.reviewToken) {
    const inspected = await governanceApi.proposal(value.id)
    if (disposed || current !== generation || !props.ready) return false
    moveOpen.value = false
    proposal.value = inspected
    message.value = 'Native move response received. Proposal status and canonical receipt are authoritative.'
  }
  return result
}
function moved() { moveOpen.value = false; if (proposal.value) void openProposal(proposal.value.id) }
watch(() => [props.pageId, props.pageLocale, props.pagePath, props.authorityKey, props.ready], () => { generation++; rules.value = []; nextRulesCursor.value = null; selected.value = null; proposal.value = null; preview.value = null; previewRequest = null; moveOpen.value = false; busy.value = false; error.value = ''; message.value = ''; void newRule(true); if (props.ready) void loadRules() }, { immediate: true })
onBeforeUnmount(() => { disposed = true; generation++; emit('dirty', false); emit('busy', false) })
</script>
<style scoped>
.page-lifecycle { margin-block: 1.5rem; overflow-wrap: anywhere; } fieldset,.lifecycle-preview { display: grid; gap: .75rem; border: 1px solid rgb(var(--v-theme-outline)); padding: 1rem; margin-block: 1rem; min-width: 0; } label { display: grid; gap: .4rem; } label:has(input[type=checkbox]) { display: flex; align-items: start; } input:not([type=checkbox]),textarea,select { border: 1px solid currentColor; padding: .5rem; max-width: 100%; background: rgb(var(--v-theme-surface)); color: inherit; } button { border: 1px solid currentColor; padding: .5rem 1rem; min-height: 44px; justify-self: start; margin: .25rem; } article { border-block-end: 1px solid rgb(var(--v-theme-outline)); margin-block: 1rem; padding-block: .75rem; } :is(button,a,input,select,textarea):focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
</style>
