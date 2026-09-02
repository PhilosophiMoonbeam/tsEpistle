<template>
  <v-form
    ref="composerRoot"
    class="agent-composer"
    :class="{
      'agent-composer--sending': sendInProgress || canStop,
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
        aria-multiselectable="true"
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
        <v-list-item v-if="skillCommandResults.length === 0 && skillsLoading" role="option" aria-disabled="true" title="Loading skill catalog" subtitle="Wait for the available skills to finish loading." disabled />
        <v-list-item v-else-if="skillCommandResults.length === 0 && skillsPartial" role="option" aria-disabled="true" :title="skillLoadTitle" :subtitle="skillLoadMessage" disabled />
        <v-list-item v-else-if="skillCommandResults.length === 0" role="option" aria-disabled="true" title="No matching skills" subtitle="Try another name or description." disabled />
      </v-list>
      <div class="agent-composer__command-status sr-only" role="status" aria-live="polite">{{ skillCommandStatus }}</div>
      <v-card-actions v-if="skillsLoadError" class="agent-composer__command-retry">
        <span>{{ skills.length > 0 ? 'Showing the last-loaded catalog.' : 'No catalog entries are available.' }}</span>
        <v-btn prepend-icon="mdi-refresh" size="small" variant="text" :loading="skillsLoading" @click="retrySkills">Retry catalog</v-btn>
      </v-card-actions>
    </v-card>

    <div class="agent-composer__editor">
      <v-textarea
        ref="messageInput"
        v-model="draft"
        class="agent-composer__input"
        :aria-label="composerInputLabel"
        aria-describedby="agent-composer-status agent-composer-keyboard-hint"
        :role="skillsEnabled ? 'combobox' : undefined"
        :aria-autocomplete="skillsEnabled ? 'list' : undefined"
        :aria-haspopup="skillsEnabled ? 'listbox' : undefined"
        :placeholder="goalMode ? 'Describe a bounded outcome for Wiki Agent' : skillsEnabled ? 'Ask a follow-up · Type / for skills' : 'Ask a follow-up'"
        rows="3"
        variant="solo"
        flat
        hide-details
        :disabled="disabled || sendInProgress"
        :aria-expanded="skillsEnabled ? skillCommandOpen : undefined"
        :aria-controls="skillsEnabled && skillCommandOpen ? 'agent-skill-command-results' : undefined"
        :aria-activedescendant="skillsEnabled && skillCommandOpen && activeCommandSkill ? `agent-skill-command-${activeCommandSkill.versionId}` : undefined"
        @select="handleSelectionChange"
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
          :close-label="`Remove ${skill.name}`"
          size="small"
          color="primary"
          variant="tonal"
          :disabled="disabled || sendInProgress"
          @click:close="toggleSkill(skill.versionId)"
        >
          {{ skill.name }}
        </v-chip>
      </div>
    </div>

    <div class="agent-composer__actions">
      <div class="agent-composer__context-controls" role="group" aria-label="Conversation context controls">
        <v-menu v-if="skillsEnabled" v-model="skillMenuOpen" :close-on-content-click="false">
          <template #activator="{ props: activatorProps }">
            <v-btn
              id="agent-composer-skills-trigger"
              ref="skillsTrigger"
              v-bind="activatorProps"
              class="agent-composer__skill-button"
              variant="text"
              :prepend-icon="skillsLoadError ? 'mdi-puzzle-remove-outline' : 'mdi-puzzle-outline'"
              :color="skillsLoadError ? 'error' : undefined"
              :disabled="disabled || sendInProgress"
              :aria-label="skillsLoadError ? `Choose skills; the skill catalog is ${skills.length > 0 ? 'incomplete' : 'unavailable'}` : 'Choose skills for the next message'"
              aria-haspopup="dialog"
              aria-controls="agent-composer-skills-menu"
              :aria-expanded="skillMenuOpen"
            >
              <span class="d-none d-sm-inline">{{ selectedSkills.length > 0 ? `Skills (${selectedSkills.length})` : skillsLoadError ? skills.length > 0 ? 'Skills incomplete' : 'Skills unavailable' : 'Skills' }}</span>
            </v-btn>
          </template>
          <v-card id="agent-composer-skills-menu" class="agent-composer__skill-menu" min-width="300" max-width="420" role="dialog" aria-labelledby="agent-composer-skills-title">
            <v-card-title id="agent-composer-skills-title" class="text-body-large">Skills</v-card-title>
            <v-card-subtitle>Select for the next message or always load in conversations.</v-card-subtitle>
            <div
              v-if="skillsPartial"
              class="agent-composer__skill-load-state"
              :class="{ 'agent-composer__skill-load-state--error': skillsLoadError }"
              :role="skillsLoadError ? 'alert' : 'status'"
              aria-live="polite"
            >
              <v-icon :icon="skillsLoadError ? 'mdi-cloud-alert-outline' : 'mdi-cloud-sync-outline'" size="20" aria-hidden="true" />
              <div>
                <strong>{{ skillLoadTitle }}</strong>
                <span>{{ skillLoadMessage }}</span>
              </div>
              <v-btn v-if="skillsLoadError" prepend-icon="mdi-refresh" size="small" variant="tonal" :loading="skillsLoading" @click="retrySkills">
                Retry
              </v-btn>
            </div>
            <v-progress-linear v-if="skillsLoading" indeterminate color="primary" aria-label="Loading skill catalog" />
            <v-list v-if="skillMenuItems.length > 0" aria-label="Available skills" density="compact" max-height="320" class="overflow-y-auto">
              <v-list-item
                v-for="skill in skillMenuItems"
                :key="skill.versionId"
                :active="isSelected(skill.versionId) || isPreferred(skill.versionId)"
                :disabled="disabled || sendInProgress"
                @click="toggleSkill(skill.versionId)"
              >
                <template #prepend>
                  <v-checkbox-btn
                    :model-value="isSelected(skill.versionId) || isPreferred(skill.versionId)"
                    :aria-label="`${skill.name}: ${isSelected(skill.versionId) || isPreferred(skill.versionId) ? 'selected' : 'not selected'}`"
                    :disabled="disabled || sendInProgress || isPreferred(skill.versionId) || (!isSelected(skill.versionId) && selectedSkillIds.length >= invocationLimit)"
                    @click.stop="toggleSkill(skill.versionId)"
                  />
                </template>
                <v-list-item-title>{{ skill.name }}</v-list-item-title>
                <v-list-item-subtitle>{{ isPreferred(skill.versionId) ? 'Always loaded in conversations' : skill.description }}</v-list-item-subtitle>
                <template #append>
                  <div class="d-flex align-center ga-1">
                    <v-chip v-if="skill.exposureMode === 'owner'" size="x-small" variant="tonal">Mine</v-chip>
                    <v-btn
                      class="agent-composer__pin"
                      :class="{ 'agent-composer__pin--active': isPreferred(skill.versionId) }"
                      :icon="isPreferred(skill.versionId) ? 'mdi-pin' : 'mdi-pin-outline'"
                      :color="isPreferred(skill.versionId) ? 'primary' : undefined"
                      :variant="isPreferred(skill.versionId) ? 'tonal' : 'text'"
                      size="small"
                      :disabled="disabled || sendInProgress || (!isPreferred(skill.versionId) && invocationLimit === 0)"
                      :aria-label="isPreferred(skill.versionId) ? `Stop always loading ${skill.name}` : `Always load ${skill.name} in conversations`"
                      :aria-pressed="isPreferred(skill.versionId)"
                      :title="isPreferred(skill.versionId) ? `Pinned: ${skill.name} always loads` : `Pin ${skill.name} to always load`"
                      @click.stop="togglePreference(skill.versionId)"
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
        </v-menu>
        <v-btn
          v-if="goalsEnabled"
          class="agent-composer__goal-button"
          :color="goalMode ? 'primary' : undefined"
          :variant="goalMode ? 'tonal' : 'text'"
          prepend-icon="mdi-target"
          aria-label="Toggle goal mode"
          :aria-pressed="goalMode"
          :disabled="disabled || sendInProgress"
          @click="goalMode = !goalMode"
        >
          <span class="d-none d-sm-inline">Goal</span>
        </v-btn>
      </div>

      <div
        id="agent-composer-status"
        class="agent-composer__state"
        :class="`agent-composer__state--${statusTone}`"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        :title="statusLabel"
      >
        <span class="agent-composer__state-dot" aria-hidden="true" />
        <span>{{ statusLabel }}</span>
      </div>

      <div class="agent-composer__primary-actions" role="group" aria-label="Message actions">
        <v-btn
          v-if="canStop"
          class="agent-composer__stop"
          color="warning"
          variant="outlined"
          prepend-icon="mdi-stop"
          @click="$emit('stop')"
        >Stop response</v-btn>
        <v-btn
          v-if="!canStop"
          class="agent-composer__submit"
          type="submit"
          color="primary"
          :prepend-icon="sendFailed ? 'mdi-refresh' : goalMode ? 'mdi-target-arrow' : 'mdi-send'"
          :loading="sendInProgress"
          :disabled="disabled || sendInProgress || !draft.trim()"
        >{{ submitLabel }}</v-btn>
      </div>
    </div>

    <span id="agent-composer-keyboard-hint" class="agent-composer__hint">
      Enter to send; Shift+Enter for a new line
    </span>
  </v-form>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AgentSessionSkillView } from '../../../shared/agents/contracts.ts'
