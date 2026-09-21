<template>
  <v-form
    ref="composerRoot"
    class="agent-composer"
    :class="{
      'agent-composer--sending': sendInProgress || canStop,
      'agent-composer--disabled': disabled,
      'agent-composer--retry': sendFailed,
      'agent-composer--status-error': statusTone === 'error'
    }"
    @submit.prevent="submit"
    @paste="handleMediaPaste"
    @dragover="handleMediaDragOver"
    @drop="handleMediaDrop"
  >
    <v-card
      v-if="skillCommandOpen"
      :id="composerIds.commandMenu"
      class="agent-composer__command-menu"
      :aria-labelledby="composerIds.commandHeading"
      :aria-describedby="composerIds.commandDescription"
      elevation="5"
    >
      <v-card-title :id="composerIds.commandHeading" class="agent-composer__command-heading">
        <span>
          <v-icon icon="mdi-puzzle-outline" size="18" aria-hidden="true" />
          Invoke a skill
        </span>
        <span :id="composerIds.commandDescription" class="agent-composer__command-help">Type to filter · Esc to close</span>
      </v-card-title>
      <v-divider />
      <v-list
        :id="composerIds.commandResults"
        role="listbox"
        aria-multiselectable="true"
        aria-label="Matching skills"
        density="compact"
        max-height="320"
        class="overflow-y-auto"
      >
        <v-list-item
          v-for="skill in skillCommandResults"
          :id="commandOptionId(skill.versionId)"
          :key="skill.versionId"
          role="option"
          :active="activeCommandSkill?.versionId === skill.versionId"
          :aria-selected="isSelected(skill.versionId)"
          :aria-disabled="isCommandSkillDisabled(skill.versionId) || undefined"
          :disabled="isCommandSkillDisabled(skill.versionId)"
          :prepend-icon="isSelected(skill.versionId) ? 'mdi-check-circle' : 'mdi-puzzle-outline'"
          :title="skill.name"
          :subtitle="isPreferred(skill.versionId) ? 'Always loaded in conversations' : skill.description"
          @mouseenter="setActiveCommandSkill(skill.versionId)"
          @click="invokeCommandSkill(skill)"
        >
          <template #append>
            <div class="d-flex ga-1">
              <v-chip v-if="skill.exposureMode === 'owner'" size="x-small" variant="tonal">Mine</v-chip>
              <v-chip v-if="skill.exposureMode === 'owner' && !skill.isAgentDiscoverable" size="x-small" variant="outlined">Explicit only</v-chip>
            </div>
          </template>
        </v-list-item>
        <v-list-item v-if="skillCommandResults.length === 0 && skillsLoading" :id="composerIds.commandLoading" role="option" aria-disabled="true" title="Loading skill catalog" subtitle="Wait for the available skills to finish loading." disabled />
        <v-list-item v-else-if="skillCommandResults.length === 0 && skillsPartial" :id="composerIds.commandPartial" role="option" aria-disabled="true" :title="skillLoadTitle" :subtitle="skillLoadMessage" disabled />
        <v-list-item v-else-if="skillCommandResults.length === 0" :id="composerIds.commandEmpty" role="option" aria-disabled="true" title="No matching skills" subtitle="Try another name or description." disabled />
      </v-list>
      <div class="agent-composer__command-status sr-only" role="status" aria-live="polite">{{ skillCommandStatus }}</div>
      <v-card-actions v-if="skillsLoadError" class="agent-composer__command-retry">
        <span>{{ skills.length > 0 ? 'Showing the last-loaded catalog.' : 'No catalog entries are available.' }}</span>
        <v-btn prepend-icon="mdi-refresh" size="small" variant="text" :loading="skillsLoading" :disabled="skillsLoading || networkBlocked" @click="retrySkills">Retry catalog</v-btn>
      </v-card-actions>
    </v-card>
    <span
      :id="composerIds.status"
      class="agent-composer__live-status sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >{{ liveStatusLabel }}</span>

    <div class="agent-composer__context-row">
      <slot name="context-controls" />
      <v-chip
        v-if="goalsEnabled && goalMode"
        class="agent-composer__goal-chip"
        color="primary"
        size="small"
        variant="tonal"
        prepend-icon="mdi-target"
        closable
        close-label="Turn off goal mode"
        :disabled="disabled || sendInProgress"
        title="Goal mode is on. Your next message defines a durable outcome for Wiki Agent."
        @click:close="goalMode = false"
      >Goal</v-chip>
    </div>

    <div class="agent-composer__editor">
      <v-textarea
        ref="messageInput"
        v-model="draft"
        class="agent-composer__input"
        :aria-label="composerInputLabel"
        :aria-describedby="composerInputDescriptionIds"
        :aria-autocomplete="skillsEnabled ? 'list' : undefined"
        :aria-haspopup="skillsEnabled ? 'listbox' : undefined"
        :placeholder="composerInputPlaceholder"
        rows="1"
        variant="solo"
        flat
        hide-details
        :disabled="disabled || sendInProgress"
        :aria-controls="skillsEnabled && skillCommandOpen ? composerIds.commandResults : undefined"
        :aria-activedescendant="activeCommandOptionId"
        @select="handleSelectionChange"
        @keydown="handleKeydown"
      />
    </div>

    <p v-if="error" class="agent-composer__notice" role="alert">{{ error }}</p>

    <AgentComposerMedia
      ref="mediaComposer"
      :csrf-token="csrfToken ?? ''"
      :session="mediaSession ?? null"
      :capabilities="mediaCapabilities"
      :generation-tools-enabled="generationToolsEnabled"
      :disabled="disabled || sendInProgress || canStop || goalMode"
      :network-blocked="Boolean(networkBlocked)"
      @change="mediaSubmission = $event"
      @busy="mediaBusy = $event"
      @dictation="appendDictation"
      @settled="emit('mediaSettled')"
    >
      <template #attachments="{ attachments, uploading, locked, removeAttachment }">
        <ul v-if="attachments.length" class="agent-composer__media-attachments" aria-label="Attachments for the next message">
          <li v-for="item in attachments" :key="item.id">
            <img v-if="item.mimeType.startsWith('image/')" :src="agentMediaContentUrl(item.id)" alt="" />
            <v-icon v-else icon="mdi-file-pdf-box" size="24" aria-hidden="true" />
            <span :title="item.filename">{{ item.filename }}</span>
            <v-btn icon="mdi-close" size="x-small" variant="text" :aria-label="`Remove ${item.filename}`" :disabled="locked" @click="removeAttachment(item)" />
          </li>
        </ul>
        <span v-if="uploading" class="agent-composer__uploading" role="status">Uploading…</span>
      </template>
    </AgentComposerMedia>

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
      <div ref="controlsGroup" class="agent-composer__context-controls" role="group" aria-label="Message tools">
        <v-menu v-if="attachmentsAvailable" content-class="agent-owned-overlay" location="top start" v-model="attachmentMenuOpen">
          <template #activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              class="agent-composer__attach wiki-purpose-control"
              variant="text"
              rounded="pill"
              prepend-icon="mdi-paperclip"
              aria-label="Attach files"
              title="Attach files"
              :disabled="attachDisabled"
              :aria-expanded="attachmentMenuOpen"
            >Attach</v-btn>
          </template>
          <v-list density="compact" aria-label="Attachment source">
            <v-list-item prepend-icon="mdi-upload" title="Upload files" @click="openFilePicker" />
            <v-list-item prepend-icon="mdi-folder-outline" title="Browse Wiki assets" @click="openAssetBrowser" />
          </v-list>
        </v-menu>
        <v-menu v-if="createAvailable && !isControlFolded('create')" content-class="agent-owned-overlay" location="top start">
          <template #activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              class="agent-composer__create wiki-purpose-control"
              :variant="selectedGenerationTools.length ? 'tonal' : 'text'"
              :color="selectedGenerationTools.length ? 'primary' : undefined"
              :data-state="selectedGenerationTools.length ? 'selected' : undefined"
              rounded="pill"
              prepend-icon="mdi-creation-outline"
              append-icon="mdi-chevron-down"
              aria-label="Choose creation tools"
              :title="selectedGenerationTools.length ? `${selectedGenerationTools.length} creation tool${selectedGenerationTools.length === 1 ? '' : 's'} enabled for the assistant` : 'Choose creation tools'"
              :disabled="attachDisabled"
            >Create</v-btn>
          </template>
          <v-list density="compact" class="agent-composer__tool-menu" aria-label="Creation tools">
            <v-list-subheader>Available for the assistant to use</v-list-subheader>
            <v-list-item
              v-for="option in generationOptions"
              :key="option.value"
              :title="option.title"
              :prepend-icon="option.icon"
              role="menuitemcheckbox"
              :aria-checked="selectedGenerationTools.includes(option.value)"
              :active="selectedGenerationTools.includes(option.value)"
              :disabled="attachDisabled"
              @click="toggleGenerationTool(option.value)"
            >
              <template #append><v-icon :icon="selectedGenerationTools.includes(option.value) ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline'" size="20" aria-hidden="true" /></template>
            </v-list-item>
            <p class="agent-composer__tool-menu-note">Ask naturally. The assistant can combine your selected tools in one reply.</p>
          </v-list>
        </v-menu>
        <label
          v-if="!isControlFolded('web')"
          class="agent-composer__web-search-toggle wiki-purpose-control"
          :class="{ 'wiki-purpose-control--selected': googleSearchEnabled }"
          :data-state="googleSearchEnabled ? 'selected' : undefined"
          :title="googleSearchAvailable ? 'Use Google Search for future responses in this conversation. Search queries and relevant context may be sent to Google Search; charges are additional to model token charges.' : 'Google Search is unavailable for this provider'"
        >
          <input
            type="checkbox"
            :checked="googleSearchEnabled"
            :aria-checked="googleSearchEnabled ? 'true' : 'false'"
            :disabled="webSearchDisabled"
            aria-label="Use Google Search for this conversation"
            @change="toggleGoogleSearch"
          >
          <v-icon icon="mdi-web" size="17" aria-hidden="true" />
          <span>Web</span>
        </label>
        <v-btn
          v-if="goalsEnabled && !goalMode && !isControlFolded('goal')"
          class="agent-composer__goal-toggle wiki-purpose-control"
          :class="{ 'wiki-purpose-control--selected': goalMode }"
          :data-state="goalMode ? 'selected' : undefined"
          variant="text"
          rounded="pill"
          prepend-icon="mdi-target"
          aria-label="Goal"
          title="Define a durable outcome for multi-step tasks"
          :disabled="disabled || sendInProgress || mediaBusy || mediaSubmission.attachmentIds.length > 0"
          @click="goalMode = true"
        >Goal</v-btn>
        <v-menu
          v-if="hasMoreMenuContent"
          content-class="agent-owned-overlay agent-composer__more-menu-content"
          v-model="moreMenuOpen"
          location="top end"
        >
          <template #activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              class="agent-composer__more-button"
              icon="mdi-dots-horizontal"
              variant="text"
              size="small"
              rounded="pill"
              aria-label="More options"
              aria-haspopup="menu"
              :aria-expanded="moreMenuOpen"
              title="More options"
              :disabled="disabled || sendInProgress"
            />
          </template>
          <v-list density="compact" class="agent-composer__more-menu" aria-label="More composer options">
            <v-list-item
              v-for="item in moreMenuItems"
              :key="item.key"
              :prepend-icon="item.icon"
              :title="item.label"
              :subtitle="item.subtitle"
              :disabled="item.disabled"
              :aria-checked="item.checked"
              role="menuitemcheckbox"
              @click="item.run()"
            >
              <template #append><v-icon :icon="item.checked ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline'" size="20" aria-hidden="true" /></template>
            </v-list-item>
            <v-menu
              v-if="skillsEnabled"
              content-class="agent-owned-overlay agent-composer__skill-menu-content"
              v-model="foldedSkillMenuOpen"
              location="end top"
              :close-on-content-click="false"
            >
              <template #activator="{ props: submenuProps }">
                <v-list-item
                  v-bind="submenuProps"
                  prepend-icon="mdi-puzzle-outline"
                  title="Skills"
                  append-icon="mdi-chevron-right"
                  aria-haspopup="dialog"
                  :aria-expanded="foldedSkillMenuOpen"
                  :disabled="disabled || sendInProgress"
                />
              </template>
              <AgentComposerSkillMenu
                :items="skillMenuItems"
                :skills-count="skills.length"
                :skills-loading="skillsLoading"
                :skills-load-error="skillsLoadError"
                :skills-partial="skillsPartial"
                :disabled="disabled"
                :send-in-progress="sendInProgress"
                :network-blocked="networkBlocked"
                :invocation-limit="invocationLimit"
                :selected-skill-version-ids="selectedSkillIds"
                :preferred-version-ids="preferredMenuVersionIds"
                @toggle="toggleSkill"
                @toggle-preference="togglePreference"
                @manage-skills="manageSkills"
                @retry-skills="retrySkills"
              />
            </v-menu>
          </v-list>
        </v-menu>
      </div>

      <div class="agent-composer__primary-actions" role="group" aria-label="Message actions">
        <v-btn
          v-if="canStop"
          class="agent-composer__stop"
          color="warning"
          variant="outlined"
          prepend-icon="mdi-stop"
          :aria-describedby="composerIds.status"
          :disabled="networkBlocked"
          @click="emit('stop')"
        >Stop response</v-btn>
        <template v-else>
          <template v-if="dictationAvailable">
            <span
              v-if="mediaRecording || mediaTranscribing"
              class="agent-composer__dictation-status"
              role="status"
              aria-live="polite"
            >{{ mediaRecording ? `${mediaSeconds} / 60s` : 'Transcribing…' }}</span>
            <v-btn
              v-else
              class="agent-composer__mic"
              icon="mdi-microphone-outline"
              variant="text"
              size="small"
              rounded="pill"
              aria-label="Start dictation"
              title="Start dictation"
              :disabled="disabled || sendInProgress || networkBlocked || mediaBusy"
              @click="startDictation"
            />
          </template>
          <template v-if="mediaRecording">
            <v-btn
              class="agent-composer__mic agent-composer__mic--recording"
              icon="mdi-stop-circle-outline"
              variant="tonal"
              color="error"
              size="small"
              rounded="pill"
              aria-label="Stop dictation and insert text"
              title="Stop dictation and insert text"
              :aria-describedby="composerIds.status"
              @click="stopDictation"
            />
            <v-btn
              class="agent-composer__dictation-cancel"
              variant="text"
              size="small"
              rounded="pill"
              :disabled="disabled || sendInProgress"
              title="Cancel recording; keeps your typed message"
              @click="cancelDictation"
            >Cancel</v-btn>
          </template>
          <v-btn
            v-if="!canStop"
            class="agent-composer__submit"
            type="submit"
            color="primary"
            :prepend-icon="submitIcon"
            :loading="sendInProgress || mediaTranscribing"
            :disabled="submitDisabled"
            :aria-describedby="composerIds.status"
          >{{ submitLabel }}</v-btn>
        </template>
      </div>

    </div>

  </v-form>


