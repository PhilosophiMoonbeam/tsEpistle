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
  openGoal: ValueRef<{ status: string } | null>
  goalSubmitUnavailableReason: ValueRef<string>
  submitUnavailableReason: ValueRef<string>
  sessionMutationBusy: ValueRef<boolean>
  agentCalls: {
    newSession: (...args: unknown[]) => unknown
    resetHistory: (...args: unknown[]) => unknown
  }
  newSession: () => Promise<void>
  openResetHistory: () => void
  recoverResetHistory: () => Promise<void>
  resetHistory: () => Promise<void>
  resetHistoryOpen: ValueRef<boolean>
  thread: ValueRef<Record<string, unknown>>
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

const loadGoalLockState = (status: 'active' | 'paused' | null, mutationBusy = false): LockState => {
  const ref = <T>(value: T): ValueRef<T> => ({ value })
  const thread = ref({
    session: {
      id: 'session-1',
      title: 'Release planning',
      skills: [],
      currentRun: status === 'active' ? { canCancel: true, status: 'running' } : null
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
    newSession: vi.fn(),
    resetHistory: vi.fn()
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
    `${executableScript}\nreturn { activeRun, canSubmit, goalSubmitUnavailableReason, newSession, openGoal, openResetHistory, recoverResetHistory, resetHistory, resetHistoryOpen, sessionMutationBusy, submitUnavailableReason, thread }`
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
    () => agentCalls,
    () => ({}),
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
    resetHistoryOpen: false,
    resetting: false,
    resetCommitted: false,
    resetError: '',
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
    connectionLabel: 'Ready',
    connectionTone: 'ready',
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
    'applyProviderProfile',
    'closeResetHistory',
    'handleGoalExpanded',
    'handleTranscriptScroll',
    'jumpToApproval',
    'newSession',
    'openResetHistory',
    'openSkillManager',
    'recoverResetHistory',
    'reloadHistory',
    'resetHistory',
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
    'AgentSessionSettings',
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

  it('blocks new and reset conversation actions while another session mutation owns the lock', async () => {
    const lockState = loadGoalLockState(null, true)
    const mounted = mountInlineAgent(lockState)
    const newConversation = mounted.root.querySelector<HTMLButtonElement>('[aria-label="Start a new agent conversation"]')

    expect(newConversation?.disabled).toBe(true)

    lockState.openResetHistory()
    await lockState.newSession()
    await lockState.resetHistory()
    await lockState.recoverResetHistory()

    expect(lockState.resetHistoryOpen.value).toBe(false)
    expect(lockState.agentCalls.newSession).not.toHaveBeenCalled()
    expect(lockState.agentCalls.resetHistory).not.toHaveBeenCalled()
    expect(componentSource).toContain(':persistent="resetting || sessionMutationBusy"')
    expect(componentSource.match(/:disabled="resetting \|\| sessionMutationBusy"/g)).toHaveLength(3)
  })
})
