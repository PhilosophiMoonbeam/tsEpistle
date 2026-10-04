<template>
  <div class="agent-history-session-actions" @click.stop @keydown.stop>
    <v-menu content-class="agent-owned-overlay" location="bottom end">
      <template #activator="{ props: moveMenuProps }">
        <v-btn
          v-bind="moveMenuProps"
          @focus="moveTrigger = $event.currentTarget as HTMLElement"
          @click="moveTrigger = $event.currentTarget as HTMLElement"
          class="agent-history-session-actions__move"
          prepend-icon="mdi-folder-move-outline"
          size="small"
          variant="text"
          :aria-label="$t('common:agentHistorySessionActions.move', { title: session.title || $t('common:agentHistorySessionActions.newConversation'), interpolation: { escapeValue: false } })"
          :disabled="busy || disabled"
        >{{ $t('common:actions.move') }}</v-btn>
      </template>
      <v-list
        class="agent-history-session-actions__menu agent-history-session-actions__destinations"
        density="compact"
        min-width="14.5rem"
        :aria-label="$t('common:agentHistorySessionActions.move', { title: session.title || $t('common:agentHistorySessionActions.newConversation'), interpolation: { escapeValue: false } })"
      >
        <v-list-item
          v-if="session.folderId !== null"
          prepend-icon="mdi-history"
          :title="$t('common:agentHistorySessionActions.recent')"
          :subtitle="$t('common:agentHistorySessionActions.returns90DayHistory')"
          :disabled="busy || disabled"
          @click="emit('move', null)"
        />
        <v-list-item
          v-for="folder in availableFolders"
          :key="folder.id"
          prepend-icon="mdi-folder-outline"
          :title="folder.name"
          :disabled="busy || disabled"
          @click="emit('move', folder.id)"
        />
        <v-divider v-if="availableFolders.length || session.folderId !== null" class="agent-history-session-actions__divider" />
        <v-list-item
          prepend-icon="mdi-folder-plus-outline"
          :title="$t('common:agentHistorySessionActions.newFolder')"
          :subtitle="$t('common:agentHistorySessionActions.createFolderConversation')"
          :disabled="busy || disabled"
          @click="requestNewFolder"
        />
      </v-list>
    </v-menu>
    <v-menu content-class="agent-owned-overlay" location="bottom end">
      <template #activator="{ props: menuProps }">
        <v-btn
          v-bind="menuProps"
          @focus="trigger = $event.currentTarget as HTMLElement"
          @click="trigger = $event.currentTarget as HTMLElement"
          class="agent-history-session-actions__trigger"
          icon="mdi-dots-horizontal"
          size="small"
          variant="text"
          :aria-label="$t('common:agentHistorySessionActions.conversationActions', { title: session.title || $t('common:agentHistorySessionActions.newConversation'), interpolation: { escapeValue: false } })"
          :disabled="busy || disabled"
          :loading="busy"
        />
      </template>
      <v-list
        class="agent-history-session-actions__menu"
        density="compact"
        min-width="12rem"
        :aria-label="$t('common:agentHistorySessionActions.actions', { title: session.title || $t('common:agentHistorySessionActions.newConversation'), interpolation: { escapeValue: false } })"
      >
        <v-list-item
          prepend-icon="mdi-pencil-outline"
          :title="$t('common:actions.rename')"
          :disabled="busy || disabled"
          @click="requestRename"
        />
        <v-list-item
          class="agent-history-session-actions__delete text-error"
          prepend-icon="mdi-delete-outline"
          :title="$t('common:actions.delete')"
          :disabled="busy || disabled"
          @click="requestRemove"
        />
      </v-list>
    </v-menu>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentConversationFolderView } from '../../../shared/agents/contracts.ts'
import type { AgentSessionSummary } from '../../helpers/agents-api.ts'

const props = defineProps<{
  session: AgentSessionSummary
  folders: readonly AgentConversationFolderView[]
  busy?: boolean
  disabled?: boolean
}>()
const emit = defineEmits<{
  move: [folderId: string | null]
  'new-folder': [session: AgentSessionSummary, restoreTarget: HTMLElement | null]
  rename: [restoreTarget: HTMLElement | null]
  remove: [restoreTarget: HTMLElement | null]
}>()
// Capture native triggers without overriding VMenu's activator ref.
const trigger = ref<HTMLElement | null>(null)
const moveTrigger = ref<HTMLElement | null>(null)
const requestNewFolder = (): void => emit('new-folder', props.session, moveTrigger.value)
const requestRename = (): void => emit('rename', trigger.value)
const requestRemove = (): void => emit('remove', trigger.value)
const availableFolders = computed(() => props.folders.filter(folder => folder.id !== props.session.folderId))
</script>
<style scoped>
.agent-history-session-actions { align-items: center; display: flex; gap: var(--wiki-space-1); }
.agent-history-session-actions__trigger,
.agent-history-session-actions__move {
  color: var(--wiki-text-muted);
  min-height: 2.5rem;
}
.agent-history-session-actions__trigger { min-width: 2.5rem; }
.agent-history-session-actions__move { letter-spacing: 0; padding-inline: var(--wiki-space-2); text-transform: none; }
.agent-history-session-actions__trigger:hover,
.agent-history-session-actions__move:hover { color: rgb(var(--v-theme-on-surface)); }
.agent-history-session-actions__trigger:focus-visible,
.agent-history-session-actions__move:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 2px; }
.agent-history-session-actions__menu {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  box-shadow: var(--wiki-shadow-md);
  padding-block: var(--wiki-space-1);
}
.agent-history-session-actions__destinations {
  max-height: min(28rem, 65dvh);
  max-width: min(24rem, calc(100vw - 2rem));
  overflow-y: auto;
  overscroll-behavior: contain;
}
.agent-history-session-actions__menu :deep(.v-list-item-title) { overflow-wrap: anywhere; white-space: normal; }
.agent-history-session-actions__divider { margin-block: var(--wiki-space-1); }
.agent-history-session-actions__delete { color: rgb(var(--v-theme-error)); }
.agent-history-session-actions__menu :deep(.v-list-item-subtitle) {
  font-size: var(--wiki-type-micro, .75rem);
  line-height: 1.35;
}
@media (max-width: 599.98px), (pointer: coarse) {
  .agent-history-session-actions__trigger,
  .agent-history-session-actions__move { min-height: 44px; min-width: 44px; }
}
@media (forced-colors: active) {
  .agent-history-session-actions__trigger:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
}
</style>
