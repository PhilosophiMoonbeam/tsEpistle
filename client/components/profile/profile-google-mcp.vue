<template>
  <section id="google-workspace-connections" class="profile-section" aria-labelledby="profile-google-mcp-title">
    <header class="profile-section__header"><h2 id="profile-google-mcp-title" class="profile-section__title">{{ t('title') }}</h2><p class="profile-section__hint">{{ t('description') }}</p></header>
    <div class="profile-section__body google-connections">
      <p>{{ t('privacy') }}</p>
      <v-alert v-if="returnMessage" :type="returnStatus === 'connected' ? 'info' : 'warning'" variant="tonal" role="status">{{ returnMessage }}</v-alert>
      <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="loading || !isCurrent" @click="load">{{ t('reload') }}</v-btn>
      <p v-if="loaded && !servers.length">{{ t('empty') }}</p>
      <article v-for="server in servers" :key="server.id" class="google-connections__entry">
        <h3>{{ server.displayName }}</h3>
        <p>{{ server.destinationHost }} · {{ t(server.scope === 'admin' ? 'shared' : 'personal') }}</p>
        <agent-google-mcp-connection :server="server" :owner-id="ownerId" :csrf-token="csrfToken" :disabled="!isCurrent" />
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { googleMcpErrorKey, listAvailableExternalMcp, type ExternalMcpServerView } from '../../helpers/agent-control-api.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
import { wikiStore } from '../../store/index.ts'
import AgentGoogleMcpConnection from '../agents/agent-google-mcp-connection.vue'

const props = defineProps<{ ownerId: number; csrfToken: string }>()
const t = useTranslate('profile:googleMcp')
const route = useRoute(), router = useRouter()
const returnStatus = ref('')
const returnMessage = computed(() => returnStatus.value ? t(returnStatus.value === 'connected' ? 'returnConnected' : returnStatus.value === 'denied' ? 'returnDenied' : 'returnError') : '')
const servers = shallowRef<ExternalMcpServerView[]>([])
const loading = ref(false), loaded = ref(false), error = ref('')
const isCurrent = computed(() => props.ownerId > 0 && props.ownerId === wikiStore.user.id)
const fetcher: typeof fetch = (...args) => window.fetch(...args)
let generation = 0
let disposed = false
let controller: AbortController | null = null
async function load() {
  controller?.abort()
  const epoch = ++generation
  servers.value = []; loaded.value = false; error.value = ''; loading.value = false
  if (!isCurrent.value || !props.csrfToken) return
  const abort = new AbortController(); controller = abort; loading.value = true
  try {
    const value = await listAvailableExternalMcp(fetcher, props.csrfToken, abort.signal)
    if (!disposed && epoch === generation && isCurrent.value) {
      servers.value = value.filter(server => server.authMode === 'google' && (server.scope === 'admin' || server.ownerId === props.ownerId))
      loaded.value = true
    }
  } catch (caught) { if (!disposed && epoch === generation && isCurrent.value && !abort.signal.aborted) error.value = t(googleMcpErrorKey(caught)) }
  finally { if (!disposed && epoch === generation) { loading.value = false; controller = null } }
}
watch(() => route.query.googleOAuth, value => {
  if (typeof value !== 'string') return
  returnStatus.value = ['connected', 'denied', 'error'].includes(value) ? value : 'error'
  const query = { ...route.query }; delete query.googleOAuth
  void router.replace({ path: route.path, query, hash: '#google-workspace-connections' })
}, { immediate: true })
watch(() => [props.ownerId, props.csrfToken, isCurrent.value], () => { void load() }, { immediate: true })
onBeforeUnmount(() => { disposed = true; generation++; controller?.abort(); servers.value = [] })
</script>

<style scoped>
.google-connections { display: grid; gap: .75rem; }
.google-connections__entry { min-width: 0; padding-top: 1rem; border-top: 1px solid rgb(var(--v-theme-outline-variant)); }
.google-connections__entry h3 { font-size: 1rem; margin-bottom: .25rem; }
.google-connections__entry p { overflow-wrap: anywhere; }
</style>
