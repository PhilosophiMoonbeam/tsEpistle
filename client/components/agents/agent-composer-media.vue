<template>
  <div v-if="capabilities?.attachments || generationOptions.length || capabilities?.transcription" class="agent-media-composer">
    <div ref="mediaControls" class="agent-media-composer__controls" role="group" aria-label="Message media">
      <input ref="fileInput" class="agent-media-composer__file" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" multiple aria-label="Choose images or PDFs" @change="chooseFiles" />
      <v-menu v-if="capabilities?.attachments" v-model="attachmentMenu" content-class="agent-owned-overlay" location="top start">
        <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" class="agent-media-composer__attach" variant="text" size="small" prepend-icon="mdi-paperclip" :disabled="locked || !session || attachments.length >= 4" aria-label="Attach images or PDFs">Attach</v-btn></template>
        <v-list density="compact" aria-label="Attachment source"><v-list-item prepend-icon="mdi-upload" title="Upload files" @click="chooseUpload" /><v-list-item prepend-icon="mdi-folder-outline" title="Browse Wiki assets" @click="browseAssets" /></v-list>
      </v-menu>
      <v-menu v-if="generationOptions.length && generationToolsEnabled !== false" v-model="generationMenu" :close-on-content-click="false" content-class="agent-owned-overlay" location="top start">
        <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" :variant="selectedGenerationTools.length ? 'tonal' : 'text'" :color="selectedGenerationTools.length ? 'primary' : undefined" size="small" prepend-icon="mdi-creation-outline" append-icon="mdi-chevron-down" aria-label="Choose creation tools" :disabled="locked">Create<span v-if="selectedGenerationTools.length" class="agent-media-composer__count">{{ selectedGenerationTools.length }}</span></v-btn></template>
        <v-list density="compact" class="agent-media-composer__tool-menu" aria-label="Creation tools">
          <v-list-subheader>Available for the assistant to use</v-list-subheader>
          <v-list-item v-for="option in generationOptions" :key="option.value" :title="option.title" :prepend-icon="option.icon" role="menuitemcheckbox" :aria-checked="selectedGenerationTools.includes(option.value)" :active="selectedGenerationTools.includes(option.value)" @click="toggleGenerationTool(option.value)">
            <template #append><v-icon :icon="selectedGenerationTools.includes(option.value) ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline'" size="20" aria-hidden="true" /></template>
          </v-list-item>
          <p class="agent-media-composer__menu-note">Ask naturally. The assistant can combine your selected tools in one reply.</p>
        </v-list>
      </v-menu>
      <v-btn v-if="capabilities?.transcription && !recording && !transcribing" variant="text" size="small" prepend-icon="mdi-microphone-outline" :disabled="locked" aria-label="Dictate a message" @click="startRecording">Dictate</v-btn>
      <template v-if="recording">
        <span class="agent-media-composer__recording" role="status">Recording · {{ seconds }} / 60s</span>
        <v-btn variant="tonal" color="primary" size="small" prepend-icon="mdi-stop" @click="stopRecording">Transcribe</v-btn>
      </template>
      <span v-if="transcribing" role="status">Transcribing…</span>
      <v-btn v-if="recording || transcribing" variant="text" size="small" @click="cancelDictation">Cancel dictation</v-btn>
      <span v-if="uploading" role="status">Uploading…</span>
    </div>
    <p v-if="generationOptions.length && generationToolsEnabled === false" class="agent-media-composer__hint">Creation tools are available in conversations that support tool use.</p>
    <p v-else-if="generationOptions.length && !capabilities?.attachments" class="agent-media-composer__hint">Image references need PDF and image attachments enabled for this provider.</p>
    <ul v-if="attachments.length" class="agent-media-composer__attachments" aria-label="Attachments for the next message">
      <li v-for="item in attachments" :key="item.id">
        <img v-if="item.mimeType.startsWith('image/')" :src="agentMediaContentUrl(item.id)" alt="" />
        <v-icon v-else icon="mdi-file-pdf-box" size="24" aria-hidden="true" />
        <span :title="item.filename">{{ item.filename }}</span>
        <v-btn icon="mdi-close" size="x-small" variant="text" :aria-label="`Remove ${item.filename}`" :disabled="locked" @click="removeAttachment(item)" />
      </li>
    </ul>
    <AgentAssetPicker v-if="assetPickerOpen" :image-only="false" :busy="uploading" :disabled="disabled || networkBlocked" :attachment-error="error" @close="closeAssetPicker" @select="attachAsset" />
    <p v-if="error && !assetPickerOpen" class="agent-media-composer__error" role="alert">{{ error }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import type { AgentMediaView, AgentProviderProfileView, AgentThreadState } from '../../../shared/agents/contracts.ts'
import { AgentApiError, agentMediaContentUrl, attachAgentAsset, cancelAgentRun, deleteAgentMedia, getAgentTranscription, startAgentTranscription, uploadAgentMedia } from '../../helpers/agents-api.ts'
import AgentAssetPicker from './agent-asset-picker.vue'
import type { Asset } from '../../helpers/assets-api.ts'
import { validateAgentAttachment, type AgentMediaSubmission } from '../../helpers/agent-media.ts'
const props = defineProps<{
  csrfToken: string
  session: AgentThreadState['session'] | null
  capabilities?: AgentProviderProfileView['media']
  generationToolsEnabled?: boolean
  disabled: boolean
  networkBlocked: boolean
}>()
const emit = defineEmits<{ change: [value: AgentMediaSubmission]; busy: [value: boolean]; dictation: [text: string]; settled: [] }>()
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const mediaControls = useTemplateRef<HTMLDivElement>('mediaControls')
const attachmentMenu = ref(false)
const assetPickerOpen = ref(false)
const attachments = ref<AgentMediaView[]>([])
const generationMenu = ref(false)
type GenerationTool = 'image' | 'video' | 'music'
const selectedGenerationTools = ref<GenerationTool[]>([])
const generationOptions = computed(() => [
  { value: 'image' as const, enabled: props.capabilities?.imageGeneration, title: 'Images', icon: 'mdi-image-outline' },
  { value: 'video' as const, enabled: props.capabilities?.videoGeneration, title: 'Video', icon: 'mdi-movie-open-outline' },
  { value: 'music' as const, enabled: props.capabilities?.musicGeneration, title: 'Music', icon: 'mdi-music-note-outline' }
].filter(option => option.enabled))
watch(generationOptions, (options, previous = []) => {
  const previousIds = new Set(previous.map(option => option.value))
  selectedGenerationTools.value = options.filter(option => !previousIds.has(option.value) || selectedGenerationTools.value.includes(option.value)).map(option => option.value)
}, { immediate: true })
const error = ref('')
const uploading = ref(false)
const recording = ref(false)
const transcribing = ref(false)
const seconds = ref(0)
const locked = computed(() => props.disabled || props.networkBlocked || uploading.value || recording.value || transcribing.value)
const fetcher: typeof fetch = (...args) => window.fetch(...args)
let disposed = false
let generation = 0
let uploadController: AbortController | null = null
let dictationController: AbortController | null = null
let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let timer: ReturnType<typeof setInterval> | null = null
let transcriptionRunId: string | null = null
watch([attachments, selectedGenerationTools, () => props.generationToolsEnabled], () => emit('change', { attachmentIds: attachments.value.map(item => item.id), generationTools: props.generationToolsEnabled === false ? [] : [...selectedGenerationTools.value] }), { deep: true, immediate: true })
watch([uploading, recording, transcribing], () => emit('busy', uploading.value || recording.value || transcribing.value), { flush: 'sync' })
const releaseMicrophone = () => {
  if (timer !== null) clearInterval(timer)
  timer = null
  stream?.getTracks().forEach(track => track.stop())
  stream = null
}
const cancelDictation = () => {
  generation += 1
  dictationController?.abort()
  dictationController = null
  if (recorder) {
    recorder.onstop = null
    recorder.ondataavailable = null
    if (recorder.state !== 'inactive') recorder.stop()
  }
  recorder = null
  releaseMicrophone()
  recording.value = false
  transcribing.value = false
  if (transcriptionRunId) {
    const id = transcriptionRunId
    transcriptionRunId = null
    void cancelAgentRun(fetcher, props.csrfToken, id).catch(() => {}).finally(() => { if (!disposed) emit('settled') })
  }
}
const toggleGenerationTool = (tool: GenerationTool) => {
  if (locked.value || props.generationToolsEnabled === false || !generationOptions.value.some(option => option.value === tool)) return
  selectedGenerationTools.value = selectedGenerationTools.value.includes(tool) ? selectedGenerationTools.value.filter(item => item !== tool) : generationOptions.value.filter(option => option.value === tool || selectedGenerationTools.value.includes(option.value)).map(option => option.value)
}
const clear = () => {
  // Accepted uploads now belong to the message; never delete them here.
  attachments.value = []
  error.value = ''
}
const removeAttachment = async (item: AgentMediaView) => {
  if (locked.value) return
  uploading.value = true
  try {
    await deleteAgentMedia(fetcher, props.csrfToken, item.id)
    if (!disposed) attachments.value = attachments.value.filter(candidate => candidate.id !== item.id)
  } catch (value) { if (!disposed) error.value = value instanceof Error ? value.message : 'The attachment could not be removed.' }
  finally { if (!disposed) uploading.value = false }
}
const addFiles = async (files: readonly File[]) => {
  if (locked.value || !props.capabilities?.attachments || !props.session) return false
  error.value = ''
  if (attachments.value.length + files.length > 4) { error.value = 'Attach up to 4 files per message.'; return }
  for (const file of files) {
    const problem = validateAgentAttachment(file)
    if (problem) { error.value = problem; return false }
  }
  const sessionId = props.session.id
  const csrfToken = props.csrfToken
  const controller = new AbortController()
  uploadController = controller
  uploading.value = true
  try {
    for (const file of files) {
      const media = await uploadAgentMedia(fetcher, csrfToken, sessionId, file, controller.signal)
      if (disposed || controller.signal.aborted || props.session?.id !== sessionId) {
        void deleteAgentMedia(fetcher, csrfToken, media.id).catch(() => {})
        return
      }
      attachments.value = [...attachments.value, media]
    }
    return true
  } catch (value) {
    if (!disposed && !controller.signal.aborted) error.value = value instanceof Error ? value.message : 'The attachment could not be uploaded.'
  } finally {
    if (uploadController === controller) { uploadController = null; uploading.value = false }
  }
}
const chooseUpload = () => {
  attachmentMenu.value = false
  if (!locked.value && props.session && attachments.value.length < 4) fileInput.value?.click()
}
const browseAssets = () => {
  attachmentMenu.value = false
  if (locked.value || !props.session || attachments.value.length >= 4 || !props.capabilities?.attachments) return
  error.value = ''
  assetPickerOpen.value = true
}
const closeAssetPicker = () => {
  if (!assetPickerOpen.value) return
  assetPickerOpen.value = false
  uploadController?.abort()
  void nextTick(() => {
    const trigger = mediaControls.value?.querySelector<HTMLButtonElement>('.agent-media-composer__attach')
    if (!trigger || disposed || assetPickerOpen.value) return
    // Menu activator props own the button ref. Restore through the stable controls
    // after the dialog's focus trap and inert background have been released.
    window.requestAnimationFrame(() => { if (!disposed && !assetPickerOpen.value && trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true }) })
  })
}
const attachAsset = async (asset: Asset) => {
  if (!assetPickerOpen.value || locked.value || !props.session || attachments.value.length >= 4 || !props.capabilities?.attachments) return
  const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' }
  const type = mimeTypes[asset.ext.replace(/^\./, '').toLowerCase()] ?? ''
  const problem = validateAgentAttachment({ type, size: asset.fileSize })
  if (problem) { error.value = problem; return }
  const sessionId = props.session.id
  const csrfToken = props.csrfToken
  const controller = new AbortController()
  uploadController = controller
  uploading.value = true
  error.value = ''
  try {
    const media = await attachAgentAsset(fetcher, csrfToken, sessionId, asset.id, controller.signal)
    if (disposed || controller.signal.aborted || props.session?.id !== sessionId || !assetPickerOpen.value) {
      void deleteAgentMedia(fetcher, csrfToken, media.id).catch(() => {})
      return
    }
    attachments.value = [...attachments.value, media]
    closeAssetPicker()
  } catch (value) {
    if (!disposed && !controller.signal.aborted) error.value = value instanceof AgentApiError && value.status === 403 ? 'You no longer have access to this Wiki asset. Choose another file or upload a copy.' : value instanceof Error ? value.message : 'The Wiki asset could not be attached.'
  } finally {
    if (uploadController === controller) { uploadController = null; uploading.value = false }
  }
}
const editImage = async (media: AgentMediaView): Promise<boolean> => {
  if (locked.value || !props.capabilities?.imageGeneration || !props.capabilities?.attachments || props.generationToolsEnabled === false || !props.session) return false
  const sessionId = props.session.id
  error.value = ''
  uploading.value = true
  const controller = new AbortController()
  uploadController = controller
  let file: File
  try {
    const response = await fetcher(agentMediaContentUrl(media.id), { credentials: 'same-origin', signal: controller.signal })
    if (!response.ok) throw new Error('The image is no longer available. Try attaching it again.')
    const blob = await response.blob()
    if (disposed || controller.signal.aborted || props.session?.id !== sessionId) return false
    file = new File([blob], media.filename, { type: media.mimeType })
  } catch (value) {
    if (!disposed && !controller.signal.aborted) error.value = value instanceof Error ? value.message : 'The image could not be attached.'
    return false
  } finally {
    if (uploadController === controller) { uploadController = null; uploading.value = false }
  }
  const added = await addFiles([file])
  if (added && !selectedGenerationTools.value.includes('image')) selectedGenerationTools.value = ['image', ...selectedGenerationTools.value]
  return added === true
}
const chooseFiles = (event: Event) => {
  const input = event.target as HTMLInputElement
  void addFiles(Array.from(input.files ?? []))
  input.value = ''
}
const stopRecording = () => {
  if (recorder?.state === 'recording') recorder.stop()
  releaseMicrophone()
}
const startRecording = async () => {
  if (locked.value || !props.session || !props.capabilities?.transcription) return
  error.value = ''
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    error.value = 'This browser does not support dictation. You can still type your message.'
    return
  }
  const current = ++generation
  const session = props.session
  const csrfToken = props.csrfToken
  recording.value = true
  seconds.value = 0
  let chunks: Blob[] = []
  let byteLength = 0
  try {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (disposed || current !== generation || props.networkBlocked) { microphone.getTracks().forEach(track => track.stop()); return }
    stream = microphone
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type))
    recorder = mimeType ? new MediaRecorder(microphone, { mimeType }) : new MediaRecorder(microphone)
    recorder.ondataavailable = event => {
      byteLength += event.data.size
      if (byteLength > 10 * 1024 * 1024) { error.value = 'Recording exceeded 10 MB. Please record a shorter message.'; cancelDictation(); return }
      chunks.push(event.data)
    }
    recorder.onerror = () => { error.value = 'Recording failed. Please try again.'; cancelDictation() }
    recorder.onstop = () => {
      const type = recorder?.mimeType || 'audio/webm'
      recorder = null
      releaseMicrophone()
      recording.value = false
      if (current !== generation || disposed) return
      const file = new File(chunks, type.includes('mp4') ? 'dictation.m4a' : type.includes('ogg') ? 'dictation.ogg' : 'dictation.webm', { type: type.split(';')[0] })
      chunks = []
      void transcribe(file, session, csrfToken, current)
    }
    recorder.start(1000)
    timer = setInterval(() => { seconds.value += 1; if (seconds.value >= 60) stopRecording() }, 1000)
  } catch (value) {
    if (current === generation && !disposed) { error.value = value instanceof Error ? value.message : 'Microphone access was not available.'; cancelDictation() }
  }
}
const transcribe = async (file: File, session: AgentThreadState['session'], csrfToken: string, current: number) => {
  const controller = new AbortController()
  dictationController = controller
  transcribing.value = true
  let uploadedId: string | null = null
  let admitted = false
  try {
    const media = await uploadAgentMedia(fetcher, csrfToken, session.id, file, controller.signal)
    uploadedId = media.id
    if (controller.signal.aborted) return
    const runId = await startAgentTranscription(fetcher, csrfToken, session.id, { clientRequestId: crypto.randomUUID(), expectedSessionVersion: session.version, profileResolutionToken: session.profileResolutionToken, attachmentId: media.id })
    admitted = true
    if (disposed || current !== generation) {
      void cancelAgentRun(fetcher, csrfToken, runId).catch(() => {}).finally(() => { if (!disposed && props.session?.id === session.id) emit('settled') })
      return
    }
    transcriptionRunId = runId
    const deadline = Date.now() + 180_000
    while (!controller.signal.aborted && Date.now() < deadline) {
      const result = await getAgentTranscription(fetcher, csrfToken, runId, controller.signal)
      if (disposed || current !== generation) return
      if (result.status === 'succeeded') {
        if (result.text?.trim()) emit('dictation', result.text.trim())
        else error.value = 'No speech was found. Try recording again.'
        transcriptionRunId = null
        return
      }
      if (!['queued', 'running'].includes(result.status)) throw new Error('Dictation could not be transcribed. Please try again.')
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timeout); controller.signal.removeEventListener('abort', finish); resolve() }
        const timeout = setTimeout(finish, 800)
        controller.signal.addEventListener('abort', finish, { once: true })
      })
    }
    if (!controller.signal.aborted) throw new Error('Transcription took too long. Please try again.')
  } catch (value) {
    if (!disposed && current === generation && !controller.signal.aborted) error.value = value instanceof Error ? value.message : 'Dictation could not be transcribed.'
  } finally {
    if (uploadedId && !admitted) void deleteAgentMedia(fetcher, csrfToken, uploadedId).catch(() => {})
    if (current === generation) {
      if (transcriptionRunId) void cancelAgentRun(fetcher, csrfToken, transcriptionRunId).catch(() => {})
      transcriptionRunId = null
      dictationController = null
      transcribing.value = false
      if (!disposed) emit('settled')
    }
  }
}
watch(() => [props.disabled, props.networkBlocked] as const, ([disabled, blocked]) => { if (disabled || blocked) { attachmentMenu.value = false; closeAssetPicker(); uploadController?.abort(); if (blocked) cancelDictation() } }, { flush: 'sync' })
watch(() => props.session?.id, (id, previous) => {
  if (id === previous) return
  attachmentMenu.value = false
  closeAssetPicker()
  uploadController?.abort()
  cancelDictation()
  for (const item of attachments.value) void deleteAgentMedia(fetcher, props.csrfToken, item.id).catch(() => {})
  clear()
}, { flush: 'sync' })
watch(() => props.capabilities, () => {
  attachmentMenu.value = false
  generationMenu.value = false
  closeAssetPicker()
  uploadController?.abort()
  if (!props.capabilities?.transcription) cancelDictation()
  if (!props.capabilities?.attachments && attachments.value.length) {
    for (const item of attachments.value) void deleteAgentMedia(fetcher, props.csrfToken, item.id).catch(() => {})
    attachments.value = []
    error.value = 'Attachments were removed because this provider no longer supports them.'
  }
}, { deep: true })
onBeforeUnmount(() => {
  disposed = true
  cancelDictation()
  uploadController?.abort()
  for (const item of attachments.value) void deleteAgentMedia(fetcher, props.csrfToken, item.id).catch(() => {})
})
defineExpose({ clear, addFiles, editImage })
</script>
<style scoped>
.agent-media-composer { padding: 0 var(--wiki-space-3); }
.agent-media-composer__controls { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; font-size: .8rem; }
.agent-media-composer__count { margin-left: 6px; font-size: .72rem; opacity: .7; }
.agent-media-composer__tool-menu { min-width: 264px; max-width: min(320px, calc(100vw - 24px)); }
.agent-media-composer__menu-note { margin: 8px 16px 6px; max-width: 250px; font-size: .75rem; line-height: 1.5; opacity: .7; }
.agent-media-composer__file { display: none; }
.agent-media-composer__hint { margin: 2px 0 6px; font-size: .78rem; color: rgb(var(--v-theme-on-surface), .68); }
.agent-media-composer__attachments { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; padding: 4px 0; margin: 0; }
.agent-media-composer__attachments li { display: flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 6px; border: 1px solid rgb(var(--v-theme-on-surface), .12); border-radius: 12px; background: rgb(var(--v-theme-surface), .48); }
.agent-media-composer__attachments img { width: 32px; height: 32px; object-fit: cover; border-radius: 6px; }
.agent-media-composer__attachments li > span { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .8rem; }
.agent-media-composer__recording { color: rgb(var(--v-theme-error)); }
.agent-media-composer__error { color: rgb(var(--v-theme-error)); font-size: .8rem; margin: 6px 0; }
</style>
