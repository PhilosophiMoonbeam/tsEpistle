import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { up as addPresentationPreferences } from '../../db/migrations/tsfranki-000009-user-presentation-preferences.ts'
import { up as materializePresentationDefaults } from '../../db/migrations/tsfranki-000010-concrete-user-presentation-defaults.ts'
import { down, up } from '../../db/migrations/tsfranki-000011-remove-reading-gutters.ts'

type JsonObject = Record<string, unknown>

interface UserRow {
  id: number
  email: string
  displayName: string
  fontFamily: string
  readingGutter?: string
}

interface SettingsRow {
  key: string
  value: unknown
}

interface ObjectSettingsStore {
  value: JsonObject
}

const USER_COLUMNS_AFTER_UP = ['displayName', 'email', 'fontFamily', 'id']

const withObjectThemingSettings = (database: Knex, store: ObjectSettingsStore): Knex => {
  const settingsDatabase = ((tableName: string) => {
    if (tableName !== 'settings') return database(tableName)

    let matchesTheming = false
    const query = {
      where(criteria: Record<string, unknown>) {
        matchesTheming = criteria.key === 'theming'
        return query
      },
      async first() {
        return matchesTheming ? { value: store.value } : undefined
      },
      async update(changes: { value: unknown }) {
        if (!matchesTheming) return 0
        if (typeof changes.value !== 'object' || changes.value === null || Array.isArray(changes.value)) {
          throw new TypeError('Expected object-encoded theming settings')
        }
        store.value = changes.value as JsonObject
        return 1
      }
    }
    return query
  }) as unknown as Knex
  Reflect.set(settingsDatabase, 'schema', database.schema)
  return settingsDatabase
}

