import { createRequire } from 'node:module'
import path from 'node:path'

import fs from 'fs-extra'
import type { Knex } from 'knex'
import semver from 'semver'

interface WikiDatabaseContext {
  SERVERPATH: string
  config: {
    db: { type: string }
  }
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
const baseMigrationPath = path.join(wiki.SERVERPATH, (wiki.config.db.type !== 'sqlite') ? 'db/migrations' : 'db/migrations-sqlite')
const requireMigration = createRequire(import.meta.url)

const migrationSource: Knex.MigrationSource<MigrationSpec> = {
  async getMigrations () {
    const migrationFiles = await fs.readdir(baseMigrationPath)
    return migrationFiles
      .filter(file => file.endsWith('.ts'))
      .map(file => file.slice(0, -3))
      .sort(semver.compare)
      .map(file => ({
        file,
        directory: baseMigrationPath
      }))
  },

  getMigrationName (migration) {
    return migration.file.endsWith('.js') ? migration.file : `${migration.file}.js`
  },

  async getMigration (migration) {
    const filename = migration.file.replace(/\.js$/, '') + '.ts'
    const loaded: unknown = requireMigration(path.join(baseMigrationPath, filename))
    if (!isMigration(loaded)) {
      throw new TypeError(`Invalid migration module: ${filename}`)
    }
    return loaded
  }
}

export default migrationSource
