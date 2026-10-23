import type { AgentMediaSubmission } from '../helpers/agent-media.ts'
import { AgentKnowledgeContextSchema } from '../../shared/agents/knowledge-context.ts'
import { emptyAgentDraft, type AgentDraft } from '../helpers/agent-draft.ts'
import {
  clearAgentChatRecent,
  isAgentSessionId,
  readAgentChatRecent,
  writeAgentChatRecent,
  sameAgentChatPage,
  type AgentChatContextSelector
} from '../helpers/agent-chat-continuity.ts'
import { fetchWikiSource } from '../helpers/wiki-source.ts'
import type { WikiSource } from '../../shared/wiki-source.ts'
import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import { translate } from '../modules/localization.ts'
import type { AgentConversationFolderView, AgentCurrentPageHint, AgentEventType, AgentThreadState } from '../../shared/agents/contracts.ts'
import {
  AgentApiError,
  cancelAgentGoal,
  cancelAgentRun,
  clearUnfiledAgentHistory,
  createAgentConversationFolder,
  createAgentGoal,
  createAgentThread,
  decideAgentProposal,
  deleteAgentConversationFolder,
  deleteAgentSession,
  getAgentThread,
  listAgentConversationFolders,
  listAgentSessions,
  listAgentSkills,
  moveAgentSessionToFolder,
  pauseAgentGoal,
  renameAgentConversationFolder,
  renewAgentGoalBudget,
  resumeAgentGoal,
  subscribeAgentRun,
  submitAgentMessage,
  updateAgentSession,
  updateAgentSkillPreferences,
  type AgentSessionSummary,
  type CreatedAgentThread,
  type VisibleAgentSkill
} from '../helpers/agents-api.ts'

interface AgentAdmissionPins {
  readonly v: 1
  readonly ownerId: number
  readonly sessionId: string
  readonly sessionVersion: number
  readonly profileId: string
  readonly profileVersionId: string
  readonly profileVersion: number
  readonly profilePolicyVersion: number
  readonly defaultGeneration: number
  readonly executionMode: 'agent'
}

const admissionPinFields = [
  'v',
  'kid',
  'ownerId',
  'sessionId',
  'sessionVersion',
  'profileId',
  'profileVersionId',
  'profileVersion',
  'profilePolicyVersion',
  'defaultGeneration',
  'executionMode',
  'exp'
] as const
const positiveAdmissionInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

// Continuity only: the server still authenticates and validates the fresh signed token.
const readAdmissionPins = (token: string): AgentAdmissionPins | null => {
  if (typeof token !== 'string' || token.length > 16_384) return null
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null
  try {
    const decoded: unknown = JSON.parse(atob(parts[1].replace(/-/gu, '+').replace(/_/gu, '/')))
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null
    const payload = decoded as Record<string, unknown>
    for (const field of admissionPinFields) if (!Object.hasOwn(payload, field)) return null
    if (
      payload.v !== 1 ||
      typeof payload.kid !== 'string' ||
      !payload.kid ||
      !positiveAdmissionInteger(payload.ownerId) ||
      !isAgentSessionId(payload.sessionId) ||
      !positiveAdmissionInteger(payload.sessionVersion) ||
      !isAgentSessionId(payload.profileId) ||
      !isAgentSessionId(payload.profileVersionId) ||
      !positiveAdmissionInteger(payload.profileVersion) ||
      !positiveAdmissionInteger(payload.profilePolicyVersion) ||
      typeof payload.defaultGeneration !== 'number' ||
      !Number.isSafeInteger(payload.defaultGeneration) ||
      payload.defaultGeneration < 0 ||
      payload.executionMode !== 'agent' ||
      !positiveAdmissionInteger(payload.exp)
    )
      return null
    return payload as unknown as AgentAdmissionPins
  } catch {
    return null
  }
}

const sameAdmissionPins = (previous: AgentAdmissionPins | null, next: AgentAdmissionPins | null): boolean =>
  previous !== null &&
  next !== null &&
  previous.v === next.v &&
  previous.ownerId === next.ownerId &&
  previous.sessionId === next.sessionId &&
  previous.sessionVersion === next.sessionVersion &&
  previous.profileId === next.profileId &&
  previous.profileVersionId === next.profileVersionId &&
  previous.profileVersion === next.profileVersion &&
  previous.profilePolicyVersion === next.profilePolicyVersion &&
  previous.defaultGeneration === next.defaultGeneration &&
  previous.executionMode === next.executionMode

const terminalEvents = new Set<AgentEventType>(['run.completed', 'run.partial', 'run.failed', 'run.cancelled', 'run.recovery_required'])
const fetchFromWindow: typeof fetch = (input, init) => window.fetch(input, init)
const SSE_INACTIVITY_MS = 15_000
const SSE_RETRY_BASE_MS = 1_000
const SSE_RETRY_MAX_MS = 30_000
const THREAD_READ_TIMEOUT_MS = 15_000

