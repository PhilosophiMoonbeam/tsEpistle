import { AGENT_PDF_ERRORS, type AgentPdfErrorCode, AgentPdfPreparationError } from '../pdf-preparation.ts'
import { AgentRepositoryError } from '../repository.ts'
import { AgentProviderAttemptError } from './factory.ts'
import type { AgentProviderTransportKind } from './registry.ts'

export const AGENT_EXECUTION_FAILURE_STAGES = [
  'setup',
  'context_admission',
  'dispatch_admission',
  'provider_request',
  'provider_stream',
  'provider_response',
  'usage_reconciliation',
  'action_cleanup',
  'unknown'
] as const

export type AgentExecutionFailureStage = (typeof AGENT_EXECUTION_FAILURE_STAGES)[number]

export type AgentExecutionFailureCode =
  | 'AGENT_MEDIA_WINDOW_LIMIT'
  | 'AGENT_MEDIA_INPUT_UNSUPPORTED'
  | 'AGENT_MEDIA_INPUT_LIMIT'
  | 'AGENT_MEDIA_DISABLED'
  | 'AGENT_MEDIA_NOT_FOUND'
  | 'AGENT_MEDIA_CORRUPT'
  | 'INVALID_MEDIA_INPUT'
  | 'INVALID_AGENT_MEDIA'
  | 'MEDIA_BUDGET_REQUIRED'
  | 'MEDIA_PROVIDER_CHANGED'
  | 'MEDIA_PROVIDER_CORRUPT'
  | 'AGENT_ACCESS_REVOKED'
  | 'AGENT_EVENT_CORRUPT'
  | AgentPdfErrorCode
  | 'AGENT_PDF_PAGE_LIMIT'
  | 'AGENT_MEDIA_PART_LIMIT'
  | 'AGENT_MEDIA_CONTEXT_LIMIT'
  | 'AGENT_CONTEXT_TOO_LARGE'
  | 'INVALID_PROVIDER_REQUEST'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'AGENT_PROVIDER_STATE_CORRUPT'
  | 'PROVIDER_USAGE_INVALID'
  | 'PROVIDER_EGRESS_DENIED'
  | 'AGENT_TURN_LIMIT'
  | 'AGENT_EVIDENCE_INVALID'
  | 'AGENT_BUDGET_LIMITED'
  | 'AGENT_TOKEN_BUDGET_LIMITED'
  | 'AGENT_QUOTA_EXHAUSTED'
  | 'DISPATCH_RESERVATION_EXCEEDED'
  | 'DISPATCH_RESERVATION_INVALID'
  | 'AGENT_CHILD_BUDGET_EXCEEDED'
  | 'AGENT_ACTION_RECOVERY_REQUIRED'
  | 'AGENT_SPECIALIST_CONTINUATION_INVALID'
  | 'AGENT_SPECIALIST_CONTEXT_LIMIT'
  | 'AGENT_SPECIALIST_HANDOFF_INVALID'
  | 'INVALID_SUBAGENT_AUTHORITY'
  | 'AGENT_ACTION_CONTINUATION_MISMATCH'
  | 'UNEXPECTED_PROVIDER_TOOL_CALL'
  | 'PROVIDER_CONTEXT_TOO_LARGE'
  | 'ACTION_SESSION_CLOSE_FAILED'
  | 'PROVIDER_REDIRECT_DENIED'
  | 'PROVIDER_AUTH_REJECTED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_REQUEST_TOO_LARGE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_REQUEST_REJECTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REQUEST_FAILED'
  | 'EXTERNAL_MCP_ACCESS_DENIED'
  | 'EXTERNAL_MCP_NATIVE_TOOLS_REQUIRED'
  | 'EXTERNAL_MCP_TOOL_COLLISION'
  | 'EXTERNAL_MCP_CATALOG_LIMIT'
  | 'EXTERNAL_MCP_RESULT_LIMIT'
  | 'EXTERNAL_MCP_BUDGET_REQUIRED'
  | 'EXTERNAL_MCP_SIDE_EFFECT_FENCE_REQUIRED'
  | 'EXTERNAL_MCP_CALL_FAILED'
  | 'EXTERNAL_MCP_MODALITY_UNSUPPORTED'

