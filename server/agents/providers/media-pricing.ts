import type { AgentTokenUsage } from '../../../shared/agents/contracts.ts'
import { AgentRepositoryError } from '../repository.ts'
import { agentProviderCostMicros, type AgentProviderPricing } from './factory.ts'

/** Charge unclassified output conservatively; a complete modality receipt permits exact rates. */
export const agentVideoCostMicros = (
  pricing: AgentProviderPricing & { textOutputMicrosPerMillionTokens: number },
  usage: AgentTokenUsage,
  breakdown?: { text: number; video: number }
): number => {
  const maximumOutputRate = Math.max(pricing.outputMicrosPerMillionTokens, pricing.textOutputMicrosPerMillionTokens)
  const conservative = agentProviderCostMicros(
    { ...pricing, outputMicrosPerMillionTokens: maximumOutputRate },
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens
  )
  if (!Number.isSafeInteger(pricing.textOutputMicrosPerMillionTokens) || pricing.textOutputMicrosPerMillionTokens < 1)
    throw new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Video pricing is invalid', 502)
  if (!breakdown) return conservative
  if (
    !Number.isSafeInteger(breakdown.text) ||
    !Number.isSafeInteger(breakdown.video) ||
    breakdown.text < 0 ||
    breakdown.video < 0 ||
    breakdown.text + breakdown.video !== usage.outputTokens
  )
    throw new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Video usage is invalid', 502)
  const residual = usage.totalTokens - usage.inputTokens - usage.outputTokens
  const numerator =
    BigInt(usage.inputTokens) * BigInt(pricing.inputMicrosPerMillionTokens) +
    BigInt(breakdown.text) * BigInt(pricing.textOutputMicrosPerMillionTokens) +
    BigInt(breakdown.video) * BigInt(pricing.outputMicrosPerMillionTokens) +
    BigInt(residual) * BigInt(Math.max(maximumOutputRate, pricing.inputMicrosPerMillionTokens))
  const cost = (numerator + 999_999n) / 1_000_000n
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new AgentRepositoryError('PROVIDER_USAGE_INVALID', 'Video usage cost exceeds the supported range', 502)
  return Number(cost)
}
