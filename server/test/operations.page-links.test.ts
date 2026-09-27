import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import { getPageLinks } from '../operations/page-links.ts'

const requester = { id: 7 } as Express.User

const addPage = async (
  db: Knex,
  id: number,
  path: string,
  overrides: Partial<{
    localeCode: string
    title: string
    visibility: 'public' | 'private'
    ownerId: number | null
    sourceRevision: number
    isPublished: boolean
    isSearchable: boolean
    publishStartDate: Date | null
    publishEndDate: Date | null
  }> = {}
): Promise<void> => {
  await db('pages').insert({
    id,
    path,
    localeCode: 'en',
    title: `Page ${id}`,
    visibility: 'public',
    ownerId: null,
    sourceRevision: 1,
    isPublished: true,
    isSearchable: true,
    publishStartDate: null,
    publishEndDate: null,
    ...overrides
  })
}

const addLink = async (db: Knex, pageId: number, path: string, localeCode = 'en'): Promise<void> => {
  await db('pageLinks').insert({ pageId, path, localeCode })
}

const addReceipt = async (db: Knex, pageId: number, revision: number): Promise<void> => {
  await db('pageMutationOutbox').insert({
    pageId,
    sourceRevision: revision,
    effectKind: 'links',
    desiredState: 'present',
    status: 'succeeded'
  })
}

