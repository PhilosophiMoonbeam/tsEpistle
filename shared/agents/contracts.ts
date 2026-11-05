import { z } from 'zod'
import { AgentCurrentPageHintSchema, type AgentKnowledgeContext } from './knowledge-context.ts'
import type { SpecialistInvocationView } from './specialists.ts'
import type { AgentMediaInputs, AgentMediaKind } from './media-providers.ts'
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
  'glossary.list',
  'glossary.get',
  'skills.list',
  'skills.read',
  'memory.manage',
  'media.generateImage',
  'media.generateVideo',
  'media.generateMusic',
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
export const TOOL_DISCOVERY_CONTROL_NAME = 'wiki_enable_tools' as const
export const AGENT_TOOL_CONTROL_NAMES = [TOOL_DISCOVERY_CONTROL_NAME] as const
export type AgentToolControlName = (typeof AGENT_TOOL_CONTROL_NAMES)[number]
export const AGENT_TOOL_CALL_NAMES = [...AGENT_ACTION_NAMES, ...AGENT_TOOL_CONTROL_NAMES] as const
export type ExternalMcpToolCallName = `mcp.${string}.tools.${string}`
export const isExternalMcpToolCallName = (value: unknown): value is ExternalMcpToolCallName =>
  typeof value === 'string' && /^mcp\.external_[a-f0-9]{32}\.tools\.[A-Za-z0-9_.-]{1,128}$/u.test(value)
export type AgentToolCallName = (typeof AGENT_TOOL_CALL_NAMES)[number] | ExternalMcpToolCallName

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
  'glossary.list': 'wiki_list_glossary',
  'glossary.get': 'wiki_get_glossary_term',
  'skills.list': 'wiki_list_skills',
  'skills.read': 'wiki_read_skill',
  'memory.manage': 'wiki_manage_memory',
  'media.generateImage': 'wiki_generate_image',
  'media.generateVideo': 'wiki_generate_video',
  'media.generateMusic': 'wiki_generate_music',
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
export type AgentActionRisk = 'read' | 'open-world-read' | 'proposal' | 'reversible-write' | 'destructive-write' | 'external'
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
export type AgentToolState = 'preparing' | 'running' | 'awaitingApproval' | 'complete' | 'omitted' | 'not_executed' | 'failed' | 'denied' | 'cancelled'
export interface AgentToolContextExclusion {
  readonly status: 'omitted' | 'not_executed'
  readonly reason: 'tool_result_capacity'
}
export const AGENT_TASK_KINDS = ['source_scout', 'fact_check', 'conflict_check'] as const
export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number]
export type AgentTaskStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
export type AgentTaskOutcome = 'completed' | 'blocked' | 'partial' | 'failed'
export type AgentEvidenceConfidence = 'high' | 'medium' | 'low'
export const AGENT_GOAL_STATUSES = ['active', 'paused', 'blocked', 'budget_limited', 'completed', 'cancelled', 'failed'] as const
export type AgentGoalStatus = (typeof AGENT_GOAL_STATUSES)[number]
export type AgentCompletionOutcome = 'complete' | 'retry' | 'blocked' | 'partial'
export const AGENT_GOAL_TOKEN_TIERS = ['small', 'standard', 'extended'] as const
export type AgentGoalTokenTier = (typeof AGENT_GOAL_TOKEN_TIERS)[number]
export const AGENT_GOAL_BUDGET_SELECTIONS = ['pending', 'utility', 'fallback', 'legacy'] as const
export type AgentGoalBudgetSelection = (typeof AGENT_GOAL_BUDGET_SELECTIONS)[number]
export const AGENT_GOAL_BUDGET_LIMIT_REASONS = ['tokens', 'tool_calls', 'duration', 'continuations', 'quota', 'accounting', 'authority'] as const
export type AgentGoalBudgetLimitReason = (typeof AGENT_GOAL_BUDGET_LIMIT_REASONS)[number]

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

export type AgentCurrentPageHint = z.infer<typeof AgentCurrentPageHintSchema>

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

