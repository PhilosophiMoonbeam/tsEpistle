import { createHash } from 'node:crypto'
import type { Knex } from 'knex'

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
  state: 'running' | 'complete' | 'failed'
  output: unknown
  errorCode: string | null
  cacheHit: boolean
  duplicateOfActionCallId: string | null
  requestedAfterRejectedEvidenceDrafts: number
  requestReason: 'model_requested' | 'model_requested_after_evidence_rejection'
  rationale: null
}

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const nullableIso = (value: Date | string | null): string | null => value === null ? null : iso(value)
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

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
  try { return JSON.parse(value) } catch { return null }
}

const readIdentity = (actionName: string, input: unknown, output: unknown): string | null => {
  if (actionName !== 'pages.get' && actionName !== 'pages.getVersion') return null
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const candidate = input as Record<string, unknown>
    if (candidate.id !== undefined) return `${actionName}:id:${String(candidate.id)}`
    if (typeof candidate.path === 'string' && typeof candidate.locale === 'string') return `${actionName}:path:${candidate.locale}:${candidate.path}`
    if (candidate.pageId !== undefined && candidate.versionId !== undefined) return `${actionName}:version:${String(candidate.pageId)}:${String(candidate.versionId)}`
  }
  if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
    const candidate = output as Record<string, unknown>
    if (candidate.id !== undefined && candidate.sourceRevision !== undefined) return `${actionName}:result:${String(candidate.id)}:${String(candidate.sourceRevision)}`
  }
  return null
}

