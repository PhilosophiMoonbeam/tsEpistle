import type { LookupAddress } from 'node:dns'
import type { AxChatRequest, AxChatResponse, AxFunctionJSONSchema } from '@ax-llm/ax'
import createKnex, { type Knex } from 'knex'
import { AgentProviderFactory, decodeAgentProviderContinuation, encodeAgentProviderContinuation } from '../../agents/providers/factory.ts'
import { readAgentProviderUsage } from '../../agents/providers/usage.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

const id = '00000000-0000-4000-8000-000000000049'
const model = 'gemini-3.7-flash'
const publicResolver = async (): Promise<LookupAddress[]> => [{ address: '93.184.216.34', family: 4 }]
const usageMetadata = { promptTokenCount: 10, cachedContentTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 15 }
const reply = (parts: readonly Record<string, unknown>[] = [{ text: 'Answer.' }], finishReason = 'STOP') => ({
  responseId: 'native-response',
  modelVersion: model,
  candidates: [{ index: 0, content: { role: 'model', parts }, finishReason }],
  usageMetadata
})
const buffered = async (value: Promise<AxChatResponse | ReadableStream<AxChatResponse>>): Promise<AxChatResponse> => {
  const response = await value
  if (response instanceof ReadableStream) throw new Error('Expected a buffered native response')
  return response
}
const consume = async (value: Promise<AxChatResponse | ReadableStream<AxChatResponse>>): Promise<AxChatResponse[]> => {
  const response = await value
  return response instanceof ReadableStream ? Array.fromAsync(response) : [response]
}

