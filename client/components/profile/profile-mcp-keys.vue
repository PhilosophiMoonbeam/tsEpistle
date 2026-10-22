<template>
  <section class="profile-section profile-mcp" aria-labelledby="profile-mcp-title">
    <header class="profile-section__header">
      <h2 id="profile-mcp-title" class="profile-section__title">MCP access keys</h2>
      <p class="profile-section__hint">Connect an external assistant to Wiki as you. Keys never grant more than your current permissions.</p>
    </header>
    <div class="profile-section__body profile-mcp__body">
      <p class="profile-muted text-body-small">These keys work only at the MCP endpoint, not as a Wiki sign-in or general API credential. Edits require a compatible approval-capable client and your Wiki permissions; every proposed change still needs human approval.</p>
      <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
      <p v-if="notice" role="status" class="text-body-small">{{ notice }}</p>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy || !isCurrent || Boolean(issuedKey)" @click="load">Reload access keys</v-btn>
      <v-alert v-if="issuanceUncertain" type="warning" variant="tonal">A key may have been created without returning its secret. Reload the key list and revoke any key you cannot use before creating another.</v-alert>
      <v-progress-linear v-if="loading" indeterminate aria-label="Loading MCP access keys" />
      <template v-if="catalog && isCurrent">
        <v-text-field :model-value="catalog.endpoint" label="MCP endpoint" variant="outlined" density="comfortable" readonly hide-details />
        <v-alert v-if="canManageSystem" class="profile-mcp__admin-warning" type="warning" variant="tonal" role="note">{{ t('adminWarning', { defaultValue: 'Your account can manage the system and read all pages regardless of page rules, including private pages. Both Read only and Read and propose edits keys inherit these unrestricted page reads. Read only prevents edits; it does not restrict which pages the client can read.' }) }}</v-alert>
        <p v-else class="profile-muted text-body-small">{{ t('pageAccess', { defaultValue: 'Page reads follow your current permissions and page rules, including private-page restrictions. Choosing Read only limits tools, not a separate set of pages.' }) }}</p>
        <v-alert v-if="!catalog.enabled" type="info" variant="tonal">MCP access is disabled by the administrator. Existing keys can still be revoked.</v-alert>
        <v-alert v-else-if="!catalog.canIssue" type="info" variant="tonal">Your account cannot issue MCP keys with its current permissions. You can still revoke existing keys.</v-alert>
        <div v-if="issuedKey" class="profile-mcp__secret" role="region" aria-labelledby="profile-mcp-secret-title">
          <h3 id="profile-mcp-secret-title" class="text-title-small">Save your new key now</h3>
          <p class="text-body-small">This is the only time the key is shown. Store it in your MCP client's secret configuration and send it as a Bearer token. Do not paste it into a chat prompt.</p>
          <v-text-field :model-value="issuedKey" :type="showKey ? 'text' : 'password'" label="New MCP key (shown once)" readonly autocomplete="off" spellcheck="false" variant="outlined" hide-details />
          <div class="profile-mcp__actions">
            <v-btn variant="text" :aria-pressed="showKey" @click="showKey = !showKey">{{ showKey ? 'Hide key' : 'Reveal key' }}</v-btn>
            <v-btn variant="tonal" prepend-icon="mdi-content-copy" @click="copyKey">Copy key</v-btn>
            <v-btn color="primary" @click="forgetSecret">Done</v-btn>
          </div>
        </div>
        <form v-else-if="catalog.enabled && catalog.canIssue" class="profile-mcp__form" :aria-busy="busy" @submit.prevent="issue">
          <v-text-field v-model="name" label="Key name" hint="Identify this client or device, for example Desktop assistant." persistent-hint minlength="2" maxlength="255" autocomplete="off" variant="outlined" density="comfortable" :disabled="busy" />
          <v-select v-model="access" :items="accessOptions" label="Key access" variant="outlined" density="comfortable" :disabled="busy" hide-details />
          <p class="profile-muted text-body-small">Read only never exposes edit tools. Read and propose edits remains bounded by your live permissions and client approval support.</p>
          <v-select v-model="expirationDays" :items="expirationOptions" label="Expires after" variant="outlined" density="comfortable" :disabled="busy" hide-details />
          <div class="profile-mcp__actions"><v-btn color="primary" type="submit" prepend-icon="mdi-key-plus" :loading="mutating" :disabled="busy || !validName || issuanceUncertain">Create MCP key</v-btn></div>
        </form>
        <section class="profile-mcp__setup" aria-labelledby="profile-mcp-setup-title">
          <h3 id="profile-mcp-setup-title" class="text-title-small">{{ t('setupTitle', { defaultValue: 'Set up your MCP client' }) }}</h3>
          <p class="profile-muted text-body-small">{{ t('setupSafety', { defaultValue: 'These snippets always contain a token placeholder, never your issued key. Copy the key separately into the indicated secret input or the environment that launches your client, outside chat. Keep secrets out of shared files, source control, shell history, and screenshots.' }) }}</p>
          <v-select v-model="setupClient" class="profile-mcp__setup-client" :items="setupClients" :label="t('setupClient', { defaultValue: 'MCP client' })" variant="outlined" density="comfortable" hide-details />
          <p class="text-body-small">{{ setupInstructions }}</p>
          <pre class="profile-mcp__snippet" tabindex="0" :aria-label="t('setupJson', { defaultValue: 'MCP setup JSON with token placeholder' })"><code>{{ setupSnippet }}</code></pre>
          <div class="profile-mcp__actions"><v-btn variant="tonal" prepend-icon="mdi-content-copy" @click="copySetup">{{ t('copySetup', { defaultValue: 'Copy setup snippet' }) }}</v-btn></div>
          <p class="profile-muted text-body-small">{{ t('setupApproval', { defaultValue: 'These clients support remote HTTP with Bearer keys; no Wiki OAuth sign-in is configured here. Start with a permitted read. Read and propose edits also requires compatible client approval support, your current Wiki permissions, and human approval for every proposed change.' }) }}</p>
        </section>
        <div class="profile-mcp__inventory">
          <h3 class="text-title-small">Your keys</h3>
          <p v-if="!catalog.keys.length" class="profile-muted text-body-small">No MCP access keys yet.</p>
          <ul v-else class="profile-mcp__keys">
            <li v-for="item in catalog.keys" :key="item.id" class="profile-mcp__key">
              <div class="profile-mcp__key-copy">
                <strong>{{ item.name }}</strong>
                <span class="profile-muted text-body-small">{{ item.access === 'read-only' ? 'Read only' : 'Read and propose edits' }} · {{ item.isRevoked ? 'Revoked' : isExpired(item) ? 'Expired' : 'Active' }}</span>
                <span class="profile-muted text-body-small">Expires <time :datetime="item.expiresAt">{{ formatDate(item.expiresAt) }}</time></span>
              </div>
              <v-btn v-if="!item.isRevoked" color="error" variant="text" :disabled="busy" :aria-label="`Revoke MCP key ${item.name}`" @click="revoke(item)">Revoke</v-btn>
            </li>
          </ul>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { IssuePersonalMcpKeyInputSchema, type PersonalMcpAccess, type PersonalMcpKey } from '../../../shared/personal-mcp.ts'
