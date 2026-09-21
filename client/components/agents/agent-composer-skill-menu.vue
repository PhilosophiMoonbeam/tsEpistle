<template>
  <v-card
    :id="dialogId"
    class="agent-composer-skill-menu__card"
    min-width="300"
    max-width="420"
    role="dialog"
    :aria-labelledby="headingId"
    :aria-describedby="descriptionId"
  >
    <v-card-title :id="headingId" class="text-body-large">Skills</v-card-title>
    <v-card-subtitle :id="descriptionId">Select for the next message or always load in conversations.</v-card-subtitle>
    <div
      v-if="skillsPartial"
      class="agent-composer-skill-menu__load-state"
      :class="{ 'agent-composer-skill-menu__load-state--error': skillsLoadError }"
      :role="skillsLoadError ? 'alert' : 'status'"
      aria-live="polite"
    >
      <v-icon :icon="skillsLoadError ? 'mdi-cloud-alert-outline' : 'mdi-cloud-sync-outline'" size="20" aria-hidden="true" />
      <div>
        <strong>{{ skillLoadTitle }}</strong>
        <span>{{ skillLoadMessage }}</span>
      </div>
      <v-btn v-if="skillsLoadError" prepend-icon="mdi-refresh" size="small" variant="tonal" :loading="skillsLoading" :disabled="skillsLoading || networkBlocked" @click="retrySkills">
        Retry
      </v-btn>
    </div>
    <v-progress-linear v-if="skillsLoading" indeterminate color="primary" aria-label="Loading skill catalog" />
    <v-list v-if="items.length > 0" aria-label="Available skills" density="compact" max-height="320" class="overflow-y-auto">
      <v-list-item
        v-for="skill in items"
        :key="skill.versionId"
        :active="isSelected(skill.versionId) || isPreferred(skill.versionId)"
        :disabled="disabled || sendInProgress"
        @click="toggle(skill.versionId)"
      >
        <template #prepend>
          <v-checkbox-btn
            :model-value="isSelected(skill.versionId) || isPreferred(skill.versionId)"
            :aria-label="`${skill.name}: ${isSelected(skill.versionId) || isPreferred(skill.versionId) ? 'selected' : 'not selected'}`"
            :disabled="disabled || sendInProgress || isPreferred(skill.versionId) || (!isSelected(skill.versionId) && selectedSkillVersionIds.length >= invocationLimit)"
            @click.stop="toggle(skill.versionId)"
          />
        </template>
        <v-list-item-title>{{ skill.name }}</v-list-item-title>
        <v-list-item-subtitle>{{ isPreferred(skill.versionId) ? 'Always loaded in conversations' : skill.description }}</v-list-item-subtitle>
        <template #append>
          <div class="d-flex align-center ga-1">
            <v-chip v-if="skill.exposureMode === 'owner'" size="x-small" variant="tonal">Mine</v-chip>
            <v-btn
              class="agent-composer-skill-menu__pin"
              :class="{ 'agent-composer-skill-menu__pin--active': isPreferred(skill.versionId) }"
              :icon="isPreferred(skill.versionId) ? 'mdi-pin' : 'mdi-pin-outline'"
              :color="isPreferred(skill.versionId) ? 'primary' : undefined"
              :variant="isPreferred(skill.versionId) ? 'tonal' : 'text'"
              size="small"
              :disabled="disabled || sendInProgress || networkBlocked || (!isPreferred(skill.versionId) && invocationLimit === 0)"
              :aria-label="isPreferred(skill.versionId) ? `Stop always loading ${skill.name}` : `Always load ${skill.name} in conversations`"
              :aria-pressed="isPreferred(skill.versionId)"
              :title="isPreferred(skill.versionId) ? `Pinned: ${skill.name} always loads` : `Pin ${skill.name} to always load`"
              @click.stop="emit('togglePreference', skill.versionId)"
            />
          </div>
        </template>
      </v-list-item>
    </v-list>
    <v-card-text v-else-if="!skillsPartial" class="text-medium-emphasis">No skills are available yet.</v-card-text>
    <v-card-text v-if="invocationLimit === 0" class="pt-0 text-body-small text-medium-emphasis">You have the maximum 8 automatically loaded skills. Remove one to make room.</v-card-text>
    <v-divider />
    <v-card-actions>
      <v-btn prepend-icon="mdi-file-document-edit-outline" variant="text" :disabled="sendInProgress" @click="manageSkills">Manage my skills</v-btn>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'

