<template>
  <section
    ref="inlineAgentRoot"
    class="inline-agent"
    :class="{ 'inline-agent--history': historyOpen, 'inline-agent--memory': memoryOpen, 'inline-agent--contextual': contextualGlass }"
    :data-panel-mode="panelMode"
    :aria-labelledby="workspaceTitleId"
    :aria-busy="loading || Boolean(creatingRetention) || connectionRetrying || sessionMutationBusy"
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
        :network-blocked="connectionBlocked"
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
              <v-icon icon="mdi-creation-outline" size="20" aria-hidden="true" />
            </v-avatar>
            <div class="inline-agent__heading">
              <h2 :id="workspaceTitleId" aria-label="Wiki Agent">
                <span class="inline-agent__workspace-title--wide">Wiki Agent</span>
              </h2>
              <div class="inline-agent__session-line">
                <span class="inline-agent__session-title" :title="sessionTitle">{{ sessionTitle }}</span>
                <v-icon
                  v-if="isCurrentChatPinned"
                  class="inline-agent__pin-indicator"
                  icon="mdi-pin"
                  size="14"
                  role="img"
                  aria-label="Pinned conversation"
                />
                <v-menu
                  v-model="temporaryMenuOpen"
                  content-class="agent-owned-overlay"
                  location="bottom start"
                  attach=".inline-agent"
                >
                  <template #activator="{ props: temporaryMenuProps }">
                    <button
                      v-bind="temporaryMenuProps"
                      class="inline-agent__temporary-toggle"
                      :class="{ 'inline-agent__temporary-toggle--active': isTemporary }"
                      type="button"
                      :disabled="loading || sending || sessionMutationBusy || Boolean(creatingRetention) || connectionBlocked || !workspaceReady"
                      :aria-expanded="temporaryMenuOpen"
                      aria-haspopup="dialog"
                    >
                      <v-icon icon="mdi-timer-sand-complete" size="14" aria-hidden="true" />
                      <span>Temporary {{ isTemporary ? 'on' : 'off' }}</span>
                      <v-icon icon="mdi-chevron-down" size="14" aria-hidden="true" />
                    </button>
                  </template>
                  <div class="inline-agent__temporary-popover" role="dialog" aria-label="Temporary conversation mode">
                    <div class="inline-agent__temporary-popover-row">
                      <span id="inline-agent-temporary-label" class="inline-agent__temporary-popover-title">Temporary conversation</span>
                      <button
                        type="button"
                        class="inline-agent__temporary-switch"
                        role="switch"
                        :aria-checked="isTemporary"
                        aria-labelledby="inline-agent-temporary-label"
                        :disabled="loading || sending || sessionMutationBusy || Boolean(creatingRetention) || connectionBlocked || !workspaceReady"
                        @click="isTemporary ? keepConversation() : startTemporaryChat()"
                      />
                    </div>
                    <p class="inline-agent__temporary-popover-copy">Hidden from history<span v-if="temporaryExpiry"> · Expires {{ temporaryExpiry }}</span>. Personal memory still applies.</p>
                    <p v-if="!isTemporary" class="inline-agent__temporary-popover-copy">Turning it on opens a new conversation. This conversation stays right where it is.</p>
                    <p v-else class="inline-agent__temporary-popover-copy">Turning it off keeps this conversation in history with its messages.</p>
                  </div>
                </v-menu>
              </div>
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
          <v-menu v-model="panelMenuOpen" ref="panelMenu" content-class="agent-owned-overlay" location="bottom end" attach=".inline-agent">
            <template #activator="{ props: menuProps }">
              <v-btn
                v-bind="menuProps"
                ref="panelMenuTrigger"
                class="inline-agent__more-menu"
                icon="mdi-dots-horizontal"
                variant="text"
                :aria-label="panelMenuOpen ? 'Close agent actions menu' : 'More agent actions'"
                :aria-expanded="panelMenuOpen"
              />
            </template>
            <v-list density="compact">
              <v-list-item
                class="inline-agent__panel-menu-item inline-agent__panel-menu-item--compact"
                link
                prepend-icon="mdi-magnify"
                title="Return to Wiki Search"
                @click="emit('return-search')"
              />
              <v-list-item
                class="inline-agent__panel-menu-item inline-agent__panel-menu-item--compact"
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
                :aria-expanded="memoryOpen"
                :disabled="memoryMutationBusy"
                @click="toggleMemory"
              />
              <v-list-item
                class="inline-agent__panel-menu-item"
                link
                :prepend-icon="isCurrentChatPinned ? 'mdi-pin' : 'mdi-pin-outline'"
                :title="isCurrentChatPinned ? 'Unpin chat' : 'Pin chat'"
                :disabled="!canPinCurrentChat"
                @click="setCurrentChatPinned(!isCurrentChatPinned)"
              />
            </v-list>
          </v-menu>
          <v-btn
            class="inline-agent__session-action inline-agent__new-session"
            prepend-icon="mdi-plus"
            variant="tonal"
            color="primary"
            size="small"
            rounded="pill"
            :loading="creatingRetention === 'saved'"
            aria-label="New chat"
            :disabled="loading || sending || sessionMutationBusy || Boolean(creatingRetention) || connectionBlocked || !workspaceReady"
            @click="newSession"
          >
            <span class="inline-agent__new-label--wide">New chat</span>
          </v-btn>
          <v-btn class="inline-agent__close-action wiki-close-control" icon="mdi-close" variant="text" aria-label="Close chat panel" :disabled="memoryMutationBusy" :title="memoryMutationBusy ? 'Wait for the memory change to finish' : undefined" @click="emit('close')" />
        </div>
      </v-toolbar>


      <v-progress-linear
        v-if="loading"
        class="inline-agent__progress"
        indeterminate
        color="primary"
        aria-label="Opening conversation"
      />

      <v-alert
        v-if="connectionBlocked"
        class="inline-agent__alert inline-agent__connection-alert"
        type="warning"
        variant="tonal"
        role="status"
        icon="mdi-cloud-off-outline"
      >
        <div class="inline-agent__initialization-error-content">
          <span>{{ connectionRequiredMessage }}</span>
          <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :loading="connectionRetrying" :disabled="connectionRetrying" @click="retryAgentConnection">Retry connection</v-btn>
        </div>
      </v-alert>

      <AgentMcpApproval v-if="approvalId" :csrf-token="csrfToken" :proposal-id="approvalId" :network-blocked="connectionBlocked" />
      <template v-else>
        <div v-if="isTemporary" class="inline-agent__retention" aria-label="Temporary conversation" role="status">
          <v-icon icon="mdi-timer-sand-complete" size="22" aria-hidden="true" />
          <div class="inline-agent__retention-copy">
            <strong>Temporary conversation</strong>
            <p>Hidden from history<span v-if="temporaryExpiry"> · Expires {{ temporaryExpiry }}</span>. Personal memory still applies.</p>
          </div>
          <v-btn variant="text" size="small" prepend-icon="mdi-bookmark-outline" :loading="keepingConversation" :disabled="sessionMutationBusy || loading || sending || connectionBlocked || !workspaceReady" :title="connectionBlocked ? connectionRequiredMessage : undefined" @click="keepConversation">Keep conversation</v-btn>
        </div>
        <p v-else-if="sessionNotice" class="inline-agent__session-notice" role="status">{{ sessionNotice }}</p>
        <div class="inline-agent__body">
          <v-alert
            v-if="!loading && !connectionBlocked && !providerAvailable"
            class="inline-agent__alert"
            variant="tonal"
            icon="mdi-connection"
          >
            {{ providerUnavailableMessage }}
          </v-alert>
          <v-alert
            v-if="!loading && initializationError"
            class="inline-agent__alert inline-agent__initialization-error"
            type="error"
            variant="tonal"
            role="alert"
          >
            <div class="inline-agent__initialization-error-content">
              <span>{{ initializationError }}</span>
              <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :disabled="loading || connectionRetrying" @click="retryInitialization">Retry opening conversation</v-btn>
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
              @pointerdown="handleTranscriptEngagement"
              @focusin="handleTranscriptEngagement"
            >
              <div v-if="loading && !thread" class="inline-agent__loading" role="status">
                <span class="inline-agent__loading-mark" aria-hidden="true" />
                <span>
                  <strong>Opening conversation</strong>
                  <small>Recovering your latest working context</small>
                </span>
              </div>

              <section v-if="thread && !hasConversation" class="inline-agent__welcome" aria-labelledby="inline-agent-welcome-title">
                <h2 id="inline-agent-welcome-title">
                  <span class="inline-agent__welcome-line">{{ welcomeGreeting.first }}</span>
                  <em class="inline-agent__welcome-line">{{ welcomeGreeting.second }}</em>
                </h2>
                <div
                  ref="startersRow"
                  class="inline-agent__starters"
                  role="group"
                  aria-label="Conversation starters"
                  @pointerdown="holdStartersSpin"
                  @pointerup="holdStartersSpin"
                  @pointercancel="holdStartersSpin"
                  @wheel="holdStartersSpin"
                  @scroll.passive="handleStartersScroll"
                >
                  <v-btn
                    v-for="starter in starters"
                    :key="starter.prompt"
                    class="inline-agent__starter"
                    color="primary"
                    variant="text"
                    :disabled="!canSubmit || promptSubmissionPending"
                    :title="!canSubmit ? submitUnavailableReason : undefined"
                    @click="sendPrompt(starter.prompt)"
                  >
                    <span class="inline-agent__starter-heading">
                      <v-icon :icon="starter.icon" size="20" aria-hidden="true" />
                      <strong>{{ starter.label }}</strong>
                    </span>
                    <span class="inline-agent__starter-copy"><small>{{ starter.description }}</small></span>
                  </v-btn>
                </div>
              </section>

              <AgentThread
                v-else-if="thread"
                :thread="thread"
                :image-editing-enabled="providerEnabled && mediaProfile?.media?.imageGeneration === true && mediaProfile?.media?.attachments === true && thread?.session.executionMode === 'agent'"
                :connection="connection"
                :deciding-approval-id="decidingApprovalId"
                :can-submit="canSubmit"
                :network-blocked="connectionBlocked"
                :google-search-suggestions="liveGoogleSearchSuggestions"
                @suggest="preparePrompt"
                @edit-image="composer?.editImage($event)"
                @reattach="media => void composer?.reattachMedia(media)"
                @ask-source="source => preparePrompt(`Help me understand “${source.title}”.`, source)"
                @decision="handleDecision"
              />
              <div class="inline-agent__conversation-dock">
                <div
                  v-if="thread?.goal"
                  class="inline-agent__goal-dock"
                  :class="{ 'inline-agent__goal-dock--expanded': goalExpanded }"
                >
                  <AgentGoalStatus
                    :goal="thread.goal"
                    :busy="goalBusy"
                    :network-blocked="connectionBlocked"
                    :run-active="Boolean(activeRun)"
                    :expanded="goalExpanded"
                    @pause="pauseGoal"
                    @resume="resumeGoal"
                    @cancel="cancelGoal"
                    @renew-budget="renewGoalBudget"
                    @update:expanded="handleGoalExpanded"
                  />
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
                    variant="text"
                    aria-label="Jump to latest response"
                    :style="{ opacity: 0.8 * transcriptReadingProgress }"
                    @click="scrollToLatest"
                  >
                    <span class="inline-agent__follow-jump-frame">
                      <span class="inline-agent__follow-jump-halo" aria-hidden="true" />
                      <span class="inline-agent__follow-jump-face">
                        <v-icon icon="mdi-arrow-down" size="16" aria-hidden="true" />
                        <span>Latest</span>
                      </span>
                    </span>
                  </v-btn>
                </nav>

                <footer
                  class="inline-agent__composer"
                  :class="{ 'inline-agent__composer--scrolled': !transcriptFollowing, 'inline-agent__composer--focused': composerFocused }"
                  :style="{ '--agent-composer-opacity': 1 - 0.8 * transcriptReadingProgress }"
                  @focusin="handleComposerFocusIn"
                  @focusout="handleComposerFocusOut"
                  @keydown="handleComposerFocusIn"
                >
                  <div class="inline-agent__composer-inner">
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
                    <p v-if="pinStorageAvailable === false" class="inline-agent__pin-storage-warning" role="status" aria-live="polite">
                      <v-icon icon="mdi-information-outline" size="16" aria-hidden="true" />
                      <span>Pinning is available for this tab, but browser storage is unavailable; it will not survive a reload.</span>
                    </p>
                    <p v-if="agents.contextTransferNotice" class="inline-agent__pin-storage-warning" role="status" aria-live="polite">
                      <v-icon icon="mdi-information-outline" size="16" aria-hidden="true" />
                      <span>{{ agents.contextTransferNotice }}</span>
                    </p>
                    <AgentComposer
                      :key="`${ownerId}:${thread?.session.id ?? 'opening'}:${mediaProfile?.id ?? 'none'}:${mediaProfile?.policyVersion ?? 0}`"
                      ref="composer"
                      :csrf-token="csrfToken"
                      :media-session="thread?.session"
                      :media-capabilities="providerEnabled ? mediaProfile?.media : undefined"
                      :generation-tools-enabled="thread?.session.executionMode === 'agent'"
                      :google-search-available="googleSearchAvailable"
                      :google-search-enabled="googleSearchEnabled"
                      :google-search-busy="sessionMutationBusy"
                      @media-settled="refreshAfterMedia"
                      :session-id="thread?.session.id ?? offlineSessionId"
                      :initial-draft="thread ? agents.drafts[thread.session.id]?.text ?? offlineComposerDraft : offlineComposerDraft"
                      :initial-mode="thread ? agents.drafts[thread.session.id]?.mode : 'message'"
                      :initial-skill-version-ids="thread ? agents.drafts[thread.session.id]?.skillVersionIds : []"
                      :has-messages="hasConversation"
                      @draft-change="handleDraftChange"
                      @composition-change="agents.updateDraft"
                      :sending="sending"
                      :network-blocked="connectionBlocked"
                      :can-stop="Boolean(activeRun?.canCancel)"
                      :disabled="composerDisabled || mediaRefreshing"
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
                      @stop="stopRun"
                      @manage-skills="openSkillManager"
                      @retry-skills="reloadSkillCatalog"
                      @update-skill-preferences="updateSkillPreferences"
                      @update-google-search="updateGoogleSearch"
                    >
                      <template #context-controls>
                        <AgentContextPicker
                          v-if="thread"
                          :key="thread.session.id"
                          :draft="activeDraft"
                          :current-page="currentPage"
                          :disabled="loading || sending || sessionMutationBusy || Boolean(creatingRetention) || !workspaceReady"
                          :connection-blocked="connectionBlocked"
                          :connection-retrying="connectionRetrying"
                          @change="patchDraft"
                          @sources-added="focusComposer"
                          @retry-connection="retryAgentConnection"
                        />
                      </template>
                    </AgentComposer>
                  </div>
                </footer>
              </div>
            </div>

          </div>

        </div>
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
        :network-blocked="connectionBlocked"
        @update:model-value="updateMemoryOpen"
        @update:busy="memoryMutationBusy = $event"
      />
    </div>
  </section>

  <AgentPersonalSkills
    v-if="skillsEnabled"
    v-model="skillManagerOpen"
    :csrf-token="csrfToken"
    :owner-id="ownerId"
    :network-blocked="connectionBlocked"
    :connection-retrying="connectionRetrying"
    @changed="reloadSkillCatalog"
    @retry-connection="retryAgentConnection"
  />

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
        <v-alert v-if="connectionBlocked" class="mt-4" density="compact" type="warning" variant="tonal" role="status">
          <div class="inline-agent__initialization-error-content">
            <span>Connection required to change conversation history.</span>
            <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :loading="connectionRetrying" :disabled="connectionRetrying" @click="retryAgentConnection">Retry connection</v-btn>
          </div>
        </v-alert>
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
          :disabled="clearingUnfiledHistory || sessionMutationBusy || connectionBlocked"
          @click="recoverClearUnfiledHistory"
        >
          Retry opening conversation
        </v-btn>
        <v-btn
          v-else
          color="error"
          :loading="clearingUnfiledHistory"
          :disabled="clearingUnfiledHistory || sessionMutationBusy || connectionBlocked"
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
import type { AgentMediaSubmission } from '../../helpers/agent-media.ts'
import type { AgentMediaView, AgentCurrentPageHint } from '../../../shared/agents/contracts.ts'
import { pwaState, retryServerConnection } from '../../helpers/pwa.ts'
import { useAgentsStore } from '../../store/agents.ts'
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
import { activeOwnedOverlayRoots, createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'

const welcomeGreetings = [
  { first: 'Pipeline looks healthy.', second: 'Budget feels nervous.' },
  { first: 'Calendar looks spacious.', second: 'Meetings feel endless.' },
  { first: 'Forecast brings sunshine.', second: 'Spreadsheet brings rain.' },
  { first: 'Sales notes align.', second: 'Calendars disagree.' },
  { first: 'Clients seem charmed.', second: 'Contracts seem haunted.' },
  { first: 'Reports look cheerful.', second: 'Footnotes know better.' },
  { first: 'Targets wear ties.', second: 'Budgets wear frowns.' },
  { first: 'Inbox feels lighter.', second: 'That feels suspicious.' },
  { first: 'Strategy feels solid.', second: 'Tactics need coffee.' },
  { first: 'Good news pending.', second: 'Legal wants edits.' },
  { first: 'Sales keeps momentum.', second: 'Finance has concerns.' },
  { first: 'Revenue stays social.', second: 'Expenses stay bashful.' },
  { first: 'Paperwork feels brave.', second: 'Signatures feel shy.' },
  { first: 'Meeting notes bloom.', second: 'Action items migrate.' },
  { first: 'Fresh leads arrived.', second: 'Old tabs celebrated.' },
  { first: 'Roadmap looks brave.', second: 'Deadline looks braver.' },
  { first: 'Client call pending.', second: 'Small talk loading.' },
  { first: 'Briefing starts soon.', second: 'Coffee starts sooner.' },
  { first: 'Pipeline nearly sings.', second: 'Budget nearly agrees.' },
  { first: 'Revenue seems cheerful.', second: 'Expense reports giggle.' }
] as const

const props = defineProps<{
  csrfToken: string
  ownerId: number
  resumeSessionId?: string
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
const welcomeGreeting = welcomeGreetings[Math.floor(Math.random() * welcomeGreetings.length)] ?? welcomeGreetings[0]

const agents = useAgentsStore()
const { canPinCurrentChat, connection, decidingApprovalId, error, goalBusy, googleSearchSuggestions, loading, networkPaused, pinStorageAvailable, pinnedSessionId, profiles, sending, sessionMutationBusy, skills, skillsLoadError, skillsLoading, skillsPartial, thread, workspaceDisposed } = storeToRefs(agents)
const inlineAgentRoot = useTemplateRef<HTMLElement>('inlineAgentRoot')
const transcript = useTemplateRef<HTMLElement>('transcript')
const composer = useTemplateRef<{ focusInput: () => Promise<void>; focusSkillsTrigger: () => Promise<void>; setDraft: (value: string) => Promise<void>; editImage: (media: AgentMediaView) => Promise<void>; reattachMedia: (media: AgentMediaView) => Promise<boolean> }>('composer')
type ComponentRoot = { $el?: unknown }
const historyTrigger = useTemplateRef<ComponentRoot | HTMLElement>('historyTrigger')
const panelMenuTrigger = useTemplateRef<ComponentRoot | HTMLElement>('panelMenuTrigger')
const temporaryMenuOpen = ref(false)
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
const promptSubmissionPending = ref(false)
const keepingConversation = ref(false)
const sessionNotice = ref('')
const SESSION_NOTICE_VISIBLE_MS = 5000
let sessionNoticeTimer: ReturnType<typeof setTimeout> | null = null
const clearSessionNotice = (): void => {
  if (sessionNoticeTimer !== null) { clearTimeout(sessionNoticeTimer); sessionNoticeTimer = null }
  sessionNotice.value = ''
}
const setSessionNotice = (message: string): void => {
  if (sessionNoticeTimer !== null) { clearTimeout(sessionNoticeTimer); sessionNoticeTimer = null }
  sessionNotice.value = message
  if (message) {
    sessionNoticeTimer = setTimeout(() => {
      sessionNoticeTimer = null
      sessionNotice.value = ''
    }, SESSION_NOTICE_VISIBLE_MS)
  }
}
const historyOpen = ref(false)
const memoryOpen = ref(false)
const panelMenuOpen = ref(false)
const memoryMutationBusy = ref(false)
const initializationError = ref('')
const connectionRetrying = ref(false)
const waitingForConnection = ref(false)
const offlineComposerDraft = ref('')
const offlineSessionId = 'offline-agent-draft'
const composerFocused = ref(false)
const handleComposerFocusIn = (): void => {
  composerFocused.value = true
}
const handleComposerFocusOut = (event: FocusEvent): void => {
  const nextTarget = event.relatedTarget
  const currentTarget = event.currentTarget
  if (!(currentTarget instanceof HTMLElement) || !(nextTarget instanceof Node) || !currentTarget.contains(nextTarget)) composerFocused.value = false
}
const handleTranscriptEngagement = (event: FocusEvent | PointerEvent): void => {
  const target = event.target
  if (target instanceof Element && target.closest('.inline-agent__composer')) return
  composerFocused.value = false
}
const transcriptFollowing = ref(true)
const transcriptBottomDistance = ref(0)
// Restore the composer over the final 160px, with a quiet 24px landing zone.
const transcriptReadingProgress = computed(() => Math.min(1, Math.max(0, (transcriptBottomDistance.value - 24) / 136)))
let transcriptObserver: MutationObserver | null = null
let transcriptFrame: number | null = null
let transcriptFrameShouldFollow = false
let panelFocusScope: ModalFocusScope | null = null
let panelFocusKind: 'history' | 'memory' | null = null
let pendingPanelFocusKind: 'history' | 'memory' | null = null
let disposed = false
let initializationEpoch = 0
let initializationKey = ''
let initialization: Promise<boolean> | null = null
let componentGeneration = 0
let retryGeneration = 0
let promptGeneration = 0
let actionGeneration = 0
const isComponentCurrent = (generation: number, ownerId: number): boolean =>
  !disposed && componentGeneration === generation && props.ownerId === ownerId
const startersRow = useTemplateRef<HTMLElement>('startersRow')
const STARTERS_SPIN_STEP_MS = 3000
const STARTERS_SPIN_HOLD_MS = 3000
let startersSpinTimer: ReturnType<typeof setInterval> | null = null
let startersHoldTimer: ReturnType<typeof setTimeout> | null = null
let startersProgrammaticUntil = 0

const stopStartersSpin = (): void => {
  if (startersSpinTimer !== null) { clearInterval(startersSpinTimer); startersSpinTimer = null }
  if (startersHoldTimer !== null) { clearTimeout(startersHoldTimer); startersHoldTimer = null }
}

const holdStartersSpin = (): void => {
  if (disposed || startersRow.value === null) return
  if (startersHoldTimer !== null) clearTimeout(startersHoldTimer)
  startersHoldTimer = setTimeout(() => { startersHoldTimer = null }, STARTERS_SPIN_HOLD_MS)
}

const handleStartersScroll = (): void => {
  if (Date.now() < startersProgrammaticUntil) return
  holdStartersSpin()
}

const startStartersSpin = (): void => {
  if (disposed || startersSpinTimer !== null) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  startersSpinTimer = setInterval(() => {
    const row = startersRow.value
    if (disposed || !row || startersHoldTimer !== null) return
    if (!window.matchMedia('(max-width: 639.98px)').matches) return
    const buttons = row.querySelectorAll<HTMLElement>('.inline-agent__starter')
    if (buttons.length < 2) return
    const firstOffset = buttons[0]?.offsetLeft ?? 0
    const maxScroll = row.scrollWidth - row.clientWidth
    if (maxScroll <= 4) return
    let index = 0
    buttons.forEach((button, buttonIndex) => {
      if (button.offsetLeft - firstOffset <= row.scrollLeft + 4) index = buttonIndex
    })
    const nextIndex = (index + 1) % buttons.length
    const next = buttons[nextIndex]
    const target = next ? (nextIndex === 0 ? 0 : Math.min(maxScroll, next.offsetLeft - firstOffset)) : 0
    startersProgrammaticUntil = Date.now() + 900
    row.scrollTo({ left: target, behavior: 'smooth' })
  }, STARTERS_SPIN_STEP_MS)
}

watch(startersRow, row => { if (row) startStartersSpin(); else stopStartersSpin() })

const panelMode = ref<'wide' | 'docked' | 'modal'>('wide')
let panelModeMedia: MediaQueryList[] = []
const mobilePanelQuery = '(max-width: 639.98px)'

const pageHintFromProps = (): AgentCurrentPageHint | null => {
  if (props.pageId < 1 || !props.pageLocale || !props.pagePath || !props.pageUpdatedAt) return null
  return { id: props.pageId, locale: props.pageLocale, path: props.pagePath, observedUpdatedAt: props.pageUpdatedAt }
}
const currentPage = computed(pageHintFromProps)
const activeRun = computed(() => {
  const run = thread.value?.session.currentRun
  return run && (run.status === 'queued' || run.status === 'running' || run.status === 'awaiting_approval') ? run : null
})
const openGoal = computed(() => {
  const goal = thread.value?.goal
  return goal && (goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked') ? goal : null
})
const hasConversation = computed(() => Boolean(thread.value && (thread.value.messages.length || thread.value.tools.length || thread.value.artifacts.length || thread.value.goal)))
const followJumpVisible = computed(() => Boolean(hasConversation.value && transcriptReadingProgress.value > 0 && !approvalJumpVisible.value))
const pendingApprovalId = computed(() => thread.value?.proposals.find(proposal => proposal.status === 'pending' && proposal.approval?.status === 'pending')?.id ?? null)
const mediaProfile = computed(() => thread.value?.session.providerProfileId ? profiles.value.find(profile => profile.id === thread.value?.session.providerProfileId) : profiles.value.find(profile => profile.isGlobalDefault) ?? (profiles.value.length === 1 ? profiles.value[0] : undefined))
const googleSearchAvailable = computed(() => Boolean(thread.value && thread.value.session.executionMode === 'agent' && mediaProfile.value?.googleSearchAvailable === true))
const googleSearchEnabled = computed(() => thread.value?.session.googleSearchEnabled === true)
const liveGoogleSearchSuggestions = computed(() => {
  const live = googleSearchSuggestions.value
  const session = thread.value?.session
  return live && session && live.ownerId === props.ownerId && live.sessionId === session.id
    ? { runId: live.runId, suggestions: live.suggestions }
    : null
})
const mediaRefreshing = ref(false)
const refreshAfterMedia = async () => {
  mediaRefreshing.value = true
  try { await agents.refreshThread() } finally { mediaRefreshing.value = false }
}
const providerAvailable = computed(() => props.providerEnabled && profiles.value.length > 0)
const workspaceReady = computed(() => agents.isWorkspaceReady())
const serverConnectionUnavailable = computed(() =>
  pwaState.connectionState === 'offline' ||
  pwaState.connectionState === 'server-unavailable'
)
const connectionBlocked = computed(() =>
  serverConnectionUnavailable.value ||
  waitingForConnection.value ||
  (networkPaused.value && !workspaceDisposed.value && !loading.value)
)
const connectionRequiredMessage = computed(() => {
  if (pwaState.connectionState === 'server-unavailable') return 'Connection required. The server is unavailable right now.'
  if (pwaState.connectionState === 'offline') return 'Connection required. You appear to be offline.'
  if (networkPaused.value || waitingForConnection.value) return 'Connection required. Reconnect to continue this conversation.'
  return 'Connection required to open or message Wiki Agent.'
})
const providerUnavailableMessage = computed(() => props.providerEnabled
  ? 'No enabled provider profile is available for your account. Ask an administrator to grant one in Administration → Agents.'
  : 'Agent inference is currently disabled. An administrator can configure it in Administration → Agents.')
const canSubmit = computed(() =>
  providerAvailable.value &&
  workspaceReady.value &&
  !connectionBlocked.value &&
  !initializationError.value &&
  !loading.value &&
  !sending.value &&
  !sessionMutationBusy.value &&
  Boolean(thread.value) &&
  !activeRun.value &&
  !openGoal.value
)
const composerDisabled = computed(() => connectionBlocked.value
  ? loading.value || sending.value || sessionMutationBusy.value
  : !canSubmit.value)
const goalSubmitUnavailableReason = computed(() => !openGoal.value
  ? ''
  : openGoal.value.status === 'paused'
    ? 'Resume or cancel the current goal before sending a message'
    : 'Finish or cancel the current goal before sending a message')
const submitUnavailableReason = computed(() => connectionBlocked.value
  ? connectionRequiredMessage.value
  : !providerAvailable.value
    ? providerUnavailableMessage.value
    : !workspaceReady.value
      ? 'Reauthorizing the conversation'
      : loading.value
        ? 'Opening conversation'
        : initializationError.value
          ? 'The requested conversation could not be opened'
          : sending.value
            ? 'Sending your message'
            : sessionMutationBusy.value
              ? 'Wait for the current conversation update to finish'
              : activeRun.value
                ? 'Wait for the current response to finish'
                : openGoal.value
                  ? goalSubmitUnavailableReason.value
                  : '')
const preferredSkillIds = computed(() => thread.value?.session.skills.map(skill => skill.skillId) ?? [])
const invocationLimit = computed(() => Math.max(0, 8 - preferredSkillIds.value.length))
const isTemporary = computed(() => thread.value?.session.retention === 'temporary' && !thread.value.session.folderId)
const isCurrentChatPinned = computed(() => Boolean(thread.value && pinnedSessionId.value === thread.value.session.id))
const temporaryExpiry = computed(() => {
  const value = thread.value?.session.expiresAt
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
})
const sessionTitle = computed(() => thread.value?.session.title || (isTemporary.value ? 'Temporary conversation' : 'New conversation'))
const connectionLabel = computed(() => connectionBlocked.value
  ? 'Connection required'
  : loading.value
    ? 'Opening'
    : connection.value === 'reconnecting'
      ? 'Reconnecting'
      : !providerAvailable.value
        ? 'Unavailable'
        : Boolean(initializationError.value)
          ? 'Try again'
          : Boolean(error.value)
            ? 'Try again'
            : activeRun.value?.status === 'awaiting_approval'
              ? 'Review needed'
              : sending.value
                ? 'Sending'
                : activeRun.value
                  ? 'Working'
                  : 'Ready')
const connectionTone = computed<'ready' | 'error' | 'busy'>(() => connectionBlocked.value || !providerAvailable.value || Boolean(error.value) || Boolean(initializationError.value)
  ? 'error'
  : loading.value || connection.value === 'reconnecting' || sending.value || Boolean(activeRun.value)
    ? 'busy'
    : 'ready')
const activeDraft = computed(() => thread.value ? agents.drafts[thread.value.session.id] ?? emptyAgentDraft() : emptyAgentDraft())
const contextualGlass = computed(() => Boolean(currentPage.value && activeDraft.value.includeCurrentPage))
const starters = computed(() => [
  ...(contextualGlass.value
    ? [{ label: 'Understand This Page', description: 'Key ideas, with sources', prompt: 'Summarize the current Wiki page and cite the key sections.', icon: 'mdi-text-box-search-outline' }]
    : [{ label: 'Explore the Wiki', description: 'Find a place to begin', prompt: 'Give me an overview of the main topics in the Wiki, with links to useful starting pages.', icon: 'mdi-compass-outline' }]),
  { label: 'Connect the Dots', description: 'Discover related knowledge', prompt: contextualGlass.value ? 'Find Wiki pages related to the current page and explain how they connect.' : 'Help me explore connections between topics in the Wiki. Ask me which topic I want to start with.', icon: 'mdi-vector-link' },
  { label: 'Catch Up', description: 'See what changed recently', prompt: 'Summarize the 10 most recently updated Wiki pages I can access. Give each page a brief summary with a source.', icon: 'mdi-history' }
])

const patchDraft = (patch: Partial<AgentDraft>): void => { if (thread.value) agents.updateDraft(thread.value.session.id, patch) }
const setCurrentChatPinned = (pinned: boolean): void => {
  agents.setCurrentChatPinned(pinned)
}
const handleDraftChange = (sessionId: string, text: string): void => {
  if (!thread.value && sessionId === offlineSessionId) {
    offlineComposerDraft.value = text
    return
  }
  if (thread.value?.session.id === sessionId) {
    agents.setDraft(sessionId, text)
    if (!text) offlineComposerDraft.value = ''
  }
}

const preparePrompt = async (prompt: string, source?: WikiSource, scope?: AgentSearchScope): Promise<void> => {
  const generation = componentGeneration
  const ownerId = props.ownerId
  if (!await ensureInitialized() || !isComponentCurrent(generation, ownerId)) return
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
  if (!isComponentCurrent(generation, ownerId) || thread.value?.session.id !== sessionId) return
  const existing = agents.drafts[sessionId]?.text ?? ''
  await composer.value?.setDraft(existing.trim() && existing.trim() !== prompt.trim() ? source ? existing : `${existing}\n\n${prompt}` : prompt)
}
const initializationFailureMessage = (value: unknown): string =>
  value instanceof Error && value.message
    ? value.message
    : typeof value === 'string' && value
      ? value
      : 'The conversation could not be opened.'
type InitializationRequest = {
  readonly allowCreate?: boolean
  readonly bypassConnectionGate?: boolean
  readonly forceFresh?: boolean
}
const initializationAuthorityKey = (): string =>
  JSON.stringify({
    csrfToken: props.csrfToken,
    ownerId: props.ownerId,
    resumeSessionId: props.resumeSessionId ?? null,
    currentPage: currentPage.value
  })
const ensureInitialized = (request: InitializationRequest = {}): Promise<boolean> => {
  if (disposed) return Promise.resolve(false)
  const allowCreate = request.allowCreate ?? true
  const authorityKey = `${initializationAuthorityKey()}:create=${allowCreate}`
  if (!request.bypassConnectionGate && serverConnectionUnavailable.value) {
    waitingForConnection.value = true
    return Promise.resolve(false)
  }
  const storeOwnerId = (agents as unknown as { pinOwnerId?: number | null }).pinOwnerId
  if (
    !request.forceFresh &&
    workspaceReady.value &&
    (storeOwnerId === undefined || storeOwnerId === props.ownerId) &&
    !initializationError.value
  )
    return Promise.resolve(true)
  if (initialization && initializationKey === authorityKey) return initialization

  const epoch = ++initializationEpoch
  initializationKey = authorityKey
  initializationError.value = ''
  agents.error = ''
  const pending = agents.initialize(props.csrfToken, {
    ownerId: props.ownerId,
    resumeSessionId: props.resumeSessionId,
    routeSync: false,
    currentPage: currentPage.value,
    allowCreate
  })
  const tracked = pending.then(
    success => {
      if (disposed || epoch !== initializationEpoch || initializationKey !== authorityKey) return false
      const initialized = Boolean(success)
      if (initialized) {
        waitingForConnection.value = false
        initializationError.value = ''
        const sessionId = thread.value?.session.id
        const draft = offlineComposerDraft.value
        if (sessionId && draft) {
          agents.setDraft(sessionId, draft)
          offlineComposerDraft.value = ''
        }
      } else {
        initializationError.value = error.value || 'The conversation could not be opened. Retry to try again.'
      }
      return initialized
    },
    value => {
      if (disposed || epoch !== initializationEpoch || initializationKey !== authorityKey) return false
      initializationError.value = initializationFailureMessage(value)
      return false
    }
  )
  initialization = tracked
  void tracked.finally(() => {
    if (epoch === initializationEpoch && initializationKey === authorityKey && initialization === tracked) {
      initialization = null
      initializationKey = ''
    }
  })
  return tracked
}
const retryAgentConnection = async (): Promise<void> => {
  if (disposed || connectionRetrying.value) return
  const generation = retryGeneration + 1
  retryGeneration = generation
  const componentOwnerId = props.ownerId
  connectionRetrying.value = true
  waitingForConnection.value = true
  try {
    const reachable = await retryServerConnection()
    if (!reachable || !isComponentCurrent(componentGeneration, componentOwnerId) || retryGeneration !== generation) return
    initializationError.value = ''
    agents.error = ''
    await ensureInitialized({ allowCreate: false, bypassConnectionGate: true, forceFresh: true })
  } finally {
    if (isComponentCurrent(componentGeneration, componentOwnerId) && retryGeneration === generation) connectionRetrying.value = false
  }
}
const retryInitialization = async (): Promise<void> => {
  if (disposed || loading.value || connectionRetrying.value) return
  if (connectionBlocked.value) {
    await retryAgentConnection()
    return
  }
  if (!initializationError.value) return
  const generation = retryGeneration + 1
  retryGeneration = generation
  const componentOwnerId = props.ownerId
  connectionRetrying.value = true
  initializationError.value = ''
  agents.error = ''
  try {
    await ensureInitialized({ allowCreate: false, bypassConnectionGate: true, forceFresh: true })
  } finally {
    if (isComponentCurrent(componentGeneration, componentOwnerId) && retryGeneration === generation) connectionRetrying.value = false
  }
}
const focusComposer = async (): Promise<void> => {
  if (!await ensureInitialized()) return
  await nextTick()
  await composer.value?.focusInput()
}
const sendPrompt = async (
  content: string,
  invokedSkillVersionIds: readonly string[] = [],
  mode: 'message' | 'goal' = 'message',
  completion?: (success: boolean) => void,
  media?: AgentMediaSubmission
): Promise<boolean> => {
  const prompt = content.trim()
  if (disposed) { completion?.(false); return false }
  if (connectionBlocked.value) {
    waitingForConnection.value = true
    completion?.(false)
    return false
  }
  if (sessionMutationBusy.value) { completion?.(false); return false }
  if (!prompt && !media?.attachmentIds.length) { completion?.(false); return false }
  if (promptSubmissionPending.value) { completion?.(false); return false }
  const generation = promptGeneration + 1
  promptGeneration = generation
  const ownerId = props.ownerId
  promptSubmissionPending.value = true
  try {
    const initialized = await ensureInitialized()
    if (!isComponentCurrent(componentGeneration, ownerId) || promptGeneration !== generation) return false
    if (!initialized || !canSubmit.value || (mode === 'goal' && !props.goalsEnabled)) { completion?.(false); return false }
    transcriptFollowing.value = true
    const success = await agents.send(prompt, invokedSkillVersionIds, mode, media)
    if (!isComponentCurrent(componentGeneration, ownerId) || promptGeneration !== generation) return false
    completion?.(success)
    if (success) await reconcileTranscriptGrowth(true)
    return success
  } catch (value) {
    if (!isComponentCurrent(componentGeneration, ownerId) || promptGeneration !== generation) return false
    agents.error = value instanceof Error ? value.message : 'The message could not be sent.'
    completion?.(false)
    return false
  } finally {
    if (isComponentCurrent(componentGeneration, ownerId) && promptGeneration === generation) promptSubmissionPending.value = false
  }
}
const networkActionAllowed = (): boolean => {
  if (disposed || !workspaceReady.value) {
    if (connectionBlocked.value) waitingForConnection.value = true
    return false
  }
  if (!connectionBlocked.value) return true
  waitingForConnection.value = true
  return false
}
const handleDecision = (proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string): void => {
  if (disposed || connectionBlocked.value || !agents.isWorkspaceMutationReady()) return
  void agents.decideProposal(proposalId, approvalId, decision, confirmationPath)
}
const pauseGoal = (): void => {
  if (networkActionAllowed()) void agents.pauseGoal()
}
const resumeGoal = (): void => {
  if (networkActionAllowed()) void agents.resumeGoal()
}
const renewGoalBudget = (): void => {
  if (networkActionAllowed()) void agents.renewGoalBudget()
}
const cancelGoal = (): void => {
  if (networkActionAllowed()) void agents.cancelGoal()
}
const stopRun = (): void => {
  if (networkActionAllowed()) void agents.stop()
}
const focusConversation = async (): Promise<void> => {
  composerFocused.value = false
  await nextTick()
  transcript.value?.focus({ preventScroll: true })
}
const scrollToLatest = async (): Promise<void> => {
  composerFocused.value = false
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
  if (!networkActionAllowed()) return
  const generation = componentGeneration
  const ownerId = props.ownerId
  const loaded = await agents.reloadSkills()
  if (!isComponentCurrent(generation, ownerId) || !loaded) return
}
const updateSkillPreferences = (skillIds: readonly string[]): void => {
  if (networkActionAllowed()) void agents.setSkillPreferences(skillIds)
}
const updateGoogleSearch = (enabled: boolean): void => {
  if (!networkActionAllowed() || activeRun.value || openGoal.value || sessionMutationBusy.value) return
  if (enabled && !googleSearchAvailable.value) return
  void agents.setGoogleSearchEnabled(enabled)
}
const keepConversation = async (): Promise<void> => {
  if (!networkActionAllowed()) return
  const sessionId = thread.value?.session.id
  if (!sessionId || sessionMutationBusy.value || keepingConversation.value) return
  const generation = actionGeneration
  const ownerId = props.ownerId
  keepingConversation.value = true
  try {
    const kept = await agents.setSessionRetention(sessionId, 'saved')
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation || !kept || thread.value?.session.id !== sessionId) return
    setSessionNotice(hasConversation.value ? 'Conversation kept in history.' : 'Conversation kept. It will appear in history after your first message.')
  } catch (value) {
    if (isComponentCurrent(generation, ownerId) && actionGeneration === generation)
      agents.error = value instanceof Error ? value.message : 'The conversation could not be kept.'
  } finally {
    if (isComponentCurrent(generation, ownerId) && actionGeneration === generation) keepingConversation.value = false
  }
}
const createSession = async (retention: 'saved' | 'temporary'): Promise<void> => {
  if (!networkActionAllowed()) return
  if (sessionMutationBusy.value || creatingRetention.value) return
  const generation = actionGeneration
  const ownerId = props.ownerId
  creatingRetention.value = retention
  clearSessionNotice()
  try {
    const initialized = await ensureInitialized()
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation || !initialized || sessionMutationBusy.value || !networkActionAllowed()) return
    const created = await agents.newSession(retention)
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
    if (created && thread.value?.session.retention === retention) {
      await nextTick()
      if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
      await composer.value?.focusInput()
    }
  } catch (value) {
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
    const kind = retention === 'temporary' ? 'temporary conversation' : 'new saved conversation'
    agents.error = value instanceof Error ? value.message : `A ${kind} could not be created.`
  } finally {
    if (isComponentCurrent(generation, ownerId) && actionGeneration === generation) creatingRetention.value = null
  }
}
const newTemporarySession = (): Promise<void> => createSession('temporary')
const startTemporaryChat = async (): Promise<void> => {
  temporaryMenuOpen.value = false
  await newTemporarySession()
}
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
  const direct = kind === 'history' ? componentElement(historyTrigger.value) : null
  const panels = componentElement(panelMenuTrigger.value)
  const usePanelMenu = window.matchMedia(mobilePanelQuery).matches
  return (usePanelMenu ? [panels, direct] : [direct, panels]).find(isVisibleTrigger) ?? null
}
const openSkillManager = (): void => { if (networkActionAllowed()) skillManagerOpen.value = true }
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
  if (open && connectionBlocked.value) return
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
  if (!networkActionAllowed()) return
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
  if (!networkActionAllowed()) return
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
  if (!networkActionAllowed()) return
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
  if (!networkActionAllowed()) return
  if (clearingUnfiledHistory.value || sessionMutationBusy.value) return
  const generation = actionGeneration
  const ownerId = props.ownerId
  const originalSessionId = thread.value?.session.id ?? null
  const clearingCurrentSession = thread.value?.session.folderId === null
  clearingUnfiledHistory.value = true
  clearUnfiledError.value = ''
  clearUnfiledCommitted.value = false
  try {
    await agents.clearUnfiledHistory()
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
    if (clearingCurrentSession && originalSessionId && !thread.value) {
      clearUnfiledCommitted.value = true
      clearUnfiledError.value = error.value
        ? `${error.value} Saved folders and their filed conversations remain unchanged.`
        : 'Unfiled conversations were cleared, but a replacement conversation could not be opened. Saved folders and their filed conversations remain unchanged.'
      return
    }
    clearUnfiledHistoryOpen.value = false
  } catch (value) {
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
    const detail = value instanceof Error ? value.message : 'Try again.'
    clearUnfiledError.value = `Unfiled conversations could not be cleared. Saved folders and their filed conversations remain unchanged. ${detail}`
  } finally {
    if (isComponentCurrent(generation, ownerId) && actionGeneration === generation) clearingUnfiledHistory.value = false
  }
}
const recoverClearUnfiledHistory = async (): Promise<void> => {
  if (!networkActionAllowed()) return
  if (clearingUnfiledHistory.value || sessionMutationBusy.value) return
  const generation = actionGeneration
  const ownerId = props.ownerId
  clearingUnfiledHistory.value = true
  try {
    const refreshed = await agents.reloadSessions()
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
    if (!refreshed.accepted || !refreshed.current) {
      const detail = refreshed.error instanceof Error ? refreshed.error.message : 'History could not be refreshed.'
      throw new Error(detail)
    }
    if (!thread.value) {
      const candidate = agents.sessions.find(session => !session.deletedAt)
      if (!candidate || !await agents.openSession(candidate.id)) throw new Error('No replacement conversation is available yet. Retry.')
      if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
    }
    clearUnfiledHistoryOpen.value = false
    clearUnfiledError.value = ''
    clearUnfiledCommitted.value = false
  } catch (value) {
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
    const detail = value instanceof Error ? value.message : 'A replacement conversation could not be opened.'
    clearUnfiledError.value = `Unfiled conversations were cleared, but a replacement conversation still could not be opened. Saved folders and their filed conversations remain unchanged. ${detail}`
  } finally {
    if (isComponentCurrent(generation, ownerId) && actionGeneration === generation) clearingUnfiledHistory.value = false
  }
}
const updateApprovalJump = (): void => {
  const container = transcript.value
  const proposalId = pendingApprovalId.value
  if (!container || !proposalId) { approvalJumpVisible.value = false; return }
  const approval = container.querySelector<HTMLElement>(`#agent-approval-${proposalId}`)
  if (!approval) { approvalJumpVisible.value = false; return }
  const viewport = container.getBoundingClientRect()
  const dockBounds = container.querySelector<HTMLElement>('.inline-agent__conversation-dock')?.getBoundingClientRect()
  const visibleBottom = dockBounds && dockBounds.height > 0 && dockBounds.top > viewport.top
    ? Math.min(viewport.bottom, dockBounds.top)
    : viewport.bottom
  approvalJumpVisible.value = isAgentApprovalOutsideViewport(
    { top: viewport.top, bottom: visibleBottom },
    approval.getBoundingClientRect()
  )
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
  const container = transcript.value
  const distance = container ? Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight) : 0
  if (distance > transcriptBottomDistance.value + 1) composerFocused.value = false
  transcriptBottomDistance.value = distance
  const following = transcriptIsNearBottom(transcript.value)
  transcriptFollowing.value = following
  if (!following) transcriptFrameShouldFollow = false
  updateApprovalJump()
}
const reconcileTranscriptGrowth = async (shouldFollow: boolean): Promise<void> => {
  await nextTick()
  if (disposed) return
  if (!hasConversation.value && transcript.value) {
    transcript.value.scrollTo({ top: 0, behavior: 'auto' })
    transcriptFollowing.value = true
  } else if (shouldFollow && transcript.value) {
    transcript.value.scrollTo({ top: transcript.value.scrollHeight, behavior: 'auto' })
    transcriptFollowing.value = true
  } else {
    transcriptFollowing.value = transcriptIsNearBottom(transcript.value)
  }
  handleTranscriptScroll()
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
  handleTranscriptScroll()
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
watch(() => {
  const messages = thread.value?.messages ?? []
  const response = messages.findLast(message => message.role === 'assistant' && (message.content || message.media?.length))
  return [thread.value?.session.id, response?.id, response?.status === 'complete'] as const
}, ([sessionId, responseId, complete], previous) => {
  // Follow each new answer and its completion, but let readers scroll back during streaming.
  if (sessionId !== previous[0] || (responseId && (responseId !== previous[1] || (complete && !previous[2])))) {
    transcriptFollowing.value = true
    void reconcileTranscriptGrowth(true)
  }
}, { flush: 'post' })
watch(networkPaused, paused => {
  if (!paused && pwaState.connectionState === 'online') waitingForConnection.value = false
})
watch(() => pwaState.connectionState, state => {
  if (state === 'offline' || state === 'server-unavailable') {
    waitingForConnection.value = true
    agents.pauseNetwork()
    return
  }
  if (state !== 'online' || !waitingForConnection.value) return
  void retryAgentConnection()
})
watch(() => props.ownerId, (ownerId, previousOwnerId) => {
  if (disposed || ownerId === previousOwnerId) return
  componentGeneration += 1
  retryGeneration += 1
  promptGeneration += 1
  actionGeneration += 1
  connectionRetrying.value = false
  promptSubmissionPending.value = false
  keepingConversation.value = false
  creatingRetention.value = null
  clearingUnfiledHistory.value = false
  initializationEpoch += 1
  initialization = null
  initializationKey = ''
  waitingForConnection.value = false
  initializationError.value = ''
  offlineComposerDraft.value = ''
  agents.destroyWorkspace()
  void ensureInitialized({
    allowCreate: true,
    bypassConnectionGate: pwaState.connectionState === 'online',
    forceFresh: true
  })
})
watch(currentPage, (page, previous) => {
  if (page?.id === previous?.id && page?.locale === previous?.locale) {
    agents.setCurrentPage(page)
    return
  }
  componentGeneration += 1
  retryGeneration += 1
  promptGeneration += 1
  actionGeneration += 1
  promptSubmissionPending.value = false
  connectionRetrying.value = false
  keepingConversation.value = false
  creatingRetention.value = null
  clearingUnfiledHistory.value = false
  offlineComposerDraft.value = ''
  void ensureInitialized({ forceFresh: true })
}, { flush: 'post' })
const handlePageHide = (): void => { agents.closeWorkspace() }
const handlePageShow = (event: PageTransitionEvent): void => {
  if (event.persisted) void ensureInitialized({ forceFresh: true })
}
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
  if (sessionId !== previousSessionId) { goalExpanded.value = false; clearSessionNotice() }
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
    handleTranscriptScroll()
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
  transcriptObserver = new MutationObserver(records => {
    // Navigation fades must never trigger following or change a reader's position.
    if (records.some(record => {
      const element = record.target instanceof Element ? record.target : record.target.parentElement
      return element === transcript.value || element?.closest('.agent-thread, .inline-agent__goal-dock, .inline-agent__composer')
    })) scheduleTranscriptReconcile()
  })
  observeTranscript(transcript.value)
  window.addEventListener('resize', scheduleTranscriptReconcile)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('pageshow', handlePageShow)
  window.visualViewport?.addEventListener('resize', scheduleTranscriptReconcile)
  void ensureInitialized()
})
onBeforeUnmount(() => {
  disposed = true
  componentGeneration += 1
  retryGeneration += 1
  promptGeneration += 1
  actionGeneration += 1
  initializationEpoch += 1
  initialization = null
  initializationKey = ''
  transcriptObserver?.disconnect()
  if (transcriptFrame !== null) window.cancelAnimationFrame(transcriptFrame)
  panelFocusScope?.deactivate({ restoreFocus: false })
  if (sessionNoticeTimer !== null) { clearTimeout(sessionNoticeTimer); sessionNoticeTimer = null }
  stopStartersSpin()
  panelModeMedia.forEach(media => media.removeEventListener('change', reconcilePanelMode))
  window.removeEventListener('resize', scheduleTranscriptReconcile)
  window.removeEventListener('pagehide', handlePageHide)
  window.removeEventListener('pageshow', handlePageShow)
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
  transition: background-color var(--wiki-motion-slow) var(--wiki-motion-ease);
}
.inline-agent--contextual {
  background: transparent;
}
.inline-agent--contextual .inline-agent__card {
  background: transparent;
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
  -webkit-backdrop-filter: var(--wiki-chrome-blur);
  backdrop-filter: var(--wiki-chrome-blur);
  transition: background-color var(--wiki-motion-slow) var(--wiki-motion-ease);
}
.inline-agent--contextual .inline-agent__toolbar {
  background: var(--wiki-chrome-surface) !important;
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
  min-width: 0;
  max-width: 28rem;
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

.inline-agent__panel-menu-item--compact {
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
  position: relative;
  height: calc(var(--wiki-control-height) - var(--wiki-space-2)) !important;
  min-height: calc(var(--wiki-control-height) - var(--wiki-space-2));
  isolation: isolate;
  overflow: hidden;
  margin-inline-start: var(--wiki-space-1);
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 32%, transparent);
  border-radius: var(--wiki-radius-pill) !important;
  background: color-mix(in srgb, var(--wiki-accent-warm) 12%, transparent) !important;
  color: var(--wiki-accent-ink) !important;
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.inline-agent__new-session :deep(.v-btn__prepend),
.inline-agent__new-session :deep(.v-btn__content),
.inline-agent__new-session :deep(.v-btn__append) {
  z-index: 1;
}

.inline-agent__new-session:hover {
  border-color: color-mix(in srgb, var(--wiki-ambient-accent) 42%, transparent);
  background: color-mix(in srgb, var(--wiki-accent-warm) 16%, transparent) !important;
}

.inline-agent__new-session.v-btn--disabled {
  border-color: transparent;
  background: transparent !important;
  color: rgb(var(--v-theme-on-surface)) !important;
  opacity: .38;
}
.inline-agent__session-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-2);
  margin-top: var(--wiki-space-1);
}

