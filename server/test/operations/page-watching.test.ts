
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

let knex: Knex
let page: { id: number; title: string; visibility: 'public'; ownerId: null; path: string; localeCode: string; tags: never[] }
let user: Express.User
const authorityFor = (requester: Express.User | undefined) => ({
  requester,
  permissions: requester?.permissions ?? [],
  groups: [],
  tagAliases: {}
})

beforeEach(async () => {
  user = { id: 7, email: 'reader@example.test', permissions: ['read:pages'], groups: [3] } as Express.User
  vi.resetModules()
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.string('title').notNullable()
    table.string('path').notNullable()
    table.string('localeCode').notNullable()
    table.string('visibility').notNullable()
    table.integer('ownerId').nullable()
  })
  await knex.schema.createTable('tags', table => {
    table.integer('id').primary()
    table.string('tag').notNullable()
  })
  await knex.schema.createTable('pageTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
  await knex.schema.createTable('pageWatchers', table => {
    table.integer('pageId').notNullable()
    table.integer('userId').notNullable()
    table.dateTime('createdAt').notNullable()
    table.boolean('emailEnabled').notNullable().defaultTo(true)
    table.boolean('inAppEnabled').notNullable().defaultTo(true)
    table.primary(['pageId', 'userId'])
  })
  await knex.schema.createTable('pageWatchNotifications', table => {
    table.string('id').primary()
    table.integer('userId').notNullable()
    table.integer('pageId').notNullable()
    table.string('eventType').notNullable()
    table.string('actorName').notNullable()
    table.string('title').notNullable()
    table.string('path').notNullable()
    table.string('localeCode').notNullable()
    table.string('visibility').notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('readAt').nullable()
  })
  page = { id: 42, title: 'Getting Started', visibility: 'public', ownerId: null, path: 'docs/start', localeCode: 'en', tags: [] }
  await knex('pages').insert({ id: page.id, title: page.title, path: page.path, localeCode: page.localeCode, visibility: page.visibility, ownerId: page.ownerId })
  Reflect.set(global, 'WIKI', {
    auth: {
      checkAccess: vi.fn((user: Express.User | undefined, permissions: readonly string[]) => permissions.includes('read:pages') && user?.permissions?.includes('read:pages')),
      checkPageAccess: vi.fn((user: Express.User | undefined, permissions: readonly string[], _context: unknown, authority: { requester: unknown; permissions: readonly string[] }) =>
        authority.requester === user && permissions.some(permission => authority.permissions.includes(permission))),
      loadPageRuleAuthority: vi.fn(async (requester: Express.User | undefined) => authorityFor(requester))
    },
    models: {
      knex,
      pages: { getPageFromDb: vi.fn(async (id: number) => id === page.id ? page : undefined) }
    }
  })
})

afterEach(async () => {
  await knex.destroy()
  vi.restoreAllMocks()
})

describe('page watching operations', () => {
  it('subscribes idempotently, reports state, and unsubscribes', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)

    await operations.watchPage({ requester: user, id: page.id })
    await operations.watchPage({ requester: user, id: page.id })

    expect(await knex('pageWatchers')).toHaveLength(1)
    expect(await operations.getPageWatchState({ requester: user, id: page.id })).toEqual({
      watched: true,
      emailEnabled: true,
      inAppEnabled: true
    })
    expect(await operations.unwatchPage({ requester: user, id: page.id })).toEqual({ watched: false })
    expect(await operations.getPageWatchState({ requester: user, id: page.id })).toEqual({
      watched: false,
      emailEnabled: false,
      inAppEnabled: false
    })
  })

  it('updates independent channels and owns notification read state', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    await operations.watchPage({ requester: user, id: page.id, emailEnabled: false, inAppEnabled: true })
    await knex('pageWatchNotifications').insert({
      id: 'notification-1',
      userId: 7,
      pageId: page.id,
      eventType: 'page.updated',
      actorName: 'Editor',
      title: 'Docs',
      path: page.path,
      localeCode: page.localeCode,
      visibility: page.visibility,
      createdAt: new Date(),
      readAt: null
    })

    expect(await operations.getPageWatchState({ requester: user, id: page.id })).toMatchObject({
      emailEnabled: false,
      inAppEnabled: true
    })
    expect(await operations.listPageWatchNotifications(user)).toMatchObject({ unreadCount: 1 })
    await operations.markPageWatchNotificationRead(user, 'notification-1')
    expect(await operations.listPageWatchNotifications(user)).toMatchObject({ unreadCount: 0 })
  })

  it('reauthorizes current page metadata, purges revoked rows, and leaves other users untouched', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    await knex('pageWatchers').insert([
      { pageId: page.id, userId: 7, createdAt: new Date(), emailEnabled: true, inAppEnabled: true },
      { pageId: page.id, userId: 8, createdAt: new Date(), emailEnabled: true, inAppEnabled: true },
      { pageId: 99, userId: 7, createdAt: new Date(), emailEnabled: true, inAppEnabled: true },
      { pageId: 99, userId: 8, createdAt: new Date(), emailEnabled: true, inAppEnabled: true }
    ])
    await knex('pages').where({ id: page.id }).update({ title: 'Current title', path: 'docs/current', localeCode: 'fr' })
    await knex('pageWatchNotifications').insert([
      {
        id: 'current-notification',
        userId: 7,
        pageId: page.id,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Stale title',
        path: 'docs/stale',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        readAt: null
      },
      {
        id: 'deleted-notification',
        userId: 7,
        pageId: 99,
        eventType: 'page.deleted',
        actorName: 'Editor',
        title: 'Deleted title',
        path: 'docs/deleted',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date('2025-12-31T00:00:00.000Z'),
        readAt: null
      },
      {
        id: 'other-user-notification',
        userId: 8,
        pageId: 99,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other user',
        path: 'docs/other',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date('2025-12-30T00:00:00.000Z'),
        readAt: null
      },
      {
        id: 'other-user-current-notification',
        userId: 8,
        pageId: page.id,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other user current',
        path: 'docs/current',
        localeCode: 'fr',
        visibility: 'public',
        createdAt: new Date('2025-12-29T00:00:00.000Z'),
        readAt: null
      }
    ])

    await expect(operations.listPageWatchNotifications(user)).resolves.toMatchObject({
      items: [expect.objectContaining({ title: 'Current title', path: 'docs/current', localeCode: 'fr', visibility: 'public' })],
      unreadCount: 1
    })
    expect(await knex('pageWatchNotifications').where({ userId: 7 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 8 })).toHaveLength(2)
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: page.id })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(0)
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 99 })).toHaveLength(1)
    const revokedUser = { ...user, permissions: [] } as Express.User
    await expect(operations.listPageWatchNotifications(revokedUser)).resolves.toEqual({ items: [], unreadCount: 0 })
    expect(await knex('pageWatchNotifications').where({ userId: 7 })).toHaveLength(0)
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: page.id })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7 })).toHaveLength(0)
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 8, pageId: page.id })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 99 })).toHaveLength(1)
  })

  it('rejects anonymous and permission-revoked subscriptions', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)

    await expect(Promise.resolve(operations.watchPage({ requester: undefined, id: page.id }))).rejects.toMatchObject({ status: 401 })
    await expect(Promise.resolve(operations.watchPage({ requester: { ...user, permissions: [] } as Express.User, id: page.id }))).rejects.toMatchObject({ status: 404 })
    expect(await knex('pageWatchers')).toEqual([])
  })
})
