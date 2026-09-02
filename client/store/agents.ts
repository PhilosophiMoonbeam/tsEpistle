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
  resetAgentHistory,
  resumeAgentGoal,
  submitAgentMessage,
  subscribeAgentRun,
  updateAgentProfile,
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
export interface AgentStoreInitializeOptions {
  readonly routeSync?: boolean
  readonly currentPage?: AgentCurrentPageHint | null
  readonly reuseLatest?: boolean
}

export const useAgentsStore = defineStore('agents', {
  state: () => ({
    csrfToken: '',
    sessions: [] as AgentSessionSummary[],
    sessionsNextCursor: null as string | null,
    sessionsLoadingMore: false,
    sessionsLoadMoreError: '',
    sessionsLoadMoreController: null as AbortController | null,
    sessionsReloading: false,
    folders: [] as AgentConversationFolderView[],
    thread: null as AgentThreadState | null,
    skills: [] as VisibleAgentSkill[],
    skillsLoading: false,
    skillsLoadError: '',
    skillsPartial: false,
    skillsLoadGeneration: 0,
    profiles: [] as AgentProviderProfileView[],
    launchPage: null as AgentCurrentPageHint | null,
    contextPage: null as AgentCurrentPageHint | null,
    routeSync: true,
    loading: false,
    sending: false,
    error: '',
    connection: 'idle' as 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed',
    eventSequence: 0,
    source: null as EventSource | null,
    refreshTimer: null as number | null,
    watchdogTimer: null as number | null,
    refreshGeneration: 0,
    refreshSessionId: null as string | null,
    refreshController: null as AbortController | null,
    connectionGeneration: 0,
    reconnectAttempt: 0,
    visibilityListening: false,
    decidingApprovalId: null as string | null,
    goalBusy: false,
    stoppingRunId: null as string | null,
    sessionTransitionVersion: 0,
    sessionTransitionController: null as AbortController | null,
    sessionListVersion: 0,
    workspaceVersion: 0,
    folderReloadGeneration: 0,
    folderReloadController: null as AbortController | null,
    workspaceDisposed: false
  }),
  actions: {
    async initialize(csrfToken: string, options: AgentStoreInitializeOptions = {}) {
      this.cancelSessionTransition()
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
      this.workspaceVersion = workspaceVersion
      this.workspaceDisposed = false
      this.sessionListVersion = sessionListVersion
      this.sessionsLoadMoreController?.abort()
      this.sessionsLoadMoreController = null
      this.sessionsReloading = false
      this.sessionsLoadingMore = false
      this.sessionsLoadMoreError = ''
      this.csrfToken = csrfToken
      this.routeSync = options.routeSync ?? true
      this.contextPage = options.currentPage ?? null
      this.loading = true
      this.error = ''
      this.listenForVisibility()
      void this.reloadSkills()
      try {
        const pathMatch = this.routeSync ? /^\/sessions\/([0-9a-f-]{36})$/i.exec(window.location.pathname) : null
        const [sessionPage, folders, profiles] = await Promise.all([
          listAgentSessions(fetchFromWindow, csrfToken),
          listAgentConversationFolders(fetchFromWindow, csrfToken),
          listAgentProfiles(fetchFromWindow, csrfToken)
        ])
        if (!this.isWorkspaceCurrent(workspaceVersion)) return
        this.profiles = markRaw(profiles)
        if (this.sessionListVersion === sessionListVersion) {
          this.sessions = markRaw(sessionPage.sessions)
          this.sessionsNextCursor = sessionPage.nextCursor
        }
        if (this.folderReloadGeneration === folderReloadGeneration) this.folders = markRaw(folders)
        if (pathMatch?.[1]) {
          await this.openSession(pathMatch[1])
        } else if (!this.routeSync && this.thread) {
          await this.openSession(this.thread.session.id)
        } else if (options.reuseLatest && sessionPage.sessions[0]) {
          await this.openSession(sessionPage.sessions[0].id)
        } else {
          await this.newSession('saved')
        }
      } catch (error) {
        if (this.isWorkspaceCurrent(workspaceVersion)) this.error = error instanceof Error ? error.message : 'Agent session failed to load.'
      } finally {
        if (this.isWorkspaceCurrent(workspaceVersion)) this.loading = false
      }
    },
    setCurrentPage(page: AgentCurrentPageHint | null) {
      this.contextPage = page
    },
    isWorkspaceCurrent(version: number) {
      return !this.workspaceDisposed && this.workspaceVersion === version
    },
    isSessionContextCurrent(version: number, sessionId: string) {
      return this.isWorkspaceCurrent(version) && this.thread?.session.id === sessionId
    },
    listenForVisibility() {
      if (this.visibilityListening) return
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
      this.visibilityListening = true
    },
    beginSessionTransition() {
      const version = this.sessionTransitionVersion + 1
      this.sessionTransitionVersion = version
      this.sessionTransitionController?.abort()
      this.sessionTransitionController = null
      return version
    },
    beginSessionReadTransition() {
      const version = this.beginSessionTransition()
      const controller = markRaw(new AbortController())
      this.sessionTransitionController = controller
      return { version, controller }
    },
    isSessionTransitionCurrent(version: number) {
      return this.sessionTransitionVersion === version
    },
    cancelSessionTransition() {
      this.beginSessionTransition()
    },
    closeWorkspace() {
      this.workspaceVersion += 1
      this.workspaceDisposed = true
      this.profiles = []
      this.skills = []
      this.skillsLoading = false
      this.skillsLoadError = ''
      this.skillsPartial = false
      this.skillsLoadGeneration += 1
      this.loading = false
      this.sending = false
      this.goalBusy = false
      this.stoppingRunId = null
      this.decidingApprovalId = null
      this.cancelSessionTransition()
      this.invalidateRefresh()
      this.invalidateFolderReload()
      this.sessionsLoadMoreController?.abort()
      this.sessionsLoadMoreController = null
      this.sessionsReloading = false
      this.sessionsLoadingMore = false
      this.closeStream()
      if (this.visibilityListening) document.removeEventListener('visibilitychange', this.handleVisibilityChange)
      this.visibilityListening = false
    },
    async newSession(retention: 'temporary' | 'saved') {
      const workspaceVersion = this.workspaceVersion
      const version = this.beginSessionTransition()
      const disposableSessionId = this.thread && this.thread.messages.length === 0 && !this.thread.session.currentRun ? this.thread.session.id : null
      try {
        if (disposableSessionId) {
          await deleteAgentSession(fetchFromWindow, this.csrfToken, disposableSessionId)
          if (!this.isWorkspaceCurrent(workspaceVersion)) return
          if (!this.isSessionTransitionCurrent(version)) {
            await this.reloadSessions()
            return
          }
          if (this.thread?.session.id === disposableSessionId) {
            this.closeStream()
            this.thread = null
            this.launchPage = null
          }
        }
        const created = await createAgentThread(fetchFromWindow, this.csrfToken, { retention, providerProfileId: null })
        if (this.isWorkspaceCurrent(workspaceVersion) && this.isSessionTransitionCurrent(version)) {
          this.closeStream()
          this.applyCreatedThread(created)
          if (this.routeSync) window.history.replaceState(null, '', `/sessions/${created.session.id}`)
        }
        if (this.isWorkspaceCurrent(workspaceVersion)) await this.reloadSessions()
      } catch (error) {
        try {
          if (this.isWorkspaceCurrent(workspaceVersion)) await this.reloadSessions()
        } catch {}
        if (!this.isWorkspaceCurrent(workspaceVersion) || !this.isSessionTransitionCurrent(version)) return
        throw error
      }
    },
    applyCreatedThread(created: CreatedAgentThread) {
      this.thread = markRaw(created)
      const launch = created.launchPage
      this.launchPage =
        launch?.pageId && launch.locale && launch.path && launch.observedUpdatedAt
          ? { id: launch.pageId, locale: launch.locale, path: launch.path, observedUpdatedAt: launch.observedUpdatedAt }
          : null
      this.connectCurrentRun()
    },
    async openSession(sessionId: string): Promise<boolean> {
      const workspaceVersion = this.workspaceVersion
      const { version, controller } = this.beginSessionReadTransition()
      try {
        const candidate = await getAgentThread(fetchFromWindow, this.csrfToken, sessionId, controller.signal)
        if (!this.isWorkspaceCurrent(workspaceVersion) || !this.isSessionTransitionCurrent(version)) return false
        this.sessionTransitionController = null
        this.closeStream()
        this.invalidateRefresh()
        this.thread = markRaw(candidate)
        this.launchPage = null
        if (this.routeSync) window.history.replaceState(null, '', `/sessions/${sessionId}`)
        this.connectCurrentRun()
        return true
      } catch (error) {
        if (!this.isWorkspaceCurrent(workspaceVersion) || !this.isSessionTransitionCurrent(version)) return false
        this.sessionTransitionController = null
        throw error
      }
    },
    invalidateRefresh() {
      this.refreshGeneration += 1
      this.refreshSessionId = null
      this.refreshController?.abort()
      this.refreshController = null
    },
    async refreshThread(): Promise<boolean> {
      const workspaceVersion = this.workspaceVersion
      const sessionId = this.thread?.session.id
      if (!sessionId || !this.isWorkspaceCurrent(workspaceVersion) || document.visibilityState === 'hidden') return false
      const generation = this.refreshGeneration + 1
      this.refreshGeneration = generation
      this.refreshSessionId = sessionId
      this.refreshController?.abort()
      const controller = markRaw(new AbortController())
      this.refreshController = controller
      try {
        const refreshed = await getAgentThread(fetchFromWindow, this.csrfToken, sessionId, controller.signal)
        if (!this.isSessionContextCurrent(workspaceVersion, sessionId) || this.refreshSessionId !== sessionId || this.refreshGeneration !== generation)
          return false
        this.thread = markRaw(refreshed)
        return true
      } finally {
        if (this.refreshGeneration === generation) this.refreshController = null
      }
    },
    async reloadSessions() {
      const workspaceVersion = this.workspaceVersion
      const version = this.sessionListVersion + 1
      this.sessionListVersion = version
      this.sessionsLoadMoreController?.abort()
      this.sessionsLoadMoreController = null
      this.sessionsLoadingMore = false
      this.sessionsLoadMoreError = ''
      this.sessionsReloading = true
      try {
        const page = await listAgentSessions(fetchFromWindow, this.csrfToken)
        if (this.isWorkspaceCurrent(workspaceVersion) && this.sessionListVersion === version) {
          this.sessions = markRaw(page.sessions)
          this.sessionsNextCursor = page.nextCursor
        }
      } finally {
        if (this.sessionListVersion === version) this.sessionsReloading = false
      }
    },
    async loadMoreSessions(): Promise<boolean> {
      const cursor = this.sessionsNextCursor
      if (!cursor || this.loading || this.sessionsLoadingMore || this.sessionsReloading) return false
      const workspaceVersion = this.workspaceVersion
      const version = this.sessionListVersion
      const controller = markRaw(new AbortController())
      this.sessionsLoadMoreController = controller
      this.sessionsLoadingMore = true
      this.sessionsLoadMoreError = ''
      try {
        const page = await listAgentSessions(fetchFromWindow, this.csrfToken, { cursor, signal: controller.signal })
        if (
          !this.isWorkspaceCurrent(workspaceVersion) ||
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
        if (this.isWorkspaceCurrent(workspaceVersion) && this.sessionListVersion === version && this.sessionsLoadMoreController === controller)
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
    async reloadFolders() {
      const workspaceVersion = this.workspaceVersion
      const generation = this.folderReloadGeneration + 1
      this.folderReloadGeneration = generation
      this.folderReloadController?.abort()
      const controller = markRaw(new AbortController())
      this.folderReloadController = controller
      try {
        const folders = await listAgentConversationFolders(fetchFromWindow, this.csrfToken, controller.signal)
        if (this.isWorkspaceCurrent(workspaceVersion) && this.folderReloadGeneration === generation && this.folderReloadController === controller)
          this.folders = markRaw(folders)
      } catch (error) {
        if (!this.isWorkspaceCurrent(workspaceVersion) || this.folderReloadGeneration !== generation || this.folderReloadController !== controller) return
        throw error
      } finally {
        if (this.folderReloadController === controller) this.folderReloadController = null
      }
    },
    async createFolder(name: string) {
      if (this.loading) throw new Error('Conversation folders are still loading. Please wait and try again.')
      const workspaceVersion = this.workspaceVersion
      this.invalidateFolderReload()
      const created = await createAgentConversationFolder(fetchFromWindow, this.csrfToken, name)
      if (this.isWorkspaceCurrent(workspaceVersion)) {
        this.invalidateFolderReload()
        this.folders = markRaw([...this.folders, created])
      }
      return created
    },
    async renameFolder(folderId: string, expectedVersion: number, name: string) {
      if (this.loading) throw new Error('Conversation folders are still loading. Please wait and try again.')
      const workspaceVersion = this.workspaceVersion
      this.invalidateFolderReload()
      const renamed = await renameAgentConversationFolder(fetchFromWindow, this.csrfToken, folderId, expectedVersion, name)
      if (this.isWorkspaceCurrent(workspaceVersion)) {
        this.invalidateFolderReload()
        this.folders = markRaw(this.folders.map(folder => (folder.id === folderId ? renamed : folder)))
      }
      return renamed
    },
    async deleteFolder(folderId: string) {
      if (this.loading) throw new Error('Conversation folders are still loading. Please wait and try again.')
      const workspaceVersion = this.workspaceVersion
      this.invalidateFolderReload()
      const sessionId = this.thread?.session.id
      const refreshCurrent = this.thread?.session.folderId === folderId
      await deleteAgentConversationFolder(fetchFromWindow, this.csrfToken, folderId)
      if (!this.isWorkspaceCurrent(workspaceVersion)) return
      this.invalidateFolderReload()
      this.folders = markRaw(this.folders.filter(folder => folder.id !== folderId))
      const refreshes = [this.reloadSessions()]
      if (refreshCurrent && sessionId && this.isSessionContextCurrent(workspaceVersion, sessionId)) refreshes.push(this.refreshThread().then(() => undefined))
      const results = await Promise.allSettled(refreshes)
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected' && this.isWorkspaceCurrent(workspaceVersion))
        this.error = `The folder was deleted, but the workspace could not be refreshed. ${failed.reason instanceof Error ? failed.reason.message : ''}`.trim()
    },
    async moveSessionToFolder(sessionId: string, folderId: string | null) {
      const workspaceVersion = this.workspaceVersion
      const current = this.thread?.session.id === sessionId ? this.thread.session : null
      const summary = this.sessions.find(session => session.id === sessionId)
      const expectedSessionVersion = current?.version ?? summary?.version
      if (!expectedSessionVersion) throw new Error('The conversation changed. Refresh history and try again.')
      const projected = await moveAgentSessionToFolder(fetchFromWindow, this.csrfToken, sessionId, { expectedSessionVersion, folderId })
      if (this.isSessionContextCurrent(workspaceVersion, sessionId)) this.thread = markRaw(projected)
      if (!this.isWorkspaceCurrent(workspaceVersion)) return projected
      try {
        await this.reloadSessions()
      } catch (error) {
        if (this.isWorkspaceCurrent(workspaceVersion))
          this.error = `The conversation was moved, but history could not be refreshed. ${error instanceof Error ? error.message : ''}`.trim()
      }
      return projected
    },
    async refreshCommittedMutation(workspaceVersion: number, sessionId: string, message: string): Promise<boolean> {
      if (!this.isSessionContextCurrent(workspaceVersion, sessionId)) return false
      try {
        const refreshed = await this.refreshThread()
        if (refreshed && this.isSessionContextCurrent(workspaceVersion, sessionId)) this.connectCurrentRun()
        return refreshed
      } catch (error) {
        if (this.isSessionContextCurrent(workspaceVersion, sessionId))
          this.error = `${message} ${error instanceof Error ? error.message : 'Refresh the conversation.'}`.trim()
        return false
      }
    },
    async send(content: string, invokedSkillVersionIds: readonly string[] = [], mode: 'message' | 'goal' = 'message'): Promise<boolean> {
      const thread = this.thread
      const trimmed = content.trim()
      const currentPage = this.contextPage ?? this.launchPage
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
      this.sending = true
      this.error = ''
      try {
        const request = {
          clientRequestId: crypto.randomUUID(),
          expectedSessionVersion: thread.session.version,
          profileResolutionToken: thread.session.profileResolutionToken,
          ...(invokedSkillVersionIds.length > 0 ? { invokedSkillVersionIds } : {}),
          ...(currentPage ? { currentPage } : {})
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
        if (this.isWorkspaceCurrent(workspaceVersion)) this.sending = false
        return false
      }
      await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The message was sent, but the conversation could not be refreshed.')
      if (this.isWorkspaceCurrent(workspaceVersion)) this.sending = false
      return true
    },
    async stop() {
      const goal = this.thread?.goal
      if (goal?.status === 'active' || goal?.status === 'blocked') {
        await this.pauseGoal()
        return
      }
      const run = this.thread?.session.currentRun
      if (!run?.canCancel || this.stoppingRunId === run.id) return
      const workspaceVersion = this.workspaceVersion
      const sessionId = this.thread!.session.id
      this.stoppingRunId = run.id
      this.error = ''
      try {
        await cancelAgentRun(fetchFromWindow, this.csrfToken, run.id)
      } catch (error) {
        if (this.isSessionContextCurrent(workspaceVersion, sessionId)) this.error = error instanceof Error ? error.message : 'Run could not be stopped.'
        if (this.stoppingRunId === run.id) this.stoppingRunId = null
        return
      }
      await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The run was stopped, but the conversation could not be refreshed.')
      if (this.stoppingRunId === run.id) this.stoppingRunId = null
    },
    async pauseGoal() {
      const thread = this.thread
      const goal = thread?.goal
      if (!thread || !goal || this.goalBusy || (goal.status !== 'active' && goal.status !== 'blocked')) return
      const workspaceVersion = this.workspaceVersion
      const sessionId = thread.session.id
      this.goalBusy = true
      this.error = ''
      try {
        await pauseAgentGoal(fetchFromWindow, this.csrfToken, goal.id, { expectedVersion: goal.version })
      } catch (error) {
        if (this.isSessionContextCurrent(workspaceVersion, sessionId)) this.error = error instanceof Error ? error.message : 'Goal could not be paused.'
        if (this.isWorkspaceCurrent(workspaceVersion)) this.goalBusy = false
        return
      }
      await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The goal was paused, but the conversation could not be refreshed.')
      if (this.isWorkspaceCurrent(workspaceVersion)) this.goalBusy = false
    },
    async resumeGoal() {
      const thread = this.thread
      const goal = thread?.goal
      if (!thread || !goal || this.goalBusy || (goal.status !== 'paused' && goal.status !== 'blocked')) return
      const workspaceVersion = this.workspaceVersion
      const sessionId = thread.session.id
      this.goalBusy = true
      this.error = ''
      try {
        await resumeAgentGoal(fetchFromWindow, this.csrfToken, goal.id, {
          expectedVersion: goal.version,
          runId: crypto.randomUUID(),
          clientRequestId: crypto.randomUUID()
        })
      } catch (error) {
        if (this.isSessionContextCurrent(workspaceVersion, sessionId)) this.error = error instanceof Error ? error.message : 'Goal could not be resumed.'
        if (this.isWorkspaceCurrent(workspaceVersion)) this.goalBusy = false
        return
      }
      await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The goal was resumed, but the conversation could not be refreshed.')
      if (this.isWorkspaceCurrent(workspaceVersion)) this.goalBusy = false
    },
    async cancelGoal() {
      const thread = this.thread
      const goal = thread?.goal
      if (!thread || !goal || this.goalBusy || !['active', 'paused', 'blocked'].includes(goal.status)) return
      const workspaceVersion = this.workspaceVersion
      const sessionId = thread.session.id
      this.goalBusy = true
      this.error = ''
      try {
        await cancelAgentGoal(fetchFromWindow, this.csrfToken, goal.id, { expectedVersion: goal.version })
      } catch (error) {
        if (this.isSessionContextCurrent(workspaceVersion, sessionId)) this.error = error instanceof Error ? error.message : 'Goal could not be cancelled.'
        if (this.isWorkspaceCurrent(workspaceVersion)) this.goalBusy = false
        return
      }
      await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The goal was cancelled, but the conversation could not be refreshed.')
      if (this.isWorkspaceCurrent(workspaceVersion)) this.goalBusy = false
    },
    async decideProposal(proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string) {
      const sessionId = this.thread?.session.id
      if (!sessionId || this.decidingApprovalId) return
      const workspaceVersion = this.workspaceVersion
      this.decidingApprovalId = approvalId
      this.error = ''
      try {
        await decideAgentProposal(fetchFromWindow, this.csrfToken, proposalId, approvalId, {
          decision,
          ...(confirmationPath === undefined ? {} : { confirmationPath })
        })
      } catch (error) {
        if (this.isSessionContextCurrent(workspaceVersion, sessionId)) this.error = error instanceof Error ? error.message : 'Proposal decision failed.'
        if (this.decidingApprovalId === approvalId) this.decidingApprovalId = null
        return
      }
      await this.refreshCommittedMutation(workspaceVersion, sessionId, 'The decision was saved, but the conversation could not be refreshed.')
      if (this.decidingApprovalId === approvalId) this.decidingApprovalId = null
    },
    async setProfile(providerProfileId: string | null) {
      const thread = this.thread
      if (!thread || thread.session.currentRun?.canCancel || (thread.goal && ['active', 'paused', 'blocked'].includes(thread.goal.status))) return
      const workspaceVersion = this.workspaceVersion
      const sessionId = thread.session.id
      try {
        const projected = await updateAgentProfile(fetchFromWindow, this.csrfToken, sessionId, {
          expectedSessionVersion: thread.session.version,
          providerProfileId
        })
        if (this.isSessionContextCurrent(workspaceVersion, sessionId)) this.thread = markRaw(projected)
        return projected
      } catch (error) {
        if (!this.isSessionContextCurrent(workspaceVersion, sessionId)) return
        await Promise.allSettled([this.refreshThread(), this.reloadProfiles()])
        if (this.isSessionContextCurrent(workspaceVersion, sessionId))
          this.error = error instanceof Error ? error.message : 'Provider selection changed concurrently.'
      }
    },
    async setSkillPreferences(skillIds: readonly string[]) {
      const sessionId = this.thread?.session.id
      if (!sessionId) return
      const workspaceVersion = this.workspaceVersion
      try {
        await updateAgentSkillPreferences(fetchFromWindow, this.csrfToken, { skillIds })
      } catch (error) {
        if (!this.isSessionContextCurrent(workspaceVersion, sessionId)) return
        await Promise.allSettled([this.refreshThread(), this.reloadSkills()])
        if (this.isSessionContextCurrent(workspaceVersion, sessionId))
          this.error = error instanceof Error ? error.message : 'Skill preferences could not be updated.'
        return
      }
      await this.refreshCommittedMutation(workspaceVersion, sessionId, 'Skill preferences were saved, but the conversation could not be refreshed.')
    },
    async reloadProfiles() {
      const workspaceVersion = this.workspaceVersion
      const profiles = await listAgentProfiles(fetchFromWindow, this.csrfToken)
      if (this.isWorkspaceCurrent(workspaceVersion)) this.profiles = markRaw(profiles)
    },
    async reloadSkills(): Promise<boolean> {
      if (this.workspaceDisposed) return false
      const workspaceVersion = this.workspaceVersion
      const generation = this.skillsLoadGeneration + 1
      this.skillsLoadGeneration = generation
      this.skillsLoading = true
      this.skillsLoadError = ''
      this.skillsPartial = true
      try {
        const skills = await listAgentSkills(fetchFromWindow, this.csrfToken)
        if (!this.isWorkspaceCurrent(workspaceVersion) || this.skillsLoadGeneration !== generation) return false
        this.skills = markRaw(skills)
        this.skillsPartial = false
        return true
      } catch (error) {
        if (!this.isWorkspaceCurrent(workspaceVersion) || this.skillsLoadGeneration !== generation) return false
        this.skillsLoadError = (error instanceof Error ? error.message : 'The skill catalog could not be loaded.').slice(0, 512)
        return false
      } finally {
        if (this.isWorkspaceCurrent(workspaceVersion) && this.skillsLoadGeneration === generation) this.skillsLoading = false
      }
    },
    async removeSession(sessionId: string): Promise<boolean> {
      const workspaceVersion = this.workspaceVersion
      const version = this.beginSessionTransition()
      try {
        await deleteAgentSession(fetchFromWindow, this.csrfToken, sessionId)
      } catch (error) {
        try {
          if (this.isWorkspaceCurrent(workspaceVersion)) await this.reloadSessions()
        } catch {}
        if (!this.isWorkspaceCurrent(workspaceVersion) || !this.isSessionTransitionCurrent(version)) return false
        throw error
      }
      if (!this.isWorkspaceCurrent(workspaceVersion)) return true
      const removedDisplayedSession = this.thread?.session.id === sessionId
      if (this.isSessionTransitionCurrent(version) && removedDisplayedSession) {
        this.closeStream()
        this.invalidateRefresh()
        this.thread = null
        this.launchPage = null
        try {
          await this.newSession('saved')
        } catch (error) {
          if (this.isWorkspaceCurrent(workspaceVersion))
            this.error = `The conversation was deleted, but a new conversation could not be created. ${error instanceof Error ? error.message : ''}`.trim()
        }
        return true
      }
      try {
        await this.reloadSessions()
      } catch (error) {
        if (this.isWorkspaceCurrent(workspaceVersion) && this.isSessionTransitionCurrent(version))
          this.error = `The conversation was deleted, but history could not be refreshed. ${error instanceof Error ? error.message : ''}`.trim()
      }
      return true
    },
    async resetHistory() {
      const workspaceVersion = this.workspaceVersion
      const sessionId = this.thread?.session.id
      this.closeStream()
      this.cancelSessionTransition()
      try {
        await resetAgentHistory(fetchFromWindow, this.csrfToken)
      } catch (error) {
        if (sessionId && this.isSessionContextCurrent(workspaceVersion, sessionId)) this.connectCurrentRun()
        throw error
      }
      if (!this.isWorkspaceCurrent(workspaceVersion)) return
      this.invalidateRefresh()
      this.thread = null
      this.sessions = []
      this.sessionsNextCursor = null
      this.sessionsLoadMoreController?.abort()
      this.sessionsLoadMoreController = null
      this.sessionsReloading = false
      this.sessionsLoadingMore = false
      this.sessionsLoadMoreError = ''
      this.error = ''
      if (this.profiles.length > 0) await this.newSession('saved')
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
          event: (type, sequence) => {
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
        if (!refreshed || !this.isSessionContextCurrent(workspaceVersion, sessionId)) return
        const currentRun = this.thread?.session.currentRun
        if (observedRunId !== undefined && currentRun?.canCancel && currentRun.id !== observedRunId) {
          this.connectCurrentRun()
          if (terminal) await this.reloadSessions()
          return
        }
        if (terminal || !currentRun?.canCancel) {
          await this.reloadSessions()
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
      this.connection = observedRunId ? 'reconnecting' : 'idle'
      void this.refreshThread()
        .then(refreshed => {
          if (!refreshed || !this.isSessionContextCurrent(workspaceVersion, sessionId)) return
          this.connectCurrentRun()
        })
        .catch(error => {
          if (!this.isSessionContextCurrent(workspaceVersion, sessionId)) return
          if (error instanceof DOMException && error.name === 'AbortError') return
          const retryable = error instanceof AgentApiError ? error.retryable : error instanceof TypeError
          if (!retryable) {
            this.error = (error instanceof Error ? error.message : 'The conversation refresh response was invalid.').slice(0, 512)
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
