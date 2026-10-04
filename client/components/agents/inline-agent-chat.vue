<template>
  <section
    ref="inlineAgentRoot"
    class="inline-agent"
    :class="{ 'inline-agent--history': historyOpen, 'inline-agent--memory': memoryOpen }"
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
      :aria-label="$t('common:inlineAgentChat.closeAgentSidePanel')"
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
      <v-toolbar class="inline-agent__toolbar" color="transparent" :height="64" tag="header">
        <div class="inline-agent__toolbar-main">
          <div class="inline-agent__mobile-navigation">
            <v-tooltip location="bottom" :text="historyToggleBlocked ? $t('common:agentWorkspace.waitForMemory') : $t('common:agentWorkspace.history')">
              <template #activator="{ props: tooltipProps }">
                <v-btn
                  v-bind="tooltipProps"
                  ref="historyTrigger"
                  class="inline-agent__history-toggle"
                  prepend-icon="mdi-history"
                  variant="text"
                  :aria-label="$t('common:agentWorkspace.history')"
                  :aria-expanded="historyOpen"
                  aria-controls="agent-history-panel"
                  :aria-disabled="historyToggleBlocked ? 'true' : undefined"
                  @click="toggleHistory"
                >{{ $t('common:agentWorkspace.history') }}</v-btn>
              </template>
            </v-tooltip>
            <v-tooltip location="bottom" :text="memoryMutationBusy ? $t('common:agentWorkspace.waitForMemory') : $t('common:agentWorkspace.memory')">
              <template #activator="{ props: tooltipProps }">
                <v-btn
                  v-bind="tooltipProps"
                  ref="memoryTrigger"
                  class="inline-agent__memory-toggle"
                  prepend-icon="mdi-brain"
                  variant="text"
                  :aria-label="$t('common:agentWorkspace.memory')"
                  :aria-expanded="memoryOpen"
                  aria-controls="agent-memory-panel"
                  :aria-disabled="memoryMutationBusy ? 'true' : undefined"
                  @click="toggleMemory"
                >{{ $t('common:agentWorkspace.memory') }}</v-btn>
              </template>
            </v-tooltip>
          </div>
          <div class="inline-agent__identity">
            <div class="inline-agent__heading">
              <h2 :id="workspaceTitleId">{{ $t('common:inlineAgentChat.wikiAgent') }}</h2>
              <div class="inline-agent__session-line">
                <span class="inline-agent__session-title">
                  {{ sessionTitle }}
                  <v-icon
                    v-if="isCurrentChatPinned"
                    class="inline-agent__pin-indicator"
                    icon="mdi-pin"
                    size="14"
                    role="img"
                    :aria-label="$t('common:agentWorkspace.pinned')"
                  />
                </span>
                <v-menu v-if="providerIdentity" v-model="providerMenuOpen" content-class="agent-owned-overlay" location="bottom start" attach=".inline-agent">
                  <template #activator="{ props: providerMenuProps }">
                    <v-btn
                      v-bind="providerMenuProps"
                      class="inline-agent__provider-trigger"
                      variant="text"
                      size="small"
                      :title="providerIdentity"
                      :aria-label="$t('common:inlineAgentChat.chooseProviderLabel', { identity: providerIdentity, interpolation: { escapeValue: false } })"
                      :aria-expanded="providerMenuOpen"
                    >
                      <span class="inline-agent__provider-identity" :title="providerIdentity">{{ providerIdentity }}</span>
                      <span class="inline-agent__model-label">{{ $t('common:inlineAgentChat.modelLabel', { defaultValue: 'Model' }) }}</span>
                      <v-icon icon="mdi-chevron-down" size="14" aria-hidden="true" />
                    </v-btn>
                  </template>
                  <v-list class="inline-agent__provider-menu" density="compact" role="menu" :aria-label="$t('common:inlineAgentChat.chooseProvider')">
                    <v-list-item
                      class="inline-agent__provider-option"
                      role="menuitemradio"
                      :aria-checked="!thread?.session.providerProfileId"
                      :aria-disabled="Boolean(providerSelectionUnavailableReason)"
                      :active="!thread?.session.providerProfileId"
                      :prepend-icon="!thread?.session.providerProfileId ? 'mdi-check' : undefined"
                      :title="$t('common:inlineAgentChat.workspaceDefaultProvider')"
                      :disabled="Boolean(providerSelectionUnavailableReason)"
                      @click="selectProvider(null)"
                    />
                    <v-list-item
                      v-for="profile in profiles"
                      :key="profile.id"
                      class="inline-agent__provider-option"
                      role="menuitemradio"
                      :aria-checked="thread?.session.providerProfileId === profile.id"
                      :aria-disabled="Boolean(providerSelectionUnavailableReason)"
                      :active="thread?.session.providerProfileId === profile.id"
                      :prepend-icon="thread?.session.providerProfileId === profile.id ? 'mdi-check' : undefined"
                      :title="profile.name"
                      :subtitle="profile.model"
                      :disabled="Boolean(providerSelectionUnavailableReason)"
                      @click="selectProvider(profile.id)"
                    />
                    <p v-if="providerSelectionUnavailableReason" class="inline-agent__provider-help" role="status">{{ providerSelectionUnavailableReason }}</p>
                    <p class="inline-agent__provider-help">{{ $t('common:inlineAgentChat.providerWebConsentHelp') }}</p>
                  </v-list>
                </v-menu>
              </div>
            </div>
          </div>
        </div>

        <div class="inline-agent__panel-actions" role="group" :aria-label="$t('common:agentWorkspace.actionsLabel')">
          <v-tooltip location="bottom" :text="$t('common:agentWorkspace.search')">
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="tooltipProps"
                class="inline-agent__search-action"
                prepend-icon="mdi-magnify"
                variant="text"
                :aria-label="$t('common:agentWorkspace.search')"
                @click="emit('return-search')"
              >{{ $t('common:agentWorkspace.search') }}</v-btn>
            </template>
          </v-tooltip>
          <v-menu v-model="panelMenuOpen" ref="panelMenu" content-class="agent-owned-overlay" location="bottom end" attach=".inline-agent">
            <template #activator="{ props: menuProps }">
              <v-tooltip location="bottom" :text="$t('common:agentWorkspace.moreActions')">
                <template #activator="{ props: tooltipProps }">
                  <v-btn
                    v-bind="{ ...menuProps, ...tooltipProps }"
                    ref="panelMenuTrigger"
                    class="inline-agent__more-menu"
                    icon="mdi-dots-vertical"
                    variant="text"
                    :aria-label="$t('common:agentWorkspace.moreActions')"
                    :aria-expanded="panelMenuOpen"
                  />
                </template>
              </v-tooltip>
            </template>
            <v-list density="compact">
              <v-list-item
                class="inline-agent__panel-menu-item inline-agent__panel-menu-item--compact"
                link
                prepend-icon="mdi-brain"
                :title="$t('common:agentWorkspace.memory')"
                :aria-expanded="memoryOpen"
                :disabled="memoryMutationBusy"
                @click="toggleMemory"
              />
              <v-list-item
                class="inline-agent__panel-menu-item"
                link
                :prepend-icon="isCurrentChatPinned ? 'mdi-pin' : 'mdi-pin-outline'"
                :title="isCurrentChatPinned ? $t('common:agentWorkspace.unpin') : $t('common:agentWorkspace.pin')"
                :disabled="!canPinCurrentChat"
                @click="setCurrentChatPinned(!isCurrentChatPinned)"
              />
              <v-list-item
                class="inline-agent__panel-menu-item"
                link
                :prepend-icon="isTemporary ? 'mdi-timer-sand-complete' : 'mdi-timer-sand-empty'"
                :title="isTemporary ? $t('common:agentWorkspace.keepConversation') : $t('common:agentWorkspace.temporaryChat')"
                :disabled="loading || sending || sessionMutationBusy || Boolean(creatingRetention) || connectionBlocked || !workspaceReady"
                @click="isTemporary ? keepConversation() : startTemporaryChat()"
              />
            </v-list>
          </v-menu>
          <v-tooltip location="bottom" :text="$t('common:agentWorkspace.newChat')">
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="tooltipProps"
                class="inline-agent__session-action inline-agent__new-session"
                prepend-icon="mdi-plus-circle-outline"
                variant="text"
                :loading="creatingRetention === 'saved'"
                :aria-label="$t('common:agentWorkspace.newChat')"
                :disabled="loading || sending || sessionMutationBusy || Boolean(creatingRetention) || connectionBlocked || !workspaceReady"
                @click="newSession"
              >{{ $t('common:agentWorkspace.newChat') }}</v-btn>
            </template>
          </v-tooltip>
          <div class="inline-agent__actions-divider" aria-hidden="true" />
          <v-tooltip location="bottom" :text="memoryMutationBusy ? $t('common:agentWorkspace.waitForMemory') : $t('common:agentWorkspace.close')">
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="tooltipProps"
                class="inline-agent__close-action"
                prepend-icon="mdi-close"
                variant="text"
                :aria-label="$t('common:agentWorkspace.close')"
                :aria-disabled="memoryMutationBusy ? 'true' : undefined"
                @click="requestClose"
              >{{ $t('common:agentWorkspace.close') }}</v-btn>
            </template>
          </v-tooltip>
        </div>
      </v-toolbar>

      <div class="inline-agent__commandbar">
        <p class="inline-agent__execution-state" role="status" aria-live="polite">
          <v-icon :icon="admissionBlocked ? 'mdi-lock-outline' : connectionTone === 'error' ? 'mdi-cloud-alert-outline' : connectionTone === 'busy' ? 'mdi-progress-clock' : 'mdi-check-circle-outline'" size="18" aria-hidden="true" />
          <span>{{ admissionBlocked ? admissionRequiredMessage : connectionLabel }}</span>
          <span v-if="thread && (thread.historyWindow.hasOlderMessages || thread.historyWindow.hasOlderRuns)" class="inline-agent__history-scope">{{ $t('common:agentThread.historyWindowSummary', { defaultValue: 'Older history is not included in this view.' }) }}</span>
        </p>
        <div class="inline-agent__session-controls" role="group" :aria-label="$t('common:agentWorkspace.actionsLabel')">
          <v-btn
            variant="text"
            size="small"
            :prepend-icon="isCurrentChatPinned ? 'mdi-pin' : 'mdi-pin-outline'"
            :aria-pressed="isCurrentChatPinned"
            :disabled="!canPinCurrentChat"
            @click="setCurrentChatPinned(!isCurrentChatPinned)"
          >{{ isCurrentChatPinned ? $t('common:agentWorkspace.unpin') : $t('common:agentWorkspace.pin') }}</v-btn>
          <v-btn
            variant="text"
            size="small"
            :prepend-icon="isTemporary ? 'mdi-content-save-outline' : 'mdi-timer-sand-empty'"
            :loading="keepingConversation || creatingRetention === 'temporary'"
            :disabled="loading || sending || sessionMutationBusy || Boolean(creatingRetention) || connectionBlocked || !workspaceReady"
            @click="isTemporary ? keepConversation() : startTemporaryChat()"
          >{{ isTemporary ? $t('common:agentWorkspace.keepConversation') : $t('common:agentWorkspace.temporaryChat') }}</v-btn>
        </div>
      </div>


      <v-progress-linear
        v-if="loading"
        class="inline-agent__progress"
        indeterminate
        color="primary"
        :aria-label="$t('common:inlineAgentChat.openingConversation')"
      />

      <v-alert
        v-if="connectionBlocked && approvalId"
        class="inline-agent__alert inline-agent__connection-alert"
        type="warning"
        variant="tonal"
        role="status"
        icon="mdi-cloud-off-outline"
      >
        <div class="inline-agent__initialization-error-content">
          <span>{{ connectionRequiredMessage }}</span>
          <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :loading="connectionRetrying" :disabled="connectionRetrying" @click="retryAgentConnection">{{ $t('common:agentWorkspace.retryConnection') }}</v-btn>
        </div>
      </v-alert>

      <AgentMcpApproval v-if="approvalId && !admissionBlocked" :csrf-token="csrfToken" :proposal-id="approvalId" :network-blocked="connectionBlocked" />
      <template v-else>
        <div v-if="isTemporary" class="inline-agent__retention" :aria-label="$t('common:agentWorkspace.temporaryChat')" role="status">
          <v-icon icon="mdi-timer-sand-complete" size="22" aria-hidden="true" />
          <div class="inline-agent__retention-copy">
            <strong>{{ $t('common:agentWorkspace.temporaryChat') }}</strong>
            <p>{{ $t('common:inlineAgentChat.hiddenHistory') }}<span v-if="temporaryExpiry"> {{ $t('common:inlineAgentChat.expires', { temporaryExpiry, interpolation: { escapeValue: false } }) }}</span>{{ $t('common:inlineAgentChat.personalMemoryStillApplies') }}</p>
          </div>
        </div>
        <p v-else-if="sessionNotice" class="inline-agent__session-notice" role="status">{{ sessionNotice }}</p>
        <div class="inline-agent__body">
          <!-- One status slot: admission and connection failures stay distinct,
               and only the highest-priority problem is shown at a time. -->
          <v-alert
            v-if="admissionBlocked"
            class="inline-agent__alert inline-agent__admission-alert"
            type="warning"
            variant="tonal"
            role="alert"
            icon="mdi-lock-outline"
          >
            <div class="inline-agent__initialization-error-content">
              <span>{{ admissionRequiredMessage }}</span>
              <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :loading="connectionRetrying" :disabled="loading || connectionRetrying" @click="retryInitialization">{{ $t('common:agentWorkspace.retryOpening') }}</v-btn>
            </div>
          </v-alert>
          <v-alert
            v-else-if="connectionBlocked"
            class="inline-agent__alert inline-agent__connection-alert"
            type="warning"
            variant="tonal"
            role="status"
            icon="mdi-cloud-off-outline"
          >
            <div class="inline-agent__initialization-error-content">
              <span>{{ connectionRequiredMessage }}</span>
              <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :loading="connectionRetrying" :disabled="connectionRetrying" @click="retryAgentConnection">{{ $t('common:agentWorkspace.retryConnection') }}</v-btn>
            </div>
          </v-alert>
          <v-alert
            v-else-if="!loading && initializationError"
            class="inline-agent__alert inline-agent__initialization-error"
            type="error"
            variant="tonal"
            role="alert"
          >
            <div class="inline-agent__initialization-error-content">
              <span>{{ initializationError }}</span>
              <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :disabled="loading || connectionRetrying" @click="retryInitialization">{{ $t('common:agentWorkspace.retryOpening') }}</v-btn>
            </div>
          </v-alert>
          <v-alert
            v-else-if="!loading && !providerAvailable"
            class="inline-agent__alert"
            variant="tonal"
            role="status"
            icon="mdi-connection"
          >
            {{ providerUnavailableMessage }}
          </v-alert>
          <v-alert
            v-else-if="error && (thread || !initializationError)"
            class="inline-agent__alert"
            type="error"
            variant="tonal"
            role="alert"
            closable
            @click:close="agents.error = ''"
          >{{ error }}</v-alert>

          <div class="inline-agent__transcript-wrap">
            <div
              ref="transcript"
              class="inline-agent__transcript"
              :class="{ 'inline-agent__transcript--following': transcriptFollowing }"
              tabindex="0"
              role="region"
              :aria-label="$t('common:inlineAgentChat.conversationTranscript')"
              @scroll.passive="handleTranscriptScroll"
              @wheel.passive="handleTranscriptEngagement"
              @touchstart.passive="handleTranscriptEngagement"
              @keydown="handleTranscriptEngagement"
              @pointerdown="handleTranscriptEngagement"
              @focusin="handleTranscriptEngagement"
            >
              <div v-if="loading && !thread" class="inline-agent__loading" role="status">
                <span class="inline-agent__loading-mark" aria-hidden="true" />
                <span>
                  <strong>{{ $t('common:inlineAgentChat.openingConversation') }}</strong>
                  <small>{{ $t('common:inlineAgentChat.recoveringLatestWorkingContext') }}</small>
                </span>
              </div>

              <section v-if="!hasConversation && (thread || (!loading && connectionBlocked))" class="inline-agent__welcome" :aria-label="$t('common:agentWorkspace.startConversation')">
                <div class="inline-agent__welcome-intro">
                  <p class="inline-agent__welcome-title">
                    <span class="inline-agent__welcome-line">{{ $t('common:agentWorkspace.welcomeIdentity') }}</span>
                    <em class="inline-agent__welcome-line">{{ $t('common:agentWorkspace.welcomeUtility') }}</em>
                  </p>
                  <p class="inline-agent__welcome-subtitle">{{ $t('common:agentWorkspace.welcomeSources') }}</p>
                </div>
                <div
                  class="inline-agent__starters"
                  role="group"
                  :aria-label="$t('common:agentWorkspace.starters')"
                  :aria-describedby="starterUnavailableReason ? starterReasonId : undefined"
                  :aria-busy="promptSubmissionPending"
                >
                  <v-btn
                    v-for="starter in starters"
                    :key="starter.prompt"
                    class="inline-agent__starter"
                    color="primary"
                    variant="text"
                    :aria-disabled="!canSubmit || promptSubmissionPending ? 'true' : undefined"
                    @click="sendStarter(starter.prompt)"
                  >
                    <span class="inline-agent__starter-heading">
                      <v-icon
                        :icon="starter.icon"
                        size="20"
                        aria-hidden="true"
                      />
                      <strong>{{ $t(starter.label) }}</strong>
                    </span>
                    <span class="inline-agent__starter-copy"><small>{{ $t(starter.description) }}</small></span>
                  </v-btn>
                  <p v-if="starterUnavailableReason" :id="starterReasonId" class="inline-agent__starter-reason" role="status">{{ starterUnavailableReason }}</p>
                </div>
              </section>

              <AgentThread
                v-else-if="thread"
                :thread="thread"
                :user-picture="userPicture"
                :image-editing-enabled="providerEnabled && mediaProfile?.media?.imageGeneration === true && mediaProfile?.media?.attachments === true && thread?.session.executionMode === 'agent'"
                :connection="connection"
                :deciding-approval-id="decidingApprovalId"
                :can-submit="canSubmit"
                :network-blocked="connectionBlocked"
                :google-search-suggestions="liveGoogleSearchSuggestions"
                @suggest="preparePrompt"
                @edit-image="composer?.editImage($event)"
                @reattach="media => void composer?.reattachMedia(media)"
                @ask-source="source => preparePrompt($t('common:inlineAgentChat.helpMeUnderstand', { title: source.title, interpolation: { escapeValue: false } }), source)"
                @decision="handleDecision"
              />
              <div ref="conversationDock" class="inline-agent__conversation-dock">
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
                  :aria-label="$t('common:inlineAgentChat.conversationNavigation')"
                >
                  <v-btn
                    v-if="approvalJumpVisible"
                    class="inline-agent__approval-jump"
                    color="warning"
                    variant="elevated"
                    prepend-icon="mdi-shield-alert-outline"
                    append-icon="mdi-arrow-down"
                    @click="jumpToApproval"
                  >{{ $t('common:inlineAgentChat.approvalRequired') }}</v-btn>
                  <v-btn
                    v-else
                    class="inline-agent__follow-jump"
                    color="primary"
                    variant="text"
                    :aria-label="$t('common:agentWorkspace.jumpLatest')"
                    @click="scrollToLatest"
                  >
                    <span class="inline-agent__follow-jump-frame">
                      <span class="inline-agent__follow-jump-face">
                        <v-icon icon="mdi-arrow-down" size="16" aria-hidden="true" />
                        <span>{{ $t('common:agentWorkspace.latest') }}</span>
                      </span>
                    </span>
                  </v-btn>
                </nav>

                <footer
                  class="inline-agent__composer"
                  :class="{ 'inline-agent__composer--scrolled': !transcriptFollowing, 'inline-agent__composer--focused': composerFocused }"
                  @focusin="handleComposerFocusIn"
                  @focusout="handleComposerFocusOut"
                  @keydown="handleComposerFocusIn"
                >
                  <div class="inline-agent__composer-inner">
                    <p
                      v-if="composerLockVisible"
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
                      <span>{{ $t('common:inlineAgentChat.pinningAvailableTabBut') }}</span>
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
                      :google-search-busy="googleSearchPending !== null"
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
                      :draft-editable="composerDraftEditable"
                      :external-description-id="composerLockVisible ? 'agent-composer-lock-reason' : undefined"
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
                          :current-page-title="pageTitle"
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
      v-if="!admissionBlocked"
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
    v-if="skillsEnabled && !admissionBlocked"
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
    :model-value="discardDraftOpen"
    :retain-focus="false"
    max-width="30rem"
    :aria-labelledby="discardDraftTitleId"
    :aria-describedby="discardDraftDescriptionId"
    @update:model-value="value => { if (!value) resolveDraftDiscard(false) }"
  >
    <v-card ref="discardDraftCard" rounded="xl">
      <v-card-title class="pt-5 px-5">
        <h2 :id="discardDraftTitleId" class="text-title-medium">{{ $t('common:agentWorkspace.discardDraftTitle') }}</h2>
      </v-card-title>
      <v-card-text class="px-5">
        <p :id="discardDraftDescriptionId">{{ $t('common:agentWorkspace.discardDraftBody') }}</p>
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="resolveDraftDiscard(false)">{{ $t('common:actions.cancel') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="sessionMutationBusy || connectionBlocked || !workspaceReady"
          @click="resolveDraftDiscard(true)"
        >{{ $t('common:agentWorkspace.discardDraftConfirm') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

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
          {{ clearUnfiledCommitted ? $t('common:agentWorkspace.clearRecentDone') : $t('common:agentWorkspace.clearRecentTitle') }}
        </h2>
      </v-card-title>
      <v-card-text class="px-5">
        <p v-if="clearUnfiledCommitted">{{ $t('common:agentWorkspace.clearRecentPartial') }}</p>
        <p v-else>{{ $t('common:agentWorkspace.clearRecentBody') }}</p>
        <v-alert v-if="connectionBlocked" class="mt-4" density="compact" type="warning" variant="tonal" role="status">
          <div class="inline-agent__initialization-error-content">
            <span>{{ $t('common:agentWorkspace.historyNeedsConnection') }}</span>
            <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :loading="connectionRetrying" :disabled="connectionRetrying" @click="retryAgentConnection">{{ $t('common:agentWorkspace.retryConnection') }}</v-btn>
          </div>
        </v-alert>
        <v-alert v-if="clearUnfiledError" class="mt-4" density="compact" type="error" variant="tonal" role="alert">
          {{ clearUnfiledError }}
        </v-alert>
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" :disabled="clearingUnfiledHistory || sessionMutationBusy" @click="closeClearUnfiledHistory">
          {{ clearUnfiledCommitted ? $t('common:actions.close') : $t('common:actions.cancel') }}
        </v-btn>
        <v-btn
          v-if="clearUnfiledCommitted"
          color="primary"
          prepend-icon="mdi-refresh"
          :loading="clearingUnfiledHistory"
          :disabled="clearingUnfiledHistory || sessionMutationBusy || connectionBlocked"
          @click="recoverClearUnfiledHistory"
        >
          {{ $t('common:agentWorkspace.retryOpening') }}
        </v-btn>
        <v-btn
          v-else
          color="error"
          variant="flat"
          :loading="clearingUnfiledHistory"
          :disabled="clearingUnfiledHistory || sessionMutationBusy || connectionBlocked"
          @click="clearUnfiledHistory"
        >
          {{ clearUnfiledError ? $t('common:agentWorkspace.retryClear') : $t('common:agentWorkspace.clearRecent') }}
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
import { wikiStore } from '../../store/index.ts'
import { resolveUserPicture } from '../../helpers/user-picture.ts'
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
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

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
  pageTitle?: string
}>()
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'return-search'): void
}>()
const agents = useAgentsStore()
const userPicture = computed(() => resolveUserPicture(wikiStore.user))
const { canPinCurrentChat, connection, decidingApprovalId, error, goalBusy, googleSearchPending, googleSearchSuggestions, initializationAdmissionFailure, loading, networkPaused, pinStorageAvailable, pinnedSessionId, profiles, sending, sessionMutationBusy, skills, skillsLoadError, skillsLoading, skillsPartial, thread, workspaceDisposed } = storeToRefs(agents)
const inlineAgentRoot = useTemplateRef<HTMLElement>('inlineAgentRoot')
const transcript = useTemplateRef<HTMLElement>('transcript')
const conversationDock = useTemplateRef<HTMLElement>('conversationDock')
const composer = useTemplateRef<{ focusInput: () => Promise<void>; focusSkillsTrigger: () => Promise<void>; setDraft: (value: string) => Promise<void>; editImage: (media: AgentMediaView) => Promise<void>; reattachMedia: (media: AgentMediaView) => Promise<boolean>; hasUnsentMedia: () => boolean; isMediaBusy: () => boolean }>('composer')
type ComponentRoot = { $el?: unknown }
const historyTrigger = useTemplateRef<ComponentRoot | HTMLElement>('historyTrigger')
const memoryTrigger = useTemplateRef<ComponentRoot | HTMLElement>('memoryTrigger')
const panelMenuTrigger = useTemplateRef<ComponentRoot | HTMLElement>('panelMenuTrigger')
const historyPanel = useTemplateRef<HTMLElement>('historyPanel')
const memoryPanel = useTemplateRef<HTMLElement>('memoryPanel')
const panelScrim = useTemplateRef<HTMLElement>('panelScrim')
const discardDraftCard = useTemplateRef<ComponentRoot>('discardDraftCard')
const panelIdPrefix = useId()
const workspaceTitleId = `${panelIdPrefix}-workspace-title`
const historyHeadingId = `${panelIdPrefix}-history-title`
const historyDescriptionId = `${panelIdPrefix}-history-description`
const memoryHeadingId = `${panelIdPrefix}-memory-title`
const memoryDescriptionId = `${panelIdPrefix}-memory-description`
const discardDraftTitleId = `${panelIdPrefix}-discard-draft-title`
const discardDraftDescriptionId = `${panelIdPrefix}-discard-draft-description`
const goalExpanded = ref(false)
const approvalJumpVisible = ref(false)
const skillManagerOpen = ref(false)
const clearUnfiledHistoryOpen = ref(false)
const discardDraftOpen = ref(false)
let draftDiscardResolver: ((discard: boolean) => void) | null = null
let draftDiscardFocusScope: ModalFocusScope | null = null
let restoreDiscardDraftFocus = false
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
const providerMenuOpen = ref(false)
const providerSelectionPending = ref(false)
let providerSelectionGeneration = 0
const memoryMutationBusy = ref(false)
const initializationError = ref('')
const connectionRetrying = ref(false)
const waitingForConnection = ref(false)
const offlineComposerDraft = ref('')
const offlineSessionId = 'offline-agent-draft'
const composerFocused = ref(false)
let transcriptReadingIntent = false
const handleComposerFocusIn = (): void => {
  composerFocused.value = true
  transcriptReadingIntent = false
}
const handleComposerFocusOut = (event: FocusEvent): void => {
  const nextTarget = event.relatedTarget
  const currentTarget = event.currentTarget
  if (!(currentTarget instanceof HTMLElement) || !(nextTarget instanceof Node) || !currentTarget.contains(nextTarget)) composerFocused.value = false
}
const handleTranscriptEngagement = (event: FocusEvent | PointerEvent | WheelEvent | TouchEvent | KeyboardEvent): void => {
  const target = event.target
  if (target instanceof Element && target.closest('.inline-agent__composer')) return
  transcriptReadingIntent = true
  composerFocused.value = false
}
const transcriptFollowing = ref(true)
const transcriptBottomDistance = ref(0)
let transcriptObserver: MutationObserver | null = null
let dockObserver: ResizeObserver | null = null
let transcriptFrame: number | null = null
let transcriptFrameShouldFollow = false
let transcriptGrowthPending = false
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
const starterReasonId = `${panelIdPrefix}-starter-reason`
const sendStarter = (prompt: string): void => {
  if (!canSubmit.value || promptSubmissionPending.value) return
  void sendPrompt(prompt)
}

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
const followJumpVisible = computed(() => Boolean(hasConversation.value && transcriptBottomDistance.value > 24 && !approvalJumpVisible.value))
const pendingApprovalId = computed(() => thread.value?.proposals.find(proposal => proposal.status === 'pending' && proposal.approval?.status === 'pending')?.id ?? null)
const mediaProfile = computed(() => thread.value?.session.providerProfileId ? profiles.value.find(profile => profile.id === thread.value?.session.providerProfileId) : profiles.value.find(profile => profile.isGlobalDefault) ?? (profiles.value.length === 1 ? profiles.value[0] : undefined))
const providerIdentity = computed(() => mediaProfile.value
  ? t('common:inlineAgentChat.providerIdentity', { name: mediaProfile.value.name, model: mediaProfile.value.model, interpolation: { escapeValue: false } })
  : '')
const googleSearchAvailable = computed(() => Boolean(thread.value && thread.value.session.executionMode === 'agent' && mediaProfile.value?.googleSearchAvailable === true))
/* Optimistic while the Web toggle request is in flight, so the button state
   is truthful immediately and the global session mutation lock stays free. */
const googleSearchEnabled = computed(() => googleSearchPending.value !== null ? googleSearchPending.value : thread.value?.session.googleSearchEnabled === true)
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
const admissionBlocked = computed(() => initializationAdmissionFailure.value !== null)
const admissionRequiredMessage = computed(() => t(initializationAdmissionFailure.value === 'authentication'
  ? 'common:agentWorkspace.authenticationRequiredMessage'
  : 'common:agentWorkspace.admissionRequiredMessage'))
const serverConnectionUnavailable = computed(() =>
  pwaState.connectionState === 'offline' ||
  pwaState.connectionState === 'server-unavailable'
)
const connectionBlocked = computed(() => !admissionBlocked.value && (
  serverConnectionUnavailable.value ||
  waitingForConnection.value ||
  (networkPaused.value && !workspaceDisposed.value && !loading.value)
))
const connectionRequiredMessage = computed(() => {
  if (pwaState.connectionState === 'server-unavailable') return t('common:inlineAgentChat.connectionRequiredServerUnavailable')
  if (pwaState.connectionState === 'offline') return t('common:inlineAgentChat.connectionRequiredYouAppear')
  return t('common:inlineAgentChat.connectionRequiredReconnectContinue')
})
const providerUnavailableMessage = computed(() => props.providerEnabled
  ? t('common:inlineAgentChat.noEnabledProviderProfile')
  : t('common:inlineAgentChat.agentInferenceCurrentlyDisabled'))
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
/* While a reply streams, the user may draft the next message; only sending waits. */
const composerDraftEditable = computed(() =>
  Boolean(thread.value) &&
  workspaceReady.value &&
  !connectionBlocked.value &&
  !loading.value &&
  !mediaRefreshing.value &&
  (sending.value || promptSubmissionPending.value || Boolean(activeRun.value))
)
const goalSubmitUnavailableReason = computed(() => !openGoal.value
  ? ''
  : openGoal.value.status === 'paused'
    ? t('common:inlineAgentChat.resumeCancelCurrentGoal')
    : t('common:inlineAgentChat.finishCancelCurrentGoal'))
/* The session-mutation lock message is delayed briefly: a quick mutation
   (Web search toggle, temporary toggle) resolves within the delay and never
   flashes "Wait for the current conversation update to finish". Longer
   mutations keep the normal immediate disable behavior; only the message
   waits. */
const mutationLockMessageVisible = ref(false)
let mutationLockMessageTimer: ReturnType<typeof setTimeout> | null = null
watch(sessionMutationBusy, busy => {
  if (busy) {
    if (mutationLockMessageTimer === null) {
      mutationLockMessageTimer = setTimeout(() => {
        mutationLockMessageTimer = null
        mutationLockMessageVisible.value = true
      }, 300)
    }
  } else {
    if (mutationLockMessageTimer !== null) {
      clearTimeout(mutationLockMessageTimer)
      mutationLockMessageTimer = null
    }
    mutationLockMessageVisible.value = false
  }
}, { immediate: true })
const composerLockVisible = computed(() => Boolean(openGoal.value) || mutationLockMessageVisible.value)
const submitUnavailableReason = computed(() => admissionBlocked.value
  ? admissionRequiredMessage.value
  : connectionBlocked.value
  ? connectionRequiredMessage.value
  : !providerAvailable.value
    ? providerUnavailableMessage.value
    : !workspaceReady.value
      ? t('common:inlineAgentChat.reauthorizingConversation')
      : loading.value
        ? t('common:inlineAgentChat.openingConversation')
        : initializationError.value
          ? t('common:inlineAgentChat.requestedConversationCouldNot')
          : sending.value
            ? t('common:inlineAgentChat.sendingMessage')
            : sessionMutationBusy.value
              ? t('common:inlineAgentChat.waitCurrentConversationUpdate')
              : activeRun.value
                ? t('common:inlineAgentChat.waitCurrentResponseFinish')
                : openGoal.value
                  ? goalSubmitUnavailableReason.value
                  : '')
const starterUnavailableReason = computed(() => promptSubmissionPending.value
  ? t('common:inlineAgentChat.sendingMessage')
  : !canSubmit.value ? submitUnavailableReason.value : '')
const providerSelectionUnavailableReason = computed(() => {
  if (composer.value?.isMediaBusy() || mediaRefreshing.value) return t('common:inlineAgentChat.providerWaitForMedia')
  if (composer.value?.hasUnsentMedia()) return t('common:inlineAgentChat.providerRemoveAttachments')
  if (providerSelectionPending.value) return t('common:inlineAgentChat.providerChanging')
  if (promptSubmissionPending.value) return t('common:inlineAgentChat.sendingMessage')
  if (creatingRetention.value || keepingConversation.value || googleSearchPending.value !== null) return t('common:inlineAgentChat.waitCurrentConversationUpdate')
  return canSubmit.value ? '' : submitUnavailableReason.value || t('common:inlineAgentChat.providerConversationRequired')
})
const selectProvider = async (providerProfileId: string | null): Promise<void> => {
  if (!networkActionAllowed() || providerSelectionUnavailableReason.value || !thread.value) return
  if (providerProfileId !== null && !profiles.value.some(profile => profile.id === providerProfileId)) return
  if ((thread.value.session.providerProfileId ?? null) === providerProfileId) { providerMenuOpen.value = false; return }
  const generation = componentGeneration
  const selectionGeneration = ++providerSelectionGeneration
  const ownerId = props.ownerId
  const sessionId = thread.value.session.id
  const workspaceVersion = agents.workspaceVersion
  const ownerGeneration = agents.ownerGeneration
  const isSelectionCurrent = (): boolean => isComponentCurrent(generation, ownerId) &&
    providerSelectionGeneration === selectionGeneration && thread.value?.session.id === sessionId &&
    agents.workspaceVersion === workspaceVersion && agents.ownerGeneration === ownerGeneration
  providerSelectionPending.value = true
  providerMenuOpen.value = false
  try {
    const updated = await agents.setProfile(providerProfileId)
    if (!isSelectionCurrent() || !updated || (thread.value?.session.providerProfileId ?? null) !== providerProfileId) return
    setSessionNotice(t('common:inlineAgentChat.providerChanged', { identity: providerIdentity.value, interpolation: { escapeValue: false } }))
  } catch (value) {
    if (isSelectionCurrent()) agents.error = value instanceof Error ? value.message : t('common:inlineAgentChat.providerChangeFailed')
  } finally {
    if (providerSelectionGeneration === selectionGeneration) providerSelectionPending.value = false
  }
}
watch([
  () => props.ownerId,
  () => currentPage.value?.id,
  () => currentPage.value?.locale,
  () => thread.value?.session.id,
  () => agents.workspaceVersion,
  () => agents.ownerGeneration,
  () => workspaceDisposed.value
], () => {
  providerMenuOpen.value = false
  providerSelectionPending.value = false
  providerSelectionGeneration += 1
}, { flush: 'sync' })
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
const sessionTitle = computed(() => thread.value?.session.title || (isTemporary.value ? t('common:inlineAgentChat.temporaryChat') : t('common:inlineAgentChat.newChat')))

const connectionLabel = computed(() => admissionBlocked.value
  ? t('common:inlineAgentChat.tryAgain')
  : connectionBlocked.value
  ? t('common:inlineAgentChat.connectionRequired')
  : loading.value
    ? t('common:inlineAgentChat.opening')
    : connection.value === 'reconnecting'
      ? t('common:inlineAgentChat.reconnecting')
      : !providerAvailable.value
        ? t('common:inlineAgentChat.unavailable')
        : Boolean(initializationError.value)
          ? t('common:inlineAgentChat.tryAgain')
          : Boolean(error.value)
            ? t('common:inlineAgentChat.tryAgain')
            : activeRun.value?.status === 'awaiting_approval'
              ? t('common:inlineAgentChat.reviewNeeded')
              : sending.value
                ? t('common:inlineAgentChat.sending')
                : activeRun.value
                  ? t('common:inlineAgentChat.working')
                  : t('common:inlineAgentChat.ready'))
const connectionTone = computed<'ready' | 'error' | 'busy'>(() => connectionBlocked.value || !providerAvailable.value || Boolean(error.value) || Boolean(initializationError.value)
  ? 'error'
  : loading.value || connection.value === 'reconnecting' || sending.value || Boolean(activeRun.value)
    ? 'busy'
    : 'ready')
const activeDraft = computed(() => thread.value ? agents.drafts[thread.value.session.id] ?? emptyAgentDraft() : emptyAgentDraft())
const currentPageIncluded = computed(() => Boolean(currentPage.value && activeDraft.value.includeCurrentPage))
/* Labels and descriptions are locale keys; prompts are model input and stay as written. */
const starters = computed(() => [
  ...(currentPageIncluded.value
    ? [{ label: 'common:agentWorkspace.starterPage', description: 'common:agentWorkspace.starterPageHint', prompt: t('common:inlineAgentChat.summarizeCurrentWikiPage'), icon: 'mdi-text-box-search-outline' }]
    : [{ label: 'common:agentWorkspace.starterExplore', description: 'common:agentWorkspace.starterExploreHint', prompt: t('common:inlineAgentChat.giveMeOverviewMain'), icon: 'mdi-compass-outline' }]),
  { label: 'common:agentWorkspace.starterConnect', description: 'common:agentWorkspace.starterConnectHint', prompt: currentPageIncluded.value ? t('common:inlineAgentChat.findWikiPagesRelated') : t('common:inlineAgentChat.helpMeExploreConnections'), icon: 'mdi-vector-link' },
  { label: 'common:agentWorkspace.starterCatchUp', description: 'common:agentWorkspace.starterCatchUpHint', prompt: t('common:inlineAgentChat.summarize10MostRecently'), icon: 'mdi-history' }
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
      if (sources.length >= 8) { agents.error = t('common:inlineAgentChat.eightSourcesAlreadyAttached'); return }
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
      : t('common:inlineAgentChat.conversationCouldNotOpened')
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
  if (admissionBlocked.value && !request.forceFresh) return Promise.resolve(false)
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
        if (admissionBlocked.value) waitingForConnection.value = false
        initializationError.value = admissionBlocked.value ? admissionRequiredMessage.value : error.value || t('common:inlineAgentChat.conversationCouldNotOpened2')
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
  if (disposed || connectionRetrying.value || admissionBlocked.value) return
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
  if (!initializationError.value && !admissionBlocked.value) return
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
    transcriptReadingIntent = false
    transcriptFollowing.value = true
    const success = await agents.send(prompt, invokedSkillVersionIds, mode, media)
    if (!isComponentCurrent(componentGeneration, ownerId) || promptGeneration !== generation) return false
    completion?.(success)
    if (success) await reconcileTranscriptGrowth(true)
    return success
  } catch (value) {
    if (!isComponentCurrent(componentGeneration, ownerId) || promptGeneration !== generation) return false
    agents.error = value instanceof Error ? value.message : t('common:inlineAgentChat.messageCouldNotSent')
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
  if (!disposed && !connectionBlocked.value && agents.isWorkspaceMutationReady()) void agents.stop()
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
  handleTranscriptScroll()
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
    setSessionNotice(hasConversation.value ? t('common:inlineAgentChat.conversationKeptHistory') : t('common:inlineAgentChat.conversationKeptWillAppear'))
  } catch (value) {
    if (isComponentCurrent(generation, ownerId) && actionGeneration === generation)
      agents.error = value instanceof Error ? value.message : t('common:inlineAgentChat.conversationCouldNotKept')
  } finally {
    if (isComponentCurrent(generation, ownerId) && actionGeneration === generation) keepingConversation.value = false
  }
}
const mediaReplacementAllowed = (): boolean => {
  if (!composer.value?.isMediaBusy()) return true
  panelMenuOpen.value = false
  setSessionNotice(t('common:agentWorkspace.waitForMediaBeforeNewChat'))
  return false
}
const hasDisposableDraft = (): boolean => {
  const current = thread.value
  if (!current || current.messages.length > 0 || current.session.currentRun || current.goal || current.session.folderId) return false
  const draft = activeDraft.value
  return Boolean(
    draft.text || offlineComposerDraft.value || draft.sources.length || draft.skillVersionIds.length ||
    draft.mode !== 'message' || draft.scope.kind !== 'all' || !draft.includeCurrentPage || composer.value?.hasUnsentMedia()
  )
}
const resolveDraftDiscard = (discard: boolean, restoreFocus = true): void => {
  if (discard && (sessionMutationBusy.value || !networkActionAllowed() || !mediaReplacementAllowed())) return
  const resolve = draftDiscardResolver
  draftDiscardResolver = null
  restoreDiscardDraftFocus = !discard && restoreFocus
  discardDraftOpen.value = false
  resolve?.(discard)
}
const confirmDraftDiscard = (): Promise<boolean> => new Promise(resolve => {
  panelMenuOpen.value = false
  restoreDiscardDraftFocus = false
  draftDiscardResolver = resolve
  discardDraftOpen.value = true
})
const createSession = async (retention: 'saved' | 'temporary'): Promise<void> => {
  if (!networkActionAllowed()) return
  if (sessionMutationBusy.value || creatingRetention.value) return
  if (!mediaReplacementAllowed()) return
  const generation = componentGeneration
  const action = actionGeneration
  const ownerId = props.ownerId
  const workspaceVersion = agents.workspaceVersion
  const ownerGeneration = agents.ownerGeneration
  const sessionId = thread.value?.session.id ?? null
  const isCreateContextCurrent = (): boolean =>
    isComponentCurrent(generation, ownerId) && actionGeneration === action &&
    agents.workspaceVersion === workspaceVersion && agents.ownerGeneration === ownerGeneration &&
    (thread.value?.session.id ?? null) === sessionId
  creatingRetention.value = retention
  try {
    if (hasDisposableDraft() && !await confirmDraftDiscard()) return
    if (!isCreateContextCurrent() || sessionMutationBusy.value || !networkActionAllowed() || !mediaReplacementAllowed()) return
    const initialized = await ensureInitialized()
    if (!isCreateContextCurrent() || !initialized || sessionMutationBusy.value || !networkActionAllowed() || !mediaReplacementAllowed()) return
    clearSessionNotice()
    const created = await agents.newSession(retention)
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== action) return
    if (created && thread.value?.session.retention === retention) {
      offlineComposerDraft.value = ''
      await nextTick()
      if (!isComponentCurrent(generation, ownerId) || actionGeneration !== action) return
      await composer.value?.focusInput()
    }
  } catch (value) {
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== action) return
    const kind = retention === 'temporary' ? t('common:inlineAgentChat.temporaryConversation') : t('common:inlineAgentChat.newSavedConversation')
    agents.error = value instanceof Error ? value.message : t('common:inlineAgentChat.couldNotCreated', { kind, interpolation: { escapeValue: false } })
  } finally {
    if (isComponentCurrent(generation, ownerId) && actionGeneration === action) creatingRetention.value = null
  }
}
const newTemporarySession = (): Promise<void> => createSession('temporary')
const startTemporaryChat = (): Promise<void> => newTemporarySession()
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
  const usePanelMenu = kind === 'memory' && window.matchMedia(mobilePanelQuery).matches
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
  if (open && (connectionBlocked.value || admissionBlocked.value)) return
  if (open) memoryOpen.value = true
  else closeMemory()
}
const historyToggleBlocked = computed(() => memoryMutationBusy.value && memoryOpen.value && panelMode.value !== 'wide')
const requestClose = (): void => {
  if (memoryMutationBusy.value) return
  emit('close')
}
const toggleHistory = (): void => {
  if (historyToggleBlocked.value) return
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
        ? t('common:inlineAgentChat.savedFoldersTheirFiled', { value: error.value, interpolation: { escapeValue: false } })
        : t('common:inlineAgentChat.recentConversationsWereCleared')
      return
    }
    clearUnfiledHistoryOpen.value = false
  } catch (value) {
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
    const detail = value instanceof Error ? value.message : t('common:inlineAgentChat.tryAgain2')
    clearUnfiledError.value = t('common:inlineAgentChat.recentConversationsCouldNot', { detail, interpolation: { escapeValue: false } })
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
      const detail = refreshed.error instanceof Error ? refreshed.error.message : t('common:inlineAgentChat.historyCouldNotRefreshed')
      throw new Error(detail)
    }
    if (!thread.value) {
      const candidate = agents.sessions.find(session => !session.deletedAt)
      if (!candidate || !await agents.openSession(candidate.id)) throw new Error(t('common:inlineAgentChat.noReplacementConversationAvailable'))
      if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
    }
    clearUnfiledHistoryOpen.value = false
    clearUnfiledError.value = ''
    clearUnfiledCommitted.value = false
  } catch (value) {
    if (!isComponentCurrent(generation, ownerId) || actionGeneration !== generation) return
    const detail = value instanceof Error ? value.message : t('common:inlineAgentChat.replacementConversationCouldNot')
    clearUnfiledError.value = t('common:inlineAgentChat.recentConversationsWereCleared2', { detail, interpolation: { escapeValue: false } })
  } finally {
    if (isComponentCurrent(generation, ownerId) && actionGeneration === generation) clearingUnfiledHistory.value = false
  }
}
const updateApprovalJump = (container: HTMLElement, dockBounds: DOMRect | undefined): void => {
  const proposalId = pendingApprovalId.value
  if (!proposalId) { approvalJumpVisible.value = false; return }
  const approval = container.querySelector<HTMLElement>(`#agent-approval-${proposalId}`)
  if (!approval) { approvalJumpVisible.value = false; return }
  const viewport = container.getBoundingClientRect()
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
  transcriptReadingIntent = true
  transcriptFollowing.value = false
  transcriptFrameShouldFollow = false
  approval.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' })
  await nextTick()
  if (!approval.isConnected || !transcript.value?.contains(approval)) return
  approval.focus({ preventScroll: true })
  approvalJumpVisible.value = false
  handleTranscriptScroll()
}
let transcriptScrollTopMemory = 0
const handleTranscriptScroll = (): void => {
  scheduleTranscriptFrame()
}
const reconcileTranscriptGrowth = async (shouldFollow: boolean): Promise<void> => {
  await nextTick()
  if (disposed) return
  transcriptGrowthPending = true
  transcriptFrameShouldFollow ||= shouldFollow
  scheduleTranscriptFrame()
}
const handleGoalExpanded = async (expanded: boolean): Promise<void> => {
  const shouldFollow = shouldFollowGoalExpansion(expanded, transcriptFollowing.value, transcriptBottomDistance.value < 160)
  goalExpanded.value = expanded
  await reconcileTranscriptGrowth(shouldFollow)
}
const scheduleTranscriptFrame = (): void => {
  if (disposed || transcriptFrame !== null) return
  transcriptFrame = window.requestAnimationFrame(() => {
    transcriptFrame = null
    if (disposed) return
    const container = transcript.value
    const shouldFollow = transcriptFrameShouldFollow
    const growthPending = transcriptGrowthPending
    transcriptFrameShouldFollow = false
    transcriptGrowthPending = false
    if (!container) { approvalJumpVisible.value = false; return }

    // Scroll bursts, content growth and dock resizing share one layout pass.
    const scrollHeight = container.scrollHeight
    const clientHeight = container.clientHeight
    const scrollTop = container.scrollTop
    const distance = Math.max(0, scrollHeight - scrollTop - clientHeight)
    // Keyboard resizing can change the distance without moving the viewport.
    if (scrollTop > transcriptScrollTopMemory + 1 && distance > transcriptBottomDistance.value + 1) composerFocused.value = false
    transcriptBottomDistance.value = distance
    if (distance < 160) transcriptFollowing.value = true
    else if (scrollTop < transcriptScrollTopMemory - 1 && transcriptReadingIntent) transcriptFollowing.value = false
    const restoreFollowing = transcriptFollowing.value && !transcriptReadingIntent && scrollTop < transcriptScrollTopMemory - 1
    transcriptScrollTopMemory = scrollTop

    if ((growthPending || restoreFollowing) && (!hasConversation.value || ((shouldFollow || restoreFollowing) && transcriptFollowing.value))) {
      const top = !hasConversation.value && !(window.matchMedia(mobilePanelQuery).matches && composerFocused.value)
        ? 0
        : Math.max(0, scrollHeight - clientHeight)
      container.scrollTo({ top, behavior: 'auto' })
      transcriptFollowing.value = true
      transcriptScrollTopMemory = top
      transcriptBottomDistance.value = Math.max(0, scrollHeight - top - clientHeight)
    }
    const dockBounds = conversationDock.value?.getBoundingClientRect()
    container.style.setProperty('--agent-dock-height', `${dockBounds?.height ?? 0}px`)
    updateApprovalJump(container, dockBounds)
  })
}
const scheduleTranscriptReconcile = (): void => {
  transcriptGrowthPending = true
  transcriptFrameShouldFollow ||= transcriptFollowing.value
  scheduleTranscriptFrame()
}
const observeTranscript = (container: HTMLElement | null): void => {
  transcriptObserver?.disconnect()
  if (container) transcriptObserver?.observe(container, { childList: true, subtree: true, characterData: true })
  transcriptScrollTopMemory = container?.scrollTop ?? 0
  scheduleTranscriptReconcile()
}
const observeConversationDock = (dock: HTMLElement | null): void => {
  dockObserver?.disconnect()
  if (dock) dockObserver?.observe(dock, { box: 'border-box' })
  scheduleTranscriptReconcile()
}

