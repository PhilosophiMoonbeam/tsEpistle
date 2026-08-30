<template>
    <v-card class="agent-memory" rounded="xl">
      <div class="agent-memory__hero pa-5 pb-4">
        <div class="d-flex align-start ga-4">
          <v-avatar color="primary" size="46" variant="tonal">
            <v-icon icon="mdi-brain" size="25" />
          </v-avatar>
          <div class="flex-grow-1">
            <div class="d-flex align-center flex-wrap ga-2">
              <h2 class="text-title-medium font-weight-medium">Agent memory</h2>
              <v-chip color="primary" size="x-small" variant="tonal">New conversations</v-chip>
            </div>
            <p class="text-body-medium text-medium-emphasis mt-1 mb-0">
              A small, curated set of details the Agent carries between conversations.
            </p>
          </div>
          <v-btn icon="mdi-close" variant="text" aria-label="Close agent memory" @click="open = false" />
        </div>
      </div>

      <v-divider />
      <v-card-text class="agent-memory__body pa-5">
        <v-progress-linear v-if="loading" class="mb-4" indeterminate color="primary" aria-label="Loading agent memory" />
        <v-alert v-if="error" class="mb-4" type="error" variant="tonal" closable @click:close="error = ''">
          {{ error }} <v-btn variant="text" size="small" @click="load">Retry</v-btn>
        </v-alert>
        <div v-if="loaded && loading" class="text-body-small text-medium-emphasis mb-3">Refreshing memory…</div>

        <template v-if="loaded">
          <v-expand-transition>
            <v-sheet v-if="editing" class="agent-memory__editor pa-4 mb-5" border rounded="lg">
              <div class="d-flex align-center mb-3">
                <div class="text-title-medium font-weight-medium">{{ editing.id ? 'Edit memory' : 'Add memory' }}</div>
                <v-spacer />
                <v-btn icon="mdi-close" size="small" variant="text" aria-label="Cancel memory edit" @click="cancelEdit" />
              </div>
              <v-btn-toggle v-model="draftTarget" class="mb-4" color="primary" divided mandatory variant="outlined">
                <v-btn value="user" prepend-icon="mdi-account-outline">About you</v-btn>
                <v-btn value="agent" prepend-icon="mdi-notebook-outline">Agent notes</v-btn>
              </v-btn-toggle>
              <v-textarea v-model="draftContent" :counter="targetLimit" :maxlength="targetLimit" :label="draftTarget === 'user' ? 'Preference or personal detail' : 'Project, environment, or workflow fact'" rows="3" auto-grow autofocus variant="outlined" @keydown.meta.enter="save" @keydown.ctrl.enter="save" />
              <div class="d-flex justify-end ga-2">
                <v-btn variant="text" @click="cancelEdit">Cancel</v-btn>
                <v-btn color="primary" :disabled="!draftContent.trim() || saving" :loading="saving" @click="save">Save memory</v-btn>
              </div>
            </v-sheet>
          </v-expand-transition>

          <section v-for="section in sections" :key="section.target" class="agent-memory__section mb-4" :aria-labelledby="`agent-memory-${section.target}`">
            <div class="d-flex align-center ga-3 mb-2">
              <v-avatar :color="section.color" size="34" variant="tonal"><v-icon :icon="section.icon" size="19" /></v-avatar>
              <div class="flex-grow-1">
                <h3 :id="`agent-memory-${section.target}`" class="text-title-medium font-weight-medium">{{ section.title }}</h3>
                <div class="text-body-small text-medium-emphasis">{{ section.description }}</div>
              </div>
              <span class="text-body-small text-medium-emphasis">{{ section.store.characters.toLocaleString() }} / {{ section.store.limit.toLocaleString() }}</span>
            </div>
            <v-progress-linear class="agent-memory__capacity mb-3" :color="section.store.characters / section.store.limit > .8 ? 'warning' : section.color" :model-value="section.store.characters / section.store.limit * 100" height="3" rounded />
            <div v-if="section.store.entries.length" class="agent-memory__entries">
              <div v-for="entry in section.store.entries" :key="entry.id" class="agent-memory__entry pa-3">
                <p class="text-body-medium mb-0">{{ entry.content }}</p>
                <div class="agent-memory__entry-actions">
                  <v-btn icon="mdi-pencil-outline" size="x-small" variant="text" :aria-label="`Edit memory: ${entry.content}`" :disabled="Boolean(actionBusy)" @click="beginEdit(entry)" />
                  <v-btn icon="mdi-delete-outline" size="x-small" variant="text" color="error" :aria-label="`Remove memory: ${entry.content}`" :disabled="Boolean(actionBusy)" @click="dialogError = ''; removing = entry" />
                </div>
              </div>
            </div>
            <v-sheet v-else class="agent-memory__empty pa-4 text-body-medium text-medium-emphasis" rounded="lg">{{ section.empty }}</v-sheet>
          </section>
          <v-alert class="mt-5" color="info" icon="mdi-shield-lock-outline" variant="tonal">Memory is private to your Wiki account and bounded by design. Never store passwords, API keys, or short-lived details.</v-alert>
        </template>

      </v-card-text>

      <v-divider />
      <v-card-actions class="px-5 py-4">
        <v-btn
          color="error"
          icon="mdi-delete-sweep-outline"
          variant="text"
          aria-label="Clear memory"
          :disabled="memoryCount === 0 || Boolean(actionBusy)"
          @click="clearError = ''; clearing = true"
        />
        <v-spacer />
        <v-btn color="primary" prepend-icon="mdi-plus" variant="flat" :disabled="Boolean(actionBusy)" @click="beginAdd">Add memory</v-btn>
      </v-card-actions>
    </v-card>

  <v-dialog :model-value="Boolean(removing)" max-width="28rem" @update:model-value="value => { if (!value) removing = null }">
    <v-card rounded="xl" title="Remove this memory?">
      <v-card-text>
        <v-alert v-if="dialogError" class="mb-3" type="error" variant="tonal" density="compact">{{ dialogError }}</v-alert>
        <p class="mb-3">It will no longer appear in new conversations.</p>
        <v-sheet v-if="removing" class="pa-3 text-body-medium" color="surface-variant" rounded="lg">{{ removing.content }}</v-sheet>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="Boolean(actionBusy)" @click="removing = null">Cancel</v-btn>
        <v-btn color="error" :loading="actionBusy === 'remove'" :disabled="Boolean(actionBusy)" @click="remove">Remove</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="clearing" max-width="28rem">
    <v-card rounded="xl" title="Clear all Agent memory?">
      <v-card-text>
        <v-alert v-if="clearError" class="mb-3" type="error" variant="tonal" density="compact">{{ clearError }}</v-alert>
        This removes every saved preference and Agent note. Conversation history is not affected.
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="Boolean(actionBusy)" @click="clearing = false">Cancel</v-btn>
        <v-btn color="error" :loading="actionBusy === 'clear'" :disabled="Boolean(actionBusy)" @click="clear">Clear memory</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { clearAgentMemories, createAgentMemory, getAgentMemories, removeAgentMemory, updateAgentMemory, type AgentMemoryEntry, type AgentMemoryTarget, type AgentMemoryView } from '../../helpers/agents-api.ts'

