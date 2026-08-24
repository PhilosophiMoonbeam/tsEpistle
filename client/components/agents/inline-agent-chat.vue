<template>
  <section class="inline-agent" aria-label="Wiki Agent">
    <v-card class="inline-agent__card" elevation="5" rounded="xl">
      <v-toolbar class="inline-agent__toolbar" color="transparent" density="comfortable" tag="div">
        <v-avatar class="ml-3" color="primary" size="38" variant="tonal">
          <v-icon icon="mdi-auto-fix" />
        </v-avatar>
        <div class="inline-agent__heading ml-3">
          <div class="text-body-large font-weight-bold">Wiki Agent</div>
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
            <v-list-subheader>Recent conversations</v-list-subheader>
            <v-list-item
              v-for="session in sessions"
              :key="session.id"
              :active="session.id === thread?.session.id"
              :title="session.title || 'Untitled conversation'"
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

      <v-divider />
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
          v-if="thread && (profiles.length > 1 || skillsEnabled)"
          class="inline-agent__settings"
          :session="thread.session"
          :profiles="profiles"
          :skills="skills"
          :skills-enabled="skillsEnabled"
          :disabled="Boolean(activeRun)"
          @profile="agents.setProfile"
          @skills="agents.setSkills"
        />

        <div
          ref="transcript"
          class="inline-agent__transcript"
          :class="{ 'inline-agent__transcript--approval-jump': approvalJumpVisible }"
          tabindex="-1"
          @scroll.passive="updateApprovalJump"
        >
          <div v-if="thread && !hasConversation" class="inline-agent__welcome">
            <v-avatar color="primary" size="64" variant="tonal">
              <v-icon icon="mdi-book-open-page-variant-outline" size="34" />
            </v-avatar>
            <h2 class="text-headline-medium font-weight-bold mt-4">What would you like to know?</h2>
            <p class="text-body-large text-medium-emphasis mt-2 mb-5">
              Ask questions across pages you can access. Answers include Wiki citations, and proposed edits always require review.
            </p>
            <div class="inline-agent__starters" aria-label="Suggested questions">
              <v-btn
                v-for="starter in starters"
                :key="starter.prompt"
                class="inline-agent__starter"
                color="primary"
                variant="tonal"
                rounded="lg"
                @click="sendPrompt(starter.prompt)"
              >
                <v-icon start :icon="starter.icon" />
                {{ starter.label }}
              </v-btn>
            </div>
          </div>
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

      <v-divider />
      <footer class="inline-agent__composer">
        <AgentComposer
          :sending="sending"
          :can-stop="Boolean(activeRun?.canCancel)"
          :disabled="!providerAvailable || loading || !thread || Boolean(activeRun)"
          :skills-enabled="skillsEnabled"
          :skills="skills"
          :pinned-skill-version-ids="pinnedSkillVersionIds"
          :invocation-limit="invocationLimit"
          @send="sendPrompt"
          @stop="agents.stop"
          @manage-skills="skillManagerOpen = true"
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
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { AgentCurrentPageHint } from '../../../shared/agents/contracts.ts'
import { useAgentsStore } from '../../store/agents.ts'
import AgentComposer from './agent-composer.vue'
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
let initialization: Promise<void> | null = null

const currentPage = computed<AgentCurrentPageHint | null>(() => {
  if (props.pageId < 1 || !props.pageLocale || !props.pagePath || !props.pageUpdatedAt) return null
  return { id: props.pageId, locale: props.pageLocale, path: props.pagePath, observedUpdatedAt: props.pageUpdatedAt }
})
const activeRun = computed(() => thread.value?.session.currentRun?.canCancel ? thread.value.session.currentRun : null)
const hasConversation = computed(() => Boolean(thread.value && (thread.value.messages.length || thread.value.tools.length || thread.value.artifacts.length)))
const pendingApprovalId = computed(() => thread.value?.proposals.find(proposal => proposal.status === 'pending' && proposal.approval?.status === 'pending')?.id ?? null)
const providerAvailable = computed(() => props.providerEnabled && profiles.value.length > 0)
const pinnedSkillVersionIds = computed(() => thread.value?.session.skills.map(skill => skill.versionId) ?? [])
const invocationLimit = computed(() => Math.max(0, 8 - pinnedSkillVersionIds.value.length))
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
.inline-agent { margin: 0 auto; max-width: 76rem; padding: clamp(.75rem, 2vw, 1.5rem); width: 100%; }
.inline-agent__card { background: rgb(var(--v-theme-surface)); display: flex; flex-direction: column; height: min(78vh, 54rem); min-height: 32rem; overflow: hidden; text-align: start; }
.inline-agent__toolbar { flex: 0 0 auto; }
.inline-agent__heading { min-width: 0; }
.inline-agent__history { max-height: min(28rem, 70vh); min-width: min(24rem, 90vw); overflow-y: auto; }
.inline-agent__alert { flex: 0 0 auto; }
.inline-agent__settings { flex: 0 0 auto; max-height: 100%; overflow-y: auto; overscroll-behavior: contain; }
.inline-agent__settings:has(.v-expansion-panel-title[aria-expanded="true"]) { flex: 1 1 auto; min-height: clamp(9rem, 45dvh, 18rem); }
.inline-agent__body { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden; padding: 1rem 1.25rem 0; position: relative; }
.inline-agent__transcript { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: .25rem .25rem 1rem; scroll-behavior: smooth; }
.inline-agent__transcript--approval-jump { padding-bottom: 4.5rem; }
.inline-agent__approval-jump { bottom: 1rem; position: absolute; right: 1.75rem; z-index: 2; }
.inline-agent__welcome { align-items: center; display: flex; flex-direction: column; margin: auto; max-width: 46rem; padding: clamp(1.5rem, 5vh, 4rem) 1rem; text-align: center; }
.inline-agent__starters { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr)); width: 100%; }
.inline-agent__starter { height: auto; justify-content: flex-start; min-height: 3rem; padding: .75rem 1rem; text-transform: none; white-space: normal; }
.inline-agent__composer { background: rgb(var(--v-theme-surface)); flex: 0 0 auto; padding: 1rem 1.25rem 1.1rem; }
.inline-agent__notice { align-items: center; display: flex; gap: .35rem; justify-content: center; text-align: center; }
@media (max-width: 599.98px) {
  .inline-agent { padding: 0; }
  .inline-agent__card { border-radius: 0 !important; height: calc(100dvh - 64px); min-height: 0; }
  .inline-agent__body { padding-inline: .75rem; }
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
