<template>
  <section
    class="inline-agent"
    aria-labelledby="inline-agent-title"
    :aria-busy="loading"
  >
    <button
      v-if="historyOpen || memoryOpen"
      class="inline-agent__scrim"
      type="button"
      aria-label="Close Agent side panel"
      @click="closePanels"
    />
    <aside v-if="historyOpen" id="agent-history-panel" ref="historyPanel" class="inline-agent__side inline-agent__side--history" aria-label="Chat history panel" aria-modal="true">
      <AgentHistoryPanel @close="closeHistory" @reset="resetHistoryOpen = true" />
    </aside>
    <v-card class="inline-agent__card" elevation="0" rounded="xl">
      <v-toolbar class="inline-agent__toolbar" color="transparent" density="comfortable" tag="div">
        <v-avatar class="inline-agent__avatar ms-4" color="primary" size="34" variant="tonal">
          <v-icon icon="mdi-auto-fix" size="19" aria-hidden="true" />
        </v-avatar>
        <div class="inline-agent__heading ms-3">
          <h2 id="inline-agent-title" class="text-title-medium font-weight-medium">Wiki Agent</h2>
          <div class="inline-agent__session-title text-body-small text-medium-emphasis text-truncate">{{ sessionTitle }}</div>
        </div>
        <v-spacer />
        <v-chip
          v-if="activeRun || connection === 'reconnecting'"
          class="inline-agent__connection me-2"
          :color="connectionColor"
          size="small"
          variant="tonal"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >{{ connectionLabel }}</v-chip>
        <v-btn
          ref="historyTrigger"
          class="inline-agent__desktop-panel-btn"
          icon="mdi-history"
          :color="historyOpen ? 'primary' : undefined"
          :variant="historyOpen ? 'tonal' : 'text'"
          aria-label="Open agent conversation history"
          :aria-expanded="historyOpen"
          aria-controls="agent-history-panel"
          @click="toggleHistory"
        />
        <v-btn
          ref="memoryTrigger"
          class="inline-agent__desktop-panel-btn"
          icon="mdi-brain"
          :color="memoryOpen ? 'primary' : undefined"
          :variant="memoryOpen ? 'tonal' : 'text'"
          aria-label="Manage agent memory"
          :aria-expanded="memoryOpen"
          aria-controls="agent-memory-panel"
          @click="toggleMemory"
        />
        <v-menu class="inline-agent__mobile-actions" location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn ref="mobileActionsTrigger" v-bind="menuProps" icon="mdi-dots-vertical" aria-label="More Agent actions" />
          </template>
          <v-list density="compact">
            <v-list-item title="Conversation history" prepend-icon="mdi-history" @click="toggleHistory" />
            <v-list-item title="Agent memory" prepend-icon="mdi-brain" @click="toggleMemory" />
          </v-list>
        </v-menu>
        <v-btn
          class="me-2"
          icon="mdi-plus"
          variant="text"
          aria-label="Start a new agent conversation"
          :disabled="loading || sending"
          @click="newSession"
        />
      </v-toolbar>

      <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Opening conversation" />

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
          :disabled="Boolean(activeRun) || Boolean(openGoal)"
          @profile="agents.setProfile"
        />
        <AgentGoalStatus
          v-if="thread?.goal"
          :goal="thread.goal"
          :busy="goalBusy"
          :run-active="Boolean(activeRun)"
          @pause="agents.pauseGoal"
          @resume="agents.resumeGoal"
          @cancel="agents.cancelGoal"
        />


        <div
          ref="transcript"
          class="inline-agent__transcript"
          :class="{ 'inline-agent__transcript--approval-jump': approvalJumpVisible }"
          tabindex="-1"
          @scroll.passive="handleTranscriptScroll"
        >
          <p v-if="loading && !thread" class="inline-agent__loading text-body-medium text-medium-emphasis" role="status">Opening conversation</p>
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
                :disabled="!canSubmit"
                :title="!canSubmit ? submitUnavailableReason : undefined"
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
            :can-submit="canSubmit"
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
          ref="composer"
          :sending="sending"
          :can-stop="Boolean(activeRun?.canCancel)"
          :disabled="!canSubmit"
          :skills-enabled="skillsEnabled"
          :goals-enabled="goalsEnabled"
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
    <aside v-if="memoryOpen" id="agent-memory-panel" ref="memoryPanel" class="inline-agent__side inline-agent__side--memory" aria-label="Agent memory panel" aria-modal="true">
      <AgentMemoryManager v-model="memoryOpen" :csrf-token="csrfToken" />
    </aside>
  </section>
  <AgentPersonalSkills v-if="skillsEnabled" v-model="skillManagerOpen" :csrf-token="csrfToken" @changed="reloadSkillCatalog" />
  <v-dialog v-model="resetHistoryOpen" max-width="30rem" aria-labelledby="reset-history-title">
    <v-card rounded="xl">
      <v-card-title class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="error" size="38" variant="tonal"><v-icon icon="mdi-delete-sweep-outline" aria-hidden="true" /></v-avatar>
        <h2 id="reset-history-title" class="text-title-medium">Reset conversation history?</h2>
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { AgentCurrentPageHint } from '../../../shared/agents/contracts.ts'
import { useAgentsStore } from '../../store/agents.ts'
import { createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'
import AgentComposer from './agent-composer.vue'
import AgentHistoryPanel from './agent-history-panel.vue'
import AgentMemoryManager from './agent-memory-manager.vue'
import AgentPersonalSkills from './agent-personal-skills.vue'
import AgentMcpApproval from './agent-mcp-approval.vue'
import AgentSessionSettings from './agent-session-settings.vue'
import AgentGoalStatus from './agent-goal-status.vue'
import AgentThread from './agent-thread.vue'
import { isAgentApprovalOutsideViewport } from './agent-thread-presentation.ts'

const props = defineProps<{
  csrfToken: string
  approvalId?: string
  providerEnabled: boolean
  skillsEnabled: boolean
  goalsEnabled: boolean
  pageId: number
  pageLocale: string
  pagePath: string
  pageUpdatedAt: string
}>()

const agents = useAgentsStore()
const { connection, decidingApprovalId, error, goalBusy, loading, profiles, sending, skills, thread } = storeToRefs(agents)
const transcript = ref<HTMLElement | null>(null)
const composer = ref<{ focusInput: () => Promise<void> } | null>(null)
const historyPanel = ref<HTMLElement | null>(null)
const memoryPanel = ref<HTMLElement | null>(null)
const historyTrigger = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const memoryTrigger = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const mobileActionsTrigger = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const approvalJumpVisible = ref(false)
const skillManagerOpen = ref(false)
const resetHistoryOpen = ref(false)
const resetting = ref(false)
const historyOpen = ref(false)
const memoryOpen = ref(false)
const transcriptFollowing = ref(true)
let transcriptObserver: MutationObserver | null = null
let panelFocusScope: ModalFocusScope | null = null
let panelFocusKind: 'history' | 'memory' | null = null
let initialization: Promise<void> | null = null
let compactPanelMedia: MediaQueryList | null = null
const compactPanelQuery = '(max-width: 1711.98px)'

const currentPage = computed<AgentCurrentPageHint | null>(() => {
  if (props.pageId < 1 || !props.pageLocale || !props.pagePath || !props.pageUpdatedAt) return null
  return { id: props.pageId, locale: props.pageLocale, path: props.pagePath, observedUpdatedAt: props.pageUpdatedAt }
})
const activeRun = computed(() => {
  const run = thread.value?.session.currentRun
  return run && ['queued', 'running', 'awaiting_approval'].includes(run.status) ? run : null
})
const openGoal = computed(() => thread.value?.goal && ['active', 'paused', 'blocked'].includes(thread.value.goal.status) ? thread.value.goal : null)
const hasConversation = computed(() => Boolean(thread.value && (thread.value.messages.length || thread.value.tools.length || thread.value.artifacts.length || thread.value.goal)))
const pendingApprovalId = computed(() => thread.value?.proposals.find(proposal => proposal.status === 'pending' && proposal.approval?.status === 'pending')?.id ?? null)
const providerAvailable = computed(() => props.providerEnabled && profiles.value.length > 0)
const providerUnavailableMessage = computed(() => props.providerEnabled
  ? 'No enabled provider profile is available for your account. Ask an administrator to grant one in Administration → Agents.'
  : 'Agent inference is currently disabled. An administrator can configure it in Administration → Agents.')
const canSubmit = computed(() => providerAvailable.value && !loading.value && Boolean(thread.value) && !activeRun.value && !openGoal.value)
const submitUnavailableReason = computed(() => !providerAvailable.value ? providerUnavailableMessage.value : loading.value ? 'Opening conversation' : activeRun.value ? 'Wait for the current response to finish' : openGoal.value ? 'Finish or pause the current goal before sending a message' : '')
const preferredSkillIds = computed(() => thread.value?.session.skills.map(skill => skill.skillId) ?? [])
const invocationLimit = computed(() => Math.max(0, 8 - preferredSkillIds.value.length))
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
  const pending = agents.initialize(props.csrfToken, { routeSync: false, currentPage: currentPage.value, reuseLatest: true })
  initialization = pending
  void pending.then(() => { if (!agents.thread) initialization = null })
  return pending
}
const focusComposer = async (): Promise<void> => {
  await ensureInitialized()
  await nextTick()
  await composer.value?.focusInput()
}
const sendPrompt = async (
  content: string,
  invokedSkillVersionIds: readonly string[] = [],
  mode: 'message' | 'goal' = 'message',
  completion?: (success: boolean) => void
): Promise<boolean> => {
  const prompt = content.trim()
  if (!prompt) { completion?.(false); return false }
  await ensureInitialized()
  if (!canSubmit.value || (mode === 'goal' && !props.goalsEnabled)) { completion?.(false); return false }
  const success = await agents.send(prompt, invokedSkillVersionIds, mode)
  completion?.(success)
  return success
}
const focusConversation = async (): Promise<void> => {
  await nextTick()
  transcript.value?.focus({ preventScroll: true })
}
const reloadSkillCatalog = async (): Promise<void> => {
  try { await agents.reloadSkills() } catch (value) {
    agents.error = value instanceof Error ? value.message : 'The skill catalog could not be refreshed.'
  }
}
const newSession = async (): Promise<void> => {
  try { await ensureInitialized(); await agents.newSession('saved') } catch (value) {
    agents.error = value instanceof Error ? value.message : 'A new conversation could not be created.'
  }
}
const elementForRef = (value: { $el?: HTMLElement } | HTMLElement | null): HTMLElement | null =>
  value instanceof HTMLElement ? value : value?.$el ?? null
