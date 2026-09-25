import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { AgentProviderAttemptError, type AgentProviderFactory } from '../../agents/providers/factory.ts'
import { AgentProviderConformanceRunner } from '../../agents/providers/conformance.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'

const usage = { ai: 'test', model: 'model-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
const readProbeToken = (input: Readonly<AxChatRequest>): string | undefined => {
  const request = [...input.chatPrompt].reverse().find(message => message.role === 'user')?.content
  const text = typeof request === 'string' ? request : ''
  return /^Call wiki_conformance_echo exactly once with token ([0-9a-f-]+)\. After receiving the action result, reply with exactly ACKNOWLEDGED followed by the receipt from that result\. Do not call any action again\.$/u.exec(
    text
  )?.[1]
}
const readResultReceipt = (input: Readonly<AxChatRequest>): string | undefined => {
  const functionResult = input.chatPrompt.find(message => message.role === 'function')
  if (functionResult) {
    const result = JSON.parse(functionResult.result) as { receipt?: unknown }
    return typeof result.receipt === 'string' ? result.receipt : undefined
  }
  const promptResult = input.chatPrompt.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('<wiki-tool-result>')
  )
  if (!promptResult || typeof promptResult.content !== 'string') return undefined
  const match = /<wiki-tool-result>([\s\S]*?)<\/wiki-tool-result>/u.exec(promptResult.content)
  if (!match?.[1]) return undefined
  const envelope = JSON.parse(match[1]) as { result?: { receipt?: unknown } }
  return typeof envelope.result?.receipt === 'string' ? envelope.result.receipt : undefined
}
const successfulPromptResponse = (input: Readonly<AxChatRequest>): AxChatResponse => {
  const receipt = readResultReceipt(input)
  const token = readProbeToken(input)
  let content = 'ok'
  if (receipt) content = `ACKNOWLEDGED ${receipt}`
  else if (token) content = `<wiki-tool-call>{"name":"wiki_conformance_echo","arguments":{"token":"${token}"}}</wiki-tool-call>`
  return { results: [{ index: 0, content }], modelUsage: usage }
}
const service = (
  chat: (input: Readonly<AxChatRequest>) => Promise<AxChatResponse | ReadableStream<AxChatResponse>>,
  capabilityOverrides: Record<string, unknown> = {}
) => ({
  service: {
    chat: async (input: Readonly<AxChatRequest>, options?: { abortSignal?: AbortSignal }) => {
      if (options?.abortSignal?.aborted) throw options.abortSignal.reason
      return chat(input)
    }
  },
  capabilities: {
    streaming: false,
    toolCalling: 'prompt',
    parallelToolCalls: false,
    structuredOutput: 'prompt-only',
    usage: 'terminal',
    cancellation: true,
    maxContextTokens: 10_000,
    maxOutputTokens: 1_000,
    ...capabilityOverrides
  },
  transportKind: 'openai-chat',
  model: 'model-test',
  capabilityRevision: 'cap-2',
  pricingRevision: 'price-1',
  pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
})

