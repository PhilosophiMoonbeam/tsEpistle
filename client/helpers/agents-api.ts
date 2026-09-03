import { z } from 'zod'
import { sameOriginJsonFetch } from './json-transport.ts'
import {
  AGENT_ACTION_NAMES,
  AGENT_EVENT_TYPES,
  AGENT_GOAL_STATUSES,
  AGENT_PROPOSAL_STATUSES,
  AGENT_PROVIDER_TRANSPORTS,
  AGENT_TASK_KINDS,
  type AgentConversationFolderView,
  type AgentEventType,
  type AgentProviderProfileView,
  type AgentThreadState,
  type CancelAgentGoalRequest,
  type DecideAgentApprovalRequest,
  type CreateAgentGoalRequest,
  type CreateAgentSessionRequest,
  type PauseAgentGoalRequest,
  type ResumeAgentGoalRequest,
  type SubmitAgentMessageRequest,
  type UpdateAgentSessionFolderRequest,
  type UpdateAgentSessionProfileRequest,
  type UpdateAgentSkillPreferencesRequest
} from '../../shared/agents/contracts.ts'

const Iso = z.iso.datetime()
const Uuid = z.uuid()
const RunStatus = z.enum(['queued', 'running', 'awaiting_approval', 'succeeded', 'partial', 'failed', 'cancelled', 'recovery_required'])
const Run = z.object({
  id: Uuid,
  sessionId: Uuid,
  status: RunStatus,
  attempt: z.number().int().nonnegative(),
  eventSequence: z.number().int().nonnegative(),
  canCancel: z.boolean(),
  createdAt: Iso,
  startedAt: Iso.nullable(),
  completedAt: Iso.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable()
})
const Citation = z.object({
  evidenceId: z.string(),
  kind: z.enum(['page', 'search-result', 'skill', 'browser']),
  label: z.string(),
  href: z.string().nullable()
})
const Message = z.object({
  id: Uuid,
  runId: Uuid.nullable(),
  ordinal: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant']),
  status: z.enum(['pending', 'streaming', 'complete', 'failed', 'cancelled']),
  content: z.string(),
  citations: z.array(Citation),
  createdAt: Iso,
  updatedAt: Iso
})
const Skill = z.object({
  skillId: Uuid,
  versionId: Uuid,
  name: z.string(),
  description: z.string(),
  contentHash: z.string(),
  sourcePath: z.string(),
  versionCreatedAt: Iso,
  status: z.enum(['enabled', 'disabled', 'revoked']),
  drifted: z.boolean(),
  selected: z.boolean(),
  ordinal: z.number().int().nonnegative()
})
const Session = z.object({
  id: Uuid,
  title: z.string(),
  retention: z.enum(['temporary', 'saved']),
  folderId: Uuid.nullable(),
  status: z.enum(['active', 'deletion_pending']),
  executionMode: z.literal('agent'),
  version: z.number().int().positive(),
  providerProfileId: Uuid.nullable(),
  profileResolutionToken: z.string(),
  skills: z.array(Skill),
  currentRun: Run.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  lastActivityAt: Iso,
  expiresAt: Iso.nullable()
})
const Tool = z.object({
  id: z.string(),
  runId: Uuid,
  actionName: z.enum(AGENT_ACTION_NAMES),
  title: z.string(),
  state: z.enum(['preparing', 'running', 'awaitingApproval', 'complete', 'failed', 'denied', 'cancelled']),
  risk: z.enum(['read', 'open-world-read', 'proposal', 'reversible-write', 'destructive-write']),
  summary: z.string().nullable(),
  proposalId: Uuid.nullable(),
  startedAt: Iso,
  completedAt: Iso.nullable()
})
const Task = z.object({
  id: Uuid,
  runId: Uuid,
  kind: z.enum(AGENT_TASK_KINDS),
  title: z.string(),
  question: z.string(),
  sourceScope: z.array(z.string()),
  requiredEvidenceCount: z.number().int().positive(),
  status: z.enum(['pending', 'running', 'blocked', 'completed', 'failed', 'cancelled']),
  subagentRunId: Uuid.nullable(),
  attempt: z.number().int().nonnegative(),
  outcome: z.enum(['completed', 'blocked', 'partial', 'failed']).nullable(),
  evidenceCount: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: Iso,
  startedAt: Iso.nullable(),
  completedAt: Iso.nullable()
})
const CompletionIssue = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() })
const Completion = z.object({ outcome: z.enum(['complete', 'retry', 'blocked', 'partial']), issues: z.array(CompletionIssue) })
const Goal = z.object({
  id: Uuid,
  sessionId: Uuid,
  objective: z.string(),
  status: z.enum(AGENT_GOAL_STATUSES),
  version: z.number().int().positive(),
  currentRunId: Uuid.nullable(),
  continuationCount: z.number().int().nonnegative(),
  maxContinuations: z.number().int().nonnegative(),
  consumedTokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive(),
  consumedToolCalls: z.number().int().nonnegative(),
  maxToolCalls: z.number().int().positive(),
  startedAt: Iso,
  deadlineAt: Iso,
  completedAt: Iso.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  completion: Completion.nullable()
})
const Approval = z.object({
  id: Uuid,
  proposalId: Uuid,
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
  requestedAt: Iso,
  expiresAt: Iso,
  decidedAt: Iso.nullable(),
  decisionNote: z.string().nullable()
})
const PageReference = z.object({
  id: z.number().int().positive(),
  locale: z.string(),
  path: z.string(),
  title: z.string(),
  contentType: z.string(),
  sourceRevision: z.string()
})
const ProposalBase = z.object({
  id: Uuid,
  sourceKind: z.enum(['agent', 'mcp']),
  actionName: z.enum(AGENT_ACTION_NAMES),
  risk: z.enum(['read', 'open-world-read', 'proposal', 'reversible-write', 'destructive-write']),
  status: z.enum(AGENT_PROPOSAL_STATUSES),
  summary: z.string(),
  target: PageReference.nullable(),
  baseSourceRevision: z.string().nullable(),
  authoritySha256: z.string(),
  inputHash: z.string(),
  patchSha256: z.string().nullable(),
  resultCanonicalSha256: z.string().nullable(),
  diffSha256: z.string().nullable(),
  diff: z.string().nullable(),
  expiresAt: Iso,
  approval: Approval.nullable()
})
const Proposal = ProposalBase.extend({ pageLink: z.object({ label: z.string(), href: z.string() }).nullable() })
const Artifact = z.object({
  id: Uuid,
  kind: z.literal('browser-screenshot'),
  mimeType: z.literal('image/png'),
  byteLength: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  createdAt: Iso,
  expiresAt: Iso.nullable(),
  available: z.boolean()
})
const Suggestion = z.object({ id: z.string(), label: z.string(), prompt: z.string() })
const HistoryWindow = z.object({
  messageLimit: z.number().int().positive(),
  hasOlderMessages: z.boolean(),
  runLimit: z.number().int().positive(),
  hasOlderRuns: z.boolean()
})
const Thread = z.object({
  session: Session,
  messages: z.array(Message),
  tools: z.array(Tool),
  tasks: z.array(Task),
  goal: Goal.nullable(),
  proposals: z.array(Proposal),
  artifacts: z.array(Artifact),
  historyWindow: HistoryWindow,
  suggestions: z.array(Suggestion)
})
const LaunchPage = z
  .object({ pageId: z.number().int().positive().nullable(), locale: z.string().nullable(), path: z.string().nullable(), observedUpdatedAt: Iso.nullable() })
  .nullable()
