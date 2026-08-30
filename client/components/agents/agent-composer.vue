<template>
  <v-form
    class="agent-composer"
    :class="{
      'agent-composer--sending': sending || canStop,
      'agent-composer--disabled': disabled,
      'agent-composer--retry': sendFailed
    }"
    @submit.prevent="submit"
  >
    <v-card
      v-if="skillCommandOpen"
      class="agent-composer__command-menu"
      aria-label="Invoke a skill"
      elevation="5"
    >
      <v-card-title class="agent-composer__command-heading">
        <span>
          <v-icon icon="mdi-puzzle-outline" size="18" aria-hidden="true" />
          Invoke a skill
        </span>
        <span class="agent-composer__command-help">Type to filter · Esc to close</span>
      </v-card-title>
      <v-divider />
      <v-list
        id="agent-skill-command-results"
        role="listbox"
        aria-label="Matching skills"
        density="compact"
        max-height="320"
        class="overflow-y-auto"
      >
        <v-list-item
          v-for="(skill, index) in skillCommandResults"
          :id="`agent-skill-command-${skill.versionId}`"
          :key="skill.versionId"
          role="option"
          :active="index === activeCommandIndex"
          :aria-selected="isSelected(skill.versionId)"
          :disabled="isCommandSkillDisabled(skill.versionId)"
          :prepend-icon="isSelected(skill.versionId) ? 'mdi-check-circle' : 'mdi-puzzle-outline'"
          :title="skill.name"
          :subtitle="isPreferred(skill.versionId) ? 'Always loaded in conversations' : skill.description"
          @mouseenter="activeCommandIndex = index"
          @click="invokeCommandSkill(skill)"
        >
          <template #append>
            <div class="d-flex ga-1">
              <v-chip v-if="skill.exposureMode === 'owner'" size="x-small" variant="tonal">Mine</v-chip>
              <v-chip v-if="skill.exposureMode === 'owner' && !skill.isAgentDiscoverable" size="x-small" variant="outlined">Explicit only</v-chip>
            </div>
          </template>
        </v-list-item>
        <v-list-item v-if="skillCommandResults.length === 0" title="No matching skills" subtitle="Try another name or description." disabled />
        <div class="agent-composer__command-status sr-only" role="status" aria-live="polite">{{ skillCommandResults.length ? `${skillCommandResults.length} matching skills` : 'No matching skills' }}</div>
      </v-list>
    </v-card>

    <div class="agent-composer__editor">
      <div class="agent-composer__editor-label">
        <span>{{ goalMode ? 'Define an outcome' : 'Message Wiki Agent' }}</span>
        <span v-if="goalMode" class="agent-composer__mode-badge">Goal mode</span>
      </div>
      <v-textarea
        ref="messageInput"
        v-model="draft"
        class="agent-composer__input"
        :aria-label="composerInputLabel"
        aria-describedby="agent-composer-status agent-composer-keyboard-hint"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        :placeholder="goalMode ? 'Describe a bounded outcome for Wiki Agent' : skillsEnabled ? 'Ask a follow-up · Type / for skills' : 'Ask a follow-up'"
        rows="1"
        variant="solo"
        flat
        hide-details
        :disabled="disabled || sending"
        :aria-expanded="skillCommandOpen"
        :aria-controls="skillCommandOpen ? 'agent-skill-command-results' : undefined"
        :aria-activedescendant="activeCommandSkill ? `agent-skill-command-${activeCommandSkill.versionId}` : undefined"
        @keydown="handleKeydown"
      />
    </div>

    <div v-if="selectedSkills.length > 0" class="agent-composer__attachments" role="group" aria-label="Skills attached as context for the next message">
      <span class="agent-composer__attachments-label">
        <v-icon icon="mdi-paperclip" size="15" aria-hidden="true" />
        Attached context
      </span>
      <div class="agent-composer__skills">
        <v-chip
          v-for="skill in selectedSkills"
          :key="skill.versionId"
          closable
          size="small"
          color="primary"
          variant="tonal"
          :disabled="disabled || sending"
          @click:close="toggleSkill(skill.versionId)"
        >
          {{ skill.name }}
        </v-chip>
      </div>
    </div>

    <div class="agent-composer__actions">
      <div class="agent-composer__context-controls" role="group" aria-label="Conversation context controls">
        <span v-if="skillsEnabled || goalsEnabled" class="agent-composer__context-label">Context</span>
        <v-menu v-if="skillsEnabled" v-model="skillMenuOpen" :close-on-content-click="false">
          <template #activator="{ props: activatorProps }">
            <v-btn
              id="agent-composer-skills-trigger"
              ref="skillsTrigger"
              v-bind="activatorProps"
              class="agent-composer__skill-button"
              variant="text"
              prepend-icon="mdi-puzzle-outline"
              :disabled="disabled || sending"
              :text="selectedSkills.length > 0 ? `Skills (${selectedSkills.length})` : 'Skills'"
              aria-label="Choose skills for the next message"
              aria-haspopup="dialog"
              aria-controls="agent-composer-skills-menu"
              :aria-expanded="skillMenuOpen"
            />
          </template>
          <v-card id="agent-composer-skills-menu" class="agent-composer__skill-menu" min-width="300" max-width="420" role="dialog" aria-labelledby="agent-composer-skills-title">
            <v-card-title id="agent-composer-skills-title" class="text-body-large">Skills</v-card-title>
            <v-card-subtitle>Select for the next message or always load in conversations.</v-card-subtitle>
            <v-list v-if="skillMenuItems.length > 0" role="listbox" aria-label="Available skills" aria-multiselectable="true" density="compact" max-height="320" class="overflow-y-auto">
              <v-list-item
                v-for="skill in skillMenuItems"
                :key="skill.versionId"
                role="option"
                :active="isSelected(skill.versionId) || isPreferred(skill.versionId)"
                :aria-selected="isSelected(skill.versionId) || isPreferred(skill.versionId)"
                :disabled="disabled || sending"
                @click="toggleSkill(skill.versionId)"
              >
                <template #prepend>
                  <v-checkbox-btn
                    :model-value="isSelected(skill.versionId) || isPreferred(skill.versionId)"
                    :disabled="disabled || sending || isPreferred(skill.versionId) || (!isSelected(skill.versionId) && selectedSkillIds.length >= invocationLimit)"
                    tabindex="-1"
                  />
                </template>
                <v-list-item-title>{{ skill.name }}</v-list-item-title>
                <v-list-item-subtitle>{{ isPreferred(skill.versionId) ? 'Always loaded in conversations' : skill.description }}</v-list-item-subtitle>
                <template #append>
                  <div class="d-flex align-center ga-1">
                    <v-chip v-if="skill.exposureMode === 'owner'" size="x-small" variant="tonal">Mine</v-chip>
                    <v-btn
                      :icon="isPreferred(skill.versionId) ? 'mdi-autorenew' : 'mdi-autorenew-off'"
                      :variant="isPreferred(skill.versionId) ? 'tonal' : 'text'"
                      size="small"
                      :disabled="disabled || sending || (!isPreferred(skill.versionId) && invocationLimit === 0)"
                      :aria-label="isPreferred(skill.versionId) ? `Stop always loading ${skill.name}` : `Always load ${skill.name} in conversations`"
                      @click.stop="togglePreference(skill.versionId)"
                    />
                  </div>
                </template>
              </v-list-item>
            </v-list>
            <v-card-text v-else class="text-medium-emphasis">No skills are available yet.</v-card-text>
            <v-card-text v-if="invocationLimit === 0" class="pt-0 text-body-small text-medium-emphasis">You have the maximum 8 automatically loaded skills. Remove one to make room.</v-card-text>
            <v-divider />
            <v-card-actions>
              <v-btn prepend-icon="mdi-file-document-edit-outline" variant="text" :disabled="sending" @click="manageSkills">Manage my skills</v-btn>
            </v-card-actions>
          </v-card>
        </v-menu>
        <v-btn
          v-if="goalsEnabled"
          class="agent-composer__goal-button"
          :color="goalMode ? 'primary' : undefined"
          :variant="goalMode ? 'tonal' : 'text'"
          prepend-icon="mdi-target"
          :aria-pressed="goalMode"
          :disabled="disabled || sending"
          @click="goalMode = !goalMode"
        >Goal</v-btn>
      </div>

      <div
        id="agent-composer-status"
        class="agent-composer__state"
        :class="{ 'agent-composer__state--error': sendFailed, 'agent-composer__state--active': sending || canStop }"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span class="agent-composer__state-dot" aria-hidden="true" />
        <span>{{ composerStatus }}</span>
      </div>

      <div class="agent-composer__primary-actions" role="group" aria-label="Message actions">
        <v-btn
          v-if="canStop"
          class="agent-composer__stop"
          color="warning"
          variant="outlined"
          prepend-icon="mdi-stop"
          @click="$emit('stop')"
        >Stop</v-btn>
        <v-btn
          class="agent-composer__submit"
          type="submit"
          color="primary"
          :prepend-icon="sendFailed ? 'mdi-refresh' : goalMode ? 'mdi-target-arrow' : 'mdi-send'"
          :loading="sending"
          :disabled="disabled || sending || !draft.trim()"
        >{{ submitLabel }}</v-btn>
      </div>
    </div>

    <p id="agent-composer-keyboard-hint" class="agent-composer__hint">
      <v-icon icon="mdi-keyboard-return" size="14" aria-hidden="true" />
      Enter to send <span aria-hidden="true">·</span> Shift+Enter for a new line
    </p>
  </v-form>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AgentSessionSkillView } from '../../../shared/agents/contracts.ts'