import type { VisibleAgentSkill } from '../../helpers/agents-api.ts'
import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'
import { caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret } from './agent-composer-sizing.ts'
const props = defineProps<{
  disabled: boolean
  sending: boolean
  canStop: boolean
  skillsEnabled: boolean
  goalsEnabled: boolean
  skills: readonly VisibleAgentSkill[]
  skillsLoading: boolean
  skillsLoadError: string
  skillsPartial: boolean
  preferredSkills: readonly AgentSessionSkillView[]
  invocationLimit: number
  statusLabel: string
  statusTone: 'ready' | 'error' | 'busy'
}>()
const emit = defineEmits<{ send: [content: string, invokedSkillVersionIds: readonly string[], mode: 'message' | 'goal', completion?: (success: boolean) => void]; stop: []; manageSkills: []; retrySkills: []; updateSkillPreferences: [skillIds: string[]] }>()
const draft = ref('')
const goalMode = ref(false)
const skillMenuOpen = ref(false)
const selectedSkillIds = ref<string[]>([])
const composerRoot = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const messageInput = ref<{ focus: () => void; $el?: HTMLElement } | null>(null)
const skillsTrigger = ref<{ focus?: () => void; $el?: HTMLElement } | HTMLElement | null>(null)
const dismissedCommandToken = ref<{ start: number; prefix: string } | null>(null)
const activeCommandIndex = ref(0)
const sendFailed = ref(false)
const submissionPending = ref(false)
const sendInProgress = computed(() => props.sending || submissionPending.value)
let restoreInputWhenReady = false
let mounted = false
const preferredSkillIds = computed(() => new Set(props.preferredSkills.map(skill => skill.skillId)))
const preferredSkillIdByVersionId = computed(() => new Map(props.preferredSkills.map(skill => [skill.versionId, skill.skillId])))
const selectedSkillIdSet = computed(() => new Set(selectedSkillIds.value))
const visibleSkillIds = computed(() => new Set(props.skills.map(skill => skill.id)))
const visibleSkillByVersionId = computed(() => new Map(props.skills.map(skill => [skill.versionId, skill])))
const selectedSkills = computed(() => selectedSkillIds.value.flatMap(id => {
  const skill = visibleSkillByVersionId.value.get(id)
  return skill ? [skill] : []
}))
const skillMenuItems = computed(() => [
  ...filterUserSelectableSkills(props.skills),
  ...filterPreferredBuiltInSkills(props.skills, preferredSkillIdByVersionId.value),
  ...props.preferredSkills
    .filter(skill => skill.sourcePath.startsWith('personal/') && !visibleSkillIds.value.has(skill.skillId))
    .map(skill => ({ ...skill, exposureMode: undefined }))
])
const skillIdForVersion = (versionId: string): string | undefined =>
  visibleSkillByVersionId.value.get(versionId)?.id ?? preferredSkillIdByVersionId.value.get(versionId)
