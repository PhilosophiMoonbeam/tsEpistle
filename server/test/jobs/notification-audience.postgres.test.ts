import { randomUUID } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import { DurableJobStore } from '../../core/durable-jobs.ts'
import type { DurableJobHandler } from '../../core/durable-jobs.ts'
import { up as addDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addOutbox } from '../../db/migrations/2.5.131.ts'
import { up as addPageWatching } from '../../db/migrations/2.5.132.ts'
import { up as addLeaseToken } from '../../db/migrations/2.5.158.ts'
import { up as addNotificationPreferences } from '../../db/migrations/tsepistle-000058-discussion-notifications.ts'
import { createPageWatchNotificationHandler, type PageWatchWikiContext } from '../../jobs/page-watch-notification.ts'
import type * as notificationOperations from '../../operations/page-watching.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_notification_audience_test', import.meta.path)
const suite = connection ? describe : describe.skip
const recipient = { id: 7, email: 'watcher@example.test', permissions: ['read:pages'] } as Express.User
const control = { id: 8, email: 'nonwatcher@example.test', permissions: ['read:pages'] } as Express.User
const former = { path: 'docs/deleted', localeCode: 'en', visibility: 'public', ownerId: null, tags: [{ tag: 'readable' }] }
type Message = Parameters<PageWatchWikiContext['mail']['send']>[0]
type Channels = { inAppEnabled: boolean; emailEnabled: boolean }

