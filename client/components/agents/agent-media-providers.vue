<template>
  <section class="media-admin" aria-labelledby="media-admin-title">
    <header class="media-admin__header"><div><h2 id="media-admin-title">{{ t('mediaProviders') }}</h2><p>{{ t('mediaIndependentHelp') }}</p></div><div><v-btn :loading="loading" :disabled="busy" @click="load">{{ t('refreshStatus') }}</v-btn><v-btn ref="headerAdd" color="primary" :disabled="busy" @click="open(undefined, $event)">{{ t('addMediaProvider') }}</v-btn></div></header>
    <v-alert type="info" variant="tonal">{{ t('mediaInteractionsMigration') }}</v-alert>
    <v-alert v-if="error" type="error" variant="tonal" role="alert" class="my-4">{{ error }}<v-btn :disabled="loading || busy" @click="load">{{ t('retry') }}</v-btn></v-alert>
    <p role="status" aria-live="polite">{{ busy ? t('mediaSaving') : notice }}</p>
    <v-progress-linear v-if="loading" indeterminate :aria-label="t('loading')" />
    <div v-if="loaded && !providers.length" class="media-admin__empty">
      <span class="media-admin__empty-icon"><v-icon icon="mdi-image-multiple-outline" size="34" aria-hidden="true" /></span>
      <h3>{{ t('mediaEmptyTitle') }}</h3>
      <p>{{ t('mediaEmpty') }}</p>
      <v-btn color="primary" prepend-icon="mdi-plus" :disabled="busy" @click="open(undefined, $event)">{{ t('addMediaProvider') }}</v-btn>
    </div>
    <article v-for="provider in providers" :key="provider.id" class="media-admin__provider">
      <div><h3>{{ provider.displayName }}</h3><p>{{ t(`mediaKind${provider.config.kind}`) }} · <code>{{ provider.config.api }}</code> · <code>{{ provider.config.model }}</code></p><p><code>{{ provider.config.baseUrl }}</code></p><p>{{ provider.enabled ? t('enabled') : t('disabled') }} · {{ provider.secretConfigured ? t('mediaCredentialConfigured') : t('mediaCredentialMissing') }}<span v-if="provider.isDefault"> · {{ t('mediaOperationDefault') }}</span></p><p>{{ provider.exposureMode === 'all_agent_users' ? t('everyone') : groupNames(provider.groupIds) }}</p></div>
      <div class="media-admin__actions"><v-btn :disabled="busy" :aria-label="t('mediaEditNamed', { name: provider.displayName })" @click="open(provider, $event)">{{ t('mediaEdit') }}</v-btn><v-btn :disabled="busy || (!provider.enabled && !provider.secretConfigured)" @click="mutate(() => enableMediaProvider(fetcher, csrfToken, provider.id, provider.revision, !provider.enabled))">{{ provider.enabled ? t('mediaDisable') : t('mediaEnable') }}</v-btn><v-btn :disabled="busy || !provider.enabled || !provider.secretConfigured || provider.isDefault" @click="mutate(() => defaultMediaProvider(fetcher, csrfToken, provider.id, provider.revision))">{{ t('mediaSetDefault') }}</v-btn><v-btn color="error" :disabled="busy" @click="removing = provider">{{ t('mediaRemove') }}</v-btn></div>
    </article>
    <v-dialog :model-value="dialog" max-width="850" scrollable :persistent="busy" aria-labelledby="media-editor-title" @update:model-value="value => { if (!value) closeEditor() }" @after-leave="editorAfterLeave">
      <v-card><v-card-title id="media-editor-title">{{ editing ? t('editMediaProvider') : t('addMediaProvider') }}</v-card-title>
        <v-card-text><v-form id="media-provider-form" @submit.prevent="save"><v-alert v-if="editorError" type="error" role="alert" variant="tonal" class="mb-4">{{ editorError }}<v-btn v-if="conflict" :disabled="busy || loading" @click="reloadEditing">{{ t('mediaReloadCurrent') }}</v-btn></v-alert>
          <div class="media-admin__grid">
            <v-text-field v-model="draft.displayName" :label="t('displayName')" :error-messages="fieldError('displayName')" :disabled="busy" />
            <v-select v-model="draft.kind" :items="kindOptions" :label="t('mediaOperation')" :disabled="busy" @update:model-value="selectKind" />
            <v-select v-model="draft.api" :items="apiOptions" :label="t('mediaApi')" :disabled="busy" @update:model-value="selectApi" />
            <v-text-field v-model="draft.model" :label="t('mediaExactModel')" :hint="t(draft.model ? 'mediaExactModelHelp' : 'mediaModelInvalid')" persistent-hint :error-messages="fieldError('config.model')" :disabled="busy" />
            <v-text-field v-model="draft.baseUrl" :label="t('mediaOfficialBaseUrl')" :error-messages="fieldError('config.baseUrl')" :disabled="busy" />
            <v-text-field v-model.number="draft.timeoutMs" type="number" min="1000" max="300000" :label="t('mediaTimeout')" :error-messages="fieldError('config.timeoutMs')" :disabled="busy" />
            <v-text-field v-model.number="draft.maxInputTokens" type="number" min="1" max="10000000" :label="t('mediaInputCeiling')" :hint="t('mediaInputCeilingHint')" persistent-hint :error-messages="fieldError('config.maxInputTokens')" :disabled="busy" />
            <v-text-field v-model.number="draft.maxOutputTokens" type="number" min="1" max="1000000" :label="t('mediaOutputCeiling')" :error-messages="fieldError('config.maxOutputTokens')" :disabled="busy" />
            <v-select v-model="draft.pricingKind" :items="pricingOptions" :label="t('mediaPricing')" :disabled="busy" />
            <v-text-field v-model="draft.pricingRevision" :label="t('mediaPricingRevision')" :error-messages="fieldError('config.pricing')" :disabled="busy" />
            <template v-if="draft.pricingKind === 'tokens'"><v-text-field v-model.number="draft.inputRate" type="number" min="1" :label="t('mediaInputRate')" :disabled="busy" /><v-text-field v-model.number="draft.outputRate" type="number" min="1" :label="t('mediaOutputRate')" :disabled="busy" /><v-text-field v-if="draft.kind === 'video'" v-model.number="draft.textRate" type="number" min="1" :label="t('mediaTextRate')" :disabled="busy" /></template>
            <v-text-field v-else v-model.number="draft.costMicros" type="number" min="1" :label="t('mediaFixedCost')" :disabled="busy" />
            <v-select v-model="draft.secretMode" :items="secretOptions" :label="t('mediaCredentialAction')" :disabled="busy" />
            <v-alert v-if="credentialOriginChanged" type="warning" variant="tonal" role="alert">{{ t('mediaCredentialOriginChange') }}</v-alert>
            <v-text-field v-if="draft.secretMode === 'replace'" v-model="draft.secretValue" type="password" autocomplete="new-password" :label="t('mediaEncryptedKey')" :hint="t('mediaSecretHelp')" persistent-hint :error-messages="fieldError('secretValue')" :disabled="busy" />
            <v-text-field v-if="draft.secretMode === 'environment'" v-model="draft.secretReference" :label="t('mediaEnvReference')" :hint="t('mediaEnvHelp')" persistent-hint :error-messages="fieldError('secretReference')" :disabled="busy" />
            <v-select v-model="draft.exposureMode" :items="exposureOptions" :label="t('available2')" :disabled="busy" />
            <v-autocomplete v-if="draft.exposureMode === 'groups'" v-model="draft.groupIds" :items="groups" item-title="name" item-value="id" multiple chips closable-chips :label="t('wikiGroups')" :disabled="busy || groupsLoading || Boolean(groupsError)" :error-messages="fieldError('groupIds')" />
          </div>
          <v-alert v-if="draft.exposureMode === 'groups' && groupsError" type="error" role="alert">{{ groupsError }}<v-btn @click="$emit('refresh-groups')">{{ t('retry') }}</v-btn></v-alert>
          <p>{{ t('mediaNoPaidVerification') }}</p><p v-if="editing">{{ t('mediaVersion', { version: editing.profileVersionId, revision: editing.revision }) }}</p>
          <v-alert v-if="submitted && !parsed.success" type="warning" role="alert">{{ t('mediaInvalidSettings') }}</v-alert>
        </v-form></v-card-text>
        <v-card-actions><v-spacer /><v-btn ref="editorCancel" :disabled="busy" @click="closeEditor">{{ $t('common:actions.cancel') }}</v-btn><v-btn type="submit" form="media-provider-form" color="primary" :loading="busy" :disabled="busy || conflict || (credentialOriginChanged && draft.secretMode === 'retain') || (draft.exposureMode === 'groups' && (groupsLoading || Boolean(groupsError)))">{{ $t('common:actions.save') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog :model-value="Boolean(removing)" max-width="480" persistent aria-labelledby="media-remove-title"><v-card><v-card-title id="media-remove-title">{{ t('mediaRemove') }}</v-card-title><v-card-text>{{ t('mediaRemoveHelp', { name: removing?.displayName }) }}<v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert></v-card-text><v-card-actions><v-spacer /><v-btn :disabled="busy" @click="removing = null">{{ $t('common:actions.cancel') }}</v-btn><v-btn :loading="busy" color="error" @click="remove">{{ t('mediaRemove') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog :model-value="discardDialog" max-width="480" :persistent="busy" aria-labelledby="media-discard-title" @update:model-value="value => { if (!value && !busy) discardDialog = false }" @after-leave="discardAfterLeave"><v-card><v-card-title id="media-discard-title">{{ t('discardProviderChanges') }}</v-card-title><v-card-text>{{ t('mediaDiscardHelp') }}</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="busy" @click="discardDialog = false">{{ t('keepEditing') }}</v-btn><v-btn color="error" :disabled="busy" @click="discardChanges">{{ t('discardChanges') }}</v-btn></v-card-actions></v-card></v-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { AgentMediaProviderConfigSchema, AgentMediaProviderWriteSchema, type AgentMediaApi, type AgentMediaKind, type AgentMediaProviderView, type AgentMediaProviderWrite } from '../../../shared/agents/media-providers.ts'
import { listMediaProviders, createMediaProvider, updateMediaProvider, enableMediaProvider, defaultMediaProvider, deleteMediaProvider } from '../../helpers/agent-control-api.ts'
import { AgentApiError } from '../../helpers/agents-api.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
const { csrfToken, groups, groupsLoading = false, groupsError = '' } = defineProps<{ csrfToken: string; groups: readonly { id: number; name: string }[]; groupsLoading?: boolean; groupsError?: string }>()
defineEmits<{ 'refresh-groups': [] }>()
const t = useTranslate('admin:agentAdmin')
const fetcher: typeof fetch = (...args) => window.fetch(...args)
const providers = shallowRef<AgentMediaProviderView[]>([]), editing = shallowRef<AgentMediaProviderView | null>(null), removing = shallowRef<AgentMediaProviderView | null>(null)
const loading = ref(false), loaded = ref(false), busy = ref(false), dialog = ref(false), submitted = ref(false), conflict = ref(false), discardDialog = ref(false)
const error = ref(''), editorError = ref(''), notice = ref(''), baseline = ref('')
const headerAdd = ref<{ $el: HTMLElement } | null>(null), editorCancel = ref<{ $el: HTMLElement } | null>(null)
let editorOpener: HTMLElement | null = null
let editorFocusPending = false, editorHasLeft = false
let controller: AbortController | undefined
let disposed = false
const defaults = () => ({ displayName: '', kind: 'image' as AgentMediaKind, api: 'gemini-generate-content' as AgentMediaApi, model: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', timeoutMs: 120000, maxInputTokens: 32000, maxOutputTokens: 8192, pricingKind: 'tokens' as 'tokens' | 'fixed', pricingRevision: 'media-v1', inputRate: 0, outputRate: 0, textRate: 0, costMicros: 0, secretMode: 'retain', secretValue: '', secretReference: '', exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups', groupIds: [] as number[] })
const draft = reactive(defaults())
const kindOptions = computed(() => (['image', 'video', 'music', 'transcription'] as const).map(value => ({ value, title: t(`mediaKind${value}`) })))
const supportedApis: Record<AgentMediaKind, readonly AgentMediaApi[]> = { image: ['gemini-generate-content', 'openai-images', 'stability-images'], video: ['gemini-interactions'], music: ['gemini-interactions'], transcription: ['gemini-generate-content'] }
const apiOptions = computed(() => supportedApis[draft.kind].map(value => ({ value, title: t(`mediaApi${value}`) })))
const pricingOptions = computed(() => (draft.kind === 'video' ? ['tokens'] : draft.kind === 'music' || draft.api === 'stability-images' ? ['fixed'] : ['tokens', 'fixed']).map(value => ({ value, title: t(`mediaPricing${value}`) })))
const secretOptions = computed(() => ['retain', 'replace', 'environment', 'clear'].map(value => ({ value, title: t(`mediaSecret${value}`) })))
const exposureOptions = computed(() => [{ value: 'all_agent_users', title: t('everyone') }, { value: 'groups', title: t('selectedWikiGroups') }])
const payload = (): AgentMediaProviderWrite => ({ displayName: draft.displayName, config: { kind: draft.kind, api: draft.api, model: draft.model, baseUrl: draft.baseUrl, timeoutMs: draft.timeoutMs, maxInputTokens: draft.maxInputTokens, maxOutputTokens: draft.maxOutputTokens, pricing: draft.pricingKind === 'fixed' ? { kind: 'fixed', pricingRevision: draft.pricingRevision, costMicros: draft.costMicros } : { kind: 'tokens', pricingRevision: `${draft.pricingRevision}|${draft.inputRate}|${draft.outputRate}`, ...(draft.kind === 'video' ? { textOutputMicrosPerMillionTokens: draft.textRate } : {}) } }, exposureMode: draft.exposureMode, groupIds: draft.exposureMode === 'groups' ? draft.groupIds : [], ...(draft.secretMode === 'replace' ? { secretValue: draft.secretValue } : draft.secretMode === 'environment' ? { secretReference: draft.secretReference } : draft.secretMode === 'clear' ? { secretReference: null, secretValue: null } : {}) })
const parsed = computed(() => AgentMediaProviderWriteSchema.safeParse(payload()))
const credentialOriginChanged = computed(() => {
  const previous = editing.value
  return Boolean(previous?.secretConfigured && parsed.value.success && new URL(previous.config.baseUrl).origin !== new URL(parsed.value.data.config.baseUrl).origin)
})
const fieldError = (path: string): string[] => submitted.value && !parsed.value.success && parsed.value.error.issues.some(issue => issue.path.join('.').startsWith(path)) ? [t(path === 'config.model' ? 'mediaModelInvalid' : path === 'config.maxInputTokens' ? 'mediaInputCeilingHint' : 'mediaFieldInvalid')] : []
const groupNames = (ids: readonly number[]) => ids.map(id => groups.find(group => group.id === id)?.name ?? String(id)).join(', ')
const isStaleRevision = (value: unknown): value is AgentApiError => value instanceof AgentApiError && value.status === 409 && value.code === 'MEDIA_PROVIDER_REVISION_CHANGED'
const message = (value: unknown) => isStaleRevision(value) ? t('mediaStaleRevision') : value instanceof Error ? value.message : t('mediaRequestFailed')
const load = async (): Promise<boolean> => {
  controller?.abort(); controller = new AbortController(); const current = controller
  loading.value = true; error.value = ''
  try { const result = await listMediaProviders(fetcher, csrfToken, current.signal); if (!disposed && controller === current) { providers.value = result; loaded.value = true }; return true }
  catch (value) { if (!current.signal.aborted && !disposed) error.value = message(value); return false }
  finally { if (controller === current) loading.value = false }
}
const selectApi = () => {
  draft.baseUrl = draft.api.startsWith('gemini-') ? 'https://generativelanguage.googleapis.com/v1beta' : draft.api === 'openai-images' ? 'https://api.openai.com/v1' : 'https://api.stability.ai/v2beta'
  if (draft.kind === 'video') draft.pricingKind = 'tokens'
  else if (draft.kind === 'music' || draft.api === 'stability-images') draft.pricingKind = 'fixed'
  if (!draft.model) return
  // Validate model compatibility independently of incomplete pricing or numeric drafts.
  const modelValidation = AgentMediaProviderConfigSchema.safeParse({
    kind: draft.kind, api: draft.api, model: draft.model, baseUrl: draft.baseUrl,
    timeoutMs: 120000, maxInputTokens: 32000, maxOutputTokens: 8192,
    pricing: { kind: 'fixed', pricingRevision: 'media-v1', costMicros: 1 }
  })
  if (!modelValidation.success && modelValidation.error.issues.some(issue => issue.path[0] === 'model')) draft.model = ''
}
const selectKind = () => { if (!supportedApis[draft.kind].includes(draft.api)) draft.api = supportedApis[draft.kind][0]!; selectApi() }
const open = (provider?: AgentMediaProviderView, event?: Event) => {
  if (busy.value || disposed) return
  if (event) editorOpener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  editorFocusPending = false; editorHasLeft = false; discardDialog.value = false
  editing.value = provider ?? null; Object.assign(draft, defaults())
  if (provider) { const { pricing, ...config } = provider.config; Object.assign(draft, config, { displayName: provider.displayName, exposureMode: provider.exposureMode, groupIds: [...provider.groupIds], pricingKind: pricing.kind, pricingRevision: pricing.pricingRevision.split('|')[0], ...(pricing.kind === 'fixed' ? { costMicros: pricing.costMicros } : { inputRate: Number(pricing.pricingRevision.split('|')[1]), outputRate: Number(pricing.pricingRevision.split('|')[2]), textRate: pricing.textOutputMicrosPerMillionTokens ?? 0 }) }) }
  submitted.value = false; conflict.value = false; editorError.value = ''; baseline.value = JSON.stringify(draft); dialog.value = true
}
const restoreEditorFocus = async () => {
  await nextTick()
  if (disposed || dialog.value || busy.value || !editorFocusPending || !editorHasLeft) return
  const target = editorOpener?.isConnected && !editorOpener.matches(':disabled, [aria-disabled="true"]') ? editorOpener : headerAdd.value?.$el
  editorFocusPending = false; editorOpener = null
  if (target?.isConnected && !target.matches(':disabled, [aria-disabled="true"]')) target.focus()
}
const editorAfterLeave = () => {
  if (dialog.value || disposed) return
  editorHasLeft = true
  void restoreEditorFocus()
}
const discardAfterLeave = async () => {
  await nextTick()
  if (!disposed && dialog.value && !discardDialog.value && !busy.value) editorCancel.value?.$el.focus()
}
const dismissEditor = () => {
  editorFocusPending = true; editorHasLeft = false; dialog.value = false
  draft.secretValue = ''; draft.secretReference = ''
}
const closeEditor = () => {
  if (busy.value) return
  if (JSON.stringify(draft) !== baseline.value) discardDialog.value = true
  else dismissEditor()
}
const discardChanges = () => {
  if (busy.value) return
  discardDialog.value = false
  dismissEditor()
}
const reloadEditing = async () => { const id = editing.value?.id; if (!await load()) return; const current = providers.value.find(provider => provider.id === id); if (current) open(current); else editorError.value = t('mediaProviderRemoved') }
const mutate = async (operation: () => Promise<unknown>): Promise<boolean> => {
  if (busy.value) return false
  busy.value = true; error.value = ''; notice.value = ''
  try { await operation(); notice.value = t('mediaSaved'); await load(); return true }
  catch (value) { error.value = message(value); return false }
  finally { busy.value = false }
}
const save = async () => {
  if (busy.value || conflict.value) return
  submitted.value = true; if (!parsed.value.success) return
  if (credentialOriginChanged.value && draft.secretMode === 'retain') { editorError.value = t('mediaCredentialOriginChange'); return }
  busy.value = true; editorError.value = ''
  try { const write = parsed.value.data; if (editing.value) await updateMediaProvider(fetcher, csrfToken, editing.value.id, write, editing.value.revision); else await createMediaProvider(fetcher, csrfToken, write); dismissEditor(); notice.value = t('mediaSaved'); await load() }
  catch (value) { conflict.value = isStaleRevision(value); editorError.value = message(value) }
  finally { busy.value = false; void restoreEditorFocus() }
}
const remove = async () => { const provider = removing.value; if (provider && await mutate(() => deleteMediaProvider(fetcher, csrfToken, provider.id, provider.revision))) removing.value = null }
onMounted(() => { void load() })
onBeforeUnmount(() => { disposed = true; controller?.abort(); editorFocusPending = false; editorHasLeft = false; editorOpener = null; draft.secretValue = ''; draft.secretReference = '' })
</script>

<style scoped>
.media-admin { padding: var(--wiki-space-6, 1.5rem); }
.media-admin__header, .media-admin__provider { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.media-admin__header { margin-bottom: 1.5rem; }
.media-admin__empty { display: grid; min-height: calc(var(--wiki-space-12) * 7); place-items: center; align-content: center; padding: var(--wiki-space-12) var(--wiki-space-6); border: 1px dashed var(--wiki-surface-border-strong); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-sunken); text-align: center; }
.media-admin__empty-icon { display: grid; place-items: center; width: calc(var(--wiki-space-12) + var(--wiki-space-6)); height: calc(var(--wiki-space-12) + var(--wiki-space-6)); margin-block-end: var(--wiki-space-4); border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 18%, transparent); border-radius: var(--wiki-panel-radius); background: color-mix(in srgb, var(--wiki-accent-warm) 9%, var(--wiki-surface-raised)); color: var(--wiki-accent-ink); box-shadow: var(--wiki-shadow-inset); }
.media-admin__empty h3 { margin: 0; font-family: var(--wiki-font-display); }
.media-admin__empty p { max-width: 34rem; margin: var(--wiki-space-2) auto var(--wiki-space-4); color: var(--wiki-text-muted); }
.media-admin__provider { padding-block: 1.5rem; border-bottom: 1px solid var(--wiki-surface-border); }
.media-admin__provider p { margin-block: .5rem; overflow-wrap: anywhere; }
.media-admin__actions { display: flex; flex-wrap: wrap; align-content: start; gap: .5rem; }
.media-admin__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
@media (max-width: 600px) { .media-admin__grid { grid-template-columns: 1fr; } }
</style>
