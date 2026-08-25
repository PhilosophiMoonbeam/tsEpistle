<template>
  <section class="inline-agent" aria-label="Wiki Agent">
    <v-card class="inline-agent__card" elevation="0" rounded="xl">
      <v-toolbar class="inline-agent__toolbar" color="transparent" density="comfortable" tag="div">
        <v-avatar class="ml-4" color="primary" size="34" variant="tonal">
          <v-icon icon="mdi-auto-fix" size="19" />
        </v-avatar>
        <div class="inline-agent__heading ml-3">
          <div class="text-title-medium font-weight-medium">Wiki Agent</div>
          <div class="text-body-small text-medium-emphasis text-truncate">{{ sessionTitle }}</div>
        </div>
        <v-spacer />
        <v-chip
          v-if="activeRun || connection === 'reconnecting'"
          class="mr-2"
          :color="connectionColor"
          size="small"
          variant="tonal"
        >{{ connectionLabel }}</v-chip>
        <AgentMemoryManager :csrf-token="csrfToken" />
        <v-menu location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              icon="mdi-history"
              variant="text"
              aria-label="Open agent conversation history"
            />
          </template>
          <v-list class="inline-agent__history" density="compact" aria-label="Agent conversation history">
            <div class="inline-agent__history-header px-4 pt-3 pb-2">
              <div>
                <div class="text-label-large">Recent conversations</div>
                <div class="text-body-small text-medium-emphasis">Automatically removed after 90 days</div>
              </div>
              <v-btn
                color="error"
                prepend-icon="mdi-delete-sweep-outline"
                size="small"
                variant="text"
                :disabled="resetting || sessions.length === 0"
                @click="resetHistoryOpen = true"
              >Reset</v-btn>
            </div>
            <v-list-item
              v-for="session in sessions"
              :key="session.id"
              :active="session.id === thread?.session.id"
              :title="session.title || 'New conversation'"
              :subtitle="formatSessionDate(session.updatedAt)"
              prepend-icon="mdi-message-text-outline"
              @click="openSession(session.id)"
            />
            <v-list-item v-if="!sessions.length" title="No saved conversations yet" disabled />
          </v-list>
        </v-menu>
        <v-btn
          class="mr-2"
          icon="mdi-plus"
          variant="text"
          aria-label="Start a new agent conversation"
          :disabled="loading || sending"
          @click="newSession"
        />
      </v-toolbar>

      <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Loading Wiki Agent" />

      <AgentMcpApproval v-if="approvalId" :csrf-token="csrfToken" :proposal-id="approvalId" />
      <template v-else>
      <div class="inline-agent__body">
        <v-alert
          class="inline-agent__alert mb-4"
          v-if="!loading && !providerAvailable"
          variant="tonal"
          icon="mdi-connection"
        >
          {{ providerUnavailableMessage }}
        </v-alert>
        <v-alert
          v-if="error"
          class="mb-4"
          type="error"
          variant="tonal"
          closable
          @click:close="agents.error = ''"
        >{{ error }}</v-alert>

        <AgentSessionSettings
          v-if="thread && profiles.length > 1"
          class="inline-agent__settings"
          :session="thread.session"
          :profiles="profiles"
          :disabled="Boolean(activeRun)"
          @profile="agents.setProfile"
        />

        <div
          ref="transcript"
          class="inline-agent__transcript"
          :class="{ 'inline-agent__transcript--approval-jump': approvalJumpVisible }"
          tabindex="-1"
          @scroll.passive="updateApprovalJump"
        >
          <section v-if="thread && !hasConversation" class="inline-agent__welcome" aria-labelledby="inline-agent-welcome-title">
            <div class="inline-agent__welcome-mark" aria-hidden="true">
              <v-icon icon="mdi-auto-fix" size="28" />
            </div>
            <p class="inline-agent__welcome-eyebrow">Curious · grounded · concise</p>
            <h2 id="inline-agent-welcome-title">Hi, I’m Wiki.</h2>
            <p class="inline-agent__welcome-copy">
              I can trace answers through your knowledge base, connect what matters, and help turn an idea into a careful change.
            </p>
            <div class="inline-agent__starters" aria-label="Conversation starters">
              <v-btn
                v-for="starter in starters"
                :key="starter.prompt"
                class="inline-agent__starter"
                color="primary"
                variant="tonal"
                rounded="xl"
                @click="sendPrompt(starter.prompt)"
              >
                <v-icon start :icon="starter.icon" />
                {{ starter.label }}
              </v-btn>
            </div>
          </section>
          <AgentThread
            v-else-if="thread"
            :thread="thread"
            :connection="connection"
            :deciding-approval-id="decidingApprovalId"
            @suggest="sendPrompt"
            @decision="agents.decideProposal"
          />
        </div>
        <v-btn
          v-if="approvalJumpVisible"
          class="inline-agent__approval-jump"
          color="warning"
          variant="elevated"
          prepend-icon="mdi-shield-alert-outline"
          append-icon="mdi-arrow-down"
          @click="jumpToApproval"
        >Approval required</v-btn>
      </div>

      <footer class="inline-agent__composer">
        <AgentComposer
          :sending="sending"
          :can-stop="Boolean(activeRun?.canCancel)"
          :disabled="!providerAvailable || loading || !thread || Boolean(activeRun)"
          :skills-enabled="skillsEnabled"
          :skills="skills"
          :preferred-skills="thread?.session.skills ?? []"
          :invocation-limit="invocationLimit"
          @send="sendPrompt"
          @stop="agents.stop"
          @manage-skills="skillManagerOpen = true"
          @update-skill-preferences="agents.setSkillPreferences"
        />
        <div class="inline-agent__notice text-body-small text-medium-emphasis mt-2">
          <v-icon icon="mdi-shield-check-outline" size="15" />
          Answers respect your Wiki permissions. Verify cited sources before relying on model output.
        </div>
      </footer>
      </template>
    </v-card>
  </section>
  <AgentPersonalSkills v-if="skillsEnabled" v-model="skillManagerOpen" :csrf-token="csrfToken" @changed="reloadSkillCatalog" />
  <v-dialog v-model="resetHistoryOpen" max-width="30rem">
    <v-card rounded="xl">
      <v-card-title class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="error" size="38" variant="tonal"><v-icon icon="mdi-delete-sweep-outline" /></v-avatar>
        Reset conversation history?
      </v-card-title>
      <v-card-text class="px-5">
        Every Agent conversation will be permanently removed and a clean conversation will open. Your curated Agent memory stays intact.
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="resetHistoryOpen = false">Cancel</v-btn>
        <v-btn color="error" :loading="resetting" @click="resetHistory">Reset history</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { AgentCurrentPageHint } from '../../../shared/agents/contracts.ts'
