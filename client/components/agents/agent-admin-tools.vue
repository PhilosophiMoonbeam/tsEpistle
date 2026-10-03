<template>
  <section class="tool-workspace" aria-labelledby="tool-directory-title">
    <header>
      <div class="tool-eyebrow">{{ $t('admin:agentAdminTools.capabilitiesConnections') }}</div>
      <h2 id="tool-directory-title">{{ $t('admin:agentAdminTools.toolsMcp') }}</h2>
      <p>{{ $t('admin:agentAdminTools.seeWhatDeploymentCan') }}</p>
    </header>
    <div class="mcp-connection">
      <div>
        <h3>{{ $t('admin:agentAdminTools.connectAnotherAgent') }}</h3>
        <p>{{ $t('admin:agentAdminTools.useStreamableHttpApi') }}</p>
        <v-chip size="small" :color="loaded ? mcpEnabled ? 'success' : 'warning' : undefined" variant="tonal">{{ !loaded ? $t('admin:agentAdminTools.stateUnavailable') : mcpEnabled ? $t('admin:agentAdminTools.mcpEnabledDeployment') : $t('admin:agentAdminTools.mcpDisabledDeployment') }}</v-chip>
      </div>
      <div class="mcp-connection__endpoint">
        <span>{{ $t('admin:agentAdminTools.mcpResourceUrl') }}</span>
        <div class="mcp-connection__url"><code id="agent-mcp-endpoint">{{ endpoint }}</code><v-btn icon="mdi-content-copy" size="small" variant="text" :aria-label="$t('admin:agentAdminTools.copyMcpResourceUrl')" @click="copyEndpoint" /></div>
        <span v-if="copyMessage" role="status">{{ copyMessage }}</span>
        <a href="/a/api">{{ $t('admin:agentAdminTools.manageApiKeysIntegration') }} <v-icon size="16">mdi-arrow-right</v-icon></a>
      </div>
    </div>
    <div class="tool-toolbar" role="search" :aria-label="$t('admin:agentAdminTools.findAgentTools')">
      <v-text-field v-model="query" :label="$t('admin:agentAdminTools.findTool')" prepend-inner-icon="mdi-magnify" clearable hide-details />
      <v-select v-model="transport" :label="$t('admin:agentAdminTools.available')" :items="transports" hide-details />
      <v-select v-model="state" :label="$t('admin:agentAdminTools.deploymentState')" :items="states" hide-details />
    </div>
    <p class="tool-explanation">{{ $t('admin:agentAdminTools.deploymentEligibilityOnlyFirst') }}</p>
    <p class="tool-explanation">{{ $t('admin:agentAdminTools.eligibilityFilterScope') }}</p>
    <v-skeleton-loader v-if="!loaded && loading" type="list-item-three-line, list-item-three-line" />
    <v-alert v-else-if="!loaded" type="info" variant="tonal">{{ $t('admin:agentAdminTools.toolPolicyCouldNot') }}</v-alert>
    <template v-else>
      <p class="tool-count" role="status">{{ $t('admin:agentAdminTools.tools', { filteredToolsCount: filteredTools.length, toolsCount: tools.length, interpolation: { escapeValue: false } }) }}</p>
      <div class="tool-directory">
        <details v-for="tool in filteredTools" :key="tool.name" class="tool-record">
          <summary>
            <v-icon size="20">{{ tool.risk === 'read' ? 'mdi-book-search-outline' : tool.risk === 'open-world-read' ? 'mdi-web' : 'mdi-pencil-lock-outline' }}</v-icon>
            <span class="tool-record__name"><strong>{{ tool.title }}</strong><code>{{ tool.toolName }}</code></span>
            <span class="tool-record__states">
              <span v-for="interfaceName in interfaceNames" :key="interfaceName" class="tool-record__state">{{ $t('admin:agentAdminTools.interfaceEligibility', { interface: interfaceName === 'agent' ? $t('admin:agentAdminTools.wikiAgent') : $t('admin:agentAdminTools.mcpClients'), state: interfaceState(tool, interfaceName), interpolation: { escapeValue: false } }) }}</span>
            </span>
            <v-icon size="18">mdi-chevron-down</v-icon>
          </summary>
          <div class="tool-record__details">
            <p>{{ tool.description }}</p>
            <dl>
              <div><dt>{{ $t('admin:agentAdminTools.effect') }}</dt><dd>{{ riskLabels[tool.risk] }}</dd></div>
              <div><dt>{{ $t('admin:agentAdminTools.permissions') }}</dt><dd>{{ tool.requiredPermissions.join(', ') || $t('admin:agentAdminTools.authenticatedAccessResourceRules') }}</dd></div>
              <div><dt>{{ $t('admin:agentAdminTools.wikiAgent') }}</dt><dd>{{ exposureDescription(tool.exposure.agent, tool.agentBlockers) }}</dd></div>
              <div><dt>{{ $t('admin:agentAdminTools.mcpClients') }}</dt><dd>{{ exposureDescription(tool.exposure.mcp, tool.mcpBlockers) }}</dd></div>
            </dl>
          </div>
        </details>
      </div>
      <div v-if="!filteredTools.length" class="tool-empty">
        <h3>{{ tools.length ? $t('admin:agentAdminTools.noToolsMatchThese') : $t('admin:agentAdminTools.toolInventoryUnavailable') }}</h3>
        <p>{{ tools.length ? $t('admin:agentAdminTools.tryAnotherCapabilityPermission') : $t('admin:agentAdminTools.refreshAfterServerClient') }}</p>
        <v-btn v-if="tools.length" variant="tonal" @click="query = ''; transport = 'all'; state = 'all'">{{ $t('admin:agentAdminTools.clearFilters') }}</v-btn>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentAdminTool } from '../../../shared/agents/admin.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

