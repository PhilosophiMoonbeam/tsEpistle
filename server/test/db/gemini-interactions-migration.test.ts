import createKnex from 'knex'
import { afterEach, describe, expect, it } from 'vitest'

import { down, up } from '../../db/migrations/2.5.153.ts'

describe('Gemini Interactions capability migration', () => {
  const databases: ReturnType<typeof createKnex>[] = []
  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  it('invalidates only Gemini profiles and removes an obsolete Gemini default', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(db)
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.string('id').primary()
      table.string('transportKind').notNullable()
      table.string('capabilityRevision').notNullable()
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
      { id: 'gemini-version', transportKind: 'gemini-api', capabilityRevision: 'wiki-protocol-capabilities-v2:gemini-api', conformed: true },
      { id: 'openai-version', transportKind: 'openai-responses', capabilityRevision: 'wiki-protocol-capabilities-v2:openai-responses', conformed: true }
    ])
    await db('agentProviderProfiles').insert([
      { id: 'gemini-profile', currentVersionId: 'gemini-version', status: 'enabled', conformed: true, isGlobalDefault: true, policyVersion: 4 },
      { id: 'openai-profile', currentVersionId: 'openai-version', status: 'enabled', conformed: true, isGlobalDefault: false, policyVersion: 2 }
    ])
    await db('agentProviderConfiguration').insert({ id: 1, defaultGeneration: 7 })

    await up(db)

    expect(await db('agentProviderProfileVersions').where({ id: 'gemini-version' }).first()).toMatchObject({ capabilityRevision: 'wiki-protocol-capabilities-v3:gemini-api', conformed: 0 })
    expect(await db('agentProviderProfiles').where({ id: 'gemini-profile' }).first()).toMatchObject({ status: 'disabled', conformed: 0, isGlobalDefault: 0, policyVersion: 5 })
    expect(await db('agentProviderConfiguration').where({ id: 1 }).first()).toMatchObject({ defaultGeneration: 8 })
    expect(await db('agentProviderProfileVersions').where({ id: 'openai-version' }).first()).toMatchObject({ capabilityRevision: 'wiki-protocol-capabilities-v2:openai-responses', conformed: 1 })
    expect(await db('agentProviderProfiles').where({ id: 'openai-profile' }).first()).toMatchObject({ status: 'enabled', conformed: 1, policyVersion: 2 })

    await down(db)
    expect(await db('agentProviderProfileVersions').where({ id: 'gemini-version' }).first()).toMatchObject({ capabilityRevision: 'wiki-protocol-capabilities-v2:gemini-api', conformed: 0 })
  })
})
