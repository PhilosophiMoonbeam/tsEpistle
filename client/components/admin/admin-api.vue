<template>
  <v-container fluid class="admin-api api-workspace">
    <admin-hero :title="$t('admin:api.apiAccess')" :description="$t('admin:api.giveEveryApplicationAgent')" :eyebrow="$t('admin:api.intelligenceConnections')" icon="mdi-api">
      <template #status><v-chip v-if="loadState === 'success'" size="small" :color="enabled ? 'success' : 'warning'">{{ enabled ? $t('admin:api.apiKeyAccessEnabled') : $t('admin:api.apiKeyAccessDisabled') }}</v-chip></template>
      <template #actions><v-btn variant="text" prepend-icon="mdi-refresh" :loading="loadState === 'loading'" :disabled="adminApiBusy" @click="refresh()">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:api.reloadApiKeysSettings') }}</v-tooltip></v-btn><v-btn color="primary" prepend-icon="mdi-plus" :disabled="loadState !== 'success' || adminApiBusy || (!createFullAccess && !assignableGroups.length)" @click="newKey()">{{ $t('admin:api.createKey') }}</v-btn></template>
    </admin-hero>
    <v-alert v-if="loadState === 'error'" type="error" variant="tonal" class="mb-4">{{ $t('admin:api.credentialInventoryCouldNot') }} <v-btn variant="text" @click="refresh(false)">{{ $t('admin:api.retry') }}</v-btn></v-alert>
    <v-alert v-if="loadState === 'success' && !enabled" type="warning" variant="tonal" class="mb-4">{{ $t('admin:api.apiKeyAuthenticationDisabled') }}</v-alert>
    <v-tabs v-model="section" color="primary" class="api-tabs" show-arrows :aria-label="$t('admin:api.apiAdministrationSections')">
      <v-tab id="api-tab-credentials" value="credentials" aria-controls="api-panel-credentials">{{ $t('admin:api.credentials') }}</v-tab>
      <v-tab id="api-tab-connect" value="connect" aria-controls="api-panel-connect">{{ $t('admin:api.connectClient') }}</v-tab>
      <v-tab id="api-tab-explore" value="explore" aria-controls="api-panel-explore">{{ $t('admin:api.graphqlExplorer') }}</v-tab>
    </v-tabs>
    <section v-show="section === 'credentials'" id="api-panel-credentials" role="tabpanel" aria-labelledby="api-tab-credentials">
      <v-skeleton-loader v-if="loadState === 'loading'" type="article, table-tbody" />
      <template v-else-if="loadState === 'success'">
        <div class="api-inventory-intro"><div><h2>{{ $t('admin:api.credentialRegister') }}</h2><p>{{ $t('admin:api.oneKeyPerIntegration') }}</p></div><dl class="api-counts"><div><dt>{{ $t('admin:api.active2') }}</dt><dd>{{ activeKeyCount }}</dd></div><div><dt>{{ $t('admin:api.expired2') }}</dt><dd>{{ expiredKeyCount }}</dd></div><div><dt>{{ $t('admin:api.revoked2') }}</dt><dd>{{ revokedKeyCount }}</dd></div></dl></div>
        <v-alert v-if="connectionError" type="info" variant="tonal" class="mb-4">{{ $t('admin:api.groupNamesConnectionSettings') }} <v-btn size="small" variant="text" @click="loadConnections">{{ $t('admin:api.retryDetails') }}</v-btn></v-alert>
        <div class="api-filters"><v-text-field v-model="keySearch" :label="$t('admin:api.findKeyGroupKey')" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable /><v-select v-model="keyFilter" :label="$t('admin:api.keyStatus')" :items="keyFilterOptions" variant="outlined" density="compact" hide-details /><span role="status">{{ $t('admin:api.of', { filteredKeysCount: filteredKeys.length, keysCount: keys.length, interpolation: { escapeValue: false } }) }}</span></div>
        <div v-if="filteredKeys.length" class="api-register">
          <details v-for="key in filteredKeys" :key="key.id" class="api-record">
            <summary><span class="api-key-identity"><strong>{{ key.name }}</strong><small>{{ groupName(key) }}</small></span><span class="api-key-expiry"><small>{{ keyState(key) === 'expired' ? $t('admin:api.expired2') : $t('admin:api.expires') }}</small>{{ formatDate(key.expiration) }}</span><v-chip size="small" :color="keyState(key) === 'active' ? 'success' : keyState(key) === 'expired' ? 'warning' : undefined">{{ keyState(key) }}</v-chip><v-icon size="18">mdi-chevron-down</v-icon></summary>
            <div class="api-key-detail"><dl><div><dt>{{ $t('admin:api.keyEnding') }}</dt><dd><code>{{ key.keyShort }}</code></dd></div><div><dt>{{ $t('admin:api.headerCreated') }}</dt><dd>{{ formatDate(key.createdAt) }}</dd></div><div><dt>{{ $t('admin:api.issuedPermissionGroup') }}</dt><dd>{{ groupName(key) }}<span v-if="key.grant.groupId"> · #{{ key.grant.groupId }}</span></dd></div><div><dt>{{ $t('admin:api.mcpResourceBinding') }}</dt><dd>{{ key.grant.mcpResource || $t('admin:api.noMcpBindingWas') }}</dd></div></dl>
              <v-alert v-if="key.grant.mcpResource && (key.grant.mcpResourceVersion !== 1 || (connections && key.grant.mcpResource !== connections.mcpResource))" type="warning" variant="tonal" class="mb-3">{{ $t('admin:api.bindingDoesNotMatch') }}</v-alert>
              <p>{{ key.grant.groupId === 1 ? $t('admin:api.keyCarriesSystemAdministrator') : !key.grant.groupId ? $t('admin:api.issuedGrantCouldNot') : $t('admin:api.groupsCurrentPermissionsPage') }}</p>
              <p v-if="keyState(key) === 'active' && !enabled" class="api-note">{{ $t('admin:api.credentialHasNotExpired') }}</p>
              <div class="api-record-actions"><v-btn variant="outlined" :disabled="adminApiBusy" prepend-icon="mdi-key-plus" @click="newKey(key)">{{ $t('admin:api.createReplacement') }}</v-btn><v-btn v-if="!key.isRevoked && key.canRevoke" variant="text" color="error" :disabled="adminApiBusy" @click="revoke(key)">{{ $t('admin:api.revokeKey') }}</v-btn></div>
            </div>
          </details>
        </div>
        <div v-else class="api-empty"><v-icon size="36" color="primary">mdi-key-outline</v-icon><h3>{{ keys.length ? $t('admin:api.noMatchingCredentials') : $t('admin:api.dedicatedIdentityEachConnection') }}</h3><p>{{ keys.length ? $t('admin:api.tryAnotherNameChoose') : $t('admin:api.createScopedKeyConfigure') }}</p><v-btn v-if="keys.length" variant="text" @click="keySearch = ''; keyFilter = 'all'">{{ $t('admin:api.showAllKeys') }}</v-btn><v-btn v-else color="primary" @click="newKey()">{{ $t('admin:api.createFirstKey') }}</v-btn></div>
        <p class="api-note mt-4">{{ $t('admin:api.statusBasedExpiryRevocation') }}</p>
        <div class="api-access-control"><div><h3>{{ $t('admin:api.apiKeyAuthentication') }}</h3><p>{{ enabled ? $t('admin:api.disableApiKeyRequests') : $t('admin:api.enableApiKeyRequests') }}</p></div><v-btn :color="enabled ? 'error' : 'primary'" variant="outlined" :disabled="adminApiBusy" :loading="isToggleLoading" @click="enabled ? disableDialog = true : globalSwitch()">{{ enabled ? $t('admin:api.disableApiKeyAccess') : $t('admin:api.enableApiKeyAccess') }}</v-btn></div>
      </template>
    </section>
    <section v-show="section === 'connect'" id="api-panel-connect" role="tabpanel" aria-labelledby="api-tab-connect"><admin-api-connect :connections="connections" :loading="connectionLoading" :error="connectionError" :enabled="enabled" @retry="loadConnections" @create="newKey()" /></section>
    <section v-show="section === 'explore'" id="api-panel-explore" role="tabpanel" aria-labelledby="api-tab-explore">
      <div class="api-explorer-intro"><div><span class="api-kicker">{{ $t('admin:api.interactiveSchema') }}</span><h2>{{ $t('admin:api.exploreShapeWiki') }}</h2><p>{{ $t('admin:api.useGraphqlWorkspaceInspect') }}</p><v-btn color="primary" prepend-icon="mdi-code-braces" href="/graphql" target="_blank" rel="noopener">{{ $t('admin:api.openGraphqlWorkspace') }}<v-icon end size="16">mdi-open-in-new</v-icon></v-btn></div><aside><h3>{{ $t('admin:api.sessionStartingPoint') }}</h3><p>{{ $t('admin:api.explorerUsesSignedBrowser') }}</p><p>{{ $t('admin:api.evaluateKeyUseBearer') }}</p></aside></div>
      <div class="api-explorer-principles"><div><span>01</span><h3>{{ $t('admin:api.discover') }}</h3><p>{{ $t('admin:api.browseTypesFieldsArguments') }}</p></div><div><span>02</span><h3>{{ $t('admin:api.compose') }}</h3><p>{{ $t('admin:api.useVariablesAutocompleteBuild') }}</p></div><div><span>03</span><h3>{{ $t('admin:api.inspect') }}</h3><p>{{ $t('admin:api.reviewReturnedDataPermission') }}</p></div></div>
    </section>
    <create-api-key v-model="isCreateDialogShown" :refresh-api-keys="refresh" :connections="connections" :assignable-groups="assignableGroups" :create-full-access="createFullAccess" :seed="replacementKey" @sensitive-state="credentialFlowProtected = $event" @retry-connections="loadConnections" />
    <v-dialog v-model="isRevokeConfirmDialogShown" max-width="520" persistent aria-labelledby="revoke-api-key-dialog-title"><v-card><v-card-title id="revoke-api-key-dialog-title">{{ $t('admin:api.revokeKey2') }}</v-card-title><v-card-text><strong>{{ current?.name }}</strong> {{ $t('admin:api.willStopAuthenticatingNew') }}</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="revokeLoading" @click="isRevokeConfirmDialogShown = false">{{ $t('admin:api.keepKey') }}</v-btn><v-btn color="error" :loading="revokeLoading" @click="revokeConfirm">{{ $t('admin:api.revokeKey') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="disableDialog" max-width="520" persistent aria-labelledby="disable-api-title"><v-card><v-card-title id="disable-api-title">{{ $t('admin:api.disableApiKeyAccess2') }}</v-card-title><v-card-text>{{ $t('admin:api.allApiKeyIntegrations') }}</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="isToggleLoading" @click="disableDialog = false">{{ $t('admin:api.keepEnabled') }}</v-btn><v-btn color="error" :loading="isToggleLoading" @click="disableApi">{{ $t('admin:api.disableAccess') }}</v-btn></v-card-actions></v-card></v-dialog>
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
      return [{ title: this.$t('admin:api.allKeys', { keysCount: this.keys.length, interpolation: { escapeValue: false } }), value: 'all' }, { title: this.$t('admin:api.active', { activeKeyCount: this.activeKeyCount, interpolation: { escapeValue: false } }), value: 'active' }, { title: this.$t('admin:api.expired', { expiredKeyCount: this.expiredKeyCount, interpolation: { escapeValue: false } }), value: 'expired' }, { title: this.$t('admin:api.revoked', { revokedKeyCount: this.revokedKeyCount, interpolation: { escapeValue: false } }), value: 'revoked' }, { title: this.$t('admin:api.unknownExpiry'), value: 'unknown' }]
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
    formatDate (date: string): string { return Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : this.$t('admin:api.unknown') },
    groupName (key: AdminApiKey): string {
      if (key.grant.groupId === 1) return this.$t('admin:api.systemAdministrator')
      if (!key.grant.groupId) return this.$t('admin:api.issuedPermissionsUnavailable')
      return this.connections?.groups.find(group => group.id === key.grant.groupId)?.name || this.$t('admin:api.group', { groupId: key.grant.groupId, interpolation: { escapeValue: false } })
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
        const bootstrap = await fetchAdminApiBootstrap(window.fetch.bind(window), this.$t('admin:api.adminApiBootstrapResponse'))
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
.api-workspace { padding-bottom: calc(var(--wiki-footer-height) + 2rem) !important; min-width: 0; }
.api-tabs { border-bottom: 1px solid var(--wiki-surface-border); margin-bottom: 1rem; }
.api-kicker { font-size: .75rem; font-weight: 600; color: var(--wiki-text-muted); }
h2 { font: 600 1.25rem/1.4 var(--wiki-font-display); margin-block: .25rem .5rem; }
h3 { font: 600 1rem/1.4 var(--wiki-font-display); margin-bottom: .5rem; }
p { font-size: .875rem; line-height: 1.6; margin-bottom: .75rem; }
.api-inventory-intro { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; margin-block: .75rem 1rem; align-items: start; }
.api-inventory-intro > div { flex: 1 1 20rem; min-width: 0; }.api-inventory-intro p { max-width: 65ch; }
.api-counts { display: flex; gap: 1.5rem; }.api-counts > div { display: flex; gap: .5rem; align-items: baseline; }.api-counts dt { font-size: .8rem; color: var(--wiki-text-muted); }.api-counts dd { font: 600 1.25rem var(--wiki-font-display); margin: 0; }
.api-filters { display: grid; grid-template-columns: minmax(0, 1fr) minmax(10rem, 14rem) auto; gap: .75rem; align-items: center; margin-block: 1rem; }.api-filters > span { font-size: .8rem; color: var(--wiki-text-muted); }
.api-record { border-bottom: 1px solid var(--wiki-surface-border); }.api-record:first-child { border-top: 1px solid var(--wiki-surface-border); }
.api-record summary { cursor: pointer; display: grid; grid-template-columns: minmax(0, 1fr) 150px 85px 18px; gap: 1rem; align-items: center; padding: .85rem .5rem; list-style: none; font-size: .8rem; }.api-record summary::-webkit-details-marker { display: none; }.api-record summary:focus-visible { outline: 2px solid var(--wiki-accent-ink); outline-offset: 2px; }.api-record[open] summary > .v-icon { transform: rotate(180deg); }.api-key-identity strong { font-size: .9rem; font-weight: 600; overflow-wrap: anywhere; }.api-record summary small { display: block; font-size: .75rem; margin-block: .25rem; color: var(--wiki-text-muted); }
.api-key-detail { padding: 1rem; background: var(--wiki-surface-raised); border-top: 1px solid var(--wiki-surface-border); margin-bottom: .75rem; }.api-key-detail dl { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1rem; margin-bottom: 1rem; }.api-key-detail dt { font-size: .75rem; margin-bottom: .25rem; color: var(--wiki-text-muted); }.api-key-detail dd { font-size: .875rem; margin: 0; overflow-wrap: anywhere; }.api-key-detail code { font: .8rem var(--wiki-font-mono); }.api-key-detail p { max-width: 85ch; }.api-record-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.api-empty { text-align: center; padding: 2rem 1rem; }.api-empty h3 { margin-top: .75rem; }.api-empty p { max-width: 55ch; margin-inline: auto; }.api-note { font-size: .8rem; color: var(--wiki-text-muted); }
.api-access-control { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: start; gap: 1rem; border-top: 1px solid var(--wiki-surface-border); padding-top: 1rem; margin-top: 1.5rem; }.api-access-control > div { flex: 1 1 20rem; }.api-access-control p { max-width: 65ch; }
.api-explorer-intro { display: grid; grid-template-columns: minmax(0,1.4fr) minmax(0,1fr); gap: 1.5rem; margin-block: 1rem 1.5rem; }.api-explorer-intro aside { border-inline-start: 1px solid var(--wiki-surface-border); padding-inline-start: 1.25rem; }.api-explorer-principles { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 1rem; border-top: 1px solid var(--wiki-surface-border); padding-top: 1rem; }.api-explorer-principles span { font: 600 .8rem var(--wiki-font-body); color: var(--wiki-text-muted); display: block; margin-bottom: .5rem; }
@media(max-width: 900px) { .api-explorer-intro { grid-template-columns: 1fr; gap: 1rem; }.api-explorer-intro aside { border-inline-start: 0; padding: 1rem 0 0; border-top: 1px solid var(--wiki-surface-border); } }
@media(max-width: 600px) { .api-filters, .api-key-detail dl, .api-explorer-principles { grid-template-columns: 1fr; }.api-key-expiry { grid-column: 1; grid-row: 2; }.api-record summary { grid-template-columns: minmax(0,1fr) auto 18px; gap: .5rem .75rem; }.api-record summary > .v-chip { grid-column: 2; grid-row: 1; }.api-record summary > .v-icon { grid-column: 3; grid-row: 1; }.api-key-detail { padding: .75rem; }.api-counts { flex-wrap: wrap; gap: .5rem 1rem; }.api-access-control .v-btn, .api-record-actions .v-btn { min-height: 44px; height: auto; white-space: normal; max-width: 100%; } }
</style>
