import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { calculateComposerSizing, caretBoundsFromMirror, scrollTopForCaret } from './agent-composer-sizing.ts'
import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'
import { resolveUserPicture } from '../../helpers/user-picture.ts'
import { createPinia, storeToRefs, type StoreGeneric } from 'pinia'
import { useAgentsStore } from '../../store/agents.ts'
import { agentMediaContentUrl } from '../../helpers/agents-api.ts'
import { emptyAgentDraft } from '../../helpers/agent-draft.ts'
import { searchPages } from '../../helpers/pages-api.ts'
import { fetchWikiSource } from '../../helpers/wiki-source.ts'
import { AgentKnowledgeContextSchema } from '../../../shared/agents/knowledge-context.ts'
import type { AgentProviderProfileView, AgentThreadState } from '../../../shared/agents/contracts.ts'

const componentPath = path.join(process.cwd(), 'client/components/agents/inline-agent-chat.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const descriptor = parse(componentSource, { filename: componentPath }).descriptor
if (!descriptor.template || !descriptor.scriptSetup) throw new Error('inline-agent-chat.vue template and setup script are required')
const inlineScriptMetadata = compileScript(descriptor, { id: 'inline-agent-chat-interaction-test' })
const inlineBindings = inlineScriptMetadata.bindings
if (!inlineBindings) throw new Error('Inline setup metadata was not compiled')
const inlinePropNames = Object.keys(inlineBindings).filter(name => inlineBindings[name] === 'props')

const composerComponentPath = path.join(process.cwd(), 'client/components/agents/agent-composer.vue')
const composerComponentSource = fs.readFileSync(composerComponentPath, 'utf8')
const composerDescriptor = parse(composerComponentSource, { filename: composerComponentPath }).descriptor
if (!composerDescriptor.template || !composerDescriptor.scriptSetup) throw new Error('agent-composer.vue template and setup script are required')

import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
;globalThis.useTranslate = () => translateEnglish

resetBody()

// Vuetify snapshots browser capabilities during module evaluation, so the DOM must exist before loading it here.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')

// Preserve the real imported child. Static import cannot work here: the
// test SFC loader must be registered before loading the .vue module.
Bun.plugin({
  name: 'inline-agent-real-skill-menu',
  setup(builder) {
    builder.onLoad({ filter: /agent-composer-skill-menu\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const script = compileScript(parsed.descriptor, {
        id: 'inline-agent-real-skill-menu',
        genDefaultAs: '__component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${script.content}\nexport default __component;` }
    })
  }
})
const skillMenuComponent = (await import('./agent-composer-skill-menu.vue')).default
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

const pickerPath = path.join(process.cwd(), 'client/components/agents/agent-context-picker.vue')
const pickerDescriptor = parse(fs.readFileSync(pickerPath, 'utf8'), { filename: pickerPath }).descriptor
if (!pickerDescriptor.template || !pickerDescriptor.scriptSetup) throw new Error('Context picker template and script are required')
const pickerTemplate = compileTemplate({
  source: pickerDescriptor.template.content,
  filename: pickerPath,
  id: 'inline-agent-context-picker-test',
  compilerOptions: { mode: 'function' }
})
if (pickerTemplate.errors.length > 0) throw pickerTemplate.errors[0]
const renderPicker = new Function('Vue', pickerTemplate.code)(Vue) as () => unknown
const pickerScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(pickerDescriptor.scriptSetup.content.replace(/^import .*$/gm, ''))
const pickerBindings = Array.from(pickerDescriptor.scriptSetup.content.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm), match => match[1])
const evaluatePicker = new Function(
  '{ computed, nextTick, onBeforeUnmount, ref, useId, watch, defineProps, defineEmits, searchPages, fetchWikiSource, AgentKnowledgeContextSchema }',
  `${pickerScript}\nreturn { ${pickerBindings.join(', ')} }`
) as (dependencies: Record<string, unknown>) => Record<string, unknown>
const contextPickerComponent = Vue.defineComponent({
  props: {
    draft: { type: Object, required: true },
    currentPage: { type: Object, default: null },
    disabled: Boolean,
    connectionBlocked: Boolean,
    connectionRetrying: Boolean
  },
  emits: ['change', 'sourcesAdded', 'retry-connection'],
  setup(props, { emit }) {
    return evaluatePicker({
      computed: Vue.computed,
      nextTick: Vue.nextTick,
      onBeforeUnmount: Vue.onBeforeUnmount,
      ref: Vue.ref,
      useId: Vue.useId,
      watch: Vue.watch,
      defineProps: () => props,
      defineEmits: () => emit,
      searchPages,
      fetchWikiSource,
      AgentKnowledgeContextSchema
    })
  },
  render: renderPicker
})

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
  [binding: string]: unknown
  workspaceReady: ValueRef<boolean>
  registerLifecycle: () => void
  dispose: () => void
  advanceTime: (milliseconds: number) => void
  panelMode: ValueRef<'wide' | 'docked' | 'modal'>
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
  recoverClearUnfiledHistory: () => Promise<void>
  ensureInitialized: () => Promise<boolean>
  clearUnfiledHistoryOpen: ValueRef<boolean>
  newSession: () => Promise<void>
  newTemporarySession: () => Promise<void>
  openClearUnfiledHistory: () => void
  historyOpen: ValueRef<boolean>
  memoryOpen: ValueRef<boolean>
  panelMenuOpen: ValueRef<boolean>
  toggleHistory: () => void
  toggleMemory: () => void
  thread: ValueRef<Record<string, unknown> | null>
  sendPrompt: (content: string) => Promise<boolean>
  currentPage: ValueRef<TestPageHint | null>
  sessionNotice: ValueRef<string>
  setSessionNotice: (message: string) => void
  clearSessionNotice: () => void
  SESSION_NOTICE_VISIBLE_MS: number
  emitted: unknown[][]
  pendingStartersFrames: Array<{ callback: (now: number) => void }>
  clearedStartersFrameIds: number[]
  componentProps: { pageId: number; pageLocale: string; pagePath: string; pageUpdatedAt: string; resumeSessionId?: string }
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
const composerBindings = Array.from(composerScript.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm), match => match[1])
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
  'agentMediaContentUrl',
  `${executableComposerScript}\nreturn { ${composerBindings.join(', ')} }`
) as (...dependencies: unknown[]) => Record<string, unknown>

let stateId = 0

