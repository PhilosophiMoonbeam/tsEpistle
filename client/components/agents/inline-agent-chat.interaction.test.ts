import fs from 'node:fs'
import path from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'
import { caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret } from './agent-composer-sizing.ts'

const componentPath = path.join(process.cwd(), 'client/components/agents/inline-agent-chat.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const descriptor = parse(componentSource, { filename: componentPath }).descriptor
if (!descriptor.template || !descriptor.scriptSetup) throw new Error('inline-agent-chat.vue template and setup script are required')

const composerComponentPath = path.join(process.cwd(), 'client/components/agents/agent-composer.vue')
const composerComponentSource = fs.readFileSync(composerComponentPath, 'utf8')
const composerDescriptor = parse(composerComponentSource, { filename: composerComponentPath }).descriptor
if (!composerDescriptor.template || !composerDescriptor.scriptSetup) throw new Error('agent-composer.vue template and setup script are required')
const composerStyles = composerDescriptor.styles.map(style => style.content).join('\n')

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/'
})
const browserWindow = dom.window
const css = { escape: (value: string) => value, supports: () => false }
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
class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
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
  IntersectionObserver: ObserverStub,
  KeyboardEvent: browserWindow.KeyboardEvent,
  MouseEvent: browserWindow.MouseEvent,
  MutationObserver: browserWindow.MutationObserver,
  Node: browserWindow.Node,
  ResizeObserver: ObserverStub,
  SVGElement: browserWindow.SVGElement,
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

// Vuetify snapshots browser capabilities during module evaluation, so the DOM must exist before loading it here.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')

const compiledTemplate = compileTemplate({
  source: descriptor.template.content,
  filename: componentPath,
  id: 'inline-agent-chat-interaction-test',
  compilerOptions: { mode: 'function' }
})
if (compiledTemplate.errors.length > 0) throw compiledTemplate.errors[0]
const renderInlineAgent = new Function('Vue', compiledTemplate.code)(Vue) as () => unknown
const compiledComposerTemplate = compileTemplate({
  source: composerDescriptor.template.content,
  filename: composerComponentPath,
  id: 'agent-composer-interaction-test',
  compilerOptions: { mode: 'function' }
})
if (compiledComposerTemplate.errors.length > 0) throw compiledComposerTemplate.errors[0]
const renderAgentComposer = new Function('Vue', compiledComposerTemplate.code)(Vue) as () => unknown

interface ValueRef<T> {
  value: T
}

interface LockState {
  activeRun: ValueRef<{ canCancel: boolean; status: string } | null>
  canPinCurrentChat: ValueRef<boolean>
  canSubmit: ValueRef<boolean>
  composerFocused: ValueRef<boolean>
  invocationLimit: ValueRef<number>
  connectionLabel: ValueRef<string>
  connectionTone: ValueRef<string>
  handleComposerFocusIn: () => void
  handleComposerFocusOut: (event: FocusEvent) => void
  handleTranscriptEngagement: (event: FocusEvent | PointerEvent) => void
  openGoal: ValueRef<{ status: string } | null>
  goalSubmitUnavailableReason: ValueRef<string>
  submitUnavailableReason: ValueRef<string>
  sessionMutationBusy: ValueRef<boolean>
  agentCalls: {
    clearUnfiledHistory: (...args: unknown[]) => unknown
    initialize: (...args: unknown[]) => unknown
    newSession: (...args: unknown[]) => unknown
    reloadSessions: (...args: unknown[]) => unknown
    send: (...args: unknown[]) => unknown
    setCurrentChatPinned: (...args: unknown[]) => unknown
  }
  clearUnfiledCommitted: ValueRef<boolean>
  clearUnfiledError: ValueRef<string>
  clearUnfiledHistory: () => Promise<void>
  clearUnfiledHistoryOpen: ValueRef<boolean>
  newSession: () => Promise<void>
  newTemporarySession: () => Promise<void>
  openClearUnfiledHistory: () => void
  recoverClearUnfiledHistory: () => Promise<void>
  thread: ValueRef<Record<string, unknown> | null>
  sendPrompt: (content: string) => Promise<boolean>
}

const removeSetupMacro = (content: string, macroName: string): string => {
  const match = new RegExp(`(^|\\n)[ \\t]*${macroName}\\s*\\(`).exec(content)
  if (!match) return content
  const statementStart = match.index + (match[1] === '\n' ? 1 : 0)
  const start = statementStart + match[0].length - (match[1] === '\n' ? 1 : 0) - 1
  let depth = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = start; index < content.length; index += 1) {
    const character = content[index]
    const next = content[index + 1]
    if (lineComment) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '(') {
      depth += 1
      continue
    }
    if (character === ')') {
      depth -= 1
      if (depth === 0) {
        let end = index + 1
        while (/\s/.test(content[end] ?? '')) end += 1
        if (content[end] === ';') end += 1
        return `${content.slice(0, statementStart)}${content.slice(end)}`
      }
    }
  }
  return content
}

