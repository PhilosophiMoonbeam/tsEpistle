<template>
  <section class="control-panel" aria-labelledby="routing-title">
    <header><div><h2 id="routing-title">{{ t('admin:routingPolicy.modelTasksAutomaticRouting') }}</h2><p>{{ t('admin:routingPolicy.afterConfiguringGenerativeModelsAndASeparate') }}</p></div><v-btn variant="text" :loading="loading" :disabled="busy || loading" @click="refresh">{{ t('admin:routingPolicy.refreshPolicyModels') }}</v-btn></header>
    <v-alert type="info" variant="tonal">{{ t('admin:routingPolicy.usersInteractWithTheAgentNotA') }}</v-alert>
    <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
    <v-alert v-if="profilesError" type="warning" variant="tonal" role="alert">{{ t('admin:routingPolicy.modelStateIsUnavailableOrStaleRefresh', { profilesError: profilesError }) }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="primary" :aria-label="t('admin:routingPolicy.loadingRoutingPolicy')" />
    <v-form v-if="policy" @submit.prevent="savePolicy">
      <h3>{{ t('admin:routingPolicy.routingPolicyCurrentRevision', { revision: policy.revision }) }}</h3>
      <p role="status">{{ policyDirty ? t('admin:routingPolicy.unsavedRevision', { revision: editRevision }) : t('admin:routingPolicy.noUnsavedPolicyChanges') }}</p>
      <v-alert v-if="policyConflict" type="warning" variant="tonal">{{ t('admin:routingPolicy.thePolicyChangedElsewhereYourDraftIs') }}</v-alert>
      <v-checkbox v-model="draft.enabled" :label="t('admin:routingPolicy.enableAutomaticRouting')" :disabled="busy || loading || denied" />
      <v-select v-model="draft.decisionProviderId" :items="providerOptions" item-title="title" item-value="value" item-props="props" clearable :label="t('admin:routingPolicy.agentDecisionProviderBlankUsesDecisionDefault')" :disabled="busy || loading || denied" />
      <p v-if="selectedDecision">{{ t('admin:routingPolicy.classifierRevisionCredentialChecked', { displayName: selectedDecision.displayName, dialect: selectedDecision.config.kind === 'typesafe' ? t('admin:routingPolicy.nativeTypeSafeJev') : t('admin:routingPolicy.customDialect', { dialect: selectedDecision.config.dialect }), model: selectedDecision.config.model, revision: selectedDecision.revision, disabled: selectedDecision.enabled ? t('admin:routingPolicy.enabled') : t('admin:routingPolicy.disabled'), missing: selectedDecision.secretConfigured ? t('admin:routingPolicy.configured') : t('admin:routingPolicy.missing'), value: selectedDecision.checkedAt || t('admin:routingPolicy.never'), default: selectedDecision.isDefault ? t('admin:routingPolicy.decisionDefaultSuffix') : '' }) }}</p>
      <v-alert v-if="decisionProblem" type="warning" variant="tonal">{{ decisionProblem }} <v-btn variant="text" @click="emit('navigate', 'decision')">{{ t('admin:routingPolicy.configureDecisionProviders') }}</v-btn></v-alert>
      <v-alert v-if="!profiles.some(p => p.isGlobalDefault && modelReady(p) && p.exposureMode === 'all_agent_users')" type="warning" variant="tonal">{{ t('admin:routingPolicy.noReadyAdministratorDefaultIsAvailableConfigure') }}<v-btn variant="text" @click="emit('navigate', 'profiles')">{{ t('admin:routingPolicy.configureGenerativeModels') }}</v-btn></v-alert>
      <div class="fields"><v-text-field v-for="field in policyFields" :key="field.key" v-model.number="draft[field.key]" type="number" :step="field.step" :error-messages="policyErrors[field.key]" :label="field.label" :disabled="busy || loading || denied" /></div>
      <v-btn type="submit" color="primary" :loading="busy" :disabled="denied || loading || !policyDirty || policyConflict || (draft.enabled && Boolean(decisionProblem))">{{ t('admin:routingPolicy.saveRoutingPolicy') }}</v-btn>
      <v-btn variant="text" :disabled="busy || loading || !policyDirty" @click="policyDiscard = true">{{ t('admin:routingPolicy.discardPolicyChanges') }}</v-btn>
    </v-form>
    <section class="entry"><h3>{{ t('admin:routingPolicy.modelTaskDeclarations') }}</h3><p>{{ t('admin:routingPolicy.declarationsBindAnImmutableCurrentGenerativeProfile') }}</p><p v-if="!profiles.length">{{ t('admin:routingPolicy.noGenerativeModelProfilesAvailable') }}<v-btn variant="text" @click="emit('navigate', 'profiles')">{{ t('admin:routingPolicy.configureGenerativeModels') }}</v-btn></p>
      <article v-for="{ profile: p, declaration } in modelRows" :key="p.id" class="entry">
        <h4>{{ p.displayName }} · {{ p.model }} <v-chip v-if="p.isGlobalDefault" size="small" color="primary">{{ t('admin:routingPolicy.administratorDefault') }}</v-chip></h4>
        <p>{{ t('admin:routingPolicy.credentialAccessChecked', { Disabled: p.status === 'enabled' ? t('admin:routingPolicy.enabled') : t('admin:routingPolicy.disabled2'), verified: p.conformed ? t('admin:routingPolicy.connectionVerified') : t('admin:routingPolicy.connectionNotVerified'), missing: p.secretConfigured ? t('admin:routingPolicy.configured') : t('admin:routingPolicy.missing'), groups: p.exposureMode === 'all_agent_users' ? t('admin:routingPolicy.allAgentUsers') : p.groupIds?.length ? t('admin:routingPolicy.grantedGroupsOnly') : t('admin:routingPolicy.noGrantedGroups'), value: p.connectionCheck?.completedAt || t('admin:routingPolicy.never') }) }}</p>
        <p>{{ t('admin:routingPolicy.currentVersion') }}<code>{{ p.profileVersionId || t('admin:routingPolicy.unavailable') }}</code></p>
        <template v-if="declaration"><p>{{ t('admin:routingPolicy.declaredVersionRevision', { profileVersionId: declaration.profileVersionId, revision: declaration.revision }) }}<strong v-if="declaration.profileVersionId !== p.profileVersionId">{{ t('admin:routingPolicy.staleNotEligible') }}</strong></p><p>{{ declaration.acceptableTasks.map(entry => t('admin:routingPolicy.declaredTasks', { task: taskLabel(entry.taskClass), complexities: entry.complexities.map(complexityLabel).join(', ') })).join(' · ') }}</p><p>{{ t('admin:routingPolicy.configuredLatencyEstimate', { ms: declaration.estimatedLatencyMs === null ? t('admin:routingPolicy.unknown') : t('admin:routingPolicy.milliseconds', { amount: declaration.estimatedLatencyMs }) }) }}</p></template><p v-else>{{ t('admin:routingPolicy.noDeclaredTaskSufficiencyThisModelIs') }}</p>
        <p v-if="!modelReady(p)">{{ t('admin:routingPolicy.notReadyForRoutingEnableVerifyConfigure') }}</p>
        <v-btn variant="tonal" :disabled="busy || loading || denied || Boolean(profilesError) || !policy || !p.profileVersionId" @click="open(p)">{{ t('admin:routingPolicy.declareCurrentVersion') }}</v-btn><v-btn v-if="declaration" variant="text" color="error" :disabled="busy || loading || denied" @click="remove = declaration">{{ t('admin:routingPolicy.removeDeclaration') }}</v-btn>
      </article>
      <article v-for="m in declarations.filter(m => !profiles.some(p => p.id === m.profileId))" :key="m.profileId" class="entry"><p>{{ t('admin:routingPolicy.unavailableProfileRevisionThisDeclarationDoesNot', { profileId: m.profileId, revision: m.revision }) }}</p><v-btn variant="text" color="error" :disabled="busy || loading || denied" @click="remove = m">{{ t('admin:routingPolicy.removeDeclaration') }}</v-btn></article>
    </section>
    <v-dialog aria-labelledby="routingPolicy-dialog-1" :model-value="dialog" max-width="720" :persistent="busy" @update:model-value="close"><v-card><v-card-title id="routingPolicy-dialog-1">{{ t('admin:routingPolicy.declareCurrentModelTaskSufficiency') }}</v-card-title><v-card-text><p>{{ selected?.displayName }} · {{ selected?.model }}</p><p>{{ t('admin:routingPolicy.immutableCurrentVersion', { profileVersionId: selected?.profileVersionId }) }}</p><v-alert v-if="declarationStale" type="warning" variant="tonal">{{ t('admin:routingPolicy.theModelVersionOrDeclarationChangedYour') }}</v-alert><v-alert v-if="formError" type="error" variant="tonal" role="alert">{{ formError }}</v-alert><v-form @submit.prevent="saveModel"><div v-for="task in ROUTING_TASK_CLASSES" :key="task"><v-select v-model="tasks[task]" :items="complexityOptions" :error-messages="declarationErrors.tasks" multiple chips :label="t('admin:routingPolicy.acceptableComplexities', { task: taskLabel(task) })" :disabled="busy || denied" /></div><v-text-field v-model="latency" :error-messages="declarationErrors.latency" type="number" :label="t('admin:routingPolicy.optionalConfiguredLatencyEstimateMillisecondsBlankUnknown')" :disabled="busy || denied" /><v-card-actions><v-btn :disabled="busy" @click="close(false)">{{ t('admin:routingPolicy.cancel') }}</v-btn><v-spacer /><v-btn type="submit" color="primary" :loading="busy" :disabled="denied || loading || declarationStale || Boolean(profilesError)">{{ t('admin:routingPolicy.saveDeclaration') }}</v-btn></v-card-actions></v-form></v-card-text></v-card></v-dialog>
    <v-dialog aria-labelledby="routingPolicy-dialog-2" v-model="discard" max-width="440"><v-card><v-card-title id="routingPolicy-dialog-2">{{ t('admin:routingPolicy.discardUnsavedDeclaration') }}</v-card-title><v-card-actions><v-btn @click="discard = false">{{ t('admin:routingPolicy.keepEditing') }}</v-btn><v-btn color="error" @click="discard = false; dialog = false">{{ t('admin:routingPolicy.discard') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog aria-labelledby="routingPolicy-dialog-3" v-model="policyDiscard" max-width="440"><v-card><v-card-title id="routingPolicy-dialog-3">{{ t('admin:routingPolicy.discardUnsavedRoutingPolicy') }}</v-card-title><v-card-text>{{ t('admin:routingPolicy.theLatestSavedRevisionWillReplaceYour') }}</v-card-text><v-card-actions><v-btn @click="policyDiscard = false">{{ t('admin:routingPolicy.keepEditing') }}</v-btn><v-btn color="error" @click="resetPolicy(); policyDiscard = false">{{ t('admin:routingPolicy.discard') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog aria-labelledby="routingPolicy-dialog-4" :model-value="Boolean(remove)" max-width="440" :persistent="busy" @update:model-value="value => { if (!value && !busy) remove = null }"><v-card><v-card-title id="routingPolicy-dialog-4">{{ t('admin:routingPolicy.removeTaskDeclaration') }}</v-card-title><v-card-text>{{ t('admin:routingPolicy.theModelWillNoLongerQualifyAs') }}</v-card-text><v-card-actions><v-btn :disabled="busy" @click="remove = null">{{ t('admin:routingPolicy.cancel') }}</v-btn><v-btn color="error" :loading="busy" :disabled="denied || loading" @click="removeModel">{{ t('admin:routingPolicy.remove') }}</v-btn></v-card-actions></v-card></v-dialog>
  </section>
</template>
<script setup lang="ts">
import { useTranslate } from '../../helpers/use-translate.ts'
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
const t = useTranslate()
const fetcher: typeof fetch = (...args) => window.fetch(...args)
const loading = ref(false), busy = ref(false), denied = ref(false), error = ref(''), formError = ref(''), policy = ref<RoutingPolicyView | null>(null), declarations = ref<RoutingModelPolicyView[]>([]), providers = ref<DecisionProviderView[]>([]), selected = ref<ModelProfile | null>(null), remove = ref<RoutingModelPolicyView | null>(null), dialog = ref(false), discard = ref(false), baseline = ref(''), latency = ref(''), expectedRevision = ref(0)
const policyBaseline = ref(''), editRevision = ref(0), policyDiscard = ref(false)
const draft = reactive({ ...DEFAULT_ROUTING_POLICY })
const policyDirty = computed(() => Boolean(policyBaseline.value) && JSON.stringify(draft) !== policyBaseline.value)
const policyConflict = computed(() => policyDirty.value && policy.value?.revision !== editRevision.value)
const providerOptions = computed(() => providers.value.map(p => ({
  title: t('admin:routingPolicy.providerOption', {
    name: p.displayName,
    selection: t(p.isDefault ? 'admin:routingPolicy.defaultProvider' : 'admin:routingPolicy.alternativeProvider'),
    enabled: t(p.enabled ? 'admin:routingPolicy.enabled' : 'admin:routingPolicy.disabled'),
    credential: t(p.secretConfigured ? 'admin:routingPolicy.configured' : 'admin:routingPolicy.missing'),
    checked: t(p.checkedAt ? 'admin:routingPolicy.checked' : 'admin:routingPolicy.notChecked')
  }),
  value: p.id,
  props: { disabled: !p.enabled || !p.secretConfigured || !p.checkedAt }
})))
const selectedDecision = computed(() => draft.decisionProviderId ? providers.value.find(p => p.id === draft.decisionProviderId) : providers.value.find(p => p.isDefault))
const decisionProblem = computed(() => {
  const p = selectedDecision.value
  if (!p) return draft.decisionProviderId ? t('admin:routingPolicy.theConfiguredDecisionProviderIsUnavailableChoose') : t('admin:routingPolicy.noDefaultAgentDecisionProviderIsConfigured')
  if (!p.secretConfigured || !p.enabled || !p.checkedAt) return t('admin:routingPolicy.theSelectedAgentDecisionProviderNeedsAn')
  return ''
})
const policyFields: readonly { key: 'minimumConfidence' | 'minimumSavingsRatio' | 'minimumSavingsMicros' | 'switchCostMicros' | 'classifierMaxStateBytes'; label: string; step?: string }[] = [
  { key: 'minimumConfidence', label: t('admin:routingPolicy.minimumClassifierConfidence081'), step: '0.01' },
  { key: 'minimumSavingsRatio', label: t('admin:routingPolicy.minimumSavingsRatio0051'), step: '0.01' },
  { key: 'minimumSavingsMicros', label: t('admin:routingPolicy.minimumSavingsUSDEstimate') },
  { key: 'switchCostMicros', label: t('admin:routingPolicy.switchingLossAllowanceUSDEstimate') },
  { key: 'classifierMaxStateBytes', label: t('admin:routingPolicy.boundedClassifierStateBytes25616384') }
]
const modelRows = computed(() => profiles.map(profile => ({ profile, declaration: declarations.value.find(m => m.profileId === profile.id) })))
const modelReady = (p: ModelProfile) => p.status === 'enabled' && p.conformed && p.secretConfigured && (p.exposureMode === 'all_agent_users' || Boolean(p.groupIds?.length))
const declarationStale = computed(() => Boolean(selected.value) && (profiles.find(p => p.id === selected.value?.id)?.profileVersionId !== selected.value?.profileVersionId || (declarations.value.find(m => m.profileId === selected.value?.id)?.revision ?? 0) !== expectedRevision.value))
const tasks = reactive<Record<RoutingTaskClass, RoutingComplexity[]>>({ conversation: [], retrieval: [], writing: [], coding: [], analysis: [], planning: [] })
const declarationAttempted = ref(false)
const policyValidation = computed(() => RoutingPolicyInputSchema.safeParse(draft))
const policyErrors = computed(() => {
  const errors: Record<string, string> = {}
  if (!policyValidation.value.success) for (const issue of policyValidation.value.error.issues) {
    const field = String(issue.path[0] ?? '')
    errors[field] = policyFieldMessage(field)
  }
  return errors
})
function policyFieldMessage(field: string) {
  const messages: Record<string, string> = {
    minimumConfidence: t('admin:routingPolicy.invalidMinimumConfidence'),
    minimumSavingsRatio: t('admin:routingPolicy.invalidMinimumSavingsRatio'),
    minimumSavingsMicros: t('admin:routingPolicy.invalidMinimumSavingsMicros'),
    switchCostMicros: t('admin:routingPolicy.invalidSwitchCostMicros'),
    classifierMaxStateBytes: t('admin:routingPolicy.invalidClassifierMaxStateBytes'),
  }
  return messages[field] ?? t('admin:routingPolicy.invalidPolicy')
}
const declarationInput = computed(() => ({ profileVersionId: selected.value?.profileVersionId, acceptableTasks: ROUTING_TASK_CLASSES.filter(task => tasks[task].length).map(task => ({ taskClass: task, complexities: tasks[task] })), estimatedLatencyMs: latency.value.trim() ? Number(latency.value) : null }))
const declarationValidation = computed(() => RoutingModelPolicyInputSchema.safeParse(declarationInput.value))
const declarationErrors = computed(() => {
  const errors: Record<string, string> = {}
  if (!declarationAttempted.value || declarationValidation.value.success) return errors
  for (const issue of declarationValidation.value.error.issues) {
    if (issue.path[0] === 'estimatedLatencyMs') errors.latency = t('admin:routingPolicy.invalidLatency')
    else errors.tasks = t('admin:routingPolicy.invalidTasks')
  }
  return errors
})
function taskLabel(task: RoutingTaskClass) { return t(`admin:routingPolicy.task_${task}`) }
function complexityLabel(complexity: RoutingComplexity) { return t(`admin:routingPolicy.complexity_${complexity}`) }
const complexityOptions = computed(() => ROUTING_COMPLEXITIES.map(value => ({ title: complexityLabel(value), value })))
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
    error.value = denied.value ? t('admin:routingPolicy.systemAdministrationPermissionIsRequired') : e instanceof Error ? e.message : t('admin:routingPolicy.unableToLoadRoutingPolicy')
    emit('state', null)
  } finally { if (controller === request) loading.value = false }
}
function refresh() { emit('refresh-profiles'); void load() }
async function savePolicy() {
  if (busy.value || loading.value || denied.value || !policy.value || policyConflict.value || !policyDirty.value) return
  const validated = policyValidation.value
  if (!validated.success) { error.value = t('admin:routingPolicy.invalidPolicy'); return }
  busy.value = true; error.value = ''
  try {
    if (draft.enabled && decisionProblem.value) throw new Error(decisionProblem.value)
    policy.value = await updateAgentRouting(fetcher, csrfToken, { ...validated.data, expectedRevision: editRevision.value })
    resetPolicy()
    await load(); emit('changed')
  } catch (e) {
    if (e instanceof AgentApiError && e.status === 403) denied.value = true
    if (e instanceof AgentApiError && e.status === 409) { await load(); error.value = t('admin:routingPolicy.stalePolicyRevisionYourDraftIsPreserved') }
    else error.value = e instanceof Error ? e.message : t('admin:routingPolicy.unableToSaveRoutingPolicy')
  } finally { busy.value = false }
}
function open(p: ModelProfile) {
  if (denied.value || busy.value || loading.value || profilesError) return
  selected.value = { ...p }
  const existing = declarations.value.find(m => m.profileId === p.id)
  expectedRevision.value = existing?.revision ?? 0
  for (const task of ROUTING_TASK_CLASSES) tasks[task] = [...(existing?.acceptableTasks.find(t => t.taskClass === task)?.complexities ?? [])]
  latency.value = existing?.estimatedLatencyMs?.toString() ?? ''
  baseline.value = JSON.stringify({ tasks, latency: latency.value }); declarationAttempted.value = false; formError.value = ''; dialog.value = true
}
function close(value: boolean) { if (value || busy.value) return; if (JSON.stringify({ tasks, latency: latency.value }) !== baseline.value) discard.value = true; else dialog.value = false }
async function saveModel() {
  if (busy.value || loading.value || denied.value || declarationStale.value || profilesError || !selected.value?.profileVersionId) return
  declarationAttempted.value = true
  const validated = declarationValidation.value
  if (!validated.success) { formError.value = t('admin:routingPolicy.invalidDeclaration'); return }
  busy.value = true; formError.value = ''
  try {
    const input = validated.data
    await setAgentRoutingModel(fetcher, csrfToken, selected.value.id, { ...input, expectedRevision: expectedRevision.value })
    dialog.value = false; await load(); emit('changed')
  } catch (e) {
    if (e instanceof AgentApiError && e.status === 403) denied.value = true
    if (e instanceof AgentApiError && e.status === 409) { emit('refresh-profiles'); await load(); formError.value = t('admin:routingPolicy.staleDeclarationOrProfileVersionCloseAnd') }
    else formError.value = e instanceof Error ? e.message : t('admin:routingPolicy.unableToSaveDeclaration')
  } finally { busy.value = false }
}
async function removeModel() {
  const m = remove.value
  if (busy.value || loading.value || denied.value || !m) return
  busy.value = true; error.value = ''
  try { await deleteAgentRoutingModel(fetcher, csrfToken, m.profileId, m.revision); remove.value = null; await load(); emit('changed') }
  catch (e) {
    if (e instanceof AgentApiError && e.status === 403) denied.value = true
    if (e instanceof AgentApiError && e.status === 409) { await load(); remove.value = null; error.value = t('admin:routingPolicy.staleRevisionRefreshedDeclarationsReviewBeforeRetrying') }
    else error.value = e instanceof Error ? e.message : t('admin:routingPolicy.unableToRemoveDeclaration')
  } finally { busy.value = false }
}
watch(() => refreshKey, () => { void load() })
watch(() => profiles.map(p => `${p.id}:${p.profileVersionId}:${p.status}:${p.conformed}:${p.secretConfigured}:${p.exposureMode}:${p.groupIds?.join(',')}:${p.isGlobalDefault}`).join('|'), () => { void load() })
onMounted(() => { void load() })
onBeforeUnmount(() => controller?.abort())
</script>
<style scoped lang="scss">
@use "../admin/admin-workspace.scss" as workspace;
.control-panel { @include workspace.admin-agent-control; }
h4 { color: rgb(var(--v-theme-on-surface)); overflow-wrap: anywhere; }
.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: var(--wiki-space-4); }
</style>
