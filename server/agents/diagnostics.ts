import { createHash } from 'node:crypto'
import type { Knex } from 'knex'

import type { AgentToolContextExclusion } from '../../shared/agents/contracts.ts'
import { decodeAgentMemorySnapshot } from './memory.ts'
import { AgentRepositoryError } from './repository.ts'

interface DiagnosticEventRow {
  id: string
  runId: string
  sequence: number
  type: string
  attempt: number
  schemaVersion: number
  dataSha256: string
  data: string
  createdAt: Date | string
}

interface DiagnosticToolCall {
  actionCallId: string
  actionName: string
  title: string | null
  turn: number | null
  input: unknown
  inputRecorded: boolean
  state: 'running' | 'complete' | 'omitted' | 'not_executed' | 'failed'
  output: unknown
  errorCode: string | null
  contextExclusion: AgentToolContextExclusion | null
  cacheHit: boolean
  duplicateOfActionCallId: string | null
  requestedAfterRejectedEvidenceDrafts: number
  requestReason: 'model_requested' | 'model_requested_after_evidence_rejection'
  rationale: null
}

const invalidDiagnosticEvent = (message: string): never => {
  throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', message, 500)
}

const contextExclusionFor = (data: Record<string, unknown>): AgentToolContextExclusion | undefined => {
  if (!Object.hasOwn(data, 'contextExclusion')) return undefined
  const value = data.contextExclusion
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidDiagnosticEvent('Agent tool context exclusion is invalid')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || keys.some(key => key !== 'status' && key !== 'reason')) return invalidDiagnosticEvent('Agent tool context exclusion is invalid')
  const status = record.status
  const reason = record.reason
  if ((status !== 'omitted' && status !== 'not_executed') || reason !== 'tool_result_capacity')
    return invalidDiagnosticEvent('Agent tool context exclusion is invalid')
  return { status: status as AgentToolContextExclusion['status'], reason: 'tool_result_capacity' }
}

const validateToolAction = (tool: DiagnosticToolCall, data: Record<string, unknown>): void => {
  const actionName = data.actionName
  if (actionName !== undefined && (typeof actionName !== 'string' || actionName !== tool.actionName))
    invalidDiagnosticEvent('Agent tool event action is invalid')
}

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString())
const nullableIso = (value: Date | string | null): string | null => (value === null ? null : iso(value))
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const DIAGNOSTIC_USAGE_INTEGER = /^(0|[1-9][0-9]*)$/
const invalidDiagnosticUsage = (): never => {
  throw new AgentRepositoryError('AGENT_DIAGNOSTIC_USAGE_INVALID', 'Stored agent diagnostic usage is invalid', 500)
}
const diagnosticUsageOverflow = (): never => {
  throw new AgentRepositoryError('AGENT_DIAGNOSTIC_USAGE_OVERFLOW', 'Agent diagnostic usage totals exceed the supported numeric range', 500)
}
const diagnosticUsageInteger = (value: unknown): number => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return invalidDiagnosticUsage()
    return value
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_SAFE_INTEGER_BIGINT) return invalidDiagnosticUsage()
    return Number(value)
  }
  if (typeof value === 'string' && DIAGNOSTIC_USAGE_INTEGER.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return invalidDiagnosticUsage()
}
const safeDiagnosticAdd = (left: number, right: number, onOverflow: () => never): number => {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) return invalidDiagnosticUsage()
  if (right > Number.MAX_SAFE_INTEGER - left) return onOverflow()
  return left + right
}

interface DiagnosticUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly estimatedCostMicros: number | null
}

const readDiagnosticUsage = (row: Record<string, unknown>): DiagnosticUsage => {
  const inputTokens = diagnosticUsageInteger(row.inputTokens)
  const outputTokens = diagnosticUsageInteger(row.outputTokens)
  const totalTokens = diagnosticUsageInteger(row.totalTokens)
  const directionalTotal = safeDiagnosticAdd(inputTokens, outputTokens, invalidDiagnosticUsage)
  if (totalTokens < directionalTotal) return invalidDiagnosticUsage()
  const estimatedCostMicros = row.estimatedCostMicros === null ? null : diagnosticUsageInteger(row.estimatedCostMicros)
  return { inputTokens, outputTokens, totalTokens, estimatedCostMicros }
}

