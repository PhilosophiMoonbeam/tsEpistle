<template>
  <section class="review-routing" :aria-labelledby="headingId" :aria-busy="busy">
    <h3 :id="headingId">Review routing and due reminders</h3>
    <p>Writer-only metadata. Routing grants no access, private ownership or review authority. Saving and reminding never attest accuracy.</p>
    <p v-if="loading" role="status">Loading current routing…</p><p v-if="error" role="alert">{{ error }}</p>
    <button v-if="error" type="button" :disabled="busy || !ready" @click="load">Reload routing (discard this routing draft)</button>
    <template v-if="view">
      <p role="status">{{ diagnostic(view.diagnostic) }}</p><dl><dt>Current due</dt><dd>{{ view.currentDueAt || 'Not currently due' }} {{ view.currentMilestone }}</dd><dt>Next due (UTC)</dt><dd>{{ view.nextDueAt || 'No next due date' }}</dd><dt>Saved schedule</dt><dd>{{ view.schedule.mode === 'accuracy-age' ? 'Current exact-revision human accuracy age: 30 days / over 90 days' : `Independent UTC anchor ${view.schedule.anchorAt}, every ${view.schedule.intervalDays} elapsed days` }}</dd></dl>
      <ul aria-label="Current configured routing references"><li v-for="member in view.members" :key="member.id">{{ member.unavailable ? `Unavailable reference ${member.id}` : member.name || `Reference ${member.id}` }}</li></ul>
      <form @submit.prevent="previewRoute(false)"><fieldset :disabled="busy || !ready"><legend>Exclusive recipient mode</legend><label>Route <select v-model="mode"><option value="contacts">Existing creator / last-editor contacts</option><option value="users">Explicit human users (1–20)</option><option value="groups">Explicit groups (1–10)</option></select></label><label v-if="mode !== 'contacts'">{{ mode === 'users' ? 'Current human user IDs' : 'Current group IDs' }} (comma separated)<input v-model="memberIds" inputmode="numeric" required /></label><p>Empty explicit selections are invalid, not Reset. Current active membership, effective write access and channel consent are checked again at delivery. No administrator fallback.</p><button type="submit">Preview recipient change</button><button type="button" @click="previewRoute(true)">Explicit Reset to existing contacts — preview</button></fieldset></form>
      <form @submit.prevent="previewSchedule"><fieldset :disabled="busy || !ready"><legend>Due schedule — independent from routing</legend><label>Schedule <select v-model="scheduleMode"><option value="accuracy-age">Actual current human accuracy age</option><option value="independent">Explicit independent UTC cadence</option></select></label><template v-if="scheduleMode === 'independent'"><label>Anchor (ISO UTC)<input v-model="anchor" placeholder="2026-11-08T12:00:00.000Z" required /></label><label>Elapsed-day interval (1–3650)<input v-model.number="interval" type="number" min="1" max="3650" required /></label><label><input v-model="independentConsent" type="checkbox" required /> These independent due dates do not indicate accuracy; human attestation does not reset this cadence.</label></template><button type="submit">Preview schedule change</button></fieldset></form>
      <button type="button" :disabled="busy || !ready" @click="previewEnable">Preview {{ view.enabled ? 'disable reminders' : 'explicitly enable reminders' }}</button>
      <section v-if="preview && pending" class="review-preview" aria-label="Review change preview"><h4>Preview before deliberate save</h4><p>{{ pending.command === 'reset' ? 'Reset only recipient overrides; preserve schedule, due time, accuracy and preferences.' : pending.command === 'enable' ? `Reminders will be ${pending.enabled ? 'enabled' : 'disabled'}. No channel preference changes.` : pending.command === 'reschedule' ? 'This changes the schedule generation and cancels uncommitted old-schedule work, not accuracy records.' : 'This changes routing only, not current contacts or page access.' }}</p><p>{{ diagnostic(preview.diagnostic) }}</p><p>Current due: {{ preview.currentDueAt || 'Not due' }} · Next due: {{ preview.nextDueAt || 'None' }}</p><ul><li v-for="recipient in preview.recipients" :key="recipient.userId">{{ recipient.name || `User ${recipient.userId}` }} — {{ recipient.inAppEnabled ? 'in-app consented' : 'in-app off' }}, {{ recipient.emailEnabled ? 'email consented' : 'email off' }}</li></ul><button type="button" :disabled="busy || !ready" @click="apply">Save this previewed change</button><button type="button" :disabled="busy" @click="pending = null; preview = null">Keep saved routing</button></section>
      <p><a :href="attestationHref">Open canonical page for deliberate current-revision human accuracy review</a>. Open its accuracy control after reviewing the source; no save or reminder here marks it verified.</p>
      <p>Recipients choose their own <a href="/p/notifications">review-reminder channel consent</a>. Assignment never opts anyone in.</p>
      <section v-if="view.deliveries.length" aria-label="Current cycle delivery receipts"><h4>Actual delivery receipts</h4><ul><li v-for="delivery in view.deliveries" :key="`${delivery.userId}-${delivery.channel}`">{{ delivery.channel }}: {{ delivery.status }} (attempt {{ delivery.attempt }})<template v-if="delivery.channel === 'email' && ['failed','unknown'].includes(delivery.status)"><label><input v-model="resendConsent" type="checkbox" /> Resending unknown email may duplicate an accepted message</label><button type="button" :disabled="busy || !ready || !resendConsent" @click="resend(delivery.userId)">Deliberately resend this email</button></template></li></ul><button v-if="view.currentCycleId" type="button" :disabled="busy || !ready" @click="acknowledge">Acknowledge my reminder only — not accuracy</button></section>
    </template>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue'
