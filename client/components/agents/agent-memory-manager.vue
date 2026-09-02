<template>
  <v-card class="agent-memory" elevation="0" rounded="xl" :aria-busy="loading">
    <header class="agent-memory__hero">
      <div class="agent-memory__mark" aria-hidden="true">
        <v-icon icon="mdi-archive-outline" size="21" />
      </div>
      <div class="agent-memory__heading">
        <div class="agent-memory__title-row">
          <h2 class="text-title-medium">Agent memory</h2>
          <span
            v-if="loaded"
            class="agent-memory__count"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >{{ memoryCountLabel }}</span>
        </div>
        <p class="agent-memory__intro">A deliberate snapshot, not hidden learning.</p>
      </div>
      <v-btn ref="memoryCloseButton" class="agent-memory__close" icon="mdi-close" variant="text" aria-label="Close agent memory" @click="open = false" />
    </header>

    <v-divider />
    <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Loading agent memory" />

    <v-card-text class="agent-memory__body">
      <v-alert v-if="error" class="agent-memory__error" type="error" variant="tonal" :closable="!stale" role="alert" @click:close="error = ''">
        <div class="agent-memory__error-content">
          <span>{{ error }}</span>
          <v-btn v-if="!loading" variant="text" size="small" @click="load()">Refresh archive</v-btn>
        </div>
      </v-alert>

      <div v-if="loading && !loaded" class="agent-memory__state" role="status" aria-live="polite">
        <v-progress-circular color="primary" indeterminate :size="24" :width="2" aria-hidden="true" />
        <span>Loading memory…</span>
      </div>

      <template v-else-if="loaded">
        <p v-if="loading" class="agent-memory__refresh" role="status" aria-live="polite">
          <v-icon icon="mdi-sync" size="16" aria-hidden="true" />
          Refreshing memory…
        </p>

        <v-expand-transition>
          <section v-if="editing" class="agent-memory__editor" aria-labelledby="agent-memory-editor-title">
            <header class="agent-memory__editor-header">
              <div>
                <p class="agent-memory__eyebrow">{{ editing.id ? 'Revise record' : 'New record' }}</p>
                <h3 id="agent-memory-editor-title" class="text-title-medium">{{ editing.id ? 'Edit memory' : 'Add to memory' }}</h3>
              </div>
              <v-btn icon="mdi-close" size="small" variant="text" aria-label="Cancel memory edit" @click="cancelEdit" />
            </header>

            <fieldset class="agent-memory__target">
              <legend>Save under</legend>
              <v-btn-toggle v-model="draftTarget" color="primary" divided mandatory variant="outlined">
                <v-btn value="user" prepend-icon="mdi-account-outline">You</v-btn>
                <v-btn value="agent" prepend-icon="mdi-notebook-outline">Agent</v-btn>
              </v-btn-toggle>
            </fieldset>

            <v-textarea
              v-model="draftContent"
              :counter="targetLimit"
              :maxlength="targetLimit"
              :label="draftTarget === 'user' ? 'Preference or personal detail' : 'Project, environment, or workflow fact'"
              :hint="draftCapacityLabel"
              persistent-hint
              rows="3"
              auto-grow
              autofocus
              variant="outlined"
              @keydown.esc="cancelEdit"
              @keydown.meta.enter="save"
              @keydown.ctrl.enter="save"
            />
            <p v-if="draftOverLimit" class="agent-memory__draft-limit" role="alert">{{ draftCapacityLabel }}</p>
            <div class="agent-memory__editor-actions">
              <span class="agent-memory__shortcut">Esc to cancel · <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> to save</span>
              <v-btn variant="text" :disabled="saving" @click="cancelEdit">Cancel</v-btn>
              <v-btn color="primary" :disabled="!draftContent.trim() || draftOverLimit || saving || stale || loading" :loading="saving" @click="save">
                {{ editing.id ? 'Save revision' : 'Save memory' }}
              </v-btn>
            </div>
          </section>
        </v-expand-transition>

        <section
          v-for="section in sections"
          :key="section.target"
          class="agent-memory__section"
          :aria-labelledby="`agent-memory-${section.target}`"
        >
          <header class="agent-memory__section-header">
            <div class="agent-memory__section-mark" :class="`agent-memory__section-mark--${section.target}`" aria-hidden="true">
              <v-icon :icon="section.icon" size="18" />
            </div>
            <h3 :id="`agent-memory-${section.target}`" class="text-title-small">{{ section.title }}</h3>
          </header>

          <div v-if="section.store.entries.length" class="agent-memory__entries">
            <article v-for="(entry, index) in section.store.entries" :key="entry.id" class="agent-memory__entry">
              <div class="agent-memory__entry-index" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</div>
              <div class="agent-memory__entry-content">
                <div class="agent-memory__entry-meta">{{ memoryDateLabel(entry) }}</div>
                <p>{{ entry.content }}</p>
              </div>
              <div class="agent-memory__entry-actions" role="group" :aria-label="`Actions for memory ${index + 1}`">
                <v-btn prepend-icon="mdi-pencil-outline" size="small" variant="text" :aria-label="`Edit memory: ${entry.content}`" :disabled="Boolean(actionBusy) || stale || loading" @click="beginEdit(entry)">Edit</v-btn>
                <v-btn prepend-icon="mdi-delete-outline" size="small" variant="text" color="error" :aria-label="`Remove memory: ${entry.content}`" :disabled="Boolean(actionBusy) || stale || loading" @click="beginRemove(entry, $event)">Remove</v-btn>
              </div>
            </article>
          </div>
          <div v-else class="agent-memory__empty">
            <v-icon :icon="section.icon" size="20" aria-hidden="true" />
            <p>{{ section.empty }}</p>
            <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" :aria-label="`Add ${section.target === 'user' ? 'personal detail' : 'Agent note'} to ${section.title}`" :disabled="Boolean(actionBusy) || stale || loading || !canAddTo(section.target)" @click="beginAdd(section.target)">
              {{ section.target === 'user' ? 'Add detail' : 'Add note' }}
            </v-btn>
          </div>
          <v-alert v-if="!canAddTo(section.target)" class="agent-memory__limit-alert" color="warning" icon="mdi-archive-lock-outline" variant="tonal" density="compact">
            Full. Edit or remove a record to add another.
          </v-alert>
        </section>

        <aside class="agent-memory__safety" aria-label="Memory safety">
          <v-icon icon="mdi-shield-lock-outline" size="18" aria-hidden="true" />
          <p><strong>Private to your account.</strong> Changes apply to future conversations only. Never save passwords, keys, or tokens.</p>
        </aside>
      </template>
    </v-card-text>

    <v-divider />
    <v-card-actions class="agent-memory__footer">
      <v-btn color="error" prepend-icon="mdi-delete-sweep-outline" variant="text" :disabled="Boolean(clearMemoryDisabledReason) || Boolean(actionBusy)" :title="clearMemoryDisabledReason" @click="beginClear($event)">
        Clear archive
      </v-btn>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" variant="flat" :disabled="!canAddMemory || Boolean(actionBusy)" :title="addMemoryDisabledReason" @click="beginAdd()">
        Add memory
      </v-btn>
    </v-card-actions>
  </v-card>

  <v-dialog :model-value="Boolean(removing)" max-width="30rem" :persistent="actionBusy === 'remove'" @update:model-value="value => { if (!value && actionBusy !== 'remove') cancelRemove() }">
    <v-card ref="removeDialogCard" class="agent-memory__dialog" rounded="xl">
      <v-card-title class="agent-memory__dialog-title">
        <v-avatar color="error" size="38" variant="tonal"><v-icon icon="mdi-archive-remove-outline" aria-hidden="true" /></v-avatar>
        <span>Remove this memory?</span>
      </v-card-title>
      <v-card-text>
        <v-alert v-if="dialogError" class="agent-memory__dialog-error" type="error" variant="tonal" density="compact">{{ dialogError }}</v-alert>
        <p>This record will be omitted from conversations started after removal. Existing conversation snapshots are unchanged.</p>
        <blockquote v-if="removing" class="agent-memory__dialog-record">{{ removing.content }}</blockquote>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="Boolean(actionBusy)" @click="cancelRemove">Keep record</v-btn>
        <v-btn color="error" :loading="actionBusy === 'remove'" :disabled="Boolean(actionBusy)" @click="remove">Remove memory</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="clearing" max-width="30rem" :persistent="actionBusy === 'clear'" @update:model-value="value => { if (!value && actionBusy !== 'clear') cancelClear() }">
    <v-card ref="clearDialogCard" class="agent-memory__dialog" rounded="xl">
      <v-card-title class="agent-memory__dialog-title">
        <v-avatar color="error" size="38" variant="tonal"><v-icon icon="mdi-delete-sweep-outline" aria-hidden="true" /></v-avatar>
        <span>Clear the memory archive?</span>
      </v-card-title>
      <v-card-text>
        <v-alert v-if="clearError" class="agent-memory__dialog-error" type="error" variant="tonal" density="compact">{{ clearError }}</v-alert>
        Every saved preference and Agent note will be removed from future conversations. Conversation history and existing memory snapshots are not affected.
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="Boolean(actionBusy)" @click="cancelClear">Keep archive</v-btn>
        <v-btn color="error" :loading="actionBusy === 'clear'" :disabled="Boolean(actionBusy)" @click="clear">Clear archive</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { clearAgentMemories, createAgentMemory, getAgentMemories, removeAgentMemory, updateAgentMemory, type AgentMemoryEntry, type AgentMemoryTarget, type AgentMemoryView } from '../../helpers/agents-api.ts'
import { createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'

const props = defineProps<{ csrfToken: string }>()
const open = defineModel<boolean>({ required: true })
const emptyStore = (limit: number) => ({ entries: [] as AgentMemoryEntry[], characters: 0, limit })
const loading = ref(false)
const loaded = ref(false)
const stale = ref(false)
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
type MemoryStore = AgentMemoryView[AgentMemoryTarget]
type ComponentRoot = { $el?: HTMLElement }
const memoryCloseButton = ref<ComponentRoot | HTMLElement | null>(null)
const removeDialogCard = ref<ComponentRoot | HTMLElement | null>(null)
const clearDialogCard = ref<ComponentRoot | HTMLElement | null>(null)
const destructiveRestoreTarget = ref<HTMLElement | null>(null)
let destructiveFocusScope: ModalFocusScope | null = null
let loadController: AbortController | null = null
let loadGeneration = 0
let disposed = false

const targetLimit = computed(() => memories.value[draftTarget.value].limit)
const memoryCount = computed(() => memories.value.user.entries.length + memories.value.agent.entries.length)
const memoryCountLabel = computed(() => `${memoryCount.value} saved ${memoryCount.value === 1 ? 'record' : 'records'}`)
const memoryEntrySeparatorLength = '\n§\n'.length
const projectedStoreCharacters = computed(() => {
  const currentId = editing.value?.id
  let characters = 0
  let entryCount = 0
  for (const entry of memories.value[draftTarget.value].entries) {
    if (entry.id === currentId) continue
    if (entryCount > 0) characters += memoryEntrySeparatorLength
    characters += entry.content.length
    entryCount += 1
  }
  const content = draftContent.value.trim()
  if (content) characters += content.length + (entryCount > 0 ? memoryEntrySeparatorLength : 0)
  return characters
})
const draftOverLimit = computed(() => projectedStoreCharacters.value > targetLimit.value)
const draftCapacityLabel = computed(() => {
  const difference = targetLimit.value - projectedStoreCharacters.value
  if (difference < 0) return `This section would exceed its limit by ${Math.abs(difference).toLocaleString()} characters.`
  return `${difference.toLocaleString()} characters will remain in this section after saving.`
})

const remainingCharacters = (store: MemoryStore): number => Math.max(0, store.limit - store.characters)
const canAddTo = (target: AgentMemoryTarget): boolean => {
  const store = memories.value[target]
  const requiredCharacters = store.entries.length ? 4 : 1
  return remainingCharacters(store) >= requiredCharacters
}
const addMemoryDisabledReason = computed<string | undefined>(() => {
  if (loading.value || !loaded.value) return 'Loading Agent memory'
  if (stale.value) return 'Refresh Agent memory before adding'
  if (!canAddTo('user') && !canAddTo('agent')) return 'Memory is at capacity'
  return undefined
})
const clearMemoryDisabledReason = computed<string | undefined>(() => {
  if (loading.value || !loaded.value) return 'Loading Agent memory'
  if (stale.value) return 'Refresh Agent memory before clearing'
  if (memoryCount.value === 0) return 'No saved memory to clear'
  return undefined
})
const canAddMemory = computed(() => addMemoryDisabledReason.value === undefined)
const memoryDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const memoryDateLabel = (entry: AgentMemoryEntry): string => {
  const revised = entry.updatedAt !== entry.createdAt
  return `${revised ? 'Revised' : 'Added'} ${memoryDateFormatter.format(new Date(revised ? entry.updatedAt : entry.createdAt))}`
}

const sections = computed(() => [
  {
    target: 'user' as const,
    title: 'You',
    empty: 'Save a lasting preference or personal detail.',
    icon: 'mdi-account-outline',
    store: memories.value.user
  },
  {
    target: 'agent' as const,
    title: 'Agent',
    empty: 'Save durable project or workflow context.',
    icon: 'mdi-notebook-outline',
    store: memories.value.agent
  }
])
const message = (value: unknown, fallback: string): string => value instanceof Error ? value.message : fallback
const load = async (committedMessage?: string): Promise<boolean> => {
  if (disposed) return false
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  const generation = ++loadGeneration
  loading.value = true
  error.value = ''
  try {
    const nextMemories = await getAgentMemories(window.fetch.bind(window), props.csrfToken, controller.signal)
    if (generation !== loadGeneration) return false
    memories.value = nextMemories
    stale.value = false
    loaded.value = true
    return true
  } catch (value) {
    if (generation !== loadGeneration || controller.signal.aborted) return false
    stale.value = loaded.value
    const reason = message(value, loaded.value ? 'Agent memory could not be refreshed.' : 'Agent memory could not be loaded.')
    error.value = loaded.value
      ? `${committedMessage ? `${committedMessage}, but the archive could not be refreshed. ` : ''}Showing last-loaded memory. ${reason}`
      : reason
    return false
  } finally {
    if (generation === loadGeneration) {
      loading.value = false
      if (loadController === controller) loadController = null
    }
  }
}
const cancelEdit = (): void => {
  editing.value = null
  draftTarget.value = 'user'
  draftContent.value = ''
}
const beginAdd = (target?: AgentMemoryTarget): void => {
  editing.value = { id: '', version: 0 }
  draftTarget.value = target ?? (canAddTo('user') ? 'user' : 'agent')
  draftContent.value = ''
}
const beginEdit = (entry: AgentMemoryEntry): void => {
  editing.value = { id: entry.id, version: entry.version }
  draftTarget.value = entry.target
  draftContent.value = entry.content
}
const beginRemove = (entry: AgentMemoryEntry, event: MouseEvent): void => {
  dialogError.value = ''
  destructiveRestoreTarget.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  removing.value = entry
}
const beginClear = (event: MouseEvent): void => {
  clearError.value = ''
  destructiveRestoreTarget.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  clearing.value = true
}
const cancelRemove = (): void => {
  if (actionBusy.value === 'remove') return
  removing.value = null
  dialogError.value = ''
}
const cancelClear = (): void => {
  if (actionBusy.value === 'clear') return
  clearing.value = false
  clearError.value = ''
}
const componentElement = (component: ComponentRoot | HTMLElement | null): HTMLElement | null => {
  if (!component) return null
  return component instanceof HTMLElement ? component : component.$el ?? null
}
const save = async (): Promise<void> => {
  const current = editing.value
  const content = draftContent.value.trim()
  if (!current || !content || draftOverLimit.value || saving.value || actionBusy.value || stale.value || loading.value) return
  saving.value = true; actionBusy.value = 'save'; error.value = ''
  try {
    if (current.id) await updateAgentMemory(window.fetch.bind(window), props.csrfToken, current.id, { expectedVersion: current.version, target: draftTarget.value, content })
    else await createAgentMemory(window.fetch.bind(window), props.csrfToken, { target: draftTarget.value, content })
  } catch (value) {
    error.value = message(value, 'Memory could not be saved.')
    saving.value = false; actionBusy.value = ''
    return
  }
  cancelEdit()
  await load('Memory was saved')
  saving.value = false; actionBusy.value = ''
}
const remove = async (): Promise<void> => {
  const entry = removing.value
  if (!entry || saving.value || actionBusy.value || stale.value || loading.value) return
  saving.value = true; actionBusy.value = 'remove'; dialogError.value = ''
  try {
    const mutation = await removeAgentMemory(window.fetch.bind(window), props.csrfToken, entry.id, entry.version)
    const store = memories.value[entry.target]
    memories.value = {
      ...memories.value,
      [entry.target]: {
        ...store,
        entries: store.entries.filter(candidate => candidate.id !== entry.id),
        characters: mutation.characters,
        limit: mutation.limit
      }
    }
  } catch (value) {
    dialogError.value = message(value, 'Memory could not be removed.')
    saving.value = false; actionBusy.value = ''
    return
  }
  if (editing.value?.id === entry.id) cancelEdit()
  destructiveRestoreTarget.value = componentElement(memoryCloseButton.value)
  removing.value = null
  await load('Memory was removed')
  saving.value = false; actionBusy.value = ''
}
const clear = async (): Promise<void> => {
  if (saving.value || actionBusy.value || stale.value || loading.value) return
  saving.value = true; actionBusy.value = 'clear'; clearError.value = ''
  try {
    await clearAgentMemories(window.fetch.bind(window), props.csrfToken)
  } catch (value) {
    clearError.value = message(value, 'Agent memory could not be cleared.')
    saving.value = false; actionBusy.value = ''
    return
  }
  memories.value = {
    agent: emptyStore(memories.value.agent.limit),
    user: emptyStore(memories.value.user.limit)
  }
  destructiveRestoreTarget.value = componentElement(memoryCloseButton.value)
  clearing.value = false
  cancelEdit()
  await load('Agent memory was cleared')
  saving.value = false; actionBusy.value = ''
}

watch([removing, clearing], async ([entry, clearOpen], _previous, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  if (!entry && !clearOpen) {
    await nextTick()
    if (cancelled) return
    destructiveFocusScope?.deactivate({ restoreFocus: true })
    destructiveFocusScope = null
    destructiveRestoreTarget.value = null
    return
  }
  await nextTick()
  if (cancelled) return
  const root = componentElement(entry ? removeDialogCard.value : clearDialogCard.value)
  if (!root) return
  destructiveFocusScope?.deactivate({ restoreFocus: false })
  destructiveFocusScope = createModalFocusScope({
    root,
    restoreTarget: () => destructiveRestoreTarget.value,
    onEscape: () => {
      if (actionBusy.value) return
      if (removing.value) cancelRemove()
      else cancelClear()
    }
  })
})
watch(open, value => { if (value) void load() }, { immediate: true })
onBeforeUnmount(() => {
  disposed = true
  loadGeneration += 1
  loadController?.abort()
  loadController = null
  destructiveFocusScope?.deactivate({ restoreFocus: false })
  destructiveFocusScope = null
})
</script>

<style scoped>
.agent-memory {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  flex-direction: column;
  border: 1px solid var(--wiki-surface-border-strong);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-md), var(--wiki-shadow-inset);
  color: rgb(var(--v-theme-on-surface));
}

