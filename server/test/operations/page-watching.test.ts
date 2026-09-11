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
const notificationRow = (
  id: string,
  {
    userId = user.id,
    pageId = page.id,
    createdAt = new Date('2026-01-01T00:00:00.000Z'),
    readAt = null
  }: { userId?: number; pageId?: number; createdAt?: Date | string | number; readAt?: Date | string | null } = {}
) => ({
  id,
  userId,
  pageId,
  eventType: 'page.updated',
  actorName: 'Editor',
  title: page.title,
  path: page.path,
  localeCode: page.localeCode,
  visibility: page.visibility,
  createdAt,
  readAt
})
const insertNotifications = async (rows: readonly Record<string, unknown>[]): Promise<void> => {
  for (let offset = 0; offset < rows.length; offset += 100) await knex('pageWatchNotifications').insert(rows.slice(offset, offset + 100))
}

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
  await knex('pages').insert({
    id: page.id,
    title: page.title,
    path: page.path,
    localeCode: page.localeCode,
    visibility: page.visibility,
    ownerId: page.ownerId
  })
  Reflect.set(global, 'WIKI', {
    auth: {
      checkAccess: vi.fn(
        (user: Express.User | undefined, permissions: readonly string[]) => permissions.includes('read:pages') && user?.permissions?.includes('read:pages')
      ),
      checkPageAccess: vi.fn(
        (
          user: Express.User | undefined,
          permissions: readonly string[],
          _context: unknown,
          authority: { requester: unknown; permissions: readonly string[] }
        ) => authority.requester === user && permissions.some(permission => authority.permissions.includes(permission))
      ),
      loadPageRuleAuthority: vi.fn(async (requester: Express.User | undefined) => authorityFor(requester))
    },
    models: {
      knex,
      pages: { getPageFromDb: vi.fn(async (id: number) => (id === page.id ? page : undefined)) }
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

  it('prioritizes unread notifications before capping and keeps newest order stable', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    const notification = (id: string, createdAt: Date, readAt: Date | null) => ({
      id,
      userId: user.id,
      pageId: page.id,
      eventType: 'page.updated',
      actorName: 'Editor',
      title: page.title,
      path: page.path,
      localeCode: page.localeCode,
      visibility: page.visibility,
      createdAt,
      readAt
    })
    const newestReadDate = new Date('2026-02-20T00:00:00.000Z')
    const readNotifications = Array.from({ length: 51 }, (_, index) =>
      notification(
        `read-${String(index).padStart(2, '0')}`,
        index >= 49 ? new Date(newestReadDate) : new Date(Date.UTC(2026, 0, index + 2)),
        new Date('2026-02-21T00:00:00.000Z')
      )
    )

    await knex('pageWatchNotifications').insert([
      notification('unread-new', new Date('2026-01-01T00:00:00.000Z'), null),
      notification('unread-old', new Date('2025-12-31T00:00:00.000Z'), null),
      ...readNotifications
    ])

    const listed = await operations.listPageWatchNotifications(user)
    expect(listed).toMatchObject({ ownerId: 7, unreadCount: 2 })
    expect(listed.items.map(item => item.id)).toEqual([
      'unread-new',
      'unread-old',
      ...Array.from({ length: 48 }, (_, offset) => `read-${String(50 - offset).padStart(2, '0')}`)
    ])
    expect(listed.items.slice(0, 2).every(item => item.readAt === null)).toBe(true)
    expect(listed.items.slice(2).every(item => item.readAt !== null)).toBe(true)
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
    await expect(operations.listPageWatchNotifications(revokedUser)).resolves.toEqual({
      ownerId: 7,
      items: [],
      unreadCount: 0,
      nextCursor: null,
      unreadComplete: true
    })
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
    await expect(Promise.resolve(operations.watchPage({ requester: { ...user, permissions: [] } as Express.User, id: page.id }))).rejects.toMatchObject({
      status: 404
    })
    expect(await knex('pageWatchers')).toEqual([])
  })
  it('caps shared inspected candidates at 500 and resumes rejected rows', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    await knex('pageWatchers').insert([
      { pageId: 99, userId: 7, createdAt: new Date(), emailEnabled: true, inAppEnabled: true },
      { pageId: 99, userId: 8, createdAt: new Date(), emailEnabled: true, inAppEnabled: true }
    ])
    await insertNotifications(
      Array.from({ length: 501 }, (_, index) =>
        notificationRow(`rejected-${String(index).padStart(3, '0')}`, {
          pageId: 99,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index))
        })
      )
    )

    let projectionQueries = 0
    knex.on('query', (query: { sql?: string }) => {
      if (typeof query.sql === 'string' && query.sql.toLowerCase().includes('select * from `pages`')) projectionQueries += 1
    })

    const first = await operations.listPageWatchNotifications(user)
    const firstCursor = first.nextCursor
    expect(first).toMatchObject({ ownerId: 7, items: [], unreadCount: 0, nextCursor: expect.any(String), unreadComplete: false })
    expect(projectionQueries).toBe(10)
    expect(await knex('pageWatchNotifications').where({ userId: 7 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(0)
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 99 })).toHaveLength(1)

    const second = await operations.listPageWatchNotifications(user, firstCursor)
    expect(second).toEqual({ ownerId: 7, items: [], unreadCount: 0, nextCursor: null, unreadComplete: true })
    expect(await knex('pageWatchNotifications').where({ userId: 7 })).toHaveLength(0)
  })

  it('shares the 500-candidate budget across unread and read phases', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    await knex('pageWatchers').insert({ pageId: 99, userId: 7, createdAt: new Date(), emailEnabled: true, inAppEnabled: true })
    await insertNotifications([
      ...Array.from({ length: 300 }, (_, index) =>
        notificationRow(`unread-rejected-${String(index).padStart(3, '0')}`, {
          pageId: 99,
          createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)),
          readAt: null
        })
      ),
      ...Array.from({ length: 300 }, (_, index) =>
        notificationRow(`read-rejected-${String(index).padStart(3, '0')}`, {
          pageId: 99,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
          readAt: new Date('2026-02-01T00:00:00.000Z')
        })
      )
    ])
    const first = await operations.listPageWatchNotifications(user)
    const firstCursor = first.nextCursor
    expect(first).toMatchObject({ ownerId: 7, items: [], unreadCount: 0, nextCursor: expect.any(String), unreadComplete: true })
    expect(await knex('pageWatchNotifications').where({ userId: 7 })).toHaveLength(100)
    expect(await knex('pageWatchNotifications').where({ userId: 7 }).whereNotNull('readAt')).toHaveLength(100)
    expect(firstCursor).not.toBeNull()
    const second = await operations.listPageWatchNotifications(user, firstCursor)

    expect(second).toEqual({ ownerId: 7, items: [], unreadCount: 0, nextCursor: null, unreadComplete: true })
    expect(await knex('pageWatchNotifications').where({ userId: 7 })).toHaveLength(0)
  })

  it('continues unread rows before reaching the read phase', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    await knex('pageWatchNotifications').insert([
      ...Array.from({ length: 55 }, (_, index) =>
        notificationRow(`unread-${String(index).padStart(3, '0')}`, {
          createdAt: new Date(Date.UTC(2026, 2, 1, 0, 0, index)),
          readAt: null
        })
      ),
      notificationRow('read-after-unread', {
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        readAt: new Date('2026-03-02T00:00:00.000Z')
      })
    ])

    const first = await operations.listPageWatchNotifications(user)
    const firstCursor = first.nextCursor
    expect(first.items).toHaveLength(50)
    expect(first.items.every(item => item.readAt === null)).toBe(true)
    expect(first.unreadCount).toBe(50)
    expect(first.unreadComplete).toBe(false)
    expect(firstCursor).toEqual(expect.any(String))

    const second = await operations.listPageWatchNotifications(user, firstCursor)
    expect(second.items.map(item => item.id)).toEqual(['unread-004', 'unread-003', 'unread-002', 'unread-001', 'unread-000', 'read-after-unread'])
    expect(second.unreadCount).toBe(5)
    expect(second.unreadComplete).toBe(true)
    expect(second.nextCursor).toBeNull()
  })

  it('resumes strictly after a tied boundary inside a fetched batch', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    const tiedAt = new Date('2026-04-01T00:00:00.000Z')
    await knex('pageWatchNotifications').insert([
      notificationRow('unread-only', { createdAt: tiedAt, readAt: null }),
      ...Array.from({ length: 99 }, (_, index) =>
        notificationRow(`read-${String(index + 1).padStart(3, '0')}`, {
          createdAt: tiedAt,
          readAt: new Date('2026-04-02T00:00:00.000Z')
        })
      )
    ])

    const first = await operations.listPageWatchNotifications(user)
    const firstCursor = first.nextCursor
    expect(first.items).toHaveLength(50)
    expect(first.items.slice(0, 1).map(item => item.id)).toEqual(['unread-only'])
    expect(first.items.slice(1).map(item => item.id)).toEqual(Array.from({ length: 49 }, (_, index) => `read-${String(99 - index).padStart(3, '0')}`))
    expect(first.unreadComplete).toBe(true)
    expect(firstCursor).toEqual(expect.any(String))

    const second = await operations.listPageWatchNotifications(user, firstCursor)
    const secondCursor = second.nextCursor
    expect(second.items.map(item => item.id)).toEqual(Array.from({ length: 50 }, (_, index) => `read-${String(50 - index).padStart(3, '0')}`))
    expect(second.items.some(item => first.items.some(previous => previous.id === item.id))).toBe(false)
    expect(second.unreadComplete).toBe(true)
    expect(secondCursor).toEqual(expect.any(String))

    const third = await operations.listPageWatchNotifications(user, secondCursor)
    expect(third).toEqual({ ownerId: 7, items: [], unreadCount: 0, nextCursor: null, unreadComplete: true })
  })

  it('purges only inspected rejected notifications and watcher keys for the owner', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    await knex('pageWatchers').insert([
      { pageId: 99, userId: 7, createdAt: new Date(), emailEnabled: true, inAppEnabled: true },
      { pageId: 98, userId: 7, createdAt: new Date(), emailEnabled: true, inAppEnabled: true },
      { pageId: 99, userId: 8, createdAt: new Date(), emailEnabled: true, inAppEnabled: true }
    ])
    await knex('pageWatchNotifications').insert([
      ...Array.from({ length: 49 }, (_, index) =>
        notificationRow(`unread-visible-${String(index).padStart(3, '0')}`, {
          createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, index)),
          readAt: null
        })
      ),
      notificationRow('rejected-inspected', {
        pageId: 99,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
        readAt: new Date('2026-06-03T00:00:00.000Z')
      }),
      notificationRow('read-visible', {
        pageId: page.id,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        readAt: new Date('2026-06-03T00:00:00.000Z')
      }),
      notificationRow('rejected-uninspected', {
        pageId: 99,
        createdAt: new Date('2026-05-31T00:00:00.000Z'),
        readAt: new Date('2026-06-03T00:00:00.000Z')
      }),
      notificationRow('other-page-uninspected', {
        pageId: 98,
        createdAt: new Date('2026-05-30T00:00:00.000Z'),
        readAt: new Date('2026-06-03T00:00:00.000Z')
      }),
      notificationRow('other-owner-rejected', {
        userId: 8,
        pageId: 99,
        createdAt: new Date('2026-05-29T00:00:00.000Z'),
        readAt: null
      })
    ])

    const listed = await operations.listPageWatchNotifications(user)
    expect(listed.items).toHaveLength(50)
    expect(listed.items.some(item => item.id === 'read-visible')).toBe(true)
    expect(await knex('pageWatchNotifications').where({ userId: 7, id: 'rejected-inspected' })).toHaveLength(0)
    expect(await knex('pageWatchNotifications').where({ userId: 7, id: 'rejected-uninspected' })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, id: 'other-page-uninspected' })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 8, id: 'other-owner-rejected' })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(0)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 98 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 99 })).toHaveLength(1)
  })

  it('rejects malformed, expired, and foreign cursors uniformly while allowing permission changes', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    await knex('pageWatchNotifications').insert(
      Array.from({ length: 51 }, (_, index) =>
        notificationRow(`cursor-${String(index).padStart(3, '0')}`, {
          createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)),
          readAt: null
        })
      )
    )
    const first = await operations.listPageWatchNotifications(user)
    if (first.nextCursor === null) throw new Error('Expected a watch continuation cursor')
    const firstCursor = first.nextCursor

    await expect(operations.listPageWatchNotifications(user, 'not-a-cursor')).rejects.toMatchObject({
      status: 409,
      name: 'WATCH_CURSOR_EXPIRED'
    })
    await expect(operations.listPageWatchNotifications({ ...user, id: 8 } as Express.User, firstCursor)).rejects.toMatchObject({
      status: 409,
      name: 'WATCH_CURSOR_EXPIRED'
    })

    const revoked = { ...user, permissions: [] } as Express.User
    await expect(operations.listPageWatchNotifications(revoked, firstCursor)).resolves.toMatchObject({
      ownerId: 7,
      items: [],
      nextCursor: null,
      unreadComplete: true
    })

    const now = Date.now()
    vi.setSystemTime(now + 5 * 60 * 1_000 + 1)
    try {
      await expect(operations.listPageWatchNotifications(user, firstCursor)).rejects.toMatchObject({
        status: 409,
        name: 'WATCH_CURSOR_EXPIRED'
      })
    } finally {
      vi.setSystemTime(now)
    }
  })

  it('reuses an equivalent live cursor without extending its lifetime', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    await knex('pageWatchNotifications').insert(
      Array.from({ length: 51 }, (_, index) =>
        notificationRow(`equivalent-${String(index).padStart(3, '0')}`, {
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index))
        })
      )
    )
    const first = await operations.listPageWatchNotifications(user)
    if (first.nextCursor === null) throw new Error('Expected equivalent cursor')
    const firstCursor = first.nextCursor
    const issuedAt = Date.now()
    vi.setSystemTime(issuedAt + 5 * 60 * 1_000 - 1)
    try {
      const repeated = await operations.listPageWatchNotifications(user)
      expect(repeated.nextCursor).toBe(firstCursor)
      vi.setSystemTime(issuedAt + 5 * 60 * 1_000 + 1)
      await expect(operations.listPageWatchNotifications(user, firstCursor)).rejects.toMatchObject({
        status: 409,
        name: 'WATCH_CURSOR_EXPIRED'
      })
    } finally {
      vi.setSystemTime(issuedAt)
    }
  })

  it('advances raw malformed boundaries before wiring reachable valid notifications', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    await insertNotifications([
      ...Array.from({ length: 501 }, (_, index) =>
        notificationRow(`malformed-${String(index).padStart(3, '0')}`, {
          pageId: 99,
          createdAt: 'invalid-timestamp',
          readAt: null
        })
      ),
      notificationRow('valid-after-malformed', {
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        readAt: null
      })
    ])
    const first = await operations.listPageWatchNotifications(user)
    const firstCursor = first.nextCursor
    if (firstCursor === null) throw new Error('Expected malformed boundary cursor')
    expect(first.unreadComplete).toBe(false)
    expect(await knex('pageWatchNotifications').where({ userId: 7 })).toHaveLength(2)

    const second = await operations.listPageWatchNotifications(user, firstCursor)
    expect(second.items.map(item => item.id)).toEqual(['valid-after-malformed'])
    expect(second.nextCursor).toBeNull()
    expect(second.unreadComplete).toBe(true)
    expect(await knex('pageWatchNotifications').where({ userId: 7 })).toHaveLength(1)
  })

  it('reuses equivalent cursors, keeps other owners live, and enforces cache capacity', async () => {
    const operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
    const initialNow = Date.now()
    const ownerRequesters = Array.from(
      { length: 32 },
      (_, index) => ({ id: 100 + index, email: `owner-${index}@example.test`, permissions: ['read:pages'], groups: [3] }) as Express.User
    )
    const rows: Array<Record<string, unknown>> = []
    for (const [ownerIndex, owner] of ownerRequesters.entries()) {
      const count = ownerIndex === 0 ? 251 : 201
      for (let index = 0; index < count; index += 1) {
        rows.push(
          notificationRow(`owner-${owner.id}-${String(index).padStart(3, '0')}`, {
            userId: owner.id as number,
            createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index))
          })
        )
      }
    }
    rows.push(
      ...Array.from({ length: 51 }, (_, index) =>
        notificationRow(`capacity-owner-${String(index).padStart(3, '0')}`, {
          userId: 999,
          createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index))
        })
      )
    )
    await insertNotifications(rows)

    const firstCursors: string[] = []
    const secondCursors: string[] = []
    const fourthCursors: string[] = []
    for (const owner of ownerRequesters) {
      let listed = await operations.listPageWatchNotifications(owner)
      if (listed.nextCursor === null) throw new Error('Expected first owner cursor')
      firstCursors.push(listed.nextCursor)
      for (let round = 1; round < 4; round += 1) {
        listed = await operations.listPageWatchNotifications(owner, listed.nextCursor)
        if (listed.nextCursor === null) throw new Error('Expected owner cursor within four pages')
        if (round === 1) secondCursors.push(listed.nextCursor)
      }
      fourthCursors.push(listed.nextCursor)
      expect(listed.items).toHaveLength(50)
    }

    const ownerTwoEquivalent = await operations.listPageWatchNotifications(ownerRequesters[1]!, firstCursors[1])
    expect(ownerTwoEquivalent.nextCursor).toBe(secondCursors[1])
    expect(ownerTwoEquivalent.items).toHaveLength(50)

    const ownerOneFifth = await operations.listPageWatchNotifications(ownerRequesters[0]!, fourthCursors[0])
    expect(ownerOneFifth.nextCursor).toEqual(expect.any(String))
    await expect(operations.listPageWatchNotifications(ownerRequesters[0]!, firstCursors[0])).rejects.toMatchObject({
      status: 409,
      name: 'WATCH_CURSOR_EXPIRED'
    })
    await expect(operations.listPageWatchNotifications(ownerRequesters[1]!, firstCursors[1])).resolves.toMatchObject({
      ownerId: 101,
      items: expect.any(Array)
    })

    await expect(
      operations.listPageWatchNotifications({ id: 999, email: 'capacity@example.test', permissions: ['read:pages'], groups: [3] } as Express.User)
    ).rejects.toMatchObject({ status: 503, name: 'NOTIFICATION_CURSOR_CAPACITY' })

    vi.setSystemTime(initialNow + 5 * 60 * 1_000 + 1)
    try {
      const afterExpiry = await operations.listPageWatchNotifications({
        id: 999,
        email: 'capacity@example.test',
        permissions: ['read:pages'],
        groups: [3]
      } as Express.User)
      expect(afterExpiry.nextCursor).toEqual(expect.any(String))
    } finally {
      vi.setSystemTime(initialNow)
    }
  })
})
