<template>
  <div class="api-connect">
    <div class="connect-heading"><span class="connect-kicker">{{ $t('admin:apiConnect.integrationWorkbench') }}</span><h2>{{ $t('admin:apiConnect.chooseConnection') }}</h2><p>{{ $t('admin:apiConnect.restStraightforwardResourceAccess') }}</p></div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ $t('admin:apiConnect.connectionSettingsCouldNot') }} <v-btn variant="text" @click="$emit('retry')">{{ $t('admin:apiConnect.retry') }}</v-btn></v-alert>
    <v-progress-linear v-if="loading" indeterminate color="primary" :aria-label="$t('admin:apiConnect.loadingConnectionSettings')" />
    <v-radio-group v-model="protocol" inline :label="$t('admin:apiConnect.clientProtocol')" color="primary"><v-radio :label="$t('admin:apiConnect.restV1')" value="rest" /><v-radio :label="$t('admin:apiConnect.graphql')" value="graphql" /><v-radio :label="$t('admin:apiConnect.mcp')" value="mcp" /></v-radio-group>
    <div class="connect-grid">
      <section class="connect-panel"><span class="connect-kicker">{{ $t('admin:apiConnect.n01Endpoint') }}</span><h3>{{ protocolTitle }}</h3><code class="endpoint-value">{{ endpoint || $t('admin:apiConnect.canonicalMcpResourceUnavailable') }}</code>
        <p v-if="protocol === 'mcp'">{{ $t('admin:apiConnect.useStreamableHttpKey') }}</p><p v-else>{{ $t('admin:apiConnect.authenticateEachRequest') }} <code>Authorization: Bearer &lt;API_KEY&gt;</code>{{ $t('admin:apiConnect.keepCredentialClientsSecret') }}</p>
        <v-alert v-if="protocol === 'mcp' && connections && !connections.mcpEnabled" type="warning" variant="tonal">{{ $t('admin:apiConnect.mcpDisabledDeploymentConfigure') }}</v-alert><v-alert v-if="protocol === 'mcp' && connections?.mcpConfigurationError" type="error" variant="tonal">{{ $t('admin:apiConnect.configuredPublicOriginCannot') }}</v-alert>
        <dl class="connection-facts"><div><dt>{{ $t('admin:apiConnect.apiKeyAuthentication') }}</dt><dd>{{ enabled ? $t('admin:apiConnect.enabled') : $t('admin:apiConnect.disabled') }}</dd></div><div><dt>{{ $t('admin:apiConnect.authorization') }}</dt><dd>{{ $t('admin:apiConnect.issuedGroupsCurrentPermissions') }}</dd></div><div v-if="protocol === 'mcp'"><dt>{{ $t('admin:apiConnect.mcpRuntime') }}</dt><dd>{{ connections ? connections.mcpEnabled ? $t('admin:apiConnect.configuredEnabled') : $t('admin:apiConnect.disabled') : $t('admin:apiConnect.notLoaded') }}</dd></div></dl>
        <p class="connection-note">{{ $t('admin:apiConnect.configurationShownHereNot') }}</p><div class="connection-actions"><v-btn variant="outlined" prepend-icon="mdi-content-copy" :disabled="!endpoint" @click="copy(endpoint || '')">{{ $t('admin:apiConnect.copyEndpoint') }}</v-btn><v-btn variant="text" @click="$emit('create')">{{ $t('admin:apiConnect.createKey') }}</v-btn></div>
      </section>
      <section class="connect-example"><span class="connect-kicker">{{ $t('admin:apiConnect.n02FirstRequest') }}</span><h3>{{ protocol === 'mcp' ? $t('admin:apiConnect.configureAgentClient') : $t('admin:apiConnect.readSmallPageInventory') }}</h3><p>{{ protocol === 'mcp' ? $t('admin:apiConnect.enterEndpointBearerCredential') : $t('admin:apiConnect.setWikiApiKey') }}</p>
        <pre tabindex="0" :aria-label="$t('admin:apiConnect.connectionExample', { protocolTitle, interpolation: { escapeValue: false } })">{{ example }}</pre><v-btn variant="text" prepend-icon="mdi-content-copy" :disabled="!endpoint" @click="copy(example)">{{ $t('admin:apiConnect.copyExample') }}</v-btn><p v-if="copied" class="connection-note" role="status">{{ copied }}</p>
        <p v-if="protocol === 'mcp'" class="connection-note">{{ $t('admin:apiConnect.mcpCapableKeysAlso') }}</p>
        <a v-if="protocol === 'rest'" :href="openApiEndpoint" target="_blank" rel="noopener" class="reference-link">{{ $t('admin:apiConnect.openOpenapiContract') }} <v-icon size="16">mdi-open-in-new</v-icon></a><a v-if="protocol === 'graphql'" href="/graphql" target="_blank" rel="noopener" class="reference-link">{{ $t('admin:apiConnect.openGraphqlWorkspace') }} <v-icon size="16">mdi-open-in-new</v-icon></a>
      </section>
    </div>
    <section class="connection-checks"><h3>{{ $t('admin:apiConnect.whenRequestDoesNot') }}</h3><dl><div><dt>{{ $t('admin:apiConnect.n401Authentication') }}</dt><dd>{{ $t('admin:apiConnect.checkApiKeyEnablement') }}</dd></div><div><dt>{{ $t('admin:apiConnect.n403Authorization') }}</dt><dd>{{ $t('admin:apiConnect.reviewKeysPermissionGroup') }}</dd></div><div><dt>{{ $t('admin:apiConnect.browserSessions') }}</dt><dd>{{ $t('admin:apiConnect.internal') }} <code>/_api</code> {{ $t('admin:apiConnect.routesBelongApplicationReject') }}</dd></div></dl></section>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { apiAccessContract } from '../../../shared/api-access.ts'