</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import type { Ref } from 'vue'
import AgentComposerMedia from './agent-composer-media.vue'
import AgentComposerSkillMenu from './agent-composer-skill-menu.vue'
import type { AgentMediaSubmission } from '../../helpers/agent-media.ts'
import type { AgentMediaView, AgentProviderProfileView, AgentThreadState, AgentSessionSkillView } from '../../../shared/agents/contracts.ts'
import { agentMediaContentUrl, type VisibleAgentSkill } from '../../helpers/agents-api.ts'
import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'
import { caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret } from './agent-composer-sizing.ts'
const props = defineProps<{
  csrfToken?: string
  mediaSession?: AgentThreadState['session'] | null
  mediaCapabilities?: AgentProviderProfileView['media']
  generationToolsEnabled?: boolean
  disabled: boolean
  sending: boolean
  canStop: boolean
  skillsEnabled: boolean
  googleSearchAvailable: boolean
  googleSearchEnabled: boolean
  googleSearchBusy?: boolean
  goalsEnabled: boolean
  skills: readonly VisibleAgentSkill[]
  skillsLoading: boolean
  skillsLoadError: string
  skillsPartial: boolean
  preferredSkills: readonly AgentSessionSkillView[]
  invocationLimit: number
  statusLabel: string
  statusTone: 'ready' | 'error' | 'busy'
  sessionId?: string
  initialDraft?: string
  initialMode?: 'message' | 'goal'
  initialSkillVersionIds?: readonly string[]
  hasMessages?: boolean
  externalDescriptionId?: string
  networkBlocked?: boolean
}>()
const emit = defineEmits<{ draftChange: [sessionId: string, text: string]; compositionChange: [sessionId: string, patch: { mode: 'message' | 'goal'; skillVersionIds: string[] }]; send: [content: string, invokedSkillVersionIds: readonly string[], mode: 'message' | 'goal', completion?: (success: boolean) => void, media?: AgentMediaSubmission]; mediaSettled: []; stop: []; manageSkills: []; retrySkills: []; updateSkillPreferences: [skillIds: string[]]; updateGoogleSearch: [enabled: boolean] }>()
const mediaComposer = useTemplateRef<{
  clear: () => void
  addFiles: (files: readonly File[]) => Promise<unknown>
  editImage: (media: AgentMediaView) => Promise<boolean>
  reattachMedia: (media: AgentMediaView) => Promise<boolean>
  startRecording: () => Promise<void>
  stopRecording: () => void
  cancelDictation: () => void
  beginDictationSubmit: () => boolean
  waitForDictationTranscript: () => Promise<string | null>
  recording: Ref<boolean>
  transcribing: Ref<boolean>
  seconds: Ref<number>
  dictationIntent: Ref<'insert' | 'send'>
  dictationError: Ref<string>
  chooseUpload: () => void
  browseAssets: () => void
  toggleGenerationTool: (tool: 'image' | 'video' | 'music') => void
  generationOptions: Ref<ReadonlyArray<{ value: 'image' | 'video' | 'music'; title: string; icon: string }>>
  selectedGenerationTools: Ref<ReadonlyArray<'image' | 'video' | 'music'>>
}>('mediaComposer')
const mediaSubmission = ref<AgentMediaSubmission>({ attachmentIds: [] })
const mediaBusy = ref(false)
// Exposed refs unwrap on a component instance, so accept both the raw ref
// and its unwrapped value depending on how the media composer is mounted.
const mediaRecording = computed(() => {
  const recording = mediaComposer.value?.recording as boolean | Ref<boolean> | undefined
  return typeof recording === 'object' && recording !== null ? Boolean(recording.value) : Boolean(recording)
})
const mediaTranscribing = computed(() => {
  const transcribing = mediaComposer.value?.transcribing as boolean | Ref<boolean> | undefined
  return typeof transcribing === 'object' && transcribing !== null ? Boolean(transcribing.value) : Boolean(transcribing)
})
const mediaSeconds = computed(() => {
  const seconds = mediaComposer.value?.seconds as number | Ref<number> | undefined
  return typeof seconds === 'object' && seconds !== null ? seconds.value : (seconds ?? 0)
})
const dictationAvailable = computed(() => Boolean(props.mediaCapabilities?.transcription))
const attachmentsAvailable = computed(() => Boolean(props.mediaCapabilities?.attachments))
const attachmentCount = computed(() => {
  const count = (mediaComposer.value as unknown as { attachments?: unknown } | null)?.attachments
  return Array.isArray(count) ? count.length : 0
})
const attachDisabled = computed(() =>
  props.disabled || sendInProgress.value || props.networkBlocked === true ||
  mediaBusy.value || !props.mediaSession || attachmentCount.value >= 4
)
interface ComposerGenerationOption { value: 'image' | 'video' | 'music'; title: string; icon: string }
const generationOptions = computed<ReadonlyArray<ComposerGenerationOption>>(() => {
  const options = mediaComposer.value?.generationOptions as unknown
  return Array.isArray(options) ? (options as ReadonlyArray<ComposerGenerationOption>) : []
})
const selectedGenerationTools = computed<ReadonlyArray<'image' | 'video' | 'music'>>(() => {
  const tools = mediaComposer.value?.selectedGenerationTools as unknown
  return Array.isArray(tools) ? (tools as ReadonlyArray<'image' | 'video' | 'music'>) : []
})
const createAvailable = computed(() =>
  props.generationToolsEnabled !== false && generationOptions.value.length > 0
)
const openFilePicker = (): void => {
  attachmentMenuOpen.value = false
  if (!attachDisabled.value) mediaComposer.value?.chooseUpload()
}
const openAssetBrowser = (): void => {
  attachmentMenuOpen.value = false
  if (!attachDisabled.value) mediaComposer.value?.browseAssets()
}
const toggleGenerationTool = (tool: 'image' | 'video' | 'music'): void => {
  if (attachDisabled.value) return
  mediaComposer.value?.toggleGenerationTool(tool)
}
/**
 * Saved caret anchor for dictated text. Tracked from the textarea's own
 * selection while the user types or moves the caret; insertion restores the
 * anchor when it is still valid and otherwise appends, so typing is never
 * overwritten.
 */
