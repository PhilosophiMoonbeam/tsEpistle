import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { AgentCurrentPageHint, AgentEventType, AgentProviderProfileView, AgentThreadState } from '../../shared/agents/contracts.ts'
import { cancelAgentRun, createAgentThread, decideAgentProposal, deleteAgentSession, getAgentThread, listAgentProfiles, listAgentSessions, listAgentSkills, submitAgentMessage, subscribeAgentRun, updateAgentProfile, updateAgentSkills, type AgentSessionSummary, type CreatedAgentThread, type VisibleAgentSkill } from '../helpers/agents-api.ts'

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
        const [sessions, profiles, skills] = await Promise.all([
          listAgentSessions(window.fetch.bind(window), csrfToken),
          listAgentProfiles(window.fetch.bind(window), csrfToken),
          listAgentSkills(window.fetch.bind(window), csrfToken).catch(() => [])
        ])
        this.profiles = profiles
        this.skills = skills
        this.sessions = sessions
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
      this.closeStream()
      const created = await createAgentThread(window.fetch.bind(window), this.csrfToken, { retention, executionMode: 'agent', providerProfileId: null })
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
    async send(content: string): Promise<boolean> {
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
    async setProfile(providerProfileId: string | null, executionMode: 'agent' | 'generation-only') {
      const thread = this.thread
      if (!thread || thread.session.currentRun?.canCancel) return
      try {
        this.thread = await updateAgentProfile(window.fetch.bind(window), this.csrfToken, thread.session.id, {
          expectedSessionVersion: thread.session.version,
          providerProfileId,
          executionMode
        })
      } catch (error) {
        await Promise.all([this.refreshThread(), this.reloadProfiles()])
        this.error = error instanceof Error ? error.message : 'Provider selection changed concurrently.'
      }
    },
    async setSkills(skillVersionIds: readonly string[]) {
      const thread = this.thread
      if (!thread || thread.session.currentRun?.canCancel) return
      try {
        await updateAgentSkills(window.fetch.bind(window), this.csrfToken, thread.session.id, {
          expectedSessionVersion: thread.session.version,
          skillVersionIds
        })
        await this.refreshThread()
      } catch (error) {
        await Promise.all([this.refreshThread(), this.reloadSkills()])
        this.error = error instanceof Error ? error.message : 'Skill selection changed concurrently.'
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
          if (this.connection !== 'closed') this.connection = 'reconnecting'
        }
      }))
    },
    scheduleRefresh(terminal: boolean) {
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null
        void this.refreshThread().finally(() => {
          if (terminal) this.closeStream()
        })
      }, 50)
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