export const AGENT_USAGE_ISSUES = ['missing', 'shape', 'unsafe_integer', 'directional_overflow', 'total_below_directions', 'regression'] as const
export type AgentExecutionFailureUsageIssue = (typeof AGENT_USAGE_ISSUES)[number]

export const AGENT_USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens'] as const
export type AgentExecutionFailureUsageField = (typeof AGENT_USAGE_FIELDS)[number]

export interface AgentExecutionFailureUsageReceipt {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export interface AgentExecutionFailureContextDiagnostics {
  readonly inputBytes?: number
  readonly candidateBytes?: number
  readonly limitBytes?: number
  readonly visibleSchemaBytes?: number
  readonly admittedResultCount?: number
  readonly omittedResultCount?: number
}

export interface AgentExecutionFailureDiagnostics {
  readonly usageIssue?: AgentExecutionFailureUsageIssue
  readonly usageField?: AgentExecutionFailureUsageField
  readonly prior?: AgentExecutionFailureUsageReceipt
  readonly current?: AgentExecutionFailureUsageReceipt
  readonly context?: AgentExecutionFailureContextDiagnostics
  readonly providerTurn?: number
  readonly transportKind?: AgentProviderTransportKind
  readonly providerErrorCode?: string
}
const SAFE_EXTERNAL_MCP_CODES: Readonly<Record<string, true>> = {
  EXTERNAL_MCP_ACCESS_DENIED: true,
  EXTERNAL_MCP_NATIVE_TOOLS_REQUIRED: true,
  EXTERNAL_MCP_TOOL_COLLISION: true,
  EXTERNAL_MCP_CATALOG_LIMIT: true,
  EXTERNAL_MCP_RESULT_LIMIT: true,
  EXTERNAL_MCP_BUDGET_REQUIRED: true,
  EXTERNAL_MCP_SIDE_EFFECT_FENCE_REQUIRED: true,
  EXTERNAL_MCP_CALL_FAILED: true,
  EXTERNAL_MCP_MODALITY_UNSUPPORTED: true
}
const SAFE_REPOSITORY_CODES: Readonly<Record<string, true>> = {
  ...SAFE_EXTERNAL_MCP_CODES,
  AGENT_MEDIA_WINDOW_LIMIT: true,
  AGENT_MEDIA_INPUT_UNSUPPORTED: true,
  AGENT_MEDIA_INPUT_LIMIT: true,
  AGENT_MEDIA_DISABLED: true,
  AGENT_MEDIA_NOT_FOUND: true,
  AGENT_MEDIA_CORRUPT: true,
  INVALID_MEDIA_INPUT: true,
  INVALID_AGENT_MEDIA: true,
  MEDIA_BUDGET_REQUIRED: true,
  MEDIA_PROVIDER_CHANGED: true,
  MEDIA_PROVIDER_CORRUPT: true,
  AGENT_ACCESS_REVOKED: true,
  AGENT_EVENT_CORRUPT: true,
  ...Object.fromEntries(Object.keys(AGENT_PDF_ERRORS).map(code => [code, true as const])),
  AGENT_PDF_PAGE_LIMIT: true,
  AGENT_MEDIA_PART_LIMIT: true,
  AGENT_MEDIA_CONTEXT_LIMIT: true,
  AGENT_CONTEXT_TOO_LARGE: true,
  INVALID_PROVIDER_REQUEST: true,
  INVALID_PROVIDER_RESPONSE: true,
  AGENT_PROVIDER_STATE_CORRUPT: true,
  PROVIDER_USAGE_INVALID: true,
  PROVIDER_EGRESS_DENIED: true,
  PROVIDER_AUTH_REJECTED: true,
  PROVIDER_TIMEOUT: true,
  PROVIDER_RATE_LIMITED: true,
  PROVIDER_REQUEST_REJECTED: true,
  PROVIDER_UNAVAILABLE: true,
  AGENT_TURN_LIMIT: true,
  AGENT_EVIDENCE_INVALID: true,
  AGENT_BUDGET_LIMITED: true,
  AGENT_TOKEN_BUDGET_LIMITED: true,
  AGENT_QUOTA_EXHAUSTED: true,
  DISPATCH_RESERVATION_EXCEEDED: true,
  DISPATCH_RESERVATION_INVALID: true,
  AGENT_CHILD_BUDGET_EXCEEDED: true,
  AGENT_ACTION_RECOVERY_REQUIRED: true,
  AGENT_SPECIALIST_CONTINUATION_INVALID: true,
  AGENT_SPECIALIST_CONTEXT_LIMIT: true,
  AGENT_SPECIALIST_HANDOFF_INVALID: true,
  INVALID_SUBAGENT_AUTHORITY: true,
  AGENT_ACTION_CONTINUATION_MISMATCH: true,
  UNEXPECTED_PROVIDER_TOOL_CALL: true
}

const SAFE_CODES: Readonly<Record<string, true>> = {
  ...SAFE_REPOSITORY_CODES,
  ACTION_SESSION_CLOSE_FAILED: true,
  PROVIDER_CONTEXT_TOO_LARGE: true,
  PROVIDER_REDIRECT_DENIED: true,
  PROVIDER_AUTH_REJECTED: true,
  PROVIDER_TIMEOUT: true,
  PROVIDER_REQUEST_TOO_LARGE: true,
  PROVIDER_RATE_LIMITED: true,
  PROVIDER_REQUEST_REJECTED: true,
  PROVIDER_UNAVAILABLE: true,
  PROVIDER_REQUEST_FAILED: true
}
const UPSTREAM_REPOSITORY_CODES: Readonly<Record<string, true>> = {
  PROVIDER_AUTH_REJECTED: true,
  PROVIDER_TIMEOUT: true,
  PROVIDER_RATE_LIMITED: true,
  PROVIDER_REQUEST_REJECTED: true,
  PROVIDER_UNAVAILABLE: true
}
const SAFE_STAGES: Readonly<Record<string, true>> = {
  setup: true,
  context_admission: true,
  dispatch_admission: true,
  provider_request: true,
  provider_stream: true,
  provider_response: true,
  usage_reconciliation: true,
  action_cleanup: true,
  unknown: true
}

const SAFE_MESSAGE = 'Agent inference failed'
const MEDIA_MESSAGES: Readonly<Record<string, string>> = {
  EXTERNAL_MCP_ACCESS_DENIED: 'External MCP access is no longer available. Check endpoint access before starting another run.',
  EXTERNAL_MCP_NATIVE_TOOLS_REQUIRED: 'External MCP requires a model with native tool calling.',
  EXTERNAL_MCP_TOOL_COLLISION: 'The external MCP tool catalog conflicts with the available tools.',
  EXTERNAL_MCP_CATALOG_LIMIT: 'The external MCP catalog exceeds the supported limit.',
  EXTERNAL_MCP_RESULT_LIMIT: 'The external MCP result exceeds the supported limit. The operation was not retried.',
  EXTERNAL_MCP_BUDGET_REQUIRED: 'External MCP requires an admitted run budget.',
  EXTERNAL_MCP_SIDE_EFFECT_FENCE_REQUIRED: 'External MCP requires a durable run fence before an operation can start.',
  EXTERNAL_MCP_CALL_FAILED: 'The external MCP operation could not be confirmed. It was not retried; do not assume success.',
  EXTERNAL_MCP_MODALITY_UNSUPPORTED: 'The selected model cannot consume the external MCP media result. The operation was not retried.',
  AGENT_MEDIA_INPUT_UNSUPPORTED: 'The selected model is not enabled to consume this attachment format. Choose a supported attachment or model.',
  AGENT_MEDIA_INPUT_LIMIT: 'The attachment exceeds the selected model’s input limit. Choose a smaller file or shorter recording.',
  AGENT_MEDIA_DISABLED: 'The requested media operation is no longer available. Check media access before starting another run.',
  AGENT_MEDIA_NOT_FOUND: 'The attachment is no longer available in this conversation. Attach it again.',
  AGENT_MEDIA_CORRUPT: 'The saved attachment failed integrity validation. Attach it again.',
  INVALID_MEDIA_INPUT: 'The media input is invalid for this operation. Choose supported attachments.',
  INVALID_AGENT_MEDIA: 'The media file is invalid or exceeds the supported limits.',
  MEDIA_BUDGET_REQUIRED: 'Media requires an admitted run budget.',
  MEDIA_PROVIDER_CHANGED: 'The admitted media provider version is no longer current. Start another run to resolve an available provider.',
  MEDIA_PROVIDER_CORRUPT: 'The saved media provider configuration is invalid. Contact an administrator.',
  AGENT_ACCESS_REVOKED: 'Current account access to Wiki Agents is no longer available.',
  AGENT_EVENT_CORRUPT: 'The saved run context failed integrity validation. Contact an administrator.',
  AGENT_MEDIA_WINDOW_LIMIT:
    'This conversation exceeds the attachment window of 16 files or 1 GB. Start a new conversation with the files needed for this request.',
  ...Object.fromEntries(Object.entries(AGENT_PDF_ERRORS).map(([code, detail]) => [code, detail.message])),
  AGENT_PDF_PAGE_LIMIT: 'The PDFs in this conversation exceed Google’s 1,000-page request limit. Start a new conversation with fewer pages.',
  AGENT_MEDIA_PART_LIMIT: 'The attachments require too many document parts. Start a new conversation with fewer or smaller files.',
  AGENT_MEDIA_CONTEXT_LIMIT: 'The attached files exceed this model’s context limit. Start a new conversation with fewer pages or smaller files.'
}
const SAFE_STATUS_BY_CODE: Readonly<Record<string, number>> = {
  AGENT_MEDIA_WINDOW_LIMIT: 413,
  AGENT_MEDIA_INPUT_UNSUPPORTED: 409,
  AGENT_MEDIA_INPUT_LIMIT: 413,
  AGENT_MEDIA_DISABLED: 403,
  AGENT_MEDIA_NOT_FOUND: 404,
  AGENT_MEDIA_CORRUPT: 500,
  INVALID_MEDIA_INPUT: 400,
  INVALID_AGENT_MEDIA: 400,
  MEDIA_BUDGET_REQUIRED: 409,
  MEDIA_PROVIDER_CHANGED: 409,
  MEDIA_PROVIDER_CORRUPT: 500,
  AGENT_ACCESS_REVOKED: 403,
  AGENT_EVENT_CORRUPT: 500,
  EXTERNAL_MCP_ACCESS_DENIED: 403,
  EXTERNAL_MCP_NATIVE_TOOLS_REQUIRED: 409,
  EXTERNAL_MCP_TOOL_COLLISION: 409,
  EXTERNAL_MCP_CATALOG_LIMIT: 413,
  EXTERNAL_MCP_RESULT_LIMIT: 413,
  EXTERNAL_MCP_BUDGET_REQUIRED: 409,
  EXTERNAL_MCP_SIDE_EFFECT_FENCE_REQUIRED: 409,
  EXTERNAL_MCP_CALL_FAILED: 502,
  EXTERNAL_MCP_MODALITY_UNSUPPORTED: 409,
  ...Object.fromEntries(Object.entries(AGENT_PDF_ERRORS).map(([code, detail]) => [code, detail.status])),
  AGENT_PDF_PAGE_LIMIT: 413,
  AGENT_MEDIA_PART_LIMIT: 413,
  AGENT_MEDIA_CONTEXT_LIMIT: 413,
  AGENT_CONTEXT_TOO_LARGE: 413,
  AGENT_TURN_LIMIT: 409,
  AGENT_EVIDENCE_INVALID: 409,
  AGENT_BUDGET_LIMITED: 409,
  AGENT_TOKEN_BUDGET_LIMITED: 409,
  AGENT_QUOTA_EXHAUSTED: 429,
  AGENT_CHILD_BUDGET_EXCEEDED: 409,
  AGENT_ACTION_RECOVERY_REQUIRED: 409,
  AGENT_SPECIALIST_CONTINUATION_INVALID: 409,
  AGENT_SPECIALIST_CONTEXT_LIMIT: 409,
  AGENT_SPECIALIST_HANDOFF_INVALID: 409,
  INVALID_SUBAGENT_AUTHORITY: 409,
  AGENT_ACTION_CONTINUATION_MISMATCH: 409,
  AGENT_PROVIDER_STATE_CORRUPT: 500,
  INVALID_PROVIDER_REQUEST: 500,
  DISPATCH_RESERVATION_INVALID: 500
}

const safeStage = (stage: AgentExecutionFailureStage): AgentExecutionFailureStage => (SAFE_STAGES[stage] === true ? stage : 'unknown')
const safeProviderStatus = (status: unknown): number | undefined =>
  typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined

const SAFE_TRANSPORT_KINDS: Readonly<Record<AgentProviderTransportKind, true>> = {
  'openai-responses': true,
  openresponses: true,
  'openai-chat': true,
  'legacy-completions': true,
  'anthropic-messages': true,
  'gemini-api': true
}
const SAFE_RECEIPT_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens'] as const
const SAFE_CONTEXT_FIELDS = ['inputBytes', 'candidateBytes', 'limitBytes', 'visibleSchemaBytes', 'admittedResultCount', 'omittedResultCount'] as const
const safeNonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const safeProperty = (value: object, key: PropertyKey): unknown => {
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}
const safeReceipt = (value: unknown): AgentExecutionFailureUsageReceipt | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const receipt: Record<string, number> = {}
  for (const field of SAFE_RECEIPT_FIELDS) {
    const item = safeNonNegativeInteger(safeProperty(value, field))
    if (item !== undefined) receipt[field] = item
  }
  return Object.keys(receipt).length > 0 ? receipt : undefined
}
const safeContext = (value: unknown): AgentExecutionFailureContextDiagnostics | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const context: Record<string, number> = {}
  for (const field of SAFE_CONTEXT_FIELDS) {
    const item = safeNonNegativeInteger(safeProperty(value, field))
    if (item !== undefined) context[field] = item
  }
  return Object.keys(context).length > 0 ? context : undefined
}
const safeEnum = <T extends readonly string[]>(value: unknown, values: T): T[number] | undefined =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T[number]) : undefined

