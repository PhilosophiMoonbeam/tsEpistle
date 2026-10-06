<template>
  <section class="media-admin" aria-labelledby="media-admin-title">
    <header class="media-admin__header"><div><h2 id="media-admin-title">{{ tr('mediaProviders') }}</h2><p>{{ tr('mediaIndependentHelp') }}</p></div><div><v-btn :loading="loading" :disabled="busy" @click="load">{{ tr('refreshStatus') }}</v-btn><v-btn color="primary" :disabled="busy" @click="open()">{{ tr('addMediaProvider') }}</v-btn></div></header>
    <v-alert type="info" variant="tonal">{{ tr('mediaInteractionsMigration') }}</v-alert>
    <v-alert v-if="error" type="error" variant="tonal" role="alert" class="my-4">{{ error }}<v-btn :disabled="loading || busy" @click="load">{{ tr('retry') }}</v-btn></v-alert>
    <p role="status" aria-live="polite">{{ busy ? tr('mediaSaving') : notice }}</p>
    <v-progress-linear v-if="loading" indeterminate :aria-label="tr('loading')" />
    <p v-if="loaded && !providers.length">{{ tr('mediaEmpty') }}</p>
    <article v-for="provider in providers" :key="provider.id" class="media-admin__provider">
      <div><h3>{{ provider.displayName }}</h3><p>{{ tr(`mediaKind${provider.config.kind}`) }} · <code>{{ provider.config.api }}</code> · <code>{{ provider.config.model }}</code></p><p><code>{{ provider.config.baseUrl }}</code></p><p>{{ provider.enabled ? tr('enabled') : tr('disabled') }} · {{ provider.secretConfigured ? tr('mediaCredentialConfigured') : tr('mediaCredentialMissing') }}<span v-if="provider.isDefault"> · {{ tr('mediaOperationDefault') }}</span></p><p>{{ provider.exposureMode === 'all_agent_users' ? tr('everyone') : groupNames(provider.groupIds) }}</p></div>
      <div class="media-admin__actions"><v-btn :disabled="busy" :aria-label="tr('mediaEditNamed', { name: provider.displayName })" @click="open(provider)">{{ tr('mediaEdit') }}</v-btn><v-btn :disabled="busy || (!provider.enabled && !provider.secretConfigured)" @click="mutate(() => enableMediaProvider(fetcher, csrfToken, provider.id, provider.revision, !provider.enabled))">{{ provider.enabled ? tr('mediaDisable') : tr('mediaEnable') }}</v-btn><v-btn :disabled="busy || !provider.enabled || !provider.secretConfigured || provider.isDefault" @click="mutate(() => defaultMediaProvider(fetcher, csrfToken, provider.id, provider.revision))">{{ tr('mediaSetDefault') }}</v-btn><v-btn color="error" :disabled="busy" @click="removing = provider">{{ tr('mediaRemove') }}</v-btn></div>
    </article>
    <v-dialog v-model="dialog" max-width="850" scrollable persistent aria-labelledby="media-editor-title">
      <v-card><v-card-title id="media-editor-title">{{ editing ? tr('editMediaProvider') : tr('addMediaProvider') }}</v-card-title>
        <v-card-text><v-form id="media-provider-form" @submit.prevent="save"><v-alert v-if="editorError" type="error" role="alert" variant="tonal" class="mb-4">{{ editorError }}<v-btn v-if="conflict" :disabled="busy || loading" @click="reloadEditing">{{ tr('mediaReloadCurrent') }}</v-btn></v-alert>
          <div class="media-admin__grid">
            <v-text-field v-model="draft.displayName" :label="tr('displayName')" :error-messages="fieldError('displayName')" :disabled="busy" />
            <v-select v-model="draft.kind" :items="kindOptions" :label="tr('mediaOperation')" :disabled="busy" @update:model-value="selectKind" />
            <v-select v-model="draft.api" :items="apiOptions" :label="tr('mediaApi')" :disabled="busy" @update:model-value="selectApi" />
            <v-text-field v-model="draft.model" :label="tr('mediaExactModel')" :hint="tr('mediaExactModelHelp')" persistent-hint :error-messages="fieldError('config.model')" :disabled="busy" />
            <v-text-field v-model="draft.baseUrl" :label="tr('mediaOfficialBaseUrl')" :error-messages="fieldError('config.baseUrl')" :disabled="busy" />
            <v-text-field v-model.number="draft.timeoutMs" type="number" min="1000" max="300000" :label="tr('mediaTimeout')" :error-messages="fieldError('config.timeoutMs')" :disabled="busy" />
            <v-text-field v-model.number="draft.maxInputTokens" type="number" min="1" max="10000000" :label="tr('mediaInputCeiling')" :error-messages="fieldError('config.maxInputTokens')" :disabled="busy" />
            <v-text-field v-model.number="draft.maxOutputTokens" type="number" min="1" max="1000000" :label="tr('mediaOutputCeiling')" :error-messages="fieldError('config.maxOutputTokens')" :disabled="busy" />
            <v-select v-model="draft.pricingKind" :items="pricingOptions" :label="tr('mediaPricing')" :disabled="busy" />
            <v-text-field v-model="draft.pricingRevision" :label="tr('mediaPricingRevision')" :error-messages="fieldError('config.pricing')" :disabled="busy" />
            <template v-if="draft.pricingKind === 'tokens'"><v-text-field v-model.number="draft.inputRate" type="number" min="1" :label="tr('mediaInputRate')" :disabled="busy" /><v-text-field v-model.number="draft.outputRate" type="number" min="1" :label="tr('mediaOutputRate')" :disabled="busy" /><v-text-field v-if="draft.kind === 'video'" v-model.number="draft.textRate" type="number" min="1" :label="tr('mediaTextRate')" :disabled="busy" /></template>
            <v-text-field v-else v-model.number="draft.costMicros" type="number" min="1" :label="tr('mediaFixedCost')" :disabled="busy" />
            <v-select v-model="draft.secretMode" :items="secretOptions" :label="tr('mediaCredentialAction')" :disabled="busy" />
            <v-alert v-if="credentialOriginChanged" type="warning" variant="tonal" role="alert">{{ tr('mediaCredentialOriginChange') }}</v-alert>
            <v-text-field v-if="draft.secretMode === 'replace'" v-model="draft.secretValue" type="password" autocomplete="new-password" :label="tr('mediaEncryptedKey')" :hint="tr('mediaSecretHelp')" persistent-hint :error-messages="fieldError('secretValue')" :disabled="busy" />
            <v-text-field v-if="draft.secretMode === 'environment'" v-model="draft.secretReference" :label="tr('mediaEnvReference')" :hint="tr('mediaEnvHelp')" persistent-hint :error-messages="fieldError('secretReference')" :disabled="busy" />
            <v-select v-model="draft.exposureMode" :items="exposureOptions" :label="tr('available2')" :disabled="busy" />
            <v-autocomplete v-if="draft.exposureMode === 'groups'" v-model="draft.groupIds" :items="groups" item-title="name" item-value="id" multiple chips closable-chips :label="tr('wikiGroups')" :disabled="busy || groupsLoading || Boolean(groupsError)" :error-messages="fieldError('groupIds')" />
          </div>
          <v-alert v-if="draft.exposureMode === 'groups' && groupsError" type="error" role="alert">{{ groupsError }}<v-btn @click="$emit('refresh-groups')">{{ tr('retry') }}</v-btn></v-alert>
          <p>{{ tr('mediaNoPaidVerification') }}</p><p v-if="editing">{{ tr('mediaVersion', { version: editing.profileVersionId, revision: editing.revision }) }}</p>
          <v-alert v-if="submitted && !parsed.success" type="warning" role="alert">{{ tr('mediaInvalidSettings') }}</v-alert>
        </v-form></v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="busy" @click="closeEditor">{{ $t('common:actions.cancel') }}</v-btn><v-btn type="submit" form="media-provider-form" color="primary" :loading="busy" :disabled="busy || conflict || (credentialOriginChanged && draft.secretMode === 'retain') || (draft.exposureMode === 'groups' && (groupsLoading || Boolean(groupsError)))">{{ $t('common:actions.save') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog :model-value="Boolean(removing)" max-width="480" persistent aria-labelledby="media-remove-title"><v-card><v-card-title id="media-remove-title">{{ tr('mediaRemove') }}</v-card-title><v-card-text>{{ tr('mediaRemoveHelp', { name: removing?.displayName }) }}<v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert></v-card-text><v-card-actions><v-spacer /><v-btn :disabled="busy" @click="removing = null">{{ $t('common:actions.cancel') }}</v-btn><v-btn :loading="busy" color="error" @click="remove">{{ tr('mediaRemove') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="discardDialog" max-width="480" persistent aria-labelledby="media-discard-title"><v-card><v-card-title id="media-discard-title">{{ tr('discardProviderChanges') }}</v-card-title><v-card-text>{{ tr('mediaDiscardHelp') }}</v-card-text><v-card-actions><v-spacer /><v-btn @click="discardDialog = false">{{ tr('keepEditing') }}</v-btn><v-btn color="error" @click="discardDialog = false; dismissEditor()">{{ tr('discardChanges') }}</v-btn></v-card-actions></v-card></v-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { AgentMediaProviderWriteSchema, type AgentMediaApi, type AgentMediaKind, type AgentMediaProviderView, type AgentMediaProviderWrite } from '../../../shared/agents/media-providers.ts'
import { listMediaProviders, createMediaProvider, updateMediaProvider, enableMediaProvider, defaultMediaProvider, deleteMediaProvider } from '../../helpers/agent-control-api.ts'
import { AgentApiError } from '../../helpers/agents-api.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
const { csrfToken, groups, groupsLoading = false, groupsError = '' } = defineProps<{ csrfToken: string; groups: readonly { id: number; name: string }[]; groupsLoading?: boolean; groupsError?: string }>()
defineEmits<{ 'refresh-groups': [] }>()
const t = useTranslate()
const tr = (key: string, values?: Record<string, unknown>) => t(`admin:agentAdmin.${key}`, values)
const fetcher: typeof fetch = (...args) => window.fetch(...args)
const providers = shallowRef<AgentMediaProviderView[]>([]), editing = shallowRef<AgentMediaProviderView | null>(null), removing = shallowRef<AgentMediaProviderView | null>(null)
const loading = ref(false), loaded = ref(false), busy = ref(false), dialog = ref(false), submitted = ref(false), conflict = ref(false), discardDialog = ref(false)
const error = ref(''), editorError = ref(''), notice = ref(''), baseline = ref('')
let controller: AbortController | undefined
let disposed = false
const defaults = () => ({ displayName: '', kind: 'image' as AgentMediaKind, api: 'gemini-generate-content' as AgentMediaApi, model: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', timeoutMs: 120000, maxInputTokens: 32000, maxOutputTokens: 8192, pricingKind: 'tokens' as 'tokens' | 'fixed', pricingRevision: 'media-v1', inputRate: 0, outputRate: 0, textRate: 0, costMicros: 0, secretMode: 'retain', secretValue: '', secretReference: '', exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups', groupIds: [] as number[] })
const draft = reactive(defaults())
const kindOptions = computed(() => (['image', 'video', 'music', 'transcription'] as const).map(value => ({ value, title: tr(`mediaKind${value}`) })))
const supportedApis: Record<AgentMediaKind, readonly AgentMediaApi[]> = { image: ['gemini-generate-content', 'openai-images', 'stability-images'], video: ['gemini-interactions'], music: ['gemini-interactions'], transcription: ['gemini-generate-content'] }
const apiOptions = computed(() => supportedApis[draft.kind].map(value => ({ value, title: tr(`mediaApi${value}`) })))
const pricingOptions = computed(() => (draft.kind === 'video' ? ['tokens'] : draft.kind === 'music' || draft.api === 'stability-images' ? ['fixed'] : ['tokens', 'fixed']).map(value => ({ value, title: tr(`mediaPricing${value}`) })))
const secretOptions = computed(() => ['retain', 'replace', 'environment', 'clear'].map(value => ({ value, title: tr(`mediaSecret${value}`) })))
const exposureOptions = computed(() => [{ value: 'all_agent_users', title: tr('everyone') }, { value: 'groups', title: tr('selectedWikiGroups') }])
const payload = (): AgentMediaProviderWrite => ({ displayName: draft.displayName, config: { kind: draft.kind, api: draft.api, model: draft.model, baseUrl: draft.baseUrl, timeoutMs: draft.timeoutMs, maxInputTokens: draft.maxInputTokens, maxOutputTokens: draft.maxOutputTokens, pricing: draft.pricingKind === 'fixed' ? { kind: 'fixed', pricingRevision: draft.pricingRevision, costMicros: draft.costMicros } : { kind: 'tokens', pricingRevision: `${draft.pricingRevision}|${draft.inputRate}|${draft.outputRate}`, ...(draft.kind === 'video' ? { textOutputMicrosPerMillionTokens: draft.textRate } : {}) } }, exposureMode: draft.exposureMode, groupIds: draft.exposureMode === 'groups' ? draft.groupIds : [], ...(draft.secretMode === 'replace' ? { secretValue: draft.secretValue } : draft.secretMode === 'environment' ? { secretReference: draft.secretReference } : draft.secretMode === 'clear' ? { secretReference: null, secretValue: null } : {}) })
const parsed = computed(() => AgentMediaProviderWriteSchema.safeParse(payload()))
const credentialOriginChanged = computed(() => {
  const previous = editing.value
  return Boolean(previous?.secretConfigured && parsed.value.success && new URL(previous.config.baseUrl).origin !== new URL(parsed.value.data.config.baseUrl).origin)
})
const fieldError = (path: string): string[] => submitted.value && !parsed.value.success && parsed.value.error.issues.some(issue => issue.path.join('.').startsWith(path)) ? [tr(path === 'config.model' ? 'mediaModelInvalid' : 'mediaFieldInvalid')] : []
const groupNames = (ids: readonly number[]) => ids.map(id => groups.find(group => group.id === id)?.name ?? String(id)).join(', ')
const message = (value: unknown) => value instanceof AgentApiError && value.status === 409 ? tr('mediaStaleRevision') : value instanceof Error ? value.message : tr('mediaRequestFailed')
const load = async (): Promise<boolean> => {
  controller?.abort(); controller = new AbortController(); const current = controller
  loading.value = true; error.value = ''
  try { const result = await listMediaProviders(fetcher, csrfToken, current.signal); if (!disposed && controller === current) { providers.value = result; loaded.value = true }; return true }
  catch (value) { if (!current.signal.aborted && !disposed) error.value = message(value); return false }
  finally { if (controller === current) loading.value = false }
}
const selectApi = () => { draft.baseUrl = draft.api.startsWith('gemini-') ? 'https://generativelanguage.googleapis.com/v1beta' : draft.api === 'openai-images' ? 'https://api.openai.com/v1' : 'https://api.stability.ai/v2beta'; if (draft.kind === 'video') draft.pricingKind = 'tokens'; else if (draft.kind === 'music' || draft.api === 'stability-images') draft.pricingKind = 'fixed' }
const selectKind = () => { if (!supportedApis[draft.kind].includes(draft.api)) draft.api = supportedApis[draft.kind][0]!; selectApi() }
const open = (provider?: AgentMediaProviderView) => {
  editing.value = provider ?? null; Object.assign(draft, defaults())
  if (provider) { const { pricing, ...config } = provider.config; Object.assign(draft, config, { displayName: provider.displayName, exposureMode: provider.exposureMode, groupIds: [...provider.groupIds], pricingKind: pricing.kind, pricingRevision: pricing.pricingRevision.split('|')[0], ...(pricing.kind === 'fixed' ? { costMicros: pricing.costMicros } : { inputRate: Number(pricing.pricingRevision.split('|')[1]), outputRate: Number(pricing.pricingRevision.split('|')[2]), textRate: pricing.textOutputMicrosPerMillionTokens ?? 0 }) }) }
  submitted.value = false; conflict.value = false; editorError.value = ''; baseline.value = JSON.stringify(draft); dialog.value = true
}
const dismissEditor = () => { dialog.value = false; draft.secretValue = ''; draft.secretReference = '' }
const closeEditor = () => { if (JSON.stringify(draft) !== baseline.value) discardDialog.value = true; else dismissEditor() }
const reloadEditing = async () => { const id = editing.value?.id; if (!await load()) return; const current = providers.value.find(provider => provider.id === id); if (current) open(current); else editorError.value = tr('mediaProviderRemoved') }
const mutate = async (operation: () => Promise<unknown>): Promise<boolean> => {
  if (busy.value) return false
  busy.value = true; error.value = ''; notice.value = ''
  try { await operation(); notice.value = tr('mediaSaved'); await load(); return true }
  catch (value) { error.value = message(value); return false }
  finally { busy.value = false }
}
const save = async () => {
  if (busy.value || conflict.value) return
  submitted.value = true; if (!parsed.value.success) return
  if (credentialOriginChanged.value && draft.secretMode === 'retain') { editorError.value = tr('mediaCredentialOriginChange'); return }
  busy.value = true; editorError.value = ''
  try { const write = parsed.value.data; if (editing.value) await updateMediaProvider(fetcher, csrfToken, editing.value.id, write, editing.value.revision); else await createMediaProvider(fetcher, csrfToken, write); dismissEditor(); notice.value = tr('mediaSaved'); await load() }
  catch (value) { conflict.value = value instanceof AgentApiError && value.status === 409; editorError.value = message(value) }
  finally { busy.value = false }
}
const remove = async () => { const provider = removing.value; if (provider && await mutate(() => deleteMediaProvider(fetcher, csrfToken, provider.id, provider.revision))) removing.value = null }
onMounted(() => { void load() })
onBeforeUnmount(() => { disposed = true; controller?.abort(); draft.secretValue = '' })
</script>

<style scoped>
.media-admin { padding: var(--wiki-space-6, 1.5rem); }
.media-admin__header, .media-admin__provider { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.media-admin__header { margin-bottom: 1.5rem; }
.media-admin__provider { padding-block: 1.5rem; border-bottom: 1px solid var(--wiki-surface-border); }
.media-admin__provider p { margin-block: .5rem; overflow-wrap: anywhere; }
.media-admin__actions { display: flex; flex-wrap: wrap; align-content: start; gap: .5rem; }
.media-admin__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
@media (max-width: 600px) { .media-admin__grid { grid-template-columns: 1fr; } }
</style>