.agent-memory__hero {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: calc(var(--wiki-control-height) - var(--wiki-space-1)) minmax(0, 1fr) var(--wiki-control-height);
  gap: var(--wiki-space-2);
  align-items: center;
  padding: var(--wiki-space-3) var(--wiki-space-4);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent), transparent 58%),
    var(--wiki-surface-raised);
}

.agent-memory__mark,
.agent-memory__section-mark {
  display: grid;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 28%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 11%, var(--wiki-surface-raised));
  color: var(--wiki-accent-warm);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.agent-memory__mark {
  width: calc(var(--wiki-control-height) - var(--wiki-space-1));
  height: calc(var(--wiki-control-height) - var(--wiki-space-1));
}

.agent-memory__heading {
  min-width: 0;
}

.agent-memory__eyebrow {
  margin: 0 0 var(--wiki-space-1);
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .1em;
  text-transform: uppercase;
}

.agent-memory__title-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  align-items: center;
}

.agent-memory__title-row h2,
.agent-memory__editor-header h3,
.agent-memory__section-header h3 {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
  line-height: var(--wiki-leading-heading);
}

.agent-memory__count {
  padding: var(--wiki-space-1) var(--wiki-space-2);
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, var(--wiki-surface-border));
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, var(--wiki-accent-warm) 9%, transparent);
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-variant-numeric: tabular-nums;
  font-weight: var(--wiki-label-weight);
  line-height: 1;
}

