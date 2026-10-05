<template>
  <section class="control-panel" aria-labelledby="routing-title">
    <header><div><h2 id="routing-title">Model tasks & automatic routing</h2><p>After configuring generative models and a separate Agent Decision Provider, declare task sufficiency for current model versions. Routing is opt-in.</p></div><v-btn variant="text" :loading="loading" :disabled="busy || loading" @click="refresh">Refresh policy & models</v-btn></header>
    <v-alert type="info" variant="tonal">Users interact with the Agent, not a model picker. The authorized administrator default starts conversations; automatic routing stays on the current model or swaps directly to an eligible alternative. Only currently authorized, enabled, verified models qualify. Changes happen between durable turns, never during approval replay. Unknown sufficiency or pricing excludes alternatives; the authorized current model remains the safe fallback. Cost and latency estimates are not billing or measured performance, and assume no prompt-cache discount.</v-alert>
    <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
    <v-alert v-if="profilesError" type="warning" variant="tonal" role="alert">Model state is unavailable or stale: {{ profilesError }}. Refresh models before changing declarations.</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Loading routing policy" />
    <v-form v-if="policy" @submit.prevent="savePolicy">
      <h3>Routing policy · current revision {{ policy.revision }}</h3>
      <p role="status">{{ policyDirty ? `Unsaved changes based on revision ${editRevision}.` : 'No unsaved policy changes.' }}</p>
      <v-alert v-if="policyConflict" type="warning" variant="tonal">The policy changed elsewhere. Your draft is preserved; discard it to review the current revision before saving.</v-alert>
      <v-checkbox v-model="draft.enabled" label="Enable automatic routing" :disabled="busy || loading || denied" />
      <v-select v-model="draft.decisionProviderId" :items="providerOptions" item-title="title" item-value="value" item-props="props" clearable label="Agent Decision Provider (blank uses decision default)" :disabled="busy || loading || denied" />
      <p v-if="selectedDecision">Classifier: {{ selectedDecision.displayName }} · {{ selectedDecision.config.kind === 'typesafe' ? 'Native TypeSafe / Jev' : `Custom ${selectedDecision.config.dialect}` }} · {{ selectedDecision.config.model }} · revision {{ selectedDecision.revision }} · {{ selectedDecision.enabled ? 'enabled' : 'disabled' }} · credential {{ selectedDecision.secretConfigured ? 'configured' : 'missing' }} · checked {{ selectedDecision.checkedAt || 'never' }}{{ selectedDecision.isDefault ? ' · decision default' : '' }}.</p>
      <v-alert v-if="decisionProblem" type="warning" variant="tonal">{{ decisionProblem }} <v-btn variant="text" @click="emit('navigate', 'decision')">Configure Decision Providers</v-btn></v-alert>
      <v-alert v-if="!profiles.some(p => p.isGlobalDefault && modelReady(p) && p.exposureMode === 'all_agent_users')" type="warning" variant="tonal">No ready administrator default is available. Configure an enabled, verified model with credentials and all-Agent-user access. <v-btn variant="text" @click="emit('navigate', 'profiles')">Configure generative models</v-btn></v-alert>
      <div class="fields"><v-text-field v-for="field in policyFields" :key="field.key" v-model.number="draft[field.key]" type="number" :step="field.step" :label="field.label" :disabled="busy || loading || denied" /></div>
      <v-btn type="submit" color="primary" :loading="busy" :disabled="denied || loading || !policyDirty || policyConflict || (draft.enabled && Boolean(decisionProblem))">Save routing policy</v-btn>
      <v-btn variant="text" :disabled="busy || loading || !policyDirty" @click="policyDiscard = true">Discard policy changes</v-btn>
    </v-form>
    <section class="entry"><h3>Model task declarations</h3><p>Declarations bind an immutable current generative profile version. Changing the profile invalidates the old declaration; review and redeclare rather than inheriting unproven capability. A declaration never grants access or enables a model. Alternatives also require known server-side pricing.</p><p v-if="!profiles.length">No generative model profiles available. <v-btn variant="text" @click="emit('navigate', 'profiles')">Configure generative models</v-btn></p>
      <article v-for="{ profile: p, declaration } in modelRows" :key="p.id" class="entry">
        <h4>{{ p.displayName }} · {{ p.model }} <v-chip v-if="p.isGlobalDefault" size="small" color="primary">Administrator default</v-chip></h4>
        <p>{{ p.status === 'enabled' ? 'Enabled' : 'Disabled' }} · {{ p.conformed ? 'connection verified' : 'connection not verified' }} · credential {{ p.secretConfigured ? 'configured' : 'missing' }} · access {{ p.exposureMode === 'all_agent_users' ? 'all Agent users' : p.groupIds?.length ? 'granted groups only' : 'no granted groups' }} · checked {{ p.connectionCheck?.completedAt || 'never' }}.</p>
        <p>Current version: <code>{{ p.profileVersionId || 'unavailable' }}</code></p>
        <template v-if="declaration"><p>Declared version: {{ declaration.profileVersionId }} · revision {{ declaration.revision }} <strong v-if="declaration.profileVersionId !== p.profileVersionId">(stale; not eligible)</strong></p><p>{{ declaration.acceptableTasks.map(t => `${t.taskClass}: ${t.complexities.join(', ')}`).join(' · ') }}</p><p>Configured latency estimate: {{ declaration.estimatedLatencyMs === null ? 'unknown' : `${declaration.estimatedLatencyMs} ms` }}</p></template><p v-else>No declared task sufficiency. This model is not an automatic alternative.</p>
        <p v-if="!modelReady(p)">Not ready for routing: enable, verify, configure credentials and grant an audience in Generative models.</p>
        <v-btn variant="tonal" :disabled="busy || loading || denied || Boolean(profilesError) || !policy || !p.profileVersionId" @click="open(p)">Declare current version</v-btn><v-btn v-if="declaration" variant="text" color="error" :disabled="busy || loading || denied" @click="remove = declaration">Remove declaration</v-btn>
      </article>
      <article v-for="m in declarations.filter(m => !profiles.some(p => p.id === m.profileId))" :key="m.profileId" class="entry"><p>Unavailable profile {{ m.profileId }} · revision {{ m.revision }}. This declaration does not authorize a model.</p><v-btn variant="text" color="error" :disabled="busy || loading || denied" @click="remove = m">Remove declaration</v-btn></article>
    </section>
    <v-dialog :model-value="dialog" max-width="720" :persistent="busy" @update:model-value="close"><v-card title="Declare current model task sufficiency"><v-card-text><p>{{ selected?.displayName }} · {{ selected?.model }}</p><p>Immutable current version {{ selected?.profileVersionId }}</p><v-alert v-if="declarationStale" type="warning" variant="tonal">The model version or declaration changed. Your draft is preserved; close and reopen the current version before saving.</v-alert><v-alert v-if="formError" type="error" variant="tonal" role="alert">{{ formError }}</v-alert><v-form @submit.prevent="saveModel"><div v-for="task in ROUTING_TASK_CLASSES" :key="task"><v-select v-model="tasks[task]" :items="ROUTING_COMPLEXITIES" multiple chips :label="`${task} — acceptable complexities`" :disabled="busy || denied" /></div><v-text-field v-model="latency" type="number" label="Optional configured latency estimate (milliseconds; blank = unknown)" :disabled="busy || denied" /><v-card-actions><v-btn :disabled="busy" @click="close(false)">Cancel</v-btn><v-spacer /><v-btn type="submit" color="primary" :loading="busy" :disabled="denied || loading || declarationStale || Boolean(profilesError)">Save declaration</v-btn></v-card-actions></v-form></v-card-text></v-card></v-dialog>
    <v-dialog v-model="discard" max-width="440"><v-card title="Discard unsaved declaration?"><v-card-actions><v-btn @click="discard = false">Keep editing</v-btn><v-btn color="error" @click="discard = false; dialog = false">Discard</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="policyDiscard" max-width="440"><v-card title="Discard unsaved routing policy?"><v-card-text>The latest saved revision will replace your draft.</v-card-text><v-card-actions><v-btn @click="policyDiscard = false">Keep editing</v-btn><v-btn color="error" @click="resetPolicy(); policyDiscard = false">Discard</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog :model-value="Boolean(remove)" max-width="440" :persistent="busy" @update:model-value="value => { if (!value && !busy) remove = null }"><v-card title="Remove task declaration?"><v-card-text>The model will no longer qualify as an automatic alternative through this declaration.</v-card-text><v-card-actions><v-btn :disabled="busy" @click="remove = null">Cancel</v-btn><v-btn color="error" :loading="busy" :disabled="denied || loading" @click="removeModel">Remove</v-btn></v-card-actions></v-card></v-dialog>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { AgentApiError } from '../../helpers/agents-api.ts'