const isPreferred = (versionId: string): boolean => {
  const skillId = skillIdForVersion(versionId)
  return skillId !== undefined && preferredSkillIds.value.has(skillId)
}
const composerInputLabel = computed(() => goalMode.value ? 'Define an outcome for Wiki Agent' : 'Message Wiki Agent')
const submitLabel = computed(() => sendFailed.value ? 'Retry' : goalMode.value ? 'Start goal' : 'Send')
const isSelected = (versionId: string): boolean => selectedSkillIdSet.value.has(versionId)
const getTextarea = (): HTMLTextAreaElement | null => {
  const textarea = messageInput.value?.$el?.querySelector('textarea')
  return textarea instanceof HTMLTextAreaElement ? textarea : null
}
let caretMirror: HTMLDivElement | null = null
let caretMirrorPrefix: Text | null = null
let caretMirrorMarker: HTMLSpanElement | null = null
let caretMirrorSuffix: Text | null = null

const mountCaretMirror = (): void => {
  if (typeof document === 'undefined' || !document.body || caretMirror) return
  const mirror = document.createElement('div')
  const prefix = document.createTextNode('')
  const marker = document.createElement('span')
  const suffix = document.createTextNode('\u200b')
  marker.appendChild(suffix)
  mirror.append(prefix, marker)
  mirror.setAttribute('aria-hidden', 'true')
  mirror.setAttribute('inert', '')
  mirror.style.position = 'fixed'
  mirror.style.left = '-100000px'
  mirror.style.top = '0'
  mirror.style.visibility = 'hidden'
  mirror.style.pointerEvents = 'none'
  mirror.style.overflow = 'hidden'
  mirror.style.margin = '0'
  mirror.style.border = '0'
  mirror.style.boxSizing = 'border-box'
  document.body.appendChild(mirror)
  caretMirror = mirror
  caretMirrorPrefix = prefix
  caretMirrorMarker = marker
  caretMirrorSuffix = suffix
}

