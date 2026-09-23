import fs from 'node:fs'
import path from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { calculateComposerSizing, caretBoundsFromMirror, scrollTopForCaret } from './agent-composer-sizing.ts'
import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'

const componentPath = path.join(process.cwd(), 'client/components/agents/inline-agent-chat.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const descriptor = parse(componentSource, { filename: componentPath }).descriptor
if (!descriptor.template || !descriptor.scriptSetup) throw new Error('inline-agent-chat.vue template and setup script are required')

const composerComponentPath = path.join(process.cwd(), 'client/components/agents/agent-composer.vue')
const composerComponentSource = fs.readFileSync(composerComponentPath, 'utf8')
const composerDescriptor = parse(composerComponentSource, { filename: composerComponentPath }).descriptor
if (!composerDescriptor.template || !composerDescriptor.scriptSetup) throw new Error('agent-composer.vue template and setup script are required')
const composerStyles = composerDescriptor.styles.map(style => style.content).join('\n')

import { browserWindow, resetBody } from '../../test/browser-dom.mts'

resetBody()


// Vuetify snapshots browser capabilities during module evaluation, so the DOM must exist before loading it here.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const testPwaState = { connectionState: 'online' as const }

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
interface TestPageHint {
  readonly id: number
  readonly locale: string
  readonly path: string
  readonly observedUpdatedAt: string
}

interface LockState {
  activeRun: ValueRef<{ canCancel: boolean; status: string } | null>
  canPinCurrentChat: ValueRef<boolean>
  canSubmit: ValueRef<boolean>
  composerFocused: ValueRef<boolean>
  invocationLimit: ValueRef<number>
  connectionLabel: ValueRef<string>
  composerLockVisible: ValueRef<boolean>
  connectionTone: ValueRef<string>
  mutationLockMessageVisible: ValueRef<boolean>
  welcomeGreeting: { readonly first: string; readonly second: string }
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
    isWorkspaceReady: (...args: unknown[]) => unknown
    newSession: (...args: unknown[]) => unknown
    reloadSessions: (...args: unknown[]) => unknown
    sessions: Array<{ id: string; deletedAt: string | null }>
    send: (...args: unknown[]) => unknown
    setCurrentChatPinned: (...args: unknown[]) => unknown
  }
  clearUnfiledCommitted: ValueRef<boolean>
  clearUnfiledError: ValueRef<string>
  clearUnfiledHistory: () => Promise<void>
  ensureInitialized: () => Promise<boolean>
  clearUnfiledHistoryOpen: ValueRef<boolean>
  newSession: () => Promise<void>
  newTemporarySession: () => Promise<void>
  openClearUnfiledHistory: () => void
  recoverClearUnfiledHistory: () => Promise<void>
  thread: ValueRef<Record<string, unknown> | null>
  sendPrompt: (content: string) => Promise<boolean>
  currentPage: ValueRef<TestPageHint | null>
  sessionNotice: ValueRef<string>
  setSessionNotice: (message: string) => void
  clearSessionNotice: () => void
  SESSION_NOTICE_VISIBLE_MS: number
  startersRow: ValueRef<HTMLElement | null>
  startStartersSpin: () => void
  stopStartersSpin: () => void
  holdStartersSpin: () => void
  handleStartersScroll: () => void
  STARTERS_SPIN_STEP_MS: number
  STARTERS_SPIN_HOLD_MS: number
  pendingSessionNoticeTimers: Array<{ callback: () => void; delay: number }>
  pendingStartersIntervals: Array<{ callback: () => void; delay: number }>
  clearedStartersIntervalIds: number[]
  componentProps: { pageId: number; pageLocale: string; pagePath: string; pageUpdatedAt: string }
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
  `${executableComposerScript}
return {
  mediaSubmission, mediaBusy, appendDictation, handleMediaPaste, handleMediaDragOver, handleMediaDrop,
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
  dictationAvailable,
  attachmentsAvailable,
  attachDisabled,
  generationOptions,
  selectedGenerationTools,
  createAvailable,
  attachmentMenuOpen,
  openFilePicker,
  openAssetBrowser,
  toggleGenerationTool,
  mediaRecording,
  mediaRequesting,
  mediaTranscribing,
  mediaSeconds,
  dictationStatusLabel,
  dictationTimerLabel,
  dictationEnding,
  readDictationLevel,
  error,
  appendDictation,
  startDictation,
  stopDictation,
  cancelDictation
}`
) as (...dependencies: unknown[]) => Record<string, unknown>

