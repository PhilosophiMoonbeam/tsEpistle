import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import { down, up } from '../../db/migrations/2.5.149.ts'

describe('agent provider utility model migration', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.string('id').primary()
      table.string('model', 255).notNullable()
    })
    await db('agentProviderProfileVersions').insert({ id: 'profile-version-1', model: 'agent-model' })
  })

  afterEach(async () => db.destroy())

  it('adds an optional utility model without changing existing model assignments', async () => {
    await up(db)

    expect(await db.schema.hasColumn('agentProviderProfileVersions', 'utilityModel')).toBe(true)
    expect(await db('agentProviderProfileVersions').first('model', 'utilityModel')).toEqual({ model: 'agent-model', utilityModel: null })
    await db('agentProviderProfileVersions').update({ utilityModel: 'utility-model' })
    expect(await db('agentProviderProfileVersions').first('utilityModel')).toEqual({ utilityModel: 'utility-model' })
  })

  it('removes only the utility model column on rollback', async () => {
    await up(db)
    await down(db)

    expect(await db.schema.hasColumn('agentProviderProfileVersions', 'utilityModel')).toBe(false)
    expect(await db('agentProviderProfileVersions').first('model')).toEqual({ model: 'agent-model' })
  })
})
