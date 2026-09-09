
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { DurableJob } from '../../core/durable-jobs.ts'
import { createPageWatchNotificationHandler, type PageWatchWikiContext } from '../../jobs/page-watch-notification.ts'

let knex: Knex
const send = vi.fn()
let user: {
  id: number
  email: string
  isActive: boolean
  groups: Array<{ id: number; permissions: string[] }>
  permissions: string[]
  getGlobalPermissions: () => string[]
}
const page = { id: 42, title: 'Getting Started', visibility: 'public', ownerId: null, path: 'docs/start', localeCode: 'en', tags: [] }

beforeEach(async () => {
  user = {
    id: 7,
    email: 'reader@example.test',
    isActive: true,
    groups: [{ id: 3, permissions: ['read:pages'] }],
    permissions: ['read:pages'],
    getGlobalPermissions () { return ['read:pages'] }
  }
  send.mockReset()
  Reflect.set(global, 'WIKI', {
    auth: {
      checkAccess: vi.fn((principal: Express.User | undefined) => {
        const permissions = principal && Reflect.get(principal, 'permissions')
        return Array.isArray(permissions) && permissions.includes('read:pages')
      }),
      checkPageAccess: vi.fn((
        principal: Express.User | undefined,
        _permissions: readonly string[],
        _context: unknown,
        authority: { permissions: readonly string[] }
      ) => {
        const permissions = principal && Reflect.get(principal, 'permissions')
        return Array.isArray(permissions) && permissions.includes('read:pages') && authority.permissions.includes('read:pages')
      })
    }
  })
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await knex.schema.createTable('outboxEvents', table => {
    table.string('id').primary()
    table.string('type').notNullable()
    table.text('payload').notNullable()
  })
  await knex.schema.createTable('pageWatchers', table => {
    table.integer('pageId').notNullable()
    table.integer('userId').notNullable()
  })
  await knex.schema.createTable('pageWatchDeliveries', table => {
    table.string('id').primary()
    table.string('eventId').notNullable()
    table.integer('userId').notNullable()
    table.dateTime('deliveredAt').nullable()
    table.text('lastError').nullable()
  })
  await knex.schema.createTable('pageWatchNotifications', table => {
    table.string('id').primary()
    table.string('eventId').notNullable()
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
    table.unique(['eventId', 'userId'])
  })
  await knex('pageWatchers').insert({ pageId: 42, userId: 7 })
  await knex('outboxEvents').insert({
    id: 'event-1',
    type: 'page.updated',
    payload: JSON.stringify({
      pageId: 42,
      actorId: 9,
      actorName: 'Editor',
      title: 'Getting Started',
      ownerId: null,
      tags: [],
      path: 'docs/start',
      localeCode: 'en',
      visibility: 'public'
    })
  })
  await knex('pageWatchDeliveries').insert({ id: 'delivery-1', eventId: 'event-1', userId: 7, deliveredAt: null, lastError: null })
})

afterEach(async () => {
  await knex.destroy()
  vi.restoreAllMocks()
})

const job: DurableJob = {
  id: 'job-1',
  type: 'notify-page-watcher',
  version: 1,
  payload: { deliveryId: 'delivery-1', eventId: 'event-1', userId: 7, emailEnabled: true, inAppEnabled: true },
  state: 'running',
  attempts: 1,
  maxAttempts: 5,
  nextRunAt: new Date(),
  leaseOwner: 'test-worker',
  leaseExpiresAt: new Date(),
  lastError: null,
  deduplicationKey: 'page-watch:7:event-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null
}

const wiki = (pageResult: Record<string, unknown> | undefined): PageWatchWikiContext => ({
  config: { host: 'https://wiki.example.test/' },
  mail: { send },
  auth: {
    loadPageRuleAuthority: vi.fn(async requester => ({
      requester,
      permissions: ['read:pages'],
      groups: [],
      tagAliases: {}
    }))
  },
  models: {
    pages: { getPageFromDb: vi.fn().mockResolvedValue(pageResult) },
    users: {
      query: () => ({
        findById: () => ({
          withGraphJoined: () => ({
            modifyGraph: async () => user
          })
        })
      }),
      getRootUser: vi.fn()
    }
  }
})

