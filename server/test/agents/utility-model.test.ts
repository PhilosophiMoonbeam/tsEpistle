import { describe, expect, it, vi } from 'vitest'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'
import { AgentUtilityModel, conversationTitleFallback, normalizeConversationTitle } from '../../agents/providers/utility.ts'

const request = {
  profileVersionId: '00000000-0000-4000-8000-000000000001',
  messages: [
    { role: 'user' as const, content: 'Investigate intermittent failures in the deployment pipeline' },
    { role: 'assistant' as const, content: 'I found a stale runner configuration.' },
    { role: 'user' as const, content: 'Focus on rollover failures after deployments.' },
    { role: 'assistant' as const, content: 'The rollover leaves runners attached to the previous release.' }
  ],
  signal: new AbortController().signal
}

describe('agent utility model', () => {
  it('normalizes bounded model titles and rejects generic placeholders', () => {
    const fallback = conversationTitleFallback('## Diagnose production cache misses\nMore detail')
    expect(fallback).toBe('Diagnose production cache misses')
    expect(normalizeConversationTitle('Title: “Production Cache Investigation.”', fallback)).toBe('Production Cache Investigation')
    expect(normalizeConversationTitle('Untitled conversation', fallback)).toBe(fallback)
    expect(conversationTitleFallback('A '.repeat(80))).toHaveLength(71)
  })

  it('uses the provider utility role without tools and reports its token usage', async () => {
    const chat = vi.fn(async (...args: [unknown, unknown]) => {
      void args
      return {
        results: [{ index: 0, content: '“Deployment Pipeline Failures”' }],
        modelUsage: { ai: 'test', model: 'model-mini', tokens: { promptTokens: 19, completionTokens: 4, totalTokens: 23 } }
      }
    })
    const create = vi.fn(async () => ({ service: { chat }, model: 'model-mini' }))
    const utility = new AgentUtilityModel({ create } as unknown as AgentProviderFactory)

    await expect(utility.generateConversationTitle(request)).resolves.toEqual({
      title: 'Deployment Pipeline Failures',
      source: 'utility',
      inputTokens: 19,
      outputTokens: 4
    })
    expect(create).toHaveBeenCalledWith(request.profileVersionId, { purpose: 'utility' })
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      model: 'model-mini',
      modelConfig: { maxTokens: 128 },
      chatPrompt: expect.arrayContaining([expect.objectContaining({ role: 'system' }), expect.objectContaining({ role: 'user' })])
    }), expect.objectContaining({ stream: false, abortSignal: expect.any(AbortSignal) }))
    expect(chat.mock.calls[0]?.[0]).not.toHaveProperty('functions')
    const prompt = chat.mock.calls[0]?.[0] as { chatPrompt: Array<{ role: string, content: string }> }
    expect(JSON.parse(prompt.chatPrompt.at(-1)?.content ?? '')).toEqual({ transcript: request.messages })
  })

  it('falls back to the first user message when utility inference fails', async () => {
    const create = vi.fn(async () => { throw new Error('provider unavailable') })
    const utility = new AgentUtilityModel({ create } as unknown as AgentProviderFactory)

    await expect(utility.generateConversationTitle(request)).resolves.toEqual({
      title: 'Investigate intermittent failures in the deployment pipeline',
      source: 'fallback',
      inputTokens: 0,
      outputTokens: 0
    })
  })

  it('returns strict bounded knowledge enrichment without exposing tools', async () => {
    const chat = vi.fn(async () => ({
      results: [{
        index: 0,
        content: JSON.stringify({
          type: 'Procedure',
          summary: 'Deploy through the release pipeline.',
          tags: ['deployment'],
          entities: [{ name: 'Release pipeline', type: 'System' }],
          relationships: [{ subject: 'Deployment', predicate: 'uses', object: 'Release pipeline' }],
          openQuestions: []
        })
      }],
      modelUsage: { ai: 'test', model: 'model-mini', tokens: { promptTokens: 25, completionTokens: 12, totalTokens: 37 } }
    }))
    const create = vi.fn(async () => ({ service: { chat }, model: 'model-mini' }))
    const utility = new AgentUtilityModel({ create } as unknown as AgentProviderFactory)

    const result = await utility.enrichKnowledge({
      profileVersionId: request.profileVersionId,
      page: { title: 'Deploy', description: '', locale: 'en', path: 'ops/deploy', contentType: 'markdown', content: '# Deploy\n' },
      missingFields: ['concept.type', 'concept.tags'],
      signal: request.signal
    })

    expect(result).toMatchObject({
      value: { type: 'Procedure', tags: ['deployment'] },
      model: 'model-mini',
      inputTokens: 25,
      outputTokens: 12
    })
    expect(result.inputSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(create).toHaveBeenCalledWith(request.profileVersionId, { purpose: 'utility' })
    expect(chat.mock.calls[0]?.[0]).not.toHaveProperty('functions')
  })

  it('rejects nonconforming utility knowledge output instead of filling gaps', async () => {
    const chat = vi.fn(async () => ({ results: [{ index: 0, content: '```json\n{}\n```' }] }))
    const utility = new AgentUtilityModel({
      create: vi.fn(async () => ({ service: { chat }, model: 'model-mini' }))
    } as unknown as AgentProviderFactory)

    await expect(utility.enrichKnowledge({
      profileVersionId: request.profileVersionId,
      page: { title: 'Deploy', description: '', locale: 'en', path: 'ops/deploy', contentType: 'markdown', content: '# Deploy\n' },
      missingFields: ['concept.type'],
      signal: request.signal
    })).rejects.toThrow()
  })
})