const loadGoalLockState = (
  status: 'active' | 'paused' | null,
  mutationBusy = false,
  runStatus: 'running' | 'awaiting_approval' | null = status === 'active' ? 'running' : null,
  canPinCurrentChat = true,
  workspaceClosed = false,
  page: TestPageHint | null = null,
  realStore?: StoreGeneric
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
    googleSearchPending: ref(null),
    googleSearchSuggestions: ref(null),
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
  const props = Vue.reactive({
    csrfToken: 'csrf',
    mediaProfile: undefined,
    mediaRefreshing: false,
    refreshAfterMedia: () => {},
    ownerId: 2,
    resumeSessionId: undefined as string | undefined,
    providerEnabled: true,
    skillsEnabled: false,
    goalsEnabled: true,
    pageId: page?.id ?? 0,
    pageLocale: page?.locale ?? '',
    pagePath: page?.path ?? '',
    pageUpdatedAt: page?.observedUpdatedAt ?? ''
  })
  const agentCalls = {
    clearUnfiledHistory: vi.fn(() => Promise.resolve()),
    initialize: vi.fn(() => Promise.resolve(true)),
    isWorkspaceReady: vi.fn(() => !workspaceClosed),
    newSession: vi.fn(() => Promise.resolve(true)),
    reloadSessions: vi.fn(() => Promise.resolve({ accepted: true, current: true })),
    sessions: [] as Array<{ id: string; deletedAt: string | null }>,
    send: vi.fn(() => Promise.resolve(true)),
    setCurrentChatPinned: vi.fn(),
    drafts: Vue.reactive({}),
    setDraft: vi.fn(),
    updateDraft: vi.fn(),
    setCurrentPage: vi.fn(),
    pauseNetwork: vi.fn(),
    closeWorkspace: vi.fn(),
    destroyWorkspace: vi.fn()
  }
  let now = 0
  let timerId = 0
  const timers = new Map<number, { callback: () => void; deadline: number }>()
  const advanceTime = (milliseconds: number): void => {
    const target = now + milliseconds
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.deadline <= target).sort((a, b) => a[1].deadline - b[1].deadline)[0]
      if (!next) break
      now = next[1].deadline
      timers.delete(next[0])
      next[1].callback()
    }
    now = target
  }
  const mountedCallbacks: Array<() => void> = []
  const unmountedCallbacks: Array<() => void> = []
  const scope = Vue.effectScope()
  const bindingNames = Array.from(setupScript.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm), match => match[1])
  const emitted: unknown[][] = []
  const pendingStartersFrames: Array<{ callback: (now: number) => void }> = []
  const clearedStartersFrameIds: number[] = []
  const evaluate = new Function(
    '{ computed, nextTick, onBeforeUnmount, onMounted, ref, setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame, useTemplateRef, useId, watch, storeToRefs, defineProps, defineEmits, useAgentsStore, activeOwnedOverlayRoots, createModalFocusScope, isAgentApprovalOutsideViewport, shouldFollowGoalExpansion, pwaState, retryServerConnection, wikiStore, resolveUserPicture, emptyAgentDraft }',
    `${executableScript}\nreturn { ...storeToRefs(agents), ${bindingNames.join(', ')} }`
  ) as (dependencies: Record<string, unknown>) => LockState

  const state = scope.run(() => evaluate({
    computed: Vue.computed,
    nextTick: Vue.nextTick,
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId
      timers.set(id, { callback, deadline: now + delay })
      return id
    },
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: (now: number) => void) => {
      pendingStartersFrames.push({ callback })
      return pendingStartersFrames.length
    },
    cancelAnimationFrame: (id: number) => {
      clearedStartersFrameIds.push(id)
    },
    onBeforeUnmount: (callback: () => void) => unmountedCallbacks.push(callback),
    onMounted: (callback: () => void) => mountedCallbacks.push(callback),
    ref,
    useTemplateRef: () => ref(null),
    useId: () => `agent-state-${++stateId}`,
    watch: Vue.watch,
    storeToRefs: realStore ? storeToRefs : () => storeRefs,
    defineEmits: () => (...event: unknown[]) => { emitted.push(event) },
    defineProps: () => props,
    useAgentsStore: () => realStore ?? agentCalls,
    activeOwnedOverlayRoots: () => [],
    createModalFocusScope: () => ({ deactivate: () => undefined }),
    isAgentApprovalOutsideViewport: () => false,
    shouldFollowGoalExpansion: () => false,
    pwaState: testPwaState,
    retryServerConnection: async () => true,
    wikiStore: { user: { id: 2, name: 'Test User', pictureUrl: '' } },
    resolveUserPicture,
    emptyAgentDraft
  })) as LockState
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    scope.stop()
    for (const callback of unmountedCallbacks) callback()
    timers.clear()
  }
  stateCleanups.push(dispose)
  return {
    ...state,
    agentCalls: realStore ? realStore as unknown as LockState['agentCalls'] : agentCalls,
    componentProps: props,
    emitted,
    advanceTime,
    pendingStartersFrames,
    clearedStartersFrameIds,
    dispose,
    registerLifecycle: () => {
      for (const callback of mountedCallbacks) Vue.onMounted(callback)
      Vue.onBeforeUnmount(dispose)
    }
  }
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

let resizeViewport: ((width: number) => void) | null = null
const installBrowserSurface = (): void => {
  if (resizeViewport) return
  let width = 390
  const previousWidth = Object.getOwnPropertyDescriptor(browserWindow, 'innerWidth')
  const previousScrollTo = Object.getOwnPropertyDescriptor(browserWindow.Element.prototype, 'scrollTo')
  const originalMatchMedia = browserWindow.matchMedia.bind(browserWindow)
  const queries = new Map<string, MediaQueryList>()
  const matchesWidth = (query: string): boolean => {
    const constraints = [...query.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g)]
    return constraints.length
      ? constraints.every(([, boundary, pixels]) => boundary === 'min' ? width >= Number(pixels) : width <= Number(pixels))
      : originalMatchMedia(query).matches
  }
  Object.defineProperty(browserWindow, 'innerWidth', { configurable: true, get: () => width })
  vi.spyOn(browserWindow, 'matchMedia').mockImplementation(query => {
    const existing = queries.get(query)
    if (existing) return existing
    const media = new browserWindow.EventTarget() as MediaQueryList
    Object.defineProperties(media, {
      media: { value: query },
      matches: { get: () => matchesWidth(query) }
    })
    media.onchange = null
    media.addListener = listener => { if (listener) media.addEventListener('change', listener as EventListener) }
    media.removeListener = listener => { if (listener) media.removeEventListener('change', listener as EventListener) }
    queries.set(query, media)
    return media
  })
  Object.defineProperty(browserWindow.Element.prototype, 'scrollTo', {
    configurable: true,
    value(this: Element, optionsOrX: ScrollToOptions | number = {}, y?: number): void {
      const options = typeof optionsOrX === 'number' ? { left: optionsOrX, top: y ?? 0 } : optionsOrX
      const previousTop = this.scrollTop
      const previousLeft = this.scrollLeft
      if (options.top !== undefined) this.scrollTop = Math.max(0, Math.min(options.top, Math.max(0, this.scrollHeight - this.clientHeight)))
      if (options.left !== undefined) this.scrollLeft = Math.max(0, Math.min(options.left, Math.max(0, this.scrollWidth - this.clientWidth)))
      if (this.scrollTop !== previousTop || this.scrollLeft !== previousLeft) this.dispatchEvent(new browserWindow.Event('scroll'))
    }
  })
  resizeViewport = nextWidth => {
    const previous = new Map([...queries.values()].map(media => [media, media.matches]))
    width = nextWidth
    for (const [media, matched] of previous) {
      if (media.matches === matched) continue
      const event = new browserWindow.Event('change') as MediaQueryListEvent
      Object.defineProperties(event, { matches: { value: media.matches }, media: { value: media.media } })
      media.dispatchEvent(event)
      media.onchange?.call(media, event)
    }
    browserWindow.dispatchEvent(new browserWindow.Event('resize'))
  }
  stateCleanups.push(() => {
    resizeViewport = null
    if (previousWidth) Object.defineProperty(browserWindow, 'innerWidth', previousWidth)
    else Reflect.deleteProperty(browserWindow, 'innerWidth')
    if (previousScrollTo) Object.defineProperty(browserWindow.Element.prototype, 'scrollTo', previousScrollTo)
    else Reflect.deleteProperty(browserWindow.Element.prototype, 'scrollTo')
  })
}
const mountedApps: Array<() => void> = []
const stateCleanups: Array<() => void> = []
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 32; turn += 1) await Promise.resolve()
  await Vue.nextTick()
  await Vue.nextTick()
}

