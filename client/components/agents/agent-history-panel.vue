<template>
  <v-card class="agent-history" elevation="0" rounded="xl">
    <header class="agent-history__header">
      <div class="agent-history__mark" aria-hidden="true">
        <v-icon icon="mdi-history" size="21" />
      </div>
      <div class="agent-history__heading">
        <h2>Chat history</h2>
        <p>Find, file, and revisit your work.</p>
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
        :disabled="sessions.length === 0"
        @click="emit('reset')"
      />
    </div>

    <v-alert v-if="localError" class="mx-3 mb-3" density="compact" type="error" variant="tonal" closable @click:close="localError = ''">
      {{ localError }}
    </v-alert>

    <div class="agent-history__body">
      <section class="agent-history__recent" aria-labelledby="agent-history-recent-title">
        <div class="agent-history__section-heading">
          <div>
            <h3 id="agent-history-recent-title" class="agent-history__section-title">Recent</h3>
            <div class="agent-history__section-copy">Removed 90 days after last activity</div>
          </div>
          <v-chip size="x-small" variant="tonal">{{ recentSessions.length }}</v-chip>
        </div>
        <v-list v-if="recentSessions.length" class="agent-history__list" density="compact" nav>
          <v-list-item
            v-for="session in recentSessions"
            :key="session.id"
            class="agent-history__session"
            :active="session.id === thread?.session.id"
            :title="session.title || 'New conversation'"
            :subtitle="formatSessionDate(session.lastActivityAt)"
            rounded="lg"
            @click="openSession(session.id)"
          >
            <template #prepend>
              <v-icon :icon="session.id === thread?.session.id ? 'mdi-message-text' : 'mdi-message-text-outline'" size="18" />
            </template>
            <template #append>
              <AgentHistorySessionActions
                :session="session"
                :folders="folders"
                @move="folderId => moveSession(session, folderId)"
                @remove="deletingSession = session"
              />
            </template>
          </v-list-item>
        </v-list>
        <div v-else class="agent-history__empty">
          <v-icon icon="mdi-message-outline" size="20" />
          <span>Your unfiled conversations appear here.</span>
        </div>
      </section>

      <section class="agent-history__folders" aria-labelledby="agent-history-folders-title">
        <div class="agent-history__section-heading agent-history__section-heading--folders">
          <div>
            <h3 id="agent-history-folders-title" class="agent-history__section-title">Folders</h3>
            <div class="agent-history__section-copy">Conversations here never expire</div>
          </div>
          <v-chip color="primary" size="x-small" variant="tonal">Kept</v-chip>
        </div>

        <v-expansion-panels v-if="folders.length" v-model="openFolderIds" class="agent-history__folder-panels" multiple variant="accordion">
          <v-expansion-panel v-for="folder in folders" :key="folder.id" :value="folder.id" rounded="lg">
            <div class="agent-history__folder-row">
              <v-expansion-panel-title class="agent-history__folder-title">
                <v-icon class="me-2" color="primary" icon="mdi-folder-outline" size="19" />
                <span class="agent-history__folder-name">{{ folder.name }}</span>
                <span class="agent-history__folder-count">{{ sessionsForFolder(folder.id).length }}</span>
              </v-expansion-panel-title>
              <v-menu location="bottom end">
                <template #activator="{ props: menuProps }">
                  <v-btn v-bind="menuProps" class="agent-history__folder-actions" icon="mdi-dots-horizontal" size="x-small" variant="text" :aria-label="`Actions for ${folder.name}`" />
                </template>
                <v-list density="compact">
                  <v-list-item prepend-icon="mdi-pencil-outline" title="Rename folder" @click="beginRenameFolder(folder)" />
                  <v-list-item class="text-error" prepend-icon="mdi-folder-remove-outline" title="Remove folder" @click="dialogError = ''; removingFolder = folder" />
                </v-list>
              </v-menu>
            </div>
            <v-expansion-panel-text>
              <v-list v-if="sessionsForFolder(folder.id).length" class="agent-history__list agent-history__list--folder" density="compact" nav>
                <v-list-item
                  v-for="session in sessionsForFolder(folder.id)"
                  :key="session.id"
                  class="agent-history__session"
                  :active="session.id === thread?.session.id"
                  :title="session.title || 'New conversation'"
                  :subtitle="formatSessionDate(session.lastActivityAt)"
                  rounded="lg"
                  @click="openSession(session.id)"
                >
                  <template #prepend>
                    <v-icon :icon="session.id === thread?.session.id ? 'mdi-message-text' : 'mdi-message-text-outline'" size="18" />
                  </template>
                  <template #append>
                    <AgentHistorySessionActions
                      :session="session"
                      :folders="folders"
                      @move="folderId => moveSession(session, folderId)"
                      @remove="deletingSession = session"
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
    </div>
  </v-card>

  <v-dialog v-model="folderEditorOpen" max-width="28rem">
    <v-card rounded="xl">
      <v-card-title class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="primary" size="38" variant="tonal"><v-icon icon="mdi-folder-outline" /></v-avatar>
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
        <v-btn color="primary" :disabled="!folderName.trim() || savingFolder" :loading="savingFolder" @click="saveFolder">
          {{ editingFolder ? 'Save' : 'Create folder' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="Boolean(deletingSession)" max-width="29rem" @update:model-value="value => { if (!value) deletingSession = null }">
    <v-card rounded="xl">
      <v-card-title class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="error" size="38" variant="tonal"><v-icon icon="mdi-delete-outline" /></v-avatar>
        Delete conversation?
      </v-card-title>
      <v-card-text class="px-5">
        <v-alert v-if="dialogError" class="mb-3" type="error" variant="tonal" density="compact">{{ dialogError }}</v-alert>
        <strong>{{ deletingSession?.title || 'New conversation' }}</strong> and its messages will be permanently removed.
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" :disabled="deleting" @click="deletingSession = null">Cancel</v-btn>
        <v-btn color="error" :loading="deleting" :disabled="deleting" @click="deleteSession">Delete</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="Boolean(removingFolder)" max-width="30rem" @update:model-value="value => { if (!value) removingFolder = null }">
    <v-card rounded="xl">
      <v-card-title class="d-flex align-center ga-3 pt-5 px-5">
        <v-avatar color="warning" size="38" variant="tonal"><v-icon icon="mdi-folder-remove-outline" /></v-avatar>
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
        <v-btn color="warning" :loading="deleting" :disabled="deleting" @click="deleteFolder">Remove folder</v-btn>
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
const { folders, sessions, thread } = storeToRefs(agents)
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

const recentSessions = computed(() => sessions.value.filter(session => session.folderId === null))
const sessionsForFolder = (folderId: string): AgentSessionSummary[] => sessions.value.filter(session => session.folderId === folderId)
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
  try {
    const opened = await agents.openSession(sessionId)
    if (opened && window.matchMedia('(max-width: 1199.98px)').matches) emit('close')
  } catch (value) {
    localError.value = message(value, 'The conversation could not be opened.')
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
onBeforeUnmount(() => agents.cancelSessionTransition())


</script>

<style scoped>
.agent-history {
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 97%, rgb(var(--v-theme-primary)) 3%);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 14%, transparent);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.agent-history__actions { display: flex; flex: 0 0 auto; gap: .35rem; padding: 0 .85rem .85rem; }
.agent-history__new-folder { flex: 1; }
.agent-history__header { align-items: center; display: flex; flex: 0 0 auto; gap: .7rem; padding: 1rem .85rem .8rem; }
.agent-history__mark { align-items: center; background: color-mix(in srgb, rgb(var(--v-theme-primary)) 14%, transparent); border-radius: .75rem; color: rgb(var(--v-theme-primary)); display: flex; height: 2.35rem; justify-content: center; width: 2.35rem; }
.agent-history__heading { flex: 1; min-width: 0; }
.agent-history__heading h2 { font-size: 1rem; font-weight: 650; line-height: 1.25; margin: 0; }
.agent-history__heading p { font-size: .74rem; margin: .12rem 0 0; opacity: .62; }
.agent-history__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 .65rem 1rem; }
.agent-history__recent { border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 10%, transparent); padding-bottom: .8rem; }
.agent-history__folders { padding-top: .9rem; }
.agent-history__section-heading { align-items: center; display: flex; gap: .75rem; justify-content: space-between; padding: .45rem .4rem .6rem; }
.agent-history__section-heading--folders { padding-top: 0; }
.agent-history__section-title { font-size: .78rem; font-weight: 700; letter-spacing: .035em; }
.agent-history__section-copy { font-size: .67rem; margin-top: .08rem; opacity: .56; }
.agent-history__list { background: transparent; padding: 0; }
.agent-history__session { margin: .15rem 0; min-height: 3.3rem; }
.agent-history__session :deep(.v-list-item-title) { font-size: .79rem; font-weight: 560; }
.agent-history__session :deep(.v-list-item-subtitle) { font-size: .68rem; }
.agent-history__session :deep(.v-list-item__prepend) { margin-inline-end: .55rem; }
.agent-history__session :deep(.v-list-item__append) { margin-inline-start: .2rem; }
.agent-history__empty { align-items: center; border: 1px dashed color-mix(in srgb, rgb(var(--v-theme-on-surface)) 16%, transparent); border-radius: .75rem; color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent); display: flex; font-size: .72rem; gap: .55rem; line-height: 1.4; padding: .8rem; }
.agent-history__empty--folder { border: 0; padding: .35rem .2rem .6rem; }
.agent-history__empty--folders { margin: .1rem .15rem; }
.agent-history__folder-panels { gap: .4rem; }
.agent-history__folder-panels :deep(.v-expansion-panel) { background: color-mix(in srgb, rgb(var(--v-theme-surface-variant)) 28%, transparent); border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 9%, transparent); }
.agent-history__folder-title { font-size: .78rem; min-height: 3rem !important; padding: .5rem .5rem .5rem .7rem !important; }
.agent-history__folder-title :deep(.v-expansion-panel-title__overlay) { opacity: 0; }
.agent-history__folder-name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-history__folder-count { align-items: center; background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent); border-radius: 999px; display: inline-flex; font-size: .66rem; height: 1.3rem; justify-content: center; margin-inline: .35rem; min-width: 1.3rem; padding-inline: .32rem; }
.agent-history__folder-panels :deep(.v-expansion-panel-text__wrapper) { padding: 0 .35rem .45rem; }
.agent-history__list--folder { padding-inline: 0; }
.agent-history__folder-row { display: flex; align-items: stretch; }
.agent-history__folder-row .agent-history__folder-title { flex: 1; }
.agent-history__folder-actions { align-self: center; flex: 0 0 auto; margin-inline-end: .35rem; }
@media (max-width: 1199.98px) {
  .agent-history {
    border-radius: 0 !important;
    border-end-end-radius: 1rem !important;
    border-start-end-radius: 1rem !important;
  }
}
@media (max-width: 599.98px) {
  .agent-history { border-radius: 0 !important; border-width: 0; border-inline-end-width: 1px; }
  .agent-history__header { padding-top: max(1rem, env(safe-area-inset-top)); }
}
@media (forced-colors: active) {
  .agent-history, .agent-history__empty, .agent-history__folder-panels :deep(.v-expansion-panel) { border: 1px solid CanvasText; }
}
</style>
