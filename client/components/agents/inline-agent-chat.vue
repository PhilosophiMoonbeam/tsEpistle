<template>
  <section
    ref="inlineAgentRoot"
    class="inline-agent"
    aria-labelledby="inline-agent-title"
    :aria-busy="loading"
  >
    <button
      v-if="historyOpen || memoryOpen"
      class="inline-agent__scrim"
      ref="panelScrim"
      type="button"
      tabindex="-1"
      aria-label="Close Agent side panel"
      @click="closePanels"
    />

    <aside
      v-if="historyOpen"
      id="agent-history-panel"
      ref="historyPanel"
      class="inline-agent__side inline-agent__side--history"
      :role="compactPanels ? 'dialog' : undefined"
      aria-label="Chat history panel"
      :aria-modal="compactPanels ? 'true' : undefined"
      :tabindex="compactPanels ? -1 : undefined"
    >
      <v-card v-if="historyLoadError" class="inline-agent__panel-load-error" elevation="0" rounded="xl" role="alert">
        <header class="inline-agent__panel-load-error-header">
          <div>
            <p class="inline-agent__eyebrow">Conversation archive</p>
            <h2>History unavailable</h2>
          </div>
          <v-btn icon="mdi-close" size="small" variant="text" aria-label="Close chat history" @click="closeHistory" />
        </header>
        <div class="inline-agent__panel-load-error-body">
          <v-icon color="error" icon="mdi-archive-alert-outline" size="28" aria-hidden="true" />
          <p>{{ historyLoadError }}</p>
          <v-btn color="primary" prepend-icon="mdi-refresh" variant="tonal" :loading="historyLoading" @click="reloadHistory">
            Retry archive
          </v-btn>
        </div>
      </v-card>
      <AgentHistoryPanel v-else @close="closeHistory" @reset="openResetHistory" />
    </aside>

    <v-card class="inline-agent__card" elevation="0">
      <v-toolbar class="inline-agent__toolbar" color="transparent" density="comfortable" tag="header">
        <div class="inline-agent__identity">
          <v-avatar class="inline-agent__avatar" color="primary" size="38" variant="tonal">
            <v-icon icon="mdi-auto-fix" size="20" aria-hidden="true" />
          </v-avatar>
          <div class="inline-agent__heading">
            <p class="inline-agent__eyebrow">Knowledge workspace</p>
            <h2 id="inline-agent-title">Wiki Agent</h2>
            <p class="inline-agent__session-title">{{ sessionTitle }}</p>
          </div>
        </div>

        <v-spacer />

        <v-chip
          class="inline-agent__connection"
          :class="{ 'inline-agent__connection--active': loading || sending || Boolean(activeRun) || connection === 'reconnecting' }"
          :color="connectionColor"
          size="small"
          variant="tonal"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span class="inline-agent__connection-dot" aria-hidden="true" />
          {{ connectionLabel }}
        </v-chip>

        <div class="inline-agent__panel-actions" role="group" aria-label="Agent workspace panels">
          <v-btn
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
            class="inline-agent__desktop-panel-btn"
            icon="mdi-brain"
            :color="memoryOpen ? 'primary' : undefined"
            :variant="memoryOpen ? 'tonal' : 'text'"
            aria-label="Manage agent memory"
            :aria-expanded="memoryOpen"
            aria-controls="agent-memory-panel"
            @click="toggleMemory"
          />
          <v-menu location="bottom end">
            <template #activator="{ props: menuProps }">
              <v-btn v-bind="menuProps" class="inline-agent__mobile-panel-menu" prepend-icon="mdi-view-dashboard-outline" variant="text" size="small" aria-label="Open Agent panels: conversation history and memory">Panels</v-btn>
            </template>
            <v-list density="compact">
              <v-list-item title="Conversation history" prepend-icon="mdi-history" @click="toggleHistory" />
              <v-list-item title="Agent memory" prepend-icon="mdi-brain" @click="toggleMemory" />
            </v-list>
          </v-menu>
          <v-btn
            class="inline-agent__new-session"
            prepend-icon="mdi-plus"
            variant="tonal"
            aria-label="Start a new agent conversation"
            :disabled="loading || sending"
            @click="newSession"
          >New</v-btn>
        </div>
      </v-toolbar>

      <v-progress-linear
        v-if="loading"
        class="inline-agent__progress"
        indeterminate
        color="primary"
        aria-label="Opening conversation"
      />

      <AgentMcpApproval v-if="approvalId" :csrf-token="csrfToken" :proposal-id="approvalId" />
      <template v-else>
        <div class="inline-agent__body">
          <v-alert
            v-if="!loading && !providerAvailable"
            class="inline-agent__alert"
            variant="tonal"
            icon="mdi-connection"
          >
            {{ providerUnavailableMessage }}
          </v-alert>
          <v-alert
            v-if="error"
            class="inline-agent__alert"
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
            :apply-provider-profile="applyProviderProfile"
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
            aria-label="Conversation transcript"
            @scroll.passive="handleTranscriptScroll"
          >
            <div v-if="loading && !thread" class="inline-agent__loading" role="status">
              <span class="inline-agent__loading-mark" aria-hidden="true" />
              <span>
                <strong>Opening conversation</strong>
                <small>Recovering your latest working context</small>
              </span>
            </div>

            <section v-if="thread && !hasConversation" class="inline-agent__welcome" aria-labelledby="inline-agent-welcome-title">
              <div class="inline-agent__welcome-intro">
                <div class="inline-agent__welcome-mark" aria-hidden="true">
                  <v-icon icon="mdi-auto-fix" size="25" />
                </div>
                <div>
                  <p class="inline-agent__welcome-index">Archive desk · Ready</p>
                  <h2 id="inline-agent-welcome-title">Begin with what you need to understand.</h2>
                </div>
              </div>
              <p class="inline-agent__welcome-copy">
                Wiki Agent traces answers through the knowledge you can access, keeps sources visible, and turns careful intent into auditable work.
              </p>
              <div class="inline-agent__welcome-rule" aria-hidden="true">
                <span>Explore</span>
              </div>
              <div class="inline-agent__starters" role="group" aria-label="Conversation starters">
                <v-btn
                  v-for="starter in starters"
                  :key="starter.prompt"
                  class="inline-agent__starter"
                  color="primary"
                  variant="tonal"
                  :disabled="!canSubmit"
                  :title="!canSubmit ? submitUnavailableReason : undefined"
                  @click="sendPrompt(starter.prompt)"
                >
                  <v-icon start :icon="starter.icon" />
                  {{ starter.label }}
                  <v-icon class="inline-agent__starter-arrow" end icon="mdi-arrow-right" size="16" />
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
          <div v-if="currentPage" class="inline-agent__page-context">
            <v-icon icon="mdi-file-link-outline" size="16" aria-hidden="true" />
            <span><strong>Page context available</strong> · Wiki Agent can consult the page you are viewing</span>
          </div>
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
            @manage-skills="openSkillManager"
            @update-skill-preferences="agents.setSkillPreferences"
          />
          <div class="inline-agent__notice">
            <v-icon icon="mdi-shield-check-outline" size="15" aria-hidden="true" />
            <span>Permissions are enforced. Verify cited sources before relying on model output.</span>
          </div>
        </footer>
      </template>
    </v-card>

    <aside
      v-if="memoryOpen"
      id="agent-memory-panel"
      ref="memoryPanel"
      class="inline-agent__side inline-agent__side--memory"
      :role="compactPanels ? 'dialog' : undefined"
      aria-label="Agent memory panel"
      :aria-modal="compactPanels ? 'true' : undefined"
      :tabindex="compactPanels ? -1 : undefined"
    >
      <AgentMemoryManager :model-value="memoryOpen" :csrf-token="csrfToken" @update:model-value="updateMemoryOpen" />
    </aside>
  </section>

  <AgentPersonalSkills v-if="skillsEnabled" v-model="skillManagerOpen" :csrf-token="csrfToken" @changed="reloadSkillCatalog" />

  <v-dialog v-model="resetHistoryOpen" max-width="30rem" aria-labelledby="reset-history-title">
    <v-card rounded="xl">
      <v-card-title class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="error" size="38" variant="tonal"><v-icon icon="mdi-delete-sweep-outline" aria-hidden="true" /></v-avatar>
        <h2 id="reset-history-title" class="text-title-medium">{{ resetCommitted ? 'Conversation history reset' : 'Reset conversation history?' }}</h2>
      </v-card-title>
      <v-card-text class="px-5">
        <p v-if="resetCommitted">The archive was removed, but the clean conversation did not finish opening. Retry only the conversation load below.</p>
        <p v-else>Every Agent conversation will be permanently removed and a clean conversation will open. Your curated Agent memory stays intact.</p>
        <v-alert v-if="resetError" class="mt-4" density="compact" type="error" variant="tonal" role="alert">
          {{ resetError }}
        </v-alert>
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="closeResetHistory">{{ resetCommitted ? 'Close' : 'Cancel' }}</v-btn>
        <v-btn v-if="resetCommitted" color="primary" prepend-icon="mdi-refresh" :loading="resetting" @click="recoverResetHistory">
          Retry opening conversation
        </v-btn>
        <v-btn v-else color="error" :loading="resetting" @click="resetHistory">
          {{ resetError ? 'Retry reset' : 'Reset history' }}
        </v-btn>
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
const { connection, decidingApprovalId, error, goalBusy, loading, profiles, sending, sessions, skills, thread } = storeToRefs(agents)
const inlineAgentRoot = ref<HTMLElement | null>(null)
const transcript = ref<HTMLElement | null>(null)
const composer = ref<{ focusInput: () => Promise<void>; focusSkillsTrigger: () => Promise<void> } | null>(null)
const historyPanel = ref<HTMLElement | null>(null)
const memoryPanel = ref<HTMLElement | null>(null)
const panelScrim = ref<HTMLElement | null>(null)
const approvalJumpVisible = ref(false)
const skillManagerOpen = ref(false)
const resetHistoryOpen = ref(false)
const resetting = ref(false)
const resetError = ref('')
const resetCommitted = ref(false)
const historyOpen = ref(false)
const historyLoadError = ref('')
const historyLoading = ref(false)
const memoryOpen = ref(false)
const transcriptFollowing = ref(true)
const compactPanels = ref(false)
let transcriptObserver: MutationObserver | null = null
let transcriptFrame: number | null = null
let transcriptFrameShouldFollow = false
let panelFocusScope: ModalFocusScope | null = null
let panelFocusKind: 'history' | 'memory' | null = null
let pendingPanelFocusKind: 'history' | 'memory' | null = null
let initialization: Promise<void> | null = null
let compactPanelMedia: MediaQueryList | null = null
const compactPanelQuery = '(max-width: 1711.98px)'
const mobilePanelQuery = '(max-width: 639.98px)'

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
const canSubmit = computed(() => providerAvailable.value && !loading.value && !sending.value && Boolean(thread.value) && !activeRun.value && !openGoal.value)
const submitUnavailableReason = computed(() => !providerAvailable.value ? providerUnavailableMessage.value : loading.value ? 'Opening conversation' : sending.value ? 'Sending your message' : activeRun.value ? 'Wait for the current response to finish' : openGoal.value ? 'Finish or pause the current goal before sending a message' : '')
const preferredSkillIds = computed(() => thread.value?.session.skills.map(skill => skill.skillId) ?? [])
const invocationLimit = computed(() => Math.max(0, 8 - preferredSkillIds.value.length))
const sessionTitle = computed(() => thread.value?.session.title || 'New conversation')
const connectionLabel = computed(() => loading.value
  ? 'Opening'
  : connection.value === 'reconnecting'
    ? 'Reconnecting'
    : !providerAvailable.value
      ? 'Unavailable'
      : activeRun.value?.status === 'awaiting_approval'
        ? 'Review needed'
        : sending.value
          ? 'Sending'
          : activeRun.value
            ? 'Working'
            : 'Ready')