import { fetchProfileMcpKeys, issueProfileMcpKey, revokeProfileMcpKey } from '../../helpers/users-api.ts'
import { formatPersonalMcpSetup, type PersonalMcpClient } from '../../helpers/personal-mcp-setup.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
import { getErrorMessage } from '../../helpers/root-ui-store.ts'
import { wikiStore } from '../../store/index.ts'
import { requestConfirmation } from '../common/confirm-dialog.ts'

const props = defineProps<{ ownerId: number; csrfToken: string }>()
const t = useTranslate('profile:mcp')
const catalog = shallowRef<Awaited<ReturnType<typeof fetchProfileMcpKeys>> | null>(null)
const name = ref('')
const access = ref<PersonalMcpAccess>('read-only')
const expirationDays = ref(30)
const issuedKey = ref('')
const issuedId = ref<number | null>(null)
const showKey = ref(false)
const setupClient = ref<PersonalMcpClient>('claude-code')
const loading = ref(false)
const mutating = ref(false)
const issuanceUncertain = ref(false)
const error = ref('')
const notice = ref('')
const busy = computed(() => loading.value || mutating.value)
const isCurrent = computed(() => props.ownerId > 0 && props.ownerId === wikiStore.user.id)
const canManageSystem = computed(() => isCurrent.value && wikiStore.user.permissions.includes('manage:system'))
const setupClients = computed(() => [
  { title: 'Claude Code', value: 'claude-code' },
  { title: 'Cursor', value: 'cursor' },
  { title: t('vscodeLocal', { defaultValue: 'VS Code (Local harness)' }), value: 'vscode-local' }
])
const setupSnippet = computed(() => isCurrent.value && catalog.value ? formatPersonalMcpSetup(setupClient.value, catalog.value.endpoint) : '')
const setupInstructions = computed(() => {
  if (setupClient.value === 'claude-code') return t('claudeSetup', { defaultValue: 'Merge this into .mcp.json in your project. Set WIKI_MCP_KEY securely in the environment that launches Claude Code. The snippet references that variable without storing the key in JSON.' })
  if (setupClient.value === 'cursor') return t('cursorSetup', { defaultValue: 'Merge this into your personal ~/.cursor/mcp.json. Set WIKI_MCP_KEY securely in the environment that launches Cursor. Remote servers do not support envFile; the snippet uses environment interpolation.' })
  return t('vscodeSetup', { defaultValue: 'For the VS Code Local harness, merge this into your user-profile MCP configuration (MCP: Open User Configuration). Enter the key in the masked input prompt when the server starts. Input-variable servers are not forwarded to Copilot harness sessions; do not use this snippet for those sessions.' })
})
const validName = computed(() => IssuePersonalMcpKeyInputSchema.shape.name.safeParse(name.value).success)
const accessOptions = [{ title: 'Read only', value: 'read-only' }, { title: 'Read and propose edits', value: 'read-write' }]
const expirationOptions = [1, 7, 30, 90].map(value => ({ title: `${value} ${value === 1 ? 'day' : 'days'}`, value }))
let generation = 0
let disposed = false
const current = (owner: number, revision: number) => !disposed && isCurrent.value && owner === props.ownerId && revision === generation
const fetcher = (url: string, init: RequestInit) => window.fetch(url, init)
const isExpired = (item: PersonalMcpKey) => Date.parse(item.expiresAt) <= Date.now()
const formatDate = (value: string) => new Date(value).toLocaleString()