const unmountCaretMirror = (): void => {
  caretMirror?.remove()
  caretMirror = null
  caretMirrorPrefix = null
  caretMirrorMarker = null
  caretMirrorSuffix = null
}

interface CaretBounds {
  readonly top: number
  readonly bottom: number
}

const measureCaretBounds = (textarea: HTMLTextAreaElement, styles: CSSStyleDeclaration): CaretBounds | null => {
  const mirror = caretMirror
  const prefix = caretMirrorPrefix
  const marker = caretMirrorMarker
  const suffix = caretMirrorSuffix
  if (!mirror || !prefix || !marker || !suffix || textarea.clientWidth <= 0) return null

  const mirrorStyle = mirror.style
  mirrorStyle.width = `${textarea.clientWidth}px`
  mirrorStyle.paddingTop = styles.paddingTop
  mirrorStyle.paddingRight = styles.paddingRight
  mirrorStyle.paddingBottom = styles.paddingBottom
  mirrorStyle.paddingLeft = styles.paddingLeft
  mirrorStyle.font = styles.font
  mirrorStyle.fontKerning = styles.fontKerning
  mirrorStyle.fontFeatureSettings = styles.fontFeatureSettings
  mirrorStyle.fontVariationSettings = styles.fontVariationSettings
  mirrorStyle.lineHeight = styles.lineHeight
  mirrorStyle.letterSpacing = styles.letterSpacing
  mirrorStyle.wordSpacing = styles.wordSpacing
  mirrorStyle.textAlign = styles.textAlign
  mirrorStyle.textIndent = styles.textIndent
  mirrorStyle.textTransform = styles.textTransform
  mirrorStyle.direction = styles.direction
  mirrorStyle.tabSize = styles.tabSize
  mirrorStyle.whiteSpace = styles.whiteSpace
  mirrorStyle.overflowWrap = styles.overflowWrap
  mirrorStyle.wordBreak = styles.wordBreak

  const selectionStart = textarea.selectionStart ?? textarea.value.length
  const selectionEnd = textarea.selectionEnd ?? selectionStart
  const caretIndex = textarea.selectionDirection === 'backward' ? selectionStart : selectionEnd
  prefix.data = textarea.value.slice(0, caretIndex)
  suffix.data = textarea.value.slice(caretIndex) || '\u200b'

  const caretRect = marker.getClientRects()[0]
  if (!caretRect) return null
  const mirrorRect = mirror.getBoundingClientRect()
  const lineHeight = Number.parseFloat(styles.lineHeight) || caretRect.height || 24
  return caretBoundsFromMirror(caretRect.top, mirrorRect.top, caretRect.height, lineHeight)
}