const props = defineProps<{ csrfToken: string }>()
const open = defineModel<boolean>({ required: true })
const emptyStore = (limit: number) => ({ entries: [] as AgentMemoryEntry[], characters: 0, limit })
const loading = ref(false)
const loaded = ref(false)
const saving = ref(false)
const actionBusy = ref('')
const error = ref('')
const dialogError = ref('')
const clearError = ref('')
const memories = ref<AgentMemoryView>({ agent: emptyStore(2_200), user: emptyStore(1_375) })
const editing = ref<{ id: string; version: number } | null>(null)
const removing = ref<AgentMemoryEntry | null>(null)
const clearing = ref(false)
const draftTarget = ref<AgentMemoryTarget>('user')
const draftContent = ref('')
const targetLimit = computed(() => memories.value[draftTarget.value].limit)
const memoryCount = computed(() => memories.value.user.entries.length + memories.value.agent.entries.length)

const sections = computed(() => [
  { target: 'user' as const, title: 'About you', description: 'Preferences, role, communication style, and working habits.', empty: 'No profile memories yet. The Agent can learn durable preferences as you work together.', icon: 'mdi-account-outline', color: 'primary', store: memories.value.user },
  { target: 'agent' as const, title: 'Agent notes', description: 'Stable project, environment, convention, and workflow facts.', empty: 'No Agent notes yet. Useful project context can be carried into future conversations.', icon: 'mdi-notebook-outline', color: 'secondary', store: memories.value.agent }
])
const message = (value: unknown, fallback: string): string => value instanceof Error ? value.message : fallback
const load = async (): Promise<void> => {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try { memories.value = await getAgentMemories(window.fetch.bind(window), props.csrfToken); loaded.value = true }
  catch (value) { error.value = message(value, 'Agent memory could not be loaded.') }
  finally { loading.value = false }
}
const cancelEdit = (): void => {
  editing.value = null
  draftTarget.value = 'user'
  draftContent.value = ''
}
const beginAdd = (): void => {
  editing.value = { id: '', version: 0 }
  draftTarget.value = 'user'
  draftContent.value = ''
}
const beginEdit = (entry: AgentMemoryEntry): void => {
  editing.value = { id: entry.id, version: entry.version }
  draftTarget.value = entry.target
  draftContent.value = entry.content
}
const save = async (): Promise<void> => {
  const current = editing.value
  const content = draftContent.value.trim()
  if (!current || !content || saving.value || actionBusy.value) return
  saving.value = true; actionBusy.value = 'save'; error.value = ''
  try {
    if (current.id) await updateAgentMemory(window.fetch.bind(window), props.csrfToken, current.id, { expectedVersion: current.version, target: draftTarget.value, content })
    else await createAgentMemory(window.fetch.bind(window), props.csrfToken, { target: draftTarget.value, content })
    cancelEdit(); await load()
  } catch (value) { error.value = message(value, 'Memory could not be saved.') }
  finally { saving.value = false; actionBusy.value = '' }
}
const remove = async (): Promise<void> => {
  const entry = removing.value
  if (!entry || saving.value || actionBusy.value) return
  saving.value = true; actionBusy.value = 'remove'; dialogError.value = ''
  try { await removeAgentMemory(window.fetch.bind(window), props.csrfToken, entry.id, entry.version); removing.value = null; await load() }
  catch (value) { dialogError.value = message(value, 'Memory could not be removed.') }
  finally { saving.value = false; actionBusy.value = '' }
}
const clear = async (): Promise<void> => {
  if (saving.value || actionBusy.value) return
  saving.value = true; actionBusy.value = 'clear'; clearError.value = ''
  try { await clearAgentMemories(window.fetch.bind(window), props.csrfToken); clearing.value = false; cancelEdit(); await load() }
  catch (value) { clearError.value = message(value, 'Agent memory could not be cleared.') }
  finally { saving.value = false; actionBusy.value = '' }
}

