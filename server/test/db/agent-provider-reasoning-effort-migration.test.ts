import createKnex from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { down, up } from '../../db/migrations/2.5.154.ts'

const config = (value: string): Record<string, unknown> => JSON.parse(value) as Record<string, unknown>

describe('agent provider reasoning effort migration', () => {
  const databases: ReturnType<typeof createKnex>[] = []
  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  it('splits legacy effort by model role, normalizes protocol values, and invalidates affected profiles', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(db)
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.string('id').primary()
      table.string('transportKind').notNullable()
      table.text('adapterConfig').notNullable()
      table.boolean('conformed').notNullable()
    })
    await db.schema.createTable('agentProviderProfiles', table => {
      table.string('id').primary()
      table.string('currentVersionId').notNullable()
      table.string('status').notNullable()
      table.boolean('conformed').notNullable()
      table.boolean('isGlobalDefault').notNullable()
      table.integer('policyVersion').notNullable()
    })
    await db.schema.createTable('agentProviderConfiguration', table => {
      table.integer('id').primary()
      table.integer('defaultGeneration').notNullable()
    })
    await db('agentProviderProfileVersions').insert([
      { id: 'openai-version', transportKind: 'openai-responses', adapterConfig: JSON.stringify({ timeoutMs: 10000, reasoningEffort: 'high' }), conformed: true },
      { id: 'openresponses-version', transportKind: 'openresponses', adapterConfig: JSON.stringify({ timeoutMs: 10000, reasoningEffort: 'minimal' }), conformed: true },
      { id: 'gemini-version', transportKind: 'gemini-api', adapterConfig: JSON.stringify({ timeoutMs: 10000, reasoningEffort: 'none' }), conformed: true },
      { id: 'untouched-version', transportKind: 'anthropic-messages', adapterConfig: JSON.stringify({ timeoutMs: 10000 }), conformed: true }
    ])
    await db('agentProviderProfiles').insert([
      { id: 'openai-profile', currentVersionId: 'openai-version', status: 'enabled', conformed: true, isGlobalDefault: true, policyVersion: 3 },
      { id: 'openresponses-profile', currentVersionId: 'openresponses-version', status: 'enabled', conformed: true, isGlobalDefault: false, policyVersion: 4 },
      { id: 'gemini-profile', currentVersionId: 'gemini-version', status: 'enabled', conformed: true, isGlobalDefault: false, policyVersion: 5 },
      { id: 'untouched-profile', currentVersionId: 'untouched-version', status: 'enabled', conformed: true, isGlobalDefault: false, policyVersion: 6 }
    ])
    await db('agentProviderConfiguration').insert({ id: 1, defaultGeneration: 9 })

    await up(db)

    const openAI = config((await db('agentProviderProfileVersions').where({ id: 'openai-version' }).first('adapterConfig') as { adapterConfig: string }).adapterConfig)
    expect(openAI).toMatchObject({ agentReasoningEffort: 'high', utilityReasoningEffort: 'high' })
    expect(openAI).not.toHaveProperty('reasoningEffort')
    const openResponses = config((await db('agentProviderProfileVersions').where({ id: 'openresponses-version' }).first('adapterConfig') as { adapterConfig: string }).adapterConfig)
    expect(openResponses).toMatchObject({ agentReasoningEffort: 'low', utilityReasoningEffort: 'low' })
    const gemini = config((await db('agentProviderProfileVersions').where({ id: 'gemini-version' }).first('adapterConfig') as { adapterConfig: string }).adapterConfig)
    expect(gemini).toMatchObject({ agentReasoningEffort: 'minimal', utilityReasoningEffort: 'minimal' })
    expect(await db('agentProviderProfiles').where({ id: 'openai-profile' }).first()).toMatchObject({ status: 'disabled', conformed: 0, isGlobalDefault: 0, policyVersion: 4 })
    expect(await db('agentProviderProfiles').where({ id: 'untouched-profile' }).first()).toMatchObject({ status: 'enabled', conformed: 1, policyVersion: 6 })
    expect(await db('agentProviderConfiguration').where({ id: 1 }).first()).toMatchObject({ defaultGeneration: 10 })

    await down(db)

    const rolledBack = config((await db('agentProviderProfileVersions').where({ id: 'openai-version' }).first('adapterConfig') as { adapterConfig: string }).adapterConfig)
    expect(rolledBack).toMatchObject({ reasoningEffort: 'high' })
    expect(rolledBack).not.toHaveProperty('agentReasoningEffort')
    expect(rolledBack).not.toHaveProperty('utilityReasoningEffort')
  })
})
