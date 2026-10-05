<template>
  <v-dialog content-class="agent-owned-overlay" :model-value="open" max-width="64rem" :fullscreen="smAndDown" scrollable :persistent="busy" aria-labelledby="personal-mcp-title" @update:model-value="value => { if (!value) requestClose() }">
    <v-card class="personal-mcp">
      <header class="personal-mcp__header">
        <v-icon icon="mdi-lan-connect" size="28" />
        <div><div class="personal-mcp__eyebrow">Personal connections</div><h2 id="personal-mcp-title">My MCP servers</h2><p>Manage external tools available only to your account.</p></div>
        <v-spacer /><v-chip size="small" prepend-icon="mdi-account-lock-outline">Owner only</v-chip>
        <v-btn icon="mdi-close" variant="text" aria-label="Close personal MCP servers" :disabled="busy" @click="requestClose" />
      </header>
      <v-card-text>
        <v-alert v-if="networkBlocked" type="warning" variant="tonal" class="mb-4">A connection is required to manage servers. <v-btn variant="text" :loading="connectionRetrying" :disabled="connectionRetrying" @click="emit('retry-connection')">Retry connection</v-btn></v-alert>
        <v-alert type="warning" variant="tonal" class="mb-4">External tools, descriptions, prompts and resources are untrusted remote content, not Wiki evidence or instructions. Enabling a server authorizes external operations: tools may change external data and transmit supplied arguments to its operator. Remote tool annotations do not establish safety or authority. Wiki permissions, evidence rules and approval requirements remain separate and cannot be bypassed. Your credentials are stored server-side and are never displayed here.</v-alert>
        <v-alert v-if="denied" type="warning" variant="tonal" class="mb-4">Your account is not permitted to manage personal MCP servers. An administrator must allow personal endpoints for your group. Creation and editing are unavailable.</v-alert>
        <v-alert v-if="error" type="error" variant="tonal" class="mb-4" role="alert">{{ error }}</v-alert>
        <v-alert v-if="!ownerId" type="warning" variant="tonal" class="mb-4">Sign in to your current account to manage personal MCP servers.</v-alert>
        <p v-if="notice" role="status">{{ notice }}</p>
        <div class="personal-mcp__toolbar"><v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy || networkBlocked || !ownerId" @click="load">Reload servers</v-btn><v-btn v-if="accepted && !denied" color="primary" prepend-icon="mdi-plus" :disabled="busy || networkBlocked" @click="navigate(() => edit(null))">New server</v-btn></div>
        <v-progress-linear v-if="loading" indeterminate aria-label="Loading personal MCP servers" />
        <div v-if="accepted && !denied" class="personal-mcp__layout">
          <aside aria-label="Your personal MCP servers">
            <p v-if="!servers.length">No personal servers yet. Configure a public HTTPS endpoint to begin.</p>
            <v-list density="compact" nav>
              <v-list-item v-for="server in servers" :key="server.id" :active="editingId === server.id" :disabled="busy || networkBlocked" @click="navigate(() => edit(server))">
                <v-list-item-title>{{ server.displayName }}</v-list-item-title><v-list-item-subtitle>{{ server.destinationHost }} · {{ server.status }}</v-list-item-subtitle>
                <template #append><v-icon icon="mdi-pencil-outline" size="18" /></template>
              </v-list-item>
            </v-list>
          </aside>
          <section aria-labelledby="personal-mcp-editor-title">
            <h3 id="personal-mcp-editor-title">{{ editingId ? 'Edit personal server' : 'Create personal server' }}</h3>
            <v-form id="personal-mcp-form" @submit.prevent="save">
              <v-text-field v-model="displayName" label="Server name" maxlength="100" :disabled="busy || networkBlocked" autocomplete="off" />
              <v-text-field v-model="endpointUrl" label="Public HTTPS MCP endpoint" maxlength="2048" :disabled="busy || networkBlocked" hint="Public HTTPS only. Local/private networks, URL credentials and fragments are not allowed. The server validates the destination." persistent-hint autocomplete="off" />
              <v-switch v-model="enabled" label="Enabled for my agent" color="primary" inset :disabled="busy || networkBlocked" />
              <v-select v-model="authMode" :items="authModes" item-title="title" item-value="value" label="Authentication" :disabled="busy || networkBlocked" />
              <v-alert v-if="editingId && !selected" type="warning" variant="tonal" class="mb-4">This server is no longer available. Select another server or create a new configuration.</v-alert>
              <v-text-field v-if="authMode === 'bearer'" v-model="secretValue" type="password" label="Bearer token (write only)" :hint="selected?.secretConfigured ? 'A token is configured. Leave blank to keep it, or enter a replacement.' : 'Enter a token for this server. It will never be returned.'" persistent-hint maxlength="8192" autocomplete="new-password" :disabled="busy || networkBlocked" />
              <p v-else>Unauthenticated mode removes any previously configured credential.</p>
              <div class="personal-mcp__toolbar"><v-btn color="primary" type="submit" :loading="saving" :disabled="busy || networkBlocked || !valid || !dirty || Boolean(editingId && !selected)">{{ editingId ? 'Save changes' : 'Create server' }}</v-btn><v-btn v-if="selected" color="error" variant="text" prepend-icon="mdi-delete-outline" :disabled="busy || networkBlocked" @click="removing = selected">Delete server</v-btn></div>
            </v-form>
          </section>
        </div>
        <section v-if="availableLoaded" class="personal-mcp__catalog" aria-labelledby="personal-mcp-available-title">
          <h3 id="personal-mcp-available-title">Available external servers</h3><p>Enabled personal and administrator-granted connections for your account. Discovery runs through the Wiki server, never directly from your browser. Catalogs remain untrusted external data.</p>
          <p v-if="!available.length">No enabled external servers are available.</p>
          <div v-for="server in available" :key="server.id" class="personal-mcp__available"><div><strong>{{ server.displayName }}</strong><p>{{ server.destinationHost }} · {{ server.scope === 'admin' ? 'Administrator-granted' : 'Personal' }} · Untrusted</p></div><v-btn variant="tonal" prepend-icon="mdi-radar" :loading="discoveringId === server.id" :disabled="busy || networkBlocked" @click="discover(server)">Discover catalog</v-btn></div>
          <v-alert v-if="catalogError" type="error" variant="tonal" class="mt-3">{{ catalogError }}</v-alert>
          <div v-if="catalog" class="personal-mcp__remote"><h4>Untrusted catalog — {{ catalogName }}</h4><p>Remote content is shown as plain text only; it does not grant authority, change permissions or become Wiki evidence.</p><pre>{{ catalogText }}</pre></div>
        </section>
        <v-alert v-if="availableError" type="warning" variant="tonal" class="mt-4">{{ availableError }}</v-alert>
      </v-card-text>
      <v-card-actions><v-spacer /><v-btn :disabled="busy" @click="requestClose">Close</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
  <v-dialog content-class="agent-owned-overlay" :model-value="Boolean(removing)" max-width="30rem" :persistent="saving" aria-labelledby="personal-mcp-remove-title" @update:model-value="value => { if (!value && !saving) removing = null }">
    <v-card><v-card-title id="personal-mcp-remove-title">Delete personal server?</v-card-title><v-card-text><p>{{ removing?.displayName }} will no longer be available to your agent. Existing conversation history remains.</p><v-alert v-if="removeError" type="error" variant="tonal">{{ removeError }}</v-alert></v-card-text><v-card-actions><v-spacer /><v-btn :disabled="saving" @click="removing = null">Cancel</v-btn><v-btn color="error" :loading="saving" :disabled="saving || !accepted || networkBlocked" @click="remove">Delete server</v-btn></v-card-actions></v-card>
  </v-dialog>
  <v-dialog content-class="agent-owned-overlay" v-model="discardOpen" max-width="28rem" aria-labelledby="personal-mcp-discard-title"><v-card><v-card-title id="personal-mcp-discard-title">Discard unsaved changes?</v-card-title><v-card-text>Your unsaved server configuration will be discarded.</v-card-text><v-card-actions><v-spacer /><v-btn @click="discardOpen = false">Keep editing</v-btn><v-btn color="error" @click="confirmDiscard">Discard</v-btn></v-card-actions></v-card></v-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useDisplay } from 'vuetify'