const setupScript = removeSetupMacro(descriptor.scriptSetup.content, 'defineExpose')
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(setupScript.replace(/^import .*$/gm, ''))
const composerScript = composerDescriptor.scriptSetup.content
const executableComposerScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(composerScript.replace(/^import .*$/gm, ''))
const composerBindingNames = Array.from(composerScript.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm), match => match[1])
const evaluateComposer = new Function(
  'computed',
  'nextTick',
  'onBeforeUnmount',
  'onMounted',
  'ref',
  'useTemplateRef',
  'useId',
  'watch',
  'defineProps',
  'defineEmits',
  'defineExpose',
  'filterPreferredBuiltInSkills',
  'filterSkillsForCommand',
  'filterUserSelectableSkills',
  'caretBoundsFromMirror',
  'calculateComposerSizing',
  'scrollTopForCaret',
  `${executableComposerScript}\nreturn { ${composerBindingNames.join(', ')} }`
) as (...dependencies: unknown[]) => Record<string, unknown>

const loadGoalLockState = (
  status: 'active' | 'paused' | null,
  mutationBusy = false,
  runStatus: 'running' | 'awaiting_approval' | null = status === 'active' ? 'running' : null,
  canPinCurrentChat = true
): LockState => {
  const ref = <T>(value: T): ValueRef<T> => Vue.ref(value) as ValueRef<T>
  const thread = ref({
    session: {
      id: 'session-1',
      title: 'Release planning',
      skills: [],
      currentRun: runStatus ? { canCancel: true, status: runStatus } : null,
      folderId: null
    },
    messages: [],
    tools: [],
    artifacts: [],
    proposals: [],
    goal: status ? { id: 'goal-1', status } : null
  })
  const storeRefs = {
    connection: ref('connected'),
    canPinCurrentChat: ref(canPinCurrentChat),
    decidingApprovalId: ref(null),
    error: ref(''),
    goalBusy: ref(false),
    loading: ref(false),
    pinnedSessionId: ref<string | null>(null),
    pinStorageAvailable: ref(true),
    profiles: ref([{ id: 'profile-1' }]),
    sending: ref(false),
    sessionMutationBusy: ref(mutationBusy),
    sessions: ref([]),
    skills: ref([]),
    skillsLoadError: ref(''),
    skillsLoading: ref(false),
    skillsPartial: ref(false),
    thread
  }
  const props = {
    csrfToken: 'csrf',
    ownerId: 2,
    resumeSessionId: undefined,
    providerEnabled: true,
    skillsEnabled: true,
    goalsEnabled: true,
    pageId: 0,
    pageLocale: '',
    pagePath: '',
    pageUpdatedAt: ''
  }
  const agentCalls = {
    clearUnfiledHistory: vi.fn(() => Promise.resolve()),
    initialize: vi.fn(() => Promise.resolve(true)),
    newSession: vi.fn(() => Promise.resolve(true)),
    reloadSessions: vi.fn(() => Promise.resolve()),
    send: vi.fn(() => Promise.resolve(true)),
    setCurrentChatPinned: vi.fn()
  }
  const evaluate = new Function(
    '{ computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, useId, watch, storeToRefs, defineProps, defineEmits, useAgentsStore, activeOwnedOverlayRoots, createModalFocusScope, isAgentApprovalOutsideViewport, shouldFollowGoalExpansion }',
    `${executableScript}\nreturn { activeRun, canPinCurrentChat, canSubmit, clearUnfiledCommitted, clearUnfiledError, clearUnfiledHistory, clearUnfiledHistoryOpen, composerFocused, connectionLabel, connectionTone, ensureInitialized, goalSubmitUnavailableReason, handleComposerFocusIn, handleComposerFocusOut, handleTranscriptEngagement, invocationLimit, newSession, newTemporarySession, openGoal, openClearUnfiledHistory, recoverClearUnfiledHistory, retryInitialization, sendPrompt, sessionMutationBusy, submitUnavailableReason, thread }`
  ) as (dependencies: Record<string, unknown>) => LockState

  const state = evaluate({
    computed: (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    nextTick: () => Promise.resolve(),
    onBeforeUnmount: () => undefined,
    onMounted: () => undefined,
    ref,
    useTemplateRef: () => ref(null),
    useId: () => 'agent-test',
    watch: () => undefined,
    storeToRefs: () => storeRefs,
    defineEmits: () => () => undefined,
    defineProps: () => props,
    useAgentsStore: () => agentCalls,
    activeOwnedOverlayRoots: () => [],
    createModalFocusScope: () => ({ deactivate: () => undefined }),
    isAgentApprovalOutsideViewport: () => false,
    shouldFollowGoalExpansion: () => false
  }) as LockState
  return { ...state, agentCalls }
}

interface MountedInlineAgent {
  activator: HTMLElement
  composerFocused: ValueRef<boolean>
  historyOpen: ValueRef<boolean>
  memoryOpen: ValueRef<boolean>
  root: HTMLElement
  transcriptFollowing: ValueRef<boolean>
  unmount: () => void
}

const mountedApps: Array<() => void> = []
const settle = async (): Promise<void> => {
  await Vue.nextTick()
  await Vue.nextTick()
}

const mountInlineAgent = (
  lockState?: LockState,
  options: { readonly approvalJumpVisible?: boolean; readonly followJumpVisible?: boolean; readonly isTemporary?: boolean } = {}
): MountedInlineAgent => {
  const host = document.createElement('div')
  document.body.append(host)
  const historyOpen = Vue.ref(false)
  const memoryOpen = Vue.ref(false)
  const panelMenuOpen = Vue.ref(false)
  const composerFocused = lockState?.composerFocused ?? Vue.ref(false)
  const handleComposerFocusIn =
    lockState?.handleComposerFocusIn ??
    (() => {
      composerFocused.value = true
    })
  const handleComposerFocusOut =
    lockState?.handleComposerFocusOut ??
    ((event: FocusEvent) => {
      const nextTarget = event.relatedTarget
      const currentTarget = event.currentTarget
      if (!(currentTarget instanceof HTMLElement) || !(nextTarget instanceof Node) || !currentTarget.contains(nextTarget)) composerFocused.value = false
    })
  const handleComposerPointerDown = (): void => {
    composerFocused.value = true
  }
  const handleTranscriptEngagement =
    lockState?.handleTranscriptEngagement ??
    ((event: FocusEvent | PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.inline-agent__composer')) return
      composerFocused.value = false
    })
  const transcriptFollowing = Vue.ref(true)
  const goal = lockState?.openGoal.value ?? null
  const thread = lockState?.thread.value ?? null
  const context: Record<string, unknown> = {
    csrfToken: 'csrf',
    ownerId: 2,
    resumeSessionId: undefined,
    approvalId: undefined,
    providerEnabled: true,
    skillsEnabled: false,
    goalsEnabled: true,
    pageId: 0,
    pageLocale: '',
    pagePath: '',
    pageUpdatedAt: '',
    loading: false,
    sending: false,
    sessionMutationBusy: lockState?.sessionMutationBusy.value ?? false,
    connection: 'connected',
    error: '',
    pinStorageAvailable: true,
    canPinCurrentChat: lockState?.canPinCurrentChat.value ?? true,
    decidingApprovalId: null,
    goalBusy: false,
    profiles: [{}],
    sessions: [],
    skills: [],
    skillsLoadError: '',
    skillsLoading: false,
    skillsPartial: false,
    thread,
    workspaceTitleId: 'agent-test-workspace-title',
    historyHeadingId: 'agent-test-history-title',
    historyDescriptionId: 'agent-test-history-description',
    memoryHeadingId: 'agent-test-memory-title',
    memoryDescriptionId: 'agent-test-memory-description',
    historyOpen,
    memoryOpen,
    panelMenuOpen,
    memoryMutationBusy: false,
    panelMode: 'modal',
    initializationError: '',
    clearUnfiledHistoryOpen: false,
    clearingUnfiledHistory: false,
    clearUnfiledCommitted: false,
    clearUnfiledError: '',
    goalExpanded: false,
    approvalJumpVisible: options.approvalJumpVisible ?? false,
    followJumpVisible: options.followJumpVisible ?? false,
    skillManagerOpen: false,
    currentPage: null,
    activeRun: lockState?.activeRun.value ?? null,
    openGoal: goal,
    hasConversation: Boolean(goal),
    providerAvailable: true,
    providerUnavailableMessage: '',
    canSubmit: lockState?.canSubmit.value ?? true,
    goalSubmitUnavailableReason: lockState?.goalSubmitUnavailableReason.value ?? '',
    submitUnavailableReason: lockState?.submitUnavailableReason.value ?? '',
    transcriptFollowing,
    invocationLimit: lockState?.invocationLimit.value ?? 8,
    composerFocused,
    handleComposerFocusIn,
    handleComposerFocusOut,
    handleComposerPointerDown,
    handleTranscriptEngagement,
    sessionTitle: 'Release planning',
    connectionLabel: lockState?.connectionLabel.value ?? 'Ready',
    connectionTone: lockState?.connectionTone.value ?? 'ready',
    starters: [
      {
        label: 'Explore the Wiki',
        description: 'Find a place to begin',
        prompt: 'Give me an overview of the main topics in the Wiki, with links to useful starting pages.',
        icon: 'mdi-compass-outline'
      },
      {
        label: 'Connect the Dots',
        description: 'Discover related knowledge',
        prompt: 'Help me explore connections between topics in the Wiki. Ask me which topic I want to start with.',
        icon: 'mdi-vector-link'
      },
      {
        label: 'Catch Up',
        description: 'See what changed recently',
        prompt: 'Summarize the most recently updated Wiki pages I can access.',
        icon: 'mdi-history'
      }
    ],
    emit: () => undefined,
    agents: { drafts: {}, setDraft: () => undefined },
    setCurrentChatPinned: () => undefined,
    creatingRetention: null,
    keepingConversation: false,
    isTemporary: options.isTemporary ?? false,
    temporaryExpiry: '',
    sessionNotice: '',
    closePanels: () => {
      historyOpen.value = false
      memoryOpen.value = false
    },
    closeHistory: () => {
      historyOpen.value = false
    },
    toggleHistory: () => {
      panelMenuOpen.value = false
      historyOpen.value = !historyOpen.value
      memoryOpen.value = false
    },
    toggleMemory: () => {
      panelMenuOpen.value = false
      memoryOpen.value = !memoryOpen.value
      historyOpen.value = false
    }
  }
  for (const method of [
    'clearUnfiledHistory',
    'closeClearUnfiledHistory',
    'handleGoalExpanded',
    'handleTranscriptScroll',
    'jumpToApproval',
    'newSession',
    'newTemporarySession',
    'openClearUnfiledHistory',
    'openSkillManager',
    'recoverClearUnfiledHistory',
    'retryInitialization',
    'scrollToLatest',
    'sendPrompt',
    'updateMemoryOpen'
  ])
    context[method] = () => undefined

  const componentStub = Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs }) {
      return () => Vue.h('div', attrs)
    }
  })
  const composerComponent = Vue.defineComponent({
    name: 'AgentComposerInteractionHarness',
    props: {
      sessionId: String,
      initialDraft: String,
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
      hasMessages: Boolean,
      chatPinned: Boolean,
      chatPinDisabled: Boolean,
      externalDescriptionId: String
    },
    emits: ['send', 'stop', 'manageSkills', 'retrySkills', 'updateSkillPreferences', 'update:chatPinned', 'draftChange'],
    setup(props, { emit, expose }) {
      return evaluateComposer(
        Vue.computed,
        Vue.nextTick,
        Vue.onBeforeUnmount,
        Vue.onMounted,
        Vue.ref,
        Vue.useTemplateRef,
        Vue.useId,
        Vue.watch,
        () => props,
        () => emit,
        expose,
        filterPreferredBuiltInSkills,
        filterSkillsForCommand,
        filterUserSelectableSkills,
        caretBoundsFromMirror,
        calculateComposerSizing,
        scrollTopForCaret
      )
    },
    render: renderAgentComposer
  })
  const inlineHarness = Vue.defineComponent({
    name: 'InlineAgentInteractionHarness',
    render: renderInlineAgent,
    setup: () => context
  })
  const app = Vue.createApp(inlineHarness)
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  for (const name of ['AgentGoalStatus', 'AgentHistoryPanel', 'AgentMcpApproval', 'AgentMemoryManager', 'AgentPersonalSkills', 'AgentThread'])
    app.component(name, componentStub)
  app.component('AgentComposer', composerComponent)
  app.mount(host)

  const root = host.querySelector<HTMLElement>('.inline-agent')
  const activator = host.querySelector<HTMLElement>('[aria-label="Open Agent panels: conversation history and memory"]')
  if (!root || !activator) throw new Error('Inline Agent mobile panel controls did not render')
  const unmount = (): void => {
    app.unmount()
    host.remove()
  }
  mountedApps.push(unmount)
  return { activator, composerFocused, historyOpen, memoryOpen, root, transcriptFollowing, unmount }
}

