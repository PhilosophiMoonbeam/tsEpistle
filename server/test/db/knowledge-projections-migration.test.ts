import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { down, up } from '../../db/migrations/2.5.152.ts'

describe('page knowledge projection migration', () => {
  let db: Knex

  beforeEach(() => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  })

  afterEach(async () => db.destroy())

  it('stores one immutable projection per page source revision', async () => {
    await up(db)
    await up(db)
    const row = {
      pageId: 42,
      sourceRevision: '7',
      sourceSha256: 'a'.repeat(64),
      schemaVersion: 1,
      deterministicVersion: 'wiki-knowledge-v1',
      state: 'partial',
      enrichmentState: 'unavailable',
      conceptType: null,
      summary: 'Summary',
      searchText: 'summary',
      lifecycleStatus: 'stable',
      trustTier: 'unverified',
      verification: 'unverified',
      staleAfter: null,
      projection: '{}'
    }
    await db('pageKnowledgeProjections').insert(row)
    await expect(db('pageKnowledgeProjections').insert(row)).rejects.toThrow()
    await expect(db('pageKnowledgeProjections').insert({ ...row, sourceRevision: '8' })).resolves.toBeDefined()
  })

  it('removes only the projection store on rollback', async () => {
    await up(db)
    await down(db)
    expect(await db.schema.hasTable('pageKnowledgeProjections')).toBe(false)
  })
})