/**
 * Presentational skill picker card shared by the composer's inline Skills
 * trigger menu and the compact Skills entry folded into the More menu. All
 * selection state stays with the parent composer; this component only renders
 * it and reports the user's intent.
 */
interface AgentComposerSkillMenuItem {
  readonly versionId: string
  readonly name: string
  readonly description: string
  readonly exposureMode?: 'all_agent_users' | 'groups' | 'owner'
}

const props = withDefaults(defineProps<{
  items: readonly AgentComposerSkillMenuItem[]
  skillsCount: number
  skillsLoading: boolean
  skillsLoadError: string
  skillsPartial: boolean
  disabled: boolean
  sendInProgress: boolean
  networkBlocked?: boolean
  invocationLimit: number
  selectedSkillVersionIds: readonly string[]
  preferredVersionIds: readonly string[]
  dialogId?: string
  headingId?: string
  descriptionId?: string
}>(), {
  networkBlocked: false,
  dialogId: undefined,
  headingId: undefined,
  descriptionId: undefined
})

const emit = defineEmits<{
  toggle: [versionId: string]
  togglePreference: [versionId: string]
  manageSkills: []
  retrySkills: []
}>()

const generatedId = useId()
const dialogId = computed(() => props.dialogId ?? `${generatedId}-skills-dialog`)
const headingId = computed(() => props.headingId ?? `${generatedId}-skills-heading`)
const descriptionId = computed(() => props.descriptionId ?? `${generatedId}-skills-description`)

const selectedSkillVersionIdSet = computed(() => new Set(props.selectedSkillVersionIds))
const preferredVersionIdSet = computed(() => new Set(props.preferredVersionIds))
const isSelected = (versionId: string): boolean => selectedSkillVersionIdSet.value.has(versionId)
const isPreferred = (versionId: string): boolean => preferredVersionIdSet.value.has(versionId)

const skillLoadTitle = computed(() => props.skillsLoadError
  ? props.skillsCount > 0 ? 'Skill catalog incomplete' : 'Skill catalog unavailable'
  : 'Loading skill catalog')
const skillLoadMessage = computed(() => props.skillsLoadError
  ? props.skillsCount > 0
    ? `Showing the last-loaded catalog. ${props.skillsLoadError}`
    : props.skillsLoadError
  : 'Available skills are still being loaded.')

const toggle = (versionId: string): void => {
  if (props.disabled || props.sendInProgress) return
  emit('toggle', versionId)
}
const manageSkills = (): void => {
  if (props.disabled || props.sendInProgress) return
  emit('manageSkills')
}
const retrySkills = (): void => {
  if (props.skillsLoading || props.networkBlocked) return
  emit('retrySkills')
}
</script>

<style scoped>
.agent-composer-skill-menu__pin {
  min-width: max(44px, var(--wiki-control-height));
  min-height: max(44px, var(--wiki-control-height));
}

.agent-composer-skill-menu__pin--active {
  box-shadow: var(--wiki-shadow-inset);
}

.agent-composer-skill-menu__load-state {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--wiki-space-2);
  margin: var(--wiki-space-3);
  padding: var(--wiki-space-3);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 28%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 8%, var(--wiki-surface-raised));
}

.agent-composer-skill-menu__load-state--error {
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 32%, var(--wiki-surface-border));
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 8%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-error));
}

.agent-composer-skill-menu__load-state > div {
  display: grid;
  gap: 2px;
}

.agent-composer-skill-menu__load-state span {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: var(--wiki-label-size);
  overflow-wrap: anywhere;
}
</style>
