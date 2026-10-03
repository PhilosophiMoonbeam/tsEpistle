import fs from 'node:fs'
import path from 'node:path'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'

import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'
import { caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret } from './agent-composer-sizing.ts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
globalThis.useTranslate = () => translateEnglish
import type { AgentMediaView } from '../../../shared/agents/contracts.ts'

interface Ref<T> {
  value: T
}

interface TestSkill {
  readonly id: string
  readonly versionId: string
  readonly name: string
  readonly description: string
  readonly exposureMode: 'owner'
  readonly isAgentDiscoverable: boolean
}

interface KeyOptions {
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly isComposing?: boolean
}

interface SentMessage {
  readonly media?: { attachmentIds: readonly string[]; generationTools?: readonly ('image' | 'video' | 'music')[] }
  readonly content: string
  readonly invokedSkillVersionIds: readonly string[]
  readonly mode: 'message' | 'goal'
  readonly complete: (success: boolean) => void
}

interface ComposerHarness {
  readonly mediaSubmission: Ref<{ attachmentIds: readonly string[]; generationTools?: readonly ('image' | 'video' | 'music')[] }>
  readonly mediaBusy: Ref<boolean>
  readonly draft: Ref<string>
  readonly coarseInput: Ref<boolean>
  readonly goalMode: Ref<boolean>
  readonly selectedSkillIds: Ref<string[]>
  readonly activeCommandSkill: Ref<TestSkill | null>
  readonly activeCommandOptionId: Ref<string | undefined>
  readonly skillCommandOpen: Ref<boolean>
  readonly handleKeydown: (event: KeyboardEvent) => void
  readonly submit: () => void
  readonly sent: SentMessage[]
}

class FakeElement {}
class FakeTextArea extends FakeElement {}

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-composer.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const descriptor = parse(source, { filename: componentPath }).descriptor
const compiledScript = compileScript(descriptor, { id: 'agent-composer-interaction-test' })
if (!compiledScript.bindings || !compiledScript.scriptSetupAst) throw new Error('Composer setup metadata was not compiled')
const setupNames = Object.keys(compiledScript.bindings).filter(
  name => compiledScript.bindings?.[name] !== 'props' && compiledScript.bindings?.[name] !== 'props-aliased' && !compiledScript.imports?.[name]
)
const script = descriptor.scriptSetup?.content
if (!script) throw new Error('agent-composer.vue script block was not found')
const scriptParts: string[] = []
let previousImportEnd = 0
for (const statement of compiledScript.scriptSetupAst) {
  if (statement.type !== 'ImportDeclaration') continue
  if (typeof statement.start !== 'number' || typeof statement.end !== 'number') throw new Error('Composer import positions were not compiled')
  scriptParts.push(script.slice(previousImportEnd, statement.start))
  previousImportEnd = statement.end
}
scriptParts.push(script.slice(previousImportEnd))
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(scriptParts.join(''))
const evaluateComposer = new Function(
  '{ computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch, defineProps, defineEmits, defineExpose, filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills, caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret, window, document, HTMLElement, HTMLTextAreaElement }',
  `${executableScript}
return { ${setupNames.join(', ')} }`
) as (dependencies: Record<string, unknown>) => Record<string, unknown>
let nextComposerId = 0
const testUseId = (): string => `agent-composer-test-${++nextComposerId}`
if (!descriptor.template || descriptor.styles.length === 0) throw new Error('agent-composer.vue template and styles are required')

resetBody()

// These test-only imports must wait for the browser globals above; Vuetify snapshots them during module evaluation.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const compiledTemplate = compileTemplate({
  source: descriptor.template.content,
  filename: componentPath,
  id: 'agent-composer-interaction-test',
  compilerOptions: { mode: 'function' }
})
if (compiledTemplate.errors.length > 0) throw compiledTemplate.errors[0]
const renderAgentComposer = new Function('Vue', compiledTemplate.code)(Vue) as () => unknown
const compiledStyle = compileStyle({
  source: descriptor.styles.map(style => style.content).join('\n'),
  filename: componentPath,
  id: 'data-v-agent-composer-interaction-test',
  scoped: true
})
if (compiledStyle.errors.length > 0) throw compiledStyle.errors[0]
const styleElement = document.createElement('style')
styleElement.textContent = compiledStyle.code
document.head.append(styleElement)
const composerScopeAttribute = 'data-v-agent-composer-interaction-test'

// Compile the real setup and template together: returning setup locals would
// bypass script-setup privacy and conceal missing parent/child contracts.
Bun.plugin({
  name: 'agent-composer-real-sfc-regressions',
  setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const id = `composer-real-${path.basename(filename, '.vue')}`
      const script = compileScript(parsed.descriptor, {
        id,
        genDefaultAs: '__component',
        inlineTemplate: true,
        templateOptions: { compilerOptions: { scopeId: `data-v-${id}` } }
      })
      for (const style of parsed.descriptor.styles) {
        const compiled = compileStyle({ source: style.content, filename, id: `data-v-${id}`, scoped: style.scoped })
        if (compiled.errors.length) throw compiled.errors[0]
        const element = document.createElement('style')
        element.textContent = compiled.code
        document.head.append(element)
      }
      return { loader: 'ts', contents: `${script.content}\n__component.__scopeId = ${JSON.stringify(`data-v-${id}`)};\nexport default __component;` }
    })
  }
})
// The loader must be registered before this intentionally exercised SFC import.
const RealAgentComposer = (await import(componentPath)).default
const RealAgentComposerSkillMenu = (await import('./agent-composer-skill-menu.vue')).default