export interface AgentMediaCapabilities {
  readonly attachments: boolean
  readonly imageGeneration: boolean
  readonly videoGeneration?: boolean
  readonly musicGeneration?: boolean
  readonly transcription: boolean
  /** Authorized model-input opt-ins, independent of media generation and dictation. */
  readonly inputModalities?: Readonly<AgentMediaInputs>
  /** Exact authorized model-input formats; generation references and dictation are separate. */
  readonly inputMimeTypes?: readonly string[]
  /** Authorized independent tools and the reference modalities their actual APIs accept. */
  readonly mediaToolInputs?: Readonly<Partial<Record<AgentMediaKind, Readonly<AgentMediaInputs>>>>
}

export interface AgentMediaView {
  readonly id: string
  readonly kind: 'attachment' | 'generated-image' | 'generated-video' | 'generated-audio'
  readonly filename: string
  readonly mimeType: string
  readonly byteLength: number
  readonly available: boolean
  /** True when context compaction detached this attachment from the provider prompt. */
  readonly detached: boolean
}

export interface AgentGoogleSearchCitation {
  readonly url: string
  readonly title: string
  readonly startIndex: number
  readonly endIndex: number
}

export interface AgentGoogleSearchGrounding {
  readonly citations: readonly AgentGoogleSearchCitation[]
}

/** Display-only user intent; never source authority or provider instructions. */
export const AGENT_PRESET_IDS = ['page-summary', 'wiki-overview', 'page-connections', 'wiki-connections', 'catch-up'] as const
export type AgentPresetId = (typeof AGENT_PRESET_IDS)[number]

export interface AgentMessageView {
  /** User messages only: the explicitly submitted preset, never inferred from content. */
  readonly presetId?: AgentPresetId
  readonly media?: readonly AgentMediaView[]
  readonly googleSearchGrounding?: AgentGoogleSearchGrounding
  readonly knowledgeContext?: AgentKnowledgeContext
  /** User messages only: original frozen hint, null for known exclusion, omitted when unrecoverable. */
  readonly currentPage?: AgentCurrentPageHint | null
  readonly id: string
  readonly runId: string | null
  /** Present only when the matching assistant run is terminal and selected in the bounded thread window. */
  readonly runOutcome?: { readonly status: AgentTerminalRunStatus; readonly errorCode: string | null }
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

/** Immutable USD micros per million tokens: legacy normal rates, or explicit cache read/write rates. */
export const AgentProviderPricingRevisionSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9._-]{1,64}\|[0-9]{1,15}\|[0-9]{1,15}(?:\|[0-9]{1,15}\|[0-9]{1,15})?$/)
  .refine(
    value =>
      value
        .split('|')
        .slice(1)
        .every((rate, index) => {
          const parsed = Number(rate)
          return Number.isSafeInteger(parsed) && (index < 2 ? parsed > 0 : parsed >= 0)
        }),
    'Provider input and output rates must be positive safe integers; explicit cache read and write rates must be nonnegative safe integers'
  )

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
  /** Current administrator-resolved media capabilities; never a model-selection control. */
  readonly mediaCapabilities: Required<AgentMediaCapabilities> | null
  readonly skills: readonly AgentSessionSkillView[]
  readonly currentRun: AgentRunView | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastActivityAt: string
  readonly expiresAt: string | null
}

export type AgentRunWorkingPhase = 'correcting'

