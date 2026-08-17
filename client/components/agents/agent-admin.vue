<template>
  <main aria-labelledby="admin-title">
    <div v-if="!embedded" class="d-flex flex-wrap align-center ga-3 mb-5">
      <div><h1 id="admin-title" class="text-headline-large">Agent administration</h1><p class="text-medium-emphasis mb-0">Profiles, skills, browser policy, kill switches, quotas, and retention.</p></div>
      <v-spacer />
      <v-btn variant="outlined" prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh</v-btn>
    </div>
    <div v-else class="d-flex justify-end mb-3">
      <v-btn variant="outlined" prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh</v-btn>
    </div>
    <v-alert v-if="error" class="mb-4" type="error" variant="tonal" closable @click:close="error = ''">{{ error }}</v-alert>
    <v-tabs v-model="tab" show-arrows aria-label="Agent administration sections">
      <v-tab value="runtime">Runtime</v-tab><v-tab value="profiles">Providers</v-tab><v-tab value="skills">Skills</v-tab><v-tab value="browser">Browser</v-tab>
    </v-tabs>
    <v-window v-model="tab" class="mt-4">
      <v-window-item value="runtime">
        <v-sheet class="pa-5" rounded="lg" border>
          <h2 class="text-headline-small mb-3">Effective runtime policy</h2>
          <v-progress-linear v-if="loading" indeterminate aria-label="Loading runtime policy" />
          <template v-else-if="runtime">
            <v-alert type="info" variant="tonal" class="mb-4">Kill switches are deployment configuration. Changes require a controlled config rollout and process restart.</v-alert>
            <div class="policy-grid">
              <v-card title="Capabilities" variant="outlined"><v-list density="compact"><v-list-item v-for="item in capabilityRows" :key="item.label" :title="item.label"><template #append><v-chip :color="item.enabled ? 'success' : 'default'" size="small">{{ item.enabled ? 'Enabled' : 'Disabled' }}</v-chip></template></v-list-item></v-list></v-card>
              <v-card title="Capacity" variant="outlined"><v-list density="compact"><v-list-item title="Global concurrent runs" :subtitle="String(runtime.quotas.globalConcurrency)"/><v-list-item title="Per-user concurrent runs" :subtitle="String(runtime.quotas.perUserConcurrency)"/><v-list-item title="SSE connections per user" :subtitle="String(runtime.quotas.maximumSseConnectionsPerUser)"/><v-list-item title="Coordinator reconciliation" :subtitle="`${runtime.quotas.pollingMilliseconds} ms`"/></v-list></v-card>
              <v-card title="Retention" variant="outlined"><v-list density="compact"><v-list-item title="Temporary sessions" :subtitle="`${runtime.retention.temporarySessionHours} hours`"/><v-list-item title="MCP proposal content" :subtitle="`${runtime.retention.mcpContentDays} days`"/><v-list-item title="Audit ledger" :subtitle="`${runtime.retention.auditDays} days`"/><v-list-item title="Maintenance batch" :subtitle="String(runtime.retention.maintenanceBatchSize)"/></v-list></v-card>
              <v-card title="Metrics and health" variant="outlined"><v-card-text>Agent run, proposal, artifact, and usage gauges are exported through the existing metrics endpoint. Provider, browser-worker, and MCP failures do not affect <code>/healthz</code>.</v-card-text></v-card>
            </div>
          </template>
        </v-sheet>
      </v-window-item>

      <v-window-item value="profiles">
        <v-sheet class="pa-5" rounded="lg" border>
          <div class="d-flex flex-wrap align-center ga-3 mb-3"><div><h2 class="text-headline-small">Provider profiles</h2><p class="text-medium-emphasis mb-0">Immutable versions remain disabled until conformance passes.</p></div><v-spacer/><v-btn color="primary" prepend-icon="mdi-plus" :disabled="runtime?.providerEnabled !== true" @click="openProfile()">Add profile</v-btn></div>
          <v-alert v-if="runtime?.providerEnabled === false" type="info" variant="tonal" class="mb-4">Provider administration is unavailable while provider inference is disabled in deployment configuration. Enable <code>agents.provider.enabled</code>, configure the provider runtime keys, and restart Wiki before adding profiles.</v-alert>
          <v-alert v-if="profiles.some(profile => !profile.secretConfigured)" type="warning" variant="tonal" class="mb-4">A provider credential is unavailable. Create an immutable version and enter its API key before running conformance and enabling the profile.</v-alert>
          <v-table>
            <thead><tr><th>Name</th><th>API protocol</th><th>Destination</th><th>State</th><th class="text-right">Actions</th></tr></thead>
            <tbody>
              <tr v-for="profile in profiles" :key="profile.id">
                <td><strong>{{ profile.displayName }}</strong><div class="text-body-small">v{{ profile.currentVersion }} · {{ profile.model }}</div></td>
                <td>{{ agentProviderProtocolOption(profile.transportKind).title }}</td>
                <td>{{ profile.destinationHost }}</td>
                <td>
                  <div class="d-flex flex-wrap ga-1">
                    <v-chip size="x-small" :color="profile.status === 'enabled' ? 'success' : undefined">{{ profile.status }}</v-chip>
                    <v-chip size="x-small" :color="profile.conformed ? 'success' : 'warning'">{{ profile.conformed ? 'conformed' : 'not conformed' }}</v-chip>
                    <v-chip v-if="profile.isGlobalDefault" size="x-small" color="primary">default</v-chip>
                    <v-chip v-if="!profile.secretConfigured" size="x-small" color="warning">secret unavailable</v-chip>
                  </div>
                </td>
                <td class="text-right">
                  <v-menu>
                    <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-dots-vertical" variant="text" :aria-label="`Actions for ${profile.displayName}`"/></template>
                    <v-list>
                      <v-list-item title="Create immutable version" @click="openProfile(profile)"/>
                      <v-list-item title="Run conformance" :disabled="!profile.secretConfigured" @click="conform(profile)"/>
                      <v-list-item title="Edit access grants" @click="openGrants(profile)"/>
                      <v-list-item v-if="profile.status === 'disabled'" title="Enable" :disabled="!profile.conformed || !profile.secretConfigured" @click="setProfileEnabled(profile, true)"/>
                      <v-list-item v-else title="Disable" @click="setProfileEnabled(profile, false)"/>
                      <v-list-item title="Set global default" :disabled="!profile.conformed || profile.status !== 'enabled' || profile.exposureMode !== 'all_agent_users'" @click="setDefault(profile)"/>
                    </v-list>
                  </v-menu>
                </td>
              </tr>
              <tr v-if="!profiles.length"><td colspan="5" class="text-center text-medium-emphasis py-8">No provider profiles configured.</td></tr>
            </tbody>
          </v-table>
        </v-sheet>
      </v-window-item>

      <v-window-item value="skills"><SkillAdmin :csrf-token="csrfToken" /></v-window-item>

      <v-window-item value="browser">
        <v-sheet class="pa-5" rounded="lg" border>
          <div class="d-flex flex-wrap align-center ga-3 mb-3"><div><h2 class="text-headline-small">Browser allowlist</h2><p class="text-medium-emphasis mb-0">Exact canonical HTTPS targets. Redirects and every request are revalidated by the worker.</p></div><v-spacer/><v-btn color="primary" prepend-icon="mdi-plus" @click="browserDialog = true">Add target</v-btn></div>
          <v-table><thead><tr><th>Canonical URL</th><th>Policy hash</th><th class="text-right">Enabled</th></tr></thead><tbody><tr v-for="target in browserTargets" :key="target.id"><td><code>{{ target.canonicalUrl }}</code></td><td><code>{{ target.policySha256.slice(0, 16) }}…</code></td><td class="text-right"><v-switch :model-value="target.enabled" color="primary" hide-details :aria-label="`Enable ${target.canonicalUrl}`" @update:model-value="value => setBrowserEnabled(target, Boolean(value))"/></td></tr><tr v-if="!browserTargets.length"><td colspan="3" class="text-center text-medium-emphasis py-8">No browser targets configured.</td></tr></tbody></v-table>
        </v-sheet>
      </v-window-item>
    </v-window>

    <v-dialog v-model="profileDialog" max-width="60rem" scrollable>
      <v-card :title="editingProfile ? `New version of ${editingProfile.displayName}` : 'Add provider profile'">
        <v-card-text><v-form ref="profileForm">
          <v-alert v-if="profileError" type="error" variant="tonal" density="compact" class="mb-4" closable @click:close="profileError = ''">{{ profileError }}</v-alert>
          <div class="form-grid">
            <v-text-field v-if="!editingProfile" v-model="profileDraft.displayName" label="Display name" required/>
            <div class="protocol-field">
              <v-select v-model="profileDraft.transportKind" :items="protocolOptions" item-title="title" item-value="value" label="API protocol" required @update:model-value="selectProtocol">
                <template #item="{ props: itemProps, internalItem }">
                  <v-list-subheader v-if="internalItem.raw.startsGroup">{{ internalItem.raw.group }}</v-list-subheader>
                  <v-list-item v-bind="itemProps" :title="internalItem.raw.title" :subtitle="internalItem.raw.description"/>
                </template>
              </v-select>
              <p class="text-body-small text-medium-emphasis mt-n4 mb-4">{{ selectedProtocol.description }} Endpoint: <code>{{ selectedProtocol.endpoint }}</code>.</p>
            </div>
            <v-text-field v-model="profileDraft.model" label="Model" required/>
            <v-text-field v-model="profileDraft.baseUrl" label="Base URL" hint="Public HTTPS API root; the selected endpoint path is appended" required/>
            <v-select v-if="availableAuthModes.length > 1" v-model="profileDraft.authMode" :items="availableAuthModes" label="Authentication mode"/>
            <v-text-field v-model="profileDraft.secretValue" label="API key" type="password" autocomplete="new-password" hint="Encrypted with the server-managed provider key and never returned by the API." persistent-hint required/>
            <v-select v-if="!editingProfile" v-model="profileDraft.exposureMode" :items="exposureModes" label="Exposure"/>
            <v-text-field v-if="!editingProfile && profileDraft.exposureMode === 'groups'" v-model="profileDraft.groupIds" label="Group IDs" hint="Comma-separated positive IDs"/>
          </div>
          <v-sheet class="pa-4 mt-2" rounded="lg" border>
            <h3 class="text-title-medium">Protocol-derived behavior</h3>
            <p class="text-body-small text-medium-emphasis mb-3">Wiki selects conservative behavior from the API protocol. The immutable profile must still pass conformance before it can be enabled.</p>
            <dl class="protocol-summary">
              <div v-for="row in protocolBehaviorRows" :key="row.label">
                <dt>{{ row.label }}</dt>
                <dd>{{ row.value }}</dd>
              </div>
            </dl>
          </v-sheet>
          <v-expansion-panels variant="accordion" class="mt-4">
            <v-expansion-panel>
              <v-expansion-panel-title>Advanced limits and quotas</v-expansion-panel-title>
              <v-expansion-panel-text>
                <div class="form-grid">
                  <v-text-field v-model.number="profileDraft.maxContextTokens" type="number" label="Maximum context tokens"/>
                  <v-text-field v-model.number="profileDraft.maxOutputTokens" type="number" label="Maximum output tokens"/>
                  <v-text-field v-model.number="profileDraft.dailyTokens" type="number" label="Daily token limit"/>
                  <v-text-field v-model.number="profileDraft.dailyCostMicros" type="number" label="Daily cost reservation (micros)"/>
                  <v-text-field v-model.number="profileDraft.reservationTokens" type="number" label="Per-run token reservation"/>
                  <v-text-field v-model.number="profileDraft.reservationCostMicros" type="number" label="Per-run cost reservation (micros)"/>
                  <v-text-field v-model.number="profileDraft.timeoutMs" type="number" label="Request timeout (ms)"/>
                  <v-text-field v-model.number="profileDraft.maxAttempts" type="number" label="Maximum attempts"/>
                </div>
                <v-alert type="info" variant="tonal" density="compact">Cost values are reservation ceilings. Provider billing is not calculated in this release, so immutable profiles record the automatic pricing revision <code>unpriced-v1</code>.</v-alert>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-form></v-card-text>
        <v-card-actions><v-spacer/><v-btn @click="profileDialog = false">Cancel</v-btn><v-btn color="primary" :loading="saving" @click="saveProfile">Save immutable version</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="grantsDialog" max-width="32rem"><v-card title="Provider access grants"><v-card-text><v-select v-model="grantDraft.exposureMode" :items="exposureModes" label="Exposure"/><v-text-field v-if="grantDraft.exposureMode === 'groups'" v-model="grantDraft.groupIds" label="Group IDs" hint="Comma-separated positive IDs"/></v-card-text><v-card-actions><v-spacer/><v-btn @click="grantsDialog = false">Cancel</v-btn><v-btn color="primary" :loading="saving" @click="saveGrants">Save grants</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="browserDialog" max-width="36rem"><v-card title="Add browser target"><v-card-text><v-text-field v-model="browserUrl" label="Exact HTTPS URL" placeholder="https://example.com/path" autofocus/><v-checkbox v-model="browserEnabled" label="Enable immediately"/></v-card-text><v-card-actions><v-spacer/><v-btn @click="browserDialog = false">Cancel</v-btn><v-btn color="primary" :loading="saving" @click="createBrowserTarget">Add target</v-btn></v-card-actions></v-card></v-dialog>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { AgentProviderTransport } from '../../../shared/agents/contracts.ts'
