<template>
  <section class="control-panel" aria-labelledby="mcp-admin-title">
    <header>
      <div><h2 id="mcp-admin-title">{{ tr('title') }}</h2><p>{{ tr('description') }}</p></div>
      <div class="actions">
        <v-btn variant="text" :loading="loading" :disabled="busy || loading" @click="refresh">{{ tr('refresh') }}</v-btn>
        <v-btn color="primary" :disabled="busy || loading || denied || !loaded" @click="open()">{{ tr('addEndpoint') }}</v-btn>
      </div>
    </header>
    <v-alert type="warning" variant="tonal">{{ tr('untrustedWarning') }}</v-alert>
    <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="primary" :aria-label="tr('loading')" />
    <v-alert v-if="groupsLoading" type="info" variant="tonal" role="status">{{ tr('groupsLoading') }}</v-alert>
    <v-alert v-else-if="groupsError" type="warning" variant="tonal" role="alert">{{ tr('groupsUnavailable', { error: groupsError }) }}</v-alert>
    <p v-if="loaded && !servers.length">{{ tr('noEndpoints') }}</p>
    <article v-for="s in servers" :key="s.id" class="entry">
      <h3>{{ s.displayName }} <v-chip size="small">{{ t(`admin:agentAdmin.${s.status}`) }}</v-chip></h3>
      <p>{{ tr('endpointMetadata', { url: s.endpointUrl, namespace: s.namespace, revision: s.revision }) }}</p>
      <p>{{ tr(s.authMode === 'none' ? 'credentialNotRequired' : s.secretConfigured ? 'credentialConfigured' : 'credentialMissing') }}</p>
      <p>{{ tr('grantedGroups', { groups: groupNames(s.groupIds) }) }}</p>
      <div v-if="s.status !== 'enabled' || (s.authMode === 'bearer' && !s.secretConfigured) || !s.groupIds.length">
        <p>{{ tr('incompleteSetup') }}</p>
        <ul>
          <li v-if="s.status !== 'enabled'">{{ tr('endpointDisabled') }}</li>
          <li v-if="s.authMode === 'bearer' && !s.secretConfigured">{{ tr('bearerMissing') }}</li>
          <li v-if="!s.groupIds.length">{{ tr('noAuthorizedGroups') }}</li>
        </ul>
      </div>
      <p v-if="catalogRevisions[s.id]">{{ tr('catalogRevision', { revision: catalogRevisions[s.id] }) }}</p>
      <div class="actions">
        <v-btn v-for="action in serverActions" :key="action.key" :variant="action.variant" :color="action.color" :disabled="busy || loading || denied || (action.key === 'groupGrants' && groupsLocked) || (action.requiresEnabled && (s.status !== 'enabled' || (s.authMode === 'bearer' && !s.secretConfigured)))" @click="action.run(s)">{{ action.key === 'delete' ? t('common:actions.delete') : tr(action.key) }}</v-btn>
      </div>
    </article>
    <section class="entry">
      <h3>{{ tr('personalPolicy') }}</h3>
      <p>{{ tr('personalPolicyHelp') }}</p>
      <p v-if="!policies.length && loaded && !groupsLocked">{{ tr('noGroups') }} <router-link to="/a/groups">{{ tr('manageGroups') }}</router-link> {{ tr('refreshAfterGroups') }}</p>
      <div v-for="p in policies" :key="p.groupId" class="policy">
        <span>{{ tr(p.allowPersonalEndpoints ? 'policyAllowed' : 'policyDenied', { group: groupName(p.groupId), revision: p.revision }) }}</span>
        <v-btn variant="text" :disabled="busy || loading || denied || groupsLocked" @click="policyConfirm = p">{{ tr(p.allowPersonalEndpoints ? 'denyCreation' : 'allowCreation') }}</v-btn>
      </div>
    </section>
    <v-dialog :model-value="dialog" max-width="680" scrollable :persistent="busy" aria-labelledby="mcp-editor-title" @update:model-value="close">
      <v-card>
        <v-card-title id="mcp-editor-title" class="dialog-title">{{ tr(editing ? 'editEndpoint' : 'addEndpoint') }}</v-card-title>
        <v-card-text>
          <v-alert v-if="formError" type="error" variant="tonal" role="alert">{{ formError }}</v-alert>
          <v-alert v-if="editingStale" type="warning" variant="tonal">{{ tr('editingStale') }}</v-alert>
          <v-form id="mcp-endpoint-form" @submit.prevent="save">
            <v-text-field v-for="field in textFields" :key="field.key" v-model="draft[field.key]" :label="tr(field.key)" :autofocus="field.autofocus" :disabled="busy || denied" :error-messages="fieldError(field.key)" />
            <v-select v-model="draft.status" :label="tr('status')" :items="statusOptions" :disabled="busy || denied" :error-messages="fieldError('status')" />
            <v-select v-model="draft.authMode" :label="tr('authentication')" :items="authOptions" :disabled="busy || denied" :error-messages="fieldError('authMode')" />
            <v-text-field v-if="draft.authMode === 'bearer'" v-model="draft.secret" type="password" autocomplete="new-password" :label="tr('newCredential')" :disabled="busy || denied || draft.clearSecret" :error-messages="fieldError('secretValue')" />
            <v-checkbox v-if="draft.authMode === 'bearer'" v-model="draft.clearSecret" :label="tr('clearCredential')" :disabled="busy || denied" />
            <template v-if="!editing">
              <v-select v-model="draft.groupIds" :items="groups" item-title="name" item-value="id" multiple chips :label="tr('creationGrants')" :disabled="busy || denied || groupsLocked" />
              <v-alert v-if="groupsLoading" type="info" variant="tonal" role="status">{{ tr('groupsLoading') }}</v-alert>
              <v-alert v-else-if="groupsError" type="warning" variant="tonal" role="alert">{{ tr('groupsUnavailable', { error: groupsError }) }}</v-alert>
              <p v-else-if="!groups.length">{{ tr('noGroupOptions') }}</p>
            </template>
          </v-form>
        </v-card-text>
        <v-card-actions class="dialog-actions">
          <v-btn :disabled="busy" @click="close(false)">{{ t('common:actions.cancel') }}</v-btn><v-spacer />
          <v-btn type="submit" form="mcp-endpoint-form" color="primary" :loading="busy" :disabled="denied || loading || editingStale || (!editing && draft.groupIds.length > 0 && groupsLocked) || JSON.stringify(draft) === baseline">{{ tr('saveEndpoint') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="discard" max-width="440" aria-labelledby="mcp-discard-title">
      <v-card><v-card-title id="mcp-discard-title" class="dialog-title">{{ tr('discardEndpoint') }}</v-card-title><v-card-actions class="dialog-actions">
        <v-btn @click="discard = false">{{ t('common:confirm.keepEditing') }}</v-btn>
        <v-btn color="error" @click="discard = false; dialog = false; draft.secret = ''">{{ t('common:actions.discard') }}</v-btn>
      </v-card-actions></v-card>
    </v-dialog>
    <v-dialog :model-value="Boolean(grants)" max-width="600" scrollable :persistent="busy" aria-labelledby="mcp-grants-title" @update:model-value="closeGrants">
      <v-card><v-card-title id="mcp-grants-title" class="dialog-title">{{ tr('authorizeGroups') }}</v-card-title><v-card-text>
        <p>{{ tr('grantsWarning') }}</p>
        <v-alert v-if="grantsStale" type="warning" variant="tonal">{{ tr('grantsStale') }}</v-alert>
        <v-alert v-if="groupsLoading" type="info" variant="tonal" role="status">{{ tr('groupsLoading') }}</v-alert>
        <v-alert v-else-if="groupsError" type="warning" variant="tonal" role="alert">{{ tr('groupsUnavailable', { error: groupsError }) }}</v-alert>
        <v-select v-model="grantIds" :items="groups" item-title="name" item-value="id" multiple chips :label="tr('groupGrants')" :disabled="busy || denied || groupsLocked" />
      </v-card-text><v-card-actions class="dialog-actions">
        <v-btn :disabled="busy" @click="closeGrants(false)">{{ t('common:actions.cancel') }}</v-btn>
        <v-btn color="primary" :loading="busy" :disabled="denied || loading || grantsStale || !grantsDirty || groupsLocked" @click="saveGrants">{{ tr('saveGrants') }}</v-btn>
      </v-card-actions></v-card>
    </v-dialog>
    <v-dialog v-model="grantDiscard" max-width="440" aria-labelledby="mcp-grant-discard-title">
      <v-card><v-card-title id="mcp-grant-discard-title" class="dialog-title">{{ tr('discardGrants') }}</v-card-title><v-card-actions class="dialog-actions">
        <v-btn @click="grantDiscard = false">{{ t('common:confirm.keepEditing') }}</v-btn>
        <v-btn color="error" @click="grantDiscard = false; grants = null">{{ t('common:actions.discard') }}</v-btn>
      </v-card-actions></v-card>
    </v-dialog>
    <v-dialog :model-value="Boolean(policyConfirm)" max-width="540" :persistent="busy" aria-labelledby="mcp-policy-title" @update:model-value="value => { if (!value && !busy) policyConfirm = null }">
      <v-card><v-card-title id="mcp-policy-title" class="dialog-title">{{ tr('changePolicy') }}</v-card-title><v-card-text>
        <p>{{ tr(policyConfirm?.allowPersonalEndpoints ? 'confirmDeny' : 'confirmAllow', { group: policyConfirm ? groupName(policyConfirm.groupId) : '' }) }}</p>
        <v-alert v-if="groupsLoading" type="info" variant="tonal" role="status">{{ tr('groupsLoading') }}</v-alert>
        <v-alert v-else-if="groupsError" type="warning" variant="tonal" role="alert">{{ tr('groupsUnavailable', { error: groupsError }) }}</v-alert>
      </v-card-text><v-card-actions class="dialog-actions">
        <v-btn :disabled="busy" @click="policyConfirm = null">{{ t('common:actions.cancel') }}</v-btn>
        <v-btn color="primary" :loading="busy" :disabled="denied || loading || groupsLocked" @click="savePolicy">{{ tr('confirmPolicy') }}</v-btn>
      </v-card-actions></v-card>
    </v-dialog>
    <v-dialog :model-value="Boolean(remove)" max-width="440" :persistent="busy" aria-labelledby="mcp-remove-title" @update:model-value="value => { if (!value && !busy) remove = null }">
      <v-card><v-card-title id="mcp-remove-title" class="dialog-title">{{ tr('deleteEndpoint') }}</v-card-title><v-card-text>{{ tr('deleteEndpointHelp', { name: remove?.displayName }) }}</v-card-text><v-card-actions class="dialog-actions">
        <v-btn :disabled="busy" @click="remove = null">{{ t('common:actions.cancel') }}</v-btn>
        <v-btn color="error" :loading="busy" :disabled="denied || loading" @click="removeServer">{{ t('common:actions.delete') }}</v-btn>
      </v-card-actions></v-card>
    </v-dialog>
    <v-dialog :model-value="Boolean(discovery)" max-width="760" scrollable aria-labelledby="mcp-catalog-title" @update:model-value="value => { if (!value) discovery = null }">
      <v-card><v-card-title id="mcp-catalog-title" class="dialog-title">{{ tr('catalogTitle') }}</v-card-title><v-card-text v-if="discovery" class="catalog">
        <p>{{ tr('catalogMetadata', { name: discovery.attribution.displayName, host: discovery.attribution.destinationHost, revision: discovery.catalog.revision }) }}</p>
        <p>{{ tr('catalogWarning') }}</p>
        <h3>{{ tr('tools') }}</h3><p v-if="!discovery.catalog.tools.length">{{ tr('noTools') }}</p>
        <p v-for="tool in discovery.catalog.tools" :key="tool.name"><strong>{{ tool.name }}</strong> — {{ tool.description || tr('noDescription') }}</p>
        <h3>{{ tr('prompts') }}</h3><p v-for="prompt in discovery.catalog.prompts" :key="prompt.name">{{ prompt.name }} — {{ prompt.description }}</p>
        <h3>{{ tr('resources') }}</h3><p v-for="resource in discovery.catalog.resources" :key="resource.uri">{{ resource.name }} · {{ resource.uri }}</p>
        <h3>{{ tr('resourceTemplates') }}</h3><p v-for="resource in discovery.catalog.resourceTemplates" :key="resource.uriTemplate">{{ resource.name }} · {{ resource.uriTemplate }}</p>
      </v-card-text><v-card-actions class="dialog-actions"><v-btn @click="discovery = null">{{ t('common:actions.close') }}</v-btn></v-card-actions></v-card>
    </v-dialog>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ZodError } from 'zod'
import { AgentApiError } from '../../helpers/agents-api.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
import { ExternalMcpServerInputSchema } from '../../../shared/agents/external-mcp.ts'
import { listAdminExternalMcp,createAdminExternalMcp,updateAdminExternalMcp,deleteAdminExternalMcp,setExternalMcpGrants,listExternalMcpGroupPolicies,setExternalMcpGroupPolicy,discoverExternalMcp,type ExternalMcpServerView,type ExternalMcpGroupPolicyView,type ExternalMcpDiscovery } from '../../helpers/agent-control-api.ts'

const { csrfToken, groups, refreshKey = 0, groupsLoading = false, groupsError = '' } = defineProps<{ csrfToken: string; groups: readonly { id: number; name: string }[]; refreshKey?: number; groupsLoading?: boolean; groupsError?: string }>()
const emit = defineEmits<{ 'refresh-groups': []; state: [value: { servers: ExternalMcpServerView[]; policies: ExternalMcpGroupPolicyView[] } | null] }>()
const t = useTranslate()
const tr = (key: string, values?: Record<string, unknown>) => t(`admin:agentMcpAdmin.${key}`, values)
const fetcher: typeof fetch = (...args) => window.fetch(...args)
const servers=ref<ExternalMcpServerView[]>([]),policies=ref<ExternalMcpGroupPolicyView[]>([]),loading=ref(false),loaded=ref(false),busy=ref(false),denied=ref(false),error=ref(''),formError=ref(''),dialog=ref(false),discard=ref(false),baseline=ref(''),editing=ref<ExternalMcpServerView|null>(null),remove=ref<ExternalMcpServerView|null>(null),grants=ref<ExternalMcpServerView|null>(null),grantIds=ref<number[]>([]),policyConfirm=ref<ExternalMcpGroupPolicyView|null>(null),discovery=ref<ExternalMcpDiscovery|null>(null)
const draft = reactive({ displayName: '', endpointUrl: '', status: 'disabled' as 'enabled' | 'disabled', authMode: 'none' as 'none' | 'bearer', secret: '', clearSecret: false, groupIds: [] as number[] })
const submitted = ref(false)
const grantDiscard = ref(false)
const catalogRevisions = reactive<Record<string, number>>({})
const editingStale = computed(() => Boolean(editing.value) && servers.value.find(s => s.id === editing.value?.id)?.revision !== editing.value?.revision)
const grantsStale = computed(() => Boolean(grants.value) && servers.value.find(s => s.id === grants.value?.id)?.revision !== grants.value?.revision)
const groupsLocked = computed(() => groupsLoading || Boolean(groupsError))
const sortedIds = (ids: readonly number[]) => JSON.stringify([...ids].sort((a, b) => a - b))
const grantsDirty = computed(() => Boolean(grants.value) && sortedIds(grantIds.value) !== sortedIds(grants.value?.groupIds ?? []))
const parsed = computed(() => ExternalMcpServerInputSchema.safeParse({
  displayName: draft.displayName,
  endpointUrl: draft.endpointUrl,
  status: draft.status,
  authMode: draft.authMode,
  ...(draft.authMode === 'bearer' ? (draft.clearSecret ? { secretValue: null } : draft.secret ? { secretValue: draft.secret } : {}) : {})
}))
const validationKey = (path: PropertyKey | undefined) => {
  switch (path) {
    case 'displayName': return 'invalidDisplayName'
    case 'endpointUrl': return 'invalidEndpointUrl'
    case 'secretValue': return 'invalidCredential'
    case 'status': return 'invalidStatus'
    case 'authMode': return 'invalidAuthentication'
    case 'groupIds': return 'invalidGroups'
    default: return 'invalidSettings'
  }
}
const fieldError = (path: string): string[] => submitted.value && !parsed.value.success && parsed.value.error.issues.some(issue => issue.path[0] === path) ? [tr(validationKey(path))] : []
const message = (value: unknown, fallback: string) => {
  if (value instanceof ZodError) return [...new Set(value.issues.map(issue => tr(validationKey(issue.path[0]))))].join(' ')
  if (value instanceof AgentApiError && value.status === 403) return tr('permissionRequired')
  return value instanceof Error ? value.message : tr(fallback)
}
const groupName = (id: number) => groups.find(group => group.id === id)?.name ?? t('admin:agentAdmin.group', { id })
const groupNames = (ids: readonly number[]) => ids.length ? ids.map(groupName).join(', ') : t('admin:agentAdmin.none')
const textFields = [{ key: 'displayName', autofocus: true }, { key: 'endpointUrl', autofocus: false }] as const
const statusOptions = computed(() => (['disabled', 'enabled'] as const).map(value => ({ value, title: t(`admin:agentAdmin.${value}`) })))
const authOptions = computed(() => [{ value: 'none', title: tr('unauthenticated') }, { value: 'bearer', title: tr('bearerAuthentication') }])
const serverActions = [
  { key: 'editEndpoint', variant: 'text', color: undefined, requiresEnabled: false, run: open },
  { key: 'groupGrants', variant: 'text', color: undefined, requiresEnabled: false, run: openGrants },
  { key: 'discover', variant: 'tonal', color: undefined, requiresEnabled: true, run: discover },
  { key: 'delete', variant: 'text', color: 'error', requiresEnabled: false, run: (s: ExternalMcpServerView) => { remove.value = s } }
] as const
let controller: AbortController | null = null
async function load() {
  controller?.abort()
  const request = new AbortController()
  controller = request
  loading.value = true
  try {
    const [s, p] = await Promise.all([listAdminExternalMcp(fetcher, csrfToken, request.signal), listExternalMcpGroupPolicies(fetcher, csrfToken, request.signal)])
    if (request.signal.aborted) return
    for (const current of s) {
      const prior = servers.value.find(previous => previous.id === current.id)
      if (prior && prior.revision !== current.revision) delete catalogRevisions[current.id]
    }
    servers.value = s
    policies.value = p
    loaded.value = true
    denied.value = false
    error.value = ''
    emit('state', { servers: s, policies: p })
  } catch (e) {
    if (request.signal.aborted) return
    denied.value = e instanceof AgentApiError && e.status === 403
    error.value = message(e, 'loadFailed')
    emit('state', null)
  } finally {
    if (controller === request) loading.value = false
  }
}
function refresh() { emit('refresh-groups'); void load() }
function open(s?: ExternalMcpServerView) {
  editing.value = s ?? null
  Object.assign(draft, { displayName: s?.displayName ?? '', endpointUrl: s?.endpointUrl ?? '', status: s?.status ?? 'disabled', authMode: s?.authMode ?? 'none', secret: '', clearSecret: false, groupIds: [...(s?.groupIds ?? [])] })
  baseline.value = JSON.stringify(draft)
  submitted.value = false
  formError.value = ''
  dialog.value = true
}
function close(value: boolean) {
  if (value || busy.value) return
  if (JSON.stringify(draft) !== baseline.value) discard.value = true
  else { dialog.value = false; draft.secret = '' }
}
async function act(operation: () => Promise<unknown>) {
  if (busy.value || loading.value || denied.value) return
  busy.value = true
  error.value = ''
  try { await operation(); await load() }
  catch (e) {
    if (e instanceof AgentApiError && e.status === 403) denied.value = true
    error.value = message(e, 'operationFailed')
    if (e instanceof AgentApiError && e.status === 409) {
      await load()
      grants.value = null
      policyConfirm.value = null
      remove.value = null
      error.value = tr('actionStale')
    }
  } finally { busy.value = false }
}
async function save() {
  if (busy.value || loading.value || denied.value || editingStale.value) return
  submitted.value = true
  formError.value = ''
  if (!editing.value && draft.groupIds.length && groupsLocked.value) {
    formError.value = tr('refreshGroupsBeforeGrants')
    return
  }
  const result = parsed.value
  if (!result.success) {
    formError.value = tr('invalidSettings')
    return
  }
  if (draft.authMode === 'bearer' && draft.status === 'enabled' && (draft.clearSecret || (!draft.secret && !editing.value?.secretConfigured))) {
    formError.value = tr('enabledBearerRequiresCredential')
    return
  }
  busy.value = true
  try {
    if (editing.value) await updateAdminExternalMcp(fetcher, csrfToken, editing.value.id, { ...result.data, expectedRevision: editing.value.revision })
    else await createAdminExternalMcp(fetcher, csrfToken, { ...result.data, groupIds: draft.groupIds })
    dialog.value = false
    draft.secret = ''
    await load()
  } catch (e) {
    if (e instanceof AgentApiError && e.status === 403) denied.value = true
    formError.value = message(e, 'saveFailed')
    if (e instanceof AgentApiError && e.status === 409) { await load(); formError.value = tr('saveStale') }
  } finally { busy.value = false }
}
function openGrants(s: ExternalMcpServerView) {
  if (groupsLocked.value) return
  grants.value = s
  grantIds.value = [...s.groupIds]
}
function closeGrants(value: boolean) {
  if (value || busy.value) return
  if (grantsDirty.value) grantDiscard.value = true
  else grants.value = null
}
async function saveGrants() {
  const s = grants.value
  if (!s || grantsStale.value || !grantsDirty.value || groupsLocked.value) return
  await act(async () => { await setExternalMcpGrants(fetcher, csrfToken, s.id, s.revision, grantIds.value); grants.value = null })
}
async function savePolicy() {
  const p = policyConfirm.value
  if (!p || groupsLocked.value) return
  await act(async () => { await setExternalMcpGroupPolicy(fetcher, csrfToken, p.groupId, p.revision, !p.allowPersonalEndpoints); policyConfirm.value = null })
}
async function removeServer() {
  const s = remove.value
  if (!s) return
  await act(async () => { await deleteAdminExternalMcp(fetcher, csrfToken, s.id, s.revision); remove.value = null })
}
async function discover(s: ExternalMcpServerView) {
  await act(async () => { discovery.value = await discoverExternalMcp(fetcher, csrfToken, s.id); catalogRevisions[s.id] = discovery.value.catalog.revision })
}
watch(() => refreshKey, () => { void load() })
watch(() => groups.map(g => g.id).join(','), () => { void load() })
onBeforeUnmount(() => { controller?.abort(); draft.secret = '' })
onMounted(load)
</script>
<style lang="scss" scoped>
@use '../admin/admin-workspace.scss' as workspace;

.control-panel { @include workspace.admin-agent-control; }
.policy {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--wiki-space-3);
  margin-block: var(--wiki-space-4);

  > span { min-width: 0; overflow-wrap: anywhere; }
}
.dialog-title {
  font-family: var(--wiki-font-display);
  color: rgb(var(--v-theme-on-surface));
  white-space: normal;
  overflow-wrap: anywhere;
}
.dialog-actions { flex-wrap: wrap; gap: var(--wiki-space-2); }
.actions, .policy, .dialog-actions {
  :deep(.v-btn) { height: auto; min-height: var(--wiki-control-height); max-width: 100%; padding-block: var(--wiki-space-2); }
  :deep(.v-btn__content) { white-space: normal; overflow-wrap: anywhere; }
}
.catalog {
  p { line-height: 1.65; overflow-wrap: anywhere; }
  h3 { font-family: var(--wiki-font-display); color: rgb(var(--v-theme-on-surface)); overflow-wrap: anywhere; }
}
</style>
