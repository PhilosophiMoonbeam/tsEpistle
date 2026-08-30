<template>
  <div class="agent-history-session-actions" @click.stop @keydown.stop>
    <v-menu location="bottom end">
      <template #activator="{ props: menuProps }">
        <v-btn
          v-bind="menuProps"
          class="agent-history-session-actions__trigger"
          icon="mdi-dots-horizontal"
          size="small"
          variant="text"
          :aria-label="`Conversation actions for ${session.title || 'New conversation'}`"
        />
      </template>
      <v-list
        class="agent-history-session-actions__menu"
        density="compact"
        min-width="14.5rem"
        :aria-label="`Actions for ${session.title || 'New conversation'}`"
      >
        <v-list-subheader v-if="canMove" class="agent-history-session-actions__heading">
          Move conversation
        </v-list-subheader>
        <v-list-item
          v-if="session.folderId !== null"
          prepend-icon="mdi-history"
          title="Recent"
          subtitle="Returns to the 90-day history window"
          @click="emit('move', null)"
        />
        <v-list-item
          v-for="folder in availableFolders"
          :key="folder.id"
          prepend-icon="mdi-folder-outline"
          :title="folder.name"
          @click="emit('move', folder.id)"
        />
        <v-divider v-if="canMove" class="agent-history-session-actions__divider" />
        <v-list-subheader class="agent-history-session-actions__heading">
          Manage
        </v-list-subheader>
        <v-list-item
          class="agent-history-session-actions__delete text-error"
          prepend-icon="mdi-delete-outline"
          title="Delete conversation"
          subtitle="Permanently removes its messages"
          @click="emit('remove')"
        />
      </v-list>
    </v-menu>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentConversationFolderView } from '../../../shared/agents/contracts.ts'
import type { AgentSessionSummary } from '../../helpers/agents-api.ts'

const props = defineProps<{
  session: AgentSessionSummary
  folders: readonly AgentConversationFolderView[]
}>()
const emit = defineEmits<{
  move: [folderId: string | null]
  remove: []
}>()
const availableFolders = computed(() => props.folders.filter(folder => folder.id !== props.session.folderId))
const canMove = computed(() => props.session.folderId !== null || availableFolders.value.length > 0)
</script>
<style scoped>
.agent-history-session-actions { align-items: center; display: flex; }
.agent-history-session-actions__trigger {
  color: rgba(var(--v-theme-on-surface), .62);
  min-height: var(--wiki-control-height);
  min-width: var(--wiki-control-height);
}
.agent-history-session-actions__trigger:hover,
.agent-history-session-actions__trigger:focus-visible { color: rgb(var(--v-theme-on-surface)); }
.agent-history-session-actions__menu {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  box-shadow: var(--wiki-shadow-md);
  padding-block: var(--wiki-space-1);
}
.agent-history-session-actions__heading {
  color: rgba(var(--v-theme-on-surface), .58);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .07em;
  min-height: 1.75rem;
  text-transform: uppercase;
}
.agent-history-session-actions__divider { margin-block: var(--wiki-space-1); }
.agent-history-session-actions__delete { color: rgb(var(--v-theme-error)); }
.agent-history-session-actions__menu :deep(.v-list-item-subtitle) {
  font-size: .68rem;
  line-height: 1.35;
}
@media (max-width: 600px), (pointer: coarse) {
  .agent-history-session-actions__trigger { min-height: var(--wiki-control-height); min-width: var(--wiki-control-height); }
}
@media (forced-colors: active) {
  .agent-history-session-actions__trigger:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
}
</style>
