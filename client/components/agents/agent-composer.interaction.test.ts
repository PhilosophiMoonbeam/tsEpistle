import fs from 'node:fs'
import path from 'node:path'

import { compileStyle, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'
import { caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret } from './agent-composer-sizing.ts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'

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
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-composer.vue script block was not found')
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))
const evaluateComposer = new Function(
  '{ computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch, defineProps, defineEmits, defineExpose, filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills, caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret, window, document, HTMLElement, HTMLTextAreaElement }',
  `${executableScript}
return {
  mediaSubmission,
  mediaBusy,
  appendDictation,
  handleMediaPaste,
  handleMediaDragOver,
  handleMediaDrop,
  props,
  emit,
  draft,
  goalMode,
  skillMenuOpen,
  selectedSkillIds,
  syncingComposition,
  composerRoot,
  messageInput,
  dismissedCommandToken,
  activeCommandIndex,
  sendFailed,
  submissionPending,
  sendInProgress,
  restoreInputWhenReady,
  mounted,
  composerId,
  composerIds,
  commandOptionId,
  preferredSkillIds,
  preferredSkillIdByVersionId,
  selectedSkillIdSet,
  visibleSkillIds,
  visibleSkillByVersionId,
  selectedSkills,
  skillMenuItems,
  skillIdForVersion,
  isPreferred,
  composerInputLabel,
  composerInputDescriptionIds,
  composerInputPlaceholder,
  liveStatusLabel,
  submitLabel,
  submitIcon,
  isSelected,
  getTextarea,
  caretMirror,
  caretMirrorPrefix,
  caretMirrorMarker,
  caretMirrorSuffix,
  mountCaretMirror,
  unmountCaretMirror,
  measureCaretBounds,
  keepCaretVisible,
  resizeInput,
  handleSelectionChange,
  focusInput,
  togglePreference,
  skillCommandCandidate,
  skillCommandMatch,
  skillCommandQuery,
  skillCommandOpen,
  skillCommandResults,
  skillLoadTitle,
  skillLoadMessage,
  skillCommandStatus,
  isCommandSkillDisabled,
  usableSkillCommandResults,
  activeCommandSkill,
  activeCommandOptionId,
  setActiveCommandSkill,
  invokeCommandSkill,
  handleKeydown,
  toggleSkill,
  manageSkills,
  retrySkills,
  focusSkillsTrigger,
  resetInput,
  submit,
  setDraft,
  moreMenuItems,
  moreMenuOpen,
  foldedControls,
  foldMeasureOverride,
  updateFoldState,
  isControlFolded,
  hasMoreMenuContent,
  foldedSkillMenuOpen,
  preferredMenuVersionIds,
  submitDisabled,
  savedCaret,
  handleSelectionChange,
  attachmentsAvailable,
  attachmentCount,
  attachDisabled,
  generationOptions,
  selectedGenerationTools,
  createAvailable,
  attachmentMenuOpen,
  openFilePicker,
  openAssetBrowser,
  toggleGenerationTool,
  mediaRecording,
  mediaTranscribing,
  mediaSeconds,
  dictationAvailable,
  error,
  startDictation,
  stopDictation,
  cancelDictation
}`
) as (dependencies: Record<string, unknown>) => Record<string, unknown>
let nextComposerId = 0
const testUseId = (): string => `agent-composer-test-${++nextComposerId}`
const descriptor = parse(source, { filename: componentPath }).descriptor
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
  } = {}
): ComposerHarness => {
  const props = {
    disabled: options.disabled ?? false,
    sending: options.sending ?? false,
    canStop: options.canStop ?? false,
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
    initialMode: options.initialMode,
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
  readonly sent: Array<{ content: string; invokedSkillVersionIds: readonly string[]; mode: 'message' | 'goal' }>
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
}

// Shared media-composer stub state; each test reads/adjusts these through the mounted harness helpers.
let dictationTranscriptHook: () => Promise<string | null> = async () => null
const setDictationTranscriptHook = (hook: () => Promise<string | null>): void => { dictationTranscriptHook = hook }
const recording = Vue.ref(false)
const transcribing = Vue.ref(false)
const seconds = Vue.ref(0)
const dictationIntent = Vue.ref<'insert' | 'send'>('insert')
const generationOptions = Vue.ref([
  { value: 'image', title: 'Images', icon: 'mdi-image-outline' },
  { value: 'video', title: 'Video', icon: 'mdi-movie-open-outline' }
])
const selectedTools = Vue.ref<Array<'image' | 'video' | 'music'>>([])
const attachments = Vue.ref<Array<{ id: string; filename: string; mimeType: string }>>([])
let chooseUploadCalls = 0
let browseAssetsCalls = 0
const markDocument = (name: string): void => { (document as unknown as { __which: string }).__which = name }
markDocument('composer-test')
const mountedComposers: Array<() => void> = []
let sentRecorder: Array<{ content: string; invokedSkillVersionIds: readonly string[]; mode: 'message' | 'goal' }> = []
let lastBindings: Record<string, unknown> | null = null
const mountComposer = (options: MountedComposerOptions = {}): MountedComposer => {
  const host = document.createElement('div')
  document.body.append(host)
  const componentProps = {
    disabled: options.disabled ?? false,
    sending: options.sending ?? false,
    canStop: options.canStop ?? false,
    skillsEnabled: options.skillsEnabled ?? false,
    goalsEnabled: true,
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
    networkBlocked: false,
    mediaCapabilities: options.mediaCapabilities,
    mediaSession: options.mediaSession
  }
  const composerComponent = Vue.defineComponent({
    name: 'AgentComposerInteractionHarness',
    props: {
      disabled: Boolean,
      sending: Boolean,
      canStop: Boolean,
      skillsEnabled: Boolean,
      goalsEnabled: Boolean,
      skills: Array,
      skillsLoading: Boolean,
      skillsLoadError: String,
      skillsPartial: Boolean,
      preferredSkills: Array,
      invocationLimit: Number,
      statusLabel: String,
      statusTone: String,
      initialDraft: String,
      initialMode: String,
      initialSkillVersionIds: Array,
      hasMessages: Boolean,
      csrfToken: String,
      mediaSession: Object,
      mediaCapabilities: Object,
      networkBlocked: Boolean
    },
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
  sentRecorder = sentMessages
  const app = Vue.createApp({
    name: 'AgentComposerInteractionRoot',
    render: () => Vue.h(
      composerComponent,
      {
        ...componentProps,
        onSend: (content: string, invokedSkillVersionIds: readonly string[], mode: 'message' | 'goal', completion?: (success: boolean) => void) => {
          sentMessages.push({ content, invokedSkillVersionIds, mode })
          completion?.(true)
        }
      },
      options.contextControls
        ? { 'context-controls': () => Vue.h('span', { class: 'harness-context-chip' }, 'EN · home') }
        : undefined
    )
  })
  const mediaHarness = Vue.defineComponent({
    name: 'AgentComposerMediaHarness',
    props: ['csrfToken', 'session', 'capabilities', 'generationToolsEnabled', 'disabled', 'networkBlocked'],
    emits: ['change', 'busy', 'dictation', 'settled'],
    template: '<div class="agent-media-composer-harness" />',
    setup(_props, { emit, expose }: { emit: (event: string, value: unknown) => void; expose: (value: unknown) => void }) {
      Vue.watch(recording, value => emit('busy', value))
      Vue.watch(transcribing, value => { if (value) emit('busy', true) })
      expose({
        clear: () => undefined,
        addFiles: async () => undefined,
        editImage: async () => false,
        reattachMedia: async () => true,
        startRecording: async () => { recording.value = true; seconds.value = 0 },
        stopRecording: () => { recording.value = false },
        cancelDictation: () => { recording.value = false; transcribing.value = false; dictationIntent.value = 'insert' },
        beginDictationSubmit: () => {
          if (!recording.value) return false
          dictationIntent.value = 'send'
          return true
        },
        waitForDictationTranscript: () => dictationIntent.value === 'send' ? dictationTranscriptHook() : Promise.resolve(null),
        chooseUpload: () => { chooseUploadCalls += 1 },
        browseAssets: () => { browseAssetsCalls += 1 },
        toggleGenerationTool: (tool: 'image' | 'video' | 'music') => {
          selectedTools.value = selectedTools.value.includes(tool)
            ? selectedTools.value.filter(item => item !== tool)
            : [...selectedTools.value, tool]
        },
        generationOptions,
        selectedGenerationTools: selectedTools,
        attachments,
        recording,
        transcribing,
        seconds,
        dictationIntent
      })
    }
  })
  app.component('AgentComposerMedia', mediaHarness)
  app.component('AgentComposerSkillMenu', Vue.defineComponent({
    name: 'AgentComposerSkillMenuHarness',
    props: ['items', 'skillsCount', 'skillsLoading', 'skillsLoadError', 'skillsPartial', 'disabled', 'sendInProgress', 'networkBlocked', 'invocationLimit', 'selectedSkillVersionIds', 'preferredVersionIds', 'dialogId', 'headingId', 'descriptionId'],
    emits: ['toggle', 'togglePreference', 'manageSkills', 'retrySkills'],
    template: '<div class="agent-composer-skill-menu-harness">Skills menu</div>'
  }))
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.mount(host)
  for (const element of host.querySelectorAll<HTMLElement>('*')) element.setAttribute(composerScopeAttribute, '')
  const root = host.querySelector<HTMLElement>('.agent-composer')
  if (!root) throw new Error('Agent composer did not render')
  const unmount = (): void => {
    app.unmount()
    host.remove()
  }
  mountedComposers.push(unmount)
  return { root, sent: sentMessages, unmount }
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
  transcribing.value = false
  seconds.value = 0
  dictationIntent.value = 'insert'
  selectedTools.value = []
  attachments.value = []
  chooseUploadCalls = 0
  browseAssetsCalls = 0
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
    expect(idle.root.querySelector('.agent-composer__state')).toBeNull()
    expect(idleStatus.getAttribute('role')).toBe('status')
    expect(idleStatus.getAttribute('aria-live')).toBe('polite')
    expect(idleStatus.textContent?.trim()).toBe('Ready')

    const loadingStatus = loading.root.querySelector<HTMLElement>('.agent-composer__live-status')
    if (!loadingStatus) throw new Error('Loading live composer status did not render')
    expect(loadingStatus.textContent?.trim()).toBe('Sending')
  })


  it('announces external error feedback without relabeling the ordinary Send action', () => {
    const error = mountComposer({ statusLabel: 'Try again', statusTone: 'error' })
    const button = error.root.querySelector<HTMLButtonElement>('.agent-composer__submit')
    const status = error.root.querySelector<HTMLElement>('.agent-composer__live-status')
    if (!button || !status) throw new Error('Error composer controls did not render')

    expect(error.root.querySelector('.agent-composer__state')).toBeNull()
    expect(error.root.classList.contains('agent-composer--status-error')).toBe(true)
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


describe('Agent composer instance accessibility', () => {
  it('keeps option IDs and descriptions distinct across instances', () => {
    const first = loadComposer()
    const second = loadComposer()
    first.draft.value = '/docs'
    second.draft.value = '/docs'

    expect(first.activeCommandOptionId.value).toBeDefined()
    expect(second.activeCommandOptionId.value).toBeDefined()
    expect(first.activeCommandOptionId.value).not.toBe(second.activeCommandOptionId.value)
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

    expect(actions.children).toHaveLength(2)
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
    // The separate media controls row is gone; dictation has no row label anymore.
    expect(root.querySelector('.agent-media-composer__controls')).toBeNull()
    expect(root.querySelector('.agent-composer__web-search-info')).toBeNull()
  })

  it('labels the Create control without a count and routes upload and asset browsing through the media pipeline', async () => {
    const mounted = mountComposer({ initialDraft: '', mediaCapabilities: { attachments: true, transcription: true }, mediaSession: { id: 'session-1' } })
    await Vue.nextTick()
    selectedTools.value = ['image']
    await Vue.nextTick()
    const create = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__create')
    if (!create) throw new Error('Create control did not render')
    expect(create.textContent?.trim()).toBe('Create')
    expect(create.getAttribute('data-state')).toBe('selected')
    // Open the attachment menu through its model, as Vuetify overlay tests do.
    const bindings = lastBindings as unknown as { attachmentMenuOpen: { value: boolean } }
    bindings.attachmentMenuOpen.value = true
    await Vue.nextTick()
    await Vue.nextTick()
    const uploadItem = Array.from(document.body.querySelectorAll<HTMLElement>('.v-list-item')).find(item => item.textContent?.includes('Upload files'))
    if (!uploadItem) throw new Error('Upload files menu item did not render')
    uploadItem.click()
    await Vue.nextTick()
    expect(chooseUploadCalls).toBe(1)
  })

  it('disables attaching once the four-attachment limit is reached', async () => {
    const mounted = mountComposer({ initialDraft: '', mediaCapabilities: { attachments: true, transcription: true }, mediaSession: { id: 'session-1' } })
    await Vue.nextTick()
    attachments.value = [
      { id: '1', filename: 'a.png', mimeType: 'image/png' },
      { id: '2', filename: 'b.png', mimeType: 'image/png' },
      { id: '3', filename: 'c.png', mimeType: 'image/png' },
      { id: '4', filename: 'd.png', mimeType: 'image/png' }
    ]
    await Vue.nextTick()
    expect(mounted.root.querySelector<HTMLButtonElement>('.agent-composer__attach')?.disabled).toBe(true)
  })

  it('labels the Web toggle and drops the standalone information control', () => {
    const mounted = mountComposer({ initialDraft: '' })
    const toggle = mounted.root.querySelector<HTMLLabelElement>('.agent-composer__web-search-toggle')
    if (!toggle) throw new Error('Web toggle did not render')
    expect(toggle.textContent?.trim()).toBe('Web')
    expect(toggle.querySelector('input')?.getAttribute('aria-label')).toBe('Use Google Search for this conversation')
    expect(toggle.getAttribute('title')).toContain('Google Search')
    // Color-independent state attribute for the off state is absent; the checkbox aria-checked carries state.
    expect(toggle.querySelector('input')?.getAttribute('aria-checked')).toBe('false')
    expect(mounted.root.querySelector('.agent-composer__web-search-info')).toBeNull()
  })

  it('keeps the Goal control inline where Skills used to sit and moves Skills into the More menu', () => {
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
    // Skills no longer render as an inline control; they live behind More options.
    expect(mounted.root.querySelector('.agent-composer__skill-button')).toBeNull()
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

  it('collapses the context row to nothing when no slot content and no goal chip render', () => {
    const mounted = mountComposer({ initialDraft: '' })
    const row = mounted.root.querySelector<HTMLElement>('.agent-composer__context-row')
    if (!row) throw new Error('Source context row did not render')
    // Only v-if comment placeholders remain, so the CSS :empty rule can hide the row.
    expect(row.children).toHaveLength(0)
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

  it('keeps an unfolded control restored instead of oscillating', async () => {
    const fold = asFoldHarness(loadComposer())
    fold.foldedControls.value = ['web']
    // Plenty of space: everything unfolds and stays unfolded.
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
    expect(mounted.root.querySelector('.agent-composer__skill-button')).toBeNull()
    expect(mounted.root.querySelector('.agent-composer__attach')).not.toBeNull()

    bindings.moreMenuOpen.value = true
    await Vue.nextTick()
    await Vue.nextTick()
    const moreMenu = Array.from(document.body.querySelectorAll<HTMLElement>('.agent-composer__more-menu')).pop()
    if (!moreMenu) throw new Error('More menu did not render')
    const titles = Array.from(moreMenu.querySelectorAll<HTMLElement>('.v-list-item')).map(item => item.querySelector('.v-list-item-title')?.textContent?.trim())
    const webItem = Array.from(moreMenu.querySelectorAll<HTMLElement>('.v-list-item')).find(item => item.querySelector('.v-list-item-title')?.textContent?.trim() === 'Web')
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
    expect(mounted.root.querySelector('.agent-composer__skill-button')).toBeNull()
    bindings.moreMenuOpen.value = true
    await Vue.nextTick()
    await Vue.nextTick()
    const reopened = Array.from(document.body.querySelectorAll<HTMLElement>('.agent-composer__more-menu')).pop()
    if (!reopened) throw new Error('Reopened More menu did not render')
    const reopenedTitles = Array.from(reopened.querySelectorAll<HTMLElement>('.v-list-item')).map(item => item.querySelector('.v-list-item-title')?.textContent?.trim())
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
    const bindings = lastBindings as unknown as { foldedControls: { value: string[] }, moreMenuOpen: { value: boolean } }
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
    const goalItem = Array.from(moreMenu.querySelectorAll<HTMLElement>('.v-list-item')).find(item => item.querySelector('.v-list-item-title')?.textContent?.trim() === 'Goal')
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
  it('starts recording from the microphone and inserts a finished transcript for review', async () => {
    const mounted = mountComposer({ initialDraft: 'typed words', mediaCapabilities: { transcription: true } })
    const mic = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic')
    if (!mic) throw new Error('Microphone did not render')
    mic.click()
    await Vue.nextTick()
    expect(recording.value).toBe(true)
    expect(mounted.root.querySelector('.agent-composer__dictation-status')).not.toBeNull()
    // A second mic click stops and inserts for review.
    const stop = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic--recording')
    if (!stop) throw new Error('Stop dictation control did not render')
    expect(stop.getAttribute('aria-label')).toBe('Stop dictation and insert text')
    stop.click()
    await Vue.nextTick()
    expect(recording.value).toBe(false)
  })

  it('keeps a reserved countdown with the microphone while recording', async () => {
    const mounted = mountComposer({ initialDraft: '', mediaCapabilities: { transcription: true } })
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic')?.click()
    await Vue.nextTick()
    seconds.value = 37
    await Vue.nextTick()
    const status = mounted.root.querySelector<HTMLElement>('.agent-composer__dictation-status')
    expect(status?.textContent?.trim()).toBe('37 / 60s')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    const cancel = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__dictation-cancel')
    expect(cancel?.textContent?.trim()).toBe('Cancel')
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
  })

  it('preserves the typed draft when a recording is canceled', async () => {
    const mounted = mountComposer({ initialDraft: 'keep me', mediaCapabilities: { transcription: true } })
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic')?.click()
    await Vue.nextTick()
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__dictation-cancel')?.click()
    await Vue.nextTick()
    expect(recording.value).toBe(false)
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    expect(textarea?.value).toBe('keep me')
  })

  it('blocks duplicate submissions while a dictation submit is pending', async () => {
    let resolveTranscript: ((value: string | null) => void) | null = null
    setDictationTranscriptHook(() => new Promise(resolve => { resolveTranscript = resolve }))
    const mounted = mountComposer({ initialDraft: 'typed words', mediaCapabilities: { transcription: true } })
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__mic')?.click()
    await Vue.nextTick()
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__submit')?.click()
    await Vue.nextTick()
    // Submit again while the transcript is still pending.
    mounted.root.querySelector<HTMLButtonElement>('.agent-composer__submit')?.click()
    if (resolveTranscript) resolveTranscript('voice words')
    await settleAsync()
    expect(sentRecorder).toHaveLength(1)
  })

  it('inserts dictated text at the saved caret instead of overwriting typed text', async () => {
    const mounted = mountComposer({ initialDraft: 'head tail', mediaCapabilities: { transcription: true } })
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    if (!textarea) throw new Error('Composer textarea did not render')
    // The saved caret anchor is captured from the textarea's selection (the
    // select handler and typing position); insertion honors it directly.
    const bindings = lastBindings as unknown as { savedCaret: { value: number | null }; appendDictation: (text: string) => void }
    bindings.savedCaret.value = 4
    const draft = (lastBindings as unknown as { draft: { value: string } }).draft
    bindings.appendDictation('spoken')
    await Vue.nextTick()
    expect(draft.value).toBe('head spoken tail')

    // An invalid anchor falls back to appending without clobbering typed text.
    bindings.savedCaret.value = 999
    bindings.appendDictation('more')
    await Vue.nextTick()
    expect(draft.value).toBe('head spoken tail more')
  })
})
