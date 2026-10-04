<template>
  <div v-if="error || capabilities?.attachments || generationOptions.length || capabilities?.transcription" class="agent-media-composer">
    <!-- Recording, upload, and transcription controls live in the composer action bar (agent-composer.vue).
         This component owns the capture/transcription pipeline and renders pending attachments only. -->
    <input ref="fileInput" class="agent-media-composer__file" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" multiple :aria-label="$t('common:agentComposerMedia.chooseImagesPdfs')" :disabled="locked || !session || !capabilities?.attachments || attachments.length >= 4" @change="chooseFiles" />
    <p v-if="generationOptions.length && generationToolsEnabled === false" class="agent-media-composer__hint">{{ $t('common:agentComposerMedia.creationToolsAvailableConversations') }}</p>
    <p v-else-if="generationOptions.length && !capabilities?.attachments" class="agent-media-composer__hint">{{ $t('common:agentComposerMedia.imageReferencesNeedPdf') }}</p>
    <slot
      name="attachments"
      :attachments="attachments"
      :uploading="uploading"
      :locked="locked"
      :remove-attachment="removeAttachment"
    />
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
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const props = defineProps<{
  csrfToken: string
  session: AgentThreadState['session'] | null
  capabilities?: AgentProviderProfileView['media']
  generationToolsEnabled?: boolean
  disabled: boolean
  networkBlocked: boolean
}>()
const emit = defineEmits<{ change: [value: AgentMediaSubmission]; busy: [value: boolean]; dictation: [text: string]; dictationFailed: [message: string]; settled: []; assetPickerClosed: [] }>()
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const assetPickerOpen = ref(false)
const attachments = ref<AgentMediaView[]>([])
type GenerationTool = 'image' | 'video' | 'music'
const selectedGenerationTools = ref<GenerationTool[]>([])
const generationOptions = computed(() => [
  { value: 'image' as const, enabled: props.capabilities?.imageGeneration, title: t('common:agentComposerMedia.images'), icon: 'mdi-image-outline' },
  { value: 'video' as const, enabled: props.capabilities?.videoGeneration, title: t('common:agentComposerMedia.video'), icon: 'mdi-movie-open-outline' },
  { value: 'music' as const, enabled: props.capabilities?.musicGeneration, title: t('common:agentComposerMedia.music'), icon: 'mdi-music-note-outline' }
].filter(option => option.enabled))
watch(generationOptions, options => {
  // Availability can revoke a choice, but only a user action can enable one.
  selectedGenerationTools.value = options.filter(option => selectedGenerationTools.value.includes(option.value)).map(option => option.value)
}, { immediate: true })
const error = ref('')
/** Dictation failures surface through the composer's notice, not the attachment error slot. */
const dictationError = ref('')
const uploading = ref(false)
const recording = ref(false)
/** True while microphone permission is still being requested. */
const requesting = ref(false)
const transcribing = ref(false)
const seconds = ref(0)
/**
 * How the next settled transcription should be delivered: 'insert' puts the
 * transcript into the draft for review; 'send' resolves the pending
 * send-during-recording submit with the transcript. The composer drives this
 * through beginDictationSubmit before stopping capture.
 */
