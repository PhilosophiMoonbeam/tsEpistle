import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { down, up } from '../../db/migrations/tsfranki-000009-user-presentation-preferences.ts'

interface LegacyUserRow {
  id: number
  email: string
  displayName: string
}

interface UserRow extends LegacyUserRow {
  fontFamily: string
  readingGutter: string
}

const LEGACY_COLUMNS = ['displayName', 'email', 'id']

describe('user presentation preferences migration', () => {
  const databases: Knex[] = []

  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  const createDatabase = async (): Promise<Knex> => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(db)
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.string('email').notNullable()
      table.string('displayName').notNullable()
    })
    return db
  }

  it('adds defaults without losing users and removes only the added columns on rollback', async () => {
    const db = await createDatabase()
    const existingUser: LegacyUserRow = { id: 1, email: 'existing@example.com', displayName: 'Existing User' }
    await db<LegacyUserRow>('users').insert(existingUser)

    await up(db)

    expect(await db<UserRow>('users').where({ id: existingUser.id }).first()).toEqual({
      ...existingUser,
      fontFamily: 'newsreader',
      readingGutter: 'site'
    })

    const newUser: LegacyUserRow = { id: 2, email: 'new@example.com', displayName: 'New User' }
    await db<LegacyUserRow>('users').insert(newUser)
    expect(await db<UserRow>('users').where({ id: newUser.id }).first()).toEqual({
      ...newUser,
      fontFamily: 'newsreader',
      readingGutter: 'site'
    })

    await down(db)

    expect(Object.keys(await db('users').columnInfo()).sort()).toEqual(LEGACY_COLUMNS)
    expect(await db<LegacyUserRow>('users').orderBy('id')).toEqual([existingUser, newUser])
  })
})
