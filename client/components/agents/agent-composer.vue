<template>
  <v-form class="agent-composer" @submit.prevent="submit">
    <v-textarea
      v-model="draft"
      label="Message Wiki Agent"
      placeholder="Ask about pages you can access"
      rows="2"
      max-rows="8"
      auto-grow
      counter="32000"
      :disabled="disabled"
      @keydown.enter.exact.prevent="submit"
      @keydown.ctrl.enter.prevent="submit"
      @keydown.meta.enter.prevent="submit"
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
import { computed, ref, watch } from 'vue'
import type { VisibleAgentSkill } from '../../helpers/agents-api.ts'

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
const pinned = computed(() => new Set(props.pinnedSkillVersionIds))
const selectedSkills = computed(() => selectedSkillIds.value.flatMap(id => {
  const skill = props.skills.find(candidate => candidate.versionId === id)
  return skill ? [skill] : []
}))
const isPinned = (versionId: string): boolean => pinned.value.has(versionId)
const isSelected = (versionId: string): boolean => selectedSkillIds.value.includes(versionId)
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
const manageSkills = (): void => {
  skillMenuOpen.value = false
  emit('manageSkills')
}
const submit = (): void => {
  if (props.disabled || !draft.value.trim()) return
  const content = draft.value
  const invokedSkillVersionIds = [...selectedSkillIds.value]
  draft.value = ''
  selectedSkillIds.value = []
  emit('send', content, invokedSkillVersionIds)
}
</script>

<style scoped>
.agent-composer__actions { flex-wrap: wrap; }
.agent-composer__skill-menu :deep(.v-selection-control) { pointer-events: none; }
@media (max-width: 520px) {
  .agent-composer__hint { order: 2; text-align: center; width: 100%; }
}
</style>