watch(open, value => { if (value) void load() }, { immediate: true })
</script>

<style scoped>
.agent-memory {
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 97%, rgb(var(--v-theme-primary)) 3%);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 14%, transparent);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.agent-memory__hero { background: color-mix(in srgb, rgb(var(--v-theme-primary)) 6%, rgb(var(--v-theme-surface))); flex: 0 0 auto; }
.agent-memory__body { flex: 1 1 auto; max-height: none; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.agent-memory__editor { background: color-mix(in srgb, rgb(var(--v-theme-primary)) 4%, rgb(var(--v-theme-surface))); }
.agent-memory__capacity { opacity: .72; }
.agent-memory__entries { border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 16%, transparent); border-radius: .75rem; overflow: hidden; }
.agent-memory__entry { align-items: flex-start; display: flex; gap: .75rem; justify-content: space-between; }
.agent-memory__entry + .agent-memory__entry { border-top: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 12%, transparent); }
.agent-memory__entry p { overflow-wrap: anywhere; white-space: pre-wrap; }
.agent-memory__entry-actions { display: flex; flex: 0 0 auto; opacity: .62; }
.agent-memory__entry:hover .agent-memory__entry-actions, .agent-memory__entry:focus-within .agent-memory__entry-actions { opacity: 1; }
.agent-memory__empty { background: color-mix(in srgb, rgb(var(--v-theme-surface-variant)) 38%, transparent); border: 1px dashed color-mix(in srgb, rgb(var(--v-theme-on-surface)) 18%, transparent); }
@media (max-width: 1199.98px) {
  .agent-memory {
    border-radius: 0 !important;
    border-end-start-radius: 1rem !important;
    border-start-start-radius: 1rem !important;
  }
}
@media (max-width: 599.98px) {
  .agent-memory { border-radius: 0 !important; border-width: 0; border-inline-start-width: 1px; }
  .agent-memory__body { padding: 1rem !important; }
  .agent-memory__entry-actions { opacity: 1; }
}
@media (forced-colors: active) {
  .agent-memory__entries, .agent-memory__empty { border: 1px solid CanvasText; }
}
</style>
