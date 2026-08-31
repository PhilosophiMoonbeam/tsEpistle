export const AGENT_PERMISSION_KEYS = ['use:agents', 'use:agent-browser', 'use:mcp'] as const

export type AgentPermissionKey = (typeof AGENT_PERMISSION_KEYS)[number]

export const AGENT_FEATURE_FLAG_KEYS = [
  'agents.enabled',
  'agents.provider.enabled',
  'agents.orchestration.enabled',
  'agents.skills.enabled',
  'agents.browser.enabled',
  'agents.proposals.enabled',
  'agents.writes.enabled',
  'agents.writes.create.enabled',
  'agents.writes.patch.enabled',
  'agents.writes.move.enabled',
  'agents.writes.restore.enabled',
  'agents.writes.delete.enabled',
  'agents.mcp.enabled'
] as const

export type AgentFeatureFlagKey = (typeof AGENT_FEATURE_FLAG_KEYS)[number]
export type AgentFeatureFlags = Readonly<Record<AgentFeatureFlagKey, boolean>>

export const AGENT_ACTION_NAMES = [
  'pages.search',
  'pages.searchTags',
  'pages.listTags',
  'pages.discover',
  'pages.get',
  'pages.getOkf',
  'pages.readForPatch',
  'pages.listRecent',
  'pages.listHistory',
  'pages.getVersion',
  'pages.listLinks',
  'pages.related',
  'skills.list',
  'skills.read',
  'memory.manage',
  'browser.navigate',
  'browser.observe',
  'browser.act',
  'browser.extract',
  'browser.screenshot',
  'pages.prepareCreate',
  'pages.preparePatch',
  'pages.prepareMove',
  'pages.prepareRestore',
  'pages.prepareDelete',
  'pages.applyProposal'
] as const

export type AgentActionName = (typeof AGENT_ACTION_NAMES)[number]

export const AGENT_TOOL_NAMES = {
  'pages.search': 'wiki_search_pages',
  'pages.searchTags': 'wiki_search_tags',
  'pages.listTags': 'wiki_list_tags',
  'pages.discover': 'wiki_discover_pages',
  'pages.get': 'wiki_get_page',
  'pages.getOkf': 'wiki_get_page_okf',
  'pages.readForPatch': 'wiki_read_page_for_patch',
  'pages.listRecent': 'wiki_list_recent_pages',
  'pages.listHistory': 'wiki_list_page_history',
  'pages.getVersion': 'wiki_get_page_version',
  'pages.listLinks': 'wiki_list_page_links',
  'pages.related': 'wiki_get_related_pages',
  'skills.list': 'wiki_list_skills',
  'skills.read': 'wiki_read_skill',
  'memory.manage': 'wiki_manage_memory',
  'browser.navigate': 'wiki_browser_navigate',
  'browser.observe': 'wiki_browser_observe',
  'browser.act': 'wiki_browser_act',
  'browser.extract': 'wiki_browser_extract',
  'browser.screenshot': 'wiki_browser_screenshot',
  'pages.prepareCreate': 'wiki_prepare_page_create',
  'pages.preparePatch': 'wiki_prepare_page_patch',
  'pages.prepareMove': 'wiki_prepare_page_move',
  'pages.prepareRestore': 'wiki_prepare_page_restore',
  'pages.prepareDelete': 'wiki_prepare_page_delete',
  'pages.applyProposal': 'wiki_apply_page_proposal'
} as const satisfies Record<AgentActionName, string>

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[keyof typeof AGENT_TOOL_NAMES]
export const AGENT_ACTION_BY_TOOL_NAME = Object.fromEntries(
  Object.entries(AGENT_TOOL_NAMES).map(([actionName, toolName]) => [toolName, actionName])
) as Readonly<Record<AgentToolName, AgentActionName>>
export type AgentTransport = 'agent' | 'mcp'
export type AgentActionRisk = 'read' | 'open-world-read' | 'proposal' | 'reversible-write' | 'destructive-write'
export type AgentExecutionMode = 'agent' | 'generation-only'
export type AgentSessionRetention = 'temporary' | 'saved'
export type AgentSessionStatus = 'active' | 'deletion_pending'
export type AgentRunStatus = 'queued' | 'running' | 'awaiting_approval' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'recovery_required'
export const AGENT_TERMINAL_RUN_STATUSES = ['succeeded', 'partial', 'failed', 'cancelled', 'recovery_required'] as const satisfies readonly AgentRunStatus[]
export type AgentTerminalRunStatus = (typeof AGENT_TERMINAL_RUN_STATUSES)[number]
export const isTerminalAgentRunStatus = (status: AgentRunStatus): status is AgentTerminalRunStatus =>
  AGENT_TERMINAL_RUN_STATUSES.includes(status as AgentTerminalRunStatus)