function forgetSecret() {
  issuedKey.value = ''
  issuedId.value = null
  showKey.value = false
  error.value = ''
  notice.value = ''
}

async function load() {
  const revision = ++generation
  const owner = props.ownerId
  forgetSecret()
  catalog.value = null
  error.value = ''
  notice.value = ''
  mutating.value = false
  loading.value = false
  if (!isCurrent.value) return
  loading.value = true
  try {
    const response = await fetchProfileMcpKeys(fetcher, owner, props.csrfToken)
    if (current(owner, revision)) {
      catalog.value = response
      if (issuanceUncertain.value) notice.value = 'Key list reloaded. Revoke any key whose secret you did not receive.'
      issuanceUncertain.value = false
    }
  } catch (value) {
    if (current(owner, revision)) error.value = getErrorMessage(value)
  } finally {
    if (current(owner, revision)) loading.value = false
  }
}

async function issue() {
  if (!isCurrent.value || busy.value || issuanceUncertain.value || !validName.value || !catalog.value?.canIssue || !catalog.value.enabled || issuedKey.value) return
  const owner = props.ownerId
  const revision = generation
  mutating.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await issueProfileMcpKey(fetcher, owner, props.csrfToken, { name: name.value.trim(), access: access.value, expirationDays: expirationDays.value })
    if (!current(owner, revision) || !catalog.value) return
    catalog.value = { ...catalog.value, keys: [result.item, ...catalog.value.keys] }
    issuedKey.value = result.key
    issuedId.value = result.item.id
    name.value = ''
    notice.value = 'MCP key created. Copy it before leaving this page.'
  } catch (value) {
    if (current(owner, revision)) {
      issuanceUncertain.value = true
      error.value = getErrorMessage(value)
    }
  } finally {
    if (current(owner, revision)) mutating.value = false
  }
}