const sessionId = '00000000-0000-4000-8000-000000000001'
const timestamp = '2026-09-15T10:00:00.000Z'
// Fixture-only signing material; this harness exercises client continuity, not server authorization.
const profileResolutionToken = (id: string, version: number): string => {
  const kid = 'inline-agent-interaction'
  const payload = Buffer.from(JSON.stringify({
    v: 1, kid, ownerId: 2, sessionId: id, sessionVersion: version,
    profileId: profileFixture.id, profileVersionId: '00000000-0000-4000-8000-000000000011',
    profileVersion: 1, profilePolicyVersion: profileFixture.policyVersion, defaultGeneration: 1,
    executionMode: 'agent', googleSearchEnabled: false, exp: 4_000_000_000
  })).toString('base64url')
  return `${kid}.${payload}.${createHmac('sha256', 'inline-agent-interaction-fixture-key').update(payload).digest('base64url')}`
}
const threadFixture = (id = sessionId, retention: 'saved' | 'temporary' = 'saved'): AgentThreadState => ({
  session: {
    id, title: 'Release planning', retention, folderId: null, status: 'active', executionMode: 'agent',
    version: 1, providerProfileId: null, profileResolutionToken: profileResolutionToken(id, 1), googleSearchEnabled: false, skills: [], currentRun: null,
    createdAt: timestamp, updatedAt: timestamp, lastActivityAt: timestamp,
    expiresAt: retention === 'temporary' ? '2026-09-16T10:00:00.000Z' : null
  },
  messages: [], tools: [], tasks: [], artifacts: [], proposals: [], goal: null,
  historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false },
  suggestions: []
})
const profileFixture: AgentProviderProfileView = {
  id: '00000000-0000-4000-8000-000000000010', name: 'Test provider', transport: 'openai-chat', model: 'test',
  utilityModel: null, destinationHost: 'provider.test',
  capabilities: { streaming: true, toolCalling: 'native', parallelToolCalls: false, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 4096, maxOutputTokens: 1024 },
  capabilityRevision: 'test', policyVersion: 1, isGlobalDefault: true
}
const realWorkspace = (retention: 'saved' | 'temporary' = 'saved', page: TestPageHint | null = null) => {
  const store = useAgentsStore(createPinia())
  let serverThread = threadFixture(sessionId, retention)
  const creations: Array<{ retention: 'saved' | 'temporary'; thread: AgentThreadState }> = []
  const authorization = { pending: null as Promise<Response> | null }
  const summary = () => {
    const { session } = serverThread
    return { ...session, deletedAt: null }
  }
  vi.spyOn(browserWindow, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), browserWindow.location.href)
    const path = url.pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    if (path === '/_api/agents/profiles') return authorization.pending ?? Response.json({ profiles: [profileFixture] })
    if (path === '/_api/agents/skills') return Response.json({ skills: [] })
    if (path === '/_api/agents/conversation-folders') return Response.json({ folders: [] })
    if (path === '/_api/agents/sessions' && method === 'GET') return Response.json({ sessions: [summary()], nextCursor: null })
    if (path === '/_api/agents/sessions' && method === 'POST') {
      const next = creations.shift()
      if (!next || body.retention !== next.retention) throw new Error('Unexpected session creation retention')
      serverThread = next.thread
      return Response.json({ ...serverThread, launchPage: null })
    }
    if (path === `/_api/agents/sessions/${serverThread.session.id}` && method === 'PATCH') {
      if (body.retention !== 'saved' || body.expectedSessionVersion !== serverThread.session.version) throw new Error('Unexpected retention mutation')
      const version = serverThread.session.version + 1
      serverThread = { ...serverThread, session: { ...serverThread.session, retention: 'saved', version, profileResolutionToken: profileResolutionToken(serverThread.session.id, version), expiresAt: null } }
      return Response.json(serverThread)
    }
    if (path === `/_api/agents/sessions/${serverThread.session.id}` && method === 'GET') return Response.json(serverThread)
    if (path === `/_api/agents/sessions/${serverThread.session.id}/messages` && method === 'POST') {
      const run: NonNullable<AgentThreadState['session']['currentRun']> = {
        id: '00000000-0000-4000-8000-000000000020', sessionId: serverThread.session.id, status: 'succeeded', attempt: 1, eventSequence: 1,
        canCancel: false, createdAt: timestamp, startedAt: timestamp, completedAt: timestamp, errorCode: null, errorMessage: null
      }
      serverThread = { ...serverThread, session: { ...serverThread.session, currentRun: run } }
      return Response.json({ run, replayed: false })
    }
    if (method === 'DELETE' && /^\/_api\/agents\/sessions\/[a-f0-9-]+$/.test(path)) return new Response(null, { status: 204 })
    throw new Error(`Unexpected Agent request: ${method} ${path}`)
  })
  store.$patch({
    csrfToken: 'csrf', pinOwnerId: 2, routeSync: false, connection: 'connected',
    initializedWorkspaceVersion: store.workspaceVersion, thread: serverThread, profiles: [profileFixture], contextPage: page,
    continuitySessionId: serverThread.session.id, conversationPage: page ? { id: page.id, locale: page.locale } : null
  })
  const state = () => loadGoalLockState(null, false, null, true, false, page, store)
  stateCleanups.push(() => { store.closeWorkspace(); store.$dispose() })
  return { store, state, creations, authorization }
}

const menuAction = (items: HTMLElement[], name: string): HTMLElement => {
  const item = items.find(candidate => candidate.querySelector('.v-list-item-title')?.textContent?.trim() === name)
  if (!item) throw new Error(`Missing More chat actions item: ${name}`)
  return item
}

