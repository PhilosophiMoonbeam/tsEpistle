import { describe, expect, it, vi } from '../bun-test.mts'
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
        modelUsage: { ai: 'test', model: 'model-mini', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 4580 } }
      }
    })
    const create = vi.fn(async () => ({
      service: { chat },
      model: 'model-mini',
      capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 },
      pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
    }))
    const utility = new AgentUtilityModel({ create } as unknown as AgentProviderFactory)

    expect(await utility.generateConversationTitle(request)).toEqual({
      title: 'Deployment Pipeline Failures',
      source: 'utility',
      inputTokens: 3,
      outputTokens: 309,
      totalTokens: 4580,
      costMicros: 9157
    })
    expect(create).toHaveBeenCalledWith(request.profileVersionId, { purpose: 'utility' })
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'model-mini',
        modelConfig: { maxTokens: 128 },
        chatPrompt: expect.arrayContaining([expect.objectContaining({ role: 'system' }), expect.objectContaining({ role: 'user' })])
      }),
      expect.objectContaining({ stream: false, abortSignal: expect.any(AbortSignal) })
    )
    expect(chat.mock.calls[0]?.[0]).not.toHaveProperty('functions')
    const prompt = chat.mock.calls[0]?.[0] as { chatPrompt: Array<{ role: string; content: string }> }
    expect(JSON.parse(prompt.chatPrompt.at(-1)?.content ?? '')).toEqual({ transcript: request.messages })
  })

  it('falls back to the first user message when utility inference fails', async () => {
    const create = vi.fn(async () => {
      throw new Error('provider unavailable')
    })
    const utility = new AgentUtilityModel({ create } as unknown as AgentProviderFactory)

    expect(await utility.generateConversationTitle(request)).toEqual({
      title: 'Investigate intermittent failures in the deployment pipeline',
      source: 'fallback',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costMicros: 0
    })
  })

  it('falls back to presentation text while retaining a valid complete receipt', async () => {
    const chat = vi.fn(async () => ({
      results: [{ index: 0, content: 'Untitled conversation' }],
      modelUsage: { ai: 'test', model: 'model-mini', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 4580 } }
    }))
    const create = vi.fn(async () => ({
      service: { chat },
      model: 'model-mini',
      capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 },
      pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
    }))
    const utility = new AgentUtilityModel({ create } as unknown as AgentProviderFactory)

    await expect(utility.generateConversationTitle(request)).resolves.toEqual({
      title: 'Investigate intermittent failures in the deployment pipeline',
      source: 'fallback',
      inputTokens: 3,
      outputTokens: 309,
      totalTokens: 4580,
      costMicros: 9157
    })
  })

  it('rejects missing provider usage instead of settling a dispatched title at zero', async () => {
    const chat = vi.fn(async () => ({ results: [{ index: 0, content: 'A title' }] }))
    const utility = new AgentUtilityModel({
      create: vi.fn(async () => ({
        service: { chat },
        model: 'model-mini',
        capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 },
        pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
      }))
    } as unknown as AgentProviderFactory)

    await expect(utility.generateConversationTitle(request)).rejects.toMatchObject({ code: 'PROVIDER_USAGE_INVALID' })
  })

  it('does not release an attempted reservation when the provider request fails', async () => {
    const reserve = vi.fn(async () => ({ id: 1, tokens: 100_000, costMicros: 100_000 }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const chat = vi.fn(async () => {
      throw new Error('provider request failed')
    })
    const utility = new AgentUtilityModel({
      create: vi.fn(async () => ({
        service: { chat },
        model: 'model-mini',
        capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 },
        pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
      }))
    } as unknown as AgentProviderFactory)

    await expect(
      utility.generateConversationTitle({
        ...request,
        dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      })
    ).resolves.toMatchObject({
      title: 'Investigate intermittent failures in the deployment pipeline',
      source: 'fallback',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    })
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('releases a reservation when user cancellation wins before provider invocation', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled before utility dispatch')
    const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => {
      controller.abort(reason)
      return reservation
    })
    const release = vi.fn(async () => {})
    const chat = vi.fn(async () => ({ results: [] }))
    const utility = new AgentUtilityModel({
      create: vi.fn(async () => ({
        service: { chat },
        model: 'model-mini',
        capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 },
        pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
      }))
    } as unknown as AgentProviderFactory)

    await expect(
      utility.generateConversationTitle({
        ...request,
        signal: controller.signal,
        dispatchBudget: {
          reserve,
          reconcile: vi.fn(async () => {}),
          release,
          consumeTool: vi.fn(async () => {}),
          unsettledExposure: { tokens: 0, costMicros: 0 }
        }
      })
    ).rejects.toBe(reason)
    expect(chat).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('reserves unknown attempted title exposure at the configured maximum rate', async () => {
    const reserve = vi.fn(async () => ({ id: 1, tokens: 100_000, costMicros: 100_000 }))
    const release = vi.fn(async () => {})
    const utility = new AgentUtilityModel({
      create: vi.fn(async () => ({
        service: {
          chat: vi.fn(async () => {
            throw new Error('provider request failed')
          })
        },
        model: 'model-mini',
        capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 },
        pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
      }))
    } as unknown as AgentProviderFactory)

    await expect(
      utility.generateConversationTitle({
        ...request,
        dispatchBudget: {
          reserve,
          reconcile: vi.fn(async () => {}),
          release,
          consumeTool: vi.fn(async () => {}),
          unsettledExposure: { tokens: 0, costMicros: 0 }
        }
      })
    ).resolves.toMatchObject({ source: 'fallback', totalTokens: 0 })
    const admission = reserve.mock.calls[0]?.[0] as { tokens: number; costMicros: number } | undefined
    expect(admission).toBeDefined()
    expect(admission?.costMicros).toBe((admission?.tokens ?? 0) * 2)
    expect(release).not.toHaveBeenCalled()
  })
  it('cancels a rejected stream before releasing its reader and retains attempted exposure', async () => {
    let cancelReason: unknown
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'x'.repeat(4_097) }],
          modelUsage: { ai: 'test', model: 'model-mini', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 4580 } }
        })
      },
      cancel(reason) {
        cancelReason = reason
      }
    })
    const reserve = vi.fn(async () => ({ id: 1, tokens: 100_000, costMicros: 100_000 }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const utility = new AgentUtilityModel({
      create: vi.fn(async () => ({
        service: { chat: vi.fn(async () => stream) },
        model: 'model-mini',
        capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 },
        pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
      }))
    } as unknown as AgentProviderFactory)

    await expect(
      utility.generateConversationTitle({
        ...request,
        dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      })
    ).resolves.toMatchObject({
      title: 'Investigate intermittent failures in the deployment pipeline',
      source: 'fallback',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    })
    expect(cancelReason).toBe('provider stream failed')
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('uses cumulative maxima only after a streaming response reaches EOF', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'Deployment ' }],
          modelUsage: { ai: 'test', model: 'model-mini', tokens: { promptTokens: 3, completionTokens: 100, totalTokens: 1_000 } }
        })
        controller.enqueue({
          results: [{ index: 0, content: 'Pipeline Failures' }],
          modelUsage: { ai: 'test', model: 'model-mini', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 4_580 } }
        })
        controller.close()
      }
    })
    const utility = new AgentUtilityModel({
      create: vi.fn(async () => ({
        service: { chat: vi.fn(async () => stream) },
        model: 'model-mini',
        capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 },
        pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
      }))
    } as unknown as AgentProviderFactory)

    await expect(utility.generateConversationTitle(request)).resolves.toMatchObject({
      title: 'Deployment Pipeline Failures',
      inputTokens: 3,
      outputTokens: 309,
      totalTokens: 4_580
    })
  })

  it('propagates post-attempt reconciliation failures', async () => {
    const reconcile = vi.fn(async () => {
      throw new Error('accounting unavailable')
    })
    const release = vi.fn(async () => {})
    const chat = vi.fn(async () => ({
      results: [{ index: 0, content: 'Useful title' }],
      modelUsage: { ai: 'test', model: 'model-mini', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 4580 } }
    }))
    const utility = new AgentUtilityModel({
      create: vi.fn(async () => ({
        service: { chat },
        model: 'model-mini',
        capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 },
        pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
      }))
    } as unknown as AgentProviderFactory)

    await expect(
      utility.generateConversationTitle({
        ...request,
        dispatchBudget: {
          reserve: vi.fn(async () => ({ id: 1, tokens: 100_000, costMicros: 100_000 })),
          reconcile,
          release,
          consumeTool: vi.fn(async () => {}),
          unsettledExposure: { tokens: 0, costMicros: 0 }
        }
      })
    ).rejects.toThrow('accounting unavailable')
    expect(release).not.toHaveBeenCalled()
  })

  it('returns strict bounded knowledge enrichment without exposing tools', async () => {
    const chat = vi.fn(async () => ({
      results: [
        {
          index: 0,
          content: JSON.stringify({
            type: 'Procedure',
            summary: 'Deploy through the release pipeline.',
            tags: ['deployment'],
            entities: [{ name: 'Release pipeline', type: 'System' }],
            relationships: [{ subject: 'Deployment', predicate: 'uses', object: 'Release pipeline' }],
            openQuestions: [],
            searchTerms: ['release deployment']
          })
        }
      ],
      modelUsage: { ai: 'test', model: 'model-mini', tokens: { promptTokens: 3, completionTokens: 309, totalTokens: 4580 } }
    }))
    const create = vi.fn(async () => ({
      service: { chat },
      model: 'model-mini',
      capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 }
    }))
    const utility = new AgentUtilityModel({ create } as unknown as AgentProviderFactory)

    const result = await utility.enrichKnowledge({
      profileVersionId: request.profileVersionId,
      page: { title: 'Deploy', description: '', locale: 'en', path: 'ops/deploy', contentType: 'markdown', content: '# Deploy\n' },
      missingFields: ['concept.type', 'concept.tags'],
      signal: request.signal
    })

    expect(result).toMatchObject({
      value: { type: 'Procedure', tags: ['deployment'], searchTerms: ['release deployment'] },
      model: 'model-mini',
      inputTokens: 3,
      outputTokens: 309,
      totalTokens: 4580
    })
    expect(result.inputSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(create).toHaveBeenCalledWith(request.profileVersionId, { purpose: 'utility' })
    expect(chat.mock.calls[0]?.[0]).not.toHaveProperty('functions')
  })

  it('rejects undeclared or malformed utility knowledge output instead of filling gaps', async () => {
    const chat = vi.fn(async () => ({
      results: [
        {
          index: 0,
          content: JSON.stringify({
            type: null,
            summary: null,
            tags: [],
            entities: [],
            relationships: [],
            openQuestions: [],
            searchTerms: [],
            unexpected: 'field'
          })
        }
      ]
    }))
    const utility = new AgentUtilityModel({
      create: vi.fn(async () => ({ service: { chat }, model: 'model-mini', capabilities: { maxContextTokens: 10_000, maxOutputTokens: 4_000 } }))
    } as unknown as AgentProviderFactory)

    await expect(
      Promise.resolve(
        utility.enrichKnowledge({
          profileVersionId: request.profileVersionId,
          page: { title: 'Deploy', description: '', locale: 'en', path: 'ops/deploy', contentType: 'markdown', content: '# Deploy\n' },
          missingFields: ['concept.type'],
          signal: request.signal
        })
      )
    ).rejects.toThrow()
  })

  it('clamps knowledge source and output to resolved provider capabilities', async () => {
    const chat = vi.fn(async () => ({
      results: [
        {
          index: 0,
          content: JSON.stringify({
            type: null,
            summary: null,
            tags: [],
            entities: [],
            relationships: [],
            openQuestions: [],
            searchTerms: []
          })
        }
      ],
      modelUsage: { ai: 'test', model: 'model-mini', tokens: { promptTokens: 3, completionTokens: 0, totalTokens: 3 } }
    }))
    const utility = new AgentUtilityModel({
      create: vi.fn(async () => ({ service: { chat }, model: 'model-mini', capabilities: { maxContextTokens: 2_000, maxOutputTokens: 8 } }))
    } as unknown as AgentProviderFactory)

    await utility.enrichKnowledge({
      profileVersionId: request.profileVersionId,
      page: {
        title: 'Deploy',
        description: '',
        locale: 'en',
        path: 'ops/deploy',
        contentType: 'markdown',
        content: 'Source '.repeat(20_000)
      },
      missingFields: ['concept.searchTerms'],
      signal: request.signal
    })

    const providerRequest = chat.mock.calls[0]?.[0]
    expect(providerRequest).toMatchObject({ modelConfig: { maxTokens: 8 } })
    expect(Buffer.byteLength(JSON.stringify(providerRequest), 'utf8')).toBeLessThanOrEqual(1_992)
  })
})