import type { ApiConnectionInfo } from '../../../shared/api-admin.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const { connections, loading, error, enabled } = defineProps<{ connections: ApiConnectionInfo | null; loading: boolean; error: boolean; enabled: boolean }>()
defineEmits<{ retry: []; create: [] }>()
const protocol = ref('rest')
const copied = ref('')
const protocolTitle = computed(() => ({ rest: t('admin:apiConnect.restV1'), graphql: 'GraphQL', mcp: t('admin:apiConnect.modelContextProtocol') })[protocol.value] || t('admin:apiConnect.restV1'))
const endpoint = computed(() => protocol.value === 'mcp' ? connections?.mcpResource : `${window.location.origin}${protocol.value === 'graphql' ? apiAccessContract.graphqlPath : apiAccessContract.externalRestPrefix}`)
const openApiEndpoint = `${window.location.origin}${apiAccessContract.openApiPath}`
const example = computed(() => {
  if (protocol.value === 'mcp') return `Transport: Streamable HTTP\nURL: ${endpoint.value || t('admin:apiConnect.canonicalMcpResource')}\nAuthorization: Bearer <API_KEY>`
  const auth = '  --header "Authorization: Bearer $WIKI_API_KEY"'
  if (protocol.value === 'rest') return `curl '${endpoint.value}/pages?limit=10' \\\n${auth}`
  return `curl '${endpoint.value}' \\\n${auth} \\\n  --header 'Content-Type: application/json' \\\n  --data '{"query":"query { pages { list(limit: 10) { id title path locale } } }"}'`
})
async function copy(value: string) { try { await navigator.clipboard.writeText(value); copied.value = t('admin:apiConnect.copiedClipboard') } catch { copied.value = t('admin:apiConnect.copyFailedSelectText') } }
</script>
<style scoped>
.connect-kicker { font-size: .7rem; letter-spacing: .09em; text-transform: uppercase; color: var(--wiki-accent-ink); }
h2 { font: 500 2rem var(--wiki-font-display); margin-block: .5rem 1rem; }h3 { font: 500 1.3rem var(--wiki-font-display); margin-block: .5rem 1rem; }p, dd { font-size: .85rem; line-height: 1.75; }.connect-heading { max-width: 75ch; margin-bottom: 1rem; }.connect-heading p { margin-bottom: 1rem; }
.connect-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1.2fr); gap: 2rem; align-items: start; }.connect-panel { padding: 1.5rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); }.connect-panel p { margin-block: 1rem; }.connect-example { min-width: 0; padding-block: .75rem; }.connect-example p { margin-bottom: 1rem; }
code { font: .8rem var(--wiki-font-mono); overflow-wrap: anywhere; }.endpoint-value { display: block; padding-block: .5rem; }.connection-facts { margin-block: 1.5rem; display: grid; gap: 1rem; }.connection-facts dt { font-size: .7rem; }.connection-facts dd { margin: .3rem 0 0; }.connection-note { font-size: .75rem; }.connection-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: .78rem/1.8 var(--wiki-font-mono); padding: 1.25rem; background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); margin-block: 1rem; }pre:focus-visible { outline: 2px solid var(--wiki-accent-ink); }.reference-link { display: inline-flex; align-items: center; gap: .5rem; margin-top: .75rem; font-size: .85rem; color: var(--wiki-accent-ink); }
.connection-checks { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--wiki-surface-border); }.connection-checks dl { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 2rem; }.connection-checks dt { font-size: .85rem; font-weight: 500; }.connection-checks dd { margin: .5rem 0 0; }
@media(max-width: 950px) { .connect-grid, .connection-checks dl { grid-template-columns: 1fr; gap: 1rem; } }
</style>