import type { VisibleAgentSkill } from '../../helpers/agents-api.ts'
import { filterSkillsForCommand } from './agent-skill-command.ts'

const props = defineProps<{
  disabled: boolean
  sending: boolean
  canStop: boolean
  skillsEnabled: boolean
  goalsEnabled: boolean
  skills: readonly VisibleAgentSkill[]
  preferredSkills: readonly AgentSessionSkillView[]
  invocationLimit: number
}>()
const emit = defineEmits<{ send: [content: string, invokedSkillVersionIds: readonly string[], mode: 'message' | 'goal', completion?: (success: boolean) => void]; stop: []; manageSkills: []; updateSkillPreferences: [skillIds: string[]] }>()
const draft = ref('')
const goalMode = ref(false)
const skillMenuOpen = ref(false)
const selectedSkillIds = ref<string[]>([])
const messageInput = ref<{ focus: () => void; $el?: HTMLElement } | null>(null)
const skillsTrigger = ref<{ focus?: () => void; $el?: HTMLElement } | HTMLElement | null>(null)
const commandDismissed = ref(false)
const activeCommandIndex = ref(0)
const sendFailed = ref(false)
const preferredSkillIds = computed(() => new Set(props.preferredSkills.map(skill => skill.skillId)))
const selectedSkills = computed(() => selectedSkillIds.value.flatMap(id => {
  const skill = props.skills.find(candidate => candidate.versionId === id)
  return skill ? [skill] : []
}))
const skillMenuItems = computed(() => [
  ...props.skills,
  ...props.preferredSkills
    .filter(skill => !props.skills.some(candidate => candidate.id === skill.skillId))
    .map(skill => ({ ...skill, exposureMode: undefined }))
])
const skillIdForVersion = (versionId: string): string | undefined =>
  props.skills.find(skill => skill.versionId === versionId)?.id ?? props.preferredSkills.find(skill => skill.versionId === versionId)?.skillId
