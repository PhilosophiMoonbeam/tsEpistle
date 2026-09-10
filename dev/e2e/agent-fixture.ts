import type { Page, Route } from '@playwright/test'
import type { AgentProposalView } from '../../shared/agents/contracts.ts'
export type AgentFixtureMode = 'success' | 'failure' | 'retry' | 'stop' | 'approval' | 'partial' | 'focus' | 'security' | 'cap'

export interface AgentFixtureOptions {
  readonly mode?: AgentFixtureMode
  readonly archivePartialFailure?: boolean
  readonly seedMemory?: boolean
}

export interface EnabledAgentFixture {
  readonly sessionId: string
  readonly mode: AgentFixtureMode
  readonly unexpectedRequests: readonly string[]
  readonly requests: readonly string[]
  assertNoUnexpectedRequests(): void
  dispose(): Promise<void>
}

type AgentRunStatus = 'queued' | 'running' | 'awaiting_approval' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
type AgentMessageStatus = 'pending' | 'streaming' | 'complete' | 'failed' | 'cancelled'
type AgentRole = 'user' | 'assistant'
type AgentCitation = { evidenceId: string; kind: 'page' | 'search-result' | 'skill' | 'browser'; label: string; href: string | null }
type AgentRun = {
  id: string
  sessionId: string
  status: AgentRunStatus
  attempt: number
  eventSequence: number
  canCancel: boolean
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  errorCode: string | null
  errorMessage: string | null
}
type AgentMessage = {
  id: string
  runId: string | null
  ordinal: number
  role: AgentRole
  status: AgentMessageStatus
  content: string
  citations: AgentCitation[]
  createdAt: string
  updatedAt: string
  knowledgeContext?: { scope: { kind: 'all' }; sources: never[] }
}
type AgentTool = {
  id: string
  runId: string
  actionName: 'pages.preparePatch'
  title: string
  state: 'preparing' | 'running' | 'awaitingApproval' | 'complete' | 'failed' | 'denied' | 'cancelled'
  risk: 'proposal'
  summary: string | null
  proposalId: string | null
  startedAt: string
  completedAt: string | null
}
type AgentSession = {
  id: string
  title: string
  retention: 'saved' | 'temporary'
  folderId: string | null
  status: 'active'
  executionMode: 'agent'
  version: number
  providerProfileId: string
  profileResolutionToken: string
  skills: never[]
  currentRun: AgentRun | null
  createdAt: string
  updatedAt: string
  lastActivityAt: string
  expiresAt: string | null
}
type FixtureThread = {
  session: AgentSession
  messages: AgentMessage[]
  tools: AgentTool[]
  tasks: never[]
  goal: null
  proposals: AgentProposalView[]
  artifacts: never[]
  historyWindow: { messageLimit: number; hasOlderMessages: boolean; runLimit: number; hasOlderRuns: boolean }
  suggestions: { id: string; label: string; prompt: string }[]
}

const NOW = '2026-09-01T12:00:00.000Z'
const LATER = '2026-09-01T12:00:01.000Z'
const SESSION_ID = '00000000-0000-4000-8000-000000000101'
const PROFILE_ID = '00000000-0000-4000-8000-000000000102'
const FOLDER_ID = '00000000-0000-4000-8000-000000000103'
const MEMORY_ID = '00000000-0000-4000-8000-000000000104'
const RUN_ID_BASE = '00000000-0000-4000-8000-000000000110'
const USER_MESSAGE_BASE = '00000000-0000-4000-8000-000000000120'
const ASSISTANT_MESSAGE_BASE = '00000000-0000-4000-8000-000000000130'
const PROPOSAL_ID = '00000000-0000-4000-8000-000000000140'
const APPROVAL_ID = '00000000-0000-4000-8000-000000000141'

const uuidAt = (base: string, offset: number): string => {
  const last = Number.parseInt(base.slice(-3), 16) + offset
  return `${base.slice(0, -3)}${last.toString(16).padStart(3, '0')}`
}

const json = (route: Route, payload: unknown, status = 200): Promise<void> =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const emptyHistoryWindow = () => ({ messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false })

