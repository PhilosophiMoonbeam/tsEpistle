import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { up as addPreferences } from '../../db/migrations/tsfranki-000009-user-presentation-preferences.ts'
import { down, up } from '../../db/migrations/tsfranki-000010-concrete-user-presentation-defaults.ts'

interface UserRow {
  id: number
  email: string
  displayName: string
  fontFamily: string
  readingGutter: string
}

describe('concrete user presentation defaults migration', () => {
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
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.json('value')
    })
    await addPreferences(db)
    return db
  }

  it('preserves existing fonts while materializing the current administrator gutter and changing defaults', async () => {
    const db = await createDatabase()
    await db('settings').insert({ key: 'theming', value: JSON.stringify({ gutterStyle: 'laurel' }) })
    await db('users').insert({ id: 1, email: 'default@example.com', displayName: 'Default User' })
    await db('users').insert([
      {
        id: 2,
        email: 'explicit@example.com',
        displayName: 'Explicit User',
        fontFamily: 'roboto-flex',
        readingGutter: 'orbits'
      },
      {
        id: 3,
        email: 'newsreader@example.com',
        displayName: 'Newsreader User',
        fontFamily: 'newsreader',
        readingGutter: 'none'
      }
    ])

    await up(db)

    expect(await db<UserRow>('users').orderBy('id')).toEqual([
      {
        id: 1,
        email: 'default@example.com',
        displayName: 'Default User',
        fontFamily: 'newsreader',
        readingGutter: 'laurel'
      },
      {
        id: 2,
        email: 'explicit@example.com',
        displayName: 'Explicit User',
        fontFamily: 'roboto-flex',
        readingGutter: 'orbits'
      },
      {
        id: 3,
        email: 'newsreader@example.com',
        displayName: 'Newsreader User',
        fontFamily: 'newsreader',
        readingGutter: 'none'
      }
    ])

    await db('users').insert({ id: 4, email: 'new@example.com', displayName: 'New User' })
    expect(await db<UserRow>('users').where({ id: 4 }).first()).toEqual({
      id: 4,
      email: 'new@example.com',
      displayName: 'New User',
      fontFamily: 'roboto-flex',
      readingGutter: 'columns'
    })
  })

  it('accepts wrapped settings and restores only schema defaults on rollback', async () => {
    const db = await createDatabase()
    await db('settings').insert({ key: 'theming', value: JSON.stringify({ v: { gutterStyle: 'aurora' } }) })
    await db('users').insert({
      id: 1,
      email: 'existing@example.com',
      displayName: 'Existing User',
      fontFamily: 'roboto-flex'
    })

    await up(db)
    await down(db)

    expect(await db<UserRow>('users').where({ id: 1 }).first()).toMatchObject({
      fontFamily: 'roboto-flex',
      readingGutter: 'aurora'
    })
    await db('users').insert({ id: 2, email: 'rolled-back@example.com', displayName: 'Rolled Back User' })
    expect(await db<UserRow>('users').where({ id: 2 }).first()).toMatchObject({
      fontFamily: 'newsreader',
      readingGutter: 'site'
    })
  })

  it('uses columns when the administrator setting is invalid', async () => {
    const db = await createDatabase()
    await db('settings').insert({ key: 'theming', value: JSON.stringify({ gutterStyle: 'marble' }) })
    await db('users').insert({ id: 1, email: 'existing@example.com', displayName: 'Existing User' })

    await up(db)

    expect(await db<UserRow>('users').where({ id: 1 }).first()).toMatchObject({
      fontFamily: 'newsreader',
      readingGutter: 'columns'
    })
  })
})