const resolveDescribedBy = (control: HTMLElement): HTMLElement[] => {
  const ids = control.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? []
  const descriptions = ids.map(id => document.getElementById(id))
  expect(ids.length).toBeGreaterThan(0)
  expect(descriptions.every((description): description is HTMLElement => Boolean(description))).toBe(true)
  return descriptions.filter((description): description is HTMLElement => Boolean(description))
}

const expectComposerActionStructure = (mounted: MountedInlineAgent): { primary: HTMLElement; status: HTMLElement } => {
  const actions = mounted.root.querySelector<HTMLElement>('.agent-composer__actions')
  if (!actions) throw new Error('Agent composer actions did not render')

  const context = actions.querySelector<HTMLElement>('.agent-composer__context-controls')
  const primary = actions.querySelector<HTMLElement>('.agent-composer__primary-actions')
  const status = mounted.root.querySelector<HTMLElement>('.agent-composer__live-status')
  if (!context || !primary || !status) throw new Error('Agent composer accessible status or controls did not render')
  expect(actions.children).toHaveLength(2)
  expect(context.getAttribute('role')).toBe('group')
  expect(context.getAttribute('aria-label')).toBe('Conversation context controls')
  expect(status.id).not.toBe('')
  expect(status.matches('.sr-only')).toBe(true)
  expect(status.getAttribute('role')).toBe('status')
  expect(status.getAttribute('aria-live')).toBe('polite')
  expect(status.getAttribute('aria-atomic')).toBe('true')
  expect(primary.matches('.agent-composer__primary-actions')).toBe(true)
  expect(primary.getAttribute('role')).toBe('group')
  expect(primary.getAttribute('aria-label')).toBe('Message actions')
  expect(primary.previousElementSibling).toBe(context)

  const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
  if (!textarea) throw new Error('Agent composer input did not render')
  expect(resolveDescribedBy(textarea)).toContain(status)
  return { primary, status }
}

