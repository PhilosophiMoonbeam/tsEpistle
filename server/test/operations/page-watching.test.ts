/** @vitest-environment node */

import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let knex: Knex
let page: { id: number; visibility: 'public'; ownerId: null; path: string; localeCode: string }

beforeEach(async () => {
  vi.resetModules()
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
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
  page = { id: 42, visibility: 'public', ownerId: null, path: 'docs/start', localeCode: 'en' }
  Reflect.set(global, 'WIKI', {
    auth: { checkAccess: vi.fn((user: Express.User | undefined, permissions: readonly string[]) => permissions.includes('read:pages') && user?.permissions?.includes('read:pages')) },
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

const user = { id: 7, email: 'reader@example.test', permissions: ['read:pages'], groups: [3] } as Express.User

describe('page watching operations', () => {
  it('subscribes idempotently, reports state, and unsubscribes', async () => {
    const operations = await import('../../operations/page-watching.ts')

    await operations.watchPage({ requester: user, id: page.id })
    await operations.watchPage({ requester: user, id: page.id })

    expect(await knex('pageWatchers')).toHaveLength(1)
    await expect(operations.getPageWatchState({ requester: user, id: page.id })).resolves.toEqual({
      watched: true,
      emailEnabled: true,
      inAppEnabled: true
    })
    await expect(operations.unwatchPage({ requester: user, id: page.id })).resolves.toEqual({ watched: false })
    await expect(operations.getPageWatchState({ requester: user, id: page.id })).resolves.toEqual({
      watched: false,
      emailEnabled: false,
      inAppEnabled: false
    })
  })

  it('updates independent channels and owns notification read state', async () => {
    const operations = await import('../../operations/page-watching.ts')
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

    await expect(operations.getPageWatchState({ requester: user, id: page.id })).resolves.toMatchObject({
      emailEnabled: false,
      inAppEnabled: true
    })
    await expect(operations.listPageWatchNotifications(user)).resolves.toMatchObject({ unreadCount: 1 })
    await operations.markPageWatchNotificationRead(user, 'notification-1')
    await expect(operations.listPageWatchNotifications(user)).resolves.toMatchObject({ unreadCount: 0 })
  })

  it('rejects anonymous and permission-revoked subscriptions', async () => {
    const operations = await import('../../operations/page-watching.ts')

    await expect(operations.watchPage({ requester: undefined, id: page.id })).rejects.toMatchObject({ status: 401 })
    await expect(operations.watchPage({ requester: { ...user, permissions: [] } as Express.User, id: page.id })).rejects.toMatchObject({ status: 404 })
    expect(await knex('pageWatchers')).toEqual([])
  })
})
