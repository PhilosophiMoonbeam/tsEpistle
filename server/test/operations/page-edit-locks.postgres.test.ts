import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up, down } from '../../db/migrations/tsepistle-000080-page-edit-locks.ts'
import { assertPageEditUnlocked, assertPagesEditUnlocked } from '../../helpers/page-edit-lock.ts'
import type * as LockOperations from '../../operations/page-edit-lock.ts'
import type { PagePrincipal } from '../../helpers/page-access.ts'

const connection = getPostgresTestConnection('_page_edit_locks_test', import.meta.path)
const suite = connection ? describe : describe.skip
const manager = { id: 7, authVersion: 0, permissions: ['manage:system'] }
const reader = { id: 8, authVersion: 0, permissions: ['read:pages'] }
const originalWiki = Reflect.get(globalThis, 'WIKI')
suite('PostgreSQL administrative edit-lock policy and commit ordering', () => {
  let db: Knex, peer: Knex, operations: typeof LockOperations
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 5 } })
    peer = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 2 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, "isActive" boolean NOT NULL DEFAULT true, "isSystem" boolean NOT NULL DEFAULT false, "authVersion" integer NOT NULL DEFAULT 0, email text NOT NULL);
      CREATE TABLE groups (id integer PRIMARY KEY, permissions jsonb NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer NOT NULL, "groupId" integer NOT NULL);
      CREATE TABLE pages (id integer PRIMARY KEY, path text NOT NULL, "localeCode" text NOT NULL DEFAULT 'en', visibility text NOT NULL DEFAULT 'public', "ownerId" integer, "isPublished" boolean NOT NULL DEFAULT true, "publishStartDate" text NOT NULL DEFAULT '', "publishEndDate" text NOT NULL DEFAULT '', content text NOT NULL DEFAULT 'Original source', "sourceRevision" bigint NOT NULL DEFAULT 1);
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL);
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY, version integer NOT NULL);
      CREATE TABLE "pageUnlockGrants" ("pageId" integer, "sessionId" text, "userId" integer, "passwordVersion" integer, "expiresAt" timestamptz);
    `)
    await db('pages').insert({ id: 41, path: 'pre-migration/exact', sourceRevision: '9007199254740993', content: 'Preserve exact authored bytes\\r\\n<literal>.' })
    const preMigrationPage = await db('pages').where({ id: 41 }).first()
    await up(db)
    expect(await db('pages').where({ id: 41 }).first()).toEqual(preMigrationPage)
    expect(await db('pageEditLocks')).toEqual([])
    await down(db)
    expect(await db('pages').where({ id: 41 }).first()).toEqual(preMigrationPage)
    await up(db)
    const permissions = (requester: PagePrincipal): string[] => requester?.permissions ?? []
    Reflect.set(globalThis, 'WIKI', { models: { knex: db }, auth: {
      checkAccess: (requester: PagePrincipal, required: string[]) => required.some(permission => permissions(requester).includes(permission)),
      checkPageAccess: (requester: PagePrincipal, required: string[]) => permissions(requester).includes('manage:system') || required.some(permission => permissions(requester).includes(permission)),
      loadPageRuleAuthority: async (requester: PagePrincipal) => ({ requester, permissions: permissions(requester), groups: [], tagAliases: {} })
    } })
    // Operations capture WIKI while loading; static evaluation would bind another test runtime.
    operations = await import('../../operations/page-edit-lock.ts')
  })
  beforeEach(async () => {
    await db.raw('TRUNCATE "pageEditLockAudit", "pageEditLocks", "pageUnlockGrants", "pageAccessPasswords", "pageTags", tags, pages, "userGroups", groups, users')
    await db('users').insert([{ id: 7, email: 'manager@example.test' }, { id: 8, email: 'reader@example.test' }])
    await db('groups').insert([{ id: 7, permissions: JSON.stringify(manager.permissions) }, { id: 8, permissions: JSON.stringify(reader.permissions) }])
    await db('userGroups').insert([{ userId: 7, groupId: 7 }, { userId: 8, groupId: 8 }])
    await db('pages').insert([{ id: 42, path: 'lock/source' }, { id: 43, path: 'lock/other' }])
  })
  afterAll(async () => { Reflect.set(globalThis, 'WIKI', originalWiki); await Promise.all([db?.destroy(), peer?.destroy()]) })
  const set = async (isEditLocked: boolean, expectedLockVersion: string, reason = 'Deliberate reviewed policy change') => operations.setPageEditLock({ requester: manager, pageId: 42, sessionId: 'manager-session', input: { isEditLocked, expectedLockVersion, reason } })
  const get = (requester: PagePrincipal = manager) => operations.getPageEditLock({ requester, pageId: 42, sessionId: 'reader-session' })
  it('defaults false without content/history changes and audits monotonic reasoned set/clear including same-state commands', async () => {
    const source = await db('pages').where({ id: 42 }).first()
    expect(await get()).toEqual({ isEditLocked: false, lockVersion: '0', canManage: true, reason: null, updatedAt: null, updatedBy: null })
    expect(await set(true, '0', 'Retain reviewed source')).toMatchObject({ isEditLocked: true, lockVersion: '1' })
    expect(await set(true, '1', 'Confirm the same policy')).toMatchObject({ isEditLocked: true, lockVersion: '2' })
    expect(await set(false, '2', 'Explicit unlock before an authorized correction')).toMatchObject({ isEditLocked: false, lockVersion: '3' })
    expect(await db('pages').where({ id: 42 }).first()).toEqual(source)
    expect(await db('pageEditLockAudit').orderBy('lockVersion').select('lockVersion', 'wasEditLocked', 'isEditLocked', 'actorId', 'reason')).toEqual([
      { lockVersion: '1', wasEditLocked: false, isEditLocked: true, actorId: 7, reason: 'Retain reviewed source' },
      { lockVersion: '2', wasEditLocked: true, isEditLocked: true, actorId: 7, reason: 'Confirm the same policy' },
      { lockVersion: '3', wasEditLocked: true, isEditLocked: false, actorId: 7, reason: 'Explicit unlock before an authorized correction' }
    ])
    await expect(down(db)).rejects.toThrow('retained')
    expect(await db.schema.hasTable('pageEditLocks')).toBe(true)
  })
  it('rejects stale versions, reasonless operations and ambient nonmanager or stale-session authority without side effects', async () => {
    await set(true, '0')
    await expect(set(false, '0')).rejects.toMatchObject({ status: 409, name: 'PAGE_EDIT_LOCK_CONFLICT' })
    await expect(set(false, '1', ' \n ')).rejects.toMatchObject({ status: 400 })
    await expect(Promise.resolve(operations.setPageEditLock({ requester: reader, pageId: 42, sessionId: 'reader', input: { isEditLocked: false, expectedLockVersion: '1', reason: 'Cannot override' } }))).rejects.toMatchObject({ status: 403 })
    await db('groups').where({ id: 7 }).update({ permissions: JSON.stringify(['read:pages']) })
    await expect(set(false, '1')).rejects.toMatchObject({ status: 403 })
    await db('users').where({ id: 7 }).update({ authVersion: 1 })
    await expect(Promise.resolve(get())).rejects.toMatchObject({ status: 401 })
    expect(await db('pageEditLockAudit')).toHaveLength(1)
    expect((await db('pageEditLocks').first()).isEditLocked).toBe(true)
  })
  it('withholds actor/reason from authorized readers and discloses no inaccessible/private/protected page policy', async () => {
    await set(true, '0', 'Manager-only audit explanation')
    expect(await get(reader)).toEqual({ isEditLocked: true, lockVersion: '1', canManage: false, updatedAt: null, updatedBy: null, reason: null })
    await db('pages').where({ id: 42 }).update({ visibility: 'private', ownerId: 7 })
    await expect(Promise.resolve(get(reader))).rejects.toMatchObject({ status: 404 })
    await db('pages').where({ id: 42 }).update({ visibility: 'public', ownerId: null })
    await db('pageAccessPasswords').insert({ pageId: 42, version: 1 })
    await expect(Promise.resolve(get(reader))).rejects.toMatchObject({ status: 404 })
    await expect(Promise.resolve(operations.getPageEditLock({ requester: manager, pageId: 42, sessionId: '' }))).rejects.toMatchObject({ status: 401 })
  })
  it('refuses a deterministic bulk mutation atomically without exposing the blocked identity; explicit audited unlock allows it', async () => {
    await set(true, '0')
    const mutate = () => db.transaction(async transaction => {
      await transaction('pages').whereIn('id', [43, 42]).orderBy('id').forUpdate()
      await assertPagesEditUnlocked(transaction, [43, 42, 43])
      await transaction('pages').whereIn('id', [42, 43]).update({ content: 'Bulk correction' })
    })
    await expect(Promise.resolve(mutate())).rejects.toMatchObject({ status: 409, name: 'PAGE_EDIT_LOCKED' })
    expect(await db('pages').orderBy('id').pluck('content')).toEqual(['Original source', 'Original source'])
    await set(false, '1', 'Explicit unlock for bulk correction')
    await mutate()
    expect(await db('pages').orderBy('id').pluck('content')).toEqual(['Bulk correction', 'Bulk correction'])
  })
  it('serializes policy changes behind an already committing page fence and refuses writes ordered after the lock', async () => {
    const held = await peer.transaction()
    try {
      await held('pages').where({ id: 42 }).forUpdate().first()
      await assertPageEditUnlocked(held, 42)
      await held('pages').where({ id: 42 }).update({ content: 'Writer committed first' })
      const locking = set(true, '0')
      let observed = false
      for (let attempt = 0; attempt < 200; attempt++) {
        const waiting = await peer.raw<{ rows: Array<{ waiting: boolean }> }>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%pages%for update%') AS waiting`)
        if (waiting.rows[0]?.waiting) { observed = true; break }
        // Real PostgreSQL lock-wait observation cannot be driven with JavaScript fake time.
        await Bun.sleep(5)
      }
      expect(observed).toBe(true)
      expect(await peer('pageEditLocks')).toHaveLength(0)
      await held.commit()
      await locking
    } finally { if (!held.isCompleted()) await held.rollback() }
    expect((await db('pages').where({ id: 42 }).first()).content).toBe('Writer committed first')
    await expect(Promise.resolve(db.transaction(async transaction => { await transaction('pages').where({ id: 42 }).forUpdate().first(); await assertPageEditUnlocked(transaction, 42); await transaction('pages').where({ id: 42 }).update({ content: 'Must not commit' }) }))).rejects.toMatchObject({ name: 'PAGE_EDIT_LOCKED' })
    expect((await db('pages').where({ id: 42 }).first()).content).toBe('Writer committed first')
  })
  it('retains stable policy identity and audit after deletion and never recovers policy from content history', async () => {
    await set(true, '0'); await set(false, '1', 'Explicit unlock before deletion')
    const policy = await db('pageEditLocks').first(), audit = await db('pageEditLockAudit').orderBy('lockVersion')
    await db('pages').where({ id: 42 }).delete()
    await db('pages').insert({ id: 42, path: 'recovered/new-destination', content: 'Recovered historical source' })
    expect(await db('pageEditLocks').first()).toEqual(policy)
    expect(await db('pageEditLockAudit').orderBy('lockVersion')).toEqual(audit)
    expect(await get()).toMatchObject({ isEditLocked: false, lockVersion: '2' })
  })
})
