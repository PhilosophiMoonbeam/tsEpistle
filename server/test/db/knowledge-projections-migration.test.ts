import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { down, up } from '../../db/migrations/2.5.152.ts'

describe('page knowledge projection migration', () => {
  let db: Knex

  beforeEach(() => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  })

  afterEach(async () => db.destroy())

  it('stores one projection per page source revision', async () => {
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
    await expect(Promise.resolve(db('pageKnowledgeProjections').insert(row))).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' })
    await db('pageKnowledgeProjections').insert({ ...row, sourceRevision: '8' })
    const stored = await db('pageKnowledgeProjections').orderBy('sourceRevision').select('pageId', 'sourceRevision', 'sourceSha256', 'summary', 'projection')
    expect(stored.map(value => ({ ...value, sourceRevision: String(value.sourceRevision) }))).toEqual([
      { pageId: 42, sourceRevision: '7', sourceSha256: 'a'.repeat(64), summary: 'Summary', projection: '{}' },
      { pageId: 42, sourceRevision: '8', sourceSha256: 'a'.repeat(64), summary: 'Summary', projection: '{}' }
    ])
  })

  it('removes only the projection store on rollback', async () => {
    await up(db)
    await down(db)
    expect(await db.schema.hasTable('pageKnowledgeProjections')).toBe(false)
  })
})