const savedCaret = ref<number | null>(null)
const rememberCaret = (): void => {
  const textarea = getTextarea()
  if (!textarea) return
  savedCaret.value = textarea.selectionStart ?? textarea.value.length
}
const insertionAnchor = (): number => {
  // The anchor is saved from the textarea's selection while the user types or
  // moves the caret; when it is no longer valid for the current draft the
  // dictated text appends instead, so typed text is never overwritten.
  const anchor = savedCaret.value
  const length = draft.value.length
  if (anchor === null || !Number.isInteger(anchor) || anchor < 0 || anchor > length) return length
  return anchor
}
const appendDictation = (text: string) => {
  const anchor = insertionAnchor()
  const before = draft.value.slice(0, anchor)
  const after = draft.value.slice(anchor)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  draft.value = `${before}${prefix}${text}${suffix}${after}`
  savedCaret.value = anchor + prefix.length + text.length
  void nextTick(() => {
    const textarea = getTextarea()
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.setSelectionRange(savedCaret.value ?? textarea.value.length, savedCaret.value ?? textarea.value.length)
      void focusInput()
    }
  })
}
const handleMediaPaste = (event: ClipboardEvent) => {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (!(props.mediaCapabilities?.attachments) || !files.length) return
  event.preventDefault()
  void mediaComposer.value?.addFiles(files)
}
const handleMediaDragOver = (event: DragEvent) => {
  if ((props.mediaCapabilities?.attachments) && event.dataTransfer?.types.includes('Files')) event.preventDefault()
}
const handleMediaDrop = (event: DragEvent) => {
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (!files.length) return
  event.preventDefault()
  if (props.mediaCapabilities?.attachments) void mediaComposer.value?.addFiles(files)
}
const draft = ref(props.initialDraft ?? '')
watch(draft, text => {
  if (props.sessionId) emit('draftChange', props.sessionId, text)
}, { flush: 'sync' })
// A send may settle while a replacement composer is already mounted.
watch(() => props.initialDraft, (value, previous) => {
  if (draft.value === (previous ?? '')) draft.value = value ?? ''
})
const goalMode = ref(props.initialMode === 'goal')
const skillMenuOpen = ref(false)
const foldedSkillMenuOpen = ref(false)
const moreMenuOpen = ref(false)
const attachmentMenuOpen = ref(false)
const selectedSkillIds = ref<string[]>([...(props.initialSkillVersionIds ?? [])])
let syncingComposition = false
watch([goalMode, selectedSkillIds], () => {
  if (props.sessionId && !syncingComposition) emit('compositionChange', props.sessionId, { mode: goalMode.value ? 'goal' : 'message', skillVersionIds: [...selectedSkillIds.value] })
}, { deep: true, flush: 'sync' })
watch(() => [props.initialMode, props.initialSkillVersionIds] as const, ([mode, skills]) => {
  syncingComposition = true
  goalMode.value = mode === 'goal'
  if (JSON.stringify(skills ?? []) !== JSON.stringify(selectedSkillIds.value)) selectedSkillIds.value = [...(skills ?? [])]
  syncingComposition = false
})
const composerRoot = useTemplateRef<{ $el?: HTMLElement } | HTMLElement>('composerRoot')
const controlsGroup = useTemplateRef<HTMLElement | null>('controlsGroup')
const messageInput = useTemplateRef<{ focus: () => void; $el?: HTMLElement }>('messageInput')
const dismissedCommandToken = ref<{ start: number; prefix: string } | null>(null)
const activeCommandIndex = ref(0)
const sendFailed = ref(false)
const submissionPending = ref(false)
const error = ref('')
const sendInProgress = computed(() => props.sending || submissionPending.value)
const webSearchDisabled = computed(() =>
  props.disabled || sendInProgress.value || props.googleSearchBusy || (!props.googleSearchAvailable && !props.googleSearchEnabled)
)
const toggleGoogleSearch = (event: Event): void => {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  const enabled = input.checked
  input.checked = props.googleSearchEnabled
  if (webSearchDisabled.value) return
  emit('updateGoogleSearch', enabled)
}
let restoreInputWhenReady = false
let mounted = false
const composerId = useId()
const composerIds = {
  commandMenu: `${composerId}-command-menu`,
  commandHeading: `${composerId}-command-heading`,
  commandDescription: `${composerId}-command-description`,
  commandResults: `${composerId}-command-results`,
  commandLoading: `${composerId}-command-loading`,
  commandPartial: `${composerId}-command-partial`,
  commandEmpty: `${composerId}-command-empty`,
  skillsDialog: `${composerId}-skills-dialog`,
  skillsHeading: `${composerId}-skills-heading`,
  skillsDescription: `${composerId}-skills-description`,
  status: `${composerId}-status`
} as const
const commandOptionId = (versionId: string): string => `${composerIds.commandResults}-${versionId}`
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
const preferredMenuVersionIds = computed(() => skillMenuItems.value.filter(item => isPreferred(item.versionId)).map(item => item.versionId))
const isPreferred = (versionId: string): boolean => {
  const skillId = skillIdForVersion(versionId)
  return skillId !== undefined && preferredSkillIds.value.has(skillId)
}
/**
 * Lower-priority composer controls move into the More menu. On desktop the
 * Skills menu stays a direct control; goals, when enabled, move here while
 * unset. Items present in the context row are excluded automatically.
 */
