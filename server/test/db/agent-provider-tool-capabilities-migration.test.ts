import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

import { down, up } from '../../db/migrations/2.5.148.ts'

describe('agent provider tool capability migration', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfiles', table => {
      table.uuid('id').primary()
      table.string('status').notNullable()
      table.boolean('conformed').notNullable()
    })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.text('capabilities').notNullable()
      table.string('capabilityRevision').notNullable()
      table.boolean('conformed').notNullable()
    })
    await db('agentProviderProfiles').insert({ id: '00000000-0000-4000-8000-000000000001', status: 'enabled', conformed: true })
    await db('agentProviderProfileVersions').insert([
      {
        id: '00000000-0000-4000-8000-000000000011',
        capabilities: JSON.stringify({ streaming: true, functions: true, parallelFunctions: true }),
        capabilityRevision: 'wiki-protocol-capabilities-v1:openai-responses',
        conformed: true
      },
      {
        id: '00000000-0000-4000-8000-000000000012',
        capabilities: JSON.stringify({ streaming: false, functions: false, parallelFunctions: false }),
        capabilityRevision: 'wiki-protocol-capabilities-v1:legacy-completions',
        conformed: true
      }
    ])
  })

  afterEach(async () => db.destroy())

  it('maps native and prompt modes and forces live reconformance', async () => {
    await up(db)

    const rows = await db('agentProviderProfileVersions').orderBy('id').select('capabilities', 'capabilityRevision', 'conformed') as Array<{ capabilities: string; capabilityRevision: string; conformed: number }>
    expect(rows.map(row => ({ ...row, capabilities: JSON.parse(row.capabilities) }))).toEqual([
      { capabilities: { streaming: true, toolCalling: 'native', parallelToolCalls: true }, capabilityRevision: 'wiki-protocol-capabilities-v2:openai-responses', conformed: 0 },
      { capabilities: { streaming: false, toolCalling: 'prompt', parallelToolCalls: false }, capabilityRevision: 'wiki-protocol-capabilities-v2:legacy-completions', conformed: 0 }
    ])
    expect(await db('agentProviderProfiles').first('status', 'conformed')).toMatchObject({ status: 'disabled', conformed: 0 })

    await down(db)
    const restored = await db('agentProviderProfileVersions').orderBy('id').select('capabilities', 'capabilityRevision') as Array<{ capabilities: string; capabilityRevision: string }>
    expect(restored.map(row => ({ ...row, capabilities: JSON.parse(row.capabilities) }))).toEqual([
      { capabilities: { streaming: true, functions: true, parallelFunctions: true }, capabilityRevision: 'wiki-protocol-capabilities-v1:openai-responses' },
      { capabilities: { streaming: false, functions: false, parallelFunctions: false }, capabilityRevision: 'wiki-protocol-capabilities-v1:legacy-completions' }
    ])
  })
})