const mountInlineAgent = (
  lockState: LockState = loadGoalLockState(null),
  options: {
    readonly viewportWidth?: number
    readonly approvalJumpVisible?: boolean
    readonly followJumpVisible?: boolean
  } = {}
): MountedInlineAgent => {
  installBrowserSurface()
  if (options.viewportWidth !== undefined) resizeViewport?.(options.viewportWidth)
  const host = document.createElement('div')
  document.body.append(host)
  const historyOpen = lockState.historyOpen
  const memoryOpen = lockState.memoryOpen
  const composerFocused = lockState.composerFocused
  const transcriptFollowing = lockState.transcriptFollowing as ValueRef<boolean>
  const context = { ...Vue.toRefs(lockState.componentProps), ...lockState }
  if (options.approvalJumpVisible !== undefined) (lockState.approvalJumpVisible as ValueRef<boolean>).value = options.approvalJumpVisible
  if (options.followJumpVisible !== undefined) {
    context.followJumpVisible = Vue.computed(() => options.followJumpVisible && !(lockState.approvalJumpVisible as ValueRef<boolean>).value)
    context.transcriptReadingProgress = Vue.computed(() => options.followJumpVisible ? 1 : 0)
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
      skillsLoading: Boolean,
      generationToolsEnabled: Boolean,
      googleSearchAvailable: Boolean,
      googleSearchEnabled: Boolean,
      googleSearchBusy: Boolean,
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
    emits: ['send', 'stop', 'manageSkills', 'retrySkills', 'updateSkillPreferences', 'draftChange', 'compositionChange', 'mediaSettled', 'updateGoogleSearch'],
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
        scrollTopForCaret,
        agentMediaContentUrl
      )
      return bindings
    },
    render: renderAgentComposer
  })
  const inlineHarness = Vue.defineComponent({
    name: 'InlineAgentInteractionHarness',
    // Optional template props must exist in the same compiler-owned scope as
    // the SFC, even when a fixture does not pass them.
    props: inlinePropNames,
    render: renderInlineAgent,
    setup: () => {
      lockState.registerLifecycle()
      return context
    }
  })
  const app = Vue.createApp(inlineHarness, Object.fromEntries(Object.entries(lockState.componentProps).filter(([name]) => inlinePropNames.includes(name))))
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.config.globalProperties.$t = translateEnglish
  for (const name of ['AgentGoalStatus', 'AgentMcpApproval', 'AgentMemoryManager', 'AgentPersonalSkills', 'AgentThread', 'WikiSourcePreview'])
    app.component(name, componentStub)
  app.component('AgentHistoryPanel', Vue.defineComponent({
    props: { headingId: String, descriptionId: String },
    setup(props) {
      return () => Vue.h('div', [
        Vue.h('h2', { id: props.headingId }, 'Conversations'),
        Vue.h('p', { id: props.descriptionId }, 'Conversation history')
      ])
    }
  }))
  app.component('AgentContextPicker', contextPickerComponent)
  app.component('AgentComposer', composerComponent)
  app.component('AgentComposerSkillMenu', skillMenuComponent)
  app.component('AgentComposerMedia', { template: '<div />' })
  app.component('AgentDictationWaveform', { template: '<canvas class="agent-dictation-waveform" />' })
  app.mount(host)

  const root = host.querySelector<HTMLElement>('.inline-agent')
  const activator = host.querySelector<HTMLElement>('[aria-label="More chat actions"]')
  if (!root || !activator) throw new Error('Inline Agent mobile panel controls did not render')
  let mounted = true
  const unmount = (): void => {
    if (!mounted) return
    mounted = false
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
  expect(context.getAttribute('role')).toBe('group')
  expect(context.getAttribute('aria-label')).toBe('Message tools')
  expect(status.id).not.toBe('')
  expect(status.matches('.sr-only')).toBe(true)
  expect(status.getAttribute('role')).toBe('status')
  expect(status.getAttribute('aria-live')).toBe('polite')
  expect(status.getAttribute('aria-atomic')).toBe('true')
  expect(primary.getAttribute('role')).toBe('group')
  expect(primary.getAttribute('aria-label')).toBe('Message actions')

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
  menuAction(items, 'Memory')
  menuAction(items, 'Pin chat')
  menuAction(items, options.isTemporary ? 'Keep conversation' : 'Temporary chat')
  expect(items.every(item => item.getAttribute('role') === 'listitem')).toBe(true)
  expect(items.every(item => item.getAttribute('role') !== 'menu')).toBe(true)
  expect(items.every(item => item.hasAttribute('tabindex') || item.classList.contains('v-list-item--disabled'))).toBe(true)
  return items
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  for (const dispose of stateCleanups.splice(0)) dispose()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Inline Agent mobile panel controls', () => {
  it('opens History from its header when the workspace is ready', async () => {
    const mounted = mountInlineAgent(loadGoalLockState(null))
    const historyToggle = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__history-toggle')
    if (!historyToggle) throw new Error('History toggle did not render')

    historyToggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle()

    expect(historyToggle.getAttribute('aria-expanded')).toBe('true')
    expect(mounted.root.querySelector('.inline-agent__side--history')).not.toBeNull()
  })

  it('keeps History closed when the workspace is unavailable', async () => {
    const mounted = mountInlineAgent(loadGoalLockState(null, false, null, true, true))
    const historyToggle = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__history-toggle')
    if (!historyToggle) throw new Error('History toggle did not render')

    historyToggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle()

    expect(historyToggle.getAttribute('aria-expanded')).toBe('false')
    expect(mounted.root.querySelector('.inline-agent__side--history')).toBeNull()
  })

})