const dictationIntent = ref<'insert' | 'send'>('insert')
const dictationSendText = ref<string | null>(null)
let dictationSendResolve: ((text: string | null) => void) | null = null
const locked = computed(() => props.disabled || props.networkBlocked || uploading.value || recording.value || transcribing.value)
const fetcher: typeof fetch = (...args) => window.fetch(...args)
let disposed = false
let generation = 0
let uploadController: AbortController | null = null
let dictationController: AbortController | null = null
let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null
// Screen Wake Lock while dictating: keeps the screen awake so mobile browsers
// do not mute or kill the microphone capture when the page loses visibility.
interface WakeLockSentinelLike {
  release: () => Promise<void>
  addEventListener?: (type: 'release', listener: () => void) => void
}
type WakeLockManager = { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
let wakeLock: WakeLockSentinelLike | null = null
let wakeLockPending = false
const acquireWakeLock = async () => {
  const manager = (navigator as Navigator & { wakeLock?: WakeLockManager }).wakeLock
  if (wakeLockPending || wakeLock !== null || disposed || !recording.value || !manager) return
  const current = generation
  wakeLockPending = true
  try {
    const sentinel = await manager.request('screen')
    if (disposed || !recording.value || current !== generation) {
      void sentinel.release().catch(() => {})
      return
    }
    wakeLock = sentinel
    // The browser releases the lock on its own when the page hides; clear the
    // handle so the visibilitychange listener can re-acquire when visible again.
    sentinel.addEventListener?.('release', () => { if (wakeLock === sentinel) wakeLock = null })
  } catch { /* Wake lock is best-effort: unsupported, denied, or page hidden. */ } finally {
    wakeLockPending = false
  }
}
const releaseWakeLock = () => {
  const lock = wakeLock
  wakeLock = null
  void lock?.release().catch(() => {})
}
const handleWakeLockVisibility = () => {
  if (document.visibilityState === 'visible') void acquireWakeLock()
}
let timer: ReturnType<typeof setInterval> | null = null
let transcriptionRunId: string | null = null
// Live microphone feedback for the recording waveform. Created per capture;
// never connected to the output destination.
let levelContext: AudioContext | null = null
let levelSource: MediaStreamAudioSourceNode | null = null
let levelAnalyser: AnalyserNode | null = null
let levelData: Float32Array<ArrayBuffer> | null = null
let analysisUnavailable = false
let fallbackTimer: ReturnType<typeof setTimeout> | null = null
// Speech-activity endpointing: the 60s countdown starts when sustained voice
// is first detected (pre-roll does not consume the timer), sustained silence
// after speech auto-stops into the review path, and a pre-roll with no
// speech at all is canceled so a stray recording never sits open.
const SPEECH_ONSET_LEVEL = 0.06
const SILENCE_FLOOR_LEVEL = 0.035
const SPEECH_ONSET_TICKS = 2
const ENDPOINT_SILENCE_MS = 2_500
const PRE_SPEECH_LIMIT_MS = 10_000
const SPEECH_TICK_MS = 100
const speechDetected = ref(false)
let speechMonitor: ReturnType<typeof setInterval> | null = null
let speechVotes = 0
let lastVoiceAt = 0
let preRollStartedAt = 0
watch([attachments, selectedGenerationTools, () => props.generationToolsEnabled], () => emit('change', { attachmentIds: attachments.value.map(item => item.id), generationTools: props.generationToolsEnabled === false ? [] : [...selectedGenerationTools.value] }), { deep: true, immediate: true })
watch([uploading, recording, transcribing], () => emit('busy', uploading.value || recording.value || transcribing.value), { flush: 'sync' })
const releaseMicrophone = () => {
  document.removeEventListener('visibilitychange', handleWakeLockVisibility)
  releaseWakeLock()
  if (timer !== null) clearInterval(timer)
  timer = null
  if (speechMonitor !== null) clearInterval(speechMonitor)
  if (fallbackTimer !== null) clearTimeout(fallbackTimer)
  fallbackTimer = null
  analysisUnavailable = false
  speechMonitor = null
  speechDetected.value = false
  speechVotes = 0
  lastVoiceAt = 0
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  levelSource?.disconnect()
  levelSource = null
  levelAnalyser = null
  levelData = null
  if (levelContext) {
    const context = levelContext
    levelContext = null
    void context.close().catch(() => {})
  }
}
/**
 * One read of the live microphone: `level` is the visual amplitude from 0
 * (silence) to 1 (loudest) for the recording waveform, and `db` is the same
 * RMS expressed in dBFS (0 = digital full scale) for tone thresholds.
 * Analysis failure returns null, distinct from actual silence. The waveform
 * treats unavailable analysis as a flat line; endpointing uses manual stop.
 */
const readAudioSample = (): { level: number; db: number } | null => {
  if (!levelAnalyser || !levelData || (levelContext?.state && levelContext.state !== 'running') || typeof levelAnalyser.getFloatTimeDomainData !== 'function') return null
  try {
    levelAnalyser.getFloatTimeDomainData(levelData)
  } catch {
    return null
  }
  let sum = 0
  for (let index = 0; index < levelData.length; index += 1) sum += levelData[index] ** 2
  const rms = Math.sqrt(sum / levelData.length)
  return { level: Math.min(1, rms * 3), db: rms > 0 ? 20 * Math.log10(rms) : -96 }
}

const getAudioLevel = (): number => readAudioSample()?.level ?? 0

const getAudioLevelDb = (): number => readAudioSample()?.db ?? -96
/** Attaches an analyser to the live stream so the waveform can show real input. */
const startAudioFeedback = (microphone: MediaStream): void => {
  try {
    const contextCtor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (typeof contextCtor !== 'function') return
    const context = new contextCtor()
    levelContext = context
    const source = context.createMediaStreamSource(microphone)
    levelSource = source
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    levelAnalyser = analyser
    levelData = new Float32Array(analyser.fftSize)
    if (context.state === 'suspended') void context.resume().catch(() => {})
  } catch {
    // Analysis is optional; the recording and manual stop still work without it.
    levelSource?.disconnect()
    levelSource = null
    levelAnalyser = null
    levelData = null
    if (levelContext) {
      const context = levelContext
      levelContext = null
      void context.close().catch(() => {})
    }
  }
}
const cancelDictation = () => {
  generation += 1
  dictationController?.abort()
  dictationController = null
  if (recorder) {
    recorder.onstop = null
    recorder.ondataavailable = null
    recorder.onerror = null
    if (recorder.state !== 'inactive') recorder.stop()
  }
  recorder = null
  releaseMicrophone()
  recording.value = false
  requesting.value = false
  transcribing.value = false
  dictationIntent.value = 'insert'
  dictationSendResolve?.(null)
  dictationSendResolve = null
  dictationError.value = t('common:agentComposerMedia.dictationWasCanceledTyped')
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
  } catch (value) { if (!disposed) error.value = value instanceof Error ? value.message : t('common:agentComposerMedia.attachmentCouldNotRemoved') }
  finally { if (!disposed) uploading.value = false }
}
const addFiles = async (files: readonly File[]): Promise<boolean> => {
  if (disposed || !files.length) return false
  if (!props.capabilities?.attachments) { error.value = t('common:agentComposerMedia.attachmentsUnavailable'); return false }
  if (!props.session) { error.value = t('common:agentComposerMedia.sessionRequired'); return false }
  if (props.networkBlocked) { error.value = t('common:agentComposerMedia.connectionRequired'); return false }
  if (locked.value) { error.value = t('common:agentComposerMedia.attachmentsBusy'); return false }
  error.value = ''
  if (attachments.value.length + files.length > 4) { error.value = t('common:agentComposerMedia.attachUp4Files'); return false }
  for (const file of files) {
    const problem = validateAgentAttachment(file)
    if (problem) { error.value = t(problem); return false }
  }
  const sessionId = props.session.id
  const csrfToken = props.csrfToken
  const controller = new AbortController()
  uploadController = controller
  uploading.value = true
  const uploaded: Array<AgentMediaView | null> = files.map(() => null)
  const failed = files.map(() => false)
  const stale = () => disposed || controller.signal.aborted || uploadController !== controller || props.session?.id !== sessionId || props.csrfToken !== csrfToken
  const discardUploads = () => {
    for (let index = 0; index < uploaded.length; index += 1) {
      const media = uploaded[index]
      if (!media) continue
      uploaded[index] = null
      void deleteAgentMedia(fetcher, csrfToken, media.id).catch(() => {})
    }
  }
  controller.signal.addEventListener('abort', discardUploads, { once: true })
  let nextIndex = 0
  const uploadNext = async () => {
    while (!stale()) {
      const index = nextIndex++
      if (index >= files.length) return
      try {
        const media = await uploadAgentMedia(fetcher, csrfToken, sessionId, files[index], controller.signal)
        if (stale()) {
          void deleteAgentMedia(fetcher, csrfToken, media.id).catch(() => {})
          return
        }
        uploaded[index] = media
      } catch {
        if (stale()) return
        failed[index] = true
      }
    }
  }
  try {
    // Match the server's single-upload memory admission gate; files settle independently.
    await uploadNext()
    if (stale()) { discardUploads(); return false }
    attachments.value = [...attachments.value, ...uploaded.filter((media): media is AgentMediaView => media !== null)]
    if (failed.some(Boolean)) {
      error.value = t('common:agentComposerMedia.filesCouldNotUploaded', { filenames: files.filter((_file, index) => failed[index]).map(file => file.name).join(', '), interpolation: { escapeValue: false } })
      return false
    }
    return true
  } finally {
    controller.signal.removeEventListener('abort', discardUploads)
    if (uploadController === controller) { uploadController = null; uploading.value = false }
  }
}
const chooseUpload = () => {
  if (!locked.value && props.session && props.capabilities?.attachments && attachments.value.length < 4) fileInput.value?.click()
}
const browseAssets = () => {
  if (locked.value || !props.session || attachments.value.length >= 4 || !props.capabilities?.attachments) return
  error.value = ''
  assetPickerOpen.value = true
}
const closeAssetPicker = (restoreFocus = true) => {
  if (!assetPickerOpen.value) return
  assetPickerOpen.value = false
  uploadController?.abort()
  if (restoreFocus && !disposed) emit('assetPickerClosed')
}
const attachAsset = async (asset: Asset) => {
  if (!assetPickerOpen.value || locked.value || !props.session || attachments.value.length >= 4 || !props.capabilities?.attachments) return
  const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' }
  const type = mimeTypes[asset.ext.replace(/^\./, '').toLowerCase()] ?? ''
  const problem = validateAgentAttachment({ type, size: asset.fileSize })
  if (problem) { error.value = t(problem); return }
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
    if (!disposed && !controller.signal.aborted) error.value = value instanceof AgentApiError && value.status === 403 ? t('common:agentComposerMedia.youNoLongerHave') : value instanceof Error ? value.message : t('common:agentComposerMedia.wikiAssetCouldNot')
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
    if (!response.ok) throw new Error(t('common:agentComposerMedia.imageNoLongerAvailable'))
    const blob = await response.blob()
    if (disposed || controller.signal.aborted || props.session?.id !== sessionId) return false
    file = new File([blob], media.filename, { type: media.mimeType })
  } catch (value) {
    if (!disposed && !controller.signal.aborted) error.value = value instanceof Error ? value.message : t('common:agentComposerMedia.imageCouldNotAttached')
    return false
  } finally {
    if (uploadController === controller) { uploadController = null; uploading.value = false }
  }
  const added = await addFiles([file])
  if (added && !selectedGenerationTools.value.includes('image')) selectedGenerationTools.value = ['image', ...selectedGenerationTools.value]
  return added === true
}
// Re-attaching a detached attachment downloads the stored copy and re-uploads it as a
// new pending attachment through the same flow used for freshly chosen files.
const reattachMedia = async (media: AgentMediaView): Promise<boolean> => {
  if (locked.value || !props.capabilities?.attachments || !props.session) return false
  const sessionId = props.session.id
  error.value = ''
  uploading.value = true
  const controller = new AbortController()
  uploadController = controller
  let file: File
  try {
    const response = await fetcher(agentMediaContentUrl(media.id), { credentials: 'same-origin', signal: controller.signal })
    if (!response.ok) throw new Error(t('common:agentComposerMedia.attachmentCopyNoLonger'))
    const blob = await response.blob()
    if (disposed || controller.signal.aborted || props.session?.id !== sessionId) return false
    file = new File([blob], media.filename, { type: media.mimeType })
  } catch (value) {
    if (!disposed && !controller.signal.aborted) error.value = value instanceof Error ? value.message : t('common:agentComposerMedia.attachmentCouldNotRe')
    return false
  } finally {
    if (uploadController === controller) { uploadController = null; uploading.value = false }
  }
  return (await addFiles([file])) === true
}
const chooseFiles = (event: Event) => {
  const input = event.target as HTMLInputElement
  void addFiles(Array.from(input.files ?? []))
  input.value = ''
}
// Stop capture and settle through the pipeline. When intent is 'send' the
// caller is awaiting the transcript through waitForDictationTranscript.
const stopRecording = () => {
  if (requesting.value) { cancelDictation(); return }
  if (recorder?.state === 'recording') recorder.stop()
  releaseMicrophone()
}
/**
 * One-shot send during recording: capture stops, the recording uploads and
 * transcribes, and the resolved transcript (or null on failure/cancel)
 * replaces the composer draft so exactly one submit can proceed.
 */
