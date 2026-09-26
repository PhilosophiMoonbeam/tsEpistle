import type { AxChatResponse } from '@ax-llm/ax'

import type { AgentEventData, AgentTokenUsage } from '../../../shared/agents/contracts.ts'
import { AgentRepositoryError } from '../repository.ts'
import type { AgentProviderTransportKind } from './registry.ts'

export type AgentProviderUsage = AgentTokenUsage & {
  readonly cachedInputTokens?: number
  readonly cacheCreationInputTokens?: number
}

type AgentUsageIssue =
  | 'missing'
  | 'shape'
  | 'unsafe_integer'
  | 'directional_overflow'
  | 'total_below_directions'
  | 'cache_exceeds_input'
  | 'regression'
type AgentUsageField = 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cachedInputTokens' | 'cacheCreationInputTokens'
type UsageReceipt = Partial<AgentProviderUsage>
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

const safeTokenSum = (...values: readonly number[]): number | null => {
  let sum = 0
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - sum) return null
    sum += value
  }
  return sum
}

const safeReceipt = (
  inputTokens: unknown,
  outputTokens: unknown,
  totalTokens: unknown,
  cachedInputTokens?: unknown,
  cacheCreationInputTokens?: unknown
): UsageReceipt => {
  const receipt: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
    cacheCreationInputTokens?: number
  } = {}
  if (validToken(inputTokens)) receipt.inputTokens = inputTokens
  if (validToken(outputTokens)) receipt.outputTokens = outputTokens
  if (validToken(totalTokens)) receipt.totalTokens = totalTokens
  if (validToken(cachedInputTokens)) receipt.cachedInputTokens = cachedInputTokens
  if (validToken(cacheCreationInputTokens)) receipt.cacheCreationInputTokens = cacheCreationInputTokens
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

const readOptionalUsageToken = (value: unknown, field: AgentUsageField): number | undefined =>
  value === undefined ? undefined : readUsageToken(value, field)

const assertAgentProviderUsage = (usage: AgentProviderUsage): void => {
  assertAgentTokenUsage(usage.inputTokens, usage.outputTokens, usage.totalTokens)
  const current = safeReceipt(
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cachedInputTokens,
    usage.cacheCreationInputTokens
  )
  if (usage.cachedInputTokens !== undefined && !validToken(usage.cachedInputTokens))
    throw invalidProviderUsage({
      usageIssue: invalidTokenIssue(usage.cachedInputTokens),
      usageField: 'cachedInputTokens',
      current
    })
  if (usage.cacheCreationInputTokens !== undefined && !validToken(usage.cacheCreationInputTokens))
    throw invalidProviderUsage({
      usageIssue: invalidTokenIssue(usage.cacheCreationInputTokens),
      usageField: 'cacheCreationInputTokens',
      current
    })
  const cachedInputTokens = usage.cachedInputTokens ?? 0
  const cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0
  if (
    cachedInputTokens > usage.inputTokens ||
    cacheCreationInputTokens > usage.inputTokens - cachedInputTokens
  )
    throw invalidProviderUsage({ usageIssue: 'cache_exceeds_input', current })
}