describe('page links operation', () => {
  let db: Knex
  let previousWiki: unknown

  beforeEach(async () => {
    previousWiki = Reflect.get(globalThis, 'WIKI')
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('path').notNullable()
      table.string('localeCode').notNullable()
      table.string('title').notNullable()
      table.string('visibility').notNullable()
      table.integer('ownerId').nullable()
      table.bigInteger('sourceRevision').notNullable()
      table.boolean('isPublished').notNullable()
      table.boolean('isSearchable').notNullable()
      table.dateTime('publishStartDate').nullable()
      table.dateTime('publishEndDate').nullable()
    })
    await db.schema.createTable('pageTags', table => {
      table.integer('pageId').notNullable()
      table.integer('tagId').notNullable()
    })
    await db.schema.createTable('tags', table => {
      table.integer('id').primary()
      table.string('tag').notNullable()
    })
    await db.schema.createTable('pageLinks', table => {
      table.increments('id').primary()
      table.integer('pageId').notNullable()
      table.string('localeCode').notNullable()
      table.string('path').notNullable()
      table.index(['path', 'localeCode'])
    })
    await db.schema.createTable('pageAccessPasswords', table => {
      table.integer('pageId').primary()
    })
    await db.schema.createTable('pageMutationOutbox', table => {
      table.increments('id').primary()
      table.integer('pageId').notNullable()
      table.bigInteger('sourceRevision').notNullable()
      table.string('effectKind').notNullable()
      table.string('desiredState').notNullable()
      table.string('status').notNullable()
    })
    const auth = {
      checkAccess: vi.fn(() => false),
      checkPageAccess: vi.fn((_user: Express.User | undefined, _permissions: readonly string[], context: { path: string }) => !context.path.startsWith('restricted')),
      loadPageRuleAuthority: vi.fn(async user => ({
        requester: user,
        permissions: ['read:pages'],
        groups: [],
        tagAliases: {}
      }) as unknown as PageRuleAuthority)
    }
    Reflect.set(globalThis, 'WIKI', { models: { knex: db }, config: { sessionSecret: 'test-only page links signing key' }, auth })
  })

  afterEach(async () => {
    await db.destroy()
    if (previousWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
    else Reflect.set(globalThis, 'WIKI', previousWiki)
  })

  it('paginates only authorized live endpoints and bases hasMore on an authorized lookahead', async () => {
    await addPage(db, 1, 'source', { sourceRevision: 3 })
    await addReceipt(db, 1, 3)
    for (let id = 2; id <= 21; id += 1) await addPage(db, id, `target-${id}`)
    await addPage(db, 22, 'restricted-before-next')
    await addPage(db, 23, 'private-target', { visibility: 'private', ownerId: 9 })
    await addPage(db, 24, 'draft-target', { isPublished: false })
    await addPage(db, 25, 'unsearchable-target', { isSearchable: false })
    await addPage(db, 26, 'locked-target')
    await db('pageAccessPasswords').insert({ pageId: 26 })
    await addPage(db, 27, 'restricted-after-lock')
    await addPage(db, 28, 'target-after-hidden-neighbors')
    for (let id = 2; id <= 28; id += 1) {
      const page = await db('pages').where({ id }).first('path')
      await addLink(db, 1, String(page.path))
    }
    await addLink(db, 1, 'target-2')
    await addLink(db, 1, 'missing-target')

    const first = await getPageLinks({ pageId: 1, direction: 'outgoing', requester })
    expect(first).toMatchObject({
      state: 'ready',
      pageId: 1,
      direction: 'outgoing',
      sourceRevision: '3',
      hasMore: true
    })
    if (first.state !== 'ready') throw new Error('Expected a ready link page')
    expect(first.items.map(item => item.id)).toEqual(Array.from({ length: 20 }, (_value, index) => index + 2))
    expect(JSON.stringify(first)).not.toContain('restricted-before-next')
    expect(JSON.stringify(first)).not.toContain('private-target')
    expect(JSON.stringify(first)).not.toContain('draft-target')
    expect(JSON.stringify(first)).not.toContain('locked-target')
    expect(JSON.stringify(first)).not.toContain('missing-target')

    const second = await getPageLinks({ pageId: 1, direction: 'outgoing', cursor: first.nextCursor!, requester })
    expect(second).toMatchObject({ state: 'ready', hasMore: false, nextCursor: null })
    if (second.state !== 'ready') throw new Error('Expected a ready link page')
    expect(second.items.map(item => item.id)).toEqual([28])
    await expect(getPageLinks({ pageId: 1, direction: 'incoming', cursor: first.nextCursor!, requester })).rejects.toMatchObject({ status: 400 })
    await expect(getPageLinks({ pageId: 1, direction: 'outgoing', cursor: `${first.nextCursor}x`, requester })).rejects.toMatchObject({ status: 400 })

    await db('pages').where({ id: 1 }).update({ sourceRevision: 4 })
    const staleCursor = await getPageLinks({ pageId: 1, direction: 'outgoing', cursor: first.nextCursor!, requester })
    expect(staleCursor).toEqual({ schemaVersion: 1, state: 'refresh', pageId: 1, direction: 'outgoing', sourceRevision: '4' })
  })

  it('uses current source receipts for incoming edges and refreshes without partial stale metadata', async () => {
    await addPage(db, 100, 'root', { sourceRevision: 9 })
    await addPage(db, 101, 'current-incoming', { sourceRevision: 4 })
    await addLink(db, 101, 'root')
    await addReceipt(db, 101, 4)
    await addPage(db, 102, 'private-stale-incoming', { visibility: 'private', ownerId: 8 })
    await addLink(db, 102, 'root')

    const current = await getPageLinks({ pageId: 100, direction: 'incoming', requester })
    expect(current).toMatchObject({ state: 'ready', sourceRevision: '9', hasMore: false })
    if (current.state !== 'ready') throw new Error('Expected current incoming links')
    expect(current.items.map(item => item.id)).toEqual([101])

    await addPage(db, 103, 'stale-public-incoming', { sourceRevision: 5 })
    await addLink(db, 103, 'root')
    await addReceipt(db, 103, 4)
    const stale = await getPageLinks({ pageId: 100, direction: 'incoming', requester })
    expect(stale).toEqual({ schemaVersion: 1, state: 'refresh', pageId: 100, direction: 'incoming', sourceRevision: '9' })
    expect(Object.hasOwn(stale, 'items')).toBe(false)
  })

  it('returns refresh rather than an empty graph when the requested page lacks its current link receipt', async () => {
    await addPage(db, 200, 'not-yet-indexed')
    await addPage(db, 201, 'would-be-target')
    await addLink(db, 200, 'would-be-target')

    const result = await getPageLinks({ pageId: 200, direction: 'outgoing', requester })
    expect(result).toEqual({ schemaVersion: 1, state: 'refresh', pageId: 200, direction: 'outgoing', sourceRevision: '1' })
  })
})