const openPanelMenu = async (mounted: MountedInlineAgent): Promise<HTMLElement[]> => {
  expect(mounted.activator.getAttribute('role')).not.toBe('menu')
  expect(mounted.activator.getAttribute('aria-haspopup')).toBe('menu')
  expect(mounted.activator.getAttribute('aria-expanded')).toBe('false')

  mounted.activator.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  expect(mounted.activator.getAttribute('aria-expanded')).toBe('true')
  expect(mounted.activator.getAttribute('aria-controls')).toBeTruthy()

  const list = mounted.root.querySelector<HTMLElement>('.v-menu .v-list')
  expect(list?.getAttribute('role')).toBe('list')
  expect(list?.getAttribute('role')).not.toBe('menu')
  const items = Array.from(mounted.root.querySelectorAll<HTMLElement>('.inline-agent__panel-menu-item'))
  expect(items.map(item => item.querySelector<HTMLElement>('.v-list-item-title')?.textContent?.trim())).toEqual(['Conversation history', 'Agent memory'])
  expect(items.every(item => item.getAttribute('role') === 'listitem')).toBe(true)
  expect(items.every(item => item.getAttribute('role') !== 'menu')).toBe(true)
  expect(items.every(item => item.hasAttribute('tabindex'))).toBe(true)
  return items
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  document.body.replaceChildren()
})