const connectionColor = computed(() => !providerAvailable.value && !loading.value
  ? 'error'
  : connection.value === 'reconnecting' || activeRun.value?.status === 'awaiting_approval'
    ? 'warning'
    : loading.value || sending.value || activeRun.value
      ? 'primary'
      : 'success')
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
const applyProviderProfile = async (providerProfileId: string | null): Promise<
  { readonly success: true } | { readonly success: false; readonly error: string }
> => {
  const sessionId = thread.value?.session.id
  if (!sessionId) return { success: false, error: 'The conversation is no longer available. Open it again and retry.' }
  const sessionChanged = (): boolean => thread.value?.session.id !== sessionId
  try {
    const updated = await agents.setProfile(providerProfileId)
    if (sessionChanged()) return { success: true }
    if (updated) return { success: true }
    return {
      success: false,
      error: error.value || 'The provider profile could not be applied. Refresh the conversation and retry.'
    }
  } catch (value) {
    if (sessionChanged()) return { success: true }
    return {
      success: false,
      error: value instanceof Error ? value.message : 'The provider profile could not be applied. Try again.'
    }
  }
}
const newSession = async (): Promise<void> => {
  try { await ensureInitialized(); await agents.newSession('saved') } catch (value) {
    agents.error = value instanceof Error ? value.message : 'A new conversation could not be created.'
  }
}
const isVisibleTrigger = (element: HTMLElement | null): element is HTMLElement => {
  if (!element || !element.isConnected || element.getClientRects().length === 0) return false
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}
const triggerForPanel = (kind: 'history' | 'memory'): HTMLElement | null => {
  const root = inlineAgentRoot.value
  if (!root) return null
  const directLabel = kind === 'history' ? 'Open agent conversation history' : 'Manage agent memory'
  const direct = root.querySelector<HTMLElement>(`[aria-label="${directLabel}"]`)
  const mobile = root.querySelector<HTMLElement>('[aria-label="Open Agent panels: conversation history and memory"]')
  const useMobileTrigger = window.matchMedia(mobilePanelQuery).matches
  return (useMobileTrigger ? [mobile, direct] : [direct, mobile]).find(isVisibleTrigger) ?? null
}
const openSkillManager = (): void => { skillManagerOpen.value = true }
const preparePanelTriggerRestore = (kind: 'history' | 'memory'): void => {
  pendingPanelFocusKind = kind
}
const closeHistory = (): void => {
  const closingKind = compactPanels.value && historyOpen.value ? 'history' : null
  if (closingKind) preparePanelTriggerRestore(closingKind)
  historyOpen.value = false
}
const closeMemory = (): void => {
  const closingKind = compactPanels.value && memoryOpen.value ? 'memory' : null
  if (closingKind) preparePanelTriggerRestore(closingKind)
  memoryOpen.value = false
}
const updateMemoryOpen = (open: boolean): void => {
  if (open) memoryOpen.value = true
  else closeMemory()
}
const reloadHistory = async (): Promise<void> => {
  if (historyLoading.value) return
  historyLoading.value = true
  try {
    const results = await Promise.allSettled([agents.reloadSessions(), agents.reloadFolders()])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    historyLoadError.value = ''
  } catch (value) {
    historyLoadError.value = value instanceof Error ? value.message : 'Conversation history could not be loaded.'
  } finally {
    historyLoading.value = false
  }
}
const toggleHistory = (): void => {
  if (historyOpen.value) {
    closeHistory()
    return
  }
  historyOpen.value = true
  if (compactPanels.value) memoryOpen.value = false
  void reloadHistory()
}
const toggleMemory = (): void => {
  if (memoryOpen.value) {
    closeMemory()
    return
  }
  memoryOpen.value = true
  if (compactPanels.value) historyOpen.value = false
}
const reconcileCompactPanels = (event: MediaQueryListEvent): void => {
  compactPanels.value = event.matches
  if (event.matches && historyOpen.value && memoryOpen.value) memoryOpen.value = false
}
const closePanels = (): void => {
  const closingKind = compactPanels.value
    ? historyOpen.value ? 'history' : memoryOpen.value ? 'memory' : null
    : null
  if (closingKind) preparePanelTriggerRestore(closingKind)
  historyOpen.value = false
  memoryOpen.value = false
}
const openResetHistory = (): void => {
  resetError.value = ''
  resetCommitted.value = false
  resetHistoryOpen.value = true
}
const closeResetHistory = (): void => {
  if (resetting.value) return
  resetHistoryOpen.value = false
  resetError.value = ''
  resetCommitted.value = false
}
const resetHistory = async (): Promise<void> => {
  const originalSessionId = thread.value?.session.id ?? null
  const originalSessionCount = sessions.value.length
  resetting.value = true
  resetError.value = ''
  resetCommitted.value = false
  try {
    await agents.resetHistory()
    resetHistoryOpen.value = false
  } catch (value) {
    resetCommitted.value = originalSessionId !== null
      ? thread.value?.session.id !== originalSessionId
      : originalSessionCount > 0 && sessions.value.length === 0
    const detail = value instanceof Error ? value.message : 'Conversation history could not be reset.'
    resetError.value = resetCommitted.value
      ? `History was reset, but a clean conversation could not be opened. ${detail}`
      : detail
  } finally {
    resetting.value = false
  }
}
const recoverResetHistory = async (): Promise<void> => {
  if (resetting.value) return
  resetting.value = true
  try {
    await agents.reloadSessions()
    if (!thread.value && sessions.value[0]) {
      const opened = await agents.openSession(sessions.value[0].id)
      if (!opened) throw new Error('The clean conversation changed before it could be opened. Retry.')
    } else if (!thread.value && profiles.value.length > 0) {
      await agents.newSession('saved')
    }
    resetHistoryOpen.value = false
    resetError.value = ''
    resetCommitted.value = false
  } catch (value) {
    const detail = value instanceof Error ? value.message : 'A clean conversation could not be opened.'
    resetError.value = `History was reset, but a clean conversation still could not be opened. ${detail}`
  } finally {
    resetting.value = false
  }
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
const transcriptIsNearBottom = (element: HTMLElement | null): boolean =>
  Boolean(element && element.scrollHeight - element.scrollTop - element.clientHeight < 160)
const handleTranscriptScroll = (): void => {
  transcriptFollowing.value = transcriptIsNearBottom(transcript.value)
  updateApprovalJump()
}
const reconcileTranscriptGrowth = async (shouldFollow: boolean): Promise<void> => {
  await nextTick()
  if (shouldFollow && transcript.value) {
    transcript.value.scrollTo({ top: transcript.value.scrollHeight, behavior: 'auto' })
    transcriptFollowing.value = true
  } else {
    transcriptFollowing.value = transcriptIsNearBottom(transcript.value)
  }
  updateApprovalJump()
}
const scheduleTranscriptReconcile = (): void => {
  transcriptFrameShouldFollow ||= transcriptFollowing.value || transcriptIsNearBottom(transcript.value)
  if (transcriptFrame !== null) return
  transcriptFrame = window.requestAnimationFrame(() => {
    const shouldFollow = transcriptFrameShouldFollow
    transcriptFrame = null
    transcriptFrameShouldFollow = false
    void reconcileTranscriptGrowth(shouldFollow)
  })
}

watch(currentPage, page => agents.setCurrentPage(page), { immediate: true })
watch(skillManagerOpen, (open, wasOpen) => {
  if (!open && wasOpen) void nextTick(() => composer.value?.focusSkillsTrigger())
})
watch([historyOpen, memoryOpen, compactPanels], async ([history, memory, compact]) => {
  const kind = history ? 'history' : memory ? 'memory' : null
  if (!kind || !compact) {
    panelFocusScope?.deactivate({ restoreFocus: false })
    panelFocusScope = null
    panelFocusKind = null
    return
  }
  if (panelFocusScope && panelFocusKind === kind) return
  panelFocusScope?.deactivate({ restoreFocus: false })
  panelFocusScope = null
  panelFocusKind = null
  await nextTick()
  const currentKind = historyOpen.value ? 'history' : memoryOpen.value ? 'memory' : null
  if (!compactPanels.value || currentKind !== kind) return
  const root = kind === 'history' ? historyPanel.value : memoryPanel.value
  if (!root) return
  panelFocusKind = kind
  panelFocusScope = createModalFocusScope({
    root,
    restoreTarget: () => triggerForPanel(kind),
    additionalRoots: () => panelScrim.value ? [panelScrim.value] : [],
    onEscape: kind === 'history' ? closeHistory : closeMemory
  })
})
watch([historyOpen, memoryOpen], ([history, memory]) => {
  if (history || memory) {
    pendingPanelFocusKind = null
    return
  }
  const restoreKind = pendingPanelFocusKind
  pendingPanelFocusKind = null
  if (!restoreKind) return
  triggerForPanel(restoreKind)?.focus({ preventScroll: true })
}, { flush: 'post' })
watch(() => thread.value?.session.id, (sessionId, previousSessionId) => {
  if (!historyOpen.value || !sessionId || !previousSessionId || sessionId === previousSessionId) return
  panelFocusScope?.deactivate({ restoreFocus: false })
  panelFocusScope = null
  panelFocusKind = null
  if (compactPanels.value) historyOpen.value = false
  void nextTick(async () => {
    if (hasConversation.value) transcript.value?.focus({ preventScroll: true })
    else await composer.value?.focusInput()
  })
})
watch([thread, pendingApprovalId, connection], () => {
  void nextTick(() => { if (!hasConversation.value && transcript.value) transcript.value.scrollTop = 0; updateApprovalJump() })
}, { flush: 'post' })
onMounted(() => {
  compactPanelMedia = window.matchMedia(compactPanelQuery)
  compactPanels.value = compactPanelMedia.matches
  compactPanelMedia.addEventListener('change', reconcileCompactPanels)
  transcriptObserver = new MutationObserver(scheduleTranscriptReconcile)
  if (transcript.value) transcriptObserver.observe(transcript.value, { childList: true, subtree: true, characterData: true })
  window.addEventListener('resize', scheduleTranscriptReconcile)
  window.visualViewport?.addEventListener('resize', scheduleTranscriptReconcile)
  void ensureInitialized()
})
onBeforeUnmount(() => {
  transcriptObserver?.disconnect()
  if (transcriptFrame !== null) window.cancelAnimationFrame(transcriptFrame)
  panelFocusScope?.deactivate({ restoreFocus: false })
  compactPanelMedia?.removeEventListener('change', reconcileCompactPanels)
  window.removeEventListener('resize', scheduleTranscriptReconcile)
  window.visualViewport?.removeEventListener('resize', scheduleTranscriptReconcile)
  agents.closeWorkspace()
})
defineExpose({ sendPrompt, focusComposer, focusConversation })
</script>

<style scoped>
.inline-agent {
  position: relative;
  display: grid;
  width: 100%;
  max-width: var(--wiki-shell-max);
  margin: 0 auto;
  grid-template-columns: minmax(0, 1fr) minmax(36rem, 68rem) minmax(0, 1fr);
  gap: var(--wiki-space-4);
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-body);
  text-align: start;
}