const realSessionId = '00000000-0000-4000-8000-000000000081'
const realMediaCapabilities = { attachments: true, imageGeneration: false, videoGeneration: false, musicGeneration: false, transcription: false }
const storedPdfBytes = '%PDF-1.4\nowned stored report\n%%EOF\n'
const storedPdf: AgentMediaView = {
  id: '00000000-0000-4000-8000-000000000084',
  kind: 'attachment',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  byteLength: storedPdfBytes.length,
  available: true,
  detached: true
}
interface RealComposerPublic {
  readonly reattachMedia: (media: AgentMediaView) => Promise<boolean>
  readonly hasUnsentMedia: () => boolean
  readonly isMediaBusy: () => boolean
}
interface RealComposerOptions {
  readonly skills?: readonly TestSkill[]
  readonly media?: boolean
  readonly attachments?: boolean
  readonly imageGeneration?: boolean
  readonly videoGeneration?: boolean
  readonly musicGeneration?: boolean
  readonly noSession?: boolean
  readonly networkBlocked?: boolean
  readonly invocationLimit?: number
}
const mountRealComposers = (options: readonly RealComposerOptions[]) => {
  const host = document.createElement('div')
  document.body.append(host)
  const publicRefs = options.map(() => Vue.ref<RealComposerPublic | null>(null))
  const requests: Array<{ path: string; method: string; credentials: RequestCredentials | undefined; csrf: string | null }> = []
  const uploads: Array<{ id: string; filename: string; type: string; bytes: string }> = []
  let nextUploadId = 100
  const sent: Array<Pick<SentMessage, 'content' | 'invokedSkillVersionIds' | 'mode' | 'media'>> = []
  const drafts: Array<{ sessionId: string; text: string }> = []
  const previousFetch = Object.getOwnPropertyDescriptor(browserWindow, 'fetch')
  const fetcher: typeof fetch = async (input, init) => {
    const requestPath = new URL(String(input), browserWindow.location.href).pathname
    const method = init?.method ?? 'GET'
    requests.push({ path: requestPath, method, credentials: init?.credentials, csrf: new Headers(init?.headers).get('x-wiki-csrf') })
    if (method === 'GET' && requestPath === `/_api/agents/media/${storedPdf.id}/content`) {
      return new Response(storedPdfBytes, { headers: { 'content-type': 'application/pdf' } })
    }
    if (method === 'POST' && requestPath === `/_api/agents/sessions/${realSessionId}/media`) {
      const file = (init?.body as FormData)?.get('file')
      if (!(file instanceof File)) throw new Error('Real media upload did not provide a multipart File')
      const id = `00000000-0000-4000-8000-${String(nextUploadId++).padStart(12, '0')}`
      uploads.push({ id, filename: file.name, type: file.type, bytes: await file.text() })
      return new Response(
        JSON.stringify({
          media: { id, kind: 'attachment', filename: file.name, mimeType: file.type, byteLength: file.size, available: true, detached: false }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    }
    if (method === 'GET' && (requestPath === '/_api/assets' || requestPath === '/_api/assets/folders')) {
      return new Response('[]', { headers: { 'content-type': 'application/json' } })
    }
    if (method === 'DELETE' && requestPath.startsWith('/_api/agents/media/')) return new Response(null, { status: 204 })
    throw new Error(`Unexpected real composer request: ${method} ${requestPath}`)
  }
  Object.defineProperty(browserWindow, 'fetch', { configurable: true, writable: true, value: fetcher })
  const app = Vue.createApp({
    setup: () => () =>
      Vue.h(
        'div',
        options.map((option, index) =>
          Vue.h(RealAgentComposer, {
            ref: publicRefs[index],
            sessionId: realSessionId,
            csrfToken: 'csrf',
            mediaSession: option.media && !option.noSession ? { id: realSessionId, version: 3, profileResolutionToken: 'resolved' } : null,
            mediaCapabilities: option.media
              ? {
                  ...realMediaCapabilities,
                  attachments: option.attachments ?? true,
                  imageGeneration: option.imageGeneration ?? false,
                  videoGeneration: option.videoGeneration ?? false,
                  musicGeneration: option.musicGeneration ?? false
                }
              : undefined,
            generationToolsEnabled: true,
            disabled: false,
            sending: false,
            canStop: false,
            skillsEnabled: Boolean(option.skills),
            googleSearchAvailable: false,
            googleSearchEnabled: false,
            goalsEnabled: true,
            skills: option.skills ?? [],
            skillsLoading: false,
            skillsLoadError: '',
            skillsPartial: false,
            preferredSkills: [],
            invocationLimit: option.invocationLimit ?? 3,
            statusLabel: 'Ready',
            statusTone: 'ready',
            initialDraft: '',
            networkBlocked: option.networkBlocked ?? false,
            onDraftChange: (sessionId: string, text: string) => drafts.push({ sessionId, text }),
            onSend: (content: string, invokedSkillVersionIds: readonly string[], mode: 'message' | 'goal', _complete: unknown, media: SentMessage['media']) =>
              sent.push({ content, invokedSkillVersionIds, mode, media })
          })
        )
      )
  })
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.config.globalProperties.$t = translateEnglish
  // Register cleanup before mounting so failed mounts restore the HTTP platform.
  let unmounted = false
  mountedComposers.push(() => {
    if (unmounted) return
    unmounted = true
    app.unmount()
    host.remove()
    if (previousFetch) Object.defineProperty(browserWindow, 'fetch', previousFetch)
    else Reflect.deleteProperty(browserWindow, 'fetch')
  })
  app.mount(host)
  return { roots: Array.from(host.querySelectorAll<HTMLElement>('.agent-composer')), publicRefs, requests, uploads, sent, drafts }
}
const waitForRealSurface = async (ready: () => boolean, description: string): Promise<void> => {
  for (let turn = 0; turn < 100; turn++) {
    await Vue.nextTick()
    if (ready()) return
    // Let actual frame-driven menus, body streams and DOM work settle.
    await new Promise<void>(resolve => browserWindow.requestAnimationFrame(() => resolve()))
  }
  throw new Error(`Real composer did not settle: ${description}`)
}
const selectRealFiles = async (root: HTMLElement, files: readonly File[]): Promise<void> => {
  const input = root.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('Real media file input did not render')
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  input.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
  await yieldEventLoop()
  await Vue.nextTick()
}
const realAttachmentNames = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll('.agent-composer__media-attachments li > span')).map(item => item.textContent?.trim() ?? '')
const openRealAttachmentMenu = async (root: HTMLElement, keyboard = false): Promise<HTMLElement> => {
  const attach = root.querySelector<HTMLButtonElement>('[aria-label="Attach files"]')
  if (!attach) throw new Error('Real Attach action did not render')
  if (keyboard) {
    attach.focus()
    attach.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  } else {
    attach.click()
  }
  await waitForRealSurface(() => Boolean(document.querySelector('.v-overlay--active [aria-label="Attachment source"]')), 'attachment source menu')
  const menu = document.querySelector<HTMLElement>('.v-overlay--active [aria-label="Attachment source"]')
  if (!menu) throw new Error('Real attachment source menu did not open')
  return menu
}
const chooseRealAttachmentSource = async (menu: HTMLElement, title: string): Promise<void> => {
  const item = Array.from(menu.querySelectorAll<HTMLElement>('.v-list-item')).find(
    candidate => candidate.querySelector('.v-list-item-title')?.textContent?.trim() === title
  )
  if (!item) throw new Error(`Real attachment source ${title} did not render`)
  item.click()
  await waitForRealSurface(() => !menu.isConnected, 'attachment source selection closed')
}
const openRealCreationMenu = async (root: HTMLElement): Promise<HTMLElement> => {
  const create = root.querySelector<HTMLButtonElement>('.agent-composer__create')
  if (!create) throw new Error('Real Create action did not render')
  expect(create.disabled).toBe(false)
  create.click()
  await waitForRealSurface(() => Boolean(document.querySelector('.v-overlay--active .agent-composer__tool-menu')), 'creation tools menu')
  const menu = document.querySelector<HTMLElement>('.v-overlay--active .agent-composer__tool-menu')
  if (!menu) throw new Error('Real creation tools menu did not open')
  return menu
}

const makeSkill = (name: string, versionId = `${name}-version`): TestSkill => ({
  id: name,
  versionId,
  name,
  description: `${name} skill`,
  exposureMode: 'owner',
  isAgentDiscoverable: true
})

const makeEvent = (key: string, options: KeyOptions = {}): KeyboardEvent & { wasPrevented: () => boolean } => {
  let prevented = false
  return {
    key,
    shiftKey: options.shiftKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    isComposing: options.isComposing ?? false,
    preventDefault: () => {
      prevented = true
    },
    wasPrevented: () => prevented
  } as KeyboardEvent & { wasPrevented: () => boolean }
}

const loadComposer = (
  options: {
    readonly skills?: readonly TestSkill[]
    readonly preferredSkills?: readonly { skillId: string; versionId: string; sourcePath: string }[]
    readonly invocationLimit?: number
    readonly initialSkillVersionIds?: readonly string[]
    readonly initialMode?: 'message' | 'goal'
    readonly disabled?: boolean
    readonly sending?: boolean
    readonly canStop?: boolean
    readonly draftEditable?: boolean
  } = {}
): ComposerHarness => {
  const props = {
    disabled: options.disabled ?? false,
    sending: options.sending ?? false,
    canStop: options.canStop ?? false,
    draftEditable: options.draftEditable,
    skillsEnabled: true,
    goalsEnabled: true,
    skills: options.skills ?? [makeSkill('docs')],
    skillsLoading: false,
    skillsLoadError: '',
    skillsPartial: false,
    preferredSkills: options.preferredSkills ?? [],
    invocationLimit: options.invocationLimit ?? 3,
    statusLabel: 'Ready',
    statusTone: 'ready' as const,
    initialSkillVersionIds: options.initialSkillVersionIds,
    initialMode: options.initialMode
  }
  const sent: SentMessage[] = []
  const composer = evaluateComposer({
    computed: <T>(getter: () => T): Ref<T> => ({
      get value() {
        return getter()
      }
    }),
    nextTick: (callback?: () => void) => {
      callback?.()
      return Promise.resolve()
    },
    onBeforeUnmount: () => {},
    onMounted: () => {},
    ref: <T>(value: T): Ref<T> => ({ value }),
    useId: testUseId,
    useTemplateRef: <T>(_key: string): Ref<T | null> => ({ value: null }),
    watch: () => {},
    defineProps: () => props,
    defineEmits:
      () =>
      (event: string, ...args: unknown[]) => {
        if (event === 'send') {
          sent.push({
            content: String(args[0]),
            invokedSkillVersionIds: args[1] as readonly string[],
            mode: args[2] as 'message' | 'goal',
            complete: args[3] as (success: boolean) => void,
            media: args[4] as SentMessage['media']
          })
        }
      },
    defineExpose: () => {},
    filterPreferredBuiltInSkills,
    filterSkillsForCommand,
    filterUserSelectableSkills,
    caretBoundsFromMirror,
    calculateComposerSizing,
    scrollTopForCaret,
    window: { getComputedStyle: () => ({}) },
    document: {},
    HTMLElement: FakeElement,
    HTMLTextAreaElement: FakeTextArea
  }) as unknown as ComposerHarness
  return { ...composer, sent }
}
interface MountedComposer {
  readonly root: HTMLElement
  readonly publicRef: Ref<RealComposerPublic | null>
  readonly sent: Array<{ content: string; invokedSkillVersionIds: readonly string[]; mode: 'message' | 'goal' }>
  readonly googleSearchUpdates: boolean[]
  readonly unmount: () => void
}

interface MountedComposerOptions {
  readonly contextControls?: boolean
  readonly disabled?: boolean
  readonly sending?: boolean
  readonly canStop?: boolean
  readonly statusLabel?: string
  readonly statusTone?: 'ready' | 'error' | 'busy'
  readonly initialDraft?: string
  readonly initialMode?: 'message' | 'goal'
  readonly skillsEnabled?: boolean
  readonly mediaCapabilities?: { attachments?: boolean; transcription?: boolean }
  readonly mediaSession?: Record<string, unknown>
  readonly googleSearchAvailable?: boolean
  readonly googleSearchEnabled?: boolean
  readonly draftEditable?: boolean
  readonly networkBlocked?: boolean
}

// Shared media-composer stub state; each test reads/adjusts these through the mounted harness helpers.
let dictationTranscriptHook: () => Promise<string | null> = async () => null
const setDictationTranscriptHook = (hook: () => Promise<string | null>): void => {
  dictationTranscriptHook = hook
}
const recording = Vue.ref(false)
const requesting = Vue.ref(false)
const transcribing = Vue.ref(false)
const seconds = Vue.ref(0)
const dictationIntent = Vue.ref<'insert' | 'send'>('insert')
const generationOptions = Vue.ref([
  { value: 'image', title: 'Images', icon: 'mdi-image-outline' },
  { value: 'video', title: 'Video', icon: 'mdi-movie-open-outline' }
])
const selectedTools = Vue.ref<Array<'image' | 'video' | 'music'>>([])
const markDocument = (name: string): void => {
  ;(document as unknown as { __which: string }).__which = name
}
markDocument('composer-test')
const mountedComposers: Array<() => void> = []
let sentRecorder: Array<{ content: string; invokedSkillVersionIds: readonly string[]; mode: 'message' | 'goal' }> = []
let lastBindings: Record<string, unknown> | null = null
const mountComposer = (options: MountedComposerOptions = {}): MountedComposer => {
  const host = document.createElement('div')
  document.body.append(host)
  const publicRef = Vue.ref<RealComposerPublic | null>(null)
  const componentProps = {
    disabled: options.disabled ?? false,
    sending: options.sending ?? false,
    canStop: options.canStop ?? false,
    skillsEnabled: options.skillsEnabled ?? false,
    goalsEnabled: true,
    generationToolsEnabled: true,
    googleSearchAvailable: options.googleSearchAvailable ?? false,
    googleSearchEnabled: options.googleSearchEnabled ?? false,
    draftEditable: options.draftEditable,
    skills: [],
    skillsLoading: false,
    skillsLoadError: '',
    skillsPartial: false,
    preferredSkills: [],
    invocationLimit: 3,
    statusLabel: options.statusLabel ?? 'Ready',
    statusTone: options.statusTone ?? 'ready',
    initialDraft: options.initialDraft ?? 'draft',
    initialMode: options.initialMode,
    initialSkillVersionIds: undefined,
    hasMessages: false,
    networkBlocked: options.networkBlocked ?? false,
    mediaCapabilities: options.mediaCapabilities,
    mediaSession: options.mediaSession
  }
  const composerComponent = Vue.defineComponent({
    __scopeId: composerScopeAttribute,
    name: 'AgentComposerInteractionHarness',
    props: RealAgentComposer.props,
    emits: ['draftChange', 'compositionChange', 'send', 'stop', 'manageSkills', 'retrySkills', 'updateSkillPreferences', 'mediaSettled', 'updateGoogleSearch'],
    setup(props, { emit, expose }) {
      const bindings = evaluateComposer({
        computed: Vue.computed,
        nextTick: Vue.nextTick,
        onBeforeUnmount: Vue.onBeforeUnmount,
        onMounted: Vue.onMounted,
        ref: Vue.ref,
        useId: Vue.useId,
        useTemplateRef: Vue.useTemplateRef,
        watch: Vue.watch,
        defineProps: () => props,
        defineEmits: () => emit,
        defineExpose: expose,
        filterPreferredBuiltInSkills,
        filterSkillsForCommand,
        filterUserSelectableSkills,
        caretBoundsFromMirror,
        calculateComposerSizing,
        scrollTopForCaret,
        window: browserWindow,
        document: browserWindow.document,
        HTMLElement: browserWindow.HTMLElement,
        HTMLTextAreaElement: browserWindow.HTMLTextAreaElement
      })
      lastBindings = bindings as Record<string, unknown>
      return bindings
    },
    render: renderAgentComposer
  })
  const sentMessages: Array<{ content: string; invokedSkillVersionIds: readonly string[]; mode: 'message' | 'goal' }> = []
  const googleSearchUpdates: boolean[] = []
  sentRecorder = sentMessages
  const app = Vue.createApp({
    name: 'AgentComposerInteractionRoot',
    render: () =>
      Vue.h(
        composerComponent,
        {
          ...componentProps,
          ref: publicRef,
          onUpdateGoogleSearch: (enabled: boolean) => googleSearchUpdates.push(enabled),
          onSend: (content: string, invokedSkillVersionIds: readonly string[], mode: 'message' | 'goal', completion?: (success: boolean) => void) => {
            sentMessages.push({ content, invokedSkillVersionIds, mode })
            completion?.(true)
          }
        },
        options.contextControls ? { 'context-controls': () => Vue.h('span', { class: 'harness-context-chip' }, 'EN · home') } : undefined
      )
  })
  const mediaHarness = Vue.defineComponent({
    name: 'AgentComposerMediaHarness',
    props: ['csrfToken', 'session', 'capabilities', 'generationToolsEnabled', 'disabled', 'networkBlocked'],
    emits: ['change', 'busy', 'dictation', 'settled'],
    template: '<div class="agent-media-composer-harness" />',
    setup(_props, { emit, expose }: { emit: (event: string, value: unknown) => void; expose: (value: unknown) => void }) {
      Vue.watch([recording, transcribing], ([capturing, processing]) => emit('busy', capturing || processing), { flush: 'sync' })
      expose({
        clear: () => undefined,
        addFiles: async () => undefined,
        editImage: async () => false,
        startRecording: async () => {
          recording.value = true
          seconds.value = 0
        },
        stopRecording: () => {
          recording.value = false
        },
        cancelDictation: () => {
          recording.value = false
          transcribing.value = false
          dictationIntent.value = 'insert'
        },
        beginDictationSubmit: () => {
          if (!recording.value) return false
          dictationIntent.value = 'send'
          return true
        },
        waitForDictationTranscript: () => (dictationIntent.value === 'send' ? dictationTranscriptHook() : Promise.resolve(null)),
        toggleGenerationTool: (tool: 'image' | 'video' | 'music') => {
          selectedTools.value = selectedTools.value.includes(tool) ? selectedTools.value.filter(item => item !== tool) : [...selectedTools.value, tool]
        },
        generationOptions,
        selectedGenerationTools: selectedTools,
        recording,
        requesting,
        transcribing,
        seconds,
        dictationIntent
      })
    }
  })
  app.component('AgentComposerMedia', mediaHarness)
  app.component('AgentDictationWaveform', { template: '<canvas class="agent-dictation-waveform" />' })
  app.component('AgentComposerSkillMenu', RealAgentComposerSkillMenu)
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  const root = host.querySelector<HTMLElement>('.agent-composer')
  if (!root) throw new Error('Agent composer did not render')
  const unmount = (): void => {
    app.unmount()
    host.remove()
  }
  mountedComposers.push(unmount)
  return { root, publicRef, sent: sentMessages, googleSearchUpdates, unmount }
}

const press = (composer: ComposerHarness, key: string, options?: KeyOptions): KeyboardEvent & { wasPrevented: () => boolean } => {
  const event = makeEvent(key, options)
  composer.handleKeydown(event)
  return event
}
afterEach(() => {
  for (const unmount of mountedComposers.splice(0)) unmount()
  document.body.replaceChildren()
  recording.value = false
  requesting.value = false
  transcribing.value = false
  seconds.value = 0
  dictationIntent.value = 'insert'
  selectedTools.value = []
  sentRecorder = []
  dictationTranscriptHook = async () => null
})

const settleAsync = async (): Promise<void> => {
  for (let step = 0; step < 8; step++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

describe('Agent composer submit loading presentation', () => {
  it('keeps idle-disabled Send opaque while hiding loading content behind its loader', () => {
    const idle = mountComposer({ disabled: true })
    const idleButton = idle.root.querySelector<HTMLButtonElement>('.agent-composer__submit')
    if (!idleButton) throw new Error('Idle-disabled Send action did not render')
    const idleContent = idleButton.querySelector<HTMLElement>('.v-btn__content')
    if (!idleContent) throw new Error('Idle-disabled Send content did not render')
    expect(idleButton.disabled).toBe(true)
    expect(browserWindow.getComputedStyle(idle.root).opacity).toBe('1')
    expect(browserWindow.getComputedStyle(idleButton).opacity).toBe('1')
    expect(browserWindow.getComputedStyle(idleContent).opacity).toBe('1')

    const loading = mountComposer({ sending: true })
    const loadingButton = loading.root.querySelector<HTMLButtonElement>('.agent-composer__submit')
    if (!loadingButton) throw new Error('Loading Send action did not render')
    const loadingContent = loadingButton.querySelector<HTMLElement>('.v-btn__content')
    const loadingPrepend = loadingButton.querySelector<HTMLElement>('.v-btn__prepend')
    if (!loadingContent || !loadingPrepend) throw new Error('Loading Send content did not render')
    expect(loadingButton.classList.contains('v-btn--loading')).toBe(true)
    expect(loadingButton.querySelector('.v-btn__loader')).not.toBeNull()
    expect(browserWindow.getComputedStyle(loading.root).opacity).toBe('1')
    expect(browserWindow.getComputedStyle(loadingContent).opacity).toBe('0')
    expect(browserWindow.getComputedStyle(loadingPrepend).opacity).toBe('0')

    const idleStatus = idle.root.querySelector<HTMLElement>('.agent-composer__live-status')
    if (!idleStatus) throw new Error('Idle live composer status did not render')
    expect(idleStatus.getAttribute('role')).toBe('status')
    expect(idleStatus.getAttribute('aria-live')).toBe('polite')
    expect(idleStatus.textContent?.trim()).toBe('Ready')

    const loadingStatus = loading.root.querySelector<HTMLElement>('.agent-composer__live-status')
    if (!loadingStatus) throw new Error('Loading live composer status did not render')
    expect(loadingStatus.textContent?.trim()).toBe('Sending')
  })

  it('uses working status instead of a localized ready label during send and streaming', () => {
    const idle = mountComposer({ statusLabel: 'Prêt', statusTone: 'ready' })
    expect(idle.root.querySelector('.agent-composer__live-status')?.textContent?.trim()).toBe('Prêt')
    const sending = mountComposer({ statusLabel: 'Prêt', statusTone: 'ready', sending: true })
    expect(sending.root.querySelector('.agent-composer__live-status')?.textContent?.trim()).toBe('Sending')
    const working = mountComposer({ statusLabel: 'Prêt', statusTone: 'ready', canStop: true })
    expect(working.root.querySelector('.agent-composer__live-status')?.textContent?.trim()).toBe('Working')
    const busy = mountComposer({ statusLabel: 'Recherche en cours', statusTone: 'busy', canStop: true })
    expect(busy.root.querySelector('.agent-composer__live-status')?.textContent?.trim()).toBe('Recherche en cours')
  })

  it('announces external error feedback without relabeling the ordinary Send action', () => {
    const error = mountComposer({ statusLabel: 'Try again', statusTone: 'error' })
    const button = error.root.querySelector<HTMLButtonElement>('.agent-composer__submit')
    const status = error.root.querySelector<HTMLElement>('.agent-composer__live-status')
    if (!button || !status) throw new Error('Error composer controls did not render')

    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(button.textContent?.trim()).toBe('Send')
    expect(button.getAttribute('aria-describedby')).toContain(status.id)
    expect(status.textContent?.trim()).toBe('Try again')
  })
})

describe('Agent composer slash-command keyboard gates', () => {
  it('submits a no-match command literally and keeps Tab native', () => {
    const composer = loadComposer({ skills: [makeSkill('docs')] })
    composer.draft.value = '/unknown'

    const tab = press(composer, 'Tab')
    expect(tab.wasPrevented()).toBe(false)
    expect(composer.sent).toHaveLength(0)

    const enter = press(composer, 'Enter')
    expect(enter.wasPrevented()).toBe(true)
    expect(composer.sent.map(message => message.content)).toEqual(['/unknown'])
  })

  it('submits a disabled preferred result literally without assigning an active option', () => {
    const skill = makeSkill('docs')
    const composer = loadComposer({
      skills: [skill],
      preferredSkills: [{ skillId: skill.id, versionId: skill.versionId, sourcePath: 'built-in/docs' }]
    })
    composer.draft.value = '/docs'

    expect(composer.activeCommandSkill.value).toBeNull()
    expect(composer.activeCommandOptionId.value).toBeUndefined()
    expect(press(composer, 'Tab').wasPrevented()).toBe(false)
    expect(composer.sent).toHaveLength(0)

    press(composer, 'Enter')
    expect(composer.sent.map(message => message.content)).toEqual(['/docs'])
  })

  it('submits a command literally when the invocation limit disables every result', () => {
    const composer = loadComposer({
      skills: [makeSkill('docs'), makeSkill('code')],
      invocationLimit: 1,
      initialSkillVersionIds: ['already-selected-version']
    })
    composer.draft.value = '/'

    expect(composer.activeCommandSkill.value).toBeNull()
    expect(composer.activeCommandOptionId.value).toBeUndefined()
    expect(press(composer, 'Tab').wasPrevented()).toBe(false)
    expect(composer.sent).toHaveLength(0)

    const enter = press(composer, 'Enter')
    expect(enter.wasPrevented()).toBe(true)
    expect(composer.sent.map(message => message.content)).toEqual(['/'])
  })

  it('accepts a usable active suggestion without sending and preserves surrounding whitespace', () => {
    const composer = loadComposer({ skills: [makeSkill('docs')] })
    composer.draft.value = 'Explain /docs'

    const enter = press(composer, 'Enter')
    expect(enter.wasPrevented()).toBe(true)
    expect(composer.sent).toHaveLength(0)
    expect(composer.draft.value).toBe('Explain ')
    expect(composer.selectedSkillIds.value).toEqual(['docs-version'])
  })

  it('uses an explicit submit to send the literal draft even while a suggestion is open', () => {
    const composer = loadComposer({ initialMode: 'goal', initialSkillVersionIds: ['docs-version'] })
    composer.draft.value = '/docs'

    composer.submit()
    expect(composer.sent).toHaveLength(1)
    expect(composer.sent[0].content).toBe('/docs')
    expect(composer.sent[0].invokedSkillVersionIds).toEqual(['docs-version'])
    expect(composer.sent[0].mode).toBe('goal')
  })

  it('keeps Shift+Tab and Shift+Enter native, while Ctrl and Meta Enter send', () => {
    const shiftTabComposer = loadComposer()
    shiftTabComposer.draft.value = '/docs'
    expect(press(shiftTabComposer, 'Tab', { shiftKey: true }).wasPrevented()).toBe(false)
    expect(shiftTabComposer.sent).toHaveLength(0)

    const shiftEnterComposer = loadComposer()
    shiftEnterComposer.draft.value = '/docs'
    expect(press(shiftEnterComposer, 'Enter', { shiftKey: true }).wasPrevented()).toBe(false)
    expect(shiftEnterComposer.sent).toHaveLength(0)

    const ctrlEnterComposer = loadComposer()
    ctrlEnterComposer.draft.value = '/docs'
    expect(press(ctrlEnterComposer, 'Enter', { ctrlKey: true }).wasPrevented()).toBe(true)
    expect(ctrlEnterComposer.sent).toHaveLength(1)
    expect(ctrlEnterComposer.sent[0].content).toBe('/docs')

    const metaEnterComposer = loadComposer()
    metaEnterComposer.draft.value = '/docs'
    expect(press(metaEnterComposer, 'Enter', { metaKey: true }).wasPrevented()).toBe(true)
    expect(metaEnterComposer.sent).toHaveLength(1)
    expect(metaEnterComposer.sent[0].content).toBe('/docs')
  })

  it('keeps busy editable Enter native and restores desktop sending after work settles', () => {
    const busy = loadComposer({ disabled: true, sending: true, canStop: true, draftEditable: true })
    busy.draft.value = 'Keep editing'
    expect(press(busy, 'Enter').wasPrevented()).toBe(false)
    expect(press(busy, 'Enter', { ctrlKey: true }).wasPrevented()).toBe(true)
    expect(busy.sent).toHaveLength(0)
    expect(busy.draft.value).toBe('Keep editing')

    const ready = loadComposer({ draftEditable: true })
    ready.draft.value = 'Ready to send'
    expect(press(ready, 'Enter').wasPrevented()).toBe(true)
    expect(ready.sent.map(message => message.content)).toEqual(['Ready to send'])
  })

  it('allows coarse input new lines without intercepting IME and keeps explicit sending', () => {
    const composer = loadComposer()
    composer.coarseInput.value = true
    composer.draft.value = '/docs'
    expect(press(composer, 'Enter').wasPrevented()).toBe(false)
    expect(press(composer, 'Enter', { isComposing: true }).wasPrevented()).toBe(false)
    expect(composer.selectedSkillIds.value).toEqual([])
    expect(composer.sent).toHaveLength(0)
    composer.submit()
    expect(composer.sent.map(message => message.content)).toEqual(['/docs'])

    const shortcut = loadComposer()
    shortcut.coarseInput.value = true
    shortcut.draft.value = 'Send with shortcut'
    press(shortcut, 'Enter', { metaKey: true })
    expect(shortcut.sent.map(message => message.content)).toEqual(['Send with shortcut'])
  })

  it('leaves IME composition untouched and Escape dismisses only the command token', () => {
    const composing = loadComposer()
    composing.draft.value = '/docs'
    expect(press(composing, 'Enter', { isComposing: true }).wasPrevented()).toBe(false)
    expect(composing.sent).toHaveLength(0)

    const dismissed = loadComposer()
    dismissed.draft.value = 'Keep this /docs'
    const escapeEvent = press(dismissed, 'Escape')
    expect(escapeEvent.wasPrevented()).toBe(true)
    expect(dismissed.draft.value).toBe('Keep this /docs')
    expect(dismissed.skillCommandOpen.value).toBe(false)
  })
})

describe('Agent composer send admission', () => {
  it('sends an attachment-only message with its selected generation tools', () => {
    const composer = loadComposer()
    composer.mediaSubmission.value = { attachmentIds: ['owned-image'], generationTools: ['image', 'video'] }
    composer.submit()
    expect(composer.sent).toHaveLength(1)
    expect(composer.sent[0]?.content).toBe('')
    expect(composer.sent[0]?.media).toEqual({ attachmentIds: ['owned-image'], generationTools: ['image', 'video'] })
  })
  it('blocks send while media is uploading or dictation is pending', () => {
    const composer = loadComposer()
    composer.draft.value = 'Please examine the upload'
    composer.mediaBusy.value = true
    composer.submit()
    expect(composer.sent).toHaveLength(0)
  })

  it('does not submit a non-empty draft while the composer is disabled', () => {
    const disabled = loadComposer({ disabled: true })
    disabled.draft.value = 'keep this draft'

    disabled.submit()

    expect(disabled.sent).toHaveLength(0)
    expect(disabled.draft.value).toBe('keep this draft')
  })
})

describe('Real Agent composer slash boundaries', () => {
  it('preserves a documentation path in the draft and submission without selecting a skill', async () => {
    const mounted = mountRealComposers([{ skills: [makeSkill('release-notes')] }])
    const root = mounted.roots[0]
    const textarea = root?.querySelector<HTMLTextAreaElement>('textarea')
    if (!root || !textarea) throw new Error('Real composer textbox did not render')
    const draft = 'Explain docs/release-notes'
    textarea.value = draft
    textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await Vue.nextTick()

    expect(textarea.value).toBe(draft)
    expect(mounted.drafts.at(-1)).toEqual({ sessionId: realSessionId, text: draft })
    expect(root.querySelector('.agent-composer__command-menu')).toBeNull()
    expect(textarea.hasAttribute('aria-activedescendant')).toBe(false)
    expect(root.querySelector('[aria-label="Skills attached as context for the next message"]')).toBeNull()
    textarea.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await Vue.nextTick()
    expect(mounted.sent).toEqual([
      expect.objectContaining({
        content: 'Explain docs/release-notes',
        invokedSkillVersionIds: [],
        mode: 'message'
      })
    ])
  })

  it('accepts a whitespace-delimited slash command while preserving the preceding draft', async () => {
    const mounted = mountRealComposers([{ skills: [makeSkill('release-notes')] }])
    const root = mounted.roots[0]
    const textarea = root?.querySelector<HTMLTextAreaElement>('textarea')
    const submit = root?.querySelector<HTMLButtonElement>('.agent-composer__submit')
    if (!root || !textarea || !submit) throw new Error('Real composer controls did not render')
    textarea.value = 'Explain /release-notes'
    textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await Vue.nextTick()
    const activeId = textarea.getAttribute('aria-activedescendant')
    expect(root.querySelector('.agent-composer__command-menu')).not.toBeNull()
    expect(activeId && root.querySelector(`[id="${activeId}"]`)?.textContent).toContain('release-notes')

    textarea.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await Vue.nextTick()
    expect(textarea.value).toBe('Explain ')
    expect(mounted.drafts.at(-1)).toEqual({ sessionId: realSessionId, text: 'Explain ' })
    expect(root.querySelector('[aria-label="Skills attached as context for the next message"]')?.textContent).toContain('release-notes')
    expect(mounted.sent).toEqual([])
    submit.click()
    await Vue.nextTick()
    expect(mounted.sent).toEqual([
      expect.objectContaining({
        content: 'Explain ',
        invokedSkillVersionIds: ['release-notes-version'],
        mode: 'message'
      })
    ])
  })
})

describe('Agent composer instance accessibility', () => {
  it('keeps option IDs and descriptions distinct across instances', async () => {
    const mounted = mountRealComposers([{ skills: [makeSkill('docs')] }, { skills: [makeSkill('docs')] }])
    const optionIds: string[] = []
    const descriptionIds: string[] = []
    for (const root of mounted.roots) {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea')
      if (!textarea) throw new Error('Real composer textarea did not render')
      textarea.value = '/docs'
      textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
      await Vue.nextTick()
      const optionId = textarea.getAttribute('aria-activedescendant')
      if (!optionId) throw new Error('Real command active descendant did not render')
      const option = document.getElementById(optionId)
      expect(root.contains(option)).toBe(true)
      expect(option?.getAttribute('role')).toBe('option')
      expect(option?.textContent).toContain('docs')
      optionIds.push(optionId)
      const ids = textarea.getAttribute('aria-describedby')?.split(/\s+/) ?? []
      if (!ids.length) throw new Error('Real textarea description was not associated')
      for (const id of ids) expect(root.contains(document.getElementById(id))).toBe(true)
      descriptionIds.push(...ids)
      const submit = root.querySelector<HTMLButtonElement>('.agent-composer__submit')
      const statusId = submit?.getAttribute('aria-describedby')
      if (!statusId) throw new Error('Real Send status was not associated')
      expect(root.contains(document.getElementById(statusId))).toBe(true)
    }
    expect(optionIds[0]).not.toBe(optionIds[1])
    expect(new Set(descriptionIds).size).toBe(descriptionIds.length)
  })
})

describe('Agent composer three-section layout', () => {
  it('renders one context row, one editor, and one action row with the microphone beside Send', async () => {
    const mounted = mountComposer({ initialDraft: '', mediaCapabilities: { attachments: true, transcription: true } })
    const root = mounted.root
    const context = root.querySelector<HTMLElement>('.agent-composer__context-controls')
    const actions = root.querySelector<HTMLElement>('.agent-composer__actions')
    const primary = root.querySelector<HTMLElement>('.agent-composer__primary-actions')
    const editor = root.querySelector<HTMLElement>('.agent-composer__editor')
    const submit = root.querySelector<HTMLButtonElement>('.agent-composer__submit')
    const mic = root.querySelector<HTMLButtonElement>('.agent-composer__mic')
    if (!context || !actions || !primary || !editor || !submit || !mic) throw new Error('Three-section composer did not render')

    expect(actions.contains(context)).toBe(true)
    expect(actions.contains(primary)).toBe(true)
    expect(primary.contains(mic)).toBe(true)
    expect(primary.contains(submit)).toBe(true)
    // The source context row sits above the editor, outside the action bar.
    const contextRow = root.querySelector<HTMLElement>('.agent-composer__context-row')
    if (!contextRow) throw new Error('Source context row did not render')
    expect(contextRow.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(actions.contains(contextRow)).toBe(false)
    // Without skills and with nothing folded, the More menu has no content.
    const more = root.querySelector<HTMLButtonElement>('.agent-composer__more-button')
    expect(more).toBeNull()
    const webToggle = root.querySelector<HTMLElement>('.agent-composer__web-search-toggle')
    if (!webToggle) throw new Error('Web toggle did not render')
    // Goal sits between the Web toggle and the action group's end.
    const goalToggle = root.querySelector<HTMLElement>('.agent-composer__goal-toggle')
    if (!goalToggle) throw new Error('Goal toggle did not render')
    expect(webToggle.compareDocumentPosition(goalToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The microphone sits immediately before Send in the action row.
    expect(mic.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(mic.getAttribute('aria-label')).toBe('Start dictation')
    expect(submit.textContent?.trim()).toBe('Send')
    await Vue.nextTick()
    const attach = root.querySelector<HTMLButtonElement>('.agent-composer__attach')
    const create = root.querySelector<HTMLButtonElement>('.agent-composer__create')
    expect(attach?.getAttribute('aria-label')).toBe('Attach files')
    expect(create?.textContent).toContain('Create')
  })

  it('labels the Create control without a count and consumes real upload and Wiki asset sources', async () => {
    const mounted = mountRealComposers([{ media: true, imageGeneration: true }])
    const root = mounted.roots[0]
    await Vue.nextTick()
    const create = root.querySelector<HTMLButtonElement>('.agent-composer__create')
    if (!create) throw new Error('Create control did not render')
    expect(create.textContent?.trim()).toBe('Create')
    expect(create.getAttribute('data-state')).toBe('selected')
    expect(mounted.publicRefs[0].value?.hasUnsentMedia()).toBe(false)
    expect(mounted.publicRefs[0].value?.isMediaBusy()).toBe(false)
    const menu = await openRealAttachmentMenu(root)
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error('Upload input did not render')
    let dialogOpened = false
    // Browser platform boundary: the native file chooser cannot open in JSDOM.
    input.addEventListener('click', () => {
      dialogOpened = true
    })
    await chooseRealAttachmentSource(menu, 'Upload files')
    expect(dialogOpened).toBe(true)
    await selectRealFiles(root, [new File(['%PDF-1.4\nreference\n%%EOF\n'], 'reference.pdf', { type: 'application/pdf' })])
    await waitForRealSurface(
      () => realAttachmentNames(root).includes('reference.pdf') && root.querySelector<HTMLButtonElement>('[aria-label="Attach files"]')?.disabled === false,
      'settled reference upload'
    )
    expect(realAttachmentNames(root)).toEqual(['reference.pdf'])
    expect(mounted.requests.filter(request => request.method === 'POST')).toEqual([
      { path: `/_api/agents/sessions/${realSessionId}/media`, method: 'POST', credentials: 'same-origin', csrf: 'csrf' }
    ])
    await chooseRealAttachmentSource(await openRealAttachmentMenu(root, true), 'Browse Wiki assets')
    await waitForRealSurface(() => document.querySelector('[aria-label="Search filenames in this folder"]') !== null, 'real Wiki asset picker')
    const pickerInput = document.querySelector<HTMLInputElement>('[aria-label="Search filenames in this folder"]')
    const picker = pickerInput?.closest('[role="dialog"]')
    expect(picker?.getAttribute('aria-label')).toBe('Browse Wiki assets')
    expect(picker?.getAttribute('aria-modal')).toBe('true')
    expect(picker?.classList.contains('v-overlay--active')).toBe(true)
    expect(mounted.requests.filter(request => request.path.startsWith('/_api/assets')).map(request => request.path)).toEqual([
      '/_api/assets',
      '/_api/assets/folders'
    ])
  })

  it('changes real generation preferences without attachment support or uploads', async () => {
    const mounted = mountRealComposers([
      {
        media: true,
        attachments: false,
        imageGeneration: true,
        videoGeneration: true,
        musicGeneration: true
      }
    ])
    const root = mounted.roots[0]
    await Vue.nextTick()
    expect(root.querySelector('.agent-composer__attach')).toBeNull()
    expect(root.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true)
    expect(root.querySelector('.sr-only[id$="-attachment-reason"]')?.textContent).toBe(translateEnglish('common:agentComposer.attachmentsUnsupported'))
    const menu = await openRealCreationMenu(root)
    const options = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
    expect(options.map(option => option.querySelector('.v-list-item-title')?.textContent?.trim())).toEqual([
      translateEnglish('common:agentComposerMedia.images'),
      translateEnglish('common:agentComposerMedia.video'),
      translateEnglish('common:agentComposerMedia.music')
    ])
    for (const option of options) {
      expect(option.getAttribute('aria-disabled')).not.toBe('true')
      expect(option.getAttribute('aria-checked')).toBe('true')
    }
    options[1].click()
    await waitForRealSurface(() => !menu.isConnected, 'generation preference menu closed')
    const textarea = root.querySelector<HTMLTextAreaElement>('textarea')
    if (!textarea) throw new Error('Real composer textbox did not render')
    textarea.value = 'Create an image with accompanying music'
    textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await Vue.nextTick()
    root.querySelector<HTMLButtonElement>('.agent-composer__submit')?.click()
    await Vue.nextTick()
    expect(mounted.sent).toEqual([
      {
        content: 'Create an image with accompanying music',
        invokedSkillVersionIds: [],
        mode: 'message',
        media: { attachmentIds: [], generationTools: ['image', 'music'] }
      }
    ])
    expect(mounted.uploads).toEqual([])
    expect(mounted.requests).toEqual([])
  })

  it('keeps real generation preferences operable at four attachments while rejecting a fifth', async () => {
    const mounted = mountRealComposers([{ media: true, imageGeneration: true }])
    const root = mounted.roots[0]
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input?.disabled).toBe(false)
    const files = ['one.pdf', 'two.pdf', 'three.pdf', 'four.pdf'].map(
      filename => new File([`%PDF-1.4\n${filename}\n%%EOF\n`], filename, { type: 'application/pdf' })
    )
    await selectRealFiles(root, files)
    await waitForRealSurface(
      () => realAttachmentNames(root).length === 4 && root.querySelector<HTMLButtonElement>('.agent-composer__submit')?.disabled === false,
      'four settled uploads'
    )
    expect(realAttachmentNames(root)).toEqual(files.map(file => file.name))
    expect(mounted.uploads.map(upload => upload.filename)).toEqual(files.map(file => file.name))
    const attach = root.querySelector<HTMLButtonElement>('[aria-label="Attach files"]')
    expect(attach?.disabled).toBe(true)
    expect(input?.disabled).toBe(true)
    expect(root.querySelector('.agent-composer__attachment-count')?.textContent?.trim()).toBe('4/4')
    const reasonId = attach?.getAttribute('aria-describedby')
    expect(reasonId ? document.getElementById(reasonId)?.textContent : '').toBe(translateEnglish('common:agentComposer.attachmentsFull'))
    attach?.click()
    await Vue.nextTick()
    expect(document.querySelector('.v-overlay--active [aria-label="Attachment source"]')).toBeNull()
    const creationMenu = await openRealCreationMenu(root)
    const imageOption = creationMenu.querySelector<HTMLElement>('[role="menuitemcheckbox"]')
    if (!imageOption) throw new Error('Image generation option did not render at attachment capacity')
    expect(imageOption.getAttribute('aria-disabled')).not.toBe('true')
    expect(imageOption.getAttribute('aria-checked')).toBe('true')
    imageOption.click()
    await waitForRealSurface(() => !creationMenu.isConnected, 'full-capacity generation preference selection')
    expect(root.querySelector('.agent-composer__create')?.getAttribute('data-state')).toBeNull()
    expect(mounted.uploads).toHaveLength(4)
    await selectRealFiles(root, [new File(['%PDF-1.4\nfifth\n%%EOF\n'], 'five.pdf', { type: 'application/pdf' })])
    await waitForRealSurface(
      () => root.querySelector('[role="alert"]') !== null || realAttachmentNames(root).includes('five.pdf'),
      'fifth file admission result'
    )
    expect(realAttachmentNames(root)).toEqual(files.map(file => file.name))
    expect(mounted.uploads.map(upload => upload.filename)).toEqual(files.map(file => file.name))
    expect(root.querySelector('[role="alert"]')).not.toBeNull()
    const remove = root.querySelector<HTMLButtonElement>('[aria-label="Remove two.pdf"]')
    if (!remove) throw new Error('The second ready attachment cannot be removed')
    expect(remove.disabled).toBe(false)
    remove.click()
    await waitForRealSurface(() => realAttachmentNames(root).length === 3, 'selected attachment removal')
    expect(realAttachmentNames(root)).toEqual(['one.pdf', 'three.pdf', 'four.pdf'])
    expect(mounted.requests.filter(request => request.method === 'DELETE').map(request => request.path)).toEqual([
      '/_api/agents/media/00000000-0000-4000-8000-000000000101'
    ])
    expect(attach?.disabled).toBe(false)
    expect(input?.disabled).toBe(false)
    expect(root.querySelector('.agent-composer__attachment-count')?.textContent?.trim()).toBe('3/4')
  })

  it('preserves native text paste and blocks unavailable file navigation with a reason', async () => {
    for (const option of [{ media: false }, { media: true, noSession: true }, { media: true, networkBlocked: true }]) {
      const mounted = mountRealComposers([option])
      const root = mounted.roots[0]
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea')
      if (!textarea) throw new Error('Composer textarea did not render')
      textarea.value = 'Do not lose this draft'
      textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
      await Vue.nextTick()
      const paste = new browserWindow.Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(paste, 'clipboardData', { value: { files: [], getData: () => 'ordinary text' } })
      textarea.dispatchEvent(paste)
      expect(paste.defaultPrevented).toBe(false)
      const file = new File(['%PDF-1.4\nreport\n%%EOF\n'], 'report.pdf', { type: 'application/pdf' })
      const drag = new browserWindow.Event('dragover', { bubbles: true, cancelable: true })
      Object.defineProperty(drag, 'dataTransfer', { value: { types: ['Files'] } })
      textarea.dispatchEvent(drag)
      expect(drag.defaultPrevented).toBe(true)
      const drop = new browserWindow.Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], types: ['Files'] } })
      textarea.dispatchEvent(drop)
      expect(drop.defaultPrevented).toBe(true)
      await Vue.nextTick()
      const key = !option.media
        ? 'common:agentComposer.attachmentsUnsupported'
        : 'noSession' in option
          ? 'common:agentComposer.attachmentsNeedSession'
          : 'common:agentComposer.attachmentsOffline'
      expect(root.querySelector('[role="alert"]')?.textContent).toBe(translateEnglish(key))
      expect(textarea.value).toBe('Do not lose this draft')
      expect(mounted.uploads).toEqual([])
      const filePaste = new browserWindow.Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(filePaste, 'clipboardData', { value: { files: [file], getData: () => '' } })
      textarea.dispatchEvent(filePaste)
      expect(filePaste.defaultPrevented).toBe(true)
      await Vue.nextTick()
      expect(textarea.value).toBe('Do not lose this draft')
      expect(root.querySelector('[role="alert"]')?.textContent).toBe(translateEnglish(key))
      const mixedPaste = new browserWindow.Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(mixedPaste, 'clipboardData', { value: { files: [file], getData: () => ' and pasted text' } })
      textarea.dispatchEvent(mixedPaste)
      expect(mixedPaste.defaultPrevented).toBe(false)
      // Native insertion follows the paste event; jsdom does not perform that default action.
      textarea.value = 'Do not lose this draft and pasted text'
      textarea.dispatchEvent(new browserWindow.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: ' and pasted text' }))
      await Vue.nextTick()
      expect(textarea.value).toBe('Do not lose this draft and pasted text')
      expect(root.querySelector('[role="alert"]')?.textContent).toBe(translateEnglish(key))
      expect(mounted.uploads).toEqual([])
    }
  })

  it('explains invocation limits in the real slash list and skills card without selecting', async () => {
    const mounted = mountRealComposers([{ skills: [makeSkill('docs')], invocationLimit: 0 }])
    const root = mounted.roots[0]
    const textarea = root.querySelector<HTMLTextAreaElement>('textarea')
    if (!textarea) throw new Error('Composer textarea did not render')
    textarea.value = '/'
    textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await Vue.nextTick()
    const reason = translateEnglish('common:agentComposerSkillMenu.youHaveMaximum8')
    const option = root.querySelector<HTMLElement>('[role="option"]')
    expect(option?.getAttribute('aria-disabled')).toBe('true')
    expect(option?.textContent).toContain(reason)
    expect(root.querySelector('.agent-composer__command-limit')?.textContent).toBe(reason)
    option?.click()
    await Vue.nextTick()
    expect(mounted.sent).toEqual([])
    expect(textarea.value).toBe('/')
    root.querySelector<HTMLButtonElement>('.agent-composer__more-button')?.click()
    await waitForRealSurface(() => Boolean(document.querySelector('.v-overlay--active .agent-composer__more-menu')), 'More menu')
    const skills = Array.from(document.querySelectorAll<HTMLElement>('.agent-composer__more-menu .v-list-item')).find(item =>
      item.textContent?.includes('Skills')
    )
    skills?.click()
    await waitForRealSurface(() => Boolean(document.querySelector('.agent-composer-skill-menu__card')), 'Skills card')
    const card = document.querySelector<HTMLElement>('.agent-composer-skill-menu__card')
    expect(card?.textContent).toContain(reason)
    expect(card?.querySelector('input[type="checkbox"]')?.hasAttribute('disabled')).toBe(true)
  })

  it('re-attaches stored bytes through the real parent public action as fresh pending media', async () => {
    const mounted = mountRealComposers([{ media: true }])
    const root = mounted.roots[0]
    await Vue.nextTick()
    const parent = mounted.publicRefs[0].value
    if (!parent) throw new Error('Real parent public ref was not mounted')
    expect(parent.hasUnsentMedia()).toBe(false)
    expect(parent.isMediaBusy()).toBe(false)
    expect(await parent.reattachMedia(storedPdf)).toBe(true)
    await Vue.nextTick()
    expect(parent.hasUnsentMedia()).toBe(true)
    expect(parent.isMediaBusy()).toBe(false)
    expect(mounted.requests).toEqual([
      { path: `/_api/agents/media/${storedPdf.id}/content`, method: 'GET', credentials: 'same-origin', csrf: null },
      { path: `/_api/agents/sessions/${realSessionId}/media`, method: 'POST', credentials: 'same-origin', csrf: 'csrf' }
    ])
    expect(mounted.uploads).toEqual([{ id: '00000000-0000-4000-8000-000000000100', filename: 'report.pdf', type: 'application/pdf', bytes: storedPdfBytes }])
    expect(realAttachmentNames(root)).toEqual(['report.pdf'])
    expect(root.querySelector('[role="alert"]')).toBeNull()
    root.querySelector<HTMLButtonElement>('.agent-composer__submit')?.click()
    await settleAsync()
    await waitForRealSurface(() => mounted.sent.length !== 0, 'attachment-only message submission')
    expect(mounted.sent).toEqual([
      expect.objectContaining({ content: '', media: { attachmentIds: ['00000000-0000-4000-8000-000000000100'], generationTools: [] } })
    ])
  })

  it('labels the Web toggle and announces its unchecked Google Search preference', () => {
    const mounted = mountComposer({ initialDraft: '', googleSearchAvailable: true })
    const toggle = mounted.root.querySelector<HTMLLabelElement>('.agent-composer__web-search-toggle')
    if (!toggle) throw new Error('Web toggle did not render')
    expect(toggle.textContent?.trim()).toBe('Web')
    expect(toggle.querySelector('input')?.getAttribute('aria-label')).toBe('Use Google Search for this conversation')
    // No native title: touch and keyboard users get the same disclosure through aria-describedby.
    expect(toggle.hasAttribute('title')).toBe(false)
    const noticeId = toggle.querySelector('input')?.getAttribute('aria-describedby')
    const notice = noticeId ? mounted.root.querySelector<HTMLElement>(`[id="${noticeId}"]`) : null
    expect(notice?.textContent).toContain('Google Search')
    expect(notice?.textContent).toContain('charges')
    expect(notice?.textContent).toContain('Enable Web')
    expect(notice?.textContent).not.toContain('Web search is on')
    if (!notice) throw new Error('Unchecked Web description did not render')
    const style = browserWindow.getComputedStyle(notice)
    expect(style.position).toBe('absolute')
    expect(style.width).toBe('1px')
    expect(style.height).toBe('1px')
    expect(style.overflow).toBe('hidden')
    // Color-independent state attribute for the off state is absent; the checkbox aria-checked carries state.
    expect(toggle.querySelector('input')?.getAttribute('aria-checked')).toBe('false')
  })

  it('shows the Web cost and privacy notice while Google Search is on', () => {
    const mounted = mountComposer({ initialDraft: '', googleSearchAvailable: true, googleSearchEnabled: true })
    const input = mounted.root.querySelector<HTMLInputElement>('.agent-composer__web-search-toggle input')
    const notice = mounted.root.querySelector<HTMLElement>('.agent-composer__web-notice')
    expect(input?.getAttribute('aria-describedby')).toBe(notice?.id)
    if (!notice) throw new Error('Enabled Web notice did not render')
    expect(browserWindow.getComputedStyle(notice).position).not.toBe('absolute')
    expect(notice?.getAttribute('role')).toBe('note')
    expect(notice?.textContent).toContain('Search has its own charges')
    expect(notice.textContent).toContain('Web search is on')
  })

  it('blocks offline inline and folded Web changes but allows connected changes', async () => {
    for (const enabled of [false, true]) {
      const mounted = mountComposer({ googleSearchAvailable: true, googleSearchEnabled: enabled, networkBlocked: true })
      const input = mounted.root.querySelector<HTMLInputElement>('.agent-composer__web-search-toggle input')
      if (!input) throw new Error('Offline Web checkbox did not render')
      expect(input.disabled).toBe(true)
      input.checked = !enabled
      input.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
      await Vue.nextTick()
      expect(mounted.googleSearchUpdates).toEqual([])
      expect(input.checked).toBe(enabled)
      expect(input.getAttribute('aria-checked')).toBe(String(enabled))
      const bindings = lastBindings as unknown as {
        foldedControls: { value: string[] }
        moreMenuOpen: { value: boolean }
      }
      bindings.foldedControls.value = ['web']
      bindings.moreMenuOpen.value = true
      await Vue.nextTick()
      await Vue.nextTick()
      const menu = Array.from(document.body.querySelectorAll<HTMLElement>('.agent-composer__more-menu')).pop()
      const webItem = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? []).find(
        item => item.querySelector('.v-list-item-title')?.textContent?.trim() === 'Web'
      )
      if (!webItem) throw new Error('Offline folded Web action did not render')
      expect(webItem.getAttribute('aria-disabled')).toBe('true')
      webItem.click()
      await Vue.nextTick()
      expect(mounted.googleSearchUpdates).toEqual([])
      expect(webItem.getAttribute('aria-checked')).toBe(String(enabled))
      bindings.moreMenuOpen.value = false
      await Vue.nextTick()
    }
    const connected = mountComposer({ googleSearchAvailable: true })
    const input = connected.root.querySelector<HTMLInputElement>('.agent-composer__web-search-toggle input')
    if (!input) throw new Error('Connected Web checkbox did not render')
    expect(input.disabled).toBe(false)
    input.checked = true
    input.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
    await Vue.nextTick()
    expect(connected.googleSearchUpdates).toEqual([true])
    const bindings = lastBindings as unknown as {
      foldedControls: { value: string[] }
      moreMenuOpen: { value: boolean }
    }
    bindings.foldedControls.value = ['web']
    bindings.moreMenuOpen.value = true
    await Vue.nextTick()
    await Vue.nextTick()
    const menu = Array.from(document.body.querySelectorAll<HTMLElement>('.agent-composer__more-menu')).pop()
    const webItem = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? []).find(
      item => item.querySelector('.v-list-item-title')?.textContent?.trim() === 'Web'
    )
    if (!webItem) throw new Error('Connected folded Web action did not render')
    expect(webItem.getAttribute('aria-disabled')).not.toBe('true')
    webItem.click()
    await Vue.nextTick()
    expect(connected.googleSearchUpdates).toEqual([true, true])
    bindings.moreMenuOpen.value = false
    await Vue.nextTick()
  })

  it('keeps the message field editable while a reply streams but does not submit', async () => {
    const mounted = mountComposer({ initialDraft: 'next question', sending: true, canStop: true, draftEditable: true })
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('textarea')
    expect(textarea?.disabled).toBe(false)
    textarea?.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await Vue.nextTick()
    expect(mounted.sent).toEqual([])
    const idle = mountComposer({ initialDraft: 'next question', sending: true, canStop: true })
    expect(idle.root.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true)
  })

  it('keeps Goal and Web inline alongside More when Skills are available', () => {
    const mounted = mountComposer({ initialDraft: '', skillsEnabled: true })
    const context = mounted.root.querySelector<HTMLElement>('.agent-composer__context-controls')
    const goalToggle = mounted.root.querySelector<HTMLElement>('.agent-composer__goal-toggle')
    const webToggle = mounted.root.querySelector<HTMLElement>('.agent-composer__web-search-toggle')
    const more = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__more-button')
    expect(context).not.toBeNull()
    expect(goalToggle).not.toBeNull()
    expect(webToggle).not.toBeNull()
    expect(more).not.toBeNull()
    expect(context?.contains(goalToggle ?? null)).toBe(true)
    expect(context?.contains(webToggle ?? null)).toBe(true)
    expect(context?.contains(more ?? null)).toBe(true)
  })

  it('renders the source context slot and the goal chip in the top context row', async () => {
    const mounted = mountComposer({ initialDraft: '', initialMode: 'goal', contextControls: true })
    const row = mounted.root.querySelector<HTMLElement>('.agent-composer__context-row')
    const editor = mounted.root.querySelector<HTMLElement>('.agent-composer__editor')
    const actions = mounted.root.querySelector<HTMLElement>('.agent-composer__actions')
    if (!row || !editor || !actions) throw new Error('Composer sections did not render')
    expect(row.querySelector('.harness-context-chip')).not.toBeNull()
    expect(row.querySelector('.agent-composer__goal-chip')).not.toBeNull()
    expect(row.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The source context moved out of the action bar entirely.
    expect(actions.querySelector('.harness-context-chip')).toBeNull()
    expect(actions.querySelector('.agent-composer__goal-chip')).toBeNull()
  })
})