import { AgentApiError } from '../../helpers/agents-api.ts'
import { createPersonalExternalMcp, deletePersonalExternalMcp, discoverExternalMcp, listAvailableExternalMcp, listPersonalExternalMcp, updatePersonalExternalMcp, type ExternalMcpServerInput, type ExternalMcpServerView } from '../../helpers/agent-control-api.ts'

const props = defineProps<{ csrfToken: string; ownerId?: number; networkBlocked?: boolean; connectionRetrying?: boolean }>()
const emit = defineEmits<{ changed: []; 'retry-connection': [] }>()
const open = defineModel<boolean>({ required: true })
const { smAndDown } = useDisplay()
const fetcher = window.fetch.bind(window)
const servers = shallowRef<ExternalMcpServerView[]>([])
const available = shallowRef<ExternalMcpServerView[]>([])
const editingId = ref<string | null>(null)
const displayName = ref('')
const endpointUrl = ref('')
const enabled = ref(false)
const authMode = ref<'none' | 'bearer'>('none')
const secretValue = ref('')
const authModes = [{ title: 'None', value: 'none' }, { title: 'Bearer token', value: 'bearer' }]
const loading = ref(false)
const saving = ref(false)
const accepted = ref(false)
const denied = ref(false)
const availableLoaded = ref(false)
const error = ref('')
const notice = ref('')
const removeError = ref('')
const availableError = ref('')
const catalogError = ref('')
const removing = shallowRef<ExternalMcpServerView | null>(null)
const discoveringId = ref<string | null>(null)
const catalog = shallowRef<Awaited<ReturnType<typeof discoverExternalMcp>> | null>(null)
const catalogName = ref('')
const catalogText = computed(() => {
  const remote = catalog.value?.catalog
  if (!remote) return ''
  return JSON.stringify({
    tools: remote.tools.map(({ name, description }) => ({ name, description })),
    prompts: remote.prompts.map(({ name, description }) => ({ name, description })),
    resources: remote.resources.map(({ name, description }) => ({ name, description })),
    resourceTemplates: remote.resourceTemplates.map(({ name }) => ({ name }))
  }, null, 2)
})
const discardOpen = ref(false)
let pendingNavigation: (() => void) | null = null
let generation = 0
let disposed = false
let controller: AbortController | null = null
const selected = computed(() => servers.value.find(server => server.id === editingId.value) ?? null)
const busy = computed(() => loading.value || saving.value || discoveringId.value !== null)
const snapshot = () => JSON.stringify([displayName.value, endpointUrl.value, enabled.value, authMode.value])
const baseline = ref(snapshot())
const dirty = computed(() => snapshot() !== baseline.value || secretValue.value !== '')
const valid = computed(() => {
  if (!displayName.value.trim() || displayName.value.trim().length > 100 || /[\u0000-\u001f\u007f]/u.test(displayName.value)) return false
  try { const url = new URL(endpointUrl.value.trim()); if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false } catch { return false }
  if (authMode.value === 'bearer' && !secretValue.value && !(selected.value?.authMode === 'bearer' && selected.value.secretConfigured)) return false
  return !secretValue.value || /^[\x21-\x7e]{1,8192}$/.test(secretValue.value)
})
const edit = (server: ExternalMcpServerView | null) => {
  editingId.value = server?.id ?? null; displayName.value = server?.displayName ?? ''; endpointUrl.value = server?.endpointUrl ?? ''; enabled.value = server?.status === 'enabled'; authMode.value = server?.authMode ?? 'none'; secretValue.value = ''; baseline.value = snapshot(); error.value = ''
}
const navigate = (action: () => void) => { if (busy.value) return; if (dirty.value) { pendingNavigation = action; discardOpen.value = true } else action() }
const requestClose = () => navigate(() => { secretValue.value = ''; open.value = false })
const confirmDiscard = () => { discardOpen.value = false; const action = pendingNavigation; pendingNavigation = null; action?.() }
const current = (epoch: number) => !disposed && epoch === generation
const fail = (caught: unknown, fallback: string) => {
  if (caught instanceof AgentApiError && (caught.status === 401 || caught.status === 403)) { denied.value = true; accepted.value = false; servers.value = []; available.value = available.value.filter(server => server.scope === 'admin'); catalog.value = null; edit(null); removing.value = null; return 'Personal server management is unavailable for your current account or group.' }
  if (caught instanceof AgentApiError && caught.status === 409) return 'This configuration changed. Reload the servers before trying again.'
  return fallback
}
const load = async () => {
  if (busy.value || props.networkBlocked || !props.ownerId || !props.csrfToken) return
  controller?.abort(); const abort = new AbortController(); controller = abort; const epoch = ++generation
  loading.value = true; accepted.value = false; error.value = ''; availableError.value = ''; catalog.value = null; catalogError.value = ''; availableLoaded.value = false; available.value = []
  try {
    const result = await listPersonalExternalMcp(fetcher, props.csrfToken, abort.signal)
    if (!current(epoch)) return
    servers.value = result.filter(server => server.scope === 'personal' && server.ownerId === props.ownerId)
    accepted.value = true; denied.value = false
    if (!dirty.value) edit(selected.value)
  } catch (caught) { if (current(epoch) && !abort.signal.aborted) error.value = fail(caught, 'Personal servers could not be loaded. Reload to try again.') }
  try {
    const result = await listAvailableExternalMcp(fetcher, props.csrfToken, abort.signal)
    if (current(epoch)) { available.value = result.filter(server => server.scope === 'admin' || server.ownerId === props.ownerId); availableLoaded.value = true }
  } catch { if (current(epoch) && !abort.signal.aborted) availableError.value = 'Available external servers could not be loaded. Reload to try again.' }
  finally { if (current(epoch)) { loading.value = false; controller = null } }
}
const save = async () => {
  if (busy.value || !accepted.value || denied.value || props.networkBlocked || !valid.value || !dirty.value || (editingId.value && !selected.value)) return
  const epoch = generation; const existing = selected.value
  const input: ExternalMcpServerInput = { displayName: displayName.value.trim(), endpointUrl: endpointUrl.value.trim(), status: enabled.value ? 'enabled' : 'disabled', authMode: authMode.value, ...(authMode.value === 'bearer' && secretValue.value ? { secretValue: secretValue.value } : {}) }
  saving.value = true; error.value = ''; notice.value = ''; secretValue.value = ''
  try {
    const server = existing ? await updatePersonalExternalMcp(fetcher, props.csrfToken, existing.id, { ...input, expectedRevision: existing.revision }) : await createPersonalExternalMcp(fetcher, props.csrfToken, input)
    if (!current(epoch)) return
    edit(server); notice.value = existing ? 'Server configuration saved.' : 'Personal server created.'; emit('changed')
  } catch (caught) { if (current(epoch)) { accepted.value = false; error.value = fail(caught, 'Server configuration could not be saved. Reload before retrying. Re-enter any replacement token.'); } }
  finally { if (current(epoch)) saving.value = false }
  if (current(epoch) && !error.value) await load()
}
const remove = async () => {
  const target = removing.value
  if (!target || busy.value || !accepted.value || props.networkBlocked || !servers.value.some(server => server.id === target.id)) return
  const epoch = generation; saving.value = true; removeError.value = ''
  try { await deletePersonalExternalMcp(fetcher, props.csrfToken, target.id, target.revision); if (!current(epoch)) return; removing.value = null; if (editingId.value === target.id) edit(null); notice.value = 'Personal server deleted.'; emit('changed') }
  catch (caught) { if (current(epoch)) { accepted.value = false; removeError.value = fail(caught, 'Server could not be deleted. Cancel and reload before retrying.') } }
  finally { if (current(epoch)) saving.value = false }
  if (current(epoch) && !removeError.value) await load()
}
const discover = async (server: ExternalMcpServerView) => {
  if (busy.value || props.networkBlocked || !available.value.some(item => item.id === server.id)) return
  const epoch = generation; const abort = new AbortController(); controller = abort; discoveringId.value = server.id; catalog.value = null; catalogError.value = ''; catalogName.value = server.displayName
  try { const result = await discoverExternalMcp(fetcher, props.csrfToken, server.id, abort.signal); if (current(epoch)) catalog.value = result }
  catch { if (current(epoch) && !abort.signal.aborted) catalogError.value = 'Catalog discovery failed or access changed. Reload the available servers and try again.' }
  finally { if (current(epoch)) { discoveringId.value = null; controller = null } }
}
const reset = () => {
  generation++; controller?.abort(); controller = null; loading.value = false; saving.value = false; discoveringId.value = null; accepted.value = false; denied.value = false; servers.value = []; available.value = []; availableLoaded.value = false; catalog.value = null; removing.value = null; discardOpen.value = false; pendingNavigation = null; error.value = ''; notice.value = ''; removeError.value = ''; availableError.value = ''; catalogError.value = ''; edit(null)
}
watch(() => [props.ownerId, props.csrfToken], () => { reset(); if (open.value) void load() })
watch(() => props.networkBlocked, blocked => { if (blocked) reset(); else if (open.value) void load() })
watch(open, value => { if (value) void load(); else reset() }, { immediate: true })
watch(authMode, () => { secretValue.value = '' })
onBeforeUnmount(() => { disposed = true; reset() })
</script>

