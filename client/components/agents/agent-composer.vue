<template>
  <v-form class="agent-composer" @submit.prevent="submit">
    <v-card
      v-if="skillCommandOpen"
      class="agent-composer__command-menu"
      role="dialog"
      aria-label="Invoke a skill"
      elevation="5"
    >
      <v-card-title class="d-flex align-center text-body-large">
        Invoke a skill
        <v-spacer />
        <span class="text-body-small text-medium-emphasis">Type to filter · Esc to close</span>
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
          :subtitle="isPinned(skill.versionId) ? 'Already pinned to this session' : skill.description"
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
      </v-list>
    </v-card>
    <v-textarea
      ref="messageInput"
      v-model="draft"
      label="Message Wiki Agent"
      placeholder="Ask about pages you can access · Type / to invoke a skill"
      rows="2"
      max-rows="8"
      auto-grow
      counter="32000"
      :disabled="disabled"
      :aria-expanded="skillCommandOpen"
      :aria-controls="skillCommandOpen ? 'agent-skill-command-results' : undefined"
      :aria-activedescendant="activeCommandSkill ? `agent-skill-command-${activeCommandSkill.versionId}` : undefined"
      @keydown="handleKeydown"
    />
    <div v-if="selectedSkills.length > 0" class="agent-composer__skills d-flex flex-wrap ga-2 mb-2" aria-label="Skills selected for the next message">
      <v-chip
        v-for="skill in selectedSkills"
        :key="skill.versionId"
        size="small"
        color="primary"
        closable
        @click:close="toggleSkill(skill.versionId)"
      >
        {{ skill.name }}
      </v-chip>
    </div>
    <div class="agent-composer__actions d-flex align-center ga-2">
      <v-menu v-if="skillsEnabled" v-model="skillMenuOpen" :close-on-content-click="false">
        <template #activator="{ props: activatorProps }">
          <v-btn
            v-bind="activatorProps"
            variant="text"
            prepend-icon="mdi-puzzle-outline"
            :text="selectedSkills.length > 0 ? `Skills (${selectedSkills.length})` : 'Skills'"
          />
        </template>
        <v-card class="agent-composer__skill-menu" min-width="300" max-width="420">
          <v-card-title class="text-body-large">Use for next message</v-card-title>
          <v-card-subtitle>This selection applies once. Session pins are unchanged.</v-card-subtitle>
          <v-list v-if="skills.length > 0" density="compact" max-height="320" class="overflow-y-auto">
            <v-list-item
              v-for="skill in skills"
              :key="skill.versionId"
              :disabled="disabled || isPinned(skill.versionId) || (!isSelected(skill.versionId) && selectedSkillIds.length >= invocationLimit)"
              @click="toggleSkill(skill.versionId)"
            >
              <template #prepend>
                <v-checkbox-btn :model-value="isSelected(skill.versionId)" tabindex="-1" />
              </template>
              <v-list-item-title>{{ skill.name }}</v-list-item-title>
              <v-list-item-subtitle>{{ isPinned(skill.versionId) ? 'Already pinned to this session' : skill.description }}</v-list-item-subtitle>
              <template #append>
                <v-chip v-if="skill.exposureMode === 'owner'" size="x-small" variant="tonal">Mine</v-chip>
              </template>
            </v-list-item>
          </v-list>
          <v-card-text v-else class="text-medium-emphasis">No skills are available yet.</v-card-text>
          <v-card-text v-if="invocationLimit === 0" class="pt-0 text-body-small text-medium-emphasis">This session already has the maximum 8 pinned skills.</v-card-text>
          <v-divider />
          <v-card-actions>
            <v-btn prepend-icon="mdi-file-document-edit-outline" variant="text" @click="manageSkills">Manage my skills</v-btn>
          </v-card-actions>
        </v-card>
      </v-menu>
      <span class="agent-composer__hint text-body-small text-medium-emphasis">Enter to send · Shift+Enter for a new line</span>
      <v-spacer />
      <v-btn v-if="canStop" color="warning" variant="outlined" prepend-icon="mdi-stop" @click="$emit('stop')">Stop</v-btn>
      <v-btn type="submit" color="primary" prepend-icon="mdi-send" :loading="sending" :disabled="disabled || !draft.trim()">Send</v-btn>
    </div>
  </v-form>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { VisibleAgentSkill } from '../../helpers/agents-api.ts'
