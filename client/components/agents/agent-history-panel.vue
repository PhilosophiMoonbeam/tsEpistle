<template>
  <v-card
    class="agent-history"
    elevation="0"
    rounded="xl"
    :aria-busy="loading || refreshingHistory || sessionsReloading || sessionsLoadingMore || savingFolder || deleting || sessionMutationBusy || openingSessionIds.size > 0 || movingSessionIds.size > 0"
  >
    <header class="agent-history__header">
      <div class="agent-history__mark" aria-hidden="true">
        <v-icon icon="mdi-history" size="21" />
      </div>
      <div class="agent-history__heading">
        <p class="agent-history__kicker">Conversation archive</p>
        <h2>Chat history</h2>
        <p class="agent-history__intro">{{ displaySessions.length }} {{ displaySessions.length === 1 ? 'conversation' : 'conversations' }} in this workspace</p>
      </div>
      <v-btn ref="historyCloseButton" icon="mdi-close" size="small" variant="text" aria-label="Close chat history" @click="closeHistory" />
    </header>

    <div class="agent-history__actions">
      <v-btn class="agent-history__new-folder" color="primary" prepend-icon="mdi-folder-plus-outline" variant="tonal" :disabled="loading || refreshingHistory || sessionsReloading || savingFolder || deleting" @click="beginCreateFolder">
        New folder
      </v-btn>
      <v-btn
        color="error"
        icon="mdi-delete-sweep-outline"
        variant="text"
        aria-label="Reset all conversation history"
        :disabled="sessions.length === 0 || loading || refreshingHistory || sessionsReloading || sessionsLoadingMore || savingFolder || deleting || sessionMutationBusy || openingSessionIds.size > 0 || movingSessionIds.size > 0"
        @click="requestReset"
      >
        <v-tooltip activator="parent" location="bottom">Reset all history</v-tooltip>
      </v-btn>
    </div>

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
      Drag a conversation to Recent or a saved folder. Use its actions menu to move it with a keyboard.
    </span>
    <span class="agent-history__search-status" role="status" aria-live="polite">{{ dragStatus }}</span>

    <v-alert v-if="localError" class="mx-3 mb-3" density="compact" type="error" variant="tonal" closable @click:close="localError = ''">
      {{ localError }}
    </v-alert>
    <v-alert v-if="refreshError" class="mx-3 mb-3" density="compact" type="warning" variant="tonal">
      <div class="agent-history__refresh-error">
        <span>{{ refreshError }}</span>
        <v-btn size="small" variant="text" :loading="refreshingHistory" :disabled="refreshingHistory" @click="refreshHistory">Retry refresh</v-btn>
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
              <div class="agent-history__section-copy">Unfiled conversations · retained for 90 days</div>
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
        </section>

        <section class="agent-history__folders" aria-labelledby="agent-history-folders-title">
          <div class="agent-history__section-heading agent-history__section-heading--folders">
            <div>
              <h3 id="agent-history-folders-title" class="agent-history__section-title">Saved folders</h3>
              <div class="agent-history__section-copy">Filed conversations do not expire</div>
            </div>
            <span class="agent-history__retained"><v-icon icon="mdi-archive-check-outline" size="14" /> Kept</span>
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
              <div class="agent-history__folder-row">
                <v-expansion-panel-title class="agent-history__folder-title">
                  <v-icon class="me-2" color="primary" icon="mdi-folder-outline" size="19" />
                  <span class="agent-history__folder-name">{{ group.folder.name }}</span>
                  <span class="agent-history__folder-count" :aria-label="`${group.sessions.length} conversations`">{{ group.sessions.length }}</span>
                </v-expansion-panel-title>
                <v-menu location="bottom end">
                  <template #activator="{ props: menuProps }">
                    <v-btn v-bind="menuProps" class="agent-history__folder-actions" icon="mdi-dots-horizontal" size="x-small" variant="text" :aria-label="`Actions for ${group.folder.name}`" :disabled="loading || refreshingHistory || sessionsReloading || savingFolder || deleting || sessionMutationBusy" />
                  </template>
                  <v-list density="compact" :aria-label="`Folder actions for ${group.folder.name}`">
                    <v-list-item link prepend-icon="mdi-pencil-outline" title="Rename folder" :disabled="loading || refreshingHistory || sessionsReloading || savingFolder || deleting || sessionMutationBusy" @click="beginRenameFolder(group.folder)" />
                    <v-divider />
                    <v-list-item link class="text-error" prepend-icon="mdi-folder-remove-outline" title="Remove folder" subtitle="Conversations return to Recent" :disabled="loading || refreshingHistory || sessionsReloading || savingFolder || deleting || sessionMutationBusy" @click="beginRemoveFolder(group.folder)" />
                  </v-list>
                </v-menu>
              </div>
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
          <div v-else class="agent-history__empty agent-history__empty--folders">
            <v-icon icon="mdi-folder-heart-outline" size="22" />
            <span>Create a folder for conversations worth keeping.</span>
          </div>
        </section>
      </template>

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
    </div>
  </v-card>

  <v-dialog v-model="folderEditorOpen" max-width="28rem" aria-labelledby="agent-history-folder-editor-title" :persistent="savingFolder">
    <v-card rounded="xl">
      <v-card-title id="agent-history-folder-editor-title" class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="primary" size="38" variant="tonal"><v-icon icon="mdi-folder-outline" aria-hidden="true" /></v-avatar>
        {{ editingFolder ? 'Rename folder' : 'New folder' }}
      </v-card-title>
      <v-card-text class="px-5 pt-4">
        <v-alert v-if="dialogError" class="mb-3" type="error" variant="tonal" density="compact">{{ dialogError }}</v-alert>
        <v-text-field ref="folderInput" v-model="folderName" autofocus counter="64" label="Folder name" maxlength="64" variant="outlined" @keydown.enter.prevent="saveFolder" />
        <p class="text-body-small text-medium-emphasis mb-0">Chats in a folder are exempt from the 90-day history window.</p>
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" :disabled="savingFolder" @click="folderEditorOpen = false">Cancel</v-btn>
        <v-btn color="primary" variant="tonal" :disabled="loading || !folderName.trim() || savingFolder" :loading="savingFolder" @click="saveFolder">
          {{ editingFolder ? 'Save name' : 'Create folder' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="sessionEditorOpen" max-width="28rem" aria-labelledby="agent-history-session-editor-title" :persistent="savingSessionTitle">
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

  <v-dialog :model-value="Boolean(deletingSession)" max-width="29rem" aria-labelledby="agent-history-delete-title" :persistent="deleting || sessionMutationBusy" @update:model-value="value => { if (!value && !deleting && !sessionMutationBusy) cancelDeleteSession() }">
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

  <v-dialog :model-value="Boolean(removingFolder)" max-width="30rem" aria-labelledby="agent-history-remove-folder-title" :persistent="deleting || sessionMutationBusy" @update:model-value="value => { if (!value && !deleting && !sessionMutationBusy) cancelRemoveFolder() }">
    <v-card ref="removeFolderDialogCard" rounded="xl">
      <v-card-title id="agent-history-remove-folder-title" class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="warning" size="38" variant="tonal"><v-icon icon="mdi-folder-remove-outline" aria-hidden="true" /></v-avatar>
        Remove folder?
      </v-card-title>
      <v-card-text class="px-5">
        <v-alert v-if="dialogError" class="mb-3" type="error" variant="tonal" density="compact">{{ dialogError }}</v-alert>
        <p class="mb-2"><strong>{{ removingFolder?.name }}</strong> will be removed.</p>
        <p class="mb-0">Its conversations return to Recent and each starts a fresh 90-day timer. No conversations are deleted.</p>
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
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch, type ComponentPublicInstance } from 'vue'
import { storeToRefs } from 'pinia'
import type { AgentConversationFolderView } from '../../../shared/agents/contracts.ts'
import type { AgentSessionSummary } from '../../helpers/agents-api.ts'
import { useAgentsStore } from '../../store/agents.ts'
import { createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'
import AgentHistorySessionActions from './agent-history-session-actions.vue'
const emit = defineEmits<{ close: []; reset: [] }>()
const agents = useAgentsStore()
const { folders, loading, sessionMutationBusy, sessions, sessionsLoadMoreError, sessionsLoadingMore, sessionsNextCursor, sessionsReloading, thread } = storeToRefs(agents)
const openFolderIds = ref<string[]>([])
const localError = ref('')
const folderEditorOpen = ref(false)
const folderName = ref('')
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
const refreshError = ref('')
const refreshingHistory = ref(false)
const draggedSessionId = ref<string | null>(null)
const activeDropTarget = ref<string | null>(null)
const dragStatus = ref('')
const recentDropTarget = '__agent_history_recent__'
type ComponentRoot = ComponentPublicInstance | HTMLElement
const historyCloseButton = useTemplateRef<ComponentRoot>('historyCloseButton')
const historySearchField = useTemplateRef<ComponentRoot>('historySearchField')
const deleteDialogCard = useTemplateRef<ComponentRoot>('deleteDialogCard')
const removeFolderDialogCard = useTemplateRef<ComponentRoot>('removeFolderDialogCard')
const folderEditorRestoreTarget = shallowRef<HTMLElement | null>(null)
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
const filteredRecentSessions = computed(() => historyPartition.value.recentSessions)
const recentSessionGroups = computed(() => historyPartition.value.recentGroups)
const visibleFolderGroups = computed(() => historyPartition.value.visibleFolderGroups)
const draggedSession = computed(() =>
  draggedSessionId.value ? historyPartition.value.sessionsById.get(draggedSessionId.value) ?? null : null)
const hasSearchResults = computed(() =>
  filteredRecentSessions.value.length > 0 || visibleFolderGroups.value.length > 0)
const matchingConversationCount = computed(() => historyPartition.value.matchingConversationCount)
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
  session.folderId !== null || visibleFolderGroups.value.length > 0
const canDragSession = (session: AgentSessionSummary): boolean =>
  !sessionMutationBusy.value && !sessionBusy(session.id) && hasRenderedDropDestination(session)
const dropTargetKey = (folderId: string | null): string => folderId ?? recentDropTarget
const isActiveDropTarget = (folderId: string | null): boolean =>
  activeDropTarget.value === dropTargetKey(folderId)
const canDropTo = (folderId: string | null): boolean => {
  const session = draggedSession.value
  return Boolean(session && !sessionMutationBusy.value && session.folderId !== folderId && !sessionBusy(session.id))
}
const clearDragState = (): void => {
  draggedSessionId.value = null
  activeDropTarget.value = null
}
const beginSessionDrag = (event: DragEvent, session: AgentSessionSummary): void => {
  if (!canDragSession(session)) {
    event.preventDefault()
    return
  }
  draggedSessionId.value = session.id
  activeDropTarget.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', session.id)
  }
  dragStatus.value = `Dragging ${session.title || 'New conversation'}. Drop it on Recent or a saved folder.`
}
const finishSessionDrag = (): void => {
  if (draggedSessionId.value) dragStatus.value = 'Conversation move cancelled.'
  clearDragState()
}
const setDropTarget = (event: DragEvent, folderId: string | null): void => {
  if (!canDropTo(folderId)) return
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
  refreshError.value = `Showing last-loaded conversation history. ${agents.error}`
  return true
}
const refreshHistory = async (): Promise<void> => {
  if (refreshingHistory.value || savingFolder.value || deleting.value || deletingSession.value || removingFolder.value) return
  refreshingHistory.value = true
  agents.error = ''
  try {
    await Promise.all([agents.reloadSessions(), agents.reloadFolders()])
    committedDeletedSessionIds.value = new Set()
    projectedFolderIds.value = new Map()
    localError.value = ''
    refreshError.value = ''
  } catch (value) {
    refreshError.value = `Showing last-loaded conversation history. ${message(value, 'Conversation history could not be refreshed.')}`
  } finally {
    refreshingHistory.value = false
  }
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


const closeHistory = (): void => {
  agents.cancelSessionTransition()
  emit('close')
}
const requestReset = (): void => {
  if (sessionMutationBusy.value) return
  emit('reset')
}

const openSession = async (sessionId: string): Promise<void> => {
  if (loading.value || refreshingHistory.value || sessionsReloading.value || openingSessionIds.value.size > 0) return
  if (sessionId === thread.value?.session.id) {
    agents.cancelSessionTransition()
    return
  }
  if (openingSessionIds.value.has(sessionId)) return
  localError.value = ''
  updatePendingSet(openingSessionIds, sessionId, true)
  try {
    const opened = await agents.openSession(sessionId)
    if (opened && window.matchMedia('(max-width: 1199.98px)').matches) emit('close')
  } catch (value) {
    localError.value = message(value, 'The conversation could not be opened.')
  } finally {
    updatePendingSet(openingSessionIds, sessionId, false)
  }
}

const moveSession = async (session: AgentSessionSummary, folderId: string | null): Promise<boolean> => {
  if (loading.value || sessionMutationBusy.value || refreshingHistory.value || sessionsReloading.value || openingSessionIds.value.size > 0 || session.folderId === folderId || movingSessionIds.value.has(session.id)) return false
  const title = session.title || 'New conversation'
  const destination = dropDestinationName(folderId)
  const originalLocation = sessionLocationName(session)
  localError.value = ''
  refreshError.value = ''
  agents.error = ''
  dragStatus.value = `Moving ${title} to ${destination}.`
  updatePendingSet(movingSessionIds, session.id, true)
  try {
    await agents.moveSessionToFolder(session.id, folderId)
    setProjectedFolder(session.id, folderId)
    if (!showCommittedRefreshFailure()) clearProjectedFolder(session.id)
    if (folderId && !openFolderIds.value.includes(folderId)) openFolderIds.value.push(folderId)
    dragStatus.value = `Moved ${title} to ${destination}.`
    return true
  } catch (value) {
    localError.value = message(value, 'The conversation could not be moved.')
    dragStatus.value = `${title} could not be moved. It remains in ${originalLocation}.`
    return false
  } finally {
    updatePendingSet(movingSessionIds, session.id, false)
  }
}
const dropSession = async (event: DragEvent, folderId: string | null): Promise<void> => {
  if (!canDropTo(folderId)) return
  event.preventDefault()
  const session = draggedSession.value
  clearDragState()
  if (session) await moveSession(session, folderId)
}
const beginCreateFolder = (): void => {
  if (loading.value) return
  dialogError.value = ''
  editingFolder.value = null
  folderName.value = ''
  folderEditorRestoreTarget.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
  folderEditorOpen.value = true
}
const beginRenameFolder = (folder: AgentConversationFolderView): void => {
  if (loading.value) return
  dialogError.value = ''
  editingFolder.value = folder
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
watch(sessionEditorOpen, async (open, _previous, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
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
const saveFolder = async (): Promise<void> => {
  const name = folderName.value.trim()
  if (!name || loading.value || savingFolder.value || deleting.value) return
  savingFolder.value = true; dialogError.value = ''
  try {
    if (editingFolder.value) await agents.renameFolder(editingFolder.value.id, editingFolder.value.version, name)
    else await agents.createFolder(name)
    folderEditorOpen.value = false
  } catch (value) { dialogError.value = message(value, 'The folder could not be saved.') }
  finally { savingFolder.value = false }
}
watch(folderEditorOpen, async (open, _previous, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  if (open) return
  await nextTick()
  if (cancelled) return
  const target = folderEditorRestoreTarget.value
  folderEditorRestoreTarget.value = null
  if (target?.isConnected && !target.closest('[inert], [aria-hidden="true"]')) target.focus()
})
const deleteSession = async (): Promise<void> => {
  const session = deletingSession.value
  if (!session || deleting.value || savingFolder.value || sessionMutationBusy.value) return
  deleting.value = true; dialogError.value = ''; refreshError.value = ''; agents.error = ''
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
  deleting.value = true; dialogError.value = ''; refreshError.value = ''; agents.error = ''
  try {
    await agents.deleteFolder(folder.id)
    for (const sessionId of affectedSessionIds) setProjectedFolder(sessionId, null)
    openFolderIds.value = openFolderIds.value.filter(id => id !== folder.id)
    destructiveRestoreTarget.value = componentElement(historyCloseButton.value)
    removingFolder.value = null
    if (!showCommittedRefreshFailure()) {
      for (const sessionId of affectedSessionIds) clearProjectedFolder(sessionId)
    }
  } catch (value) {
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
watch([deletingSession, removingFolder], async ([session, folder], _previous, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
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
onBeforeUnmount(() => {
  destructiveFocusScope?.deactivate({ restoreFocus: false })
  agents.cancelSessionTransition()
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
.agent-history__header {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-4) var(--wiki-space-4) var(--wiki-space-3);
}
.agent-history__mark {
  align-items: center;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 12%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 24%, transparent);
  border-radius: var(--wiki-control-radius);
  color: rgb(var(--v-theme-primary));
  display: flex;
  height: var(--wiki-control-height);
  justify-content: center;
  width: var(--wiki-control-height);
}
.agent-history__heading { flex: 1; min-width: 0; }
.agent-history__kicker {
  color: rgb(var(--v-theme-primary));
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .08em;
  margin: 0 0 var(--wiki-space-1);
  text-transform: uppercase;
}
.agent-history__heading h2 { font-size: 1rem; font-weight: 700; line-height: 1.2; margin: 0; }
.agent-history__intro { color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent); font-size: .72rem; margin: var(--wiki-space-1) 0 0; }
.agent-history__actions {
  display: flex;
  flex: 0 0 auto;
  gap: var(--wiki-space-2);
  padding: 0 var(--wiki-space-4) var(--wiki-space-3);
}
.agent-history__new-folder { flex: 1; }
.agent-history__search { flex: 0 0 auto; padding: 0 var(--wiki-space-4) var(--wiki-space-3); position: relative; }
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
.agent-history__body {
  flex: 1 1 auto;
  min-height: 0;
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
.agent-history__folders { padding-top: var(--wiki-space-4); }
.agent-history__section-heading {
  align-items: center;
  display: flex;
  gap: var(--wiki-space-3);
  justify-content: space-between;
  padding: var(--wiki-space-2) var(--wiki-space-2) var(--wiki-space-3);
}
.agent-history__section-heading--folders { padding-top: 0; }
.agent-history__section-title { font-size: .78rem; font-weight: 750; letter-spacing: .035em; margin: 0; }
.agent-history__section-copy { color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent); font-size: var(--wiki-type-micro, .75rem); margin-top: var(--wiki-space-1); }
.agent-history__count,
.agent-history__retained {
  align-items: center;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 20%, transparent);
  border-radius: var(--wiki-radius-pill);
  color: rgb(var(--v-theme-primary));
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
.agent-history__session :deep(.v-list-item-title) { font-size: .79rem; font-weight: 600; line-height: 1.35; }
.agent-history__session :deep(.v-list-item-subtitle) { font-size: .67rem; opacity: .62; }
.agent-history__session :deep(.v-list-item__prepend) { margin-inline-end: var(--wiki-space-2); }
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
.agent-history__folder-title { font-size: .78rem; min-height: var(--wiki-control-height) !important; padding: var(--wiki-space-2) var(--wiki-space-2) var(--wiki-space-2) var(--wiki-space-3) !important; }
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
.agent-history__folder-row { align-items: stretch; display: flex; }
.agent-history__folder-row .agent-history__folder-title { flex: 1; min-width: 0; }
.agent-history__folder-actions { align-self: center; flex: 0 0 auto; margin-inline-end: var(--wiki-space-1); }
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
  .agent-history__header { padding-block-start: max(var(--wiki-space-4), env(safe-area-inset-top)); }
  .agent-history__header,
  .agent-history__actions,
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