import { governanceApi, governanceOwnerMatches, PageGovernanceError } from '../helpers/page-governance-api.ts'
import { PageReviewRouteSchema, PageReviewScheduleSchema, type PageReviewCommand, type PageReviewView } from '../../shared/page-review-routing.ts'
const props = defineProps<{ pageId: number; sourceRevision: string; ready: boolean; authorityKey: string; attestationHref: string }>()
const emit = defineEmits<{ dirty: [value: boolean]; busy: [value: boolean] }>()
const headingId = `review-routing-${useId()}`, view = ref<PageReviewView | null>(null), preview = ref<PageReviewView | null>(null), pending = ref<PageReviewCommand | null>(null), mode = ref<'contacts' | 'users' | 'groups'>('contacts'), memberIds = ref(''), scheduleMode = ref<'accuracy-age' | 'independent'>('accuracy-age'), anchor = ref(''), interval = ref(30), independentConsent = ref(false), resendConsent = ref(false), loading = ref(false), busy = ref(false), error = ref('')
let generation = 0, controller: AbortController | null = null, disposed = false, adopting = false
watch(busy, value => emit('busy', value))
watch([mode, memberIds, scheduleMode, anchor, interval, independentConsent], () => { if (!adopting) { pending.value = null; preview.value = null; emit('dirty', true) } })
function adopt(loaded: PageReviewView) { adopting = true; view.value = loaded; mode.value = loaded.mode; memberIds.value = loaded.mode === 'contacts' ? '' : loaded.members.map(member => member.id).join(', '); scheduleMode.value = loaded.schedule.mode; anchor.value = loaded.schedule.mode === 'independent' ? loaded.schedule.anchorAt : ''; interval.value = loaded.schedule.mode === 'independent' ? loaded.schedule.intervalDays : 30; independentConsent.value = false; pending.value = null; preview.value = null; emit('dirty', false); queueMicrotask(() => { adopting = false }) }
function diagnostic(code: string) { const descriptions: Record<string,string> = { disabled: 'Reminders are disabled. No automatic enrollment.', 'no-current-contacts': 'No current review contact. Select an explicit current route.', 'no-eligible-recipients': 'No eligible consenting recipients. Routing never grants access.', 'opted-out': 'Eligible recipients have not consented to a channel.', protected: 'Protected page: an interactive unlocked human review is required.', 'unknown-clock': 'The accuracy clock is unknown. No invented due time.', scheduled: 'Scheduled for the displayed UTC due time.', queued: 'Current reminder queued; delivery is not yet confirmed.', delivered: 'A delivery receipt is recorded.', failed: 'Delivery failed. Inspect receipts before explicitly retrying.', 'unknown-email': 'Email acceptance is unknown. Automatic resend is disabled.', suppressed: 'Delivery suppressed by current authority or preferences.' }; return descriptions[code] ?? code }
async function load() {
  const current = ++generation; controller?.abort(); view.value = null; pending.value = null; preview.value = null; error.value = ''; busy.value = false
  if (!props.ready) return
  controller = new AbortController(); loading.value = true
  try { const loaded = await governanceApi.review(props.pageId, controller.signal); if (!disposed && current === generation && props.ready) { if (loaded.pageId !== props.pageId || loaded.sourceRevision !== props.sourceRevision) throw new Error('Source changed. Reload and review the current canonical page.'); adopt(loaded) } }
  catch (cause) { if (!disposed && current === generation && !(cause instanceof Error && cause.name === 'AbortError')) error.value = cause instanceof Error ? cause.message : 'Routing unavailable.' }
  finally { if (!disposed && current === generation) loading.value = false }
}
async function prepare(command: PageReviewCommand) {
  if (!props.ready || busy.value || !view.value || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true; error.value = ''; pending.value = null; preview.value = null
  try { const result = await governanceApi.previewReview(props.pageId, { expectedSourceRevision: command.expectedSourceRevision, expectedRoutingRevision: command.expectedRoutingRevision, ...(command.command === 'route' ? { route: command.route } : command.command === 'reset' ? { route: { mode: 'contacts' as const } } : {}), ...(command.command === 'reschedule' ? { schedule: command.schedule } : {}) }); if (!disposed && current === generation && props.ready) { pending.value = command; preview.value = result; emit('dirty', true) } }
  catch (cause) {
    if (!disposed && current === generation) {
      error.value = cause instanceof Error ? cause.message : 'Preview failed.'
      if (cause instanceof PageGovernanceError && [401, 403, 404].includes(cause.status)) { view.value = null; pending.value = null; preview.value = null; emit('dirty', false) }
    }
  }
  finally { if (!disposed && current === generation) busy.value = false }
}
function previewRoute(reset: boolean) {
  if (!view.value) return
  const fence = { expectedSourceRevision: props.sourceRevision, expectedRoutingRevision: view.value.routingRevision }
  try { if (reset) { void prepare({ command: 'reset', mode: 'contacts', ...fence }); return } const ids = memberIds.value.split(',').map(value => Number(value.trim())); const route = PageReviewRouteSchema.parse(mode.value === 'contacts' ? { mode: 'contacts' } : mode.value === 'users' ? { mode: 'users', userIds: ids } : { mode: 'groups', groupIds: ids }); void prepare({ command: 'route', route, ...fence }) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Choose valid current recipients.' }
}
function previewSchedule() { if (!view.value) return; try { const schedule = PageReviewScheduleSchema.parse(scheduleMode.value === 'accuracy-age' ? { mode: 'accuracy-age' } : { mode: 'independent', anchorAt: anchor.value, intervalDays: interval.value, acknowledgeIndependentAccuracy: independentConsent.value }); void prepare({ command: 'reschedule', expectedSourceRevision: props.sourceRevision, expectedRoutingRevision: view.value.routingRevision, schedule }) } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Enter an explicit valid schedule.' } }
function previewEnable() { if (view.value) void prepare({ command: 'enable', expectedSourceRevision: props.sourceRevision, expectedRoutingRevision: view.value.routingRevision, enabled: !view.value.enabled }) }
async function execute(command: PageReviewCommand) {
  if (!props.ready || busy.value || !governanceOwnerMatches(props.authorityKey)) return
  const current = generation; busy.value = true; error.value = ''
  try { const loaded = await governanceApi.updateReview(props.pageId, command); if (!disposed && current === generation && props.ready) adopt(loaded) }
  catch (cause) {
    if (!disposed && current === generation) {
      error.value = cause instanceof Error ? cause.message : 'Save outcome not confirmed. Reload before retrying.'
      pending.value = null; preview.value = null
      if (cause instanceof PageGovernanceError && [401, 403, 404].includes(cause.status)) { view.value = null; emit('dirty', false) }
    }
  }
  finally { if (!disposed && current === generation) busy.value = false }
}
function apply() { if (pending.value && preview.value) void execute(pending.value) }
function acknowledge() { if (view.value?.currentCycleId) void execute({ command: 'acknowledge', expectedSourceRevision: props.sourceRevision, expectedRoutingRevision: view.value.routingRevision, cycleId: view.value.currentCycleId }) }
function resend(userId: number) { if (view.value?.currentCycleId && resendConsent.value) { resendConsent.value = false; void execute({ command: 'resend', expectedSourceRevision: props.sourceRevision, expectedRoutingRevision: view.value.routingRevision, cycleId: view.value.currentCycleId, userId, acknowledgePossibleDuplicate: true }) } }
watch(() => [props.pageId, props.sourceRevision, props.authorityKey, props.ready], () => { emit('dirty', false); resendConsent.value = false; void load() }, { immediate: true })
onBeforeUnmount(() => { disposed = true; generation++; controller?.abort(); emit('dirty', false); emit('busy', false) })
</script>
<style scoped>
.review-routing { margin-block: 1.5rem; overflow-wrap: anywhere; } fieldset, .review-preview { display: grid; gap: .75rem; border: 1px solid rgb(var(--v-theme-outline)); margin-block: 1rem; padding: 1rem; } label { display: grid; gap: .4rem; } label:has(input[type=checkbox]) { display: flex; align-items: start; } input:not([type=checkbox]),select { border: 1px solid currentColor; padding: .5rem; background: rgb(var(--v-theme-surface)); color: inherit; max-width: 100%; } button { border: 1px solid currentColor; min-height: 44px; padding: .5rem 1rem; justify-self: start; } dt { font-weight: 600; } dd { margin-block-end: .6rem; } :is(button,a,input,select):focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
</style>