const loadGoalLockState = (
  status: 'active' | 'paused' | null,
  mutationBusy = false,
  runStatus: 'running' | 'awaiting_approval' | null = status === 'active' ? 'running' : null,
  canPinCurrentChat = true,
  workspaceClosed = false,
  page: TestPageHint | null = null
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
    networkPaused: ref(workspaceClosed),
    workspaceDisposed: ref(workspaceClosed),
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
    mediaProfile: undefined,
    mediaRefreshing: false,
    refreshAfterMedia: () => {},
    ownerId: 2,
    resumeSessionId: undefined,
    providerEnabled: true,
    skillsEnabled: true,
    goalsEnabled: true,
    pageId: page?.id ?? 0,
    pageLocale: page?.locale ?? '',
    pagePath: page?.path ?? '',
    pageUpdatedAt: page?.observedUpdatedAt ?? ''
  }
  const agentCalls = {
    clearUnfiledHistory: vi.fn(() => Promise.resolve()),
    initialize: vi.fn(() => Promise.resolve(true)),
    isWorkspaceReady: vi.fn(() => !workspaceClosed),
    newSession: vi.fn(() => Promise.resolve(true)),
    reloadSessions: vi.fn(() => Promise.resolve({ accepted: true, current: true })),
    sessions: [] as Array<{ id: string; deletedAt: string | null }>,
    send: vi.fn(() => Promise.resolve(true)),
    setCurrentChatPinned: vi.fn()
  }
  const pendingSessionNoticeTimers: Array<{ callback: () => void; delay: number }> = []
  const pendingStartersIntervals: Array<{ callback: () => void; delay: number }> = []
  const clearedStartersIntervalIds: number[] = []
  const evaluate = new Function(
    '{ computed, nextTick, onBeforeUnmount, onMounted, ref, setInterval, clearInterval, setTimeout, useTemplateRef, useId, watch, storeToRefs, defineProps, defineEmits, useAgentsStore, activeOwnedOverlayRoots, createModalFocusScope, isAgentApprovalOutsideViewport, shouldFollowGoalExpansion, pwaState, retryServerConnection }',
    `${executableScript}\nreturn { SESSION_NOTICE_VISIBLE_MS, STARTERS_SPIN_HOLD_MS, STARTERS_SPIN_STEP_MS, activeRun, canPinCurrentChat, canSubmit, clearSessionNotice, clearUnfiledCommitted, clearUnfiledError, clearUnfiledHistory, clearUnfiledHistoryOpen, composerFocused, composerLockVisible, connectionLabel, connectionTone, currentPage, ensureInitialized, goalSubmitUnavailableReason, handleComposerFocusIn, handleComposerFocusOut, handleStartersScroll, handleTranscriptEngagement, holdStartersSpin, invocationLimit, mutationLockMessageVisible, newSession, newTemporarySession, openGoal, openClearUnfiledHistory, recoverClearUnfiledHistory, retryInitialization, sendPrompt, sessionMutationBusy, sessionNotice, setSessionNotice, startersRow, startStartersSpin, startTemporaryChat, stopStartersSpin, submitUnavailableReason, thread, welcomeGreeting }`
  ) as (dependencies: Record<string, unknown>) => LockState

  const state = evaluate({
    computed: (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    nextTick: () => Promise.resolve(),
    setTimeout: (callback: () => void, delay: number) => {
      pendingSessionNoticeTimers.push({ callback, delay })
      return pendingSessionNoticeTimers.length
    },
    setInterval: (callback: () => void, delay: number) => {
      pendingStartersIntervals.push({ callback, delay })
      return pendingStartersIntervals.length
    },
    clearInterval: (id: number) => {
      clearedStartersIntervalIds.push(id)
    },
    onBeforeUnmount: () => undefined,
    onMounted: () => undefined,
    ref,
    useTemplateRef: () => ref(null),
    useId: () => 'agent-test',
    watch: Vue.watch,
    storeToRefs: () => storeRefs,
    defineEmits: () => () => undefined,
    defineProps: () => props,
    useAgentsStore: () => agentCalls,
    activeOwnedOverlayRoots: () => [],
    createModalFocusScope: () => ({ deactivate: () => undefined }),
    isAgentApprovalOutsideViewport: () => false,
    shouldFollowGoalExpansion: () => false,
    pwaState: testPwaState,
    retryServerConnection: async () => true
  }) as LockState
  return { ...state, agentCalls, componentProps: props, pendingSessionNoticeTimers, pendingStartersIntervals, clearedStartersIntervalIds }
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
  options: {
    readonly approvalJumpVisible?: boolean
    readonly followJumpVisible?: boolean
    readonly isTemporary?: boolean
    readonly page?: TestPageHint | null
  } = {}
): MountedInlineAgent => {
  const host = document.createElement('div')
  document.body.append(host)
  const historyOpen = Vue.ref(false)
  const memoryOpen = Vue.ref(false)
  const panelMenuOpen = Vue.ref(false)
  const temporaryCalls: string[] = []
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
  const page = options.page ?? lockState?.currentPage.value ?? null
  const context: Record<string, unknown> = {
    csrfToken: 'csrf',
    mediaProfile: undefined,
    mediaRefreshing: false,
    refreshAfterMedia: () => {},
    ownerId: 2,
    resumeSessionId: undefined,
    approvalId: undefined,
    providerEnabled: true,
    skillsEnabled: false,
    goalsEnabled: true,
    pageId: page?.id ?? 0,
    pageLocale: page?.locale ?? '',
    pagePath: page?.path ?? '',
    pageUpdatedAt: page?.observedUpdatedAt ?? '',
    loading: false,
    connectionRetrying: false,
    connectionBlocked: false,
    workspaceReady: lockState?.canPinCurrentChat.value ?? true,
    offlineSessionId: 'offline-agent-draft',
    offlineComposerDraft: '',
    composerDisabled: !(lockState?.canSubmit.value ?? true),
    sending: false,
    promptSubmissionPending: false,
    sessionMutationBusy: lockState?.sessionMutationBusy.value ?? false,
    googleSearchPending: null as boolean | null,
    composerLockVisible: Boolean(lockState?.openGoal.value) || (lockState?.sessionMutationBusy.value ?? false),
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
    isCurrentChatPinned: options.isCurrentChatPinned ?? false,
    startTemporaryChat: () => undefined,
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
    currentPage: page,
    contextualGlass: Boolean(page),
    activeRun: lockState?.activeRun.value ?? null,
    openGoal: goal,
    hasConversation: Boolean(goal),
    providerAvailable: true,
    providerUnavailableMessage: '',
    activeDraft: {},
    pinnedSessionId: null,
    canSubmit: lockState?.canSubmit.value ?? true,
    goalSubmitUnavailableReason: lockState?.goalSubmitUnavailableReason.value ?? '',
    handleDraftChange: () => undefined,
    submitUnavailableReason: lockState?.submitUnavailableReason.value ?? '',
    transcriptFollowing,
    transcriptReadingProgress: options.followJumpVisible ? 1 : 0,
    invocationLimit: lockState?.invocationLimit.value ?? 8,
    composerFocused,
    handleComposerFocusIn,
    handleComposerFocusOut,
    handleComposerPointerDown,
    handleTranscriptEngagement,
    sessionTitle: 'Release planning',
    connectionLabel: lockState?.connectionLabel.value ?? 'Ready',
    connectionTone: lockState?.connectionTone.value ?? 'ready',
    welcomeGreeting: lockState?.welcomeGreeting ?? { first: 'Stacks of possibilities.', second: 'Zero overdue fees.' },
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
        prompt: 'Summarize the 10 most recently updated Wiki pages I can access. Give each page a brief summary with a source.',
        icon: 'mdi-history'
      }
    ],
    sendPrompt: lockState?.sendPrompt ?? (async () => false),
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
    'preparePrompt',
    'handleDecision',
    'pauseGoal',
    'resumeGoal',
    'cancelGoal',
    'renewGoalBudget',
    'patchDraft',
    'focusComposer',
    'retryAgentConnection',
    'reloadSkillCatalog',
    'stopRun',
    'updateSkillPreferences',
    'keepConversation',
    'jumpToApproval',
    'newSession',
    'newTemporarySession',
    'openClearUnfiledHistory',
    'openSkillManager',
    'recoverClearUnfiledHistory',
    'retryInitialization',
    'scrollToLatest',
    'updateMemoryOpen'
  ])
    context[method] = () => undefined

  context.keepConversation = () => {
    temporaryCalls.push('keep')
  }
  context.startTemporaryChat = () => {
    temporaryCalls.push('start')
  }

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
      initialMode: String,
      initialSkillVersionIds: Array,
      disabled: Boolean,
      sending: Boolean,
      canStop: Boolean,
      skillsEnabled: Boolean,
      goalsEnabled: Boolean,
      skills: Array,
      skillsLoadError: String,
      skillsPartial: Boolean,
      preferredSkills: Array,
      invocationLimit: Number,
      statusLabel: String,
      statusTone: String,
      hasMessages: Boolean,
      externalDescriptionId: String,
      csrfToken: String,
      mediaSession: Object,
      mediaCapabilities: Object,
      networkBlocked: Boolean
    },
    emits: ['send', 'stop', 'manageSkills', 'retrySkills', 'updateSkillPreferences', 'draftChange'],
    setup(props, { emit, expose }) {
      const bindings = evaluateComposer(
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
      return { ...bindings, canStop: props.canStop, skillsEnabled: props.skillsEnabled, goalsEnabled: props.goalsEnabled }
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
    'AgentThread',
    'ControlBorderBeam'
  ])
    app.component(name, componentStub)
  app.component(
    'AgentContextPicker',
    Vue.defineComponent({
      inheritAttrs: false,
      setup(_props, { attrs }) {
        return () => Vue.h('div', { ...attrs, class: 'agent-context' })
      }
    })
  )
  app.component('AgentComposer', composerComponent)
  app.component('AgentComposerMedia', { template: '<div />' })
  app.component('AgentDictationWaveform', { template: '<canvas class="agent-dictation-waveform" />' })
  app.mount(host)

  const root = host.querySelector<HTMLElement>('.inline-agent')
  const activator = host.querySelector<HTMLElement>('[aria-label="Settings"]')
  if (!root || !activator) throw new Error('Inline Agent mobile panel controls did not render')
  const unmount = (): void => {
    app.unmount()
    host.remove()
  }
  mountedApps.push(unmount)
  return { activator, composerFocused, historyOpen, memoryOpen, root, temporaryCalls, transcriptFollowing, unmount }
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
  expect(context.getAttribute('aria-label')).toBe('Message tools')
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

