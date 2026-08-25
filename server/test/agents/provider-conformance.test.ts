import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import createKnex, { type Knex } from 'knex'
import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { AgentProviderAttemptError, type AgentProviderFactory } from '../../agents/providers/factory.ts'
import { AgentProviderConformanceRunner } from '../../agents/providers/conformance.ts'

const usage = { ai: 'test', model: 'model-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
const successfulPromptResponse = (input: Readonly<AxChatRequest>): AxChatResponse => {
  const request = [...input.chatPrompt].reverse().find(message => message.role === 'user')?.content
  const text = typeof request === 'string' ? request : ''
  const token = /^Call wiki_conformance_echo exactly once with token ([0-9a-f-]+)\. After receiving the action result, reply with exactly ACKNOWLEDGED and do not call any action again\.$/u.exec(text)?.[1]
  const content = token
    ? `<wiki-tool-call>{"name":"wiki_conformance_echo","arguments":{"token":"${token}"}}</wiki-tool-call>`
    : 'ok'
  return { results: [{ index: 0, content }], modelUsage: usage }
}
const service = (chat: (input: Readonly<AxChatRequest>) => Promise<AxChatResponse | ReadableStream<AxChatResponse>>, capabilityOverrides: Record<string, unknown> = {}) => ({
  service: {
    chat: async (input: Readonly<AxChatRequest>, options?: { abortSignal?: AbortSignal }) => {
      if (options?.abortSignal?.aborted) throw options.abortSignal.reason
      return chat(input)
    }
  },
  capabilities: { streaming: false, toolCalling: 'prompt', parallelToolCalls: false, structuredOutput: 'prompt-only', usage: 'terminal', cancellation: true, maxContextTokens: 10_000, maxOutputTokens: 1_000, ...capabilityOverrides },
  transportKind: 'openai-chat', model: 'model-test', capabilityRevision: 'cap-2', pricingRevision: 'price-1'
})

describe('provider conformance runner', () => {
  let db: Knex
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfiles', table => { table.string('id').primary(); table.string('currentVersionId'); table.dateTime('deletedAt').nullable() })
    await db.schema.createTable('agentProviderConformanceReports', table => { table.string('id').primary(); table.string('profileVersionId'); table.string('status'); table.text('checks'); table.string('errorCode').nullable(); table.integer('actorId'); table.dateTime('startedAt'); table.dateTime('completedAt') })
    await db('agentProviderProfiles').insert({ id: '00000000-0000-4000-8000-000000000001', currentVersionId: '00000000-0000-4000-8000-000000000002' })
  })
  afterEach(async () => db.destroy())

  it('marks only the current profile settings conformed and retains bounded evidence', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = { create: vi.fn(async () => service(async input => successfulPromptResponse(input))) } as unknown as AgentProviderFactory
    const runner = new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
    const report = await runner.run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({ status: 'passed', errorCode: null, checks: [{ name: 'profile-load', passed: true }, { name: 'pre-dispatch-cancellation', passed: true }, { name: 'buffered-response', passed: true }, { name: 'bounded-text-output', passed: true }, { name: 'declared-usage', passed: true }, { name: 'prompt-tool-round-trip', passed: true }] })
    expect(factory.create).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002', { requireConformed: false })
    expect(setConformed).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', true, 7)
    await expect(runner.list('00000000-0000-4000-8000-000000000001')).resolves.toEqual([report])
  })
  it('verifies a native function call and result round trip', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = {
      create: async () => service(async input => {
        const forced = typeof input.functionCall === 'object'
        if (forced) {
          const prompt = input.chatPrompt.find(message => message.role === 'user')?.content
          const token = typeof prompt === 'string' ? /token ([0-9a-f-]+)/u.exec(prompt)?.[1] : undefined
          return { results: [{ index: 0, functionCalls: [{ id: 'native-call-1', type: 'function', function: { name: 'wiki_conformance_echo', params: JSON.stringify({ token }) } }] }], modelUsage: usage }
        }
        return { results: [{ index: 0, content: 'ok' }], modelUsage: usage }
      }, { toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'tool-result' })
    } as unknown as AgentProviderFactory

    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
      .run('00000000-0000-4000-8000-000000000001', 7)

    expect(report).toMatchObject({ status: 'passed', checks: expect.arrayContaining([{ name: 'native-tool-round-trip', passed: true }]) })
  })

  it('reports when a native provider omits its final answer after the action result', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = {
      create: async () => service(async input => {
        if (!input.functions?.length) return { results: [{ index: 0, content: 'ok' }], modelUsage: usage }
        if (typeof input.functionCall === 'object') {
          const prompt = input.chatPrompt.find(message => message.role === 'user')?.content
          const token = typeof prompt === 'string' ? /token ([0-9a-f-]+)/u.exec(prompt)?.[1] : undefined
          return { results: [{ index: 0, functionCalls: [{ id: 'native-call-1', type: 'function', function: { name: 'wiki_conformance_echo', params: JSON.stringify({ token }) } }] }], modelUsage: usage }
        }
        return { results: [{ index: 0, content: '' }], modelUsage: usage }
      }, { toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'tool-result' })
    } as unknown as AgentProviderFactory

    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
      .run('00000000-0000-4000-8000-000000000001', 7)

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
    const factory = { create: async () => service(async () => { throw wrapped }) } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
      .run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({
      status: 'failed',
      errorCode: 'unsupported_value',
      message: 'Provider rejected the “temperature” setting (unsupported_value).',
      checks: expect.arrayContaining([{ name: 'provider-smoke', passed: false, detail: 'Provider rejected the “temperature” setting (unsupported_value).' }])
    })
  })

  it('rejects a profile whose transport ignores pre-dispatch cancellation', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = {
      create: async () => ({
        ...service(async () => ({ results: [{ index: 0, content: 'unexpected' }] })),
        service: { chat: async () => ({ results: [{ index: 0, content: 'unexpected' }] }) }
      })
    } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
      .run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({ status: 'failed', errorCode: 'CONFORMANCE_CANCELLATION_IGNORED' })
  })

  it('consumes declared streaming output and records the capability-specific gate', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = {
      create: async () => service(async input => {
        const response = successfulPromptResponse(input)
        return new ReadableStream<AxChatResponse>({
          start(controller) {
            const content = response.results[0]?.content ?? ''
            controller.enqueue({ results: [{ index: 0, content: content.slice(0, Math.ceil(content.length / 2)) }] })
            controller.enqueue({ results: [{ index: 0, content: content.slice(Math.ceil(content.length / 2)) }], modelUsage: usage })
            controller.close()
          }
        })
      }, { streaming: true })
    } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
      .run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({ status: 'passed', checks: expect.arrayContaining([{ name: 'stream-response', passed: true }, { name: 'prompt-tool-round-trip', passed: true }]) })
  })

  it.each([
    ['CONFORMANCE_UNEXPECTED_TOOL', { results: [{ index: 0, functionCalls: [{ id: 'call-1', type: 'function', function: { name: 'pages_get', params: '{}' } }] }] }],
    ['CONFORMANCE_OUTPUT_TOO_LARGE', { results: [{ index: 0, content: 'x'.repeat(16_001) }] }]
  ])('fails closed with bounded evidence for %s', async (expectedCode, response) => {
    const setConformed = vi.fn(async () => {})
    const factory = { create: async () => service(async () => ({ ...response, modelUsage: usage } as AxChatResponse)) } as unknown as AgentProviderFactory
    const report = await new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
      .run('00000000-0000-4000-8000-000000000001', 7)
    expect(report).toMatchObject({ status: 'failed', errorCode: expectedCode, checks: expect.arrayContaining([expect.objectContaining({ name: 'provider-smoke', passed: false })]) })
    expect(JSON.stringify(report)).not.toContain('x'.repeat(256))
  })
})