const moreMenuItems = computed(() => {
  const items: Array<{ key: string; icon: string; label: string; subtitle?: string; checked?: boolean; disabled?: boolean; run: () => void }> = []
  if (props.goalsEnabled && !goalMode.value && isControlFolded('goal')) {
    items.push({
      key: 'goal',
      icon: 'mdi-target',
      label: 'Goal',
      subtitle: 'Define a durable outcome for multi-step tasks',
      checked: false,
      run: () => {
        if (props.disabled || sendInProgress.value || mediaBusy.value || mediaSubmission.value.attachmentIds.length > 0) return
        goalMode.value = true
      }
    })
  }
  if (isControlFolded('web')) {
    items.push({
      key: 'web',
      icon: 'mdi-web',
      label: 'Web',
      subtitle: props.googleSearchAvailable ? 'Use Google Search for this conversation' : 'Google Search is unavailable for this provider',
      checked: props.googleSearchEnabled === true,
      disabled: webSearchDisabled.value,
      run: () => {
        if (webSearchDisabled.value) return
        emit('updateGoogleSearch', !props.googleSearchEnabled)
      }
    })
  }
  if (isControlFolded('create') && createAvailable.value) {
    for (const option of generationOptions.value) {
      items.push({
        key: `create-${option.value}`,
        icon: option.icon,
        label: option.title,
        checked: selectedGenerationTools.value.includes(option.value),
        disabled: attachDisabled.value,
        run: () => toggleGenerationTool(option.value)
      })
    }
  }
  return items
})