const CreatedThread = Thread.extend({ launchPage: LaunchPage.optional() })
const SessionSummary = z.object({
  id: Uuid,
  title: z.string(),
  retention: z.enum(['temporary', 'saved']),
  folderId: Uuid.nullable(),
  executionMode: z.literal('agent'),
  version: z.number().int().positive(),
  providerProfileId: Uuid.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  lastActivityAt: Iso,
  expiresAt: Iso.nullable(),
  deletedAt: Iso.nullable()
})
const ConversationFolder = z.object({ id: Uuid, name: z.string(), version: z.number().int().positive(), createdAt: Iso, updatedAt: Iso })
const Profile = z.object({
  id: Uuid,
  name: z.string(),
  transport: z.enum(AGENT_PROVIDER_TRANSPORTS),
  model: z.string(),
  utilityModel: z.string().nullable(),
  destinationHost: z.string(),
  capabilities: z.object({
    streaming: z.boolean(),
    toolCalling: z.enum(['native', 'prompt']),
    parallelToolCalls: z.boolean(),
    structuredOutput: z.enum(['native-json-schema', 'tool-result', 'prompt-only']),
    usage: z.enum(['stream', 'terminal', 'estimated']),
    cancellation: z.literal(true),
    maxContextTokens: z.number(),
    maxOutputTokens: z.number()
  }),
  capabilityRevision: z.string(),
  policyVersion: z.number().int().positive(),
  isGlobalDefault: z.boolean()
})
const VisibleSkill = z.object({
  id: Uuid,
  versionId: Uuid,
  name: z.string(),
  description: z.string(),
  contentHash: z.string(),
  sourceRevision: z.string(),
  exposureMode: z.enum(['all_agent_users', 'groups', 'owner']),
  isAgentDiscoverable: z.boolean()
})
const PersonalSkill = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string(),
  isAgentDiscoverable: z.boolean(),
  versionId: Uuid,
  contentHash: z.string(),
  skillMarkdown: z.string(),
  createdAt: Iso,
  updatedAt: Iso
})
const MemoryTarget = z.enum(['agent', 'user'])
const MemoryEntry = z.object({ id: Uuid, target: MemoryTarget, content: z.string(), version: z.number().int().positive(), createdAt: Iso, updatedAt: Iso })
const MemoryStore = z.object({ entries: z.array(MemoryEntry), characters: z.number().int().nonnegative(), limit: z.number().int().positive() })
const MemoryView = z.object({ agent: MemoryStore, user: MemoryStore })
const MemoryMutation = z.object({
  changed: z.boolean(),
  message: z.string(),
  target: MemoryTarget,
  entries: z.array(z.string()),
  characters: z.number().int().nonnegative(),
  limit: z.number().int().positive()
})
const McpProposal = z.object({
  id: Uuid,
  actionName: z.enum(AGENT_ACTION_NAMES),
  risk: z.enum(['proposal', 'destructive-write']),
  status: z.enum(AGENT_PROPOSAL_STATUSES),
  summary: z.string(),
  pageId: z.number().int().positive().nullable(),
  path: z.string().nullable(),
  baseSourceRevision: z.string().nullable(),
  inputHash: z.string(),
  patchHash: z.string().nullable(),
  diffHash: z.string().nullable(),
  diff: z.string().nullable(),
  expiresAt: Iso,
  confirmationPath: z.string().nullable(),
  approval: z.object({
    id: Uuid,
    status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
    requestedAt: Iso,
    expiresAt: Iso,
    decidedAt: Iso.nullable()
  })
})

