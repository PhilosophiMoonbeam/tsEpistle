import fs from 'node:fs'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { agentMediaContentUrl, cancelAgentRun, deleteAgentMedia, getAgentTranscription, startAgentTranscription, uploadAgentMedia } from '../../helpers/agents-api.ts'
import { validateAgentAttachment } from '../../helpers/agent-media.ts'
const source = fs.readFileSync(new URL('./agent-composer-media.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
if (!script) throw new Error('Media composer script is missing')
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))
const evaluate = new Function('dependencies', `const { computed, onBeforeUnmount, ref, useTemplateRef, watch, defineProps, defineEmits, defineExpose, agentMediaContentUrl, cancelAgentRun, deleteAgentMedia, getAgentTranscription, startAgentTranscription, uploadAgentMedia, validateAgentAttachment, navigator, MediaRecorder, window } = dependencies; ${executable}; return { addFiles, editImage, clear, cancelDictation, startRecording, stopRecording, attachments, imageMode, recording, transcribing, error }`)
const sessionId = '00000000-0000-4000-8000-000000000081'
const mediaId = '00000000-0000-4000-8000-000000000082'
const runId = '00000000-0000-4000-8000-000000000083'
const media = { id: mediaId, kind: 'attachment', filename: 'image.png', mimeType: 'image/png', byteLength: 5, available: true }
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const settle = async () => { for (let step = 0; step < 12; step++) await new Promise(resolve => setTimeout(resolve, 0)) }
class Recorder {
  static isTypeSupported() { return true }
  state = 'inactive'
  mimeType = 'audio/webm'
  onstop: (() => void) | null = null
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onerror: (() => void) | null = null
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) }); this.onstop?.() }
}
const mount = (options: { media?: { attachments: boolean; imageGeneration: boolean; transcription: boolean }; fetch?: typeof fetch; microphone?: () => Promise<unknown> } = {}) => {
  const props = reactive({ csrfToken: 'csrf', session: { id: sessionId, version: 3, profileResolutionToken: 'resolved' }, capabilities: options.media, disabled: false, networkBlocked: false })
  const events: Array<[string, unknown]> = []
  const cleanup: Array<() => void> = []
  let stopped = 0
  let microphoneCalls = 0
  const scope = effectScope()
  const api = scope.run(() => evaluate({ computed, ref, watch, useTemplateRef: () => ref(null), onBeforeUnmount: (fn: () => void) => cleanup.push(fn), defineProps: () => props, defineEmits: () => (event: string, value: unknown) => events.push([event, value]), defineExpose: () => {}, agentMediaContentUrl, cancelAgentRun, deleteAgentMedia, getAgentTranscription, startAgentTranscription, uploadAgentMedia, validateAgentAttachment, navigator: { mediaDevices: { getUserMedia: async () => { microphoneCalls++; return options.microphone ? options.microphone() : { getTracks: () => [{ stop: () => { stopped++ } }] } } } }, MediaRecorder: Recorder, window: { fetch: options.fetch ?? (async () => response({ media })) } }))
  return { api, props, events, stopped: () => stopped, microphoneCalls: () => microphoneCalls, unmount: () => { cleanup.forEach(fn => { fn() }); scope.stop() } }
}
describe('Agent media composer lifecycle', () => {
  it('does not upload or request microphone access without configured capabilities', async () => {
    let requests = 0
    const harness = mount({ fetch: async () => { requests++; return response({ media }) } })
    await harness.api.addFiles([new File(['bytes'], 'image.png', { type: 'image/png' })])
    await harness.api.startRecording()
    expect(requests).toBe(0)
    expect(harness.microphoneCalls()).toBe(0)
    harness.unmount()
  })
  it('stops a late permission grant after the conversation is unmounted', async () => {
    let grant!: (stream: unknown) => void
    let stopped = 0
    const harness = mount({ media: { attachments: false, imageGeneration: false, transcription: true }, microphone: () => new Promise(resolve => { grant = resolve }) })
    const starting = harness.api.startRecording()
    harness.unmount()
    grant({ getTracks: () => [{ stop: () => { stopped++ } }] })
    await starting
    expect(stopped).toBe(1)
    expect(harness.events.some(([event]) => event === 'dictation')).toBe(false)
  })
  it('transcribes into an editable draft without sending a chat message and releases the microphone', async () => {
    const paths: string[] = []
    const harness = mount({ media: { attachments: false, imageGeneration: false, transcription: true }, fetch: async (input) => {
      const path = String(input); paths.push(path)
      if (path.endsWith('/media')) return response({ media: { ...media, mimeType: 'audio/webm' } })
      if (path.endsWith('/transcriptions')) return response({ runId })
      if (path.endsWith('/transcription')) return response({ status: 'succeeded', text: 'Please edit this draft.' })
      throw new Error(`Unexpected request ${path}`)
    } })
    await harness.api.startRecording()
    harness.api.stopRecording()
    await settle()
    expect(harness.stopped()).toBe(1)
    expect(harness.events).toContainEqual(['dictation', 'Please edit this draft.'])
    expect(paths.some(path => path.endsWith('/messages'))).toBe(false)
    expect(harness.api.transcribing.value).toBe(false)
    harness.unmount()
  })
  it('cancels an admitted transcription when connection is lost and ignores late text', async () => {
    let resolveResult!: (value: Response) => void
    let cancelled = false
    const harness = mount({ media: { attachments: false, imageGeneration: false, transcription: true }, fetch: async (input) => {
      const path = String(input)
      if (path.endsWith('/media')) return response({ media })
      if (path.endsWith('/transcriptions')) return response({ runId })
      if (path.endsWith('/transcription')) return new Promise(resolve => { resolveResult = resolve })
      if (path.endsWith('/cancel')) { cancelled = true; return response({ run: { id: runId, sessionId, status: 'cancelled', attempt: 1, eventSequence: 1, canCancel: false, createdAt: '2026-09-18T00:00:00.000Z', startedAt: null, completedAt: null, errorCode: null, errorMessage: null } }) }
      throw new Error(`Unexpected request ${path}`)
    } })
    await harness.api.startRecording(); harness.api.stopRecording(); await settle()
    harness.props.networkBlocked = true; await nextTick()
    resolveResult(response({ status: 'succeeded', text: 'Late text' })); await settle()
    expect(cancelled).toBe(true)
    expect(harness.events.some(([event]) => event === 'dictation')).toBe(false)
    harness.unmount()
  })
  it('preserves a PDF draft and asks for removal before reattaching an image for editing', async () => {
    let requests = 0
    const harness = mount({ media: { attachments: true, imageGeneration: true, transcription: false }, fetch: async () => { requests++; return response({ media: { ...media, filename: 'reference.pdf', mimeType: 'application/pdf' } }) } })
    await harness.api.addFiles([new File(['%PDF-1.7'], 'reference.pdf', { type: 'application/pdf' })])
    expect(await harness.api.editImage({ ...media, kind: 'generated-image' })).toBe(false)
    expect(requests).toBe(1)
    expect(harness.api.attachments.value).toHaveLength(1)
    expect(harness.api.imageMode.value).toBe(false)
    expect(harness.api.error.value).toContain('Remove PDF')
    harness.api.clear()
    harness.unmount()
  })
  it('enters image mode for image-only providers and keeps accepted media when clearing the composer', async () => {
    const methods: string[] = []
    const harness = mount({ media: { attachments: false, imageGeneration: true, transcription: false }, fetch: async (_input, init) => { methods.push(init?.method ?? 'GET'); return response({ media }) } })
    await harness.api.addFiles([new File(['bytes'], 'image.png', { type: 'image/png' })])
    expect(harness.api.imageMode.value).toBe(true)
    expect(harness.api.attachments.value).toHaveLength(1)
    harness.api.clear(); harness.unmount()
    expect(methods).toEqual(['POST'])
  })
})