export const normalizeAgentExecutionFailureDiagnostics = (value: unknown): AgentExecutionFailureDiagnostics | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const diagnostics: {
    usageIssue?: AgentExecutionFailureUsageIssue
    usageField?: AgentExecutionFailureUsageField
    prior?: AgentExecutionFailureUsageReceipt
    current?: AgentExecutionFailureUsageReceipt
    context?: AgentExecutionFailureContextDiagnostics
    providerTurn?: number
    transportKind?: AgentProviderTransportKind
    providerErrorCode?: string
  } = {}
  const usageIssue = safeEnum(safeProperty(value, 'usageIssue'), AGENT_USAGE_ISSUES)
  if (usageIssue !== undefined) diagnostics.usageIssue = usageIssue
  const usageField = safeEnum(safeProperty(value, 'usageField'), AGENT_USAGE_FIELDS)
  if (usageField !== undefined) diagnostics.usageField = usageField
  const prior = safeReceipt(safeProperty(value, 'prior'))
  if (prior !== undefined) diagnostics.prior = prior
  const current = safeReceipt(safeProperty(value, 'current'))
  if (current !== undefined) diagnostics.current = current
  const context = safeContext(safeProperty(value, 'context'))
  if (context !== undefined) diagnostics.context = context
  const providerTurn = safeNonNegativeInteger(safeProperty(value, 'providerTurn'))
  if (providerTurn !== undefined) diagnostics.providerTurn = providerTurn
  const transportKind = safeProperty(value, 'transportKind')
  if (typeof transportKind === 'string' && SAFE_TRANSPORT_KINDS[transportKind as AgentProviderTransportKind] === true)
    diagnostics.transportKind = transportKind as AgentProviderTransportKind
  const providerErrorCode = safeProperty(value, 'providerErrorCode')
  if (typeof providerErrorCode === 'string' && /^[a-z0-9_]{1,64}$/u.test(providerErrorCode)) diagnostics.providerErrorCode = providerErrorCode
  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined
}
export class AgentExecutionFailure extends Error {
  readonly code: AgentExecutionFailureCode
  readonly stage: AgentExecutionFailureStage
  readonly status: number
  readonly providerStatus?: number
  readonly diagnostics?: AgentExecutionFailureDiagnostics