.inline-agent:dir(rtl),
.inline-agent:lang(ar) {
  font-family: 'Tajawal', var(--wiki-font-body);
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

.inline-agent__card,
.inline-agent__side {
  height: min(82dvh, 54rem);
  max-height: calc(100dvh - var(--wiki-space-4));
  min-height: min(34rem, calc(100dvh - var(--wiki-space-4)));
}

.inline-agent__card {
  position: relative;
  display: flex;
  min-width: 0;
  grid-column: 2;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-hero-radius) !important;
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset);
  text-align: start;
}

.inline-agent__toolbar {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-6));
  flex: 0 0 auto;
  padding-inline: var(--wiki-space-4);
  border-bottom: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--wiki-accent-warm) 7%, var(--wiki-surface-raised)),
      var(--wiki-surface-raised) 42%,
      color-mix(in srgb, var(--wiki-accent-spectral) 4%, var(--wiki-surface-raised))
    ) !important;
  box-shadow: var(--wiki-shadow-xs);
}

.inline-agent__toolbar::after {
  position: absolute;
  inset-block-end: -1px;
  inset-inline-start: var(--wiki-space-6);
  width: calc(var(--wiki-space-12) * 2);
  height: 1px;
  background: var(--wiki-ambient-accent);
  content: '';
}

