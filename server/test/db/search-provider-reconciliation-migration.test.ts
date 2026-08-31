import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { up } from '../../db/migrations/tsfranki-000004-postgres-search-provider-cutover.ts'

interface ModuleRow {
  key: string
  isEnabled: number
  config: string | Record<string, unknown>
}

const parseConfig = (config: ModuleRow['config']): Record<string, unknown> =>
  typeof config === 'string' ? (JSON.parse(config) as Record<string, unknown>) : config

const createModuleTables = async (db: Knex): Promise<void> => {
  await db.schema.createTable('searchEngines', table => {
    table.string('key').primary()
    table.boolean('isEnabled').notNullable().defaultTo(false)
    table.json('config')
  })
  await db.schema.createTable('storage', table => {
    table.string('key').primary()
    table.boolean('isEnabled').notNullable().defaultTo(false)
    table.json('config')
  })
}

describe('PostgreSQL-only provider migration', () => {
  const databases: Knex[] = []

  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  const createDatabase = async (): Promise<Knex> => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(db)
    await createModuleTables(db)
    return db
  }

  it('enables only PostgreSQL Advanced and preserves its existing configuration', async () => {
    const db = await createDatabase()
    const postgresConfig = { dictLanguage: 'german', ranking: { graphWeight: 0.75 } }
    await db('searchEngines').insert([
      { key: 'postgres', isEnabled: false, config: JSON.stringify(postgresConfig) },
      { key: 'algolia', isEnabled: true, config: '{}' },
      { key: 'elasticsearch', isEnabled: false, config: '{}' },
      { key: 'aws', isEnabled: false, config: '{}' },
      { key: 'azure', isEnabled: false, config: '{}' },
      { key: 'manticore', isEnabled: false, config: '{}' },
      { key: 'solr', isEnabled: false, config: '{}' },
      { key: 'sphinx', isEnabled: false, config: '{}' },
      { key: 'db', isEnabled: true, config: '{}' }
    ])
    await db('storage').insert([
      { key: 'box', isEnabled: true, config: '{}' },
      { key: 'dropbox', isEnabled: true, config: '{}' },
      { key: 'gdrive', isEnabled: true, config: '{}' },
      { key: 'onedrive', isEnabled: true, config: '{}' },
      { key: 's3', isEnabled: true, config: '{}' },
      { key: 'azure', isEnabled: true, config: '{}' },
      { key: 'disk', isEnabled: true, config: '{}' }
    ])

    await up(db)

    const searchRows = await db<ModuleRow>('searchEngines').orderBy('key')
    expect(searchRows).toHaveLength(1)
    expect(searchRows[0]).toMatchObject({ key: 'postgres', isEnabled: 1 })
    expect(parseConfig(searchRows[0].config)).toEqual(postgresConfig)
    expect((await db('storage').orderBy('key').select('key')).map(row => row.key)).toEqual(['azure', 'disk', 's3'])
  })

  it('creates PostgreSQL Advanced with its default configuration when no row exists', async () => {
    const db = await createDatabase()
    await db('searchEngines').insert({ key: 'db', isEnabled: true, config: '{"legacy":true}' })

    await up(db)

    const searchRows = await db<ModuleRow>('searchEngines')
    expect(searchRows).toHaveLength(1)
    expect(searchRows[0]).toMatchObject({ key: 'postgres', isEnabled: 1 })
    expect(parseConfig(searchRows[0].config)).toEqual({ dictLanguage: 'english' })
  })
})