async function copyKey() {
  if (!isCurrent.value || !issuedKey.value) return
  const owner = props.ownerId
  const revision = generation
  try {
    await navigator.clipboard.writeText(issuedKey.value)
    if (current(owner, revision)) notice.value = 'Key copied. Store it securely, then select Done.'
  } catch {
    if (current(owner, revision)) error.value = 'Clipboard access is unavailable. Reveal the key and copy it manually.'
  }
}

async function copySetup() {
  if (!isCurrent.value || !setupSnippet.value) return
  const owner = props.ownerId
  const revision = generation
  try {
    await navigator.clipboard.writeText(setupSnippet.value)
    if (current(owner, revision)) notice.value = t('setupCopied', { defaultValue: 'Setup snippet copied. Supply the key separately in your client, not in chat.' })
  } catch {
    if (current(owner, revision)) error.value = t('setupCopyFailed', { defaultValue: 'Clipboard access is unavailable. Select and copy the setup snippet manually.' })
  }
}

async function revoke(item: PersonalMcpKey) {
  if (!isCurrent.value || busy.value || item.isRevoked) return
  const owner = props.ownerId
  const revision = generation
  const accepted = await requestConfirmation({ title: 'Revoke MCP key?', message: `${item.name} will immediately lose access. Existing Wiki changes and audit history remain.`, confirmLabel: 'Revoke key', cancelLabel: 'Keep key', tone: 'destructive' })
  if (!accepted || !current(owner, revision) || busy.value) return
  mutating.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await revokeProfileMcpKey(fetcher, owner, props.csrfToken, item.id)
    if (!current(owner, revision) || !catalog.value) return
    catalog.value = { ...catalog.value, keys: catalog.value.keys.map(row => row.id === result.id ? { ...row, isRevoked: true } : row) }
    if (issuedId.value === item.id) forgetSecret()
    notice.value = 'MCP key revoked.'
  } catch (value) {
    if (current(owner, revision)) error.value = getErrorMessage(value)
  } finally {
    if (current(owner, revision)) mutating.value = false
  }
}

watch(() => [props.ownerId, props.csrfToken, wikiStore.user.id], () => { name.value = ''; access.value = 'read-only'; expirationDays.value = 30; setupClient.value = 'claude-code'; issuanceUncertain.value = false; void load() }, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { disposed = true; generation++; forgetSecret(); catalog.value = null })
</script>

<style scoped>
.profile-mcp__body, .profile-mcp__form, .profile-mcp__secret, .profile-mcp__inventory, .profile-mcp__setup { display: grid; gap: var(--wiki-space-3); min-width: 0; }
.profile-mcp__body > p, .profile-mcp__secret > p, .profile-mcp__secret > h3, .profile-mcp__inventory > h3, .profile-mcp__setup > p, .profile-mcp__setup > h3 { margin: 0; }
.profile-mcp__actions { display: flex; flex-wrap: wrap; gap: var(--wiki-space-2); }
.profile-mcp__secret { padding: var(--wiki-space-4); border: 1px solid var(--wiki-surface-border); border-radius: var(--profile-radius); background: var(--wiki-surface-base); }
.profile-mcp__inventory, .profile-mcp__setup { border-top: 1px solid var(--wiki-surface-border); padding-top: var(--wiki-space-4); }
.profile-mcp__snippet { margin: 0; padding: var(--wiki-space-3); max-width: 100%; overflow-x: auto; border: 1px solid var(--wiki-surface-border); border-radius: var(--profile-radius); background: var(--wiki-surface-base); font-size: 0.875rem; user-select: text; }
.profile-mcp__keys { padding: 0; margin: 0; list-style: none; }
.profile-mcp__key { display: flex; align-items: center; justify-content: space-between; gap: var(--wiki-space-2); padding-block: var(--wiki-space-3); border-bottom: 1px solid var(--wiki-surface-border); }
.profile-mcp__key-copy { display: grid; min-width: 0; gap: var(--wiki-space-1); overflow-wrap: anywhere; }
@media (max-width: 420px) { .profile-mcp__key { align-items: start; flex-direction: column; } }
</style>