describe('Agent composer fit-based folding', () => {
  interface FoldHarness {
    readonly foldedControls: { value: string[] }
    readonly foldMeasureOverride: { value: (() => boolean) | null }
    readonly updateFoldState: () => Promise<void>
  }

  const asFoldHarness = (composer: unknown): FoldHarness => {
    const harness = composer as unknown as FoldHarness
    if (!harness.foldedControls || !harness.foldMeasureOverride || !harness.updateFoldState) throw new Error('Fold state was not exposed by the composer')
    return harness
  }

  it('folds Create, then Web until the left control group fits', async () => {
    const fold = asFoldHarness(loadComposer())
    // The stub measure models a row that only fits once two controls are folded.
    fold.foldMeasureOverride.value = () => fold.foldedControls.value.length < 2
    await fold.updateFoldState()
    expect(fold.foldedControls.value).toEqual(['create', 'web'])
  })

  it('never folds past the foldable set, protecting Attach, mic, and Send', async () => {
    const fold = asFoldHarness(loadComposer())
    fold.foldMeasureOverride.value = () => true
    await fold.updateFoldState()
    expect(fold.foldedControls.value).toEqual(['create', 'web', 'goal'])
  })

  it('unfolds the last folded control in reverse order when space returns', async () => {
    const fold = asFoldHarness(loadComposer())
    fold.foldedControls.value = ['create', 'web']
    // The stub only overflows once the group is empty: restoring Create (the
    // second control) overflows again and stays folded.
    fold.foldMeasureOverride.value = () => fold.foldedControls.value.length === 0
    await fold.updateFoldState()
    expect(fold.foldedControls.value).toEqual(['create'])

    fold.foldMeasureOverride.value = () => false
    await fold.updateFoldState()
    expect(fold.foldedControls.value).toEqual([])
  })

  it('shows folded controls as More menu entries and restores the inline controls on unfold', async () => {
    const mounted = mountComposer({
      initialDraft: '',
      skillsEnabled: true,
      mediaCapabilities: { attachments: true, transcription: true },
      mediaSession: { id: 'session-1' }
    })
    const bindings = lastBindings as unknown as {
      foldedControls: { value: string[] }
      moreMenuOpen: { value: boolean }
    }
    await Vue.nextTick()
    bindings.foldedControls.value = ['create', 'web']
    await Vue.nextTick()
    // The folded inline controls are removed from the action bar.
    expect(mounted.root.querySelector('.agent-composer__web-search-toggle')).toBeNull()
    expect(mounted.root.querySelector('.agent-composer__create')).toBeNull()
    expect(mounted.root.querySelector('.agent-composer__attach')).not.toBeNull()

    bindings.moreMenuOpen.value = true
    await Vue.nextTick()
    await Vue.nextTick()
    const moreMenu = Array.from(document.body.querySelectorAll<HTMLElement>('.agent-composer__more-menu')).pop()
    if (!moreMenu) throw new Error('More menu did not render')
    const titles = Array.from(moreMenu.querySelectorAll<HTMLElement>('.v-list-item')).map(item => item.querySelector('.v-list-item-title')?.textContent?.trim())
    const webItem = Array.from(moreMenu.querySelectorAll<HTMLElement>('.v-list-item')).find(
      item => item.querySelector('.v-list-item-title')?.textContent?.trim() === 'Web'
    )
    if (!webItem) throw new Error('Folded Web menu item did not render')
    expect(webItem.getAttribute('role')).toBe('menuitemcheckbox')
    expect(webItem.getAttribute('aria-checked')).toBe('false')
    expect(webItem.classList.contains('v-list-item--disabled')).toBe(true)
    const createTitles = titles.filter(title => title === 'Images' || title === 'Video')
    expect(createTitles).toEqual(['Images', 'Video'])
    // Skills always live inside the More menu, folded or not.
    const skillsItem = Array.from(moreMenu.querySelectorAll<HTMLElement>('.v-list-item')).find(item => item.getAttribute('aria-haspopup') === 'dialog')
    if (!skillsItem) throw new Error('Folded Skills submenu item did not render')
    expect(skillsItem.querySelector('.v-list-item-title')?.textContent?.trim()).toBe('Skills')

    // Unfolding restores the inline controls and empties the folded menu entries.
    bindings.moreMenuOpen.value = false
    await Vue.nextTick()
    bindings.foldedControls.value = []
    await Vue.nextTick()
    expect(mounted.root.querySelector('.agent-composer__web-search-toggle')).not.toBeNull()
    expect(mounted.root.querySelector('.agent-composer__create')).not.toBeNull()
    bindings.moreMenuOpen.value = true
    await Vue.nextTick()
    await Vue.nextTick()
    const reopened = Array.from(document.body.querySelectorAll<HTMLElement>('.agent-composer__more-menu')).pop()
    if (!reopened) throw new Error('Reopened More menu did not render')
    const reopenedTitles = Array.from(reopened.querySelectorAll<HTMLElement>('.v-list-item')).map(item =>
      item.querySelector('.v-list-item-title')?.textContent?.trim()
    )
    expect(reopenedTitles).toEqual(['Skills'])
  })
})