describe('page watch notification handler', () => {
  it('sends one stable-message-id email and records completion idempotently', async () => {
    const handler = createPageWatchNotificationHandler(wiki(page))

    await handler(job, { knex, signal: new AbortController().signal })
    await handler(job, { knex, signal: new AbortController().signal })

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'reader@example.test',
      messageId: '<page-watch-delivery-1@wiki.local>',
      data: expect.objectContaining({ url: 'https://wiki.example.test/en/docs/start' })
    }))
    expect(await knex('pageWatchNotifications')).toEqual([
      expect.objectContaining({ eventId: 'event-1', userId: 7, title: 'Getting Started' })
    ])
    expect(await knex('pageWatchDeliveries').where('id', 'delivery-1').first()).toMatchObject({ deliveredAt: expect.anything(), lastError: null })
  })
  it('uses the recipient authority snapshot before dispatching a notification', async () => {
    const deniedWiki = wiki(page)
    const loadPageRuleAuthority = vi.fn(async requester => ({
      requester,
      permissions: [],
      groups: [],
      tagAliases: {}
    }))
    deniedWiki.auth.loadPageRuleAuthority = loadPageRuleAuthority
    await knex('pageWatchers').insert([
      { pageId: 42, userId: 8 },
      { pageId: 99, userId: 7 }
    ])
    await knex('pageWatchNotifications').insert([
      {
        id: 'previous-notification',
        eventId: 'event-previous',
        userId: 7,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Prior',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'other-user-previous-notification',
        eventId: 'event-other-user-previous',
        userId: 8,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other user',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'other-page-previous-notification',
        eventId: 'event-other-page-previous',
        userId: 7,
        pageId: 99,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other page',
        path: 'docs/other',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      }
    ])
    await createPageWatchNotificationHandler(deniedWiki)(job, { knex, signal: new AbortController().signal })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({
      deliveredAt: expect.anything(),
      lastError: expect.any(String)
    })
  })

  it('purges prior notifications when the current page is deleted', async () => {
    await knex('pageWatchers').insert([
      { pageId: 42, userId: 8 },
      { pageId: 99, userId: 7 }
    ])
    await knex('pageWatchNotifications').insert([
      {
        id: 'deleted-page-notification',
        eventId: 'event-deleted-prior',
        userId: 7,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Prior title',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'deleted-page-other-user-notification',
        eventId: 'event-deleted-other-user',
        userId: 8,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other user',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'deleted-page-other-page-notification',
        eventId: 'event-deleted-other-page',
        userId: 7,
        pageId: 99,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other page',
        path: 'docs/other',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      }
    ])
    await createPageWatchNotificationHandler(wiki(undefined))(job, { knex, signal: new AbortController().signal })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({
      deliveredAt: expect.anything(),
      lastError: expect.any(String)
    })
  })

  it('purges unavailable recipients without touching another user', async () => {
    await knex('pageWatchers').insert([
      { pageId: 42, userId: 8 },
      { pageId: 99, userId: 7 }
    ])
    await knex('pageWatchNotifications').insert([
      {
        id: 'inactive-user-notification',
        eventId: 'event-inactive-prior',
        userId: 7,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Prior title',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'other-user-notification',
        eventId: 'event-other-user',
        userId: 8,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other user',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'other-page-notification',
        eventId: 'event-other-page',
        userId: 7,
        pageId: 99,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other page',
        path: 'docs/other',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      }
    ])
    const inactiveWiki = wiki(page)
    inactiveWiki.models.users.query = () => ({
      findById: () => ({ withGraphJoined: () => ({ modifyGraph: async () => ({ ...user, isActive: false }) }) })
    })

    await createPageWatchNotificationHandler(inactiveWiki)(job, { knex, signal: new AbortController().signal })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({
      deliveredAt: expect.anything(),
      lastError: expect.any(String)
    })
  })

  it('delivers the in-app channel without sending email when email is disabled', async () => {
    const inAppOnlyJob: DurableJob = {
      ...job,
      payload: { ...job.payload, emailEnabled: false, inAppEnabled: true }
    }

    await createPageWatchNotificationHandler(wiki(page))(inAppOnlyJob, { knex, signal: new AbortController().signal })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications')).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({ deliveredAt: expect.anything() })
  })

  it('removes the subscription without sending after page access is revoked', async () => {
    await knex('pageWatchers').insert([
      { pageId: 42, userId: 8 },
      { pageId: 99, userId: 7 }
    ])
    await knex('pageWatchNotifications').insert([
      {
        id: 'revoked-user-notification',
        eventId: 'event-revoked-prior',
        userId: 7,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Prior title',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'revoked-other-user-notification',
        eventId: 'event-revoked-other-user',
        userId: 8,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other user',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'revoked-other-page-notification',
        eventId: 'event-revoked-other-page',
        userId: 7,
        pageId: 99,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other page',
        path: 'docs/other',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      }
    ])
    const deniedUser = { ...user, permissions: [], getGlobalPermissions: () => [] }
    const deniedWiki = wiki(page)
    deniedWiki.models.users.query = () => ({
      findById: () => ({ withGraphJoined: () => ({ modifyGraph: async () => deniedUser }) })
    })

    await createPageWatchNotificationHandler(deniedWiki)(job, { knex, signal: new AbortController().signal })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({
      deliveredAt: expect.anything(),
      lastError: expect.any(String)
    })
  })

  it('does not dispatch or commit when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      createPageWatchNotificationHandler(wiki(page))(job, { knex, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchers')).toEqual([{ pageId: 42, userId: 7 }])
    expect(await knex('pageWatchNotifications')).toEqual([])
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({
      deliveredAt: null,
      lastError: null
    })
  })
})