.inline-agent__identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-3);
}

.inline-agent__avatar {
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--wiki-accent-warm) 10%, var(--wiki-surface-raised)) !important;
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.inline-agent__heading {
  min-width: 0;
}

.inline-agent__eyebrow,
.inline-agent__session-title {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inline-agent__eyebrow {
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .1em;
  line-height: 1.2;
  text-transform: uppercase;
}

.inline-agent__heading h2 {
  margin: var(--wiki-space-1) 0 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
  font-size: 1rem;
  font-weight: 720;
  letter-spacing: -.015em;
  line-height: 1.2;
}

.inline-agent__session-title {
  max-width: 28rem;
  margin-top: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.2;
}

.inline-agent__connection {
  flex: 0 0 auto;
  margin-inline: var(--wiki-space-2);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
}

.inline-agent__connection-dot {
  width: var(--wiki-space-2);
  height: var(--wiki-space-2);
  margin-inline-end: var(--wiki-space-2);
  border-radius: var(--wiki-radius-pill);
  background: currentColor;
  box-shadow: 0 0 0 var(--wiki-space-1) color-mix(in srgb, currentColor 14%, transparent);
}
.inline-agent__connection--active .inline-agent__connection-dot {
  animation: agentPulse 1.8s var(--wiki-motion-ease) infinite;
}

.inline-agent__panel-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--wiki-space-1);
}

