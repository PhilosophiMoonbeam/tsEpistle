import createKnex, { type Knex } from 'knex'
import { up } from '../../db/migrations/tsepistle-000075-page-lifecycle.ts'
import { observePageLifecycleBaseline, recordPageLifecycleBody, recordPageLifecycleComment } from '../../helpers/page-lifecycle-clocks.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_page_lifecycle_clocks_test', import.meta.path)
if (connection) describe('native lifecycle clock transactions', () => {
  let db: Knex
  const schema = 'lifecycle_clock_contract'
  const source = { id: 1, content: 'original', contentType: 'markdown', sourceRevision: '1' }
  const clock = () => db('pageLifecycleClocks').where('pageId', 1).first()
  const body = (patch: Partial<typeof source> = {}, created = false) => db.transaction(async tx => {
    const next = { ...source, ...patch }
    await tx('pages').where('id', 1).update(next)
    await recordPageLifecycleBody(tx, next, { created })
  })
  beforeAll(async () => {
    const admin = createKnex({ client: 'pg', connection })
    await admin.raw('CREATE SCHEMA ??', [schema])
    await admin.destroy()
    db = createKnex({ client: 'pg', connection, searchPath: [schema], pool: { min: 1, max: 4 } })
    await db.schema.createTable('users', table => { table.integer('id').primary() })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary(); table.text('content').notNullable(); table.text('contentType').notNullable(); table.bigInteger('sourceRevision').notNullable()
    })
    // A legacy source is present before migration; history/updatedAt are deliberately absent.
    await db('pages').insert(source)
    await up(db)
    const migrated = await clock()
    expect(migrated.bodyAnchorKind).toBe('unknown')
    expect(migrated.bodyAnchorAt).toBeNull()
    expect(migrated.commentAnchorKind).toBe('unknown')
    expect(migrated.commentAnchorAt).toBeNull()
    expect(await db('pages').first()).toEqual(source)
  })
  beforeEach(async () => {
    await db('pageLifecycleCommentEvents').del()
    await db('pageLifecycleClocks').del()
    await db('pages').where('id', 1).update(source)
  })
  afterAll(async () => {
    await db.raw('DROP SCHEMA ?? CASCADE', [schema])
    await db.destroy()
  })
  it('keeps a lazy legacy clock unknown until explicit matching-revision observation', async () => {
    await body()
    const unknown = await clock()
    expect(unknown.bodyAnchorKind).toBe('unknown')
    expect(unknown.commentAnchorKind).toBe('unknown')
    expect(await db.transaction(tx => observePageLifecycleBaseline(tx, { pageId: 1, sourceRevision: '0', kind: 'body', now: new Date(0) }))).toBe(false)
    expect((await clock()).bodyAnchorAt).toBeNull()
    expect(await db.transaction(tx => observePageLifecycleBaseline(tx, { pageId: 1, sourceRevision: '1', kind: 'body', now: new Date(0) }))).toBe(true)
    const observed = await clock()
    expect(observed.bodyAnchorKind).toBe('observed-baseline')
    expect(new Date(observed.bodyAnchorAt).valueOf()).toBeGreaterThan(Date.UTC(2020, 0, 1))
    expect(await db.transaction(tx => observePageLifecycleBaseline(tx, { pageId: 1, sourceRevision: '1', kind: 'body', now: new Date(0) }))).toBe(false)
    expect((await clock()).bodyEpoch).toBe(observed.bodyEpoch)
    expect(await db('pages').first()).toEqual({ ...source, sourceRevision: '1' })
  })
  it('creates a body event and no-comment baseline but metadata/same-byte restore preserve epochs', async () => {
    await body({}, true)
    const initial = await clock()
    expect(initial.bodyAnchorKind).toBe('known-change')
    expect(initial.commentAnchorKind).toBe('observed-baseline')
    await body({ sourceRevision: '2' })
    expect((await clock()).bodyEpoch).toBe(initial.bodyEpoch)
    expect(String((await clock()).bodyObservedSourceRevision)).toBe('2')
    await body({ sourceRevision: '3', content: 'changed' })
    const changed = await clock()
    expect(changed.bodyEpoch).not.toBe(initial.bodyEpoch)
    expect(changed.commentEpoch).toBe(initial.commentEpoch)
    await body({ sourceRevision: '4', content: 'changed' })
    expect((await clock()).bodyEpoch).toBe(changed.bodyEpoch)
    await body({ sourceRevision: '5', content: 'changed', contentType: 'html' })
    expect((await clock()).bodyEpoch).not.toBe(changed.bodyEpoch)
  })
  it('deduplicates old repeated native events after newer events and rolls back failed transactions', async () => {
    await body({}, true)
    const original = await clock()
    for (const eventId of ['root', 'reply']) await db.transaction(tx => recordPageLifecycleComment(tx, { pageId: 1, eventId }))
    const after = await clock()
    expect(after.commentAnchorKind).toBe('known-change')
    expect(after.bodyEpoch).toBe(original.bodyEpoch)
    await db.transaction(tx => recordPageLifecycleComment(tx, { pageId: 1, eventId: 'root' }))
    expect((await clock()).commentEpoch).toBe(after.commentEpoch)
    const rollback = new Error('Fixture rollback')
    await expect(Promise.resolve(db.transaction(async tx => {
      await recordPageLifecycleComment(tx, { pageId: 1, eventId: 'rolled-back' })
      throw rollback
    }))).rejects.toBe(rollback)
    expect((await clock()).commentEpoch).toBe(after.commentEpoch)
    expect(await db('pageLifecycleCommentEvents').where('eventId', 'rolled-back')).toHaveLength(0)
  })
  it('serializes concurrent first comments without lost events and never moves a future anchor backward', async () => {
    await Promise.all(['a', 'b'].map(eventId => db.transaction(tx => recordPageLifecycleComment(tx, { pageId: 1, eventId }))))
    expect(await db('pageLifecycleCommentEvents')).toHaveLength(2)
    const future = new Date('2099-01-01T00:00:00.000Z')
    await db('pageLifecycleClocks').where('pageId', 1).update({ commentAnchorAt: future })
    await db.transaction(tx => recordPageLifecycleComment(tx, { pageId: 1, eventId: 'c' }))
    expect(new Date((await clock()).commentAnchorAt).toISOString()).toBe(future.toISOString())
  })
  it('rejects stale producer snapshots atomically', async () => {
    await body({}, true)
    const before = await clock()
    await expect(Promise.resolve(db.transaction(tx => recordPageLifecycleBody(tx, { ...source, sourceRevision: '99' })))).rejects.toThrow()
    expect(await clock()).toEqual(before)
  })
})
