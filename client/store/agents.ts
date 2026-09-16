import { AgentKnowledgeContextSchema } from '../../shared/agents/knowledge-context.ts'
import { emptyAgentDraft, type AgentDraft } from '../helpers/agent-draft.ts'
import { clearAgentChatPin, isAgentSessionId, readAgentChatPin, writeAgentChatPin } from '../helpers/agent-chat-pin.ts'
import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type {
  AgentConversationFolderView,
  AgentCurrentPageHint,
  AgentEventType,
  AgentProviderProfileView,
  AgentThreadState
} from '../../shared/agents/contracts.ts'
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
  listAgentProfiles,
  listAgentSessions,
  listAgentSkills,
  moveAgentSessionToFolder,
  pauseAgentGoal,
  renameAgentConversationFolder,
  renewAgentGoalBudget,
  resumeAgentGoal,
  subscribeAgentRun,
  submitAgentMessage,
  updateAgentProfile,
  updateAgentSession,
  updateAgentSkillPreferences,
  type AgentSessionSummary,
  type CreatedAgentThread,
  type VisibleAgentSkill
} from '../helpers/agents-api.ts'

const terminalEvents = new Set<AgentEventType>(['run.completed', 'run.partial', 'run.failed', 'run.cancelled', 'run.recovery_required'])
const fetchFromWindow: typeof fetch = (input, init) => window.fetch(input, init)
const SSE_INACTIVITY_MS = 15_000
const SSE_RETRY_BASE_MS = 1_000
const SSE_RETRY_MAX_MS = 30_000
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
    profiles: [] as AgentProviderProfileView[],
    profilesLoadGeneration: 0,
    profilesLoadController: null as AbortController | null,
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
    eventSequence: 0,
    source: null as EventSource | null,
    refreshTimer: null as number | null,
    watchdogTimer: null as number | null,
    refreshGeneration: 0,
    refreshSessionId: null as string | null,
    initializationGeneration: 0,
    initializationController: null as AbortController | null,
    refreshController: null as AbortController | null,
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
    pinnedSessionId: null as string | null,
    pinStorageAvailable: true,
    pinOwnerId: null as number | null
  }),
  getters: {
    sessionMutationBusy: state => state.sessionMutationToken !== null,
    canPinCurrentChat: state =>
      !state.workspaceDisposed &&
      state.initializedWorkspaceVersion !== null &&
      state.initializedWorkspaceVersion === state.workspaceVersion &&
      !state.loading &&
      !state.networkPaused &&
      state.sessionTransitionController === null &&
      state.sessionMutationToken === null &&
      state.thread !== null &&
      isAgentSessionId(state.thread.session.id) &&
      state.pinOwnerId !== null &&
      Number.isSafeInteger(state.pinOwnerId) &&
      state.pinOwnerId > 0
  },
  actions: {
    async initialize(csrfToken: string, options: AgentStoreInitializeOptions): Promise<boolean> {
      const ownerChanged = this.pinOwnerId !== null && this.pinOwnerId !== options.ownerId
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
        this.pinnedSessionId = null
        clearAgentChatPin()
      }

      const previousThread = this.thread
      const requestedResumeId = isAgentSessionId(options.resumeSessionId) ? options.resumeSessionId : null
      const retainOpenWorkspace =
        !ownerChanged &&
        previousThread !== null &&
        (requestedResumeId === null || requestedResumeId === previousThread.session.id)
      this.initializationGeneration += 1
      this.initializationController?.abort()
      const initializationGeneration = this.initializationGeneration
      const initializationController = markRaw(new AbortController())
      this.initializationController = initializationController

      this.pinOwnerId = options.ownerId
      this.cancelSessionTransition()
      this.networkPaused = true
      this.profilesLoadGeneration += 1
      this.profilesLoadController?.abort()
      this.profilesLoadController = null
      this.skillsLoadGeneration += 1
      this.skillsLoadController?.abort()
      this.skillsLoadController = null
      this.closeStream()
      this.profiles = []
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
      const previousPinnedSessionId = this.pinnedSessionId
      const pin = readAgentChatPin(options.ownerId)
      this.pinStorageAvailable = pin.available
      const pinnedSessionId = pin.sessionId ?? (!pin.available ? previousPinnedSessionId : null)
      this.pinnedSessionId = pinnedSessionId
      this.listenForVisibility()
      void this.reloadSkills()
      const allowCreate = options.allowCreate ?? true
      let initialized = false
      const isCurrent = (): boolean =>
        this.isOwnerContextCurrent(workspaceVersion, options.ownerId, ownerGeneration) &&
        this.initializationGeneration === initializationGeneration &&
        this.initializationController === initializationController
      try {
        const pathMatch = this.routeSync ? /^\/sessions\/([^/]+)$/.exec(window.location.pathname) : null
        const [sessionPage, folders, profiles] = await Promise.all([
          listAgentSessions(fetchFromWindow, csrfToken, { signal: initializationController.signal }),
          listAgentConversationFolders(fetchFromWindow, csrfToken, initializationController.signal),
          listAgentProfiles(fetchFromWindow, csrfToken, initializationController.signal)
        ])
        if (!isCurrent()) return false
        this.profiles = markRaw(profiles)
        if (this.sessionListVersion === sessionListVersion) {
          this.sessions = markRaw(sessionPage.sessions)
          this.sessionsNextCursor = sessionPage.nextCursor
        }
        if (this.folderReloadGeneration === folderReloadGeneration) this.folders = markRaw(folders)

        if (retainOpenWorkspace && this.thread === previousThread) {
          initialized = await this.openSession(previousThread.session.id, { preservePin: true })
        } else {
          const routeSessionId = pathMatch?.[1]
          if (routeSessionId && isAgentSessionId(routeSessionId)) {
            initialized = await this.openSession(routeSessionId)
          } else {
            const resumeSessionId = isAgentSessionId(options.resumeSessionId) ? options.resumeSessionId : null
            let resumeWasAbsent = false
            if (resumeSessionId) {
              try {
                initialized = await this.openSession(resumeSessionId, { preservePin: true })
              } catch (error) {
                if (!(error instanceof AgentApiError) || (error.status !== 404 && error.status !== 410)) throw error
                resumeWasAbsent = true
                if (pinnedSessionId === resumeSessionId) this.clearPinnedState()
              }
            }
            if (!initialized && isCurrent() && (!resumeWasAbsent || pinnedSessionId !== resumeSessionId) && pinnedSessionId) {
              try {
                initialized = await this.openSession(pinnedSessionId, { preservePin: true })
              } catch (error) {
                if (!(error instanceof AgentApiError) || (error.status !== 404 && error.status !== 410)) throw error
                this.clearPinnedState()
              }
            }
            if (!initialized && allowCreate && isCurrent()) initialized = await this.newSession('saved', undefined, true)
          }
        }
        if (initialized && isCurrent()) this.initializedWorkspaceVersion = workspaceVersion
        return initialized
      } catch (error) {
        if (isCurrent()) {
          if (error instanceof AgentApiError && error.status === 401) this.destroyWorkspace()
          else this.error = error instanceof Error ? error.message : 'Agent session failed to load.'
        }
        return false
      } finally {
        const stillCurrent = isCurrent()
        if (this.initializationController === initializationController) this.initializationController = null
        if (stillCurrent) {
          this.loading = false
          if (initialized) this.initializedWorkspaceVersion = workspaceVersion
        }
      }
    },
    clearPinnedState() {
      this.pinnedSessionId = null
      this.pinStorageAvailable = clearAgentChatPin()
    },
    setCurrentChatPinned(value: boolean): void {
      if (!this.canPinCurrentChat) return
      const sessionId = this.thread?.session.id
      const ownerId = this.pinOwnerId
      if (!value) {
        this.clearPinnedState()
        return
      }
      if (!sessionId || ownerId === null) return
      this.pinnedSessionId = sessionId
      this.pinStorageAvailable = writeAgentChatPin(ownerId, sessionId)
    },
    setCurrentPage(page: AgentCurrentPageHint | null) {
      this.contextPage = page
    },
    isWorkspaceCurrent(version: number) {
      return !this.workspaceDisposed && this.workspaceVersion === version
    },
    isOwnerContextCurrent(workspaceVersion: number, ownerId: number | null, ownerGeneration: number): boolean {
      return this.isWorkspaceCurrent(workspaceVersion) && this.pinOwnerId === ownerId && this.ownerGeneration === ownerGeneration
    },
    isWorkspaceMutationReady(): boolean {
      return (
        !this.workspaceDisposed &&
        !this.loading &&
        !this.networkPaused &&
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
        this.pinOwnerId === ownerId &&
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
      this.visibilityListening = true
    },
    beginSessionTransition(kind: 'read' | 'mutation' = 'mutation') {
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
      this.invalidateSessionMutation()
      this.workspaceVersion += 1
      this.workspaceDisposed = true
      this.networkPaused = true
      this.profilesLoadGeneration += 1
      this.profilesLoadController?.abort()
      this.profilesLoadController = null
      this.skillsLoadGeneration += 1
      this.skillsLoadController?.abort()
      this.skillsLoadController = null
      this.profiles = []
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
      if (this.visibilityListening) document.removeEventListener('visibilitychange', this.handleVisibilityChange)
      this.visibilityListening = false
    },
    /**
     * Verified identity loss is different from a component unmount: no
     * plaintext thread or draft may remain available to a later owner.
     */
    destroyWorkspace() {
      this.closeWorkspace()
      this.ownerGeneration += 1
      this.pinOwnerId = null
      this.thread = null
      this.drafts = {}
      this.sessions = []
      this.sessionsNextCursor = null
      this.folders = []
      this.launchPage = null
      this.contextPage = null
      this.error = ''
      this.pinnedSessionId = null
      clearAgentChatPin()
    },
    setDraft(sessionId: string, text: string) {
      if (!sessionId) return
      this.updateDraft(sessionId, { text })
    },
    updateDraft(sessionId: string, patch: Partial<AgentDraft>) {
      if (!sessionId) return
      this.drafts[sessionId] = { ...(this.drafts[sessionId] ?? emptyAgentDraft()), ...patch }
    },
    async newSession(retention: 'temporary' | 'saved', mutationOwner?: number, allowWhileInitializing = false): Promise<boolean> {
      if (
        this.workspaceDisposed ||
        (!this.isWorkspaceReady() && !(allowWhileInitializing && this.loading && this.initializedWorkspaceVersion === null))
      )
        return false
      const acquiredHere = mutationOwner === undefined
      const mutationToken = mutationOwner === undefined ? this.beginSessionMutation() : this.isSessionMutationOwned(mutationOwner) ? mutationOwner : null
      if (mutationToken === null) return false
      try {
        const workspaceVersion = this.workspaceVersion
        const ownerId = this.pinOwnerId
        const ownerGeneration = this.ownerGeneration
        const version = this.beginSessionTransition()
        const previous = this.thread
        const disposableSessionId =
          previous && previous.messages.length === 0 && !previous.session.currentRun && !previous.goal && !previous.session.folderId
            ? previous.session.id
            : null
        // Keep the current conversation and its draft intact until creation succeeds.
        const created = await createAgentThread(fetchFromWindow, this.csrfToken, { retention, providerProfileId: null })
        const selectsCreated =
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionTransitionCurrent(version)
        if (!selectsCreated) return false
        this.error = ''
        this.closeStream()
        this.invalidateRefresh()
        this.applyCreatedThread(created)
        this.clearPinnedState()
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
      const launch = created.launchPage
      this.launchPage =
        launch?.pageId && launch.locale && launch.path && launch.observedUpdatedAt
          ? { id: launch.pageId, locale: launch.locale, path: launch.path, observedUpdatedAt: launch.observedUpdatedAt }
          : null
      // A successful create is an authoritative read for the new resource.
      this.initializedWorkspaceVersion = this.workspaceVersion
      this.networkPaused = false
      this.connectCurrentRun()
    },
    async openSession(sessionId: string, options: { readonly preservePin?: boolean } = {}): Promise<boolean> {
      if (this.workspaceDisposed || !isAgentSessionId(sessionId) || this.sessionMutationToken !== null) return false
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.pinOwnerId
      const ownerGeneration = this.ownerGeneration
      const { version, controller } = this.beginSessionReadTransition()
      const isCurrent = (): boolean =>
        this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionTransitionCurrent(version)
      try {
        const candidate = await getAgentThread(fetchFromWindow, this.csrfToken, sessionId, controller.signal)
        if (!isCurrent()) return false
        this.sessionTransitionController = null
        this.sessionTransitionKind = null
        this.closeStream()
        this.invalidateRefresh()
        this.thread = markRaw(candidate)
        this.launchPage = null
        if (!options.preservePin && this.pinnedSessionId && this.pinnedSessionId !== sessionId) this.clearPinnedState()
        if (this.routeSync) window.history.replaceState(null, '', `/sessions/${sessionId}`)
        // The candidate was just authorized by a fresh thread read.
        this.initializedWorkspaceVersion = workspaceVersion
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
      this.refreshController?.abort()
      this.refreshController = null
    },
    async refreshThread(): Promise<AgentRefreshResult> {
      const workspaceVersion = this.workspaceVersion
      const sessionId = this.thread?.session.id
      const ownerId = this.pinOwnerId
      const ownerGeneration = this.ownerGeneration
      if (!sessionId || !this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) return refreshResult(false, false)
      if (document.visibilityState === 'hidden') return refreshResult(false, true)
      const generation = this.refreshGeneration + 1
      this.refreshGeneration = generation
      this.refreshSessionId = sessionId
      this.refreshController?.abort()
      const controller = markRaw(new AbortController())
      this.refreshController = controller
      const isCurrent = (): boolean =>
        this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
        this.refreshSessionId === sessionId &&
        this.refreshGeneration === generation &&
        this.refreshController === controller
      try {
        const refreshed = await getAgentThread(fetchFromWindow, this.csrfToken, sessionId, controller.signal)
        if (!isCurrent()) return refreshResult(false, false)
        this.thread = markRaw(refreshed)
        this.initializedWorkspaceVersion = workspaceVersion
        this.networkPaused = false
        return refreshResult(true, true)
      } catch (error) {
        const current =
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
          this.refreshSessionId === sessionId &&
          this.refreshGeneration === generation
        if (current) {
          this.initializedWorkspaceVersion = null
          this.networkPaused = true
          if (error instanceof AgentApiError && error.status === 401) {
            this.destroyWorkspace()
            return refreshResult(false, false, error)
          }
        }
        return refreshResult(false, current, error)
      } finally {
        if (this.refreshGeneration === generation && this.refreshController === controller) this.refreshController = null
      }
    },
    async reloadSessions(): Promise<AgentRefreshResult> {
      if (this.workspaceDisposed) return refreshResult(false, false)
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.pinOwnerId
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
      const ownerId = this.pinOwnerId
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
      const ownerId = this.pinOwnerId
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
      const ownerId = this.pinOwnerId
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
      const ownerId = this.pinOwnerId
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
        const ownerId = this.pinOwnerId
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
      const ownerId = this.pinOwnerId
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
    projectCommittedSessionMutation(
      workspaceVersion: number,
      sessionId: string,
      projected: AgentThreadState,
      ownerId: number | null,
      ownerGeneration: number
    ) {
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
      const ownerId = this.pinOwnerId
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
      const ownerId = this.pinOwnerId
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
    async send(content: string, invokedSkillVersionIds: readonly string[] = [], mode: 'message' | 'goal' = 'message'): Promise<boolean> {
      if (!this.isWorkspaceReady()) return false
      const thread = this.thread
      const trimmed = content.trim()
      const draftSnapshot = JSON.parse(JSON.stringify(this.drafts[thread?.session.id ?? ''] ?? emptyAgentDraft())) as AgentDraft
      const currentPage = draftSnapshot.includeCurrentPage ? (this.contextPage ?? this.launchPage) : null
      if (
        !thread ||
        !trimmed ||
        this.sending ||
        thread.session.currentRun?.canCancel ||
        (thread.goal && ['active', 'paused', 'blocked'].includes(thread.goal.status))
      )
        return false
      const workspaceVersion = this.workspaceVersion
      const sessionId = thread.session.id
      const ownerId = this.pinOwnerId
      const ownerGeneration = this.ownerGeneration
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return false
      this.sending = true
      this.error = ''
      try {
        try {
          const request = {
            clientRequestId: crypto.randomUUID(),
            expectedSessionVersion: thread.session.version,
            profileResolutionToken: thread.session.profileResolutionToken,
            ...(invokedSkillVersionIds.length > 0 ? { invokedSkillVersionIds } : {}),
            ...(currentPage ? { currentPage } : {}),
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
              objective: trimmed
            })
          } else {
            await submitAgentMessage(fetchFromWindow, this.csrfToken, sessionId, {
              ...request,
              content: trimmed
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
      if (!this.isWorkspaceReady()) return
      const goal = this.thread?.goal
      if (goal?.status === 'active' || goal?.status === 'blocked') {
        await this.pauseGoal()
        return
      }
      const run = this.thread?.session.currentRun
      if (!run?.canCancel || this.stoppingRunId === run.id) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.pinOwnerId
      const ownerGeneration = this.ownerGeneration
      const sessionId = this.thread!.session.id
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      this.stoppingRunId = run.id
      this.error = ''
      try {
        await cancelAgentRun(fetchFromWindow, this.csrfToken, run.id)
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionContextCurrent(workspaceVersion, sessionId) || !this.isSessionMutationOwned(mutationToken)) return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The run was stopped, but the conversation could not be refreshed.')
      } catch (error) {
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionContextCurrent(workspaceVersion, sessionId) && this.isSessionMutationOwned(mutationToken))
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
      const ownerId = this.pinOwnerId
      const ownerGeneration = this.ownerGeneration
      const sessionId = thread.session.id
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      this.goalBusy = true
      this.error = ''
      try {
        await pauseAgentGoal(fetchFromWindow, this.csrfToken, goal.id, { expectedVersion: goal.version })
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionContextCurrent(workspaceVersion, sessionId) || !this.isSessionMutationOwned(mutationToken)) return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The goal was paused, but the conversation could not be refreshed.')
      } catch (error) {
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionContextCurrent(workspaceVersion, sessionId) && this.isSessionMutationOwned(mutationToken))
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
      const ownerId = this.pinOwnerId
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
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionContextCurrent(workspaceVersion, sessionId) || !this.isSessionMutationOwned(mutationToken)) return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The goal was resumed, but the conversation could not be refreshed.')
      } catch (error) {
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionContextCurrent(workspaceVersion, sessionId) && this.isSessionMutationOwned(mutationToken))
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
      const ownerId = this.pinOwnerId
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
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionContextCurrent(workspaceVersion, sessionId) || !this.isSessionMutationOwned(mutationToken))
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
      const ownerId = this.pinOwnerId
      const ownerGeneration = this.ownerGeneration
      const sessionId = thread.session.id
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      this.goalBusy = true
      this.error = ''
      try {
        await cancelAgentGoal(fetchFromWindow, this.csrfToken, goal.id, { expectedVersion: goal.version })
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionContextCurrent(workspaceVersion, sessionId) || !this.isSessionMutationOwned(mutationToken)) return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The goal was cancelled, but the conversation could not be refreshed.')
      } catch (error) {
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionContextCurrent(workspaceVersion, sessionId) && this.isSessionMutationOwned(mutationToken))
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
      if (!sessionId || !proposal || proposal.approval?.id !== approvalId || proposal.status !== 'pending' || proposal.approval.status !== 'pending' || this.decidingApprovalId) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.pinOwnerId
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
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionContextCurrent(workspaceVersion, sessionId) || !this.isSessionMutationOwned(mutationToken)) return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The decision was saved, but the conversation could not be refreshed.')
      } catch (error) {
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionContextCurrent(workspaceVersion, sessionId) && this.isSessionMutationOwned(mutationToken))
          this.error = error instanceof Error ? error.message : 'Proposal decision failed.'
      } finally {
        if (this.isSessionMutationOwned(mutationToken) && this.decidingApprovalId === approvalId) this.decidingApprovalId = null
        this.endSessionMutation(mutationToken)
      }
    },
    async setProfile(providerProfileId: string | null) {
      if (!this.isWorkspaceReady()) return
      const thread = this.thread
      if (!thread || thread.session.currentRun?.canCancel || (thread.goal && ['active', 'paused', 'blocked'].includes(thread.goal.status))) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.pinOwnerId
      const ownerGeneration = this.ownerGeneration
      const sessionId = thread.session.id
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      try {
        const projected = await updateAgentProfile(fetchFromWindow, this.csrfToken, sessionId, {
          expectedSessionVersion: thread.session.version,
          providerProfileId
        })
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionContextCurrent(workspaceVersion, sessionId) && this.isSessionMutationOwned(mutationToken))
          this.thread = markRaw(projected)
        return projected
      } catch (error) {
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionContextCurrent(workspaceVersion, sessionId) || !this.isSessionMutationOwned(mutationToken)) return
        await Promise.allSettled([this.refreshThread(), this.reloadProfiles()])
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionContextCurrent(workspaceVersion, sessionId) && this.isSessionMutationOwned(mutationToken))
          this.error = error instanceof Error ? error.message : 'Provider selection changed concurrently.'
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    async setSkillPreferences(skillIds: readonly string[]) {
      if (!this.isWorkspaceReady()) return
      const sessionId = this.thread?.session.id
      if (!sessionId) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.pinOwnerId
      const ownerGeneration = this.ownerGeneration
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return
      try {
        await updateAgentSkillPreferences(fetchFromWindow, this.csrfToken, { skillIds })
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionContextCurrent(workspaceVersion, sessionId) || !this.isSessionMutationOwned(mutationToken)) return
        await this.refreshCommittedMutation(workspaceVersion, sessionId, 'Skill preferences were saved, but the conversation could not be refreshed.')
      } catch (error) {
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionContextCurrent(workspaceVersion, sessionId) || !this.isSessionMutationOwned(mutationToken)) return
        await Promise.allSettled([this.refreshThread(), this.reloadSkills()])
        if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) && this.isSessionContextCurrent(workspaceVersion, sessionId) && this.isSessionMutationOwned(mutationToken))
          this.error = error instanceof Error ? error.message : 'Skill preferences could not be updated.'
      } finally {
        this.endSessionMutation(mutationToken)
      }
    },
    async reloadProfiles() {
      if (this.workspaceDisposed) return
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.pinOwnerId
      const ownerGeneration = this.ownerGeneration
      const generation = this.profilesLoadGeneration + 1
      this.profilesLoadGeneration = generation
      this.profilesLoadController?.abort()
      const controller = markRaw(new AbortController())
      this.profilesLoadController = controller
      try {
        const profiles = await listAgentProfiles(fetchFromWindow, this.csrfToken, controller.signal)
        if (
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) &&
          this.profilesLoadGeneration === generation &&
          this.profilesLoadController === controller
        )
          this.profiles = markRaw(profiles)
      } finally {
        if (this.profilesLoadGeneration === generation && this.profilesLoadController === controller) this.profilesLoadController = null
      }
    },
    async reloadSkills(): Promise<boolean> {
      if (this.workspaceDisposed) return false
      const workspaceVersion = this.workspaceVersion
      const ownerId = this.pinOwnerId
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
    async removeSession(sessionId: string): Promise<boolean> {
      if (!this.isWorkspaceReady()) return false
      const mutationToken = this.beginSessionMutation()
      if (mutationToken === null) return false
      try {
        const workspaceVersion = this.workspaceVersion
        const ownerId = this.pinOwnerId
        const ownerGeneration = this.ownerGeneration
        const version = this.beginSessionTransition()
        try {
          await deleteAgentSession(fetchFromWindow, this.csrfToken, sessionId)
          delete this.drafts[sessionId]
        } catch (error) {
          if (this.pinnedSessionId === sessionId && error instanceof AgentApiError && (error.status === 404 || error.status === 410)) this.clearPinnedState()
          if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) {
            const refreshed = await this.reloadSessions()
            if (!refreshed.accepted && refreshed.current) this.error = refreshed.error instanceof Error ? refreshed.error.message : 'History could not be refreshed.'
          }
          if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration) || !this.isSessionTransitionCurrent(version)) return false
          throw error
        }
        if (!this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)) return true
        if (this.pinnedSessionId === sessionId) this.clearPinnedState()
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
        const ownerId = this.pinOwnerId
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
        if (
          this.pinnedSessionId &&
          ((clearsCurrentSession && currentSessionId === this.pinnedSessionId) ||
            this.sessions.some(session => session.id === this.pinnedSessionId && session.folderId === null))
        )
          this.clearPinnedState()

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
            if (this.profiles.length > 0) creationFailed = !(await this.newSession('saved', mutationToken))
            else refreshResult = await this.reloadSessions()
          } else {
            refreshResult = await this.reloadSessions()
          }
        } catch (error) {
          if (this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration))
            this.error = `${
              replacingCurrentSession && this.profiles.length > 0 && !this.thread
                ? 'Unfiled conversations were cleared, but a new conversation could not be created.'
                : 'Unfiled conversations were cleared, but history could not be refreshed.'
            } ${error instanceof Error ? error.message : ''}`.trim()
        }
        if (
          refreshResult &&
          !refreshResult.accepted &&
          refreshResult.current &&
          this.isOwnerContextCurrent(workspaceVersion, ownerId, ownerGeneration)
        ) {
          const detail = refreshResult.error instanceof Error ? refreshResult.error.message : 'Refresh the conversation.'
          this.error = `${
            replacingCurrentSession && this.profiles.length > 0 && !this.thread
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
      this.source = markRaw(
        subscribeAgentRun(runId, run.eventSequence, {
          event: (type: AgentEventType, sequence: number) => {
            if (!this.isConnectionCurrent(generation, workspaceVersion, sessionId, runId)) return
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
      if (document.visibilityState === 'hidden') {
        this.pauseNetwork()
        return
      }
      const workspaceVersion = this.workspaceVersion
      const sessionId = this.thread?.session.id
      if (!sessionId || !this.isWorkspaceCurrent(workspaceVersion)) return
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