describe('reading gutters removal migration', () => {
  const databases: Knex[] = []

  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  const createDatabase = async (themingValue?: string): Promise<Knex> => {
    const database = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(database)
    await database.schema.createTable('users', table => {
      table.integer('id').primary()
      table.string('email').notNullable()
      table.string('displayName').notNullable()
    })
    await database.schema.createTable('settings', table => {
      table.string('key').primary()
      table.json('value')
    })
    if (themingValue !== undefined) await database<SettingsRow>('settings').insert({ key: 'theming', value: themingValue })
    await addPresentationPreferences(database)
    await materializePresentationDefaults(database)
    return database
  }

  it('removes plain string-encoded gutter settings and the user column without losing unrelated data', async () => {
    const theming = {
      gutterStyle: 'laurel',
      gutterCustomCss: '.page::before { content: ""; }',
      primaryColor: '#123456',
      typography: { headings: 'serif' }
    }
    const database = await createDatabase(JSON.stringify(theming))
    const navigationValue = JSON.stringify({ mode: 'tree', compact: true })
    await database<SettingsRow>('settings').insert({ key: 'navigation', value: navigationValue })
    await database<UserRow>('users').insert({
      id: 1,
      email: 'reader@example.com',
      displayName: 'Reader',
      fontFamily: 'source-serif-4',
      readingGutter: 'orbits'
    })

    await up(database)

    expect(Object.keys(await database('users').columnInfo()).sort()).toEqual(USER_COLUMNS_AFTER_UP)
    expect(await database<UserRow>('users').where({ id: 1 }).first()).toEqual({
      id: 1,
      email: 'reader@example.com',
      displayName: 'Reader',
      fontFamily: 'source-serif-4'
    })
    const storedTheming = await database<SettingsRow>('settings').where({ key: 'theming' }).first('value')
    expect(typeof storedTheming?.value).toBe('string')
    expect(JSON.parse(storedTheming?.value as string)).toEqual({
      primaryColor: '#123456',
      typography: { headings: 'serif' }
    })
    expect(await database<SettingsRow>('settings').where({ key: 'navigation' }).first('value')).toEqual({ value: navigationValue })

    await database<UserRow>('users').insert({ id: 2, email: 'new@example.com', displayName: 'New Reader' })
    expect(await database<UserRow>('users').where({ id: 2 }).first()).toMatchObject({ fontFamily: 'roboto-flex' })
  })

  it('removes wrapped gutter settings while preserving the string envelope', async () => {
    const database = await createDatabase(
      JSON.stringify({
        v: {
          gutterStyle: 'custom',
          gutterCustomCss: '.page { border-inline: 1px solid; }',
          darkMode: true,
          nested: { spacing: 12 }
        },
        version: 4,
        source: 'administrator'
      })
    )

    await up(database)

    const stored = await database<SettingsRow>('settings').where({ key: 'theming' }).first('value')
    expect(typeof stored?.value).toBe('string')
    expect(JSON.parse(stored?.value as string)).toEqual({
      v: { darkMode: true, nested: { spacing: 12 } },
      version: 4,
      source: 'administrator'
    })
  })

  it('preserves object encoding for plain and wrapped theming settings', async () => {
    const cases: Array<{ input: JsonObject; expected: JsonObject }> = [
      {
        input: { gutterStyle: 'columns', gutterCustomCss: 'ignored', logoUrl: '/logo.svg' },
        expected: { logoUrl: '/logo.svg' }
      },
      {
        input: {
          v: { gutterStyle: 'aurora', gutterCustomCss: 'ignored', contrast: 'high' },
          gutterStyle: 'stale-envelope-value',
          revision: 8
        },
        expected: { v: { contrast: 'high' }, revision: 8 }
      }
    ]

    for (const migrationCase of cases) {
      const database = await createDatabase()
      const store: ObjectSettingsStore = { value: migrationCase.input }

      await up(withObjectThemingSettings(database, store))

      expect(store.value).toEqual(migrationCase.expected)
      expect(Object.keys(await database('users').columnInfo()).sort()).toEqual(USER_COLUMNS_AFTER_UP)
    }
  })

  it.each([
    ['absent settings', undefined],
    ['invalid JSON', '{"gutterStyle":'],
    ['JSON null', 'null'],
    ['JSON array', '["gutterStyle"]'],
    ['JSON primitive', '42'],
    ['valid settings without gutters', '{ "primaryColor": "#abcdef" }']
  ] as const)('handles %s without rewriting the theming value', async (_label, themingValue) => {
    const database = await createDatabase(themingValue)
    const storedBeforeMigration = await database<SettingsRow>('settings').where({ key: 'theming' }).first('value')

    await up(database)

    expect(Object.keys(await database('users').columnInfo()).sort()).toEqual(USER_COLUMNS_AFTER_UP)
    const stored = await database<SettingsRow>('settings').where({ key: 'theming' }).first('value')
    expect(stored?.value).toBe(storedBeforeMigration?.value)
  })

  it('restores a non-null historical user default without reconstructing removed settings on rollback', async () => {
    const database = await createDatabase(JSON.stringify({ gutterStyle: 'orbits', gutterCustomCss: 'ignored', primaryColor: '#456789' }))
    await database<UserRow>('users').insert({
      id: 1,
      email: 'existing@example.com',
      displayName: 'Existing Reader',
      fontFamily: 'roboto-flex',
      readingGutter: 'none'
    })
    await up(database)

    await down(database)

    expect(await database<UserRow>('users').where({ id: 1 }).first()).toEqual({
      id: 1,
      email: 'existing@example.com',
      displayName: 'Existing Reader',
      fontFamily: 'roboto-flex',
      readingGutter: 'columns'
    })
    await database<UserRow>('users').insert({ id: 2, email: 'new@example.com', displayName: 'New Reader', fontFamily: 'roboto-flex' })
    expect(await database<UserRow>('users').where({ id: 2 }).first()).toMatchObject({ readingGutter: 'columns' })
    await expect(
      Promise.resolve(
        database<UserRow>('users').insert({
          id: 3,
          email: 'null@example.com',
          displayName: 'Null Reader',
          fontFamily: 'roboto-flex',
          readingGutter: null as unknown as string
        })
      )
    ).rejects.toThrow()
    const stored = await database<SettingsRow>('settings').where({ key: 'theming' }).first('value')
    expect(JSON.parse(stored?.value as string)).toEqual({ primaryColor: '#456789' })
  })
})