watch(transcript, observeTranscript, { flush: 'post' })
watch(conversationDock, observeConversationDock, { flush: 'post' })
watch(() => {
  const messages = thread.value?.messages ?? []
  const response = messages.findLast(message => message.role === 'assistant' && (message.content || message.media?.length))
  return [thread.value?.session.id, response?.id, response?.status === 'complete'] as const
}, ([sessionId, responseId, complete], previous) => {
  // A new session starts at the latest answer. An arriving answer must not
  // pull a reader away from earlier messages, including during streaming.
  if (sessionId !== previous[0]) transcriptFollowing.value = true
  if (sessionId !== previous[0] || (responseId && (responseId !== previous[1] || (complete && !previous[2])))) {
    void reconcileTranscriptGrowth(transcriptFollowing.value)
  }
}, { flush: 'post' })
watch(networkPaused, paused => {
  if (!paused && pwaState.connectionState === 'online') waitingForConnection.value = false
})
watch(admissionBlocked, blocked => {
  if (!blocked) return
  waitingForConnection.value = false
  memoryOpen.value = false
  skillManagerOpen.value = false
})
watch(() => pwaState.connectionState, state => {
  if (state === 'offline' || state === 'server-unavailable') {
    waitingForConnection.value = true
    agents.pauseNetwork()
    return
  }
  if (state !== 'online' || !waitingForConnection.value || admissionBlocked.value) return
  void retryAgentConnection()
})
watch(() => props.ownerId, (ownerId, previousOwnerId) => {
  if (disposed || ownerId === previousOwnerId) return
  componentGeneration += 1
  retryGeneration += 1
  promptGeneration += 1
  actionGeneration += 1
  resolveDraftDiscard(false, false)
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
  resolveDraftDiscard(false, false)
  promptSubmissionPending.value = false
  connectionRetrying.value = false
  keepingConversation.value = false
  creatingRetention.value = null
  clearingUnfiledHistory.value = false
  void ensureInitialized({ forceFresh: true })
}, { flush: 'post' })
const handlePageHide = (): void => { agents.closeWorkspace() }
const handlePageShow = (event: PageTransitionEvent): void => {
  if (event.persisted) void ensureInitialized({ forceFresh: true })
}
// A screen sleep/wake (or browser process restore) while the composer is focused
// can drop the keyboard pan and shift the document, hiding the input behind the
// keyboard again. Re-anchor the composer and the transcript once visible.
const handleComposerWake = (): void => {
  if (document.visibilityState !== 'visible' || !composerFocused.value) return
  scheduleTranscriptReconcile()
  void nextTick(() => {
    const composerEl = inlineAgentRoot.value instanceof HTMLElement
      ? inlineAgentRoot.value.querySelector<HTMLElement>('.inline-agent__composer')
      : null
    composerEl?.scrollIntoView({ block: 'end', behavior: 'auto' })
  })
}
document.addEventListener('visibilitychange', handleComposerWake)
watch(skillManagerOpen, (open, wasOpen) => {
  if (!open && wasOpen) void nextTick(() => composer.value?.focusSkillsTrigger())
})
watch(discardDraftOpen, async (open, _previous, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  await nextTick()
  if (cancelled || disposed) return
  if (!open) {
    draftDiscardFocusScope?.deactivate({ restoreFocus: restoreDiscardDraftFocus })
    draftDiscardFocusScope = null
    restoreDiscardDraftFocus = false
    return
  }
  const root = componentElement(discardDraftCard.value)
  if (!root) return
  draftDiscardFocusScope?.deactivate({ restoreFocus: false })
  draftDiscardFocusScope = createModalFocusScope({
    root,
    restoreTarget: () => inlineAgentRoot.value?.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea') ?? null,
    additionalRoots: () => {
      // The native scrim owns backdrop dismissal; do not inert it with the background.
      const scrim = root.closest('.v-overlay')?.querySelector<HTMLElement>(':scope > .v-overlay__scrim')
      return scrim ? [scrim] : []
    },
    onEscape: () => resolveDraftDiscard(false)
  })
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
  if (sessionId !== previousSessionId) {
    resolveDraftDiscard(false, false)
    goalExpanded.value = false
    clearSessionNotice()
  }
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
  handleTranscriptScroll()
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
  dockObserver = new ResizeObserver(scheduleTranscriptReconcile)
  observeConversationDock(conversationDock.value)
  window.addEventListener('resize', scheduleTranscriptReconcile)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('pageshow', handlePageShow)
  window.visualViewport?.addEventListener('resize', scheduleTranscriptReconcile)
  document.addEventListener('visibilitychange', handleComposerWake)
  void ensureInitialized()
})
onBeforeUnmount(() => {
  disposed = true
  componentGeneration += 1
  retryGeneration += 1
  promptGeneration += 1
  actionGeneration += 1
  resolveDraftDiscard(false, false)
  draftDiscardFocusScope?.deactivate({ restoreFocus: false })
  initializationEpoch += 1
  initialization = null
  initializationKey = ''
  transcriptObserver?.disconnect()
  dockObserver?.disconnect()
  if (transcriptFrame !== null) window.cancelAnimationFrame(transcriptFrame)
  transcriptFrame = null
  panelFocusScope?.deactivate({ restoreFocus: false })
  if (sessionNoticeTimer !== null) { clearTimeout(sessionNoticeTimer); sessionNoticeTimer = null }
  if (mutationLockMessageTimer !== null) { clearTimeout(mutationLockMessageTimer); mutationLockMessageTimer = null }
  panelModeMedia.forEach(media => media.removeEventListener('change', reconcilePanelMode))
  window.removeEventListener('resize', scheduleTranscriptReconcile)
  window.removeEventListener('pagehide', handlePageHide)
  window.removeEventListener('pageshow', handlePageShow)
  window.visualViewport?.removeEventListener('resize', scheduleTranscriptReconcile)
  document.removeEventListener('visibilitychange', handleComposerWake)
  agents.closeWorkspace()
})
defineExpose({ sendPrompt, preparePrompt, focusComposer, focusConversation, scrollToLatest })
</script>

