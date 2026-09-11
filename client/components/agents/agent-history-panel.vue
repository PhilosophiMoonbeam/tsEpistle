<template>
  <v-card
    class="agent-history"
    elevation="0"
    rounded="xl"
    :aria-busy="loading || refreshingHistory || sessionsReloading || sessionsLoadingMore || savingFolder || deleting || sessionMutationBusy || openingSessionIds.size > 0 || movingSessionIds.size > 0"
  >
    <AgentPanelHeader ref="historyCloseButton" title="Conversations" icon="mdi-history" close-label="Close chat history" :heading-id="headingId" :description-id="descriptionId" @close="closeHistory">
      {{ archiveCountDescription }}
    </AgentPanelHeader>

    <div class="agent-history__search">
      <v-text-field
        ref="historySearchField"
        v-model="searchQuery"
        aria-label="Search conversation history"
        clearable
        density="compact"
        hide-details
        label="Search conversations"
        prepend-inner-icon="mdi-magnify"
        variant="outlined"
      />
      <span class="agent-history__search-status" role="status" aria-live="polite">{{ searchStatus }}</span>
    </div>
    <span id="agent-history-drag-instructions" class="agent-history__search-status">
      Drag a conversation to Recent, a saved folder, or the new-folder area. Use its actions menu to move it with a keyboard.
    </span>
    <span class="agent-history__search-status" role="status" aria-live="polite">{{ dragStatus }}</span>

    <v-alert v-if="localError" class="mx-3 mb-3" density="compact" type="error" variant="tonal" closable @click:close="localError = ''">
      {{ localError }}
    </v-alert>
    <v-alert v-if="sessionsRefreshError" class="mx-3 mb-3" density="compact" type="warning" variant="tonal">
      <div class="agent-history__refresh-error">
        <span>{{ sessionsRefreshError }}</span>
        <v-btn size="small" variant="text" :loading="refreshingSessions" :disabled="refreshingSessions" @click="refreshSessions">Retry conversations</v-btn>
      </div>
    </v-alert>
    <v-alert v-if="foldersRefreshError" class="mx-3 mb-3" density="compact" type="warning" variant="tonal">
      <div class="agent-history__refresh-error">
        <span>{{ foldersRefreshError }}</span>
        <v-btn size="small" variant="text" :loading="refreshingFolders" :disabled="refreshingFolders" @click="refreshFolders">Retry folders</v-btn>
      </div>
    </v-alert>

    <div v-if="loading && displaySessions.length === 0" class="agent-history__loading" role="status" aria-live="polite">
      <v-progress-circular color="primary" indeterminate size="22" width="2" />
      <span>Opening the conversation archive…</span>
    </div>

    <div v-else class="agent-history__body">
      <div v-if="normalizedSearch && !hasSearchResults" class="agent-history__empty agent-history__empty--search">
        <v-icon icon="mdi-text-search" size="22" />
        <div>
          <strong>No matching conversations</strong>
          <span>Try a title or folder name.</span>
        </div>
      </div>

      <template v-else>
        <section
          class="agent-history__recent"
          :class="{
            'agent-history__drop-target--available': canDropTo(null),
            'agent-history__drop-target--active': isActiveDropTarget(null)
          }"
          aria-labelledby="agent-history-recent-title"
          aria-describedby="agent-history-drag-instructions"
          @dragenter="setDropTarget($event, null)"
          @dragover="setDropTarget($event, null)"
          @dragleave="leaveDropTarget($event, null)"
          @drop="dropSession($event, null)"
        >
          <div class="agent-history__section-heading">
            <div>
              <h3 id="agent-history-recent-title" class="agent-history__section-title">Recent</h3>
              <div class="agent-history__section-copy">Your recent, unfiled conversations</div>
            </div>
            <span class="agent-history__count" :aria-label="`${filteredRecentSessions.length} recent conversations`">{{ filteredRecentSessions.length }}</span>
          </div>

          <template v-if="recentSessionGroups.length">
            <div v-for="group in recentSessionGroups" :key="group.label" class="agent-history__time-group">
              <div class="agent-history__time-label">{{ group.label }}</div>
              <v-list class="agent-history__list" density="compact" nav :aria-label="`${group.label} conversations`">
                <v-list-item
                  v-for="session in group.sessions"
                  :key="session.id"
                  class="agent-history__session"
                  :active="session.id === thread?.session.id"
                  :class="{ 'agent-history__session--dragging': draggedSessionId === session.id }"
                  :aria-current="session.id === thread?.session.id ? 'page' : undefined"
                  :title="session.title || 'New conversation'"
                  :subtitle="session.id === thread?.session.id ? `${sessionDateLabel(session.id)} · Current session` : sessionDateLabel(session.id)"
                  link
                  :disabled="sessionBusy(session.id)"
                  :draggable="canDragSession(session)"
                  aria-describedby="agent-history-drag-instructions"
                  rounded="lg"
                  @click="openSession(session.id)"
                  @dragstart.stop="beginSessionDrag($event, session)"
                  @dragend="finishSessionDrag"
                >
                  <template #prepend>
                    <v-progress-circular v-if="openingSessionIds.has(session.id)" color="primary" indeterminate size="18" width="2" aria-label="Opening conversation" />
                    <v-icon v-else :icon="session.id === thread?.session.id ? 'mdi-message-text' : 'mdi-message-text-outline'" size="18" />
                  </template>
                  <template #append>
                    <AgentHistorySessionActions
                      :session="session"
                      :folders="folders"
                      :busy="sessionBusy(session.id)"
                      :disabled="sessionMutationBusy"
                      @move="folderId => moveSession(session, folderId)"
                      @new-folder="(selectedSession, restoreTarget) => beginCreateFolderForSession(selectedSession, restoreTarget)"
                      @rename="restoreTarget => beginRenameSession(session, restoreTarget)"
                      @remove="restoreTarget => beginDeleteSession(session, restoreTarget)"
                    />
                  </template>
                </v-list-item>
              </v-list>
            </div>
          </template>
          <div v-else class="agent-history__empty">
            <v-icon icon="mdi-message-outline" size="20" />
            <span>Your unfiled conversations appear here.</span>
          </div>

            <div
              v-if="sessionsNextCursor || sessionsLoadingMore || sessionsLoadMoreError"
              class="agent-history__pagination"
              aria-live="polite"
            >
              <div v-if="sessionsLoadingMore" class="agent-history__pagination-status" role="status">
                <v-progress-circular color="primary" indeterminate size="18" width="2" />
                <span>Loading older conversations…</span>
              </div>
              <v-alert v-else-if="sessionsLoadMoreError" density="compact" role="alert" type="warning" variant="tonal">
                <div class="agent-history__refresh-error">
                  <span>{{ sessionsLoadMoreError }}</span>
                  <v-btn aria-label="Retry loading older conversations" size="small" variant="text" @click="loadMoreSessions">Retry</v-btn>
                </div>
              </v-alert>
              <v-btn
                v-else
                block
                prepend-icon="mdi-chevron-down"
                variant="tonal"
                :disabled="refreshingHistory || sessionsReloading"
                @click="loadMoreSessions"
              >
                Load more
              </v-btn>
            </div>
        </section>

        <section class="agent-history__folders" aria-labelledby="agent-history-folders-title">
          <div class="agent-history__section-heading agent-history__section-heading--folders">
            <div>
              <h3 id="agent-history-folders-title" class="agent-history__section-title">Saved folders</h3>
              <div class="agent-history__section-copy">Kept without expiry</div>
            </div>
            <v-btn class="agent-history__new-folder" prepend-icon="mdi-folder-plus-outline" size="small" variant="text" aria-label="Create a conversation folder" :disabled="loading || refreshingHistory || sessionsReloading || savingFolder || deleting || sessionMutationBusy" @click="beginCreateFolder">New folder</v-btn>
          </div>

          <v-expansion-panels v-if="visibleFolderGroups.length" v-model="openFolderIds" class="agent-history__folder-panels" multiple variant="accordion">
            <v-expansion-panel
              v-for="group in visibleFolderGroups"
              :key="group.folder.id"
              :value="group.folder.id"
              :class="{
                'agent-history__drop-target--available': canDropTo(group.folder.id),
                'agent-history__drop-target--active': isActiveDropTarget(group.folder.id)
              }"
              aria-describedby="agent-history-drag-instructions"
              rounded="lg"
              @dragenter="setDropTarget($event, group.folder.id)"
              @dragover="setDropTarget($event, group.folder.id)"
              @dragleave="leaveDropTarget($event, group.folder.id)"
              @drop="dropSession($event, group.folder.id)"
            >
              <v-expansion-panel-title class="agent-history__folder-title">
                <v-icon class="me-2 agent-history__folder-icon" icon="mdi-folder-outline" size="19" />
                <span class="agent-history__folder-name">{{ group.folder.name }}</span>
                <span class="agent-history__folder-count" :aria-label="`${group.sessions.length} conversations`">{{ group.sessions.length }}</span>
              </v-expansion-panel-title>
              <v-menu content-class="agent-owned-overlay" location="bottom end">
                <template #activator="{ props: menuProps }">
                  <v-btn v-bind="menuProps" class="agent-history__folder-actions" icon="mdi-dots-horizontal" size="x-small" variant="text" :aria-label="`Actions for ${group.folder.name}`" :disabled="loading || refreshingHistory || sessionsReloading || savingFolder || deleting || sessionMutationBusy" />
                </template>
                <v-list density="compact" :aria-label="`Folder actions for ${group.folder.name}`">
                  <v-list-item link prepend-icon="mdi-pencil-outline" title="Rename folder" :disabled="loading || refreshingHistory || sessionsReloading || savingFolder || deleting || sessionMutationBusy" @click="beginRenameFolder(group.folder)" />
                  <v-divider />
                  <v-list-item link class="text-error" prepend-icon="mdi-folder-remove-outline" title="Remove folder" subtitle="Conversations return to Recent" :disabled="loading || refreshingHistory || sessionsReloading || savingFolder || deleting || sessionMutationBusy" @click="beginRemoveFolder(group.folder)" />
                </v-list>
              </v-menu>
              <v-expansion-panel-text>
                <v-list v-if="group.sessions.length" class="agent-history__list agent-history__list--folder" density="compact" nav :aria-label="`${group.folder.name} conversations`">
                  <v-list-item
                    v-for="session in group.sessions"
                    :key="session.id"
                    class="agent-history__session"
                    :active="session.id === thread?.session.id"
                    :aria-current="session.id === thread?.session.id ? 'page' : undefined"
                    :class="{ 'agent-history__session--dragging': draggedSessionId === session.id }"
                    :title="session.title || 'New conversation'"
                    :subtitle="session.id === thread?.session.id ? `${sessionDateLabel(session.id)} · Current session` : sessionDateLabel(session.id)"
                    link
                    :disabled="sessionBusy(session.id)"
                    :draggable="canDragSession(session)"
                    aria-describedby="agent-history-drag-instructions"
                    rounded="lg"
                    @click="openSession(session.id)"
                    @dragstart.stop="beginSessionDrag($event, session)"
                    @dragend="finishSessionDrag"
                  >
                    <template #prepend>
                      <v-progress-circular v-if="openingSessionIds.has(session.id)" color="primary" indeterminate size="18" width="2" aria-label="Opening conversation" />
                      <v-icon v-else :icon="session.id === thread?.session.id ? 'mdi-message-text' : 'mdi-message-text-outline'" size="18" />
                    </template>
                    <template #append>
                      <AgentHistorySessionActions
                        :session="session"
                        :folders="folders"
                        :busy="sessionBusy(session.id)"
                        :disabled="sessionMutationBusy"
                        @move="folderId => moveSession(session, folderId)"
                        @new-folder="(selectedSession, restoreTarget) => beginCreateFolderForSession(selectedSession, restoreTarget)"
                        @rename="restoreTarget => beginRenameSession(session, restoreTarget)"
                        @remove="restoreTarget => beginDeleteSession(session, restoreTarget)"
                      />
                    </template>
                  </v-list-item>
                </v-list>
                <div v-else class="agent-history__empty agent-history__empty--folder">Move a conversation here to keep it.</div>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
          <div
            v-else-if="folders.length === 0"
            class="agent-history__empty agent-history__empty--folders"
            :class="{
              'agent-history__drop-target--available': canDropTo(newFolderDropTarget),
              'agent-history__drop-target--active': isActiveDropTarget(newFolderDropTarget)
            }"
            data-drop-target="new-folder"
            role="region"
            aria-label="Create a folder for conversations worth keeping"
            aria-describedby="agent-history-drag-instructions"
            @dragenter="setDropTarget($event, newFolderDropTarget)"
            @dragover="setDropTarget($event, newFolderDropTarget)"
            @dragleave="leaveDropTarget($event, newFolderDropTarget)"
            @drop="dropSession($event, newFolderDropTarget)"
          >
            <v-icon icon="mdi-folder-heart-outline" size="22" />
            <div>
              <strong>Create a folder for conversations worth keeping</strong>
              <span>Drop a conversation here to start a new folder.</span>
            </div>
          </div>
          <div v-else class="agent-history__empty agent-history__empty--folders">
            <v-icon icon="mdi-folder-heart-outline" size="22" />
            <span>Create a folder for conversations worth keeping.</span>
          </div>
        </section>
      </template>

    </div>
    <footer class="agent-history__footer">
      <p>Keep a temporary chat to find it here.</p>
      <v-menu content-class="agent-owned-overlay" location="top end">
        <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-dots-horizontal" size="small" variant="text" aria-label="Conversation history options" /></template>
        <v-list density="compact"><v-list-item link prepend-icon="mdi-delete-sweep-outline" title="Clear Recent history" subtitle="Saved folders are preserved" :disabled="clearHistoryDisabled" @click="requestClear" /></v-list>
      </v-menu>
    </footer>
  </v-card>

  <v-dialog content-class="agent-owned-overlay" v-model="folderEditorOpen" max-width="28rem" aria-labelledby="agent-history-folder-editor-title" :persistent="savingFolder">
    <v-card rounded="xl">
      <v-card-title id="agent-history-folder-editor-title" class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="primary" size="38" variant="tonal"><v-icon icon="mdi-folder-outline" aria-hidden="true" /></v-avatar>
        {{ editingFolder ? 'Rename folder' : 'New folder' }}
      </v-card-title>
      <v-card-text class="px-5 pt-4">
        <v-alert v-if="dialogError" class="mb-3" type="error" variant="tonal" density="compact">{{ dialogError }}</v-alert>
        <v-text-field
          ref="folderInput"
          v-model="folderName"
          class="agent-history__folder-input"
          autofocus
          counter="64"
          label="Folder name"
          maxlength="64"
          variant="outlined"
          :disabled="folderWorkflowState === 'move-retry' || folderWorkflowState === 'create-unknown'"
          @keydown.enter.prevent="saveFolder"
        />
        <p class="text-body-small text-medium-emphasis mb-0">Folders keep conversations beyond the history window.</p>
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" :disabled="savingFolder" @click="cancelFolderEditor">Cancel</v-btn>
        <v-btn
          color="primary"
          variant="tonal"
          :disabled="loading || !folderName.trim() || savingFolder || sessionMutationBusy"
          :loading="savingFolder"
          @click="saveFolder"
        >
          {{ editingFolder ? 'Save name' : folderWorkflowState === 'move-retry' ? 'Retry move' : folderWorkflowState === 'create-unknown' ? 'Check folder status' : 'Create folder' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog content-class="agent-owned-overlay" v-model="sessionEditorOpen" max-width="28rem" aria-labelledby="agent-history-session-editor-title" :persistent="savingSessionTitle">
    <v-card rounded="xl">
      <v-card-title id="agent-history-session-editor-title" class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="primary" size="38" variant="tonal"><v-icon icon="mdi-pencil-outline" aria-hidden="true" /></v-avatar>
        Rename conversation
      </v-card-title>
      <v-card-text class="px-5 pt-4">
        <v-alert v-if="sessionDialogError" class="mb-3" type="error" variant="tonal" density="compact">{{ sessionDialogError }}</v-alert>
        <v-text-field v-model="sessionRenameTitle" autofocus counter="255" label="Conversation title" maxlength="255" variant="outlined" :disabled="savingSessionTitle || sessionMutationBusy" @keydown.enter.prevent="saveSessionTitle" />
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" :disabled="savingSessionTitle" @click="sessionEditorOpen = false">Cancel</v-btn>
        <v-btn color="primary" variant="tonal" :disabled="loading || !sessionRenameTitle.trim() || savingSessionTitle || sessionMutationBusy" :loading="savingSessionTitle" @click="saveSessionTitle">
          Save title
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog content-class="agent-owned-overlay" :model-value="Boolean(deletingSession)" max-width="29rem" aria-labelledby="agent-history-delete-title" :persistent="deleting || sessionMutationBusy" @update:model-value="value => { if (!value && !deleting && !sessionMutationBusy) cancelDeleteSession() }">
    <v-card ref="deleteDialogCard" rounded="xl">
      <v-card-title id="agent-history-delete-title" class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="error" size="38" variant="tonal"><v-icon icon="mdi-delete-outline" aria-hidden="true" /></v-avatar>
        Delete conversation?
      </v-card-title>
      <v-card-text class="px-5">
        <v-alert v-if="dialogError" class="mb-3" type="error" variant="tonal" density="compact">{{ dialogError }}</v-alert>
        <strong>{{ deletingSession?.title || 'New conversation' }}</strong> and its messages will be permanently removed.
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" :disabled="deleting || sessionMutationBusy" @click="cancelDeleteSession">Cancel</v-btn>
        <v-btn color="error" variant="tonal" :loading="deleting" :disabled="deleting || sessionMutationBusy" @click="deleteSession">Delete permanently</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog content-class="agent-owned-overlay" :model-value="Boolean(removingFolder)" max-width="30rem" aria-labelledby="agent-history-remove-folder-title" :persistent="deleting || sessionMutationBusy" @update:model-value="value => { if (!value && !deleting && !sessionMutationBusy) cancelRemoveFolder() }">
    <v-card ref="removeFolderDialogCard" rounded="xl">
      <v-card-title id="agent-history-remove-folder-title" class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="warning" size="38" variant="tonal"><v-icon icon="mdi-folder-remove-outline" aria-hidden="true" /></v-avatar>
        Remove folder?
      </v-card-title>
      <v-card-text class="px-5">
        <v-alert v-if="dialogError" class="mb-3" type="error" variant="tonal" density="compact">{{ dialogError }}</v-alert>
        <p class="mb-2"><strong>{{ removingFolder?.name }}</strong> will be removed.</p>
        <p class="mb-0">Its conversations return to Recent and each starts a fresh history retention window. No conversations are deleted.</p>
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" :disabled="deleting || sessionMutationBusy" @click="cancelRemoveFolder">Cancel</v-btn>
        <v-btn color="warning" variant="tonal" :loading="deleting" :disabled="loading || deleting || sessionMutationBusy" @click="deleteFolder">Remove folder</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import AgentPanelHeader from './agent-panel-header.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, onWatcherCleanup, ref, shallowRef, useTemplateRef, watch, type ComponentPublicInstance } from 'vue'
import { storeToRefs } from 'pinia'
import type { AgentConversationFolderView } from '../../../shared/agents/contracts.ts'
import { agentConversationFolderNameKey, cleanAgentConversationFolderName } from '../../../shared/agents/conversation-folders.ts'
import type { AgentSessionSummary } from '../../helpers/agents-api.ts'
import { useAgentsStore } from '../../store/agents.ts'
import { createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'
import AgentHistorySessionActions from './agent-history-session-actions.vue'
const { headingId, descriptionId } = defineProps<{ headingId: string; descriptionId: string }>()
const emit = defineEmits<{ close: []; clear: [] }>()
const agents = useAgentsStore()
const { folders, loading, sessionMutationBusy, sessions, sessionsLoadMoreError, sessionsLoadingMore, sessionsNextCursor, sessionsReloading, thread } = storeToRefs(agents)
const openFolderIds = ref<string[]>([])
const localError = ref('')
const folderEditorOpen = ref(false)
const folderEditorRestoreTarget = shallowRef<HTMLElement | null>(null)
const folderName = ref('')
type FolderWorkflowState = 'idle' | 'creating' | 'create-unknown' | 'moving' | 'move-retry'
const folderWorkflowState = ref<FolderWorkflowState>('idle')
const folderWorkflowSession = shallowRef<AgentSessionSummary | null>(null)
const folderWorkflowFolderId = ref<string | null>(null)
const folderWorkflowFolder = shallowRef<AgentConversationFolderView | null>(null)
const editingFolder = shallowRef<AgentConversationFolderView | null>(null)
const savingFolder = ref(false)
const sessionEditorOpen = ref(false)
const editingSession = shallowRef<AgentSessionSummary | null>(null)
const sessionRenameTitle = ref('')
const sessionDialogError = ref('')
const savingSessionTitle = ref(false)
const sessionEditorRestoreTarget = shallowRef<HTMLElement | null>(null)
const deletingSession = shallowRef<AgentSessionSummary | null>(null)
const removingFolder = shallowRef<AgentConversationFolderView | null>(null)
const dialogError = ref('')
const deleting = ref(false)
const searchQuery = ref<string | null>('')
const openingSessionIds = shallowRef(new Set<string>())
const movingSessionIds = shallowRef(new Set<string>())
const committedDeletedSessionIds = shallowRef(new Set<string>())
const projectedFolderIds = shallowRef(new Map<string, string | null>())
const lastMoveRefresh = shallowRef<{ readonly sessionId: string; readonly refreshed: boolean } | null>(null)
const sessionsRefreshError = ref('')
const foldersRefreshError = ref('')
const refreshingSessions = ref(false)
const refreshingFolders = ref(false)
const refreshingHistory = computed(() => refreshingSessions.value || refreshingFolders.value)
const initialRefreshPending = ref(false)
const draggedSessionId = ref<string | null>(null)
const activeDropTarget = ref<string | null>(null)
const activeDragToken = ref<string | null>(null)
let activeDragDataTransfer: DataTransfer | null = null
let dragTokenSequence = 0
const dragStatus = ref('')
const recentDropTarget = '__agent_history_recent__'
const newFolderDropTarget = '__agent_history_new_folder__'
const sessionDragMime = 'application/x-ts-epistle-agent-session'
type ComponentRoot = ComponentPublicInstance | HTMLElement
const historyCloseButton = useTemplateRef<ComponentRoot>('historyCloseButton')
const historySearchField = useTemplateRef<ComponentRoot>('historySearchField')
const deleteDialogCard = useTemplateRef<ComponentRoot>('deleteDialogCard')
const removeFolderDialogCard = useTemplateRef<ComponentRoot>('removeFolderDialogCard')
const folderInput = useTemplateRef<ComponentRoot>('folderInput')
const destructiveRestoreTarget = shallowRef<HTMLElement | null>(null)
let destructiveFocusScope: ModalFocusScope | null = null

const normalizedSearch = computed(() => (searchQuery.value ?? '').trim().toLocaleLowerCase())
type SessionTimeGroupLabel = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Earlier'
const sessionTimeGroupLabels: readonly SessionTimeGroupLabel[] = ['Today', 'Yesterday', 'Previous 7 days', 'Earlier']
interface SessionTimeMetadata {
  readonly group: SessionTimeGroupLabel
  readonly displayDate: string
}
interface HistoryPartition {
  readonly displaySessions: readonly AgentSessionSummary[]
  readonly sessionsById: ReadonlyMap<string, AgentSessionSummary>
  readonly sessionDateLabels: ReadonlyMap<string, string>
  readonly recentSessions: readonly AgentSessionSummary[]
  readonly recentGroups: readonly { readonly label: SessionTimeGroupLabel; readonly sessions: readonly AgentSessionSummary[] }[]
  readonly visibleFolderGroups: readonly { readonly folder: AgentConversationFolderView; readonly sessions: readonly AgentSessionSummary[] }[]
  readonly matchingConversationCount: number
}
const sessionTimeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const sessionDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const sessionDateWithYearFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const calendarDay = (value: Date): number => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())
const sessionTimeMetadata = (
  value: string,
  today: number,
  todayDate: string,
  yesterdayDate: string,
  currentYear: number
): SessionTimeMetadata => {
  const date = new Date(value)
  const daysAgo = Math.floor((today - calendarDay(date)) / 86_400_000)
  const group: SessionTimeGroupLabel = daysAgo <= 0
    ? 'Today'
    : daysAgo === 1
      ? 'Yesterday'
      : daysAgo < 7
        ? 'Previous 7 days'
        : 'Earlier'
  const displayDate = date.toDateString() === todayDate
    ? sessionTimeFormatter.format(date)
    : date.toDateString() === yesterdayDate
      ? 'Yesterday'
      : (date.getFullYear() === currentYear ? sessionDateFormatter : sessionDateWithYearFormatter).format(date)
  return { group, displayDate }
}
const historyPartition = computed<HistoryPartition>(() => {
  const query = normalizedSearch.value
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const today = calendarDay(now)
  const todayDate = now.toDateString()
  const yesterdayDate = yesterday.toDateString()
  const currentYear = now.getFullYear()
  const folderSessions = new Map<string, AgentSessionSummary[]>()
  const matchingFolderSessions = new Map<string, AgentSessionSummary[]>()
  for (const folder of folders.value) {
    folderSessions.set(folder.id, [])
    matchingFolderSessions.set(folder.id, [])
  }

  const displaySessions: AgentSessionSummary[] = []
  const sessionsById = new Map<string, AgentSessionSummary>()
  const sessionDateLabels = new Map<string, string>()
  const recentSessions: AgentSessionSummary[] = []
  const recentByTime: Record<SessionTimeGroupLabel, AgentSessionSummary[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    Earlier: []
  }
  for (const sourceSession of sessions.value) {
    if (committedDeletedSessionIds.value.has(sourceSession.id)) continue
    const session = projectedFolderIds.value.has(sourceSession.id)
      ? { ...sourceSession, folderId: projectedFolderIds.value.get(sourceSession.id) ?? null }
      : sourceSession
    displaySessions.push(session)
    sessionsById.set(session.id, session)
    const time = sessionTimeMetadata(session.lastActivityAt, today, todayDate, yesterdayDate, currentYear)
    sessionDateLabels.set(session.id, time.displayDate)
    const matchesSearch = !query || (session.title || 'New conversation').toLocaleLowerCase().includes(query)
    if (session.folderId === null) {
      if (matchesSearch) {
        recentSessions.push(session)
        recentByTime[time.group].push(session)
      }
      continue
    }
    folderSessions.get(session.folderId)?.push(session)
    if (matchesSearch) matchingFolderSessions.get(session.folderId)?.push(session)
  }

  const recentGroups: { label: SessionTimeGroupLabel; sessions: readonly AgentSessionSummary[] }[] = []
  for (const label of sessionTimeGroupLabels) {
    if (recentByTime[label].length) recentGroups.push({ label, sessions: recentByTime[label] })
  }
  const visibleFolderGroups: { folder: AgentConversationFolderView; sessions: readonly AgentSessionSummary[] }[] = []
  let matchingConversationCount = recentSessions.length
  for (const folder of folders.value) {
    const folderMatches = folder.name.toLocaleLowerCase().includes(query)
    const visibleSessions = !query || folderMatches
      ? folderSessions.get(folder.id)!
      : matchingFolderSessions.get(folder.id)!
    if (!folderMatches && visibleSessions.length === 0) continue
    visibleFolderGroups.push({ folder, sessions: visibleSessions })
    matchingConversationCount += visibleSessions.length
  }
  return {
    displaySessions,
    sessionsById,
    sessionDateLabels,
    recentSessions,
    recentGroups,
    visibleFolderGroups,
    matchingConversationCount
  }
})
const displaySessions = computed(() => historyPartition.value.displaySessions)
const draggedSession = computed<AgentSessionSummary | null>(() => {
  const sessionId = draggedSessionId.value
  return sessionId ? historyPartition.value.sessionsById.get(sessionId) ?? null : null
})
const filteredRecentSessions = computed(() => historyPartition.value.recentSessions)
const hasUnfiledSessions = computed(() => displaySessions.value.some(session => session.folderId === null))
const clearHistoryDisabled = computed(() =>
  !hasUnfiledSessions.value ||
  loading.value ||
  refreshingHistory.value ||
  sessionsReloading.value ||
  sessionsLoadingMore.value ||
  savingFolder.value ||
  deleting.value ||
  sessionMutationBusy.value ||
  openingSessionIds.value.size > 0 ||
  movingSessionIds.value.size > 0)
const recentSessionGroups = computed(() => historyPartition.value.recentGroups)
const visibleFolderGroups = computed(() => historyPartition.value.visibleFolderGroups)
const matchingConversationCount = computed(() => historyPartition.value.matchingConversationCount)
const hasSearchResults = computed(() => matchingConversationCount.value > 0)
const archiveCountDescription = computed(() => {
  const count = matchingConversationCount.value
  const noun = count === 1 ? 'conversation' : 'conversations'
  const queryQualifier = normalizedSearch.value ? ' matching' : ''
  const paginationQualifier = sessionsNextCursor.value ? ' loaded so far' : ''
  return `${count}${queryQualifier} ${noun}${paginationQualifier}`
})
const searchStatus = computed(() => normalizedSearch.value
  ? `${matchingConversationCount.value} matching ${matchingConversationCount.value === 1 ? 'conversation' : 'conversations'}`
  : '')
const sessionDateLabel = (sessionId: string): string => historyPartition.value.sessionDateLabels.get(sessionId) ?? ''
const message = (value: unknown, fallback: string): string => {
  const text = value instanceof Error ? value.message.trim() : ''
  return (text || fallback).slice(0, 512)
}
const updatePendingSet = (pending: typeof openingSessionIds, sessionId: string, add: boolean): void => {
  const next = new Set(pending.value)
  if (add) next.add(sessionId)
  else next.delete(sessionId)
  pending.value = next
}
const setProjectedFolder = (sessionId: string, folderId: string | null): void => {
  projectedFolderIds.value = new Map(projectedFolderIds.value).set(sessionId, folderId)
}
const clearProjectedFolder = (sessionId: string): void => {
  const next = new Map(projectedFolderIds.value)
  next.delete(sessionId)
  projectedFolderIds.value = next
}
const sessionBusy = (sessionId: string): boolean =>
  loading.value || refreshingHistory.value || sessionsReloading.value || openingSessionIds.value.size > 0 || movingSessionIds.value.has(sessionId)
const hasRenderedDropDestination = (session: AgentSessionSummary): boolean =>
  session.folderId !== null || visibleFolderGroups.value.length > 0 || !normalizedSearch.value
const canDragSession = (session: AgentSessionSummary): boolean =>
  !sessionMutationBusy.value && !sessionBusy(session.id) && hasRenderedDropDestination(session)
const dropTargetKey = (folderId: string | null): string => folderId ?? recentDropTarget
const isActiveDropTarget = (folderId: string | null): boolean =>
  activeDropTarget.value === dropTargetKey(folderId)
const canDropTo = (folderId: string | null): boolean => {
  const session = draggedSession.value
  if (!session || sessionMutationBusy.value || sessionBusy(session.id)) return false
  if (folderId !== null && folderId !== newFolderDropTarget && !folders.value.some(folder => folder.id === folderId)) return false
  return folderId === newFolderDropTarget || session.folderId !== folderId
}
const clearDragState = (): void => {
  draggedSessionId.value = null
  activeDropTarget.value = null
  activeDragToken.value = null
  activeDragDataTransfer = null
}
const isKnownSessionDrag = (event: DragEvent): boolean => {
  const transfer = event.dataTransfer
  const token = activeDragToken.value
  if (!transfer || !draggedSessionId.value || !token) return false
  if (transfer === activeDragDataTransfer) return true
  const types = Array.from(transfer.types ?? [])
  if (!types.includes(sessionDragMime)) return false
  let encoded = ''
  try {
    encoded = typeof transfer.getData === 'function' ? transfer.getData(sessionDragMime) : ''
  } catch {
    return false
  }
  return !encoded || encoded === token
}
const beginSessionDrag = (event: DragEvent, session: AgentSessionSummary): void => {
  if (!canDragSession(session)) {
    event.preventDefault()
    return
  }
  const token = `${session.id}:${++dragTokenSequence}`
  draggedSessionId.value = session.id
  activeDragToken.value = token
  activeDragDataTransfer = event.dataTransfer
  activeDropTarget.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(sessionDragMime, token)
    event.dataTransfer.setData('text/plain', session.id)
  }
  dragStatus.value = `Dragging ${session.title || 'New conversation'}. Drop it on Recent, a saved folder, or the new-folder area.`
}
const finishSessionDrag = (): void => {
  if (draggedSessionId.value) dragStatus.value = 'Conversation move cancelled.'
  clearDragState()
}
const setDropTarget = (event: DragEvent, folderId: string | null): void => {
  if (!isKnownSessionDrag(event) || !canDropTo(folderId)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  activeDropTarget.value = dropTargetKey(folderId)
}
const leaveDropTarget = (event: DragEvent, folderId: string | null): void => {
  const currentTarget = event.currentTarget as HTMLElement | null
  if (event.relatedTarget && currentTarget?.contains(event.relatedTarget as Node)) return
  if (isActiveDropTarget(folderId)) activeDropTarget.value = null
}
const dropDestinationName = (folderId: string | null): string =>
  folderId === null ? 'Recent' : folders.value.find(folder => folder.id === folderId)?.name ?? 'the saved folder'
const sessionLocationName = (session: AgentSessionSummary): string =>
  session.folderId === null ? 'Recent' : folders.value.find(folder => folder.id === session.folderId)?.name ?? 'its current folder'
const showCommittedRefreshFailure = (): boolean => {
  if (!agents.error) return false
  sessionsRefreshError.value = `Showing last-loaded conversations. ${agents.error}`
  return true
}
const refreshHistoryBlocked = (): boolean =>
  loading.value ||
  refreshingHistory.value ||
  sessionMutationBusy.value ||
  savingFolder.value ||
  deleting.value ||
  Boolean(deletingSession.value) ||
  Boolean(removingFolder.value)
const refreshSessions = async (): Promise<boolean> => {
  if (loading.value || refreshingSessions.value || sessionMutationBusy.value) return false
  refreshingSessions.value = true
  sessionsRefreshError.value = ''
  try {
    await agents.reloadSessions()
    if (!sessionMutationBusy.value) {
      committedDeletedSessionIds.value = new Set()
      projectedFolderIds.value = new Map()
    }
    localError.value = ''
    return true
  } catch (value) {
    sessionsRefreshError.value = `Showing last-loaded conversations. ${message(value, 'Conversations could not be refreshed.')}`
    return false
  } finally {
    refreshingSessions.value = false
  }
}
const refreshFolders = async (): Promise<boolean> => {
  if (loading.value || refreshingFolders.value || sessionMutationBusy.value) return false
  refreshingFolders.value = true
  foldersRefreshError.value = ''
  try {
    await agents.reloadFolders()
    localError.value = ''
    return true
  } catch (value) {
    foldersRefreshError.value = `Showing last-loaded folders. ${message(value, 'Folders could not be refreshed.')}`
    return false
  } finally {
    refreshingFolders.value = false
  }
}
const refreshHistory = async (): Promise<boolean> => {
  if (refreshHistoryBlocked()) return false
  initialRefreshPending.value = false
  const sessionsRefresh = refreshSessions()
  const foldersRefresh = refreshFolders()
  await Promise.allSettled([sessionsRefresh, foldersRefresh])
  return true
}
const loadMoreSessions = async (): Promise<void> => {
  if (refreshingHistory.value || sessionsReloading.value || sessionsLoadingMore.value) return
  await agents.loadMoreSessions()
}
const componentElement = (component: ComponentRoot | null): HTMLElement | null => {
  if (!component) return null
  if (component instanceof HTMLElement) return component
  return component.$el instanceof HTMLElement ? component.$el : null
}
const componentControl = (component: ComponentRoot | null): HTMLElement | null => {
  const root = componentElement(component)
  if (!root) return null
  if (root.matches('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')) return root
  return root.querySelector<HTMLElement>(
    'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  )
}
const isVisibleFocusTarget = (target: HTMLElement | null): target is HTMLElement =>
  Boolean(
    target?.isConnected &&
    target.getClientRects().length > 0 &&
    !target.matches(':disabled, [aria-disabled="true"]') &&
    !target.closest('[inert], [aria-hidden="true"]')
  )
const restoreSessionEditorFocus = (): void => {
  const originalTarget = sessionEditorRestoreTarget.value
  sessionEditorRestoreTarget.value = null
  const target = [
    originalTarget,
    componentControl(historySearchField.value),
    componentControl(historyCloseButton.value)
  ].find(isVisibleFocusTarget)
  target?.focus()
}


const cancelPendingSessionRead = (): void => {
  if (openingSessionIds.value.size > 0) agents.cancelSessionReadTransition()
}
const closeHistory = (): void => {
  cancelPendingSessionRead()
  emit('close')
}
const requestClear = (): void => {
  if (clearHistoryDisabled.value) return
  emit('clear')
}

const openSession = async (sessionId: string): Promise<void> => {
  if (loading.value || sessionMutationBusy.value || refreshingHistory.value || sessionsReloading.value || openingSessionIds.value.size > 0) return
  if (sessionId === thread.value?.session.id) return
  if (openingSessionIds.value.has(sessionId)) return
  localError.value = ''
  updatePendingSet(openingSessionIds, sessionId, true)
  try {
    await agents.openSession(sessionId)
  } catch (value) {
    localError.value = message(value, 'The conversation could not be opened.')
  } finally {
    updatePendingSet(openingSessionIds, sessionId, false)
  }
}

const errorStatus = (value: unknown): number | null => {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
  return typeof record?.status === 'number' ? record.status : null
}
const isConflictError = (value: unknown): boolean => errorStatus(value) === 409
const moveSession = async (session: AgentSessionSummary, folderId: string | null): Promise<boolean> => {
  if (loading.value || sessionMutationBusy.value || refreshingHistory.value || sessionsReloading.value || openingSessionIds.value.size > 0 || session.folderId === folderId || movingSessionIds.value.has(session.id)) return false
  lastMoveRefresh.value = null
  const title = session.title || 'New conversation'
  const destination = dropDestinationName(folderId)
  const originalLocation = sessionLocationName(session)
  localError.value = ''
  sessionsRefreshError.value = ''
  agents.error = ''
  dragStatus.value = `Moving ${title} to ${destination}.`
  updatePendingSet(movingSessionIds, session.id, true)
  try {
    const projected = await agents.moveSessionToFolder(session.id, folderId)
    if (!projected) return false
    setProjectedFolder(session.id, folderId)
    if (!showCommittedRefreshFailure()) clearProjectedFolder(session.id)
    if (folderId && !openFolderIds.value.includes(folderId)) openFolderIds.value.push(folderId)
    dragStatus.value = `Moved ${title} to ${destination}.`
    return true
  } catch (value) {
    const refreshed = await refreshSessions()
    lastMoveRefresh.value = { sessionId: session.id, refreshed }
    localError.value = message(value, 'The conversation could not be moved.')
    dragStatus.value = `${title} could not be moved. It remains in ${originalLocation}. Refresh history, then retry the move.`
    return false
  } finally {
    updatePendingSet(movingSessionIds, session.id, false)
  }
}
const dropSession = async (event: DragEvent, folderId: string | null): Promise<void> => {
  if (!isKnownSessionDrag(event) || !canDropTo(folderId)) return
  event.preventDefault()
  const session = draggedSession.value
  clearDragState()
  if (!session) return
  if (folderId === newFolderDropTarget) {
    beginCreateFolderForSession(session, document.activeElement instanceof HTMLElement ? document.activeElement : null)
    return
  }
  await moveSession(session, folderId)
}
const resetFolderWorkflow = (): void => {
  folderWorkflowState.value = 'idle'
  folderWorkflowSession.value = null
  folderWorkflowFolderId.value = null
  folderWorkflowFolder.value = null
}
const beginCreateFolder = (): void => {
  if (loading.value || sessionMutationBusy.value) return
  dialogError.value = ''
  editingFolder.value = null
  resetFolderWorkflow()
  folderName.value = ''
  folderEditorRestoreTarget.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
  folderEditorOpen.value = true
}
const beginCreateFolderForSession = (session: AgentSessionSummary, restoreTarget: HTMLElement | null): void => {
  if (loading.value || sessionMutationBusy.value || sessionBusy(session.id)) return
  dialogError.value = ''
  editingFolder.value = null
  folderName.value = ''
  folderWorkflowState.value = 'creating'
  folderWorkflowSession.value = session
  folderWorkflowFolderId.value = null
  folderWorkflowFolder.value = null
  folderEditorRestoreTarget.value = restoreTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  folderEditorOpen.value = true
}
const beginRenameFolder = (folder: AgentConversationFolderView): void => {
  if (loading.value || sessionMutationBusy.value) return
  dialogError.value = ''
  editingFolder.value = folder
  resetFolderWorkflow()
  folderName.value = folder.name
  folderEditorRestoreTarget.value =
    document.querySelector<HTMLElement>('.agent-history__folder-actions[aria-expanded="true"]') ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  folderEditorOpen.value = true
}
const beginRenameSession = (session: AgentSessionSummary, restoreTarget: HTMLElement | null): void => {
  if (loading.value || sessionMutationBusy.value) return
  sessionDialogError.value = ''
  editingSession.value = session
  sessionRenameTitle.value = session.title || ''
  sessionEditorRestoreTarget.value = restoreTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  sessionEditorOpen.value = true
}
const saveSessionTitle = async (): Promise<void> => {
  const title = sessionRenameTitle.value.trim()
  const session = editingSession.value
  if (!title || !session || savingSessionTitle.value || loading.value || sessionMutationBusy.value) return
  savingSessionTitle.value = true
  sessionDialogError.value = ''
  try {
    await agents.renameSession(session.id, title)
    sessionEditorOpen.value = false
  } catch (value) {
    sessionDialogError.value = message(value, 'The conversation could not be renamed.')
  } finally {
    savingSessionTitle.value = false
  }
}
watch(sessionEditorOpen, async open => {
  let cancelled = false
  onWatcherCleanup(() => { cancelled = true })
  if (open) return
  await nextTick()
  if (cancelled) return
  restoreSessionEditorFocus()
})
const beginDeleteSession = (session: AgentSessionSummary, restoreTarget: HTMLElement | null): void => {
  if (loading.value || sessionMutationBusy.value) return
  dialogError.value = ''
  destructiveRestoreTarget.value = restoreTarget
  deletingSession.value = session
}
const beginRemoveFolder = (folder: AgentConversationFolderView): void => {
  if (loading.value || sessionMutationBusy.value) return
  dialogError.value = ''
  destructiveRestoreTarget.value = document.querySelector<HTMLElement>('.agent-history__folder-actions[aria-expanded="true"]')
  removingFolder.value = folder
}
const cancelDeleteSession = (): void => {
  if (deleting.value || sessionMutationBusy.value) return
  deletingSession.value = null
  dialogError.value = ''
}
const cancelRemoveFolder = (): void => {
  if (deleting.value || sessionMutationBusy.value) return
  removingFolder.value = null
  dialogError.value = ''
}
const folderByName = (name: string): AgentConversationFolderView | null => {
  const nameKey = agentConversationFolderNameKey(cleanAgentConversationFolderName(name))
  return folders.value.find(folder =>
    agentConversationFolderNameKey(cleanAgentConversationFolderName(folder.name)) === nameKey) ?? null
}
const isFolderView = (value: unknown): value is AgentConversationFolderView => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.name === 'string' && typeof record.version === 'number'
}
const reconcileFolderByName = async (name: string): Promise<AgentConversationFolderView | null> => {
  const local = folderByName(name)
  if (local) return local
  if (!await refreshFolders()) return null
  return folderByName(name)
}
const closeFolderEditorAfterCommit = (): void => {
  folderEditorOpen.value = false
  resetFolderWorkflow()
}
const completeCreatedFolderMove = (folder: AgentConversationFolderView, session: AgentSessionSummary): void => {
  localError.value = ''
  dialogError.value = ''
  setProjectedFolder(session.id, folder.id)
  if (!openFolderIds.value.includes(folder.id)) openFolderIds.value.push(folder.id)
  dragStatus.value = `Moved ${session.title || 'New conversation'} to ${folder.name}.`
  closeFolderEditorAfterCommit()
}
const moveCreatedFolder = async (folder: AgentConversationFolderView): Promise<boolean> => {
  folderWorkflowFolderId.value = folder.id
  folderWorkflowFolder.value = folder
  const source = folderWorkflowSession.value
  if (!source) {
    closeFolderEditorAfterCommit()
    return true
  }
  const authoritativeLatest = sessions.value.find(candidate => candidate.id === source.id)
  const latest = displaySessions.value.find(candidate => candidate.id === source.id) ?? source
  folderWorkflowSession.value = latest
  const moved = authoritativeLatest?.folderId === folder.id || await moveSession(latest, folder.id)
  if (moved) {
    completeCreatedFolderMove(folder, latest)
    return true
  }
  const refreshed = sessions.value.find(candidate => candidate.id === source.id)
  if (refreshed) folderWorkflowSession.value = refreshed
  if (
    lastMoveRefresh.value?.sessionId === source.id &&
    lastMoveRefresh.value.refreshed &&
    refreshed?.folderId === folder.id
  ) {
    completeCreatedFolderMove(folder, refreshed)
    return true
  }
  folderWorkflowState.value = 'move-retry'
  dialogError.value = `Folder “${folder.name}” was created, but the conversation could not be moved. Retry the move.`
  return false
}
const retryFolderMove = async (): Promise<void> => {
  const folderId = folderWorkflowFolderId.value
  const source = folderWorkflowSession.value
  const folder = folderWorkflowFolder.value ?? (folderId ? folders.value.find(candidate => candidate.id === folderId) ?? null : null)
  if (!folderId || !source || !folder) {
    dialogError.value = 'The created folder is no longer available. Refresh folders before retrying.'
    return
  }
  await moveCreatedFolder(folder)
}
const cancelFolderEditor = (): void => {
  if (savingFolder.value) return
  folderEditorOpen.value = false
  resetFolderWorkflow()
}
const saveFolder = async (): Promise<void> => {
  const name = cleanAgentConversationFolderName(folderName.value)
  if (!name || loading.value || savingFolder.value || deleting.value || sessionMutationBusy.value) return
  savingFolder.value = true
  dialogError.value = ''
  try {
    if (editingFolder.value) {
      await agents.renameFolder(editingFolder.value.id, editingFolder.value.version, name)
      closeFolderEditorAfterCommit()
      return
    }
    if (folderWorkflowState.value === 'move-retry') {
      await retryFolderMove()
      return
    }
    if (folderWorkflowState.value === 'create-unknown') {
      const reconciled = await reconcileFolderByName(name)
      if (reconciled) await moveCreatedFolder(reconciled)
      else if (!foldersRefreshError.value) {
        folderWorkflowState.value = 'creating'
        dialogError.value = 'No matching folder was found. You can create it now.'
      } else {
        dialogError.value = 'The folder creation result is still unknown. Refresh folders, then check again before retrying.'
      }
      return
    }
    folderWorkflowState.value = 'creating'
    try {
      const created = await agents.createFolder(name)
      const folder = isFolderView(created) ? created : await reconcileFolderByName(name)
      if (!folder) {
        folderWorkflowState.value = 'create-unknown'
        dialogError.value = 'The folder may have been created, but its result could not be confirmed. Check again before retrying.'
        return
      }
      await moveCreatedFolder(folder)
    } catch (value) {
      const createError = message(value, 'The folder could not be saved.')
      const reconciled = await reconcileFolderByName(name)
      if (reconciled) {
        await moveCreatedFolder(reconciled)
        return
      }
      const refreshFailed = Boolean(foldersRefreshError.value)
      folderWorkflowState.value = refreshFailed ? 'create-unknown' : 'creating'
      dialogError.value = refreshFailed
        ? 'The folder creation result is unknown. Refresh folders, then check again before retrying.'
        : createError
    }
  } finally {
    savingFolder.value = false
  }
}
watch(folderEditorOpen, async open => {
  let cancelled = false
  onWatcherCleanup(() => { cancelled = true })
  if (open) return
  await nextTick()
  if (cancelled) return
  const target = folderEditorRestoreTarget.value
  folderEditorRestoreTarget.value = null
  resetFolderWorkflow()
  const focusTarget = [
    target,
    componentControl(historySearchField.value),
    componentControl(historyCloseButton.value)
  ].find(isVisibleFocusTarget)
  focusTarget?.focus()
})
const deleteSession = async (): Promise<void> => {
  const session = deletingSession.value
  if (!session || deleting.value || savingFolder.value || sessionMutationBusy.value) return
  deleting.value = true; dialogError.value = ''; sessionsRefreshError.value = ''; agents.error = ''
  try {
    const committed = await agents.removeSession(session.id)
    if (!committed) return
    committedDeletedSessionIds.value = new Set(committedDeletedSessionIds.value).add(session.id)
    destructiveRestoreTarget.value = componentElement(historyCloseButton.value)
    deletingSession.value = null
    showCommittedRefreshFailure()
  } catch (value) {
    dialogError.value = message(value, 'The conversation could not be deleted.')
  } finally {
    deleting.value = false
  }
}
const deleteFolder = async (): Promise<void> => {
  const folder = removingFolder.value
  if (!folder || loading.value || deleting.value || savingFolder.value || sessionMutationBusy.value) return
  const affectedSessionIds = displaySessions.value.filter(session => session.folderId === folder.id).map(session => session.id)
  deleting.value = true; dialogError.value = ''; sessionsRefreshError.value = ''; agents.error = ''
  try {
    const committed = await agents.deleteFolder(folder.id, folder.version)
    if (!committed) return
    for (const sessionId of affectedSessionIds) setProjectedFolder(sessionId, null)
    openFolderIds.value = openFolderIds.value.filter(id => id !== folder.id)
    destructiveRestoreTarget.value = componentElement(historyCloseButton.value)
    removingFolder.value = null
    if (!showCommittedRefreshFailure()) {
      for (const sessionId of affectedSessionIds) clearProjectedFolder(sessionId)
    }
  } catch (value) {
    if (isConflictError(value)) {
      const refreshed = await refreshFolders()
      const renewed = refreshed ? folders.value.find(candidate => candidate.id === folder.id) ?? null : null
      if (renewed) {
        removingFolder.value = renewed
        dialogError.value = 'The folder changed while you were reviewing it. Review the updated folder, then remove it again.'
      } else {
        dialogError.value = refreshed
          ? 'The folder is no longer available. Refresh folders before trying again.'
          : 'The folder changed while you were reviewing it. Refresh folders, then review the confirmation again.'
      }
      return
    }
    dialogError.value = message(value, 'The folder could not be removed.')
  } finally {
    deleting.value = false
  }
}
const expandActiveFolder = (): void => {
  const activeId = thread.value?.session.id
  const activeSession = displaySessions.value.find(session => session.id === activeId)
  if (activeSession?.folderId && !openFolderIds.value.includes(activeSession.folderId)) openFolderIds.value.push(activeSession.folderId)
}
watch([deletingSession, removingFolder], async ([session, folder]) => {
  let cancelled = false
  onWatcherCleanup(() => { cancelled = true })
  if (!session && !folder) {
    await nextTick()
    if (cancelled) return
    destructiveFocusScope?.deactivate({ restoreFocus: true })
    destructiveFocusScope = null
    destructiveRestoreTarget.value = null
    return
  }
  await nextTick()
  if (cancelled) return
  const root = componentElement(session ? deleteDialogCard.value : removeFolderDialogCard.value)
  if (!root) return
  destructiveFocusScope?.deactivate({ restoreFocus: false })
  destructiveFocusScope = createModalFocusScope({
    root,
    restoreTarget: () => destructiveRestoreTarget.value,
    onEscape: () => {
      if (deleting.value) return
      if (deletingSession.value) cancelDeleteSession()
      else cancelRemoveFolder()
    }
  })
})
watch(() => thread.value?.session.id, expandActiveFolder, { immediate: true })
watch(folders, expandActiveFolder, { immediate: true })
watch(normalizedSearch, query => {
  if (!query) return
  const visibleIds = visibleFolderGroups.value.map(group => group.folder.id)
  openFolderIds.value = [...new Set([...openFolderIds.value, ...visibleIds])]
})
const startPendingInitialRefresh = (): void => {
  if (!initialRefreshPending.value || refreshHistoryBlocked()) return
  void refreshHistory()
}
watch([loading, sessionMutationBusy, savingFolder, deleting, deletingSession, removingFolder, refreshingHistory], startPendingInitialRefresh)
onMounted(() => {
  initialRefreshPending.value = true
  startPendingInitialRefresh()
})
onBeforeUnmount(() => {
  initialRefreshPending.value = false
  destructiveFocusScope?.deactivate({ restoreFocus: false })
  cancelPendingSessionRead()
})


</script>

<style scoped>
.agent-history {
  background: var(--wiki-surface-raised);
  border: 1px solid var(--wiki-surface-border);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.agent-history__search { flex: 0 0 auto; padding: 1rem 1.25rem .75rem; position: relative; }
.agent-history__search :deep(.v-field) { border-radius: var(--wiki-control-radius); }
.agent-history__search-status {
  clip: rect(0, 0, 0, 0);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
.agent-history__refresh-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-2);
}
.agent-history__loading {
  align-items: center;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  display: flex;
  flex: 1;
  flex-direction: column;
  font-size: .78rem;
  gap: var(--wiki-space-3);
  justify-content: center;
  padding: var(--wiki-space-8);
  text-align: center;
}
.agent-history__footer { display: flex; align-items: center; gap: .5rem; padding: .65rem 1.25rem; border-top: 1px solid var(--wiki-surface-border); }
.agent-history__footer p { flex: 1; margin: 0; font-size: .7rem; line-height: 1.5; color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent); }
.agent-history__folder-icon { color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, rgb(var(--v-theme-on-surface))); }
.agent-history__new-folder { flex: 0 0 auto; color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, rgb(var(--v-theme-on-surface))); }
.agent-history__folder-input :deep(.v-field--variant-outlined .v-field__outline__notch) {
  background-color: var(--wiki-surface-raised);
}
.agent-history__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 var(--wiki-space-3) var(--wiki-space-4);
  scrollbar-gutter: stable;
}
.agent-history__pagination {
  padding: var(--wiki-space-4) var(--wiki-space-1) 0;
}
.agent-history__pagination-status {
  align-items: center;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  display: flex;
  font-size: var(--wiki-type-micro, .75rem);
  gap: var(--wiki-space-2);
  justify-content: center;
  min-height: var(--wiki-control-height);
}
.agent-history__recent {
  border-bottom: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  padding-bottom: var(--wiki-space-3);
}
.agent-history__folders {
  padding-top: var(--wiki-space-4);
}
.agent-history__section-heading {
  align-items: center;
  display: flex;
  gap: var(--wiki-space-3);
  justify-content: space-between;
  padding: var(--wiki-space-2) var(--wiki-space-2) var(--wiki-space-3);
}
.agent-history__recent > .agent-history__section-heading,
.agent-history__folders > .agent-history__section-heading { flex: 0 0 auto; }
.agent-history__section-heading--folders { padding-top: 0; }
.agent-history__section-title { font-size: .78rem; font-weight: 750; letter-spacing: .035em; margin: 0; }
.agent-history__section-copy { color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent); font-size: var(--wiki-type-micro, .75rem); margin-top: var(--wiki-space-1); }
.agent-history__count,
.agent-history__retained {
  align-items: center;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 20%, transparent);
  border-radius: var(--wiki-radius-pill);
  color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, rgb(var(--v-theme-on-surface)));
  display: inline-flex;
  font-size: var(--wiki-type-micro, .75rem);
  font-weight: 700;
  gap: var(--wiki-space-1);
  line-height: 1;
  padding: var(--wiki-space-1) var(--wiki-space-2);
}
.agent-history__time-group + .agent-history__time-group { margin-top: var(--wiki-space-2); }
.agent-history__time-label {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: var(--wiki-type-micro, .75rem);
  font-weight: 700;
  letter-spacing: .08em;
  padding: var(--wiki-space-1) var(--wiki-space-2);
  text-transform: uppercase;
}
.agent-history__list { background: transparent; padding: 0; }
.agent-history__session {
  border: 1px solid transparent;
  margin: var(--wiki-space-1) 0;
  min-height: 3.25rem;
  position: relative;
  transition: background-color var(--wiki-motion-fast) var(--wiki-motion-ease), border-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}