// Abort must settle the consumer even if a suspended/custom transport ignores
// its signal. The wall clock also fences responses when timer callbacks slept.
const readThreadWithDeadline = async (
  csrfToken: string,
  sessionId: string,
  controller: AbortController,
  deadline = Date.now() + THREAD_READ_TIMEOUT_MS
): Promise<AgentThreadState> => {
  const signal = controller.signal
  if (signal.aborted) throw signal.reason
  const { promise: aborted, reject } = Promise.withResolvers<never>()
  const onAbort = (): void => reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = window.setTimeout(() => controller.abort(new AgentApiError(408, 'The conversation read timed out. Try again.')), Math.max(0, deadline - Date.now()))
  try {
    const thread = await Promise.race([getAgentThread(fetchFromWindow, csrfToken, sessionId, signal), aborted])
    if (Date.now() >= deadline) throw new AgentApiError(408, 'The conversation read timed out. Try again.')
    return thread
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
export { isAgentSessionId }
export interface AgentRefreshResult {
  /**
   * `accepted` is true only when this read committed its fresh response to the
   * captured workspace/resource. `current` is false when the caller was
   * superseded, disposed, or switched owners before the response settled.
   */
  readonly accepted: boolean
  readonly current: boolean
  readonly error?: unknown
}

const refreshResult = (accepted: boolean, current: boolean, error?: unknown): AgentRefreshResult =>
  error === undefined ? { accepted, current } : { accepted, current, error }

export interface AgentStoreInitializeOptions {
  readonly ownerId: number
  readonly routeSync?: boolean
  readonly currentPage?: AgentCurrentPageHint | null
  readonly resumeSessionId?: string
  /**
   * Retry/revalidation may read the current authority but must not create a
   * conversation as a side effect. Initial entry keeps this enabled.
   */
  readonly allowCreate?: boolean
}

export const useAgentsStore = defineStore('agents', {
  state: () => ({
    csrfToken: '',
    sessions: [] as AgentSessionSummary[],
    sessionsNextCursor: null as string | null,
    sessionsLoadingMore: false,
    sessionsLoadMoreError: '',
    sessionsLoadMoreController: null as AbortController | null,
    sessionsReloadController: null as AbortController | null,
    sessionsReloading: false,
    folders: [] as AgentConversationFolderView[],
    thread: null as AgentThreadState | null,
    drafts: {} as Record<string, AgentDraft>,
    skills: [] as VisibleAgentSkill[],
    skillsLoading: false,
    skillsLoadError: '',
    skillsPartial: false,
    skillsLoadGeneration: 0,
    skillsLoadController: null as AbortController | null,
    launchPage: null as AgentCurrentPageHint | null,
    contextPage: null as AgentCurrentPageHint | null,
    routeSync: true,
    loading: false,
    sending: false,
    sessionMutationTokenCounter: 0,
    sessionMutationToken: null as number | null,
    error: '',
    connection: 'idle' as 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed',
    networkPaused: false,
    initializationAdmissionFailure: null as 'access' | 'authentication' | null,
    eventSequence: 0,
    source: null as EventSource | null,
    refreshTimer: null as number | null,
    watchdogTimer: null as number | null,
    refreshGeneration: 0,
    refreshSessionId: null as string | null,
    initializationGeneration: 0,
    initializationController: null as AbortController | null,
    refreshController: null as AbortController | null,
    refreshDeadlineAt: null as number | null,
    connectionGeneration: 0,
    reconnectAttempt: 0,
    visibilityListening: false,
    decidingApprovalId: null as string | null,
    goalBusy: false,
    stoppingRunId: null as string | null,
    sessionTransitionVersion: 0,
    sessionTransitionController: null as AbortController | null,
    sessionTransitionKind: null as 'read' | 'mutation' | null,
    sessionListVersion: 0,
    workspaceVersion: 0,
    ownerGeneration: 0,
    folderReloadGeneration: 0,
    folderReloadController: null as AbortController | null,
    workspaceDisposed: false,
    initializedWorkspaceVersion: null as number | null,
    workspaceCloseReason: null as 'authentication' | 'access' | 'session-unavailable' | null,
    workspaceOwnerId: null as number | null,
    continuitySessionId: null as string | null,
    workspaceClosedAt: null as number | null,
    contextTransferNotice: '',
    contextTransferController: null as AbortController | null,
    contextTransferGeneration: 0
  }),
  getters: {
    sessionMutationBusy: state => state.sessionMutationToken !== null
  },
  actions: {
    async initialize(csrfToken: string, options: AgentStoreInitializeOptions): Promise<boolean> {
      const ownerChanged = this.workspaceOwnerId !== null && this.workspaceOwnerId !== options.ownerId
      if (ownerChanged) {
        this.ownerGeneration += 1
        this.invalidateSessionMutation()
        this.closeStream()
        this.invalidateRefresh()
        this.cancelSessionTransition()
        this.thread = null
        this.drafts = {}
        this.sessions = []
        this.sessionsNextCursor = null
        this.folders = []
        this.launchPage = null
        this.error = ''
        this.sending = false
        this.goalBusy = false
        this.stoppingRunId = null
        this.decidingApprovalId = null
        this.continuitySessionId = null
        this.workspaceClosedAt = null
        this.contextTransferNotice = ''
        clearAgentChatRecent()
      }

      const previousThread = this.thread
      const previousContext = this.currentChatContext()
      // A known-gone conversation may retain a same-owner composition in
      // memory, but its retired selector must never be restored or replayed.
      const unavailableComposition = !ownerChanged && previousThread && this.continuitySessionId === null ? this.drafts[previousThread.session.id] : undefined
      const requestedResumeId = isAgentSessionId(options.resumeSessionId) ? options.resumeSessionId : null
      const retainOpenWorkspace =
        !ownerChanged &&
        !this.workspaceDisposed &&
        this.initializedWorkspaceVersion === this.workspaceVersion &&
        previousThread !== null &&
        (requestedResumeId === null || requestedResumeId === previousThread.session.id)
      this.cancelContextTransfer()
      this.initializationGeneration += 1
      this.initializationController?.abort()
      const initializationGeneration = this.initializationGeneration
      const initializationController = markRaw(new AbortController())
      this.initializationController = initializationController

      this.workspaceOwnerId = options.ownerId
      this.cancelSessionTransition()
      let selectionVersion = this.sessionTransitionVersion
      this.workspaceCloseReason = null
      this.networkPaused = true
      this.initializationAdmissionFailure = null
      this.skillsLoadGeneration += 1
      this.skillsLoadController?.abort()
      this.skillsLoadController = null
      this.closeStream()
      this.skills = []
      this.skillsLoadError = ''
      this.skillsPartial = true
      this.invalidateRefresh()
      this.invalidateFolderReload()
      const folderReloadGeneration = this.folderReloadGeneration
      const workspaceVersion = this.workspaceVersion + 1
      const sessionListVersion = this.sessionListVersion + 1
      const ownerGeneration = this.ownerGeneration
      this.workspaceVersion = workspaceVersion
      this.initializedWorkspaceVersion = null
      this.workspaceDisposed = false
      this.sessionListVersion = sessionListVersion
      this.sessionsLoadMoreController?.abort()
      this.sessionsLoadMoreController = null
      this.sessionsReloadController?.abort()
      this.sessionsReloadController = null
      this.sessionsReloading = false
      this.sessionsLoadingMore = false
      this.sessionsLoadMoreError = ''
      this.networkPaused = true
      this.loading = true
      this.error = ''
      this.csrfToken = csrfToken
      this.routeSync = options.routeSync ?? true
      this.contextPage = options.currentPage ?? null
      const recent = readAgentChatRecent(options.ownerId)
      this.listenForVisibility()
      void this.reloadSkills()
      const allowCreate = options.allowCreate ?? true
      let initialized = false
      const isInitializationCurrent = (): boolean =>
        this.isOwnerContextCurrent(workspaceVersion, options.ownerId, ownerGeneration) &&
        this.initializationGeneration === initializationGeneration &&
        this.initializationController === initializationController
      const isCurrent = (): boolean => isInitializationCurrent() && this.sessionTransitionVersion === selectionVersion
      try {
        const pathMatch = this.routeSync ? /^\/sessions\/([^/]+)$/.exec(window.location.pathname) : null
        const [sessionPage, folders] = await Promise.all([
          listAgentSessions(fetchFromWindow, csrfToken, { signal: initializationController.signal }),
          listAgentConversationFolders(fetchFromWindow, csrfToken, initializationController.signal)
        ])
        if (!isCurrent()) return false
        if (this.sessionListVersion === sessionListVersion) {
          this.sessions = markRaw(sessionPage.sessions)
          this.sessionsNextCursor = sessionPage.nextCursor
        }
        if (this.folderReloadGeneration === folderReloadGeneration) this.folders = markRaw(folders)

        const routeSessionId = pathMatch?.[1]
        const explicitSessionId = isAgentSessionId(routeSessionId) ? routeSessionId : requestedResumeId
        const candidates = [
          ...new Set(
            [
              explicitSessionId,
              retainOpenWorkspace && this.thread === previousThread ? previousThread.session.id : null,
              recent?.sessionId ?? null
            ].filter((id): id is string => id !== null)
          )
        ]
        let unavailableDraft = explicitSessionId === null || explicitSessionId === previousThread?.session.id ? unavailableComposition : undefined
        for (const candidate of candidates) {
          if (!isCurrent()) return false
          try {
            const opening = this.openSession(candidate)
            selectionVersion = this.sessionTransitionVersion
            initialized = await opening
            if (!initialized) return false
            break
          } catch (error) {
            if (!(error instanceof AgentApiError) || (error.status !== 404 && error.status !== 410)) throw error
            unavailableDraft ??= this.drafts[candidate]
            this.clearConversationSelection(candidate)
          }
        }
        if (!initialized && allowCreate && isCurrent()) {
          const creating = this.newSession('saved', undefined, true)
          selectionVersion = this.sessionTransitionVersion
          initialized = await creating
          if (initialized && isCurrent() && unavailableDraft && this.thread) {
            // Only explicit entry may create a replacement for a gone chat.
            // Recover its unsent composition for review, never an old POST.
            this.updateDraft(this.thread.session.id, JSON.parse(JSON.stringify(unavailableDraft)) as AgentDraft)
          }
        }
        if (initialized && isCurrent()) {
          const context = previousThread?.session.id === this.thread?.session.id
            ? previousContext
            : recent !== null && recent.sessionId === this.thread?.session.id ? recent.context : undefined
          initialized = await this.reconcileConversationContext(context)
          if (initialized && isCurrent()) {
            this.workspaceClosedAt = null
            this.continuitySessionId = this.thread?.session.id ?? null
            this.persistConversationContext()
          }
        }
        if (initialized && isCurrent()) {
          this.initializedWorkspaceVersion = workspaceVersion
          this.initializationAdmissionFailure = null
        }
        return initialized && isCurrent()
      } catch (error) {
        if (isCurrent()) {
          initialized = false
          this.initializedWorkspaceVersion = null
          this.networkPaused = true
          if (error instanceof AgentApiError && error.status === 401) {
            this.destroyWorkspace()
            this.workspaceCloseReason = 'authentication'
            this.initializationAdmissionFailure = 'authentication'
            this.error = translate('common:agentWorkspace.authenticationRequiredMessage')
          } else if (error instanceof AgentApiError && error.status === 403) {
            this.initializationAdmissionFailure = 'access'
            this.error = translate('common:agentWorkspace.admissionRequiredMessage')
          } else this.error = error instanceof Error ? error.message : 'Agent session failed to load.'
        }
        return false
      } finally {
        const stillCurrent = isInitializationCurrent()
        const stillSelected = isCurrent()
        if (this.initializationController === initializationController) this.initializationController = null
        if (stillCurrent) {
          this.loading = false
          if (initialized && stillSelected) this.initializedWorkspaceVersion = workspaceVersion
        }
      }
    },
    clearConversationSelection(sessionId?: string): void {
      if (sessionId === undefined || (this.workspaceOwnerId !== null && readAgentChatRecent(this.workspaceOwnerId)?.sessionId === sessionId)) clearAgentChatRecent()
      if (sessionId === undefined || this.continuitySessionId === sessionId) {
        this.continuitySessionId = null
        this.workspaceClosedAt = null
      }
    },
    currentChatContext(): AgentChatContextSelector | undefined {
      const sessionId = this.thread?.session.id
      const draft = sessionId ? this.drafts[sessionId] : undefined
      if (!draft) return undefined
      return {
        includeCurrentPage: draft.includeCurrentPage,
        sources: draft.sources.map(({ id, locale }) => ({ id, locale }))
      }
    },
    persistConversationContext(): void {
      const sessionId = this.thread?.session.id
      if (this.workspaceOwnerId === null || !sessionId || sessionId !== this.continuitySessionId) return
      const current = this.currentChatContext()
      const recent = current === undefined ? readAgentChatRecent(this.workspaceOwnerId) : null
      const context = current ?? (recent?.sessionId === sessionId ? recent.context : undefined)
      writeAgentChatRecent(this.workspaceOwnerId, sessionId, this.workspaceClosedAt ?? Date.now(), context)
    },
    setCurrentPage(page: AgentCurrentPageHint | null) {
      this.contextPage = page
    },
    cancelContextTransfer(): void {
      this.contextTransferGeneration += 1
      this.contextTransferController?.abort()
      this.contextTransferController = null
    },
    async reconcileConversationContext(previous?: AgentChatContextSelector): Promise<boolean> {
      const sessionId = this.thread?.session.id
      const ownerId = this.workspaceOwnerId
      if (!sessionId || ownerId === null) return true
      this.cancelContextTransfer()
      const draft = this.drafts[sessionId]
      // Mounted compositions, including reviewed original hints, belong to
      // their conversation. Browsing only changes the separate current-page hint.
      if (draft) return true
      if (!previous) {
        this.drafts[sessionId] = emptyAgentDraft()
        this.contextTransferNotice = ''
        return true
      }
      const generation = this.contextTransferGeneration
      const controller = markRaw(new AbortController())
      this.contextTransferController = controller
      const workspaceVersion = this.workspaceVersion
      const ownerGeneration = this.ownerGeneration
      const isCurrent = (): boolean =>
        !controller.signal.aborted &&
        this.contextTransferGeneration === generation &&
        this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
        this.thread?.session.id === sessionId &&
        this.drafts[sessionId] === undefined
      let unavailable = false
      try {
        const sources = (await Promise.all(previous.sources.map(async selector => {
          try {
            const source = await fetchWikiSource({ id: selector.id }, '', controller.signal)
            if (!sameAgentChatPage(source, selector)) throw new Error('Source identity changed.')
            return source
          } catch {
            if (!controller.signal.aborted) unavailable = true
            return null
          }
        }))).filter((source): source is WikiSource => source !== null)
        if (!isCurrent()) return false
        this.drafts[sessionId] = { ...emptyAgentDraft(), sources, includeCurrentPage: previous.includeCurrentPage }
        this.contextTransferNotice = unavailable ? 'A previous source could not be restored. Check access and add it again if needed.' : ''
        return true
      } finally {
        if (this.contextTransferController === controller) this.contextTransferController = null
      }
    },
    isWorkspaceCurrent(version: number) {
      return !this.workspaceDisposed && this.workspaceVersion === version
    },
    isOwnerContextCurrent(workspaceVersion: number, ownerId: number | null, ownerGeneration: number): boolean {
      return this.isWorkspaceCurrent(workspaceVersion) && this.workspaceOwnerId === ownerId && this.ownerGeneration === ownerGeneration
    },
    isWorkspaceMutationReady(): boolean {
      return (
        !this.workspaceDisposed &&
        !this.loading &&
        !this.networkPaused &&
        this.initializationAdmissionFailure === null &&
        this.initializedWorkspaceVersion === this.workspaceVersion
      )
    },
    isWorkspaceReady(): boolean {
      return this.isWorkspaceMutationReady() && (this.connection === 'idle' || this.connection === 'connected')
    },
    isSessionContextCurrent(version: number, sessionId: string) {
      return this.isWorkspaceCurrent(version) && this.thread?.session.id === sessionId
    },
    isSendCompletionCurrent(workspaceVersion: number, sessionId: string, ownerId: number | null, ownerGeneration: number, mutationToken: number) {
      if (this.isWorkspaceCurrent(workspaceVersion)) return this.isSessionMutationOwned(mutationToken)
      return (
        ownerId !== null &&
        this.workspaceOwnerId === ownerId &&
        this.ownerGeneration === ownerGeneration &&
        this.thread?.session.id === sessionId &&
        this.initializedWorkspaceVersion === this.workspaceVersion &&
        this.sessionMutationToken === null
      )
    },
    beginSessionMutation(): number | null {
      if (this.workspaceDisposed || this.sessionMutationToken !== null) return null
      const token = this.sessionMutationTokenCounter + 1
      this.sessionMutationTokenCounter = token
      this.sessionMutationToken = token
      this.beginSessionTransition('mutation')
      return token
    },
    isSessionMutationOwned(token: number): boolean {
      return this.sessionMutationToken === token
    },
    endSessionMutation(token: number): boolean {
      if (this.sessionMutationToken !== token) return false
      this.sessionMutationToken = null
      return true
    },
    invalidateSessionMutation() {
      this.sessionMutationToken = null
    },
    listenForVisibility() {
      if (this.visibilityListening) return
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
      window.addEventListener('focus', this.handleVisibilityChange)
      window.addEventListener('pageshow', this.handleVisibilityChange)
      this.visibilityListening = true
    },
    beginSessionTransition(kind: 'read' | 'mutation' = 'mutation') {
      this.cancelContextTransfer()
      const version = this.sessionTransitionVersion + 1
      this.sessionTransitionVersion = version
      this.sessionTransitionController?.abort()
      this.sessionTransitionController = null
      this.sessionTransitionKind = kind
      return version
    },
    beginSessionReadTransition() {
      const version = this.beginSessionTransition('read')
      const controller = markRaw(new AbortController())
      this.sessionTransitionController = controller
      return { version, controller }
    },
    isSessionTransitionCurrent(version: number) {
      return this.sessionTransitionVersion === version
    },
    cancelSessionTransition() {
      this.sessionTransitionVersion += 1
      this.sessionTransitionController?.abort()
      this.sessionTransitionController = null
      this.sessionTransitionKind = null
    },
    cancelSessionReadTransition() {
      if (this.sessionTransitionKind !== 'read' || !this.sessionTransitionController) return
      this.sessionTransitionVersion += 1
      this.sessionTransitionController.abort()
      this.sessionTransitionController = null
      this.sessionTransitionKind = null
    },
    closeWorkspace() {
      if (!this.workspaceDisposed && this.workspaceClosedAt === null && this.workspaceOwnerId !== null && this.thread?.session.id === this.continuitySessionId) {
        this.workspaceClosedAt = Date.now()
        this.persistConversationContext()
      }
      this.cancelContextTransfer()
      this.invalidateSessionMutation()
      this.workspaceVersion += 1
      this.workspaceDisposed = true
      this.networkPaused = true
      this.initializationAdmissionFailure = null
      this.skillsLoadGeneration += 1
      this.skillsLoadController?.abort()
      this.skillsLoadController = null
      this.skills = []
      this.skillsLoading = false
      this.skillsLoadError = ''
      this.skillsPartial = false
      this.loading = false
      this.initializedWorkspaceVersion = null
      this.sending = false
      this.goalBusy = false
      this.stoppingRunId = null
      this.decidingApprovalId = null
      this.initializationGeneration += 1
      this.initializationController?.abort()
      this.initializationController = null
      this.cancelSessionTransition()
      this.invalidateRefresh()
      this.invalidateFolderReload()
      this.sessionsLoadMoreController?.abort()
      this.sessionsLoadMoreController = null
      this.sessionsReloadController?.abort()
      this.sessionsReloadController = null
      this.sessionsReloading = false
      this.sessionsLoadingMore = false
      this.closeStream()
      if (this.visibilityListening) {
        document.removeEventListener('visibilitychange', this.handleVisibilityChange)
        window.removeEventListener('focus', this.handleVisibilityChange)
        window.removeEventListener('pageshow', this.handleVisibilityChange)
      }
      this.visibilityListening = false
    },
    /**
     * Verified identity loss is different from a component unmount: no
     * plaintext thread or draft may remain available to a later owner.
     */
    destroyWorkspace() {
      this.closeWorkspace()
      this.ownerGeneration += 1
      this.workspaceOwnerId = null
      this.thread = null
      this.drafts = {}
      this.sessions = []
      this.sessionsNextCursor = null
      this.folders = []
      this.launchPage = null
      this.contextPage = null
      this.error = ''
      this.continuitySessionId = null
      this.workspaceClosedAt = null
      this.contextTransferNotice = ''
      clearAgentChatRecent()
    },
    setDraft(sessionId: string, text: string) {
      if (!sessionId) return
      this.updateDraft(sessionId, { text })
    },
    updateDraft(sessionId: string, patch: Partial<AgentDraft>) {
      if (!sessionId) return
      const previous = this.drafts[sessionId] ?? emptyAgentDraft()
      const contextChanged =
        (patch.includeCurrentPage !== undefined && patch.includeCurrentPage !== previous.includeCurrentPage) ||
        (patch.sources !== undefined &&
          patch.sources !== previous.sources &&
          (patch.sources.length !== previous.sources.length || patch.sources.some((source, index) => !sameAgentChatPage(source, previous.sources[index]))))
      const clearPageOverride =
        (patch.text === '' && previous.text !== '' && patch.currentPageOverride === undefined) ||
        (patch.includeCurrentPage === true && previous.currentPageOverride === null && patch.currentPageOverride === undefined)
      const next = { ...previous, ...patch }
      if (clearPageOverride) delete next.currentPageOverride
      this.drafts[sessionId] = next
      if (contextChanged && sessionId === this.continuitySessionId) this.persistConversationContext()
    },
    async restoreRequest(messageId: string): Promise<string | null> {
      if (!this.isWorkspaceReady() || this.sending || this.sessionMutationBusy) return null
      const thread = this.thread
      const message = thread?.messages.find(item => item.id === messageId && item.role === 'user')
      if (!thread || !message) return null
      this.cancelContextTransfer()
      const generation = this.contextTransferGeneration
      const controller = markRaw(new AbortController())
      this.contextTransferController = controller
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const sessionId = thread.session.id
      // Fail closed even when historical metadata or a source is unavailable.
      this.updateDraft(sessionId, { includeCurrentPage: false, currentPageOverride: null })
      const draft = this.drafts[sessionId]
      const isCurrent = (): boolean =>
        !controller.signal.aborted &&
        this.contextTransferGeneration === generation &&
        this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
        this.thread?.session.id === sessionId &&
        this.drafts[sessionId] === draft
      try {
        const knowledgeContext = AgentKnowledgeContextSchema.safeParse(message.knowledgeContext)
        if (!knowledgeContext.success) throw new Error('Historical source context is unavailable.')
        const sources = await Promise.all(knowledgeContext.data.sources.map(async selector => {
          const source = await fetchWikiSource({ id: selector.id }, '', controller.signal)
          if (!sameAgentChatPage(source, selector)) throw new Error('Source identity changed.')
          return source
        }))
        if (!isCurrent()) return null
        this.updateDraft(sessionId, {
          text: message.content,
          sources,
          scope: knowledgeContext.data.scope,
          includeCurrentPage: message.currentPage != null,
          currentPageOverride: message.currentPage ? { ...message.currentPage } : null
        })
        this.contextTransferNotice = message.currentPage === undefined
          ? 'A previous source could not be restored. Check access and add it again if needed.'
          : ''
        return message.content
      } catch {
        if (isCurrent()) this.contextTransferNotice = 'A previous source could not be restored. Check access and add it again if needed.'
        controller.abort()
        return null
      } finally {
        if (this.contextTransferController === controller) this.contextTransferController = null
      }
    },
    async newSession(retention: 'temporary' | 'saved', mutationOwner?: number, allowWhileInitializing = false): Promise<boolean> {
      if (this.workspaceDisposed || (!this.isWorkspaceReady() && !(allowWhileInitializing && this.loading && this.initializedWorkspaceVersion === null)))
        return false
      const acquiredHere = mutationOwner === undefined
      const mutationToken = mutationOwner === undefined ? this.beginSessionMutation() : this.isSessionMutationOwned(mutationOwner) ? mutationOwner : null
      if (mutationToken === null) return false
      try {
        const workspaceVersion = this.workspaceVersion
        const ownerId = this.workspaceOwnerId
        const ownerGeneration = this.ownerGeneration
        const version = this.beginSessionTransition()
        const previous = this.thread
        const disposableSessionId =
          previous && previous.messages.length === 0 && !previous.session.currentRun && !previous.goal && !previous.session.folderId
            ? previous.session.id
            : null
        // Keep the current conversation and its draft intact until creation succeeds.
        const created = await createAgentThread(fetchFromWindow, this.csrfToken, { retention })
        const selectsCreated = this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionTransitionCurrent(version)
        if (!selectsCreated) return false
        this.error = ''
        this.closeStream()
        this.invalidateRefresh()
        this.applyCreatedThread(created)
        if (this.routeSync) window.history.replaceState(null, '', `/sessions/${created.session.id}`)
        if (disposableSessionId) {
          try {
            await deleteAgentSession(fetchFromWindow, this.csrfToken, disposableSessionId)
            delete this.drafts[disposableSessionId]
          } catch {
            // The replacement is usable; empty sessions are already excluded from history.
          }
        }
        this.networkPaused = false
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) {
          const refreshed = await this.reloadSessions()
          if (!refreshed.accepted && refreshed.current && this.isSessionTransitionCurrent(version)) {
            const detail = refreshed.error instanceof Error ? refreshed.error.message : 'Refresh the conversation.'
            this.error = `The conversation was created, but history could not be refreshed. ${detail}`.trim()
          }
        }
        return true
      } finally {
        if (acquiredHere) this.endSessionMutation(mutationToken)
      }
    },
    applyCreatedThread(created: CreatedAgentThread) {
      this.thread = markRaw(created)
      this.continuitySessionId = created.session.id
      this.workspaceClosedAt = null
      this.contextTransferNotice = ''
      const launch = created.launchPage
      this.launchPage =
        launch?.pageId && launch.locale && launch.path && launch.observedUpdatedAt
          ? { id: launch.pageId, locale: launch.locale, path: launch.path, observedUpdatedAt: launch.observedUpdatedAt }
          : null
      // A successful create is an authoritative read for the new resource.
      this.initializedWorkspaceVersion = this.workspaceVersion
      this.initializationAdmissionFailure = null
      this.networkPaused = false
      this.persistConversationContext()
      this.connectCurrentRun()
    },
    async openSession(sessionId: string): Promise<boolean> {
      if (this.workspaceDisposed || this.initializationAdmissionFailure !== null || !isAgentSessionId(sessionId) || this.sessionMutationToken !== null)
        return false
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const { version, controller } = this.beginSessionReadTransition()
      const isCurrent = (): boolean => this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionTransitionCurrent(version)
      try {
        const candidate = await readThreadWithDeadline(this.csrfToken, sessionId, controller)
        if (!isCurrent()) return false
        this.sessionTransitionController = null
        this.sessionTransitionKind = null
        this.closeStream()
        this.invalidateRefresh()
        const changedSession = this.thread?.session.id !== candidate.session.id
        this.thread = markRaw(candidate)
        this.continuitySessionId = candidate.session.id
        this.workspaceClosedAt = null
        this.launchPage = null
        if (changedSession) this.contextTransferNotice = ''
        this.persistConversationContext()
        if (this.routeSync) window.history.replaceState(null, '', `/sessions/${sessionId}`)
        // The candidate was just authorized by a fresh thread read.
        this.initializedWorkspaceVersion = workspaceVersion
        this.initializationAdmissionFailure = null
        this.networkPaused = false
        this.connectCurrentRun()
        return true
      } catch (error) {
        if (!isCurrent()) return false
        this.sessionTransitionController = null
        this.sessionTransitionKind = null
        throw error
      }
    },
    invalidateRefresh() {
      this.refreshGeneration += 1
      this.refreshSessionId = null
      this.refreshDeadlineAt = null
      this.refreshController?.abort()
      this.refreshController = null
    },
    async refreshThread(): Promise<AgentRefreshResult> {
      const workspaceVersion = this.workspaceVersion
      const sessionId = this.thread?.session.id
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      if (!sessionId || this.initializationAdmissionFailure !== null || !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration))
        return refreshResult(false, false)
      if (document.visibilityState === 'hidden') return refreshResult(false, true)
      const generation = this.refreshGeneration + 1
      this.refreshGeneration = generation
      this.refreshSessionId = sessionId
      this.refreshController?.abort()
      const controller = markRaw(new AbortController())
      this.refreshController = controller
      const deadline = Date.now() + THREAD_READ_TIMEOUT_MS
      this.refreshDeadlineAt = deadline
      const isCurrent = (): boolean =>
        this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
        this.refreshSessionId === sessionId &&
        this.refreshGeneration === generation &&
        this.refreshController === controller
      try {
        const refreshed = await readThreadWithDeadline(this.csrfToken, sessionId, controller, deadline)
        if (!isCurrent()) return refreshResult(false, false)
        this.thread = markRaw(refreshed)
        this.initializedWorkspaceVersion = workspaceVersion
        this.initializationAdmissionFailure = null
        this.networkPaused = false
        return refreshResult(true, true)
      } catch (error) {
        const current =
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.refreshSessionId === sessionId && this.refreshGeneration === generation
        if (!current) return refreshResult(false, false)
        if (current) {
          this.initializedWorkspaceVersion = null
          this.networkPaused = true
          if (error instanceof AgentApiError && error.status === 401) {
            this.destroyWorkspace()
            this.workspaceCloseReason = 'authentication'
            return refreshResult(false, false, error)
          }
          if (error instanceof AgentApiError && (error.status === 403 || error.status === 404 || error.status === 410)) {
            // Retain same-owner drafts and selectors, not stale admission. Reopening
            // must read current authority and may discover that this chat is gone.
            if (error.status !== 403) this.clearConversationSelection(sessionId)
            this.closeWorkspace()
            this.error = error.status === 403 ? translate('common:agentWorkspace.admissionRequiredMessage') : error.message
            this.workspaceCloseReason = error.status === 403 ? 'access' : 'session-unavailable'
            return refreshResult(false, false, error)
          }
        }
        return refreshResult(false, current, error)
      } finally {
        if (this.refreshGeneration === generation && this.refreshController === controller) {
          this.refreshController = null
          this.refreshDeadlineAt = null
        }
      }
    },
    async reloadSessions(): Promise<AgentRefreshResult> {
      if (this.workspaceDisposed) return refreshResult(false, false)
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const version = this.sessionListVersion + 1
      this.sessionListVersion = version
      this.sessionsLoadMoreController?.abort()
      this.sessionsLoadMoreController = null
      this.sessionsLoadingMore = false
      this.sessionsLoadMoreError = ''
      this.sessionsReloadController?.abort()
      const controller = markRaw(new AbortController())
      this.sessionsReloadController = controller
      this.sessionsReloading = true
      const isCurrent = (): boolean =>
        this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
        this.sessionListVersion === version &&
        this.sessionsReloadController === controller
      try {
        const page = await listAgentSessions(fetchFromWindow, this.csrfToken, { signal: controller.signal })
        if (!isCurrent()) return refreshResult(false, false)
        const previousById = new Map(this.sessions.map(session => [session.id, session]))
        this.sessions = markRaw(
          page.sessions.map(session => {
            const previous = previousById.get(session.id)
            return previous && previous.version > session.version ? previous : session
          })
        )
        this.sessionsNextCursor = page.nextCursor
        return refreshResult(true, true)
      } catch (error) {
        const current = this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.sessionListVersion === version
        if (current && error instanceof DOMException && error.name === 'AbortError') return refreshResult(false, false, error)
        return refreshResult(false, current, error)
      } finally {
        if (this.sessionsReloadController === controller) {
          this.sessionsReloadController = null
          if (this.sessionListVersion === version) this.sessionsReloading = false
        }
      }
    },
    async loadMoreSessions(): Promise<boolean> {
      if (this.workspaceDisposed) return false
      const cursor = this.sessionsNextCursor
      if (!cursor || this.loading || this.sessionsLoadingMore || this.sessionsReloading) return false
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const version = this.sessionListVersion
      const controller = markRaw(new AbortController())
      this.sessionsLoadMoreController = controller
      this.sessionsLoadingMore = true
      this.sessionsLoadMoreError = ''
      try {
        const page = await listAgentSessions(fetchFromWindow, this.csrfToken, { cursor, signal: controller.signal })
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          this.sessionListVersion !== version ||
          this.sessionsLoadMoreController !== controller ||
          this.sessionsNextCursor !== cursor
        )
          return false
        const knownIds = new Set(this.sessions.map(session => session.id))
        const olderSessions = page.sessions.filter(session => {
          if (knownIds.has(session.id)) return false
          knownIds.add(session.id)
          return true
        })
        this.sessions = markRaw([...this.sessions, ...olderSessions])
        this.sessionsNextCursor = page.nextCursor
        return true
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return false
        if (
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
          this.sessionListVersion === version &&
          this.sessionsLoadMoreController === controller
        )
          this.sessionsLoadMoreError = error instanceof Error ? error.message : 'Older conversations could not be loaded.'
        return false
      } finally {
        if (this.sessionsLoadMoreController === controller) {
          this.sessionsLoadMoreController = null
          this.sessionsLoadingMore = false
        }
      }
    },
    invalidateFolderReload() {
      this.folderReloadGeneration += 1
      this.folderReloadController?.abort()
      this.folderReloadController = null
    },
    async reloadFolders(): Promise<AgentRefreshResult> {
      if (this.workspaceDisposed) return refreshResult(false, false)
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const generation = this.folderReloadGeneration + 1
      this.folderReloadGeneration = generation
      this.folderReloadController?.abort()
      const controller = markRaw(new AbortController())
      this.folderReloadController = controller
      const isCurrent = (): boolean =>
        this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
        this.folderReloadGeneration === generation &&
        this.folderReloadController === controller
      try {
        const folders = await listAgentConversationFolders(fetchFromWindow, this.csrfToken, controller.signal)
        if (!isCurrent()) return refreshResult(false, false)
        this.folders = markRaw(folders)
        return refreshResult(true, true)
      } catch (error) {
        const current = this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.folderReloadGeneration === generation
        if (current && error instanceof DOMException && error.name === 'AbortError') return refreshResult(false, false, error)
        return refreshResult(false, current, error)
      } finally {
        if (this.folderReloadController === controller) this.folderReloadController = null
      }
    },
    async createFolder(name: string) {
      if (this.workspaceDisposed || !this.isWorkspaceReady()) throw new Error('The conversation workspace is not ready. Please retry.')
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) throw new Error('Another conversation update is already in progress. Please retry.')
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      try {
        this.invalidateFolderReload()
        const created = await createAgentConversationFolder(fetchFromWindow, this.csrfToken, name)
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionMutationOwned(mutationToken)) {
          this.invalidateFolderReload()
          this.folders = markRaw([...this.folders, created])
        }
        return created
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    async renameFolder(folderId: string, expectedVersion: number, name: string) {
      if (this.workspaceDisposed || !this.isWorkspaceReady()) throw new Error('The conversation workspace is not ready. Please retry.')
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) throw new Error('Another conversation update is already in progress. Please retry.')
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      try {
        this.invalidateFolderReload()
        const renamed = await renameAgentConversationFolder(fetchFromWindow, this.csrfToken, folderId, expectedVersion, name)
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionMutationOwned(mutationToken)) {
          this.invalidateFolderReload()
          this.folders = markRaw(this.folders.map(folder => (folder.id === folderId ? renamed : folder)))
        }
        return renamed
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    async deleteFolder(folderId: string, expectedVersion: number): Promise<boolean> {
      if (this.workspaceDisposed || !this.isWorkspaceReady()) return false
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return false
      try {
        const workspaceVersion = this.workspaceVersion
        const ownerId = this.workspaceOwnerId
        const ownerGeneration = this.ownerGeneration
        this.invalidateFolderReload()
        const sessionId = this.thread?.session.id
        const refreshCurrent = this.thread?.session.folderId === folderId
        await deleteAgentConversationFolder(fetchFromWindow, this.csrfToken, folderId, expectedVersion)
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) return true
        this.invalidateFolderReload()
        this.folders = markRaw(this.folders.filter(folder => folder.id !== folderId))
        const refreshes: Promise<AgentRefreshResult>[] = [this.reloadSessions()]
        if (refreshCurrent && sessionId && this.isSessionContextCurrent(workspaceVersion, sessionId)) refreshes.push(this.refreshThread())
        const results = await Promise.all(refreshes)
        const failed = results.find(result => !result.accepted && result.current)
        if (failed && this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) {
          const detail = failed.error instanceof Error ? failed.error.message : 'Refresh the conversation.'
          this.error = `The folder was deleted, but the workspace could not be refreshed. ${detail}`.trim()
        }
        return true
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    async moveSessionToFolder(sessionId: string, folderId: string | null) {
      if (this.workspaceDisposed || !this.isWorkspaceReady()) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const current = this.thread?.session.id === sessionId ? this.thread.session : null
      const summary = this.sessions.find(session => session.id === sessionId)
      const expectedSessionVersion = Math.max(current?.version ?? 0, summary?.version ?? 0)
      if (!expectedSessionVersion) throw new Error('The conversation changed. Refresh history and try again.')
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      try {
        const projected = await moveAgentSessionToFolder(fetchFromWindow, this.csrfToken, sessionId, { expectedSessionVersion, folderId })
        this.projectCommittedSessionMutation(workspaceVersion, sessionId, projected, ownerId, ownerGeneration)
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) return projected
        const refreshed = await this.reloadSessions()
        if (!refreshed.accepted && refreshed.current && this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) {
          const detail = refreshed.error instanceof Error ? refreshed.error.message : 'Refresh the conversation.'
          this.error = `The conversation was moved, but history could not be refreshed. ${detail}`.trim()
        }
        return projected
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    projectCommittedSessionMutation(workspaceVersion: number, sessionId: string, projected: AgentThreadState, ownerId: number | null, ownerGeneration: number) {
      const projectedExecutionMode = projected.session.executionMode
      if (projectedExecutionMode !== 'agent') throw new Error('The server returned an invalid conversation execution mode.')
      if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) return
      const current = this.thread?.session.id === sessionId ? this.thread.session : null
      const summary = this.sessions.find(session => session.id === sessionId)
      const greatestKnownVersion = Math.max(current?.version ?? 0, summary?.version ?? 0)
      if (projected.session.version < greatestKnownVersion) return
      if (current) {
        this.invalidateRefresh()
        if (current.version <= projected.session.version) this.thread = markRaw(projected)
      }
      this.sessions = markRaw(
        this.sessions.map(session => {
          if (session.id !== sessionId || session.version > projected.session.version) return session
          const updated: AgentSessionSummary = {
            id: projected.session.id,
            title: projected.session.title,
            retention: projected.session.retention,
            folderId: projected.session.folderId,
            executionMode: projectedExecutionMode,
            version: projected.session.version,
            providerProfileId: projected.session.providerProfileId,
            createdAt: projected.session.createdAt,
            updatedAt: projected.session.updatedAt,
            lastActivityAt: projected.session.lastActivityAt,
            expiresAt: projected.session.expiresAt,
            deletedAt: session.deletedAt
          }
          return updated
        })
      )
    },
    async renameSession(sessionId: string, title: string) {
      if (this.workspaceDisposed || !this.isWorkspaceReady()) throw new Error('The conversation workspace is not ready. Please retry.')
      const trimmed = title.trim().slice(0, 255)
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const current = this.thread?.session.id === sessionId ? this.thread.session : null
      const summary = this.sessions.find(session => session.id === sessionId)
      const expectedSessionVersion = Math.max(current?.version ?? 0, summary?.version ?? 0)
      if (!expectedSessionVersion) throw new Error('The conversation changed. Refresh history and try again.')
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      try {
        const projected = await updateAgentSession(fetchFromWindow, this.csrfToken, sessionId, { expectedSessionVersion, title: trimmed })
        this.projectCommittedSessionMutation(workspaceVersion, sessionId, projected, ownerId, ownerGeneration)
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) return projected
        const refreshed = await this.reloadSessions()
        if (!refreshed.accepted && refreshed.current && this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) {
          const detail = refreshed.error instanceof Error ? refreshed.error.message : 'Refresh the conversation.'
          this.error = `The conversation was renamed, but history could not be refreshed. ${detail}`.trim()
        }
        return projected
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    async setSessionRetention(sessionId: string, retention: 'temporary' | 'saved') {
      if (this.workspaceDisposed || !this.isWorkspaceReady()) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const current = this.thread?.session.id === sessionId ? this.thread.session : null
      const summary = this.sessions.find(session => session.id === sessionId)
      const expectedSessionVersion = Math.max(current?.version ?? 0, summary?.version ?? 0)
      if (!expectedSessionVersion) throw new Error('The conversation changed. Refresh history and try again.')
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      try {
        const projected = await updateAgentSession(fetchFromWindow, this.csrfToken, sessionId, { expectedSessionVersion, retention })
        this.projectCommittedSessionMutation(workspaceVersion, sessionId, projected, ownerId, ownerGeneration)
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) return projected
        const refreshed = await this.reloadSessions()
        if (!refreshed.accepted && refreshed.current && this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) {
          const detail = refreshed.error instanceof Error ? refreshed.error.message : 'Refresh the conversation.'
          this.error = `The retention setting was updated, but history could not be refreshed. ${detail}`.trim()
        }
        return projected
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    async refreshCommittedMutation(workspaceVersion: number, sessionId: string, message: string): Promise<boolean> {
      if (!this.isSessionContextCurrent(workspaceVersion, sessionId)) return false
      const refreshed = await this.refreshThread()
      if (refreshed.accepted && refreshed.current && this.isSessionContextCurrent(workspaceVersion, sessionId)) {
        this.connectCurrentRun()
        return true
      }
      if (refreshed.current && this.isSessionContextCurrent(workspaceVersion, sessionId)) {
        const detail = refreshed.error instanceof Error ? refreshed.error.message : 'Refresh the conversation.'
        this.error = `${message} ${detail}`.trim()
      }
      return false
    },
    async send(
      content: string,
      invokedSkillVersionIds: readonly string[] = [],
      mode: 'message' | 'goal' = 'message',
      media?: AgentMediaSubmission,
      onAccepted?: () => void
    ): Promise<boolean> {
      if (!this.isWorkspaceReady() || this.contextTransferController !== null) return false
      const thread = this.thread
      const trimmed = content.trim()
      const draftSnapshot = JSON.parse(JSON.stringify(this.drafts[thread?.session.id ?? ''] ?? emptyAgentDraft())) as AgentDraft
      const currentPage = draftSnapshot.includeCurrentPage
        ? (draftSnapshot.currentPageOverride === undefined ? this.contextPage ?? this.launchPage : draftSnapshot.currentPageOverride)
        : null
      const clickedCurrentPage = currentPage ? { ...currentPage } : null
      if (
        !thread ||
        (!trimmed && !media?.attachmentIds.length) ||
        this.sending ||
        thread.session.currentRun?.canCancel ||
        (thread.goal && ['active', 'paused', 'blocked'].includes(thread.goal.status))
      )
        return false
      const workspaceVersion = this.workspaceVersion
      const sessionId = thread.session.id
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const capturedPins = readAdmissionPins(thread.session.profileResolutionToken)
      const capturedSessionVersion = thread.session.version
      const capturedExecutionMode = thread.session.executionMode
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return false
      this.sending = true
      this.error = ''
      try {
        const clickedSkillVersionIds = invokedSkillVersionIds.length > 0 ? [...invokedSkillVersionIds] : undefined
        const clickedMedia = media
          ? {
              attachmentIds: [...media.attachmentIds],
              ...(media.generationTools ? { generationTools: [...media.generationTools] } : {})
            }
          : undefined
        try {
          const refreshed = await this.refreshThread()
          if (
            !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
            !this.isSessionContextCurrent(workspaceVersion, sessionId) ||
            !this.isSessionMutationOwned(mutationToken)
          )
            return false
          if (!refreshed.accepted || !refreshed.current || !this.isWorkspaceReady()) {
            if (refreshed.current) this.error = 'The conversation could not be refreshed. Nothing was sent; retry when ready.'
            return false
          }
          const freshThread = this.thread
          if (!freshThread || freshThread.session.id !== sessionId) return false
          if (freshThread.session.currentRun?.canCancel || (freshThread.goal && ['active', 'paused', 'blocked'].includes(freshThread.goal.status))) {
            this.connectCurrentRun()
            return false
          }
          const freshPins = readAdmissionPins(freshThread.session.profileResolutionToken)
          if (
            !sameAdmissionPins(capturedPins, freshPins) ||
            freshPins?.ownerId !== ownerId ||
            freshPins?.sessionId !== sessionId ||
            freshPins?.sessionVersion !== freshThread.session.version ||
            freshThread.session.version !== capturedSessionVersion ||
            freshThread.session.executionMode !== capturedExecutionMode ||
            freshPins?.executionMode !== freshThread.session.executionMode
          ) {
            this.error = 'Agent settings changed. Review the conversation before sending again. Nothing was sent.'
            return false
          }
          const request = {
            clientRequestId: crypto.randomUUID(),
            expectedSessionVersion: freshThread.session.version,
            profileResolutionToken: freshThread.session.profileResolutionToken,
            ...(clickedSkillVersionIds ? { invokedSkillVersionIds: clickedSkillVersionIds } : {}),
            ...(clickedCurrentPage ? { currentPage: clickedCurrentPage } : {}),
            knowledgeContext: AgentKnowledgeContextSchema.parse({
              scope: draftSnapshot.scope,
              sources: draftSnapshot.sources.map(({ id, locale, path, title, visibility, sourceRevision }) => ({
                id,
                locale,
                path,
                title,
                visibility,
                sourceRevision
              }))
            })
          }
          if (mode === 'goal') {
            await createAgentGoal(fetchFromWindow, this.csrfToken, sessionId, {
              ...request,
              goalId: crypto.randomUUID(),
              objective: trimmed,
              ...(clickedMedia?.generationTools ? { generationTools: clickedMedia.generationTools } : {})
            })
          } else {
            await submitAgentMessage(fetchFromWindow, this.csrfToken, sessionId, {
              ...request,
              content: trimmed,
              ...(clickedMedia ? { attachmentIds: clickedMedia.attachmentIds, generationTools: clickedMedia.generationTools } : {})
            })
          }
        } catch (error) {
          if (this.isSessionContextCurrent(workspaceVersion, sessionId)) this.error = error instanceof Error ? error.message : 'Message could not be sent.'
          return false
        }
        const completionCurrent = this.isSendCompletionCurrent(workspaceVersion, sessionId, ownerId, ownerGeneration, mutationToken)
        if (
          completionCurrent &&
          this.drafts[sessionId]?.text.trim() === trimmed &&
          this.drafts[sessionId]?.mode === draftSnapshot.mode &&
          JSON.stringify(this.drafts[sessionId]?.skillVersionIds) === JSON.stringify(draftSnapshot.skillVersionIds)
        )
          this.updateDraft(sessionId, { text: '', mode: 'message', skillVersionIds: [] })
        // Admission is complete before the follow-up view refresh. Let the
        // current composer release accepted input without treating it as unsent.
        if (completionCurrent) onAccepted?.()
        // Reopening the same conversation while POST is pending must discover its accepted run.
        // A reopened workspace may accept this completion only for the same initialized owner/session.
        if (completionCurrent && this.thread?.session.id === sessionId) {
          const refreshVersion = this.isWorkspaceCurrent(workspaceVersion) ? workspaceVersion : this.workspaceVersion
          await this.refreshCommittedMutation(refreshVersion, sessionId, 'The message was sent, but the conversation could not be refreshed.')
        }
        return true
      } finally {
        if (this.isWorkspaceCurrent(workspaceVersion)) this.sending = false
        this.endSessionMutation(mutationToken)
      }
    },
    async stop() {
      if (!this.isWorkspaceMutationReady()) return
      const goal = this.thread?.goal
      if (goal?.status === 'active' || goal?.status === 'blocked') {
        await this.pauseGoal()
        return
      }
      const run = this.thread?.session.currentRun
      if (!run?.canCancel || this.stoppingRunId === run.id) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const sessionId = this.thread!.session.id
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      this.stoppingRunId = run.id
      this.error = ''
      try {
        await cancelAgentRun(fetchFromWindow, this.csrfToken, run.id)
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          !this.isSessionContextCurrent(workspaceVersion, sessionId) ||
          !this.isSessionMutationOwned(mutationToken)
        )
          return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The run was stopped, but the conversation could not be refreshed.')
      } catch (error) {
        if (
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
          this.isSessionContextCurrent(workspaceVersion, sessionId) &&
          this.isSessionMutationOwned(mutationToken)
        )
          this.error = error instanceof Error ? error.message : 'Run could not be stopped.'
      } finally {
        if (this.isSessionMutationOwned(mutationToken) && this.stoppingRunId === run.id) this.stoppingRunId = null
        this.endSessionMutation(mutationToken)
      }
    },
    async pauseGoal() {
      if (!this.isWorkspaceReady()) return
      const thread = this.thread
      const goal = thread?.goal
      if (!thread || !goal || this.goalBusy || (goal.status !== 'active' && goal.status !== 'blocked')) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const sessionId = thread.session.id
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      this.goalBusy = true
      this.error = ''
      try {
        await pauseAgentGoal(fetchFromWindow, this.csrfToken, goal.id, { expectedVersion: goal.version })
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          !this.isSessionContextCurrent(workspaceVersion, sessionId) ||
          !this.isSessionMutationOwned(mutationToken)
        )
          return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The goal was paused, but the conversation could not be refreshed.')
      } catch (error) {
        if (
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
          this.isSessionContextCurrent(workspaceVersion, sessionId) &&
          this.isSessionMutationOwned(mutationToken)
        )
          this.error = error instanceof Error ? error.message : 'Goal could not be paused.'
      } finally {
        if (this.isSessionMutationOwned(mutationToken)) this.goalBusy = false
        this.endSessionMutation(mutationToken)
      }
    },
    async resumeGoal() {
      if (!this.isWorkspaceReady()) return
      const thread = this.thread
      const goal = thread?.goal
      if (!thread || !goal || this.goalBusy || (goal.status !== 'paused' && goal.status !== 'blocked')) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const sessionId = thread.session.id
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      this.goalBusy = true
      this.error = ''
      try {
        await resumeAgentGoal(fetchFromWindow, this.csrfToken, goal.id, {
          expectedVersion: goal.version,
          runId: crypto.randomUUID(),
          clientRequestId: crypto.randomUUID()
        })
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          !this.isSessionContextCurrent(workspaceVersion, sessionId) ||
          !this.isSessionMutationOwned(mutationToken)
        )
          return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The goal was resumed, but the conversation could not be refreshed.')
      } catch (error) {
        if (
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
          this.isSessionContextCurrent(workspaceVersion, sessionId) &&
          this.isSessionMutationOwned(mutationToken)
        )
          this.error = error instanceof Error ? error.message : 'Goal could not be resumed.'
      } finally {
        if (this.isSessionMutationOwned(mutationToken)) this.goalBusy = false
        this.endSessionMutation(mutationToken)
      }
    },
    async renewGoalBudget(): Promise<boolean> {
      if (!this.isWorkspaceReady()) return false
      const thread = this.thread
      const goal = thread?.goal
      if (
        !thread ||
        !goal ||
        this.goalBusy ||
        goal.status !== 'budget_limited' ||
        goal.budgetLimitReason !== 'tokens' ||
        !goal.canRenewTokenBudget ||
        goal.tokenAllowance === null
      )
        return false
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const sessionId = thread.session.id
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return false
      const request = {
        expectedVersion: goal.version,
        runId: crypto.randomUUID(),
        clientRequestId: crypto.randomUUID(),
        confirmed: true as const
      }
      this.goalBusy = true
      this.error = ''
      let requestError: unknown = null
      try {
        try {
          await renewAgentGoalBudget(fetchFromWindow, this.csrfToken, goal.id, request)
        } catch (error) {
          requestError = error
        }
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          !this.isSessionContextCurrent(workspaceVersion, sessionId) ||
          !this.isSessionMutationOwned(mutationToken)
        )
          return false
        const refreshed = await this.refreshThread()
        if (!refreshed.accepted || !refreshed.current || !this.isSessionContextCurrent(workspaceVersion, sessionId)) {
          if (refreshed.current && this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionMutationOwned(mutationToken)) {
            const detail = refreshed.error instanceof Error ? refreshed.error.message : 'Refresh the conversation.'
            this.error =
              requestError === null
                ? `The token budget was renewed, but the conversation could not be refreshed. ${detail}`.trim()
                : `${requestError instanceof Error ? requestError.message : 'The token budget request could not be completed.'} ${detail}`.trim()
          }
          return false
        }
        this.connectCurrentRun()
        if (requestError === null) return true
        const latestGoal = this.thread?.goal
        const reconciled =
          latestGoal !== null &&
          latestGoal !== undefined &&
          (latestGoal.version > goal.version ||
            latestGoal.maxTokens > goal.maxTokens ||
            latestGoal.budgetCycle > goal.budgetCycle ||
            latestGoal.status !== goal.status ||
            latestGoal.currentRunId !== goal.currentRunId)
        if (reconciled) return true
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionMutationOwned(mutationToken))
          this.error = requestError instanceof Error ? requestError.message : 'The token budget could not be renewed.'
        return false
      } finally {
        if (this.isSessionMutationOwned(mutationToken)) this.goalBusy = false
        this.endSessionMutation(mutationToken)
      }
    },
    async cancelGoal() {
      if (!this.isWorkspaceReady()) return
      const thread = this.thread
      const goal = thread?.goal
      if (!thread || !goal || this.goalBusy || !['active', 'paused', 'blocked'].includes(goal.status)) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const sessionId = thread.session.id
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      this.goalBusy = true
      this.error = ''
      try {
        await cancelAgentGoal(fetchFromWindow, this.csrfToken, goal.id, { expectedVersion: goal.version })
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          !this.isSessionContextCurrent(workspaceVersion, sessionId) ||
          !this.isSessionMutationOwned(mutationToken)
        )
          return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The goal was cancelled, but the conversation could not be refreshed.')
      } catch (error) {
        if (
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
          this.isSessionContextCurrent(workspaceVersion, sessionId) &&
          this.isSessionMutationOwned(mutationToken)
        )
          this.error = error instanceof Error ? error.message : 'Goal could not be cancelled.'
      } finally {
        if (this.isSessionMutationOwned(mutationToken)) this.goalBusy = false
        this.endSessionMutation(mutationToken)
      }
    },
    async decideProposal(proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string) {
      if (!this.isWorkspaceMutationReady()) return
      const thread = this.thread
      const sessionId = thread?.session.id
      const proposal = thread?.proposals.find(candidate => candidate.id === proposalId)
      if (
        !sessionId ||
        !proposal ||
        proposal.approval?.id !== approvalId ||
        proposal.status !== 'pending' ||
        proposal.approval.status !== 'pending' ||
        this.decidingApprovalId
      )
        return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      this.decidingApprovalId = approvalId
      this.error = ''
      try {
        await decideAgentProposal(fetchFromWindow, this.csrfToken, proposalId, approvalId, {
          decision,
          ...(confirmationPath === undefined ? {} : { confirmationPath })
        })
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          !this.isSessionContextCurrent(workspaceVersion, sessionId) ||
          !this.isSessionMutationOwned(mutationToken)
        )
          return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The decision was saved, but the conversation could not be refreshed.')
      } catch (error) {
        if (
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
          this.isSessionContextCurrent(workspaceVersion, sessionId) &&
          this.isSessionMutationOwned(mutationToken)
        )
          this.error = error instanceof Error ? error.message : 'Proposal decision failed.'
      } finally {
        if (this.isSessionMutationOwned(mutationToken) && this.decidingApprovalId === approvalId) this.decidingApprovalId = null
        this.endSessionMutation(mutationToken)
      }
    },
    async setSkillPreferences(skillIds: readonly string[]) {
      if (!this.isWorkspaceReady()) return
      const sessionId = this.thread?.session.id
      if (!sessionId) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      try {
        await updateAgentSkillPreferences(fetchFromWindow, this.csrfToken, { skillIds })
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          !this.isSessionContextCurrent(workspaceVersion, sessionId) ||
          !this.isSessionMutationOwned(mutationToken)
        )
          return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'Skill preferences were saved, but the conversation could not be refreshed.')
      } catch (error) {
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          !this.isSessionContextCurrent(workspaceVersion, sessionId) ||
          !this.isSessionMutationOwned(mutationToken)
        )
          return
        await Promise.allSettled([this.refreshThread(), this.reloadSkills()])
        if (
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
          this.isSessionContextCurrent(workspaceVersion, sessionId) &&
          this.isSessionMutationOwned(mutationToken)
        )
          this.error = error instanceof Error ? error.message : 'Skill preferences could not be updated.'
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    async reloadSkills(): Promise<boolean> {
      if (this.workspaceDisposed) return false
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.workspaceOwnerId
      const ownerGeneration = this.ownerGeneration
      const generation = this.skillsLoadGeneration + 1
      this.skillsLoadGeneration = generation
      this.skillsLoadController?.abort()
      const controller = markRaw(new AbortController())
      this.skillsLoadController = controller
      this.skillsLoading = true
      this.skillsLoadError = ''
      this.skillsPartial = true
      try {
        const skills = await listAgentSkills(fetchFromWindow, this.csrfToken, controller.signal)
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          this.skillsLoadGeneration !== generation ||
          this.skillsLoadController !== controller
        )
          return false
        this.skills = markRaw(skills)
        this.skillsPartial = false
        return true
      } catch (error) {
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          this.skillsLoadGeneration !== generation ||
          this.skillsLoadController !== controller
        )
          return false
        if (error instanceof DOMException && error.name === 'AbortError') return false
        this.skillsLoadError = (error instanceof Error ? error.message : 'The skill catalog could not be loaded.').slice(0, 512)
        return false
      } finally {
        if (this.skillsLoadGeneration === generation && this.skillsLoadController === controller) {
          this.skillsLoadController = null
          this.skillsLoading = false
        }
      }
    },
    async removeSession(sessionId: string, onCommitted?: () => void): Promise<boolean> {
      if (!this.isWorkspaceReady()) return false
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return false
      try {
        const workspaceVersion = this.workspaceVersion
        const ownerId = this.workspaceOwnerId
        const ownerGeneration = this.ownerGeneration
        const version = this.beginSessionTransition()
        try {
          await deleteAgentSession(fetchFromWindow, this.csrfToken, sessionId)
        } catch (error) {
          if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && error instanceof AgentApiError && (error.status === 404 || error.status === 410))
            this.clearConversationSelection(sessionId)
          if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) {
            const refreshed = await this.reloadSessions()
            if (!refreshed.accepted && refreshed.current)
              this.error = refreshed.error instanceof Error ? refreshed.error.message : 'History could not be refreshed.'
          }
          if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionTransitionCurrent(version)) return false
          throw error
        }
        if (
          !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) ||
          !this.isSessionTransitionCurrent(version) ||
          !this.isSessionMutationOwned(mutationToken)
        ) return true
        delete this.drafts[sessionId]
        this.clearConversationSelection(sessionId)
        // Let the initiating UI acknowledge this commit before the thread transition invalidates it.
        onCommitted?.()
        const removedDisplayedSession = this.thread?.session.id === sessionId
        if (this.isSessionTransitionCurrent(version) && removedDisplayedSession) {
          this.closeStream()
          if (!this.workspaceDisposed) this.connection = 'idle'
          this.invalidateRefresh()
          this.thread = null
          this.launchPage = null
          try {
            const replacement = await this.newSession('saved', mutationToken)
            if (!replacement && this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration))
              this.error = 'The conversation was deleted, but a new conversation could not be created.'
          } catch (error) {
            if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration))
              this.error = `The conversation was deleted, but a new conversation could not be created. ${error instanceof Error ? error.message : ''}`.trim()
          }
          return true
        }
        const refreshed = await this.reloadSessions()
        if (!refreshed.accepted && refreshed.current && this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) {
          const detail = refreshed.error instanceof Error ? refreshed.error.message : 'Refresh the conversation.'
          this.error = `The conversation was deleted, but history could not be refreshed. ${detail}`.trim()
        }
        return true
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    async clearUnfiledHistory() {
      if (!this.isWorkspaceReady()) return
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      try {
        const workspaceVersion = this.workspaceVersion
        const currentSessionId = this.thread?.session.id
        const ownerId = this.workspaceOwnerId
        const ownerGeneration = this.ownerGeneration
        const clearsCurrentSession = this.thread?.session.folderId === null
        if (clearsCurrentSession) {
          this.closeStream()
          if (!this.workspaceDisposed) this.connection = 'idle'
          this.cancelSessionTransition()
        }
        try {
          await clearUnfiledAgentHistory(fetchFromWindow, this.csrfToken)
        } catch (error) {
          if (
            clearsCurrentSession &&
            currentSessionId &&
            this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
            this.isSessionContextCurrent(workspaceVersion, currentSessionId)
          )
            this.connectCurrentRun()
          throw error
        }
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) return
        const preservedFiledSessions = this.sessions.filter(session => session.folderId !== null)
        const retainedDraftIds = new Set(preservedFiledSessions.map(session => session.id))
        if (this.thread?.session.folderId) retainedDraftIds.add(this.thread.session.id)
        for (const id of Object.keys(this.drafts)) if (!retainedDraftIds.has(id)) delete this.drafts[id]

        this.sessionListVersion += 1
        this.sessionsLoadMoreController?.abort()
        this.sessionsLoadMoreController = null
        this.sessionsReloading = false
        this.sessionsLoadingMore = false
        this.sessionsLoadMoreError = ''
        this.sessions = markRaw(preservedFiledSessions)
        this.sessionsNextCursor = null
        this.error = ''
        const recent = ownerId === null ? null : readAgentChatRecent(ownerId)
        if (recent && !retainedDraftIds.has(recent.sessionId)) this.clearConversationSelection(recent.sessionId)
        if (this.continuitySessionId && !retainedDraftIds.has(this.continuitySessionId)) this.clearConversationSelection(this.continuitySessionId)

        const replacingCurrentSession = this.thread?.session.folderId === null
        let refreshResult: AgentRefreshResult | null = null
        let creationFailed = false
        try {
          if (replacingCurrentSession) {
            this.closeStream()
            if (!this.workspaceDisposed) this.connection = 'idle'
            this.cancelSessionTransition()
            this.invalidateRefresh()
            this.thread = null
            this.launchPage = null
            creationFailed = !(await this.newSession('saved', mutationToken))
          } else {
            refreshResult = await this.reloadSessions()
          }
        } catch (error) {
          if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration))
            this.error = `${
              replacingCurrentSession && !this.thread
                ? 'Unfiled conversations were cleared, but a new conversation could not be created.'
                : 'Unfiled conversations were cleared, but history could not be refreshed.'
            } ${error instanceof Error ? error.message : ''}`.trim()
        }
        if (refreshResult && !refreshResult.accepted && refreshResult.current && this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) {
          const detail = refreshResult.error instanceof Error ? refreshResult.error.message : 'Refresh the conversation.'
          this.error = `${
            replacingCurrentSession && !this.thread
              ? 'Unfiled conversations were cleared, but a new conversation could not be created.'
              : 'Unfiled conversations were cleared, but history could not be refreshed.'
          } ${detail}`.trim()
        } else if (creationFailed && this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) {
          this.error = 'Unfiled conversations were cleared, but a new conversation could not be created.'
        }

        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) return
        const loadedIds = new Set(this.sessions.map(session => session.id))
        const preservedMissingSessions = preservedFiledSessions.filter(session => !loadedIds.has(session.id))
        if (preservedMissingSessions.length > 0) this.sessions = markRaw([...this.sessions, ...preservedMissingSessions])
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    connectCurrentRun() {
      const run = this.thread?.session.currentRun
      if (run?.canCancel) {
        this.connect(run.id, run.eventSequence)
      } else {
        this.closeStream()
        if (!this.workspaceDisposed) this.connection = 'idle'
      }
    },
    isConnectionCurrent(generation: number, workspaceVersion: number, sessionId: string, runId: string) {
      return (
        this.connectionGeneration === generation && this.isSessionContextCurrent(workspaceVersion, sessionId) && this.thread?.session.currentRun?.id === runId
      )
    },
    connect(runId: string, _after: number) {
      const workspaceVersion = this.workspaceVersion
      const sessionId = this.thread?.session.id
      const run = this.thread?.session.currentRun
      if (!sessionId || !run?.canCancel || run.id !== runId || !this.isWorkspaceCurrent(workspaceVersion)) return
      this.networkPaused = false
      this.listenForVisibility()
      if (document.visibilityState === 'hidden') {
        this.pauseNetwork()
        return
      }
      this.closeStream()
      const generation = this.connectionGeneration + 1
      this.connectionGeneration = generation
      this.eventSequence = run.eventSequence
      this.connection = 'connecting'
      this.reconnectAttempt = 0
      let terminalObserved = false
      let streamFailed = false
      this.source = markRaw(
        subscribeAgentRun(runId, run.eventSequence, {
          event: (type: AgentEventType, sequence: number) => {
            if (streamFailed || !this.isConnectionCurrent(generation, workspaceVersion, sessionId, runId)) return
            const terminal = terminalEvents.has(type)
            this.connection = terminal ? 'reconnecting' : 'connected'
            this.reconnectAttempt = 0
            this.eventSequence = Math.max(this.eventSequence, sequence)
            if (terminal) {
              terminalObserved = true
              if (this.watchdogTimer !== null) window.clearTimeout(this.watchdogTimer)
              this.watchdogTimer = null
              this.source?.close()
              this.source = null
              this.scheduleRefresh(true, 50, runId, generation)
            } else {
              this.armInactivityWatchdog(runId, generation)
              this.scheduleRefresh(false, 50, runId, generation)
            }
          },
          error: () => {
            if (terminalObserved || !this.isConnectionCurrent(generation, workspaceVersion, sessionId, runId)) return
            if (streamFailed) return
            streamFailed = true
            // A failed EventSource can be permanently CLOSED after an idle
            // proxy/auth disconnect. Re-authorize via GET before replacing it.
            this.source?.close()
            this.source = null
            this.connection = 'reconnecting'
            if (this.watchdogTimer !== null) window.clearTimeout(this.watchdogTimer)
            this.watchdogTimer = null
            const delay = Math.min(SSE_RETRY_BASE_MS * 2 ** this.reconnectAttempt, SSE_RETRY_MAX_MS)
            this.reconnectAttempt += 1
            this.scheduleRefresh(false, delay, runId, generation)
          }
        })
      )
      this.armInactivityWatchdog(runId, generation)
    },
    armInactivityWatchdog(runId: string, generation?: number) {
      const connectionGeneration = generation ?? this.connectionGeneration
      if (this.watchdogTimer !== null) window.clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
      if (document.visibilityState === 'hidden' || this.workspaceDisposed) return
      this.watchdogTimer = window.setTimeout(() => {
        this.watchdogTimer = null
        this.scheduleRefresh(false, 0, runId, connectionGeneration)
      }, SSE_INACTIVITY_MS)
    },
    scheduleRefresh(terminal: boolean, delay = 50, observedRunId?: string, generation?: number) {
      const connectionGeneration = generation ?? this.connectionGeneration
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
      this.refreshTimer = null
      if (document.visibilityState === 'hidden' || this.workspaceDisposed) return
      const workspaceVersion = this.workspaceVersion
      const sessionId = this.thread?.session.id
      if (!sessionId) return
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null
        if (!this.isSessionContextCurrent(workspaceVersion, sessionId) || (observedRunId !== undefined && this.connectionGeneration !== connectionGeneration))
          return
        void this.runScheduledRefresh(terminal, observedRunId, connectionGeneration, workspaceVersion, sessionId)
      }, delay)
    },
    async runScheduledRefresh(terminal: boolean, observedRunId: string | undefined, generation: number, workspaceVersion: number, sessionId: string) {
      try {
        const refreshed = await this.refreshThread()
        if (!refreshed.accepted || !refreshed.current || !this.isSessionContextCurrent(workspaceVersion, sessionId)) {
          if (!refreshed.current || refreshed.accepted) return
          const refreshError = refreshed.error
          if (refreshError instanceof DOMException && refreshError.name === 'AbortError') return
          const retryable = refreshError instanceof AgentApiError ? refreshError.retryable : refreshError instanceof TypeError
          if (!retryable) {
            this.error = (refreshError instanceof Error ? refreshError.message : 'The conversation refresh response was invalid.').slice(0, 512)
            this.closeStream()
            return
          }
          this.connection = 'reconnecting'
          const delay = Math.min(SSE_RETRY_BASE_MS * 2 ** this.reconnectAttempt, SSE_RETRY_MAX_MS)
          this.reconnectAttempt += 1
          this.scheduleRefresh(terminal, delay, observedRunId, generation)
          return
        }
        const currentRun = this.thread?.session.currentRun
        if (observedRunId !== undefined && currentRun?.canCancel && currentRun.id !== observedRunId) {
          this.connectCurrentRun()
          if (terminal) {
            const listed = await this.reloadSessions()
            if (!listed.accepted || !listed.current || !this.isSessionContextCurrent(workspaceVersion, sessionId)) return
          }
          return
        }
        if (terminal || !currentRun?.canCancel) {
          const listed = await this.reloadSessions()
          if (!listed.accepted || !listed.current || !this.isSessionContextCurrent(workspaceVersion, sessionId)) {
            if (listed.current && this.isSessionContextCurrent(workspaceVersion, sessionId)) {
              this.connection = 'reconnecting'
              const delay = Math.min(SSE_RETRY_BASE_MS * 2 ** this.reconnectAttempt, SSE_RETRY_MAX_MS)
              this.reconnectAttempt += 1
              this.scheduleRefresh(terminal, delay, observedRunId, generation)
            }
            return
          }
          if (terminal && currentRun?.canCancel) {
            const delay = Math.min(SSE_RETRY_BASE_MS * 2 ** this.reconnectAttempt, SSE_RETRY_MAX_MS)
            this.reconnectAttempt += 1
            this.scheduleRefresh(true, delay, observedRunId, generation)
          } else if (terminal && this.thread?.goal?.status === 'active') {
            const delay = Math.min(SSE_RETRY_BASE_MS * 2 ** this.reconnectAttempt, SSE_RETRY_MAX_MS)
            this.reconnectAttempt += 1
            this.scheduleRefresh(true, delay, observedRunId, generation)
          } else {
            this.closeStream()
            if (!this.workspaceDisposed) this.connection = 'idle'
          }
          return
        }
        if (!this.source) {
          this.connectCurrentRun()
          return
        }
        this.reconnectAttempt = 0
        this.armInactivityWatchdog(currentRun.id, generation)
      } catch (error) {
        if (!this.isSessionContextCurrent(workspaceVersion, sessionId) || (observedRunId !== undefined && this.connectionGeneration !== generation)) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        const retryable = error instanceof AgentApiError ? error.retryable : error instanceof TypeError
        if (!retryable) {
          this.error = (error instanceof Error ? error.message : 'The conversation refresh response was invalid.').slice(0, 512)
          this.closeStream()
          return
        }
        this.connection = 'reconnecting'
        const delay = Math.min(SSE_RETRY_BASE_MS * 2 ** this.reconnectAttempt, SSE_RETRY_MAX_MS)
        this.reconnectAttempt += 1
        this.scheduleRefresh(terminal, delay, observedRunId, generation)
      }
    },
    pauseNetwork() {
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
      if (this.watchdogTimer !== null) window.clearTimeout(this.watchdogTimer)
      this.refreshTimer = null
      this.watchdogTimer = null
      this.invalidateRefresh()
      this.connectionGeneration += 1
      this.source?.close()
      this.source = null
      this.networkPaused = true
      this.connection = this.thread?.session.currentRun?.canCancel ? 'idle' : 'closed'
    },
    handleVisibilityChange() {
      if (this.initializationAdmissionFailure !== null) return
      if (document.visibilityState === 'hidden') {
        this.pauseNetwork()
        return
      }
      const workspaceVersion = this.workspaceVersion
      const sessionId = this.thread?.session.id
      if (!sessionId || !this.isWorkspaceCurrent(workspaceVersion)) return
      // Keep a recent authority read single-flight, but a read stranded across
      // sleep cannot hold the workspace or Send lease indefinitely.
      const expiredRead = this.refreshController !== null && this.refreshDeadlineAt !== null && Date.now() >= this.refreshDeadlineAt
      if (expiredRead) this.invalidateRefresh()
      if (this.loading || (this.sessionMutationBusy && !expiredRead) || this.refreshController !== null) return
      const observedRunId = this.thread?.session.currentRun?.id
      this.networkPaused = false
      this.connection = observedRunId ? 'reconnecting' : 'idle'
      void this.refreshThread().then(refreshed => {
        if (refreshed.accepted && refreshed.current && this.isSessionContextCurrent(workspaceVersion, sessionId)) {
          this.connectCurrentRun()
          return
        }
        if (!refreshed.current || refreshed.accepted || !this.isSessionContextCurrent(workspaceVersion, sessionId)) return
        const refreshError = refreshed.error
        if (refreshError instanceof DOMException && refreshError.name === 'AbortError') return
        const retryable = refreshError instanceof AgentApiError ? refreshError.retryable : refreshError instanceof TypeError
        if (!retryable) {
          this.error = (refreshError instanceof Error ? refreshError.message : 'The conversation refresh response was invalid.').slice(0, 512)
          this.closeStream()
          return
        }
        this.connection = 'reconnecting'
        this.scheduleRefresh(false, SSE_RETRY_BASE_MS, observedRunId)
      })
    },
    closeStream() {
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
      if (this.watchdogTimer !== null) window.clearTimeout(this.watchdogTimer)
      this.refreshTimer = null
      this.watchdogTimer = null
      this.connectionGeneration += 1
      this.source?.close()
      this.source = null
      this.connection = 'closed'
    }
  }
})