.inline-agent__pin-indicator {
  flex: 0 0 auto;
  color: var(--wiki-accent-warm);
}

.inline-agent__temporary-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: .25rem;
  min-height: var(--wiki-space-6);
  padding-inline: var(--wiki-space-2);
  border: 1px solid transparent;
  border-radius: var(--wiki-radius-pill);
  background: transparent;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, rgb(var(--v-theme-surface)) 38%);
  font-family: var(--wiki-font-ui, inherit);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  line-height: 1.2;
  cursor: pointer;
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.inline-agent__temporary-toggle:hover,
.inline-agent__temporary-toggle:focus-visible {
  border-color: color-mix(in srgb, var(--wiki-ambient-accent) 24%, transparent);
  background: color-mix(in srgb, var(--wiki-ambient-accent) 8%, transparent);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 78%, rgb(var(--v-theme-surface)) 22%);
}

.inline-agent__temporary-toggle--active {
  border-color: color-mix(in srgb, var(--wiki-ambient-accent) 34%, transparent);
  background: color-mix(in srgb, var(--wiki-ambient-accent) 14%, transparent);
  color: var(--wiki-accent-ink);
}

.inline-agent__temporary-toggle:disabled {
  opacity: .5;
  cursor: default;
}

.inline-agent__temporary-toggle:focus-visible {
  outline: .125rem solid var(--wiki-focus-color);
  outline-offset: var(--wiki-focus-offset);
}