.inline-agent__mobile-panel-menu {
  display: none !important;
}

.inline-agent__new-session {
  margin-inline-start: var(--wiki-space-1);
}

.inline-agent__progress {
  position: absolute;
  z-index: 3;
  inset-block-start: calc(var(--wiki-control-height) + var(--wiki-space-6) - var(--wiki-space-1));
  inset-inline: 0;
  pointer-events: none;
}

.inline-agent__body {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
  padding: var(--wiki-space-4) clamp(var(--wiki-space-4), 3vw, var(--wiki-space-8)) 0;
  background:
    repeating-linear-gradient(
      to bottom,
      transparent 0,
      transparent calc(var(--wiki-space-12) - 1px),
      color-mix(in srgb, var(--wiki-surface-border) 34%, transparent) var(--wiki-space-12)
    ),
    var(--wiki-surface-sunken);
}

.inline-agent__alert {
  flex: 0 0 auto;
  margin-bottom: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
}

.inline-agent__settings {
  max-height: 100%;
  flex: 0 0 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.inline-agent__settings:has(.v-expansion-panel-title[aria-expanded='true']) {
  min-height: clamp(9rem, 45dvh, 18rem);
  flex: 1 1 auto;
}

.inline-agent__transcript {
  min-height: 0;
  flex: 1 1 auto;
  padding: var(--wiki-space-3) var(--wiki-space-1) var(--wiki-space-6);
  overflow-y: auto;
  outline: none;
  overscroll-behavior: contain;
  scroll-behavior: smooth;
  scroll-padding-block: var(--wiki-space-4);
}

.inline-agent__transcript:focus-visible {
  border-radius: var(--wiki-control-radius);
  box-shadow: inset var(--wiki-focus-ring);
}

.inline-agent__transcript :deep(.agent-thread) {
  width: 100%;
  max-width: 56rem;
  margin-inline: auto;
}

.inline-agent__transcript:has(> .inline-agent__welcome) {
  display: flex;
}

.inline-agent__transcript--approval-jump {
  padding-bottom: calc(var(--wiki-space-12) * 1.5);
}

.inline-agent__loading {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-3);
  margin: var(--wiki-space-6) auto;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.inline-agent__loading-mark {
  width: var(--wiki-space-3);
  height: var(--wiki-space-3);
  border: 1px solid var(--wiki-accent-warm);
  border-radius: var(--wiki-radius-pill);
  background: var(--wiki-accent-warm);
  animation: agentPulse 1.8s var(--wiki-motion-ease) infinite;
}

.inline-agent__loading span:last-child {
  display: grid;
}

.inline-agent__loading strong {
  color: rgb(var(--v-theme-on-surface));
  font-size: .875rem;
}

.inline-agent__loading small {
  font-size: var(--wiki-label-size);
}

.inline-agent__approval-jump {
  position: absolute;
  z-index: 2;
  inset-block-end: var(--wiki-space-4);
  inset-inline-end: var(--wiki-space-8);
  box-shadow: var(--wiki-shadow-md);
}

.inline-agent__welcome {
  position: relative;
  width: min(100%, 48rem);
  margin: auto;
  padding: clamp(var(--wiki-space-6), 5vw, var(--wiki-space-10));
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  background:
    linear-gradient(
      145deg,
      color-mix(in srgb, var(--wiki-accent-warm) 7%, var(--wiki-surface-raised)),
      var(--wiki-surface-raised) 48%,
      color-mix(in srgb, var(--wiki-accent-spectral) 5%, var(--wiki-surface-raised))
    );
  box-shadow: var(--wiki-shadow-md), var(--wiki-shadow-inset);
  text-align: start;
}

.inline-agent__welcome::before {
  position: absolute;
  inset-block: var(--wiki-space-6);
  inset-inline-start: 0;
  width: var(--wiki-space-1);
  border-radius: 0 var(--wiki-radius-pill) var(--wiki-radius-pill) 0;
  background: var(--wiki-ambient-accent);
  content: '';
}

.inline-agent__welcome::after {
  position: absolute;
  inset-block-start: var(--wiki-space-4);
  inset-inline-end: var(--wiki-space-4);
  width: var(--wiki-space-10);
  height: var(--wiki-space-10);
  border-block-start: 1px solid color-mix(in srgb, var(--wiki-accent-spectral) 30%, transparent);
  border-inline-end: 1px solid color-mix(in srgb, var(--wiki-accent-spectral) 30%, transparent);
  content: '';
}

.inline-agent__welcome-intro {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-4);
}

