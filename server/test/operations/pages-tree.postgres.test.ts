import knexModule, { type Knex } from 'knex'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import type pagesOperations from '../../operations/pages.ts'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from '../bun-test.mts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? '', password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection = database.endsWith('_page_tree_test') && password
  ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432), user: 'wiki', database, password } : null
const suite = connection ? describe : describe.skip
suite('PostgreSQL Browse page access', () => {
  let db: Knex, operations: typeof pagesOperations
  const originalWiki = globalThis.WIKI
  const requester = { id: 3 } as Express.User
  let readPaths: Set<string>, writePaths: Set<string>, readTags: Set<string>
  const tables = ['pageTags', 'tags', 'pageTree', 'pages', 'userGroups', 'groups']
  const syncAuthority = async () => {
    const pageRules = [
      ...[...readPaths].map(path => ({ match: 'EXACT', path, deny: false, roles: ['read:pages'], locales: ['en'] })),
      ...[...writePaths].map(path => ({ match: 'EXACT', path, deny: false, roles: ['write:pages'], locales: ['en'] })),
      ...[...readTags].map(path => ({ match: 'TAG', path, deny: false, roles: ['read:pages'], locales: ['en'] }))
    ]
    await db('groups').where('id', 1).update({
      permissions: JSON.stringify(['read:pages', 'write:pages']),
      pageRules: JSON.stringify(pageRules)
    })
  }
  const tree = async (extra = {}) => {
    await syncAuthority()
    return operations.getTree({ requester, locale: 'en', mode: 'ALL', parent: 0, ...extra })
  }
  const seed = async (id: number, path: string, options: Record<string, unknown> = {}) => {
    const { parent = null, ancestors = [], folder = false, page = true, tag, ...pageOptions } = options
    const identity = { path, localeCode: 'en', visibility: 'public', ownerId: null, ...pageOptions }
    if (page) await db('pages').insert({ id, title: `Private title ${id}`, isPublished: true, ...identity })
    await db('pageTree').insert({ id, ...identity, title: `Private title ${id}`, parent, ancestors: JSON.stringify(ancestors), isFolder: folder, pageId: page ? id : null })
    if (tag) {
      await db('tags').insert({ id, tag })
      await db('pageTags').insert({ pageId: id, tagId: id })
    }
  }
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    await db.schema.createTable('pages', t => {
      t.integer('id').primary(); t.string('path'); t.string('title'); t.string('localeCode'); t.string('visibility'); t.integer('ownerId')
      t.boolean('isPublished'); t.string('publishStartDate'); t.string('publishEndDate')
    })
    await db.schema.createTable('pageTree', t => {
      t.integer('id').primary(); t.string('path'); t.string('title'); t.string('localeCode'); t.string('visibility'); t.integer('ownerId')
      t.integer('parent'); t.integer('pageId'); t.boolean('isFolder'); t.json('ancestors')
    })
    await db.schema.createTable('groups', t => {
      t.integer('id').primary(); t.string('name'); t.jsonb('permissions'); t.jsonb('pageRules')
    })
    await db.schema.createTable('userGroups', t => {
      t.integer('userId'); t.integer('groupId')
    })
    await db.schema.createTable('tags', t => {
      t.integer('id').primary(); t.string('tag'); t.integer('redirectToId'); t.boolean('isArchived').notNullable().defaultTo(false)
    })
    await db.schema.createTable('pageTags', t => { t.integer('pageId'); t.integer('tagId') })
    await db('groups').insert({
      id: 1,
      name: 'Navigation readers',
      permissions: JSON.stringify(['read:pages', 'write:pages']),
      pageRules: JSON.stringify([])
    })
    await db('userGroups').insert({ userId: 3, groupId: 1 })
    globalThis.WIKI = {
      config: { db: { type: 'postgres' } },
      configSvc: {},
      events: {},
      lang: {},
      logger: {},
      startedAt: {},
      models: { knex: db },
      auth: { checkAccess: auth.checkAccess, checkPageAccess: auth.checkPageAccess, loadPageRuleAuthority }
    } as never
    operations = (await vi.importFresh('../../operations/pages.ts', import.meta.url)).default
  })
  afterAll(async () => {
    globalThis.WIKI = originalWiki
    if (db) { for (const table of tables) await db.schema.dropTableIfExists(table); await db.destroy() }
  })
  beforeEach(async () => {
    for (const table of ['pageTags', 'tags', 'pageTree', 'pages']) await db(table).delete()
    readPaths = new Set(); writePaths = new Set(); readTags = new Set()
  })
  it('omits denied page metadata and only includes the current principal’s private pages', async () => {
    await seed(1, 'allowed'); await seed(2, 'denied')
    await seed(3, 'mine', { visibility: 'private', ownerId: 3 })
    await seed(4, 'theirs', { visibility: 'private', ownerId: 4 })
    readPaths.add('allowed')
    const rows = await tree()
    expect(rows.map(row => row.path).sort()).toEqual(['allowed', 'mine'])
    expect(rows.find(row => row.path === 'mine')?.canEdit).toBe(true)
    expect(rows.find(row => row.path === 'allowed')?.canEdit).toBe(false)
    expect(JSON.stringify(rows)).not.toContain('Private title 2')
    expect(await tree({ path: 'denied', parent: undefined })).toEqual([])
  })
  it('uses persisted page rules for authorized roots and ancestors without leaking denied metadata', async () => {
    await seed(1, 'authorized', { folder: true })
    await seed(2, 'authorized/hidden', { folder: true, parent: 1, ancestors: [1] })
    await seed(3, 'authorized/hidden/guide', { parent: 2, ancestors: [1, 2] })
    await seed(4, 'denied')
    readPaths.add('authorized'); readPaths.add('authorized/hidden/guide')
    const root = await tree()
    expect(root.map(row => row.path)).toEqual(['authorized'])
    expect(root[0]).toMatchObject({ id: 1, title: 'Private title 1', pageId: 1, isFolder: true })
    expect(JSON.stringify(root)).not.toContain('Private title 4')
    const expanded = await tree({ path: 'authorized/hidden/guide', parent: undefined, includeAncestors: true })
    expect(expanded.map(row => row.id).sort()).toEqual([1, 2, 3])
    expect(expanded.find(row => row.id === 1)).toMatchObject({ title: 'Private title 1', pageId: 1 })
    expect(expanded.find(row => row.id === 2)).toMatchObject({
      path: 'authorized/hidden', title: 'hidden', pageId: null, canEdit: false, isFolder: true
    })
    expect(expanded.find(row => row.id === 3)).toMatchObject({ title: 'Private title 3', pageId: 3 })
    expect(JSON.stringify(expanded)).not.toContain('Private title 2')
  })
  it('keeps folders for exact-path and tag-only grants without leaking denied hybrid page details', async () => {
    await seed(1, 'restricted', { folder: true })
    await seed(2, 'restricted/deep', { folder: true, page: false, parent: 1, ancestors: [1] })
    await seed(3, 'restricted/deep/guide', { parent: 2, ancestors: [1, 2], tag: 'reader' })
    await seed(4, 'closed', { folder: true }); await seed(5, 'closed/secret', { parent: 4, ancestors: [4] })
    readTags.add('reader')
    const root = await tree()
    expect(root).toHaveLength(1)
    expect(root[0]).toMatchObject({ id: 1, title: 'restricted', pageId: null, canEdit: false, isFolder: true })
    expect(await tree({ mode: 'PAGES' })).toEqual([])
    expect((await tree({ mode: 'FOLDERS' })).map(row => row.id)).toEqual([1])
    expect((await tree({ parent: 2 })).map(row => row.id)).toEqual([3])
    expect((await tree({ path: 'restricted/deep/guide', parent: undefined, includeAncestors: true })).map(row => row.id).sort()).toEqual([1, 2, 3])
    readTags.clear(); readPaths.add('restricted/deep/guide')
    expect((await tree()).map(row => row.id)).toEqual([1])
    readPaths.clear()
    expect(await tree()).toEqual([])
  })
  it('respects draft and publication windows while allowing authorized writer selection', async () => {
    for (const [id, path] of [[1, 'draft'], [2, 'future'], [3, 'expired'], [4, 'published']] as const) { await seed(id, path); readPaths.add(path) }
    await db('pages').where('id', 1).update('isPublished', false)
    await db('pages').where('id', 2).update('publishStartDate', '2099-01-01T00:00:00Z')
    await db('pages').where('id', 3).update('publishEndDate', '2000-01-01T00:00:00Z')
    expect((await tree()).map(row => row.path)).toEqual(['published'])
    writePaths.add('draft'); writePaths.add('future'); writePaths.add('expired')
    expect(await tree()).toHaveLength(4)
    expect((await tree()).filter(row => row.canEdit)).toHaveLength(3)
  })
  it('keeps ancestor OR conditions inside locale, mode and ownership boundaries', async () => {
    await seed(1, 'foreign', { localeCode: 'fr', visibility: 'private', ownerId: 4, folder: true })
    await seed(2, 'folder', { page: false, folder: true })
    await seed(3, 'folder/allowed', { parent: 2, ancestors: [1, 2] })
    readPaths.add('folder/allowed')
    const rows = await tree({ path: 'folder/allowed', parent: undefined, includeAncestors: true })
    expect(rows.map(row => row.id).sort()).toEqual([2, 3])
    expect((await tree({ path: 'folder/allowed', parent: undefined, includeAncestors: true, mode: 'PAGES' })).map(row => row.id)).toEqual([3])
  })
  it('ignores stale tree entries after a path, ownership or visibility change', async () => {
    await seed(1, 'moved'); await seed(2, 'privatized'); await seed(3, 'transferred', { visibility: 'private', ownerId: 3 })
    readPaths.add('moved'); readPaths.add('privatized')
    await db('pages').where('id', 1).update('path', 'new-path')
    await db('pages').where('id', 2).update({ visibility: 'private', ownerId: 4 })
    await db('pages').where('id', 3).update('ownerId', 4)
    expect(await tree()).toEqual([])
  })
  it('expands the right tree when public and personal pages share a path', async () => {
    await seed(1, 'shared', { folder: true, page: false })
    await seed(2, 'shared/page', { parent: 1, ancestors: [1] })
    await seed(3, 'shared', { visibility: 'private', ownerId: 3, folder: true, page: false })
    await seed(4, 'shared/page', { visibility: 'private', ownerId: 3, parent: 3, ancestors: [3] })
    readPaths.add('shared/page')
    expect((await tree({ path: 'shared/page', parent: undefined, visibility: 'public', includeAncestors: true })).map(row => row.id)).toEqual([1, 2])
    expect((await tree({ path: 'shared/page', parent: undefined, visibility: 'private', includeAncestors: true })).map(row => row.id)).toEqual([3, 4])
  })
  it('continues through bounded metadata batches without truncating a later authorized page', async () => {
    const pages = Array.from({ length: 1002 }, (_, index) => ({ id: index + 1, path: `page-${index + 1}`, localeCode: 'en', visibility: 'public', ownerId: null, title: 'Hidden title', isPublished: true }))
    await db.batchInsert('pages', pages, 250)
    await db.batchInsert('pageTree', pages.map(({ isPublished: _, ...page }) => ({ ...page, pageId: page.id, isFolder: false, ancestors: '[]' })), 250)
    readPaths.add('page-1002')
    expect((await tree()).map(row => row.id)).toEqual([1002])
  })
})