const openPanelMenu = async (mounted: MountedInlineAgent, options: { readonly isTemporary?: boolean } = {}): Promise<HTMLElement[]> => {
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
  expect(items.map(item => item.querySelector<HTMLElement>('.v-list-item-title')?.textContent?.trim())).toEqual([
    'Return to Wiki Search',
    'Conversation history',
    'Agent memory',
    'Pin chat',
    options.isTemporary ? 'Keep conversation' : 'Temporary chat'
  ])
  expect(items.every(item => item.getAttribute('role') === 'listitem')).toBe(true)
  expect(items.every(item => item.getAttribute('role') !== 'menu')).toBe(true)
  expect(items.every(item => item.hasAttribute('tabindex') || item.classList.contains('v-list-item--disabled'))).toBe(true)
  return items
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  document.body.replaceChildren()
})

describe('Inline Agent mobile panel controls', () => {
  it('keeps both History and Memory pointer-activatable and closes the menu', async () => {
    for (const [index, panel] of [
      [1, 'history'],
      [2, 'memory']
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
  it('keeps History (icon-only, upper left) and New chat direct, groups Memory, Pin, and Temporary into More', async () => {
    const mounted = mountInlineAgent(undefined, { isTemporary: true })
    const historyToggle = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__history-toggle')
    const newSession = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__session-action')
    if (!historyToggle || !newSession) throw new Error('Header action controls did not render')

    // History replaced the Wiki Search shortcut with an icon-only toggle.
    expect(historyToggle.getAttribute('aria-label')).toBe('History')
    expect(historyToggle.getAttribute('title')).toBe('History')
    expect(historyToggle.getAttribute('aria-expanded')).toBe('false')
    expect(historyToggle.getAttribute('aria-controls')).toBe('agent-history-panel')
    expect(historyToggle.textContent?.trim()).toBe('')
    expect(newSession.getAttribute('aria-label')).toBe('New chat')
    expect(newSession.getAttribute('title')).toBe('New')
    // No Wiki Search shortcut remains in the header controls.
    expect(mounted.root.querySelector('.inline-agent__mobile-return')).toBeNull()
    // The direct Temporary control is gone from the session line; the chat name stands alone.
    expect(mounted.root.querySelector('.inline-agent__temporary-toggle')).toBeNull()

    const items = await openPanelMenu(mounted, { isTemporary: true })
    const pinItem = items[3]
    const temporaryItem = items[4]
    if (!pinItem || !temporaryItem) throw new Error('Pin and Temporary menu items did not render')
    expect(pinItem.querySelector<HTMLElement>('.v-list-item-title')?.textContent?.trim()).toBe('Pin chat')
    // A begun temp conversation offers Keep conversation from the menu.
    expect(temporaryItem.querySelector<HTMLElement>('.v-list-item-title')?.textContent?.trim()).toBe('Keep conversation')

    // Invoking the menu item keeps the begun conversation in history.
    temporaryItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle()
    expect(mounted.temporaryCalls).toEqual(['keep'])
  })

  it('offers Temporary chat in More for a saved conversation and starts one from the menu', async () => {
    const mounted = mountInlineAgent()
    // The saved conversation shows no direct temporary control in the header.
    expect(mounted.root.querySelector('.inline-agent__temporary-toggle')).toBeNull()

    const items = await openPanelMenu(mounted)
    const temporaryItem = items[4]
    if (!temporaryItem) throw new Error('Temporary menu item did not render')
    expect(temporaryItem.querySelector<HTMLElement>('.v-list-item-title')?.textContent?.trim()).toBe('Temporary chat')

    temporaryItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle()
    expect(mounted.temporaryCalls).toEqual(['start'])
  })

  it('drops the redundant Keep conversation action from the retention strip', () => {
    const mounted = mountInlineAgent(undefined, { isTemporary: true })
    const retention = mounted.root.querySelector<HTMLElement>('.inline-agent__retention')
    expect(retention).not.toBeNull()
    expect(retention?.textContent).toContain('Temp chat')
    expect(Array.from(retention?.querySelectorAll('button') ?? [])).toHaveLength(0)
  })

  it('keeps the accessible brand label and lets the conversation title lead the header', () => {
    const mounted = mountInlineAgent()
    const title = mounted.root.querySelector<HTMLElement>('.inline-agent__heading h2')
    const wideTitle = mounted.root.querySelector<HTMLElement>('.inline-agent__workspace-title--wide')
    const compactTitle = mounted.root.querySelector<HTMLElement>('.inline-agent__workspace-title--compact')
    const sessionTitle = mounted.root.querySelector<HTMLElement>('.inline-agent__session-title')
    if (!title || !sessionTitle) throw new Error('Workspace header did not render')

    expect(title.textContent?.trim()).toBe('Wiki Agent')
    expect(title.getAttribute('aria-label')).toBe('Wiki Agent')
    expect(wideTitle).toBeNull()
    expect(compactTitle).toBeNull()
    // The conversation name occupies the title slot with no temporary control beneath it.
    expect(sessionTitle.textContent?.trim()).toBe('Release planning')
    expect(mounted.root.querySelector('.inline-agent__temporary-toggle')).toBeNull()
  })

  it('creates temporary and saved conversations with distinct retention', async () => {
    const lockState = loadGoalLockState(null)

    await lockState.newTemporarySession()
    await lockState.newSession()

    expect(lockState.agentCalls.newSession).toHaveBeenNthCalledWith(1, 'temporary')
    expect(lockState.agentCalls.newSession).toHaveBeenNthCalledWith(2, 'saved')
  })

  it('reinitializes a reopened workspace without requiring a connection retry', async () => {
    const reopened = loadGoalLockState(null, false, null, true, true)

    await expect(reopened.ensureInitialized()).resolves.toBe(true)

    expect(reopened.agentCalls.initialize).toHaveBeenCalledTimes(1)
  })

  it('keeps the workspace composer mounted beneath the labelled session controls with one context picker slot', () => {
    const mounted = mountInlineAgent(loadGoalLockState(null))
    const composer = mounted.root.querySelector<HTMLElement>('.inline-agent__composer')
    const picker = composer?.querySelectorAll('.agent-context')
    expect(composer).not.toBeNull()
    expect(picker).toHaveLength(1)
    expect(picker?.[0]?.closest('.agent-composer__context-row')).not.toBeNull()
    expect(mounted.root.querySelector('.inline-agent__session-action')?.textContent?.trim()).toBe('')
    expect(mounted.root.querySelector('.agent-composer__input textarea')).not.toBeNull()
  })

  it('renders a two-line welcome greeting above exactly three starter cards', () => {
    const mounted = mountInlineAgent(loadGoalLockState(null))
    const heading = mounted.root.querySelector<HTMLElement>('.inline-agent__welcome h2')
    const lines = heading ? Array.from(heading.querySelectorAll<HTMLElement>(':scope > .inline-agent__welcome-line')) : []
    const starterGroup = mounted.root.querySelector<HTMLElement>('.inline-agent__starters')
    const starters = Array.from(mounted.root.querySelectorAll<HTMLElement>('.inline-agent__starter'))
    if (!heading || !starterGroup) throw new Error('Welcome starter cards did not render')
    expect(lines).toHaveLength(2)
    expect(lines.map(line => line.tagName)).toEqual(['SPAN', 'EM'])
    const wordCounts = lines.map(line => (line.textContent?.trim() ?? '').split(/\s+/).filter(Boolean).length)
    expect(wordCounts.every(count => count >= 2 && count <= 3)).toBe(true)
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
    expect(starters.every(starter => !starter.querySelector('.inline-agent__starter-arrow'))).toBe(true)
  })
  it('keeps the selected two-line greeting stable for one visit', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.42)
    try {
      const mounted = mountInlineAgent(loadGoalLockState(null))
      const heading = mounted.root.querySelector<HTMLElement>('.inline-agent__welcome h2')
      const lines = heading ? Array.from(heading.querySelectorAll<HTMLElement>(':scope > .inline-agent__welcome-line')) : []
      if (!heading || lines.length !== 2) throw new Error('Welcome greeting lines did not render')
      expect(lines[0]?.tagName).toBe('SPAN')
      expect(lines[1]?.tagName).toBe('EM')
      const initial = heading.textContent
      mounted.transcriptFollowing.value = false
      await settle()
      expect(mounted.root.querySelector<HTMLElement>('.inline-agent__welcome h2')?.textContent).toBe(initial)
    } finally {
      random.mockRestore()
    }
  })
  it('keeps the Included page synchronized with Wiki navigation', () => {
    const firstPage: TestPageHint = {
      id: 41,
      locale: 'en',
      path: 'handbook/first',
      observedUpdatedAt: '2026-09-15T10:00:00.000Z'
    }
    const secondPage: TestPageHint = {
      id: 42,
      locale: 'en',
      path: 'handbook/second',
      observedUpdatedAt: '2026-09-16T10:00:00.000Z'
    }
    const first = loadGoalLockState(null, false, null, true, false, firstPage)
    expect(first.currentPage.value).toEqual(firstPage)

    first.componentProps.pageId = secondPage.id
    first.componentProps.pageLocale = secondPage.locale
    first.componentProps.pagePath = secondPage.path
    first.componentProps.pageUpdatedAt = secondPage.observedUpdatedAt
    expect(first.currentPage.value).toEqual(secondPage)

    const reopened = loadGoalLockState(null, false, null, true, false, secondPage)
    expect(reopened.currentPage.value).toEqual(secondPage)
  })

  it('allows a starter to submit only once while its first request is in flight', async () => {
    const lockState = loadGoalLockState(null)
    const mounted = mountInlineAgent(lockState)
    const starter = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__starter')
    if (!starter) throw new Error('Conversation starter did not render')

    starter.click()
    starter.click()
    await settle()

    expect(lockState.agentCalls.send).toHaveBeenCalledTimes(1)
  })

  it('keeps composer dock focus state independent from transcript scrolling and engagement', async () => {
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

  it('keeps recovery open when no replacement conversation is available after a committed clear', async () => {
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
    expect(lockState.clearUnfiledError.value).toContain('No replacement conversation is available yet. Retry.')
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
    expect(button.textContent?.trim()).toBe('Latest')
    expect(button.querySelectorAll('button')).toHaveLength(0)
    expect(face.textContent?.trim()).toBe('Latest')
    expect(halo.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps approval navigation ahead of latest response navigation', () => {
    const mounted = mountInlineAgent(undefined, { approvalJumpVisible: true, followJumpVisible: true })
    const dock = mounted.root.querySelector<HTMLElement>('.inline-agent__jump-dock')

    expect(dock?.querySelector('.inline-agent__approval-jump')?.textContent?.trim()).toBe('Approval required')
    expect(dock?.querySelector('.inline-agent__follow-jump')).toBeNull()
  })
})

describe('Agent workspace action semantics', () => {
  it('keeps the accessible live status before Send and keeps pin state out of the header row', () => {
    const mounted = mountInlineAgent()
    const { primary, status } = expectComposerActionStructure(mounted)
    const submit = primary.querySelector<HTMLButtonElement>('.agent-composer__submit')
    const composer = mounted.root.querySelector<HTMLElement>('.inline-agent__composer')
    const headerActions = mounted.root.querySelector<HTMLElement>('.inline-agent__panel-actions')
    const newChat = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__new-session')
    const moreMenu = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__more-menu')
    const temporaryToggle = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__temporary-toggle')
    const pinIndicator = mounted.root.querySelector<HTMLElement>('.inline-agent__pin-indicator')

    expect(status.textContent?.trim()).toBe('Ready')
    expect(primary.children).toHaveLength(1)
    // Without skills and with nothing folded the composer renders no More button.
    const more = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__more-button')
    expect(more).toBeNull()
    expect(submit?.tagName).toBe('BUTTON')
    expect(submit?.textContent?.trim()).toBe('Send')
    expect(primary.querySelector('.agent-composer__stop')).toBeNull()
    // Pin lives in the More menu; the header shows a pin indicator only when pinned.
    expect(mounted.root.querySelector('.inline-agent__chat-pin')).toBeNull()
    // New chat is now icon-only like History, with a native "New" tooltip.
    expect(newChat?.textContent?.trim()).toBe('')
    expect(newChat?.getAttribute('aria-label')).toBe('New chat')
    expect(newChat?.getAttribute('title')).toBe('New')
    expect(moreMenu?.getAttribute('aria-label')).toBe('Settings')
    expect(moreMenu?.getAttribute('title')).toBe('Settings')
    expect(moreMenu?.parentElement).toBe(headerActions)
    expect(temporaryToggle).toBeNull()
    expect(pinIndicator).toBeNull()
    expect(composer?.querySelector('.inline-agent__chat-pin')).toBeNull()
    expect(mounted.root.querySelector('.agent-composer__hint')).toBeNull()
  })

  it('keeps the accessible Working status before Stop with the pin action available in More', async () => {
    const mounted = mountInlineAgent(loadGoalLockState('active'))
    const { primary, status } = expectComposerActionStructure(mounted)
    const stop = primary.querySelector<HTMLButtonElement>('.agent-composer__stop')

    expect(status.textContent?.trim()).toBe('Working')
    expect(primary.children).toHaveLength(1)
    expect(stop?.tagName).toBe('BUTTON')
    expect(stop?.textContent?.trim()).toBe('Stop response')
    expect(primary.querySelector('.agent-composer__submit')).toBeNull()
    // No More options button renders without skills enabled or folded controls.
    expect(mounted.root.querySelector('.agent-composer__more-button')).toBeNull()
    const items = await openPanelMenu(mounted)
    const pinItem = items[3]
    expect(pinItem?.hasAttribute('disabled')).toBe(false)
  })

  it('disables the pin action only while workspace selection is unsettled', async () => {
    const unsettled = mountInlineAgent(loadGoalLockState(null, false, null, false))
    const disabled = (item?: HTMLElement): boolean => Boolean(item?.hasAttribute('disabled') || item?.getAttribute('aria-disabled') === 'true' || item?.classList.contains('v-list-item--disabled'))
    const unsettledItems = await openPanelMenu(unsettled)
    expect(disabled(unsettledItems[3])).toBe(true)
    unsettled.unmount()

    const activeRun = mountInlineAgent(loadGoalLockState(null, false, 'running', true))
    const activeRunItems = await openPanelMenu(activeRun)
    expect(disabled(activeRunItems[3])).toBe(false)
    activeRun.unmount()

    const activeGoal = mountInlineAgent(loadGoalLockState('active', false, 'running', true))
    const activeGoalItems = await openPanelMenu(activeGoal)
    expect(disabled(activeGoalItems[3])).toBe(false)
    activeGoal.unmount()
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

describe('Inline Agent session notice', () => {
  it('dismisses the session notice after its visible window and frees the strip', () => {
    const lockState = loadGoalLockState(null)
    lockState.setSessionNotice('Conversation kept. It will appear in history after your first message.')
    expect(lockState.sessionNotice.value).toBe('Conversation kept. It will appear in history after your first message.')
    expect(lockState.pendingSessionNoticeTimers).toHaveLength(1)
    expect(lockState.pendingSessionNoticeTimers[0]?.delay).toBe(lockState.SESSION_NOTICE_VISIBLE_MS)

    lockState.pendingSessionNoticeTimers[0]?.callback()
    expect(lockState.sessionNotice.value).toBe('')
    expect(lockState.pendingSessionNoticeTimers).toHaveLength(1)

    lockState.setSessionNotice('')
    expect(lockState.pendingSessionNoticeTimers).toHaveLength(1)
    expect(lockState.sessionNotice.value).toBe('')

    lockState.setSessionNotice('Conversation kept in history.')
    expect(lockState.pendingSessionNoticeTimers).toHaveLength(2)
    lockState.clearSessionNotice()
    expect(lockState.sessionNotice.value).toBe('')
    expect(lockState.pendingSessionNoticeTimers).toHaveLength(2)
  })
})

describe('Inline Agent starters carousel', () => {
  interface FakeStarterRow {
    scrollWidth: number
    clientWidth: number
    scrollLeft: number
    scrollTo: (options: { left: number; behavior: string }) => void
    querySelectorAll: (selector: string) => Array<{ offsetLeft: number }>
  }

  const buildFakeRow = (scrollToCalls: Array<{ left: number; behavior: string }>): FakeStarterRow => ({
    scrollWidth: 620,
    clientWidth: 330,
    scrollLeft: 0,
    scrollTo: options => {
      scrollToCalls.push(options)
    },
    querySelectorAll: selector => {
      expect(selector).toBe('.inline-agent__starter')
      return [{ offsetLeft: 12 }, { offsetLeft: 202 }, { offsetLeft: 401 }]
    }
  })

  it('advances the row on its own, clamps at the end, and wraps back to the first starter', () => {
    const lockState = loadGoalLockState(null)
    const scrollToCalls: Array<{ left: number; behavior: string }> = []
    const row = buildFakeRow(scrollToCalls)
    lockState.startersRow.value = row as unknown as HTMLElement

    lockState.startStartersSpin()
    expect(lockState.pendingStartersIntervals).toHaveLength(1)
    expect(lockState.pendingStartersIntervals[0]?.delay).toBe(lockState.STARTERS_SPIN_STEP_MS)

    lockState.pendingStartersIntervals[0]?.callback()
    expect(scrollToCalls).toEqual([{ left: 202 - 12, behavior: 'smooth' }])

    row.scrollLeft = scrollToCalls[0]?.left ?? 0
    lockState.pendingStartersIntervals[0]?.callback()
    expect(scrollToCalls[1]).toEqual({ left: 290, behavior: 'smooth' })

    row.scrollLeft = 290
    lockState.pendingStartersIntervals[0]?.callback()
    expect(scrollToCalls[2]).toEqual({ left: 290, behavior: 'smooth' })
    expect(scrollToCalls.every(call => call.behavior === 'smooth')).toBe(true)

    lockState.stopStartersSpin()
    expect(lockState.clearedStartersIntervalIds).toEqual([1])
  })

  it('holds the landed position after a swipe and resumes stepping once the hold expires', () => {
    const lockState = loadGoalLockState(null)
    const scrollToCalls: Array<{ left: number; behavior: string }> = []
    const row = buildFakeRow(scrollToCalls)
    lockState.startersRow.value = row as unknown as HTMLElement
    lockState.startStartersSpin()

    lockState.pendingStartersIntervals[0]?.callback()
    expect(scrollToCalls).toHaveLength(1)

    row.scrollLeft = 190
    lockState.holdStartersSpin()
    expect(lockState.pendingSessionNoticeTimers.at(-1)?.delay).toBe(lockState.STARTERS_SPIN_HOLD_MS)
    lockState.pendingStartersIntervals[0]?.callback()
    expect(scrollToCalls).toHaveLength(1)

    const holdTimer = lockState.pendingSessionNoticeTimers.at(-1)
    holdTimer?.callback()
    lockState.pendingStartersIntervals[0]?.callback()
    expect(scrollToCalls).toHaveLength(2)
    expect(scrollToCalls[1]?.left).toBe(290)

    lockState.stopStartersSpin()
  })

  it('re-arms the hold on user scrolls and ignores the spin own programmatic scrolls', () => {
    const lockState = loadGoalLockState(null)
    const scrollToCalls: Array<{ left: number; behavior: string }> = []
    const row = buildFakeRow(scrollToCalls)
    lockState.startersRow.value = row as unknown as HTMLElement
    lockState.startStartersSpin()

    const timersBefore = lockState.pendingSessionNoticeTimers.length
    lockState.pendingStartersIntervals[0]?.callback()
    lockState.handleStartersScroll()
    expect(lockState.pendingSessionNoticeTimers.length).toBe(timersBefore)

    lockState.holdStartersSpin()
    expect(lockState.pendingSessionNoticeTimers.length).toBe(timersBefore + 1)
    expect(lockState.pendingSessionNoticeTimers.at(-1)?.delay).toBe(lockState.STARTERS_SPIN_HOLD_MS)

    lockState.stopStartersSpin()
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

  it('delays the mutation lock message so quick toggles never flash it', async () => {
    const lockState = loadGoalLockState(null, false)
    expect(lockState.composerLockVisible.value).toBe(false)

    // A short mutation: busy flips true then back before the delay elapses.
    lockState.sessionMutationBusy.value = true
    await Vue.nextTick()
    const lockTimers = lockState.pendingSessionNoticeTimers
    expect(lockTimers.at(-1)?.delay).toBe(300)
    expect(lockState.composerLockVisible.value).toBe(false)
    lockState.sessionMutationBusy.value = false
    await Vue.nextTick()
    expect(lockState.composerLockVisible.value).toBe(false)
    // The pending timer was cancelled and the message never shows.
    expect(lockState.mutationLockMessageVisible.value).toBe(false)

    // A sustained mutation shows the message once the delay elapses.
    lockState.sessionMutationBusy.value = true
    await Vue.nextTick()
    const sustainedTimer = lockState.pendingSessionNoticeTimers.at(-1)
    sustainedTimer?.callback()
    expect(lockState.composerLockVisible.value).toBe(true)
    lockState.sessionMutationBusy.value = false
    await Vue.nextTick()
    expect(lockState.composerLockVisible.value).toBe(false)
  })

  it('blocks New and clear-unfiled actions while another session mutation owns the lock', async () => {
    const lockState = loadGoalLockState(null, true)
    const mounted = mountInlineAgent(lockState)
    const newConversation = mounted.root.querySelector<HTMLButtonElement>('[aria-label="New chat"]')

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
