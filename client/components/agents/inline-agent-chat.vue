<template>
  <section
    ref="inlineAgentRoot"
    class="inline-agent"
    :class="{ 'inline-agent--history': historyOpen, 'inline-agent--memory': memoryOpen }"
    :data-panel-mode="panelMode"
    :aria-labelledby="workspaceTitleId"
    :aria-busy="loading || Boolean(creatingRetention)"
  >
    <button
      v-if="panelMode === 'modal' && (historyOpen || memoryOpen)"
      class="inline-agent__scrim"
      ref="panelScrim"
      type="button"
      tabindex="-1"
      aria-label="Close Agent side panel"
      @click="closePanels"
    />

    <div
      v-if="historyOpen"
      id="agent-history-panel"
      ref="historyPanel"
      class="inline-agent__side inline-agent__side--history"
      :role="panelMode === 'modal' ? 'dialog' : 'complementary'"
      :aria-labelledby="historyHeadingId"
      :aria-describedby="historyDescriptionId"
      :aria-modal="panelMode === 'modal' ? 'true' : undefined"
      :tabindex="panelMode === 'modal' ? -1 : undefined"
    >
      <AgentHistoryPanel
        :heading-id="historyHeadingId"
        :description-id="historyDescriptionId"
        @close="closeHistory"
        @clear="openClearUnfiledHistory"
      />
    </div>

    <v-card class="inline-agent__card" elevation="0">
      <v-toolbar class="inline-agent__toolbar" color="transparent" density="comfortable" tag="header">
        <div class="inline-agent__toolbar-main">
          <div class="inline-agent__mobile-navigation">
            <v-btn class="inline-agent__mobile-return" icon="mdi-magnify" variant="text" aria-label="Return to Wiki Search" :disabled="memoryMutationBusy" :title="memoryMutationBusy ? 'Wait for the memory change to finish' : undefined" @click="emit('return-search')" />
          </div>
          <div class="inline-agent__identity">
            <v-avatar class="inline-agent__avatar" color="primary" size="38" variant="tonal">
              <v-icon icon="mdi-book-open-page-variant-outline" size="20" aria-hidden="true" />
            </v-avatar>
            <div class="inline-agent__heading">
              <h2 :id="workspaceTitleId">Wiki Agent</h2>
              <p class="inline-agent__session-title" :title="sessionTitle">{{ sessionTitle }}</p>
            </div>
          </div>
        </div>

        <div class="inline-agent__panel-actions" role="group" aria-label="Agent workspace actions">
          <v-btn
            class="inline-agent__desktop-panel-btn"
            ref="historyTrigger"
            prepend-icon="mdi-history"
            :color="historyOpen ? 'primary' : undefined"
            :variant="historyOpen ? 'tonal' : 'text'"
            :aria-label="historyOpen ? 'Close agent conversation history' : 'Open agent conversation history'"
            :aria-expanded="historyOpen"
            aria-controls="agent-history-panel"
            :disabled="memoryMutationBusy && memoryOpen && panelMode !== 'wide'"
            @click="toggleHistory"
          >History</v-btn>
          <v-btn
            class="inline-agent__desktop-panel-btn"
            ref="memoryTrigger"
            prepend-icon="mdi-brain"
            :color="memoryOpen ? 'primary' : undefined"
            :variant="memoryOpen ? 'tonal' : 'text'"
            :aria-label="memoryOpen ? 'Close agent memory' : 'Manage agent memory'"
            :aria-expanded="memoryOpen"
            aria-controls="agent-memory-panel"
            :disabled="memoryMutationBusy"
            @click="toggleMemory"
          >Memory</v-btn>
          <v-menu v-model="panelMenuOpen" ref="panelMenu" content-class="agent-owned-overlay" location="bottom end" attach=".inline-agent">
            <template #activator="{ props: menuProps }">
              <v-btn
                v-bind="menuProps"
                ref="panelMenuTrigger"
                class="inline-agent__mobile-panel-menu"
                prepend-icon="mdi-view-dashboard-outline"
                variant="text"
                aria-label="Open Agent panels: conversation history and memory"
              >Panels</v-btn>
            </template>
            <v-list density="compact">
              <v-list-item
                class="inline-agent__panel-menu-item"
                link
                prepend-icon="mdi-history"
                title="Conversation history"
                :disabled="memoryMutationBusy && memoryOpen && panelMode !== 'wide'"
                @click="toggleHistory"
              />
              <v-list-item
                class="inline-agent__panel-menu-item"
                link
                prepend-icon="mdi-brain"
                title="Agent memory"
                :disabled="memoryMutationBusy"
                @click="toggleMemory"
              />
            </v-list>
          </v-menu>
          <v-menu content-class="agent-owned-overlay" location="bottom end" attach=".inline-agent">
            <template #activator="{ props: menuProps }">
              <v-btn
                v-bind="menuProps"
                ref="newSessionTrigger"
                class="inline-agent__session-action inline-agent__new-session"
                prepend-icon="mdi-plus"
                variant="tonal"
                :loading="Boolean(creatingRetention)"
                aria-label="New conversation"
                :disabled="loading || sending || sessionMutationBusy"
              >New</v-btn>
            </template>
            <v-list density="compact">
              <v-list-item
                class="inline-agent__panel-menu-item"
                link
                prepend-icon="mdi-bookmark-outline"
                title="Saved conversation"
                subtitle="Keep this conversation in history"
                :disabled="loading || sending || sessionMutationBusy"
                @click="newSession"
              />
              <v-list-item
                class="inline-agent__panel-menu-item"
                link
                prepend-icon="mdi-clock-outline"
                title="Temporary conversation"
                subtitle="Start without saving to history"
                :disabled="loading || sending || sessionMutationBusy"
                @click="newTemporarySession"
              />
            </v-list>
          </v-menu>
          <v-btn class="inline-agent__mobile-close" icon="mdi-close" variant="text" aria-label="Close Wiki Agent" :disabled="memoryMutationBusy" :title="memoryMutationBusy ? 'Wait for the memory change to finish' : undefined" @click="emit('close')" />
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
        <div v-if="isTemporary" class="inline-agent__retention" aria-label="Temporary conversation" role="status">
          <v-icon icon="mdi-clock-outline" size="22" aria-hidden="true" />
          <div class="inline-agent__retention-copy">
            <strong>Temporary conversation</strong>
            <p>Hidden from history<span v-if="temporaryExpiry"> · Expires {{ temporaryExpiry }}</span>. Personal memory still applies.</p>
          </div>
          <v-btn variant="text" size="small" prepend-icon="mdi-bookmark-outline" :loading="keepingConversation" :disabled="sessionMutationBusy || loading || sending" @click="keepConversation">Keep conversation</v-btn>
        </div>
        <p v-else-if="sessionNotice" class="inline-agent__session-notice" role="status">{{ sessionNotice }}</p>
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
            v-if="!loading && !thread && initializationError"
            class="inline-agent__alert inline-agent__initialization-error"
            type="error"
            variant="tonal"
            role="alert"
          >
            <div class="inline-agent__initialization-error-content">
              <span>{{ initializationError }}</span>
              <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :disabled="loading" @click="retryInitialization">Retry opening conversation</v-btn>
            </div>
          </v-alert>
          <v-alert
            v-if="error && (thread || !initializationError)"
            class="inline-agent__alert"
            type="error"
            variant="tonal"
            closable
            @click:close="agents.error = ''"
          >{{ error }}</v-alert>

          <div class="inline-agent__transcript-wrap">
            <div
              ref="transcript"
              class="inline-agent__transcript"
              tabindex="0"
              role="region"
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
                <div class="inline-agent__welcome-mark" aria-hidden="true"><v-icon icon="mdi-book-open-page-variant-outline" size="30" /></div>
                <p class="inline-agent__welcome-index">Your knowledge, connected</p>
                <h2 id="inline-agent-welcome-title">A little curiosity.
                  <em>A clearer picture.</em></h2>
                <p class="inline-agent__welcome-copy">
                  Explore an idea, connect the dots, or work on your Wiki. Start with a question; follow the sources wherever they lead.
                </p>
                <div class="inline-agent__starters" role="group" aria-label="Conversation starters">
                  <v-btn
                    v-for="starter in starters"
                    :key="starter.prompt"
                    class="inline-agent__starter"
                    color="primary"
                    variant="text"
                    :disabled="!canSubmit"
                    :title="!canSubmit ? submitUnavailableReason : undefined"
                    @click="preparePrompt(starter.prompt)"
                  >
                    <v-icon start :icon="starter.icon" />
                    <span class="inline-agent__starter-copy"><strong>{{ starter.label }}</strong><small>{{ starter.description }}</small></span>
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
                @suggest="preparePrompt"
                @ask-source="source => preparePrompt(`Help me understand “${source.title}”.`, source)"
                @decision="agents.decideProposal"
              />
              <div
                v-if="thread?.goal"
                class="inline-agent__goal-dock"
                :class="{ 'inline-agent__goal-dock--expanded': goalExpanded }"
              >
                <AgentGoalStatus
                  :goal="thread.goal"
                  :busy="goalBusy"
                  :run-active="Boolean(activeRun)"
                  :expanded="goalExpanded"
                  @pause="agents.pauseGoal"
                  @resume="agents.resumeGoal"
                  @cancel="agents.cancelGoal"
                  @update:expanded="handleGoalExpanded"
                />
              </div>
            </div>

            <nav
              v-if="approvalJumpVisible || followJumpVisible"
              class="inline-agent__jump-dock"
              aria-label="Conversation navigation"
            >
              <v-btn
                v-if="approvalJumpVisible"
                class="inline-agent__approval-jump"
                color="warning"
                variant="elevated"
                prepend-icon="mdi-shield-alert-outline"
                append-icon="mdi-arrow-down"
                @click="jumpToApproval"
              >Approval required</v-btn>
              <v-btn
                v-else
                class="inline-agent__follow-jump"
                color="primary"
                variant="tonal"
                prepend-icon="mdi-arrow-down"
                aria-label="Jump to latest response"
                @click="scrollToLatest"
              >Latest response</v-btn>
            </nav>
          </div>
        </div>

        <footer class="inline-agent__composer">
          <div class="inline-agent__composer-inner">
            <AgentContextPicker v-if="thread" :draft="activeDraft" :current-page="currentPage" @change="patchDraft" @find-sources="emit('return-search')" />
            <p
              v-if="openGoal || sessionMutationBusy"
              id="agent-composer-lock-reason"
              class="inline-agent__composer-lock"
              role="status"
              aria-live="polite"
            >
              <v-icon icon="mdi-lock-outline" size="16" aria-hidden="true" />
              <span>{{ openGoal ? goalSubmitUnavailableReason : submitUnavailableReason }}</span>
            </p>
            <AgentComposer
              :key="thread?.session.id ?? 'opening'"
              ref="composer"
              :session-id="thread?.session.id"
              :initial-draft="thread ? agents.drafts[thread.session.id]?.text : ''"
              :initial-mode="thread ? agents.drafts[thread.session.id]?.mode : 'message'"
              :initial-skill-version-ids="thread ? agents.drafts[thread.session.id]?.skillVersionIds : []"
              @draft-change="agents.setDraft"
              @composition-change="agents.updateDraft"
              :sending="sending"
              :can-stop="Boolean(activeRun?.canCancel)"
              :disabled="!canSubmit"
              :has-messages="hasConversation"
              :external-description-id="openGoal || sessionMutationBusy ? 'agent-composer-lock-reason' : undefined"
              :skills-enabled="skillsEnabled"
              :goals-enabled="goalsEnabled"
              :skills="skills"
              :skills-loading="skillsLoading"
              :skills-load-error="skillsLoadError"
              :skills-partial="skillsPartial"
              :preferred-skills="thread?.session.skills ?? []"
              :invocation-limit="invocationLimit"
              :status-label="connectionLabel"
              :status-tone="connectionTone"
              @send="sendPrompt"
              @stop="agents.stop"
              @manage-skills="openSkillManager"
              @retry-skills="agents.reloadSkills"
              @update-skill-preferences="agents.setSkillPreferences"
            />
          </div>
        </footer>
      </template>
    </v-card>

    <div
      v-show="memoryOpen"
      id="agent-memory-panel"
      ref="memoryPanel"
      class="inline-agent__side inline-agent__side--memory"
      :role="panelMode === 'modal' ? 'dialog' : 'complementary'"
      :aria-labelledby="memoryHeadingId"
      :aria-describedby="memoryDescriptionId"
      :aria-modal="panelMode === 'modal' ? 'true' : undefined"
      :tabindex="panelMode === 'modal' ? -1 : undefined"
    >
      <AgentMemoryManager
        :model-value="memoryOpen"
        :csrf-token="csrfToken"
        :heading-id="memoryHeadingId"
        :description-id="memoryDescriptionId"
        @update:model-value="updateMemoryOpen"
        @update:busy="memoryMutationBusy = $event"
      />
    </div>
  </section>

  <AgentPersonalSkills v-if="skillsEnabled" v-model="skillManagerOpen" :csrf-token="csrfToken" @changed="reloadSkillCatalog" />

  <v-dialog
    content-class="agent-owned-overlay"
    v-model="clearUnfiledHistoryOpen"
    max-width="30rem"
    aria-labelledby="clear-unfiled-history-title"
    :persistent="clearingUnfiledHistory || sessionMutationBusy"
  >
    <v-card rounded="xl">
      <v-card-title class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="error" size="38" variant="tonal"><v-icon icon="mdi-delete-sweep-outline" aria-hidden="true" /></v-avatar>
        <h2 id="clear-unfiled-history-title" class="text-title-medium">
          {{ clearUnfiledCommitted ? 'Unfiled conversations cleared' : 'Clear unfiled conversations?' }}
        </h2>
      </v-card-title>
      <v-card-text class="px-5">
        <p v-if="clearUnfiledCommitted">
          Unfiled conversations were cleared, but a replacement conversation did not finish opening. Saved folders and their filed conversations remain unchanged. Retry only the conversation load below.
        </p>
        <p v-else>
          Only conversations outside saved folders will be permanently removed. Saved folders and their filed conversations will remain. If the current conversation is unfiled, a new saved conversation will open. Your curated Agent memory stays intact.
        </p>
        <v-alert v-if="clearUnfiledError" class="mt-4" density="compact" type="error" variant="tonal" role="alert">
          {{ clearUnfiledError }}
        </v-alert>
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" :disabled="clearingUnfiledHistory || sessionMutationBusy" @click="closeClearUnfiledHistory">
          {{ clearUnfiledCommitted ? 'Close' : 'Cancel' }}
        </v-btn>
        <v-btn
          v-if="clearUnfiledCommitted"
          color="primary"
          prepend-icon="mdi-refresh"
          :loading="clearingUnfiledHistory"
          :disabled="clearingUnfiledHistory || sessionMutationBusy"
          @click="recoverClearUnfiledHistory"
        >
          Retry opening conversation
        </v-btn>
        <v-btn
          v-else
          color="error"
          :loading="clearingUnfiledHistory"
          :disabled="clearingUnfiledHistory || sessionMutationBusy"
          @click="clearUnfiledHistory"
        >
          {{ clearUnfiledError ? 'Retry clear' : 'Clear unfiled' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { AgentCurrentPageHint } from '../../../shared/agents/contracts.ts'
import { useAgentsStore } from '../../store/agents.ts'
import { activeOwnedOverlayRoots, createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'
import AgentComposer from './agent-composer.vue'
import AgentHistoryPanel from './agent-history-panel.vue'
import AgentMemoryManager from './agent-memory-manager.vue'
import AgentPersonalSkills from './agent-personal-skills.vue'
import AgentMcpApproval from './agent-mcp-approval.vue'
import AgentGoalStatus from './agent-goal-status.vue'
import AgentThread from './agent-thread.vue'
import AgentContextPicker from './agent-context-picker.vue'
import { emptyAgentDraft, type AgentDraft, type AgentSearchScope } from '../../helpers/agent-draft.ts'
import type { WikiSource } from '../../../shared/wiki-source.ts'
import { isAgentApprovalOutsideViewport, shouldFollowGoalExpansion } from './agent-thread-presentation.ts'

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
const emit = defineEmits<{
  (event: 'return-search'): void
  (event: 'close'): void
}>()

const agents = useAgentsStore()
const { connection, decidingApprovalId, error, goalBusy, loading, profiles, sending, sessionMutationBusy, skills, skillsLoadError, skillsLoading, skillsPartial, thread } = storeToRefs(agents)
const inlineAgentRoot = useTemplateRef<HTMLElement>('inlineAgentRoot')
const transcript = useTemplateRef<HTMLElement>('transcript')
const composer = useTemplateRef<{ focusInput: () => Promise<void>; focusSkillsTrigger: () => Promise<void>; setDraft: (value: string) => Promise<void> }>('composer')
type ComponentRoot = { $el?: unknown }
const historyTrigger = useTemplateRef<ComponentRoot | HTMLElement>('historyTrigger')
const memoryTrigger = useTemplateRef<ComponentRoot | HTMLElement>('memoryTrigger')
const panelMenuTrigger = useTemplateRef<ComponentRoot | HTMLElement>('panelMenuTrigger')
const historyPanel = useTemplateRef<HTMLElement>('historyPanel')
const memoryPanel = useTemplateRef<HTMLElement>('memoryPanel')
const panelScrim = useTemplateRef<HTMLElement>('panelScrim')
const panelIdPrefix = useId()
const workspaceTitleId = `${panelIdPrefix}-workspace-title`
const historyHeadingId = `${panelIdPrefix}-history-title`
const historyDescriptionId = `${panelIdPrefix}-history-description`
const memoryHeadingId = `${panelIdPrefix}-memory-title`
const memoryDescriptionId = `${panelIdPrefix}-memory-description`
const goalExpanded = ref(false)
const approvalJumpVisible = ref(false)
const skillManagerOpen = ref(false)
const clearUnfiledHistoryOpen = ref(false)
const clearingUnfiledHistory = ref(false)
const clearUnfiledError = ref('')
const clearUnfiledCommitted = ref(false)
const creatingRetention = ref<'saved' | 'temporary' | null>(null)
const keepingConversation = ref(false)
const sessionNotice = ref('')
const historyOpen = ref(false)
const memoryOpen = ref(false)
const panelMenuOpen = ref(false)
const memoryMutationBusy = ref(false)
const initializationError = ref('')
const transcriptFollowing = ref(true)
let transcriptObserver: MutationObserver | null = null
let transcriptFrame: number | null = null
let transcriptFrameShouldFollow = false
let panelFocusScope: ModalFocusScope | null = null
let panelFocusKind: 'history' | 'memory' | null = null
let pendingPanelFocusKind: 'history' | 'memory' | null = null
let initialization: Promise<void> | null = null
const panelMode = ref<'wide' | 'docked' | 'modal'>('wide')
let panelModeMedia: MediaQueryList[] = []
const mobilePanelQuery = '(max-width: 639.98px)'

const currentPage = computed<AgentCurrentPageHint | null>(() => {
  if (props.pageId < 1 || !props.pageLocale || !props.pagePath || !props.pageUpdatedAt) return null
  return { id: props.pageId, locale: props.pageLocale, path: props.pagePath, observedUpdatedAt: props.pageUpdatedAt }
})
const activeRun = computed(() => {
  const run = thread.value?.session.currentRun
  return run && (run.status === 'queued' || run.status === 'running' || run.status === 'awaiting_approval') ? run : null
})
const openGoal = computed(() => {
  const goal = thread.value?.goal
  return goal && (goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked') ? goal : null
})
const hasConversation = computed(() => Boolean(thread.value && (thread.value.messages.length || thread.value.tools.length || thread.value.artifacts.length || thread.value.goal)))
const followJumpVisible = computed(() => Boolean(hasConversation.value && !transcriptFollowing.value && !approvalJumpVisible.value))
const pendingApprovalId = computed(() => thread.value?.proposals.find(proposal => proposal.status === 'pending' && proposal.approval?.status === 'pending')?.id ?? null)
const providerAvailable = computed(() => props.providerEnabled && profiles.value.length > 0)
const providerUnavailableMessage = computed(() => props.providerEnabled
  ? 'No enabled provider profile is available for your account. Ask an administrator to grant one in Administration → Agents.'
  : 'Agent inference is currently disabled. An administrator can configure it in Administration → Agents.')
const canSubmit = computed(() => providerAvailable.value && !loading.value && !sending.value && !sessionMutationBusy.value && Boolean(thread.value) && !activeRun.value && !openGoal.value)
const goalSubmitUnavailableReason = computed(() => !openGoal.value
  ? ''
  : openGoal.value.status === 'paused'
    ? 'Resume or cancel the current goal before sending a message'
    : 'Finish or cancel the current goal before sending a message')
const submitUnavailableReason = computed(() => !providerAvailable.value ? providerUnavailableMessage.value : loading.value ? 'Opening conversation' : sending.value ? 'Sending your message' : sessionMutationBusy.value ? 'Wait for the current conversation update to finish' : activeRun.value ? 'Wait for the current response to finish' : openGoal.value ? goalSubmitUnavailableReason.value : '')
const preferredSkillIds = computed(() => thread.value?.session.skills.map(skill => skill.skillId) ?? [])
const invocationLimit = computed(() => Math.max(0, 8 - preferredSkillIds.value.length))
const isTemporary = computed(() => thread.value?.session.retention === 'temporary' && !thread.value.session.folderId)
const temporaryExpiry = computed(() => {
  const value = thread.value?.session.expiresAt
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
})
const sessionTitle = computed(() => thread.value?.session.title || (isTemporary.value ? 'Temporary conversation' : 'New conversation'))
const connectionLabel = computed(() => loading.value
  ? 'Opening'
  : connection.value === 'reconnecting'
    ? 'Reconnecting'
    : !providerAvailable.value
      ? 'Unavailable'
      : Boolean(error.value)
        ? 'Try again'
        : activeRun.value?.status === 'awaiting_approval'
          ? 'Review needed'
          : sending.value
            ? 'Sending'
            : activeRun.value
              ? 'Working'
              : 'Ready')
const connectionTone = computed<'ready' | 'error' | 'busy'>(() => loading.value || connection.value === 'reconnecting'
  ? 'busy'
  : !providerAvailable.value || Boolean(error.value)
    ? 'error'
    : sending.value || Boolean(activeRun.value)
      ? 'busy'
      : 'ready')
const starters = computed(() => [
  ...(currentPage.value
    ? [{ label: 'Understand this page', description: 'Key ideas, with sources', prompt: 'Summarize the current Wiki page and cite the key sections.', icon: 'mdi-text-box-search-outline' }]
    : [{ label: 'Explore the Wiki', description: 'Find a place to begin', prompt: 'Give me an overview of the main topics in the Wiki, with links to useful starting pages.', icon: 'mdi-compass-outline' }]),
  { label: 'Connect the dots', description: 'Discover related knowledge', prompt: currentPage.value ? 'Find Wiki pages related to the current page and explain how they connect.' : 'Help me explore connections between topics in the Wiki. Ask me which topic I want to start with.', icon: 'mdi-vector-link' },
  { label: 'Catch up', description: 'See what changed recently', prompt: 'Summarize the most recently updated Wiki pages I can access.', icon: 'mdi-history' }
])

const activeDraft = computed(() => thread.value ? agents.drafts[thread.value.session.id] ?? emptyAgentDraft() : emptyAgentDraft())
const patchDraft = (patch: Partial<AgentDraft>): void => { if (thread.value) agents.updateDraft(thread.value.session.id, patch) }

const preparePrompt = async (prompt: string, source?: WikiSource, scope?: AgentSearchScope): Promise<void> => {
  await ensureInitialized()
  const sessionId = thread.value?.session.id
  if (!sessionId) return
  if (scope) agents.updateDraft(sessionId, { scope })
  if (source) {
    const sources = agents.drafts[sessionId]?.sources ?? []
    if (!sources.some(item => item.id === source.id)) {
      if (sources.length >= 8) { agents.error = 'Eight sources are already attached. Remove one before adding another.'; return }
      agents.updateDraft(sessionId, { sources: [...sources, source] })
    }
  }
  await nextTick()
  const existing = agents.drafts[sessionId]?.text ?? ''
  await composer.value?.setDraft(existing.trim() && existing.trim() !== prompt.trim() ? source ? existing : `${existing}\n\n${prompt}` : prompt)
}

const initializationFailureMessage = (value: unknown): string =>
  value instanceof Error && value.message
    ? value.message
    : typeof value === 'string' && value
      ? value
      : 'The conversation could not be opened.'
const ensureInitialized = (): Promise<void> => {
  if (initialization) return initialization
  initializationError.value = ''
  const pending = agents.initialize(props.csrfToken, { routeSync: false, currentPage: currentPage.value, reuseLatest: true })
  const tracked = pending.then(
    () => {
      if (thread.value) {
        initializationError.value = ''
        return
      }
      initializationError.value = error.value || 'The conversation could not be opened. Retry to try again.'
      if (initialization === tracked) initialization = null
    },
    value => {
      if (!thread.value) initializationError.value = initializationFailureMessage(value)
      if (initialization === tracked) initialization = null
    }
  )
  initialization = tracked
  return tracked
}
const retryInitialization = async (): Promise<void> => {
  if (loading.value || thread.value) return
  initializationError.value = ''
  agents.error = ''
  await ensureInitialized()
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
  if (sessionMutationBusy.value) { completion?.(false); return false }
  if (!prompt) { completion?.(false); return false }
  try {
    await ensureInitialized()
    if (!canSubmit.value || (mode === 'goal' && !props.goalsEnabled)) { completion?.(false); return false }
    const success = await agents.send(prompt, invokedSkillVersionIds, mode)
    completion?.(success)
    return success
  } catch (value) {
    agents.error = value instanceof Error ? value.message : 'The message could not be sent.'
    completion?.(false)
    return false
  }
}
const focusConversation = async (): Promise<void> => {
  await nextTick()
  transcript.value?.focus({ preventScroll: true })
}
const scrollToLatest = async (): Promise<void> => {
  const container = transcript.value
  if (!container) return
  container.scrollTo({ top: container.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
  transcriptFollowing.value = true
  await nextTick()
  if (container !== transcript.value || !container.isConnected) return
  container.focus({ preventScroll: true })
  updateApprovalJump()
}
const reloadSkillCatalog = async (): Promise<void> => {
  await agents.reloadSkills()
}
const keepConversation = async (): Promise<void> => {
  const sessionId = thread.value?.session.id
  if (!sessionId || sessionMutationBusy.value || keepingConversation.value) return
  keepingConversation.value = true
  try {
    const kept = await agents.setSessionRetention(sessionId, 'saved')
    if (!kept || thread.value?.session.id !== sessionId) return
    sessionNotice.value = hasConversation.value ? 'Conversation kept in history.' : 'Conversation kept. It will appear in history after your first message.'
  } catch (value) {
    agents.error = value instanceof Error ? value.message : 'The conversation could not be kept.'
  } finally {
    keepingConversation.value = false
  }
}
const createSession = async (retention: 'saved' | 'temporary'): Promise<void> => {
  if (sessionMutationBusy.value || creatingRetention.value) return
  creatingRetention.value = retention
  sessionNotice.value = ''
  try {
    await ensureInitialized()
    if (sessionMutationBusy.value) return
    await agents.newSession(retention)
    if (thread.value?.session.retention === retention) {
      sessionNotice.value = retention === 'saved' ? 'New conversation ready.' : ''
      await nextTick()
      await composer.value?.focusInput()
    }
  } catch (value) {
    const kind = retention === 'temporary' ? 'temporary conversation' : 'new saved conversation'
    agents.error = value instanceof Error ? value.message : `A ${kind} could not be created.`
  } finally {
    creatingRetention.value = null
  }
}
const newTemporarySession = (): Promise<void> => createSession('temporary')
const newSession = (): Promise<void> => createSession('saved')
const isVisibleTrigger = (element: HTMLElement | null): element is HTMLElement => {
  if (!element || !element.isConnected || element.getClientRects().length === 0) return false
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}
const componentElement = (component: ComponentRoot | HTMLElement | null): HTMLElement | null => {
  if (component instanceof HTMLElement) return component
  return component?.$el instanceof HTMLElement ? component.$el : null
}
const triggerForPanel = (kind: 'history' | 'memory'): HTMLElement | null => {
  const direct = componentElement(kind === 'history' ? historyTrigger.value : memoryTrigger.value)
  const panels = componentElement(panelMenuTrigger.value)
  const usePanelMenu = window.matchMedia(mobilePanelQuery).matches
  return (usePanelMenu ? [panels, direct] : [direct, panels]).find(isVisibleTrigger) ?? null
}
const openSkillManager = (): void => { skillManagerOpen.value = true }
const preparePanelTriggerRestore = (kind: 'history' | 'memory'): void => {
  pendingPanelFocusKind = kind
}
const closeHistory = (): void => {
  const closingKind = panelMode.value === 'modal' && historyOpen.value ? 'history' : null
  if (closingKind) preparePanelTriggerRestore(closingKind)
  historyOpen.value = false
}
const closeMemory = (): void => {
  if (memoryMutationBusy.value) return
  const closingKind = panelMode.value === 'modal' && memoryOpen.value ? 'memory' : null
  if (closingKind) preparePanelTriggerRestore(closingKind)
  memoryOpen.value = false
}
const updateMemoryOpen = (open: boolean): void => {
  if (open) memoryOpen.value = true
  else closeMemory()
}
const toggleHistory = (): void => {
  if (memoryMutationBusy.value && memoryOpen.value && panelMode.value !== 'wide') return
  panelMenuOpen.value = false
  if (historyOpen.value) {
    closeHistory()
    return
  }
  historyOpen.value = true
  if (panelMode.value !== 'wide') memoryOpen.value = false
}
const toggleMemory = (): void => {
  if (memoryMutationBusy.value) return
  panelMenuOpen.value = false
  if (memoryOpen.value) {
    closeMemory()
    return
  }
  memoryOpen.value = true
  if (panelMode.value !== 'wide') historyOpen.value = false
}
const reconcilePanelMode = (): void => {
  const nextMode = window.matchMedia('(min-width: 1760px)').matches
    ? 'wide'
    : window.matchMedia('(min-width: 1024px)').matches
      ? 'docked'
      : 'modal'
  if (panelMode.value === 'wide' && nextMode !== 'wide' && historyOpen.value && memoryOpen.value) {
    if (memoryMutationBusy.value) {
      historyOpen.value = false
      panelMode.value = nextMode
      return
    }
    const activeElement = document.activeElement
    const focusedPanel = memoryPanel.value?.contains(activeElement)
      ? 'memory'
      : historyPanel.value?.contains(activeElement)
        ? 'history'
        : null
    if (focusedPanel === 'memory') historyOpen.value = false
    else memoryOpen.value = false
  }
  panelMode.value = nextMode
}
const closePanels = (): void => {
  if (memoryOpen.value && memoryMutationBusy.value) return
  const closingKind = panelMode.value === 'modal'
    ? historyOpen.value ? 'history' : memoryOpen.value ? 'memory' : null
    : null
  if (closingKind) preparePanelTriggerRestore(closingKind)
  historyOpen.value = false
  memoryOpen.value = false
}
const openClearUnfiledHistory = (): void => {
  if (sessionMutationBusy.value) return
  clearUnfiledError.value = ''
  clearUnfiledCommitted.value = false
  clearUnfiledHistoryOpen.value = true
}
const closeClearUnfiledHistory = (): void => {
  if (clearingUnfiledHistory.value || sessionMutationBusy.value) return
  clearUnfiledHistoryOpen.value = false
  clearUnfiledError.value = ''
  clearUnfiledCommitted.value = false
}
const clearUnfiledHistory = async (): Promise<void> => {
  if (clearingUnfiledHistory.value || sessionMutationBusy.value) return
  const originalSessionId = thread.value?.session.id ?? null
  const clearingCurrentSession = thread.value?.session.folderId === null
  clearingUnfiledHistory.value = true
  clearUnfiledError.value = ''
  clearUnfiledCommitted.value = false
  try {
    await agents.clearUnfiledHistory()
    if (clearingCurrentSession && originalSessionId && !thread.value) {
      clearUnfiledCommitted.value = true
      clearUnfiledError.value = error.value
        ? `${error.value} Saved folders and their filed conversations remain unchanged.`
        : 'Unfiled conversations were cleared, but a replacement conversation could not be opened. Saved folders and their filed conversations remain unchanged.'
      return
    }
    clearUnfiledHistoryOpen.value = false
  } catch (value) {
    const detail = value instanceof Error ? value.message : 'Try again.'
    clearUnfiledError.value = `Unfiled conversations could not be cleared. Saved folders and their filed conversations remain unchanged. ${detail}`
  } finally {
    clearingUnfiledHistory.value = false
  }
}
const recoverClearUnfiledHistory = async (): Promise<void> => {
  if (clearingUnfiledHistory.value || sessionMutationBusy.value) return
  clearingUnfiledHistory.value = true
  try {
    await agents.reloadSessions()
    if (!thread.value && profiles.value.length > 0) await agents.newSession('saved')
    if (!thread.value) throw new Error('No replacement conversation is available yet. Retry.')
    clearUnfiledHistoryOpen.value = false
    clearUnfiledError.value = ''
    clearUnfiledCommitted.value = false
  } catch (value) {
    const detail = value instanceof Error ? value.message : 'A replacement conversation could not be opened.'
    clearUnfiledError.value = `Unfiled conversations were cleared, but a replacement conversation still could not be opened. Saved folders and their filed conversations remain unchanged. ${detail}`
  } finally {
    clearingUnfiledHistory.value = false
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
  if (!approval.isConnected || !transcript.value?.contains(approval)) return
  approval.focus({ preventScroll: true })
  approvalJumpVisible.value = false
}
const transcriptIsNearBottom = (element: HTMLElement | null): boolean =>
  Boolean(element && element.scrollHeight - element.scrollTop - element.clientHeight < 160)
const handleTranscriptScroll = (): void => {
  const following = transcriptIsNearBottom(transcript.value)
  transcriptFollowing.value = following
  if (!following) transcriptFrameShouldFollow = false
  updateApprovalJump()
}
const reconcileTranscriptGrowth = async (shouldFollow: boolean): Promise<void> => {
  await nextTick()
  if (!hasConversation.value && transcript.value) {
    transcript.value.scrollTo({ top: 0, behavior: 'auto' })
    transcriptFollowing.value = true
  } else if (shouldFollow && transcript.value) {
    transcript.value.scrollTo({ top: transcript.value.scrollHeight, behavior: 'auto' })
    transcriptFollowing.value = true
  } else {
    transcriptFollowing.value = transcriptIsNearBottom(transcript.value)
  }
  updateApprovalJump()
}
const handleGoalExpanded = async (expanded: boolean): Promise<void> => {
  const container = transcript.value
  const shouldFollow = shouldFollowGoalExpansion(expanded, transcriptFollowing.value, transcriptIsNearBottom(container))
  goalExpanded.value = expanded
  await nextTick()
  if (container !== transcript.value || !container?.isConnected) return
  if (shouldFollow) {
    container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
    transcriptFollowing.value = true
  } else {
    transcriptFollowing.value = transcriptIsNearBottom(container)
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
const observeTranscript = (container: HTMLElement | null): void => {
  transcriptObserver?.disconnect()
  if (container) transcriptObserver?.observe(container, { childList: true, subtree: true, characterData: true })
}

watch(transcript, observeTranscript, { flush: 'post' })
watch(currentPage, page => agents.setCurrentPage(page), { immediate: true })
watch(skillManagerOpen, (open, wasOpen) => {
  if (!open && wasOpen) void nextTick(() => composer.value?.focusSkillsTrigger())
})
watch([historyOpen, memoryOpen, panelMode], async ([history, memory, mode]) => {
  const kind = history ? 'history' : memory ? 'memory' : null
  if (!kind || mode !== 'modal') {
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
  if (panelMode.value !== 'modal' || currentKind !== kind) return
  const root = kind === 'history' ? historyPanel.value : memoryPanel.value
  if (!root) return
  panelFocusKind = kind
  panelFocusScope = createModalFocusScope({
    root,
    restoreTarget: () => triggerForPanel(kind),
    additionalRoots: () => [...(panelScrim.value ? [panelScrim.value] : []), ...activeOwnedOverlayRoots('.agent-owned-overlay')],
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
  if (sessionId !== previousSessionId) { goalExpanded.value = false; sessionNotice.value = '' }
  if (!sessionId || !previousSessionId || sessionId === previousSessionId) return
  const restoreWorkspaceFocus = !clearUnfiledHistoryOpen.value
  if (historyOpen.value) {
    panelFocusScope?.deactivate({ restoreFocus: false })
    panelFocusScope = null
    panelFocusKind = null
    if (panelMode.value !== 'wide') historyOpen.value = false
  }
  transcriptFollowing.value = true
  void nextTick(async () => {
    const container = transcript.value
    if (hasConversation.value) {
      if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
      if (restoreWorkspaceFocus) container?.focus({ preventScroll: true })
    } else {
      if (container) container.scrollTop = 0
      if (restoreWorkspaceFocus) await composer.value?.focusInput()
    }
    updateApprovalJump()
  })
})
watch(() => thread.value?.goal?.id, (goalId, previousGoalId) => {
  if (goalId !== previousGoalId) goalExpanded.value = false
})
watch([thread, pendingApprovalId, connection], () => {
  void nextTick(() => { if (!hasConversation.value && transcript.value) transcript.value.scrollTop = 0; updateApprovalJump() })
}, { flush: 'post' })
onMounted(() => {
  panelModeMedia = [
    window.matchMedia('(min-width: 1760px)'),
    window.matchMedia('(min-width: 1024px) and (max-width: 1759.98px)')
  ]
  panelModeMedia.forEach(media => media.addEventListener('change', reconcilePanelMode))
  reconcilePanelMode()
  transcriptObserver = new MutationObserver(scheduleTranscriptReconcile)
  observeTranscript(transcript.value)
  window.addEventListener('resize', scheduleTranscriptReconcile)
  window.visualViewport?.addEventListener('resize', scheduleTranscriptReconcile)
  void ensureInitialized()
})
onBeforeUnmount(() => {
  transcriptObserver?.disconnect()
  if (transcriptFrame !== null) window.cancelAnimationFrame(transcriptFrame)
  panelFocusScope?.deactivate({ restoreFocus: false })
  panelModeMedia.forEach(media => media.removeEventListener('change', reconcilePanelMode))
  window.removeEventListener('resize', scheduleTranscriptReconcile)
  window.visualViewport?.removeEventListener('resize', scheduleTranscriptReconcile)
  agents.closeWorkspace()
})
defineExpose({ sendPrompt, preparePrompt, focusComposer, focusConversation, scrollToLatest })
</script>

<style scoped>
.inline-agent {
  --agent-conversation-width: 49rem;
  --inline-agent-workspace-base: color-mix(in srgb, var(--wiki-surface-raised) 76%, rgb(var(--v-theme-background)));
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  max-width: var(--wiki-shell-max);
  margin: 0 auto;
  grid-template-columns: minmax(0, 1fr);
  justify-content: center;
  gap: 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-body);
  background: transparent;
  isolation: isolate;
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
  height: 100%;
  max-height: none;
  min-height: 0;
}

.inline-agent__card {
  container: agent-workspace / inline-size;
  position: relative;
  display: flex;
  min-width: 0;
  grid-column: 1;
  flex-direction: column;
  overflow: hidden;
  border: 0;
  border-radius: 0 !important;
  background: rgb(var(--v-theme-background));
  box-shadow: none;
  text-align: start;
}

.inline-agent__toolbar {
  display: flex;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-6));
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-content: center;
  align-items: center;
  gap: 0;
  padding-block-start: 0;
  padding-inline: var(--wiki-space-4);
  border-bottom: 1px solid var(--wiki-surface-border);
  background: rgb(var(--v-theme-background)) !important;
  box-shadow: none;
}
.inline-agent__toolbar :deep(.v-toolbar__content) {
  flex-wrap: inherit;
  align-content: inherit;
  align-items: inherit;
  min-height: inherit;
}

.inline-agent__toolbar-main {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
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
  margin: 0;
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

.inline-agent__panel-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--wiki-space-1);
}

.inline-agent__mobile-navigation {
  display: flex;
  margin-inline-end: var(--wiki-space-3);
  padding-inline-end: var(--wiki-space-3);
  border-inline-end: 1px solid var(--wiki-surface-border);
}

.inline-agent__mobile-panel-menu {
  display: none !important;
}

.inline-agent__panel-menu-item {
  min-block-size: 44px;
  justify-content: flex-start;
  text-transform: none;
}

.inline-agent__session-action {
  min-width: var(--wiki-control-height);
  min-height: var(--wiki-control-height);
  padding-inline: var(--wiki-space-3);
  text-transform: none;
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

.inline-agent__retention {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: .75rem;
  padding: .8rem clamp(1rem, 3vw, 2rem);
  border-bottom: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
}
.inline-agent__retention-copy { flex: 1; min-width: 0; }
.inline-agent__retention strong { font-size: .8rem; font-weight: 650; }
.inline-agent__retention p { margin: .2rem 0 0; font-size: .75rem; line-height: 1.5; color: color-mix(in srgb, currentColor 70%, transparent); }
.inline-agent__session-notice { margin: 0; padding: .65rem 1.5rem; font-size: .8rem; color: var(--wiki-accent-ink); }
@media (max-width: 639.98px) {
  .inline-agent__retention { flex-wrap: wrap; gap: .5rem; }
  .inline-agent__retention-copy { flex-basis: calc(100% - 2rem); }
  .inline-agent__retention > .v-btn { margin-inline-start: 1.9rem; }
}

.inline-agent__body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
  padding: var(--wiki-space-4) clamp(var(--wiki-space-4), 3vw, var(--wiki-space-8)) 0;
  background: rgb(var(--v-theme-background));
}
.inline-agent__transcript-wrap {
  position: relative;
  display: flex;
  container-name: inline-agent-transcript;
  container-type: size;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}


.inline-agent__alert {
  flex: 0 0 auto;
  margin-bottom: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
}


.inline-agent__transcript {
  min-height: 0;
  flex: 1 1 auto;
  padding: var(--wiki-space-3) var(--wiki-space-1) var(--wiki-space-6);
  overflow-y: auto;
  outline: none;
  overscroll-behavior: contain;
  scrollbar-gutter: stable both-edges;
  scroll-behavior: smooth;
  scroll-padding-block: var(--wiki-space-4);
}
.inline-agent__goal-dock {
  position: sticky;
  z-index: 2;
  inset-block-end: 0;
  width: min(100%, var(--agent-conversation-width));
  margin: calc(var(--wiki-space-3) / 2) auto 0;
  padding-block: var(--wiki-space-1) calc(var(--wiki-space-3) / 2);
  background: linear-gradient(
    to bottom,
    transparent,
    color-mix(in srgb, var(--inline-agent-workspace-base) 94%, transparent) var(--wiki-space-2)
  );
}

.inline-agent__goal-dock :deep(.agent-goal) {
  box-shadow: var(--wiki-shadow-md);
}


.inline-agent__transcript:focus-visible {
  border-radius: var(--wiki-control-radius);
  box-shadow: inset var(--wiki-focus-ring);
}
.inline-agent__transcript :deep(.agent-thread) {
  width: 100%;
  max-width: var(--agent-conversation-width);
  margin-inline: auto;
}

.inline-agent__transcript:has(> .inline-agent__welcome) {
  display: flex;
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

.inline-agent__jump-dock {
  display: flex;
  width: min(100%, var(--agent-conversation-width));
  flex: 0 0 auto;
  justify-content: flex-end;
  margin-inline: auto;
  padding: var(--wiki-space-1) var(--wiki-space-1) var(--wiki-space-2);
}

.inline-agent__approval-jump,
.inline-agent__follow-jump {
  box-shadow: var(--wiki-shadow-md);
}

.inline-agent__welcome {
  position: relative;
  width: min(100%, var(--agent-conversation-width));
  margin: auto;
  padding: clamp(1.5rem, 4vh, 4rem) 0;
  text-align: start;
}

.inline-agent__welcome-mark {
  display: grid;
  place-items: center;
  width: 3.5rem;
  height: 3.5rem;
  margin-bottom: 1.75rem;
  color: var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: 50%;
  background: var(--wiki-surface-sunken);
}

.inline-agent__welcome-index {
  margin: 0 0 1rem;
  color: var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
  font-size: .7rem;
  font-weight: 650;
  letter-spacing: .15em;
  text-transform: uppercase;
}

.inline-agent__welcome h2 {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-display);
  font-size: clamp(2.4rem, 4vw, 4.25rem);
  font-weight: 450;
  letter-spacing: -.045em;
  line-height: 1.04;
  text-wrap: balance;
}

.inline-agent__welcome h2 em {
  display: block;
  font-weight: inherit;
  color: var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
}

.inline-agent__welcome-copy {
  max-width: 34rem;
  margin: 1.4rem 0 2rem;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
  font-size: 1rem;
  line-height: 1.65;
}

.inline-agent__starters {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: .65rem;
}

.inline-agent__starter {
  height: auto !important;
  min-height: 6.5rem;
  padding: 1rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface)) !important;
  text-align: start;
  letter-spacing: 0;
  text-transform: none;
  white-space: normal;
  transition: border-color .18s, background .18s;
}
.inline-agent__starter:hover {
  border-color: var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
  background: var(--wiki-surface-sunken);
}
.inline-agent__starter :deep(.v-btn__content) {
  display: grid;
  grid-template-columns: 1fr auto;
  justify-items: start;
  gap: .75rem;
  width: 100%;
}
.inline-agent__starter :deep(.v-icon--start) { margin: 0; font-size: 1.25rem; }
.inline-agent__starter-copy { grid-column: 1 / -1; grid-row: 2; display: grid; gap: .25rem; }
.inline-agent__starter-copy strong { font-size: .83rem; font-weight: 600; }
.inline-agent__starter-copy small { font-size: .73rem; font-weight: 400; opacity: .7; }
.inline-agent__starter-arrow { grid-column: 2; grid-row: 1; opacity: .5; }

.inline-agent__composer {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  padding: var(--wiki-space-4) clamp(var(--wiki-space-4), 3vw, var(--wiki-space-8)) max(var(--wiki-space-4), env(safe-area-inset-bottom));
  border-top: 0;
  background: rgb(var(--v-theme-background));
  box-shadow: none;
}
.inline-agent__composer-inner {
  width: min(100%, var(--agent-conversation-width));
  margin-inline: auto;
}

.inline-agent__composer-lock {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-2);
  margin: 0 0 var(--wiki-space-3);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 36%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 10%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-on-surface));
  font-size: var(--wiki-label-size);
  font-weight: 500;
  line-height: 1.4;
}

.inline-agent__composer-meta {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-3);
  justify-content: space-between;
  margin-bottom: var(--wiki-space-3);
}

.inline-agent__page-context {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-1) var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, var(--wiki-surface-raised) 60%, transparent);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.4;
}

