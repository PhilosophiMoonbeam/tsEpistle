import { randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import type { PostgresTestConnection } from '../postgres-test-connection.mts'

/** The runner admits native connections; this helper only owns per-case construction and schema teardown. */
export const createAgentMediaTestDatabase = async (connection: PostgresTestConnection | null): Promise<{ db: Knex; destroy: () => Promise<void> }> => {
  if (connection === null) {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    return {
      db,
      destroy: async () => {
        await db.destroy()
      }
    }
  }
  const schema = `agent_media_test_${randomUUID().replaceAll('-', '')}`
  const admin = createKnex({ client: 'pg', connection, pool: { min: 0, max: 1 } })
  try {
    await admin.raw(`CREATE SCHEMA "${schema}"`)
  } finally {
    await admin.destroy()
  }
  const db = createKnex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } })
  return {
    db,
    destroy: async () => {
      try {
        await db.raw(`DROP SCHEMA "${schema}" CASCADE`)
      } finally {
        await db.destroy()
      }
    }
  }
}