const parseObject = (value: string, code: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new AgentRepositoryError(code, 'Stored agent diagnostic data is invalid', 500)
  }
}

const parseOptionalJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const readIdentity = (actionName: string, input: unknown, output: unknown): string | null => {
  if (actionName !== 'pages.get' && actionName !== 'pages.getVersion') return null
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const candidate = input as Record<string, unknown>
    if (candidate.id !== undefined) return `${actionName}:id:${String(candidate.id)}`
    if (typeof candidate.path === 'string' && typeof candidate.locale === 'string') return `${actionName}:path:${candidate.locale}:${candidate.path}`
    if (candidate.pageId !== undefined && candidate.versionId !== undefined)
      return `${actionName}:version:${String(candidate.pageId)}:${String(candidate.versionId)}`
  }
  if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
    const candidate = output as Record<string, unknown>
    if (candidate.id !== undefined && candidate.sourceRevision !== undefined)
      return `${actionName}:result:${String(candidate.id)}:${String(candidate.sourceRevision)}`
  }
  return null
}

const recentEvidenceRowCount = (actionName: string, output: unknown): number => {
  if (actionName !== 'pages.listRecent' || typeof output !== 'object' || output === null || Array.isArray(output)) return 0
  const result = output as Record<string, unknown>
  if (result.kind !== 'recent-page-evidence' || !Array.isArray(result.pages)) return 0
  return result.pages.filter(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const row = value as Record<string, unknown>
    const citation = row.citation
    if (
      typeof row.id !== 'number' ||
      !Number.isSafeInteger(row.id) ||
      row.id < 1 ||
      typeof row.locale !== 'string' ||
      typeof row.path !== 'string' ||
      typeof row.title !== 'string' ||
      typeof row.contentType !== 'string' ||
      typeof row.sourceRevision !== 'string' ||
      typeof row.updatedAt !== 'string' ||
      typeof row.content !== 'string' ||
      typeof row.sourceContentCharacters !== 'number' ||
      !Number.isSafeInteger(row.sourceContentCharacters) ||
      row.sourceContentCharacters < 0 ||
      typeof row.contentTruncated !== 'boolean' ||
      typeof citation !== 'object' ||
      citation === null ||
      Array.isArray(citation)
    )
      return false
    const citationRecord = citation as Record<string, unknown>
    return typeof citationRecord.evidenceId === 'string' && typeof citationRecord.label === 'string' && typeof citationRecord.href === 'string'
  }).length
}
const analyzeTools = (
  events: readonly { readonly type: string; readonly data: Record<string, unknown> }[]
): {
  readonly toolCalls: readonly DiagnosticToolCall[]
  readonly findings: readonly Readonly<Record<string, unknown>>[]
} => {
  const tools: DiagnosticToolCall[] = []
  const toolsById = new Map<string, DiagnosticToolCall>()
  const firstReadByIdentity = new Map<string, string>()
  const evidenceIssues = new Set<string>()
  let rejectedEvidenceDrafts = 0
  let rejectedSinceLastTool = 0
  let acceptedWithoutCitations = false
  let completedPageReads = 0

  for (const event of events) {
    if (event.type === 'evidence.provenance') {
      if (event.data.accepted === false) {
        rejectedEvidenceDrafts += 1
        rejectedSinceLastTool += 1
        if (Array.isArray(event.data.issues)) {
          for (const issue of event.data.issues) if (typeof issue === 'string') evidenceIssues.add(issue)
        }
      } else if (
        event.data.accepted === true &&
        completedPageReads > 0 &&
        Array.isArray(event.data.finalCitationIds) &&
        event.data.finalCitationIds.length === 0
      ) {
        acceptedWithoutCitations = true
      }
      continue
    }
    const isToolEvent = event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.notExecuted' || event.type === 'tool.failed'
    if (!isToolEvent) continue
    const actionCallId = typeof event.data.actionCallId === 'string' ? event.data.actionCallId : ''
    if (!actionCallId) continue
    if (event.type === 'tool.started') {
      if (Object.hasOwn(event.data, 'contextExclusion')) invalidDiagnosticEvent('Agent tool start cannot have a context exclusion')
      const inputRecorded = typeof event.data.input === 'string'
      const tool: DiagnosticToolCall = {
        actionCallId,
        actionName: typeof event.data.actionName === 'string' ? event.data.actionName : 'unknown',
        title: typeof event.data.title === 'string' ? event.data.title : null,
        turn: Number.isSafeInteger(event.data.turn) ? Number(event.data.turn) : null,
        input: inputRecorded ? parseOptionalJson(event.data.input) : null,
        inputRecorded,
        state: 'running',
        output: null,
        errorCode: null,
        contextExclusion: null,
        cacheHit: false,
        duplicateOfActionCallId: null,
        requestedAfterRejectedEvidenceDrafts: rejectedSinceLastTool,
        requestReason: rejectedSinceLastTool > 0 ? 'model_requested_after_evidence_rejection' : 'model_requested',
        rationale: null
      }
      rejectedSinceLastTool = 0
      tools.push(tool)
      toolsById.set(actionCallId, tool)
      continue
    }
    if (event.type === 'tool.failed') {
      if (contextExclusionFor(event.data) !== undefined) invalidDiagnosticEvent('Failed tool activity cannot have a context exclusion')
      const tool = toolsById.get(actionCallId)
      if (!tool) continue
      if (tool.state === 'omitted' || tool.state === 'not_executed') invalidDiagnosticEvent('Agent tool activity has multiple terminal events')
      tool.state = 'failed'
      tool.errorCode = typeof event.data.errorCode === 'string' ? event.data.errorCode : 'ACTION_FAILED'
      continue
    }
    if (event.type === 'tool.notExecuted') {
      const exclusion = contextExclusionFor(event.data)
      const tool = toolsById.get(actionCallId)
      if (exclusion === undefined || exclusion.status !== 'not_executed' || Object.hasOwn(event.data, 'result')) {
        invalidDiagnosticEvent('Not-executed tool activity has an invalid exclusion')
        continue
      }
      if (tool === undefined) {
        invalidDiagnosticEvent('Agent tool event has no start boundary')
        continue
      }
      if (tool.state !== 'running') {
        invalidDiagnosticEvent('Agent tool activity has multiple terminal events')
        continue
      }
      validateToolAction(tool, event.data)
      tool.contextExclusion = exclusion
      tool.state = 'not_executed'
      continue
    }
    const exclusion = contextExclusionFor(event.data)
    if (exclusion?.status === 'not_executed') invalidDiagnosticEvent('Completed tool activity cannot be marked not executed')
    const tool = toolsById.get(actionCallId)
    if (tool === undefined) {
      if (exclusion !== undefined) {
        invalidDiagnosticEvent('Agent tool event has no start boundary')
      }
      continue
    }
    if (exclusion !== undefined) {
      if (tool.state !== 'running') invalidDiagnosticEvent('Agent tool activity has multiple terminal events')
      validateToolAction(tool, event.data)
    } else if (tool.state === 'omitted' || tool.state === 'not_executed') {
      invalidDiagnosticEvent('Agent tool activity has multiple terminal events')
    }
    tool.contextExclusion = exclusion ?? null
    tool.state = exclusion?.status ?? 'complete'
    tool.output = parseOptionalJson(event.data.result)
    tool.cacheHit = event.data.cacheHit === true
    tool.duplicateOfActionCallId = typeof event.data.reusedActionCallId === 'string' ? event.data.reusedActionCallId : null
    if (tool.actionName === 'pages.get' || tool.actionName === 'pages.getVersion') {
      const identity = readIdentity(tool.actionName, tool.input, tool.output)
      if (identity !== null && tool.duplicateOfActionCallId === null) {
        const first = firstReadByIdentity.get(identity)
        if (first) tool.duplicateOfActionCallId = first
        else firstReadByIdentity.set(identity, tool.actionCallId)
      }
      if (tool.state === 'complete') completedPageReads += 1
    } else if (tool.state === 'complete') {
      completedPageReads += recentEvidenceRowCount(tool.actionName, tool.output)
    }
  }

  const duplicateReads = tools
    .filter(tool => tool.duplicateOfActionCallId !== null)
    .map(tool => ({
      actionCallId: tool.actionCallId,
      duplicateOfActionCallId: tool.duplicateOfActionCallId,
      actionName: tool.actionName,
      cacheHit: tool.cacheHit
    }))
  const findings: Readonly<Record<string, unknown>>[] = []
  if (duplicateReads.length > 0) findings.push({ kind: 'duplicate_page_reads', count: duplicateReads.length, calls: duplicateReads })
  if (rejectedEvidenceDrafts > 0) findings.push({ kind: 'evidence_retries', count: rejectedEvidenceDrafts, issues: [...evidenceIssues] })
  if (acceptedWithoutCitations) findings.push({ kind: 'page_answer_accepted_without_citations' })
  return { toolCalls: tools, findings }
}