import { useAgentsStore } from '../../store/agents.ts'
import AgentComposer from './agent-composer.vue'
import AgentMemoryManager from './agent-memory-manager.vue'
import AgentPersonalSkills from './agent-personal-skills.vue'
import AgentMcpApproval from './agent-mcp-approval.vue'
import AgentSessionSettings from './agent-session-settings.vue'
import AgentThread from './agent-thread.vue'
import { isAgentApprovalOutsideViewport } from './agent-thread-presentation.ts'

const props = defineProps<{
  csrfToken: string
  approvalId?: string
  providerEnabled: boolean
  skillsEnabled: boolean
  pageId: number
  pageLocale: string
  pagePath: string
  pageUpdatedAt: string
}>()

const agents = useAgentsStore()
const { connection, decidingApprovalId, error, loading, profiles, sending, sessions, skills, thread } = storeToRefs(agents)
const transcript = ref<HTMLElement | null>(null)
const approvalJumpVisible = ref(false)
const skillManagerOpen = ref(false)
const resetHistoryOpen = ref(false)
const resetting = ref(false)
let initialization: Promise<void> | null = null

const currentPage = computed<AgentCurrentPageHint | null>(() => {
  if (props.pageId < 1 || !props.pageLocale || !props.pagePath || !props.pageUpdatedAt) return null
  return { id: props.pageId, locale: props.pageLocale, path: props.pagePath, observedUpdatedAt: props.pageUpdatedAt }
})
const activeRun = computed(() => thread.value?.session.currentRun?.canCancel ? thread.value.session.currentRun : null)
const hasConversation = computed(() => Boolean(thread.value && (thread.value.messages.length || thread.value.tools.length || thread.value.artifacts.length)))
const pendingApprovalId = computed(() => thread.value?.proposals.find(proposal => proposal.status === 'pending' && proposal.approval?.status === 'pending')?.id ?? null)
const providerAvailable = computed(() => props.providerEnabled && profiles.value.length > 0)
const preferredSkillIds = computed(() => thread.value?.session.skills.map(skill => skill.skillId) ?? [])
const invocationLimit = computed(() => Math.max(0, 8 - preferredSkillIds.value.length))
const providerUnavailableMessage = computed(() => props.providerEnabled
  ? 'No enabled provider profile is available for your account. Ask an administrator to grant one in Administration → Agents.'
  : 'Agent inference is currently disabled. An administrator can configure it in Administration → Agents.')
