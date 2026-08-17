<template>
  <v-app>
    <v-app-bar color="primary" density="comfortable">
      <v-app-bar-nav-icon v-if="isConversationPage" aria-label="Open session history" @click="drawer = !drawer" />
      <v-app-bar-title>Wiki Agents</v-app-bar-title>
      <v-chip v-if="isConversationPage" class="mr-2" size="small" :color="connectionColor" variant="tonal">{{ connectionLabel }}</v-chip>
      <v-btn v-if="bootstrap.isAdmin" href="/admin" variant="text">Administration</v-btn>
      <v-form action="/auth/logout" method="post"><v-btn type="submit" variant="text">Sign out</v-btn></v-form>
    </v-app-bar>

    <v-navigation-drawer v-if="isConversationPage" v-model="drawer" :temporary="$vuetify.display.mdAndDown" width="320">
      <div class="pa-3 d-flex ga-2">
        <v-btn color="primary" prepend-icon="mdi-plus" block @click="newSession('saved')">New chat</v-btn>
        <v-menu>
          <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-chevron-down" aria-label="New chat options" /></template>
          <v-list><v-list-item title="New temporary chat" subtitle="Automatically expires" prepend-icon="mdi-timer-sand" @click="newSession('temporary')" /></v-list>
        </v-menu>
      </div>
      <v-divider />
      <v-list nav aria-label="Agent session history">
        <v-list-item
          v-for="session in sessions"
          :key="session.id"
          :active="thread?.session.id === session.id"
          :title="session.title"
          :subtitle="session.retention === 'temporary' ? 'Temporary' : new Date(session.lastActivityAt).toLocaleString()"
          prepend-icon="mdi-message-text-outline"
          @click="openSession(session.id)"
        >
          <template #append>
            <v-btn icon="mdi-delete-outline" size="small" variant="text" :aria-label="`Delete ${session.title}`" @click.stop="removeSession(session.id)" />
          </template>
        </v-list-item>
      </v-list>
    </v-navigation-drawer>

    <v-main>
      <v-container class="agent-shell" fluid>
        <AgentMcpApproval v-if="isApprovalPage" :csrf-token="bootstrap.csrfToken" />
        <AgentAdmin v-else-if="isAdminPage && bootstrap.isAdmin" :csrf-token="bootstrap.csrfToken" />
        <v-alert v-else-if="isAdminPage" type="error" variant="tonal">System administration permission is required.</v-alert>
        <template v-else>
          <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Loading agent session" />
          <v-alert v-if="error" type="error" closable class="mb-4" @click:close="agents.error = ''">{{ error }}</v-alert>
          <template v-if="thread">
            <header class="mb-4 d-flex flex-wrap align-center ga-2">
              <div>
                <h1 class="text-headline-medium">{{ thread.session.title }}</h1>
                <div class="text-body-small text-medium-emphasis">{{ thread.session.retention === 'temporary' ? 'Temporary session' : 'Saved private session' }}</div>
              </div>
              <v-spacer />
              <v-chip v-if="launchPage" prepend-icon="mdi-file-document-outline" size="small" variant="outlined">Context: {{ launchPage.path }}</v-chip>
            </header>
            <AgentSessionSettings
              :session="thread.session"
              :profiles="profiles"
              :skills="skills"
              :disabled="Boolean(thread.session.currentRun?.canCancel)"
              @profile="setProfile"
              @skills="setSkills"
            />
            <v-sheet class="thread-surface pa-4" rounded="lg" border>
              <AgentThread :thread="thread" :connection="connection" :deciding-approval-id="decidingApprovalId" @suggest="send" @decision="decideProposal" />
            </v-sheet>
            <AgentComposer
              class="composer-surface mt-4"
              :disabled="loading || Boolean(thread.session.currentRun?.canCancel)"
              :sending="sending"
              :can-stop="Boolean(thread.session.currentRun?.canCancel)"
              @send="send"
              @stop="stop"
            />
          </template>
        </template>
      </v-container>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAgentsStore } from '../../store/agents.ts'
import AgentMcpApproval from './agent-mcp-approval.vue'
import AgentComposer from './agent-composer.vue'
import AgentThread from './agent-thread.vue'
import AgentSessionSettings from './agent-session-settings.vue'
import AgentAdmin from './agent-admin.vue'

interface AgentBootstrap { readonly csrfToken: string; readonly isAdmin: boolean; readonly userId: number }
const props = defineProps<{ bootstrap: AgentBootstrap }>()
const isAdminPage = window.location.pathname === '/admin'
const isApprovalPage = /^\/approvals\/[0-9a-f-]{36}$/i.test(window.location.pathname)
const isConversationPage = !isAdminPage && !isApprovalPage
const drawer = ref(true)
const agents = useAgentsStore()
const { connection, decidingApprovalId, error, launchPage, loading, profiles, sending, sessions, skills, thread } = storeToRefs(agents)
const connectionLabel = computed(() => ({ idle: 'Ready', connecting: 'Connecting', connected: 'Live', reconnecting: 'Reconnecting', closed: 'Offline' }[connection.value]))
const connectionColor = computed(() => connection.value === 'reconnecting' || connection.value === 'closed' ? 'warning' : 'white')
const newSession = (retention: 'temporary' | 'saved') => void agents.newSession(retention).catch(fail)
const openSession = (id: string) => void agents.openSession(id).catch(fail)
const removeSession = (id: string) => void agents.removeSession(id).catch(fail)
const send = (content: string) => void agents.send(content)
const stop = () => void agents.stop()
const setProfile = (profileId: string | null, mode: 'agent' | 'generation-only') => void agents.setProfile(profileId, mode)
const setSkills = (versionIds: string[]) => void agents.setSkills(versionIds)
const decideProposal = (proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string) => void agents.decideProposal(proposalId, approvalId, decision, confirmationPath)
const fail = (value: unknown) => { agents.error = value instanceof Error ? value.message : 'Agent request failed.' }
onMounted(() => { if (isConversationPage) void agents.initialize(props.bootstrap.csrfToken) })
onBeforeUnmount(() => agents.closeStream())
</script>

<style scoped>
.agent-shell { margin-inline: auto; max-width: 76rem; padding: clamp(1rem, 4vw, 3rem); }
.thread-surface { min-height: min(55vh, 42rem); }
.composer-surface { position: sticky; bottom: 0; padding: 1rem; background: rgb(var(--v-theme-background)); }
@media (max-width: 600px) { .agent-shell { padding: .75rem; } .thread-surface { padding: .75rem !important; } }
@media (prefers-reduced-motion: reduce) { :deep(*) { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
@media (forced-colors: active) { :deep(.v-sheet), :deep(.v-card) { border: 1px solid CanvasText; } }
</style>
