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
      <v-tab value="runtime">Runtime</v-tab><v-tab value="profiles">Providers</v-tab><v-tab value="skills">Skills</v-tab><v-tab value="knowledge">Knowledge</v-tab><v-tab value="browser">Browser</v-tab>
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
          <div class="d-flex flex-wrap align-center ga-3 mb-3"><div><h2 class="text-headline-small">Provider profiles</h2><p class="text-medium-emphasis mb-0">Pair a capable Agent model with an optional fast utility model, then assign the profile to everyone or selected Wiki groups. Saving verifies both model roles.</p></div><v-spacer/><v-btn color="primary" prepend-icon="mdi-plus" :disabled="runtime?.providerEnabled !== true" @click="openProfile()">Add profile</v-btn></div>
          <v-alert v-if="runtime?.providerEnabled === false" type="info" variant="tonal" class="mb-4">Provider administration is unavailable while provider inference is disabled in deployment configuration. Enable <code>agents.provider.enabled</code>, configure the provider runtime keys, and restart Wiki before adding profiles.</v-alert>
          <v-alert v-if="profiles.some(profile => !profile.secretConfigured)" type="warning" variant="tonal" class="mb-4">A provider credential is unavailable. Edit the profile and enter its API key to verify and enable it.</v-alert>
          <v-alert v-if="profiles.some(profile => profile.status === 'enabled' && profile.conformed && profile.exposureMode === 'all_agent_users') && !profiles.some(profile => profile.isGlobalDefault)" type="warning" variant="tonal" class="mb-4">No global default provider is set. Open an enabled provider's actions menu and choose <strong>Set global default</strong> before starting a conversation.</v-alert>
          <v-table>
            <thead><tr><th>Provider and models</th><th>API protocol</th><th>Audience</th><th>Destination</th><th>State</th><th class="text-right">Actions</th></tr></thead>
            <tbody>
              <tr v-for="profile in profiles" :key="profile.id">
                <td>
                  <strong>{{ profile.displayName }}</strong>
                  <div class="model-stack mt-1">
                    <div><span>Agent</span><code>{{ profile.model }}</code></div>
                    <div><span>Utility</span><code>{{ profile.utilityModel ? profile.utilityModel : profile.model }}</code><v-chip v-if="!profile.utilityModel" size="x-small" variant="tonal">shared</v-chip></div>
                  </div>
                </td>
                <td>{{ agentProviderProtocolOption(profile.transportKind).title }}</td>
                <td>{{ profile.exposureMode === 'all_agent_users' ? 'Everyone' : groupNames(profile.groupIds) }}</td>
                <td>{{ profile.destinationHost }}</td>
                <td>
                  <div class="d-flex flex-wrap ga-1">
                    <v-chip size="x-small" :color="profile.status === 'enabled' ? 'success' : undefined">{{ profile.status }}</v-chip>
                    <v-chip size="x-small" :color="profile.conformed ? 'success' : 'warning'">{{ profile.conformed ? 'connection verified' : profile.connectionCheck?.status === 'failed' ? 'connection failed' : 'connection not checked' }}</v-chip>
                    <v-chip v-if="profile.isGlobalDefault" size="x-small" color="primary">default</v-chip>
                    <v-chip v-if="!profile.secretConfigured" size="x-small" color="warning">secret unavailable</v-chip>
                    <p v-if="!profile.conformed && profile.connectionCheck?.message" class="text-body-small text-error mt-1 mb-0">{{ profile.connectionCheck.message }}</p>
                  </div>
                </td>
                <td class="text-right">
                  <v-menu>
                    <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-dots-vertical" variant="text" :aria-label="`Actions for ${profile.displayName}`"/></template>
                    <v-list>
                      <v-list-item title="Edit settings" subtitle="Updates this profile" @click="openProfile(profile)"/>
                      <v-list-item :title="profile.status === 'disabled' ? 'Test and enable' : 'Test connection'" :disabled="!profile.secretConfigured" @click="testConnection(profile)"/>
                      <v-list-item title="Edit access grants" @click="openGrants(profile)"/>
                      <v-list-item v-if="profile.status === 'disabled'" title="Enable" :disabled="!profile.conformed || !profile.secretConfigured" @click="setProfileEnabled(profile, true)"/>
                      <v-list-item v-else title="Disable" @click="setProfileEnabled(profile, false)"/>
                      <v-list-item title="Set global default" :disabled="!profile.conformed || profile.status !== 'enabled' || profile.exposureMode !== 'all_agent_users'" @click="setDefault(profile)"/>
                      <v-divider class="my-1"/>
                      <v-list-item title="Remove provider" base-color="error" @click="confirmRemove(profile)"/>
                    </v-list>
                  </v-menu>
                </td>
              </tr>
              <tr v-if="!profiles.length"><td colspan="6" class="text-center text-medium-emphasis py-8">No provider profiles configured.</td></tr>
            </tbody>
          </v-table>
        </v-sheet>
      </v-window-item>

      <v-window-item value="skills"><SkillAdmin :csrf-token="csrfToken" /></v-window-item>
      <v-window-item value="knowledge">
        <section class="knowledge-shell" aria-labelledby="knowledge-title">
          <header class="knowledge-hero">
            <div class="knowledge-hero-copy">
              <p class="knowledge-eyebrow">Open Knowledge Format · v0.2</p>
              <h2 id="knowledge-title">Portable knowledge, native to the Wiki</h2>
              <p>Every Markdown page can travel as a self-describing concept: readable by people, traversable by agents, and explicit about provenance, trust, freshness, and lifecycle.</p>
              <div class="knowledge-badges" aria-label="Knowledge interchange standards">
                <v-chip size="small" variant="flat" color="primary">OKF 0.2</v-chip>
                <v-chip size="small" variant="tonal">MCP 2026-07-28</v-chip>
                <v-chip size="small" variant="tonal">Official TypeScript SDK v2</v-chip>
              </div>
            </div>
            <div class="knowledge-glyph" aria-hidden="true">
              <span class="knowledge-node knowledge-node--one"></span>
              <span class="knowledge-node knowledge-node--two"></span>
              <span class="knowledge-node knowledge-node--three"></span>
              <v-icon icon="mdi-file-tree-outline" size="56" />
            </div>
          </header>

          <div class="knowledge-principles">
            <article>
              <v-icon icon="mdi-file-document-outline" color="primary" />
              <h3>Concepts</h3>
              <p>Wiki hierarchy becomes portable Markdown concepts. Titles, descriptions, tags, and canonical links remain useful outside tsFranki.</p>
            </article>
            <article>
              <v-icon icon="mdi-shield-check-outline" color="primary" />
              <h3>Trust is data</h3>
              <p>Generated and verified actors, sources, lifecycle, and stale-after dates let consumers qualify an answer instead of guessing.</p>
              <div class="trust-scale" aria-label="Derived knowledge trust tiers">
                <span>Unverified</span><span>Machine-confirmed</span><span>Human-reviewed</span>
              </div>
            </article>
            <article>
              <v-icon icon="mdi-connection" color="primary" />
              <h3>One governed surface</h3>
              <p>The built-in Agent and remote MCP clients share page permissions, immutable proposals, revision fences, and human approval.</p>
            </article>
          </div>

          <v-sheet class="knowledge-workflow" rounded="lg" border>
            <div class="knowledge-workflow-heading">
              <div>
                <p class="knowledge-eyebrow">Shared agent lifecycle</p>
                <h3>Project → discover → read → govern</h3>
              </div>
              <code>wiki://pages/{locale}/{path}</code>
            </div>
            <ol>
              <li><span>1</span><div><strong>Project every revision</strong><code>deterministic + utility gaps</code></div></li>
              <li><span>2</span><div><strong>Discover lifecycle context</strong><code>wiki_discover_pages</code></div></li>
              <li><span>3</span><div><strong>Read source and projection</strong><code>wiki_get_page</code></div></li>
              <li><span>4</span><div><strong>Propose and approve changes</strong><code>wiki_apply_page_proposal</code></div></li>
            </ol>
            <v-alert type="info" variant="tonal" density="compact">Built-in and MCP agents use the same operations and enriched corpus. OKF remains a portable MCP resource representation, never a second knowledge store or write path.</v-alert>
          </v-sheet>
        </section>
      </v-window-item>


      <v-window-item value="browser">
        <v-sheet class="pa-5" rounded="lg" border>
          <div class="d-flex flex-wrap align-center ga-3 mb-3"><div><h2 class="text-headline-small">Browser allowlist</h2><p class="text-medium-emphasis mb-0">Exact canonical HTTPS targets. Redirects and every request are revalidated by the worker.</p></div><v-spacer/><v-btn color="primary" prepend-icon="mdi-plus" @click="browserDialog = true">Add target</v-btn></div>
          <v-table><thead><tr><th>Canonical URL</th><th>Policy hash</th><th class="text-right">Enabled</th></tr></thead><tbody><tr v-for="target in browserTargets" :key="target.id"><td><code>{{ target.canonicalUrl }}</code></td><td><code>{{ target.policySha256.slice(0, 16) }}…</code></td><td class="text-right"><v-switch :model-value="target.enabled" color="primary" hide-details :aria-label="`Enable ${target.canonicalUrl}`" @update:model-value="value => setBrowserEnabled(target, Boolean(value))"/></td></tr><tr v-if="!browserTargets.length"><td colspan="3" class="text-center text-medium-emphasis py-8">No browser targets configured.</td></tr></tbody></v-table>
        </v-sheet>
      </v-window-item>
    </v-window>

    <v-dialog v-model="profileDialog" max-width="60rem" scrollable>
      <v-card :title="editingProfile ? `Edit ${editingProfile.displayName}` : 'Add provider profile'">
        <v-card-text><v-form ref="profileForm">
          <v-alert v-if="profileError" type="error" variant="tonal" density="compact" class="mb-4" closable @click:close="profileError = ''">{{ profileError }}</v-alert>
          <div class="form-grid">
            <v-text-field v-model="profileDraft.displayName" label="Display name" required/>
            <div class="protocol-field">
              <v-select v-model="profileDraft.transportKind" :items="protocolOptions" item-title="title" item-value="value" label="API protocol" required @update:model-value="selectProtocol">
                <template #item="{ props: itemProps, internalItem }">
                  <v-list-subheader v-if="internalItem.raw.startsGroup">{{ internalItem.raw.group }}</v-list-subheader>
                  <v-list-item v-bind="itemProps" :title="internalItem.raw.title" :subtitle="internalItem.raw.description"/>
                </template>
              </v-select>
              <p class="text-body-small text-medium-emphasis mt-n4 mb-4">{{ selectedProtocol.description }} Endpoint: <code>{{ selectedProtocol.endpoint }}</code>.</p>
            </div>
            <v-text-field v-model="profileDraft.model" label="Agent model" hint="Primary model for conversational answers and Wiki actions." persistent-hint required/>
            <v-text-field v-model="profileDraft.utilityModel" label="Utility model (optional)" hint="Fast, economical model for conversation titles and future classification or routing. Leave blank to use the Agent model." persistent-hint/>
            <v-select v-model="profileDraft.toolCalling" :items="toolCallingOptions" item-title="title" item-value="value" label="Tool calling" :disabled="profileDraft.transportKind === 'legacy-completions'" hint="Native uses the API tool contract. Prompt-emulated supports models or APIs without native tools and is verified before enablement." persistent-hint @update:model-value="selectToolCalling"/>
            <v-text-field v-model="profileDraft.baseUrl" label="Base URL" hint="Public HTTPS API root; the selected endpoint path is appended" required/>
            <v-select v-if="availableAuthModes.length > 1" v-model="profileDraft.authMode" :items="availableAuthModes" label="Authentication mode"/>
            <v-text-field v-model="profileDraft.secretValue" label="API key" type="password" autocomplete="new-password" :hint="editingProfile && editingProfile.secretConfigured ? 'Leave blank to retain the current encrypted credential, or enter a replacement.' : 'Encrypted with the server-managed provider key and never returned by the API.'" persistent-hint :required="!editingProfile || !editingProfile.secretConfigured"/>
            <v-select v-if="!editingProfile" v-model="profileDraft.exposureMode" :items="exposureModes" label="Available to"/>
            <v-autocomplete v-if="!editingProfile && profileDraft.exposureMode === 'groups'" v-model="profileDraft.groupIds" :items="groups" item-title="name" item-value="id" label="Wiki groups" multiple chips closable-chips/>
          </div>
          <v-sheet class="pa-4 mt-2" rounded="lg" border>
            <h3 class="text-title-medium">Protocol-derived behavior</h3>
            <p class="text-body-small text-medium-emphasis mb-3">Wiki verifies the provider connection automatically after every save. A new profile is enabled only after that check succeeds.</p>
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
                <v-alert type="info" variant="tonal" density="compact">Cost values are reservation ceilings. Provider billing is not calculated in this release, so profiles use the automatic pricing revision <code>unpriced-v1</code>.</v-alert>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-form></v-card-text>
        <v-card-actions><v-spacer/><v-btn @click="profileDialog = false">Cancel</v-btn><v-btn color="primary" :loading="saving" @click="saveProfile">Save profile</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="removingProfile !== null" max-width="34rem" @update:model-value="value => { if (!value) removingProfile = null }">
      <v-card title="Remove provider profile?">
        <v-card-text>
          <p><strong>{{ removingProfile?.displayName }}</strong> will no longer be available to sessions or new runs.</p>
          <p class="mb-0">The configuration is removed from use and its server-managed API keys are permanently deleted. Audit records are retained.</p>
        </v-card-text>
        <v-card-actions><v-spacer/><v-btn @click="removingProfile = null">Cancel</v-btn><v-btn color="error" :loading="saving" @click="removeProfile">Remove provider</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="grantsDialog" max-width="36rem" scrollable>
      <v-card :title="grantProfile ? `Access for ${grantProfile.displayName}` : 'Provider access'">
        <v-card-text>
          <v-select v-model="grantDraft.exposureMode" :items="exposureModes" label="Available to"/>
          <v-autocomplete v-if="grantDraft.exposureMode === 'groups'" v-model="grantDraft.groupIds" :items="groups" item-title="name" item-value="id" label="Wiki groups" multiple chips closable-chips hint="Users receive this provider through any selected group." persistent-hint/>
          <v-alert class="mt-4" type="info" variant="tonal" density="compact">The global default is available to everyone. Group-assigned profiles augment that default and appear as a session choice only when a user has more than one available profile.</v-alert>
        </v-card-text>
        <v-card-actions><v-spacer/><v-btn @click="grantsDialog = false">Cancel</v-btn><v-btn color="primary" :loading="saving" :disabled="grantDraft.exposureMode === 'groups' && grantDraft.groupIds.length === 0" @click="saveGrants">Save access</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
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
  type AgentProviderToolCalling,
  type AgentProviderUsageMode
} from '../../helpers/agent-provider-protocols.ts'
import SkillAdmin from './skill-admin.vue'

