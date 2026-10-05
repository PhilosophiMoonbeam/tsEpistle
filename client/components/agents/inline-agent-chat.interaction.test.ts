import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { createPinia, type StoreGeneric, storeToRefs } from 'pinia'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { AgentThreadState } from '../../../shared/agents/contracts.ts'
import { AgentKnowledgeContextSchema } from '../../../shared/agents/knowledge-context.ts'
import { type AgentDraft, emptyAgentDraft } from '../../helpers/agent-draft.ts'
import { agentMediaContentUrl } from '../../helpers/agents-api.ts'
import { searchPages } from '../../helpers/pages-api.ts'
import { resolveUserPicture } from '../../helpers/user-picture.ts'
import { fetchWikiSource } from '../../helpers/wiki-source.ts'
import { fallbackLocalizationLabel } from '../../modules/localization.ts'
import { useAgentsStore } from '../../store/agents.ts'
import { createModalFocusScope } from '../common/modal-focus-scope.ts'
import { calculateComposerSizing, caretBoundsFromMirror, scrollTopForCaret } from './agent-composer-sizing.ts'
import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'
import { isAgentApprovalOutsideViewport, shouldFollowGoalExpansion } from './agent-thread-presentation.ts'

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

globalThis.useTranslate = () => translateEnglish

resetBody()

// Vuetify snapshots browser capabilities during module evaluation, so the DOM must exist before loading it here.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')

// Preserve real media and skill children. Static imports cannot work here:
// the test SFC loader must be registered before loading their .vue modules.
Bun.plugin({
  name: 'inline-agent-real-composer-children',
  setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const script = compileScript(parsed.descriptor, {
        id: `inline-agent-real-${path.basename(filename, '.vue')}`,
        genDefaultAs: '__component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${script.content}\nexport default __component;` }
    })
  }
})
const skillMenuComponent = (await import('./agent-composer-skill-menu.vue')).default
const mediaComposerComponent = (await import('./agent-composer-media.vue')).default
// The real transcript must load after the SFC plugin; a static import bypasses that boundary.
const threadComponent = (await import('./agent-thread.vue')).default
const testPwaState = Vue.reactive({ connectionState: 'online' as 'online' | 'offline' | 'server-unavailable' })

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
  '{ computed, mergeProps, nextTick, onBeforeUnmount, ref, useId, watch, defineProps, defineEmits, searchPages, fetchWikiSource, AgentKnowledgeContextSchema }',
  `${pickerScript}\nreturn { mergeProps, ${pickerBindings.join(', ')} }`
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
      mergeProps: Vue.mergeProps,
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
  handleComposerFocusIn: () => void
  handleComposerFocusOut: (event: FocusEvent) => void
  handleTranscriptEngagement: (event: FocusEvent | PointerEvent) => void
  transcript: ValueRef<HTMLElement | null>
  conversationDock: ValueRef<HTMLElement | null>
  handleTranscriptScroll: () => void
  scheduleTranscriptReconcile: () => void
  jumpToApproval: () => Promise<void>
  approvalJumpVisible: ValueRef<boolean>
  transcriptFollowing: ValueRef<boolean>
  transcriptBottomDistance: ValueRef<number>
  reconcileTranscriptGrowth: (shouldFollow: boolean) => Promise<void>
  openGoal: ValueRef<{ status: string } | null>
  goalSubmitUnavailableReason: ValueRef<string>
  submitUnavailableReason: ValueRef<string>
  sessionMutationBusy: ValueRef<boolean>
  discardDraftOpen: ValueRef<boolean>
  offlineComposerDraft: ValueRef<string>
  resolveDraftDiscard: (discard: boolean) => void
  agentCalls: {
    drafts: Record<string, AgentDraft>
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
  retryInitialization: () => Promise<void>
  connectionProbe: () => Promise<boolean>
  clearUnfiledHistoryOpen: ValueRef<boolean>
  newSession: () => Promise<void>
  newTemporarySession: () => Promise<void>
  openClearUnfiledHistory: () => void
  historyOpen: ValueRef<boolean>
  memoryOpen: ValueRef<boolean>
  panelMenuOpen: ValueRef<boolean>
  toggleHistory: () => void
  toggleMemory: () => void
  closeHistory: () => void
  closeMemory: () => void
  triggerForPanel: (kind: 'history' | 'memory') => HTMLElement | null
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
  componentProps: { ownerId: number; pageId: number; pageLocale: string; pagePath: string; pageUpdatedAt: string; resumeSessionId?: string }
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
      folderId: null,
      mediaCapabilities: null
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
    initializationAdmissionFailure: ref<'access' | 'authentication' | null>(null),
    loading: ref(false),
    pinnedSessionId: ref<string | null>(null),
    pinStorageAvailable: ref(true),
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
    drafts: Vue.reactive<Record<string, AgentDraft>>({}),
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
  const connectionProbe = vi.fn(async () => true)
  const bindingNames = Array.from(setupScript.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm), match => match[1])
  const emitted: unknown[][] = []
  const pendingStartersFrames: Array<{ callback: (now: number) => void }> = []
  const clearedStartersFrameIds: number[] = []
  const evaluate = new Function(
    '{ computed, nextTick, onBeforeUnmount, onMounted, ref, setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame, useTemplateRef, useId, watch, storeToRefs, defineProps, defineEmits, useAgentsStore, activeOwnedOverlayRoots, createModalFocusScope, isAgentApprovalOutsideViewport, shouldFollowGoalExpansion, pwaState, retryServerConnection, wikiStore, resolveUserPicture, emptyAgentDraft }',
    `${executableScript}\nreturn { ...storeToRefs(agents), ${bindingNames.join(', ')} }`
  ) as (dependencies: Record<string, unknown>) => LockState

  const state = scope.run(() =>
    evaluate({
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
      defineEmits:
        () =>
        (...event: unknown[]) => {
          emitted.push(event)
        },
      defineProps: () => props,
      useAgentsStore: () => realStore ?? agentCalls,
      activeOwnedOverlayRoots: () => [],
      createModalFocusScope: (options: Parameters<typeof createModalFocusScope>[0]) =>
        options.root.closest('.v-dialog') ? createModalFocusScope(options) : { deactivate: () => undefined },
      isAgentApprovalOutsideViewport,
      shouldFollowGoalExpansion,
      pwaState: testPwaState,
      retryServerConnection: connectionProbe,
      wikiStore: { user: { id: 2, name: 'Test User', pictureUrl: '' } },
      resolveUserPicture,
      emptyAgentDraft
    })
  ) as LockState
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
    agentCalls: realStore ? (realStore as unknown as LockState['agentCalls']) : agentCalls,
    componentProps: props,
    connectionProbe,
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
      ? constraints.every(([, boundary, pixels]) => (boundary === 'min' ? width >= Number(pixels) : width <= Number(pixels)))
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
    media.addListener = listener => {
      if (listener) media.addEventListener('change', listener as EventListener)
    }
    media.removeListener = listener => {
      if (listener) media.removeEventListener('change', listener as EventListener)
    }
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