export type AgentSessionSummary = z.infer<typeof SessionSummary>
export type { AgentConversationFolderView }
export type VisibleAgentSkill = z.infer<typeof VisibleSkill>
export type PersonalAgentSkill = z.infer<typeof PersonalSkill>
export type AgentMemoryTarget = z.infer<typeof MemoryTarget>
export type AgentMemoryEntry = z.infer<typeof MemoryEntry>
export type AgentMemoryView = z.infer<typeof MemoryView>
export interface CreatedAgentThread extends AgentThreadState {
  readonly launchPage?: z.infer<typeof LaunchPage>
}
export type McpAgentProposal = z.infer<typeof McpProposal>
export interface AgentSessionPage {
  readonly sessions: AgentSessionSummary[]
  readonly nextCursor: string | null
}

export interface ListAgentSessionsOptions {
  readonly limit?: number
  readonly cursor?: string
  readonly signal?: AbortSignal
}

const MAX_ERROR_MESSAGE_LENGTH = 512
const MAX_CURSOR_LENGTH = 512

const fallbackErrorMessage = (status: number): string => {
  if (status === 401) return 'Your Wiki session expired. Sign in again and retry.'
  if (status === 403)
    return 'Wiki Agent rejected this request. Refresh the page, then verify your Agent permission and the configured Site Host if it persists.'
  if (status === 409) return 'The Wiki Agent conversation changed. Refresh it and retry.'
  if (status === 429) return 'Wiki Agent is at its current usage limit. Retry later.'
  return `Agent request failed (${status})`
}