export interface AgentRunView {
  readonly id: string
  readonly sessionId: string
  readonly status: AgentRunStatus
  readonly attempt: number
  readonly eventSequence: number
  readonly canCancel: boolean
  readonly workingPhase?: AgentRunWorkingPhase
  readonly createdAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export interface AgentToolCallView {
  readonly id: string
  readonly runId: string
  readonly actionName: AgentToolCallName
  readonly title: string
  readonly state: AgentToolState
  readonly risk: AgentActionRisk
  readonly summary: string | null
  readonly proposalId: string | null
  readonly contextExclusion?: AgentToolContextExclusion
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
  readonly budgetPolicyVersion: number | null
  readonly budgetSelection: AgentGoalBudgetSelection
  readonly tokenTier: AgentGoalTokenTier | null
  readonly tokenAllowance: number | null
  readonly budgetCycle: number
  readonly budgetLimitReason: AgentGoalBudgetLimitReason | null
  readonly canRenewTokenBudget: boolean
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

/**
 * Metadata never contains memory text. Counts use the repository's UTF-16
 * characters including its existing entry separators, not bytes/tokens.
 * snapshotId is an opaque owner-bound fingerprint of the target's frozen/saved
 * contents (HMAC-SHA256 with the existing server signing secret over owner,
 * target and canonical ordered contents). Never expose an unkeyed content hash.
 * Unknown/unavailable/error/offline carry no invented zero counts or limits.
 * Stale retains previously authorized metadata but is not evidence of freshness.
 */
export const AGENT_MEMORY_CHARACTER_LIMITS = { user: 1375, agent: 2200 } as const
const AgentContextIdSchema = z.string().min(1).max(128)
// Fingerprint input is JSON.stringify([ownerId, target, orderedContents]); use
// the repository's existing createdAt/id entry order and lowercase hex digest.
const AgentMemoryFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/)
const AgentUserMemoryCountSchema = z.strictObject({
  target: z.literal('user'),
  characters: z.number().int().min(0).max(1375),
  limit: z.literal(1375),
  snapshotId: AgentMemoryFingerprintSchema
})
const AgentAgentMemoryCountSchema = z.strictObject({
  target: z.literal('agent'),
  characters: z.number().int().min(0).max(2200),
  limit: z.literal(2200),
  snapshotId: AgentMemoryFingerprintSchema
})
export const AgentMemoryTargetCountSchema = z.discriminatedUnion('target', [AgentUserMemoryCountSchema, AgentAgentMemoryCountSchema])
const AgentMemoryUnavailableSchema = z.strictObject({ state: z.enum(['unknown', 'unavailable', 'error', 'offline']) })
const AgentUserMemoryMetadataSchema = z.union([AgentUserMemoryCountSchema.extend({ state: z.enum(['available', 'stale']) }), AgentMemoryUnavailableSchema])
const AgentAgentMemoryMetadataSchema = z.union([AgentAgentMemoryCountSchema.extend({ state: z.enum(['available', 'stale']) }), AgentMemoryUnavailableSchema])
export const AgentMemoryContextProjectionSchema = z
  .strictObject({
    ownerId: z.number().int().positive(),
    sessionId: AgentContextIdSchema,
    frozen: z.strictObject({
      // The existing session id identifies its immutable memorySnapshot. Null
      // means the historical snapshot could not be loaded/authorized, not empty.
      snapshotId: AgentContextIdSchema.nullable(),
      user: AgentUserMemoryMetadataSchema,
      agent: AgentAgentMemoryMetadataSchema
    }),
    latestSaved: z.strictObject({ user: AgentUserMemoryMetadataSchema, agent: AgentAgentMemoryMetadataSchema }),
    nextSession: z.strictObject({
      user: z.enum(['unknown', 'unchanged', 'changed']),
      agent: z.enum(['unknown', 'unchanged', 'changed'])
    })
  })
  .superRefine((value, ctx) => {
    if (value.frozen.snapshotId !== null && value.frozen.snapshotId !== value.sessionId)
      ctx.addIssue({ code: 'custom', path: ['frozen', 'snapshotId'], message: 'Frozen snapshot identity must be the owning session' })
    for (const target of ['user', 'agent'] as const) {
      const frozen = value.frozen[target]
      const saved = value.latestSaved[target]
      if ((frozen.state === 'available' || frozen.state === 'stale') && value.frozen.snapshotId === null)
        ctx.addIssue({ code: 'custom', path: ['frozen', target], message: 'Known frozen counts require a snapshot identity' })
      if (
        (frozen.state === 'available' || frozen.state === 'stale') &&
        (saved.state === 'available' || saved.state === 'stale') &&
        frozen.snapshotId === saved.snapshotId &&
        frozen.characters !== saved.characters
      )
        ctx.addIssue({ code: 'custom', path: ['latestSaved', target], message: 'Identical target snapshots must have identical counts' })
      const expected =
        frozen.state === 'available' && saved.state === 'available' ? (frozen.snapshotId === saved.snapshotId ? 'unchanged' : 'changed') : 'unknown'
      if (value.nextSession[target] !== expected)
        ctx.addIssue({ code: 'custom', path: ['nextSession', target], message: 'Next-session state must compare fresh authoritative target snapshots' })
    }
  })

const AgentMemoryReceiptTargetsSchema = z
  .array(AgentMemoryTargetCountSchema)
  .min(1)
  .max(2)
  .refine(value => new Set(value.map(row => row.target)).size === value.length, { message: 'Receipt targets must be distinct' })
  .refine(value => value.some(row => row.characters > 0), { message: 'Receipt must include nonempty memory' })

/**
 * Produced AFTER observed successful delivery of nonempty frozen memory to the
 * provider on an applicable non-subagent request. deliveryId is the existing
 * provider invocation/dispatch identity; append at most once for that delivery.
 * A start/intent, disconnected/failed dispatch, GET, panel-open or message delta
 * never qualifies. A later failed run does not erase a real successful delivery.
 * This acknowledges context delivery, never cognitive recall or a particular entry.
 */
export const AgentMemoryContextIncludedDataSchema = z
  .strictObject({
    ownerId: z.number().int().positive(),
    sessionId: AgentContextIdSchema,
    snapshotId: AgentContextIdSchema,
    deliveryId: AgentContextIdSchema,
    targets: AgentMemoryReceiptTargetsSchema
  })
  .superRefine((value, ctx) => {
    if (value.snapshotId !== value.sessionId)
      ctx.addIssue({ code: 'custom', path: ['snapshotId'], message: 'Inclusion must identify the frozen owning session' })
    if (value.targets.some(row => row.characters === 0))
      ctx.addIssue({ code: 'custom', path: ['targets'], message: 'Inclusion targets must be nonempty actually delivered frozen memory' })
  })

/**
 * Persist only after fenced successful changed=true memory.manage add/replace.
 * targets reports the resulting authorized saved-store target(s), never a new
 * frozen session snapshot. operationId is the existing successful tool-call id.
 * remove/clear/no-op/denied/failure/pending are deliberately unrepresentable.
 */
export const AgentMemorySavedDataSchema = z
  .strictObject({
    ownerId: z.number().int().positive(),
    sessionId: AgentContextIdSchema,
    snapshotId: AgentContextIdSchema,
    origin: z.literal('memory.manage'),
    operationId: AgentContextIdSchema,
    operation: z.enum(['add', 'replace']),
    changed: z.literal(true),
    targets: AgentMemoryReceiptTargetsSchema
  })
  .refine(value => value.snapshotId === value.sessionId, { message: 'Save must identify its unchanged frozen owning session' })

/**
 * Manual mutation response only: no invented run/attempt or second event store.
 * entryId/resulting entryVersion come from the successful authorized write,
 * including optimistic expectedVersion checks, without an additional read.
 * (ownerId, entryId, entryVersion) is its replay identity; entryVersion increases
 * monotonically per entry. A create has version1; replace has version>=2.
 * sessionId echoes a shape-validated client correlation (null outside a session),
 * NOT proof of session access or loaded frozen memory. Authorize the owner via
 * the existing mutation principal; no session lookup is required just to reward.
 * A target-changing replacement includes BOTH resulting target counts.
 */
export const AgentManualMemorySavedReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    origin: z.literal('manual'),
    ownerId: z.number().int().positive(),
    sessionId: AgentContextIdSchema.nullable(),
    runId: z.null(),
    attempt: z.null(),
    snapshotId: z.null(),
    entryId: AgentContextIdSchema,
    entryVersion: z.number().int().positive(),
    operation: z.enum(['add', 'replace']),
    changed: z.literal(true),
    targets: AgentMemoryReceiptTargetsSchema
  })
  .refine(value => (value.operation === 'add' ? value.entryVersion === 1 : value.entryVersion >= 2), {
    message: 'Manual operation must match the resulting entry version'
  })