const closeHistory = (): void => { historyOpen.value = false }
const closeMemory = (): void => { memoryOpen.value = false }
const toggleHistory = (): void => {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value && window.matchMedia(compactPanelQuery).matches) memoryOpen.value = false
}
const toggleMemory = (): void => {
  memoryOpen.value = !memoryOpen.value
  if (memoryOpen.value && window.matchMedia(compactPanelQuery).matches) historyOpen.value = false
}
const reconcileCompactPanels = (event: MediaQueryListEvent): void => {
  if (event.matches && historyOpen.value && memoryOpen.value) memoryOpen.value = false
  if (!event.matches) panelFocusScope?.deactivate({ restoreFocus: false })
}
const closePanels = (): void => { historyOpen.value = false; memoryOpen.value = false }
const resetHistory = async (): Promise<void> => {
  resetting.value = true
  try { await agents.resetHistory(); resetHistoryOpen.value = false } catch (value) {
    agents.error = value instanceof Error ? value.message : 'Conversation history could not be reset.'
  } finally { resetting.value = false }
}
const updateApprovalJump = (): void => {
  const container = transcript.value
  const proposalId = pendingApprovalId.value
  if (!container || !proposalId) { approvalJumpVisible.value = false; return }
  const approval = container.querySelector<HTMLElement>(`#agent-approval-${proposalId}`)
  if (!approval) { approvalJumpVisible.value = false; return }
  approvalJumpVisible.value = isAgentApprovalOutsideViewport(container.getBoundingClientRect(), approval.getBoundingClientRect())
}
const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const jumpToApproval = async (): Promise<void> => {
  const proposalId = pendingApprovalId.value
  const approval = proposalId ? transcript.value?.querySelector<HTMLElement>(`#agent-approval-${proposalId}`) : null
  if (!approval) return
  approval.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' })
  await nextTick()
  approval.focus({ preventScroll: true })
  approvalJumpVisible.value = false
}
const handleTranscriptScroll = (): void => {
  const element = transcript.value
  if (!element) return
  transcriptFollowing.value = element.scrollHeight - element.scrollTop - element.clientHeight < 160
  updateApprovalJump()
}
const reconcileTranscriptGrowth = async (): Promise<void> => {
  const shouldFollow = transcriptFollowing.value || !transcript.value || transcript.value.scrollHeight - transcript.value.scrollTop - transcript.value.clientHeight < 160
  await nextTick()
  if (shouldFollow && transcript.value) transcript.value.scrollTo({ top: transcript.value.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
  transcriptFollowing.value = Boolean(transcript.value && transcript.value.scrollHeight - transcript.value.scrollTop - transcript.value.clientHeight < 160)
  updateApprovalJump()
}

watch(currentPage, page => agents.setCurrentPage(page), { immediate: true })
watch([historyOpen, memoryOpen], async ([history, memory]) => {
  const kind = history ? 'history' : memory ? 'memory' : null
  if (!kind || !compactPanelMedia?.matches) {
    if (!kind) { panelFocusScope?.deactivate({ restoreFocus: true }); panelFocusScope = null; panelFocusKind = null }
    return
  }
  panelFocusScope?.deactivate({ restoreFocus: false })
  await nextTick()
  const root = kind === 'history' ? historyPanel.value : memoryPanel.value
  if (!root) return
  const trigger = compactPanelMedia?.matches
    ? elementForRef(mobileActionsTrigger.value)
    : elementForRef(kind === 'history' ? historyTrigger.value : memoryTrigger.value)
  panelFocusScope = createModalFocusScope({ root, restoreTarget: trigger, onEscape: closePanels })
})
watch([thread, pendingApprovalId, connection], () => {
  void nextTick(() => { if (!hasConversation.value && transcript.value) transcript.value.scrollTop = 0; updateApprovalJump() })
}, { flush: 'post' })
onMounted(() => {
  compactPanelMedia = window.matchMedia(compactPanelQuery)
  compactPanelMedia.addEventListener('change', reconcileCompactPanels)
  transcriptObserver = new MutationObserver(() => { void reconcileTranscriptGrowth() })
  if (transcript.value) transcriptObserver.observe(transcript.value, { childList: true, subtree: true, characterData: true })
  void ensureInitialized()
})
onBeforeUnmount(() => {
  transcriptObserver?.disconnect()
  panelFocusScope?.deactivate({ restoreFocus: false })
  compactPanelMedia?.removeEventListener('change', reconcileCompactPanels)
  agents.closeWorkspace()
})
defineExpose({ sendPrompt, focusComposer, focusConversation })
</script>

<style scoped>
.inline-agent {
  --agent-border: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 16%, transparent);
  --agent-divider: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 11%, transparent);
  --agent-focus: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-surface));
  display: grid;
  font-family: 'WikiAgentSans', 'Tajawal', 'Roboto', system-ui, sans-serif;
  gap: 1rem;
  grid-template-columns: minmax(0, 1fr) minmax(36rem, 68rem) minmax(0, 1fr);
  margin: 0 auto;
  max-width: 112rem;
  position: relative;
  text-align: start;
  width: 100%;
}
.inline-agent__side {
  height: min(82dvh, 54rem);
  max-height: calc(100dvh - 1rem);
  min-height: min(34rem, calc(100dvh - 1rem));
  min-width: 0;
}
.inline-agent__side--history { grid-column: 1; justify-self: end; width: min(19rem, 100%); }
.inline-agent__side--memory { grid-column: 3; justify-self: start; width: min(21rem, 100%); }
.inline-agent__scrim { display: none; }
.inline-agent:dir(rtl),
.inline-agent:lang(ar) {
  font-family: 'Tajawal', 'WikiAgentSans', 'Roboto', system-ui, sans-serif;
}
.inline-agent :deep(.v-alert),
.inline-agent :deep(.v-btn),
.inline-agent :deep(.v-card),
.inline-agent :deep(.v-chip),
.inline-agent :deep(.v-field),
.inline-agent :deep(.v-input),
.inline-agent :deep(.v-list),
.inline-agent :deep(.v-toolbar) {
  font-family: inherit;
}
.inline-agent__card {
  grid-column: 2;
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 98%, rgb(var(--v-theme-background)));
  border: 1px solid var(--agent-border);
  box-shadow: 0 1.25rem 4rem color-mix(in srgb, rgb(var(--v-theme-on-surface)) 16%, transparent);
  display: flex;
  flex-direction: column;
  height: min(82dvh, 54rem);
  max-height: calc(100dvh - 1rem);
  min-height: min(34rem, calc(100dvh - 1rem));
  overflow: hidden;
  text-align: start;
}
.inline-agent__toolbar {
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 92%, rgb(var(--v-theme-primary)) 8%);
  border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 11%, transparent);
  flex: 0 0 auto;
  min-height: 4.25rem;
  padding-inline: .5rem;
}
.inline-agent__heading { min-width: 0; }
.inline-agent__heading h2 { margin: 0; }
.inline-agent__mobile-actions { display: none; }
.inline-agent__alert { flex: 0 0 auto; }
.inline-agent__settings { flex: 0 0 auto; max-height: 100%; overflow-y: auto; overscroll-behavior: contain; }
.inline-agent__settings:has(.v-expansion-panel-title[aria-expanded="true"]) { flex: 1 1 auto; min-height: clamp(9rem, 45dvh, 18rem); }
.inline-agent__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  padding: 1.1rem clamp(1rem, 3vw, 2rem) 0;
  position: relative;
}
.inline-agent__transcript {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: .5rem .25rem 1.5rem;
  scroll-behavior: smooth;
  scroll-padding-block: 1rem;
}
.inline-agent__loading { margin: 1rem auto; }
.inline-agent__transcript :deep(.agent-thread) {
  margin-inline: auto;
  max-width: 56rem;
  width: 100%;
}
.inline-agent__transcript:has(> .inline-agent__welcome) { display: flex; }
.inline-agent__transcript--approval-jump { padding-bottom: 4.5rem; }
.inline-agent__approval-jump { bottom: 1rem; position: absolute; right: 1.75rem; z-index: 2; }
.inline-agent__welcome {
  align-items: center;
  background:
    radial-gradient(circle at 92% 8%, color-mix(in srgb, rgb(var(--v-theme-primary)) 19%, transparent), transparent 38%),
    color-mix(in srgb, rgb(var(--v-theme-surface-variant)) 34%, rgb(var(--v-theme-surface)));
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 24%, rgb(var(--v-theme-on-surface)) 12%);
  border-radius: 1.5rem;
  box-shadow: 0 1rem 3rem color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent);
  display: flex;
  flex-direction: column;
  margin: auto;
  max-width: 48rem;
  overflow: hidden;
  padding: clamp(1.75rem, 5vw, 3.25rem);
  text-align: center;
  width: 100%;
}
.inline-agent__welcome-mark {
  align-items: center;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 16%, rgb(var(--v-theme-surface)));
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 30%, transparent);
  border-radius: 1.1rem;
  color: rgb(var(--v-theme-on-surface));
  display: flex;
  height: 3.4rem;
  justify-content: center;
  width: 3.4rem;
}
.inline-agent__welcome-eyebrow { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 700; letter-spacing: .12em; margin: 1.1rem 0 .4rem; text-transform: uppercase; }
.inline-agent__welcome h2 { font-size: clamp(1.55rem, 4vw, 2rem); font-weight: 650; letter-spacing: -.025em; line-height: 1.2; margin: 0; }
.inline-agent__welcome-copy { color: rgb(var(--v-theme-on-surface)); line-height: 1.6; margin: .7rem auto 1.5rem; max-width: 34rem; opacity: .72; }
.inline-agent__starters { display: grid; gap: .65rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); width: 100%; }
.inline-agent__composer {
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 96%, rgb(var(--v-theme-primary)) 4%);
  border-top: 1px solid var(--agent-divider);
  flex: 0 0 auto;
  padding: 1rem clamp(1rem, 3vw, 2rem) calc(1.1rem + env(safe-area-inset-bottom));
}
.inline-agent__notice { align-items: center; display: flex; gap: .35rem; justify-content: center; text-align: center; }
@media (max-width: 1711.98px) {
  .inline-agent__side {
    bottom: 0;
    height: auto;
    max-height: none;
    min-height: 0;
    position: absolute;
    top: 0;
    width: min(22rem, calc(100% - 2.5rem));
    z-index: 5;
  }
  .inline-agent__side--history { inset-inline-start: 0; }
  .inline-agent__side--memory { inset-inline-end: 0; }
  .inline-agent__scrim {
    background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 34%, transparent);
    border: 0;
    display: block;
    inset: 0;
    padding: 0;
    position: absolute;
    z-index: 4;
  }
}