export type AgentMessageRole = 'user' | 'assistant'
export type AgentMessageStatus = 'pending' | 'streaming' | 'complete' | 'failed' | 'cancelled'
export const AGENT_PROPOSAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'applying', 'applied', 'failed', 'cancelled', 'recovery_required'] as const
export type AgentProposalStatus = (typeof AGENT_PROPOSAL_STATUSES)[number]
export type AgentApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'
export type AgentToolState = 'preparing' | 'running' | 'awaitingApproval' | 'complete' | 'failed' | 'denied' | 'cancelled'
export const AGENT_TASK_KINDS = ['source_scout', 'fact_check', 'conflict_check'] as const
export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number]
export type AgentTaskStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
export type AgentTaskOutcome = 'completed' | 'blocked' | 'partial' | 'failed'
export type AgentEvidenceConfidence = 'high' | 'medium' | 'low'
export const AGENT_GOAL_STATUSES = ['active', 'paused', 'blocked', 'budget_limited', 'completed', 'cancelled', 'failed'] as const
export type AgentGoalStatus = (typeof AGENT_GOAL_STATUSES)[number]
export type AgentCompletionOutcome = 'complete' | 'retry' | 'blocked' | 'partial'

export interface AgentCompletionIssue {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface AgentCompletionAssessment {
  readonly outcome: AgentCompletionOutcome
  readonly issues: readonly AgentCompletionIssue[]
}

export interface AgentEvidenceClaim {
  readonly text: string
  readonly evidenceIds: readonly string[]
  readonly sourceRevisionIds: readonly string[]
  readonly confidence: AgentEvidenceConfidence
  readonly caveat?: string
}

export interface AgentEvidenceConflict {
  readonly claim: string
  readonly evidenceIds: readonly string[]
  readonly explanation: string
}

export interface AgentChildEvidencePacket {
  readonly taskId: string
  readonly outcome: AgentTaskOutcome
  readonly claims: readonly AgentEvidenceClaim[]
  readonly conflicts: readonly AgentEvidenceConflict[]
  readonly unanswered: readonly string[]
  readonly recommendedFollowups: readonly string[]
}

export interface AgentActionExposure {
  readonly agent: boolean
  readonly mcp: boolean
}

export interface AgentActionAnnotations {
  readonly idempotent: boolean
  readonly openWorld: boolean
  readonly sideEffects: boolean
}

export interface AgentActionDescriptor {
  readonly name: AgentActionName
  readonly title: string
  readonly description: string
  readonly risk: AgentActionRisk
  readonly requiredPermissions: readonly string[]
  readonly exposure: AgentActionExposure
  readonly annotations: AgentActionAnnotations
}

export type RequestAuthContext<Principal = unknown> =
  | { readonly kind: 'guest'; readonly ownershipUserId: null; readonly principal: Principal }
  | { readonly kind: 'user'; readonly userId: number; readonly ownershipUserId: number; readonly principal: Principal }
  | { readonly kind: 'apiKey'; readonly apiKeyId: number; readonly groupId: number; readonly ownershipUserId: null; readonly principal: Principal }

export interface AgentCurrentPageHint {
  readonly id: number
  readonly locale: string
  readonly path: string
  readonly observedUpdatedAt: string
}

export interface AgentPageReference {
  readonly id: number
  readonly locale: string
  readonly path: string
  readonly title: string
  readonly contentType: string
  readonly sourceRevision: string
}

export interface AgentPageActionLink {
  readonly label: string
  readonly href: string
}

export interface AgentCitation {
  readonly evidenceId: string
  readonly kind: 'page' | 'search-result' | 'skill' | 'browser'
  readonly label: string
  readonly href: string | null
}

export interface AgentFollowUpSuggestion {
  readonly id: string
  readonly label: string
  readonly prompt: string
}

export interface AgentMessageView {
  readonly id: string
  readonly runId: string | null
  readonly ordinal: number
  readonly role: AgentMessageRole
  readonly status: AgentMessageStatus
  readonly content: string
  readonly citations: readonly AgentCitation[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AgentProviderCapabilities {
  readonly streaming: boolean
  readonly toolCalling: 'native' | 'prompt'
  readonly parallelToolCalls: boolean
  readonly structuredOutput: 'native-json-schema' | 'tool-result' | 'prompt-only'
  readonly usage: 'stream' | 'terminal' | 'estimated'
  readonly cancellation: boolean
  readonly maxContextTokens: number
  readonly maxOutputTokens: number
}

export const AGENT_PROVIDER_TRANSPORTS = ['openai-responses', 'openresponses', 'openai-chat', 'legacy-completions', 'anthropic-messages', 'gemini-api'] as const

export type AgentProviderTransport = (typeof AGENT_PROVIDER_TRANSPORTS)[number]

export const AGENT_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number]

const AGENT_REASONING_EFFORTS_BY_TRANSPORT = {
  'openai-responses': AGENT_REASONING_EFFORTS,
  openresponses: ['none', 'low', 'medium', 'high', 'xhigh'],
  'openai-chat': AGENT_REASONING_EFFORTS,
  'legacy-completions': [],
  'anthropic-messages': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gemini-api': ['minimal', 'low', 'medium', 'high']
} as const satisfies Readonly<Record<AgentProviderTransport, readonly AgentReasoningEffort[]>>

export const agentProviderReasoningEfforts = (transport: AgentProviderTransport): readonly AgentReasoningEffort[] =>
  AGENT_REASONING_EFFORTS_BY_TRANSPORT[transport]

export interface AgentProviderProfileView {
  readonly id: string
  readonly name: string
  readonly transport: AgentProviderTransport
  readonly model: string
  readonly utilityModel: string | null
  readonly destinationHost: string
  readonly capabilities: AgentProviderCapabilities
  readonly capabilityRevision: string
  readonly policyVersion: number
  readonly isGlobalDefault: boolean
}

export interface AgentSkillMetadataView {
  readonly skillId: string
  readonly versionId: string
  readonly name: string
  readonly description: string
  readonly contentHash: string
  readonly sourcePath: string
  readonly versionCreatedAt: string
  readonly status: 'enabled' | 'disabled' | 'revoked'
  readonly drifted: boolean
  readonly selected: boolean
}

export interface AgentSessionSkillView extends AgentSkillMetadataView {
  readonly ordinal: number
}

export interface AgentConversationFolderView {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AgentSessionView {
  readonly id: string
  readonly title: string
  readonly retention: AgentSessionRetention
  readonly folderId: string | null
  readonly status: AgentSessionStatus
  readonly executionMode: AgentExecutionMode
  readonly version: number
  readonly providerProfileId: string | null
  readonly profileResolutionToken: string
  readonly skills: readonly AgentSessionSkillView[]
  readonly currentRun: AgentRunView | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastActivityAt: string
  readonly expiresAt: string | null
}

export interface AgentRunView {
  readonly id: string
  readonly sessionId: string
  readonly status: AgentRunStatus
  readonly attempt: number
  readonly eventSequence: number
  readonly canCancel: boolean
  readonly createdAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export interface AgentToolCallView {
  readonly id: string
  readonly runId: string
  readonly actionName: AgentActionName
  readonly title: string
  readonly state: AgentToolState
  readonly risk: AgentActionRisk
  readonly summary: string | null
  readonly proposalId: string | null
  readonly startedAt: string
  readonly completedAt: string | null
}

export interface AgentTaskView {
  readonly id: string
  readonly runId: string
  readonly kind: AgentTaskKind
  readonly title: string
  readonly question: string
  readonly sourceScope: readonly string[]
  readonly requiredEvidenceCount: number
  readonly status: AgentTaskStatus
  readonly subagentRunId: string | null
  readonly attempt: number
  readonly outcome: AgentTaskOutcome | null
  readonly evidenceCount: number
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
}
export interface AgentGoalView {
  readonly id: string
  readonly sessionId: string
  readonly objective: string
  readonly status: AgentGoalStatus
  readonly version: number
  readonly currentRunId: string | null
  readonly continuationCount: number
  readonly maxContinuations: number
  readonly consumedTokens: number
  readonly maxTokens: number
  readonly consumedToolCalls: number
  readonly maxToolCalls: number
  readonly startedAt: string
  readonly deadlineAt: string
  readonly completedAt: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly completion: AgentCompletionAssessment | null
}

export interface AgentProposalView {
  readonly id: string
  readonly sourceKind: AgentTransport
  readonly actionName: AgentActionName
  readonly risk: AgentActionRisk
  readonly status: AgentProposalStatus
  readonly summary: string
  readonly target: AgentPageReference | null
  readonly pageLink: AgentPageActionLink | null
  readonly baseSourceRevision: string | null
  readonly authoritySha256: string
  readonly inputHash: string
  readonly patchSha256: string | null
  readonly resultCanonicalSha256: string | null
  readonly diffSha256: string | null
  readonly diff: string | null
  readonly expiresAt: string
  readonly approval: AgentApprovalView | null
}

export interface AgentApprovalView {
  readonly id: string
  readonly proposalId: string
  readonly status: AgentApprovalStatus
  readonly requestedAt: string
  readonly expiresAt: string
  readonly decidedAt: string | null
  readonly decisionNote: string | null
}

export interface AgentArtifactView {
  readonly id: string
  readonly kind: 'browser-screenshot'
  readonly mimeType: 'image/png'
  readonly byteLength: number
  readonly width: number
  readonly height: number
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly available: boolean
}

export const AGENT_EVENT_TYPES = [
  'run.queued',
  'run.started',
  'run.attemptStarted',
  'run.attemptSuperseded',
  'run.status',
  'run.interrupted',
  'run.resumed',
  'run.completionAssessed',
  'message.started',
  'message.delta',
  'message.completed',
  'model.turn',
  'evidence.provenance',
  'tool.started',
  'task.planCreated',
  'task.created',
  'task.started',
  'task.blocked',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'subagent.started',
  'subagent.suspended',
  'subagent.completed',
  'subagent.failed',
  'goal.created',
  'goal.status',
  'tool.progress',
  'tool.completed',
  'tool.failed',
  'skill.selected',
  'skill.loaded',
  'skill.read',
  'browser.started',
  'browser.observed',
  'browser.artifact',
  'browser.closed',
  'proposal.created',
  'approval.requested',
  'approval.resolved',
  'usage.updated',
  'run.completed',
  'run.partial',
  'run.failed',
  'run.cancelled',
  'run.recovery_required',
  'suggestions.updated'
] as const

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]
export type AgentEventData = Readonly<Record<string, string | number | boolean | null | readonly unknown[] | Readonly<Record<string, unknown>>>>

export interface AgentEvent {
  readonly id: string
  readonly runId: string
  readonly sequence: number
  readonly type: AgentEventType
  readonly attempt: number
  readonly schemaVersion: 1
  readonly data: AgentEventData
  readonly createdAt: string
}

export interface AgentThreadState {
  readonly session: AgentSessionView
  readonly messages: readonly AgentMessageView[]
  readonly tools: readonly AgentToolCallView[]
  readonly tasks: readonly AgentTaskView[]
  readonly goal: AgentGoalView | null
  readonly proposals: readonly AgentProposalView[]
  readonly artifacts: readonly AgentArtifactView[]
  readonly suggestions: readonly AgentFollowUpSuggestion[]
  readonly historyWindow: {
    readonly messageLimit: number
    readonly hasOlderMessages: boolean
    readonly runLimit: number
    readonly hasOlderRuns: boolean
  }
}

export interface AgentRunState {
  readonly run: AgentRunView
  readonly isConnected: boolean
  readonly reconnectAfterSequence: number
}

export interface CreateAgentSessionRequest {
  readonly retention: AgentSessionRetention
  readonly providerProfileId: string | null
}

export interface UpdateAgentSessionRequest {
  readonly expectedSessionVersion: number
  readonly title?: string
  readonly retention?: AgentSessionRetention
}
export interface UpdateAgentSessionFolderRequest {
  readonly expectedSessionVersion: number
  readonly folderId: string | null
}

export interface UpdateAgentSkillPreferencesRequest {
  readonly skillIds: readonly string[]
}

export interface UpdateAgentSessionProfileRequest {
  readonly expectedSessionVersion: number
  readonly providerProfileId: string | null
}

export interface SubmitAgentMessageRequest {
  readonly clientRequestId: string
  readonly expectedSessionVersion: number
  readonly profileResolutionToken: string
  readonly content: string
  readonly invokedSkillVersionIds?: readonly string[]
  readonly currentPage?: AgentCurrentPageHint
}
export interface CreateAgentGoalRequest {
  readonly goalId: string
  readonly clientRequestId: string
  readonly expectedSessionVersion: number
  readonly profileResolutionToken: string
  readonly objective: string
  readonly invokedSkillVersionIds?: readonly string[]
  readonly currentPage?: AgentCurrentPageHint
}

export interface PauseAgentGoalRequest {
  readonly expectedVersion: number
}

export interface ResumeAgentGoalRequest {
  readonly expectedVersion: number
  readonly runId: string
  readonly clientRequestId: string
}

export interface CancelAgentGoalRequest {
  readonly expectedVersion: number
}

export interface DecideAgentApprovalRequest {
  readonly decision: 'approved' | 'denied'
  readonly decisionNote?: string
  readonly confirmationPath?: string
}

export interface WikiLineAnchorV1 {
  readonly line: number
  readonly tag: string
}

export interface WikiLineSnapshotV1 {
  readonly version: 'wiki-line-snapshot-v1'
  readonly page: {
    readonly id: number
    readonly locale: string
    readonly path: string
    readonly contentType: 'markdown'
  }
  readonly revision: {
    readonly sourceRevision: string
    readonly rawSha256: string
    readonly canonicalSha256: string
  }
  readonly documentTag: string
  readonly lineEnding: 'lf' | 'crlf'
  readonly finalNewline: boolean
  readonly disclosed: readonly {
    readonly startLine: number
    readonly endLine: number
    readonly lines: readonly {
      readonly number: number
      readonly tag: string
      readonly text: string
    }[]
  }[]
  readonly snapshotToken: string
}

export type WikiLinePatchOperationV1 =
  | {
      readonly kind: 'insert'
      readonly gap: {
        readonly after: WikiLineAnchorV1 | null
        readonly before: WikiLineAnchorV1 | null
      }
      readonly lines: readonly string[]
    }
  | {
      readonly kind: 'replace'
      readonly range: {
        readonly start: WikiLineAnchorV1
        readonly end: WikiLineAnchorV1
      }
      readonly lines: readonly string[]
    }
  | {
      readonly kind: 'delete'
      readonly range: {
        readonly start: WikiLineAnchorV1
        readonly end: WikiLineAnchorV1
      }
    }

export interface WikiLinePatchV1 {
  readonly version: 'wiki-line-patch-v1'
  readonly snapshotToken: string
  readonly baseDocumentTag: string
  readonly resultFinalNewline: boolean
  readonly operations: readonly WikiLinePatchOperationV1[]
}

export interface AgentUsageUpdate {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number | null
  readonly reasoningTokens: number | null
  readonly estimatedCostMicros: number | null
}

export interface AgentFinalResponse {
  readonly content: string
  readonly citations: readonly AgentCitation[]
  readonly suggestions: readonly AgentFollowUpSuggestion[]
}

export type BrowserActKind = 'scrollIntoView' | 'followLink'

export interface BrowserObservation {
  readonly contextId: string
  readonly documentEpoch: string
  readonly url: string
  readonly title: string
  readonly text: string
  readonly refs: readonly {
    readonly ref: string
    readonly role: string
    readonly name: string
    readonly href: string | null
  }[]
  readonly observedAt: string
}
