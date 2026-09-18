import { randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'

/** Opt-in PostgreSQL proof uses a disposable schema in a dedicated agents test database. */
export const createAgentMediaTestDatabase = async (): Promise<{ db: Knex; destroy: () => Promise<void> }> => {
  if (process.env.WIKI_AGENT_MEDIA_POSTGRES !== '1') {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    return {
      db,
      destroy: async () => {
        await db.destroy()
      }
    }
  }
  const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
  if (!database.endsWith('_agents_test')) throw new Error('Media PostgreSQL proof requires a dedicated database ending in _agents_test.')
  const connection = {
    host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
    port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
    user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
    password: process.env.WIKI_TEST_POSTGRES_PASSWORD,
    database
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
