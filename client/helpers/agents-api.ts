import { z } from 'zod'
import { AGENT_ACTION_NAMES, AGENT_EVENT_TYPES, type AgentEventType, type AgentProviderProfileView, type AgentThreadState, type CreateAgentSessionRequest, type SubmitAgentMessageRequest, type UpdateAgentSessionProfileRequest, type UpdateAgentSkillPreferencesRequest } from '../../shared/agents/contracts.ts'

const Iso = z.iso.datetime()
const Uuid = z.uuid()
const RunStatus = z.enum(['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'recovery_required'])
const Run = z.object({ id: Uuid, sessionId: Uuid, status: RunStatus, attempt: z.number().int().nonnegative(), eventSequence: z.number().int().nonnegative(), canCancel: z.boolean(), createdAt: Iso, startedAt: Iso.nullable(), completedAt: Iso.nullable(), errorCode: z.string().nullable(), errorMessage: z.string().nullable() })
const Citation = z.object({ evidenceId: z.string(), kind: z.enum(['page', 'search-result', 'skill', 'browser']), label: z.string(), href: z.string().nullable() })
const Message = z.object({ id: Uuid, runId: Uuid.nullable(), ordinal: z.number().int().nonnegative(), role: z.enum(['user', 'assistant']), status: z.enum(['pending', 'streaming', 'complete', 'failed', 'cancelled']), content: z.string(), citations: z.array(Citation), createdAt: Iso, updatedAt: Iso })
const Skill = z.object({ skillId: Uuid, versionId: Uuid, name: z.string(), description: z.string(), contentHash: z.string(), sourcePath: z.string(), versionCreatedAt: Iso, status: z.enum(['enabled', 'disabled', 'revoked']), drifted: z.boolean(), selected: z.boolean(), ordinal: z.number().int().nonnegative() })
const Session = z.object({ id: Uuid, title: z.string(), retention: z.enum(['temporary', 'saved']), status: z.enum(['active', 'deletion_pending']), executionMode: z.literal('agent'), version: z.number().int().positive(), providerProfileId: Uuid.nullable(), profileResolutionToken: z.string(), skills: z.array(Skill), currentRun: Run.nullable(), createdAt: Iso, updatedAt: Iso, lastActivityAt: Iso, expiresAt: Iso.nullable() })
const Tool = z.object({ id: z.string(), runId: Uuid, actionName: z.enum(AGENT_ACTION_NAMES), title: z.string(), state: z.enum(['preparing', 'running', 'awaitingApproval', 'complete', 'failed', 'denied', 'cancelled']), risk: z.enum(['read', 'open-world-read', 'proposal', 'reversible-write', 'destructive-write']), summary: z.string().nullable(), proposalId: Uuid.nullable(), startedAt: Iso, completedAt: Iso.nullable() })
const Approval = z.object({ id: Uuid, proposalId: Uuid, status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']), requestedAt: Iso, expiresAt: Iso, decidedAt: Iso.nullable(), decisionNote: z.string().nullable() })
const PageReference = z.object({ id: z.number().int().positive(), locale: z.string(), path: z.string(), title: z.string(), contentType: z.string(), sourceRevision: z.string() })
const ProposalBase = z.object({ id: Uuid, sourceKind: z.enum(['agent', 'mcp']), actionName: z.enum(AGENT_ACTION_NAMES), risk: z.enum(['read', 'open-world-read', 'proposal', 'reversible-write', 'destructive-write']), status: z.enum(['pending', 'approved', 'denied', 'expired', 'applying', 'applied', 'failed', 'cancelled']), summary: z.string(), target: PageReference.nullable(), baseSourceRevision: z.string().nullable(), authoritySha256: z.string(), inputHash: z.string(), patchSha256: z.string().nullable(), resultCanonicalSha256: z.string().nullable(), diffSha256: z.string().nullable(), diff: z.string().nullable(), expiresAt: Iso, approval: Approval.nullable() })
const Proposal = ProposalBase.extend({ pageLink: z.object({ label: z.string(), href: z.string() }).nullable() })
const Artifact = z.object({ id: Uuid, kind: z.literal('browser-screenshot'), mimeType: z.literal('image/png'), byteLength: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive(), createdAt: Iso, expiresAt: Iso.nullable(), available: z.boolean() })
const Suggestion = z.object({ id: z.string(), label: z.string(), prompt: z.string() })
const Thread = z.object({ session: Session, messages: z.array(Message), tools: z.array(Tool), proposals: z.array(Proposal), artifacts: z.array(Artifact), suggestions: z.array(Suggestion) })
const LaunchPage = z.object({ pageId: z.number().int().positive().nullable(), locale: z.string().nullable(), path: z.string().nullable(), observedUpdatedAt: Iso.nullable() }).nullable()
const CreatedThread = Thread.extend({ launchPage: LaunchPage.optional() })
const SessionSummary = z.object({ id: Uuid, title: z.string(), retention: z.enum(['temporary', 'saved']), executionMode: z.literal('agent'), version: z.number().int().positive(), providerProfileId: Uuid.nullable(), createdAt: Iso, updatedAt: Iso, lastActivityAt: Iso, expiresAt: Iso.nullable(), deletedAt: Iso.nullable() })
const Profile = z.object({ id: Uuid, name: z.string(), transport: z.enum(['openai-responses', 'openresponses', 'openai-chat', 'anthropic-messages']), model: z.string(), destinationHost: z.string(), capabilities: z.object({ streaming: z.literal(true), functions: z.literal(true), parallelFunctions: z.boolean(), structuredOutput: z.enum(['native-json-schema', 'tool-result', 'prompt-only']), usage: z.enum(['stream', 'terminal', 'estimated']), cancellation: z.literal(true), maxContextTokens: z.number(), maxOutputTokens: z.number() }), capabilityRevision: z.string(), policyVersion: z.number().int().positive(), isGlobalDefault: z.boolean() })
const VisibleSkill = z.object({ id: Uuid, versionId: Uuid, name: z.string(), description: z.string(), contentHash: z.string(), sourceRevision: z.string(), exposureMode: z.enum(['all_agent_users', 'groups', 'owner']), isAgentDiscoverable: z.boolean() })
const PersonalSkill = z.object({ id: Uuid, name: z.string(), description: z.string(), isAgentDiscoverable: z.boolean(), versionId: Uuid, contentHash: z.string(), skillMarkdown: z.string(), createdAt: Iso, updatedAt: Iso })
const MemoryTarget = z.enum(['agent', 'user'])
const MemoryEntry = z.object({ id: Uuid, target: MemoryTarget, content: z.string(), version: z.number().int().positive(), createdAt: Iso, updatedAt: Iso })
const MemoryStore = z.object({ entries: z.array(MemoryEntry), characters: z.number().int().nonnegative(), limit: z.number().int().positive() })
const MemoryView = z.object({ agent: MemoryStore, user: MemoryStore })
const MemoryMutation = z.object({ changed: z.boolean(), message: z.string(), target: MemoryTarget, entries: z.array(z.string()), characters: z.number().int().nonnegative(), limit: z.number().int().positive() })
const McpProposal = z.object({
  id: Uuid,
  actionName: z.enum(AGENT_ACTION_NAMES),
  risk: z.enum(['proposal', 'destructive-write']),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'applying', 'applied', 'failed', 'cancelled']),
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
export type VisibleAgentSkill = z.infer<typeof VisibleSkill>
export type PersonalAgentSkill = z.infer<typeof PersonalSkill>
export type AgentMemoryTarget = z.infer<typeof MemoryTarget>
export type AgentMemoryEntry = z.infer<typeof MemoryEntry>
export type AgentMemoryView = z.infer<typeof MemoryView>
export interface CreatedAgentThread extends AgentThreadState { readonly launchPage?: z.infer<typeof LaunchPage> }
export type McpAgentProposal = z.infer<typeof McpProposal>

const fallbackErrorMessage = (status: number): string => {
  if (status === 401) return 'Your Wiki session expired. Sign in again and retry.'
  if (status === 403) return 'Wiki Agent rejected this request. Refresh the page, then verify your Agent permission and the configured Site Host if it persists.'
  if (status === 409) return 'The Wiki Agent conversation changed. Refresh it and retry.'
  if (status === 429) return 'Wiki Agent is at its current usage limit. Retry later.'
  return `Agent request failed (${status})`
}

const errorMessage = async (response: Response): Promise<string> => {
  const fallback = fallbackErrorMessage(response.status)
  try {
    const parsed = z.object({ message: z.string().optional(), error: z.string().optional() }).parse(await response.json())
    return (parsed.message ?? parsed.error ?? fallback).slice(0, 512)
  } catch {
    return fallback
  }
}

const requestJson = async <T>(fetcher: typeof fetch, csrfToken: string, path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> => {
  const response = await fetcher(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.method && init.method !== 'GET' ? { 'x-wiki-csrf': csrfToken } : {}),
      ...init.headers
    }
  })
  if (!response.ok) throw new Error(await errorMessage(response))
  return schema.parse(await response.json())
}

export const listAgentSessions = async (fetcher: typeof fetch, csrfToken: string): Promise<AgentSessionSummary[]> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/sessions', z.object({ sessions: z.array(SessionSummary) }))).sessions

export const createAgentThread = (fetcher: typeof fetch, csrfToken: string, input: CreateAgentSessionRequest): Promise<CreatedAgentThread> =>
  requestJson(fetcher, csrfToken, '/_api/agents/sessions', CreatedThread, { method: 'POST', body: JSON.stringify(input) }) as Promise<CreatedAgentThread>

export const getAgentThread = (fetcher: typeof fetch, csrfToken: string, sessionId: string): Promise<AgentThreadState> =>
  requestJson(fetcher, csrfToken, `/_api/agents/sessions/${encodeURIComponent(sessionId)}`, Thread) as Promise<AgentThreadState>

export const deleteAgentSession = async (fetcher: typeof fetch, csrfToken: string, sessionId: string): Promise<void> => {
  const response = await fetcher(`/_api/agents/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-wiki-csrf': csrfToken } })
  if (!response.ok) throw new Error(await errorMessage(response))
}
export const resetAgentHistory = async (fetcher: typeof fetch, csrfToken: string): Promise<void> => {
  const response = await fetcher('/_api/agents/sessions', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-wiki-csrf': csrfToken } })
  if (!response.ok) throw new Error(await errorMessage(response))
}

export const getAgentMemories = (fetcher: typeof fetch, csrfToken: string): Promise<AgentMemoryView> =>
  requestJson(fetcher, csrfToken, '/_api/agents/memories', MemoryView)

export const createAgentMemory = (fetcher: typeof fetch, csrfToken: string, input: { readonly target: AgentMemoryTarget, readonly content: string }) =>
  requestJson(fetcher, csrfToken, '/_api/agents/memories', MemoryMutation, { method: 'POST', body: JSON.stringify(input) })

export const updateAgentMemory = (fetcher: typeof fetch, csrfToken: string, memoryId: string, input: { readonly expectedVersion: number, readonly target: AgentMemoryTarget, readonly content: string }) =>
  requestJson(fetcher, csrfToken, `/_api/agents/memories/${encodeURIComponent(memoryId)}`, MemoryMutation, { method: 'PUT', body: JSON.stringify(input) })

export const removeAgentMemory = (fetcher: typeof fetch, csrfToken: string, memoryId: string, expectedVersion: number) =>
  requestJson(fetcher, csrfToken, `/_api/agents/memories/${encodeURIComponent(memoryId)}?expectedVersion=${encodeURIComponent(String(expectedVersion))}`, MemoryMutation, { method: 'DELETE' })

export const clearAgentMemories = async (fetcher: typeof fetch, csrfToken: string): Promise<number> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/memories', z.object({ removed: z.number().int().nonnegative() }), { method: 'DELETE' })).removed

export const submitAgentMessage = async (fetcher: typeof fetch, csrfToken: string, sessionId: string, input: SubmitAgentMessageRequest) =>
  (await requestJson(fetcher, csrfToken, `/_api/agents/sessions/${encodeURIComponent(sessionId)}/messages`, z.object({ run: Run, replayed: z.boolean() }), { method: 'POST', body: JSON.stringify(input) })).run

export const cancelAgentRun = async (fetcher: typeof fetch, csrfToken: string, runId: string) =>
  (await requestJson(fetcher, csrfToken, `/_api/agents/runs/${encodeURIComponent(runId)}/cancel`, z.object({ run: z.object({ id: Uuid, status: RunStatus }).passthrough() }), { method: 'POST' })).run

export const decideAgentProposal = async (
  fetcher: typeof fetch,
  csrfToken: string,
  proposalId: string,
  approvalId: string,
  input: { readonly decision: 'approved' | 'denied'; readonly decisionNote?: string; readonly confirmationPath?: string }
) => requestJson(fetcher, csrfToken, `/_api/agents/proposals/${encodeURIComponent(proposalId)}/approvals/${encodeURIComponent(approvalId)}/decision`, z.object({
  proposalId: Uuid,
  approvalId: Uuid,
  status: z.enum(['approved', 'denied']),
  decidedAt: Iso
}), { method: 'POST', body: JSON.stringify(input) })

export const getMcpAgentProposal = async (fetcher: typeof fetch, csrfToken: string, proposalId: string): Promise<McpAgentProposal> =>
  (await requestJson(fetcher, csrfToken, `/_api/agents/mcp-proposals/${encodeURIComponent(proposalId)}`, z.object({ proposal: McpProposal }))).proposal

export const listAgentProfiles = async (fetcher: typeof fetch, csrfToken: string): Promise<AgentProviderProfileView[]> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/profiles', z.object({ profiles: z.array(Profile) }))).profiles as AgentProviderProfileView[]

export const updateAgentProfile = (fetcher: typeof fetch, csrfToken: string, sessionId: string, input: UpdateAgentSessionProfileRequest): Promise<AgentThreadState> =>
  requestJson(fetcher, csrfToken, `/_api/agents/sessions/${encodeURIComponent(sessionId)}/profile`, Thread, { method: 'PUT', body: JSON.stringify({ expectedSessionVersion: input.expectedSessionVersion, profileId: input.providerProfileId }) }) as Promise<AgentThreadState>

export const listAgentSkills = async (fetcher: typeof fetch, csrfToken: string): Promise<VisibleAgentSkill[]> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/skills', z.object({ skills: z.array(VisibleSkill) }))).skills


export const listPersonalAgentSkills = async (fetcher: typeof fetch, csrfToken: string): Promise<PersonalAgentSkill[]> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/personal-skills', z.object({ skills: z.array(PersonalSkill) }))).skills

export const createPersonalAgentSkill = async (
  fetcher: typeof fetch,
  csrfToken: string,
  input: { readonly name: string; readonly skillMarkdown: string; readonly isAgentDiscoverable: boolean }
): Promise<PersonalAgentSkill> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/personal-skills', z.object({ skill: PersonalSkill }), { method: 'POST', body: JSON.stringify(input) })).skill

export const updatePersonalAgentSkill = async (
  fetcher: typeof fetch,
  csrfToken: string,
  skillId: string,
  input: { readonly expectedVersionId: string; readonly skillMarkdown: string; readonly isAgentDiscoverable: boolean }
): Promise<PersonalAgentSkill> =>
  (await requestJson(fetcher, csrfToken, `/_api/agents/personal-skills/${encodeURIComponent(skillId)}`, z.object({ skill: PersonalSkill }), { method: 'PUT', body: JSON.stringify(input) })).skill

export const removePersonalAgentSkill = async (
  fetcher: typeof fetch,
  csrfToken: string,
  skillId: string,
  expectedVersionId: string
): Promise<void> => {
  await requestJson(fetcher, csrfToken, `/_api/agents/personal-skills/${encodeURIComponent(skillId)}`, z.object({ deleted: z.literal(true) }), { method: 'DELETE', body: JSON.stringify({ expectedVersionId }) })
}
export const updateAgentSkillPreferences = async (fetcher: typeof fetch, csrfToken: string, input: UpdateAgentSkillPreferencesRequest): Promise<readonly string[]> =>
  (await requestJson(fetcher, csrfToken, '/_api/agents/skill-preferences', z.object({ skillIds: z.array(Uuid).max(8) }), { method: 'PUT', body: JSON.stringify({ ...input, transportRequestId: crypto.randomUUID() }) })).skillIds

export const subscribeAgentRun = (runId: string, after: number, handlers: { readonly event: (type: AgentEventType, sequence: number) => void; readonly error: () => void }): EventSource => {
  const source = new EventSource(`/_api/agents/runs/${encodeURIComponent(runId)}/events?after=${after}`)
  for (const type of AGENT_EVENT_TYPES) {
    source.addEventListener(type, event => {
      const sequence = Number((event as MessageEvent).lastEventId)
      handlers.event(type, Number.isSafeInteger(sequence) ? sequence : after)
    })
  }
  source.addEventListener('error', handlers.error)
  return source
}