.agent-memory__intro {
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: .75rem;
  line-height: 1.35;
}

.agent-memory__close {
  align-self: start;
}

.agent-memory__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--wiki-space-4) !important;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.agent-memory__error,
.agent-memory__editor,
.agent-memory__section,
.agent-memory__safety {
  margin-bottom: var(--wiki-space-3);
}

.agent-memory__error-content,
.agent-memory__refresh,
.agent-memory__editor-header,
.agent-memory__editor-actions,
.agent-memory__safety {
  display: flex;
  align-items: center;
}

.agent-memory__error-content {
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  justify-content: space-between;
}

.agent-memory__state {
  display: flex;
  min-height: calc(var(--wiki-space-12) * 2);
  gap: var(--wiki-space-3);
  align-items: center;
  justify-content: center;
  padding: var(--wiki-space-4);
  border: 1px dashed var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-sunken);
}

.agent-memory__refresh,
.agent-memory__empty p,
.agent-memory__safety p,
.agent-memory__dialog p {
  margin: 0;
}

.agent-memory__state,
.agent-memory__empty p,
.agent-memory__safety p {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: .8125rem;
  line-height: 1.45;
}

.agent-memory__refresh {
  gap: var(--wiki-space-2);
  margin-bottom: var(--wiki-space-3);
  color: var(--wiki-accent-warm);
  font-size: .75rem;
}