interface RuntimePolicy { enabled: boolean; providerEnabled: boolean; skillsEnabled: boolean; browserEnabled: boolean; proposalsEnabled: boolean; writes: { enabled: boolean; create: boolean; patch: boolean; move: boolean; restore: boolean; delete: boolean }; mcpEnabled: boolean; quotas: { globalConcurrency: number; perUserConcurrency: number; pollingMilliseconds: number; maximumSseConnectionsPerUser: number }; retention: { temporarySessionHours: number; mcpContentDays: number; auditDays: number; maintenanceBatchSize: number } }
interface ConnectionCheck { status: 'passed' | 'failed'; errorCode: string | null; message: string | null; completedAt: string }
interface Profile { id: string; displayName: string; status: 'enabled' | 'disabled'; isGlobalDefault: boolean; exposureMode: 'all_agent_users' | 'groups'; groupIds: number[]; conformed: boolean; connectionCheck: ConnectionCheck | null; transportKind: AgentProviderTransport; model: string; utilityModel: string | null; baseUrl: string; destinationHost: string; authMode: AgentProviderAuthMode; secretConfigured: boolean; adapterConfig: { timeoutMs: number; maxRetries: number; additionalHeaders: Record<string, string> }; capabilities: { streaming: boolean; toolCalling: AgentProviderToolCalling; parallelToolCalls: boolean; structuredOutput: AgentProviderStructuredOutput; usage: AgentProviderUsageMode; cancellation: boolean; maxContextTokens: number; maxOutputTokens: number }; policies: { allowedModes: string[]; dailyTokens: number; dailyCostMicros: number; reservationTokens: number; reservationCostMicros: number; reservationMilliseconds: number; promptVersion: number; maxAttempts: number } }
interface BrowserTarget { id: string; canonicalUrl: string; enabled: boolean; policySha256: string }
interface GroupOption { id: number; name: string; isSystem: boolean }
interface ProfileDraft { displayName: string; transportKind: AgentProviderTransport; model: string; utilityModel: string; baseUrl: string; authMode: AgentProviderAuthMode; secretValue: string; exposureMode: 'all_agent_users' | 'groups'; groupIds: number[]; maxContextTokens: number; maxOutputTokens: number; dailyTokens: number; dailyCostMicros: number; reservationTokens: number; reservationCostMicros: number; reservationMilliseconds: number; timeoutMs: number; maxRetries: number; maxAttempts: number; promptVersion: number; additionalHeaders: Record<string, string>; structuredOutput: AgentProviderStructuredOutput; usage: AgentProviderUsageMode; streaming: boolean; toolCalling: AgentProviderToolCalling; parallelToolCalls: boolean; cancellation: boolean }