const waitForDictationTranscript = (): Promise<string | null> => {
  // A transcription for a 'send' intent that already settled (for example a
  // 60s auto-stop racing the send click) resolves with its stored text.
  if (dictationIntent.value === 'send' && dictationSendText.value !== null) return Promise.resolve(dictationSendText.value)
  if (recording.value || transcribing.value) {
    return new Promise(resolve => { dictationSendResolve = resolve })
  }
  return Promise.resolve(null)
}
/** Begin a stop-and-send dictation. Returns false when no recording is active. */
const beginDictationSubmit = (): boolean => {
  if (!recording.value) return false
  dictationIntent.value = 'send'
  return true
}
const failCapture = (current: number, message: string): void => {
  if (disposed || current !== generation || props.networkBlocked) return
  cancelDictation()
  dictationError.value = message
  emit('dictationFailed', message)
}
/** Speech-activity tick: starts the countdown on voice, endpoints on silence. */
const monitorSpeech = () => {
  if (!recording.value || recorder === null) return
  const now = Date.now()
  const sample = analysisUnavailable ? null : readAudioSample()
  if (!sample) {
    if (fallbackTimer === null) {
      analysisUnavailable = true
      fallbackTimer = setTimeout(stopRecording, Math.max(0, 60_000 - (now - preRollStartedAt)))
    }
    return
  }
  const level = sample.level
  if (!speechDetected.value) {
    if (level >= SPEECH_ONSET_LEVEL) {
      speechVotes += 1
      if (speechVotes < SPEECH_ONSET_TICKS) return
      speechDetected.value = true
      lastVoiceAt = now
      seconds.value = 0
      timer = setInterval(() => { seconds.value += 1; if (seconds.value >= 60) stopRecording() }, 1000)
      return
    }
    speechVotes = 0
    if (now - preRollStartedAt >= PRE_SPEECH_LIMIT_MS) {
      failCapture(generation, t('common:agentComposerMedia.noSpeechWasDetected'))
    }
    return
  }
  if (level >= SILENCE_FLOOR_LEVEL) {
    lastVoiceAt = now
    return
  }
  if (now - lastVoiceAt >= ENDPOINT_SILENCE_MS) stopRecording()
}

