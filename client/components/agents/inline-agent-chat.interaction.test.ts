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
const componentStyles = descriptor.styles.map(style => style.content).join('\n')
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
  canSubmit: ValueRef<boolean>
  connectionLabel: ValueRef<string>
  connectionTone: ValueRef<string>
  openGoal: ValueRef<{ status: string } | null>
  goalSubmitUnavailableReason: ValueRef<string>
  submitUnavailableReason: ValueRef<string>
  sessionMutationBusy: ValueRef<boolean>
  agentCalls: {
    clearUnfiledHistory: (...args: unknown[]) => unknown
    initialize: (...args: unknown[]) => unknown
    newSession: (...args: unknown[]) => unknown
    reloadSessions: (...args: unknown[]) => unknown
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
}

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.scriptSetup.content.replace(/^import .*$/gm, ''))
const composerScript = composerDescriptor.scriptSetup.content
const executableComposerScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(composerScript.replace(/^import .*$/gm, ''))
const composerBindingNames = Array.from(composerScript.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm), match => match[1])
const evaluateComposer = new Function(
  'computed',
  'nextTick',
  'onBeforeUnmount',
  'onMounted',
  'ref',
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
  runStatus: 'running' | 'awaiting_approval' | null = status === 'active' ? 'running' : null
): LockState => {
  const ref = <T>(value: T): ValueRef<T> => ({ value })
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
    decidingApprovalId: ref(null),
    error: ref(''),
    goalBusy: ref(false),
    loading: ref(false),
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
    initialize: vi.fn(() => Promise.resolve()),
    newSession: vi.fn(() => Promise.resolve()),
    reloadSessions: vi.fn(() => Promise.resolve())
  }
  const evaluate = new Function(
    'computed',
    'nextTick',
    'onBeforeUnmount',
    'onMounted',
    'ref',
    'useTemplateRef',
    'watch',
    'storeToRefs',
    'defineProps',
    'defineEmits',
    'useAgentsStore',
    'createModalFocusScope',
    'isAgentApprovalOutsideViewport',
    'shouldFollowGoalExpansion',
    'defineExpose',
    `${executableScript}\nreturn { activeRun, canSubmit, clearUnfiledCommitted, clearUnfiledError, clearUnfiledHistory, clearUnfiledHistoryOpen, connectionLabel, connectionTone, goalSubmitUnavailableReason, newSession, newTemporarySession, openClearUnfiledHistory, openGoal, recoverClearUnfiledHistory, sessionMutationBusy, submitUnavailableReason, thread }`
  ) as (...dependencies: unknown[]) => LockState

  const state = evaluate(
    (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    () => Promise.resolve(),
    () => undefined,
    () => undefined,
    ref,
    () => ref(null),
    () => undefined,
    () => storeRefs,
    () => props,
    () => ({}),
    () => agentCalls,
    () => ({ deactivate: () => undefined }),
    () => false,
    () => false,
    () => undefined
  ) as LockState
  return { ...state, agentCalls }
}

interface MountedInlineAgent {
  activator: HTMLElement
  historyOpen: ValueRef<boolean>
  memoryOpen: ValueRef<boolean>
  root: HTMLElement
  unmount: () => void
}

const mountedApps: Array<() => void> = []
const settle = async (): Promise<void> => {
  await Vue.nextTick()
  await Vue.nextTick()
}