export const exportAgentSessionDiagnostics = async (knex: Knex, sessionId: string): Promise<Readonly<Record<string, unknown>>> => {
  const session = (await knex('agentSessions')
    .where({ id: sessionId })
    .first(
      'id',
      'ownerId',
      'title',
      'titleSource',
      'retention',
      'folderId',
      'providerProfileId',
      'googleSearchEnabled',
      'executionMode',
      'version',
      'summary',
      'summaryThroughOrdinal',
      'memorySnapshot',
      'createdAt',
      'updatedAt',
      'lastActivityAt',
      'expiresAt',
      'deletedAt'
    )) as Record<string, unknown> | undefined
  if (!session) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent resource was not found', 404)

  const [messages, runRows, eventRows, skillRows, goals] = await Promise.all([
    knex('agentMessages')
      .where({ sessionId })
      .orderBy('ordinal')
      .select(
        'id',
        'runId',
        'ordinal',
        'role',
        'status',
        'content',
        'isVisible',
        'citations',
        'googleSearchGrounding',
        'providerStateSha256',
        'createdAt',
        'updatedAt'
      ) as Promise<Array<Record<string, unknown>>>,
    knex('agentRuns')
      .where({ sessionId })
      .orderBy('queuedAt')
      .select(
        'id',
        'userMessageId',
        'assistantMessageId',
        'clientRequestId',
        'goalId',
        'goalContinuation',
        'status',
        'attempts',
        'maxAttempts',
        'eventSequence',
        'availableAt',
        'cancelRequestedAt',
        'sideEffectsStarted',
        'providerProfileVersionId',
        'transportKind',
        'model',
        'executionMode',
        'googleSearchEnabled',
        'profilePolicyVersion',
        'defaultGeneration',
        'capabilityRevision',
        'pricingRevision',
        'promptVersion',
        'inputTokens',
        'outputTokens',
        'totalTokens',
        'estimatedCostMicros',
        'completionOutcome',
        'completionAssessment',
        'completionAssessmentSha256',
        'errorCode',
        'errorMessage',
        'queuedAt',
        'startedAt',
        'updatedAt',
        'completedAt'
      ) as Promise<Array<Record<string, unknown>>>,
    knex<DiagnosticEventRow>('agentEvents')
      .join('agentRuns', 'agentRuns.id', 'agentEvents.runId')
      .where('agentRuns.sessionId', sessionId)
      .orderBy('agentRuns.queuedAt')
      .orderBy('agentEvents.sequence')
      .select('agentEvents.*'),
    knex('agentRunSkills')
      .join('agentSkillVersions', 'agentSkillVersions.id', 'agentRunSkills.skillVersionId')
      .join('agentSkills', 'agentSkills.id', 'agentSkillVersions.skillId')
      .join('agentRuns', 'agentRuns.id', 'agentRunSkills.runId')
      .where('agentRuns.sessionId', sessionId)
      .orderBy('agentRunSkills.ordinal')
      .select(
        'agentRunSkills.runId',
        'agentRunSkills.ordinal',
        'agentSkillVersions.id as versionId',
        'agentSkillVersions.contentHash',
        'agentSkillVersions.skillMarkdown',
        'agentSkills.name'
      ) as Promise<Array<Record<string, unknown>>>,
    knex('agentGoals')
      .where({ sessionId })
      .orderBy('startedAt')
      .select(
        'id',
        'objective',
        'objectiveSha256',
        'status',
        'version',
        'continuationCount',
        'maxContinuations',
        'consumedTokens',
        'maxTokens',
        'consumedToolCalls',
        'maxToolCalls',
        'completionOutcome',
        'completionAssessment',
        'completionAssessmentSha256',
        'errorCode',
        'errorMessage',
        'startedAt',
        'deadlineAt',
        'updatedAt',
        'completedAt'
      ) as Promise<Array<Record<string, unknown>>>
  ])

  const eventsByRun = new Map<
    string,
    Array<{
      id: string
      sequence: number
      type: string
      attempt: number
      schemaVersion: number
      dataSha256: string
      data: Record<string, unknown>
      createdAt: string
    }>
  >()
  for (const row of eventRows) {
    if (sha256(row.data) !== row.dataSha256) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Agent event payload hash mismatch', 500)
    const event = {
      id: row.id,
      sequence: Number(row.sequence),
      type: row.type,
      attempt: Number(row.attempt),
      schemaVersion: Number(row.schemaVersion),
      dataSha256: row.dataSha256,
      data: parseObject(row.data, 'AGENT_EVENT_CORRUPT'),
      createdAt: iso(row.createdAt)
    }
    const existing = eventsByRun.get(row.runId)
    if (existing) existing.push(event)
    else eventsByRun.set(row.runId, [event])
  }

  const skillsByRun = new Map<string, Record<string, unknown>[]>()
  for (const row of skillRows) {
    const runId = String(row.runId)
    const skill = { ordinal: Number(row.ordinal), versionId: row.versionId, name: row.name, contentHash: row.contentHash, skillMarkdown: row.skillMarkdown }
    const existing = skillsByRun.get(runId)
    if (existing) existing.push(skill)
    else skillsByRun.set(runId, [skill])
  }

  const runs: Array<Readonly<Record<string, unknown>>> = []
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostMicros: 0 }
  for (const row of runRows) {
    const usage = readDiagnosticUsage(row)
    const id = String(row.id)
    const timeline = eventsByRun.get(id) ?? []
    const diagnostics = analyzeTools(timeline)
    const run = {
      id,
      userMessageId: row.userMessageId,
      assistantMessageId: row.assistantMessageId,
      clientRequestId: row.clientRequestId,
      goalId: row.goalId,
      goalContinuation: row.goalContinuation === null ? null : Number(row.goalContinuation),
      status: row.status,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.maxAttempts),
      eventSequence: Number(row.eventSequence),
      availableAt: iso(row.availableAt as Date | string),
      cancelRequestedAt: nullableIso(row.cancelRequestedAt as Date | string | null),
      sideEffectsStarted: Boolean(row.sideEffectsStarted),
      provider: {
        profileVersionId: row.providerProfileVersionId,
        transport: row.transportKind,
        model: row.model,
        capabilityRevision: row.capabilityRevision,
        pricingRevision: row.pricingRevision,
        profilePolicyVersion: Number(row.profilePolicyVersion),
        defaultGeneration: Number(row.defaultGeneration),
        googleSearchEnabled: row.googleSearchEnabled === true || row.googleSearchEnabled === 1,
        promptVersion: Number(row.promptVersion)
      },
      usage,
      completion:
        row.completionOutcome === null
          ? null
          : {
              outcome: row.completionOutcome,
              assessment: parseOptionalJson(row.completionAssessment),
              sha256: row.completionAssessmentSha256
            },
      error: row.errorCode === null ? null : { code: row.errorCode, message: row.errorMessage },
      queuedAt: iso(row.queuedAt as Date | string),
      startedAt: nullableIso(row.startedAt as Date | string | null),
      updatedAt: iso(row.updatedAt as Date | string),
      completedAt: nullableIso(row.completedAt as Date | string | null),
      skills: skillsByRun.get(id) ?? [],
      timeline,
      diagnostics
    }
    totals.inputTokens = safeDiagnosticAdd(totals.inputTokens, usage.inputTokens, diagnosticUsageOverflow)
    totals.outputTokens = safeDiagnosticAdd(totals.outputTokens, usage.outputTokens, diagnosticUsageOverflow)
    totals.totalTokens = safeDiagnosticAdd(totals.totalTokens, usage.totalTokens, diagnosticUsageOverflow)
    if (usage.estimatedCostMicros !== null)
      totals.estimatedCostMicros = safeDiagnosticAdd(totals.estimatedCostMicros, usage.estimatedCostMicros, diagnosticUsageOverflow)
    runs.push(run)
  }

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    limitations: {
      modelRationale: 'Private chain-of-thought is neither retained nor exported. Tool reasons identify observable control-flow context only.',
      historicalToolInputs:
        'Tool inputs are available for runs created after diagnostic input capture was enabled. Older selectors may be inferred from successful outputs.',
      intermediateContent: 'Model turn content is capped at 32,000 characters per turn; final assistant messages are complete in messages.'
    },
    session: {
      id: session.id,
      ownerId: Number(session.ownerId),
      title: session.title,
      titleSource: session.titleSource,
      retention: session.retention,
      folderId: session.folderId,
      providerProfileId: session.providerProfileId,
      googleSearchEnabled: session.googleSearchEnabled === true || session.googleSearchEnabled === 1,
      executionMode: session.executionMode,
      version: Number(session.version),
      summary: session.summary,
      summaryThroughOrdinal: session.summaryThroughOrdinal === null ? null : Number(session.summaryThroughOrdinal),
      memorySnapshot: decodeAgentMemorySnapshot(String(session.memorySnapshot)),
      createdAt: iso(session.createdAt as Date | string),
      updatedAt: iso(session.updatedAt as Date | string),
      lastActivityAt: iso(session.lastActivityAt as Date | string),
      expiresAt: nullableIso(session.expiresAt as Date | string | null),
      deletedAt: nullableIso(session.deletedAt as Date | string | null)
    },
    messages: messages.map(message => ({
      id: message.id,
      runId: message.runId,
      ordinal: Number(message.ordinal),
      role: message.role,
      status: message.status,
      content: message.content,
      visible: Boolean(message.isVisible),
      citations: parseOptionalJson(message.citations),
      googleSearchGrounding: parseOptionalJson(message.googleSearchGrounding),
      providerContinuation: message.providerStateSha256 === null ? null : { sha256: message.providerStateSha256, contentExported: false },
      createdAt: iso(message.createdAt as Date | string),
      updatedAt: iso(message.updatedAt as Date | string)
    })),
    goals: goals.map(goal => ({
      ...goal,
      version: Number(goal.version),
      continuationCount: Number(goal.continuationCount),
      maxContinuations: Number(goal.maxContinuations),
      consumedTokens: Number(goal.consumedTokens),
      maxTokens: Number(goal.maxTokens),
      consumedToolCalls: Number(goal.consumedToolCalls),
      maxToolCalls: Number(goal.maxToolCalls),
      completionAssessment: parseOptionalJson(goal.completionAssessment),
      startedAt: iso(goal.startedAt as Date | string),
      deadlineAt: iso(goal.deadlineAt as Date | string),
      updatedAt: iso(goal.updatedAt as Date | string),
      completedAt: nullableIso(goal.completedAt as Date | string | null)
    })),
    totals,
    runs
  }
}