const isPreferred = (versionId: string): boolean => {
  const skillId = skillIdForVersion(versionId)
  return skillId !== undefined && preferredSkillIds.value.has(skillId)
}
const composerInputLabel = computed(() => goalMode.value ? 'Define an outcome for Wiki Agent' : 'Message Wiki Agent')
const composerStatus = computed(() => {
  if (props.sending) return 'Sending request'
  if (props.canStop) return 'Agent responding'
  if (sendFailed.value) return 'Send failed · Ready to retry'
  if (props.disabled) return 'Waiting for the current operation'
  if (goalMode.value) return 'Goal mode ready'
  if (selectedSkills.value.length) return `${selectedSkills.value.length} context ${selectedSkills.value.length === 1 ? 'attachment' : 'attachments'}`
  return 'Ready'
})
const submitLabel = computed(() => sendFailed.value ? 'Retry' : goalMode.value ? 'Start goal' : 'Send')
const isSelected = (versionId: string): boolean => selectedSkillIds.value.includes(versionId)
const resizeInput = (): void => {
  const textarea = messageInput.value?.$el?.querySelector('textarea')
  if (!(textarea instanceof HTMLTextAreaElement)) return
  textarea.style.height = '0px'
  textarea.style.overflowY = 'hidden'
  const styles = window.getComputedStyle(textarea)
  const minHeight = Number.parseFloat(styles.minHeight) || 0
  const maxHeight = Number.parseFloat(styles.maxHeight) || Number.POSITIVE_INFINITY
  const contentHeight = textarea.scrollHeight
  const height = Math.min(Math.max(contentHeight, minHeight), maxHeight)
  textarea.style.height = `${height}px`
  textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
}
const focusInput = async (): Promise<void> => {
  await nextTick()
  messageInput.value?.focus()
}
const togglePreference = (versionId: string): void => {
  if (props.disabled || props.sending) return
  const skillIds = props.preferredSkills.map(skill => skill.skillId)
  const skillId = skillIdForVersion(versionId)
  if (!skillId) return
  const index = skillIds.indexOf(skillId)
  if (index >= 0) skillIds.splice(index, 1)
  else {
    if (props.invocationLimit === 0) return
    skillIds.push(skillId)
  }
  emit('updateSkillPreferences', skillIds)
}
const skillCommandQuery = computed<string | null>(() => {
  if (!props.skillsEnabled || props.disabled || props.sending || commandDismissed.value) return null
  return /^\/([^\s/]*)$/.exec(draft.value)?.[1] ?? null
})
const skillCommandOpen = computed(() => skillCommandQuery.value !== null)
const skillCommandResults = computed(() => filterSkillsForCommand(props.skills, skillCommandQuery.value ?? ''))
const activeCommandSkill = computed(() => skillCommandResults.value[activeCommandIndex.value] ?? null)
const isCommandSkillDisabled = (versionId: string): boolean =>
  props.disabled || props.sending || isPreferred(versionId) || (!isSelected(versionId) && selectedSkillIds.value.length >= props.invocationLimit)