suite('PostgreSQL notification audience delivery and read projection', () => {
  let db: Knex
  let operations: typeof notificationOperations
  let handler: DurableJobHandler
  const originalWiki = Reflect.get(globalThis, 'WIKI')
  const messages: Message[] = []
  const tables = [
    'userNotificationPreferences',
    'pageWatchNotifications',
    'pageWatchDeliveries',
    'pageWatchers',
    'webhookDeliveries',
    'outboxEvents',
    'webhooks',
    'durableJobs',
    'deletedPageRecovery',
    'pageHistory',
    'pageAccessPasswords',
    'pageTags',
    'pages',
    'tags',
    'userGroups',
    'groups',
    'users'
  ]

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, email text NOT NULL, "isActive" boolean NOT NULL DEFAULT true,
        "isSystem" boolean NOT NULL DEFAULT false, "authVersion" integer NOT NULL DEFAULT 0);
      CREATE TABLE groups (id integer PRIMARY KEY, name text NOT NULL, permissions jsonb NOT NULL, "pageRules" jsonb NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer REFERENCES users(id), "groupId" integer REFERENCES groups(id),
        PRIMARY KEY ("userId", "groupId"));
      CREATE TABLE pages (id integer PRIMARY KEY, title text NOT NULL, path text NOT NULL, "localeCode" text NOT NULL,
        visibility text NOT NULL, "ownerId" integer, "isPublished" boolean NOT NULL DEFAULT true,
        "publishStartDate" text, "publishEndDate" text);
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL, "redirectToId" integer, "isArchived" boolean NOT NULL DEFAULT false);
      CREATE TABLE "pageTags" ("pageId" integer REFERENCES pages(id) ON DELETE CASCADE, "tagId" integer REFERENCES tags(id));
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE, version integer NOT NULL);
      CREATE TABLE "pageHistory" (id integer PRIMARY KEY, title text NOT NULL);
      CREATE TABLE "deletedPageRecovery" ("pageId" integer PRIMARY KEY, "deletionVersionId" integer REFERENCES "pageHistory"(id),
        "securityContext" jsonb NOT NULL);
    `)
    await addDurableJobs(db)
    await addLeaseToken(db)
    await addOutbox(db)
    await addPageWatching(db)
    await addNotificationPreferences(db)
    const wiki = {
      config: { host: 'https://wiki.example.test' },
      configSvc: {},
      events: {},
      lang: {},
      logger: {},
      startedAt: {},
      auth: { checkAccess: auth.checkAccess, checkPageAccess: auth.checkPageAccess, loadPageRuleAuthority },
      mail: {
        async send(message: Message) {
          messages.push(message)
        }
      },
      models: {
        knex: db,
        pages: { getPageFromDb: (id: number) => db('pages').where({ id }).first() },
        users: undefined as unknown
      }
    }
    Reflect.set(globalThis, 'WIKI', wiki)
    const [{ default: User }, { default: Group }] = await Promise.all([import('../../models/users.ts'), import('../../models/groups.ts')])
    User.knex(db)
    Group.knex(db)
    wiki.models.users = User
    handler = createPageWatchNotificationHandler(wiki as unknown as PageWatchWikiContext)
    operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
  })

  beforeEach(async () => {
    messages.length = 0
    for (const table of tables) await db(table).delete()
    await db('users').insert([
      { id: 2, email: 'guest@example.test' },
      { id: recipient.id, email: recipient.email },
      { id: control.id, email: control.email },
      { id: 9, email: 'actor@example.test' }
    ])
    await db('groups').insert({
      id: 3,
      name: 'Notification readers',
      permissions: JSON.stringify(['read:pages']),
      pageRules: JSON.stringify([{ match: 'TAG', path: 'readable', deny: false, roles: ['read:pages'], locales: ['en'] }])
    })
    await db('userGroups').insert([2, 7, 8, 9].map(userId => ({ userId, groupId: 3 })))
    await db('tags').insert([
      { id: 1, tag: 'readable' },
      { id: 2, tag: 'restricted' }
    ])
    await db('pages').insert({ id: 42, title: 'Live guide', path: former.path, localeCode: 'en', visibility: 'public', ownerId: null })
    await db('pageTags').insert({ pageId: 42, tagId: 1 })
  })

  afterAll(async () => {
    Reflect.set(globalThis, 'WIKI', originalWiki)
    if (!db) return
    for (const table of tables) await db.schema.dropTableIfExists(table)
    await db.destroy()
  })

  const watch = async (userId: number, channels: Channels): Promise<void> => {
    await db('pageWatchers').insert({ pageId: 42, userId, createdAt: new Date('2026-01-01T00:00:00.000Z'), ...channels })
  }
  const preference = async (userId: number, category: string, channels: Channels): Promise<void> => {
    await db('userNotificationPreferences').insert({ userId, category, updatedAt: new Date('2026-01-01T00:00:00.000Z'), ...channels })
  }
  const deletePage = async (): Promise<void> => {
    await db('pageHistory').insert({ id: 501, title: 'Safe deleted guide' })
    await db('deletedPageRecovery').insert({ pageId: 42, deletionVersionId: 501, securityContext: JSON.stringify({ version: 1, former, protection: null }) })
    await db('pages').where({ id: 42 }).delete()
  }
  const deliver = async (type = 'page.deleted'): Promise<string> => {
    const eventId = randomUUID()
    await db('outboxEvents').insert({
      id: eventId,
      type,
      aggregateType: 'page',
      aggregateId: '42',
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
      payload: JSON.stringify({ ...former, pageId: 42, actorId: 9, actorName: 'Editor', title: 'Stale event title' })
    })
    const store = new DurableJobStore(db)
    const audience = await store.enqueue({
      type: 'notify-page-watcher',
      version: 1,
      payload: { mode: 'audience', eventId, afterUserId: 0, audienceAt: '2026-01-01T12:00:00.000Z' },
      deduplicationKey: `notification-audience:${eventId}:0`
    })
    const context = { knex: db, signal: new AbortController().signal }
    await handler(audience, context)
    await handler(audience, context)
    const deliveries = await db('pageWatchDeliveries').where({ eventId }).orderBy('userId').select('jobId')
    for (const delivery of deliveries) {
      const job = await store.get(delivery.jobId)
      if (!job) throw new Error('Native notification delivery has no durable job')
      await handler(job, context)
      await handler(job, context)
    }
    return eventId
  }

  it.each([
    ['in-app', { inAppEnabled: true, emailEnabled: false }, { inAppEnabled: false, emailEnabled: true }],
    ['email', { inAppEnabled: false, emailEnabled: true }, { inAppEnabled: true, emailEnabled: false }],
    ['both channels', { inAppEnabled: true, emailEnabled: true }, { inAppEnabled: false, emailEnabled: true }]
  ] as const)('delivers explicit deletion %s once for a watcher and projects safe current recovery metadata', async (_channel, enabled, legacy) => {
    await watch(7, legacy)
    for (const userId of [2, 7, 8, 9]) await preference(userId, 'pageDeleted', enabled)
    await deletePage()
    const eventId = await deliver()
    // The nonwatching control proves the deleted recovery scope is actually authorized.
    for (const requester of [control, recipient]) {
      const inbox = await operations.listPageWatchNotifications(requester)
      expect(inbox.items).toEqual(
        enabled.inAppEnabled
          ? [
              expect.objectContaining({
                pageId: 42,
                eventType: 'page.deleted',
                category: 'pageDeleted',
                commentId: null,
                actorName: 'Editor',
                title: 'Safe deleted guide',
                path: former.path,
                readAt: null
              })
            ]
          : []
      )
      expect(inbox.unreadCount).toBe(enabled.inAppEnabled ? 1 : 0)
      const mail = messages.filter(message => message.to === requester.email)
      expect(mail).toHaveLength(enabled.emailEnabled ? 1 : 0)
      if (enabled.emailEnabled)
        expect(mail[0]).toMatchObject({
          template: 'page-watch',
          data: { action: 'deleted', actorName: 'Editor', pageTitle: 'Safe deleted guide', url: 'https://wiki.example.test/en/docs/deleted' }
        })
      if (enabled.inAppEnabled) {
        const id = inbox.items[0]!.id
        await operations.markPageWatchNotificationRead({ ...requester, id: 9 } as Express.User, id)
        expect((await operations.listPageWatchNotifications(requester)).items[0]?.readAt).toBeNull()
        await operations.markPageWatchNotificationRead(requester, id)
        const read = await operations.listPageWatchNotifications(requester)
        expect(read.items).toEqual([expect.objectContaining({ id, category: 'pageDeleted', title: 'Safe deleted guide', readAt: expect.any(String) })])
        expect(read.unreadCount).toBe(0)
      }
    }
    expect(messages).toHaveLength(enabled.emailEnabled ? 2 : 0)
    expect(await db('pageWatchNotifications').where({ eventId })).toHaveLength(enabled.inAppEnabled ? 2 : 0)
    expect(await db('pageWatchDeliveries').where({ eventId }).orderBy('userId').select('userId', 'lastError')).toEqual([
      { userId: 7, lastError: null },
      { userId: 8, lastError: null }
    ])
    expect(await db('pageWatchers').where({ pageId: 42 })).toEqual([])
  })

  it('preserves legacy watch channels for live events without enabling opted-out global categories', async () => {
    await watch(7, { inAppEnabled: true, emailEnabled: false })
    await preference(7, 'pageCreated', { inAppEnabled: false, emailEnabled: true })
    await preference(7, 'pageDeleted', { inAppEnabled: false, emailEnabled: true })
    await preference(8, 'pageCreated', { inAppEnabled: false, emailEnabled: false })
    await preference(8, 'pageDeleted', { inAppEnabled: true, emailEnabled: true })
    for (const type of ['page.created', 'page.updated']) await deliver(type)
    expect(messages).toEqual([])
    const inbox = await operations.listPageWatchNotifications(recipient)
    expect(inbox.items).toHaveLength(2)
    expect(inbox.items.every(item => item.category === 'pageWatch' && item.title === 'Live guide')).toBe(true)
    expect((await operations.listPageWatchNotifications(control)).items).toEqual([])
    expect(await db('pageWatchDeliveries').where({ userId: 8 })).toEqual([])
  })

  it.each(['absent', 'disabled'] as const)('does not turn an enabled legacy watch into a default deletion subscription when preference is %s', async state => {
    await watch(7, { inAppEnabled: true, emailEnabled: true })
    if (state === 'disabled') await preference(7, 'pageDeleted', { inAppEnabled: false, emailEnabled: false })
    await preference(8, 'pageDeleted', { inAppEnabled: true, emailEnabled: true })
    await deletePage()
    await deliver()
    expect((await operations.listPageWatchNotifications(control)).items).toHaveLength(1)
    expect(messages.filter(message => message.to === control.email)).toHaveLength(1)
    expect((await operations.listPageWatchNotifications(recipient)).items).toEqual([])
    expect(messages.filter(message => message.to === recipient.email)).toEqual([])
  })

  const withhold = async (change: string): Promise<void> => {
    if (change === 'protected recovery') {
      await db('deletedPageRecovery')
        .where({ pageId: 42 })
        .update({ securityContext: JSON.stringify({ version: 1, former, protection: { version: 1 } }) })
    } else if (change === 'missing recovery') {
      await db('deletedPageRecovery').where({ pageId: 42 }).delete()
    } else if (change === 'revoked membership') {
      await db('userGroups').whereIn('userId', [7, 8]).delete()
    } else {
      await db('pages').insert({
        id: 99,
        title: 'Restricted replacement',
        path: former.path,
        localeCode: 'en',
        visibility: 'public',
        ownerId: null,
        isPublished: change !== 'unpublished replacement'
      })
      await db('pageTags').insert({ pageId: 99, tagId: change === 'unauthorized replacement' ? 2 : 1 })
      if (change === 'protected replacement') await db('pageAccessPasswords').insert({ pageId: 99, version: 1 })
    }
  }
  const withheldScopes = [
    'protected recovery',
    'missing recovery',
    'revoked membership',
    'protected replacement',
    'unpublished replacement',
    'unauthorized replacement'
  ] as const

  it.each(withheldScopes)('withholds deletion inbox and mail for %s at delivery', async change => {
    await watch(7, { inAppEnabled: true, emailEnabled: true })
    for (const userId of [7, 8]) await preference(userId, 'pageDeleted', { inAppEnabled: true, emailEnabled: true })
    await deletePage()
    await withhold(change)
    await deliver()
    expect(messages).toEqual([])
    expect(await db('pageWatchNotifications')).toEqual([])
    expect((await operations.listPageWatchNotifications(recipient)).items).toEqual([])
    expect((await operations.listPageWatchNotifications(control)).items).toEqual([])
  })

  it.each(withheldScopes)('reauthorizes delivered deletion read state and projection after %s', async change => {
    await watch(7, { inAppEnabled: false, emailEnabled: true })
    await preference(7, 'pageDeleted', { inAppEnabled: true, emailEnabled: false })
    await deletePage()
    await deliver()
    const initial = await operations.listPageWatchNotifications(recipient)
    expect(initial.items).toEqual([expect.objectContaining({ category: 'pageDeleted', title: 'Safe deleted guide', readAt: null })])
    await withhold(change)
    await operations.markPageWatchNotificationRead(recipient, initial.items[0]!.id)
    expect(await db('pageWatchNotifications').where({ userId: 7 })).toEqual([])
    expect((await operations.listPageWatchNotifications(recipient)).items).toEqual([])
    expect(messages).toEqual([])
  })

  it('projects only the currently authorized replacement title rather than stale deleted metadata', async () => {
    await watch(7, { inAppEnabled: false, emailEnabled: true })
    await preference(7, 'pageDeleted', { inAppEnabled: true, emailEnabled: true })
    await deletePage()
    await db('pages').insert({ id: 99, title: 'Authorized replacement', path: former.path, localeCode: 'en', visibility: 'public', ownerId: null })
    await db('pageTags').insert({ pageId: 99, tagId: 1 })
    await deliver()
    const inbox = await operations.listPageWatchNotifications(recipient)
    expect(inbox.items).toEqual([expect.objectContaining({ pageId: 42, category: 'pageDeleted', title: 'Authorized replacement' })])
    expect(messages).toEqual([expect.objectContaining({ data: expect.objectContaining({ pageTitle: 'Authorized replacement' }) })])
    expect(JSON.stringify({ inbox, messages })).not.toContain('Safe deleted guide')
    expect(JSON.stringify({ inbox, messages })).not.toContain('Stale event title')
  })
})