.inline-agent__temporary-popover {
  display: grid;
  gap: var(--wiki-space-2);
  min-width: min(18rem, calc(100vw - var(--wiki-space-8)));
  max-width: 20rem;
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-lg, .75rem);
  background: rgb(var(--v-theme-surface));
  box-shadow: var(--wiki-shadow-md, 0 .5rem 1rem rgba(0, 0, 0, .12));
}

.inline-agent__temporary-popover-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-2);
}

.inline-agent__temporary-popover-title {
  font-weight: var(--wiki-label-weight);
  font-size: var(--wiki-label-size);
}

.inline-agent__temporary-switch {
  position: relative;
  flex: 0 0 auto;
  width: 2.75rem;
  height: 1.5rem;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 38%, transparent);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 12%, transparent);
  cursor: pointer;
  transition: background-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.inline-agent__temporary-switch::after {
  content: '';
  position: absolute;
  top: 50%;
  left: .1875rem;
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  background: rgb(var(--v-theme-surface));
  box-shadow: var(--wiki-shadow-xs);
  transform: translateY(-50%);
  transition: transform var(--wiki-motion-fast) var(--wiki-motion-ease), background-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.inline-agent__temporary-switch[aria-checked='true'] {
  border-color: color-mix(in srgb, var(--wiki-ambient-accent) 40%, transparent);
  background: color-mix(in srgb, var(--wiki-ambient-accent) 55%, transparent);
}

.inline-agent__temporary-switch[aria-checked='true']::after {
  transform: translate(1.25rem, -50%);
  background: rgb(var(--v-theme-surface));
}

.inline-agent__temporary-switch:focus-visible {
  outline: .125rem solid var(--wiki-focus-color);
  outline-offset: var(--wiki-focus-offset);
}

.inline-agent__temporary-switch:disabled {
  opacity: .5;
  cursor: default;
}

.inline-agent__temporary-popover-copy {
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.45;
}

.inline-agent__more-menu {
  order: 3;
  min-width: var(--wiki-control-height);
  min-height: var(--wiki-control-height);
}

.inline-agent__panel-actions > .inline-agent__new-session {
  order: 2;
}

.inline-agent__panel-actions > .inline-agent__close-action {
  order: 4;
}

.inline-agent__close-action {
  margin-inline-start: var(--wiki-space-2);
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
.inline-agent__session-notice {
  margin: 0;
  padding: .65rem clamp(1rem, 3vw, 2rem);
  border-bottom: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
  font-size: .8rem;
  color: var(--wiki-accent-ink);
}
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
  padding: var(--wiki-space-4) clamp(var(--wiki-space-4), 3vw, var(--wiki-space-8)) var(--wiki-space-2);
  background: rgb(var(--v-theme-background));
  -webkit-backdrop-filter: var(--wiki-chrome-blur);
  backdrop-filter: var(--wiki-chrome-blur);
  transition: background-color var(--wiki-motion-slow) var(--wiki-motion-ease);
}

.inline-agent--contextual .inline-agent__body {
  background: var(--wiki-chrome-surface);
}

@supports not ((backdrop-filter: blur(6px)) or (-webkit-backdrop-filter: blur(6px))) {
  .inline-agent .inline-agent__toolbar,
  .inline-agent .inline-agent__body {
    background: rgb(var(--v-theme-background)) !important;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
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
  scroll-behavior: auto;
  scroll-padding-block: var(--wiki-space-4);
}
.inline-agent__conversation-dock {
  position: sticky;
  z-index: 3;
  inset-block-end: 0;
  display: flex;
  width: 100%;
  box-sizing: border-box;
  flex-direction: column;
  margin: var(--wiki-space-3) auto 0;
  pointer-events: none;
}
.inline-agent__conversation-dock > .inline-agent__goal-dock,
.inline-agent__conversation-dock > .inline-agent__composer {
  pointer-events: auto;
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
  flex-direction: column;
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
  position: absolute;
  inset-block-end: 100%;
  inset-inline-end: max(0px, calc((100% - var(--agent-conversation-width)) / 2));
  display: flex;
  align-items: center;
  width: min(100%, var(--agent-conversation-width));
  box-sizing: border-box;
  flex: 0 0 auto;
  justify-content: flex-end;
  margin-inline: auto;
  padding: var(--wiki-space-4);
  border: 0;
  background: transparent;
  pointer-events: none;
}

.inline-agent__jump-dock > .v-btn {
  pointer-events: auto;
}

.inline-agent__approval-jump {
  box-shadow: var(--wiki-shadow-md);
}

.inline-agent__follow-jump {
  box-sizing: border-box;
  min-width: 36px;
  min-height: 36px;
  height: auto;
  padding: 0;
  border-radius: var(--wiki-control-radius);
  background: transparent !important;
  box-shadow: none;
  transition: opacity 160ms var(--wiki-motion-ease);
}

.inline-agent__follow-jump :deep(.v-btn__content) {
  min-height: 36px;
  padding: 0;
}

.inline-agent__follow-jump-frame {
  position: relative;
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  justify-content: center;
}

.inline-agent__follow-jump-halo {
  position: absolute;
  inset: -2px;
  border-radius: var(--wiki-control-radius);
  background: linear-gradient(
    90deg,
    var(--wiki-accent-warm),
    var(--wiki-ambient-accent),
    var(--wiki-accent-spectral)
  );
  filter: blur(4px);
  opacity: .42;
  pointer-events: none;
}

.inline-agent__follow-jump-face {
  position: relative;
  display: inline-flex;
  min-height: 36px;
  box-sizing: border-box;
  align-items: center;
  gap: var(--wiki-space-1);
  padding-inline: var(--wiki-space-2);
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 38%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-md);
  color: rgb(var(--v-theme-on-surface));
  font-size: .75rem;
  line-height: 1;
  white-space: nowrap;
}

.inline-agent__follow-jump-face :deep(.v-icon) {
  flex: 0 0 auto;
  font-size: 16px;
}

@media (pointer: coarse) {
  .inline-agent__follow-jump {
    min-height: 44px;
    padding: 4px;
  }
}

.inline-agent__welcome {
  position: relative;
  display: flex;
  width: min(100%, var(--agent-conversation-width));
  min-height: 0;
  box-sizing: border-box;
  flex: 1 1 auto;
  flex-direction: column;
  justify-content: space-evenly;
  margin: 0 auto;
  padding: clamp(1.5rem, 4vh, 3.5rem) 0 clamp(2rem, 8vh, 5rem);
  text-align: center;
  transform: translateY(-2vh);
}

/* The welcome treatment stays typographic and compact; the old decorative mark is intentionally omitted. */

.inline-agent__welcome h2 {
  position: relative;
  isolation: isolate;
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-display);
  font-size: clamp(2.4rem, 4vw, 4.25rem);
  font-weight: 450;
  letter-spacing: -.045em;
  line-height: 1.04;
  text-wrap: balance;
}