const controlTranscriptFrames = () => {
  let frameId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  vi.spyOn(browserWindow, 'requestAnimationFrame').mockImplementation(callback => {
    const id = ++frameId
    callbacks.set(id, callback)
    return id
  })
  vi.spyOn(browserWindow, 'cancelAnimationFrame').mockImplementation(id => {
    cancelled.push(id)
    callbacks.delete(id)
  })
  return {
    callbacks,
    cancelled,
    flush: async () => {
      await settle()
      const frame = [...callbacks.values()]
      callbacks.clear()
      for (const callback of frame) callback(0)
      await settle()
    }
  }
}

const sessionId = '00000000-0000-4000-8000-000000000001'
const timestamp = '2026-09-15T10:00:00.000Z'
// Fixture-only signing material; this harness exercises client continuity, not server authorization.
const profileResolutionToken = (id: string, version: number): string => {
  const kid = 'inline-agent-interaction'
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      kid,
      ownerId: 2,
      sessionId: id,
      sessionVersion: version,
      profileId: '00000000-0000-4000-8000-000000000010',
      profileVersionId: '00000000-0000-4000-8000-000000000011',
      profileVersion: 1,
      profilePolicyVersion: 1,
      defaultGeneration: 1,
      executionMode: 'agent',
      exp: 4_000_000_000
    })
  ).toString('base64url')
  return `${kid}.${payload}.${createHmac('sha256', 'inline-agent-interaction-fixture-key').update(payload).digest('base64url')}`
}
const threadFixture = (id = sessionId, retention: 'saved' | 'temporary' = 'saved'): AgentThreadState => ({
  session: {
    id,
    title: 'Release planning',
    retention,
    folderId: null,
    status: 'active',
    executionMode: 'agent',
    version: 1,
    providerProfileId: null,
    profileResolutionToken: profileResolutionToken(id, 1),
    mediaCapabilities: null,
    skills: [],
    currentRun: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    expiresAt: retention === 'temporary' ? '2026-09-16T10:00:00.000Z' : null
  },
  messages: [],
  tools: [],
  tasks: [],
  artifacts: [],
  routingDecisions: [],
  specialistInvocations: [],
  proposals: [],
  goal: null,
  suggestions: [],
  historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false }
})
const realWorkspace = (retention: 'saved' | 'temporary' = 'saved', page: TestPageHint | null = null, initialThread?: AgentThreadState) => {
  const store = useAgentsStore(createPinia())
  let serverThread = initialThread ?? threadFixture(sessionId, retention)
  const creations: Array<{ retention: 'saved' | 'temporary'; thread: AgentThreadState }> = []
  const authorization = { pending: null as Promise<Response> | null }
  const mediaUpload = { pending: null as Promise<Response> | null }
  const sendResponse = { pending: null as Promise<Response> | null }
  const requests: Array<{ method: string; path: string }> = []
  const summary = () => {
    const { session } = serverThread
    return { ...session, deletedAt: null }
  }
  vi.spyOn(browserWindow, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), browserWindow.location.href)
    const path = url.pathname
    const method = init?.method ?? 'GET'
    requests.push({ method, path })
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    if (path === '/_api/agents/skills') return Response.json({ skills: [] })
    if (path === '/_api/agents/conversation-folders') return Response.json({ folders: [] })
    if (path === '/_api/agents/sessions' && method === 'GET') return authorization.pending ?? Response.json({ sessions: [summary()], nextCursor: null })
    if (path === '/_api/agents/sessions' && method === 'POST') {
      const next = creations.shift()
      if (!next || body.retention !== next.retention || Object.keys(body).some(key => key !== 'retention'))
        throw new Error('Unexpected session creation payload')
      serverThread = next.thread
      return Response.json({ ...serverThread, launchPage: null })
    }
    if (path === `/_api/agents/sessions/${serverThread.session.id}/media` && method === 'POST') {
      const uploadBody = init?.body
      if (!(uploadBody instanceof FormData)) throw new Error('Media upload did not provide FormData')
      const file = uploadBody.get('file')
      if (!(file instanceof File)) throw new Error('Media upload did not provide a File')
      return (
        mediaUpload.pending ??
        Response.json({
          media: {
            id: '00000000-0000-4000-8000-000000000050',
            kind: 'attachment',
            filename: file.name,
            mimeType: file.type,
            byteLength: file.size,
            available: true,
            detached: false
          }
        })
      )
    }
    if (path === `/_api/agents/sessions/${serverThread.session.id}` && method === 'PATCH') {
      if (body.retention !== 'saved' || body.expectedSessionVersion !== serverThread.session.version) throw new Error('Unexpected retention mutation')
      const version = serverThread.session.version + 1
      serverThread = {
        ...serverThread,
        session: {
          ...serverThread.session,
          retention: 'saved',
          version,
          profileResolutionToken: profileResolutionToken(serverThread.session.id, version),
          expiresAt: null
        }
      }
      return Response.json(serverThread)
    }
    if (path === `/_api/agents/sessions/${serverThread.session.id}` && method === 'GET') return Response.json(serverThread)
    if (path === `/_api/agents/sessions/${serverThread.session.id}/messages` && method === 'POST') {
      if (sendResponse.pending) return sendResponse.pending
      const run: NonNullable<AgentThreadState['session']['currentRun']> = {
        id: '00000000-0000-4000-8000-000000000020',
        sessionId: serverThread.session.id,
        status: 'succeeded',
        attempt: 1,
        eventSequence: 1,
        canCancel: false,
        createdAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        errorCode: null,
        errorMessage: null
      }
      serverThread = { ...serverThread, session: { ...serverThread.session, currentRun: run } }
      return Response.json({ run, replayed: false })
    }
    if (method === 'DELETE' && /^\/_api\/agents\/sessions\/[a-f0-9-]+$/.test(path)) return new Response(null, { status: 204 })
    if (method === 'DELETE' && /^\/_api\/agents\/media\/[a-f0-9-]+$/.test(path)) return new Response(null, { status: 204 })
    throw new Error(`Unexpected Agent request: ${method} ${path}`)
  })
  store.$patch({
    csrfToken: 'csrf',
    pinOwnerId: 2,
    routeSync: false,
    connection: 'connected',
    initializedWorkspaceVersion: store.workspaceVersion,
    thread: serverThread,
    contextPage: page,
    continuitySessionId: serverThread.session.id,
    conversationPage: page ? { id: page.id, locale: page.locale } : null
  })
  const state = () => loadGoalLockState(null, false, null, true, false, page, store)
  stateCleanups.push(() => {
    store.closeWorkspace()
    store.$dispose()
  })
  return { store, state, creations, authorization, mediaUpload, sendResponse, requests }
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
    readonly realThread?: boolean
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
    emits: ['send', 'stop', 'manageSkills', 'retrySkills', 'updateSkillPreferences', 'draftChange', 'compositionChange', 'mediaSettled'],
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
  for (const name of [
    'AgentGoalStatus',
    'AgentMcpApproval',
    'AgentMemoryManager',
    'AgentPersonalSkills',
    'AgentPersonalMcp',
    'AgentThread',
    'WikiSourcePreview'
  ])
    app.component(name, componentStub)
  if (options.realThread) app.component('AgentThread', threadComponent)
  app.component(
    'AgentHistoryPanel',
    Vue.defineComponent({
      props: { headingId: String, descriptionId: String },
      setup(props) {
        return () => Vue.h('div', [Vue.h('h2', { id: props.headingId }, 'Conversations'), Vue.h('p', { id: props.descriptionId }, 'Conversation history')])
      }
    })
  )
  app.component('AgentContextPicker', contextPickerComponent)
  app.component('AgentComposer', composerComponent)
  app.component('AgentComposerSkillMenu', skillMenuComponent)
  app.component('AgentComposerMedia', mediaComposerComponent)
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
  testPwaState.connectionState = 'online'
  vi.useRealTimers()
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

  it('restores each modal panel to its own visible trigger at phone and desktop widths', async () => {
    const state = loadGoalLockState(null)
    const mounted = mountInlineAgent(state, { viewportWidth: 320 })
    const history = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__history-toggle')
    const more = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__more-menu')
    const memory = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__memory-toggle')
    if (!history || !more || !memory) throw new Error('Panel triggers did not render')
    // The test DOM has no layout; give visible buttons a client rect like Chromium does.
    for (const button of [history, more, memory]) {
      vi.spyOn(button, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList)
    }
    state.toggleHistory()
    await settle()
    state.closeHistory()
    await settle()
    expect(document.activeElement).toBe(history)
    expect(state.triggerForPanel('history')).toBe(history)
    expect(state.triggerForPanel('memory')).toBe(more)

    resizeViewport?.(640)
    await settle()
    state.toggleMemory()
    await settle()
    state.closeMemory()
    await settle()
    expect(document.activeElement).toBe(memory)
    expect(state.triggerForPanel('memory')).toBe(memory)
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

  for (const retention of ['saved', 'temporary'] as const) {
    it(`retains the full draft when ${retention} chat is cancelled, then starts clean only after confirmation`, async () => {
      vi.useFakeTimers()
      const workspace = realWorkspace()
      const draft: AgentDraft = {
        text: 'Prepare a release checklist',
        mode: 'goal',
        skillVersionIds: ['00000000-0000-4000-8000-000000000030'],
        sources: [
          {
            id: 41,
            locale: 'en',
            path: 'handbook/release',
            title: 'Release handbook',
            description: '',
            visibility: 'public',
            updatedAt: timestamp,
            sourceRevision: '1',
            excerpt: '',
            excerptTruncated: false
          }
        ],
        scope: { kind: 'selected' },
        includeCurrentPage: false
      }
      const expectedDraft = structuredClone(draft)
      workspace.store.drafts[sessionId] = draft
      const state = workspace.state()
      const mounted = mountInlineAgent(state)
      await settle()
      const startChat = async (): Promise<void> => {
        if (retention === 'temporary') {
          // Vuetify fences menu activator clicks for 50ms after a close.
          await vi.advanceTimersByTimeAsync(50)
          menuAction(await openPanelMenu(mounted), 'Temporary chat').click()
        } else {
          const action = mounted.root.querySelector<HTMLButtonElement>('[aria-label="New chat"]')
          if (!action) throw new Error('New chat action missing')
          action.click()
          action.click()
        }
        await settle()
      }
      const dialogAction = (key: string): HTMLButtonElement => {
        const title = document.getElementById(state.discardDraftTitleId as string)
        const dialog = title?.closest<HTMLElement>('.v-card')
        const action = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
          button => button.textContent?.trim() === translateEnglish(key)
        )
        if (!action) throw new Error('Draft discard dialog action missing')
        return action
      }
      const requestsBefore = [...workspace.requests]
      await startChat()
      expect(state.discardDraftOpen.value).toBe(true)
      expect(workspace.requests).toEqual(requestsBefore)
      dialogAction('common:actions.cancel').click()
      await settle()
      expect(state.discardDraftOpen.value).toBe(false)
      expect(workspace.requests).toEqual(requestsBefore)
      expect(workspace.store.thread?.session.id).toBe(sessionId)
      expect(workspace.store.drafts[sessionId]).toEqual(expectedDraft)
      expect(mounted.root.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(expectedDraft.text)
      expect(mounted.root.querySelector('.agent-composer__goal-chip')).not.toBeNull()
      expect(mounted.root.querySelector('.agent-context__sources')?.textContent).toContain('Release handbook')
      const textarea = mounted.root.querySelector<HTMLTextAreaElement>('textarea')
      expect(document.activeElement).toBe(textarea)
      expect(mounted.root.getAttribute('aria-busy')).toBe('false')

      await startChat()
      const scrim = document
        .getElementById(state.discardDraftTitleId as string)
        ?.closest('.v-overlay')
        ?.querySelector<HTMLElement>(':scope > .v-overlay__scrim')
      if (!scrim) throw new Error('Draft discard dialog scrim missing')
      expect(scrim.inert).not.toBe(true)
      expect(scrim.closest('[inert], [aria-hidden="true"]')).toBeNull()
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      scrim.click()
      await vi.advanceTimersByTimeAsync(0)
      await settle()
      expect(state.discardDraftOpen.value).toBe(false)
      expect(workspace.requests).toEqual(requestsBefore)
      expect(workspace.store.thread?.session.id).toBe(sessionId)
      expect(workspace.store.drafts[sessionId]).toEqual(expectedDraft)
      expect(textarea?.value).toBe(expectedDraft.text)
      expect(document.activeElement).toBe(textarea)
      expect(mounted.root.getAttribute('aria-busy')).toBe('false')

      await startChat()
      const cancel = dialogAction('common:actions.cancel')
      cancel.focus()
      cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await settle()
      expect(state.discardDraftOpen.value).toBe(false)
      expect(workspace.requests).toEqual(requestsBefore)
      expect(workspace.store.drafts[sessionId]).toEqual(expectedDraft)
      expect(document.activeElement).toBe(textarea)

      const next = threadFixture('00000000-0000-4000-8000-000000000004', retention)
      workspace.creations.push({ retention, thread: next })
      await startChat()
      const confirm = dialogAction('common:agentWorkspace.discardDraftConfirm')
      confirm.click()
      confirm.click()
      await settle()
      expect(workspace.store.thread?.session).toMatchObject({ id: next.session.id, retention })
      expect(workspace.requests.filter(request => request.path === '/_api/agents/sessions' && request.method === 'POST')).toHaveLength(1)
      expect(workspace.requests.filter(request => request.method === 'DELETE')).toEqual([{ method: 'DELETE', path: `/_api/agents/sessions/${sessionId}` }])
      expect(workspace.requests.some(request => request.path.endsWith('/messages'))).toBe(false)
      expect(workspace.store.drafts[sessionId]).toBeUndefined()
      expect(workspace.store.drafts[next.session.id] ?? emptyAgentDraft()).toMatchObject({
        text: '',
        mode: 'message',
        skillVersionIds: [],
        sources: [],
        scope: { kind: 'all' },
        includeCurrentPage: true
      })
      expect(mounted.root.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('')
      expect(mounted.root.querySelector('.agent-composer__goal-chip')).toBeNull()
      expect(mounted.root.querySelector('.agent-context__sources')).toBeNull()
    })

    it(`protects a pending attachment-only draft when starting ${retention} chat and blocks replacement until upload settles`, async () => {
      vi.useFakeTimers()
      const workspace = realWorkspace()
      const initial = workspace.store.thread!
      workspace.store.thread = {
        ...initial,
        session: {
          ...initial.session,
          mediaCapabilities: { attachments: true, imageGeneration: true, videoGeneration: false, musicGeneration: false, transcription: false }
        }
      }
      let completeUpload: (response: Response) => void = () => {
        throw new Error('Upload response was not initialized')
      }
      workspace.mediaUpload.pending = new Promise<Response>(resolve => {
        completeUpload = resolve
      })
      const state = workspace.state()
      const mounted = mountInlineAgent(state)
      await settle()
      const startChat = async (): Promise<void> => {
        if (retention === 'temporary') {
          await vi.advanceTimersByTimeAsync(50)
          menuAction(await openPanelMenu(mounted), 'Temporary chat').click()
        } else {
          const action = mounted.root.querySelector<HTMLButtonElement>('[aria-label="New chat"]')
          if (!action) throw new Error('New chat action missing')
          action.click()
        }
        await settle()
      }
      const dialogAction = (key: string): HTMLButtonElement => {
        const dialog = document.getElementById(state.discardDraftTitleId as string)?.closest<HTMLElement>('.v-card')
        const action = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
          button => button.textContent?.trim() === translateEnglish(key)
        )
        if (!action) throw new Error('Draft discard dialog action missing')
        return action
      }
      const input = mounted.root.querySelector<HTMLInputElement>('input[type="file"]')
      if (!input) throw new Error('Real media upload input missing')
      const file = new File(['%PDF-1.4\npending report\n%%EOF\n'], 'pending-report.pdf', { type: 'application/pdf' })
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })
      input.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
      await settle()
      const uploadRequests = [...workspace.requests]
      expect(uploadRequests).toContainEqual({ method: 'POST', path: `/_api/agents/sessions/${sessionId}/media` })
      await startChat()
      expect(state.discardDraftOpen.value).toBe(false)
      expect(workspace.requests).toEqual(uploadRequests)
      expect(workspace.store.thread?.session.id).toBe(sessionId)
      expect(mounted.root.querySelector('[role="status"].inline-agent__session-notice')?.textContent).toContain(
        'wait for transcription and file uploads to finish'
      )
      completeUpload(
        Response.json({
          media: {
            id: '00000000-0000-4000-8000-000000000050',
            kind: 'attachment',
            filename: file.name,
            mimeType: file.type,
            byteLength: file.size,
            available: true,
            detached: false
          }
        })
      )
      await settle()
      expect(mounted.root.querySelector('.agent-composer__media-attachments')?.textContent).toContain(file.name)
      expect(mounted.root.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('')
      expect(workspace.store.drafts[sessionId] ?? emptyAgentDraft()).toEqual(emptyAgentDraft())

      await startChat()
      expect(state.discardDraftOpen.value).toBe(true)
      expect(workspace.requests).toEqual(uploadRequests)
      dialogAction('common:actions.cancel').click()
      await settle()
      expect(workspace.store.thread?.session.id).toBe(sessionId)
      expect(mounted.root.querySelector('.agent-composer__media-attachments')?.textContent).toContain(file.name)
      expect(workspace.requests).toEqual(uploadRequests)

      const next = threadFixture('00000000-0000-4000-8000-000000000004', retention)
      workspace.creations.push({ retention, thread: next })
      await startChat()
      expect(state.discardDraftOpen.value).toBe(true)
      const confirm = dialogAction('common:agentWorkspace.discardDraftConfirm')
      confirm.click()
      confirm.click()
      await settle()
      expect(workspace.store.thread?.session).toMatchObject({ id: next.session.id, retention })
      expect(mounted.root.querySelector('.agent-composer__media-attachments')).toBeNull()
      expect(workspace.requests.filter(request => request.path === '/_api/agents/sessions' && request.method === 'POST')).toHaveLength(1)
      expect(
        workspace.requests
          .filter(request => request.method === 'DELETE')
          .map(request => request.path)
          .sort()
      ).toEqual(['/_api/agents/media/00000000-0000-4000-8000-000000000050', `/_api/agents/sessions/${sessionId}`])
      expect(workspace.requests.some(request => request.path.endsWith('/messages'))).toBe(false)
    })
  }

  it('starts a pristine chat without prompting when generation capabilities are available', async () => {
    const workspace = realWorkspace()
    const initial = workspace.store.thread!
    workspace.store.thread = {
      ...initial,
      session: {
        ...initial.session,
        mediaCapabilities: { attachments: true, imageGeneration: true, videoGeneration: true, musicGeneration: true, transcription: false }
      }
    }
    const state = workspace.state()
    const mounted = mountInlineAgent(state)
    await settle()
    const next = threadFixture('00000000-0000-4000-8000-000000000004')
    workspace.creations.push({ retention: 'saved', thread: next })
    mounted.root.querySelector<HTMLButtonElement>('[aria-label="New chat"]')?.click()
    await settle()
    expect(state.discardDraftOpen.value).toBe(false)
    expect(workspace.store.thread?.session.id).toBe(next.session.id)
    expect(workspace.requests.filter(request => request.path === '/_api/agents/sessions' && request.method === 'POST')).toHaveLength(1)
    expect(workspace.requests.some(request => request.path.endsWith('/messages'))).toBe(false)
  })

  it('protects selection-only drafts before replacing a disposable empty chat', async () => {
    const selections: Partial<AgentDraft>[] = [
      { mode: 'goal' },
      { skillVersionIds: ['skill-version-1'] },
      {
        sources: [
          {
            id: 41,
            locale: 'en',
            path: 'handbook/release',
            title: 'Release handbook',
            description: '',
            visibility: 'public',
            updatedAt: timestamp,
            sourceRevision: '1',
            excerpt: '',
            excerptTruncated: false
          }
        ]
      },
      { scope: { kind: 'selected' } },
      { includeCurrentPage: false }
    ]
    for (const selection of selections) {
      const state = loadGoalLockState(null)
      const draft = { ...emptyAgentDraft(), ...selection }
      const expectedDraft = structuredClone(draft)
      state.agentCalls.drafts['session-1'] = draft
      const pending = state.newSession()
      await settle()
      expect(state.discardDraftOpen.value).toBe(true)
      expect(state.agentCalls.newSession).not.toHaveBeenCalled()
      state.resolveDraftDiscard(false)
      await pending
      expect(state.agentCalls.drafts['session-1']).toEqual(expectedDraft)
      expect(state.agentCalls.newSession).not.toHaveBeenCalled()
      state.dispose()
    }
  })

  it('never creates a conversation when its draft confirmation belongs to a stale owner or session, or a new mutation owns the lease', async () => {
    for (const invalidation of ['owner', 'session', 'lease'] as const) {
      const state = loadGoalLockState(null)
      state.agentCalls.drafts['session-1'] = { ...emptyAgentDraft(), text: 'Keep this draft' }
      const pending = state.newSession()
      await settle()
      expect(state.discardDraftOpen.value).toBe(true)
      state.resolveDraftDiscard(true)
      if (invalidation === 'owner') state.componentProps.ownerId = 3
      if (invalidation === 'session') state.thread.value = threadFixture('00000000-0000-4000-8000-000000000004') as unknown as Record<string, unknown>
      if (invalidation === 'lease') state.sessionMutationBusy.value = true
      await pending
      await settle()
      expect(state.agentCalls.newSession).not.toHaveBeenCalled()
      expect(state.agentCalls.drafts['session-1']?.text).toBe('Keep this draft')
      state.dispose()
    }
  })

  it('retains an offline draft across same-owner Wiki navigation and clears it when the owner changes', async () => {
    testPwaState.connectionState = 'offline'
    const state = loadGoalLockState(null)
    state.thread.value = null
    const mounted = mountInlineAgent(state)
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('textarea')
    if (!textarea) throw new Error('Offline draft textbox missing')
    textarea.value = 'A question for when the connection returns'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(state.offlineComposerDraft.value).toBe(textarea.value)
    state.componentProps.pageId = 42
    state.componentProps.pageLocale = 'en'
    state.componentProps.pagePath = 'handbook/second'
    state.componentProps.pageUpdatedAt = timestamp
    await settle()
    expect(mounted.root.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('A question for when the connection returns')
    expect(state.offlineComposerDraft.value).toBe('A question for when the connection returns')
    expect(state.agentCalls.initialize).not.toHaveBeenCalled()
    state.componentProps.ownerId = 3
    await settle()
    expect(state.offlineComposerDraft.value).toBe('')
    expect(mounted.root.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('')
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
    expect(workspace.requests.some(request => /\/profiles(?:\/|$)|\/profile$/.test(request.path))).toBe(false)
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
    const pending = new Promise<boolean>(resolve => {
      complete = resolve
    })
    lockState.agentCalls.send = vi.fn(() => pending)
    const mounted = mountInlineAgent(lockState)
    const starter = mounted.root.querySelector<HTMLButtonElement>('.inline-agent__starter')
    if (!starter) throw new Error('Conversation starter did not render')

    starter.click()
    starter.click()
    await settle()

    expect(lockState.agentCalls.send).toHaveBeenCalledTimes(1)
    const group = mounted.root.querySelector<HTMLElement>('.inline-agent__starters')
    const reasonId = group?.getAttribute('aria-describedby')
    const reason = reasonId ? mounted.root.querySelector<HTMLElement>(`[id="${reasonId}"]`) : null
    expect(group?.getAttribute('aria-busy')).toBe('true')
    expect(reason?.textContent?.trim()).toBe(translateEnglish('common:inlineAgentChat.sendingMessage'))
    expect(reason?.getAttribute('role')).toBe('status')
    const secondStarter = mounted.root.querySelectorAll<HTMLButtonElement>('.inline-agent__starter')[1]
    secondStarter?.click()
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
    expect(group?.getAttribute('aria-busy')).toBe('false')
    expect(group?.hasAttribute('aria-describedby')).toBe(false)
    starter.click()
    await settle()
    expect(lockState.agentCalls.send).toHaveBeenCalledTimes(2)
  })

  for (const viewportWidth of [1440, 390]) {
    it(`keeps a historical pinned conversation model-free at ${viewportWidth}px`, async () => {
      const historical = threadFixture()
      const historicalProfile = '00000000-0000-4000-8000-000000000099'
      const workspace = realWorkspace('saved', null, {
        ...historical,
        session: { ...historical.session, providerProfileId: historicalProfile }
      })
      workspace.store.pinnedSessionId = sessionId
      workspace.store.initializedWorkspaceVersion = null
      const state = workspace.state()
      state.componentProps.resumeSessionId = sessionId
      const mounted = mountInlineAgent(state, { viewportWidth })
      await settle()
      expect(workspace.store.isWorkspaceReady()).toBe(true)
      expect(mounted.root.querySelector('.inline-agent__session-title')?.textContent).toContain('Release planning')
      expect(mounted.root.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false)
      expect(mounted.root.querySelector('[role="radiogroup"]')).toBeNull()
      expect(
        Array.from(mounted.root.querySelectorAll('button, [role="menuitem"], [role="radio"]')).some(control =>
          /model|provider/i.test(`${control.textContent} ${control.getAttribute('aria-label') ?? ''}`)
        )
      ).toBe(false)
      expect(mounted.root.textContent).not.toContain(historicalProfile)
      expect(workspace.store.thread?.session.providerProfileId).toBe(historicalProfile)
      expect(workspace.requests.some(request => /\/profiles(?:\/|$)|\/profile$/.test(request.path))).toBe(false)
    })
  }

  it('retains the complete draft after send admission fails without requesting model inventory or selection', async () => {
    const workspace = realWorkspace()
    const draft: AgentDraft = {
      ...emptyAgentDraft(),
      text: 'Keep this research draft',
      scope: { kind: 'selected' },
      includeCurrentPage: false,
      sources: [
        {
          id: 41,
          locale: 'en',
          path: 'handbook/release',
          title: 'Release handbook',
          description: '',
          visibility: 'public',
          updatedAt: timestamp,
          sourceRevision: '1',
          excerpt: '',
          excerptTruncated: false
        }
      ]
    }
    workspace.store.drafts[sessionId] = structuredClone(draft)
    let completeSend!: (response: Response) => void
    workspace.sendResponse.pending = new Promise<Response>(resolve => {
      completeSend = resolve
    })
    const mounted = mountInlineAgent(workspace.state())
    await settle()
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('textarea')
    const send = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__submit')
    if (!textarea || !send) throw new Error('Composer send controls missing')
    expect(textarea.value).toBe(draft.text)
    send.click()
    await settle()
    expect(workspace.requests.filter(request => request.path.endsWith('/messages') && request.method === 'POST')).toHaveLength(1)
    expect(textarea.value).toBe(draft.text)
    expect(workspace.store.drafts[sessionId]).toEqual(draft)
    completeSend(Response.json({ error: 'The Agent cannot start this request right now.' }, { status: 409 }))
    await settle()
    expect(textarea.value).toBe(draft.text)
    expect(workspace.store.drafts[sessionId]).toEqual(draft)
    expect(workspace.store.sending).toBe(false)
    expect(workspace.requests.some(request => /\/profiles(?:\/|$)|\/profile$/.test(request.path))).toBe(false)
  })

  it('updates attachment and image-edit controls from the current conversation capabilities', async () => {
    const initial = threadFixture()
    const workspace = realWorkspace('saved', null, {
      ...initial,
      messages: [
        {
          id: 'image-answer',
          runId: 'image-run',
          ordinal: 1,
          role: 'assistant',
          status: 'complete',
          content: '',
          citations: [],
          createdAt: timestamp,
          updatedAt: timestamp,
          media: [
            {
              id: '00000000-0000-4000-8000-000000000051',
              kind: 'generated-image',
              filename: 'release.png',
              mimeType: 'image/png',
              byteLength: 42,
              available: true,
              detached: false
            }
          ]
        }
      ]
    })
    const mounted = mountInlineAgent(workspace.state(), { realThread: true })
    await settle()
    const attach = () => mounted.root.querySelector<HTMLButtonElement>('[aria-label="Attach files"]')
    const edit = () =>
      Array.from(mounted.root.querySelectorAll<HTMLButtonElement>('.agent-message__media button')).find(
        button => button.textContent?.trim() === translateEnglish('common:agentThread.editImage')
      )
    const setCapabilities = async (capabilities: AgentThreadState['session']['mediaCapabilities']): Promise<void> => {
      const thread = workspace.store.thread!
      workspace.store.thread = { ...thread, session: { ...thread.session, mediaCapabilities: capabilities } }
      await settle()
    }
    expect(attach()).toBeNull()
    expect(edit()).toBeUndefined()
    await setCapabilities({ attachments: true, imageGeneration: false, videoGeneration: false, musicGeneration: false, transcription: false })
    expect(attach()?.disabled).toBe(false)
    expect(edit()).toBeUndefined()
    await setCapabilities({ attachments: true, imageGeneration: true, videoGeneration: false, musicGeneration: false, transcription: false })
    expect(attach()?.disabled).toBe(false)
    expect(edit()?.disabled).toBe(false)
    const input = mounted.root.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error('Real media upload input missing')
    const file = new File(['%PDF-1.4\nreport\n%%EOF\n'], 'draft-report.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
    await settle()
    expect(mounted.root.querySelector('.agent-composer__media-attachments')?.textContent).toContain(file.name)
    const remove = mounted.root.querySelector<HTMLButtonElement>('.agent-composer__media-attachments button')
    if (!remove) throw new Error('Attachment removal control missing')
    remove.click()
    await settle()
    expect(mounted.root.querySelector('.agent-composer__media-attachments')).toBeNull()
    expect(workspace.requests).toContainEqual({ method: 'DELETE', path: '/_api/agents/media/00000000-0000-4000-8000-000000000050' })
    await setCapabilities({ attachments: false, imageGeneration: true, videoGeneration: false, musicGeneration: false, transcription: false })
    expect(attach()).toBeNull()
    expect(edit()).toBeUndefined()
    await setCapabilities(null)
    expect(attach()).toBeNull()
    expect(edit()).toBeUndefined()
    expect(workspace.requests.some(request => /\/profiles(?:\/|$)|\/profile$/.test(request.path))).toBe(false)
  })

  it('coalesces scroll measurements while preserving manual reading, follow and approval navigation', async () => {
    installBrowserSurface()
    const frames = controlTranscriptFrames()
    const state = loadGoalLockState(null)
    const thread = state.thread.value
    if (!thread) throw new Error('Conversation missing')
    state.thread.value = {
      ...thread,
      messages: [{ id: 'message-1', role: 'user', content: 'A question' }],
      proposals: [{ id: 'proposal-1', status: 'pending', approval: { status: 'pending' } }]
    }
    const mounted = mountInlineAgent(state)
    const container = mounted.root.querySelector<HTMLElement>('.inline-agent__transcript')
    const dock = mounted.root.querySelector<HTMLElement>('.inline-agent__conversation-dock')
    if (!container || !dock) throw new Error('Conversation dock missing')
    state.transcript.value = container
    state.conversationDock.value = dock
    const approval = document.createElement('div')
    approval.id = 'agent-approval-proposal-1'
    approval.tabIndex = -1
    container.insertBefore(approval, dock)
    let height = 2000
    const heightRead = vi.fn(() => height)
    const viewportRead = vi.fn(() => ({ top: 0, bottom: 600, height: 600 }) as DOMRect)
    const dockRead = vi.fn(() => ({ top: 400, bottom: 600, height: 200 }) as DOMRect)
    let approvalTop = 700
    const approvalRead = vi.fn(() => ({ top: approvalTop, bottom: approvalTop + 100, height: 100 }) as DOMRect)
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, get: heightRead },
      clientHeight: { configurable: true, value: 600 }
    })
    container.getBoundingClientRect = viewportRead
    dock.getBoundingClientRect = dockRead
    approval.getBoundingClientRect = approvalRead
    await frames.flush()
    expect(container.scrollTop).toBe(1400)
    heightRead.mockClear()
    viewportRead.mockClear()
    dockRead.mockClear()
    approvalRead.mockClear()

    container.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    for (const top of [1000, 900, 800]) {
      container.scrollTop = top
      container.dispatchEvent(new browserWindow.Event('scroll'))
    }
    expect(heightRead).not.toHaveBeenCalled()
    expect(viewportRead).not.toHaveBeenCalled()
    await frames.flush()
    expect(heightRead).toHaveBeenCalledTimes(1)
    expect(viewportRead).toHaveBeenCalledTimes(1)
    expect(dockRead).toHaveBeenCalledTimes(1)
    expect(approvalRead).toHaveBeenCalledTimes(1)
    expect(state.transcriptFollowing.value).toBe(false)
    expect(state.transcriptBottomDistance.value).toBe(600)
    expect(state.approvalJumpVisible.value).toBe(true)

    height = 2400
    state.scheduleTranscriptReconcile()
    await frames.flush()
    expect(container.scrollTop).toBe(800)
    expect(state.transcriptFollowing.value).toBe(false)
    approvalTop = 200
    state.handleTranscriptScroll()
    await frames.flush()
    expect(state.approvalJumpVisible.value).toBe(false)

    container.scrollTop = 1800
    container.dispatchEvent(new browserWindow.Event('scroll'))
    await frames.flush()
    expect(state.transcriptFollowing.value).toBe(true)
    height = 2600
    state.scheduleTranscriptReconcile()
    await frames.flush()
    expect(container.scrollTop).toBe(2000)
    expect(state.transcriptBottomDistance.value).toBe(0)

    state.handleTranscriptScroll()
    const scheduled = [...frames.callbacks.keys()]
    mounted.unmount()
    expect(scheduled.every(id => frames.cancelled.includes(id))).toBe(true)
    expect(frames.callbacks.size).toBe(0)
  })

  it('tracks growing dock height and focuses approvals without resuming automatic follow', async () => {
    installBrowserSurface()
    const frames = controlTranscriptFrames()
    const originalObserver = globalThis.ResizeObserver
    const observers: TestDockObserver[] = []
    class TestDockObserver implements ResizeObserver {
      readonly targets = new Set<Element>()
      disconnected = false
      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this)
      }
      observe(target: Element): void {
        this.disconnected = false
        this.targets.add(target)
      }
      unobserve(target: Element): void {
        this.targets.delete(target)
      }
      disconnect(): void {
        this.disconnected = true
        this.targets.clear()
      }
    }
    globalThis.ResizeObserver = TestDockObserver
    stateCleanups.push(() => {
      globalThis.ResizeObserver = originalObserver
    })
    const state = loadGoalLockState(null)
    const thread = state.thread.value
    if (!thread) throw new Error('Conversation missing')
    state.thread.value = {
      ...thread,
      messages: [{ id: 'message-1', role: 'user', content: 'A question' }],
      proposals: [{ id: 'proposal-1', status: 'pending', approval: { status: 'pending' } }]
    }
    const mounted = mountInlineAgent(state)
    const container = mounted.root.querySelector<HTMLElement>('.inline-agent__transcript')
    const dock = mounted.root.querySelector<HTMLElement>('.inline-agent__conversation-dock')
    if (!container || !dock) throw new Error('Conversation dock missing')
    state.transcript.value = container
    state.conversationDock.value = dock
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 600 }
    })
    let dockHeight = 120
    dock.getBoundingClientRect = () => ({ top: 600 - dockHeight, bottom: 600, height: dockHeight }) as DOMRect
    container.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect
    const approval = document.createElement('div')
    approval.id = 'agent-approval-proposal-1'
    approval.tabIndex = -1
    approval.getBoundingClientRect = () => ({ top: 200, bottom: 300, height: 100 }) as DOMRect
    container.insertBefore(approval, dock)
    await frames.flush()
    expect(container.style.getPropertyValue('--agent-dock-height')).toBe('120px')
    const observer = observers.find(candidate => candidate.targets.has(dock))
    if (!observer) throw new Error('Conversation dock was not observed')
    dockHeight = 340
    observer.callback([], observer)
    observer.callback([], observer)
    await frames.flush()
    expect(container.style.getPropertyValue('--agent-dock-height')).toBe('340px')

    const scrollIntoView = vi.spyOn(approval, 'scrollIntoView')
    await state.jumpToApproval()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(approval)
    expect(state.transcriptFollowing.value).toBe(false)
    container.scrollTop = 900
    state.handleTranscriptScroll()
    await frames.flush()
    dockHeight = 420
    observer.callback([], observer)
    await frames.flush()
    expect(container.style.getPropertyValue('--agent-dock-height')).toBe('420px')
    expect(container.scrollTop).toBe(900)
    expect(state.transcriptFollowing.value).toBe(false)
    mounted.unmount()
    expect(observer.disconnected).toBe(true)
  })

  it('positions empty mobile starters above the focused composer while translations are unavailable and after recovery', async () => {
    installBrowserSurface()
    const frames = controlTranscriptFrames()
    resizeViewport?.(390)
    const translator = vi.spyOn(globalThis, 'useTranslate').mockReturnValue(fallbackLocalizationLabel)
    const state = loadGoalLockState(null)
    const transcript = document.createElement('div')
    document.body.append(transcript)
    // Model a keyboard-reduced scrollport; native delayed-media anchoring is
    // exercised separately by the responsive browser case.
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 240 }
    })
    state.transcript.value = transcript
    state.handleComposerFocusIn()
    await state.reconcileTranscriptGrowth(false)
    await frames.flush()
    expect(transcript.scrollTop).toBe(560)

    translator.mockReturnValue(translateEnglish)
    transcript.scrollTo({ top: 0 })
    await state.reconcileTranscriptGrowth(false)
    await frames.flush()
    expect(transcript.scrollTop).toBe(560)

    resizeViewport?.(1024)
    await state.reconcileTranscriptGrowth(false)
    await frames.flush()
    expect(transcript.scrollTop).toBe(0)
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
    focusedTextarea.dispatchEvent(new document.defaultView!.FocusEvent('focusin', { bubbles: true }))
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
    refocusedTextarea.dispatchEvent(new document.defaultView!.FocusEvent('focusin', { bubbles: true }))
    await settle()
    expect(getComposerDock().classList.contains('inline-agent__composer--focused')).toBe(true)
    const refocusTranscript = getTranscript()
    refocusTranscript.focus()
    expect(document.activeElement).toBe(refocusTranscript)
    const transcriptFocusEvent = new document.defaultView!.FocusEvent('focusin', { bubbles: true })
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
      workspaceDisposed: false,
      networkPaused: false,
      loading: false,
      connection: 'connected',
      initializedWorkspaceVersion: workspace.store.workspaceVersion,
      thread: {
        ...threadFixture(),
        session: {
          ...threadFixture().session,
          currentRun: {
            id: '00000000-0000-4000-8000-000000000020',
            sessionId,
            status: 'running',
            attempt: 1,
            eventSequence: 1,
            canCancel: true,
            createdAt: timestamp,
            startedAt: timestamp,
            completedAt: null,
            errorCode: null,
            errorMessage: null
          }
        }
      }
    })
    const running = mountInlineAgent(workspace.state())
    expect(disabled(menuAction(await openPanelMenu(running), 'Pin chat'))).toBe(false)
    running.unmount()
    workspace.store.$patch({
      workspaceDisposed: false,
      networkPaused: false,
      loading: false,
      connection: 'connected',
      initializedWorkspaceVersion: workspace.store.workspaceVersion
    })
    const activeThread = workspace.store.thread
    if (!activeThread) throw new Error('Active conversation missing')
    workspace.store.thread = {
      ...activeThread,
      goal: {
        id: '00000000-0000-4000-8000-000000000030',
        sessionId,
        objective: 'Plan the release',
        status: 'active',
        version: 1,
        currentRunId: '00000000-0000-4000-8000-000000000020',
        continuationCount: 0,
        maxContinuations: 4,
        consumedTokens: 0,
        maxTokens: 4096,
        consumedToolCalls: 0,
        maxToolCalls: 16,
        budgetPolicyVersion: null,
        budgetSelection: 'legacy',
        tokenTier: null,
        tokenAllowance: null,
        budgetCycle: 0,
        budgetLimitReason: null,
        canRenewTokenBudget: false,
        startedAt: timestamp,
        deadlineAt: '2026-09-16T10:00:00.000Z',
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        completion: null
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
    expect(welcome?.querySelector('h1, h2, h3')).toBeNull()
    expect(welcome?.querySelectorAll('p.inline-agent__welcome-title .inline-agent__welcome-line')).toHaveLength(2)
    expect(welcome?.querySelector('.inline-agent__welcome-subtitle')?.textContent?.trim()).toBeTruthy()
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

describe('Inline Agent initialization admission', () => {
  for (const rawError of ['A same-origin request is required.', 'Agent permission denied.']) {
    it(`keeps a 403 admission failure separate from connectivity and retries only a fresh read (${rawError})`, async () => {
      const workspace = realWorkspace()
      workspace.authorization.pending = Promise.resolve(Response.json({ error: rawError }, { status: 403 }))
      workspace.store.initializedWorkspaceVersion = null
      const state = workspace.state()
      state.componentProps.resumeSessionId = sessionId
      const mounted = mountInlineAgent(state)
      await settle()

      const alert = mounted.root.querySelector<HTMLElement>('.inline-agent__admission-alert')
      expect(alert?.getAttribute('role')).toBe('alert')
      expect(alert?.textContent).toContain('access permission')
      expect(alert?.textContent).toContain('configured address')
      expect(alert?.textContent).not.toContain(rawError)
      expect(workspace.store.error).not.toContain(rawError)
      expect(mounted.root.querySelector('.inline-agent__connection-alert')).toBeNull()
      expect(workspace.store.initializationAdmissionFailure).toBe('access')
      expect(workspace.store.isWorkspaceReady()).toBe(false)
      expect(workspace.store.isWorkspaceMutationReady()).toBe(false)
      expect(state.canSubmit.value).toBe(false)
      expect(await state.sendPrompt('Do not send while admission is blocked')).toBe(false)
      expect(await workspace.store.newSession('saved')).toBe(false)

      const blockedRequests = workspace.requests.length
      workspace.store.handleVisibilityChange()
      testPwaState.connectionState = 'offline'
      await settle()
      testPwaState.connectionState = 'online'
      await settle()
      expect(workspace.requests).toHaveLength(blockedRequests)
      expect(state.connectionProbe).not.toHaveBeenCalled()
      expect(workspace.store.isWorkspaceMutationReady()).toBe(false)

      workspace.authorization.pending = null
      const retry = alert?.querySelector<HTMLButtonElement>('button')
      expect(retry?.textContent).toContain('Retry opening conversation')
      retry?.click()
      await settle()
      expect(state.connectionProbe).not.toHaveBeenCalled()
      expect(workspace.requests.slice(blockedRequests).some(request => request.path === `/_api/agents/sessions/${sessionId}` && request.method === 'GET')).toBe(
        true
      )
      expect(workspace.requests.every(request => request.method === 'GET')).toBe(true)
      expect(workspace.store.initializationAdmissionFailure).toBeNull()
      expect(workspace.store.isWorkspaceMutationReady()).toBe(true)
      expect(state.canSubmit.value).toBe(true)
      expect(mounted.root.querySelector('.inline-agent__admission-alert')).toBeNull()
    })
  }

  it('preserves identity loss on 401 without misreporting an offline workspace', async () => {
    const workspace = realWorkspace()
    workspace.authorization.pending = Promise.resolve(Response.json({ error: 'Internal authentication detail' }, { status: 401 }))
    workspace.store.initializedWorkspaceVersion = null
    workspace.store.setDraft(sessionId, 'Private draft')
    const state = workspace.state()
    const mounted = mountInlineAgent(state)
    await settle()
    const alert = mounted.root.querySelector<HTMLElement>('.inline-agent__admission-alert')
    expect(alert?.textContent).toContain('Sign in again')
    expect(alert?.textContent).not.toContain('Internal authentication detail')
    expect(mounted.root.querySelector('.inline-agent__connection-alert')).toBeNull()
    expect(workspace.store.thread).toBeNull()
    expect(workspace.store.drafts).toEqual({})
    expect(workspace.store.pinOwnerId).toBeNull()
    expect(workspace.store.initializationAdmissionFailure).toBe('authentication')
    expect(workspace.store.isWorkspaceReady()).toBe(false)
    expect(workspace.store.isWorkspaceMutationReady()).toBe(false)
    expect(state.connectionProbe).not.toHaveBeenCalled()
  })

  it('still offers connection recovery for transient service failures', async () => {
    const workspace = realWorkspace()
    workspace.authorization.pending = Promise.resolve(Response.json({ error: 'Service unavailable' }, { status: 503 }))
    workspace.store.initializedWorkspaceVersion = null
    const state = workspace.state()
    const mounted = mountInlineAgent(state)
    await settle()
    expect(workspace.store.initializationAdmissionFailure).toBeNull()
    expect(mounted.root.querySelector('.inline-agent__admission-alert')).toBeNull()
    expect(mounted.root.querySelector('.inline-agent__connection-alert')?.textContent).toContain('Retry connection')
    expect(state.canSubmit.value).toBe(false)
    expect(workspace.store.isWorkspaceMutationReady()).toBe(false)
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