const keepCaretVisible = (textarea: HTMLTextAreaElement): void => {
  if (typeof window === 'undefined' || textarea.clientHeight <= 0) return
  const styles = window.getComputedStyle(textarea)
  const maxHeight = Number.parseFloat(styles.maxHeight)
  if (!Number.isFinite(maxHeight) || textarea.scrollHeight <= maxHeight) return
  const caret = measureCaretBounds(textarea, styles)
  if (!caret) return
  const paddingTop = Number.parseFloat(styles.paddingTop) || 0
  const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0
  const nextScrollTop = scrollTopForCaret({
    scrollTop: textarea.scrollTop,
    clientHeight: textarea.clientHeight,
    scrollHeight: textarea.scrollHeight,
    paddingTop,
    paddingBottom,
    caret
  })
  textarea.scrollTop = nextScrollTop
}
const resizeInput = (): void => {
  const textarea = getTextarea()
  if (!textarea) return
  textarea.style.height = '0px'
  textarea.style.overflowY = 'hidden'
  const styles = window.getComputedStyle(textarea)
  const minHeight = Number.parseFloat(styles.minHeight) || 0
  const maxHeight = Number.parseFloat(styles.maxHeight) || Number.POSITIVE_INFINITY
  const contentHeight = textarea.scrollHeight
  const { height, overflowing } = calculateComposerSizing(contentHeight, minHeight, maxHeight)
  textarea.style.height = `${height}px`
  textarea.style.overflowY = overflowing ? 'auto' : 'hidden'
  if (!overflowing) textarea.scrollTop = 0
  else keepCaretVisible(textarea)
}
const handleSelectionChange = (): void => {
  void nextTick(() => {
    const textarea = getTextarea()
    if (textarea) keepCaretVisible(textarea)
  })
}
const focusInput = async (): Promise<void> => {
  await nextTick()
  messageInput.value?.focus()
}
const togglePreference = (versionId: string): void => {
  if (props.disabled || sendInProgress.value) return
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
interface SkillCommandMatch {
  readonly query: string
  readonly start: number
  readonly end: number
}
const skillCommandCandidate = computed<SkillCommandMatch | null>(() => {
  if (!props.skillsEnabled || props.disabled || sendInProgress.value) return null
  const match = /(^|\s)\/([^\s/]*)$/.exec(draft.value)
  if (!match) return null
  const boundary = match[1] ?? ''
  return {
    query: match[2] ?? '',
    start: match.index + boundary.length,
    end: draft.value.length
  }
})
const skillCommandMatch = computed<SkillCommandMatch | null>(() => {
  const candidate = skillCommandCandidate.value
  const dismissed = dismissedCommandToken.value
  if (!candidate) return null
  if (dismissed && dismissed.start === candidate.start && dismissed.prefix === draft.value.slice(0, candidate.start)) return null
  return candidate
})
const skillCommandQuery = computed<string | null>(() => skillCommandMatch.value?.query ?? null)
const skillCommandOpen = computed(() => skillCommandQuery.value !== null)
const skillCommandResults = computed(() => skillCommandQuery.value === null ? [] : filterSkillsForCommand(props.skills, skillCommandQuery.value))
const skillLoadTitle = computed(() => props.skillsLoadError
  ? props.skills.length > 0 ? 'Skill catalog incomplete' : 'Skill catalog unavailable'
  : 'Loading skill catalog')
const skillLoadMessage = computed(() => props.skillsLoadError
  ? props.skills.length > 0
    ? `Showing the last-loaded catalog. ${props.skillsLoadError}`
    : props.skillsLoadError
  : 'Available skills are still being loaded.')
const activeCommandSkill = computed(() => skillCommandResults.value[activeCommandIndex.value] ?? null)
const skillCommandStatus = computed(() => skillCommandResults.value.length
  ? `${skillCommandResults.value.length} matching skills`
  : props.skillsLoading
    ? 'Loading skill catalog'
    : props.skillsPartial
      ? props.skills.length > 0 ? 'Skill catalog incomplete' : 'Skill catalog unavailable'
      : 'No matching skills')
const isCommandSkillDisabled = (versionId: string): boolean =>
  props.disabled || sendInProgress.value || isPreferred(versionId) || (!isSelected(versionId) && selectedSkillIds.value.length >= props.invocationLimit)
const invokeCommandSkill = (skill: VisibleAgentSkill): void => {
  const command = skillCommandMatch.value
  if (!command || isCommandSkillDisabled(skill.versionId)) return
  if (!isSelected(skill.versionId)) toggleSkill(skill.versionId)
  const remainingDraft = `${draft.value.slice(0, command.start)}${draft.value.slice(command.end)}`
  draft.value = remainingDraft.trim() ? remainingDraft : ''
  dismissedCommandToken.value = null
  activeCommandIndex.value = 0
  void nextTick(() => {
    messageInput.value?.focus()
    const textarea = messageInput.value?.$el?.querySelector('textarea')
    if (textarea instanceof HTMLTextAreaElement) textarea.setSelectionRange(draft.value.length, draft.value.length)
  })
}
const handleKeydown = (event: KeyboardEvent): void => {
  if (event.isComposing) return
  if (skillCommandOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      const command = skillCommandCandidate.value
      if (command) dismissedCommandToken.value = { start: command.start, prefix: draft.value.slice(0, command.start) }
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
  if (props.disabled || sendInProgress.value) return
  const index = selectedSkillIds.value.indexOf(versionId)
  if (index >= 0) {
    selectedSkillIds.value.splice(index, 1)
    return
  }
  if (isPreferred(versionId) || selectedSkillIds.value.length >= props.invocationLimit) return
  selectedSkillIds.value.push(versionId)
}
watch(
  [visibleSkillByVersionId, preferredSkillIds, () => props.invocationLimit],
  () => {
    selectedSkillIds.value = selectedSkillIds.value
      .filter(id => visibleSkillByVersionId.value.has(id) && !isPreferred(id))
      .slice(0, props.invocationLimit)
  }
)
watch(draft, value => {
  const dismissed = dismissedCommandToken.value
  const candidate = skillCommandCandidate.value
  if (dismissed && (
    !candidate ||
    candidate.start !== dismissed.start ||
    value.slice(0, dismissed.start) !== dismissed.prefix
  )) dismissedCommandToken.value = null
  if (sendFailed.value) sendFailed.value = false
  void nextTick(resizeInput)
})
watch(skillCommandResults, () => {
  activeCommandIndex.value = 0
})
watch(
  () => [props.disabled, props.sending, props.canStop, submissionPending.value] as const,
  ([disabled, sending, canStop, pending]) => {
    if (disabled || sending || canStop || pending || !restoreInputWhenReady) return
    restoreInputWhenReady = false
    void nextTick(() => {
      if (typeof document === 'undefined') return
      const root = composerRoot.value instanceof HTMLElement ? composerRoot.value : composerRoot.value?.$el
      const activeElement = document.activeElement
      if (activeElement === document.body || activeElement === null || root?.contains(activeElement)) {
        messageInput.value?.focus()
      }
    })
  },
  { flush: 'post' }
)
const manageSkills = (): void => {
  if (props.disabled || sendInProgress.value) return
  skillMenuOpen.value = false
  emit('manageSkills')
}
const retrySkills = (): void => {
  if (props.skillsLoading) return
  emit('retrySkills')
}
const focusSkillsTrigger = async (): Promise<void> => {
  await nextTick()
  const trigger = skillsTrigger.value
  if (trigger instanceof HTMLElement) trigger.focus()
  else if (trigger?.$el instanceof HTMLElement) trigger.$el.focus()
  else trigger?.focus?.()
}
const resetInput = (): void => {
  resizeInput()
  const textarea = getTextarea()
  if (textarea) textarea.scrollTop = 0
}
const submit = (): void => {
  if (props.disabled || sendInProgress.value || skillCommandOpen.value || !draft.value.trim()) return
  const content = draft.value
  const invokedSkillVersionIds = [...selectedSkillIds.value]
  const mode = goalMode.value ? 'goal' : 'message'
  submissionPending.value = true
  skillMenuOpen.value = false
  restoreInputWhenReady = true
  sendFailed.value = false
  emit('send', content, invokedSkillVersionIds, mode, (success: boolean) => {
    if (!mounted) return
    submissionPending.value = false
    sendFailed.value = !success
    if (success) {
      if (draft.value === content) {
        draft.value = ''
        void nextTick(resetInput)
      }
      selectedSkillIds.value = []
      goalMode.value = false
    } else {
      restoreInputWhenReady = false
      void nextTick(() => {
        messageInput.value?.focus()
        resizeInput()
      })
    }
  })
}
defineExpose({ focusInput, focusSkillsTrigger })
onMounted(() => {
  mounted = true
  mountCaretMirror()
  resizeInput()
  window.addEventListener('resize', resizeInput)
})
onBeforeUnmount(() => {
  mounted = false
  window.removeEventListener('resize', resizeInput)
  unmountCaretMirror()
})
</script>

<style scoped>
.agent-composer {
  position: relative;
  display: flex;
  max-height: min(calc(var(--wiki-space-12) * 7), 44dvh);
  flex-direction: column;
  overflow: visible;
  min-width: 0;
  padding: var(--wiki-space-1);
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs);
  font-family: var(--wiki-font-body);
  transition:
    border-color var(--wiki-motion-normal) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease);
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
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  padding: var(--wiki-space-1) 0 0;
}

