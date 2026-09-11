import fs from 'node:fs'
import path from 'node:path'

import { compileStyle, compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'
import { caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret } from './agent-composer-sizing.ts'

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
  readonly content: string
  readonly invokedSkillVersionIds: readonly string[]
  readonly mode: 'message' | 'goal'
  readonly complete: (success: boolean) => void
}

interface ComposerHarness {
  readonly draft: Ref<string>
  readonly goalMode: Ref<boolean>
  readonly selectedSkillIds: Ref<string[]>
  readonly activeCommandSkill: Ref<TestSkill | null>
  readonly activeCommandOptionId: Ref<string | undefined>
  readonly skillCommandOpen: Ref<boolean>
  readonly handleKeydown: (event: KeyboardEvent) => void
  readonly submit: () => void
  readonly toggleChatPinned: () => void
  readonly pinnedEvents: boolean[]
  readonly sent: SentMessage[]
}

class FakeElement {}
class FakeTextArea extends FakeElement {}

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-composer.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-composer.vue script block was not found')
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))
const bindingNames = Array.from(script.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm), match => match[1])
const evaluateComposer = new Function(
  '{ computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch, defineProps, defineEmits, defineExpose, filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills, caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret, window, document, HTMLElement, HTMLTextAreaElement }',
  `${executableScript}\nreturn { ${bindingNames.join(', ')} }`
) as (dependencies: Record<string, unknown>) => Record<string, unknown>
let nextComposerId = 0
const testUseId = (): string => `agent-composer-test-${++nextComposerId}`
const descriptor = parse(source, { filename: componentPath }).descriptor
if (!descriptor.template || descriptor.styles.length === 0) throw new Error('agent-composer.vue template and styles are required')

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/'
})
const browserWindow = dom.window
const css = { escape: (value: string) => value, supports: () => false }
class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const visualViewport = {
  width: 1024,
  height: 768,
  offsetLeft: 0,
  offsetTop: 0,
  pageLeft: 0,
  pageTop: 0,
  scale: 1,
  addEventListener: () => undefined,
  removeEventListener: () => undefined
}
Object.defineProperties(browserWindow, {
  CSS: { configurable: true, value: css },
  IntersectionObserver: { configurable: true, value: ObserverStub },
  ResizeObserver: { configurable: true, value: ObserverStub },
  devicePixelRatio: { configurable: true, value: 1 },
  matchMedia: {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('max-width: 639.98px'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true
    })
  },
  visualViewport: { configurable: true, value: visualViewport }
})
const globalValues: Record<string, unknown> = {
  CSS: css,
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLElement: browserWindow.HTMLElement,
  HTMLButtonElement: browserWindow.HTMLButtonElement,
  HTMLInputElement: browserWindow.HTMLInputElement,
  HTMLTextAreaElement: browserWindow.HTMLTextAreaElement,
  IntersectionObserver: ObserverStub,
  KeyboardEvent: browserWindow.KeyboardEvent,
  MouseEvent: browserWindow.MouseEvent,
  MutationObserver: browserWindow.MutationObserver,
  Node: browserWindow.Node,
  ResizeObserver: ObserverStub,
  SVGElement: browserWindow.SVGElement,
  Text: browserWindow.Text,
  cancelAnimationFrame: browserWindow.cancelAnimationFrame.bind(browserWindow),
  devicePixelRatio: 1,
  document: browserWindow.document,
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  navigator: browserWindow.navigator,
  requestAnimationFrame: browserWindow.requestAnimationFrame.bind(browserWindow),
  visualViewport,
  window: browserWindow
}
for (const [name, value] of Object.entries(globalValues)) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })
}

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
    readonly chatPinned?: boolean
    readonly chatPinDisabled?: boolean
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
    chatPinned: options.chatPinned ?? false,
    chatPinDisabled: options.chatPinDisabled ?? false
  }
  const sent: SentMessage[] = []
  const pinnedEvents: boolean[] = []
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
            complete: args[3] as (success: boolean) => void
          })
        } else if (event === 'update:chatPinned') {
          pinnedEvents.push(Boolean(args[0]))
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
  return { ...composer, sent, pinnedEvents }
}
interface MountedComposer {
  readonly root: HTMLElement
  readonly unmount: () => void
}

interface MountedComposerOptions {
  readonly disabled?: boolean
  readonly sending?: boolean
  readonly initialDraft?: string
}

const mountedComposers: Array<() => void> = []
const mountComposer = (options: MountedComposerOptions = {}): MountedComposer => {
  const host = document.createElement('div')
  document.body.append(host)
  const componentProps = {
    disabled: options.disabled ?? false,
    sending: options.sending ?? false,
    canStop: false,
    skillsEnabled: false,
    goalsEnabled: true,
    skills: [],
    skillsLoading: false,
    skillsLoadError: '',
    skillsPartial: false,
    preferredSkills: [],
    invocationLimit: 3,
    statusLabel: 'Ready',
    statusTone: 'ready' as const,
    initialDraft: options.initialDraft ?? 'draft',
    initialMode: undefined,
    initialSkillVersionIds: undefined,
    hasMessages: false,
    chatPinned: false,
    chatPinDisabled: false
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
      chatPinned: Boolean,
      chatPinDisabled: Boolean
    },
    emits: ['draftChange', 'compositionChange', 'send', 'stop', 'manageSkills', 'retrySkills', 'updateSkillPreferences', 'update:chatPinned'],
    setup(props, { emit, expose }) {
      return evaluateComposer({
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
    },
    render: renderAgentComposer
  })
  const statusIndicator = Vue.defineComponent({
    props: {
      label: String
    },
    setup(props) {
      return () => Vue.h('span', { 'aria-label': props.label })
    }
  })
  const app = Vue.createApp(composerComponent, componentProps)
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.component('StatusIndicator', statusIndicator)
  app.mount(host)
  for (const element of host.querySelectorAll<HTMLElement>('*')) element.setAttribute(composerScopeAttribute, '')
  const root = host.querySelector<HTMLElement>('.agent-composer')
  if (!root) throw new Error('Agent composer did not render')
  const unmount = (): void => {
    app.unmount()
    host.remove()
  }
  mountedComposers.push(unmount)
  return { root, unmount }
}

const press = (composer: ComposerHarness, key: string, options?: KeyOptions): KeyboardEvent & { wasPrevented: () => boolean } => {
  const event = makeEvent(key, options)
  composer.handleKeydown(event)
  return event
}
afterEach(() => {
  for (const unmount of mountedComposers.splice(0)) unmount()
  document.body.replaceChildren()
})

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
  it('does not submit a non-empty draft while the composer is disabled', () => {
    const disabled = loadComposer({ disabled: true })
    disabled.draft.value = 'keep this draft'

    disabled.submit()

    expect(disabled.sent).toHaveLength(0)
    expect(disabled.draft.value).toBe('keep this draft')
  })
})

describe('Agent composer chat pin semantics', () => {
  it('emits a pin update while an active run has disabled the composer', () => {
    const activeRun = loadComposer({ disabled: true, sending: true, canStop: true })

    activeRun.toggleChatPinned()

    expect(activeRun.pinnedEvents).toEqual([true])
  })

  it('guards the pin update while workspace selection is unsettled', () => {
    const unsettled = loadComposer({ chatPinDisabled: true })

    unsettled.toggleChatPinned()

    expect(unsettled.pinnedEvents).toHaveLength(0)
  })

  it('emits an unpin update from the selected tonal state', () => {
    const pinned = loadComposer({ chatPinned: true })

    pinned.toggleChatPinned()

    expect(pinned.pinnedEvents).toEqual([false])
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