describe('Inline Agent workspace actions', () => {
  it('keeps a temporary conversation through More chat actions and creates a saved conversation through New', async () => {
    const workspace = realWorkspace('temporary')
    const mounted = mountInlineAgent(workspace.state())
    const historyToggle = mounted.root.querySelector<HTMLButtonElement>('[aria-label="History"]')
    const newChat = mounted.root.querySelector<HTMLButtonElement>('[aria-label="New chat"]')
    if (!historyToggle || !newChat) throw new Error('Header actions did not render')
    expect(historyToggle.getAttribute('aria-expanded')).toBe('false')
    expect(historyToggle.getAttribute('aria-controls')).toBeTruthy()
    historyToggle.click()
    await settle()
    expect(document.getElementById(historyToggle.getAttribute('aria-controls') ?? '')?.getAttribute('role')).toBe('dialog')
    historyToggle.click()
    await settle()

    const items = await openPanelMenu(mounted, { isTemporary: true })
    menuAction(items, 'Keep conversation').click()
    await settle()
    expect(workspace.store.thread?.session).toMatchObject({ id: sessionId, retention: 'saved', version: 2 })
    expect(mounted.root.querySelector('.inline-agent__retention')).toBeNull()
    expect(mounted.root.querySelector('[role="status"].inline-agent__session-notice')?.textContent).toContain('Conversation kept')

    const saved = threadFixture('00000000-0000-4000-8000-000000000002')
    workspace.creations.push({ retention: 'saved', thread: saved })
    newChat.click()
    await settle()
    expect(workspace.store.thread?.session).toMatchObject({ id: saved.session.id, retention: 'saved' })
    expect(mounted.root.querySelector('.inline-agent__retention')).toBeNull()
  })

  it('starts a selected temporary conversation from More chat actions and discloses its retention', async () => {
    const workspace = realWorkspace()
    const temporary = threadFixture('00000000-0000-4000-8000-000000000003', 'temporary')
    workspace.creations.push({ retention: 'temporary', thread: temporary })
    const mounted = mountInlineAgent(workspace.state())
    const items = await openPanelMenu(mounted)
    menuAction(items, 'Temporary chat').click()
    await settle()
    expect(workspace.store.thread?.session).toMatchObject({ id: temporary.session.id, retention: 'temporary' })
    const retention = mounted.root.querySelector<HTMLElement>('.inline-agent__retention')
    expect(retention?.getAttribute('role')).toBe('status')
    expect(retention?.getAttribute('aria-label')).toBe('Temporary chat')
    expect(retention?.textContent).toContain('Hidden from history')
  })


  it('names the workspace accessibly and updates the selected conversation title', async () => {
    const state = loadGoalLockState(null)
    const mounted = mountInlineAgent(state)
    const title = document.getElementById(mounted.root.getAttribute('aria-labelledby') ?? '')
    expect(title?.getAttribute('aria-label') ?? title?.textContent?.trim()).toBe('Wiki Agent')
    expect(mounted.root.querySelector('.inline-agent__session-title')?.textContent?.trim()).toBe('Release planning')
    const thread = state.thread.value
    if (!thread) throw new Error('Selected thread missing')
    const session = thread.session as { title: string }
    session.title = 'Launch checklist'
    await settle()
    expect(mounted.root.querySelector('.inline-agent__session-title')?.textContent?.trim()).toBe('Launch checklist')
  })


  it('reinitializes a closed workspace on mount without requiring Retry', async () => {
    const workspace = realWorkspace()
    const first = mountInlineAgent(workspace.state())
    await settle()
    first.unmount()
    expect(workspace.store.isWorkspaceReady()).toBe(false)
    const reopened = mountInlineAgent(workspace.state())
    await settle()
    expect(workspace.store.isWorkspaceReady()).toBe(true)
    expect(workspace.store.thread?.session.id).toBe(sessionId)
    expect(reopened.root.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false)
    expect(reopened.root.querySelector('.inline-agent__session-title')?.textContent?.trim()).toBe('Release planning')
    expect(reopened.root.querySelector('.inline-agent__initialization-error')).toBeNull()
  })

  it('mounts a usable source picker and message textbox in the workspace', () => {
    const mounted = mountInlineAgent()
    expect(mounted.root.querySelectorAll('[aria-label="Conversation source controls"]')).toHaveLength(1)
    expect(mounted.root.querySelector<HTMLButtonElement>('[aria-label="Add sources"]')?.disabled).toBe(false)
    expect(mounted.root.querySelector<HTMLButtonElement>('[aria-label="Choose Agent search scope"]')?.disabled).toBe(false)
    expect(mounted.root.querySelector('textarea')).not.toBeNull()
  })

  it('offers labelled no-page starters and admits a Wiki-wide run', async () => {
    const workspace = realWorkspace()
    const mounted = mountInlineAgent(workspace.state())
    const group = mounted.root.querySelector('[role="group"][aria-label="Suggested prompts"]')
    expect(group).not.toBeNull()
    const starter = Array.from(group?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(button => button.textContent?.includes('Explore the Wiki'))
    if (!starter) throw new Error('No-page exploration starter missing')
    starter.click()
    await settle()
    expect(workspace.store.thread?.session.currentRun).toMatchObject({ sessionId, status: 'succeeded' })
    expect(workspace.store.error).toBe('')
  })
  it('keeps the Included page synchronized with Wiki navigation across a send and reopen', async () => {
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
    const workspace = realWorkspace('saved', firstPage)
    const first = workspace.state()
    const mounted = mountInlineAgent(first)
    const expectIncluded = (root: HTMLElement, page: TestPageHint): void => {
      const chip = root.querySelector('[aria-pressed="true"].agent-context__page-chip')
      expect(chip?.getAttribute('aria-label')).toBe(`Include current page: ${page.locale}/${page.path}`)
    }
    expect(first.currentPage.value).toEqual(firstPage)
    expectIncluded(mounted.root, firstPage)
    const next = threadFixture('00000000-0000-4000-8000-000000000004')
    workspace.creations.push({ retention: 'saved', thread: next })
    first.componentProps.pageId = secondPage.id
    first.componentProps.pageLocale = secondPage.locale
    first.componentProps.pagePath = secondPage.path
    first.componentProps.pageUpdatedAt = secondPage.observedUpdatedAt
    await settle()
    expect(first.currentPage.value).toEqual(secondPage)
    expectIncluded(mounted.root, secondPage)
    expect(workspace.store.thread?.session.id).toBe(next.session.id)
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.agent-composer__input textarea')
    const submit = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__submit')
    if (!textarea || !submit) throw new Error('Composer send controls missing')
    textarea.value = 'Explain this page'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(workspace.store.drafts[next.session.id]?.text).toBe('Explain this page')
    submit.click()
    await settle()
    expect(workspace.store.thread?.session.currentRun).toMatchObject({ sessionId: next.session.id, status: 'succeeded' })
    expect(workspace.store.drafts[next.session.id]?.text).toBe('')
    expect(textarea.value).toBe('')
    expectIncluded(mounted.root, secondPage)
    mounted.unmount()
    const reopenedState = loadGoalLockState(null, false, null, true, false, secondPage, workspace.store)
    const reopened = mountInlineAgent(reopenedState)
    await settle()
    expect(reopenedState.currentPage.value).toEqual(secondPage)
    expectIncluded(reopened.root, secondPage)
  })

  it('allows a starter to submit only once while its first request is in flight', async () => {
    const lockState = loadGoalLockState(null)
    let complete!: (success: boolean) => void
    const pending = new Promise<boolean>(resolve => { complete = resolve })
    lockState.agentCalls.send = vi.fn(() => pending)
    const mounted = mountInlineAgent(lockState)
    const starter = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__starter')
    if (!starter) throw new Error('Conversation starter did not render')

    starter.click()
    starter.click()
    await settle()

    expect(lockState.agentCalls.send).toHaveBeenCalledTimes(1)
    starter.click()
    await settle()
    expect(lockState.agentCalls.send).toHaveBeenCalledTimes(1)
    const competing = lockState.sendPrompt('Concurrent search handoff')
    await settle()
    expect(lockState.agentCalls.send).toHaveBeenCalledTimes(1)
    complete(true)
    await competing
    await settle()
    expect((lockState.promptSubmissionPending as ValueRef<boolean>).value).toBe(false)
    starter.click()
    await settle()
    expect(lockState.agentCalls.send).toHaveBeenCalledTimes(2)
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
    focusedTextarea.dispatchEvent(new (document.defaultView!.FocusEvent)('focusin', { bubbles: true }))
    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(true)
    const editingTranscript = getTranscript()
    const transcriptPointerEvent = new MouseEvent('pointerdown', { bubbles: true }) as unknown as PointerEvent
    editingTranscript.dispatchEvent(transcriptPointerEvent)
    await settle()
    expect(document.activeElement).toBe(focusedTextarea)
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(false)
    editingTranscript.focus()
    expect(document.activeElement).toBe(editingTranscript)
    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(false)

    const refocusedTextarea = getTextarea()
    refocusedTextarea.focus()
    expect(document.activeElement).toBe(refocusedTextarea)
    refocusedTextarea.dispatchEvent(new (document.defaultView!.FocusEvent)('focusin', { bubbles: true }))
    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(true)
    const refocusTranscript = getTranscript()
    refocusTranscript.focus()
    expect(document.activeElement).toBe(refocusTranscript)
    const transcriptFocusEvent = new (document.defaultView!.FocusEvent)('focusin', { bubbles: true })
    refocusTranscript.dispatchEvent(transcriptFocusEvent)
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
    await settle()
    expect(mounted.root.getAttribute('data-panel-mode')).toBe('modal')
    expect(mounted.root.querySelector('.inline-agent__composer')).not.toBeNull()

    mounted.historyOpen.value = true
    await settle()

    const history = mounted.root.querySelector<HTMLElement>('.inline-agent__side--history')
    expect(history?.getAttribute('role')).toBe('dialog')
    const heading = document.getElementById(history?.getAttribute('aria-labelledby') ?? '')
    const descriptions = history ? resolveDescribedBy(history) : []
    expect(heading?.tagName).toBe('H2')
    expect(heading?.textContent?.trim()).toBe('Conversations')
    expect(heading && history?.contains(heading)).toBe(true)
    expect(descriptions.map(description => description.textContent?.trim())).toEqual(['Conversation history'])
    expect(descriptions.every(description => history?.contains(description) && !description.hidden)).toBe(true)
  })

  it('reconciles modal, docked and wide panels from viewport changes and stops observing after teardown', async () => {
    const state = loadGoalLockState(null)
    const mounted = mountInlineAgent(state, { viewportWidth: 1023 })
    await settle()
    state.toggleHistory()
    await settle()
    expect(mounted.root.getAttribute('data-panel-mode')).toBe('modal')
    expect(mounted.root.querySelector('.inline-agent__side--history')?.getAttribute('aria-modal')).toBe('true')
    expect(mounted.root.querySelector('.inline-agent__scrim')).not.toBeNull()

    resizeViewport?.(1024)
    await settle()
    expect(mounted.root.getAttribute('data-panel-mode')).toBe('docked')
    expect(mounted.root.querySelector('.inline-agent__side--history')?.getAttribute('role')).toBe('complementary')
    expect(mounted.root.querySelector('.inline-agent__side--history')?.hasAttribute('aria-modal')).toBe(false)
    expect(mounted.root.querySelector('.inline-agent__scrim')).toBeNull()
    state.toggleMemory()
    await settle()
    expect(mounted.root.querySelector('.inline-agent__side--history')).toBeNull()
    expect(mounted.root.querySelector('.inline-agent__side--memory')?.getAttribute('role')).toBe('complementary')

    resizeViewport?.(1760)
    await settle()
    state.toggleHistory()
    await settle()
    expect(mounted.root.getAttribute('data-panel-mode')).toBe('wide')
    expect(mounted.root.querySelector('.inline-agent__side--history')).not.toBeNull()
    expect(mounted.root.querySelector('.inline-agent__side--memory')).not.toBeNull()
    expect(mounted.root.querySelector('.inline-agent__composer')).not.toBeNull()

    resizeViewport?.(390)
    await settle()
    expect(mounted.root.getAttribute('data-panel-mode')).toBe('modal')
    expect(mounted.root.querySelector('.inline-agent__side--history')?.getAttribute('role')).toBe('dialog')
    const closedMemory = mounted.root.querySelector<HTMLElement>('.inline-agent__side--memory')
    expect(closedMemory === null || browserWindow.getComputedStyle(closedMemory).display === 'none').toBe(true)
    mounted.unmount()
    resizeViewport?.(1760)
    await settle()
    expect(state.panelMode.value).toBe('modal')
  })
})

describe('Inline Agent latest response dock', () => {
  it('names the latest response button and hides its decorative halo from assistive technology', () => {
    const mounted = mountInlineAgent(undefined, { followJumpVisible: true })
    const button = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__follow-jump')
    const halo = mounted.root.querySelector<HTMLElement>('.inline-agent__follow-jump-halo')

    if (!button || !halo) throw new Error('Latest response control did not render')
    expect(button.getAttribute('aria-label')).toBe('Jump to latest response')
    expect(button.querySelectorAll('button')).toHaveLength(0)
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
  it('announces Ready with an accessible Send action and labelled workspace controls', () => {
    const mounted = mountInlineAgent()
    const { primary, status } = expectComposerActionStructure(mounted)
    const submit = primary.querySelector<HTMLButtonElement>('.agent-composer__submit')
    const newChat = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__new-session')
    const moreMenu = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__more-menu')

    expect(status.textContent?.trim()).toBe('Ready')
    expect(submit?.tagName).toBe('BUTTON')
    expect(submit?.textContent?.trim()).toBe('Send')
    expect(primary.querySelector('.agent-composer__stop')).toBeNull()
    expect(newChat?.getAttribute('aria-label')).toBe('New chat')
    expect(moreMenu?.getAttribute('aria-label')).toBe('More chat actions')
  })

  it('announces Working with Stop instead of Send during an active run', () => {
    const mounted = mountInlineAgent(loadGoalLockState('active'))
    const { primary, status } = expectComposerActionStructure(mounted)
    const stop = primary.querySelector<HTMLButtonElement>('.agent-composer__stop')

    expect(status.textContent?.trim()).toBe('Working')
    expect(stop?.tagName).toBe('BUTTON')
    expect(stop?.textContent?.trim()).toBe('Stop response')
    expect(primary.querySelector('.agent-composer__submit')).toBeNull()
  })

  it('disables Pin while selection is unsettled but allows it during active runs and goals', async () => {
    const workspace = realWorkspace()
    const disabled = (item: HTMLElement): boolean =>
      item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true' || item.classList.contains('v-list-item--disabled')
    workspace.authorization.pending = new Promise<Response>(() => {})
    workspace.store.initializedWorkspaceVersion = null
    const unsettled = mountInlineAgent(workspace.state())
    expect(disabled(menuAction(await openPanelMenu(unsettled), 'Pin chat'))).toBe(true)
    unsettled.unmount()

    workspace.authorization.pending = null
    workspace.store.$patch({
      workspaceDisposed: false, networkPaused: false, loading: false, connection: 'connected',
      profiles: [profileFixture],
      initializedWorkspaceVersion: workspace.store.workspaceVersion,
      thread: {
        ...threadFixture(),
        session: {
          ...threadFixture().session,
          currentRun: {
            id: '00000000-0000-4000-8000-000000000020', sessionId, status: 'running', attempt: 1, eventSequence: 1,
            canCancel: true, createdAt: timestamp, startedAt: timestamp, completedAt: null, errorCode: null, errorMessage: null
          }
        }
      }
    })
    const running = mountInlineAgent(workspace.state())
    expect(disabled(menuAction(await openPanelMenu(running), 'Pin chat'))).toBe(false)
    running.unmount()
    workspace.store.$patch({
      workspaceDisposed: false, networkPaused: false, loading: false, connection: 'connected',
      initializedWorkspaceVersion: workspace.store.workspaceVersion, profiles: [profileFixture]
    })
    const activeThread = workspace.store.thread
    if (!activeThread) throw new Error('Active conversation missing')
    workspace.store.thread = {
      ...activeThread,
      goal: {
        id: '00000000-0000-4000-8000-000000000030', sessionId, objective: 'Plan the release', status: 'active', version: 1,
        currentRunId: '00000000-0000-4000-8000-000000000020', continuationCount: 0, maxContinuations: 4,
        consumedTokens: 0, maxTokens: 4096, consumedToolCalls: 0, maxToolCalls: 16,
        budgetPolicyVersion: null, budgetSelection: 'legacy', tokenTier: null, tokenAllowance: null,
        budgetCycle: 0, budgetLimitReason: null, canRenewTokenBudget: false,
        startedAt: timestamp, deadlineAt: '2026-09-16T10:00:00.000Z', completedAt: null,
        errorCode: null, errorMessage: null, completion: null
      }
    }
    const goal = mountInlineAgent(workspace.state())
    expect(disabled(menuAction(await openPanelMenu(goal), 'Pin chat'))).toBe(false)
  })

  it('announces Review needed with Stop instead of Send while awaiting approval', () => {
    const mounted = mountInlineAgent(loadGoalLockState('active', false, 'awaiting_approval'))
    const { primary, status } = expectComposerActionStructure(mounted)
    const stop = primary.querySelector<HTMLButtonElement>('.agent-composer__stop')

    expect(status.textContent?.trim()).toBe('Review needed')
    expect(stop?.textContent?.trim()).toBe('Stop response')
    expect(primary.querySelector('.agent-composer__submit')).toBeNull()
  })
})

describe('Inline Agent session notice', () => {
  it('expires visible notices after five seconds and gives replacements their own window', async () => {
    const state = loadGoalLockState(null)
    const mounted = mountInlineAgent(state)
    const notice = () => mounted.root.querySelector('.inline-agent__session-notice')
    state.setSessionNotice('First notice')
    await settle()
    expect(notice()?.textContent).toBe('First notice')
    state.advanceTime(4_900)
    state.setSessionNotice('Replacement notice')
    await settle()
    state.advanceTime(100)
    await settle()
    expect(notice()?.textContent).toBe('Replacement notice')
    state.advanceTime(4_899)
    await settle()
    expect(notice()?.textContent).toBe('Replacement notice')
    state.advanceTime(1)
    await settle()
    expect(state.sessionNotice.value).toBe('')
    expect(notice()).toBeNull()
    state.setSessionNotice('')
    await settle()
    expect(notice()).toBeNull()
    state.setSessionNotice('Cleared notice')
    state.clearSessionNotice()
    await settle()
    expect(state.sessionNotice.value).toBe('')
    expect(notice()).toBeNull()
    state.advanceTime(4_900)
    state.setSessionNotice('After clear')
    state.advanceTime(100)
    await settle()
    expect(notice()?.textContent).toBe('After clear')
  })
})

describe('Inline Agent conversation starters', () => {
  it('renders one static, centered set of suggested prompts below the greeting', () => {
    const mounted = mountInlineAgent()
    const welcome = mounted.root.querySelector<HTMLElement>('.inline-agent__welcome')
    expect(welcome?.getAttribute('aria-label')).toBe('Start a conversation')
    // The rotating two-line greeting is text, not a second section heading.
    expect(welcome?.querySelector('h1, h2, h3')).toBeNull()
    expect(welcome?.querySelectorAll('p.inline-agent__welcome-title .inline-agent__welcome-line')).toHaveLength(2)
    const group = mounted.root.querySelector<HTMLElement>('[role="group"][aria-label="Suggested prompts"]')
    expect(group?.classList.contains('inline-agent__starters--marquee')).toBe(false)
    const starters = Array.from(group?.querySelectorAll<HTMLButtonElement>('.inline-agent__starter') ?? [])
    expect(starters.map(starter => starter.querySelector('strong')?.textContent?.trim())).toEqual(['Explore the Wiki', 'Connect the dots', 'Catch up'])
    expect(starters.map(starter => starter.querySelector('.inline-agent__starter-copy')?.textContent?.trim())).toEqual([
      'Find a place to begin',
      'Discover related knowledge',
      'See what changed recently'
    ])
    // No duplicated marquee clones: every starter is a real, reachable control.
    expect(starters.every(starter => !starter.hasAttribute('aria-hidden') && starter.getAttribute('tabindex') !== '-1')).toBe(true)
    expect(group?.hasAttribute('aria-describedby')).toBe(false)
  })

  it('keeps blocked starters focusable, explains why, and does not send', async () => {
    const lockState = loadGoalLockState(null, true)
    const mounted = mountInlineAgent(lockState)
    await settle()
    const group = mounted.root.querySelector<HTMLElement>('[role="group"][aria-label="Suggested prompts"]')
    const starters = Array.from(group?.querySelectorAll<HTMLButtonElement>('.inline-agent__starter') ?? [])
    expect(starters).toHaveLength(3)
    expect(starters.every(starter => !starter.disabled && starter.getAttribute('aria-disabled') === 'true')).toBe(true)
    const reasonId = group?.getAttribute('aria-describedby')
    const reason = reasonId ? mounted.root.querySelector<HTMLElement>(`[id="${reasonId}"]`) : null
    expect(reason?.textContent?.trim()).toBe(lockState.submitUnavailableReason.value)
    expect(reason?.textContent?.trim()).not.toBe('')
    starters[0]?.click()
    await settle()
    expect(lockState.agentCalls.send).not.toHaveBeenCalled()
  })
  it('keeps a blocked, unopened workspace inside the body glass with starters above a bottom-docked composer', async () => {
    const lockState = loadGoalLockState(null)
    ;(lockState.thread as ValueRef<unknown>).value = null
    ;(lockState.networkPaused as ValueRef<boolean>).value = true
    const mounted = mountInlineAgent(lockState)
    await settle()
    // The notice lives in the blurred conversation body, never in the
    // transparent card gap between the header and the body.
    const notices = Array.from(mounted.root.querySelectorAll<HTMLElement>('.inline-agent__connection-alert'))
    expect(notices).toHaveLength(1)
    expect(notices[0]?.parentElement?.classList.contains('inline-agent__body')).toBe(true)
    expect(notices[0]?.textContent).toContain('Connection required')
    expect(notices[0]?.textContent).toContain('Retry connection')
    const transcript = mounted.root.querySelector<HTMLElement>('.inline-agent__transcript')
    const order = Array.from(transcript?.children ?? []).map(child => child.className)
    expect(order[0]).toContain('inline-agent__welcome')
    expect(order.at(-1)).toContain('inline-agent__conversation-dock')
    const starters = Array.from(mounted.root.querySelectorAll<HTMLButtonElement>('.inline-agent__starter'))
    expect(starters).toHaveLength(3)
    expect(starters.every(starter => starter.getAttribute('aria-disabled') === 'true')).toBe(true)
    expect(mounted.root.querySelector('.inline-agent__starter-reason')?.textContent).toContain('Connection required')
    starters[0]?.click()
    await settle()
    expect(lockState.agentCalls.send).not.toHaveBeenCalled()
  })
})

describe('Inline Agent header actions', () => {
  it('opens Memory from its own toggle beside History', async () => {
    const lockState = loadGoalLockState(null)
    const mounted = mountInlineAgent(lockState, { viewportWidth: 1024 })
    const navigation = mounted.root.querySelector<HTMLElement>('.inline-agent__mobile-navigation')
    const memoryToggle = navigation?.querySelector<HTMLButtonElement>('.inline-agent__memory-toggle')
    expect(navigation?.querySelector('.inline-agent__history-toggle')).not.toBeNull()
    expect(memoryToggle?.getAttribute('aria-label')).toBe('Memory')
    expect(memoryToggle?.getAttribute('aria-expanded')).toBe('false')
    memoryToggle?.click()
    await settle()
    expect(mounted.memoryOpen.value).toBe(true)
    expect(memoryToggle?.getAttribute('aria-expanded')).toBe('true')
  })

  it('asks the host to return to page search from the search button', async () => {
    const lockState = loadGoalLockState(null)
    const mounted = mountInlineAgent(lockState)
    const search = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__search-action')
    expect(search?.getAttribute('aria-label')).toBe('Search the Wiki')
    search?.click()
    await settle()
    expect(lockState.emitted).toEqual([['return-search']])
  })

  it('keeps Close focusable while memory saves and closes only after it finishes', async () => {
    const lockState = loadGoalLockState(null)
    const mounted = mountInlineAgent(lockState)
    const close = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__close-action')
    expect(close?.getAttribute('aria-label')).toBe('Close Wiki Agent')
    ;(lockState.memoryMutationBusy as ValueRef<boolean>).value = true
    await settle()
    expect(close?.disabled).toBe(false)
    expect(close?.getAttribute('aria-disabled')).toBe('true')
    close?.click()
    await settle()
    expect(lockState.emitted).toEqual([])
    ;(lockState.memoryMutationBusy as ValueRef<boolean>).value = false
    await settle()
    close?.click()
    expect(lockState.emitted).toEqual([['close']])
  })

  it('shows one status alert at a time, highest priority first', async () => {
    const lockState = loadGoalLockState(null)
    const mounted = mountInlineAgent(lockState)
    const alerts = () => Array.from(mounted.root.querySelectorAll<HTMLElement>('.inline-agent__body > .inline-agent__alert'))
    ;(lockState.error as ValueRef<string>).value = 'The last request failed.'
    await settle()
    expect(alerts().map(alert => alert.textContent?.trim())).toEqual([expect.stringContaining('The last request failed.')])
    ;(lockState.initializationError as ValueRef<string>).value = 'The conversation could not be opened.'
    await settle()
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0]?.textContent).toContain('The conversation could not be opened.')
    expect(alerts()[0]?.textContent).toContain('Retry opening conversation')
  })

  it('keeps the composer readable while the reader scrolls back', () => {
    const lockState = loadGoalLockState(null)
    const mounted = mountInlineAgent(lockState, { followJumpVisible: true })
    const composer = mounted.root.querySelector<HTMLElement>('.inline-agent__composer')
    expect(Number(composer?.style.getPropertyValue('--agent-composer-opacity'))).toBeCloseTo(0.85, 5)
    const latest = mounted.root.querySelector<HTMLElement>('.inline-agent__follow-jump')
    expect(latest?.style.opacity ?? '').toBe('')
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

    if (!reason || !textarea) throw new Error('Locked composer description did not render')
    expect(reason.textContent?.trim()).toBe(expectedReason)
    expect(reason.getAttribute('role')).toBe('status')
    expect(textarea.disabled).toBe(true)
    expect(textarea.getAttribute('aria-label')).toBe('Follow up with Wiki Agent')
    expect(resolveDescribedBy(textarea)).toContain(reason)
  })

  it('keeps the same composer disabled with its mutation description until the lock clears', async () => {
    const state = loadGoalLockState(null, true)
    expect(state.canSubmit.value).toBe(false)
    expect(state.submitUnavailableReason.value).toBe('Wait for the current conversation update to finish')
    const mounted = mountInlineAgent(state)
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('textarea')
    if (!textarea) throw new Error('Composer textbox missing')
    expect(textarea.disabled).toBe(true)
    expect(mounted.root.querySelector('.inline-agent__composer-lock')).toBeNull()
    state.advanceTime(300)
    await settle()
    const reason = mounted.root.querySelector<HTMLElement>('.inline-agent__composer-lock')
    if (!reason) throw new Error('Mutation lock reason missing')
    expect(reason.textContent?.trim()).toBe('Wait for the current conversation update to finish')
    expect(resolveDescribedBy(textarea)).toContain(reason)
    state.sessionMutationBusy.value = false
    await settle()
    expect(state.canSubmit.value).toBe(true)
    expect(state.submitUnavailableReason.value).toBe('')
    expect(mounted.root.querySelector('textarea')).toBe(textarea)
    expect(textarea.disabled).toBe(false)
    expect(mounted.root.querySelector('.inline-agent__composer-lock')).toBeNull()
    expect(resolveDescribedBy(textarea)).not.toContain(reason)
  })

  it('delays the mutation lock message and cancels quick mutations before their deadline', async () => {
    const state = loadGoalLockState(null)
    const mounted = mountInlineAgent(state)
    expect(state.composerLockVisible.value).toBe(false)
    state.sessionMutationBusy.value = true
    await settle()
    state.advanceTime(100)
    expect(state.composerLockVisible.value).toBe(false)
    state.sessionMutationBusy.value = false
    await settle()
    state.advanceTime(201)
    await settle()
    expect(state.mutationLockMessageVisible.value).toBe(false)
    expect(mounted.root.querySelector('.inline-agent__composer-lock')).toBeNull()
    state.sessionMutationBusy.value = true
    await settle()
    state.advanceTime(299)
    await settle()
    expect(state.composerLockVisible.value).toBe(false)
    state.advanceTime(1)
    await settle()
    expect(state.composerLockVisible.value).toBe(true)
    expect(mounted.root.querySelector('.inline-agent__composer-lock')).not.toBeNull()
    state.sessionMutationBusy.value = false
    await settle()
    expect(state.composerLockVisible.value).toBe(false)
    expect(mounted.root.querySelector('.inline-agent__composer-lock')).toBeNull()
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
    expect(lockState.agentCalls.reloadSessions).not.toHaveBeenCalled()
    lockState.sessionMutationBusy.value = false
    lockState.thread.value = null
    lockState.openClearUnfiledHistory()
    await lockState.recoverClearUnfiledHistory()
    expect(lockState.agentCalls.reloadSessions).toHaveBeenCalledTimes(1)
    expect(lockState.clearUnfiledHistoryOpen.value).toBe(true)
    expect(lockState.clearUnfiledError.value).toContain('No replacement conversation is available yet. Retry.')
  })
})
