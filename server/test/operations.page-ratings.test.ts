import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import { createApiPrincipal } from '../helpers/api-principal.ts'
import { getPostgresTestConnection } from './postgres-test-connection.mts'

const connection = getPostgresTestConnection('_page_ratings_test', import.meta.path)
const suite = connection ? describe : describe.skip
const originalWiki = Reflect.get(globalThis, 'WIKI')
const reader = { id: 7, authVersion: 0, email: 'reader@example.test', permissions: ['read:pages'] } as Express.User
const otherReader = { id: 8, authVersion: 0, email: 'other@example.test', permissions: ['read:pages'] } as Express.User
const pageFeatures = { schemaVersion: 1, linksVisible: false, ratingsAllowed: true, lastEditorVisible: false }

suite('native page ratings operations', () => {
  let db: Knex

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 12 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('path').notNullable()
      table.string('localeCode').notNullable()
      table.string('visibility').notNullable()
      table.integer('ownerId').nullable()
      table.jsonb('extra').notNullable()
    })
    await db.schema.createTable('tags', table => {
      table.increments('id')
      table.string('tag').notNullable()
    })
    await db.schema.createTable('pageTags', table => {
      table.integer('pageId').notNullable().references('pages.id').onDelete('CASCADE')
      table.integer('tagId').notNullable().references('tags.id').onDelete('CASCADE')
      table.primary(['pageId', 'tagId'])
    })
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.jsonb('value').notNullable()
      table.timestamp('updatedAt', { useTz: true }).notNullable()
    })
    await db.schema.createTable('pageAccessPasswords', table => {
      table.integer('pageId').primary().references('pages.id').onDelete('CASCADE')
      table.text('passwordHash').notNullable()
      table.integer('version').notNullable()
    })
    await db.schema.createTable('pageUnlockGrants', table => {
      table.uuid('id').primary()
      table.integer('pageId').notNullable().references('pages.id').onDelete('CASCADE')
      table.string('sessionId').notNullable()
      table.integer('userId').notNullable().references('users.id').onDelete('CASCADE')
      table.integer('passwordVersion').notNullable()
      table.timestamp('expiresAt', { useTz: true }).notNullable()
    })
    await db.schema.createTable('pageRatings', table => {
      table.integer('pageId').notNullable().references('pages.id').onDelete('CASCADE')
      table.integer('userId').notNullable().references('users.id').onDelete('CASCADE')
      table.string('kind').notNullable()
      table.integer('value').notNullable()
      table.timestamp('createdAt', { useTz: true }).notNullable()
      table.timestamp('updatedAt', { useTz: true }).notNullable()
      table.unique(['pageId', 'userId'])
      table.index(['pageId', 'kind'])
    })
  })

  afterAll(async () => {
    if (db) {
      for (const table of ['pageRatings', 'pageUnlockGrants', 'pageAccessPasswords', 'pageTags', 'tags', 'settings', 'pages', 'users']) {
        await db.schema.dropTableIfExists(table)
      }
      await db.destroy()
    }
    if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
    else Reflect.set(globalThis, 'WIKI', originalWiki)
  })

  beforeEach(async () => {
    for (const table of ['pageRatings', 'pageUnlockGrants', 'pageAccessPasswords', 'pageTags', 'tags', 'settings', 'pages', 'users']) await db(table).delete()
    await db('users').insert([
      { id: 2, isActive: true, authVersion: 0 },
      { id: 7, isActive: true, authVersion: 0 },
      { id: 8, isActive: true, authVersion: 0 },
      { id: 9, isActive: false, authVersion: 0 }
    ])
    await db('pages').insert({
      id: 42,
      path: 'docs/start',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null,
      extra: { pageFeatures }
    })
    await db('settings').insert({
      key: 'features',
      value: { featurePageRatings: true },
      updatedAt: new Date()
    })
    Reflect.set(globalThis, 'WIKI', {
      config: { db: { type: 'postgres' }, features: { featurePageRatings: true } },
      auth: {
        checkAccess: (requester: Express.User | undefined, permissions: readonly string[]) =>
          permissions.some(permission => (requester?.permissions as string[] | undefined)?.includes(permission)),
        checkPageAccess: (
          requester: Express.User | undefined,
          permissions: readonly string[],
          _page: unknown,
          authority: { requester: unknown; permissions: readonly string[] }
        ) => authority.requester === requester && permissions.some(permission => authority.permissions.includes(permission)),
        loadPageRuleAuthority: async (requester: Express.User | undefined) => ({
          requester,
          permissions: (requester?.permissions as string[] | undefined) ?? [],
          groups: [],
          tagAliases: {}
        })
      },
      models: { knex: db }
    })
  })

  it('serializes concurrent retries to one vote for each account and page', async () => {
    const operations = await vi.importFresh('../operations/page-ratings.ts', import.meta.url)
    const results = await Promise.all(Array.from({ length: 8 }, () => operations.putPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session', vote: { kind: 'thumbs', value: 1 } })))

    expect(await db('pageRatings').where({ pageId: 42, userId: 7 })).toHaveLength(1)
    expect(results.every(result => result.kind === 'thumbs' && result.count === 1 && result.ownVote === 1)).toBe(true)
    expect(await operations.getPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session' })).toMatchObject({
      kind: 'thumbs',
      count: 1,
      score: 1,
      distribution: { '-1': 0, '1': 1 },
      ownVote: 1
    })
  })

  it('replaces one account vote, aggregates distributions, and removes its contribution', async () => {
    const operations = await vi.importFresh('../operations/page-ratings.ts', import.meta.url)
    await operations.putPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session', vote: { kind: 'thumbs', value: -1 } })
    await operations.putPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session', vote: { kind: 'thumbs', value: 1 } })
    await operations.putPageRating({ requester: otherReader, pageId: 42, sessionId: 'other-session', vote: { kind: 'thumbs', value: 1 } })

    expect(await db('pageRatings').where({ pageId: 42 })).toHaveLength(2)
    expect(await operations.getPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session' })).toMatchObject({
      kind: 'thumbs',
      count: 2,
      score: 1,
      distribution: { '-1': 0, '1': 2 },
      ownVote: 1
    })
    expect(await operations.removePageRating({ requester: reader, pageId: 42, sessionId: 'reader-session' })).toMatchObject({
      count: 1,
      score: 1,
      distribution: { '-1': 0, '1': 1 },
      ownVote: null
    })
    expect(await operations.removePageRating({ requester: reader, pageId: 42, sessionId: 'reader-session' })).toMatchObject({ count: 1, ownVote: null })
  })

  it('keeps vote kinds distinct across mode changes until the account replaces its vote', async () => {
    const operations = await vi.importFresh('../operations/page-ratings.ts', import.meta.url)
    await db('settings').where('key', 'features').update({ value: { featurePageRatings: true, pageRatingsMode: 'stars' } })
    await operations.putPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session', vote: { kind: 'stars', value: 5 } })
    await operations.putPageRating({ requester: otherReader, pageId: 42, sessionId: 'other-session', vote: { kind: 'stars', value: 2 } })
    expect(await operations.getPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session' })).toMatchObject({
      kind: 'stars', count: 2, score: 3.5, distribution: { '1': 0, '2': 1, '3': 0, '4': 0, '5': 1 }, ownVote: 5
    })
    await db('settings').where('key', 'features').update({ value: { featurePageRatings: true, pageRatingsMode: 'thumbs' } })
    await expect(operations.putPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session', vote: { kind: 'stars', value: 4 } })).rejects.toMatchObject({ status: 409 })

    expect(await operations.getPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session' })).toMatchObject({
      kind: 'thumbs', count: 0, score: null, distribution: { '-1': 0, '1': 0 }, ownVote: null
    })
    await operations.putPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session', vote: { kind: 'thumbs', value: -1 } })
    expect(await db('pageRatings').where({ pageId: 42 })).toHaveLength(2)
    expect(await db('pageRatings').where({ pageId: 42, userId: 7 }).first()).toMatchObject({ kind: 'thumbs', value: -1 })
    expect(await operations.getPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session' })).toMatchObject({
      kind: 'thumbs', count: 1, score: -1, distribution: { '-1': 1, '1': 0 }, ownVote: -1
    })
  })

  it('rejects invalid, guest, API, inactive, stale, unreadable, and disabled requests', async () => {
    const operations = await vi.importFresh('../operations/page-ratings.ts', import.meta.url)
    await expect(operations.getPageRating({ requester: reader, pageId: 0 })).rejects.toMatchObject({ status: 400 })
    await expect(operations.putPageRating({ requester: reader, pageId: 42, vote: { kind: 'thumbs', value: 1, extra: true } })).rejects.toMatchObject({ status: 400 })
    const guest = { id: 2, authVersion: 0, permissions: ['read:pages'] } as Express.User
    await expect(operations.getPageRating({ requester: guest, pageId: 42 })).rejects.toMatchObject({ status: 401 })
    await expect(operations.putPageRating({ requester: guest, pageId: 42, vote: { kind: 'thumbs', value: 1 } })).rejects.toMatchObject({ status: 401 })
    await expect(operations.removePageRating({ requester: guest, pageId: 42 })).rejects.toMatchObject({ status: 401 })
    const api = createApiPrincipal(11, 3, ['read:pages'])
    await expect(operations.getPageRating({ requester: api, pageId: 42 })).rejects.toMatchObject({ status: 401 })
    await expect(operations.putPageRating({ requester: api, pageId: 42, vote: { kind: 'thumbs', value: 1 } })).rejects.toMatchObject({ status: 401 })
    await expect(operations.removePageRating({ requester: api, pageId: 42 })).rejects.toMatchObject({ status: 401 })
    await expect(operations.getPageRating({ requester: { ...reader, id: 9 } as Express.User, pageId: 42 })).rejects.toMatchObject({ status: 401 })
    await expect(operations.getPageRating({ requester: { ...reader, authVersion: 1 } as Express.User, pageId: 42 })).rejects.toMatchObject({ status: 401 })
    await expect(operations.getPageRating({ requester: { ...reader, permissions: [] } as Express.User, pageId: 42 })).rejects.toMatchObject({ status: 404 })

    await db('settings').where('key', 'features').update({ value: { featurePageRatings: false } })
    await expect(operations.getPageRating({ requester: reader, pageId: 42 })).rejects.toMatchObject({ status: 403 })
    await expect(operations.putPageRating({ requester: reader, pageId: 42, vote: { kind: 'thumbs', value: 1 } })).rejects.toMatchObject({ status: 403 })
    await db('settings').where('key', 'features').update({ value: { featurePageRatings: true } })
    await db('pages').where({ id: 42 }).update({ extra: { pageFeatures: { ...pageFeatures, ratingsAllowed: false } } })
    await expect(operations.getPageRating({ requester: reader, pageId: 42 })).rejects.toMatchObject({ status: 403 })
    await expect(operations.putPageRating({ requester: reader, pageId: 42, vote: { kind: 'thumbs', value: 1 } })).rejects.toMatchObject({ status: 403 })
    expect(await db('pageRatings')).toHaveLength(0)
  })

  it('requires a current page unlock before exposing or changing ratings', async () => {
    const operations = await vi.importFresh('../operations/page-ratings.ts', import.meta.url)
    await db('pageAccessPasswords').insert({ pageId: 42, passwordHash: 'not-used', version: 3 })
    await expect(operations.getPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session' })).rejects.toMatchObject({
      status: 403,
      name: 'PAGE_LOCKED'
    })
    await db('pageUnlockGrants').insert({
      id: 'a5c2724a-e008-4af9-8fe7-a1dff98371c2',
      pageId: 42,
      sessionId: 'reader-session',
      userId: 7,
      passwordVersion: 3,
      expiresAt: new Date(Date.now() + 60_000)
    })
    await expect(operations.putPageRating({ requester: reader, pageId: 42, sessionId: 'reader-session', vote: { kind: 'thumbs', value: 1 } })).resolves.toMatchObject({ count: 1, ownVote: 1 })
  })
})
