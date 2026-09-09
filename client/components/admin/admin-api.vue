<template>
  <v-container fluid class="admin-api api-workspace">
    <admin-hero title="API access" description="Give every application and agent a clear identity in your wiki." eyebrow="Intelligence & connections" icon="mdi-api">
      <template #status><v-chip v-if="loadState === 'success'" size="small" :color="enabled ? 'success' : 'warning'">{{ enabled ? 'API-key access enabled' : 'API-key access disabled' }}</v-chip></template>
      <template #actions><v-btn variant="text" prepend-icon="mdi-refresh" :loading="loadState === 'loading'" :disabled="adminApiBusy" @click="refresh()">Refresh</v-btn><v-btn color="primary" prepend-icon="mdi-plus" :disabled="loadState !== 'success' || adminApiBusy || (!createFullAccess && !assignableGroups.length)" @click="newKey()">Create key</v-btn></template>
    </admin-hero>
    <v-alert v-if="loadState === 'error'" type="error" variant="tonal" class="mb-4">Credential inventory could not be loaded. <v-btn variant="text" @click="refresh(false)">Retry</v-btn></v-alert>
    <v-alert v-if="loadState === 'success' && !enabled" type="warning" variant="tonal" class="mb-4">API-key authentication is disabled. You can prepare credentials here; applications and MCP clients can use them after access is enabled. Browser sessions remain separate.</v-alert>
    <v-tabs v-model="section" color="primary" class="api-tabs" show-arrows aria-label="API administration sections">
      <v-tab id="api-tab-credentials" value="credentials" aria-controls="api-panel-credentials">Credentials</v-tab>
      <v-tab id="api-tab-connect" value="connect" aria-controls="api-panel-connect">Connect a client</v-tab>
      <v-tab id="api-tab-explore" value="explore" aria-controls="api-panel-explore">GraphQL explorer</v-tab>
    </v-tabs>
    <section v-show="section === 'credentials'" id="api-panel-credentials" role="tabpanel" aria-labelledby="api-tab-credentials">
      <v-skeleton-loader v-if="loadState === 'loading'" type="article, table-tbody" />
      <template v-else-if="loadState === 'success'">
        <div class="api-inventory-intro"><div><span class="api-kicker">Credential register</span><h2>Know who can connect.</h2><p>One key per integration makes access easier to understand, replace and retire. Open a record to inspect its issued permissions and MCP binding.</p></div><dl class="api-counts"><div><dt>Active</dt><dd>{{ activeKeyCount }}</dd></div><div><dt>Expired</dt><dd>{{ expiredKeyCount }}</dd></div><div><dt>Revoked</dt><dd>{{ revokedKeyCount }}</dd></div></dl></div>
        <v-alert v-if="connectionError" type="info" variant="tonal" class="mb-4">Group names and connection settings are unavailable. Issued group IDs remain visible. <v-btn size="small" variant="text" @click="loadConnections">Retry details</v-btn></v-alert>
        <div class="api-filters"><v-text-field v-model="keySearch" label="Find a key, group or key ending" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable /><v-select v-model="keyFilter" label="Key status" :items="keyFilterOptions" variant="outlined" density="compact" hide-details /><span role="status">{{ filteredKeys.length }} of {{ keys.length }}</span></div>
        <div v-if="filteredKeys.length" class="api-register">
          <details v-for="key in filteredKeys" :key="key.id" class="api-record">
            <summary><span class="api-key-identity"><strong>{{ key.name }}</strong><small>{{ groupName(key) }}</small></span><span class="api-key-expiry"><small>{{ keyState(key) === 'expired' ? 'Expired' : 'Expires' }}</small>{{ formatDate(key.expiration) }}</span><v-chip size="small" :color="keyState(key) === 'active' ? 'success' : keyState(key) === 'expired' ? 'warning' : undefined">{{ keyState(key) }}</v-chip><v-icon size="18">mdi-chevron-down</v-icon></summary>
            <div class="api-key-detail"><dl><div><dt>Key ending</dt><dd><code>{{ key.keyShort }}</code></dd></div><div><dt>Created</dt><dd>{{ formatDate(key.createdAt) }}</dd></div><div><dt>Issued permission group</dt><dd>{{ groupName(key) }}<span v-if="key.grant.groupId"> · #{{ key.grant.groupId }}</span></dd></div><div><dt>MCP resource binding</dt><dd>{{ key.grant.mcpResource || 'No MCP binding was issued' }}</dd></div></dl>
              <v-alert v-if="key.grant.mcpResource && (key.grant.mcpResourceVersion !== 1 || (connections && key.grant.mcpResource !== connections.mcpResource))" type="warning" variant="tonal" class="mb-3">This binding does not match the current MCP resource contract. Create a replacement key for this deployment.</v-alert>
              <p>{{ key.grant.groupId === 1 ? 'This key carries system-administrator authority. Use a scoped group when the integration needs less access.' : !key.grant.groupId ? 'The issued grant could not be read. Create a replacement with an explicit permission source before using this integration.' : 'The group’s current permissions and page rules apply to every request. Changing the group changes what this key can do.' }}</p>
              <p v-if="keyState(key) === 'active' && !enabled" class="api-note">This credential has not expired or been revoked, but API-key authentication is currently disabled.</p>
              <div class="api-record-actions"><v-btn variant="outlined" :disabled="adminApiBusy" prepend-icon="mdi-key-plus" @click="newKey(key)">Create replacement</v-btn><v-btn v-if="!key.isRevoked && key.canRevoke" variant="text" color="error" :disabled="adminApiBusy" @click="revoke(key)">Revoke key</v-btn></div>
            </div>
          </details>
        </div>
        <div v-else class="api-empty"><v-icon size="36" color="primary">mdi-key-outline</v-icon><h3>{{ keys.length ? 'No matching credentials' : 'A dedicated identity for each connection' }}</h3><p>{{ keys.length ? 'Try another name or choose a different status.' : 'Create a scoped key, configure your client, then verify the operations it needs.' }}</p><v-btn v-if="keys.length" variant="text" @click="keySearch = ''; keyFilter = 'all'">Show all keys</v-btn><v-btn v-else color="primary" @click="newKey()">Create your first key</v-btn></div>
        <p class="api-note mt-4">Status is based on expiry and revocation. This register does not track request activity or last use.</p>
        <div class="api-access-control"><div><h3>API-key authentication</h3><p>{{ enabled ? 'Disable API-key requests across REST, GraphQL and MCP when a workspace-wide stop is needed.' : 'Enable API-key requests when your credentials and clients are ready.' }}</p></div><v-btn :color="enabled ? 'error' : 'primary'" variant="outlined" :disabled="adminApiBusy" :loading="isToggleLoading" @click="enabled ? disableDialog = true : globalSwitch()">{{ enabled ? 'Disable API-key access' : 'Enable API-key access' }}</v-btn></div>
      </template>
    </section>
    <section v-show="section === 'connect'" id="api-panel-connect" role="tabpanel" aria-labelledby="api-tab-connect"><admin-api-connect :connections="connections" :loading="connectionLoading" :error="connectionError" :enabled="enabled" @retry="loadConnections" @create="newKey()" /></section>
    <section v-show="section === 'explore'" id="api-panel-explore" role="tabpanel" aria-labelledby="api-tab-explore">
      <div class="api-explorer-intro"><div><span class="api-kicker">An interactive schema</span><h2>Explore the shape of your wiki.</h2><p>Use the GraphQL workspace to inspect schema documentation, compose queries, and examine real responses. Start with a small page inventory and expand from there.</p><v-btn color="primary" prepend-icon="mdi-code-braces" href="/graphql" target="_blank" rel="noopener">Open GraphQL workspace<v-icon end size="16">mdi-open-in-new</v-icon></v-btn></div><aside><h3>Your session is the starting point</h3><p>The explorer uses your signed-in browser session. Permissions and page rules still apply. API-key enablement does not control session access.</p><p>To evaluate a key, use its bearer token in the request headers. Header values are not intentionally persisted by the workspace. Mutations change real data.</p></aside></div>
      <div class="api-explorer-principles"><div><span>01</span><h3>Discover</h3><p>Browse types, fields and arguments in the schema documentation.</p></div><div><span>02</span><h3>Compose</h3><p>Use variables and autocomplete to build a precise request.</p></div><div><span>03</span><h3>Inspect</h3><p>Review returned data and permission errors before putting the query into an integration.</p></div></div>
    </section>
    <create-api-key v-model="isCreateDialogShown" :refresh-api-keys="refresh" :connections="connections" :assignable-groups="assignableGroups" :create-full-access="createFullAccess" :seed="replacementKey" @sensitive-state="credentialFlowProtected = $event" @retry-connections="loadConnections" />
    <v-dialog v-model="isRevokeConfirmDialogShown" max-width="520" persistent aria-labelledby="revoke-api-key-dialog-title"><v-card><v-card-title id="revoke-api-key-dialog-title">Revoke this key?</v-card-title><v-card-text><strong>{{ current?.name }}</strong> will stop authenticating new requests. Revocation cannot be undone. If replacing a key, configure and verify the new credential first.</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="revokeLoading" @click="isRevokeConfirmDialogShown = false">Keep key</v-btn><v-btn color="error" :loading="revokeLoading" @click="revokeConfirm">Revoke key</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="disableDialog" max-width="520" persistent aria-labelledby="disable-api-title"><v-card><v-card-title id="disable-api-title">Disable API-key access?</v-card-title><v-card-text>All API-key integrations, including external MCP clients, will lose authentication. Existing keys remain stored. Your browser session remains available to turn access back on.</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="isToggleLoading" @click="disableDialog = false">Keep enabled</v-btn><v-btn color="error" :loading="isToggleLoading" @click="disableApi">Disable access</v-btn></v-card-actions></v-card></v-dialog>
  </v-container>