const retryableStatus = (status: number): boolean => status === 408 || status === 425 || status === 429 || status >= 500

const invalidRequest = (message: string): AgentApiError => new AgentApiError(400, message)
const assertUuid = (value: string, label: string): void => {
  if (!Uuid.safeParse(value).success) throw invalidRequest(`${label} is invalid.`)
}
const assertFolderName = (value: string): string => {
  if (typeof value !== 'string') throw invalidRequest('Conversation folder name is invalid.')
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!name || name.length > 64) throw invalidRequest('Conversation folder names must contain between 1 and 64 characters.')
  return name
}
const assertPositiveVersion = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidRequest('The expected conversation version is invalid.')
}

export class AgentApiError extends Error {
  readonly status: number
  readonly retryable: boolean

  constructor(status: number, message: string) {
    super(message.slice(0, MAX_ERROR_MESSAGE_LENGTH))
    this.name = 'AgentApiError'
    this.status = status
    this.retryable = retryableStatus(status)
  }
}

const errorMessage = async (response: Response): Promise<string> => {
  const fallback = fallbackErrorMessage(response.status)
  try {
    const parsed = z.object({ message: z.string().optional(), error: z.string().optional() }).parse(await response.json())
    const supplied = parsed.message?.trim() || parsed.error?.trim()
    return (supplied || fallback).slice(0, MAX_ERROR_MESSAGE_LENGTH)
  } catch {
    return fallback
  }
}

const requestJson = async <T>(fetcher: typeof fetch, csrfToken: string, path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> => {
  const response = await sameOriginJsonFetch(fetcher, path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.method && init.method !== 'GET' ? { 'x-wiki-csrf': csrfToken } : {}),
      ...init.headers
    }
  })
  if (!response.ok) throw new AgentApiError(response.status, await errorMessage(response))
  try {
    return schema.parse(await response.json())
  } catch (value) {
    if (value instanceof DOMException && value.name === 'AbortError') throw value
    throw new AgentApiError(502, 'Agent returned an invalid response. Try again.')
  }
}

export const listAgentSessions = async (fetcher: typeof fetch, csrfToken: string, options: ListAgentSessionsOptions = {}): Promise<AgentSessionPage> => {
  const query = new URLSearchParams()
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
      throw invalidRequest('Session history limit must be between 1 and 100.')
    query.set('limit', String(options.limit))
  }
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== 'string' || options.cursor.length < 1 || options.cursor.length > MAX_CURSOR_LENGTH)
      throw invalidRequest('Session history cursor is invalid.')
    query.set('cursor', options.cursor)
  }
  const encodedQuery = query.toString()
  const suffix = encodedQuery ? `?${encodedQuery}` : ''
  return requestJson(
    fetcher,
    csrfToken,
    `/_api/agents/sessions${suffix}`,
    z.object({ sessions: z.array(SessionSummary), nextCursor: z.string().min(1).max(MAX_CURSOR_LENGTH).nullable() }),
    { signal: options.signal }
  )
}

export const listAgentConversationFolders = async (fetcher: typeof fetch, csrfToken: string, signal?: AbortSignal): Promise<AgentConversationFolderView[]> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/conversation-folders', z.object({ folders: z.array(ConversationFolder) }), { signal })).folders

export const createAgentConversationFolder = async (fetcher: typeof fetch, csrfToken: string, name: string): Promise<AgentConversationFolderView> => {
  const normalizedName = assertFolderName(name)
  return (
    await requestJson(fetcher, csrfToken, '/_api/agents/conversation-folders', z.object({ folder: ConversationFolder }), {
      method: 'POST',
      body: JSON.stringify({ name: normalizedName })
    })
  ).folder
}

export const renameAgentConversationFolder = async (
  fetcher: typeof fetch,
  csrfToken: string,
  folderId: string,
  expectedVersion: number,
  name: string
): Promise<AgentConversationFolderView> => {
  assertUuid(folderId, 'Folder ID')
  assertPositiveVersion(expectedVersion)
  const normalizedName = assertFolderName(name)
  return (
    await requestJson(fetcher, csrfToken, `/_api/agents/conversation-folders/${encodeURIComponent(folderId)}`, z.object({ folder: ConversationFolder }), {
      method: 'PATCH',
      body: JSON.stringify({ expectedVersion, name: normalizedName })
    })
  ).folder
}