const sessionTitle = computed(() => thread.value?.session.title || 'New conversation')
const connectionLabel = computed(() => connection.value === 'reconnecting' ? 'Reconnecting' : activeRun.value?.status === 'awaiting_approval' ? 'Review needed' : 'Working')
const connectionColor = computed(() => connection.value === 'reconnecting' ? 'warning' : activeRun.value?.status === 'awaiting_approval' ? 'warning' : 'primary')
const starters = computed(() => [
  ...(currentPage.value ? [{ label: 'Summarize this page', prompt: 'Summarize the current Wiki page and cite the key sections.', icon: 'mdi-text-box-search-outline' }] : []),
  { label: 'Find related pages', prompt: 'Find Wiki pages related to the current topic and explain how they connect.', icon: 'mdi-file-link-outline' },
  { label: 'What changed recently?', prompt: 'Summarize the most recently updated Wiki pages I can access.', icon: 'mdi-history' }
])

const ensureInitialized = (): Promise<void> => {
  if (initialization) return initialization
  const pending = agents.initialize(props.csrfToken, {
    routeSync: false,
    currentPage: currentPage.value,
    reuseLatest: true
  })
  initialization = pending
  void pending.then(() => {
    if (!agents.thread) initialization = null
  })
  return pending
}

const sendPrompt = async (content: string, invokedSkillVersionIds: readonly string[] = []): Promise<boolean> => {
  const prompt = content.trim()
  if (!prompt) return false
  await ensureInitialized()
  if (!providerAvailable.value || !thread.value) return false
  return agents.send(prompt, invokedSkillVersionIds)
}

const reloadSkillCatalog = async (): Promise<void> => {
  try {
    await agents.reloadSkills()
  } catch (value) {
    agents.error = value instanceof Error ? value.message : 'The skill catalog could not be refreshed.'
  }
}

const newSession = async (): Promise<void> => {
  try {
    await ensureInitialized()
    await agents.newSession('saved')
  } catch (value) {
    agents.error = value instanceof Error ? value.message : 'A new conversation could not be created.'
  }
}

const openSession = async (sessionId: string): Promise<void> => {
  if (sessionId === thread.value?.session.id) return
  try {
    await agents.openSession(sessionId)
  } catch (value) {
    agents.error = value instanceof Error ? value.message : 'The conversation could not be opened.'
  }
}
const resetHistory = async (): Promise<void> => {
  resetting.value = true
  try {
    await agents.resetHistory()
    resetHistoryOpen.value = false
  } catch (value) {
    agents.error = value instanceof Error ? value.message : 'Conversation history could not be reset.'
  } finally {
    resetting.value = false
  }
}

const formatSessionDate = (value: string): string => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
}).format(new Date(value))

const updateApprovalJump = (): void => {
  const container = transcript.value
  const proposalId = pendingApprovalId.value
  if (!container || !proposalId) {
    approvalJumpVisible.value = false
    return
  }
  const approval = container.querySelector<HTMLElement>(`#agent-approval-${proposalId}`)
  if (!approval) {
    approvalJumpVisible.value = false
    return
  }
  const containerRect = container.getBoundingClientRect()
  const approvalRect = approval.getBoundingClientRect()
  approvalJumpVisible.value = isAgentApprovalOutsideViewport(containerRect, approvalRect)
}

const jumpToApproval = async (): Promise<void> => {
  const proposalId = pendingApprovalId.value
  if (!proposalId) return
  const approval = transcript.value?.querySelector<HTMLElement>(`#agent-approval-${proposalId}`)
  if (!approval) return
  approval.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await nextTick()
  approval.focus({ preventScroll: true })
  approvalJumpVisible.value = false
}

watch(currentPage, page => agents.setCurrentPage(page), { immediate: true })
watch(
  () => [thread.value?.messages.length, thread.value?.tools.length, thread.value?.artifacts.length, pendingApprovalId.value, connection.value],
  async () => {
    if (!hasConversation.value) {
      await nextTick()
      if (transcript.value) transcript.value.scrollTop = 0
      approvalJumpVisible.value = false
      return
    }
    const element = transcript.value
    const nearBottom = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 160
    await nextTick()
    if (nearBottom && transcript.value) transcript.value.scrollTo({ top: transcript.value.scrollHeight, behavior: 'smooth' })
    updateApprovalJump()
  }
)

onMounted(() => { void ensureInitialized() })
defineExpose({ sendPrompt })
</script>