import {
  AGENT_PROVIDER_PRICING_REVISION,
  AGENT_PROVIDER_PROTOCOL_OPTIONS,
  agentProviderCapabilityRevision,
  agentProviderProtocolDefaults,
  agentProviderProtocolExecutionModes,
  agentProviderProtocolOption,
  isAgentProviderTransport,
  type AgentProviderAuthMode,
  type AgentProviderStructuredOutput,
  type AgentProviderUsageMode
} from '../../helpers/agent-provider-protocols.ts'
import SkillAdmin from './skill-admin.vue'

interface RuntimePolicy { enabled: boolean; providerEnabled: boolean; skillsEnabled: boolean; browserEnabled: boolean; proposalsEnabled: boolean; writes: { enabled: boolean; create: boolean; patch: boolean; move: boolean; restore: boolean; delete: boolean }; mcpEnabled: boolean; quotas: { globalConcurrency: number; perUserConcurrency: number; pollingMilliseconds: number; maximumSseConnectionsPerUser: number }; retention: { temporarySessionHours: number; mcpContentDays: number; auditDays: number; maintenanceBatchSize: number } }
interface Profile { id: string; displayName: string; status: 'enabled' | 'disabled'; isGlobalDefault: boolean; exposureMode: 'all_agent_users' | 'groups'; conformed: boolean; currentVersion: number; currentVersionId: string; transportKind: AgentProviderTransport; model: string; destinationHost: string; secretConfigured: boolean; capabilities: { streaming: boolean; functions: boolean; parallelFunctions: boolean; structuredOutput: AgentProviderStructuredOutput; usage: AgentProviderUsageMode; cancellation: boolean; maxContextTokens: number; maxOutputTokens: number }; capabilityRevision: string; pricingRevision: string }
interface BrowserTarget { id: string; canonicalUrl: string; enabled: boolean; policySha256: string }
interface ProfileDraft { displayName: string; transportKind: AgentProviderTransport; model: string; baseUrl: string; authMode: AgentProviderAuthMode; secretValue: string; exposureMode: 'all_agent_users' | 'groups'; groupIds: string; maxContextTokens: number; maxOutputTokens: number; dailyTokens: number; dailyCostMicros: number; reservationTokens: number; reservationCostMicros: number; timeoutMs: number; maxAttempts: number; structuredOutput: AgentProviderStructuredOutput; usage: AgentProviderUsageMode; streaming: boolean; functions: boolean; parallelFunctions: boolean; cancellation: boolean }