.agent-memory__editor {
  padding: var(--wiki-space-3);
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 32%, var(--wiki-surface-border));
  border-radius: var(--wiki-panel-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 5%, var(--wiki-surface-raised));
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
}

.agent-memory__editor-header {
  gap: var(--wiki-space-2);
  justify-content: space-between;
  margin-bottom: var(--wiki-space-3);
}

.agent-memory__target {
  min-width: 0;
  margin: 0 0 var(--wiki-space-3);
  padding: 0;
  border: 0;
}

.agent-memory__target legend {
  margin-bottom: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: .75rem;
  font-weight: 650;
}

.agent-memory__target .v-btn-toggle {
  width: 100%;
}

.agent-memory__target .v-btn {
  min-height: var(--wiki-control-height);
  flex: 1 1 50%;
  border-radius: var(--wiki-control-radius);
  text-transform: none;
}

.agent-memory__editor :deep(.v-field) {
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.agent-memory__draft-limit {
  margin: var(--wiki-space-2) 0 0;
  color: rgb(var(--v-theme-error));
  font-size: .75rem;
  font-weight: 650;
}

.agent-memory__editor-actions {
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  justify-content: flex-end;
  margin-top: var(--wiki-space-3);
}

.agent-memory__shortcut {
  margin-inline-end: auto;
}

.agent-memory__shortcut kbd {
  font-family: var(--wiki-font-mono);
}

.agent-memory__section {
  padding-bottom: var(--wiki-space-3);
  border-bottom: 1px solid var(--wiki-surface-border);
}

.agent-memory__section-header {
  display: grid;
  grid-template-columns: calc(var(--wiki-control-height) - var(--wiki-space-2)) minmax(0, 1fr);
  gap: var(--wiki-space-2);
  align-items: center;
  margin-bottom: var(--wiki-space-2);
}

.agent-memory__section-mark {
  width: calc(var(--wiki-control-height) - var(--wiki-space-2));
  height: calc(var(--wiki-control-height) - var(--wiki-space-2));
}

.agent-memory__section-mark--agent {
  border-color: color-mix(in srgb, var(--wiki-accent-spectral) 28%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--wiki-accent-spectral) 10%, var(--wiki-surface-raised));
  color: var(--wiki-accent-spectral);
}