/**
 * Fit-based folding of low-priority controls into the More menu. There is no
 * device detection: the left control group is measured, and whenever it
 * overflows its one row the lowest-priority inline control (Create, then Web)
 * moves into the More menu; when space returns the last folded control is
 * restored. Skills always live inside the More menu, and Goal replaces their
 * former inline slot. Attach, the microphone, and Send/Stop never fold, and
 * the action bar never wraps. The fold state is UI-only.
 */
type FoldableControl = 'create' | 'web' | 'goal'
const FOLDABLE_CONTROLS: readonly FoldableControl[] = ['create', 'web', 'goal']
const foldedControls = ref<FoldableControl[]>([])
const foldMeasureOverride = ref<(() => boolean) | null>(null)
let foldResizeObserver: ResizeObserver | null = null
const isControlFolded = (control: FoldableControl): boolean => foldedControls.value.includes(control)
const hasMoreMenuContent = computed(() =>
  moreMenuItems.value.length > 0 || props.skillsEnabled
)
const measureControlsOverflow = (): boolean => {
  const override = foldMeasureOverride.value
  if (override) return override()
  const group = controlsGroup.value
  if (!group) return false
  return group.scrollWidth > group.clientWidth
}
const updateFoldState = async (): Promise<void> => {
  if (measureControlsOverflow()) {
    const control = FOLDABLE_CONTROLS.find(candidate => !foldedControls.value.includes(candidate))
    if (control === undefined) return
    foldedControls.value = [...foldedControls.value, control]
    await nextTick()
    await updateFoldState()
    return
  }
  if (foldedControls.value.length === 0) return
  const last = foldedControls.value[foldedControls.value.length - 1]
  foldedControls.value = foldedControls.value.slice(0, -1)
  await nextTick()
  if (measureControlsOverflow()) {
    // Restoring did not fit after all; keep it folded and stop to avoid oscillation.
    foldedControls.value = [...foldedControls.value, last]
    await nextTick()
    return
  }
  await updateFoldState()
}
const handleFoldResize = (): void => {
  void updateFoldState()
}

const composerInputLabel = computed(() =>
  goalMode.value
    ? 'Define an outcome for Wiki Agent'
    : props.hasMessages
      ? 'Follow up with Wiki Agent'
      : 'Message Wiki Agent'
)
const composerInputDescriptionIds = computed(() => [
  props.externalDescriptionId?.trim(),
  composerIds.status
].filter(Boolean).join(' '))
const composerInputPlaceholder = computed(() => {
  if (goalMode.value) return 'Describe a bounded outcome for Wiki Agent'
  if (props.skillsEnabled) {
    return props.hasMessages
      ? 'Ask a follow-up · Type / for skills'
      : 'Ask a question · Type / for skills'
  }
  return props.hasMessages ? 'Ask a follow-up' : 'Ask a question or search query'
})
const liveStatusLabel = computed(() => {
  if (sendFailed.value) return 'Message failed to send. Retry is available.'
  const label = props.statusLabel.trim()
  if (sendInProgress.value || props.canStop) {
    if (label && label !== 'Ready') return label
    return props.canStop ? 'Working' : 'Sending'
  }
  return label || 'Ready'
})
const submitLabel = computed(() => {
  if (sendFailed.value) return 'Retry'
  return goalMode.value ? 'Start goal' : 'Send'
})
const submitIcon = computed(() => {
  if (sendFailed.value) return 'mdi-refresh'
  if (props.statusTone === 'error') return 'mdi-alert-circle-outline'
  if (props.statusTone === 'busy') return 'mdi-progress-clock'
  return goalMode.value ? 'mdi-target-arrow' : 'mdi-send'
})
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
  rememberCaret()
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
  if (props.disabled || props.networkBlocked || sendInProgress.value) return
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
const skillCommandStatus = computed(() => skillCommandResults.value.length
  ? `${skillCommandResults.value.length} matching skills`
  : props.skillsLoading
    ? 'Loading skill catalog'
    : props.skillsPartial
      ? props.skills.length > 0 ? 'Skill catalog incomplete' : 'Skill catalog unavailable'
      : 'No matching skills')
const isCommandSkillDisabled = (versionId: string): boolean =>
  props.disabled || sendInProgress.value || isPreferred(versionId) || (!isSelected(versionId) && selectedSkillIds.value.length >= props.invocationLimit)
