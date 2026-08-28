import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { AgentConversationFolderView, AgentCurrentPageHint, AgentEventType, AgentProviderProfileView, AgentThreadState } from '../../shared/agents/contracts.ts'
import { cancelAgentRun, createAgentConversationFolder, createAgentThread, decideAgentProposal, deleteAgentConversationFolder, deleteAgentSession, getAgentThread, listAgentConversationFolders, listAgentProfiles, listAgentSessions, listAgentSkills, moveAgentSessionToFolder, renameAgentConversationFolder, resetAgentHistory, submitAgentMessage, subscribeAgentRun, updateAgentProfile, updateAgentSkillPreferences, type AgentSessionSummary, type CreatedAgentThread, type VisibleAgentSkill } from '../helpers/agents-api.ts'

const terminalEvents = new Set<AgentEventType>(['run.completed', 'run.failed', 'run.cancelled', 'run.recovery_required'])
export interface AgentStoreInitializeOptions {
  readonly routeSync?: boolean
  readonly currentPage?: AgentCurrentPageHint | null
  readonly reuseLatest?: boolean
}


export const useAgentsStore = defineStore('agents', {
  state: () => ({
    csrfToken: '',
    sessions: [] as AgentSessionSummary[],
    folders: [] as AgentConversationFolderView[],
    thread: null as AgentThreadState | null,
    skills: [] as VisibleAgentSkill[],
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
    decidingApprovalId: null as string | null
  }),
  actions: {
    async initialize(csrfToken: string, options: AgentStoreInitializeOptions = {}) {
      this.csrfToken = csrfToken
      this.routeSync = options.routeSync ?? true
      this.contextPage = options.currentPage ?? null
      this.loading = true
      this.error = ''
      try {
        const pathMatch = this.routeSync ? /^\/sessions\/([0-9a-f-]{36})$/i.exec(window.location.pathname) : null
        const [sessions, folders, profiles, skills] = await Promise.all([
          listAgentSessions(window.fetch.bind(window), csrfToken),
          listAgentConversationFolders(window.fetch.bind(window), csrfToken),
          listAgentProfiles(window.fetch.bind(window), csrfToken),
          listAgentSkills(window.fetch.bind(window), csrfToken).catch(() => [])
        ])
        this.profiles = profiles
        this.skills = skills
        this.sessions = sessions
        this.folders = folders
        if (pathMatch?.[1]) {
          await this.openSession(pathMatch[1])
        } else if (!this.routeSync && this.thread) {
          await this.openSession(this.thread.session.id)
        } else if (options.reuseLatest && sessions[0]) {
          await this.openSession(sessions[0].id)
        } else {
          await this.newSession('saved')
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Agent session failed to load.'
      } finally {
        this.loading = false
      }
    },
    setCurrentPage(page: AgentCurrentPageHint | null) {
      this.contextPage = page
    },
    async newSession(retention: 'temporary' | 'saved') {
      const disposableSessionId = this.thread && this.thread.messages.length === 0 && !this.thread.session.currentRun
        ? this.thread.session.id
        : null
      this.closeStream()
      if (disposableSessionId) await deleteAgentSession(window.fetch.bind(window), this.csrfToken, disposableSessionId)
      const created = await createAgentThread(window.fetch.bind(window), this.csrfToken, { retention, providerProfileId: null })
      this.applyCreatedThread(created)
      if (this.routeSync) window.history.replaceState(null, '', `/sessions/${created.session.id}`)
      await this.reloadSessions()
    },
    applyCreatedThread(created: CreatedAgentThread) {
      this.thread = created
      const launch = created.launchPage
      this.launchPage = launch?.pageId && launch.locale && launch.path && launch.observedUpdatedAt
        ? { id: launch.pageId, locale: launch.locale, path: launch.path, observedUpdatedAt: launch.observedUpdatedAt }
        : null
      this.connectCurrentRun()
    },
    async openSession(sessionId: string) {
      this.closeStream()
      this.thread = await getAgentThread(window.fetch.bind(window), this.csrfToken, sessionId)
      this.launchPage = null
      if (this.routeSync) window.history.replaceState(null, '', `/sessions/${sessionId}`)
      this.connectCurrentRun()
    },
    async refreshThread() {
      const sessionId = this.thread?.session.id
      if (!sessionId) return
      const refreshed = await getAgentThread(window.fetch.bind(window), this.csrfToken, sessionId)
      if (this.thread?.session.id !== sessionId) return
      this.thread = refreshed
    },
    async reloadSessions() {
      this.sessions = await listAgentSessions(window.fetch.bind(window), this.csrfToken)
    },
    async reloadFolders() {
      this.folders = await listAgentConversationFolders(window.fetch.bind(window), this.csrfToken)
    },
    async createFolder(name: string) {
      await createAgentConversationFolder(window.fetch.bind(window), this.csrfToken, name)
      await this.reloadFolders()
    },
    async renameFolder(folderId: string, expectedVersion: number, name: string) {
      await renameAgentConversationFolder(window.fetch.bind(window), this.csrfToken, folderId, expectedVersion, name)
      await this.reloadFolders()
    },
    async deleteFolder(folderId: string) {
      const refreshCurrent = this.thread?.session.folderId === folderId
      await deleteAgentConversationFolder(window.fetch.bind(window), this.csrfToken, folderId)
      await Promise.all([this.reloadFolders(), this.reloadSessions()])
      if (refreshCurrent) await this.refreshThread()
    },
    async moveSessionToFolder(sessionId: string, folderId: string | null) {
      const current = this.thread?.session.id === sessionId ? this.thread.session : null
      const summary = this.sessions.find(session => session.id === sessionId)
      const expectedSessionVersion = current?.version ?? summary?.version
      if (!expectedSessionVersion) throw new Error('The conversation changed. Refresh history and try again.')
      const projected = await moveAgentSessionToFolder(window.fetch.bind(window), this.csrfToken, sessionId, { expectedSessionVersion, folderId })
      if (current) this.thread = projected
      await this.reloadSessions()
    },
    async send(content: string, invokedSkillVersionIds: readonly string[] = []): Promise<boolean> {
      const thread = this.thread
      const trimmed = content.trim()
      const currentPage = this.contextPage ?? this.launchPage
      if (!thread || !trimmed || this.sending || thread.session.currentRun?.canCancel) return false
      this.sending = true
      this.error = ''
      try {
        const run = await submitAgentMessage(window.fetch.bind(window), this.csrfToken, thread.session.id, {
          clientRequestId: crypto.randomUUID(),
          expectedSessionVersion: thread.session.version,
          profileResolutionToken: thread.session.profileResolutionToken,
          content: trimmed,
          ...(invokedSkillVersionIds.length > 0 ? { invokedSkillVersionIds } : {}),
          ...(currentPage ? { currentPage } : {})
        })
        await this.refreshThread()
        this.eventSequence = run.eventSequence
        this.connect(run.id, run.eventSequence)
        return true
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Message could not be sent.'
        return false
      } finally {
        this.sending = false
      }
    },
    async stop() {
      const run = this.thread?.session.currentRun
      if (!run?.canCancel) return
      try {
        await cancelAgentRun(window.fetch.bind(window), this.csrfToken, run.id)
        await this.refreshThread()
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Run could not be stopped.'
      }
    },
    async decideProposal(proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string) {
      if (this.decidingApprovalId) return
      this.decidingApprovalId = approvalId
      this.error = ''
      try {
        await decideAgentProposal(window.fetch.bind(window), this.csrfToken, proposalId, approvalId, {
          decision,
          ...(confirmationPath === undefined ? {} : { confirmationPath })
        })
        await this.refreshThread()
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Proposal decision failed.'
        await this.refreshThread()
      } finally {
        this.decidingApprovalId = null
      }
    },
    async setProfile(providerProfileId: string | null) {
      const thread = this.thread
      if (!thread || thread.session.currentRun?.canCancel) return
      try {
        this.thread = await updateAgentProfile(window.fetch.bind(window), this.csrfToken, thread.session.id, {
          expectedSessionVersion: thread.session.version,
          providerProfileId
        })
      } catch (error) {
        await Promise.all([this.refreshThread(), this.reloadProfiles()])
        this.error = error instanceof Error ? error.message : 'Provider selection changed concurrently.'
      }
    },
    async setSkillPreferences(skillIds: readonly string[]) {
      if (!this.thread) return
      try {
        await updateAgentSkillPreferences(window.fetch.bind(window), this.csrfToken, { skillIds })
        await this.refreshThread()
      } catch (error) {
        await Promise.all([this.refreshThread(), this.reloadSkills()])
        this.error = error instanceof Error ? error.message : 'Skill preferences could not be updated.'
      }
    },
    async reloadProfiles() {
      this.profiles = await listAgentProfiles(window.fetch.bind(window), this.csrfToken)
    },
    async reloadSkills() {
      this.skills = await listAgentSkills(window.fetch.bind(window), this.csrfToken)
    },
    async removeSession(sessionId: string) {
      await deleteAgentSession(window.fetch.bind(window), this.csrfToken, sessionId)
      if (this.thread?.session.id === sessionId) {
        this.closeStream()
        this.thread = null
        await this.newSession('saved')
      } else {
        await this.reloadSessions()
      }
    },
    async resetHistory() {
      this.closeStream()
      await resetAgentHistory(window.fetch.bind(window), this.csrfToken)
      this.thread = null
      this.sessions = []
      this.error = ''
      if (this.profiles.length > 0) await this.newSession('saved')
    },
    connectCurrentRun() {
      const run = this.thread?.session.currentRun
      if (run?.canCancel) this.connect(run.id, run.eventSequence)
      else this.connection = 'idle'
    },
    connect(runId: string, after: number) {
      this.closeStream()
      this.eventSequence = after
      this.connection = 'connecting'
      this.source = markRaw(subscribeAgentRun(runId, after, {
        event: (type, sequence) => {
          this.connection = 'connected'
          this.eventSequence = Math.max(this.eventSequence, sequence)
          this.scheduleRefresh(terminalEvents.has(type))
        },
        error: () => {
          if (this.connection !== 'closed') {
            this.connection = 'reconnecting'
            this.scheduleRefresh(false, 250)
          }
        }
      }))
      this.scheduleRefresh(false, 1_000)
    },
    scheduleRefresh(terminal: boolean, delay = 50) {
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null
        void this.refreshThread().then(() => {
          if (terminal || !this.thread?.session.currentRun?.canCancel) return this.reloadSessions()
          return undefined
        }).catch(() => {
          if (this.connection !== 'closed') this.connection = 'reconnecting'
        }).finally(() => {
          if (terminal || !this.thread?.session.currentRun?.canCancel) {
            this.closeStream()
          } else if (this.connection !== 'closed') {
            this.scheduleRefresh(false, 1_000)
          }
        })
      }, delay)
    },
    closeStream() {
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
      this.refreshTimer = null
      this.source?.close()
      this.source = null
      this.connection = 'closed'
    }
  }
})