.agent-composer__input :deep(.v-field) {
  background: transparent;
  box-shadow: none;
}

.agent-composer__input :deep(.v-field__input) {
  min-height: calc(var(--wiki-space-12) * 2);
  padding: var(--wiki-space-3) var(--wiki-space-1) var(--wiki-space-2);
}

.agent-composer__input :deep(textarea) {
  box-sizing: border-box;
  min-height: calc(var(--wiki-space-12) * 2);
  max-height: min(calc(var(--wiki-space-12) * 3), 30dvh);
  overflow-y: hidden;
  overscroll-behavior: contain;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1rem;
  line-height: var(--wiki-leading-body);
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
  min-width: 0;
  min-height: 0;
  flex: 0 1 auto;
  max-height: min(calc(var(--wiki-space-12) * 2), 24dvh);
  align-items: flex-start;
  gap: var(--wiki-space-1);
  margin: 0 var(--wiki-space-1) var(--wiki-space-1);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--wiki-space-1);
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
  align-content: flex-start;
  gap: var(--wiki-space-1);
}

.agent-composer__actions {
  display: grid;
  min-width: 0;
  min-height: var(--wiki-control-height);
  flex: 0 0 auto;
  grid-template-columns: minmax(0, auto) minmax(var(--wiki-space-12), 1fr) auto;
  align-items: center;
  gap: var(--wiki-space-1);
  padding: var(--wiki-space-1) 0 0;
  border-top: 1px solid var(--wiki-surface-border);
}

