import type { AxChatResponse } from '@ax-llm/ax'
import { describe, expect, it } from '../bun-test.mts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import type { AgentProviderTransportKind } from '../../agents/providers/registry.ts'
import {
  acceptCumulativeAgentProviderUsage,
  readAgentProviderUsage,
  type AgentProviderUsage
} from '../../agents/providers/usage.ts'

const usageFor = (transportKind: AgentProviderTransportKind, tokens: Record<string, unknown>): AgentProviderUsage | null =>
  readAgentProviderUsage(transportKind, {
    results: [],
    modelUsage: { ai: 'test', model: 'test-model', tokens }
  } as unknown as AxChatResponse)

const expectInvalidUsage = (run: () => unknown): void => {
  try {
    run()
    throw new Error('Expected invalid provider usage')
  } catch (error) {
    expect(error).toMatchObject({ code: 'PROVIDER_USAGE_INVALID' })
  }
}

describe('agent provider usage normalization', () => {
  it('reconstructs full input by trusted transport semantics and preserves independent totals', () => {
    expect(
      usageFor('openai-responses', {
        promptTokens: 7,
        completionTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
        totalTokens: 24
      })
    ).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 24,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 2
    })
    expect(
      usageFor('anthropic-messages', {
        promptTokens: 7,
        completionTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
        totalTokens: 99
      })
    ).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 99,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 2
    })
    expect(
      usageFor('gemini-api', {
        promptTokens: 12,
        completionTokens: 4,
        cacheReadTokens: 3,
        totalTokens: 16
      })
    ).toEqual({ inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 3 })
    expect(
      usageFor('legacy-completions', {
        promptTokens: 12,
        completionTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
        totalTokens: 16
      })
    ).toEqual({ inputTokens: 12, outputTokens: 4, totalTokens: 16 })
  })

  it('distinguishes unavailable cache counters from reported zero and rejects malformed or overflowing counters', () => {
    expect(usageFor('openai-chat', { promptTokens: 4, completionTokens: 2, totalTokens: 6 })).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6
    })
    expect(
      usageFor('openai-chat', {
        promptTokens: 4,
        completionTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 6
      })
    ).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 0, cacheCreationInputTokens: 0 })
    expect(
      usageFor('anthropic-messages', {
        promptTokens: 4,
        completionTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
    ).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 0, cacheCreationInputTokens: 0 })

    for (const field of ['cacheReadTokens', 'cacheCreationTokens'] as const) {
      for (const invalid of [null, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
        expectInvalidUsage(() =>
          usageFor('openai-responses', {
            promptTokens: 4,
            completionTokens: 2,
            [field]: invalid,
            totalTokens: 6
          })
        )
      }
    }
    expectInvalidUsage(() =>
      usageFor('openai-responses', {
        promptTokens: Number.MAX_SAFE_INTEGER,
        completionTokens: 0,
        cacheCreationTokens: 1,
        totalTokens: Number.MAX_SAFE_INTEGER
      })
    )
    expectInvalidUsage(() =>
      usageFor('gemini-api', { promptTokens: 4, completionTokens: 2, cacheReadTokens: 5, totalTokens: 6 })
    )
    expectInvalidUsage(() =>
      usageFor('openai-responses', { promptTokens: 4, completionTokens: 2, totalTokens: 5 })
    )
  })

  it('rejects cumulative regressions and retains only previously known omitted cache counters', () => {
    const previous: AgentProviderUsage = {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 14,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 2
    }
    const omittedCacheCounters: AgentProviderUsage = { inputTokens: 10, outputTokens: 4, totalTokens: 16 }
    expect(acceptCumulativeAgentProviderUsage(previous, omittedCacheCounters)).toEqual({
      ...omittedCacheCounters,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 2
    })
    expect(acceptCumulativeAgentProviderUsage(previous, omittedCacheCounters)).not.toBe(omittedCacheCounters)

    const unchangedCacheCounters: AgentProviderUsage = {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 16,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 2
    }
    expect(acceptCumulativeAgentProviderUsage(previous, unchangedCacheCounters)).toBe(unchangedCacheCounters)

    for (const next of [
      { ...previous, inputTokens: 9, totalTokens: 13 },
      { ...previous, outputTokens: 1, totalTokens: 13 },
      { ...previous, totalTokens: 13 },
      { ...previous, cachedInputTokens: 2 },
      { ...previous, cacheCreationInputTokens: 1 }
    ]) {
      expectInvalidUsage(() => acceptCumulativeAgentProviderUsage(previous, next))
    }
  })
})