.agent-history__session[draggable='true'] { cursor: grab; }
.agent-history__session[draggable='true']:active { cursor: grabbing; }
.agent-history__session--dragging {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 8%, transparent);
  border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 38%, transparent);
  cursor: grabbing;
  opacity: .52;
}
.agent-history__session::before {
  background: rgb(var(--v-theme-primary));
  border-radius: var(--wiki-radius-pill);
  content: '';
  inset-block: var(--wiki-space-2);
  inset-inline-start: 0;
  opacity: 0;
  position: absolute;
  width: var(--wiki-space-1);
}
.agent-history__session.v-list-item--active {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 25%, transparent);
}
.agent-history__session.v-list-item--active::before { opacity: 1; }
.agent-history__session :deep(.v-list-item-title) { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; font-size: .82rem; font-weight: 550; line-height: 1.4; }
.agent-history__session :deep(.v-list-item-subtitle) { font-size: .68rem; opacity: .75; }
.agent-history__session :deep(.v-list-item__prepend) { margin-inline-end: .65rem; }
.agent-history__session :deep(.v-list-item__prepend > .v-list-item__spacer) { width: 0; }
.agent-history__session :deep(.v-list-item__append) { margin-inline-start: var(--wiki-space-1); }
.agent-history__empty {
  align-items: center;
  border: 1px dashed var(--wiki-surface-border-strong);
  border-radius: var(--wiki-control-radius);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  display: flex;
  font-size: .72rem;
  gap: var(--wiki-space-2);
  line-height: 1.4;
  padding: var(--wiki-space-3);
}
.agent-history__empty strong,
.agent-history__empty span { display: block; }
.agent-history__empty strong { color: rgb(var(--v-theme-on-surface)); font-size: .78rem; margin-bottom: var(--wiki-space-1); }
.agent-history__empty--search { margin: var(--wiki-space-4) var(--wiki-space-1); padding: var(--wiki-space-4); }
.agent-history__empty--folder { border: 0; padding: var(--wiki-space-2) var(--wiki-space-1) var(--wiki-space-3); }
.agent-history__empty--folders { margin: var(--wiki-space-1); }
.agent-history__folder-panels { gap: var(--wiki-space-2); }
.agent-history__folder-panels :deep(.v-expansion-panel) {
  background: var(--wiki-surface-sunken);
  border: 1px solid var(--wiki-surface-border);
  box-shadow: none;
}
.agent-history__folder-title {
  font-size: .78rem;
  min-height: var(--wiki-control-height) !important;
  padding: var(--wiki-space-2) calc(var(--wiki-control-height) + var(--wiki-space-3)) var(--wiki-space-2) var(--wiki-space-3) !important;
}
.agent-history__folder-title :deep(.v-expansion-panel-title__overlay) { opacity: 0; }
.agent-history__folder-name { flex: 1; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-history__folder-count {
  align-items: center;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent);
  border-radius: var(--wiki-radius-pill);
  display: inline-flex;
  font-size: .66rem;
  height: 1.3rem;
  justify-content: center;
  margin-inline: var(--wiki-space-1);
  min-width: 1.3rem;
  padding-inline: var(--wiki-space-1);
}
.agent-history__folder-panels :deep(.v-expansion-panel-text__wrapper) { padding: 0 var(--wiki-space-2) var(--wiki-space-2); }
.agent-history__list--folder { padding-inline: 0; }
.agent-history__folder-actions {
  inset-block-start: 0;
  inset-inline-end: var(--wiki-space-1);
  position: absolute;
  z-index: 2;
}
.agent-history__drop-target--available {
  outline: 1px dashed color-mix(in srgb, rgb(var(--v-theme-primary)) 48%, transparent);
  outline-offset: -2px;
}
.agent-history__drop-target--active {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 14%, var(--wiki-surface-sunken));
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}
.agent-history__folder-panels :deep(.v-expansion-panel.agent-history__drop-target--active) {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 14%, var(--wiki-surface-sunken));
}