.agent-composer__context-controls,
.agent-composer__primary-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-1);
}

.agent-composer__primary-actions {
  min-width: calc(var(--wiki-space-12) * 2);
  justify-content: stretch;
}

.agent-composer__primary-actions > .agent-composer__submit,
.agent-composer__primary-actions > .agent-composer__stop {
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
}

.agent-composer__actions :deep(.v-btn) {
  min-height: var(--wiki-control-height);
}

.agent-composer__skill-button {
  max-width: 100%;
}

.agent-composer__pin {
  min-width: var(--wiki-control-height);
  min-height: var(--wiki-control-height);
}

.agent-composer__pin--active {
  box-shadow: var(--wiki-shadow-inset);
}
.agent-composer__skill-load-state {
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

.agent-composer__skill-load-state--error {
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 32%, var(--wiki-surface-border));
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 8%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-error));
}

.agent-composer__skill-load-state > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.agent-composer__skill-load-state span {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: var(--wiki-label-size);
  overflow-wrap: anywhere;
}

.agent-composer__state {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  white-space: nowrap;
}

.agent-composer__state > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-composer__state-dot {
  width: var(--wiki-space-2);
  height: var(--wiki-space-2);
  flex: 0 0 auto;
  border: 1px solid currentColor;
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, currentColor 18%, transparent);
}