describe('Inline Agent mobile panel controls', () => {
  it('keeps both History and Memory pointer-activatable and closes the menu', async () => {
    for (const [index, panel] of [
      [0, 'history'],
      [1, 'memory']
    ] as const) {
      const mounted = mountInlineAgent()
      const items = await openPanelMenu(mounted)
      const item = items[index]
      if (!item) throw new Error(`Panel menu item ${index} did not render`)

      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await settle()

      expect(mounted.historyOpen.value).toBe(panel === 'history')
      expect(mounted.memoryOpen.value).toBe(panel === 'memory')
      expect(mounted.activator.getAttribute('aria-expanded')).toBe('false')
      mounted.unmount()
      mountedApps.pop()
    }
  })
})

describe('Inline Agent workspace actions', () => {
  it('keeps History and Memory available and exposes direct New and Temporary controls', async () => {
    const mounted = mountInlineAgent()
    const actions = Array.from(mounted.root.querySelectorAll<HTMLElement>('.inline-agent__desktop-panel-btn, .inline-agent__session-action'))

    expect(actions.map(action => action.getAttribute('aria-label'))).toEqual([
      'Open agent conversation history',
      'Manage agent memory',
      'New conversation',
      'Temporary conversation'
    ])
    expect(mounted.activator.textContent?.trim()).toContain('Panels')
    const newConversation = mounted.root.querySelector<HTMLElement>('.inline-agent__new-session')
    const temporaryConversation = mounted.root.querySelector<HTMLElement>('.inline-agent__temporary-session')
    const close = mounted.root.querySelector<HTMLElement>('.inline-agent__mobile-close')
    if (!newConversation || !temporaryConversation || !close) throw new Error('Session action controls did not render')
    expect(newConversation.textContent?.trim()).toBe('New')
    expect(newConversation.classList.contains('rounded-pill')).toBe(true)
    expect(newConversation.hasAttribute('aria-haspopup')).toBe(false)
    expect(newConversation.hasAttribute('aria-expanded')).toBe(false)
    expect(newConversation.classList.contains('v-btn--variant-tonal')).toBe(true)
    expect(temporaryConversation.classList.contains('v-btn--variant-text')).toBe(true)
    expect(temporaryConversation.classList.contains('v-btn--variant-tonal')).toBe(false)
    expect(temporaryConversation.getAttribute('title')).toBe('Start a temporary conversation')
    expect(temporaryConversation.classList.contains('inline-agent__temporary-session--active')).toBe(false)
    expect(temporaryConversation.getAttribute('aria-pressed')).toBe('false')
    expect(temporaryConversation.getAttribute('data-state')).toBeNull()
    expect(temporaryConversation.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const active = mountInlineAgent(undefined, { isTemporary: true })
    const activeTemporary = active.root.querySelector<HTMLElement>('.inline-agent__temporary-session')
    if (!activeTemporary) throw new Error('Active temporary conversation control did not render')
    expect(activeTemporary.classList.contains('inline-agent__temporary-session--active')).toBe(true)
    expect(activeTemporary.getAttribute('aria-pressed')).toBe('true')
    expect(activeTemporary.getAttribute('data-state')).toBe('active')
    expect(activeTemporary.classList.contains('v-btn--variant-text')).toBe(true)
    expect(activeTemporary.classList.contains('v-btn--variant-tonal')).toBe(false)
    expect(activeTemporary.getAttribute('title')).toBe('Current temporary conversation')

    await openPanelMenu(mounted)
  })

  it('renders distinct desktop and mobile workspace titles', () => {
    const mounted = mountInlineAgent()
    const title = mounted.root.querySelector<HTMLElement>('.inline-agent__heading h2')
    const wideTitle = mounted.root.querySelector<HTMLElement>('.inline-agent__workspace-title--wide')
    const compactTitle = mounted.root.querySelector<HTMLElement>('.inline-agent__workspace-title--compact')
    if (!title || !wideTitle || !compactTitle) throw new Error('Responsive workspace title did not render')

    expect(wideTitle.textContent?.trim()).toBe('Wiki Agent')
    expect(compactTitle.textContent?.trim()).toBe('Agent')
  })

  it('creates temporary and saved conversations with distinct retention', async () => {
    const lockState = loadGoalLockState(null)

    await lockState.newTemporarySession()
    await lockState.newSession()

    expect(lockState.agentCalls.newSession).toHaveBeenNthCalledWith(1, 'temporary')
    expect(lockState.agentCalls.newSession).toHaveBeenNthCalledWith(2, 'saved')
  })

  it('keeps the workspace composer mounted beneath the labelled session controls', () => {
    const mounted = mountInlineAgent()
    expect(mounted.root.querySelector('.inline-agent__composer')).not.toBeNull()
    expect(mounted.root.querySelector('.inline-agent__session-action')?.textContent?.trim()).toBe('New')
    expect(mounted.root.querySelector('.agent-composer__input textarea')).not.toBeNull()
  })

  it('centers the welcome heading above exactly three starter cards without supporting copy', () => {
    const mounted = mountInlineAgent(loadGoalLockState(null))
    const heading = mounted.root.querySelector<HTMLElement>('.inline-agent__welcome h2')
    const copy = mounted.root.querySelector<HTMLElement>('.inline-agent__welcome-copy')
    const starterGroup = mounted.root.querySelector<HTMLElement>('.inline-agent__starters')
    const starters = Array.from(mounted.root.querySelectorAll<HTMLElement>('.inline-agent__starter'))
    if (!heading || !starterGroup) throw new Error('Welcome starter cards did not render')

    expect(heading.textContent?.trim()).toBe('A little curiosity, a clearer picture')
    expect(copy).toBeNull()
    expect(mounted.root.textContent).not.toContain('Explore an idea, connect the dots, or work on your wiki.')
    expect(starterGroup.getAttribute('role')).toBe('group')
    expect(starterGroup.getAttribute('aria-label')).toBe('Conversation starters')
    expect(heading.nextElementSibling).toBe(starterGroup)
    expect(starters).toHaveLength(3)
    expect(starters.map(starter => starter.querySelector<HTMLElement>('.inline-agent__starter-heading strong')?.textContent?.trim())).toEqual([
      'Explore the Wiki',
      'Connect the Dots',
      'Catch Up'
    ])
    expect(mounted.root.querySelector('.inline-agent__welcome-mark')).toBeNull()
    expect(mounted.root.querySelector('.inline-agent__welcome-index')).toBeNull()
    expect(mounted.root.querySelector('.inline-agent__avatar .mdi-creation-outline')).not.toBeNull()
  })

  it('keeps the composer glassy while scrolled until real editing focus, then clears on transcript engagement', async () => {
    const lockState = loadGoalLockState(null)
    const mounted = mountInlineAgent(lockState)
    const getComposerDock = (): HTMLElement => {
      const dock = mounted.root.querySelector<HTMLElement>('.inline-agent__composer')
      if (!dock) throw new Error('Composer dock did not render')
      return dock
    }
    const getTranscript = (): HTMLElement => {
      const transcript = mounted.root.querySelector<HTMLElement>('.inline-agent__transcript')
      if (!transcript) throw new Error('Composer transcript did not render')
      return transcript
    }
    const getTextarea = (): HTMLTextAreaElement => {
      const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
      if (!textarea) throw new Error('Composer textarea did not render')
      return textarea
    }
    getTranscript()
    getTextarea()
    await settle()
    const initialTranscript = getTranscript()
    initialTranscript.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    initialTranscript.focus()
    expect(document.activeElement).toBe(initialTranscript)
    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(false)
    mounted.transcriptFollowing.value = false
    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--scrolled')).toBe(true)
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(false)

    getComposerDock().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))

    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(false)

    const focusedTextarea = getTextarea()
    focusedTextarea.focus()
    expect(document.activeElement).toBe(focusedTextarea)
    lockState.handleComposerFocusIn()
    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(true)
    const editingTranscript = getTranscript()
    const transcriptPointerEvent = new MouseEvent('pointerdown', { bubbles: true }) as unknown as PointerEvent
    editingTranscript.dispatchEvent(transcriptPointerEvent)
    lockState.handleTranscriptEngagement(transcriptPointerEvent)
    editingTranscript.focus()
    expect(document.activeElement).toBe(editingTranscript)
    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(false)

    const refocusedTextarea = getTextarea()
    refocusedTextarea.focus()
    expect(document.activeElement).toBe(refocusedTextarea)
    lockState.handleComposerFocusIn()
    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(true)
    const refocusTranscript = getTranscript()
    refocusTranscript.focus()
    expect(document.activeElement).toBe(refocusTranscript)
    const transcriptFocusEvent = new FocusEvent('focusin', { bubbles: true })
    refocusTranscript.dispatchEvent(transcriptFocusEvent)
    lockState.handleTranscriptEngagement(transcriptFocusEvent)
    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(false)

    const disabledState = loadGoalLockState('active')
    const disabledMounted = mountInlineAgent(disabledState)
    const getDisabledComposerDock = (): HTMLElement => {
      const dock = disabledMounted.root.querySelector<HTMLElement>('.inline-agent__composer')
      if (!dock) throw new Error('Disabled composer dock did not render')
      return dock
    }
    const getDisabledTextarea = (): HTMLTextAreaElement => {
      const textarea = disabledMounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
      if (!textarea) throw new Error('Disabled composer textarea did not render')
      return textarea
    }
    disabledMounted.transcriptFollowing.value = false
    await settle()
    getDisabledTextarea().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await settle()
    expect(getDisabledComposerDock().classList.contains('inline-agent__composer--focused')).toBe(false)
  })
})