.inline-agent__welcome h2::before {
  content: '';
  position: absolute;
  z-index: 0;
  inset: -.9em -1em;
  border-radius: 50%;
  background: radial-gradient(ellipse closest-side,
    rgb(var(--v-theme-background)) 0% 64%,
    rgba(var(--v-theme-background), .92) 72%,
    rgba(var(--v-theme-background), .45) 86%,
    rgba(var(--v-theme-background), 0) 100%);
  filter: blur(12px);
  opacity: 0;
  transition: opacity var(--wiki-motion-slow) var(--wiki-motion-ease);
  pointer-events: none;
}

@supports ((backdrop-filter: blur(6px)) or (-webkit-backdrop-filter: blur(6px))) {
  @media (prefers-reduced-transparency: no-preference) and (forced-colors: none) {
    .inline-agent--contextual .inline-agent__welcome h2::before {
      opacity: 1;
    }
  }
}

.inline-agent__welcome-line {
  position: relative;
  z-index: 1;
  display: block;
}

@container inline-agent-transcript (max-width: 900px) {
  .inline-agent__welcome h2::before { inset-inline: 0; }
}

.inline-agent__welcome h2 em {
  font-style: italic;
  font-weight: inherit;
  color: var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
}

.inline-agent__starters {
  display: grid;
  width: min(84%, calc(var(--agent-conversation-width) - var(--wiki-space-8)));
  margin: clamp(1.25rem, 5vh, 3rem) auto 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: .65rem;
  justify-content: center;
}