.inline-agent__welcome-mark {
  display: grid;
  width: calc(var(--wiki-space-12) + var(--wiki-space-2));
  height: calc(var(--wiki-space-12) + var(--wiki-space-2));
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 30%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 10%, var(--wiki-surface-raised));
  color: var(--wiki-accent-warm);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.inline-agent__welcome-index {
  margin: 0 0 var(--wiki-space-1);
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .11em;
  text-transform: uppercase;
}

.inline-agent__welcome h2 {
  max-width: 36rem;
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
  font-size: clamp(1.5rem, 4vw, 2.125rem);
  font-weight: 680;
  letter-spacing: -.035em;
  line-height: var(--wiki-leading-heading);
}

.inline-agent__welcome-copy {
  max-width: 39rem;
  margin: var(--wiki-space-5) 0 var(--wiki-space-6);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  line-height: var(--wiki-leading-body);
}

.inline-agent__welcome-rule {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-3);
  margin-bottom: var(--wiki-space-3);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 54%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .08em;
  text-transform: uppercase;
}

.inline-agent__welcome-rule::after {
  height: 1px;
  flex: 1;
  background: var(--wiki-surface-border);
  content: '';
}

.inline-agent__starters {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--wiki-space-2);
}

.inline-agent__starter {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-2));
  justify-content: flex-start;
  padding-inline: var(--wiki-space-3);
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 18%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  text-align: start;
}