describe('Inline Agent clear-unfiled confirmation', () => {
  it('consumes the clear event and invokes only the clear-unfiled store action', async () => {
    const lockState = loadGoalLockState(null)

    lockState.openClearUnfiledHistory()
    expect(lockState.clearUnfiledHistoryOpen.value).toBe(true)
    await lockState.clearUnfiledHistory()

    expect(lockState.agentCalls.clearUnfiledHistory).toHaveBeenCalledTimes(1)
    expect(lockState.clearUnfiledHistoryOpen.value).toBe(false)
  })

  it('keeps recovery open and retries a new saved conversation after a committed clear', async () => {
    const lockState = loadGoalLockState(null)
    lockState.agentCalls.clearUnfiledHistory = vi.fn(() => {
      lockState.thread.value = null
      return Promise.resolve()
    })

    lockState.openClearUnfiledHistory()
    await lockState.clearUnfiledHistory()

    expect(lockState.clearUnfiledCommitted.value).toBe(true)
    expect(lockState.clearUnfiledHistoryOpen.value).toBe(true)
    expect(lockState.clearUnfiledError.value).toContain('Saved folders and their filed conversations remain unchanged.')

    await lockState.recoverClearUnfiledHistory()

    expect(lockState.agentCalls.reloadSessions).toHaveBeenCalledTimes(1)
    expect(lockState.agentCalls.newSession).toHaveBeenLastCalledWith('saved')
    expect(lockState.clearUnfiledHistoryOpen.value).toBe(true)
  })
})
describe('Inline Agent panel semantics', () => {
  it('exposes the computed mode and labelled panel roots without hiding the workspace', async () => {
    const mounted = mountInlineAgent()
    expect(mounted.root.getAttribute('data-panel-mode')).toBe('modal')
    expect(mounted.root.querySelector('.inline-agent__composer')).not.toBeNull()

    mounted.historyOpen.value = true
    await settle()

    const history = mounted.root.querySelector<HTMLElement>('.inline-agent__side--history')
    expect(history?.getAttribute('role')).toBe('dialog')
    expect(history?.getAttribute('aria-labelledby')).toBe('agent-test-history-title')
    expect(history?.getAttribute('aria-describedby')).toBe('agent-test-history-description')
  })
})