const profile = () => ({
  id: PROFILE_ID,
  name: 'Deterministic Wiki provider',
  transport: 'openai-chat',
  model: 'fixture-model',
  utilityModel: null,
  destinationHost: 'fixture.invalid',
  capabilities: {
    streaming: true,
    toolCalling: 'native',
    parallelToolCalls: true,
    structuredOutput: 'native-json-schema',
    usage: 'stream',
    cancellation: true,
    maxContextTokens: 32_000,
    maxOutputTokens: 4_096
  },
  capabilityRevision: 'fixture-capabilities-v1',
  policyVersion: 1,
  isGlobalDefault: true
})
const sessionFor = (sessionId: string, currentRun: AgentRun | null = null, version = 1): AgentSession => ({
  id: sessionId,
  title: 'Release evidence review',
  retention: 'saved',
  folderId: null,
  status: 'active',
  executionMode: 'agent',
  version,
  providerProfileId: PROFILE_ID,
  profileResolutionToken: 'fixture-profile-resolution-token',
  skills: [],
  currentRun,
  createdAt: NOW,
  updatedAt: currentRun ? LATER : NOW,
  lastActivityAt: currentRun ? LATER : NOW,
  expiresAt: null
})

const runFor = (runId: string, sessionId = SESSION_ID, status: AgentRunStatus = 'running', eventSequence = 1): AgentRun => ({
  id: runId,
  sessionId,
  status,
  attempt: 1,
  eventSequence,
  canCancel: status === 'queued' || status === 'running' || status === 'awaiting_approval',
  createdAt: NOW,
  startedAt: status === 'queued' ? null : NOW,
  completedAt: status === 'queued' || status === 'running' || status === 'awaiting_approval' ? null : LATER,
  errorCode: status === 'failed' ? 'FIXTURE_PROVIDER_FAILED' : null,
  errorMessage: status === 'failed' ? 'The fixture provider stopped responding.' : null
})

const citationRows = (): AgentCitation[] => [
  { evidenceId: 'page:6', kind: 'page', label: 'Release guide', href: '/en/release-guide#overview' },
  { evidenceId: 'page:6:section:1', kind: 'page', label: 'Release guide › Overview', href: '/en/release-guide#overview' },
  { evidenceId: 'page:6:section:2', kind: 'page', label: 'Release guide › Verification sequence', href: '/en/release-guide#verification-sequence' },
  { evidenceId: 'citation-title-only', kind: 'page', label: 'A title that is not a citation marker', href: '/en/release-guide#title-only' }
]

const successfulMarkdown = [
  'The release is ready for a deliberate review.',
  '',
  'The verification sequence is documented in [[cite:page:6:section:2]], with the overview in [[cite:page:6:section:1]].',
  '',
  '```mermaid',
  'graph TD',
  '  A[Review sources] --> B{Evidence complete}',
  '  B -->|yes| C[Publish release]',
  '  B -->|no| D[Request follow-up]',
  '```',
  '',
  '[A title that is not a citation marker](/en/release-guide#title-only)',
  '',
  '[Follow-up reading](/en/release-guide#title-only)',
  '[Follow-up reading](/en/release-guide#title-only)'
].join('\n')

const focusSameCountMarkdown = `${successfulMarkdown}\n\nThe streamed review context is still current.`
const focusCardinalityMarkdown = `${focusSameCountMarkdown}\n\nThe streamed review context gained another link.\n\n[Follow-up reading](/en/release-guide#title-only)`
const hostileMermaidMarkdown = [
  '```mermaid',
  String.raw`%%{init: {"themeCSS":".node { fill: url(\"https://mermaid-hostile.invalid/fill\"); } @import url(\"https://mermaid-hostile.invalid/import.css\");"}}%%`,
  'graph TD',
  '  A[Hostile theme] --> B[Fallback]',
  '```'
].join('\n')

const cappedMermaidMarkdown = Array.from({ length: 9 }, (_, index) =>
  ['```mermaid', `graph TD\n  A${index}[Diagram ${index + 1}] --> B${index}[Ready]`, '```'].join('\n')
).join('\n\n')

const responseMarkdown = (mode: AgentFixtureMode): string => {
  if (mode === 'security') return hostileMermaidMarkdown
  if (mode === 'cap') return cappedMermaidMarkdown
  return successfulMarkdown
}

const threadFor = (sessionId = SESSION_ID): FixtureThread => ({
  session: sessionFor(sessionId),
  messages: [],
  tools: [],
  tasks: [],
  goal: null,
  proposals: [],
  artifacts: [],
  historyWindow: emptyHistoryWindow(),
  suggestions: [{ id: 'fixture-follow-up', label: 'Show the evidence', prompt: 'Show the evidence behind that answer.' }]
})

