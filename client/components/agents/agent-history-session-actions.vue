<template>
  <div class="agent-history-session-actions" @click.stop>
    <v-menu location="bottom end">
      <template #activator="{ props: menuProps }">
        <v-btn
          v-bind="menuProps"
          icon="mdi-dots-horizontal"
          size="x-small"
          variant="text"
          :aria-label="`Actions for ${session.title || 'New conversation'}`"
        />
      </template>
      <v-list density="compact" min-width="13.75rem">
        <v-list-item
          v-if="session.folderId !== null"
          prepend-icon="mdi-history"
          title="Move to Recent"
          @click="emit('move', null)"
        />
        <v-list-subheader v-if="folders.length">Move to folder</v-list-subheader>
        <v-list-item
          v-for="folder in availableFolders"
          :key="folder.id"
          prepend-icon="mdi-folder-outline"
          :title="folder.name"
          @click="emit('move', folder.id)"
        />
        <v-divider />
        <v-list-item
          class="text-error"
          prepend-icon="mdi-delete-outline"
          title="Delete conversation"
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
</script>