export const AgentManualMemoryMutationContextSchema = z.strictObject({
  sessionId: AgentContextIdSchema.nullable()
})
export type AgentManualMemoryMutationContext = z.infer<typeof AgentManualMemoryMutationContextSchema>
// Manual create/update request bodies include `context` with the schema above.
// Their existing mutation response gains REQUIRED `receipt`, null for no-change;
// remove/clear never populate it. Response fields containing existing memory
// management content are not copied into this metadata-only receipt.
export const AgentManualMemoryMutationReceiptFieldsSchema = z.strictObject({
  receipt: AgentManualMemorySavedReceiptSchema.nullable()
})
export type AgentManualMemoryMutationReceiptFields = z.infer<typeof AgentManualMemoryMutationReceiptFieldsSchema>

export type AgentMemoryTargetCount = z.infer<typeof AgentMemoryTargetCountSchema>
export type AgentMemoryContextProjection = z.infer<typeof AgentMemoryContextProjectionSchema>
export type AgentMemoryContextIncludedData = z.infer<typeof AgentMemoryContextIncludedDataSchema>
export type AgentMemorySavedData = z.infer<typeof AgentMemorySavedDataSchema>
export type AgentManualMemorySavedReceipt = z.infer<typeof AgentManualMemorySavedReceiptSchema>

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
  'memory.contextIncluded',
  'memory.saved',
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
  'tool.notExecuted',
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
  'dispatch.accounting',
  'media.usage',
  'run.completed',
  'run.partial',
  'run.failed',
  'run.cancelled',
  'run.recovery_required',
  'suggestions.updated'
] as const

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]
export type AgentEventData = Readonly<Record<string, string | number | boolean | null | readonly unknown[] | Readonly<Record<string, unknown>>>>

