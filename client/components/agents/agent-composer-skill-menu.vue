<template>
  <v-card
    :id="dialogId"
    class="agent-composer-skill-menu__card"
    role="dialog"
    :aria-labelledby="headingId"
    :aria-describedby="descriptionId"
  >
    <v-card-title :id="headingId" class="text-body-large">{{ $t('common:agentComposerSkillMenu.skills') }}</v-card-title>
    <v-card-subtitle :id="descriptionId">{{ $t('common:agentComposerSkillMenu.selectNextMessageAlways') }}</v-card-subtitle>
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
        {{ $t('common:agentComposerSkillMenu.retry') }}
      </v-btn>
    </div>
    <v-progress-linear v-if="skillsLoading" indeterminate color="primary" :aria-label="$t('common:agentComposerSkillMenu.loadingSkillCatalog')" />
    <v-list v-if="items.length > 0" :aria-label="$t('common:agentComposerSkillMenu.availableSkills')" density="compact" max-height="320" class="overflow-y-auto">
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
            :aria-label="`${skill.name}: ${isSelected(skill.versionId) || isPreferred(skill.versionId) ? $t('common:agentComposerSkillMenu.selected') : $t('common:agentComposerSkillMenu.notSelected')}`"
            :disabled="disabled || sendInProgress || isPreferred(skill.versionId) || isLimited(skill.versionId)"
            :title="isLimited(skill.versionId) ? skillLimitReason : undefined"
            :aria-describedby="isLimited(skill.versionId) ? limitReasonId : undefined"
            @click.stop="toggle(skill.versionId)"
          />
        </template>
        <v-list-item-title>{{ skill.name }}</v-list-item-title>
        <v-list-item-subtitle>{{ isLimited(skill.versionId) ? skillLimitReason : isPreferred(skill.versionId) ? $t('common:agentComposerSkillMenu.alwaysLoadedConversations') : skill.description }}</v-list-item-subtitle>
        <template #append>
          <div class="d-flex align-center ga-1">
            <v-chip v-if="skill.exposureMode === 'owner'" size="x-small" variant="tonal">{{ $t('common:agentComposerSkillMenu.mine') }}</v-chip>
            <v-btn
              class="agent-composer-skill-menu__pin"
              :class="{ 'agent-composer-skill-menu__pin--active': isPreferred(skill.versionId) }"
              :icon="isPreferred(skill.versionId) ? 'mdi-pin' : 'mdi-pin-outline'"
              :color="isPreferred(skill.versionId) ? 'primary' : undefined"
              :variant="isPreferred(skill.versionId) ? 'tonal' : 'text'"
              size="small"
              :disabled="disabled || sendInProgress || networkBlocked || (!isPreferred(skill.versionId) && invocationLimit === 0)"
              :aria-label="isPreferred(skill.versionId) ? $t('common:agentComposerSkillMenu.stopAlwaysLoading', { name: skill.name, interpolation: { escapeValue: false } }) : $t('common:agentComposerSkillMenu.alwaysLoadConversations', { name: skill.name, interpolation: { escapeValue: false } })"
              :aria-pressed="isPreferred(skill.versionId)"
              :title="isPreferred(skill.versionId) ? $t('common:agentComposerSkillMenu.pinnedAlwaysLoads', { name: skill.name, interpolation: { escapeValue: false } }) : $t('common:agentComposerSkillMenu.pinAlwaysLoad', { name: skill.name, interpolation: { escapeValue: false } })"
              @click.stop="emit('togglePreference', skill.versionId)"
            />
          </div>
        </template>
      </v-list-item>
    </v-list>
    <v-card-text v-else-if="!skillsPartial" class="text-medium-emphasis">{{ $t('common:agentComposerSkillMenu.noSkillsAvailableYet') }}</v-card-text>
    <v-card-text v-if="items.some(skill => isLimited(skill.versionId))" :id="limitReasonId" role="status" class="pt-0 text-body-small text-medium-emphasis">{{ skillLimitReason }}</v-card-text>
    <v-divider />
    <v-card-actions>
      <v-btn prepend-icon="mdi-file-document-edit-outline" variant="text" :disabled="disabled || sendInProgress" @click="manageSkills">{{ $t('common:agentComposerSkillMenu.manageMySkills') }}</v-btn>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

