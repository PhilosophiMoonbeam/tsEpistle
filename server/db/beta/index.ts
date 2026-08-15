import { createRequire } from 'node:module'
import path from 'node:path'

import fs from 'fs-extra'
import type { Knex } from 'knex'
import _ from 'lodash'
import semver from 'semver'



interface WikiDatabaseContext {
  SERVERPATH: string
  config: {
    db: { type: string }
  }
}

interface MigrationRecord {
  name: string
}

interface MigrationSpec {
  file: string
  directory: string
}

function isMigration (value: unknown): value is Knex.Migration {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.up === 'function' &&
    (candidate.down === undefined || typeof candidate.down === 'function')
}

const wiki = WIKI as unknown as WikiDatabaseContext
function createLegacyMigrationSource(): Knex.MigrationSource<MigrationSpec> {
  const baseMigrationPath = path.join(wiki.SERVERPATH, (wiki.config.db.type !== 'sqlite') ? 'db/beta/migrations' : 'db/beta/migrations-sqlite')
  const requireMigration = createRequire(import.meta.url)
  return {
    async getMigrations () {
      const migrationFiles = await fs.readdir(baseMigrationPath)
      return migrationFiles
        .filter(file => file.endsWith('.ts'))
        .sort((left, right) => semver.compare(left.slice(0, -3), right.slice(0, -3)))
        .map(file => ({
          file,
          directory: baseMigrationPath
        }))
    },
    getMigrationName (migration) {
      return migration.file.replace(/\.ts$/, '.js')
    },
    async getMigration (migration) {
      const loaded: unknown = requireMigration(path.join(baseMigrationPath, migration.file))
      if (!isMigration(loaded)) {
        throw new TypeError(`Invalid beta migration module: ${migration.file}`)
      }
      return loaded
    }
  }
}

export async function getLegacyMigrationNames(): Promise<string[]> {
  const migrationSource = createLegacyMigrationSource()
  const migrations = await migrationSource.getMigrations([])
  return migrations.map(migration => migrationSource.getMigrationName(migration))
}

export async function migrate (knex: Knex): Promise<void> {
  const migrationsTableExists = await knex.schema.hasTable('migrations')
  if (!migrationsTableExists) {
    return
  }

  const dbCompat = {
    charset: (wiki.config.db.type === 'mysql' || wiki.config.db.type === 'mariadb')
  }

  const migrations = await knex<MigrationRecord>('migrations')
  if (_.some(migrations, migration => migration.name.indexOf('2.0.0-beta') >= 0)) {
    const localeColnInfo = await knex('pages').columnInfo('localeCode')
    if (wiki.config.db.type !== 'sqlite' && localeColnInfo.maxLength === 2) {
      const locales = await knex('locales')
      await knex.schema
        .table('users', table => {
          table.dropForeign(['localeCode'])
        })
        .table('pages', table => {
          table.dropForeign(['localeCode'])
        })
        .table('pageHistory', table => {
          table.dropForeign(['localeCode'])
        })
        .table('pageTree', table => {
          table.dropForeign(['localeCode'])
        })
        .dropTable('locales')
        .createTable('locales', table => {
          if (dbCompat.charset) { table.charset('utf8mb4') }
          table.string('code', 5).notNullable().primary()
          table.json('strings')
          table.boolean('isRTL').notNullable().defaultTo(false)
          table.string('name').notNullable()
          table.string('nativeName').notNullable()
          table.integer('availability').notNullable().defaultTo(0)
          table.string('createdAt').notNullable()
          table.string('updatedAt').notNullable()
        })
      await knex('locales').insert(locales)
      await knex.schema
        .table('users', table => {
          table.string('localeCode', 5).notNullable().defaultTo('en').alter()
        })
        .table('pages', table => {
          table.string('localeCode', 5).alter()
        })
        .table('pageHistory', table => {
          table.string('localeCode', 5).alter()
        })
        .table('pageTree', table => {
          table.string('localeCode', 5).alter()
        })
        .table('users', table => {
          table.foreign('localeCode').references('code').inTable('locales')
        })
        .table('pages', table => {
          table.foreign('localeCode').references('code').inTable('locales')
        })
        .table('pageHistory', table => {
          table.foreign('localeCode').references('code').inTable('locales')
        })
        .table('pageTree', table => {
          table.foreign('localeCode').references('code').inTable('locales')
        })
    }

    const migrationSource = createLegacyMigrationSource()

    await knex.migrate.latest({
      tableName: 'migrations',
      migrationSource
    })

    await knex('migrations').truncate()
    await knex('migrations').insert({
      name: '2.0.0.js',
      batch: 1,
      migration_time: knex.fn.now()
    })
  }
}

export default { getLegacyMigrationNames, migrate }
