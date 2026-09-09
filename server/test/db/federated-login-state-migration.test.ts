import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { down, up } from '../../db/migrations/tsepistle-000030-federated-login-state.ts'

const TABLE = 'federatedLoginAttempts'

describe('federated login attempt migration', () => {
  const databases: Knex[] = []

  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  const createDatabase = (): Knex => {
    const database = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(database)
    return database
  }

  it('creates only the transient attempt table and can roll it back without backfill', async () => {
    const database = createDatabase()
    await up(database)

    expect(await database.schema.hasTable(TABLE)).toBe(true)
    expect(await database(TABLE)).toHaveLength(0)
    await down(database)
    expect(await database.schema.hasTable(TABLE)).toBe(false)
  })
})
