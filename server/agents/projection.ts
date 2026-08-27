import type { Knex } from 'knex'
import { z } from 'zod'
import {
  AGENT_ACTION_NAMES,
  type AgentActionName,
  type AgentActionRisk,
  type AgentApprovalView,
  type AgentArtifactView,
  type AgentCitation,
  type AgentEvent,
  type AgentFollowUpSuggestion,
  type AgentMessageView,
  type AgentProposalView,
  type AgentPageActionLink,
  type AgentRunView,
  type AgentSessionSkillView,
  type AgentSessionView,
  type AgentThreadState,
  type AgentToolCallView,
  type AgentToolState
} from '../../shared/agents/contracts.ts'
import { AgentRepositoryError, getOwnedAgentSession, listOwnedAgentEvents, listOwnedAgentMessages } from './repository.ts'

const actionNames = new Set<string>(AGENT_ACTION_NAMES)
const runStatusSchema = z.enum(['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'recovery_required'])
const proposalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired', 'applying', 'applied', 'failed', 'cancelled'])
const approvalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled'])
const riskSchema = z.enum(['read', 'open-world-read', 'proposal', 'reversible-write', 'destructive-write'])

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const nullableIso = (value: Date | string | null): string | null => value === null ? null : iso(value)
const stringValue = (value: unknown, maximum = 4_000): string | null => typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null

const parseJson = (value: string | null, code: string): unknown => {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    throw new AgentRepositoryError(code, 'Durable agent projection contains invalid JSON', 500)
  }
}

const citations = (value: string | null): readonly AgentCitation[] => {
  const parsed = parseJson(value, 'AGENT_MESSAGE_CORRUPT')
  if (parsed === null) return []
  const result = z.array(z.strictObject({
    evidenceId: z.string().min(1).max(128),
    kind: z.enum(['page', 'search-result', 'skill', 'browser']),
    label: z.string().min(1).max(512),
    href: z.string().max(2_048).nullable()
  })).max(100).safeParse(parsed)
  if (!result.success) throw new AgentRepositoryError('AGENT_MESSAGE_CORRUPT', 'Agent message citations are invalid', 500)
  return result.data
}

interface ToolAccumulator {
  id: string
  runId: string
  actionName: AgentActionName
  title: string
  state: AgentToolState
  risk: AgentActionRisk
  summary: string | null
  proposalId: string | null
  startedAt: string
  completedAt: string | null
}

const toolStateForFailure = (data: AgentEvent['data']): AgentToolState => {
  const state = stringValue(data.state, 32)
  if (state === 'denied' || state === 'cancelled') return state
  return 'failed'
}

const completedToolState = (data: AgentEvent['data']): AgentToolState => {
  const result = stringValue(data.result)
  if (result === null) return 'complete'
  try {
    const status = Reflect.get(JSON.parse(result) as object, 'status')
    if (status === 'denied' || status === 'cancelled') return status
    if (status === 'expired') return 'failed'
  } catch {
    return 'complete'
  }
  return 'complete'
}

export interface ReducedAgentEvents {
  readonly tools: readonly AgentToolCallView[]
  readonly suggestions: readonly AgentFollowUpSuggestion[]
}

export const reduceAgentEvents = (events: readonly AgentEvent[]): ReducedAgentEvents => {
  const tools = new Map<string, ToolAccumulator>()
  let suggestions: readonly AgentFollowUpSuggestion[] = []
  const visibleAttempt = events.reduce((maximum, event) => Math.max(maximum, event.attempt), 0)

  for (const event of events) {
    if (event.attempt !== visibleAttempt) continue
    if (event.type === 'suggestions.updated') {
      const parsed = z.array(z.strictObject({ id: z.string().min(1).max(128), label: z.string().min(1).max(255), prompt: z.string().min(1).max(4_000) })).max(10).safeParse(event.data.suggestions)
      if (!parsed.success) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Agent suggestions event is invalid', 500)
      suggestions = parsed.data
      continue
    }

    const actionCallId = stringValue(event.data.actionCallId, 128)
    if (actionCallId === null) continue
    if (event.type === 'tool.started') {
      const actionName = stringValue(event.data.actionName, 128)
      const risk = riskSchema.safeParse(event.data.risk)
      const title = stringValue(event.data.title, 255)
      if (actionName === null || !actionNames.has(actionName) || !risk.success || title === null) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Agent tool start event is invalid', 500)
      if (tools.has(actionCallId)) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Agent tool call was started twice', 500)
      tools.set(actionCallId, { id: actionCallId, runId: event.runId, actionName: actionName as AgentActionName, title, state: 'running', risk: risk.data, summary: null, proposalId: null, startedAt: event.createdAt, completedAt: null })
      continue
    }

    const tool = tools.get(actionCallId)
    if (!tool) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Agent tool event has no start boundary', 500)
    if (event.type === 'tool.progress') {
      const summary = stringValue(event.data.summary)
      if (summary !== null) tool.summary = summary
    } else if (event.type === 'proposal.created') {
      tool.state = 'awaitingApproval'
      tool.proposalId = stringValue(event.data.proposalId, 64)
    } else if (event.type === 'tool.completed') {
      tool.state = completedToolState(event.data)
      tool.summary = stringValue(event.data.summary) ?? tool.summary
      tool.completedAt = event.createdAt
    } else if (event.type === 'tool.failed') {
      tool.state = toolStateForFailure(event.data)
      tool.summary = stringValue(event.data.summary) ?? tool.summary
      tool.completedAt = event.createdAt
    }
  }

  return { tools: [...tools.values()].map(tool => ({ ...tool })), suggestions }
}

export interface ProjectAgentRunInput {
  readonly id: string
  readonly sessionId: string
  readonly status: string
  readonly attempts: number
  readonly eventSequence: number
  readonly queuedAt: Date | string
  readonly startedAt: Date | string | null
  readonly completedAt: Date | string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export const projectAgentRun = (row: ProjectAgentRunInput): AgentRunView => {
  const status = runStatusSchema.parse(row.status)
  return {
    id: row.id,
    sessionId: row.sessionId,
    status,
    attempt: row.attempts,
    eventSequence: row.eventSequence,
    canCancel: status === 'queued' || status === 'running' || status === 'awaiting_approval',
    createdAt: iso(row.queuedAt),
    startedAt: nullableIso(row.startedAt),
    completedAt: nullableIso(row.completedAt),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage
  }
}

interface SkillRow {
  skillId: string
  versionId: string
  name: string
  frontmatter: string
  contentHash: string
  sourcePath: string
  versionCreatedAt: Date | string
  status: string
  currentVersionId: string | null
  ordinal: number
}

const skillView = (row: SkillRow): AgentSessionSkillView => {
  const status = row.status === 'enabled' || row.status === 'disabled' || row.status === 'revoked' ? row.status : null
  if (status === null) throw new AgentRepositoryError('AGENT_SKILL_CORRUPT', 'Agent skill status is invalid', 500)
  const parsedFrontmatter = z.strictObject({ description: z.string().min(1).max(2_000) }).passthrough().safeParse(parseJson(row.frontmatter, 'AGENT_SKILL_CORRUPT'))
  if (!parsedFrontmatter.success) throw new AgentRepositoryError('AGENT_SKILL_CORRUPT', 'Agent skill frontmatter is invalid', 500)
  return {
    skillId: row.skillId,
    versionId: row.versionId,
    name: row.name,
    description: parsedFrontmatter.data.description,
    contentHash: row.contentHash,
    sourcePath: row.sourcePath,
    versionCreatedAt: iso(row.versionCreatedAt),
    status,
    drifted: row.currentVersionId !== row.versionId,
    selected: true,
    ordinal: row.ordinal
  }
}

interface ProposalRow {
  id: string
  sourceKind: 'agent' | 'mcp'
  actionName: string
  risk: string
  status: string
  summary: string
  operation: string
  pageId: number | null
  pageLocale: string | null
  pagePath: string | null
  pageTitle: string | null
  pageContentType: string | null
  baseSourceRevision: number | string | null
  authoritySha256: string
  inputHash: string
  patchSha256: string | null
  resultCanonicalSha256: string | null
  diffSha256: string | null
  diff: string | null
  contentPurgedAt: Date | string | null
  expiresAt: Date | string
}

const linkedPageActions = new Set<AgentActionName>([
  'pages.prepareImportOkf',
  'pages.prepareCreate',
  'pages.preparePatch',
  'pages.prepareMove',
  'pages.prepareRestore'
])

const proposalPageLink = (row: ProposalRow, status: AgentProposalView['status']): AgentPageActionLink | null => {
  if (status !== 'applied' || !linkedPageActions.has(row.actionName as AgentActionName)) return null
  const operation = parseJson(row.operation, 'AGENT_PROPOSAL_CORRUPT')
  if (typeof operation !== 'object' || operation === null) throw new AgentRepositoryError('AGENT_PROPOSAL_CORRUPT', 'Agent proposal operation is invalid', 500)
  const locale = stringValue(Reflect.get(operation, 'locale'), 16)
  const path = stringValue(Reflect.get(operation, 'path'), 1_024)
  if (!locale || !path) throw new AgentRepositoryError('AGENT_PROPOSAL_CORRUPT', 'Applied proposal target is invalid', 500)
  return {
    label: `/${path}`,
    href: `/${encodeURIComponent(locale)}/${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }
}

const proposalView = (row: ProposalRow, approval: AgentApprovalView | null): AgentProposalView => {
  if (!actionNames.has(row.actionName)) throw new AgentRepositoryError('AGENT_PROPOSAL_CORRUPT', 'Agent proposal action is invalid', 500)
  const status = proposalStatusSchema.parse(row.status)
  const target = row.pageId === null
    ? null
    : {
        id: row.pageId,
        locale: row.pageLocale ?? '',
        path: row.pagePath ?? '',
        title: row.pageTitle ?? '',
        contentType: row.pageContentType ?? '',
        sourceRevision: String(row.baseSourceRevision ?? '')
      }
  return {
    id: row.id,
    sourceKind: row.sourceKind,
    actionName: row.actionName as AgentActionName,
    risk: riskSchema.parse(row.risk),
    status,
    summary: row.summary,
    target,
    pageLink: proposalPageLink(row, status),
    baseSourceRevision: row.baseSourceRevision === null ? null : String(row.baseSourceRevision),
    authoritySha256: row.authoritySha256,
    inputHash: row.inputHash,
    patchSha256: row.patchSha256,
    resultCanonicalSha256: row.resultCanonicalSha256,
    diffSha256: row.diffSha256,
    diff: row.contentPurgedAt === null ? row.diff : null,
    expiresAt: iso(row.expiresAt),
    approval
  }
}

interface ApprovalRow {
  id: string
  proposalId: string
  status: string
  requestedAt: Date | string
  expiresAt: Date | string
  decidedAt: Date | string | null
  decisionNote: string | null
}

const approvalView = (row: ApprovalRow): AgentApprovalView => ({
  id: row.id,
  proposalId: row.proposalId,
  status: approvalStatusSchema.parse(row.status),
  requestedAt: iso(row.requestedAt),
  expiresAt: iso(row.expiresAt),
  decidedAt: nullableIso(row.decidedAt),
  decisionNote: row.decisionNote
})

interface ArtifactRow {
  id: string
  kind: string
  mimeType: string
  byteLength: number
  width: number
  height: number
  createdAt: Date | string
  expiresAt: Date | string | null
}

const artifactView = (row: ArtifactRow, now: Date): AgentArtifactView => {
  if (row.kind !== 'browser-screenshot' || row.mimeType !== 'image/png') throw new AgentRepositoryError('AGENT_ARTIFACT_CORRUPT', 'Agent artifact type is invalid', 500)
  return {
    id: row.id,
    kind: 'browser-screenshot',
    mimeType: 'image/png',
    byteLength: row.byteLength,
    width: row.width,
    height: row.height,
    createdAt: iso(row.createdAt),
    expiresAt: nullableIso(row.expiresAt),
    available: row.expiresAt === null || new Date(row.expiresAt).valueOf() > now.valueOf()
  }
}

export interface ProjectAgentThreadOptions {
  readonly profileResolutionToken: (session: { readonly id: string, readonly version: number, readonly providerProfileId: string | null, readonly executionMode: string }) => string
  readonly now?: Date
}

export const projectAgentThread = async (knex: Knex, ownerId: number, sessionId: string, options: ProjectAgentThreadOptions): Promise<AgentThreadState> => {
  const session = await getOwnedAgentSession(knex, ownerId, sessionId)
  const now = options.now ?? new Date()
  const groupIds = await knex('userGroups').where({ userId: ownerId }).pluck('groupId') as number[]
  const [messageRows, runRows, skillRows, proposalRows, approvalRows, artifactRows] = await Promise.all([
    listOwnedAgentMessages(knex, ownerId, sessionId, 0, 500),
    knex<ProjectAgentRunInput>('agentRuns').where('sessionId', sessionId).andWhere('ownerId', ownerId).orderBy('queuedAt', 'desc'),
    knex<SkillRow>('agentUserSkillPreferences as preferences')
      .join('agentSkills as skills', 'skills.id', 'preferences.skillId')
      .join('agentSkillVersions as versions', 'versions.id', 'skills.currentVersionId')
      .where('preferences.ownerId', ownerId)
      .where('skills.status', 'enabled')
      .where('versions.approvalStatus', 'approved')
      .whereNull('skills.deletedAt')
      .where(visibility => {
        visibility.where('skills.ownerUserId', ownerId).orWhere(system => {
          system.whereNull('skills.ownerUserId').andWhere(exposure => {
            exposure.where('skills.exposureMode', 'all_agent_users')
            if (groupIds.length > 0) {
              exposure.orWhereExists(function groupGrant () {
                this.select(knex.raw('1'))
                  .from('agentSkillGrants as grants')
                  .whereRaw('grants."skillId" = skills.id')
                  .whereIn('grants.groupId', groupIds)
              })
            }
          })
        })
      })
      .select({ skillId: 'skills.id', versionId: 'versions.id', name: 'skills.name', frontmatter: 'versions.frontmatter', contentHash: 'versions.contentHash', sourcePath: 'skills.rootPath', versionCreatedAt: 'versions.createdAt', status: 'skills.status', currentVersionId: 'skills.currentVersionId', ordinal: 'preferences.ordinal' })
      .orderBy('preferences.ordinal'),
    knex<ProposalRow>('agentProposals')
      .leftJoin('pages', 'pages.id', 'agentProposals.pageId')
      .where('agentProposals.sessionId', sessionId)
      .select({ id: 'agentProposals.id', sourceKind: 'agentProposals.sourceKind', actionName: 'agentProposals.actionName', risk: 'agentProposals.risk', status: 'agentProposals.status', summary: 'agentProposals.summary', pageId: 'agentProposals.pageId', pageLocale: 'pages.localeCode', pagePath: 'pages.path', pageTitle: 'pages.title', pageContentType: 'pages.contentType', baseSourceRevision: 'agentProposals.baseSourceRevision', authoritySha256: 'agentProposals.authoritySha256', inputHash: 'agentProposals.inputHash', patchSha256: 'agentProposals.patchSha256', resultCanonicalSha256: 'agentProposals.resultCanonicalSha256', diffSha256: 'agentProposals.diffSha256', diff: 'agentProposals.diff', contentPurgedAt: 'agentProposals.contentPurgedAt', expiresAt: 'agentProposals.expiresAt' })
      .select({ operation: 'agentProposals.operation' })
      .orderBy('agentProposals.createdAt'),
    knex<ApprovalRow>('agentApprovals').join('agentProposals', 'agentProposals.id', 'agentApprovals.proposalId').where('agentProposals.sessionId', sessionId).select('agentApprovals.*'),
    knex<ArtifactRow>('agentArtifacts').where('sessionId', sessionId).andWhere('ownerId', ownerId).select('id', 'kind', 'mimeType', 'byteLength', 'width', 'height', 'createdAt', 'expiresAt').orderBy('createdAt')
  ])

  const runs = runRows.map(projectAgentRun)
  const currentRun = runs.find(run => run.canCancel) ?? null
  const allEvents = (await Promise.all(runRows.map(run => listOwnedAgentEvents(knex, ownerId, run.id, 0, 1_000)))).flat()
  const reduced = reduceAgentEvents(allEvents)
  const approvals = new Map(approvalRows.map(row => [row.proposalId, approvalView(row)]))
  const messages: AgentMessageView[] = messageRows.map(message => ({
    id: message.id,
    runId: message.runId,
    ordinal: message.ordinal,
    role: message.role,
    status: message.status,
    content: message.content,
    citations: citations(message.citations),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt
  }))
  const sessionView: AgentSessionView = {
    id: session.id,
    title: session.title,
    retention: session.retention,
    status: session.deletedAt === null ? 'active' : 'deletion_pending',
    executionMode: session.executionMode,
    version: session.version,
    providerProfileId: session.providerProfileId,
    profileResolutionToken: options.profileResolutionToken(session),
    skills: skillRows.map(skillView),
    currentRun,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    expiresAt: session.expiresAt
  }
  return {
    session: sessionView,
    messages,
    tools: reduced.tools,
    proposals: proposalRows.map(row => proposalView(row, approvals.get(row.id) ?? null)),
    artifacts: artifactRows.map(row => artifactView(row, now)),
    suggestions: reduced.suggestions
  }
}