const { tools, loaded, loading, mcpEnabled } = defineProps<{ tools: AgentAdminTool[]; loaded: boolean; loading: boolean; mcpEnabled: boolean }>()
const query = ref<string | null>('')
const transport = ref<'all' | 'agent' | 'mcp'>('all')
const state = ref('all')
const copyMessage = ref('')
const endpoint = new URL('/mcp', window.location.origin).href
const transports = [{ title: t('admin:agentAdminTools.eitherInterface'), value: 'all' }, { title: t('admin:agentAdminTools.wikiAgent'), value: 'agent' }, { title: t('admin:agentAdminTools.mcpClients'), value: 'mcp' }]
const states = [{ title: t('admin:agentAdminTools.allStates'), value: 'all' }, { title: t('admin:agentAdminTools.eligible'), value: 'eligible' }, { title: t('admin:agentAdminTools.deploymentBlocked'), value: 'blocked' }]
const riskLabels = { read: t('admin:agentAdminTools.readOnly'), 'open-world-read': t('admin:agentAdminTools.externalBrowsing'), proposal: t('admin:agentAdminTools.preparesChangeReview'), 'reversible-write': t('admin:agentAdminTools.changesStoredData'), 'destructive-write': t('admin:agentAdminTools.appliesApprovedChange') }
const interfaceNames = ['agent', 'mcp'] as const
const interfaceState = (tool: AgentAdminTool, interfaceName: 'agent' | 'mcp') => !tool.exposure[interfaceName]
  ? t('admin:agentAdminTools.notExposed')
  : (interfaceName === 'agent' ? tool.agentBlockers : tool.mcpBlockers).length
    ? t('admin:agentAdminTools.deploymentBlocked')
    : t('admin:agentAdminTools.eligible')
const eligible = (tool: AgentAdminTool) =>
  (transport.value !== 'mcp' && tool.exposure.agent && !tool.agentBlockers.length) ||
  (transport.value !== 'agent' && tool.exposure.mcp && !tool.mcpBlockers.length)