describe('Inline Agent latest response dock', () => {
  it('keeps the compact latest response face in the sticky conversation dock with an accessible halo', () => {
    const mounted = mountInlineAgent(undefined, { followJumpVisible: true })
    const body = mounted.root.querySelector<HTMLElement>('.inline-agent__body')
    const dock = mounted.root.querySelector<HTMLElement>('.inline-agent__jump-dock')
    const composer = mounted.root.querySelector<HTMLElement>('.inline-agent__composer')
    const button = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__follow-jump')
    const face = mounted.root.querySelector<HTMLElement>('.inline-agent__follow-jump-face')
    const halo = mounted.root.querySelector<HTMLElement>('.inline-agent__follow-jump-halo')

    if (!body || !dock || !composer || !button || !face || !halo) throw new Error('Latest response control did not render')
    const conversationDock = dock.parentElement
    if (!conversationDock) throw new Error('Sticky conversation dock did not render')
    expect(body.contains(conversationDock)).toBe(true)
    expect(conversationDock.classList.contains('inline-agent__conversation-dock')).toBe(true)
    expect(dock.nextElementSibling).toBe(composer)
    expect(button.getAttribute('aria-label')).toBe('Jump to latest response')
    expect(button.textContent?.trim()).toBe('Latest response')
    expect(button.querySelectorAll('button')).toHaveLength(0)
    expect(face.textContent?.trim()).toBe('Latest response')
    expect(halo.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps approval navigation ahead of latest response navigation', () => {
    const mounted = mountInlineAgent(undefined, { approvalJumpVisible: true, followJumpVisible: true })
    const dock = mounted.root.querySelector<HTMLElement>('.inline-agent__jump-dock')

    expect(dock?.querySelector('.inline-agent__approval-jump')?.textContent?.trim()).toBe('Approval required')
    expect(dock?.querySelector('.inline-agent__follow-jump')).toBeNull()
  })
})

describe('Agent composer action semantics', () => {
  it('keeps the accessible live status before the Send action and exposes Pin', () => {
    const mounted = mountInlineAgent()
    const { primary, status } = expectComposerActionStructure(mounted)
    const submit = primary.querySelector<HTMLButtonElement>('.agent-composer__submit')
    const pin = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__chat-pin')

    expect(status.textContent?.trim()).toBe('Ready')
    expect(primary.children).toHaveLength(1)
    expect(submit?.tagName).toBe('BUTTON')
    expect(submit?.textContent?.trim()).toBe('Send')
    expect(primary.querySelector('.agent-composer__stop')).toBeNull()
    expect(pin?.textContent?.trim()).toBe('Pin')
    expect(pin?.getAttribute('aria-label')).toBe('Pin conversation')
    expect(pin?.hasAttribute('disabled')).toBe(false)
    expect(mounted.root.querySelector('.agent-composer__hint')).toBeNull()
  })

  it('keeps the accessible Working status before the Stop action while Pin stays enabled', () => {
    const mounted = mountInlineAgent(loadGoalLockState('active'))
    const { primary, status } = expectComposerActionStructure(mounted)
    const stop = primary.querySelector<HTMLButtonElement>('.agent-composer__stop')
    const pin = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__chat-pin')

    expect(status.textContent?.trim()).toBe('Working')
    expect(primary.children).toHaveLength(1)
    expect(stop?.tagName).toBe('BUTTON')
    expect(stop?.textContent?.trim()).toBe('Stop response')
    expect(primary.querySelector('.agent-composer__submit')).toBeNull()
    expect(pin?.getAttribute('aria-pressed')).toBe('false')
    expect(pin?.hasAttribute('disabled')).toBe(false)
  })
  it('disables Pin only while workspace selection is unsettled', () => {
    const unsettled = mountInlineAgent(loadGoalLockState(null, false, null, false))
    const unsettledPin = unsettled.root.querySelector<HTMLButtonElement>('.agent-composer__chat-pin')
    expect(unsettledPin?.disabled).toBe(true)

    const activeRun = mountInlineAgent(loadGoalLockState(null, false, 'running', true))
    const activeRunPin = activeRun.root.querySelector<HTMLButtonElement>('.agent-composer__chat-pin')
    expect(activeRunPin?.disabled).toBe(false)

    const activeGoal = mountInlineAgent(loadGoalLockState('active', false, 'running', true))
    const activeGoalPin = activeGoal.root.querySelector<HTMLButtonElement>('.agent-composer__chat-pin')
    expect(activeGoalPin?.disabled).toBe(false)
  })

  it('keeps Review needed immediately before Stop while awaiting approval', () => {
    const mounted = mountInlineAgent(loadGoalLockState('active', false, 'awaiting_approval'))
    const { primary, status } = expectComposerActionStructure(mounted)
    const stop = primary.querySelector<HTMLButtonElement>('.agent-composer__stop')

    expect(status.textContent?.trim()).toBe('Review needed')
    expect(stop?.textContent?.trim()).toBe('Stop response')
    expect(primary.querySelector('.agent-composer__submit')).toBeNull()
  })
})

describe('Inline Agent goal submission lock', () => {
  it('keeps a fresh unlocked composer associated only with mounted descriptions', () => {
    const mounted = mountInlineAgent()
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    if (!textarea) throw new Error('Agent composer input did not render')

    expect(mounted.root.querySelector('.inline-agent__composer-lock')).toBeNull()
    expect(textarea.getAttribute('aria-label')).toBe('Message Wiki Agent')
    expect(resolveDescribedBy(textarea).length).toBeGreaterThan(0)
  })

  it.each([
    ['paused', 'Resume or cancel the current goal before sending a message'],
    ['active', 'Finish or cancel the current goal before sending a message']
  ] as const)('renders the truthful %s goal reason on the disabled composer textarea', (status, expectedReason) => {
    const lockState = loadGoalLockState(status)
    expect(lockState.canSubmit.value).toBe(false)
    const mounted = mountInlineAgent(lockState)
    const reason = mounted.root.querySelector<HTMLElement>('.inline-agent__composer-lock')
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    const sessionTitle = mounted.root.querySelector<HTMLElement>('.inline-agent__session-title')

    if (!reason || !textarea) throw new Error('Locked composer description did not render')
    expect(reason.textContent?.trim()).toBe(expectedReason)
    expect(reason.getAttribute('role')).toBe('status')
    expect(sessionTitle?.textContent?.trim()).toBe('Release planning')
    expect(textarea.disabled).toBe(true)
    expect(textarea.getAttribute('aria-label')).toBe('Follow up with Wiki Agent')
    expect(resolveDescribedBy(textarea)).toContain(reason)
  })

  it('renders the shared mutation reason and disables the composer until the store lock clears', () => {
    const lockState = loadGoalLockState(null, true)
    expect(lockState.canSubmit.value).toBe(false)
    expect(lockState.submitUnavailableReason.value).toBe('Wait for the current conversation update to finish')

    const locked = mountInlineAgent(lockState)
    const lockedReason = locked.root.querySelector<HTMLElement>('.inline-agent__composer-lock')
    const lockedTextarea = locked.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    if (!lockedReason || !lockedTextarea) throw new Error('Locked composer description did not render')
    expect(lockedReason.textContent?.trim()).toBe('Wait for the current conversation update to finish')
    expect(lockedTextarea.disabled).toBe(true)
    expect(resolveDescribedBy(lockedTextarea)).toContain(lockedReason)

    lockState.sessionMutationBusy.value = false
    expect(lockState.canSubmit.value).toBe(true)
    expect(lockState.submitUnavailableReason.value).toBe('')
    const unlocked = mountInlineAgent(lockState)
    const unlockedTextarea = unlocked.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    expect(unlocked.root.querySelector('.inline-agent__composer-lock')).toBeNull()
    expect(unlockedTextarea?.disabled).toBe(false)
  })

  it('blocks New and clear-unfiled actions while another session mutation owns the lock', async () => {
    const lockState = loadGoalLockState(null, true)
    const mounted = mountInlineAgent(lockState)
    const newConversation = mounted.root.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')

    expect(newConversation?.disabled).toBe(true)

    lockState.openClearUnfiledHistory()
    await lockState.newTemporarySession()
    await lockState.newSession()
    await lockState.clearUnfiledHistory()
    await lockState.recoverClearUnfiledHistory()

    expect(lockState.clearUnfiledHistoryOpen.value).toBe(false)
    expect(lockState.agentCalls.newSession).not.toHaveBeenCalled()
    expect(lockState.agentCalls.clearUnfiledHistory).not.toHaveBeenCalled()
  })
})
