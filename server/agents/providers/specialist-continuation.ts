import { createHash } from 'node:crypto'
import type { AxChatRequest } from '@ax-llm/ax'
import type { SpecialistProviderBinding } from '../../../shared/agents/specialists.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { SUBAGENT_READ_ACTIONS } from '../orchestration.ts'
import { AgentRepositoryError } from '../repository.ts'
import type { AgentEngineRequest } from '../runtime.ts'

export interface SpecialistEvidenceReceipt {
  readonly actionCallId: string
  readonly actionName: 'pages.get' | 'pages.getVersion' | 'pages.getOkf' | 'pages.listRecent'
  readonly sourceOutput: unknown
}

export interface SpecialistPromptEvidence extends SpecialistEvidenceReceipt {
  readonly index: number
  readonly callId: string
  readonly output: unknown
  readonly evidenceId?: string
  readonly evidenceIds?: readonly string[]
  readonly receipts?: readonly SpecialistEvidenceReceipt[]
  readonly validationOnly?: boolean
  readonly representationSha256?: string
  readonly unitPackets?: readonly string[]
}

/** Host-only state; never root run or browser state. Native thought blocks remain provider-encrypted. */
export interface SpecialistContinuation extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 1
  readonly contextId: string
  readonly taskClass: string
  readonly binding: SpecialistProviderBinding
  readonly authoritySha256: string
  readonly systemSha256: string
  readonly continuationDialect: string | null
  readonly messageCount: number
  readonly messagesSha256: string
  readonly providerPrompt: AxChatRequest['chatPrompt']
  readonly evidenceMessages: readonly SpecialistPromptEvidence[]
  readonly actionSnapshot: Readonly<Record<string, unknown>>
}

export const specialistContextSha256 = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex')
export const specialistHistorySha256 = (messages: readonly { readonly role: string; readonly content: string }[]): string =>
  specialistContextSha256(messages.map(message => ({ role: message.role, content: message.content })))

const invalid: () => never = () => {
  throw new AgentRepositoryError('AGENT_SPECIALIST_CONTINUATION_INVALID', 'Specialist continuation cannot be safely restored', 409)
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const receipt = (value: unknown): value is SpecialistEvidenceReceipt =>
  record(value) &&
  identity(value.actionCallId) &&
  ['pages.get', 'pages.getVersion', 'pages.getOkf', 'pages.listRecent'].includes(String(value.actionName)) &&
  record(value.sourceOutput)

/** Reject lossy JSON conversion (undefined, nonfinite numbers, exotic objects, cycles). */
export const boundedSpecialistJson = <T>(value: T, maximumBytes: number): T => {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 4_096 || maximumBytes > 262_144) invalid()
  let values = 0
  const ancestors = new Set<object>()
  const visit = (entry: unknown, depth: number): void => {
    if (++values > 65_536 || depth > 64) invalid()
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return
    if (typeof entry === 'number' && Number.isFinite(entry)) return
    if (typeof entry !== 'object' || ancestors.has(entry)) invalid()
    const object = entry as object
    if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) invalid()
    ancestors.add(object)
    for (const key of Reflect.ownKeys(object)) {
      if (Array.isArray(entry) && key === 'length') continue
      if (typeof key !== 'string' || !Object.getOwnPropertyDescriptor(object, key)?.enumerable || (Array.isArray(entry) && !/^(?:0|[1-9]\d*)$/u.test(key)))
        invalid()
    }
    for (const key of Object.keys(object)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalid()
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      if (!descriptor || !('value' in descriptor)) invalid()
      visit(descriptor.value, depth + 1)
    }
    if (Array.isArray(entry) && Object.keys(entry).length !== entry.length) invalid()
    ancestors.delete(object)
  }
  visit(value, 0)
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded, 'utf8') > maximumBytes)
    throw new AgentRepositoryError('AGENT_SPECIALIST_CONTEXT_LIMIT', 'Specialist continuation exceeds its bounded context', 409)
  return JSON.parse(encoded) as T
}