type FixtureMemory = {
  id: string
  target: 'agent' | 'user'
  content: string
  version: number
  createdAt: string
  updatedAt: string
}
type FixtureState = {
  thread: FixtureThread
  mode: AgentFixtureMode
  archivePartialFailure: boolean
  seedMemory: boolean
  runIndex: number
  sessionVersion: number
  sessionListReads: number
  folderReads: number
  eventReads: number
  memoryEntries: FixtureMemory[]
  activeRunId: string | null
  finalizedRuns: Set<string>
  approvalRequestedAt: string
  approvalExpiresAt: string
}
const memory = (): FixtureMemory => ({
  id: MEMORY_ID,
  target: 'user',
  content: 'Prefer concise release notes with explicit evidence.',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW
})

const sessionSummary = (thread: FixtureThread) => ({
  id: thread.session.id,
  title: thread.session.title,
  retention: thread.session.retention,
  folderId: thread.session.folderId,
  executionMode: 'agent',
  version: thread.session.version,
  providerProfileId: thread.session.providerProfileId,
  createdAt: thread.session.createdAt,
  updatedAt: thread.session.updatedAt,
  lastActivityAt: thread.session.lastActivityAt,
  expiresAt: thread.session.expiresAt,
  deletedAt: null
})

const setActiveThread = (state: FixtureState, prompt: string): string => {
  const index = state.runIndex
  const runId = uuidAt(RUN_ID_BASE, index)
  const userId = uuidAt(USER_MESSAGE_BASE, index)
  const assistantId = uuidAt(ASSISTANT_MESSAGE_BASE, index)
  const run = runFor(runId, state.thread.session.id, 'running', 1)
  state.activeRunId = runId
  state.eventReads = 0
  state.sessionVersion += 1
  state.thread.session = sessionFor(state.thread.session.id, run, state.sessionVersion)
  state.thread.messages.push({
    id: userId,
    runId: null,
    ordinal: state.thread.messages.length,
    role: 'user',
    status: 'complete',
    content: prompt,
    citations: [],
    createdAt: NOW,
    updatedAt: NOW,
    knowledgeContext: { scope: { kind: 'all' }, sources: [] }
  })
  state.thread.messages.push({
    id: assistantId,
    runId,
    ordinal: state.thread.messages.length,
    role: 'assistant',
    status: 'streaming',
    content: state.mode === 'focus' ? successfulMarkdown : 'I am checking the release evidence…',
    citations: citationRows(),
    createdAt: NOW,
    updatedAt: NOW
  })
  state.thread.tools = []
  state.thread.tasks = []
  state.thread.proposals = []
  if (state.mode === 'approval') {
    const proposal = {
      id: PROPOSAL_ID,
      sourceKind: 'agent',
      actionName: 'pages.preparePatch',
      risk: 'proposal',
      status: 'pending',
      summary: 'Apply the reviewed release evidence note.',
      target: { id: 6, locale: 'en', path: 'release-guide', title: 'Release guide', contentType: 'markdown', sourceRevision: '7' },
      pageLink: null,
      baseSourceRevision: '7',
      authoritySha256: 'a'.repeat(64),
      inputHash: 'b'.repeat(64),
      patchSha256: 'c'.repeat(64),
      resultCanonicalSha256: null,
      diffSha256: 'd'.repeat(64),
      diff: '+Evidence reviewed\n+Release is ready.',
      expiresAt: state.approvalExpiresAt,
      approval: {
        id: APPROVAL_ID,
        proposalId: PROPOSAL_ID,
        status: 'pending',
        requestedAt: state.approvalRequestedAt,
        expiresAt: state.approvalExpiresAt,
        decidedAt: null,
        decisionNote: null
      }
    } satisfies AgentProposalView
    state.thread.proposals = [proposal]
    const tool: AgentTool = {
      id: 'fixture-tool-approval',
      runId,
      actionName: 'pages.preparePatch',
      title: 'Prepare page patch',
      state: 'awaitingApproval',
      risk: 'proposal',
      summary: 'Waiting for your review.',
      proposalId: PROPOSAL_ID,
      startedAt: NOW,
      completedAt: null
    }
    state.thread.tools = [tool]
    state.thread.session.currentRun = runFor(runId, state.thread.session.id, 'awaiting_approval', 1)
  }
  return runId
}