<style scoped>
.inline-agent {
  margin: 0 auto;
  max-width: 64rem;
  width: 100%;
}
.inline-agent__card {
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 98%, rgb(var(--v-theme-background)));
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-outline)) 28%, transparent);
  box-shadow: 0 1.25rem 4rem rgba(0, 0, 0, .22);
  display: flex;
  flex-direction: column;
  height: min(78vh, 52rem);
  min-height: 32rem;
  overflow: hidden;
  text-align: start;
}
.inline-agent__toolbar {
  border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-outline)) 18%, transparent);
  flex: 0 0 auto;
}
.inline-agent__heading { min-width: 0; }
.inline-agent__history { max-height: min(28rem, 70vh); min-width: min(24rem, 90vw); overflow-y: auto; }
.inline-agent__history-header { align-items: center; display: flex; gap: 1rem; justify-content: space-between; }
.inline-agent__alert { flex: 0 0 auto; }
.inline-agent__settings { flex: 0 0 auto; max-height: 100%; overflow-y: auto; overscroll-behavior: contain; }
.inline-agent__settings:has(.v-expansion-panel-title[aria-expanded="true"]) { flex: 1 1 auto; min-height: clamp(9rem, 45dvh, 18rem); }
.inline-agent__body { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden; padding: 1rem 1.25rem 0; position: relative; }
.inline-agent__transcript { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: .5rem .5rem 1.25rem; scroll-behavior: smooth; }
.inline-agent__transcript:has(> .inline-agent__welcome) { display: flex; }
.inline-agent__transcript--approval-jump { padding-bottom: 4.5rem; }
.inline-agent__approval-jump { bottom: 1rem; position: absolute; right: 1.75rem; z-index: 2; }
.inline-agent__welcome {
  align-items: center;
  background:
    radial-gradient(circle at 92% 8%, color-mix(in srgb, rgb(var(--v-theme-primary)) 19%, transparent), transparent 38%),
    color-mix(in srgb, rgb(var(--v-theme-surface-variant)) 34%, rgb(var(--v-theme-surface)));
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 24%, rgb(var(--v-theme-outline-variant)));
  border-radius: 1.5rem;
  box-shadow: 0 1rem 3rem color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent);
  display: flex;
  flex-direction: column;
  margin: auto;
  max-width: 44rem;
  overflow: hidden;
  padding: clamp(1.75rem, 5vw, 3rem);
  text-align: center;
  width: 100%;
}
.inline-agent__welcome-mark {
  align-items: center;
  background: rgb(var(--v-theme-primary-container));
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 30%, transparent);
  border-radius: 1.1rem;
  color: rgb(var(--v-theme-on-primary-container));
  display: flex;
  height: 3.4rem;
  justify-content: center;
  width: 3.4rem;
}
.inline-agent__welcome-eyebrow { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 700; letter-spacing: .12em; margin: 1.1rem 0 .4rem; text-transform: uppercase; }
.inline-agent__welcome h2 { font-size: clamp(1.55rem, 4vw, 2rem); font-weight: 650; letter-spacing: -.025em; line-height: 1.2; margin: 0; }
.inline-agent__welcome-copy { color: rgb(var(--v-theme-on-surface)); line-height: 1.6; margin: .7rem auto 1.5rem; max-width: 34rem; opacity: .72; }
.inline-agent__starters { display: grid; gap: .65rem; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; }
.inline-agent__starter { height: auto; justify-content: flex-start; letter-spacing: 0; min-height: 2.9rem; padding: .65rem .9rem; text-transform: none; white-space: normal; }
.inline-agent__composer {
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 98%, rgb(var(--v-theme-primary)) 2%);
  border-top: 1px solid color-mix(in srgb, rgb(var(--v-theme-outline)) 18%, transparent);
  flex: 0 0 auto;
  padding: .9rem 1.25rem 1rem;
}
.inline-agent__notice { align-items: center; display: flex; gap: .35rem; justify-content: center; text-align: center; }
@media (max-width: 599.98px) {
  .inline-agent__card { border: 0; border-radius: 0 !important; box-shadow: none; height: 100%; min-height: 0; }
  .inline-agent__body { padding-inline: .75rem; }
  .inline-agent__transcript { padding-inline: 0; }
  .inline-agent__welcome { border-radius: 1.25rem; padding: 1.4rem 1rem; }
  .inline-agent__starters { grid-template-columns: 1fr; }
  .inline-agent__composer { padding: .75rem; }
  .inline-agent__approval-jump { bottom: .75rem; left: 1.5rem; right: 1.5rem; }
  .inline-agent__notice { display: none; }
}
@media (max-height: 500px) {
  .inline-agent__body { overflow-y: auto; padding: .5rem .75rem 0; }
  .inline-agent__composer { padding: .5rem .75rem; }
  .inline-agent__composer :deep(.v-input__details), .inline-agent__notice { display: none; }
}
@media (forced-colors: active) {
  .inline-agent__card { border: 1px solid CanvasText; }
}
@media (prefers-reduced-motion: reduce) {
  .inline-agent__transcript { scroll-behavior: auto; }
}
</style>