const usableSkillCommandResults = computed(() => skillCommandResults.value.filter(skill => !isCommandSkillDisabled(skill.versionId)))
const activeCommandSkill = computed(() => usableSkillCommandResults.value[activeCommandIndex.value] ?? null)
const activeCommandOptionId = computed(() => {
  const skill = activeCommandSkill.value
  return skill ? commandOptionId(skill.versionId) : undefined
})
const setActiveCommandSkill = (versionId: string): void => {
  const index = usableSkillCommandResults.value.findIndex(skill => skill.versionId === versionId)
  if (index >= 0) activeCommandIndex.value = index
}
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
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && usableSkillCommandResults.value.length > 0) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const resultCount = usableSkillCommandResults.value.length
      activeCommandIndex.value = (activeCommandIndex.value + direction + resultCount) % resultCount
      return
    }
    const active = activeCommandSkill.value
    const acceptsWithTab = event.key === 'Tab' && !event.shiftKey && active !== null
    const acceptsWithEnter = event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && active !== null
    if (acceptsWithTab || acceptsWithEnter) {
      event.preventDefault()
      invokeCommandSkill(active)
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
  [visibleSkillByVersionId, preferredSkillIds, () => props.invocationLimit, () => props.skillsPartial],
  () => {
    if (props.skillsPartial || props.skillsLoading) return
    selectedSkillIds.value = selectedSkillIds.value
      .filter(id => visibleSkillByVersionId.value.has(id) && !isPreferred(id))
      .slice(0, props.invocationLimit)
  }
)
watch(draft, value => {
  if (error.value) error.value = ''
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
watch(usableSkillCommandResults, results => {
  activeCommandIndex.value = results.length > 0
    ? Math.min(activeCommandIndex.value, results.length - 1)
    : 0
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
  foldedSkillMenuOpen.value = false
  emit('manageSkills')
}
const retrySkills = (): void => {
  if (props.skillsLoading || props.networkBlocked) return
  emit('retrySkills')
}
const focusSkillsTrigger = async (): Promise<void> => {
  // The inline Skills control no longer exists (Skills live in the More menu),
  // so focus returns to the editor after the skill manager closes.
  await focusInput()
}
const resetInput = (): void => {
  resizeInput()
  const textarea = getTextarea()
  if (textarea) textarea.scrollTop = 0
}
// Send stays enabled during an active recording: submitting while recording
// is the stop-and-send flow. It is disabled only while a prior submit is in
// flight or dictation output is still processing, which prevents duplicates.
const submitDisabled = computed(() =>
  props.disabled ||
  sendInProgress.value ||
  props.networkBlocked === true ||
  // Media busy covers uploads and dictation processing, but an active
  // recording must keep Send available: submitting while recording is the
  // stop-and-send flow.
  (mediaBusy.value && !mediaRecording.value) ||
  mediaTranscribing.value ||
  (!draft.value.trim() && !mediaSubmission.value.attachmentIds.length && !mediaRecording.value)
)
/**
 * One-shot send during recording: stop capture, await the transcript, and
 * submit the combined transcript and typed draft exactly once. On failure the
 * typed draft is preserved and nothing is submitted.
 */
const submitDuringRecording = async (): Promise<void> => {
  const media = mediaComposer.value
  if (!media?.beginDictationSubmit()) return
  const typedDraft = draft.value
  submissionPending.value = true
  try {
    media.stopRecording()
    const transcript = await media.waitForDictationTranscript()
    if (transcript === null) {
      // No speech, failure, or cancellation: keep the typed draft for review
      // and surface the media composer's dictation message in the notice.
      draft.value = typedDraft
      const mediaMessage = mediaComposer.value?.dictationError as string | undefined
      if (!error.value) error.value = mediaMessage || 'No speech was found. Try recording again.'
      return
    }
    const content = [typedDraft.trim(), transcript].filter(Boolean).join(' ')
    const invokedSkillVersionIds = [...selectedSkillIds.value]
    const mode = goalMode.value ? 'goal' : 'message'
    const success = await new Promise<boolean>(resolve => {
      emit('send', content, invokedSkillVersionIds, mode, (success: boolean) => resolve(success), { attachmentIds: [...mediaSubmission.value.attachmentIds], generationTools: mediaSubmission.value.generationTools })
    })
    if (success) {
      // Mirror the plain-send success path: the submitted draft is gone.
      // The draft holds only the typed part, so compare against that.
      if (draft.value === typedDraft || draft.value === content) {
        draft.value = ''
        void nextTick(resetInput)
      }
      mediaComposer.value?.clear()
      selectedSkillIds.value = []
      goalMode.value = false
    } else {
      sendFailed.value = true
    }
  } finally {
    submissionPending.value = false
  }
}
const startDictation = (): void => {
  if (props.disabled || sendInProgress.value || mediaBusy.value) return
  void mediaComposer.value?.startRecording()
}
const stopDictation = (): void => {
  mediaComposer.value?.stopRecording()
}
const cancelDictation = (): void => {
  mediaComposer.value?.cancelDictation()
}
const submit = (): void => {
  if (mediaRecording.value) {
    void submitDuringRecording()
    return
  }
  if (props.disabled || props.networkBlocked || sendInProgress.value || mediaBusy.value || (!draft.value.trim() && !mediaSubmission.value.attachmentIds.length)) return
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
      mediaComposer.value?.clear()
      selectedSkillIds.value = []
      goalMode.value = false
    } else {
      restoreInputWhenReady = false
      void nextTick(() => {
        messageInput.value?.focus()
        resizeInput()
      })
    }
  }, { attachmentIds: [...mediaSubmission.value.attachmentIds], generationTools: mediaSubmission.value.generationTools })
}
const setDraft = async (value: string): Promise<void> => {
  draft.value = value
  await focusInput()
}
const editImage = async (media: AgentMediaView) => {
  if (await mediaComposer.value?.editImage(media)) {
    if (!draft.value.trim()) draft.value = 'Edit this image: '
    await focusInput()
  }
}
const reattachMedia = async (media: AgentMediaView): Promise<boolean> => (await mediaComposer.value?.reattachMedia(media)) === true
defineExpose({ focusInput, focusSkillsTrigger, setDraft, editImage, reattachMedia })
onMounted(() => {
  mounted = true
  mountCaretMirror()
  resizeInput()
  window.addEventListener('resize', resizeInput)
  if (typeof ResizeObserver !== 'undefined') {
    foldResizeObserver = new ResizeObserver(handleFoldResize)
    const group = controlsGroup.value
    if (group) foldResizeObserver.observe(group)
    const root = composerRoot.value instanceof HTMLElement ? composerRoot.value : composerRoot.value?.$el
    if (root instanceof HTMLElement) foldResizeObserver.observe(root)
    void nextTick(handleFoldResize)
  }
})
onBeforeUnmount(() => {
  mounted = false
  window.removeEventListener('resize', resizeInput)
  foldResizeObserver?.disconnect()
  foldResizeObserver = null
  unmountCaretMirror()
})
</script>