const filteredTools = computed(() => {
  const terms = (query.value || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return tools.filter(tool => (transport.value === 'all' || tool.exposure[transport.value]) &&
    (state.value === 'all' || eligible(tool) === (state.value === 'eligible')) &&
    terms.every(term => `${tool.title} ${tool.toolName} ${tool.description} ${tool.requiredPermissions.join(' ')}`.toLocaleLowerCase().includes(term)))
})
const exposureDescription = (exposed: boolean, blockers: readonly string[]) => !exposed ? t('admin:agentAdminTools.notExposedInterface') : blockers.length ? t('admin:agentAdminTools.enable', { blockers: blockers.join(', '), interpolation: { escapeValue: false } }) : t('admin:agentAdminTools.eligibleSubjectRequestAuthorization')
async function copyEndpoint() {
  try { await navigator.clipboard.writeText(endpoint); copyMessage.value = t('admin:agentAdminTools.resourceUrlCopied') }
  catch { copyMessage.value = t('admin:agentAdminTools.copyUnavailableSelectCopy') }
}
</script>

<style scoped>
.tool-workspace { padding: clamp(1rem, 3vw, 2rem); background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); }
.tool-eyebrow { color: var(--wiki-accent-ink); font-size: .75rem; letter-spacing: .1em; text-transform: uppercase; }
h2 { font: 500 1.7rem var(--wiki-font-display); margin-block: .35rem; }
h3 { font-size: 1rem; }
p { font-size: .9rem; line-height: 1.65; margin-block: .5rem 1rem; }
.mcp-connection { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; padding: 1.5rem; margin-block: 1rem 1.5rem; border: 1px solid var(--wiki-purpose-info-edge); border-radius: var(--wiki-control-radius); background: var(--wiki-purpose-info-fill); color: var(--wiki-purpose-info-ink); }
.mcp-connection > div { min-width: 0; }
.mcp-connection__endpoint { display: flex; flex-direction: column; gap: .6rem; font-size: .8rem; }
.mcp-connection__url { display: flex; align-items: center; gap: .5rem; padding: .6rem; background: var(--wiki-surface-sunken); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); }
.mcp-connection__url code { flex: 1; overflow-wrap: anywhere; }
a { color: var(--wiki-accent-ink); }
.tool-toolbar { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr); gap: .75rem; }
.tool-explanation, .tool-count { font-size: .8rem; }
.tool-directory { border-top: 1px solid var(--wiki-surface-border); }
.tool-record { border-bottom: 1px solid var(--wiki-surface-border); }
summary { display: flex; align-items: center; gap: .8rem; padding-block: 1rem; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary:focus-visible { outline: 2px solid var(--wiki-accent-ink); outline-offset: 3px; }
.tool-record__name { display: grid; gap: .2rem; flex: 1; min-width: 0; }
.tool-record__name strong { font-size: .9rem; }
code { font-family: var(--wiki-font-mono); font-size: .75rem; overflow-wrap: anywhere; }
.tool-record__states { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .4rem; max-width: 28rem; }
.tool-record__state { font-size: .75rem; line-height: 1.5; padding: .2rem .5rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); }
.tool-record__details { padding: 0 1rem 1rem 2rem; }
dl { display: grid; gap: .75rem; font-size: .8rem; }
dl > div { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 1rem; }
dt { font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
.tool-empty { text-align: center; padding: 2rem; }
@media (max-width: 1100px) { .mcp-connection, .tool-toolbar { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 600px) { summary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: .5rem; } .tool-record__states { grid-column: 2; grid-row: 2; justify-content: flex-start; max-width: none; } summary > .v-icon:last-child { grid-column: 3; grid-row: 1; } .tool-record__details { padding-inline: 0; } dl > div { grid-template-columns: 1fr; gap: .25rem; } }
@media (forced-colors: active) { .mcp-connection, .tool-record__state { border-color: CanvasText; background: Canvas; color: CanvasText; } }
</style>