const startRecording = async () => {
  if (locked.value || !props.session || !props.capabilities?.transcription) return
  dictationError.value = ''
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    dictationError.value = t('common:agentComposerMedia.browserDoesNotSupport')
    emit('dictationFailed', dictationError.value)
    return
  }
  const current = ++generation
  const session = props.session
  const csrfToken = props.csrfToken
  requesting.value = true
  recording.value = true
  seconds.value = 0
  dictationIntent.value = 'insert'
  dictationSendText.value = null
  let chunks: Blob[] = []
  let byteLength = 0
  try {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true, channelCount: { ideal: 1 } }, video: false })
    if (disposed || current !== generation || props.networkBlocked || props.session?.id !== session.id || props.csrfToken !== csrfToken) {
      microphone.getTracks().forEach(track => track.stop())
      if (current === generation) {
        recording.value = false
        requesting.value = false
      }
      return
    }
    requesting.value = false
    stream = microphone
    startAudioFeedback(microphone)
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type))
    const captureRecorder = mimeType ? new MediaRecorder(microphone, { mimeType }) : new MediaRecorder(microphone)
    recorder = captureRecorder
    captureRecorder.ondataavailable = event => {
      if (current !== generation) return
      byteLength += event.data.size
      if (byteLength > 10 * 1024 * 1024) { failCapture(current, t('common:agentComposerMedia.recordingExceeded10Mb')); return }
      chunks.push(event.data)
    }
    captureRecorder.onerror = () => {
      if (props.session?.id !== session.id || props.csrfToken !== csrfToken) return
      failCapture(current, t('common:agentComposerMedia.recordingFailedPleaseTry'))
    }
    captureRecorder.onstop = () => {
      if (current !== generation || disposed) return
      const type = captureRecorder.mimeType || 'audio/webm'
      captureRecorder.onstop = null
      captureRecorder.ondataavailable = null
      captureRecorder.onerror = null
      if (recorder === captureRecorder) recorder = null
      releaseMicrophone()
      recording.value = false
      const file = new File(chunks, type.includes('mp4') ? 'dictation.m4a' : type.includes('ogg') ? 'dictation.ogg' : 'dictation.webm', { type: type.split(';')[0] })
      chunks = []
      void transcribe(file, session, csrfToken, current)
    }
    captureRecorder.start(1000)
    preRollStartedAt = Date.now()
    speechMonitor = setInterval(monitorSpeech, SPEECH_TICK_MS)
    document.addEventListener('visibilitychange', handleWakeLockVisibility)
    void acquireWakeLock()
  } catch (value) {
    if (props.session?.id === session.id && props.csrfToken === csrfToken) {
      failCapture(current, value instanceof Error ? value.message : t('common:agentComposerMedia.microphoneAccessWasNot'))
    }
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
        const transcript = result.text?.trim() ?? ''
        if (transcript) {
          dictationSendText.value = transcript
          if (dictationIntent.value === 'send') dictationSendResolve?.(transcript)
          else emit('dictation', transcript)
        } else {
          dictationError.value = t('common:agentComposerMedia.noSpeechWasFound')
          if (dictationIntent.value === 'send') dictationSendResolve?.(null)
          else emit('dictationFailed', dictationError.value)
        }
        dictationIntent.value = 'insert'
        dictationSendResolve = null
        transcriptionRunId = null
        return
      }
      if (!['queued', 'running'].includes(result.status)) throw new Error(t('common:agentComposerMedia.dictationCouldNotTranscribed'))
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timeout); controller.signal.removeEventListener('abort', finish); resolve() }
        const timeout = setTimeout(finish, 800)
        controller.signal.addEventListener('abort', finish, { once: true })
      })
    }
    if (!controller.signal.aborted) throw new Error(t('common:agentComposerMedia.transcriptionTookTooLong'))
  } catch (value) {
    if (!disposed && current === generation && !controller.signal.aborted) {
      dictationError.value = value instanceof Error ? value.message : t('common:agentComposerMedia.dictationCouldNotTranscribed2')
      emit('dictationFailed', dictationError.value)
    }
    if (current === generation && dictationSendResolve) {
      dictationSendResolve(null)
      dictationSendResolve = null
      dictationIntent.value = 'insert'
    }
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
watch(() => [props.disabled, props.networkBlocked] as const, ([disabled, blocked]) => { if (disabled || blocked) { closeAssetPicker(false); uploadController?.abort(); if (blocked) cancelDictation() } }, { flush: 'sync' })
watch(() => props.session?.id, (id, previous) => {
  if (id === previous) return
  closeAssetPicker(false)
  uploadController?.abort()
  cancelDictation()
  for (const item of attachments.value) void deleteAgentMedia(fetcher, props.csrfToken, item.id).catch(() => {})
  clear()
}, { flush: 'sync' })
watch(() => props.capabilities, () => {
  closeAssetPicker(false)
  uploadController?.abort()
  if (!props.capabilities?.transcription) cancelDictation()
  if (!props.capabilities?.attachments && attachments.value.length) {
    for (const item of attachments.value) void deleteAgentMedia(fetcher, props.csrfToken, item.id).catch(() => {})
    attachments.value = []
    error.value = t('common:agentComposerMedia.attachmentsWereRemovedBecause')
  }
}, { deep: true })
onBeforeUnmount(() => {
  disposed = true
  cancelDictation()
  uploadController?.abort()
  for (const item of attachments.value) void deleteAgentMedia(fetcher, props.csrfToken, item.id).catch(() => {})
})
defineExpose({ clear, addFiles, editImage, reattachMedia, attachments, startRecording, stopRecording, cancelDictation, beginDictationSubmit, waitForDictationTranscript, recording, requesting, transcribing, seconds, speechDetected, dictationIntent, dictationError, getAudioLevel, getAudioLevelDb, chooseUpload, browseAssets, toggleGenerationTool, generationOptions, selectedGenerationTools })
</script>
<style scoped>
.agent-media-composer { min-width: 0; }
.agent-media-composer__file { display: none; }
.agent-media-composer__hint { margin: 2px 0 6px; font-size: .78rem; color: rgb(var(--v-theme-on-surface), .68); }
.agent-media-composer__error { color: rgb(var(--v-theme-error)); font-size: .8rem; margin: 6px 0; }
</style>
