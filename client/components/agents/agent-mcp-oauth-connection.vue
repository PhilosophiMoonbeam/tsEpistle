<template>
  <section class="mcp-oauth" :aria-label="t('accountForEndpoint', { name: server.displayName, interpolation: { escapeValue: false } })" :aria-busy="busy">
    <p v-if="loading" role="status">{{ t('loadingStatus') }}</p>
    <template v-else-if="oauth">
      <p role="status">{{ t(!oauth.configured ? 'notConfigured' : oauth.reconnectRequired ? 'reconnectRequired' : oauth.connected ? 'connected' : 'notConnected') }}</p>
      <dl class="mcp-oauth__metadata">
        <template v-if="oauth.issuer"><dt>{{ t('issuer') }}</dt><dd>{{ oauth.issuer }}</dd></template>
        <template v-if="oauth.registrationMode"><dt>{{ t('registrationMode') }}</dt><dd>{{ t(oauth.registrationMode) }}</dd></template>
        <template v-if="oauth.callbackUrl"><dt>{{ t('callbackUrl') }}</dt><dd><code>{{ oauth.callbackUrl }}</code></dd></template>
      </dl>
      <details v-if="oauth.scopes.length"><summary>{{ t('scopes') }}</summary><ul><li v-for="scope in oauth.scopes" :key="scope"><code>{{ scope }}</code></li></ul></details>
      <div class="mcp-oauth__actions">
        <v-btn color="primary" variant="tonal" prepend-icon="mdi-account-key-outline" :loading="connecting" :disabled="busy || disabled || !isCurrent || !oauth.configured" @click="connect">{{ t(oauth.connected || oauth.reconnectRequired ? 'reconnect' : 'connect') }}</v-btn>
        <v-btn v-if="oauth.connected || oauth.reconnectRequired" color="error" variant="text" :loading="disconnecting" :disabled="busy || disabled || !isCurrent" @click="disconnect">{{ t('disconnect') }}</v-btn>
      </div>
    </template>
    <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
    <p v-if="notice" role="status">{{ notice }}</p>
    <v-btn variant="text" size="small" prepend-icon="mdi-refresh" :disabled="busy || disabled || !isCurrent" @click="load">{{ t('refreshStatus') }}</v-btn>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { connectExternalMcpOAuth, disconnectExternalMcpOAuth, getExternalMcpOAuth, externalMcpOAuthErrorKey, type ExternalMcpServerView, type ExternalMcpOAuthStatus } from '../../helpers/agent-control-api.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
import { wikiStore } from '../../store/index.ts'
import { requestConfirmation } from '../common/confirm-dialog.ts'

const props = defineProps<{ server: ExternalMcpServerView; csrfToken: string; ownerId: number; disabled?: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const t = useTranslate('profile:externalMcpOAuth')
const fetcher: typeof fetch = (...args) => window.fetch(...args)
const oauth = shallowRef<ExternalMcpOAuthStatus | null>(null)
const loading = ref(false), connecting = ref(false), disconnecting = ref(false)
const error = ref(''), notice = ref('')
const busy = computed(() => loading.value || connecting.value || disconnecting.value)
const isCurrent = computed(() => props.ownerId > 0 && props.ownerId === wikiStore.user.id && props.server.authMode === 'oauth')
let generation = 0
let disposed = false
let controller: AbortController | null = null
const current = (epoch: number) => !disposed && epoch === generation && isCurrent.value

async function load() {
  controller?.abort()
  const epoch = ++generation
  oauth.value = null; error.value = ''; notice.value = ''; loading.value = false; connecting.value = false; disconnecting.value = false
  if (!isCurrent.value || props.disabled || !props.csrfToken) return
  const abort = new AbortController(); controller = abort; loading.value = true
  try { const value = await getExternalMcpOAuth(fetcher, props.csrfToken, props.server.id, abort.signal); if (current(epoch)) oauth.value = value }
  catch (caught) { if (current(epoch) && !abort.signal.aborted) error.value = t(externalMcpOAuthErrorKey(caught)) }
  finally { if (current(epoch)) { loading.value = false; controller = null } }
}
async function connect() {
  if (busy.value || props.disabled || !isCurrent.value || !oauth.value?.configured) return
  const epoch = generation
  connecting.value = true; error.value = ''; notice.value = ''
  try {
    const authorizationUrl = await connectExternalMcpOAuth(fetcher, props.csrfToken, props.server.id)
    if (current(epoch) && !props.disabled) window.location.assign(authorizationUrl)
  } catch (caught) { if (current(epoch)) error.value = t(externalMcpOAuthErrorKey(caught)) }
  finally { if (current(epoch)) connecting.value = false }
}
async function disconnect() {
  if (busy.value || props.disabled || !isCurrent.value || !oauth.value || (!oauth.value.connected && !oauth.value.reconnectRequired)) return
  const epoch = generation
  disconnecting.value = true; error.value = ''; notice.value = ''
  try {
    const confirmed = await requestConfirmation({ title: t('disconnectTitle'), message: t('disconnectHelp', { name: props.server.displayName, interpolation: { escapeValue: false } }), confirmLabel: t('disconnect'), cancelLabel: t('common:actions.cancel') })
    if (!confirmed || !current(epoch) || props.disabled) return
    await disconnectExternalMcpOAuth(fetcher, props.csrfToken, props.server.id)
    if (!current(epoch)) return
    oauth.value = null
    emit('changed')
    disconnecting.value = false
    await load()
    if (current(generation)) notice.value = t('disconnected')
  } catch (caught) { if (current(epoch)) error.value = t(externalMcpOAuthErrorKey(caught)) }
  finally { if (current(epoch)) disconnecting.value = false }
}
watch(() => [props.server.id, props.server.revision, props.ownerId, props.csrfToken, props.disabled, isCurrent.value], () => { void load() }, { immediate: true })
onBeforeUnmount(() => { disposed = true; generation++; controller?.abort(); oauth.value = null })
</script>

<style scoped>
.mcp-oauth { min-width: 0; }
.mcp-oauth p { margin: .5rem 0; }
.mcp-oauth__actions { display: flex; flex-wrap: wrap; gap: .5rem; margin: .5rem 0; }
.mcp-oauth ul { padding-left: 1.25rem; }
.mcp-oauth code, .mcp-oauth dd { overflow-wrap: anywhere; font-size: .8rem; }
.mcp-oauth__metadata { display: grid; gap: .25rem; margin-block: .5rem; }
.mcp-oauth dt { font-weight: 600; }
.mcp-oauth dd { margin: 0 0 .5rem; }
</style>