export const deleteAgentConversationFolder = async (fetcher: typeof fetch, csrfToken: string, folderId: string): Promise<number> => {
  assertUuid(folderId, 'Folder ID')
  return (
    await requestJson(
      fetcher,
      csrfToken,
      `/_api/agents/conversation-folders/${encodeURIComponent(folderId)}`,
      z.object({ deleted: z.literal(true), movedSessions: z.number().int().nonnegative() }),
      { method: 'DELETE' }
    )
  ).movedSessions
}

export const createAgentThread = (fetcher: typeof fetch, csrfToken: string, input: CreateAgentSessionRequest): Promise<CreatedAgentThread> => {
  if (input.providerProfileId !== null) assertUuid(input.providerProfileId, 'Provider profile ID')
  return requestJson(fetcher, csrfToken, '/_api/agents/sessions', CreatedThread, { method: 'POST', body: JSON.stringify(input) }) as Promise<CreatedAgentThread>
}

export const getAgentThread = (fetcher: typeof fetch, csrfToken: string, sessionId: string, signal?: AbortSignal): Promise<AgentThreadState> => {
  assertUuid(sessionId, 'Session ID')
  return requestJson(fetcher, csrfToken, `/_api/agents/sessions/${encodeURIComponent(sessionId)}`, Thread, { signal }) as Promise<AgentThreadState>
}
export const moveAgentSessionToFolder = (
  fetcher: typeof fetch,
  csrfToken: string,
  sessionId: string,
  input: UpdateAgentSessionFolderRequest
): Promise<AgentThreadState> => {
  assertUuid(sessionId, 'Session ID')
  assertPositiveVersion(input.expectedSessionVersion)
  if (input.folderId !== null) assertUuid(input.folderId, 'Folder ID')
  return requestJson(fetcher, csrfToken, `/_api/agents/sessions/${encodeURIComponent(sessionId)}/folder`, Thread, {
    method: 'PUT',
    body: JSON.stringify(input)
  }) as Promise<AgentThreadState>
}

export const updateAgentSession = (
  fetcher: typeof fetch,
  csrfToken: string,
  sessionId: string,
  input: {
    readonly expectedSessionVersion: number
    readonly title?: string
    readonly retention?: 'temporary' | 'saved'
  }
): Promise<AgentThreadState> => {
  assertUuid(sessionId, 'Session ID')
  assertPositiveVersion(input.expectedSessionVersion)
  return requestJson(fetcher, csrfToken, `/_api/agents/sessions/${encodeURIComponent(sessionId)}`, Thread, {
    method: 'PATCH',
    body: JSON.stringify(input)
  }) as Promise<AgentThreadState>
}