.agent-memory__limit-alert {
  margin-top: var(--wiki-space-2);
}

.agent-memory__entries {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.agent-memory__entry {
  display: grid;
  min-width: 0;
  content-visibility: auto;
  contain-intrinsic-size: auto 6rem;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--wiki-space-2);
  align-items: start;
  padding: var(--wiki-space-3);
}

.agent-memory__entry + .agent-memory__entry {
  border-top: 1px solid var(--wiki-surface-border);
}

.agent-memory__entry-index {
  min-width: var(--wiki-space-6);
  padding-top: var(--wiki-space-1);
  color: var(--wiki-accent-warm);
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  font-weight: 700;
}

.agent-memory__entry-content {
  min-width: 0;
}

.agent-memory__entry-content p {
  margin: var(--wiki-space-1) 0 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.agent-memory__entry-actions {
  display: flex;
  flex: 0 0 auto;
  gap: var(--wiki-space-1);
  opacity: .7;
  transition: opacity var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.agent-memory__entry:hover .agent-memory__entry-actions,
.agent-memory__entry:focus-within .agent-memory__entry-actions {
  opacity: 1;
}

.agent-memory__entry-actions .v-btn,
.agent-memory__footer .v-btn,
.agent-memory__editor-actions .v-btn {
  min-height: var(--wiki-control-height);
  border-radius: var(--wiki-control-radius);
  font-weight: 650;
  text-transform: none;
}

.agent-memory__empty {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--wiki-space-2);
  align-items: center;
  padding: var(--wiki-space-3);
  border: 1px dashed var(--wiki-surface-border-strong);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.agent-memory__empty > .v-icon {
  color: var(--wiki-accent-warm);
}

.agent-memory__safety {
  gap: var(--wiki-space-2);
  align-items: center;
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border-inline-start: var(--wiki-space-1) solid rgb(var(--v-theme-info));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-info)) 8%, var(--wiki-surface-sunken));
}