.inline-agent__starter {
  height: auto !important;
  min-height: 4.05rem;
  padding: .6rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface)) !important;
  text-align: center;
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
  width: 100%;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: center;
  justify-items: stretch;
  gap: .25rem;
}

.inline-agent__starter-heading {
  position: relative;
  display: grid;
  min-width: 0;
  align-items: center;
  justify-items: center;
  gap: .3rem;
  width: 100%;
  box-sizing: border-box;
  padding-inline: 1.25rem;
}

.inline-agent__starter-heading > :deep(.v-icon:first-child) {
  flex: 0 0 auto;
  font-size: 1.25rem;
}

.inline-agent__starter-heading strong {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
  text-align: center;
  font-size: .83rem;
  font-weight: 700;
}

.inline-agent__starter-copy {
  display: block;
  min-width: 0;
  grid-column: 1;
  grid-row: 2;
  padding-inline: 1.25rem;
  text-align: center;
}

.inline-agent__starter-copy small {
  display: block;
  overflow-wrap: anywhere;
  font-size: .73rem;
  font-weight: 400;
  opacity: .7;
}

.inline-agent__composer {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  flex: 0 0 auto;
  padding: var(--wiki-space-4) clamp(var(--wiki-space-4), 3vw, var(--wiki-space-8)) max(var(--wiki-space-4), env(safe-area-inset-bottom));
  border-top: 0;
  background: transparent;
  box-shadow: none;
  opacity: var(--agent-composer-opacity, 1);
  transition: opacity 160ms var(--wiki-motion-ease);
}
.inline-agent__composer--focused {
  opacity: 1;
}
@media (hover: hover) and (pointer: fine) {
  .inline-agent__composer:hover {
    opacity: 1;
  }
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
.inline-agent__pin-storage-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-2);
  margin: 0 0 var(--wiki-space-3);
  color: color-mix(in srgb, rgb(var(--v-theme-warning)) 88%, rgb(var(--v-theme-on-surface)));
  font-size: var(--wiki-label-size);
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
  background: var(--wiki-surface-raised);
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
  background: var(--wiki-surface-raised);
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
  background: var(--wiki-surface-raised);
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
  .inline-agent__starters { width: 100%; grid-template-columns: 1fr; }
  .inline-agent__starter { min-height: 3.6rem; padding: .675rem; }
  .inline-agent__welcome {
    max-width: 40rem;
  }
}

