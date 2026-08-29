
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { DurableJob } from '../../core/durable-jobs.ts'
import { createPageWatchNotificationHandler, type PageWatchWikiContext } from '../../jobs/page-watch-notification.ts'

let knex: Knex
const send = vi.fn()
const user = {
  id: 7,
  email: 'reader@example.test',
  isActive: true,
  groups: [{ id: 3, permissions: ['read:pages'] }],
  permissions: ['read:pages'],
  getGlobalPermissions () { return ['read:pages'] }
}
const page = { id: 42, visibility: 'public', ownerId: null, path: 'docs/start', localeCode: 'en' }

beforeEach(async () => {
  send.mockReset()
  Reflect.set(global, 'WIKI', {
    auth: { checkAccess: vi.fn((principal: Express.User | undefined) => {
      const permissions = principal && Reflect.get(principal, 'permissions')
      return Array.isArray(permissions) && permissions.includes('read:pages')
    }) }
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

const wiki = (pageResult: Record<string, unknown> | undefined = page): PageWatchWikiContext => ({
  config: { host: 'https://wiki.example.test/' },
  mail: { send },
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
    const handler = createPageWatchNotificationHandler(wiki())

    await handler(job, { knex })
    await handler(job, { knex })

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

  it('delivers the in-app channel without sending email when email is disabled', async () => {
    const inAppOnlyJob: DurableJob = {
      ...job,
      payload: { ...job.payload, emailEnabled: false, inAppEnabled: true }
    }

    await createPageWatchNotificationHandler(wiki())(inAppOnlyJob, { knex })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications')).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({ deliveredAt: expect.anything() })
  })

  it('removes the subscription without sending after page access is revoked', async () => {
    const deniedUser = { ...user, permissions: [], getGlobalPermissions: () => [] }
    const deniedWiki = wiki()
    deniedWiki.models.users.query = () => ({
      findById: () => ({ withGraphJoined: () => ({ modifyGraph: async () => deniedUser }) })
    })

    await createPageWatchNotificationHandler(deniedWiki)(job, { knex })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchers')).toEqual([])
    expect(await knex('pageWatchNotifications')).toEqual([])
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({ deliveredAt: expect.anything(), lastError: 'Page access was revoked' })
  })
})