describe('provider conformance runner', () => {
  let db: Knex
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfiles', table => {
      table.string('id').primary()
      table.string('currentVersionId')
      table.dateTime('deletedAt').nullable()
    })
    await db.schema.createTable('agentProviderConformanceReports', table => {
      table.string('id').primary()
      table.string('profileVersionId')
      table.string('status')
      table.text('checks')
      table.string('errorCode').nullable()
      table.integer('actorId')
      table.dateTime('startedAt')
      table.dateTime('completedAt')
    })
    await db('agentProviderProfiles').insert({ id: '00000000-0000-4000-8000-000000000001', currentVersionId: '00000000-0000-4000-8000-000000000002' })
  })
  afterEach(async () => db.destroy())

  it('marks only the current profile settings conformed and retains bounded evidence', async () => {
    const setConformed = vi.fn(async () => {})
    let finalRequest: Readonly<AxChatRequest> | undefined
    const factory = {
      create: vi.fn(async () =>
        service(async input => {
          if (
            input.chatPrompt.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('<wiki-tool-result>'))
          )
            finalRequest = input
          return successfulPromptResponse(input)
        })
      )
    } as unknown as AgentProviderFactory
    const runner = new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
    const report = await runner.run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({
      status: 'passed',
      errorCode: null,
      checks: [
        { name: 'profile-load', passed: true },
        { name: 'pre-dispatch-cancellation', passed: true },
        { name: 'buffered-response', passed: true },
        { name: 'bounded-text-output', passed: true },
        { name: 'declared-usage', passed: true },
        { name: 'utility-model-fallback', passed: true },
        { name: 'prompt-tool-round-trip', passed: true }
      ]
    })
    expect(finalRequest).toBeDefined()
    expect(finalRequest?.functions).toBeUndefined()
    expect(finalRequest?.functionCall).toBeUndefined()
    const finalSystem = finalRequest?.chatPrompt.find(message => message.role === 'system')?.content
    expect(finalSystem).toContain('No actions are available')
    expect(finalSystem).not.toContain('Available action catalog')
    if (!finalRequest) throw new Error('Prompt conformance did not send its no-tools final request')
    expect(readResultReceipt(finalRequest)).toMatch(/^[0-9a-f-]{36}$/u)
    expect(factory.create).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002', { requireConformed: false })
    expect(setConformed).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', true, 7)
    expect(await runner.list('00000000-0000-4000-8000-000000000001')).toEqual([report])
  })
  it('returns no latest reports for an empty profile list and enforces the admin list bound', async () => {
    const runner = new AgentProviderConformanceRunner(db, {} as AgentProviderFactory, { setConformed: vi.fn() } as never)
    const queries: string[] = []
    db.on('query', query => queries.push(query.sql))

    expect(await runner.listLatest([])).toEqual([])
    await expect(runner.listLatest(Array.from({ length: 101 }, (_, index) => `profile-${index}`))).rejects.toMatchObject({
      code: 'CONFORMANCE_PROFILE_PROJECTION_OVERFLOW',
      status: 500
    })
    expect(queries).toEqual([])
  })

  it('projects null latest reports for profiles and profile IDs without current reports', async () => {
    const runner = new AgentProviderConformanceRunner(db, {} as AgentProviderFactory, { setConformed: vi.fn() } as never)

    expect(await runner.listLatest(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000099'])).toEqual([null, null])
  })

  it('loads the newest current-version report for multiple profiles in one report query and preserves input order', async () => {
    const secondProfileId = '00000000-0000-4000-8000-000000000010'
    const secondVersionId = '00000000-0000-4000-8000-000000000011'
    await db('agentProviderProfiles').insert({ id: secondProfileId, currentVersionId: secondVersionId })
    await db('agentProviderConformanceReports').insert([
      {
        id: '00000000-0000-4000-8000-000000000020',
        profileVersionId: '00000000-0000-4000-8000-000000000002',
        status: 'failed',
        checks: JSON.stringify([{ name: 'old', passed: false }]),
        errorCode: 'OLD_FAILURE',
        actorId: 7,
        startedAt: '2026-08-30T00:00:00.000Z',
        completedAt: '2026-08-30T00:00:01.000Z'
      },
      {
        id: '00000000-0000-4000-8000-000000000021',
        profileVersionId: '00000000-0000-4000-8000-000000000002',
        status: 'passed',
        checks: JSON.stringify([]),
        errorCode: null,
        actorId: 7,
        startedAt: '2026-08-30T00:00:01.000Z',
        completedAt: '2026-08-30T00:00:02.000Z'
      },
      {
        id: '00000000-0000-4000-8000-000000000022',
        profileVersionId: '00000000-0000-4000-8000-000000000099',
        status: 'passed',
        checks: JSON.stringify([]),
        errorCode: null,
        actorId: 7,
        startedAt: '2026-08-30T00:00:08.000Z',
        completedAt: '2026-08-30T00:00:09.000Z'
      },
      {
        id: '00000000-0000-4000-8000-000000000023',
        profileVersionId: secondVersionId,
        status: 'failed',
        checks: JSON.stringify([{ name: 'second', passed: false, detail: 'Second profile failed' }]),
        errorCode: 'SECOND_FAILURE',
        actorId: 7,
        startedAt: '2026-08-30T00:00:02.000Z',
        completedAt: '2026-08-30T00:00:03.000Z'
      }
    ])
    const reportQueries: string[] = []
    db.on('query', query => {
      if (query.sql.includes('agentProviderConformanceReports')) reportQueries.push(query.sql)
    })

    const reports = await new AgentProviderConformanceRunner(db, {} as AgentProviderFactory, { setConformed: vi.fn() } as never).listLatest([
      secondProfileId,
      '00000000-0000-4000-8000-000000000001'
    ])

    expect(reportQueries).toHaveLength(1)
    expect(reports.map(latest => latest?.id ?? null)).toEqual(['00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000021'])
    expect(reports[0]).toMatchObject({
      profileVersionId: secondVersionId,
      status: 'failed',
      errorCode: 'SECOND_FAILURE',
      message: 'Second profile failed'
    })
  })
  it('cannot apply completion for version A after an overlapping edit advances to version B', async () => {
    const versionB = '00000000-0000-4000-8000-000000000003'
    let edited = false
    const factory = {
      create: vi.fn(async () => {
        if (!edited) {
          edited = true
          await db('agentProviderProfiles').where({ id: '00000000-0000-4000-8000-000000000001' }).update({ currentVersionId: versionB })
        }
        return service(async input => successfulPromptResponse(input))
      })
    } as unknown as AgentProviderFactory
    const setConformed = vi.fn(async (profileId: string, versionId: string) => {
      const current = (await db('agentProviderProfiles').where({ id: profileId }).first('currentVersionId')) as { currentVersionId: string }
      if (current.currentVersionId !== versionId) throw new AgentRepositoryError('PROFILE_VERSION_CHANGED', 'Provider profile version changed', 409)
    })
    const runner = new AgentProviderConformanceRunner(db, factory, { setConformed } as never)

    await expect(Promise.resolve(runner.run('00000000-0000-4000-8000-000000000001', 7))).rejects.toMatchObject({ code: 'PROFILE_VERSION_CHANGED', status: 409 })
    expect(setConformed).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', true, 7)
    expect(await db('agentProviderConformanceReports').first('profileVersionId', 'status')).toEqual({
      profileVersionId: '00000000-0000-4000-8000-000000000002',
      status: 'passed'
    })
  })
  it('verifies a separately configured utility model before enabling the profile', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = {
      create: vi.fn(async (_profileVersionId: string, options?: { purpose?: 'agent' | 'utility' }) => ({
        ...service(async input => successfulPromptResponse(input)),
        model: options?.purpose === 'utility' ? 'model-test-mini' : 'model-test'
      }))
    } as unknown as AgentProviderFactory

    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)

    expect(report).toMatchObject({ status: 'passed', checks: expect.arrayContaining([{ name: 'utility-model-text-output', passed: true }]) })
    expect(factory.create).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002', { requireConformed: false, purpose: 'utility' })
  })
  it('verifies a native function call and no-tools result round trip', async () => {
    const setConformed = vi.fn(async () => {})
    let finalRequest: Readonly<AxChatRequest> | undefined
    const factory = {
      create: async () =>
        service(
          async input => {
            if (typeof input.functionCall === 'object') {
              const token = readProbeToken(input)
              return {
                results: [
                  {
                    index: 0,
                    functionCalls: [{ id: 'native-call-1', type: 'function', function: { name: 'wiki_conformance_echo', params: JSON.stringify({ token }) } }]
                  }
                ],
                modelUsage: usage
              }
            }
            const receipt = readResultReceipt(input)
            if (receipt) {
              finalRequest = input
              return { results: [{ index: 0, content: `ACKNOWLEDGED ${receipt}` }], modelUsage: usage }
            }
            return { results: [{ index: 0, content: 'ok' }], modelUsage: usage }
          },
          { toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'tool-result' }
        )
    } as unknown as AgentProviderFactory

    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)

    expect(report).toMatchObject({ status: 'passed', checks: expect.arrayContaining([{ name: 'native-tool-round-trip', passed: true }]) })
    expect(finalRequest).toBeDefined()
    expect(finalRequest?.functions).toBeUndefined()
    expect(finalRequest?.functionCall).toBeUndefined()
    if (!finalRequest) throw new Error('Native conformance did not send its no-tools final request')
    expect(readResultReceipt(finalRequest)).toMatch(/^[0-9a-f-]{36}$/u)
  })
  it('rejects malformed native action arguments before a result turn', async () => {
    const setConformed = vi.fn(async () => {})
    let requests = 0
    const factory = {
      create: async () =>
        service(
          async input => {
            requests++
            if (typeof input.functionCall === 'object') {
              return {
                results: [
                  {
                    index: 0,
                    functionCalls: [{ id: 'native-call-1', type: 'function', function: { name: 'wiki_conformance_echo', params: 'not-json' } }]
                  }
                ],
                modelUsage: usage
              }
            }
            return { results: [{ index: 0, content: 'ok' }], modelUsage: usage }
          },
          { toolCalling: 'native' }
        )
    } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({
      status: 'failed',
      errorCode: 'CONFORMANCE_TOOL_INVALID',
      message: 'Provider returned invalid conformance action JSON'
    })
    expect(requests).toBe(2)
  })

  it('replays encrypted Gemini Interactions state through a no-tools final', async () => {
    const setConformed = vi.fn(async () => {})
    let continuationObserved = false
    let finalRequest: Readonly<AxChatRequest> | undefined
    const interactionState = 'wiki.gemini.interactions.v1:[{"signature":"opaque-signature","type":"thought"}]'
    const factory = {
      create: async () => ({
        ...service(
          async input => {
            if (typeof input.functionCall === 'object') {
              const token = readProbeToken(input)
              return {
                results: [
                  {
                    index: 0,
                    functionCalls: [{ id: 'gemini-call-1', type: 'function', function: { name: 'wiki_conformance_echo', params: { token } } }],
                    thoughtBlocks: [{ data: interactionState, encrypted: true }]
                  }
                ],
                modelUsage: usage
              }
            }
            const assistant = input.chatPrompt.find(message => message.role === 'assistant')
            if (assistant?.functionCalls?.length) {
              finalRequest = input
              continuationObserved =
                assistant.thoughtBlocks?.some(block => block.data === interactionState && block.encrypted && block.signature === undefined) === true
              const receipt = readResultReceipt(input)
              return { results: [{ index: 0, content: receipt ? `ACKNOWLEDGED ${receipt}` : 'ACKNOWLEDGED' }], modelUsage: usage }
            }
            return { results: [{ index: 0, content: 'ok' }], modelUsage: usage }
          },
          { toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'native-json-schema', usage: 'stream' }
        ),
        transportKind: 'gemini-api',
        preserveThoughtBlock: (_resultId: string, block: { data: string; encrypted: boolean; signature?: string }) =>
          block.encrypted && block.data.startsWith('wiki.gemini.interactions.v1:') ? { data: block.data, encrypted: true as const } : null
      })
    } as unknown as AgentProviderFactory

    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)

    expect(report).toMatchObject({ status: 'passed', checks: expect.arrayContaining([{ name: 'native-tool-round-trip', passed: true }]) })
    expect(continuationObserved).toBe(true)
    expect(finalRequest).toBeDefined()
    expect(finalRequest?.functions).toBeUndefined()
    expect(finalRequest?.functionCall).toBeUndefined()
    const finalSystem = finalRequest?.chatPrompt.find(message => message.role === 'system')?.content
    expect(finalSystem).toContain('No actions are available')
    expect(finalSystem).not.toContain('Available action catalog')
    if (!finalRequest) throw new Error('Gemini conformance did not send its no-tools final request')
    expect(readResultReceipt(finalRequest)).toMatch(/^[0-9a-f-]{36}$/u)
  })
  it.each(['native', 'prompt'] as const)('rejects a %s final that does not use its action result', async toolCalling => {
    const setConformed = vi.fn(async () => {})
    let finalRequest: Readonly<AxChatRequest> | undefined
    const factory = {
      create: async () =>
        service(
          async input => {
            const token = readProbeToken(input)
            if (toolCalling === 'native' && typeof input.functionCall === 'object') {
              return {
                results: [
                  {
                    index: 0,
                    functionCalls: [{ id: 'call-1', type: 'function', function: { name: 'wiki_conformance_echo', params: JSON.stringify({ token }) } }]
                  }
                ],
                modelUsage: usage
              }
            }
            if (toolCalling === 'prompt' && token)
              return {
                results: [{ index: 0, content: `<wiki-tool-call>{"name":"wiki_conformance_echo","arguments":{"token":"${token}"}}</wiki-tool-call>` }],
                modelUsage: usage
              }
            if (readResultReceipt(input)) {
              finalRequest = input
              return { results: [{ index: 0, content: 'ACKNOWLEDGED' }], modelUsage: usage }
            }
            return { results: [{ index: 0, content: 'ok' }], modelUsage: usage }
          },
          {
            toolCalling,
            parallelToolCalls: toolCalling === 'native',
            structuredOutput: toolCalling === 'native' ? 'tool-result' : 'prompt-only'
          }
        )
    } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({
      status: 'failed',
      errorCode: 'CONFORMANCE_TOOL_INVALID',
      message: 'Provider did not incorporate the conformance action result in its final answer'
    })
    expect(finalRequest?.functions).toBeUndefined()
    expect(finalRequest?.functionCall).toBeUndefined()
  })

  it('reports when a native provider omits its final answer after the action result', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = {
      create: async () =>
        service(
          async input => {
            if (!input.functions?.length && input.chatPrompt.some(message => message.role === 'function'))
              return { results: [{ index: 0, content: '' }], modelUsage: usage }
            if (!input.functions?.length) return { results: [{ index: 0, content: 'ok' }], modelUsage: usage }
            if (typeof input.functionCall === 'object') {
              const token = readProbeToken(input)
              return {
                results: [
                  {
                    index: 0,
                    functionCalls: [{ id: 'native-call-1', type: 'function', function: { name: 'wiki_conformance_echo', params: JSON.stringify({ token }) } }]
                  }
                ],
                modelUsage: usage
              }
            }
            return { results: [{ index: 0, content: '' }], modelUsage: usage }
          },
          { toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'tool-result' }
        )
    } as unknown as AgentProviderFactory

    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)

    expect(report).toMatchObject({
      status: 'failed',
      errorCode: 'CONFORMANCE_EMPTY_OUTPUT',
      message: 'Provider returned no final text after the native conformance action result'
    })
  })

  it('fails closed on malformed or empty provider output', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = { create: async () => service(async () => ({ results: [], modelUsage: usage })) } as unknown as AgentProviderFactory
    const runner = new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
    const report = await runner.run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({ status: 'failed', errorCode: 'CONFORMANCE_EMPTY_OUTPUT' })
    expect(setConformed).toHaveBeenCalledWith(expect.any(String), expect.any(String), false, 7)
  })

  it('preserves actionable provider validation details from wrapped Ax errors', async () => {
    const setConformed = vi.fn(async () => {})
    const providerError = new AgentProviderAttemptError('unsupported_value', 400, null, 'temperature')
    const wrapped = Object.assign(new Error('Network Error: Provider request failed'), { originalError: providerError })
    const factory = {
      create: async () =>
        service(async () => {
          throw wrapped
        })
    } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({
      status: 'failed',
      errorCode: 'unsupported_value',
      message: 'Provider rejected the “temperature” setting (unsupported_value).',
      checks: expect.arrayContaining([{ name: 'provider-smoke', passed: false, detail: 'Provider rejected the “temperature” setting (unsupported_value).' }])
    })
  })

  it('recognizes an Ax-wrapped abort cause without dispatching the cancelled request', async () => {
    const setConformed = vi.fn(async () => {})
    let dispatched = 0
    const factory = {
      create: async () => ({
        ...service(async input => successfulPromptResponse(input)),
        service: {
          chat: async (input: Readonly<AxChatRequest>, options?: { abortSignal?: AbortSignal }) => {
            if (options?.abortSignal?.aborted) throw Object.assign(new Error('Provider request failed'), { originalError: options.abortSignal.reason })
            dispatched++
            return successfulPromptResponse(input)
          }
        }
      })
    } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({ status: 'passed', checks: expect.arrayContaining([{ name: 'pre-dispatch-cancellation', passed: true }]) })
    expect(dispatched).toBe(3)
  })

  it('rejects a profile whose transport ignores pre-dispatch cancellation', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = {
      create: async () => ({
        ...service(async () => ({ results: [{ index: 0, content: 'unexpected' }] })),
        service: { chat: async () => ({ results: [{ index: 0, content: 'unexpected' }] }) }
      })
    } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({ status: 'failed', errorCode: 'CONFORMANCE_CANCELLATION_IGNORED' })
  })
  it.each([
    ['plain error', new Error('provider request failed')],
    ['unrelated abort error', new DOMException('independent network abort', 'AbortError')],
    ['unrelated abort code', Object.assign(new Error('independent error'), { code: 'ERR_ABORTED' })]
  ])('does not accept a %s as honoring pre-dispatch cancellation', async (_name, failure) => {
    const setConformed = vi.fn(async () => {})
    let dispatched = 0
    const factory = {
      create: async () => ({
        ...service(async () => ({ results: [{ index: 0, content: 'ok' }], modelUsage: usage })),
        service: {
          chat: async (_input: Readonly<AxChatRequest>, options?: { abortSignal?: AbortSignal }) => {
            if (options?.abortSignal?.aborted) throw failure
            dispatched++
            return { results: [{ index: 0, content: 'ok' }], modelUsage: usage }
          }
        }
      })
    } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({
      status: 'failed',
      errorCode: 'CONFORMANCE_CANCELLATION_INVALID',
      message: 'Provider returned a non-cancellation error for an aborted request'
    })
    expect(dispatched).toBe(0)
  })

  it('consumes declared streaming output and records the capability-specific gate', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = {
      create: async () =>
        service(
          async input => {
            const response = successfulPromptResponse(input)
            return new ReadableStream<AxChatResponse>({
              start(controller) {
                const content = response.results[0]?.content ?? ''
                controller.enqueue({ results: [{ index: 0, content: content.slice(0, Math.ceil(content.length / 2)) }] })
                controller.enqueue({ results: [{ index: 0, content: content.slice(Math.ceil(content.length / 2)) }], modelUsage: usage })
                controller.close()
              }
            })
          },
          { streaming: true }
        )
    } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({
      status: 'passed',
      checks: expect.arrayContaining([
        { name: 'stream-response', passed: true },
        { name: 'prompt-tool-round-trip', passed: true }
      ])
    })
  })
  it.each([
    ['stream', true],
    ['terminal', false]
  ] as const)('requires declared %s usage before accepting EOF', async (usageMode, streaming) => {
    const setConformed = vi.fn(async () => {})
    const factory = {
      create: async () =>
        service(
          async () => {
            const response: AxChatResponse = { results: [{ index: 0, content: 'usable answer' }] }
            if (!streaming) return response
            return new ReadableStream<AxChatResponse>({
              start(controller) {
                controller.enqueue(response)
                controller.close()
              }
            })
          },
          { usage: usageMode, streaming }
        )
    } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({ status: 'failed', errorCode: 'CONFORMANCE_USAGE_MISSING' })
  })

  it.each([
    [
      'CONFORMANCE_UNEXPECTED_TOOL',
      { results: [{ index: 0, functionCalls: [{ id: 'call-1', type: 'function', function: { name: 'pages_get', params: '{}' } }] }] }
    ],
    ['CONFORMANCE_OUTPUT_TOO_LARGE', { results: [{ index: 0, content: 'x'.repeat(16_001) }] }]
  ])('fails closed with bounded evidence for %s', async (expectedCode, response) => {
    const setConformed = vi.fn(async () => {})
    const factory = { create: async () => service(async () => ({ ...response, modelUsage: usage }) as AxChatResponse) } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never).run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({
      status: 'failed',
      errorCode: expectedCode,
      checks: expect.arrayContaining([expect.objectContaining({ name: 'provider-smoke', passed: false })])
    })
    expect(JSON.stringify(report)).not.toContain('x'.repeat(256))
  })
})