describe('Ax native Gemini application transport', () => {
  let db: Knex
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.string('transportKind')
      table.string('model')
      table.string('utilityModel').nullable()
      table.string('baseUrl')
      table.string('authMode')
      table.string('secretReference')
      table.text('adapterConfig')
      table.text('capabilities')
      table.string('capabilityRevision')
      table.string('pricingRevision')
      table.boolean('conformed')
    })
    await db('agentProviderProfileVersions').insert({
      id,
      transportKind: 'gemini-api',
      model,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      authMode: 'google-api-key',
      secretReference: 'managed:00000000-0000-4000-8000-000000000001',
      adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {}, agentReasoningEffort: 'medium', temperature: 0.5 }),
      capabilities: JSON.stringify({
        streaming: true,
        toolCalling: 'native',
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema',
        usage: 'stream',
        cancellation: true,
        maxContextTokens: 100_000,
        maxOutputTokens: 4_000
      }),
      capabilityRevision: 'wiki-protocol-capabilities-v4:gemini-api',
      pricingRevision: 'price-v1|1000000|2000000',
      conformed: true
    })
  })
  afterEach(async () => db.destroy())
  const provider = (fetchImplementation: typeof fetch) =>
    new AgentProviderFactory(db, { get: () => 'credential-fixture' }, fetchImplementation, publicResolver as never).create(id)

  it('preserves union action schemas, output caps, thinking and exact multi-signature action continuation without native Search', async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const nativeParts = [
      { text: 'Inspect the two sources.', thought: true, thought_signature: 'signed-hidden-thought' },
      { text: 'Read both sources.', thoughtSignature: 'signed-visible-part' },
      { functionCall: { id: 'call-a', name: 'wiki_get_page', args: { input: 42 } }, thoughtSignature: 'signed-call-a' },
      { functionCall: { id: 'call-b', name: 'wiki_get_page', args: { input: 'guide' } }, thoughtSignature: 'signed-call-b' }
    ]
    const service = await provider((async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      return Response.json(reply(requests.length === 1 ? nativeParts : [{ text: 'Both sources read.' }]))
    }) as typeof fetch)
    const inputSchema = {
      type: ['number', 'string'],
      description: 'Page identifier or title',
      anyOf: [{ type: 'number' }, { type: 'string' }]
    }
    const parameters: AxFunctionJSONSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { input: inputSchema },
      required: ['input']
    }
    const first = await buffered(
      service.service.chat(
        {
          chatPrompt: [
            { role: 'system', content: 'Read Wiki sources.' },
            { role: 'user', content: 'Read both.' }
          ],
          modelConfig: { maxTokens: 20_000 },
          functions: [{ name: 'wiki_get_page', description: 'Read a page', parameters }],
          functionCall: { type: 'function', function: { name: 'wiki_get_page' } }
        },
        { stream: false }
      )
    )
    expect(first.results[0]?.functionCalls?.map(call => call.id)).toEqual(['call-a', 'call-b'])
    expect(first.results[0]?.content).toBe('Read both sources.')
    expect(requests[0]?.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`)
    expect(requests[0]?.headers.get('x-goog-api-key')).toBe('credential-fixture')
    expect(requests[0]?.headers.has('authorization')).toBe(false)
    expect(requests[0]?.body).toMatchObject({
      generationConfig: { maxOutputTokens: 4_000, temperature: 0.5, thinkingConfig: { thinkingLevel: 'medium' } },
      tools: [{ function_declarations: [{ name: 'wiki_get_page', parametersJsonSchema: parameters }] }],
      toolConfig: { function_calling_config: { mode: 'ANY', allowed_function_names: ['wiki_get_page'] } }
    })
    const calls = first.results[0]!.functionCalls!
    const block = first.results[0]!.thoughtBlocks![0]!
    const envelope = encodeAgentProviderContinuation(service.continuationDialect, [service.preserveThoughtBlock('', block)!])!
    const restored = decodeAgentProviderContinuation(envelope, service.continuationDialect)!
    await buffered(
      service.service.chat(
        {
          chatPrompt: [
            { role: 'user', content: 'Read both.' },
            { role: 'assistant', content: first.results[0]!.content, functionCalls: calls, thoughtBlocks: [...restored.thoughtBlocks] },
            ...calls.map(call => ({ role: 'function' as const, functionId: call.id, result: '{"ok":true}' }))
          ]
        },
        { stream: false }
      )
    )
    expect(requests[1]?.body).not.toHaveProperty('tools')
    expect(requests[1]?.body).not.toHaveProperty('toolConfig')
    expect(requests[1]?.body).not.toHaveProperty('previous_interaction_id')
    expect(requests[1]?.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Read both.' }] },
      { role: 'model', parts: nativeParts },
      { role: 'user', parts: calls.map(call => ({ functionResponse: { id: call.id, name: 'wiki_get_page', response: { result: '{"ok":true}' } } })) }
    ])
    expect(readAgentProviderUsage('gemini-api', first)).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 15, cachedInputTokens: 4 })
  })

  it('replays stored Interactions answers canonically and retains native inline attachments on a configured endpoint', async () => {
    await db('agentProviderProfileVersions').where({ id }).update({ baseUrl: 'https://gemini.example.test/custom/v1beta' })
    let sent: { url: string; body: Record<string, unknown> } | undefined
    const service = await provider((async (input, init) => {
      sent = { url: String(input), body: JSON.parse(String(init?.body)) }
      return Response.json(reply())
    }) as typeof fetch)
    const retired = {
      schemaVersion: 1,
      continuationDialect: 'gemini-interactions-v1',
      thoughtBlocks: [{ data: 'wiki.gemini.interactions.v1:historical-opaque-state', encrypted: true }]
    }
    expect(decodeAgentProviderContinuation(retired, service.continuationDialect)).toBeUndefined()
    const history: AxChatRequest['chatPrompt'] = [
      { role: 'assistant', content: 'Saved answer with [source](https://example.com).' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Explain this.' },
          { type: 'image', image: 'AQID', mimeType: 'image/png' },
          { type: 'file', data: 'JVBERi0=', mimeType: 'application/pdf', filename: 'source.pdf' }
        ]
      }
    ]
    await buffered(service.service.chat({ chatPrompt: history, modelConfig: { maxTokens: 321 } }, { stream: false }))
    expect(sent?.url).toBe(`https://gemini.example.test/custom/v1beta/models/${model}:generateContent`)
    expect(sent?.body).toMatchObject({
      generationConfig: { maxOutputTokens: 321 },
      contents: [
        { role: 'model', parts: [{ text: 'Saved answer with [source](https://example.com).' }] },
        {
          role: 'user',
          parts: [
            { text: 'Explain this.' },
            { inlineData: { mimeType: 'image/png', data: 'AQID' } },
            { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } }
          ]
        }
      ]
    })
  })

  it('uses the utility model and its separate configured thinking budget without exceeding the request ceiling', async () => {
    await db('agentProviderProfileVersions')
      .where({ id })
      .update({
        utilityModel: 'gemini-2.5-pro',
        adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {}, agentReasoningEffort: 'low', utilityReasoningEffort: 'high' })
      })
    let sent: { url: string; body: Record<string, unknown> } | undefined
    const factory = new AgentProviderFactory(
      db,
      { get: () => 'credential-fixture' },
      (async (input, init) => {
        sent = { url: String(input), body: JSON.parse(String(init?.body)) }
        return Response.json(reply())
      }) as typeof fetch,
      publicResolver as never
    )
    const service = await factory.create(id, { purpose: 'utility' })
    await buffered(service.service.chat({ chatPrompt: [{ role: 'user', content: 'Summarize.' }], modelConfig: { maxTokens: 123 } }, { stream: false }))
    expect(sent).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
      body: { generationConfig: { maxOutputTokens: 123, thinkingConfig: { thinkingBudget: 10_000 } } }
    })
  })

  it('omits unconfigured thinking and caller cache defaults while binding the profile model', async () => {
    await db('agentProviderProfileVersions')
      .where({ id })
      .update({ adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {} }) })
    let sent: { url: string; body: Record<string, unknown> } | undefined
    const service = await provider((async (input, init) => {
      sent = { url: String(input), body: JSON.parse(String(init?.body)) }
      return Response.json(reply())
    }) as typeof fetch)
    await buffered(
      service.service.chat(
        { model: { untrustedAlias: 'gemini-2.5-pro' }, chatPrompt: [{ role: 'user', content: 'Hello.' }], modelConfig: { maxTokens: 123 } },
        { stream: false, thinkingTokenBudget: 'highest', contextCache: { ttlSeconds: 60 } }
      )
    )
    expect(sent?.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`)
    expect(sent?.body).toHaveProperty('generationConfig.maxOutputTokens', 123)
    expect(sent?.body).not.toHaveProperty('generationConfig.thinkingConfig')
    expect(sent?.body).not.toHaveProperty('cachedContent')
  })

  it('does not dispatch an already aborted request', async () => {
    let calls = 0
    const service = await provider((async () => {
      calls++
      return Response.json(reply())
    }) as typeof fetch)
    const controller = new AbortController()
    controller.abort(new Error('aborted before dispatch'))
    await expect(
      service.service.chat({ chatPrompt: [{ role: 'user', content: 'Hello.' }] }, { stream: false, abortSignal: controller.signal })
    ).rejects.toThrow()
    expect(calls).toBe(0)
  })

  it('streams native content through a genuine EOF with full cached input counted once', async () => {
    let url = ''
    const frames = [
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello ' }] } }] },
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'world.' }] }, finishReason: 'STOP' }], usageMetadata }
    ]
    const service = await provider((async input => {
      url = String(input)
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch)
    const chunks = await consume(service.service.chat({ chatPrompt: [{ role: 'user', content: 'Hello.' }] }, { stream: true }))
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`)
    expect(
      chunks
        .flatMap(chunk => chunk.results)
        .map(result => result.content ?? '')
        .join('')
    ).toBe('Hello world.')
    expect(readAgentProviderUsage('gemini-api', chunks.at(-1)!)).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 15, cachedInputTokens: 4 })
  })

  it.each(['missing_finish', 'missing_usage', 'partial_json', 'malformed_json', 'invalid_usage', 'trailing_content'] as const)(
    'fails closed on %s instead of accepting an incomplete stream',
    async scenario => {
      const terminal = reply() as Record<string, unknown>
      if (scenario === 'missing_finish') terminal.candidates = [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }]
      if (scenario === 'missing_usage') delete terminal.usageMetadata
      if (scenario === 'invalid_usage') terminal.usageMetadata = { ...usageMetadata, cachedContentTokenCount: 11 }
      let body = `data: ${JSON.stringify(terminal)}\n\n`
      if (scenario === 'partial_json') body += 'data: {"candidates":'
      if (scenario === 'malformed_json') body = 'data: {bad json}\n\n'
      if (scenario === 'trailing_content') body += `data: ${JSON.stringify(reply([{ text: 'extra' }]))}\n\n`
      const service = await provider((async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch)
      await expect(consume(service.service.chat({ chatPrompt: [{ role: 'user', content: 'Hello.' }] }, { stream: true }))).rejects.toThrow()
    }
  )

  it.each(['abort', 'cancel'] as const)('propagates %s to the pending provider body without retry or leaked reads', async mode => {
    const controller = new AbortController()
    let signal: AbortSignal | null | undefined
    let cancelled = 0
    let dispatched = 0
    const service = await provider((async (_input, init) => {
      dispatched++
      signal = init?.signal
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            start(stream) {
              stream.enqueue(new TextEncoder().encode('data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"first"}]}}]}\n\n'))
            },
            cancel() {
              cancelled++
            }
          },
          { highWaterMark: 0 }
        ),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }) as typeof fetch)
    const response = await service.service.chat({ chatPrompt: [{ role: 'user', content: 'Hello.' }] }, { stream: true, abortSignal: controller.signal })
    if (!(response instanceof ReadableStream)) throw new Error('Expected native stream')
    const reader = response.getReader()
    expect((await reader.read()).value?.results[0]?.content).toBe('first')
    if (mode === 'abort') {
      const pending = reader.read()
      controller.abort(new Error('cancelled by caller'))
      await expect(pending).rejects.toThrow()
    } else await reader.cancel('cancelled by consumer')
    expect(signal?.aborted).toBe(true)
    expect(dispatched).toBe(1)
    expect(cancelled).toBe(1)
    reader.releaseLock()
  })
})