export const readAgentProviderUsage = (
  transportKind: AgentProviderTransportKind,
  response: AxChatResponse
): AgentProviderUsage | null => {
  try {
    const modelUsage = Reflect.get(response, 'modelUsage')
    if (modelUsage === undefined) return null
    if (typeof modelUsage !== 'object' || modelUsage === null || Array.isArray(modelUsage)) throw invalidProviderUsage({ usageIssue: 'shape' })
    const tokens = Reflect.get(modelUsage, 'tokens')
    if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) throw invalidProviderUsage({ usageIssue: 'shape' })

    const promptTokens = readUsageToken(Reflect.get(tokens, 'promptTokens'), 'inputTokens')
    const outputTokens = readUsageToken(Reflect.get(tokens, 'completionTokens'), 'outputTokens')
    const rawTotalTokens = Reflect.get(tokens, 'totalTokens')
    const reportedCachedInputTokens = readOptionalUsageToken(Reflect.get(tokens, 'cacheReadTokens'), 'cachedInputTokens')
    const reportedCacheCreationInputTokens = readOptionalUsageToken(
      Reflect.get(tokens, 'cacheCreationTokens'),
      'cacheCreationInputTokens'
    )
    let cachedInputTokens: number | undefined
    let cacheCreationInputTokens: number | undefined
    let inputTokens: number
    switch (transportKind) {
      case 'openai-responses':
      case 'openresponses':
      case 'openai-chat':
      case 'anthropic-messages': {
        cachedInputTokens = reportedCachedInputTokens
        cacheCreationInputTokens = reportedCacheCreationInputTokens
        const fullInput = safeTokenSum(promptTokens, cachedInputTokens ?? 0, cacheCreationInputTokens ?? 0)
        if (fullInput === null) throw invalidProviderUsage({ usageIssue: 'directional_overflow' })
        inputTokens = fullInput
        break
      }
      case 'gemini-api':
        inputTokens = promptTokens
        cachedInputTokens = reportedCachedInputTokens
        break
      case 'legacy-completions':
        inputTokens = promptTokens
        break
      default:
        throw invalidProviderUsage({ usageIssue: 'shape' })
    }

    const totalTokens =
      rawTotalTokens === undefined && transportKind === 'anthropic-messages'
        ? safeDirectionalSum(inputTokens, outputTokens)
        : readUsageToken(rawTotalTokens, 'totalTokens')
    if (totalTokens === null) throw invalidProviderUsage({ usageIssue: 'directional_overflow' })
    const usage: AgentProviderUsage = {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens })
    }
    assertAgentProviderUsage(usage)
    return usage
  } catch (error) {
    if (error instanceof AgentRepositoryError && error.code === 'PROVIDER_USAGE_INVALID') throw error
    throw invalidProviderUsage({ usageIssue: 'shape' })
  }
}

export const acceptCumulativeAgentProviderUsage = (
  previous: AgentProviderUsage | null,
  next: AgentProviderUsage
): AgentProviderUsage => {
  assertAgentProviderUsage(next)
  if (previous === null) return next
  assertAgentProviderUsage(previous)
  const priorReceipt = safeReceipt(
    previous.inputTokens,
    previous.outputTokens,
    previous.totalTokens,
    previous.cachedInputTokens,
    previous.cacheCreationInputTokens
  )
  const currentReceipt = safeReceipt(
    next.inputTokens,
    next.outputTokens,
    next.totalTokens,
    next.cachedInputTokens,
    next.cacheCreationInputTokens
  )
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (next[field] < previous[field])
      throw invalidProviderUsage({ usageIssue: 'regression', usageField: field, prior: priorReceipt, current: currentReceipt })
  }
  for (const field of ['cachedInputTokens', 'cacheCreationInputTokens'] as const) {
    const current = next[field]
    const prior = previous[field]
    if (current !== undefined && prior !== undefined && current < prior)
      throw invalidProviderUsage({ usageIssue: 'regression', usageField: field, prior: priorReceipt, current: currentReceipt })
  }
  if (
    next.cachedInputTokens !== undefined ||
    previous.cachedInputTokens === undefined
  ) {
    if (
      next.cacheCreationInputTokens !== undefined ||
      previous.cacheCreationInputTokens === undefined
    )
      return next
  }
  const cumulative = {
    ...next,
    ...(next.cachedInputTokens === undefined && previous.cachedInputTokens !== undefined
      ? { cachedInputTokens: previous.cachedInputTokens }
      : {}),
    ...(next.cacheCreationInputTokens === undefined && previous.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: previous.cacheCreationInputTokens }
      : {})
  }
  assertAgentProviderUsage(cumulative)
  return cumulative
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