const mountInlineAgent = (lockState?: LockState): MountedInlineAgent => {
  const host = document.createElement('div')
  document.body.append(host)
  const historyOpen = Vue.ref(false)
  const memoryOpen = Vue.ref(false)
  const goal = lockState?.openGoal.value ?? null
  const thread = lockState?.thread.value ?? null
  const context: Record<string, unknown> = {
    csrfToken: 'csrf',
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
    error: '',
    connection: 'connected',
    decidingApprovalId: null,
    goalBusy: false,
    profiles: [{}],
    sessions: [],
    skills: [],
    skillsLoadError: '',
    skillsLoading: false,
    skillsPartial: false,
    thread,
    historyOpen,
    memoryOpen,
    panelMode: 'modal',
    memoryMutationBusy: false,
    historyLoadError: '',
    historyLoading: false,
    clearUnfiledHistoryOpen: false,
    clearingUnfiledHistory: false,
    clearUnfiledCommitted: false,
    clearUnfiledError: '',
    goalExpanded: false,
    approvalJumpVisible: false,
    followJumpVisible: false,
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
    preferredSkillIds: [],
    invocationLimit: 8,
    sessionTitle: 'Release planning',
    connectionLabel: lockState?.connectionLabel.value ?? 'Ready',
    connectionTone: lockState?.connectionTone.value ?? 'ready',
    starters: [],
    emit: () => undefined,
    agents: {},
    closePanels: () => {
      historyOpen.value = false
      memoryOpen.value = false
    },
    closeHistory: () => {
      historyOpen.value = false
    },
    toggleHistory: () => {
      historyOpen.value = !historyOpen.value
      memoryOpen.value = false
    },
    toggleMemory: () => {
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
    'reloadHistory',
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
      externalDescriptionId: String
    },
    emits: ['send', 'stop', 'manageSkills', 'retrySkills', 'updateSkillPreferences'],
    setup(props, { emit, expose }) {
      return evaluateComposer(
        Vue.computed,
        Vue.nextTick,
        Vue.onBeforeUnmount,
        Vue.onMounted,
        Vue.ref,
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
  for (const name of [
    'AgentGoalStatus',
    'AgentHistoryPanel',
    'AgentMcpApproval',
    'AgentMemoryManager',
    'AgentPersonalSkills',
    'AgentThread'
  ])
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
  return { activator, historyOpen, memoryOpen, root, unmount }
}

const expectComposerActionStructure = (mounted: MountedInlineAgent): { primary: HTMLElement; status: HTMLElement } => {
  const actions = mounted.root.querySelector<HTMLElement>('.agent-composer__actions')
  if (!actions) throw new Error('Agent composer actions did not render')

  const children = Array.from(actions.children)
  expect(children).toHaveLength(3)
  const [context, status, primary] = children as [HTMLElement, HTMLElement, HTMLElement]
  expect(context.matches('.agent-composer__context-controls')).toBe(true)
  expect(context.getAttribute('role')).toBe('group')
  expect(context.getAttribute('aria-label')).toBe('Conversation context controls')
  expect(status.matches('#agent-composer-status.agent-composer__state')).toBe(true)
  expect(status.getAttribute('role')).toBe('status')
  expect(status.getAttribute('aria-live')).toBe('polite')
  expect(status.getAttribute('aria-atomic')).toBe('true')
  expect(primary.matches('.agent-composer__primary-actions')).toBe(true)
  expect(primary.getAttribute('role')).toBe('group')
  expect(primary.getAttribute('aria-label')).toBe('Message actions')
  expect(status.nextElementSibling).toBe(primary)
  expect(primary.previousElementSibling).toBe(status)
  return { primary, status }
}

const openPanelMenu = async (mounted: MountedInlineAgent): Promise<HTMLElement[]> => {
  mounted.activator.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  expect(mounted.activator.getAttribute('aria-expanded')).toBe('true')
  const items = Array.from(mounted.root.querySelectorAll<HTMLElement>('[role="menuitem"]'))
  expect(items.map(item => item.textContent?.trim())).toEqual(['Conversation history', 'Agent memory'])
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

      items[index]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await settle()

      expect(mounted.historyOpen.value).toBe(panel === 'history')
      expect(mounted.memoryOpen.value).toBe(panel === 'memory')
      expect(mounted.activator.getAttribute('aria-expanded')).toBe('false')
      mounted.unmount()
      mountedApps.pop()
    }
  })

  it('focuses and activates History with Enter and Memory with Space through Vuetify list-item behavior', async () => {
    for (const [index, key, panel] of [
      [0, 'Enter', 'history'],
      [1, ' ', 'memory']
    ] as const) {
      const mounted = mountInlineAgent()
      const items = await openPanelMenu(mounted)
      const item = items[index]
      if (!item) throw new Error(`Panel menu item ${index} did not render`)

      expect(item.classList.contains('v-list-item--link')).toBe(true)
      item.focus()
      expect(document.activeElement).toBe(item)
      item.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
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
  it('renders History, Memory, Temporary, and New in desktop order with explicit accessible names', () => {
    const mounted = mountInlineAgent()
    const actions = Array.from(mounted.root.querySelectorAll<HTMLElement>(
      '.inline-agent__desktop-panel-btn, .inline-agent__session-action'
    ))

    expect(actions.map(action => action.getAttribute('aria-label'))).toEqual([
      'Open agent conversation history',
      'Manage agent memory',
      'Start a temporary agent conversation',
      'Start a new saved agent conversation'
    ])
    expect(actions[2]?.textContent?.trim()).toBe('Temporary')
    expect(actions[3]?.textContent?.trim()).toBe('New')
    expect(actions[2]?.getAttribute('title')).toBe('Temporary conversations are not saved')
  })

  it('creates temporary and saved conversations with distinct retention', async () => {
    const lockState = loadGoalLockState(null)

    await lockState.newTemporarySession()
    await lockState.newSession()

    expect(lockState.agentCalls.newSession).toHaveBeenNthCalledWith(1, 'temporary')
    expect(lockState.agentCalls.newSession).toHaveBeenNthCalledWith(2, 'saved')
  })

  it('removes session configuration and the clipped composer focus ring', () => {
    expect(componentSource).not.toContain('AgentSessionSettings')
    expect(componentSource).not.toContain('applyProviderProfile')
    expect(composerStyles).toContain('border: 1px solid var(--wiki-surface-border-strong);')
    expect(composerStyles).not.toContain('.agent-composer:focus-within')
    expect(composerStyles).not.toContain('var(--wiki-focus-ring)')
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
    expect(componentSource).toContain('@clear="openClearUnfiledHistory"')
    expect(componentSource).not.toContain('@reset=')
    expect(componentSource).not.toContain('resetHistory')
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

  it('states that saved folders and filed conversations remain throughout confirmation and recovery', () => {
    expect(componentSource).toContain('Only conversations outside saved folders will be permanently removed.')
    expect(componentSource).toContain('Saved folders and their filed conversations will remain.')
    expect(componentSource.match(/Saved folders and their filed conversations remain unchanged\./g)?.length).toBeGreaterThanOrEqual(3)
    expect(componentSource).toContain('If the current conversation is unfiled, a new saved conversation will open.')
    expect(componentSource).toContain('Clear unfiled conversations?')
  })
})

describe('Inline Agent fixed desktop layout', () => {
  it('reserves fixed wide columns only once every panel and gap fits', () => {
    const wideLayout = componentStyles.match(/@media \(min-width:\s*1760px\)([\s\S]*?)(?=@media|$)/)?.[1] ?? ''

    expect(wideLayout).toContain('grid-template-columns: 19rem minmax(0, 68rem) 21rem;')
    expect(wideLayout).toContain('gap: var(--wiki-space-4);')
    expect(wideLayout).toMatch(/\.inline-agent__side--history \{\s*grid-column: 1;/)
    expect(wideLayout).toMatch(/\.inline-agent__side--memory \{\s*grid-column: 3;/)
    expect(componentSource).toContain("window.matchMedia('(min-width: 1760px)')")
    expect(componentStyles).not.toMatch(/\.inline-agent\.inline-agent--(?:history|memory|panels)-open\s*\{[^}]*grid-template-columns/s)
  })

  it('keeps one centered chat track and anchors overlay panels to workspace edges from 1024 through 1759 pixels', () => {
    const dockedLayout = componentStyles.match(
      /@media \(min-width:\s*1024px\) and \(max-width:\s*1759\.98px\)([\s\S]*?)(?=@media|$)/
    )?.[1] ?? ''

    const baseHistorySide = componentStyles.match(/\.inline-agent__side--history \{([^}]*)\}/)?.[1] ?? ''
    const baseMemorySide = componentStyles.match(/\.inline-agent__side--memory \{([^}]*)\}/)?.[1] ?? ''
    expect(dockedLayout).toContain('grid-template-columns: minmax(0, 68rem);')
    expect(dockedLayout).toMatch(/\.inline-agent__side \{[\s\S]*?position: absolute;/)
    expect(dockedLayout).not.toMatch(/\.inline-agent__side \{[^}]*grid-(?:column|row):/)
    expect(dockedLayout).toContain('inset-inline-start: 0;')
    expect(baseHistorySide).not.toContain('grid-column:')
    expect(baseMemorySide).not.toContain('grid-column:')
    expect(dockedLayout).toContain('inset-inline-end: 0;')
    expect(dockedLayout).toContain('width: 19rem;')
    expect(dockedLayout).toContain('width: 21rem;')
    expect(componentStyles).toMatch(/\.inline-agent__side \{[\s\S]*?overflow: hidden;[\s\S]*?border-radius: var\(--wiki-panel-radius\);[\s\S]*?background: transparent;/)
  })
})

describe('Agent composer action semantics', () => {
  it('renders Ready immediately before the accessible Send action', () => {
    const mounted = mountInlineAgent()
    const { primary, status } = expectComposerActionStructure(mounted)
    const submit = primary.querySelector<HTMLButtonElement>('.agent-composer__submit')

    expect(status.textContent?.trim()).toBe('Ready')
    expect(status.getAttribute('title')).toBe('Ready')
    expect(primary.children).toHaveLength(1)
    expect(submit?.tagName).toBe('BUTTON')
    expect(submit?.textContent?.trim()).toBe('Send')
    expect(primary.querySelector('.agent-composer__stop')).toBeNull()
  })

  it('keeps Working immediately before the accessible Stop action for cancellable runs', () => {
    const mounted = mountInlineAgent(loadGoalLockState('active'))
    const { primary, status } = expectComposerActionStructure(mounted)
    const stop = primary.querySelector<HTMLButtonElement>('.agent-composer__stop')

    expect(status.textContent?.trim()).toBe('Working')
    expect(status.getAttribute('title')).toBe('Working')
    expect(primary.children).toHaveLength(1)
    expect(stop?.tagName).toBe('BUTTON')
    expect(stop?.textContent?.trim()).toBe('Stop response')
    expect(primary.querySelector('.agent-composer__submit')).toBeNull()
  })

  it('keeps Review needed immediately before Stop while awaiting approval', () => {
    const mounted = mountInlineAgent(loadGoalLockState('active', false, 'awaiting_approval'))
    const { primary, status } = expectComposerActionStructure(mounted)
    const stop = primary.querySelector<HTMLButtonElement>('.agent-composer__stop')

    expect(status.textContent?.trim()).toBe('Review needed')
    expect(status.getAttribute('title')).toBe('Review needed')
    expect(stop?.textContent?.trim()).toBe('Stop response')
    expect(primary.querySelector('.agent-composer__submit')).toBeNull()
  })
})

describe('Inline Agent goal submission lock', () => {
  it('keeps a fresh unlocked composer associated only with its internal descriptions', () => {
    const mounted = mountInlineAgent()
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')

    expect(mounted.root.querySelector('#agent-composer-lock-reason')).toBeNull()
    expect(textarea?.getAttribute('aria-label')).toBe('Message Wiki Agent')
    expect(textarea?.getAttribute('aria-describedby')).toBe('agent-composer-status agent-composer-keyboard-hint')
  })

  it.each([
    ['paused', 'Resume or cancel the current goal before sending a message'],
    ['active', 'Finish or cancel the current goal before sending a message']
  ] as const)('renders the truthful %s goal reason on the disabled composer textarea', (status, expectedReason) => {
    const lockState = loadGoalLockState(status)
    expect(lockState.canSubmit.value).toBe(false)
    expect(lockState.goalSubmitUnavailableReason.value).toBe(expectedReason)

    const mounted = mountInlineAgent(lockState)
    const reason = mounted.root.querySelector<HTMLElement>('#agent-composer-lock-reason')
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    const sessionTitle = mounted.root.querySelector<HTMLElement>('.inline-agent__session-title')

    expect(reason?.textContent?.trim()).toBe(expectedReason)
    expect(reason?.getAttribute('role')).toBe('status')
    expect(sessionTitle?.textContent?.trim()).toBe('Release planning')
    expect(textarea?.disabled).toBe(true)
    expect(textarea?.getAttribute('aria-label')).toBe('Follow up with Wiki Agent')
    expect(textarea?.getAttribute('aria-describedby')).toBe('agent-composer-lock-reason agent-composer-status agent-composer-keyboard-hint')
  })

  it('renders the shared mutation reason and disables the composer until the store lock clears', () => {
    const lockState = loadGoalLockState(null, true)
    expect(lockState.canSubmit.value).toBe(false)
    expect(lockState.submitUnavailableReason.value).toBe('Wait for the current conversation update to finish')

    const locked = mountInlineAgent(lockState)
    const lockedReason = locked.root.querySelector<HTMLElement>('#agent-composer-lock-reason')
    const lockedTextarea = locked.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    expect(lockedReason?.textContent?.trim()).toBe('Wait for the current conversation update to finish')
    expect(lockedTextarea?.disabled).toBe(true)
    expect(lockedTextarea?.getAttribute('aria-describedby')).toContain('agent-composer-lock-reason')
    locked.unmount()
    mountedApps.pop()

    lockState.sessionMutationBusy.value = false
    expect(lockState.canSubmit.value).toBe(true)
    expect(lockState.submitUnavailableReason.value).toBe('')
    const unlocked = mountInlineAgent(lockState)
    const unlockedTextarea = unlocked.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    expect(unlocked.root.querySelector('#agent-composer-lock-reason')).toBeNull()
    expect(unlockedTextarea?.disabled).toBe(false)
  })

  it('blocks saved, temporary, and clear-unfiled actions while another session mutation owns the lock', async () => {
    const lockState = loadGoalLockState(null, true)
    const mounted = mountInlineAgent(lockState)
    const temporaryConversation = mounted.root.querySelector<HTMLButtonElement>('[aria-label="Start a temporary agent conversation"]')
    const newConversation = mounted.root.querySelector<HTMLButtonElement>('[aria-label="Start a new saved agent conversation"]')

    expect(temporaryConversation?.disabled).toBe(true)
    expect(newConversation?.disabled).toBe(true)

    lockState.openClearUnfiledHistory()
    await lockState.newTemporarySession()
    await lockState.newSession()
    await lockState.clearUnfiledHistory()
    await lockState.recoverClearUnfiledHistory()

    expect(lockState.clearUnfiledHistoryOpen.value).toBe(false)
    expect(lockState.agentCalls.newSession).not.toHaveBeenCalled()
    expect(lockState.agentCalls.clearUnfiledHistory).not.toHaveBeenCalled()
    expect(componentSource).toContain(':persistent="clearingUnfiledHistory || sessionMutationBusy"')
    expect(componentSource.match(/:disabled="clearingUnfiledHistory \|\| sessionMutationBusy"/g)).toHaveLength(3)
  })
})
