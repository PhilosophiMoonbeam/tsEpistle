import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import createKnex, { type Knex } from 'knex'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'
import { AgentProviderConformanceRunner } from '../../agents/providers/conformance.ts'

const service = (chat: () => Promise<unknown>) => ({
  service: { chat },
  capabilities: { streaming: false, functions: false, parallelFunctions: false, structuredOutput: 'prompt-only', usage: 'terminal', cancellation: true, maxContextTokens: 10_000, maxOutputTokens: 1_000 },
  transportKind: 'openai-chat', model: 'model-test', capabilityRevision: 'cap-1', pricingRevision: 'price-1'
})

describe('provider conformance runner', () => {
  let db: Knex
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfiles', table => { table.string('id').primary(); table.string('currentVersionId') })
    await db.schema.createTable('agentProviderConformanceReports', table => { table.string('id').primary(); table.string('profileVersionId'); table.string('status'); table.text('checks'); table.string('errorCode').nullable(); table.integer('actorId'); table.dateTime('startedAt'); table.dateTime('completedAt') })
    await db('agentProviderProfiles').insert({ id: '00000000-0000-4000-8000-000000000001', currentVersionId: '00000000-0000-4000-8000-000000000002' })
  })
  afterEach(async () => db.destroy())

  it('marks only a successful exact profile version conformed and retains bounded evidence', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = { create: vi.fn(async () => service(async () => ({ results: [{ index: 0, content: 'ok' }] }))) } as unknown as AgentProviderFactory
    const runner = new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
    const report = await runner.run('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 7)
    expect(report).toMatchObject({ status: 'passed', errorCode: null, checks: [{ name: 'profile-load', passed: true }, { name: 'buffered-response', passed: true }, { name: 'bounded-text-output', passed: true }] })
    expect(factory.create).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002', { requireConformed: false })
    expect(setConformed).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', true, 7)
    await expect(runner.list('00000000-0000-4000-8000-000000000002')).resolves.toEqual([report])
  })

  it('fails closed on malformed or empty provider output', async () => {
    const setConformed = vi.fn(async () => {})
    const factory = { create: async () => service(async () => ({ results: [] })) } as unknown as AgentProviderFactory
    const runner = new AgentProviderConformanceRunner(db, factory, { setConformed } as never)
    const report = await runner.run('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 7)
    expect(report).toMatchObject({ status: 'failed', errorCode: 'CONFORMANCE_EMPTY_OUTPUT' })
    expect(setConformed).toHaveBeenCalledWith(expect.any(String), expect.any(String), false, 7)
  })
})