const props = withDefaults(defineProps<{ csrfToken: string; embedded?: boolean }>(), { embedded: false })
const { embedded } = props
const tab = ref('runtime')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const profileError = ref('')
const runtime = ref<RuntimePolicy | null>(null)
const profiles = ref<Profile[]>([])
const browserTargets = ref<BrowserTarget[]>([])
const profileDialog = ref(false)
const grantsDialog = ref(false)
const browserDialog = ref(false)
const editingProfile = ref<Profile | null>(null)
const grantProfile = ref<Profile | null>(null)
const browserUrl = ref('')
const browserEnabled = ref(false)
const grantDraft = reactive({ exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups', groupIds: '' })
const protocolOptions = AGENT_PROVIDER_PROTOCOL_OPTIONS
const exposureModes = [{ title: 'All agent users', value: 'all_agent_users' }, { title: 'Selected groups', value: 'groups' }]
const defaults = (): ProfileDraft => ({ displayName: '', transportKind: 'openai-responses', model: '', ...agentProviderProtocolDefaults('openai-responses'), secretValue: '', exposureMode: 'all_agent_users', groupIds: '', maxContextTokens: 128000, maxOutputTokens: 8192, dailyTokens: 1000000, dailyCostMicros: 10000000, reservationTokens: 32000, reservationCostMicros: 1000000, timeoutMs: 120000, maxAttempts: 3 })
const profileDraft = reactive<ProfileDraft>(defaults())
const availableAuthModes = computed<AgentProviderAuthMode[]>(() => profileDraft.transportKind === 'legacy-completions' ? ['bearer', 'api-key-header'] : [agentProviderProtocolDefaults(profileDraft.transportKind).authMode])

const selectedProtocol = computed(() => agentProviderProtocolOption(profileDraft.transportKind))
const protocolBehaviorRows = computed(() => {
  const modes = agentProviderProtocolExecutionModes(profileDraft.transportKind)
  const structuredOutput = {
    'native-json-schema': 'Native JSON Schema',
    'tool-result': 'Tool-result schema',
    'prompt-only': 'Prompt-validated text'
  }[profileDraft.structuredOutput]
  const usage = {
    stream: 'Provider token counts from the response stream',
    terminal: 'Provider token counts from the final response',
    estimated: 'Estimated token counts'
  }[profileDraft.usage]
  const authentication = {
    bearer: 'Bearer token',
    'api-key-header': 'API-key header',
    'anthropic-api-key': 'Anthropic API key'
  }[profileDraft.authMode]
  return [
    { label: 'Available use', value: modes.includes('agent') ? 'Agent with Wiki actions, or text generation without actions' : 'Text generation only; Wiki actions unavailable' },
    { label: 'Tool calls', value: !profileDraft.functions ? 'Unavailable' : profileDraft.parallelFunctions ? 'Multiple calls per model turn; Wiki executes them in order' : 'One call per model turn' },
    { label: 'Response delivery', value: profileDraft.streaming ? `Streamed; ${profileDraft.cancellation ? 'cancellable' : 'not cancellable'}` : 'One buffered response' },
    { label: 'Structured output', value: structuredOutput },
    { label: 'Usage accounting', value: usage },
    { label: 'Authentication', value: authentication }
  ]
})
const selectProtocol = (value: unknown) => {
  if (!isAgentProviderTransport(value)) return
  profileDraft.transportKind = value
  Object.assign(profileDraft, agentProviderProtocolDefaults(value))
}

const capabilityRows = computed(() => runtime.value ? [
  { label: 'Inline agent', enabled: runtime.value.enabled }, { label: 'Provider inference', enabled: runtime.value.providerEnabled }, { label: 'Approved skills', enabled: runtime.value.skillsEnabled }, { label: 'Isolated browser', enabled: runtime.value.browserEnabled }, { label: 'Proposals', enabled: runtime.value.proposalsEnabled }, { label: 'All writes', enabled: runtime.value.writes.enabled }, { label: 'Create', enabled: runtime.value.writes.create }, { label: 'Patch', enabled: runtime.value.writes.patch }, { label: 'Move', enabled: runtime.value.writes.move }, { label: 'Restore', enabled: runtime.value.writes.restore }, { label: 'Delete', enabled: runtime.value.writes.delete }, { label: 'MCP', enabled: runtime.value.mcpEnabled }
] : [])

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.method && init.method !== 'GET' ? { 'x-wiki-csrf': props.csrfToken } : {}), ...init.headers } })
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { message?: string; error?: string }; throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`) }
  return response.status === 204 ? undefined as T : await response.json() as T
}
const ids = (value: string): number[] => [...new Set(value.split(',').map(part => Number(part.trim())).filter(id => Number.isSafeInteger(id) && id > 0))]
const run = async (operation: () => Promise<void>) => { saving.value = true; error.value = ''; try { await operation() } catch (value) { error.value = value instanceof Error ? value.message : 'Agent administration request failed.' } finally { saving.value = false } }
const load = async () => { loading.value = true; error.value = ''; try { const [runtimeResult, profileResult, browserResult] = await Promise.all([request<{ runtime: RuntimePolicy }>('/_api/agents/admin/runtime'), request<{ profiles: Profile[] }>('/_api/agents/admin/profiles'), request<{ targets: BrowserTarget[] }>('/_api/agents/admin/browser-targets')]); runtime.value = runtimeResult.runtime; profiles.value = profileResult.profiles; browserTargets.value = browserResult.targets } catch (value) { error.value = value instanceof Error ? value.message : 'Agent administration could not be loaded.' } finally { loading.value = false } }
const openProfile = (profile?: Profile) => { profileError.value = ''; editingProfile.value = profile ?? null; Object.assign(profileDraft, defaults(), profile ? { ...agentProviderProtocolDefaults(profile.transportKind), transportKind: profile.transportKind, model: profile.model, maxContextTokens: profile.capabilities.maxContextTokens, maxOutputTokens: profile.capabilities.maxOutputTokens, structuredOutput: profile.capabilities.structuredOutput, usage: profile.capabilities.usage, streaming: profile.capabilities.streaming, functions: profile.capabilities.functions, parallelFunctions: profile.capabilities.parallelFunctions, cancellation: profile.capabilities.cancellation } : {}); profileDialog.value = true }
const profilePayload = () => ({ transportKind: profileDraft.transportKind, model: profileDraft.model, baseUrl: profileDraft.baseUrl, authMode: profileDraft.authMode, secretReference: null, secretValue: profileDraft.secretValue, adapterConfig: { timeoutMs: profileDraft.timeoutMs, maxRetries: 0, additionalHeaders: {} }, capabilities: { streaming: profileDraft.streaming, functions: profileDraft.functions, parallelFunctions: profileDraft.parallelFunctions, structuredOutput: profileDraft.structuredOutput, usage: profileDraft.usage, cancellation: profileDraft.cancellation, maxContextTokens: profileDraft.maxContextTokens, maxOutputTokens: profileDraft.maxOutputTokens }, capabilityRevision: agentProviderCapabilityRevision(profileDraft.transportKind), policies: { allowedModes: [...agentProviderProtocolExecutionModes(profileDraft.transportKind)], dailyTokens: profileDraft.dailyTokens, dailyCostMicros: profileDraft.dailyCostMicros, reservationTokens: profileDraft.reservationTokens, reservationCostMicros: profileDraft.reservationCostMicros, reservationMilliseconds: 300000, promptVersion: 1, maxAttempts: profileDraft.maxAttempts }, pricingRevision: AGENT_PROVIDER_PRICING_REVISION })
const saveProfile = async (): Promise<void> => {
  saving.value = true
  profileError.value = ''
  try {
    const payload = profilePayload()
    if (editingProfile.value) await request(`/_api/agents/admin/profiles/${encodeURIComponent(editingProfile.value.id)}/versions`, { method: 'POST', body: JSON.stringify(payload) })
    else await request('/_api/agents/admin/profiles', { method: 'POST', body: JSON.stringify({ ...payload, displayName: profileDraft.displayName, exposureMode: profileDraft.exposureMode, ...(profileDraft.exposureMode === 'groups' ? { groupIds: ids(profileDraft.groupIds) } : {}) }) })
    profileDialog.value = false
    await load()
  } catch (value) {
    profileError.value = value instanceof Error ? value.message : 'Provider profile could not be saved.'
  } finally {
    saving.value = false
  }
}
const setProfileEnabled = (profile: Profile, enabled: boolean) => run(async () => { await request(`/_api/agents/admin/profiles/${profile.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }); await load() })
const setDefault = (profile: Profile) => run(async () => { await request(`/_api/agents/admin/profiles/${profile.id}/default`, { method: 'POST', body: '{}' }); await load() })
const conform = (profile: Profile) => run(async () => { await request(`/_api/agents/admin/profiles/${profile.id}/conformance`, { method: 'POST', body: JSON.stringify({ versionId: profile.currentVersionId }) }); await load() })
const openGrants = (profile: Profile) => { grantProfile.value = profile; grantDraft.exposureMode = profile.exposureMode; grantDraft.groupIds = ''; grantsDialog.value = true }
const saveGrants = () => run(async () => { if (!grantProfile.value) return; await request(`/_api/agents/admin/profiles/${grantProfile.value.id}/grants`, { method: 'PUT', body: JSON.stringify({ exposureMode: grantDraft.exposureMode, groupIds: grantDraft.exposureMode === 'groups' ? ids(grantDraft.groupIds) : [] }) }); grantsDialog.value = false; await load() })
const createBrowserTarget = () => run(async () => { await request('/_api/agents/admin/browser-targets', { method: 'POST', body: JSON.stringify({ canonicalUrl: browserUrl.value, enabled: browserEnabled.value }) }); browserDialog.value = false; browserUrl.value = ''; browserEnabled.value = false; await load() })
const setBrowserEnabled = (target: BrowserTarget, enabled: boolean) => run(async () => { await request(`/_api/agents/admin/browser-targets/${target.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }); await load() })
onMounted(() => void load())
</script>

<style scoped>
.policy-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.form-grid { display: grid; gap: 0 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.protocol-field { grid-column: 1 / -1; }
.protocol-summary { display: grid; gap: .65rem; margin: 0; }
.protocol-summary > div { display: grid; gap: .25rem; grid-template-columns: minmax(9rem, .45fr) minmax(0, 1fr); }
.protocol-summary dt { font-weight: 600; }
.protocol-summary dd { margin: 0; color: rgb(var(--v-theme-on-surface-variant)); }
code { overflow-wrap: anywhere; }
@media (max-width: 700px) { .form-grid { grid-template-columns: 1fr; } .protocol-field { grid-column: auto; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
</style>
