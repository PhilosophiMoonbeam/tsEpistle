import type { AxChatResponse } from '@ax-llm/ax'

import type { AgentEventData, AgentTokenUsage } from '../../../shared/agents/contracts.ts'
import { AgentRepositoryError } from '../repository.ts'

type AgentUsageIssue = 'missing' | 'shape' | 'unsafe_integer' | 'directional_overflow' | 'total_below_directions' | 'regression'
type AgentUsageField = 'inputTokens' | 'outputTokens' | 'totalTokens'
type UsageReceipt = { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number }
type UsageDiagnostics = {
  readonly usageIssue: AgentUsageIssue
  readonly usageField?: AgentUsageField
  readonly prior?: UsageReceipt
  readonly current?: UsageReceipt
}

const invalidProviderUsage = (diagnostics?: UsageDiagnostics): AgentRepositoryError => {
  const error = new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Provider returned incomplete or invalid token usage', 502)
  if (diagnostics !== undefined) Object.defineProperty(error, 'agentDiagnostics', { value: diagnostics, enumerable: false })
  return error
}

const invalidEventUsage = (): AgentRepositoryError => new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored agent usage event data is invalid', 500)

const validToken = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const safeDirectionalSum = (inputTokens: number, outputTokens: number): number | null => {
  if (outputTokens > Number.MAX_SAFE_INTEGER - inputTokens) return null
  return inputTokens + outputTokens
}

const safeReceipt = (inputTokens: unknown, outputTokens: unknown, totalTokens: unknown): UsageReceipt => {
  const receipt: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {}
  if (validToken(inputTokens)) receipt.inputTokens = inputTokens
  if (validToken(outputTokens)) receipt.outputTokens = outputTokens
  if (validToken(totalTokens)) receipt.totalTokens = totalTokens
  return receipt
}

const invalidTokenIssue = (value: unknown): 'missing' | 'shape' | 'unsafe_integer' => {
  if (value === undefined) return 'missing'
  return typeof value === 'number' ? 'unsafe_integer' : 'shape'
}

export const assertAgentTokenUsage = (inputTokens: number, outputTokens: number, totalTokens: number): void => {
  const current = safeReceipt(inputTokens, outputTokens, totalTokens)
  if (!validToken(inputTokens)) throw invalidProviderUsage({ usageIssue: invalidTokenIssue(inputTokens), usageField: 'inputTokens', current })
  if (!validToken(outputTokens)) throw invalidProviderUsage({ usageIssue: invalidTokenIssue(outputTokens), usageField: 'outputTokens', current })
  if (!validToken(totalTokens)) throw invalidProviderUsage({ usageIssue: invalidTokenIssue(totalTokens), usageField: 'totalTokens', current })
  const directionalSum = safeDirectionalSum(inputTokens, outputTokens)
  if (directionalSum === null) throw invalidProviderUsage({ usageIssue: 'directional_overflow', current })
  if (totalTokens < directionalSum) throw invalidProviderUsage({ usageIssue: 'total_below_directions', current })
}

const readUsageToken = (value: unknown, field: AgentUsageField): number => {
  if (!validToken(value)) throw invalidProviderUsage({ usageIssue: invalidTokenIssue(value), usageField: field })
  return value
}

export const readAgentProviderUsage = (response: AxChatResponse): AgentTokenUsage | null => {
  try {
    const modelUsage = Reflect.get(response, 'modelUsage')
    if (modelUsage === undefined) return null
    if (typeof modelUsage !== 'object' || modelUsage === null || Array.isArray(modelUsage)) throw invalidProviderUsage({ usageIssue: 'shape' })
    const tokens = Reflect.get(modelUsage, 'tokens')
    if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) throw invalidProviderUsage({ usageIssue: 'shape' })
    const inputTokens = readUsageToken(Reflect.get(tokens, 'promptTokens'), 'inputTokens')
    const outputTokens = readUsageToken(Reflect.get(tokens, 'completionTokens'), 'outputTokens')
    const totalTokens = readUsageToken(Reflect.get(tokens, 'totalTokens'), 'totalTokens')
    assertAgentTokenUsage(inputTokens, outputTokens, totalTokens)
    return { inputTokens, outputTokens, totalTokens }
  } catch (error) {
    if (error instanceof AgentRepositoryError && error.code === 'PROVIDER_USAGE_INVALID') throw error
    throw invalidProviderUsage({ usageIssue: 'shape' })
  }
}

export const readAgentUsageEvent = (data: AgentEventData): AgentTokenUsage & { readonly costMicros: number } => {
  try {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw invalidEventUsage()
    const hasUsageVersion = Reflect.has(data, 'usageVersion')
    const hasTotalTokens = Reflect.has(data, 'totalTokens')
    const inputTokens = Reflect.get(data, 'inputTokens')
    const outputTokens = Reflect.get(data, 'outputTokens')
    const usageVersion = Reflect.get(data, 'usageVersion')
    const costPresent = Reflect.has(data, 'costMicros')
    const rawCostMicros = costPresent ? Reflect.get(data, 'costMicros') : 0
    if (!validToken(inputTokens) || !validToken(outputTokens) || !validToken(rawCostMicros)) throw invalidEventUsage()
    if (hasUsageVersion || hasTotalTokens) {
      if (usageVersion !== 2 || !hasTotalTokens || !costPresent) throw invalidEventUsage()
      const totalTokens = Reflect.get(data, 'totalTokens')
      if (!validToken(totalTokens)) throw invalidEventUsage()
      assertAgentTokenUsage(inputTokens, outputTokens, totalTokens)
      return { inputTokens, outputTokens, totalTokens, costMicros: rawCostMicros }
    }
    const totalTokens = safeDirectionalSum(inputTokens, outputTokens)
    if (totalTokens === null) throw invalidEventUsage()
    assertAgentTokenUsage(inputTokens, outputTokens, totalTokens)
    return { inputTokens, outputTokens, totalTokens, costMicros: rawCostMicros }
  } catch {
    throw invalidEventUsage()
  }
}