/**
 * Presentational skill picker for the composer's explicit Skills control.
 * Selection state stays with the parent composer; this component only renders
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
const limitReasonId = `${generatedId}-skills-limit`
const isLimited = (versionId: string): boolean =>
  !isPreferred(versionId) && !isSelected(versionId) && props.selectedSkillVersionIds.length >= props.invocationLimit
const skillLimitReason = computed(() => props.invocationLimit === 0
  ? t('common:agentComposerSkillMenu.youHaveMaximum8')
  : t('common:agentComposer.skillSelectionLimit', { limit: props.invocationLimit }))

const skillLoadTitle = computed(() => props.skillsLoadError
  ? props.skillsCount > 0 ? t('common:agentComposerSkillMenu.skillCatalogIncomplete') : t('common:agentComposerSkillMenu.skillCatalogUnavailable')
  : t('common:agentComposerSkillMenu.loadingSkillCatalog'))
const skillLoadMessage = computed(() => props.skillsLoadError
  ? props.skillsCount > 0
    ? t('common:agentComposerSkillMenu.showingLastLoadedCatalog', { skillsLoadError: props.skillsLoadError, interpolation: { escapeValue: false } })
    : props.skillsLoadError
  : t('common:agentComposerSkillMenu.availableSkillsStillBeing'))

const toggle = (versionId: string): void => {
  if (props.disabled || props.sendInProgress || isPreferred(versionId) || isLimited(versionId)) return
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
.agent-composer-skill-menu__card {
  width: min(420px, calc(100vw - 32px));
  min-width: 0;
  max-height: min(640px, 75dvh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface));
}

.agent-composer-skill-menu__card :deep(.v-card-title) {
  padding: var(--wiki-space-3) var(--wiki-space-4) var(--wiki-space-1);
  font-size: 1rem;
  font-weight: 650;
  white-space: normal;
}

.agent-composer-skill-menu__card :deep(.v-card-subtitle) {
  flex: 0 0 auto;
  padding-block-end: var(--wiki-space-3);
  color: var(--wiki-text-muted);
  opacity: 1;
  white-space: normal;
  overflow-wrap: anywhere;
}

.agent-composer-skill-menu__card :deep(.v-list) {
  min-height: 0;
  flex: 1 1 auto;
  max-height: min(320px, 44dvh) !important;
  border-block-start: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-raised);
  overscroll-behavior: contain;
}

.agent-composer-skill-menu__card :deep(.v-list-item) { min-height: 64px; padding-inline: var(--wiki-space-2); }
.agent-composer-skill-menu__card :deep(.v-list-item__prepend > .v-list-item__spacer) { width: var(--wiki-space-1); }
.agent-composer-skill-menu__card :deep(.v-list-item__append > .v-list-item__spacer) { width: var(--wiki-space-1); }
.agent-composer-skill-menu__card :deep(.v-list-item-title),
.agent-composer-skill-menu__card :deep(.v-list-item-subtitle) { white-space: normal; overflow-wrap: anywhere; }
.agent-composer-skill-menu__card :deep(.v-list-item-subtitle) { color: var(--wiki-text-muted); opacity: 1; line-height: 1.5; }
.agent-composer-skill-menu__card :deep(.v-card-actions) { flex: 0 0 auto; flex-wrap: wrap; padding: var(--wiki-space-2); }
.agent-composer-skill-menu__card :deep(.v-card-actions .v-btn) { min-height: 44px; max-width: 100%; border-radius: var(--wiki-control-radius); }
.agent-composer-skill-menu__card :deep(.v-btn__content) { white-space: normal; }
.agent-composer-skill-menu__card :deep(.v-btn:focus-visible) { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }

.agent-composer-skill-menu__pin {
  min-width: max(44px, var(--wiki-control-height));
  min-height: max(44px, var(--wiki-control-height));
  border-radius: var(--wiki-control-radius);
}

.agent-composer-skill-menu__load-state {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: var(--wiki-space-2);
  margin: var(--wiki-space-3);
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.agent-composer-skill-menu__load-state > .v-btn { grid-column: 2; justify-self: start; min-height: 44px; }
.agent-composer-skill-menu__load-state--error { border-color: var(--wiki-error-ink); }
.agent-composer-skill-menu__load-state > div { display: grid; min-width: 0; gap: var(--wiki-space-1); }
.agent-composer-skill-menu__load-state strong { font-size: .875rem; overflow-wrap: anywhere; }
.agent-composer-skill-menu__load-state span { color: var(--wiki-text-muted); font-size: var(--wiki-label-size); overflow-wrap: anywhere; }
</style>