.inline-agent__page-context > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inline-agent__page-context .v-icon {
  color: var(--wiki-accent-warm);
}

.inline-agent__page-context strong {
  color: rgb(var(--v-theme-on-surface));
  font-weight: var(--wiki-label-weight);
}

.inline-agent__notice {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: var(--wiki-space-1);
  padding: var(--wiki-space-1) var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, var(--wiki-surface-raised) 60%, transparent);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 60%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.4;
  text-align: end;
}

.inline-agent__notice span {
  white-space: nowrap;
}

.inline-agent__side {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--wiki-panel-radius);
  outline: none;
  background: transparent;
}

.inline-agent__side:focus-visible {
  border-radius: var(--wiki-panel-radius);
  box-shadow: var(--wiki-focus-ring);
}


.inline-agent__side--history {
  width: min(19rem, 100%);
  justify-self: end;
}

.inline-agent__side--memory {
  width: min(21rem, 100%);
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

/* Panel geometry follows the mode computed at the fixed 1024px and 1760px fit thresholds. */
.inline-agent[data-panel-mode="docked"],
.inline-agent[data-panel-mode="wide"] {
  grid-template-columns: minmax(0, 1fr);
}

.inline-agent[data-panel-mode="docked"].inline-agent--history {
  grid-template-columns: 20rem minmax(0, 1fr);
}

.inline-agent[data-panel-mode="docked"].inline-agent--memory {
  grid-template-columns: minmax(0, 1fr) 22rem;
}

.inline-agent[data-panel-mode="wide"].inline-agent--history {
  grid-template-columns: 20rem minmax(0, 1fr);
}

.inline-agent[data-panel-mode="wide"].inline-agent--memory {
  grid-template-columns: minmax(0, 1fr) 22rem;
}

.inline-agent[data-panel-mode="wide"].inline-agent--history.inline-agent--memory {
  grid-template-columns: 20rem minmax(0, 1fr) 22rem;
}

.inline-agent[data-panel-mode="docked"] .inline-agent__card,
.inline-agent[data-panel-mode="wide"] .inline-agent__card {
  grid-column: 1;
  grid-row: 1;
}

.inline-agent[data-panel-mode="docked"].inline-agent--history .inline-agent__card,
.inline-agent[data-panel-mode="wide"].inline-agent--history .inline-agent__card {
  grid-column: 2;
}

.inline-agent[data-panel-mode="wide"].inline-agent--history .inline-agent__side--memory {
  grid-column: 3;
}

.inline-agent[data-panel-mode="docked"] .inline-agent__side,
.inline-agent[data-panel-mode="wide"] .inline-agent__side {
  position: relative;
  z-index: auto;
  width: 100%;
  max-width: none;
  grid-row: 1;
  justify-self: stretch;
  border-radius: 0;
  filter: none;
}

.inline-agent[data-panel-mode="docked"] .inline-agent__side--history,
.inline-agent[data-panel-mode="wide"] .inline-agent__side--history {
  grid-column: 1;
  border-inline-end: 1px solid var(--wiki-surface-border);
}

.inline-agent[data-panel-mode="docked"] .inline-agent__side--memory,
.inline-agent[data-panel-mode="wide"] .inline-agent__side--memory {
  grid-column: 2;
  border-inline-start: 1px solid var(--wiki-surface-border);
}

.inline-agent[data-panel-mode="docked"] .inline-agent__side :deep(.agent-history),
.inline-agent[data-panel-mode="docked"] .inline-agent__side :deep(.agent-memory),
.inline-agent[data-panel-mode="wide"] .inline-agent__side :deep(.agent-history),
.inline-agent[data-panel-mode="wide"] .inline-agent__side :deep(.agent-memory) {
  border: 0;
  border-radius: 0 !important;
  box-shadow: none;
}

.inline-agent[data-panel-mode="modal"] {
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
}

.inline-agent[data-panel-mode="modal"] .inline-agent__card {
  grid-column: 1;
  grid-row: 1;
}

.inline-agent[data-panel-mode="modal"] .inline-agent__side {
  position: absolute;
  z-index: 5;
  inset-block: 0;
  width: 22rem;
  max-width: calc(100% - var(--wiki-space-10));
  grid-column: 1 / -1;
  grid-row: 1;
  box-sizing: border-box;
  filter: drop-shadow(var(--wiki-shadow-md));
}

.inline-agent[data-panel-mode="modal"] .inline-agent__side--history {
  inset-inline-start: 0;
  inset-inline-end: auto;
  justify-self: start;
}

.inline-agent[data-panel-mode="modal"] .inline-agent__side--memory {
  inset-inline-start: auto;
  inset-inline-end: 0;
  justify-self: end;
}

.inline-agent[data-panel-mode="modal"] .inline-agent__scrim {
  position: absolute;
  z-index: 4;
  display: block;
  inset: 0;
  padding: 0;
  border: 0;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 40%, transparent);
}