// Admission/queued events precede the first execution attempt and legitimately
// carry attempt0. Memory receipts below require an actual positive attempt.
export const AgentEventEnvelopeSchema = z.strictObject({
  id: AgentContextIdSchema,
  runId: AgentContextIdSchema,
  sequence: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime({ offset: true })
})
type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>

// New memory event variants require their exact validated payload; do not hide
// missing semantics behind optional data or a deprecated transport path.
export type AgentEvent = AgentEventEnvelope &
  (
    | { readonly type: 'memory.contextIncluded'; readonly data: AgentMemoryContextIncludedData }
    | { readonly type: 'memory.saved'; readonly data: AgentMemorySavedData }
    | { readonly type: Exclude<AgentEventType, 'memory.contextIncluded' | 'memory.saved'>; readonly data: AgentEventData }
  )

const AgentMemoryEventEnvelopeSchema = AgentEventEnvelopeSchema.extend({
  attempt: z.number().int().positive()
})
export const AgentMemoryReceiptEventSchema = z.discriminatedUnion('type', [
  AgentMemoryEventEnvelopeSchema.extend({ type: z.literal('memory.contextIncluded'), data: AgentMemoryContextIncludedDataSchema }),
  AgentMemoryEventEnvelopeSchema.extend({ type: z.literal('memory.saved'), data: AgentMemorySavedDataSchema })
])
export type AgentMemoryReceiptEvent = z.infer<typeof AgentMemoryReceiptEventSchema>

export const AgentEventSchema = z.union([
  AgentMemoryReceiptEventSchema,
  AgentEventEnvelopeSchema.extend({
    type: z.enum(
      AGENT_EVENT_TYPES.filter(
        (type): type is Exclude<AgentEventType, 'memory.contextIncluded' | 'memory.saved'> => type !== 'memory.contextIncluded' && type !== 'memory.saved'
      )
    ),
    data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())]))
  })
])

/**
 * Non-durable transport control, sent FIRST on EVERY SSE connection (including
 * automatic reconnect) with no SSE id. replayThroughSequence is the existing
 * initial authorized run.eventSequence, not a new counter or an extra fetch.
 * Extend that existing query with sessionId. A cursor ahead of this value is
 * invalid. Until this control validates, all receipts are replay/ineligible.
 * Events <= replayThroughSequence are replay; later events are live. Reset this
 * boundary on connection open/error, not the existing monotonic run watermark.
 * The SSE data for durable events is the complete AgentEvent (including original
 * id/runId/sequence/type); SSE event name and lastEventId must match type/sequence.
 * Never invent event ids or reconstruct missing authoritative envelope fields.
 */