</template>

<script lang='ts'>
import { markRaw } from 'vue'
import { wikiStore } from '@/store/index.ts'

import CreateApiKey from './admin-api-create.vue'
import AdminApiConnect from './admin-api-connect.vue'
import { apiKeyState, type ApiAssignableGroup, type ApiConnectionInfo } from '../../../shared/api-admin.ts'
import { fetchApiConnections, fetchAdminApiBootstrap, revokeAdminApiKey, setAdminApiState, type AdminApiKey } from '../../helpers/auth-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { apiAccessContract } from '../../../shared/api-access.ts'

export default {
  components: {
    CreateApiKey, AdminApiConnect
  },
  data() {
    return {
      section: ['connect', 'explore'].includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'credentials',
      connections: null as ApiConnectionInfo | null,
      connectionLoading: false,
      connectionError: false,
      replacementKey: null as AdminApiKey | null,
      credentialFlowProtected: false,
      clock: Date.now(),
      clockTimer: null as ReturnType<typeof setInterval> | null,
      enabled: false,
      createFullAccess: false,
      assignableGroups: [] as ApiAssignableGroup[],
      isToggleLoading: false,
      keys: [] as AdminApiKey[],
      keySearch: '',
      keyFilter: 'all',
      loadState: 'loading' as 'loading' | 'success' | 'error',
      isCreateDialogShown: false,
      isRevokeConfirmDialogShown: false,
      disableDialog: false,
      revokeLoading: false,
      current: null as AdminApiKey | null,
      isDisposed: false
    }
  },
  computed: {
    keyFilterOptions() {
      return [{ title: `All keys (${this.keys.length})`, value: 'all' }, { title: `Active (${this.activeKeyCount})`, value: 'active' }, { title: `Expired (${this.expiredKeyCount})`, value: 'expired' }, { title: `Revoked (${this.revokedKeyCount})`, value: 'revoked' }, { title: 'Unknown expiry', value: 'unknown' }]
    },
    filteredKeys(): AdminApiKey[] {
      const query = (this.keySearch || '').trim().toLocaleLowerCase()
      return this.keys.filter(key => `${key.name} ${key.keyShort} ${this.groupName(key)}`.toLocaleLowerCase().includes(query) && (this.keyFilter === 'all' || this.keyState(key) === this.keyFilter))
    },
    adminApiBusy(): boolean { return this.loadState === 'loading' || this.isToggleLoading || this.revokeLoading || this.credentialFlowProtected },
    activeKeyCount(): number { return this.keys.filter(key => this.keyState(key) === 'active').length },
    expiredKeyCount(): number { return this.keys.filter(key => this.keyState(key) === 'expired').length },
    revokedKeyCount(): number { return this.keys.filter(key => key.isRevoked).length },
    apiAccessContract() {
      return apiAccessContract
    },
    mcpEndpoint() { return `${window.location.origin}${apiAccessContract.mcpPath}` },
    graphqlEndpoint() {
      return `${window.location.origin}${apiAccessContract.graphqlPath}`
    },
    externalRestEndpoint() {
      return `${window.location.origin}${apiAccessContract.externalRestPrefix}`
    },
    openApiEndpoint() {
      return `${window.location.origin}${apiAccessContract.openApiPath}`
    },
    internalRestEndpoint() {
      return `${window.location.origin}${apiAccessContract.internalRestPrefix}/*`
    },
    curlExample() {
      return [
        `curl --request POST '${this.graphqlEndpoint}' \\`,
        `  --header 'Authorization: ${apiAccessContract.bearerScheme} <API_KEY>' \\`,
        "  --header 'Content-Type: application/json' \\",
        "  --data '{\"query\":\"query { system { info { currentVersion product { name version } } } }\"}'"
      ].join('\n')
    }
  },
  watch: {
    section (value: string) { window.history.replaceState(window.history.state, '', `${window.location.pathname}${value === 'credentials' ? '' : `#${value}`}`) }
  },
  beforeRouteLeave (): boolean { return !this.isCreateDialogShown && !this.credentialFlowProtected && !this.isToggleLoading && !this.revokeLoading },
  methods: {
    keyState (key: AdminApiKey) { return apiKeyState(key, this.clock) },
    formatDate (date: string): string { return Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown' },
    groupName (key: AdminApiKey): string {
      if (key.grant.groupId === 1) return 'System administrator'
      if (!key.grant.groupId) return 'Issued permissions unavailable'
      return this.connections?.groups.find(group => group.id === key.grant.groupId)?.name || `Group ${key.grant.groupId}`
    },
    async loadConnections () {
      if (this.connectionLoading || this.isDisposed) return
      this.connectionLoading = true; this.connectionError = false
      try { const info = await fetchApiConnections(window.fetch.bind(window)); if (!this.isDisposed) this.connections = info }
      catch { if (!this.isDisposed) this.connectionError = true }
      finally { if (!this.isDisposed) this.connectionLoading = false }
    },
    async loadApiBootstrap () {
      if (this.isDisposed) return false
      this.loadState = 'loading'
      wikiStore.startLoading('admin-api-state-refresh')
      wikiStore.startLoading('admin-api-keys-refresh')
      try {
        const bootstrap = await fetchAdminApiBootstrap(window.fetch.bind(window), 'Admin API bootstrap response is invalid')
        if (this.isDisposed) return false
        this.enabled = bootstrap.enabled
        this.createFullAccess = bootstrap.createFullAccess
        this.assignableGroups = markRaw(bootstrap.assignableGroups)
        this.keys = markRaw(bootstrap.keys)
        this.loadState = 'success'
        return true
      } catch (err) {
        if (this.isDisposed) return false
        this.loadState = 'error'
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
        return false
      } finally {
        wikiStore.stopLoading('admin-api-state-refresh')
        wikiStore.stopLoading('admin-api-keys-refresh')
      }
    },
    async refresh (notify = true) {
      if (this.isDisposed || this.loadState === 'loading') return false
      const loaded = await this.loadApiBootstrap()
      if (notify && loaded) {
        wikiStore.showNotification({
          message: this.$t('admin:api.refreshSuccess'),
          style: 'success',
          icon: 'cached'
        })
      }
      return loaded
    },
    async globalSwitch () {
      if (this.isDisposed || this.isToggleLoading || this.revokeLoading || this.loadState !== 'success') return
      const wasEnabled = this.enabled
      this.isToggleLoading = true
      wikiStore.startLoading('admin-api-toggle')
      try {
        await setAdminApiState(window.fetch.bind(window), !this.enabled)
        if (this.isDisposed) return
        const loaded = await this.refresh(false)
        if (loaded) {
          wikiStore.showNotification({
            style: 'success',
            message: wasEnabled ? this.$t('admin:api.toggleStateDisabledSuccess') : this.$t('admin:api.toggleStateEnabledSuccess'),
            icon: 'check'
          })
        }
      } catch (err) {
        if (!this.isDisposed) wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-api-toggle')
        if (!this.isDisposed) this.isToggleLoading = false
      }
    },
    async disableApi () {
      this.disableDialog = false
      await this.globalSwitch()
    },
    newKey (key?: AdminApiKey) {
      if (this.isDisposed || this.adminApiBusy || (!key && !this.createFullAccess && !this.assignableGroups.length)) return
      this.replacementKey = key || null
      this.isCreateDialogShown = true
    },
    revoke (key: AdminApiKey) {
      if (this.isDisposed || this.adminApiBusy || key.isRevoked || !key.canRevoke) return
      this.current = key
      this.isRevokeConfirmDialogShown = true
    },
    async revokeConfirm () {
      if (this.isDisposed || this.revokeLoading || !this.current) return
      this.revokeLoading = true
      wikiStore.startLoading('admin-api-revoke')
      try {
        await revokeAdminApiKey(window.fetch.bind(window), this.current.id)
        if (this.isDisposed) return
        const loaded = await this.refresh(false)
        if (loaded) {
          wikiStore.showNotification({
            style: 'success',
            message: this.$t('admin:api.revokeSuccess'),
            icon: 'check'
          })
        }
      } catch (err) {
        if (!this.isDisposed) wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-api-revoke')
        if (!this.isDisposed) {
          this.isRevokeConfirmDialogShown = false
          this.revokeLoading = false
        }
      }
    }
  },
  created () {
    this.loadApiBootstrap()
    this.loadConnections()
    this.clockTimer = setInterval(() => { this.clock = Date.now() }, 60000)
  },
  beforeUnmount () {
    this.isDisposed = true
    if (this.clockTimer) clearInterval(this.clockTimer)
  }
}
</script>

<style scoped>
.api-workspace { padding-bottom: calc(var(--wiki-footer-height) + 3rem) !important; }
.api-tabs { border-bottom: 1px solid var(--wiki-surface-border); margin-bottom: 1.75rem; }
.api-kicker { font-size: .7rem; letter-spacing: .09em; text-transform: uppercase; color: var(--wiki-accent-ink); }
h2 { font: 500 clamp(1.6rem, 2.5vw, 2.2rem) var(--wiki-font-display); margin-block: .5rem 1rem; }
h3 { font: 500 1.25rem var(--wiki-font-display); margin-bottom: .6rem; }
p { font-size: .85rem; line-height: 1.75; margin-bottom: 1rem; }
.api-inventory-intro { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(260px, 1fr); gap: 3rem; margin-block: 1rem 1.5rem; align-items: center; }
.api-inventory-intro p { max-width: 65ch; }.api-counts { display: grid; grid-template-columns: repeat(3,1fr); gap: 1.5rem; }.api-counts dt { font-size: .75rem; }.api-counts dd { font: 500 2.5rem var(--wiki-font-display); margin: .5rem 0; }
.api-filters { display: grid; grid-template-columns: minmax(0, 1fr) 220px auto; gap: 1rem; align-items: center; margin-block: 1.5rem; }.api-filters > span { font-size: .75rem; }
.api-record { border-bottom: 1px solid var(--wiki-surface-border); }.api-record:first-child { border-top: 1px solid var(--wiki-surface-border); }
.api-record summary { cursor: pointer; display: grid; grid-template-columns: minmax(0, 1fr) 150px 85px 18px; gap: 1.5rem; align-items: center; padding: 1.25rem .75rem; list-style: none; font-size: .8rem; }.api-record summary::-webkit-details-marker { display: none; }.api-record summary:focus-visible { outline: 2px solid var(--wiki-accent-ink); outline-offset: 2px; }.api-record[open] summary > .v-icon { transform: rotate(180deg); }.api-key-identity strong { font-size: .9rem; font-weight: 500; overflow-wrap: anywhere; }.api-record summary small { display: block; font-size: .75rem; margin-block: .35rem; }
.api-key-detail { padding: 1.5rem; background: var(--wiki-surface-raised); border-radius: var(--wiki-control-radius); margin-bottom: 1rem; }.api-key-detail dl { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1.5rem; margin-bottom: 1.5rem; }.api-key-detail dt { font-size: .7rem; margin-bottom: .4rem; }.api-key-detail dd { font-size: .85rem; margin: 0; overflow-wrap: anywhere; }.api-key-detail code { font: .8rem var(--wiki-font-mono); }.api-key-detail p { max-width: 85ch; }.api-record-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.api-empty { text-align: center; padding: 3rem 1rem; }.api-empty h3 { margin-top: 1rem; }.api-empty p { max-width: 55ch; margin-inline: auto; }.api-note { font-size: .75rem; }
.api-access-control { display: flex; justify-content: space-between; align-items: start; gap: 2rem; border-top: 1px solid var(--wiki-surface-border); padding-top: 1.5rem; margin-top: 2rem; }.api-access-control p { max-width: 65ch; }.api-access-control .v-btn { flex-shrink: 0; }
.api-explorer-intro { display: grid; grid-template-columns: minmax(0,1.4fr) minmax(0,1fr); gap: 3rem; margin-block: 1rem 3rem; }.api-explorer-intro aside { border-left: 1px solid var(--wiki-surface-border); padding-left: 2rem; }.api-explorer-principles { display: grid; grid-template-columns: repeat(3,1fr); gap: 2rem; border-top: 1px solid var(--wiki-surface-border); padding-top: 1.5rem; }.api-explorer-principles span { font: 1.8rem var(--wiki-font-display); color: var(--wiki-accent-ink); display: block; margin-bottom: 1rem; }
@media(max-width: 1000px) { .api-inventory-intro, .api-explorer-intro { grid-template-columns: 1fr; gap: 1rem; }.api-counts { max-width: 420px; }.api-explorer-intro aside { border-left: 0; padding: 1.5rem 0 0; border-top: 1px solid var(--wiki-surface-border); }.api-access-control { flex-direction: column; gap: .5rem; } }
@media(max-width: 600px) { .api-filters, .api-key-detail dl, .api-explorer-principles { grid-template-columns: 1fr; }.api-key-expiry { display: none; }.api-record summary { grid-template-columns: minmax(0,1fr) auto 18px; gap: .75rem; }.api-key-detail { padding: 1rem; } }
</style>
