<template>
  <div class="agent-history-session-actions" @click.stop @keydown.stop>
    <v-menu location="bottom end">
      <template #activator="{ props: menuProps }">
        <v-btn
          ref="trigger"
          v-bind="menuProps"
          class="agent-history-session-actions__trigger"
          icon="mdi-dots-horizontal"
          size="small"
          variant="text"
          :aria-label="`Conversation actions for ${session.title || 'New conversation'}`"
          :disabled="busy"
          :loading="busy"
        />
      </template>
      <v-list
        class="agent-history-session-actions__menu"
        density="compact"
        min-width="12rem"
        :aria-label="`Actions for ${session.title || 'New conversation'}`"
      >
        <v-menu v-if="canMove" location="end" submenu>
          <template #activator="{ props: moveMenuProps }">
            <v-list-item
              v-bind="moveMenuProps"
              prepend-icon="mdi-folder-move-outline"
              title="Move"
              :disabled="busy"
            >
              <template #append>
                <v-icon icon="mdi-chevron-right" size="18" />
              </template>
            </v-list-item>
          </template>
          <v-list
            class="agent-history-session-actions__menu"
            density="compact"
            min-width="14.5rem"
            :aria-label="`Move ${session.title || 'New conversation'}`"
          >
            <v-list-item
              v-if="session.folderId !== null"
              prepend-icon="mdi-history"
              title="Recent"
              subtitle="Returns to the 90-day history window"
              :disabled="busy"
              @click="emit('move', null)"
            />
            <v-list-item
              v-for="folder in availableFolders"
              :key="folder.id"
              prepend-icon="mdi-folder-outline"
              :title="folder.name"
              :disabled="busy"
              @click="emit('move', folder.id)"
            />
          </v-list>
        </v-menu>
        <v-divider v-if="canMove" class="agent-history-session-actions__divider" />
        <v-list-item
          class="agent-history-session-actions__delete text-error"
          prepend-icon="mdi-delete-outline"
          title="Delete"
          :disabled="busy"
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
}>()
const emit = defineEmits<{
  move: [folderId: string | null]
  remove: [restoreTarget: HTMLElement | null]
}>()
type ComponentRoot = { $el?: HTMLElement }
const trigger = ref<ComponentRoot | HTMLElement | null>(null)
const triggerElement = (): HTMLElement | null => {
  const value = trigger.value
  if (!value) return null
  return value instanceof HTMLElement ? value : value.$el ?? null
}
const requestRemove = (): void => emit('remove', triggerElement())
const availableFolders = computed(() => props.folders.filter(folder => folder.id !== props.session.folderId))
const canMove = computed(() => props.session.folderId !== null || availableFolders.value.length > 0)
</script>
<style scoped>
.agent-history-session-actions { align-items: center; display: flex; }
.agent-history-session-actions__trigger {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
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