.agent-memory__safety > .v-icon {
  flex: 0 0 auto;
  color: rgb(var(--v-theme-info));
}

.agent-memory__footer {
  flex: 0 0 auto;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-3) var(--wiki-space-4);
  background: var(--wiki-surface-raised);
}

.agent-memory__dialog {
  border: 1px solid var(--wiki-surface-border-strong);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset);
}

.agent-memory__dialog-title {
  display: flex;
  gap: var(--wiki-space-3);
  align-items: center;
  padding: var(--wiki-space-5) var(--wiki-space-5) var(--wiki-space-3);
}

.agent-memory__dialog-error {
  margin-bottom: var(--wiki-space-3);
}

.agent-memory__dialog-record {
  margin: var(--wiki-space-4) 0 0;
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-inline-start: var(--wiki-space-1) solid var(--wiki-accent-warm);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

@media (max-width: 1199.98px) {
  .agent-memory {
    border-radius: 0 !important;
    border-end-start-radius: var(--wiki-panel-radius) !important;
    border-start-start-radius: var(--wiki-panel-radius) !important;
  }
}

@media (max-width: 599.98px) {
  .agent-memory {
    border-width: 0;
    border-inline-start-width: 1px;
    border-radius: 0 !important;
  }

  .agent-memory__hero,
  .agent-memory__body,
  .agent-memory__footer {
    padding-inline: var(--wiki-space-4) !important;
  }

  .agent-memory__hero {
    grid-template-columns: var(--wiki-control-height) minmax(0, 1fr) var(--wiki-control-height);
  }

  .agent-memory__empty {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .agent-memory__empty .v-btn {
    grid-column: 1 / -1;
    width: 100%;
  }


  .agent-memory__entry {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .agent-memory__entry-actions {
    grid-column: 1 / -1;
    width: 100%;
    opacity: 1;
  }

  .agent-memory__entry-actions .v-btn {
    flex: 1 1 50%;
  }

  .agent-memory__shortcut {
    width: 100%;
  }

  .agent-memory__footer {
    flex-wrap: wrap;
  }

  .agent-memory__footer .v-spacer {
    display: none;
  }

  .agent-memory__footer .v-btn {
    flex: 1 1 calc(50% - var(--wiki-space-1));
  }
}

@media (forced-colors: active) {
  .agent-memory,
  .agent-memory__editor,
  .agent-memory__entries,
  .agent-memory__empty,
  .agent-memory__safety,
  .agent-memory__dialog-record {
    border: 1px solid CanvasText;
  }

  .agent-memory__safety {
    border-inline-start-width: var(--wiki-space-1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-memory__entry-actions {
    transition: none;
  }
}
</style>