const invokeCommandSkill = (skill: VisibleAgentSkill): void => {
  if (isCommandSkillDisabled(skill.versionId)) return
  if (!isSelected(skill.versionId)) toggleSkill(skill.versionId)
  draft.value = ''
  commandDismissed.value = false
  activeCommandIndex.value = 0
  void nextTick(() => messageInput.value?.focus())
}
const handleKeydown = (event: KeyboardEvent): void => {
  if (skillCommandOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      commandDismissed.value = true
      return
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && skillCommandResults.value.length > 0) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      activeCommandIndex.value = (activeCommandIndex.value + direction + skillCommandResults.value.length) % skillCommandResults.value.length
      return
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      if (activeCommandSkill.value) invokeCommandSkill(activeCommandSkill.value)
      return
    }
  }
  if (event.key === 'Enter' && (!event.shiftKey || event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    submit()
  }
}
const toggleSkill = (versionId: string): void => {
  if (props.disabled || props.sending) return
  const index = selectedSkillIds.value.indexOf(versionId)
  if (index >= 0) {
    selectedSkillIds.value.splice(index, 1)
    return
  }
  if (isPreferred(versionId) || selectedSkillIds.value.length >= props.invocationLimit) return
  selectedSkillIds.value.push(versionId)
}
watch(
  () => [props.skills.map(skill => skill.versionId).join(','), props.preferredSkills.map(skill => skill.versionId).join(','), props.invocationLimit],
  () => {
    const available = new Set(props.skills.map(skill => skill.versionId))
    selectedSkillIds.value = selectedSkillIds.value.filter(id => available.has(id) && !isPreferred(id)).slice(0, props.invocationLimit)
  }
)
watch(draft, value => {
  if (!value.startsWith('/')) commandDismissed.value = false
  if (sendFailed.value) sendFailed.value = false
  void nextTick(resizeInput)
})
watch(skillCommandQuery, () => {
  activeCommandIndex.value = 0
})
const manageSkills = (): void => {
  if (props.disabled || props.sending) return
  skillMenuOpen.value = false
  emit('manageSkills')
}
const focusSkillsTrigger = async (): Promise<void> => {
  await nextTick()
  const trigger = skillsTrigger.value
  if (trigger instanceof HTMLElement) trigger.focus()
  else if (trigger?.$el instanceof HTMLElement) trigger.$el.focus()
  else trigger?.focus?.()
}
const submit = (): void => {
  if (props.disabled || props.sending || skillCommandOpen.value || !draft.value.trim()) return
  const content = draft.value
  const invokedSkillVersionIds = [...selectedSkillIds.value]
  const mode = goalMode.value ? 'goal' : 'message'
  sendFailed.value = false
  emit('send', content, invokedSkillVersionIds, mode, (success: boolean) => {
    sendFailed.value = !success
    if (success) {
      if (draft.value === content) draft.value = ''
      selectedSkillIds.value = []
      goalMode.value = false
    } else {
      void nextTick(() => {
        messageInput.value?.focus()
        resizeInput()
      })
    }
  })
}
defineExpose({ focusInput, focusSkillsTrigger })
onMounted(() => {
  resizeInput()
  window.addEventListener('resize', resizeInput)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeInput)
})
</script>