describe('Agent composer goal placement', () => {
  it('keeps Goal as a direct inline control while unset', () => {
    const mounted = mountComposer({ initialDraft: '', initialMode: 'message' })
    expect(mounted.root.querySelector('.agent-composer__goal-chip')).toBeNull()
    const goal = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__goal-toggle')
    if (!goal) throw new Error('Goal control did not render')
    expect(goal.textContent?.trim()).toBe('Goal')
    expect(goal.getAttribute('title')).toContain('durable outcome')
  })

  it('moves Goal into the More menu only when the fold logic folds it', async () => {
    const mounted = mountComposer({ initialDraft: '', initialMode: 'message' })
    await Vue.nextTick()
    const bindings = lastBindings as unknown as { foldedControls: { value: string[] }; moreMenuOpen: { value: boolean } }
    bindings.foldedControls.value = ['goal']
    await Vue.nextTick()
    await Vue.nextTick()
    expect(mounted.root.querySelector('.agent-composer__goal-toggle')).toBeNull()
    const more = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__more-button')
    if (!more) throw new Error('More options button did not render')
    bindings.moreMenuOpen.value = true
    await Vue.nextTick()
    await Vue.nextTick()
    await Vue.nextTick()
    const moreMenu = Array.from(document.body.querySelectorAll<HTMLElement>('.agent-composer__more-menu')).pop()
    if (!moreMenu) throw new Error('More menu did not render')
    const goalItem = Array.from(moreMenu.querySelectorAll<HTMLElement>('.v-list-item')).find(
      item => item.querySelector('.v-list-item-title')?.textContent?.trim() === 'Goal'
    )
    if (!goalItem) throw new Error('Folded Goal menu item did not render')
    goalItem.click()
    await Vue.nextTick()
    expect(mounted.root.querySelector('.agent-composer__goal-chip')).not.toBeNull()
  })

  it('shows an editable Goal context chip when goal mode is on and restores the inline control', async () => {
    const mounted = mountComposer({ initialDraft: '', initialMode: 'goal' })
    const chip = mounted.root.querySelector<HTMLElement>('.agent-composer__goal-chip')
    if (!chip) throw new Error('Goal chip did not render')
    expect(chip.textContent?.trim()).toBe('Goal')
    // While set, the inline Goal control yields to the chip.
    expect(mounted.root.querySelector('.agent-composer__goal-toggle')).toBeNull()
    const close = chip.querySelector<HTMLButtonElement>('.v-chip__close')
    if (!close) throw new Error('Goal chip close control did not render')
    close.click()
    await Vue.nextTick()
    expect(mounted.root.querySelector('.agent-composer__goal-chip')).toBeNull()
    expect(mounted.root.querySelector('.agent-composer__goal-toggle')).not.toBeNull()
  })
})