export const AGENT_RUN_STREAM_READY_EVENT = 'stream.ready'
export const AgentRunStreamReadySchema = z.strictObject({
  schemaVersion: z.literal(1),
  ownerId: z.number().int().positive(),
  sessionId: AgentContextIdSchema,
  runId: AgentContextIdSchema,
  replayThroughSequence: z.number().int().nonnegative()
})
export type AgentRunStreamReady = z.infer<typeof AgentRunStreamReadySchema>

/**
 * Projection/hydration never rewards. Consumers capture existing owner, session
 * and workspace generation before subscription/mutation; reject results after
 * any changes. For live events also match runId, current attempt and frozen
 * snapshotId. Dedup by event.id AND runId/sequence; keep the existing per-run
 * sequence watermark monotonic across attempt changes and reconnects. Reconnect
 * catch-up and bootstrap are history, not live. Use stream.ready on EVERY
 * connection to distinguish catch-up from later live events. Advance the existing
 * watermark for ALL event types, not just memory. Unknown cursor/attempt/boundary
 * suppresses rewards until synchronized, without an extra fetch/provider call.
 * Repeated operationId/deliveryId in the same run/attempt is the same receipt.
 * Inclusion targets must exactly match the nonempty available frozen targets'
 * fingerprints/counts/limits in the authorized projection; unknown/stale state
 * cannot qualify. Save targets are resulting saved metadata and cannot be
 * compared to frozen counts; match operation origin and identity instead.
 * Manual receipts qualify only from the current generation's successful mutation
 * response, with matching owner/session and a new entryVersion, never a list GET.
 * Neither event contents nor manual responses may overwrite frozen metadata.
 */
export const AgentMemoryReceiptDeliverySchema = z.strictObject({
  generation: z.number().int().nonnegative(),
  phase: z.enum(['bootstrap', 'replay', 'live']),
  receipt: z.union([AgentMemoryReceiptEventSchema, AgentManualMemorySavedReceiptSchema])
})
export type AgentMemoryReceiptDelivery = z.infer<typeof AgentMemoryReceiptDeliverySchema>

export interface AgentRoutingDecisionView {
  readonly runId: string
  readonly strategy: 'stay' | 'swap' | 'delegate'
  readonly rootProfileVersionId: string
  readonly specialistProfileVersionId: string | null
  readonly reason: string
  readonly costs: {
    readonly stayMicros: number | null
    readonly coldSwapMicros: number | null
    readonly delegateMicros: number | null
  } | null
}

export interface AgentThreadState {
  readonly session: AgentSessionView
  readonly memoryContext: AgentMemoryContextProjection
  readonly messages: readonly AgentMessageView[]
  readonly tools: readonly AgentToolCallView[]
  readonly tasks: readonly AgentTaskView[]
  readonly specialistInvocations: readonly SpecialistInvocationView[]
  readonly routingDecisions: readonly AgentRoutingDecisionView[]
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

export const AGENT_GENERATION_TOOLS = ['image', 'video', 'music'] as const
export type AgentGenerationTool = (typeof AGENT_GENERATION_TOOLS)[number]

export interface SubmitAgentMessageRequest {
  readonly presetId?: AgentPresetId
  readonly generationTools?: readonly AgentGenerationTool[]
  readonly attachmentIds?: readonly string[]
  readonly responseMode?: 'text' | 'image' | 'video' | 'music'
  readonly clientRequestId: string
  readonly expectedSessionVersion: number
  readonly profileResolutionToken: string
  readonly content: string
  readonly invokedSkillVersionIds?: readonly string[]
  readonly currentPage?: AgentCurrentPageHint
  readonly knowledgeContext?: AgentKnowledgeContext
}
export interface CreateAgentGoalRequest {
  readonly generationTools?: readonly AgentGenerationTool[]
  readonly goalId: string
  readonly clientRequestId: string
  readonly expectedSessionVersion: number
  readonly profileResolutionToken: string
  readonly objective: string
  readonly invokedSkillVersionIds?: readonly string[]
  readonly currentPage?: AgentCurrentPageHint
  readonly knowledgeContext?: AgentKnowledgeContext
}
export interface RenewAgentGoalBudgetRequest {
  readonly expectedVersion: number
  readonly runId: string
  readonly clientRequestId: string
  readonly confirmed: true
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

export interface AgentTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

export interface AgentUsageUpdate {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
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