<style scoped>
.agent-composer {
  --agent-composer-control-face-height: clamp(28px, calc(var(--wiki-control-height) * .7), 31px);
  --agent-composer-control-hit-height: max(44px, var(--wiki-control-height));
  --agent-composer-control-hit-inset: calc((var(--agent-composer-control-hit-height) - var(--agent-composer-control-face-height)) / -2);
  --agent-composer-control-gap: clamp(5px, calc(var(--wiki-space-2) * .8), 8px);
  --agent-composer-control-padding-inline: calc(var(--wiki-space-3) * .9);
  --agent-composer-control-font-size: var(--v-btn-size, .875rem);
  --agent-composer-control-min-width: calc(var(--agent-composer-control-face-height) + var(--wiki-space-1));
  --agent-composer-padding: calc(var(--wiki-space-2) * .8);
  position: relative;
  display: flex;
  max-height: min(calc(var(--wiki-space-12) * 7), 44dvh);
  flex-direction: column;
  overflow: visible;
  min-width: 0;
  padding: var(--agent-composer-padding);
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
  font-family: var(--wiki-font-body);
  transition:
    border-color var(--wiki-motion-normal) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease);
}

.agent-composer:has(textarea:focus-visible) {
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: 2px;
}
.agent-composer__input :deep(.v-field:has(:focus-visible)) {
  outline: none;
  box-shadow: none;
}

.agent-composer--sending {
  border-color: color-mix(in srgb, var(--wiki-accent-warm) 42%, var(--wiki-surface-border));
}

.agent-composer--retry,
.agent-composer--status-error {
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 48%, var(--wiki-surface-border));
}

.agent-composer--disabled:not(.agent-composer--sending) {
  opacity: 1;
  background: var(--wiki-surface-sunken);
  box-shadow: var(--wiki-shadow-inset);
}

.agent-composer--disabled:not(.agent-composer--sending) .agent-composer__submit.v-btn--disabled:not(.v-btn--loading),
.agent-composer--disabled:not(.agent-composer--sending) .agent-composer__submit:disabled:not(.v-btn--loading) {
  color: rgb(var(--v-theme-on-primary-disabled-sunken)) !important;
}

.agent-composer__editor {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  padding: calc(var(--wiki-space-1) * .5) 0 0;
}

.agent-composer__input :deep(.v-field) {
  background: transparent;
  box-shadow: none;
}

.agent-composer__input :deep(.v-field__input) {
  /* One text line + the field padding: the editor starts as a single line. */
  min-height: calc(var(--wiki-leading-body) * 1rem + var(--wiki-space-1) * 1.9);
  padding: calc(var(--wiki-space-1) * .9) var(--wiki-space-1);
}

.agent-composer__input :deep(textarea) {
  /* This label-free editor needs no floating-label fade over its first line. */
  -webkit-mask-image: none;
  mask-image: none;
  box-sizing: border-box;
  min-height: calc(var(--wiki-leading-body) * 1rem);
  max-height: min(calc(var(--wiki-leading-body) * 6rem), 30dvh);
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
  min-height: var(--agent-composer-control-face-height);
  flex: 0 0 auto;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--agent-composer-control-gap);
  padding: var(--agent-composer-control-gap) 0 0;
  margin-top: var(--agent-composer-control-gap);
  /* Subtle separation above the action toolbar instead of a hard divider. */
  border-top: 1px solid color-mix(in srgb, var(--wiki-surface-border) 55%, transparent);
}

.agent-composer__context-row {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--agent-composer-control-gap);
  margin: 0 0 var(--agent-composer-control-gap);
}

/* Collapses entirely when the context slot renders nothing and no goal chip is set. */
.agent-composer__context-row:empty {
  display: none;
}

.agent-composer__context-controls,
.agent-composer__primary-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--agent-composer-control-gap);
}

/* One action row at any width: overflow is handled by folding controls into
   the More menu, never by wrapping. */
.agent-composer__context-controls {
  flex-wrap: nowrap;
  overflow: visible;
}

.agent-composer__context-controls > * {
  flex: 0 0 auto;
}


.agent-composer__primary-actions {
  min-width: calc(var(--wiki-space-12) * 1.9);
  justify-content: stretch;
}

.agent-composer__primary-actions > .agent-composer__submit,
.agent-composer__primary-actions > .agent-composer__stop {
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
}

/* Uniform action faces: every composer control shares one height, font, and
   pill shape, and retains a 44px effective pointer target through an invisible
   before-pseudo-element. */
.agent-composer__attach,
.agent-composer__create,
.agent-composer__goal-toggle,
.agent-composer__web-search-toggle,
.agent-composer__mic,
.agent-composer__more-button,
.agent-composer__submit,
.agent-composer__stop {
  position: relative;
  box-sizing: border-box;
  min-width: var(--agent-composer-control-min-width);
  height: var(--agent-composer-control-face-height);
  min-height: var(--agent-composer-control-face-height);
  border-radius: var(--wiki-radius-pill);
  font-family: inherit;
  font-size: var(--agent-composer-control-font-size);
  font-weight: 500;
  text-transform: none;
  letter-spacing: .01em;
}

.agent-composer__attach::before,
.agent-composer__create::before,
.agent-composer__goal-toggle::before,
.agent-composer__web-search-toggle::before,
.agent-composer__mic::before,
.agent-composer__more-button::before,
.agent-composer__submit::before,
.agent-composer__stop::before {
  position: absolute;
  inset-block: var(--agent-composer-control-hit-inset);
  inset-inline-start: 50%;
  width: 100%;
  min-width: var(--agent-composer-control-hit-height);
  min-height: var(--agent-composer-control-hit-height);
  border-radius: inherit;
  content: '';
  pointer-events: auto;
  transform: translateX(-50%);
}

.agent-composer__attach,
.agent-composer__create,
.agent-composer__goal-toggle {
  max-width: 100%;
  padding-inline: var(--agent-composer-control-padding-inline);
}
.agent-composer__web-search {
  display: inline-flex;
  align-items: center;
  gap: 0;
}