import { DEFAULT_ROUTING_POLICY, ROUTING_TASK_CLASSES, ROUTING_COMPLEXITIES, RoutingPolicyInputSchema, RoutingModelPolicyInputSchema, type RoutingTaskClass, type RoutingComplexity } from '../../../shared/agents/routing.ts'
import { getAgentRouting, updateAgentRouting, setAgentRoutingModel, deleteAgentRoutingModel, listDecisionProviders, type RoutingPolicyView, type RoutingModelPolicyView, type DecisionProviderView } from '../../helpers/agent-control-api.ts'
interface ModelProfile {
  id: string; displayName: string; model: string; profileVersionId?: string
  status?: 'enabled' | 'disabled'; conformed?: boolean; secretConfigured?: boolean; isGlobalDefault?: boolean
  exposureMode?: 'all_agent_users' | 'groups'; groupIds?: readonly number[]; connectionCheck?: { completedAt: string } | null
}
const { csrfToken, profiles, refreshKey = 0, profilesError = '' } = defineProps<{ csrfToken: string; profiles: readonly ModelProfile[]; refreshKey?: number; profilesError?: string }>()
const emit = defineEmits<{ 'refresh-profiles': []; changed: []; state: [value: { policy: RoutingPolicyView; models: RoutingModelPolicyView[] } | null]; navigate: [section: 'profiles' | 'decision'] }>()
const fetcher: typeof fetch = (...args) => window.fetch(...args)
const loading = ref(false), busy = ref(false), denied = ref(false), error = ref(''), formError = ref(''), policy = ref<RoutingPolicyView | null>(null), declarations = ref<RoutingModelPolicyView[]>([]), providers = ref<DecisionProviderView[]>([]), selected = ref<ModelProfile | null>(null), remove = ref<RoutingModelPolicyView | null>(null), dialog = ref(false), discard = ref(false), baseline = ref(''), latency = ref(''), expectedRevision = ref(0)
const policyBaseline = ref(''), editRevision = ref(0), policyDiscard = ref(false)
const draft = reactive({ ...DEFAULT_ROUTING_POLICY })
const policyDirty = computed(() => Boolean(policyBaseline.value) && JSON.stringify(draft) !== policyBaseline.value)
const policyConflict = computed(() => policyDirty.value && policy.value?.revision !== editRevision.value)
const providerOptions = computed(() => providers.value.map(p => ({ title: `${p.displayName}${p.isDefault ? ' · default' : ''}${!p.enabled ? ' · disabled' : ''}${!p.secretConfigured ? ' · credential missing' : ''}${!p.checkedAt ? ' · unchecked' : ''}`, value: p.id, props: { disabled: !p.enabled || !p.secretConfigured || !p.checkedAt } })))
const selectedDecision = computed(() => draft.decisionProviderId ? providers.value.find(p => p.id === draft.decisionProviderId) : providers.value.find(p => p.isDefault))
const decisionProblem = computed(() => {
  const p = selectedDecision.value
  if (!p) return draft.decisionProviderId ? 'The configured Decision Provider is unavailable. Choose a current provider or use the decision default.' : 'No default Agent Decision Provider is configured. Check, enable and select a decision default before enabling routing.'
  if (!p.secretConfigured || !p.enabled || !p.checkedAt) return 'The selected Agent Decision Provider needs an available credential, successful check and enablement before routing can use it.'
  return ''
})
const policyFields: readonly { key: 'minimumConfidence' | 'minimumSavingsRatio' | 'minimumSavingsMicros' | 'switchCostMicros' | 'classifierMaxStateBytes'; label: string; step?: string }[] = [
  { key: 'minimumConfidence', label: 'Minimum classifier confidence (0.8–1)', step: '0.01' },
  { key: 'minimumSavingsRatio', label: 'Minimum savings ratio (0.05–1)', step: '0.01' },
  { key: 'minimumSavingsMicros', label: 'Minimum savings (µUSD estimate)' },
  { key: 'switchCostMicros', label: 'Switching loss allowance (µUSD estimate)' },
  { key: 'classifierMaxStateBytes', label: 'Bounded classifier state bytes (256–16384)' }
]
const modelRows = computed(() => profiles.map(profile => ({ profile, declaration: declarations.value.find(m => m.profileId === profile.id) })))
const modelReady = (p: ModelProfile) => p.status === 'enabled' && p.conformed && p.secretConfigured && (p.exposureMode === 'all_agent_users' || Boolean(p.groupIds?.length))
const declarationStale = computed(() => Boolean(selected.value) && (profiles.find(p => p.id === selected.value?.id)?.profileVersionId !== selected.value?.profileVersionId || (declarations.value.find(m => m.profileId === selected.value?.id)?.revision ?? 0) !== expectedRevision.value))
const tasks = reactive<Record<RoutingTaskClass, RoutingComplexity[]>>({ conversation: [], retrieval: [], writing: [], coding: [], analysis: [], planning: [] })
let controller: AbortController | null = null
function resetPolicy() {
  if (!policy.value) return
  const { revision, updatedAt, ...input } = policy.value
  Object.assign(draft, input)
  editRevision.value = revision
  policyBaseline.value = JSON.stringify(draft)
}
async function load() {
  controller?.abort()
  const request = new AbortController()
  controller = request
  loading.value = true
  try {
    const [r, p] = await Promise.all([getAgentRouting(fetcher, csrfToken, request.signal), listDecisionProviders(fetcher, csrfToken, request.signal)])
    if (request.signal.aborted) return
    const retainDraft = policyDirty.value
    policy.value = r.policy; declarations.value = r.models; providers.value = p
    if (!retainDraft) resetPolicy()
    denied.value = false; error.value = ''
    emit('state', r)
  } catch (e) {
    if (request.signal.aborted) return
    denied.value = e instanceof AgentApiError && e.status === 403
    error.value = denied.value ? 'System administration permission is required.' : e instanceof Error ? e.message : 'Unable to load routing policy.'
    emit('state', null)
  } finally { if (controller === request) loading.value = false }
}
function refresh() { emit('refresh-profiles'); void load() }
async function savePolicy() {
  if (busy.value || loading.value || denied.value || !policy.value || policyConflict.value || !policyDirty.value) return
  busy.value = true; error.value = ''
  try {
    if (draft.enabled && decisionProblem.value) throw new Error(decisionProblem.value)
    policy.value = await updateAgentRouting(fetcher, csrfToken, { ...RoutingPolicyInputSchema.parse(draft), expectedRevision: editRevision.value })
    resetPolicy()
    await load(); emit('changed')
  } catch (e) {
    if (e instanceof AgentApiError && e.status === 403) denied.value = true
    if (e instanceof AgentApiError && e.status === 409) { await load(); error.value = 'Stale policy revision. Your draft is preserved; discard it and review the current revision before saving again.' }
    else error.value = e instanceof Error ? e.message : 'Unable to save routing policy.'
  } finally { busy.value = false }
}
function open(p: ModelProfile) {
  if (denied.value || busy.value || loading.value || profilesError) return
  selected.value = { ...p }
  const existing = declarations.value.find(m => m.profileId === p.id)
  expectedRevision.value = existing?.revision ?? 0
  for (const task of ROUTING_TASK_CLASSES) tasks[task] = [...(existing?.acceptableTasks.find(t => t.taskClass === task)?.complexities ?? [])]
  latency.value = existing?.estimatedLatencyMs?.toString() ?? ''
  baseline.value = JSON.stringify({ tasks, latency: latency.value }); formError.value = ''; dialog.value = true
}
function close(value: boolean) { if (value || busy.value) return; if (JSON.stringify({ tasks, latency: latency.value }) !== baseline.value) discard.value = true; else dialog.value = false }
async function saveModel() {
  if (busy.value || loading.value || denied.value || declarationStale.value || profilesError || !selected.value?.profileVersionId) return
  busy.value = true; formError.value = ''
  try {
    const input = RoutingModelPolicyInputSchema.parse({ profileVersionId: selected.value.profileVersionId, acceptableTasks: ROUTING_TASK_CLASSES.filter(task => tasks[task].length).map(task => ({ taskClass: task, complexities: tasks[task] })), estimatedLatencyMs: latency.value.trim() ? Number(latency.value) : null })
    await setAgentRoutingModel(fetcher, csrfToken, selected.value.id, { ...input, expectedRevision: expectedRevision.value })
    dialog.value = false; await load(); emit('changed')
  } catch (e) {
    if (e instanceof AgentApiError && e.status === 403) denied.value = true
    if (e instanceof AgentApiError && e.status === 409) { emit('refresh-profiles'); await load(); formError.value = 'Stale declaration or profile version. Close and reopen this declaration before retrying.' }
    else formError.value = e instanceof Error ? e.message : 'Unable to save declaration.'
  } finally { busy.value = false }
}
async function removeModel() {
  const m = remove.value
  if (busy.value || loading.value || denied.value || !m) return
  busy.value = true; error.value = ''
  try { await deleteAgentRoutingModel(fetcher, csrfToken, m.profileId, m.revision); remove.value = null; await load(); emit('changed') }
  catch (e) {
    if (e instanceof AgentApiError && e.status === 403) denied.value = true
    if (e instanceof AgentApiError && e.status === 409) { await load(); remove.value = null; error.value = 'Stale revision. Refreshed declarations; review before retrying.' }
    else error.value = e instanceof Error ? e.message : 'Unable to remove declaration.'
  } finally { busy.value = false }
}
watch(() => refreshKey, () => { void load() })
watch(() => profiles.map(p => `${p.id}:${p.profileVersionId}:${p.status}:${p.conformed}:${p.secretConfigured}:${p.exposureMode}:${p.groupIds?.join(',')}:${p.isGlobalDefault}`).join('|'), () => { void load() })
onMounted(() => { void load() })
onBeforeUnmount(() => controller?.abort())
</script>
<style scoped>
.control-panel{padding:24px;background:rgb(var(--v-theme-surface));border-radius:16px}header{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}h2,h3,h4{color:rgb(var(--v-theme-primary))}p{line-height:1.6;overflow-wrap:anywhere}.entry{padding:20px 0;border-bottom:1px solid rgba(var(--v-theme-on-surface),.12)}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}.v-alert{margin-bottom:16px}
</style>