const analyzeTools = (events: readonly { readonly type: string, readonly data: Record<string, unknown> }[]): {
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
      } else if (event.data.accepted === true && completedPageReads > 0 && Array.isArray(event.data.finalCitationIds) && event.data.finalCitationIds.length === 0) {
        acceptedWithoutCitations = true
      }
      continue
    }
    const actionCallId = typeof event.data.actionCallId === 'string' ? event.data.actionCallId : ''
    if (!actionCallId) continue
    if (event.type === 'tool.started') {
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
    const tool = toolsById.get(actionCallId)
    if (!tool) continue
    if (event.type === 'tool.failed') {
      tool.state = 'failed'
      tool.errorCode = typeof event.data.errorCode === 'string' ? event.data.errorCode : 'ACTION_FAILED'
      continue
    }
    if (event.type !== 'tool.completed') continue
    tool.state = 'complete'
    tool.output = parseOptionalJson(event.data.result)
    tool.cacheHit = event.data.cacheHit === true
    tool.duplicateOfActionCallId = typeof event.data.reusedActionCallId === 'string' ? event.data.reusedActionCallId : null
    if (tool.actionName === 'pages.get' || tool.actionName === 'pages.getVersion') completedPageReads += 1
    const identity = readIdentity(tool.actionName, tool.input, tool.output)
    if (identity !== null && tool.duplicateOfActionCallId === null) {
      const first = firstReadByIdentity.get(identity)
      if (first) tool.duplicateOfActionCallId = first
      else firstReadByIdentity.set(identity, tool.actionCallId)
    }
  }

  const duplicateReads = tools.filter(tool => tool.duplicateOfActionCallId !== null).map(tool => ({
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
  const session = await knex('agentSessions').where({ id: sessionId }).first(
    'id', 'ownerId', 'title', 'titleSource', 'retention', 'providerProfileId', 'executionMode', 'version', 'summary', 'summaryThroughOrdinal', 'memorySnapshot', 'createdAt', 'updatedAt', 'lastActivityAt', 'expiresAt', 'deletedAt'
  ) as Record<string, unknown> | undefined
  if (!session) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent resource was not found', 404)

  const [messages, runRows, eventRows, skillRows] = await Promise.all([
    knex('agentMessages').where({ sessionId }).orderBy('ordinal').select('id', 'runId', 'ordinal', 'role', 'status', 'content', 'citations', 'providerStateSha256', 'createdAt', 'updatedAt') as Promise<Array<Record<string, unknown>>>,
    knex('agentRuns').where({ sessionId }).orderBy('queuedAt').select(
      'id', 'userMessageId', 'assistantMessageId', 'clientRequestId', 'status', 'attempts', 'maxAttempts', 'eventSequence', 'availableAt', 'cancelRequestedAt', 'sideEffectsStarted', 'providerProfileVersionId', 'transportKind', 'model', 'executionMode', 'profilePolicyVersion', 'defaultGeneration', 'capabilityRevision', 'pricingRevision', 'promptVersion', 'inputTokens', 'outputTokens', 'estimatedCostMicros', 'errorCode', 'errorMessage', 'queuedAt', 'startedAt', 'updatedAt', 'completedAt'
    ) as Promise<Array<Record<string, unknown>>>,
    knex<DiagnosticEventRow>('agentEvents').join('agentRuns', 'agentRuns.id', 'agentEvents.runId').where('agentRuns.sessionId', sessionId).orderBy('agentRuns.queuedAt').orderBy('agentEvents.sequence').select('agentEvents.*'),
    knex('agentRunSkills').join('agentSkillVersions', 'agentSkillVersions.id', 'agentRunSkills.skillVersionId').join('agentSkills', 'agentSkills.id', 'agentSkillVersions.skillId').join('agentRuns', 'agentRuns.id', 'agentRunSkills.runId').where('agentRuns.sessionId', sessionId).orderBy('agentRunSkills.ordinal').select('agentRunSkills.runId', 'agentRunSkills.ordinal', 'agentSkillVersions.id as versionId', 'agentSkillVersions.contentHash', 'agentSkillVersions.skillMarkdown', 'agentSkills.name') as Promise<Array<Record<string, unknown>>>
  ])

  const eventsByRun = new Map<string, Array<{ id: string, sequence: number, type: string, attempt: number, schemaVersion: number, dataSha256: string, data: Record<string, unknown>, createdAt: string }>>()
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

  const runs = runRows.map(row => {
    const id = String(row.id)
    const timeline = eventsByRun.get(id) ?? []
    const diagnostics = analyzeTools(timeline)
    return {
      id,
      userMessageId: row.userMessageId,
      assistantMessageId: row.assistantMessageId,
      clientRequestId: row.clientRequestId,
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
        promptVersion: Number(row.promptVersion)
      },
      usage: {
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        totalTokens: Number(row.inputTokens) + Number(row.outputTokens),
        estimatedCostMicros: row.estimatedCostMicros === null ? null : Number(row.estimatedCostMicros)
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
  })

  const totals = runs.reduce((sum, run) => ({
    inputTokens: sum.inputTokens + run.usage.inputTokens,
    outputTokens: sum.outputTokens + run.usage.outputTokens,
    totalTokens: sum.totalTokens + run.usage.totalTokens,
    estimatedCostMicros: sum.estimatedCostMicros + (run.usage.estimatedCostMicros ?? 0)
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostMicros: 0 })

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    limitations: {
      modelRationale: 'Private chain-of-thought is neither retained nor exported. Tool reasons identify observable control-flow context only.',
      historicalToolInputs: 'Tool inputs are available for runs created after diagnostic input capture was enabled. Older selectors may be inferred from successful outputs.',
      intermediateContent: 'Model turn content is capped at 32,000 characters per turn; final assistant messages are complete in messages.'
    },
    session: {
      id: session.id,
      ownerId: Number(session.ownerId),
      title: session.title,
      titleSource: session.titleSource,
      retention: session.retention,
      providerProfileId: session.providerProfileId,
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
      citations: parseOptionalJson(message.citations),
      providerContinuation: message.providerStateSha256 === null ? null : { sha256: message.providerStateSha256, contentExported: false },
      createdAt: iso(message.createdAt as Date | string),
      updatedAt: iso(message.updatedAt as Date | string)
    })),
    totals,
    runs
  }
}