export const deleteAgentSession = async (fetcher: typeof fetch, csrfToken: string, sessionId: string): Promise<void> => {
  assertUuid(sessionId, 'Session ID')
  const response = await sameOriginJsonFetch(fetcher, `/_api/agents/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'x-wiki-csrf': csrfToken }
  })
  if (!response.ok) throw new AgentApiError(response.status, await errorMessage(response))
}
export const clearUnfiledAgentHistory = async (fetcher: typeof fetch, csrfToken: string): Promise<void> => {
  const response = await sameOriginJsonFetch(fetcher, '/_api/agents/sessions', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'x-wiki-csrf': csrfToken }
  })
  if (!response.ok) throw new AgentApiError(response.status, await errorMessage(response))
}

export const getAgentMemories = (fetcher: typeof fetch, csrfToken: string, signal?: AbortSignal): Promise<AgentMemoryView> =>
  requestJson(fetcher, csrfToken, '/_api/agents/memories', MemoryView, { signal })

export const createAgentMemory = (fetcher: typeof fetch, csrfToken: string, input: { readonly target: AgentMemoryTarget; readonly content: string }) =>
  requestJson(fetcher, csrfToken, '/_api/agents/memories', MemoryMutation, { method: 'POST', body: JSON.stringify(input) })

export const updateAgentMemory = (
  fetcher: typeof fetch,
  csrfToken: string,
  memoryId: string,
  input: { readonly expectedVersion: number; readonly target: AgentMemoryTarget; readonly content: string }
) => requestJson(fetcher, csrfToken, `/_api/agents/memories/${encodeURIComponent(memoryId)}`, MemoryMutation, { method: 'PUT', body: JSON.stringify(input) })

export const removeAgentMemory = (fetcher: typeof fetch, csrfToken: string, memoryId: string, expectedVersion: number) =>
  requestJson(
    fetcher,
    csrfToken,
    `/_api/agents/memories/${encodeURIComponent(memoryId)}?expectedVersion=${encodeURIComponent(String(expectedVersion))}`,
    MemoryMutation,
    { method: 'DELETE' }
  )

export const clearAgentMemories = async (fetcher: typeof fetch, csrfToken: string): Promise<number> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/memories', z.object({ removed: z.number().int().nonnegative() }), { method: 'DELETE' })).removed

export const submitAgentMessage = async (fetcher: typeof fetch, csrfToken: string, sessionId: string, input: SubmitAgentMessageRequest) =>
  (
    await requestJson(fetcher, csrfToken, `/_api/agents/sessions/${encodeURIComponent(sessionId)}/messages`, z.object({ run: Run, replayed: z.boolean() }), {
      method: 'POST',
      body: JSON.stringify(input)
    })
  ).run

export const cancelAgentRun = async (fetcher: typeof fetch, csrfToken: string, runId: string) =>
  (
    await requestJson(
      fetcher,
      csrfToken,
      `/_api/agents/runs/${encodeURIComponent(runId)}/cancel`,
      z.object({ run: z.object({ id: Uuid, status: RunStatus }).passthrough() }),
      { method: 'POST' }
    )
  ).run
export const createAgentGoal = async (fetcher: typeof fetch, csrfToken: string, sessionId: string, input: CreateAgentGoalRequest) =>
  requestJson(fetcher, csrfToken, `/_api/agents/sessions/${encodeURIComponent(sessionId)}/goals`, z.object({ goal: Goal, run: Run, replayed: z.boolean() }), {
    method: 'POST',
    body: JSON.stringify(input)
  })

export const pauseAgentGoal = async (fetcher: typeof fetch, csrfToken: string, goalId: string, input: PauseAgentGoalRequest) =>
  (
    await requestJson(fetcher, csrfToken, `/_api/agents/goals/${encodeURIComponent(goalId)}/pause`, z.object({ goal: Goal }), {
      method: 'POST',
      body: JSON.stringify(input)
    })
  ).goal

export const resumeAgentGoal = async (fetcher: typeof fetch, csrfToken: string, goalId: string, input: ResumeAgentGoalRequest) =>
  requestJson(
    fetcher,
    csrfToken,
    `/_api/agents/goals/${encodeURIComponent(goalId)}/resume`,
    z.object({ goal: Goal, run: Run.nullable(), replayed: z.boolean() }),
    { method: 'POST', body: JSON.stringify(input) }
  )

export const cancelAgentGoal = async (fetcher: typeof fetch, csrfToken: string, goalId: string, input: CancelAgentGoalRequest) =>
  (
    await requestJson(fetcher, csrfToken, `/_api/agents/goals/${encodeURIComponent(goalId)}/cancel`, z.object({ goal: Goal }), {
      method: 'POST',
      body: JSON.stringify(input)
    })
  ).goal

export const decideAgentProposal = async (
  fetcher: typeof fetch,
  csrfToken: string,
  proposalId: string,
  approvalId: string,
  input: DecideAgentApprovalRequest
) =>
  requestJson(
    fetcher,
    csrfToken,
    `/_api/agents/proposals/${encodeURIComponent(proposalId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
    z.object({
      proposalId: Uuid,
      approvalId: Uuid,
      status: z.enum(['approved', 'denied']),
      decidedAt: Iso
    }),
    { method: 'POST', body: JSON.stringify(input) }
  )

export const getMcpAgentProposal = async (fetcher: typeof fetch, csrfToken: string, proposalId: string, signal?: AbortSignal): Promise<McpAgentProposal> =>
  (await requestJson(fetcher, csrfToken, `/_api/agents/mcp-proposals/${encodeURIComponent(proposalId)}`, z.object({ proposal: McpProposal }), { signal }))
    .proposal

export const listAgentProfiles = async (fetcher: typeof fetch, csrfToken: string, signal?: AbortSignal): Promise<AgentProviderProfileView[]> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/profiles', z.object({ profiles: z.array(Profile) }), { signal })).profiles as AgentProviderProfileView[]

export const updateAgentProfile = (
  fetcher: typeof fetch,
  csrfToken: string,
  sessionId: string,
  input: UpdateAgentSessionProfileRequest
): Promise<AgentThreadState> => {
  assertUuid(sessionId, 'Session ID')
  assertPositiveVersion(input.expectedSessionVersion)
  if (input.providerProfileId !== null) assertUuid(input.providerProfileId, 'Provider profile ID')
  return requestJson(fetcher, csrfToken, `/_api/agents/sessions/${encodeURIComponent(sessionId)}/profile`, Thread, {
    method: 'PUT',
    body: JSON.stringify({ expectedSessionVersion: input.expectedSessionVersion, profileId: input.providerProfileId })
  }) as Promise<AgentThreadState>
}

export const listAgentSkills = async (fetcher: typeof fetch, csrfToken: string, signal?: AbortSignal): Promise<VisibleAgentSkill[]> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/skills', z.object({ skills: z.array(VisibleSkill) }), { signal })).skills

export const listPersonalAgentSkills = async (fetcher: typeof fetch, csrfToken: string, signal?: AbortSignal): Promise<PersonalAgentSkill[]> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/personal-skills', z.object({ skills: z.array(PersonalSkill) }), { signal })).skills

export const createPersonalAgentSkill = async (
  fetcher: typeof fetch,
  csrfToken: string,
  input: { readonly name: string; readonly skillMarkdown: string; readonly isAgentDiscoverable: boolean }
): Promise<PersonalAgentSkill> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/personal-skills', z.object({ skill: PersonalSkill }), { method: 'POST', body: JSON.stringify(input) }))
    .skill

export const updatePersonalAgentSkill = async (
  fetcher: typeof fetch,
  csrfToken: string,
  skillId: string,
  input: { readonly expectedVersionId: string; readonly skillMarkdown: string; readonly isAgentDiscoverable: boolean }
): Promise<PersonalAgentSkill> =>
  (
    await requestJson(fetcher, csrfToken, `/_api/agents/personal-skills/${encodeURIComponent(skillId)}`, z.object({ skill: PersonalSkill }), {
      method: 'PUT',
      body: JSON.stringify(input)
    })
  ).skill

export const removePersonalAgentSkill = async (fetcher: typeof fetch, csrfToken: string, skillId: string, expectedVersionId: string): Promise<void> => {
  await requestJson(fetcher, csrfToken, `/_api/agents/personal-skills/${encodeURIComponent(skillId)}`, z.object({ deleted: z.literal(true) }), {
    method: 'DELETE',
    body: JSON.stringify({ expectedVersionId })
  })
}
export const updateAgentSkillPreferences = async (
  fetcher: typeof fetch,
  csrfToken: string,
  input: UpdateAgentSkillPreferencesRequest
): Promise<readonly string[]> =>
  (
    await requestJson(fetcher, csrfToken, '/_api/agents/skill-preferences', z.object({ skillIds: z.array(Uuid).max(8) }), {
      method: 'PUT',
      body: JSON.stringify({ ...input, transportRequestId: crypto.randomUUID() })
    })
  ).skillIds

export const subscribeAgentRun = (
  runId: string,
  after: number,
  handlers: { readonly event: (type: AgentEventType, sequence: number) => void; readonly error: () => void }
): EventSource => {
  const source = new EventSource(`/_api/agents/runs/${encodeURIComponent(runId)}/events?after=${after}`)
  for (const type of AGENT_EVENT_TYPES) {
    source.addEventListener(type, event => {
      const eventId = (event as MessageEvent).lastEventId
      const sequence = /^[1-9]\d*$/.test(eventId) ? Number(eventId) : Number.NaN
      handlers.event(type, Number.isSafeInteger(sequence) && sequence > after ? sequence : after)
    })
  }
  source.addEventListener('error', handlers.error)
  return source
}