const props = withDefaults(defineProps<{ csrfToken: string; embedded?: boolean }>(), { embedded: false })
const { embedded } = props
const tab = ref('runtime')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const profileError = ref('')
const runtime = ref<RuntimePolicy | null>(null)
const profiles = ref<Profile[]>([])
const groups = ref<GroupOption[]>([])
const browserTargets = ref<BrowserTarget[]>([])
const profileDialog = ref(false)
const grantsDialog = ref(false)
const browserDialog = ref(false)
const editingProfile = ref<Profile | null>(null)
const removingProfile = ref<Profile | null>(null)
const grantProfile = ref<Profile | null>(null)
const browserUrl = ref('')
const browserEnabled = ref(false)
const grantDraft = reactive({ exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups', groupIds: [] as number[] })
const protocolOptions = AGENT_PROVIDER_PROTOCOL_OPTIONS.filter(option => agentProviderProtocolExecutionModes(option.value).includes('agent'))
const exposureModes = [{ title: 'Everyone', value: 'all_agent_users' }, { title: 'Selected Wiki groups', value: 'groups' }]
const toolCallingOptions = [
  { title: 'Native API tools', value: 'native' as const },
  { title: 'Prompt-emulated tools', value: 'prompt' as const }
]
const defaults = (): ProfileDraft => ({ displayName: '', transportKind: 'openai-responses', model: '', utilityModel: '', ...agentProviderProtocolDefaults('openai-responses'), secretValue: '', exposureMode: 'all_agent_users', groupIds: [], maxContextTokens: 128000, maxOutputTokens: 8192, dailyTokens: 1000000, dailyCostMicros: 10000000, reservationTokens: 32000, reservationCostMicros: 1000000, reservationMilliseconds: 300000, timeoutMs: 120000, maxRetries: 0, maxAttempts: 3, promptVersion: 1, additionalHeaders: {} })
const profileDraft = reactive<ProfileDraft>(defaults())
const availableAuthModes = computed<AgentProviderAuthMode[]>(() => profileDraft.transportKind === 'legacy-completions' ? ['bearer', 'api-key-header'] : [agentProviderProtocolDefaults(profileDraft.transportKind).authMode])

const selectedProtocol = computed(() => agentProviderProtocolOption(profileDraft.transportKind))
const protocolBehaviorRows = computed(() => {
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
    { label: 'Available use', value: 'Wiki Agent with actions governed by the user’s Wiki group permissions' },
    { label: 'Model roles', value: profileDraft.utilityModel.trim() ? `Agent: ${profileDraft.model || 'not set'} · Utility: ${profileDraft.utilityModel}` : 'The Agent model also handles bounded utility work' },
    { label: 'Tool calls', value: profileDraft.toolCalling === 'prompt' ? 'Prompt-emulated; one action per model turn' : profileDraft.parallelToolCalls ? 'Native API; multiple calls per model turn, executed in order' : 'Native API; one call per model turn' },
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
const selectToolCalling = () => {
  profileDraft.parallelToolCalls = profileDraft.toolCalling === 'native' && agentProviderProtocolDefaults(profileDraft.transportKind).parallelToolCalls
}

const capabilityRows = computed(() => runtime.value ? [
  { label: 'Inline agent', enabled: runtime.value.enabled }, { label: 'Provider inference', enabled: runtime.value.providerEnabled }, { label: 'Approved skills', enabled: runtime.value.skillsEnabled }, { label: 'Isolated browser', enabled: runtime.value.browserEnabled }, { label: 'Proposals', enabled: runtime.value.proposalsEnabled }, { label: 'All writes', enabled: runtime.value.writes.enabled }, { label: 'Create', enabled: runtime.value.writes.create }, { label: 'Patch', enabled: runtime.value.writes.patch }, { label: 'Move', enabled: runtime.value.writes.move }, { label: 'Restore', enabled: runtime.value.writes.restore }, { label: 'Delete', enabled: runtime.value.writes.delete }, { label: 'MCP', enabled: runtime.value.mcpEnabled }
] : [])

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.method && init.method !== 'GET' ? { 'x-wiki-csrf': props.csrfToken } : {}), ...init.headers } })
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { message?: string; error?: string }; throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`) }
  return response.status === 204 ? undefined as T : await response.json() as T
}
const run = async (operation: () => Promise<void>) => { saving.value = true; error.value = ''; try { await operation() } catch (value) { error.value = value instanceof Error ? value.message : 'Agent administration request failed.' } finally { saving.value = false } }
const load = async () => { loading.value = true; error.value = ''; try { const [runtimeResult, profileResult, browserResult, groupResult] = await Promise.all([request<{ runtime: RuntimePolicy }>('/_api/agents/admin/runtime'), request<{ profiles: Profile[] }>('/_api/agents/admin/profiles'), request<{ targets: BrowserTarget[] }>('/_api/agents/admin/browser-targets'), request<GroupOption[]>('/_api/groups')]); runtime.value = runtimeResult.runtime; profiles.value = profileResult.profiles; browserTargets.value = browserResult.targets; groups.value = groupResult } catch (value) { error.value = value instanceof Error ? value.message : 'Agent administration could not be loaded.' } finally { loading.value = false } }
const openProfile = (profile?: Profile) => { profileError.value = ''; editingProfile.value = profile ?? null; Object.assign(profileDraft, defaults(), profile ? { ...agentProviderProtocolDefaults(profile.transportKind), displayName: profile.displayName, transportKind: profile.transportKind, model: profile.model, utilityModel: profile.utilityModel ?? '', baseUrl: profile.baseUrl, authMode: profile.authMode, maxContextTokens: profile.capabilities.maxContextTokens, maxOutputTokens: profile.capabilities.maxOutputTokens, structuredOutput: profile.capabilities.structuredOutput, usage: profile.capabilities.usage, streaming: profile.capabilities.streaming, toolCalling: profile.capabilities.toolCalling, parallelToolCalls: profile.capabilities.parallelToolCalls, cancellation: profile.capabilities.cancellation, dailyTokens: profile.policies.dailyTokens, dailyCostMicros: profile.policies.dailyCostMicros, reservationTokens: profile.policies.reservationTokens, reservationCostMicros: profile.policies.reservationCostMicros, reservationMilliseconds: profile.policies.reservationMilliseconds, timeoutMs: profile.adapterConfig.timeoutMs, maxRetries: profile.adapterConfig.maxRetries, maxAttempts: profile.policies.maxAttempts, promptVersion: profile.policies.promptVersion, additionalHeaders: profile.adapterConfig.additionalHeaders } : {}); profileDialog.value = true }
const profilePayload = () => ({ transportKind: profileDraft.transportKind, model: profileDraft.model, utilityModel: profileDraft.utilityModel.trim() || null, baseUrl: profileDraft.baseUrl, authMode: profileDraft.authMode, secretReference: null, ...(profileDraft.secretValue ? { secretValue: profileDraft.secretValue } : {}), adapterConfig: { timeoutMs: profileDraft.timeoutMs, maxRetries: profileDraft.maxRetries, additionalHeaders: profileDraft.additionalHeaders }, capabilities: { streaming: profileDraft.streaming, toolCalling: profileDraft.toolCalling, parallelToolCalls: profileDraft.parallelToolCalls, structuredOutput: profileDraft.structuredOutput, usage: profileDraft.usage, cancellation: profileDraft.cancellation, maxContextTokens: profileDraft.maxContextTokens, maxOutputTokens: profileDraft.maxOutputTokens }, capabilityRevision: agentProviderCapabilityRevision(profileDraft.transportKind), policies: { allowedModes: ['agent'], dailyTokens: profileDraft.dailyTokens, dailyCostMicros: profileDraft.dailyCostMicros, reservationTokens: profileDraft.reservationTokens, reservationCostMicros: profileDraft.reservationCostMicros, reservationMilliseconds: profileDraft.reservationMilliseconds, promptVersion: profileDraft.promptVersion, maxAttempts: profileDraft.maxAttempts }, pricingRevision: AGENT_PROVIDER_PRICING_REVISION })
const saveProfile = async (): Promise<void> => {
  saving.value = true
  profileError.value = ''
  try {
    const payload = profilePayload()
    const result = editingProfile.value
      ? await request<{ profile: Profile; connectionCheck: ConnectionCheck }>(`/_api/agents/admin/profiles/${encodeURIComponent(editingProfile.value.id)}`, { method: 'PUT', body: JSON.stringify({ ...payload, displayName: profileDraft.displayName }) })
      : await request<{ profile: Profile; connectionCheck: ConnectionCheck }>('/_api/agents/admin/profiles', { method: 'POST', body: JSON.stringify({ ...payload, displayName: profileDraft.displayName, exposureMode: profileDraft.exposureMode, ...(profileDraft.exposureMode === 'groups' ? { groupIds: profileDraft.groupIds } : {}) }) })
    profileDialog.value = false
    await load()
    if (result.connectionCheck.status === 'failed') error.value = `Profile saved, but its connection check failed: ${result.connectionCheck.message ?? result.connectionCheck.errorCode ?? 'Unknown provider error'}`
  } catch (value) {
    profileError.value = value instanceof Error ? value.message : 'Provider profile could not be saved.'
  } finally {
    saving.value = false
  }
}
const confirmRemove = (profile: Profile) => { removingProfile.value = profile }
const removeProfile = () => run(async () => { if (!removingProfile.value) return; await request(`/_api/agents/admin/profiles/${encodeURIComponent(removingProfile.value.id)}`, { method: 'DELETE' }); removingProfile.value = null; await load() })
const setProfileEnabled = (profile: Profile, enabled: boolean) => run(async () => { await request(`/_api/agents/admin/profiles/${profile.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }); await load() })
const setDefault = (profile: Profile) => run(async () => { await request(`/_api/agents/admin/profiles/${profile.id}/default`, { method: 'POST', body: '{}' }); await load() })
const testConnection = (profile: Profile) => run(async () => {
  const result = await request<{ profile: Profile; connectionCheck: ConnectionCheck }>(`/_api/agents/admin/profiles/${profile.id}/connection-check`, { method: 'POST', body: JSON.stringify({ enableOnSuccess: profile.status === 'disabled' }) })
  await load()
  if (result.connectionCheck.status === 'failed') throw new Error(result.connectionCheck.message ?? result.connectionCheck.errorCode ?? 'Provider connection check failed.')
})
const groupNames = (groupIds: readonly number[]): string => groupIds.map(id => groups.value.find(group => group.id === id)?.name ?? `Group ${id}`).join(', ')
const openGrants = (profile: Profile) => { grantProfile.value = profile; grantDraft.exposureMode = profile.exposureMode; grantDraft.groupIds = [...profile.groupIds]; grantsDialog.value = true }
const saveGrants = () => run(async () => { if (!grantProfile.value) return; await request(`/_api/agents/admin/profiles/${grantProfile.value.id}/grants`, { method: 'PUT', body: JSON.stringify({ exposureMode: grantDraft.exposureMode, groupIds: grantDraft.exposureMode === 'groups' ? grantDraft.groupIds : [] }) }); grantsDialog.value = false; await load() })
const createBrowserTarget = () => run(async () => { await request('/_api/agents/admin/browser-targets', { method: 'POST', body: JSON.stringify({ canonicalUrl: browserUrl.value, enabled: browserEnabled.value }) }); browserDialog.value = false; browserUrl.value = ''; browserEnabled.value = false; await load() })
const setBrowserEnabled = (target: BrowserTarget, enabled: boolean) => run(async () => { await request(`/_api/agents/admin/browser-targets/${target.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }); await load() })
onMounted(() => void load())
</script>

<style scoped>
.policy-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.form-grid { display: grid; gap: 0 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.model-stack { display: grid; gap: .2rem; }
.model-stack > div { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
.model-stack span { min-width: 3.2rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.protocol-field { grid-column: 1 / -1; }
.protocol-summary { display: grid; gap: .65rem; margin: 0; }
.protocol-summary > div { display: grid; gap: .25rem; grid-template-columns: minmax(9rem, .45fr) minmax(0, 1fr); }
.protocol-summary dt { font-weight: 600; }
.protocol-summary dd { margin: 0; color: rgb(var(--v-theme-on-surface-variant)); }
code { overflow-wrap: anywhere; }
.knowledge-shell { display: grid; gap: 1rem; }
.knowledge-hero { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 10rem; min-height: 15rem; overflow: hidden; padding: clamp(1.5rem, 4vw, 3rem); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 1rem; background: linear-gradient(125deg, rgba(var(--v-theme-primary), .14), rgba(var(--v-theme-surface), .96) 48%, rgba(var(--v-theme-secondary), .11)); }
.knowledge-hero::after { position: absolute; inset: 0; background-image: linear-gradient(rgba(var(--v-theme-primary), .045) 1px, transparent 1px), linear-gradient(90deg, rgba(var(--v-theme-primary), .045) 1px, transparent 1px); background-size: 2rem 2rem; content: ''; mask-image: linear-gradient(90deg, transparent, #000); pointer-events: none; }
.knowledge-hero-copy { position: relative; z-index: 1; max-width: 50rem; }
.knowledge-hero h2 { max-width: 42rem; margin: .2rem 0 .75rem; font-size: clamp(1.8rem, 4vw, 3.15rem); font-weight: 650; letter-spacing: -.045em; line-height: 1.03; }
.knowledge-hero-copy > p:not(.knowledge-eyebrow) { max-width: 46rem; margin: 0; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); font-size: 1.05rem; line-height: 1.65; }
.knowledge-eyebrow { margin: 0; color: rgb(var(--v-theme-primary)); font-size: .72rem; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }
.knowledge-badges { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1.35rem; }
.knowledge-glyph { position: relative; z-index: 1; display: grid; width: 8.5rem; height: 8.5rem; place-items: center; align-self: center; justify-self: center; color: rgb(var(--v-theme-primary)); border: 1px solid rgba(var(--v-theme-primary), .28); border-radius: 50%; background: rgba(var(--v-theme-surface), .68); box-shadow: 0 1.2rem 3rem rgba(var(--v-theme-primary), .14), inset 0 0 0 1rem rgba(var(--v-theme-primary), .035); }
.knowledge-node { position: absolute; width: .7rem; height: .7rem; border: 2px solid rgb(var(--v-theme-surface)); border-radius: 50%; background: rgb(var(--v-theme-primary)); box-shadow: 0 0 0 .25rem rgba(var(--v-theme-primary), .16); }
.knowledge-node--one { top: .5rem; left: 1.5rem; }.knowledge-node--two { right: -.1rem; bottom: 2.2rem; }.knowledge-node--three { bottom: -.1rem; left: 2.6rem; }
.knowledge-principles { display: grid; gap: 1rem; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.knowledge-principles article { min-height: 12rem; padding: 1.35rem; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: .85rem; background: rgb(var(--v-theme-surface)); }
.knowledge-principles article > .v-icon { padding: 1.2rem; border-radius: .75rem; background: rgba(var(--v-theme-primary), .09); }
.knowledge-principles h3 { margin: 1rem 0 .4rem; font-size: 1.05rem; }.knowledge-principles p { margin: 0; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); line-height: 1.55; }
.trust-scale { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: 1rem; }.trust-scale span { padding: .2rem .45rem; border-radius: 999px; background: rgba(var(--v-theme-primary), .08); color: rgb(var(--v-theme-primary)); font-size: .68rem; font-weight: 650; }
.knowledge-workflow { padding: clamp(1.25rem, 3vw, 2rem); }
.knowledge-workflow-heading { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 1rem; }.knowledge-workflow-heading h3 { margin: .2rem 0 0; font-size: 1.35rem; }.knowledge-workflow-heading > code { padding: .55rem .7rem; border-radius: .45rem; background: rgba(var(--v-theme-primary), .07); color: rgb(var(--v-theme-primary)); }
.knowledge-workflow ol { display: grid; margin: 1.5rem 0; padding: 0; grid-template-columns: repeat(4, minmax(0, 1fr)); list-style: none; }
.knowledge-workflow li { position: relative; display: flex; min-width: 0; gap: .7rem; padding-right: 1rem; }.knowledge-workflow li:not(:last-child)::after { position: absolute; top: .9rem; right: .35rem; left: 2.5rem; height: 1px; background: rgba(var(--v-theme-primary), .25); content: ''; }
.knowledge-workflow li span { z-index: 1; display: grid; width: 1.8rem; height: 1.8rem; flex: 0 0 auto; place-items: center; border-radius: 50%; background: rgb(var(--v-theme-primary)); color: rgb(var(--v-theme-surface)); font-size: .72rem; font-weight: 750; }.knowledge-workflow li div { z-index: 1; display: grid; min-width: 0; gap: .2rem; padding-top: .1rem; background: rgb(var(--v-theme-surface)); }.knowledge-workflow li strong { font-size: .8rem; }.knowledge-workflow li code { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); font-size: .7rem; }
@media (max-width: 900px) { .knowledge-principles { grid-template-columns: 1fr; }.knowledge-principles article { min-height: 0; }.knowledge-workflow ol { gap: 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }.knowledge-workflow li::after { display: none; } }
@media (max-width: 700px) { .form-grid { grid-template-columns: 1fr; } .protocol-field { grid-column: auto; }.knowledge-hero { grid-template-columns: 1fr; }.knowledge-glyph { display: none; }.knowledge-workflow ol { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
</style>