<style scoped>
.agent-composer {
  position: relative;
  min-width: 0;
  padding: var(--wiki-space-2);
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--wiki-accent-warm) 6%, transparent),
      transparent 42%
    ),
    var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-md), var(--wiki-shadow-inset);
  font-family: var(--wiki-font-body);
  transition:
    border-color var(--wiki-motion-normal) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease);
}

.agent-composer::before {
  position: absolute;
  inset-block-start: 0;
  inset-inline: var(--wiki-space-6);
  height: var(--wiki-space-1);
  border-radius: 0 0 var(--wiki-radius-pill) var(--wiki-radius-pill);
  background: var(--wiki-ambient-accent);
  content: '';
  opacity: .72;
}

.agent-composer:focus-within {
  border-color: color-mix(in srgb, var(--wiki-focus-color) 58%, var(--wiki-surface-border));
  box-shadow: var(--wiki-shadow-md), var(--wiki-focus-ring), var(--wiki-shadow-inset);
}

.agent-composer--sending {
  border-color: color-mix(in srgb, var(--wiki-accent-warm) 42%, var(--wiki-surface-border));
}

.agent-composer--retry {
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 48%, var(--wiki-surface-border));
}

.agent-composer--disabled:not(.agent-composer--sending) {
  background: var(--wiki-surface-sunken);
  box-shadow: var(--wiki-shadow-inset);
}

.agent-composer__editor {
  min-width: 0;
  padding: var(--wiki-space-2) var(--wiki-space-2) 0;
}

.agent-composer__editor-label {
  display: flex;
  min-height: var(--wiki-space-5);
  align-items: center;
  gap: var(--wiki-space-2);
  padding-inline: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .08em;
  text-transform: uppercase;
}

.agent-composer__mode-badge {
  padding: 0 var(--wiki-space-2);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, var(--wiki-accent-warm) 12%, transparent);
  color: var(--wiki-accent-warm);
  letter-spacing: .04em;
}

.agent-composer__input :deep(.v-field) {
  background: transparent;
  box-shadow: none;
}

.agent-composer__input :deep(.v-field__input) {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-3));
  padding: var(--wiki-space-2) var(--wiki-space-1) var(--wiki-space-1);
}

.agent-composer__input :deep(textarea) {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-3));
  max-height: min(calc(var(--wiki-space-12) * 4), 42dvh);
  overflow-y: hidden;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1rem;
  line-height: 1.55;
  resize: none;
}

.agent-composer__input :deep(textarea::placeholder) {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 48%, transparent);
  opacity: 1;
}

.agent-composer__input :deep(textarea:focus-visible) {
  outline: none;
}

.agent-composer__attachments {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-2);
  margin: 0 var(--wiki-space-2) var(--wiki-space-2);
  padding: var(--wiki-space-2);
  border-block: 1px solid var(--wiki-surface-border);
}

.agent-composer__attachments-label {
  display: inline-flex;
  min-height: calc(var(--wiki-control-height) - var(--wiki-space-3));
  align-items: center;
  gap: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  white-space: nowrap;
}

.agent-composer__skills {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
}

.agent-composer__actions {
  display: grid;
  min-width: 0;
  min-height: var(--wiki-control-height);
  grid-template-columns: minmax(0, auto) minmax(var(--wiki-space-12), 1fr) auto;
  align-items: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-1);
  border-top: 1px solid var(--wiki-surface-border);
}

.agent-composer__context-controls,
.agent-composer__primary-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-1);
}

.agent-composer__context-label {
  margin-inline: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 54%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .06em;
  text-transform: uppercase;
}

.agent-composer__actions :deep(.v-btn) {
  min-height: var(--wiki-control-height);
}

.agent-composer__skill-button {
  max-width: 100%;
}

