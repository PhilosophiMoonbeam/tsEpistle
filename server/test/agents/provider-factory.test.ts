import { afterEach, describe, expect, it } from 'vitest'
import createKnex, { type Knex } from 'knex'
import type { LookupAddress } from 'node:dns'
import { AgentProviderAttemptError, AgentProviderFactory, createGuardedProviderFetch } from '../../agents/providers/factory.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'

const publicResolver = async (): Promise<LookupAddress[]> => [{ address: '93.184.216.34', family: 4 }]
const privateResolver = async (): Promise<LookupAddress[]> => [{ address: '127.0.0.1', family: 4 }]

describe('guarded provider fetch', () => {
  it('allows only the configured HTTPS endpoint and rejects private DNS results', async () => {
    let called = 0
    const implementation = async (): Promise<Response> => {
      called++
      return Response.json({ ok: true })
    }
    const guarded = createGuardedProviderFetch('https://provider.example.test/v1', '/responses', {}, implementation as typeof fetch, publicResolver as never)
    await expect(guarded('https://other.example.test/v1/responses')).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    await expect(guarded('https://provider.example.test/v1/chat/completions')).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    const privateGuarded = createGuardedProviderFetch('https://provider.example.test/v1', '/responses', {}, implementation as typeof fetch, privateResolver as never)
    await expect(privateGuarded('https://provider.example.test/v1/responses')).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
    expect(called).toBe(0)
  })

  it('blocks redirects and exposes only bounded retry metadata for provider failures', async () => {
    const redirect = createGuardedProviderFetch('https://provider.example.test/v1', '/responses', {}, (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })) as typeof fetch, publicResolver as never)
    await expect(redirect('https://provider.example.test/v1/responses')).rejects.toMatchObject({ code: 'PROVIDER_REDIRECT_DENIED', status: 302 })
    const failed = createGuardedProviderFetch('https://provider.example.test/v1', '/responses', {}, (async () => Response.json({ error: { code: 'rate_limit', message: 'secret provider detail' } }, { status: 429, headers: { 'retry-after': '2' } })) as typeof fetch, publicResolver as never)
    const error = await failed('https://provider.example.test/v1/responses').catch(error => error) as AgentProviderAttemptError
    expect(error).toMatchObject({ code: 'rate_limit', status: 429, retryAfterMilliseconds: 2_000, retryable: true, message: 'Provider request failed' })
    expect(JSON.stringify(error)).not.toContain('secret provider detail')
  })
})

describe('Ax provider factory', () => {
  let db: Knex | undefined
  afterEach(async () => db?.destroy())

  it('pins an OpenAI Responses version and forces storage-off encrypted reasoning requests', async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.string('transportKind').notNullable()
      table.string('model').notNullable()
      table.string('baseUrl').notNullable()
      table.string('authMode').notNullable()
      table.string('secretReference').nullable()
      table.text('adapterConfig').notNullable()
      table.text('capabilities').notNullable()
      table.string('capabilityRevision').notNullable()
      table.string('pricingRevision').notNullable()
      table.boolean('conformed').notNullable()
    })
    await db('agentProviderProfileVersions').insert({
      id: '00000000-0000-4000-8000-000000000001',
      transportKind: 'openai-responses',
      model: 'gpt-test',
      baseUrl: 'https://provider.example.test/v1',
      authMode: 'bearer',
      secretReference: 'env:TEST_PROVIDER_KEY',
      adapterConfig: JSON.stringify({ timeoutMs: 10_000, maxRetries: 0, additionalHeaders: { 'x-tenant': 'wiki' } }),
      capabilities: JSON.stringify({ streaming: true, functions: true, parallelFunctions: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 }),
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1',
      conformed: true
    })
    let request: { url: URL; init?: RequestInit } | undefined
    const implementation = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      request = { url: new URL(typeof input === 'string' || input instanceof URL ? input : input.url), init }
      return Response.json({
        id: 'resp_1', object: 'response', created_at: 1, status: 'completed', error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model: 'gpt-test', parallel_tool_calls: true, previous_response_id: null,
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
        usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
      })
    }
    const factory = new AgentProviderFactory(db, { get: reference => reference === 'env:TEST_PROVIDER_KEY' ? 'test-key' : null }, implementation as typeof fetch, publicResolver as never)
    const provider = await factory.create('00000000-0000-4000-8000-000000000001')
    const result = await provider.service.chat({ chatPrompt: [{ role: 'user', content: 'hello' }], model: 'gpt-test' }, { stream: false })
    expect(result).not.toBeInstanceOf(ReadableStream)
    expect(request?.url.href).toBe('https://provider.example.test/v1/responses')
    expect(new Headers(request?.init?.headers).get('x-tenant')).toBe('wiki')
    expect(new Headers(request?.init?.headers).get('authorization')).toBe('Bearer test-key')
    expect(request?.init).toMatchObject({ redirect: 'manual', credentials: 'omit' })
    const payload = JSON.parse(String(request?.init?.body)) as Record<string, unknown>
    expect(payload).toMatchObject({ model: 'gpt-test', store: false, previous_response_id: null })
    expect(payload.include).toContain('reasoning.encrypted_content')
  })

  it('fails closed for missing and unsupported immutable profile versions', async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary(); table.string('transportKind'); table.string('model'); table.string('baseUrl'); table.string('authMode'); table.string('secretReference'); table.text('adapterConfig'); table.text('capabilities'); table.string('capabilityRevision'); table.string('pricingRevision'); table.boolean('conformed')
    })
    const factory = new AgentProviderFactory(db, { get: () => null })
    await expect(factory.create('00000000-0000-4000-8000-000000000099')).rejects.toBeInstanceOf(AgentRepositoryError)
  })
})