.agent-composer__state--ready {
  color: rgb(var(--v-theme-success));
}

.agent-composer__state--ready .agent-composer__state-dot,
.agent-composer__state--error .agent-composer__state-dot {
  background: currentColor;
}

.agent-composer__state--error {
  color: rgb(var(--v-theme-error));
}

.agent-composer__submit {
  min-width: calc(var(--wiki-space-12) * 2);
  box-shadow: var(--wiki-shadow-xs);
}

.agent-composer__stop {
  min-width: calc(var(--wiki-space-12) * 1.6);
}

.agent-composer__hint {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
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
.agent-composer__command-retry {
  justify-content: space-between;
  gap: var(--wiki-space-2);
  border-top: 1px solid var(--wiki-surface-border);
  color: rgb(var(--v-theme-error));
  font-size: var(--wiki-label-size);
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

@media (max-width: 740px) {
  .agent-composer {
    padding: var(--wiki-space-1);
    border-radius: var(--wiki-control-radius);
  }

  .agent-composer__context-controls {
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scrollbar-width: none;
  }

  .agent-composer__context-controls::-webkit-scrollbar {
    display: none;
  }

  .agent-composer__attachments {
    flex-direction: column;
    max-height: min(calc(var(--wiki-space-12) * 2), 24dvh);
  }

}

@media (max-width: 740px) and (max-height: 500px) {
  .agent-composer__attachments {
    flex-direction: row;
    align-items: center;
    max-height: calc(var(--wiki-control-height) + var(--wiki-space-3));
    overflow: hidden;
  }

  .agent-composer__skills {
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-inline: contain;
    scrollbar-width: none;
  }

  .agent-composer__skills::-webkit-scrollbar {
    display: none;
  }
}

@media (max-width: 430px) {

  .agent-composer__skill-button,
  .agent-composer__goal-button {
    min-width: var(--wiki-control-height);
    padding-inline: var(--wiki-space-2);
  }


  .agent-composer__skill-button :deep(.v-btn__prepend),
  .agent-composer__goal-button :deep(.v-btn__prepend) {
    margin: 0;
  }

  .agent-composer__primary-actions,
  .agent-composer__submit {
    min-width: calc(var(--wiki-space-12) * 1.5);
  }

  .agent-composer__submit {
    padding-inline: var(--wiki-space-3);
  }

  .agent-composer__submit :deep(.v-btn__prepend) {
    display: none;
  }
}

@media (max-height: 500px) {
  .agent-composer__input :deep(.v-field__input),
  .agent-composer__input :deep(textarea) {
    min-height: calc(var(--wiki-space-12) * 1.5);
    max-height: calc(var(--wiki-space-12) * 1.5);
  }
}

@media (forced-colors: active) {
  .agent-composer,
  .agent-composer__command-menu {
    border: 1px solid CanvasText;
  }

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