.agent-composer__state {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  white-space: nowrap;
}

.agent-composer__state-dot {
  width: var(--wiki-space-2);
  height: var(--wiki-space-2);
  flex: 0 0 auto;
  border: 1px solid currentColor;
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, currentColor 18%, transparent);
}

.agent-composer__state--active {
  color: var(--wiki-accent-warm);
}

.agent-composer__state--active .agent-composer__state-dot {
  background: currentColor;
  box-shadow: 0 0 0 var(--wiki-space-1) color-mix(in srgb, currentColor 14%, transparent);
  animation: composerPulse 1.8s var(--wiki-motion-ease) infinite;
}

.agent-composer__state--error {
  color: rgb(var(--v-theme-error));
}

.agent-composer__submit {
  min-width: calc(var(--wiki-space-12) * 2.5);
  box-shadow: var(--wiki-shadow-xs);
}

.agent-composer__stop {
  min-width: calc(var(--wiki-space-12) * 1.6);
}

.agent-composer__hint {
  display: flex;
  min-height: var(--wiki-space-5);
  align-items: center;
  justify-content: flex-end;
  gap: var(--wiki-space-1);
  margin: var(--wiki-space-1) var(--wiki-space-2) 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 52%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.4;
}

.agent-composer__command-menu {
  position: absolute;
  z-index: 10;
  inset-block-end: calc(100% + var(--wiki-space-2));
  inset-inline-start: 0;
  width: min(calc(var(--wiki-space-12) * 12.5), 100%);
  max-width: 100%;
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-lg);
}
.agent-composer__command-menu :deep(.v-list) {
  max-height: min(20rem, 42dvh) !important;
}

.agent-composer__command-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-3);
  font-size: .875rem;
}

.agent-composer__command-heading > span {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-2);
}

.agent-composer__command-help {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: 500;
}

.agent-composer__command-status {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}

.agent-composer__skill-menu :deep(.v-selection-control) {
  pointer-events: none;
}

@keyframes composerPulse {
  50% {
    opacity: .52;
  }
}

@media (max-width: 740px) {
  .agent-composer {
    padding: var(--wiki-space-1);
    border-radius: var(--wiki-control-radius);
  }

  .agent-composer::before {
    inset-inline: var(--wiki-space-4);
  }

  .agent-composer__editor {
    padding-inline: var(--wiki-space-2);
  }

  .agent-composer__actions {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .agent-composer__context-label,
  .agent-composer__state {
    display: none;
  }

  .agent-composer__context-controls {
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scrollbar-width: none;
  }

  .agent-composer__context-controls::-webkit-scrollbar {
    display: none;
  }

  .agent-composer__primary-actions {
    grid-column: 2;
  }

  .agent-composer__attachments {
    flex-direction: column;
  }

  .agent-composer__hint {
    justify-content: flex-start;
  }
}

@media (max-width: 430px) {
  .agent-composer__editor-label,
  .agent-composer__hint {
    display: none;
  }

  .agent-composer__input :deep(.v-field__input),
  .agent-composer__input :deep(textarea) {
    min-height: var(--wiki-control-height);
  }

  .agent-composer__skill-button,
  .agent-composer__goal-button {
    min-width: var(--wiki-control-height);
    padding-inline: var(--wiki-space-2);
  }

  .agent-composer__skill-button :deep(.v-btn__content),
  .agent-composer__goal-button :deep(.v-btn__content) {
    font-size: 0;
  }

  .agent-composer__skill-button :deep(.v-btn__prepend),
  .agent-composer__goal-button :deep(.v-btn__prepend) {
    margin: 0;
  }

  .agent-composer__submit {
    min-width: var(--wiki-control-height);
    padding-inline: var(--wiki-space-3);
  }
}

@media (max-height: 500px) {
  .agent-composer__input :deep(textarea) {
    max-height: calc(var(--wiki-space-12) * 1.5);
  }

  .agent-composer__editor-label,
  .agent-composer__hint {
    display: none;
  }
}

@media (forced-colors: active) {
  .agent-composer,
  .agent-composer__command-menu {
    border: 1px solid CanvasText;
  }

  .agent-composer::before,
  .agent-composer__state-dot {
    background: Highlight;
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-composer,
  .agent-composer__state-dot {
    transition: none;
    animation: none;
  }
}
</style>