const finalizeThread = (state: FixtureState, runId: string, status: Exclude<AgentRunStatus, 'queued' | 'running' | 'awaiting_approval'>): void => {
  if (state.finalizedRuns.has(runId)) return
  const run = runFor(runId, state.thread.session.id, status, 4)
  state.thread.session.currentRun = run
  state.thread.session.updatedAt = LATER
  state.thread.session.lastActivityAt = LATER
  const assistant = [...state.thread.messages].reverse().find(message => message.runId === runId && message.role === 'assistant')
  if (assistant) {
    assistant.status = status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'complete'
    assistant.content =
      status === 'failed'
        ? 'The provider stopped responding before the answer was complete.'
        : status === 'cancelled'
          ? 'The response was stopped before completion.'
          : state.mode === 'focus'
            ? assistant.content
            : responseMarkdown(state.mode)
    assistant.updatedAt = LATER
  }
  state.finalizedRuns.add(runId)
}

const eventStream = (runId: string, terminal: AgentRunStatus | null): string => {
  const events: Array<{ id: number; type: string; data: Record<string, unknown> }> = [
    { id: 2, type: 'run.started', data: { runId } },
    { id: 3, type: 'message.delta', data: { runId, text: ' evidence' } }
  ]
  if (terminal) events.push({ id: 4, type: terminal === 'partial' ? 'run.partial' : terminal === 'failed' ? 'run.failed' : 'run.completed', data: { runId } })
  return events.map(event => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`).join('')
}

const requestDescription = (route: Route): string => {
  const request = route.request()
  const url = new URL(request.url())
  return `${request.method()} ${url.pathname}${url.search}`
}

export async function installEnabledAgentFixture(page: Page, options: AgentFixtureOptions = {}): Promise<EnabledAgentFixture> {
  const mode = options.mode ?? 'success'
  const unexpectedRequests: string[] = []
  const requests: string[] = []
  const approvalWindowStart = Date.now()
  const approvalRequestedAt = new Date(approvalWindowStart).toISOString()
  const approvalExpiresAt = new Date(approvalWindowStart + 15 * 60_000).toISOString()
  const state: FixtureState = {
    thread: threadFor(),
    mode,
    archivePartialFailure: options.archivePartialFailure ?? false,
    seedMemory: options.seedMemory ?? true,
    runIndex: 0,
    sessionVersion: 1,
    sessionListReads: 0,
    folderReads: 0,
    eventReads: 0,
    memoryEntries: options.seedMemory === false ? [] : [memory()],
    activeRunId: null,
    finalizedRuns: new Set(),
    approvalRequestedAt,
    approvalExpiresAt
  }

  await page.addInitScript(() => {
    let captured: Record<string, unknown> | undefined
    Object.defineProperty(window, 'siteConfig', {
      configurable: true,
      get: () => captured ?? {},
      set: (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return
        captured = value as Record<string, unknown>
        captured.agentsEnabled = true
        captured.agentProviderEnabled = true
        captured.agentCsrfToken = typeof captured.agentCsrfToken === 'string' && captured.agentCsrfToken ? captured.agentCsrfToken : 'fixture-agent-csrf-token'
      }
    })
  })

  await page.route(/\/_api\/agents(?:\/|$)/, async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    requests.push(requestDescription(route))

    const failUnexpected = async (): Promise<void> => {
      const description = requestDescription(route)
      unexpectedRequests.push(description)
      await route.abort('blockedbyclient')
    }

    if (path === '/_api/agents/sessions' && request.method() === 'GET') {
      state.sessionListReads += 1
      if (state.archivePartialFailure && state.sessionListReads === 2) return json(route, { sessions: [sessionSummary(state.thread)], nextCursor: null })
      return json(route, { sessions: [sessionSummary(state.thread)], nextCursor: null })
    }
    if (path === '/_api/agents/conversation-folders' && request.method() === 'GET') {
      state.folderReads += 1
      if (state.archivePartialFailure && state.folderReads === 2) return json(route, { error: 'Fixture archive folder failure' }, 503)
      return json(route, { folders: [{ id: FOLDER_ID, name: 'Release reviews', version: 1, createdAt: NOW, updatedAt: NOW }] })
    }
    if (path === '/_api/agents/profiles' && request.method() === 'GET') return json(route, { profiles: [profile()] })
    if (path === '/_api/agents/skills' && request.method() === 'GET') return json(route, { skills: [] })
    if (path === '/_api/agents/memories' && request.method() === 'GET') {
      const userCharacters = state.memoryEntries.filter(entry => entry.target === 'user').reduce((sum, entry) => sum + entry.content.length, 0)
      const agentCharacters = state.memoryEntries.filter(entry => entry.target === 'agent').reduce((sum, entry) => sum + entry.content.length, 0)
      return json(route, {
        agent: { entries: state.memoryEntries.filter(entry => entry.target === 'agent'), characters: agentCharacters, limit: 2_200 },
        user: { entries: state.memoryEntries.filter(entry => entry.target === 'user'), characters: userCharacters, limit: 1_375 }
      })
    }
    if (path === '/_api/agents/memories' && request.method() === 'POST') {
      const body = (request.postDataJSON() ?? {}) as { target?: 'agent' | 'user'; content?: string }
      const target = body.target === 'agent' ? 'agent' : 'user'
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      const entry = { id: uuidAt(MEMORY_ID, state.memoryEntries.length + 1), target, content, version: 1, createdAt: NOW, updatedAt: NOW }
      state.memoryEntries.push(entry)
      const characters = state.memoryEntries.filter(item => item.target === target).reduce((sum, item) => sum + item.content.length, 0)
      return json(
        route,
        {
          changed: true,
          message: 'Memory saved.',
          target,
          entries: state.memoryEntries.filter(item => item.target === target).map(item => item.content),
          characters,
          limit: target === 'agent' ? 2_200 : 1_375
        },
        201
      )
    }
    if (path.startsWith('/_api/agents/memories/') && request.method() === 'PUT') {
      const id = path.split('/').pop() ?? ''
      const body = (request.postDataJSON() ?? {}) as { target?: 'agent' | 'user'; content?: string; expectedVersion?: number }
      const entry = state.memoryEntries.find(item => item.id === id)
      if (!entry) return json(route, { error: 'Memory not found.' }, 404)
      entry.target = body.target === 'agent' ? 'agent' : 'user'
      entry.content = typeof body.content === 'string' ? body.content.trim() : entry.content
      entry.version += 1
      entry.updatedAt = LATER
      const characters = state.memoryEntries.filter(item => item.target === entry.target).reduce((sum, item) => sum + item.content.length, 0)
      return json(route, {
        changed: true,
        message: 'Memory updated.',
        target: entry.target,
        entries: state.memoryEntries.filter(item => item.target === entry.target).map(item => item.content),
        characters,
        limit: entry.target === 'agent' ? 2_200 : 1_375
      })
    }
    if (path.startsWith('/_api/agents/memories/') && request.method() === 'DELETE') {
      const id = path.split('/').pop()?.split('?')[0] ?? ''
      const index = state.memoryEntries.findIndex(item => item.id === id)
      if (index >= 0) state.memoryEntries.splice(index, 1)
      return json(route, { changed: true, message: 'Memory removed.', target: 'user', entries: [], characters: 0, limit: 1_375 })
    }
    if (path === '/_api/agents/sessions' && request.method() === 'POST') {
      const body = (request.postDataJSON() ?? {}) as { retention?: 'saved' | 'temporary' }
      state.sessionVersion = 1
      state.thread = threadFor()
      state.thread.session.retention = body.retention === 'temporary' ? 'temporary' : 'saved'
      state.thread.session.expiresAt = body.retention === 'temporary' ? '2026-09-02T12:00:00.000Z' : null
      state.activeRunId = null
      return json(route, { ...copy(state.thread), launchPage: null }, 201)
    }
    const sessionMatch = path.match(/^\/_api\/agents\/sessions\/([^/]+)$/)
    if (sessionMatch && request.method() === 'GET') {
      if (sessionMatch[1] !== state.thread.session.id) return json(route, { error: 'Session not found.' }, 404)
      return json(route, copy(state.thread))
    }
    if (sessionMatch && request.method() === 'PATCH') {
      const body = (request.postDataJSON() ?? {}) as { title?: string; retention?: 'saved' | 'temporary' }
      state.sessionVersion += 1
      if (typeof body.title === 'string' && body.title.trim()) state.thread.session.title = body.title.trim()
      if (body.retention) state.thread.session.retention = body.retention
      state.thread.session.version = state.sessionVersion
      return json(route, copy(state.thread))
    }
    if (sessionMatch && request.method() === 'PUT') return json(route, copy(state.thread))
    if (sessionMatch && request.method() === 'DELETE') {
      state.thread = threadFor()
      return route.fulfill({ status: 204 })
    }
    const messageMatch = path.match(/^\/_api\/agents\/sessions\/([^/]+)\/messages$/)
    if (messageMatch && request.method() === 'POST') {
      const body = (request.postDataJSON() ?? {}) as { content?: string }
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      const runId = setActiveThread(state, content)
      state.runIndex += 1
      return json(route, { run: runFor(runId, state.thread.session.id, state.mode === 'approval' ? 'awaiting_approval' : 'running', 1), replayed: false }, 202)
    }
    const cancelMatch = path.match(/^\/_api\/agents\/runs\/([^/]+)\/cancel$/)
    if (cancelMatch && request.method() === 'POST') {
      const runId = cancelMatch[1]!
      if (state.activeRunId === runId) finalizeThread(state, runId, 'cancelled')
      return json(route, { run: copy(state.thread.session.currentRun) })
    }
    const eventsMatch = path.match(/^\/_api\/agents\/runs\/([^/]+)\/events$/)
    if (eventsMatch && request.method() === 'GET') {
      const runId = eventsMatch[1]!
      const run = state.thread.session.currentRun
      if (!run || run.id !== runId) return await failUnexpected()
      state.eventReads += 1
      if (state.mode === 'focus') {
        const assistant = [...state.thread.messages].reverse().find(message => message.runId === runId && message.role === 'assistant')
        if (assistant) {
          assistant.status = 'complete'
          if (state.eventReads === 2) assistant.content = focusSameCountMarkdown
          if (state.eventReads >= 3) assistant.content = focusCardinalityMarkdown
        }
      }
      const isRetrySuccess = state.mode === 'retry' && state.runIndex > 1
      const terminal =
        state.mode === 'stop' || state.mode === 'approval' || (state.mode === 'focus' && state.eventReads < 3)
          ? null
          : state.mode === 'failure' || (state.mode === 'retry' && !isRetrySuccess)
            ? 'failed'
            : state.mode === 'partial'
              ? 'partial'
              : 'succeeded'
      if (terminal) finalizeThread(state, runId, terminal)
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-cache', connection: 'keep-alive' },
        body: eventStream(runId, terminal)
      })
    }
    const decisionMatch = path.match(/^\/_api\/agents\/proposals\/([^/]+)\/approvals\/([^/]+)\/decision$/)
    if (decisionMatch && request.method() === 'POST') {
      const body = (request.postDataJSON() ?? {}) as { decision?: 'approved' | 'denied'; decisionNote?: string }
      const proposal = state.thread.proposals.find(item => item.id === decisionMatch[1])
      if (proposal?.approval) {
        const decision = body.decision === 'approved' ? 'approved' : 'denied'
        const decidedAt = new Date().toISOString()
        const decisionNote = body.decisionNote ?? null
        state.thread.proposals = state.thread.proposals.map(item =>
          item.id === proposal.id && item.approval
            ? { ...item, status: decision, approval: { ...item.approval, status: decision, decidedAt, decisionNote } }
            : item
        )
        const tool = state.thread.tools.find(item => item.proposalId === proposal.id)
        if (tool) tool.state = decision === 'approved' ? 'complete' : 'denied'
        if (state.activeRunId) finalizeThread(state, state.activeRunId, decision === 'approved' ? 'succeeded' : 'partial')
        return json(route, { proposalId: proposal.id, approvalId: proposal.approval.id, status: decision, decidedAt })
      }
      return json(route, { error: 'Approval not found.' }, 404)
    }
    return failUnexpected()
  })

  return {
    sessionId: SESSION_ID,
    mode,
    get unexpectedRequests() {
      return [...unexpectedRequests]
    },
    get requests() {
      return [...requests]
    },
    assertNoUnexpectedRequests() {
      if (unexpectedRequests.length) throw new Error(`Unexpected Agent fixture requests: ${unexpectedRequests.join(', ')}`)
    },
    async dispose() {
      if (!page.isClosed()) await page.unroute(/\/_api\/agents(?:\/|$)/)
    }
  }
}
