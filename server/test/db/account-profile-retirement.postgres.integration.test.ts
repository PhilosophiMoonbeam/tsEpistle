import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

import { down, up } from '../../db/migrations/tsepistle-000061-retire-profile-field.ts'

const connection = getPostgresTestConnection('_profile_retire_test', import.meta.path)
const suite = connection ? describe : describe.skip

suite('PostgreSQL account profile retirement', () => {
  let db: Knex

  beforeAll(async () => {
    if (!connection) throw new Error('An isolated PostgreSQL assignment is required.')
    db = knexModule({ client: 'pg', connection })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.string('location').notNullable()
      table.string('jobTitle').notNullable()
      table.string('pronouns').notNullable().defaultTo('')
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('authentication', table => {
      table.string('key').primary()
      table.json('config').nullable()
    })
  })

  afterAll(async () => {
    if (!db) return
    await db.schema.dropTableIfExists('authentication')
    await db.schema.dropTableIfExists('users')
    await db.destroy()
  })

  it('removes only retired values and mapping keys while retaining supported claims and identity state', async () => {
    const users = [
      { id: 1, location: 'Montréal', jobTitle: 'Editor', authVersion: 7 },
      { id: 2, location: '', jobTitle: '', authVersion: 0 }
    ]
    await db('users').insert(users.map((user, index) => ({ ...user, pronouns: index === 0 ? 'retired text' : '' })))
    const retainedConfig = {
      locationClaim: 'office.location',
      jobTitleClaim: 'role',
      mappingLocation: 'l',
      mappingJobTitle: 'title',
      requireEmailVerified: true,
      clientSecret: 'fixture-secret',
      custom: { nested: ['preserve', 5, false] }
    }
    await db('authentication').insert([
      { key: 'configured', config: JSON.stringify({ ...retainedConfig, pronounsClaim: 'retired', mappingPronouns: '' }) },
      { key: 'unconfigured', config: JSON.stringify({ clientSecret: 'unchanged', custom: null }) },
      { key: 'nullable', config: null }
    ])

    await db.transaction(up)

    expect(await db.schema.hasColumn('users', 'pronouns')).toBe(false)
    expect(await db('users').orderBy('id')).toEqual(users)
    expect(await db('authentication').orderBy('key')).toEqual([
      { key: 'configured', config: retainedConfig },
      { key: 'nullable', config: null },
      { key: 'unconfigured', config: { clientSecret: 'unchanged', custom: null } }
    ])
    await expect(down(db)).rejects.toThrow('cannot be reconstructed')
    expect(await db('users').orderBy('id')).toEqual(users)
  })
})