.inline-agent__starter-arrow {
  margin-inline-start: auto !important;
  opacity: .58;
}

.inline-agent__composer {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  padding: var(--wiki-space-3) clamp(var(--wiki-space-4), 3vw, var(--wiki-space-8)) max(var(--wiki-space-3), env(safe-area-inset-bottom));
  border-top: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--wiki-accent-warm) 3%, var(--wiki-surface-raised)),
      var(--wiki-surface-raised)
    );
  box-shadow: 0 calc(var(--wiki-space-2) * -1) var(--wiki-space-8) color-mix(in srgb, var(--wiki-shadow-color) 42%, transparent);
}

.inline-agent__page-context {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-2);
  margin: 0 var(--wiki-space-2) var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 60%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.4;
}

.inline-agent__page-context .v-icon {
  color: var(--wiki-accent-warm);
}

.inline-agent__page-context strong {
  color: rgb(var(--v-theme-on-surface));
  font-weight: var(--wiki-label-weight);
}

.inline-agent__notice {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--wiki-space-1);
  margin-top: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 52%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.4;
  text-align: center;
}

.inline-agent__side {
  position: relative;
  min-width: 0;
  outline: none;
}

.inline-agent__side:focus-visible {
  border-radius: var(--wiki-panel-radius);
  box-shadow: var(--wiki-focus-ring);
}

.inline-agent__panel-load-error {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-raised);
}

.inline-agent__panel-load-error-header {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--wiki-space-3);
  justify-content: space-between;
  padding: var(--wiki-space-4);
  border-bottom: 1px solid var(--wiki-surface-border);
}

.inline-agent__panel-load-error-header h2 {
  margin: var(--wiki-space-1) 0 0;
  font-family: var(--wiki-font-heading);
  font-size: 1rem;
}

.inline-agent__panel-load-error-body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-6);
  text-align: center;
}

.inline-agent__panel-load-error-body p {
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  font-size: .8125rem;
  line-height: 1.5;
}

.inline-agent__side--history {
  width: min(19rem, 100%);
  grid-column: 1;
  justify-self: end;
}

.inline-agent__side--memory {
  width: min(21rem, 100%);
  grid-column: 3;
  justify-self: start;
}

.inline-agent__scrim {
  display: none;
}

@keyframes agentPulse {
  50% {
    opacity: .42;
    transform: scale(.82);
  }
}

@media (max-width: 1711.98px) {
  .inline-agent__side {
    position: absolute;
    z-index: 5;
    inset-block: 0;
    width: 22rem;
    max-width: calc(100% - var(--wiki-space-10));
    height: auto;
    max-height: none;
    min-height: 0;
    grid-column: 1 / -1;
    grid-row: 1;
    box-sizing: border-box;
    filter: drop-shadow(var(--wiki-shadow-md));
  }

  .inline-agent__side--history {
    inset-inline-start: 0;
  }

  .inline-agent__side--memory {
    inset-inline-end: 0;
  }

  .inline-agent__scrim {
    position: absolute;
    z-index: 4;
    display: block;
    inset: 0;
    padding: 0;
    border: 0;
    background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 40%, transparent);
  }
}

@media (max-width: 900px) {
  .inline-agent__starters {
    grid-template-columns: 1fr;
  }

  .inline-agent__welcome {
    max-width: 40rem;
  }
}