import { filterSkillsForCommand } from './agent-skill-command.ts'

const props = defineProps<{
  disabled: boolean
  sending: boolean
  canStop: boolean
  skillsEnabled: boolean
  skills: readonly VisibleAgentSkill[]
  pinnedSkillVersionIds: readonly string[]
  invocationLimit: number
}>()
const emit = defineEmits<{ send: [content: string, invokedSkillVersionIds: readonly string[]]; stop: []; manageSkills: [] }>()
const draft = ref('')
const skillMenuOpen = ref(false)
const selectedSkillIds = ref<string[]>([])
const messageInput = ref<{ focus: () => void } | null>(null)
const commandDismissed = ref(false)
const activeCommandIndex = ref(0)
const pinned = computed(() => new Set(props.pinnedSkillVersionIds))
const selectedSkills = computed(() => selectedSkillIds.value.flatMap(id => {
  const skill = props.skills.find(candidate => candidate.versionId === id)
  return skill ? [skill] : []
}))
const isPinned = (versionId: string): boolean => pinned.value.has(versionId)
const isSelected = (versionId: string): boolean => selectedSkillIds.value.includes(versionId)
const skillCommandQuery = computed<string | null>(() => {
  if (!props.skillsEnabled || props.disabled || commandDismissed.value) return null
  return /^\/([^\s/]*)$/.exec(draft.value)?.[1] ?? null
})
const skillCommandOpen = computed(() => skillCommandQuery.value !== null)
const skillCommandResults = computed(() => filterSkillsForCommand(props.skills, skillCommandQuery.value ?? ''))
const activeCommandSkill = computed(() => skillCommandResults.value[activeCommandIndex.value] ?? null)
const isCommandSkillDisabled = (versionId: string): boolean =>
  props.disabled || isPinned(versionId) || (!isSelected(versionId) && selectedSkillIds.value.length >= props.invocationLimit)
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
  const index = selectedSkillIds.value.indexOf(versionId)
  if (index >= 0) {
    selectedSkillIds.value.splice(index, 1)
    return
  }
  if (props.disabled || isPinned(versionId) || selectedSkillIds.value.length >= props.invocationLimit) return
  selectedSkillIds.value.push(versionId)
}
watch(
  () => [props.skills.map(skill => skill.versionId).join(','), props.pinnedSkillVersionIds.join(','), props.invocationLimit],
  () => {
    const available = new Set(props.skills.map(skill => skill.versionId))
    selectedSkillIds.value = selectedSkillIds.value.filter(id => available.has(id) && !isPinned(id)).slice(0, props.invocationLimit)
  }
)
watch(draft, value => {
  if (!value.startsWith('/')) commandDismissed.value = false
})
watch(skillCommandQuery, () => {
  activeCommandIndex.value = 0
})
const manageSkills = (): void => {
  skillMenuOpen.value = false
  emit('manageSkills')
}
const submit = (): void => {
  if (props.disabled || skillCommandOpen.value || !draft.value.trim()) return
  const content = draft.value
  const invokedSkillVersionIds = [...selectedSkillIds.value]
  draft.value = ''
  selectedSkillIds.value = []
  emit('send', content, invokedSkillVersionIds)
}
</script>

<style scoped>
.agent-composer { position: relative; }
.agent-composer__command-menu {
  bottom: calc(100% + .5rem);
  left: 0;
  max-width: 38rem;
  position: absolute;
  width: min(38rem, 100%);
  z-index: 10;
}
.agent-composer__actions { flex-wrap: wrap; }
.agent-composer__skill-menu :deep(.v-selection-control) { pointer-events: none; }
@media (max-width: 520px) {
  .agent-composer__hint { order: 2; text-align: center; width: 100%; }
}
</style>