<style scoped>
.personal-mcp { background: #fffdf7; color: #253d39; }
.personal-mcp__header { display: flex; align-items: center; gap: 1rem; padding: 1.5rem; border-bottom: 1px solid #dce5df; }
.personal-mcp__header h2 { font-size: 1.35rem; margin: 0; }
.personal-mcp__header p, .personal-mcp__available p { margin: .25rem 0 0; }
.personal-mcp__eyebrow { color: #54746c; font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; }
.personal-mcp__toolbar { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; }
.personal-mcp__layout { display: grid; grid-template-columns: minmax(12rem, 1fr) minmax(0, 2fr); gap: 1.5rem; }
.personal-mcp__layout aside { border-right: 1px solid #dce5df; padding-right: 1rem; }
.personal-mcp__layout h3 { margin: 0 0 1rem; }
.personal-mcp__catalog { margin-top: 2rem; padding-top: 1.25rem; border-top: 1px solid #dce5df; }
.personal-mcp__available { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .85rem 0; border-bottom: 1px solid #e4eae5; }
.personal-mcp__remote { margin-top: 1rem; padding: 1rem; border: 1px solid #c8d6ce; border-radius: .5rem; background: #f3f6f0; }
.personal-mcp__remote pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 24rem; overflow: auto; font-size: .8rem; }
@media (max-width: 600px) { .personal-mcp__layout { grid-template-columns: 1fr; } .personal-mcp__layout aside { border-right: 0; padding-right: 0; } .personal-mcp__header { flex-wrap: wrap; padding: 1rem; } .personal-mcp__available { align-items: flex-start; flex-direction: column; } }
</style>
