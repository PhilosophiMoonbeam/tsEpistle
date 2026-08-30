<template>
  <v-card
    class="agent-history"
    elevation="0"
    rounded="xl"
    :aria-busy="loading || Boolean(openingSessionId)"
  >
    <header class="agent-history__header">
      <div class="agent-history__mark" aria-hidden="true">
        <v-icon icon="mdi-history" size="21" />
      </div>
      <div class="agent-history__heading">
        <p class="agent-history__kicker">Conversation archive</p>
        <h2>Chat history</h2>
        <p class="agent-history__intro">{{ sessions.length }} {{ sessions.length === 1 ? 'conversation' : 'conversations' }} in this workspace</p>
      </div>
      <v-btn icon="mdi-close" size="small" variant="text" aria-label="Close chat history" @click="closeHistory" />
    </header>

    <div class="agent-history__actions">
      <v-btn class="agent-history__new-folder" color="primary" prepend-icon="mdi-folder-plus-outline" variant="tonal" @click="beginCreateFolder">
        New folder
      </v-btn>
      <v-btn
        color="error"
        icon="mdi-delete-sweep-outline"
        variant="text"
        aria-label="Reset all conversation history"
        :disabled="sessions.length === 0 || loading"
        @click="emit('reset')"
      >
        <v-tooltip activator="parent" location="bottom">Reset all history</v-tooltip>
      </v-btn>
    </div>

    <div class="agent-history__search">
      <v-text-field
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

    <v-alert v-if="localError" class="mx-3 mb-3" density="compact" type="error" variant="tonal" closable @click:close="localError = ''">
      {{ localError }}
    </v-alert>

    <div v-if="loading && sessions.length === 0" class="agent-history__loading" role="status" aria-live="polite">
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
        <section class="agent-history__recent" aria-labelledby="agent-history-recent-title">
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
                  :aria-current="session.id === thread?.session.id ? 'page' : undefined"
                  :title="session.title || 'New conversation'"
                  :subtitle="session.id === thread?.session.id ? `${formatSessionDate(session.lastActivityAt)} · Current session` : formatSessionDate(session.lastActivityAt)"
                  rounded="lg"
                  @click="openSession(session.id)"
                >
                  <template #prepend>
                    <v-progress-circular v-if="openingSessionId === session.id" color="primary" indeterminate size="18" width="2" aria-label="Opening conversation" />
                    <v-icon v-else :icon="session.id === thread?.session.id ? 'mdi-message-text' : 'mdi-message-text-outline'" size="18" />
                  </template>
                  <template #append>
                    <AgentHistorySessionActions
                      :session="session"
                      :folders="folders"
                      @move="folderId => moveSession(session, folderId)"
                      @remove="dialogError = ''; deletingSession = session"
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
            <v-expansion-panel v-for="group in visibleFolderGroups" :key="group.folder.id" :value="group.folder.id" rounded="lg">
              <div class="agent-history__folder-row">
                <v-expansion-panel-title class="agent-history__folder-title">
                  <v-icon class="me-2" color="primary" icon="mdi-folder-outline" size="19" />
                  <span class="agent-history__folder-name">{{ group.folder.name }}</span>
                  <span class="agent-history__folder-count" :aria-label="`${group.sessions.length} conversations`">{{ group.sessions.length }}</span>
                </v-expansion-panel-title>
                <v-menu location="bottom end">
                  <template #activator="{ props: menuProps }">
                    <v-btn v-bind="menuProps" class="agent-history__folder-actions" icon="mdi-dots-horizontal" size="x-small" variant="text" :aria-label="`Actions for ${group.folder.name}`" />
                  </template>
                  <v-list density="compact" :aria-label="`Folder actions for ${group.folder.name}`">
                    <v-list-item prepend-icon="mdi-pencil-outline" title="Rename folder" @click="beginRenameFolder(group.folder)" />
                    <v-divider />
                    <v-list-item class="text-error" prepend-icon="mdi-folder-remove-outline" title="Remove folder" subtitle="Conversations return to Recent" @click="dialogError = ''; removingFolder = group.folder" />
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
                    :title="session.title || 'New conversation'"
                    :subtitle="session.id === thread?.session.id ? `${formatSessionDate(session.lastActivityAt)} · Current session` : formatSessionDate(session.lastActivityAt)"
                    rounded="lg"
                    @click="openSession(session.id)"
                  >
                    <template #prepend>
                      <v-progress-circular v-if="openingSessionId === session.id" color="primary" indeterminate size="18" width="2" aria-label="Opening conversation" />
                      <v-icon v-else :icon="session.id === thread?.session.id ? 'mdi-message-text' : 'mdi-message-text-outline'" size="18" />
                    </template>
                    <template #append>
                      <AgentHistorySessionActions
                        :session="session"
                        :folders="folders"
                        @move="folderId => moveSession(session, folderId)"
                        @remove="dialogError = ''; deletingSession = session"
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
    </div>
  </v-card>

  <v-dialog v-model="folderEditorOpen" max-width="28rem" aria-labelledby="agent-history-folder-editor-title">
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
        <v-btn color="primary" variant="tonal" :disabled="!folderName.trim() || savingFolder" :loading="savingFolder" @click="saveFolder">
          {{ editingFolder ? 'Save name' : 'Create folder' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="Boolean(deletingSession)" max-width="29rem" aria-labelledby="agent-history-delete-title" @update:model-value="value => { if (!value) deletingSession = null }">
    <v-card rounded="xl">
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
        <v-btn variant="text" :disabled="deleting" @click="deletingSession = null">Cancel</v-btn>
        <v-btn color="error" variant="tonal" :loading="deleting" :disabled="deleting" @click="deleteSession">Delete permanently</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="Boolean(removingFolder)" max-width="30rem" aria-labelledby="agent-history-remove-folder-title" @update:model-value="value => { if (!value) removingFolder = null }">
    <v-card rounded="xl">
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
        <v-btn variant="text" :disabled="deleting" @click="removingFolder = null">Cancel</v-btn>
        <v-btn color="warning" variant="tonal" :loading="deleting" :disabled="deleting" @click="deleteFolder">Remove folder</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { AgentConversationFolderView } from '../../../shared/agents/contracts.ts'
import type { AgentSessionSummary } from '../../helpers/agents-api.ts'
import { useAgentsStore } from '../../store/agents.ts'
import AgentHistorySessionActions from './agent-history-session-actions.vue'
const emit = defineEmits<{ close: []; reset: [] }>()
const agents = useAgentsStore()
const { folders, loading, sessions, thread } = storeToRefs(agents)
const openFolderIds = ref<string[]>([])
const localError = ref('')
const folderEditorOpen = ref(false)
const folderName = ref('')
const editingFolder = ref<AgentConversationFolderView | null>(null)
const savingFolder = ref(false)
const deletingSession = ref<AgentSessionSummary | null>(null)
const removingFolder = ref<AgentConversationFolderView | null>(null)
const dialogError = ref('')
const deleting = ref(false)
const searchQuery = ref<string | null>('')
const openingSessionId = ref<string | null>(null)

const normalizedSearch = computed(() => (searchQuery.value ?? '').trim().toLocaleLowerCase())
const sessionMatchesSearch = (session: AgentSessionSummary): boolean =>
  !normalizedSearch.value || (session.title || 'New conversation').toLocaleLowerCase().includes(normalizedSearch.value)
const filteredRecentSessions = computed(() =>
  sessions.value.filter(session => session.folderId === null && sessionMatchesSearch(session)))
const sessionsForFolder = (folderId: string): AgentSessionSummary[] =>
  sessions.value.filter(session => session.folderId === folderId)
const visibleFolderGroups = computed(() => folders.value.flatMap(folder => {
  const folderSessions = sessionsForFolder(folder.id)
  const folderMatches = folder.name.toLocaleLowerCase().includes(normalizedSearch.value)
  const visibleSessions = !normalizedSearch.value || folderMatches
    ? folderSessions
    : folderSessions.filter(sessionMatchesSearch)
  return folderMatches || visibleSessions.length ? [{ folder, sessions: visibleSessions }] : []
}))
const hasSearchResults = computed(() => filteredRecentSessions.value.length > 0 || visibleFolderGroups.value.length > 0)
const matchingConversationCount = computed(() =>
  filteredRecentSessions.value.length + visibleFolderGroups.value.reduce((count, group) => count + group.sessions.length, 0))
const searchStatus = computed(() => normalizedSearch.value
  ? `${matchingConversationCount.value} matching ${matchingConversationCount.value === 1 ? 'conversation' : 'conversations'}`
  : '')
const calendarDay = (value: Date): number => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())
const sessionTimeGroup = (value: string): string => {
  const daysAgo = Math.floor((calendarDay(new Date()) - calendarDay(new Date(value))) / 86_400_000)
  if (daysAgo <= 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo < 7) return 'Previous 7 days'
  return 'Earlier'
}
const recentSessionGroups = computed(() => {
  const labels = ['Today', 'Yesterday', 'Previous 7 days', 'Earlier']
  return labels.flatMap(label => {
    const groupedSessions = filteredRecentSessions.value.filter(session => sessionTimeGroup(session.lastActivityAt) === label)
    return groupedSessions.length ? [{ label, sessions: groupedSessions }] : []
  })
})
const message = (value: unknown, fallback: string): string => value instanceof Error ? value.message : fallback

const formatSessionDate = (value: string): string => {
  const date = new Date(value)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' }).format(date)
}
const closeHistory = (): void => {
  agents.cancelSessionTransition()
  emit('close')
}


const openSession = async (sessionId: string): Promise<void> => {
  if (sessionId === thread.value?.session.id) {
    agents.cancelSessionTransition()
    return
  }
  localError.value = ''
  openingSessionId.value = sessionId
  try {
    const opened = await agents.openSession(sessionId)
    if (opened && window.matchMedia('(max-width: 1199.98px)').matches) emit('close')
  } catch (value) {
    localError.value = message(value, 'The conversation could not be opened.')
  } finally {
    if (openingSessionId.value === sessionId) openingSessionId.value = null
  }
}

const moveSession = async (session: AgentSessionSummary, folderId: string | null): Promise<void> => {
  if (session.folderId === folderId) return
  localError.value = ''
  try {
    await agents.moveSessionToFolder(session.id, folderId)
    if (folderId && !openFolderIds.value.includes(folderId)) openFolderIds.value.push(folderId)
  } catch (value) {
    localError.value = message(value, 'The conversation could not be moved.')
  }
}

const beginCreateFolder = (): void => { dialogError.value = ''; editingFolder.value = null; folderName.value = ''; folderEditorOpen.value = true }
const beginRenameFolder = (folder: AgentConversationFolderView): void => { dialogError.value = ''; editingFolder.value = folder; folderName.value = folder.name; folderEditorOpen.value = true }
const saveFolder = async (): Promise<void> => {
  const name = folderName.value.trim()
  if (!name || savingFolder.value || deleting.value) return
  savingFolder.value = true; dialogError.value = ''
  try {
    if (editingFolder.value) await agents.renameFolder(editingFolder.value.id, editingFolder.value.version, name)
    else await agents.createFolder(name)
    folderEditorOpen.value = false
  } catch (value) { dialogError.value = message(value, 'The folder could not be saved.') }
  finally { savingFolder.value = false }
}
const deleteSession = async (): Promise<void> => {
  const session = deletingSession.value
  if (!session || deleting.value || savingFolder.value) return
  deleting.value = true; dialogError.value = ''
  try { await agents.removeSession(session.id); deletingSession.value = null }
  catch (value) { dialogError.value = message(value, 'The conversation could not be deleted.') }
  finally { deleting.value = false }
}
const deleteFolder = async (): Promise<void> => {
  const folder = removingFolder.value
  if (!folder || deleting.value || savingFolder.value) return
  deleting.value = true; dialogError.value = ''
  try { await agents.deleteFolder(folder.id); openFolderIds.value = openFolderIds.value.filter(id => id !== folder.id); removingFolder.value = null }
  catch (value) { dialogError.value = message(value, 'The folder could not be removed.') }
  finally { deleting.value = false }
}
const expandActiveFolder = (): void => {
  const activeId = thread.value?.session.id
  const activeSession = sessions.value.find(session => session.id === activeId)
  if (activeSession?.folderId && !openFolderIds.value.includes(activeSession.folderId)) openFolderIds.value.push(activeSession.folderId)
}
watch(() => thread.value?.session.id, expandActiveFolder, { immediate: true })
watch(folders, expandActiveFolder, { immediate: true })
watch(normalizedSearch, query => {
  if (!query) return
  const visibleIds = visibleFolderGroups.value.map(group => group.folder.id)
  openFolderIds.value = [...new Set([...openFolderIds.value, ...visibleIds])]
})
onBeforeUnmount(() => agents.cancelSessionTransition())


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
.agent-history__intro { color: rgba(var(--v-theme-on-surface), .62); font-size: .72rem; margin: var(--wiki-space-1) 0 0; }
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
.agent-history__loading {
  align-items: center;
  color: rgba(var(--v-theme-on-surface), .68);
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
.agent-history__recent { border-bottom: 1px solid var(--wiki-surface-border); padding-bottom: var(--wiki-space-3); }
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
.agent-history__section-copy { color: rgba(var(--v-theme-on-surface), .56); font-size: .67rem; margin-top: var(--wiki-space-1); }
.agent-history__count,
.agent-history__retained {
  align-items: center;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 20%, transparent);
  border-radius: var(--wiki-radius-pill);
  color: rgb(var(--v-theme-primary));
  display: inline-flex;
  font-size: .65rem;
  font-weight: 700;
  gap: var(--wiki-space-1);
  line-height: 1;
  padding: var(--wiki-space-1) var(--wiki-space-2);
}
.agent-history__time-group + .agent-history__time-group { margin-top: var(--wiki-space-2); }
.agent-history__time-label {
  color: rgba(var(--v-theme-on-surface), .5);
  font-size: .63rem;
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
  color: rgba(var(--v-theme-on-surface), .62);
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
  background: rgba(var(--v-theme-on-surface), .08);
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
  .agent-history__session.v-list-item--active::before { background: Highlight; }
}
</style>