@media (max-width: 639.98px) {
  .inline-agent {
    height: 100dvh;
    min-height: 100svh;
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }

  .inline-agent__card {
    height: 100dvh;
    min-height: 100svh;
    max-height: none;
    grid-column: 1;
    border: 0;
    border-radius: 0 !important;
    box-shadow: none;
  }

  .inline-agent__side {
    position: fixed;
    width: min(22rem, calc(100% - var(--wiki-space-8)));
  }
  .inline-agent__scrim {
    position: fixed;
  }

  .inline-agent__toolbar {
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-4));
    padding-block-start: env(safe-area-inset-top);
    padding-inline: var(--wiki-space-2);
  }
  .inline-agent__progress {
    inset-block-start: calc(var(--wiki-control-height) + var(--wiki-space-4) + env(safe-area-inset-top) - var(--wiki-space-1));
  }

  .inline-agent__avatar,
  .inline-agent__eyebrow,
  .inline-agent__session-title {
    display: none;
  }

  .inline-agent__heading h2 {
    margin: 0;
  }

  .inline-agent__connection {
    max-width: 7rem;
    margin-inline: var(--wiki-space-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .inline-agent__desktop-panel-btn {
    display: none;
  }

  .inline-agent__mobile-panel-menu {
    display: inline-flex !important;
    min-width: auto !important;
    padding-inline: var(--wiki-space-2) !important;
    letter-spacing: 0;
    text-transform: none;
  }

  .inline-agent__panel-actions {
    gap: 0;
  }

  .inline-agent__new-session {
    min-width: var(--wiki-control-height);
    padding-inline: var(--wiki-space-2);
  }

  .inline-agent__new-session :deep(.v-btn__content) {
    font-size: 0;
  }

  .inline-agent__new-session :deep(.v-btn__prepend) {
    margin: 0;
  }

  .inline-agent__toolbar :deep(.v-btn) {
    min-width: var(--wiki-control-height);
    min-height: var(--wiki-control-height);
  }

  .inline-agent__body {
    padding: var(--wiki-space-2) var(--wiki-space-3) 0;
  }

  .inline-agent__transcript {
    padding-inline: 0;
  }

  .inline-agent__welcome {
    padding: var(--wiki-space-5);
  }

  .inline-agent__welcome-intro {
    align-items: flex-start;
  }

  .inline-agent__welcome-mark {
    width: var(--wiki-space-10);
    height: var(--wiki-space-10);
  }

  .inline-agent__welcome h2 {
    font-size: 1.5rem;
  }

  .inline-agent__welcome-copy {
    margin-block: var(--wiki-space-4);
  }

  .inline-agent__composer {
    padding: var(--wiki-space-2) var(--wiki-space-3) max(var(--wiki-space-2), env(safe-area-inset-bottom));
  }

  .inline-agent__page-context {
    margin-inline: var(--wiki-space-1);
  }

  .inline-agent__page-context span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .inline-agent__approval-jump {
    inset-block-end: var(--wiki-space-3);
    inset-inline: var(--wiki-space-6);
  }
}

@media (max-width: 380px) {
  .inline-agent__connection {
    max-width: var(--wiki-space-10);
    padding-inline: var(--wiki-space-2) !important;
    font-size: 0;
  }

  .inline-agent__connection-dot {
    margin: 0;
  }

  .inline-agent__welcome-intro {
    display: block;
  }

  .inline-agent__welcome-mark {
    margin-bottom: var(--wiki-space-3);
  }

  .inline-agent__page-context {
    display: none;
  }
}

@media (max-height: 500px) {
  .inline-agent__card {
    height: 100dvh;
    min-height: 0;
    max-height: none;
  }

  .inline-agent__toolbar {
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-2));
  }

  .inline-agent__avatar,
  .inline-agent__eyebrow,
  .inline-agent__session-title {
    display: none;
  }

  .inline-agent__progress {
    inset-block-start: calc(var(--wiki-control-height) + var(--wiki-space-2) - var(--wiki-space-1));
  }

  .inline-agent__body {
    padding-block-start: var(--wiki-space-1);
  }

  .inline-agent__composer {
    padding-block: var(--wiki-space-1);
  }

  .inline-agent__page-context {
    display: none;
  }

  .inline-agent__notice {
    justify-content: flex-start;
    margin-top: var(--wiki-space-1);
    font-size: .6875rem;
    line-height: 1.25;
    text-align: start;
  }

  .inline-agent__welcome {
    padding-block: var(--wiki-space-4);
  }
}

@media (forced-colors: active) {
  .inline-agent__card,
  .inline-agent__welcome,
  .inline-agent__side {
    border: 1px solid CanvasText;
  }

  .inline-agent__scrim {
    background: Canvas;
    opacity: .72;
  }

  .inline-agent__toolbar::after,
  .inline-agent__welcome::before,
  .inline-agent__connection-dot,
  .inline-agent__loading-mark {
    background: Highlight;
  }
}

@media (prefers-reduced-motion: reduce) {
  .inline-agent__transcript {
    scroll-behavior: auto;
  }

  .inline-agent__connection-dot,
  .inline-agent__loading-mark {
    animation: none;
  }
}
</style>