/* Compact phones: keep the three starters on one row and let the row scroll
   horizontally instead of clipping the last button under the composer. */
@media (max-width: 639.98px) {
  .inline-agent__starters {
    display: flex;
    gap: var(--wiki-space-2);
    margin-top: var(--wiki-space-5);
    padding: var(--wiki-space-1) var(--wiki-space-3) var(--wiki-space-2);
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    /* Center justification would split the overflow across both edges of the
       scrollport, clipping the first starter where it cannot be scrolled to. */
    justify-content: flex-start;
  }
  .inline-agent__starters::-webkit-scrollbar { display: none; }
  .inline-agent__starters::after {
    content: '';
    display: block;
    flex: 0 0 1px;
  }
  .inline-agent__starter {
    flex: 0 0 auto;
    min-height: 3.5rem;
  }
  .inline-agent__starter-heading { padding-inline: .75rem; }
  .inline-agent__starter-copy { padding-inline: .75rem; }
  .inline-agent__starter-copy small { white-space: nowrap; }
}

/* A docked panel can make a desktop conversation as narrow as a tablet. */
@container agent-workspace (max-width: 780px) {
  .inline-agent__desktop-panel-btn { display: none; }
  .inline-agent__new-label--wide { display: none; }
  .inline-agent__panel-actions > .inline-agent__new-session { order: 1; }
  .inline-agent__panel-actions > .inline-agent__more-menu { order: 2; }
  .inline-agent__panel-menu-item--compact { display: flex !important; }
  .inline-agent__session-action { min-width: var(--wiki-control-height); padding-inline: var(--wiki-space-2); }
  .inline-agent__session-action :deep(.v-btn__prepend) { margin: 0; }
  .inline-agent__notice { display: none; }
  .inline-agent__starters { width: 100%; grid-template-columns: 1fr; }
  .inline-agent__starter { min-height: 3.25rem; padding: .6rem; }
}