.agent-composer__web-search-toggle {
  position: relative;
  display: inline-flex;
  min-height: var(--agent-composer-control-face-height);
  align-items: center;
  gap: var(--wiki-space-2);
  padding-inline: var(--agent-composer-control-padding-inline);
  border-radius: var(--wiki-radius-pill);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 76%, transparent);
  cursor: pointer;
  font-size: var(--agent-composer-control-font-size);
  font-weight: 500;
  user-select: none;
}

.agent-composer__web-search-toggle:has(input:checked) {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 13%, transparent);
  color: rgb(var(--v-theme-primary));
}

.agent-composer__web-search-toggle:has(input:focus-visible) {
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: 2px;
}

.agent-composer__web-search-toggle:has(input:disabled) {
  cursor: default;
  opacity: .45;
}

.agent-composer__web-search-toggle input {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  opacity: 0;
  pointer-events: none;
}

.agent-composer__notice {
  margin: 0 var(--wiki-space-1) var(--wiki-space-1);
  color: rgb(var(--v-theme-error));
  font-size: var(--wiki-label-size);
}

.agent-composer__goal-chip {
  max-width: 100%;
}

.agent-composer__tool-menu {
  min-width: 264px;
  max-width: min(320px, calc(100vw - 24px));
}

.agent-composer__tool-menu-note {
  margin: 8px 16px 6px;
  max-width: 250px;
  font-size: .75rem;
  line-height: 1.5;
  opacity: .7;
}

.agent-composer__more-menu {
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-success)) 24%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
}

.agent-composer__dictation-status {
  min-width: calc(var(--wiki-space-12) * 1.15);
  color: rgb(var(--v-theme-error));
  font-size: var(--wiki-label-size);
  font-variant-numeric: tabular-nums;
  text-align: center;
  white-space: nowrap;
}

.agent-composer__mic--recording {
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 55%, transparent);
}

.agent-composer__dictation-cancel {
  height: var(--agent-composer-control-face-height);
  min-height: var(--agent-composer-control-face-height);
  border-radius: var(--wiki-radius-pill);
  font-size: var(--agent-composer-control-font-size);
}

.agent-composer__actions :deep(.v-icon) {
  font-size: 18px;
}

.agent-composer__actions :deep(.v-btn__prepend),
.agent-composer__actions :deep(.v-btn__append) {
  margin-inline: calc(var(--wiki-space-1) * -.9) calc(var(--wiki-space-2) * .9);
}



.agent-composer__submit {
  min-width: calc(var(--wiki-space-12) * 1.9);
  box-shadow: var(--wiki-shadow-xs);
  transition: transform var(--wiki-motion-fast) var(--wiki-motion-ease), box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.agent-composer__submit.v-btn--disabled:not(.v-btn--loading),
.agent-composer__submit:disabled:not(.v-btn--loading) {
  opacity: 1;
  background-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 80%, transparent) !important;
  color: rgb(var(--v-theme-on-primary-disabled-raised)) !important;
}

.agent-composer__submit.v-btn--disabled:not(.v-btn--loading) :deep(.v-btn__content),
.agent-composer__submit.v-btn--disabled:not(.v-btn--loading) :deep(.v-btn__prepend),
.agent-composer__submit.v-btn--disabled:not(.v-btn--loading) :deep(.v-icon),
.agent-composer__submit:disabled:not(.v-btn--loading) :deep(.v-btn__content),
.agent-composer__submit:disabled:not(.v-btn--loading) :deep(.v-btn__prepend),
.agent-composer__submit:disabled:not(.v-btn--loading) :deep(.v-icon) {
  opacity: 1;
}

.agent-composer__submit.v-btn--loading :deep(.v-btn__content),
.agent-composer__submit.v-btn--loading :deep(.v-btn__prepend) {
  opacity: 0;
}

.agent-composer__submit.v-btn--disabled :deep(.v-btn__overlay),
.agent-composer__submit:disabled :deep(.v-btn__overlay) {
  opacity: 0;
}

.agent-composer__submit:hover:not(:disabled) {
  box-shadow: var(--wiki-shadow-sm);
  transform: translateY(-1px);
}

.agent-composer__submit:active:not(:disabled) {
  transform: translateY(0);
}

.agent-composer__stop {
  min-width: calc(var(--wiki-space-12) * 1.52);
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

:global(.agent-composer__skill-menu-content) {
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-success)) 24%, var(--wiki-surface-border)) !important;
  border-radius: var(--wiki-panel-radius);
  box-shadow: 0 0 0 1px color-mix(in srgb, rgb(var(--v-theme-success)) 8%, transparent);
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

.agent-composer__live-status,
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
    padding: var(--agent-composer-padding);
    border-radius: var(--wiki-control-radius);
  }

  .agent-composer__actions {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "context primary";
    column-gap: var(--agent-composer-control-gap);
    row-gap: 0;
  }

  .agent-composer__context-controls {
    grid-area: context;
    overflow: visible;
    padding-block: var(--agent-composer-control-gap);
    margin-block: calc(var(--agent-composer-control-gap) * -1);
  }

  .agent-composer__primary-actions {
    grid-area: primary;
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

@media (max-width: 599.98px) {
  .agent-composer {
    /* Touch layout: control faces grow to meet the 44px touch target so the
       desktop's compact faces never carry over unchanged. */
    --agent-composer-control-face-height: max(44px, var(--wiki-control-height));
    --agent-composer-control-hit-inset: 0px;
  }

  .agent-composer__attach,
  .agent-composer__create,
  .agent-composer__goal-toggle {
    padding-inline: calc(var(--wiki-space-2) * .9);
  }

  .agent-composer__attach :deep(.v-btn__prepend),
  .agent-composer__create :deep(.v-btn__prepend) {
    margin: 0;
  }
}

@media (max-width: 430px) {
  .agent-composer__primary-actions,
  .agent-composer__submit {
    min-width: calc(var(--wiki-space-12) * 1.425);
  }

  .agent-composer__submit {
    padding-inline: calc(var(--wiki-space-3) * .9);
  }

  .agent-composer__submit :deep(.v-btn__prepend) {
    display: none;
  }
}

@media (max-height: 500px) {
  .agent-composer__input :deep(.v-field__input),
  .agent-composer__input :deep(textarea) {
    min-height: calc(var(--wiki-space-12) * 1.25);
    max-height: calc(var(--wiki-space-12) * 1.25);
  }
}
@media (forced-colors: active) {
  .agent-composer,
  .agent-composer__command-menu {
    border: 1px solid CanvasText;
  }

}
@media (prefers-reduced-motion: reduce) {
  .agent-composer {
    transition: none;
    animation: none;
  }
}
</style>