export const readSpecialistContinuation = (request: AgentEngineRequest): SpecialistContinuation | null => {
  const specialist = request.specialist
  if (!specialist) return null
  if (
    request.purpose !== 'subagent' ||
    request.mediaRequest ||
    request.compaction ||
    request.recoveredAction ||
    request.research ||
    request.specialistHandoff ||
    request.actionAllowlist === undefined ||
    request.actionAllowlist.some(action => !SUBAGENT_READ_ACTIONS.includes(action as (typeof SUBAGENT_READ_ACTIONS)[number])) ||
    request.memory.user.length > 0 ||
    request.memory.agent.length > 0 ||
    request.skills.length > 0 ||
    (request.priorActivity?.length ?? 0) > 0 ||
    request.messages.some(message => (message.attachments?.length ?? 0) > 0 || message.content.length === 0) ||
    specialist.binding.profileVersionId !== request.run.providerProfileVersionId
  )
    invalid()
  boundedSpecialistJson({}, specialist.maximumContextBytes)
  if (specialist.state === null) return null
  const state = boundedSpecialistJson(specialist.state, specialist.maximumContextBytes)
  if (
    state.schemaVersion !== 1 ||
    state.contextId !== specialist.contextId ||
    state.taskClass !== specialist.taskClass ||
    !record(state.binding) ||
    specialistContextSha256(state.binding) !== specialistContextSha256(specialist.binding) ||
    !hash(state.authoritySha256) ||
    !hash(state.systemSha256) ||
    !hash(state.messagesSha256) ||
    !(state.continuationDialect === null || identity(state.continuationDialect)) ||
    !Number.isSafeInteger(state.messageCount) ||
    Number(state.messageCount) < 1 ||
    Number(state.messageCount) >= request.messages.length ||
    state.messagesSha256 !== specialistHistorySha256(request.messages.slice(0, Number(state.messageCount))) ||
    !record(state.actionSnapshot) ||
    !Array.isArray(state.providerPrompt) ||
    !Array.isArray(state.evidenceMessages)
  )
    invalid()
  for (const message of state.providerPrompt) {
    if (!record(message) || !['user', 'assistant', 'function'].includes(String(message.role))) invalid()
    if (
      message.role === 'function'
        ? !identity(message.functionId) || typeof message.result !== 'string'
        : message.content !== undefined && typeof message.content !== 'string'
    )
      invalid()
    if (message.role !== 'assistant' && (message.functionCalls !== undefined || message.thoughtBlocks !== undefined)) invalid()
    if (message.functionCalls !== undefined && !Array.isArray(message.functionCalls)) invalid()
    if (message.thoughtBlocks !== undefined && !Array.isArray(message.thoughtBlocks)) invalid()
  }
  for (const evidence of state.evidenceMessages) {
    if (
      !receipt(evidence) ||
      !record(evidence) ||
      !identity(evidence.callId) ||
      !Number.isSafeInteger(evidence.index) ||
      Number(evidence.index) < 0 ||
      Number(evidence.index) >= state.providerPrompt.length ||
      (evidence.receipts !== undefined && (!Array.isArray(evidence.receipts) || !evidence.receipts.every(receipt))) ||
      (evidence.evidenceId !== undefined && !identity(evidence.evidenceId)) ||
      (evidence.evidenceIds !== undefined && (!Array.isArray(evidence.evidenceIds) || !evidence.evidenceIds.every(identity))) ||
      (evidence.validationOnly !== undefined && typeof evidence.validationOnly !== 'boolean') ||
      (evidence.representationSha256 !== undefined && !hash(evidence.representationSha256)) ||
      (evidence.unitPackets !== undefined &&
        (!Array.isArray(evidence.unitPackets) ||
          !evidence.unitPackets.every(packet => typeof packet === 'string') ||
          !hash(evidence.representationSha256) ||
          !identity(evidence.evidenceId)))
    )
      invalid()
  }
  return state as SpecialistContinuation
}