@media (max-width: 599.98px) {
  .inline-agent { gap: 0; grid-template-columns: minmax(0, 1fr); height: 100dvh; }
  .inline-agent__card { grid-column: 1; }
  .inline-agent__side { width: min(22rem, calc(100% - 2.25rem)); }
  .inline-agent__card { border: 0; border-radius: 0 !important; box-shadow: none; height: 100dvh; max-height: none; min-height: 0; }
  .inline-agent__toolbar { padding-inline: .25rem; }
  .inline-agent__avatar,
  .inline-agent__session-title { display: none; }
  .inline-agent__heading { margin-inline-start: .4rem !important; }
  .inline-agent__connection { max-width: 7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inline-agent__desktop-panel-btn { display: none; }
  .inline-agent__mobile-actions { display: block; }
  .inline-agent__toolbar :deep(.v-btn) { min-height: 2.75rem; min-width: 2.75rem; }
  .inline-agent__body { padding-inline: .75rem; }
  .inline-agent__transcript { padding-inline: 0; }
  .inline-agent__welcome { border-radius: 1.25rem; padding: 1.4rem 1rem; }
  .inline-agent__starters { grid-template-columns: 1fr; }
  .inline-agent__composer { padding-inline: .75rem; }
  .inline-agent__approval-jump { bottom: .75rem; left: 1.5rem; right: 1.5rem; }
  .inline-agent__notice { display: flex; font-size: .72rem; line-height: 1.35; }
}
@media (max-height: 500px) {
  .inline-agent__card { height: 100dvh; max-height: none; min-height: 0; }
  .inline-agent__body { overflow-y: auto; padding: .5rem .75rem 0; }
  .inline-agent__composer { padding: .5rem .75rem; }
  .inline-agent__composer :deep(.v-input__details), .inline-agent__notice { display: none; }
  .inline-agent__welcome { padding-block: 1.25rem; }
}
@media (forced-colors: active) {
  .inline-agent__card { border: 1px solid CanvasText; }
}
@media (prefers-reduced-motion: reduce) {
  .inline-agent__transcript { scroll-behavior: auto; }
}
</style>