@media (min-width: 640px) and (max-width: 1023.98px) {
  .inline-agent__toolbar {
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-4));
    padding-inline: var(--wiki-space-3);
  }

  .inline-agent__eyebrow,
  .inline-agent__desktop-panel-btn,
  .inline-agent__new-label--wide {
    display: none;
  }

  .inline-agent__panel-menu-item--compact {
    display: flex !important;
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
  .inline-agent__close-action {
    min-width: var(--wiki-control-height) !important;
    min-height: var(--wiki-control-height) !important;
  }

  .inline-agent__mobile-return {
    padding-inline: var(--wiki-space-2) !important;
  }

  .inline-agent__toolbar {
    flex-wrap: nowrap;
    min-height: calc(var(--wiki-control-height) + env(safe-area-inset-top));
    padding-block-start: max(0px, env(safe-area-inset-top));
    padding-inline: var(--wiki-space-2);
  }
  .inline-agent__toolbar :deep(.v-toolbar__content) {
    flex-wrap: nowrap;
    align-content: center;
    align-items: center;
    min-height: inherit;
  }
  .inline-agent__toolbar-main {
    flex: 1 1 auto;
    min-width: 0;
    min-height: var(--wiki-control-height);
  }
  .inline-agent__progress {
    inset-block-start: calc(var(--wiki-control-height) + env(safe-area-inset-top) - var(--wiki-space-1));
  }

  .inline-agent__eyebrow {
    display: none;
  }
  .inline-agent__identity {
    overflow: hidden;
    gap: .375rem;
  }
  .inline-agent__avatar { width: 32px !important; height: 32px !important; }

  /* The brand title drops out of the visual header on phones; the h2 stays
     only as the accessible label while the conversation name becomes the
     visible title line. */
  .inline-agent__heading h2 {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    border: 0;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .inline-agent__workspace-title--wide { display: none; }

  .inline-agent__session-line {
    flex-wrap: wrap;
    row-gap: 0;
    margin-top: 0;
  }
  .inline-agent__session-title {
    flex: 0 0 100%;
    color: rgb(var(--v-theme-on-surface));
    font-family: var(--wiki-font-heading);
    font-size: 1rem;
    font-weight: 720;
    letter-spacing: -.015em;
  }


  .inline-agent__desktop-panel-btn,
  .inline-agent__new-label--wide {
    display: none;
  }

  .inline-agent__panel-menu-item--compact {
    display: flex !important;
  }

  .inline-agent__panel-actions {
    flex: 0 0 auto;
    min-height: var(--wiki-control-height);
    justify-content: flex-end;
    gap: var(--wiki-space-1);
  }

  .inline-agent__toolbar :deep(.v-btn) {
    min-width: var(--wiki-control-height);
    min-height: var(--wiki-control-height);
  }

  .inline-agent__body {
    padding: var(--wiki-space-2) var(--wiki-space-3) var(--wiki-space-2);
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
    padding: var(--wiki-space-6) var(--wiki-space-2) var(--wiki-space-5);
  }


  .inline-agent__welcome h2 { font-size: clamp(2rem, 8vw, 3rem); }


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
    min-height: auto;
    justify-content: flex-start;
    padding-block: var(--wiki-space-5);
    transform: none;
  }

  .inline-agent__starters {
    margin-top: var(--wiki-space-5);
  }
}

