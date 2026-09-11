import { AgentRepositoryError } from '../repository.ts'
import { AgentProviderAttemptError } from './factory.ts'

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
  | 'AGENT_CONTEXT_TOO_LARGE'
  | 'INVALID_PROVIDER_REQUEST'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'AGENT_PROVIDER_STATE_CORRUPT'
  | 'PROVIDER_USAGE_INVALID'
  | 'PROVIDER_EGRESS_DENIED'
  | 'AGENT_TURN_LIMIT'
  | 'AGENT_EVIDENCE_INVALID'
  | 'AGENT_BUDGET_LIMITED'
  | 'DISPATCH_RESERVATION_EXCEEDED'
  | 'DISPATCH_RESERVATION_INVALID'
  | 'AGENT_CHILD_BUDGET_EXCEEDED'
  | 'AGENT_ACTION_RECOVERY_REQUIRED'
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
const SAFE_REPOSITORY_CODES: Readonly<Record<string, true>> = {
  AGENT_CONTEXT_TOO_LARGE: true,
  INVALID_PROVIDER_REQUEST: true,
  INVALID_PROVIDER_RESPONSE: true,
  AGENT_PROVIDER_STATE_CORRUPT: true,
  PROVIDER_USAGE_INVALID: true,
  PROVIDER_EGRESS_DENIED: true,
  AGENT_TURN_LIMIT: true,
  AGENT_EVIDENCE_INVALID: true,
  AGENT_BUDGET_LIMITED: true,
  DISPATCH_RESERVATION_EXCEEDED: true,
  DISPATCH_RESERVATION_INVALID: true,
  AGENT_CHILD_BUDGET_EXCEEDED: true,
  AGENT_ACTION_RECOVERY_REQUIRED: true,
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
const SAFE_STATUS_BY_CODE: Readonly<Record<string, number>> = {
  AGENT_CONTEXT_TOO_LARGE: 413,
  AGENT_TURN_LIMIT: 409,
  AGENT_EVIDENCE_INVALID: 409,
  AGENT_BUDGET_LIMITED: 409,
  AGENT_CHILD_BUDGET_EXCEEDED: 409,
  AGENT_ACTION_RECOVERY_REQUIRED: 409,
  AGENT_ACTION_CONTINUATION_MISMATCH: 409,
  AGENT_PROVIDER_STATE_CORRUPT: 500,
  INVALID_PROVIDER_REQUEST: 500,
  DISPATCH_RESERVATION_INVALID: 500
}

const safeStage = (stage: AgentExecutionFailureStage): AgentExecutionFailureStage => (SAFE_STAGES[stage] === true ? stage : 'unknown')
const safeProviderStatus = (status: unknown): number | undefined =>
  typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined

export class AgentExecutionFailure extends Error {
  readonly code: AgentExecutionFailureCode
  readonly stage: AgentExecutionFailureStage
  readonly status: number
  readonly providerStatus?: number

  constructor(code: AgentExecutionFailureCode, stage: AgentExecutionFailureStage, providerStatus?: number) {
    const safeCode = SAFE_CODES[code] === true ? code : 'PROVIDER_REQUEST_FAILED'
    super(SAFE_MESSAGE)
    this.name = 'AgentExecutionFailure'
    this.code = safeCode
    this.stage = safeStage(stage)
    this.status = SAFE_STATUS_BY_CODE[safeCode] ?? 502
    const normalizedProviderStatus = safeProviderStatus(providerStatus)
    if (normalizedProviderStatus !== undefined) this.providerStatus = normalizedProviderStatus
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
export const classifyAgentExecutionFailure = (error: unknown, stage: AgentExecutionFailureStage): AgentExecutionFailure => {
  if (error instanceof AgentExecutionFailure) return error
  if (stage === 'action_cleanup') return new AgentExecutionFailure('ACTION_SESSION_CLOSE_FAILED', stage)
  const queue: Array<{ readonly value: unknown; readonly links: number }> = [{ value: error, links: 0 }]
  const seen = new Set<object>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.value instanceof AgentExecutionFailure) return current.value
    if (current.value instanceof AgentRepositoryError) {
      const code = SAFE_REPOSITORY_CODES[current.value.code] === true ? (current.value.code as AgentExecutionFailureCode) : 'PROVIDER_REQUEST_FAILED'
      return new AgentExecutionFailure(code, stage)
    }
    if (current.value instanceof AgentProviderAttemptError) {
      const providerStatus = safeProviderStatus(current.value.status)
      return new AgentExecutionFailure(providerCode(current.value), stage, providerStatus)
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