  constructor(code: AgentExecutionFailureCode, stage: AgentExecutionFailureStage, providerStatus?: number, diagnostics?: unknown) {
    const safeCode = SAFE_CODES[code] === true ? code : 'PROVIDER_REQUEST_FAILED'
    super(MEDIA_MESSAGES[safeCode] ?? SAFE_MESSAGE)
    this.name = 'AgentExecutionFailure'
    this.code = safeCode
    this.stage = safeStage(stage)
    this.status = SAFE_STATUS_BY_CODE[safeCode] ?? 502
    const normalizedProviderStatus = safeProviderStatus(providerStatus)
    if (normalizedProviderStatus !== undefined) this.providerStatus = normalizedProviderStatus
    const normalizedDiagnostics = normalizeAgentExecutionFailureDiagnostics(diagnostics)
    if (normalizedDiagnostics !== undefined) this.diagnostics = normalizedDiagnostics
  }
}

const providerCode = (error: AgentProviderAttemptError): AgentExecutionFailureCode => {
  if (error.code === 'context_length_exceeded') return 'PROVIDER_CONTEXT_TOO_LARGE'
  if (error.code === 'PROVIDER_REDIRECT_DENIED') return 'PROVIDER_REDIRECT_DENIED'
  if (error.status === 401 || error.status === 403) return 'PROVIDER_AUTH_REJECTED'
  if (error.status === 408 || error.status === 504) return 'PROVIDER_TIMEOUT'
  if (error.status === 413) return 'PROVIDER_REQUEST_TOO_LARGE'
  if (error.status === 429) return 'PROVIDER_RATE_LIMITED'
  if (error.status >= 400 && error.status <= 499) return 'PROVIDER_REQUEST_REJECTED'
  if (error.status >= 500 && error.status <= 599) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_REQUEST_FAILED'
}

