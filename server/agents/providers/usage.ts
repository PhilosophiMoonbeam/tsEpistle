import type { AxChatResponse } from '@ax-llm/ax'

import type { AgentEventData, AgentTokenUsage } from '../../../shared/agents/contracts.ts'
import { AgentRepositoryError } from '../repository.ts'

const invalidProviderUsage = (): AgentRepositoryError =>
  new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Provider returned incomplete or invalid token usage', 502)

const invalidEventUsage = (): AgentRepositoryError => new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored agent usage event data is invalid', 500)

const validToken = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const safeDirectionalSum = (inputTokens: number, outputTokens: number): number | null => {
  if (outputTokens > Number.MAX_SAFE_INTEGER - inputTokens) return null
  return inputTokens + outputTokens
}

export const assertAgentTokenUsage = (inputTokens: number, outputTokens: number, totalTokens: number): void => {
  if (!validToken(inputTokens) || !validToken(outputTokens) || !validToken(totalTokens)) throw invalidProviderUsage()
  const directionalSum = safeDirectionalSum(inputTokens, outputTokens)
  if (directionalSum === null || totalTokens < directionalSum) throw invalidProviderUsage()
}

export const readAgentProviderUsage = (response: AxChatResponse): AgentTokenUsage | null => {
  try {
    const modelUsage = Reflect.get(response, 'modelUsage')
    if (modelUsage === undefined) return null
    if (typeof modelUsage !== 'object' || modelUsage === null || Array.isArray(modelUsage)) throw invalidProviderUsage()
    const tokens = Reflect.get(modelUsage, 'tokens')
    if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) throw invalidProviderUsage()
    const inputTokens = Reflect.get(tokens, 'promptTokens')
    const outputTokens = Reflect.get(tokens, 'completionTokens')
    const totalTokens = Reflect.get(tokens, 'totalTokens')
    if (!validToken(inputTokens) || !validToken(outputTokens) || !validToken(totalTokens)) throw invalidProviderUsage()
    assertAgentTokenUsage(inputTokens, outputTokens, totalTokens)
    return { inputTokens, outputTokens, totalTokens }
  } catch (error) {
    if (error instanceof AgentRepositoryError && error.code === 'PROVIDER_USAGE_INVALID') throw error
    throw invalidProviderUsage()
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
