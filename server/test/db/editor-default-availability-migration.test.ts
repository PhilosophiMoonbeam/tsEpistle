import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { up } from '../../db/migrations/tsfranki-000005-editor-default-availability.ts'

interface SettingsRow {
  key: string
  value: string | Record<string, unknown>
}

const LEGACY_EDITORS = ['markdown', 'visual-markdown', 'ckeditor', 'asciidoc', 'code']

const readEditorSettings = async (db: Knex): Promise<Record<string, unknown>> => {
  const row = await db<SettingsRow>('settings').where({ key: 'editors' }).first('value')
  if (!row) throw new Error('Expected editors settings row')
  return typeof row.value === 'string' ? (JSON.parse(row.value) as Record<string, unknown>) : row.value
}

const createSettingsTable = async (db: Knex): Promise<void> => {
  await db.schema.createTable('settings', table => {
    table.string('key').notNullable().primary()
    table.json('value')
  })
}

describe('editor default availability migration', () => {
  const databases: Knex[] = []

  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  const createDatabase = async (): Promise<Knex> => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(db)
    await createSettingsTable(db)
    return db
  }

  it('migrates an unordered exact legacy set returned as JSON text', async () => {
    const db = await createDatabase()
    await db<SettingsRow>('settings').insert({
      key: 'editors',
      value: JSON.stringify({ available: ['code', 'ckeditor', 'markdown', 'asciidoc', 'visual-markdown'] })
    })

    await up(db)

    expect(await readEditorSettings(db)).toEqual({ available: ['markdown', 'visual-markdown'] })
  })

  it('preserves every other editors setting property', async () => {
    const db = await createDatabase()
    const settings = {
      available: LEGACY_EDITORS,
      default: 'ckeditor',
      preferences: { markdown: { lineNumbers: true } }
    }
    await db<SettingsRow>('settings').insert({ key: 'editors', value: JSON.stringify(settings) })

    await up(db)

    expect(await readEditorSettings(db)).toEqual({
      ...settings,
      available: ['markdown', 'visual-markdown']
    })
  })

  it('preserves custom subsets, values with extras, and malformed values', async () => {
    const unchangedValues: Array<string | Record<string, unknown>> = [
      { available: ['markdown', 'ckeditor'] },
      { available: [...LEGACY_EDITORS, 'future-editor'] },
      { available: 'markdown' },
      'not-json'
    ]

    for (const value of unchangedValues) {
      const db = await createDatabase()
      const storedValue = typeof value === 'string' ? value : JSON.stringify(value)
      await db<SettingsRow>('settings').insert({ key: 'editors', value: storedValue })

      await up(db)

      expect((await db<SettingsRow>('settings').where({ key: 'editors' }).first('value'))?.value).toBe(storedValue)
    }
  })

  it('migrates an exact legacy set returned as a parsed JSON object', async () => {
    let updatedValue: string | undefined
    interface SettingsQuery {
      where(criteria: { key: string }): SettingsQuery
      first(column: string): Promise<{ value: unknown }>
      update(values: { value: string }): Promise<number>
    }

    let query: SettingsQuery
    query = {
      where: () => query,
      first: async () => ({ value: { available: LEGACY_EDITORS, preferred: 'markdown' } }),
      update: async values => {
        updatedValue = values.value
        return 1
      }
    }
    const db = ((table: string) => {
      expect(table).toBe('settings')
      return query
    }) as unknown as Knex

    await up(db)

    expect(JSON.parse(updatedValue ?? '')).toEqual({ available: ['markdown', 'visual-markdown'], preferred: 'markdown' })
  })

  it('does not create settings when the editors row is missing', async () => {
    const db = await createDatabase()

    await up(db)

    expect(await db<SettingsRow>('settings')).toEqual([])
  })
})