const wrappedValues = (error: unknown): readonly unknown[] => {
  if (typeof error !== 'object' || error === null) return []
  const values: unknown[] = []
  for (const key of ['originalError', 'cause'] as const) {
    try {
      const value: unknown = Reflect.get(error, key)
      if (value !== undefined && value !== error) values.push(value)
    } catch {
      // A hostile wrapper getter is not an execution classification signal.
    }
  }
  return values
}
const attachedDiagnostics = (value: object): AgentExecutionFailureDiagnostics | undefined => {
  const attached = safeProperty(value, 'agentDiagnostics')
  const publicDiagnostics = attached === undefined ? safeProperty(value, 'diagnostics') : attached
  return normalizeAgentExecutionFailureDiagnostics(publicDiagnostics)
}

export const classifyAgentExecutionFailure = (error: unknown, stage: AgentExecutionFailureStage): AgentExecutionFailure => {
  if (error instanceof AgentExecutionFailure) return error
  if (stage === 'action_cleanup') return new AgentExecutionFailure('ACTION_SESSION_CLOSE_FAILED', stage)
  const queue: Array<{ readonly value: unknown; readonly links: number }> = [{ value: error, links: 0 }]
  const seen = new Set<object>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.value instanceof AgentExecutionFailure) return current.value
    if (current.value instanceof AgentPdfPreparationError) return new AgentExecutionFailure(current.value.code, stage)
    if (current.value instanceof AgentRepositoryError) {
      const code = SAFE_REPOSITORY_CODES[current.value.code] === true ? (current.value.code as AgentExecutionFailureCode) : 'PROVIDER_REQUEST_FAILED'
      const providerStatus = UPSTREAM_REPOSITORY_CODES[code] === true ? safeProviderStatus(current.value.status) : undefined
      const diagnostics =
        SAFE_REPOSITORY_CODES[current.value.code] === true && SAFE_EXTERNAL_MCP_CODES[code] !== true ? attachedDiagnostics(current.value) : undefined
      return new AgentExecutionFailure(code, stage, providerStatus, diagnostics)
    }
    if (current.value instanceof AgentProviderAttemptError) {
      const providerStatus = safeProviderStatus(current.value.status)
      return new AgentExecutionFailure(providerCode(current.value), stage, providerStatus, attachedDiagnostics(current.value))
    }
    if (typeof current.value === 'object' && current.value !== null) {
      if (seen.has(current.value)) continue
      seen.add(current.value)
      if (current.links < 4) {
        for (const value of wrappedValues(current.value)) queue.push({ value, links: current.links + 1 })
      }
    }
  }
  return new AgentExecutionFailure('PROVIDER_REQUEST_FAILED', stage)
}