@media (pointer: coarse) {
  .agent-history__folder-actions {
    min-width: var(--wiki-control-height) !important;
    min-height: var(--wiki-control-height) !important;
  }
}
@media (max-width: 1199.98px) {
  .agent-history {
    border-radius: 0 !important;
    border-end-end-radius: var(--wiki-panel-radius) !important;
    border-start-end-radius: var(--wiki-panel-radius) !important;
  }
}
@media (max-width: 599.98px) {
  .agent-history { border-radius: 0 !important; border-width: 0; border-inline-end-width: 1px; }
  .agent-history__search { padding-inline: var(--wiki-space-3); }
  .agent-history__body { padding-inline: var(--wiki-space-2); }
  .agent-history__session { min-height: var(--wiki-control-height); }
  .agent-history__session :deep(.v-list-item__content) { min-width: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .agent-history__session { transition: none; }
}
@media (forced-colors: active) {
  .agent-history,
  .agent-history__empty,
  .agent-history__folder-panels :deep(.v-expansion-panel),
  .agent-history__session.v-list-item--active { border: 1px solid CanvasText; }
  .agent-history__drop-target--available,
  .agent-history__drop-target--active,
  .agent-history__session--dragging { outline: 2px solid Highlight; }
  .agent-history__session.v-list-item--active::before { background: Highlight; }
}
</style>