describe('Agent composer dictation controls', () => {
  it('reports permission, recording, and transcription work through the parent public contract', async () => {
    const mounted = mountComposer({ initialDraft: '', mediaCapabilities: { transcription: true } })
    const parent = mounted.publicRef.value
    if (!parent) throw new Error('Composer parent public ref was not mounted')
    expect(parent.hasUnsentMedia()).toBe(false)
    expect(parent.isMediaBusy()).toBe(false)
    for (const pending of [requesting, recording, transcribing]) {
      pending.value = true
      expect(parent.isMediaBusy()).toBe(true)
      expect(parent.hasUnsentMedia()).toBe(false)
      pending.value = false
      await Vue.nextTick()
      expect(parent.isMediaBusy()).toBe(false)
    }
    expect(mounted.sent).toEqual([])
  })

  it('starts recording from the microphone and stops for review with a labeled outlined control', async () => {
    const mounted = mountComposer({ initialDraft: 'typed words', mediaCapabilities: { transcription: true } })
    const mic = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic')
    if (!mic) throw new Error('Microphone did not render')
    mic.click()
    await Vue.nextTick()
    expect(recording.value).toBe(true)
    // The recording indicator is a noninteractive status dot, not a red target.
    const dot = mounted.root.querySelector<HTMLElement>('.agent-composer__dictation-dot')
    expect(dot).not.toBeNull()
    expect(dot?.querySelector('button')).toBeNull()
    const label = mounted.root.querySelector<HTMLElement>('.agent-composer__dictation-label')
    expect(label?.textContent?.trim()).toBe('Listening…')
    expect(label?.getAttribute('role')).toBe('status')
    // Recording feedback keeps the typed draft visible in the editor.
    expect(mounted.root.querySelector('.agent-composer__input textarea')).not.toBeNull()
    expect(mounted.root.querySelector('.agent-composer__dictation-wave')).not.toBeNull()
    const review = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__dictation-review')
    if (!review) throw new Error('Review control did not render')
    expect(review.textContent?.trim()).toBe('Review')
    expect(review.getAttribute('aria-label')).toBe('Stop dictation and review the transcript')
    // Discard is separated at the opposite end of the action row.
    const discard = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__dictation-discard')
    if (!discard) throw new Error('Discard control did not render')
    expect(discard.getAttribute('aria-label')).toBe('Discard recording; keeps your typed message')
    const leftGroup = mounted.root.querySelector<HTMLElement>('.agent-composer__dictation-actions-left')
    if (!leftGroup) throw new Error('Discard group did not render')
    expect(leftGroup.contains(discard)).toBe(true)
    expect(leftGroup.contains(review)).toBe(false)
    expect(leftGroup.contains(mounted.root.querySelector('.agent-composer__submit'))).toBe(false)
    // Review stops capture; child lifecycle tests protect transcript delivery.
    review.click()
    await Vue.nextTick()
    expect(recording.value).toBe(false)
  })

  it('keeps a tabular countdown with a static status and emphasizes the final ten seconds', async () => {
    const mounted = mountComposer({ initialDraft: '', mediaCapabilities: { transcription: true } })
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic')?.click()
    await Vue.nextTick()
    seconds.value = 37
    await Vue.nextTick()
    const timer = mounted.root.querySelector<HTMLElement>('.agent-composer__dictation-timer')
    expect(timer?.textContent?.trim()).toBe('00:37 / 01:00')
    if (!timer) throw new Error('Recording timer did not render')
    const regularWeight = browserWindow.getComputedStyle(timer).fontWeight
    expect(browserWindow.getComputedStyle(timer).fontVariantNumeric).toBe('tabular-nums')
    const label = mounted.root.querySelector<HTMLElement>('.agent-composer__dictation-label')
    expect(label?.textContent?.trim()).toBe('Listening…')
    // The last ten seconds emphasize the timer.
    seconds.value = 53
    await Vue.nextTick()
    expect(browserWindow.getComputedStyle(timer).fontWeight).toBe('600')
    expect(browserWindow.getComputedStyle(timer).fontWeight).not.toBe(regularWeight)
    expect(label?.textContent?.trim()).toBe('Listening…')
  })

  it('announces the permission request separately from listening', async () => {
    const mounted = mountComposer({ initialDraft: '', mediaCapabilities: { transcription: true } })
    requesting.value = true
    recording.value = true
    await Vue.nextTick()
    const label = mounted.root.querySelector<HTMLElement>('.agent-composer__dictation-label')
    expect(label?.textContent?.trim()).toBe('Requesting microphone…')
    requesting.value = false
    await Vue.nextTick()
    expect(mounted.root.querySelector('.agent-composer__dictation-label')?.textContent?.trim()).toBe('Listening…')
    requesting.value = false
    recording.value = false
  })

  it('submits exactly once with the combined transcript and typed draft when Send is pressed during recording', async () => {
    setDictationTranscriptHook(async () => {
      transcribing.value = true
      return 'voice words'
    })
    const mounted = mountComposer({ initialDraft: 'typed words', mediaCapabilities: { transcription: true } })
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic')?.click()
    await Vue.nextTick()
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__submit')?.click()
    await settleAsync()
    expect(sentRecorder).toHaveLength(1)
    expect(sentRecorder[0]?.content).toBe('typed words voice words')
    // A successful dictation send clears the submitted draft like a plain send.
    expect((mounted.root.querySelector('.agent-composer__input textarea') as HTMLTextAreaElement | null)?.value ?? '').not.toContain('typed words')
  })

  it('notifies without submitting when a send-during-recording finds no speech', async () => {
    setDictationTranscriptHook(async () => null)
    const mounted = mountComposer({ initialDraft: 'typed words', mediaCapabilities: { transcription: true } })
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic')?.click()
    await Vue.nextTick()
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__submit')?.click()
    await settleAsync()
    expect(sentRecorder).toHaveLength(0)
    expect(mounted.root.querySelector('.agent-composer__notice')?.textContent).toContain('No speech was found')
    expect(mounted.root.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('typed words')
  })

  it('preserves the typed draft when a recording is discarded', async () => {
    const mounted = mountComposer({ initialDraft: 'keep me', mediaCapabilities: { transcription: true } })
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic')?.click()
    await Vue.nextTick()
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__dictation-discard')?.click()
    await Vue.nextTick()
    expect(recording.value).toBe(false)
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    expect(textarea?.value).toBe('keep me')
  })

  it('blocks duplicate submissions while a dictation submit is pending', async () => {
    let resolveTranscript: ((value: string | null) => void) | null = null
    setDictationTranscriptHook(
      () =>
        new Promise(resolve => {
          resolveTranscript = resolve
        })
    )
    const mounted = mountComposer({ initialDraft: 'typed words', mediaCapabilities: { transcription: true } })
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic')?.click()
    await Vue.nextTick()
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__submit')?.click()
    await Vue.nextTick()
    const submit = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__submit')
    expect(submit?.disabled).toBe(true)
    expect(submit?.classList.contains('v-btn--loading')).toBe(true)
    submit?.click()
    // A form submission can reach the handler even when its button is disabled.
    mounted.root.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
    await Vue.nextTick()
    expect(sentRecorder).toEqual([])
    if (resolveTranscript) resolveTranscript('voice words')
    await settleAsync()
    expect(sentRecorder).toHaveLength(1)
  })

  it('returns to editing with a short notice when a review-path transcription fails', async () => {
    const mounted = mountComposer({ initialDraft: 'typed words', mediaCapabilities: { transcription: true } })
    const bindings = lastBindings as unknown as { receiveDictationFailure: (message: string) => void }
    bindings.receiveDictationFailure('No speech was found. Try recording again.')
    await Vue.nextTick()
    const notice = mounted.root.querySelector('.agent-composer__notice')
    expect(notice?.textContent).toContain('No speech was found')
    // The typed draft survives a failed transcription.
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    expect(textarea?.value).toBe('typed words')
    // The notice never clobbers a higher-priority message.
    bindings.receiveDictationFailure('Transcription failed')
    await Vue.nextTick()
    expect(mounted.root.querySelector('.agent-composer__notice')?.textContent).toContain('No speech was found')
  })

  it('inserts dictated text at the saved caret instead of overwriting typed text', async () => {
    const mounted = mountComposer({ initialDraft: 'head tail', mediaCapabilities: { transcription: true } })
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    if (!textarea) throw new Error('Composer textarea did not render')
    // The saved caret anchor is captured from the textarea's selection (the
    // select handler and typing position); insertion honors it directly.
    const bindings = lastBindings as unknown as { savedCaret: { value: number | null }; appendDictation: (text: string) => void }
    textarea.focus()
    textarea.setSelectionRange(4, 4)
    textarea.dispatchEvent(new browserWindow.Event('select', { bubbles: true }))
    const draft = (lastBindings as unknown as { draft: { value: string } }).draft
    bindings.appendDictation('spoken')
    await Vue.nextTick()
    expect(draft.value).toBe('head spoken tail')
    expect(textarea.value).toBe('head spoken tail')

    // An invalid anchor falls back to appending without clobbering typed text.
    bindings.savedCaret.value = 999
    bindings.appendDictation('more')
    await Vue.nextTick()
    expect(draft.value).toBe('head spoken tail more')
    expect(textarea.value).toBe('head spoken tail more')
  })
})