@media (max-width: 639.98px) and (max-height: 500px) {
  .inline-agent__starters {
    padding-block: var(--wiki-space-1) var(--wiki-space-2);
  }
}

@media (max-width: 639.98px) and (max-height: 500px) {
  .inline-agent__toolbar {
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-2) + env(safe-area-inset-top));
  }

  .inline-agent__progress {
    inset-block-start: calc(var(--wiki-control-height) + var(--wiki-space-2) + env(safe-area-inset-top) - var(--wiki-space-1));
  }
}

@media (prefers-reduced-transparency: reduce) {
  .inline-agent .inline-agent__toolbar,
  .inline-agent .inline-agent__body {
    background: rgb(var(--v-theme-background)) !important;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    transition: none;
  }
}

@media (forced-colors: active) {
  .inline-agent__composer {
    opacity: 1;
  }
  .inline-agent__welcome h2::before {
    display: none;
  }
  .inline-agent__card,
  .inline-agent__side {
    border: 1px solid CanvasText;
  }
  .inline-agent .inline-agent__toolbar,
  .inline-agent .inline-agent__body {
    background: Canvas !important;
    color: CanvasText;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  .inline-agent__scrim {
    background: Canvas;
    opacity: .72;
  }

  .inline-agent__loading-mark {
    background: Highlight;
  }
  .inline-agent__follow-jump-halo,
  .inline-agent__follow-jump :deep(.v-btn__underlay),
  .inline-agent__follow-jump :deep(.v-btn__overlay) {
    display: none;
  }

  .inline-agent__follow-jump-face,
  .inline-agent__composer--scrolled:not(.inline-agent__composer--focused),
  .inline-agent__composer--scrolled:not(.inline-agent__composer--focused) :deep(.agent-composer) {
    border-color: ButtonText;
    background: Canvas;
    box-shadow: none;
    color: ButtonText;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  .inline-agent__temporary-session--active {
    border-color: Highlight !important;
    background: Highlight !important;
    color: HighlightText !important;
    outline: 2px solid Highlight;
    outline-offset: -2px;
    box-shadow: inset 0 0 0 1px HighlightText;
  }

  .inline-agent__temporary-session--active:focus-visible {
    outline-offset: 2px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .inline-agent__transcript {
    scroll-behavior: auto;
  }

  .inline-agent__loading-mark {
    animation: none;
  }
  .inline-agent__starter,
  .inline-agent__composer,
  .inline-agent__follow-jump,
  .inline-agent__card,
  .inline-agent__toolbar,
  .inline-agent__body {
    transition: none;
  }
}
</style>