<style scoped lang="scss">
.inline-agent {
  --agent-conversation-width: 56rem;
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-height: 0;
  margin-inline: auto;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-body);
  background: var(--wiki-surface-raised);
  isolation: isolate;
  text-align: start;
}
.inline-agent:dir(rtl), .inline-agent:lang(ar) { font-family: 'Tajawal', var(--wiki-font-body); }
.inline-agent :deep(.v-btn), .inline-agent :deep(.v-list), .inline-agent :deep(.v-card), .inline-agent :deep(.v-toolbar), .inline-agent :deep(.v-input) { font-family: inherit; }
.inline-agent :deep(.v-btn) { border-radius: var(--wiki-control-radius); text-transform: none; letter-spacing: normal; }
.inline-agent__card, .inline-agent__side { height: 100%; min-height: 0; min-width: 0; }
.inline-agent__card {
  container: agent-workspace / inline-size;
  position: relative;
  display: flex;
  grid-column: 1;
  grid-row: 1;
  flex-direction: column;
  overflow: hidden;
  border-radius: 0 !important;
  background: var(--wiki-surface-raised);
  box-shadow: none;
}
.inline-agent__toolbar {
  flex: 0 0 auto;
  min-height: var(--wiki-chrome-height, 4rem);
  padding-inline: var(--wiki-space-4);
  border-bottom: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-raised) !important;
}
.inline-agent__toolbar :deep(.v-toolbar__content) { height: auto !important; min-height: inherit; flex-wrap: wrap; gap: var(--wiki-space-2); padding-block: var(--wiki-space-2); }
.inline-agent__toolbar-main { display: flex; align-items: center; gap: var(--wiki-space-4); flex: 1 1 24rem; min-width: 0; }
.inline-agent__mobile-navigation { display: flex; flex: 0 0 auto; gap: var(--wiki-space-1); }
.inline-agent__toolbar :deep(.v-btn) { min-height: 44px; }
.inline-agent__history-toggle[aria-expanded='true'], .inline-agent__memory-toggle[aria-expanded='true'] { background: var(--wiki-surface-sunken); color: var(--wiki-primary-ink); }
.inline-agent__history-toggle[aria-disabled='true'], .inline-agent__memory-toggle[aria-disabled='true'], .inline-agent__close-action[aria-disabled='true'] { opacity: .6; }
.inline-agent__identity, .inline-agent__heading { min-width: 0; }
.inline-agent__heading h2 { margin: 0; font: 700 .9rem/1.4 var(--wiki-font-body); }
.inline-agent__session-line { display: flex; align-items: center; flex-wrap: wrap; gap: var(--wiki-space-2); min-width: 0; }
.inline-agent__session-title { max-width: 24rem; min-width: 0; font-size: .85rem; color: var(--wiki-text-muted); overflow-wrap: anywhere; }
.inline-agent__pin-indicator { color: var(--wiki-primary-ink); }
.inline-agent__provider-trigger { max-width: 100%; min-width: 0; height: auto !important; color: rgb(var(--v-theme-on-surface)); padding-inline: var(--wiki-space-2); }
.inline-agent__provider-trigger :deep(.v-btn__content) { min-width: 0; gap: var(--wiki-space-2); }
.inline-agent__provider-identity { max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .8rem; }
.inline-agent__model-label { order: -1; color: var(--wiki-text-muted); font-size: .75rem; }
.inline-agent__provider-help { margin: 0; max-width: 28rem; padding: var(--wiki-space-3); color: var(--wiki-text-muted); font-size: .8rem; }
.inline-agent__panel-actions { display: flex; align-items: center; gap: var(--wiki-space-1); margin-inline-start: auto; flex-wrap: wrap; }
.inline-agent__actions-divider { width: 1px; height: 24px; margin-inline: var(--wiki-space-1); background: var(--wiki-surface-border); }
.inline-agent__panel-menu-item { min-height: 44px; }
.inline-agent__commandbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--wiki-space-2); padding: var(--wiki-space-2) var(--wiki-space-4); border-bottom: 1px solid var(--wiki-surface-border); background: var(--wiki-surface-sunken); }
.inline-agent__history-scope { color: var(--wiki-text-muted); padding-inline-start: var(--wiki-space-2); border-inline-start: 1px solid var(--wiki-surface-border-strong); }
.inline-agent__execution-state { display: flex; align-items: center; gap: var(--wiki-space-2); min-width: 0; margin: 0; font-size: .8rem; overflow-wrap: anywhere; }
.inline-agent__session-controls { display: flex; flex-wrap: wrap; gap: var(--wiki-space-1); margin-inline-start: auto; }
.inline-agent__session-controls :deep(.v-btn) { min-height: 36px; }
.inline-agent__progress { flex: 0 0 auto; }
.inline-agent__retention { display: flex; align-items: start; gap: var(--wiki-space-3); padding: var(--wiki-space-3) var(--wiki-space-4); border-bottom: 1px solid var(--wiki-surface-border); background: var(--wiki-surface-sunken); }
.inline-agent__retention-copy { min-width: 0; }
.inline-agent__retention strong { font-size: .85rem; }
.inline-agent__retention p { margin: var(--wiki-space-1) 0 0; font-size: .8rem; color: var(--wiki-text-muted); line-height: 1.5; }
.inline-agent__session-notice { margin: 0; padding: var(--wiki-space-3) var(--wiki-space-4); background: var(--wiki-surface-sunken); color: var(--wiki-primary-ink); font-size: .85rem; }
.inline-agent__body { display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; overflow: hidden; background: var(--wiki-surface-raised); }
.inline-agent__alert { flex: 0 0 auto; margin: var(--wiki-space-3) var(--wiki-space-4) 0; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); }
.inline-agent__initialization-error-content { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--wiki-space-2); }
.inline-agent__transcript-wrap { position: relative; display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; overflow: hidden; container-type: size; }
.inline-agent__transcript {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  padding: var(--wiki-space-5) clamp(var(--wiki-space-3), 3vw, var(--wiki-space-8)) 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scroll-padding-block: var(--wiki-space-4);
  scroll-padding-block-end: calc(var(--agent-dock-height, 0px) + var(--wiki-space-4));
}
.inline-agent__transcript--following { overflow-anchor: none; }
.inline-agent__transcript:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }
.inline-agent__transcript :deep(.agent-thread) { flex: 0 0 auto; width: 100%; max-width: var(--agent-conversation-width); margin-inline: auto; }
.inline-agent__conversation-dock { position: sticky; z-index: 3; inset-block-end: 0; display: flex; width: 100%; flex: 0 0 auto; flex-direction: column; margin: auto auto 0; padding-block-start: var(--wiki-space-3); pointer-events: none; }
.inline-agent__goal-dock, .inline-agent__composer { pointer-events: auto; background: var(--wiki-surface-raised); }
.inline-agent__goal-dock { width: min(100%, var(--agent-conversation-width)); margin-inline: auto; padding-block: var(--wiki-space-2); }
.inline-agent__composer { padding: var(--wiki-space-3) 0 max(var(--wiki-space-4), env(safe-area-inset-bottom)); border-top: 1px solid var(--wiki-surface-border); max-height: min(32rem, 70cqh); overflow-y: auto; overscroll-behavior: contain; }
.inline-agent__composer-inner { width: min(100%, var(--agent-conversation-width)); margin-inline: auto; }
.inline-agent__composer-lock, .inline-agent__pin-storage-warning { display: flex; align-items: start; gap: var(--wiki-space-2); margin: 0 0 var(--wiki-space-2); color: var(--wiki-text-muted); font-size: .8rem; line-height: 1.5; }
.inline-agent__composer-lock { border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); padding: var(--wiki-space-2) var(--wiki-space-3); background: var(--wiki-surface-sunken); color: rgb(var(--v-theme-on-surface)); }
.inline-agent__jump-dock { position: absolute; inset-block-end: 100%; inset-inline-end: 0; display: flex; justify-content: end; max-width: 100%; padding: var(--wiki-space-2); pointer-events: none; }
.inline-agent__jump-dock > .v-btn { pointer-events: auto; min-height: 44px; border: 1px solid var(--wiki-surface-border-strong); background: var(--wiki-surface-raised) !important; color: rgb(var(--v-theme-on-surface)) !important; box-shadow: var(--wiki-shadow-xs); }
.inline-agent__follow-jump-frame, .inline-agent__follow-jump-face { display: inline-flex; align-items: center; gap: var(--wiki-space-2); }
.inline-agent__loading { display: flex; align-items: center; gap: var(--wiki-space-3); margin: var(--wiki-space-6) auto; color: var(--wiki-text-muted); }
.inline-agent__loading span:last-child { display: grid; }
.inline-agent__loading strong { color: rgb(var(--v-theme-on-surface)); font-size: .9rem; }
.inline-agent__loading small { font-size: .8rem; }
.inline-agent__loading-mark { width: 12px; height: 12px; border: 2px solid var(--wiki-surface-border-strong); border-top-color: var(--wiki-primary-ink); border-radius: 50%; }
.inline-agent__welcome { width: min(100%, var(--agent-conversation-width)); box-sizing: border-box; margin: auto; padding-block: var(--wiki-space-6); }
.inline-agent__welcome-title { margin: 0; color: rgb(var(--v-theme-on-surface)); font: 700 clamp(1.25rem, 2vw, 1.75rem)/1.35 var(--wiki-font-body); }
.inline-agent__welcome-line { display: block; }
.inline-agent__welcome-title em { font-style: normal; font-weight: 500; }
.inline-agent__welcome-subtitle { max-width: 42rem; margin: var(--wiki-space-3) 0 var(--wiki-space-5); color: var(--wiki-text-muted); font-size: .9rem; line-height: 1.6; }
.inline-agent__starters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--wiki-space-3); }
.inline-agent__starter { min-width: 0; height: auto !important; min-height: 88px; padding: var(--wiki-space-3); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); color: rgb(var(--v-theme-on-surface)) !important; text-align: start; white-space: normal; }
.inline-agent__starter :deep(.v-btn__content) { display: grid; min-width: 0; width: 100%; justify-items: start; gap: var(--wiki-space-2); }
.inline-agent__starter-heading { display: flex; align-items: center; gap: var(--wiki-space-2); min-width: 0; font-size: .85rem; }
.inline-agent__starter-heading :deep(.v-icon) { color: var(--wiki-primary-ink); flex: 0 0 auto; }
.inline-agent__starter-copy small { display: block; color: var(--wiki-text-muted); font-size: .8rem; line-height: 1.5; overflow-wrap: anywhere; }
.inline-agent__starter[aria-disabled='true'] { border-style: dashed; cursor: not-allowed; }
.inline-agent__starter:not([aria-disabled='true']):hover { border-color: var(--wiki-surface-border-strong); }
.inline-agent__starter-reason { grid-column: 1 / -1; margin: 0; color: var(--wiki-text-muted); font-size: .8rem; }
.inline-agent__side { position: relative; overflow: hidden; background: var(--wiki-surface-raised); outline: none; }
.inline-agent__side:focus-visible { box-shadow: inset var(--wiki-focus-ring); }
.inline-agent__scrim { display: none; }
.inline-agent[data-panel-mode='docked'].inline-agent--history, .inline-agent[data-panel-mode='wide'].inline-agent--history { grid-template-columns: 20rem minmax(0, 1fr); }
.inline-agent[data-panel-mode='docked'].inline-agent--memory, .inline-agent[data-panel-mode='wide'].inline-agent--memory { grid-template-columns: minmax(0, 1fr) 22rem; }
.inline-agent[data-panel-mode='wide'].inline-agent--history.inline-agent--memory { grid-template-columns: 20rem minmax(0, 1fr) 22rem; }
.inline-agent[data-panel-mode='docked'].inline-agent--history .inline-agent__card, .inline-agent[data-panel-mode='wide'].inline-agent--history .inline-agent__card { grid-column: 2; }
.inline-agent__side--history { grid-column: 1; grid-row: 1; border-inline-end: 1px solid var(--wiki-surface-border); }
.inline-agent__side--memory { grid-column: 2; grid-row: 1; border-inline-start: 1px solid var(--wiki-surface-border); }
.inline-agent[data-panel-mode='wide'].inline-agent--history .inline-agent__side--memory { grid-column: 3; }
.inline-agent__side :deep(.agent-history), .inline-agent__side :deep(.agent-memory) { border: 0; border-radius: 0 !important; box-shadow: none; }
.inline-agent[data-panel-mode='modal'] .inline-agent__side { position: absolute; z-index: 5; inset-block: 0; width: min(24rem, calc(100% - 2rem)); grid-column: 1; box-shadow: var(--wiki-shadow-md); }
.inline-agent[data-panel-mode='modal'] .inline-agent__side--history { inset-inline-start: 0; }
.inline-agent[data-panel-mode='modal'] .inline-agent__side--memory { inset-inline-end: 0; }
.inline-agent[data-panel-mode='modal'] .inline-agent__scrim { position: absolute; z-index: 4; display: block; inset: 0; border: 0; background: rgba(var(--v-theme-on-surface), .35); }
@container agent-workspace (max-width: 780px) {
  .inline-agent__starters { grid-template-columns: minmax(0, 1fr); }
  .inline-agent__starter { min-height: 64px; }
  .inline-agent__toolbar-main { flex-basis: 100%; flex-wrap: wrap; gap: var(--wiki-space-2); }
  .inline-agent__identity { flex: 1 1 12rem; }
  .inline-agent__panel-actions { margin-inline-start: 0; }
}
@media (max-width: 639.98px) {
  .inline-agent__toolbar { padding-inline: var(--wiki-space-3); }
  .inline-agent__toolbar-main { display: grid; grid-template-columns: minmax(0, 1fr) auto; flex-basis: 100%; gap: var(--wiki-space-2); }
  .inline-agent__mobile-navigation { grid-column: 2; grid-row: 1; align-self: start; }
  .inline-agent__identity { grid-column: 1; grid-row: 1; }
  .inline-agent__provider-identity { flex: 1; min-width: 0; }
  .inline-agent__model-label { display: none; }
  .inline-agent__session-title { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inline-agent__panel-actions { width: 100%; justify-content: flex-end; }
  :is(.inline-agent__history-toggle, .inline-agent__memory-toggle, .inline-agent__search-action, .inline-agent__new-session, .inline-agent__close-action) { width: 44px; min-width: 44px; padding: 0; }
  :is(.inline-agent__history-toggle, .inline-agent__memory-toggle, .inline-agent__search-action, .inline-agent__new-session, .inline-agent__close-action) :deep(.v-btn__content) { display: none; }
  :is(.inline-agent__history-toggle, .inline-agent__memory-toggle, .inline-agent__search-action, .inline-agent__new-session, .inline-agent__close-action) :deep(.v-btn__prepend) { margin-inline: 0; }
  .inline-agent__commandbar { padding-inline: var(--wiki-space-3); }
  .inline-agent__session-controls { margin-inline-start: 0; }
  .inline-agent__session-controls :deep(.v-btn) { min-height: 44px; }
  .inline-agent__welcome { padding-block: var(--wiki-space-4); }
  .inline-agent__starters { grid-template-columns: minmax(0, 1fr); }
}
@media (forced-colors: active) {
  .inline-agent, .inline-agent__card, .inline-agent__toolbar, .inline-agent__body, .inline-agent__composer, .inline-agent__side { background: Canvas !important; color: CanvasText; }
  .inline-agent__scrim { background: Canvas; opacity: .7; }
}
</style>