@media (max-width: 900px) {
  .inline-agent__starters { grid-template-columns: 1fr; }
  .inline-agent__starter { min-height: 3.5rem; padding: .75rem; }
  .inline-agent__starter :deep(.v-btn__content) { display: flex; gap: .75rem; }
  .inline-agent__starter-copy { flex: 1; }

  .inline-agent__welcome {
    max-width: 40rem;
  }
}

/* A docked panel can make a desktop conversation as narrow as a tablet. */
@container agent-workspace (max-width: 780px) {
  .inline-agent__desktop-panel-btn { display: none; }
  .inline-agent__mobile-panel-menu { display: inline-flex !important; }
  .inline-agent__session-action { min-width: var(--wiki-control-height); padding-inline: var(--wiki-space-2); }
  .inline-agent__session-action :deep(.v-btn__prepend) { margin: 0; }
  .inline-agent__notice { display: none; }
  .inline-agent__starters { grid-template-columns: 1fr; }
  .inline-agent__starter { min-height: 3.5rem; padding: .75rem; }
  .inline-agent__starter :deep(.v-btn__content) { display: flex; gap: .75rem; }
  .inline-agent__starter-copy { flex: 1; }
}

@media (min-width: 640px) and (max-width: 1023.98px) {
  .inline-agent__toolbar {
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-4));
    padding-inline: var(--wiki-space-3);
  }

  .inline-agent__eyebrow,
  .inline-agent__desktop-panel-btn {
    display: none;
  }

  .inline-agent__mobile-panel-menu {
    display: inline-flex !important;
    min-width: auto !important;
    padding-inline: var(--wiki-space-2) !important;
  }

  .inline-agent__panel-actions {
    gap: var(--wiki-space-1);
  }
}
@media (max-width: 1023.98px) {
  .inline-agent__session-action {
    min-width: var(--wiki-control-height);
    padding-inline: var(--wiki-space-2);
  }

  .inline-agent__session-action :deep(.v-btn__prepend) {
    margin: 0;
  }
}
@media (max-width: 639.98px) {
  .inline-agent {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }

  .inline-agent__card {
    max-height: none;
    grid-column: 1;
    border: 0;
    border-radius: 0 !important;
    box-shadow: none;
  }

  .inline-agent__side {
    position: absolute;
    width: min(22rem, calc(100% - var(--wiki-space-8)));
  }
  .inline-agent__scrim {
    position: absolute;
  }

  .inline-agent__mobile-navigation {
    display: flex;
    align-items: center;
    gap: 0;
    margin-inline-end: .4rem;
    padding: 0;
    border: 0;
  }

  .inline-agent__mobile-return,
  .inline-agent__mobile-close {
    min-width: var(--wiki-control-height) !important;
    min-height: var(--wiki-control-height) !important;
  }

  .inline-agent__mobile-return {
    padding-inline: var(--wiki-space-2) !important;
  }

  .inline-agent__toolbar {
    min-height: calc((var(--wiki-control-height) * 2) + var(--wiki-space-5) + env(safe-area-inset-top));
    padding-block-start: max(0px, env(safe-area-inset-top));
    padding-inline: var(--wiki-space-2);
  }
  .inline-agent__toolbar :deep(.v-toolbar__content) {
    flex-wrap: wrap;
    align-content: center;
    min-height: inherit;
  }
  .inline-agent__toolbar-main {
    flex: 1 0 100%;
    min-height: var(--wiki-control-height);
  }
  .inline-agent__progress {
    inset-block-start: calc((var(--wiki-control-height) * 2) + var(--wiki-space-5) + env(safe-area-inset-top) - var(--wiki-space-1));
  }

  .inline-agent__eyebrow {
    display: none;
  }
  .inline-agent__identity {
    overflow: hidden;
    gap: .375rem;
  }
  .inline-agent__avatar { width: 32px !important; height: 32px !important; }

  .inline-agent__heading h2 {
    overflow: hidden;
    margin: 0;
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
    flex: 1 0 100%;
    min-height: var(--wiki-control-height);
    justify-content: flex-end;
    gap: var(--wiki-space-1);
    padding-block-start: var(--wiki-space-1);
    border-top: 1px solid var(--wiki-surface-border);
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

  .inline-agent__notice {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  .inline-agent__welcome {
    padding: var(--wiki-space-5) var(--wiki-space-2);
  }


  .inline-agent__welcome h2 { font-size: clamp(2rem, 8vw, 3rem); }
  .inline-agent__welcome-mark { display: none; }

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

  .inline-agent__jump-dock {
    padding-inline: 0;
  }
}


@media (max-height: 500px) {
  .inline-agent__card {
    min-height: 0;
    max-height: none;
  }

  .inline-agent__toolbar {
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-2));
  }

  .inline-agent__eyebrow {
    display: none;
  }

  .inline-agent__progress {
    inset-block-start: calc(var(--wiki-control-height) + var(--wiki-space-2) - var(--wiki-space-1));
  }

  .inline-agent__body {
    padding-block-start: var(--wiki-space-1);
  }

  .inline-agent__composer {
    padding-block-start: var(--wiki-space-1);
    padding-block-end: max(var(--wiki-space-1), env(safe-area-inset-bottom));
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

@media (max-width: 639.98px) and (max-height: 500px) {
  .inline-agent__toolbar {
    min-height: calc((var(--wiki-control-height) * 2) + var(--wiki-space-5) + env(safe-area-inset-top));
  }

  .inline-agent__progress {
    inset-block-start: calc((var(--wiki-control-height) * 2) + var(--wiki-space-5) + env(safe-area-inset-top) - var(--wiki-space-1));
  }
}

@media (forced-colors: active) {
  .inline-agent__card,
  .inline-agent__side {
    border: 1px solid CanvasText;
  }

  .inline-agent__scrim {
    background: Canvas;
    opacity: .72;
  }

  .inline-agent__loading-mark {
    background: Highlight;
  }
}

@media (prefers-reduced-motion: reduce) {
  .inline-agent__transcript {
    scroll-behavior: auto;
  }

  .inline-agent__loading-mark {
    animation: none;
  }
}
</style>
